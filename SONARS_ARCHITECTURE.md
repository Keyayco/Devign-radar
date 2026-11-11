# SONARS — Architecture Baseline & Multi-Source Target Architecture
**System:** Signal Observation, Navigation, Analysis & Response System (SONARS)  
**Target Identity:** Internal Intelligence & Prospecting Engine for Devign Digital  
**Document Purpose:** Baseline Architecture Audit & Multi-Source Evolution Blueprint  
**Phase:** Phase 0 Architecture Baseline  
**Date:** November 2026  

---

## PART I: CURRENT ARCHITECTURE BASELINE (AS-BUILT)

### 1. High-Level Architecture Overview

The existing Lead Radar architecture is a dual-process system comprising a lightweight Node.js/Express web application and a dedicated Python 3 monitoring worker. Communication between the two runtimes occurs via standard I/O (stdio) pipes, with SQLite providing local persistent storage.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL SOURCES                              │
│                                                                        │
│   Reddit RSS Feeds (XML)             Telegram Bot API (HTTPS POST)     │
└──────────────┬─────────────────────────────────────▲───────────────────┘
               │ HTTP GET (ETag/304)                 │ alerts_sent
               ▼                                     │ (medium/high)
┌────────────────────────────────────────────────────┴───────────────────┐
│                    PYTHON WORKER (worker.py)                           │
│                                                                        │
│  • fetch_feed(): feedparser + _etag_cache                              │
│  • normalize_url(): Canonical permalink generator                     │
│  • Deduplication: in-memory seen_ids set                               │
│  • Keyword Filter: Substring scan against configured keywords          │
│  • Scoring: score_post() [Intent 0-100] + compute_lead_value() [0-100] │
│  • emit(): Formats and flushes JSON lines to stdout                   │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │ stdout (Newline-delimited JSON)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   EXPRESS BACKEND (Node.js)                            │
│                                                                        │
│  • server.js: HTTP server, static file serving, API router mounting    │
│  • lib/worker-manager.js:                                              │
│      - Spawns python3 -u worker.py via child_process                   │
│      - readline stream parses stdout: {type: 'lead'|'stat'|'log'}      │
│      - Manages SSE client set & broadcasts events                      │
│      - Auto-restart crash supervisor (5s -> 60s exponential backoff)   │
│  • lib/db.js: Synchronous SQLite persistence (better-sqlite3, WAL)     │
│  • routes/monitor.js: 10 REST endpoints + SSE stream endpoint          │
└──────────────┬─────────────────────────────────────┬───────────────────┘
               │ SQLite IPC                          │ SSE + HTTP REST
               ▼                                     ▼
┌──────────────────────────────┐       ┌─────────────────────────────────┐
│  LOCAL PERSISTENCE (SQLite)  │       │     FRONTEND DASHBOARD          │
│                              │       │                                 │
│  • lead_monitor.db (WAL mode)│       │  • frontend/dashboard.html      │
│  • leads table (UNIQUE url)  │       │  • Real-time SSE event listener │
│  • scan_stats table          │       │  • Filter pills (High/Med/Low)  │
│  • outreach table (stub)     │       │  • Lead status triage selector  │
│  • monitor_config.json       │       │  • In-browser log console       │
└──────────────────────────────┘       └─────────────────────────────────┘
```

---

### 2. Component Responsibilities

| Component | Source File | Core Responsibility |
| :--- | :--- | :--- |
| **Server Entrypoint** | `server.js` | Configures Express, mounts JSON body parsing, injects `window.API_BASE` into HTML responses, serves static assets, mounts routes at `BASE + '/api'`, and binds to `0.0.0.0:PORT`. |
| **Worker Supervisor** | `lib/worker-manager.js` | Spawns `worker.py` as an unbuffered child process; reads and parses stdout/stderr lines; seeds Python with known IDs; maintains rolling log buffer (max 600 lines); broadcasts SSE events; supervises crashes with exponential back-off. |
| **Persistence Layer** | `lib/db.js` | Manages SQLite connection via `better-sqlite3`; enables WAL mode; handles idempotent schema migrations; performs atomic `INSERT OR IGNORE` queries; provides lead filtering and aggregation. |
| **REST API Router** | `routes/monitor.js` | Exposes 10 HTTP endpoints for status, logs, start/stop, config read/write, lead listing, and status updates; sanitizes sensitive Telegram credentials. |
| **Intelligence Worker** | `worker.py` | Standalone Python process; parses Reddit RSS feeds with ETag caching; normalizes permalinks; executes keyword filtering; scores intent and business value; sends Telegram alerts; emits NDJSON to stdout. |
| **Dashboard Interface** | `frontend/dashboard.html` | Vanilla HTML/CSS/JS interface; connects to `/api/stream` via `EventSource`; renders incoming leads, logs, and metrics; submits configuration changes; manages lead triage state. |

---

### 3. Detailed End-to-End Data Flow

Tracing a single lead from discovery to UI presentation:

```
[Reddit RSS Feed]
       │
       ▼
1. fetch_feed(url): Checks _etag_cache; sends If-None-Match / If-Modified-Since.
       │ If 304 -> Skip cycle. If 200 -> feed.entries extracted.
       ▼
2. normalize_url(entry.link):
       Strips query params (?utm_source, etc.), forces lowercase path, normalizes host to www.reddit.com.
       │
       ▼
3. Deduplication Check:
       If canonical in seen_ids -> increments dupes count -> skips post.
       Else -> adds canonical to seen_ids.
       │
       ▼
4. Keyword Matching:
       Extracts title and sanitized summary (strip_html, truncated to 600 chars).
       search_text = (title + " " + content).lower()
       Scans for first match in keywords array.
       │ If no match -> post dropped (seen_ids still retains canonical URL).
       ▼
5. Scoring Engines:
       score, score_detail = score_post(title, content)  // Intent score 0-100
       intent = classify_intent(score)                   // 'high' | 'medium' | 'low'
       value = compute_lead_value(title, content)        // Business value 0-100 (base 50)
       │
       ▼
6. Telegram Alert Dispatch:
       If intent in ('medium', 'high') and bot_token is set:
           requests.post("https://api.telegram.org/bot{token}/sendMessage", ...)
       │
       ▼
7. IPC Emission:
       emit({"type": "lead", "reddit_post_id": canonical, "subreddit": f"r/{sub}",
             "title": title, "content": content, "url": canonical,
             "matched_keyword": matched_kw, "score": score, "intent": intent,
             "lead_value": value, "created_utc": created_utc})
       │ Flushed to stdout as JSON string + "\n"
       ▼
8. Express Line Handler (lib/worker-manager.js:handleLine):
       readline detects newline -> JSON.parse(rawLine) -> type === 'lead'
       │
       ▼
9. SQLite Persistence (lib/db.js:insertLead):
       Executes INSERT OR IGNORE INTO leads (...) VALUES (...)
       │ If changes === 0 (race condition duplicate) -> drops lead.
       │ Else -> returns newly inserted row.
       ▼
10. SSE Event Dispatch (lib/worker-manager.js:broadcast):
       broadcast('lead', lead) iterates over connected HTTP response objects
       Writes: "event: lead\ndata: { ... }\n\n"
       │
       ▼
11. Browser Rendering (frontend/dashboard.html:es.addEventListener('lead')):
       Browser EventSource parses message -> unshifts lead into memory array
       renderLeads() updates table DOM -> updates badges and counter cards.
```

---

### 4. Database Schema & Persistence Architecture

The application uses SQLite via `better-sqlite3` in Write-Ahead Logging (`WAL`) mode with foreign key constraints enabled (`PRAGMA foreign_keys = ON;`).

```sql
-- Core leads table
CREATE TABLE IF NOT EXISTS leads (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  reddit_post_id       TEXT    UNIQUE NOT NULL,  -- Canonical permalink (Deduplication Key)
  subreddit            TEXT    NOT NULL,
  title                TEXT    NOT NULL,
  content              TEXT,
  url                  TEXT    NOT NULL,
  matched_keyword      TEXT    NOT NULL,
  score                INTEGER NOT NULL DEFAULT 0,
  intent               TEXT    NOT NULL DEFAULT 'low',
  lead_value           INTEGER NOT NULL DEFAULT 50,
  status               TEXT    NOT NULL DEFAULT 'new', -- 'new' | 'contacted' | 'ignored' | 'won'
  created_utc          INTEGER,                         -- Unix epoch of publication
  ai_summary           TEXT,                            -- Reserved stub
  ai_score             INTEGER,                         -- Reserved stub
  ai_reply_suggestion  TEXT,                            -- Reserved stub
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Reserved outreach tracking table (currently unreferenced)
CREATE TABLE IF NOT EXISTS outreach (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  message        TEXT,
  sent           INTEGER NOT NULL DEFAULT 0,
  reply_received INTEGER NOT NULL DEFAULT 0,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Scan cycle performance metrics table
CREATE TABLE IF NOT EXISTS scan_stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle         INTEGER NOT NULL,
  posts_checked INTEGER DEFAULT 0,
  matches_found INTEGER DEFAULT 0,
  dupes_skipped INTEGER DEFAULT 0,
  scan_ms       REAL    DEFAULT 0,
  alerts_sent   INTEGER DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Query optimization indexes
CREATE INDEX IF NOT EXISTS idx_leads_intent  ON leads (intent);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_score   ON leads (score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_value   ON leads (lead_value DESC);
CREATE INDEX IF NOT EXISTS idx_leads_utc     ON leads (created_utc DESC);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at DESC);
```

#### Identified Schema Discrepancies
1. **Committed DB vs Schema Code**: The physical database `lead_monitor.db` committed in the repository root lacks the `scan_stats` table and the `lead_value` and `created_utc` columns, relying on runtime `ALTER TABLE` statements inside `lib/db.js:initSchema` to patch the structure.
2. **Orphan Tables**: The committed database contains an untracked table named `config (key TEXT PRIMARY KEY, value TEXT NOT NULL)` not defined anywhere in the codebase.

---

### 5. API Interface Specification

Mounted at `BASE + '/api'` (default: `/api`):

| Method | Endpoint | Description | Request Payload | Response Structure |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/stream` | Long-lived Server-Sent Events stream. | None | SSE stream of `log`, `lead`, `stats`, and `status` events. Ping comment every 25s. |
| `GET` | `/status` | Returns worker running state and database statistics. | None | `{ running: boolean, stats: object, db: object }` |
| `GET` | `/logs` | Returns buffered logs for initial page hydration. | None | `{ lines: string[] }` (up to 600 lines) |
| `POST` | `/start` | Spawns the Python monitoring worker process. | None | `{ ok: true }` or `{ ok: false, msg: string }` |
| `POST` | `/stop` | Terminates the running Python worker (SIGTERM/SIGKILL). | None | `{ ok: true }` or `{ ok: false, msg: string }` |
| `GET` | `/config` | Retrieves safe configuration (Telegram token redacted). | None | `{ token_configured, token_from_env, chat_id_configured, chat_id_display, interval, feeds, keywords }` |
| `POST` | `/config` | Updates configuration and persists to disk. | `{ bot_token?, chat_id?, interval?, feeds?, keywords? }` | `{ ok: true }` |
| `GET` | `/leads` | Fetches filtered/sorted leads from SQLite. | Query params: `?intent=high\|medium\|low&sort=score\|value\|created_at` | `{ leads: Lead[] }` |
| `PATCH`| `/leads/:id` | Updates a lead's triage status. | `{ status: "new"\|"contacted"\|"ignored"\|"won" }` | `{ ok: true }` |
| `GET` | `/health` | Unmounted root health check for container probes. | None | `{ ok: true }` |

---

### 6. Scoring & Qualification Logic (as implemented in `worker.py`)

#### 6.1. Intent Score (`score_post`)
- Calculated additively starting from `0`.
- **Positive Signals (`HIGH_INTENT`)**: 31 phrases weighted between `+15` and `+45`.
  - Distress / Replacement Signals: `"developer disappeared"` (+45), `"replacing developer"` (+44).
  - Explicit Hiring Signals: `"hire a developer"` (+42), `"freelancer needed"` (+42), `"need a developer"` (+38).
  - Commercial / Budget Signals: `"paid project"` (+34), `"paying"` (+32), `"budget"` (+30), `"what would it cost"` (+28).
  - Urgent Need: `"urgent"` (+25), `"asap"` (+23).
- **Negative Suppressors (`LOW_INTENT`)**: 35 phrases weighted between `-14` and `-35`.
  - Feedback / Roast: `"rate my"` (-35), `"roast my"` (-35), `"what do you think"` (-32), `"feedback"` (-26).
  - Showcase / Portfolios: `"template showcase"` (-35), `"dribbble"` (-35), `"portfolio"` (-30).
  - Academic / Hobby: `"student project"` (-35), `"class project"` (-35), `"for fun"` (-28), `"hobby"` (-28).
- **Clamping**: Total score is clamped to `[0, 100]`.
- **Classification**:
  - `HIGH`: Score ≥ 70
  - `MEDIUM`: Score 45–69
  - `LOW`: Score < 45

#### 6.2. Lead Value Score (`compute_lead_value`)
- Estimates commercial deal size and ROI potential (base = 50, clamped to `[0, 100]`).
- Positive weights: `saas` (+20), `agency` (+18), `ecommerce` (+16), `shopify` (+16), `startup` (+14).
- Negative weights: `student` (-22), `for fun` (-22), `hobby` (-20), `learning` (-18).

---

### 7. Coupling & Source-Independence Assessment

The current codebase is tightly bound to Reddit in the following areas:
1. **Database Schema**: Hardcoded `reddit_post_id` as primary unique deduplication column; hardcoded `subreddit` column.
2. **Worker Implementation**: `worker.py` parses URLs assuming Reddit directory structures (`/r/.../`), generates permalinks locked to `www.reddit.com`, and sends User-Agents labeled `RedditLeadIntel/3.0`.
3. **Frontend Presentation**: Dashboard table explicitly columns "Subreddit", renders Reddit branding, and opens direct Reddit URLs.

**Decoupling Feasibility**:
The Express server, `worker-manager.js` IPC bridge, SQLite WAL engine, SSE streaming architecture, and log buffering are **already 100% source-independent**. Decoupling requires only:
- Generalizing the database deduplication column from `reddit_post_id` to `source_entity_id` and adding `source_type`.
- Abstracting `worker.py` into pluggable source adapters under a common protocol.
- Generalizing UI column labels from "Subreddit" to "Source / Channel".

---

## PART II: PROPOSED FUTURE MULTI-SOURCE ARCHITECTURE (SONARS TARGET)

### 1. Architectural Philosophy: The Intelligence Funnel

SONARS is not a generic lead scraper. It is Devign Digital's proprietary intelligence engine. Its purpose is to filter out noise and surface high-confidence commercial opportunities through a rigorous qualification funnel:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        LAYER 1: SIGNAL OBSERVATION                     │
│  Ingests raw public records, discussions, postings, and directory events│
│  [Source: Reddit RSS]      [Source: CIPC Registrations]   [Source: Niche]
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Canonical Raw Signal
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        LAYER 2: ENTITY RESOLUTION                      │
│  Resolves signals into real entities: Company, Person, Domain, or Post  │
│  Deduplicates by Registration #, Verified Domain, or Canonical URL     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Resolved Entity
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       LAYER 3: EVIDENCE & ANALYSIS                     │
│  Evaluates presence vs need vs intent:                                 │
│  • Does the business exist? (Entity verification)                      │
│  • Do they have a website? (DNS / HTTP probe)                          │
│  • What is their digital health? (Mobile-friendly, SSL, technology)     │
│  • Are they actively asking for services? (Commercial intent)          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Evidence Triad
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     LAYER 4: 3-DIMENSIONAL SCORING                     │
│                                                                        │
│   1. BUYING INTENT       2. COMMERCIAL FIT      3. EVIDENCE CONFIDENCE │
│   (Is there a budget     (Does Devign build     (Is the source data    │
│    or active search?)     what they need?)       verified and fresh?)  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Qualified Threshold Met
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      LAYER 5: RESPONSE & ACTION                        │
│                                                                        │
│   [Internal SONARS Triage Queue]   ───(Manual Push)───► [Lead Forge CRM]
└────────────────────────────────────────────────────────────────────────┘
```

---

### 2. The Source Adapter Interface

To scale beyond Reddit without rewriting the monitoring core, all intelligence sources will implement the standard `SourceAdapter` specification:

```python
from abc import ABC, abstractmethod
from typing import Iterator, Optional
from dataclasses import dataclass

@dataclass
class CanonicalSignal:
    source_type: str        # 'reddit_rss' | 'cipc_company' | 'directory_scan'
    source_entity_id: str   # Globally unique within source (e.g. CIPC reg number or Reddit permalink)
    entity_name: str        # Company name, individual name, or poster handle
    title: str              # Headline or business registration name
    content: str            # Raw post text, company object summary, or registration data
    url: Optional[str]      # Web URL if applicable
    published_utc: int      # Timestamp of event
    raw_payload: dict       # Preserved full source object for auditability

class SourceAdapter(ABC):
    @abstractmethod
    def get_source_type(self) -> str:
        """Returns unique identifier for this source adapter."""
        pass

    @abstractmethod
    def poll(self) -> Iterator[CanonicalSignal]:
        """Polls source and yields normalized CanonicalSignal instances."""
        pass

    @abstractmethod
    def health_check(self) -> bool:
        """Verifies network access, API quotas, and credential validity."""
        pass
```

---

### 3. Devign-Specific Intelligence Classification

SONARS enforces strict semantic separation between mere business existence and a commercial sales opportunity:

```
[Level 0: Registered Entity]
  │  Entity exists legally (e.g. newly registered company in CIPC).
  │  CRITICAL RULE: A registered company is NOT automatically a sales lead!
  ▼
[Level 1: Infrastructure Audit]
  │  Automated DNS / web check:
  │  - No domain exists, or
  │  - Domain registered but park page / no website, or
  │  - Obsolete website (non-responsive, insecure, broken).
  ▼
[Level 2: Commercial Need Identification]
  │  Business is in an industry Devign serves (Professional Services, E-commerce, B2B SaaS)
  │  and exhibits commercial viability indicators.
  ▼
[Level 3: Active Buying Intent]
  │  Direct evidence of commercial RFP, replacement of vanished developer,
  │  allocated budget, or urgent timeline.
  ▼
[Level 4: High-Probability Prospect]
  │  High scores across all three dimensions; ready for Devign outreach.
```

---

### 4. Tri-Dimensional Scoring Framework

Rather than collapsing all signals into a single generic number, SONARS separates intelligence into three orthogonal scores:

#### Dimension 1: Buying Intent Score (0–100)
- **Measures**: Is someone actively trying to spend money or hire right now?
- **High Signals**: "budget approved", "developer disappeared", "hiring immediately", "quote needed".
- **Zero Signals**: Routine business registration without active post; educational inquiry.
- **Negative Signals**: "rate my site", "student project", "free help".

#### Dimension 2: Devign Commercial Fit Score (0–100)
- **Measures**: Does this opportunity match Devign Digital’s service capabilities and deal criteria?
- **High Signals**: E-commerce, custom web applications, Shopify/WooCommerce, high-ticket service industries, established businesses modernizing digital presence.
- **Low Signals**: Low-budget requests ("need a site for $50"), unsupported stacks, non-commercial hobbies.

#### Dimension 3: Evidence Confidence Score (0–100)
- **Measures**: How reliable, fresh, and verifiable is the underlying data?
- **High Confidence**: Verified government registry record with active status and identifiable directors; direct verified poster with company URL.
- **Low Confidence**: Anonymous Reddit account; third-party scraped snippet; unverified domain contact.

Every score will be fully explainable by storing an audit record:
```json
{
  "intent_score": 75,
  "intent_factors": ["+45 developer disappeared", "+30 budget stated"],
  "fit_score": 85,
  "fit_factors": ["+20 ecommerce", "+15 premium branding fit"],
  "confidence_score": 60,
  "confidence_factors": ["+80 direct user post", "-20 anonymous handle"]
}
```

---

### 5. Lead Forge CRM Integration Boundary

To protect Devign Lead Forge from low-quality spam or unqualified noise:
1. **Strict Gatekeeping**: Only leads with `intent >= 65`, `fit >= 70`, and `confidence >= 60` can be recommended for Lead Forge transfer.
2. **Explicit Operator Approval**: Transfer is never automatic. A single-click operator action (`[Push to Lead Forge]`) in the SONARS dashboard initiates export.
3. **Cross-System Deduplication**: Deduplication occurs against Lead Forge via domain name, email address, or business registration number before submission.
4. **Enriched Prospect Dossier**: When transferred, SONARS provides the complete evidence package: original source context, timestamp, scoring breakdown, and initial outreach angle.
