"use strict";

/**
 * test/messages.test.js — Phase 2 unit tests for extension/core/messages.js.
 *
 * Uses memory backends (no chrome APIs). Runs under `node --test`.
 *
 * Coverage:
 *   (a) valid posts ingested successfully
 *   (b) wrong origin rejected for TP_POSTS, TP_CLASS_CONTEXT, and TP_ASSIGNMENTS
 *   (c) oversize className, posts, assignments, and string fields rejected
 *   (d) TP_ASSIGNMENTS without context dropped
 *   (e) TP_ASSIGNMENTS with context lands under the right class
 */

const test   = require("node:test");
const assert = require("node:assert");

// Ensure globalThis.TP has hashPost and isNoteworthy for tests
const { hashPost }     = require("../extension/core/fingerprint");
const { isNoteworthy } = require("../extension/core/digest-utils");
const { createStore, memoryBackend } = require("../extension/core/store");

globalThis.TP = Object.assign(globalThis.TP || {}, {
  hashPost,
  isNoteworthy,
});

const { handleMessage, tabCtxKey } = require("../extension/core/messages");

// ── Factories ─────────────────────────────────────────────────────────────

function makeStore() {
  return createStore(memoryBackend());
}

function makeSession() {
  const _data = {};
  return {
    get(key)        { return Promise.resolve(_data[key] ?? null); },
    set(key, value) { _data[key] = value; return Promise.resolve(); },
    remove(key)     { delete _data[key]; return Promise.resolve(); },
    _raw: _data,
  };
}

function makeDeps(overrides = {}) {
  return {
    store:   overrides.store   ?? makeStore(),
    session: overrides.session ?? makeSession(),
    nowIso:  overrides.nowIso  ?? (() => "2026-09-30T10:00:00.000Z"),
  };
}

const VALID_POST = {
  author:        "Prof. Smith",
  isBot:         false,
  isAnnouncement: true,
  subject:       "CT-2 Announcement",
  timestamp:     "Mon 3:00 PM",
  timestampFull: "Monday, August 29, 2026 3:00 PM",
  timestampIso:  "2026-08-29T09:00:00.000Z",
  body:          "CT-2 will be held on 2026-10-10.",
  attachments:   [],
  urlPreviews:   [],
  replyCount:    0,
  replies:       [],
};

function teamsSender(tabId = 1, url = "https://teams.microsoft.com/v2/") {
  return { id: "test-ext-id", tab: { id: tabId }, url };
}

function teamsCloudSender(tabId = 1, url = "https://teams.cloud.microsoft/v2/") {
  return { id: "test-ext-id", tab: { id: tabId }, url };
}

function assignSender(tabId = 1, url = "https://assignments.edu.cloud.microsoft/class/123") {
  return { id: "test-ext-id", tab: { id: tabId }, url };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("messages: valid TP_CLASS_CONTEXT saves className in session (teams.microsoft.com)", async () => {
  const session = makeSession();
  const deps    = makeDeps({ session });
  const sender  = teamsSender(42);

  const result = await handleMessage(
    { type: "TP_CLASS_CONTEXT", className: "Summer_2026_CSE 312 (V1)" },
    sender,
    deps
  );

  assert.strictEqual(result.ok, true);
  const saved = await session.get(tabCtxKey(42));
  assert.strictEqual(saved, "Summer_2026_CSE 312 (V1)");
});

test("messages: valid TP_CLASS_CONTEXT accepts teams.cloud.microsoft (flagged unverified origin)", async () => {
  const session = makeSession();
  const deps    = makeDeps({ session });
  const sender  = teamsCloudSender(99);

  const result = await handleMessage(
    { type: "TP_CLASS_CONTEXT", className: "CSE 312" },
    sender,
    deps
  );

  assert.strictEqual(result.ok, true);
  const saved = await session.get(tabCtxKey(99));
  assert.strictEqual(saved, "CSE 312");
});

test("messages: valid TP_POSTS ingested into store and returns ok", async () => {
  const store   = makeStore();
  const session = makeSession();
  const deps    = makeDeps({ store, session });
  const tabId   = 5;

  await handleMessage(
    { type: "TP_CLASS_CONTEXT", className: "CSE 101" },
    teamsSender(tabId),
    deps
  );

  const result = await handleMessage(
    { type: "TP_POSTS", className: "CSE 101", posts: [VALID_POST], scrapedAt: "2026-09-30T10:00:00.000Z" },
    teamsSender(tabId),
    deps
  );

  assert.strictEqual(result.ok, true);

  const state = await store.getState();
  assert.ok("CSE 101" in state.classes, "class should appear in store");
  const posts = Object.values(state.classes["CSE 101"].posts);
  assert.strictEqual(posts.length, 1, "store should contain the ingested post");
});

test("messages: wrong origin rejected for TP_POSTS and TP_CLASS_CONTEXT", async () => {
  const deps   = makeDeps();
  const badSender = { tab: { id: 1 }, url: "https://attacker.com/teams" };

  const r1 = await handleMessage(
    { type: "TP_CLASS_CONTEXT", className: "CSE 101" },
    badSender,
    deps
  );
  assert.strictEqual(r1.ok, false);
  assert.match(r1.reason, /disallowed origin/);

  const r2 = await handleMessage(
    { type: "TP_POSTS", className: "CSE 101", posts: [VALID_POST] },
    badSender,
    deps
  );
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /disallowed origin/);
});

test("messages: wrong origin rejected for TP_ASSIGNMENTS", async () => {
  const deps   = makeDeps();
  const r = await handleMessage(
    { type: "TP_ASSIGNMENTS", assignments: [] },
    teamsSender(1),
    deps
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /disallowed origin/);
});

test("messages: oversize className (>200 chars) rejected", async () => {
  const deps = makeDeps();
  const longName = "A".repeat(201);

  const r1 = await handleMessage(
    { type: "TP_CLASS_CONTEXT", className: longName },
    teamsSender(1),
    deps
  );
  assert.strictEqual(r1.ok, false);
  assert.match(r1.reason, /200/);

  const r2 = await handleMessage(
    { type: "TP_POSTS", className: longName, posts: [] },
    teamsSender(1),
    deps
  );
  assert.strictEqual(r2.ok, false);
});

test("messages: posts array > 500 items rejected", async () => {
  const deps    = makeDeps();
  const bigList = Array.from({ length: 501 }, () => ({ ...VALID_POST }));
  const result  = await handleMessage(
    { type: "TP_POSTS", className: "CSE 101", posts: bigList },
    teamsSender(1),
    deps
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /500/);
});

test("messages: assignments array > 300 items rejected", async () => {
  const session = makeSession();
  const deps    = makeDeps({ session });
  await session.set(tabCtxKey(1), "CSE 101");

  const bigList = Array.from({ length: 301 }, () => ({ tab: "Upcoming", title: "HW" }));
  const result  = await handleMessage(
    { type: "TP_ASSIGNMENTS", assignments: bigList },
    assignSender(1),
    deps
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /300/);
});

test("messages: string field > 20,000 chars rejected", async () => {
  const deps = makeDeps();
  const hugeBodyPost = {
    ...VALID_POST,
    body: "x".repeat(20_001),
  };

  const result = await handleMessage(
    { type: "TP_POSTS", className: "CSE 101", posts: [hugeBodyPost] },
    teamsSender(1),
    deps
  );
  assert.strictEqual(result.ok, false);
});

test("messages: TP_ASSIGNMENTS without prior class context is dropped", async () => {
  const deps   = makeDeps();
  const result = await handleMessage(
    { type: "TP_ASSIGNMENTS", assignments: [{ tab: "Upcoming", title: "HW1" }] },
    assignSender(99),
    deps
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /no class context/);
});

test("messages: TP_ASSIGNMENTS with context lands under correct class in store", async () => {
  const store   = makeStore();
  const session = makeSession();
  const deps    = makeDeps({ store, session });
  const tabId   = 7;

  await handleMessage(
    { type: "TP_CLASS_CONTEXT", className: "Summer_2026_CSE 312 (V1)" },
    teamsSender(tabId),
    deps
  );

  const assignments = [
    { tab: "Upcoming",  title: "Lab 3",   details: "Due Sep 30", dueRaw: null, dueDate: null, status: "Not submitted" },
    { tab: "Past due",  title: "HW-1",    details: "Due Sep 10", dueRaw: null, dueDate: null, status: "Overdue" },
    { tab: "Completed", title: "Quiz-1",  details: "Sep 5",      dueRaw: null, dueDate: null, status: "Turned in" },
  ];

  const result = await handleMessage(
    { type: "TP_ASSIGNMENTS", assignments },
    assignSender(tabId),
    deps
  );

  assert.strictEqual(result.ok, true);

  const state = await store.getState();
  assert.ok("Summer_2026_CSE 312 (V1)" in state.classes, "class should be in store");
  const stored = state.classes["Summer_2026_CSE 312 (V1)"].assignments;
  assert.strictEqual(stored.length, 3, "all 3 assignments should be stored");
  assert.strictEqual(stored[0].title, "Lab 3");
  assert.strictEqual(stored[1].tab,   "Past due");
  assert.strictEqual(stored[2].title, "Quiz-1");
});

test("messages: missing sender tab or missing type rejected", async () => {
  const deps = makeDeps();

  const r1 = await handleMessage({}, teamsSender(1), deps);
  assert.strictEqual(r1.ok, false);

  const r2 = await handleMessage(
    { type: "TP_CLASS_CONTEXT", className: "CSE 101" },
    { url: "https://teams.microsoft.com/" },
    deps
  );
  assert.strictEqual(r2.ok, false);

  const r3 = await handleMessage(
    { type: "UNKNOWN" },
    teamsSender(1),
    deps
  );
  assert.strictEqual(r3.ok, false);
});
