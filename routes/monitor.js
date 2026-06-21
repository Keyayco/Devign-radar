'use strict';

/**
 * routes/monitor.js — Reddit Lead Intel API routes
 * ──────────────────────────────────────────────────
 * Mounted at BASE/api by server.js.
 *
 * Endpoints
 * ──────────
 *  GET  /stream          Server-Sent Events (logs / leads / stats / status)
 *  GET  /status          Running state + session + DB stats
 *  GET  /logs            Buffered log lines (page-load hydration)
 *  POST /start           Spawn Python worker
 *  POST /stop            Kill Python worker
 *  GET  /config          Safe config (Telegram token NEVER returned)
 *  POST /config          Update and persist config
 *  GET  /leads           Paginated leads (optional ?intent= &sort=)
 *  PATCH /leads/:id      Update lead status tag
 */

const { Router } = require('express');
const path       = require('path');
const fs         = require('fs');
const wm         = require('../lib/worker-manager');
const db         = require('../lib/db');

const router      = Router();
const CONFIG_PATH = path.join(__dirname, '..', 'monitor_config.json');

// ── Default config ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  bot_token: '',
  chat_id:   '',
  interval:  120,
  feeds: [
    'https://www.reddit.com/r/Entrepreneur/.rss',
    'https://www.reddit.com/r/smallbusiness/.rss',
    'https://www.reddit.com/r/forhire/.rss',
    'https://www.reddit.com/r/hireafreelancer/.rss',
    'https://www.reddit.com/r/webdesign/.rss',
    'https://www.reddit.com/r/web_design/.rss',
  ],
  keywords: [
    'need a website',
    'looking for a website',
    'build me a website',
    'hire a web developer',
    'need web developer',
    'need a web designer',
    'looking for web designer',
    'website redesign',
    'need ecommerce',
    'need an online store',
    'website quote',
    'website budget',
    'how much does a website cost',
    'wordpress developer',
    'shopify developer',
    'shopify help',
    'need a landing page',
    'replace my developer',
    'developer disappeared',
    'freelancer needed',
    'need a developer',
  ],
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function persistConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── SSE ─────────────────────────────────────────────────────────────────────
router.get('/stream', (req, res) => {
  wm.addSSEClient(res);
});

// ── Status ───────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    running: wm.isRunning(),
    stats:   wm.getStats(),
    db:      db.getDbStats(),
  });
});

// ── Logs (for page-load hydration; SSE handles subsequent lines) ─────────────
router.get('/logs', (req, res) => {
  res.json({ lines: wm.getLogs() });
});

// ── Start ────────────────────────────────────────────────────────────────────
router.post('/start', (req, res) => {
  if (wm.isRunning()) {
    return res.json({ ok: false, msg: 'Monitor is already running' });
  }
  wm.startWorker(loadConfig());
  res.json({ ok: true });
});

// ── Stop ─────────────────────────────────────────────────────────────────────
router.post('/stop', (req, res) => {
  if (!wm.isRunning()) {
    return res.json({ ok: false, msg: 'Monitor is not running' });
  }
  wm.stopWorker();
  res.json({ ok: true });
});

// ── Config GET — NEVER expose the Telegram bot token ────────────────────────
router.get('/config', (req, res) => {
  const c = loadConfig();
  res.json({
    token_configured:   !!(c.bot_token && c.bot_token.length > 5),
    chat_id_configured: !!(c.chat_id   && c.chat_id.length   > 2),
    chat_id_display:    c.chat_id ? c.chat_id.slice(0, 5) + '…' : '',
    interval:           c.interval,
    feeds:              c.feeds,
    keywords:           c.keywords,
  });
});

// ── Config POST ───────────────────────────────────────────────────────────────
router.post('/config', (req, res) => {
  const b   = req.body || {};
  const cur = loadConfig();
  persistConfig({
    bot_token: b.bot_token?.trim() || cur.bot_token,
    chat_id:   b.chat_id?.trim()   || cur.chat_id,
    interval:  b.interval ? Math.max(30, Number(b.interval)) : cur.interval,
    feeds:     Array.isArray(b.feeds)    ? b.feeds.filter(Boolean)    : cur.feeds,
    keywords:  Array.isArray(b.keywords) ? b.keywords.filter(Boolean) : cur.keywords,
  });
  res.json({ ok: true });
});

// ── Leads GET ─────────────────────────────────────────────────────────────────
router.get('/leads', (req, res) => {
  const { intent, sort } = req.query;
  res.json({ leads: db.getLeads({ intent, sort }) });
});

// ── Lead PATCH — update status tag ─────────────────────────────────────────
router.patch('/leads/:id', (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const status = String((req.body || {}).status || '');

  if (!['new', 'contacted', 'ignored', 'won'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  if (isNaN(id))
    return res.status(400).json({ error: 'Invalid id' });

  db.updateLeadStatus(id, status);
  res.json({ ok: true });
});

module.exports = router;

