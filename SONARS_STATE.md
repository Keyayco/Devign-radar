# SONARS — State of the Repository (Phase 0 Audit)
**System:** Signal Observation, Navigation, Analysis & Response System (SONARS)  
**Target Identity:** Internal Intelligence & Prospecting Engine for Devign Digital  
**Repository Source:** `https://github.com/Keyayco/Devign-radar.git`  
**Audit Date:** November 2026  
**Auditor:** Senior Software Engineer (AI Studio Build / SONARS Transition)  

---

## 1. Executive Summary

This repository represents the initial foundation of **Lead Radar** (now transitioning to **SONARS**). The current application is a single-source Reddit lead monitor consisting of:
1. A **Node.js/Express** backend running synchronously with SQLite (`better-sqlite3`).
2. A **Python 3** subprocess (`worker.py`) that periodically polls Reddit RSS feeds via `feedparser`, runs regex/substring keyword matching, computes additive intent scores, and alerts via Telegram.
3. A **real-time browser dashboard** driven by Server-Sent Events (SSE).

**Phase 0 Decision Updates:**
- **Security Remediation (Completed):** Hardcoded credentials in `main.py` have been purged and replaced with environment variable lookups. The leaked bot token has been flagged for rotation via `@BotFather`.
- **Frontend Alignment (Completed):** Root `frontend/dashboard.html` has been reconciled to load external `frontend/styles.css` and `frontend/app.js` as authoritative sources. The dead-code anomaly has been resolved while strictly preserving the vanilla JS/CSS constraint and visual design.
- **Repository Consolidation (On Hold):** A full duplication audit between the root and `artifacts/` directories has been completed, identifying active deployment references and candidate scaffolding for removal upon approval.
- **CIPC Access Strategy (Investigated):** Official CIPC APIVerse Hub (`developer.cipc.co.za`), POPIA compliance, and statutory extract costs have been evaluated to establish a compliant, lawful business discovery architecture.

---

## 2. Inventory of Existing Functionality

### 2.1. Verified Working Features
- **Reddit RSS Feed Polling (`worker.py:fetch_feed`)**:
  - Successfully parses RSS feeds from configured subreddits using `feedparser`.
  - Implements HTTP ETag and `If-Modified-Since` request caching via an in-memory dictionary `_etag_cache`, skipping re-processing on HTTP `304 Not Modified`.
  - Extracts title, sanitized summary (`strip_html`), and UTC publication timestamps (`extract_utc`).
- **Keyword Filtering (`worker.py:scan_feed`)**:
  - Scans combined title and summary text against a configured keyword list (`keywords`).
  - Matches the first triggering keyword using case-insensitive substring search.
- **Additive Intent & Value Scoring (`worker.py:score_post`, `compute_lead_value`)**:
  - Computes an Intent Score (0–100) using positive weights from `HIGH_INTENT` (+15 to +45) and heavy negative penalties from `LOW_INTENT` (-14 to -35).
  - Classifies intent into three categorical tiers (`classify_intent`): `high` (≥70), `medium` (45–69), and `low` (<45).
  - Computes a separate `lead_value` (0–100, base 50) using business ROI keywords in `LEAD_VALUE`.
- **Inter-Process Communication (`lib/worker-manager.js:spawnWorker`, `handleLine`)**:
  - Node.js spawns Python with unbuffered stdout (`python3 -u worker.py`).
  - Python emits newline-delimited JSON objects (`emit()`).
  - Express parses stdout line-by-line via `readline`, inserting new leads into SQLite and broadcasting them to SSE clients in real time.
- **Deduplication Engine (`worker.py:normalize_url`, `lib/db.js:insertLead`)**:
  - Python normalizes Reddit permalinks (strips query parameters, lowercases path, normalizes host to `www.reddit.com`).
  - In-memory `seen_ids` set in Python skips known URLs immediately without database or scoring overhead.
  - SQLite `UNIQUE` constraint on `reddit_post_id` paired with `INSERT OR IGNORE` provides atomic, race-condition-safe persistence.
- **Telegram Alerting (`worker.py:send_telegram`)**:
  - Dispatches immediate markdown alerts via Telegram Bot API (`/sendMessage`) for `medium` and `high` intent leads when configured.
- **Server-Sent Events (SSE) Streaming (`lib/worker-manager.js:addSSEClient`, `broadcast`)**:
  - Real-time event broadcasting to connected browsers across four event types: `log`, `lead`, `stats`, and `status`.
  - Includes a 25-second `: ping` comment loop to prevent proxy and browser timeout disconnections.
- **Lead Status Management (`routes/monitor.js:PATCH /api/leads/:id`, `lib/db.js:updateLeadStatus`)**:
  - Persists manual user triage tags across four states: `new`, `contacted`, `ignored`, and `won`.
- **Config Management & Safe Exposure (`routes/monitor.js:loadConfig`, `GET /api/config`)**:
  - Redacts sensitive Telegram bot tokens (returns `token_configured: boolean`, never the raw token).
  - Masks chat IDs (`chat_id_display: 12345…`).
  - Merges environment variables (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) with file-backed storage (`monitor_config.json`).

---

### 2.2. Partially Implemented Features
- **Scan Statistics Recording (`lib/db.js:recordScanStat`, `lib/worker-manager.js:handleLine`)**:
  - The SQLite table `scan_stats` and the function `recordScanStat()` are fully implemented in `lib/db.js`.
  - However, `worker-manager.js` only invokes `recordScanStat` if `parsed.cycle_detail` is present:
    ```javascript
    if (parsed.cycle_detail) db.recordScanStat(parsed.cycle_detail);
    ```
  - `worker.py` only emits `{ cycles, matches, alerts_sent, dupes, scan_ms }` and **never** emits `cycle_detail`. Consequently, cycle-level historical metrics are never written to the database.
- **Worker Crash Back-Off Reset (`lib/worker-manager.js:spawnWorker`)**:
  - Worker crash recovery doubles the restart delay (`5s -> 10s -> 20s -> 40s -> 60s max`).
  - However, there is no success timer to reset `restartDelay` back to `5000ms` after a prolonged period of stable operation. A worker running cleanly for 24 hours that encounters a single transient failure will still incur the maximum accumulated penalty.
- **Seen IDs Seeding via Config File (`lib/worker-manager.js:startWorker`, `routes/monitor.js:loadConfig`)**:
  - On worker start, `startWorker()` retrieves all `reddit_post_id` entries from SQLite and writes them into `monitor_config.json` under `seen_post_ids`.
  - While this successfully seeds Python's in-memory `seen_ids`, it turns `monitor_config.json` from a configuration file into an ever-growing data store, causing unnecessary disk I/O and memory bloat on every config read.

---

### 2.3. Broken, Unreliable, or Conflicting Implementation
- **Frontend Code Drift & Decoupling Failure (`frontend/dashboard.html` vs `frontend/app.js` & `frontend/styles.css`)**:
  - **The README claims:** `dashboard.html` is "Pure HTML (no inline CSS/JS)" backed by `styles.css` and `app.js`.
  - **The actual reality:** `frontend/dashboard.html` is a **734-line monolithic file** containing an inline `<style>` block (lines 6–348) and an inline `<script>` block (lines 350–734).
  - `frontend/dashboard.html` **never links `styles.css`** and **never imports `app.js`**.
  - Any improvements made to `frontend/app.js` (such as the null guard in commit `0d32bd5` or `aea003a`) **are completely bypassed** at runtime because the server serves `frontend/dashboard.html` with its embedded inline script!
- **Database Schema Divergence (`lead_monitor.db` in repo root)**:
  - The pre-existing SQLite database file checked into the root of the repository (`lead_monitor.db`) was generated from an earlier schema iteration:
    - It is **missing the `scan_stats` table** entirely (`sqlite3.OperationalError: no such table: scan_stats`).
    - The `leads` table in this pre-existing DB is missing the `lead_value` and `created_utc` columns (handled via dynamic `ALTER TABLE` in `lib/db.js:initSchema`).
    - It contains an unreferenced legacy table named `config` (`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).
- **Synchronous Telegram Blocking (`worker.py:scan_feed`, `send_telegram`)**:
  - Telegram alert dispatch is executed synchronously within the RSS feed scanning loop with a `timeout=10` parameter. A network freeze or Telegram API latency directly stalls the feed polling cycle.
- **Absence of HTTP 429 & Rate Limit Handling (`worker.py:fetch_feed`)**:
  - Reddit RSS endpoints aggressively rate-limit non-browser User-Agents. If Reddit responds with `429 Too Many Requests`, `feedparser` returns an empty feed without raising an exception. The worker logs `r/subreddit — 0 posts` without detecting rate limiting or triggering backoff.

---

### 2.4. Documented but Not Implemented
- **Outreach Tracking (`lib/db.js:outreach`)**:
  - The `outreach` table (`id`, `lead_id`, `message`, `sent`, `reply_received`, `created_at`) is created in SQLite and documented in `README.md` and `CHANGES.md`.
  - **Zero application code interacts with this table.** There are no API endpoints, worker functions, or UI elements for composing, dispatching, or tracking outreach messages.
- **AI Classification Columns (`lib/db.js:leads`)**:
  - The `leads` table includes `ai_summary`, `ai_score`, and `ai_reply_suggestion`.
  - Neither the backend nor the worker contains any logic to populate or utilize these columns. They are static placeholders.
- **Clean Architecture Claims**:
  - `README.md` states: *"Clean separation — no inline CSS, no inline JS."* As verified in section 2.3, the root dashboard is 100% inline.

---

### 2.5. Implemented but Undocumented
- **Environment Variable Precedence for Credentials (`routes/monitor.js:loadConfig`)**:
  - The API checks `process.env.TELEGRAM_BOT_TOKEN` and `process.env.TELEGRAM_CHAT_ID` ahead of `monitor_config.json`.
  - The UI visually differentiates whether the token is configured via environment variables or file storage (`token_from_env`).
- **Dashboard Fallback Polling (`frontend/dashboard.html:startMonitor`)**:
  - An inline timer fires fallback HTTP GET requests to `/status` at 1500ms and 4000ms after clicking "Start Monitor" to verify worker state if SSE delivery is delayed.
- **Database `config` Table**:
  - A table named `config` exists inside the committed SQLite database, but is not defined in `initSchema()`.

---

### 2.6. Duplicated or Unnecessarily Complicated Code
- **Repository Duplication (Root vs `artifacts/lead-monitor`)**:
  - The entire application exists **twice** in the repository:
    1. Root level: `server.js`, `worker.py`, `frontend/`, `routes/`, `lib/`, `requirements.txt`.
    2. Artifact level: `artifacts/lead-monitor/` containing duplicate copies of the same files.
  - The `.replit` workflow configuration targets `artifacts/lead-monitor/server.js`, whereas `Dockerfile` copies `artifacts/lead-monitor/package.json` but runs root `server.js`.
- **Parallel Unused Backend Scaffold (`artifacts/api-server`)**:
  - An entire TypeScript/Express/Pino/Drizzle API server exists in `artifacts/api-server`, referencing an empty Drizzle schema in `lib/db/src/schema/index.ts` and an OpenAPI spec with only `/healthz` in `lib/api-spec/openapi.yaml`.
- **Unused UI Sandbox (`artifacts/mockup-sandbox`)**:
  - A Vite + React + Tailwind + Radix/shadcn component sandbox exists in `artifacts/mockup-sandbox`, totally disconnected from the lead monitoring system.
- **Multiple Divergent Dashboards**:
  1. `frontend/dashboard.html` (734 lines, all inline CSS and JS).
  2. `artifacts/lead-monitor/frontend/dashboard.html` (194 lines, imports external CSS and JS).
  3. `artifacts/lead-monitor/dashboard.html` (719 lines, legacy monolithic file).
  4. `artifacts/lead-monitor/static/index.html` (legacy Flask static template).
- **Abandoned Legacy Entrypoints**:
  - `main.py` in the root directory: The original single-file CLI prototype.
  - `artifacts/lead-monitor/monitor_app.py`: A legacy Flask web app with background Python threads.

---

## 3. Dependencies & Runtime Environment

### 3.1. Node.js & NPM
- **Root `package.json`**:
  - Declares a `pnpm-workspace` root with `private: true`.
  - Dependencies: **Empty**.
  - DevDependencies: `prettier: ^3.8.3`, `typescript: ~5.9.3`.
  - **Issue:** Running `npm install` in the repository root does not install runtime dependencies needed by `server.js`.
- **`artifacts/lead-monitor/package.json`**:
  - Dependencies: `better-sqlite3: ^12.10.0`, `express: ^5.2.1` (or 4.x in production lockfile).
  - Node engine requirement: `>=18.0.0`.

### 3.2. Python Runtime
- **Requirements (`requirements.txt`)**:
  - `feedparser>=6.0.10`
  - `requests>=2.31.0`
- **Standard Library Modules Utilized**:
  - `calendar`, `json`, `os`, `re`, `sys`, `time`, `urllib.parse`.
- **Python Version**: Python 3.9+ required; tested with Python 3.10.

---

## 4. Deployment Status

| Platform / Method | Configuration File | Implementation Status | Issues / Constraints |
| :--- | :--- | :--- | :--- |
| **Docker (Production)** | `Dockerfile` | **Functional** (with quirks) | Copies `artifacts/lead-monitor/package.json` to install dependencies, then copies root files and executes `node server.js`. Persists SQLite to `/data/lead_monitor.db`. |
| **Docker (Alternate)** | `.dockerfile` | **Broken** | Copies root `package.json` (which has no runtime dependencies) and runs `npm install --omit=dev`. Will fail at runtime due to missing `express` and `better-sqlite3`. |
| **Replit** | `.replit` | **Operational** | Executes `BASE_PATH=/monitor PORT=3001 node artifacts/lead-monitor/server.js`. |
| **Railway** | `artifacts/lead-monitor/railway.toml` | **Configured** | Expects single-service deployment from `artifacts/lead-monitor/` folder. |
| **Render** | Documented in `DEPLOY.md` | **Documentation only** | No deployment configuration file checked in. |

---

## 5. Outstanding Technical & Security Risks

1. **CRITICAL: Plaintext Credentials in Repository History**:
   - `main.py` contains hardcoded, active Telegram bot tokens and user chat IDs in plaintext. Even if not run in production, this poses an immediate credential exposure risk across the git history.
2. **Security: Unauthenticated API Endpoints**:
   - The Express API (`/api/*`) and dashboard have no authentication or access control layer. Anyone with network access can stop the worker, alter keywords/feeds, or change lead statuses.
3. **Data Loss / Concurrency Risk with SQLite WAL**:
   - In containerized deployments (Docker/Railway), the SQLite database is written to local disk. Unless mapped to an external persistent volume, all stored leads and triage statuses are erased on every container rebuild or redeploy.
4. **Memory & I/O Overhead from Monolithic Config**:
   - Storing all deduplication keys inside `monitor_config.json` causes unbounded file growth as lead volume scales.
5. **No Automated Testing**:
   - Zero test coverage. Any refactoring to scoring, deduplication, or parsing risks silent regressions.
6. **Hardcoded Platform Coupling**:
   - The data model, regex patterns, URL normalization, and user interface are inextricably tied to Reddit RSS structures.
