"use strict";

/**
 * test/assignments-capture.test.js — regressions from the owner's 2026-10-01
 * .ics export (13 assignments × 2: every Past due item again as "Upcoming"
 * +1 year, all filed under CSE 304, "Due at 11:59 PMCSE 204" glued) and the
 * v0.6.1–0.6.3 "nothing captured" reports. Today = 2026-10-03.
 *
 * End-to-end hop trace with the real modules:
 *   content-script payload → messages.handleMessage → store → buildDigest → buildIcs
 */

const test   = require("node:test");
const assert = require("node:assert");

const { createStore, memoryBackend, KEY_CAPTURE_REPORT } = require("../extension/core/store");
const { handleMessage, tabCtxKey } = require("../extension/core/messages");
const { buildDigest } = require("../extension/core/shape");
const { buildIcs }    = require("../extension/core/ics");
const { inferDueDate } = require("../extension/content/assignments-frame");

const TODAY = new Date(2026, 9, 3, 10, 0, 0);
const C304 = "Summer_2026_CSE 304 (V1)_242_D1";
const C204 = "CSE 204 (Digital Logic Design DLD Lab)";
const C312 = "Summer_2026_CSE 312 (V1)_ 232_D4";
const SENDER = { tab: { id: 9 }, url: "https://assignments.edu.cloud.microsoft/classes/all/list" };

function setup() {
  const backend = memoryBackend();
  const store = createStore(backend);
  const sdata = {};
  const session = {
    get: async (k) => sdata[k] ?? null,
    set: async (k, v) => { sdata[k] = v; },
    remove: async (k) => { delete sdata[k]; },
  };
  let t = 0;
  const deps = { store, session, nowIso: () => new Date(Date.parse("2026-10-03T10:00:00Z") + (t++) * 1000).toISOString() };
  const teams = { tab: { id: 9 }, url: "https://teams.cloud.microsoft/" };
  const seeClass = (cn) => handleMessage({ type: "TP_CLASS_CONTEXT", className: cn }, teams, deps);
  return { backend, store, deps, session, seeClass };
}

const card = (tab, title, id, extra = {}) => ({
  tab, title, assignmentId: `${id}-1111-4222-8333-444455556666`, rawId: `${id}-1111-4222-8333-444455556666`,
  details: "Due at 11:59 PM", dueRaw: "Aug 31st Due at 11:59 PM", dueDate: "2026-08-31", status: "", ...extra,
});
const report = (status, tabs) => ({ version: 1, startedAt: "2026-10-03T10:00:00.000Z", trigger: "load", scope: "all-classes",
  readyWaitResult: "ready", documentHidden: false, rendered: true, status, reason: "", tabs });
const tabRep = (tab, status, reason = "") => ({ tab, tabFound: true, clicked: true, selectedConfirmed: true,
  cardsChangedConfirmed: status === "ok", listLoaded: status === "ok", cardsRaw: 2, droppedHidden: 0, droppedStale: 0,
  droppedByRelativeFilter: 0, dedupedOut: 0, kept: status === "ok" ? 1 : 0, status, reason });

// ── inferDueDate (H6) ───────────────────────────────────────────────────────

test("inferDueDate: year from proximity to today, on the side the header/tab implies", () => {
  assert.strictEqual(inferDueDate("Dec 30th", "Past due", TODAY), "2025-12-30");
  assert.strictEqual(inferDueDate("Jan 5th", "Upcoming", TODAY), "2027-01-05");
  assert.strictEqual(inferDueDate("Oct 20th", "Completed", TODAY), "2026-10-20", "Completed, no relative text");
  // Evidence: a past-due card read under "Upcoming" was rolled to 2027.
  assert.strictEqual(inferDueDate("Mar 15th", "Upcoming", TODAY, "Due 7 months ago"), "2026-03-15");
  assert.strictEqual(inferDueDate("Dec 29, 2025", "Upcoming", TODAY), "2025-12-29", "explicit year wins");
  assert.strictEqual(inferDueDate("Feb 30th", "Past due", TODAY), null);
});

// ── Store merge (H5) ────────────────────────────────────────────────────────

test("skipped Completed tab leaves stored Completed items intact; ok tabs are replaced", async () => {
  const { store, deps, seeClass } = setup();
  await seeClass(C312);
  await store.mergeAssignments(C312, [card("Completed", "Quiz-1", "c0000001"), card("Past due", "old", "p0000009")],
    ["Upcoming", "Past due", "Completed"], "2026-10-01T00:00:00Z");

  const res = await handleMessage({ type: "TP_ASSIGNMENTS", scope: "all-classes", okTabs: ["Upcoming", "Past due"],
    assignments: [card("Past due", "Project Submission", "p0000001", { className: C312 })],
    report: report("partial", [tabRep("Upcoming", "ok"), tabRep("Past due", "ok"), tabRep("Completed", "timeout", "list-not-loaded")]),
  }, SENDER, deps);
  assert.strictEqual(res.ok, true, res.reason);
  const items = (await store.getState()).classes[C312].assignments;
  assert.deepStrictEqual(items.map((a) => `${a.tab}:${a.title}`).sort(), ["Completed:Quiz-1", "Past due:Project Submission"]);
});

test("all tabs timing out → report 'failed', nothing overwritten", async () => {
  const { store, backend, deps, seeClass } = setup();
  await seeClass(C312);
  await store.mergeAssignments(C312, [card("Past due", "keep me", "p0000001")], ["Past due"], "2026-10-01T00:00:00Z");

  const res = await handleMessage({ type: "TP_ASSIGNMENTS", scope: "all-classes", okTabs: [], assignments: [],
    report: report("failed", ["Upcoming", "Past due", "Completed"].map((t) => tabRep(t, "timeout", "list-not-loaded"))),
  }, SENDER, deps);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.stored, false);
  assert.deepStrictEqual((await store.getState()).classes[C312].assignments.map((a) => a.title), ["keep me"]);
  const rep = backend._raw[KEY_CAPTURE_REPORT];
  assert.strictEqual(rep.status, "failed");
  assert.strictEqual(rep.background.accepted, true);
  assert.match(rep.background.reason, /stored assignments kept/);
  assert.strictEqual(rep.tabs.length, 3);
});

test("all-classes: a stored class absent from the batch is cleared only when all tabs were ok", async () => {
  const { store, deps, seeClass } = setup();
  for (const c of [C304, C312]) await seeClass(c);
  await store.mergeAssignments(C304, [card("Past due", "wrongly filed", "p0000002")], ["Past due"], "2026-10-01T00:00:00Z");
  const batch = { type: "TP_ASSIGNMENTS", scope: "all-classes", assignments: [card("Past due", "x", "p0000003", { className: C312 })] };

  await handleMessage({ ...batch, okTabs: ["Past due", "Completed"] }, SENDER, deps);
  assert.strictEqual((await store.getState()).classes[C304].assignments.length, 1, "partial capture must not clear");

  await handleMessage({ ...batch, okTabs: ["Upcoming", "Past due", "Completed"] }, SENDER, deps);
  assert.strictEqual((await store.getState()).classes[C304].assignments.length, 0, "full capture clears");
});

// ── Class attribution (H7) ──────────────────────────────────────────────────

test("per-card class beats tab context; card of an unvisited (old/hidden) class is dropped", async () => {
  const { store, backend, deps, session, seeClass } = setup();
  await seeClass(C204);
  await seeClass(C304); // the class whose tab is open
  assert.strictEqual(await session.get(tabCtxKey(9)), C304);

  const res = await handleMessage({ type: "TP_ASSIGNMENTS", scope: "class", okTabs: ["Upcoming", "Past due", "Completed"],
    assignments: [
      card("Past due", "Lab Report (Experiment 5)", "a0000001", { className: "CSE 204  (Digital Logic Design DLD Lab)" }),
      card("Past due", "Mystery", "a0000002", { className: "Some Other Team" }),
      card("Upcoming", "No class line", "a0000003"),
    ] }, SENDER, deps);
  assert.strictEqual(res.ok, true, res.reason);
  const st = (await store.getState()).classes;
  assert.deepStrictEqual(st[C204].assignments.map((a) => a.title), ["Lab Report (Experiment 5)"]);
  assert.deepStrictEqual(st[C304].assignments.map((a) => a.title), ["No class line"]);
  assert.ok(!st.Unmatched || st.Unmatched.assignments.length === 0, "no Unmatched bucket");
  assert.ok(!JSON.stringify(st).includes("Mystery"), "old/hidden class card not stored");
  const rep = backend._raw[KEY_CAPTURE_REPORT];
  assert.strictEqual(rep.background.droppedUnknownClass, 1);
  assert.strictEqual(rep.background.health, "ok");
});

test("capture report is sanitized: no titles or class names survive", async () => {
  const { backend, deps, seeClass } = setup();
  await seeClass(C312);
  const r = report("ok", [{ ...tabRep("Past due", "ok"), reason: "<b>Secret Title</b>", extra: C312 }]);
  r.reason = "CSE 312 Lab Report-03 <x>";
  r.title = "Secret Title";
  await handleMessage({ type: "TP_ASSIGNMENTS", scope: "all-classes", okTabs: ["Past due"],
    assignments: [card("Past due", "Secret Title", "p0000004", { className: C312 })], report: r }, SENDER, deps);
  const json = JSON.stringify(backend._raw[KEY_CAPTURE_REPORT]);
  assert.ok(!json.includes("Secret Title") && !json.includes("CSE 312") && !json.includes("<"), json);
});

test("a 'deferred' report (hidden frame) does not replace a recent good report", async () => {
  const { backend, deps, seeClass } = setup();
  await seeClass(C312);
  await handleMessage({ type: "TP_ASSIGNMENTS", scope: "all-classes", okTabs: ["Past due"],
    assignments: [card("Past due", "a", "p0000005", { className: C312 })], report: report("partial", [tabRep("Past due", "ok")]) }, SENDER, deps);
  await handleMessage({ type: "TP_ASSIGNMENTS", scope: "all-classes", okTabs: [], assignments: [],
    report: { ...report("deferred", []), reason: "frame-not-rendered" } }, SENDER, deps);
  assert.strictEqual(backend._raw[KEY_CAPTURE_REPORT].status, "partial");
});

test("rejected batch is still reported with the reason", async () => {
  const { backend, deps } = setup();
  const res = await handleMessage({ type: "TP_ASSIGNMENTS", scope: "class", okTabs: ["Upcoming"],
    assignments: [card("Upcoming", "x", "u0000001")], report: report("ok", []) }, SENDER, deps);
  assert.strictEqual(res.ok, false);
  const rep = backend._raw[KEY_CAPTURE_REPORT];
  assert.strictEqual(rep.background.accepted, false);
  assert.match(rep.background.reason, /class context/);
});

// ── End-to-end hop trace (H4, H9) ───────────────────────────────────────────

test("trace: payload → messages → store → buildDigest → ics, nothing lost or mislabelled", async () => {
  const { store, deps, seeClass } = setup();
  for (const c of [C204, C312]) await seeClass(c);
  // What the fixed content script sends for the evidence case (ids unique per tab).
  const assignments = [
    card("Past due", "Lab Report (Experiment 5)", "e0000001", { className: C204, dueDate: "2026-03-15", dueRaw: "Mar 15th Due at 11:59 PM" }),
    card("Past due", "Project Submission", "e0000002", { className: C312, dueDate: "2026-08-31", dueRaw: "Aug 31st Due at 11:59 PM" }),
    card("Upcoming", "Final Project", "e0000003", { className: C312, dueDate: "2027-01-05", dueRaw: "Jan 5th Due at 9:00 AM", details: "Due at 9:00 AM" }),
    card("Completed", "Quiz-1", "e0000004", { className: C204, dueDate: "2026-09-05" }),
  ];
  const res = await handleMessage({ type: "TP_ASSIGNMENTS", scope: "all-classes",
    okTabs: ["Upcoming", "Past due", "Completed"], assignments, report: report("ok", []) }, SENDER, deps);
  assert.strictEqual(res.ok, true, res.reason);

  const state = await store.getState();
  assert.strictEqual(state.classes[C204].assignments.length + state.classes[C312].assignments.length, 4, "store hop");

  const digest = buildDigest(state, { nowMs: TODAY.getTime() });
  const shown = digest.classes.flatMap((c) => c.assignments.map((a) => `${c.rawClassName}|${a.tab}|${a.title}|${a.dueDate}`)).sort();
  assert.deepStrictEqual(shown, [
    `${C204}|Past due|Lab Report (Experiment 5)|2026-03-15`,
    `${C312}|Past due|Project Submission|2026-08-31`,
    `${C312}|Upcoming|Final Project|2027-01-05`,
  ], "digest shows Upcoming + Past due under each card's own class (Completed is stored, not shown)");

  const { ics, exported } = buildIcs(digest, TODAY.getTime());
  assert.strictEqual(exported, 3);
  const uids = ics.match(/^UID:.*$/gm);
  assert.strictEqual(new Set(uids).size, uids.length, "no duplicate events");
  assert.ok(!/DTSTART:2027(03|08)/.test(ics), "no year-shifted past-due dates");
});

test("ics: DESCRIPTION keeps the due time apart from the class name (older glued data)", () => {
  const digest = { classes: [{ displayName: "CSE 304", rawClassName: C304, assignments: [
    { title: "Lab", tab: "Past due", details: "Due at 11:59 PMCSE 204 (Digital Logic Design DLD Lab)", dueIso: "2026-03-15T17:59:00.000Z" },
  ] }] };
  const { ics } = buildIcs(digest, TODAY.getTime());
  const desc = ics.replace(/\r\n /g, "").match(/^DESCRIPTION:.*$/m)[0];
  assert.match(desc, /Due at 11:59 PM · CSE 204/);
});

test("shape keeps only the canonical tab labels the content script emits (H4)", async () => {
  const { store, deps, seeClass } = setup();
  await seeClass(C312);
  await handleMessage({ type: "TP_ASSIGNMENTS", scope: "all-classes", okTabs: ["Past due"],
    assignments: [card("Past due", "a", "p0000006", { className: C312 })] }, SENDER, deps);
  const digest = buildDigest(await store.getState(), { nowMs: TODAY.getTime() });
  assert.strictEqual(digest.classes[0].assignments[0].tab, "Past due");
  // A non-canonical label (e.g. "Overdue") would be dropped by shape: the
  // content script only ever emits TABS, and okTabs filters to them.
  const { TABS } = require("../extension/content/assignments-frame");
  assert.deepStrictEqual(TABS, ["Upcoming", "Past due", "Completed"]);
});
