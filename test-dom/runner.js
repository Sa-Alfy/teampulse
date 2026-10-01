"use strict";

/**
 * test-dom/runner.js — Playwright DOM tests for content scripts.
 *
 * Run with:  npm run test:dom
 * NOT picked up by `node --test` (does not match test file patterns).
 *
 * DISCLAIMER: These fixtures prove port logic only, NOT compatibility with
 * the real Teams DOM. The real Teams DOM is dynamically rendered by React;
 * attribute values, whitespace, and character encoding (e.g. NBSP) may differ
 * from these static fixtures. All selectors used here are exactly those listed
 * in the task spec and used by scrape-posts.js / teams.js. Correctness on the
 * live site requires manual verification.
 */

const { chromium } = require("playwright");
const path         = require("path");
const assert       = require("assert");

const FIXTURE_DIR  = path.join(__dirname, "fixtures");
const SCRIPT_DIR   = path.join(__dirname, "..", "extension", "content");

// ── Chrome stubs ───────────────────────────────────────────────────────────
const CHROME_STUB_TEAMS = `
(function() {
  window.__msgs = [];
  window.__TP_TEST_CLASS = "Test CSE 312";
  window.chrome = {
    runtime: {
      id: "test-extension-id",
      sendMessage: function(msg) {
        window.__msgs.push(JSON.parse(JSON.stringify(msg)));
      }
    }
  };
})();
`;

const CHROME_STUB_ASSIGNMENTS = `
(function() {
  window.__msgs = [];
  window.chrome = {
    runtime: {
      id: "test-extension-id",
      sendMessage: function(msg) {
        window.__msgs.push(JSON.parse(JSON.stringify(msg)));
      }
    }
  };
})();
`;

// ── Typed message polling helpers ──────────────────────────────────────────

async function waitPostMsgs(page, targetCount, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const postCount = await page.evaluate(
      () => (window.__msgs || []).filter((m) => m.type === "TP_POSTS").length
    );
    if (postCount >= targetCount) break;
    await page.waitForTimeout(150);
  }
  return page.evaluate(() => window.__msgs || []);
}

async function waitAssignMsgs(page, targetCount, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const assignCount = await page.evaluate(
      () => (window.__msgs || []).filter((m) => m.type === "TP_ASSIGNMENTS").length
    );
    if (assignCount >= targetCount) break;
    await page.waitForTimeout(150);
  }
  return page.evaluate(() => window.__msgs || []);
}

// ── Test runner ────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  let failed = 0;

  async function runTest(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  // ── teams-top.js tests ─────────────────────────────────────────────────

  console.log("\nteams-top.js:");

  // (1) 2-post fixture → one TP_POSTS with exactly 2 posts
  await runTest("fixture with 2 posts → TP_POSTS message with 2 posts", async () => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: CHROME_STUB_TEAMS });

    await page.goto(
      "file:///" + path.join(FIXTURE_DIR, "teams-channel.html").replace(/\\/g, "/")
    );
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "teams-top.js") });

    // Wait for at least 1 TP_POSTS message (debounce is 1500 ms).
    const msgs     = await waitPostMsgs(page, 1, 5000);
    const postMsgs = msgs.filter((m) => m.type === "TP_POSTS");

    assert.ok(postMsgs.length >= 1, `Expected ≥1 TP_POSTS, got ${postMsgs.length}`);
    const first = postMsgs[0];
    assert.strictEqual(first.posts.length, 2, `Expected 2 posts, got ${first.posts.length}`);
    assert.strictEqual(first.className, "Test CSE 312", "className should come from override");
    assert.ok(typeof first.scrapedAt === "string", "scrapedAt should be an ISO string");

    // Verify all field names match scrape-posts.js extractPosts() output.
    const p = first.posts[0];
    for (const field of ["author","isBot","isAnnouncement","subject",
                          "timestamp","timestampFull","timestampIso",
                          "body","attachments","urlPreviews","replyCount","replies"]) {
      assert.ok(field in p, `Field "${field}" missing from post`);
    }

    // Spot checks on extracted values.
    assert.strictEqual(p.subject, "CT-3 Schedule");
    assert.strictEqual(first.posts[1].replyCount, 1, "2nd post should have 1 reply");

    await ctx.close();
  });

  // (2) Dynamically added 3rd post → new TP_POSTS after debounce
  await runTest("3rd post added dynamically → new TP_POSTS after debounce", async () => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: CHROME_STUB_TEAMS });

    await page.goto(
      "file:///" + path.join(FIXTURE_DIR, "teams-channel.html").replace(/\\/g, "/")
    );
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "teams-top.js") });

    // Wait for the initial TP_POSTS.
    const initial    = await waitPostMsgs(page, 1, 5000);
    const initCount  = initial.filter((m) => m.type === "TP_POSTS").length;
    assert.ok(initCount >= 1, "Should have at least one TP_POSTS before mutation");

    // Inject a 3rd post into the DOM.
    await page.evaluate(() => {
      const div = document.createElement("div");
      div.setAttribute("data-tid", "channel-pane-message");
      div.innerHTML = `
        <div data-tid="post-message-subheader">
          Dr. Gamma
          <span data-tid="timestamp" title="Wednesday, October 1, 2026 9:00 AM">Wed 9:00 AM</span>
        </div>
        <div data-tid="subject-line">New Announcement</div>
        <div data-tid="message-body">Important update for everyone.</div>
      `;
      document.body.appendChild(div);
    });

    // Wait for a second TP_POSTS after debounce (debounce = 1500 ms).
    const after    = await waitPostMsgs(page, initCount + 1, 6000);
    const postMsgs = after.filter((m) => m.type === "TP_POSTS");

    assert.ok(postMsgs.length > initCount,
      `Expected more TP_POSTS after mutation (had ${initCount}, now ${postMsgs.length})`);
    const last = postMsgs[postMsgs.length - 1];
    assert.strictEqual(last.posts.length, 3, `Expected 3 posts, got ${last.posts.length}`);

    await ctx.close();
  });

  // (3) Empty page → no TP_POSTS message
  await runTest("empty post list → no TP_POSTS message sent", async () => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: CHROME_STUB_TEAMS });

    await page.setContent("<!DOCTYPE html><html><body></body></html>");
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "teams-top.js") });

    // Wait past the debounce interval.
    await page.waitForTimeout(2500);

    const msgs     = await page.evaluate(() => window.__msgs || []);
    const postMsgs = msgs.filter((m) => m.type === "TP_POSTS");
    assert.strictEqual(postMsgs.length, 0, `Expected 0 TP_POSTS, got ${postMsgs.length}`);

    await ctx.close();
  });

  // ── assignments-frame.js tests ─────────────────────────────────────────

  console.log("\nassignments-frame.js:");

  // (4) 3-tab fixture → single TP_ASSIGNMENTS with all 4 cards; original tab restored
  await runTest("3-tab fixture → TP_ASSIGNMENTS with all cards; original tab restored", async () => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: CHROME_STUB_ASSIGNMENTS });

    await page.goto(
      "file:///" + path.join(FIXTURE_DIR, "assignments.html").replace(/\\/g, "/")
    );
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "assignments-frame.js") });

    // assignments-frame.js clicks 3 tabs and waits for each to settle.
    const msgs       = await waitAssignMsgs(page, 1, 20000);
    const assignMsgs = msgs.filter((m) => m.type === "TP_ASSIGNMENTS");

    assert.ok(assignMsgs.length >= 1, `Expected ≥1 TP_ASSIGNMENTS, got ${assignMsgs.length}`);

    const payload = assignMsgs[0];
    assert.ok(typeof payload.scrapedAt === "string", "scrapedAt should be an ISO string");
    assert.ok(Array.isArray(payload.assignments),    "assignments should be an array");

    // 2 Upcoming + 1 Past due + 1 Completed = 4.
    assert.strictEqual(payload.assignments.length, 4,
      `Expected 4 assignments, got ${payload.assignments.length}`);

    const tabs = payload.assignments.map((a) => a.tab);
    assert.ok(tabs.includes("Upcoming"),  "Should have Upcoming entries");
    assert.ok(tabs.includes("Past due"),  "Should have Past due entries");
    assert.ok(tabs.includes("Completed"), "Should have Completed entries");

    // Verify all field names match teams.js output.
    const a = payload.assignments[0];
    for (const field of ["tab","assignmentId","rawId","title","details","dueRaw","dueDate","status"]) {
      assert.ok(field in a, `Field "${field}" missing from assignment`);
    }

    // Verify GUID extracted from card id.
    const lab = payload.assignments.find((x) => x.title === "Lab 4 Report");
    assert.ok(lab, "Lab 4 Report should be present");
    assert.match(
      lab.assignmentId || "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "assignmentId should be a GUID"
    );

    // dueRaw from <time datetime>.
    assert.strictEqual(lab.dueRaw, "2026-10-05T23:59:00Z");

    // Original tab (Upcoming) should be restored.
    const restoredSel = await page.evaluate(() => {
      const el = document.querySelector('[data-test="Upcoming"]');
      return el ? el.getAttribute("aria-selected") : null;
    });
    assert.strictEqual(restoredSel, "true", "Original tab (Upcoming) should be restored after scrape");

    await ctx.close();
  });

  await require("./popup-xss.test.js").run(browser, runTest);

  // ── Summary ────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(46)}`);
  console.log(`Tests: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  console.log("─".repeat(46));
  console.log("");
  console.log("NOTE: These fixtures prove port logic only, not");
  console.log("compatibility with the real Teams DOM.");

  await browser.close();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err.stack || err);
  process.exit(1);
});
