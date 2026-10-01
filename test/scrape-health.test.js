"use strict";

/**
 * Scraper-health path: TP_HEALTH (messages.js) → store.recordHealth →
 * buildStatus().scraper / scraperIssues (shape.js).
 */

const test   = require("node:test");
const assert = require("node:assert");

const { hashPost }     = require("../extension/core/fingerprint");
const { isNoteworthy } = require("../extension/core/digest-utils");
globalThis.TP = Object.assign(globalThis.TP || {}, { hashPost, isNoteworthy });

const { createStore, memoryBackend } = require("../extension/core/store");
const { buildStatus }   = require("../extension/core/shape");
const { handleMessage } = require("../extension/core/messages");

const TEAMS = "https://teams.cloud.microsoft/";
const CLS   = "Summer_2026_CSE 312 (V1)_ 232_D4";

function setup() {
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const store = createStore(memoryBackend());
  const deps = {
    store,
    session: { get: async () => null, set: async () => {}, remove: async () => {} },
    nowIso: () => new Date(clock).toISOString(),
  };
  const send = (msg, url = TEAMS) => handleMessage(msg, { tab: { id: 1 }, url }, deps);
  const tick = (ms) => { clock += ms; };
  const status = async () => buildStatus(await store.getState(), clock);
  return { store, send, tick, status };
}

const POST = {
  author: "Dr A", isBot: false, isAnnouncement: false, subject: "CT-2 schedule",
  body: "Quiz on 5 October 2026", timestamp: "", timestampFull: "", timestampIso: null,
  attachments: [], urlPreviews: [], replyCount: 0, replies: [],
};

test("no reports → scraper ok, even with no data", async () => {
  const { status } = setup();
  const s = await status();
  assert.strictEqual(s.scraper, "ok");
  assert.deepStrictEqual(s.scraperIssues, []);
});

test("no-class with no data yet → suspect (class detection broken is never silent)", async () => {
  const { send, status } = setup();
  assert.deepStrictEqual(await send({ type: "TP_HEALTH", status: "no-class" }), { ok: true });
  const s = await status();
  assert.strictEqual(s.noDataYet, true);
  assert.strictEqual(s.scraper, "suspect");
  assert.strictEqual(s.scraperIssues[0].kind, "no-class");
  assert.strictEqual(s.scraperIssues[0].className, null);
});

test("no-class is cleared by a later successful capture", async () => {
  const { send, tick, status } = setup();
  await send({ type: "TP_HEALTH", status: "no-class" });
  tick(1000);
  assert.deepStrictEqual(await send({ type: "TP_POSTS", className: CLS, posts: [POST] }), { ok: true });
  assert.strictEqual((await status()).scraper, "ok");
});

test("no-messages flags only its class and clears on that class's next capture", async () => {
  const { send, tick, status } = setup();
  await send({ type: "TP_POSTS", className: CLS, posts: [POST] });
  tick(1000);
  await send({ type: "TP_HEALTH", status: "no-messages", className: CLS });
  let s = await status();
  assert.strictEqual(s.scraper, "suspect");
  assert.strictEqual(s.scraperIssues[0].className, CLS);

  tick(1000);
  await send({ type: "TP_POSTS", className: CLS, posts: [{ ...POST, body: "Final on 20 October 2026" }] });
  s = await status();
  assert.strictEqual(s.scraper, "ok");
});

test("TP_HEALTH validation: origin, status, className rules", async () => {
  const { send, status } = setup();
  const bad = [
    [{ type: "TP_HEALTH", status: "no-class" }, "https://evil.example/"],
    [{ type: "TP_HEALTH", status: "ok" }],
    [{ type: "TP_HEALTH", status: "no-messages" }],
    [{ type: "TP_HEALTH", status: "no-messages", className: "" }],
    [{ type: "TP_HEALTH", status: "no-messages", className: "x".repeat(10_000) }],
    [{ type: "TP_HEALTH", status: "no-class", className: CLS }],
  ];
  for (const [msg, url] of bad) {
    const res = await send(msg, url);
    assert.strictEqual(res.ok, false, `should reject ${JSON.stringify(msg).slice(0, 80)}`);
  }
  assert.strictEqual((await status()).scraper, "ok", "rejected reports must not be stored");
});

test("clearAll removes health records", async () => {
  const { store, send, status } = setup();
  await send({ type: "TP_HEALTH", status: "no-class" });
  await store.clearAll();
  assert.strictEqual((await status()).scraper, "ok");
});
