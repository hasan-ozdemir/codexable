#!/usr/bin/env node

/**
 * TUI accessibility extension.
 *
 * Provides configuration flags for Codex TUI accessibility features so they
 * can be centrally toggled (and overridden via environment variables) without
 * hard-coding them in the Rust layer.
 */

let LOG_PATH = null;
let appReadyPlayed = false;

function log(msg) {
  if (!LOG_PATH) return;
  try {
    const ts = Date.now() / 1000;
    require("fs").appendFileSync(LOG_PATH, `${ts.toFixed(3)} [a11y] ${msg}\n`);
  } catch (err) {
    // best-effort logging only
  }
}

function respond(obj) {
  console.log(JSON.stringify(obj));
}

function parseBoolEnv(name, defaultVal) {
  const raw = process.env[name];
  if (raw === undefined) return defaultVal;
  const v = raw.toLowerCase();
  return !(v === "0" || v === "false" || v === "no");
}

function handleConfig() {
  respond({
    status: "ok",
    payload: {
      hide_edit_marker: parseBoolEnv("a11y_hide_edit_marker", false),
      hide_prompt_hints: parseBoolEnv("a11y_hide_prompt_hints", false),
      hide_statusbar_hints: parseBoolEnv("a11y_hide_statusbar_hints", false),
      align_left: parseBoolEnv("a11y_editor_align_left", false),
      editor_borderline: parseBoolEnv("a11y_editor_borderline", false),
      a11y_keyboard_shortcuts: parseBoolEnv("a11y_keyboard_shortcuts", false),
      a11y_audio_cues: parseBoolEnv("a11y_audio_cues", false),
    },
  });
}

let currentSound = null;

function playSound(file) {
  const path = require("path");
  const { spawn } = require("child_process");
  const fs = require("fs");
  const pkgRoot = (() => {
    try {
      const pkg = require.resolve("@openai/codex/package.json");
      return path.dirname(pkg);
    } catch {
      return null;
    }
  })();
  const jawsPath =
    "C:\\\\ProgramData\\\\Freedom Scientific\\\\JAWS\\\\2025\\\\SETTINGS\\\\enu\\\\SOUNDS\\\\TypeDing2.wav";

  const full = (() => {
    if (path.isAbsolute(file) && fs.existsSync(file)) {
      log(`playSound resolved absolute path ${file}`);
      return file;
    }
    const bundled = path.join(__dirname, "sounds", file);
    if (fs.existsSync(bundled)) return bundled;
    if (pkgRoot) {
      const pkgSound = path.join(pkgRoot, "extensions", "sounds", file);
      if (fs.existsSync(pkgSound)) return pkgSound;
    }
    log(`playSound fell back to JAWS default for ${file}`);
    return jawsPath;
  })();

  try {
    if (currentSound && !currentSound.killed) {
      currentSound.kill();
    }
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(New-Object Media.SoundPlayer '${full.replace(/'/g, "''")}').PlaySync()`,
      ],
      { stdio: "ignore" }
    );
    currentSound = child;
    child.on("exit", (code) => {
      if (currentSound === child) {
        currentSound = null;
      }
      if (code !== 0) {
        log(`playSound exit ${code} for ${file} (resolved ${full})`);
      }
    });
    child.on("error", (err) => {
      log(`playSound failed for ${file} (resolved ${full}): ${err}`);
    });
    return true;
  } catch (err) {
    log(`playSound threw for ${file} (resolved ${full}): ${err}`);
    return false;
  }
}

function handleNotify(payload, req) {
  if (!parseBoolEnv("a11y_audio_cues", false)) {
    log("notify skipped: a11y_audio_cues disabled");
    respond({ status: "skip" });
    return;
  }
  const event = (payload && payload.event) || (req && req.event);
  if (!event) {
    log("notify error: missing event");
    respond({ status: "error", message: "missing event" });
    return;
  }
  log(`notify event=${event}`);
  if (event === "line_end" || event === "line_added") {
    const ok = playSound("PushButtonUp.wav");
    respond(ok ? { status: "ok" } : { status: "error", message: "sound failed" });
    return;
  }
  if (event === "prompt_submitted") {
    const ok = playSound("TypeDing2.wav");
    respond(ok ? { status: "ok" } : { status: "error", message: "sound failed" });
    return;
  }
  if (event === "conversation_interrupted") {
    const ok = playSound("TableLayerExit.wav");
    respond(ok ? { status: "ok" } : { status: "error", message: "sound failed" });
    return;
  }
  if (event === "completion_end") {
    const ok = playSound("ascend.wav");
    respond(ok ? { status: "ok" } : { status: "error", message: "sound failed" });
    return;
  }
  if (event === "app_ready") {
    if (appReadyPlayed) {
      respond({ status: "skip" });
      return;
    }
    appReadyPlayed = true;
    // Use bundled notify.wav so it also works inside the packaged npm install.
    const ok = playSound("notify.wav");
    respond(ok ? { status: "ok" } : { status: "error", message: "sound failed" });
    return;
  }
  log(`notify skip: unknown event ${event}`);
  respond({ status: "skip" });
}

function main() {
  let req;
  try {
    const stdin = require("fs").readFileSync(0, "utf8");
    req = JSON.parse(stdin);
  } catch (err) {
    respond({ status: "error", message: `invalid request: ${String(err)}` });
    return;
  }

  LOG_PATH = req.log_path || null;

  switch (req.action) {
    case "config":
      return handleConfig();
    case "notify":
      return handleNotify(req.payload || {}, req);
    default:
      respond({ status: "skip" });
  }
}

function handle(req) {
  LOG_PATH = req?.log_path || null;
  if (req.action === "config") {
    handleConfig();
    return;
  }
  if (req.action === "notify") {
    handleNotify(req.payload || {}, req);
    return;
  }
  respond({ status: "skip" });
}

if (require.main === module) {
  main();
} else {
  module.exports = { handle };
}
