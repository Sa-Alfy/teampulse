// Test double for a D1 binding, backed by node:sqlite (in-memory). Implements
// the subset the Worker uses: prepare().bind().all()/first()/run(), batch().
// batch() runs in one transaction like D1. Calls are recorded so tests can
// assert that each ingest writes in exactly one batch.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const READ = /^\s*(SELECT|WITH|EXPLAIN|PRAGMA)\b/i;

export function createD1({ migrationsDir = null } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  if (migrationsDir) {
    for (const f of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      sqlite.exec(fs.readFileSync(path.join(migrationsDir, f), "utf8"));
    }
  }
  const calls = { batches: [], directWrites: 0, failOn: null };

  function exec(sql, params) {
    if (calls.failOn && calls.failOn.test(sql)) throw new Error("injected failure");
    const st = sqlite.prepare(sql);
    if (READ.test(sql)) return { results: st.all(...params), success: true, meta: {} };
    const r = st.run(...params);
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }

  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) {
      for (const v of params) {
        if (v === undefined) throw new TypeError("D1_TYPE_ERROR: undefined is not a valid bind value");
      }
      return new Stmt(this.sql, params);
    }
    async all() { if (!READ.test(this.sql)) calls.directWrites++; return exec(this.sql, this.params); }
    async run() { if (!READ.test(this.sql)) calls.directWrites++; return exec(this.sql, this.params); }
    async first(col) {
      const { results } = exec(this.sql, this.params);
      const row = results[0] ?? null;
      return row && col ? row[col] : row;
    }
  }

  return {
    sqlite,
    calls,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      calls.batches.push(stmts.map((s) => (READ.test(s.sql) ? "read" : "write")));
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => exec(s.sql, s.params));
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
