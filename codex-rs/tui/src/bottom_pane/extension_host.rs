use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::cell::RefCell;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use tracing::warn;

use super::external_editor::ExternalEditorError;

#[derive(Debug)]
pub(crate) struct ExtensionHost {
    scripts: Vec<PathBuf>,
    config: ExtensionConfig,
    last_seed_mtime: RefCell<Option<SystemTime>>,
    log_path: PathBuf,
    session_path: RefCell<Option<PathBuf>>,
    line_added_token: Arc<AtomicU64>,
}

const HISTORY_PAGE_JUMP: usize = 10;

#[derive(Clone, Debug, Default)]
pub(crate) struct ExtensionConfig {
    pub external_edit_keys: Vec<KeyBinding>,
    pub history_prev_keys: Vec<KeyBinding>,
    pub history_next_keys: Vec<KeyBinding>,
    pub history_prev_page_keys: Vec<KeyBinding>,
    pub history_next_page_keys: Vec<KeyBinding>,
    pub history_first_keys: Vec<KeyBinding>,
    pub history_last_keys: Vec<KeyBinding>,
    pub editor_command: Option<Vec<String>>,
    pub hide_edit_marker: Option<bool>,
    pub hide_prompt_hints: Option<bool>,
    pub hide_statusbar_hints: Option<bool>,
    pub align_left: Option<bool>,
    pub editor_borderline: Option<bool>,
    pub a11y_keyboard_shortcuts: Option<bool>,
    pub a11y_audio_cues: Option<bool>,
}

#[derive(Default)]
struct ConfigDelta {
    external_edit_keys: Option<Vec<KeyBinding>>,
    history_prev_keys: Option<Vec<KeyBinding>>,
    history_next_keys: Option<Vec<KeyBinding>>,
    history_prev_page_keys: Option<Vec<KeyBinding>>,
    history_next_page_keys: Option<Vec<KeyBinding>>,
    history_first_keys: Option<Vec<KeyBinding>>,
    history_last_keys: Option<Vec<KeyBinding>>,
    editor_command: Option<Vec<String>>,
    hide_edit_marker: Option<bool>,
    hide_prompt_hints: Option<bool>,
    hide_statusbar_hints: Option<bool>,
    align_left: Option<bool>,
    editor_borderline: Option<bool>,
    a11y_keyboard_shortcuts: Option<bool>,
    a11y_audio_cues: Option<bool>,
}

#[derive(Debug)]
enum ExtensionReply {
    Ok {
        text: Option<String>,
        payload: Option<Value>,
    },
    Skip,
}

#[derive(Debug)]
enum ExtensionHostError {
    SpawnFailed {
        script: PathBuf,
        error: io::Error,
    },
    Io {
        script: PathBuf,
        error: io::Error,
    },
    InvalidJson {
        script: PathBuf,
        raw: String,
        error: serde_json::Error,
    },
    ScriptError {
        script: PathBuf,
        message: String,
    },
    MissingStatus {
        script: PathBuf,
        raw: String,
    },
}

impl std::fmt::Display for ExtensionHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtensionHostError::SpawnFailed { script, error } => {
                write!(f, "failed to spawn extension {script:?}: {error}")
            }
            ExtensionHostError::Io { script, error } => {
                write!(f, "error running extension {script:?}: {error}")
            }
            ExtensionHostError::InvalidJson { script, raw, error } => write!(
                f,
                "extension {script:?} returned invalid JSON ({error}): {raw}"
            ),
            ExtensionHostError::ScriptError { script, message } => {
                write!(f, "extension {script:?} reported an error: {message}")
            }
            ExtensionHostError::MissingStatus { script, raw } => write!(
                f,
                "extension {script:?} response missing status field: {raw}"
            ),
        }
    }
}

impl std::error::Error for ExtensionHostError {}

#[cfg_attr(test, allow(dead_code))]
impl ExtensionHost {
    pub(crate) fn new() -> Self {
        let scripts = Self::discover_scripts();
        let config = Self::load_config(&scripts);
        let log_path = Self::default_log_path();
        let host = Self {
            scripts,
            config,
            last_seed_mtime: RefCell::new(None),
            log_path,
            session_path: RefCell::new(None),
            line_added_token: Arc::new(AtomicU64::new(0)),
        };
        host.log_event(format!(
            "Host initialized; discovered extensions: {:?}",
            host.scripts
        ));
        host.log_loaded_extensions();
        host.maybe_seed_history();
        host
    }

    fn log_loaded_extensions(&self) {
        if self.scripts.is_empty() {
            return;
        }
        let names: Vec<String> = self
            .scripts
            .iter()
            .filter_map(|p| p.file_name().and_then(|s| s.to_str()).map(String::from))
            .collect();
        if names.is_empty() {
            return;
        }
        self.log_event(format!("Loaded extensions: {}", names.join(", ")));
    }

    #[allow(dead_code)]
    pub(crate) fn scripts(&self) -> &[PathBuf] {
        &self.scripts
    }

    pub(crate) fn external_edit(&self, text: &str) -> Result<Option<String>, ExternalEditorError> {
        let payload = json!({ "text": text });
        self.log_event("external_edit requested");
        let reply = self.invoke_first("external_edit", payload);
        match reply {
            Ok(Some(ExtensionReply::Ok { text: Some(t), .. })) => Ok(Some(t)),
            Ok(Some(ExtensionReply::Ok {
                text: None,
                payload,
            })) => {
                if let Some(s) = payload.and_then(Self::extract_text_field) {
                    return Ok(Some(s));
                }
                Err(ExternalEditorError::Extension(
                    "Extension returned success without text".to_string(),
                ))
            }
            Ok(Some(ExtensionReply::Skip)) | Ok(None) => {
                self.log_event("external_edit extension skip -> fallback");
                Ok(None)
            }
            Err(err) => Err(ExternalEditorError::Extension(err.to_string())),
        }
    }

    pub(crate) fn config(&self) -> &ExtensionConfig {
        &self.config
    }

    pub(crate) fn notify_event(&self, event: &str) {
        if matches!(event, "completion_end" | "conversation_interrupted") {
            self.cancel_line_added_timer();
        }
        if self.scripts.is_empty() {
            return;
        }
        if event == "line_added" {
            let token = self.line_added_token.fetch_add(1, Ordering::SeqCst) + 1;
            let scripts = self.scripts.clone();
            let log_path = self.log_path.clone();
            let line_added_token = self.line_added_token.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1000));
                if line_added_token.load(Ordering::SeqCst) != token {
                    return;
                }
                let payload = json!({ "event": "line_added" });
                for script in scripts {
                    let request =
                        ExtensionHost::build_request("notify", payload.clone(), &log_path);
                    let _ = ExtensionHost::run_script(&script, "notify", request, &log_path);
                }
            });
        } else {
            let scripts = self.scripts.clone();
            let log_path = self.log_path.clone();
            let event_string = event.to_string();
            std::thread::spawn(move || {
                let payload = json!({ "event": event_string });
                for script in scripts {
                    let request =
                        ExtensionHost::build_request("notify", payload.clone(), &log_path);
                    let _ = ExtensionHost::run_script(&script, "notify", request, &log_path);
                }
            });
        }
    }

    fn cancel_line_added_timer(&self) {
        self.line_added_token.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn history_push(&self, text: &str) {
        self.ensure_session_path();
        let session_path_json = self
            .session_path
            .borrow()
            .as_ref()
            .map(|p| json!(p))
            .unwrap_or(Value::Null);
        let payload = json!({ "text": text, "session_path": session_path_json });
        self.log_event(format!("history_push text='{text}'"));
        if let Err(err) = self.invoke_first("history_push", payload) {
            warn!(?err, "history_push extension failed");
        }
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn history_prev(&self) -> Option<String> {
        self.maybe_seed_history();
        self.log_event("history_prev invoked");
        let result = self.history_lookup("history_prev");
        self.log_event(format!("history_prev result={result:?}"));
        result
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn history_first(&self) -> Option<String> {
        self.maybe_seed_history();
        self.log_event("history_first invoked");
        let result = self.history_lookup("history_first");
        self.log_event(format!("history_first result={result:?}"));
        result
    }

    pub(crate) fn history_delete(&self, text: &str, index: Option<usize>) -> Option<String> {
        self.ensure_session_path();
        let session_path_json = self
            .session_path
            .borrow()
            .as_ref()
            .map(|p| json!(p))
            .unwrap_or(Value::Null);
        let payload = json!({
            "text": text,
            "index": index,
            "session_path": session_path_json
        });
        let reply = self.invoke_first("history_delete", payload).ok()??;
        match reply {
            ExtensionReply::Ok {
                text: Some(next), ..
            } => Some(next),
            ExtensionReply::Ok { payload, .. } => payload
                .as_ref()
                .and_then(Self::extract_next_text_field)
                .or_else(|| payload.and_then(Self::extract_text_field)),
            ExtensionReply::Skip => None,
        }
    }

    fn ensure_session_path(&self) {
        if self.session_path.borrow().is_some() {
            return;
        }
        let root = Self::history_root();
        if let Some((_, latest)) = Self::find_latest_jsonl(&root) {
            *self.session_path.borrow_mut() = Some(latest);
        }
    }

    fn history_root() -> PathBuf {
        dirs::home_dir()
            .map(|h| h.join(".codex").join("sessions"))
            .unwrap_or_else(|| PathBuf::from("."))
    }

    pub(crate) fn has_history_state(&self) -> bool {
        Self::history_root().exists()
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn history_next(&self) -> Option<String> {
        self.maybe_seed_history();
        self.log_event("history_next invoked");
        let result = self.history_lookup("history_next");
        self.log_event(format!("history_next result={result:?}"));
        result
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn history_last(&self) -> Option<String> {
        self.maybe_seed_history();
        self.log_event("history_last invoked");
        let result = self.history_lookup("history_last");
        self.log_event(format!("history_last result={result:?}"));
        result
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn history_prev_page(&self) -> Option<String> {
        self.history_jump(|| self.history_prev())
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn history_next_page(&self) -> Option<String> {
        self.history_jump(|| self.history_next())
    }

    fn history_jump<F>(&self, mut step: F) -> Option<String>
    where
        F: FnMut() -> Option<String>,
    {
        let mut last: Option<String> = None;
        for _ in 0..HISTORY_PAGE_JUMP {
            match step() {
                Some(text) => last = Some(text),
                None => break,
            }
        }
        last
    }

    #[cfg_attr(test, allow(dead_code))]
    fn history_lookup(&self, action: &str) -> Option<String> {
        let reply = self.invoke_first(action, json!({}));
        match reply {
            Ok(Some(ExtensionReply::Ok { text, payload })) => {
                text.or_else(|| payload.and_then(Self::extract_text_field))
            }
            Ok(Some(ExtensionReply::Skip)) | Ok(None) => None,
            Err(err) => {
                warn!(?err, "history extension call failed");
                None
            }
        }
    }

    fn invoke_first(
        &self,
        action: &str,
        payload: Value,
    ) -> Result<Option<ExtensionReply>, ExtensionHostError> {
        if self.scripts.is_empty() {
            self.log_event(format!("No extensions to handle action {action}; skipping"));
            return Ok(None);
        }

        for script in &self.scripts {
            self.log_event(format!("Calling script {script:?} action {action}"));
            match Self::run_script(script, action, payload.clone(), &self.log_path) {
                Ok(ExtensionReply::Skip) => {
                    self.log_event(format!("Script {script:?} returned skip"));
                    continue;
                }
                Ok(reply) => {
                    self.log_event(format!("Script {script:?} returned ok"));
                    return Ok(Some(reply));
                }
                Err(err) => {
                    self.log_event(format!("Script {script:?} failed: {err}"));
                    return Err(err);
                }
            }
        }
        Ok(None)
    }

    fn run_script(
        script: &Path,
        action: &str,
        payload: Value,
        log_path: &Path,
    ) -> Result<ExtensionReply, ExtensionHostError> {
        let request = Self::build_request(action, payload, log_path);
        let mut cmd = Command::new("node");
        #[cfg(test)]
        {
            for key in [
                "a11y_hide_edit_marker",
                "a11y_hide_prompt_hints",
                "a11y_hide_statusbar_hints",
                "a11y_editor_align_left",
                "a11y_editor_borderline",
                "a11y_keyboard_shortcuts",
                "a11y_audio_cues",
            ] {
                cmd.env_remove(key);
            }
        }
        let mut child = cmd
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| ExtensionHostError::SpawnFailed {
                script: script.to_path_buf(),
                error,
            })?;

        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(request.to_string().as_bytes())
                .map_err(|error| ExtensionHostError::Io {
                    script: script.to_path_buf(),
                    error,
                })?;
        }

        let output = child
            .wait_with_output()
            .map_err(|error| ExtensionHostError::Io {
                script: script.to_path_buf(),
                error,
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let json_line =
            Self::extract_last_json_line(&stdout).unwrap_or_else(|| stdout.trim().to_string());

        if json_line.is_empty() {
            return Err(ExtensionHostError::ScriptError {
                script: script.to_path_buf(),
                message: format!("empty response (stderr: {stderr})"),
            });
        }

        let parsed: RawResponse =
            serde_json::from_str(&json_line).map_err(|error| ExtensionHostError::InvalidJson {
                script: script.to_path_buf(),
                raw: json_line.clone(),
                error,
            })?;

        match parsed.status.as_str() {
            "ok" => Ok(ExtensionReply::Ok {
                text: parsed.text,
                payload: parsed.payload,
            }),
            "skip" => Ok(ExtensionReply::Skip),
            "error" => Err(ExtensionHostError::ScriptError {
                script: script.to_path_buf(),
                message: parsed
                    .message
                    .unwrap_or_else(|| "extension returned error".to_string()),
            }),
            _ => Err(ExtensionHostError::MissingStatus {
                script: script.to_path_buf(),
                raw: json_line,
            }),
        }
    }

    fn build_request(action: &str, payload: Value, log_path: &Path) -> Value {
        let mut map: Map<String, Value> = Map::new();
        map.insert("action".to_string(), json!(action));
        map.insert("log_path".to_string(), json!(log_path));
        if let Value::Object(obj) = &payload {
            for (k, v) in obj {
                map.insert(k.clone(), v.clone());
            }
        } else {
            map.insert("payload".to_string(), payload);
        }
        Value::Object(map)
    }

    fn extract_last_json_line(output: &str) -> Option<String> {
        for line in output.lines().rev() {
            let trimmed = line.trim();
            if trimmed.starts_with('{') && trimmed.ends_with('}') {
                return Some(trimmed.to_string());
            }
        }
        None
    }

    fn extract_text_field(payload: Value) -> Option<String> {
        if let Value::Object(map) = payload {
            return map.get("text").and_then(|v| v.as_str()).map(String::from);
        }
        None
    }

    fn extract_next_text_field(payload: &Value) -> Option<String> {
        payload
            .as_object()
            .and_then(|obj| obj.get("next_text").and_then(Value::as_str))
            .map(str::to_string)
    }

    fn discover_scripts() -> Vec<PathBuf> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = env::var("CODEX_TUI_EXTENSION_DIR") {
            candidates.push(PathBuf::from(dir));
        }

        let mut is_packaged = false;
        if let Ok(exe) = env::current_exe() {
            is_packaged = exe
                .ancestors()
                .any(|p| p.components().any(|c| c.as_os_str() == "node_modules"));
            for ancestor in exe.ancestors() {
                candidates.push(ancestor.join("extensions"));
            }
        }

        // In packaged (npm -g) installations we should not pick up a developer
        // working directory's extensions. In dev/debug runs (cargo/just),
        // including cwd/extensions keeps local edits active.
        if !is_packaged {
            if let Ok(cwd) = env::current_dir() {
                candidates.push(cwd.join("extensions"));
            }
        }

        let mut scripts: Vec<PathBuf> = Vec::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();

        for dir in candidates {
            if !dir.is_dir() {
                continue;
            }
            if !seen.insert(dir.clone()) {
                continue;
            }
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file()
                        && let Some(ext) = path.extension().and_then(|s| s.to_str())
                        && ext.eq_ignore_ascii_case("js")
                    {
                        scripts.push(path);
                    }
                }
            }
        }

        scripts.sort();
        scripts
    }

    fn load_config(scripts: &[PathBuf]) -> ExtensionConfig {
        let cfg = ExtensionConfig {
            external_edit_keys: vec![KeyBinding::ctrl_char('e')],
            history_prev_keys: vec![KeyBinding::alt_code(KeyCode::Up)],
            history_next_keys: vec![KeyBinding::alt_code(KeyCode::Down)],
            history_prev_page_keys: vec![KeyBinding::alt_code(KeyCode::PageUp)],
            history_next_page_keys: vec![KeyBinding::alt_code(KeyCode::PageDown)],
            history_first_keys: vec![KeyBinding::alt_code(KeyCode::Home)],
            history_last_keys: vec![KeyBinding::alt_code(KeyCode::End)],
            editor_command: None,
            hide_edit_marker: None,
            hide_prompt_hints: None,
            hide_statusbar_hints: None,
            align_left: None,
            editor_borderline: None,
            a11y_keyboard_shortcuts: None,
            a11y_audio_cues: None,
        };

        let mut cfg = scripts.iter().fold(cfg, |mut acc, script| {
            let log_path = Self::default_log_path();
            let request = Self::build_request("config", json!({}), &log_path);
            let response = Self::run_script(script, "config", request, &log_path);
            let Ok(ExtensionReply::Ok { payload, .. }) = response else {
                return acc;
            };
            if let Some(p) = payload
                && let Some(parsed) = Self::parse_config(p)
            {
                if let Some(v) = parsed.external_edit_keys {
                    acc.external_edit_keys = v;
                }
                if let Some(v) = parsed.history_prev_keys {
                    acc.history_prev_keys = v;
                }
                if let Some(v) = parsed.history_next_keys {
                    acc.history_next_keys = v;
                }
                if let Some(v) = parsed.history_prev_page_keys {
                    acc.history_prev_page_keys = v;
                }
                if let Some(v) = parsed.history_next_page_keys {
                    acc.history_next_page_keys = v;
                }
                if let Some(v) = parsed.history_first_keys {
                    acc.history_first_keys = v;
                }
                if let Some(v) = parsed.history_last_keys {
                    acc.history_last_keys = v;
                }
                if let Some(v) = parsed.editor_command {
                    acc.editor_command = Some(v);
                }
                if let Some(v) = parsed.hide_edit_marker {
                    acc.hide_edit_marker = Some(v);
                }
                if let Some(v) = parsed.hide_prompt_hints {
                    acc.hide_prompt_hints = Some(v);
                }
                if let Some(v) = parsed.hide_statusbar_hints {
                    acc.hide_statusbar_hints = Some(v);
                }
                if let Some(v) = parsed.align_left {
                    acc.align_left = Some(v);
                }
                if let Some(v) = parsed.editor_borderline {
                    acc.editor_borderline = Some(v);
                }
                if let Some(v) = parsed.a11y_keyboard_shortcuts {
                    acc.a11y_keyboard_shortcuts = Some(v);
                }
                if let Some(v) = parsed.a11y_audio_cues {
                    acc.a11y_audio_cues = Some(v);
                }
            }
            acc
        });

        Self::ensure_history_binding(&mut cfg.history_prev_keys, KeyCode::Up, KeyModifiers::NONE);
        Self::ensure_history_binding(
            &mut cfg.history_next_keys,
            KeyCode::Down,
            KeyModifiers::NONE,
        );

        cfg
    }

    #[allow(dead_code)]
    fn ensure_history_binding(keys: &mut Vec<KeyBinding>, code: KeyCode, modifiers: KeyModifiers) {
        if keys
            .iter()
            .any(|kb| kb.code == code && kb.modifiers == modifiers)
        {
            return;
        }
        keys.push(KeyBinding { code, modifiers });
    }

    fn parse_config(value: Value) -> Option<ConfigDelta> {
        let obj = value.as_object()?;
        let mut cfg = ConfigDelta::default();

        if let Some(keys) = obj.get("external_edit_keys") {
            cfg.external_edit_keys = Some(Self::parse_key_list(keys));
        }
        if let Some(keys) = obj.get("history_prev_keys") {
            cfg.history_prev_keys = Some(Self::parse_key_list(keys));
        }
        if let Some(keys) = obj.get("history_next_keys") {
            cfg.history_next_keys = Some(Self::parse_key_list(keys));
        }
        if let Some(keys) = obj.get("history_prev_page_keys") {
            cfg.history_prev_page_keys = Some(Self::parse_key_list(keys));
        }
        if let Some(keys) = obj.get("history_next_page_keys") {
            cfg.history_next_page_keys = Some(Self::parse_key_list(keys));
        }
        if let Some(keys) = obj.get("history_first_keys") {
            cfg.history_first_keys = Some(Self::parse_key_list(keys));
        }
        if let Some(keys) = obj.get("history_last_keys") {
            cfg.history_last_keys = Some(Self::parse_key_list(keys));
        }
        if let Some(cmd_val) = obj.get("editor_command") {
            cfg.editor_command = Self::parse_editor_command(cmd_val);
        }
        if let Some(v) = obj.get("hide_edit_marker").and_then(Value::as_bool) {
            cfg.hide_edit_marker = Some(v);
        }
        if let Some(v) = obj.get("hide_prompt_hints").and_then(Value::as_bool) {
            cfg.hide_prompt_hints = Some(v);
        }
        if let Some(v) = obj.get("hide_statusbar_hints").and_then(Value::as_bool) {
            cfg.hide_statusbar_hints = Some(v);
        }
        if let Some(v) = obj.get("align_left").and_then(Value::as_bool) {
            cfg.align_left = Some(v);
        }
        if let Some(v) = obj.get("editor_borderline").and_then(Value::as_bool) {
            cfg.editor_borderline = Some(v);
        }
        if let Some(v) = obj.get("a11y_keyboard_shortcuts").and_then(Value::as_bool) {
            cfg.a11y_keyboard_shortcuts = Some(v);
        }
        if let Some(v) = obj.get("a11y_audio_cues").and_then(Value::as_bool) {
            cfg.a11y_audio_cues = Some(v);
        }
        if let Some(v) = obj.get("a11y_audio_cues").and_then(Value::as_bool) {
            cfg.a11y_audio_cues = Some(v);
        }

        Some(cfg)
    }

    fn parse_key_list(value: &Value) -> Vec<KeyBinding> {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(KeyBinding::from_json)
            .collect()
    }

    fn parse_editor_command(cmd: &Value) -> Option<Vec<String>> {
        match cmd {
            Value::String(s) => shlex::split(s),
            Value::Array(arr) => {
                let mut parts: Vec<String> = Vec::new();
                for v in arr {
                    if let Some(s) = v.as_str() {
                        parts.push(s.to_string());
                    }
                }
                if parts.is_empty() { None } else { Some(parts) }
            }
            _ => None,
        }
    }

    fn maybe_seed_history(&self) {
        let Some(seed) = Self::load_recent_history() else {
            self.log_event("No history file found");
            return;
        };
        if let Some(prev) = *self.last_seed_mtime.borrow()
            && prev >= seed.mtime
        {
            self.log_event("History already seeded with latest file");
            return;
        }
        self.log_event(format!(
            "Seeding history from {:?} ({} entries)",
            seed.path,
            seed.entries.len()
        ));
        *self.session_path.borrow_mut() = Some(seed.path.clone());
        let payload = json!({ "payload": { "entries": seed.entries, "session_path": seed.path } });
        for script in &self.scripts {
            let _ = Self::run_script(script, "history_seed", payload.clone(), &self.log_path);
        }
        *self.last_seed_mtime.borrow_mut() = Some(seed.mtime);
    }

    fn load_recent_history() -> Option<HistorySeed> {
        let root = Self::history_root();
        if !root.exists() {
            return None;
        }
        let (mtime, latest) = Self::find_latest_jsonl(&root)?;
        let entries = Self::read_user_messages(&latest);
        if entries.is_empty() {
            return None;
        }
        Some(HistorySeed {
            entries,
            mtime,
            path: latest,
        })
    }

    fn find_latest_jsonl(root: &Path) -> Option<(SystemTime, PathBuf)> {
        let mut latest: Option<(SystemTime, PathBuf)> = None;
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
                        && let Ok(meta) = entry.metadata()
                        && let Ok(mtime) = meta.modified()
                    {
                        match &latest {
                            Some((ts, _)) if *ts >= mtime => {}
                            _ => latest = Some((mtime, path.clone())),
                        }
                    }
                }
            }
        }
        latest
    }

    fn read_user_messages(path: &Path) -> Vec<String> {
        let file = match fs::File::open(path) {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };
        let reader = BufReader::new(file);
        let mut messages = Vec::new();

        for line in reader.lines().map_while(Result::ok) {
            let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            let (role, content_value) = Self::extract_role_and_content(&obj);
            let (Some(role), Some(content_value)) = (role, content_value) else {
                continue;
            };
            if role != "user" {
                continue;
            }

            if let Some(text) = Self::content_to_string(content_value) {
                messages.push(text);
            }
        }

        messages
    }

    fn default_log_path() -> PathBuf {
        if let Some(home) = dirs::home_dir() {
            return home.join(".codex").join("log").join("codex_extensions.log");
        }
        env::temp_dir().join("codex_extensions.log")
    }

    pub(crate) fn log_event(&self, message: impl AsRef<str>) {
        let enabled = env::var("codex_extensions_log")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !enabled {
            return;
        }
        let log_path = &self.log_path;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let line = format!("{timestamp:.3} [tui] {}\n", message.as_ref());
        if let Some(dir) = log_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = file.write_all(line.as_bytes());
        }
    }

    fn content_to_string(value: &Value) -> Option<String> {
        match value {
            Value::String(s) => Some(s.to_string()),
            Value::Array(items) => {
                let mut parts: Vec<String> = Vec::new();
                for item in items {
                    match item {
                        Value::String(s) => parts.push(s.to_string()),
                        Value::Object(obj) => {
                            if let Some(text) = obj.get("text").and_then(Value::as_str) {
                                parts.push(text.to_string());
                            }
                        }
                        _ => {}
                    }
                }
                if parts.is_empty() {
                    None
                } else {
                    Some(parts.join(""))
                }
            }
            _ => None,
        }
    }

    fn extract_role_and_content(
        obj: &serde_json::Map<String, Value>,
    ) -> (Option<&str>, Option<&Value>) {
        let direct_role = obj.get("role").and_then(Value::as_str);
        let direct_content = obj.get("content");
        if direct_role.is_some() || direct_content.is_some() {
            return (direct_role, direct_content);
        }

        if let Some(Value::Object(payload)) = obj.get("payload") {
            let role = payload.get("role").and_then(Value::as_str);
            let content = payload.get("content");
            return (role, content);
        }

        (None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn host_with_token(token: u64) -> ExtensionHost {
        ExtensionHost {
            scripts: Vec::new(),
            config: ExtensionConfig::default(),
            last_seed_mtime: RefCell::new(None),
            log_path: PathBuf::from("log"),
            session_path: RefCell::new(None),
            line_added_token: Arc::new(AtomicU64::new(token)),
        }
    }

    #[test]
    fn completion_end_cancels_line_added_timer() {
        let host = host_with_token(7);
        host.notify_event("completion_end");
        assert_eq!(8, host.line_added_token.load(Ordering::SeqCst));
    }

    #[test]
    fn unrelated_events_do_not_cancel_line_added_timer() {
        let host = host_with_token(2);
        host.notify_event("some_other_event");
        assert_eq!(2, host.line_added_token.load(Ordering::SeqCst));
    }
}

struct HistorySeed {
    entries: Vec<String>,
    mtime: SystemTime,
    path: PathBuf,
}

#[derive(Debug, Deserialize)]
struct RawResponse {
    status: String,
    text: Option<String>,
    payload: Option<Value>,
    message: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct KeyBinding {
    pub code: KeyCode,
    pub modifiers: KeyModifiers,
}

impl KeyBinding {
    pub fn matches(&self, event: &crossterm::event::KeyEvent) -> bool {
        self.code == event.code && self.modifiers == event.modifiers
    }

    fn ctrl_char(ch: char) -> Self {
        Self {
            code: KeyCode::Char(ch),
            modifiers: KeyModifiers::CONTROL,
        }
    }

    #[allow(dead_code)]
    fn ctrl_code(code: KeyCode) -> Self {
        Self {
            code,
            modifiers: KeyModifiers::CONTROL,
        }
    }

    fn alt_code(code: KeyCode) -> Self {
        Self {
            code,
            modifiers: KeyModifiers::ALT,
        }
    }

    fn from_json(value: &Value) -> Option<Self> {
        let obj = value.as_object()?;
        let code_val = obj.get("code")?;
        let code = if let Some(s) = code_val.as_str() {
            match s {
                "PageUp" => KeyCode::PageUp,
                "PageDown" => KeyCode::PageDown,
                "Home" => KeyCode::Home,
                "End" => KeyCode::End,
                "Enter" => KeyCode::Enter,
                "Esc" => KeyCode::Esc,
                other if other.len() == 1 => KeyCode::Char(other.chars().next().unwrap_or(' ')),
                _ => return None,
            }
        } else {
            return None;
        };

        let ctrl = obj.get("ctrl").and_then(Value::as_bool).unwrap_or(false);
        let alt = obj.get("alt").and_then(Value::as_bool).unwrap_or(false);
        let shift = obj.get("shift").and_then(Value::as_bool).unwrap_or(false);

        let mut mods = KeyModifiers::empty();
        if ctrl {
            mods.insert(KeyModifiers::CONTROL);
        }
        if alt {
            mods.insert(KeyModifiers::ALT);
        }
        if shift {
            mods.insert(KeyModifiers::SHIFT);
        }

        Some(Self {
            code,
            modifiers: mods,
        })
    }
}
