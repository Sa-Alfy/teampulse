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
const FIXTURE_CLASS = "Summer_2026_CSE 312 (V1)_ 232_D4";

// ── Chrome stubs ───────────────────────────────────────────────────────────
const CHROME_STUB_TEAMS = `
(function() {
  window.__msgs = [];
  window.__storageListeners = [];
  window.__local = {};
  window.__reply = function() { return { ok: true }; };   // tests may override
  window.chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      sendMessage: function(msg, cb) {
        window.__msgs.push(JSON.parse(JSON.stringify(msg)));
        const res = window.__reply(msg);
        if (cb) setTimeout(function() { cb(res); }, 0);
      }
    },
    storage: {
      onChanged: { addListener: function(fn) { window.__storageListeners.push(fn); } },
      local: { set: function(obj, cb) { Object.assign(window.__local, JSON.parse(JSON.stringify(obj))); if (cb) cb(); } }
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
    assert.strictEqual(first.className, FIXTURE_CLASS, "className should come from document.title");
    const ctxMsgs = msgs.filter((m) => m.type === "TP_CLASS_CONTEXT");
    assert.strictEqual(ctxMsgs[0] && ctxMsgs[0].className, FIXTURE_CLASS, "TP_CLASS_CONTEXT should carry the class");
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

  // (4) Class detection: unresolvable → silent; SPA switch → new context
  await runTest("class name: title/heading mismatch sends nothing; SPA switch re-sends context", async () => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: CHROME_STUB_TEAMS });
    await page.goto(
      "file:///" + path.join(FIXTURE_DIR, "teams-channel.html").replace(/\\/g, "/")
    );
    // Heading no longer matches any title segment → class unresolvable.
    await page.evaluate(() => {
      document.querySelector('[data-tid="channelTitle-text"]').textContent = "Random";
    });
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "teams-top.js") });
    await page.waitForTimeout(2500);
    let msgs = await page.evaluate(() => window.__msgs || []);
    assert.strictEqual(msgs.length, 0, `Expected no messages, got ${msgs.length}`);

    // Navigate (SPA-style) to another class: title + heading change together.
    await page.evaluate(() => {
      document.title = "Teams and Channels | Summer_2026_CSE 311 (V1)_ 232_D2 | Lab | Microsoft Teams";
      document.querySelector('[data-tid="channelTitle-text"]').textContent = "Lab";
    });
    msgs = await waitPostMsgs(page, 1, 5000);
    const ctxMsgs = msgs.filter((m) => m.type === "TP_CLASS_CONTEXT");
    const post    = msgs.find((m) => m.type === "TP_POSTS");
    assert.strictEqual(ctxMsgs.length, 1, "Expected one TP_CLASS_CONTEXT");
    assert.strictEqual(ctxMsgs[0].className, "Summer_2026_CSE 311 (V1)_ 232_D2");
    assert.strictEqual(post && post.className, "Summer_2026_CSE 311 (V1)_ 232_D2");

    await ctx.close();
  });

  // (5) Reliability: clear → resend, rejection → retry, orphaned script → silent stop
  async function loadedChannel() {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript({ content: CHROME_STUB_TEAMS });
    await page.goto(
      "file:///" + path.join(FIXTURE_DIR, "teams-channel.html").replace(/\\/g, "/")
    );
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "teams-top.js") });
    await waitPostMsgs(page, 1, 5000);
    const count = (type) => page.evaluate((t) => window.__msgs.filter((m) => m.type === t).length, type);
    const poke  = () => page.evaluate(() => document.body.appendChild(document.createElement("span")));
    return { ctx, page, errors, count, poke };
  }

  await runTest("Clear stored data → unchanged channel is re-sent (context + posts)", async () => {
    const { ctx, page, count } = await loadedChannel();
    assert.strictEqual(await count("TP_POSTS"), 1);
    await page.evaluate(() => window.__storageListeners.forEach((fn) =>
      fn({ "tp:v1:class-index": { oldValue: ["x"] } }, "local")));
    await waitPostMsgs(page, 2, 5000);
    assert.strictEqual(await count("TP_POSTS"), 2, "posts not re-sent after clear");
    assert.strictEqual(await count("TP_CLASS_CONTEXT"), 2, "class context not re-sent after clear");
    await ctx.close();
  });

  await runTest("unrelated storage writes do not trigger a resend", async () => {
    const { ctx, page, count } = await loadedChannel();
    await page.evaluate(() => window.__storageListeners.forEach((fn) =>
      fn({ "tp:v1:seen-hashes": { oldValue: {}, newValue: { a: 1 } } }, "local")));
    await page.waitForTimeout(2500);
    assert.strictEqual(await count("TP_POSTS"), 1);
    await ctx.close();
  });

  await runTest("rejected TP_POSTS is retried on the next DOM change", async () => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: CHROME_STUB_TEAMS });
    await page.addInitScript({ content: `
      let rejected = false;
      window.__reply = (m) => (m.type === "TP_POSTS" && !rejected) ? (rejected = true, { ok: false, reason: "test" }) : { ok: true };
    ` });
    await page.goto(
      "file:///" + path.join(FIXTURE_DIR, "teams-channel.html").replace(/\\/g, "/")
    );
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "teams-top.js") });
    await waitPostMsgs(page, 1, 5000);
    await page.evaluate(() => document.body.appendChild(document.createElement("span")));
    const msgs = await waitPostMsgs(page, 2, 5000);
    assert.strictEqual(msgs.filter((m) => m.type === "TP_POSTS").length, 2, "rejected batch not retried");
    await ctx.close();
  });

  await runTest("extension reloaded under the page → script stops without errors", async () => {
    const { ctx, page, errors, count, poke } = await loadedChannel();
    await page.evaluate(() => {
      window.chrome.runtime.id = undefined;
      window.chrome.runtime.sendMessage = () => { throw new Error("Extension context invalidated."); };
    });
    await page.evaluate(() => document.querySelector('[data-tid="subject-line"]').textContent = "Changed");
    await page.waitForTimeout(2500);
    await poke();
    await page.waitForTimeout(2500);
    assert.strictEqual(await count("TP_POSTS"), 1, "orphaned script kept sending");
    assert.deepStrictEqual(errors, [], `page errors: ${errors.join("; ")}`);
    await ctx.close();
  });

  await runTest("Sync all classes: visits every class (not hidden ones), one TP_POSTS each, returns to grid", async () => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: CHROME_STUB_TEAMS });
    await page.goto(
      "file:///" + path.join(FIXTURE_DIR, "teams-grid.html").replace(/\\/g, "/")
    );
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "teams-top.js") });
    await page.evaluate(() => window.__storageListeners.forEach((fn) =>
      fn({ "tp:sync:cmd": { newValue: { id: "1" } } }, "local")));

    const deadline = Date.now() + 40000;
    let status = null;
    while (Date.now() < deadline) {
      status = await page.evaluate(() => window.__local["tp:sync:status"] || null);
      if (status && status.state !== "running") break;
      await page.waitForTimeout(250);
    }
    assert.ok(status, "no sync status written");
    assert.strictEqual(status.state, "done", `sync ended as ${JSON.stringify(status)}`);
    assert.strictEqual(status.total, 3);
    assert.strictEqual(status.done, 3);
    assert.strictEqual(status.failed, 0);
    assert.strictEqual(status.assignments, "ok", "Assignments app opened and capture awaited");
    assert.strictEqual(await page.evaluate(() => window.__assignmentsOpened), 1);

    const visited = await page.evaluate(() => window.__visited);
    assert.ok(!visited.includes("Old_2025_CSE 101"), "hidden team was visited");

    const posts = (await page.evaluate(() => window.__msgs)).filter((m) => m.type === "TP_POSTS");
    for (const name of ["Summer_2026_CSE 303 (V1)_242_D4", "Summer_2026_CSE 311 (V1)_ 232_D2", "MAT 103 D1; Summer 2026"]) {
      const p = posts.find((m) => m.className === name);
      assert.ok(p, `no TP_POSTS for ${name}`);
      assert.ok(p.posts.every((x) => x.body.includes(name)), `posts filed under the wrong class for ${name}`);
    }
    assert.ok(await page.locator('[data-tid="teams-grid-view"]').count(), "did not return to the grid it started on");
    await ctx.close();
  });

  // (6) Scraper health — fake clock, so the grace periods run instantly.
  async function healthPage(mutate) {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.clock.install();
    await page.addInitScript({ content: CHROME_STUB_TEAMS });
    await page.goto(
      "file:///" + path.join(FIXTURE_DIR, "teams-channel.html").replace(/\\/g, "/")
    );
    await page.evaluate(mutate);
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "teams-top.js") });
    const health = () => page.evaluate(() => (window.__msgs || []).filter((m) => m.type === "TP_HEALTH"));
    return { ctx, page, health };
  }

  await runTest("health: unresolvable class → one TP_HEALTH no-class after 10 s, not before", async () => {
    const { ctx, page, health } = await healthPage(() => {
      document.querySelector('[data-tid="channelTitle-text"]').textContent = "Random";
    });
    await page.clock.runFor(8000);
    assert.strictEqual((await health()).length, 0, "reported before the grace period");
    await page.clock.runFor(30000);
    const h = await health();
    assert.strictEqual(h.length, 1, `Expected exactly 1 TP_HEALTH, got ${h.length}`);
    assert.deepStrictEqual(h[0], { type: "TP_HEALTH", status: "no-class" });
    await ctx.close();
  });

  await runTest("health: class resolved but zero messages → TP_HEALTH no-messages after 60 s", async () => {
    const { ctx, page, health } = await healthPage(() => {
      document.querySelectorAll('[data-tid="channel-pane-message"]').forEach((n) => n.remove());
    });
    await page.clock.runFor(50000);
    assert.strictEqual((await health()).length, 0, "reported before the grace period");
    await page.clock.runFor(20000);
    const h = await health();
    assert.strictEqual(h.length, 1, `Expected exactly 1 TP_HEALTH, got ${h.length}`);
    assert.deepStrictEqual(h[0], { type: "TP_HEALTH", status: "no-messages", className: FIXTURE_CLASS });
    await ctx.close();
  });

  await runTest("health: healthy channel never reports", async () => {
    const { ctx, page, health } = await healthPage(() => {});
    await page.clock.runFor(120000);
    assert.strictEqual((await health()).length, 0);
    await ctx.close();
  });

  // ── Open in Teams (popup card click → tp:nav:cmd) ──────────────────────
  async function navPage() {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: CHROME_STUB_TEAMS });
    await page.goto("file:///" + path.join(FIXTURE_DIR, "teams-channel.html").replace(/\\/g, "/"));
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "teams-top.js") });
    const fire = (cmd) => page.evaluate((c) => {
      const full = { id: `t-${Math.random()}`, at: Date.now(), ...c };
      window.__storageListeners.forEach((l) => l({ "tp:nav:cmd": { newValue: full } }, "local"));
    }, cmd);
    return { ctx, page, fire };
  }

  await runTest("open in Teams: post in the open class is scrolled to and outlined", async () => {
    const { ctx, page, fire } = await navPage();
    await fire({ kind: "post", className: FIXTURE_CLASS, subject: "Lab Cancelled", bodyStart: "",
      timestampIso: new Date("Tuesday, September 30, 2026 2:00 PM").toISOString() });
    await page.waitForFunction(() => document.getElementById("msg-2").style.outline.includes("solid"), null, { timeout: 5000 });
    assert.strictEqual(await page.evaluate(() => document.getElementById("msg-1").style.outline), "", "wrong post outlined");
    await ctx.close();
  });

  await runTest("open in Teams: body-start match works without a subject", async () => {
    const { ctx, page, fire } = await navPage();
    await fire({ kind: "post", className: FIXTURE_CLASS, subject: "", bodyStart: "CT-3 will be held on", timestampIso: null });
    await page.waitForFunction(() => document.getElementById("msg-1").style.outline.includes("solid"), null, { timeout: 5000 });
    await ctx.close();
  });

  await runTest("open in Teams: post not found → on-page notice, nothing outlined", async () => {
    const { ctx, page, fire } = await navPage();
    await fire({ kind: "post", className: FIXTURE_CLASS, subject: "No such post", bodyStart: "", timestampIso: null });
    await page.waitForFunction(() => /couldn't find that post/.test(document.body.textContent), null, { timeout: 20000 });
    const outlined = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-tid="channel-pane-message"]')).filter((m) => m.style.outline).length);
    assert.strictEqual(outlined, 0);
    await ctx.close();
  });

  await runTest("open in Teams: stale command (older than 2 min) is ignored", async () => {
    const { ctx, page, fire } = await navPage();
    await fire({ kind: "post", className: FIXTURE_CLASS, subject: "Lab Cancelled", at: Date.now() - 5 * 60e3 });
    await page.waitForTimeout(1500);
    assert.strictEqual(await page.evaluate(() => document.getElementById("msg-2").style.outline), "");
    await ctx.close();
  });

  // ── assignments-frame.js tests ─────────────────────────────────────────

  console.log("\nassignments-frame.js:");

  await runTest("open in Teams: after the capture, the frame selects the item's tab and outlines its card", async () => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: `
      window.__msgs = []; window.__nav = [];
      window.chrome = {
        runtime: { id: "test-extension-id", sendMessage: (m) => { window.__msgs.push(JSON.parse(JSON.stringify(m))); } },
        storage: {
          local: { get: (keys, cb) => cb({}) },
          onChanged: { addListener: (fn) => window.__nav.push(fn) },
        },
      };` });
    await page.goto("file:///" + path.join(FIXTURE_DIR, "assignments.html").replace(/\\/g, "/"));
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "assignments-frame.js") });
    await waitAssignMsgs(page, 1, 20000); // capture done, Upcoming restored
    await page.evaluate(() => window.__nav.forEach((l) => l({ "tp:nav:task": { newValue: {
      id: "n1", at: Date.now(), tab: "Past due", title: "HW-3",
      assignmentId: "ccdd3456-7890-3456-cdef-012345678901" } } }, "local")));
    await page.waitForFunction(() => {
      const card = document.getElementById("card-pd-1-ccdd3456-7890-3456-cdef-012345678901");
      return card && card.style.outline.includes("solid");
    }, null, { timeout: 10000 });
    assert.strictEqual(await page.evaluate(() => document.querySelector('[data-test="Past due"]').getAttribute("aria-selected")), "true");
    await ctx.close();
  });

  // Live 0.7.1 (owner, 2026-10-03): the jump waited behind a capture stuck on
  // Upcoming. A jump pending when the frame starts now runs first.
  await runTest("open in Teams: a jump pending at frame load runs before the capture, which still follows", async () => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript({ content: `
      window.__msgs = []; window.__outlinedAt = 0;
      const cmd = { id: "n2", at: Date.now(), tab: "Past due", title: "HW-3",
        assignmentId: "ccdd3456-7890-3456-cdef-012345678901" };
      window.chrome = {
        runtime: { id: "test-extension-id", sendMessage: (m) => { window.__msgs.push(JSON.parse(JSON.stringify(m))); } },
        storage: { local: { get: (keys, cb) => cb({ "tp:nav:task": cmd }) }, onChanged: { addListener: () => {} } },
      };` });
    await page.goto("file:///" + path.join(FIXTURE_DIR, "assignments.html").replace(/\\/g, "/"));
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "assignments-frame.js") });
    await page.waitForFunction(() => {
      const card = document.getElementById("card-pd-1-ccdd3456-7890-3456-cdef-012345678901");
      return card && card.style.outline.includes("solid");
    }, null, { timeout: 8000 });
    const capturedBeforeJump = await page.evaluate(() => window.__msgs.filter((m) => m.type === "TP_ASSIGNMENTS").length);
    assert.strictEqual(capturedBeforeJump, 0, "capture ran before the jump");
    const msgs = await waitAssignMsgs(page, 1, 25000);
    assert.ok(msgs.some((m) => m.type === "TP_ASSIGNMENTS" && m.assignments.length > 0), "capture did not follow the jump");
    await ctx.close();
  });

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

  // (all-classes) Grouped list at /classes/all/list → dates from group headers,
  // class from each card, scope "all-classes". Served at a fake https URL so
  // location.pathname matches the real view.
  await runTest("all-classes view: date from group header + time, class per card, scope all-classes", async () => {
    const ctx  = await browser.newContext({ timezoneId: "UTC" });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date("2026-10-01T10:00:00Z"));
    await page.route("https://assignments.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: require("fs").readFileSync(path.join(FIXTURE_DIR, "assignments-all.html"), "utf8"),
    }));
    await page.addInitScript({ content: CHROME_STUB_ASSIGNMENTS });
    await page.goto("https://assignments.test/classes/all/list");
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "assignments-frame.js") });

    const msgs = await waitAssignMsgs(page, 1, 20000);
    const m = msgs.find((x) => x.type === "TP_ASSIGNMENTS");
    assert.ok(m, "no TP_ASSIGNMENTS");
    assert.strictEqual(m.scope, "all-classes");
    assert.strictEqual(m.assignments.length, 4, `expected 4 cards, no duplicates: ${m.assignments.map((a) => a.title)}`);
    const by = Object.fromEntries(m.assignments.map((a) => [a.title, a]));
    assert.deepStrictEqual(Object.keys(by).sort(), ["CLP-02", "Final Project", "Project Proposal", "Project Submission"]);
    assert.strictEqual(by["Project Proposal"].tab, "Completed");
    assert.strictEqual(by["Project Proposal"].dueDate, "2026-07-24", "Completed → most recent past");

    assert.strictEqual(by["Project Submission"].dueDate, "2026-08-31", "Past due → this year (already passed)");
    assert.strictEqual(by["Project Submission"].className, "Summer_2026_CSE 312 (V1)_ 232_D4");
    assert.match(by["Project Submission"].dueRaw, /Aug 31st Due at 11:59 PM/);
    assert.strictEqual(by["CLP-02"].className, "Summer_2026_CSE 304 (V1)_242_D1");
    assert.strictEqual(by["Final Project"].dueDate, "2026-12-30", "Upcoming → next occurrence");
    assert.strictEqual(by["Final Project"].tab, "Upcoming");
    assert.strictEqual(by["Project Submission"].tab, "Past due", "stale cards must not be labelled with the next tab");
    assert.strictEqual(by["Project Submission"].details, "Due at 11:59 PM", "details = due line only");
    await ctx.close();
  });

  // Live bug: Upcoming empty → the scraper read the still-visible past-due
  // cards as "Upcoming" (46 = 2 × 23). Each card must appear once, correctly tabbed.
  await runTest("all-classes view, empty Upcoming: no stale cards recorded as Upcoming, no duplicates", async () => {
    const ctx  = await browser.newContext({ timezoneId: "UTC" });
    const page = await ctx.newPage();
    await page.route("https://assignments.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: require("fs").readFileSync(path.join(FIXTURE_DIR, "assignments-all.html"), "utf8"),
    }));
    await page.addInitScript({ content: CHROME_STUB_ASSIGNMENTS });
    await page.goto("https://assignments.test/classes/all/list?emptyUpcoming=1");
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "assignments-frame.js") });

    const m = (await waitAssignMsgs(page, 1, 30000)).find((x) => x.type === "TP_ASSIGNMENTS");
    assert.ok(m, "no TP_ASSIGNMENTS");
    const tabs = m.assignments.map((a) => `${a.title}:${a.tab}`).sort();
    assert.deepStrictEqual(tabs, ["CLP-02:Past due", "Project Proposal:Completed", "Project Submission:Past due"]);
    await ctx.close();
  });

  // Live failures 2026-10-01: wrong class (path was "/" at load), only the
  // rendered cards captured (virtualized list), past-due cards as Upcoming.
  await runTest("virtualized all-classes list: every card, right class, Past due, past dates, tab restored", async () => {
    const ctx  = await browser.newContext({ timezoneId: "UTC" });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date("2026-10-01T10:00:00Z"));
    await page.route("https://assignments.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: require("fs").readFileSync(path.join(FIXTURE_DIR, "assignments-virtual.html"), "utf8"),
    }));
    await page.addInitScript({ content: CHROME_STUB_ASSIGNMENTS });
    await page.goto("https://assignments.test/?isTeamsFrame=true");
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "assignments-frame.js") });

    const m = (await waitAssignMsgs(page, 1, 90000)).find((x) => x.type === "TP_ASSIGNMENTS");
    assert.ok(m, "no TP_ASSIGNMENTS");
    assert.strictEqual(m.scope, "all-classes");
    const past = await page.evaluate(() => window.__PAST);
    assert.strictEqual(m.assignments.length, past.length, `captured ${m.assignments.length} of ${past.length}`);
    for (const exp of past) {
      const a = m.assignments.find((x) => x.title === exp.title);
      assert.ok(a, `missing ${exp.title}`);
      assert.strictEqual(a.tab, "Past due", `${exp.title} tab`);
      assert.strictEqual(a.className, exp.cls, `${exp.title} class`);
      assert.strictEqual(a.dueDate, exp.iso, `${exp.title} date`);
    }
    await page.waitForTimeout(800); // restore click + the fixture's swap delay
    assert.strictEqual(await page.evaluate(() => document.querySelector('[data-test="Past due"]').getAttribute("aria-selected")),
      "true", "original tab restored");
    await ctx.close();
  });

  // Live 2026-10-01: app opens on empty Upcoming; Past due loads slowly →
  // the old 4 s wait read an empty screen ("+ assignments", 0 tasks).
  await runTest("Assignments app opens on empty Upcoming, Past due loads in 6 s → all cards captured", async () => {
    const ctx  = await browser.newContext({ timezoneId: "UTC" });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date("2026-10-01T10:00:00Z"));
    await page.route("https://assignments.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: require("fs").readFileSync(path.join(FIXTURE_DIR, "assignments-virtual.html"), "utf8"),
    }));
    await page.addInitScript({ content: CHROME_STUB_ASSIGNMENTS });
    await page.goto("https://assignments.test/?start=Upcoming&delay=6000");
    await page.addScriptTag({ path: path.join(SCRIPT_DIR, "assignments-frame.js") });

    const m = (await waitAssignMsgs(page, 1, 90000)).find((x) => x.type === "TP_ASSIGNMENTS");
    assert.ok(m, "no TP_ASSIGNMENTS");
    const past = await page.evaluate(() => window.__PAST);
    assert.strictEqual(m.assignments.length, past.length, `captured ${m.assignments.length} of ${past.length}`);
    assert.ok(m.assignments.every((a) => a.tab === "Past due"), "all Past due");
    await ctx.close();
  });

  // ── v0.6.4 regressions on the higher-fidelity mock (assignments-matrix.js) ──
  // Evidence (2026-10-01 .ics): stale Upcoming read → every Past due item
  // again as Upcoming +1 year; v0.6.1–0.6.3: nothing captured.
  console.log("\nassignments mock matrix:");
  const matrix = require("./assignments-matrix");
  const clean = (r) => {
    assert.strictEqual(r.missing, 0, `missing ${r.missing}/${r.expected}`);
    for (const k of ["dup", "wrongTab", "wrongDate", "wrongClass"]) assert.strictEqual(r[k], 0, `${k}=${r[k]}`);
    assert.strictEqual(r.status, "ok");
  };
  const byName = (n) => matrix.SCENARIOS.find((s) => s.name === n);
  const cases = [
    ["stale previous-tab cards (2 s) + late load → no cross-tab duplicates, no year shift", "stale 2s + load 3s", clean],
    ["Upcoming opens empty, its empty text lingers → Past due/Completed still captured", "start Upcoming(empty), stale 800 + load 2s", clean],
    ["React reuses card nodes across tabs → switch still detected", "index-key node reuse, load 1.5s", clean],
    ["iframe loads display:none, shown later → deferred, then captured", "iframe display:none, shown at 4s", (r) => {
      clean(r);
      assert.strictEqual(r.msgs, 2, "deferred report + capture");
    }],
    ["iframe never shown → 'deferred' report, no cards, nothing to overwrite", "iframe hidden, never shown", (r) => {
      assert.strictEqual(r.status, "deferred");
      assert.strictEqual(r.cards, 0);
      assert.strictEqual(r.okTabs, "");
    }],
    ["live: opens on Upcoming showing Past due's list, switches itself (3 s) → all captured", "live: opens on Upcoming showing Past due, self-switches 3s", clean],
    ["live: same, switch after 300 ms → all captured", "live: self-switch 300ms", clean],
    ["live: empty Upcoming redirects to Completed → Completed not filed as Upcoming", "live: empty Upcoming redirects to Completed (1.5s)", (r) => {
      assert.strictEqual(r.wrongTab + r.dup + r.missing + r.wrongDate + r.wrongClass, 0, JSON.stringify(r.msg.report.tabs));
      assert.strictEqual(r.status, "partial");
      assert.strictEqual(r.reasons, "tab-switched-away");
    }],
    ["tabs missing (DOM drift) → 'failed' report with reason, no okTabs", "tabs missing (DOM drift)", (r) => {
      assert.strictEqual(r.status, "failed");
      assert.strictEqual(r.reasons, "no-tabs-found");
      assert.strictEqual(r.okTabs, "");
    }],
    ["live all-classes wording 'No upcoming assignments right now.' → Upcoming ok, no 20 s stall", "live empty wording (all-classes)", (r) => {
      clean(r);
      const up = r.msg.report.tabs.find((t) => t.tab === "Upcoming");
      assert.strictEqual(up.listLoaded, true, JSON.stringify(up));
    }],
    ["unknown empty-state wording → that tab times out (reported), others ok", "other empty wording", (r) => {
      assert.strictEqual(r.status, "partial");
      assert.strictEqual(r.okTabs, "Past due,Completed");
      assert.strictEqual(r.wrongDate + r.dup + r.wrongClass, 0);
    }],
  ];
  const results = await Promise.all(cases.map(([, n]) => matrix.runScenario(browser, byName(n))));
  for (let i = 0; i < cases.length; i++) {
    await runTest(cases[i][0], async () => cases[i][2](results[i]));
  }
  await runTest("capture report carries counts and codes only (no titles, no class names)", async () => {
    const r = results[0].msg.report;
    const json = JSON.stringify(r);
    assert.ok(!/Project Submission|CSE 312|Lab Report/.test(json), json);
    assert.deepStrictEqual(r.tabs.map((t) => t.tab), ["Past due", "Upcoming", "Completed"], "selected tab read first");
    assert.ok(r.tabs.every((t) => t.selectedConfirmed && t.cardsChangedConfirmed && t.listLoaded));
  });

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
