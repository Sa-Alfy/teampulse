/**
 * scrape-posts.js — General-channel post scraping.
 *
 * Usable as a library (teams.js imports scrapeClassPosts) or standalone:
 *   node scrape-posts.js [--headed] [--class "CSE 312"] [--hours 48] [--scrollback N]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { filterRecentPosts } = require("./digest-utils");
const {
  launchTeams,
  openTeamsList,
  openTeamByIndex,
  goBackToTeamsList,
  selectClasses,
  fatal,
} = require("./teams-session");

const NOTICES_FILE = "notices.json";
const DEBUG_DIR = "debug";
const MESSAGE_SELECTOR = '[data-tid="channel-pane-message"]';

// How many upward scroll passes to make per class before giving up on older
// history. Teams' virtual scroller only renders what's in the runway, so
// without this the tool can only ever see the most recent handful of posts.
const DEFAULT_SCROLLBACK = 5;

function debugShot(page, name) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
  } catch { /* ignore */ }
  return page
    .screenshot({ path: path.join(DEBUG_DIR, `${name}-${Date.now()}.png`), fullPage: true })
    .catch(() => {});
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Wait for channel-pane-message elements to appear in the DOM.
 * Teams uses a virtual scroll list that lazy-hydrates after ~5-10s.
 * Returns count of messages found or 0 if timed out.
 */
async function waitForPosts(page, maxSeconds = 12) {
  for (let s = 1; s <= maxSeconds; s++) {
    await page.waitForTimeout(1000);
    const count = await page.locator(MESSAGE_SELECTOR).count();
    if (count > 0) {
      console.log(`    Posts appeared at second ${s} (${count} visible).`);
      return count;
    }
  }
  return 0;
}

/**
 * Scroll the message list upward until it stops producing new messages.
 *
 * @returns {Promise<number>} final message count
 */
async function loadOlderPosts(page, maxPasses = DEFAULT_SCROLLBACK) {
  let previous = await page.locator(MESSAGE_SELECTOR).count();
  if (maxPasses <= 0) return previous;

  for (let pass = 0; pass < maxPasses; pass++) {
    await page.evaluate((sel) => {
      const msg = document.querySelector(sel);
      if (!msg) return;
      // Walk up to the nearest actually-scrollable ancestor.
      let el = msg.parentElement;
      while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement;
      if (el) el.scrollTop = 0;
      else window.scrollTo(0, 0);
    }, MESSAGE_SELECTOR);

    await page.waitForTimeout(1500);
    const count = await page.locator(MESSAGE_SELECTOR).count();
    if (count <= previous) break; // stopped growing — we've reached the top
    console.log(`    Scrollback pass ${pass + 1}: ${previous} → ${count} messages.`);
    previous = count;
  }
  return previous;
}

/**
 * Extract all currently-rendered post cards from the General channel.
 * Cleans body text, extracts attachments/URLs, detects bots and announcements,
 * and formats timestamps into ISO.
 */
async function extractPosts(page, className = "") {
  return await page.evaluate((args) => {
    const { sel, clsName } = args;
    const messages = Array.from(document.querySelectorAll(sel));

    // Runs in the browser, so it can't see Node scope — these helpers are
    // necessarily local.
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const normWs = (s) => s.replace(/[ \s]+/g, " ").trim();

    const normalizedClass = clsName ? normWs(clsName) : "";

    return messages.map((msg) => {
      // ── Subheader & Timestamp ──────────────────────────────────────────
      const subheader = msg.querySelector('[data-tid="post-message-subheader"]');
      const timestampEl = msg.querySelector('[data-tid="timestamp"]');

      const timestampText = timestampEl ? timestampEl.innerText.trim() : "";
      const timestampFull = timestampEl
        ? (timestampEl.getAttribute("title") || timestampEl.getAttribute("aria-label") || "")
        : "";

      let timestampIso = null;
      if (timestampFull) {
        const parsed = Date.parse(timestampFull);
        if (!isNaN(parsed)) {
          timestampIso = new Date(parsed).toISOString();
        }
      }

      // ── Author detection ───────────────────────────────────────────────
      const appTrigger = msg.querySelector('[data-tid="app-profile-card-trigger"]');
      let author = "";
      if (appTrigger) {
        author = appTrigger.innerText.trim() || "System";
      } else if (subheader) {
        let raw = subheader.innerText.trim();
        if (timestampText) raw = raw.replace(timestampText, "");
        author = raw.replace(/\bEdited\b/gi, "").trim();
      }

      const isBot = !!appTrigger ||
        /^assignments$/i.test(author) ||
        author.toLowerCase().includes("bot");

      // ── Subject / Subject line ─────────────────────────────────────────
      const subjectEl = msg.querySelector('[data-tid="subject-line"]');
      const subject = subjectEl ? subjectEl.innerText.trim() : "";

      // ── Announcement badge ─────────────────────────────────────────────
      const isAnnouncement = !!msg.querySelector('[data-tid="team-badge"]');

      // ── Attachments & URL previews ─────────────────────────────────────
      const attachments = [];
      const fileEls = msg.querySelectorAll('[data-tid="file-attachment-grid"] [role="gridcell"], [data-tid="file-attachment-grid"] a, [data-tid="file-name"]');
      fileEls.forEach((f) => {
        const txt = f.innerText.trim();
        if (txt && !attachments.includes(txt)) attachments.push(txt);
      });

      const urlPreviews = [];
      const urlEls = msg.querySelectorAll('[data-tid="url-preview"]');
      urlEls.forEach((u) => {
        const txt = u.innerText.trim().replace(/\s+/g, " ");
        if (txt && !urlPreviews.includes(txt)) urlPreviews.push(txt);
      });

      // ── Body ────────────────────────────────────────────────────────────
      const bodyEl = msg.querySelector('[data-tid="message-body"]');
      let body = bodyEl ? bodyEl.innerText.trim() : "";

      // Clean the channel-name leak Teams appends to the body.
      //
      // Whitespace is normalised FIRST because Teams joins the class name with
      // a non-breaking space, which a plain includes() never matches — so the
      // leak survived. And only a TRAILING occurrence is stripped: a global
      // split/join also deletes the course code out of the middle of a real
      // sentence ("CSE 312 lab will be held..." loses its subject).
      if (normalizedClass) {
        body = normWs(body).replace(new RegExp(escapeRe(normalizedClass) + "\\s*$"), "").trim();
      }

      // Clean bot button label
      if (isBot) {
        body = body.replace(/View assignment\s*$/i, "").trim();
      }

      // If body is empty but files are attached, mention the files
      if (!body && attachments.length > 0) {
        body = `[Attached: ${attachments.join(", ")}]`;
      }

      // ── Replies ─────────────────────────────────────────────────────────
      const responseSurfaces = Array.from(msg.querySelectorAll('[data-tid="response-surface"]'));
      const replies = responseSurfaces.map((r) => {
        const rHeader = r.querySelector('[data-tid="reply-message-header"]');
        const rTime = r.querySelector('[data-tid="timestamp"]');
        const rBody = r.querySelector('[data-tid="message-body"]');
        const rTimeStr = rTime ? rTime.innerText.trim() : "";
        let rAuthor = "";
        if (rHeader) {
          rAuthor = rHeader.innerText.trim().replace(rTimeStr, "").replace(/\bEdited\b/gi, "").trim();
        }
        return {
          author: rAuthor,
          timestamp: rTimeStr,
          body: rBody ? rBody.innerText.trim() : "",
        };
      });

      return {
        author,
        isBot,
        isAnnouncement,
        subject,
        timestamp: timestampText,
        timestampFull,
        timestampIso,
        body,
        attachments,
        urlPreviews,
        replyCount: replies.length,
        replies,
      };
    });
  }, { sel: MESSAGE_SELECTOR, clsName: className });
}

/**
 * Scrape General channel posts for a single class.
 *
 * @param {import('playwright').Page} page
 * @param {string} className
 * @param {{ scrollback?: number }} opts
 */
async function scrapeClassPosts(page, className = "unknown", opts = {}) {
  const scrollback = opts.scrollback === undefined ? DEFAULT_SCROLLBACK : opts.scrollback;

  const postCount = await waitForPosts(page, 12);
  if (postCount === 0) {
    console.log(`  (no channel posts found or empty channel)`);
    return [];
  }

  await loadOlderPosts(page, scrollback);

  const posts = await extractPosts(page, className);
  console.log(`  Extracted ${posts.length} post threads.`);
  return posts;
}

// --------------------------------------------------------------------------
// Standalone runner
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { headed: false, classFilter: null, hours: null, scrollback: DEFAULT_SCROLLBACK };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--headed") {
      opts.headed = true;
    } else if (arg === "--class") {
      opts.classFilter = argv[++i];
      if (!opts.classFilter) {
        console.error('❌ --class needs a value, e.g. --class "CSE 312"');
        process.exit(1);
      }
    } else if (arg === "--hours") {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error("❌ --hours needs a positive number.");
        process.exit(1);
      }
      opts.hours = n;
    } else if (arg === "--scrollback") {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error("❌ --scrollback needs a non-negative number.");
        process.exit(1);
      }
      opts.scrollback = n;
    } else {
      console.error(`❌ Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const allResults = [];

  const flush = () => {
    try {
      fs.writeFileSync(NOTICES_FILE, JSON.stringify(allResults, null, 2));
    } catch (e) {
      console.log(`  ⚠️ Could not write ${NOTICES_FILE}: ${e.message}`);
    }
  };

  const { browser, page } = await launchTeams({ headed: opts.headed });

  try {
    console.log("Navigating to Teams...");
    const classNames = await openTeamsList(page);
    const targets = selectClasses(classNames, opts.classFilter);

    if (targets.length === 0) {
      console.log(`Found ${classNames.length} classes, none matching --class "${opts.classFilter}".`);
      return;
    }
    console.log(`Found ${classNames.length} classes; scraping ${targets.length}.\n`);

    for (let n = 0; n < targets.length; n++) {
      const { name: className, index } = targets[n];
      console.log(`📢 [${n + 1}/${targets.length}] ${className}`);

      try {
        await openTeamByIndex(page, index);

        let posts = await scrapeClassPosts(page, className, { scrollback: opts.scrollback });
        if (opts.hours !== null) {
          const before = posts.length;
          posts = filterRecentPosts(posts, opts.hours);
          console.log(`    Window: kept ${posts.length}/${before} within ${opts.hours}h.`);
        }

        if (posts.length > 0) {
          const last = posts[posts.length - 1];
          console.log(`    Latest: "${last.author}" — "${(last.subject || last.body).slice(0, 60)}..."`);
        }

        allResults.push({ className, posts });
      } catch (e) {
        console.log(`    ❌ Error: ${e.message.slice(0, 80)}`);
        await debugShot(page, `posts-fail-${index}`);
        allResults.push({ className, posts: [], error: e.message });
      }

      flush();

      if (n < targets.length - 1) {
        console.log("    Returning to teams list...");
        await goBackToTeamsList(page);
      }
      console.log("");
    }
  } finally {
    flush();
    console.log(`✅ Done. Saved to ${NOTICES_FILE}`);
    await browser.close().catch(() => {});
  }
}

// Export for integration
module.exports = {
  scrapeClassPosts,
  extractPosts,
  waitForPosts,
  loadOlderPosts,
  parseArgs,
};

// Run directly if called from CLI
if (require.main === module) {
  main().catch(fatal);
}
