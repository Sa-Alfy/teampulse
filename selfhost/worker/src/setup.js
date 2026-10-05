// First-run setup (/setup) and pairing-code reissue (/setup/pair).
//
// Threat model: whoever reaches a fresh instance first could claim it. So
// claiming requires the bot token, which only the student has (it is the
// TELEGRAM_BOT_TOKEN Worker secret). Attempts are rate-limited with a D1
// counter; the claim is atomic (a plain INSERT of 'claimed' — a second claim
// fails the whole batch); afterwards /setup only offers a new pairing code,
// and that needs the ingest key. Secrets are shown once and only hashes are
// stored. Pages have no scripts and a strict CSP.

import configMod from "../../core/config.js";
import authMod from "../../core/auth.js";
import botMod from "../../core/bot.js";
import { log, readCapped } from "./http.js";
import { getSettings } from "./store.js";
import { invalidateKeyCache } from "./routes.js";
import { tgApi } from "./telegram.js";

const { PRODUCT_NAME } = configMod;
const { timingSafeEqual, hashKey, randomSecret, keyMatches } = authMod;
const { makePairCode, PAIR_TTL_MS } = botMod;

export const RATE_WINDOW_MS = 15 * 60e3;
export const RATE_MAX = 5;
const FORM_MAX_BYTES = 4096;
const CLAIM_KEYS = ["claimed", "ingest_key_hash", "tg_secret_hash", "pair_hash", "pair_expires", "pair_fails", "ics_hash", "webhook_set"];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(status, title, bodyHtml) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(PRODUCT_NAME)} setup</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1b1b1b;background:#fff}
code,input{font:15px ui-monospace,monospace}code{background:#f2f2f2;padding:.15rem .35rem;border-radius:4px;word-break:break-all}
input{width:100%;padding:.5rem;box-sizing:border-box}button{padding:.5rem 1rem;margin-top:.5rem}.warn{color:#9a3412}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}code{background:#2a2a2a}}
</style></head><body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

/** Fixed-window counter in D1. Returns the count for this window, including this hit. */
export async function rateHit(db, key, now) {
  const reset = now - RATE_WINDOW_MS;
  const { results } = await db.prepare(
    "INSERT INTO rate (k, window_start, count) VALUES (?, ?, 1) ON CONFLICT(k) DO UPDATE SET " +
    "count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END, " +
    "window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END RETURNING count"
  ).bind(key, now, reset, reset).all();
  return results[0] ? results[0].count : RATE_MAX + 1;
}

async function readForm(request) {
  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  if (!ctype.startsWith("application/x-www-form-urlencoded")) return null;
  const body = await readCapped(request, FORM_MAX_BYTES);
  if (body.tooLarge) return null;
  return new URLSearchParams(body.text);
}

const TOKEN_FORM = `<p>Paste your Telegram bot token (from @BotFather). It proves this is your server; it is compared with the
<code>TELEGRAM_BOT_TOKEN</code> secret and not stored.</p>
<form method="post" action="/setup"><input name="token" type="password" autocomplete="off" required maxlength="200">
<button type="submit">Set up</button></form>`;

const PAIR_FORM = `<p>Need a new Telegram pairing code? Paste your ingest key:</p>
<form method="post" action="/setup/pair"><input name="key" type="password" autocomplete="off" required maxlength="200">
<button type="submit">New pairing code</button></form>`;

function pairBlock(code, botUser) {
  const link = botUser ? `<a href="https://t.me/${esc(botUser)}" rel="noopener noreferrer">@${esc(botUser)}</a>` : "your bot";
  return `<p>Open ${link} in Telegram and send:</p><p><code>/start ${esc(code)}</code></p>
<p>The code works once and expires in ${PAIR_TTL_MS / 60e3} minutes.</p>`;
}

/** GET /setup */
export async function setupPage(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return page(503, "Almost there", "<p>Add the <code>TELEGRAM_BOT_TOKEN</code> secret to this Worker first (step 3 of the guide), then reload this page.</p>");
  }
  const s = await getSettings(env.DB, ["claimed", "chat_id"]);
  if (s.claimed) return page(200, "Already set up", s.chat_id ? "<p>This server is set up and paired with Telegram.</p>" : PAIR_FORM);
  return page(200, `Set up ${PRODUCT_NAME}`, TOKEN_FORM);
}

/** POST /setup */
export async function setupSubmit(request, env, now) {
  const db = env.DB;
  if (!env.TELEGRAM_BOT_TOKEN) return page(503, "Almost there", "<p>Add the <code>TELEGRAM_BOT_TOKEN</code> secret first.</p>");
  if ((await getSettings(db, ["claimed"])).claimed) return page(410, "Already set up", "<p>This server has already been set up.</p>");
  const form = await readForm(request);
  if (!form) return page(400, "Setup failed", "<p>Unexpected form data.</p>");

  const count = await rateHit(db, "setup", now);
  if (count > RATE_MAX) {
    log({ route: "setup", status: 429 });
    return page(429, "Too many attempts", "<p>Wait 15 minutes and try again.</p>");
  }
  const given = String(form.get("token") || "").trim();
  const ok = given.length > 0 && timingSafeEqual(await hashKey(given), await hashKey(env.TELEGRAM_BOT_TOKEN));
  if (!ok) {
    log({ route: "setup", status: 401, attempt: count });
    return page(401, "Setup failed", `<p class="warn">That is not this server's bot token.</p>${TOKEN_FORM}`);
  }

  const origin = new URL(request.url).origin;
  const ingestKey = `tp_${randomSecret(32)}`;
  const tgSecret = randomSecret(32);
  const icsToken = randomSecret(24);
  const code = makePairCode(globalThis.crypto.getRandomValues(new Uint8Array(10)));
  const set = (k, v) => db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, String(v));
  try {
    await db.batch([
      db.prepare("INSERT INTO settings (k, v) VALUES ('claimed', ?)").bind(String(now)), // fails if already claimed
      set("ingest_key_hash", await hashKey(ingestKey)),
      set("tg_secret_hash", await hashKey(tgSecret)),
      set("pair_hash", await hashKey(code)),
      set("pair_expires", now + PAIR_TTL_MS),
      set("pair_fails", 0),
      set("ics_hash", await hashKey(icsToken)),
      set("webhook_set", 0),
    ]);
  } catch {
    log({ route: "setup", status: 409 });
    return page(409, "Already set up", "<p>This server was set up a moment ago.</p>");
  }

  const hook = await tgApi(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
    url: `${origin}/telegram/webhook`, secret_token: tgSecret, allowed_updates: ["message"], drop_pending_updates: true,
  });
  if (!hook.ok) {
    await db.batch([db.prepare(`DELETE FROM settings WHERE k IN (${CLAIM_KEYS.map(() => "?").join(", ")})`).bind(...CLAIM_KEYS)]);
    log({ route: "setup", status: 502, tg: hook.status });
    return page(502, "Setup failed", "<p class=\"warn\">Telegram did not accept the webhook. Check the bot token and try again.</p>");
  }
  await db.batch([set("webhook_set", 1)]);
  invalidateKeyCache(db);
  const me = await tgApi(env.TELEGRAM_BOT_TOKEN, "getMe", {});
  const botUser = me.ok && me.result && /^[A-Za-z0-9_]{1,64}$/.test(me.result.username || "") ? me.result.username : null;
  log({ route: "setup", status: 200 });

  return page(200, "Setup complete", `
<p class="warn"><strong>Copy these now. They are shown only once</strong> (only hashes are stored).</p>
<h2>1. Telegram</h2>${pairBlock(code, botUser)}
<h2>2. Extension key</h2><p>Paste into the extension's Connect settings:</p><p><code>${esc(ingestKey)}</code></p>
<h2>3. Calendar</h2><p>Google Calendar → Other calendars → From URL:</p><p><code>${esc(`${origin}/cal/${icsToken}.ics`)}</code></p>
<p>Keep both secret. In Telegram, <code>/rotatekey</code> and <code>/rotatecal</code> replace them.</p>`);
}

/** POST /setup/pair — new pairing code; needs the ingest key. */
export async function pairSubmit(request, env, now) {
  const db = env.DB;
  const s = await getSettings(db, ["claimed", "chat_id", "ingest_key_hash"]);
  if (!s.claimed) return page(409, "Not set up", "<p>Set up the server first: <a href=\"/setup\">/setup</a>.</p>");
  if (s.chat_id) return page(409, "Already paired", "<p>This server is already paired with a Telegram chat.</p>");
  const form = await readForm(request);
  if (!form) return page(400, "Failed", "<p>Unexpected form data.</p>");
  if (await rateHit(db, "pair", now) > RATE_MAX) return page(429, "Too many attempts", "<p>Wait 15 minutes and try again.</p>");
  if (!(await keyMatches(String(form.get("key") || "").trim(), s.ingest_key_hash))) {
    log({ route: "setup_pair", status: 401 });
    return page(401, "Failed", `<p class="warn">That key does not match.</p>${PAIR_FORM}`);
  }
  const code = makePairCode(globalThis.crypto.getRandomValues(new Uint8Array(10)));
  const set = (k, v) => db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, String(v));
  await db.batch([set("pair_hash", await hashKey(code)), set("pair_expires", now + PAIR_TTL_MS), set("pair_fails", 0)]);
  log({ route: "setup_pair", status: 200 });
  return page(200, "New pairing code", pairBlock(code, null));
}
