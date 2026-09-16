/**
 * digest-utils.js — Shared rule-based parsing utilities for TeamsPulse.
 *
 * Used by both build-digest.js (CLI) and server.js (API) so logic stays DRY.
 * Pure functions only — no file I/O, no DB access.
 */

"use strict";

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

// Month names that are also ordinary English words. A bare "<month> <number>"
// match on one of these is far more likely to be prose ("we may 5 students")
// than a date, so it needs corroboration — an ordinal suffix, a comma or a year.
const AMBIGUOUS_MONTHS = new Set(["may", "march", "august"]);

const pad = (n) => String(n).padStart(2, "0");

/**
 * Does this Y/M/D triple describe a real calendar day?
 * Round-trips through Date so that 31 February is rejected rather than
 * silently rolled forward to 3 March.
 */
function isRealDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const dt = new Date(year, month - 1, day);
  return dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day;
}

function formatDate(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Extract the first date mentioned in `text`.
 *
 * Supports, in priority order:
 *   - DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY (falls back to MM/DD/YYYY when
 *     day-first is impossible, so US-formatted dates still parse)
 *   - "26th August", "26 August 2026"
 *   - "August 29, 2026", "Aug 21"
 *
 * A year written in the text always wins over `fallbackYear`.
 * Impossible dates (31 February, month 13) return null rather than a
 * plausible-looking string.
 *
 * @param {string|null} text
 * @param {number} fallbackYear — used only when the text gives no year
 * @returns {string|null} — "YYYY-MM-DD" or null
 */
function extractDate(text, fallbackYear) {
  if (!text) return null;

  // ── Numeric: DD.MM.YYYY (with MM/DD/YYYY rescue) ──────────────────────────
  let m = text.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/);
  if (m) {
    let day = parseInt(m[1], 10);
    let month = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);

    // Day-first is the assumed convention. If it can't be a real date but the
    // swapped reading can, the source was almost certainly MM/DD/YYYY.
    if (!isRealDate(year, month, day) && isRealDate(year, day, month)) {
      [day, month] = [month, day];
    }
    if (isRealDate(year, month, day)) return formatDate(year, month, day);
    // Real numeric-looking date that isn't a real day — don't guess further.
    return null;
  }

  // ── Day-first: "26th August", "26 August 2026" ────────────────────────────
  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[2].toLowerCase()] + 1;
    const year = m[3] ? parseInt(m[3], 10) : fallbackYear;
    if (isRealDate(year, month, day)) return formatDate(year, month, day);
  }

  // ── Month-first: "August 29, 2026", "Aug 21" ──────────────────────────────
  m = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const monthWord = m[1].toLowerCase();
    const hasOrdinal = !!m[3];
    const hasYear = !!m[4];
    const hasComma = /\d\s*,/.test(m[0]);

    // "may 5" needs a supporting signal; "aug 21" does not.
    if (!AMBIGUOUS_MONTHS.has(monthWord) || hasOrdinal || hasYear || hasComma) {
      const day = parseInt(m[2], 10);
      const month = MONTHS[monthWord] + 1;
      const year = hasYear ? parseInt(m[4], 10) : fallbackYear;
      if (isRealDate(year, month, day)) return formatDate(year, month, day);
    }
  }

  return null;
}

/** Tidy a matched time string: collapse spaces, "9.30" → "9:30", "am" → "AM". */
function normalizeTime(raw) {
  return raw
    .replace(/\s+/g, " ")
    .replace(/(\d)\.(\d{2})/g, "$1:$2")
    .replace(/\b(am|pm)\b/gi, (s) => s.toUpperCase())
    .trim();
}

/**
 * Extract the first time mention from `text` (supports ranges).
 *
 * Handles both 12-hour ("9:30 AM", "7PM–9PM") and 24-hour ("14:30") clocks.
 * A bare "9:30" is only read as a time when the text has no AM/PM anywhere,
 * so it can't steal the hour off a 12-hour range the patterns above missed.
 *
 * @param {string|null} text
 * @returns {string|null} — e.g. "9:30 AM", "9:30-11:00 AM", "14:30", or null
 */
function extractTime(text) {
  if (!text) return null;

  const hasMeridiem = /\b(am|pm)\b/i.test(text);

  // Ranges like "9:30-11:00 am", "7PM-9PM", "9:30 AM – 12:30 PM"
  const meridiemRange = text.match(
    /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm)?\s*[-–—to]+\s*\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm))\b/i
  );
  if (meridiemRange) return normalizeTime(meridiemRange[0]);

  // 24-hour ranges like "14:30-16:00"
  const clockRange = text.match(
    /\b([01]?\d|2[0-3]):([0-5]\d)\s*[-–—]\s*([01]?\d|2[0-3]):([0-5]\d)\b/
  );
  if (clockRange && !hasMeridiem) return normalizeTime(clockRange[0]);

  // Single times like "9:30 AM", "7:30 pm", "11:59 PM", "9.30 am"
  const meridiemSingle = text.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm))\b/i);
  if (meridiemSingle) return normalizeTime(meridiemSingle[0]);

  // Single 24-hour time like "14:30". An hour of 13-23 is unambiguous; 00-12
  // is only a time if the text isn't using a 12-hour clock elsewhere.
  const clockSingle = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (clockSingle) {
    const hour = parseInt(clockSingle[1], 10);
    if (hour >= 13 || !hasMeridiem) return normalizeTime(clockSingle[0]);
  }

  return null;
}

/**
 * Classify a post into a human-readable category tag with emoji.
 *
 * @param {string} text — combined subject + body
 * @returns {string} — e.g. "🧪 CT/Quiz"
 */
function classify(text) {
  const t = text.toLowerCase();
  if (/\bct\b|class test|\bquiz\b/.test(t)) return "🧪 CT/Quiz";
  if (/\bfinal\b|\bexam\b|mid ?term/.test(t)) return "📝 Exam";
  if (/presentation/.test(t)) return "🎤 Presentation";
  if (/reschedul|makeup|make-up|postpon/.test(t)) return "🔄 Reschedule";
  if (/\bcancel/.test(t)) return "❌ Cancelled";
  if (/\bdue\b|deadline|\bsubmit/.test(t)) return "📌 Deadline";
  if (/\bmarks\b|\bgrade|\bresult/.test(t)) return "📊 Grades";
  return "📢 Notice";
}

/**
 * Decide whether a post is worth surfacing in the digest.
 * Announcements and bot posts always qualify; other posts need keywords or dates.
 *
 * @param {object} post
 * @returns {boolean}
 */
function isNoteworthy(post) {
  const combined = `${post.subject || ""} ${post.body || ""}`.trim();
  if (post.body === "Loading...") return false;
  if (!combined && (!post.attachments || !post.attachments.length) && (!post.urlPreviews || !post.urlPreviews.length)) {
    return false;
  }
  if (post.isAnnouncement) return true;
  if (post.isBot) return true;

  const hasDate = /\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}\b/.test(combined);
  const hasKeyword =
    /\b(ct|class test|quiz|exam|final|midterm|presentation|reschedul|makeup|postpon|cancel|due|deadline|submit|marks|grade|result)\b/i.test(
      combined
    );
  return hasDate || hasKeyword;
}

/**
 * Keep only posts within the last `hours`. Posts with an unparseable timestamp
 * are kept rather than dropped — losing a notice is worse than showing an old one.
 *
 * @param {object[]} posts
 * @param {number} hours
 * @returns {object[]}
 */
function filterRecentPosts(posts, hours = 48) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return (posts || []).filter((p) => {
    if (!p.timestampIso) return true;
    const postTime = new Date(p.timestampIso).getTime();
    if (Number.isNaN(postTime)) return true;
    return postTime >= cutoff;
  });
}

/**
 * Truncate text to `max` characters, appending "…" if trimmed.
 *
 * @param {string|null} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max = 90) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/**
 * Escape pipe characters and newlines for Markdown table cells.
 *
 * @param {string|null} text
 * @returns {string}
 */
function escapeCell(text) {
  return (text || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Shorten a raw className like "Summer_2026_CSE 312 (V1)_232_D4" to just "CSE 312".
 *
 * DISPLAY LABEL ONLY. Two sections of the same course collapse to the same
 * string, so this must never be used as a key — see server.js, which groups
 * by rawClassName and uses this purely for presentation.
 *
 * @param {string} className
 * @returns {string}
 */
function shortClassName(className) {
  // Try to extract e.g. "CSE 312" or "CSE312"
  const m = (className || "").match(/[A-Z]{2,4}\s*\d{3,4}/);
  return m ? m[0] : className;
}

/**
 * Extract a section hint like "V1" / "V2" from a raw class name, so two
 * sections of one course stay tellable apart in the UI.
 *
 * @param {string} className
 * @returns {string|null}
 */
function sectionLabel(className) {
  const m = (className || "").match(/\(([^)]+)\)/);
  return m ? m[1] : null;
}

module.exports = {
  extractDate,
  extractTime,
  classify,
  isNoteworthy,
  filterRecentPosts,
  truncate,
  escapeCell,
  shortClassName,
  sectionLabel,
  isRealDate,
};
