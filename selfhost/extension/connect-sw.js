/**
 * selfhost/extension/connect-sw.js — Self-host build only. Pushes stored
 * Teams data to the student's own Worker after each sync.
 *
 * - Watches chrome.storage for tp:v1:{assignments,posts,last-sync}:<class>
 *   changes (written by the unchanged store code) and marks classes dirty
 *   (persisted, so a sleeping service worker loses nothing).
 * - Flushes 15 s after the last change, on a 15-min alarm, or on "Push now".
 * - Sends only to the server the student entered, only with the host
 *   permission they granted for it, with credentials omitted. The only
 *   secret sent is their own ingest key. Nothing from Teams' cookies or
 *   tokens is ever read.
 * Loaded by background-selfhost.js after background.js (one global scope:
 * everything is inside this IIFE).
 */

(() => {
  "use strict";

  const K = { server: "tp:sh:server", status: "tp:sh:status", dirty: "tp:sh:dirty", cmd: "tp:sh:cmd", pushed: "tp:sh:pushed:" };
  const DATA_PREFIXES = ["tp:v1:assignments:", "tp:v1:posts:", "tp:v1:last-sync:"];
  const ALARM = "tp-sh-push";
  const DEBOUNCE_MS = 15e3;
  const MAX_PUSHED = 2000;

  const area = chrome.storage.local;
  const sget = (keys) => new Promise((r) => area.get(keys, r));
  const sset = (obj) => new Promise((r) => area.set(obj, r));
  const sdel = (keys) => new Promise((r) => area.remove(keys, r));

  let timer = null;
  let running = null;

  function classOf(key) {
    for (const p of DATA_PREFIXES) if (key.startsWith(p)) return key.slice(p.length);
    return null;
  }

  async function markDirty(classes) {
    const cur = (await sget([K.dirty]))[K.dirty] || [];
    await sset({ [K.dirty]: [...new Set([...cur, ...classes])].slice(-500) });
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush(); }, ms);
  }

  async function setStatus(s) {
    await sset({ [K.status]: { ...s, at: Date.now() } });
  }

  async function pushAll() {
    const srv = (await sget([K.server]))[K.server];
    if (!srv || !srv.url || !srv.key) return { skipped: "not_connected" };
    const granted = await chrome.permissions.contains({ origins: [`${srv.url}/*`] });
    if (!granted) { await setStatus({ ok: false, error: "permission_missing" }); return { skipped: "permission" }; }

    const dirty = (await sget([K.dirty]))[K.dirty] || [];
    if (!dirty.length) return { skipped: "nothing" };
    const report = (await sget(["tp:v1:capture-report"]))["tp:v1:capture-report"] || null;
    const syncId = TPSH.newSyncId(crypto.getRandomValues(new Uint8Array(8)));
    let events = 0;
    let calls = 0;
    const left = new Set(dirty);

    for (const cn of dirty) {
      const keys = [`tp:v1:assignments:${cn}`, `tp:v1:posts:${cn}`, `tp:v1:last-sync:${cn}`, K.pushed + cn];
      const d = await sget(keys);
      const assignments = d[keys[0]];
      const posts = d[keys[1]] || {};
      if (!Array.isArray(assignments) && !Object.keys(posts).length) { left.delete(cn); continue; }
      const pushed = new Set(d[keys[3]] || []);
      const { payloads, postIds } = TPSH.buildPayloads(
        { className: cn, assignments: assignments || [], posts, lastSync: d[keys[2]] || null },
        report, pushed, syncId, TP.transformAssignment);
      for (let i = 0; i < payloads.length; i++) {
        let res;
        try {
          res = await fetch(`${srv.url}/api/ingest`, {
            method: "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
            headers: { authorization: `Bearer ${srv.key}`, "content-type": "application/json" },
            body: JSON.stringify(payloads[i]), signal: AbortSignal.timeout(20e3),
          });
        } catch (e) {
          await sset({ [K.dirty]: [...left] });
          await setStatus({ ok: false, error: "network", calls });
          return { error: "network" };
        }
        calls++;
        if (!res.ok) {
          await sset({ [K.dirty]: [...left] });
          await setStatus({ ok: false, error: res.status === 401 ? "key_rejected" : `http_${res.status}`, calls });
          return { error: res.status };
        }
        const body = await res.json().catch(() => ({}));
        events += Number(body.events) || 0;
        for (const id of postIds[i]) pushed.add(id);
        await sset({ [K.pushed + cn]: [...pushed].slice(-MAX_PUSHED) });
      }
      left.delete(cn);
      await sset({ [K.dirty]: [...left] });
    }
    await setStatus({ ok: true, classes: dirty.length, calls, events });
    return { ok: true, calls, events };
  }

  function flush() {
    if (!running) running = pushAll().catch(async () => { await setStatus({ ok: false, error: "internal" }); }).finally(() => { running = null; });
    return running;
  }

  async function markAllAndFlush() {
    const index = (await sget(["tp:v1:class-index"]))["tp:v1:class-index"] || [];
    await markDirty(index);
    return flush();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[K.cmd] && changes[K.cmd].newValue) { markAllAndFlush(); return; }
    const classes = Object.keys(changes).map(classOf).filter(Boolean);
    if (classes.length) markDirty(classes).then(() => schedule(DEBOUNCE_MS));
  });

  chrome.alarms.create(ALARM, { periodInMinutes: 15 });
  chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === ALARM) flush(); });

  // Test hook (harmless in production): lets tests await a flush.
  globalThis.TPSH_SW = { flush, markAllAndFlush };
})();
