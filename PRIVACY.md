# Privacy Policy — TeamsPulse browser extension

_Last updated: 2026-10-01 · applies to extension version 0.6.0_

**What it reads.** While you have Microsoft Teams open (`teams.microsoft.com`, `teams.cloud.microsoft`) and its assignments frame (`assignments.edu.cloud.microsoft`), the extension reads what those pages show: class names, channel posts (author name, subject, text, timestamp, attachment names) and assignment titles, due dates and status. It reads nothing on any other website. "Sync all classes" only opens your own classes in your own Teams tab when you click it.

**Where it is stored.** Only in your browser's extension storage (`chrome.storage.local`) on your device. A temporary per-tab note of the open class is kept in session storage and is discarded when the tab closes.

**What is sent anywhere.** Nothing. The extension makes no network requests: no servers, no analytics, no tracking, no ads, no remote code. Its pages are locked down with a Content Security Policy of `connect-src 'none'`. Nothing is sold or shared.

**Other people's content.** The extension stores whatever the Teams page shows you, which includes posts written by teachers and classmates and their names. It is kept only on your device and is not shown to anyone except you.

**Deleting your data.** Open the extension popup and click **Clear stored data**, or remove the extension; either deletes everything it stored.

**Permissions.** `storage` / `unlimitedStorage` (keep your briefing on your device), `alarms` (refresh the toolbar badge every 30 minutes). No host permissions; content scripts run only on the Teams pages listed above.

**Contact.** Open an issue at https://github.com/Sa-Alfy/teampulse/issues.
