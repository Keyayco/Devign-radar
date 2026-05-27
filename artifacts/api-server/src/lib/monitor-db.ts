/**
 * monitor-db.ts
 * ─────────────
 * SQLite persistence layer for the Reddit Lead Intelligence Platform.
 * Uses better-sqlite3 (synchronous API) — safe to call from any route handler.
 *
 * Database file: <workspace-root>/lead_monitor.db
 *
 * Tables
 * ──────
 *  leads    — one row per unique Reddit post that matched a keyword
 *  outreach — messages sent to leads (future use)
 *  config   — key/value store for persistent config (fallback)
 *
 * AI-readiness: leads table includes ai_summary, ai_score, ai_reply_suggestion
 * columns. They are NULL until a future AI step populates them.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Lead {
  id: number;
  reddit_post_id: string;
  subreddit: string;
  title: string;
  content: string | null;
  url: string;
  matched_keyword: string;
  score: number;
  intent: "high" | "medium" | "low";
  status: "new" | "contacted" | "ignored" | "won";
  ai_summary: string | null;
  ai_score: number | null;
  ai_reply_suggestion: string | null;
  created_at: string;
}

export interface LeadInput {
  reddit_post_id: string;
  subreddit: string;
  title: string;
  content?: string;
  url: string;
  matched_keyword: string;
  score: number;
  intent: string;
}

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

// __dirname = artifacts/api-server/dist/ at runtime (set by esbuild banner)
const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");
const DB_PATH = path.join(WORKSPACE_ROOT, "lead_monitor.db");

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");   // concurrent reads without blocking writes
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  return _db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    -- ── leads ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS leads (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      reddit_post_id       TEXT    UNIQUE NOT NULL,
      subreddit            TEXT    NOT NULL,
      title                TEXT    NOT NULL,
      content              TEXT,
      url                  TEXT    NOT NULL,
      matched_keyword      TEXT    NOT NULL,
      score                INTEGER DEFAULT 0,
      intent               TEXT    NOT NULL DEFAULT 'low',
      status               TEXT    NOT NULL DEFAULT 'new',
      -- AI-ready columns (NULL until AI step populates them)
      ai_summary           TEXT,
      ai_score             INTEGER,
      ai_reply_suggestion  TEXT,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── outreach ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS outreach (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      message         TEXT,
      sent            INTEGER NOT NULL DEFAULT 0,
      reply_received  INTEGER NOT NULL DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── config ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ── indexes ────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_leads_intent    ON leads (intent);
    CREATE INDEX IF NOT EXISTS idx_leads_status    ON leads (status);
    CREATE INDEX IF NOT EXISTS idx_leads_score     ON leads (score DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_created   ON leads (created_at DESC);
  `);
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/**
 * Insert a new lead. Uses INSERT OR IGNORE so duplicates are silently skipped.
 * Returns true if the row was actually inserted (not a duplicate).
 */
export function insertLead(input: LeadInput): Lead | null {
  const stmt = db().prepare(`
    INSERT OR IGNORE INTO leads
      (reddit_post_id, subreddit, title, content, url, matched_keyword, score, intent)
    VALUES
      (@reddit_post_id, @subreddit, @title, @content, @url,
       @matched_keyword, @score, @intent)
  `);

  const result = stmt.run({
    reddit_post_id: input.reddit_post_id,
    subreddit:      input.subreddit,
    title:          input.title,
    content:        input.content ?? null,
    url:            input.url,
    matched_keyword: input.matched_keyword,
    score:          input.score,
    intent:         input.intent,
  });

  if (result.changes === 0) return null; // was a duplicate
  return getLeadById(Number(result.lastInsertRowid));
}

export function getLeadById(id: number): Lead | null {
  return (db().prepare("SELECT * FROM leads WHERE id = ?").get(id) as Lead) ?? null;
}

/**
 * Return leads ordered by score DESC, newest first within same score.
 * Optionally filter by intent level.
 */
export function getLeads(intent?: string, limit = 200): Lead[] {
  if (intent && ["high", "medium", "low"].includes(intent)) {
    return db()
      .prepare(
        "SELECT * FROM leads WHERE intent = ? ORDER BY score DESC, created_at DESC LIMIT ?"
      )
      .all(intent, limit) as Lead[];
  }
  return db()
    .prepare("SELECT * FROM leads ORDER BY score DESC, created_at DESC LIMIT ?")
    .all(limit) as Lead[];
}

export function updateLeadStatus(id: number, status: string): void {
  db().prepare("UPDATE leads SET status = ? WHERE id = ?").run(status, id);
}

/** All reddit_post_ids in the DB — used to seed Python's seen_ids on restart. */
export function getSeenIds(): string[] {
  const rows = db()
    .prepare("SELECT reddit_post_id FROM leads")
    .all() as { reddit_post_id: string }[];
  return rows.map((r) => r.reddit_post_id);
}

export function countLeads(intent?: string): number {
  if (intent && ["high", "medium", "low"].includes(intent)) {
    const row = db()
      .prepare("SELECT COUNT(*) as n FROM leads WHERE intent = ?")
      .get(intent) as { n: number };
    return row.n;
  }
  const row = db().prepare("SELECT COUNT(*) as n FROM leads").get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Config key/value store
// ---------------------------------------------------------------------------

export function dbSetConfig(key: string, value: string): void {
  db()
    .prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)")
    .run(key, value);
}

export function dbGetConfig(key: string): string | null {
  const row = db()
    .prepare("SELECT value FROM leads WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
