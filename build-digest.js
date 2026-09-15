const fs = require("fs");

const NOTICES_FILE = "notices.json";
const ASSIGNMENTS_FILE = "assignments.json";
const OUTPUT_FILE = "digest.md";

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

// ---------------------------------------------------------------------------
// Pure rule-based extraction — regex + keyword matching only, no AI
// ---------------------------------------------------------------------------

function extractDate(text, fallbackYear) {
  if (!text) return null;

  // DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY
  let m = text.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/);
  if (m) {
    const day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // "26th August"
  m = text.match(/\b(\d{1,2})(st|nd|rd|th)?\s+([A-Za-z]{3,9})\b/);
  if (m && MONTHS[m[3].toLowerCase()] !== undefined) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[3].toLowerCase()];
    return `${fallbackYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // "Aug 21" / "Sep 2"
  m = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})\b/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const day = parseInt(m[2], 10);
    if (day >= 1 && day <= 31) {
      const month = MONTHS[m[1].toLowerCase()];
      return `${fallbackYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return null;
}

function extractTime(text) {
  if (!text) return null;
  // Support ranges like "9:30-11:00 am", "7PM-9PM", "9:30 AM – 12:30 PM"
  const rangeMatch = text.match(
    /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm)?\s*[-–—to]+\s*\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm))\b/i
  );
  if (rangeMatch) return rangeMatch[0].replace(/\s+/g, " ").trim();

  // Single times like "9:30 AM", "7:30 pm", "11:59 PM"
  const singleMatch = text.match(
    /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:AM|PM|am|pm))\b/i
  );
  return singleMatch ? singleMatch[0].replace(/\s+/g, " ").trim() : null;
}

function classify(text) {
  const t = text.toLowerCase();
  if (/\bct\b|class test|\bquiz\b/.test(t)) return "🧪 CT/Quiz";
  if (/\bfinal\b|\bexam\b|mid ?term/.test(t)) return "📝 Exam";
  if (/presentation/.test(t)) return "🎤 Presentation";
  if (/reschedul|makeup|make-up|postpon/.test(t)) return "🔄 Reschedule";
  if (/\bcancel/.test(t)) return "❌ Cancelled";
  if (/\bdue\b|deadline|\bsubmit/.test(t)) return "📌 Deadline";
  if (/\bmarks\b|\bgrade|\bresult/.test(t)) return "📊 Grades";
  return "📢 Notice";
}

function isNoteworthy(post) {
  const combined = `${post.subject || ""} ${post.body || ""}`.trim();
  if (post.body === "Loading...") return false;
  if (!combined && (!post.attachments || !post.attachments.length) && (!post.urlPreviews || !post.urlPreviews.length)) {
    return false;
  }
  if (post.isAnnouncement) return true;
  if (post.isBot) return true;

  const hasDate = /\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}\b/.test(combined);
  const hasKeyword =
    /\b(ct|class test|quiz|exam|final|midterm|presentation|reschedul|makeup|postpon|cancel|due|deadline|submit|marks|grade|result)\b/i.test(
      combined
    );
  return hasDate || hasKeyword;
}

function truncate(text, max = 90) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function escapeCell(text) {
  return (text || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

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

  const notices = JSON.parse(fs.readFileSync(NOTICES_FILE, "utf-8"));
  const assignments = fs.existsSync(ASSIGNMENTS_FILE) ? JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, "utf-8")) : [];

  const assignmentsByClass = {};
  for (const entry of assignments) assignmentsByClass[entry.className] = entry.assignments || [];

  let md = `# TeamsPulse Digest\n\n_Generated ${new Date().toISOString()} — rule-based, no AI involved._\n\n---\n\n`;

  for (const classEntry of notices) {
    md += `## ${classEntry.className}\n\n### Notices & Announcements\n\n`;
    md += buildNoticesSection(classEntry.posts || []);
    md += `\n### Assignments\n\n`;
    md += buildAssignmentsSection(assignmentsByClass[classEntry.className]);
    md += `\n---\n\n`;
  }

  fs.writeFileSync(OUTPUT_FILE, md);
  console.log(`✅ Done. Saved to ${OUTPUT_FILE}`);
}

main();

