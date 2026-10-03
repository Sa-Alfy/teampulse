#!/usr/bin/env node
/**
 * scripts/build-icons.js — Render assets/logo*.svg to the extension's PNG icons.
 *
 *   npm run build:icons
 *
 * Uses the Playwright Chromium the project already installs (no new
 * dependency). 16 and 32 px come from logo-small.svg (heavier line, fewer
 * bends); 48 and 128 px from logo.svg. Output: extension/icons/icon<N>.png.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT  = path.join(__dirname, "..");
const OUT   = path.join(ROOT, "extension", "icons");
const SIZES = [
  { size: 16,  src: "logo-small.svg" },
  { size: 32,  src: "logo-small.svg" },
  { size: 48,  src: "logo.svg" },
  { size: 128, src: "logo.svg" },
];

async function main() {
  const browser = await chromium.launch();
  try {
    for (const { size, src } of SIZES) {
      const svg  = fs.readFileSync(path.join(ROOT, "assets", src), "utf8");
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}
        svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`;
      await page.setContent(html);
      const file = path.join(OUT, `icon${size}.png`);
      await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
      await page.close();
      console.log(`${path.relative(ROOT, file)}  (${fs.statSync(file).size} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
