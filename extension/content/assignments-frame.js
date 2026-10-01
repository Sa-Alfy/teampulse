/**
 * extension/content/assignments-frame.js — Assignments iframe content script.
 *
 * Matches: https://assignments.edu.cloud.microsoft/*
 * all_frames: true
 *
 * Ports the tab-loop from teams.js scrapeClassAssignments() (~lines 40-165)
 * to plain DOM operations with a MutationObserver-based waitFor() helper.
 *
 * Sequence:
 *   1. waitFor() until the iframe's initial content resolves.
 *   2. Record which tab is currently aria-selected.
 *   3. For each of ["Upcoming", "Past due", "Completed"]:
 *        a. Click the tab (the ONLY click allowed per spec).
 *        b. waitFor() until that tab is aria-selected AND cards/empty text visible.
 *        c. Extract cards with the same fields as teams.js produces.
 *   4. Restore the originally selected tab.
 *   5. Send { type: "TP_ASSIGNMENTS", assignments, scrapedAt }.
 *   6. Throttle: at most once per 60 s.
 *
 * Field names match exactly what teams.js pushes and what store.ingestAssignments
 * / shape.transformAssignment expect:
 *   { tab, assignmentId, rawId, title, details, dueRaw, dueDate, status }
 *
 * NOTE: dueDate here is null (extractDate from digest-utils requires Node);
 * the background/shape layer performs the extraction from dueRaw + details.
 */

"use strict";

// ── Constants ─────────────────────────────────────────────────────────────

const TABS            = ["Upcoming", "Past due", "Completed"];
const COOLDOWN_MS     = 60_000;   // at most once per 60 s
const WAIT_TIMEOUT_MS = 10_000;
const SETTLE_MS       = 400;      // brief settle after tab becomes active

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wait until predicate() returns a truthy value, using MutationObserver +
 * polling fallback. Resolves with the truthy return value or null on timeout.
 *
 * @param {() => any} predicate
 * @param {number}    timeoutMs
 * @returns {Promise<any>}
 */
function waitFor(predicate, timeoutMs = WAIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    // Fast path: already satisfied.
    const initial = predicate();
    if (initial) return resolve(initial);

    let done = false;
    let obs  = null;
    let tid  = null;

    function finish(value) {
      if (done) return;
      done = true;
      if (obs)  obs.disconnect();
      if (tid !== null) clearTimeout(tid);
      resolve(value);
    }

    obs = new MutationObserver(() => {
      const val = predicate();
      if (val) finish(val);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });

    tid = setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Return the tab element for tabName, or null.
 * Mirrors clickTab() from teams.js: tries data-test first, then text.
 *
 * @param {string} tabName
 * @returns {Element|null}
 */
function findTabEl(tabName) {
  let el = document.querySelector(`[data-test="${tabName}"]`);
  if (el) return el;
  // Text fallback (exact match).
  for (const candidate of document.querySelectorAll("[role='tab'], button, [tabindex]")) {
    if ((candidate.innerText || "").trim() === tabName) return candidate;
  }
  return null;
}

/**
 * Return the tab that currently has aria-selected="true", or null.
 * @returns {string|null}
 */
function selectedTabName() {
  for (const t of TABS) {
    const el = document.querySelector(`[data-test="${t}"][aria-selected="true"]`);
    if (el) return t;
  }
  return null;
}

/**
 * True once the tab panel has settled: either assignment-card elements are
 * present, or the "No assignments" empty-state text is visible.
 * @returns {boolean}
 */
function panelSettled() {
  if (document.querySelector('[data-test="assignment-card"]')) return true;
  const body = document.body.innerText || "";
  return body.includes("No assignments");
}

/** Pull a GUID out of a card's id attribute. */
function extractGuid(rawId) {
  if (!rawId) return null;
  const m = String(rawId).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

/**
 * Extract cards currently visible in the active tab panel.
 * Only takes elements that are actually rendered (offsetParent !== null or
 * getComputedStyle check) — in the real Teams DOM the inactive tabs' cards are
 * unmounted; in test fixtures the inactive panels are hidden with display:none.
 *
 * @param {string} tabName
 * @returns {object[]}
 */
const EMPTY_TAB_WAIT_MS = 4_000;
const SCROLL_SETTLE_MS  = 400;
const MAX_SCROLL_STEPS  = 120;

/** Nearest scrollable ancestor of the assignment list (or the page). */
function scrollContainer() {
  const list = document.querySelector('[data-test="assignment-list"]') ||
               document.querySelector('[data-test="assignment-card"]');
  for (let el = list; el && el !== document.body; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 10) return el;
  }
  const page = document.scrollingElement;
  return page && page.scrollHeight > page.clientHeight + 10 ? page : null;
}

/**
 * The list is virtualized: only cards near the viewport exist in the DOM
 * (live: 13 of many past-due cards captured). Scroll through it, collecting
 * as we go, then put the scroll position back.
 */
async function collectAllCards(tabName) {
  const byKey = new Map();
  const grab = () => {
    for (const c of extractCards(tabName)) {
      const k = c.assignmentId || c.rawId || `${c.title}|${c.dueRaw}`;
      if (!byKey.has(k)) byKey.set(k, c);
    }
  };
  grab();
  const sc = scrollContainer();
  if (!sc) return [...byKey.values()];

  const start = sc.scrollTop;
  sc.scrollTop = 0;
  await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));
  grab();
  for (let i = 0; i < MAX_SCROLL_STEPS; i++) {
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
    if (atBottom) break;
    sc.scrollTop += Math.max(100, Math.floor(sc.clientHeight * 0.8));
    await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));
    grab();
  }
  sc.scrollTop = start;
  return [...byKey.values()];
}

function visibleCards() {
  return Array.from(document.querySelectorAll('[data-test="assignment-card"]'))
    .filter((el) => el.getClientRects().length > 0);
}

function visibleCardIds() {
  return new Set(visibleCards().map((el) => el.getAttribute("id") || el.textContent));
}

function sameIds(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function extractCards(tabName) {
  // Visible cards only. Never fall back to hidden ones: those belong to
  // another tab and would be recorded under the wrong tab name.
  const targetCards = visibleCards();
  const results = [];

  for (const card of targetCards) {
    const titleEl  = card.querySelector(".fui-CardHeader__header") ||
                     card.querySelector(ALL_UP_TITLE_SEL);
    const descEl   = card.querySelector(".fui-CardHeader__description");
    const actionEl = card.querySelector(".fui-CardHeader__action");

    const title  = titleEl  ? (titleEl.textContent  || "").trim() : "";
    const desc   = descEl   ? (descEl.textContent   || "").trim() : "";
    const action = actionEl ? (actionEl.textContent || "").trim() : "";
    const allUp  = allUpParts(card, title);
    const { date: groupDate, relative } = groupHeader(card);

    // The header's relative text says which side of today the date is on.
    // It also catches stale cards: a "… ago" card is never Upcoming, and a
    // "Due in …" card is never Past due (live: past-due cards read as Upcoming).
    if (tabName === "Upcoming" && /\bago\b/i.test(relative)) continue;
    if (tabName === "Past due" && /\bdue in\b/i.test(relative)) continue;

    const rawId    = card.getAttribute("id")      || null;
    const dataId   = card.getAttribute("data-id") || null;
    const assignmentId = extractGuid(rawId) || extractGuid(dataId) || null;

    // Prefer machine-readable due date; fall back to text attributes.
    const dueEl = card.querySelector("[datetime], time, [title*='Due'], [aria-label*='Due']");
    const dueRaw = dueEl
      ? (dueEl.getAttribute("datetime") ||
         dueEl.getAttribute("title")     ||
         dueEl.getAttribute("aria-label") || null)
      : null;

    // Grouped lists put the date in the group header ("Aug 31st") and only the
    // time on the card ("Due at 11:59 PM"); combine them. dueDate is ISO so
    // the shape layer uses it as-is and reads the time from dueRaw.
    const dueDate = !dueRaw && groupDate ? inferDueDate(groupDate, tabName, new Date(), relative) : null;
    const rawText = [groupDate, allUp.dueText].filter(Boolean).join(" ");

    const item = {
      tab:          tabName,
      assignmentId,
      rawId,
      title,
      // All-up cards: the description block is "Due at …" + class name run
      // together; keep just the due line (class is stored separately).
      details:      allUp.className ? allUp.dueText : desc,
      dueRaw:       dueRaw || rawText || null,
      dueDate,      // null → resolved by shape layer (extractDate)
      status:       action,
    };
    // All-classes view: each card names its own class.
    if (allUp.className && isAllClassesView()) item.className = allUp.className;
    results.push(item);
  }

  return results;
}

// ── Grouped / all-classes list (shape from tools/dom-probe-assignments.js) ─
//   [data-test="assignment-list"] > … > [role="group"]
//       [id^="groupHeader_"] > span "Aug 31st"  + "Due a month ago"
//       … [data-test="assignment-card"]
//            span[data-test="assignment-card-title-all-up-view"]  title
//            div[role="presentation"] "Due at 11:59 PM"
//            div[role="presentation"] "Summer_2026_CSE 312 (V1)_ 232_D4"

const ALL_UP_TITLE_SEL    = '[data-test="assignment-card-title-all-up-view"]';
/**
 * Checked at capture time, not at load: the app first loads at "/" and routes
 * to /classes/all/list afterwards (live: everything was filed under the tab's
 * last class). The all-up title element only exists in the all-classes view.
 */
function isAllClassesView() {
  return /^\/classes\/all\//.test(location.pathname) || !!document.querySelector(ALL_UP_TITLE_SEL);
}
const MONTHS_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function ownText(el) {
  return Array.from(el.childNodes).filter((n) => n.nodeType === 3)
    .map((n) => n.textContent).join(" ").replace(/[\s ]+/g, " ").trim();
}

/** "Due at …" text and the class-name line of an all-up card. */
function allUpParts(card, title) {
  let dueText = "";
  let className = "";
  for (const el of card.querySelectorAll('[role="presentation"]')) {
    const t = ownText(el);
    if (!t || t === title || /^\d+(\.\d+)?\s+points?$/i.test(t)) continue;
    if (/^due\b/i.test(t)) { if (!dueText) dueText = t; continue; }
    if (dueText && !className) className = t; // the line right after "Due at …"
  }
  return { dueText, className };
}

/**
 * The card's group header: date ("Aug 31st", "Dec 29, 2025") and the
 * relative part ("Due a month ago" / "Due in 3 days").
 */
function groupHeader(card) {
  const group  = card.closest('[role="group"]');
  const header = group && group.querySelector('[id^="groupHeader_"]');
  if (!header) return { date: "", relative: "" };
  const norm = (s) => (s || "").replace(/[\s ]+/g, " ").trim();
  const span = header.querySelector("span");
  const date = norm(span ? span.textContent : header.textContent);
  return { date, relative: norm(header.textContent).slice(date.length).trim() };
}

/**
 * "Aug 31st" (+ optional year) / Today / Tomorrow / Yesterday → "YYYY-MM-DD".
 * Without a year: Upcoming → next occurrence; Past due / Completed → most
 * recent past occurrence. Returns null if the text isn't a date.
 */
function inferDueDate(text, tabName, now, relative = "") {
  // "Due 7 months ago" → past; "Due in 3 days" → future; otherwise by tab.
  if (/\bago\b/i.test(relative)) tabName = "Past due";
  else if (/\bdue in\b/i.test(relative)) tabName = "Upcoming";
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rel = { today: 0, tomorrow: 1, yesterday: -1 }[text.trim().toLowerCase()];
  if (rel !== undefined) return fmt(new Date(today.getFullYear(), today.getMonth(), today.getDate() + rel));

  const m = text.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (!m) return null;
  const month = MONTHS_IDX[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  if (month === undefined) return null;

  let year = m[3] ? parseInt(m[3], 10) : today.getFullYear();
  let d = new Date(year, month, day);
  if (d.getMonth() !== month) return null; // e.g. Feb 30
  if (!m[3]) {
    const DAY = 864e5;
    if (tabName === "Upcoming" && d < today - DAY) d = new Date(++year, month, day);
    else if (tabName !== "Upcoming" && d > +today + DAY) d = new Date(--year, month, day);
  }
  return fmt(d);
}

// ── Throttle state ─────────────────────────────────────────────────────────

let _lastRunMs = 0;

// ── Main scrape routine ────────────────────────────────────────────────────

async function scrape() {
  const now = Date.now();
  if (now - _lastRunMs < COOLDOWN_MS) return;
  _lastRunMs = now;

  // Wait for the iframe to show at least one recognisable element.
  const ready = await waitFor(
    () => document.querySelector('[data-test="assignment-card"], [data-test="Upcoming"], [data-test="Past due"], [data-test="Completed"]') ||
          (document.body && (document.body.innerText || "").includes("No assignments in this class yet")),
    20_000
  );
  if (!ready) return;  // iframe never resolved — drop silently

  // Record which tab is originally selected so we can restore it.
  const originalTab = selectedTabName();

  const assignments = [];
  const seenIds = new Set();

  for (const tabName of TABS) {
    const tabEl = findTabEl(tabName);
    if (!tabEl) continue;

    // Teams keeps the previous tab's cards on screen for a moment after a tab
    // switch; reading then mislabels them (live: 23 past-due cards were also
    // recorded as "Upcoming"). Remember what was shown before switching.
    const wasSelected = selectedTabName() === tabName;
    const before = visibleCardIds();

    // Click the tab (the ONLY click performed by this script).
    tabEl.click();

    // 1. Wait for the tab to report aria-selected="true".
    await waitFor(
      () => {
        const el = document.querySelector(`[data-test="${tabName}"][aria-selected="true"]`);
        return !!el;
      },
      8_000
    );

    // 2. Wait for the panel to settle (cards or empty text) AND, after a real
    //    switch, for the visible cards to differ from the previous tab's.
    //    An assignment is only ever in one tab, so an unchanged non-empty set
    //    means stale content: skip the tab rather than mislabel it.
    await waitFor(panelSettled, WAIT_TIMEOUT_MS);
    if (!wasSelected) {
      // Empty → empty is a genuinely empty tab, so that wait is kept short.
      const changed = await waitFor(() => !sameIds(visibleCardIds(), before),
        before.size > 0 ? WAIT_TIMEOUT_MS : EMPTY_TAB_WAIT_MS);
      if (!changed && before.size > 0) {
        console.warn(`[TeamsPulse] "${tabName}" still showed the previous tab's cards; skipped`);
        continue;
      }
    }

    // Brief extra settle to let React flush.
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // 3. Extract cards (an assignment is recorded once, under its first tab).
    for (const c of await collectAllCards(tabName)) {
      const id = c.assignmentId || c.rawId;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      assignments.push(c);
    }
  }

  // Restore the originally selected tab.
  if (originalTab && originalTab !== selectedTabName()) {
    const restoreEl = findTabEl(originalTab);
    if (restoreEl) restoreEl.click();
  }

  // Send regardless of whether assignments is empty (the background validates).
  sendAssignments({
    type: "TP_ASSIGNMENTS",
    assignments,
    scope: isAllClassesView() ? "all-classes" : "class",
    scrapedAt: new Date().toISOString(),
  }, 2);
}

/**
 * Send with a short retry: the background rejects assignments until the top
 * frame's TP_CLASS_CONTEXT has landed, which can race this iframe's load.
 * Stops silently if the extension was reloaded under this page.
 */
function sendAssignments(msg, retriesLeft) {
  try {
    if (!(chrome.runtime && chrome.runtime.id)) return;
    chrome.runtime.sendMessage(msg, (res) => {
      let err = null;
      try { err = chrome.runtime.lastError; } catch (_) { /* context gone */ }
      if (!err && res && res.ok) return;
      console.warn(`[TeamsPulse] TP_ASSIGNMENTS not stored: ${err ? err.message : (res && res.reason) || "no response"}`);
      if (retriesLeft > 0) setTimeout(() => sendAssignments(msg, retriesLeft - 1), 3000);
    });
  } catch (_) { /* extension context invalidated */ }
}

// ── Entry point ───────────────────────────────────────────────────────────

// Run once on load (after DOM is interactive).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => scrape());
} else {
  scrape();
}
