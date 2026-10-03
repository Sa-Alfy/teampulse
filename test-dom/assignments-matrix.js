"use strict";

/**
 * test-dom/assignments-matrix.js — run the REAL assignments-frame.js against
 * the offline mock (fixtures/assignments-mock.html) in a matrix of scenarios
 * and print scenario × result. Proves logic only, NOT the live Teams DOM.
 *
 *   node test-dom/assignments-matrix.js                 # current script
 *   node test-dom/assignments-matrix.js --script <path> # e.g. an older version
 *   node test-dom/assignments-matrix.js --only <name>   # one scenario
 *
 * Exported for test-dom/runner.js: runScenario, SCENARIOS, analyse.
 */

const { chromium } = require("playwright");
const path = require("path");
const fs   = require("fs");

const FIXTURE = path.join(__dirname, "fixtures", "assignments-mock.html");
const DEFAULT_SCRIPT = path.join(__dirname, "..", "extension", "content", "assignments-frame.js");
const TODAY = "2026-10-03T10:00:00";

const STUB = `
(function() {
  window.__msgs = [];
  window.chrome = { runtime: { id: "test-extension-id", lastError: undefined,
    sendMessage: function(msg, cb) {
      window.__msgs.push(JSON.parse(JSON.stringify(msg)));
      if (cb) setTimeout(function() { cb({ ok: true }); }, 0);
    } } };
})();`;

// hidden: the iframe (or the whole tab) starts hidden and is shown after showMs.
const SCENARIOS = [
  { name: "baseline",                 qs: "" },
  { name: "stale 600ms",              qs: "stale=600" },
  { name: "stale 2s + load 3s",       qs: "stale=2000&load=3000" },
  { name: "start Upcoming(empty), stale empty text, load 6s", qs: "start=Upcoming&emptyUpcoming=1&keepEmpty=1&load=6000" },
  { name: "start Upcoming(empty), stale 800 + load 2s", qs: "start=Upcoming&emptyUpcoming=1&keepEmpty=1&stale=800&load=2000" },
  { name: "index-key node reuse, load 1.5s", qs: "reuse=1&load=1500" },
  { name: "virtualized, stale 600",   qs: "virtual=1&stale=600" },
  { name: "no relative text, stale 1.5s", qs: "rel=0&stale=1500" },
  { name: "headers with year",        qs: "year=1&stale=600" },
  { name: "late route 3s",            qs: "route=3000" },
  { name: "live empty wording (all-classes)", qs: "start=Upcoming&emptyUpcoming=1&emptyText=No%20upcoming%20assignments%20right%20now.&stale=800&load=2000" },
  { name: "other empty wording",      qs: "start=Upcoming&emptyUpcoming=1&emptyText=You%27re%20all%20caught%20up&stale=800&load=2000" },
  { name: "tabs missing (DOM drift)", qs: "noTabs=1" },
  { name: "live: opens on Upcoming showing Past due, self-switches 3s", qs: "autoSwitch=3000&emptyUpcoming=1&stale=600" },
  { name: "live: self-switch 300ms", qs: "autoSwitch=300&emptyUpcoming=1&stale=600" },
  { name: "live: empty Upcoming redirects to Completed (1.5s)", qs: "start=Past%20due&emptyUpcoming=1&stale=600&redirect=1500" },
  { name: "iframe display:none, shown at 4s", qs: "stale=600", frame: "display", showMs: 4000 },
  { name: "iframe 0x0, shown at 4s",  qs: "stale=600", frame: "zero", showMs: 4000 },
  { name: "background tab, visible at 4s", qs: "stale=600", docHidden: true, showMs: 4000 },
  { name: "iframe hidden, never shown", qs: "", frame: "display", showMs: 0 },
];

function parentHtml(frameSrc, mode) {
  const style = mode === "zero" ? "width:0;height:0;border:0" : "display:none";
  return `<!DOCTYPE html><html><body style="margin:0">
<iframe id="f" src="${frameSrc}" style="${style}"></iframe>
<script>window.__show = () => { document.getElementById("f").style.cssText = "width:800px;height:600px;border:0"; };</script>
</body></html>`;
}

async function runScenario(browser, sc, scriptPath = DEFAULT_SCRIPT, waitMs = 75_000) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await ctx.clock.setFixedTime(new Date(TODAY));
  await ctx.addInitScript({ content: STUB });
  if (sc.docHidden) {
    await ctx.addInitScript({ content: `
      window.__hidden = true;
      Object.defineProperty(Document.prototype, "hidden", { get: () => window.__hidden });
      Object.defineProperty(Document.prototype, "visibilityState", { get: () => window.__hidden ? "hidden" : "visible" });` });
  }
  const mock = fs.readFileSync(FIXTURE, "utf8");
  await ctx.route("https://assignments.test/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/parent.html") {
      return route.fulfill({ contentType: "text/html", body: parentHtml(`/classes/all/list?${sc.qs}`, sc.frame) });
    }
    return route.fulfill({ contentType: "text/html", body: mock });
  });
  const page = await ctx.newPage();
  const start = sc.qs.includes("route=") ? "/" : "/classes/all/list";
  let target;
  if (sc.frame) {
    await page.goto("https://assignments.test/parent.html");
    target = page.frames().find((f) => f !== page.mainFrame());
    await target.waitForLoadState("domcontentloaded");
  } else {
    await page.goto(`https://assignments.test${start}?${sc.qs}`);
    target = page.mainFrame();
  }
  await target.addScriptTag({ path: scriptPath });
  if (sc.showMs) {
    setTimeout(() => {
      (sc.frame ? page.evaluate(() => window.__show())
        : page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); }))
        .catch(() => {});
    }, sc.showMs);
  }

  // Done when a message carrying cards (or a final report) arrived and the
  // page has been quiet for a while — or at waitMs.
  const deadline = Date.now() + waitMs;
  let msgs = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    msgs = (await target.evaluate(() => window.__msgs || [])).filter((m) => m.type === "TP_ASSIGNMENTS");
    const final = msgs.filter((m) => !(m.report && m.report.status === "deferred"));
    if (final.length) { await page.waitForTimeout(1500); msgs = (await target.evaluate(() => window.__msgs)).filter((m) => m.type === "TP_ASSIGNMENTS"); break; }
    if (sc.frame && !sc.showMs && msgs.length) break; // never shown: the deferred report is the outcome
  }
  const expected = await target.evaluate(() => window.__expected);
  await ctx.close();
  return analyse(sc, msgs, expected);
}

function analyse(sc, msgs, expected) {
  const final = msgs.filter((m) => !(m.report && m.report.status === "deferred"));
  const m = final[final.length - 1] || msgs[msgs.length - 1] || null;
  const got = m ? m.assignments : [];
  const exp = new Map(expected.map((e) => [e.id, e]));
  const seen = new Map();
  let wrongTab = 0, wrongDate = 0, wrongClass = 0, dup = 0;
  for (const a of got) {
    const id = a.assignmentId;
    seen.set(id, (seen.get(id) || 0) + 1);
    if (seen.get(id) === 2) dup++;
    const e = exp.get(id);
    if (!e) continue;
    if (a.tab !== e.tab) wrongTab++;
    else if (a.dueDate !== e.dueDate) wrongDate++;
    if (a.className !== e.className) wrongClass++;
  }
  const missing = expected.filter((e) => !seen.has(e.id)).length;
  const perTab = ["Upcoming", "Past due", "Completed"].map((t) => got.filter((a) => a.tab === t).length).join("/");
  return {
    scenario: sc.name, msgs: msgs.length, cards: got.length, perTab, expected: expected.length,
    missing, dup, wrongTab, wrongDate, wrongClass,
    status: m && m.report ? m.report.status : "-",
    okTabs: m && m.okTabs ? m.okTabs.join(",") : "-",
    reasons: m && m.report ? (m.report.reason || m.report.tabs.map((t) => t.reason).filter(Boolean).join(";")) : "",
    msg: m,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const scriptPath = args.includes("--script") ? path.resolve(args[args.indexOf("--script") + 1]) : DEFAULT_SCRIPT;
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
  const list = SCENARIOS.filter((s) => !only || s.name.includes(only));
  const browser = await chromium.launch();
  const rows = await Promise.all(list.map((sc) => runScenario(browser, sc, scriptPath).catch((e) => ({ scenario: sc.name, error: e.message }))));
  await browser.close();
  console.log(`script: ${path.relative(process.cwd(), scriptPath)}  (today ${TODAY})`);
  console.log("scenario | msgs | cards U/P/C | missing | dup | wrongTab | wrongDate | wrongClass | status | okTabs | reasons");
  for (const r of rows) {
    if (r.error) { console.log(`${r.scenario} | ERROR ${r.error}`); continue; }
    console.log(`${r.scenario} | ${r.msgs} | ${r.cards} ${r.perTab} | ${r.missing}/${r.expected} | ${r.dup} | ${r.wrongTab} | ${r.wrongDate} | ${r.wrongClass} | ${r.status} | ${r.okTabs} | ${r.reasons}`);
  }
}

module.exports = { runScenario, analyse, SCENARIOS };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
