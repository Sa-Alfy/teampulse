/**
 * background.js — TeamsPulse Background Service Worker (Manifest V3)
 *
 *   - importScripts for core modules (digest-utils, fingerprint, store, shape, messages)
 *   - chrome.runtime.onMessage listener routing content script messages to handleMessage
 *   - chrome.tabs.onRemoved listener clearing tab context
 *   - toolbar badge = buildDigest(state).newPostCount, computed from local storage
 *
 * Makes no network requests.
 */

"use strict";

importScripts(
  "core/digest-utils.js",
  "core/fingerprint.js",
  "core/store.js",
  "core/shape.js",
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

// ── Badge (local data only) ─────────────────────────────────────────────────

const LEGACY_ALARM = "teamspulse-badge-poll"; // old 1-minute localhost poll
const BADGE_ALARM  = "teamspulse-badge-refresh";
const BADGE_PERIOD_MIN = 30; // the 24 h "new" window ages with time

async function refreshBadge() {
  try {
    const state = await _store.getState();
    const count = TP.buildDigest(state).newPostCount || 0;
    const text  = count > 0 ? String(count) : "";
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: "#6264a7" });
  } catch {
    // Storage unavailable (e.g. during shutdown); next trigger retries.
  }
}

let _badgeTimer = null;
function scheduleBadgeRefresh() {
  if (_badgeTimer !== null) clearTimeout(_badgeTimer);
  _badgeTimer = setTimeout(() => {
    _badgeTimer = null;
    refreshBadge();
  }, 500);
}

function setupAlarms() {
  chrome.alarms.clear(LEGACY_ALARM);
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: BADGE_PERIOD_MIN });
}

chrome.runtime.onInstalled.addListener(() => {
  setupAlarms();
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarms();
  refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) refreshBadge();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (Object.keys(changes).some((k) => k.startsWith(TP.KEY_PREFIX))) scheduleBadgeRefresh();
});