/**
 * Calendar building blocks: turn a day in the user's timezone into a labeled time window
 * (a day, a week, a month, a range). Everything works on TZDate, so day boundaries follow
 * the user's zone, including daylight-saving changes.
 */
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
  subDays,
} from "date-fns";
import type { LabeledWindow } from "../types.js";
import { DAY_FORMAT } from "./format.js";

/** Start of the calendar week (Monday) in the date's own timezone. */
export function weekStart(date: TZDate): TZDate {
  return startOfWeek<TZDate, TZDate>(date, { weekStartsOn: 1 });
}

/** Day offset of a weekday from Monday (Monday = 0 … Sunday = 6). `weekday` uses JS numbering (Sunday = 0). */
function daysFromMonday(weekday: number): number {
  return (weekday + 6) % 7;
}

// ── Windows ─────────────────────────────────────────────────────────

export function dayWindow(date: TZDate): LabeledWindow {
  const start = startOfDay(date);
  return { start: start.getTime(), end: addDays(start, 1).getTime(), label: format(start, DAY_FORMAT) };
}

/** From `start` up to (not including) `endExclusive`. Default label: "Mon 2 Nov – Sun 8 Nov 2026". */
export function rangeWindow(start: TZDate, endExclusive: TZDate, label?: string): LabeledWindow {
  const lastDay = subDays(endExclusive, 1);
  const sameYear = start.getFullYear() === lastDay.getFullYear();
  const startLabel = format(start, sameYear ? "EEE d MMM" : DAY_FORMAT);
  return {
    start: start.getTime(),
    end: endExclusive.getTime(),
    label: label ?? `${startLabel} – ${format(lastDay, DAY_FORMAT)}`,
  };
}

export function monthWindow(date: TZDate): LabeledWindow {
  const start = startOfMonth(date);
  return { start: start.getTime(), end: addMonths(start, 1).getTime(), label: format(start, "MMMM yyyy") };
}

/** The Monday–Sunday week that contains `date`. */
export function weekWindow(date: TZDate): LabeledWindow {
  const start = weekStart(date);
  return rangeWindow(start, addWeeks(start, 1));
}

// ── Weekdays ────────────────────────────────────────────────────────

/** Most recent date with this weekday strictly before today. */
export function previousWeekday(today: TZDate, weekday: number): TZDate {
  const daysBack = (today.getDay() - weekday + 7) % 7 || 7;
  return subDays(today, daysBack);
}

/** Bare "Monday": the most recent one. Said on a Monday it could also mean today, so both are kept. */
export function bareWeekday(today: TZDate, weekday: number): LabeledWindow[] {
  const previous = dayWindow(previousWeekday(today, weekday));
  return today.getDay() === weekday ? [previous, dayWindow(today)] : [previous];
}

/**
 * "Last Tuesday". If the most recent Tuesday is still in this calendar week, people mean
 * either it or the one a week earlier, so both are returned (nearest first).
 */
export function lastWeekday(today: TZDate, weekday: number): LabeledWindow[] {
  const previous = previousWeekday(today, weekday);
  const isInThisWeek = weekStart(previous).getTime() === weekStart(today).getTime();
  return isInThisWeek ? [dayWindow(previous), dayWindow(subDays(previous, 7))] : [dayWindow(previous)];
}

/** "This Tuesday": the one in the current week, unless it is still in the future. */
export function thisWeekday(today: TZDate, weekday: number): LabeledWindow[] {
  const date = addDays(weekStart(today), daysFromMonday(weekday));
  return date.getTime() <= today.getTime() ? [dayWindow(date)] : [];
}

/** "Tuesday last week": that weekday inside the previous calendar week. */
export function weekdayLastWeek(today: TZDate, weekday: number): LabeledWindow[] {
  const lastMonday = subDays(weekStart(today), 7);
  return [dayWindow(addDays(lastMonday, daysFromMonday(weekday)))];
}

// ── Months ──────────────────────────────────────────────────────────

/** "In October": the most recent October that has already started. `month` is 0-based. */
export function namedMonth(today: TZDate, month: number): LabeledWindow {
  let firstDay = new TZDate(today.getFullYear(), month, 1, today.timeZone!);
  if (firstDay.getTime() > today.getTime()) firstDay = addYears(firstDay, -1);
  return monthWindow(firstDay);
}
