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

const fs = require("fs");
const os = require("os");
const path = require("path");

const ignoreSystemPrompts = (() => {
  const val = process.env.CODEX_HISTORY_IGNORE_SYSTEM_PROMPTS;
  if (val === undefined) return false;
  return !["0", "false", "no"].includes(String(val).trim().toLowerCase());
})();

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
    const d = new Date();
    const stamp = `${d.getMinutes()}:${d.getSeconds()}`;
    fs.appendFileSync(logPath, `${stamp} [ext message-history] ${msg}\n`);
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
const lastSessionPathFile = path.join(historyDir, "current_session_path");

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

function readLastSessionPath() {
  try {
    const raw = fs.readFileSync(lastSessionPathFile, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

function writeLastSessionPath(sessionPath) {
  if (typeof sessionPath !== "string" || !sessionPath.trim()) return;
  ensureDir(historyDir);
  try {
    fs.writeFileSync(lastSessionPathFile, sessionPath.trim(), "utf8");
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

function rolloutFileForSession(sessionId) {
  return path.join(historyDir, `${sessionId}.rollout.jsonl`);
}

function syncRolloutMirror(sessionPath, sessionId) {
  if (!sessionPath || !sessionId) return;
  const sessionPathStr = String(sessionPath).trim();
  if (!sessionPathStr) return;
  try {
    const data = fs.readFileSync(sessionPathStr);
    const target = rolloutFileForSession(sessionId);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, data);
  } catch (err) {
    log(`rollout sync failed: ${err}`);
  }
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
  const eventMessages = [];
  const responseMessages = [];
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

      if (obj?.type === "event_msg" && payload?.type === "user_message") {
        const text = extractEventUserText(payload);
        const cleaned = cleanText(text);
        if (cleaned) eventMessages.push(cleaned);
        continue;
      }

      const role = payload?.role;
      if (obj?.type === "response_item" && role === "user") {
        const text = extractResponseUserText(payload);
        const cleaned = cleanText(text);
        if (cleaned) responseMessages.push(cleaned);
      }
    }
  } catch {
    /* ignore read/parse errors */
  }
  if (eventMessages.length > 0) {
    return collapse_consecutive_unique(eventMessages);
  }
  return collapse_consecutive_unique(responseMessages);
}

function readEntries(filePath) {
  const entries = [];
  try {
    const data = fs.readFileSync(filePath, "utf8");
    for (const line of data.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.text === "string" && parsed.text.trim()) {
          const cleaned = cleanText(parsed.text);
          if (cleaned) entries.push(cleaned);
        }
      } catch {
        // if plain string line, accept it
        const cleaned = cleanText(line);
        if (cleaned) entries.push(cleaned);
      }
    }
  } catch {
    /* missing or unreadable file => empty */
  }
  return collapse_consecutive_unique(entries);
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
  if (typeof text !== "string" || !text.trim()) return;
  const cleaned = cleanText(text);
  if (!cleaned) return;
  const current = readEntries(filePath);
  const last = current[current.length - 1];
  if (last && normalize_key(last) === normalize_key(cleaned)) return;
  ensureDir(path.dirname(filePath));
  try {
    fs.appendFileSync(filePath, `${JSON.stringify({ text: cleaned })}\n`, "utf8");
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
  const cleaned = cleanText(payloadText);
  return cleaned ?? "";
}

function clampCursor(cursor, length) {
  if (!Number.isInteger(cursor)) return length;
  if (cursor < 0) return 0;
  if (cursor > length) return length;
  return cursor;
}

function extractEventUserText(payload) {
  let text = null;
  if (typeof payload?.message === "string") {
    text = payload.message;
  } else if (payload?.content) {
    text = parseUserContent(payload.content);
  }
  return text;
}

function extractResponseUserText(payload) {
  const content = parseUserContent(payload?.content);
  return content;
}

function dedup_entries(list) {
  return collapse_consecutive_unique(list);
}

function pushUnique(arr, seen, text) {
  const key = normalize_key(text);
  if (!key) return;
  if (seen.has(key)) return;
  seen.add(key);
  arr.push(cleanText(text));
}

function cleanText(text) {
  if (typeof text !== "string") return null;
  const normalized = text.replace(/\r\n?/g, "\n");
  const trimmed = normalized.trim();
  if (!trimmed) return null;
  if (ignoreSystemPrompts && isSystemGenerated(trimmed)) return null;
  return trimmed;
}

function normalize_key(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return null;
  return cleaned.replace(/\s+/g, " ");
}

function collapse_consecutive_unique(list) {
  const out = [];
  let lastKey = null;
  for (const item of list) {
    const key = normalize_key(item);
    if (!key) continue;
    if (key === lastKey) continue;
    lastKey = key;
    out.push(cleanText(item));
  }
  return out;
}

function isSystemGenerated(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("# AGENTS.md instructions for")) return true;
  if (trimmed.startsWith("<environment_context>")) return true;
  return false;
}

function handleSeed(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);
  log(`history_seed received session=${sessionId}`);
  const sessionPath = req?.payload?.session_path ?? req?.session_path;
  if (sessionPath) {
    log(`history_seed session_path=${sessionPath}`);
    writeLastSessionPath(sessionPath);
    syncRolloutMirror(sessionPath, sessionId);
  }

  const fromSessionFile =
    typeof sessionPath === "string" ? readRolloutUserMessages(sessionPath) : [];
  const incoming = req?.payload?.entries ?? req?.entries;
  const merged =
    fromSessionFile.length > 0
      ? fromSessionFile
      : Array.isArray(incoming) && incoming.length > 0
      ? incoming.slice()
      : [];
  const deduped = dedup_entries(merged);

  log(`history_seed entries=${deduped.length}`);
  overwriteEntries(entriesFile, deduped);
  writeCursor(stateFile, deduped.length);
  log(`history_seed persisted entries=${deduped.length}`);
  return { status: "ok" };
}

function handlePush(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);
  const sessionPath =
    req?.payload?.session_path ?? req?.session_path ?? readLastSessionPath();
  syncRolloutMirror(sessionPath, sessionId);
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
  let entries = readEntries(entriesFile);
  if (!entries.length) {
    const lastPath = readLastSessionPath();
    if (lastPath) {
      entries = readRolloutUserMessages(lastPath);
      overwriteEntries(entriesFile, entries);
      writeCursor(stateFile, entries.length);
    }
  }
  if (!entries.length) {
    log(`history_prev no entries for session=${sessionId}, skipping`);
    return { status: "skip" };
  }

  let cursor = clampCursor(readCursor(stateFile, entries.length), entries.length);
  if (cursor >= entries.length) {
    cursor = entries.length;
  }
  const idx = cursor <= 0 ? 0 : cursor - 1;
  writeCursor(stateFile, idx);
  const text = entries[idx] ?? "";
  log(
    `history_prev session=${sessionId} cursor_in=${cursor} cursor_out=${idx} entries=${entries.length}`,
  );
  return { status: "ok", text };
}

function handleFirst(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);
  let entries = readEntries(entriesFile);
  if (!entries.length) {
    const lastPath = readLastSessionPath();
    if (lastPath) {
      entries = readRolloutUserMessages(lastPath);
      overwriteEntries(entriesFile, entries);
    }
  }
  if (!entries.length) {
    log(`history_first no entries for session=${sessionId}, skipping`);
    return { status: "skip" };
  }
  writeCursor(stateFile, 0);
  const text = entries[0] ?? "";
  log(`history_first session=${sessionId} cursor_out=0 entries=${entries.length}`);
  return { status: "ok", text };
}

function handleNext(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);
  let entries = readEntries(entriesFile);
  if (!entries.length) {
    const lastPath = readLastSessionPath();
    if (lastPath) {
      entries = readRolloutUserMessages(lastPath);
      overwriteEntries(entriesFile, entries);
      writeCursor(stateFile, entries.length);
    }
  }
  if (!entries.length) {
    log(`history_next no entries for session=${sessionId}, skipping`);
    return { status: "skip" };
  }

  let cursor = clampCursor(readCursor(stateFile, entries.length), entries.length);
  if (cursor >= entries.length - 1) {
    writeCursor(stateFile, entries.length);
    log(
      `history_next session=${sessionId} cursor_in=${cursor} cursor_out=${entries.length} entries=${entries.length}`,
    );
    return { status: "ok", text: "" };
  }

  const idx = cursor + 1;
  const text = entries[idx] ?? "";
  writeCursor(stateFile, idx);
  log(
    `history_next session=${sessionId} cursor_in=${cursor} cursor_out=${idx} entries=${entries.length}`,
  );
  return { status: "ok", text };
}

function handleLast(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);
  let entries = readEntries(entriesFile);
  if (!entries.length) {
    const lastPath = readLastSessionPath();
    if (lastPath) {
      entries = readRolloutUserMessages(lastPath);
      overwriteEntries(entriesFile, entries);
    }
  }
  if (!entries.length) {
    log(`history_last no entries for session=${sessionId}, skipping`);
    return { status: "skip" };
  }
  let idx = entries.length - 1;
  writeCursor(stateFile, idx);
  const text = entries[idx] ?? "";
  log(`history_last session=${sessionId} cursor_out=${idx} entries=${entries.length}`);
  return { status: "ok", text };
}

function handleDelete(req) {
  const sessionId = activeSessionId(req);
  const { entries: entriesFile, state: stateFile } = filesForSession(sessionId);

  let entries = readEntries(entriesFile);
  if (!entries.length) {
    const lastPath = readLastSessionPath();
    if (lastPath) {
      entries = readRolloutUserMessages(lastPath);
      overwriteEntries(entriesFile, entries);
      writeCursor(stateFile, entries.length);
    }
  }

  if (!entries.length) {
    log(`history_delete no entries for session=${sessionId}, skipping`);
    return { status: "skip" };
  }

  const incomingIdx =
    Number.isInteger(req?.payload?.index) && req.payload.index >= 0
      ? req.payload.index
      : Number.isInteger(req?.index) && req.index >= 0
      ? req.index
      : null;
  const targetKey = normalize_key(normalizedText(req));
  let deleteIdx =
    Number.isInteger(incomingIdx) && incomingIdx < entries.length
      ? incomingIdx
      : -1;
  if (deleteIdx < 0 && targetKey) {
    deleteIdx = entries.findIndex(
      (e) => normalize_key(e) === targetKey && normalize_key(e) !== null,
    );
  }

  if (deleteIdx < 0 || deleteIdx >= entries.length) {
    log(`history_delete could not locate target entry`);
    return { status: "skip" };
  }

  const removedKey = normalize_key(entries[deleteIdx]) ?? targetKey;
  entries.splice(deleteIdx, 1);
  overwriteEntries(entriesFile, entries);

  let cursor = clampCursor(readCursor(stateFile, entries.length), entries.length);
  if (cursor > deleteIdx) {
    cursor -= 1;
  }
  if (cursor > entries.length) {
    cursor = entries.length;
  }
  writeCursor(stateFile, cursor);

  const sessionPath =
    req?.payload?.session_path ?? req?.session_path ?? readLastSessionPath();
  if (sessionPath && removedKey) {
    removeUserFromRollout(sessionPath, deleteIdx, removedKey);
  }
  if (sessionPath) {
    syncRolloutMirror(sessionPath, sessionId);
  }

  const next_text = entries[deleteIdx] ?? "";
  return { status: "ok", next_text };
}

function removeUserFromRollout(sessionPath, deleteIdx, targetKey) {
  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    const trailingNewline = raw.endsWith("\n");
    const lines = raw.split(/\r?\n/);
    const { events, responses } = collectRolloutUserLines(lines);
    const useEvents = events.length > 0;
    const list = useEvents ? events : responses;
    if (!list.length) return;

    let idx =
      Number.isInteger(deleteIdx) && deleteIdx >= 0 && deleteIdx < list.length
        ? deleteIdx
        : -1;
    if (idx < 0 && targetKey) {
      idx = list.findIndex(
        (entry) => normalize_key(entry.text) === targetKey && targetKey !== null,
      );
    }
    if (idx < 0 || idx >= list.length) return;

    const targetLine = list[idx].line;
    const filtered = lines.filter((_, i) => i !== targetLine);
    let output = filtered.join("\n");
    if (trailingNewline && !output.endsWith("\n")) {
      output += "\n";
    }
    fs.writeFileSync(sessionPath, output, "utf8");
  } catch (err) {
    log(`history_delete failed to update rollout: ${err}`);
  }
}

function collectRolloutUserLines(lines) {
  const events = [];
  const responses = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj?.payload && typeof obj.payload === "object" ? obj.payload : obj;
    if (obj?.type === "event_msg" && payload?.type === "user_message") {
      const text = extractEventUserText(payload);
      const cleaned = cleanText(text);
      if (cleaned) events.push({ line: i, text: cleaned });
      continue;
    }
    const role = payload?.role;
    if (obj?.type === "response_item" && role === "user") {
      const text = extractResponseUserText(payload);
      const cleaned = cleanText(text);
      if (cleaned) responses.push({ line: i, text: cleaned });
    }
  }
  return { events, responses };
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
    case "history_first":
      return handleFirst(req);
    case "history_last":
      return handleLast(req);
    case "history_delete":
      return handleDelete(req);
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

if (require.main === module) {
  main();
} else {
  module.exports = { dispatch };
}
