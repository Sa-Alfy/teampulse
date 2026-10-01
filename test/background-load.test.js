"use strict";

/**
 * Loads extension/background.js the way Chrome does: every importScripts()
 * file runs in ONE shared global scope, so a top-level const/let declared in
 * two files is a SyntaxError that kills the service worker (status code 15).
 * Per-file require() in the other tests cannot catch that.
 */

const test   = require("node:test");
const assert = require("node:assert");
const fs     = require("fs");
const path   = require("path");
const vm     = require("vm");

const EXT = path.join(__dirname, "..", "extension");

function loadWorker() {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const local = {};
  const calls = { badge: [], alarmsCreated: [], alarmsCleared: [] };

  const chrome = {
    runtime: { id: "x", lastError: undefined, onMessage: on("onMessage"),
               onInstalled: on("onInstalled"), onStartup: on("onStartup") },
    tabs:    { onRemoved: on("onRemoved") },
    alarms:  { onAlarm: on("onAlarm"),
               create: (n, o) => calls.alarmsCreated.push([n, o]),
               clear:  (n) => calls.alarmsCleared.push(n) },
    action:  { setBadgeText: async (o) => { calls.badge.push(o.text); },
               setBadgeBackgroundColor: async () => {} },
    storage: {
      onChanged: on("storageOnChanged"),
      local: {
        get: (keys, cb) => { const o = {}; for (const k of keys || Object.keys(local)) if (k in local) o[k] = local[k]; cb(o); },
        set: (obj, cb) => { Object.assign(local, obj); cb(); },
        remove: (keys, cb) => { for (const k of [].concat(keys)) delete local[k]; cb(); },
      },
      session: { get: (k, cb) => cb({}), set: (o, cb) => cb(), remove: (k, cb) => cb() },
    },
  };

  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout, crypto: globalThis.crypto, TextEncoder });
  ctx.globalThis = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) {
      vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  return { ctx, listeners, calls, local };
}

test("background.js + importScripts load in one global scope without redeclaration errors", () => {
  const { listeners } = loadWorker();
  for (const name of ["onMessage", "onInstalled", "onStartup", "onAlarm", "onRemoved", "storageOnChanged"]) {
    assert.strictEqual(typeof listeners[name], "function", `${name} listener not registered`);
  }
});

test("onInstalled clears the legacy poll alarm, creates the 30-min alarm and sets the badge", async () => {
  const { listeners, calls } = loadWorker();
  listeners.onInstalled();
  await new Promise((r) => setTimeout(r, 20));
  // JSON round-trip: objects built inside the vm context have foreign prototypes.
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepStrictEqual(plain(calls.alarmsCleared), ["teamspulse-badge-poll"]);
  assert.deepStrictEqual(plain(calls.alarmsCreated), [["teamspulse-badge-refresh", { periodInMinutes: 30 }]]);
  assert.deepStrictEqual(plain(calls.badge), [""], "empty store → empty badge");
});
