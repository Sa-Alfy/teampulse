Published policy: https://sa-alfy.github.io/teampulse/privacy.html

# Privacy Policy — TeamsPulse browser extension

_Last updated: 2026-10-03 · applies to extension version 0.7.3_

**What it reads.** While you have Microsoft Teams open (`teams.microsoft.com`, `teams.cloud.microsoft`) and its assignments frame (`assignments.edu.cloud.microsoft`), the extension reads what those pages show: class names, channel posts (author name, subject, text, timestamp, attachment names) and assignment titles, due dates and status. It reads nothing on any other website. "Sync all classes" opens your own classes and the Teams Assignments app in your own Teams tab — when you click it, and (unless you untick **Auto-sync** under ⚙ in the popup) once automatically when Teams opens, at most every 6 hours. Clicking a card in the popup opens that class or the Assignments app in your Teams tab (or opens Teams in a new tab), the same way.

**Where it is stored.** Scraped class names, announcements, assignment titles and dates, settings, and UI marks are kept in your browser's extension storage (`chrome.storage.local`) on your device. A temporary per-tab note of the open class is kept in `chrome.storage.session` and is discarded when the tab closes. Which assignments you tick as done and which announcements you have read are kept in that same extension storage on your device.

**What is sent anywhere.** Nothing. The extension makes no network requests: no servers, no analytics, no tracking, no ads, no remote code. Its pages are locked down with a Content Security Policy of `connect-src 'none'`. Nothing is sold or shared. Web links inside Teams posts are shown as links; a page loads only if you click one, in a new tab, like any link you click yourself.

**Other people's content.** The extension stores whatever the Teams page shows you, which includes posts written by teachers and classmates and their names. It is kept only on your device and is not shown to anyone except you.

**Deleting your data.** Open the extension popup and click **Clear stored data**, or remove the extension; either deletes everything it stored.

**Permissions.** `storage` / `unlimitedStorage` (keep your briefing on your device), `alarms` (refresh the toolbar badge every 30 minutes). No host permissions; content scripts run only on the Teams pages listed above.

The extension is not affiliated with or endorsed by Microsoft or the university. The repository also contains a separate optional self-host server component. The extension does not connect to it.

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

**Contact.** Open an issue at https://github.com/Sa-Alfy/teampulse/issues.
