# Chrome Web Store / Edge Add-ons listing — draft (v0.6.0)

Nothing has been submitted. Items marked **DECIDE** need the owner.

## Product name — DECIDE

"TeamsPulse" contains **Teams**, a Microsoft trademark. Store reviewers can reject names that suggest affiliation, and Microsoft can file a complaint. Neutral options (not chosen):

1. **ClassPulse**
2. **Coursework Radar**
3. **StudyBrief**

If the name changes, update `manifest.json` `name`, the popup title and this doc. Mentioning compatibility in the description ("works with Microsoft Teams") is the usual safe form; add "not affiliated with or endorsed by Microsoft".

## Single purpose

Shows students a briefing of new class announcements and upcoming assignments from the Microsoft Teams pages they already have open, stored only on their device.

## Short description (≤132 chars)

> Your Teams classes at a glance: new announcements, exams and upcoming assignments, kept privately in your browser.

## Long description

> See what's new in your classes without scrolling through every channel.
>
> While you use Microsoft Teams in your browser, the extension reads the class posts and assignments the page shows you and turns them into one briefing: new announcements, exam and class-test dates, deadlines, and upcoming or past-due assignments, grouped by class. A toolbar badge counts posts that are new in the last 24 hours. Click "Sync all classes" to have it open each class in your Teams tab once and catch up.
>
> Private by design: everything stays in your browser. No account, no server, no analytics, no network requests. Delete everything anytime with "Clear stored data".
>
> Limitations: it only sees what Teams shows in your browser (it does not read older messages you haven't scrolled to), and if Microsoft changes the Teams page the popup will warn "Scraper may be out of date" until an update ships.
>
> Not affiliated with or endorsed by Microsoft.

## Permission justifications

| Permission | Justification for reviewers |
|---|---|
| `storage` | Saves the captured class posts, assignments and settings in `chrome.storage.local` on the user's device. Also used for a per-tab note of the open class (`chrome.storage.session`). |
| `unlimitedStorage` | A semester of posts across several classes can exceed the default 10 MB quota; without it, captures would start failing silently. Data never leaves the device. |
| `alarms` | Refreshes the toolbar badge every 30 minutes, because "new" is a 24-hour window that ages even when no new data arrives. |
| Content scripts on `https://teams.microsoft.com/*`, `https://teams.cloud.microsoft/*` | Reads the class name, channel posts and class list that Teams displays, to build the briefing. The extension's single purpose depends on this page. |
| Content script on `https://assignments.edu.cloud.microsoft/*` (all frames) | Teams shows assignments inside this iframe; the script reads assignment titles, due dates and status. |

No `host_permissions`, no `tabs`, no `scripting`, no remote code.

## Data-usage answers (Privacy practices tab)

- **Data collected — DECIDE wording.** The extension *processes* "Website content" (posts and assignments on Teams pages) and, inside that content, other people's names. It stores it **only locally** and **transmits nothing**. Store definitions of "collect" vary; the conservative choice is to tick **Website content** (and **Personally identifiable information → name**, because post authors are named) and explain "stored only on the user's device; never transmitted".
- **Certify:** not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used for creditworthiness or lending.
- **Evidence for "nothing transmitted":** extension pages CSP `connect-src 'none'`; the network grep below has no hits outside comments and the sender-origin allowlist; `test-dom/extension-e2e.js` asserts the popup makes no http(s) requests; `test-dom/popup-xss.test.js` asserts no request even with hostile post content.

```
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|eval\(|new Function|https?://" extension --include=*.js --include=*.html
```

Hits are only comments and the origin strings in `extension/core/messages.js` (used to check which page sent a message, not to request anything).

## Privacy policy hosting

The store requires a public URL. Plan: link the repository file
`https://github.com/Sa-Alfy/teampulse/blob/main/PRIVACY.md`. If a nicer URL is wanted, enable GitHub Pages and serve the same file. **DECIDE** which.

## Package

```
npm run pack:extension   →   dist/teamspulse-extension-<version>.zip
```

Runtime files only (15 files at v0.6.0). Upload that zip; do not upload the repo.

## Before submitting — checklist

- [ ] Product name decided (see above); manifest updated
- [x] Live-Teams check of "Sync all classes" (owner, 2026-10-01)
- [ ] Live-Teams check of assignments capture
- [ ] Store screenshots (1280×800) — use mock data or blur classmates' names
- [ ] 128×128 icon is final (current icons are placeholders)
- [ ] Privacy policy URL live
- [ ] Data-usage answers chosen
