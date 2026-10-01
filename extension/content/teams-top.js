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

  let _syncing = false;

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
    const appBtn = document.querySelector(TEAMS_APP_BTN_SEL);
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

      // Return the user to where they started: their class, or the grid.
      if (await goToGrid()) {
        const btn = startClass && classButtons().find((b) => normWs(b.textContent || "") === startClass);
        if (btn) btn.click();
      }
      writeSyncStatus({ state: "done", done, failed, total });
    } catch (_) {
      writeSyncStatus({ state: "error", reason: "unexpected", done, failed, total });
    } finally {
      _syncing = false;
    }
  }

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

