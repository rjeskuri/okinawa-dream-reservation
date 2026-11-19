// What the date field reads for a pickup and a package (#137), without the code under test. The wording is the dictionary's,
// so it stays free: this pins only which string a package kind takes, what fills its placeholders, and how a date is
// written. Each kind's string in src/i18n/strings/calendar.ts holds exactly the placeholders FIELD_PLACEHOLDERS names:
//   calendar.field.days     a package of 2 days or more:  "{pickup} → back {return} by {close}"
//   calendar.field.sameDay  a 1 day package:              "{pickup}, back by {close}"
//   calendar.field.hours    an hours package below 24:    "{pickup}, {hours} hours, back by closing"
//   calendar.field.fullDay  24, 48 or 72 hours:           "{pickup} → back {return}, same time"
//   calendar.field.empty    no pickup chosen yet:         "Pick a date"
// With no package the field reads the pickup alone. {pickup} and {return} are the day and short month in the page's
// language, as Intl writes them ("Nov 17", "11月17日", "11월 17일"); {close} is the shop's closing time as the sheet has
// it (HH:mm); {hours} is the package's hours as a plain number.
import { htmlLang } from "../../src/i18n/locales.ts";
import { calendar } from "../../src/i18n/strings/calendar.ts";
import type { Locale } from "../../src/lib/locale.ts";
import type { PackageLength } from "../../src/lib/types.ts";

export const FIELD_PLACEHOLDERS: Record<string, string[]> = {
  "calendar.field.empty": [],
  "calendar.field.days": ["close", "pickup", "return"],
  "calendar.field.sameDay": ["close", "pickup"],
  "calendar.field.hours": ["hours", "pickup"],
  "calendar.field.fullDay": ["pickup", "return"],
};

/** YYYY-MM-DD `n` days after `date`, by Date.UTC arithmetic. */
export function plusDays(date: string, n: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + n)).toISOString().slice(0, 10);
}

/** The day and short month of `date` in the locale's language. Formatted in UTC from a UTC midnight, so no zone shifts it. */
export function shortDate(locale: Locale, date: string): string {
  const format = new Intl.DateTimeFormat(htmlLang(locale), { month: "short", day: "numeric", timeZone: "UTC" });
  return format.format(new Date(`${date}T00:00:00Z`));
}

function fill(locale: Locale, key: string, values: Record<string, string>): string {
  const template = calendar[key]?.[locale];
  if (typeof template !== "string") throw new Error(`src/i18n/strings/calendar.ts has no ${locale} text for ${key}`);
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), template);
}

/** The text of the field before a pickup is chosen. */
export function emptyField(locale: Locale): string {
  return fill(locale, "calendar.field.empty", {});
}

/** The text of the field for a pickup on `pickup` of `pkg` (null: no package chosen), at a shop that closes at `shopClose`. */
export function expectedSummary(locale: Locale, pickup: string, pkg: PackageLength | null, shopClose: string): string {
  const date = (day: string) => shortDate(locale, day);
  if (pkg === null) return date(pickup);
  if (pkg.days !== null) {
    // The package returns by closing on its last day, pickup + days - 1 (ticket #11).
    if (pkg.days === 1) return fill(locale, "calendar.field.sameDay", { pickup: date(pickup), close: shopClose });
    return fill(locale, "calendar.field.days", {
      pickup: date(pickup),
      return: date(plusDays(pickup, pkg.days - 1)),
      close: shopClose,
    });
  }
  if (pkg.hours < 24) return fill(locale, "calendar.field.hours", { pickup: date(pickup), hours: String(pkg.hours) });
  if (pkg.hours % 24 === 0) {
    return fill(locale, "calendar.field.fullDay", { pickup: date(pickup), return: date(plusDays(pickup, pkg.hours / 24)) });
  }
  throw new Error(`#137 does not say what the field reads for ${pkg.hours} hours`);
}
