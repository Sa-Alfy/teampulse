"use strict";

/**
 * test-dom/extension-e2e.js — loads the REAL unpacked extension in Chromium
 * and drives it against local mock pages.   Run: npm run test:e2e
 *
 * The shipped extension is never edited. A temp copy gets two test-only
 * patches, each asserted to have applied:
 *   - manifest.json: content-script matches for the local mock origins
 *   - core/messages.js: those origins added to the sender allowlist
 * Teams page and assignments iframe are served from different ports so the
 * iframe is cross-origin, as on real Teams.
 *
 * Verifies: content script → service worker → chrome.storage.local → popup
 * (posts + assignments), badge text, hostile post text rendered literally,
 * and that the popup page makes no http(s) requests.
 */

const { chromium } = require("playwright");
const http   = require("http");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const assert = require("assert");

const ROOT     = path.join(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const XSS      = "<img src=x onerror=alert(1)> Exam notice";

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function patch(file, from, to) {
  const src = fs.readFileSync(file, "utf8");
  const out = src.replace(from, to);
  assert.notStrictEqual(out, src, `test patch did not apply to ${path.basename(file)} — update extension-e2e.js`);
  fs.writeFileSync(file, out);
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  // ── Mock servers ──────────────────────────────────────────────────────────
  let assignOrigin = "";
  const teamsSrv = await listen((req, res) => {
    if (req.url !== "/teams") { res.writeHead(404); return res.end(); }
    const html = fs.readFileSync(path.join(FIXTURES, "teams-channel.html"), "utf8")
      .replace("</body>", `<iframe src="${assignOrigin}/assignments" width="800" height="600"></iframe></body>`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  const assignSrv = await listen((req, res) => {
    if (req.url !== "/assignments") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(FIXTURES, "assignments.html")));
  });
  const teamsOrigin = `http://127.0.0.1:${teamsSrv.address().port}`;
  assignOrigin      = `http://127.0.0.1:${assignSrv.address().port}`;

  // ── Test-only extension copy ──────────────────────────────────────────────
  const tmp    = fs.mkdtempSync(path.join(os.tmpdir(), "tp-e2e-"));
  const extDir = path.join(tmp, "extension");
  fs.cpSync(path.join(ROOT, "extension"), extDir, { recursive: true });

  const manifestPath = path.join(extDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.content_scripts[0].matches.push(`${teamsOrigin}/*`);
  manifest.content_scripts[1].matches.push(`${assignOrigin}/*`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const msgPath = path.join(extDir, "core", "messages.js");
  patch(msgPath, 'const TEAMS_ORIGINS = new Set([', `const TEAMS_ORIGINS = new Set([\n  "${teamsOrigin}",`);
  patch(msgPath, /const ASSIGNMENTS_ORIGIN = "[^"]+";/, `const ASSIGNMENTS_ORIGIN = "${assignOrigin}";`);

  // ── Browser with the unpacked extension ───────────────────────────────────
  const userDir = path.join(tmp, "profile");
  const context = await chromium.launchPersistentContext(userDir, {
    channel: "chromium", // new headless; required for extensions in headless mode
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });

  let passed = 0, failed = 0;
  const run = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
  };

  try {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    console.log(`\nextension (unpacked, id ${extId}):`);

    // Auto-sync would start clicking the mock page 20 s after load.
    await sw.evaluate(() => chrome.storage.local.set({ "tp:settings:autoSync": false }));

    const errors = [];
    const teams = await context.newPage();
    teams.on("pageerror", (e) => errors.push(e.message));
    await teams.goto(`${teamsOrigin}/teams`);
    // Hostile post added like a real new message.
    await teams.evaluate((subject) => {
      const msg = document.createElement("div");
      msg.setAttribute("data-tid", "channel-pane-message");
      const sub = document.createElement("div");
      sub.setAttribute("data-tid", "subject-line");
      sub.textContent = subject;
      const body = document.createElement("div");
      body.setAttribute("data-tid", "message-body");
      body.textContent = "Quiz on 5 October 2026";
      msg.append(sub, body);
      document.body.appendChild(msg);
    }, XSS);

    const readState = () => sw.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const cls = all["tp:v1:class-index"] || [];
      const posts = cls.reduce((n, c) => n + Object.keys(all[`tp:v1:posts:${c}`] || {}).length, 0);
      const assigns = cls.reduce((n, c) => n + (all[`tp:v1:assignments:${c}`] || []).length, 0);
      return { cls, posts, assigns };
    });

    await run("content scripts → service worker → chrome.storage.local (posts + assignments)", async () => {
      const s = await waitFor(async () => {
        const st = await readState();
        return st.posts >= 3 && st.assigns >= 4 ? st : null;
      }, 30000, "3 posts and 4 assignments in storage");
      assert.deepStrictEqual(s.cls, ["Summer_2026_CSE 312 (V1)_ 232_D4"]);
    });

    await run("badge shows the new-post count", async () => {
      // Posts arrive in debounced batches; wait for the settled count.
      let text = "";
      await waitFor(async () => (text = await sw.evaluate(() => chrome.action.getBadgeText({}))) === "3",
        10000, `badge "3" (last seen "${text}")`).catch((e) => { throw new Error(`${e.message}; last badge "${text}"`); });
    });

    await run("popup renders posts + tasks; hostile text literal; no http(s) requests", async () => {
      const popup = await context.newPage();
      const requests = [];
      popup.on("request", (r) => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
      let dialogs = 0;
      popup.on("dialog", (d) => { dialogs++; d.dismiss().catch(() => {}); });
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await popup.waitForSelector("#feedContainer:not(.hidden)", { timeout: 10000 });
      const text = await popup.locator("#classList").textContent();
      for (const s of ["CT-3 Schedule", XSS]) assert.ok(text.includes(s), `popup missing: ${s}`);
      assert.strictEqual(await popup.locator("#countAssignments").textContent(), "3", "Upcoming + Past due tasks");
      assert.strictEqual(await popup.locator("img").count(), 0, "an <img> was created");
      await popup.waitForTimeout(500);
      assert.strictEqual(dialogs, 0, "a dialog fired");
      assert.deepStrictEqual(requests, [], `popup made requests: ${requests.join(", ")}`);
      await popup.close();
    });

    // Real chrome.tabs / chrome.windows with the shipped permissions (no "tabs"):
    // the popup page is in front, so the Teams tab is hidden until the popup
    // switches to it; the content script then runs the pending command.
    await run("clicking an announcement switches to the Teams tab and outlines the post", async () => {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await popup.waitForSelector("#feedContainer:not(.hidden)", { timeout: 10000 });
      await popup.bringToFront();
      await popup.click("#tabNotices");
      await popup.locator(".notice-card", { hasText: "Lab Cancelled" }).click();
      await waitFor(() => teams.evaluate(() => document.visibilityState === "visible"), 10000, "Teams tab in front");
      await waitFor(() => teams.evaluate(() => {
        const m = Array.from(document.querySelectorAll('[data-tid="channel-pane-message"]'))
          .find((x) => /Lab Cancelled/.test(x.textContent));
        return m && m.style.outline.includes("solid");
      }), 10000, "post outlined");
      if (!popup.isClosed()) await popup.close();
    });

    await run("no page errors from the content scripts", async () => {
      assert.deepStrictEqual(errors, []);
    });
  } finally {
    await context.close();
    teamsSrv.close();
    assignSrv.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  console.log(`\nE2E: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  console.log("NOTE: mock pages, not the live Teams DOM.");
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("Fatal:", err.stack || err); process.exit(1); });
