const { chromium } = require("playwright");
const fs = require("fs");

const TEAMS_URL = "https://teams.microsoft.com/v2/";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Parse author name from post-message-subheader text.
 * Subheader text looks like: "Mayeesha Farjana 8/23 9:36 AM" or
 * "Mayeesha Farjana 8/23 9:36 AM Edited"
 */
function parseAuthor(subheaderText, timestampText) {
  if (!subheaderText) return "";
  let author = subheaderText;
  if (timestampText) {
    author = author.replace(timestampText, "").replace(/\bEdited\b/gi, "").trim();
  }
  return author.trim();
}

/**
 * Wait for channel-pane-message elements to appear in the DOM.
 * Teams uses a virtual scroll list that lazy-hydrates after ~5-10s.
 * Returns count of messages found or 0 if timed out.
 */
async function waitForPosts(page, maxSeconds = 12) {
  for (let s = 1; s <= maxSeconds; s++) {
    await page.waitForTimeout(1000);
    const count = await page.locator('[data-tid="channel-pane-message"]').count();
    if (count > 0) {
      console.log(`    Posts appeared at second ${s} (${count} visible).`);
      return count;
    }
  }
  return 0;
}

/**
 * Extract all currently-rendered post cards from the General channel.
 * Cleans body text, extracts attachments/URLs, detects bots and announcements,
 * and formats timestamps into ISO.
 */
async function extractPosts(page, className = "") {
  return await page.evaluate((clsName) => {
    const messages = Array.from(document.querySelectorAll('[data-tid="channel-pane-message"]'));

    return messages.map(msg => {
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
      fileEls.forEach(f => {
        const txt = f.innerText.trim();
        if (txt && !attachments.includes(txt)) attachments.push(txt);
      });

      const urlPreviews = [];
      const urlEls = msg.querySelectorAll('[data-tid="url-preview"]');
      urlEls.forEach(u => {
        const txt = u.innerText.trim().replace(/\s+/g, ' ');
        if (txt && !urlPreviews.includes(txt)) urlPreviews.push(txt);
      });

      // ── Body ────────────────────────────────────────────────────────────
      const bodyEl = msg.querySelector('[data-tid="message-body"]');
      let body = bodyEl ? bodyEl.innerText.trim() : "";

      // Clean channel name leaks from body
      if (clsName && body.includes(clsName)) {
        body = body.split(clsName).join("").trim();
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
      const replies = responseSurfaces.map(r => {
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
          body: rBody ? rBody.innerText.trim() : ""
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
        replies
      };
    });
  }, className);
}

/**
 * Filter posts within a given hour window (e.g. 48 hours).
 */
function filterRecentPosts(posts, hours = 48) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return posts.filter(p => {
    if (!p.timestampIso) return true; // keep if date unparseable to avoid data loss
    const postTime = new Date(p.timestampIso).getTime();
    return postTime >= cutoff;
  });
}

/**
 * Scrape General channel posts for a single class.
 */
async function scrapeClassPosts(page, className = "unknown") {
  const postCount = await waitForPosts(page, 12);
  if (postCount === 0) {
    console.log(`  (no channel posts found or empty channel)`);
    return [];
  }
  const posts = await extractPosts(page, className);
  console.log(`  Extracted ${posts.length} post threads.`);
  return posts;
}

/**
 * Navigate back to the teams list.
 */
async function goBackToTeamsList(page) {
  try {
    const backBtn = page.getByText("All teams", { exact: false }).first();
    await backBtn.waitFor({ timeout: 8000 });
    await backBtn.click();
    await page.waitForTimeout(2000);
    await page.waitForSelector('[data-testid="team-name"]', { timeout: 10000 });
    return true;
  } catch (e) {
    console.log(`    Back nav failed (${e.message.slice(0, 60)}), reloading...`);
    try {
      await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('[data-testid="team-name"]', { timeout: 45000 });
      return true;
    } catch (e2) {
      console.log(`    ❌ Reload also failed: ${e2.message.slice(0, 60)}`);
      return false;
    }
  }
}

// --------------------------------------------------------------------------
// Standalone runner
// --------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: "auth-teams.json",
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();

  console.log("Navigating to Teams...");
  await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="team-name"]', { timeout: 45000 });

  const classNames = await page.locator('[data-testid="team-name"]').allTextContents();
  console.log(`Found ${classNames.length} classes.\n`);

  const allResults = [];

  for (let i = 0; i < classNames.length; i++) {
    const className = classNames[i].trim();
    console.log(`📢 [${i + 1}/${classNames.length}] ${className}`);

    try {
      const teamLocator = page
        .locator('[data-testid="team-name"]')
        .filter({ hasText: className })
        .first();
      await teamLocator.waitFor({ timeout: 15000 });
      await teamLocator.click();

      const posts = await scrapeClassPosts(page, className);
      if (posts.length > 0) {
        const last = posts[posts.length - 1];
        console.log(`    Latest: "${last.author}" — "${(last.subject || last.body).slice(0, 60)}..."`);
      }

      allResults.push({ className, posts });
    } catch (e) {
      console.log(`    ❌ Error: ${e.message.slice(0, 80)}`);
      await page.screenshot({ path: `debug-posts-fail-${i}.png`, fullPage: true }).catch(() => {});
      allResults.push({ className, posts: [], error: e.message });
    }

    if (i < classNames.length - 1) {
      console.log("    Returning to teams list...");
      await goBackToTeamsList(page);
    }
    console.log("");
  }

  fs.writeFileSync("notices.json", JSON.stringify(allResults, null, 2));
  console.log("✅ Done. Saved to notices.json");

  await browser.close();
}

// Export for integration
module.exports = {
  scrapeClassPosts,
  extractPosts,
  waitForPosts,
  filterRecentPosts
};

// Run directly if called from CLI
if (require.main === module) {
  main().catch(err => console.error("❌ Fatal error:", err));
}
