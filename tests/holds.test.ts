// A hold takes the least-used free bike of a model in one conditional INSERT. Expected values come from literals, from
// Date.parse on an explicit +09:00 offset, or from the ledger of the random sequence, never from src/lib/time.ts, the
// blocking rule or the code under test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignFreeVehicleSql, createHold, getBooking } from "../src/lib/booking/holds.ts";
import { isLocale } from "../src/lib/locale.ts";
import type { Locale } from "../src/lib/locale.ts";
import type { Booking, BookingSource, BookingStatus } from "../src/lib/types.ts";
import { createTestDb } from "./helpers/d1.ts";
import {
  seedBooking,
  seedCatalogMeta,
  seedClosedDates,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedType,
  seedVehicle,
} from "./helpers/seed.ts";
import type { PackageRow } from "./helpers/seed.ts";

type HoldInput = Parameters<typeof createHold>[1];
type HoldResult = Awaited<ReturnType<typeof createHold>>;
type Shop = { modelId: string; packageId: string; rateClassId: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const WINDOW_REASONS: string[] = [
  "OUTSIDE_HOURS",
  "OFF_SLOT",
  "CLOSED_PICKUP",
  "RETURN_OUTSIDE_HOURS",
  "CLOSED_RETURN",
  "TOO_SOON",
  "TOO_FAR",
];
const HOLD_REASONS: string[] = ["SOLD_OUT", "UNKNOWN_MODEL", "UNKNOWN_PACKAGE", "NO_PRICE", "CONFLICT", ...WINDOW_REASONS];
const SOLD_OUT = { ok: false, reason: "SOLD_OUT" };
const CONFLICT = { ok: false, reason: "CONFLICT" };

/** The alphabet of randomRef: Crockford base32, which has no I, L, O or U. */
const REF_SHAPE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

function jst(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/** The date `n` days after `date`, from Date.UTC's own calendar. */
function dayAfter(date: string, n: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + n)).toISOString().slice(0, 10);
}

const NOW = jst("2030-06-01", "12:00");
const PICKUP_DAY = "2030-06-10";
const PICKUP = jst(PICKUP_DAY, "09:00");
const PICKUP_DAY_CLOSE = jst(PICKUP_DAY, "18:00");

/** A published shop on a fresh database. The defaults are 09:00 to 18:00, 30-minute slots and a 60-minute turnaround. */
async function withShop(run: (db: D1Database) => Promise<void>, config: Record<string, string | number> = {}): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedConfig(db, config);
    await seedCatalogMeta(db);
    await run(db);
  } finally {
    await dispose();
  }
}

/** A model with no vehicles yet, and one days package priced for its rate class. */
async function seedShop(db: D1Database, days = 1, price_jpy = 8000): Promise<Shop> {
  const model = await seedModel(db);
  const pkg = await seedPackage(db, { days });
  await seedPrice(db, { rate_class_id: model.rate_class_id, package_id: pkg.id, price_jpy });
  return { modelId: model.id, packageId: pkg.id, rateClassId: model.rate_class_id };
}

/** A package's length as seedPackage takes it: days, or hours alone. */
type Length = { days: number } | { hours: number };

/** A model with no vehicles yet, and a package of each length priced for its rate class, in that order. */
async function seedShopOf(
  db: D1Database,
  lengths: Length[],
  price_jpy = 8000,
): Promise<Shop & { packageIds: string[] }> {
  const model = await seedModel(db);
  const packageIds: string[] = [];
  for (const length of lengths) {
    const pkg = await seedPackage(db, length);
    await seedPrice(db, { rate_class_id: model.rate_class_id, package_id: pkg.id, price_jpy });
    packageIds.push(pkg.id);
  }
  return { modelId: model.id, packageId: packageIds[0] as string, rateClassId: model.rate_class_id, packageIds };
}

async function seedFleet(db: D1Database, modelId: string, size: number): Promise<string[]> {
  const plates: string[] = [];
  for (let i = 0; i < size; i += 1) plates.push((await seedVehicle(db, { model_id: modelId })).plate);
  return plates;
}

let lastHold = 0;

/** A valid hold for the first pickup slot of PICKUP_DAY, with a new id. */
function holdFor(shop: Shop, partial: Partial<HoldInput> = {}): HoldInput {
  lastHold += 1;
  return {
    id: `hold-${lastHold}`,
    modelId: shop.modelId,
    packageId: shop.packageId,
    startAt: PICKUP,
    locale: "en",
    ...partial,
  };
}

function booked(result: HoldResult, label = "hold"): Booking {
  assert.ok(result.ok, `${label}: ${JSON.stringify(result)}`);
  return result.booking;
}

async function countBookings(db: D1Database, modelId?: string): Promise<number> {
  const sql = "SELECT COUNT(*) AS n FROM bookings";
  const statement = modelId === undefined ? db.prepare(sql) : db.prepare(`${sql} WHERE model_id = ?1`).bind(modelId);
  return (await statement.first<{ n: number }>())?.n ?? -1;
}

const BOOKING_INSERT = /\binsert\b[^;]*?\binto\s+bookings\b/i;

/**
 * `db`, with `beforeInsert` run once just before the first statement that inserts into bookings executes. That is the
 * moment a rival request or a publish lands after every earlier check, which only a single conditional statement
 * survives. `raced` says the moment came, so a case cannot pass without it.
 */
function raceBeforeInsert(db: D1Database, beforeInsert: () => Promise<unknown>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "bind") return wrap(value.apply(target, args), sql);
          if (raced || !BOOKING_INSERT.test(sql)) return value.apply(target, args);
          raced = true;
          return beforeInsert().then(() => value.apply(target, args));
        };
      },
    });
  const racing = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: racing, raced: () => raced };
}

/**
 * Ways for every hold of a call to overlap every other, with the 60-minute turnaround. A day package ends at closing time
 * on its last day, and an hours package `hours` after its pickup. Call n takes lengths[n % lengths.length].
 */
const OVERLAPS: { label: string; lengths: Length[]; startAt: (call: number) => number }[] = [
  { label: "one pickup time", lengths: [{ days: 1 }], startAt: () => PICKUP },
  { label: "every slot of one day", lengths: [{ days: 1 }], startAt: (call) => PICKUP + (call % 18) * 30 * MINUTE_MS },
  { label: "three-day rentals from three days", lengths: [{ days: 3 }], startAt: (call) => PICKUP + (call % 3) * DAY_MS },
  { label: "4-hour rentals from one pickup", lengths: [{ hours: 4 }], startAt: () => PICKUP },
  // 09:00 to 12:00: each start is under four hours from every other.
  { label: "4-hour rentals from seven slots", lengths: [{ hours: 4 }], startAt: (call) => PICKUP + (call % 7) * 30 * MINUTE_MS },
  { label: "2-hour rentals from four slots", lengths: [{ hours: 2 }], startAt: (call) => PICKUP + (call % 4) * 30 * MINUTE_MS },
  {
    label: "24-hour rentals from every slot of one day",
    lengths: [{ hours: 24 }],
    startAt: (call) => PICKUP + (call % 18) * 30 * MINUTE_MS,
  },
  { label: "day and hours packages from one pickup", lengths: [{ days: 1 }, { hours: 4 }, { hours: 24 }, { days: 3 }], startAt: () => PICKUP },
  // A 24-hour rental from 09:00 is back at 09:00 the next day, an hour inside the buffer of a 09:30 pickup then.
  {
    label: "24 hours, then 4 hours inside its buffer the next morning",
    lengths: [{ hours: 24 }, { hours: 4 }],
    startAt: (call) => (call % 2 === 0 ? PICKUP : PICKUP + DAY_MS + 30 * MINUTE_MS),
  },
];

test("concurrent holds never oversell a model", async () => {
  await withShop(async (db) => {
    for (const fleetSize of [1, 3, 5]) {
      for (const { label, lengths, startAt } of OVERLAPS) {
        const caseLabel = `${fleetSize} bikes, ${label}`;
        const shop = await seedShopOf(db, lengths);
        const fleet = await seedFleet(db, shop.modelId, fleetSize);
        // A free bike of another model, which no hold of this model may take.
        await seedFleet(db, (await seedShopOf(db, lengths)).modelId, 1);

        const calls = Array.from({ length: 20 }, (_, call) =>
          holdFor(shop, { startAt: startAt(call), packageId: shop.packageIds[call % shop.packageIds.length] }),
        );
        const results = await Promise.all(calls.map((input) => createHold(db, input, NOW)));

        const plates: string[] = [];
        results.forEach((result, call) => {
          if (!result.ok) return assert.deepEqual(result, SOLD_OUT, caseLabel);
          plates.push(result.booking.vehiclePlate);
          const length = lengths[call % lengths.length] as Length;
          assert.equal(result.booking.endAt, returnOf(length, startAt(call)), `${caseLabel}: call ${call}'s return`);
        });
        assert.deepEqual(plates.sort(), [...fleet].sort(), caseLabel);
        assert.equal(await countBookings(db, shop.modelId), fleetSize, caseLabel);
      }
    }
  });
});

/** When a rental of `length` from `startAt` returns at the default 18:00 close, worked out here with Date alone. */
function returnOf(length: Length, startAt: number): number {
  if ("hours" in length) return startAt + length.hours * HOUR_MS;
  const pickupDate = new Date(startAt + 9 * HOUR_MS).toISOString().slice(0, 10);
  return jst(dayAfter(pickupDate, length.days - 1), "18:00");
}

// #50: an hours package frees its bike `hours` after the pickup, so one bike can carry a morning and an afternoon rental,
// and the turnaround still keeps them apart. With 4 hours and 60 minutes of turnaround, 09:00 is back at 13:00 and the
// bike is free again from 14:00.
test("concurrent hourly holds share a bike across the day and never overlap", async () => {
  await withShop(async (db) => {
    const morning = jst(PICKUP_DAY, "09:00");
    for (const fleetSize of [1, 2, 3]) {
      for (const [afternoonAt, sharesTheBike] of [
        ["14:00", true],
        ["13:30", false],
      ] as const) {
        const label = `${fleetSize} bikes, 09:00 and ${afternoonAt}`;
        const afternoon = jst(PICKUP_DAY, afternoonAt);
        const shop = await seedShopOf(db, [{ hours: 4 }]);
        const fleet = await seedFleet(db, shop.modelId, fleetSize);

        const calls = Array.from({ length: 20 }, (_, call) => holdFor(shop, { startAt: call % 2 === 0 ? morning : afternoon }));
        const results = await Promise.all(calls.map((input) => createHold(db, input, NOW)));

        const taken = new Map<number, string[]>([
          [morning, []],
          [afternoon, []],
        ]);
        for (const result of results) {
          if (!result.ok) {
            assert.deepEqual(result, SOLD_OUT, label);
            continue;
          }
          const { startAt, endAt, vehiclePlate } = result.booking;
          assert.equal(endAt, startAt + 4 * HOUR_MS, `${label}: the return`);
          taken.get(startAt)?.push(vehiclePlate);
        }
        const [mornings, afternoons] = [taken.get(morning) ?? [], taken.get(afternoon) ?? []];
        if (sharesTheBike) {
          // Every bike twice: once in the morning and once in the afternoon.
          assert.deepEqual([...mornings].sort(), [...fleet].sort(), `${label}: the mornings`);
          assert.deepEqual([...afternoons].sort(), [...fleet].sort(), `${label}: the afternoons`);
        } else {
          // Each bike once, in whichever of the two got there first.
          assert.deepEqual([...mornings, ...afternoons].sort(), [...fleet].sort(), label);
        }
        assert.deepEqual(await conflictingPairs(db, NOW, HOUR_MS), [], label);
      }
    }
  });
});

type Bike = { plate: string; base: number; odometer: number | null };
type Span = { startAt: number; endAt: number };
/** `usage` is the rental's usage days once it is CONFIRMED: 1 for one of 24 hours or less, else the JST dates it touches. */
type Rental = Span & { id: string; plate: string; status: BookingStatus; expiresAt: number; usage: number };

const RANDOM_FLEETS: Bike[][] = [
  [
    { plate: "R-1", base: 4, odometer: 300 },
    { plate: "R-2", base: 4, odometer: null },
    { plate: "R-3", base: 0, odometer: 9000 },
  ],
  [
    { plate: "S-1", base: 2, odometer: 50 },
    { plate: "S-2", base: 2, odometer: 40 },
  ],
];

/** mulberry32: a small seeded generator, so a failure replays exactly. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every pair of bookings on one bike that block at `now` and sit closer than `bufMs`, over the whole table. */
async function conflictingPairs(db: D1Database, now: number, bufMs: number): Promise<{ a: string; b: string }[]> {
  const blocking = (alias: string) =>
    `(${alias}.status IN ('CONFIRMED', 'PAYMENT_PENDING') OR (${alias}.status = 'ON_HOLD' AND ${alias}.expires_at > ?1))`;
  const { results } = await db
    .prepare(
      `SELECT a.id AS a, b.id AS b FROM bookings a JOIN bookings b ON a.vehicle_plate = b.vehicle_plate AND a.id < b.id
       WHERE ${blocking("a")} AND ${blocking("b")} AND a.start_at < b.end_at + ?2 AND b.start_at < a.end_at + ?2`,
    )
    .bind(now, bufMs)
    .all<{ a: string; b: string }>();
  return results;
}

test("no overlapping blocking bookings after a random sequence", async () => {
  for (const seed of [20, 2026, 777]) {
    await withShop(async (db) => {
      const random = seededRandom(seed);
      const pick = (n: number): number => Math.floor(random() * n);
      const bufMs = 60 * MINUTE_MS;

      const rateClass = await seedRateClass(db);
      // Day and hours packages mixed, so the ledger checks each end rule against the other's rentals.
      const lengths: Length[] = [{ days: 1 }, { days: 2 }, { days: 3 }, { hours: 2 }, { hours: 4 }, { hours: 24 }];
      const packages: { id: string; length: Length }[] = [];
      for (const length of lengths) {
        const pkg = await seedPackage(db, length);
        await seedPrice(db, { rate_class_id: rateClass.id, package_id: pkg.id });
        packages.push({ id: pkg.id, length });
      }
      const fleets: { modelId: string; bikes: Bike[] }[] = [];
      for (const bikes of RANDOM_FLEETS) {
        const model = await seedModel(db, { rate_class_id: rateClass.id });
        for (const { plate, base, odometer } of bikes) {
          await seedVehicle(db, { plate, model_id: model.id, base_usage_days: base, odometer_km: odometer });
        }
        fleets.push({ modelId: model.id, bikes });
      }

      // The ledger is the rule worked out again in this test, and it predicts each outcome before the database answers.
      const ledger: Rental[] = [];
      const blocks = (rental: Rental, at: number): boolean =>
        rental.status === "CONFIRMED" ||
        rental.status === "PAYMENT_PENDING" ||
        (rental.status === "ON_HOLD" && rental.expiresAt > at);
      const clashes = (a: Span, b: Span): boolean => b.startAt < a.endAt + bufMs && a.startAt < b.endAt + bufMs;
      const usage = (bike: Bike): number =>
        ledger.reduce((sum, r) => sum + (r.plate === bike.plate && r.status === "CONFIRMED" ? r.usage : 0), bike.base);
      const leastUsed = (bikes: Bike[]): Bike =>
        [...bikes].sort(
          (a, b) =>
            usage(a) - usage(b) ||
            (a.odometer ?? Infinity) - (b.odometer ?? Infinity) ||
            (a.plate < b.plate ? -1 : 1),
        )[0];

      let now = NOW;
      let taken = 0;
      let takenHourly = 0;
      let soldOut = 0;
      let reclaimed = 0;
      let refusedLate = 0;
      for (let step = 0; step < 150; step += 1) {
        const label = `seed ${seed}, step ${step}`;
        now += random() < 0.15 ? 20 * MINUTE_MS : pick(4) * MINUTE_MS;

        const { modelId, bikes } = fleets[pick(fleets.length)];
        const { id: packageId, length } = packages[pick(packages.length)];
        const date = dayAfter(PICKUP_DAY, pick(6));
        const sinceOpen = pick(18) * 30;
        const startAt = jst(date, "09:00") + sinceOpen * MINUTE_MS;
        // A day package returns at 18:00 on its last day, an hours package `hours` later, and that must be by 18:00.
        const hours = "hours" in length ? length.hours : null;
        const endAt = hours === null ? jst(dayAfter(date, (length as { days: number }).days - 1), "18:00") : startAt + hours * HOUR_MS;
        const returnClock = (9 * 60 + sinceOpen + (hours ?? 0) * 60) % (24 * 60);
        const returnsLate = hours !== null && (returnClock > 18 * 60 || returnClock < 9 * 60);
        const span: Span = { startAt, endAt };
        const onBike = (bike: Bike) => ledger.filter((rental) => rental.plate === bike.plate && clashes(rental, span));
        const free = bikes.filter((bike) => !onBike(bike).some((rental) => blocks(rental, now)));

        const id = `random-${seed}-${step}`;
        const result = await createHold(db, { id, modelId, packageId, startAt, locale: "ja" }, now);

        if (returnsLate) {
          assert.deepEqual(result, { ok: false, reason: "RETURN_OUTSIDE_HOURS" }, label);
          refusedLate += 1;
        } else if (free.length === 0) {
          assert.deepEqual(result, SOLD_OUT, label);
          soldOut += 1;
        } else {
          const bike = leastUsed(free);
          const booking = booked(result, label);
          assert.equal(booking.vehiclePlate, bike.plate, label);
          assert.equal(booking.endAt, endAt, `${label}: the return`);
          // The bike is free, so a hold that clashes with this rental has lapsed.
          if (onBike(bike).some((rental) => rental.status === "ON_HOLD")) reclaimed += 1;
          taken += 1;
          if (hours !== null) takenHourly += 1;
          const expiresAt = now + 15 * MINUTE_MS;
          // 24 hours or less is one usage day (owner, 2026-11-15); a longer day package counts the dates it touches.
          const usageDays = endAt - startAt <= DAY_MS ? 1 : (length as { days: number }).days;
          ledger.push({ ...span, id, plate: bike.plate, status: "ON_HOLD", expiresAt, usage: usageDays });
        }

        // Sometimes a guest pays or walks away while a hold is live.
        const live = ledger.filter((rental) => rental.status === "ON_HOLD" && rental.expiresAt > now);
        if (live.length > 0 && random() < 0.4) {
          const target = live[pick(live.length)];
          target.status = (["CONFIRMED", "CONFIRMED", "PAYMENT_PENDING", "CANCELLED"] as const)[pick(4)];
          await db.prepare("UPDATE bookings SET status = ?1 WHERE id = ?2").bind(target.status, target.id).run();
        }

        assert.deepEqual(await conflictingPairs(db, now, bufMs), [], label);
      }

      // The sequence reached every outcome, or the check above proved little.
      const outcomes = `seed ${seed}: ${taken}, ${takenHourly}, ${soldOut}, ${reclaimed}, ${refusedLate}`;
      assert.ok(taken > 0 && takenHourly > 0 && soldOut > 0 && reclaimed > 0 && refusedLate > 0, outcomes);

      // The self-join can fail: two rentals on a spare bike, 30 minutes apart inside the 60-minute buffer.
      const spare = await seedVehicle(db, { model_id: fleets[0].modelId });
      const late = PICKUP + HOUR_MS + 30 * MINUTE_MS;
      const first = await seedBooking(db, { vehicle_plate: spare.plate, start_at: PICKUP, end_at: PICKUP + HOUR_MS });
      const second = await seedBooking(db, { vehicle_plate: spare.plate, start_at: late, end_at: late + HOUR_MS });
      const found = await conflictingPairs(db, now, bufMs);
      assert.deepEqual(found.map(({ a, b }) => [a, b].sort()), [[first.id, second.id].sort()]);
    });
  }
});

/** [plate, base_usage_days, odometer_km], seeded in this order so that insertion order decides nothing. */
const TIE_BREAKS: { label: string; bikes: [string, number, number | null][]; order: string[] }[] = [
  {
    label: "usage, then odometer with unknown last, then plate",
    bikes: [
      ["A-100", 1, null],
      ["B-200", 1, 7000],
      ["C-300", 1, 300],
      ["D-400", 1, 0],
      ["E-500", 1, null],
      ["F-600", 2, 1],
      ["Z-900", 0, 900_000],
    ],
    order: ["Z-900", "D-400", "C-300", "B-200", "A-100", "E-500", "F-600"],
  },
  {
    label: "usage is compared as a number",
    bikes: [
      ["U-1", 100, 1],
      ["U-2", 20, 1],
      ["U-3", 3, 1],
    ],
    order: ["U-3", "U-2", "U-1"],
  },
  {
    label: "the odometer is compared as a number",
    bikes: [
      ["O-1", 5, 1000],
      ["O-2", 5, 999],
      ["O-3", 5, 90],
    ],
    order: ["O-3", "O-2", "O-1"],
  },
  {
    label: "the plate decides between equal odometers",
    bikes: [
      ["M-3", 3, 500],
      ["M-2", 3, 500],
      ["M-1", 3, 500],
    ],
    order: ["M-1", "M-2", "M-3"],
  },
  {
    label: "the plate decides between unknown odometers",
    bikes: [
      ["K-3", 0, null],
      ["K-1", 0, null],
      ["K-2", 0, null],
    ],
    order: ["K-1", "K-2", "K-3"],
  },
];

test("picks the least-used bike with odometer and plate tie-breaks", async () => {
  await withShop(async (db) => {
    for (const { label, bikes, order } of TIE_BREAKS) {
      const shop = await seedShop(db);
      for (const [plate, base_usage_days, odometer_km] of bikes) {
        await seedVehicle(db, { plate, model_id: shop.modelId, base_usage_days, odometer_km });
      }
      for (const plate of order) {
        const booking = booked(await createHold(db, holdFor(shop), NOW), label);
        assert.equal(booking.vehiclePlate, plate, label);
      }
      assert.deepEqual(await createHold(db, holdFor(shop), NOW), SOLD_OUT, label);
    }
  });
});

test("only active, free bikes of the model can be taken", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db);
    const other = await seedShop(db);
    // Every other bike looks better than the free one on usage.
    await seedVehicle(db, { plate: "X-maintenance", model_id: shop.modelId, status: "maintenance" });
    await seedVehicle(db, { plate: "X-retired", model_id: shop.modelId, status: "retired" });
    await seedVehicle(db, { plate: "X-other-model", model_id: other.modelId });
    await seedVehicle(db, { plate: "X-busy", model_id: shop.modelId });
    await seedVehicle(db, { plate: "X-free", model_id: shop.modelId, base_usage_days: 50 });
    await seedBooking(db, { vehicle_plate: "X-busy", start_at: PICKUP, end_at: PICKUP_DAY_CLOSE });

    assert.equal(booked(await createHold(db, holdFor(shop), NOW)).vehiclePlate, "X-free");
    assert.deepEqual(await createHold(db, holdFor(shop), NOW), SOLD_OUT);

    // The busy bike is free on another day, and it is still the less used of the two.
    const nextDay = holdFor(shop, { startAt: PICKUP + DAY_MS });
    assert.equal(booked(await createHold(db, nextDay, NOW)).vehiclePlate, "X-busy");

    // A model with a price and no bikes has none free.
    assert.deepEqual(await createHold(db, holdFor(await seedShop(db)), NOW), SOLD_OUT);

    // A model staff withdrew takes no holds, whichever reason says so.
    const model = await seedModel(db, { active: 0 });
    const pkg = await seedPackage(db);
    await seedPrice(db, { rate_class_id: model.rate_class_id, package_id: pkg.id });
    await seedVehicle(db, { model_id: model.id });
    const withdrawn = holdFor({ modelId: model.id, packageId: pkg.id, rateClassId: model.rate_class_id });
    const result = await createHold(db, withdrawn, NOW);
    assert.ok(!result.ok && ["UNKNOWN_MODEL", "SOLD_OUT"].includes(result.reason), JSON.stringify(result));
    assert.equal(await countBookings(db, model.id), 0);
  });
});

/**
 * One seeded rental that stays clear of PICKUP_DAY, which days and status it has being the point. `days` is how many
 * JST dates it touches, from `start` on `date` to `end` on the last of them, by default opening to closing. Without a
 * `package_id` it has a catalog package of its own, `days` long unless `pkg` says otherwise. It counts as `days` usage
 * days when it lasts more than 24 hours, and as one when it lasts 24 hours or less (#50).
 */
type Usage = {
  date: string;
  days: number;
  status?: BookingStatus;
  start?: string;
  end?: string;
  source?: BookingSource;
  package_id?: string | null;
  pkg?: Partial<PackageRow>;
};

const FUTURE = "2030-08-01";
const PAST = "2030-03-01";
/** A staff block has no package, so only its dates can say how many days it is. */
const BLOCK = { source: "block", package_id: null } as const;

/**
 * Bike A starts at 2 usage days and bike B at 5, so A wins until its bookings add more than 3 days, and on a tie the
 * plate gives it to A. Neither bike has an odometer reading unless the case names one.
 */
const USAGE_CASES: {
  label: string;
  a?: Usage[];
  b?: Usage[];
  odometer?: { A?: number; B?: number };
  expected: "A" | "B";
}[] = [
  { label: "no bookings", expected: "A" },
  { label: "a future 7-day rental", a: [{ date: FUTURE, days: 7 }], expected: "B" },
  { label: "a past 7-day rental", a: [{ date: PAST, days: 7 }], expected: "B" },
  { label: "a future 2-day rental stays under", a: [{ date: FUTURE, days: 2 }], expected: "A" },
  { label: "a future 3-day rental ties", a: [{ date: FUTURE, days: 3 }], expected: "A" },
  { label: "a future 4-day rental passes", a: [{ date: FUTURE, days: 4 }], expected: "B" },
  {
    label: "past and future days add up",
    a: [
      { date: PAST, days: 2 },
      { date: FUTURE, days: 2 },
    ],
    expected: "B",
  },
  {
    label: "two one-day rentals are two days",
    a: [
      { date: "2030-08-01", days: 1 },
      { date: "2030-08-03", days: 1 },
    ],
    expected: "A",
  },
  {
    label: "four one-day rentals are four days",
    a: [
      { date: "2030-08-01", days: 1 },
      { date: "2030-08-03", days: 1 },
      { date: "2030-08-05", days: 1 },
      { date: "2030-08-07", days: 1 },
    ],
    expected: "B",
  },
  { label: "days on both bikes", a: [{ date: FUTURE, days: 4 }], b: [{ date: PAST, days: 2 }], expected: "A" },
  { label: "bike B stays ahead by a day", a: [{ date: FUTURE, days: 7 }], b: [{ date: FUTURE, days: 5 }], expected: "A" },
  { label: "bike B falls behind by a day", a: [{ date: FUTURE, days: 7 }], b: [{ date: FUTURE, days: 3 }], expected: "B" },
  { label: "a live hold is not usage", a: [{ date: FUTURE, days: 7, status: "ON_HOLD" }], expected: "A" },
  { label: "a charge in flight is not usage", a: [{ date: FUTURE, days: 7, status: "PAYMENT_PENDING" }], expected: "A" },
  { label: "a cancelled rental is not usage", a: [{ date: FUTURE, days: 7, status: "CANCELLED" }], expected: "A" },
  { label: "an expired hold is not usage", a: [{ date: FUTURE, days: 7, status: "EXPIRED" }], expected: "A" },

  // Every CONFIRMED booking counts, whatever its source and whether or not its package is still in the catalog.
  { label: "a package that left the catalog", a: [{ date: FUTURE, days: 7, package_id: "package-gone" }], expected: "B" },
  { label: "a staff block", a: [{ date: FUTURE, days: 7, ...BLOCK }], expected: "B" },
  { label: "a 3-day block ties", a: [{ date: FUTURE, days: 3, ...BLOCK }], expected: "A" },
  { label: "a 4-day block passes", a: [{ date: FUTURE, days: 4, ...BLOCK }], expected: "B" },
  {
    label: "a catalog rental, a removed package and a block add up",
    a: [
      { date: PAST, days: 1 },
      { date: "2030-08-01", days: 1, package_id: "package-gone" },
      { date: "2030-08-03", days: 2, ...BLOCK },
    ],
    expected: "B",
  },
  { label: "a cancelled block is not usage", a: [{ date: FUTURE, days: 7, status: "CANCELLED", ...BLOCK }], expected: "A" },

  // The booking's own dates decide, even when its package is there and has since changed.
  { label: "a package shortened since", a: [{ date: FUTURE, days: 7, pkg: { days: 1 } }], expected: "B" },
  { label: "a package lengthened since", a: [{ date: FUTURE, days: 2, pkg: { days: 9 } }], expected: "A" },

  // The dates are JST dates, and 09:00 JST is midnight UTC. Only a block forces the dates to be worked out.
  {
    label: "over midnight UTC is one JST date",
    a: [
      { date: "2030-08-01", days: 1, start: "08:30", end: "09:30", ...BLOCK },
      { date: "2030-08-03", days: 1, start: "08:30", end: "09:30", ...BLOCK },
    ],
    expected: "A",
  },
  // #50 (owner, 2026-11-15): a booking of 24 hours or less is one usage day, whatever dates it touches, so each of these
  // 12-hour blocks over midnight JST is one day and not two.
  {
    label: "a 12-hour block over midnight JST is one day",
    a: [
      { date: "2030-08-01", days: 2, start: "20:00", end: "08:00", ...BLOCK },
      { date: "2030-08-04", days: 2, start: "20:00", end: "08:00", ...BLOCK },
    ],
    expected: "A",
  },
  // A longer one still counts JST dates: 36 hours from 20:00 touch three of them and two UTC dates, and with a one-day
  // rental beside it only the JST count passes bike B.
  {
    label: "36 hours over two midnights JST are three days",
    a: [
      { date: "2030-08-01", days: 3, start: "20:00", end: "08:00", ...BLOCK },
      { date: "2030-08-05", days: 1 },
    ],
    expected: "B",
  },

  // Hours packages (#50). Three of anything that counts one day each ties bike B, and four passes it.
  {
    label: "three 24-hour rentals over two dates each are three days",
    a: [
      { date: "2030-08-01", days: 2, end: "09:00", pkg: { hours: 24 } },
      { date: "2030-08-04", days: 2, end: "09:00", pkg: { hours: 24 } },
      { date: "2030-08-07", days: 2, start: "17:30", end: "17:30", pkg: { hours: 24 } },
    ],
    expected: "A",
  },
  {
    label: "four 24-hour rentals are four days",
    a: [
      { date: "2030-08-01", days: 2, end: "09:00", pkg: { hours: 24 } },
      { date: "2030-08-04", days: 2, end: "09:00", pkg: { hours: 24 } },
      { date: "2030-08-07", days: 2, start: "12:00", end: "12:00", pkg: { hours: 24 } },
      { date: "2030-08-10", days: 2, start: "17:30", end: "17:30", pkg: { hours: 24 } },
    ],
    expected: "B",
  },
  {
    label: "three 4-hour rentals are three days",
    a: [
      { date: "2030-08-01", days: 1, end: "13:00", pkg: { hours: 4 } },
      { date: "2030-08-03", days: 1, start: "14:00", end: "18:00", pkg: { hours: 4 } },
      { date: "2030-08-05", days: 1, start: "10:30", end: "14:30", pkg: { hours: 4 } },
    ],
    expected: "A",
  },
  {
    label: "four 2-hour rentals are four days",
    a: [
      { date: "2030-08-01", days: 1, end: "11:00", pkg: { hours: 2 } },
      { date: "2030-08-03", days: 1, start: "16:00", end: "18:00", pkg: { hours: 2 } },
      { date: "2030-08-05", days: 1, start: "12:00", end: "14:00", pkg: { hours: 2 } },
      { date: "2030-08-07", days: 1, end: "11:00", pkg: { hours: 2 } },
    ],
    expected: "B",
  },
  // A minute over 24 hours is two dates and two days, so three of them pass bike B where three of 24 hours tie it.
  {
    label: "three blocks of 24 hours and a minute are six days",
    a: [
      { date: "2030-08-01", days: 2, end: "09:01", ...BLOCK },
      { date: "2030-08-04", days: 2, end: "09:01", ...BLOCK },
      { date: "2030-08-07", days: 2, end: "09:01", ...BLOCK },
    ],
    expected: "B",
  },
  {
    label: "three blocks of 24 hours are three days",
    a: [
      { date: "2030-08-01", days: 2, end: "09:00", ...BLOCK },
      { date: "2030-08-04", days: 2, end: "09:00", ...BLOCK },
      { date: "2030-08-07", days: 2, end: "09:00", ...BLOCK },
    ],
    expected: "A",
  },
  // A 2-day package still counts the two dates it touches, so two of them pass bike B.
  {
    label: "two 2-day rentals are four days",
    a: [
      { date: "2030-08-01", days: 2 },
      { date: "2030-08-05", days: 2, start: "17:30" },
    ],
    expected: "B",
  },

  // Dates touched, not 24-hour periods: each of these lasts exactly 72 hours.
  { label: "72 hours from 09:00 touch four dates", a: [{ date: FUTURE, days: 4, end: "09:00", ...BLOCK }], expected: "B" },
  {
    label: "72 hours from midnight JST touch four dates",
    a: [{ date: FUTURE, days: 4, start: "00:00", end: "00:00", ...BLOCK }],
    expected: "B",
  },

  // The tie-breaks read the same total: leave out the removed package or the block and these are no longer ties.
  {
    label: "a removed package on bike B ties, and the plate decides",
    a: [{ date: FUTURE, days: 4 }],
    b: [{ date: PAST, days: 1, package_id: "package-gone" }],
    expected: "A",
  },
  {
    label: "a block on bike B ties, and the plate decides",
    a: [{ date: FUTURE, days: 4 }],
    b: [{ date: PAST, days: 1, ...BLOCK }],
    expected: "A",
  },
  {
    label: "a removed package ties, and the odometer decides",
    a: [{ date: FUTURE, days: 3, package_id: "package-gone" }],
    odometer: { A: 500, B: 100 },
    expected: "B",
  },
  {
    label: "a block ties, and the known odometer decides",
    a: [{ date: FUTURE, days: 3, ...BLOCK }],
    odometer: { B: 100 },
    expected: "B",
  },
];

test("future confirmed bookings count as usage", async () => {
  await withShop(async (db) => {
    const seedUsage = async (plate: string, modelId: string, rentals: Usage[]): Promise<void> => {
      for (const { date, days, status = "CONFIRMED", start = "09:00", end = "18:00", source = "web", package_id, pkg } of rentals) {
        // A package of its own: usage reads the booking's days, not the days of the package being held.
        const packageId = package_id === undefined ? (await seedPackage(db, pkg ?? { days })).id : package_id;
        const block =
          source === "block"
            ? { external_ref: `${plate}-${date}`, external_channel: "klook", price_jpy: null, deposit_jpy: null }
            : {};
        await seedBooking(db, {
          vehicle_plate: plate,
          model_id: modelId,
          package_id: packageId,
          source,
          ...block,
          status,
          expires_at: status === "ON_HOLD" ? NOW + HOUR_MS : null,
          start_at: jst(date, start),
          end_at: jst(dayAfter(date, days - 1), end),
        });
      }
    };

    for (const [index, { label, a = [], b = [], odometer = {}, expected }] of USAGE_CASES.entries()) {
      const shop = await seedShop(db);
      const plates = { A: `A-${index}`, B: `B-${index}` };
      const { A: odometerA = null, B: odometerB = null } = odometer;
      await seedVehicle(db, { plate: plates.A, model_id: shop.modelId, base_usage_days: 2, odometer_km: odometerA });
      await seedVehicle(db, { plate: plates.B, model_id: shop.modelId, base_usage_days: 5, odometer_km: odometerB });
      await seedUsage(plates.A, shop.modelId, a);
      await seedUsage(plates.B, shop.modelId, b);

      const booking = booked(await createHold(db, holdFor(shop), NOW), label);
      assert.equal(booking.vehiclePlate, plates[expected], label);
    }
  });
});

test("expired holds free the bike", async () => {
  await withShop(async (db) => {
    for (const hold_minutes of [10, 15, 45]) {
      await seedConfig(db, { hold_minutes });
      const shop = await seedShop(db);
      const [plate] = await seedFleet(db, shop.modelId, 1);
      const expiresAt = NOW + hold_minutes * MINUTE_MS;

      assert.equal(booked(await createHold(db, holdFor(shop), NOW)).vehiclePlate, plate);
      assert.deepEqual(await createHold(db, holdFor(shop), expiresAt - 1), SOLD_OUT, `${hold_minutes} minutes, just before`);

      // Nothing ran between these calls but the clock. The new hold takes the bike and blocks in its turn.
      const label = `${hold_minutes} minutes, at the expiry`;
      assert.equal(booked(await createHold(db, holdFor(shop), expiresAt), label).vehiclePlate, plate, label);
      assert.deepEqual(await createHold(db, holdFor(shop), expiresAt + 1), SOLD_OUT, `${hold_minutes} minutes, after`);
      assert.equal(await countBookings(db, shop.modelId), 2);
    }

    // Only an ON_HOLD booking lapses: a charge in flight outlives the expiry it came with.
    const table: [BookingStatus, number | null, boolean][] = [
      ["ON_HOLD", NOW + 1, true],
      ["ON_HOLD", NOW, false],
      ["ON_HOLD", NOW - 1, false],
      ["PAYMENT_PENDING", NOW - HOUR_MS, true],
      ["CONFIRMED", null, true],
      ["CONFIRMED", NOW - HOUR_MS, true],
      ["EXPIRED", NOW + HOUR_MS, false],
      ["CANCELLED", NOW + HOUR_MS, false],
      ["CANCELLED", null, false],
    ];
    await seedConfig(db);
    for (const [status, expires_at, blocks] of table) {
      const label = `${status} expiring at ${expires_at}`;
      const shop = await seedShop(db);
      const [plate] = await seedFleet(db, shop.modelId, 1);
      await seedBooking(db, { vehicle_plate: plate, status, expires_at, start_at: PICKUP, end_at: PICKUP_DAY_CLOSE });

      const result = await createHold(db, holdFor(shop), NOW);
      if (blocks) assert.deepEqual(result, SOLD_OUT, label);
      else assert.equal(booked(result, label).vehiclePlate, plate, label);
    }
  });
});

/** A staff block on the only bike, and a one-day hold around it. A one-day hold runs from its pickup to 18:00. */
const BLOCK_CASES: { turnaround: number; block: [string, string]; pickup: string; free: boolean }[] = [
  // A block that ends before the pickup.
  { turnaround: 60, block: ["07:00", "10:00"], pickup: "10:30", free: false },
  { turnaround: 60, block: ["07:00", "10:00"], pickup: "11:00", free: true },
  { turnaround: 30, block: ["07:00", "10:00"], pickup: "10:00", free: false },
  { turnaround: 30, block: ["07:00", "10:00"], pickup: "10:30", free: true },
  { turnaround: 90, block: ["07:00", "10:00"], pickup: "11:00", free: false },
  { turnaround: 90, block: ["07:00", "10:00"], pickup: "11:30", free: true },
  { turnaround: 0, block: ["07:00", "10:00"], pickup: "09:30", free: false },
  { turnaround: 0, block: ["07:00", "10:00"], pickup: "10:00", free: true },
  // A block that starts after the return.
  { turnaround: 60, block: ["18:30", "20:00"], pickup: "09:00", free: false },
  { turnaround: 60, block: ["19:00", "20:00"], pickup: "09:00", free: true },
  { turnaround: 30, block: ["18:29", "20:00"], pickup: "09:00", free: false },
  { turnaround: 30, block: ["18:30", "20:00"], pickup: "09:00", free: true },
  { turnaround: 0, block: ["17:59", "20:00"], pickup: "09:00", free: false },
  { turnaround: 0, block: ["18:00", "20:00"], pickup: "09:00", free: true },
];

/** Two one-day holds on one bike: the first returns at 18:00, 15 hours before the shop opens the next day. */
const NEXT_DAY_CASES: { turnaround: number; pickup: string; free: boolean }[] = [
  { turnaround: 60, pickup: "09:00", free: true },
  { turnaround: 900, pickup: "09:00", free: true },
  { turnaround: 930, pickup: "09:00", free: false },
  { turnaround: 930, pickup: "09:30", free: true },
];

test("the turnaround buffer separates rentals", async () => {
  await withShop(async (db) => {
    for (const [index, { turnaround, block, pickup, free }] of BLOCK_CASES.entries()) {
      const label = `block ${block.join(" to ")}, pickup ${pickup}, ${turnaround} minutes`;
      await seedConfig(db, { turnaround_minutes: turnaround });
      const shop = await seedShop(db);
      const [plate] = await seedFleet(db, shop.modelId, 1);
      await seedBooking(db, {
        vehicle_plate: plate,
        source: "block",
        external_ref: `block-${index}`,
        external_channel: "klook",
        start_at: jst(PICKUP_DAY, block[0]),
        end_at: jst(PICKUP_DAY, block[1]),
        price_jpy: null,
        deposit_jpy: null,
      });

      const result = await createHold(db, holdFor(shop, { startAt: jst(PICKUP_DAY, pickup) }), NOW);
      if (free) assert.equal(booked(result, label).vehiclePlate, plate, label);
      else assert.deepEqual(result, SOLD_OUT, label);
    }

    for (const { turnaround, pickup, free } of NEXT_DAY_CASES) {
      const label = `next day at ${pickup}, ${turnaround} minutes`;
      await seedConfig(db, { turnaround_minutes: turnaround });
      const shop = await seedShop(db);
      const [plate] = await seedFleet(db, shop.modelId, 1);
      booked(await createHold(db, holdFor(shop), NOW), label);

      const startAt = jst(dayAfter(PICKUP_DAY, 1), pickup);
      const result = await createHold(db, holdFor(shop, { startAt }), NOW);
      if (free) assert.equal(booked(result, label).vehiclePlate, plate, label);
      else assert.deepEqual(result, SOLD_OUT, label);
    }
  });
});

/**
 * A staff block on the only bike and an hours hold beside it, which runs from its pickup to `hours` later. The block is
 * on PICKUP_DAY plus `day`.
 */
const HOURLY_BLOCK_CASES: { turnaround: number; hours: number; pickup: string; day?: number; block: [string, string]; free: boolean }[] = [
  // A block after the return: 09:00 for 4 hours is back at 13:00, where a one-day hold would run on to 18:00.
  { turnaround: 60, hours: 4, pickup: "09:00", block: ["13:59", "18:00"], free: false },
  { turnaround: 60, hours: 4, pickup: "09:00", block: ["14:00", "18:00"], free: true },
  { turnaround: 30, hours: 4, pickup: "09:00", block: ["13:29", "18:00"], free: false },
  { turnaround: 30, hours: 4, pickup: "09:00", block: ["13:30", "18:00"], free: true },
  { turnaround: 0, hours: 4, pickup: "09:00", block: ["12:59", "18:00"], free: false },
  { turnaround: 0, hours: 4, pickup: "09:00", block: ["13:00", "18:00"], free: true },
  { turnaround: 60, hours: 2, pickup: "09:30", block: ["12:29", "14:00"], free: false },
  { turnaround: 60, hours: 2, pickup: "09:30", block: ["12:30", "14:00"], free: true },
  { turnaround: 90, hours: 8, pickup: "09:00", block: ["18:29", "20:00"], free: false },
  { turnaround: 90, hours: 8, pickup: "09:00", block: ["18:30", "20:00"], free: true },
  // A block before the pickup.
  { turnaround: 60, hours: 4, pickup: "10:30", block: ["07:00", "10:00"], free: false },
  { turnaround: 60, hours: 4, pickup: "11:00", block: ["07:00", "10:00"], free: true },
  { turnaround: 0, hours: 2, pickup: "10:00", block: ["07:00", "10:00"], free: true },
  // 24 hours from 09:00 is back at 09:00 the next day, so it covers that evening and the next morning's first hour.
  { turnaround: 60, hours: 24, pickup: "09:00", block: ["19:00", "20:00"], free: false },
  { turnaround: 60, hours: 24, pickup: "09:00", day: 1, block: ["09:59", "12:00"], free: false },
  { turnaround: 60, hours: 24, pickup: "09:00", day: 1, block: ["10:00", "12:00"], free: true },
  { turnaround: 30, hours: 24, pickup: "17:30", day: 1, block: ["17:59", "19:00"], free: false },
  { turnaround: 30, hours: 24, pickup: "17:30", day: 1, block: ["18:00", "19:00"], free: true },
];

/** Two holds on the only bike, the second after or before the first. `day` puts the second on PICKUP_DAY plus that. */
const HOURLY_PAIRS: { turnaround: number; first: [Length, string]; second: [Length, string, number?]; free: boolean }[] = [
  // A 4-hour morning from 09:00 is back at 13:00.
  { turnaround: 60, first: [{ hours: 4 }, "09:00"], second: [{ hours: 4 }, "13:30"], free: false },
  { turnaround: 60, first: [{ hours: 4 }, "09:00"], second: [{ hours: 4 }, "14:00"], free: true },
  { turnaround: 30, first: [{ hours: 4 }, "09:00"], second: [{ hours: 4 }, "13:00"], free: false },
  { turnaround: 30, first: [{ hours: 4 }, "09:00"], second: [{ hours: 4 }, "13:30"], free: true },
  { turnaround: 60, first: [{ hours: 4 }, "09:00"], second: [{ days: 1 }, "13:30"], free: false },
  { turnaround: 60, first: [{ hours: 4 }, "09:00"], second: [{ days: 1 }, "14:00"], free: true },
  // The afternoon held first, then a morning that has to be back an hour before it.
  { turnaround: 60, first: [{ hours: 4 }, "14:00"], second: [{ hours: 4 }, "09:00"], free: true },
  { turnaround: 60, first: [{ hours: 4 }, "14:00"], second: [{ hours: 4 }, "09:30"], free: false },
  { turnaround: 60, first: [{ hours: 4 }, "14:00"], second: [{ hours: 2 }, "11:00"], free: true },
  { turnaround: 60, first: [{ hours: 4 }, "14:00"], second: [{ hours: 2 }, "11:30"], free: false },
  { turnaround: 0, first: [{ days: 1 }, "14:00"], second: [{ hours: 4 }, "10:00"], free: true },
  { turnaround: 0, first: [{ days: 1 }, "14:00"], second: [{ hours: 4 }, "10:30"], free: false },
  // 24 hours from 09:00 holds the bike until 09:00 the next day.
  { turnaround: 60, first: [{ hours: 24 }, "09:00"], second: [{ hours: 4 }, "09:30", 1], free: false },
  { turnaround: 60, first: [{ hours: 24 }, "09:00"], second: [{ hours: 4 }, "10:00", 1], free: true },
  { turnaround: 60, first: [{ hours: 24 }, "09:00"], second: [{ days: 1 }, "10:00", 1], free: true },
  { turnaround: 60, first: [{ hours: 24 }, "17:30"], second: [{ hours: 4 }, "09:00", 1], free: false },
  { turnaround: 60, first: [{ days: 1 }, "09:00"], second: [{ hours: 24 }, "09:00", 1], free: true },
];

test("the turnaround buffer separates an hourly rental from the next", async () => {
  await withShop(async (db) => {
    for (const [index, { turnaround, hours, pickup, day = 0, block, free }] of HOURLY_BLOCK_CASES.entries()) {
      const label = `${hours} hours from ${pickup}, block ${block.join(" to ")} on day ${day}, ${turnaround} minutes`;
      await seedConfig(db, { turnaround_minutes: turnaround });
      const shop = await seedShopOf(db, [{ hours }]);
      const [plate] = await seedFleet(db, shop.modelId, 1);
      const blockDay = dayAfter(PICKUP_DAY, day);
      await seedBooking(db, {
        vehicle_plate: plate,
        source: "block",
        external_ref: `hourly-block-${index}`,
        external_channel: "klook",
        start_at: jst(blockDay, block[0]),
        end_at: jst(blockDay, block[1]),
        price_jpy: null,
        deposit_jpy: null,
      });

      const result = await createHold(db, holdFor(shop, { startAt: jst(PICKUP_DAY, pickup) }), NOW);
      if (free) assert.equal(booked(result, label).vehiclePlate, plate, label);
      else assert.deepEqual(result, SOLD_OUT, label);
    }

    for (const { turnaround, first, second, free } of HOURLY_PAIRS) {
      const [secondLength, secondPickup, secondDay = 0] = second;
      const label = `${JSON.stringify(first)}, then ${JSON.stringify(second)}, ${turnaround} minutes`;
      await seedConfig(db, { turnaround_minutes: turnaround });
      const shop = await seedShopOf(db, [first[0], secondLength]);
      const [plate] = await seedFleet(db, shop.modelId, 1);
      const held = holdFor(shop, { packageId: shop.packageIds[0], startAt: jst(PICKUP_DAY, first[1]) });
      assert.equal(booked(await createHold(db, held, NOW), `${label}: the first`).vehiclePlate, plate, label);

      const startAt = jst(dayAfter(PICKUP_DAY, secondDay), secondPickup);
      const result = await createHold(db, holdFor(shop, { packageId: shop.packageIds[1], startAt }), NOW);
      if (free) assert.equal(booked(result, label).vehiclePlate, plate, label);
      else assert.deepEqual(result, SOLD_OUT, label);
    }
  });
});

/**
 * Each input that a stored field depends on, varied together. `end` is closing time on a day package's last day, and
 * `hours` after the pickup for an hours package.
 */
const STORED_CASES: {
  hold_minutes: number;
  shop_open?: string;
  shop_close: string;
  now: number;
  length: Length;
  start: [string, string];
  end: [string, string];
  locale: Locale;
}[] = [
  {
    hold_minutes: 10,
    shop_close: "18:00",
    now: jst("2030-06-01", "12:00"),
    length: { days: 1 },
    start: ["2030-06-10", "09:00"],
    end: ["2030-06-10", "18:00"],
    locale: "en",
  },
  {
    hold_minutes: 15,
    shop_close: "18:00",
    now: jst("2030-06-02", "03:07") + 7_250,
    length: { days: 3 },
    start: ["2030-06-10", "13:30"],
    end: ["2030-06-12", "18:00"],
    locale: "ja",
  },
  {
    hold_minutes: 45,
    shop_close: "18:00",
    now: jst("2030-06-20", "23:59"),
    length: { days: 7 },
    start: ["2030-06-28", "17:30"],
    end: ["2030-07-04", "18:00"],
    locale: "zh-cn",
  },
  {
    hold_minutes: 5,
    shop_close: "17:00",
    now: jst("2030-07-01", "08:00"),
    length: { days: 2 },
    start: ["2030-07-30", "16:30"],
    end: ["2030-07-31", "17:00"],
    locale: "ko",
  },
  // The config reader accepts H:mm, and a hold reads both times of it.
  {
    hold_minutes: 20,
    shop_open: "7:00",
    shop_close: "9:30",
    now: jst("2030-06-03", "10:00"),
    length: { days: 2 },
    start: ["2030-06-10", "08:30"],
    end: ["2030-06-11", "09:30"],
    locale: "en",
  },
  // Hours packages (#50): an hours package with a price is bookable, and it ends `hours` after its pickup.
  {
    hold_minutes: 15,
    shop_close: "18:00",
    now: jst("2030-06-01", "12:00"),
    length: { hours: 4 },
    start: ["2030-06-10", "13:30"],
    end: ["2030-06-10", "17:30"],
    locale: "ja",
  },
  {
    hold_minutes: 10,
    shop_close: "17:00",
    now: jst("2030-06-02", "09:00"),
    length: { hours: 8 },
    start: ["2030-06-10", "09:00"],
    end: ["2030-06-10", "17:00"],
    locale: "en",
  },
  {
    hold_minutes: 30,
    shop_close: "18:00",
    now: jst("2030-06-15", "18:00"),
    length: { hours: 24 },
    start: ["2030-06-30", "16:30"],
    end: ["2030-07-01", "16:30"],
    locale: "ko",
  },
  // 07:30 JST is 22:30 UTC the day before, and two hours later is exactly the 9:30 close.
  {
    hold_minutes: 20,
    shop_open: "7:00",
    shop_close: "9:30",
    now: jst("2030-07-01", "10:00"),
    length: { hours: 2 },
    start: ["2030-07-31", "07:30"],
    end: ["2030-07-31", "09:30"],
    locale: "zh-cn",
  },
];

test("a hold stores the reservation fields", async () => {
  await withShop(async (db) => {
    for (const { hold_minutes, shop_open = "09:00", shop_close, now, length, start, end, locale } of STORED_CASES) {
      await seedConfig(db, { hold_minutes, shop_open, shop_close });
      const shop = await seedShopOf(db, [length], 11_000);
      const [plate] = await seedFleet(db, shop.modelId, 1);
      const input = holdFor(shop, { startAt: jst(...start), locale });

      const booking = booked(await createHold(db, input, now), JSON.stringify(length));
      const expected: Booking = {
        id: input.id,
        ref: booking.ref,
        status: "ON_HOLD",
        source: "web",
        modelId: shop.modelId,
        packageId: shop.packageId,
        vehiclePlate: plate,
        startAt: jst(...start),
        endAt: jst(...end),
        expiresAt: now + hold_minutes * MINUTE_MS,
        priceJpy: 11_000,
        depositJpy: 5000,
        catalogVersion: 1,
        locale,
        guestFamilyName: null,
        guestGivenName: null,
        guestEmail: null,
        guestPhone: null,
        externalRef: null,
        externalChannel: null,
        contentHash: null,
        paymentId: null,
        paymentAttempt: 0,
        paidJpy: 0,
        cancelReason: null,
        createdAt: now,
        updatedAt: now,
        confirmedAt: null,
        cancelledAt: null,
      };
      assert.deepEqual(booking, expected);
      assert.deepEqual(await getBooking(db, input.id), expected);

      // The row itself, because getBooking could mend what the statement stored.
      const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(input.id).first<Record<string, unknown>>();
      assert.equal(row?.status, "ON_HOLD");
      assert.equal(row?.vehicle_plate, plate);
      assert.equal(row?.end_at, jst(...end));
      assert.equal(row?.expires_at, now + hold_minutes * MINUTE_MS);
      assert.equal(row?.price_jpy, 11_000);
    }
  });
});

test("every hold gets its own 8-character ref", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db);
    await seedFleet(db, shop.modelId, 1);
    const refs: string[] = [];
    for (let day = 0; day < 24; day += 1) {
      const startAt = jst(dayAfter(PICKUP_DAY, day), "09:00");
      const { ref } = booked(await createHold(db, holdFor(shop, { startAt }), NOW));
      assert.match(ref, REF_SHAPE);
      refs.push(ref);
    }
    assert.equal(new Set(refs).size, refs.length);
  });
});

test("a ref collision is retried once", async (t) => {
  await withShop(async (db) => {
    // randomRef turns eight zero bytes into this ref, so a booking that already has it is a collision on demand.
    const takenRef = "00000000";
    const owner = await seedBooking(db, { ref: takenRef, start_at: PICKUP + 30 * DAY_MS, end_at: PICKUP + 31 * DAY_MS });

    const realValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let collisions = 0;
    let draws = 0;
    const colliding: typeof globalThis.crypto.getRandomValues = (buf) => {
      if (buf.byteLength !== 8) return realValues(buf);
      draws += 1;
      if (draws > collisions) return realValues(buf);
      new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).fill(0);
      return buf;
    };
    t.mock.method(globalThis.crypto, "getRandomValues", colliding);

    const shop = await seedShop(db);
    await seedFleet(db, shop.modelId, 2);

    collisions = 1;
    const retried = booked(await createHold(db, holdFor(shop), NOW), "one collision");
    assert.notEqual(retried.ref, takenRef);
    assert.match(retried.ref, REF_SHAPE);
    assert.equal(draws, 2);
    assert.equal(await countBookings(db, shop.modelId), 1);

    // The second attempt is the last, and how it fails is left open.
    collisions = Infinity;
    draws = 0;
    const input = holdFor(shop);
    const outcome: unknown = await createHold(db, input, NOW).catch((error: unknown) => error);
    assert.notEqual((outcome as { ok?: unknown }).ok, true);
    assert.equal(draws, 2);
    assert.equal(await getBooking(db, input.id), null);
    assert.equal((await getBooking(db, owner.id))?.ref, takenRef);
  });
});

test("price and deposit come from the catalog in the same statement", async () => {
  await withShop(async (db) => {
    await seedType(db, { id: "scooter", deposit_jpy: 3000 });
    await seedType(db, { id: "motorcycle", deposit_jpy: 10_000 });
    await seedType(db, { id: "car", deposit_jpy: 30_000 });
    const cheap = await seedRateClass(db);
    const dear = await seedRateClass(db);
    const oneDay = await seedPackage(db, { days: 1 });
    const threeDays = await seedPackage(db, { days: 3 });
    const fees: [string, string, number][] = [
      [cheap.id, oneDay.id, 4000],
      [cheap.id, threeDays.id, 11_000],
      [dear.id, oneDay.id, 9000],
      [dear.id, threeDays.id, 25_000],
    ];
    for (const [rate_class_id, package_id, price_jpy] of fees) await seedPrice(db, { rate_class_id, package_id, price_jpy });

    // [type, rate class, package, version, price, deposit]: the price follows the class and the package, and the
    // deposit follows the type.
    const table: [string, string, string, number, number, number][] = [
      ["scooter", cheap.id, oneDay.id, 1, 4000, 3000],
      ["scooter", cheap.id, threeDays.id, 2, 11_000, 3000],
      ["motorcycle", cheap.id, threeDays.id, 7, 11_000, 10_000],
      ["motorcycle", dear.id, oneDay.id, 7, 9000, 10_000],
      ["car", dear.id, threeDays.id, 42, 25_000, 30_000],
      ["scooter", dear.id, oneDay.id, 43, 9000, 3000],
    ];
    for (const [type_id, rate_class_id, packageId, version, priceJpy, depositJpy] of table) {
      await seedCatalogMeta(db, { version });
      const model = await seedModel(db, { type_id, rate_class_id });
      await seedFleet(db, model.id, 1);
      const shop = { modelId: model.id, packageId, rateClassId: rate_class_id };
      const booking = booked(await createHold(db, holdFor(shop), NOW));
      assert.deepEqual(
        { priceJpy: booking.priceJpy, depositJpy: booking.depositJpy, catalogVersion: booking.catalogVersion },
        { priceJpy, depositJpy, catalogVersion: version },
        `${type_id}, version ${version}`,
      );
    }

    // A publish lands after every check and just before the insert: the hold has the new catalog, all three values of
    // it, and a value read earlier and bound as a parameter would show the old one.
    const shop = await seedShop(db, 1, 8000);
    await seedType(db, { id: "motorcycle", deposit_jpy: 5000 });
    await seedFleet(db, shop.modelId, 2);
    await seedCatalogMeta(db, { version: 50 });
    const publish = raceBeforeInsert(db, async () => {
      await db.prepare("UPDATE prices SET price_jpy = 8800 WHERE package_id = ?1").bind(shop.packageId).run();
      await seedType(db, { id: "motorcycle", deposit_jpy: 5500 });
      await seedCatalogMeta(db, { version: 51 });
    });
    const held = booked(await createHold(publish.db, holdFor(shop), NOW));
    assert.ok(publish.raced(), "no statement inserted into bookings");
    assert.deepEqual([held.priceJpy, held.depositJpy, held.catalogVersion], [8800, 5500, 51]);

    // A hold keeps what it took: the next publish reaches the next hold and leaves this one alone.
    await db.prepare("UPDATE prices SET price_jpy = 9900 WHERE package_id = ?1").bind(shop.packageId).run();
    await seedCatalogMeta(db, { version: 52 });
    const next = booked(await createHold(db, holdFor(shop), NOW));
    assert.deepEqual([next.priceJpy, next.catalogVersion], [9900, 52]);
    assert.deepEqual(await getBooking(db, held.id), held);

    // A publish can move the model itself, to another rate class and type. Both classes price this package and both
    // types have a deposit, so a class or type read earlier and bound as a join key still finds a row, the old one.
    await seedCatalogMeta(db, { version: 60 });
    const moving = await seedModel(db, { type_id: "scooter", rate_class_id: cheap.id });
    await seedFleet(db, moving.id, 1);
    const move = raceBeforeInsert(db, async () => {
      await db
        .prepare("UPDATE models SET rate_class_id = ?1, type_id = ?2 WHERE id = ?3")
        .bind(dear.id, "car", moving.id)
        .run();
      await seedCatalogMeta(db, { version: 61 });
    });
    const moved = booked(
      await createHold(move.db, holdFor({ modelId: moving.id, packageId: oneDay.id, rateClassId: cheap.id }), NOW),
    );
    assert.ok(move.raced(), "no statement inserted into bookings");
    assert.deepEqual([moved.priceJpy, moved.depositJpy, moved.catalogVersion], [9000, 30_000, 61]);
  });
});

test("the insert sees a rival that lands after validation", async () => {
  await withShop(async (db) => {
    const run = (sql: string, ...values: string[]) =>
      db
        .prepare(sql)
        .bind(...values)
        .run();

    // Each of these leaves the one bike unavailable. Validation has passed by then, so a pick made by an earlier
    // statement stores a double-booking or a hold on a retired bike.
    const landings: { label: string; reasons: string[]; land: (shop: Shop, plate: string) => Promise<unknown> }[] = [
      {
        label: "a rival booking",
        reasons: ["SOLD_OUT"],
        land: (_shop, plate) => seedBooking(db, { vehicle_plate: plate, start_at: PICKUP, end_at: PICKUP_DAY_CLOSE }),
      },
      {
        label: "the bike retired",
        reasons: ["SOLD_OUT"],
        land: (_shop, plate) => run("UPDATE vehicles SET status = 'retired' WHERE plate = ?1", plate),
      },
      {
        label: "the model withdrawn",
        reasons: ["SOLD_OUT", "UNKNOWN_MODEL"],
        land: (shop) => run("UPDATE models SET active = 0 WHERE id = ?1", shop.modelId),
      },
      {
        label: "the price removed",
        reasons: ["SOLD_OUT", "NO_PRICE"],
        land: (shop) => run("DELETE FROM prices WHERE package_id = ?1", shop.packageId),
      },
    ];
    for (const { label, reasons, land } of landings) {
      const shop = await seedShop(db);
      const [plate] = await seedFleet(db, shop.modelId, 1);
      const input = holdFor(shop);
      const racing = raceBeforeInsert(db, () => land(shop, plate));

      const result = await createHold(racing.db, input, NOW);
      assert.ok(racing.raced(), `${label}: no statement inserted into bookings`);
      assert.ok(!result.ok && reasons.includes(result.reason), `${label}: ${JSON.stringify(result)}`);
      assert.equal(await getBooking(db, input.id), null, label);
    }

    // A rival on the least-used bike leaves the next one.
    {
      const shop = await seedShop(db);
      await seedVehicle(db, { plate: "L-1", model_id: shop.modelId, base_usage_days: 0 });
      await seedVehicle(db, { plate: "L-2", model_id: shop.modelId, base_usage_days: 9 });
      const racing = raceBeforeInsert(db, () =>
        seedBooking(db, { vehicle_plate: "L-1", start_at: PICKUP, end_at: PICKUP_DAY_CLOSE }),
      );
      assert.equal(booked(await createHold(racing.db, holdFor(shop), NOW)).vehiclePlate, "L-2");
      assert.ok(racing.raced(), "no statement inserted into bookings");
    }

    // A rival with the same id. With one bike the statement finds none free, and with two it breaks the primary key:
    // neither is SOLD_OUT or an exception, because the id settles it.
    for (const fleetSize of [1, 2]) {
      const shop = await seedShop(db);
      await seedFleet(db, shop.modelId, fleetSize);

      const same = holdFor(shop);
      const sameRival = raceBeforeInsert(db, () => createHold(db, same, NOW));
      const replayed = await createHold(sameRival.db, same, NOW);
      assert.ok(sameRival.raced(), "no statement inserted into bookings");
      assert.deepEqual(replayed, { ok: true, booking: await getBooking(db, same.id) }, `${fleetSize} bikes, same inputs`);

      const changed = holdFor(shop, { startAt: PICKUP + 2 * DAY_MS });
      const rivalInput = { ...changed, startAt: changed.startAt + 30 * MINUTE_MS };
      const changedRival = raceBeforeInsert(db, () => createHold(db, rivalInput, NOW));
      const refused = await createHold(changedRival.db, changed, NOW);
      assert.ok(changedRival.raced(), "no statement inserted into bookings");
      assert.deepEqual(refused, CONFLICT, `${fleetSize} bikes, changed inputs`);
      assert.equal((await getBooking(db, changed.id))?.startAt, rivalInput.startAt);
    }
  });
});

test("same id is idempotent and changed inputs conflict", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db);
    await seedFleet(db, shop.modelId, 2);
    const input = holdFor(shop);
    const first = booked(await createHold(db, input, NOW));

    // A replay is answered from the booking, not from the window or the clock.
    const replays: [string, number][] = [
      ["at once", NOW],
      ["while the hold is live", NOW + 5 * MINUTE_MS],
      ["after the hold expired", NOW + 2 * HOUR_MS],
      ["once the pickup is inside the lead time", PICKUP - HOUR_MS],
      ["after the pickup", PICKUP + DAY_MS],
    ];
    for (const [label, now] of replays) {
      assert.deepEqual(await createHold(db, input, now), { ok: true, booking: first }, label);
    }
    assert.equal(await countBookings(db, shop.modelId), 1);

    // Another id is another booking, on the other bike.
    const other = booked(await createHold(db, holdFor(shop), NOW));
    assert.notEqual(other.ref, first.ref);
    assert.notEqual(other.vehiclePlate, first.vehiclePlate);

    // Each input on its own, changed to one that would be valid on a new id.
    const otherModel = await seedModel(db);
    await seedPrice(db, { rate_class_id: otherModel.rate_class_id, package_id: shop.packageId });
    await seedFleet(db, otherModel.id, 1);
    const otherPackage = await seedPackage(db, { days: 2 });
    await seedPrice(db, { rate_class_id: shop.rateClassId, package_id: otherPackage.id });
    const changes: [string, Partial<HoldInput>][] = [
      ["the model", { modelId: otherModel.id }],
      ["the package", { packageId: otherPackage.id }],
      ["the pickup slot", { startAt: PICKUP + 30 * MINUTE_MS }],
      ["the pickup day", { startAt: PICKUP + DAY_MS }],
      ["the locale", { locale: "ja" }],
      // Not valid on a new id, and the id is what answers here: it is a change to this booking before it is a bad input.
      ["a model that does not exist", { modelId: "no-such-model" }],
      ["a package that does not exist", { packageId: "no-such-package" }],
    ];
    for (const [label, change] of changes) {
      assert.deepEqual(await createHold(db, { ...input, ...change }, NOW), CONFLICT, label);
      assert.deepEqual(await getBooking(db, input.id), first, label);
    }

    // A replay after payment gets the booking as it now stands.
    await db.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ?1").bind(input.id).run();
    const later = await createHold(db, input, NOW + 3 * HOUR_MS);
    assert.deepEqual(later, { ok: true, booking: { ...first, status: "CONFIRMED" } });

    // A replay is not answered from the catalog either: a booking outlives what it booked going off sale.
    const run = (sql: string, id: string) => db.prepare(sql).bind(id).run();
    const removePrices = (gone: Shop) => run("DELETE FROM prices WHERE package_id = ?1", gone.packageId);
    const removals: [string, (gone: Shop) => Promise<unknown>][] = [
      ["the price removed", removePrices],
      [
        "the package removed",
        async (gone) => {
          await removePrices(gone);
          await run("DELETE FROM packages WHERE id = ?1", gone.packageId);
        },
      ],
      ["the model withdrawn", (gone) => run("UPDATE models SET active = 0 WHERE id = ?1", gone.modelId)],
    ];
    for (const [label, remove] of removals) {
      const gone = await seedShop(db);
      await seedFleet(db, gone.modelId, 1);
      const sold = holdFor(gone);
      const booking = booked(await createHold(db, sold, NOW), label);
      await remove(gone);
      assert.deepEqual(await createHold(db, sold, NOW), { ok: true, booking }, label);
    }
  });
});

test("concurrent calls with one id make one booking", async () => {
  await withShop(async (db) => {
    // One bike is the hard case: the losers find no bike free, and they still get the booking, not SOLD_OUT.
    for (const fleetSize of [1, 3]) {
      const shop = await seedShop(db);
      await seedFleet(db, shop.modelId, fleetSize);
      const input = holdFor(shop);

      const results = await Promise.all(Array.from({ length: 10 }, () => createHold(db, input, NOW)));
      const stored = await getBooking(db, input.id);
      assert.ok(stored, `${fleetSize} bikes: no booking stored`);
      for (const result of results) assert.deepEqual(result, { ok: true, booking: stored }, `${fleetSize} bikes`);
      assert.equal(await countBookings(db, shop.modelId), 1, `${fleetSize} bikes`);
    }

    // Two different requests under one id, on two bikes so that each could win. Whichever is stored, its own calls get
    // the booking and the others hear CONFLICT.
    const shop = await seedShop(db);
    await seedFleet(db, shop.modelId, 2);
    const morning = holdFor(shop);
    const afternoon = { ...morning, startAt: PICKUP + 6 * HOUR_MS };
    const calls = Array.from({ length: 10 }, (_, call) => (call % 2 === 0 ? morning : afternoon));

    const results = await Promise.all(calls.map((input) => createHold(db, input, NOW)));
    const stored = await getBooking(db, morning.id);
    assert.ok(stored, "no booking stored");
    results.forEach((result, call) => {
      const expected = calls[call].startAt === stored.startAt ? { ok: true, booking: stored } : CONFLICT;
      assert.deepEqual(result, expected, `call ${call}`);
    });
    assert.equal(await countBookings(db, shop.modelId), 1);
  });
});

test("invalid inputs return reasons", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db);
    await seedFleet(db, shop.modelId, 2);
    await seedClosedDates(db, ["2030-06-20", "2030-06-27", "2030-12-03"]);

    const threeDays = await seedPackage(db, { days: 3 });
    await seedPrice(db, { rate_class_id: shop.rateClassId, package_id: threeDays.id });
    // The default horizon of 180 days from NOW ends on 2030-11-28. A rental may return past it, so 2030-12-03 is read.
    const sevenDays = await seedPackage(db, { days: 7 });
    await seedPrice(db, { rate_class_id: shop.rateClassId, package_id: sevenDays.id });
    // Hours packages (#50): back by closing time, and a 24-hour return is on the next day's date.
    const fourHours = await seedPackage(db, { hours: 4 });
    await seedPrice(db, { rate_class_id: shop.rateClassId, package_id: fourHours.id });
    const dayAndNight = await seedPackage(db, { hours: 24 });
    await seedPrice(db, { rate_class_id: shop.rateClassId, package_id: dayAndNight.id });
    // Priced for another rate class only.
    const elsewhere = await seedPackage(db, { days: 2 });
    await seedPrice(db, { rate_class_id: (await seedRateClass(db)).id, package_id: elsewhere.id });
    const hoursElsewhere = await seedPackage(db, { hours: 2 });
    await seedPrice(db, { rate_class_id: (await seedRateClass(db)).id, package_id: hoursElsewhere.id });

    const table: [string, Partial<HoldInput>, string][] = [
      ["unknown model", { modelId: "no-such-model" }, "UNKNOWN_MODEL"],
      ["unknown package", { packageId: "no-such-package" }, "UNKNOWN_PACKAGE"],
      ["no price for this rate class", { packageId: elsewhere.id }, "NO_PRICE"],
      ["no hours price for this rate class", { packageId: hoursElsewhere.id }, "NO_PRICE"],
      ["4 hours returning a slot past closing", { packageId: fourHours.id, startAt: jst(PICKUP_DAY, "14:30") }, "RETURN_OUTSIDE_HOURS"],
      ["4 hours from the last slot", { packageId: fourHours.id, startAt: jst(PICKUP_DAY, "17:30") }, "RETURN_OUTSIDE_HOURS"],
      ["4 hours from closing time", { packageId: fourHours.id, startAt: jst(PICKUP_DAY, "18:00") }, "OUTSIDE_HOURS"],
      ["4 hours off the grid", { packageId: fourHours.id, startAt: jst(PICKUP_DAY, "14:15") }, "OFF_SLOT"],
      ["4 hours late on a closed day", { packageId: fourHours.id, startAt: jst("2030-06-20", "14:30") }, "CLOSED_PICKUP"],
      ["24 hours into a closed day", { packageId: dayAndNight.id, startAt: jst("2030-06-26", "17:30") }, "CLOSED_RETURN"],
      ["24 hours inside the lead time", { packageId: dayAndNight.id, startAt: jst("2030-06-02", "09:00") }, "TOO_SOON"],
      ["before opening", { startAt: jst(PICKUP_DAY, "08:30") }, "OUTSIDE_HOURS"],
      ["at closing", { startAt: jst(PICKUP_DAY, "18:00") }, "OUTSIDE_HOURS"],
      ["between slots", { startAt: jst(PICKUP_DAY, "09:15") }, "OFF_SLOT"],
      ["closed on pickup", { startAt: jst("2030-06-20", "09:00") }, "CLOSED_PICKUP"],
      ["closed on return", { packageId: threeDays.id, startAt: jst("2030-06-25", "09:00") }, "CLOSED_RETURN"],
      ["closed on a return past the horizon", { packageId: sevenDays.id, startAt: jst("2030-11-27", "09:00") }, "CLOSED_RETURN"],
      ["inside the lead time", { startAt: jst("2030-06-02", "09:00") }, "TOO_SOON"],
      ["in the past", { startAt: jst("2030-05-01", "09:00") }, "TOO_SOON"],
      ["past the horizon", { startAt: jst("2030-11-29", "09:00") }, "TOO_FAR"],
    ];
    for (const [label, partial, reason] of table) {
      assert.deepEqual(await createHold(db, holdFor(shop, partial), NOW), { ok: false, reason }, label);
    }

    // A request body can hold anything, so an input that is no object at all gets a reason as well.
    for (const input of [null, undefined, 42, "x", []] as unknown[]) {
      const result = await createHold(db, input as HoldInput, NOW);
      assert.ok(!result.ok && HOLD_REASONS.includes(result.reason), `${JSON.stringify(input)}: ${JSON.stringify(result)}`);
    }
    assert.equal(await countBookings(db), 0);

    // The same requests with the fault taken out go through, and a closed date mid-rental refuses nothing.
    booked(await createHold(db, holdFor(shop), NOW), "the first slot");
    const overClosedDay = { packageId: threeDays.id, startAt: jst("2030-06-19", "09:00") };
    booked(await createHold(db, holdFor(shop, overClosedDay), NOW), "a closed date mid-rental");
    const openReturn = { packageId: sevenDays.id, startAt: jst("2030-11-26", "09:00") };
    booked(await createHold(db, holdFor(shop, openReturn), NOW), "an open return past the horizon");
    // 4 hours back at closing, and on the day before a closed date, which only a 24-hour rental returns on.
    const atClosing = { packageId: fourHours.id, startAt: jst(PICKUP_DAY, "14:00") };
    booked(await createHold(db, holdFor(shop, atClosing), NOW), "4 hours returning at closing");
    const beforeClosed = { packageId: fourHours.id, startAt: jst("2030-06-26", "13:30") };
    booked(await createHold(db, holdFor(shop, beforeClosed), NOW), "4 hours the day before a closed date");
    const afterClosed = { packageId: dayAndNight.id, startAt: jst("2030-06-21", "17:30") };
    booked(await createHold(db, holdFor(shop, afterClosed), NOW), "24 hours from the day after a closed date");
  });
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

test("hostile inputs get a typed reason, never an exception", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db);
    await seedFleet(db, shop.modelId, 6);
    // The longest package the schema allows: its return is past year 9999 for any pickup late in that year.
    const longest = await seedPackage(db, { days: 60 });
    await seedPrice(db, { rate_class_id: shop.rateClassId, package_id: longest.id });
    // And hours packages, whose return clock is read too: the shortest that refuses a late slot, and the longest.
    const fourHours = await seedPackage(db, { hours: 4 });
    await seedPrice(db, { rate_class_id: shop.rateClassId, package_id: fourHours.id });
    const longestHours = await seedPackage(db, { hours: 72 });
    await seedPrice(db, { rate_class_id: shop.rateClassId, package_id: longestHours.id });
    const attempt = (partial: Record<string, unknown>) => createHold(db, holdFor(shop, partial as Partial<HoldInput>), NOW);

    const notIds: unknown[] = [undefined, null, 42, NaN, true, {}, [], ""];
    const injection = "x'; DROP TABLE bookings; --";

    for (const modelId of [...notIds, injection, "x".repeat(5000)]) {
      const expected = { ok: false, reason: "UNKNOWN_MODEL" };
      assert.deepEqual(await attempt({ modelId }), expected, `modelId ${String(modelId)}`);
    }
    for (const packageId of [...notIds, injection, "x".repeat(5000)]) {
      const expected = { ok: false, reason: "UNKNOWN_PACKAGE" };
      assert.deepEqual(await attempt({ packageId }), expected, `packageId ${String(packageId)}`);
    }

    // The declared reasons include none meant for a bad booking id, so any of them will do. It must not be stored.
    for (const id of notIds) {
      const result = await attempt({ id });
      assert.ok(!result.ok && HOLD_REASONS.includes(result.reason), `id ${String(id)}: ${JSON.stringify(result)}`);
    }

    // A wall clock to the minute reads each of these as the 09:00 slot.
    for (const startAt of [PICKUP + 0.5, PICKUP + 1, PICKUP + 30_000]) {
      assert.deepEqual(await attempt({ startAt }), { ok: false, reason: "OFF_SLOT" }, `startAt ${startAt}`);
    }
    const notInstants: unknown[] = [
      NaN,
      Infinity,
      -Infinity,
      1e20,
      -1e20,
      ...CALENDAR_EDGES,
      null,
      undefined,
      true,
      {},
      "",
      "2030-06-10T09:00:00+09:00",
      String(PICKUP),
    ];
    for (const packageId of [shop.packageId, longest.id, fourHours.id, longestHours.id]) {
      for (const startAt of notInstants) {
        const result = await attempt({ startAt, packageId });
        const label = `startAt ${String(startAt)}, package ${packageId}: ${JSON.stringify(result)}`;
        assert.ok(!result.ok && WINDOW_REASONS.includes(result.reason), label);
      }
    }

    // readShopConfig accepts a slot of 0, and no start is on that grid.
    await seedConfig(db, { slot_minutes: 0 });
    const noGrid = await attempt({});
    assert.ok(!noGrid.ok && WINDOW_REASONS.includes(noGrid.reason), JSON.stringify(noGrid));
    await seedConfig(db);

    assert.equal(await countBookings(db), 0);

    // A bad locale may be refused or cleared, and it is never stored as it came.
    for (const locale of [undefined, null, 42, {}, "xx"]) {
      const result = await attempt({ locale });
      const label = `locale ${String(locale)}: ${JSON.stringify(result)}`;
      if (result.ok) assert.ok(result.booking.locale === null || isLocale(result.booking.locale), label);
      else assert.ok(HOLD_REASONS.includes(result.reason), label);
    }

    // The same starts on an id already stored: the check that compares them with the booking must not throw either.
    const stored = holdFor(shop, { startAt: PICKUP + DAY_MS });
    booked(await createHold(db, stored, NOW));
    for (const startAt of notInstants) {
      const result = await createHold(db, { ...stored, startAt: startAt as number }, NOW);
      const label = `stored id, startAt ${String(startAt)}: ${JSON.stringify(result)}`;
      assert.ok(!result.ok && HOLD_REASONS.includes(result.reason), label);
    }
    assert.equal((await getBooking(db, stored.id))?.startAt, stored.startAt);
  });
});

test("getBooking returns the stored booking or null", async () => {
  await withShop(async (db) => {
    const vehicle = await seedVehicle(db, { plate: "G-1" });
    const stored = await seedBooking(db, {
      id: "booking-full",
      ref: "7XK2M9QD",
      status: "CANCELLED",
      source: "web",
      vehicle_plate: "G-1",
      package_id: "package-gone",
      start_at: PICKUP,
      end_at: PICKUP_DAY_CLOSE,
      expires_at: NOW + HOUR_MS,
      price_jpy: 12_345,
      deposit_jpy: 6789,
      catalog_version: 11,
      locale: "ko",
      guest_family_name: "Higa",
      guest_given_name: "Rina",
      guest_email: "rina@example.com",
      guest_phone: "+81-90-1111-2222",
      content_hash: "abc123",
      payment_id: "pay-1",
      payment_attempt: 3,
      paid_jpy: 6789,
      cancel_reason: "guest",
      created_at: NOW,
      updated_at: NOW + 1,
      confirmed_at: NOW + 2,
      cancelled_at: NOW + 3,
    });
    const expected: Booking = {
      id: "booking-full",
      ref: "7XK2M9QD",
      status: "CANCELLED",
      source: "web",
      modelId: vehicle.model_id,
      packageId: "package-gone",
      vehiclePlate: "G-1",
      startAt: PICKUP,
      endAt: PICKUP_DAY_CLOSE,
      expiresAt: NOW + HOUR_MS,
      priceJpy: 12_345,
      depositJpy: 6789,
      catalogVersion: 11,
      locale: "ko",
      guestFamilyName: "Higa",
      guestGivenName: "Rina",
      guestEmail: "rina@example.com",
      guestPhone: "+81-90-1111-2222",
      externalRef: null,
      externalChannel: null,
      contentHash: "abc123",
      paymentId: "pay-1",
      paymentAttempt: 3,
      paidJpy: 6789,
      cancelReason: "guest",
      createdAt: NOW,
      updatedAt: NOW + 1,
      confirmedAt: NOW + 2,
      cancelledAt: NOW + 3,
    };
    assert.deepEqual(await getBooking(db, stored.id), expected);

    // A block has no package, price, deposit, locale or guest.
    await seedBooking(db, {
      id: "booking-block",
      ref: "BLOCK001",
      source: "block",
      vehicle_plate: "G-1",
      start_at: PICKUP + 7 * DAY_MS,
      end_at: PICKUP + 8 * DAY_MS,
      price_jpy: null,
      deposit_jpy: null,
      catalog_version: null,
      locale: null,
      guest_family_name: null,
      guest_given_name: null,
      guest_email: null,
      guest_phone: null,
      external_ref: "klook-1",
      external_channel: "klook",
    });
    const block = await getBooking(db, "booking-block");
    assert.equal(block?.source, "block");
    assert.equal(block?.packageId, null);
    assert.equal(block?.priceJpy, null);
    assert.equal(block?.locale, null);
    assert.equal(block?.externalRef, "klook-1");

    for (const id of ["no-such-booking", "", "x'; DROP TABLE bookings; --", undefined, null, 42, {}]) {
      assert.equal(await getBooking(db, id as string), null, `id ${String(id)}`);
    }
  });
});

test("assignFreeVehicleSql is exported for the block and override tasks", () => {
  assert.ok(["string", "function"].includes(typeof assignFreeVehicleSql), typeof assignFreeVehicleSql);
});

// #131: a price row may carry an advance price, which a guest pays who books before the pickup's JST date. The hold decides
// between the two and locks the result in bookings.price_jpy. The shop opens at 08:00 here, so a pickup can fall on the UTC
// date of a hold made the JST day before, and the lead time is 0, so a hold can be made on the pickup date at all. Which
// side of the rule each case falls on is written by hand.
const ADVANCE_SHOP = { shop_open: "08:00", shop_close: "18:00", min_lead_hours: 0 };

/** A JST wall clock with seconds or milliseconds where a case needs them, from Date.parse alone. */
function wall(date: string, clock: string): number {
  const instant = Date.parse(`${date}T${clock}+09:00`);
  assert.ok(Number.isFinite(instant), `bad fixture time ${date} ${clock}`);
  return instant;
}

type AdvanceRow = {
  label: string;
  modelId: string;
  packageId: string;
  priceJpy: number;
  advancePriceJpy: number | null;
  depositJpy: number;
};

// [days, price_jpy, advance_price_jpy] per type. The e-bike's are the flyer's; a bike row has one too, because the shop sets
// it per row, not per type. Two rows have none.
const ADVANCE_FEES: { type: string; grp: string; deposit: number; rows: [number, number, number | null][] }[] = [
  {
    type: "ebike",
    grp: "ebike",
    deposit: 1500,
    rows: [
      [1, 4500, 4000],
      [2, 8000, 7000],
      [3, 10_000, 9000],
      [5, 15_000, null],
    ],
  },
  {
    type: "motorcycle",
    grp: "bike",
    deposit: 10_000,
    rows: [
      [1, 5200, null],
      [3, 13_800, 12_900],
      [4, 17_000, 16_400],
    ],
  },
];

/** Both types, a model of each with bikes enough for every overlapping hold, and every row of ADVANCE_FEES. */
async function seedAdvanceShop(db: D1Database): Promise<AdvanceRow[]> {
  const rows: AdvanceRow[] = [];
  for (const { type, grp, deposit, rows: fees } of ADVANCE_FEES) {
    await seedType(db, { id: type, deposit_jpy: deposit });
    const rateClass = await seedRateClass(db, { grp });
    const engine = type === "ebike" ? { engine_cc: null, license_class: "none" } : {};
    const model = await seedModel(db, { type_id: type, rate_class_id: rateClass.id, ...engine });
    await seedFleet(db, model.id, 40);
    for (const [days, price_jpy, advance_price_jpy] of fees) {
      const pkg = await seedPackage(db, { days });
      await seedPrice(db, { rate_class_id: rateClass.id, package_id: pkg.id, price_jpy, advance_price_jpy });
      rows.push({
        label: `${type}, ${days} days`,
        modelId: model.id,
        packageId: pkg.id,
        priceJpy: price_jpy,
        advancePriceJpy: advance_price_jpy,
        depositJpy: deposit,
      });
    }
  }
  return rows;
}

/** Holds `row` for `startAt` at `now`, and checks the price and deposit on the booking and on the stored row. */
async function holdPrice(db: D1Database, row: AdvanceRow, startAt: number, now: number, label: string): Promise<Booking> {
  const input = holdFor({ modelId: row.modelId, packageId: row.packageId, rateClassId: "" }, { startAt });
  const booking = booked(await createHold(db, input, now), label);
  assert.equal(booking.depositJpy, row.depositJpy, `${label}: the deposit follows the type, not the price`);
  const stored = await db
    .prepare("SELECT price_jpy, deposit_jpy FROM bookings WHERE id = ?1")
    .bind(input.id)
    .first<{ price_jpy: number; deposit_jpy: number }>();
  assert.deepEqual(stored, { price_jpy: booking.priceJpy, deposit_jpy: row.depositJpy }, `${label}: the stored row`);
  return booking;
}

/** [label, the hold's now, the pickup]: each now is on a JST date before the pickup's. */
const BEFORE_THE_PICKUP_DATE: [string, number, number][] = [
  ["nine days ahead", wall("2030-06-01", "12:00"), wall("2030-06-10", "09:00")],
  ["at 00:00:00 JST the day before", wall("2030-06-09", "00:00:00"), wall("2030-06-10", "17:30")],
  // 10:00 JST on the 9th is 01:00 UTC on the 9th, and 08:00 JST on the 10th is 23:00 UTC on the 9th: one UTC date.
  ["the day before in JST, the same date in UTC", wall("2030-06-09", "10:00"), wall("2030-06-10", "08:00")],
  ["at 23:59:59 JST the day before", wall("2030-06-09", "23:59:59"), wall("2030-06-10", "09:00")],
  ["in the last millisecond of the day before", wall("2030-06-12", "23:59:59.999"), wall("2030-06-13", "08:30")],
];

/** [label, the hold's now, the pickup, the last second before that JST date]: each now is on the pickup's JST date. */
const ON_THE_PICKUP_DATE: [string, number, number, number][] = [
  ["at 00:00:00 JST", wall("2030-06-10", "00:00:00"), wall("2030-06-10", "09:00"), wall("2030-06-09", "23:59:59")],
  [
    "a millisecond past midnight",
    wall("2030-06-10", "00:00:00.001"),
    wall("2030-06-10", "17:30"),
    wall("2030-06-09", "23:59:59"),
  ],
  // 08:30 JST on the 10th is 23:30 UTC on the 9th, and the 09:00 pickup is 00:00 UTC on the 10th: a UTC date says ahead.
  [
    "at 08:30 JST, the day before in UTC",
    wall("2030-06-10", "08:30"),
    wall("2030-06-10", "09:00"),
    wall("2030-06-09", "23:59:59"),
  ],
  [
    "at 08:59 JST, for an afternoon pickup",
    wall("2030-06-10", "08:59"),
    wall("2030-06-10", "12:30"),
    wall("2030-06-09", "23:59:59"),
  ],
  ["at noon, for an evening pickup", wall("2030-06-13", "12:00"), wall("2030-06-13", "17:00"), wall("2030-06-12", "23:59:59")],
];

test("a hold locks the advance price", async () => {
  await withShop(async (db) => {
    const rows = await seedAdvanceShop(db);

    // Every row, at every moment before the pickup's date: the advance price where the row has one, else the regular one.
    const lastEvening = new Map<AdvanceRow, Booking>();
    for (const [when, now, startAt] of BEFORE_THE_PICKUP_DATE) {
      for (const row of rows) {
        const label = `${row.label}, ${when}`;
        const booking = await holdPrice(db, row, startAt, now, label);
        assert.equal(booking.priceJpy, row.advancePriceJpy ?? row.priceJpy, label);
        if (when === "at 23:59:59 JST the day before") lastEvening.set(row, booking);
      }
    }

    // Locked: a publish after midnight changes every price, and a replay on the pickup date still gets the hold as made.
    await db.prepare("UPDATE prices SET price_jpy = price_jpy + 700, advance_price_jpy = NULL").run();
    for (const [row, held] of lastEvening) {
      const replay = holdFor(
        { modelId: row.modelId, packageId: row.packageId, rateClassId: "" },
        { id: held.id, startAt: held.startAt, locale: held.locale ?? "en" },
      );
      assert.deepEqual(await createHold(db, replay, wall("2030-06-10", "00:05")), { ok: true, booking: held }, row.label);
      assert.deepEqual(await getBooking(db, held.id), held, row.label);
    }

    // A publish lands after every check and just before the insert: the hold takes the advance price as it stands then.
    const [oneDay, , , noAdvance] = rows;
    const restore = (row: AdvanceRow, price: number, advance: number | null) =>
      db
        .prepare("UPDATE prices SET price_jpy = ?1, advance_price_jpy = ?2 WHERE package_id = ?3")
        .bind(price, advance, row.packageId)
        .run();
    await restore(oneDay, 4500, 4000);
    await restore(noAdvance, 15_000, null);
    const races: [string, AdvanceRow, number | null, number][] = [
      ["the advance price lowered", oneDay, 3800, 3800],
      ["the advance price cleared", oneDay, null, 4500],
      ["an advance price added", noAdvance, 14_200, 14_200],
    ];
    for (const [label, row, advance, expected] of races) {
      const publish = raceBeforeInsert(db, () =>
        db.prepare("UPDATE prices SET advance_price_jpy = ?1 WHERE package_id = ?2").bind(advance, row.packageId).run(),
      );
      const input = holdFor({ modelId: row.modelId, packageId: row.packageId, rateClassId: "" }, {
        startAt: wall("2030-07-20", "09:00"),
      });
      const held = booked(await createHold(publish.db, input, wall("2030-07-01", "12:00")), label);
      assert.ok(publish.raced(), `${label}: no statement inserted into bookings`);
      assert.equal(held.priceJpy, expected, label);
    }
  }, ADVANCE_SHOP);
});

test("a same-day hold pays the regular price", async () => {
  await withShop(async (db) => {
    const rows = await seedAdvanceShop(db);
    for (const [when, now, startAt, dayBefore] of ON_THE_PICKUP_DATE) {
      for (const row of rows) {
        const label = `${row.label}, ${when}`;
        const booking = await holdPrice(db, row, startAt, now, label);
        assert.equal(booking.priceJpy, row.priceJpy, label);

        // The same pickup held a second before that JST midnight gets the advance price, where the row has one.
        const aheadLabel = `${row.label}, the same pickup held the second before midnight`;
        const ahead = await holdPrice(db, row, startAt, dayBefore, aheadLabel);
        assert.equal(ahead.priceJpy, row.advancePriceJpy ?? row.priceJpy, aheadLabel);
      }
    }
  }, ADVANCE_SHOP);
});
