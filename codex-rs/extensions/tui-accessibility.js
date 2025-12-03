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
      hide_edit_marker: parseBoolEnv("a11y_hide_edit_marker", true),
      hide_prompt_hints: parseBoolEnv("a11y_hide_prompt_hints", true),
      hide_statusbar_hints: parseBoolEnv("a11y_hide_statusbar_hints", true),
      align_left: parseBoolEnv("a11y_editor_align_left", true),
      editor_borderline: parseBoolEnv("a11y_editor_borderline", true),
      a11y_keyboard_shortcuts: parseBoolEnv("a11y_keyboard_shortcuts", true),
    },
  });
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
    default:
      respond({ status: "skip" });
  }
}

main();
