/**
 * selfhost/extension/push-core.js — Builds /api/ingest payloads from the
 * extension's stored state. Pure: no chrome.*, no network, `now` passed in.
 * Self-host build only (never part of the store build).
 *
 * Per class, one sync = one or more calls with the same syncId:
 *   - call 1: the full assignment snapshot + `tabs` (fully captured tabs) +
 *     the first chunk of new posts;
 *   - further calls: more new posts only.
 * Coverage is conservative: `tabs` comes from the last capture report only
 * when that report was saved together with this class's assignments
 * (same timestamp, as messages.js writes them); otherwise `tabs` is empty, so
 * the server never infers a removal or ends the baseline from stale data.
 * Due times are resolved here (transformAssignment, browser timezone) and
 * sent as dueIso.
 *
 * Dual export: CJS in Node, globalThis.TPSH in the service worker.
 */

"use strict";

const TPSH_TABS = ["Upcoming", "Past due", "Completed"];
const TPSH_LIMITS = { ASSIGNMENTS: 300, CALL_BYTES: 96 * 1024, CLASS: 200, TITLE: 500, DETAILS: 1000, DUE_RAW: 300, AUTHOR: 200, SUBJECT: 500, BODY: 4000, SHORT: 64 };
const TPSH_REPORT_SKEW_MS = 5000;
const TPSH_GUID = /^[A-Za-z0-9-]{1,64}$/;
const TPSH_POST_ID = /^[0-9a-f]{64}$/;

function tpshCut(v, max) {
  if (typeof v !== "string") return undefined;
  if (v.length <= max) return v;
  const cut = /[\uD800-\uDBFF]/.test(v[max - 1]) ? max - 1 : max;
  return v.slice(0, cut);
}

function tpshBytes(v) {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

/** Tabs captured in full for this class, or [] when the report does not match its last sync. */
function coveredTabs(report, lastSyncIso) {
  if (!report || !Array.isArray(report.tabs) || !lastSyncIso) return [];
  if (report.status !== "ok" && report.status !== "partial") return [];
  const a = Date.parse(report.receivedAt || "");
  const b = Date.parse(lastSyncIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > TPSH_REPORT_SKEW_MS) return [];
  return TPSH_TABS.filter((t) => report.tabs.some((r) => r && r.tab === t && r.status === "ok"));
}

function assignmentOut(className, a, transform) {
  if (!a || typeof a.title !== "string" || !TPSH_TABS.includes(a.tab)) return null;
  let dueIso;
  try { dueIso = transform ? transform(className, a).dueIso : undefined; } catch { dueIso = undefined; }
  return {
    assignmentId: typeof a.assignmentId === "string" && TPSH_GUID.test(a.assignmentId) ? a.assignmentId : undefined,
    title: tpshCut(a.title, TPSH_LIMITS.TITLE),
    tab: a.tab,
    dueIso: dueIso || undefined,
    dueDate: tpshCut(a.dueDate, TPSH_LIMITS.SHORT),
    dueRaw: tpshCut(a.dueRaw, TPSH_LIMITS.DUE_RAW),
    details: tpshCut(a.details, TPSH_LIMITS.DETAILS),
  };
}

function postOut(id, rec) {
  const p = rec && rec.post;
  if (!p || !TPSH_POST_ID.test(id)) return null;
  return {
    id,
    author: tpshCut(p.author, TPSH_LIMITS.AUTHOR),
    subject: tpshCut(p.subject, TPSH_LIMITS.SUBJECT),
    body: tpshCut(p.body, TPSH_LIMITS.BODY),
    ts: tpshCut(p.timestampIso || p.timestampFull, TPSH_LIMITS.SHORT),
    isBot: p.isBot === true,
    isAnnouncement: p.isAnnouncement === true,
    attachmentCount: Array.isArray(p.attachments) ? Math.min(p.attachments.length, 1000) : 0,
  };
}

/**
 * @param {{ className, assignments: object[], posts: object, lastSync: string|null }} cls
 * @param {object|null} report   tp:v1:capture-report
 * @param {Set<string>} pushed   post ids the server already accepted
 * @param {string} syncId
 * @param {Function} transform   TP.transformAssignment
 * @returns {{ payloads: object[], postIds: string[][] }}  postIds[i] = ids carried by payloads[i]
 */
function buildPayloads(cls, report, pushed, syncId, transform) {
  const className = tpshCut(cls.className, TPSH_LIMITS.CLASS);
  let tabs = coveredTabs(report, cls.lastSync);
  let assignments = (cls.assignments || []).map((a) => assignmentOut(cls.className, a, transform)).filter(Boolean);
  if (assignments.length > TPSH_LIMITS.ASSIGNMENTS) { assignments = assignments.slice(0, TPSH_LIMITS.ASSIGNMENTS); tabs = []; }
  const posts = Object.entries(cls.posts || {})
    .filter(([id]) => !pushed.has(id))
    .map(([id, rec]) => postOut(id, rec))
    .filter(Boolean);
  const postsCaptured = Object.keys(cls.posts || {}).length > 0;

  // Server cap is 128 KiB per call; stay under CALL_BYTES (UTF-8 bytes, not characters).
  if (tpshBytes(assignments) > TPSH_LIMITS.CALL_BYTES) {
    assignments = assignments.map((a) => ({ ...a, details: undefined, dueRaw: undefined }));
  }
  const payloads = [];
  const postIds = [];
  let chunk = [];
  let budget = TPSH_LIMITS.CALL_BYTES - tpshBytes(assignments);
  const emit = () => {
    const first = payloads.length === 0;
    payloads.push({ v: 1, syncId, class: className, tabs: first ? tabs : [], postsCaptured, assignments: first ? assignments : [], posts: chunk });
    postIds.push(chunk.map((p) => p.id));
    chunk = [];
    budget = TPSH_LIMITS.CALL_BYTES;
  };
  for (const p of posts) {
    const size = tpshBytes(p) + 1;
    if (chunk.length && (size > budget || chunk.length >= 100)) emit();
    chunk.push(p);
    budget -= size;
  }
  if (chunk.length || payloads.length === 0) emit();
  return { payloads, postIds };
}

/** "https://name.sub.workers.dev" (no path) or null. */
function normalizeServer(input) {
  try {
    const u = new URL(String(input || "").trim());
    if (u.protocol !== "https:" || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/i.test(u.hostname) || u.port) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function newSyncId(randomBytes) {
  return `ext-${Array.from(randomBytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const _tpsh = { coveredTabs, buildPayloads, normalizeServer, newSyncId, TPSH_LIMITS, TPSH_TABS };

if (typeof module !== "undefined" && module.exports) {
  module.exports = _tpsh;
} else {
  globalThis.TPSH = Object.assign(globalThis.TPSH || {}, _tpsh);
}
