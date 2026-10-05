/**
 * selfhost/core/reminders.js — Which reminders are due now. Pure.
 *
 * Slots (config.REMINDER_SLOTS): "24h" fires in [due-24h, due-3h), "3h" in [due-3h, due).
 *   - Open items only: not submitted, not marked done, not removed.
 *   - First seen less than 24 h before due → no 24h reminder (the new-assignment
 *     alert already said when it is due).
 *   - First seen less than 3 h before due → the 3h slot is sent as a one-time
 *     "due_soon" alert instead.
 *   - Quiet hours defer the 24h reminder (it fires when they end, if still in
 *     its window). The 3h / due_soon reminder ignores quiet hours.
 *   - Idempotent: the reminder id is (itemKey, dueIso, slot). A moved due date
 *     gives new ids, so the new date gets its own reminders.
 */

"use strict";

const { REMINDER_SLOTS } = require("./config");
const { isQuiet } = require("./time");

function reminderId(itemKey, dueIso, slot) {
  return `${itemKey}\0${dueIso}\0${slot}`;
}

function isOpen(r) {
  return r.kind === "a" && !r.removedAt && !r.submitted && !r.doneAt;
}

/**
 * @param {object[]} items — assignment records
 * @param {Set<string>} sent — reminder ids already sent
 * @param {number} now
 * @param {{ tz: string, quiet?: {start,end}|null }} opts
 * @returns {{ id, itemKey, slot, kind, dueIso, title, class }[]} soonest due first
 */
function planReminders(items, sent, now, opts) {
  const quiet = isQuiet(now, opts.tz, opts.quiet);
  const out = [];
  for (const r of items) {
    if (!isOpen(r) || !r.dueIso) continue;
    const due = Date.parse(r.dueIso);
    if (Number.isNaN(due) || now >= due) continue;

    for (let i = 0; i < REMINDER_SLOTS.length; i++) {
      const { slot, ms } = REMINDER_SLOTS[i];
      const until = i + 1 < REMINDER_SLOTS.length ? due - REMINDER_SLOTS[i + 1].ms : due;
      if (now < due - ms || now >= until) continue;
      const last = i === REMINDER_SLOTS.length - 1;
      if (!last && r.firstSeen > due - ms) continue; // seen too late for this slot
      if (!last && quiet) continue;                   // deferred, not dropped
      const id = reminderId(r.key, r.dueIso, slot);
      if (sent.has(id)) continue;
      const kind = last && r.firstSeen > due - ms ? "due_soon" : slot;
      out.push({ id, itemKey: r.key, slot, kind, dueIso: r.dueIso, title: r.title, class: r.class });
    }
  }
  return out.sort((a, b) => Date.parse(a.dueIso) - Date.parse(b.dueIso));
}

module.exports = { planReminders, reminderId, isOpen };
