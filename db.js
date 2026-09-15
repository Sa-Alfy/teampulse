/**
 * db.js — TeamsPulse SQLite persistence layer
 *
 * Provides a lightweight "seen-posts" store so the digest only surfaces
 * posts that are genuinely new since the last run.
 *
 * Schema (posts table):
 *   hash         TEXT PRIMARY KEY  — sha256(className + "\0" + timestampIso + "\0" + body[:500])
 *   class_name   TEXT              — source class, for future per-class queries
 *   timestamp_iso TEXT             — ISO 8601 post timestamp (may be null)
 *   author        TEXT
 *   snippet       TEXT             — first 120 chars of body
 *   seen_at       TEXT             — ISO 8601 timestamp of when this run stored the record
 */

const Database = require("better-sqlite3");
const crypto   = require("crypto");
const path     = require("path");

// Place the DB next to this file so it's always in the project root.
const DB_PATH = path.join(__dirname, "teamspulse.db");

let _db = null;

/**
 * Lazily open (or create) the database.
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    // WAL mode: faster writes, safe concurrent readers.
    _db.pragma("journal_mode = WAL");
  }
  return _db;
}

/**
 * Create the posts table if it doesn't exist yet.
 * Safe to call on every startup — fully idempotent.
 */
function ensureSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS posts (
      hash          TEXT PRIMARY KEY,
      class_name    TEXT,
      timestamp_iso TEXT,
      author        TEXT,
      snippet       TEXT,
      seen_at       TEXT
    );
  `);
}

/**
 * Compute a stable SHA-256 fingerprint for a post.
 *
 * @param {string} className
 * @param {object} post  — shape from scrape-posts.js
 * @returns {string}     — hex digest
 */
function hashPost(className, post) {
  // Use timestampIso, fall back to timestampFull if ISO parse failed.
  const ts   = post.timestampIso || post.timestampFull || "";
  // Cap body to 500 chars so transient "Loading..." mutations don't create
  // a different hash on a retry run.
  const body = (post.body || "").slice(0, 500);
  const raw  = `${className}\0${ts}\0${body}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// Prepared statements (lazily initialised after ensureSchema).
let _stmtExists = null;
let _stmtInsert = null;

function stmtExists() {
  if (!_stmtExists) _stmtExists = getDb().prepare("SELECT 1 FROM posts WHERE hash = ?");
  return _stmtExists;
}

function stmtInsert() {
  if (!_stmtInsert) {
    _stmtInsert = getDb().prepare(`
      INSERT OR IGNORE INTO posts (hash, class_name, timestamp_iso, author, snippet, seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }
  return _stmtInsert;
}

/**
 * Check whether this post has been seen before.
 *
 * @param {string} hash — from hashPost()
 * @returns {boolean}   true = never seen → include in digest
 */
function isNew(hash) {
  return !stmtExists().get(hash);
}

/**
 * Persist a post as "seen" so future runs skip it.
 *
 * @param {string} hash
 * @param {{ className: string, post: object }} meta
 */
function markSeen(hash, { className, post }) {
  const snippet = (post.subject || post.body || "").slice(0, 120).replace(/\s+/g, " ").trim();
  stmtInsert().run(
    hash,
    className,
    post.timestampIso || post.timestampFull || null,
    post.author || null,
    snippet || null,
    new Date().toISOString()
  );
}

/**
 * Close the database connection (useful in tests / long-running processes).
 */
function close() {
  if (_db) {
    _db.close();
    _db = null;
    _stmtExists = null;
    _stmtInsert = null;
  }
}

module.exports = { ensureSchema, hashPost, isNew, markSeen, close, DB_PATH };

