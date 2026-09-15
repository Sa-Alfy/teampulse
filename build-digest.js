const fs = require("fs");
const db = require("./db");

const NOTICES_FILE = "notices.json";
const ASSIGNMENTS_FILE = "assignments.json";
const OUTPUT_FILE = "digest.md";

const {
  extractDate,
  extractTime,
  classify,
  isNoteworthy,
  truncate,
  escapeCell,
} = require("./digest-utils");


// ---------------------------------------------------------------------------
// Build the digest
// ---------------------------------------------------------------------------

function buildNoticesSection(posts) {
  const rows = posts
    .filter(isNoteworthy)
    .map((post) => {
      const combined = `${post.subject || ""} ${post.body || ""}`.trim();
      const postYear = post.timestampIso ? new Date(post.timestampIso).getFullYear() : new Date().getFullYear();
      const date = extractDate(combined, postYear) || extractDate(post.timestampFull, postYear);
      const time = extractTime(combined);
      const tag = classify(combined);
      const summary = truncate(post.subject || post.body, 90);
      return {
        date, time, tag, summary,
        author: post.author,
        originalTimestamp: post.timestamp,
        sortKey: post.timestampIso || "",
      };
    })
    .sort((a, b) => (b.sortKey > a.sortKey ? 1 : -1)); // most recent first

  if (rows.length === 0) {
    return `_(no notable posts — either empty, or nothing matched the filters)_\n`;
  }

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

function main() {
  if (!fs.existsSync(NOTICES_FILE)) {
    console.error(`❌ ${NOTICES_FILE} not found. Run the scraper first.`);
    process.exit(1);
  }

  // ── Initialise deduplication store ────────────────────────────────────────
  db.ensureSchema();

  const notices = JSON.parse(fs.readFileSync(NOTICES_FILE, "utf-8"));
  const assignments = fs.existsSync(ASSIGNMENTS_FILE) ? JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, "utf-8")) : [];

  const assignmentsByClass = {};
  for (const entry of assignments) assignmentsByClass[entry.className] = entry.assignments || [];

  // ── Deduplication pass ────────────────────────────────────────────────────
  // Separate every post into "new" vs "already seen" buckets, and collect
  // the metadata needed to persist the new ones after the digest is written.
  let totalPosts = 0;
  let skippedPosts = 0;
  const toMarkSeen = []; // [{ hash, className, post }]

  // Build a deduplicated copy of notices to pass to the digest builder.
  const freshNotices = notices.map((classEntry) => {
    const freshPosts = [];
    for (const post of (classEntry.posts || [])) {
      totalPosts++;
      const hash = db.hashPost(classEntry.className, post);
      if (db.isNew(hash)) {
        freshPosts.push(post);
        toMarkSeen.push({ hash, className: classEntry.className, post });
      } else {
        skippedPosts++;
      }
    }
    return { ...classEntry, posts: freshPosts };
  });

  const newPosts = totalPosts - skippedPosts;
  console.log(`📊 Dedup: ${newPosts} new post(s), ${skippedPosts} already seen (skipped).`);

  // ── Build digest from new posts only ──────────────────────────────────────
  let md = `# TeamsPulse Digest\n\n`;
  md += `_Generated ${new Date().toISOString()} — rule-based, no AI involved._\n`;
  md += `_${newPosts} new post(s) across ${freshNotices.length} class(es); ${skippedPosts} duplicate(s) suppressed._\n\n---\n\n`;

  for (const classEntry of freshNotices) {
    md += `## ${classEntry.className}\n\n### Notices & Announcements\n\n`;
    md += buildNoticesSection(classEntry.posts || []);
    md += `\n### Assignments\n\n`;
    md += buildAssignmentsSection(assignmentsByClass[classEntry.className]);
    md += `\n---\n\n`;
  }

  fs.writeFileSync(OUTPUT_FILE, md);
  console.log(`✅ Digest saved to ${OUTPUT_FILE}`);

  // ── Persist new posts as seen ─────────────────────────────────────────────
  // Done AFTER writing the digest so a crash mid-write doesn't silently lose
  // posts — they'll simply reappear on the next run instead.
  for (const entry of toMarkSeen) {
    db.markSeen(entry.hash, { className: entry.className, post: entry.post });
  }
  console.log(`💾 Marked ${toMarkSeen.length} post(s) as seen in ${db.DB_PATH}`);

  db.close();
}

main();

