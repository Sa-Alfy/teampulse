/**
 * teams-session.js — Shared Playwright session/navigation helpers.
 *
 * Both scrapers (teams.js and scrape-posts.js) launch a browser, restore the
 * saved Teams session and walk the same team list. That logic lives here once
 * so the two entry points cannot drift apart.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const TEAMS_URL = "https://teams.microsoft.com/v2/";
const AUTH_FILE = path.join(__dirname, "auth-teams.json");

// Pin the browser's timezone and locale.
//
// Teams renders timestamps as localised strings ("Saturday, August 29, 2026
// 5:20 PM") with no zone information. Date.parse() then resolves them against
// whatever the host machine's timezone happens to be — so the same post gets a
// different timestampIso on a laptop and on a UTC server, and since
// timestampIso feeds the dedup hash, every post looks new again after a move.
// A non-English UI is worse: the string doesn't parse at all.
const TIMEZONE = process.env.TEAMSPULSE_TZ || "Asia/Dhaka";
const LOCALE   = process.env.TEAMSPULSE_LOCALE || "en-US";

const TEAM_NAME_SELECTOR = '[data-testid="team-name"]';

/**
 * Fail early and helpfully if the saved session is missing, instead of letting
 * Playwright throw an ENOENT from deep inside newContext().
 */
function requireAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(
      `No saved Teams session found at ${AUTH_FILE}.\n` +
      `   Run \`npm run login\` first and sign in when the browser opens.`
    );
  }
}

/**
 * Launch Chromium with the saved Teams session restored.
 *
 * @param {{ headed?: boolean }} opts
 * @returns {Promise<{browser: import('playwright').Browser, context: any, page: any}>}
 */
async function launchTeams({ headed = false } = {}) {
  requireAuthFile();

  const browser = await chromium.launch({ headless: !headed });
  try {
    const context = await browser.newContext({
      storageState: AUTH_FILE,
      viewport: { width: 1400, height: 900 },
      timezoneId: TIMEZONE,
      locale: LOCALE,
    });
    const page = await context.newPage();
    return { browser, context, page };
  } catch (err) {
    // Don't leak a browser if context creation fails.
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Detect the "your session expired" case: Teams bounces to a Microsoft login
 * page, and without this check the caller just eats a 45-second selector
 * timeout with no idea why.
 */
async function looksLoggedOut(page) {
  try {
    const url = page.url();
    if (/login\.microsoftonline\.com|\/_?login|signin/i.test(url)) return true;
    const loginField = page.locator('input[name="loginfmt"], input[type="password"]').first();
    return (await loginField.count()) > 0;
  } catch {
    return false;
  }
}

/**
 * Navigate to Teams and wait for the team list to render.
 * Throws with an actionable message if the session has expired.
 *
 * @returns {Promise<string[]>} trimmed team names, in DOM order
 */
async function openTeamsList(page) {
  await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  if (await looksLoggedOut(page)) {
    throw new Error("Your Teams session has expired. Run `npm run login` to refresh it.");
  }

  try {
    await page.waitForSelector(TEAM_NAME_SELECTOR, { timeout: 45000 });
  } catch (err) {
    if (await looksLoggedOut(page)) {
      throw new Error("Your Teams session has expired. Run `npm run login` to refresh it.");
    }
    throw err;
  }

  const names = await page.locator(TEAM_NAME_SELECTOR).allTextContents();
  return names.map((n) => n.trim());
}

/**
 * Open the i-th team in the list.
 *
 * Indexed, not text-matched. `filter({ hasText })` is a SUBSTRING match, so a
 * class whose display name is a prefix of another's (trivially common with
 * section suffixes like "CSE 312" vs "CSE 312 Lab") resolves to whichever
 * comes first in the DOM — scraping one team twice under two different labels.
 *
 * @param {import('playwright').Page} page
 * @param {number} index
 */
async function openTeamByIndex(page, index) {
  const teamLocator = page.locator(TEAM_NAME_SELECTOR).nth(index);
  await teamLocator.waitFor({ timeout: 15000 });
  await teamLocator.click();
}

/**
 * Navigate back to the teams list, falling back to a full reload.
 *
 * @returns {Promise<boolean>}
 */
async function goBackToTeamsList(page) {
  try {
    const backBtn = page.getByText("All teams", { exact: false }).first();
    await backBtn.waitFor({ timeout: 8000 });
    await backBtn.click();
    await page.waitForSelector(TEAM_NAME_SELECTOR, { timeout: 10000 });
    return true;
  } catch (e) {
    console.log(`  ⚠️ "All teams" back nav failed (${e.message.slice(0, 60)}), trying full reload...`);
    try {
      await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector(TEAM_NAME_SELECTOR, { timeout: 45000 });
      return true;
    } catch (e2) {
      console.log(`  ❌ Full reload also failed: ${e2.message.slice(0, 60)}`);
      return false;
    }
  }
}

/**
 * Shared CLI flags for both scrapers.
 *   --headed        run with a visible browser
 *   --class <text>  only scrape teams whose name contains <text>
 */
function parseScraperArgs(argv) {
  const opts = { headed: false, classFilter: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--headed") {
      opts.headed = true;
    } else if (argv[i] === "--class") {
      opts.classFilter = argv[++i];
      if (!opts.classFilter) {
        console.error("❌ --class needs a value, e.g. --class \"CSE 312\"");
        process.exit(1);
      }
    } else {
      console.error(`❌ Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return opts;
}

/** Apply --class, returning [{ name, index }] for the teams to scrape. */
function selectClasses(classNames, classFilter) {
  return classNames
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => !classFilter || name.toLowerCase().includes(classFilter.toLowerCase()));
}

/**
 * Report a fatal error and set a non-zero exit code.
 *
 * `.catch(console.error)` alone still exits 0, so cron jobs and shell `&&`
 * chains cannot tell a failed scrape from a successful one.
 */
function fatal(err) {
  console.error(`\n❌ Fatal error: ${err && err.message ? err.message : err}`);
  if (err && err.stack && process.env.TEAMSPULSE_DEBUG) console.error(err.stack);
  process.exitCode = 1;
}

module.exports = {
  TEAMS_URL,
  AUTH_FILE,
  TIMEZONE,
  LOCALE,
  TEAM_NAME_SELECTOR,
  requireAuthFile,
  launchTeams,
  openTeamsList,
  openTeamByIndex,
  goBackToTeamsList,
  looksLoggedOut,
  parseScraperArgs,
  selectClasses,
  fatal,
};
