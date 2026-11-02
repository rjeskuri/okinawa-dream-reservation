// Staff overrides from the Bookings tab, on a real in-memory D1. Every case reads the database back, because `results`
// and what happened to the booking are two claims. Expected values come from literals, from Date.parse on an explicit
// +09:00 offset, or from the rule worked out again here, never from src/lib/db/blocking.ts or the code under test.
//
// Rulings these tests pin where the ticket is silent:
// - `results` holds the touched rows, in the order of `rows`. Level `ok` means the booking moved, and `plate` is then its
//   new plate. Everything else that is touched is level `error`.
// - A row whose override already equals the stored plate is not touched: no entry in `results`, no write. That is
//   checked first, so it holds on a booking that ended or was cancelled and on a bike since retired. Otherwise every
//   override that ever applied would come back as an error on every Publish.
// - Only a CONFIRMED booking moves. ON_HOLD, PAYMENT_PENDING and EXPIRED rows are ignored with a message, as CANCELLED is.
// - A booking has ended once `now` reaches end_at. A rental under way can still move.
// - A moved booking has updated_at = now, and no other column changes.
// - Rows run top to bottom, each against what the rows before it did. The higher of two competing rows wins, a bike
//   freed by one row is free for the next, and a swap in one Publish is refused on both rows.
// - A refusal's `plate`, if it has one, is never the bike it was refused. Messages are only checked for being there,
//   and for telling busy, inactive, unknown and other-model apart: their wording is for a reviewer.
// - One call attempts at most 20 moves, and costs at most 50 D1 statements whatever the length of the tab, which is what
//   Workers Free allows an invocation. An attempted move is a row that reaches the conditional UPDATE. No-ops and rows
//   refused from the stored state (ended, cancelled, unknown) do not count.
// - Rows run top to bottom, so a row past the cap is a later row. It is level `error`, with a message that it was not
//   applied and that publishing again will do it, and its booking is unchanged. The next call does it.
// - The cap is only about moves. Past it a no-op is still silent and a row refused from the stored state keeps its own
//   refusal, since no Publish would ever do that row.
// - The stored state includes the bike: a row wanting a busy bike or a plate that is no bike keeps its own refusal, and a
//   tab of them neither fills the cap nor spends a statement a row. That refusal is what the row gets as a call's only row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHold } from "../src/lib/booking/holds.ts";
import { createTestDb } from "./helpers/d1.ts";
import { seedBooking, seedCatalogMeta, seedConfig, seedModel, seedPackage, seedPrice, seedVehicle } from "./helpers/seed.ts";
import type { BookingRow, VehicleRow } from "./helpers/seed.ts";

type OverrideRow = { row: number; bookingId: string; overridePlate: string };
type OverrideResult = { row: number; level: "ok" | "error"; message: string; plate?: string };
type Shop = { modelId: string; packageId: string; rateClassId: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function jst(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/** The date `n` days after `date`, from Date.UTC's own calendar. */
function dayAfter(date: string, n: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + n)).toISOString().slice(0, 10);
}

const NOW = jst("2030-06-01", "12:00");
const DAY = "2030-06-10";
const PICKUP = jst(DAY, "09:00");
const CLOSE = jst(DAY, "18:00");
const DEFAULT_BUF_MS = 60 * MINUTE_MS;

/** Loaded here, so each test reports its own failure until the module exists. */
async function apply(db: D1Database, rows: OverrideRow[], now = NOW): Promise<OverrideResult[]> {
  const { applyOverrides } = await import("../src/lib/booking/overrides.ts");
  return (await applyOverrides(db, rows, now)).results;
}

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
async function seedShop(db: D1Database, days = 1): Promise<Shop> {
  const model = await seedModel(db);
  const pkg = await seedPackage(db, { days });
  await seedPrice(db, { rate_class_id: model.rate_class_id, package_id: pkg.id });
  return { modelId: model.id, packageId: pkg.id, rateClassId: model.rate_class_id };
}

async function bike(db: D1Database, shop: Shop, partial: Partial<VehicleRow> = {}): Promise<string> {
  return (await seedVehicle(db, { model_id: shop.modelId, ...partial })).plate;
}

/** A CONFIRMED rental on `plate`, opening to closing on DAY unless `partial` says otherwise. */
function rental(db: D1Database, shop: Shop, plate: string, partial: Partial<BookingRow> = {}): Promise<BookingRow> {
  return seedBooking(db, {
    vehicle_plate: plate,
    model_id: shop.modelId,
    package_id: shop.packageId,
    start_at: PICKUP,
    end_at: CLOSE,
    ...partial,
  });
}

/** `count` copies of a booking on its bike, each a day after the last, in one statement rather than a seed call each. */
async function copiesOf(db: D1Database, template: BookingRow, count: number): Promise<BookingRow[]> {
  const columns = Object.keys(template);
  const copied = columns.map((column) => {
    if (column === "id" || column === "ref") return `${column} || '-' || n.i`;
    if (column === "start_at" || column === "end_at") return `${column} + n.i * ?3`;
    return column;
  });
  const { results } = await db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO bookings (${columns.join(", ")})
       SELECT ${copied.join(", ")} FROM bookings, n WHERE id = ?1 RETURNING *`,
    )
    .bind(template.id, count, DAY_MS)
    .all<BookingRow>();
  assert.equal(results.length, count, "the copies");
  return results.sort((a, b) => a.start_at - b.start_at);
}

let lastBlock = 0;

/** The columns of a staff block, which has no package, price or deposit. */
function block(partial: Partial<BookingRow> = {}): Partial<BookingRow> {
  lastBlock += 1;
  return {
    source: "block",
    external_ref: `override-block-${lastBlock}`,
    external_channel: "klook",
    package_id: null,
    price_jpy: null,
    deposit_jpy: null,
    ...partial,
  };
}

let lastHold = 0;

function holdFor(shop: Shop, startAt: number) {
  lastHold += 1;
  return { id: `hold-${lastHold}`, modelId: shop.modelId, packageId: shop.packageId, startAt, locale: "en" as const };
}

async function stored(db: D1Database, id: string): Promise<BookingRow> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `booking ${id} is in D1`);
  return row;
}

async function assertMoved(db: D1Database, before: BookingRow, plate: string, now: number, label: string): Promise<void> {
  assert.deepEqual(await stored(db, before.id), { ...before, vehicle_plate: plate, updated_at: now }, label);
}

async function assertKept(db: D1Database, before: BookingRow, label: string): Promise<void> {
  assert.deepEqual(await stored(db, before.id), before, label);
}

function assertApplied(result: OverrideResult | undefined, row: number, plate: string, label: string): void {
  assert.ok(result, `${label}: no result`);
  assert.equal(result.row, row, label);
  assert.equal(result.level, "ok", `${label}: ${result.message}`);
  assert.equal(result.plate, plate, label);
  assert.ok(result.message.trim().length > 0, `${label}: an empty message`);
}

function assertRefused(result: OverrideResult | undefined, row: number, target: string, label: string): void {
  assert.ok(result, `${label}: no result`);
  assert.equal(result.row, row, label);
  assert.equal(result.level, "error", `${label}: ${JSON.stringify(result)}`);
  assert.notEqual(result.plate, target, label);
  assert.ok(result.message.trim().length > 0, `${label}: an empty message`);
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

const BOOKING_UPDATE = /\bupdate\s+(?:or\s+\w+\s+)?["`]?bookings\b/i;

/**
 * `db`, with `beforeUpdate` run once just before the first statement that updates bookings executes. That is the moment
 * a rival hold or a publish lands after every earlier read, which only a conditional UPDATE survives. `raced` says the
 * moment came, so a case cannot pass without it.
 */
function raceBeforeUpdate(db: D1Database, beforeUpdate: () => Promise<unknown>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const unwrapped = new WeakMap<object, { statement: D1PreparedStatement; sql: string }>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapper = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "bind") return wrap(value.apply(target, args), sql);
          if (raced || !BOOKING_UPDATE.test(sql)) return value.apply(target, args);
          raced = true;
          return beforeUpdate().then(() => value.apply(target, args));
        };
      },
    });
    unwrapped.set(wrapper, { statement, sql });
    return wrapper;
  };
  const racing = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const inner = statements.map((statement) => unwrapped.get(statement) ?? { statement, sql: "" });
          if (!raced && inner.some(({ sql }) => BOOKING_UPDATE.test(sql))) {
            raced = true;
            await beforeUpdate();
          }
          return target.batch(inner.map(({ statement }) => statement));
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: racing, raced: () => raced };
}

/** `db`, counting what D1 charges an invocation for: each statement run, and each statement in a `batch` on its own. */
function countStatements(db: D1Database): { db: D1Database; count: () => number } {
  let count = 0;
  const unwrapped = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapper = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "bind") return wrap(value.apply(target, args));
          count += 1;
          return value.apply(target, args);
        };
      },
    });
    unwrapped.set(wrapper, statement);
    return wrapper;
  };
  const counting = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          count += statements.length;
          return target.batch(statements.map((statement) => unwrapped.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counting, count: () => count };
}

// --- A valid override --------------------------------------------------------------------------------------------

/** `row` is a sheet row number, which nothing below may assume is small or in order. */
const MOVES: { label: string; from: string; to: string; days: number; pickup: string; row: number; isBlock?: boolean }[] = [
  { label: "a one-day rental", from: "A-1", to: "B-1", days: 1, pickup: "09:00", row: 2 },
  { label: "three days from the afternoon", from: "わ1001", to: "わ1002", days: 3, pickup: "13:30", row: 17 },
  { label: "a week on plates of digits", from: "2001", to: "2002", days: 7, pickup: "10:00", row: 301 },
  { label: "a plate with a quote in it", from: "O'Neil-1", to: "O'Neil-2", days: 2, pickup: "11:30", row: 44 },
  { label: "a staff block", from: "品川500あ7777", to: "品川500あ7778", days: 2, pickup: "17:30", row: 5, isBlock: true },
];

test("a valid override moves the booking", async () => {
  await withShop(async (db) => {
    for (const { label, from, to, days, pickup, row, isBlock } of MOVES) {
      const shop = await seedShop(db, days);
      await seedVehicle(db, { plate: from, model_id: shop.modelId });
      await seedVehicle(db, { plate: to, model_id: shop.modelId });
      const span = { start_at: jst(DAY, pickup), end_at: jst(dayAfter(DAY, days - 1), "18:00") };
      // A third bike out at the same time: only the named bike's own bookings can make it busy.
      await rental(db, shop, await bike(db, shop), span);
      const booking = await rental(db, shop, from, { ...span, ...(isBlock ? block() : {}) });

      const results = await apply(db, [{ row, bookingId: booking.id, overridePlate: to }]);

      assert.equal(results.length, 1, label);
      assertApplied(results[0], row, to, label);
      await assertMoved(db, booking, to, NOW, label);

      // The old bike is free again and the new one is taken, so a hold for the same rental gets exactly one bike.
      const freed = await createHold(db, holdFor(shop, span.start_at), NOW);
      assert.ok(freed.ok && freed.booking.vehiclePlate === from, `${label}: ${JSON.stringify(freed)}`);
      assert.deepEqual(await createHold(db, holdFor(shop, span.start_at), NOW), { ok: false, reason: "SOLD_OUT" }, label);
    }

    // The clock is the caller's: by the real clock this rental ended years ago, and at this `now` it is under way.
    const shop = await seedShop(db);
    const target = await bike(db, shop);
    const past = await rental(db, shop, await bike(db, shop), {
      start_at: jst("2020-03-01", "09:00"),
      end_at: jst("2020-03-03", "18:00"),
    });
    const now = jst("2020-03-02", "12:00");
    assertApplied((await apply(db, [{ row: 9, bookingId: past.id, overridePlate: target }], now))[0], 9, target, "in 2020");
    await assertMoved(db, past, target, now, "in 2020");
  });
});

// --- Refused bikes -------------------------------------------------------------------------------------------------

test("busy, inactive, unknown and other-model bikes are refused", async () => {
  await withShop(async (db) => {
    const run = (sql: string, ...values: string[]) =>
      db
        .prepare(sql)
        .bind(...values)
        .run();

    // Each leaves one thing wrong with the bike and `repair` puts it right, so a refusal can only be about that thing.
    const refusals: {
      reason: string;
      arrange: (shop: Shop, plate: string) => Promise<unknown>;
      repair: (shop: Shop, plate: string) => Promise<unknown>;
    }[] = [
      {
        reason: "busy",
        arrange: async (shop, plate) => rental(db, shop, await bike(db, shop, { plate })),
        repair: (_shop, plate) => run("UPDATE bookings SET status = 'CANCELLED' WHERE vehicle_plate = ?1", plate),
      },
      {
        reason: "maintenance",
        arrange: (shop, plate) => bike(db, shop, { plate, status: "maintenance" }),
        repair: (_shop, plate) => run("UPDATE vehicles SET status = 'active' WHERE plate = ?1", plate),
      },
      {
        reason: "retired",
        arrange: (shop, plate) => bike(db, shop, { plate, status: "retired" }),
        repair: (_shop, plate) => run("UPDATE vehicles SET status = 'active' WHERE plate = ?1", plate),
      },
      {
        reason: "unknown",
        arrange: async () => {},
        repair: (shop, plate) => bike(db, shop, { plate }),
      },
      {
        reason: "other-model",
        // Same rate class, type and price as the booking's model, so only the model itself tells them apart.
        arrange: async (shop, plate) => {
          const other = await seedModel(db, { rate_class_id: shop.rateClassId });
          await seedVehicle(db, { plate, model_id: other.id });
        },
        repair: (shop, plate) => run("UPDATE vehicles SET model_id = ?1 WHERE plate = ?2", shop.modelId, plate),
      },
    ];

    const messages = new Map<string, string>();
    for (const [index, { reason, arrange, repair }] of refusals.entries()) {
      const shop = await seedShop(db);
      const booking = await rental(db, shop, await bike(db, shop));
      const plate = `refused-${index}`;
      const row = 10 + index * 7;
      const asked = { row, bookingId: booking.id, overridePlate: plate };
      await arrange(shop, plate);

      const results = await apply(db, [asked]);
      assert.equal(results.length, 1, reason);
      assertRefused(results[0], row, plate, reason);
      await assertKept(db, booking, reason);
      messages.set(reason, results[0].message);

      // The booking still holds its bike, and neither bike is left for a guest.
      assert.deepEqual(await createHold(db, holdFor(shop, PICKUP), NOW), { ok: false, reason: "SOLD_OUT" }, reason);

      // With the one thing put right the same row goes through.
      await repair(shop, plate);
      const later = NOW + HOUR_MS;
      assertApplied((await apply(db, [asked], later))[0], row, plate, `${reason}, repaired`);
      await assertMoved(db, booking, plate, later, `${reason}, repaired`);
    }

    // Staff read these in override_status, so each reason has its own. Maintenance and retired may share one.
    const messageOf = (reason: string) => messages.get(reason);
    for (const inactive of ["maintenance", "retired"]) {
      const reasons = ["busy", inactive, "unknown", "other-model"];
      assert.equal(new Set(reasons.map(messageOf)).size, 4, JSON.stringify(reasons.map(messageOf)));
    }

    // Hostile text is a plate like any other: a parameter that matches no bike, and the rows after it still run.
    const shop = await seedShop(db);
    const target = await bike(db, shop);
    const hostile = ["' OR '1'='1", "x'; DROP TABLE bookings; --", "%", "_", `${target.slice(0, -1)}%`];
    for (const plate of hostile) {
      const booking = await rental(db, shop, await bike(db, shop));
      const results = await apply(db, [{ row: 3, bookingId: booking.id, overridePlate: plate }]);
      assert.equal(results.length, 1, plate);
      assertRefused(results[0], 3, plate, plate);
      await assertKept(db, booking, plate);
    }

    // A blank plate names no bike, whatever the row reports. The endpoint filters blank cells: see the e2e test.
    const blank = await rental(db, shop, await bike(db, shop));
    await apply(db, [{ row: 3, bookingId: blank.id, overridePlate: "" }]);
    await assertKept(db, blank, "a blank plate");
  });
});

test("a bike is busy by the overlap rule, to the millisecond and whatever the turnaround", async () => {
  await withShop(async (db) => {
    const spans = [
      { label: "an afternoon", startAt: jst(DAY, "10:00"), endAt: jst(DAY, "14:00") },
      { label: "three days", startAt: jst(DAY, "13:30"), endAt: jst(dayAfter(DAY, 2), "18:00") },
    ];
    for (const turnaround of [0, 30, 60, 90, 930]) {
      await seedConfig(db, { turnaround_minutes: turnaround });
      const buf = turnaround * MINUTE_MS;
      const shop = await seedShop(db);

      for (const { label, startAt, endAt } of spans) {
        // [what the rival does, its start, its end, whether the bike stays free for this rental]
        const rivals: [string, number, number, boolean][] = [
          ["returns exactly one turnaround before the pickup", startAt - buf - HOUR_MS, startAt - buf, true],
          ["returns a millisecond too late", startAt - buf - HOUR_MS, startAt - buf + 1, false],
          ["leaves exactly one turnaround after the return", endAt + buf, endAt + buf + HOUR_MS, true],
          ["leaves a millisecond too early", endAt + buf - 1, endAt + buf + HOUR_MS, false],
          ["sits inside the rental", startAt + MINUTE_MS, endAt - MINUTE_MS, false],
          ["runs around the rental", startAt - HOUR_MS, endAt + HOUR_MS, false],
        ];
        for (const [what, start_at, end_at, free] of rivals) {
          const caseLabel = `${label}, ${turnaround} minutes: the rival ${what}`;
          const target = await bike(db, shop);
          await rental(db, shop, target, { start_at, end_at });
          const booking = await rental(db, shop, await bike(db, shop), { start_at: startAt, end_at: endAt });

          const [result] = await apply(db, [{ row: 2, bookingId: booking.id, overridePlate: target }]);

          if (free) {
            assertApplied(result, 2, target, caseLabel);
            await assertMoved(db, booking, target, NOW, caseLabel);
          } else {
            assertRefused(result, 2, target, caseLabel);
            await assertKept(db, booking, caseLabel);
          }
        }
      }
    }
  });
});

test("a rival on the bike counts only while it blocks at the given now", async () => {
  const rivals: [string, () => Partial<BookingRow>, boolean][] = [
    ["a live hold", () => ({ status: "ON_HOLD", expires_at: NOW + 1 }), true],
    ["a hold expiring at this instant", () => ({ status: "ON_HOLD", expires_at: NOW }), false],
    ["a lapsed hold", () => ({ status: "ON_HOLD", expires_at: NOW - 1 }), false],
    ["a charge in flight", () => ({ status: "PAYMENT_PENDING" }), true],
    ["a charge in flight past its hold", () => ({ status: "PAYMENT_PENDING", expires_at: NOW - HOUR_MS }), true],
    ["a confirmed rental", () => ({}), true],
    ["a confirmed rental with an old expiry", () => ({ expires_at: NOW - HOUR_MS }), true],
    ["a cancelled rental", () => ({ status: "CANCELLED" }), false],
    ["an expired hold, its expiry ahead", () => ({ status: "EXPIRED", expires_at: NOW + HOUR_MS }), false],
    ["a staff block", () => block(), true],
    ["a cancelled staff block", () => block({ status: "CANCELLED" }), false],
  ];
  await withShop(async (db) => {
    for (const [label, fields, blocks] of rivals) {
      const shop = await seedShop(db);
      const target = await bike(db, shop);
      await rental(db, shop, target, fields());
      const booking = await rental(db, shop, await bike(db, shop));

      const [result] = await apply(db, [{ row: 2, bookingId: booking.id, overridePlate: target }]);

      if (blocks) {
        assertRefused(result, 2, target, label);
        await assertKept(db, booking, label);
      } else {
        assertApplied(result, 2, target, label);
        await assertMoved(db, booking, target, NOW, label);
      }
    }

    // The same hold on the same bike, on either side of its expiry.
    const shop = await seedShop(db);
    const target = await bike(db, shop);
    const expiry = NOW + 10 * MINUTE_MS;
    await rental(db, shop, target, { status: "ON_HOLD", expires_at: expiry });
    const booking = await rental(db, shop, await bike(db, shop));
    const asked = { row: 2, bookingId: booking.id, overridePlate: target };
    assertRefused((await apply(db, [asked], expiry - 1))[0], 2, target, "before the expiry");
    await assertKept(db, booking, "before the expiry");
    assertApplied((await apply(db, [asked], expiry))[0], 2, target, "at the expiry");
    await assertMoved(db, booking, target, expiry, "at the expiry");
  });
});

// --- Competing overrides -------------------------------------------------------------------------------------------

/** Rental A runs 09:00 to 12:00 and B as given, both wanting one bike, with the default 60-minute turnaround. */
const PAIRS: { label: string; start: string; end: string; clash: boolean }[] = [
  { label: "the same span", start: "09:00", end: "12:00", clash: true },
  { label: "B starting inside A", start: "11:00", end: "15:00", clash: true },
  { label: "B around A", start: "08:00", end: "16:00", clash: true },
  { label: "B starting a minute into the turnaround", start: "12:59", end: "15:00", clash: true },
  { label: "B starting as the turnaround ends", start: "13:00", end: "15:00", clash: false },
  { label: "B returning a minute into the turnaround", start: "06:00", end: "08:01", clash: true },
  { label: "B returning as the turnaround ends", start: "06:00", end: "08:00", clash: false },
];

test("competing overrides cannot double-book a bike", async () => {
  await withShop(async (db) => {
    for (const { label, start, end, clash } of PAIRS) {
      for (const aFirst of [true, false]) {
        const caseLabel = `${label}, ${aFirst ? "A" : "B"} first`;
        const shop = await seedShop(db);
        const target = await bike(db, shop);
        const a = await rental(db, shop, await bike(db, shop), { end_at: jst(DAY, "12:00") });
        const b = await rental(db, shop, await bike(db, shop), { start_at: jst(DAY, start), end_at: jst(DAY, end) });
        const [first, second] = aFirst ? [a, b] : [b, a];
        const rows = [
          { row: 4, bookingId: first.id, overridePlate: target },
          { row: 9, bookingId: second.id, overridePlate: target },
        ];

        const results = await apply(db, rows);

        assert.equal(results.length, 2, caseLabel);
        assertApplied(results[0], 4, target, caseLabel);
        await assertMoved(db, first, target, NOW, caseLabel);
        if (clash) {
          assertRefused(results[1], 9, target, caseLabel);
          await assertKept(db, second, caseLabel);
        } else {
          // Two rentals that clear each other share the bike: a row is refused by a booking, not by a repeated plate.
          assertApplied(results[1], 9, target, caseLabel);
          await assertMoved(db, second, target, NOW, caseLabel);
        }
        assert.deepEqual(await conflictingPairs(db, NOW, DEFAULT_BUF_MS), [], caseLabel);
      }
    }

    // Many rows, one bike: the first takes it.
    {
      const shop = await seedShop(db);
      const target = await bike(db, shop);
      const rivals: BookingRow[] = [];
      for (let i = 0; i < 6; i += 1) rivals.push(await rental(db, shop, await bike(db, shop)));
      const rows = rivals.map(({ id }, i) => ({ row: 20 - i, bookingId: id, overridePlate: target }));

      const results = await apply(db, rows);

      assert.equal(results.length, rivals.length);
      assertApplied(results[0], 20, target, "six rows, the first");
      await assertMoved(db, rivals[0], target, NOW, "six rows, the first");
      for (let i = 1; i < rivals.length; i += 1) {
        assertRefused(results[i], 20 - i, target, `six rows, row ${i}`);
        await assertKept(db, rivals[i], `six rows, row ${i}`);
      }
    }

    // P and R clear each other and Q clashes with both, so who wins depends on what the rows before already did.
    const chains: { order: ("P" | "Q" | "R")[]; onTarget: string[] }[] = [
      { order: ["P", "Q", "R"], onTarget: ["P", "R"] },
      { order: ["R", "Q", "P"], onTarget: ["R", "P"] },
      { order: ["Q", "P", "R"], onTarget: ["Q"] },
      { order: ["P", "R", "Q"], onTarget: ["P", "R"] },
    ];
    for (const { order, onTarget } of chains) {
      const label = `chain ${order.join(" ")}`;
      const shop = await seedShop(db);
      const target = await bike(db, shop);
      const bookings = {
        P: await rental(db, shop, await bike(db, shop), { start_at: jst(DAY, "09:00"), end_at: jst(DAY, "11:00") }),
        Q: await rental(db, shop, await bike(db, shop), { start_at: jst(DAY, "10:00"), end_at: jst(DAY, "14:00") }),
        R: await rental(db, shop, await bike(db, shop), { start_at: jst(DAY, "12:00"), end_at: jst(DAY, "16:00") }),
      };
      const rows = order.map((name, i) => ({ row: i + 2, bookingId: bookings[name].id, overridePlate: target }));

      const results = await apply(db, rows);

      assert.equal(results.length, 3, label);
      for (const [i, name] of order.entries()) {
        if (onTarget.includes(name)) {
          assertApplied(results[i], i + 2, target, `${label}, ${name}`);
          await assertMoved(db, bookings[name], target, NOW, `${label}, ${name}`);
        } else {
          assertRefused(results[i], i + 2, target, `${label}, ${name}`);
          await assertKept(db, bookings[name], `${label}, ${name}`);
        }
      }
    }

    // Separate calls at once: a read taken before the other call's write would let both through.
    for (const size of [2, 5]) {
      const shop = await seedShop(db);
      const target = await bike(db, shop);
      const rivals: BookingRow[] = [];
      for (let i = 0; i < size; i += 1) rivals.push(await rental(db, shop, await bike(db, shop)));

      const outcomes = await Promise.all(rivals.map(({ id }) => apply(db, [{ row: 2, bookingId: id, overridePlate: target }])));

      const levels = outcomes.map((results) => results[0]?.level);
      assert.equal(levels.filter((level) => level === "ok").length, 1, `${size} calls: ${levels.join(", ")}`);
      assert.equal(levels.filter((level) => level === "error").length, size - 1, `${size} calls`);
      const onTarget = await db
        .prepare("SELECT COUNT(*) AS n FROM bookings WHERE vehicle_plate = ?1")
        .bind(target)
        .first<{ n: number }>();
      assert.equal(onTarget?.n, 1, `${size} calls`);
    }

    // An override against a guest's hold for the same bike: whichever lands first, each rental has a bike of its own.
    for (let round = 0; round < 6; round += 1) {
      const shop = await seedShop(db);
      const target = await bike(db, shop);
      const booking = await rental(db, shop, await bike(db, shop));

      const [results, hold] = await Promise.all([
        apply(db, [{ row: 2, bookingId: booking.id, overridePlate: target }]),
        createHold(db, holdFor(shop, PICKUP), NOW),
      ]);

      assert.ok(hold.ok, `round ${round}: ${JSON.stringify(hold)}`);
      assert.equal(results.length, 1, `round ${round}`);
      assert.deepEqual(await conflictingPairs(db, NOW, DEFAULT_BUF_MS), [], `round ${round}`);
    }
  });
});

test("the update sees a rival that lands after every earlier read", async () => {
  await withShop(async (db) => {
    const run = (sql: string, ...values: string[]) =>
      db
        .prepare(sql)
        .bind(...values)
        .run();

    // Each lands after the checks have passed. Decided by an earlier read, the update double-books the bike, moves a
    // booking onto one it may not have, or moves a booking that may no longer move. `becomes` is what the landing itself
    // does to the booking, which is all that may have happened to it.
    const landings: {
      label: string;
      land: (shop: Shop, plate: string, otherModel: string, booking: BookingRow) => Promise<unknown>;
      becomes?: (booking: BookingRow) => BookingRow;
    }[] = [
      { label: "a rival rental", land: (shop, plate) => rental(db, shop, plate) },
      { label: "a guest's live hold", land: (shop, plate) => rental(db, shop, plate, { status: "ON_HOLD", expires_at: NOW + HOUR_MS }) },
      { label: "a staff block", land: (shop, plate) => rental(db, shop, plate, block()) },
      { label: "the bike retired", land: (_shop, plate) => run("UPDATE vehicles SET status = 'retired' WHERE plate = ?1", plate) },
      { label: "the bike off to maintenance", land: (_shop, plate) => run("UPDATE vehicles SET status = 'maintenance' WHERE plate = ?1", plate) },
      {
        label: "the bike given to another model",
        land: (_shop, plate, otherModel) => run("UPDATE vehicles SET model_id = ?1 WHERE plate = ?2", otherModel, plate),
      },
      {
        label: "the booking itself cancelled",
        land: (_shop, _plate, _otherModel, booking) => run("UPDATE bookings SET status = 'CANCELLED' WHERE id = ?1", booking.id),
        becomes: (booking) => ({ ...booking, status: "CANCELLED" }),
      },
    ];
    for (const { label, land, becomes } of landings) {
      const shop = await seedShop(db);
      const otherModel = (await seedModel(db)).id;
      const target = await bike(db, shop);
      const booking = await rental(db, shop, await bike(db, shop));
      const racing = raceBeforeUpdate(db, () => land(shop, target, otherModel, booking));

      const results = await apply(racing.db, [{ row: 6, bookingId: booking.id, overridePlate: target }]);

      assert.ok(racing.raced(), `${label}: no statement updated bookings`);
      assert.equal(results.length, 1, label);
      assertRefused(results[0], 6, target, label);
      await assertKept(db, becomes?.(booking) ?? booking, label);
      assert.deepEqual(await conflictingPairs(db, NOW, DEFAULT_BUF_MS), [], label);
    }
  });
});

test("each row sees what the rows before it did", async () => {
  await withShop(async (db) => {
    const world = async () => {
      const shop = await seedShop(db);
      const [one, two, three] = [await bike(db, shop), await bike(db, shop), await bike(db, shop)];
      return { one, two, three, a: await rental(db, shop, one), b: await rental(db, shop, two) };
    };

    // B leaves bike two and A takes it, in one call.
    {
      const { two, three, a, b } = await world();
      const results = await apply(db, [
        { row: 2, bookingId: b.id, overridePlate: three },
        { row: 3, bookingId: a.id, overridePlate: two },
      ]);
      assert.equal(results.length, 2);
      assertApplied(results[0], 2, three, "the bike is freed first");
      assertApplied(results[1], 3, two, "and then taken");
      await assertMoved(db, b, three, NOW, "the bike is freed first");
      await assertMoved(db, a, two, NOW, "and then taken");
    }

    // The same two rows the other way up: bike two is still taken when A asks for it.
    {
      const { two, three, a, b } = await world();
      const results = await apply(db, [
        { row: 2, bookingId: a.id, overridePlate: two },
        { row: 3, bookingId: b.id, overridePlate: three },
      ]);
      assert.equal(results.length, 2);
      assertRefused(results[0], 2, two, "the bike is asked for first");
      assertApplied(results[1], 3, three, "and freed after");
      await assertKept(db, a, "the bike is asked for first");
      await assertMoved(db, b, three, NOW, "and freed after");
    }

    // A swap needs a bike that is free at each step, and neither is.
    {
      const { one, two, a, b } = await world();
      const results = await apply(db, [
        { row: 2, bookingId: a.id, overridePlate: two },
        { row: 3, bookingId: b.id, overridePlate: one },
      ]);
      assert.equal(results.length, 2);
      assertRefused(results[0], 2, two, "a swap, the first row");
      assertRefused(results[1], 3, one, "a swap, the second row");
      await assertKept(db, a, "a swap, the first row");
      await assertKept(db, b, "a swap, the second row");
    }
  });
});

// --- Rows that are not moved ---------------------------------------------------------------------------------------

test("ended, cancelled and unknown bookings are ignored with a message", async () => {
  await withShop(async (db) => {
    // Every one has a free bike of its model to move to, so only the booking can be the reason. The ended ones end in
    // 2030, still ahead by the real clock, so `now` is the only thing that can say so.
    const ignored: { label: string; fields?: () => Partial<BookingRow>; now?: number }[] = [
      { label: "a cancelled rental", fields: () => ({ status: "CANCELLED", cancelled_at: NOW - HOUR_MS }) },
      { label: "an expired hold", fields: () => ({ status: "EXPIRED", expires_at: NOW - HOUR_MS }) },
      { label: "a live hold", fields: () => ({ status: "ON_HOLD", expires_at: NOW + HOUR_MS }) },
      { label: "a lapsed hold", fields: () => ({ status: "ON_HOLD", expires_at: NOW - HOUR_MS }) },
      { label: "a charge in flight", fields: () => ({ status: "PAYMENT_PENDING" }) },
      { label: "a cancelled block", fields: () => block({ status: "CANCELLED" }) },
      { label: "a rental that ended weeks ago", now: CLOSE + 30 * DAY_MS },
      { label: "a rental that ended a millisecond ago", now: CLOSE + 1 },
      { label: "a rental ending at this instant", now: CLOSE },
      { label: "a block that ended", fields: () => block(), now: CLOSE + DAY_MS },
    ];
    for (const [index, { label, fields, now }] of ignored.entries()) {
      const shop = await seedShop(db);
      const target = await bike(db, shop);
      const booking = await rental(db, shop, await bike(db, shop), fields?.());
      const row = 5 + index;

      const results = await apply(db, [{ row, bookingId: booking.id, overridePlate: target }], now);

      assert.equal(results.length, 1, label);
      assertRefused(results[0], row, target, label);
      await assertKept(db, booking, label);
    }

    // The other side of the boundary: a rental moves up to its last millisecond, under way or not.
    const stillMovable: [string, number][] = [
      ["a rental ahead", NOW],
      ["a rental starting at this instant", PICKUP],
      ["a rental under way", PICKUP + HOUR_MS],
      ["a rental with a millisecond left", CLOSE - 1],
    ];
    for (const [label, now] of stillMovable) {
      const shop = await seedShop(db);
      const target = await bike(db, shop);
      const booking = await rental(db, shop, await bike(db, shop));

      const results = await apply(db, [{ row: 2, bookingId: booking.id, overridePlate: target }], now);

      assert.equal(results.length, 1, label);
      assertApplied(results[0], 2, target, label);
      await assertMoved(db, booking, target, now, label);
    }

    // No booking by this id, and the id is only ever a parameter.
    const shop = await seedShop(db);
    const target = await bike(db, shop);
    const bystander = await rental(db, shop, await bike(db, shop));
    const unknown = ["no-such-booking", bystander.id.toUpperCase(), `${bystander.id}-2`, "' OR '1'='1", "x'; DROP TABLE bookings; --", "%"];
    for (const [index, bookingId] of unknown.entries()) {
      const row = 50 + index;
      const results = await apply(db, [{ row, bookingId, overridePlate: target }]);
      assert.equal(results.length, 1, bookingId);
      assertRefused(results[0], row, target, bookingId);
      await assertKept(db, bystander, bookingId);
    }
    const onTarget = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE vehicle_plate = ?1").bind(target).first<{ n: number }>();
    assert.equal(onTarget?.n, 0, "the free bike stayed free");
  });
});

test("matching overrides are no-ops", async () => {
  await withShop(async (db) => {
    // None of these may be reported, not even those that would be refused if the plate differed: the row is the record
    // of an override that already applied, and it stays on the sheet for every later Publish.
    const matches: {
      label: string;
      fields?: () => Partial<BookingRow>;
      vehicle?: Partial<VehicleRow>;
      rival?: boolean;
      now?: number;
    }[] = [
      { label: "a rental ahead" },
      { label: "a rental under way", now: PICKUP + HOUR_MS },
      { label: "a staff block", fields: () => block() },
      { label: "a bike since in maintenance", vehicle: { status: "maintenance" } },
      { label: "a bike since retired", vehicle: { status: "retired" } },
      { label: "a bike sharing its time with a rival", rival: true },
      { label: "a rental that ended", now: CLOSE + 30 * DAY_MS },
      { label: "a cancelled rental", fields: () => ({ status: "CANCELLED", cancelled_at: NOW - HOUR_MS }) },
      { label: "an expired hold", fields: () => ({ status: "EXPIRED", expires_at: NOW - HOUR_MS }) },
      { label: "a live hold", fields: () => ({ status: "ON_HOLD", expires_at: NOW + HOUR_MS }) },
    ];
    for (const [index, { label, fields, vehicle, rival, now }] of matches.entries()) {
      const shop = await seedShop(db);
      const plate = await bike(db, shop, vehicle);
      const booking = await rental(db, shop, plate, fields?.());
      const other = rival ? await rental(db, shop, plate) : null;

      const results = await apply(db, [{ row: 2 + index, bookingId: booking.id, overridePlate: plate }], now);

      assert.deepEqual(results, [], label);
      await assertKept(db, booking, label);
      if (other !== null) await assertKept(db, other, label);
    }

    // A second Publish meets the override it applied: nothing moves, and updated_at keeps the first time.
    const shop = await seedShop(db);
    const target = await bike(db, shop);
    const booking = await rental(db, shop, await bike(db, shop));
    const asked = { row: 8, bookingId: booking.id, overridePlate: target };
    assertApplied((await apply(db, [asked]))[0], 8, target, "the first Publish");
    assert.deepEqual(await apply(db, [asked], NOW + DAY_MS), [], "the second Publish");
    await assertMoved(db, booking, target, NOW, "the second Publish");

    // A no-op among rows that do something takes no place in the results.
    const busy = await bike(db, shop);
    await rental(db, shop, busy);
    const [still, moving, refused] = [
      await rental(db, shop, await bike(db, shop)),
      await rental(db, shop, await bike(db, shop)),
      await rental(db, shop, await bike(db, shop)),
    ];
    const free = await bike(db, shop);
    const results = await apply(db, [
      { row: 2, bookingId: still.id, overridePlate: still.vehicle_plate },
      { row: 3, bookingId: moving.id, overridePlate: free },
      { row: 4, bookingId: still.id, overridePlate: still.vehicle_plate },
      { row: 5, bookingId: refused.id, overridePlate: busy },
    ]);
    assert.equal(results.length, 2);
    assertApplied(results[0], 3, free, "the move between no-ops");
    assertRefused(results[1], 5, busy, "the refusal after them");
    await assertKept(db, still, "the no-op");
  });
});

test("a row that cannot move does not stop the rows after it", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db);
    assert.deepEqual(await apply(db, []), [], "no rows");

    const busy = await bike(db, shop);
    await rental(db, shop, busy);
    const [freeOne, freeTwo] = [await bike(db, shop), await bike(db, shop)];
    const [first, second, cancelled, refused] = [
      await rental(db, shop, await bike(db, shop)),
      await rental(db, shop, await bike(db, shop)),
      await rental(db, shop, await bike(db, shop), { status: "CANCELLED" }),
      await rental(db, shop, await bike(db, shop)),
    ];

    // Out of sheet order on purpose: results keep the order of `rows` and carry each row's own number.
    const results = await apply(db, [
      { row: 40, bookingId: "no-such-booking", overridePlate: freeOne },
      { row: 7, bookingId: first.id, overridePlate: freeOne },
      { row: 12, bookingId: refused.id, overridePlate: busy },
      { row: 3, bookingId: cancelled.id, overridePlate: freeTwo },
      { row: 99, bookingId: second.id, overridePlate: freeTwo },
    ]);

    assert.equal(results.length, 5);
    assertRefused(results[0], 40, freeOne, "the unknown booking");
    assertApplied(results[1], 7, freeOne, "the first move");
    assertRefused(results[2], 12, busy, "the busy bike");
    assertRefused(results[3], 3, freeTwo, "the cancelled booking");
    assertApplied(results[4], 99, freeTwo, "the last move");
    await assertMoved(db, first, freeOne, NOW, "the first move");
    await assertMoved(db, second, freeTwo, NOW, "the last move");
    await assertKept(db, refused, "the busy bike");
    await assertKept(db, cancelled, "the cancelled booking");
  });
});

test("a tab of more rows than a D1 statement takes parameters", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db);
    const target = await bike(db, shop);
    const total = 120; // past D1's 100 parameters per statement
    const rows: OverrideRow[] = [];
    const bookings: BookingRow[] = [];
    for (let i = 0; i < total; i += 1) {
      const start_at = PICKUP + i * 2 * DAY_MS;
      const booking = await rental(db, shop, await bike(db, shop), { start_at, end_at: start_at + 8 * HOUR_MS });
      bookings.push(booking);
      // Almost every row is the record of an old override, and each tenth is a new one onto the one spare bike.
      rows.push({ row: i + 2, bookingId: booking.id, overridePlate: i % 10 === 0 ? target : booking.vehicle_plate });
    }

    const results = await apply(db, rows);

    assert.deepEqual(
      results.map(({ row }) => row),
      rows.filter((_, i) => i % 10 === 0).map(({ row }) => row),
    );
    for (const [i, booking] of bookings.entries()) {
      if (i % 10 === 0) await assertMoved(db, booking, target, NOW, `row ${i}`);
      else await assertKept(db, booking, `row ${i}`);
    }
  });
});

// --- The limits of one invocation ----------------------------------------------------------------------------------

const MOVE_CAP = 20;
const STATEMENT_BUDGET = 50;

test("at most 20 moves are attempted in one call, and publishing again does the rest", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db);

    // What each refusal says, so the row past the cap can be told from all of them.
    const busy = await bike(db, shop);
    await rental(db, shop, busy);
    const otherModel = await seedModel(db, { rate_class_id: shop.rateClassId });
    const refusedPlates = [
      busy,
      await bike(db, shop, { status: "maintenance" }),
      "no-such-plate",
      (await seedVehicle(db, { model_id: otherModel.id })).plate,
    ];
    const refusedRows: OverrideRow[] = [];
    for (const [i, overridePlate] of refusedPlates.entries()) {
      const booking = await rental(db, shop, await bike(db, shop));
      refusedRows.push({ row: i + 2, bookingId: booking.id, overridePlate });
    }
    const refusals = await apply(db, refusedRows);
    assert.equal(refusals.length, refusedRows.length, "the four refusals");
    for (const [i, { row, overridePlate }] of refusedRows.entries()) {
      assertRefused(refusals[i], row, overridePlate, overridePlate);
    }
    const refusalMessages = refusals.map(({ message }) => message);

    // Each with a free bike of its own, so nothing but the cap can stop one. Rows run in the order given, not by number.
    const total = 25;
    const bookings = await copiesOf(db, await rental(db, shop, await bike(db, shop)), total);
    const rows: OverrideRow[] = [];
    for (const [i, { id }] of bookings.entries()) {
      rows.push({ row: 400 - i * 7, bookingId: id, overridePlate: await bike(db, shop) });
    }

    const first = await apply(db, rows);

    assert.equal(first.length, total);
    for (const [i, booking] of bookings.entries()) {
      const { row, overridePlate } = rows[i];
      const label = `the first call, row ${i}`;
      if (i < MOVE_CAP) {
        assertApplied(first[i], row, overridePlate, label);
        await assertMoved(db, booking, overridePlate, NOW, label);
      } else {
        assertRefused(first[i], row, overridePlate, label);
        await assertKept(db, booking, label);
        assert.ok(!refusalMessages.includes(first[i].message), `${label}: says it was refused: ${first[i].message}`);
      }
    }

    // The same rows at the next Publish: the rest move, and the first twenty are the record of a move already made.
    const later = NOW + HOUR_MS;
    const second = await apply(db, rows, later);

    assert.equal(second.length, total - MOVE_CAP);
    for (const [i, booking] of bookings.entries()) {
      const { row, overridePlate } = rows[i];
      const label = `the second call, row ${i}`;
      if (i < MOVE_CAP) {
        await assertMoved(db, booking, overridePlate, NOW, label);
      } else {
        assertApplied(second[i - MOVE_CAP], row, overridePlate, label);
        await assertMoved(db, booking, overridePlate, later, label);
      }
    }
  });
});

test("only rows that reach the update count towards the cap", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db);
    const free = await bike(db, shop);
    const rows: OverrideRow[] = [];
    const ask = (bookingId: string, overridePlate: string): OverrideRow => {
      const asked = { row: rows.length + 2, bookingId, overridePlate };
      rows.push(asked);
      return asked;
    };

    // The kinds of row that never reach the update. The refusals want a free bike, so only the booking can be the reason.
    const silent: BookingRow[] = [];
    const storedRefusals: { asked: OverrideRow; booking?: BookingRow }[] = [];
    const refused = async (partial: Partial<BookingRow>): Promise<void> => {
      const booking = await rental(db, shop, await bike(db, shop), partial);
      storedRefusals.push({ asked: ask(booking.id, free), booking });
    };
    const idleKinds: (() => Promise<void>)[] = [
      async () => {
        const booking = await rental(db, shop, await bike(db, shop));
        ask(booking.id, booking.vehicle_plate);
        silent.push(booking);
      },
      () => refused({ status: "CANCELLED", cancelled_at: NOW - HOUR_MS }),
      () => refused({ start_at: NOW - 2 * DAY_MS, end_at: NOW - DAY_MS }),
      async () => {
        storedRefusals.push({ asked: ask(`no-such-booking-${rows.length}`, free) });
      },
    ];

    const bookings = await copiesOf(db, await rental(db, shop, await bike(db, shop)), MOVE_CAP + 2);
    const moves: { asked: OverrideRow; booking: BookingRow }[] = [];
    const move = async (): Promise<void> => {
      const booking = bookings[moves.length];
      moves.push({ asked: ask(booking.id, await bike(db, shop)), booking });
    };

    // A row of another kind after each move, so a cap that counted any of them would fill before the twentieth move.
    for (let i = 0; i < MOVE_CAP; i += 1) {
      await move();
      await idleKinds[i % idleKinds.length]();
    }
    // And past the cap, every kind between two moves that have to wait.
    await move();
    for (const idle of idleKinds) await idle();
    await move();

    const results = await apply(db, rows);

    const silentIds = new Set(silent.map(({ id }) => id));
    assert.deepEqual(
      results.map(({ row }) => row),
      rows.filter(({ bookingId }) => !silentIds.has(bookingId)).map(({ row }) => row),
      "every row but the no-ops, in order",
    );
    const resultOf = new Map(results.map((result) => [result.row, result]));

    for (const [i, { asked, booking }] of moves.entries()) {
      const label = `move ${i}`;
      if (i < MOVE_CAP) {
        assertApplied(resultOf.get(asked.row), asked.row, asked.overridePlate, label);
        await assertMoved(db, booking, asked.overridePlate, NOW, label);
      } else {
        assertRefused(resultOf.get(asked.row), asked.row, asked.overridePlate, label);
        await assertKept(db, booking, label);
      }
    }

    const notApplied = resultOf.get(moves[MOVE_CAP].asked.row)?.message;
    for (const { asked, booking } of storedRefusals) {
      const label = `the stored refusal on row ${asked.row}`;
      assertRefused(resultOf.get(asked.row), asked.row, free, label);
      assert.notEqual(resultOf.get(asked.row)?.message, notApplied, `${label}: no Publish will ever do this row`);
      if (booking !== undefined) await assertKept(db, booking, label);
    }
    for (const booking of silent) await assertKept(db, booking, "a no-op");
  });
});

test("a long tab stays within the D1 statements of one invocation", async () => {
  await withShop(async (db) => {
    // The counter's own control: every way to run a statement counts, and a batch counts by what is in it.
    const probe = countStatements(db);
    const select = probe.db.prepare("SELECT ?1 AS n");
    await select.bind(1).first();
    await probe.db.prepare("SELECT 2 AS n").all();
    await probe.db.prepare("SELECT 3 AS n").raw();
    await probe.db.prepare("DELETE FROM closed_dates WHERE date = 'never'").run();
    assert.equal(probe.count(), 4, "one at a time");
    const batched = await probe.db.batch<{ n: number }>([select.bind(4), select.bind(5), probe.db.prepare("SELECT 6 AS n")]);
    assert.deepEqual(
      batched.map(({ results }) => results[0].n),
      [4, 5, 6],
    );
    assert.equal(probe.count(), 7, "a batch of three");

    const shop = await seedShop(db);
    const otherModel = await seedModel(db, { rate_class_id: shop.rateClassId });
    const bookings = await copiesOf(db, await rental(db, shop, await bike(db, shop)), 204);

    const free = (): Promise<string> => bike(db, shop);
    const busy = async (): Promise<string> => {
      const plate = await bike(db, shop);
      await rental(db, shop, plate, { end_at: PICKUP + 365 * DAY_MS });
      return plate;
    };
    const inMaintenance = (): Promise<string> => bike(db, shop, { status: "maintenance" });
    const retired = (): Promise<string> => bike(db, shop, { status: "retired" });
    const unknown = async (): Promise<string> => "no-such-plate";
    const ofOtherModel = async (): Promise<string> => (await seedVehicle(db, { model_id: otherModel.id })).plate;

    // The first twenty rows with something to do, each wanting a bike of its own so that nothing a lookup reads can be
    // reused, and most of those bikes busy, which takes the most to find out. Every row that can move is here, so it is
    // inside the cap whichever refused rows get as far as the update, and any row past the cap is refused either way.
    const firstTwenty = [
      free, busy, busy, busy, inMaintenance,
      free, busy, retired, busy, busy,
      free, unknown, busy, busy, ofOtherModel,
      free, busy, busy, busy, busy,
    ];
    // The other 48 want one busy bike: a cap that let refused rows through would pay for them, one update each.
    const taken = await busy();

    // Two old overrides before each of those rows.
    type Line = { booking: BookingRow; plate: string; ends: "moves" | "refused" | "silent" };
    const lines: Line[] = [];
    for (const [i, booking] of bookings.entries()) {
      if (i % 3 < 2) {
        lines.push({ booking, plate: booking.vehicle_plate, ends: "silent" });
        continue;
      }
      const wanted = firstTwenty.shift();
      if (wanted === undefined) lines.push({ booking, plate: taken, ends: "refused" });
      else lines.push({ booking, plate: await wanted(), ends: wanted === free ? "moves" : "refused" });
    }
    const rows = lines.map(({ booking, plate }, i) => ({ row: i + 2, bookingId: booking.id, overridePlate: plate }));

    const counted = countStatements(db);
    const results = await apply(counted.db, rows);

    const statements = counted.count();
    assert.ok(statements > 0, "the call went through the counter");
    assert.ok(statements <= STATEMENT_BUDGET, `${statements} D1 statements for ${rows.length} rows`);

    // The budget buys the same outcome as any other call. Read back on `db`, so none of this is counted.
    assert.deepEqual(
      results.map(({ row }) => row),
      rows.filter((_, i) => lines[i].ends !== "silent").map(({ row }) => row),
    );
    const resultOf = new Map(results.map((result) => [result.row, result]));
    const { results: after } = await db.prepare("SELECT * FROM bookings").all<BookingRow>();
    const afterById = new Map(after.map((row) => [row.id, row]));
    for (const [i, { booking, plate, ends }] of lines.entries()) {
      const { row } = rows[i];
      const label = `row ${row}, ${ends}`;
      if (ends === "moves") assertApplied(resultOf.get(row), row, plate, label);
      if (ends === "refused") assertRefused(resultOf.get(row), row, plate, label);
      const expected = ends === "moves" ? { ...booking, vehicle_plate: plate, updated_at: NOW } : booking;
      assert.deepEqual(afterById.get(booking.id), expected, label);
    }
  });
});

/** What `asked` gets as the only row of a call, where no cap can reach it: its own refusal, whatever the wording. */
async function ownRefusal(db: D1Database, asked: OverrideRow, label: string): Promise<string> {
  const results = await apply(db, [asked]);
  assert.equal(results.length, 1, label);
  assertRefused(results[0], asked.row, asked.overridePlate, label);
  return results[0].message;
}

test("a tab of unknown plates stays within the D1 statements of one invocation", async () => {
  await withShop(async (db) => {
    // Two rows share no model, bike, day or plate, so a lookup keyed on any of them costs a statement a row. The long tab
    // above names 21 plates, which a cache of plates pays for once each.
    const lines: { booking: BookingRow; asked: OverrideRow }[] = [];
    for (let i = 0; i < 60; i += 1) {
      const shop = await seedShop(db);
      const booking = await rental(db, shop, await bike(db, shop), { start_at: PICKUP + i * DAY_MS, end_at: CLOSE + i * DAY_MS });
      lines.push({ booking, asked: { row: 900 - i * 7, bookingId: booking.id, overridePlate: `no-such-plate-${i}` } });
    }
    const rows = lines.map(({ asked }) => asked);

    const counted = countStatements(db);
    const results = await apply(counted.db, rows);

    const statements = counted.count();
    assert.ok(statements > 0, "the call went through the counter");
    assert.ok(statements <= STATEMENT_BUDGET, `${statements} D1 statements for ${rows.length} rows`);

    assert.deepEqual(
      results.map(({ row }) => row),
      rows.map(({ row }) => row),
      "every row, in order",
    );
    for (const [i, { booking, asked }] of lines.entries()) {
      const label = `row ${asked.row}`;
      assertRefused(results[i], asked.row, asked.overridePlate, label);
      await assertKept(db, booking, label);
      // No Publish will ever find this bike, so "publish again" would be false however far down the tab the row is.
      assert.equal(results[i].message, await ownRefusal(db, asked, label), `${label}: not its own refusal`);
    }
  });
});

test("a valid row under busy rows moves on the first call", async () => {
  type Span = { start_at: number; end_at: number };

  // Each way a bike can be busy, as the rival that makes it so for the rental `span`. A round runs on one way only, so a
  // reason the reads miss sends every busy row of that round to the update.
  const rivals: [string, (span: Span) => Partial<BookingRow>][] = [
    ["a confirmed rental", (span) => span],
    ["a live hold", (span) => ({ ...span, status: "ON_HOLD", expires_at: NOW + HOUR_MS })],
    ["a charge in flight", (span) => ({ ...span, status: "PAYMENT_PENDING" })],
    ["a staff block", (span) => block(span)],
    [
      "a rental returning a minute into the turnaround",
      ({ start_at }) => ({ start_at: start_at - 3 * HOUR_MS, end_at: start_at - DEFAULT_BUF_MS + MINUTE_MS }),
    ],
  ];
  const busyRows = MOVE_CAP + 5;

  await withShop(async (db) => {
    for (const [kind, rivalOver] of rivals) {
      const shop = await seedShop(db);

      // Every busy row wants a bike of its own, kept busy by a rival of its own, for that row's rental and no other.
      const busy: { booking: BookingRow; asked: OverrideRow }[] = [];
      for (let i = 0; i < busyRows; i += 1) {
        const span = { start_at: PICKUP + i * DAY_MS, end_at: CLOSE + i * DAY_MS };
        const booking = await rental(db, shop, await bike(db, shop), span);
        const wanted = await bike(db, shop);
        await rental(db, shop, wanted, rivalOver(span));
        busy.push({ booking, asked: { row: i + 2, bookingId: booking.id, overridePlate: wanted } });
      }

      // The row under them wants the first of those bikes, weeks after its rival: it is busy for that row and free for this.
      const valid = await rental(db, shop, await bike(db, shop), {
        start_at: PICKUP + busyRows * DAY_MS,
        end_at: CLOSE + busyRows * DAY_MS,
      });
      const target = busy[0].asked.overridePlate;
      const validRow = { row: busyRows + 2, bookingId: valid.id, overridePlate: target };
      const rows = [...busy.map(({ asked }) => asked), validRow];

      const counted = countStatements(db);
      const first = await apply(counted.db, rows);

      const statements = counted.count();
      assert.ok(statements > 0, `${kind}: the call went through the counter`);
      assert.ok(statements <= STATEMENT_BUDGET, `${kind}: ${statements} D1 statements for ${rows.length} rows`);

      assert.deepEqual(
        first.map(({ row }) => row),
        rows.map(({ row }) => row),
        `${kind}: every row, in order`,
      );
      assertApplied(first[busyRows], validRow.row, target, `${kind}: the row under the busy rows`);
      await assertMoved(db, valid, target, NOW, `${kind}: the row under the busy rows`);

      for (const [i, { booking, asked }] of busy.entries()) {
        const label = `${kind}: busy row ${i}`;
        assertRefused(first[i], asked.row, asked.overridePlate, label);
        await assertKept(db, booking, label);
        // Not the cap's "publish again": the bike is busy, and a later Publish finds it just as busy.
        assert.equal(first[i].message, await ownRefusal(db, asked, label), `${label}: not its own refusal`);
      }
    }
  });
});

// --- Every rule at once --------------------------------------------------------------------------------------------

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

type Bike = { plate: string; modelId: string; status: string };
type Rental = { id: string; modelId: string; plate: string; startAt: number; endAt: number; status: string; expiresAt: number };

test("no overlapping blocking bookings after a random sequence of overrides", async () => {
  for (const seed of [22, 2030, 555]) {
    await withShop(async (db) => {
      const random = seededRandom(seed);
      const pick = (n: number): number => Math.floor(random() * n);

      const bikes: Bike[] = [];
      const fleets: [string, string[]][] = [
        ["A", ["active", "active", "active", "active", "active", "maintenance"]],
        ["B", ["active", "active", "active", "retired"]],
      ];
      for (const [fleet, conditions] of fleets) {
        const { id: modelId } = await seedModel(db);
        for (const [i, status] of conditions.entries()) {
          const plate = `${fleet}-${i}`;
          await seedVehicle(db, { plate, model_id: modelId, status });
          bikes.push({ plate, modelId, status });
        }
      }

      // The ledger is the rule worked out again in this test, and it predicts each outcome before the database answers.
      const blocks = (r: Rental, at: number): boolean =>
        r.status === "CONFIRMED" || r.status === "PAYMENT_PENDING" || (r.status === "ON_HOLD" && r.expiresAt > at);
      const clashes = (a: Rental, b: Rental): boolean =>
        b.startAt < a.endAt + DEFAULT_BUF_MS && a.startAt < b.endAt + DEFAULT_BUF_MS;

      const statuses = ["CONFIRMED", "CONFIRMED", "CONFIRMED", "CONFIRMED", "CONFIRMED", "PAYMENT_PENDING", "ON_HOLD", "CANCELLED"];
      const ledger: Rental[] = [];
      for (let i = 0; i < 30; i += 1) {
        const { plate, modelId } = bikes[pick(bikes.length)];
        const startAt = jst(dayAfter(DAY, pick(7)), "09:00") + pick(18) * 30 * MINUTE_MS;
        const candidate: Rental = {
          id: `random-${seed}-${String(i).padStart(2, "0")}`,
          modelId,
          plate,
          startAt,
          endAt: startAt + (1 + pick(40)) * HOUR_MS,
          status: statuses[pick(statuses.length)],
          expiresAt: NOW + (1 + pick(30)) * 10 * MINUTE_MS,
        };
        const taken = ledger.some((other) => other.plate === plate && blocks(other, NOW) && clashes(other, candidate));
        if (taken && blocks(candidate, NOW)) continue;
        ledger.push(candidate);
        await seedBooking(db, {
          id: candidate.id,
          vehicle_plate: plate,
          model_id: modelId,
          status: candidate.status,
          start_at: startAt,
          end_at: candidate.endAt,
          expires_at: candidate.status === "ON_HOLD" ? candidate.expiresAt : null,
        });
      }

      let now = NOW;
      const seen = { moved: 0, refused: 0, noOps: 0 };
      for (let step = 0; step < 80; step += 1) {
        const label = `seed ${seed}, step ${step}`;
        // The last steps run past the end of most rentals, and every hold has lapsed by then.
        now += step === 60 ? 15 * DAY_MS : pick(3) * 10 * MINUTE_MS;

        // A booking has one row on the tab, so it comes up once in a call.
        const chosen = new Set(Array.from({ length: 1 + pick(4) }, () => ledger[pick(ledger.length)]));
        const rows: OverrideRow[] = [...chosen].map(({ id, plate, modelId }, i) => {
          const sameModel = bikes.filter((bike) => bike.modelId === modelId);
          const asked = random();
          const anyBike = bikes[pick(bikes.length)].plate;
          const likelyBike = sameModel[pick(sameModel.length)].plate;
          const overridePlate = asked < 0.08 ? "no-such-plate" : asked < 0.16 ? plate : asked < 0.8 ? likelyBike : anyBike;
          return { row: 100 * step + i, bookingId: id, overridePlate };
        });

        const expected: { row: number; level: string; plate?: string }[] = [];
        for (const { row, bookingId, overridePlate } of rows) {
          const booking = ledger.find(({ id }) => id === bookingId) as Rental;
          if (booking.plate === overridePlate) {
            seen.noOps += 1;
            continue;
          }
          const target = bikes.find(({ plate }) => plate === overridePlate);
          const movable =
            booking.status === "CONFIRMED" &&
            booking.endAt > now &&
            target?.status === "active" &&
            target.modelId === booking.modelId &&
            !ledger.some((o) => o.id !== booking.id && o.plate === overridePlate && blocks(o, now) && clashes(o, booking));
          if (movable) {
            booking.plate = overridePlate;
            expected.push({ row, level: "ok", plate: overridePlate });
            seen.moved += 1;
          } else {
            expected.push({ row, level: "error" });
            seen.refused += 1;
          }
        }

        const results = await apply(db, rows, now);

        assert.deepEqual(
          results.map(({ row, level, plate }) => (level === "ok" ? { row, level, plate } : { row, level })),
          expected,
          label,
        );
        const { results: plates } = await db
          .prepare("SELECT id, vehicle_plate AS plate FROM bookings ORDER BY id")
          .all<{ id: string; plate: string }>();
        assert.deepEqual(plates, ledger.map(({ id, plate }) => ({ id, plate })).sort((a, b) => (a.id < b.id ? -1 : 1)), label);
        assert.deepEqual(await conflictingPairs(db, now, DEFAULT_BUF_MS), [], label);
      }

      // The sequence reached every outcome, or the checks above proved little.
      assert.ok(seen.moved > 0 && seen.refused > 0 && seen.noOps > 0, `seed ${seed}: ${JSON.stringify(seen)}`);
    });
  }
});
