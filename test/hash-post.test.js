"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { hashPost } = require("../db");

const base = {
  author: "Dr. Theory",
  subject: "CT-2 Schedule",
  body: "Details in the attached file.",
  timestampIso: "2026-08-29T11:20:00.000Z",
};

const CLASS_V1 = "Summer_2026_CSE 312 (V1)_232_D4";
const CLASS_V2 = "Summer_2026_CSE 312 (V2)_232_D9";

test("hashPost: identical posts hash identically", () => {
  assert.strictEqual(hashPost(CLASS_V1, { ...base }), hashPost(CLASS_V1, { ...base }));
});

test("hashPost: subject is part of the fingerprint", () => {
  // Same class, same minute, same body — different subject line. These are two
  // posts; a tuple that omits subject collapses them and INSERT drops one.
  const a = hashPost(CLASS_V1, { ...base, subject: "CT-2 Schedule" });
  const b = hashPost(CLASS_V1, { ...base, subject: "CT-3 Schedule" });
  assert.notStrictEqual(a, b);
});

test("hashPost: author is part of the fingerprint", () => {
  const a = hashPost(CLASS_V1, { ...base, author: "Dr. Theory" });
  const b = hashPost(CLASS_V1, { ...base, author: "Dr. Lab" });
  assert.notStrictEqual(a, b);
});

test("hashPost: class sections do not collide", () => {
  assert.notStrictEqual(hashPost(CLASS_V1, { ...base }), hashPost(CLASS_V2, { ...base }));
});

test("hashPost: four distinct posts produce four distinct hashes", () => {
  // The finding-3 fixture: under the old className+timestamp+body tuple these
  // four collapsed to three, and the fourth was suppressed forever.
  const posts = [
    { ...base, subject: "CT-2 Schedule" },
    { ...base, subject: "CT-2 Room Change" },
    { ...base, subject: "CT-2 Schedule", author: "Dr. Lab" },
    { ...base, subject: "CT-2 Schedule", body: "Bring your own laptop." },
  ];
  const hashes = new Set(posts.map((p) => hashPost(CLASS_V1, p)));
  assert.strictEqual(hashes.size, 4);
});

test("hashPost: body beyond 500 chars does not change the hash", () => {
  // Deliberate: transient "Loading..." tails must not fork the fingerprint.
  const long = "x".repeat(500);
  const a = hashPost(CLASS_V1, { ...base, body: long + "AAAA" });
  const b = hashPost(CLASS_V1, { ...base, body: long + "BBBB" });
  assert.strictEqual(a, b);
});

test("hashPost: falls back to timestampFull when ISO parse failed", () => {
  const a = hashPost(CLASS_V1, { ...base, timestampIso: null, timestampFull: "Saturday, August 29, 2026 5:20 PM" });
  const b = hashPost(CLASS_V1, { ...base, timestampIso: null, timestampFull: "Sunday, August 30, 2026 5:20 PM" });
  assert.notStrictEqual(a, b);
});

test("hashPost: missing optional fields are stable, not crashy", () => {
  const minimal = { body: "hello" };
  assert.strictEqual(hashPost(CLASS_V1, minimal), hashPost(CLASS_V1, { ...minimal }));
});
