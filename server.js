'use strict';

/**
 * server.js — Reddit Lead Intelligence Platform
 * ──────────────────────────────────────────────
 * Plain Node.js + Express. No TypeScript. No build step. Just run:
 *   node server.js
 *
 * ENV vars
 * ─────────
 *   PORT      — listening port (default 3001)
 *   BASE_PATH — URL prefix when behind a proxy, e.g. /monitor (default '')
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, ''); // e.g. '/monitor' or ''

const FRONTEND  = path.join(__dirname, 'frontend');
const DASHBOARD = path.join(FRONTEND, 'dashboard.html');

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Dashboard ───────────────────────────────────────────────────────────────
// Serve dashboard.html, injecting the API base URL so app.js can find the API
// regardless of what proxy path this server lives behind.
function serveDashboard(req, res) {
  try {
    const html   = fs.readFileSync(DASHBOARD, 'utf8');
    const inject = `<script>window.API_BASE=${JSON.stringify(BASE + '/api')};</script>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html.replace('</head>', inject + '\n</head>'));
  } catch {
    res.status(500).send('Dashboard not found. Check frontend/dashboard.html exists.');
  }
}

// Serve dashboard at BASE/ and BASE (with or without trailing slash)
app.get(BASE + '/', serveDashboard);
if (BASE) {
  app.get(BASE, serveDashboard);
}

// ── Static files (styles.css, app.js) ──────────────────────────────────────
// Mounted AFTER the explicit dashboard route so index.html isn't auto-served
app.use(BASE + '/', express.static(FRONTEND));

// ── API routes ──────────────────────────────────────────────────────────────
const monitorRouter = require('./routes/monitor');
app.use(BASE + '/api', monitorRouter);

// ── Root health check (Replit port detection hits / without the BASE prefix) ─
app.get('/', (req, res) => {
  res.redirect(BASE + '/');
});
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// ── 404 fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error guards (prevent silent crash after startup) ─────────────────
process.on('uncaughtException', (err) => {
  console.error('[SERVER] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[SERVER] unhandledRejection:', reason);
});

// ── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}${BASE}/`;
  console.log(`[SERVER] Reddit Lead Intel running at ${url}`);
  console.log(`[SERVER] PID=${process.pid}  NODE_ENV=${process.env.NODE_ENV || 'development'}`);
});

server.on('error', (err) => {
  console.error('[SERVER] listen error:', err.message);
  process.exit(1);
});
