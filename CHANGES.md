# Reddit Lead Intelligence Platform — Change Log

## Update: Full Platform Upgrade (Phases 1–8)

This update transforms the original single-file Reddit keyword monitor into a
production-oriented lead intelligence platform. The frontend remains 100%
standalone vanilla HTML/CSS/JS — no React, Vue, or any frontend framework.

---

### Architecture Overview

```
artifacts/lead-monitor/dashboard.html   ← Standalone vanilla HTML/CSS/JS UI
artifacts/lead-monitor/worker.py        ← Python Reddit scanner + intent scorer
artifacts/api-server/src/routes/monitor.ts      ← Express routes (10 endpoints)
artifacts/api-server/src/lib/monitor-db.ts      ← SQLite persistence layer
artifacts/api-server/src/lib/worker-manager.ts  ← Worker lifecycle + SSE
lead_monitor.db                         ← SQLite database (workspace root)
logs/monitor.log                        ← Persistent log file (workspace root)
```

---

### Phase 1 — Core Stability

**Problem:** The original Flask/threaded approach was fragile and mixed concerns.

**Changes:**
- Replaced all Flask logic with Express routes + Python subprocess only
- Python spawned as `python3 -u worker.py` (unbuffered stdout)
- Both stdout and stderr are captured and logged
- Logs are persisted to `logs/monitor.log` (append mode)
- Crash detection: if the worker exits unexpectedly while `isRunning` is true,
  it auto-restarts after a delay (5s → 10s → 20s → … → 60s max, exponential back-off)
- `intentionallyStopped` flag distinguishes crashes from clean stops
- SIGTERM sent on stop; SIGKILL follows 5 seconds later if still alive
- Config persisted to `artifacts/lead-monitor/monitor_config.json`

---

### Phase 2 — SQLite Database

**New file:** `artifacts/api-server/src/lib/monitor-db.ts`

**Package added:** `better-sqlite3` (synchronous SQLite, native build approved)

**Tables created:**

```sql
leads (
  id, reddit_post_id UNIQUE, subreddit, title, content, url,
  matched_keyword, score, intent, status,
  ai_summary, ai_score, ai_reply_suggestion,   -- AI-ready columns
  created_at
)

outreach (
  id, lead_id FK, message, sent, reply_received, created_at
)

config (key PRIMARY KEY, value)
```

- `INSERT OR IGNORE` on `reddit_post_id` prevents duplicate leads across sessions
- WAL mode enabled for concurrent reads
- Known post IDs from DB are passed to Python at startup via `monitor_config.json`
  so Python's in-session `seen_ids` set starts pre-populated — no re-alerting on restart

---

### Phase 3 — Intent Scoring

**Changes to:** `artifacts/lead-monitor/worker.py`

**High-intent phrases** (+20 to +40 points each):
`hire`, `hiring`, `freelancer needed`, `need developer`, `budget`, `quote`,
`paying`, `asap`, `urgent`, `contract`, `build my`, `need someone to`, etc.

**Low-intent phrases** (−10 to −25 points each):
`feedback`, `critique`, `showcase`, `what do you think`, `rate my`,
`roast my`, `i made`, `i built`, `side project`, `for fun`, `wip`, etc.

**Score range:** 0–100

**Intent classification:**
- `high`   → score ≥ 60
- `medium` → score ≥ 25
- `low`    → score < 25

**Telegram alerts sent only for `medium` and `high` leads.**

---

### Phase 4 — Lead Management UI

**Changes to:** `artifacts/lead-monitor/dashboard.html`

New **Leads tab** with:
- Filter pills: All | High Intent | Medium | Low
- Table columns: Score bar, Intent badge, Subreddit, Title (linked), Keyword chip, Date, Status
- Status dropdown per row: New / Contacted / Ignored / Won
- Status changes call `PATCH /api/monitor/leads/:id` immediately
- Lead count badge on the Leads tab updates in real time via SSE

Intent badge colour coding:
- High → green (`#4ade80`) on dark green background
- Medium → orange (`#fb923c`) on dark amber background
- Low → grey (`#64748b`) on dark slate background

---

### Phase 5 — Performance

**Changes to:** `artifacts/lead-monitor/worker.py`

- ETag and Last-Modified caching per feed URL (stored in `feed_etag_cache` dict)
- Requests sent with `If-None-Match` and `If-Modified-Since` headers
- HTTP 304 Not Modified responses are detected and skipped (no reprocessing)
- Custom `User-Agent: RedditLeadMonitor/2.0` header on all requests
- Python keeps an in-session `seen_ids` set (session-level dedup)
- SQLite `UNIQUE` constraint provides cross-session dedup

---

### Phase 6 — Real-Time SSE

**Replaced:** periodic `setInterval` polling

**New:** `EventSource("/api/monitor/stream")` — Server-Sent Events

Named SSE events emitted by Express to all connected clients:

| Event    | Payload                                              |
|----------|------------------------------------------------------|
| `log`    | `{ line: string }` — every Python stdout log line    |
| `lead`   | Full lead object from SQLite on successful insert    |
| `stats`  | `{ cycles, matches, alerts_sent }` after each cycle  |
| `status` | `{ running: boolean }` on start/stop/crash/restart   |

- 25-second keep-alive ping comments prevent proxy timeouts
- Client disconnection removes the response from the broadcast set automatically
- On reconnect, the client immediately receives a status + stats snapshot

---

### Phase 7 — Security

**GET `/api/monitor/config` never exposes the Telegram bot token.**

Response includes only:
```json
{
  "token_configured": true,
  "chat_id_configured": true,
  "chat_id_display": "−1001…",
  "interval": 120,
  "feeds": [...],
  "keywords": [...]
}
```

- Config form password field clears after save
- Token only flows: form input → POST body → Express → disk
- Dashboard JavaScript has zero knowledge of the secret value at any point

---

### Phase 8 — AI-Ready Architecture

No AI is implemented. The schema and lead objects are designed so a future AI
classification step can plug in without migrations:

```typescript
interface Lead {
  // ... existing fields ...
  ai_summary:           string | null;  // future: GPT summary of the post
  ai_score:             number | null;  // future: AI confidence score
  ai_reply_suggestion:  string | null;  // future: drafted outreach message
}
```

The `outreach` table (already created) supports tracking sent messages and
replies per lead, ready for a future outreach composer feature.

---

### Files Removed / Deprecated

- `artifacts/lead-monitor/monitor_app.py` — old Flask server, no longer used
  (kept in place but the "Reddit Lead Monitor" workflow that ran it is superseded
  by the Express API server workflow)

---

### API Endpoints Added

| Method | Path                      | Description                          |
|--------|---------------------------|--------------------------------------|
| GET    | `/api/monitor`            | Serve dashboard HTML                 |
| GET    | `/api/monitor/stream`     | SSE stream (logs/leads/stats/status) |
| POST   | `/api/monitor/start`      | Spawn Python worker                  |
| POST   | `/api/monitor/stop`       | Kill Python worker                   |
| GET    | `/api/monitor/status`     | Running state + session stats        |
| GET    | `/api/monitor/logs`       | Recent log buffer (page load hydration) |
| GET    | `/api/monitor/config`     | Safe config (no token)               |
| POST   | `/api/monitor/config`     | Update config                        |
| GET    | `/api/monitor/leads`      | Leads from SQLite (optional ?intent=) |
| PATCH  | `/api/monitor/leads/:id`  | Update lead status tag               |
