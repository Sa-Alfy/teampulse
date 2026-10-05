#!/usr/bin/env node
/**
 * scripts/pack-selfhost-extension.js — builds the SELF-HOST extension:
 * the unchanged store files from extension/ plus selfhost/extension/.
 *
 *   node scripts/pack-selfhost-extension.js [outDir]
 *
 * Output: <outDir or dist/selfhost-extension>/ (load unpacked) and
 * dist/teamspulse-selfhost-<version>.zip. The store build (extension/,
 * npm run pack:extension) is never modified.
 *
 * Manifest changes vs the store build (everything else is copied as is):
 *   - name + " (self-host)", version SELFHOST_VERSION (the store build keeps its own)
 *   - background.service_worker → background-selfhost.js
 *   - optional_host_permissions: https://*.workers.dev/* (granted per server
 *     at runtime on the Connect page; no required host permission)
 *   - CSP connect-src 'none' → https://*.workers.dev
 *   - options_ui → connect.html
 * popup.html gets one extra <script> (the server bar); no other store file changes.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { walk, buildZip } = require("./pack-extension");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const OVERLAY = path.join(ROOT, "selfhost", "extension");
const OVERLAY_FILES = {
  "background-selfhost.js": "background-selfhost.js",
  "connect.html": "connect.html",
  "selfhost/push-core.js": "push-core.js",
  "selfhost/connect-sw.js": "connect-sw.js",
  "selfhost/connect-page.js": "connect-page.js",
  "selfhost/popup-connect.js": "popup-connect.js",
};
const SELFHOST_VERSION = "0.9.0";
const POPUP_HOOK = '<script src="popup.js"></script>';
const WORKERS_ORIGINS = "https://*.workers.dev/*";

function transformManifest(store) {
  const m = JSON.parse(JSON.stringify(store));
  m.name = `${store.name} (self-host)`;
  m.version = SELFHOST_VERSION;
  m.background = { ...store.background, service_worker: "background-selfhost.js" };
  m.optional_host_permissions = [WORKERS_ORIGINS];
  const csp = store.content_security_policy.extension_pages;
  if (!csp.includes("connect-src 'none'")) throw new Error("store CSP changed: expected connect-src 'none'");
  m.content_security_policy = { ...store.content_security_policy, extension_pages: csp.replace("connect-src 'none'", "connect-src https://*.workers.dev") };
  m.options_ui = { page: "connect.html", open_in_tab: true };
  return m;
}

function patchPopup(html) {
  if (!html.includes(POPUP_HOOK)) throw new Error("popup.html changed: popup.js script tag not found");
  return html.replace(POPUP_HOOK, `${POPUP_HOOK}
  <script src="selfhost/popup-connect.js"></script>`);
}

function build(outDir) {
  const store = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const manifest = transformManifest(store);
  fs.rmSync(outDir, { recursive: true, force: true });
  const entries = [];
  for (const name of walk(EXT)) {
    if (name === "manifest.json") continue;
    let data = fs.readFileSync(path.join(EXT, name));
    if (name === "popup.html") data = Buffer.from(patchPopup(data.toString("utf8")));
    entries.push({ name, data });
  }
  for (const [name, src] of Object.entries(OVERLAY_FILES)) {
    if (entries.some((e) => e.name === name)) throw new Error(`overlay would overwrite a store file: ${name}`);
    entries.push({ name, data: fs.readFileSync(path.join(OVERLAY, src)) });
  }
  entries.push({ name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
  for (const e of entries) {
    const p = path.join(outDir, ...e.name.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, e.data);
  }
  return { manifest, entries };
}

function main() {
  const outDir = path.resolve(process.argv[2] || path.join(ROOT, "dist", "selfhost-extension"));
  const { manifest, entries } = build(outDir);
  const zipPath = path.join(ROOT, "dist", `teamspulse-selfhost-${manifest.version}.zip`);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, buildZip(entries));
  console.log(`${path.relative(ROOT, outDir)}/  (${entries.length} files, load unpacked)`);
  console.log(`${path.relative(ROOT, zipPath)}`);
}

if (require.main === module) main();

module.exports = { transformManifest, build, patchPopup, OVERLAY_FILES, SELFHOST_VERSION };
