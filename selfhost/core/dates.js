/**
 * selfhost/core/dates.js — Resolve an assignment's due instant on the server.
 *
 * The extension's shape.transformAssignment parses in the browser's local
 * timezone with the current year; a Worker runs in UTC, so the server needs
 * its own resolver: explicit timezone, `now` as a parameter, and a tab-aware
 * year rule for dates written without a year ("Jan 5th Due at 9:00 AM"):
 *   - Upcoming: a date more than 60 days before today rolls to next year.
 *   - Past due: a date after today rolls to last year.
 *   - Completed (any other tab): the nearest of last / this / next year, like
 *     the frame's inferDueDate when it knows no side.
 * Parsing reuses extractDate / extractTime (no new date regexes).
 */

"use strict";

const { extractDate, extractTime } = require("../../extension/core/digest-utils");
const { YEAR_ROLL_UPCOMING_DAYS, DEFAULT_DUE_TIME } = require("./config");
const { localParts, zonedToUtc, dayKey, daysBetween } = require("./time");

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function shiftYear(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const yy = y + n;
  const leap = (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  const dd = m === 2 && d === 29 && !leap ? 28 : d;
  return `${yy}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// "now"-derived values, computed once per (now, tz) instead of once per item.
let nowMemo = { key: "", year: 0, today: "" };
function nowInfo(nowMs, tz) {
  const key = `${nowMs}|${tz}`;
  if (nowMemo.key !== key) nowMemo = { key, year: localParts(nowMs, tz).y, today: dayKey(nowMs, tz) };
  return nowMemo;
}

/** "9:30 AM" / "14:30" / "7PM-9PM" (end wins) → { h, min } or null. */
function parseClock(t) {
  if (!t) return null;
  const last = t.split(/[-–—]|\bto\b/).pop().trim();
  const m = last.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  }
  return h < 24 && min < 60 ? { h, min } : null;
}

/**
 * Due instant as an ISO string (UTC), or null when no date can be read.
 *
 * @param {object} a     — { dueIso?, dueDate?, dueRaw?, details?, tab }
 * @param {number} nowMs
 * @param {string} tz
 */
function resolveDueIso(a, nowMs, tz) {
  // A complete instant (with offset) from the sender is used as is.
  if (typeof a.dueIso === "string" && /(Z|[+-]\d{2}:\d{2})$/.test(a.dueIso)) {
    const ms = Date.parse(a.dueIso);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }

  const text = `${a.dueDate || ""} ${a.dueRaw || ""} ${a.details || ""}`.trim();
  if (!text) return null;

  let day;
  if (typeof a.dueDate === "string" && ISO_DAY.test(a.dueDate)) {
    day = a.dueDate; // the frame already chose the year (inferDueDate)
  } else {
    const { year, today } = nowInfo(nowMs, tz);
    day = extractDate(text, year);
    if (!day) return null;
    // Year-less text: the result follows the fallback year.
    const yearless = extractDate(text, year + 1) !== day;
    if (yearless) {
      const diff = daysBetween(today, day);
      if (a.tab === "Upcoming" && diff < -YEAR_ROLL_UPCOMING_DAYS) day = shiftYear(day, 1);
      else if (a.tab === "Past due" && diff > 0) day = shiftYear(day, -1);
      else if (a.tab !== "Upcoming" && a.tab !== "Past due") {
        for (const cand of [shiftYear(day, -1), shiftYear(day, 1)]) {
          if (Math.abs(daysBetween(today, cand)) < Math.abs(daysBetween(today, day))) day = cand;
        }
      }
    }
  }

  const clock = parseClock(extractTime(text)) || DEFAULT_DUE_TIME;
  const [y, m, d] = day.split("-").map(Number);
  return new Date(zonedToUtc(y, m, d, clock.h, clock.min, tz)).toISOString();
}

module.exports = { resolveDueIso, parseClock, shiftYear };
