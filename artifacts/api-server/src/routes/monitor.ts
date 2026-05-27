/**
 * monitor.ts — Reddit Lead Intelligence Platform routes
 * ──────────────────────────────────────────────────────
 * All logic is delegated to:
 *   src/lib/worker-manager.ts  — Python subprocess lifecycle + SSE
 *   src/lib/monitor-db.ts      — SQLite persistence
 *
 * Routes
 * ──────
 *   GET  /monitor              → serve dashboard HTML
 *   GET  /monitor/stream       → SSE (logs, leads, stats, status)
 *   POST /monitor/start        → spawn Python worker
 *   POST /monitor/stop         → kill Python worker
 *   GET  /monitor/status       → running state + stats
 *   GET  /monitor/logs         → buffered log lines (initial page load)
 *   GET  /monitor/config       → safe config (token never exposed)
 *   POST /monitor/config       → persist config to disk
 *   GET  /monitor/leads        → paginated leads from SQLite
 *   PATCH /monitor/leads/:id   → update lead status
 */

import { Router } from "express";
import fs from "fs";
import path from "path";
import {
  addSSEClient,
  startWorker,
  stopWorker,
  isWorkerRunning,
  getStats,
  getLogs,
  CONFIG_PATH,
} from "../lib/worker-manager.js";
import {
  getLeads,
  updateLeadStatus,
  getSeenIds,
} from "../lib/monitor-db.js";

const router = Router();

// ---------------------------------------------------------------------------
// Dashboard HTML — served as a static file
// ---------------------------------------------------------------------------

// __dirname = artifacts/api-server/dist/ at runtime (set by esbuild banner)
// Three levels up reaches the workspace root
const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");
const DASHBOARD_PATH = path.join(WORKSPACE_ROOT, "artifacts/lead-monitor/dashboard.html");

router.get("/monitor", (_req, res) => {
  res.sendFile(DASHBOARD_PATH);
});

// ---------------------------------------------------------------------------
// SSE stream — EventSource("/api/monitor/stream")
// ---------------------------------------------------------------------------

router.get("/monitor/stream", (req, res) => {
  addSSEClient(res);
  // Note: response intentionally kept open — SSE is a long-lived connection
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

router.get("/monitor/status", (_req, res) => {
  res.json({ running: isWorkerRunning(), stats: getStats() });
});

// ---------------------------------------------------------------------------
// Logs (for initial page hydration — SSE carries subsequent lines)
// ---------------------------------------------------------------------------

router.get("/monitor/logs", (_req, res) => {
  res.json({ lines: getLogs() });
});

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface MonitorConfig {
  bot_token: string;
  chat_id:   string;
  interval:  number;
  feeds:     string[];
  keywords:  string[];
}

const DEFAULT_CONFIG: MonitorConfig = {
  bot_token: "YOUR_BOT_TOKEN_HERE",
  chat_id:   "YOUR_CHAT_ID_HERE",
  interval:  120,
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

function loadConfig(): MonitorConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function persistConfig(cfg: MonitorConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ---------------------------------------------------------------------------
// GET /monitor/config — NEVER expose the bot token
// ---------------------------------------------------------------------------

router.get("/monitor/config", (_req, res) => {
  const cfg = loadConfig();

  const tokenOk  = !!cfg.bot_token && !cfg.bot_token.includes("YOUR_BOT");
  const chatOk   = !!cfg.chat_id   && !cfg.chat_id.includes("YOUR_CHAT");

  res.json({
    token_configured:   tokenOk,
    chat_id_configured: chatOk,
    // Partial mask — lets dashboard show "configured" without leaking real value
    chat_id_display:    chatOk ? cfg.chat_id.slice(0, 5) + "…" : "",
    interval:           cfg.interval,
    feeds:              cfg.feeds,
    keywords:           cfg.keywords,
  });
});

// ---------------------------------------------------------------------------
// POST /monitor/config — update config
// ---------------------------------------------------------------------------

router.post("/monitor/config", (req, res) => {
  const d   = req.body as Partial<MonitorConfig>;
  const cur = loadConfig();

  const updated: MonitorConfig = {
    // Only overwrite token/chatid if caller sent a non-empty value
    bot_token: d.bot_token?.trim() || cur.bot_token,
    chat_id:   d.chat_id?.trim()   || cur.chat_id,
    interval:  d.interval != null ? Math.max(30, Number(d.interval)) : cur.interval,
    feeds:     Array.isArray(d.feeds)    ? d.feeds.filter(Boolean)    : cur.feeds,
    keywords:  Array.isArray(d.keywords) ? d.keywords.filter(Boolean) : cur.keywords,
  };

  persistConfig(updated);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /monitor/start
// ---------------------------------------------------------------------------

router.post("/monitor/start", (_req, res) => {
  if (isWorkerRunning()) {
    res.json({ ok: false, msg: "Monitor is already running" }); return;
  }

  const cfg     = loadConfig();
  const seenIds = getSeenIds(); // prevents re-alerting on restart

  // Pass full config (including token) to worker-manager — it writes to disk
  startWorker(cfg as unknown as Record<string, unknown>, seenIds);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /monitor/stop
// ---------------------------------------------------------------------------

router.post("/monitor/stop", (_req, res) => {
  if (!isWorkerRunning()) {
    res.json({ ok: false, msg: "Monitor is not running" }); return;
  }
  stopWorker();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /monitor/leads
// ---------------------------------------------------------------------------

router.get("/monitor/leads", (req, res) => {
  const intent = typeof req.query.intent === "string" ? req.query.intent : undefined;
  const leads  = getLeads(intent);
  res.json({ leads });
});

// ---------------------------------------------------------------------------
// PATCH /monitor/leads/:id — update status tag
// ---------------------------------------------------------------------------

router.patch("/monitor/leads/:id", (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const status = String(req.body?.status ?? "");

  if (!["new", "contacted", "ignored", "won"].includes(status)) {
    res.status(400).json({ error: "Invalid status value" }); return;
  }
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid lead id" }); return;
  }

  updateLeadStatus(id, status);
  res.json({ ok: true });
});

export default router;
