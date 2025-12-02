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

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

function readRequest() {
  const chunks = [];
  return new Promise((resolve, reject) => {
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

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
    const ts = (Date.now() / 1000).toFixed(3);
    fs.appendFileSync(logPath, `${ts} [ext editor-launcher] ${msg}\n`);
  } catch {
    // ignore logging failures
  }
}

function main() {
  readRequest()
    .then((req) => {
      logPath = req?.log_path;
      log(`request action=${req?.action}`);
      if (req.action === "config") {
        console.log(
          JSON.stringify({
            status: "ok",
            payload: {
              // Change shortcuts here; more than one keybinding allowed.
              external_edit_keys: [{ code: "Char", char: "e", ctrl: true }],
              history_prev_keys: [{ code: "PageUp", ctrl: true }],
              history_next_keys: [{ code: "PageDown", ctrl: true }],
              // Override editor command if desired (string or array)
              editor_command:
                process.platform === "win32" ? "notepad" : "nano",
            },
          }),
        );
        return;
      }
      if (req.action !== "external_edit") {
        console.log(JSON.stringify({ status: "skip" }));
        return;
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
        console.log(
          JSON.stringify({
            status: "error",
            message: `Editor exited with status ${result.status}`,
          }),
        );
        return;
      }

      const output = fs.readFileSync(filePath, "utf8");
      const trimmed = output.replace(/\r?\n$/, "");
      log("external_edit returning updated text");
      console.log(JSON.stringify({ status: "ok", text: trimmed }));
    })
    .catch((err) => {
      console.log(JSON.stringify({ status: "error", message: String(err) }));
    });
}

main();
