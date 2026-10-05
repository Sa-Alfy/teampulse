// Telegram adapter: webhook (pairing + commands) and the outbox sender.
// The bot token lives only in env.TELEGRAM_BOT_TOKEN (a Worker secret); it is
// never logged, stored in D1 or returned. Messages are plain text (no parse_mode).

import botMod from "../../core/bot.js";
import authMod from "../../core/auth.js";
import { json, error, log, readCapped } from "./http.js";
import { COLS, rowToRecord, getSettings, prefs } from "./store.js";

const { parseCommand, reply, HELP, normalizePairCode, pairingOpen, buildAlertMessages, PAIR_MAX_FAILS } = botMod;
const { timingSafeEqual, hashKey } = authMod;

const WEBHOOK_MAX_BYTES = 64 * 1024;
const SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;   // Telegram's secret_token charset
const CLAIM_LEASE_MS = 2 * 60e3;
const MAX_ATTEMPTS = 8;
const OUTBOX_BATCH = 50;
const MAX_MESSAGES_PER_FLUSH = 10;            // stays far below the 50 external subrequests

export const OPEN_ITEMS_SQL = `SELECT ${COLS} FROM items WHERE kind = 'a' AND removed_at IS NULL AND submitted = 0`;
export const OUTBOX_SQL =
  "SELECT id, type, payload FROM events WHERE sent_at IS NULL AND not_before <= ? AND attempts < ? " +
  "AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY not_before, id LIMIT ?";

let fetchImpl = (...a) => fetch(...a);
/** Tests replace the network call. */
export function setFetchForTests(f) {
  fetchImpl = f || ((...a) => fetch(...a));
}

const WEBHOOK_KEYS = ["tg_secret_hash", "chat_id", "pair_hash", "pair_expires", "pair_fails", "last_sync_at", "tz", "quiet", "list_due", "list_undone", "digest_time"];

function setStmt(db, k, v) {
  return db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, String(v));
}

function delStmt(db, keys) {
  return db.prepare(`DELETE FROM settings WHERE k IN (${keys.map(() => "?").join(", ")})`).bind(...keys);
}

function parseList(v) {
  try { const x = JSON.parse(v); return x && Array.isArray(x.keys) ? x : null; } catch { return null; }
}

/** Answer in the webhook response itself (no extra subrequest). */
function answer(chatId, text) {
  return json(200, { method: "sendMessage", chat_id: chatId, text, link_preview_options: { is_disabled: true } });
}

const NOTHING = () => json(200, {});

/** POST /telegram/webhook */
export async function webhook(request, env, now) {
  const header = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!SECRET_RE.test(header)) return error(401, "unauthorized"); // before any D1 read
  const db = env.DB;
  const s = await getSettings(db, WEBHOOK_KEYS);
  if (!s.tg_secret_hash) return error(503, "not_configured");
  if (!timingSafeEqual(await hashKey(header), s.tg_secret_hash)) return error(401, "unauthorized");

  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  if (!/^application\/json(\s*;|$)/.test(ctype)) return error(415, "unsupported_media_type");
  const body = await readCapped(request, WEBHOOK_MAX_BYTES);
  if (body.tooLarge) return error(413, "payload_too_large");
  let update;
  try { update = JSON.parse(body.text); } catch { return error(400, "bad_json"); }

  const msg = update && update.message;
  const chat = msg && msg.chat;
  if (!chat || chat.type !== "private" || !Number.isSafeInteger(chat.id) || typeof msg.text !== "string") return NOTHING();
  const c = parseCommand(msg.text);

  // ── not paired yet: only /start <code> ──
  if (!s.chat_id) {
    if (!c || c.cmd !== "start") return NOTHING();
    const pairing = { hash: s.pair_hash, expiresAt: s.pair_expires, fails: s.pair_fails };
    if (!pairingOpen(pairing, now)) {
      log({ route: "telegram", pair: "closed" });
      return answer(chat.id, "No pairing code is active. Open the setup page of your server to get one.");
    }
    const code = normalizePairCode(c.arg);
    const ok = !!code && timingSafeEqual(await hashKey(code), s.pair_hash);
    if (!ok) {
      const fails = Number(s.pair_fails || 0) + 1;
      await db.batch(fails >= PAIR_MAX_FAILS
        ? [delStmt(db, ["pair_hash", "pair_expires", "pair_fails"])]
        : [setStmt(db, "pair_fails", fails)]);
      log({ route: "telegram", pair: "fail", fails });
      return answer(chat.id, fails >= PAIR_MAX_FAILS
        ? "Too many wrong codes. This code is now disabled; create a new one on the setup page."
        : "That pairing code is wrong or expired.");
    }
    await db.batch([setStmt(db, "chat_id", chat.id), delStmt(db, ["pair_hash", "pair_expires", "pair_fails"])]);
    log({ route: "telegram", pair: "ok" });
    return answer(chat.id, `Paired ✅ This chat now receives alerts and reminders.\n\n${HELP}`);
  }

  // ── paired: everyone else is ignored without a reply or a write ──
  if (String(chat.id) !== s.chat_id) {
    log({ route: "telegram", ignored: "chat" });
    return NOTHING();
  }
  if (!c) return answer(chat.id, HELP);
  if (c.cmd === "start") return answer(chat.id, `Already paired.\n\n${HELP}`);
  if (ADMIN[c.cmd]) {
    const text = await ADMIN[c.cmd]({ c, db, env, s, now, origin: new URL(request.url).origin });
    log({ route: "telegram", cmd: c.cmd });
    return answer(chat.id, text);
  }

  const { tz } = prefs(s);
  const needsItems = ["today", "week", "due", "plan", "done", "undone"].includes(c.cmd);
  const items = needsItems ? (await db.prepare(OPEN_ITEMS_SQL).all()).results.map(rowToRecord) : [];
  const out = reply(c, {
    items, now, tz, lastSyncAt: s.last_sync_at ? Number(s.last_sync_at) : null,
    lists: { due: parseList(s.list_due), undone: parseList(s.list_undone) }, digest: s.digest_time,
  });
  const stmts = [];
  for (const w of out.writes) stmts.push(db.prepare("UPDATE items SET done_at = ? WHERE key = ? AND kind = 'a'").bind(w.doneAt ?? null, w.key));
  if (out.lists.due) stmts.push(setStmt(db, "list_due", JSON.stringify(out.lists.due)));
  if (out.lists.undone) stmts.push(setStmt(db, "list_undone", JSON.stringify(out.lists.undone)));
  for (const [k, v] of Object.entries(out.settings || {})) stmts.push(setStmt(db, k, v));
  if (stmts.length) await db.batch(stmts);
  log({ route: "telegram", cmd: c.cmd.slice(0, 12), items: items.length, writes: out.writes.length });
  return answer(chat.id, out.text);
}

// ── admin commands (paired chat only): /doctor /rotatekey /rotatecal /deleteall ──

const DELETE_TTL_MS = 5 * 60e3;
const DATA_TABLES = ["items", "events", "reminders_sent", "syncs", "classes"];
const DATA_SETTINGS = ["last_sync_at", "list_due", "list_undone", "last_digest_day", "delete_confirm", "delete_expires"];

const ADMIN = {
  async doctor({ db, env, s, now }) {
    const [counts] = await db.batch([db.prepare(
      "SELECT (SELECT COUNT(*) FROM items WHERE kind = 'a' AND removed_at IS NULL AND submitted = 0) AS open, " +
      "(SELECT COUNT(*) FROM events WHERE sent_at IS NULL AND not_before <= ?) AS waiting, " +
      "(SELECT COUNT(*) FROM events WHERE sent_at IS NULL AND attempts >= ?) AS failed"
    ).bind(now - 30 * 60e3, MAX_ATTEMPTS)]);
    const c = counts.results[0];
    const extra = await getSettings(db, ["webhook_set", "last_cron_at", "digest_time", "quiet"]);
    const info = env.TELEGRAM_BOT_TOKEN ? await tgApi(env.TELEGRAM_BOT_TOKEN, "getWebhookInfo", {}) : { ok: false };
    const hookErr = info.ok && info.result && info.result.last_error_date && now / 1000 - info.result.last_error_date < 3600;
    return botMod.formatDoctor({
      now, tz: prefs(s).tz,
      botToken: !!env.TELEGRAM_BOT_TOKEN,
      webhook: extra.webhook_set === "1" && info.ok && !!(info.result && info.result.url) && !hookErr,
      lastSyncAt: s.last_sync_at ? Number(s.last_sync_at) : null,
      lastCronAt: extra.last_cron_at ? Number(extra.last_cron_at) : null,
      open: c.open, waiting: c.waiting, failed: c.failed,
      digest: extra.digest_time, quiet: extra.quiet,
    });
  },

  async rotatekey({ db, now }) {
    const key = `tp_${authMod.randomSecret(32)}`;
    await db.batch([setStmt(db, "ingest_key_hash", await hashKey(key))]);
    invalidate(db);
    log({ route: "telegram", rotated: "key", at: now });
    return `New extension key (paste it into the extension's Connect settings):\n\n${key}\n\nThe old key stops working within 1 minute. Delete this message after copying.`;
  },

  async rotatecal({ db, origin }) {
    const token = authMod.randomSecret(24);
    await db.batch([setStmt(db, "ics_hash", await hashKey(token))]);
    return `New calendar URL (the old one stops working now):\n\n${origin}/cal/${token}.ics\n\nIn Google Calendar, remove the old calendar and add this URL under Other calendars → From URL.`;
  },

  async deleteall({ c, db, now }) {
    const pending = await getSettings(db, ["delete_confirm", "delete_expires"]);
    if (c.arg && pending.delete_confirm && Number(pending.delete_expires) > now && c.arg.toUpperCase() === pending.delete_confirm) {
      const stmts = DATA_TABLES.map((t) => db.prepare(`DELETE FROM ${t}`));
      stmts.push(delStmt(db, DATA_SETTINGS));
      const res = await db.batch(stmts);
      const n = res.slice(0, DATA_TABLES.length).reduce((sum, r) => sum + ((r.meta && r.meta.changes) || 0), 0);
      log({ route: "telegram", deleted: n });
      return `Deleted ${n} stored rows (assignments, posts, alerts, reminders, sync history).\nYour keys, calendar URL and this Telegram pairing are kept. The extension uploads again on its next sync — disconnect it first if you want it to stop.`;
    }
    const code = botMod.makePairCode(globalThis.crypto.getRandomValues(new Uint8Array(10))).slice(0, 6);
    await db.batch([setStmt(db, "delete_confirm", code), setStmt(db, "delete_expires", now + DELETE_TTL_MS)]);
    return `This deletes ALL assignments, posts, alerts and reminders stored on your server. It cannot be undone.\n\nTo confirm, send within 5 minutes:\n/deleteall ${code}`;
  },
};

let invalidate = () => {};
/** routes.js registers its key-cache invalidation here (avoids an import cycle). */
export function onKeyRotated(fn) {
  invalidate = fn;
}

/** Call a Bot API method. Returns { ok, status, result } — never throws, never logs the token. */
export async function tgApi(token, method, body) {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(10e3),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.ok === true, status: res.status, result: data.result };
  } catch (e) {
    return { ok: false, status: 0, err: e && e.name ? String(e.name) : "Error" };
  }
}

function sendMessage(token, chatId, text) {
  return tgApi(token, "sendMessage", { chat_id: Number(chatId), text, link_preview_options: { is_disabled: true } });
}

/**
 * Send due outbox rows. A row counts as sent only after Telegram answers
 * ok: true. Rows are claimed first (2 min lease) so two flushes never send
 * the same row at once; a failed send is retried after the lease, up to
 * MAX_ATTEMPTS. Without a paired chat or a bot token nothing is sent.
 */
export async function flushOutbox(env, now) {
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const s = await getSettings(db, ["chat_id", "last_sync_at", "tz", "quiet"]);
  if (!token || !s.chat_id) {
    log({ route: "outbox", sent: 0, reason: token ? "not_paired" : "no_token" });
    return { sent: 0, failed: 0 };
  }
  const { results: due } = await db.prepare(OUTBOX_SQL).bind(now, MAX_ATTEMPTS, now - CLAIM_LEASE_MS, OUTBOX_BATCH).all();
  if (!due.length) return { sent: 0, failed: 0 };

  const ids = due.map((r) => r.id);
  const { results: claimed } = await db.prepare(
    `UPDATE events SET claimed_at = ?, attempts = attempts + 1 WHERE id IN (${ids.map(() => "?").join(", ")}) ` +
    "AND sent_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?) RETURNING id"
  ).bind(now, ...ids, now - CLAIM_LEASE_MS).all();
  const mine = new Set(claimed.map((r) => r.id));
  const rows = due.filter((r) => mine.has(r.id)).map((r) => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload) }));

  const { tz } = prefs(s);
  const messages = buildAlertMessages(rows, { now, tz, lastSyncAt: s.last_sync_at ? Number(s.last_sync_at) : null });
  const done = [];
  let sent = 0;
  let failed = 0;
  const statuses = [];
  for (const m of messages) {
    if (m.text === null) { done.push(...m.ids); continue; }
    if (sent + failed >= MAX_MESSAGES_PER_FLUSH) break;   // the rest waits for the next flush
    const r = await sendMessage(token, s.chat_id, m.text);
    if (r.ok) { sent++; done.push(...m.ids); } else { failed++; statuses.push(r.status); }
    if (!r.ok && r.status === 429) break;                  // rate limited: stop this flush
  }
  if (done.length) {
    await db.batch([db.prepare(`UPDATE events SET sent_at = ? WHERE id IN (${done.map(() => "?").join(", ")})`).bind(now, ...done)]);
  }
  log({ route: "outbox", rows: rows.length, sent, failed, statuses });
  return { sent, failed };
}
