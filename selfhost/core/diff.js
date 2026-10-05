/**
 * selfhost/core/diff.js — Change detection for one sync. Pure: no I/O, no clock.
 *
 * Input (already validated by the host adapter):
 *   prev = {
 *     classes: { [className]: { a: bool, p: bool } },  // baseline done for assignments / posts
 *     items:   Map<key, record>,  // every non-removed assignment of the classes in this sync,
 *                                 // plus stored posts whose ids are in this sync
 *   }
 *   sync = {
 *     syncId, at (ms), tz,
 *     covered:     [{ class, tabs: [...], postsCaptured?: bool }],
 *     assignments: [{ class, assignmentId?, title, dueIso?, dueDate?, dueRaw?, details?, tab }],
 *     posts:       [{ class, id, author?, subject?, body?, ts?, isBot?, isAnnouncement?, attachmentCount? }],
 *   }
 *
 * Rules:
 *   - A class's assignments are baselined (stored, zero events) until the first
 *     sync that covers all three tabs (a loaded but empty tab counts); posts
 *     until the first sync whose covered[] entry says postsCaptured: true
 *     (zero posts is fine). Posts of a class not captured are stored silently.
 *   - Removal: class fully covered AND item missing in 2 syncs with different
 *     syncIds at least REMOVAL_MIN_GAP_MS apart.
 *   - Submitted = tab "Completed"; an event only on false → true.
 *   - due_date_changed only for open items (not Completed).
 *   - /done (doneAt) is sticky; a sync clears it only when Teams shows Completed.
 *   - Two snapshot items with the same key: no due-date events for that key.
 *   - Event ids hash (type, key, old, new, syncId): replaying a sync never
 *     duplicates, and a date that moves back and forth still alerts each time.
 *
 * Output: { events, upserts, classes, stats } — upserts are only records that changed.
 */

"use strict";

const { sha256Hex } = require("../../extension/core/fingerprint");
const { classify, isNoteworthy } = require("../../extension/core/digest-utils");
const { ASSIGNMENT_TABS, SUBMITTED_TAB, REMOVAL_MIN_GAP_MS, MAX_TEXT } = require("./config");
const { resolveDueIso } = require("./dates");
const { clip: clipText } = require("./text");

const NOTICE_TAG = classify("");

/**
 * Stable key. The Teams GUID when present; otherwise class + normalized title
 * (no due date, so a moved date is a change, not remove + new).
 */
function assignmentKey(a) {
  if (a.assignmentId) return `a:id:${a.assignmentId}`;
  const title = String(a.title || "").trim().replace(/\s+/g, " ").toLowerCase();
  return `a:t:${a.class}\0${title}`;
}

function postKey(p) {
  return `p:${p.id}`;
}

function clip(s, max = MAX_TEXT) {
  return clipText(s, max);
}

const ASSIGN_FIELDS = ["class", "title", "dueIso", "tab", "submitted", "firstSeen", "missingSyncId", "missingAt", "removedAt", "doneAt"];

function sameRecord(a, b) {
  return ASSIGN_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
}

async function diffSync(prev, sync) {
  const { syncId, at, tz } = sync;
  const classes = {};
  for (const [cn, st] of Object.entries(prev.classes || {})) classes[cn] = { a: !!st.a, p: !!st.p };
  const ensure = (cn) => (classes[cn] ||= { a: false, p: false });

  const pending = []; // [type, key, old, new, payload]
  const upserts = [];
  const stats = { collisions: 0, baselined: 0, removedPending: 0 };

  const fullyCovered = new Set(
    (sync.covered || [])
      .filter((c) => ASSIGNMENT_TABS.every((t) => (c.tabs || []).includes(t)))
      .map((c) => c.class)
  );

  // ── Assignments present in the snapshot ─────────────────────────────────
  const snapshot = new Map();
  const collided = new Set();
  for (const a of sync.assignments || []) {
    const key = assignmentKey(a);
    if (snapshot.has(key)) { collided.add(key); continue; }
    snapshot.set(key, a);
  }
  stats.collisions = collided.size;

  for (const [key, a] of snapshot) {
    const cn = a.class;
    const live = ensure(cn).a;
    const old = prev.items.get(key);
    const submitted = a.tab === SUBMITTED_TAB;
    const dueIso = resolveDueIso(a, at, tz);
    const info = { class: cn, title: clip(a.title), tab: a.tab, submitted };

    let rec;
    if (!old || old.removedAt) {
      rec = { key, kind: "a", class: cn, title: clip(a.title), dueIso, tab: a.tab, submitted,
              firstSeen: at, missingSyncId: null, missingAt: null, removedAt: null, doneAt: null };
      if (live) pending.push(["new_assignment", key, null, dueIso, { ...info, dueIso, reappeared: !!old }]);
      else stats.baselined++;
    } else {
      rec = { ...old, class: cn, title: clip(a.title), tab: a.tab, submitted,
              dueIso: dueIso || old.dueIso, missingSyncId: null, missingAt: null };
      if (submitted) rec.doneAt = null; // Teams now confirms it; the manual mark is no longer needed
      if (live && !submitted && dueIso && old.dueIso !== dueIso && !collided.has(key)) {
        pending.push(["due_date_changed", key, old.dueIso || null, dueIso, { ...info, old: old.dueIso || null, new: dueIso }]);
      }
      if (live && submitted && !old.submitted) {
        pending.push(["assignment_submitted", key, null, null, { ...info, dueIso: rec.dueIso }]);
      }
    }
    if (!old || !sameRecord(old, rec)) upserts.push(rec);
  }

  // ── Missing assignments (fully covered classes only) ────────────────────
  for (const [key, old] of prev.items) {
    if (old.kind !== "a" || old.removedAt || snapshot.has(key) || !fullyCovered.has(old.class)) continue;
    if (!old.missingSyncId) {
      upserts.push({ ...old, missingSyncId: syncId, missingAt: at });
      stats.removedPending++;
    } else if (old.missingSyncId !== syncId && at - old.missingAt >= REMOVAL_MIN_GAP_MS) {
      upserts.push({ ...old, removedAt: at });
      if (ensure(old.class).a) {
        pending.push(["assignment_removed", key, null, null,
          { class: old.class, title: old.title, tab: old.tab, submitted: old.submitted, dueIso: old.dueIso }]);
      }
    }
  }
  for (const cn of fullyCovered) ensure(cn).a = true;

  // ── Posts (delta: only ids the server has not stored) ───────────────────
  const seenPosts = new Set();
  for (const p of sync.posts || []) {
    const key = postKey(p);
    if (seenPosts.has(key) || prev.items.has(key)) continue;
    seenPosts.add(key);
    const text = `${p.subject || ""} ${p.body || ""}`.trim();
    const tag = classify(text);
    upserts.push({ key, kind: "p", class: p.class, title: clip(p.subject), body: clip(p.body, 2000),
                   ts: p.ts || null, tag, firstSeen: at });
    const noteworthy = isNoteworthy({
      subject: p.subject, body: p.body, isBot: !!p.isBot, isAnnouncement: !!p.isAnnouncement,
      attachments: new Array(Math.max(0, p.attachmentCount | 0)),
    });
    if (classes[p.class] && classes[p.class].p && noteworthy) {
      const payload = { class: p.class, subject: clip(p.subject), snippet: clip(p.body), ts: p.ts || null, tag };
      pending.push([tag === NOTICE_TAG ? "new_post" : "tagged_post", key, null, null, payload]);
    }
  }
  for (const c of sync.covered || []) if (c.postsCaptured === true) ensure(c.class).p = true;

  const events = [];
  for (const [type, key, oldV, newV, payload] of pending) {
    const id = await sha256Hex(`${type}\0${key}\0${oldV ?? ""}\0${newV ?? ""}\0${syncId}`);
    events.push({ id, type, itemKey: key, at, payload });
  }
  return { events, upserts, classes, stats };
}

module.exports = { diffSync, assignmentKey, postKey, NOTICE_TAG };
