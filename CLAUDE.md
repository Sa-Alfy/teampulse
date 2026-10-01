# CLAUDE.md — working rules for this repo

- Read before you write; grep to confirm names. Never invent APIs or selectors. If a fact is missing, implement a safe fallback and say what is needed.
- Claims need evidence: paste command output. Anything not run goes under NOT VERIFIED.
- Owner is on Windows/PowerShell: write cross-platform Node scripts, no bash-isms.
- Security first: the shipped extension (`extension/`) makes zero network requests, has no analytics, no remote code, no eval/new Function. Scraped text is untrusted: never put it into innerHTML.
- The self-host flow (server.js, Playwright scrapers, build-digest.js, Telegram, db.js) must keep working; all existing tests keep passing (`node --test`, `npm run test:dom`).
- No new runtime dependencies. devDependencies only if essential, and flag them.
- Never revert/stash/checkout uncommitted changes you didn't make. Never use the owner's logged-in browser or Teams account.
- Docs must be honest: "verified" only for what was run. Real-Teams capture stays "unverified" until the owner confirms it.
- Ask the owner before: adding any permission, host match, network call or remote code; changing self-host behavior; picking a public product name; any destructive git. Never push.
