"use strict";

/**
 * test-dom/popup-xss.test.js — Popup rendering tests (Playwright).
 *
 * Run via `npm run test:dom` (test-dom/runner.js calls run()). The file name
 * matches `node --test`'s default glob, so under `node --test` it registers a
 * single skipped test instead of launching a browser.
 *
 * popup.html is loaded from file:// with an in-memory chrome.* stub whose
 * storage is pre-seeded with hostile scraped text. Asserts the text renders
 * literally, no <img>/<script> elements are created, no dialog fires and no
 * request leaves the page.
 */

const path   = require("path");
const assert = require("assert");

const POPUP_URL = "file:///" + path.join(__dirname, "..", "extension", "popup.html").replace(/\\/g, "/");

const P1 = "<img src=x onerror=alert(1)>";
const P2 = '<img src="https://example.invalid/x">';

function seedState(nowIso, lastSyncIso) {
  const cls = "Test CSE 312";
  const post = {
    author: `Dr ${P1}`,
    isBot: false,
    isAnnouncement: true,
    subject: `Exam ${P1}`,
    timestamp: "Mon 9:00 AM",
    timestampFull: "",
    timestampIso: nowIso,
    body: `Quiz ${P2}`,
    attachments: [],
    urlPreviews: [],
    replyCount: 0,
    replies: [],
  };
  return {
    "tp:v1:class-index": [cls],
    "tp:v1:seen-hashes": { h1: { seenAt: nowIso, surfaced: true } },
    [`tp:v1:posts:${cls}`]: { h1: { post, className: cls, seenAt: nowIso, surfaced: true } },
    [`tp:v1:assignments:${cls}`]: [
      { tab: "Upcoming", title: `Lab ${P2}`, details: `Read ${P1}`, dueDate: null, dueRaw: "" },
    ],
    [`tp:v1:last-sync:${cls}`]: lastSyncIso,
    collapsedClasses: {},
  };
}

// In-memory chrome.* stub. Supports both callback and promise call styles.
function chromeStub(seed) {
  return `(() => {
    const local = ${JSON.stringify(seed)};
    const session = { "tp:tabctx:7": "Test CSE 312" };
    const listeners = [];
    window.__badge = null;
    const area = (data, name) => ({
      get(keys, cb) {
        const out = {};
        if (keys === null) Object.assign(out, data);
        else for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
        const copy = JSON.parse(JSON.stringify(out));
        if (cb) { cb(copy); return; }
        return Promise.resolve(copy);
      },
      set(obj, cb) {
        Object.assign(data, JSON.parse(JSON.stringify(obj)));
        const changes = {}; for (const k of Object.keys(obj)) changes[k] = { newValue: obj[k] };
        listeners.forEach((l) => l(changes, name));
        if (cb) { cb(); return; } return Promise.resolve();
      },
      remove(keys, cb) {
        const changes = {};
        for (const k of [].concat(keys)) { changes[k] = { oldValue: data[k] }; delete data[k]; }
        listeners.forEach((l) => l(changes, name));
        if (cb) { cb(); return; } return Promise.resolve();
      },
    });
    window.__local = local;
    window.__session = session;
    window.chrome = {
      runtime: { id: "test", lastError: undefined },
      action: { setBadgeText: (o) => { window.__badge = o.text; return Promise.resolve(); },
                setBadgeBackgroundColor: () => Promise.resolve() },
      storage: { local: area(local, "local"), session: area(session, "session"),
                 onChanged: { addListener: (fn) => listeners.push(fn) } },
    };
  })();`;
}

async function openPopup(browser, seed) {
  const ctx  = await browser.newContext();
  const page = await ctx.newPage();
  const requests = [];
  const dialogs  = [];
  page.on("request", (r) => { if (!r.url().startsWith("file://") || /\/x$/.test(r.url())) requests.push(r.url()); });
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await page.addInitScript({ content: chromeStub(seed) });
  await page.goto(POPUP_URL);
  return { ctx, page, requests, dialogs };
}

async function run(browser, runTest) {
  console.log("\npopup.html:");

  await runTest("hostile scraped text renders literally; no <img>, dialog or request", async () => {
    const now = new Date().toISOString();
    const { ctx, page, requests, dialogs } = await openPopup(browser, seedState(now, now));
    await page.waitForSelector("#feedContainer:not(.hidden)", { timeout: 5000 });
    await page.waitForTimeout(500); // give any injected <img> time to fire

    const text = await page.locator("#classList").textContent();
    for (const p of [P1, P2]) assert.ok(text.includes(p), `payload not shown literally: ${p}`);

    const dom = await page.evaluate(() => ({
      imgs: document.querySelectorAll("img").length,
      inlineScripts: Array.from(document.scripts).filter((s) => !s.src).length,
      scripts: document.scripts.length,
    }));
    assert.strictEqual(dom.imgs, 0, "an <img> element was created");
    assert.strictEqual(dom.inlineScripts, 0, "an inline <script> exists");
    assert.strictEqual(dom.scripts, 6, `expected the 6 static <script src> tags, got ${dom.scripts}`);
    assert.deepStrictEqual(dialogs, [], "a dialog fired");
    assert.deepStrictEqual(requests, [], `unexpected requests: ${requests.join(", ")}`);
    assert.strictEqual(await page.locator("#staleBanner").isHidden(), true, "fresh data must not show stale banner");
    await ctx.close();
  });

  await runTest("stale data shows banner; Clear stored data wipes storage and badge", async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 48 * 3600e3).toISOString();
    const { ctx, page } = await openPopup(browser, seedState(now, old));
    await page.waitForSelector("#feedContainer:not(.hidden)", { timeout: 5000 });
    assert.strictEqual(await page.locator("#staleBanner").isVisible(), true, "stale banner not shown");

    await page.click("#clearDataBtn");
    await page.click("#clearDataBtn");
    await page.waitForSelector("#noDataState:not(.hidden)", { timeout: 5000 });

    const after = await page.evaluate(() => ({
      tpKeys: Object.keys(window.__local).filter((k) => k.startsWith("tp:v1:")),
      session: Object.keys(window.__session),
      badge: window.__badge,
    }));
    assert.deepStrictEqual(after.tpKeys, [], "tp:v1:* keys remain");
    assert.deepStrictEqual(after.session, [], "tab contexts remain");
    assert.strictEqual(after.badge, "", "badge not cleared");
    assert.match(await page.locator("#noDataState").textContent(), /Open Microsoft Teams in this browser/);
    await ctx.close();
  });
}

async function runIcs(browser, runTest) {
  await runTest("Export assignments (.ics) downloads an on-device calendar file, no requests", async () => {
    const now  = new Date().toISOString();
    const seed = seedState(now, now);
    seed["tp:v1:assignments:Test CSE 312"].push(
      { tab: "Upcoming", title: "Lab 9", details: "", dueDate: "2026-10-05", dueRaw: "" });
    const { ctx, page, requests } = await openPopup(browser, seed);
    await page.waitForSelector("#feedContainer:not(.hidden)", { timeout: 5000 });
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportIcsBtn")]);
    assert.match(download.suggestedFilename(), /^assignments-\d{4}-\d{2}-\d{2}\.ics$/);
    const body = require("fs").readFileSync(await download.path(), "utf8");
    assert.match(body, /^BEGIN:VCALENDAR\r\n/);
    assert.strictEqual((body.match(/BEGIN:VEVENT/g) || []).length, 1, "only the dated assignment");
    assert.ok(body.includes("SUMMARY:Lab 9"), "dated assignment exported");
    assert.match(await page.locator("#syncStatus").textContent(), /Exported 1 assignment \(1 undated skipped\)/);
    assert.deepStrictEqual(requests, [], `unexpected requests: ${requests.join(", ")}`);
    await ctx.close();
  });
}

async function runCaptureDetails(browser, runTest) {
  await runTest("Capture details shows the last capture report (text only) with a warning", async () => {
    const now  = new Date().toISOString();
    const seed = seedState(now, now);
    seed["tp:v1:capture-report"] = {
      status: "partial", reason: "", trigger: "load", scope: "all-classes", readyWaitResult: "ready",
      documentHidden: false, rendered: true, receivedAt: now, cardsSent: 14,
      background: { accepted: true, reason: "", okTabs: ["Past due"], classesWritten: 2, unmatched: 0, classValidation: "known-classes", health: "ok" },
      tabs: [{ tab: "Upcoming", status: "timeout", reason: "list-not-loaded", tabFound: true, clicked: true,
        selectedConfirmed: true, cardsChangedConfirmed: true, listLoaded: false, cardsRaw: 0, droppedHidden: 0,
        droppedStale: 0, droppedByRelativeFilter: 0, dedupedOut: 0, kept: 0 }],
    };
    const { ctx, page, requests } = await openPopup(browser, seed);
    await page.waitForSelector("#captureDetails:not([hidden])", { timeout: 5000 });
    assert.match(await page.locator("#captureSummary").textContent(), /Capture details ⚠/);
    await page.click("#captureSummary");
    const text = await page.locator("#captureReport").textContent();
    assert.match(text, /status partial/);
    assert.match(text, /Upcoming: timeout \(list-not-loaded\)/);
    assert.match(text, /ok tabs Past due · classes written 2/);
    assert.strictEqual(await page.locator("#captureReport *").count(), 0, "report rendered as text only");
    assert.deepStrictEqual(requests, []);
    await ctx.close();
  });
}

async function runHealth(browser, runTest) {
  await runTest("scraper problem newer than last capture → 'Scraper may be out of date' banner", async () => {
    const now  = new Date().toISOString();
    const old  = new Date(Date.now() - 48 * 3600e3).toISOString();
    const seed = seedState(now, old);
    seed["tp:v1:scrape-health"] = { global: { status: "no-class", at: now }, classes: {} };
    const { ctx, page } = await openPopup(browser, seed);
    await page.waitForSelector("#scraperBanner:not(.hidden)", { timeout: 5000 });
    assert.match(await page.locator("#scraperBanner").textContent(), /Scraper may be out of date/);
    assert.strictEqual(await page.locator("#staleBanner").isHidden(), true, "stale banner should yield to scraper banner");
    await ctx.close();
  });
}

module.exports = { run: async (browser, runTest) => {
  await run(browser, runTest);
  await runHealth(browser, runTest);
  await runIcs(browser, runTest);
  await runCaptureDetails(browser, runTest);
} };

if (process.env.NODE_TEST_CONTEXT) {
  require("node:test").test("popup DOM tests (run with npm run test:dom)", { skip: true }, () => {});
}
