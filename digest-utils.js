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

/**
 * Extract the first date mentioned in `text`.
 * Supports: DD.MM.YYYY, DD-MM-YYYY, DD/MM/YYYY, "26th August", "Aug 21"
 *
 * @param {string|null} text
 * @param {number} fallbackYear — used when only month+day are given
 * @returns {string|null} — "YYYY-MM-DD" or null
 */
function extractDate(text, fallbackYear) {
  if (!text) return null;

  // DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY
  let m = text.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/);
  if (m) {
    const day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // "26th August"
  m = text.match(/\b(\d{1,2})(st|nd|rd|th)?\s+([A-Za-z]{3,9})\b/);
  if (m && MONTHS[m[3].toLowerCase()] !== undefined) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[3].toLowerCase()];
    return `${fallbackYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // "Aug 21" / "Sep 2"
  m = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})\b/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const day = parseInt(m[2], 10);
    if (day >= 1 && day <= 31) {
      const month = MONTHS[m[1].toLowerCase()];
      return `${fallbackYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return null;
}

/**
 * Extract the first time mention from `text` (supports ranges).
 *
 * @param {string|null} text
 * @returns {string|null} — e.g. "9:30 AM" or "9:30-11:00 AM" or null
 */
function extractTime(text) {
  if (!text) return null;
  // Ranges like "9:30-11:00 am", "7PM-9PM", "9:30 AM – 12:30 PM"
  const rangeMatch = text.match(
    /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm)?\s*[-–—to]+\s*\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm))\b/i
  );
  if (rangeMatch) return rangeMatch[0].replace(/\s+/g, " ").trim();

  // Single times like "9:30 AM", "7:30 pm", "11:59 PM"
  const singleMatch = text.match(
    /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm))\b/i
  );
  return singleMatch ? singleMatch[0].replace(/\s+/g, " ").trim() : null;
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
 * @param {string} className
 * @returns {string}
 */
function shortClassName(className) {
  // Try to extract e.g. "CSE 312" or "CSE312"
  const m = className.match(/[A-Z]{2,4}\s*\d{3,4}/);
  return m ? m[0] : className;
}

module.exports = { extractDate, extractTime, classify, isNoteworthy, truncate, escapeCell, shortClassName };

