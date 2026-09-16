/**
 * build-digest.js — Turn scraped notices/assignments into digest.md
 *
 * Usage:
 *   node build-digest.js [--hours N] [--out FILE] [--no-archive]
 *
 *   --hours N     only consider posts from the last N hours (default: all)
 *   --out FILE    output path (default: digest.md)
 *   --no-archive  skip writing a dated copy into digests/
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("./db");

const NOTICES_FILE     = "notices.json";
const ASSIGNMENTS_FILE = "assignments.json";
const DEFAULT_OUTPUT   = "digest.md";
const ARCHIVE_DIR      = "digests";

const {
  extractDate,
  extractTime,
  classify,
  isNoteworthy,
  truncate,
  escapeCell,
  filterRecentPosts,
} = require("./digest-utils");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { hours: null, out: DEFAULT_OUTPUT, archive: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hours") {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error("❌ --hours needs a positive number.");
        process.exit(1);
      }
      opts.hours = n;
    } else if (arg === "--out") {
      opts.out = argv[++i];
      if (!opts.out) {
        console.error("❌ --out needs a file path.");
        process.exit(1);
      }
    } else if (arg === "--no-archive") {
      opts.archive = false;
    } else {
      console.error(`❌ Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Turn one post into the row shape the markdown table needs. */
function toRow(post) {
  const combined = `${post.subject || ""} ${post.body || ""}`.trim();
  const postYear = post.timestampIso
    ? new Date(post.timestampIso).getFullYear()
    : new Date().getFullYear();
  const date = extractDate(combined, postYear) || extractDate(post.timestampFull, postYear);
  return {
    date,
    time: extractTime(combined),
    tag: classify(combined),
    summary: truncate(post.subject || post.body, 90),
    author: post.author,
    originalTimestamp: post.timestamp,
    sortKey: post.timestampIso || "",
  };
}

function renderTable(posts, emptyText) {
  if (!posts || posts.length === 0) return `_${emptyText}_\n`;

  const rows = posts
    .map(toRow)
    .sort((a, b) => (b.sortKey > a.sortKey ? 1 : -1)); // most recent first

  let out = `| Date | Time | Type | Summary | Source |\n|------|------|------|---------|--------|\n`;
  for (const r of rows) {
    out += `| ${r.date || "—"} | ${r.time || "—"} | ${r.tag} | ${escapeCell(r.summary)} | ${escapeCell(r.author)}, ${escapeCell(r.originalTimestamp)} |\n`;
  }
  return out;
}

function buildAssignmentsSection(assignments) {
  if (!assignments || assignments.length === 0) return `_(no assignments recorded)_\n`;
  let out = `| Tab | Title | Details | Status |\n|-----|-------|---------|--------|\n`;
  for (const a of assignments) {
    out += `| ${a.tab} | ${escapeCell(a.title)} | ${escapeCell(a.details)} | ${escapeCell(a.status)} |\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(NOTICES_FILE)) {
    console.error(`❌ ${NOTICES_FILE} not found. Run the scraper first (npm run scrape).`);
    process.exit(1);
  }

  db.ensureSchema();

  const notices = JSON.parse(fs.readFileSync(NOTICES_FILE, "utf-8"));
  const assignments = fs.existsSync(ASSIGNMENTS_FILE)
    ? JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, "utf-8"))
    : [];

  // Assignments are keyed by the RAW class name — two sections of one course
  // are two different teams with two different assignment lists.
  const assignmentsByClass = {};
  for (const entry of assignments) assignmentsByClass[entry.className] = entry.assignments || [];

  let totalPosts    = 0;
  let filteredOut   = 0;  // failed isNoteworthy — recorded, never counted as seen
  let newCount      = 0;
  let standingCount = 0;
  let inRunDupes    = 0;

  // Hashes surfaced during THIS run. The DB only knows about previous runs, so
  // without this a post appearing twice in one scrape slips through both checks.
  const seenThisRun = new Set();

  // [{ hash, className, post, surfaced }] — written after the digest file.
  const toRecord = [];

  const classes = notices.map((classEntry) => {
    const rawClassName = classEntry.className;
    let posts = classEntry.posts || [];
    if (opts.hours !== null) posts = filterRecentPosts(posts, opts.hours);

    const newPosts      = [];
    const standingPosts = [];

    for (const post of posts) {
      totalPosts++;

      // Filter FIRST, dedup second. A post that never made it into a digest
      // must not be burned as "seen" — otherwise improving the classifier can
      // never recover it.
      if (!isNoteworthy(post)) {
        filteredOut++;
        toRecord.push({
          hash: db.hashPost(rawClassName, post),
          className: rawClassName,
          post,
          surfaced: false,
        });
        continue;
      }

      const hash = db.hashPost(rawClassName, post);

      if (seenThisRun.has(hash)) {
        inRunDupes++;
        continue;
      }
      seenThisRun.add(hash);

      if (db.isNew(hash)) {
        newPosts.push(post);
        newCount++;
      } else {
        standingPosts.push(post);
        standingCount++;
      }
      toRecord.push({ hash, className: rawClassName, post, surfaced: true });
    }

    return { rawClassName, newPosts, standingPosts };
  });

  console.log(
    `📊 ${totalPosts} post(s) scanned · ${newCount} new · ${standingCount} still standing · ` +
    `${filteredOut} filtered out · ${inRunDupes} in-run duplicate(s)`
  );

  // ── Render ────────────────────────────────────────────────────────────────
  const generatedAt = new Date();
  let md = `# TeamsPulse Digest\n\n`;
  md += `_Generated ${generatedAt.toISOString()} — rule-based, no AI involved._\n`;
  md += `_${newCount} new since last run; ${standingCount} still standing across ${classes.length} class(es)._\n`;
  if (opts.hours !== null) md += `_Window: last ${opts.hours} hour(s)._\n`;
  md += `\n---\n\n`;

  for (const c of classes) {
    md += `## ${c.rawClassName}\n\n`;

    md += `### 🆕 New since last run\n\n`;
    md += renderTable(c.newPosts, "(nothing new)");

    md += `\n### 📋 Still standing\n\n`;
    md += renderTable(c.standingPosts, "(nothing carried over)");

    md += `\n### 📝 Assignments\n\n`;
    md += buildAssignmentsSection(assignmentsByClass[c.rawClassName]);
    md += `\n---\n\n`;
  }

  fs.writeFileSync(opts.out, md);
  console.log(`✅ Digest saved to ${opts.out}`);

  if (opts.archive) {
    try {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const stamp = generatedAt.toISOString().slice(0, 10);
      const archivePath = path.join(ARCHIVE_DIR, `${stamp}.md`);
      fs.writeFileSync(archivePath, md);
      console.log(`🗄️  Archived to ${archivePath}`);
    } catch (err) {
      console.log(`⚠️  Could not archive digest: ${err.message}`);
    }
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  // Done AFTER writing the digest so a crash mid-write doesn't silently lose
  // posts — they'll simply reappear on the next run instead.
  let surfaced = 0;
  for (const entry of toRecord) {
    db.markSeen(entry.hash, {
      className: entry.className,
      post: entry.post,
      surfaced: entry.surfaced,
    });
    if (entry.surfaced) surfaced++;
  }
  console.log(`💾 Recorded ${toRecord.length} post(s) (${surfaced} surfaced) in ${db.DB_PATH}`);

  db.close();
}

if (require.main === module) {
  main();
}

module.exports = { toRow, renderTable, buildAssignmentsSection, parseArgs };
