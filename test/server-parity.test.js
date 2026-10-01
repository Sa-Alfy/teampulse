"use strict";

/**
 * Golden parity test: the real server.js vs extension/core/shape.js on the
 * same data. server.js hard-codes its port and data paths (__dirname), so it
 * runs from a temp copy with only the PORT line rewritten — self-host code is
 * not modified. The DB is written with the copied db.js (real schema).
 *
 * Ignored: generatedAt / serverTime (wall clock) and the extension-only
 * fields scraper / scraperIssues.
 */

const test   = require("node:test");
const assert = require("node:assert");
const fs     = require("fs");
const os     = require("os");
const net    = require("net");
const path   = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const { hashPost }    = require("../extension/core/fingerprint");
const { buildDigest, buildStatus } = require("../extension/core/shape");

const HOUR = 3600e3;
const now  = Date.now();
const iso  = (msAgo) => new Date(now - msAgo).toISOString();

function post(over) {
  return {
    author: "Dr A", isBot: false, isAnnouncement: false, subject: "", body: "",
    timestamp: "", timestampFull: "", timestampIso: iso(72 * HOUR),
    attachments: [], urlPreviews: [], replyCount: 0, replies: [], ...over,
  };
}

// Two sections of one course (displayName disambiguation) + a single class.
const S1 = "Summer_2026_CSE 312 (V1)_ 232_D4";
const S2 = "Summer_2026_CSE 312 (V2)_ 232_D5";
const C3 = "MAT 103 D1; Summer 2026";

const NOTICES = [
  { className: S1, posts: [
    post({ subject: "CT-2 Schedule", body: "CT-2 will be held on 5 October 2026 at 10:00 AM in room 301." }), // surfaced 1 h ago → new
    post({ subject: "Final exam", body: "Final exam on 20 October 2026.", author: "Dr B" }),                 // surfaced 48 h ago → old
    post({ subject: "", body: "Thanks everyone", author: "Dr C" }),                                         // not noteworthy (surfaced=0 row)
  ] },
  { className: S2, posts: [
    post({ subject: "Notice:", body: "Quiz on 5th Oct", isAnnouncement: true }),                             // surfaced 1 h ago
  ] },
  { className: C3, posts: [] },
];

const ASSIGNMENTS = [
  { className: S1, assignments: [
    { tab: "Upcoming",  title: "Lab 4", details: "", dueRaw: "2026-10-05T23:59:00Z", dueDate: "Oct 5, 2026", status: "" },
    { tab: "Past due",  title: "Lab 3", details: "", dueRaw: "", dueDate: "Sep 20, 2026", status: "" },
    { tab: "Completed", title: "Lab 1", details: "", dueRaw: "", dueDate: "Sep 1, 2026", status: "" },
  ] },
  { className: C3, assignments: [
    { tab: "Upcoming", title: "Problem set (no date)", details: "", dueRaw: "", dueDate: "", status: "" },
  ] },
];

// seen_at per post (by [class, index]); undefined → never written to DB.
const SEEN = { [`${S1}#0`]: iso(1 * HOUR), [`${S1}#1`]: iso(48 * HOUR), [`${S2}#0`]: iso(1 * HOUR) };
const UNSURFACED = [`${S1}#2`];
const LAST_SCRAPE_MS = Math.floor((now - 2 * HOUR) / 1000) * 1000; // fs mtime has 1 s granularity on some FS

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on("error", reject);
  });
}

function copyServer(dir, port) {
  for (const f of ["server.js", "db.js", "digest-utils.js"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, "extension", "core"), path.join(dir, "extension", "core"), { recursive: true });
  const serverPath = path.join(dir, "server.js");
  const src = fs.readFileSync(serverPath, "utf8");
  const patched = src.replace(/^const PORT\s*=\s*3457;/m, `const PORT = ${port};`);
  assert.notStrictEqual(patched, src, "server.js PORT line changed — update this test");
  fs.writeFileSync(serverPath, patched);
}

function writeServerData(dir) {
  fs.writeFileSync(path.join(dir, "notices.json"), JSON.stringify(NOTICES));
  fs.writeFileSync(path.join(dir, "assignments.json"), JSON.stringify(ASSIGNMENTS));
  fs.utimesSync(path.join(dir, "notices.json"), LAST_SCRAPE_MS / 1000, LAST_SCRAPE_MS / 1000);

  const db = require(path.join(dir, "db.js")); // copy → DB lands in the temp dir
  db.ensureSchema();
  for (const c of NOTICES) c.posts.forEach((p, i) => {
    const k = `${c.className}#${i}`;
    if (SEEN[k]) db.markSeen(db.hashPost(c.className, p), { className: c.className, post: p, surfaced: true });
    if (UNSURFACED.includes(k)) db.markSeen(db.hashPost(c.className, p), { className: c.className, post: p, surfaced: false });
  });
  db.close();
  // markSeen stamps "now"; set the intended seen_at values.
  const raw = new DatabaseSync(path.join(dir, "teamspulse.db"));
  const upd = raw.prepare("UPDATE posts SET seen_at = ? WHERE hash = ?");
  for (const c of NOTICES) c.posts.forEach((p, i) => {
    const k = `${c.className}#${i}`;
    if (SEEN[k]) upd.run(SEEN[k], require(path.join(dir, "db.js")).hashPost(c.className, p));
  });
  raw.close();
}

/** The extension store state the content scripts would have produced. */
async function extensionState() {
  const state = { seenHashes: {}, classes: {} };
  const names = new Set([...NOTICES.map((c) => c.className), ...ASSIGNMENTS.map((c) => c.className)]);
  for (const cn of names) state.classes[cn] = { posts: {}, assignments: [], lastSync: null };
  for (const c of NOTICES) {
    for (const [i, p] of c.posts.entries()) {
      const h = await hashPost(c.className, p);
      const k = `${c.className}#${i}`;
      const surfaced = !UNSURFACED.includes(k);
      const seenAt = SEEN[k] || new Date(now).toISOString();
      state.classes[c.className].posts[h] = { post: p, className: c.className, seenAt, surfaced };
      if (surfaced) state.seenHashes[h] = { seenAt, surfaced: true };
    }
  }
  for (const c of ASSIGNMENTS) state.classes[c.className].assignments = c.assignments;
  state.classes[S1].lastSync = new Date(LAST_SCRAPE_MS).toISOString();
  return state;
}

function startServer(dir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, "server.js")], {
      cwd: dir,
      env: { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 10000);
    const onData = (d) => {
      out += d;
      if (out.includes("running on")) { clearTimeout(timer); resolve(child); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => { out += d; });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
}

const strip = (obj, keys) => JSON.parse(JSON.stringify(obj, (k, v) => (keys.includes(k) ? undefined : v)));
const VOLATILE = ["generatedAt", "serverTime", "scraper", "scraperIssues"];

test("server.js and shape.js agree on /api/digest and /api/status for the same data", async (t) => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "tp-parity-"));
  const port = await freePort();
  copyServer(dir, port);
  writeServerData(dir);
  const child = await startServer(dir, port);
  // Windows keeps the files locked until the child has actually exited.
  t.after(async () => {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  const [srvDigest, srvStatus] = await Promise.all([get("/api/digest"), get("/api/status")]);
  const state = await extensionState();
  const extDigest = buildDigest(state, { nowMs: Date.now() });
  const extStatus = buildStatus(state, Date.now());

  // Sanity: the fixture actually exercises new/old/filtered/sections/assignments.
  assert.strictEqual(srvDigest.newPostCount, 2);
  assert.strictEqual(srvDigest.skippedCount, 1);
  assert.strictEqual(srvDigest.classes.length, 3);

  assert.deepStrictEqual(strip(extDigest, VOLATILE), strip(srvDigest, VOLATILE), "digest differs");
  assert.deepStrictEqual(strip(extStatus, VOLATILE), strip(srvStatus, VOLATILE), "status differs");
});
