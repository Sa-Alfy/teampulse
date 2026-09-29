# TeamsPulse — Project Context & Technical Architecture

> **Purpose of this document**: Provide a single source of truth for both developers and AI agents. It documents all proven techniques, selector strategies, dead ends to avoid, current progress, and the exact roadmap.  
> **Agent Directive**: Any AI agent working on this repository **must read this file first** to understand the architecture without re-investigating from scratch, and **must update this file** after implementing new features or discovering new techniques.

---

## 1. Project Overview & Vision

- **Project Name**: TeamsPulse (`teamspulse`)
- **Repository**: `https://github.com/Sa-Alfy/teampulse.git`
- **Core Mission**: Microsoft Teams is bloated, slow, and noisy. Important academic data (Class Test dates, assignment deadlines, teacher announcements, room changes) gets lost in chat threads. TeamsPulse scrapes this data in the background and delivers a clean, unified **Daily Academic Briefing** for university students.
- **Data Target**:
  1. Enrolled Classes / Teams list *(Completed)*
  2. Assignments across Upcoming, Past Due, and Completed tabs *(Completed)*
  3. Channel Posts & Teacher Announcements from `General` channel *(Completed)*
  4. Rule-based Digest Builder — keyword + regex parsing into readable `digest.md` *(Completed)*
  5. Storage & Deduplication Layer (SQLite via built-in `node:sqlite`, `db.js`, `teamspulse.db`) *(Completed)*
  6. Client Interface (Chrome/Edge Extension & Local Express API Server) *(Completed)*
  7. Zero-Install Distribution & Notification Channels *(Planned)*
- **Planned Frontends**: Lightweight Chrome/Edge Extension (Manifest V3, localhost:3457 Express bridge) and optional 1-click portable desktop bundle / Web Store distribution.

---

## 2. Hard-Won Technical Decisions (Do Not Re-Try Dead Ends!)

### ❌ The Microsoft Graph API Dead End
- **What was attempted**: Azure AD application registration (`MyClassApp`) against the
  university tenant. (Client ID and tenant ID intentionally omitted - they identify the
  author's institution and app registration, and this file is public.)
- **Why it failed**:
  - The university tenant enforces a strict blanket policy: **"Users cannot consent to apps"**. Even scopes labeled "Admin consent required: No" (like `User.Read`, `Calendars.Read`) hit an immediate *"Need admin approval"* block screen.
  - Academic scopes (`EduAssignments.Read`, `EduRoster.Read`) require tenant admin approval, which IT departments rarely grant to student developers.
  - The university does **not** sync academic timetables or assignments into Outlook Calendar.
- **Conclusion**: Graph API is unviable for student tools in this tenant.

### ✅ The Playwright Browser Automation Solution
- **Approach**: Automate a real Chromium browser session using the student's own authenticated state.
- **Authentication**: `login-teams.js` launches a visible browser where the student logs in manually and handles university MFA. The session is exported to `auth-teams.json` using `context.storageState()`.
- **Headless Execution**: `teams.js` loads `auth-teams.json` and runs headlessly without requiring login prompts.
- **Security Rule**: `auth-teams.json` is strictly ignored in `.gitignore` and **must never be committed**.

---

## 2.3. Storage & Deduplication Layer (Step 5 — Completed)

### Architecture
- **File**: `db.js` — single-responsibility module, owns all SQLite interaction.
- **Database**: `teamspulse.db` (SQLite, WAL mode) — never committed (listed in `.gitignore`).
- **Dependency**: none - uses Node's built-in `node:sqlite` (`DatabaseSync`).
  Requires **Node 24+** (the module does not exist before 22.5 and warns on 22.x).
  `better-sqlite3` is NOT used and is not in `package.json`.
- **Fingerprint source of truth**: `extension/core/fingerprint.js` → `fingerprintString()`.
  `db.js` imports this function and feeds the result into `crypto.createHash("sha256")`.
  The async `hashPost` in `fingerprint.js` uses SubtleCrypto and produces identical hex.

### Schema — `posts` table

| Column | Type | Description |
|---|---|---|
| `hash` | TEXT PRIMARY KEY | `sha256(rawClassName \0 author \0 timestampIso \0 subject \0 body[:500])` — **five** fields, null-byte separated. Subject and author are included because two posts in one class at one minute with the same body but different subjects are two posts. Versioned via `PRAGMA user_version`. |
| `class_name` | TEXT | **Raw** class name - never the shortened display label |
| `surfaced` | INTEGER | 1 = appeared in a digest (suppresses future runs); 0 = scraped but filtered out as not noteworthy. Only surfaced posts count as seen, so loosening the classifier can still surface the rest. |
| `timestamp_iso` | TEXT | ISO 8601 post timestamp (may be null if Teams didn't parse it) |
| `author` | TEXT | Post author |
| `snippet` | TEXT | First 120 chars of body |
| `seen_at` | TEXT | ISO 8601 timestamp of the run that first stored this record |

### Runtime Flow
1. `build-digest.js` calls `db.ensureSchema()` on startup (idempotent).
2. Every post in `notices.json` is hashed; posts already in the DB are skipped.
3. `digest.md` is written with **new posts only**.
4. New posts are then `INSERT OR IGNORE`-ed into `posts` — done after the write so a crash doesn't silently swallow posts.

### Exported API (`db.js`)
```js
db.ensureSchema()              // CREATE TABLE IF NOT EXISTS — safe on every run
db.hashPost(className, post)   // → hex sha256 string (delegates to fingerprintString)
db.isNew(hash)                 // → boolean (true = never seen)
db.markSeen(hash, {className, post})  // INSERT OR IGNORE
db.close()                     // close connection (useful in tests)
db.DB_PATH                     // absolute path to teamspulse.db
```

---

## 2.4. Client Interface & Local API Server (Step 5 — Completed)

### Architecture: Chrome Extension + Local Express API
Because Manifest V3 Chrome extensions cannot access the local filesystem or SQLite directly, a local Express API serves as the read-only bridge:

```
[Chrome Extension popup]
        ↕ fetch("http://localhost:3457/api/...")
[Local Express API server — server.js]
        ↕ node:sqlite / JSON reads
[teamspulse.db + notices.json + assignments.json + digest-utils.js]
```

### Components
1. **Shared Parser Utility (`digest-utils.js`)**:
   - Houses deterministic parsing rules: `isNoteworthy()`, `classify()`, `extractDate()`, `extractTime()`, `truncate()`, `escapeCell()`, `shortClassName()`.
   - Shared between `build-digest.js` (CLI) and `server.js` (API) — zero code duplication.
2. **Local Express API Server (`server.js`)**:
   - Fixed port `3457` (binds to `127.0.0.1` only).
   - Strict read-only: never launches Playwright or modifies files.
   - Endpoints:
     - `GET /`: Friendly HTML status dashboard with direct links to all endpoints.
     - `GET /api/ping`: Liveness check `{ "ok": true }`.
     - `GET /api/status`: Returns `totalSeen`, `lastRun`, `lastScrape`, `serverTime`.
     - `GET /api/digest`: Assembles classes with categorized notices & assignments.
     - `GET /api/recent?hours=N`: Queries `posts` table from `teamspulse.db`.
   - CORS enabled for `chrome-extension://*` and `http://localhost`.
3. **Chrome / Edge Extension (`extension/`)**:
   - **`manifest.json`**: Manifest V3, zero background service worker overhead, host permissions scoped to `http://localhost:3457/*`. The `storage` permission is required for the persistent collapse state feature.
   - **`popup.html` / `popup.css` / `popup.js`**:
     - **380px** modern dark-theme dashboard (inspired by Linear / Teams dark mode).
     - **Class-Based Categorization**: Notices and assignments grouped per enrolled class (`CSE 312`, `PHY 104`, etc.).
     - **Category Switcher Tabs**: `All (N)` · `📢 Notices (N)` · `📝 Tasks (N)`.
     - **Collapsible Filter Bar**: A 🔍 toggle button (`filterToggleBtn`) in the header shows/hides `.controls-bar` (class filter, time filter, search). Defaults to hidden on popup open; button carries `.active` and `aria-expanded` state. **Implemented** in `popup.html` + `popup.js` (`filterToggleBtn.addEventListener`).
     - **Filters**: Class filter dropdown, Time filter (`All Time` default, `24h`, `48h`, `7d`).
     - **Instant Search**: Real-time filtering across class names, tags, summaries, authors, and task titles.
     - **Persistent Per-Class Collapse State**: Class card expanded/collapsed state is persisted to `chrome.storage.local` keyed by `c.key || c.rawClassName || c.className` (the stable raw class name). Applied synchronously before the card is painted to avoid a flash of wrong state. **Implemented** in `popup.js` (`getStoredCollapseState`, `saveCollapseState`, `collapseStatePromise`).
     - **Live Sync**: Auto-polls every 15s with an animated `● Live` status badge and last sync ticker.
   - **`icons/`**: Native PNG icons (`icon16.png`, `icon48.png`, `icon128.png`).

---

## 2.5. Standalone Extension Architecture (Phase 1 + Phase 2 — `feat/standalone-extension`)

### Goal
Remove the Node.js / Express server dependency entirely. The extension reads Teams DOM directly via content scripts and stores data in `chrome.storage.local`.

### Data Flow

```mermaid
flowchart LR
    CS1["teams-top.js\n(content script, top frame)"] -->|TP_CLASS_CONTEXT\nTP_POSTS| SW["background.js\n(service worker)"]
    CS2["assignments-frame.js\n(content script, all_frames)"] -->|TP_ASSIGNMENTS| SW
    SW -->|handleMessage| MSG["core/messages.js\n(pure validator + router)"]
    MSG -->|ingestPosts\ningestAssignments| STORE["core/store.js\n(createStore + chromeBackend)"]
    STORE -->|chrome.storage.local\ntp:v1:* keys| CHROME[(chrome.storage.local)]
    CHROME -->|getFullState| SHAPE["core/shape.js\n(buildDigest + buildStatus)"]
    SHAPE --> POP["popup.js\n(Phase 3 — not yet wired)"]
```

### Component Breakdown

| File | Role | Phase |
|------|------|-------|
| `extension/core/digest-utils.js` | Dual-export parsing rules — `isNoteworthy`, `classify`, `extractDate`, `extractTime`, `filterRecentPosts` | Phase 1 ✅ |
| `extension/core/fingerprint.js` | `fingerprintString`, async `sha256Hex` via SubtleCrypto | Phase 1 ✅ |
| `extension/core/store.js` | `createStore(backend)`, `chromeBackend`, `memoryBackend`, promise-queued writes, 200-post cap | Phase 1 ✅ |
| `extension/core/shape.js` | `buildDigest`, `buildStatus`, `transformPost`, `transformAssignment`, `compareAssignments` | Phase 1 ✅ |
| `extension/core/messages.js` | Pure `handleMessage(msg, sender, deps)`: origin validation (two Teams origins + assignments origin), size limits (className≤200, posts≤500, assignments≤300, strings≤20k), tab-context join via `chrome.storage.session` | Phase 2 ✅ |
| `extension/content/teams-top.js` | Top-frame content script. Debounced (1500ms) MutationObserver on `[data-tid="channel-pane-message"]`. Sends `TP_CLASS_CONTEXT` + `TP_POSTS`. `getCurrentClassName()` returns **null** — NOT VERIFIED (selector unknown; test hook: `window.__TP_TEST_CLASS`) | Phase 2 ✅ |
| `extension/content/assignments-frame.js` | Cross-origin iframe script. `waitFor()` on MutationObserver. 3-tab loop (Upcoming / Past due / Completed), `extractCards()` with `getClientRects()` visibility filter, 60s cooldown | Phase 2 ✅ |
| `extension/background.js` | `importScripts(...)`, `createStore(chromeBackend())`, session adapter over `chrome.storage.session`, `onMessage` listener, `tabs.onRemoved` cleanup. Phase 1 localhost polling kept for Phase 3 removal. | Phase 2 ✅ |
| `extension/popup.js` | Still wired to localhost:3457 — to be ported in Phase 3 | Phase 3 🔲 |

### Important Constraints
- **Content scripts must not import from `core/`** — they are IIFE-wrapped and self-contained.
- **No new `host_permissions`** — the extension does not fetch any external URLs.
- **`chrome.storage.session`** holds ephemeral per-tab context (`tp:tabctx:<tabId>`); cleared when the tab closes via `tabs.onRemoved`.
- **`getCurrentClassName()` is NOT VERIFIED** — it returns null in production until the user pastes the outerHTML of the Teams class-name element. The DOM test bypasses this with `window.__TP_TEST_CLASS`.
- **Teams origins**: `https://teams.microsoft.com` is confirmed. `https://teams.cloud.microsoft` is **UNVERIFIED** — included in matches/origin checks and flagged in comments.

---



### 3.1. Avoid Fluent UI Atomic Class Names
- **Rule**: Teams v2 uses Fluent UI with generated atomic class hashes (e.g. `f22iagw`, `rfxo2k2`, `___11yg1ik`). These change across builds. **Never use them as selectors.**
- **Safe Anchors**: Use `data-testid`, `data-test`, structural container IDs (`#classroom`), ARIA roles (`[role="treeitem"]`), or semantic BEM-like class fragments (`.fui-CardHeader__header`).

### 3.2. Teams List
- Target: `page.locator('[data-testid="team-name"]')`
- Extracts all enrolled class names on `https://teams.microsoft.com/v2/`.

### 3.3. Class Navigation & The "Assignments" Post Trap
- **The Bug**: Using `page.getByText("Assignments").last()` failed on classes that had active chat posts because bot notifications inside the channel feed contain the text `"Assignments"`, hijacking the click!
- **The Fix**: Target the class-level sidebar navigation specifically:
  ```javascript
  let assignmentsBtn = page.locator('#classroom, [role="treeitem"]').getByText("Assignments", { exact: true }).first();
  if ((await assignmentsBtn.count()) === 0) {
    assignmentsBtn = page.locator('a[role="treeitem"]').filter({ hasText: "Assignments" }).first();
  }
  ```

### 3.4. Assignments Iframe Piercing
- The Assignments app is hosted in an isolated cross-origin iframe:
  `iframe[src*="assignments.edu.cloud.microsoft"]`
- Use Playwright's `page.frameLocator(...)` to query inside it.
- **Tab Buttons**: `[data-test="Upcoming"]`, `[data-test="Past due"]`, `[data-test="Completed"]`.
  - *Note*: Fluent UI creates duplicate hidden elements for sizing; **always use `.first()`**.
- **Cards**: `[data-test="assignment-card"]`
  - Title: `.fui-CardHeader__header`
  - Due Details: `.fui-CardHeader__description`
  - Status Pill: `.fui-CardHeader__action`
  - Card ID attribute contains a stable GUID. **Implemented**: `teams.js` reads it into
    `assignmentId` (see `extractGuid`), alongside a `dueDate` parsed from the card's
    `datetime`/`title` attribute or its description text.

### 3.5. Empty Class State Tolerance (The CSE 304 Fix)
- Classes with 0 assignments never render the "Upcoming" / "Past due" / "Completed" tabs; they display `"No assignments in this class yet"`.
- Waiting only for tab selectors causes a 15–20s timeout failure.
- **The Fix**: Use `Promise.race`:
  ```javascript
  await Promise.race([
    frameLocator.locator('[data-test="Completed"], [data-test="assignment-card"], [data-test="Upcoming"], [data-test="Past due"]').first().waitFor({ timeout: 20000 }),
    frameLocator.getByText("No assignments in this class yet", { exact: false }).first().waitFor({ timeout: 20000 }),
  ]);
  ```
### 3.6. In-App Back Navigation
- Full page reloads (`page.goto(TEAMS_URL)`) between classes are slow (15–30s) and flaky.
- **The Fix**: Click the in-app `page.getByText("All teams").first()` button to return to the grid, with a fallback to full reload only if navigation times out.

### 3.7. Channel Posts & Notices Selectors (Teams v2 Virtual Feed)
- **Lazy Hydration Timing**: Teams v2 renders channel messages inside a virtual scroll runway (`[data-tid="channel-pane-runway"]`). Elements take 5–10 seconds to hydrate from the background sync service. Always poll for `[data-tid="channel-pane-message"]` (up to 12s) rather than relying on an immediate `waitForSelector({ state: 'visible' })`.
- **Message Container**: `[data-tid="channel-pane-message"]`
- **Subheader & Author**:
  - Regular users: `[data-tid="post-message-subheader"]` contains the author's name followed by the timestamp and optional `"Edited"`. Strip the timestamp and `"Edited"` to extract the clean author name.
  - Bots / System Cards: `[data-tid="app-profile-card-trigger"]` is present instead of human avatar for bot notifications (e.g. Assignments bot).
- **Timestamp & ISO Date Parsing**:
  - Element: `[data-tid="timestamp"]`
  - Visible text: e.g. `"8/29 5:20 PM"`.
  - Full attribute: `getAttribute('title')` or `getAttribute('aria-label')` contains the full string: `"Saturday, August 29, 2026 5:20 PM"`.
  - Parseable directly via `Date.parse(timestampFull)` into an exact ISO timestamp (`timestampIso`), enabling 24–48 hour filtering.
- **Subject Line**: `[data-tid="subject-line"]` (present on titled announcements).
- **Announcement Banner**: `[data-tid="team-badge"]` identifies official highlighted announcements with red indicator bars.
- **Attachments & URLs**:
  - File cards: `[data-tid="file-attachment-grid"] [role="gridcell"], [data-tid="file-name"]`.
  - Link previews: `[data-tid="url-preview"]`.
- **Replies**:
  - Container: `[data-tid="response-surface"]`.
  - Header: `[data-tid="reply-message-header"]`.
  - Body: `[data-tid="message-body"]`.
- **Channel Tag Leak Trap**: Teams often appends the channel or class name with non-breaking spaces (`\u00a0`) to the message footer.
  **Implemented** in `scrape-posts.js` (`extractPosts`): whitespace is normalised with `[\u00a0\s]+` FIRST,
  then only a **trailing** occurrence is stripped with an anchored regex. A global `split().join("")` also
  deletes the course code out of the middle of legitimate sentences ("CSE 312 lab will be held...").

---

## 4. Current Project State & Verification

- **Classes Scraped**: 6 out of 6 classes verified end-to-end on live session.
- **Assignments Extracted** (`assignments.json`):
  - `CSE 303`: 3 Completed
  - `PHY 104`: 0 (clean empty read)
  - `CSE 311`: 2 Completed
  - `CSE 312`: 7 Past due, 2 Completed
  - `MAT 103`: 1 Past due
  - `CSE 304`: 0 (detected empty state instantly)
- **Channel Notices Extracted** (`notices.json`) - NOTE: the uniform "4 posts" below was a
  hydration ceiling, not a real count. Teams' virtual scroller only renders what is in the
  runway. `scrape-posts.js` now scrolls back (`--scrollback`, default 5 passes), so these
  numbers should be re-measured.

  - `CSE 303`: 0 (clean empty channel read)
  - `PHY 104`: 4 posts (class reschedule notices, lab announcements, WhatsApp form)
  - `CSE 311`: 4 posts (extra classes, Zoom links, presentation notices)
  - `CSE 312`: 4 posts (hardware session, lab final, 60% marks announcement)
  - `MAT 103`: 4 posts (online class links, presentation group sheets)
  - `CSE 304`: 4 posts (project final links, 70% marks updated announcement)
- **Digest Built** (`digest.md`): Human-readable table per course combining notices + assignments. Generated by `build-digest.js`, zero API calls.
- **Outputs**: Clean JSON saved to `assignments.json` and `notices.json`. Readable digest in `digest.md`.
- **Executables**:
  - `npm run scrape` (`teams.js`): Unified single-pass scraper for both assignments & notices.
  - `npm run scrape:posts` (`scrape-posts.js`): Dedicated channel notices & announcements scraper.
    **Implemented**: `--hours N` applies the window (via `filterRecentPosts`, which now lives in
    `digest-utils.js`); `--scrollback N` walks the virtual list upward for older history;
    `--headed` and `--class` are available on both scrapers.
  - `node build-digest.js`: Rule-based digest builder — reads `notices.json` + `assignments.json`, outputs `digest.md`.

---

## 5. Active Roadmap & Future Architecture

```mermaid
flowchart TD
    Step1["1. Multi-Class Assignments Scraper (✅ Complete)"]
    Step2["2. General Channel Posts & Notices Scraper (✅ Complete)"]
    Step3["3. Rule-Based Digest Builder — keyword/regex parsing, digest.md (✅ Complete)"]
    Step4["4. Storage & Deduplication Layer — SQLite, teamspulse.db (✅ Complete)"]
    Step5["5. Client Interface — Chrome/Edge Extension + Express API (✅ Complete)"]
    Step6["6. Zero-Install Distribution / Pure Extension & Notifications (🔄 Next Up)"]
    
    Step1 --> Step2 --> Step3 --> Step4 --> Step5 --> Step6
```

### Step 5: Client Interface (Chrome Extension) — Design Decision Log
- **Architecture**: Chrome Extension (Manifest V3) + Local Express API (`server.js` on port `3457`).
- **Data Flow**: `notices.json` & `assignments.json` & `teamspulse.db` -> `server.js` -> Extension popup.
- **Categorization**: Grouped by class (`CSE 312`, `PHY 104`, etc.) with subheadings for Notices and Tasks.
- **Tabs**: `All`, `📢 Notices`, `📝 Tasks` with dynamic count badges.
- **Time Filter**: Defaults to "All Time" to prevent semester-wide notices from being hidden, with options for 24h, 48h, 7d.
- **Real-time**: Live polling every 15s with `● Live` status badge and last sync ticker.
- **Instant Search**: Live client-side keyword search across classes, tags, and assignments.
- **Assignment Date Parsing & Sorting**: `server.js` (`transformAssignment`) uses `extractDate` and `extractTime` to build machine-sortable `dueIso` dates. `compareAssignments` sorts assignments ascending (soonest first) per class, guaranteeing undated tasks sort to the end.
- **Due-Soon Visual Urgency**: `extension/popup.js` detects assignments due within 48 hours and attaches `.due-soon`, highlighted in amber via existing `--tag-deadline-*` variables in `extension/popup.css`.
- **Collapsible Filter Bar**: The `.controls-bar` section (class filter, time filter, search) is hidden by default on popup open. A 🔍 `filterToggleBtn` icon button in the header toggles it using the same `.hidden` / `hidden` attribute pattern used by state views elsewhere. The button gets `.active` and `aria-expanded` to reflect open/closed visually. Decision: hide by default because the common use case is a quick scan of cards, not filtering.
- **Persistent Per-Class Collapse State**: After user collapses/expands a class card, the state is written to `chrome.storage.local` as `{ collapsedClasses: { [classKey]: boolean } }`. On next popup open, `getStoredCollapseState()` resolves via `collapseStatePromise`, which is included in the `Promise.all` inside `loadData`. This guarantees the state is fully loaded before `applyFiltersAndRender` runs, so cards are created with the correct `.collapsed` class from the start — no post-render patch, no visible flash. Key is `c.key || c.rawClassName || c.className` (the raw Teams name), which is section-specific and therefore the correct deduplication key (as established by the `shortClassName` collapse test in `test/`).


### Immediate Next Step: Zero-Install Distribution (Step 6)
- Solve the friction barrier for non-technical students:
  1. **Pure Chrome Web Store Extension**: Read directly from `teams.microsoft.com` tab in-browser, bypassing local Node.js / server altogether.
  2. **1-Click Portable Bundle**: Double-click `.bat` launcher with portable embedded Node.js for zero-install friend sharing.
  3. **Push Notifications**: Telegram bot push notifications (Implemented: notify.js, sendTelegram) or native desktop notifications for morning briefings.

---

## 6. Guidelines for Future AI Agents
1. **Always read this file first** before touching code.
2. **Never guess selectors**: Run small diagnostic inspection scripts and view screenshots before modifying scrapers.
3. **Never commit sensitive files**: Double-check `git status` to ensure `auth-teams.json`, `assignments.json`, and debug screenshots are never staged.
4. **Update this document**: Whenever you solve a new selector problem, add a feature, or complete a roadmap milestone, document it here immediately.
5. **Verify before trusting this file.** Instructions elsewhere tell agents to read
   this document and act on it without re-checking. That makes drift here more
   expensive than drift anywhere else in the repo: a wrong line is believed and
   built on. Four sections of this file were once ahead of the code - they
   described the nbsp normalisation, a `better-sqlite3` dependency, hour-filtering
   and assignment-GUID dedup as done when none were in the source.
   **Mark things as "Intended" until they are in the code, then change the word to
   "Implemented" and name the function.** If you find a claim here you cannot find
   in the source, fix the document in the same change.
6. **The dedup layer is the most conservative code in this repo.** It decides what
   the user will never see again. When in doubt, re-show a post: that is a minor
   annoyance, whereas suppressing one loses a CT date permanently. Concretely -
   never key data by `shortClassName()` (it collapses course sections), never
   narrow the hash tuple, and never mark a post seen before it has actually been
   surfaced.

---

## 7. Test Coverage

### Unit Tests (`npm test` — `node --test`, 72 total, all passing)

- **`test/digest-utils.test.js`**: `extractDate` (impossible dates, US-format fallback, ambiguous month words, leap years), `extractTime` (12h, 24h, ranges, dot separators), `classify`, `isNoteworthy`, `filterRecentPosts`, `truncate`, `escapeCell`, `shortClassName`, `sectionLabel`.
- **`test/hash-post.test.js`**: `db.hashPost` parity, fingerprint tuple collision checks, body capping at 500 chars.
- **`test/assignment-sort.test.js`**: assignment date extraction (`dueDate`, `dueTime`, `dueIso`) and ascending sort verification (soonest first, undated tasks last).
- **`test/notify.test.js`**: Telegram bot push chunking (4000 char limit), unconfigured env safety, redacting bot tokens.
- **`test/core.test.js`**: Phase 1 browser-safe core tests: fingerprint parity (`async hashPost === db.hashPost` across sample posts), store deduplication, filtered-out post non-burning, in-batch duplicate handling, concurrent ingest safety, shape data structures, newHours clamping, health staleness thresholds, and assignment sorting.
- **`test/messages.test.js`** *(Phase 2)*: 12 tests covering `handleMessage` — valid `TP_CLASS_CONTEXT` (both Teams origins), valid `TP_POSTS` ingested into store, wrong origin rejected for all three message types, oversize `className` (>200 chars) rejected, `posts` array >500 rejected, `assignments` array >300 rejected, string field >20,000 chars rejected, `TP_ASSIGNMENTS` without prior class context dropped, `TP_ASSIGNMENTS` with context lands under correct class.

### DOM / Integration Tests (`npm run test:dom` — Playwright headless Chromium, 4 tests, all passing)

> **Note**: These fixtures prove port logic only — they do not verify compatibility with the live Teams DOM.

- `teams-top.js` fixture with 2 posts → one `TP_POSTS` message with 2 posts
- `teams-top.js` 3rd post added dynamically → new `TP_POSTS` fires after the 1500ms debounce
- `teams-top.js` empty post list → no `TP_POSTS` message sent
- `assignments-frame.js` 3-tab fixture → one `TP_ASSIGNMENTS` with all cards from all three tabs; original tab restored

