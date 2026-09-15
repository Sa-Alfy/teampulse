const { chromium } = require("playwright");
const fs = require("fs");
const { scrapeClassPosts } = require("./scrape-posts");

const TABS = ["Upcoming", "Past due", "Completed"];
const TEAMS_URL = "https://teams.microsoft.com/v2/";

async function clickTab(frame, page, tabName) {
  let tabLocator = frame.locator(`[data-test="${tabName}"]`).first();
  if ((await tabLocator.count()) === 0) {
    tabLocator = frame.getByText(tabName, { exact: true }).first();
  }
  if ((await tabLocator.count()) === 0) return false;
  await tabLocator.click();
  await page.waitForTimeout(2000);
  return true;
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
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log(`  ⚠️ Could not open Assignments tab: ${e.message}`);
    await page.screenshot({ path: `debug-no-assign-btn-${Date.now()}.png`, fullPage: true }).catch(() => {});
    return results;
  }

  const frameLocator = page.frameLocator('iframe[src*="assignments.edu.cloud.microsoft"]');

  // Empty class state tolerance (CSE 304 fix)
  try {
    await Promise.race([
      frameLocator.locator('[data-test="Completed"], [data-test="assignment-card"], [data-test="Upcoming"], [data-test="Past due"]').first().waitFor({ timeout: 20000 }),
      frameLocator.getByText("No assignments in this class yet", { exact: false }).first().waitFor({ timeout: 20000 })
    ]);
  } catch (e) {
    console.log(`  ⚠️ Assignments app didn't load in time: ${e.message}`);
    await page.screenshot({ path: `debug-frame-timeout-${Date.now()}.png`, fullPage: true }).catch(() => {});
    return results;
  }

  for (const tabName of TABS) {
    try {
      const clicked = await clickTab(frameLocator, page, tabName);
      if (!clicked) {
        continue;
      }
      const cards = await frameLocator.locator('[data-test="assignment-card"]').all();
      for (const card of cards) {
        const title = await card.locator(".fui-CardHeader__header").first().textContent().catch(() => "");
        const description = await card.locator(".fui-CardHeader__description").first().textContent().catch(() => "");
        const action = await card.locator(".fui-CardHeader__action").first().textContent().catch(() => "");
        results.push({ tab: tabName, title: title.trim(), details: description.trim(), status: action.trim() });
      }
      console.log(`  Assignments [${tabName}]: ${cards.length} found`);
    } catch (e) {
      console.log(`  ⚠️ Error reading "${tabName}": ${e.message}`);
    }
  }
  return results;
}

async function goBackToTeamsList(page) {
  try {
    const backBtn = page.getByText("All teams", { exact: false }).first();
    await backBtn.waitFor({ timeout: 8000 });
    await backBtn.click();
    await page.waitForTimeout(2000);
    await page.waitForSelector('[data-testid="team-name"]', { timeout: 10000 });
    return true;
  } catch (e) {
    console.log(`  ⚠️ "All teams" back nav failed (${e.message.slice(0, 60)}), trying full reload...`);
    try {
      await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('[data-testid="team-name"]', { timeout: 45000 });
      return true;
    } catch (e2) {
      console.log(`  ❌ Full reload also failed: ${e2.message.slice(0, 60)}`);
      return false;
    }
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: "auth-teams.json",
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();

  console.log("Navigating to Teams...");
  await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="team-name"]', { timeout: 45000 });

  const classNames = await page.locator('[data-testid="team-name"]').allTextContents();
  console.log(`Found ${classNames.length} classes.\n`);

  const allAssignments = [];
  const allNotices = [];

  for (let i = 0; i < classNames.length; i++) {
    const className = classNames[i].trim();
    console.log(`📘 [${i + 1}/${classNames.length}] ${className}`);

    try {
      const teamLocator = page.locator('[data-testid="team-name"]').filter({ hasText: className }).first();
      await teamLocator.waitFor({ timeout: 15000 });
      await teamLocator.click();

      // 1. Scrape General Channel Posts & Notices (default view)
      const posts = await scrapeClassPosts(page, className);
      allNotices.push({ className, posts });

      // 2. Scrape Assignments
      const assignments = await scrapeClassAssignments(page, className);
      allAssignments.push({ className, assignments });
    } catch (e) {
      console.log(`  ❌ Failed: ${e.message}`);
      await page.screenshot({ path: `debug-fail-${i}.png`, fullPage: true }).catch(() => {});
      allAssignments.push({ className, assignments: [], error: e.message });
      allNotices.push({ className, posts: [], error: e.message });
    }

    if (i < classNames.length - 1) {
      console.log("  Returning to teams list...");
      const ok = await goBackToTeamsList(page);
      if (!ok) console.log("  ⚠️ Could not return to teams list — subsequent classes may fail.");
    }
    console.log("");
  }

  fs.writeFileSync("assignments.json", JSON.stringify(allAssignments, null, 2));
  fs.writeFileSync("notices.json", JSON.stringify(allNotices, null, 2));
  console.log("✅ All done. Saved to assignments.json and notices.json");

  await browser.close();
}

module.exports = {
  scrapeClassAssignments,
  clickTab,
  goBackToTeamsList
};

if (require.main === module) {
  main().catch((err) => console.error("❌ Fatal error:", err));
}
