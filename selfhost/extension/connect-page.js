// Connect page (self-host build only). All output via textContent.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const area = chrome.storage.local;
  const sget = (keys) => new Promise((r) => area.get(keys, r));
  const sset = (obj) => new Promise((r) => area.set(obj, r));
  const sdel = (keys) => new Promise((r) => area.remove(keys, r));

  const ERRORS = {
    permission_missing: "Permission for the server was removed. Click Connect again.",
    key_rejected: "The server rejected the key. Paste the current key (/rotatekey in Telegram makes a new one).",
    network: "Could not reach the server. It will retry automatically.",
    internal: "Push failed unexpectedly. It will retry automatically.",
  };

  function show(text, cls = "") {
    const el = $("status");
    el.textContent = text;
    el.className = cls;
  }

  function ago(ms) {
    const m = Math.floor(ms / 60e3);
    return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
  }

  async function render() {
    const d = await sget(["tp:sh:server", "tp:sh:status"]);
    const srv = d["tp:sh:server"];
    const st = d["tp:sh:status"];
    if (srv) { $("url").value = srv.url; $("key").value = ""; $("key").placeholder = "saved (paste a new key to replace it)"; }
    if (!srv) return show("Not connected.");
    if (!st) return show(`Connected to ${srv.url}.\nWaiting for the next sync.`, "good");
    if (st.ok) return show(`Connected to ${srv.url}.\nLast push ${ago(Date.now() - st.at)}: ${st.classes} class(es), ${st.events} change(s) found.`, "good");
    show(`Connected to ${srv.url}.\nLast push failed ${ago(Date.now() - st.at)}: ${ERRORS[st.error] || st.error}`, "bad");
  }

  $("connect").addEventListener("click", async () => {
    const url = TPSH.normalizeServer($("url").value);
    if (!url) return show("Enter your server address, like https://teamspulse.yourname.workers.dev", "bad");
    const saved = (await sget(["tp:sh:server"]))["tp:sh:server"];
    const key = $("key").value.trim() || (saved && saved.url === url ? saved.key : "");
    if (!/^tp_[A-Za-z0-9_-]{20,128}$/.test(key)) return show("Paste the extension key from your server's setup page (starts with tp_).", "bad");
    const granted = await chrome.permissions.request({ origins: [`${url}/*`] });
    if (!granted) return show("Permission not granted, so nothing can be sent.", "bad");
    show("Checking…");
    let res;
    try {
      res = await fetch(`${url}/api/events?limit=1`, { headers: { authorization: `Bearer ${key}` }, credentials: "omit", cache: "no-store" });
    } catch {
      return show("Could not reach that server. Check the address.", "bad");
    }
    if (res.status === 401) return show("The server rejected this key.", "bad");
    if (res.status === 503) return show("That server is not set up yet. Open /setup on it first.", "bad");
    if (!res.ok) return show(`Server answered ${res.status}.`, "bad");
    await sset({ "tp:sh:server": { url, key } });
    await sset({ "tp:sh:cmd": { push: Date.now() } });
    show("Connected. Sending your stored data…", "good");
  });

  $("push").addEventListener("click", async () => {
    await sset({ "tp:sh:cmd": { push: Date.now() } });
    show("Pushing…");
  });

  $("disconnect").addEventListener("click", async () => {
    const srv = (await sget(["tp:sh:server"]))["tp:sh:server"];
    const all = await sget(null);
    await sdel(Object.keys(all).filter((k) => k.startsWith("tp:sh:")));
    if (srv) await chrome.permissions.remove({ origins: [`${srv.url}/*`] }).catch(() => {});
    $("url").value = ""; $("key").value = "";
    show("Disconnected. Nothing will be sent.");
  });

  chrome.storage.onChanged.addListener((ch, a) => { if (a === "local" && (ch["tp:sh:status"] || ch["tp:sh:server"])) render(); });
  render();
})();
