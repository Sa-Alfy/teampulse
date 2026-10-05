"use strict";

/**
 * Self-host core (selfhost/core/*): timezone helpers, due-date resolution,
 * diff engine, reminder planner, agenda / plan, formatters. All pure; `now`
 * is always passed in.
 */

const test   = require("node:test");
const assert = require("node:assert");

const { ASSIGNMENT_TABS, HOUR, DAY } = require("../selfhost/core/config");
const time = require("../selfhost/core/time");
const { resolveDueIso } = require("../selfhost/core/dates");
const { diffSync, assignmentKey } = require("../selfhost/core/diff");
const { planReminders, reminderId } = require("../selfhost/core/reminders");
const agenda = require("../selfhost/core/agenda");
const fmt = require("../selfhost/core/format");
const { classify } = require("../extension/core/digest-utils");

const TZ = "Asia/Dhaka";
const T = (iso) => Date.parse(iso);
const QUIET = { start: "23:00", end: "07:00" };

// ── time ──────────────────────────────────────────────────────────────────

test("time: zonedToUtc / dayKey in Dhaka (+06:00, no DST)", () => {
  assert.strictEqual(new Date(time.zonedToUtc(2026, 10, 5, 9, 0, TZ)).toISOString(), "2026-10-05T03:00:00.000Z");
  assert.strictEqual(time.dayKey(T("2026-10-05T17:59:00Z"), TZ), "2026-10-05");
  assert.strictEqual(time.dayKey(T("2026-10-05T18:00:00Z"), TZ), "2026-10-06");
});

test("time: zonedToUtc handles a DST zone (New York, after spring-forward)", () => {
  assert.strictEqual(new Date(time.zonedToUtc(2026, 3, 8, 12, 0, "America/New_York")).toISOString(), "2026-03-08T16:00:00.000Z");
  assert.strictEqual(new Date(time.zonedToUtc(2026, 1, 8, 12, 0, "America/New_York")).toISOString(), "2026-01-08T17:00:00.000Z");
});

test("time: addDays / daysBetween across month and year ends", () => {
  assert.strictEqual(time.addDays("2026-12-31", 1), "2027-01-01");
  assert.strictEqual(time.addDays("2027-03-01", -1), "2027-02-28");
  assert.strictEqual(time.daysBetween("2026-12-20", "2027-01-05"), 16);
});

test("time: quiet hours crossing midnight, end instant, invalid tz", () => {
  assert.strictEqual(time.isQuiet(T("2026-10-05T17:30:00Z"), TZ, QUIET), true);  // 23:30 local
  assert.strictEqual(time.isQuiet(T("2026-10-05T00:59:00Z"), TZ, QUIET), true);  // 06:59 local
  assert.strictEqual(time.isQuiet(T("2026-10-05T01:00:00Z"), TZ, QUIET), false); // 07:00 local
  assert.strictEqual(time.isQuiet(T("2026-10-05T17:30:00Z"), TZ, null), false);
  assert.strictEqual(time.isQuiet(T("2026-10-05T17:30:00Z"), TZ, { start: "07:00", end: "07:00" }), false);
  assert.strictEqual(new Date(time.quietEndsAt(T("2026-10-05T17:30:00Z"), TZ, QUIET)).toISOString(), "2026-10-06T01:00:00.000Z");
  assert.strictEqual(new Date(time.quietEndsAt(T("2026-10-05T20:00:00Z"), TZ, QUIET)).toISOString(), "2026-10-06T01:00:00.000Z");
  assert.strictEqual(time.isValidTimeZone(TZ), true);
  assert.strictEqual(time.isValidTimeZone("Not/AZone"), false);
});

// ── dates: tab-aware year rule ────────────────────────────────────────────

test("dates: Upcoming year-less date >60 days in the past rolls to next year (Dec → Jan)", () => {
  const now = T("2026-12-20T06:00:00Z");
  assert.strictEqual(resolveDueIso({ tab: "Upcoming", dueRaw: "Jan 5th Due at 9:00 AM" }, now, TZ), "2027-01-05T03:00:00.000Z");
});

test("dates: Upcoming within 60 days stays this year; next-week date unchanged in January", () => {
  assert.strictEqual(resolveDueIso({ tab: "Upcoming", dueRaw: "Nov 1st Due at 9:00 AM" }, T("2026-12-01T06:00:00Z"), TZ), "2026-11-01T03:00:00.000Z");
  assert.strictEqual(resolveDueIso({ tab: "Upcoming", dueRaw: "Jan 5th Due at 9:00 AM" }, T("2027-01-02T06:00:00Z"), TZ), "2027-01-05T03:00:00.000Z");
});

test("dates: Past due year-less date in the future rolls to last year (Jan → Dec)", () => {
  assert.strictEqual(resolveDueIso({ tab: "Past due", dueRaw: "Dec 30th Due at 11:59 PM" }, T("2027-01-03T06:00:00Z"), TZ), "2026-12-30T17:59:00.000Z");
  assert.strictEqual(resolveDueIso({ tab: "Past due", dueRaw: "Dec 30th Due at 11:59 PM" }, T("2026-12-31T06:00:00Z"), TZ), "2026-12-30T17:59:00.000Z");
});

test("dates: an explicit year or a frame-supplied ISO day is never rolled", () => {
  const now = T("2026-12-20T06:00:00Z");
  assert.strictEqual(resolveDueIso({ tab: "Upcoming", dueRaw: "Jan 5, 2026 Due at 9:00 AM" }, now, TZ), "2026-01-05T03:00:00.000Z");
  assert.strictEqual(resolveDueIso({ tab: "Upcoming", dueDate: "2026-01-05", dueRaw: "Due at 9:00 AM" }, now, TZ), "2026-01-05T03:00:00.000Z");
});

test("dates: dueIso with offset passes through; no time → 23:59 local; nothing → null", () => {
  const now = T("2026-10-05T06:00:00Z");
  assert.strictEqual(resolveDueIso({ tab: "Upcoming", dueIso: "2026-10-07T12:00:00+06:00" }, now, TZ), "2026-10-07T06:00:00.000Z");
  assert.strictEqual(resolveDueIso({ tab: "Upcoming", dueDate: "2026-10-07" }, now, TZ), "2026-10-07T17:59:00.000Z");
  assert.strictEqual(resolveDueIso({ tab: "Upcoming", dueRaw: "No due date" }, now, TZ), null);
  assert.strictEqual(resolveDueIso({ tab: "Upcoming" }, now, TZ), null);
});

// ── diff engine ───────────────────────────────────────────────────────────

const A = "Summer_2026_CSE 312 (V1)";
const B = "Summer_2026_CSE 304 (V1)";
const FULL = (cn) => ({ class: cn, tabs: ASSIGNMENT_TABS.slice() });

function asg(id, over = {}) {
  return { class: A, assignmentId: id, title: `Lab ${id}`, tab: "Upcoming", dueIso: "2026-10-10T17:59:00.000Z", ...over };
}

function post(id, over = {}) {
  return { class: A, id: id.padEnd(64, "0"), author: "T", subject: "", body: "Class test on Sunday", isBot: false, ...over };
}

function newState() {
  return { classes: {}, items: new Map() };
}

function apply(st, res) {
  st.classes = res.classes;
  for (const u of res.upserts) st.items.set(u.key, u);
  return res;
}

function sync(syncId, at, over = {}) {
  return { syncId, at, tz: TZ, covered: [FULL(A)], assignments: [], posts: [], ...over };
}

const T0 = T("2026-10-05T06:00:00Z");

async function baselined() {
  const st = newState();
  apply(st, await diffSync(st, sync("s1", T0, { assignments: [asg("g1"), asg("g2")], posts: [post("p1")] })));
  return st;
}

test("diff: first sync is a baseline — stores everything, zero events", async () => {
  const st = newState();
  const r = apply(st, await diffSync(st, sync("s1", T0, { assignments: [asg("g1"), asg("g2")], posts: [post("p1")] })));
  assert.strictEqual(r.events.length, 0);
  assert.strictEqual(r.upserts.length, 3);
  assert.deepStrictEqual(r.classes[A], { a: true, p: true });
});

test("diff: the same payload again (new or same syncId) gives zero events and zero writes", async () => {
  const st = await baselined();
  for (const id of ["s2", "s1"]) {
    const r = await diffSync(st, sync(id, T0 + HOUR, { assignments: [asg("g1"), asg("g2")], posts: [post("p1")] }));
    assert.strictEqual(r.events.length, 0, id);
    assert.strictEqual(r.upserts.length, 0, id);
  }
});

test("diff: moved due date → due_date_changed {old,new}; ids are deterministic", async () => {
  const st = await baselined();
  const s = sync("s2", T0 + HOUR, { assignments: [asg("g1", { dueIso: "2026-10-12T17:59:00.000Z" }), asg("g2")] });
  const r1 = await diffSync(st, s);
  const r2 = await diffSync(st, s);
  assert.deepStrictEqual(r1.events.map((e) => e.type), ["due_date_changed"]);
  assert.strictEqual(r1.events[0].payload.old, "2026-10-10T17:59:00.000Z");
  assert.strictEqual(r1.events[0].payload.new, "2026-10-12T17:59:00.000Z");
  assert.strictEqual(r1.events[0].id, r2.events[0].id);
  assert.match(r1.events[0].id, /^[0-9a-f]{64}$/);
});

test("diff: assignment_submitted only on false → true", async () => {
  const st = await baselined();
  const r1 = apply(st, await diffSync(st, sync("s2", T0 + HOUR, { assignments: [asg("g1", { tab: "Completed" }), asg("g2")] })));
  assert.deepStrictEqual(r1.events.map((e) => e.type), ["assignment_submitted"]);
  const r2 = apply(st, await diffSync(st, sync("s3", T0 + 2 * HOUR, { assignments: [asg("g1", { tab: "Completed" }), asg("g2")] })));
  assert.strictEqual(r2.events.length, 0);
  const r3 = apply(st, await diffSync(st, sync("s4", T0 + 3 * HOUR, { assignments: [asg("g1", { tab: "Past due" }), asg("g2")] })));
  assert.strictEqual(r3.events.length, 0, "true → false is silent");
});

test("diff: removal needs 2 syncs with different syncIds at least 1 h apart", async () => {
  const st = await baselined();
  const only1 = { assignments: [asg("g1")] };
  let r = apply(st, await diffSync(st, sync("s2", T0 + HOUR, only1)));
  assert.strictEqual(r.events.length, 0);
  assert.strictEqual(st.items.get(assignmentKey(asg("g2"))).missingSyncId, "s2");
  r = apply(st, await diffSync(st, sync("s2", T0 + 3 * HOUR, only1)));
  assert.strictEqual(r.events.length, 0, "same syncId replayed later");
  r = apply(st, await diffSync(st, sync("s3", T0 + HOUR + 30 * 60e3, only1)));
  assert.strictEqual(r.events.length, 0, "only 30 min apart");
  r = apply(st, await diffSync(st, sync("s4", T0 + 2 * HOUR, only1)));
  assert.deepStrictEqual(r.events.map((e) => e.type), ["assignment_removed"]);
  assert.ok(st.items.get(assignmentKey(asg("g2"))).removedAt);
  r = await diffSync(st, sync("s5", T0 + 5 * HOUR, only1));
  assert.strictEqual(r.events.length, 0, "removed once only");
});

test("diff: reappearing before removal clears the missing mark; after removal it is new again", async () => {
  const st = await baselined();
  apply(st, await diffSync(st, sync("s2", T0 + HOUR, { assignments: [asg("g1")] })));
  let r = apply(st, await diffSync(st, sync("s3", T0 + 3 * HOUR, { assignments: [asg("g1"), asg("g2")] })));
  assert.strictEqual(r.events.length, 0);
  assert.strictEqual(st.items.get(assignmentKey(asg("g2"))).missingSyncId, null);
  apply(st, await diffSync(st, sync("s4", T0 + 4 * HOUR, { assignments: [asg("g1")] })));
  apply(st, await diffSync(st, sync("s5", T0 + 6 * HOUR, { assignments: [asg("g1")] })));
  r = await diffSync(st, sync("s6", T0 + 7 * HOUR, { assignments: [asg("g1"), asg("g2")] }));
  assert.deepStrictEqual(r.events.map((e) => [e.type, e.payload.reappeared]), [["new_assignment", true]]);
});

test("diff: partial or missing coverage never marks anything missing", async () => {
  const st = await baselined();
  for (const [i, covered] of [[2, [{ class: A, tabs: ["Upcoming", "Past due"] }]], [3, []], [4, [FULL(B)]]]) {
    const r = apply(st, await diffSync(st, sync(`s${i}`, T0 + i * 2 * HOUR, { covered, assignments: [] })));
    assert.strictEqual(r.events.length, 0);
    assert.strictEqual(st.items.get(assignmentKey(asg("g1"))).missingSyncId, null);
  }
});

test("diff: a class stays in baseline until a sync covers all three tabs", async () => {
  const st = newState();
  const part = [{ class: A, tabs: ["Past due"] }];
  let r = apply(st, await diffSync(st, sync("s1", T0, { covered: part, assignments: [asg("x", { tab: "Past due" })] })));
  assert.strictEqual(r.events.length, 0);
  r = apply(st, await diffSync(st, sync("s2", T0 + HOUR, { assignments: [asg("x", { tab: "Past due" }), asg("y", { tab: "Completed" })] })));
  assert.strictEqual(r.events.length, 0, "first full sync is still the baseline");
  r = await diffSync(st, sync("s3", T0 + 2 * HOUR, { assignments: [asg("x", { tab: "Past due" }), asg("y", { tab: "Completed" }), asg("z")] }));
  assert.deepStrictEqual(r.events.map((e) => e.type), ["new_assignment"]);
});

test("diff: without a GUID the key ignores the due date, so a move is a change", async () => {
  const st = newState();
  const noGuid = (due) => ({ class: A, title: "Report  1", tab: "Upcoming", dueIso: due });
  apply(st, await diffSync(st, sync("s1", T0, { assignments: [noGuid("2026-10-10T17:59:00.000Z")] })));
  const r = await diffSync(st, sync("s2", T0 + HOUR, { assignments: [{ ...noGuid("2026-10-11T17:59:00.000Z"), title: "report 1" }] }));
  assert.deepStrictEqual(r.events.map((e) => e.type), ["due_date_changed"]);
});

test("diff: colliding fallback keys skip due-date events and are counted", async () => {
  const st = newState();
  const twin = (due) => ({ class: A, title: "Quiz", tab: "Upcoming", dueIso: due });
  apply(st, await diffSync(st, sync("s1", T0, { assignments: [twin("2026-10-10T17:59:00.000Z"), twin("2026-10-17T17:59:00.000Z")] })));
  const r = await diffSync(st, sync("s2", T0 + HOUR, { assignments: [twin("2026-10-17T17:59:00.000Z"), twin("2026-10-10T17:59:00.000Z")] }));
  assert.strictEqual(r.stats.collisions, 1);
  assert.strictEqual(r.events.length, 0);
});

test("diff: an unreadable new due date keeps the stored one and is silent", async () => {
  const st = await baselined();
  const r = await diffSync(st, sync("s2", T0 + HOUR, { assignments: [asg("g1", { dueIso: undefined, dueRaw: "" }), asg("g2")] }));
  assert.strictEqual(r.events.length, 0);
  assert.strictEqual(r.upserts.length, 0);
});

test("diff: posts — classify tags, non-noteworthy posts stored silently, duplicates once", async () => {
  const st = await baselined();
  const posts = [
    post("p1"),                                                   // already stored
    post("p2", { body: "CT 2 on Sunday" }),                       // tagged
    post("p2", { body: "CT 2 on Sunday" }),                       // duplicate in batch
    post("p3", { body: "hello everyone" }),                       // not noteworthy
    post("p4", { body: "Welcome back", isAnnouncement: true }),   // notice
  ];
  const r = await diffSync(st, sync("s2", T0 + HOUR, { assignments: [asg("g1"), asg("g2")], posts }));
  assert.deepStrictEqual(r.events.map((e) => [e.type, e.payload.tag]), [["tagged_post", classify("ct")], ["new_post", classify("")]]);
  assert.strictEqual(r.upserts.filter((u) => u.kind === "p").length, 3);
});

test("diff: first post batch of a class is a baseline", async () => {
  const st = await baselined();
  const r = await diffSync(st, sync("s2", T0 + HOUR, { covered: [], posts: [post("q1", { class: B, body: "Quiz tomorrow" })] }));
  assert.strictEqual(r.events.length, 0);
  assert.strictEqual(r.classes[B].p, true);
});

test("diff: a later sync clears a server-side /done mark", async () => {
  const st = await baselined();
  const k = assignmentKey(asg("g1"));
  st.items.set(k, { ...st.items.get(k), doneAt: T0 + 10 * 60e3 });
  const r = await diffSync(st, sync("s2", T0 + HOUR, { assignments: [asg("g1"), asg("g2")] }));
  assert.strictEqual(r.upserts.find((u) => u.key === k).doneAt, null);
});

// ── reminders ─────────────────────────────────────────────────────────────

const NOW = T("2026-10-05T06:00:00Z"); // 12:00 Dhaka, not quiet
function item(key, dueMs, over = {}) {
  return { key, kind: "a", class: A, title: key, dueIso: new Date(dueMs).toISOString(), firstSeen: NOW - 3 * DAY,
           submitted: false, removedAt: null, doneAt: null, ...over };
}

test("reminders: 24h and 3h windows; overdue and far-off items get none", () => {
  const items = [item("d20", NOW + 20 * HOUR), item("d2", NOW + 2 * HOUR), item("d30", NOW + 30 * HOUR), item("late", NOW - HOUR)];
  const r = planReminders(items, new Set(), NOW, { tz: TZ, quiet: QUIET });
  assert.deepStrictEqual(r.map((x) => [x.itemKey, x.slot, x.kind]), [["d2", "3h", "3h"], ["d20", "24h", "24h"]]);
});

test("reminders: submitted, done and removed items get none", () => {
  const items = [
    item("sub", NOW + 2 * HOUR, { submitted: true }),
    item("done", NOW + 2 * HOUR, { doneAt: NOW - HOUR }),
    item("gone", NOW + 2 * HOUR, { removedAt: NOW - HOUR }),
  ];
  assert.deepStrictEqual(planReminders(items, new Set(), NOW, { tz: TZ, quiet: QUIET }), []);
});

test("reminders: idempotent via sent ids; a moved due date gets new ids", () => {
  const it = item("x", NOW + 2 * HOUR);
  const sent = new Set([reminderId("x", it.dueIso, "3h")]);
  assert.deepStrictEqual(planReminders([it], sent, NOW, { tz: TZ }), []);
  const moved = item("x", NOW + 2.5 * HOUR);
  assert.strictEqual(planReminders([moved], sent, NOW, { tz: TZ }).length, 1);
});

test("reminders: quiet hours defer the 24h reminder but not the 3h one", () => {
  const quietNow = T("2026-10-05T18:30:00Z"); // 00:30 Dhaka
  const items = [item("d20", quietNow + 20 * HOUR), item("d2", quietNow + 2 * HOUR)];
  const r = planReminders(items, new Set(), quietNow, { tz: TZ, quiet: QUIET });
  assert.deepStrictEqual(r.map((x) => x.itemKey), ["d2"]);
  const after = T("2026-10-06T01:05:00Z"); // 07:05 Dhaka, d20 now due in ~17.4 h
  assert.deepStrictEqual(planReminders(items, new Set(), after, { tz: TZ, quiet: QUIET }).map((x) => x.slot), ["24h"]);
});

test("reminders: first seen <24 h before due skips 24h; first seen <3 h before due → due_soon", () => {
  const late = item("late", NOW + 20 * HOUR, { firstSeen: NOW - HOUR });
  assert.deepStrictEqual(planReminders([late], new Set(), NOW, { tz: TZ }), []);
  const lateAt3 = planReminders([late], new Set(), NOW + 18 * HOUR, { tz: TZ });
  assert.deepStrictEqual(lateAt3.map((x) => x.kind), ["3h"]);
  const soon = item("soon", NOW + 2 * HOUR, { firstSeen: NOW });
  assert.deepStrictEqual(planReminders([soon], new Set(), NOW, { tz: TZ }).map((x) => [x.slot, x.kind]), [["3h", "due_soon"]]);
});

// ── agenda / plan ─────────────────────────────────────────────────────────

function agendaItems() {
  const at = (iso, key, over) => item(key, T(iso), over);
  return [
    at("2026-10-04T17:59:00Z", "overdue"),
    at("2026-10-05T12:00:00Z", "today"),            // 18:00 Dhaka
    at("2026-10-06T03:00:00Z", "tom1"),
    at("2026-10-06T08:00:00Z", "tom2"),
    at("2026-10-06T17:00:00Z", "tom3"),
    at("2026-10-10T17:59:00Z", "sat"),
    at("2026-10-14T17:59:00Z", "nextwk"),
    at("2026-11-30T17:59:00Z", "far"),
    at("2026-10-05T10:00:00Z", "subm", { submitted: true }),
    at("2026-09-01T17:59:00Z", "ancient"),
    { ...item("nodate", 0), dueIso: null },
  ];
}

test("agenda: /today, /week, /due selections", () => {
  const items = agendaItems();
  const today = agenda.selectToday(items, NOW, TZ);
  assert.deepStrictEqual(today.overdue.map((r) => r.key), ["overdue"]);
  assert.deepStrictEqual(today.due.map((r) => r.key), ["today"]);
  const week = agenda.selectWeek(items, NOW, TZ);
  assert.deepStrictEqual(week.due.map((r) => r.key), ["today", "tom1", "tom2", "tom3", "sat"]);
  assert.deepStrictEqual(agenda.selectDue(items, NOW).map((r) => r.key),
    ["overdue", "today", "tom1", "tom2", "tom3", "sat", "nextwk", "far"]);
});

test("agenda: /plan ranks by urgency bucket and flags crunch days (deterministic)", () => {
  const items = agendaItems();
  const plan = agenda.buildPlan(items, NOW, TZ);
  assert.deepStrictEqual(plan.ranked.map((r) => [r.key, r.bucket]),
    [["overdue", 0], ["today", 1], ["tom1", 1], ["tom2", 2], ["tom3", 2], ["sat", 3], ["nextwk", 4]]);
  assert.deepStrictEqual(plan.crunchDays, [{ day: "2026-10-06", count: 3 }]);
  assert.strictEqual(plan.undated, 1);
  assert.deepStrictEqual(agenda.buildPlan([...items].reverse(), NOW, TZ), plan);
});

// ── formatters ────────────────────────────────────────────────────────────

test("format: last-synced line", () => {
  assert.strictEqual(fmt.lastSyncedLine(null, NOW), "Last synced: never");
  assert.strictEqual(fmt.lastSyncedLine(NOW - 5 * 60e3, NOW), "Last synced 5 min ago");
  assert.strictEqual(fmt.lastSyncedLine(NOW - 3 * HOUR, NOW), "Last synced 3 h ago");
  assert.strictEqual(fmt.lastSyncedLine(NOW - 3 * DAY, NOW), "Last synced 3 d ago");
});

test("format: clean() strips control and bidi characters and caps length", () => {
  assert.strictEqual(fmt.clean("a\u0000b‮c​d\r\ne"), "abcd\ne");
  assert.strictEqual(fmt.clean("x".repeat(50), 10), `${"x".repeat(9)}…`);
});

test("format: events, reminders and lists are plain text with a last-synced footer", () => {
  const ctx = { now: NOW, tz: TZ, lastSyncAt: NOW - 2 * HOUR };
  const ev = { type: "due_date_changed", payload: { class: A, title: "<b>Lab</b>", old: "2026-10-10T17:59:00.000Z", new: "2026-10-12T17:59:00.000Z" } };
  const text = fmt.formatEvent(ev, ctx);
  assert.match(text, /Due date changed \[CSE 312\]/);
  assert.match(text, /<b>Lab<\/b>/);
  assert.match(text, /Was: Sat 10 Oct 23:59 \(in 5 d\)\nNow: Mon 12 Oct 23:59 \(in 7 d\)/);
  assert.strictEqual(fmt.formatEvent({ type: "nope", payload: {} }, ctx), null);
  assert.strictEqual(fmt.eventPriority(ev), "high");
  const r = fmt.formatReminder({ slot: "3h", kind: "3h", class: A, title: "Lab", dueIso: "2026-10-05T08:00:00.000Z" }, ctx);
  assert.match(r, /Last synced 2 h ago/);
  for (const out of [
    fmt.formatToday(agenda.selectToday(agendaItems(), NOW, TZ), ctx),
    fmt.formatWeek(agenda.selectWeek(agendaItems(), NOW, TZ), ctx),
    fmt.formatDue(agenda.selectDue(agendaItems(), NOW), ctx, 25),
    fmt.formatPlan(agenda.buildPlan(agendaItems(), NOW, TZ), ctx),
    fmt.formatDigest(agenda.selectWeek(agendaItems(), NOW, TZ), ctx),
  ]) assert.match(out, /\n\nLast synced 2 h ago$/);
  assert.match(fmt.formatPlan(agenda.buildPlan(agendaItems(), NOW, TZ), ctx), /🔥 6 Oct 2026: 3 due/);
});

test("format: high-priority tags are real classify() outputs", () => {
  for (const text of ["quiz", "exam", "rescheduled", "cancelled"]) {
    assert.strictEqual(fmt.eventPriority({ type: "tagged_post", payload: { tag: classify(text) } }), "high", text);
  }
  assert.strictEqual(fmt.eventPriority({ type: "tagged_post", payload: { tag: classify("grades") } }), "normal");
});
