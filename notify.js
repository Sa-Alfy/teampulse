/**
 * notify.js — Send-only Telegram push notification utility for TeamsPulse
 *
 * Usage:
 *   const { sendTelegram } = require("./notify");
 *   await sendTelegram("message text");
 *
 * CLI:
 *   node notify.js --test
 */

"use strict";

const path = require("path");

let envAttempted = false;
function loadEnv() {
  if (!envAttempted) {
    envAttempted = true;
    if (typeof process.loadEnvFile === "function") {
      try {
        process.loadEnvFile(path.join(__dirname, ".env"));
      } catch (_) {
        // Silently ignore if .env does not exist or fails to load
      }
    }
  }
}

loadEnv();

/**
 * Scrub secret credentials (bot token, chat id) from any error string.
 */
function scrub(str, token, chatId) {
  if (!str) return "";
  let s = String(str);
  if (token) s = s.split(token).join("[REDACTED]");
  if (chatId) s = s.split(chatId).join("[REDACTED]");
  return s;
}

/**
 * Split text into chunks <= maxLen characters on newline boundaries.
 */
function splitChunks(text, maxLen = 4000) {
  if (typeof text !== "string" || text.length === 0) return [];
  if (text.length <= maxLen) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let currentChunk = null;

  for (let line of lines) {
    while (line.length > maxLen) {
      if (currentChunk !== null) {
        chunks.push(currentChunk);
        currentChunk = null;
      }
      chunks.push(line.slice(0, maxLen));
      line = line.slice(maxLen);
    }

    if (currentChunk === null) {
      currentChunk = line;
    } else {
      if (currentChunk.length + 1 + line.length <= maxLen) {
        currentChunk += "\n" + line;
      } else {
        chunks.push(currentChunk);
        currentChunk = line;
      }
    }
  }

  if (currentChunk !== null) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Send plain text message to Telegram.
 *
 * @param {string} text
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function sendTelegram(text) {
  loadEnv();

  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();

  if (!token || !chatId) {
    return { sent: false, reason: "not-configured" };
  }

  if (!text || typeof text !== "string") {
    return { sent: false, reason: "empty-text" };
  }

  const chunks = splitChunks(text, 4000);
  if (chunks.length === 0) {
    return { sent: false, reason: "empty-text" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  for (const chunk of chunks) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        const desc = (data && data.description) || `http-${res.status}`;
        return { sent: false, reason: scrub(desc, token, chatId) };
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return { sent: false, reason: scrub(msg, token, chatId) };
    }
  }

  return { sent: true };
}

if (require.main === module) {
  if (process.argv.includes("--test")) {
    sendTelegram("TeamsPulse test").then((res) => {
      console.log(res);
    });
  }
}

module.exports = {
  sendTelegram,
  splitChunks,
};
