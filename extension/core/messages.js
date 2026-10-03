/**
 * extension/core/messages.js — Pure message router for the service worker.
 *
 * Exported: handleMessage(msg, sender, deps)
 *
 * deps = {
 *   store:   { ingestPosts, ingestAssignments }        — store instance
 *   session: { get(key), set(key, val), remove(key) } — session storage adapter
 *   nowIso:  () => string                               — ISO timestamp supplier
 * }
 *
 * Accepted message types:
 *   TP_CLASS_CONTEXT  — from Teams origins only; saves className in session.
 *   TP_POSTS          — from Teams origins only; validates + ingests.
 *   TP_ASSIGNMENTS    — from assignments origin only; joins to session className,
 *                       validates, then ingests.
 *
 * Returns: Promise<{ ok: boolean, reason?: string }>
 *
 * Dual export: CJS in Node, globalThis.TP in browser (via importScripts).
 */

"use strict";

// ── Origin constants ───────────────────────────────────────────────────────

const TEAMS_ORIGINS = new Set([
  "https://teams.microsoft.com",
  "https://teams.cloud.microsoft", // seen live via tools/dom-probe.js (2026-10-01)
]);

const ASSIGNMENTS_ORIGIN = "https://assignments.edu.cloud.microsoft";

const HEALTH_STATUSES = new Set(["no-class", "no-messages"]);

// ── Validation limits (from spec) ──────────────────────────────────────────

const MAX_CLASS_NAME   = 200;
const MAX_POSTS        = 500;
const MAX_ASSIGNMENTS  = 300;
const MAX_STRING_FIELD = 20_000;

// ── Helpers ────────────────────────────────────────────────────────────────

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function reject(reason) {
  return { ok: false, reason };
}

function ok() {
  return { ok: true };
}

/** Check every string field in an object is within the limit. */
function stringFieldsOk(obj, limit) {
  if (!obj || typeof obj !== "object") return false;
  for (const val of Object.values(obj)) {
    if (typeof val === "string" && val.length > limit) return false;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.length > limit) return false;
        if (item && typeof item === "object" && !stringFieldsOk(item, limit)) return false;
      }
    }
  }
  return true;
}

/** Validate post object shape. */
function isValidPost(post) {
  if (!post || typeof post !== "object")                  return false;
  if (typeof post.author    !== "string")                 return false;
  if (typeof post.body      !== "string")                 return false;
  if (typeof post.isBot     !== "boolean")                return false;
  if (!Array.isArray(post.attachments))                   return false;
  if (!Array.isArray(post.replies))                       return false;
  if (!stringFieldsOk(post, MAX_STRING_FIELD))            return false;
  return true;
}

/** Validate assignment object shape. */
function isValidAssignment(a) {
  if (!a || typeof a !== "object")                        return false;
  if (typeof a.tab   !== "string")                        return false;
  if (typeof a.title !== "string")                        return false;
  if (!stringFieldsOk(a, MAX_STRING_FIELD))               return false;
  return true;
}

function tabCtxKey(tabId) {
  return `tp:tabctx:${tabId}`;
}

// ── Assignment capture helpers ─────────────────────────────────────────────

const ASSIGNMENT_TABS = ["Upcoming", "Past due", "Completed"];
const UNMATCHED_CLASS = "Unmatched";
const REPORT_STATUSES = new Set(["ok", "partial", "failed", "deferred"]);
const REASON_RE       = /^[A-Za-z0-9 :+._()-]{0,120}$/;

/**
 * Copy of a content-script capture report with only the known fields:
 * numbers, booleans and short fixed-vocabulary codes. Anything else (titles,
 * class names, unexpected keys) is dropped.
 */
function sanitizeReport(r) {
  if (!r || typeof r !== "object") return null;
  const num  = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e6) : 0);
  const bool = (v) => v === true;
  const code = (v) => (typeof v === "string" && REASON_RE.test(v) ? v : "");
  const out = {
    version: num(r.version),
    startedAt: typeof r.startedAt === "string" && !Number.isNaN(Date.parse(r.startedAt)) ? r.startedAt.slice(0, 40) : "",
    trigger: code(r.trigger),
    scope: r.scope === "all-classes" || r.scope === "class" ? r.scope : "",
    readyWaitResult: r.readyWaitResult === "ready" || r.readyWaitResult === "timeout" ? r.readyWaitResult : "",
    documentHidden: bool(r.documentHidden),
    rendered: bool(r.rendered),
    status: REPORT_STATUSES.has(r.status) ? r.status : "failed",
    reason: code(r.reason),
    tabs: [],
  };
  for (const t of Array.isArray(r.tabs) ? r.tabs.slice(0, ASSIGNMENT_TABS.length) : []) {
    if (!t || !ASSIGNMENT_TABS.includes(t.tab)) continue;
    out.tabs.push({
      tab: t.tab,
      tabFound: bool(t.tabFound), clicked: bool(t.clicked), selectedConfirmed: bool(t.selectedConfirmed),
      cardsChangedConfirmed: bool(t.cardsChangedConfirmed), listLoaded: bool(t.listLoaded), retried: bool(t.retried), previousListForeign: bool(t.previousListForeign),
      cardsRaw: num(t.cardsRaw), droppedHidden: num(t.droppedHidden), droppedStale: num(t.droppedStale),
      droppedByRelativeFilter: num(t.droppedByRelativeFilter), dedupedOut: num(t.dedupedOut), kept: num(t.kept),
      status: ["ok", "skipped", "timeout"].includes(t.status) ? t.status : "skipped",
      reason: code(t.reason),
    });
  }
  return out;
}

const normClass = (s) => String(s).replace(/[\s\u00a0]+/g, " ").trim().toLowerCase();

/** Store the report with the background's verdict (never replaces a recent good report with "deferred"). */
async function saveCaptureReport(store, msg, background, nowIso) {
  if (!store.setCaptureReport) return;
  const report = sanitizeReport(msg && msg.report) || { status: "failed", reason: "no-report", tabs: [] };
  report.receivedAt = nowIso;
  report.cardsSent = Array.isArray(msg && msg.assignments) ? msg.assignments.length : 0;
  report.background = background;
  if (report.status === "deferred" && store.getCaptureReport) {
    const prev = await store.getCaptureReport();
    if (prev && (prev.status === "ok" || prev.status === "partial") &&
        Date.parse(nowIso) - Date.parse(prev.receivedAt || "") < 6 * 3600e3) return;
  }
  await store.setCaptureReport(report);
}

// ── handleMessage ──────────────────────────────────────────────────────────

async function handleMessage(msg, sender, deps) {
  const { store, session, nowIso } = deps;

  if (!msg || typeof msg.type !== "string") {
    return reject("missing type");
  }

  // Require sender.tab and numeric sender.tab.id
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") {
    return reject("sender.tab.id missing or invalid");
  }

  const tabId = sender.tab.id;
  const senderOrigin = getOrigin(sender.url || "");

  // ── TP_CLASS_CONTEXT ─────────────────────────────────────────────────────
  if (msg.type === "TP_CLASS_CONTEXT") {
    if (!TEAMS_ORIGINS.has(senderOrigin)) {
      return reject(`TP_CLASS_CONTEXT from disallowed origin: ${senderOrigin}`);
    }

    const { className } = msg;
    if (typeof className !== "string" || className.length === 0) {
      return reject("className must be a non-empty string");
    }
    if (className.length > MAX_CLASS_NAME) {
      return reject(`className exceeds ${MAX_CLASS_NAME} chars`);
    }

    await session.set(tabCtxKey(tabId), className);
    if (store.noteClass) await store.noteClass(className);
    return ok();
  }

  // ── TP_POSTS ─────────────────────────────────────────────────────────────
  if (msg.type === "TP_POSTS") {
    if (!TEAMS_ORIGINS.has(senderOrigin)) {
      return reject(`TP_POSTS from disallowed origin: ${senderOrigin}`);
    }

    const { className, posts } = msg;
    if (typeof className !== "string" || className.length === 0) {
      return reject("className must be a non-empty string");
    }
    if (className.length > MAX_CLASS_NAME) {
      return reject(`className exceeds ${MAX_CLASS_NAME} chars`);
    }
    if (!Array.isArray(posts)) {
      return reject("posts must be an array");
    }
    if (posts.length > MAX_POSTS) {
      return reject(`posts array exceeds ${MAX_POSTS} items`);
    }
    for (let i = 0; i < posts.length; i++) {
      if (!isValidPost(posts[i])) {
        return reject(`posts[${i}] is invalid`);
      }
    }

    const now = nowIso();
    const hashFn = (cn, post) => (globalThis.TP && globalThis.TP.hashPost ? globalThis.TP.hashPost(cn, post) : post);
    const isNoteworthyFn = (post) => (globalThis.TP && globalThis.TP.isNoteworthy ? globalThis.TP.isNoteworthy(post) : true);

    await store.ingestPosts(className, posts, now, hashFn, isNoteworthyFn);
    return ok();
  }

  // ── TP_ASSIGNMENTS ────────────────────────────────────────────────────────
  if (msg.type === "TP_ASSIGNMENTS") {
    if (senderOrigin !== ASSIGNMENTS_ORIGIN) {
      return reject(`TP_ASSIGNMENTS from disallowed origin: ${senderOrigin}`);
    }
    const now = nowIso();
    // Every outcome is recorded with the capture report (no silent drops).
    const verdict = async (res, extra = {}) => {
      await saveCaptureReport(store, msg, { accepted: res.ok, reason: res.reason || "", ...extra }, now);
      return res;
    };

    const { assignments } = msg;
    if (!Array.isArray(assignments)) {
      return verdict(reject("assignments must be an array"));
    }
    if (assignments.length > MAX_ASSIGNMENTS) {
      return verdict(reject(`assignments array exceeds ${MAX_ASSIGNMENTS} items`));
    }
    for (let i = 0; i < assignments.length; i++) {
      if (!isValidAssignment(assignments[i])) {
        return verdict(reject(`assignments[${i}] is invalid`));
      }
      const cn = assignments[i].className;
      if (cn !== undefined && (typeof cn !== "string" || cn.length === 0 || cn.length > MAX_CLASS_NAME)) {
        return verdict(reject(`assignments[${i}].className is invalid`));
      }
    }
    // All-classes cards name their class; one that doesn't (live 2026-10-03:
    // Completed cards read "Submitted at …", which hid the class line) goes to
    // the Unmatched bucket instead of rejecting the whole batch.
    const allClasses = msg.scope === "all-classes";
    let classless = 0;
    if (allClasses) {
      for (const a of assignments) if (a.className === undefined) { a.className = UNMATCHED_CLASS; classless++; }
    }

    // Tabs whose capture is authoritative. Older senders (no okTabs) captured
    // all three tabs in one go.
    const okTabs = Array.isArray(msg.okTabs)
      ? ASSIGNMENT_TABS.filter((t) => msg.okTabs.includes(t))
      : ASSIGNMENT_TABS.slice();
    if (!Array.isArray(msg.okTabs) && assignments.length === 0) {
      return verdict({ ok: true, stored: false, reason: "empty batch without tab confirmation; stored assignments kept" });
    }
    if (okTabs.length === 0) {
      // Failed or deferred capture: never overwrite stored items with nothing.
      return verdict({ ok: true, stored: false, reason: "no tab confirmed; stored assignments kept" });
    }

    // Each card that names its class is filed there (validated against
    // classes seen in Teams); the rest go under the tab's class context.
    const known = store.getKnownClasses ? await store.getKnownClasses() : [];
    const byNorm = new Map(known.map((k) => [normClass(k), k]));
    let unmatched = 0;
    let context = null;
    const byClass = new Map();
    for (const a of assignments) {
      let target;
      if (a.className !== undefined) {
        target = a.className === UNMATCHED_CLASS ? null
          : byNorm.size === 0 ? a.className : byNorm.get(normClass(a.className));
        if (!target && a.className === UNMATCHED_CLASS) {
          target = UNMATCHED_CLASS;
        } else if (!target) {
          unmatched++;
          target = UNMATCHED_CLASS;
          a.details = [a.details, a.className].filter(Boolean).join(" · ");
        }
      } else {
        if (context === null) context = (await session.get(tabCtxKey(tabId))) || "";
        if (!context) {
          return verdict(reject("no class context for tab — TP_CLASS_CONTEXT not yet received"));
        }
        target = context;
      }
      if (!byClass.has(target)) byClass.set(target, []);
      byClass.get(target).push(a);
    }
    if (!allClasses && byClass.size === 0) {
      context = (await session.get(tabCtxKey(tabId))) || "";
      if (!context) return verdict(reject("no class context for tab — TP_CLASS_CONTEXT not yet received"));
      byClass.set(context, []);
    }

    // The all-classes list covers every class: a stored class absent from it
    // has no assignments — but only trust that when every tab was confirmed.
    if (allClasses && okTabs.length === ASSIGNMENT_TABS.length) {
      for (const cn of Object.keys((await store.getState()).classes || {})) {
        if (!byClass.has(cn)) byClass.set(cn, []);
      }
    }

    let classesWritten = 0;
    for (const [cn, items] of byClass) {
      const r = store.mergeAssignments
        ? await store.mergeAssignments(cn, items, okTabs, now)
        : (await store.ingestAssignments(cn, items, now), { written: true });
      if (r && r.written) classesWritten++;
    }
    return verdict(ok(), {
      okTabs,
      classesWritten,
      unmatched,
      classless,
      classValidation: byNorm.size ? "known-classes" : "no-known-classes",
      health: unmatched || classless ? "unmatched-classes" : "ok",
    });
  }

  // ── TP_HEALTH ─────────────────────────────────────────────────────────────
  // Content script reports a sustained scraper problem. Only problem states
  // are accepted; success is implied by a newer TP_POSTS ingest.
  if (msg.type === "TP_HEALTH") {
    if (!TEAMS_ORIGINS.has(senderOrigin)) {
      return reject(`TP_HEALTH from disallowed origin: ${senderOrigin}`);
    }
    const { status, className } = msg;
    if (!HEALTH_STATUSES.has(status)) {
      return reject("status must be one of: " + [...HEALTH_STATUSES].join(", "));
    }
    if (status === "no-class") {
      if (className !== undefined && className !== null) {
        return reject("no-class must not carry a className");
      }
      await store.recordHealth(null, status, nowIso());
      return ok();
    }
    if (typeof className !== "string" || className.length === 0) {
      return reject("className must be a non-empty string");
    }
    if (className.length > MAX_CLASS_NAME) {
      return reject(`className exceeds ${MAX_CLASS_NAME} chars`);
    }
    await store.recordHealth(className, status, nowIso());
    return ok();
  }

  return reject(`unknown type: ${msg.type}`);
}

// ── Dual export ────────────────────────────────────────────────────────────

const _messages = {
  handleMessage,
  TEAMS_ORIGINS,
  ASSIGNMENTS_ORIGIN,
  tabCtxKey,
  MAX_CLASS_NAME,
  MAX_POSTS,
  MAX_ASSIGNMENTS,
  MAX_STRING_FIELD,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = _messages;
} else {
  globalThis.TP = Object.assign(globalThis.TP || {}, _messages);
}

