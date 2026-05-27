# Reddit Lead Intelligence Platform

A real-time Reddit monitoring system that finds high-intent business leads,
scores them by buying intent, stores them in SQLite, and sends Telegram alerts —
all controlled from a mobile-responsive dark dashboard.

---

## What It Does

1. **Monitors** Reddit RSS feeds every N seconds for configurable keywords
2. **Scores** each matching post on a 0–100 buying-intent scale
3. **Classifies** leads as `high`, `medium`, or `low` intent
4. **Stores** every lead permanently in SQLite (no duplicates across restarts)
5. **Alerts** you via Telegram for medium and high intent leads only
6. **Streams** logs, new leads, and stats to the dashboard in real time via SSE

---

## Architecture

```
Browser (Vanilla HTML/CSS/JS)
  │  EventSource SSE ────────────────────────────────────────────────┐
  │  fetch() REST calls ──────────────────────┐                      │
  ▼                                           ▼                      │
Express API Server (Node.js / TypeScript)     │                      │
  │  routes/monitor.ts  ← 10 REST endpoints  ◄┘                     │
  │  lib/monitor-db.ts  ← SQLite (better-sqlite3)                    │
  │  lib/worker-manager.ts ← subprocess + SSE broadcast ────────────►│
  │  spawn("python3", ["-u", "worker.py"])
  ▼
Python Worker (worker.py)
  │  feedparser + requests → Reddit RSS feeds
  │  Intent scoring (high/medium/low)
  │  Telegram alerts (medium + high only)
  └─ stdout JSON lines ──► Express ──► SQLite + SSE ──► Browser
```

**No React. No Vue. No frontend framework. Pure HTML/CSS/JS.**

---

## Key Files

| File | Purpose |
|------|---------|
| `artifacts/lead-monitor/dashboard.html` | Standalone vanilla dashboard (HTML/CSS/JS) |
| `artifacts/lead-monitor/worker.py` | Python RSS scanner + intent scorer |
| `artifacts/lead-monitor/monitor_config.json` | Runtime config (auto-created) |
| `artifacts/api-server/src/routes/monitor.ts` | Express route handlers |
| `artifacts/api-server/src/lib/monitor-db.ts` | SQLite schema + queries |
| `artifacts/api-server/src/lib/worker-manager.ts` | Worker lifecycle + SSE |
| `lead_monitor.db` | SQLite database (workspace root, auto-created) |
| `logs/monitor.log` | Persistent log file (workspace root, auto-created) |

---

## Setup

### 1. Install dependencies

```bash
pnpm install
```

Python packages (if not already installed):
```bash
pip install feedparser requests
```

### 2. Start the server

The Express API server runs via the configured workflow:

```bash
pnpm --filter @workspace/api-server run dev
```

### 3. Open the dashboard

Navigate to `/api/monitor` in the browser preview pane.

### 4. Configure Telegram (optional)

1. Create a Telegram bot via [@BotFather](https://t.me/botfather) — copy the token
2. Get your Chat ID via [@userinfobot](https://t.me/userinfobot)
3. Open the **Config** tab in the dashboard
4. Paste the token and chat ID → **Save Config**

> The token is never returned by the API — only `token_configured: true/false`
> is shown in the UI.

### 5. Start monitoring

Click **▶ Start Monitor** in the dashboard.

---

## Dashboard Tabs

### Monitor
- Live log streaming directly from Python stdout via SSE
- Session stats: cycles / leads found / alerts sent
- Start / Stop controls

### Leads
- Filter by intent: All | High | Medium | Low
- Score bar (0–100), colour-coded intent badge, subreddit, linked title, keyword
- Status tags: **New** → **Contacted** → **Ignored** → **Won**
- Status saved to SQLite immediately on change

### Config
- Telegram token (write-only — never displayed after save)
- Telegram chat ID
- Check interval (minimum 30 seconds)
- RSS feed list (one per line)
- Keyword list (one per line)

---

## Intent Scoring

Scores are additive. Final score is clamped 0–100.

### High intent keywords (+20 to +40 pts each)
`hire`, `hiring`, `freelancer needed`, `need developer`, `budget`, `quote`,
`paying`, `asap`, `urgent`, `contract`, `build my`, `need someone to`, …

### Low intent keywords (−10 to −25 pts each)
`feedback`, `critique`, `showcase`, `what do you think`, `rate my`,
`roast my`, `i made`, `i built`, `side project`, `for fun`, `wip`, …

### Classification thresholds
| Score | Intent |
|-------|--------|
| ≥ 60  | `high` — Telegram alert sent |
| ≥ 25  | `medium` — Telegram alert sent |
| < 25  | `low` — stored silently |

---

## Default Keywords (web dev leads)

```
need a website, looking for a website, build me a website,
hire a web developer, need web developer, looking for web designer,
website redesign, need ecommerce, website quote, website budget,
wordpress developer, shopify developer, how much does a website cost …
```

Edit freely via the Config tab.

---

## Default Feeds

```
r/Entrepreneur, r/smallbusiness, r/forhire,
r/hireafreelancer, r/webdesign
```

Edit freely via the Config tab (one RSS URL per line).

---

## Database Schema

```sql
CREATE TABLE leads (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  reddit_post_id       TEXT UNIQUE NOT NULL,   -- dedup key
  subreddit            TEXT NOT NULL,
  title                TEXT NOT NULL,
  content              TEXT,
  url                  TEXT NOT NULL,
  matched_keyword      TEXT NOT NULL,
  score                INTEGER DEFAULT 0,
  intent               TEXT DEFAULT 'low',     -- high | medium | low
  status               TEXT DEFAULT 'new',     -- new | contacted | ignored | won
  ai_summary           TEXT,                   -- reserved for future AI
  ai_score             INTEGER,                -- reserved for future AI
  ai_reply_suggestion  TEXT,                   -- reserved for future AI
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE outreach (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id        INTEGER REFERENCES leads(id),
  message        TEXT,
  sent           INTEGER DEFAULT 0,
  reply_received INTEGER DEFAULT 0,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/monitor` | Dashboard HTML |
| `GET` | `/api/monitor/stream` | SSE stream |
| `POST` | `/api/monitor/start` | Start worker |
| `POST` | `/api/monitor/stop` | Stop worker |
| `GET` | `/api/monitor/status` | `{ running, stats }` |
| `GET` | `/api/monitor/logs` | Recent log lines |
| `GET` | `/api/monitor/config` | Safe config (no token) |
| `POST` | `/api/monitor/config` | Update config |
| `GET` | `/api/monitor/leads?intent=high` | Leads (filterable) |
| `PATCH` | `/api/monitor/leads/:id` | Update status |

---

## Worker Reliability

- **Crash detection:** if the worker exits while `isRunning` is true, it restarts automatically
- **Exponential back-off:** 5s → 10s → 20s → 40s → 60s (max) between restarts
- **Clean stop:** SIGTERM sent; SIGKILL follows 5 seconds later if still alive
- **Deduplication:** `seen_ids` seeded from SQLite at each start — no re-alerts on restart
- **ETag caching:** HTTP 304 Not Modified respected — unchanged feeds skip reprocessing

---

## Future AI Hook

The schema is ready. To add AI classification, populate these fields per lead:

```typescript
lead.ai_summary          = await gpt.summarize(lead.content);
lead.ai_score            = await gpt.scoreIntent(lead.title, lead.content);
lead.ai_reply_suggestion = await gpt.draftReply(lead.title, lead.subreddit);
```

No database migration needed — columns already exist.

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla HTML5 / CSS3 / ES2023 JS |
| Backend | Express 5 + TypeScript (Node.js 24) |
| Database | SQLite via `better-sqlite3` |
| Worker | Python 3 (`feedparser`, `requests`) |
| Realtime | Server-Sent Events (SSE) |
| Build | esbuild (ESM bundle) |
