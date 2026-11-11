# SONARS — Migration & Evolution Plan (Phase 1–5)
**System:** Signal Observation, Navigation, Analysis & Response System (SONARS)  
**Target Identity:** Internal Intelligence & Prospecting Engine for Devign Digital  
**Document Purpose:** Phased Roadmap for Transforming Lead Radar into SONARS  
**Phase:** Phase 0 Architecture Baseline  
**Date:** November 2026  

---

## 1. Guiding Migration Principles

1. **Zero Downtime & Zero Regression**: The existing Reddit RSS monitoring pipeline must continue operating without interruption throughout all migration phases.
2. **Preserve What Works**:
   - Do not replace the Node.js/Express server or Python worker with complex distributed queues or microservices.
   - Retain the synchronous, zero-dependency `better-sqlite3` storage engine with Write-Ahead Logging (`WAL`).
   - Retain the vanilla HTML, CSS, and JavaScript frontend constraint.
   - Retain the efficient SSE streaming mechanism for live UI updates.
3. **No AI Dependency for Baseline Operations**: Keyword matching, RSS parsing, entity resolution, and scoring must remain fast, deterministic, and cost-free. AI should only ever be applied downstream as an optional analysis assistant for deep dossier summarization.
4. **Data Continuity**: Existing leads and triage history in `lead_monitor.db` must be safely preserved via backward-compatible SQLite migrations.

---

## 2. Migration Stages & Phased Roadmap

```
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 0: REPOSITORY HYGIENE & BASELINE STABILIZATION                  │
│  • Clean up duplicate artifact folders                                 │
│  • Re-link frontend/dashboard.html to app.js and styles.css            │
│  • Reconcile root package.json dependencies                            │
│  • Remove plaintext credentials from git history                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 1: DATA MODEL GENERALIZATION & ADAPTER ABSTRACTION              │
│  • Migrate SQLite schema: reddit_post_id -> source_entity_id           │
│  • Add source_type and source_evidence columns                         │
│  • Refactor worker.py into modular SourceAdapter architecture          │
│  • Extract RedditScanner into adapters/reddit_adapter.py               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 2: TRI-DIMENSIONAL SCORING ENGINE                               │
│  • Split single score into: Intent, Devign Fit, Evidence Confidence    │
│  • Store explainable scoring breakdown JSON                            │
│  • Update dashboard UI to visualize all three score dimensions         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 3: SECONDARY SOURCE INTEGRATION (CIPC ADAPTER)                  │
│  • Implement lawful CIPC Business Discovery Adapter                    │
│  • Implement Level 1 Infrastructure Probe (DNS & Website check)        │
│  • Enforce Entity Resolution: Business != Qualified Sales Lead         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 4: DEVIGN LEAD FORGE INTEGRATION BRIDGE                         │
│  • Design Lead Forge export webhook/API bridge                         │
│  • Qualification gate: Intent >= 65, Fit >= 70, Confidence >= 60       │
│  • Prevent duplicate CRM submissions with cross-system ID checks       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  STAGE 5: MOBILE-FIRST DASHBOARD MODERNIZATION                         │
│  • Rebrand dashboard from "Reddit Lead Intel" to "SONARS"              │
│  • Source filtering (All / Reddit / CIPC / Direct)                     │
│  • Prospect Dossier drawer showing full evidence trail                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Stage Breakdown

### Stage 0: Repository Hygiene & Baseline Stabilization
- **Objectives**:
  - Eliminate the dangerous code drift between the root directory and `artifacts/lead-monitor/`.
  - Fix the `frontend/dashboard.html` discrepancy by extracting the inline styles and scripts into `frontend/styles.css` and `frontend/app.js` and linking them properly.
  - Fix root `package.json` so that running `npm install` installs `express` and `better-sqlite3` directly, making root self-sufficient.
  - Revoke and rotate the exposed Telegram bot token in `main.py`, and remove hardcoded secrets.
  - Remove dead scaffolding from the repository: `artifacts/mockup-sandbox`, `lib/api-spec`, `lib/api-zod`, `lib/api-client-react`, and `lib/db/`.
- **Dependencies**: None.
- **Risks**: Modifying `dashboard.html` could introduce UI regressions if assets are referenced incorrectly behind reverse proxies.
- **Mitigation**: Preserve `window.API_BASE` path injection logic in `server.js`.

---

### Stage 1: Data Model Generalization & Source Adapter Abstraction
- **Objectives**:
  - Migrate SQLite table `leads` to support arbitrary intelligence sources:
    ```sql
    -- Safe migration preserving existing records:
    ALTER TABLE leads ADD COLUMN source_type TEXT NOT NULL DEFAULT 'reddit';
    ALTER TABLE leads ADD COLUMN source_entity_id TEXT;
    ALTER TABLE leads ADD COLUMN entity_name TEXT;
    ALTER TABLE leads ADD COLUMN raw_evidence TEXT;

    -- Backfill existing Reddit records
    UPDATE leads SET source_entity_id = reddit_post_id WHERE source_entity_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_source_entity ON leads (source_type, source_entity_id);
    ```
  - Refactor `worker.py` into a lightweight runner that loads adapters from `adapters/`.
  - Encapsulate Reddit logic in `adapters/reddit_adapter.py`, implementing the `SourceAdapter` base class without altering keyword dictionaries or weights.
  - Update `lib/worker-manager.js` and `lib/db.js` to accept `source_type` and `source_entity_id`.
- **Dependencies**: Stage 0.
- **Risks**: Duplicate leads could be inserted during migration if indices conflict.
- **Mitigation**: Run migration within an atomic SQLite transaction and backfill `source_entity_id` before enforcing unique constraints.

---

### Stage 2: Tri-Dimensional Scoring Engine
- **Objectives**:
  - Replace the monolithic intent score with the tri-dimensional evaluation model:
    1. `intent_score` (0–100): Direct commercial urgency / active buying intent.
    2. `fit_score` (0–100): Devign Digital target client alignment (e-commerce, SaaS, agency, high-ticket services).
    3. `confidence_score` (0–100): Reliability and verifiability of the signal source.
  - Compute and persist `score_breakdown` (JSON) to guarantee 100% explainable scoring.
  - Keep legacy `score` column populated with `intent_score` for backwards compatibility with existing UI filters.
- **Dependencies**: Stage 1.
- **Risks**: Scoring changes might silence Telegram alerts if thresholds are not calibrated.
- **Mitigation**: Maintain legacy threshold compatibility (`intent_score >= 45` triggers alert).

---

### Stage 3: Secondary Source Integration (CIPC Business Discovery)
- **Objectives**:
  - Implement `adapters/cipc_adapter.py` for lawful discovery of new South African company registrations.
  - Implement automated digital presence verification (Level 1 Infrastructure Probe):
    - Check DNS registration for company domain name variations.
    - Probe HTTP/HTTPS response to detect parking pages vs active websites.
  - **Apply Devign Anti-Assumption Rule**: New company registrations are labeled `intent_score = 10` unless specific digital service needs or commercial signals are detected.
  - Flag newly registered businesses without websites as *High Fit / Low Intent* prospecting candidates.
- **Dependencies**: Stage 1, Stage 2.
- **Risks**: Rate limits, network timeouts, or intermittent connectivity to external registries.
- **Mitigation**: Implement exponential back-off, persistent request caching, and independent adapter fault isolation (a CIPC failure must never stall Reddit polling).

---

### Stage 4: Devign Lead Forge Integration Bridge
- **Objectives**:
  - Implement a dedicated export endpoint: `POST /api/leads/:id/export-leadforge`.
  - Enforce strict qualification gates:
    - `intent_score >= 65` OR (`fit_score >= 75` AND `website_detected == false`).
    - `confidence_score >= 60`.
  - Prevent duplicate submissions via Lead Forge lookup by domain or business registration number.
  - Maintain an export log in SQLite tracking timestamp, operator, and Lead Forge response ID.
- **Dependencies**: Stage 2, Stage 3.
- **Risks**: Accidental bulk transfer of unvetted, low-quality prospects polluting the CRM.
- **Mitigation**: Require explicit manual operator review in the UI; ban automatic batch exports.

---

### Stage 5: Mobile-First Dashboard Modernization
- **Objectives**:
  - Rebrand interface to **SONARS** (Devign Digital Signal Observation, Navigation, Analysis & Response System).
  - Add source channel filtering (Tabs: `All Signals`, `Reddit Leads`, `CIPC Discoveries`).
  - Add Prospect Dossier side-panel / modal displaying:
    - Full verbatim source evidence.
    - Tri-dimensional score breakdown with positive and negative signal chips.
    - One-click copy for outreach angles.
    - `[Export to Lead Forge]` action button with confirmation state.
  - Ensure 100% responsive layout optimized for mobile screens (responsive tables with card view fallback on screens < 768px).
- **Dependencies**: Stages 1–4.
- **Risks**: Visual clutter and bloated bundle size.
- **Mitigation**: Strictly vanilla JavaScript and CSS; zero client-side frameworks; lightweight DOM rendering.

---

## 4. Testing & Verification Requirements

To ensure zero regressions throughout the migration, the following test suites must be created:

1. **Unit Tests (Python - `pytest`)**:
   - `test_reddit_normalizer.py`: Verify permalink normalization, query string stripping, and path canonicalization.
   - `test_scoring_engine.py`: Test additive intent score calculations, clamp limits (`0-100`), negative signal deductions, and business value computations against 50 fixture posts.
   - `test_deduplication.py`: Test `seen_ids` in-memory filtering and cross-cycle persistence.
2. **Integration Tests (Node.js - `node:test` or `mocha`)**:
   - `test_db_migration.js`: Verify that older SQLite database files upgrade cleanly without data loss.
   - `test_worker_ipc.js`: Spawn a mock Python worker emitting synthetic NDJSON lines; verify Express parses logs, inserts leads into SQLite, and broadcasts SSE messages accurately.
   - `test_api_endpoints.js`: Verify all 10 REST endpoints return expected JSON structures and properly redact sensitive tokens.
3. **End-to-End Verification**:
   - Simulated 1-hour run with synthetic RSS feeds to confirm zero memory leaks, reliable SSE reconnection, and proper crash restart recovery.

---

## 5. Unchangeable Core Components (Do Not Refactor)

The following components represent proven, working technology choices and must remain untouched:
1. **Node.js Express + Python Subprocess Architecture**: Avoid rewriting the worker into TypeScript or replacing the Express server with complex microservices. The stdio pipe model is fast, reliable, and easily supervised.
2. **Synchronous `better-sqlite3` Engine**: Do not migrate to asynchronous ORMs (Prisma, TypeORM) or external database servers (PostgreSQL/MySQL) for local single-node deployments. SQLite with WAL mode is exceptionally fast and simple to maintain.
3. **Vanilla Frontend Discipline**: No React, Vue, Svelte, or front-end build pipelines for the dashboard. Vanilla HTML, CSS, and JS guarantees instant page loads, zero build steps, and zero bundler maintenance.
4. **Existing Reddit Heuristic Weights**: Preserve the existing `HIGH_INTENT` and `LOW_INTENT` keyword tables and weights. They represent domain-tested signals that must not be disrupted.
