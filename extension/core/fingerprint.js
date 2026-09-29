/**
 * extension/core/fingerprint.js — Browser-safe post fingerprinting.
 *
 * fingerprintString: pure, synchronous — same tuple db.js hashes with createHash.
 * sha256Hex:         async, uses SubtleCrypto (browser + Node 19+).
 * hashPost:          async convenience wrapper.
 *
 * Dual export: CJS in Node, globalThis.TP in browser.
 */

"use strict";

/**
 * Build the raw string that is SHA-256'd to form a post's fingerprint.
 * MUST stay in sync with db.js hashPost (line 100-106).
 *
 * @param {string} className
 * @param {object} post
 * @returns {string}
 */
function fingerprintString(className, post) {
  const ts      = post.timestampIso || post.timestampFull || "";
  const author  = post.author  || "";
  const subject = post.subject || "";
  const body    = (post.body  || "").slice(0, 500);
  return `${className}\0${author}\0${ts}\0${subject}\0${body}`;
}

/**
 * Compute SHA-256 of a UTF-8 string, returning a lowercase hex digest.
 * Uses globalThis.crypto.subtle (available in browsers and Node >= 19).
 *
 * @param {string} str
 * @returns {Promise<string>}
 */
async function sha256Hex(str) {
  const encoder = new TextEncoder();
  const data    = encoder.encode(str);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes   = new Uint8Array(hashBuf);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Async fingerprint for a post — identical output to db.js hashPost.
 *
 * @param {string} className
 * @param {object} post
 * @returns {Promise<string>} hex digest
 */
async function hashPost(className, post) {
  return sha256Hex(fingerprintString(className, post));
}

const _fingerprint = { fingerprintString, sha256Hex, hashPost };

if (typeof module !== "undefined" && module.exports) {
  module.exports = _fingerprint;
} else {
  globalThis.TP = Object.assign(globalThis.TP || {}, _fingerprint);
}
