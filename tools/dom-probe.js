/**
 * tools/dom-probe.js — paste into the DevTools console on an open Teams class
 * channel. Read-only: makes no network calls, changes nothing, sends nothing.
 * Prints a JSON report (and copies it to the clipboard via DevTools copy()).
 *
 * Collected: team-name labels from the left list (<=80 chars) with the
 * role/aria state of their 3 nearest ancestors; short heading-like elements in
 * the main pane OUTSIDE message bodies; document.title; the URL path with
 * ID-like segments masked. Not collected: message text, authors, replies.
 */
(() => {
  "use strict";
  const cut = (s, n = 80) => {
    const t = String(s || "").replace(/[\s ]+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  const STATE_ATTRS = ["role", "aria-selected", "aria-current", "aria-expanded", "tabindex"];
  const HEAD_ATTRS = ["role", "aria-level", "aria-label", "aria-current", "aria-selected", "data-tid", "data-testid"];
  const pick = (el, names) => {
    const out = { tag: el.tagName.toLowerCase() };
    for (const n of names) if (el.hasAttribute(n)) out[n] = cut(el.getAttribute(n));
    return out;
  };
  const MESSAGE = '[data-tid="channel-pane-message"]';

  const teamNames = Array.from(document.querySelectorAll('[data-testid="team-name"]')).map((el) => {
    const ancestors = [];
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) ancestors.push(pick(p, STATE_ATTRS));
    return { text: cut(el.textContent), self: pick(el, STATE_ATTRS), ancestors };
  });

  const main = document.querySelector('[role="main"]') || document.querySelector("main") || document.body;
  const headingSel = 'h1, h2, h3, [role="heading"], [data-tid*="header" i], [data-tid*="title" i], [data-tid*="channel-name" i], [data-testid*="title" i]';
  const headings = [];
  for (const el of main.querySelectorAll(headingSel)) {
    if (el.closest(MESSAGE)) continue; // never read posts
    const text = cut(el.textContent, 200);
    if (!text || text.length > 80) continue;
    headings.push({ text, ...pick(el, HEAD_ATTRS) });
    if (headings.length >= 40) break;
  }

  const maskSeg = (seg) => {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch (_) { /* keep raw */ }
    if (/^19:|@thread|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /[A-Za-z0-9_%=-]{20,}/.test(s) || /\d{6,}/.test(s)) return "<id>";
    return seg;
  };
  const path = location.pathname.split("/").map(maskSeg).join("/");

  const report = {
    probe: "teamspulse-dom-probe/1",
    origin: location.origin,
    path,
    hashPath: location.hash ? location.hash.split(/[/?]/).map(maskSeg).join("/").slice(0, 120) : "",
    title: cut(document.title),
    mainFound: main !== document.body,
    messageNodes: document.querySelectorAll(MESSAGE).length,
    teamNames,
    headings,
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (typeof copy === "function") { copy(json); console.log("(copied to clipboard)"); }
  return report;
})();
