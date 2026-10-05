/**
 * selfhost/core/text.js — Plain-text safety for ingested strings. Pure.
 *
 * All ingested text is hostile. It is stored and sent as plain text only;
 * these helpers remove characters that are unsafe in any context (NUL and
 * other controls, bidi overrides, zero-width) and cut at a code-point
 * boundary so a slice never leaves a lone surrogate (Telegram rejects
 * strings that are not valid UTF-8).
 */

"use strict";

// C0/C1 controls except \t and \n, bidi embeddings/overrides/isolates, zero-width, BOM.
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripUnsafe(s) {
  return String(s ?? "").replace(UNSAFE, "").replace(LONE_SURROGATE, "");
}

/** First `max` UTF-16 units without splitting a surrogate pair. */
function safeSlice(s, max) {
  if (s.length <= max) return s;
  const cut = /[\uD800-\uDBFF]/.test(s[max - 1]) ? max - 1 : max;
  return s.slice(0, cut);
}

/** Strip unsafe characters, then cap the length. */
function clip(s, max) {
  return safeSlice(stripUnsafe(s), max);
}

module.exports = { stripUnsafe, safeSlice, clip, LONE_SURROGATE };
