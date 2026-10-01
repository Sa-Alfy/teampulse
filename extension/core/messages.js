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

    const { assignments } = msg;
    if (!Array.isArray(assignments)) {
      return reject("assignments must be an array");
    }
    if (assignments.length > MAX_ASSIGNMENTS) {
      return reject(`assignments array exceeds ${MAX_ASSIGNMENTS} items`);
    }
    for (let i = 0; i < assignments.length; i++) {
      if (!isValidAssignment(assignments[i])) {
        return reject(`assignments[${i}] is invalid`);
      }
    }

    // Join to className from tab context
    const className = await session.get(tabCtxKey(tabId));
    if (!className) {
      return reject("no class context for tab — TP_CLASS_CONTEXT not yet received");
    }

    const now = nowIso();
    await store.ingestAssignments(className, assignments, now);
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

