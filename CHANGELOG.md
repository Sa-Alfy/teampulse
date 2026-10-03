# Changelog

## 0.6.4 (unreleased): assignments capture fixes

Proven **offline only**: against a new Teams-assignments mock (`test-dom/fixtures/assignments-mock.html`,
16-scenario matrix in `test-dom/assignments-matrix.js`) and unit tests. **Assignment capture is still unverified on real Teams.**

### Fixed
- **Zero assignments captured (0.6.1–0.6.3).** The "list loaded" check matched "No assignments" anywhere on the page. When Upcoming was empty, its empty-state text was still on screen after the switch, so Past due and Completed were read before their lists arrived. In the mock this captured 0 of 16. A tab is now read only after the previous list is replaced: different card ids, removed nodes, or a new empty state.
- **Hidden Assignments iframe.** A frame that loaded `display:none` saw no cards because no element has client rects without layout. It captured 0 of 18 and never retried. The frame now reports "deferred" and captures when it is shown. It also re-captures on in-frame navigation and when the tab becomes visible, with an in-flight guard, a 60 s cooldown, and a skip while hidden.
- **Stale cross-tab duplicates (0.6.0 export).** The tab already on screen is read first. Cards that were on screen before a switch are dropped from the next tab.
- **Wrong year.** A date without a year now gets the year closest to today, on the side given by the header ("Due … ago" / "Due in …") or by the tab. Completed items no longer get last year's date.
- **Wrong class.** A card that names its class is filed under that class, not under the class whose tab is open. Card classes are checked against classes seen in Teams. Unknown ones go to an "Unmatched" bucket and are flagged in the report.
- **Destructive saves.** Captures are now merged per tab. A tab is replaced only when it was confirmed loaded. A class missing from an all-classes capture is cleared only when all three tabs were ok. A failed capture overwrites nothing.
- **.ics DESCRIPTION glue** ("Due at 11:59 PMCSE 204") is now split, including for already-stored data.

### Added
- **Capture report:** a per-run record with per-tab counts and reason codes, plus the background's accept/reject verdict. It is stored as `tp:v1:capture-report` and shown in the popup under **Capture details** with **Copy report**. It holds numbers and codes only: no titles, no class names, no network.
- "Sync all classes" now finishes with the capture outcome (ok / partial / failed) instead of waiting 120 s.
- `tools/dom-probe-assignments.js` probe/2 records tab `aria-controls`, tab panels, the empty-state wording, and frame visibility.

### Not verified on real Teams
- Whether the real list replaces nodes or keeps them on a tab switch, and the real empty-state wording. Unknown wording makes that tab time out: it is reported and stored items are kept.
- Reads are not yet scoped to the active tab panel. There is no probe evidence yet that `aria-controls` exists.
- Whether Teams keeps the Assignments iframe alive while hidden.
