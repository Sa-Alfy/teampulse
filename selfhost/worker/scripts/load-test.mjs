// Deploy test: sends synthetic payloads to a deployed Worker and prints only
// status codes, counts and client-side round-trip times (never the key).
//   node scripts/load-test.mjs https://<worker>.<subdomain>.workers.dev
// Needs .wrangler/deploy-test/key.txt from scripts/test-key.mjs.
// All data is synthetic: classes "Load Test Class R" (realistic) and
// "Load Test Class W" (worst case), syncIds "loadtest-…".

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{2,5})?$/.test(base)) {
  console.error("usage: node scripts/load-test.mjs https://<worker>.<subdomain>.workers.dev");
  process.exit(2);
}
const keyFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".wrangler", "deploy-test", "key.txt");
const KEY = fs.readFileSync(keyFile, "utf8").trim();
const TABS = ["Upcoming", "Past due", "Completed"];
const DAY = 864e5;
const run = crypto.randomBytes(4).toString("hex");
let seq = 0;
const BASE_DAY = Math.floor(Date.now() / DAY) * DAY + 18 * 3600e3; // fixed for the whole run
const syncId = () => `loadtest-${run}-${String(++seq).padStart(3, "0")}`;
const guid = (cls, i) => crypto.createHash("sha256").update(`${cls}:${i}`).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const postId = (cls, i) => crypto.createHash("sha256").update(`${cls}:post:${i}`).digest("hex");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Realistic: 14 assignments with dueIso (what the self-host extension will send), 5 posts.
function realistic(shift) {
  const cls = "Load Test Class R";
  const now = BASE_DAY;
  return {
    v: 1, syncId: syncId(), class: cls, tabs: TABS, postsCaptured: true,
    assignments: Array.from({ length: 14 }, (_, i) => ({
      assignmentId: guid(cls, i), title: `Synthetic lab ${i + 1}`, tab: TABS[i % 3],
      dueIso: new Date(now + ((i % 7) - 2) * DAY + (i === 0 ? shift * DAY : 0)).toISOString(), details: "Due at 11:59 PM",
    })),
    posts: Array.from({ length: 5 }, (_, i) => ({ id: postId(cls, i), author: "Synthetic Teacher", subject: "", body: `Synthetic notice ${i}: quiz on Sunday.` })),
  };
}

// Worst case within the caps: 300 assignments parsed from raw text (no dueIso), 100 posts.
function worst(shift) {
  const cls = "Load Test Class W";
  return {
    v: 1, syncId: syncId(), class: cls, tabs: TABS, postsCaptured: true,
    assignments: Array.from({ length: 300 }, (_, i) => ({
      assignmentId: guid(cls, i), title: `Synthetic assignment ${i + 1} — section ${i % 5}`, tab: TABS[i % 3],
      dueRaw: `${MONTHS[(i + (i % 10 === 0 ? shift : 0)) % 12]} ${1 + (i % 28)}th Due at 11:59 PM`, details: "Due at 11:59 PM",
    })),
    posts: Array.from({ length: 100 }, (_, i) => ({ id: postId(cls, i), author: "Synthetic Teacher", subject: "",
      body: "Synthetic: class test 2 will be held on Sunday in room 301. ".repeat(4) })),
  };
}

async function send(label, body) {
  const text = JSON.stringify(body);
  const t0 = performance.now();
  const res = await fetch(`${base}/api/ingest`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: text });
  const ms = performance.now() - t0;
  let out = {};
  try { out = await res.json(); } catch { /* non-JSON error page */ }
  console.log(`${label.padEnd(26)} ${res.status}  bytes=${String(text.length).padStart(6)}  events=${out.events ?? "-"}  written=${out.written ?? "-"}  ${out.error ? `error=${out.error}  ` : ""}rtt=${ms.toFixed(0)} ms`);
  return res.status;
}

const health = await (await fetch(`${base}/health`)).json();
console.log("health", JSON.stringify(health));
if (!health.claimed) console.log("note: claimed=false — the key hash is missing or the 60 s cache has not expired yet");

let fails = 0;
const check = (s) => { if (s !== 200) fails++; };
check(await send("realistic baseline", realistic(0)));
for (let i = 1; i <= 10; i++) check(await send(`realistic #${i}${i % 2 ? " (moved)" : ""}`, realistic(i % 2 ? i : 0)));
check(await send("worst baseline", worst(0)));        // 400 new keys → 8 chunked IN-lookups + 403-statement write batch
for (let i = 1; i <= 5; i++) check(await send(`worst #${i} (30 moved)`, worst(i)));
check(await send("worst replay", worst(5)));
console.log(fails ? `FAILED requests: ${fails}` : "all requests 200");
