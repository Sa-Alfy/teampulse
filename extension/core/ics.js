/**
 * extension/core/ics.js — build an iCalendar (.ics) file of assignments,
 * entirely on-device. Input is buildDigest() output (Upcoming + Past due).
 *
 * RFC 5545 essentials: CRLF line endings, TEXT escaping (\ ; , newline) so
 * scraped text can't inject properties, lines folded at 75 octets without
 * splitting UTF-8 characters, UTC DATE-TIMEs, stable UIDs so re-importing
 * updates events instead of duplicating them.
 *
 * Dual export: CJS in Node, globalThis.TP in browser.
 */

"use strict";

const ICS_EVENT_MINUTES = 30; // event block ending at the due time

function icsEscape(text) {
  return String(text == null ? "" : text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Fold a content line to ≤75 octets per physical line (RFC 5545 §3.1). */
function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function icsDateTime(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Deterministic 32-bit FNV-1a hex — UID fallback when Teams gives no GUID. */
function icsHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * @param {object} digest — buildDigest() result
 * @param {number} nowMs
 * @returns {{ ics: string, exported: number, skippedUndated: number }}
 */
function buildIcs(digest, nowMs) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TeamsPulse//Assignments//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  const stamp = icsDateTime(typeof nowMs === "number" ? nowMs : Date.now());
  let exported = 0;
  let skippedUndated = 0;

  for (const c of (digest && digest.classes) || []) {
    const label = c.displayName || c.className || c.rawClassName || "";
    for (const a of c.assignments || []) {
      const due = a.dueIso ? Date.parse(a.dueIso) : NaN;
      if (Number.isNaN(due)) { skippedUndated++; continue; }

      const key = a.assignmentId || icsHash(`${c.rawClassName || label}\u0000${a.title || ""}\u0000${a.dueIso}`);
      const details = String(a.details || "").replace(/(\d{1,2}:\d{2}\s?[AP]M)(?=[^\s·])/gi, "$1 · ");
      const desc = [a.tab, details].filter(Boolean).join(" · ");
      lines.push(
        "BEGIN:VEVENT",
        `UID:${icsEscape(key)}@teamspulse.local`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsDateTime(due - ICS_EVENT_MINUTES * 60e3)}`,
        `DTEND:${icsDateTime(due)}`,
        `SUMMARY:${icsEscape(`${a.title || "Assignment"} (${label})`)}`
      );
      if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
      lines.push("END:VEVENT");
      exported++;
    }
  }
  lines.push("END:VCALENDAR");

  return { ics: lines.map(icsFold).join("\r\n") + "\r\n", exported, skippedUndated };
}

const _ics = { buildIcs, icsEscape, icsFold };

if (typeof module !== "undefined" && module.exports) {
  module.exports = _ics;
} else {
  globalThis.TP = Object.assign(globalThis.TP || {}, _ics);
}
