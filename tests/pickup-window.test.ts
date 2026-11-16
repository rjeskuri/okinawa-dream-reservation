// Which pickup times the shop accepts, in JST. Expected values come from literals, from Date.parse on an explicit +09:00
// offset, or from arithmetic on minutes in this file, never from src/lib/time.ts or the code under test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickupSlots, pickupWindowError } from "../src/lib/booking/pickup-window.ts";
import type { PickupWindowReason } from "../src/lib/booking/pickup-window.ts";
import type { ShopConfig } from "../src/lib/types.ts";

const MINUTE_MS = 60_000;

const WINDOW_REASONS: string[] = [
  "OUTSIDE_HOURS",
  "OFF_SLOT",
  "CLOSED_PICKUP",
  "RETURN_OUTSIDE_HOURS",
  "CLOSED_RETURN",
  "TOO_SOON",
  "TOO_FAR",
];

/** The two columns of a package row that say how long it is: exactly one of them is set. */
type Length = { days: number; hours: null } | { days: null; hours: number };

function dayPkg(days: number): Length {
  return { days, hours: null };
}

function hoursPkg(hours: number): Length {
  return { days: null, hours };
}

const ONE_DAY = dayPkg(1);

/** Packages of each kind, short and long, for the checks that hold whatever the package. */
const EVERY_KIND: Length[] = [dayPkg(1), dayPkg(3), dayPkg(60), hoursPkg(2), hoursPkg(4), hoursPkg(24), hoursPkg(72)];

const CONFIG: ShopConfig = {
  shopOpen: "09:00",
  shopClose: "18:00",
  slotMinutes: 30,
  turnaroundMinutes: 60,
  holdMinutes: 15,
  minLeadHours: 24,
  maxDaysAhead: 180,
  photoMaxMb: 5,
};

function jst(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/** The instant of a wall clock on the pickup day used by most cases. */
function at(time: string): number {
  return jst("2030-06-10", time);
}

const NOW = jst("2030-06-01", "12:00");
/** NOW + 180 days, counted by hand: 29 left in June, then 31, 31, 30, 31 and 28. */
const HORIZON = jst("2030-11-28", "12:00");
/** PICKUP - 24 hours. */
const LEAD_BOUNDARY = jst("2030-06-09", "09:00");

type WindowCase = {
  label: string;
  start: number;
  /** One day when left out. */
  pkg?: Length;
  closed?: string[];
  now?: number;
  config?: Partial<ShopConfig>;
  expected: PickupWindowReason | null;
};

const WINDOW_CASES: WindowCase[] = [
  // Inside the window.
  { label: "the first slot", start: at("09:00"), expected: null },
  { label: "a midday slot", start: at("13:30"), expected: null },
  { label: "the last slot", start: at("17:30"), expected: null },

  // Around opening and closing. 00:00 to 08:59 JST is the day before in UTC.
  { label: "one slot before opening", start: at("08:30"), expected: "OUTSIDE_HOURS" },
  { label: "an hour before opening", start: at("08:00"), expected: "OUTSIDE_HOURS" },
  { label: "midnight", start: at("00:00"), expected: "OUTSIDE_HOURS" },
  { label: "closing time itself", start: at("18:00"), expected: "OUTSIDE_HOURS" },
  { label: "one slot past closing", start: at("18:30"), expected: "OUTSIDE_HOURS" },
  { label: "late evening", start: at("23:30"), expected: "OUTSIDE_HOURS" },

  // The window moves with the config.
  { label: "the last slot of a 17:00 close", start: at("16:30"), config: { shopClose: "17:00" }, expected: null },
  { label: "closing time of a 17:00 close", start: at("17:00"), config: { shopClose: "17:00" }, expected: "OUTSIDE_HOURS" },
  { label: "a 19:30 close opens later slots", start: at("19:00"), config: { shopClose: "19:30" }, expected: null },
  { label: "a 07:30 open opens earlier slots", start: at("07:30"), config: { shopOpen: "07:30" }, expected: null },
  { label: "before a 10:00 open", start: at("09:30"), config: { shopOpen: "10:00" }, expected: "OUTSIDE_HOURS" },
  { label: "the last 60-minute slot", start: at("17:00"), config: { slotMinutes: 60 }, expected: null },

  // readShopConfig hands H:mm over as written, and "9:00" sorts after every HH:mm time.
  { label: "the first slot of a 9:00 open", start: at("09:00"), config: { shopOpen: "9:00" }, expected: null },
  { label: "a later slot of a 9:00 open", start: at("13:30"), config: { shopOpen: "9:00" }, expected: null },
  { label: "before a 9:00 open", start: at("08:30"), config: { shopOpen: "9:00" }, expected: "OUTSIDE_HOURS" },
  { label: "off a grid from 9:00", start: at("09:15"), config: { shopOpen: "9:00" }, expected: "OFF_SLOT" },
  { label: "the last slot of a 9:30 close", start: at("09:00"), config: { shopClose: "9:30" }, expected: null },
  { label: "closing time of a 9:30 close", start: at("09:30"), config: { shopClose: "9:30" }, expected: "OUTSIDE_HOURS" },
  { label: "the afternoon after a 9:30 close", start: at("13:30"), config: { shopClose: "9:30" }, expected: "OUTSIDE_HOURS" },
  { label: "the last slot of a 7:00 to 9:00 day", start: at("08:30"), config: { shopOpen: "7:00", shopClose: "9:00" }, expected: null },
  { label: "closing time of a 7:00 to 9:00 day", start: at("09:00"), config: { shopOpen: "7:00", shopClose: "9:00" }, expected: "OUTSIDE_HOURS" },

  // The slot grid starts at opening time.
  { label: "a quarter past", start: at("09:15"), expected: "OFF_SLOT" },
  { label: "one minute early", start: at("09:29"), expected: "OFF_SLOT" },
  { label: "one minute late", start: at("09:31"), expected: "OFF_SLOT" },
  { label: "between the last two slots", start: at("17:15"), expected: "OFF_SLOT" },
  { label: "on a 30-minute slot of a 60-minute grid", start: at("09:30"), config: { slotMinutes: 60 }, expected: "OFF_SLOT" },
  { label: "on a 60-minute grid", start: at("10:00"), config: { slotMinutes: 60 }, expected: null },
  { label: "on a 20-minute grid", start: at("09:20"), config: { slotMinutes: 20 }, expected: null },
  { label: "on a 30-minute slot of a 20-minute grid", start: at("09:30"), config: { slotMinutes: 20 }, expected: "OFF_SLOT" },
  { label: "on a 45-minute grid", start: at("10:30"), config: { slotMinutes: 45 }, expected: null },
  { label: "on a 60-minute slot of a 45-minute grid", start: at("10:00"), config: { slotMinutes: 45 }, expected: "OFF_SLOT" },
  { label: "opening at 09:15", start: at("09:15"), config: { shopOpen: "09:15" }, expected: null },
  { label: "a grid from 09:15", start: at("09:45"), config: { shopOpen: "09:15" }, expected: null },
  { label: "the hour, off a grid from 09:15", start: at("10:00"), config: { shopOpen: "09:15" }, expected: "OFF_SLOT" },
  { label: "the half hour, off a grid from 09:15", start: at("09:30"), config: { shopOpen: "09:15" }, expected: "OFF_SLOT" },

  // A wall clock to the minute hides these, so the check has to read the whole instant.
  { label: "one millisecond past a slot", start: at("09:00") + 1, expected: "OFF_SLOT" },
  { label: "half a millisecond past a slot", start: at("09:00") + 0.5, expected: "OFF_SLOT" },
  { label: "thirty seconds past a slot", start: at("09:00") + 30_000, expected: "OFF_SLOT" },
  { label: "just short of the next minute", start: at("09:30") + 59_999, expected: "OFF_SLOT" },
  { label: "one millisecond before a slot", start: at("10:00") - 1, expected: "OFF_SLOT" },

  // Closed dates: the pickup date and the return date, nothing else.
  { label: "closed on a one-day pickup", start: at("09:00"), closed: ["2030-06-10"], expected: "CLOSED_PICKUP" },
  { label: "closed on a three-day pickup", start: at("09:00"), pkg: dayPkg(3), closed: ["2030-06-10"], expected: "CLOSED_PICKUP" },
  { label: "closed on a two-day return", start: at("09:00"), pkg: dayPkg(2), closed: ["2030-06-11"], expected: "CLOSED_RETURN" },
  { label: "closed on a three-day return", start: at("13:30"), pkg: dayPkg(3), closed: ["2030-06-12"], expected: "CLOSED_RETURN" },
  {
    label: "closed on a return past the month end",
    start: jst("2030-06-27", "09:00"),
    pkg: dayPkg(7),
    closed: ["2030-07-03"],
    expected: "CLOSED_RETURN",
  },
  { label: "closed between pickup and return", start: at("09:00"), pkg: dayPkg(3), closed: ["2030-06-11"], expected: null },
  { label: "closed the day before pickup", start: at("09:00"), pkg: dayPkg(3), closed: ["2030-06-09"], expected: null },
  { label: "closed the day after return", start: at("09:00"), pkg: dayPkg(3), closed: ["2030-06-13"], expected: null },
  { label: "a two-day rental ends before that date", start: at("09:00"), pkg: dayPkg(2), closed: ["2030-06-12"], expected: null },
  {
    label: "closed all around a rental",
    start: at("09:00"),
    pkg: dayPkg(3),
    closed: ["2030-06-09", "2030-06-11", "2030-06-13"],
    expected: null,
  },

  // Dates are JST dates: 07:00 JST is 22:00 UTC the day before, and so is an 08:00 close.
  {
    label: "an early pickup on its JST date",
    start: at("07:00"),
    closed: ["2030-06-10"],
    config: { shopOpen: "07:00" },
    expected: "CLOSED_PICKUP",
  },
  { label: "an early pickup, not its UTC date", start: at("07:00"), closed: ["2030-06-09"], config: { shopOpen: "07:00" }, expected: null },
  {
    label: "an early return on its JST date",
    start: at("06:00"),
    pkg: dayPkg(3),
    closed: ["2030-06-12"],
    config: { shopOpen: "06:00", shopClose: "08:00" },
    expected: "CLOSED_RETURN",
  },
  {
    label: "an early return, not its UTC date",
    start: at("06:00"),
    pkg: dayPkg(3),
    closed: ["2030-06-11"],
    config: { shopOpen: "06:00", shopClose: "08:00" },
    expected: null,
  },

  // Lead time, to the millisecond.
  { label: "exactly the lead time away", start: at("09:00"), now: LEAD_BOUNDARY, expected: null },
  { label: "one millisecond inside the lead time", start: at("09:00"), now: LEAD_BOUNDARY + 1, expected: "TOO_SOON" },
  { label: "well inside the lead time", start: at("09:00"), now: at("08:00"), expected: "TOO_SOON" },
  { label: "a start in the past", start: jst("2030-05-20", "09:00"), expected: "TOO_SOON" },
  { label: "24 hours is too soon for a 48-hour lead", start: at("09:00"), now: LEAD_BOUNDARY, config: { minLeadHours: 48 }, expected: "TOO_SOON" },
  { label: "48 hours meets a 48-hour lead", start: at("09:00"), now: jst("2030-06-08", "09:00"), config: { minLeadHours: 48 }, expected: null },
  { label: "23 hours meets a 23-hour lead", start: at("09:00"), now: jst("2030-06-09", "10:00"), config: { minLeadHours: 23 }, expected: null },
  { label: "no lead time, now", start: at("09:00"), now: at("09:00"), config: { minLeadHours: 0 }, expected: null },
  { label: "no lead time, just missed", start: at("09:00"), now: at("09:00") + 1, config: { minLeadHours: 0 }, expected: "TOO_SOON" },

  // The horizon, to the millisecond. The return may fall past it.
  { label: "exactly at the horizon", start: HORIZON, expected: null },
  { label: "one millisecond past the horizon", start: HORIZON, now: NOW - 1, expected: "TOO_FAR" },
  { label: "the slot after the horizon", start: HORIZON + 30 * MINUTE_MS, expected: "TOO_FAR" },
  { label: "the morning after the horizon", start: jst("2030-11-29", "09:00"), expected: "TOO_FAR" },
  { label: "a year out", start: jst("2031-06-02", "09:00"), expected: "TOO_FAR" },
  { label: "a long rental from the horizon", start: HORIZON, pkg: dayPkg(60), expected: null },
  { label: "a 30-day horizon", start: jst("2030-07-01", "12:00"), config: { maxDaysAhead: 30 }, expected: null },
  { label: "past a 30-day horizon", start: jst("2030-07-01", "12:30"), config: { maxDaysAhead: 30 }, expected: "TOO_FAR" },
  { label: "inside a 200-day horizon", start: jst("2030-12-18", "12:00"), config: { maxDaysAhead: 200 }, expected: null },
];

/** [open, close, slot] in minutes since midnight: the wall clock of every minute of a day is checked against each. */
const GRIDS: [string, string, number][] = [
  ["09:00", "18:00", 30],
  ["09:00", "18:00", 60],
  ["08:15", "17:45", 45],
  ["10:00", "16:00", 20],
  ["07:00", "21:30", 15],
  ["9:00", "18:00", 30],
  ["7:00", "9:30", 30],
  ["6:15", "9:45", 45],
];

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

test("each invalid start gets its reason", () => {
  for (const { label, start, pkg = ONE_DAY, closed = [], now = NOW, config, expected } of WINDOW_CASES) {
    assert.equal(pickupWindowError({ ...CONFIG, ...config }, closed, start, pkg, now), expected, label);
  }

  // Every minute of a day, against the rule worked out from minutes. A minute that is both outside the hours and off
  // the grid may name either fault.
  const midnight = at("00:00");
  for (const [shopOpen, shopClose, slotMinutes] of GRIDS) {
    const config = { ...CONFIG, shopOpen, shopClose, slotMinutes };
    const [open, close] = [minutesOf(shopOpen), minutesOf(shopClose)];
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const inHours = minute >= open && minute <= close - slotMinutes;
      const onGrid = (minute - open) % slotMinutes === 0;
      const reason = pickupWindowError(config, [], midnight + minute * MINUTE_MS, ONE_DAY, NOW);
      const label = `minute ${minute} of ${shopOpen} to ${shopClose} at ${slotMinutes} minutes`;
      if (inHours && onGrid) assert.equal(reason, null, label);
      else if (inHours) assert.equal(reason, "OFF_SLOT", label);
      else if (onGrid) assert.equal(reason, "OUTSIDE_HOURS", label);
      else assert.ok(reason === "OUTSIDE_HOURS" || reason === "OFF_SLOT", `${label}: ${reason}`);
    }
  }
});

/** The early shop of the JST cases: 06:00 to 08:00 JST is 21:00 to 23:00 UTC the day before. */
const EARLY: Partial<ShopConfig> = { shopOpen: "06:00", shopClose: "08:00" };

// #50 (owner, 2026-11-15): an hours package must be back by closing time, and returning at closing is allowed, as a day
// package returns then. A return before opening is outside the hours too. The JST date of the return is the one a closed
// date refuses, which for 24 hours is the next day. The reasons come in this order: OFF_SLOT for a non-instant, TOO_SOON,
// TOO_FAR, OFF_SLOT, OUTSIDE_HOURS, CLOSED_PICKUP, RETURN_OUTSIDE_HOURS, CLOSED_RETURN.
const HOURS_CASES: WindowCase[] = [
  // The return between opening and closing, both included.
  { label: "4 hours from the first slot", start: at("09:00"), pkg: hoursPkg(4), expected: null },
  { label: "4 hours returning at closing", start: at("14:00"), pkg: hoursPkg(4), expected: null },
  { label: "4 hours returning a slot past closing", start: at("14:30"), pkg: hoursPkg(4), expected: "RETURN_OUTSIDE_HOURS" },
  { label: "4 hours from the last slot", start: at("17:30"), pkg: hoursPkg(4), expected: "RETURN_OUTSIDE_HOURS" },
  { label: "8 hours returning at closing", start: at("10:00"), pkg: hoursPkg(8), expected: null },
  { label: "8 hours returning past closing", start: at("10:30"), pkg: hoursPkg(8), expected: "RETURN_OUTSIDE_HOURS" },
  { label: "2 hours from the last slot that fits", start: at("16:00"), pkg: hoursPkg(2), expected: null },
  { label: "2 hours a slot later", start: at("16:30"), pkg: hoursPkg(2), expected: "RETURN_OUTSIDE_HOURS" },
  // 24 hours returns at the pickup's own clock the next day, so every slot fits.
  { label: "24 hours from the first slot", start: at("09:00"), pkg: hoursPkg(24), expected: null },
  { label: "24 hours from the last slot", start: at("17:30"), pkg: hoursPkg(24), expected: null },
  // Past midnight the return comes before opening, until it reaches it.
  { label: "12 hours, returning at 01:00", start: at("13:00"), pkg: hoursPkg(12), expected: "RETURN_OUTSIDE_HOURS" },
  { label: "20 hours, returning before opening", start: at("12:00"), pkg: hoursPkg(20), expected: "RETURN_OUTSIDE_HOURS" },
  { label: "21 hours, returning at opening", start: at("12:00"), pkg: hoursPkg(21), expected: null },

  // The hours move with the config.
  { label: "4 hours to a 17:00 close", start: at("13:00"), pkg: hoursPkg(4), config: { shopClose: "17:00" }, expected: null },
  {
    label: "4 hours past a 17:00 close",
    start: at("13:30"),
    pkg: hoursPkg(4),
    config: { shopClose: "17:00" },
    expected: "RETURN_OUTSIDE_HOURS",
  },
  { label: "4 hours to a 19:30 close", start: at("15:30"), pkg: hoursPkg(4), config: { shopClose: "19:30" }, expected: null },
  {
    label: "4 hours past a 19:30 close",
    start: at("16:00"),
    pkg: hoursPkg(4),
    config: { shopClose: "19:30" },
    expected: "RETURN_OUTSIDE_HOURS",
  },
  {
    label: "2 hours to a 9:30 close",
    start: at("07:30"),
    pkg: hoursPkg(2),
    config: { shopOpen: "7:00", shopClose: "9:30" },
    expected: null,
  },
  {
    label: "2 hours past a 9:30 close",
    start: at("08:00"),
    pkg: hoursPkg(2),
    config: { shopOpen: "7:00", shopClose: "9:30" },
    expected: "RETURN_OUTSIDE_HOURS",
  },
  { label: "1 hour to an early close", start: at("07:00"), pkg: hoursPkg(1), config: EARLY, expected: null },
  { label: "1 hour past an early close", start: at("07:30"), pkg: hoursPkg(1), config: EARLY, expected: "RETURN_OUTSIDE_HOURS" },
  { label: "24 hours in an early shop", start: at("07:30"), pkg: hoursPkg(24), config: EARLY, expected: null },

  // Closed dates: the pickup's and the return's JST dates.
  { label: "24 hours into a closed day", start: at("09:00"), pkg: hoursPkg(24), closed: ["2030-06-11"], expected: "CLOSED_RETURN" },
  {
    label: "24 hours from the last slot into a closed day",
    start: at("17:30"),
    pkg: hoursPkg(24),
    closed: ["2030-06-11"],
    expected: "CLOSED_RETURN",
  },
  {
    label: "24 hours over a month end into a closed day",
    start: jst("2030-06-30", "12:00"),
    pkg: hoursPkg(24),
    closed: ["2030-07-01"],
    expected: "CLOSED_RETURN",
  },
  {
    label: "24 hours in an early shop into a closed day",
    start: at("07:30"),
    pkg: hoursPkg(24),
    closed: ["2030-06-11"],
    config: EARLY,
    expected: "CLOSED_RETURN",
  },
  { label: "4 hours the day before a closed day", start: at("14:00"), pkg: hoursPkg(4), closed: ["2030-06-11"], expected: null },
  {
    label: "24 hours between closed days",
    start: at("09:00"),
    pkg: hoursPkg(24),
    closed: ["2030-06-09", "2030-06-12"],
    expected: null,
  },
  { label: "48 hours over a closed day", start: at("09:00"), pkg: hoursPkg(48), closed: ["2030-06-11"], expected: null },
  { label: "48 hours into a closed day", start: at("09:00"), pkg: hoursPkg(48), closed: ["2030-06-12"], expected: "CLOSED_RETURN" },
  { label: "4 hours on a closed day", start: at("09:00"), pkg: hoursPkg(4), closed: ["2030-06-10"], expected: "CLOSED_PICKUP" },

  // Which reason comes first.
  { label: "a late 4-hour pickup on a closed day", start: at("14:30"), pkg: hoursPkg(4), closed: ["2030-06-10"], expected: "CLOSED_PICKUP" },
  {
    label: "12 hours into a closed day, returning before opening",
    start: at("13:00"),
    pkg: hoursPkg(12),
    closed: ["2030-06-11"],
    expected: "RETURN_OUTSIDE_HOURS",
  },
  { label: "a late 4-hour pickup inside the lead time", start: at("14:30"), pkg: hoursPkg(4), now: at("08:00"), expected: "TOO_SOON" },
  {
    label: "a late 4-hour pickup past the horizon",
    start: jst("2030-11-29", "14:30"),
    pkg: hoursPkg(4),
    expected: "TOO_FAR",
  },
  { label: "4 hours at the horizon", start: HORIZON, pkg: hoursPkg(4), expected: null },
  { label: "8 hours at the horizon", start: HORIZON, pkg: hoursPkg(8), expected: "RETURN_OUTSIDE_HOURS" },
  { label: "4 hours off the grid", start: at("14:15"), pkg: hoursPkg(4), expected: "OFF_SLOT" },
  { label: "4 hours a millisecond off a late slot", start: at("14:30") + 1, pkg: hoursPkg(4), expected: "OFF_SLOT" },
  { label: "4 hours from closing time", start: at("18:00"), pkg: hoursPkg(4), expected: "OUTSIDE_HOURS" },
  { label: "4 hours from before opening", start: at("08:30"), pkg: hoursPkg(4), expected: "OUTSIDE_HOURS" },
  { label: "2 hours from before an early opening", start: at("05:30"), pkg: hoursPkg(2), config: EARLY, expected: "OUTSIDE_HOURS" },

  // Day packages return at closing on their last day, so the rule never refuses one.
  { label: "1 day from the last slot", start: at("17:30"), expected: null },
  { label: "3 days from the last slot", start: at("17:30"), pkg: dayPkg(3), expected: null },
  { label: "1 day from the last slot of an early shop", start: at("07:30"), config: EARLY, expected: null },
];

/** Lengths for the minute-by-minute check, real and not, including several that wrap past midnight. */
const HOUR_LENGTHS = [1, 2, 3, 4, 5, 8, 9, 12, 20, 21, 24, 30, 48, 72];

test("an hours package is refused when its return falls outside shop hours", () => {
  for (const { label, start, pkg = ONE_DAY, closed = [], now = NOW, config, expected } of HOURS_CASES) {
    assert.equal(pickupWindowError({ ...CONFIG, ...config }, closed, start, pkg, now), expected, label);
  }

  // Every minute of a day, for each grid and length, against the rule worked out from minutes: a pickup the day package
  // takes is taken when the clock `hours` later is between opening and closing, both included.
  const midnight = at("00:00");
  for (const [shopOpen, shopClose, slotMinutes] of GRIDS) {
    const config = { ...CONFIG, shopOpen, shopClose, slotMinutes };
    const [open, close] = [minutesOf(shopOpen), minutesOf(shopClose)];
    for (const hours of HOUR_LENGTHS) {
      for (let minute = 0; minute < 24 * 60; minute += 1) {
        const inHours = minute >= open && minute <= close - slotMinutes;
        const onGrid = (minute - open) % slotMinutes === 0;
        const returnClock = (minute + hours * 60) % (24 * 60);
        const returnFits = returnClock >= open && returnClock <= close;
        const reason = pickupWindowError(config, [], midnight + minute * MINUTE_MS, hoursPkg(hours), NOW);
        const label = `minute ${minute} of ${shopOpen} to ${shopClose} at ${slotMinutes} minutes, ${hours} hours`;
        if (inHours && onGrid) assert.equal(reason, returnFits ? null : "RETURN_OUTSIDE_HOURS", label);
        else if (inHours) assert.equal(reason, "OFF_SLOT", label);
        else if (onGrid) assert.equal(reason, "OUTSIDE_HOURS", label);
        else assert.ok(reason === "OUTSIDE_HOURS" || reason === "OFF_SLOT", `${label}: ${reason}`);
      }
    }
  }
});

/**
 * Instants around the ends of what YYYY-MM-DD can write in JST, which is where epochToJst starts to throw. Date holds all
 * of these but the two just past its own limit, so asking Date whether it can read a start lets the rest through, and
 * asking for the UTC year misses the first hours of JST year 10000.
 */
const CALENDAR_EDGES: number[] = [
  1e15,
  -1e14,
  8.64e15,
  -8.64e15,
  8.64e15 + 1,
  -8.64e15 - 1,
  Date.parse("9999-12-31T09:00:00+09:00"),
  Date.parse("9999-12-31T23:59:59.999+09:00"),
  Date.parse("+010000-01-01T00:00:00+09:00"),
  Date.parse("+010000-01-01T09:00:00+09:00"),
  Date.parse("0000-01-01T00:00:00+09:00"),
  Date.parse("0000-01-01T09:00:00+09:00"),
  Date.parse("-000001-12-31T23:59:59.999+09:00"),
  Date.parse("-000001-12-31T09:00:00+09:00"),
];

test("a hostile start gets a reason, never an exception", () => {
  // Numbers that no calendar helper can read, and values a caller's JSON could carry.
  const hostile: unknown[] = [
    NaN,
    Infinity,
    -Infinity,
    1e20,
    -1e20,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    ...CALENDAR_EDGES,
    null,
    undefined,
    true,
    {},
    "",
    "2030-06-10T09:00:00+09:00",
    String(at("09:00")),
  ];
  for (const start of hostile) {
    for (const pkg of EVERY_KIND) {
      const reason = pickupWindowError(CONFIG, [], start as number, pkg, NOW);
      assert.ok(WINDOW_REASONS.includes(String(reason)), `${String(start)} over ${JSON.stringify(pkg)} gave ${reason}`);
    }
  }

  // The last dates the calendar helpers can write. The return of a long rental falls past year 9999, and only the
  // horizon applies, so a check that reaches for the return date or clock first must still not throw.
  const lastPickup = Date.parse("9999-12-31T09:00:00+09:00");
  const lateLastPickup = Date.parse("9999-12-31T17:30:00+09:00");
  for (const pkg of EVERY_KIND) {
    assert.equal(pickupWindowError(CONFIG, [], lastPickup, pkg, NOW), "TOO_FAR", JSON.stringify(pkg));
    assert.equal(pickupWindowError(CONFIG, [], lateLastPickup, pkg, NOW), "TOO_FAR", `${JSON.stringify(pkg)}, 17:30`);
  }

  // The first slot on the first date they can write is a good slot, and only the lead time refuses it.
  const firstPickup = Date.parse("0000-01-01T09:00:00+09:00");
  for (const pkg of EVERY_KIND) {
    assert.equal(pickupWindowError(CONFIG, [], firstPickup, pkg, NOW), "TOO_SOON", JSON.stringify(pkg));
  }
});

const BAD_SLOT_MINUTES = [0, -30, -0.5, 0.5, 29.5, 30.5, NaN, Infinity, -Infinity];

test("a bad slot config refuses every start", () => {
  // None of these starts is at fault except through the grid: 09:00 and 13:30 pass every other check.
  for (const slotMinutes of BAD_SLOT_MINUTES) {
    for (const start of [at("09:00"), at("13:30"), at("17:30")]) {
      for (const pkg of EVERY_KIND) {
        const reason = pickupWindowError({ ...CONFIG, slotMinutes }, [], start, pkg, NOW);
        const label = `slotMinutes ${slotMinutes} at ${start}, ${JSON.stringify(pkg)}, gave ${reason}`;
        assert.ok(WINDOW_REASONS.includes(String(reason)), label);
      }
    }
  }
});

const HALF_HOURS_09_TO_1730 = [
  "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00",
  "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
];

test("pickupSlots lists times from open to close minus one slot", () => {
  const table: [string, string, number, string[]][] = [
    ["09:00", "18:00", 30, HALF_HOURS_09_TO_1730],
    ["09:00", "18:00", 60, ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"]],
    // The last slot is the latest one on the grid: 17:00 here, because close minus one slot, 17:15, is off it.
    ["09:00", "17:45", 30, HALF_HOURS_09_TO_1730.slice(0, 17)],
    ["09:15", "12:00", 45, ["09:15", "10:00", "10:45"]],
    ["07:05", "08:05", 20, ["07:05", "07:25", "07:45"]],
    ["22:00", "23:59", 60, ["22:00"]],
    // One slot exactly fills the day, and then one does not fit.
    ["10:00", "10:30", 30, ["10:00"]],
    ["10:00", "10:20", 30, []],
    ["09:00", "10:00", 120, []],
    // A shop that never opens.
    ["09:00", "09:00", 30, []],
    ["18:00", "09:00", 30, []],
    // The config reader accepts H:mm, and the slots are always HH:mm.
    ["9:00", "11:00", 60, ["09:00", "10:00"]],
    ["7:00", "9:00", 60, ["07:00", "08:00"]],
    ["8:30", "9:30", 30, ["08:30", "09:00"]],
  ];
  for (const [shopOpen, shopClose, slotMinutes, expected] of table) {
    const label = `${shopOpen} to ${shopClose} at ${slotMinutes} minutes`;
    assert.deepEqual(pickupSlots({ ...CONFIG, shopOpen, shopClose, slotMinutes }), expected, label);
  }
});

test("pickupSlots is empty when slotMinutes is not a positive integer", () => {
  for (const slotMinutes of BAD_SLOT_MINUTES) {
    assert.deepEqual(pickupSlots({ ...CONFIG, slotMinutes }), [], `slotMinutes ${slotMinutes}`);
    for (const pkg of EVERY_KIND) {
      assert.deepEqual(pickupSlots({ ...CONFIG, slotMinutes }, pkg), [], `slotMinutes ${slotMinutes}, ${JSON.stringify(pkg)}`);
    }
  }
});

/** HH:mm of minutes since midnight, written here and not taken from src/lib/time.ts. */
function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Every pickup slot of a day by the minute arithmetic of task #20: from opening to closing minus one slot. */
function slotMinutesOf(shopOpen: string, shopClose: string, slotMinutes: number): number[] {
  const slots: number[] = [];
  for (let minute = minutesOf(shopOpen); minute <= minutesOf(shopClose) - slotMinutes; minute += slotMinutes) {
    slots.push(minute);
  }
  return slots;
}

// #50: with an hours package the slots are those whose return is back by closing, as pickupWindowError rules. A day
// package, or none, keeps every slot.
test("pickupSlots with an hours package lists only the slots whose return fits shop hours", () => {
  const table: [string, string, number, number, string[]][] = [
    ["09:00", "18:00", 30, 4, HALF_HOURS_09_TO_1730.slice(0, 11)],
    ["09:00", "18:00", 30, 8, ["09:00", "09:30", "10:00"]],
    ["09:00", "18:00", 30, 2, HALF_HOURS_09_TO_1730.slice(0, 15)],
    ["09:00", "18:00", 30, 9, ["09:00"]],
    ["09:00", "18:00", 30, 10, []],
    ["09:00", "18:00", 30, 24, HALF_HOURS_09_TO_1730],
    ["09:00", "18:00", 60, 4, ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"]],
    ["08:15", "17:45", 45, 4, ["08:15", "09:00", "09:45", "10:30", "11:15", "12:00", "12:45", "13:30"]],
    ["7:00", "9:30", 30, 2, ["07:00", "07:30"]],
    ["7:00", "9:30", 30, 24, ["07:00", "07:30", "08:00", "08:30", "09:00"]],
    ["7:00", "9:30", 30, 12, []],
    [
      "10:00",
      "16:00",
      20,
      1,
      [
        "10:00", "10:20", "10:40", "11:00", "11:20", "11:40", "12:00", "12:20",
        "12:40", "13:00", "13:20", "13:40", "14:00", "14:20", "14:40", "15:00",
      ],
    ],
  ];
  for (const [shopOpen, shopClose, slotMinutes, hours, expected] of table) {
    const config = { ...CONFIG, shopOpen, shopClose, slotMinutes };
    const label = `${shopOpen} to ${shopClose} at ${slotMinutes} minutes, ${hours} hours`;
    assert.deepEqual(pickupSlots(config, hoursPkg(hours)), expected, label);
  }

  // Each grid and length, against the minute arithmetic, and against pickupWindowError on a day it has no other fault on.
  for (const [shopOpen, shopClose, slotMinutes] of GRIDS) {
    const config = { ...CONFIG, shopOpen, shopClose, slotMinutes };
    const [open, close] = [minutesOf(shopOpen), minutesOf(shopClose)];
    const every = slotMinutesOf(shopOpen, shopClose, slotMinutes);
    for (const pkg of [ONE_DAY, dayPkg(3), dayPkg(60)]) {
      assert.deepEqual(pickupSlots(config, pkg), every.map(clockOf), `${shopOpen} to ${shopClose}, ${JSON.stringify(pkg)}`);
    }
    assert.deepEqual(pickupSlots(config), every.map(clockOf), `${shopOpen} to ${shopClose}, no package`);

    for (const hours of HOUR_LENGTHS) {
      const label = `${shopOpen} to ${shopClose} at ${slotMinutes} minutes, ${hours} hours`;
      const fits = (minute: number) => {
        const returnClock = (minute + hours * 60) % (24 * 60);
        return returnClock >= open && returnClock <= close;
      };
      const listed = pickupSlots(config, hoursPkg(hours));
      assert.deepEqual(listed, every.filter(fits).map(clockOf), label);
      for (const minute of every) {
        const reason = pickupWindowError(config, [], at(clockOf(minute)), hoursPkg(hours), NOW);
        assert.equal(reason, listed.includes(clockOf(minute)) ? null : "RETURN_OUTSIDE_HOURS", `${label}: ${clockOf(minute)}`);
      }
    }
  }
});
