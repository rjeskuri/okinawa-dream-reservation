// The one rule that decides whether two rentals of a bike conflict, in JS and in SQL, and the rule for a rental's end.
// Expected values come from literals, from Date.parse on an explicit +09:00 offset, or from Date.UTC minus nine hours,
// never from src/lib/time.ts or the code under test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCKING_SQL, conflicts, isBlocking, OVERLAP_SQL, rentalEnd } from "../src/lib/db/blocking.ts";
import type { BookingStatus, ShopConfig } from "../src/lib/types.ts";
import { createTestDb } from "./helpers/d1.ts";
import { seedBooking, seedVehicle } from "./helpers/seed.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const NINE_HOURS_MS = 9 * HOUR_MS;

const DAY = "2026-08-10";

function jst(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/** The instant of a wall clock on the test day. */
function at(time: string): number {
  return jst(DAY, time);
}

function span(start: string, end: string): { startAt: number; endAt: number } {
  return { startAt: at(start), endAt: at(end) };
}

test("conflicts honours the turnaround buffer", () => {
  const rental = span("08:00", "10:00");

  // [pickup, return, buffer in minutes, conflicts with the 08:00 to 10:00 rental]
  const table: [string, string, number, boolean][] = [
    // A 10:00 return with 60 minutes of buffer blocks a 10:30 pickup and allows 11:00.
    ["10:30", "12:00", 60, true],
    ["10:59", "12:00", 60, true],
    ["11:00", "12:00", 60, false],
    ["11:30", "12:00", 60, false],
    // The buffer also keeps an earlier rental's return clear of the 08:00 pickup.
    ["06:00", "07:30", 60, true],
    ["06:00", "07:01", 60, true],
    ["06:00", "07:00", 60, false],
    ["05:00", "06:00", 60, false],
    // The buffer's length decides.
    ["10:29", "12:00", 30, true],
    ["10:30", "12:00", 30, false],
    ["10:30", "12:00", 45, true],
    ["10:45", "12:00", 45, false],
    ["11:29", "12:00", 90, true],
    ["11:30", "12:00", 90, false],
    ["07:00", "07:40", 30, true],
    ["07:00", "07:30", 30, false],
    // Real overlaps conflict whatever the buffer.
    ["08:00", "10:00", 0, true],
    ["08:30", "09:00", 0, true],
    ["07:00", "11:00", 0, true],
    ["07:00", "08:01", 0, true],
    ["09:59", "12:00", 0, true],
    ["08:30", "09:00", 60, true],
    ["07:00", "11:00", 60, true],
    // With no buffer, intervals that only touch do not conflict.
    ["10:00", "12:00", 0, false],
    ["06:00", "08:00", 0, false],
    ["10:01", "12:00", 0, false],
    ["06:00", "07:59", 0, false],
  ];
  for (const [pickup, dropoff, bufferMinutes, expected] of table) {
    const candidate = span(pickup, dropoff);
    const bufMs = bufferMinutes * MINUTE_MS;
    const label = `${pickup} to ${dropoff} with ${bufferMinutes} minutes of buffer`;
    assert.equal(conflicts(candidate, rental, bufMs), expected, label);
    assert.equal(conflicts(rental, candidate, bufMs), expected, `${label}, arguments swapped`);
  }

  // The boundary is exact to the millisecond: a one-millisecond gap needs more than one millisecond of buffer.
  const end = rental.endAt;
  const next = { startAt: end + 1, endAt: end + HOUR_MS };
  assert.equal(conflicts(rental, next, 0), false);
  assert.equal(conflicts(rental, next, 1), false);
  assert.equal(conflicts(rental, next, 2), true);
  assert.equal(conflicts(rental, { startAt: end - 1, endAt: end + HOUR_MS }, 0), true);

  // Every placement on a 15-minute grid. Two rentals conflict when the gap between them is under the buffer, and an
  // overlap counts as a negative gap.
  const fixed = span("10:00", "12:00");
  for (const bufferMinutes of [0, 15, 30, 45, 60, 90, 120]) {
    const bufMs = bufferMinutes * MINUTE_MS;
    for (let startAt = at("04:00"); startAt <= at("18:00"); startAt += 15 * MINUTE_MS) {
      for (const lengthMinutes of [15, 60, 240]) {
        const other = { startAt, endAt: startAt + lengthMinutes * MINUTE_MS };
        const gap = Math.max(fixed.startAt - other.endAt, other.startAt - fixed.endAt);
        const label = `${JSON.stringify(other)} with ${bufferMinutes} minutes of buffer`;
        assert.equal(conflicts(fixed, other, bufMs), gap < bufMs, label);
        assert.equal(conflicts(other, fixed, bufMs), gap < bufMs, `${label}, arguments swapped`);
      }
    }
  }
});

test("isBlocking by status and hold expiry", () => {
  for (const now of [at("12:00"), jst("2027-01-01", "00:00"), 1_000]) {
    const anyExpiry = [null, now - HOUR_MS, now - 1, now, now + 1, now + HOUR_MS];

    for (const status of ["CONFIRMED", "PAYMENT_PENDING"] as const) {
      for (const expiresAt of anyExpiry) {
        assert.equal(isBlocking({ status, expiresAt }, now), true, `${status} expiring ${expiresAt} at ${now}`);
      }
    }
    for (const status of ["CANCELLED", "EXPIRED"] as const) {
      for (const expiresAt of anyExpiry) {
        assert.equal(isBlocking({ status, expiresAt }, now), false, `${status} expiring ${expiresAt} at ${now}`);
      }
    }

    const holds: [number | null, boolean][] = [
      [null, false],
      [now - HOUR_MS, false],
      [now - 1, false],
      [now, false],
      [now + 1, true],
      [now + HOUR_MS, true],
    ];
    for (const [expiresAt, expected] of holds) {
      assert.equal(isBlocking({ status: "ON_HOLD", expiresAt }, now), expected, `ON_HOLD expiring ${expiresAt} at ${now}`);
    }
  }

  // One hold watched over time stops blocking exactly at its expiry.
  const hold: { status: BookingStatus; expiresAt: number | null } = { status: "ON_HOLD", expiresAt: at("12:15") };
  assert.equal(isBlocking(hold, at("12:00")), true);
  assert.equal(isBlocking(hold, at("12:15") - 1), true);
  assert.equal(isBlocking(hold, at("12:15")), false);
  assert.equal(isBlocking(hold, at("12:30")), false);
});

const STATUSES: BookingStatus[] = ["ON_HOLD", "PAYMENT_PENDING", "CONFIRMED", "CANCELLED", "EXPIRED"];

// Three moments of `now`. Each is also an expires_at below, so every hold is at some point exactly at its expiry.
const EARLY = at("11:00");
const MIDDLE = at("11:30");
const LATE = at("12:00");

const EXPIRIES: Record<string, number | null> = { none: null, early: EARLY, middle: MIDDLE, late: LATE };

// Which of those expiries are still ahead at each `now`.
const NOWS: { label: string; now: number; unexpired: string[] }[] = [
  { label: "now 11:00", now: EARLY, unexpired: ["middle", "late"] },
  { label: "now 11:30", now: MIDDLE, unexpired: ["late"] },
  { label: "now 12:00", now: LATE, unexpired: [] },
];

const INTERVALS: Record<string, [string, string]> = {
  before: ["06:00", "07:00"],
  endsAtTen: ["08:00", "10:00"],
  inside: ["10:45", "11:15"],
  startsAtTwelve: ["12:00", "14:00"],
  startsAtOne: ["13:00", "15:00"],
  after: ["20:00", "21:00"],
};

// Each candidate with the INTERVALS it conflicts with, worked out by hand from the rule.
const CANDIDATES: { label: string; s: number; e: number; buf: number; conflictsWith: string[] }[] = [
  { label: "10:00-12:00, no buffer, touching on both sides", s: at("10:00"), e: at("12:00"), buf: 0, conflictsWith: ["inside"] },
  {
    label: "10:30-12:00, inside the buffer on the left, touching with the buffer on the right",
    s: at("10:30"),
    e: at("12:00"),
    buf: 60 * MINUTE_MS,
    conflictsWith: ["endsAtTen", "inside", "startsAtTwelve"],
  },
  {
    label: "11:00-12:00, touching with the buffer on the left",
    s: at("11:00"),
    e: at("12:00"),
    buf: 60 * MINUTE_MS,
    conflictsWith: ["inside", "startsAtTwelve"],
  },
  {
    label: "10:00-12:00, a one-millisecond buffer",
    s: at("10:00"),
    e: at("12:00"),
    buf: 1,
    conflictsWith: ["endsAtTen", "inside", "startsAtTwelve"],
  },
  { label: "07:30-07:45, a 30-minute buffer", s: at("07:30"), e: at("07:45"), buf: 30 * MINUTE_MS, conflictsWith: ["endsAtTen"] },
  { label: "15:30-16:00, a 60-minute buffer", s: at("15:30"), e: at("16:00"), buf: 60 * MINUTE_MS, conflictsWith: ["startsAtOne"] },
];

interface CaseBooking {
  id: string;
  status: BookingStatus;
  expiry: string;
  interval: string;
  expiresAt: number | null;
  start_at: number;
  end_at: number;
}

// Callers declare q with whatever parameter numbers their statement has free, so the fragments have to read q's columns
// and can name no parameter of their own. Moving q onto other numbers fails a fragment that does.
const QUERY_SHAPES: { label: string; cte: string; plate: string; binds: (q: number[], plate: string) => (string | number)[] }[] = [
  { label: "q on ?1 to ?4", cte: "SELECT ?1, ?2, ?3, ?4", plate: "?5", binds: (q, plate) => [...q, plate] },
  { label: "q on ?2 to ?5", cte: "SELECT ?2, ?3, ?4, ?5", plate: "?1", binds: (q, plate) => [plate, ...q] },
];

test("SQL fragments agree with the JS rule", async () => {
  const { db, dispose } = await createTestDb();
  try {
    const vehicle = await seedVehicle(db);
    const otherVehicle = await seedVehicle(db);

    // Every status, expiry and interval, on the vehicle under test and on a second one the queries must leave out.
    const bookings: CaseBooking[] = [];
    for (const status of STATUSES) {
      for (const [expiry, expires_at] of Object.entries(EXPIRIES)) {
        for (const [interval, [start, end]] of Object.entries(INTERVALS)) {
          const times = { status, expires_at, start_at: at(start), end_at: at(end) };
          const row = await seedBooking(db, { ...times, vehicle_plate: vehicle.plate, model_id: vehicle.model_id });
          await seedBooking(db, { ...times, vehicle_plate: otherVehicle.plate, model_id: otherVehicle.model_id });
          bookings.push({ id: row.id, status, expiry, interval, expiresAt: expires_at, start_at: at(start), end_at: at(end) });
        }
      }
    }

    for (const { label: shapeLabel, cte, plate, binds } of QUERY_SHAPES) {
      const select = async (where: string, s: number, e: number, buf: number, now: number) => {
        const sql = `WITH q(s, e, buf, now) AS (${cte}) SELECT b.id FROM bookings b, q WHERE ${where}`;
        const rows = await db
          .prepare(sql)
          .bind(...binds([s, e, buf, now], vehicle.plate))
          .all<{ id: string }>();
        return new Set(rows.results.map((row) => row.id));
      };
      const onVehicle = `b.vehicle_plate = ${plate}`;

      for (const { label: nowLabel, now, unexpired } of NOWS) {
        for (const { label: candidateLabel, s, e, buf, conflictsWith } of CANDIDATES) {
          const caseLabel = `${nowLabel}; ${candidateLabel}; ${shapeLabel}`;
          const blocking = await select(`${onVehicle} AND ${BLOCKING_SQL}`, s, e, buf, now);
          const overlapping = await select(`${onVehicle} AND ${OVERLAP_SQL}`, s, e, buf, now);
          const both = await select(`${onVehicle} AND ${BLOCKING_SQL} AND ${OVERLAP_SQL}`, s, e, buf, now);
          const bothReordered = await select(`${OVERLAP_SQL} AND ${BLOCKING_SQL} AND ${onVehicle}`, s, e, buf, now);

          let expectedBlocking = 0;
          let expectedOverlapping = 0;
          let expectedBoth = 0;
          for (const booking of bookings) {
            const label = `${booking.status}, expiry ${booking.expiry}, ${booking.interval}; ${caseLabel}`;

            const blocks =
              booking.status === "CONFIRMED" ||
              booking.status === "PAYMENT_PENDING" ||
              (booking.status === "ON_HOLD" && unexpired.includes(booking.expiry));
            const overlaps = conflictsWith.includes(booking.interval);
            expectedBlocking += blocks ? 1 : 0;
            expectedOverlapping += overlaps ? 1 : 0;
            expectedBoth += blocks && overlaps ? 1 : 0;

            const jsBlocks = isBlocking({ status: booking.status, expiresAt: booking.expiresAt }, now);
            const jsOverlaps = conflicts({ startAt: s, endAt: e }, { startAt: booking.start_at, endAt: booking.end_at }, buf);
            assert.equal(jsBlocks, blocks, `isBlocking: ${label}`);
            assert.equal(jsOverlaps, overlaps, `conflicts: ${label}`);

            assert.equal(blocking.has(booking.id), jsBlocks, `BLOCKING_SQL: ${label}`);
            assert.equal(overlapping.has(booking.id), jsOverlaps, `OVERLAP_SQL: ${label}`);
            assert.equal(both.has(booking.id), jsBlocks && jsOverlaps, `both fragments: ${label}`);
            assert.equal(bothReordered.has(booking.id), jsBlocks && jsOverlaps, `both fragments, reordered: ${label}`);
          }

          // The sizes also show the fragments kept to the vehicle the query named.
          assert.ok(expectedBlocking > 0 && expectedOverlapping > 0 && expectedBoth > 0, `an empty case: ${caseLabel}`);
          assert.equal(blocking.size, expectedBlocking, `BLOCKING_SQL: ${caseLabel}`);
          assert.equal(overlapping.size, expectedOverlapping, `OVERLAP_SQL: ${caseLabel}`);
          assert.equal(both.size, expectedBoth, `both fragments: ${caseLabel}`);
          assert.equal(bothReordered.size, expectedBoth, `both fragments, reordered: ${caseLabel}`);
        }
      }
    }
  } finally {
    await dispose();
  }
});

function configClosingAt(shopClose: string, shopOpen = "09:00"): ShopConfig {
  return {
    shopOpen,
    shopClose,
    slotMinutes: 30,
    turnaroundMinutes: 60,
    holdMinutes: 15,
    minLeadHours: 24,
    maxDaysAhead: 180,
    photoMaxMb: 5,
  };
}

/** Neither CI nor verify sets TZ, and a laptop in Japan runs in JST: every zone but JST exposes a host-local rentalEnd. */
const HOST_ZONES: [string, number][] = [
  ["UTC", 0],
  ["America/New_York", 300],
  ["Asia/Tokyo", -540],
];

test("rentalEnd returns closing time on the last day", () => {
  const hostZone = process.env.TZ;
  try {
    for (const [zone, januaryOffset] of HOST_ZONES) {
      process.env.TZ = zone;
      assert.equal(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset(), januaryOffset, `TZ=${zone} did not apply`);
      proveRentalEnd(zone);
    }
  } finally {
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  }
});

function proveRentalEnd(zone: string): void {
  // [pickup, days, shop close, return], all JST. 00:00 to 08:59 JST is still the previous day in UTC.
  const table: [string, number, string, string][] = [
    // A 1-day package returns the same JST date, and a 3-day package on D + 2.
    ["2026-08-10T09:00", 1, "18:00", "2026-08-10T18:00"],
    ["2026-08-10T09:00", 3, "18:00", "2026-08-12T18:00"],
    ["2026-08-10T09:00", 7, "18:00", "2026-08-16T18:00"],
    ["2026-08-10T09:00", 60, "18:00", "2026-10-08T18:00"],
    // Early pickups, whose UTC date is the day before.
    ["2026-08-10T08:30", 1, "18:00", "2026-08-10T18:00"],
    ["2026-08-10T00:30", 3, "17:00", "2026-08-12T17:00"],
    ["2026-08-10T08:59", 7, "19:30", "2026-08-16T19:30"],
    // Late pickups.
    ["2026-08-10T17:30", 1, "18:00", "2026-08-10T18:00"],
    ["2026-08-10T18:30", 1, "19:30", "2026-08-10T19:30"],
    ["2026-08-10T23:30", 3, "18:00", "2026-08-12T18:00"],
    ["2026-08-10T19:00", 7, "17:00", "2026-08-16T17:00"],
    // Across a month end.
    ["2026-08-30T10:00", 3, "18:00", "2026-09-01T18:00"],
    ["2026-08-27T09:00", 7, "18:00", "2026-09-02T18:00"],
    ["2026-08-31T08:00", 1, "18:00", "2026-08-31T18:00"],
    ["2026-09-01T08:00", 1, "18:00", "2026-09-01T18:00"],
    ["2026-09-01T08:00", 3, "17:00", "2026-09-03T17:00"],
    // Across a year end, and past February with and without a leap day.
    ["2026-12-30T08:00", 3, "18:00", "2027-01-01T18:00"],
    ["2027-01-01T08:00", 3, "18:00", "2027-01-03T18:00"],
    ["2027-02-27T09:00", 3, "18:00", "2027-03-01T18:00"],
    ["2028-02-27T09:00", 3, "18:00", "2028-02-29T18:00"],
    ["2028-02-29T08:00", 7, "18:00", "2028-03-06T18:00"],
  ];
  for (const [pickup, days, shopClose, expected] of table) {
    const startAt = Date.parse(`${pickup}:00+09:00`);
    const returnAt = Date.parse(`${expected}:00+09:00`);
    const label = `${pickup}, ${days} days, closing ${shopClose}, on a ${zone} host`;
    assert.equal(rentalEnd(startAt, { days }, configClosingAt(shopClose)), returnAt, label);
    // Only the closing time matters: not the opening time, nor the seconds of the pickup.
    assert.equal(rentalEnd(startAt + 37_500, { days }, configClosingAt(shopClose, "07:15")), returnAt, `${label}, seconds`);
  }

  // Every day of a year and a bit, from Date.UTC's own calendar.
  const pickups = [
    [0, 5],
    [8, 59],
    [9, 0],
    [12, 34],
    [16, 59],
  ];
  const closes: [string, number, number][] = [
    ["17:00", 17, 0],
    ["18:30", 18, 30],
  ];
  for (let offset = 0; offset < 400; offset += 1) {
    const day = new Date(Date.UTC(2026, 0, 1 + offset));
    const [year, month, date] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()];
    for (const days of [1, 2, 3, 7, 14, 30, 60]) {
      for (const [hour, minute] of pickups) {
        for (const [shopClose, closeHour, closeMinute] of closes) {
          const startAt = Date.UTC(year, month, date, hour, minute) - NINE_HOURS_MS;
          const expected = Date.UTC(year, month, date + days - 1, closeHour, closeMinute) - NINE_HOURS_MS;
          const label = `${year}-${month + 1}-${date} ${hour}:${minute} JST, ${days} days, closing ${shopClose}, on ${zone}`;
          assert.equal(rentalEnd(startAt, { days }, configClosingAt(shopClose)), expected, label);
        }
      }
    }
  }

  // A package row carries both columns, and an hours package has no end rule yet.
  const config = configClosingAt("18:00");
  const startAt = jst("2026-08-10", "09:00");
  const row: { days: number; hours: null } = { days: 3, hours: null };
  assert.equal(rentalEnd(startAt, row, config), jst("2026-08-12", "18:00"), zone);
  for (const hoursPackage of [{ days: null, hours: 4 }, { days: null, hours: 24 }, { hours: 8 }]) {
    assert.throws(
      () => rentalEnd(startAt, hoursPackage as unknown as { days: number }, config),
      RangeError,
      `${JSON.stringify(hoursPackage)} on ${zone}`,
    );
  }
}
