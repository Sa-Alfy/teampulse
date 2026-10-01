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
function extractCards(tabName) {
  const cards   = Array.from(document.querySelectorAll('[data-test="assignment-card"]'));
  // In the real Teams app, inactive tabs' cards are unmounted.
  // In test fixtures, inactive panels are styled display:none.
  const visible = cards.filter((el) => el.getClientRects().length > 0);
  const targetCards = visible.length > 0 ? visible : cards;
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
    const groupDate = groupHeaderDate(card);

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
    const dueDate = !dueRaw && groupDate ? inferDueDate(groupDate, tabName, new Date()) : null;
    const rawText = [groupDate, allUp.dueText].filter(Boolean).join(" ");

    const item = {
      tab:          tabName,
      assignmentId,
      rawId,
      title,
      details:      desc,
      dueRaw:       dueRaw || rawText || null,
      dueDate,      // null → resolved by shape layer (extractDate)
      status:       action,
    };
    // All-classes view: each card names its own class.
    if (IS_ALL_CLASSES_VIEW && allUp.className) item.className = allUp.className;
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
const IS_ALL_CLASSES_VIEW = /^\/classes\/all\//.test(location.pathname);
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
    if (!t || t === title) continue;
    if (/^due\b/i.test(t)) { if (!dueText) dueText = t; }
    else className = t; // the last non-"Due" line is the class name
  }
  return { dueText, className };
}

/** Date text of the card's group header, e.g. "Aug 31st". */
function groupHeaderDate(card) {
  const group  = card.closest('[role="group"]');
  const header = group && group.querySelector('[id^="groupHeader_"]');
  if (!header) return "";
  const span = header.querySelector("span");
  return ((span ? span.textContent : header.textContent) || "").replace(/[\s ]+/g, " ").trim();
}

/**
 * "Aug 31st" (+ optional year) / Today / Tomorrow / Yesterday → "YYYY-MM-DD".
 * Without a year: Upcoming → next occurrence; Past due / Completed → most
 * recent past occurrence. Returns null if the text isn't a date.
 */
function inferDueDate(text, tabName, now) {
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

  for (const tabName of TABS) {
    const tabEl = findTabEl(tabName);
    if (!tabEl) continue;

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

    // 2. Wait for the panel to settle (cards or empty text).
    await waitFor(panelSettled, WAIT_TIMEOUT_MS);

    // Brief extra settle to let React flush.
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // 3. Extract cards.
    const cards = extractCards(tabName);
    for (const c of cards) assignments.push(c);
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
    scope: IS_ALL_CLASSES_VIEW ? "all-classes" : "class",
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
