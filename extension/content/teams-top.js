/**
 * extension/content/teams-top.js — Top-frame content script for Teams.
 *
 * Runs in the top frame of https://teams.microsoft.com and
 * https://teams.cloud.microsoft (the latter seen live via tools/dom-probe.js).
 *
 * Responsibilities:
 *   1. Detect the current class name from the open-channel DOM.
 *   2. Extract posts from [data-tid="channel-pane-message"] with the same
 *      field names as scrape-posts.js extractPosts().
 *   3. Observe DOM mutations with a debounced (1500 ms) MutationObserver.
 *   4. Send TP_CLASS_CONTEXT on load and when the class changes (SPA navigation).
 *   5. Send TP_POSTS only when the post list is non-empty and changed since last send.
 *
 * No auto-scrolling (read-only).
 *
 * ── NOT VERIFIED ──────────────────────────────────────────────────────────
 * getCurrentClassName() reads the team name from document.title, anchored on
 * the channel heading (one live probe sample, 2026-10-01). Not yet confirmed:
 * that the title segment is byte-identical to the [data-testid="team-name"]
 * text the Playwright scraper stores (self-host and extension keys must
 * match), and that the layout holds for other views/locales. If the signals
 * disagree, it returns null and nothing is sent.
 * ──────────────────────────────────────────────────────────────────────────
 */

(() => {
  "use strict";

  // ── Constants ────────────────────────────────────────────────────────────

  const MESSAGE_SELECTOR   = '[data-tid="channel-pane-message"]';
  const SUBHEADER_SELECTOR = '[data-tid="post-message-subheader"]';
  const TIMESTAMP_SELECTOR = '[data-tid="timestamp"]';
  const CHANNEL_TITLE_SELECTOR = '[data-tid="channelTitle-text"]';
  const DEBOUNCE_MS        = 1500;

  // ── Helpers ──────────────────────────────────────────────────────────────

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normWs   = (s) => s.replace(/[\s\u00a0]+/g, " ").trim();

  /**
   * Read the class (team) name of the open channel.
   *
   * Confirmed by tools/dom-probe.js on https://teams.cloud.microsoft (2026-10-01):
   *   document.title = "Teams and Channels | <team name> | <channel> | Microsoft Teams"
   *   h2[data-tid="channelTitle-text"] = "<channel>"
   * The team name is the title segment immediately before the segment equal to
   * the channel heading. Requiring both signals to agree means an unexpected
   * title layout yields null (nothing sent) rather than a wrong class.
   *
   * @returns {string|null}
   */
  function getCurrentClassName() {
    const heading = document.querySelector(CHANNEL_TITLE_SELECTOR);
    const channel = heading ? normWs(heading.textContent || "") : "";
    if (!channel) return null;

    const segments = (document.title || "").split(" | ").map((s) => s.trim());
    const idx = segments.findIndex((s, i) => i > 0 && normWs(s) === channel);
    if (idx < 1) return null;

    const team = segments[idx - 1];
    return team ? team : null;
  }

  /**
   * Port of scrape-posts.js extractPosts() — identical output field names.
   *
   * @param {string} className
   * @returns {object[]}
   */
  function extractPosts(className) {
    const messages = Array.from(document.querySelectorAll(MESSAGE_SELECTOR));
    const normalizedClass = className ? normWs(className) : "";

    return messages.map((msg) => {
      // ── Subheader & Timestamp ──────────────────────────────────────────
      const subheader    = msg.querySelector(SUBHEADER_SELECTOR);
      const timestampEl  = msg.querySelector(TIMESTAMP_SELECTOR);

      const timestampText = timestampEl ? (timestampEl.innerText || "").trim() : "";
      const timestampFull = timestampEl
        ? (timestampEl.getAttribute("title") || timestampEl.getAttribute("aria-label") || "")
        : "";

      let timestampIso = null;
      if (timestampFull) {
        const parsed = Date.parse(timestampFull);
        if (!isNaN(parsed)) timestampIso = new Date(parsed).toISOString();
      }

      // ── Author detection ───────────────────────────────────────────────
      const appTrigger = msg.querySelector('[data-tid="app-profile-card-trigger"]');
      let author = "";
      if (appTrigger) {
        author = (appTrigger.innerText || "").trim() || "System";
      } else if (subheader) {
        let raw = (subheader.innerText || "").trim();
        if (timestampText) raw = raw.replace(timestampText, "");
        author = raw.replace(/\bEdited\b/gi, "").trim();
      }

      const isBot = !!appTrigger ||
        /^assignments$/i.test(author) ||
        author.toLowerCase().includes("bot");

      // ── Subject line ───────────────────────────────────────────────────
      const subjectEl = msg.querySelector('[data-tid="subject-line"]');
      const subject   = subjectEl ? (subjectEl.innerText || "").trim() : "";

      // ── Announcement badge ─────────────────────────────────────────────
      const isAnnouncement = !!msg.querySelector('[data-tid="team-badge"]');

      // ── Attachments & URL previews ─────────────────────────────────────
      const attachments = [];
      const fileEls = msg.querySelectorAll(
        '[data-tid="file-attachment-grid"] [role="gridcell"], ' +
        '[data-tid="file-attachment-grid"] a, ' +
        '[data-tid="file-name"]'
      );
      fileEls.forEach((f) => {
        const txt = (f.innerText || "").trim();
        if (txt && !attachments.includes(txt)) attachments.push(txt);
      });

      const urlPreviews = [];
      const urlEls = msg.querySelectorAll('[data-tid="url-preview"]');
      urlEls.forEach((u) => {
        const txt = ((u.innerText || "").trim()).replace(/\s+/g, " ");
        if (txt && !urlPreviews.includes(txt)) urlPreviews.push(txt);
      });

      // ── Body ──────────────────────────────────────────────────────────
      const bodyEl = msg.querySelector('[data-tid="message-body"]');
      let body = bodyEl ? (bodyEl.innerText || "").trim() : "";

      // Clean channel-name leak (normalise whitespace first — Teams uses NBSP).
      if (normalizedClass) {
        body = normWs(body)
          .replace(new RegExp(escapeRe(normalizedClass) + "\\s*$"), "")
          .trim();
      }

      // Clean bot button label.
      if (isBot) {
        body = body.replace(/View assignment\s*$/i, "").trim();
      }

      // If body is empty but files are attached, mention them.
      if (!body && attachments.length > 0) {
        body = `[Attached: ${attachments.join(", ")}]`;
      }

      // ── Replies ────────────────────────────────────────────────────────
      const responseSurfaces = Array.from(msg.querySelectorAll('[data-tid="response-surface"]'));
      const replies = responseSurfaces.map((r) => {
        const rHeader  = r.querySelector('[data-tid="reply-message-header"]');
        const rTime    = r.querySelector(TIMESTAMP_SELECTOR);
        const rBody    = r.querySelector('[data-tid="message-body"]');
        const rTimeStr = rTime ? (rTime.innerText || "").trim() : "";
        let rAuthor = "";
        if (rHeader) {
          rAuthor = (rHeader.innerText || "").trim()
            .replace(rTimeStr, "")
            .replace(/\bEdited\b/gi, "")
            .trim();
        }
        return {
          author:    rAuthor,
          timestamp: rTimeStr,
          body:      rBody ? (rBody.innerText || "").trim() : "",
        };
      });

      return {
        author,
        isBot,
        isAnnouncement,
        subject,
        timestamp:     timestampText,
        timestampFull,
        timestampIso,
        body,
        attachments,
        urlPreviews,
        replyCount:    replies.length,
        replies,
      };
    });
  }

  /** Stable signature for memoization / change detection. */
  function postsSignature(posts) {
    return JSON.stringify(posts.map((p) => ({
      author:        p.author,
      timestampFull: p.timestampFull,
      body:          (p.body || "").slice(0, 200),
      replyCount:    p.replyCount,
    })));
  }

  // ── State ──────────────────────────────────────────────────────────────────

  let _lastClassName  = null;   // last className sent via TP_CLASS_CONTEXT
  let _lastPostSig    = null;   // fingerprint of last TP_POSTS payload
  let _debounceTimer  = null;
  let _healthTimer    = null;
  let _dead           = false;  // extension reloaded/updated under this page

  // ── Messaging ─────────────────────────────────────────────────────────────

  /**
   * After the extension is reloaded or updated, Chrome does not re-inject into
   * already-open tabs and this (old) script can no longer reach the extension:
   * chrome.runtime.id becomes undefined and sendMessage throws. Stop cleanly;
   * the user must reload the Teams tab (the popup says so).
   */
  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function shutdown() {
    _dead = true;
    try { observer.disconnect(); } catch (_) { /* not created yet */ }
    if (_healthTimer !== null) clearInterval(_healthTimer);
    if (_debounceTimer !== null) clearTimeout(_debounceTimer);
  }

  /** Send to the background; onFail(reason) runs if it errors or is rejected. */
  function send(msg, onFail) {
    if (_dead) return;
    if (!contextAlive()) { shutdown(); return; }
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        let err = null;
        try { err = chrome.runtime.lastError; } catch (_) { /* context gone */ }
        if (err || !res || !res.ok) {
          const reason = err ? err.message : (res && res.reason) || "no response";
          console.warn(`[TeamsPulse] ${msg.type} not stored: ${reason}`);
          if (onFail) onFail();
        }
      });
    } catch (_) {
      shutdown();
    }
  }

  // ── Core send logic ────────────────────────────────────────────────────────

  function sendClassContext(className) {
    _lastClassName = className;
    send({ type: "TP_CLASS_CONTEXT", className }, () => { _lastClassName = null; });
  }

  function tryFlushPosts() {
    const className = getCurrentClassName();

    // Class changed → re-send context first.
    if (className !== null && className !== _lastClassName) {
      sendClassContext(className);
    }

    // Without a confirmed class name, don't send posts.
    if (className === null) return;

    const posts = extractPosts(className);
    if (posts.length === 0) return;  // empty list → no message

    const sig = postsSignature(posts);
    if (sig === _lastPostSig) return;  // unchanged → no message

    _lastPostSig = sig;
    send({
      type:       "TP_POSTS",
      className,
      posts,
      scrapedAt:  new Date().toISOString(),
    }, () => { _lastPostSig = null; }); // not stored → retry on next change
  }

  function scheduleSend() {
    if (_dead) return;
    if (_debounceTimer !== null) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      tryFlushPosts();
    }, DEBOUNCE_MS);
  }

  // ── MutationObserver ───────────────────────────────────────────────────────

  const observer = new MutationObserver(() => scheduleSend());

  observer.observe(document.body, {
    childList:     true,
    subtree:       true,
    attributes:    false,
    characterData: false,
  });

  // SPA navigation changes <title> (in <head>), which the body observer misses.
  if (document.head) {
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  }

  // ── Scraper health ───────────────────────────────────────────────────────
  // Teams DOM changes must not fail silently. Report (once per onset) when,
  // for a sustained period:
  //   no-class    — a channel view is on screen but the class can't be resolved
  //   no-messages — the class resolved, but the channel shows zero messages
  // The popup then shows "Scraper may be out of date". Never sends post data.

  const NO_CLASS_GRACE_MS    = 10_000;
  const NO_MESSAGES_GRACE_MS = 60_000;
  const HEALTH_TICK_MS       = 5_000;

  let _problem = null; // { key, since, reported }

  function checkHealth() {
    const channelView = !!document.querySelector(CHANNEL_TITLE_SELECTOR);
    const msgCount    = document.querySelectorAll(MESSAGE_SELECTOR).length;
    const className   = getCurrentClassName();

    let kind = null;
    let grace = 0;
    if (!className && (channelView || msgCount > 0)) {
      kind = "no-class";
      grace = NO_CLASS_GRACE_MS;
    } else if (className && channelView && msgCount === 0) {
      kind = "no-messages";
      grace = NO_MESSAGES_GRACE_MS;
    }

    if (!kind) {
      _problem = null;
      return;
    }

    const key = `${kind}|${className || ""}`;
    const now = Date.now();
    if (!_problem || _problem.key !== key) _problem = { key, since: now, reported: false };
    if (_problem.reported || now - _problem.since < grace) return;

    _problem.reported = true;
    send(
      kind === "no-class" ? { type: "TP_HEALTH", status: kind }
                          : { type: "TP_HEALTH", status: kind, className }
    );
  }

  _healthTimer = setInterval(checkHealth, HEALTH_TICK_MS);

  // ── Sync all classes (user-triggered from the popup) ─────────────────────
  // Selectors confirmed by tools/dom-probe-teams-list.js on teams.cloud.microsoft
  // (2026-10-01), except ALL_TEAMS_TEXT (seen on screen, same text the
  // Playwright scraper clicks) — the Teams app-bar button is the fallback.
  // Clicks only Teams' own navigation; reads the same rendered posts as above.

  const GRID_SELECTOR       = '[data-tid="teams-grid-view"]';
  const CLASS_PANEL_SEL     = '[data-tid="ClassTeamsSection-panel"]';
  const TEAM_NAME_BTN_SEL   = 'button[data-testid="team-name"]';
  const TEAMS_APP_BTN_SEL   = 'button[data-tid="2a84919f-59d8-4441-a975-2a8c2643b741"]';
  const ALL_TEAMS_TEXT      = /^all teams$/i;
  const SYNC_CMD_KEY        = "tp:sync:cmd";
  const SYNC_STATUS_KEY     = "tp:sync:status";
  const NAV_TIMEOUT_MS      = 20_000;
  const SETTLE_MS           = 2_500;

  // Left-bar app buttons live in nav[aria-label="Apps"] with aria-labels like
  // "Teams (Ctrl+Shift+1)" (probe). The Assignments button is matched the same
  // way — NOT yet seen in a probe; English UI only.
  const APPS_NAV_SEL         = '[role="navigation"][aria-label="Apps"]';
  const ASSIGNMENTS_LABEL    = /^assignments\b/i;
  const ASSIGNMENTS_WAIT_MS  = 120_000; // 3 tabs × up to 20 s load + scrolling
  const ASSIGNMENT_KEY_PFX   = "tp:v1:assignments:";
  const CAPTURE_REPORT_KEY   = "tp:v1:capture-report";

  let _syncing = false;
  let _assignmentWaiters = [];

  function assignmentsAppButton() {
    const nav = document.querySelector(APPS_NAV_SEL);
    return Array.from((nav || document).querySelectorAll("button"))
      .find((b) => ASSIGNMENTS_LABEL.test(b.getAttribute("aria-label") || "")) || null;
  }

  /** @returns {Promise<"ok"|"partial"|"failed"|"no-button"|"timeout">} */
  async function syncAssignmentsApp() {
    const btn = assignmentsAppButton();
    if (!btn) return "no-button";
    const stored = new Promise((resolve) => {
      _assignmentWaiters.push(resolve);
      setTimeout(() => resolve("timeout"), ASSIGNMENTS_WAIT_MS);
    });
    btn.click();
    return stored;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(pred, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (_dead) return false;
      if (pred()) return true;
      await sleep(250);
    }
    return false;
  }

  function classButtons() {
    const panel = document.querySelector(CLASS_PANEL_SEL);
    return panel ? Array.from(panel.querySelectorAll(TEAM_NAME_BTN_SEL)) : [];
  }

  async function goToGrid() {
    if (document.querySelector(GRID_SELECTOR)) return true;
    const back = Array.from(document.querySelectorAll("button, a, [role='button'], [role='link']"))
      .find((el) => ALL_TEAMS_TEXT.test(normWs(el.textContent || "")));
    if (back) {
      back.click();
      if (await waitFor(() => document.querySelector(GRID_SELECTOR), 8000)) return true;
    }
    const nav = document.querySelector('[role="navigation"][aria-label="Apps"]');
    const appBtn = document.querySelector(TEAMS_APP_BTN_SEL) ||
      (nav && Array.from(nav.querySelectorAll("button")).find((b) => /^teams\b/i.test(b.getAttribute("aria-label") || "")));
    if (appBtn) appBtn.click();
    return waitFor(() => document.querySelector(GRID_SELECTOR), NAV_TIMEOUT_MS);
  }

  function writeSyncStatus(status) {
    try {
      chrome.storage.local.set({ [SYNC_STATUS_KEY]: { ...status, at: new Date().toISOString() } });
    } catch (_) { /* context gone */ }
  }

  async function syncAllClasses() {
    if (_syncing || _dead) return;
    _syncing = true;
    const startClass = getCurrentClassName();
    let done = 0, failed = 0, total = 0;
    let assignments = "skipped";
    writeSyncStatus({ state: "running", done, failed, total });
    try {
      if (!(await goToGrid())) {
        writeSyncStatus({ state: "error", reason: "classes-page-not-found" });
        return;
      }
      const names = classButtons().map((b) => normWs(b.textContent || "")).filter(Boolean);
      total = names.length;
      if (total === 0) {
        writeSyncStatus({ state: "error", reason: "no-classes-found" });
        return;
      }

      for (const name of names) {
        writeSyncStatus({ state: "running", done, failed, total });
        if (!(await goToGrid())) { failed++; continue; }
        const btn = classButtons().find((b) => normWs(b.textContent || "") === name);
        if (!btn) { failed++; continue; }
        btn.click();
        const opened = await waitFor(
          () => getCurrentClassName() === name && document.querySelectorAll(MESSAGE_SELECTOR).length > 0,
          NAV_TIMEOUT_MS
        );
        if (!opened) { failed++; continue; }
        await sleep(SETTLE_MS); // let the rest of the visible posts render
        tryFlushPosts();
        done++;
      }

      // Assignments for every class live in the left-bar Assignments app
      // (all-classes list). Open it so its frame script captures them, wait
      // until they are stored, then come back.
      writeSyncStatus({ state: "running", phase: "assignments", done, failed, total });
      assignments = await syncAssignmentsApp();

      // Return the user to where they started: their class, or the grid.
      if (await goToGrid()) {
        const btn = startClass && classButtons().find((b) => normWs(b.textContent || "") === startClass);
        if (btn) btn.click();
      }
      writeSyncStatus({ state: "done", done, failed, total, assignments });
    } catch (_) {
      writeSyncStatus({ state: "error", reason: "unexpected", done, failed, total });
    } finally {
      _syncing = false;
    }
  }

  // ── Auto-sync when Teams opens (owner's choice, 2026-10-01) ────────────────
  // Runs Sync all classes once, 20 s after Teams loads, at most every 6 h,
  // only in the visible tab and never while another sync is running.
  // Popup checkbox stores tp:settings:autoSync (default on).

  const AUTO_SYNC_KEY      = "tp:settings:autoSync";
  const LAST_AUTO_SYNC_KEY = "tp:sync:lastAuto";
  const AUTO_SYNC_DELAY_MS = 20_000;
  const AUTO_SYNC_EVERY_MS = 6 * 3600e3;

  let _autoTried = false;

  async function maybeAutoSync() {
    if (_autoTried || _dead || _syncing || document.visibilityState !== "visible") return;
    _autoTried = true;
    try {
      const s = await chrome.storage.local.get([AUTO_SYNC_KEY, LAST_AUTO_SYNC_KEY, SYNC_STATUS_KEY]);
      if (s[AUTO_SYNC_KEY] === false) return;
      if (Date.now() - (Date.parse(s[LAST_AUTO_SYNC_KEY] || "") || 0) < AUTO_SYNC_EVERY_MS) return;
      const st = s[SYNC_STATUS_KEY];
      if (st && st.state === "running" && Date.now() - Date.parse(st.at) < 120_000) return; // another tab
      await chrome.storage.local.set({ [LAST_AUTO_SYNC_KEY]: new Date().toISOString() });
      syncAllClasses();
    } catch (_) { /* extension context gone */ }
  }

  setTimeout(() => {
    if (document.visibilityState === "visible") maybeAutoSync();
    else document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") setTimeout(maybeAutoSync, AUTO_SYNC_DELAY_MS);
    }, { once: true });
  }, AUTO_SYNC_DELAY_MS);

  // ── Open in Teams (user clicked a card in the popup) ───────────────────────
  // The popup stores { id, kind, className, at, … } under NAV_CMD_KEY, then
  // brings this tab to the front. Only a visible tab acts; a command that
  // arrives while hidden (or before a fresh tab has loaded) runs once the tab
  // is shown, if still recent. Posts are found with extractPosts() — the same
  // reading the capture uses — so no extra selectors are involved.
  //   kind "post": open the class like Sync does, find the post by its
  //                timestamp + subject/body start, scroll to it, outline it.
  //   kind "task": forward it as NAV_TASK_KEY (so the frame never acts on a
  //                command this tab rejected, e.g. mid-sync), then open the
  //                Assignments app; its frame script finds the card.

  const NAV_CMD_KEY     = "tp:nav:cmd";
  const NAV_TASK_KEY    = "tp:nav:task";
  const NAV_MAX_AGE_MS  = 120_000;
  const NAV_LOAD_OLDER  = 8;       // scroll-to-top rounds to load older posts
  const NAV_OLDER_WAIT  = 1_200;

  let _navHandled = null;  // id of the last command acted on
  let _navPending = null;
  let _navBusy    = false;

  function navFresh(cmd) {
    return cmd && cmd.id && cmd.id !== _navHandled && Date.now() - (Number(cmd.at) || 0) < NAV_MAX_AGE_MS;
  }

  /** Small, self-removing notice on the Teams page (text only). */
  function navToast(text) {
    try {
      const el = document.createElement("div");
      el.textContent = `TeamsPulse: ${text}`;
      el.setAttribute("role", "status");
      Object.assign(el.style, {
        position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)",
        zIndex: "2147483647", background: "#1f2330", color: "#eef1f6", padding: "8px 14px",
        borderRadius: "8px", font: "13px/1.4 Segoe UI, sans-serif", boxShadow: "0 4px 16px rgba(0,0,0,.35)",
        maxWidth: "420px", textAlign: "center",
      });
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 5000);
    } catch (_) { /* page not ready */ }
  }

  function flash(el) {
    const prev = { outline: el.style.outline, outlineOffset: el.style.outlineOffset };
    el.style.outline = "3px solid #818cf8";
    el.style.outlineOffset = "2px";
    setTimeout(() => { el.style.outline = prev.outline; el.style.outlineOffset = prev.outlineOffset; }, 3500);
  }

  /** Index of the message matching the command, or -1. */
  function findPostIndex(cmd, className) {
    const posts = extractPosts(className);
    const subject = normWs(cmd.subject || "").toLowerCase();
    const bodyStart = normWs(cmd.bodyStart || "").toLowerCase();
    const textOk = (p) =>
      (subject && normWs(p.subject || "").toLowerCase() === subject) ||
      (bodyStart && normWs(p.body || "").toLowerCase().startsWith(bodyStart));
    // Timestamp + text first; text alone if Teams re-rendered the timestamp.
    let idx = cmd.timestampIso ? posts.findIndex((p) => p.timestampIso === cmd.timestampIso && textOk(p)) : -1;
    if (idx < 0) idx = posts.findIndex(textOk);
    return idx;
  }

  async function openClass(className) {
    if (getCurrentClassName() === className) return true;
    if (!(await goToGrid())) return false;
    const btn = classButtons().find((b) => normWs(b.textContent || "") === className);
    if (!btn) return false;
    btn.click();
    return waitFor(
      () => getCurrentClassName() === className && document.querySelectorAll(MESSAGE_SELECTOR).length > 0,
      NAV_TIMEOUT_MS
    );
  }

  async function navigateToPost(cmd) {
    if (!(await openClass(cmd.className))) {
      navToast("couldn't open that class. Open it from your Teams list.");
      return;
    }
    await sleep(800);
    let idx = findPostIndex(cmd, cmd.className);
    // Older posts load when the list is scrolled to its top.
    for (let round = 0; idx < 0 && round < NAV_LOAD_OLDER && !_dead; round++) {
      const first = document.querySelector(MESSAGE_SELECTOR);
      if (!first) break;
      first.scrollIntoView({ block: "start" });
      await sleep(NAV_OLDER_WAIT);
      idx = findPostIndex(cmd, cmd.className);
    }
    const msg = idx >= 0 ? document.querySelectorAll(MESSAGE_SELECTOR)[idx] : null;
    if (!msg) {
      navToast("opened the class, but couldn't find that post. It may be further up.");
      return;
    }
    msg.scrollIntoView({ block: "center", behavior: "smooth" });
    flash(msg);
  }

  async function navigateToTask(cmd) {
    const btn = assignmentsAppButton();
    if (!btn) {
      navToast("couldn't find the Assignments app button in Teams.");
      return;
    }
    await chrome.storage.local.set({ [NAV_TASK_KEY]: {
      id: cmd.id, at: Date.now(), tab: cmd.tab, title: cmd.title,
      assignmentId: cmd.assignmentId || null, classShort: cmd.classShort || "",
    } });
    btn.click(); // the frame script picks the command up and finds the card
  }

  async function runNav(cmd) {
    if (!navFresh(cmd) || _dead) return;
    if (document.visibilityState !== "visible") { _navPending = cmd; return; }
    if (_syncing || _navBusy) { navToast("busy syncing, try again in a moment."); return; }
    _navHandled = cmd.id;
    _navPending = null;
    _navBusy = true;
    try {
      if (cmd.kind === "post" && cmd.className) await navigateToPost(cmd);
      else if (cmd.kind === "task") await navigateToTask(cmd);
    } catch (_) {
      navToast("couldn't open that item.");
    } finally {
      _navBusy = false;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && _navPending) runNav(_navPending);
  });

  // A tab opened by the popup (no Teams tab was known) finds its command here.
  try {
    chrome.storage.local.get([NAV_CMD_KEY], (res) => {
      const cmd = res && res[NAV_CMD_KEY];
      if (navFresh(cmd)) setTimeout(() => runNav(cmd), 3000);
    });
  } catch (_) { /* storage unavailable in this context */ }

  // ── Storage listener: Clear-data resend + sync command ─────────────────────
  // The store never deletes tp:v1:* keys except on clearAll, so a removal means
  // the user wiped data: forget what was sent so the open channel is re-captured.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (_dead || area !== "local") return;
      // Only the tab the user is looking at runs a sync (several Teams tabs
      // may be open; each gets this event).
      const cmd = changes[SYNC_CMD_KEY];
      if (cmd && cmd.newValue && document.visibilityState === "visible") {
        syncAllClasses();
      }
      const nav = changes[NAV_CMD_KEY];
      if (nav && nav.newValue) runNav(nav.newValue);
      // The assignments frame stored a non-empty capture → release a waiting
      // sync. (An empty write is not proof of a capture — live: "+ assignments"
      // with 0 tasks.)
      // A capture report with a final status (ok / partial / failed) also
      // ends the wait, so a failed capture says why instead of timing out.
      const rep = changes[CAPTURE_REPORT_KEY] && changes[CAPTURE_REPORT_KEY].newValue;
      const outcome = rep && ["ok", "partial", "failed"].includes(rep.status) ? rep.status
        : Object.keys(changes).some((k) => k.startsWith(ASSIGNMENT_KEY_PFX) &&
            Array.isArray(changes[k].newValue) && changes[k].newValue.length > 0) ? "ok" : null;
      if (_assignmentWaiters.length && outcome) {
        const waiters = _assignmentWaiters;
        _assignmentWaiters = [];
        waiters.forEach((r) => r(outcome));
      }
      const wiped = Object.entries(changes).some(
        ([k, c]) => k.startsWith("tp:v1:") && c.newValue === undefined
      );
      if (!wiped) return;
      _lastPostSig   = null;
      _lastClassName = null;
      _problem       = null;
      scheduleSend();
    });
  } catch (_) { /* storage unavailable in this context */ }

  // Initial check on load
  tryFlushPosts();
  checkHealth();
})();

