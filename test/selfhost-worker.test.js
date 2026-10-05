"use strict";

/**
 * Self-host Worker (selfhost/worker/src) against a node:sqlite-backed fake D1
 * with the real migration applied. Proves routing, fail-closed auth, status
 * codes, validation, change detection end to end, one write batch per
 * ingest, atomicity, content-free logs and index use. Real D1 / workerd
 * behaviour is checked separately with wrangler (see PROJECT_CONTEXT 6.6).
 */

const test   = require("node:test");
const assert = require("node:assert");
const path   = require("node:path");

const ROOT = path.join(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "selfhost", "worker", "migrations");
const { sha256Hex } = require("../extension/core/fingerprint");

const KEY = "tp_test_key_0123456789abcdefghijklmnopqrstuv";
const NOW = Date.parse("2026-10-05T06:00:00Z");
const HOUR = 3600e3;
const CLS = "Summer_2026_CSE 312 (V1)";
const TABS = ["Upcoming", "Past due", "Completed"];

let mod;
let store;
let createD1;

test.before(async () => {
  mod = await import("../selfhost/worker/src/index.js");
  store = await import("../selfhost/worker/src/store.js");
  ({ createD1 } = await import("../selfhost/worker/testing/fake-d1.js"));
});

async function setup({ key = true } = {}) {
  const DB = createD1({ migrationsDir: MIGRATIONS });
  if (key) DB.sqlite.prepare("INSERT INTO settings (k, v) VALUES ('ingest_key_hash', ?)").run(await sha256Hex(KEY));
  return { DB };
}

function req(pathname, { method = "GET", body, headers = {}, auth = KEY, scheme = "https" } = {}) {
  const h = { ...headers };
  if (auth) h.authorization = `Bearer ${auth}`;
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  return new Request(`${scheme}://worker.test${pathname}`, {
    method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function payload(over = {}) {
  return {
    v: 1, syncId: "sync-0001", class: CLS, tabs: TABS, postsCaptured: true,
    assignments: [
      { assignmentId: "g1", title: "Lab 1", tab: "Upcoming", dueIso: "2026-10-10T17:59:00.000Z" },
      { assignmentId: "g2", title: "Lab 2", tab: "Past due", dueIso: "2026-10-01T17:59:00.000Z" },
    ],
    posts: [{ id: "a".repeat(64), author: "T", subject: "", body: "Welcome", isAnnouncement: true }],
    ...over,
  };
}

async function call(env, r, now = NOW) {
  const res = await mod.handle(r, env, now);
  return { status: res.status, body: await res.json() };
}

// ── routing, transport, auth ──────────────────────────────────────────────

test("worker: HTTPS only, 404 and 405", async () => {
  const env = await setup();
  assert.strictEqual((await call(env, req("/api/ingest", { method: "POST", body: payload(), scheme: "http" }))).status, 403);
  assert.strictEqual((await call(env, req("/nope"))).status, 404);
  assert.strictEqual((await call(env, req("/api/ingest"))).status, 405);
  assert.strictEqual((await call(env, req("/api/events", { method: "POST", body: {} }))).status, 405);
});

test("worker: fails closed with 503 when no key is set", async () => {
  const env = await setup({ key: false });
  for (const r of [req("/api/ingest", { method: "POST", body: payload() }), req("/api/events")]) {
    const res = await call(env, r);
    assert.deepStrictEqual([res.status, res.body], [503, { error: "not_configured" }]);
  }
});

test("worker: 401 for missing, malformed or wrong bearer keys", async () => {
  const env = await setup();
  for (const auth of [null, "short", `${KEY}x`, "tp_wrong_key_0123456789abcdefghijklmnopqrstu"]) {
    const res = await call(env, req("/api/ingest", { method: "POST", body: payload(), auth }));
    assert.deepStrictEqual([res.status, res.body], [401, { error: "unauthorized" }], String(auth));
  }
  const raw = await call(env, req("/api/events", { auth: null, headers: { authorization: KEY } }));
  assert.strictEqual(raw.status, 401, "no Bearer prefix");
});

test("worker: 415 for a non-JSON content type", async () => {
  const env = await setup();
  const res = await call(env, req("/api/ingest", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }));
  assert.strictEqual(res.status, 415);
});

test("worker: 413 by Content-Length and by streamed size without it", async () => {
  const env = await setup();
  const big = JSON.stringify({ ...payload(), pad: "x".repeat(130 * 1024) });
  assert.strictEqual((await call(env, req("/api/ingest", { method: "POST", body: big }))).status, 413);
  const stream = new ReadableStream({
    start(c) { for (let i = 0; i < 140; i++) c.enqueue(new TextEncoder().encode("x".repeat(1024))); c.close(); },
  });
  const r = new Request("https://worker.test/api/ingest", {
    method: "POST", body: stream, duplex: "half",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  });
  assert.strictEqual(r.headers.get("content-length"), null);
  assert.strictEqual((await call(env, r)).status, 413);
});

test("worker: 400 with a fixed error code, never echoing input", async () => {
  const env = await setup();
  const hostile = "<script>alert(1)</script>";
  const cases = [
    ["not json", "bad_json"],
    [{ ...payload(), v: 2 }, "version:v"],
    [{ ...payload(), syncId: "x" }, "format:syncId"],
    [{ ...payload(), class: "" }, "empty:class"],
    [{ ...payload(), tabs: ["Upcoming", "Nope"] }, "format:tabs[1]"],
    [{ ...payload(), assignments: [{ title: "a", tab: "Done" }] }, "format:assignments[0].tab"],
    [{ ...payload(), assignments: [{ title: hostile.repeat(100), tab: "Upcoming" }] }, "too_long:assignments[0].title"],
    [{ ...payload(), assignments: Array.from({ length: 301 }, () => ({ title: "a", tab: "Upcoming" })) }, "too_many:assignments"],
    [{ ...payload(), posts: [{ id: hostile }] }, "format:posts[0].id"],
    [{ ...payload(), postsCaptured: "yes" }, "type:postsCaptured"],
  ];
  for (const [body, code] of cases) {
    const res = await call(env, req("/api/ingest", { method: "POST", body }));
    assert.deepStrictEqual([res.status, res.body], [400, { error: code }], code);
    assert.ok(!JSON.stringify(res.body).includes("<script>"));
  }
  assert.strictEqual(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM items").get().n, 0, "nothing stored");
});

// ── ingest end to end ─────────────────────────────────────────────────────

test("worker: baseline, then a moved due date and a new post become events; replay adds none", async () => {
  const env = await setup();
  let res = await call(env, req("/api/ingest", { method: "POST", body: payload() }));
  assert.deepStrictEqual(res, { status: 200, body: { ok: true, events: 0, written: 3, collisions: 0, baselineDone: { assignments: true, posts: true } } });
  const cls = env.DB.sqlite.prepare("SELECT a_baselined, p_baselined, last_sync_at FROM classes WHERE name = ?").get(CLS);
  assert.deepStrictEqual({ ...cls }, { a_baselined: 1, p_baselined: 1, last_sync_at: NOW });

  const second = payload({
    syncId: "sync-0002",
    assignments: [{ assignmentId: "g1", title: "Lab 1", tab: "Upcoming", dueIso: "2026-10-12T17:59:00.000Z" }, payload().assignments[1]],
    posts: [{ id: "b".repeat(64), subject: "", body: "Quiz on Sunday" }],
  });
  res = await call(env, req("/api/ingest", { method: "POST", body: second }), NOW + HOUR);
  assert.strictEqual(res.body.events, 2);
  res = await call(env, req("/api/ingest", { method: "POST", body: second }), NOW + 2 * HOUR);
  assert.strictEqual(res.body.events, 0, "replay");

  const list = await call(env, req("/api/events?since=0"));
  assert.deepStrictEqual(list.body.events.map((e) => e.type).sort(), ["due_date_changed", "tagged_post"]);
  const moved = list.body.events.find((e) => e.type === "due_date_changed");
  assert.deepStrictEqual([moved.payload.old, moved.payload.new], ["2026-10-10T17:59:00.000Z", "2026-10-12T17:59:00.000Z"]);
  assert.strictEqual(moved.sent, false);

  const p1 = await call(env, req("/api/events?since=0&limit=1"));
  const p2 = await call(env, req(`/api/events?cursor=${p1.body.cursor}&limit=1`));
  const p3 = await call(env, req(`/api/events?cursor=${p2.body.cursor}&limit=1`));
  assert.strictEqual(p1.body.events.length + p2.body.events.length + p3.body.events.length, 2);
  assert.notStrictEqual(p1.body.events[0].id, p2.body.events[0].id);
  assert.strictEqual((await call(env, req("/api/events?cursor=bad"))).status, 400);
});

test("worker: every ingest writes in exactly ONE batch, with no writes outside it", async () => {
  const env = await setup();
  await call(env, req("/api/ingest", { method: "POST", body: payload() }));
  await call(env, req("/api/ingest", { method: "POST", body: payload({ syncId: "sync-0002" }) }), NOW + HOUR);
  const writeBatches = env.DB.calls.batches.filter((b) => b.includes("write"));
  assert.strictEqual(writeBatches.length, 2, "one per call");
  for (const b of writeBatches) assert.ok(b.every((k) => k === "write"), "reads are never mixed into the write batch");
  assert.strictEqual(env.DB.calls.directWrites, 0);
});

test("worker: a failing statement rolls back the whole batch (500, nothing written)", async () => {
  const env = await setup();
  await call(env, req("/api/ingest", { method: "POST", body: payload() }));
  const before = env.DB.sqlite.prepare("SELECT key, due_iso FROM items ORDER BY key").all().map((r) => ({ ...r }));
  env.DB.calls.failOn = /^INSERT INTO syncs/;
  const moved = payload({ syncId: "sync-0002", assignments: [{ assignmentId: "g1", title: "Lab 1", tab: "Upcoming", dueIso: "2026-10-20T17:59:00.000Z" }, payload().assignments[1]] });
  const res = await call(env, req("/api/ingest", { method: "POST", body: moved }), NOW + HOUR);
  assert.deepStrictEqual([res.status, res.body], [500, { error: "internal" }]);
  assert.deepStrictEqual(env.DB.sqlite.prepare("SELECT key, due_iso FROM items ORDER BY key").all().map((r) => ({ ...r })), before);
  assert.strictEqual(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
});

test("worker: logs carry counts only — no titles, bodies or keys", async () => {
  const env = await setup();
  const secret = "SECRET-TITLE-<script>";
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await call(env, req("/api/ingest", { method: "POST", body: payload({ assignments: [{ title: secret, tab: "Upcoming", details: secret }], posts: [{ id: "c".repeat(64), body: secret }] }) }));
    await call(env, req("/api/events?since=0"));
    env.DB.calls.failOn = /^INSERT INTO syncs/;
    await call(env, req("/api/ingest", { method: "POST", body: payload({ syncId: "sync-0002", assignments: [{ title: secret, tab: "Past due" }] }) }), NOW + HOUR);
  } finally {
    console.log = orig;
  }
  assert.ok(lines.length >= 3);
  for (const l of lines) {
    assert.ok(!l.includes("SECRET-TITLE") && !l.includes(KEY) && !l.includes("injected"), l);
  }
});

test("worker: /health returns exactly four booleans and needs no key", async () => {
  const env = await setup();
  let res = await call(env, req("/health", { auth: null }));
  assert.deepStrictEqual(res.body, { claimed: true, bot_token_set: false, webhook_set: false, migrated: true });
  res = await call({ DB: createD1(), TELEGRAM_BOT_TOKEN: "123:abc" }, req("/health", { auth: null }));
  assert.deepStrictEqual(res.body, { claimed: false, bot_token_set: true, webhook_set: false, migrated: false });
  for (const v of Object.values(res.body)) assert.strictEqual(typeof v, "boolean");
});

// ── auth hardening: refuse bad tokens before D1, cache the key hash ───────

test("worker: missing, malformed or oversized tokens get 401 with zero D1 statements", async () => {
  for (const configured of [true, false]) {
    const env = await setup({ key: configured });
    const bad = [null, "Basic abc", "Bearer short", `Bearer ${"a".repeat(129)}`, `Bearer ${"a".repeat(5000)}`, `Bearer ${KEY} extra`, "Bearer ab$cd_efghijklmnopqrstuv"];
    for (const h of bad) {
      const before = env.DB.calls.execs;
      const r = new Request("https://worker.test/api/ingest", {
        method: "POST", body: JSON.stringify(payload()),
        headers: { "content-type": "application/json", ...(h ? { authorization: h } : {}) },
      });
      const res = await call(env, r);
      assert.deepStrictEqual([res.status, res.body], [401, { error: "unauthorized" }], String(h).slice(0, 30));
      assert.strictEqual(env.DB.calls.execs, before, `no D1 statement for ${String(h).slice(0, 30)}`);
    }
    const ev = await call(env, req("/api/events", { auth: null }));
    assert.strictEqual(ev.status, 401);
  }
});

test("worker: the key hash is read once per 60 s per isolate, including 'not set'", async () => {
  const env = await setup();
  const count = async (fn) => { const b = env.DB.calls.execs; await fn(); return env.DB.calls.execs - b; };
  const t0 = NOW + 10 * 24 * HOUR; // fresh cache window for this env
  const first = await count(() => call(env, req("/api/events?since=0"), t0));
  const cached = await count(() => call(env, req("/api/events?since=0"), t0 + 59e3));
  const expired = await count(() => call(env, req("/api/events?since=0"), t0 + 61e3));
  assert.strictEqual(first, 2, "key read + events query");
  assert.strictEqual(cached, 1, "events query only");
  assert.strictEqual(expired, 2, "re-read after 60 s");
  const wrong = await call(env, req("/api/events", { auth: "tp_wrong_key_0123456789abcdefghijklmnopqrstu" }), t0 + 62e3);
  assert.strictEqual(wrong.status, 401, "cached hash still rejects a wrong key");

  const fresh = await setup({ key: false });
  const n1 = fresh.DB.calls.execs;
  assert.strictEqual((await call(fresh, req("/api/events"), t0)).status, 503);
  assert.strictEqual((await call(fresh, req("/api/events"), t0 + 30e3)).status, 503);
  assert.strictEqual(fresh.DB.calls.execs - n1, 1, "'not set' is cached as well");
  fresh.DB.sqlite.prepare("INSERT INTO settings (k, v) VALUES ('ingest_key_hash', ?)").run(await sha256Hex(KEY));
  const routes = await import("../selfhost/worker/src/routes.js");
  routes.invalidateKeyCache(fresh.DB);
  assert.strictEqual((await call(fresh, req("/api/events"), t0 + 31e3)).status, 200, "invalidation picks up a new key at once");
});

// ── index use (EXPLAIN QUERY PLAN on SQLite; D1 checked with wrangler) ─────

test("schema: hot queries use their indexes (EXPLAIN QUERY PLAN)", async () => {
  const { DB } = await setup();
  const plan = (sql, ...p) => DB.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail).join(" | ");
  const reminders = plan(store.REMINDER_CANDIDATES_SQL, NOW, NOW + 24 * HOUR);
  assert.match(reminders, /USING INDEX items_open_due \(due_ms>\? AND due_ms<\?\)/, reminders);
  assert.match(plan(store.LOAD_CLASS_SQL, CLS), /USING INDEX items_class_live \(class=\?\)/);
  assert.match(plan("SELECT id FROM events WHERE created_at >= ? ORDER BY created_at, id LIMIT 50", 0), /USING (COVERING )?INDEX events_created/);
  for (const q of [reminders, plan(store.LOAD_CLASS_SQL, CLS)]) assert.ok(!/\bSCAN items\b/.test(q), q);
});
