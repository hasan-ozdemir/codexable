#!/usr/bin/env node

/**
 * TUI accessibility extension.
 *
 * Provides configuration flags for Codex TUI accessibility features so they
 * can be centrally toggled (and overridden via environment variables) without
 * hard-coding them in the Rust layer.
 */

let LOG_PATH = null;

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

function playSound(file) {
  const path = require("path");
  const { spawnSync } = require("child_process");
  const full = path.join(__dirname, "sounds", file);
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(New-Object Media.SoundPlayer '${full.replace(/'/g, "''")}').PlaySync()`,
    ],
    { stdio: "ignore" }
  );
  if (result.error || result.status !== 0) {
    log(`playSound failed for ${file}: ${result.error || "status " + result.status}`);
    const fb = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[console]::beep(880,120)"],
      { stdio: "ignore" }
    );
    if (fb.error || fb.status !== 0) {
      log(`fallback beep failed: ${fb.error || "status " + fb.status}`);
      return false;
    }
  }
  return true;
}

function handleNotify(payload) {
  if (!parseBoolEnv("a11y_audio_cues", false)) {
    log("notify skipped: a11y_audio_cues disabled");
    respond({ status: "skip" });
    return;
  }
  const event = payload && payload.event;
  if (!event) {
    log("notify error: missing event");
    respond({ status: "error", message: "missing event" });
    return;
  }
  log(`notify event=${event}`);
  if (event === "line_end") {
    const ok = playSound("PushButtonUp.wav");
    respond(ok ? { status: "ok" } : { status: "error", message: "sound failed" });
    return;
  }
  if (event === "completion_end") {
    const ok = playSound("ascend.wav");
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
      return handleNotify(req.payload || {});
    default:
      respond({ status: "skip" });
  }
}

main();
