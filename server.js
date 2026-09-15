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
const Database = require("better-sqlite3");

const { isNoteworthy, classify, extractDate, extractTime, truncate, shortClassName } = require("./digest-utils");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT           = 3457;
const NOTICES_FILE   = path.join(__dirname, "notices.json");
const ASSIGNMENTS_FILE = path.join(__dirname, "assignments.json");
const DB_PATH        = path.join(__dirname, "teamspulse.db");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the SQLite DB, or return null if it doesn't exist yet. */
function openDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
    return db;
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

/**
 * Transform a raw post into the shape the extension expects.
 *
 * @param {string} rawClassName
 * @param {object} post
 * @returns {object}
 */
/**
 * Transform a raw post into the shape the extension expects.
 *
 * @param {string} rawClassName
 * @param {object} post
 * @param {boolean} isNew
 * @returns {object}
 */
function transformPost(rawClassName, post, isNew = false) {
  const combined   = `${post.subject || ""} ${post.body || ""}`.trim();
  const postYear   = post.timestampIso
    ? new Date(post.timestampIso).getFullYear()
    : new Date().getFullYear();
  const date       = extractDate(combined, postYear) || extractDate(post.timestampFull, postYear);
  const time       = extractTime(combined);
  const tag        = classify(combined);

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

  const summary = truncate(summaryText, 140);

  return {
    date:              date || null,
    time:              time || null,
    tag,
    summary,
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

// CORS — allow Chrome extension origins and localhost
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://") || origin.startsWith("http://localhost")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // Still allow requests with no Origin header (curl, etc.)
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
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
    <li><a href="/api/status">/api/status</a> — Database status & post count</li>
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
  const db = openDb();
  let lastScrape = null;
  try {
    if (fs.existsSync(NOTICES_FILE)) {
      lastScrape = fs.statSync(NOTICES_FILE).mtime.toISOString();
    }
  } catch { /* ignore */ }

  if (!db) {
    return res.json({ ok: true, totalSeen: 0, lastRun: null, lastScrape, serverTime: new Date().toISOString() });
  }

  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get();
    if (!tableExists) {
      db.close();
      return res.json({ ok: true, totalSeen: 0, lastRun: null, lastScrape, serverTime: new Date().toISOString() });
    }
    const { total } = db.prepare("SELECT COUNT(*) AS total FROM posts").get();
    const { lastRun } = db.prepare("SELECT MAX(seen_at) AS lastRun FROM posts").get();
    db.close();
    res.json({
      ok: true,
      totalSeen: total || 0,
      lastRun: lastRun || null,
      lastScrape,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    db.close();
    res.json({ ok: true, totalSeen: 0, lastRun: null, lastScrape, serverTime: new Date().toISOString() });
  }
});

// ---------------------------------------------------------------------------
// GET /api/digest — digest data for the popup's main view
// ---------------------------------------------------------------------------
app.get("/api/digest", (req, res) => {
  const notices     = readJson(NOTICES_FILE);
  const assignments = readJson(ASSIGNMENTS_FILE);

  if (!notices && !assignments) {
    return res.json({
      generatedAt:   new Date().toISOString(),
      newPostCount:  0,
      skippedCount:  0,
      classes:       [],
      noDataYet:     true,
    });
  }

  const db = openDb();
  let hasPostsTable = false;
  let stmtExists = null;

  if (db) {
    try {
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get();
      if (tableCheck) {
        hasPostsTable = true;
        stmtExists = db.prepare("SELECT 1 FROM posts WHERE hash = ?");
      }
    } catch { /* ignore */ }
  }

  const crypto = require("crypto");
  function hashPost(className, post) {
    const ts   = post.timestampIso || post.timestampFull || "";
    const body = (post.body || "").slice(0, 500);
    const raw  = `${className}\0${ts}\0${body}`;
    return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  }

  function isPostNew(className, post) {
    if (!hasPostsTable || !stmtExists) return true;
    try {
      const hash = hashPost(className, post);
      const row = stmtExists.get(hash);
      return !row; // new if not found in db
    } catch {
      return true;
    }
  }

  let totalNoteworthy = 0;
  let newPostCount    = 0;
  let skippedCount    = 0;

  // Build per-class assignments indexed by normalized short class name
  const assignmentsByClass = {};
  for (const entry of (assignments || [])) {
    const key = shortClassName(entry.className);
    if (!assignmentsByClass[key]) assignmentsByClass[key] = [];

    for (const a of (entry.assignments || [])) {
      if (a.tab === "Upcoming" || a.tab === "Past due") {
        assignmentsByClass[key].push({
          ...a,
          className: key,
          rawClassName: entry.className,
        });
      }
    }
  }

  // Collect all unique class names across notices and assignments
  const allClassesSet = new Set();
  const noticesByClass = {};
  for (const classEntry of (notices || [])) {
    const key = shortClassName(classEntry.className);
    allClassesSet.add(key);
    noticesByClass[key] = classEntry;
  }
  for (const key of Object.keys(assignmentsByClass)) {
    allClassesSet.add(key);
  }

  const classes = [];
  for (const shortName of Array.from(allClassesSet).sort()) {
    const classEntry = noticesByClass[shortName];
    const transformedNotices = [];

    if (classEntry && classEntry.posts) {
      for (const post of classEntry.posts) {
        if (!isNoteworthy(post)) continue;
        totalNoteworthy++;
        const isNew = isPostNew(classEntry.className, post);
        if (isNew) {
          newPostCount++;
        } else {
          skippedCount++;
        }
        transformedNotices.push(transformPost(classEntry.className, post, isNew));
      }
    }

    const classAssignments = assignmentsByClass[shortName] || [];

    // Skip empty classes that have neither notices nor assignments
    if (transformedNotices.length === 0 && classAssignments.length === 0) continue;

    classes.push({
      className:        shortName,
      rawClassName:     classEntry ? classEntry.className : shortName,
      noticesCount:     transformedNotices.length,
      assignmentsCount: classAssignments.length,
      notices:          transformedNotices,
      assignments:      classAssignments,
    });
  }

  if (db) db.close();

  res.json({
    generatedAt:     new Date().toISOString(),
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
  const hours = Math.min(parseInt(req.query.hours, 10) || 48, 168); // cap at 7 days
  const db = openDb();
  if (!db) {
    return res.json({ posts: [] });
  }

  try {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get();
    if (!tableCheck) {
      db.close();
      return res.json({ posts: [] });
    }

    const rows = db
      .prepare(
        `SELECT class_name, author, snippet, timestamp_iso, seen_at
         FROM posts
         WHERE seen_at > datetime('now', ? )
         ORDER BY seen_at DESC`
      )
      .all(`-${hours} hours`);

    db.close();

    const posts = rows.map((r) => ({
      className:    shortClassName(r.class_name || ""),
      author:       r.author,
      snippet:      r.snippet,
      timestampIso: r.timestamp_iso,
      seenAt:       r.seen_at,
      tag:          classify(r.snippet || ""),
    }));

    res.json({ posts });
  } catch (err) {
    db.close();
    res.json({ posts: [] });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "127.0.0.1", () => {
  console.log(`⚡ TeamsPulse API server running on http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop.`);
});

