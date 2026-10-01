/**
 * extension/core/shape.js — Browser-safe data shaping for the popup.
 *
 * Ports the shaping logic from server.js without any Node-only APIs.
 * buildDigest() and buildStatus() return the same top-level shapes as
 * GET /api/digest and GET /api/status so the popup works identically
 * against either the server or the standalone extension.
 *
 * Popup contract (from popup.js):
 *   rawStatusData: { lastScrape, lastRun, totalSeen }
 *   rawDigestData: { newPostCount, classes[] }
 *     class: { key, className, displayName, rawClassName,
 *               noticesCount, assignmentsCount, notices[], assignments[] }
 *     notice: { tag, summary, subject, author, originalTimestamp,
 *                timestampIso, date, time, isNew, isAnnouncement, isBot,
 *                bodySnippet, className, rawClassName }
 *     assignment: { title, details, tab, dueDate, dueTime, dueIso,
 *                    className, rawClassName }
 *
 * Dual export: CJS in Node, globalThis.TP in browser.
 */

"use strict";

// ---------------------------------------------------------------------------
// Constants (mirrored from server.js)
// ---------------------------------------------------------------------------

const NEW_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 168; // 7 days
const STALE_THRESHOLD_HOURS = 36;

// ---------------------------------------------------------------------------
// Dependency: digest-utils functions.
// In Node: loaded via require. In browser: already on globalThis.TP.
// ---------------------------------------------------------------------------

function _getUtils() {
  if (typeof module !== "undefined" && module.exports) {
    return require("./digest-utils");
  }
  return globalThis.TP;
}

// ---------------------------------------------------------------------------
// Ported helpers (exact logic from server.js)
// ---------------------------------------------------------------------------

/** Clamp hours to [1, MAX_WINDOW_HOURS]. */
function clampHours(raw, fallback) {
  const parsed = parseInt(raw, 10);
  const n = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(n, 1), MAX_WINDOW_HOURS);
}

/** "stale" if lastScrape missing or older than 36 h from nowMs. */
function computeHealth(lastScrape, nowMs) {
  if (!lastScrape) return "stale";
  const scrapeMs = new Date(lastScrape).getTime();
  if (Number.isNaN(scrapeMs) || Number.isNaN(nowMs)) return "stale";
  return (nowMs - scrapeMs) > STALE_THRESHOLD_HOURS * 3600e3 ? "stale" : "ok";
}

/**
 * Transform a raw post into the shape popup.js expects.
 * Port of server.js transformPost (lines 114-155).
 */
function transformPost(rawClassName, post, isNew) {
  const { extractDate, extractTime, classify, truncate, shortClassName } = _getUtils();

  const combined = `${post.subject || ""} ${post.body || ""}`.trim();
  const postYear = post.timestampIso
    ? new Date(post.timestampIso).getFullYear()
    : new Date().getFullYear();
  const date = extractDate(combined, postYear) || extractDate(post.timestampFull, postYear);
  const time = extractTime(combined);
  const tag  = classify(combined);

  let summaryText = "";
  const sub = (post.subject || "").trim();
  const bdy = (post.body    || "").trim();

  if (sub && bdy && sub.toLowerCase() !== bdy.toLowerCase()) {
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

/**
 * Transform a raw assignment into the shape popup.js expects.
 * Port of server.js transformAssignment (lines 166-206).
 */
function transformAssignment(rawClassName, a) {
  const { extractDate, extractTime, shortClassName } = _getUtils();

  const currentYear = new Date().getFullYear();
  const textToScan = `${a.dueDate || ""} ${a.dueRaw || ""} ${a.details || ""}`.trim();
  const parsedDate = (a.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(a.dueDate))
    ? a.dueDate
    : extractDate(textToScan, currentYear);
  const parsedTime = extractTime(textToScan);

  let dueIso = null;
  if (parsedDate) {
    if (parsedTime) {
      const singleTime = parsedTime.includes("-")
        ? parsedTime.split(/[-–—]/).pop().trim()
        : parsedTime;
      const parsed = Date.parse(`${parsedDate} ${singleTime}`);
      if (!isNaN(parsed)) dueIso = new Date(parsed).toISOString();
    }
    if (!dueIso) {
      const parsed = Date.parse(`${parsedDate} 23:59:59`);
      if (!isNaN(parsed)) {
        dueIso = new Date(parsed).toISOString();
      } else {
        const fallback = Date.parse(parsedDate);
        if (!isNaN(fallback)) dueIso = new Date(fallback).toISOString();
      }
    }
  }

  return {
    ...a,
    dueDate: parsedDate || a.dueDate || null,
    dueTime: parsedTime || null,
    dueIso,
    className: shortClassName(rawClassName),
    rawClassName,
  };
}

/**
 * Sort comparator: ascending by due date, undated last.
 * Port of server.js compareAssignments (lines 212-228).
 */
function compareAssignments(a, b) {
  const dateA = a.dueIso || a.dueDate;
  const dateB = b.dueIso || b.dueDate;

  if (!dateA && !dateB) return 0;
  if (!dateA) return 1;
  if (!dateB) return -1;

  const timeA = new Date(dateA).getTime();
  const timeB = new Date(dateB).getTime();

  if (isNaN(timeA) && isNaN(timeB)) return 0;
  if (isNaN(timeA)) return 1;
  if (isNaN(timeB)) return -1;

  return timeA - timeB;
}

// ---------------------------------------------------------------------------
// buildDigest
// ---------------------------------------------------------------------------

/**
 * Build the /api/digest-equivalent response from store state.
 *
 * @param {object} state          — from store.getFullState(classNames)
 *   state.seenHashes             — { [hash]: { seenAt, surfaced } }
 *   state.classes                — { [rawClassName]: { posts, assignments, lastSync } }
 * @param {object} opts
 *   opts.newHours {number}       — window for "new" badge (default NEW_WINDOW_HOURS)
 *   opts.nowMs    {number}       — Date.now() for tests; defaults to real time
 * @returns {object} — same top-level shape as GET /api/digest
 */
function buildDigest(state, { newHours, nowMs } = {}) {
  const { isNoteworthy, shortClassName, sectionLabel } = _getUtils();

  const resolvedNewHours = clampHours(newHours, NEW_WINDOW_HOURS);
  const resolvedNowMs    = (typeof nowMs === "number") ? nowMs : Date.now();
  const newCutoffIso     = new Date(resolvedNowMs - resolvedNewHours * 3600e3).toISOString();

  if (!state || !state.classes || Object.keys(state.classes).length === 0) {
    return {
      generatedAt:    new Date(resolvedNowMs).toISOString(),
      newWindowHours: resolvedNewHours,
      newPostCount:   0,
      totalNoteworthy: 0,
      skippedCount:   0,
      classes:        [],
      noDataYet:      true,
    };
  }

  const seenHashes = state.seenHashes || {};

  function isPostNew(hash) {
    const entry = seenHashes[hash];
    if (!entry || !entry.surfaced) return true; // never surfaced
    return (entry.seenAt || "") > newCutoffIso;
  }

  let newPostCount    = 0;
  let totalNoteworthy = 0;
  let skippedCount    = 0;

  // Collect short-name counts for section disambiguation
  const allRawNames     = Object.keys(state.classes).sort();
  const shortNameCounts = {};
  for (const raw of allRawNames) {
    const short = shortClassName(raw);
    shortNameCounts[short] = (shortNameCounts[short] || 0) + 1;
  }

  const classes = [];

  for (const raw of allRawNames) {
    const classData = state.classes[raw];
    const postsMap  = classData.posts       || {};
    const rawAssign = classData.assignments || [];

    // Build notices (only surfaced posts, applying isNoteworthy)
    const transformedNotices = [];
    for (const [hash, entry] of Object.entries(postsMap)) {
      if (!entry.surfaced) continue;           // filtered-out; skip
      const post = entry.post;
      if (!isNoteworthy(post)) continue;       // re-check (classifier may have changed)
      totalNoteworthy++;
      const postIsNew = isPostNew(hash);
      if (postIsNew) newPostCount++; else skippedCount++;
      transformedNotices.push(transformPost(raw, post, postIsNew));
    }

    // Build assignments (Upcoming + Past due only, matching server.js logic)
    const classAssignments = rawAssign
      .filter((a) => a.tab === "Upcoming" || a.tab === "Past due")
      .map((a) => transformAssignment(raw, a))
      .sort(compareAssignments);

    if (transformedNotices.length === 0 && classAssignments.length === 0) continue;

    const short       = shortClassName(raw);
    const section     = sectionLabel(raw);
    const displayName = shortNameCounts[short] > 1 && section ? `${short} (${section})` : short;

    classes.push({
      key:              raw,
      className:        short,
      displayName,
      section:          section || null,
      rawClassName:     raw,
      noticesCount:     transformedNotices.length,
      assignmentsCount: classAssignments.length,
      notices:          transformedNotices,
      assignments:      classAssignments,
    });
  }

  return {
    generatedAt:    new Date(resolvedNowMs).toISOString(),
    newWindowHours: resolvedNewHours,
    newPostCount,
    totalNoteworthy,
    skippedCount,
    classes,
  };
}

// ---------------------------------------------------------------------------
// buildStatus
// ---------------------------------------------------------------------------

/**
 * Build the /api/status-equivalent response from store state.
 *
 * @param {object} state   — from store.getFullState(classNames)
 * @param {number} nowMs   — Date.now() or test time
 * @returns {object}       — same top-level shape as GET /api/status
 */
/**
 * Scraper problems reported by content scripts (extension only; the server
 * has no equivalent). A problem is current only while no successful capture
 * happened after it: page-level ("no-class") is cleared by any newer
 * last-sync, a class's "no-messages" by that class's newer last-sync.
 *
 * @returns {{ kind: string, className: string|null, at: string }[]}
 */
function scraperIssues(state) {
  const health  = (state && state.scrapeHealth) || {};
  const classes = (state && state.classes) || {};
  const issues  = [];

  let latestSync = null;
  for (const c of Object.values(classes)) {
    if (c.lastSync && (!latestSync || c.lastSync > latestSync)) latestSync = c.lastSync;
  }

  if (health.global && health.global.at && (!latestSync || health.global.at > latestSync)) {
    issues.push({ kind: health.global.status, className: null, at: health.global.at });
  }
  for (const [cn, entry] of Object.entries(health.classes || {})) {
    const lastSync = classes[cn] && classes[cn].lastSync;
    if (entry && entry.at && (!lastSync || entry.at > lastSync)) {
      issues.push({ kind: entry.status, className: cn, at: entry.at });
    }
  }
  return issues;
}

function buildStatus(state, nowMs) {
  const resolvedNowMs = (typeof nowMs === "number") ? nowMs : Date.now();
  const serverTime    = new Date(resolvedNowMs).toISOString();
  const issues        = scraperIssues(state);
  const scraper       = issues.length > 0 ? "suspect" : "ok";

  if (!state || !state.classes || Object.keys(state.classes).length === 0) {
    return {
      ok:            true,
      health:        "stale",
      totalSeen:     0,
      totalRecorded: 0,
      lastRun:       null,
      lastScrape:    null,
      serverTime,
      noDataYet:     true,
      scraper,
      scraperIssues: issues,
    };
  }

  // lastScrape = latest lastSync across all classes
  let lastScrape = null;
  for (const classData of Object.values(state.classes)) {
    if (classData.lastSync && (!lastScrape || classData.lastSync > lastScrape)) {
      lastScrape = classData.lastSync;
    }
  }

  const seenHashes = state.seenHashes || {};
  let totalSeen    = 0;
  let totalRecorded = 0;
  let lastRun      = null;

  for (const entry of Object.values(seenHashes)) {
    totalRecorded++;
    if (entry.surfaced) {
      totalSeen++;
      if (!lastRun || (entry.seenAt && entry.seenAt > lastRun)) {
        lastRun = entry.seenAt || null;
      }
    }
  }

  const health = computeHealth(lastScrape, resolvedNowMs);

  return {
    ok:            true,
    health,
    totalSeen,
    totalRecorded,
    lastRun:       lastRun || null,
    lastScrape,
    serverTime,
    scraper,
    scraperIssues: issues,
  };
}

const _shape = {
  clampHours,
  computeHealth,
  transformPost,
  transformAssignment,
  compareAssignments,
  buildDigest,
  buildStatus,
  scraperIssues,
  NEW_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
  STALE_THRESHOLD_HOURS,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = _shape;
} else {
  globalThis.TP = Object.assign(globalThis.TP || {}, _shape);
}
