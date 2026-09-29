/**
 * background.js — TeamsPulse Background Service Worker (Manifest V3)
 *
 * Phase 2 additions:
 *   - importScripts for core modules (digest-utils, fingerprint, store, messages)
 *   - chrome.runtime.onMessage listener routing content script messages to handleMessage
 *   - chrome.tabs.onRemoved listener clearing tab context
 *
 * Phase 1 localhost badge polling stays intact (removed in Phase 3).
 */

"use strict";

importScripts(
  "core/digest-utils.js",
  "core/fingerprint.js",
  "core/store.js",
  "core/messages.js"
);

// ── Store & Session Backends ────────────────────────────────────────────────

const _store = TP.createStore(TP.chromeBackend());

const _sessionBackend = {
  get(key) {
    return new Promise((resolve, reject) => {
      chrome.storage.session.get([key], (result) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(result[key] ?? null);
      });
    });
  },
  set(key, value) {
    return new Promise((resolve, reject) => {
      chrome.storage.session.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve();
      });
    });
  },
  remove(key) {
    return new Promise((resolve, reject) => {
      chrome.storage.session.remove([key], () => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve();
      });
    });
  },
};

const _deps = {
  store:   _store,
  session: _sessionBackend,
  nowIso:  () => new Date().toISOString(),
};

// ── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) {
    return false;
  }

  TP.handleMessage(msg, sender, _deps)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, reason: err && err.message ? err.message : String(err) }));

  return true;
});

// Clean up tab context when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  const key = TP.tabCtxKey(tabId);
  _sessionBackend.remove(key).catch(() => {});
});

// ── Localhost Polling (Phase 1 legacy — removed in Phase 3) ─────────────────

const API_BASE = "http://localhost:3457";
const ALARM_NAME = "teamspulse-badge-poll";

async function updateBadge() {
  try {
    const res = await fetch(`${API_BASE}/api/digest`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const count = typeof data.newPostCount === "number" ? data.newPostCount : 0;
    const text = count > 0 ? String(count) : "";
    if (typeof chrome !== "undefined" && chrome.action && typeof chrome.action.setBadgeText === "function") {
      await chrome.action.setBadgeText({ text });
      if (text && typeof chrome.action.setBadgeBackgroundColor === "function") {
        await chrome.action.setBadgeBackgroundColor({ color: "#6264a7" });
      }
    }
  } catch {
    // Server might be offline or unreachable; ignore
  }
}

// Set up periodic alarm
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    updateBadge();
  }
});

// Register alarm if not yet scheduled and update badge on service worker startup
chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
});

updateBadge();

