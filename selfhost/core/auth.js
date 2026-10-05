/**
 * selfhost/core/auth.js — Key handling. Pure (SubtleCrypto only).
 *
 * Keys are never stored: only sha256(key) hex. Comparison hashes the
 * presented key first, so both sides are 64 hex chars and the compare
 * runs in constant time over a fixed length.
 */

"use strict";

const { sha256Hex } = require("../../extension/core/fingerprint");

/** Constant-time compare of two equal-length strings; false on any length mismatch. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Token from "Authorization: Bearer <token>", or null. */
function bearerToken(header) {
  if (typeof header !== "string" || header.length > 256) return null;
  const m = header.match(/^Bearer ([A-Za-z0-9_-]{20,128})$/);
  return m ? m[1] : null;
}

async function hashKey(key) {
  return sha256Hex(String(key));
}

/** True only when a hash is stored AND the presented token hashes to it. */
async function keyMatches(token, storedHash) {
  if (!token || typeof storedHash !== "string" || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(await hashKey(token), storedHash);
}

/** Random URL-safe secret with `bytes` of entropy (default 32 = 256 bit). */
function randomSecret(bytes = 32) {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

module.exports = { timingSafeEqual, bearerToken, hashKey, keyMatches, randomSecret };
