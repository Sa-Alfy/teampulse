/**
 * popup.js — TeamsPulse Chrome/Edge Extension Logic
 *
 * Standalone: reads everything from chrome.storage.local via core/store.js and
 * shapes it with core/shape.js. Makes no network requests. Live-updates on
 * chrome.storage.onChanged instead of polling.
 *
 * Scraped text is untrusted — it is only ever written with textContent.
 */

"use strict";

const store = TP.createStore(TP.chromeBackend());
const TAB_CTX_PREFIX = TP.tabCtxKey("");

// DOM Elements
const refreshBtn       = document.getElementById("refreshBtn");
const filterToggleBtn  = document.getElementById("filterToggleBtn");
const clearDataBtn     = document.getElementById("clearDataBtn");
const staleBanner      = document.getElementById("staleBanner");
const scraperBanner    = document.getElementById("scraperBanner");
const controlsBar      = document.getElementById("controlsBar");
const classFilter      = document.getElementById("classFilter");
const timeFilter       = document.getElementById("timeFilter");
const searchInput      = document.getElementById("searchInput");
const clearSearchBtn   = document.getElementById("clearSearchBtn");

const liveBadge        = document.getElementById("liveBadge");
const liveText         = document.getElementById("liveText");
const lastScrapeText   = document.getElementById("lastScrapeText");
const syncTimer        = document.getElementById("syncTimer");
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
const classList        = document.getElementById("classList");

// Local App State
let activeTab          = "all"; // "all" | "notices" | "assignments"
let rawDigestData      = null;
let rawStatusData      = null;
let tickerInterval     = null;
let reloadTimer        = null;
let collapsedState     = {};

function getStoredCollapseState() {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["collapsedClasses"], (res) => {
        if (res && res.collapsedClasses && typeof res.collapsedClasses === "object") {
          resolve(res.collapsedClasses);
        } else {
          resolve({});
        }
      });
    } else {
      resolve({});
    }
  });
}

const collapseStatePromise = getStoredCollapseState().then((state) => {
  collapsedState = { ...state };
});

function saveCollapseState(classKey, isCollapsed) {
  collapsedState[classKey] = isCollapsed;
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      chrome.storage.local.set({ collapsedClasses: collapsedState }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          // Ignore storage errors in restricted contexts
        }
      });
    } catch (_) {
      // Storage unavailable
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function getTagClass(tag) {
  if (!tag) return "notice";
  return TAG_CLASSES[tag.trim()] || "notice";
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

async function loadData(silent = false) {
  if (!silent) {
    refreshBtn.querySelector(".refresh-icon").classList.add("spinning");
  }

  try {
    const [state] = await Promise.all([store.getState(), collapseStatePromise]);
    const nowMs = Date.now();
    rawStatusData = TP.buildStatus(state, nowMs);
    rawDigestData = TP.buildDigest(state, { nowMs });

    updateHeaderMeta();
    updateClassDropdown();
    applyFiltersAndRender();
  } catch (err) {
    rawStatusData = null;
    rawDigestData = null;
    footerStats.textContent = "Could not read stored data.";
    setView("no-data");
  } finally {
    refreshBtn.querySelector(".refresh-icon").classList.remove("spinning");
  }
}

function scheduleReload() {
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    loadData(true);
  }, 300);
}

function updateHeaderMeta() {
  if (!rawStatusData) return;
  const noData = Boolean(rawStatusData.noDataYet);

  if (rawStatusData.lastScrape) {
    lastScrapeText.textContent = `Last capture: ${formatRelativeTime(rawStatusData.lastScrape)}`;
  } else {
    lastScrapeText.textContent = "Nothing captured yet";
  }

  // A suspect scraper explains stale data better than "open Teams" does, so it
  // replaces the stale banner rather than stacking with it.
  const suspect = rawStatusData.scraper === "suspect";
  setHealthPill(rawStatusData.health);
  scraperBanner.classList.toggle("hidden", !suspect);
  staleBanner.classList.toggle("hidden", suspect || noData || rawStatusData.health !== "stale");

  const totalSeen = rawStatusData.totalSeen || 0;
  const newCount = rawDigestData ? (rawDigestData.newPostCount || 0) : 0;
  footerStats.textContent = `${totalSeen} posts indexed · ${newCount} new today`;
}

// Two-step confirm inside the popup (native confirm() dialogs are unreliable
// in extension popups).
let clearConfirmTimer = null;

async function clearAllData() {
  await store.clearAll();
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
// Filtering & Rendering
// ---------------------------------------------------------------------------

function updateClassDropdown() {
  if (!rawDigestData || !rawDigestData.classes) return;

  const currentSelection = classFilter.value;
  classFilter.replaceChildren(new Option("All Classes", "all"));

  for (const c of rawDigestData.classes) {
    const totalItems = (c.noticesCount || 0) + (c.assignmentsCount || 0);
    const opt = document.createElement("option");
    // Value is the raw class name: two sections of one course share a short
    // name, so selecting by short name would filter to both.
    opt.value = c.key || c.rawClassName || c.className;
    opt.textContent = `${c.displayName || c.className} (${totalItems})`;
    if (opt.value === currentSelection) opt.selected = true;
    classFilter.appendChild(opt);
  }
}

function matchesTimeFilter(timestampIso, timeOption) {
  if (timeOption === "all") return true;
  if (!timestampIso) return true;
  const postTime = new Date(timestampIso).getTime();
  if (isNaN(postTime)) return true;

  const hours = parseInt(timeOption, 10);
  const maxDiffMs = hours * 3600 * 1000;
  return Date.now() - postTime <= maxDiffMs;
}

/**
 * Time filter for assignments.
 *
 * The dropdown is backward-looking ("Last 24h"), but a task is relevant when
 * it is *near* now in either direction: something that went past due yesterday
 * and something due tomorrow are both what you came to check. So the window is
 * symmetric, ±N hours. An assignment with no parseable due date is always kept
 * — dropping a task because we couldn't read its date is the wrong failure.
 */
function assignmentMatchesTimeFilter(assignment, timeOption) {
  if (timeOption === "all") return true;
  const dateStr = assignment.dueIso || assignment.dueDate;
  if (!dateStr) return true;

  const due = new Date(dateStr).getTime();
  if (isNaN(due)) return true;

  const windowMs = parseInt(timeOption, 10) * 3600 * 1000;
  return Math.abs(due - Date.now()) <= windowMs;
}

function setSectionLabel(el, icon, text) {
  const iconSpan = document.createElement("span");
  iconSpan.textContent = icon;
  el.replaceChildren(iconSpan, document.createTextNode(` ${text}`));
}

function matchesSearch(text, query) {
  if (!query) return true;
  return (text || "").toLowerCase().includes(query);
}

function applyFiltersAndRender() {
  if (!rawDigestData || !rawDigestData.classes) {
    setView("no-data");
    return;
  }

  const selectedClass = classFilter.value;
  const selectedTime  = timeFilter.value;
  const searchQuery   = searchInput.value.trim().toLowerCase();

  let globalTotalNotices = 0;
  let globalTotalTasks   = 0;
  let visibleClassesCount = 0;

  classList.replaceChildren();

  for (const c of rawDigestData.classes) {
    // Check class filter (against the raw key — see updateClassDropdown)
    const classKey = c.key || c.rawClassName || c.className;
    const matchesClassFilter = (selectedClass === "all" || classKey === selectedClass);

    // Filter Notices for this class
    const matchingNotices = (c.notices || []).filter((notice) => {
      if (!matchesTimeFilter(notice.timestampIso, selectedTime)) return false;
      if (searchQuery) {
        const fullContent = `${notice.tag} ${notice.summary} ${notice.subject || ""} ${notice.author || ""} ${notice.date || ""}`.toLowerCase();
        return matchesSearch(fullContent, searchQuery);
      }
      return true;
    });

    // Filter Assignments for this class — the SAME filters as notices, so the
    // two halves of the view can't disagree about what's being shown.
    const matchingAssignments = (c.assignments || []).filter((assignment) => {
      if (!assignmentMatchesTimeFilter(assignment, selectedTime)) return false;
      if (searchQuery) {
        const fullContent = `${assignment.title} ${assignment.details} ${assignment.tab}`.toLowerCase();
        return matchesSearch(fullContent, searchQuery);
      }
      return true;
    });

    // Class filter applies BEFORE the tab counts are accumulated — otherwise
    // selecting one class leaves the All / Notices / Tasks badges showing
    // totals for every class.
    if (!matchesClassFilter) continue;

    globalTotalNotices += matchingNotices.length;
    globalTotalTasks   += matchingAssignments.length;

    // Check which sections to show based on activeTab
    const showNotices = (activeTab === "all" || activeTab === "notices") && matchingNotices.length > 0;
    const showTasks   = (activeTab === "all" || activeTab === "assignments") && matchingAssignments.length > 0;

    if (!showNotices && !showTasks) continue;

    visibleClassesCount++;

    const isCollapsed = Boolean(collapsedState[classKey]);

    // Render Class Card
    const card = document.createElement("div");
    card.className = isCollapsed ? "class-card collapsed" : "class-card";

    // Header
    const header = document.createElement("div");
    header.className = "class-header";

    const left = document.createElement("div");
    left.className = "class-header-left";

    const courseCode = document.createElement("span");
    courseCode.className = "course-code";
    // displayName carries the section suffix when two teams share a course
    // code, so "CSE 312 (V1)" and "CSE 312 (V2)" stay tellable apart.
    courseCode.textContent = c.displayName || c.className;
    courseCode.title = c.rawClassName || c.className;
    left.appendChild(courseCode);

    const badges = document.createElement("div");
    badges.className = "class-badges";

    if (matchingNotices.length > 0) {
      const nBadge = document.createElement("span");
      nBadge.className = "badge-count notices";
      nBadge.textContent = `📢 ${matchingNotices.length}`;
      badges.appendChild(nBadge);
    }

    if (matchingAssignments.length > 0) {
      const aBadge = document.createElement("span");
      aBadge.className = "badge-count tasks";
      aBadge.textContent = `📝 ${matchingAssignments.length}`;
      badges.appendChild(aBadge);
    }

    left.appendChild(badges);
    header.appendChild(left);

    const chevron = document.createElement("span");
    chevron.className = "collapse-icon";
    chevron.textContent = "▼";
    header.appendChild(chevron);

    // Toggle collapse — reachable by keyboard, and announced to screen readers.
    // A bare click handler on a div has neither.
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    header.setAttribute("aria-label", `Toggle ${c.displayName || c.className}`);

    const toggleCollapse = () => {
      const collapsed = card.classList.toggle("collapsed");
      header.setAttribute("aria-expanded", collapsed ? "false" : "true");
      saveCollapseState(classKey, collapsed);
    };

    header.addEventListener("click", toggleCollapse);
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleCollapse();
      }
    });

    card.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "class-body";

    // 1. Announcements section for this class
    if (showNotices) {
      const secLabel = document.createElement("div");
      secLabel.className = "section-label";
      setSectionLabel(secLabel, "📢", `Announcements & Notices (${matchingNotices.length})`);
      body.appendChild(secLabel);

      for (const notice of matchingNotices) {
        const item = document.createElement("div");
        item.className = "notice-card";

        // Meta row: Tag badge + date/time chips + new indicator
        const metaRow = document.createElement("div");
        metaRow.className = "notice-meta-row";

        const tag = document.createElement("span");
        tag.className = `tag-badge ${getTagClass(notice.tag)}`;
        tag.textContent = notice.tag || "📢 Notice";
        metaRow.appendChild(tag);

        if (notice.isNew) {
          const newPill = document.createElement("span");
          newPill.className = "new-pill";
          newPill.textContent = "NEW";
          metaRow.appendChild(newPill);
        }

        if (notice.date) {
          const dateChip = document.createElement("span");
          dateChip.className = "chip-meta";
          dateChip.textContent = `📅 ${notice.date}`;
          metaRow.appendChild(dateChip);
        }

        if (notice.time) {
          const timeChip = document.createElement("span");
          timeChip.className = "chip-meta";
          timeChip.textContent = `⏰ ${notice.time}`;
          metaRow.appendChild(timeChip);
        }

        item.appendChild(metaRow);

        // Content
        const content = document.createElement("div");
        content.className = "notice-text";
        content.textContent = notice.summary || notice.subject || "No text provided";
        item.appendChild(content);

        // Author & source
        const author = document.createElement("div");
        author.className = "notice-author";
        const authorParts = [];
        if (notice.author) authorParts.push(notice.author);
        if (notice.originalTimestamp) authorParts.push(notice.originalTimestamp);
        author.textContent = authorParts.join(" · ");
        item.appendChild(author);

        body.appendChild(item);
      }
    }

    // 2. Assignments section for this class
    if (showTasks) {
      const secLabel = document.createElement("div");
      secLabel.className = "section-label";
      setSectionLabel(secLabel, "📝", `Assignments (${matchingAssignments.length})`);
      body.appendChild(secLabel);

      for (const a of matchingAssignments) {
        const item = document.createElement("div");
        item.className = "assignment-card";

        const dateStr = a.dueIso || a.dueDate;
        if (dateStr) {
          const dueTime = new Date(dateStr).getTime();
          if (!isNaN(dueTime)) {
            const diffMs = dueTime - Date.now();
            if (diffMs >= 0 && diffMs <= 48 * 3600 * 1000) {
              item.classList.add("due-soon");
            }
          }
        }

        const headerRow = document.createElement("div");
        headerRow.className = "assignment-header-row";

        const title = document.createElement("span");
        title.className = "assignment-title";
        title.textContent = a.title || "Untitled Assignment";
        headerRow.appendChild(title);

        const statusBadge = document.createElement("span");
        const isPastDue = (a.tab === "Past due");
        statusBadge.className = `assignment-status-badge ${isPastDue ? "past-due" : "upcoming"}`;
        statusBadge.textContent = a.tab || "Pending";
        headerRow.appendChild(statusBadge);

        item.appendChild(headerRow);

        if (a.dueDate || a.details) {
          const dueText = document.createElement("div");
          dueText.className = "assignment-due-text";
          dueText.textContent = a.dueDate ? `📅 Due ${a.dueDate}${a.details ? ` · ${a.details}` : ""}` : a.details;
          item.appendChild(dueText);
        }

        body.appendChild(item);
      }
    }

    card.appendChild(body);
    classList.appendChild(card);
  }

  // Update counts on category tabs
  countAll.textContent         = globalTotalNotices + globalTotalTasks;
  countNotices.textContent     = globalTotalNotices;
  countAssignments.textContent = globalTotalTasks;

  // Empty state handling
  if (visibleClassesCount === 0) {
    if (searchQuery || selectedClass !== "all" || selectedTime !== "all") {
      setView("filter-empty");
    } else {
      setView("no-data");
    }
  } else {
    setView("feed");
  }
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

// Tab Switching
function handleTabClick(tabKey, activeBtn) {
  activeTab = tabKey;
  [tabAll, tabNotices, tabAssignments].forEach((b) => b.classList.remove("active"));
  activeBtn.classList.add("active");
  applyFiltersAndRender();
}

tabAll.addEventListener("click", () => handleTabClick("all", tabAll));
tabNotices.addEventListener("click", () => handleTabClick("notices", tabNotices));
tabAssignments.addEventListener("click", () => handleTabClick("assignments", tabAssignments));

// Filters
classFilter.addEventListener("change", applyFiltersAndRender);
timeFilter.addEventListener("change", applyFiltersAndRender);

// Search
searchInput.addEventListener("input", () => {
  if (searchInput.value.length > 0) {
    clearSearchBtn.classList.remove("hidden");
  } else {
    clearSearchBtn.classList.add("hidden");
  }
  applyFiltersAndRender();
});

clearSearchBtn.addEventListener("click", () => {
  searchInput.value = "";
  clearSearchBtn.classList.add("hidden");
  applyFiltersAndRender();
  searchInput.focus();
});

// Toggle Filter Bar
filterToggleBtn.addEventListener("click", () => {
  const isHidden = controlsBar.classList.toggle("hidden");
  controlsBar.hidden = isHidden;
  filterToggleBtn.setAttribute("aria-expanded", isHidden ? "false" : "true");
  filterToggleBtn.classList.toggle("active", !isHidden);
  if (!isHidden) {
    searchInput.focus();
  }
});

// Reload from storage
refreshBtn.addEventListener("click", () => {
  loadData(false);
});

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
    loadData(false);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle & live updates
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (Object.keys(changes).some((k) => k.startsWith(TP.KEY_PREFIX))) scheduleReload();
});

document.addEventListener("DOMContentLoaded", () => {
  loadData(false);

  // Relative "Last capture" text and the 36 h stale check age with time.
  tickerInterval = setInterval(() => loadData(true), 60000);
});

window.addEventListener("unload", () => {
  if (tickerInterval) clearInterval(tickerInterval);
  if (reloadTimer) clearTimeout(reloadTimer);
});