// Per-model availability through searchAvailability: which models come back, how many bikes are free, at what price.
// Expected values are written out from the ticket's rules on wall clocks with an explicit +09:00 offset. rentalEnd and
// conflicts are task #11's and only check those hand-worked tables, never the code under test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { conflicts, rentalEnd } from "../src/lib/db/blocking.ts";
import type { ShopConfig, VehicleTypeId } from "../src/lib/types.ts";
import { createTestDb } from "./helpers/d1.ts";
import {
  seedBooking,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedType,
  seedVehicle,
} from "./helpers/seed.ts";
import type { BookingRow, ModelRow } from "./helpers/seed.ts";

type CcBand = "upto50" | "51to125" | "126to400" | "over400";

type Query = { startAt: number; packageId: string; typeId?: VehicleTypeId; ccBand?: CcBand; now: number };

type Available = { modelId: string; vacancies: number; priceJpy: number; depositJpy: number };

type Found = [modelId: string, vacancies: number];

type Shop = { packageId: string; rateClassId: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Pickup and return times are in the future of NOW, so `now` only ever decides whether a hold has expired. */
const NOW = jst("08-01 12:00");
const PICKUP = jst("08-10 10:00");

/**
 * Loaded here, so each test seeds its fixtures and fails on its own while the module is missing. The ts-ignore covers
 * that missing module for lint and nothing else: once the module exists, this call is checked against its real types.
 */
async function search(db: D1Database, query: Query): Promise<Available[]> {
  // @ts-ignore
  const { searchAvailability } = await import("../src/lib/booking/availability.ts");
  return searchAvailability(db, query);
}

/** The instant of a JST wall clock in 2030, written `MM-DD HH:mm`. */
function jst(wall: string): number {
  return Date.parse(`2030-${wall.replace(" ", "T")}:00+09:00`);
}

async function withDb(run: (db: D1Database) => Promise<void>): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await run(db);
  } finally {
    await dispose();
  }
}

function sorted(entries: Found[]): Found[] {
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The model and vacancies of each row, in a fixed order, for the tests that are not about the order. */
function found(rows: Available[]): Found[] {
  return sorted(rows.map((row) => [row.modelId, row.vacancies]));
}

/** A published shop: config, the three types with their deposits, and one days package priced in one rate class. */
async function seedShop(
  db: D1Database,
  days: number,
  config: Record<string, string | number> = {},
  priceJpy = 8000,
): Promise<Shop> {
  await seedConfig(db, config);
  await seedType(db, { id: "scooter", deposit_jpy: 3000 });
  await seedType(db, { id: "motorcycle", deposit_jpy: 5000 });
  await seedType(db, { id: "car", deposit_jpy: 20000 });
  const pkg = await seedPackage(db, { days });
  const rate = await seedRateClass(db);
  await seedPrice(db, { rate_class_id: rate.id, package_id: pkg.id, price_jpy: priceJpy });
  return { packageId: pkg.id, rateClassId: rate.id };
}

/** A model of a rate class with bikes: a number of active ones, or one per status. */
async function seedFleet(
  db: D1Database,
  { rateClassId }: Pick<Shop, "rateClassId">,
  bikes: number | string[],
  model: Partial<ModelRow> = {},
): Promise<{ id: string; plates: string[] }> {
  const { id } = await seedModel(db, { rate_class_id: rateClassId, ...model });
  const statuses = typeof bikes === "number" ? Array<string>(bikes).fill("active") : bikes;
  const plates: string[] = [];
  for (const status of statuses) plates.push((await seedVehicle(db, { model_id: id, status })).plate);
  return { id, plates };
}

/** A booking of `plate` between two wall clocks, CONFIRMED unless `extra` says otherwise. */
async function book(
  db: D1Database,
  plate: string,
  [start, end]: [string, string],
  extra: Partial<BookingRow> = {},
): Promise<void> {
  await seedBooking(db, { vehicle_plate: plate, start_at: jst(start), end_at: jst(end), ...extra });
}

const SHOP_CONFIG: ShopConfig = {
  shopOpen: "09:00",
  shopClose: "18:00",
  slotMinutes: 30,
  turnaroundMinutes: 60,
  holdMinutes: 15,
  minLeadHours: 24,
  maxDaysAhead: 180,
  photoMaxMb: 5,
};

// [booking start, booking end, whether the bike stays free]. Each table is worked by hand from
// `b.start_at < return + buffer` and `pickup < b.end_at + buffer`.
const RENTALS: {
  label: string;
  days: number;
  shopClose: string;
  turnaround: number;
  pickup: string;
  returnAt: string;
  bookings: [string, string, boolean][];
}[] = [
  {
    label: "one day, 60 minutes of buffer",
    days: 1,
    shopClose: "18:00",
    turnaround: 60,
    pickup: "08-10 10:00",
    returnAt: "08-10 18:00",
    bookings: [
      ["08-09 09:00", "08-09 18:00", true],
      ["08-10 08:00", "08-10 09:00", true],
      ["08-10 08:00", "08-10 09:01", false],
      ["08-10 12:00", "08-10 13:00", false],
      ["08-09 09:00", "08-11 18:00", false],
      ["08-10 18:59", "08-10 20:00", false],
      ["08-10 19:00", "08-10 20:00", true],
      ["08-11 09:00", "08-11 18:00", true],
    ],
  },
  {
    // A return of 3 x 24 hours later would be 08-13 10:00, and would wrongly block the last two free rows.
    label: "three days, returning by closing time on the last day",
    days: 3,
    shopClose: "18:00",
    turnaround: 60,
    pickup: "08-10 10:00",
    returnAt: "08-12 18:00",
    bookings: [
      ["08-10 08:00", "08-10 09:00", true],
      ["08-11 09:00", "08-11 18:00", false],
      ["08-12 09:00", "08-12 12:00", false],
      ["08-12 18:30", "08-13 18:00", false],
      ["08-12 18:59", "08-13 18:00", false],
      ["08-12 19:00", "08-13 18:00", true],
      ["08-13 09:00", "08-13 18:00", true],
    ],
  },
  {
    label: "seven days, 30 minutes of buffer, closing at 17:00",
    days: 7,
    shopClose: "17:00",
    turnaround: 30,
    pickup: "08-10 16:30",
    returnAt: "08-16 17:00",
    bookings: [
      ["08-10 09:00", "08-10 16:00", true],
      ["08-10 09:00", "08-10 16:01", false],
      ["08-16 09:00", "08-16 12:00", false],
      ["08-16 17:29", "08-17 12:00", false],
      ["08-16 17:30", "08-17 12:00", true],
    ],
  },
  {
    // 08:30 JST on 08-10 is still 08-09 in UTC, and the rental ends on the JST date.
    label: "one day from an early pickup, no buffer, closing at 19:30",
    days: 1,
    shopClose: "19:30",
    turnaround: 0,
    pickup: "08-10 08:30",
    returnAt: "08-10 19:30",
    bookings: [
      ["08-09 12:00", "08-10 08:30", true],
      ["08-09 12:00", "08-10 08:31", false],
      ["08-10 19:29", "08-10 21:00", false],
      ["08-10 19:30", "08-10 21:00", true],
    ],
  },
  {
    label: "three days across a month end, 120 minutes of buffer",
    days: 3,
    shopClose: "18:00",
    turnaround: 120,
    pickup: "08-30 12:00",
    returnAt: "09-01 18:00",
    bookings: [
      ["08-30 08:00", "08-30 10:00", true],
      ["08-30 08:00", "08-30 10:01", false],
      ["09-01 19:59", "09-02 12:00", false],
      ["09-01 20:00", "09-02 12:00", true],
    ],
  },
];

test("returns only models with a free bike for the whole rental plus buffer", async () => {
  // The hand-worked tables first, against task #11's rule, so a mistake in one is not blamed on the search.
  for (const { label, days, shopClose, turnaround, pickup, returnAt, bookings } of RENTALS) {
    const rental = { startAt: jst(pickup), endAt: jst(returnAt) };
    assert.equal(rentalEnd(rental.startAt, { days }, { ...SHOP_CONFIG, shopClose }), rental.endAt, `the table: ${label}`);
    for (const [start, end, free] of bookings) {
      const booking = { startAt: jst(start), endAt: jst(end) };
      assert.equal(conflicts(rental, booking, turnaround * MINUTE_MS), !free, `the table: ${label}, ${start} to ${end}`);
    }
  }

  for (const { label, days, shopClose, turnaround, pickup, bookings } of RENTALS) {
    await withDb(async (db) => {
      const shop = await seedShop(db, days, { shop_close: shopClose, turnaround_minutes: turnaround });

      // One model per row, each with one bike, and one nobody booked.
      const untouched = await seedFleet(db, shop, 1);
      const expected: Found[] = [[untouched.id, 1]];
      for (const [start, end, free] of bookings) {
        const { id, plates } = await seedFleet(db, shop, 1);
        await book(db, plates[0], [start, end]);
        if (free) expected.push([id, 1]);
      }

      const rows = await search(db, { startAt: jst(pickup), packageId: shop.packageId, now: NOW });
      assert.deepEqual(found(rows), sorted(expected), label);
    });
  }

  // At every moment of this rental one of the two bikes is free, but neither is free for all of it.
  await withDb(async (db) => {
    const shop = await seedShop(db, 3);
    const relay = await seedFleet(db, shop, 2);
    await book(db, relay.plates[0], ["08-10 11:00", "08-10 13:00"]);
    await book(db, relay.plates[1], ["08-12 11:00", "08-12 13:00"]);
    const open = await seedFleet(db, shop, 1);

    const rows = await search(db, { startAt: PICKUP, packageId: shop.packageId, now: NOW });
    assert.deepEqual(found(rows), [[open.id, 1]]);
  });
});

// Each day of a three-day rental from PICKUP. A bike can carry several of these and is still one bike.
const RENTAL_DAYS: [string, string][] = [
  ["08-10 11:00", "08-10 13:00"],
  ["08-11 11:00", "08-11 13:00"],
  ["08-12 11:00", "08-12 13:00"],
];

const OUTSIDE_THE_RENTAL: [string, string] = ["08-20 09:00", "08-20 18:00"];

// `overlapping` names the bike of each booking; the nth one falls on RENTAL_DAYS[n % 3]. `outside` names bikes with a
// booking well away from the rental. `threeDays` is the vacancies for the three-day package from PICKUP, and `oneDay`
// for the one-day package from PICKUP, which only the bookings on the first day reach.
const FLEETS: { fleet: number; overlapping: number[]; outside: number[]; threeDays: number; oneDay: number }[] = [
  { fleet: 1, overlapping: [], outside: [0], threeDays: 1, oneDay: 1 },
  { fleet: 1, overlapping: [0], outside: [], threeDays: 0, oneDay: 0 },
  { fleet: 3, overlapping: [], outside: [], threeDays: 3, oneDay: 3 },
  { fleet: 3, overlapping: [1], outside: [0, 2], threeDays: 2, oneDay: 2 },
  { fleet: 3, overlapping: [0, 1], outside: [], threeDays: 1, oneDay: 2 },
  { fleet: 3, overlapping: [2, 2], outside: [], threeDays: 2, oneDay: 2 },
  { fleet: 3, overlapping: [0, 1, 2], outside: [], threeDays: 0, oneDay: 2 },
  { fleet: 5, overlapping: [], outside: [0, 1, 2, 3, 4], threeDays: 5, oneDay: 5 },
  { fleet: 5, overlapping: [0, 1], outside: [], threeDays: 3, oneDay: 4 },
  { fleet: 5, overlapping: [4, 4, 4], outside: [], threeDays: 4, oneDay: 4 },
  { fleet: 5, overlapping: [0, 0, 1, 1], outside: [], threeDays: 3, oneDay: 3 },
  { fleet: 5, overlapping: [0, 1, 2, 3], outside: [4], threeDays: 1, oneDay: 3 },
  { fleet: 5, overlapping: [0, 1, 2, 3, 4], outside: [], threeDays: 0, oneDay: 3 },
];

/** Everything that holds a bike in turn: a paid booking, a charge in flight, a live hold and a staff block. */
function blocker(index: number, ref: string): Partial<BookingRow> {
  const blockers: Partial<BookingRow>[] = [
    { status: "CONFIRMED" },
    { status: "PAYMENT_PENDING" },
    { status: "ON_HOLD", expires_at: NOW + 15 * MINUTE_MS },
    { status: "CONFIRMED", source: "block", external_ref: ref },
  ];
  return blockers[index % blockers.length];
}

test("vacancies count free bikes per model", async () => {
  await withDb(async (db) => {
    const threeDays = await seedShop(db, 3);
    const oneDay = (await seedPackage(db, { days: 1 })).id;
    await seedPrice(db, { rate_class_id: threeDays.rateClassId, package_id: oneDay });

    const expectedThreeDays: Found[] = [];
    const expectedOneDay: Found[] = [];
    const expectedLater: Found[] = [];
    for (const [row, { fleet, overlapping, outside, threeDays: free, oneDay: freeOneDay }] of FLEETS.entries()) {
      const { id, plates } = await seedFleet(db, threeDays, fleet);
      for (const [index, bike] of overlapping.entries()) {
        const extra = blocker(index + row, `ota-${row}-${index}`);
        await book(db, plates[bike], RENTAL_DAYS[index % RENTAL_DAYS.length], extra);
      }
      for (const bike of outside) await book(db, plates[bike], OUTSIDE_THE_RENTAL);
      if (free > 0) expectedThreeDays.push([id, free]);
      if (freeOneDay > 0) expectedOneDay.push([id, freeOneDay]);
      expectedLater.push([id, fleet]);
    }

    const query = { startAt: PICKUP, now: NOW };
    assert.deepEqual(found(await search(db, { ...query, packageId: threeDays.packageId })), sorted(expectedThreeDays));
    assert.deepEqual(found(await search(db, { ...query, packageId: oneDay })), sorted(expectedOneDay));

    // Weeks later nothing above reaches the rental, so every model has its whole fleet free.
    const later = { startAt: jst("08-25 10:00"), now: NOW, packageId: threeDays.packageId };
    assert.deepEqual(found(await search(db, later)), sorted(expectedLater));
  });
});

test("holds count until they expire", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db, 1);
    const firstExpiry = NOW + 15 * MINUTE_MS;
    const secondExpiry = NOW + 30 * MINUTE_MS;
    const rental: [string, string] = ["08-10 11:00", "08-10 13:00"];

    // Two holds, a charge in flight whose expiry has no say, and one bike nobody touched.
    const held = await seedFleet(db, shop, 4);
    await book(db, held.plates[0], rental, { status: "ON_HOLD", expires_at: firstExpiry });
    await book(db, held.plates[1], rental, { status: "ON_HOLD", expires_at: secondExpiry });
    await book(db, held.plates[2], rental, { status: "PAYMENT_PENDING", expires_at: firstExpiry });

    // The model's only bike, under a hold.
    const solo = await seedFleet(db, shop, 1);
    await book(db, solo.plates[0], rental, { status: "ON_HOLD", expires_at: firstExpiry });

    // A paid booking keeps its bike whatever its expiry says.
    const paid = await seedFleet(db, shop, 2);
    await book(db, paid.plates[0], rental, { status: "CONFIRMED", expires_at: firstExpiry });

    // None of these holds a bike at any `now` below.
    const dead = await seedFleet(db, shop, 4);
    await book(db, dead.plates[0], rental, { status: "CANCELLED", expires_at: secondExpiry });
    await book(db, dead.plates[1], rental, { status: "EXPIRED", expires_at: secondExpiry });
    await book(db, dead.plates[2], rental, { status: "ON_HOLD", expires_at: null });
    await book(db, dead.plates[3], rental, { status: "ON_HOLD", expires_at: NOW - HOUR_MS });

    // [now, vacancies of held, vacancies of solo]. A hold stops counting at its expiry, not a millisecond later.
    const moments: [number, number, number][] = [
      [NOW, 1, 0],
      [firstExpiry - 1, 1, 0],
      [firstExpiry, 2, 1],
      [secondExpiry - 1, 2, 1],
      [secondExpiry, 3, 1],
      [secondExpiry + HOUR_MS, 3, 1],
    ];
    for (const [now, heldFree, soloFree] of moments) {
      const expected: Found[] = [
        [held.id, heldFree],
        [paid.id, 1],
        [dead.id, 4],
      ];
      if (soloFree > 0) expected.push([solo.id, soloFree]);
      const rows = await search(db, { startAt: PICKUP, packageId: shop.packageId, now });
      assert.deepEqual(found(rows), sorted(expected), `now ${new Date(now).toISOString()}`);
    }
  });
});

test("maintenance and retired bikes never count", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db, 1);
    const rental: [string, string] = ["08-10 11:00", "08-10 13:00"];

    const mixed = await seedFleet(db, shop, ["active", "maintenance", "active", "retired"]);
    const single = await seedFleet(db, shop, ["maintenance", "active", "maintenance", "maintenance"]);
    await seedFleet(db, shop, ["maintenance", "retired"]);
    await seedFleet(db, shop, ["retired"]);

    // The one active bike is booked, and the free maintenance bike does not stand in for it.
    const lastOneBooked = await seedFleet(db, shop, ["active", "maintenance"]);
    await book(db, lastOneBooked.plates[0], rental);

    // A bike can go off the road with bookings on it, and those take nothing from the active bikes.
    const bookedOffRoad = await seedFleet(db, shop, ["active", "active", "maintenance", "retired"]);
    await book(db, bookedOffRoad.plates[2], rental);
    await book(db, bookedOffRoad.plates[3], rental);

    const rows = await search(db, { startAt: PICKUP, packageId: shop.packageId, now: NOW });
    const expected: Found[] = [
      [mixed.id, 2],
      [single.id, 1],
      [bookedOffRoad.id, 2],
    ];
    assert.deepEqual(found(rows), sorted(expected));
  });
});

// `band` is written by hand from the ticket's inclusive bands. A car has none, whatever its engine.
const ENGINES: { id: string; type: VehicleTypeId; cc: number; band: CcBand | null; booked?: boolean }[] = [
  { id: "scooter-49", type: "scooter", cc: 49, band: "upto50" },
  { id: "scooter-50", type: "scooter", cc: 50, band: "upto50" },
  { id: "scooter-51", type: "scooter", cc: 51, band: "51to125" },
  { id: "scooter-125", type: "scooter", cc: 125, band: "51to125" },
  { id: "scooter-126", type: "scooter", cc: 126, band: "126to400" },
  { id: "motorcycle-1", type: "motorcycle", cc: 1, band: "upto50" },
  { id: "motorcycle-50", type: "motorcycle", cc: 50, band: "upto50" },
  { id: "motorcycle-51", type: "motorcycle", cc: 51, band: "51to125" },
  { id: "motorcycle-125", type: "motorcycle", cc: 125, band: "51to125" },
  { id: "motorcycle-126", type: "motorcycle", cc: 126, band: "126to400" },
  { id: "motorcycle-250", type: "motorcycle", cc: 250, band: "126to400", booked: true },
  { id: "motorcycle-400", type: "motorcycle", cc: 400, band: "126to400" },
  { id: "motorcycle-401", type: "motorcycle", cc: 401, band: "over400" },
  { id: "motorcycle-1300", type: "motorcycle", cc: 1300, band: "over400" },
  { id: "car-50", type: "car", cc: 50, band: null },
  { id: "car-125", type: "car", cc: 125, band: null },
  { id: "car-400", type: "car", cc: 400, band: null },
  { id: "car-660", type: "car", cc: 660, band: null },
  { id: "car-1500", type: "car", cc: 1500, band: null },
];

test("type and engine filters combine and bands exclude cars", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db, 1);
    const carClass = (await seedRateClass(db, { grp: "car" })).id;
    await seedPrice(db, { rate_class_id: carClass, package_id: shop.packageId });

    for (const { id, type, cc, booked } of ENGINES) {
      const isCar = type === "car";
      const rateClass = isCar ? { rateClassId: carClass } : shop;
      const model = { id, type_id: type, engine_cc: cc, license_class: isCar ? "car" : "small" };
      const { plates } = await seedFleet(db, rateClass, 1, model);
      if (booked) await book(db, plates[0], ["08-10 11:00", "08-10 13:00"]);
    }

    for (const typeId of [undefined, "scooter", "motorcycle", "car"] as const) {
      for (const ccBand of [undefined, "upto50", "51to125", "126to400", "over400"] as const) {
        const query: Query = { startAt: PICKUP, packageId: shop.packageId, now: NOW };
        if (typeId !== undefined) query.typeId = typeId;
        if (ccBand !== undefined) query.ccBand = ccBand;

        const expected = ENGINES.filter(({ type, band, booked }) => {
          const typeMatches = typeId === undefined || type === typeId;
          const bandMatches = ccBand === undefined || band === ccBand;
          return typeMatches && bandMatches && !booked;
        }).map(({ id }): Found => [id, 1]);

        const rows = await search(db, query);
        assert.deepEqual(found(rows), sorted(expected), `type ${typeId}, band ${ccBand}`);
      }
    }
  });
});

test("models without a price or inactive models are left out", async () => {
  await withDb(async (db) => {
    const longShop = await seedShop(db, 3, {}, 15000);
    const threeDays = longShop.packageId;
    const oneDay = (await seedPackage(db, { days: 1 })).id;
    await seedPrice(db, { rate_class_id: longShop.rateClassId, package_id: oneDay, price_jpy: 6000 });

    // Priced for the one-day package alone, and priced for nothing.
    const shortClass = (await seedRateClass(db)).id;
    await seedPrice(db, { rate_class_id: shortClass, package_id: oneDay, price_jpy: 4000 });
    const unpricedClass = (await seedRateClass(db)).id;

    await seedFleet(db, longShop, 2, { id: "priced-a" });
    await seedFleet(db, longShop, 1, { id: "priced-b" });
    await seedFleet(db, { rateClassId: shortClass }, 1, { id: "one-day-only" });
    await seedFleet(db, { rateClassId: unpricedClass }, 1, { id: "unpriced" });
    await seedFleet(db, longShop, 2, { id: "inactive", active: 0 });
    await seedFleet(db, longShop, 0, { id: "no-bikes" });

    const query = { startAt: PICKUP, now: NOW };
    assert.deepEqual(await search(db, { ...query, packageId: oneDay }), [
      { modelId: "one-day-only", vacancies: 1, priceJpy: 4000, depositJpy: 5000 },
      { modelId: "priced-a", vacancies: 2, priceJpy: 6000, depositJpy: 5000 },
      { modelId: "priced-b", vacancies: 1, priceJpy: 6000, depositJpy: 5000 },
    ]);
    assert.deepEqual(await search(db, { ...query, packageId: threeDays }), [
      { modelId: "priced-a", vacancies: 2, priceJpy: 15000, depositJpy: 5000 },
      { modelId: "priced-b", vacancies: 1, priceJpy: 15000, depositJpy: 5000 },
    ]);
  });
});

test("an unknown package returns nothing", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db, 1);
    const { id } = await seedFleet(db, shop, 2);

    const query = { startAt: PICKUP, now: NOW };
    assert.deepEqual(found(await search(db, { ...query, packageId: shop.packageId })), [[id, 2]]);
    for (const packageId of ["no-such-package", "", "' OR '1'='1"]) {
      assert.deepEqual(await search(db, { ...query, packageId }), [], JSON.stringify(packageId));
      assert.deepEqual(await search(db, { ...query, packageId, typeId: "motorcycle", ccBand: "51to125" }), [], packageId);
    }
  });
});

test("an hours package returns nothing until it has an end rule", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db, 1);
    const { id } = await seedFleet(db, shop, 2);

    const query = { startAt: PICKUP, now: NOW };
    assert.deepEqual(found(await search(db, { ...query, packageId: shop.packageId })), [[id, 2]]);
    for (const hours of [1, 4, 72]) {
      const { id: packageId } = await seedPackage(db, { hours });
      await seedPrice(db, { rate_class_id: shop.rateClassId, package_id: packageId });
      assert.deepEqual(await search(db, { ...query, packageId }), [], `${hours} hours`);
    }
  });
});

test("results are ordered by model sort, then id", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db, 1);
    // Seeded in neither order, with fleets and types that do not follow it either. Sort 10 comes after 3 as a number.
    const models: [string, number, number, VehicleTypeId][] = [
      ["alpha", 3, 2, "motorcycle"],
      ["foxtrot", 2, 1, "car"],
      ["echo", 10, 4, "scooter"],
      ["charlie", 2, 3, "scooter"],
      ["delta", 1, 1, "motorcycle"],
      ["bravo", 2, 2, "motorcycle"],
    ];
    for (const [id, sort, bikes, type_id] of models) await seedFleet(db, shop, bikes, { id, sort, type_id });

    const rows = await search(db, { startAt: PICKUP, packageId: shop.packageId, now: NOW });
    assert.deepEqual(
      rows.map((row) => row.modelId),
      ["delta", "bravo", "charlie", "foxtrot", "alpha", "echo"],
    );

    const scooters = await search(db, { startAt: PICKUP, packageId: shop.packageId, now: NOW, typeId: "scooter" });
    assert.deepEqual(
      scooters.map((row) => row.modelId),
      ["charlie", "echo"],
    );
  });
});

test("priceJpy and depositJpy come from the current catalog", async () => {
  await withDb(async (db) => {
    const bikes = await seedShop(db, 1, {}, 6000);
    const oneDay = bikes.packageId;
    const threeDays = (await seedPackage(db, { days: 3 })).id;
    await seedPrice(db, { rate_class_id: bikes.rateClassId, package_id: threeDays, price_jpy: 15000 });

    const carClass = (await seedRateClass(db, { grp: "car" })).id;
    await seedPrice(db, { rate_class_id: carClass, package_id: oneDay, price_jpy: 9000 });
    await seedPrice(db, { rate_class_id: carClass, package_id: threeDays, price_jpy: 24000 });

    const scooter = await seedFleet(db, bikes, 2, { id: "a-scooter", sort: 1, type_id: "scooter" });
    await seedFleet(db, bikes, 1, { id: "b-motorcycle", sort: 2, type_id: "motorcycle" });
    await seedFleet(db, { rateClassId: carClass }, 1, { id: "c-car", sort: 3, type_id: "car", license_class: "car" });

    // A booking keeps what it was sold for, and that is not the catalog's price.
    await book(db, scooter.plates[0], ["08-10 11:00", "08-10 13:00"], { price_jpy: 1111, deposit_jpy: 2222 });

    const query = { startAt: PICKUP, now: NOW };
    assert.deepEqual(await search(db, { ...query, packageId: oneDay }), [
      { modelId: "a-scooter", vacancies: 1, priceJpy: 6000, depositJpy: 3000 },
      { modelId: "b-motorcycle", vacancies: 1, priceJpy: 6000, depositJpy: 5000 },
      { modelId: "c-car", vacancies: 1, priceJpy: 9000, depositJpy: 20000 },
    ]);
    assert.deepEqual(await search(db, { ...query, packageId: threeDays }), [
      { modelId: "a-scooter", vacancies: 1, priceJpy: 15000, depositJpy: 3000 },
      { modelId: "b-motorcycle", vacancies: 1, priceJpy: 15000, depositJpy: 5000 },
      { modelId: "c-car", vacancies: 1, priceJpy: 24000, depositJpy: 20000 },
    ]);

    // The next publish moves a price and a deposit, and the next search reads them.
    await db
      .prepare("UPDATE prices SET price_jpy = ?1 WHERE rate_class_id = ?2 AND package_id = ?3")
      .bind(7000, bikes.rateClassId, oneDay)
      .run();
    await seedType(db, { id: "scooter", deposit_jpy: 3500 });

    assert.deepEqual(await search(db, { ...query, packageId: oneDay }), [
      { modelId: "a-scooter", vacancies: 1, priceJpy: 7000, depositJpy: 3500 },
      { modelId: "b-motorcycle", vacancies: 1, priceJpy: 7000, depositJpy: 5000 },
      { modelId: "c-car", vacancies: 1, priceJpy: 9000, depositJpy: 20000 },
    ]);
  });
});
