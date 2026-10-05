/**
 * selfhost/core/schedule.js — When the daily digest is due. Pure.
 *
 * The digest time is "HH:MM" local (default 07:30) or "off". It is sent once
 * per local day, by the first cron run inside [time, time + DIGEST_WINDOW_MIN).
 * A day whose window was missed (Worker down) is skipped, not sent late.
 */

"use strict";

const { localParts, dayKey, parseHHMM } = require("./time");

const DEFAULT_DIGEST_TIME = "07:30";
const DIGEST_WINDOW_MIN = 30;

/** Normalized setting: "HH:MM", "off", or the default for anything invalid. */
function digestSetting(v) {
  if (v === "off") return "off";
  return typeof v === "string" && parseHHMM(v) !== null ? v : DEFAULT_DIGEST_TIME;
}

/** @returns {{ due: boolean, day: string }} */
function digestDue(now, tz, setting, lastDay) {
  const day = dayKey(now, tz);
  const s = digestSetting(setting);
  if (s === "off" || lastDay === day) return { due: false, day };
  const p = localParts(now, tz);
  const minutes = p.h * 60 + p.min;
  const start = parseHHMM(s);
  return { due: minutes >= start && minutes < start + DIGEST_WINDOW_MIN, day };
}

module.exports = { digestDue, digestSetting, DEFAULT_DIGEST_TIME, DIGEST_WINDOW_MIN };
