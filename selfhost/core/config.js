/**
 * selfhost/core/config.js — Constants for the self-host core.
 *
 * The product name is not final: change it here only.
 */

"use strict";

const PRODUCT_NAME = "TeamsPulse";

const HOUR = 3600e3;
const DAY  = 24 * HOUR;

module.exports = {
  PRODUCT_NAME,
  HOUR,
  DAY,
  DEFAULT_TZ: "Asia/Dhaka",
  DEFAULT_QUIET: { start: "23:00", end: "07:00" },
  // Same tab names as extension/core/messages.js ASSIGNMENT_TABS.
  ASSIGNMENT_TABS: ["Upcoming", "Past due", "Completed"],
  SUBMITTED_TAB: "Completed",
  // An assignment is removed only after 2 syncs (different syncIds) at least this far apart.
  REMOVAL_MIN_GAP_MS: HOUR,
  // Larger slot first. A reminder fires inside [due - ms, due - next slot's ms).
  REMINDER_SLOTS: [{ slot: "24h", ms: 24 * HOUR }, { slot: "3h", ms: 3 * HOUR }],
  // Year-less dates: an Upcoming date more than this many days in the past rolls forward a year.
  YEAR_ROLL_UPCOMING_DAYS: 60,
  DEFAULT_DUE_TIME: { h: 23, min: 59 },
  OVERDUE_WINDOW_DAYS: 14,
  WEEK_DAYS: 7,
  PLAN_HORIZON_DAYS: 14,
  CRUNCH_THRESHOLD: 3,
  MAX_LIST_ITEMS: 25,
  MAX_TEXT: 300,
};
