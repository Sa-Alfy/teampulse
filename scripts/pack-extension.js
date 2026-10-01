"use strict";

/**
 * scripts/pack-extension.js — build the store upload zip.   npm run pack:extension
 *
 * Includes only runtime files under extension/ (no tests, fixtures, source
 * maps, dotfiles). Fails if a file the manifest/popup references is missing.
 * Zip is written with Node built-ins only (zlib deflate + crc32), no deps.
 * Output: dist/teamspulse-extension-<version>.zip
 */

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const EXT  = path.join(ROOT, "extension");
const DIST = path.join(ROOT, "dist");

const EXCLUDE = [/\.map$/i, /(^|\/)\./, /\.test\.js$/i, /(^|\/)(test|tests|fixtures)\//i, /\.md$/i];

function walk(dir, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (!EXCLUDE.some((re) => re.test(rel))) out.push(rel);
  }
  return out;
}

/** Every file the extension loads must be in the package. */
function requiredFiles(manifest) {
  const req = new Set(["manifest.json", manifest.background.service_worker, manifest.action.default_popup]);
  Object.values(manifest.action.default_icon || {}).forEach((f) => req.add(f));
  for (const cs of manifest.content_scripts || []) (cs.js || []).forEach((f) => req.add(f));
  const bg = fs.readFileSync(path.join(EXT, manifest.background.service_worker), "utf8");
  for (const m of bg.matchAll(/"(core\/[^"]+\.js)"/g)) req.add(m[1]);
  const popup = fs.readFileSync(path.join(EXT, manifest.action.default_popup), "utf8");
  for (const m of popup.matchAll(/(?:src|href)="([^"]+)"/g)) req.add(m[1]);
  return [...req];
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function buildZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);                 // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const files = walk(EXT);
  const missing = requiredFiles(manifest).filter((f) => !files.includes(f));
  if (missing.length) {
    console.error(`Missing required files: ${missing.join(", ")}`);
    process.exit(1);
  }

  const entries = files.map((name) => ({ name, data: fs.readFileSync(path.join(EXT, name)) }));
  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, `teamspulse-extension-${manifest.version}.zip`);
  const zip = buildZip(entries);
  fs.writeFileSync(out, zip);

  console.log(`${path.relative(ROOT, out)}  (${zip.length} bytes, ${entries.length} files)`);
  for (const e of entries) console.log(`  ${String(e.data.length).padStart(7)}  ${e.name}`);
}

main();
