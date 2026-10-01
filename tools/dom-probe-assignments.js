/**
 * tools/dom-probe-assignments.js — run inside the ASSIGNMENTS iframe.
 * In DevTools → Console, switch the context dropdown (top-left, "top") to the
 * frame "assignments.edu.cloud.microsoft", then paste this. Read-only: no
 * network, no clicks. Prints JSON and copies it (copy()).
 *
 * Reports for up to 5 assignment cards: the elements inside the card that
 * carry text (tag, data-test, Fluent fui-* classes, aria/title/datetime,
 * text ≤80 chars), and the nearest preceding date-like heading with its
 * attributes and how it relates to the card. Also tab and heading summaries.
 */
(() => {
  "use strict";
  const cut = (s, n = 80) => {
    const t = String(s || "").replace(/[\s ]+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  const desc = (el) => {
    const o = { tag: el.tagName.toLowerCase() };
    for (const a of ["role", "data-test", "data-tid", "data-testid", "aria-level", "aria-label", "title", "datetime", "id"]) {
      if (el.hasAttribute(a)) o[a] = cut(el.getAttribute(a));
    }
    const fui = Array.from(el.classList).filter((c) => /^fui-|^ms-/.test(c));
    if (fui.length) o.fui = fui.join(" ");
    return o;
  };
  const ownText = (el) => cut(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
  const DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b|\b(today|tomorrow|yesterday)\b/i;

  const cardSel = '[data-test="assignment-card"]';
  const cards = Array.from(document.querySelectorAll(cardSel));

  function nearestDateHeading(card) {
    // Walk up the ancestors; at each level scan previous siblings (closest first).
    let node = card, depth = 0;
    while (node && node !== document.body && depth < 8) {
      let sib = node.previousElementSibling, hops = 0;
      while (sib && hops < 40) {
        const t = cut(sib.textContent, 120);
        if (DATE_RE.test(t) && t.length <= 60 && !sib.matches(cardSel) && !sib.querySelector(cardSel)) {
          const inner = Array.from(sib.querySelectorAll("*")).filter((e) => ownText(e)).slice(0, 4)
            .map((e) => ({ ...desc(e), text: ownText(e) }));
          return { ancestorLevelsUp: depth, siblingHops: hops + 1, heading: { ...desc(sib), text: t }, headingParts: inner };
        }
        sib = sib.previousElementSibling; hops++;
      }
      node = node.parentElement; depth++;
    }
    return null;
  }

  const samples = cards.slice(0, 5).map((card) => {
    const parts = [];
    for (const el of card.querySelectorAll("*")) {
      const t = ownText(el);
      if (t || el.hasAttribute("datetime") || el.hasAttribute("title")) parts.push({ ...desc(el), text: t });
      if (parts.length >= 15) break;
    }
    const anc = [];
    let p = card.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) anc.push(desc(p));
    return { card: desc(card), parts, ancestors: anc, dateHeading: nearestDateHeading(card) };
  });

  const report = {
    probe: "teamspulse-assignments-probe/1",
    origin: location.origin,
    pathMasked: location.pathname.split("/").map((s) => (/[0-9a-f]{8}-|[A-Za-z0-9_-]{20,}/i.test(s) ? "<id>" : s)).join("/"),
    cardCount: cards.length,
    tabs: Array.from(document.querySelectorAll("[role='tab']")).slice(0, 6).map((t) => ({ ...desc(t), text: cut(t.textContent) })),
    samples,
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (typeof copy === "function") { copy(json); console.log("(copied to clipboard)"); }
  return report;
})();
