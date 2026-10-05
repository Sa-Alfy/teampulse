"use strict";

/**
 * S4 cron (selfhost/worker/src/cron.js): reminders at 24 h / 3 h, idempotent
 * via reminders_sent, quiet hours, submitted/done skipped, daily digest once
 * per day, /digest setting, outbox send. Fake D1 + fake Telegram API.
 */

const test   = require("node:test");
const assert = require("node:assert");
const path   = require("node:path");

const { digestDue, digestSetting } = require("../selfhost/core/schedule");
const bot = require("../selfhost/core/bot");

const MIGRATIONS = path.join(__dirname, "..", "selfhost", "worker", "migrations");
const HOUR = 3600e3;
const NOON = Date.parse("2026-10-05T06:00:00Z");   // 12:00 Dhaka
const TZ = "Asia/Dhaka";
const CHAT = 424242;

let cron, tg, idx, createD1;
test.before(async () => {
  cron = await import("../selfhost/worker/src/cron.js");
  tg = await import("../selfhost/worker/src/telegram.js");
  idx = await import("../selfhost/worker/src/index.js");
  ({ createD1 } = await import("../selfhost/worker/testing/fake-d1.js"));
});

function setup({ paired = true, settings = {} } = {}) {
  const DB = createD1({ migrationsDir: MIGRATIONS });
  const set = (k, v) => DB.sqlite.prepare("INSERT INTO settings (k, v) VALUES (?, ?)").run(k, String(v));
  if (paired) set("chat_id", CHAT);
  set("last_sync_at", NOON - HOUR);
  for (const [k, v] of Object.entries(settings)) set(k, v);
  return { DB, TELEGRAM_BOT_TOKEN: "123:test" };
}

function addItem(env, key, dueMs, over = {}) {
  env.DB.sqlite.prepare(
    "INSERT INTO items (key, kind, class, title, due_iso, due_ms, tab, submitted, first_seen, done_at) VALUES (?, 'a', 'Synthetic (V1)', ?, ?, ?, 'Upcoming', ?, ?, ?)"
  ).run(key, `Title ${key}`, new Date(dueMs).toISOString(), dueMs, over.submitted ? 1 : 0, over.firstSeen ?? NOON - 5 * 24 * HOUR, over.doneAt ?? null);
}

function telegram() {
  const calls = [];
  tg.setFetchForTests(async (url, init) => { calls.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); });
  return calls;
}

const rows = (env, sql) => env.DB.sqlite.prepare(sql).all().map((r) => ({ ...r }));

test.afterEach(() => tg && tg.setFetchForTests(null));

test("schedule: digest window, once per day, off, invalid settings fall back", () => {
  const at = (iso) => Date.parse(iso);
  assert.deepStrictEqual(digestDue(at("2026-10-05T01:30:00Z"), TZ, "07:30", null), { due: true, day: "2026-10-05" });   // 07:30 Dhaka
  assert.strictEqual(digestDue(at("2026-10-05T01:59:00Z"), TZ, "07:30", null).due, true);                              // 07:59
  assert.strictEqual(digestDue(at("2026-10-05T02:00:00Z"), TZ, "07:30", null).due, false);                             // 08:00
  assert.strictEqual(digestDue(at("2026-10-05T01:25:00Z"), TZ, "07:30", null).due, false);                             // 07:25
  assert.strictEqual(digestDue(at("2026-10-05T01:35:00Z"), TZ, "07:30", "2026-10-05").due, false);
  assert.strictEqual(digestDue(at("2026-10-05T01:35:00Z"), TZ, "off", null).due, false);
  assert.strictEqual(digestSetting("25:00"), "07:30");
  assert.strictEqual(digestDue(at("2026-10-05T01:35:00Z"), TZ, undefined, null).due, true, "default 07:30");
});

test("cron: unpaired instance plans nothing and sends nothing", async () => {
  const env = setup({ paired: false });
  addItem(env, "a:1", NOON + 2 * HOUR);
  const calls = telegram();
  assert.deepStrictEqual(await cron.runCron(env, NOON), { reminders: 0, digest: false, sent: 0 });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(rows(env, "SELECT * FROM events").length, 0);
});

test("cron: 3h and 24h reminders are sent once; events and reminders_sent share ONE batch", async () => {
  const env = setup();
  addItem(env, "a:soon", NOON + 2 * HOUR);
  addItem(env, "a:day", NOON + 20 * HOUR);
  addItem(env, "a:far", NOON + 40 * HOUR);
  addItem(env, "a:sub", NOON + 2 * HOUR, { submitted: true });
  addItem(env, "a:done", NOON + 2 * HOUR, { doneAt: NOON - HOUR });
  const calls = telegram();
  const r = await cron.runCron(env, NOON);
  assert.deepStrictEqual(r, { reminders: 2, digest: false, sent: 1 });
  assert.strictEqual(calls.length, 1, "grouped into one message");
  assert.match(calls[0].text, /Reminder \(3h\)[\s\S]*Title a:soon/);
  assert.match(calls[0].text, /Reminder \(24h\)[\s\S]*Title a:day/);
  assert.ok(!/a:far|a:sub|a:done/.test(calls[0].text));
  assert.match(calls[0].text, /Last synced 1 h ago$/);
  const writeBatches = env.DB.calls.batches.filter((b) => b.includes("write"));
  assert.ok(writeBatches.some((b) => b.length === 4), "2 reminders × (reminders_sent + event) in one batch");
  assert.strictEqual(rows(env, "SELECT * FROM reminders_sent").length, 2);

  const again = await cron.runCron(env, NOON + 5 * 60e3);
  assert.deepStrictEqual(again, { reminders: 0, digest: false, sent: 0 });
  assert.strictEqual(calls.length, 1, "no duplicate reminders");
});

test("cron: a moved due date gets fresh reminders; the old slot is not resent", async () => {
  const env = setup();
  addItem(env, "a:x", NOON + 2 * HOUR);
  telegram();
  await cron.runCron(env, NOON);
  const moved = NOON + 2.5 * HOUR;
  env.DB.sqlite.prepare("UPDATE items SET due_iso = ?, due_ms = ? WHERE key = 'a:x'").run(new Date(moved).toISOString(), moved);
  const r = await cron.runCron(env, NOON + 5 * 60e3);
  assert.strictEqual(r.reminders, 1);
  assert.strictEqual(rows(env, "SELECT * FROM reminders_sent").length, 2);
});

test("cron: quiet hours hold the 24h reminder but not the 3h one", async () => {
  const env = setup();
  const night = Date.parse("2026-10-05T18:30:00Z"); // 00:30 Dhaka
  addItem(env, "a:soon", night + 2 * HOUR);
  addItem(env, "a:day", night + 20 * HOUR);
  const calls = telegram();
  assert.strictEqual((await cron.runCron(env, night)).reminders, 1);
  assert.match(calls[0].text, /3h[\s\S]*a:soon/);
  const morning = Date.parse("2026-10-06T01:05:00Z"); // 07:05 Dhaka
  assert.strictEqual((await cron.runCron(env, morning)).reminders, 1);
  assert.match(calls[1].text, /24h[\s\S]*a:day/);
});

test("cron: item first seen <3 h before due gets a one-time 'Due soon'", async () => {
  const env = setup();
  addItem(env, "a:new", NOON + 2 * HOUR, { firstSeen: NOON - 10 * 60e3 });
  const calls = telegram();
  await cron.runCron(env, NOON);
  await cron.runCron(env, NOON + 30 * 60e3);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].text, /Due soon/);
});

test("cron: daily digest at 07:30 local, once per day; /digest off stops it", async () => {
  const env = setup();
  addItem(env, "a:week", NOON + 3 * 24 * HOUR);
  const calls = telegram();
  const t0730 = Date.parse("2026-10-05T01:30:00Z");
  assert.strictEqual((await cron.runCron(env, t0730)).digest, true);
  assert.strictEqual((await cron.runCron(env, t0730 + 5 * 60e3)).digest, false, "same day");
  assert.match(calls[0].text, /daily digest[\s\S]*Title a:week[\s\S]*Last synced/);
  assert.strictEqual(calls.length, 1);

  const off = bot.reply({ cmd: "digest", arg: "off" }, { items: [], now: NOON, tz: TZ, lastSyncAt: null, lists: {}, digest: "07:30" });
  assert.deepStrictEqual(off.settings, { digest_time: "off" });
  env.DB.sqlite.prepare("INSERT INTO settings (k, v) VALUES ('digest_time', 'off') ON CONFLICT(k) DO UPDATE SET v = excluded.v").run();
  assert.strictEqual((await cron.runCron(env, t0730 + 24 * HOUR)).digest, false);
  assert.deepStrictEqual(bot.reply({ cmd: "digest", arg: "8:15" }, { items: [], now: NOON, tz: TZ, lists: {} }).settings, { digest_time: "8:15" });
  assert.deepStrictEqual(bot.reply({ cmd: "digest", arg: "99:99" }, { items: [], now: NOON, tz: TZ, lists: {} }).settings, {});
});

test("cron: the scheduled() export runs the cron and never throws", async () => {
  const env = setup();
  addItem(env, "a:soon", NOON + 2 * HOUR);
  const calls = telegram();
  await idx.default.scheduled({ scheduledTime: NOON, cron: "*/5 * * * *" }, env, { waitUntil() {} });
  assert.strictEqual(calls.length, 1);
  await idx.default.scheduled({ scheduledTime: NOON }, { DB: { batch: async () => { throw new Error("down"); } } }, {});
});

test("schema: reminder lookups are primary-key and index searches", async () => {
  const env = setup();
  const plan = (sql) => env.DB.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT id FROM reminders_sent WHERE id IN ('a', 'b')"), /SEARCH reminders_sent USING PRIMARY KEY/);
});
