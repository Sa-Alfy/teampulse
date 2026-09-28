/**
 * background.js — TeamsPulse Background Service Worker (Manifest V3)
 *
 * Polls the TeamsPulse local server periodically to update the toolbar
 * badge with the number of new posts, even when the popup is closed.
 */

"use strict";

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
