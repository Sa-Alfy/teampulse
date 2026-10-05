/**
 * selfhost/core/time.js — Timezone helpers (Intl only, no deps).
 *
 * Every function takes the instant as a parameter; nothing reads the clock.
 * Days are "YYYY-MM-DD" keys in the given IANA timezone.
 */

"use strict";

const { DAY } = require("./config");

const fmtCache = new Map();

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of `ms` in `tz`. Throws RangeError on an unknown timezone. */
function localParts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, s: +o.second, dow: o.weekday };
}

function isValidTimeZone(tz) {
  try { formatter(tz); return true; } catch { return false; }
}

// Offsets cached per 15-minute bucket (timezone transitions fall on those
// boundaries); formatToParts is the most expensive call in the diff.
const OFFSET_BUCKET = 15 * 60e3;
const offsetCache = new Map();

/** UTC offset of `tz` at `ms`, in ms (Dhaka: +6 h). */
function offsetMs(ms, tz) {
  const key = `${tz}|${Math.floor(ms / OFFSET_BUCKET)}`;
  let off = offsetCache.get(key);
  if (off === undefined) {
    const p = localParts(ms, tz);
    off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
    if (offsetCache.size > 2000) offsetCache.clear();
    offsetCache.set(key, off);
  }
  return off;
}

/** Instant of a wall-clock time in `tz` (m is 1-12). Two passes cover DST shifts. */
function zonedToUtc(y, m, d, h, min, tz) {
  const wall = Date.UTC(y, m - 1, d, h, min);
  const first = wall - offsetMs(wall, tz);
  return wall - offsetMs(first, tz);
}

const pad = (n) => String(n).padStart(2, "0");

function dayKey(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function parseDayKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

/** Shift a day key by n calendar days. */
function addDays(key, n) {
  const { y, m, d } = parseDayKey(key);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole calendar days from day key a to day key b. */
function daysBetween(a, b) {
  const pa = parseDayKey(a);
  const pb = parseDayKey(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY);
}

/** Instant of local midnight starting day `key`. */
function startOfDay(key, tz) {
  const { y, m, d } = parseDayKey(key);
  return zonedToUtc(y, m, d, 0, 0, tz);
}

/** "HH:MM" → minutes after midnight, or null. */
function parseHHMM(s) {
  const m = typeof s === "string" ? s.match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * True when `ms` falls inside quiet hours. `quiet` is { start, end } ("HH:MM")
 * or null/off. A window may cross midnight (23:00 → 07:00). start == end is off.
 */
function isQuiet(ms, tz, quiet) {
  if (!quiet) return false;
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === null || end === null || start === end) return false;
  const p = localParts(ms, tz);
  const now = p.h * 60 + p.min;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Instant quiet hours end, if `ms` is inside them; otherwise `ms`. */
function quietEndsAt(ms, tz, quiet) {
  if (!isQuiet(ms, tz, quiet)) return ms;
  const end = parseHHMM(quiet.end);
  const today = dayKey(ms, tz);
  const p = localParts(ms, tz);
  const key = p.h * 60 + p.min >= end ? addDays(today, 1) : today;
  const { y, m, d } = parseDayKey(key);
  return zonedToUtc(y, m, d, Math.floor(end / 60), end % 60, tz);
}

module.exports = {
  localParts, isValidTimeZone, offsetMs, zonedToUtc, dayKey, addDays,
  daysBetween, startOfDay, parseHHMM, isQuiet, quietEndsAt,
};
