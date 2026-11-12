/**
 * Formatting dates for people and for the model, always in the user's own timezone.
 */
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

/** "Tue 3 Nov 2026": the label format for a single day. */
export const DAY_FORMAT = "EEE d MMM yyyy";

/** Returns `timeZone` if the runtime knows it, else "UTC". */
export function safeTimeZone(timeZone: string | undefined | null): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

export function toEpochMs(time: Date | number): number {
  return typeof time === "number" ? time : time.getTime();
}

function inZone(time: Date | number, timeZone: string): TZDate {
  return new TZDate(toEpochMs(time), safeTimeZone(timeZone));
}

/** "Wednesday 11 Nov 2026, 12:30 (Asia/Kolkata, UTC+05:30)" */
export function describeNow(now: Date | number, timeZone: string): string {
  const zone = safeTimeZone(timeZone);
  const date = inZone(now, zone);
  return `${format(date, "EEEE d MMM yyyy, HH:mm")} (${zone}, UTC${format(date, "xxx")})`;
}

/** "Tue 3 Nov 2026" */
export function formatDay(time: Date | number, timeZone: string): string {
  return format(inZone(time, timeZone), DAY_FORMAT);
}

/** "Tue 3 Nov 2026, 10:30" */
export function formatDateTime(time: Date | number, timeZone: string): string {
  return format(inZone(time, timeZone), `${DAY_FORMAT}, HH:mm`);
}

/** "2026-11-03" */
export function formatIsoDay(time: Date | number, timeZone: string): string {
  return format(inZone(time, timeZone), "yyyy-MM-dd");
}
