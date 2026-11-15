// The pickup calendar's month grid and return date. Everything is a YYYY-MM-DD calendar date moved through time.ts, so
// the host's zone never enters, and DatePicker.astro runs this same code in the browser.
import { addDaysToDate, daysBetweenDates, epochToJst, jstToEpoch } from "./time.ts";
import type { PackageLength } from "./types.ts";

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

/**
 * The package's last day. A package returns by closing on that day (the owner's decision on ticket #11), so the rule is
 * pickup + days - 1 and a 1 day package returns the day it was picked up. Below 1 day is a RangeError.
 */
export function returnDate(pickup: string, days: number): string {
  if (days < 1) throw new RangeError(`a package lasts at least 1 day: ${days}`);
  return addDaysToDate(pickup, days - 1);
}

/**
 * The `days` that returnDate takes for a package, which a page gives the date picker: a days package's days, and for an
 * hours package the pickup's date plus one for each whole 24 hours (#50). That is exact for a return on the pickup's own
 * clock cycle, as 2, 4 and 24 hours always are from a pickup in shop hours. A length that is back after midnight but
 * before a whole 24 hours, like 21 hours from noon, shows its return a day early.
 */
export function packageDays(pkg: PackageLength): number {
  return pkg.days ?? Math.floor(pkg.hours / 24) + 1;
}
