// applicablePrice, src/lib/pricing.ts (#131): which of a price row's two prices a booking pays. The advance price applies
// when the JST date of the booking is before the JST date of the pickup, and only on a row that has one; otherwise the
// regular price does. Every instant here is Date.parse on an explicit +09:00 offset, and which side of the rule each pair
// falls on is written by hand, never worked out through src/lib/time.ts or the code under test.
//
// The contract read here, and nothing more of the module:
//   applicablePrice(price: { priceJpy: number; advancePriceJpy: number | null }, bookedAt: number, startAt: number): number
//   where bookedAt (the moment of booking) and startAt (the pickup) are epoch ms UTC.
import assert from "node:assert/strict";
import { test } from "node:test";

type PriceRow = { priceJpy: number; advancePriceJpy: number | null };

/**
 * Loaded here, so the test fails on its own while the module is missing. The ts-ignore covers that missing module for lint
 * and nothing else: once the module exists, this call is checked against its real types.
 */
async function pricing() {
  // @ts-ignore
  return await import("../src/lib/pricing.ts");
}

/** A JST wall clock, `YYYY-MM-DD HH:mm:ss` with optional milliseconds, as an instant. */
function jst(wall: string): number {
  const instant = Date.parse(`${wall.replace(" ", "T")}+09:00`);
  assert.ok(Number.isFinite(instant), `bad fixture time ${wall}`);
  return instant;
}

/** The UTC calendar date of an instant, to show a case really straddles a UTC date the JST one does not. */
function utcDate(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

// [label, booked at (JST), pickup (JST), whether the advance price applies]. Written out by hand from the rule: the JST date
// of the booking against the JST date of the pickup, nothing about hours or UTC.
const CASES: [label: string, booked: string, pickup: string, advance: boolean][] = [
  ["nine days ahead", "2030-06-01 12:00:00", "2030-06-10 09:00:00", true],
  ["the day before at noon", "2030-06-09 12:00:00", "2030-06-10 09:00:00", true],
  // JST midnight is the boundary, to the millisecond.
  ["23:59:59 JST the day before", "2030-06-09 23:59:59", "2030-06-10 09:00:00", true],
  ["the last millisecond of the day before", "2030-06-09 23:59:59.999", "2030-06-10 17:30:00", true],
  ["00:00:00 JST on the pickup date", "2030-06-10 00:00:00", "2030-06-10 09:00:00", false],
  ["the first millisecond of the pickup date", "2030-06-10 00:00:00.001", "2030-06-10 17:30:00", false],
  // 2030-06-10 08:30 JST is 2030-06-09 23:30 UTC, and 09:00 JST is 00:00 UTC on the 10th: a UTC date says the day before.
  ["08:30 JST on the pickup date, the day before in UTC", "2030-06-10 08:30:00", "2030-06-10 09:00:00", false],
  ["08:59 JST on the pickup date, for a pickup that evening", "2030-06-10 08:59:00", "2030-06-10 17:30:00", false],
  // 10:00 JST on the 9th is 01:00 UTC on the 9th, and 08:00 JST on the 10th is 23:00 UTC on the 9th: one UTC date.
  ["the day before, on the same UTC date as an early pickup", "2030-06-09 10:00:00", "2030-06-10 08:00:00", true],
  ["just after 09:00 JST the day before, for an 08:30 pickup", "2030-06-09 09:00:01", "2030-06-10 08:30:00", true],
  // Hours apart decide nothing: a minute before a midnight pickup is advance, a whole day of notice on the day is not.
  ["one minute before a pickup at midnight", "2030-06-09 23:59:00", "2030-06-10 00:00:00", true],
  ["almost 24 hours ahead on the pickup date", "2030-06-10 00:00:00", "2030-06-10 23:59:00", false],
  ["minutes before the pickup", "2030-06-10 17:00:00", "2030-06-10 17:30:00", false],
  // Month, year and leap-day boundaries in JST, where UTC is still on the earlier date.
  ["the last evening of February", "2030-02-28 23:30:00", "2030-03-01 09:00:00", true],
  ["the first morning of March", "2030-03-01 00:10:00", "2030-03-01 10:00:00", false],
  ["new year's eve, 23:59:59 JST", "2030-12-31 23:59:59", "2031-01-01 09:00:00", true],
  ["new year's day, 00:00 JST, still 2030 in UTC", "2031-01-01 00:00:00", "2031-01-01 09:00:00", false],
  ["the eve of a leap day", "2032-02-28 23:59:59", "2032-02-29 09:00:00", true],
  ["a leap day itself", "2032-02-29 00:00:00", "2032-02-29 12:00:00", false],
  ["months ahead", "2030-01-15 18:00:00", "2030-07-15 09:00:00", true],
  // Not before the pickup's date, so not the advance price.
  ["a day after the pickup date", "2030-06-11 09:00:00", "2030-06-10 09:00:00", false],
];

/** Several rows, as staff fill them in: three with an advance price, one equal to its regular price, two without. */
const ROWS: PriceRow[] = [
  { priceJpy: 4500, advancePriceJpy: 4000 },
  { priceJpy: 10000, advancePriceJpy: 9000 },
  { priceJpy: 2500, advancePriceJpy: 2000 },
  { priceJpy: 31415, advancePriceJpy: 27183 },
  { priceJpy: 6000, advancePriceJpy: 6000 },
  { priceJpy: 7300, advancePriceJpy: null },
  { priceJpy: 18900, advancePriceJpy: null },
];

/** Zones on both sides of JST and JST itself: the host's zone must never enter. */
const HOST_ZONES = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata"];

test("the advance price applies before the pickup's JST date", async () => {
  const { applicablePrice } = await pricing();

  // The fixture straddles what it says it does, so the cases cannot quietly stop testing UTC against JST.
  assert.notEqual(utcDate(jst("2030-06-10 08:30:00")), utcDate(jst("2030-06-10 09:00:00")));
  assert.equal(utcDate(jst("2030-06-09 10:00:00")), utcDate(jst("2030-06-10 08:00:00")));
  assert.equal(utcDate(jst("2031-01-01 00:00:00")), "2030-12-31");

  const zone = process.env.TZ;
  try {
    for (const host of HOST_ZONES) {
      process.env.TZ = host;
      for (const [label, booked, pickup, advance] of CASES) {
        for (const row of ROWS) {
          const expected = advance && row.advancePriceJpy !== null ? row.advancePriceJpy : row.priceJpy;
          const actual: unknown = applicablePrice({ ...row }, jst(booked), jst(pickup));
          assert.equal(
            actual,
            expected,
            `${label} (booked ${booked}, pickup ${pickup} JST, host ${host}): ${JSON.stringify(row)}`,
          );
        }
      }
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }

  // Both answers occur for every row with a lower advance price, so neither price alone passes.
  for (const row of ROWS.filter(({ priceJpy, advancePriceJpy }) => advancePriceJpy !== null && advancePriceJpy < priceJpy)) {
    const answers = new Set(CASES.map(([, booked, pickup]) => applicablePrice({ ...row }, jst(booked), jst(pickup))));
    assert.deepEqual([...answers].sort(), [row.advancePriceJpy, row.priceJpy].sort(), JSON.stringify(row));
  }

  // The row is read, not kept: the same moments give each row its own amounts, and the row is left as it was.
  const row = { priceJpy: 12_345, advancePriceJpy: 11_111 };
  assert.equal(applicablePrice(row, jst("2030-06-09 23:59:59"), jst("2030-06-10 09:00:00")), 11_111);
  assert.equal(applicablePrice(row, jst("2030-06-10 00:00:00"), jst("2030-06-10 09:00:00")), 12_345);
  assert.deepEqual(row, { priceJpy: 12_345, advancePriceJpy: 11_111 });
});
