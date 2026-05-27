/**
 * worker-manager.ts
 * ──────────────────
 * Manages the Python worker subprocess lifecycle and SSE broadcasting.
 *
 * Responsibilities
 * ────────────────
 *  • Spawn / stop Python worker with python3 -u worker.py
 *  • Capture stdout + stderr; parse structured JSON lines
 *  • Persist logs to logs/monitor.log
 *  • Maintain a rolling in-memory log buffer (last 500 lines)
 *  • Broadcast SSE events to all connected dashboard clients
 *  • Auto-restart on unexpected crash (exponential back-off, max 60 s)
 *  • Track session stats (cycles / matches / alerts_sent)
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import type { Response } from "express";
import { insertLead, type LeadInput } from "./monitor-db.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// __dirname = artifacts/api-server/dist/ at runtime (set by esbuild banner)
const WORKSPACE_ROOT      = path.resolve(__dirname, "../../..");
export const WORKER_PATH  = path.join(WORKSPACE_ROOT, "artifacts/lead-monitor/worker.py");
export const CONFIG_PATH  = path.join(WORKSPACE_ROOT, "artifacts/lead-monitor/monitor_config.json");
const LOG_DIR             = path.join(WORKSPACE_ROOT, "logs");
const LOG_FILE            = path.join(LOG_DIR, "monitor.log");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let proc:               ChildProcess | null = null;
let _isRunning          = false;
let intentionallyStopped = false;
let restartDelay         = 5_000;   // ms; doubles on each crash (max 60 s)
let restartTimer:        ReturnType<typeof setTimeout> | null = null;

const MAX_LOG_LINES  = 500;
const logBuffer:     string[] = [];
let   logFileStream: fs.WriteStream | null = null;

const sessionStats = { cycles: 0, matches: 0, alerts_sent: 0 };

// SSE clients: each is an Express Response with SSE headers already set
const sseClients = new Set<Response>();

// Saved config for auto-restart
let savedConfig:    Record<string, unknown> | null = null;
let savedSeenIds:   string[] = [];

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function openLogStream() {
  ensureLogDir();
  logFileStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
}

function writeLog(line: string) {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  // Persist to file
  if (!logFileStream || logFileStream.destroyed) openLogStream();
  logFileStream?.write(line + "\n");
  // Broadcast to SSE clients
  broadcast("log", { line });
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function sse(res: Response, event: string, data: object) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    sseClients.delete(res);
  }
}

function broadcast(event: string, data: object) {
  sseClients.forEach((c) => sse(c, event, data));
}

/**
 * Attach a new SSE client. Called from the /monitor/stream route.
 * Sets the required headers and sends a snapshot of current state.
 */
export function addSSEClient(res: Response): void {
  res.setHeader("Content-Type",    "text/event-stream");
  res.setHeader("Cache-Control",   "no-cache, no-transform");
  res.setHeader("Connection",      "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");  // disable nginx buffering
  res.flushHeaders();

  sseClients.add(res);

  // Send current state immediately so the client renders correctly on connect
  sse(res, "status", { running: _isRunning });
  sse(res, "stats",  { ...sessionStats });

  // Keep-alive comment every 25 seconds (some proxies close idle SSE streams)
  const pingInterval = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(pingInterval); }
  }, 25_000);

  res.on("close", () => {
    sseClients.delete(res);
    clearInterval(pingInterval);
  });
}

// ---------------------------------------------------------------------------
// Parse structured JSON lines from Python stdout
// ---------------------------------------------------------------------------

function handleLine(raw: string) {
  const line = raw.trim();
  if (!line) return;

  // Try to parse as JSON; fall back to treating it as a plain log line
  let parsed: Record<string, unknown> | null = null;
  if (line.startsWith("{")) {
    try { parsed = JSON.parse(line); } catch { /* ignore */ }
  }

  if (!parsed) {
    writeLog(line);
    return;
  }

  switch (parsed.type) {
    case "log": {
      const level = String(parsed.level ?? "INFO");
      const msg   = String(parsed.msg ?? "");
      const ts    = new Date().toTimeString().slice(0, 8);
      writeLog(`[${ts}] [${level}] ${msg}`);
      break;
    }

    case "lead": {
      // Insert into SQLite; if duplicate, insertLead returns null
      const lead = insertLead(parsed as unknown as LeadInput);
      if (lead) {
        sessionStats.matches++;
        broadcast("lead", lead);
        writeLog(
          `[${new Date().toTimeString().slice(0, 8)}] [DB] Lead saved — ${lead.intent.toUpperCase()} score=${lead.score}: ${lead.title.slice(0, 60)}`
        );
      }
      break;
    }

    case "stat": {
      sessionStats.cycles      = Number(parsed.cycles      ?? sessionStats.cycles);
      sessionStats.alerts_sent = Number(parsed.alerts_sent ?? sessionStats.alerts_sent);
      broadcast("stats", { ...sessionStats });
      break;
    }

    default:
      writeLog(`[UNKNOWN] ${line}`);
  }
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

/**
 * Spawn the Python worker. Writes config to disk first.
 * config: the full MonitorConfig object (including bot_token)
 * seenIds: reddit_post_ids from DB so Python doesn't re-alert on restart
 */
export function startWorker(
  config: Record<string, unknown>,
  seenIds: string[]
): void {
  if (_isRunning) return;

  // Persist config for potential auto-restart
  savedConfig  = config;
  savedSeenIds = seenIds;

  // Write config + seen_post_ids for Python to read
  const configWithSeenIds = { ...config, seen_post_ids: seenIds };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configWithSeenIds, null, 2));

  // Reset stats for fresh session
  sessionStats.cycles      = 0;
  sessionStats.matches     = 0;
  sessionStats.alerts_sent = 0;

  intentionallyStopped = false;
  _isRunning           = true;
  restartDelay         = 5_000;

  openLogStream();
  spawnWorker();
}

function spawnWorker() {
  const ts = new Date().toTimeString().slice(0, 8);
  writeLog(`[${ts}] [SYSTEM] Spawning Python worker…`);

  proc = spawn("python3", ["-u", WORKER_PATH], {
    cwd:   process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  // --- stdout: parse JSON lines ---
  const rl = readline.createInterface({ input: proc.stdout! });
  rl.on("line", handleLine);

  // --- stderr: treat as plain log lines ---
  const rlErr = readline.createInterface({ input: proc.stderr! });
  rlErr.on("line", (line) => {
    const ts2 = new Date().toTimeString().slice(0, 8);
    writeLog(`[${ts2}] [STDERR] ${line}`);
  });

  // --- process exit ---
  proc.on("exit", (code, signal) => {
    const ts3 = new Date().toTimeString().slice(0, 8);
    writeLog(`[${ts3}] [SYSTEM] Worker exited (code=${code ?? "?"}, signal=${signal ?? "none"})`);
    proc = null;

    if (!intentionallyStopped) {
      // Unexpected crash — auto-restart with back-off
      const delay = restartDelay;
      restartDelay = Math.min(restartDelay * 2, 60_000);
      writeLog(
        `[${ts3}] [SYSTEM] Crash detected — restarting in ${delay / 1000}s…`
      );
      restartTimer = setTimeout(() => {
        if (!intentionallyStopped && savedConfig) {
          spawnWorker();
        }
      }, delay);
    } else {
      _isRunning = false;
      broadcast("status", { running: false });
    }
  });

  broadcast("status", { running: true });
}

export function stopWorker(): void {
  intentionallyStopped = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (proc) {
    proc.kill("SIGTERM");
    // Force-kill after 5 s if still alive
    setTimeout(() => {
      try { proc?.kill("SIGKILL"); } catch { /* already dead */ }
    }, 5_000);
  } else {
    _isRunning = false;
    broadcast("status", { running: false });
  }
  if (logFileStream && !logFileStream.destroyed) {
    logFileStream.end();
    logFileStream = null;
  }
}

// ---------------------------------------------------------------------------
// Accessors (used by routes)
// ---------------------------------------------------------------------------

export function isWorkerRunning(): boolean { return _isRunning; }
export function getStats() { return { ...sessionStats }; }
export function getLogs(): string[] { return [...logBuffer]; }
