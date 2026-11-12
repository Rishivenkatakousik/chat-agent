/**
 * Turns the time phrases in a user message ("last Tuesday", "on 3 November", "2 weeks ago")
 * into concrete windows in the user's timezone, so recall can filter by date and the model
 * sees exact dates instead of guessing.
 *
 * Ambiguity is preserved, not guessed: "last Tuesday" said on a Wednesday yields both
 * yesterday and the Tuesday before, and the stored conversations decide.
 *
 * How it works: a list of regex RULES (most specific first) runs over the text. Each matched
 * span is blanked out so later rules can't match it again. Remaining absolute dates
 * ("3 November") are parsed by chrono.
 */
import { TZDate } from "@date-fns/tz";
import * as chrono from "chrono-node";
import {
  addDays,
  addYears,
  format,
  startOfDay,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";
import type { LabeledWindow, TimeRef } from "../types.js";
import { DAY_FORMAT, safeTimeZone, toEpochMs } from "./format.js";
import {
  bareWeekday,
  dayWindow,
  lastWeekday,
  monthWindow,
  namedMonth,
  previousWeekday,
  rangeWindow,
  thisWeekday,
  weekdayLastWeek,
  weekStart,
  weekWindow,
} from "./windows.js";

// ── Vocabulary ──────────────────────────────────────────────────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday)";

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)";

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const NUMBER =
  "(\\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?few|several)";

/** "3" → 3, "two" → 2, "a couple of" → 2, "a few" → 3, "several" → 4. */
function parseNumber(text: string): number {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  if (normalized.includes("couple")) return 2;
  if (normalized.includes("few")) return 3;
  if (normalized === "several") return 4;
  return NUMBER_WORDS[normalized] ?? 1;
}

/** "Tuesday" → 2 (JS numbering, Sunday = 0). */
function weekdayIndex(name: string): number {
  return WEEKDAYS.indexOf(name.toLowerCase());
}

/** "Nov" or "November" → 10 (0-based); -1 if unknown. */
function monthIndex(name: string): number {
  const prefix = name.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((month) => month.startsWith(prefix));
}

type Unit = "day" | "week" | "month";

function unitOf(text: string): Unit {
  return text.toLowerCase() as Unit;
}

// ── Rules ───────────────────────────────────────────────────────────

interface Rule {
  /** Must have the global flag: every occurrence in the text is resolved. */
  pattern: RegExp;
  /** Windows for one match; an empty list means "recognised, but not a memory cue" (e.g. "next Monday"). */
  resolve: (match: RegExpMatchArray, today: TZDate) => LabeledWindow[];
}

/** "3 days ago" (that day), "2 weeks ago" (the week around that day), "2 months ago" (that month). */
function resolveAgo(count: number, unit: Unit, today: TZDate): LabeledWindow[] {
  if (unit === "day") return [dayWindow(subDays(today, count))];
  if (unit === "month") return [monthWindow(subMonths(today, count))];

  const center = subDays(today, 7 * count);
  const label = `around ${format(center, DAY_FORMAT)}`;
  return [rangeWindow(subDays(center, 3), addDays(center, 4), label)];
}

/** "past 3 days", "in the last two weeks": from that far back up to and including today. */
function resolveRollingRange(count: number, unit: Unit, today: TZDate): LabeledWindow[] {
  const startByUnit: Record<Unit, TZDate> = {
    day: subDays(today, count),
    week: subDays(today, 7 * count),
    month: subMonths(today, count),
  };
  return [rangeWindow(startByUnit[unit], addDays(today, 1))];
}

/** "last week", "last month", "last year": the previous calendar period. */
function resolveLastPeriod(unit: string, today: TZDate): LabeledWindow[] {
  switch (unit) {
    case "week":
      return [weekWindow(subDays(today, 7))];
    case "month":
      return [monthWindow(subMonths(today, 1))];
    default: {
      const start = startOfYear<TZDate, TZDate>(addYears(today, -1));
      return [rangeWindow(start, addYears(start, 1), format(start, "yyyy"))];
    }
  }
}

/** "this week", "earlier this month", "this year": from the period's start up to and including today. */
function resolveThisPeriod(unit: string, today: TZDate): LabeledWindow[] {
  const tomorrow = addDays(today, 1);
  switch (unit) {
    case "week":
      return [rangeWindow(weekStart(today), tomorrow)];
    case "month": {
      const start = startOfMonth(today);
      return [rangeWindow(start, tomorrow, format(start, "MMMM yyyy"))];
    }
    default: {
      const start = startOfYear(today);
      return [rangeWindow(start, tomorrow, format(start, "yyyy"))];
    }
  }
}

/** "last Tuesday", "past Tuesday", "this Tuesday". */
function resolveQualifiedWeekday(qualifier: string, weekday: number, today: TZDate): LabeledWindow[] {
  switch (qualifier) {
    case "this":
      return thisWeekday(today, weekday);
    case "past":
      return [dayWindow(previousWeekday(today, weekday))];
    default:
      return lastWeekday(today, weekday);
  }
}

/** Ordered most specific first: a later rule never sees text an earlier rule matched. */
const RULES: Rule[] = [
  // "Tuesday last week", "on Tuesday of last week"
  {
    pattern: new RegExp(`\\b(?:on\\s+)?${WEEKDAY}\\s+(?:of\\s+)?last\\s+week\\b`, "gi"),
    resolve: (match, today) => weekdayLastWeek(today, weekdayIndex(match[1]!)),
  },
  // "last week on Tuesday", "last week's Tuesday"
  {
    pattern: new RegExp(`\\blast\\s+week(?:'s)?\\s+(?:on\\s+)?${WEEKDAY}\\b`, "gi"),
    resolve: (match, today) => weekdayLastWeek(today, weekdayIndex(match[1]!)),
  },
  // Future references are consumed and ignored, so "next Monday" never matches the bare weekday rule.
  {
    pattern: new RegExp(`\\b(?:next|coming)\\s+(?:${WEEKDAY}|week|month|year)\\b`, "gi"),
    resolve: () => [],
  },
  { pattern: /\b(?:tomorrow|tonight)\b/gi, resolve: () => [] },
  {
    pattern: /\b(?:the\s+)?day\s+before\s+yesterday\b/gi,
    resolve: (_match, today) => [dayWindow(subDays(today, 2))],
  },
  { pattern: /\byesterday\b/gi, resolve: (_match, today) => [dayWindow(subDays(today, 1))] },
  {
    pattern: /\b(?:earlier\s+today|today\s+earlier|this\s+(?:morning|afternoon|evening))\b/gi,
    resolve: (_match, today) => [dayWindow(today)],
  },
  // "3 days ago", "two weeks ago", "a couple of months ago"
  {
    pattern: new RegExp(`\\b${NUMBER}\\s+(day|week|month)s?\\s+ago\\b`, "gi"),
    resolve: (match, today) => resolveAgo(parseNumber(match[1]!), unitOf(match[2]!), today),
  },
  // Rolling ranges: "past 3 days", "in the last two weeks", "over the past few days"
  {
    pattern: new RegExp(`\\b(?:the\\s+)?(?:past|last)\\s+${NUMBER}\\s+(day|week|month)s\\b`, "gi"),
    resolve: (match, today) => resolveRollingRange(parseNumber(match[1]!), unitOf(match[2]!), today),
  },
  // "the past week", "this past month", or "past week" at the end of a sentence
  {
    pattern: /\b(?:the|this)\s+past\s+(week|month)\b|\bpast\s+(week|month)\b(?=\s*[?.!,]|\s*$)/gi,
    resolve: (match, today) => resolveRollingRange(1, unitOf(match[1] ?? match[2]!), today),
  },
  // Calendar periods
  {
    pattern: /\blast\s+(week|month|year)\b/gi,
    resolve: (match, today) => resolveLastPeriod(match[1]!.toLowerCase(), today),
  },
  {
    pattern: /\b(?:earlier\s+)?this\s+(week|month|year)\b/gi,
    resolve: (match, today) => resolveThisPeriod(match[1]!.toLowerCase(), today),
  },
  // Weekdays
  {
    pattern: new RegExp(`\\b(last|past|this)\\s+${WEEKDAY}\\b`, "gi"),
    resolve: (match, today) =>
      resolveQualifiedWeekday(match[1]!.toLowerCase(), weekdayIndex(match[2]!), today),
  },
  {
    pattern: new RegExp(`\\b(?:on\\s+)?${WEEKDAY}\\b`, "gi"),
    resolve: (match, today) => bareWeekday(today, weekdayIndex(match[1]!)),
  },
  // Whole months, only with a lead-in word so "may" the verb isn't read as a month: "in October", "back in Sept"
  {
    pattern: new RegExp(
      `\\b(?:back\\s+in|in|during|since|last|early|late|mid|mid-)\\s+${MONTH}\\b(?!\\s*\\d)`,
      "gi",
    ),
    resolve: (match, today) => {
      const month = monthIndex(match[1]!);
      return month < 0 ? [] : [namedMonth(today, month)];
    },
  },
];

// ── Absolute dates ──────────────────────────────────────────────────

/** Text chrono must contain for us to trust it as a date: a month name or an ISO date. */
const ABSOLUTE_DATE_TEXT = new RegExp(`${MONTH}|\\d{4}-\\d{1,2}-\\d{1,2}`, "i");

interface FoundRef extends TimeRef {
  /** Position in the message, to return refs in reading order. */
  index: number;
}

/** Strips a leading "on " ("on Monday" → "Monday"). */
function withoutOn(text: string): string {
  return text.replace(/^on\s+/i, "");
}

/**
 * Absolute dates via chrono: "3 November", "Nov 3rd", "2026-11-03".
 * A date without a year that lands in the future means last year; an explicit future date is ignored.
 */
function findAbsoluteDates(text: string, now: TZDate, today: TZDate): FoundRef[] {
  // Chrono only supplies the calendar fields; the window itself is built in the user's zone.
  const reference = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12); // local noon on the user's date
  const found: FoundRef[] = [];

  for (const result of chrono.parse(text, reference)) {
    const start = result.start;
    const isFullDate = start.isCertain("day") && start.isCertain("month");
    if (!isFullDate || !ABSOLUTE_DATE_TEXT.test(result.text)) continue;

    const year = start.get("year") ?? now.getFullYear();
    let date = new TZDate(year, start.get("month")! - 1, start.get("day")!, today.timeZone!);
    if (!start.isCertain("year") && date.getTime() > today.getTime()) date = addYears(date, -1);
    if (date.getTime() > today.getTime()) continue; // explicit future date: not a memory cue

    const phrase = withoutOn(result.text);
    const index = result.index + (result.text.length - phrase.length);
    found.push({ index, phrase, windows: [dayWindow(date)] });
  }
  return found;
}

// ── Entry point ─────────────────────────────────────────────────────

/**
 * Finds past-time references in `text`, relative to `now` in timezone `timeZone`.
 * Returns them in the order they appear. A bare "today" is not a memory cue and is ignored.
 */
export function resolveTimeRefs(text: string, now: Date | number, timeZone: string): TimeRef[] {
  const nowInZone = new TZDate(toEpochMs(now), safeTimeZone(timeZone));
  const today = startOfDay(nowInZone);

  // Matched spans are replaced with spaces (same length, so positions stay valid).
  let unmatched = text;
  const found: FoundRef[] = [];

  for (const rule of RULES) {
    for (const match of [...unmatched.matchAll(rule.pattern)]) {
      const index = match.index ?? 0;
      const length = match[0].length;
      const windows = rule.resolve(match, today);
      if (windows.length > 0) {
        found.push({ index, phrase: withoutOn(text.slice(index, index + length)), windows });
      }
      unmatched = unmatched.slice(0, index) + " ".repeat(length) + unmatched.slice(index + length);
    }
  }

  found.push(...findAbsoluteDates(unmatched, nowInZone, today));
  found.sort((a, b) => a.index - b.index);
  return found.map(({ phrase, windows }) => ({ phrase, windows }));
}
