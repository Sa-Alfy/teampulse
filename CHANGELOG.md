# Changelog

## 0.9.0 (2026-10-05, pre-release): self-host server + Connect build

The store extension is unchanged (still 0.7.3, still makes no network requests). 0.9.0 is the **self-host build**: `teamspulse-selfhost-0.9.0.zip`.

- **Your own server** (Cloudflare Workers + D1, free plan): change alerts in Telegram (new assignment, moved due date, submitted, removed, new / tagged posts), reminders 24 h and 3 h before unsubmitted work, a daily digest, commands `/today` `/week` `/due` `/plan` `/done` `/undone` `/digest` `/doctor` `/rotatekey` `/rotatecal` `/deleteall`, and a secret `.ics` calendar feed. Setup: [`docs/selfhost-guide.md`](docs/selfhost-guide.md).
- **Connect build** of the extension: same features as the store build, plus a server bar in the popup (status, **Push now**, **Connect** / **Settings**) and a Connect page. After each sync it sends your assignments and new posts to your server — only to the `*.workers.dev` address you enter, only with the permission you grant for it, without cookies.
- Security: the server never logs into Teams; `/setup` can be claimed only with your bot token; keys and calendar tokens are stored as hashes; Telegram commands only from your paired chat; plain-text messages.
- Tests: `node --test` 203 pass, 1 skipped; `npm run test:e2e` 5/5. Verified live by the owner: setup, Telegram pairing, `/doctor`, cron heartbeat, pushes arriving from the Connect build. **Not yet verified live:** change alerts and reminders on real Teams changes, calendar import, the popup server bar.

## 0.7.3 (2026-10-03, release): logo

- **New logo:** a white pulse line with an amber "new" dot on the popup's indigo→violet tile. It replaces the placeholder diamond icons and the ⚡ in the popup header, which is now inline SVG, not an `<img>`. The source is `assets/logo.svg`, plus `assets/logo-small.svg` with a heavier line for 16/32 px. `npm run build:icons` renders `extension/icons/icon{16,32,48,128}.png` with the Playwright Chromium the project already uses, so there is no new dependency.
- The manifest now has a top-level `icons` entry (16/32/48/128) and a 32 px toolbar icon. Before, `chrome://extensions` showed a generic icon. No permissions changed.
- Tests: `node --test` 103 pass; `npm run test:dom` 47/47; `npm run test:e2e` 5/5. The icon was checked on `chrome://extensions` with the unpacked extension.

## 0.7.2 (2026-10-03, release): assignments sync stuck on Upcoming, card jump stuck behind it

**Confirmed on live Teams by the owner (2026-10-03, one student account):** Sync no longer stalls on the empty Upcoming tab, and clicking an assignment card opens it in Teams. Promoted from pre-release to full release. The owner then also confirmed that opening an older announcement scrolls up and finds the post (0.7.1 feature).

Reported by the owner on live Teams (0.7.1, 2026-10-03, with a screenshot): after a sync or a card click, the Assignments app sat on an empty Upcoming tab. Clicking Past due by hand got it moving.

- **Fixed: empty Upcoming not recognised.** The all-classes view says "No upcoming assignments right now.", but the empty-state check only knew "No assignments". Upcoming waited the full 20 s and was reported as a timeout, which made the capture partial. The check now accepts "No <up to 3 words> assignments" when it starts a text node, such as "No upcoming / past due / completed assignments". It still rejects other text, such as an assignment title containing "no late assignments". New matrix case uses the exact live wording.
- **Fixed: card jump waited behind the capture.** Showing the Assignments app starts a capture that can take a minute or more. The jump only ran afterwards and gave up after 2 minutes, leaving the restored Upcoming tab. A pending jump now runs first and the capture follows.
- The Teams tab now forwards assignment jumps to the frame as `tp:nav:task`. The frame no longer reads the popup command directly, so a click made during a sync can't move the Assignments list mid-capture.
- Tests: `node --test` 103 pass; `npm run test:dom` 47/47 (2 new); `npm run test:e2e` 5/5. Live confirmation: see above.

## 0.7.1 (2026-10-03, pre-release): open any card in Teams

- **Click a card to go there.** An announcement opens its class in your Teams tab, then scrolls to the post and outlines it. If the post isn't loaded yet, it scrolls up for up to 8 rounds to load older posts. An assignment opens the Teams Assignments app. After that app's own capture finishes, it selects the item's tab (Upcoming / Past due), scrolls to the card and outlines it. It does not click the card, because opening it would start a capture of a page with no list. Text is now expanded with **Show more**. Enter on a focused card also opens it.
- **How:** like Sync, the popup stores a command (`tp:nav:cmd`, ignored after 2 minutes). It then brings forward a Teams tab the background already knows from its per-tab class notes, or opens `https://teams.cloud.microsoft/` in a new tab. Only the visible Teams tab acts. Posts are found with the capture's own `extractPosts()`, by timestamp plus subject or body start, so no new selectors were added. Assignment cards are matched by assignment id, else by title (and class, in the all-classes view). If something isn't found, a short text-only note appears on the Teams page.
- **No new permissions:** `chrome.tabs.update` / `create` and `chrome.windows.update` work without the `tabs` permission. This is proven in the e2e test, which loads the unpacked extension.
- **Verified:** `node --test` 103 pass; `npm run test:dom` 45/45 (8 new: post found / body match / not found / stale command / frame card; popup post / task / new tab); `npm run test:e2e` 5/5 (new: real tab switch, post outlined). **Not verified on real Teams** at release: finding older posts by scrolling up, and the Assignments-app card jump. (Both later confirmed on live Teams by the owner with v0.7.2.)

## 0.7.0 (2026-10-03, pre-release): popup redesign for students

- **Overview tab (new default):** a one-line summary ("2 overdue · 1 today"), the next thing due, then everything sorted by urgency: Overdue, Today, Tomorrow, This week, Later, No due date. Assignments overdue for more than 14 days are folded behind "Show N older".
- **Exams and quizzes on the agenda:** dated CT/Quiz, Exam, Presentation, Deadline, Reschedule and Cancelled announcements show up next to assignments. Repeats of the same class, day and kind are merged. One is skipped when an assignment due that day has its title in the post.
- **Countdowns:** "in 2 days", "7h late", with weekday dates instead of ISO dates.
- **Mark done:** ticking an assignment hides it in TeamsPulse only (Teams is not changed). Kept locally under `tp:ui:done`, with a "N marked done" list to undo.
- **Updates tab:** announcements newest first, grouped by Today / Yesterday / This week / Earlier. Unread marks, click to expand, and "Mark all as read" (`tp:ui:read`). Tab counts now show what needs you: attention items, open tasks and unread updates.
- **Class chips** with a stable colour per course replace the class dropdown. The time filter is removed because the urgency groups do its job.
- **Links open (owner-approved):** `https://` URLs in posts are links that open in a new tab (`rel="noopener noreferrer"`, no referrer). Long ones show as "🔗 docs.google.com/…". Other schemes (`http:`, `javascript:` and so on) stay plain text. Rendering a link fetches nothing; a page loads only when the student clicks.
- **ISO dates (owner-approved):** `extractDate` now reads `2026-10-07` / `2026/10/07` (years 19xx–20xx only), so "CT on 2026-10-07" reaches the agenda. This is shared code, so the self-host digest (`build-digest.js` / `server.js`) picks up these dates too.
- **Less chrome:** Sync is a header button, Auto-sync is under ⚙, and the .ics export sits under the list. "Capture details" appears only when the last capture had a problem. The popup has a fixed size with only the list scrolling.
- "Clear stored data" also clears done/read marks. Verified with new popup DOM tests (`npm run test:dom`). **Not checked against real Teams data in a real browser popup.**

## 0.6.7 (2026-10-03, pre-release): only current (unhidden) classes

- Owner's choice: assignments from old or hidden classes are dropped and counted in the report as "not a visited class". A class counts as current once you open it or Sync all classes visits it (Sync skips hidden teams). All-classes cards without a class line are dropped too.
- The "Unmatched" bucket from 0.6.4–0.6.6 is removed. Any stored items in it are cleared on the next capture.
- With no known classes yet (before the first sync), class-named cards are dropped and the report says `no-known-classes`.

## 0.6.6 (2026-10-03, not released separately; included in 0.6.7): completed assignments shown as Upcoming

Live 0.6.5 report (2026-10-03): accepted, 33 cards. Upcoming kept 10 cards, and Completed then de-duplicated the same 10.

- **Fixed:** clicking an empty Upcoming makes Teams show the Completed list while Upcoming still reads selected, then select Completed. A tab's read is now kept only if that tab is still selected afterwards. Otherwise it is `tab-switched-away` and retried once. Reproduced offline: v0.6.5 files 2 Completed cards as Upcoming, v0.6.6 none. **Unverified on real Teams.**
- Upcoming is then not confirmed (partial status), so stored Upcoming items are kept, not cleared. An item that moves to another tab is replaced by its id.

## 0.6.5 (2026-10-03, not released separately; included in 0.6.7): fixes from the owner's first live 0.6.4 capture report

Live report (2026-10-03): status ok, 33 cards sent, **rejected by the background**: "all-classes assignments must carry className". Upcoming read 23 cards, all dropped by the relative-text filter, but was still marked ok.

### Fixed
- **Completed cards lost their class.** Live Completed cards read "Submitted at 1:52 AM", not "Due at …". The class line is now taken after any status/time line (due / submitted / turned in / returned / graded / completed).
- **One classless card rejected the whole batch.** Such cards now go to the Unmatched bucket, and the report counts them (`classless`).
- **Upcoming marked ok with another tab's list.** The app opens on Upcoming while showing the Past due list, then selects Past due by itself. A tab whose every card belongs to another tab is now "skipped" (`list-belongs-to-other-tab`) and retried once by clicking it. The next tab trusts the list already on screen, because Teams may not re-render it.
- Reproduced offline in the mock (`autoSwitch` knob; Completed cards with "Submitted at" lines). The 18-scenario matrix is clean. **Still unverified on real Teams.**

## 0.6.4 (2026-10-03, not released separately; included in 0.6.7): assignments capture fixes

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
