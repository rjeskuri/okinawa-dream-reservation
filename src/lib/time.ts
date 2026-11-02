// JST wall clocks, calendar dates and Sheets serials. JST is a fixed UTC+9 with no daylight saving, so a wall clock is
// the instant shifted by that offset, held in a Date and read through its UTC fields alone. The host's zone never
// enters.

export const JST_OFFSET_MS = 32_400_000;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const SHEET_EPOCH_WALL_MS = Date.UTC(1899, 11, 30);

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** The start of `date` as wall-clock milliseconds, for a real calendar date in strict YYYY-MM-DD. */
function parseDate(date: string): number {
  const match = DATE_PATTERN.exec(date);
  if (match === null) throw new RangeError(`invalid date: ${date}`);
  const [year, month, day] = match.slice(1).map(Number);
  // setUTCFullYear because Date.UTC reads years 0000-0099 as 19xx. A date that does not exist rolls into another month.
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  if (wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) throw new RangeError(`invalid date: ${date}`);
  return wall.getTime();
}

/** The Date holding a wall clock. NaN, Infinity and any year that YYYY-MM-DD cannot write throw. */
function wallDate(wallMs: number): Date {
  const wall = new Date(wallMs);
  const year = wall.getUTCFullYear();
  if (!(year >= 0 && year <= 9999)) throw new RangeError(`out of range: ${wallMs}`);
  return wall;
}

/** The instant of a JST wall clock. `date` is YYYY-MM-DD; `time` is what parseHHmm accepts. */
export function jstToEpoch(date: string, time = "00:00"): number {
  return parseDate(date) + parseHHmm(time) * MINUTE_MS - JST_OFFSET_MS;
}

/** The JST wall clock of an instant, seconds dropped. Weekday 0 is Sunday. */
export function epochToJst(ms: number): { date: string; time: string; weekday: number } {
  const wall = wallDate(ms + JST_OFFSET_MS);
  const iso = wall.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: wall.getUTCDay() };
}

export function jstToday(now: number): string {
  return epochToJst(now).date;
}

/** `date` moved by a whole number of days, negative for earlier. */
export function addDaysToDate(date: string, n: number): string {
  if (!Number.isInteger(n)) throw new RangeError(`not a whole number of days: ${n}`);
  return wallDate(parseDate(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `from` to `to`: negative when `to` is earlier. */
export function daysBetweenDates(from: string, to: string): number {
  return (parseDate(to) - parseDate(from)) / DAY_MS;
}

/**
 * The instant of a Sheets serial, days since 1899-12-30 00:00 in the sheet's zone, which is fixed to Asia/Tokyo.
 * A serial is a float, so the result is rounded to the nearest millisecond. The check is on the rounded wall clock, so
 * NaN, Infinity and a serial outside years 0000-9999 JST throw.
 */
export function sheetSerialToEpoch(serial: number): number {
  return wallDate(SHEET_EPOCH_WALL_MS + Math.round(serial * DAY_MS)).getTime() - JST_OFFSET_MS;
}

/** Minutes since midnight of H:mm or HH:mm. */
export function parseHHmm(s: string): number {
  const match = TIME_PATTERN.exec(s);
  if (match === null) throw new RangeError(`invalid time: ${s}`);
  const [hours, minutes] = match.slice(1).map(Number);
  if (hours > 23 || minutes > 59) throw new RangeError(`invalid time: ${s}`);
  return hours * 60 + minutes;
}

/** HH:mm of a whole number of minutes since midnight, 0 to 1439. */
export function formatHHmm(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) throw new RangeError(`invalid minutes: ${minutes}`);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}
