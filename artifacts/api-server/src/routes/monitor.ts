/**
 * Reddit Lead Monitor — Express Routes
 * ----------------------------------------
 * This file does three things:
 *   1. Serves the HTML dashboard page at GET /api/monitor
 *   2. Controls the Python worker process (start / stop)
 *   3. Provides JSON endpoints the dashboard JavaScript calls via fetch()
 *
 * Architecture (educational overview):
 *   Browser  ──fetch()──▶  Express (Node.js)  ──spawn()──▶  Python worker
 *   Browser  ◀──JSON────  Express             ◀──stdout───  Python worker
 */

import { Router } from "express";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

const router = Router();

// ---------------------------------------------------------------------------
// PATHS
// ---------------------------------------------------------------------------

// Absolute path to the Python worker script
const WORKER_PATH = path.resolve("artifacts/lead-monitor/worker.py");

// Config file Express writes before spawning the Python worker
const CONFIG_PATH = path.resolve("artifacts/lead-monitor/monitor_config.json");

// ---------------------------------------------------------------------------
// IN-MEMORY STATE (shared across requests in this Node.js process)
// ---------------------------------------------------------------------------

let workerProcess: ChildProcess | null = null;  // the running Python process
let isRunning = false;
let logLines: string[] = [];                    // rolling log buffer (max 300)
const MAX_LOGS = 300;

const stats = { cycles: 0, matches: 0, alerts_sent: 0 };

// Default config — user edits this via the dashboard form
let config = {
  bot_token: "YOUR_BOT_TOKEN_HERE",
  chat_id: "YOUR_CHAT_ID_HERE",
  interval: 120,
  feeds: [
    "https://www.reddit.com/r/Entrepreneur/.rss",
    "https://www.reddit.com/r/smallbusiness/.rss",
    "https://www.reddit.com/r/forhire/.rss",
    "https://www.reddit.com/r/hireafreelancer/.rss",
    "https://www.reddit.com/r/webdesign/.rss",
  ],
  keywords: [
    "need a website",
    "looking for a website",
    "want a website",
    "build me a website",
    "hire a web developer",
    "need web developer",
    "looking for web developer",
    "need a landing page",
    "want a landing page",
    "need a web designer",
    "looking for web designer",
    "website redesign",
    "need ecommerce",
    "need an online store",
    "build a website",
    "website quote",
    "website budget",
    "how much does a website cost",
    "wordpress developer",
    "shopify developer",
  ],
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Add a line to the rolling log buffer. */
function addLog(line: string) {
  logLines.push(line);
  if (logLines.length > MAX_LOGS) logLines.shift(); // drop oldest
}

/** Parse a Python stdout line and update stats counters from it. */
function updateStats(line: string) {
  if (line.includes("[MATCH]"))    stats.matches++;
  if (line.includes("[TELEGRAM]")) stats.alerts_sent++;
  // Count cycle completions from "Cycle N done" lines
  if (line.includes("Cycle") && line.includes("done")) stats.cycles++;
}

/** Kill the worker if it's running. */
function killWorker() {
  if (workerProcess) {
    workerProcess.kill("SIGTERM");
    workerProcess = null;
  }
  isRunning = false;
}

// ---------------------------------------------------------------------------
// DASHBOARD HTML
// The browser loads this page, then JavaScript inside it calls our API.
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reddit Lead Monitor</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f1117; color: #e2e8f0; min-height: 100vh;
    }
    header {
      background: #1a1d27; border-bottom: 1px solid #2d3148;
      padding: 14px 20px; display: flex; align-items: center; gap: 12px;
    }
    header h1 { font-size: 1.1rem; font-weight: 700; color: #fff; }
    header .sub { font-size: 0.78rem; color: #64748b; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 99px;
      font-size: 0.75rem; font-weight: 600; letter-spacing: 0.03em;
    }
    .badge.stopped { background: #1e293b; color: #64748b; }
    .badge.running { background: #052e16; color: #4ade80; }
    .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .badge.running .dot { animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    main { max-width: 900px; margin: 0 auto; padding: 20px 16px 60px; display: flex; flex-direction: column; gap: 20px; }
    .card { background: #1a1d27; border: 1px solid #2d3148; border-radius: 10px; padding: 18px 20px; }
    .card h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin-bottom: 14px; }
    .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .stat { background: #12141e; border: 1px solid #2d3148; border-radius: 8px; padding: 14px; text-align: center; }
    .stat .num { font-size: 1.9rem; font-weight: 700; color: #818cf8; line-height: 1; }
    .stat .lbl { font-size: 0.72rem; color: #64748b; margin-top: 4px; }
    .controls { display: flex; gap: 10px; flex-wrap: wrap; }
    button {
      padding: 9px 20px; border: none; border-radius: 7px;
      font-size: 0.85rem; font-weight: 600; cursor: pointer;
      transition: opacity .15s, transform .1s;
    }
    button:active { transform: scale(.97); }
    button:disabled { opacity: .4; cursor: default; }
    #btn-start { background: #4f46e5; color: #fff; }
    #btn-start:hover:not(:disabled) { background: #4338ca; }
    #btn-stop  { background: #7f1d1d; color: #fca5a5; }
    #btn-stop:hover:not(:disabled)  { background: #991b1b; }
    #btn-save  { background: #14532d; color: #86efac; }
    #btn-save:hover { background: #166534; }
    #log-box {
      background: #0a0c14; border: 1px solid #1e2235; border-radius: 8px;
      height: 300px; overflow-y: auto; padding: 12px;
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 0.78rem; line-height: 1.6;
    }
    #log-box .line       { color: #94a3b8; }
    #log-box .line.FEED  { color: #38bdf8; }
    #log-box .line.MATCH { color: #fbbf24; font-weight: 600; }
    #log-box .line.TELEGRAM { color: #4ade80; }
    #log-box .line.ERROR { color: #f87171; }
    #log-box .line.WARN  { color: #fb923c; }
    .log-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    #auto-scroll-label { font-size: 0.78rem; color: #475569; display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    @media (max-width: 560px) { .form-grid { grid-template-columns: 1fr; } }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field label { font-size: 0.75rem; color: #64748b; }
    .field input, .field textarea {
      background: #0a0c14; border: 1px solid #2d3148; border-radius: 6px;
      color: #e2e8f0; padding: 8px 10px; font-size: 0.82rem; font-family: inherit;
      transition: border-color .15s; outline: none; width: 100%;
    }
    .field input:focus, .field textarea:focus { border-color: #4f46e5; }
    .field textarea { resize: vertical; min-height: 90px; line-height: 1.5; }
    .field .hint { font-size: 0.7rem; color: #475569; }
    .field.full { grid-column: 1 / -1; }
    .save-row { margin-top: 14px; display: flex; align-items: center; gap: 12px; }
    #save-msg { font-size: 0.78rem; color: #4ade80; opacity: 0; transition: opacity .3s; }
    .arch-box {
      background: #0a0c14; border: 1px solid #1e2235; border-radius: 8px;
      padding: 14px 16px; font-family: "SF Mono","Fira Code",monospace;
      font-size: 0.76rem; color: #64748b; line-height: 2;
    }
    .arch-box .hl { color: #818cf8; }
  </style>
</head>
<body>
<header>
  <h1>🔍 Reddit Lead Monitor</h1>
  <span class="sub">HTML + JS → Express → Python</span>
  <div style="margin-left:auto">
    <span class="badge stopped" id="status-badge"><span class="dot"></span> Stopped</span>
  </div>
</header>
<main>

  <div class="card">
    <h2>How It Works</h2>
    <div class="arch-box">
      <span class="hl">Your Browser (HTML/CSS/JS)</span>
        → fetch() every 2s →
      <span class="hl">Express server (Node.js)</span>
        → spawn() →
      <span class="hl">Python worker</span><br>
      Python scans Reddit RSS feeds → finds keywords → sends Telegram alerts → logs to stdout<br>
      Express captures stdout → stores in memory → sends back to browser as JSON
    </div>
  </div>

  <div class="card">
    <h2>Session Stats</h2>
    <div class="stats-row">
      <div class="stat"><div class="num" id="stat-cycles">0</div><div class="lbl">Cycles Run</div></div>
      <div class="stat"><div class="num" id="stat-matches">0</div><div class="lbl">Matches Found</div></div>
      <div class="stat"><div class="num" id="stat-alerts">0</div><div class="lbl">Alerts Sent</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Controls</h2>
    <div class="controls">
      <button id="btn-start" onclick="startMonitor()">▶ Start Monitor</button>
      <button id="btn-stop"  onclick="stopMonitor()" disabled>■ Stop</button>
    </div>
  </div>

  <div class="card">
    <div class="log-header">
      <h2 style="margin:0">Live Log <span style="color:#2d3148;font-weight:400">(Python stdout)</span></h2>
      <label id="auto-scroll-label">
        <input type="checkbox" id="auto-scroll" checked /> Auto-scroll
      </label>
    </div>
    <div id="log-box"><span style="color:#475569">Waiting for monitor to start…</span></div>
  </div>

  <div class="card">
    <h2>Configuration</h2>
    <div class="form-grid">
      <div class="field">
        <label>Telegram Bot Token</label>
        <input type="password" id="cfg-token" placeholder="123456:ABCdef…" />
        <span class="hint">Get from @BotFather on Telegram</span>
      </div>
      <div class="field">
        <label>Telegram Chat ID</label>
        <input type="text" id="cfg-chatid" placeholder="-100123456789" />
        <span class="hint">Get from @userinfobot on Telegram</span>
      </div>
      <div class="field">
        <label>Check Interval (seconds)</label>
        <input type="number" id="cfg-interval" min="30" step="30" value="120" />
        <span class="hint">Minimum 30 seconds</span>
      </div>
      <div class="field"></div>
      <div class="field full">
        <label>Reddit RSS Feeds (one per line)</label>
        <textarea id="cfg-feeds" rows="5"></textarea>
        <span class="hint">Format: https://www.reddit.com/r/subreddit/.rss</span>
      </div>
      <div class="field full">
        <label>Keywords to Watch (one per line)</label>
        <textarea id="cfg-keywords" rows="5"></textarea>
        <span class="hint">Case-insensitive. Each line is checked against post title + body.</span>
      </div>
    </div>
    <div class="save-row">
      <button id="btn-save" onclick="saveConfig()">💾 Save Config</button>
      <span id="save-msg">Saved!</span>
    </div>
  </div>

</main>
<script>
  /*
   * HOW THIS JAVASCRIPT WORKS (educational)
   * ─────────────────────────────────────────
   * 1. On load: fetch config from server, populate the form
   * 2. Every 2 seconds: fetch /api/monitor/status and /api/monitor/logs
   *    - Update stats counters
   *    - Append any new log lines to the log box
   * 3. Start button: POST /api/monitor/start  → server spawns Python
   * 4. Stop button:  POST /api/monitor/stop   → server kills Python
   * 5. Save button:  POST /api/monitor/config → server writes config.json
   */

  // Base path — the dashboard is served under /api/monitor
  const BASE = "/api/monitor";

  let isRunning    = false;
  let lastLogCount = 0;

  const logBox     = document.getElementById("log-box");
  const badge      = document.getElementById("status-badge");
  const btnStart   = document.getElementById("btn-start");
  const btnStop    = document.getElementById("btn-stop");
  const autoScroll = document.getElementById("auto-scroll");

  // Decide CSS class for a log line based on its level tag
  function classForLine(line) {
    if (line.includes("[MATCH]"))    return "MATCH";
    if (line.includes("[TELEGRAM]")) return "TELEGRAM";
    if (line.includes("[FEED]"))     return "FEED";
    if (line.includes("[ERROR]"))    return "ERROR";
    if (line.includes("[WARN]"))     return "WARN";
    return "INFO";
  }

  // Poll status + logs every 2 seconds
  async function poll() {
    try {
      // Fire both requests at once with Promise.all (faster than sequential)
      const [sRes, lRes] = await Promise.all([
        fetch(BASE + "/status"),
        fetch(BASE + "/logs"),
      ]);
      const status = await sRes.json();
      const logs   = await lRes.json();

      // Update stat counters
      document.getElementById("stat-cycles").textContent  = status.stats.cycles;
      document.getElementById("stat-matches").textContent = status.stats.matches;
      document.getElementById("stat-alerts").textContent  = status.stats.alerts_sent;

      // Update badge + buttons if running state changed
      if (status.running !== isRunning) {
        isRunning = status.running;
        updateUI();
      }

      // Append only NEW log lines (avoid re-rendering everything)
      const all = logs.lines;
      if (all.length > lastLogCount) {
        const newLines = all.slice(lastLogCount);
        lastLogCount   = all.length;
        if (logBox.querySelector("span")) logBox.innerHTML = "";
        newLines.forEach(line => {
          const div = document.createElement("div");
          div.className = "line " + classForLine(line);
          div.textContent = line;
          logBox.appendChild(div);
        });
        if (autoScroll.checked) logBox.scrollTop = logBox.scrollHeight;
      }
    } catch (e) {
      console.warn("Poll error:", e);
    }
  }

  function updateUI() {
    if (isRunning) {
      badge.className   = "badge running";
      badge.innerHTML   = '<span class="dot"></span> Running';
      btnStart.disabled = true;
      btnStop.disabled  = false;
    } else {
      badge.className   = "badge stopped";
      badge.innerHTML   = '<span class="dot"></span> Stopped';
      btnStart.disabled = false;
      btnStop.disabled  = true;
    }
  }

  async function startMonitor() {
    btnStart.disabled = true;
    lastLogCount = 0;
    logBox.innerHTML = "";
    const res  = await fetch(BASE + "/start", { method: "POST" });
    const data = await res.json();
    if (!data.ok) { alert(data.msg); btnStart.disabled = false; }
  }

  async function stopMonitor() {
    btnStop.disabled = true;
    await fetch(BASE + "/stop", { method: "POST" });
  }

  async function saveConfig() {
    const feeds    = document.getElementById("cfg-feeds").value.split("\\n").map(s=>s.trim()).filter(Boolean);
    const keywords = document.getElementById("cfg-keywords").value.split("\\n").map(s=>s.trim()).filter(Boolean);
    const payload  = {
      bot_token: document.getElementById("cfg-token").value,
      chat_id:   document.getElementById("cfg-chatid").value,
      interval:  parseInt(document.getElementById("cfg-interval").value, 10),
      feeds, keywords,
    };
    const res  = await fetch(BASE + "/config", {
      method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      const msg = document.getElementById("save-msg");
      msg.style.opacity = "1";
      setTimeout(() => msg.style.opacity = "0", 2000);
    }
  }

  async function loadConfig() {
    try {
      const res  = await fetch(BASE + "/config");
      const data = await res.json();
      document.getElementById("cfg-token").value    = data.bot_token;
      document.getElementById("cfg-chatid").value   = data.chat_id;
      document.getElementById("cfg-interval").value = data.interval;
      document.getElementById("cfg-feeds").value    = data.feeds.join("\\n");
      document.getElementById("cfg-keywords").value = data.keywords.join("\\n");
    } catch(e) { console.warn("Config load failed:", e); }
  }

  // Start polling and load saved config on page ready
  loadConfig();
  poll();
  setInterval(poll, 2000);
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

/** GET /api/monitor — serve the dashboard HTML page */
router.get("/monitor", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(DASHBOARD_HTML);
});

/** GET /api/monitor/status — current state + stats */
router.get("/monitor/status", (_req, res) => {
  res.json({ running: isRunning, stats: { ...stats } });
});

/** GET /api/monitor/logs — all buffered log lines */
router.get("/monitor/logs", (_req, res) => {
  res.json({ lines: [...logLines] });
});

/** GET /api/monitor/config — current config */
router.get("/monitor/config", (_req, res) => {
  res.json({ ...config });
});

/** POST /api/monitor/config — save new config */
router.post("/monitor/config", (req, res) => {
  const d = req.body as Partial<typeof config>;
  if (d.bot_token !== undefined) config.bot_token = String(d.bot_token).trim();
  if (d.chat_id   !== undefined) config.chat_id   = String(d.chat_id).trim();
  if (d.interval  !== undefined) config.interval  = Math.max(30, Number(d.interval));
  if (Array.isArray(d.feeds))    config.feeds      = d.feeds.filter(Boolean);
  if (Array.isArray(d.keywords)) config.keywords   = d.keywords.filter(Boolean);
  res.json({ ok: true });
});

/** POST /api/monitor/start — write config.json then spawn Python worker */
router.post("/monitor/start", (req, res) => {
  if (isRunning) return res.json({ ok: false, msg: "Already running" });

  // Reset state for fresh session
  logLines = [];
  stats.cycles = 0;
  stats.matches = 0;
  stats.alerts_sent = 0;

  // Write config to disk so Python can read it
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  // Spawn the Python worker process
  // python3 reads from CONFIG_PATH and prints logs to stdout
  workerProcess = spawn("python3", [WORKER_PATH], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"], // stdin=none, capture stdout+stderr
  });

  isRunning = true;

  // Capture every line Python prints to stdout
  workerProcess.stdout?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter((l) => l.trim());
    lines.forEach((line) => {
      addLog(line);
      updateStats(line);
    });
  });

  // Also capture stderr (import errors, tracebacks, etc.)
  workerProcess.stderr?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter((l) => l.trim());
    lines.forEach((line) => addLog(`[STDERR] ${line}`));
  });

  // Handle process exit (normal or crashed)
  workerProcess.on("exit", (code) => {
    addLog(`[INFO] Python worker exited (code ${code})`);
    isRunning = false;
    workerProcess = null;
  });

  res.json({ ok: true });
});

/** POST /api/monitor/stop — kill the Python worker process */
router.post("/monitor/stop", (_req, res) => {
  if (!isRunning) return res.json({ ok: false, msg: "Not running" });
  killWorker();
  res.json({ ok: true });
});

export default router;
