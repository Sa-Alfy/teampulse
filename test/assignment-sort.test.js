"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { extractDate, extractTime, shortClassName } = require("../digest-utils");

// Re-test the exact transform and sort comparator logic used in server.js
function transformAssignment(rawClassName, a) {
  const currentYear = 2026;
  const textToScan = `${a.dueDate || ""} ${a.dueRaw || ""} ${a.details || ""}`.trim();
  const parsedDate = (a.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(a.dueDate))
    ? a.dueDate
    : extractDate(textToScan, currentYear);
  const parsedTime = extractTime(textToScan);

  let dueIso = null;
  if (parsedDate) {
    if (parsedTime) {
      const singleTime = parsedTime.includes("-")
        ? parsedTime.split(/[-–—]/).pop().trim()
        : parsedTime;
      const parsed = Date.parse(`${parsedDate} ${singleTime}`);
      if (!isNaN(parsed)) {
        dueIso = new Date(parsed).toISOString();
      }
    }
    if (!dueIso) {
      const parsed = Date.parse(`${parsedDate} 23:59:59`);
      if (!isNaN(parsed)) {
        dueIso = new Date(parsed).toISOString();
      } else {
        const fallback = Date.parse(parsedDate);
        if (!isNaN(fallback)) {
          dueIso = new Date(fallback).toISOString();
        }
      }
    }
  }

  return {
    ...a,
    dueDate: parsedDate || a.dueDate || null,
    dueTime: parsedTime || null,
    dueIso,
    className: shortClassName(rawClassName),
    rawClassName,
  };
}

function compareAssignments(a, b) {
  const dateA = a.dueIso || a.dueDate;
  const dateB = b.dueIso || b.dueDate;

  if (!dateA && !dateB) return 0;
  if (!dateA) return 1;
  if (!dateB) return -1;

  const timeA = new Date(dateA).getTime();
  const timeB = new Date(dateB).getTime();

  if (isNaN(timeA) && isNaN(timeB)) return 0;
  if (isNaN(timeA)) return 1;
  if (isNaN(timeB)) return -1;

  return timeA - timeB;
}

test("transformAssignment extracts date, time, and ISO string", () => {
  const item = transformAssignment("CSE 312 (V1)", {
    title: "Project Submission",
    details: "Due Sep 20 at 11:59 PM",
  });
  assert.strictEqual(item.dueDate, "2026-09-20");
  assert.strictEqual(item.dueTime, "11:59 PM");
  assert.ok(item.dueIso);
});

test("transformAssignment handles missing dates gracefully", () => {
  const item = transformAssignment("CSE 312 (V1)", {
    title: "CLP-01",
    details: "Due at 12:20 PM",
  });
  assert.strictEqual(item.dueDate, null);
  assert.strictEqual(item.dueTime, "12:20 PM");
  assert.strictEqual(item.dueIso, null);
});

test("compareAssignments sorts ascending and places undated assignments last", () => {
  const assignments = [
    transformAssignment("CSE 312", { title: "No date 1", details: "Module: KSA" }),
    transformAssignment("CSE 312", { title: "Later", details: "Due Oct 10" }),
    transformAssignment("CSE 312", { title: "No date 2", details: "Due at 11:59 PM" }),
    transformAssignment("CSE 312", { title: "Earlier", details: "Due Sep 15" }),
  ];

  assignments.sort(compareAssignments);

  assert.strictEqual(assignments[0].title, "Earlier");
  assert.strictEqual(assignments[1].title, "Later");
  assert.strictEqual(assignments[2].title, "No date 1");
  assert.strictEqual(assignments[3].title, "No date 2");
});
