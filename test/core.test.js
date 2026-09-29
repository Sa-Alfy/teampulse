"use strict";

/**
 * test/core.test.js — Phase 1 tests for extension/core modules.
 *
 * Coverage:
 *   - fingerprint parity: async hashPost === db.hashPost on 4+ sample posts
 *   - dedup: second ingest of same posts -> new=0
 *   - filtered-out post is not burned as seen
 *   - in-batch duplicate counted once
 *   - concurrent ingests lose nothing
 *   - shape: required keys present
 *   - shape: newHours clamped
 *   - shape: health stale after 36h
 *   - shape: assignments sorted ascending by due date
 */

const test   = require("node:test");
const assert = require("node:assert");

const { hashPost: dbHashPost } = require("../db");
const {
  fingerprintString,
  sha256Hex,
  hashPost: fpHashPost,
} = require("../extension/core/fingerprint");
const { createStore, memoryBackend, chromeBackend } = require("../extension/core/store");
const { isNoteworthy } = require("../extension/core/digest-utils");
const {
  clampHours,
  computeHealth,
  buildDigest,
  buildStatus,
  compareAssignments,
  transformAssignment,
  NEW_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
} = require("../extension/core/shape");

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const CLASS_V1 = "Summer_2026_CSE 312 (V1)_232_D4";
const CLASS_V2 = "Summer_2026_CSE 312 (V2)_232_D9";

const SAMPLE_POSTS = [
  { author: "Dr. Theory", subject: "CT-2 Schedule",    body: "Details in the attached file.", timestampIso: "2026-08-29T11:20:00.000Z" },
  { author: "Dr. Theory", subject: "CT-2 Room Change", body: "Details in the attached file.", timestampIso: "2026-08-29T11:20:00.000Z" },
  { author: "Dr. Lab",    subject: "CT-2 Schedule",    body: "Details in the attached file.", timestampIso: "2026-08-29T11:20:00.000Z" },
  { author: "Dr. Theory", subject: "CT-2 Schedule",    body: "Bring your own laptop.",        timestampIso: "2026-08-29T11:20:00.000Z" },
];

// Simple isNoteworthy stub: noteworthy if post has a subject or body keyword
function isNoteworthyStub(post) {
  if (!post || !post.subject && !post.body) return false;
  if (post.body === "Loading...") return false;
  return true;
}

// Async hash adapter for store (wraps fpHashPost)
const hashFn = (className, post) => fpHashPost(className, post);

// ---------------------------------------------------------------------------
// 1. Fingerprint parity
// ---------------------------------------------------------------------------

test("fingerprint: async hashPost matches db.hashPost on 4+ sample posts", async () => {
  for (const post of SAMPLE_POSTS) {
    const syncHash  = dbHashPost(CLASS_V1, post);
    const asyncHash = await fpHashPost(CLASS_V1, post);
    assert.strictEqual(asyncHash, syncHash, `Mismatch for subject="${post.subject}", author="${post.author}"`);
  }
});

test("fingerprint: fingerprintString produces the same raw string across classes", () => {
  const post = SAMPLE_POSTS[0];
  const raw1 = fingerprintString(CLASS_V1, post);
  const raw2 = fingerprintString(CLASS_V2, post);
  assert.notStrictEqual(raw1, raw2);
  assert.ok(raw1.startsWith(CLASS_V1 + "\0"), "Should start with className + NUL");
});

test("fingerprint: sha256Hex returns 64-char lowercase hex", async () => {
  const h = await sha256Hex("hello world");
  assert.strictEqual(h.length, 64);
  assert.match(h, /^[0-9a-f]+$/);
});

test("fingerprint: body cap at 500 chars — hashes with same 500-char prefix are equal", async () => {
  const longBase = "x".repeat(500);
  const a = await fpHashPost(CLASS_V1, { ...SAMPLE_POSTS[0], body: longBase + "AAAA" });
  const b = await fpHashPost(CLASS_V1, { ...SAMPLE_POSTS[0], body: longBase + "BBBB" });
  assert.strictEqual(a, b);
});

// ---------------------------------------------------------------------------
// 2. Store: dedup — second ingest of same posts -> new=0
// ---------------------------------------------------------------------------

test("store: second ingest of same posts returns new=0", async () => {
  const store  = createStore(memoryBackend());
  const nowIso = new Date().toISOString();

  const first = await store.ingestPosts(CLASS_V1, SAMPLE_POSTS, nowIso, hashFn, isNoteworthyStub);
  assert.ok(first.new > 0, "First ingest should have new posts");

  const second = await store.ingestPosts(CLASS_V1, SAMPLE_POSTS, nowIso, hashFn, isNoteworthyStub);
  assert.strictEqual(second.new, 0, "Second ingest of same posts should have new=0");
  assert.strictEqual(second.alreadySeen, first.new, "All prior new posts now alreadySeen");
});

// ---------------------------------------------------------------------------
// 3. Store: filtered-out post is NOT burned as seen
// ---------------------------------------------------------------------------

test("store: filtered-out post is not burned — still surfaces after classifier improves", async () => {
  const store   = createStore(memoryBackend());
  const nowIso  = new Date().toISOString();
  const boring  = [{ author: "Bot", subject: "", body: "Good morning!", timestampIso: "2026-09-01T08:00:00Z" }];

  // isNoteworthy returns false for this post
  const neverNoteworthy = () => false;
  const res1 = await store.ingestPosts(CLASS_V1, boring, nowIso, hashFn, neverNoteworthy);
  assert.strictEqual(res1.filteredOut, 1);
  assert.strictEqual(res1.new, 0);

  // Now the classifier improves — same post should appear as new
  const alwaysNoteworthy = () => true;
  const res2 = await store.ingestPosts(CLASS_V1, boring, nowIso, hashFn, alwaysNoteworthy);
  assert.strictEqual(res2.new, 1, "Post should now be new after classifier improvement");
});

// ---------------------------------------------------------------------------
// 4. Store: in-batch duplicate counted once
// ---------------------------------------------------------------------------

test("store: duplicate post in same batch is counted only once", async () => {
  const store  = createStore(memoryBackend());
  const nowIso = new Date().toISOString();

  const post      = SAMPLE_POSTS[0];
  const batchWith2 = [post, { ...post }]; // two references to same logical post

  const res = await store.ingestPosts(CLASS_V1, batchWith2, nowIso, hashFn, isNoteworthyStub);
  assert.strictEqual(res.new, 1, "In-batch duplicate should be counted once");
  assert.strictEqual(res.scanned, 2);
});

// ---------------------------------------------------------------------------
// 5. Store: concurrent ingests lose nothing
// ---------------------------------------------------------------------------

test("store: concurrent ingests for different classes lose nothing", async () => {
  const store  = createStore(memoryBackend());
  const nowIso = new Date().toISOString();

  // Run two ingests concurrently — promise queue must serialise writes
  const [r1, r2] = await Promise.all([
    store.ingestPosts(CLASS_V1, SAMPLE_POSTS, nowIso, hashFn, isNoteworthyStub),
    store.ingestPosts(CLASS_V2, SAMPLE_POSTS, nowIso, hashFn, isNoteworthyStub),
  ]);

  assert.ok(r1.new > 0, "Class V1 should have new posts");
  assert.ok(r2.new > 0, "Class V2 should have new posts");

  // Run again — both classes should now have new=0
  const [r3, r4] = await Promise.all([
    store.ingestPosts(CLASS_V1, SAMPLE_POSTS, nowIso, hashFn, isNoteworthyStub),
    store.ingestPosts(CLASS_V2, SAMPLE_POSTS, nowIso, hashFn, isNoteworthyStub),
  ]);
  assert.strictEqual(r3.new, 0);
  assert.strictEqual(r4.new, 0);
});

// ---------------------------------------------------------------------------
// 6. Shape: buildDigest — required keys present
// ---------------------------------------------------------------------------

test("shape: buildDigest returns required top-level keys when no data", () => {
  const result = buildDigest({});
  assert.ok("generatedAt"     in result, "generatedAt missing");
  assert.ok("newWindowHours"  in result, "newWindowHours missing");
  assert.ok("newPostCount"    in result, "newPostCount missing");
  assert.ok("classes"         in result, "classes missing");
  assert.strictEqual(result.noDataYet, true);
});

test("shape: buildDigest class entry has required fields", () => {
  const nowMs = Date.now();
  const recentIso = new Date(nowMs - 1000).toISOString();

  const state = {
    seenHashes: {
      "fakehash": { seenAt: recentIso, surfaced: true },
    },
    classes: {
      [CLASS_V1]: {
        posts: {
          "fakehash": {
            surfaced: true,
            post: {
              author: "Dr. Theory",
              subject: "CT-2 due friday",
              body: "CT next week",
              isAnnouncement: true,
              timestampIso: recentIso,
            },
          },
        },
        assignments: [],
        lastSync: recentIso,
      },
    },
  };

  const result = buildDigest(state, { nowMs });
  assert.ok(result.classes.length > 0, "Should have at least one class");

  const cls = result.classes[0];
  assert.ok("key"              in cls, "key missing");
  assert.ok("className"        in cls, "className missing");
  assert.ok("displayName"      in cls, "displayName missing");
  assert.ok("rawClassName"     in cls, "rawClassName missing");
  assert.ok("noticesCount"     in cls, "noticesCount missing");
  assert.ok("assignmentsCount" in cls, "assignmentsCount missing");
  assert.ok("notices"          in cls, "notices missing");
  assert.ok("assignments"      in cls, "assignments missing");

  if (cls.notices.length > 0) {
    const n = cls.notices[0];
    assert.ok("tag"             in n, "notice.tag missing");
    assert.ok("summary"         in n, "notice.summary missing");
    assert.ok("isNew"           in n, "notice.isNew missing");
    assert.ok("author"          in n, "notice.author missing");
    assert.ok("timestampIso"    in n, "notice.timestampIso missing");
    assert.ok("className"       in n, "notice.className missing");
    assert.ok("rawClassName"    in n, "notice.rawClassName missing");
  }
});

// ---------------------------------------------------------------------------
// 7. Shape: newHours clamped
// ---------------------------------------------------------------------------

test("shape: newHours is clamped to [1, MAX_WINDOW_HOURS]", () => {
  assert.strictEqual(clampHours(0,   NEW_WINDOW_HOURS), 1);
  assert.strictEqual(clampHours(-5,  NEW_WINDOW_HOURS), 1);
  assert.strictEqual(clampHours(999, NEW_WINDOW_HOURS), MAX_WINDOW_HOURS);
  assert.strictEqual(clampHours(48,  NEW_WINDOW_HOURS), 48);
  assert.strictEqual(clampHours("x", NEW_WINDOW_HOURS), NEW_WINDOW_HOURS);
});

// ---------------------------------------------------------------------------
// 8. Shape: health stale after 36h
// ---------------------------------------------------------------------------

test("shape: health is stale when lastScrape is older than 36h", () => {
  const nowMs   = Date.now();
  const fresh   = new Date(nowMs - 10 * 3600e3).toISOString();  // 10h ago
  const stale36 = new Date(nowMs - 37 * 3600e3).toISOString(); // 37h ago

  assert.strictEqual(computeHealth(fresh, nowMs),   "ok");
  assert.strictEqual(computeHealth(stale36, nowMs), "stale");
  assert.strictEqual(computeHealth(null, nowMs),    "stale");
  assert.strictEqual(computeHealth("bad-date", nowMs), "stale");
});

// ---------------------------------------------------------------------------
// 9. Shape: assignments sorted ascending by due date
// (Non-duplicate of assignment-sort.test.js — tests shape.js's own
//  transformAssignment + compareAssignments via buildDigest state)
// ---------------------------------------------------------------------------

test("shape: buildDigest assignments are sorted ascending by due date", () => {
  const nowMs    = Date.now();
  const syncIso  = new Date(nowMs - 100).toISOString();

  const rawAssignments = [
    { tab: "Upcoming", title: "No date",  details: "Module: KSA" },
    { tab: "Upcoming", title: "Later",    details: "Due Oct 10" },
    { tab: "Upcoming", title: "Earlier",  details: "Due Sep 15" },
  ];

  const state = {
    seenHashes: {},
    classes: {
      [CLASS_V1]: {
        posts: {},
        assignments: rawAssignments,
        lastSync: syncIso,
      },
    },
  };

  const result = buildDigest(state, { nowMs });
  assert.strictEqual(result.classes.length, 1);
  const sorted = result.classes[0].assignments;
  assert.ok(sorted.length >= 2, "Should have assignments");

  // Find titled items
  const idx = (title) => sorted.findIndex((a) => a.title === title);
  const iEarlier = idx("Earlier");
  const iLater   = idx("Later");
  const iNoDate  = idx("No date");

  assert.ok(iEarlier >= 0 && iLater >= 0, "Earlier and Later should both be present");
  assert.ok(iEarlier < iLater, `Earlier (${iEarlier}) should precede Later (${iLater})`);
  if (iNoDate >= 0) {
    assert.ok(iNoDate > iLater, "Undated should be last");
  }
});

// ---------------------------------------------------------------------------
// 10. Shape: buildStatus returns required keys
// ---------------------------------------------------------------------------

test("shape: buildStatus returns required keys when no data", () => {
  const result = buildStatus({}, Date.now());
  assert.ok("ok"           in result, "ok missing");
  assert.ok("health"       in result, "health missing");
  assert.ok("totalSeen"    in result, "totalSeen missing");
  assert.ok("totalRecorded" in result, "totalRecorded missing");
  assert.ok("lastRun"      in result, "lastRun missing");
  assert.ok("lastScrape"   in result, "lastScrape missing");
  assert.ok("serverTime"   in result, "serverTime missing");
  assert.strictEqual(result.noDataYet, true);
});

// ---------------------------------------------------------------------------
// 11. Store: getState() returns full state for multiple classes
// ---------------------------------------------------------------------------

test("store: getState() returns full state for multiple classes", async () => {
  const store = createStore(memoryBackend());
  const nowIso = new Date().toISOString();

  await store.ingestPosts("Class A", [SAMPLE_POSTS[0]], nowIso, hashFn, isNoteworthyStub);
  await store.ingestAssignments("Class B", [{ tab: "Upcoming", title: "HW1" }], nowIso);

  const state = await store.getState();
  assert.ok("seenHashes" in state, "seenHashes missing from getState");
  assert.ok("classes" in state, "classes missing from getState");
  assert.ok("Class A" in state.classes, "Class A missing from state.classes");
  assert.ok("Class B" in state.classes, "Class B missing from state.classes");

  assert.strictEqual(state.classes["Class A"].lastSync, nowIso);
  assert.ok(Object.keys(state.classes["Class A"].posts).length > 0, "Class A posts should not be empty");
  assert.deepStrictEqual(state.classes["Class A"].assignments, []);

  assert.strictEqual(state.classes["Class B"].lastSync, nowIso);
  assert.strictEqual(state.classes["Class B"].assignments.length, 1);
  assert.deepStrictEqual(state.classes["Class B"].posts, {});
});

// ---------------------------------------------------------------------------
// 12. Integration: ingest noteworthy post -> getState -> buildDigest & buildStatus
// ---------------------------------------------------------------------------

test("integration: ingest noteworthy post -> getState -> buildDigest has newPostCount 1 & isNew, buildStatus has totalSeen 1", async () => {
  const store = createStore(memoryBackend());
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const post = {
    author: "Prof. Smith",
    subject: "CT-1 Announcement",
    body: "CT-1 will be held on 2026-10-15.",
    isAnnouncement: true,
    timestampIso: nowIso,
  };

  await store.ingestPosts("CSE 101", [post], nowIso, hashFn, isNoteworthy);

  const state = await store.getState();
  const digest = buildDigest(state, { nowMs });
  const status = buildStatus(state, nowMs);

  assert.strictEqual(digest.newPostCount, 1, `Expected newPostCount 1, got ${digest.newPostCount}`);
  assert.strictEqual(digest.classes.length, 1, `Expected 1 class in digest, got ${digest.classes.length}`);
  assert.strictEqual(digest.classes[0].notices.length, 1, `Expected 1 notice in class, got ${digest.classes[0].notices.length}`);
  assert.strictEqual(digest.classes[0].notices[0].isNew, true, "Notice should be flagged isNew: true");
  assert.strictEqual(status.totalSeen, 1, `Expected totalSeen 1, got ${status.totalSeen}`);
});

// ---------------------------------------------------------------------------
// 13. Store: clearAll() resets state and buildDigest reports noDataYet
// ---------------------------------------------------------------------------

test("store: after clearAll(), getState() is empty and buildDigest reports noDataYet", async () => {
  const store = createStore(memoryBackend());
  const nowIso = new Date().toISOString();

  await store.ingestPosts("Class A", [SAMPLE_POSTS[0]], nowIso, hashFn, isNoteworthyStub);
  await store.ingestAssignments("Class B", [{ tab: "Upcoming", title: "HW1" }], nowIso);

  await store.clearAll();

  const state = await store.getState();
  assert.deepStrictEqual(state.classes, {});
  assert.deepStrictEqual(state.seenHashes, {});

  const digest = buildDigest(state);
  assert.strictEqual(digest.noDataYet, true);
  assert.strictEqual(digest.classes.length, 0);
});

// ---------------------------------------------------------------------------
// 14. Store: chromeBackend clearAll removes only tp:v1:* keys
// ---------------------------------------------------------------------------

test("store: chromeBackend clearAll with fake chrome.storage.local removes only tp:v1:* keys", async () => {
  const fakeStorage = {
    "other_app_key": "preserve_me",
    "collapsedClasses": { "CSE 101": true },
    "tp:v1:seen-hashes": { "abc": { seenAt: "2026-09-30T00:00:00Z", surfaced: true } },
    "tp:v1:class-index": ["CSE 101"],
    "tp:v1:posts:CSE 101": { "abc": {} },
    "tp:v1:assignments:CSE 101": [],
    "tp:v1:last-sync:CSE 101": "2026-09-30T00:00:00Z",
  };

  const originalChrome = globalThis.chrome;
  try {
    globalThis.chrome = {
      runtime: {},
      storage: {
        local: {
          get(keys, cb) {
            if (keys === null) {
              cb({ ...fakeStorage });
            } else {
              const res = {};
              for (const k of keys) {
                if (k in fakeStorage) res[k] = fakeStorage[k];
              }
              cb(res);
            }
          },
          set(obj, cb) {
            Object.assign(fakeStorage, obj);
            cb();
          },
          remove(keys, cb) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) {
              delete fakeStorage[k];
            }
            cb();
          },
          clear() {
            throw new Error("clear() must never be called");
          },
        },
      },
    };

    const store = createStore(chromeBackend());
    await store.clearAll();

    assert.strictEqual(fakeStorage["other_app_key"], "preserve_me");
    assert.deepStrictEqual(fakeStorage["collapsedClasses"], { "CSE 101": true });
    assert.strictEqual("tp:v1:seen-hashes" in fakeStorage, false);
    assert.strictEqual("tp:v1:class-index" in fakeStorage, false);
    assert.strictEqual("tp:v1:posts:CSE 101" in fakeStorage, false);
    assert.strictEqual("tp:v1:assignments:CSE 101" in fakeStorage, false);
    assert.strictEqual("tp:v1:last-sync:CSE 101" in fakeStorage, false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

