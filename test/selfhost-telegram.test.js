"use strict";

/**
 * S3 Telegram: pure bot logic (selfhost/core/bot.js) and the Worker adapter
 * (selfhost/worker/src/telegram.js) against the node:sqlite fake D1. The
 * Telegram API is replaced by a recording fake fetch; nothing leaves the machine.
 */

const test   = require("node:test");
const assert = require("node:assert");
const path   = require("node:path");

const bot = require("../selfhost/core/bot");
const { sha256Hex } = require("../extension/core/fingerprint");

const MIGRATIONS = path.join(__dirname, "..", "selfhost", "worker", "migrations");
const SECRET = "webhook_secret_0123456789abcdef";
const TOKEN = "123456:TEST-token-not-real";
const NOW = Date.parse("2026-10-05T06:00:00Z"); // 12:00 Dhaka
const HOUR = 3600e3;
const CHAT = 424242;
const CODE = "ABCDEFGHJK";

let mod, tg, createD1;
test.before(async () => {
  mod = await import("../selfhost/worker/src/index.js");
  tg = await import("../selfhost/worker/src/telegram.js");
  ({ createD1 } = await import("../selfhost/worker/testing/fake-d1.js"));
});

async function setup({ paired = false, pairing = true, secret = true } = {}) {
  const DB = createD1({ migrationsDir: MIGRATIONS });
  const set = (k, v) => DB.sqlite.prepare("INSERT INTO settings (k, v) VALUES (?, ?)").run(k, String(v));
  if (secret) set("tg_secret_hash", await sha256Hex(SECRET));
  if (paired) set("chat_id", CHAT);
  else if (pairing) { set("pair_hash", await sha256Hex(CODE)); set("pair_expires", NOW + 10 * 60e3); set("pair_fails", 0); }
  set("last_sync_at", NOW - 2 * HOUR);
  return { DB, TELEGRAM_BOT_TOKEN: TOKEN };
}

function addItem(env, key, title, dueMs, over = {}) {
  env.DB.sqlite.prepare(
    "INSERT INTO items (key, kind, class, title, due_iso, due_ms, tab, submitted, first_seen, done_at) VALUES (?, 'a', ?, ?, ?, ?, 'Upcoming', ?, ?, ?)"
  ).run(key, "Summer_2026_CSE 312 (V1)", title, new Date(dueMs).toISOString(), dueMs, over.submitted ? 1 : 0, NOW - 5 * 24 * HOUR, over.doneAt ?? null);
}

function update(text, { chatId = CHAT, type = "private" } = {}) {
  return { update_id: 1, message: { message_id: 1, date: 0, chat: { id: chatId, type }, from: { id: chatId }, text } };
}

async function hook(env, body, { secret = SECRET, now = NOW, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  const res = await mod.handle(new Request("https://worker.test/telegram/webhook", { method: "POST", headers, body: raw ?? JSON.stringify(body) }), env, now);
  return { status: res.status, body: await res.json() };
}

const setting = (env, k) => {
  const r = env.DB.sqlite.prepare("SELECT v FROM settings WHERE k = ?").get(k);
  return r ? r.v : undefined;
};

// ── pure ──────────────────────────────────────────────────────────────────

test("bot: parseCommand handles bot suffix, args, junk", () => {
  assert.deepStrictEqual(bot.parseCommand("/due@MyBot  3 "), { cmd: "due", arg: "3" });
  assert.deepStrictEqual(bot.parseCommand("/TODAY"), { cmd: "today", arg: "" });
  assert.strictEqual(bot.parseCommand("hello"), null);
  assert.strictEqual(bot.parseCommand(null), null);
});

test("bot: pairing codes — 10 chars, unambiguous alphabet, normalization", () => {
  const code = bot.makePairCode(new Uint8Array([0, 1, 2, 31, 32, 255, 100, 7, 8, 9]));
  assert.strictEqual(code.length, bot.PAIR_LEN);
  assert.ok(!/[01OI]/.test(code));
  assert.strictEqual(bot.normalizePairCode("abcde-fghjk"), CODE);
  assert.strictEqual(bot.normalizePairCode("ABCDEFGHJ0"), null);
  assert.strictEqual(bot.pairingOpen({ hash: "h", expiresAt: NOW + 1, fails: 4 }, NOW), true);
  assert.strictEqual(bot.pairingOpen({ hash: "h", expiresAt: NOW, fails: 0 }, NOW), false);
  assert.strictEqual(bot.pairingOpen({ hash: "h", expiresAt: NOW + 1, fails: 5 }, NOW), false);
});

test("bot: buildAlertMessages groups under the size cap and keeps ids per message", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, type: "new_post", payload: { class: "C", subject: "x".repeat(250) } }));
  rows.push({ id: "unknown", type: "nope", payload: {} });
  const msgs = bot.buildAlertMessages(rows, { now: NOW, tz: "Asia/Dhaka", lastSyncAt: NOW - HOUR });
  assert.ok(msgs.length > 1);
  for (const m of msgs) if (m.text) { assert.ok(m.text.length <= 4096); assert.match(m.text, /Last synced 1 h ago$/); }
  assert.deepStrictEqual(msgs.flatMap((m) => m.ids).sort(), rows.map((r) => r.id).sort());
  assert.deepStrictEqual(msgs.find((m) => m.ids.includes("unknown")).text, null);
});

// ── webhook security ──────────────────────────────────────────────────────

test("webhook: missing/malformed secret → 401 with no D1 statement; wrong → 401; unset → 503", async () => {
  const env = await setup();
  for (const secret of [null, "short", "has spaces in it 1234567"]) {
    const n = env.DB.calls.execs;
    assert.strictEqual((await hook(env, update("/start"), { secret })).status, 401);
    assert.strictEqual(env.DB.calls.execs, n);
  }
  assert.strictEqual((await hook(env, update("/start"), { secret: "wrong_secret_0123456789abcdef" })).status, 401);
  assert.strictEqual((await hook(await setup({ secret: false }), update("/start"))).status, 503);
});

test("webhook: 415 / 413 / 400 and ignored update shapes", async () => {
  const env = await setup();
  const r415 = await mod.handle(new Request("https://worker.test/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "text/plain" }, body: "{}" }), env, NOW);
  assert.strictEqual(r415.status, 415);
  assert.strictEqual((await hook(env, null, { raw: "x".repeat(70 * 1024) })).status, 413);
  assert.strictEqual((await hook(env, null, { raw: "{bad" })).status, 400);
  for (const u of [{}, { edited_message: {} }, update("/start ABCDEFGHJK", { type: "group" }), { message: { chat: { id: CHAT, type: "private" } } }]) {
    const r = await hook(env, u);
    assert.deepStrictEqual([r.status, r.body], [200, {}]);
  }
  assert.strictEqual(setting(env, "chat_id"), undefined);
});

// ── pairing ───────────────────────────────────────────────────────────────

test("pairing: correct code pairs this chat once; the code is single-use", async () => {
  const env = await setup();
  const r = await hook(env, update("/start abcde fghjk"));
  assert.strictEqual(r.body.method, "sendMessage");
  assert.strictEqual(r.body.chat_id, CHAT);
  assert.match(r.body.text, /^Paired/);
  assert.strictEqual(r.body.parse_mode, undefined);
  assert.strictEqual(setting(env, "chat_id"), String(CHAT));
  assert.strictEqual(setting(env, "pair_hash"), undefined);
  const stranger = await hook(env, update(`/start ${CODE}`, { chatId: 999 }));
  assert.deepStrictEqual(stranger.body, {}, "a second chat cannot use the code again");
  assert.strictEqual(setting(env, "chat_id"), String(CHAT));
});

test("pairing: wrong codes count; the 5th disables the code; expired codes are refused", async () => {
  const env = await setup();
  for (let i = 1; i <= 4; i++) {
    const r = await hook(env, update("/start ZZZZZZZZZZ"));
    assert.match(r.body.text, /wrong or expired/);
    assert.strictEqual(setting(env, "pair_fails"), String(i));
  }
  assert.match((await hook(env, update("/start ZZZZZZZZZZ"))).body.text, /Too many wrong codes/);
  assert.strictEqual(setting(env, "pair_hash"), undefined);
  assert.match((await hook(env, update(`/start ${CODE}`))).body.text, /No pairing code is active/);
  assert.strictEqual(setting(env, "chat_id"), undefined);

  const late = await setup();
  assert.match((await hook(late, update(`/start ${CODE}`), { now: NOW + 11 * 60e3 })).body.text, /No pairing code is active/);
  assert.strictEqual(setting(late, "chat_id"), undefined);
});

test("pairing: before pairing, anything but /start gets no reply", async () => {
  const env = await setup();
  assert.deepStrictEqual((await hook(env, update("/due"))).body, {});
  assert.deepStrictEqual((await hook(env, update("hi"))).body, {});
});

// ── commands ──────────────────────────────────────────────────────────────

test("commands: other chats are ignored without reply or D1 write after pairing", async () => {
  const env = await setup({ paired: true });
  const writesBefore = env.DB.calls.batches.length;
  const r = await hook(env, update("/due", { chatId: 31337 }));
  assert.deepStrictEqual([r.status, r.body], [200, {}]);
  assert.strictEqual(env.DB.calls.batches.length, writesBefore);
});

test("commands: /today /week /due /plan reply in plain text with the last-synced line", async () => {
  const env = await setup({ paired: true });
  addItem(env, "a:id:1", "<b>Lab 1</b>", NOW + 3 * HOUR);
  addItem(env, "a:id:2", "Lab 2", NOW + 30 * HOUR);
  addItem(env, "a:id:3", "Lab 3 (submitted)", NOW + 4 * HOUR, { submitted: true });
  for (const cmd of ["/today", "/week", "/due", "/plan", "/help", "/whatever"]) {
    const r = await hook(env, update(cmd));
    assert.strictEqual(r.body.method, "sendMessage", cmd);
    assert.strictEqual(r.body.parse_mode, undefined);
    assert.match(r.body.text, /Last synced 2 h ago$/, cmd);
    assert.ok(!r.body.text.includes("Lab 3"), `${cmd}: submitted items hidden`);
  }
  assert.match((await hook(env, update("/today"))).body.text, /<b>Lab 1<\/b>/, "kept literally");
  assert.match((await hook(env, update("/start"))).body.text, /^Already paired/);
});

test("commands: /done <n> needs a fresh /due list; /undone lists and restores", async () => {
  const env = await setup({ paired: true });
  addItem(env, "a:id:1", "Lab 1", NOW + 3 * HOUR);
  addItem(env, "a:id:2", "Lab 2", NOW + 30 * HOUR);
  assert.match((await hook(env, update("/done 1"))).body.text, /Run \/due first/);
  await hook(env, update("/due"));
  assert.match((await hook(env, update("/done 9"))).body.text, /from 1 to 2/);
  assert.match((await hook(env, update("/done 2"))).body.text, /^Marked done: Lab 2/);
  assert.strictEqual(env.DB.sqlite.prepare("SELECT done_at FROM items WHERE key = 'a:id:2'").get().done_at, NOW);
  assert.ok(!(await hook(env, update("/week"))).body.text.includes("Lab 2"), "hidden while done");
  assert.match((await hook(env, update("/done 2"))).body.text, /no longer open/);
  assert.match((await hook(env, update("/done 1"), { now: NOW + 25 * HOUR })).body.text, /Run \/due first/, "list older than 24 h");

  const list = await hook(env, update("/undone"));
  assert.match(list.body.text, /1\. Lab 2/);
  assert.match((await hook(env, update("/undone 1"))).body.text, /^Restored: Lab 2/);
  assert.strictEqual(env.DB.sqlite.prepare("SELECT done_at FROM items WHERE key = 'a:id:2'").get().done_at, null);
  assert.match((await hook(env, update("/undone"))).body.text, /Nothing is marked done/);
});

// ── outbox ────────────────────────────────────────────────────────────────

function addEvent(env, id, type, payload, { notBefore = NOW - 60e3, priority = "normal" } = {}) {
  env.DB.sqlite.prepare("INSERT INTO events (id, type, item_key, created_at, payload, priority, not_before) VALUES (?, ?, NULL, ?, ?, ?, ?)")
    .run(id.padEnd(64, "0"), type, NOW - 60e3, JSON.stringify(payload), priority, notBefore);
}

function fakeTelegram(responder = () => ({ status: 200, body: { ok: true } })) {
  const calls = [];
  tg.setFetchForTests(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responder(calls.length);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return calls;
}

const sentIds = (env) => env.DB.sqlite.prepare("SELECT id FROM events WHERE sent_at IS NOT NULL").all().map((r) => r.id.slice(0, 2));

test("outbox: sends due rows to the paired chat, plain text, and marks them sent only after ok", async () => {
  const env = await setup({ paired: true });
  addEvent(env, "e1", "due_date_changed", { class: "C", title: "<script>x</script>", old: null, new: new Date(NOW + 5 * HOUR).toISOString() });
  addEvent(env, "e2", "new_post", { class: "C", subject: "Hello" });
  addEvent(env, "e3", "new_post", { class: "C", subject: "Later" }, { notBefore: NOW + HOUR }); // quiet hours
  const calls = fakeTelegram();
  const r = await tg.flushOutbox(env, NOW);
  tg.setFetchForTests(null);
  assert.deepStrictEqual(r, { sent: 1, failed: 0 });
  assert.strictEqual(calls.length, 1, "grouped into one message");
  assert.match(calls[0].url, /^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/);
  assert.deepStrictEqual(Object.keys(calls[0].body).sort(), ["chat_id", "link_preview_options", "text"]);
  assert.strictEqual(calls[0].body.chat_id, CHAT);
  assert.match(calls[0].body.text, /<script>x<\/script>/);
  assert.deepStrictEqual(sentIds(env).sort(), ["e1", "e2"]);
});

test("outbox: a failed send stays unsent, is not re-sent inside the lease, and retries after it", async () => {
  const env = await setup({ paired: true });
  addEvent(env, "e1", "new_post", { class: "C", subject: "Hello" });
  let calls = fakeTelegram(() => ({ status: 500, body: { ok: false } }));
  assert.deepStrictEqual(await tg.flushOutbox(env, NOW), { sent: 0, failed: 1 });
  assert.deepStrictEqual(sentIds(env), []);
  calls = fakeTelegram();
  assert.deepStrictEqual(await tg.flushOutbox(env, NOW + 60e3), { sent: 0, failed: 0 }, "claimed: inside the 2 min lease");
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(await tg.flushOutbox(env, NOW + 3 * 60e3), { sent: 1, failed: 0 });
  assert.deepStrictEqual(sentIds(env), ["e1"]);
  assert.deepStrictEqual(await tg.flushOutbox(env, NOW + 10 * 60e3), { sent: 0, failed: 0 }, "never twice");
  tg.setFetchForTests(null);
});

test("outbox: nothing is sent without a paired chat or a bot token; the token never reaches logs", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const unpaired = await setup();
    addEvent(unpaired, "e1", "new_post", { class: "C", subject: "Hello" });
    const calls = fakeTelegram();
    assert.deepStrictEqual(await tg.flushOutbox(unpaired, NOW), { sent: 0, failed: 0 });
    const noToken = await setup({ paired: true });
    addEvent(noToken, "e1", "new_post", { class: "C", subject: "Hello" });
    assert.deepStrictEqual(await tg.flushOutbox({ DB: noToken.DB }, NOW), { sent: 0, failed: 0 });
    assert.strictEqual(calls.length, 0);
    const paired = await setup({ paired: true });
    addEvent(paired, "e1", "new_post", { class: "C", subject: "Hello" });
    fakeTelegram(() => ({ status: 403, body: { ok: false, description: "Forbidden: bot was blocked by the user" } }));
    await tg.flushOutbox(paired, NOW);
  } finally {
    console.log = orig;
    tg.setFetchForTests(null);
  }
  for (const l of lines) assert.ok(!l.includes(TOKEN) && !l.includes("Hello") && !l.includes("blocked"), l);
});

test("ingest: a few new events are flushed via waitUntil; replies come back from Telegram", async () => {
  const env = await setup({ paired: true });
  env.DB.sqlite.prepare("INSERT INTO settings (k, v) VALUES ('ingest_key_hash', ?)").run(await sha256Hex("tp_ingest_key_0123456789abcdefghij"));
  const calls = fakeTelegram();
  const body = (syncId, due) => JSON.stringify({ v: 1, syncId, class: "Synthetic", tabs: ["Upcoming", "Past due", "Completed"], postsCaptured: true,
    assignments: [{ assignmentId: "g1", title: "Lab 1", tab: "Upcoming", dueIso: due }], posts: [] });
  const send = async (b, now) => {
    const waits = [];
    const res = await mod.handle(new Request("https://worker.test/api/ingest", { method: "POST", body: b,
      headers: { authorization: "Bearer tp_ingest_key_0123456789abcdefghij", "content-type": "application/json" } }), env, now, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return { status: res.status, waits: waits.length };
  };
  assert.deepStrictEqual(await send(body("sync-0001", "2026-10-10T17:59:00.000Z"), NOW), { status: 200, waits: 0 }, "baseline: no events");
  assert.deepStrictEqual(await send(body("sync-0002", "2026-10-12T17:59:00.000Z"), NOW + HOUR), { status: 200, waits: 1 });
  tg.setFetchForTests(null);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].body.text, /Due date changed/);
  assert.match(calls[0].body.text, /Last synced 0 min ago$/);
});

test("schema: outbox and open-items queries use their indexes", async () => {
  const { DB } = await setup();
  const plan = (sql, ...p) => DB.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail).join(" | ");
  assert.match(plan(tg.OUTBOX_SQL, NOW, 8, NOW, 50), /USING INDEX events_outbox/);
  assert.match(plan(tg.OPEN_ITEMS_SQL), /USING INDEX items_open_due/);
});
