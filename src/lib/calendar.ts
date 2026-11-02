// The pickup calendar's month grid and return date. Everything is a YYYY-MM-DD calendar date moved through time.ts, so
// the host's zone never enters, and DatePicker.astro runs this same code in the browser.
import { addDaysToDate, daysBetweenDates, epochToJst, jstToEpoch } from "./time.ts";

export type DisabledReason = "past" | "too_far" | "closed";

export interface CalendarDay {
  date: string;
  inMonth: boolean;
  disabled: boolean;
  /** Present exactly when the day is disabled. */
  reason?: DisabledReason;
}

export interface MonthGridOptions {
  minDate: string;
  maxDate: string;
  closedDates: string[];
}

const DAYS_IN_WEEK = 7;
const MIN_WEEKS = 5;

function firstOfMonth(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

/**
 * The weeks showing a month, `month` from 1 to 12, each Sunday to Saturday. A month that fits in 4 rows gets a trailing
 * week wholly outside it, so a grid always has 5 or 6. Days outside the month are evaluated like the days inside it.
 */
export function monthGrid(year: number, month: number, opts: MonthGridOptions): CalendarDay[][] {
  const first = firstOfMonth(year, month);
  const next = month === 12 ? firstOfMonth(year + 1, 1) : firstOfMonth(year, month + 1);
  const lead = epochToJst(jstToEpoch(first)).weekday;
  const length = daysBetweenDates(first, next);
  const weeks = Math.max(MIN_WEEKS, Math.ceil((lead + length) / DAYS_IN_WEEK));
  const closed = new Set(opts.closedDates);

  return Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: DAYS_IN_WEEK }, (_, weekday) => {
      const dayOfMonth = week * DAYS_IN_WEEK + weekday - lead;
      const date = addDaysToDate(first, dayOfMonth);
      const inMonth = dayOfMonth >= 0 && dayOfMonth < length;
      // YYYY-MM-DD strings sort as dates.
      let reason: DisabledReason | undefined;
      if (date < opts.minDate) reason = "past";
      else if (date > opts.maxDate) reason = "too_far";
      else if (closed.has(date)) reason = "closed";
      return reason === undefined ? { date, inMonth, disabled: false } : { date, inMonth, disabled: true, reason };
    }),
  );
}

/** The date a package of `days` days ends: a plain addition, so 0 days returns the pickup date itself. */
export function returnDate(pickup: string, days: number): string {
  return addDaysToDate(pickup, days);
}
