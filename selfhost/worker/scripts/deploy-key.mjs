// One-off deploy-test key. Never prints the key.
//   node scripts/deploy-key.mjs           → writes .wrangler/deploy-test/key.txt (the key, local only)
//                                         and .wrangler/deploy-test/key.sql (only its sha256 hash)
//   node scripts/deploy-key.mjs --delete  → deletes both files
// .wrangler/ is git-ignored.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import authMod from "../../core/auth.js";

const { randomSecret, hashKey } = authMod;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".wrangler", "deploy-test");
const keyFile = path.join(dir, "key.txt");
const sqlFile = path.join(dir, "key.sql");

if (process.argv.includes("--delete")) {
  for (const f of [keyFile, sqlFile]) if (fs.existsSync(f)) fs.rmSync(f);
  console.log("deleted local test key files:", !fs.existsSync(keyFile) && !fs.existsSync(sqlFile));
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, `tp_${randomSecret(32)}`, { mode: 0o600 });
const key = fs.readFileSync(keyFile, "utf8").trim();
const hash = await hashKey(key);
fs.writeFileSync(sqlFile,
  `INSERT INTO settings (k, v) VALUES ('ingest_key_hash', '${hash}') ON CONFLICT(k) DO UPDATE SET v = excluded.v;\n`);
console.log("test key ready (not shown). Hash-only SQL:", path.relative(process.cwd(), sqlFile));
