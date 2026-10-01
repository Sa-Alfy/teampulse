"use strict";

const test   = require("node:test");
const assert = require("node:assert");
const { buildIcs, icsEscape, icsFold } = require("../extension/core/ics");

const NOW = Date.parse("2026-10-01T10:00:00Z");
const digest = (assignments, extra = {}) => ({
  classes: [{ rawClassName: "Summer_2026_CSE 312 (V1)_ 232_D4", displayName: "CSE 312", assignments, ...extra }],
});

test("one VEVENT per dated assignment; undated skipped and counted", () => {
  const { ics, exported, skippedUndated } = buildIcs(digest([
    { title: "Lab 4", tab: "Upcoming", dueIso: "2026-10-05T17:59:00.000Z", assignmentId: "aabb-1" },
    { title: "Essay", tab: "Upcoming", dueIso: null },
  ]), NOW);
  assert.strictEqual(exported, 1);
  assert.strictEqual(skippedUndated, 1);
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(ics.includes("DTSTART:20261005T172900Z\r\n"), "30-min block ending at due time (UTC)");
  assert.ok(ics.includes("DTEND:20261005T175900Z\r\n"));
  assert.ok(ics.includes("DTSTAMP:20261001T100000Z\r\n"));
  assert.ok(ics.includes("UID:aabb-1@teamspulse.local\r\n"));
  assert.ok(ics.includes("SUMMARY:Lab 4 (CSE 312)\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends with CRLF");
});

test("scraped text cannot inject properties or events", () => {
  const evil = "x\r\nEND:VEVENT\r\nBEGIN:VEVENT\nSUMMARY:pwned; a,b\\c";
  const { ics } = buildIcs(digest([{ title: evil, details: evil, tab: "Upcoming", dueIso: "2026-10-05T17:59:00Z" }]), NOW);
  assert.strictEqual((ics.match(/^BEGIN:VEVENT/gm) || []).length, 1);
  assert.strictEqual((ics.match(/^SUMMARY:/gm) || []).length, 1);
  assert.strictEqual(icsEscape("a;b,c\\d\ne"), "a\\;b\\,c\\\\d\\ne");
});

test("lines fold at ≤75 octets without splitting multi-byte characters", () => {
  const long = "SUMMARY:" + "উপস্থাপনা ".repeat(20) + "é".repeat(50);
  const folded = icsFold(long);
  const enc = new TextEncoder();
  for (const line of folded.split("\r\n")) assert.ok(enc.encode(line).length <= 75, `line too long: ${enc.encode(line).length}`);
  assert.strictEqual(folded.replace(/\r\n /g, ""), long, "unfolding restores the original");
  assert.ok(!folded.includes("�"));
});

test("UID is stable across exports when Teams gives no GUID", () => {
  const a = { title: "Lab 4", tab: "Upcoming", dueIso: "2026-10-05T17:59:00Z" };
  const uid = (ics) => ics.match(/^UID:(.+)$/m)[1];
  assert.strictEqual(uid(buildIcs(digest([a]), NOW).ics), uid(buildIcs(digest([{ ...a }]), NOW + 5000).ics));
  assert.notStrictEqual(uid(buildIcs(digest([a]), NOW).ics), uid(buildIcs(digest([{ ...a, title: "Lab 5" }]), NOW).ics));
});

test("empty / missing digest → valid empty calendar", () => {
  for (const d of [null, { classes: [] }]) {
    const { ics, exported } = buildIcs(d, NOW);
    assert.strictEqual(exported, 0);
    assert.match(ics, /^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
  }
});
