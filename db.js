/**
 * db.js — TeamsPulse SQLite persistence layer
 *
 * Provides a lightweight "seen-posts" store so the digest only surfaces
 * posts that are genuinely new since the last run.
 *
 * Schema (posts table):
 *   hash          TEXT PRIMARY KEY  — see hashPost() for the exact tuple
 *   class_name    TEXT              — RAW class name (never the shortened label)
 *   timestamp_iso TEXT              — ISO 8601 post timestamp (may be null)
 *   author        TEXT
 *   subject       TEXT              — subject line, if the post had one
 *   snippet       TEXT              — first 120 chars of subject/body
 *   seen_at       TEXT              — ISO 8601 time this post was first SURFACED
 *   surfaced      INTEGER           — 0 = scraped only, 1 = shown in a digest
 *
 * `surfaced` is the important one: "stored" and "shown" are different facts.
 * A post that failed the noteworthiness filter is recorded (so we can audit
 * what was scraped) but is NOT considered seen — so loosening the classifier
 * later can still surface it. Only surfaced=1 rows suppress a post.
 */

"use strict";

const { DatabaseSync } = require("node:sqlite");
const crypto   = require("crypto");
const path     = require("path");

// Place the DB next to this file so it's always in the project root.
const DB_PATH = path.join(__dirname, "teamspulse.db");

// Bump this whenever the hashPost() tuple or the table shape changes.
// Old rows are keyed by a hash that can no longer be recomputed, so they are
// dropped rather than kept — re-showing a post is recoverable, hiding one is not.
const SCHEMA_VERSION = 2;

let _db = null;

/**
 * Lazily open (or create) the database.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function getDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    // WAL mode: faster writes, safe concurrent readers.
    _db.exec("PRAGMA journal_mode = WAL;");
  }
  return _db;
}

/**
 * Create the posts table if it doesn't exist yet, migrating away from any
 * older schema version first. Safe to call on every startup.
 */
function ensureSchema() {
  const db = getDb();

  const row = db.prepare("PRAGMA user_version").get();
  const version = row ? Number(Object.values(row)[0]) : 0;

  if (version < SCHEMA_VERSION) {
    // The v1 hash tuple omitted subject and author, so its hashes are not
    // comparable with the ones we compute now. Keeping the rows would silently
    // suppress nothing and confuse nothing — but it would also inflate
    // totalSeen with rows that can never match. Drop and start clean.
    db.exec("DROP TABLE IF EXISTS posts;");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      hash          TEXT PRIMARY KEY,
      class_name    TEXT,
      timestamp_iso TEXT,
      author        TEXT,
      subject       TEXT,
      snippet       TEXT,
      seen_at       TEXT,
      surfaced      INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_posts_seen_at ON posts (seen_at);");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

/**
 * Compute a stable SHA-256 fingerprint for a post.
 *
 * The tuple is deliberately wide: two posts that differ in ANY field a human
 * would call distinguishing must produce different hashes, or one of them is
 * lost forever. Same class, same minute, same body but a different subject
 * line or a different author is two posts, not one.
 *
 * @param {string} className — the RAW class name (section-specific)
 * @param {object} post      — shape from scrape-posts.js
 * @returns {string}         — hex digest
 */
function hashPost(className, post) {
  // Use timestampIso, fall back to timestampFull if ISO parse failed.
  const ts      = post.timestampIso || post.timestampFull || "";
  const author  = post.author || "";
  const subject = post.subject || "";
  // Cap body to 500 chars so transient "Loading..." mutations don't create
  // a different hash on a retry run.
  const body    = (post.body || "").slice(0, 500);
  const raw     = `${className}\0${author}\0${ts}\0${subject}\0${body}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

// Prepared statements (lazily initialised after ensureSchema).
let _stmtSurfaced = null;
let _stmtInsert   = null;

function stmtSurfaced() {
  if (!_stmtSurfaced) {
    _stmtSurfaced = getDb().prepare("SELECT 1 FROM posts WHERE hash = ? AND surfaced = 1");
  }
  return _stmtSurfaced;
}

function stmtInsert() {
  if (!_stmtInsert) {
    _stmtInsert = getDb().prepare(`
      INSERT INTO posts (hash, class_name, timestamp_iso, author, subject, snippet, seen_at, surfaced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        surfaced = MAX(posts.surfaced, excluded.surfaced),
        seen_at  = CASE WHEN posts.surfaced = 0 AND excluded.surfaced = 1
                        THEN excluded.seen_at
                        ELSE posts.seen_at END
    `);
  }
  return _stmtInsert;
}

/**
 * Check whether this post has already been surfaced in a digest.
 *
 * @param {string} hash — from hashPost()
 * @returns {boolean}   true = never surfaced → include in digest
 */
function isNew(hash) {
  return !stmtSurfaced().get(hash);
}

/**
 * Record a post.
 *
 * @param {string} hash
 * @param {{ className: string, post: object, surfaced?: boolean }} meta
 *        surfaced — true when the post actually made it into the digest.
 *        Only surfaced posts count as "seen" for future runs.
 */
function markSeen(hash, { className, post, surfaced = true }) {
  const snippet = (post.subject || post.body || "").slice(0, 120).replace(/\s+/g, " ").trim();
  stmtInsert().run(
    hash,
    className,
    post.timestampIso || post.timestampFull || null,
    post.author || null,
    post.subject || null,
    snippet || null,
    new Date().toISOString(),
    surfaced ? 1 : 0
  );
}

/**
 * Close the database connection (useful in tests / long-running processes).
 */
function close() {
  if (_db) {
    _db.close();
    _db = null;
    _stmtSurfaced = null;
    _stmtInsert = null;
  }
}

module.exports = { ensureSchema, hashPost, isNew, markSeen, close, DB_PATH, SCHEMA_VERSION };
