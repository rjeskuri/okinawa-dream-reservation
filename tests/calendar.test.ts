// The pickup calendar's pure functions. Expected values come from literals and Date.UTC arithmetic in this file, never
// from src/lib/calendar.ts. jstToday is imported only because it is how a minDate is derived from an instant.
import assert from "node:assert/strict";
import { test } from "node:test";
import { monthGrid, returnDate } from "../src/lib/calendar.ts";
import { jstToday } from "../src/lib/time.ts";

type Reason = "past" | "too_far" | "closed";
type Day = { date: string; inMonth: boolean; disabled: boolean; reason?: Reason };
type Opts = { minDate: string; maxDate: string; closedDates: string[] };

const HOUR_MS = 3_600_000;

/** A window wide enough that nothing in these tests falls outside it. */
const OPEN: Opts = { minDate: "1900-01-01", maxDate: "2999-12-31", closedDates: [] };

/** YYYY-MM-DD of a calendar day; an out-of-range day rolls over the way Date.UTC rolls it. */
function isoDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** The weeks a grid has: enough to cover the month, and never fewer than the five the ticket allows. */
function weeksOf(year: number, month: number): number {
  const lead = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.max(5, Math.ceil((lead + length) / 7));
}

function expectedDay(date: string, inMonth: boolean, opts: Opts): Day {
  // Outside the window wins over closed, in the ticket's order: past, too_far, closed.
  let reason: Reason | undefined;
  if (date < opts.minDate) reason = "past";
  else if (date > opts.maxDate) reason = "too_far";
  else if (opts.closedDates.includes(date)) reason = "closed";
  return reason === undefined ? { date, inMonth, disabled: false } : { date, inMonth, disabled: true, reason };
}

function expectedGrid(year: number, month: number, opts: Opts): Day[][] {
  const lead = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: weeksOf(year, month) }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const day = 1 - lead + week * 7 + weekday;
      return expectedDay(isoDate(year, month, day), day >= 1 && day <= length, opts);
    }),
  );
}

function assertGridShape(grid: Day[][], year: number, month: number, label: string): void {
  const weeks = weeksOf(year, month);
  const lead = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();

  assert.equal(grid.length, weeks, `${label}: week count`);
  for (const week of grid) {
    assert.equal(week.length, 7, `${label}: days in a week`);
    assert.equal(weekdayOf(week[0].date), 0, `${label}: ${week[0].date} starts a week`);
  }

  // Consecutive from the first Sunday, so no gap and no duplicate.
  const days = grid.flat();
  const dates = Array.from({ length: weeks * 7 }, (_, i) => isoDate(year, month, 1 - lead + i));
  assert.deepEqual(
    days.map((day) => day.date),
    dates,
    `${label}: dates`,
  );

  // inMonth holds for each day of the month, once and in order, and for no other day.
  const monthDays = Array.from({ length }, (_, i) => isoDate(year, month, i + 1));
  assert.deepEqual(
    days.filter((day) => day.inMonth).map((day) => day.date),
    monthDays,
    `${label}: days in the month`,
  );
}

/** Each [zone, Date#getTimezoneOffset in January] as the host's zone; the offset proves the switch took effect. */
function inEachHostZone(check: (zone: string) => void): void {
  const hostZones: [string, number][] = [
    ["UTC", 0],
    ["Asia/Tokyo", -540],
    ["America/New_York", 300],
    ["Europe/London", 0],
    ["Pacific/Kiritimati", -840],
    ["Pacific/Pago_Pago", 660],
  ];
  const hostZone = process.env.TZ;
  try {
    for (const [zone, januaryOffset] of hostZones) {
      process.env.TZ = zone;
      assert.equal(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset(), januaryOffset, `TZ=${zone} did not apply`);
      check(zone);
    }
  } finally {
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  }
}

test("grids start on Sunday and cover the month", () => {
  // [year, month, days in the month, first cell, last cell, weeks], written out from a calendar.
  const table: [number, number, number, string, string, number][] = [
    // Februaries. 2026 starts on a Sunday and fills exactly four rows, so a fifth, wholly March, week keeps the contract
    // of 5 or 6 weeks. 2032 is the leap year that starts on a Sunday, so its 29th alone spills into a fifth week.
    [2026, 2, 28, "2026-02-01", "2026-03-07", 5],
    [2032, 2, 29, "2032-02-01", "2032-03-06", 5],
    [2028, 2, 29, "2028-01-30", "2028-03-04", 5],
    [2100, 2, 28, "2100-01-31", "2100-03-06", 5],
    // Months that start on a Saturday: six weeks when they have 30 or 31 days, five in February.
    [2026, 8, 31, "2026-07-26", "2026-09-05", 6],
    [2025, 11, 30, "2025-10-26", "2025-12-06", 6],
    [2025, 2, 28, "2025-01-26", "2025-03-01", 5],
    [2020, 2, 29, "2020-01-26", "2020-02-29", 5],
    // A Friday start with 31 days needs six weeks; with five it would drop the 31st.
    [2026, 5, 31, "2026-04-26", "2026-06-06", 6],
    // Ordinary months, one starting on a Sunday and one ending on a Saturday, with no days outside on that side.
    [2026, 11, 30, "2026-11-01", "2026-12-05", 5],
    [2026, 10, 31, "2026-09-27", "2026-10-31", 5],
    // Grids that cross a year end.
    [2026, 12, 31, "2026-11-29", "2027-01-02", 5],
    [2027, 1, 31, "2026-12-27", "2027-02-06", 6],
  ];
  for (const [year, month, length, first, last, weeks] of table) {
    const label = `${year}-${month}`;
    const grid = monthGrid(year, month, OPEN);
    assert.equal(grid.length, weeks, `${label}: week count`);
    assert.equal(grid[0][0].date, first, `${label}: first cell`);
    assert.equal(grid[weeks - 1][6].date, last, `${label}: last cell`);
    assert.equal(grid.flat().filter((day) => day.inMonth).length, length, `${label}: days in the month`);
    assertGridShape(grid, year, month, label);
  }

  // Every month of 26 years, which holds every start weekday, the 4-row Februaries of 2015, 2026 and 2037, and 2032.
  for (let year = 2015; year <= 2040; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      assertGridShape(monthGrid(year, month, OPEN), year, month, `${year}-${month}`);
    }
  }

  // The dates are calendar dates, so the host's zone and its daylight saving never enter.
  inEachHostZone((zone) => {
    for (const year of [2026, 2027, 2028]) {
      for (let month = 1; month <= 12; month += 1) {
        assertGridShape(monthGrid(year, month, OPEN), year, month, `${year}-${month} on a ${zone} host`);
      }
    }
  });
});

test("days before min, after max and closed are disabled with reasons", () => {
  // [date, inMonth, reason], with null for a selectable day.
  type Spot = [string, boolean, Reason | null];
  const scenarios: { label: string; year: number; month: number; opts: Opts; spots: Spot[] }[] = [
    {
      label: "each reason, and the days next to each boundary",
      year: 2026,
      month: 11,
      opts: { minDate: "2026-11-10", maxDate: "2026-11-20", closedDates: ["2026-11-15", "2026-11-14"] },
      spots: [
        ["2026-11-01", true, "past"],
        ["2026-11-09", true, "past"],
        ["2026-11-10", true, null],
        ["2026-11-13", true, null],
        ["2026-11-14", true, "closed"],
        ["2026-11-15", true, "closed"],
        ["2026-11-16", true, null],
        ["2026-11-20", true, null],
        ["2026-11-21", true, "too_far"],
        ["2026-11-30", true, "too_far"],
        ["2026-12-05", false, "too_far"],
      ],
    },
    {
      label: "closed on the boundaries, and closed outside the window",
      year: 2026,
      month: 11,
      opts: {
        minDate: "2026-11-10",
        maxDate: "2026-11-20",
        closedDates: ["2026-11-05", "2026-11-10", "2026-11-20", "2026-11-25", "2026-11-25"],
      },
      spots: [
        ["2026-11-05", true, "past"],
        ["2026-11-10", true, "closed"],
        ["2026-11-11", true, null],
        ["2026-11-19", true, null],
        ["2026-11-20", true, "closed"],
        ["2026-11-25", true, "too_far"],
      ],
    },
    {
      label: "days outside the month are evaluated like any other",
      year: 2026,
      month: 8,
      opts: {
        minDate: "2026-07-28",
        maxDate: "2026-09-03",
        closedDates: ["2026-07-30", "2026-09-02"],
      },
      spots: [
        ["2026-07-26", false, "past"],
        ["2026-07-27", false, "past"],
        ["2026-07-28", false, null],
        ["2026-07-29", false, null],
        ["2026-07-30", false, "closed"],
        ["2026-08-01", true, null],
        ["2026-09-01", false, null],
        ["2026-09-02", false, "closed"],
        ["2026-09-03", false, null],
        ["2026-09-04", false, "too_far"],
        ["2026-09-05", false, "too_far"],
      ],
    },
    {
      label: "a window across a year end, and a closed date from another year",
      year: 2027,
      month: 1,
      opts: {
        minDate: "2026-12-30",
        maxDate: "2027-01-05",
        closedDates: ["2027-01-01", "2026-01-02", "2028-01-03"],
      },
      spots: [
        ["2026-12-29", false, "past"],
        ["2026-12-30", false, null],
        ["2026-12-31", false, null],
        ["2027-01-01", true, "closed"],
        ["2027-01-02", true, null],
        ["2027-01-03", true, null],
        ["2027-01-05", true, null],
        ["2027-01-06", true, "too_far"],
        ["2027-02-06", false, "too_far"],
      ],
    },
    {
      label: "a one-day window",
      year: 2026,
      month: 11,
      opts: { minDate: "2026-11-18", maxDate: "2026-11-18", closedDates: [] },
      spots: [
        ["2026-11-17", true, "past"],
        ["2026-11-18", true, null],
        ["2026-11-19", true, "too_far"],
      ],
    },
  ];
  for (const { label, year, month, opts, spots } of scenarios) {
    const days = monthGrid(year, month, opts).flat();
    for (const [date, inMonth, reason] of spots) {
      const expected: Day =
        reason === null ? { date, inMonth, disabled: false } : { date, inMonth, disabled: true, reason };
      assert.deepEqual(
        days.find((day) => day.date === date),
        expected,
        `${label}: ${date}`,
      );
    }
  }

  // A month wholly on one side of the window is disabled throughout, with that side's reason.
  const window: Opts = { minDate: "2026-11-01", maxDate: "2027-01-30", closedDates: ["2026-10-07", "2027-03-03"] };
  const reasonsIn = (year: number, month: number): Set<Reason | undefined> =>
    new Set(
      monthGrid(year, month, window)
        .flat()
        .map((day) => day.reason),
    );
  assert.deepEqual(reasonsIn(2026, 10), new Set(["past"]));
  assert.deepEqual(reasonsIn(2027, 3), new Set(["too_far"]));

  // Windows and closed dates no table lists: each is placed relative to the month, so it moves with the month, and the
  // closed list is out of order with duplicates and dates on both boundaries.
  const windows: [number, number][] = [
    [-3, 10],
    [1, 1],
    [5, 20],
    [15, 40],
    [40, 45],
    [-60, -30],
  ];
  for (const year of [2026, 2027, 2028]) {
    for (let month = 1; month <= 12; month += 1) {
      for (const [from, to] of windows) {
        const on = (day: number): string => isoDate(year, month, day);
        const opts: Opts = {
          minDate: on(from),
          maxDate: on(to),
          closedDates: [on(to), on(12), on(33), on(12), on(from), on(-1)],
        };
        const label = `${year}-${month} from ${opts.minDate} to ${opts.maxDate}`;
        const grid = monthGrid(year, month, opts);
        // Strict equality: a selectable day has no reason key, not one set to undefined.
        assert.deepEqual(grid, expectedGrid(year, month, opts), label);
        for (const day of grid.flat()) {
          assert.equal(Object.hasOwn(day, "reason"), day.disabled, `${label}: reason key on ${day.date}`);
        }
      }
    }
  }
});

test("min date follows the JST day", () => {
  // [now, min_lead_hours, the JST date of now + lead], the date written out by hand.
  const table: [string, number, string][] = [
    // The ticket's case, and the millisecond before it.
    ["2026-10-31T15:00:00Z", 0, "2026-11-01"],
    ["2026-10-31T14:59:59.999Z", 0, "2026-10-31"],
    // After 15:00 UTC the UTC date is still the day before.
    ["2026-10-30T16:00:00Z", 0, "2026-10-31"],
    ["2026-10-31T00:00:00Z", 0, "2026-10-31"],
    // The lead moves the instant, not the date: 23:00 JST stays on the day and 01:00 JST does not.
    ["2026-10-31T10:00:00Z", 4, "2026-10-31"],
    ["2026-10-31T10:00:00Z", 6, "2026-11-01"],
    ["2026-10-31T14:59:59.999Z", 1, "2026-11-01"],
    ["2026-10-31T15:00:00Z", 48, "2026-11-03"],
    // Year end and a leap day.
    ["2026-12-31T14:59:59.999Z", 0, "2026-12-31"],
    ["2026-12-31T15:00:00Z", 0, "2027-01-01"],
    ["2028-02-28T15:00:00Z", 0, "2028-02-29"],
    ["2028-02-29T15:00:00Z", 0, "2028-03-01"],
  ];
  for (const [now, leadHours, expectedMin] of table) {
    const label = `${now} with a ${leadHours} hour lead`;
    const minDate = jstToday(Date.parse(now) + leadHours * HOUR_MS);
    assert.equal(minDate, expectedMin, label);

    // The month of minDate and the month before it: every day before minDate is past and the first selectable is it.
    const opts: Opts = { ...OPEN, minDate };
    const year = Number(expectedMin.slice(0, 4));
    const month = Number(expectedMin.slice(5, 7));
    const before = new Date(Date.UTC(year, month - 2, 1));
    const days = [
      ...monthGrid(before.getUTCFullYear(), before.getUTCMonth() + 1, opts),
      ...monthGrid(year, month, opts),
    ]
      .flat()
      .filter((day) => day.inMonth);
    assert.equal(days.find((day) => !day.disabled)?.date, expectedMin, `${label}: first selectable day`);
    for (const day of days) {
      assert.equal(day.reason, day.date < expectedMin ? "past" : undefined, `${label}: ${day.date}`);
    }
  }

  // The two instants around the flip, read off the grids of October and November 2026.
  const cell = (year: number, month: number, date: string, nowIso: string): Day | undefined =>
    monthGrid(year, month, { ...OPEN, minDate: jstToday(Date.parse(nowIso)) })
      .flat()
      .find((day) => day.date === date);

  const atFlip = "2026-10-31T15:00:00Z";
  assert.deepEqual(cell(2026, 10, "2026-10-31", atFlip), {
    date: "2026-10-31",
    inMonth: true,
    disabled: true,
    reason: "past",
  });
  assert.deepEqual(cell(2026, 11, "2026-11-01", atFlip), { date: "2026-11-01", inMonth: true, disabled: false });

  const beforeFlip = "2026-10-31T14:59:59.999Z";
  assert.deepEqual(cell(2026, 10, "2026-10-30", beforeFlip), {
    date: "2026-10-30",
    inMonth: true,
    disabled: true,
    reason: "past",
  });
  assert.deepEqual(cell(2026, 10, "2026-10-31", beforeFlip), { date: "2026-10-31", inMonth: true, disabled: false });
});

test("returnDate crosses month and year ends", () => {
  // [pickup, days, return], written out from a calendar. The package's last day, so pickup + (days - 1): a 3 day package
  // from the 1st returns the 3rd, and a 1 day package returns the day it was picked up (ticket #11).
  const table: [string, number, string][] = [
    ["2026-11-01", 3, "2026-11-03"],
    ["2026-11-10", 7, "2026-11-16"],
    // Month ends.
    ["2026-01-31", 2, "2026-02-01"],
    ["2026-04-30", 2, "2026-05-01"],
    ["2026-10-30", 3, "2026-11-01"],
    ["2026-07-31", 31, "2026-08-30"],
    ["2026-01-30", 31, "2026-03-01"],
    // Year ends.
    ["2026-12-31", 2, "2027-01-01"],
    ["2026-12-30", 7, "2027-01-05"],
    ["2026-12-15", 30, "2027-01-13"],
    // Leap years: the century that has a leap day, the one that does not, and an ordinary year either side.
    ["2028-02-28", 2, "2028-02-29"],
    ["2028-02-29", 2, "2028-03-01"],
    ["2028-02-25", 7, "2028-03-02"],
    ["2000-02-28", 2, "2000-02-29"],
    ["2000-02-28", 3, "2000-03-01"],
    ["2026-02-28", 2, "2026-03-01"],
    ["2027-02-25", 7, "2027-03-03"],
    ["2100-02-28", 2, "2100-03-01"],
    // The longest package, packages.days tops out at 60, with and without a leap day on the way.
    ["2026-01-01", 60, "2026-03-01"],
    ["2028-01-01", 60, "2028-02-29"],
    ["2026-12-15", 60, "2027-02-12"],
    // One day is the same-day rental, on a month end, a year end and the leap day as anywhere.
    ["2026-11-02", 1, "2026-11-02"],
    ["2026-01-31", 1, "2026-01-31"],
    ["2026-12-31", 1, "2026-12-31"],
    ["2028-02-29", 1, "2028-02-29"],
  ];
  for (const [pickup, days, expected] of table) {
    assert.equal(returnDate(pickup, days), expected, `returnDate(${pickup}, ${days})`);
  }

  // Below one day would otherwise be a date before the pickup with no error, and a package is whole days.
  for (const pickup of ["2026-11-02", "2026-12-31", "2028-02-29"]) {
    for (const days of [0, -1, 1.5]) {
      assert.throws(() => returnDate(pickup, days), RangeError, `returnDate(${pickup}, ${days})`);
    }
  }

  // Every pickup of six years, leap day included, with each package length.
  for (let day = 1; day <= 2200; day += 1) {
    const pickup = isoDate(2026, 1, day);
    for (const days of [1, 2, 3, 5, 7, 14, 28, 29, 30, 31, 60]) {
      assert.equal(returnDate(pickup, days), isoDate(2026, 1, day + days - 1), `returnDate(${pickup}, ${days})`);
    }
  }

  inEachHostZone((zone) => {
    for (const [pickup, days, expected] of table) {
      assert.equal(returnDate(pickup, days), expected, `returnDate(${pickup}, ${days}) on a ${zone} host`);
    }
  });
});
