/**
 * popup.js — TeamsPulse Chrome/Edge Extension Logic
 *
 * Standalone: reads everything from chrome.storage.local via core/store.js and
 * shapes it with core/shape.js. Makes no network requests. Live-updates on
 * chrome.storage.onChanged instead of polling.
 *
 * Three views over the same data:
 *   Overview — what needs attention: overdue, due today / tomorrow / this week,
 *              dated exams & quizzes pulled from announcements, unread updates.
 *   Tasks    — every open assignment by due date; tick one off to hide it.
 *   Updates  — announcements newest first, grouped by day, unread marked.
 *
 * "Done" and "read" marks are local UI state (tp:ui:*), never sent anywhere.
 *
 * Scraped text is untrusted — it is only ever written with textContent.
 */

"use strict";

const store = TP.createStore(TP.chromeBackend());
const TAB_CTX_PREFIX = TP.tabCtxKey("");

// DOM Elements
const filterToggleBtn  = document.getElementById("filterToggleBtn");
const settingsBtn      = document.getElementById("settingsBtn");
const settingsPanel    = document.getElementById("settingsPanel");
const clearDataBtn     = document.getElementById("clearDataBtn");
const staleBanner      = document.getElementById("staleBanner");
const scraperBanner    = document.getElementById("scraperBanner");
const syncAllBtn       = document.getElementById("syncAllBtn");
const syncIcon         = document.getElementById("syncIcon");
const syncStatus       = document.getElementById("syncStatus");

const SYNC_CMD_KEY    = "tp:sync:cmd";
const SYNC_STATUS_KEY = "tp:sync:status";
const SYNC_REASONS = {
  "classes-page-not-found": "Couldn't open the Teams classes page.",
  "no-classes-found":       "No classes found on the Teams page.",
  "unexpected":             "Sync stopped unexpectedly.",
};

// Local UI state — not scraped data, so outside the tp:v1: namespace.
const UI_DONE_KEY = "tp:ui:done"; // task keys the student ticked off
const UI_READ_KEY = "tp:ui:read"; // announcement keys the student has read

const controlsBar      = document.getElementById("controlsBar");
const searchInput      = document.getElementById("searchInput");
const clearSearchBtn   = document.getElementById("clearSearchBtn");
const classChips       = document.getElementById("classChips");

const liveBadge        = document.getElementById("liveBadge");
const liveText         = document.getElementById("liveText");
const footerStats      = document.getElementById("footerStats");

// Tab buttons & counts
const tabAll           = document.getElementById("tabAll");
const tabNotices       = document.getElementById("tabNotices");
const tabAssignments   = document.getElementById("tabAssignments");
const countAll         = document.getElementById("countAll");
const countNotices     = document.getElementById("countNotices");
const countAssignments = document.getElementById("countAssignments");

// State containers
const loadingState     = document.getElementById("loadingState");
const noDataState      = document.getElementById("noDataState");
const filterEmptyState = document.getElementById("filterEmptyState");
const feedContainer    = document.getElementById("feedContainer");
const feedActions      = document.getElementById("feedActions");
const classList        = document.getElementById("classList");

// Local App State
let activeTab          = "all"; // "all" | "notices" | "assignments"
let selectedClass      = "all";
let rawDigestData      = null;
let rawStatusData      = null;
let tickerInterval     = null;
let reloadTimer        = null;
let doneSet            = new Set();
let readSet            = new Set();
const expanded         = { oldOverdue: false, done: false };

const DAY_MS = 86400e3;
const OLD_OVERDUE_DAYS = 14;   // overdue longer than this folds away
const OVERVIEW_UPDATES = 5;    // unread announcements shown on Overview

function readUiSets() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([UI_DONE_KEY, UI_READ_KEY], (res) => {
        const r = res || {};
        doneSet = new Set(Array.isArray(r[UI_DONE_KEY]) ? r[UI_DONE_KEY] : []);
        readSet = new Set(Array.isArray(r[UI_READ_KEY]) ? r[UI_READ_KEY] : []);
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}
const uiSetsPromise = readUiSets();

function saveUiSet(key, set) {
  try {
    chrome.storage.local.set({ [key]: Array.from(set) });
  } catch (_) {
    // Storage unavailable — the mark lasts until the popup closes.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function formatRelativeTime(isoString) {
  if (!isoString) return "Never";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;

  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 45) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "2026-07-18" → local midnight. `new Date("2026-07-18")` is UTC midnight,
 *  which is the previous day west of Greenwich. */
function parseLocalDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return isNaN(ms) ? null : ms;
}

function dayDiff(ms, nowMs) {
  return Math.round((startOfDay(ms) - startOfDay(nowMs)) / DAY_MS);
}

function formatDay(ms) {
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Countdown for a due moment: "in 3h", "tomorrow", "in 5 days", "2d late". */
function countdown(ms, nowMs, { dayOnly = false } = {}) {
  const diff = ms - nowMs;
  const days = dayDiff(ms, nowMs);
  if (diff < 0 && !dayOnly) {
    const late = -diff;
    if (late < 3600e3) return `${Math.max(1, Math.round(late / 60e3))}m late`;
    if (late < DAY_MS) return `${Math.round(late / 3600e3)}h late`;
    return `${Math.floor(late / DAY_MS)}d late`;
  }
  if (days === 0) {
    if (dayOnly) return "today";
    if (diff < 3600e3) return `in ${Math.max(1, Math.round(diff / 60e3))}m`;
    return `in ${Math.round(diff / 3600e3)}h`;
  }
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

// Tag → CSS modifier. Keyed on the exact strings classify() emits rather than
// on substrings: `t.includes("ct")` matches any label containing those two
// letters, so a future "Lecture" or "Practical" tag would silently render in
// CT red. Anything unrecognised falls back to the neutral notice style.
const TAG_CLASSES = {
  "🧪 CT/Quiz":      "ct",
  "📝 Exam":         "exam",
  "🎤 Presentation": "presentation",
  "🔄 Reschedule":   "reschedule",
  "❌ Cancelled":    "cancelled",
  "📌 Deadline":     "deadline",
  "📊 Grades":       "grades",
  "📢 Notice":       "notice",
};

// Announcements with these tags and a date become entries on the agenda.
const EVENT_TAGS = new Set(["ct", "exam", "presentation", "reschedule", "cancelled", "deadline"]);

function getTagClass(tag) {
  if (!tag) return "notice";
  return TAG_CLASSES[tag.trim()] || "notice";
}

// A stable accent per class so a course reads the same colour everywhere.
const CLASS_COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#f87171", "#22d3ee", "#fb923c"];

function classColor(key) {
  let h = 0;
  for (const ch of String(key || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return CLASS_COLORS[h % CLASS_COLORS.length];
}

function classChip(item) {
  const chip = el("span", "class-chip", item.classLabel);
  chip.style.setProperty("--c", item.color);
  chip.title = item.rawClassName || item.classLabel;
  return chip;
}

function taskKey(c, a) {
  return `t|${c.key || c.rawClassName || c.className}|${a.title || ""}|${a.dueDate || ""}`;
}

function noticeKey(c, n) {
  return `n|${c.key || c.rawClassName || c.className}|${n.timestampIso || n.originalTimestamp || ""}|${(n.subject || n.summary || "").slice(0, 60)}`;
}

/**
 * Append untrusted text to `parent`, turning https:// URLs into links that
 * open in a new tab. Long ones are shown compactly ("🔗 docs.google.com/…").
 * Only https URLs that parse cleanly become links (no javascript:, data: or
 * plain http); the popup itself still fetches nothing — a link only loads
 * when the student clicks it. Everything goes through textContent and the
 * href property — never innerHTML.
 */
const URL_RE = /https:\/\/[^\s<>"']+/g;
const LONG_URL = 40;

function safeHttpsUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname ? u : null;
  } catch (_) {
    return null;
  }
}

function appendLinkified(parent, text) {
  const str = String(text || "");
  let last = 0;
  for (const m of str.matchAll(URL_RE)) {
    let url = m[0];
    const trail = /[).,;:!?\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const parsed = safeHttpsUrl(url);
    if (!parsed) continue; // leave it in the text run
    if (m.index > last) parent.appendChild(document.createTextNode(str.slice(last, m.index)));
    const host = parsed.hostname.replace(/^www\./, "");
    const link = el("a", "link-chip", url.length > LONG_URL ? `🔗 ${host}/…` : url);
    link.href = parsed.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    link.title = `Open ${parsed.href}`;
    link.addEventListener("click", (e) => e.stopPropagation()); // don't toggle the card
    parent.appendChild(link);
    last = m.index + url.length;
  }
  if (last < str.length) parent.appendChild(document.createTextNode(str.slice(last)));
}

function setView(viewName) {
  loadingState.classList.add("hidden");
  noDataState.classList.add("hidden");
  filterEmptyState.classList.add("hidden");
  feedContainer.classList.add("hidden");

  switch (viewName) {
    case "loading":
      loadingState.classList.remove("hidden");
      break;
    case "no-data":
      noDataState.classList.remove("hidden");
      break;
    case "filter-empty":
      filterEmptyState.classList.remove("hidden");
      break;
    case "feed":
      feedContainer.classList.remove("hidden");
      break;
  }
}

function setHealthPill(health) {
  if (health === "ok") {
    liveBadge.classList.remove("offline");
    liveText.textContent = "Fresh";
  } else {
    liveBadge.classList.add("offline");
    liveText.textContent = "Stale";
  }
}

function setBadge(text) {
  if (typeof chrome !== "undefined" && chrome.action && typeof chrome.action.setBadgeText === "function") {
    chrome.action.setBadgeText({ text });
  }
}

// ---------------------------------------------------------------------------
// Data (local storage only — no network)
// ---------------------------------------------------------------------------

async function loadData() {
  try {
    const [state] = await Promise.all([store.getState(), uiSetsPromise]);
    const nowMs = Date.now();
    rawStatusData = TP.buildStatus(state, nowMs);
    rawDigestData = TP.buildDigest(state, { nowMs });

    pruneUiSets();
    updateHeaderMeta();
    renderClassChips();
    applyFiltersAndRender();
  } catch (err) {
    rawStatusData = null;
    rawDigestData = null;
    footerStats.textContent = "Could not read stored data.";
    setView("no-data");
  }
}

/** Forget done/read marks for items that are no longer stored. */
function pruneUiSets() {
  const classes = (rawDigestData && rawDigestData.classes) || [];
  if (classes.length === 0) return;
  const live = new Set();
  for (const c of classes) {
    for (const a of c.assignments || []) live.add(taskKey(c, a));
    for (const n of c.notices || []) live.add(noticeKey(c, n));
  }
  for (const [key, set] of [[UI_DONE_KEY, doneSet], [UI_READ_KEY, readSet]]) {
    const before = set.size;
    for (const k of set) if (!live.has(k)) set.delete(k);
    if (set.size !== before) saveUiSet(key, set);
  }
}

function scheduleReload() {
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    loadData();
  }, 300);
}

function updateHeaderMeta() {
  if (!rawStatusData) return;
  const noData = Boolean(rawStatusData.noDataYet);
  const captured = rawStatusData.lastScrape
    ? `Updated ${formatRelativeTime(rawStatusData.lastScrape)}`
    : "Nothing captured yet";

  // A suspect scraper explains stale data better than "open Teams" does, so it
  // replaces the stale banner rather than stacking with it.
  const suspect = rawStatusData.scraper === "suspect";
  setHealthPill(rawStatusData.health);
  liveBadge.title = rawStatusData.lastScrape ? `Last capture: ${formatRelativeTime(rawStatusData.lastScrape)}` : "Nothing captured yet";
  scraperBanner.classList.toggle("hidden", !suspect);
  staleBanner.classList.toggle("hidden", suspect || noData || rawStatusData.health !== "stale");

  const totalSeen = rawStatusData.totalSeen || 0;
  footerStats.textContent = `${captured} · ${totalSeen} posts on this device`;
}

// Two-step confirm inside the popup (native confirm() dialogs are unreliable
// in extension popups).
let clearConfirmTimer = null;

async function clearAllData() {
  await store.clearAll();
  await chrome.storage.local.remove([UI_DONE_KEY, UI_READ_KEY]);
  doneSet = new Set();
  readSet = new Set();
  if (chrome.storage && chrome.storage.session) {
    const all = await chrome.storage.session.get(null);
    const ctxKeys = Object.keys(all || {}).filter((k) => k.startsWith(TAB_CTX_PREFIX));
    if (ctxKeys.length > 0) await chrome.storage.session.remove(ctxKeys);
  }
  setBadge("");
}

function resetClearButton() {
  clearConfirmTimer = null;
  clearDataBtn.classList.remove("confirming");
  clearDataBtn.textContent = "Clear stored data";
}

// ---------------------------------------------------------------------------
// Model: flatten classes into tasks, dated events and announcements
// ---------------------------------------------------------------------------

function classLabelOf(c) {
  // displayName carries the section suffix when two teams share a course
  // code, so "CSE 312 (V1)" and "CSE 312 (V2)" stay tellable apart.
  return c.displayName || c.className;
}

function renderClassChips() {
  const classes = (rawDigestData && rawDigestData.classes) || [];
  // Value is the raw class name: two sections of one course share a short
  // name, so selecting by short name would filter to both.
  if (selectedClass !== "all" && !classes.some((c) => (c.key || c.rawClassName || c.className) === selectedClass)) {
    selectedClass = "all";
  }
  classChips.replaceChildren();
  classChips.hidden = classes.length < 2;
  if (classes.length < 2) return;

  const make = (value, label, color) => {
    const b = el("button", "filter-chip", label);
    b.type = "button";
    if (color) b.style.setProperty("--c", color);
    b.setAttribute("aria-pressed", value === selectedClass ? "true" : "false");
    b.addEventListener("click", () => {
      selectedClass = value === selectedClass ? "all" : value;
      renderClassChips();
      applyFiltersAndRender();
    });
    return b;
  };
  classChips.appendChild(make("all", "All classes", null));
  for (const c of classes) {
    const key = c.key || c.rawClassName || c.className;
    classChips.appendChild(make(key, classLabelOf(c), classColor(key)));
  }
}

function buildModel(nowMs) {
  const query = searchInput.value.trim().toLowerCase();
  const matches = (s) => !query || s.toLowerCase().includes(query);

  const tasks = [];
  const events = [];
  const notices = [];

  for (const c of rawDigestData.classes) {
    const key = c.key || c.rawClassName || c.className;
    if (selectedClass !== "all" && key !== selectedClass) continue;
    const base = { classKey: key, classLabel: classLabelOf(c), classShort: c.className,
      rawClassName: c.rawClassName, color: classColor(key) };

    for (const a of c.assignments || []) {
      if (!matches(`${a.title} ${a.details || ""} ${a.tab} ${base.classLabel}`)) continue;
      let dueMs = null;
      if (a.dueIso) dueMs = Date.parse(a.dueIso);
      if ((dueMs === null || isNaN(dueMs)) && a.dueDate) {
        const d = parseLocalDate(a.dueDate);
        dueMs = d === null ? null : d + DAY_MS - 60e3;
      }
      if (dueMs !== null && isNaN(dueMs)) dueMs = null;
      // Teams says "Past due" even when our parsed date disagrees; trust it.
      const overdue = a.tab === "Past due" || (dueMs !== null && dueMs < nowMs);
      const k = taskKey(c, a);
      tasks.push({ ...base, kind: "task", key: k, a, title: a.title || "Untitled assignment",
        dueMs, hasTime: Boolean(a.dueTime), overdue, done: doneSet.has(k) });
    }

    for (const n of c.notices || []) {
      const text = `${n.tag} ${n.summary} ${n.subject || ""} ${n.author || ""} ${n.date || ""} ${base.classLabel}`;
      if (!matches(text)) continue;
      const k = noticeKey(c, n);
      const postedMs = n.timestampIso ? Date.parse(n.timestampIso) : NaN;
      const item = { ...base, kind: "notice", key: k, n, tagClass: getTagClass(n.tag),
        postedMs: isNaN(postedMs) ? null : postedMs, unread: Boolean(n.isNew) && !readSet.has(k) };
      notices.push(item);

      const dayMs = parseLocalDate(n.date);
      if (dayMs !== null && EVENT_TAGS.has(item.tagClass) && dayDiff(dayMs, nowMs) >= 0) {
        events.push({ ...base, kind: "event", key: k, notice: item, dueMs: dayMs, tagClass: item.tagClass,
          title: n.subject || n.summary || "Announcement" });
      }
    }
  }

  notices.sort((x, y) => (y.postedMs || 0) - (x.postedMs || 0));

  // One agenda entry per class/day/kind (several posts often repeat the same
  // CT date), and none when an assignment on that day already covers it.
  const seen = new Set();
  const dedupedEvents = [];
  for (const ev of events.sort((x, y) => (y.notice.postedMs || 0) - (x.notice.postedMs || 0))) {
    const id = `${ev.classKey}|${ev.dueMs}|${ev.tagClass}`;
    if (seen.has(id)) continue;
    const blob = `${ev.notice.n.subject || ""} ${ev.notice.n.summary || ""}`.toLowerCase();
    const coveredByTask = tasks.some((t) => t.classKey === ev.classKey && t.dueMs !== null &&
      startOfDay(t.dueMs) === ev.dueMs && t.title.length > 2 && blob.includes(t.title.toLowerCase()));
    if (coveredByTask) continue;
    seen.add(id);
    dedupedEvents.push(ev);
  }

  return { tasks, events: dedupedEvents, notices, query };
}

/** Split agenda items into time buckets, each sorted soonest first. */
function bucketize(items, nowMs) {
  const b = { overdue: [], today: [], tomorrow: [], week: [], later: [], undated: [] };
  for (const it of items) {
    if (it.kind === "task" && it.overdue) { b.overdue.push(it); continue; }
    if (it.dueMs === null) { b.undated.push(it); continue; }
    const d = dayDiff(it.dueMs, nowMs);
    if (d <= 0) b.today.push(it);
    else if (d === 1) b.tomorrow.push(it);
    else if (d <= 7) b.week.push(it);
    else b.later.push(it);
  }
  const bySoonest = (x, y) => (x.dueMs ?? Infinity) - (y.dueMs ?? Infinity);
  for (const list of Object.values(b)) list.sort(bySoonest);
  b.overdue.reverse(); // most recently missed first — the ones still worth saving
  return b;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function sectionHeader(label, count, tone) {
  const h = el("div", `section-label${tone ? ` ${tone}` : ""}`);
  h.appendChild(el("span", null, label));
  if (count !== undefined) h.appendChild(el("span", "section-count", String(count)));
  return h;
}

// ── Open in Teams ───────────────────────────────────────────────────────────
// Like Sync: the popup can't script a tab, so it stores a command that the
// Teams tab's content script runs (open the class and scroll to the post, or
// open the Assignments app and find the card). The popup then brings a Teams
// tab it knows about to the front (tab ids from the background's per-tab
// class notes), or opens Teams in a new tab. chrome.tabs.update/create and
// chrome.windows.update need no extra permission.

const NAV_CMD_KEY  = "tp:nav:cmd";
const TEAMS_HOME   = "https://teams.cloud.microsoft/";

function postCommand(it) {
  const n = it.n;
  const body = (n.bodySnippet || "").replace(/…$/, "").slice(0, 40);
  return { kind: "post", className: it.classKey, subject: n.subject || "", bodyStart: body,
    timestampIso: n.timestampIso || null };
}

function taskCommand(it) {
  return { kind: "task", className: it.classKey, classShort: it.classShort, tab: it.a.tab,
    title: it.a.title || "", assignmentId: it.a.assignmentId || null };
}

async function openInTeams(cmd) {
  // Store first: switching tabs closes the popup and ends this script.
  await chrome.storage.local.set({ [NAV_CMD_KEY]: { ...cmd, id: `${Date.now()}-${Math.random()}`, at: Date.now() } });
  let tabIds = [];
  try {
    const ctx = await chrome.storage.session.get(null);
    const entries = Object.entries(ctx || {}).filter(([k]) => k.startsWith(TAB_CTX_PREFIX));
    // A tab already showing that class first, then any other Teams tab.
    entries.sort(([, a], [, b]) => (b === cmd.className) - (a === cmd.className));
    tabIds = entries.map(([k]) => Number(k.slice(TAB_CTX_PREFIX.length))).filter(Number.isInteger);
  } catch (_) { /* no session storage: fall through to a new tab */ }
  for (const id of tabIds) {
    try {
      const tab = await chrome.tabs.update(id, { active: true });
      if (tab && typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true });
      window.close();
      return;
    } catch (_) { /* tab gone — try the next */ }
  }
  try {
    await chrome.tabs.create({ url: TEAMS_HOME });
    window.close();
  } catch (_) {
    syncStatus.textContent = "Couldn't switch to Teams. Open your Teams tab, then click the card again.";
  }
}

/** Whole card opens in Teams on click / Enter; inner controls stop the click. */
function makeOpenable(node, label, onOpen) {
  node.classList.add("openable");
  node.tabIndex = 0;
  node.setAttribute("role", "link");
  node.setAttribute("aria-label", label);
  node.title = label;
  node.addEventListener("click", onOpen);
  node.addEventListener("keydown", (e) => {
    if (e.target === node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); }
  });
}

function agendaRow(it, nowMs) {
  const row = el("div", `agenda-row ${it.kind}`);
  row.style.setProperty("--c", it.color);
  if (it.kind === "task" && it.overdue) row.classList.add("overdue");
  if (it.done) row.classList.add("done");
  if (it.dueMs !== null && !it.overdue && it.dueMs - nowMs <= 48 * 3600e3) row.classList.add("due-soon");

  // Date block
  const dateBox = el("div", "date-box");
  if (it.dueMs !== null) {
    const d = new Date(it.dueMs);
    dateBox.appendChild(el("span", "dow", d.toLocaleDateString(undefined, { weekday: "short" })));
    dateBox.appendChild(el("span", "dom", String(d.getDate())));
    dateBox.title = formatDay(it.dueMs);
  } else {
    dateBox.appendChild(el("span", "dom", "—"));
    dateBox.title = "No due date";
  }
  row.appendChild(dateBox);

  // Title + meta
  const main = el("div", "row-main");
  const title = el("div", "row-title");
  appendLinkified(title, it.title);
  main.appendChild(title);

  const meta = el("div", "row-meta");
  meta.appendChild(classChip(it));
  if (it.kind === "event") {
    meta.appendChild(el("span", `tag-badge ${it.tagClass}`, it.notice.n.tag));
    if (it.notice.n.time) meta.appendChild(el("span", "meta-text", it.notice.n.time));
  } else {
    const bits = [];
    if (it.dueMs !== null) bits.push(formatDay(it.dueMs) + (it.hasTime ? `, ${formatClock(it.dueMs)}` : ""));
    if (it.a.details && !/^due\b/i.test(it.a.details)) bits.push(it.a.details);
    if (bits.length) meta.appendChild(el("span", "meta-text", bits.join(" · ")));
  }
  main.appendChild(meta);
  row.appendChild(main);

  // Countdown + done toggle
  const side = el("div", "row-side");
  if (it.dueMs !== null || it.overdue) {
    const cd = it.dueMs !== null && !(it.overdue && it.dueMs > nowMs)
      ? countdown(it.dueMs, nowMs, { dayOnly: it.kind === "event" })
      : "past due";
    side.appendChild(el("span", "countdown", cd));
  }
  if (it.kind === "task") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "done-box";
    box.checked = it.done;
    box.title = it.done ? "Mark as not done" : "Mark as done (only hides it here; Teams is not changed)";
    box.setAttribute("aria-label", `${it.done ? "Undo done" : "Mark done"}: ${it.title}`);
    box.addEventListener("click", (e) => e.stopPropagation()); // not "open in Teams"
    box.addEventListener("change", () => {
      if (box.checked) doneSet.add(it.key); else doneSet.delete(it.key);
      saveUiSet(UI_DONE_KEY, doneSet);
      applyFiltersAndRender();
    });
    side.appendChild(box);
  }
  row.appendChild(side);
  if (it.kind === "task") {
    makeOpenable(row, `Open this assignment in Teams (${it.classLabel})`, () => openInTeams(taskCommand(it)));
  } else {
    makeOpenable(row, `Open this announcement in Teams (${it.classLabel})`, () => openInTeams(postCommand(it.notice)));
  }
  return row;
}

function noticeCard(it, nowMs) {
  const n = it.n;
  const card = el("article", `notice-card${it.unread ? " unread" : ""}`);
  card.style.setProperty("--c", it.color);

  const top = el("div", "notice-top");
  top.appendChild(classChip(it));
  if (it.tagClass !== "notice") top.appendChild(el("span", `tag-badge ${it.tagClass}`, n.tag));
  if (it.unread) top.appendChild(el("span", "new-pill", "New"));
  top.appendChild(el("span", "spacer"));
  const when = el("span", "notice-when", it.postedMs ? formatRelativeTime(n.timestampIso) : (n.originalTimestamp || ""));
  if (n.originalTimestamp) when.title = n.originalTimestamp;
  top.appendChild(when);
  card.appendChild(top);

  const text = el("div", "notice-text clamp");
  appendLinkified(text, n.summary || n.subject || "No text provided");
  card.appendChild(text);

  const foot = el("div", "notice-foot");
  const dayMs = parseLocalDate(n.date);
  if (dayMs !== null) {
    const d = dayDiff(dayMs, nowMs);
    const rel = d >= 0 ? countdown(dayMs, nowMs, { dayOnly: true }) : `${-d}d ago`;
    foot.appendChild(el("span", "notice-date", `📅 ${formatDay(dayMs)}${n.time ? `, ${n.time}` : ""} · ${rel}`));
  }
  if (n.author) foot.appendChild(el("span", "notice-author", n.author));
  card.appendChild(foot);

  const markRead = () => {
    if (!it.unread) return;
    it.unread = false;
    readSet.add(it.key);
    saveUiSet(UI_READ_KEY, readSet);
    card.classList.remove("unread");
    const pill = card.querySelector(".new-pill");
    if (pill) pill.remove();
    updateUnreadCount();
  };

  // "Show more" expands in place; a click anywhere else opens the post in Teams.
  if ((n.summary || n.subject || "").length > 150) {
    const more = el("button", "more-btn inline", "Show more");
    more.type = "button";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const clamped = text.classList.toggle("clamp");
      more.textContent = clamped ? "Show more" : "Show less";
      markRead();
    });
    foot.prepend(more);
  }
  makeOpenable(card, `Open this post in Teams (${it.classLabel})`, () => { markRead(); openInTeams(postCommand(it)); });
  return card;
}

let lastModel = null;

function updateUnreadCount() {
  if (!lastModel) return;
  const unread = lastModel.notices.filter((x) => x.unread).length;
  setCount(countNotices, unread);
}

function setCount(node, n, tone) {
  node.textContent = n;
  node.classList.toggle("zero", n === 0);
  node.classList.toggle("alert", Boolean(tone) && n > 0);
}

function appendBucket(list, label, items, nowMs, tone) {
  if (items.length === 0) return;
  list.appendChild(sectionHeader(label, items.length, tone));
  for (const it of items) list.appendChild(agendaRow(it, nowMs));
}

function appendOverdue(list, items, nowMs) {
  if (items.length === 0) return;
  const cutoff = nowMs - OLD_OVERDUE_DAYS * DAY_MS;
  const recent = items.filter((it) => it.dueMs === null || it.dueMs >= cutoff);
  const old = items.filter((it) => it.dueMs !== null && it.dueMs < cutoff);
  list.appendChild(sectionHeader("Overdue", items.length, "danger"));
  for (const it of recent) list.appendChild(agendaRow(it, nowMs));
  if (old.length > 0) {
    if (expanded.oldOverdue) for (const it of old) list.appendChild(agendaRow(it, nowMs));
    const more = el("button", "more-btn",
      expanded.oldOverdue ? "Hide older overdue" : `Show ${old.length} older overdue (more than ${OLD_OVERDUE_DAYS} days)`);
    more.type = "button";
    more.addEventListener("click", () => { expanded.oldOverdue = !expanded.oldOverdue; applyFiltersAndRender(); });
    list.appendChild(more);
  }
  const hint = el("div", "hint", "Already handed it in? Tick the box to hide it.");
  list.appendChild(hint);
}

function renderOverview(list, model, nowMs) {
  const open = model.tasks.filter((t) => !t.done);
  const b = bucketize([...open, ...model.events], nowMs);
  const soon = b.today.length + b.tomorrow.length + b.week.length;

  // One-line summary, the first thing a student reads.
  const parts = [];
  if (b.overdue.length) parts.push(`${b.overdue.length} overdue`);
  if (b.today.length) parts.push(`${b.today.length} today`);
  if (b.tomorrow.length) parts.push(`${b.tomorrow.length} tomorrow`);
  if (b.week.length) parts.push(`${b.week.length} later this week`);
  const summary = el("div", `summary-card${b.overdue.length ? " has-overdue" : ""}`);
  summary.appendChild(el("div", "summary-title", parts.length ? parts.join(" · ") : "Nothing due this week 🎉"));
  const nextUp = [...b.today, ...b.tomorrow, ...b.week, ...b.later][0];
  if (nextUp) {
    summary.appendChild(el("div", "summary-sub",
      `Next: ${nextUp.title} (${nextUp.classLabel}) ${countdown(nextUp.dueMs, nowMs, { dayOnly: nextUp.kind === "event" })}`));
  }
  list.appendChild(summary);

  appendOverdue(list, b.overdue, nowMs);
  appendBucket(list, "Today", b.today, nowMs, "warn");
  appendBucket(list, "Tomorrow", b.tomorrow, nowMs, "warn");
  appendBucket(list, "This week", b.week, nowMs);
  appendBucket(list, "Later", b.later, nowMs);
  appendBucket(list, "No due date", b.undated, nowMs);

  // Unread announcements not already on the agenda.
  const onAgenda = new Set(model.events.map((e) => e.key));
  const fresh = model.notices.filter((x) => x.unread && !onAgenda.has(x.key));
  if (fresh.length) {
    list.appendChild(sectionHeader("New announcements", fresh.length));
    for (const it of fresh.slice(0, OVERVIEW_UPDATES)) list.appendChild(noticeCard(it, nowMs));
    if (fresh.length > OVERVIEW_UPDATES) {
      const more = el("button", "more-btn", `See all ${fresh.length} new in Updates →`);
      more.type = "button";
      more.addEventListener("click", () => selectTab("notices"));
      list.appendChild(more);
    }
  }
  return soon + b.overdue.length;
}

function renderTasks(list, model, nowMs) {
  const open = model.tasks.filter((t) => !t.done);
  const done = model.tasks.filter((t) => t.done);
  const b = bucketize(open, nowMs);

  if (open.length === 0) list.appendChild(el("div", "summary-card", "No open assignments 🎉"));
  appendOverdue(list, b.overdue, nowMs);
  appendBucket(list, "Today", b.today, nowMs, "warn");
  appendBucket(list, "Tomorrow", b.tomorrow, nowMs, "warn");
  appendBucket(list, "This week", b.week, nowMs);
  appendBucket(list, "Later", b.later, nowMs);
  appendBucket(list, "No due date", b.undated, nowMs);

  if (done.length) {
    const more = el("button", "more-btn", expanded.done ? `Hide ${done.length} done` : `✓ ${done.length} marked done — show`);
    more.type = "button";
    more.addEventListener("click", () => { expanded.done = !expanded.done; applyFiltersAndRender(); });
    list.appendChild(more);
    if (expanded.done) for (const it of done) list.appendChild(agendaRow(it, nowMs));
  }
}

function renderUpdates(list, model, nowMs) {
  const unread = model.notices.filter((x) => x.unread);
  const bar = el("div", "updates-bar");
  bar.appendChild(el("span", null, unread.length ? `${unread.length} unread` : "All caught up"));
  if (unread.length) {
    const markAll = el("button", "link-btn", "Mark all as read");
    markAll.type = "button";
    markAll.addEventListener("click", () => {
      for (const it of unread) readSet.add(it.key);
      saveUiSet(UI_READ_KEY, readSet);
      applyFiltersAndRender();
    });
    bar.appendChild(markAll);
  }
  list.appendChild(bar);

  const groups = [["Today", []], ["Yesterday", []], ["This week", []], ["Earlier", []]];
  for (const it of model.notices) {
    const d = it.postedMs === null ? -999 : dayDiff(it.postedMs, nowMs);
    const idx = d >= 0 ? 0 : d === -1 ? 1 : d >= -7 ? 2 : 3;
    groups[idx][1].push(it);
  }
  for (const [label, items] of groups) {
    if (!items.length) continue;
    list.appendChild(sectionHeader(label, items.length));
    for (const it of items) list.appendChild(noticeCard(it, nowMs));
  }
}

function applyFiltersAndRender() {
  if (!rawDigestData || !rawDigestData.classes || rawDigestData.classes.length === 0) {
    setView("no-data");
    return;
  }

  const nowMs = Date.now();
  const model = buildModel(nowMs);
  lastModel = model;

  // Counts are "things that need you", not totals.
  const open = model.tasks.filter((t) => !t.done);
  const attention = open.filter((t) => t.overdue || (t.dueMs !== null && dayDiff(t.dueMs, nowMs) <= 7)).length +
    model.events.filter((e) => dayDiff(e.dueMs, nowMs) <= 7).length;
  setCount(countAll, attention, open.some((t) => t.overdue));
  setCount(countAssignments, open.length);
  setCount(countNotices, model.notices.filter((x) => x.unread).length);

  const filtering = Boolean(model.query) || selectedClass !== "all";
  if (model.tasks.length === 0 && model.notices.length === 0) {
    setView(filtering ? "filter-empty" : "no-data");
    return;
  }

  classList.replaceChildren();
  if (activeTab === "assignments") renderTasks(classList, model, nowMs);
  else if (activeTab === "notices") renderUpdates(classList, model, nowMs);
  else renderOverview(classList, model, nowMs);

  feedActions.hidden = activeTab === "notices";
  setView("feed");
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

const TAB_BUTTONS = { all: tabAll, notices: tabNotices, assignments: tabAssignments };

function selectTab(tabKey) {
  activeTab = tabKey;
  for (const [key, btn] of Object.entries(TAB_BUTTONS)) {
    btn.classList.toggle("active", key === tabKey);
    btn.setAttribute("aria-selected", key === tabKey ? "true" : "false");
  }
  applyFiltersAndRender();
  document.getElementById("mainContent").scrollTop = 0;
}

tabAll.addEventListener("click", () => selectTab("all"));
tabNotices.addEventListener("click", () => selectTab("notices"));
tabAssignments.addEventListener("click", () => selectTab("assignments"));

// Search
searchInput.addEventListener("input", () => {
  clearSearchBtn.classList.toggle("hidden", searchInput.value.length === 0);
  applyFiltersAndRender();
});

clearSearchBtn.addEventListener("click", () => {
  searchInput.value = "";
  clearSearchBtn.classList.add("hidden");
  applyFiltersAndRender();
  searchInput.focus();
});

function togglePanel(panel, btn, onOpen) {
  panel.hidden = !panel.hidden;
  btn.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
  btn.classList.toggle("active", !panel.hidden);
  if (!panel.hidden && onOpen) onOpen();
}

filterToggleBtn.addEventListener("click", () => togglePanel(controlsBar, filterToggleBtn, () => searchInput.focus()));
settingsBtn.addEventListener("click", () => togglePanel(settingsPanel, settingsBtn));

// Clear stored data (two-step confirm)
clearDataBtn.addEventListener("click", async () => {
  if (clearConfirmTimer === null) {
    clearDataBtn.classList.add("confirming");
    clearDataBtn.textContent = "Click again to delete all data";
    clearConfirmTimer = setTimeout(resetClearButton, 4000);
    return;
  }
  clearTimeout(clearConfirmTimer);
  resetClearButton();
  try {
    await clearAllData();
  } finally {
    loadData();
  }
});

// ---------------------------------------------------------------------------
// Lifecycle & live updates
// ---------------------------------------------------------------------------

// ── Sync all classes ────────────────────────────────────────────────────────
// The popup can't message a tab without the "tabs" permission, so it writes a
// command to storage; the content script in the visible Teams tab runs it and
// reports progress back under SYNC_STATUS_KEY.

let syncWatchdog = null;

function setSyncing(on) {
  syncAllBtn.disabled = on;
  syncIcon.classList.toggle("spinning", on);
}

function renderSyncStatus(s) {
  // A "running" status that stopped updating means the tab was closed mid-sync.
  const abandoned = s && s.state === "running" && Date.now() - Date.parse(s.at) > 120000;
  if (!s || abandoned) { syncStatus.textContent = ""; setSyncing(false); return; }
  if (syncWatchdog) { clearTimeout(syncWatchdog); syncWatchdog = null; }
  if (s.state === "running") {
    syncStatus.textContent = s.phase === "assignments" ? "Capturing assignments…"
      : s.total ? `Syncing class ${s.done + s.failed + 1} of ${s.total}… keep the Teams tab open.` : "Syncing…";
  }
  else if (s.state === "done") {
    // A clean sync needs no standing message — the "Updated …" footer says it.
    const clean = !s.failed && s.assignments === "ok";
    const recent = Date.now() - Date.parse(s.at) < 60000;
    syncStatus.textContent = clean && !recent ? "" :
      `Synced ${s.done} of ${s.total} classes` + (s.failed ? ` (${s.failed} failed)` : "") +
      (s.assignments === "ok" ? " + assignments."
        : s.assignments === "partial" ? " + assignments (some tabs didn't load; their stored items were kept — see Capture details)."
        : s.assignments === "failed" ? " — assignments capture failed; nothing overwritten (see Capture details)."
        : s.assignments === "no-button" ? " — Assignments app button not found."
        : s.assignments ? " — no assignments capture reported (the Assignments app didn't load)." : ".");
  }
  else if (s.state === "error") syncStatus.textContent = SYNC_REASONS[s.reason] || "Sync failed.";
  setSyncing(s.state === "running");
}

syncAllBtn.addEventListener("click", async () => {
  syncStatus.textContent = "Starting… keep the Teams tab open.";
  await chrome.storage.local.set({ [SYNC_CMD_KEY]: { id: `${Date.now()}-${Math.random()}` } });
  // Nobody picked it up → no visible Teams tab with a live content script.
  if (syncWatchdog) clearTimeout(syncWatchdog);
  syncWatchdog = setTimeout(() => {
    syncWatchdog = null;
    syncStatus.textContent = "No Teams tab responded. Switch to your Teams tab (reload it once), then try again.";
  }, 5000);
});

chrome.storage.local.get([SYNC_STATUS_KEY], (res) => renderSyncStatus(res && res[SYNC_STATUS_KEY]));

// Auto-sync when Teams opens (read by teams-top.js; default on).
const AUTO_SYNC_KEY = "tp:settings:autoSync";
const autoSyncToggle = document.getElementById("autoSyncToggle");
chrome.storage.local.get([AUTO_SYNC_KEY], (res) => {
  autoSyncToggle.checked = !(res && res[AUTO_SYNC_KEY] === false);
});
autoSyncToggle.addEventListener("change", () => {
  chrome.storage.local.set({ [AUTO_SYNC_KEY]: autoSyncToggle.checked });
});

// ── Export assignments (.ics) — generated on-device, saved via a blob: link ──
document.getElementById("exportIcsBtn").addEventListener("click", () => {
  const { ics, exported, skippedUndated } = TP.buildIcs(rawDigestData, Date.now());
  if (exported === 0) {
    syncStatus.textContent = skippedUndated
      ? `No assignments with a due date to export (${skippedUndated} undated).`
      : "No assignments to export yet.";
    return;
  }
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `assignments-${new Date().toISOString().slice(0, 10)}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  syncStatus.textContent = `Exported ${exported} assignment${exported === 1 ? "" : "s"}` +
    (skippedUndated ? ` (${skippedUndated} undated skipped).` : ".") +
    " Open the file to add them to your calendar.";
});

// ── Capture details: the last assignments capture report ────────────────────
// Numbers and fixed reason codes only (sanitized by the background); shown
// with textContent and copied on request so the owner can share it. Only
// shown when the last capture had a problem — otherwise it is noise.
const captureDetails = document.getElementById("captureDetails");
const captureSummary = document.getElementById("captureSummary");
const captureReport  = document.getElementById("captureReport");
const copyReportBtn  = document.getElementById("copyReportBtn");
let lastCaptureReport = null;

function formatCaptureReport(r) {
  const yn = (b) => (b ? "y" : "n");
  const bg = r.background || {};
  const lines = [
    `TeamsPulse ${chrome.runtime.getManifest ? chrome.runtime.getManifest().version : ""} capture report`,
    `received ${r.receivedAt || "?"} · trigger ${r.trigger || "?"} · scope ${r.scope || "?"}`,
    `status ${r.status}${r.reason ? ` (${r.reason})` : ""} · ready ${r.readyWaitResult || "-"} · hidden ${yn(r.documentHidden)} · rendered ${yn(r.rendered)} · cards sent ${r.cardsSent || 0}`,
    `background: ${bg.accepted ? "accepted" : "rejected"}${bg.reason ? ` (${bg.reason})` : ""}` +
      (bg.okTabs ? ` · ok tabs ${bg.okTabs.join(", ") || "none"} · classes written ${bg.classesWritten} · dropped: not a visited class ${bg.droppedUnknownClass || 0}, no class ${bg.droppedClassless || 0} · ${bg.classValidation}` : ""),
  ];
  for (const t of r.tabs || []) {
    lines.push(`${t.tab}: ${t.status}${t.reason ? ` (${t.reason})` : ""} · found ${yn(t.tabFound)} clicked ${yn(t.clicked)} selected ${yn(t.selectedConfirmed)} changed ${yn(t.cardsChangedConfirmed)} loaded ${yn(t.listLoaded)} · raw ${t.cardsRaw} hidden ${t.droppedHidden} stale ${t.droppedStale} relative ${t.droppedByRelativeFilter} deduped ${t.dedupedOut} kept ${t.kept}`);
  }
  return lines.join("\n");
}

function renderCaptureReport(r) {
  lastCaptureReport = r || null;
  const bg = (r && r.background) || {};
  const warn = Boolean(r) && (r.status !== "ok" || !bg.accepted || bg.health === "no-known-classes");
  captureDetails.hidden = !warn;
  if (!r) return;
  captureSummary.textContent = `Capture details${warn ? " ⚠" : ""}`;
  captureReport.textContent = formatCaptureReport(r);
}

copyReportBtn.addEventListener("click", async () => {
  if (!lastCaptureReport) return;
  const text = `${formatCaptureReport(lastCaptureReport)}\n\n${JSON.stringify(lastCaptureReport, null, 2)}`;
  try {
    await navigator.clipboard.writeText(text);
    copyReportBtn.textContent = "Copied";
  } catch (_) {
    // Fallback: select the visible report so Ctrl+C works.
    const range = document.createRange();
    range.selectNodeContents(captureReport);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    copyReportBtn.textContent = "Selected — press Ctrl+C";
  }
  setTimeout(() => { copyReportBtn.textContent = "Copy report"; }, 2500);
});

chrome.storage.local.get([TP.KEY_CAPTURE_REPORT], (res) => renderCaptureReport(res && res[TP.KEY_CAPTURE_REPORT]));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[TP.KEY_CAPTURE_REPORT]) renderCaptureReport(changes[TP.KEY_CAPTURE_REPORT].newValue);
  if (changes[SYNC_STATUS_KEY]) renderSyncStatus(changes[SYNC_STATUS_KEY].newValue);
  if (Object.keys(changes).some((k) => k.startsWith(TP.KEY_PREFIX))) scheduleReload();
});

document.addEventListener("DOMContentLoaded", () => {
  loadData();

  // Relative times, countdowns and the 36 h stale check age with time.
  tickerInterval = setInterval(() => loadData(), 60000);
});

window.addEventListener("unload", () => {
  if (tickerInterval) clearInterval(tickerInterval);
  if (reloadTimer) clearTimeout(reloadTimer);
});
