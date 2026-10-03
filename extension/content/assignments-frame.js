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
const TAB_SELECT_MS   = 8_000;
const CHANGE_WAIT_MS  = 15_000;   // previous tab's list replaced
const SETTLE_MS       = 400;      // brief settle after tab becomes active
// Empty-state text, matched against a whole text node so a card title can't
// trigger it. Seen live: "No assignments" (class view) and, in the all-classes
// view, "No upcoming assignments right now." (owner's screenshot 2026-10-03;
// before 0.7.2 that one went unrecognised and Upcoming waited 20 s).
const EMPTY_RE        = /^\s*no\s+(?:[a-z'-]+\s+){0,3}assignments\b/i;
const MAX_SEND        = 300;      // = messages.js MAX_ASSIGNMENTS

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

/** Pull a GUID out of a card's id attribute. */
function extractGuid(rawId) {
  if (!rawId) return null;
  const m = String(rawId).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

// The old "panel settled" / "list loaded" checks matched "No assignments"
// anywhere in the body, including the previous tab's empty state still on
// screen, so the next tab was read before its list arrived (zero cards).
// listChanged()/listLoadedSince() below compare against the pre-switch list.
const LIST_LOAD_TIMEOUT_MS = 20_000;
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
async function collectAllCards(tabName, tr) {
  const byKey = new Map();
  const seen = { raw: new Set(), hidden: new Set(), relative: new Set() };
  const grab = () => {
    for (const c of extractCards(tabName, seen)) {
      const k = c.assignmentId || c.rawId || `${c.title}|${c.dueRaw}`;
      if (!byKey.has(k)) byKey.set(k, c);
    }
    if (tr) {
      tr.cardsRaw = seen.raw.size;
      tr.droppedHidden = [...seen.hidden].filter((k) => !seen.relative.has(k)).length;
      tr.droppedByRelativeFilter = seen.relative.size;
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

function sameIds(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Text of an element with its child blocks kept apart ("Due at 11:59 PM · CSE 204"). */
function splitText(el) {
  const parts = [];
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent || "").replace(/[\s\u00a0]+/g, " ").trim();
    if (t) parts.push(t);
  }
  return parts.join(" · ");
}

function extractCards(tabName, seen) {
  // Visible cards only. Never fall back to hidden ones: those belong to
  // another tab and would be recorded under the wrong tab name. (Only called
  // when the document is rendered, so "hidden" really means hidden.)
  const keyOf = (el) => el.getAttribute("id") || el.textContent;
  const targetCards = [];
  for (const el of document.querySelectorAll('[data-test="assignment-card"]')) {
    const shown = el.getClientRects().length > 0;
    if (shown) targetCards.push(el);
    if (seen) { seen.raw.add(keyOf(el)); if (!shown) seen.hidden.add(keyOf(el)); }
  }
  const results = [];

  for (const card of targetCards) {
    const titleEl  = card.querySelector(".fui-CardHeader__header") ||
                     card.querySelector(ALL_UP_TITLE_SEL);
    const descEl   = card.querySelector(".fui-CardHeader__description");
    const actionEl = card.querySelector(".fui-CardHeader__action");

    const title  = titleEl  ? (titleEl.textContent  || "").trim() : "";
    const desc   = descEl   ? splitText(descEl) : "";
    const action = actionEl ? (actionEl.textContent || "").trim() : "";
    const allUp  = allUpParts(card, title);
    const { date: groupDate, relative } = groupHeader(card);

    // The header's relative text says which side of today the date is on.
    // It also catches stale cards: a "… ago" card is never Upcoming, and a
    // "Due in …" card is never Past due (live: past-due cards read as Upcoming).
    if ((tabName === "Upcoming" && /\bago\b/i.test(relative)) ||
        (tabName === "Past due" && /\bdue in\b/i.test(relative))) {
      if (seen) seen.relative.add(keyOf(card));
      continue;
    }

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
    // A card that names its own class is filed there, not under the class
    // whose tab is open (live: every card was filed under CSE 304). The
    // background validates it against known classes.
    if (allUp.className) item.className = allUp.className;
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

/**
 * The status/time line ("Due at 11:59 PM"; Completed cards: "Submitted at
 * 1:52 AM", seen live 2026-10-03) and the class-name line right after it.
 */
const TIME_LINE_RE = /^(due|submitted|turned in|returned|graded|completed)\b/i;
function allUpParts(card, title) {
  let dueText = "";
  let className = "";
  for (const el of card.querySelectorAll('[role="presentation"]')) {
    const t = ownText(el);
    if (!t || t === title || /^\d+(\.\d+)?\s+points?$/i.test(t)) continue;
    if (TIME_LINE_RE.test(t)) { if (!dueText) dueText = t; continue; }
    if (dueText && !className) className = t; // the line right after the time line
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
 * Without a year, pick the year that puts the date closest to today, on the
 * side of today the header's relative text says ("Due … ago" past, "Due in …"
 * future), else the side the tab implies (Past due past, Upcoming future,
 * Completed either). Returns null if the text isn't a date.
 */
function inferDueDate(text, tabName, now, relative = "") {
  let side = 0; // -1 past, +1 future, 0 either
  if (/\bago\b/i.test(relative)) side = -1;
  else if (/\bdue in\b/i.test(relative)) side = 1;
  else if (tabName === "Past due") side = -1;
  else if (tabName === "Upcoming") side = 1;
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

  if (m[3]) {
    const d = new Date(parseInt(m[3], 10), month, day);
    return d.getMonth() === month ? fmt(d) : null; // e.g. Feb 30
  }
  const DAY = 864e5;
  let best = null;
  for (const y of [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]) {
    const d = new Date(y, month, day);
    if (d.getMonth() !== month) continue;
    if (side < 0 && d > +today + DAY) continue;
    if (side > 0 && d < today - DAY) continue;
    if (!best || Math.abs(d - today) < Math.abs(best - today)) best = d;
  }
  return best ? fmt(best) : null;
}

// ── Capture report ─────────────────────────────────────────────────────────
// Every run (including every early return) produces a report that travels
// with TP_ASSIGNMENTS and is stored as tp:v1:capture-report. Numbers, flags
// and fixed reason codes only: never titles or class names.

function newTabReport(tab) {
  return {
    tab, tabFound: false, clicked: false, selectedConfirmed: false,
    cardsChangedConfirmed: false, listLoaded: false, cardsRaw: 0,
    previousListForeign: false, droppedHidden: 0, droppedStale: 0, droppedByRelativeFilter: 0,
    dedupedOut: 0, kept: 0, status: "skipped", reason: "",
  };
}

function newReport(trigger) {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    trigger,
    scope: null,
    readyWaitResult: null,
    documentHidden: !!document.hidden,
    rendered: documentRendered(),
    status: null,
    reason: "",
    tabs: [],
  };
}

/**
 * True when this document is laid out and on screen. A display:none iframe
 * (Teams keeps app frames alive while another app is shown) has no layout:
 * every card then has zero client rects and would be dropped as hidden.
 */
function documentRendered() {
  if (document.hidden) return false;
  if (!(window.innerWidth > 0 && window.innerHeight > 0)) return false;
  return document.documentElement.getClientRects().length > 0;
}

// ── List state (for detecting a real tab switch) ───────────────────────────

/** Visible "No assignments" empty-state element, if any. */
function emptyStateEl() {
  const root = document.querySelector('[data-test="assignment-list"]') || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (EMPTY_RE.test(n.textContent || "")) {
      const el = n.parentElement;
      if (el && el.getClientRects().length > 0) return el;
    }
  }
  return null;
}

/** What the list currently shows: visible card ids + nodes, and the empty state. */
function listState() {
  const cards = visibleCards();
  return {
    ids: new Set(cards.map((el) => el.getAttribute("id") || el.textContent)),
    nodes: cards,
    empty: emptyStateEl(),
  };
}

/**
 * The list on screen is no longer the one captured in `before`: card ids
 * differ, or the previous nodes / empty-state element were replaced.
 */
function listChanged(before) {
  const now = listState();
  if (!sameIds(now.ids, before.ids)) return true;
  if (before.nodes.some((el) => !el.isConnected)) return true;
  if (before.empty && !before.empty.isConnected) return true;
  if (!before.empty && now.empty) return true;
  return false;
}

/** Cards visible, or a visible empty state that was not on screen in `before`. */
function listLoadedSince(before) {
  if (visibleCards().length > 0) return true;
  const e = emptyStateEl();
  return !!e && (!before || e !== before.empty);
}

// ── Main scrape routine ────────────────────────────────────────────────────

let _lastRunMs  = 0;
let _running    = false;
let _deferTimer = null;

/**
 * Entry for every trigger (load, in-frame navigation, frame shown).
 * In-flight guard; 60 s cooldown between real runs (a trigger inside the
 * cooldown runs when it ends); a hidden document is reported and skipped.
 */
function requestScrape(trigger) {
  if (_running) return;
  // A card jump goes first; the capture follows it.
  if (_navBusy || (navWaiting() && documentRendered())) { setTimeout(() => requestScrape(trigger), 3000); return; }
  const wait = COOLDOWN_MS - (Date.now() - _lastRunMs);
  if (_lastRunMs && wait > 0) {
    if (!_deferTimer) _deferTimer = setTimeout(() => { _deferTimer = null; requestScrape(`${trigger}+cooldown`); }, wait);
    return;
  }
  scrape(trigger).catch(() => { _running = false; });
}

async function scrape(trigger = "load") {
  _running = true;
  const report = newReport(trigger);
  try {
    if (!report.rendered) {
      report.status = "deferred";
      report.reason = document.hidden ? "document-hidden" : "frame-not-rendered";
      sendReportOnly(report);
      return;
    }
    _lastRunMs = Date.now();

    // Wait for the iframe to show at least one recognisable element.
    const ready = await waitFor(
      () => document.querySelector('[data-test="assignment-card"], [data-test="Upcoming"], [data-test="Past due"], [data-test="Completed"]') ||
            (document.body && (document.body.innerText || "").includes("No assignments in this class yet")),
      20_000
    );
    report.readyWaitResult = ready ? "ready" : "timeout";
    report.scope = isAllClassesView() ? "all-classes" : "class";
    if (!ready) {
      report.status = "failed";
      report.reason = "ready-timeout";
      sendReportOnly(report);
      return;
    }

    const originalTab = selectedTabName();
    // Read the tab already on screen first: no switch, so no stale list.
    const order = originalTab ? [originalTab, ...TABS.filter((t) => t !== originalTab)] : TABS.slice();
    const assignments = [];
    const capturedTab = new Map(); // id → tab it was captured under
    let prevForeign = false;       // the list on screen was judged not the previous tab's

    const captureTab = async (tabName, tr) => {
      const tabEl = findTabEl(tabName);
      if (!tabEl) { tr.reason = "tab-not-found"; return; }
      tr.tabFound = true;

      const wasSelected = selectedTabName() === tabName;
      const before = listState();
      // The list on screen did not belong to the previous tab, so it may be
      // this tab's: Teams need not re-render it when this tab is clicked.
      const trustScreen = prevForeign;
      prevForeign = false;
      tr.previousListForeign = trustScreen;
      if (!wasSelected) { tabEl.click(); tr.clicked = true; }

      tr.selectedConfirmed = !!(await waitFor(
        () => document.querySelector(`[data-test="${tabName}"][aria-selected="true"]`), TAB_SELECT_MS));
      if (!tr.selectedConfirmed) { tr.status = "timeout"; tr.reason = "tab-not-selected"; return; }

      // After a real switch Teams keeps the previous list on screen for a
      // while (live: past-due cards recorded as Upcoming). Wait until it is
      // replaced; a list that never changes is stale, not this tab's.
      if (wasSelected || trustScreen || (before.ids.size === 0 && !before.empty)) {
        tr.cardsChangedConfirmed = true;
      } else {
        tr.cardsChangedConfirmed = !!(await waitFor(() => listChanged(before), CHANGE_WAIT_MS));
      }
      if (!tr.cardsChangedConfirmed) {
        // Two empty tabs in a row also look unchanged: not proof, so not "ok".
        tr.reason = before.ids.size ? "previous-tab-cards-still-shown" : "empty-state-unchanged";
        return;
      }

      // The list is fetched after a switch: wait for cards or a fresh empty state.
      tr.listLoaded = !!(await waitFor(() => listLoadedSince(wasSelected || trustScreen ? null : before), LIST_LOAD_TIMEOUT_MS));
      if (!tr.listLoaded) { tr.status = "timeout"; tr.reason = "list-not-loaded"; return; }
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      // An assignment is in exactly one tab: a card that was on screen before
      // the switch belongs to the previous tab.
      const staleIds = wasSelected || trustScreen ? new Set() : before.ids;
      const cards = await collectAllCards(tabName, tr);
      // Teams can move off a tab by itself right after selecting it (live
      // 2026-10-03: clicking an empty Upcoming switched to Completed, whose
      // cards were then read as Upcoming). Keep the read only if the tab is
      // still selected afterwards.
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      if (selectedTabName() !== tabName) {
        tr.reason = "tab-switched-away";
        tr.cardsRaw = 0;
        return;
      }
      for (const c of cards) {
        const id = c.assignmentId || c.rawId;
        if (c.rawId && staleIds.has(c.rawId)) { tr.droppedStale++; continue; }
        if (id && capturedTab.has(id)) { tr.dedupedOut++; continue; }
        if (id) capturedTab.set(id, tabName);
        assignments.push(c);
        tr.kept++;
      }
      // Every card read here carried another tab's relative text ("Due … ago"
      // under Upcoming): the list on screen is not this tab's. Live
      // (2026-10-03): the app opened on Upcoming showing the Past due list,
      // then switched to Past due by itself.
      const foreign = tr.droppedByRelativeFilter + tr.droppedStale + tr.dedupedOut;
      if (tr.kept === 0 && tr.droppedByRelativeFilter > 0 && foreign >= tr.cardsRaw - tr.droppedHidden) {
        tr.reason = "list-belongs-to-other-tab";
        prevForeign = true;
        return;
      }
      tr.status = "ok";
    };

    for (const tabName of order) {
      const tr = newTabReport(tabName);
      report.tabs.push(tr);
      await captureTab(tabName, tr);
    }
    // Retry a tab that showed another tab's list, once, by clicking it from
    // the tab now selected.
    for (const tr of report.tabs.filter((t) => t.reason === "list-belongs-to-other-tab" || t.reason === "tab-switched-away")) {
      if (selectedTabName() === tr.tab) continue;
      Object.assign(tr, newTabReport(tr.tab), { retried: true });
      await captureTab(tr.tab, tr);
    }

    // Restore the originally selected tab.
    if (originalTab && originalTab !== selectedTabName()) {
      const restoreEl = findTabEl(originalTab);
      if (restoreEl) restoreEl.click();
    }

    // The background accepts at most MAX_SEND items. Completed items are never
    // shown, so drop them first (and keep the stored Completed list).
    if (assignments.length > MAX_SEND) {
      const tc = report.tabs.find((t) => t.tab === "Completed");
      if (tc && tc.status === "ok") { tc.status = "skipped"; tc.reason = "over-cap"; }
      for (let i = assignments.length - 1; i >= 0 && assignments.length > MAX_SEND; i--) {
        if (assignments[i].tab === "Completed") assignments.splice(i, 1);
      }
    }

    const okTabs = report.tabs.filter((t) => t.status === "ok").map((t) => t.tab);
    report.status = okTabs.length === TABS.length ? "ok" : okTabs.length ? "partial" : "failed";
    if (!okTabs.length) report.reason = report.tabs.every((t) => !t.tabFound) ? "no-tabs-found" : "no-tab-confirmed";
    send({
      type: "TP_ASSIGNMENTS",
      assignments,
      okTabs,
      scope: report.scope,
      scrapedAt: new Date().toISOString(),
      report,
    }, 2);
  } finally {
    _running = false;
    setTimeout(() => maybeNav(), 300); // a card jump waiting on this capture
  }
}

/** A run that captured nothing still reports why (the background stores no items). */
function sendReportOnly(report) {
  send({
    type: "TP_ASSIGNMENTS",
    assignments: [],
    okTabs: [],
    scope: report.scope || (isAllClassesView() ? "all-classes" : "class"),
    scrapedAt: new Date().toISOString(),
    report,
  }, 0);
}

/**
 * Send with a short retry: the background rejects class-scope assignments
 * until the top frame's TP_CLASS_CONTEXT has landed, which can race this
 * iframe's load. Stops silently if the extension was reloaded under this page.
 */
function send(msg, retriesLeft) {
  try {
    if (!(chrome.runtime && chrome.runtime.id)) return;
    chrome.runtime.sendMessage(msg, (res) => {
      let err = null;
      try { err = chrome.runtime.lastError; } catch (_) { /* context gone */ }
      if (!err && res && res.ok) return;
      const reason = err ? err.message : (res && res.reason) || "no response";
      console.warn(`[TeamsPulse] TP_ASSIGNMENTS not stored: ${reason}`);
      if (retriesLeft > 0 && /class context/i.test(reason)) setTimeout(() => send(msg, retriesLeft - 1), 3000);
    });
  } catch (_) { /* extension context invalidated */ }
}

// ── Open in Teams: find one assignment (popup card click) ─────────────────
// The popup stores the command under tp:nav:cmd; the top frame checks it
// (not while syncing), forwards task commands here as tp:nav:task { id, at,
// tab, title, assignmentId, classShort } and opens this app. The jump runs
// BEFORE any capture the newly shown frame would start (captures wait while a
// jump is pending), so it isn't stuck behind a minute-long capture. Select the
// item's tab, scroll the list until its card shows, then scroll to it and
// outline it. The card is NOT clicked: opening it would navigate the frame and
// trigger a capture of a page without a list.

const NAV_TASK_KEY   = "tp:nav:task";
const NAV_MAX_AGE_MS = 120_000;
let _navHandled = null;
let _navCmd     = null;
let _navBusy    = false;

function cardMatches(card, cmd) {
  const guid = extractGuid(card.getAttribute("id")) || extractGuid(card.getAttribute("data-id"));
  if (cmd.assignmentId && guid) return guid === cmd.assignmentId;
  const titleEl = card.querySelector(".fui-CardHeader__header") || card.querySelector(ALL_UP_TITLE_SEL);
  const title = titleEl ? (titleEl.textContent || "").replace(/\s+/g, " ").trim() : "";
  if (!title || title !== cmd.title) return false;
  // All-classes view: several classes can share a title ("Lab Report-01").
  return !cmd.classShort || !isAllClassesView() || (card.textContent || "").includes(cmd.classShort);
}

function findCard(cmd) {
  return visibleCards().find((c) => cardMatches(c, cmd)) || null;
}

async function navToCard(cmd) {
  if (cmd.tab && TABS.includes(cmd.tab) && selectedTabName() !== cmd.tab) {
    const tabEl = findTabEl(cmd.tab);
    if (tabEl) {
      tabEl.click();
      await waitFor(() => selectedTabName() === cmd.tab, TAB_SELECT_MS);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    }
  }
  let card = await waitFor(() => findCard(cmd), 4000);
  const sc = card ? null : scrollContainer();
  if (sc) { // virtualized list: walk it until the card is rendered
    sc.scrollTop = 0;
    for (let i = 0; i < MAX_SCROLL_STEPS && !card; i++) {
      await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));
      card = findCard(cmd);
      if (card || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) break;
      sc.scrollTop += Math.max(100, Math.floor(sc.clientHeight * 0.8));
    }
  }
  if (!card) return false;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  const prev = card.style.outline;
  card.style.outline = "3px solid #818cf8";
  setTimeout(() => { card.style.outline = prev; }, 3500);
  return true;
}

function navWaiting() {
  const c = _navCmd;
  return !!c && c.id !== _navHandled && Date.now() - (Number(c.at) || 0) <= NAV_MAX_AGE_MS;
}

function maybeNav(cmd) {
  if (cmd) _navCmd = cmd;
  const c = _navCmd;
  if (!navWaiting()) return;
  if (_running || !documentRendered()) return; // retried after the capture / when shown
  _navHandled = c.id;
  _navCmd = null;
  _navBusy = true;
  navToCard(c).catch(() => {}).finally(() => { _navBusy = false; });
}

// ── Entry point ───────────────────────────────────────────────────────────
// Runs on load, and again when the app navigates inside the frame (SPA
// route/hash change), when the Teams tab becomes visible, or when a hidden
// frame is shown (Teams keeps app frames alive instead of reloading them).

if (typeof module === "undefined") {
  let lastHref = location.href;
  let wasRendered = documentRendered();
  const recheck = (why) => {
    const rendered = documentRendered();
    if (location.href !== lastHref) { lastHref = location.href; if (rendered) requestScrape("navigation"); }
    else if (rendered && !wasRendered) requestScrape(why);
    wasRendered = rendered;
  };
  setInterval(() => { maybeNav(); recheck("frame-shown"); }, 2000);
  try {
    chrome.storage.local.get([NAV_TASK_KEY], (res) => maybeNav(res && res[NAV_TASK_KEY]));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[NAV_TASK_KEY] && changes[NAV_TASK_KEY].newValue) maybeNav(changes[NAV_TASK_KEY].newValue);
    });
  } catch (_) { /* storage unavailable (tests / context gone) */ }
  window.addEventListener("resize", () => recheck("frame-shown"));
  window.addEventListener("popstate", () => recheck("navigation"));
  window.addEventListener("hashchange", () => recheck("navigation"));
  document.addEventListener("visibilitychange", () => recheck("tab-visible"));

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => requestScrape("load"));
  } else {
    requestScrape("load");
  }
} else if (module.exports) {
  // Node (unit tests): pure helpers only.
  module.exports = { inferDueDate, allUpParts, splitText, TABS };
}
