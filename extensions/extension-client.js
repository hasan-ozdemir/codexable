#!/usr/bin/env node
/**
 * Persistent extension client: hosts Codex TUI extensions and talks to the Rust
 * extension host over TCP (default port 5555).
 *
 * Protocol (line-delimited JSON):
 *  Host -> Client: { id, action, payload?, log_path? }
 *  Client -> Host: { id, status, text?, payload?, message? }
 *
 * Actions:
 *  - config: merge config payloads from all extensions.
 *  - notify: broadcast to all extensions, respond {status:"ok"}.
 *  - other actions: call extensions in order until one returns non-skip.
 *  - shutdown: stop client.
 */

const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT =
  Number(process.env.CODEX_EXTENSION_PORT || process.env.CODEX_EXT_PORT) || 5555;
const HOST = "127.0.0.1";

let LOG_PATH = process.env.CODEX_EXTENSION_LOG || null;
let LAST_SCRIPTS_SUMMARY = "";

function log(msg) {
  if (!LOG_PATH) return;
  try {
    const d = new Date();
    const stamp = `${d.getMinutes()}:${d.getSeconds()}`;
    fs.appendFileSync(LOG_PATH, `${stamp} [ext-client] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function discoverScripts() {
  const candidates = [];

  if (process.env.CODEX_TUI_EXTENSION_DIR) {
    candidates.push(process.env.CODEX_TUI_EXTENSION_DIR);
  }

  const exe = process.execPath;
  const exeAncestors = [];
  let cur = path.dirname(exe);
  while (cur && cur !== path.dirname(cur)) {
    exeAncestors.push(cur);
    cur = path.dirname(cur);
  }
  for (const dir of exeAncestors) {
    candidates.push(path.join(dir, "extensions"));
  }

  // Prefer the directory where this client script lives (npm package extensions dir)
  const scriptDir = __dirname;
  if (scriptDir) {
    candidates.push(scriptDir);
    candidates.push(path.join(scriptDir, "..")); // for future layout changes
  }

  const isPackaged = exeAncestors.some((p) =>
    p.split(path.sep).includes("node_modules"),
  );
  if (!isPackaged) {
    candidates.push(path.join(process.cwd(), "extensions"));
  }

  log(
    `discover scripts; candidates=${candidates
      .filter(Boolean)
      .join(", ") || "none"}`,
  );

  const scripts = [];
  const seen = new Set();
  const selfPath = __filename ? path.resolve(__filename) : null;
  for (const dir of candidates) {
    if (!dir || seen.has(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      continue;
    }
    seen.add(dir);
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.toLowerCase().endsWith(".js")) continue;
      const full = path.join(dir, entry);
      if (fs.statSync(full).isFile()) {
        // Never treat the extension-client itself as an extension handler; doing
        // so causes circular require warnings and timeouts.
        if (selfPath && path.resolve(full) === selfPath) continue;
        scripts.push(full);
      }
    }
  }

  scripts.sort();
  if (scripts.length === 0) {
    log("discover scripts: none found");
  } else {
    log(`discover scripts: ${scripts.join(", ")}`);
  }
  return scripts;
}

function buildHandler(file) {
  try {
    const mod = require(file);
    const fn = mod.dispatch || mod.handle || mod.handleRequest || mod.default;
    if (typeof fn === "function") {
      log(`loaded handler via require ${file}`);
      return async (req) => fn(req);
    }
  } catch (err) {
    log(`failed to require ${file}: ${err}`);
  }

  // Fallback: spawn as a standalone script (legacy CLI behaviour).
  return async (req) =>
    new Promise((resolve) => {
      log(`falling back to legacy spawn for ${file}`);
      const child = spawn("node", [file], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", () => {
        const line = stdout.trim().split(/\r?\n/).pop();
        if (!line) {
          resolve({
            status: "error",
            message: `empty response (stderr: ${stderr.trim()})`,
          });
          return;
        }
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          resolve({ status: "error", message: String(err) });
        }
      });
      try {
        child.stdin.write(JSON.stringify(req));
      } catch (err) {
        resolve({ status: "error", message: String(err) });
        return;
      }
      child.stdin.end();
    });
}

const SCRIPT_PATHS = discoverScripts();
const HANDLERS = SCRIPT_PATHS.map((p) => ({ path: p, fn: buildHandler(p) }));
LAST_SCRIPTS_SUMMARY = SCRIPT_PATHS.join(", ");
log(
  `extension-client starting pid=${process.pid} node=${process.execPath} script=${__filename} cwd=${process.cwd()} port=${HOST}:${PORT} handlers=${HANDLERS.length}`,
);

function mergeConfigPayloads(payloads) {
  const merged = {};
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined) {
        merged[k] = v;
      }
    }
  }
  return merged;
}

async function handleConfig(req) {
  const payloads = [];
  for (const { fn, path: scriptPath } of HANDLERS) {
    try {
      const resp = await fn({ ...req, action: "config" });
      if (resp && resp.status === "ok" && resp.payload) {
        payloads.push(resp.payload);
      }
    } catch (err) {
      log(`config failed for ${scriptPath}: ${err}`);
    }
  }
  return { status: "ok", payload: mergeConfigPayloads(payloads) };
}

async function handleNotify(req) {
  const payload = req.payload || {};
  await Promise.all(
    HANDLERS.map(async ({ fn, path: scriptPath }) => {
      try {
        await fn({ ...req, payload, action: "notify" });
      } catch (err) {
        log(`notify failed for ${scriptPath}: ${err}`);
      }
    }),
  );
  return { status: "ok" };
}

async function handleFirstMatch(req) {
  for (const { fn, path: scriptPath } of HANDLERS) {
    try {
      const resp = await fn(req);
      if (!resp || resp.status === "skip") {
        continue;
      }
      return resp;
    } catch (err) {
      log(`handler error for ${scriptPath}: ${err}`);
      return { status: "error", message: String(err) };
    }
  }
  return { status: "skip" };
}

function startServer() {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    if (LOG_PATH) {
      log(`client accepted connection; scripts=${LAST_SCRIPTS_SUMMARY || "none"}`);
    }
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        handleLine(line, socket);
      }
    });
    socket.on("close", () => process.exit(0));
    socket.on("error", (err) => {
      log(`socket error: ${err}`);
      process.exit(1);
    });
  });

  server.on("error", (err) => {
    log(`server error: ${err}`);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    log(`extension-client listening on ${HOST}:${PORT} with ${HANDLERS.length} scripts`);
  });
}

async function handleLine(line, socket) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    log(`invalid JSON: ${err}`);
    return;
  }
  if (req.log_path) {
    LOG_PATH = req.log_path;
    log(`log path updated from request: ${LOG_PATH}`);
  }
  const id = req.id;
  log(`request id=${id} action=${req.action || "unknown"}`);

  if (req.action === "shutdown") {
    socket.write(JSON.stringify({ id, status: "ok" }) + "\n");
    socket.end();
    process.exit(0);
    return;
  }

  let resp;
  try {
    if (req.action === "config") {
      resp = await handleConfig(req);
    } else if (req.action === "notify") {
      resp = await handleNotify(req);
    } else {
      resp = await handleFirstMatch(req);
    }
  } catch (err) {
    resp = { status: "error", message: String(err) };
  }

  const out = { id, ...resp };
  socket.write(JSON.stringify(out) + "\n");
}

startServer();

process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err?.stack || err}`);
  process.exit(1);
});

process.on("exit", (code) => {
  log(`extension-client exit code=${code}`);
});
