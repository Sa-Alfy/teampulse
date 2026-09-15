/**
 * popup.js — TeamsPulse Chrome/Edge Extension Logic
 *
 * Real-time academic dashboard with:
 * - Real-time auto-polling every 15 seconds
 * - Full categorization of announcements and assignments BY CLASS
 * - Category tabs (All, Announcements, Tasks)
 * - Class & time filters + instant keyword search
 * - Dark mode modern UI
 */

"use strict";

const API_BASE = "http://localhost:3457";

// DOM Elements
const refreshBtn       = document.getElementById("refreshBtn");
const retryBtn         = document.getElementById("retryBtn");
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
const offlineState     = document.getElementById("offlineState");
const noDataState      = document.getElementById("noDataState");
const filterEmptyState = document.getElementById("filterEmptyState");
const feedContainer    = document.getElementById("feedContainer");
const classList        = document.getElementById("classList");

// Local App State
let activeTab          = "all"; // "all" | "notices" | "assignments"
let rawDigestData      = null;
let rawStatusData      = null;
let lastSyncTimestamp  = null;
let pollingInterval    = null;
let tickerInterval     = null;

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

function getTagClass(tag) {
  if (!tag) return "notice";
  const t = tag.toLowerCase();
  if (t.includes("ct") || t.includes("quiz")) return "ct";
  if (t.includes("exam") || t.includes("final") || t.includes("midterm")) return "exam";
  if (t.includes("deadline") || t.includes("due")) return "deadline";
  if (t.includes("presentation")) return "presentation";
  if (t.includes("grade") || t.includes("mark")) return "grades";
  if (t.includes("reschedul") || t.includes("makeup")) return "reschedule";
  return "notice";
}

function setView(viewName) {
  loadingState.classList.add("hidden");
  offlineState.classList.add("hidden");
  noDataState.classList.add("hidden");
  filterEmptyState.classList.add("hidden");
  feedContainer.classList.add("hidden");

  switch (viewName) {
    case "loading":
      loadingState.classList.remove("hidden");
      break;
    case "offline":
      offlineState.classList.remove("hidden");
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

function setConnectionStatus(isOnline) {
  if (isOnline) {
    liveBadge.classList.remove("offline");
    liveText.textContent = "Live";
  } else {
    liveBadge.classList.add("offline");
    liveText.textContent = "Offline";
  }
}

// ---------------------------------------------------------------------------
// Data Fetching & Sync
// ---------------------------------------------------------------------------

async function fetchFromApi(endpoint) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function loadData(silent = false) {
  if (!silent) {
    refreshBtn.querySelector(".refresh-icon").classList.add("spinning");
  }

  try {
    const [status, digest] = await Promise.all([
      fetchFromApi("/api/status"),
      fetchFromApi("/api/digest"),
    ]);

    rawStatusData = status;
    rawDigestData = digest;
    lastSyncTimestamp = Date.now();
    setConnectionStatus(true);

    updateHeaderMeta();
    updateClassDropdown();
    applyFiltersAndRender();
  } catch (err) {
    setConnectionStatus(false);
    if (!rawDigestData) {
      setView("offline");
    }
  } finally {
    refreshBtn.querySelector(".refresh-icon").classList.remove("spinning");
  }
}

function updateHeaderMeta() {
  if (rawStatusData) {
    if (rawStatusData.lastScrape) {
      lastScrapeText.textContent = `Last scrape: ${formatRelativeTime(rawStatusData.lastScrape)}`;
    } else if (rawStatusData.lastRun) {
      lastScrapeText.textContent = `Last run: ${formatRelativeTime(rawStatusData.lastRun)}`;
    } else {
      lastScrapeText.textContent = "No runs yet";
    }

    const totalSeen = rawStatusData.totalSeen || 0;
    const newCount = rawDigestData ? (rawDigestData.newPostCount || 0) : 0;
    footerStats.textContent = `${totalSeen} posts indexed · ${newCount} new today · port 3457`;
  }
  updateSyncTimerText();
}

function updateSyncTimerText() {
  if (!lastSyncTimestamp) {
    syncTimer.textContent = "Syncing...";
    return;
  }
  const seconds = Math.floor((Date.now() - lastSyncTimestamp) / 1000);
  if (seconds < 5) {
    syncTimer.textContent = "Synced just now";
  } else if (seconds < 60) {
    syncTimer.textContent = `Synced ${seconds}s ago`;
  } else {
    const mins = Math.floor(seconds / 60);
    syncTimer.textContent = `Synced ${mins}m ago`;
  }
}

// ---------------------------------------------------------------------------
// Filtering & Rendering
// ---------------------------------------------------------------------------

function updateClassDropdown() {
  if (!rawDigestData || !rawDigestData.classes) return;

  const currentSelection = classFilter.value;
  classFilter.innerHTML = `<option value="all">All Classes</option>`;

  for (const c of rawDigestData.classes) {
    const totalItems = (c.noticesCount || 0) + (c.assignmentsCount || 0);
    const opt = document.createElement("option");
    opt.value = c.className;
    opt.textContent = `${c.className} (${totalItems})`;
    if (c.className === currentSelection) opt.selected = true;
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

  classList.innerHTML = "";

  for (const c of rawDigestData.classes) {
    // Check class filter
    const matchesClassFilter = (selectedClass === "all" || c.className === selectedClass);

    // Filter Notices for this class
    const matchingNotices = (c.notices || []).filter((notice) => {
      if (!matchesTimeFilter(notice.timestampIso, selectedTime)) return false;
      if (searchQuery) {
        const fullContent = `${notice.tag} ${notice.summary} ${notice.subject || ""} ${notice.author || ""} ${notice.date || ""}`.toLowerCase();
        return matchesSearch(fullContent, searchQuery);
      }
      return true;
    });

    // Filter Assignments for this class
    const matchingAssignments = (c.assignments || []).filter((assignment) => {
      if (searchQuery) {
        const fullContent = `${assignment.title} ${assignment.details} ${assignment.tab}`.toLowerCase();
        return matchesSearch(fullContent, searchQuery);
      }
      return true;
    });

    globalTotalNotices += matchingNotices.length;
    globalTotalTasks   += matchingAssignments.length;

    if (!matchesClassFilter) continue;

    // Check which sections to show based on activeTab
    const showNotices = (activeTab === "all" || activeTab === "notices") && matchingNotices.length > 0;
    const showTasks   = (activeTab === "all" || activeTab === "assignments") && matchingAssignments.length > 0;

    if (!showNotices && !showTasks) continue;

    visibleClassesCount++;

    // Render Class Card
    const card = document.createElement("div");
    card.className = "class-card";

    // Header
    const header = document.createElement("div");
    header.className = "class-header";

    const left = document.createElement("div");
    left.className = "class-header-left";

    const courseCode = document.createElement("span");
    courseCode.className = "course-code";
    courseCode.textContent = c.className;
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

    // Toggle collapse on click
    header.addEventListener("click", () => {
      card.classList.toggle("collapsed");
    });

    card.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "class-body";

    // 1. Announcements section for this class
    if (showNotices) {
      const secLabel = document.createElement("div");
      secLabel.className = "section-label";
      secLabel.innerHTML = `<span>📢</span> Announcements & Notices (${matchingNotices.length})`;
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
      secLabel.innerHTML = `<span>📝</span> Assignments (${matchingAssignments.length})`;
      body.appendChild(secLabel);

      for (const a of matchingAssignments) {
        const item = document.createElement("div");
        item.className = "assignment-card";

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

        if (a.details) {
          const dueText = document.createElement("div");
          dueText.className = "assignment-due-text";
          dueText.textContent = a.details;
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

// Refresh & Retry
refreshBtn.addEventListener("click", () => {
  loadData(false);
});

retryBtn.addEventListener("click", () => {
  setView("loading");
  loadData(false);
});

// ---------------------------------------------------------------------------
// Lifecycle & Auto-Sync
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  loadData(false);

  // Auto-sync polling every 15 seconds while popup is open
  pollingInterval = setInterval(() => {
    loadData(true);
  }, 15000);

  // Sync timer ticker every 5 seconds
  tickerInterval = setInterval(() => {
    updateSyncTimerText();
  }, 5000);
});

window.addEventListener("unload", () => {
  if (pollingInterval) clearInterval(pollingInterval);
  if (tickerInterval) clearInterval(tickerInterval);
});
