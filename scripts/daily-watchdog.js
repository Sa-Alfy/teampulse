/**
 * scripts/daily-watchdog.js — Watchdog runner for daily scrape and digest
 *
 * Runs `npm run daily` as a child process, retrying once on non-zero exit code.
 * Appends a timestamped line to logs/watchdog.log and exits non-zero if both
 * attempts fail.
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT_DIR, "logs");
const LOG_FILE = path.join(LOGS_DIR, "watchdog.log");

/**
 * Execute `npm run daily` synchronously.
 * Returns true on zero exit code, false otherwise.
 */
function runDaily() {
  const result = spawnSync("npm", ["run", "daily"], {
    cwd: ROOT_DIR,
    stdio: "inherit",
    shell: true,
  });
  return result.status === 0;
}

function main() {
  let success = runDaily();
  if (!success) {
    success = runDaily();
  }

  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const logLine = success
    ? `[${timestamp}] SUCCESS: daily run completed\n`
    : `[${timestamp}] FAILURE: daily run failed after 2 attempts\n`;

  fs.appendFileSync(LOG_FILE, logLine, "utf-8");

  if (!success) {
    process.exit(1);
  }
}

main();
