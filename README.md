# Reddit Lead Intelligence Platform

Real-time Reddit monitoring that finds, scores, and stores business leads.  
Dark dashboard, Telegram alerts, SQLite persistence, SSE streaming.

**Stack: Vanilla HTML/CSS/JS · Plain Express.js · Python worker · SQLite · No build step.**

---

## Quick Start

```bash
cd artifacts/lead-monitor
npm install
pip install -r requirements.txt
node server.js
# Dashboard → http://localhost:3001/
```

---

## Architecture

```
Browser (dashboard.html + styles.css + app.js)
  │
  │  EventSource SSE ────────────────────────────────────────────────────────┐
  │  fetch() REST ──────────────────────────────────────────────┐            │
  ▼                                                             ▼            │
server.js (Express 4, plain JS)                                              │
  │  routes/monitor.js   — 10 REST endpoints                   ◄────────────┘
  │  lib/db.js           — SQLite (better-sqlite3, sync)
  │  lib/worker-manager.js  — subprocess + SSE broadcast
  │
  │  spawn("python3", ["-u", "worker.py"])
  ▼
worker.py
  │  feedparser   — Reddit RSS feeds (ETag cached)
  │  requests     — Telegram alerts
  │  Intent score — 0-100, HIGH ≥70 / MEDIUM 45-69 / LOW <45
  └──▶ JSON lines on stdout ──▶ Express ──▶ SQLite + SSE ──▶ Browser
```

**No React. No TypeScript. No build step. Just `node server.js`.**

---

## File Map

```
artifacts/lead-monitor/
├── server.js              ← Express entry point
├── package.json           ← express + better-sqlite3 only
├── requirements.txt       ← feedparser, requests
├── .env.example           ← PORT, BASE_PATH
├── routes/
│   └── monitor.js         ← All 10 API endpoints
├── lib/
│   ├── db.js              ← SQLite schema + queries
│   └── worker-manager.js  ← Worker lifecycle + SSE
├── frontend/
│   ├── dashboard.html     ← Pure HTML (no inline CSS/JS)
│   ├── styles.css         ← All styles (~580 lines)
│   └── app.js             ← All JS (~310 lines)
├── worker.py              ← Reddit scanner + scorer
│
├── lead_monitor.db        ← Auto-created SQLite DB
├── monitor_config.json    ← Auto-created config
└── logs/monitor.log       ← Auto-created log file
```

---

## API Reference

| Method  | Endpoint             | Description                                |
|---------|----------------------|--------------------------------------------|
| `GET`   | `/api/stream`        | SSE (log / lead / stats / status events)   |
| `GET`   | `/api/status`        | `{ running, stats, db }`                   |
| `GET`   | `/api/logs`          | Recent log buffer (page-load hydration)    |
| `POST`  | `/api/start`         | Spawn Python worker                        |
| `POST`  | `/api/stop`          | Kill Python worker                         |
| `GET`   | `/api/config`        | Safe config — token **never** returned     |
| `POST`  | `/api/config`        | Update & persist config                    |
| `GET`   | `/api/leads`         | Leads (optional `?intent=&sort=`)          |
| `PATCH` | `/api/leads/:id`     | Update lead status                         |

When running behind Replit proxy at `/monitor`, prefix all paths: `/monitor/api/...`

---

## Database Schema

```sql
leads (
  id                  INTEGER PRIMARY KEY,
  reddit_post_id      TEXT UNIQUE,    -- normalized permalink (dedup key)
  subreddit           TEXT,
  title               TEXT,
  content             TEXT,
  url                 TEXT,
  matched_keyword     TEXT,
  score               INTEGER,        -- 0-100 intent score
  intent              TEXT,           -- high | medium | low
  lead_value          INTEGER,        -- 0-100 business value estimate
  status              TEXT,           -- new | contacted | ignored | won
  created_utc         INTEGER,        -- Unix timestamp of original post
  ai_summary          TEXT,           -- reserved for future AI
  ai_score            INTEGER,        -- reserved for future AI
  ai_reply_suggestion TEXT,           -- reserved for future AI
  created_at          DATETIME
)

outreach ( id, lead_id, message, sent, reply_received, created_at )
scan_stats ( id, cycle, posts_checked, matches_found, dupes_skipped, scan_ms, alerts_sent )
```

---

## Intent Scoring

Additive score, clamped 0–100. Multiple negative signals suppress heavily.

| Tier    | Score    | Examples                                                    |
|---------|----------|-------------------------------------------------------------|
| HIGH    | ≥ 70     | "developer disappeared" (+45), "hiring" (+30), "budget" (+30) |
| MEDIUM  | 45–69    | "launch my" (+20), "urgent" (+25), "local business" (+18)  |
| LOW     | < 45     | "what do you think" (−32), "showcase" (−32), "portfolio" (−30) |

Telegram alerts sent for **medium + high** only.

Detailed scoring logs in the live log:
```
[SCORE] +38 "need developer"  +30 "budget"  -26 "feedback"
```

---

## Deduplication

Cross-session deduplication is permanent and double-layered:

1. **Python in-memory `seen_ids` set** — seeded from DB at every startup via `seen_post_ids` in `monitor_config.json`. Prevents re-scoring within a session.
2. **SQLite `UNIQUE` on `reddit_post_id`** — `INSERT OR IGNORE` prevents duplicates even if Python misses one (race condition guard).
3. **URL normalisation** — query params stripped, host normalized to `www.reddit.com`, path lowercased, trailing slash removed.

```
[DEDUP] Skipping known post: "Need a web developer for my startup..."
```

---

## Lead Value Score

Separate from intent score. Estimates business ROI of the lead (0–100, base = 50).

| Signal              | Delta |
|---------------------|-------|
| saas                | +20   |
| agency, ecommerce   | +16–18|
| shopify, startup    | +14–16|
| hobby, student      | −20–22|
| for fun, learning   | −18–22|

---

## Lead Management

From the **Leads tab**:

- **Filter**: All | High | Medium | Low
- **Sort**: Newest | Highest Score | Highest Value
- **Age badges**: Just now / Xm ago / Xh ago / Xd ago (from original post `created_utc`)
- **Status tags**: New → Contacted → Ignored → Won (saved to DB on change)
- **Quick actions**: Open Reddit ↗ | Copy link 📋 | Mark Contacted 📧 | Mark Won ✅

---

## Worker Reliability

| Feature              | Behaviour                                              |
|----------------------|--------------------------------------------------------|
| Crash recovery       | Auto-restart if worker exits unexpectedly              |
| Back-off             | 5s → 10s → 20s → 40s → 60s max between restart attempts |
| Clean stop           | SIGTERM sent; SIGKILL after 5 s if still alive         |
| ETag caching         | `If-None-Match` / `If-Modified-Since` headers; 304 skipped |
| Log persistence      | All logs appended to `logs/monitor.log`                |
| SSE keep-alive       | `: ping` comment every 25 s to survive proxy timeouts  |

---

## Setup

### 1. Telegram (optional)

1. Message [@BotFather](https://t.me/botfather) → `/newbot` → copy the token
2. Message [@userinfobot](https://t.me/userinfobot) → copy your chat ID
3. Open **Config tab** → paste token + chat ID → **Save Config**

The token is **write-only** — the API never returns it. Only `token_configured: true/false` is exposed.

### 2. Feeds & Keywords

Defaults (editable via Config tab):

**Feeds:** r/Entrepreneur, r/smallbusiness, r/forhire, r/hireafreelancer, r/webdesign

**Keywords:** need a website, looking for a website, hire a web developer, website redesign, shopify developer, need ecommerce, developer disappeared, freelancer needed…

### 3. Start

Click **▶ Start Monitor**. Logs stream in real time via SSE.

---

## Deployment

See **[DEPLOY.md](./DEPLOY.md)** for full guides:
- Local / VPS (systemd + nginx)
- Railway
- Render
- SQLite backup strategy

---

## Security

- Telegram token stored only in `monitor_config.json` (local file)
- `GET /api/config` returns `token_configured: boolean` — never the token value
- Config form clears the password field after save
- No external dependencies beyond `express` and `better-sqlite3`
- No authentication layer by default — add nginx basic auth for public VPS

---

## Future AI Hook

Schema columns already exist. No migration needed to add AI:

```javascript
// In routes/monitor.js or a new /api/leads/:id/analyze endpoint:
lead.ai_summary          = await openai.summarize(lead.content);
lead.ai_score            = await openai.scoreIntent(lead.title, lead.content);
lead.ai_reply_suggestion = await openai.draftReply(lead.title, lead.subreddit);
```

---

## Troubleshooting

| Symptom                    | Fix                                                             |
|----------------------------|-----------------------------------------------------------------|
| Dashboard blank            | Check `BASE_PATH` env var matches proxy path                   |
| SSE shows "SSE" not "Live" | Check server is running; browser EventSource auto-reconnects    |
| No leads found             | Check keywords vs actual post titles; lower scoring thresholds |
| Leads repeating on restart | Check `seen_post_ids` is written to `monitor_config.json`       |
| Telegram not alerting      | Confirm score ≥ 45 (medium); verify token + chat ID in Config  |
| worker.py not found        | Ensure `node server.js` runs from `artifacts/lead-monitor/` dir |
| SQLite error on start      | Delete `lead_monitor.db` to reset (loses all stored leads)     |

---

## Stack Versions

| Component    | Version  |
|--------------|----------|
| Node.js      | ≥ 18     |
| Express      | 4.x      |
| better-sqlite3 | 9.x    |
| Python       | ≥ 3.9    |
| feedparser   | ≥ 6.0    |
| requests     | ≥ 2.31   |
