// The single cron trigger (every 5 min): plan reminders, queue the daily
// digest, then send the outbox. Reminder / digest events and their
// idempotency rows are written in ONE D1 batch, so a reminder id can enter
// the outbox only once even if two runs overlap.

import configMod from "../../core/config.js";
import remindersMod from "../../core/reminders.js";
import agendaMod from "../../core/agenda.js";
import formatMod from "../../core/format.js";
import scheduleMod from "../../core/schedule.js";
import fpMod from "../../../extension/core/fingerprint.js";
import { log } from "./http.js";
import { REMINDER_CANDIDATES_SQL, INSERT_EVENT_SQL, rowToRecord, prefs } from "./store.js";
import { OPEN_ITEMS_SQL, flushOutbox } from "./telegram.js";

const { HOUR, REMINDER_SLOTS } = configMod;
const { planReminders, reminderId } = remindersMod;
const { selectWeek } = agendaMod;
const { eventPriority, formatDigestBody } = formatMod;
const { digestDue } = scheduleMod;
const { sha256Hex } = fpMod;

const KEY_CHUNK = 50;
const CRON_KEYS = ["tz", "quiet", "chat_id", "last_sync_at", "digest_time", "last_digest_day"];

function eventRow(db, id, type, itemKey, now, payload) {
  const priority = eventPriority({ type, payload });
  // Reminders are only planned outside quiet hours (24h) or ignore them (3h); the digest
  // goes out at its own time — so every cron event is due now.
  return db.prepare(INSERT_EVENT_SQL).bind(id, type, itemKey, now, JSON.stringify(payload), priority, now);
}

export async function runCron(env, now) {
  const db = env.DB;
  const [settingsRes, candRes] = await db.batch([
    db.prepare(`SELECT k, v FROM settings WHERE k IN (${CRON_KEYS.map(() => "?").join(", ")})`).bind(...CRON_KEYS),
    db.prepare(REMINDER_CANDIDATES_SQL).bind(now, now + 24 * HOUR),
  ]);
  const s = Object.fromEntries(settingsRes.results.map((r) => [r.k, r.v]));
  const heartbeat = db.prepare("INSERT INTO settings (k, v) VALUES ('last_cron_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(now));
  if (!s.chat_id) {
    // Unpaired: nothing would be delivered, and queued reminders would go out stale later.
    await db.batch([heartbeat]);
    log({ route: "cron", paired: false });
    return { reminders: 0, digest: false, sent: 0 };
  }
  const p = prefs(s);
  const candidates = candRes.results.map(rowToRecord);

  // Reminder ids already used: every possible id of the candidates, looked up by primary key.
  const sent = new Set();
  const ids = candidates.filter((r) => r.dueIso).flatMap((r) => REMINDER_SLOTS.map(({ slot }) => reminderId(r.key, r.dueIso, slot)));
  if (ids.length) {
    const stmts = [];
    for (let i = 0; i < ids.length; i += KEY_CHUNK) {
      const chunk = ids.slice(i, i + KEY_CHUNK);
      stmts.push(db.prepare(`SELECT id FROM reminders_sent WHERE id IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk));
    }
    for (const res of await db.batch(stmts)) for (const r of res.results) sent.add(r.id);
  }
  const planned = planReminders(candidates, sent, now, { tz: p.tz, quiet: p.quiet });

  const writes = [];
  for (const r of planned) {
    const id = await sha256Hex(`reminder\0${r.id}`);
    writes.push(db.prepare("INSERT INTO reminders_sent (id, item_key, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").bind(r.id, r.itemKey, now));
    writes.push(eventRow(db, id, "reminder", r.itemKey, now,
      { slot: r.slot, kind: r.kind, title: r.title, class: r.class, dueIso: r.dueIso }));
  }

  const dg = digestDue(now, p.tz, s.digest_time, s.last_digest_day);
  if (dg.due) {
    const items = (await db.prepare(OPEN_ITEMS_SQL).all()).results.map(rowToRecord);
    const text = formatDigestBody(selectWeek(items, now, p.tz), { now, tz: p.tz });
    writes.push(eventRow(db, await sha256Hex(`digest\0${dg.day}`), "digest", null, now, { text, day: dg.day }));
    writes.push(db.prepare("INSERT INTO settings (k, v) VALUES ('last_digest_day', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(dg.day));
  }
  writes.push(heartbeat); // /doctor: "reminder timer ran N min ago"
  await db.batch(writes);

  const out = await flushOutbox(env, now);
  log({ route: "cron", candidates: candidates.length, reminders: planned.length, digest: dg.due, sent: out.sent, failed: out.failed });
  return { reminders: planned.length, digest: dg.due, sent: out.sent };
}
