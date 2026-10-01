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

  // ── Core send logic ────────────────────────────────────────────────────────

  function sendClassContext(className) {
    chrome.runtime.sendMessage({ type: "TP_CLASS_CONTEXT", className });
    _lastClassName = className;
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
    chrome.runtime.sendMessage({
      type:       "TP_POSTS",
      className,
      posts,
      scrapedAt:  new Date().toISOString(),
    });
  }

  function scheduleSend() {
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

  // Initial check on load
  tryFlushPosts();
})();

