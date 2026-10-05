// HTTP routes: POST /api/ingest, GET /api/events, GET /health.

import diffMod from "../../core/diff.js";
import validateMod from "../../core/validate.js";
import authMod from "../../core/auth.js";
import { json, error, log, readCapped } from "./http.js";
import { getSettings, prefs, loadPrev, writeStatements } from "./store.js";
import { flushOutbox } from "./telegram.js";

// A few events go out right away; bigger batches wait for the 5-minute cron (S4)
// so one ingest call never formats and sends a large outbox inside its CPU budget.
const FLUSH_INLINE_MAX = 5;

const { diffSync, assignmentKey, postKey } = diffMod;
const { validateIngest, LIMITS } = validateMod;
const { bearerToken, keyMatches } = authMod;

// Stored key hash, cached per D1 binding in this isolate. A key set or rotated
// from another isolate takes effect here within KEY_CACHE_MS. "Not set" is
// cached too, so an unclaimed instance isn't a free D1 read per request.
const KEY_CACHE_MS = 60e3;
const keyCache = new WeakMap();

/** Drop the cached hash (call after /setup or /rotatekey in this isolate). */
export function invalidateKeyCache(db) {
  keyCache.delete(db);
}

async function storedKeyHash(db, now) {
  const hit = keyCache.get(db);
  if (hit && now >= hit.at && now - hit.at < KEY_CACHE_MS) return hit.hash;
  const s = await getSettings(db, ["ingest_key_hash"]);
  const hash = s.ingest_key_hash || null;
  keyCache.set(db, { hash, at: now });
  return hash;
}

/**
 * Bearer key check. A missing, malformed or oversized token is refused (401)
 * before any D1 read. Then fail closed: no stored key → 503, wrong key → 401.
 */
async function authorize(request, db, now) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return { response: error(401, "unauthorized") };
  const hash = await storedKeyHash(db, now);
  if (!hash) return { response: error(503, "not_configured") };
  if (!(await keyMatches(token, hash))) return { response: error(401, "unauthorized") };
  return {};
}

export async function ingest(request, env, now, ctx) {
  const db = env.DB;
  const auth = await authorize(request, db, now);
  if (auth.response) return auth.response;

  const ctype = (request.headers.get("content-type") || "").toLowerCase();
  if (!/^application\/json(\s*;|$)/.test(ctype)) return error(415, "unsupported_media_type");
  const body = await readCapped(request, LIMITS.BODY_BYTES);
  if (body.tooLarge) return error(413, "payload_too_large");

  let parsed;
  try { parsed = JSON.parse(body.text); } catch { return error(400, "bad_json"); }
  const v = validateIngest(parsed);
  if (!v.ok) return error(400, v.error);
  const p = v.value;

  const assignments = p.assignments.map((a) => ({ ...a, class: p.class }));
  const posts = p.posts.map((x) => ({ ...x, class: p.class }));
  const keys = [...assignments.map(assignmentKey), ...posts.map(postKey)];
  const prev = await loadPrev(db, p.class, keys);
  const p2 = prefs(prev.settings);
  const sync = {
    syncId: p.syncId, at: now, tz: p2.tz,
    covered: [{ class: p.class, tabs: p.tabs, postsCaptured: p.postsCaptured }],
    assignments, posts,
  };
  const res = await diffSync(prev, sync);
  const classState = res.classes[p.class] || { a: false, p: false };
  await db.batch(writeStatements(db, {
    cls: p.class, classState, upserts: res.upserts, events: res.events, syncId: p.syncId, at: now, prefs: p2,
  }));

  if (ctx && res.events.length > 0 && res.events.length <= FLUSH_INLINE_MAX) {
    ctx.waitUntil(flushOutbox(env, now).catch((e) => log({ route: "outbox", status: 500, err: e && e.name ? String(e.name) : "Error" })));
  }
  log({ route: "ingest", status: 200, bytes: body.bytes, a: p.assignments.length, p: p.posts.length,
        up: res.upserts.length, ev: res.events.length, col: res.stats.collisions });
  return json(200, {
    ok: true, events: res.events.length, written: res.upserts.length,
    collisions: res.stats.collisions, baselineDone: { assignments: classState.a, posts: classState.p },
  });
}

/** GET /api/events?since=<ms>&cursor=<ms>.<id>&limit=<1..100> — oldest first. */
export async function events(request, env, now) {
  const db = env.DB;
  const auth = await authorize(request, db, now);
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const cursor = url.searchParams.get("cursor");
  let stmt;
  if (cursor) {
    const m = cursor.match(/^(\d{1,16})\.([0-9a-f]{64})$/);
    if (!m) return error(400, "bad_cursor");
    stmt = db.prepare(
      "SELECT id, type, created_at, payload, sent_at FROM events WHERE created_at > ? OR (created_at = ? AND id > ?) ORDER BY created_at, id LIMIT ?"
    ).bind(Number(m[1]), Number(m[1]), m[2], limit);
  } else {
    const since = url.searchParams.get("since") || "0";
    if (!/^\d{1,16}$/.test(since)) return error(400, "bad_since");
    stmt = db.prepare(
      "SELECT id, type, created_at, payload, sent_at FROM events WHERE created_at >= ? ORDER BY created_at, id LIMIT ?"
    ).bind(Number(since), limit);
  }
  const { results } = await stmt.all();
  const out = results.map((r) => ({ id: r.id, type: r.type, at: r.created_at, sent: r.sent_at !== null, payload: JSON.parse(r.payload) }));
  const last = results[results.length - 1];
  log({ route: "events", status: 200, n: out.length });
  return json(200, { events: out, cursor: last ? `${last.created_at}.${last.id}` : cursor || null });
}

/** GET /health — booleans only, no values, no auth. */
export async function health(request, env) {
  let migrated = false;
  let claimed = false;
  let webhook = false;
  try {
    const s = await getSettings(env.DB, ["ingest_key_hash", "webhook_set"]);
    migrated = true;
    claimed = !!s.ingest_key_hash;
    webhook = s.webhook_set === "1";
  } catch { /* table missing or DB unbound: migrated stays false */ }
  return json(200, {
    claimed, bot_token_set: typeof env.TELEGRAM_BOT_TOKEN === "string" && env.TELEGRAM_BOT_TOKEN.length > 0,
    webhook_set: webhook, migrated,
  });
}
