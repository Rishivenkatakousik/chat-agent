import { test } from "node:test";
import assert from "node:assert/strict";
import { describeNow, safeTimeZone } from "../src/time/format.js";
import { resolveTimeRefs } from "../src/time/resolve-time-refs.js";
import type { TimeRef } from "../src/types.js";

const IST = "Asia/Kolkata";
// Wednesday 11 Nov 2026, 12:30 IST
const NOW = Date.parse("2026-11-11T07:00:00Z");

const labels = (refs: TimeRef[]) => refs.map((r) => r.windows.map((w) => w.label));
const one = (text: string, now = NOW, tz = IST) => {
  const refs = resolveTimeRefs(text, now, tz);
  assert.equal(refs.length, 1, `expected one ref in "${text}", got ${JSON.stringify(refs)}`);
  return refs[0]!;
};

test("describeNow", () => {
  assert.equal(describeNow(NOW, IST), "Wednesday 11 Nov 2026, 12:30 (Asia/Kolkata, UTC+05:30)");
  assert.equal(describeNow(NOW, "Not/AZone"), "Wednesday 11 Nov 2026, 07:00 (UTC, UTC+00:00)");
  assert.equal(safeTimeZone(undefined), "UTC");
});

// ── The three challenge phrasings ──

test("challenge: 'On Monday we shortlisted 5 CRM tools' → Mon 9 Nov", () => {
  const r = one("On Monday we shortlisted 5 CRM tools. Has anything changed since?");
  assert.equal(r.phrase, "Monday");
  assert.deepEqual(
    r.windows.map((w) => w.label),
    ["Mon 9 Nov 2026"],
  );
  assert.equal(r.windows[0]!.start, Date.parse("2026-11-08T18:30:00Z")); // IST midnight
  assert.equal(r.windows[0]!.end, Date.parse("2026-11-09T18:30:00Z"));
});

test("challenge: 'What did I ask you on 3 November?' → Tue 3 Nov", () => {
  const r = one("What did I ask you on 3 November? Is it still correct?");
  assert.equal(r.phrase, "3 November");
  assert.deepEqual(
    r.windows.map((w) => w.label),
    ["Tue 3 Nov 2026"],
  );
});

test("challenge: 'Last Tuesday' on a Wednesday is ambiguous → Tue 10 Nov and Tue 3 Nov", () => {
  const r = one("Last Tuesday I asked about Postgres hosting. Has pricing changed?");
  assert.equal(r.phrase, "Last Tuesday");
  assert.deepEqual(
    r.windows.map((w) => w.label),
    ["Tue 10 Nov 2026", "Tue 3 Nov 2026"],
  );
});

// ── Relative phrases ──

test("yesterday / day before yesterday / earlier today", () => {
  assert.deepEqual(labels(resolveTimeRefs("yesterday", NOW, IST)), [["Tue 10 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("the day before yesterday", NOW, IST)), [["Mon 9 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("what did we discuss earlier today", NOW, IST)), [
    ["Wed 11 Nov 2026"],
  ]);
});

test("bare 'today', future and non-time text yield nothing", () => {
  for (const t of [
    "what's the weather today",
    "next Monday let's meet",
    "tomorrow",
    "Postgres hosting prices",
    "I may switch to Neon",
  ]) {
    assert.deepEqual(resolveTimeRefs(t, NOW, IST), [], t);
  }
});

test("N days / weeks / months ago", () => {
  assert.deepEqual(labels(resolveTimeRefs("3 days ago", NOW, IST)), [["Sun 8 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("two weeks ago", NOW, IST)), [["around Wed 28 Oct 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("a couple of days ago", NOW, IST)), [["Mon 9 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("a month ago", NOW, IST)), [["October 2026"]]);
});

test("rolling ranges", () => {
  assert.deepEqual(labels(resolveTimeRefs("in the past 3 days", NOW, IST)), [
    ["Sun 8 Nov – Wed 11 Nov 2026"],
  ]);
  assert.deepEqual(labels(resolveTimeRefs("over the past week", NOW, IST)), [
    ["Wed 4 Nov – Wed 11 Nov 2026"],
  ]);
});

test("calendar weeks and months (weeks start Monday)", () => {
  assert.deepEqual(labels(resolveTimeRefs("last week", NOW, IST)), [["Mon 2 Nov – Sun 8 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("earlier this week", NOW, IST)), [["Mon 9 Nov – Wed 11 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("last month", NOW, IST)), [["October 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("this month", NOW, IST)), [["November 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("back in September", NOW, IST)), [["September 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("in December", NOW, IST)), [["December 2025"]]);
});

test("weekday variants", () => {
  assert.deepEqual(labels(resolveTimeRefs("Tuesday last week", NOW, IST)), [["Tue 3 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("last week on Friday", NOW, IST)), [["Fri 6 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("this Monday", NOW, IST)), [["Mon 9 Nov 2026"]]);
  assert.deepEqual(resolveTimeRefs("this Friday", NOW, IST), [], "this Friday is still ahead");
  // Most recent Friday is in the previous week, so "last Friday" is unambiguous.
  assert.deepEqual(labels(resolveTimeRefs("last Friday", NOW, IST)), [["Fri 6 Nov 2026"]]);
});

test("same weekday as today", () => {
  // "Wednesday" said on a Wednesday: a week ago first, today as the fallback.
  assert.deepEqual(labels(resolveTimeRefs("on Wednesday", NOW, IST)), [
    ["Wed 4 Nov 2026", "Wed 11 Nov 2026"],
  ]);
  // "last Wednesday" said on a Wednesday: exactly a week ago.
  assert.deepEqual(labels(resolveTimeRefs("last Wednesday", NOW, IST)), [["Wed 4 Nov 2026"]]);
});

// ── Absolute dates ──

test("absolute date formats", () => {
  assert.deepEqual(labels(resolveTimeRefs("on Nov 3rd", NOW, IST)), [["Tue 3 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("on 2026-11-03", NOW, IST)), [["Tue 3 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("November 3, 2025", NOW, IST)), [["Mon 3 Nov 2025"]]);
});

test("a date without a year that would be in the future rolls back a year", () => {
  assert.deepEqual(labels(resolveTimeRefs("what did I ask on 25 December?", NOW, IST)), [
    ["Thu 25 Dec 2025"],
  ]);
});

test("multiple references keep text order", () => {
  const refs = resolveTimeRefs("Compare what you said on 3 November with yesterday", NOW, IST);
  assert.deepEqual(
    refs.map((r) => r.phrase),
    ["3 November", "yesterday"],
  );
});

// ── Timezone and day boundaries ──

test("'yesterday' depends on the user's timezone near midnight", () => {
  // 2026-11-11T02:00Z is still Tue 10 Nov 18:00 in New York, but Wed 11 Nov 07:30 in Kolkata.
  const t = Date.parse("2026-11-11T02:00:00Z");
  assert.deepEqual(labels(resolveTimeRefs("yesterday", t, "America/New_York")), [["Mon 9 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("yesterday", t, IST)), [["Tue 10 Nov 2026"]]);
});

test("window boundaries are local midnights", () => {
  const w = one("3 November", NOW, "America/New_York").windows[0]!;
  assert.equal(w.start, Date.parse("2026-11-03T05:00:00Z")); // EST, UTC-5
  assert.equal(w.end, Date.parse("2026-11-04T05:00:00Z"));
});

test("a day that crosses a DST change is 25 hours long", () => {
  // US DST ended Sun 1 Nov 2026 in New York.
  const w = one("on 1 November", NOW, "America/New_York").windows[0]!;
  assert.equal(w.end - w.start, 25 * 3600_000);
});

test("weekday resolution just after local midnight", () => {
  // Thu 12 Nov 00:10 IST (Wed 11 Nov 18:40Z): "last Tuesday" → Tue 10 Nov and Tue 3 Nov, "Monday" → Mon 9 Nov.
  const t = Date.parse("2026-11-11T18:40:00Z");
  assert.deepEqual(labels(resolveTimeRefs("last Tuesday", t, IST)), [["Tue 10 Nov 2026", "Tue 3 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("Monday", t, IST)), [["Mon 9 Nov 2026"]]);
  // Same instant in UTC is still Wednesday, so "yesterday" differs.
  assert.deepEqual(labels(resolveTimeRefs("yesterday", t, "UTC")), [["Tue 10 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("yesterday", t, IST)), [["Wed 11 Nov 2026"]]);
});

test("Monday-start weeks: 'last Sunday' on a Monday is yesterday only", () => {
  const mon = Date.parse("2026-11-16T07:00:00Z"); // Mon 16 Nov IST
  assert.deepEqual(labels(resolveTimeRefs("last Sunday", mon, IST)), [["Sun 15 Nov 2026"]]);
  assert.deepEqual(labels(resolveTimeRefs("last Tuesday", mon, IST)), [["Tue 10 Nov 2026"]]);
});
