/**
 * selfhost/core/agenda.js — Lists for /today /week /due and the /plan ranking. Pure.
 *
 * /plan is deterministic (no AI). Open items are ranked by urgency bucket:
 *   0 overdue (within OVERDUE_WINDOW_DAYS) · 1 due within 24 h · 2 within 72 h
 *   · 3 within 7 days · 4 later (up to PLAN_HORIZON_DAYS)
 * then by due time, then title. A crunch day is a local day with at least
 * CRUNCH_THRESHOLD open items due.
 */

"use strict";

const { HOUR, DAY, OVERDUE_WINDOW_DAYS, WEEK_DAYS, PLAN_HORIZON_DAYS, CRUNCH_THRESHOLD } = require("./config");
const { dayKey, addDays, startOfDay } = require("./time");
const { isOpen } = require("./reminders");

function dated(items) {
  return items
    .filter((r) => isOpen(r) && r.dueIso && !Number.isNaN(Date.parse(r.dueIso)))
    .map((r) => ({ ...r, dueMs: Date.parse(r.dueIso) }));
}

function byDue(a, b) {
  return a.dueMs - b.dueMs || String(a.title).localeCompare(String(b.title)) || String(a.key).localeCompare(String(b.key));
}

function overdue(items, now) {
  return dated(items).filter((r) => r.dueMs < now && r.dueMs >= now - OVERDUE_WINDOW_DAYS * DAY).sort(byDue);
}

/** Recent overdue + everything due before the end of today. */
function selectToday(items, now, tz) {
  const end = startOfDay(addDays(dayKey(now, tz), 1), tz);
  return { overdue: overdue(items, now), due: dated(items).filter((r) => r.dueMs >= now && r.dueMs < end).sort(byDue) };
}

/** Due from now through the end of the 7th local day (today counts as day 1). */
function selectWeek(items, now, tz) {
  const end = startOfDay(addDays(dayKey(now, tz), WEEK_DAYS), tz);
  return { overdue: overdue(items, now), due: dated(items).filter((r) => r.dueMs >= now && r.dueMs < end).sort(byDue) };
}

/** Every open dated item: recent overdue first, then upcoming. Numbering for /done follows this order. */
function selectDue(items, now) {
  return [...overdue(items, now), ...dated(items).filter((r) => r.dueMs >= now).sort(byDue)];
}

function bucket(dueMs, now) {
  const left = dueMs - now;
  if (left < 0) return 0;
  if (left < 24 * HOUR) return 1;
  if (left < 72 * HOUR) return 2;
  if (left < 7 * DAY) return 3;
  return 4;
}

function buildPlan(items, now, tz, opts = {}) {
  const threshold = opts.crunchThreshold || CRUNCH_THRESHOLD;
  const horizonEnd = startOfDay(addDays(dayKey(now, tz), PLAN_HORIZON_DAYS), tz);
  const pool = dated(items).filter((r) => r.dueMs < horizonEnd && r.dueMs >= now - OVERDUE_WINDOW_DAYS * DAY);
  const ranked = pool
    .map((r) => ({ ...r, bucket: bucket(r.dueMs, now) }))
    .sort((a, b) => a.bucket - b.bucket || byDue(a, b));

  const perDay = new Map();
  for (const r of ranked) {
    if (r.dueMs < now) continue;
    const k = dayKey(r.dueMs, tz);
    perDay.set(k, (perDay.get(k) || 0) + 1);
  }
  const crunchDays = [...perDay]
    .filter(([, n]) => n >= threshold)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day, count }));
  const undated = items.filter((r) => isOpen(r) && !r.dueIso).length;
  return { ranked, crunchDays, undated };
}

module.exports = { selectToday, selectWeek, selectDue, buildPlan, bucket };
