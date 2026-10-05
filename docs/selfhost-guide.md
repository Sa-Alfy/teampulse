# Self-host guide: your own TeamsPulse server

Your own free Cloudflare Worker sends you Telegram alerts when a due date moves, reminds you 24 h and 3 h before unsubmitted work (even with your browser closed), answers `/today` `/week` `/due` `/plan`, and gives you a private calendar feed. Only you hold the data. The server never logs into Teams; the browser extension sends what it sees.

**Status:** built and tested with automated tests; the full flow on a real phone has **not been verified yet**, and the "about 10 minutes" target is not measured yet. The extension's Connect build (step 6) is not released yet.

**You need:** a Telegram account, a free Cloudflare account, and [Node.js 22+](https://nodejs.org) (for the commands below). Nothing here asks for a payment method; if Cloudflare does, stop.

## 1. Create your bot (Telegram, 2 min)
1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`.
2. Copy the **token** it gives you (looks like `123456:ABC…`). Keep it secret.

## 2. Get the code
```
git clone https://github.com/Sa-Alfy/teampulse.git
cd teampulse/selfhost/worker
npm install --ignore-scripts
```

## 3. Create the database (Cloudflare)
```
npx wrangler login
npx wrangler d1 create teamspulse
```
If it asks to add the binding for you, answer **No**. Copy the printed `database_id` into `wrangler.toml`, replacing `00000000-0000-0000-0000-000000000000`. Then:
```
npx wrangler d1 migrations apply DB --remote
```

## 4. Add the bot token and deploy
```
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler deploy
```
Paste the bot token when asked. `deploy` prints your URL, like `https://teamspulse.<you>.workers.dev`.

## 5. Claim your server
1. Open `https://teamspulse.<you>.workers.dev/setup` and paste the bot token again (this proves the server is yours; only you know it).
2. The page shows three things **once**: copy them now.
   - A Telegram command like `/start ABCDE23456`: open your bot and send it (works once, for 10 minutes).
   - Your **extension key** (`tp_…`).
   - Your **calendar URL** (`…/cal/….ics`).
3. In Telegram, send `/doctor` to check everything is green.

Lost the pairing code? Open `/setup` again and use your extension key to get a new one.

## 6. Connect your data
- **Calendar:** Google Calendar → Other calendars → **From URL** → paste the calendar URL. (Google refreshes subscribed calendars on its own schedule, often several hours.)
- **Extension:** the self-host "Connect" build will take the extension key (coming next; not released yet).

## Day to day
- `/today`, `/week`, `/due`, `/plan`, `/done <n>`, `/undone`, `/digest 07:30` or `/digest off`, `/doctor`.
- Every reply says **"Last synced N h ago"**: alerts are only as fresh as your last visit to Teams with the extension.
- Quiet hours are 23:00–07:00 (Asia/Dhaka by default); 3 h reminders and due-date changes still come through.

## Keys, privacy, deleting
- `/rotatekey` gives a new extension key; `/rotatecal` a new calendar URL (the old one stops at once).
- `/deleteall` deletes every stored assignment, post, alert and reminder (it asks you to confirm).
- To remove everything: `npx wrangler delete` and `npx wrangler d1 delete teamspulse`, then delete the bot in @BotFather (`/deletebot`).
