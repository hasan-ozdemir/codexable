#!/usr/bin/env node

/**
 * TUI accessibility extension.
 *
 * Provides configuration flags for Codex TUI accessibility features so they
 * can be centrally toggled (and overridden via environment variables) without
 * hard-coding them in the Rust layer.
 */

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
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(New-Object Media.SoundPlayer '${full.replace(/'/g, "''")}').PlaySync()`,
    ],
    { stdio: "ignore" }
  );
}

function handleNotify(payload) {
  if (!parseBoolEnv("a11y_audio_cues", false)) {
    respond({ status: "skip" });
    return;
  }
  const event = payload && payload.event;
  if (!event) {
    respond({ status: "error", message: "missing event" });
    return;
  }
  if (event === "line_end") {
    playSound("PushButtonUp.wav");
    respond({ status: "ok" });
    return;
  }
  if (event === "completion_end") {
    playSound("ascend.wav");
    respond({ status: "ok" });
    return;
  }
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
