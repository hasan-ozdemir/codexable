#!/usr/bin/env node
/**
 * Message history navigator with per-session persistence.
 *
 * - On resume (history_seed), load the session rollout JSONL from disk,
 *   mirror user prompts into ~/.codex/history/<session-id>.jsonl, and set cursor.
 * - history_push appends new prompts into the same per-session JSONL.
 * - history_prev/history_next read from that per-session file and keep cursor in
 *   a sidecar state file so navigation works across invocations.
 * - Session id is derived from the rollout filename; the active session id is
 *   remembered in ~/.codex/history/current_session for subsequent calls.
 */

import fs from "fs";
import os from "os";
import path from "path";

function readRequest() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);
  });
}

let logPath = null;

function log(msg) {
  if (!logPath) return;
  try {
    const ts = (Date.now() / 1000).toFixed(3);
    fs.appendFileSync(logPath, `${ts} [ext message-history] ${msg}\n`);
  } catch {
    // ignore logging failures
  }
}

const historyDir = (() => {
  const home = os.homedir();
  if (home) return path.join(home, ".codex", "history");
  return path.join(os.tmpdir(), "codex-history");
})();

const currentSessionFile = path.join(historyDir, "current_session");

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function sessionIdFromPath(sessionPath) {
  if (typeof sessionPath !== "string" || !sessionPath.trim()) return null;
  const base = path.basename(sessionPath.trim());
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function sessionIdFromRequest(req) {
  return (
    sessionIdFromPath(req?.payload?.session_path) ??
    sessionIdFromPath(req?.session_path) ??
    (typeof req?.session_id === "string" ? req.session_id : null) ??
    (typeof req?.payload?.session_id === "string" ? req.payload.session_id : null)
  );
}

function readCurrentSessionId() {
  try {
    const raw = fs.readFileSync(currentSessionFile, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

function writeCurrentSessionId(id) {
  ensureDir(historyDir);
  try {
    fs.writeFileSync(currentSessionFile, id, "utf8");
  } catch {
    /* ignore */
  }
}

function activeSessionId(req) {
  const fromReq = sessionIdFromRequest(req);
  if (fromReq) {
    writeCurrentSessionId(fromReq);
    return fromReq;
  }
  const stored = readCurrentSessionId();
  if (stored) return stored;
  const fallback = "default-session";
  writeCurrentSessionId(fallback);
  return fallback;
}

function filesForSession(sessionId) {
  const dir = historyDir;
  return {
    entries: path.join(dir, `${sessionId}.jsonl`),
    state: path.join(dir, `${sessionId}.state.json`),
  };
}

function parseUserContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object" && typeof item.text === "string") {
        parts.push(item.text);
      }
    }
    return parts.length ? parts.join("") : null;
  }
  if (value && typeof value === "object" && typeof value.text === "string") {
    return value.text;
  }
  return null;
}

function readRolloutUserMessages(sessionPath) {
  const messages = [];
  try {
    const data = fs.readFileSync(sessionPath, "utf8");
    for (const line of data.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = obj?.payload && typeof obj.payload === "object" ? obj.payload : obj;
      const role = payload?.role;
      if (role !== "user") continue;
      const content = parseUserContent(payload?.content);
      if (typeof content === "string" && content.trim()) {
        messages.push(content);
      }
    }
  } catch {
    /* ignore read/parse errors */
  }
  return messages;
}

function readEntries(filePath) {
  const entries = [];
  try {
    const data = fs.readFileSync(filePath, "utf8");
    for (const line of data.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.text === "string") {
          entries.push(parsed.text);
        }
      } catch {
        // if plain string line, accept it
        entries.push(line);
      }
    }
  } catch {
    /* missing or unreadable file => empty */
  }
  return entries;
}

function overwriteEntries(filePath, entries) {
  ensureDir(path.dirname(filePath));
  const lines = entries.map((text) => JSON.stringify({ text }));
  try {
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function appendEntry(filePath, text) {
  ensureDir(path.dirname(filePath));
  try {
    fs.appendFileSync(filePath, `${JSON.stringify({ text })}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function readCursor(statePath, defaultCursor) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed && Number.isInteger(parsed.cursor)) {
      return Math.max(0, parsed.cursor);
    }
  } catch {
    /* ignore */
  }
  return defaultCursor;
}

function writeCursor(statePath, cursor) {
  ensureDir(path.dirname(statePath));
  try {
    fs.writeFileSync(statePath, JSON.stringify({ cursor }), "utf8");
  } catch {
    /* ignore */
  }
}

function normalizedText(req) {
  const payloadText =
    (req && req.payload && req.payload.text) || req.text || req.input;
  return typeof payloadText === "string" ? payloadText.trim() : "";
}

function handleSeed(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);
  log(`history_seed received session=${sessionId}`);
  const sessionPath = req?.payload?.session_path ?? req?.session_path;
  if (sessionPath) log(`history_seed session_path=${sessionPath}`);

  const fromSessionFile =
    typeof sessionPath === "string" ? readRolloutUserMessages(sessionPath) : [];
  const incoming = req?.payload?.entries ?? req?.entries;
  const merged =
    fromSessionFile.length > 0
      ? fromSessionFile
      : Array.isArray(incoming) && incoming.length > 0
      ? incoming.slice()
      : [];

  log(`history_seed entries=${merged.length}`);
  overwriteEntries(entriesFile, merged);
  writeCursor(stateFile, merged.length);
  return { status: "ok" };
}

function handlePush(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);
  const text = normalizedText(req);
  log(`history_push text='${text}'`);
  if (!text) {
    return { status: "skip" };
  }
  appendEntry(entriesFile, text);
  const entries = readEntries(entriesFile);
  writeCursor(stateFile, entries.length);
  return { status: "ok" };
}

function handlePrev(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);
  const entries = readEntries(entriesFile);
  let cursor = readCursor(stateFile, entries.length);
  log(`history_prev session=${sessionId} cursor=${cursor} entries=${entries.length}`);
  if (!entries.length) return { status: "skip" };
  cursor = Math.max(0, Math.min(cursor, entries.length));
  if (cursor === 0) {
    writeCursor(stateFile, cursor);
    return { status: "ok", text: entries[0] };
  }
  cursor -= 1;
  writeCursor(stateFile, cursor);
  return { status: "ok", text: entries[cursor] };
}

function handleNext(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);
  const entries = readEntries(entriesFile);
  let cursor = readCursor(stateFile, entries.length);
  log(`history_next session=${sessionId} cursor=${cursor} entries=${entries.length}`);
  if (!entries.length) return { status: "skip" };
  cursor = Math.max(0, Math.min(cursor, entries.length));
  if (cursor < entries.length) cursor += 1;
  const text = cursor >= entries.length ? "" : entries[cursor];
  writeCursor(stateFile, cursor);
  return { status: "ok", text };
}

function dispatch(req) {
  switch (req.action) {
    case "history_seed":
      return handleSeed(req);
    case "history_push":
      return handlePush(req);
    case "history_prev":
      return handlePrev(req);
    case "history_next":
      return handleNext(req);
    default:
      return { status: "skip" };
  }
}

function main() {
  readRequest()
    .then((req) => {
      logPath = req?.log_path;
      log(`request action=${req?.action}`);
      return dispatch(req);
    })
    .then((resp) => console.log(JSON.stringify(resp)))
    .catch((err) =>
      console.log(JSON.stringify({ status: "error", message: String(err) })),
    );
}

main();
