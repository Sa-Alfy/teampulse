/**
 * selfhost/core/validate.js — Handwritten validation for POST /api/ingest. Pure.
 *
 * One class per call. Only known fields are copied; everything else is
 * dropped. Errors are fixed codes plus a field path, never input content.
 *
 * Payload v1:
 *   { v: 1, syncId, class, tabs: [...], postsCaptured: bool,
 *     assignments: [{ assignmentId?, title, tab, dueIso?, dueDate?, dueRaw?, details? }],
 *     posts:       [{ id (64 hex), author?, subject?, body?, ts?, isBot?, isAnnouncement?, attachmentCount? }] }
 */

"use strict";

const { ASSIGNMENT_TABS } = require("./config");

const LIMITS = {
  BODY_BYTES: 128 * 1024,
  ASSIGNMENTS: 300,
  POSTS: 100,
  CLASS: 200,
  TITLE: 500,
  DETAILS: 1000,
  DUE_RAW: 300,
  SHORT: 64,
  AUTHOR: 200,
  SUBJECT: 500,
  BODY: 4000,
  ATTACHMENTS: 1000,
};

const SYNC_ID = /^[A-Za-z0-9_-]{8,64}$/;
const GUID = /^[A-Za-z0-9-]{1,64}$/;
const POST_ID = /^[0-9a-f]{64}$/;

class Invalid extends Error {
  constructor(code) { super(code); this.code = code; }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function str(v, max, path, { required = false, re = null } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new Invalid(`missing:${path}`);
    return undefined;
  }
  if (typeof v !== "string") throw new Invalid(`type:${path}`);
  if (v.length > max) throw new Invalid(`too_long:${path}`);
  if (required && v.length === 0) throw new Invalid(`empty:${path}`);
  if (re && !re.test(v)) throw new Invalid(`format:${path}`);
  return v;
}

function bool(v, path, def) {
  if (v === undefined) return def;
  if (typeof v !== "boolean") throw new Invalid(`type:${path}`);
  return v;
}

function arr(v, max, path) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Invalid(`type:${path}`);
  if (v.length > max) throw new Invalid(`too_many:${path}`);
  return v;
}

function assignment(a, i) {
  const p = `assignments[${i}]`;
  if (!isObj(a)) throw new Invalid(`type:${p}`);
  // `tabs` (top level) lists the tabs captured in full — it drives removal and the
  // baseline only. A card may come from any tab.
  const tab = str(a.tab, LIMITS.SHORT, `${p}.tab`, { required: true });
  if (!ASSIGNMENT_TABS.includes(tab)) throw new Invalid(`format:${p}.tab`);
  return {
    assignmentId: str(a.assignmentId, LIMITS.SHORT, `${p}.assignmentId`, { re: GUID }),
    title: str(a.title, LIMITS.TITLE, `${p}.title`, { required: true }),
    tab,
    dueIso: str(a.dueIso, LIMITS.SHORT, `${p}.dueIso`),
    dueDate: str(a.dueDate, LIMITS.SHORT, `${p}.dueDate`),
    dueRaw: str(a.dueRaw, LIMITS.DUE_RAW, `${p}.dueRaw`),
    details: str(a.details, LIMITS.DETAILS, `${p}.details`),
  };
}

function post(x, i) {
  const p = `posts[${i}]`;
  if (!isObj(x)) throw new Invalid(`type:${p}`);
  const n = x.attachmentCount;
  if (n !== undefined && !(Number.isInteger(n) && n >= 0 && n <= LIMITS.ATTACHMENTS)) throw new Invalid(`type:${p}.attachmentCount`);
  return {
    id: str(x.id, 64, `${p}.id`, { required: true, re: POST_ID }),
    author: str(x.author, LIMITS.AUTHOR, `${p}.author`),
    subject: str(x.subject, LIMITS.SUBJECT, `${p}.subject`),
    body: str(x.body, LIMITS.BODY, `${p}.body`),
    ts: str(x.ts, LIMITS.SHORT, `${p}.ts`),
    isBot: bool(x.isBot, `${p}.isBot`, false),
    isAnnouncement: bool(x.isAnnouncement, `${p}.isAnnouncement`, false),
    attachmentCount: n || 0,
  };
}

/** @returns {{ ok: true, value } | { ok: false, error: string }} */
function validateIngest(body) {
  try {
    if (!isObj(body)) throw new Invalid("type:body");
    if (body.v !== 1) throw new Invalid("version:v");
    const syncId = str(body.syncId, 64, "syncId", { required: true, re: SYNC_ID });
    const cls = str(body.class, LIMITS.CLASS, "class", { required: true });
    const tabs = arr(body.tabs, ASSIGNMENT_TABS.length, "tabs").map((t, i) => {
      if (!ASSIGNMENT_TABS.includes(t)) throw new Invalid(`format:tabs[${i}]`);
      return t;
    });
    if (new Set(tabs).size !== tabs.length) throw new Invalid("duplicate:tabs");
    const postsCaptured = bool(body.postsCaptured, "postsCaptured", false);
    const assignments = arr(body.assignments, LIMITS.ASSIGNMENTS, "assignments").map((a, i) => assignment(a, i));
    const posts = arr(body.posts, LIMITS.POSTS, "posts").map(post);
    return { ok: true, value: { syncId, class: cls, tabs, postsCaptured, assignments, posts } };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.code };
    throw e;
  }
}

module.exports = { validateIngest, LIMITS };
