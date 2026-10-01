/**
 * tools/dom-probe-teams-list.js — paste into the DevTools console on the Teams
 * page that shows your class cards (Teams → "Classes" grid). Read-only: no
 * network calls, no clicks, nothing sent. Prints JSON and copies it (copy()).
 *
 * Collects, for elements that look like team/class entries: tag, role,
 * data-tid/data-testid, aria-label (<=80 chars), short text, whether they are
 * clickable, and the same attributes for 3 ancestors. Also the "All teams"
 * back control and the left app-bar "Teams" button. No posts, no people.
 */
(() => {
  "use strict";
  const cut = (s, n = 80) => {
    const t = String(s || "").replace(/[\s ]+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  const ATTRS = ["role", "data-tid", "data-testid", "aria-label", "aria-selected", "aria-expanded", "tabindex", "href"];
  const desc = (el) => {
    const o = { tag: el.tagName.toLowerCase() };
    for (const a of ATTRS) if (el.hasAttribute(a)) o[a] = cut(el.getAttribute(a));
    o.clickable = el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button" ||
      el.hasAttribute("tabindex") || typeof el.onclick === "function";
    return o;
  };
  const withAncestors = (el) => {
    const ancestors = [];
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) ancestors.push(desc(p));
    return { ...desc(el), text: cut(el.textContent), ancestors };
  };

  const sel = [
    '[data-testid*="team" i]', '[data-tid*="team" i]', '[data-tid*="class" i]',
    '[role="gridcell"]', '[role="listitem"]', '[role="treeitem"]', '[role="option"]',
  ].join(",");
  const seen = new Set();
  const candidates = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest('[data-tid="channel-pane-message"]')) continue;
    const text = cut(el.textContent, 200);
    if (!text || text.length > 120) continue;
    const key = `${el.tagName}|${el.getAttribute("data-tid")}|${el.getAttribute("data-testid")}|${el.getAttribute("role")}`;
    const n = seen.has(key) ? 0 : 1;
    seen.add(key);
    if (candidates.filter((c) => c._key === key).length >= 3) continue; // 3 samples per kind
    candidates.push({ _key: key, ...withAncestors(el) });
    if (candidates.length >= 60) break;
  }
  const kinds = {};
  for (const el of document.querySelectorAll(sel)) {
    const key = `${el.tagName.toLowerCase()}|${el.getAttribute("data-tid") || ""}|${el.getAttribute("data-testid") || ""}|${el.getAttribute("role") || ""}`;
    kinds[key] = (kinds[key] || 0) + 1;
  }

  const byText = (re) => Array.from(document.querySelectorAll("button, a, [role='button'], [role='tab'], [role='link']"))
    .filter((el) => re.test(cut(el.textContent) + " " + (el.getAttribute("aria-label") || "")))
    .slice(0, 5).map(withAncestors);

  const report = {
    probe: "teamspulse-teams-list-probe/1",
    origin: location.origin,
    title: cut(document.title),
    kindsCount: kinds,
    candidates: candidates.map(({ _key, ...c }) => c),
    allTeamsControls: byText(/\ball teams\b/i),
    teamsAppBarButtons: byText(/^\s*teams\b/i),
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (typeof copy === "function") { copy(json); console.log("(copied to clipboard)"); }
  return report;
})();
