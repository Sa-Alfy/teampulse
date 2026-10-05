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

async function sendMessage(token, chatId, text) {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10e3),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.ok === true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, err: e && e.name ? String(e.name) : "Error" };
  }
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
