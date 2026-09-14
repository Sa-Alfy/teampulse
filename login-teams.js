const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({ headless: false }); // visible browser for manual login
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("Opening Teams — please log in manually...");
  await page.goto("https://teams.microsoft.com/v2/");

  console.log("Once you see your actual Teams app loaded (teams list visible), come back here and press ENTER.");
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("data", resolve));

  await context.storageState({ path: "auth-teams.json" });
  console.log("✅ Teams session saved to auth-teams.json");

  await browser.close();
}

main();

