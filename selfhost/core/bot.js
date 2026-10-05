/**
 * selfhost/core/bot.js — Telegram bot logic. Pure: no I/O, `now` is a parameter.
 *
 * - parseCommand: "/due@MyBot 3" → { cmd: "due", arg: "3" }
 * - reply: command → { text, writes, lists } for the paired chat. `writes`
 *   are item records to store (/done, /undone); `lists` are the numbered key
 *   lists /done and /undone refer to.
 * - Pairing codes: one-time, expiring, limited attempts (helpers below).
 * - buildAlertMessages: groups outbox rows into messages ≤ ALERT_MAX chars.
 * All text is plain (sent without parse_mode).
 */

"use strict";

const { PRODUCT_NAME, MAX_LIST_ITEMS } = require("./config");
const agenda = require("./agenda");
const fmt = require("./format");
const { digestSetting } = require("./schedule");

const ALERT_MAX = 3500;          // Telegram's limit is 4096; leave room
const REPLY_MAX = 4000;
const LIST_TTL_MS = 24 * 3600e3; // /done <n> refers to a /due list at most this old
const PAIR_TTL_MS = 10 * 60e3;
const PAIR_MAX_FAILS = 5;
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const PAIR_LEN = 10;                                     // 32^10 ≈ 2^50

const HELP = [
  `${PRODUCT_NAME} commands:`,
  "/today — overdue and due today",
  "/week — due in the next 7 days",
  "/due — all open assignments, numbered",
  "/plan — what to do first, crunch days",
  "/done <n> — mark item n from /due as done",
  "/undone — list items marked done; /undone <n> to restore",
  "/digest — daily digest time; /digest 07:30 or /digest off",
].join("\n");

function parseCommand(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^\/([a-z]+)(?:@[A-Za-z0-9_]{1,64})?(?:\s+(.*))?$/is);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), arg: (m[2] || "").trim().slice(0, 64) };
}

function clipReply(text) {
  return text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX - 1)}…` : text;
}

function pickNumber(arg, list, now) {
  if (!list || !Array.isArray(list.keys) || !(now - list.at < LIST_TTL_MS)) return { error: "stale" };
  const n = /^\d{1,3}$/.test(arg) ? Number(arg) : NaN;
  if (!(n >= 1 && n <= list.keys.length)) return { error: "range", max: list.keys.length };
  return { key: list.keys[n - 1] };
}

/**
 * @param {{cmd,arg}} c
 * @param {{ items: object[], now, tz, lastSyncAt, lists: { due?, undone? } }} ctx
 * @returns {{ text: string, writes: object[], lists: object }}
 */
function reply(c, ctx) {
  const { items, now, tz } = ctx;
  const fctx = { now, tz, lastSyncAt: ctx.lastSyncAt };
  const lists = {};
  const writes = [];
  const settings = {};
  const byKey = new Map(items.map((r) => [r.key, r]));
  let text;

  switch (c.cmd) {
    case "today":
      text = fmt.formatToday(agenda.selectToday(items, now, tz), fctx);
      break;
    case "week":
      text = fmt.formatWeek(agenda.selectWeek(items, now, tz), fctx);
      break;
    case "due": {
      const rows = agenda.selectDue(items, now);
      lists.due = { at: now, keys: rows.slice(0, MAX_LIST_ITEMS).map((r) => r.key) };
      text = fmt.formatDue(rows, fctx, MAX_LIST_ITEMS);
      break;
    }
    case "plan":
      text = fmt.formatPlan(agenda.buildPlan(items, now, tz), fctx);
      break;
    case "done": {
      const pick = pickNumber(c.arg, ctx.lists.due, now);
      const rec = pick.key && byKey.get(pick.key);
      if (pick.error === "stale") text = "Run /due first, then /done <n> with a number from that list.";
      else if (pick.error) text = `Use a number from 1 to ${pick.max} from your last /due list.`;
      else if (!rec || !agenda.selectDue([rec], now).length) text = "That item is no longer open. Run /due again.";
      else {
        writes.push(agenda.markDone(rec, now));
        text = `Marked done: ${fmt.clean(rec.title, 120)}\nIt stays hidden until its due date passes or Teams shows it completed. /undone to restore.`;
      }
      text = `${text}\n\n${fmt.lastSyncedLine(ctx.lastSyncAt, now)}`;
      break;
    }
    case "undone": {
      if (!c.arg) {
        const rows = agenda.selectDone(items, now);
        lists.undone = { at: now, keys: rows.slice(0, MAX_LIST_ITEMS).map((r) => r.key) };
        const body = rows.length
          ? ["Marked done (use /undone <n>):", ...rows.slice(0, MAX_LIST_ITEMS).map((r, i) => `${i + 1}. ${fmt.clean(r.title, 120)} — ${fmt.fmtDue(r.dueIso, now, tz)}`)]
          : ["Nothing is marked done."];
        text = [...body, "", fmt.lastSyncedLine(ctx.lastSyncAt, now)].join("\n");
        break;
      }
      const pick = pickNumber(c.arg, ctx.lists.undone, now);
      const rec = pick.key && byKey.get(pick.key);
      if (pick.error === "stale") text = "Run /undone first to see the numbered list.";
      else if (pick.error) text = `Use a number from 1 to ${pick.max} from your last /undone list.`;
      else if (!rec || !rec.doneAt) text = "That item is not marked done any more.";
      else {
        writes.push(agenda.markUndone(rec));
        text = `Restored: ${fmt.clean(rec.title, 120)}`;
      }
      text = `${text}\n\n${fmt.lastSyncedLine(ctx.lastSyncAt, now)}`;
      break;
    }
    case "digest": {
      const arg = c.arg.toLowerCase();
      if (!arg) {
        const cur = digestSetting(ctx.digest);
        text = cur === "off" ? "Daily digest is off. /digest 07:30 turns it on." : `Daily digest at ${cur} (${tz}). /digest off turns it off.`;
      } else if (arg === "off") {
        settings.digest_time = "off";
        text = "Daily digest turned off.";
      } else if (/^\d{1,2}:\d{2}$/.test(arg) && digestSetting(arg) === arg) {
        settings.digest_time = arg;
        text = `Daily digest set to ${arg} (${tz}).`;
      } else {
        text = "Use /digest HH:MM (24-hour, e.g. /digest 07:30) or /digest off.";
      }
      break;
    }
    default:
      text = `${HELP}\n\n${fmt.lastSyncedLine(ctx.lastSyncAt, now)}`;
  }
  return { text: clipReply(text), writes, lists, settings };
}

// ── pairing ────────────────────────────────────────────────────────────────

/** New pairing code from random bytes (crypto.getRandomValues in the host). */
function makePairCode(randomBytes) {
  let s = "";
  for (let i = 0; i < PAIR_LEN; i++) s += PAIR_ALPHABET[randomBytes[i] % PAIR_ALPHABET.length];
  return s;
}

/** User input → canonical code (spaces/dashes dropped, upper case), or null. */
function normalizePairCode(input) {
  const s = String(input || "").replace(/[\s-]/g, "").toUpperCase();
  return s.length === PAIR_LEN && [...s].every((ch) => PAIR_ALPHABET.includes(ch)) ? s : null;
}

/** Is a stored pairing still usable? */
function pairingOpen(p, now) {
  return !!(p && p.hash && Number(p.expiresAt) > now && Number(p.fails || 0) < PAIR_MAX_FAILS);
}

// ── alerts ─────────────────────────────────────────────────────────────────

/**
 * Group outbox rows (oldest first) into messages. Each message lists the ids
 * it contains, so only delivered rows are marked sent.
 * @param {{ id, type, payload }[]} rows
 */
function buildAlertMessages(rows, ctx) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    const text = fmt.formatEvent({ type: r.type, payload: r.payload }, ctx);
    if (!text) { out.push({ text: null, ids: [r.id] }); continue; } // unknown type: mark handled, send nothing
    const piece = text.length > ALERT_MAX ? `${text.slice(0, ALERT_MAX - 1)}…` : text;
    if (cur && cur.text.length + 2 + piece.length <= ALERT_MAX) {
      cur.text += `\n\n${piece}`;
      cur.ids.push(r.id);
    } else {
      cur = { text: piece, ids: [r.id] };
      out.push(cur);
    }
  }
  const footer = `\n\n${fmt.lastSyncedLine(ctx.lastSyncAt, ctx.now)}`;
  for (const m of out) if (m.text && m.text.length + footer.length <= 4096) m.text += footer;
  return out;
}

module.exports = {
  parseCommand, reply, HELP, makePairCode, normalizePairCode, pairingOpen, buildAlertMessages,
  PAIR_TTL_MS, PAIR_MAX_FAILS, PAIR_LEN, LIST_TTL_MS, ALERT_MAX,
};
