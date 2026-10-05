/**
 * selfhost/core/format.js — Plain-text messages. Pure.
 *
 * Output is sent WITHOUT parse_mode, so ingested text cannot become markup.
 * clean() still strips control/bidi characters and caps length.
 * Every command reply ends with lastSyncedLine().
 */

"use strict";

const { PRODUCT_NAME, HOUR, DAY, MAX_TEXT } = require("./config");
const { localParts } = require("./time");
const { shortClassName } = require("../../extension/core/digest-utils");

// Exact classify() outputs that interrupt quiet hours.
const HIGH_TAGS = new Set(["🧪 CT/Quiz", "📝 Exam", "🔄 Reschedule", "❌ Cancelled"]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// C0/C1 controls except \n, plus bidi overrides/isolates and zero-width chars.
const UNSAFE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

function clean(text, max = MAX_TEXT) {
  const t = String(text ?? "").replace(UNSAFE, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function ago(ms) {
  if (ms < HOUR) return `${Math.max(0, Math.floor(ms / 60e3))} min ago`;
  if (ms < 48 * HOUR) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

function lastSyncedLine(lastSyncAt, now) {
  return lastSyncAt ? `Last synced ${ago(now - lastSyncAt)}` : "Last synced: never";
}

const pad = (n) => String(n).padStart(2, "0");

/** "Mon 6 Oct 23:59" in tz. */
function fmtWhen(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.dow} ${p.d} ${MONTHS[p.m - 1]} ${pad(p.h)}:${pad(p.min)}`;
}

/** "in 5 h" / "in 2 d" / "3 h overdue". */
function fmtLeft(dueMs, now) {
  const left = dueMs - now;
  const abs = Math.abs(left);
  const span = abs < HOUR ? `${Math.max(1, Math.round(abs / 60e3))} min` : abs < 48 * HOUR ? `${Math.floor(abs / HOUR)} h` : `${Math.floor(abs / DAY)} d`;
  return left >= 0 ? `in ${span}` : `${span} overdue`;
}

function fmtDue(dueIso, now, tz) {
  if (!dueIso) return "no due date";
  const ms = Date.parse(dueIso);
  return Number.isNaN(ms) ? "no due date" : `${fmtWhen(ms, tz)} (${fmtLeft(ms, now)})`;
}

function cls(name) {
  return clean(shortClassName(String(name || "")), 60);
}

function line(r, now, tz, n) {
  const num = n === undefined ? "•" : `${n}.`;
  return `${num} ${clean(r.title, 120)} [${cls(r.class)}] — ${fmtDue(r.dueIso, now, tz)}`;
}

/** Alert text for one event, or null for an unknown type. */
function formatEvent(ev, ctx) {
  const p = ev.payload || {};
  const { now, tz } = ctx;
  const where = `[${cls(p.class)}]`;
  switch (ev.type) {
    case "new_assignment":
      return `🆕 New assignment ${where}\n${clean(p.title)}\nDue: ${fmtDue(p.dueIso, now, tz)}`;
    case "due_date_changed":
      return `📅 Due date changed ${where}\n${clean(p.title)}\nWas: ${fmtDue(p.old, now, tz)}\nNow: ${fmtDue(p.new, now, tz)}`;
    case "assignment_submitted":
      return `✅ Submitted ${where}\n${clean(p.title)}`;
    case "assignment_removed":
      return `🗑 Assignment no longer listed ${where}\n${clean(p.title)}`;
    case "tagged_post":
      return `${clean(p.tag, 30)} ${where}\n${clean(p.subject || p.snippet)}${p.subject && p.snippet ? `\n${clean(p.snippet, 200)}` : ""}`;
    case "new_post":
      return `📢 New post ${where}\n${clean(p.subject || p.snippet)}${p.subject && p.snippet ? `\n${clean(p.snippet, 200)}` : ""}`;
    default:
      return null;
  }
}

/** Alert priority: "high" ignores quiet hours, "normal" waits for them to end. */
function eventPriority(ev) {
  if (ev.type === "due_date_changed") return "high";
  if (ev.type === "tagged_post" && ev.payload && HIGH_TAGS.has(ev.payload.tag)) return "high";
  return "normal";
}

function formatReminder(r, ctx) {
  const head = r.kind === "due_soon" ? "⚠️ Due soon" : `⏰ Reminder (${r.slot})`;
  return `${head} [${cls(r.class)}]\n${clean(r.title)}\nDue: ${fmtDue(r.dueIso, ctx.now, ctx.tz)}\n${lastSyncedLine(ctx.lastSyncAt, ctx.now)} — submitted since then? Sync to update.`;
}

function section(title, rows, ctx, numbered) {
  if (!rows.length) return [];
  return [title, ...rows.map((r, i) => line(r, ctx.now, ctx.tz, numbered ? i + 1 : undefined))];
}

function withFooter(lines, ctx) {
  return [...lines, "", lastSyncedLine(ctx.lastSyncAt, ctx.now)].join("\n");
}

function formatToday(sel, ctx) {
  const body = [...section("Overdue:", sel.overdue, ctx), ...section("Due today:", sel.due, ctx)];
  return withFooter(body.length ? body : ["Nothing due today. 🎉"], ctx);
}

function formatWeek(sel, ctx) {
  const body = [...section("Overdue:", sel.overdue, ctx), ...section("Due in the next 7 days:", sel.due, ctx)];
  return withFooter(body.length ? body : ["Nothing due this week."], ctx);
}

function formatDue(rows, ctx, max) {
  const shown = rows.slice(0, max);
  const body = shown.length ? section("Open assignments (use /done <n>):", shown, ctx, true) : ["No open assignments with a due date."];
  if (rows.length > shown.length) body.push(`… and ${rows.length - shown.length} more`);
  return withFooter(body, ctx);
}

const BUCKET_LABEL = ["Overdue", "Next 24 h", "Next 3 days", "This week", "Later"];

function formatPlan(plan, ctx) {
  const out = [];
  let b = -1;
  for (const r of plan.ranked) {
    if (r.bucket !== b) { b = r.bucket; out.push(`${out.length ? "\n" : ""}${BUCKET_LABEL[b]}:`); }
    out.push(line(r, ctx.now, ctx.tz));
  }
  if (!out.length) out.push("Nothing to plan in the next 2 weeks.");
  if (plan.crunchDays.length) {
    out.push("", "Crunch days:");
    for (const c of plan.crunchDays) {
      const [y, m, d] = c.day.split("-").map(Number);
      out.push(`🔥 ${d} ${MONTHS[m - 1]} ${y}: ${c.count} due`);
    }
  }
  if (plan.undated) out.push("", `${plan.undated} open item(s) without a due date.`);
  return withFooter(out, ctx);
}

function formatDigest(sel, ctx) {
  const body = [`☀️ ${PRODUCT_NAME} daily digest`, ...section("Overdue:", sel.overdue, ctx), ...section("Due in the next 7 days:", sel.due, ctx)];
  if (body.length === 1) body.push("Nothing due this week.");
  return withFooter(body, ctx);
}

module.exports = {
  clean, ago, lastSyncedLine, fmtWhen, fmtLeft, fmtDue, formatEvent, eventPriority,
  formatReminder, formatToday, formatWeek, formatDue, formatPlan, formatDigest,
};
