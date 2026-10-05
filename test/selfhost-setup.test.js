"use strict";

/**
 * S5: /setup claim flow, pairing reissue, .ics feed, /doctor, /rotatekey,
 * /rotatecal, /deleteall. Fake D1 + fake Telegram API; one end-to-end run
 * from an unclaimed instance to alerts and a calendar.
 */

const test   = require("node:test");
const assert = require("node:assert");
const path   = require("node:path");

const MIGRATIONS = path.join(__dirname, "..", "selfhost", "worker", "migrations");
const TOKEN = "123456:TEST-bot-token-not-real-xyz";
const NOW = Date.parse("2026-10-05T06:00:00Z");
const HOUR = 3600e3;
const CHAT = 777001;
const ORIGIN = "https://worker.test";

let mod, tg, createD1;
const tgCalls = [];
test.before(async () => {
  mod = await import("../selfhost/worker/src/index.js");
  tg = await import("../selfhost/worker/src/telegram.js");
  ({ createD1 } = await import("../selfhost/worker/testing/fake-d1.js"));
});
test.after(() => tg.setFetchForTests(null));

function fakeTelegram({ setWebhookOk = true } = {}) {
  tgCalls.length = 0;
  tg.setFetchForTests(async (url, init) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    tgCalls.push({ method, body });
    if (method === "setWebhook") return new Response(JSON.stringify({ ok: setWebhookOk, result: setWebhookOk }), { status: setWebhookOk ? 200 : 400 });
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { username: "Test_Bot" } }), { status: 200 });
    if (method === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: `${ORIGIN}/telegram/webhook`, pending_update_count: 0 } }), { status: 200 });
    return new Response('{"ok":true}', { status: 200 });
  });
}

const env = () => ({ DB: createD1({ migrationsDir: MIGRATIONS }), TELEGRAM_BOT_TOKEN: TOKEN });

async function call(e, pathname, { method = "GET", form, json: body, headers = {}, now = NOW } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) { init.headers["content-type"] = "application/x-www-form-urlencoded"; init.body = new URLSearchParams(form).toString(); }
  if (body) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await mod.handle(new Request(`${ORIGIN}${pathname}`, init), e, now, { waitUntil() {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const setting = (e, k) => { const r = e.DB.sqlite.prepare("SELECT v FROM settings WHERE k = ?").get(k); return r ? r.v : undefined; };

function secretsFrom(html) {
  return {
    code: (html.match(/\/start ([A-Z2-9]{10})/) || [])[1],
    key: (html.match(/<code>(tp_[A-Za-z0-9_-]+)<\/code>/) || [])[1],
    cal: (html.match(/<code>(https:\/\/[^<]+\.ics)<\/code>/) || [])[1],
  };
}

async function claimed() {
  const e = env();
  fakeTelegram();
  const r = await call(e, "/setup", { method: "POST", form: { token: TOKEN } });
  assert.strictEqual(r.status, 200, r.text.slice(0, 200));
  return { e, ...secretsFrom(r.text) };
}

function update(text, chatId = CHAT) {
  return { update_id: 1, message: { message_id: 1, chat: { id: chatId, type: "private" }, text } };
}

async function hook(e, text, secret, now = NOW) {
  const r = await call(e, "/telegram/webhook", { method: "POST", json: update(text), headers: { "x-telegram-bot-api-secret-token": secret }, now });
  return JSON.parse(r.text);
}

// The webhook secret is only sent to Telegram (setWebhook); tests read it from the fake.
const webhookSecret = () => tgCalls.find((c) => c.method === "setWebhook").body.secret_token;

// ── /setup ────────────────────────────────────────────────────────────────

test("setup: GET shows the token form with a strict CSP; without the bot token secret → 503", async () => {
  const r = await call(env(), "/setup");
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /name="token"/);
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.strictEqual(r.headers.get("cache-control"), "no-store");
  assert.ok(!/<script/i.test(r.text));
  assert.strictEqual((await call({ DB: createD1({ migrationsDir: MIGRATIONS }) }, "/setup")).status, 503);
});

test("setup: wrong token → 401 and counted; the 6th attempt in 15 min → 429; window resets", async () => {
  const e = env();
  fakeTelegram();
  for (let i = 1; i <= 5; i++) assert.strictEqual((await call(e, "/setup", { method: "POST", form: { token: "nope" } })).status, 401);
  assert.strictEqual((await call(e, "/setup", { method: "POST", form: { token: TOKEN } })).status, 429, "even the right token is refused while limited");
  assert.strictEqual(setting(e, "claimed"), undefined);
  assert.strictEqual((await call(e, "/setup", { method: "POST", form: { token: TOKEN }, now: NOW + 16 * 60e3 })).status, 200);
});

test("setup: success claims once, stores only hashes, registers the webhook, shows secrets once", async () => {
  const { e, code, key, cal } = await claimed();
  assert.ok(code && key && cal, "page shows code, key and calendar URL");
  const hookCall = tgCalls.find((c) => c.method === "setWebhook");
  assert.deepStrictEqual(Object.keys(hookCall.body).sort(), ["allowed_updates", "drop_pending_updates", "secret_token", "url"]);
  assert.strictEqual(hookCall.body.url, `${ORIGIN}/telegram/webhook`);
  const all = e.DB.sqlite.prepare("SELECT k, v FROM settings").all().map((r) => `${r.k}=${r.v}`).join("\n");
  for (const secret of [key, code, cal.split("/cal/")[1].replace(".ics", ""), hookCall.body.secret_token, TOKEN]) {
    assert.ok(!all.includes(secret), "no secret stored in clear");
  }
  assert.strictEqual(setting(e, "webhook_set"), "1");
  assert.strictEqual((await call(e, "/setup", { method: "POST", form: { token: TOKEN } })).status, 410, "second claim refused");
  const again = await call(e, "/setup");
  assert.ok(!again.text.includes(key) && !again.text.includes(code), "secrets never shown again");
  assert.deepStrictEqual(JSON.parse((await call(e, "/health")).text), { claimed: true, bot_token_set: true, webhook_set: true, migrated: true });
});

test("setup: if Telegram rejects the webhook nothing stays claimed", async () => {
  const e = env();
  fakeTelegram({ setWebhookOk: false });
  assert.strictEqual((await call(e, "/setup", { method: "POST", form: { token: TOKEN } })).status, 502);
  assert.strictEqual(e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM settings").get().n, 0);
  fakeTelegram();
  assert.strictEqual((await call(e, "/setup", { method: "POST", form: { token: TOKEN } })).status, 200);
});

test("setup: the secret token, key and logs never echo the bot token", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let html;
  try {
    const e = env();
    fakeTelegram();
    await call(e, "/setup", { method: "POST", form: { token: "wrong" } });
    html = (await call(e, "/setup", { method: "POST", form: { token: TOKEN } })).text;
  } finally { console.log = orig; }
  assert.ok(!html.includes(TOKEN));
  for (const l of lines) assert.ok(!l.includes(TOKEN) && !l.includes("tp_"), l);
});

test("setup/pair: a new pairing code needs the ingest key; refused once paired", async () => {
  const { e, key } = await claimed();
  assert.strictEqual((await call(e, "/setup/pair", { method: "POST", form: { key: "tp_wrongwrongwrongwrongwrong" } })).status, 401);
  const r = await call(e, "/setup/pair", { method: "POST", form: { key } });
  assert.strictEqual(r.status, 200);
  const code = secretsFrom(r.text).code;
  assert.ok(code);
  const reply = await hook(e, `/start ${code}`, webhookSecret());
  assert.match(reply.text, /^Paired/);
  assert.strictEqual((await call(e, "/setup/pair", { method: "POST", form: { key } })).status, 409);
});

// ── end to end ────────────────────────────────────────────────────────────

test("e2e: setup → pair → ingest a moved due date → alert → calendar → rotate → doctor → deleteall", async () => {
  const { e, code, key, cal } = await claimed();
  const secret = webhookSecret();
  assert.match((await hook(e, `/start ${code}`, secret)).text, /^Paired/);

  const send = (syncId, due, now) => call(e, "/api/ingest", { method: "POST", now, headers: { authorization: `Bearer ${key}` },
    json: { v: 1, syncId, class: "Synthetic Class (V1)", tabs: ["Upcoming", "Past due", "Completed"], postsCaptured: true,
      assignments: [{ assignmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", title: "Lab; report, part\\1", tab: "Upcoming", dueIso: due }], posts: [] } });
  assert.strictEqual((await send("sync-0001", "2026-10-10T17:59:00.000Z", NOW)).status, 200);
  tgCalls.length = 0;
  assert.strictEqual((await send("sync-0002", "2026-10-12T17:59:00.000Z", NOW + HOUR)).status, 200);
  await mod.default.scheduled({ scheduledTime: NOW + HOUR + 60e3 }, e);
  const alert = tgCalls.find((c) => c.method === "sendMessage");
  assert.ok(alert, "alert sent by the cron");
  assert.strictEqual(alert.body.chat_id, CHAT);
  assert.match(alert.body.text, /Due date changed/);

  const calPath = cal.replace(ORIGIN, "");
  const ics = await call(e, calPath);
  assert.strictEqual(ics.status, 200);
  assert.match(ics.headers.get("content-type"), /^text\/calendar/);
  assert.match(ics.text, /UID:0f8fad5b-d9cb-469f-a165-70867728950e@teamspulse\.local\r\n/);
  assert.match(ics.text, /SUMMARY:Lab\\; report\\, part\\\\1 \(Synthetic Class \(V1\)\)\r\n/, "RFC 5545 escaping");
  assert.match(ics.text, /DTEND:20261012T175900Z/);
  assert.strictEqual((await call(e, "/cal/wrongtokenwrongtokenwrongtoken.ics")).status, 404);

  const rot = await hook(e, "/rotatecal", secret, NOW + 2 * HOUR);
  const newCal = rot.text.match(/(https:\/\/\S+\.ics)/)[1];
  assert.strictEqual((await call(e, calPath)).status, 404, "old calendar URL revoked");
  assert.strictEqual((await call(e, newCal.replace(ORIGIN, ""))).status, 200);

  const rk = await hook(e, "/rotatekey", secret, NOW + 2 * HOUR);
  const newKey = rk.text.match(/(tp_[A-Za-z0-9_-]+)/)[1];
  assert.strictEqual((await send("sync-0003", "2026-10-12T17:59:00.000Z", NOW + 2 * HOUR)).status, 401, "old key refused at once in this isolate");
  const ok = await call(e, "/api/ingest", { method: "POST", now: NOW + 2 * HOUR, headers: { authorization: `Bearer ${newKey}` },
    json: { v: 1, syncId: "sync-0004", class: "Synthetic Class (V1)", tabs: [], postsCaptured: false, assignments: [], posts: [] } });
  assert.strictEqual(ok.status, 200);

  const doc = await hook(e, "/doctor", secret, NOW + 2 * HOUR);
  assert.match(doc.text, /✅ Database/);
  assert.match(doc.text, /✅ Telegram webhook/);
  assert.match(doc.text, /✅ Last sync 0 min ago/);
  assert.match(doc.text, /❌ Reminder timer ran 59 min ago — check Triggers/, "last cron run is older than 15 min");
  assert.ok(!doc.text.includes("Lab") && !doc.text.includes(newKey) && !doc.text.includes(TOKEN), "no content, no secrets");

  assert.match((await hook(e, "/deleteall", secret, NOW + 3 * HOUR)).text, /cannot be undone[\s\S]*\/deleteall [A-Z2-9]{6}/);
  assert.strictEqual(e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM items").get().n, 1);
  assert.match((await hook(e, "/deleteall WRONG1", secret, NOW + 3 * HOUR)).text, /To confirm/, "wrong code deletes nothing");
  const confirm2 = (await hook(e, "/deleteall", secret, NOW + 3 * HOUR)).text.match(/\/deleteall ([A-Z2-9]{6})/)[1];
  assert.match((await hook(e, `/deleteall ${confirm2}`, secret, NOW + 3 * HOUR)).text, /^Deleted \d+ stored rows/);
  for (const t of ["items", "events", "reminders_sent", "syncs", "classes"]) {
    assert.strictEqual(e.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
  assert.strictEqual(setting(e, "chat_id"), String(CHAT), "pairing kept");
  assert.ok(setting(e, "ingest_key_hash"), "key kept");
  assert.match((await hook(e, "/today", secret, NOW + 3 * HOUR)).text, /Last synced: never/);
});

test("deleteall: an expired confirmation code deletes nothing", async () => {
  const { e, code } = await claimed();
  const secret = webhookSecret();
  await hook(e, `/start ${code}`, secret);
  e.DB.sqlite.prepare("INSERT INTO items (key, kind, class, title, first_seen) VALUES ('a:id:x', 'a', 'C', 'T', 0)").run();
  const c = (await hook(e, "/deleteall", secret)).text.match(/\/deleteall ([A-Z2-9]{6})/)[1];
  await hook(e, `/deleteall ${c}`, secret, NOW + 6 * 60e3);
  assert.strictEqual(e.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM items").get().n, 1);
});
