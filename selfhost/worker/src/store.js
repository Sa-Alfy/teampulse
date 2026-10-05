// D1 data layer: row <-> record mapping, state loading, the single write batch.
// SQL text is constant; every value goes through bind() (never string-built).

import configMod from "../../core/config.js";
import timeMod from "../../core/time.js";
import formatMod from "../../core/format.js";

const { DEFAULT_TZ, DEFAULT_QUIET } = configMod;
const { isValidTimeZone, quietEndsAt, parseHHMM } = timeMod;
const { eventPriority } = formatMod;

export const COLS = "key, kind, class, title, body, due_iso, due_ms, tab, submitted, tag, ts, first_seen, missing_sync_id, missing_at, removed_at, done_at";
const N_COLS = COLS.split(",").length;
const PLACEHOLDERS = Array(N_COLS).fill("?").join(", ");
const UPDATES = COLS.split(",").map((c) => c.trim()).filter((c) => c !== "key").map((c) => `${c} = excluded.${c}`).join(", ");

export const UPSERT_ITEM_SQL = `INSERT INTO items (${COLS}) VALUES (${PLACEHOLDERS}) ON CONFLICT(key) DO UPDATE SET ${UPDATES}`;
export const LOAD_CLASS_SQL = `SELECT ${COLS} FROM items WHERE class = ? AND kind = 'a' AND removed_at IS NULL`;
// S4 reminder cron: open assignments due in (now, now + 24 h]. Uses items_open_due.
export const REMINDER_CANDIDATES_SQL = `SELECT ${COLS} FROM items WHERE kind = 'a' AND removed_at IS NULL AND submitted = 0 AND due_ms > ? AND due_ms <= ?`;

const KEY_CHUNK = 50; // stays under D1's bound-parameter limit per statement

export function rowToRecord(r) {
  return {
    key: r.key, kind: r.kind, class: r.class, title: r.title,
    body: r.body ?? undefined, dueIso: r.due_iso ?? null, tab: r.tab ?? null,
    submitted: r.submitted === 1, tag: r.tag ?? undefined, ts: r.ts ?? null,
    firstSeen: r.first_seen, missingSyncId: r.missing_sync_id ?? null, missingAt: r.missing_at ?? null,
    removedAt: r.removed_at ?? null, doneAt: r.done_at ?? null,
  };
}

function recordParams(x) {
  const dueMs = x.dueIso ? Date.parse(x.dueIso) : NaN;
  return [
    x.key, x.kind, x.class, x.title ?? "", x.body ?? null, x.dueIso ?? null,
    Number.isNaN(dueMs) ? null : dueMs, x.tab ?? null, x.submitted ? 1 : 0, x.tag ?? null, x.ts ?? null,
    x.firstSeen, x.missingSyncId ?? null, x.missingAt ?? null, x.removedAt ?? null, x.doneAt ?? null,
  ];
}

export async function getSettings(db, keys) {
  const { results } = await db.prepare(`SELECT k, v FROM settings WHERE k IN (${keys.map(() => "?").join(", ")})`).bind(...keys).all();
  return Object.fromEntries(results.map((r) => [r.k, r.v]));
}

/** Timezone and quiet hours from settings, with safe defaults. */
export function prefs(settings) {
  const tz = settings.tz && isValidTimeZone(settings.tz) ? settings.tz : DEFAULT_TZ;
  let quiet = DEFAULT_QUIET;
  if (settings.quiet === "off") quiet = null;
  else if (settings.quiet) {
    try {
      const q = JSON.parse(settings.quiet);
      if (parseHHMM(q.start) !== null && parseHHMM(q.end) !== null) quiet = { start: q.start, end: q.end };
    } catch { /* keep default */ }
  }
  return { tz, quiet };
}

/**
 * Previous state for one class: its baseline flags, its live assignments, any
 * snapshot/post keys stored elsewhere (moved class, removed, known posts), and
 * the tz / quiet settings. Two read round trips at most.
 */
export async function loadPrev(db, cls, keys) {
  const [classRes, itemsRes, settingsRes] = await db.batch([
    db.prepare("SELECT a_baselined, p_baselined FROM classes WHERE name = ?").bind(cls),
    db.prepare(LOAD_CLASS_SQL).bind(cls),
    db.prepare("SELECT k, v FROM settings WHERE k IN ('tz', 'quiet')"),
  ]);
  const row = classRes.results[0];
  const items = new Map(itemsRes.results.map((r) => [r.key, rowToRecord(r)]));
  const rest = [...new Set(keys)].filter((k) => !items.has(k));
  if (rest.length) {
    const stmts = [];
    for (let i = 0; i < rest.length; i += KEY_CHUNK) {
      const chunk = rest.slice(i, i + KEY_CHUNK);
      stmts.push(db.prepare(`SELECT ${COLS} FROM items WHERE key IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk));
    }
    for (const res of await db.batch(stmts)) for (const r of res.results) items.set(r.key, rowToRecord(r));
  }
  return {
    classes: row ? { [cls]: { a: row.a_baselined === 1, p: row.p_baselined === 1 } } : {},
    items,
    settings: Object.fromEntries(settingsRes.results.map((r) => [r.k, r.v])),
  };
}

/** Outbox row for an event: high priority goes out now, normal waits for quiet hours to end. */
function eventParams(ev, at, p) {
  const priority = eventPriority(ev);
  const notBefore = priority === "high" ? at : quietEndsAt(at, p.tz, p.quiet);
  return [ev.id, ev.type, ev.itemKey ?? null, at, JSON.stringify(ev.payload ?? {}), priority, notBefore];
}

export const INSERT_EVENT_SQL = "INSERT INTO events (id, type, item_key, created_at, payload, priority, not_before) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING";

/**
 * Everything one ingest call changes, in ONE D1 batch (D1 runs a batch as a
 * single transaction): item upserts, events, class baseline, sync row, last sync time.
 */
export function writeStatements(db, { cls, classState, upserts, events, syncId, at, prefs: p }) {
  const stmts = [];
  for (const u of upserts) stmts.push(db.prepare(UPSERT_ITEM_SQL).bind(...recordParams(u)));
  for (const ev of events) stmts.push(db.prepare(INSERT_EVENT_SQL).bind(...eventParams(ev, at, p)));
  stmts.push(db.prepare(
    "INSERT INTO classes (name, a_baselined, p_baselined, last_sync_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(name) DO UPDATE SET a_baselined = excluded.a_baselined, p_baselined = excluded.p_baselined, last_sync_at = excluded.last_sync_at"
  ).bind(cls, classState.a ? 1 : 0, classState.p ? 1 : 0, at));
  stmts.push(db.prepare(
    "INSERT INTO syncs (id, first_at, last_at, calls) VALUES (?, ?, ?, 1) " +
    "ON CONFLICT(id) DO UPDATE SET last_at = excluded.last_at, calls = calls + 1"
  ).bind(syncId, at, at));
  stmts.push(db.prepare(
    "INSERT INTO settings (k, v) VALUES ('last_sync_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  ).bind(String(at)));
  return stmts;
}
