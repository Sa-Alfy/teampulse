"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  extractDate,
  extractTime,
  classify,
  isNoteworthy,
  filterRecentPosts,
  truncate,
  escapeCell,
  shortClassName,
  sectionLabel,
} = require("../digest-utils");

// ---------------------------------------------------------------------------
// extractDate
// ---------------------------------------------------------------------------

test("extractDate: day-first numeric", () => {
  assert.strictEqual(extractDate("CT on 20.09.2025", 2026), "2025-09-20");
  assert.strictEqual(extractDate("CT on 20-09-2025", 2026), "2025-09-20");
  assert.strictEqual(extractDate("CT on 20/09/2025", 2026), "2025-09-20");
});

test("extractDate: rejects impossible calendar days", () => {
  assert.strictEqual(extractDate("exam 31.02.2026", 2026), null);
  assert.strictEqual(extractDate("exam 32.01.2026", 2026), null);
  assert.strictEqual(extractDate("exam 15.13.2026", 2026), null);
});

test("extractDate: falls back to month-first when day-first is impossible", () => {
  // US-formatted 09/20/2025 — day-first reading (month 20) can't be real.
  assert.strictEqual(extractDate("due 09/20/2025", 2026), "2025-09-20");
});

test("extractDate: a year in the text beats fallbackYear", () => {
  assert.strictEqual(
    extractDate("Saturday, August 29, 2026 5:20 PM", 1999),
    "2026-08-29"
  );
  assert.strictEqual(extractDate("26th August 2026", 1999), "2026-08-26");
});

test("extractDate: uses fallbackYear only when no year is present", () => {
  assert.strictEqual(extractDate("CT on 26th August", 2026), "2026-08-26");
  assert.strictEqual(extractDate("quiz Aug 21", 2026), "2026-08-21");
});

test("extractDate: ambiguous month words need corroboration", () => {
  // "may" as a modal verb must not become a date.
  assert.strictEqual(extractDate("we may 5 students short", 2026), null);
  assert.strictEqual(extractDate("they march 3 times", 2026), null);
  // ...but a real date using the same word still parses.
  assert.strictEqual(extractDate("CT on May 5, 2026", 2026), "2026-05-05");
  assert.strictEqual(extractDate("CT on 5th May", 2026), "2026-05-05");
});

test("extractDate: leap years", () => {
  assert.strictEqual(extractDate("29.02.2024", 2024), "2024-02-29");
  assert.strictEqual(extractDate("29.02.2026", 2026), null);
});

test("extractDate: null/empty input", () => {
  assert.strictEqual(extractDate(null, 2026), null);
  assert.strictEqual(extractDate("", 2026), null);
  assert.strictEqual(extractDate("no date here", 2026), null);
});

// ---------------------------------------------------------------------------
// extractTime
// ---------------------------------------------------------------------------

test("extractTime: 12-hour singles", () => {
  assert.strictEqual(extractTime("CT at 9:30 AM"), "9:30 AM");
  assert.strictEqual(extractTime("CT at 11:59 pm"), "11:59 PM");
});

test("extractTime: normalises dot separator", () => {
  assert.strictEqual(extractTime("starts at 9.30 am"), "9:30 AM");
});

test("extractTime: 24-hour clocks", () => {
  assert.strictEqual(extractTime("CT starts at 14:30"), "14:30");
  assert.strictEqual(extractTime("CT starts at 9:30"), "9:30");
  assert.strictEqual(extractTime("CT starts at 23:05"), "23:05");
});

test("extractTime: ranges", () => {
  assert.strictEqual(extractTime("CT 9:30-11:00 am"), "9:30-11:00 AM");
  assert.strictEqual(extractTime("exam 14:30-16:00"), "14:30-16:00");
});

test("extractTime: no time present", () => {
  assert.strictEqual(extractTime("CT next week"), null);
  assert.strictEqual(extractTime(null), null);
});

test("extractTime: does not read a room number as a time", () => {
  assert.strictEqual(extractTime("CT in room 312"), null);
});

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

test("classify: categories", () => {
  assert.strictEqual(classify("CT on monday"), "🧪 CT/Quiz");
  assert.strictEqual(classify("final exam schedule"), "📝 Exam");
  assert.strictEqual(classify("presentation slots"), "🎤 Presentation");
  assert.strictEqual(classify("class is cancelled"), "❌ Cancelled");
  assert.strictEqual(classify("assignment due friday"), "📌 Deadline");
  assert.strictEqual(classify("marks published"), "📊 Grades");
  assert.strictEqual(classify("hello everyone"), "📢 Notice");
});

// ---------------------------------------------------------------------------
// isNoteworthy
// ---------------------------------------------------------------------------

test("isNoteworthy: rejects half-hydrated placeholders", () => {
  assert.strictEqual(isNoteworthy({ body: "Loading..." }), false);
});

test("isNoteworthy: rejects empty posts", () => {
  assert.strictEqual(isNoteworthy({ subject: "", body: "" }), false);
});

test("isNoteworthy: accepts announcements and bots unconditionally", () => {
  assert.strictEqual(isNoteworthy({ body: "hi", isAnnouncement: true }), true);
  assert.strictEqual(isNoteworthy({ body: "hi", isBot: true }), true);
});

test("isNoteworthy: accepts keyword and date posts", () => {
  assert.strictEqual(isNoteworthy({ body: "CT next week" }), true);
  assert.strictEqual(isNoteworthy({ body: "meet on 20.09.2025" }), true);
  assert.strictEqual(isNoteworthy({ body: "good morning all" }), false);
});

// ---------------------------------------------------------------------------
// filterRecentPosts
// ---------------------------------------------------------------------------

test("filterRecentPosts: keeps recent, drops old, keeps undated", () => {
  const now = Date.now();
  const posts = [
    { id: "recent", timestampIso: new Date(now - 2 * 3600e3).toISOString() },
    { id: "old", timestampIso: new Date(now - 72 * 3600e3).toISOString() },
    { id: "undated", timestampIso: null },
    { id: "garbage", timestampIso: "not-a-date" },
  ];
  const kept = filterRecentPosts(posts, 24).map((p) => p.id);
  assert.deepStrictEqual(kept, ["recent", "undated", "garbage"]);
});

// ---------------------------------------------------------------------------
// truncate / escapeCell
// ---------------------------------------------------------------------------

test("truncate: collapses whitespace and appends ellipsis", () => {
  assert.strictEqual(truncate("a  b\nc", 90), "a b c");
  assert.strictEqual(truncate("abcdef", 4), "abc…");
  assert.strictEqual(truncate(null), "");
});

test("escapeCell: escapes pipes and newlines", () => {
  assert.strictEqual(escapeCell("a|b\nc"), "a\\|b c");
  assert.strictEqual(escapeCell(null), "");
});

// ---------------------------------------------------------------------------
// shortClassName / sectionLabel
// ---------------------------------------------------------------------------

test("shortClassName: extracts the course code", () => {
  assert.strictEqual(shortClassName("Summer_2026_CSE 312 (V1)_232_D4"), "CSE 312");
  assert.strictEqual(shortClassName("Summer_2026_CSE 312 (V2)_232_D9"), "CSE 312");
  assert.strictEqual(shortClassName("Random Team"), "Random Team");
});

test("shortClassName: collapses sections — proof it cannot be used as a key", () => {
  const a = "Summer_2026_CSE 312 (V1)_232_D4";
  const b = "Summer_2026_CSE 312 (V2)_232_D9";
  assert.strictEqual(shortClassName(a), shortClassName(b));
  assert.notStrictEqual(a, b);
});

test("sectionLabel: pulls the parenthesised section", () => {
  assert.strictEqual(sectionLabel("Summer_2026_CSE 312 (V1)_232_D4"), "V1");
  assert.strictEqual(sectionLabel("No section here"), null);
});
