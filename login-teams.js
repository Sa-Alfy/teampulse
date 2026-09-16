/**
 * login-teams.js — One-time interactive login that saves a Teams session.
 *
 * Opens a visible browser, waits for you to sign in, then writes the storage
 * state to auth-teams.json. Run again whenever the session expires.
 */

"use strict";

const fs = require("fs");
const { chromium } = require("playwright");
const { AUTH_FILE, TEAMS_URL, TIMEZONE, LOCALE, fatal } = require("./teams-session");

async function main() {
  const browser = await chromium.launch({ headless: false }); // visible browser for manual login

  try {
    const context = await browser.newContext({
      timezoneId: TIMEZONE,
      locale: LOCALE,
    });
    const page = await context.newPage();

    console.log("Opening Teams — please log in manually...");
    await page.goto(TEAMS_URL);

    console.log("Once you see your actual Teams app loaded (teams list visible), come back here and press ENTER.");
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once("data", resolve));
    // Release the stdin handle, or the event loop stays alive and the process
    // hangs at the prompt after everything is done.
    process.stdin.pause();

    await context.storageState({ path: AUTH_FILE });

    // This file holds live Teams tokens. Default 0644 means any other account
    // on the machine can read them. (No-op on Windows, which ignores POSIX
    // mode bits — there, rely on the user profile's own ACLs.)
    try {
      fs.chmodSync(AUTH_FILE, 0o600);
    } catch (e) {
      console.log(`⚠️  Could not restrict permissions on ${AUTH_FILE}: ${e.message}`);
    }

    console.log(`✅ Teams session saved to ${AUTH_FILE}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = { main };
