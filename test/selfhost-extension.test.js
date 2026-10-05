"use strict";

/**
 * S6: the self-host "Connect" build. Proves the store build has no network
 * code, the self-host manifest differs only where intended, the built
 * service worker loads in one global scope, and a push from stored extension
 * state reaches the real Worker code (fake D1) and produces change events.
 */

const test   = require("node:test");
const assert = require("node:assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const vm     = require("vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const { transformManifest, build, SELFHOST_VERSION } = require("../scripts/pack-selfhost-extension");
const push = require("../selfhost/extension/push-core");
const { validateIngest } = require("../selfhost/core/validate");
const { sha256Hex } = require("../extension/core/fingerprint");

const NET = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimportScripts\s*\(\s*["']https?:/;

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// ── store build stays network-free ────────────────────────────────────────

test("store build: no network API anywhere in extension/, CSP connect-src 'none', no host permissions", () => {
  for (const f of jsFiles(EXT)) assert.ok(!NET.test(fs.readFileSync(f, "utf8")), path.relative(ROOT, f));
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  assert.match(m.content_security_policy.extension_pages, /connect-src 'none'/);
  assert.deepStrictEqual(m.permissions, ["alarms", "storage", "unlimitedStorage"]);
  assert.strictEqual(m.host_permissions, undefined);
  assert.strictEqual(m.optional_host_permissions, undefined);
  assert.strictEqual(m.options_ui, undefined);
  assert.strictEqual(m.background.service_worker, "background.js");
});

test("store build: the store zip's file list contains none of the self-host files", () => {
  const { walk } = require("../scripts/pack-extension");
  const files = walk(EXT);
  for (const f of ["background-selfhost.js", "connect.html", "selfhost/push-core.js"]) assert.ok(!files.includes(f), f);
});

// ── self-host manifest and build ──────────────────────────────────────────

test("self-host manifest: only name, version, worker, optional workers.dev access, CSP connect-src and options page change", () => {
  const store = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const m = transformManifest(store);
  assert.strictEqual(m.name, `${store.name} (self-host)`);
  assert.strictEqual(m.version, SELFHOST_VERSION);
  assert.match(SELFHOST_VERSION, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(m.background.service_worker, "background-selfhost.js");
  assert.deepStrictEqual(m.optional_host_permissions, ["https://*.workers.dev/*"]);
  assert.strictEqual(m.host_permissions, undefined, "no host access until the student grants one server");
  assert.deepStrictEqual(m.permissions, store.permissions);
  assert.deepStrictEqual(m.content_scripts, store.content_scripts);
  assert.strictEqual(m.content_security_policy.extension_pages,
    store.content_security_policy.extension_pages.replace("connect-src 'none'", "connect-src https://*.workers.dev"));
  const changed = Object.keys(m).filter((k) => JSON.stringify(m[k]) !== JSON.stringify(store[k])).sort();
  assert.deepStrictEqual(changed, ["background", "content_security_policy", "name", "optional_host_permissions", "options_ui", "version"]);
});

let outDir;
test.before(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-selfhost-ext-"));
  build(outDir);
});
test.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

test("self-host build: store files copied unchanged (popup.html: +1 script tag) and every referenced file exists", () => {
  const { walk } = require("../scripts/pack-extension");
  const storePopup = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
  const builtPopup = fs.readFileSync(path.join(outDir, "popup.html"), "utf8");
  assert.strictEqual(builtPopup.replace(/\r?\n  <script src="selfhost\/popup-connect\.js"><\/script>/, ""), storePopup);
  assert.ok(fs.existsSync(path.join(outDir, "selfhost", "popup-connect.js")));
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(fs.readFileSync(path.join(outDir, "selfhost", "popup-connect.js"), "utf8")));
  for (const f of walk(EXT)) {
    if (f === "manifest.json" || f === "popup.html") continue;
    assert.ok(fs.readFileSync(path.join(outDir, f)).equals(fs.readFileSync(path.join(EXT, f))), f);
  }
  const bg = fs.readFileSync(path.join(outDir, "background-selfhost.js"), "utf8");
  for (const f of bg.match(/"([^"]+\.js)"/g).map((s) => s.slice(1, -1))) assert.ok(fs.existsSync(path.join(outDir, f)), f);
  const html = fs.readFileSync(path.join(outDir, "connect.html"), "utf8");
  for (const [, src] of html.matchAll(/src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(outDir, src)), src);
  assert.ok(!/<script>(?!<)/.test(html.replace(/<script src="[^"]+"><\/script>/g, "")), "no inline script (CSP script-src 'self')");
});

// ── push-core ─────────────────────────────────────────────────────────────

const REPORT = (at, statuses = ["ok", "ok", "ok"]) => ({
  status: statuses.every((s) => s === "ok") ? "ok" : "partial", receivedAt: at,
  tabs: ["Upcoming", "Past due", "Completed"].map((tab, i) => ({ tab, status: statuses[i] })),
});

test("push-core: tabs come from the capture report only when it matches the class's last sync", () => {
  const at = "2026-10-05T06:00:00.000Z";
  assert.deepStrictEqual(push.coveredTabs(REPORT(at), at), ["Upcoming", "Past due", "Completed"]);
  assert.deepStrictEqual(push.coveredTabs(REPORT(at, ["ok", "timeout", "ok"]), at), ["Upcoming", "Completed"]);
  assert.deepStrictEqual(push.coveredTabs(REPORT(at), "2026-10-05T07:00:00.000Z"), [], "stale report");
  assert.deepStrictEqual(push.coveredTabs({ ...REPORT(at), status: "failed" }, at), []);
  assert.deepStrictEqual(push.coveredTabs(null, at), []);
});

test("push-core: payloads pass the server validator, carry dueIso, send only new posts, stay under 128 KiB", async () => {
  const at = "2026-10-05T06:00:00.000Z";
  const posts = {};
  for (let i = 0; i < 60; i++) {
    posts[await sha256Hex(`p${i}`)] = { post: { author: "T", subject: "", body: `বাংলা নোটিশ ${i} 🧪 `.repeat(200), timestampIso: at, isBot: false, attachments: [] }, surfaced: true };
  }
  const ids = Object.keys(posts);
  const cls = {
    className: "Summer_2026_CSE 312 (V1)", lastSync: at, posts,
    assignments: [{ tab: "Upcoming", assignmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", title: "Lab 1", dueRaw: "Oct 10th Due at 11:59 PM", className: "x", status: "" }],
  };
  const transform = () => ({ dueIso: "2026-10-10T17:59:00.000Z" });
  const { payloads, postIds } = push.buildPayloads(cls, REPORT(at), new Set(ids.slice(0, 10)), "ext-0123456789abcdef", transform);
  assert.ok(payloads.length > 1, "chunked");
  assert.strictEqual(postIds.flat().length, 50, "only posts the server has not accepted");
  assert.deepStrictEqual(payloads[0].tabs, ["Upcoming", "Past due", "Completed"]);
  assert.strictEqual(payloads[0].assignments[0].dueIso, "2026-10-10T17:59:00.000Z");
  for (const p of payloads.slice(1)) { assert.deepStrictEqual(p.tabs, []); assert.deepStrictEqual(p.assignments, []); }
  for (const p of payloads) {
    assert.ok(Buffer.byteLength(JSON.stringify(p)) < 128 * 1024);
    const v = validateIngest(p);
    assert.ok(v.ok, v.error);
  }
});

test("push-core: server URL must be an https workers.dev origin", () => {
  assert.strictEqual(push.normalizeServer(" https://teamspulse.me.workers.dev/setup "), "https://teamspulse.me.workers.dev");
  for (const bad of ["http://a.workers.dev", "https://evil.com", "https://a.workers.dev.evil.com", "https://a.workers.dev:8443", "javascript:alert(1)", ""]) {
    assert.strictEqual(push.normalizeServer(bad), null, bad);
  }
});

// ── the built service worker against the real Worker code ─────────────────

function loadBuiltWorker(fetchImpl) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
  const local = {};
  const fire = (changes) => { for (const fn of listeners.storageOnChanged || []) fn(changes, "local"); };
  const chrome = {
    runtime: { id: "x", lastError: undefined, onMessage: on("onMessage"), onInstalled: on("onInstalled"), onStartup: on("onStartup") },
    tabs: { onRemoved: on("onRemoved") },
    alarms: { onAlarm: on("onAlarm"), create() {}, clear() {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    permissions: { contains: async () => true },
    storage: {
      onChanged: on("storageOnChanged"),
      local: {
        get: (keys, cb) => { const o = {}; for (const k of keys === null ? Object.keys(local) : [].concat(keys)) if (k in local) o[k] = local[k]; cb(o); },
        set: (obj, cb) => { Object.assign(local, JSON.parse(JSON.stringify(obj))); cb && cb(); },
        remove: (keys, cb) => { for (const k of [].concat(keys)) delete local[k]; cb && cb(); },
      },
      session: { get: (k, cb) => cb({}), set: (o, cb) => cb(), remove: (k, cb) => cb() },
    },
  };
  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout, crypto: globalThis.crypto, TextEncoder, URL, AbortSignal, fetch: fetchImpl });
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(outDir, f), "utf8"), ctx, { filename: f }); };
  vm.runInContext(fs.readFileSync(path.join(outDir, "background-selfhost.js"), "utf8"), ctx, { filename: "background-selfhost.js" });
  return { ctx, local, fire, listeners };
}

test("built worker: loads background.js + Connect in one scope; store listeners still registered", () => {
  const { ctx, listeners } = loadBuiltWorker(async () => { throw new Error("no network in this test"); });
  for (const n of ["onMessage", "onInstalled", "onAlarm", "storageOnChanged"]) assert.ok(listeners[n] && listeners[n].length >= 1, n);
  assert.strictEqual(listeners.storageOnChanged.length, 2, "store badge listener + Connect listener");
  assert.strictEqual(typeof ctx.TPSH_SW.flush, "function");
});

test("built worker: not connected → no request at all", async () => {
  let calls = 0;
  const { ctx, local } = loadBuiltWorker(async () => { calls++; throw new Error("x"); });
  local["tp:v1:class-index"] = ["C"];
  local["tp:v1:assignments:C"] = [{ tab: "Upcoming", title: "Lab" }];
  await ctx.TPSH_SW.markAllAndFlush();
  assert.strictEqual(calls, 0);
});

test("built worker: a push of stored extension data reaches the Worker; a moved due date becomes an event", async () => {
  const worker = await import("../selfhost/worker/src/index.js");
  const { createD1 } = await import("../selfhost/worker/testing/fake-d1.js");
  const DB = createD1({ migrationsDir: path.join(ROOT, "selfhost", "worker", "migrations") });
  const KEY = "tp_extension_test_key_0123456789abcdef";
  DB.sqlite.prepare("INSERT INTO settings (k, v) VALUES ('ingest_key_hash', ?)").run(await sha256Hex(KEY));
  const SERVER = "https://teamspulse.test-student.workers.dev";
  const seen = [];
  let now = Date.parse("2026-10-05T06:00:00Z");
  const fetchImpl = async (url, init) => {
    seen.push({ url, credentials: init.credentials, headers: Object.keys(init.headers).sort() });
    return worker.handle(new Request(url, init), { DB }, now);
  };
  const { ctx, local } = loadBuiltWorker(fetchImpl);
  const cls = "Summer_2026_CSE 312 (V1)";
  const at = "2026-10-05T05:59:00.000Z";
  const card = (due) => ({ tab: "Upcoming", assignmentId: "0f8fad5b-d9cb-469f-a165-70867728950e", title: "Lab 1", dueRaw: null, dueDate: due, details: "Due at 11:59 PM", status: "" });
  Object.assign(local, {
    "tp:v1:class-index": [cls],
    [`tp:v1:assignments:${cls}`]: [card("2026-10-10")],
    [`tp:v1:last-sync:${cls}`]: at,
    "tp:v1:capture-report": REPORT(at),
    [`tp:v1:posts:${cls}`]: { [await sha256Hex("p1")]: { post: { author: "T", subject: "", body: "Welcome", timestampIso: at, isBot: false, attachments: [] }, surfaced: true } },
    "tp:sh:server": { url: SERVER, key: KEY },
  });

  await ctx.TPSH_SW.markAllAndFlush();
  assert.ok(local["tp:sh:status"].ok, JSON.stringify(local["tp:sh:status"]));
  assert.strictEqual(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM items").get().n, 2);
  assert.deepStrictEqual({ ...DB.sqlite.prepare("SELECT a_baselined, p_baselined FROM classes").get() }, { a_baselined: 1, p_baselined: 1 });

  now += 3600e3;
  const at2 = "2026-10-05T06:59:00.000Z";
  Object.assign(local, { [`tp:v1:assignments:${cls}`]: [card("2026-10-12")], [`tp:v1:last-sync:${cls}`]: at2, "tp:v1:capture-report": REPORT(at2) });
  await ctx.TPSH_SW.markAllAndFlush();
  const events = DB.sqlite.prepare("SELECT type FROM events").all().map((r) => r.type);
  assert.deepStrictEqual(events, ["due_date_changed"]);
  assert.strictEqual(local["tp:sh:status"].events, 1);
  assert.ok(seen.every((s) => s.url === `${SERVER}/api/ingest` && s.credentials === "omit"));
  assert.ok(seen.every((s) => s.headers.join() === "authorization,content-type"), "no other headers");

  local["tp:sh:server"] = { url: SERVER, key: "tp_wrong_key_0123456789abcdefghijkl" };
  local[`tp:v1:last-sync:${cls}`] = "2026-10-05T08:00:00.000Z";
  await ctx.TPSH_SW.markAllAndFlush();
  assert.strictEqual(local["tp:sh:status"].error, "key_rejected");
  assert.deepStrictEqual(local["tp:sh:dirty"], [cls], "kept for retry");
});
