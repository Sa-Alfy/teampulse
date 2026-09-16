/**
 * server.js — TeamsPulse Local Express API Server
 *
 * Serves scraped data (notices.json, assignments.json, teamspulse.db) to the
 * Chrome Extension popup over HTTP on localhost:3457.
 *
 * Start with:  npm run server
 */

"use strict";

const express  = require("express");
const fs       = require("fs");
const path     = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  isNoteworthy,
  classify,
  extractDate,
  extractTime,
  truncate,
  shortClassName,
  sectionLabel,
} = require("./digest-utils");

// hashPost is imported, never reimplemented — the fingerprint tuple lives in
// exactly one place, so changing it can't leave this file computing stale
// hashes that silently mark every post as new.
const { hashPost } = require("./db");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT             = 3457;
const NOTICES_FILE     = path.join(__dirname, "notices.json");
const ASSIGNMENTS_FILE = path.join(__dirname, "assignments.json");
const DB_PATH          = path.join(__dirname, "teamspulse.db");

// A post counts as "new" for the UI badge if it was surfaced within this
// window. Defining newness by TIME rather than by absence from the table means
// the CLI digest and the extension agree: running `npm run digest` no longer
// permanently extinguishes the NEW pill.
const NEW_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 168; // 7 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open the SQLite DB read-only, or return null if it doesn't exist yet.
 *
 * NOTE: a read-only connection cannot recover a hot WAL. This works because
 * build-digest.js closes cleanly and checkpoints on exit; if a writer crashes
 * mid-run, the leftover -wal may make this open fail (we degrade to null and
 * serve empty stats rather than throwing). Deleting teamspulse.db-wal after a
 * crashed scrape is the manual recovery.
 */
function openDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    return new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    return null;
  }
}

/** Safely read + parse a JSON file from disk; returns null on any error. */
function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Clamp an hours query param into [1, MAX_WINDOW_HOURS]. */
function clampHours(raw, fallback) {
  const parsed = parseInt(raw, 10);
  const n = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(n, 1), MAX_WINDOW_HOURS);
}

/** Does the posts table exist on this connection? */
function hasPostsTable(db) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get();
  } catch {
    return false;
  }
}

/**
 * Transform a raw post into the shape the extension expects.
 *
 * @param {string} rawClassName — section-specific identity, never the short label
 * @param {object} post
 * @param {boolean} isNew
 * @returns {object}
 */
function transformPost(rawClassName, post, isNew = false) {
  const combined = `${post.subject || ""} ${post.body || ""}`.trim();
  const postYear = post.timestampIso
    ? new Date(post.timestampIso).getFullYear()
    : new Date().getFullYear();
  const date = extractDate(combined, postYear) || extractDate(post.timestampFull, postYear);
  const time = extractTime(combined);
  const tag  = classify(combined);

  // Build a rich, informative summary
  let summaryText = "";
  const sub = (post.subject || "").trim();
  const bdy = (post.body || "").trim();

  if (sub && bdy && sub.toLowerCase() !== bdy.toLowerCase()) {
    // If subject is very short or generic like "Notice:", put body first
    if (/^notice\s*:?$/i.test(sub)) {
      summaryText = bdy;
    } else {
      summaryText = `${sub} — ${bdy}`;
    }
  } else {
    summaryText = sub || bdy || "";
  }

  return {
    date:              date || null,
    time:              time || null,
    tag,
    summary:           truncate(summaryText, 140),
    subject:           post.subject || null,
    bodySnippet:       truncate(bdy, 220),
    isAnnouncement:    !!post.isAnnouncement,
    isBot:             !!post.isBot,
    isNew:             !!isNew,
    author:            post.author || "Instructor",
    originalTimestamp: post.timestamp || null,
    timestampIso:      post.timestampIso || null,
    className:         shortClassName(rawClassName),
    rawClassName,
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// CORS — allow the extension and localhost only.
//
// There is deliberately NO wildcard fallback. curl and other non-browser
// clients send no Origin header and need no CORS header at all, so echoing
// "*" would have bought them nothing while handing every website you happen
// to have open permission to read your course list.
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://") || origin.startsWith("http://localhost")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // The response body varies by Origin, so caches must key on it.
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// GET / — Friendly root status page
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>TeamsPulse API</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #18191a; color: #f0f2f5; padding: 2rem; line-height: 1.6; max-width: 600px; margin: 0 auto; }
    h1 { color: #f0f2f5; display: flex; align-items: center; gap: 8px; font-size: 24px; margin-bottom: 8px; }
    .status { display: inline-flex; align-items: center; gap: 6px; background: rgba(74, 222, 128, 0.15); color: #4ade80; border: 1px solid rgba(74, 222, 128, 0.3); padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; margin-bottom: 16px; }
    .pulse { width: 8px; height: 8px; background: #4ade80; border-radius: 50%; display: inline-block; }
    p { color: #b0b3b8; font-size: 14px; margin: 8px 0; }
    ul { list-style: none; padding: 0; margin: 16px 0; }
    li { margin: 8px 0; }
    a { color: #93c5fd; text-decoration: none; font-family: monospace; font-size: 14px; background: #242526; padding: 4px 8px; border-radius: 4px; border: 1px solid #383a3d; display: inline-block; }
    a:hover { background: #3a3b3c; }
    .note { margin-top: 24px; padding: 12px 14px; background: #242526; border-left: 3px solid #6264a7; border-radius: 0 6px 6px 0; font-size: 13px; color: #b0b3b8; }
    code { color: #50e3c2; }
  </style>
</head>
<body>
  <h1>⚡ TeamsPulse API</h1>
  <div class="status"><span class="pulse"></span> Running on port 3457</div>
  <p>The backend server is operating properly. It provides JSON data to the TeamsPulse Chrome/Edge extension.</p>

  <h3>Available Endpoints:</h3>
  <ul>
    <li><a href="/api/ping">/api/ping</a> — Health check</li>
    <li><a href="/api/status">/api/status</a> — Database status &amp; post count</li>
    <li><a href="/api/digest">/api/digest</a> — Formatted briefing data</li>
    <li><a href="/api/recent?hours=48">/api/recent?hours=48</a> — Recent posts</li>
  </ul>

  <div class="note">
    <strong>To view the UI:</strong> Load the <code>extension/</code> directory as an unpacked extension at <code>chrome://extensions</code> and click the ⚡ icon in your toolbar.
  </div>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// GET /api/ping — liveness probe used by the extension
// ---------------------------------------------------------------------------
app.get("/api/ping", (_req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/status — aggregate stats from teamspulse.db
// ---------------------------------------------------------------------------
app.get("/api/status", (_req, res) => {
  let lastScrape = null;
  try {
    if (fs.existsSync(NOTICES_FILE)) {
      lastScrape = fs.statSync(NOTICES_FILE).mtime.toISOString();
    }
  } catch { /* ignore */ }

  const emptyStatus = () => ({
    ok: true,
    totalSeen: 0,
    totalRecorded: 0,
    lastRun: null,
    lastScrape,
    serverTime: new Date().toISOString(),
  });

  const db = openDb();
  if (!db) return res.json(emptyStatus());

  try {
    if (!hasPostsTable(db)) {
      db.close();
      return res.json(emptyStatus());
    }
    const { surfaced, recorded } = db
      .prepare("SELECT SUM(surfaced) AS surfaced, COUNT(*) AS recorded FROM posts")
      .get();
    const { lastRun } = db.prepare("SELECT MAX(seen_at) AS lastRun FROM posts WHERE surfaced = 1").get();
    db.close();
    res.json({
      ok: true,
      totalSeen: surfaced || 0,
      totalRecorded: recorded || 0,
      lastRun: lastRun || null,
      lastScrape,
      serverTime: new Date().toISOString(),
    });
  } catch {
    db.close();
    res.json(emptyStatus());
  }
});

// ---------------------------------------------------------------------------
// GET /api/digest — digest data for the popup's main view
//
// Everything is grouped by RAW class name. Two sections of one course
// ("CSE 312 (V1)" and "CSE 312 (V2)") are two separate teams with separate
// announcements; collapsing them by short name silently dropped one section's
// notices entirely. The short name is a display label and nothing else.
// ---------------------------------------------------------------------------
app.get("/api/digest", (req, res) => {
  const notices     = readJson(NOTICES_FILE);
  const assignments = readJson(ASSIGNMENTS_FILE);

  if (!notices && !assignments) {
    return res.json({
      generatedAt:  new Date().toISOString(),
      newPostCount: 0,
      skippedCount: 0,
      classes:      [],
      noDataYet:    true,
    });
  }

  const newWindowHours = clampHours(req.query.newHours, NEW_WINDOW_HOURS);
  const newCutoffIso = new Date(Date.now() - newWindowHours * 3600e3).toISOString();

  const db = openDb();
  let stmtSeenAt = null;

  if (db && hasPostsTable(db)) {
    try {
      stmtSeenAt = db.prepare("SELECT seen_at FROM posts WHERE hash = ? AND surfaced = 1");
    } catch { /* ignore */ }
  }

  /**
   * "New" means surfaced recently, not absent from the table. Both seen_at and
   * the cutoff are JS ISO strings, so the comparison is like-for-like.
   */
  function isPostNew(rawClassName, post) {
    if (!stmtSeenAt) return true; // no DB yet — nothing has been seen
    try {
      const row = stmtSeenAt.get(hashPost(rawClassName, post));
      if (!row) return true;                 // never surfaced
      return (row.seen_at || "") > newCutoffIso;
    } catch {
      return true;
    }
  }

  // ── Index assignments by raw class name ───────────────────────────────────
  const assignmentsByRaw = {};
  for (const entry of (assignments || [])) {
    const raw = entry.className;
    if (!assignmentsByRaw[raw]) assignmentsByRaw[raw] = [];
    for (const a of (entry.assignments || [])) {
      if (a.tab === "Upcoming" || a.tab === "Past due") {
        assignmentsByRaw[raw].push({
          ...a,
          className: shortClassName(raw),
          rawClassName: raw,
        });
      }
    }
  }

  // ── Index notices by raw class name ───────────────────────────────────────
  const noticesByRaw = {};
  for (const classEntry of (notices || [])) {
    noticesByRaw[classEntry.className] = classEntry;
  }

  const allRawNames = new Set([
    ...Object.keys(noticesByRaw),
    ...Object.keys(assignmentsByRaw),
  ]);

  // A short name shared by more than one raw name needs its section shown, or
  // the popup presents two different teams under one indistinguishable label.
  const shortNameCounts = {};
  for (const raw of allRawNames) {
    const short = shortClassName(raw);
    shortNameCounts[short] = (shortNameCounts[short] || 0) + 1;
  }

  let totalNoteworthy = 0;
  let newPostCount    = 0;
  let skippedCount    = 0;

  const classes = [];
  for (const raw of Array.from(allRawNames).sort()) {
    const classEntry = noticesByRaw[raw];
    const transformedNotices = [];

    if (classEntry && classEntry.posts) {
      for (const post of classEntry.posts) {
        if (!isNoteworthy(post)) continue;
        totalNoteworthy++;
        const isNew = isPostNew(raw, post);
        if (isNew) newPostCount++;
        else skippedCount++;
        transformedNotices.push(transformPost(raw, post, isNew));
      }
    }

    const classAssignments = assignmentsByRaw[raw] || [];

    // Skip empty classes that have neither notices nor assignments
    if (transformedNotices.length === 0 && classAssignments.length === 0) continue;

    const short = shortClassName(raw);
    const section = sectionLabel(raw);
    const displayName = shortNameCounts[short] > 1 && section ? `${short} (${section})` : short;

    classes.push({
      key:              raw,          // stable identity for filtering
      className:        short,        // course code, for grouping/labels
      displayName,                    // what the popup should print
      section:          section || null,
      rawClassName:     raw,
      noticesCount:     transformedNotices.length,
      assignmentsCount: classAssignments.length,
      notices:          transformedNotices,
      assignments:      classAssignments,
    });
  }

  if (db) db.close();

  res.json({
    generatedAt: new Date().toISOString(),
    newWindowHours,
    totalNoteworthy,
    newPostCount,
    skippedCount,
    classes,
  });
});

// ---------------------------------------------------------------------------
// GET /api/recent?hours=48 — posts from teamspulse.db within N hours
// ---------------------------------------------------------------------------
app.get("/api/recent", (req, res) => {
  const hours = clampHours(req.query.hours, 48);
  const db = openDb();
  if (!db) return res.json({ posts: [], hours });

  try {
    if (!hasPostsTable(db)) {
      db.close();
      return res.json({ posts: [], hours });
    }

    // The cutoff is built in JS so both sides of the comparison are ISO-8601.
    // SQLite's datetime('now', ...) renders "YYYY-MM-DD HH:MM:SS" — a space
    // where seen_at has a "T" — and string-comparing the two diverges at
    // character 11, letting through everything from the cutoff's whole day.
    const cutoff = new Date(Date.now() - hours * 3600e3).toISOString();

    const rows = db
      .prepare(
        `SELECT class_name, author, snippet, timestamp_iso, seen_at
         FROM posts
         WHERE surfaced = 1 AND seen_at > ?
         ORDER BY seen_at DESC`
      )
      .all(cutoff);

    db.close();

    const posts = rows.map((r) => ({
      className:    shortClassName(r.class_name || ""),
      rawClassName: r.class_name || null,
      author:       r.author,
      snippet:      r.snippet,
      timestampIso: r.timestamp_iso,
      seenAt:       r.seen_at,
      tag:          classify(r.snippet || ""),
    }));

    res.json({ posts, hours, cutoff });
  } catch {
    db.close();
    res.json({ posts: [], hours });
  }
});

// ---------------------------------------------------------------------------
// Errors — clients expect JSON, so don't hand them Express's HTML 500 page.
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.use((err, _req, res, _next) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, "127.0.0.1");

// Announce success from the 'listening' event, not from listen()'s callback —
// so a failed bind never prints "running on ..." just above its own error.
server.on("listening", () => {
  console.log(`⚡ TeamsPulse API server running on http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop.`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use — is the server already running?`);
    console.error(`   Check http://localhost:${PORT}/api/ping, or stop the other process.`);
  } else if (err.code === "EACCES") {
    console.error(`❌ Not allowed to bind port ${PORT}.`);
  } else {
    console.error("❌ Server failed to start:", err);
  }
  process.exitCode = 1;
});

module.exports = app;
