// JST (UTC+9, no daylight saving) and Sheets serial conversions. Every expected value comes from a literal, Date.UTC
// or Date.parse on an explicit +09:00 offset, never from src/lib/time.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDaysToDate,
  daysBetweenDates,
  epochToJst,
  formatHHmm,
  JST_OFFSET_MS,
  jstToday,
  jstToEpoch,
  parseHHmm,
  sheetSerialToEpoch,
} from "../src/lib/time.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const NINE_HOURS_MS = 9 * HOUR_MS;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The instant of a JST wall clock: Date.UTC minus 9 hours. */
function jstInstant(date: string, time = "00:00"): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - NINE_HOURS_MS;
}

/** YYYY-MM-DD of a calendar day; an out-of-range day rolls over the way Date.UTC rolls it. */
function isoDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// [date, time, weekday], with the weekday written out from a calendar.
const JST_TABLE: [string, string, number][] = [
  // UTC day boundary: 00:00 JST is 15:00 UTC the day before, and 09:00 JST is 00:00 UTC.
  ["2026-06-15", "00:00", 1],
  ["2026-06-15", "08:59", 1],
  ["2026-06-15", "09:00", 1],
  ["2026-06-15", "23:59", 1],
  // Month ends.
  ["2026-01-31", "23:59", 6],
  ["2026-02-01", "00:00", 0],
  ["2026-04-30", "23:59", 4],
  ["2026-05-01", "00:00", 5],
  ["2026-10-31", "23:59", 6],
  ["2026-11-01", "00:00", 0],
  // Year ends.
  ["2026-12-31", "23:59", 4],
  ["2027-01-01", "00:00", 5],
  ["2024-12-31", "23:59", 2],
  ["2025-01-01", "00:00", 3],
  ["1999-12-31", "23:59", 5],
  ["2000-01-01", "00:00", 6],
  // Leap days, the century that has one and the century that does not.
  ["2024-02-28", "23:59", 3],
  ["2024-02-29", "00:00", 4],
  ["2024-02-29", "12:34", 4],
  ["2024-02-29", "23:59", 4],
  ["2024-03-01", "00:00", 5],
  ["2000-02-29", "06:05", 2],
  ["2026-02-28", "23:59", 6],
  ["2026-03-01", "00:00", 0],
  ["2100-02-28", "23:59", 0],
  ["2100-03-01", "00:00", 1],
  // Summer and winter share one offset.
  ["2026-07-01", "12:00", 3],
  ["2026-01-01", "12:00", 4],
  // Before the epoch.
  ["1970-01-01", "00:00", 4],
];

test("jstToEpoch and epochToJst round-trip a table of dates and times", () => {
  assert.equal(JST_OFFSET_MS, 32_400_000);

  for (const [date, time, weekday] of JST_TABLE) {
    const instant = jstInstant(date, time);
    assert.equal(jstToEpoch(date, time), instant, `jstToEpoch(${date}, ${time})`);
    assert.deepEqual(epochToJst(instant), { date, time, weekday }, `epochToJst at ${date} ${time}`);
  }

  // Thousands of instants no table lists, stepping off every hour and day boundary.
  const step = 11 * HOUR_MS + 17 * MINUTE_MS;
  for (let ms = Date.UTC(1996, 0, 1); ms < Date.UTC(2032, 0, 1); ms += step) {
    const shifted = new Date(ms + NINE_HOURS_MS);
    const iso = shifted.toISOString();
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 16);
    assert.deepEqual(epochToJst(ms), { date, time, weekday: shifted.getUTCDay() }, `epochToJst(${ms})`);
    assert.equal(jstToEpoch(date, time), ms, `jstToEpoch(${date}, ${time})`);
  }

  // Seconds are dropped, not rounded up into the next minute or the next day.
  assert.deepEqual(epochToJst(Date.UTC(2026, 9, 31, 14, 59, 59, 999)), {
    date: "2026-10-31",
    time: "23:59",
    weekday: 6,
  });
  assert.deepEqual(epochToJst(Date.UTC(2026, 11, 31, 0, 7, 30)), { date: "2026-12-31", time: "09:07", weekday: 4 });
});

test("jstToEpoch without a time means 00:00 JST", () => {
  for (const [date] of JST_TABLE) {
    assert.equal(jstToEpoch(date), jstInstant(date, "00:00"), date);
  }
  assert.equal(jstToEpoch("2025-01-01"), Date.parse("2024-12-31T15:00:00Z"));
});

test("jstToday flips at 15:00 UTC", () => {
  const table: [string, string][] = [
    ["2026-10-31T14:59:59Z", "2026-10-31"],
    ["2026-10-31T14:59:59.999Z", "2026-10-31"],
    ["2026-10-31T15:00:00Z", "2026-11-01"],
    ["2026-12-31T14:59:59Z", "2026-12-31"],
    ["2026-12-31T15:00:00Z", "2027-01-01"],
    ["2026-02-28T15:00:00Z", "2026-03-01"],
    ["2028-02-28T15:00:00Z", "2028-02-29"],
    ["2028-02-29T14:59:59Z", "2028-02-29"],
    ["2028-02-29T15:00:00Z", "2028-03-01"],
  ];
  for (const [instant, today] of table) {
    assert.equal(jstToday(Date.parse(instant)), today, instant);
  }

  // Both sides of the flip on every day of six years.
  for (let day = 1; day <= 2200; day += 1) {
    const flip = Date.UTC(2024, 0, day, 15);
    assert.equal(jstToday(flip - 1), isoDate(2024, 1, day), `just before the flip on day ${day}`);
    assert.equal(jstToday(flip), isoDate(2024, 1, day + 1), `at the flip on day ${day}`);
  }
});

test("daysBetweenDates and addDaysToDate cross month, year and leap-day boundaries", () => {
  const spans: [string, string, number][] = [
    ["2026-01-31", "2026-02-01", 1],
    ["2026-03-31", "2026-04-01", 1],
    ["2026-10-31", "2026-11-01", 1],
    ["2026-02-28", "2026-03-01", 1],
    ["2024-02-28", "2024-02-29", 1],
    ["2024-02-29", "2024-03-01", 1],
    ["2024-02-28", "2024-03-01", 2],
    ["2000-02-28", "2000-03-01", 2],
    ["2100-02-28", "2100-03-01", 1],
    ["2026-12-31", "2027-01-01", 1],
    ["2026-12-25", "2027-01-05", 11],
    ["2026-01-01", "2027-01-01", 365],
    ["2024-01-01", "2025-01-01", 366],
    ["2024-02-29", "2025-03-01", 366],
    ["2024-02-29", "2028-02-29", 1461],
    ["2026-11-02", "2026-11-02", 0],
  ];
  for (const [from, to, days] of spans) {
    assert.equal(daysBetweenDates(from, to), days, `daysBetweenDates(${from}, ${to})`);
    assert.equal(daysBetweenDates(to, from), 0 - days, `daysBetweenDates(${to}, ${from})`);
    assert.equal(addDaysToDate(from, days), to, `addDaysToDate(${from}, ${days})`);
    assert.equal(addDaysToDate(to, 0 - days), from, `addDaysToDate(${to}, ${0 - days})`);
  }

  // Start dates and offsets no table lists, both directions.
  const offsets = [1, 2, 27, 28, 29, 30, 31, 59, 60, 61, 364, 365, 366, 367, 1000, 1461, 3653];
  for (let start = 1; start < 3000; start += 17) {
    const from = isoDate(2019, 1, start);
    for (const days of offsets) {
      const later = isoDate(2019, 1, start + days);
      const earlier = isoDate(2019, 1, start - days);
      assert.equal(addDaysToDate(from, days), later, `addDaysToDate(${from}, ${days})`);
      assert.equal(addDaysToDate(from, 0 - days), earlier, `addDaysToDate(${from}, ${0 - days})`);
      assert.equal(daysBetweenDates(from, later), days, `daysBetweenDates(${from}, ${later})`);
      assert.equal(daysBetweenDates(from, earlier), 0 - days, `daysBetweenDates(${from}, ${earlier})`);
    }
  }
});

test("sheetSerialToEpoch converts Asia/Tokyo serials", () => {
  const table: [number, string][] = [
    [45658.375, "2025-01-01T09:00:00+09:00"],
    [45658, "2025-01-01T00:00:00+09:00"],
    [45658.5, "2025-01-01T12:00:00+09:00"],
    [45658 + 17 / 24, "2025-01-01T17:00:00+09:00"],
    [45657 + 1439 / 1440, "2024-12-31T23:59:00+09:00"],
    [45658 + 1 / 86_400, "2025-01-01T00:00:01+09:00"],
    [45351.5, "2024-02-29T12:00:00+09:00"],
    [46023, "2026-01-01T00:00:00+09:00"],
    [46326.75, "2026-10-31T18:00:00+09:00"],
    [25569, "1970-01-01T00:00:00+09:00"],
    [61, "1900-03-01T00:00:00+09:00"],
    [2, "1900-01-01T00:00:00+09:00"],
    [1, "1899-12-31T00:00:00+09:00"],
    [0, "1899-12-30T00:00:00+09:00"],
    // The nearest millisecond, not the nearest second. As doubles these sit up to 0.0003 ms off the whole millisecond,
    // some of them below it, so truncating fails too.
    [45658 + 0.5 / 86_400, "2025-01-01T00:00:00.500+09:00"],
    [45658 + 0.001 / 86_400, "2025-01-01T00:00:00.001+09:00"],
    [45658 + 1.999 / 86_400, "2025-01-01T00:00:01.999+09:00"],
    [45351.5 + 0.25 / 86_400, "2024-02-29T12:00:00.250+09:00"],
    // Between two milliseconds, rounded to the closer one on both sides of the Unix epoch.
    [45658 + 1.4 / 86_400_000, "2025-01-01T00:00:00.001+09:00"],
    [45658 + 1.6 / 86_400_000, "2025-01-01T00:00:00.002+09:00"],
    [2 + 1.4 / 86_400_000, "1900-01-01T00:00:00.001+09:00"],
    [2 + 1.6 / 86_400_000, "1900-01-01T00:00:00.002+09:00"],
  ];
  for (const [serial, instant] of table) {
    assert.equal(sheetSerialToEpoch(serial), Date.parse(instant), `sheetSerialToEpoch(${serial})`);
  }

  // Day counts and clock times no table lists. A serial is a float, so each must land on the exact whole millisecond:
  // first whole minutes, then clock times that fall between whole seconds.
  for (let day = 36_526; day < 55_000; day += 97) {
    for (let minute = 0; minute < 1440; minute += 61) {
      const expected = Date.UTC(1899, 11, 30 + day, 0, minute) - NINE_HOURS_MS;
      assert.equal(sheetSerialToEpoch(day + minute / 1440), expected, `day ${day}, minute ${minute}`);
    }
    for (let ms = 1; ms < 86_400_000; ms += 7_654_321) {
      const expected = Date.UTC(1899, 11, 30 + day, 0, 0, 0, ms) - NINE_HOURS_MS;
      assert.equal(sheetSerialToEpoch(day + ms / 86_400_000), expected, `day ${day}, ms ${ms}`);
    }
  }
});

test("invalid dates and times throw RangeError", () => {
  const badDates = [
    "2026-02-30",
    "2026-02-29",
    "2100-02-29",
    "2026-04-31",
    "2026-06-31",
    "2026-09-31",
    "2026-11-31",
    "2026-01-32",
    "2026-01-00",
    "2026-00-10",
    "2026-13-01",
    "2026-1-05",
    "2026-01-5",
    "26-01-05",
    "02026-01-05",
    "2026/01/05",
    "20260105",
    "2026-01-05T00:00",
    "2026-01-05 ",
    " 2026-01-05",
    "２０２６-０１-０５",
    "2026-1O-05",
    "2026-1x-05",
    "2026-01-1x",
    "2026-12-3 ",
    "2026-12- 3",
    "2026- 1-05",
    "not a date",
    "",
  ];
  for (const date of badDates) {
    assert.throws(() => jstToEpoch(date), RangeError, `jstToEpoch(${JSON.stringify(date)})`);
    assert.throws(() => jstToEpoch(date, "12:00"), RangeError, `jstToEpoch(${JSON.stringify(date)}, 12:00)`);
    assert.throws(() => addDaysToDate(date, 1), RangeError, `addDaysToDate(${JSON.stringify(date)}, 1)`);
    assert.throws(() => daysBetweenDates(date, "2026-03-01"), RangeError, `from ${JSON.stringify(date)}`);
    assert.throws(() => daysBetweenDates("2026-03-01", date), RangeError, `to ${JSON.stringify(date)}`);
  }

  const badTimes = [
    "24:00",
    "9:7",
    "24:01",
    "25:00",
    "23:60",
    "12:5",
    "12:005",
    "012:00",
    "1200",
    "12",
    ":30",
    "12:",
    "12:00:00",
    " 12:00",
    "12:00 ",
    "-1:00",
    "12:-5",
    "12:3O",
    "12:3x",
    "1O:30",
    "1x:30",
    " 9:30",
    "9 :30",
    "+9:30",
    "12:5 ",
    "12: 5",
    "ab:cd",
    "１２:００",
    "",
  ];
  for (const time of badTimes) {
    assert.throws(() => jstToEpoch("2026-03-01", time), RangeError, `jstToEpoch with ${JSON.stringify(time)}`);
    assert.throws(() => parseHHmm(time), RangeError, `parseHHmm(${JSON.stringify(time)})`);
  }

  // The calendar decides, not a list: every day slot of every month, valid ones included. A century is a leap year only
  // when divisible by 400, so the years hold both kinds of century on both sides of 2000.
  for (const year of [1800, 1900, 2000, 2023, 2024, 2100, 2200, 2300, 2400]) {
    for (let month = 0; month <= 13; month += 1) {
      for (let day = 0; day <= 32; day += 1) {
        const date = `${year}-${pad(month)}-${pad(day)}`;
        const real = month >= 1 && month <= 12 && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
        if (real) {
          assert.equal(jstToEpoch(date), jstInstant(date), date);
          assert.equal(addDaysToDate(date, 0), date, date);
        } else {
          assert.throws(() => jstToEpoch(date), RangeError, date);
          assert.throws(() => addDaysToDate(date, 0), RangeError, date);
        }
      }
    }
  }

  // The same for the clock.
  for (let hour = 0; hour <= 30; hour += 1) {
    for (let minute = 0; minute <= 65; minute += 1) {
      const time = `${pad(hour)}:${pad(minute)}`;
      if (hour < 24 && minute < 60) {
        assert.equal(parseHHmm(time), hour * 60 + minute, time);
        assert.equal(jstToEpoch("2026-03-01", time), jstInstant("2026-03-01", time), time);
      } else {
        assert.throws(() => parseHHmm(time), RangeError, time);
        assert.throws(() => jstToEpoch("2026-03-01", time), RangeError, time);
      }
    }
  }

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => epochToJst(bad), RangeError, `epochToJst(${bad})`);
    assert.throws(() => jstToday(bad), RangeError, `jstToday(${bad})`);
    assert.throws(() => sheetSerialToEpoch(bad), RangeError, `sheetSerialToEpoch(${bad})`);
    assert.throws(() => addDaysToDate("2026-03-01", bad), RangeError, `addDaysToDate by ${bad}`);
    assert.throws(() => formatHHmm(bad), RangeError, `formatHHmm(${bad})`);
  }
  // Whole days only. These sit outside the loop above because its other helpers take fractions: a serial is one.
  for (const days of [1.5, -1.5, 0.1]) {
    assert.throws(() => addDaysToDate("2026-03-01", days), RangeError, `addDaysToDate by ${days}`);
  }
  for (const minutes of [-1, 1440, 1441, 1.5]) {
    assert.throws(() => formatHHmm(minutes), RangeError, `formatHHmm(${minutes})`);
  }
});

test("fractional inputs throw RangeError", () => {
  // Every k in both directions from several start dates, so no list of fixture values can pass.
  for (const date of ["2026-03-01", "2024-02-29", "1999-12-31"]) {
    for (let k = -1500; k <= 1500; k += 1) {
      for (const days of [k + 0.5, k + 0.25]) {
        assert.throws(() => addDaysToDate(date, days), RangeError, `addDaysToDate(${date}, ${days})`);
      }
    }
  }

  // All inside 0..1439, so the whole-minutes rule has to refuse them: the range rule would let them through.
  for (let k = 0; k < 1439; k += 1) {
    for (const minutes of [k + 0.5, k + 0.25]) {
      assert.throws(() => formatHHmm(minutes), RangeError, `formatHHmm(${minutes})`);
    }
  }
});

test("parseHHmm and formatHHmm cover every minute of the day", () => {
  const table: [string, number][] = [
    ["00:00", 0],
    ["00:01", 1],
    ["00:59", 59],
    ["01:00", 60],
    ["09:00", 540],
    ["09:07", 547],
    ["12:05", 725],
    ["23:59", 1439],
  ];
  for (const [text, minutes] of table) {
    assert.equal(parseHHmm(text), minutes, text);
    assert.equal(formatHHmm(minutes), text, String(minutes));
  }

  for (let minutes = 0; minutes < 1440; minutes += 1) {
    const hour = Math.floor(minutes / 60);
    const text = `${pad(hour)}:${pad(minutes % 60)}`;
    assert.equal(formatHHmm(minutes), text, String(minutes));
    assert.equal(parseHHmm(text), minutes, text);
    // A sheet cell writes 9:00 as readily as 09:00, and jstToEpoch takes whatever parseHHmm takes.
    const unpadded = `${hour}:${pad(minutes % 60)}`;
    assert.equal(parseHHmm(unpadded), minutes, unpadded);
    assert.equal(jstToEpoch("2026-03-01", unpadded), jstInstant("2026-03-01", text), `jstToEpoch with ${unpadded}`);
  }
});

test("JST conversions do not depend on the host time zone", () => {
  // [zone, Date#getTimezoneOffset in January], the second proving the switch took effect.
  const hostZones: [string, number][] = [
    ["UTC", 0],
    ["Asia/Tokyo", -540],
    ["America/New_York", 300],
    ["Europe/London", 0],
    ["Pacific/Kiritimati", -840],
    ["Pacific/Pago_Pago", 660],
  ];
  // Wall clocks a host's daylight saving skips or repeats, plus plain ones.
  const wallClocks: [string, string][] = [
    ["2026-03-08", "02:30"],
    ["2026-03-29", "01:30"],
    ["2026-11-01", "01:30"],
    ["2026-06-15", "12:00"],
    ["2026-12-31", "23:59"],
  ];
  const hostZone = process.env.TZ;
  try {
    for (const [zone, januaryOffset] of hostZones) {
      process.env.TZ = zone;
      assert.equal(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset(), januaryOffset, `TZ=${zone} did not apply`);

      for (const [date, time] of wallClocks) {
        const instant = jstInstant(date, time);
        const label = `${date} ${time} on a ${zone} host`;
        assert.equal(jstToEpoch(date, time), instant, label);
        assert.deepEqual(epochToJst(instant), { date, time, weekday: weekdayOf(date) }, label);
        assert.equal(jstToday(instant), date, label);
      }
      assert.equal(daysBetweenDates("2026-03-01", "2026-04-01"), 31, zone);
      assert.equal(daysBetweenDates("2026-10-25", "2026-11-02"), 8, zone);
      assert.equal(addDaysToDate("2026-03-07", 1), "2026-03-08", zone);
      assert.equal(addDaysToDate("2026-03-28", 2), "2026-03-30", zone);
    }
  } finally {
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  }
});
