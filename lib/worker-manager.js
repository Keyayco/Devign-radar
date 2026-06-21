'use strict';

/**
 * lib/worker-manager.js
 * ──────────────────────
 * Manages the Python worker subprocess and broadcasts events via SSE.
 *
 * Responsibilities
 * ─────────────────
 *  • Spawn / stop python3 -u worker.py
 *  • Parse structured JSON lines from Python stdout
 *  • Persist logs to logs/monitor.log (append mode)
 *  • Keep a rolling in-memory log buffer for page-load hydration
 *  • Broadcast SSE events to all connected browser clients
 *  • Auto-restart on unexpected crash (exponential back-off, 5s → 60s max)
 *  • Expose isRunning(), getStats(), getLogs() for routes
 */

const { spawn } = require('child_process');
const readline  = require('readline');
const path      = require('path');
const fs        = require('fs');
const db        = require('./db');

// ── Paths ──────────────────────────────────────────────────────────────────
const WORKER_PATH = path.join(__dirname, '..', 'worker.py');
const CONFIG_PATH = path.join(__dirname, '..', 'monitor_config.json');
const LOG_DIR     = path.join(__dirname, '..', 'logs');
const LOG_FILE    = path.join(LOG_DIR, 'monitor.log');

// ── State ──────────────────────────────────────────────────────────────────
let proc               = null;
let _isRunning         = false;
let intentionallyStopped = false;
let restartDelay       = 5_000;   // ms; doubles on crash (max 60 s)
let restartTimer       = null;
let savedConfig        = null;
let logFileStream      = null;

const MAX_LOGS    = 600;
const logBuffer   = [];
const sseClients  = new Set();

const stats = {
  cycles: 0, matches: 0, alerts_sent: 0,
  dupes_skipped: 0, last_scan_ms: 0,
};

// ── Log helpers ─────────────────────────────────────────────────────────────
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function openLogStream() {
  ensureLogDir();
  if (logFileStream && !logFileStream.destroyed) return;
  logFileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

function writeLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  openLogStream();
  try { logFileStream.write(line + '\n'); } catch {}
  broadcast('log', { line });
}

// ── SSE ────────────────────────────────────────────────────────────────────
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); }
    catch { sseClients.delete(res); }
  }
}

/**
 * Attach a new SSE client (called by the /api/stream route).
 * Sets headers, sends an immediate snapshot, then waits for events.
 */
function addSSEClient(res) {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache, no-transform');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // disable nginx proxy buffering
  res.flushHeaders();

  sseClients.add(res);

  // Immediate snapshot so the UI renders the correct state on connect
  res.write(`event: status\ndata: ${JSON.stringify({ running: _isRunning })}\n\n`);
  res.write(`event: stats\ndata:  ${JSON.stringify({ ...stats })}\n\n`);

  // Keep-alive comment every 25 s (some proxies kill idle SSE connections)
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch { clearInterval(ping); sseClients.delete(res); }
  }, 25_000);

  res.on('close', () => {
    sseClients.delete(res);
    clearInterval(ping);
  });
}

// ── Stdout parser ───────────────────────────────────────────────────────────
function handleLine(raw) {
  const line = raw.trim();
  if (!line) return;

  // Attempt to parse as structured JSON; fall back to plain log line
  let parsed = null;
  if (line.startsWith('{')) {
    try { parsed = JSON.parse(line); } catch {}
  }

  if (!parsed) {
    writeLog(line);
    return;
  }

  const ts = () => new Date().toTimeString().slice(0, 8);

  switch (parsed.type) {

    case 'log':
      writeLog(`[${ts()}] [${parsed.level || 'INFO'}] ${parsed.msg || ''}`);
      break;

    case 'lead': {
      // Insert into SQLite — returns null if it's a duplicate (race condition guard)
      const lead = db.insertLead(parsed);
      if (lead) {
        stats.matches++;
        broadcast('lead', lead);
        writeLog(`[${ts()}] [DB] Saved ${lead.intent.toUpperCase()} score=${lead.score} value=${lead.lead_value} — ${lead.title.slice(0, 55)}`);
      }
      break;
    }

    case 'stat':
      if (parsed.cycles      != null) stats.cycles       = parsed.cycles;
      if (parsed.alerts_sent != null) stats.alerts_sent  = parsed.alerts_sent;
      if (parsed.dupes       != null) stats.dupes_skipped = parsed.dupes;
      if (parsed.scan_ms     != null) stats.last_scan_ms  = parsed.scan_ms;
      broadcast('stats', { ...stats });
      // Also persist the scan stat to DB for historical queries
      if (parsed.cycle_detail) db.recordScanStat(parsed.cycle_detail);
      break;

    default:
      writeLog(`[${ts()}] [?] ${line}`);
  }
}

// ── Worker lifecycle ────────────────────────────────────────────────────────
function startWorker(config) {
  if (_isRunning) return;

  savedConfig          = config;
  intentionallyStopped = false;
  _isRunning           = true;
  restartDelay         = 5_000;

  // Reset session stats
  Object.assign(stats, { cycles: 0, matches: 0, alerts_sent: 0, dupes_skipped: 0, last_scan_ms: 0 });

  // Pass config + known seen_ids to Python so it skips already-stored posts
  const seenIds   = db.getSeenIds();
  const configOut = { ...config, seen_post_ids: seenIds };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configOut, null, 2));

  openLogStream();
  spawnWorker();
}

function spawnWorker() {
  const ts = new Date().toTimeString().slice(0, 8);
  writeLog(`[${ts}] [SYSTEM] Spawning worker  (${seenCount()} known IDs seeded)`);

  proc = spawn('python3', ['-u', WORKER_PATH], {
    cwd:   path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  readline.createInterface({ input: proc.stdout }).on('line', handleLine);
  readline.createInterface({ input: proc.stderr  }).on('line', l =>
    writeLog(`[${new Date().toTimeString().slice(0, 8)}] [STDERR] ${l}`)
  );

  proc.on('exit', (code, signal) => {
    const ts2 = new Date().toTimeString().slice(0, 8);
    writeLog(`[${ts2}] [SYSTEM] Worker exited  code=${code ?? '?'}  signal=${signal ?? 'none'}`);
    proc = null;

    if (!intentionallyStopped) {
      // Unexpected crash → auto-restart with back-off
      const delay = restartDelay;
      restartDelay = Math.min(restartDelay * 2, 60_000);
      writeLog(`[${ts2}] [SYSTEM] Crash detected — restarting in ${delay / 1000}s…`);
      restartTimer = setTimeout(() => {
        if (!intentionallyStopped) spawnWorker();
      }, delay);
    } else {
      _isRunning = false;
      broadcast('status', { running: false });
    }
  });

  broadcast('status', { running: true });
}

function stopWorker() {
  intentionallyStopped = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }

  if (proc) {
    proc.kill('SIGTERM');
    // Force-kill after 5 s if still alive
    setTimeout(() => { try { proc && proc.kill('SIGKILL'); } catch {} }, 5_000);
  } else {
    _isRunning = false;
    broadcast('status', { running: false });
  }

  if (logFileStream && !logFileStream.destroyed) {
    logFileStream.end();
    logFileStream = null;
  }
}

function seenCount() {
  try { return db.getSeenIds().length; } catch { return 0; }
}

// ── Public API ──────────────────────────────────────────────────────────────
module.exports = {
  startWorker,
  stopWorker,
  addSSEClient,
  isRunning: () => _isRunning,
  getStats:  () => ({ ...stats }),
  getLogs:   () => [...logBuffer],
};

