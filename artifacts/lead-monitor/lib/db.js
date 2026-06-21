'use strict';

/**
 * lib/db.js — SQLite persistence layer
 * ──────────────────────────────────────
 * Uses better-sqlite3 (synchronous). Safe to call from any route handler.
 * Database lives at: lead-monitor/lead_monitor.db
 *
 * Schema notes
 * ─────────────
 *  leads.reddit_post_id  — normalized permalink URL, UNIQUE dedup key
 *  leads.lead_value      — business value score 0–100 (AI-ready)
 *  leads.created_utc     — Unix timestamp of original Reddit post
 *  leads.ai_*            — reserved columns for future AI classification
 */

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'lead_monitor.db');

let _db = null;

function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');  // concurrent reads without blocking writes
  _db.pragma('foreign_keys = ON');
  initSchema();
  return _db;
}

// ── Schema setup (idempotent — safe to call on every startup) ───────────────
function initSchema() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      reddit_post_id       TEXT    UNIQUE NOT NULL,
      subreddit            TEXT    NOT NULL,
      title                TEXT    NOT NULL,
      content              TEXT,
      url                  TEXT    NOT NULL,
      matched_keyword      TEXT    NOT NULL,
      score                INTEGER NOT NULL DEFAULT 0,
      intent               TEXT    NOT NULL DEFAULT 'low',
      lead_value           INTEGER NOT NULL DEFAULT 50,
      status               TEXT    NOT NULL DEFAULT 'new',
      created_utc          INTEGER,
      ai_summary           TEXT,
      ai_score             INTEGER,
      ai_reply_suggestion  TEXT,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS outreach (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      message        TEXT,
      sent           INTEGER NOT NULL DEFAULT 0,
      reply_received INTEGER NOT NULL DEFAULT 0,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE INDEX IF NOT EXISTS idx_leads_intent  ON leads (intent);
    CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads (status);
    CREATE INDEX IF NOT EXISTS idx_leads_score   ON leads (score DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_value   ON leads (lead_value DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_utc     ON leads (created_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at DESC);
  `);

  // ── Live migrations — add columns that didn't exist in earlier versions ───
  const cols = _db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  if (!cols.includes('lead_value'))
    _db.exec('ALTER TABLE leads ADD COLUMN lead_value INTEGER NOT NULL DEFAULT 50');
  if (!cols.includes('created_utc'))
    _db.exec('ALTER TABLE leads ADD COLUMN created_utc INTEGER');
}

// ── Leads ────────────────────────────────────────────────────────────────────

/**
 * Insert a new lead.  Returns the full row or null if it was a duplicate.
 * Uses INSERT OR IGNORE so duplicate reddit_post_id is silently dropped.
 */
function insertLead(data) {
  const stmt = db().prepare(`
    INSERT OR IGNORE INTO leads
      (reddit_post_id, subreddit, title, content, url,
       matched_keyword, score, intent, lead_value, created_utc)
    VALUES
      (@reddit_post_id, @subreddit, @title, @content, @url,
       @matched_keyword, @score, @intent, @lead_value, @created_utc)
  `);

  const result = stmt.run({
    reddit_post_id: data.reddit_post_id,
    subreddit:      data.subreddit      || '',
    title:          data.title          || '',
    content:        data.content        || null,
    url:            data.url            || '',
    matched_keyword: data.matched_keyword || '',
    score:          Number(data.score      || 0),
    intent:         data.intent         || 'low',
    lead_value:     Number(data.lead_value || 50),
    created_utc:    data.created_utc    ? Number(data.created_utc) : null,
  });

  if (result.changes === 0) return null; // duplicate
  return db().prepare('SELECT * FROM leads WHERE rowid = ?').get(result.lastInsertRowid);
}

/**
 * Return leads.  Supports filtering by intent and sorting by score / value /
 * created_at (default newest first).
 */
function getLeads({ intent, sort = 'created_at', limit = 300 } = {}) {
  const ORDER = {
    score:      'score DESC, created_at DESC',
    value:      'lead_value DESC, score DESC',
    created_at: 'created_at DESC',
  };
  const order = ORDER[sort] || ORDER.created_at;

  if (intent && ['high', 'medium', 'low'].includes(intent)) {
    return db()
      .prepare(`SELECT * FROM leads WHERE intent = ? ORDER BY ${order} LIMIT ?`)
      .all(intent, limit);
  }
  return db()
    .prepare(`SELECT * FROM leads ORDER BY ${order} LIMIT ?`)
    .all(limit);
}

function updateLeadStatus(id, status) {
  db().prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
}

/** All normalized permalink URLs — used to seed Python's seen_ids at startup. */
function getSeenIds() {
  return db()
    .prepare('SELECT reddit_post_id FROM leads')
    .all()
    .map(r => r.reddit_post_id);
}

/** Aggregate stats from the DB (shown in dashboard header cards). */
function getDbStats() {
  const total    = db().prepare('SELECT COUNT(*) AS n FROM leads').get().n;
  const high     = db().prepare("SELECT COUNT(*) AS n FROM leads WHERE intent='high'").get().n;
  const medium   = db().prepare("SELECT COUNT(*) AS n FROM leads WHERE intent='medium'").get().n;
  const avgScore = db().prepare('SELECT ROUND(AVG(score),0) AS a FROM leads').get().a || 0;
  const newest   = db().prepare('SELECT created_at FROM leads ORDER BY created_at DESC LIMIT 1').get();
  const dupeRow  = db().prepare('SELECT SUM(dupes_skipped) AS d FROM scan_stats').get();
  return {
    total,
    high,
    medium,
    avg_score:    Number(avgScore),
    newest_at:    newest ? newest.created_at : null,
    total_dupes:  Number(dupeRow.d || 0),
  };
}

function recordScanStat(data) {
  db().prepare(`
    INSERT INTO scan_stats
      (cycle, posts_checked, matches_found, dupes_skipped, scan_ms, alerts_sent)
    VALUES
      (@cycle, @posts_checked, @matches_found, @dupes_skipped, @scan_ms, @alerts_sent)
  `).run(data);
}

module.exports = {
  insertLead,
  getLeads,
  updateLeadStatus,
  getSeenIds,
  getDbStats,
  recordScanStat,
};
