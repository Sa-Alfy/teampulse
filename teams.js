/**
 * teams.js — Full scrape: channel posts + assignments, for every class.
 *
 * Usage:
 *   node teams.js [--headed] [--class "CSE 312"]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { scrapeClassPosts } = require("./scrape-posts");
const { extractDate } = require("./digest-utils");
const {
  launchTeams,
  openTeamsList,
  openTeamByIndex,
  goBackToTeamsList,
  parseScraperArgs,
  selectClasses,
  fatal,
} = require("./teams-session");

const TABS = ["Upcoming", "Past due", "Completed"];
const ASSIGNMENTS_FILE = "assignments.json";
const NOTICES_FILE = "notices.json";
const DEBUG_DIR = "debug";

/** Put debug screenshots somewhere that isn't the repo root. */
function debugShot(page, name) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
  } catch { /* ignore */ }
  return page
    .screenshot({ path: path.join(DEBUG_DIR, `${name}-${Date.now()}.png`), fullPage: true })
    .catch(() => {});
}

/**
 * Click an assignments tab and wait for the tab to actually BE the active one.
 *
 * A blind `waitForTimeout(2000)` here was filing one tab's cards under another
 * tab's name whenever the iframe was slow: the cards from the previous tab are
 * still in the DOM, so reading immediately after the click records "Completed"
 * work as "Past due".
 */
async function clickTab(frame, tabName) {
  let tabLocator = frame.locator(`[data-test="${tabName}"]`).first();
  if ((await tabLocator.count()) === 0) {
    tabLocator = frame.getByText(tabName, { exact: true }).first();
  }
  if ((await tabLocator.count()) === 0) return false;

  await tabLocator.click();

  // 1. The tab itself reports that it is selected.
  await frame
    .locator(`[data-test="${tabName}"][aria-selected="true"]`)
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => {
      // Some Fluent builds don't expose aria-selected on this node; the
      // content wait below is then the only guard we have.
    });

  // 2. The panel has resolved to either cards or the empty state.
  await Promise.race([
    frame.locator('[data-test="assignment-card"]').first().waitFor({ timeout: 10000 }),
    frame.getByText("No assignments", { exact: false }).first().waitFor({ timeout: 10000 }),
  ]).catch(() => {});

  return true;
}

/** Pull the stable GUID out of a card's id attribute, if there is one. */
function extractGuid(rawId) {
  if (!rawId) return null;
  const m = String(rawId).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

async function scrapeClassAssignments(page, className = "unknown") {
  const results = [];

  // Safe sidebar navigation selector (avoids chat post "Assignments" bot trap)
  try {
    let assignmentsBtn = page.locator('#classroom, [role="treeitem"]').getByText("Assignments", { exact: true }).first();
    if ((await assignmentsBtn.count()) === 0) {
      assignmentsBtn = page.locator('a[role="treeitem"]').filter({ hasText: "Assignments" }).first();
    }
    if ((await assignmentsBtn.count()) === 0) {
      // Fallback
      assignmentsBtn = page.getByText("Assignments", { exact: true }).last();
    }
    await assignmentsBtn.waitFor({ timeout: 10000 });
    await assignmentsBtn.click();
  } catch (e) {
    console.log(`  ⚠️ Could not open Assignments tab: ${e.message}`);
    await debugShot(page, "no-assign-btn");
    return results;
  }

  const frameLocator = page.frameLocator('iframe[src*="assignments.edu.cloud.microsoft"]');

  // Empty class state tolerance (CSE 304 fix)
  try {
    await Promise.race([
      frameLocator.locator('[data-test="Completed"], [data-test="assignment-card"], [data-test="Upcoming"], [data-test="Past due"]').first().waitFor({ timeout: 20000 }),
      frameLocator.getByText("No assignments in this class yet", { exact: false }).first().waitFor({ timeout: 20000 }),
    ]);
  } catch (e) {
    console.log(`  ⚠️ Assignments app didn't load in time: ${e.message}`);
    await debugShot(page, "frame-timeout");
    return results;
  }

  const nowYear = new Date().getFullYear();

  for (const tabName of TABS) {
    try {
      const clicked = await clickTab(frameLocator, tabName);
      if (!clicked) continue;

      const cards = await frameLocator.locator('[data-test="assignment-card"]').all();
      for (const card of cards) {
        const title = await card.locator(".fui-CardHeader__header").first().textContent().catch(() => "");
        const description = await card.locator(".fui-CardHeader__description").first().textContent().catch(() => "");
        const action = await card.locator(".fui-CardHeader__action").first().textContent().catch(() => "");

        // The card's id carries a stable GUID — the only real identity an
        // assignment has. Without it assignments can never be deduplicated.
        const rawId = await card.getAttribute("id").catch(() => null);
        const dataId = await card.getAttribute("data-id").catch(() => null);
        const assignmentId = extractGuid(rawId) || extractGuid(dataId) || null;

        // Prefer a machine-readable due date if the card exposes one; fall
        // back to parsing the human string ("Due Sep 20").
        const dueAttr = await card
          .locator("[datetime], time, [title*='Due'], [aria-label*='Due']")
          .first()
          .evaluate(
            (el) => el.getAttribute("datetime") || el.getAttribute("title") || el.getAttribute("aria-label") || null
          )
          .catch(() => null);

        const details = (description || "").trim();
        const dueDate = extractDate(dueAttr || details, nowYear);

        results.push({
          tab: tabName,
          assignmentId,
          rawId: rawId || null,
          title: (title || "").trim(),
          details,
          dueRaw: dueAttr || null,
          dueDate: dueDate || null,
          status: (action || "").trim(),
        });
      }
      console.log(`  Assignments [${tabName}]: ${cards.length} found`);
    } catch (e) {
      console.log(`  ⚠️ Error reading "${tabName}": ${e.message}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseScraperArgs(process.argv.slice(2));

  const allAssignments = [];
  const allNotices = [];

  // Write whatever has been collected so far. Called on every class boundary
  // AND in the finally block, so a crash on the last class no longer discards
  // the classes that already succeeded.
  const flush = () => {
    try {
      fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(allAssignments, null, 2));
      fs.writeFileSync(NOTICES_FILE, JSON.stringify(allNotices, null, 2));
    } catch (e) {
      console.log(`  ⚠️ Could not write output files: ${e.message}`);
    }
  };

  const { browser, page } = await launchTeams({ headed: opts.headed });

  try {
    console.log("Navigating to Teams...");
    const classNames = await openTeamsList(page);
    const targets = selectClasses(classNames, opts.classFilter);

    if (targets.length === 0) {
      console.log(`Found ${classNames.length} classes, none matching --class "${opts.classFilter}".`);
      return;
    }
    console.log(`Found ${classNames.length} classes; scraping ${targets.length}.\n`);

    for (let n = 0; n < targets.length; n++) {
      const { name: className, index } = targets[n];
      console.log(`📘 [${n + 1}/${targets.length}] ${className}`);

      try {
        await openTeamByIndex(page, index);

        // 1. Scrape General Channel Posts & Notices (default view)
        const posts = await scrapeClassPosts(page, className);
        allNotices.push({ className, posts });

        // 2. Scrape Assignments
        const assignments = await scrapeClassAssignments(page, className);
        allAssignments.push({ className, assignments });
      } catch (e) {
        console.log(`  ❌ Failed: ${e.message}`);
        await debugShot(page, `fail-${index}`);
        allAssignments.push({ className, assignments: [], error: e.message });
        allNotices.push({ className, posts: [], error: e.message });
      }

      // Persist incrementally — one bad class must not cost the whole run.
      flush();

      if (n < targets.length - 1) {
        console.log("  Returning to teams list...");
        const ok = await goBackToTeamsList(page);
        if (!ok) console.log("  ⚠️ Could not return to teams list — subsequent classes may fail.");
      }
      console.log("");
    }
  } finally {
    flush();
    console.log(`✅ Saved to ${ASSIGNMENTS_FILE} and ${NOTICES_FILE}`);
    await browser.close().catch(() => {});
  }
}

module.exports = {
  scrapeClassAssignments,
  clickTab,
  extractGuid,
  goBackToTeamsList,
};

if (require.main === module) {
  main().catch(fatal);
}
