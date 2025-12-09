use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use codex_protocol::protocol::SessionMetaLine;
use color_eyre::Result;
use serde_json::Value;
use tokio::task::spawn_blocking;
use uuid::Uuid;

/// Ensure every rollout file belongs to a single cwd.
/// If a file contains messages from multiple cwds, split it into separate files,
/// one per cwd, preserving timestamps and data. The original file is kept with
/// a `.mixed.bak` suffix to avoid data loss.
pub async fn normalize_sessions(codex_home: &Path) -> Result<()> {
    let root = codex_home.join("sessions");
    if !root.exists() {
        return Ok(());
    }
    let root = root.canonicalize().unwrap_or(root);
    spawn_blocking(move || normalize_sync(&root)).await??;
    Ok(())
}

fn normalize_sync(root: &Path) -> Result<()> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().is_none()
                || !path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
            {
                continue;
            }
            split_if_mixed(&path)?;
        }
    }
    Ok(())
}

fn split_if_mixed(path: &Path) -> Result<()> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(()),
    };
    let reader = BufReader::new(file);
    let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
    let mut current_cwd: Option<String> = None;
    let mut first_ts: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        let Ok(mut val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if first_ts.is_none() {
            first_ts = val
                .get("timestamp")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
        }
        if let Ok(meta) = serde_json::from_value::<SessionMetaLine>(val.clone()) {
            if let Some(cwd) = meta.meta.cwd.to_str() {
                current_cwd = Some(normalize_cwd(cwd));
            }
        }
        let key = current_cwd
            .clone()
            .unwrap_or_else(|| "_unknown".to_string());
        groups.entry(key).or_default().push(val.take());
    }

    if groups.len() <= 1 {
        return Ok(());
    }

    let ts_segment = timestamp_segment_from_filename(path)
        .or(first_ts)
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%dT%H-%M-%S").to_string());

    for (cwd, mut items) in groups {
        let new_id = Uuid::new_v4().to_string();
        for val in items.iter_mut() {
            if let Ok(mut meta) = serde_json::from_value::<SessionMetaLine>(val.clone()) {
                meta.meta.id = Uuid::parse_str(&new_id).unwrap_or_else(|_| Uuid::new_v4());
                *val = serde_json::to_value(meta)?;
            }
        }
        let file_name = format!("rollout-{ts_segment}-{new_id}.jsonl");
        let new_path = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(file_name);
        let mut fh = fs::File::create(&new_path)?;
        for v in items {
            writeln!(fh, "{}", serde_json::to_string(&v)?)?;
        }
    }

    // keep original as backup
    let backup = path.with_extension("mixed.bak");
    let _ = fs::rename(path, backup);
    Ok(())
}

fn normalize_cwd(cwd: &str) -> String {
    cwd.replace('\\', "/")
        .trim_start_matches("//?/")
        .trim_start_matches("\\\\?\\")
        .trim_end_matches('/')
        .to_ascii_lowercase()
        .to_string()
}

fn timestamp_segment_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy();
    let rest = stem.strip_prefix("rollout-")?;
    let pos = rest.rfind('-')?;
    Some(rest[..pos].to_string())
}
