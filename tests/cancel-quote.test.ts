// Refunds and signed cancel links, src/lib/booking/cancel.ts. Days, percents and yen are worked out by hand and written
// as literals, instants come from Date.parse on an explicit +09:00 offset, and tokens come from node:crypto, so no
// expected value passes through src/lib/time.ts, src/lib/crypto.ts or the code under test.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mock, test } from "node:test";
import { LOCALES } from "../src/lib/locale.ts";
import type { Locale } from "../src/lib/locale.ts";
import type { Booking, CancellationTier } from "../src/lib/types.ts";
import { createTestDb } from "./helpers/d1.ts";
import type { TestDb } from "./helpers/d1.ts";
import { seedBooking, seedTiers } from "./helpers/seed.ts";
import type { BookingRow, TierRow } from "./helpers/seed.ts";

/** Loaded inside each test, after its fixtures, so a test fails on this module alone and a bad fixture shows first. */
const cancelModule = () => import("../src/lib/booking/cancel.ts");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The instant of a JST wall clock written "YYYY-MM-DD HH:mm". */
function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

function tier(minDaysBefore: number, refundPercent: number): CancellationTier {
  return { minDaysBefore, refundPercent };
}

/** The same tiers as given, backwards and rotated: the pure function takes any order. */
function orderings(tiers: CancellationTier[]): CancellationTier[][] {
  return [[...tiers], [...tiers].reverse(), [...tiers.slice(1), ...tiers.slice(0, 1)]];
}

/** Neither CI nor verify sets TZ, and a laptop in Japan runs in JST: every zone but JST exposes a host-local count. */
const HOST_ZONES: [string, number][] = [
  ["UTC", 0],
  ["America/New_York", 300],
  ["Asia/Tokyo", -540],
  ["Pacific/Kiritimati", -840],
];

// [pickup, now, daysBefore] in JST, each count read off a calendar.
const DAY_COUNTS: [string, string, number][] = [
  // One minute apart across midnight the count drops by one, though a 24-hour count and a UTC date both stay put.
  ["2026-08-10 09:00", "2026-08-02 23:59", 8],
  ["2026-08-10 09:00", "2026-08-03 00:00", 7],
  // 23 hours apart inside one JST day the count holds, though a 24-hour count and a UTC date both move.
  ["2026-08-10 09:00", "2026-08-03 00:30", 7],
  ["2026-08-10 09:00", "2026-08-03 23:30", 7],
  // Only the pickup's JST date counts, whatever its time, though these pickups fall on two UTC dates.
  ["2026-08-10 00:00", "2026-08-03 12:00", 7],
  ["2026-08-10 08:59", "2026-08-03 12:00", 7],
  ["2026-08-10 09:00", "2026-08-03 12:00", 7],
  ["2026-08-10 18:00", "2026-08-03 12:00", 7],
  ["2026-08-10 23:59", "2026-08-03 12:00", 7],
  // The pickup day itself, and a night before it that is under a day away.
  ["2026-08-10 09:00", "2026-08-10 00:00", 0],
  ["2026-08-10 09:00", "2026-08-10 08:59", 0],
  ["2026-08-10 23:59", "2026-08-10 00:00", 0],
  ["2026-08-10 00:00", "2026-08-09 23:59", 1],
  ["2026-08-10 00:30", "2026-08-09 23:30", 1],
  // Month ends, with 28 and with 29 days in February.
  ["2026-09-01 10:00", "2026-08-31 23:59", 1],
  ["2026-09-01 10:00", "2026-09-01 00:00", 0],
  ["2026-03-01 09:00", "2026-02-28 23:59", 1],
  ["2028-03-01 09:00", "2028-02-28 23:59", 2],
  ["2028-03-01 09:00", "2028-02-29 00:00", 1],
  // Year ends.
  ["2027-01-01 09:00", "2026-12-31 23:59", 1],
  ["2027-01-02 09:00", "2026-12-31 23:59", 2],
  ["2027-01-02 09:00", "2027-01-01 00:00", 1],
  ["2027-01-15 09:00", "2026-12-20 12:00", 26],
  // A whole year, with and without a 29 February inside it.
  ["2027-08-10 09:00", "2026-08-10 08:00", 365],
  ["2028-03-01 09:00", "2027-03-01 08:00", 366],
  ["2029-03-01 09:00", "2028-03-01 08:00", 365],
  // Spanning the US clock changes of 2026-11-01 and 2027-03-14, where a local day on a New York host is not 24 hours.
  ["2026-11-02 09:00", "2026-10-31 12:00", 2],
  ["2027-03-15 09:00", "2027-03-13 12:00", 2],
];

// One pickup and one tier set, at both ends of each JST day a tier changes on. [now, daysBefore, percent]
const TIER_CHANGES: { pickup: string; tiers: CancellationTier[]; times: [string, number, number][] }[] = [
  {
    pickup: "2026-08-10 09:00",
    tiers: [tier(3, 50), tier(7, 100)],
    times: [
      ["2026-08-02 23:59", 8, 100],
      ["2026-08-03 00:00", 7, 100],
      ["2026-08-03 23:59", 7, 100],
      ["2026-08-04 00:00", 6, 50],
      ["2026-08-06 23:59", 4, 50],
      ["2026-08-07 00:00", 3, 50],
      ["2026-08-07 23:59", 3, 50],
      ["2026-08-08 00:00", 2, 0],
      ["2026-08-10 08:59", 0, 0],
    ],
  },
  {
    // Over new year to a late pickup, with a tier for the day itself.
    pickup: "2027-01-02 18:00",
    tiers: [tier(0, 10), tier(5, 80), tier(1, 30)],
    times: [
      ["2026-12-27 23:59", 6, 80],
      ["2026-12-28 00:00", 5, 80],
      ["2026-12-28 23:59", 5, 80],
      ["2026-12-29 00:00", 4, 30],
      ["2027-01-01 23:59", 1, 30],
      ["2027-01-02 00:00", 0, 10],
      ["2027-01-02 17:59", 0, 10],
    ],
  },
];

// Each set read at its exact boundaries, the day below them and far beyond the top. [daysBefore, percent]
const TIER_SETS: { name: string; tiers: CancellationTier[]; days: [number, number][] }[] = [
  {
    name: "the shape the sheet starts with",
    tiers: [tier(7, 100), tier(3, 50), tier(0, 0)],
    days: [[0, 0], [2, 0], [3, 50], [6, 50], [7, 100], [8, 100], [365, 100]],
  },
  {
    name: "gaps, and nothing for the last days",
    tiers: [tier(14, 75), tier(3, 25), tier(30, 100)],
    days: [[0, 0], [2, 0], [3, 25], [13, 25], [14, 75], [29, 75], [30, 100], [31, 100], [400, 100]],
  },
  {
    name: "a tier for pickup day itself and tiers a day wide",
    tiers: [tier(1, 40), tier(0, 10), tier(2, 90)],
    days: [[0, 10], [1, 40], [2, 90], [3, 90], [100, 90]],
  },
  {
    // The largest min_days_before decides, not the largest percent.
    name: "a percent that falls as pickup gets further away",
    tiers: [tier(5, 60), tier(10, 20), tier(1, 90)],
    days: [[0, 0], [1, 90], [4, 90], [5, 60], [9, 60], [10, 20], [11, 20]],
  },
  { name: "one tier", tiers: [tier(5, 100)], days: [[0, 0], [4, 0], [5, 100], [6, 100]] },
  { name: "no tiers", tiers: [], days: [[0, 0], [1, 0], [30, 0]] },
];

test("tiers pick the right percent across day boundaries", async () => {
  const { refundForCancellation } = await cancelModule();

  const hostZone = process.env.TZ;
  try {
    for (const [zone, januaryOffset] of HOST_ZONES) {
      process.env.TZ = zone;
      assert.equal(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset(), januaryOffset, `TZ=${zone} did not apply`);
      for (const [pickup, now, daysBefore] of DAY_COUNTS) {
        const counted = refundForCancellation([tier(0, 100)], 5000, jst(pickup), jst(now)).daysBefore;
        assert.equal(counted, daysBefore, `${now} to ${pickup}, TZ=${zone}`);
      }
    }
  } finally {
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  }

  // Paid amounts here are whole hundreds, so these refunds are exact. Rounding has its own test.
  const paid = 5000;
  for (const { pickup, tiers, times } of TIER_CHANGES) {
    for (const [now, daysBefore, refundPercent] of times) {
      assert.deepEqual(
        refundForCancellation(tiers, paid, jst(pickup), jst(now)),
        { daysBefore, refundPercent, refundJpy: 50 * refundPercent },
        `${now} to ${pickup}`,
      );
    }
  }

  // JST never changes its clocks, so a pickup a whole number of 24-hour days later is that many calendar days later.
  const now = jst("2026-06-01 09:00");
  const firstPickup = jst("2026-06-01 10:00");
  for (const { name, tiers, days } of TIER_SETS) {
    for (const [index, ordered] of orderings(tiers).entries()) {
      for (const [daysBefore, refundPercent] of days) {
        const label = `${name}, ordering ${index}, ${daysBefore} days before`;
        const startAt = firstPickup + daysBefore * DAY_MS;
        assert.deepEqual(
          refundForCancellation(ordered, 10_000, startAt, now),
          { daysBefore, refundPercent, refundJpy: 100 * refundPercent },
          label,
        );
        assert.deepEqual(
          refundForCancellation(ordered, 3_000, startAt, now),
          { daysBefore, refundPercent, refundJpy: 30 * refundPercent },
          label,
        );
      }
    }
  }

  // The day after pickup is below every tier, even one that starts at 0.
  assert.deepEqual(
    refundForCancellation([tier(0, 50)], 5000, jst("2026-08-10 09:00"), jst("2026-08-11 00:00")),
    { daysBefore: -1, refundPercent: 0, refundJpy: 0 },
  );
});

// [paid, percent, refund]: paid x percent as an integer, then its whole hundreds, so no float enters the expectation.
const ROUNDING: [number, number, number][] = [
  // Exact values with a fraction: 330.33, 500.5, 752.25, 751.5, 989.01, 99.99, 0.99, 1.99, 1099.89, 8271.15, 70000.07.
  // round or ceil go up on most of them.
  [1001, 33, 330],
  [1001, 50, 500],
  [1003, 75, 752],
  [1002, 75, 751],
  [999, 99, 989],
  [101, 99, 99],
  [99, 1, 0],
  [199, 1, 1],
  [3333, 33, 1099],
  [12_345, 67, 8271],
  [1_000_001, 7, 70_000],
  // Whole yen that paid * (percent / 100) lands just under, as 28.999... for the first.
  [100, 29, 29],
  [100, 57, 57],
  [100, 58, 58],
  [300, 41, 123],
  [700, 35, 245],
  [1500, 29, 435],
  [3000, 58, 1740],
  // Whole yen that (paid / 100) * percent or paid * 0.01 * percent lands just under.
  [58, 50, 29],
  [70, 90, 63],
  [140, 45, 63],
  [205, 60, 123],
  [232, 25, 58],
  // Whole yen with nothing to round.
  [100, 7, 7],
  [5000, 33, 1650],
  [5000, 50, 2500],
  // All of it, none of it, and nothing paid.
  [5000, 100, 5000],
  [12_345, 100, 12_345],
  [1, 100, 1],
  [5000, 0, 0],
  [0, 100, 0],
  [0, 33, 0],
];

test("refunds round down to whole yen", async () => {
  const { refundForCancellation } = await cancelModule();

  const startAt = jst("2026-08-10 09:00");
  const now = jst("2026-08-01 12:00");
  for (const [paid, refundPercent, refundJpy] of ROUNDING) {
    assert.deepEqual(
      refundForCancellation([tier(0, refundPercent)], paid, startAt, now),
      { daysBefore: 9, refundPercent, refundJpy },
      `${refundPercent}% of ${paid}`,
    );
  }
});

/** Long enough that a rental's end falls on another JST date from its pickup. */
const RENTAL_MS = 3 * DAY_MS;

// Every mapped column that can hold a value on a CONFIRMED booking, each different, so a dropped or swapped one shows.
const FILLED: Partial<BookingRow> = {
  package_id: "left-the-catalog",
  expires_at: 1001,
  catalog_version: 7,
  locale: "ko",
  guest_family_name: "Higa",
  guest_given_name: "Naomi",
  guest_email: "naomi@example.com",
  guest_phone: "+81-98-123-4567",
  external_ref: "external-1",
  external_channel: "channel-1",
  content_hash: "hash-1",
  payment_id: "square-payment-1",
  payment_attempt: 3,
  created_at: 1002,
  updated_at: 1003,
  confirmed_at: 1004,
};

/** A CONFIRMED web booking whose paid, deposit and price all differ, so the refund shows which one it came from. */
function confirmedBooking(pickup: string, paid: number): Partial<BookingRow> {
  const start_at = jst(pickup);
  return {
    ...FILLED,
    start_at,
    end_at: start_at + RENTAL_MS,
    paid_jpy: paid,
    deposit_jpy: paid + 1000,
    price_jpy: paid + 20_000,
  };
}

/** The Booking of a row, written out column by column. */
function mapped(row: BookingRow): Booking {
  return {
    id: row.id,
    ref: row.ref,
    status: row.status as Booking["status"],
    source: row.source as Booking["source"],
    modelId: row.model_id,
    packageId: row.package_id,
    vehiclePlate: row.vehicle_plate,
    startAt: row.start_at,
    endAt: row.end_at,
    expiresAt: row.expires_at,
    priceJpy: row.price_jpy,
    depositJpy: row.deposit_jpy,
    catalogVersion: row.catalog_version,
    locale: row.locale as Booking["locale"],
    guestFamilyName: row.guest_family_name,
    guestGivenName: row.guest_given_name,
    guestEmail: row.guest_email,
    guestPhone: row.guest_phone,
    externalRef: row.external_ref,
    externalChannel: row.external_channel,
    contentHash: row.content_hash,
    paymentId: row.payment_id,
    paymentAttempt: row.payment_attempt,
    paidJpy: row.paid_jpy,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
  };
}

type Quote = { daysBefore: number; refundPercent: number; refundJpy: number };

// Quotes against what the database holds. [pickup, paid, now, daysBefore, percent, refund]
const QUOTE_SETS: { tiers: TierRow[]; quotes: [string, number, string, number, number, number][] }[] = [
  {
    tiers: [
      { min_days_before: 7, refund_percent: 100 },
      { min_days_before: 3, refund_percent: 50 },
      { min_days_before: 0, refund_percent: 10 },
    ],
    quotes: [
      ["2026-08-10 09:00", 7001, "2026-08-02 23:59", 8, 100, 7001],
      ["2026-08-10 09:00", 7001, "2026-08-03 00:00", 7, 100, 7001],
      ["2026-08-10 09:00", 7001, "2026-08-04 00:00", 6, 50, 3500],
      ["2026-08-10 09:00", 7001, "2026-08-07 23:59", 3, 50, 3500],
      ["2026-08-10 09:00", 7001, "2026-08-08 00:00", 2, 10, 700],
      ["2026-08-10 09:00", 5000, "2026-08-05 12:00", 5, 50, 2500],
      ["2026-08-10 09:00", 0, "2026-08-05 12:00", 5, 50, 0],
      // The pickup day itself is still open, up to pickup.
      ["2026-08-10 09:00", 7001, "2026-08-10 00:00", 0, 10, 700],
      ["2026-08-10 09:00", 7001, "2026-08-10 08:59", 0, 10, 700],
    ],
  },
  {
    tiers: [
      { min_days_before: 14, refund_percent: 80 },
      { min_days_before: 2, refund_percent: 33 },
    ],
    quotes: [
      ["2026-12-31 18:00", 1001, "2026-12-17 00:00", 14, 80, 800],
      ["2026-12-31 18:00", 1001, "2026-12-17 23:59", 14, 80, 800],
      ["2026-12-31 18:00", 1001, "2026-12-18 00:00", 13, 33, 330],
      ["2026-12-31 18:00", 1001, "2026-12-29 23:59", 2, 33, 330],
      ["2027-01-20 10:00", 30_000, "2026-12-31 23:59", 20, 80, 24_000],
      // Inside the last tier's minimum nothing matches, so the booking can be cancelled for nothing back.
      ["2026-12-31 18:00", 1001, "2026-12-30 00:00", 1, 0, 0],
      ["2026-12-31 18:00", 1001, "2026-12-31 17:59", 0, 0, 0],
    ],
  },
  {
    tiers: [],
    quotes: [["2026-09-01 09:00", 5000, "2026-08-01 09:00", 31, 0, 0]],
  },
];

// Each with a clear reason a week before pickup. [what, changes to a confirmed web booking, reason]
const REFUSED: [string, Partial<BookingRow>, string][] = [
  ["a cancelled web booking", { status: "CANCELLED", cancel_reason: "guest", cancelled_at: 1005 }, "ALREADY_CANCELLED"],
  ["a web booking on hold", { status: "ON_HOLD", expires_at: jst("2026-08-03 09:15") }, "NOT_CANCELLABLE"],
  ["a web booking in payment", { status: "PAYMENT_PENDING" }, "NOT_CANCELLABLE"],
  ["an expired web booking", { status: "EXPIRED" }, "NOT_CANCELLABLE"],
  ["a confirmed block", { source: "block", external_ref: "block-1" }, "NOT_CANCELLABLE"],
];

// [pickup, daysBefore in the last millisecond before it]
const LAST_MOMENTS: [string, number][] = [
  ["2026-08-10 09:00", 0],
  ["2026-08-10 23:59", 0],
  ["2026-08-10 00:00", 1],
];

// From pickup itself, through the rental, to well after its end.
const AFTER_PICKUP_MS = [0, 1, MINUTE_MS, 6 * HOUR_MS, RENTAL_MS - 1, RENTAL_MS, 30 * DAY_MS];

/** Everything a quote must leave alone. */
async function writableRows(db: D1Database): Promise<unknown[]> {
  const rows = async (sql: string) => (await db.prepare(sql).all()).results;
  return [
    await rows("SELECT * FROM bookings ORDER BY id"),
    await rows("SELECT * FROM refunds ORDER BY id"),
    await rows("SELECT * FROM outbox ORDER BY id"),
  ];
}

test("only confirmed, not-yet-started web bookings can be quoted", async () => {
  const testDbs: TestDb[] = [];
  const openDb = async (): Promise<D1Database> => {
    const testDb = await createTestDb();
    testDbs.push(testDb);
    return testDb.db;
  };
  try {
    const quotable: { db: D1Database; row: BookingRow; now: number; quote: Quote }[] = [];
    for (const { tiers, quotes } of QUOTE_SETS) {
      const db = await openDb();
      await seedTiers(db, tiers);
      for (const [pickup, paid, now, daysBefore, refundPercent, refundJpy] of quotes) {
        const row = await seedBooking(db, confirmedBooking(pickup, paid));
        quotable.push({ db, row, now: jst(now), quote: { daysBefore, refundPercent, refundJpy } });
      }
    }

    // A full refund on every day, so a booking that gets past a check comes back ok: true with money in it.
    const db = await openDb();
    await seedTiers(db, [{ min_days_before: 0, refund_percent: 100 }]);
    const pickup = "2026-08-10 09:00";
    const paid = 5000;
    const refused: [string, BookingRow, string][] = [];
    for (const [what, change, reason] of REFUSED) {
      refused.push([what, await seedBooking(db, { ...confirmedBooking(pickup, paid), ...change }), reason]);
    }
    const cancelledBlock = await seedBooking(db, {
      ...confirmedBooking(pickup, paid),
      source: "block",
      external_ref: "block-2",
      status: "CANCELLED",
    });
    const lastMoments: [BookingRow, number][] = [];
    for (const [moment, daysBefore] of LAST_MOMENTS) {
      lastMoments.push([await seedBooking(db, confirmedBooking(moment, paid)), daysBefore]);
    }

    const { quoteCancellation } = await cancelModule();

    const allDbs = testDbs.map((testDb) => testDb.db);
    const before = await Promise.all(allDbs.map(writableRows));

    for (const { db: quotedDb, row, now, quote } of quotable) {
      const result = await quoteCancellation(quotedDb, row.id, now);
      const label = `${row.id}, ${row.paid_jpy} paid, at ${new Date(now).toISOString()}`;
      assert.deepEqual(result, { ok: true, booking: mapped(row), ...quote }, label);
    }

    // Ids that do not exist, among them near misses of real ones, the ref a guest sees, and hostile text.
    const [existing] = lastMoments[0];
    const unknownIds = [
      "no-such-booking",
      "",
      `${existing.id}x`,
      existing.id.toUpperCase(),
      existing.ref,
      "%",
      "' OR '1'='1",
    ];
    for (const id of unknownIds) {
      const result = await quoteCancellation(db, id, jst("2026-08-03 09:00"));
      assert.deepEqual(result, { ok: false, reason: "NOT_FOUND" }, `id ${JSON.stringify(id)}`);
    }

    for (const [what, row, reason] of refused) {
      const result = await quoteCancellation(db, row.id, row.start_at - 7 * DAY_MS);
      assert.deepEqual(result, { ok: false, reason }, what);
      // After pickup more than one reason fits. Which one wins is not settled, only that nothing is quoted.
      assert.equal((await quoteCancellation(db, row.id, row.start_at + HOUR_MS)).ok, false, `${what}, after pickup`);
    }
    for (const now of [cancelledBlock.start_at - 7 * DAY_MS, cancelledBlock.start_at + HOUR_MS]) {
      assert.equal((await quoteCancellation(db, cancelledBlock.id, now)).ok, false, "a cancelled block");
    }

    for (const [row, daysBefore] of lastMoments) {
      const label = `pickup ${new Date(row.start_at).toISOString()}`;
      assert.deepEqual(
        await quoteCancellation(db, row.id, row.start_at - 1),
        { ok: true, booking: mapped(row), daysBefore, refundPercent: 100, refundJpy: paid },
        `${label}, a millisecond before`,
      );
      for (const offset of AFTER_PICKUP_MS) {
        const result = await quoteCancellation(db, row.id, row.start_at + offset);
        assert.deepEqual(result, { ok: false, reason: "STARTED" }, `${label}, ${offset} ms after`);
      }
    }

    assert.deepEqual(await Promise.all(allDbs.map(writableRows)), before, "a quote changed something");
  } finally {
    await Promise.all(testDbs.map((testDb) => testDb.dispose()));
  }
});

const SECRET = "test-cancel-link-secret";

function hmac(secret: string, message: string): Buffer {
  return createHmac("sha256", secret).update(message, "utf8").digest();
}

function expectedToken(secret: string, id: string): string {
  return hmac(secret, `cancel:${id}`).toString("base64url").slice(0, 32);
}

/** An id whose token holds `symbol` at least twice in standard base64, so translating only the first is not enough. */
function idWithTwo(symbol: string): string {
  for (let n = 0; n < 100_000; n += 1) {
    const id = `booking-${n}`;
    const standard = hmac(SECRET, `cancel:${id}`).toString("base64").slice(0, 32);
    if (standard.split(symbol).length > 2) return id;
  }
  throw new Error(`no id gives two of ${symbol}`);
}

function swapCase(text: string): string {
  return Array.from(text, (char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase())).join("");
}

/** `token` with its first character as %XX. No base64url character needs that, but each decodes back from it. */
function percentEncodedFirst(token: string): string {
  return `%${token.charCodeAt(0).toString(16).toUpperCase()}${token.slice(1)}`;
}

/** `token` with each adjacent pair of different characters swapped: signed differences of its codes still sum to 0. */
function adjacentSwaps(token: string): string[] {
  const swaps: string[] = [];
  for (let i = 0; i + 1 < token.length; i += 1) {
    if (token[i] !== token[i + 1]) swaps.push(token.slice(0, i) + token[i + 1] + token[i] + token.slice(i + 2));
  }
  return swaps;
}

/** Everything that is almost `token`: each of these must be refused for the booking it belongs to, without throwing. */
function nearMisses(token: string, fullDigest: string): string[] {
  const misses: string[] = [];
  for (let i = 0; i < token.length; i += 1) {
    for (const replacement of ["A", "z", "0", "-", "_"]) {
      if (token[i] !== replacement) misses.push(token.slice(0, i) + replacement + token.slice(i + 1));
    }
  }
  for (let length = 0; length < token.length; length += 1) {
    misses.push(token.slice(0, length), token.slice(token.length - length));
  }
  misses.push(`${token}A`, `${token}=`, `${token} `, ` ${token}`, `${token}\n`, token + token, fullDigest);
  misses.push(token.toUpperCase(), token.toLowerCase(), swapCase(token));
  // Non-ASCII, some of the same length in UTF-16. The last has the real first character's low byte, which a cut to
  // bytes would hide.
  misses.push(
    `${token.slice(0, 31)}é`,
    `é${token.slice(1)}`,
    "é".repeat(32),
    "🏍".repeat(16),
    "日本語",
    "\ud800".repeat(32),
    String.fromCharCode(token.charCodeAt(0) + 0x100) + token.slice(1),
  );
  misses.push(...adjacentSwaps(token));
  // A decode of what searchParams.get has already decoded: the first of these opens the booking, the others throw.
  misses.push(percentEncodedFirst(token), "%", `${token}%`);
  return misses;
}

const CRYPTO_FILE = new URL("../src/lib/crypto.ts", import.meta.url).href;

/**
 * What `verify` returned, for each of `texts` the indexes it read through charCodeAt, in order, and how many of those
 * reads came from outside src/lib/crypto.ts, going by the Error node:test keeps on each mock call to show its callsite.
 * The spy calls through, is on for that one verify, and comes off even if it throws. Reads of any other string are
 * dropped, so the HMAC, btoa, the runner and whatever Miniflare left running in this process cannot move the result.
 */
async function charCodeReads(verify: () => Promise<boolean>, ...texts: string[]) {
  const spy = mock.method(String.prototype, "charCodeAt");
  let ok: boolean;
  try {
    ok = await verify();
  } finally {
    spy.mock.restore();
  }
  const calls = spy.mock.calls;
  const textCalls = texts.map((text) => calls.filter((call) => call.this === text));
  const indexes = textCalls.map((reads) => reads.map((call) => call.arguments[0]));
  const elsewhere = textCalls.flat().filter((call) => !call.stack.stack?.includes(CRYPTO_FILE)).length;
  return { ok, indexes, elsewhere };
}

test("tokens verify only for their booking and secret", async () => {
  const plusId = idWithTwo("+");
  const slashId = idWithTwo("/");
  const ids = [
    "booking-1",
    "booking-2",
    "booking-10",
    "3f2b8c1e-7a41-4d3e-9c55-0b6a1d2e4f70",
    "01JBX7Q2M9ZK4T8R6V3N5H0WYC",
    "予約-沖縄",
    plusId,
    slashId,
  ];
  const secrets = [SECRET, "another-secret", "0123456789abcdef".repeat(4), "x".repeat(65), "秘密の鍵"];

  // Built and checked ahead of the import, so a near miss that is not what it claims fails here, not on the coder.
  const almostTokens = ["booking-1", plusId, slashId].map((id) => {
    const token = expectedToken(SECRET, id);
    const misses = nearMisses(token, hmac(SECRET, `cancel:${id}`).toString("base64url"));
    assert.equal(misses.includes(token), false, `${id}, the token itself among its near misses`);
    assert.equal(decodeURIComponent(percentEncodedFirst(token)), token, `${id}, percent-encoded first character`);
    assert.notEqual(adjacentSwaps(token).length, 0, `${id}, no adjacent characters to swap`);
    return { id, misses };
  });

  const { cancelToken, verifyCancelToken } = await cancelModule();

  for (const secret of secrets) {
    for (const id of ids) {
      const label = `${id} under ${secret.slice(0, 12)}`;
      const token = await cancelToken(secret, id);
      assert.equal(token, expectedToken(secret, id), label);
      assert.match(token, /^[A-Za-z0-9_-]{32}$/, label);
      assert.equal(await cancelToken(secret, id), token, `${label}, again`);
      assert.equal(await verifyCancelToken(secret, id, token), true, label);

      // The input really has the prefix: an HMAC of the bare id opens nothing.
      const unprefixed = hmac(secret, id).toString("base64url").slice(0, 32);
      assert.equal(await verifyCancelToken(secret, id, unprefixed), false, `${label}, no prefix`);
    }
  }

  // The token of these ids has + or / twice in standard base64, which is not safe in a URL.
  for (const id of [plusId, slashId]) {
    const token = await cancelToken(SECRET, id);
    const standard = hmac(SECRET, `cancel:${id}`).toString("base64").slice(0, 32);
    assert.notEqual(token, standard, id);
    assert.doesNotMatch(token, /[+/=]/, id);
    assert.equal(await verifyCancelToken(SECRET, id, standard), false, `${id}, standard base64`);
  }

  // A token opens its own booking under its own secret and no other pairing.
  for (const tokenId of ids) {
    const token = expectedToken(SECRET, tokenId);
    for (const id of ids) {
      assert.equal(await verifyCancelToken(SECRET, id, token), id === tokenId, `${tokenId}'s token on ${id}`);
    }
  }
  for (const tokenSecret of secrets) {
    const token = expectedToken(tokenSecret, "booking-1");
    for (const secret of secrets) {
      const label = `${tokenSecret.slice(0, 12)}'s token under ${secret.slice(0, 12)}`;
      assert.equal(await verifyCancelToken(secret, "booking-1", token), secret === tokenSecret, label);
    }
  }

  // Ids and secrets a character or a case away.
  const firstToken = expectedToken(SECRET, "booking-1");
  const closeIds = ["", "booking-11", "booking-", "Booking-1", " booking-1", "booking-1 ", "booking-1\n"];
  // A decoded id would open the booking or throw. A throw or a rejection fails the test at this await.
  closeIds.push("booking%2D1", "%");
  for (const id of [...closeIds, "cancel:booking-1"]) {
    assert.equal(await verifyCancelToken(SECRET, id, firstToken), false, `id ${JSON.stringify(id)}`);
  }
  for (const secret of [`${SECRET} `, SECRET.slice(0, -1), SECRET.toUpperCase(), ` ${SECRET}`]) {
    const label = `secret ${JSON.stringify(secret)}`;
    assert.equal(await verifyCancelToken(secret, "booking-1", firstToken), false, label);
    assert.equal(await verifyCancelToken(SECRET, "booking-1", await cancelToken(secret, "booking-1")), false, label);
  }

  for (const { id, misses } of almostTokens) {
    for (const miss of misses) {
      assert.equal(await verifyCancelToken(SECRET, id, miss), false, `${id}, token ${JSON.stringify(miss)}`);
    }
  }

  // "The comparison uses timingSafeEqual from src/lib/crypto.ts." This pins that a verify reads every character of both
  // tokens wherever they first differ, as that helper does through charCodeAt and as === or an early return cannot, and
  // that the reads run in that file, which a hand-written loop or an unused import cannot do. It does not measure time.
  const everyIndex = new Set(Array.from(firstToken, (_, index) => index));

  const match = await charCodeReads(() => verifyCancelToken(SECRET, "booking-1", firstToken), firstToken);
  assert.equal(match.ok, true, "the real token, spied on");
  assert.deepEqual(new Set(match.indexes[0]), everyIndex, "the real token reads every character");
  assert.equal(match.elsewhere, 0, "the real token, reads outside src/lib/crypto.ts");

  const readsByIndex: number[][][] = [];
  for (const index of everyIndex) {
    const changed = firstToken.slice(0, index) + (firstToken[index] === "A" ? "B" : "A") + firstToken.slice(index + 1);
    const verify = () => verifyCancelToken(SECRET, "booking-1", changed);
    const { ok, indexes, elsewhere } = await charCodeReads(verify, changed, firstToken);
    assert.equal(ok, false, `a token that differs at ${index}, spied on`);
    assert.equal(elsewhere, 0, `a token that differs at ${index}, reads outside src/lib/crypto.ts`);
    readsByIndex.push(indexes);
  }

  const readsAtLast = readsByIndex[readsByIndex.length - 1];
  assert.deepEqual(new Set(readsAtLast[0]), everyIndex, "a difference at the last character, the presented token");
  assert.deepEqual(new Set(readsAtLast[1]), everyIndex, "a difference at the last character, the real token");
  // The property itself: a difference at the first character does exactly the reads of one at the last.
  for (const [index, reads] of readsByIndex.entries()) {
    assert.deepEqual(reads, readsAtLast, `a difference at ${index} reads other than one at the last`);
  }
});

// [siteUrl, locale, id, token, the URL as the ticket writes it]
const URLS: [string, Locale, string, string, string][] = [
  [
    "http://localhost:4321",
    "en",
    "booking-1",
    "-leading_dash-and_underscore",
    "http://localhost:4321/en/booking/cancel?b=booking-1&t=-leading_dash-and_underscore",
  ],
  [
    "https://okinawa-dream.example",
    "ja",
    "3f2b8c1e-7a41-4d3e-9c55-0b6a1d2e4f70",
    "abc_DEF-123",
    "https://okinawa-dream.example/ja/booking/cancel?b=3f2b8c1e-7a41-4d3e-9c55-0b6a1d2e4f70&t=abc_DEF-123",
  ],
  [
    "https://www.okinawa-dream.example",
    "zh-cn",
    "01JBX7Q2M9ZK4T8R6V3N5H0WYC",
    "ZZzz0099__--AAaa",
    "https://www.okinawa-dream.example/zh-cn/booking/cancel?b=01JBX7Q2M9ZK4T8R6V3N5H0WYC&t=ZZzz0099__--AAaa",
  ],
  ["https://book.example.co.jp", "ko", "B", "t", "https://book.example.co.jp/ko/booking/cancel?b=B&t=t"],
];

// The signature takes any string, and nothing in the repo generates booking ids yet.
const RESERVED = ["a&b=1", "x&t=forged", "a b", "a+b", "a#b", "a/b?c=d", "100%25", "a=b", "予約", "🏍"];

test("cancelUrl has the documented shape", async () => {
  const { cancelToken, cancelUrl, verifyCancelToken } = await cancelModule();

  for (const [siteUrl, locale, id, token, expected] of URLS) {
    assert.equal(cancelUrl(siteUrl, locale, id, token), expected);
  }

  // Anything a query string could misread comes back as it went in, in its own parameter.
  const siteUrl = "https://okinawa-dream.example";
  for (const value of RESERVED) {
    const pairs = [
      [value, "plain-token"],
      ["booking-1", value],
      [value, value],
    ];
    for (const [id, token] of pairs) {
      const url = new URL(cancelUrl(siteUrl, "en", id, token));
      const label = `id ${id}, token ${token}`;
      assert.equal(`${url.origin}${url.pathname}`, `${siteUrl}/en/booking/cancel`, label);
      assert.deepEqual([...url.searchParams], [["b", id], ["t", token]], label);
      assert.equal(url.hash, "", label);
    }
  }

  // The link in the email opens the booking it was made for, in every locale.
  const id = "3f2b8c1e-7a41-4d3e-9c55-0b6a1d2e4f70";
  for (const locale of LOCALES) {
    const url = new URL(cancelUrl("http://localhost:4321", locale, id, await cancelToken(SECRET, id)));
    assert.equal(url.pathname, `/${locale}/booking/cancel`);
    const [b, t] = [url.searchParams.get("b") ?? "", url.searchParams.get("t") ?? ""];
    assert.equal(b, id);
    assert.equal(await verifyCancelToken(SECRET, b, t), true, locale);
  }
});
