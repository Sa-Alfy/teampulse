// GET /cal/<token>.ics — secret, revocable calendar feed of open assignments.
// The token is compared as a sha256 hash in constant time; a wrong or rotated
// token gets the same 404 as a missing route. Escaping, line folding and
// stable UIDs come from extension/core/ics.js.

import icsMod from "../../../extension/core/ics.js";
import digestUtilsMod from "../../../extension/core/digest-utils.js";
import authMod from "../../core/auth.js";
import { error, log } from "./http.js";
import { getSettings, rowToRecord } from "./store.js";
import { OPEN_ITEMS_SQL } from "./telegram.js";

const { buildIcs } = icsMod;
const { shortClassName } = digestUtilsMod;
const { timingSafeEqual, hashKey } = authMod;

const TOKEN_RE = /^\/cal\/([A-Za-z0-9_-]{24,64})\.ics$/;

export function isCalendarPath(pathname) {
  return TOKEN_RE.test(pathname);
}

/** Items → the digest shape buildIcs expects; the GUID part of the key is the UID. */
function toDigest(items) {
  const classes = new Map();
  for (const r of items) {
    if (!r.dueIso) continue;
    if (!classes.has(r.class)) classes.set(r.class, { rawClassName: r.class, displayName: shortClassName(r.class), assignments: [] });
    const id = r.key.startsWith("a:id:") ? r.key.slice(5) : null;
    classes.get(r.class).assignments.push({ assignmentId: id, title: r.title, dueIso: r.dueIso, tab: r.tab, details: "" });
  }
  return { classes: [...classes.values()] };
}

export async function calendar(request, env, now) {
  const m = new URL(request.url).pathname.match(TOKEN_RE);
  if (!m) return error(404, "not_found");
  const db = env.DB;
  const s = await getSettings(db, ["ics_hash"]);
  if (!s.ics_hash || !timingSafeEqual(await hashKey(m[1]), s.ics_hash)) return error(404, "not_found");
  const items = (await db.prepare(OPEN_ITEMS_SQL).all()).results.map(rowToRecord);
  const { ics, exported } = buildIcs(toDigest(items), now);
  log({ route: "calendar", status: 200, n: exported });
  return new Response(ics, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
