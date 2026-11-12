import * as chrono from "chrono-node";
import { TZDate } from "@date-fns/tz";
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";
import type { TimeWindow } from "../db.js";

/**
 * Turns the time phrases in a user message ("last Tuesday", "on 3 November",
 * "2 weeks ago") into concrete windows in the user's timezone, so recall can
 * filter by date and the model sees exact dates instead of guessing.
 *
 * Ambiguity is preserved, not guessed: "last Tuesday" said on a Wednesday
 * yields both yesterday and the Tuesday before, and stored data decides.
 */

export interface LabeledWindow extends TimeWindow {
  /** Human label in the user's timezone, e.g. "Tue 3 Nov 2026". */
  label: string;
}

export interface TimeRef {
  /** The phrase as written by the user. */
  phrase: string;
  /** Candidate windows, most likely first. More than one means the phrase is ambiguous. */
  windows: LabeledWindow[];
}

/** Start of the calendar week (Monday) in the date's own timezone. */
const weekStart = (d: TZDate): TZDate => startOfWeek<TZDate, TZDate>(d, { weekStartsOn: 1 });

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_RE = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday)";

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_RE = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)";

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NUM_RE = "(\\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?few|several)";

function parseNum(s: string): number {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (t.includes("couple")) return 2;
  if (t.includes("few")) return 3;
  if (t === "several") return 4;
  return NUM_WORDS[t] ?? 1;
}

/** Returns tz if the runtime knows it, else "UTC". */
export function safeTimeZone(tz: string | undefined | null): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const toMs = (d: Date | number) => (typeof d === "number" ? d : d.getTime());

/** "Wednesday 11 Nov 2026, 12:30 (Asia/Kolkata, UTC+05:30)" */
export function describeNow(now: Date | number, tz: string): string {
  const zone = safeTimeZone(tz);
  const d = new TZDate(toMs(now), zone);
  return `${format(d, "EEEE d MMM yyyy, HH:mm")} (${zone}, UTC${format(d, "xxx")})`;
}

/** "Tue 3 Nov 2026" in the given timezone. */
export function formatDay(t: Date | number, tz: string): string {
  return format(new TZDate(toMs(t), safeTimeZone(tz)), "EEE d MMM yyyy");
}

/** "Tue 3 Nov 2026, 10:30" in the given timezone. */
export function formatDateTime(t: Date | number, tz: string): string {
  return format(new TZDate(toMs(t), safeTimeZone(tz)), "EEE d MMM yyyy, HH:mm");
}

// ── Window builders (all operate on TZDate so day boundaries follow the user's zone, DST included) ──

function dayWindow(d: TZDate): LabeledWindow {
  const start = startOfDay(d);
  return { start: start.getTime(), end: addDays(start, 1).getTime(), label: format(start, "EEE d MMM yyyy") };
}

function rangeWindow(start: TZDate, endExclusive: TZDate, label?: string): LabeledWindow {
  const last = subDays(endExclusive, 1);
  const sameYear = start.getFullYear() === last.getFullYear();
  return {
    start: start.getTime(),
    end: endExclusive.getTime(),
    label: label ?? `${format(start, sameYear ? "EEE d MMM" : "EEE d MMM yyyy")} – ${format(last, "EEE d MMM yyyy")}`,
  };
}

function monthWindow(d: TZDate): LabeledWindow {
  const start = startOfMonth(d);
  return { start: start.getTime(), end: addMonths(start, 1).getTime(), label: format(start, "MMMM yyyy") };
}

function weekWindow(d: TZDate): LabeledWindow {
  const start = weekStart(d);
  return rangeWindow(start, addWeeks(start, 1));
}

/** Most recent date with this weekday strictly before today. */
function previousWeekday(today: TZDate, weekday: number): TZDate {
  const diff = (today.getDay() - weekday + 7) % 7 || 7;
  return subDays(today, diff);
}

/** Bare "Monday": the most recent one. On a Monday it could also mean today, so both are kept. */
function bareWeekday(today: TZDate, weekday: number): LabeledWindow[] {
  const prev = previousWeekday(today, weekday);
  return today.getDay() === weekday ? [dayWindow(prev), dayWindow(today)] : [dayWindow(prev)];
}

/**
 * "Last Tuesday". If the most recent Tuesday is still in this calendar week, people
 * mean either it or the one a week earlier, so both are returned (nearest first).
 */
function lastWeekday(today: TZDate, weekday: number): LabeledWindow[] {
  const prev = previousWeekday(today, weekday);
  const inThisWeek = weekStart(prev).getTime() === weekStart(today).getTime();
  return inThisWeek ? [dayWindow(prev), dayWindow(subDays(prev, 7))] : [dayWindow(prev)];
}

/** "This Tuesday": the one in the current week, if it isn't in the future. */
function thisWeekday(today: TZDate, weekday: number): LabeledWindow[] {
  const d = addDays(weekStart(today), (weekday + 6) % 7);
  return d.getTime() <= today.getTime() ? [dayWindow(d)] : [];
}

/** "Tuesday last week": that weekday inside the previous calendar week. */
function weekdayLastWeek(today: TZDate, weekday: number): LabeledWindow[] {
  const lastMon = subDays(weekStart(today), 7);
  return [dayWindow(addDays(lastMon, (weekday + 6) % 7))];
}

/** "In October": the most recent October that has started. */
function namedMonth(today: TZDate, month: number): LabeledWindow {
  let d = new TZDate(today.getFullYear(), month, 1, today.timeZone!);
  if (d.getTime() > today.getTime()) d = addYears(d, -1);
  return monthWindow(d);
}

function weekdayIndex(name: string): number {
  return WEEKDAYS.indexOf(name.toLowerCase());
}

function monthIndex(name: string): number {
  const n = name.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(n));
}

// ── Rules, most specific first. Each matched span is masked so later rules can't re-match it. ──

type Rule = { re: RegExp; resolve: (m: RegExpExecArray, now: TZDate, today: TZDate) => LabeledWindow[] };

const rules: Rule[] = [
  // "Tuesday last week", "on Tuesday of last week", "last week on Tuesday", "last week's Tuesday"
  {
    re: new RegExp(`\\b(?:on\\s+)?${WEEKDAY_RE}\\s+(?:of\\s+)?last\\s+week\\b`, "gi"),
    resolve: (m, _n, today) => weekdayLastWeek(today, weekdayIndex(m[1]!)),
  },
  {
    re: new RegExp(`\\blast\\s+week(?:'s)?\\s+(?:on\\s+)?${WEEKDAY_RE}\\b`, "gi"),
    resolve: (m, _n, today) => weekdayLastWeek(today, weekdayIndex(m[1]!)),
  },
  // Future references are consumed and ignored, so "next Monday" never matches the bare weekday rule.
  { re: new RegExp(`\\b(?:next|coming)\\s+(?:${WEEKDAY_RE}|week|month|year)\\b`, "gi"), resolve: () => [] },
  { re: /\b(?:tomorrow|tonight)\b/gi, resolve: () => [] },
  { re: /\b(?:the\s+)?day\s+before\s+yesterday\b/gi, resolve: (_m, _n, today) => [dayWindow(subDays(today, 2))] },
  { re: /\byesterday\b/gi, resolve: (_m, _n, today) => [dayWindow(subDays(today, 1))] },
  {
    re: /\b(?:earlier\s+today|today\s+earlier|this\s+(?:morning|afternoon|evening))\b/gi,
    resolve: (_m, _n, today) => [dayWindow(today)],
  },
  // "3 days ago" (that day), "2 weeks ago" (around that day), "2 months ago" (that month)
  {
    re: new RegExp(`\\b${NUM_RE}\\s+(day|week|month)s?\\s+ago\\b`, "gi"),
    resolve: (m, _n, today) => {
      const n = parseNum(m[1]!);
      const unit = m[2]!.toLowerCase();
      if (unit === "day") return [dayWindow(subDays(today, n))];
      if (unit === "month") return [monthWindow(subMonths(today, n))];
      const center = subDays(today, 7 * n);
      return [rangeWindow(subDays(center, 3), addDays(center, 4), `around ${format(center, "EEE d MMM yyyy")}`)];
    },
  },
  // Rolling ranges: "past 3 days", "in the last two weeks", "over the past few days", "the past week"
  {
    re: new RegExp(`\\b(?:the\\s+)?(?:past|last)\\s+${NUM_RE}\\s+(day|week|month)s\\b`, "gi"),
    resolve: (m, _n, today) => {
      const n = parseNum(m[1]!);
      const unit = m[2]!.toLowerCase();
      const start = unit === "day" ? subDays(today, n) : unit === "week" ? subDays(today, 7 * n) : subMonths(today, n);
      return [rangeWindow(start, addDays(today, 1))];
    },
  },
  {
    re: /\b(?:the|this)\s+past\s+(week|month)\b|\bpast\s+(week|month)\b(?=\s*[?.!,]|\s*$)/gi,
    resolve: (m, _n, today) => {
      const unit = (m[1] ?? m[2]!).toLowerCase();
      return [rangeWindow(unit === "week" ? subDays(today, 7) : subMonths(today, 1), addDays(today, 1))];
    },
  },
  // Calendar periods
  {
    re: /\blast\s+(week|month|year)\b/gi,
    resolve: (m, _n, today) => {
      const unit = m[1]!.toLowerCase();
      if (unit === "week") return [weekWindow(subDays(today, 7))];
      if (unit === "month") return [monthWindow(subMonths(today, 1))];
      const start = startOfYear<TZDate, TZDate>(addYears(today, -1));
      return [rangeWindow(start, addYears(start, 1), format(start, "yyyy"))];
    },
  },
  {
    re: /\b(?:earlier\s+)?this\s+(week|month|year)\b/gi,
    resolve: (m, _n, today) => {
      const unit = m[1]!.toLowerCase();
      const start =
        unit === "week" ? weekStart(today) : unit === "month" ? startOfMonth(today) : startOfYear(today);
      const label = unit === "week" ? undefined : unit === "month" ? format(start, "MMMM yyyy") : format(start, "yyyy");
      return [rangeWindow(start, addDays(today, 1), label)];
    },
  },
  // Weekdays
  {
    re: new RegExp(`\\b(last|past|this)\\s+${WEEKDAY_RE}\\b`, "gi"),
    resolve: (m, _n, today) => {
      const wd = weekdayIndex(m[2]!);
      const which = m[1]!.toLowerCase();
      return which === "this" ? thisWeekday(today, wd) : which === "past" ? [dayWindow(previousWeekday(today, wd))] : lastWeekday(today, wd);
    },
  },
  {
    re: new RegExp(`\\b(?:on\\s+)?${WEEKDAY_RE}\\b`, "gi"),
    resolve: (m, _n, today) => bareWeekday(today, weekdayIndex(m[1]!)),
  },
  // Whole months, only with a lead-in word so "may" the verb isn't read as a month: "in October", "back in Sept"
  {
    re: new RegExp(`\\b(?:back\\s+in|in|during|since|last|early|late|mid|mid-)\\s+${MONTH_RE}\\b(?!\\s*\\d)`, "gi"),
    resolve: (m, _n, today) => {
      const idx = monthIndex(m[1]!);
      return idx < 0 ? [] : [namedMonth(today, idx)];
    },
  },
];

const ABSOLUTE_TEXT = new RegExp(`${MONTH_RE}|\\d{4}-\\d{1,2}-\\d{1,2}`, "i");

/** Absolute dates via chrono ("3 November", "Nov 3rd", "2026-11-03"). A date without a year that lands in the future means last year. */
function absoluteDates(masked: string, now: TZDate, today: TZDate): { index: number; text: string; windows: LabeledWindow[] }[] {
  // Chrono only supplies the calendar components; the window itself is built in the user's zone.
  const ref = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12); // system-local noon on the user's date
  const out: { index: number; text: string; windows: LabeledWindow[] }[] = [];
  for (const r of chrono.parse(masked, ref)) {
    const s = r.start;
    if (!s.isCertain("day") || !s.isCertain("month") || !ABSOLUTE_TEXT.test(r.text)) continue;
    let d = new TZDate(s.get("year") ?? now.getFullYear(), s.get("month")! - 1, s.get("day")!, today.timeZone!);
    if (!s.isCertain("year") && d.getTime() > today.getTime()) d = addYears(d, -1);
    if (d.getTime() > today.getTime()) continue; // explicit future date: not a memory cue
    const text = r.text.replace(/^on\s+/i, "");
    out.push({ index: r.index + (r.text.length - text.length), text, windows: [dayWindow(d)] });
  }
  return out;
}

/**
 * Finds past-time references in `text` relative to `now` in timezone `tz`.
 * Returns refs in the order they appear. A bare "today" is not a memory cue and is ignored.
 */
export function resolveTimeRefs(text: string, now: Date | number, tz: string): TimeRef[] {
  const zone = safeTimeZone(tz);
  const nowTz = new TZDate(toMs(now), zone);
  const today = startOfDay(nowTz);

  let masked = text;
  const found: { index: number; phrase: string; windows: LabeledWindow[] }[] = [];

  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const hits: RegExpExecArray[] = [];
    while ((m = rule.re.exec(masked))) hits.push(m);
    for (const h of hits) {
      const windows = rule.resolve(h, nowTz, today);
      const phrase = text.slice(h.index, h.index + h[0].length).replace(/^on\s+/i, "");
      if (windows.length) found.push({ index: h.index, phrase, windows });
      masked = masked.slice(0, h.index) + " ".repeat(h[0].length) + masked.slice(h.index + h[0].length);
    }
  }

  for (const a of absoluteDates(masked, nowTz, today)) found.push({ index: a.index, phrase: a.text, windows: a.windows });

  found.sort((a, b) => a.index - b.index);
  return found.map(({ phrase, windows }) => ({ phrase, windows }));
}
