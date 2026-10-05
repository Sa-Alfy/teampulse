// Self-host build only: a server bar in the popup (status, Push now, Connect/Settings).
// The popup's own Sync button still syncs Teams; every sync is pushed automatically.
"use strict";

(() => {
  const area = chrome.storage.local;
  const anchor = document.getElementById("syncStatus");
  if (!anchor) return;

  const bar = document.createElement("div");
  bar.id = "tpshBar";
  bar.setAttribute("role", "status");
  Object.assign(bar.style, {
    display: "flex", alignItems: "center", gap: "8px", padding: "4px 12px",
    fontSize: "12px", borderBottom: "1px solid rgba(127,127,127,.25)",
  });
  const text = document.createElement("span");
  text.style.flex = "1";
  text.style.overflow = "hidden";
  text.style.textOverflow = "ellipsis";
  text.style.whiteSpace = "nowrap";
  const push = document.createElement("button");
  const cfg = document.createElement("button");
  for (const b of [push, cfg]) { b.type = "button"; b.className = "icon-btn"; b.style.fontSize = "12px"; }
  push.textContent = "Push now";
  push.title = "Send your synced data to your server now";
  bar.append(text, push, cfg);
  anchor.after(bar);

  const ERR = { permission_missing: "permission removed", key_rejected: "key rejected", network: "server unreachable", internal: "push failed" };

  function ago(ms) {
    const m = Math.max(0, Math.floor(ms / 60e3));
    return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
  }

  function render() {
    area.get(["tp:sh:server", "tp:sh:status"], (d) => {
      const srv = d["tp:sh:server"];
      const st = d["tp:sh:status"];
      cfg.textContent = srv ? "Settings" : "Connect";
      cfg.title = srv ? "Server settings" : "Connect to your TeamsPulse server";
      push.style.display = srv ? "" : "none";
      if (!srv) text.textContent = "Server: not connected";
      else if (!st) text.textContent = "Server: connected · waiting for a sync";
      else if (st.ok) text.textContent = `Server ✓ pushed ${ago(Date.now() - st.at)}${st.events ? ` · ${st.events} change(s)` : ""}`;
      else text.textContent = `Server ✗ ${ERR[st.error] || st.error} · ${ago(Date.now() - st.at)}`;
    });
  }

  cfg.addEventListener("click", () => chrome.runtime.openOptionsPage());
  push.addEventListener("click", () => {
    text.textContent = "Server: pushing…";
    area.set({ "tp:sh:cmd": { push: Date.now() } });
  });
  chrome.storage.onChanged.addListener((ch, a) => { if (a === "local" && (ch["tp:sh:status"] || ch["tp:sh:server"])) render(); });
  render();
})();
