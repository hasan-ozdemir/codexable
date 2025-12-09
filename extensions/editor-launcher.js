#!/usr/bin/env node
/**
 * Sample Codex TUI extension that handles external editing.
 *
 * Protocol:
 *  - Reads a single JSON object on stdin: { action: "external_edit", text: "<current text>" }
 *  - Writes a single JSON object on stdout:
 *      { status: "ok", text: "<new text>" }
 *      { status: "skip" } to fall back to built-in behaviour
 *      { status: "error", message: "<reason>" }
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function chooseEditor() {
  return (
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === "win32" ? "notepad" : "nano")
  );
}

let logPath = null;

function log(msg) {
  if (!logPath) return;
  try {
    const d = new Date();
    const stamp = `${d.getMinutes()}:${d.getSeconds()}`;
    fs.appendFileSync(logPath, `${stamp} [ext editor-launcher] ${msg}\n`);
  } catch {
    // ignore logging failures
  }
}

function handle(req) {
  logPath = req?.log_path;
  log(`request action=${req?.action}`);
  if (req.action === "config") {
    return {
      status: "ok",
      payload: {
        // Change shortcuts here; more than one keybinding allowed.
        external_edit_keys: [{ code: "Char", char: "g", ctrl: true }],
        history_prev_keys: [{ code: "PageUp", alt: true }],
        history_next_keys: [{ code: "PageDown", alt: true }],
        history_first_keys: [{ code: "Home", alt: true }],
        history_last_keys: [{ code: "End", alt: true }],
        // Override editor command if desired (string or array)
        editor_command: process.platform === "win32" ? "notepad" : "nano",
      },
    };
  }
  if (req.action !== "external_edit") {
    return { status: "skip" };
  }
  const editor = chooseEditor();
  log(`external_edit launching editor=${editor}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ext-"));
  const filePath = path.join(tmpDir, "input.txt");
  fs.writeFileSync(filePath, req.text ?? "", "utf8");

  const result = spawnSync(editor, [filePath], {
    stdio: "inherit",
  });
  if (result.status && result.status !== 0) {
    log(`editor exited with status ${result.status}`);
    return {
      status: "error",
      message: `Editor exited with status ${result.status}`,
    };
  }

  const output = fs.readFileSync(filePath, "utf8");
  const trimmed = output.replace(/\r?\n$/, "");
  log("external_edit returning updated text");
  return { status: "ok", text: trimmed };
}

function main() {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    let req = {};
    try {
      req = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch (err) {
      console.log(JSON.stringify({ status: "error", message: String(err) }));
      return;
    }
    try {
      console.log(JSON.stringify(handle(req)));
    } catch (err) {
      console.log(JSON.stringify({ status: "error", message: String(err) }));
    }
  });
}

if (require.main === module) {
  main();
} else {
  module.exports = { handle };
}
