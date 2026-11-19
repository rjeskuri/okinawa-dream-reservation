// createStaffBooking, src/lib/booking/staff-booking.ts (#149): a phone or walk-in reservation, paid at the shop, that takes
// a bike as a web hold does and is CONFIRMED with no payment. Everything runs on a real D1 with the real migrations. What
// the tests read back is the answer, the rows in bookings and outbox, and what createHold, syncBlocks, reconcileSquare and
// syncBookingRows make of them afterwards. Instants come from Date.parse on an explicit +09:00 offset, cancel tokens from
// node:crypto, and plates, prices, deposits and reasons are literals, so no expected value passes through src/lib/time.ts,
// src/lib/booking/cancel.ts or the code under test. createHold is called only as the web hold the ticket compares with.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - A blank guest email is "" exactly. It may be stored as "" or NULL; the Bookings tab shows "" either way.
// - A replay compares the model, package, pickup, locale and the four guest fields. requestedBy names who asked, not what
//   was booked, and is not compared.
// - catalog_version, content_hash and the shape of the ref are left to the code; refs are only told apart.
// - Both emails carry paidJpy 0, beside paidAtShop and depositJpy on the guest's: nothing was paid online.
// - A batch that cannot be written books nothing and queues nothing: the call rejects or refuses, and the id books later.
// - A refusal other than INVALID_GUEST is read by its reason alone, and an input that is no booking request at all gets a
//   declared reason, never an exception.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { syncBlocks } from "../src/lib/booking/blocks.ts";
import { createHold, getBooking } from "../src/lib/booking/holds.ts";
import type { HoldInput } from "../src/lib/booking/holds.ts";
import { BOOKINGS_COLUMNS } from "../src/lib/catalog/sheet-schema.ts";
import type { ValidBlock } from "../src/lib/catalog/sheet-schema.ts";
import type { Guest } from "../src/lib/checkout.ts";
import { LOCALES, type Locale } from "../src/lib/locale.ts";
import { renderEmail } from "../src/lib/mail/templates.ts";
import { drainOutbox, type EmailPayload } from "../src/lib/outbox.ts";
import { reconcileSquare } from "../src/lib/reconcile/square.ts";
import { syncBookingRows } from "../src/lib/sheets/bookings-sync.ts";
import type { SquareClient } from "../src/lib/square/client.ts";
import type { Booking } from "../src/lib/types.ts";
import { expectedCells, named } from "./helpers/bookings-tab.ts";
import { createTestDb } from "./helpers/d1.ts";
import { createFakeSheets } from "./helpers/fake-sheets.ts";
import {
  seedBooking,
  seedCatalogMeta,
  seedClosedDates,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedTiers,
  seedType,
  seedVehicle,
  type BookingRow,
  type ModelRow,
  type TierRow,
} from "./helpers/seed.ts";

/** Loaded at each call, so a test's fixtures run first, a bad fixture shows first, and each test fails on this module alone. */
const staffModule = () => import("../src/lib/booking/staff-booking.ts");
type StaffModule = Awaited<ReturnType<typeof staffModule>>;
const createStaffBooking: StaffModule["createStaffBooking"] = async (...args) =>
  (await staffModule()).createStaffBooking(...args);

type StaffInput = Parameters<typeof createStaffBooking>[1];
type StaffResult = Awaited<ReturnType<typeof createStaffBooking>>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SITE_URL = "https://ride.okinawa-dream.example";
const STAFF_EMAIL = "front-desk@okinawa-dream.example";
const CANCEL_SECRET = `cancel-secret-${randomUUID()}`;
const CTX = { siteUrl: SITE_URL, cancelSecret: CANCEL_SECRET, staffEmail: STAFF_EMAIL };
const REQUESTED_BY = "staff@okinawa-dream.example";

/** The deposit of the default type, set apart from every seed default so the type is what a booking reads. */
const DEPOSIT_JPY = 6_400;

const WINDOW_REASONS = [
  "OUTSIDE_HOURS",
  "OFF_SLOT",
  "CLOSED_PICKUP",
  "RETURN_OUTSIDE_HOURS",
  "CLOSED_RETURN",
  "TOO_SOON",
  "TOO_FAR",
];
const DECLARED_REASONS = [
  "SOLD_OUT",
  "UNKNOWN_MODEL",
  "UNKNOWN_PACKAGE",
  "NO_PRICE",
  "CONFLICT",
  "INVALID_GUEST",
  ...WINDOW_REASONS,
];

/** The instant of a JST wall clock, "YYYY-MM-DD HH:mm" or with seconds and milliseconds. */
function jst(wall: string): number {
  const [date, clock] = wall.split(" ");
  const instant = Date.parse(`${date}T${clock?.length === 5 ? `${clock}:00` : clock}+09:00`);
  assert.ok(Number.isFinite(instant), `bad fixture time ${wall}`);
  return instant;
}

const NOW = jst("2030-06-01 12:00");
const PICKUP_DAY = "2030-06-10";
const PICKUP = jst(`${PICKUP_DAY} 09:00`);

const HANAKO: Guest = { familyName: "Yamada", givenName: "Hanako", email: "hanako@example.jp", phone: "090-1234-5678" };
const RURI: Guest = { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.jp", phone: "０９０-８６８６-３５３５" };
const MINHO: Guest = { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929" };
const NA: Guest = { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000" };
const GUESTS = [HANAKO, RURI, MINHO, NA];

const PLAIN_TIERS: TierRow[] = [
  { min_days_before: 7, refund_percent: 100 },
  { min_days_before: 3, refund_percent: 50 },
  { min_days_before: 0, refund_percent: 0 },
];

const LATE_TIERS: TierRow[] = [
  { min_days_before: 14, refund_percent: 80 },
  { min_days_before: 2, refund_percent: 25 },
];

type ShopOptions = { config?: Record<string, string | number>; tiers?: TierRow[]; deposit?: number };

/** A published shop on a fresh database: 09:00 to 18:00, 30-minute slots and a 60-minute turnaround unless `config` says. */
async function withShop(run: (db: D1Database) => Promise<void>, options: ShopOptions = {}): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedType(db, { deposit_jpy: options.deposit ?? DEPOSIT_JPY });
    await seedConfig(db, options.config ?? {});
    await seedCatalogMeta(db);
    await seedTiers(db, options.tiers ?? PLAIN_TIERS);
    await run(db);
  } finally {
    await dispose();
  }
}

/** A package's length as seedPackage takes it: days, or hours alone. */
type Length = { days: number } | { hours: number };

/** A rate class with a package of each length priced for it; the first is `packageId`. Models share it to save writes. */
type Catalog = { rateClassId: string; packageId: string; packageOf(length: Length): string };

type Shop = Catalog & { modelId: string };

async function seedCatalog(db: D1Database, lengths: Length[] = [{ days: 1 }], priceJpy = 8000): Promise<Catalog> {
  const rateClassId = (await seedRateClass(db)).id;
  const packages: [string, string][] = [];
  for (const length of lengths) {
    const pkg = await seedPackage(db, length);
    await seedPrice(db, { rate_class_id: rateClassId, package_id: pkg.id, price_jpy: priceJpy });
    packages.push([JSON.stringify(length), pkg.id]);
  }
  const packageOf = (length: Length): string => {
    const found = packages.find(([key]) => key === JSON.stringify(length));
    assert.ok(found, `no package of ${JSON.stringify(length)} in this shop`);
    return found[1];
  };
  return { rateClassId, packageId: packages[0]?.[1] ?? "", packageOf };
}

/** A model with no vehicles yet on `catalog`'s rate class, of the default type unless `model` says. */
async function seedLine(db: D1Database, catalog: Catalog, model: Partial<ModelRow> = {}): Promise<Shop> {
  const created = await seedModel(db, { type_id: "motorcycle", ...model, rate_class_id: catalog.rateClassId });
  return { ...catalog, modelId: created.id };
}

/** A model with no vehicles yet, and a package of each length priced for its own rate class. */
async function seedShop(
  db: D1Database,
  lengths: Length[] = [{ days: 1 }],
  priceJpy = 8000,
  model: Partial<ModelRow> = {},
): Promise<Shop> {
  return seedLine(db, await seedCatalog(db, lengths, priceJpy), model);
}

/** Writes only the named config keys, leaving the rest as they stand. */
async function setConfig(db: D1Database, keys: Record<string, string | number>): Promise<void> {
  for (const [key, value] of Object.entries(keys)) {
    await db.prepare("UPDATE config SET value = ?2 WHERE key = ?1").bind(key, String(value)).run();
  }
}

async function seedFleet(db: D1Database, modelId: string, size: number): Promise<string[]> {
  const plates: string[] = [];
  for (let i = 0; i < size; i += 1) plates.push((await seedVehicle(db, { model_id: modelId })).plate);
  return plates;
}

let lastRequest = 0;

/** A valid staff request for the first slot of PICKUP_DAY, with a new id. */
function staffInput(shop: Pick<Shop, "modelId" | "packageId">, partial: Partial<StaffInput> = {}): StaffInput {
  lastRequest += 1;
  return {
    id: `staff-req-${lastRequest}-${randomUUID()}`,
    modelId: shop.modelId,
    packageId: shop.packageId,
    startAt: PICKUP,
    locale: "en",
    guest: HANAKO,
    requestedBy: REQUESTED_BY,
    ...partial,
  };
}

/** A web hold of the same shape, for createHold. */
function holdInput(shop: Pick<Shop, "modelId" | "packageId">, partial: Partial<HoldInput> = {}): HoldInput {
  return { id: `web-${randomUUID()}`, modelId: shop.modelId, packageId: shop.packageId, startAt: PICKUP, locale: "en", ...partial };
}

function booked(result: StaffResult, label: string): Booking {
  assert.ok(result.ok, `${label}: ${JSON.stringify(result)}`);
  return result.booking;
}

function reasonOf(result: { ok: true } | { ok: false; reason: string }): string {
  return result.ok ? "ok" : result.reason;
}

async function countBookings(db: D1Database, modelId?: string): Promise<number> {
  const sql = "SELECT COUNT(*) AS n FROM bookings";
  const statement = modelId === undefined ? db.prepare(sql) : db.prepare(`${sql} WHERE model_id = ?1`).bind(modelId);
  return (await statement.first<{ n: number }>())?.n ?? -1;
}

type OutboxRow = { kind: string; dedupe_key: string; payload: string; status: string };

async function outboxRows(db: D1Database): Promise<OutboxRow[]> {
  const sql = "SELECT kind, dedupe_key, payload, status FROM outbox ORDER BY dedupe_key";
  return (await db.prepare(sql).all<OutboxRow>()).results;
}

/** Every dedupe key in the outbox, sorted, so a test states the whole outbox. */
async function outboxKeys(db: D1Database): Promise<string[]> {
  return (await outboxRows(db)).map((row) => row.dedupe_key);
}

const GUEST_KEY = (id: string) => `email:guest_confirmation:${id}`;
const STAFF_KEY = (id: string) => `email:staff_new_booking:${id}`;
const SHEET_KEY = (id: string) => `sheet:${id}:CONFIRMED`;

/** The keys a staff booking with a guest email queues. */
function keysFor(id: string): string[] {
  return [GUEST_KEY(id), STAFF_KEY(id), SHEET_KEY(id)];
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

async function itemOf(db: D1Database, key: string): Promise<OutboxRow> {
  const found = (await outboxRows(db)).filter((row) => row.dedupe_key === key);
  assert.equal(found.length, 1, `outbox ${key}`);
  return found[0] as OutboxRow;
}

/** HMAC-SHA256 over 'cancel:' + id, base64url, cut to 32 characters, as the cancel link's ticket (#35) states it. */
function cancelUrlFor(locale: Locale, id: string): string {
  const token = createHmac("sha256", CANCEL_SECRET).update(`cancel:${id}`).digest("base64url").slice(0, 32);
  return `${SITE_URL}/${locale}/booking/cancel?b=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
}

/** Each named field of `actual` equals `expected`'s; other fields may be there too. */
function assertHas(actual: Record<string, unknown>, expected: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${label}: ${key}`);
}

const SCRIPT: Record<Locale, RegExp> = {
  ja: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u,
  en: /[A-Za-z]{3}/,
  "zh-cn": /\p{Script=Han}/u,
  ko: /\p{Script=Hangul}/u,
};

/** The summary of the published tiers, in the reader's language. A tier that pays nothing may be left to "after that". */
function assertPolicy(summary: unknown, tiers: TierRow[], locale: Locale, label: string): void {
  assert.equal(typeof summary, "string", `${label}: policySummary`);
  const text = summary as string;
  assert.match(text, SCRIPT[locale], `${label}: the policy is not in ${locale}: ${text}`);
  for (const tier of tiers.filter(({ refund_percent }) => refund_percent > 0)) {
    for (const number of [tier.min_days_before, tier.refund_percent]) {
      assert.match(text, new RegExp(`(?<!\\d)${number}(?!\\d)`), `${label}: no ${number} in the policy: ${text}`);
    }
  }
}

const MISSING_VALUE = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|\{\w+\}/;

/** renderEmail itself, which throws on a missing number and prints a missing string, so the mail can go out as queued. */
function assertRendersWhole(email: EmailPayload, label: string): void {
  const { subject, text, html } = renderEmail(email);
  for (const part of [subject, text, html]) assert.doesNotMatch(part, MISSING_VALUE, `${label}: a missing value\n${part}`);
}

const BOOKING_INSERT = /\binsert\b[^;]*?\binto\s+bookings\b/i;

/**
 * `db`, with `beforeInsert` run once just before the first statement that inserts into bookings goes out, alone or in a
 * batch. That is the moment a rival lands after every earlier read, which only a single conditional statement survives.
 * `raced` says the moment came, so a case cannot pass without it.
 */
function raceBeforeInsert(db: D1Database, beforeInsert: () => Promise<unknown>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const race = async () => {
    if (raced) return;
    raced = true;
    await beforeInsert();
  };
  /** A batch takes real statements only, so each stand-in keeps track of its own. */
  const realOf = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const watch = (statement: D1PreparedStatement): D1PreparedStatement => {
    const watched = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property === "bind") return (...args: unknown[]) => watch(value.apply(target, args));
        return async (...args: unknown[]) => {
          await race();
          return value.apply(target, args);
        };
      },
    });
    realOf.set(watched, statement);
    return watched;
  };
  const racing = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property === "prepare") {
        return (sql: string) => {
          const statement = value.call(target, sql);
          return BOOKING_INSERT.test(sql) ? watch(statement) : statement;
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[], ...rest: unknown[]) => {
          if (statements.some((statement) => realOf.has(statement))) await race();
          return value.call(target, statements.map((statement) => realOf.get(statement) ?? statement), ...rest);
        };
      }
      return value.bind(target);
    },
  });
  return { db: racing, raced: () => raced };
}

/**
 * `db`, where every write to the outbox fails as a missing table does and everything else goes through. A D1 batch is one
 * transaction, so whatever shares a batch with that write is undone with it. `wrote` says an outbox write was prepared.
 */
function failOutboxWrites(db: D1Database): { db: D1Database; wrote: () => boolean } {
  const intoOutbox = /(\bINTO\s+["`[]?)outbox\b/gi;
  let wrote = false;
  const failing = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property !== "prepare") return value.bind(target);
      return (sql: string) => {
        if (!sql.match(intoOutbox)) return value.call(target, sql);
        wrote = true;
        return value.call(target, sql.replace(intoOutbox, "$1outbox_unreachable"));
      };
    },
  });
  return { db: failing, wrote: () => wrote };
}

// ---------------------------------------------------------------------------------------------------------------------
// Assignment and the row.

type Bike = [plate: string, baseUsageDays: number, odometerKm: number | null, status?: string];

/**
 * Fleets with bookings already on them, and the order staff bookings for one pickup take the bikes in, worked out by hand
 * from the rule: least usage (base days plus CONFIRMED bookings, a day for 24 hours or less, else the JST dates touched),
 * then the lowest odometer with unknown last, then the lowest plate. Every fleet has a better bike of another model.
 */
const FLEETS: {
  label: string;
  type: { id: string; deposit: number };
  length: Length;
  priceJpy: number;
  pickup: string;
  back: string;
  locale: Locale;
  bikes: Bike[];
  bookings: Partial<BookingRow>[];
  order: string[];
}[] = [
  {
    label: "a day rental: usage, then odometer with unknown last; bikes off the road or busy are passed over",
    type: { id: "scooter", deposit: 3_000 },
    length: { days: 1 },
    priceJpy: 4_800,
    pickup: "2030-06-10 09:00",
    back: "2030-06-10 18:00",
    locale: "en",
    bikes: [
      ["A-3", 3, 500],
      ["A-1", 1, null],
      ["A-2", 1, 900],
      ["A-0m", 0, 10, "maintenance"],
      ["A-0r", 0, 10, "retired"],
      ["A-0busy", 0, 10],
    ],
    bookings: [{ vehicle_plate: "A-0busy", start_at: jst("2030-06-10 12:00"), end_at: jst("2030-06-10 15:00") }],
    order: ["A-2", "A-1", "A-3"],
  },
  {
    label: "a 4-hour rental: CONFIRMED bookings count, cancelled ones and holds do not; a live hold and a block are busy",
    type: { id: "motorcycle", deposit: 7_300 },
    length: { hours: 4 },
    priceJpy: 3_300,
    pickup: "2030-06-10 13:30",
    back: "2030-06-10 17:30",
    locale: "ja",
    bikes: [
      ["B-b", 2, 100],
      ["B-a", 2, 100],
      ["B-c", 0, 100],
      ["B-d", 1, 100],
      ["B-e", 0, 100],
      ["B-f", 0, 100],
      ["B-g", 0, 100],
    ],
    bookings: [
      // Three JST dates: three days of usage.
      { vehicle_plate: "B-c", start_at: jst("2030-07-01 09:00"), end_at: jst("2030-07-03 18:00") },
      {
        vehicle_plate: "B-d",
        status: "CANCELLED",
        start_at: jst("2030-07-05 09:00"),
        end_at: jst("2030-07-09 18:00"),
        cancelled_at: NOW - DAY_MS,
        cancel_reason: "guest",
      },
      // Back at 13:00, so the 60-minute turnaround runs to 14:00, past the 13:30 pickup.
      {
        vehicle_plate: "B-e",
        status: "ON_HOLD",
        start_at: jst("2030-06-10 09:00"),
        end_at: jst("2030-06-10 13:00"),
        expires_at: NOW + 2 * HOUR_MS,
      },
      {
        vehicle_plate: "B-f",
        status: "ON_HOLD",
        start_at: jst("2030-06-10 09:00"),
        end_at: jst("2030-06-10 13:00"),
        expires_at: NOW - 1,
      },
      // From 18:00: inside the turnaround after a 17:30 return.
      {
        vehicle_plate: "B-g",
        source: "block",
        external_ref: "ota-b-g",
        external_channel: "klook",
        start_at: jst("2030-06-10 18:00"),
        end_at: jst("2030-06-10 20:00"),
        price_jpy: null,
        deposit_jpy: null,
        locale: null,
      },
    ],
    order: ["B-f", "B-d", "B-a", "B-b", "B-c"],
  },
  {
    label: "a 3-day rental between two bookings, each exactly one turnaround away, which count as usage",
    type: { id: "motorcycle", deposit: 7_300 },
    length: { days: 3 },
    priceJpy: 21_000,
    pickup: "2030-06-12 10:30",
    back: "2030-06-14 18:00",
    locale: "zh-cn",
    bikes: [
      ["C-1", 0, 50],
      ["C-2", 0, 40],
    ],
    bookings: [
      // 24.5 hours over two JST dates, back an hour before the pickup: two days of usage.
      { vehicle_plate: "C-2", start_at: jst("2030-06-11 09:00"), end_at: jst("2030-06-12 09:30") },
      // One hour from 19:00, an hour after the return: one day of usage.
      { vehicle_plate: "C-1", start_at: jst("2030-06-14 19:00"), end_at: jst("2030-06-14 20:00") },
    ],
    order: ["C-1", "C-2"],
  },
];

test("a staff booking takes the least-used free bike and is confirmed without a payment", async () => {
  await withShop(async (db) => {
    const refs = new Set<string>();
    for (const fleet of FLEETS) {
      await seedType(db, { id: fleet.type.id, deposit_jpy: fleet.type.deposit });
      const shop = await seedShop(db, [fleet.length], fleet.priceJpy, { type_id: fleet.type.id });
      for (const [plate, base_usage_days, odometer_km, status = "active"] of fleet.bikes) {
        await seedVehicle(db, { plate, model_id: shop.modelId, base_usage_days, odometer_km, status });
      }
      const prefix = fleet.bikes[0]?.[0].slice(0, 1);
      await seedVehicle(db, { plate: `${prefix}-other-model`, base_usage_days: 0, odometer_km: 0 });
      for (const booking of fleet.bookings) await seedBooking(db, { model_id: shop.modelId, ...booking });
      const before = await countBookings(db, shop.modelId);

      for (const [n, plate] of fleet.order.entries()) {
        const label = `${fleet.label}, booking ${n + 1}`;
        const guest = GUESTS[n % GUESTS.length] as Guest;
        const at = NOW + n * MINUTE_MS;
        const input = staffInput(shop, { startAt: jst(fleet.pickup), locale: fleet.locale, guest });
        const booking = booked(await createStaffBooking(db, input, at, CTX), label);

        assert.equal(typeof booking.ref, "string", `${label}: the ref`);
        assert.ok(booking.ref.length > 0 && !refs.has(booking.ref), `${label}: the ref ${booking.ref} is not its own`);
        refs.add(booking.ref);
        const expected: Booking = {
          id: input.id,
          ref: booking.ref,
          status: "CONFIRMED",
          source: "staff",
          modelId: shop.modelId,
          packageId: shop.packageId,
          vehiclePlate: plate,
          startAt: jst(fleet.pickup),
          endAt: jst(fleet.back),
          expiresAt: null,
          priceJpy: fleet.priceJpy,
          depositJpy: fleet.type.deposit,
          catalogVersion: booking.catalogVersion,
          locale: fleet.locale,
          guestFamilyName: guest.familyName,
          guestGivenName: guest.givenName,
          guestEmail: guest.email,
          guestPhone: guest.phone,
          externalRef: null,
          externalChannel: null,
          contentHash: booking.contentHash,
          paymentId: null,
          paymentAttempt: 0,
          paidJpy: 0,
          cancelReason: null,
          createdAt: at,
          updatedAt: at,
          confirmedAt: at,
          cancelledAt: null,
        };
        assert.deepEqual(booking, expected, label);
        // The stored row, read back by existing code, not the answer the call built.
        assert.deepEqual(await getBooking(db, input.id), expected, `${label}: the stored row`);
      }

      const late = staffInput(shop, { startAt: jst(fleet.pickup), locale: fleet.locale });
      assert.equal(reasonOf(await createStaffBooking(db, late, NOW + HOUR_MS, CTX)), "SOLD_OUT", fleet.label);
      assert.equal(await getBooking(db, late.id), null, `${fleet.label}: a sold-out request stores nothing`);
      assert.equal(await countBookings(db, shop.modelId), before + fleet.order.length, fleet.label);
    }

    // A staff booking is a CONFIRMED booking, so its day counts against its bike when the next rental is assigned.
    const shop = await seedShop(db);
    await seedVehicle(db, { plate: "D-1", model_id: shop.modelId, odometer_km: 100 });
    await seedVehicle(db, { plate: "D-2", model_id: shop.modelId, odometer_km: 200 });
    const staff = booked(await createStaffBooking(db, staffInput(shop), NOW, CTX), "the usage case");
    assert.equal(staff.vehiclePlate, "D-1");
    const later = await createHold(db, holdInput(shop, { startAt: jst("2030-06-20 09:00") }), NOW);
    assert.ok(later.ok, JSON.stringify(later));
    assert.equal(later.booking.vehiclePlate, "D-2", "the staff booking's day counts as usage of D-1");
  });
});

/** Concurrent calls that each overlap every other with the 60-minute turnaround. Call n starts at startAt(n). */
const CROWDS: { fleetSize: number; calls: number; label: string; length: Length; startAt: (call: number) => number }[] = [
  { fleetSize: 1, calls: 2, label: "one pickup time", length: { days: 1 }, startAt: () => PICKUP },
  // 09:00 to 12:00: each start is under four hours from every other.
  {
    fleetSize: 2,
    calls: 5,
    label: "4-hour rentals from seven slots",
    length: { hours: 4 },
    startAt: (call) => PICKUP + (call % 7) * 30 * MINUTE_MS,
  },
  {
    fleetSize: 3,
    calls: 7,
    label: "day rentals from every slot of one day",
    length: { days: 1 },
    startAt: (call) => PICKUP + (call % 18) * 30 * MINUTE_MS,
  },
];

test("two staff bookings for the last bike give it to one and SOLD_OUT to the other", async () => {
  await withShop(async (db) => {
    const catalog = await seedCatalog(db, [{ days: 1 }, { hours: 4 }]);
    // A free bike of another model, which none of these may take.
    await seedFleet(db, (await seedLine(db, catalog)).modelId, 1);
    for (const { fleetSize, calls: callCount, label, length, startAt } of CROWDS) {
      const caseLabel = `${fleetSize} bikes, ${callCount} calls, ${label}`;
      const shop = await seedLine(db, catalog);
      const fleet = await seedFleet(db, shop.modelId, fleetSize);
      const calls = Array.from({ length: callCount }, (_, call) =>
        staffInput(shop, {
          packageId: shop.packageOf(length),
          startAt: startAt(call),
          guest: GUESTS[call % GUESTS.length] as Guest,
        }),
      );
      const results = await Promise.all(calls.map((input) => createStaffBooking(db, input, NOW, CTX)));

      const plates: string[] = [];
      const winners: string[] = [];
      results.forEach((result, call) => {
        if (!result.ok) return assert.equal(reasonOf(result), "SOLD_OUT", `${caseLabel}: call ${call}`);
        plates.push(result.booking.vehiclePlate);
        winners.push(calls[call]?.id ?? "");
      });
      assert.deepEqual(sorted(plates), sorted(fleet), caseLabel);
      assert.equal(await countBookings(db, shop.modelId), fleetSize, caseLabel);
      const queued = (await outboxKeys(db)).filter((key) => calls.some((input) => key.includes(input.id)));
      assert.deepEqual(sorted(queued), sorted(winners.flatMap(keysFor)), `${caseLabel}: the winners' items only`);
    }

    // A rival lands after every check and just before the insert: only the statement that takes the bike can see it.
    const rivals: [string, (shop: Shop) => Promise<{ ok: boolean }>][] = [
      ["another staff booking", (shop) => createStaffBooking(db, staffInput(shop, { guest: RURI }), NOW, CTX)],
      ["a web hold", (shop) => createHold(db, holdInput(shop), NOW)],
    ];
    for (const [label, rival] of rivals) {
      const shop = await seedLine(db, catalog);
      await seedFleet(db, shop.modelId, 1);
      const rivalOk: boolean[] = [];
      const race = raceBeforeInsert(db, async () => {
        rivalOk.push((await rival(shop)).ok);
      });
      const input = staffInput(shop);
      const result = await createStaffBooking(race.db, input, NOW, CTX);
      assert.ok(race.raced(), `${label}: no statement inserted into bookings`);
      assert.deepEqual(rivalOk, [true], `${label}: the rival took the bike`);
      assert.equal(reasonOf(result), "SOLD_OUT", label);
      assert.equal(await getBooking(db, input.id), null, label);
      assert.equal(await countBookings(db, shop.modelId), 1, label);
      assert.deepEqual(
        (await outboxKeys(db)).filter((key) => key.includes(input.id)),
        [],
        `${label}: the loser queues nothing`,
      );
    }

    // With two bikes, the rival takes the better one just before the insert, and the booking gets the other.
    const shop = await seedLine(db, catalog);
    await seedVehicle(db, { plate: "R-1", model_id: shop.modelId, base_usage_days: 0 });
    await seedVehicle(db, { plate: "R-2", model_id: shop.modelId, base_usage_days: 5 });
    const race = raceBeforeInsert(db, () => createStaffBooking(db, staffInput(shop, { guest: NA }), NOW, CTX));
    const second = booked(await createStaffBooking(race.db, staffInput(shop), NOW, CTX), "the second of two bikes");
    assert.ok(race.raced(), "no statement inserted into bookings");
    assert.equal(second.vehiclePlate, "R-2");

    // A staff booking and a web hold at once for the last bike: one of them gets it.
    for (const staffFirst of [true, false]) {
      const last = await seedLine(db, catalog);
      await seedFleet(db, last.modelId, 1);
      const staffCall = () => createStaffBooking(db, staffInput(last), NOW, CTX);
      const webCall = () => createHold(db, holdInput(last), NOW);
      const results = await Promise.all(staffFirst ? [staffCall(), webCall()] : [webCall(), staffCall()]);
      assert.deepEqual(sorted(results.map(reasonOf)), ["SOLD_OUT", "ok"], `staff first: ${staffFirst}`);
      assert.equal(await countBookings(db, last.modelId), 1, `staff first: ${staffFirst}`);
    }
  });
});

/** Two bookings on the only bike, on PICKUP_DAY: `first` made first, the other second. Grouped by turnaround. */
const TURNAROUND_CASES: {
  turnaround: number;
  first: "staff" | "web";
  firstAt: [Length, string];
  secondAt: [Length, string];
  free: boolean;
}[] = [
  // A staff booking first: 4 hours from 09:00 is back at 13:00.
  { turnaround: 0, first: "staff", firstAt: [{ hours: 4 }, "09:00"], secondAt: [{ hours: 4 }, "12:30"], free: false },
  { turnaround: 0, first: "staff", firstAt: [{ hours: 4 }, "09:00"], secondAt: [{ hours: 4 }, "13:00"], free: true },
  // A live web hold first: the staff booking keeps the same distance from it, before and after.
  { turnaround: 0, first: "web", firstAt: [{ hours: 4 }, "14:00"], secondAt: [{ hours: 4 }, "10:30"], free: false },
  { turnaround: 0, first: "web", firstAt: [{ hours: 4 }, "14:00"], secondAt: [{ hours: 4 }, "10:00"], free: true },
  { turnaround: 60, first: "staff", firstAt: [{ hours: 4 }, "09:00"], secondAt: [{ hours: 4 }, "13:30"], free: false },
  { turnaround: 60, first: "staff", firstAt: [{ hours: 4 }, "09:00"], secondAt: [{ hours: 4 }, "14:00"], free: true },
  // A web hold before the staff booking's pickup has to be back a turnaround ahead of it.
  { turnaround: 60, first: "staff", firstAt: [{ days: 1 }, "14:00"], secondAt: [{ hours: 4 }, "09:30"], free: false },
  { turnaround: 60, first: "staff", firstAt: [{ days: 1 }, "14:00"], secondAt: [{ hours: 4 }, "09:00"], free: true },
  { turnaround: 60, first: "staff", firstAt: [{ days: 1 }, "09:00"], secondAt: [{ days: 1 }, "17:30"], free: false },
  { turnaround: 60, first: "web", firstAt: [{ hours: 4 }, "14:00"], secondAt: [{ hours: 4 }, "09:30"], free: false },
  { turnaround: 60, first: "web", firstAt: [{ hours: 4 }, "14:00"], secondAt: [{ hours: 4 }, "09:00"], free: true },
  { turnaround: 60, first: "web", firstAt: [{ hours: 4 }, "09:00"], secondAt: [{ hours: 4 }, "13:30"], free: false },
  { turnaround: 60, first: "web", firstAt: [{ hours: 4 }, "09:00"], secondAt: [{ hours: 4 }, "14:00"], free: true },
];

test("a staff booking blocks web holds on that bike, turnaround included", async () => {
  await withShop(async (db) => {
    const catalog = await seedCatalog(db, [{ days: 1 }, { hours: 4 }]);
    let configured = -1;
    for (const { turnaround, first, firstAt, secondAt, free } of TURNAROUND_CASES) {
      const label = `${turnaround} minutes, ${first} ${JSON.stringify(firstAt)} first, then ${JSON.stringify(secondAt)}`;
      if (turnaround !== configured) await setConfig(db, { turnaround_minutes: turnaround });
      configured = turnaround;
      const shop = await seedLine(db, catalog);
      const [plate] = await seedFleet(db, shop.modelId, 1);
      const make = (who: "staff" | "web", [length, clock]: [Length, string]) => {
        const at = { packageId: shop.packageOf(length), startAt: jst(`${PICKUP_DAY} ${clock}`) };
        return who === "staff"
          ? createStaffBooking(db, staffInput(shop, at), NOW, CTX)
          : createHold(db, holdInput(shop, at), NOW);
      };

      const made = await make(first, firstAt);
      assert.ok(made.ok, `${label}: the first booking: ${JSON.stringify(made)}`);
      assert.equal(made.booking.vehiclePlate, plate, label);
      const second = await make(first === "staff" ? "web" : "staff", secondAt);
      if (free) {
        assert.ok(second.ok, `${label}: ${JSON.stringify(second)}`);
        assert.equal(second.booking.vehiclePlate, plate, label);
      } else {
        assert.equal(reasonOf(second), "SOLD_OUT", label);
      }
    }
    await setConfig(db, { turnaround_minutes: 60 });

    // A hold blocks until the instant it expires, and from then on the staff booking takes the bike.
    const lapsing = await seedLine(db, catalog);
    const [lapsingPlate] = await seedFleet(db, lapsing.modelId, 1);
    assert.ok((await createHold(db, holdInput(lapsing), NOW)).ok);
    const expiresAt = NOW + 15 * MINUTE_MS;
    assert.equal(reasonOf(await createStaffBooking(db, staffInput(lapsing), expiresAt - 1, CTX)), "SOLD_OUT");
    const reclaimed = booked(await createStaffBooking(db, staffInput(lapsing), expiresAt, CTX), "after the hold expired");
    assert.equal(reclaimed.vehiclePlate, lapsingPlate);

    // A payment in flight keeps its bike, whatever its expiry says.
    const paying = await seedLine(db, catalog);
    const [payingPlate] = await seedFleet(db, paying.modelId, 1);
    await seedBooking(db, {
      vehicle_plate: payingPlate,
      status: "PAYMENT_PENDING",
      start_at: PICKUP,
      end_at: jst(`${PICKUP_DAY} 18:00`),
      expires_at: NOW - HOUR_MS,
      payment_attempt: 1,
    });
    assert.equal(reasonOf(await createStaffBooking(db, staffInput(paying), NOW, CTX)), "SOLD_OUT", "a payment in flight");

    // A staff booking has no expiry: days later a web hold still finds its bike taken.
    const kept = await seedLine(db, catalog);
    await seedFleet(db, kept.modelId, 1);
    booked(await createStaffBooking(db, staffInput(kept), NOW, CTX), "the kept booking");
    assert.equal(reasonOf(await createHold(db, holdInput(kept), NOW + 5 * DAY_MS)), "SOLD_OUT", "five days later");

    // A Blocks row that names the bike stays off it inside the turnaround, and goes on it just outside.
    const blocked = await seedLine(db, catalog);
    const fourHours = { packageId: blocked.packageOf({ hours: 4 }) };
    await seedVehicle(db, { plate: "BLK-X", model_id: blocked.modelId });
    await seedVehicle(db, { plate: "BLK-Y", model_id: blocked.modelId, base_usage_days: 9 });
    const onX = booked(await createStaffBooking(db, staffInput(blocked, fourHours), NOW, CTX), "the booking on BLK-X");
    const onY = booked(await createStaffBooking(db, staffInput(blocked, fourHours), NOW, CTX), "the booking on BLK-Y");
    assert.deepEqual([onX.vehiclePlate, onY.vehiclePlate], ["BLK-X", "BLK-Y"]);
    const blockOf = (blockId: string, plate: string, from: string): ValidBlock => ({
      blockId,
      modelId: blocked.modelId,
      plate,
      startAt: jst(`${PICKUP_DAY} ${from}`),
      endAt: jst(`${PICKUP_DAY} 16:00`),
      channel: "klook",
      reference: `ref-${blockId}`,
      note: "",
    });
    // Both bookings are back at 13:00, so the turnaround runs to 14:00.
    await syncBlocks(db, [blockOf("blk-inside", "BLK-X", "13:30"), blockOf("blk-outside", "BLK-Y", "14:00")], NOW);
    const blockRow = (externalRef: string) =>
      db
        .prepare("SELECT vehicle_plate, status FROM bookings WHERE source = 'block' AND external_ref = ?1")
        .bind(externalRef)
        .first<{ vehicle_plate: string; status: string }>();
    const inside = await blockRow("blk-inside");
    assert.ok(inside === null || inside.status !== "CONFIRMED", `a block inside the turnaround: ${JSON.stringify(inside)}`);
    assert.deepEqual(await blockRow("blk-outside"), { vehicle_plate: "BLK-Y", status: "CONFIRMED" });
    assert.deepEqual(await getBooking(db, onX.id), onX, "the staff booking stays as it was");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The price.

/** Open from 08:00, with no lead time, so a web hold can be made at each moment below to compare with. */
const ADVANCE_SHOP = { shop_open: "08:00", shop_close: "18:00", min_lead_hours: 0 };

/** [days, price_jpy, advance_price_jpy] per type. One row has no advance price. */
const ADVANCE_FEES: { type: string; deposit: number; rows: [number, number, number | null][] }[] = [
  {
    type: "scooter",
    deposit: 1_500,
    rows: [
      [1, 4_500, 4_000],
      [3, 10_000, null],
    ],
  },
  { type: "motorcycle", deposit: 10_000, rows: [[3, 13_800, 12_900]] },
];

type AdvanceRow = { label: string; shop: Shop; priceJpy: number; advancePriceJpy: number | null; depositJpy: number };

async function seedAdvanceShop(db: D1Database): Promise<AdvanceRow[]> {
  const rows: AdvanceRow[] = [];
  for (const { type, deposit, rows: fees } of ADVANCE_FEES) {
    await seedType(db, { id: type, deposit_jpy: deposit });
    const rateClass = await seedRateClass(db);
    const model = await seedModel(db, { type_id: type, rate_class_id: rateClass.id });
    // Each moment below has a pickup date of its own, so a moment's staff bookings and web holds are all that overlap.
    await seedFleet(db, model.id, 5);
    for (const [days, price_jpy, advance_price_jpy] of fees) {
      const pkg = await seedPackage(db, { days });
      await seedPrice(db, { rate_class_id: rateClass.id, package_id: pkg.id, price_jpy, advance_price_jpy });
      const shop: Shop = {
        modelId: model.id,
        rateClassId: rateClass.id,
        packageId: pkg.id,
        packageOf: () => pkg.id,
      };
      rows.push({ label: `${type}, ${days} days`, shop, priceJpy: price_jpy, advancePriceJpy: advance_price_jpy, depositJpy: deposit });
    }
  }
  return rows;
}

/** Each moment's JST date set against the pickup's by hand. `web` says whether a web hold may be made then too. */
const PRICE_MOMENTS: { label: string; now: string; pickup: string; ahead: boolean; web: boolean }[] = [
  { label: "nine days ahead", now: "2030-06-01 12:00", pickup: "2030-06-10 09:00", ahead: true, web: true },
  // 10:00 JST on the 14th is 01:00 UTC on the 14th, and 08:00 JST on the 15th is 23:00 UTC on the 14th: one UTC date.
  {
    label: "the day before in JST, the same date in UTC",
    now: "2030-06-14 10:00",
    pickup: "2030-06-15 08:00",
    ahead: true,
    web: true,
  },
  // 08:30 JST on the 20th is 23:30 UTC on the 19th, and the 09:00 pickup is 00:00 UTC on the 20th: a UTC date says ahead.
  { label: "at 08:30 JST, the day before in UTC", now: "2030-06-20 08:30", pickup: "2030-06-20 09:00", ahead: false, web: true },
  // Only a staff booking can be made inside the slot it picks up in.
  { label: "inside the pickup's own slot", now: "2030-06-25 09:10", pickup: "2030-06-25 09:00", ahead: false, web: false },
];

test("the price is the one a web hold would lock, advance price included", async () => {
  await withShop(
    async (db) => {
      const rows = await seedAdvanceShop(db);
      for (const moment of PRICE_MOMENTS) {
        for (const row of rows) {
          const label = `${row.label}, ${moment.label}`;
          const now = jst(moment.now);
          const startAt = jst(moment.pickup);
          const booking = booked(await createStaffBooking(db, staffInput(row.shop, { startAt }), now, CTX), label);
          const expected = moment.ahead ? (row.advancePriceJpy ?? row.priceJpy) : row.priceJpy;
          assert.equal(booking.priceJpy, expected, label);
          assert.equal(booking.depositJpy, row.depositJpy, `${label}: the deposit follows the type, not the price`);
          const stored = await db
            .prepare("SELECT price_jpy, deposit_jpy FROM bookings WHERE id = ?1")
            .bind(booking.id)
            .first<{ price_jpy: number; deposit_jpy: number }>();
          assert.deepEqual(stored, { price_jpy: expected, deposit_jpy: row.depositJpy }, `${label}: the stored row`);

          if (!moment.web) continue;
          const web = await createHold(db, holdInput(row.shop, { startAt }), now);
          assert.ok(web.ok, `${label}: the web hold: ${JSON.stringify(web)}`);
          assert.equal(booking.priceJpy, web.booking.priceJpy, `${label}: what a web hold locks`);
          assert.equal(booking.depositJpy, web.booking.depositJpy, `${label}: what a web hold locks`);
        }
      }

      // A publish lands after every check and just before the insert: the booking takes the catalog as it stands then.
      const [oneDay] = rows as [AdvanceRow];
      const restore = () =>
        db.batch([
          db.prepare("UPDATE prices SET price_jpy = 4500, advance_price_jpy = 4000 WHERE package_id = ?1").bind(oneDay.shop.packageId),
          db.prepare("UPDATE vehicle_types SET deposit_jpy = 1500 WHERE id = 'scooter'"),
        ]);
      const publishes: [string, string, unknown[], { priceJpy: number; depositJpy: number }][] = [
        [
          "the advance price lowered",
          "UPDATE prices SET advance_price_jpy = ?1 WHERE package_id = ?2",
          [3_800, oneDay.shop.packageId],
          { priceJpy: 3_800, depositJpy: 1_500 },
        ],
        [
          "the advance price cleared",
          "UPDATE prices SET advance_price_jpy = NULL WHERE package_id = ?1",
          [oneDay.shop.packageId],
          { priceJpy: 4_500, depositJpy: 1_500 },
        ],
        [
          "the deposit raised",
          "UPDATE vehicle_types SET deposit_jpy = ?1 WHERE id = 'scooter'",
          [2_000],
          { priceJpy: 4_000, depositJpy: 2_000 },
        ],
      ];
      for (const [label, sql, params, expected] of publishes) {
        await restore();
        const publish = raceBeforeInsert(db, () => db.prepare(sql).bind(...params).run());
        const input = staffInput(oneDay.shop, { startAt: jst("2030-07-20 09:00") });
        const booking = booked(await createStaffBooking(publish.db, input, jst("2030-07-01 12:00"), CTX), label);
        assert.ok(publish.raced(), `${label}: no statement inserted into bookings`);
        assert.deepEqual({ priceJpy: booking.priceJpy, depositJpy: booking.depositJpy }, expected, label);
      }
    },
    { config: ADVANCE_SHOP },
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// The outbox.

type Stay = {
  modelNames: Record<Locale, string>;
  packageNames: Record<Locale, string>;
  length: Length;
  priceJpy: number;
  pickup: string;
  /** The return, by the shop's closing time. */
  back: (close: string) => string;
};

const FIRST_STAY: Stay = {
  modelNames: { ja: "沖縄カブ 110", en: "Okinawa Cub 110", "zh-cn": "冲绳小狼 110", ko: "오키나와 커브 110" },
  packageNames: { ja: "三日間ツーリング", en: "Three day ride", "zh-cn": "三日骑行", ko: "사흘 라이드" },
  length: { days: 3 },
  priceJpy: 18_700,
  pickup: "2030-06-15 10:30",
  back: (close) => `2030-06-17 ${close}`,
};

const SECOND_STAY: Stay = {
  modelNames: { ja: "琉球フォルツァ 250", en: "Ryukyu Forza 250", "zh-cn": "琉球佛沙 250", ko: "류큐 포르자 250" },
  packageNames: { ja: "四時間コース", en: "Four hour ride", "zh-cn": "四小时骑行", ko: "네 시간 라이드" },
  length: { hours: 4 },
  priceJpy: 6_250,
  pickup: "2030-06-20 14:00",
  back: () => "2030-06-20 18:00",
};

/** Two shops, whose hours, deposit and tiers differ, with two of the four locales each. */
const OUTBOX_SHOPS: { open: string; close: string; deposit: number; tiers: TierRow[]; locales: Locale[] }[] = [
  { open: "09:00", close: "18:00", deposit: 7_300, tiers: PLAIN_TIERS, locales: ["ja", "en"] },
  { open: "10:30", close: "19:15", deposit: 12_500, tiers: LATE_TIERS, locales: ["zh-cn", "ko"] },
];

function textsOf(names: Record<Locale, string>, more: Record<string, string> = {}): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, { name: names[locale], ...more }])));
}

async function publishStay(db: D1Database, stay: Stay): Promise<Shop> {
  const rate = await seedRateClass(db);
  const model = await seedModel(db, {
    rate_class_id: rate.id,
    texts: textsOf(stay.modelNames, { summary: "A summary", description: "A description" }),
  });
  const pkg = await seedPackage(db, { ...stay.length, texts: textsOf(stay.packageNames) });
  await seedPrice(db, { rate_class_id: rate.id, package_id: pkg.id, price_jpy: stay.priceJpy });
  await seedFleet(db, model.id, 4);
  return { modelId: model.id, rateClassId: rate.id, packageId: pkg.id, packageOf: () => pkg.id };
}

test("the confirmation, staff email and Bookings row are queued once with the paid-at-shop facts and a cancel link", async () => {
  for (const [shopIndex, settings] of OUTBOX_SHOPS.entries()) {
    await withShop(
      async (db) => {
        const stays: [Stay, Shop][] = [
          [FIRST_STAY, await publishStay(db, FIRST_STAY)],
          [SECOND_STAY, await publishStay(db, SECOND_STAY)],
        ];
        const ids: string[] = [];
        for (const [n, locale] of settings.locales.entries()) {
          const [stay, shop] = stays[n % 2] as [Stay, Shop];
          const guest = GUESTS[(2 * shopIndex + n) % GUESTS.length] as Guest;
          const label = `${settings.open}-${settings.close}, ${locale}`;
          const at = NOW + n * MINUTE_MS;
          const input = staffInput(shop, { startAt: jst(stay.pickup), locale, guest });
          const booking = booked(await createStaffBooking(db, input, at, CTX), label);
          ids.push(input.id);

          const rows = (await outboxRows(db)).filter((row) => keysFor(input.id).includes(row.dedupe_key));
          assert.deepEqual(sorted(rows.map((row) => row.dedupe_key)), sorted(keysFor(input.id)), label);
          for (const row of rows) assert.equal(row.status, "pending", `${label}: ${row.dedupe_key}`);

          const facts = {
            ref: booking.ref,
            startAt: jst(stay.pickup),
            endAt: jst(stay.back(settings.close)),
            priceJpy: stay.priceJpy,
            paidJpy: 0,
          };

          const guestItem = await itemOf(db, GUEST_KEY(input.id));
          assert.equal(guestItem.kind, "email", label);
          const guestEmail = JSON.parse(guestItem.payload) as EmailPayload;
          assertHas(guestEmail, { template: "guest_confirmation", to: guest.email, locale }, `${label}: guest_confirmation`);
          assertHas(
            guestEmail.data,
            {
              ...facts,
              paidAtShop: true,
              depositJpy: settings.deposit,
              modelName: stay.modelNames[locale],
              packageName: stay.packageNames[locale],
              shopOpen: settings.open,
              shopClose: settings.close,
              guest: { familyName: guest.familyName, givenName: guest.givenName },
              cancelUrl: cancelUrlFor(locale, input.id),
            },
            `${label}: guest_confirmation data`,
          );
          assertPolicy(guestEmail.data.policySummary, settings.tiers, locale, `${label}: guest_confirmation`);
          assertRendersWhole(guestEmail, `${label}: guest_confirmation`);

          const staffItem = await itemOf(db, STAFF_KEY(input.id));
          assert.equal(staffItem.kind, "email", label);
          const staffEmail = JSON.parse(staffItem.payload) as EmailPayload;
          assertHas(staffEmail, { template: "staff_new_booking", to: STAFF_EMAIL, locale: "ja" }, `${label}: staff_new_booking`);
          assertHas(
            staffEmail.data,
            {
              ...facts,
              modelNameJa: stay.modelNames.ja,
              packageNameJa: stay.packageNames.ja,
              vehiclePlate: booking.vehiclePlate,
              guest: { familyName: guest.familyName, givenName: guest.givenName, email: guest.email, phone: guest.phone },
            },
            `${label}: staff_new_booking data`,
          );
          assertRendersWhole(staffEmail, `${label}: staff_new_booking`);

          const sheetItem = await itemOf(db, SHEET_KEY(input.id));
          assert.equal(sheetItem.kind, "sheet_booking", label);
          assert.deepEqual(JSON.parse(sheetItem.payload), { bookingId: input.id }, label);
        }
        assert.deepEqual(await outboxKeys(db), sorted(ids.flatMap(keysFor)), "nothing else is queued");
        if (shopIndex > 0) return;

        // One batch: an outbox that cannot be written leaves no booking behind, and the same request books later.
        const [, shop] = stays[0] as [Stay, Shop];
        const lone = await seedShop(db);
        await seedFleet(db, lone.modelId, 1);
        const input = staffInput(lone, { guest: MINHO, locale: "ko", startAt: jst(`${PICKUP_DAY} 11:00`) });
        const failing = failOutboxWrites(db);
        let answer: StaffResult | "rejected";
        try {
          answer = await createStaffBooking(failing.db, input, NOW, CTX);
        } catch {
          answer = "rejected";
        }
        assert.ok(failing.wrote(), "no outbox write was prepared");
        assert.ok(answer === "rejected" || !answer.ok, `an unwritable outbox still booked: ${JSON.stringify(answer)}`);
        assert.equal(await getBooking(db, input.id), null, "a booking without its emails");
        assert.equal(await countBookings(db, lone.modelId), 0);
        assert.deepEqual(await outboxKeys(db), sorted(ids.flatMap(keysFor)), "the failed batch queued nothing");
        booked(await createStaffBooking(db, input, NOW, CTX), "the same request once the outbox is back");
        ids.push(input.id);
        assert.deepEqual(await outboxKeys(db), sorted(ids.flatMap(keysFor)));

        // Another booking lands under the same id just before the insert: it was not this call's row, so nothing is queued.
        const rivals: [string, (id: string) => Promise<unknown>, boolean][] = [
          ["a web hold", (id) => createHold(db, holdInput(shop, { id, startAt: jst(FIRST_STAY.pickup) }), NOW), false],
          [
            "a staff booking of another guest",
            (id) => createStaffBooking(db, staffInput(shop, { id, startAt: jst(FIRST_STAY.pickup), guest: NA }), NOW, CTX),
            true,
          ],
        ];
        for (const [label, rival, rivalQueues] of rivals) {
          const raced = staffInput(shop, { startAt: jst(FIRST_STAY.pickup), guest: RURI });
          const race = raceBeforeInsert(db, () => rival(raced.id));
          const result = await createStaffBooking(race.db, raced, NOW, CTX);
          assert.ok(race.raced(), `${label}: no statement inserted into bookings`);
          assert.equal(reasonOf(result), "CONFLICT", label);
          if (rivalQueues) {
            ids.push(raced.id);
            // The rival's own items, with the rival's guest, and nothing of this call's.
            const guestEmail = JSON.parse((await itemOf(db, GUEST_KEY(raced.id))).payload) as EmailPayload;
            assert.equal(guestEmail.to, NA.email, label);
          }
          assert.deepEqual(await outboxKeys(db), sorted(ids.flatMap(keysFor)), `${label}: the outbox`);
        }
      },
      { config: { shop_open: settings.open, shop_close: settings.close }, tiers: settings.tiers, deposit: settings.deposit },
    );
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Idempotency.

test("a replay with the same id answers the booking and queues nothing new, and another request under that id is CONFLICT", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db, [{ days: 1 }, { days: 2 }]);
    await seedFleet(db, shop.modelId, 2);
    const input = staffInput(shop, { guest: RURI, locale: "ja" });
    const first = booked(await createStaffBooking(db, input, NOW, CTX), "the first call");
    const queued = await outboxRows(db);
    assert.deepEqual(
      queued.map((row) => row.dedupe_key),
      sorted(keysFor(input.id)),
    );

    // A replay is answered from the booking, not from the window, the clock or the catalog.
    const replays: [string, number][] = [
      ["at once", NOW],
      ["inside the pickup's own slot", PICKUP + 10 * MINUTE_MS],
      ["after the pickup", PICKUP + 2 * DAY_MS],
      ["past the horizon", NOW + 400 * DAY_MS],
    ];
    for (const [label, now] of replays) {
      assert.deepEqual(await createStaffBooking(db, input, now, CTX), { ok: true, booking: first }, label);
    }
    await db.prepare("UPDATE prices SET price_jpy = price_jpy + 900 WHERE package_id = ?1").bind(shop.packageId).run();
    assert.deepEqual(await createStaffBooking(db, input, NOW, CTX), { ok: true, booking: first }, "after a new price");
    assert.equal(await countBookings(db), 1);
    assert.deepEqual(await outboxRows(db), queued, "a replay queues nothing new");

    // Each input on its own, changed to one that would be valid on a new id.
    const otherModel = await seedModel(db);
    await seedPrice(db, { rate_class_id: otherModel.rate_class_id, package_id: shop.packageId });
    await seedFleet(db, otherModel.id, 1);
    const changes: [string, Partial<StaffInput>][] = [
      ["the model", { modelId: otherModel.id }],
      ["the package", { packageId: shop.packageOf({ days: 2 }) }],
      ["the pickup slot", { startAt: PICKUP + 30 * MINUTE_MS }],
      ["the pickup day", { startAt: PICKUP + DAY_MS }],
      ["the locale", { locale: "en" }],
      ["the family name", { guest: { ...RURI, familyName: "Yamada" } }],
      ["the given name", { guest: { ...RURI, givenName: "Hanako" } }],
      ["the email", { guest: { ...RURI, email: "someone.else@example.jp" } }],
      ["the email left blank", { guest: { ...RURI, email: "" } }],
      ["the phone", { guest: { ...RURI, phone: "090-0000-1111" } }],
      // Not valid on a new id, and the id is what answers here.
      ["a model that does not exist", { modelId: "no-such-model" }],
    ];
    for (const [label, change] of changes) {
      assert.equal(reasonOf(await createStaffBooking(db, { ...input, ...change }, NOW, CTX)), "CONFLICT", label);
      assert.deepEqual(await getBooking(db, input.id), first, label);
    }
    assert.equal(await countBookings(db), 1);
    assert.deepEqual(await outboxRows(db), queued, "a conflict queues nothing");

    // An id a web booking already has is that booking's, even when its model, package, pickup, locale and guest are the
    // very ones asked for: it was paid online, so it is no staff booking to answer with.
    const hold = await createHold(db, holdInput(shop, { startAt: PICKUP + DAY_MS }), NOW);
    assert.ok(hold.ok, JSON.stringify(hold));
    await db
      .prepare(
        `UPDATE bookings SET status = 'CONFIRMED', guest_family_name = ?2, guest_given_name = ?3, guest_email = ?4,
          guest_phone = ?5, payment_id = ?6, paid_jpy = deposit_jpy, confirmed_at = ?7, updated_at = ?7 WHERE id = ?1`,
      )
      .bind(hold.booking.id, RURI.familyName, RURI.givenName, RURI.email, RURI.phone, `sq-${randomUUID()}`, NOW)
      .run();
    const paid = await getBooking(db, hold.booking.id);
    const sameAsWeb = staffInput(shop, { id: hold.booking.id, startAt: PICKUP + DAY_MS, locale: "en", guest: RURI });
    assert.equal(reasonOf(await createStaffBooking(db, sameAsWeb, NOW, CTX)), "CONFLICT", "a web booking's id");
    assert.deepEqual(await getBooking(db, hold.booking.id), paid);
    assert.deepEqual(await outboxRows(db), queued, "a web booking's id queues nothing");

    // Concurrent calls with one id on the only bike: the losers find no bike free and still get the booking.
    const lone = await seedShop(db);
    await seedFleet(db, lone.modelId, 1);
    const same = staffInput(lone, { guest: MINHO, locale: "ko" });
    const results = await Promise.all(Array.from({ length: 4 }, () => createStaffBooking(db, same, NOW, CTX)));
    const stored = await getBooking(db, same.id);
    assert.ok(stored, "no booking stored");
    for (const result of results) assert.deepEqual(result, { ok: true, booking: stored });
    assert.equal(await countBookings(db, lone.modelId), 1);
    assert.deepEqual(
      (await outboxKeys(db)).filter((key) => key.includes(same.id)),
      sorted(keysFor(same.id)),
    );

    // Two different requests under one id at once, on two bikes so that each could win: the stored one's calls get it.
    const pair = await seedShop(db);
    await seedFleet(db, pair.modelId, 2);
    const morning = staffInput(pair, { guest: NA });
    const afternoon = { ...morning, startAt: PICKUP + 6 * HOUR_MS };
    const calls = Array.from({ length: 6 }, (_, call) => (call % 2 === 0 ? morning : afternoon));
    const answers = await Promise.all(calls.map((call) => createStaffBooking(db, call, NOW, CTX)));
    const kept = await getBooking(db, morning.id);
    assert.ok(kept, "no booking stored");
    answers.forEach((answer, call) => {
      const expected = calls[call]?.startAt === kept.startAt ? { ok: true, booking: kept } : { ok: false, reason: "CONFLICT" };
      assert.deepEqual(answer.ok ? answer : { ok: false, reason: answer.reason }, expected, `call ${call}`);
    });
    assert.equal(await countBookings(db, pair.modelId), 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The guest.

/** Each change to a valid guest and the codes it fails with, by validateGuest's rules (#34) except a blank email. */
const BAD_GUESTS: [string, Record<string, unknown>, string[]][] = [
  ["no family name", { familyName: "" }, ["FAMILY_NAME_EMPTY"]],
  ["a family name of spaces", { familyName: "   " }, ["FAMILY_NAME_EMPTY"]],
  ["no given name", { givenName: "" }, ["GIVEN_NAME_EMPTY"]],
  ["a given name of a tab", { givenName: "\t" }, ["GIVEN_NAME_EMPTY"]],
  ["an email with no domain", { email: "hanako" }, ["EMAIL_MALFORMED"]],
  ["an email with an empty label", { email: "hanako@example..jp" }, ["EMAIL_MALFORMED"]],
  ["a padded email", { email: " hanako@example.jp" }, ["EMAIL_MALFORMED"]],
  ["markup in the email", { email: "<b>@example.jp" }, ["EMAIL_MALFORMED"]],
  ["a number for an email", { email: 42 }, ["EMAIL_MALFORMED"]],
  ["no phone", { phone: "" }, ["PHONE_NO_DIGITS"]],
  ["a phone with no digits", { phone: "+- ()" }, ["PHONE_NO_DIGITS"]],
  ["a number for a phone", { phone: 9012345678 }, ["PHONE_NO_DIGITS"]],
  ["several at once", { familyName: "", email: "x@y", phone: "" }, ["FAMILY_NAME_EMPTY", "EMAIL_MALFORMED", "PHONE_NO_DIGITS"]],
  ["every field", { familyName: " ", givenName: "", email: "@", phone: "-" }, [
    "FAMILY_NAME_EMPTY",
    "GIVEN_NAME_EMPTY",
    "EMAIL_MALFORMED",
    "PHONE_NO_DIGITS",
  ]],
];

test("bad guest details answer INVALID_GUEST and write nothing", async () => {
  await withShop(async (db) => {
    // One bike: a bad request that took it would leave the good one below SOLD_OUT.
    const shop = await seedShop(db);
    const [plate] = await seedFleet(db, shop.modelId, 1);
    const ids: string[] = [];
    for (const [n, [label, change, codes]] of BAD_GUESTS.entries()) {
      const base = GUESTS[n % GUESTS.length] as Guest;
      const input = staffInput(shop, { guest: { ...base, ...change } as unknown as Guest });
      ids.push(input.id);
      const result = await createStaffBooking(db, input, NOW, CTX);
      assert.ok(!result.ok, `${label}: ${JSON.stringify(result)}`);
      assert.equal(result.reason, "INVALID_GUEST", label);
      assert.deepEqual(sorted(result.fields ?? []), sorted(codes), label);
    }
    // No guest at all names at least every field that cannot be blank.
    for (const guest of [null, undefined, 42, "Yamada"]) {
      const input = staffInput(shop, { guest: guest as unknown as Guest });
      ids.push(input.id);
      const result = await createStaffBooking(db, input, NOW, CTX);
      assert.ok(!result.ok, `${JSON.stringify(guest)}: ${JSON.stringify(result)}`);
      assert.equal(result.reason, "INVALID_GUEST", JSON.stringify(guest));
      for (const code of ["FAMILY_NAME_EMPTY", "GIVEN_NAME_EMPTY", "PHONE_NO_DIGITS"]) {
        const fields: string[] = result.fields ?? [];
        assert.ok(fields.includes(code), `${JSON.stringify(guest)}: no ${code} in ${fields.join(", ")}`);
      }
    }

    assert.equal(await countBookings(db), 0, "a refused guest stores no booking");
    assert.deepEqual(await outboxKeys(db), [], "a refused guest queues nothing");

    // The same id with the guest put right books the bike that nothing took.
    const fixed = staffInput(shop, { id: ids[0] });
    assert.equal(booked(await createStaffBooking(db, fixed, NOW, CTX), "the fixed request").vehiclePlate, plate);
  });
});

test("a blank guest email books, queues no guest confirmation, and still queues the staff email and the Bookings row", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db, [{ days: 1 }], 9_900);
    await seedFleet(db, shop.modelId, 4);
    const ids: string[] = [];
    for (const [n, [guest, locale]] of ([
      [RURI, "ja"],
      [MINHO, "ko"],
    ] as [Guest, Locale][]).entries()) {
      const label = `${guest.familyName}, ${locale}`;
      const blank = { ...guest, email: "" };
      const input = staffInput(shop, { guest: blank, locale, startAt: PICKUP + n * 30 * MINUTE_MS });
      const booking = booked(await createStaffBooking(db, input, NOW, CTX), label);
      ids.push(input.id);
      assert.equal(booking.status, "CONFIRMED", label);
      assert.equal(booking.source, "staff", label);
      assert.equal(booking.paidJpy, 0, label);
      assert.ok(booking.guestEmail === "" || booking.guestEmail === null, `${label}: the email ${booking.guestEmail}`);
      assert.equal(booking.guestFamilyName, guest.familyName, label);
      assert.equal(booking.guestPhone, guest.phone, label);

      const keys = (await outboxKeys(db)).filter((key) => key.includes(input.id));
      assert.deepEqual(keys, sorted([STAFF_KEY(input.id), SHEET_KEY(input.id)]), `${label}: the outbox`);
      const staffEmail = JSON.parse((await itemOf(db, STAFF_KEY(input.id))).payload) as EmailPayload;
      assertHas(staffEmail, { template: "staff_new_booking", to: STAFF_EMAIL, locale: "ja" }, label);
      assertHas(
        staffEmail.data,
        {
          ref: booking.ref,
          priceJpy: 9_900,
          paidJpy: 0,
          vehiclePlate: booking.vehiclePlate,
          guest: { familyName: guest.familyName, givenName: guest.givenName, email: "", phone: guest.phone },
        },
        label,
      );
      assertRendersWhole(staffEmail, `${label}: staff_new_booking`);
      assert.deepEqual(JSON.parse((await itemOf(db, SHEET_KEY(input.id))).payload), { bookingId: input.id }, label);

      // The same request again is a replay of it, blank email and all.
      assert.deepEqual(await createStaffBooking(db, input, NOW + MINUTE_MS, CTX), { ok: true, booking }, `${label}: a replay`);
    }
    const expected = ids.flatMap((id) => [STAFF_KEY(id), SHEET_KEY(id)]);
    assert.deepEqual(await outboxKeys(db), sorted(expected), "no guest confirmation, and nothing twice");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The pickup.

test("unknown model, package and price and the pickup-window reasons are refused as for a web hold", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db, [{ days: 1 }, { days: 3 }, { days: 7 }, { hours: 4 }, { hours: 24 }]);
    await seedFleet(db, shop.modelId, 2);
    await seedClosedDates(db, ["2030-06-20", "2030-06-27", "2030-12-03"]);
    // Priced for another rate class only.
    const elsewhere = await seedPackage(db, { days: 2 });
    await seedPrice(db, { rate_class_id: (await seedRateClass(db)).id, package_id: elsewhere.id });
    const hoursElsewhere = await seedPackage(db, { hours: 2 });
    await seedPrice(db, { rate_class_id: (await seedRateClass(db)).id, package_id: hoursElsewhere.id });
    // Off sale, with a free bike and a price.
    const offSale = await seedShop(db, [{ days: 1 }], 8000, { active: 0 });
    await seedFleet(db, offSale.modelId, 1);
    // On sale, with every bike out of service.
    const resting = await seedShop(db);
    await seedVehicle(db, { model_id: resting.modelId, status: "maintenance" });
    await seedVehicle(db, { model_id: resting.modelId, status: "retired" });

    const at = (wall: string) => jst(wall);
    const day = (days: number) => shop.packageOf({ days });
    const hours = (n: number) => shop.packageOf({ hours: n });
    const table: [string, Partial<StaffInput>, string][] = [
      ["unknown model", { modelId: "no-such-model" }, "UNKNOWN_MODEL"],
      ["a model off sale", { modelId: offSale.modelId, packageId: offSale.packageId }, "UNKNOWN_MODEL"],
      ["unknown package", { packageId: "no-such-package" }, "UNKNOWN_PACKAGE"],
      ["no price for this rate class", { packageId: elsewhere.id }, "NO_PRICE"],
      ["no hours price for this rate class", { packageId: hoursElsewhere.id }, "NO_PRICE"],
      ["every bike out of service", { modelId: resting.modelId, packageId: resting.packageId }, "SOLD_OUT"],
      ["before opening", { startAt: at(`${PICKUP_DAY} 08:30`) }, "OUTSIDE_HOURS"],
      ["at closing", { startAt: at(`${PICKUP_DAY} 18:00`) }, "OUTSIDE_HOURS"],
      ["between slots", { startAt: at(`${PICKUP_DAY} 09:15`) }, "OFF_SLOT"],
      ["a pickup that is no number", { startAt: Number.NaN }, "OFF_SLOT"],
      ["a pickup as text", { startAt: "2030-06-10T09:00:00+09:00" as unknown as number }, "OFF_SLOT"],
      ["closed on pickup", { startAt: at("2030-06-20 09:00") }, "CLOSED_PICKUP"],
      ["closed on return", { packageId: day(3), startAt: at("2030-06-25 09:00") }, "CLOSED_RETURN"],
      ["closed on a return past the horizon", { packageId: day(7), startAt: at("2030-11-27 09:00") }, "CLOSED_RETURN"],
      ["4 hours returning past closing", { packageId: hours(4), startAt: at(`${PICKUP_DAY} 14:30`) }, "RETURN_OUTSIDE_HOURS"],
      ["4 hours from the last slot", { packageId: hours(4), startAt: at(`${PICKUP_DAY} 17:30`) }, "RETURN_OUTSIDE_HOURS"],
      ["24 hours into a closed day", { packageId: hours(24), startAt: at("2030-06-26 17:30") }, "CLOSED_RETURN"],
      // The default horizon of 180 days from NOW ends at 2030-11-28 12:00.
      ["past the horizon", { startAt: at("2030-11-28 12:30") }, "TOO_FAR"],
      ["in the past", { startAt: at("2030-05-01 09:00") }, "TOO_SOON"],
    ];
    // Each reason is the one createHold gives the same request, as tests/holds.test.ts pins it.
    for (const [label, partial, reason] of table) {
      assert.equal(reasonOf(await createStaffBooking(db, staffInput(shop, partial), NOW, CTX)), reason, label);
    }

    // A request body can hold anything, so an input that is no request at all still gets a declared reason.
    const hostile: [string, unknown][] = [
      ["null", null],
      ["undefined", undefined],
      ["a number", 42],
      ["a string", "staff"],
      ["an array", []],
      ["an empty id", staffInput(shop, { id: "" })],
      ["a megabyte id", staffInput(shop, { id: "x".repeat(1_000_000) })],
      ["an unknown locale", staffInput(shop, { locale: "fr" as Locale })],
    ];
    for (const [label, input] of hostile) {
      const result = await createStaffBooking(db, input as StaffInput, NOW, CTX);
      assert.ok(!result.ok && DECLARED_REASONS.includes(result.reason), `${label}: ${JSON.stringify(result)}`);
    }
    assert.equal(await countBookings(db), 0, "a refusal stores nothing");
    assert.deepEqual(await outboxKeys(db), [], "a refusal queues nothing");

    // The same shop takes a request with the fault taken out.
    booked(await createStaffBooking(db, staffInput(shop), NOW, CTX), "the first slot");
    booked(await createStaffBooking(db, staffInput(shop, { packageId: day(3), startAt: at("2030-06-19 09:00") }), NOW, CTX), "over a closed day");
    booked(await createStaffBooking(db, staffInput(shop, { packageId: hours(4), startAt: at(`${PICKUP_DAY} 14:00`) }), NOW, CTX), "back at closing");
  });
});

/** Each pickup's slot set against `now` by hand: the slot runs from the pickup for slot_minutes. */
const LEAD_CASES: { slot: number; now: string; pickup: string; ok: boolean }[] = [
  // 30-minute slots: the 10:00 slot runs to 10:30.
  { slot: 30, now: "2030-06-10 10:07", pickup: "2030-06-10 10:00", ok: true },
  { slot: 30, now: "2030-06-10 10:07", pickup: "2030-06-10 09:30", ok: false },
  { slot: 30, now: "2030-06-10 10:07", pickup: "2030-06-10 10:30", ok: true },
  { slot: 30, now: "2030-06-10 10:07", pickup: "2030-06-11 09:00", ok: true },
  { slot: 30, now: "2030-06-10 10:00", pickup: "2030-06-10 10:00", ok: true },
  { slot: 30, now: "2030-06-10 10:29:59.999", pickup: "2030-06-10 10:00", ok: true },
  { slot: 30, now: "2030-06-10 10:30", pickup: "2030-06-10 10:00", ok: false },
  { slot: 30, now: "2030-06-10 10:07", pickup: "2030-06-09 17:30", ok: false },
  { slot: 30, now: "2030-06-10 17:45", pickup: "2030-06-10 17:30", ok: true },
  // 60-minute slots: the 10:00 slot runs to 11:00.
  { slot: 60, now: "2030-06-10 10:07", pickup: "2030-06-10 10:00", ok: true },
  { slot: 60, now: "2030-06-10 10:59:59.999", pickup: "2030-06-10 10:00", ok: true },
  { slot: 60, now: "2030-06-10 11:00", pickup: "2030-06-10 10:00", ok: false },
  { slot: 60, now: "2030-06-10 10:07", pickup: "2030-06-10 09:00", ok: false },
  // 20-minute slots from 09:00: the 10:00 slot runs to 10:20, and 09:40's ended at 10:00.
  { slot: 20, now: "2030-06-10 10:07", pickup: "2030-06-10 10:00", ok: true },
  { slot: 20, now: "2030-06-10 10:19", pickup: "2030-06-10 10:00", ok: true },
  { slot: 20, now: "2030-06-10 10:20", pickup: "2030-06-10 10:00", ok: false },
  { slot: 20, now: "2030-06-10 10:07", pickup: "2030-06-10 09:40", ok: false },
];

/** At 10:07 on 2030-06-10 with 30-minute slots and 2030-06-12 closed: what the lead time rule does not excuse. */
const STILL_REFUSED: { label: string; now?: string; pickup: string; length: Length; maxDays?: number; reason: string | null }[] = [
  { label: "off the grid, in the slot under way", pickup: "2030-06-10 10:05", length: { days: 1 }, reason: "OFF_SLOT" },
  { label: "off the grid later today", pickup: "2030-06-10 10:15", length: { days: 1 }, reason: "OFF_SLOT" },
  { label: "at closing today", pickup: "2030-06-10 18:00", length: { days: 1 }, reason: "OUTSIDE_HOURS" },
  { label: "before opening tomorrow", pickup: "2030-06-11 08:30", length: { days: 1 }, reason: "OUTSIDE_HOURS" },
  { label: "a closed pickup date", pickup: "2030-06-12 10:00", length: { days: 1 }, reason: "CLOSED_PICKUP" },
  {
    label: "the slot under way on a closed day",
    now: "2030-06-12 10:07",
    pickup: "2030-06-12 10:00",
    length: { days: 1 },
    reason: "CLOSED_PICKUP",
  },
  { label: "the slot under way, returning on a closed date", pickup: "2030-06-10 10:00", length: { days: 3 }, reason: "CLOSED_RETURN" },
  { label: "4 hours back past closing", pickup: "2030-06-10 14:30", length: { hours: 4 }, reason: "RETURN_OUTSIDE_HOURS" },
  { label: "the slot under way, back past closing", pickup: "2030-06-10 10:00", length: { hours: 9 }, reason: "RETURN_OUTSIDE_HOURS" },
  { label: "4 hours back at closing", pickup: "2030-06-10 14:00", length: { hours: 4 }, reason: null },
  { label: "the day after a closed date", pickup: "2030-06-13 10:00", length: { days: 1 }, reason: null },
  // 180 days from 2030-06-10 10:07 is 2030-12-07 10:07; 30 days is 2030-07-10 10:07.
  { label: "the last slot inside 180 days", pickup: "2030-12-07 10:00", length: { days: 1 }, reason: null },
  { label: "the first slot past 180 days", pickup: "2030-12-07 10:30", length: { days: 1 }, reason: "TOO_FAR" },
  { label: "the last slot inside 30 days", pickup: "2030-07-10 10:00", length: { days: 1 }, maxDays: 30, reason: null },
  { label: "the first slot past 30 days", pickup: "2030-07-10 10:30", length: { days: 1 }, maxDays: 30, reason: "TOO_FAR" },
];

test("the lead time does not apply and the current slot is allowed, while hours, closed dates and the horizon still do", async () => {
  await withShop(async (db) => {
    const catalog = await seedCatalog(db, [{ days: 1 }, { days: 3 }, { hours: 4 }, { hours: 9 }]);
    // One model per lead time and slot length, with a bike for each case that books, since those all overlap.
    for (const minLead of [0, 72]) {
      for (const slot of [...new Set(LEAD_CASES.map((leadCase) => leadCase.slot))]) {
        const cases = LEAD_CASES.filter((leadCase) => leadCase.slot === slot);
        await setConfig(db, { slot_minutes: slot, min_lead_hours: minLead });
        const shop = await seedLine(db, catalog);
        await seedFleet(db, shop.modelId, cases.filter(({ ok }) => ok).length);
        for (const { now, pickup, ok } of cases) {
          const label = `${slot}-minute slots, ${minLead} hours lead, at ${now} for ${pickup}`;
          const result = await createStaffBooking(db, staffInput(shop, { startAt: jst(pickup) }), jst(now), CTX);
          assert.equal(reasonOf(result), ok ? "ok" : "TOO_SOON", label);
        }
      }
    }

    // A web hold at the same moment still keeps the lead time.
    await setConfig(db, { slot_minutes: 30, min_lead_hours: 24 });
    const web = await seedLine(db, catalog);
    await seedFleet(db, web.modelId, 1);
    const tooSoon = await createHold(db, holdInput(web, { startAt: jst("2030-06-10 10:30") }), jst("2030-06-10 10:07"));
    assert.equal(reasonOf(tooSoon), "TOO_SOON", "a web hold inside the lead time");

    await seedClosedDates(db, ["2030-06-12"]);
    for (const maxDays of [180, 30]) {
      const cases = STILL_REFUSED.filter((refused) => (refused.maxDays ?? 180) === maxDays);
      await setConfig(db, { max_days_ahead: maxDays });
      const shop = await seedLine(db, catalog);
      await seedFleet(db, shop.modelId, cases.filter(({ reason }) => reason === null).length);
      for (const { label, now = "2030-06-10 10:07", pickup, length, reason } of cases) {
        const input = staffInput(shop, { packageId: shop.packageOf(length), startAt: jst(pickup) });
        assert.equal(reasonOf(await createStaffBooking(db, input, jst(now), CTX)), reason ?? "ok", label);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// After the booking.

/** Square with no payment and no refund in any window. Anything that would move money fails the test. */
function emptySquare(): SquareClient {
  return {
    async createPayment() {
      throw new Error("a reconciliation takes no payment");
    },
    async refundPayment() {
      throw new Error("a reconciliation sends no refund");
    },
    async getPayment(id) {
      return { kind: "error", code: "NOT_FOUND", detail: `Could not find payment with id: ${id}` };
    },
    async listPayments() {
      return { kind: "ok", payments: [] };
    },
    async listRefunds() {
      return { kind: "ok", refunds: [] };
    },
  };
}

test("reconciliation does not flag a staff booking as missing a payment", async () => {
  await withShop(async (db) => {
    const shop = await seedShop(db, [{ days: 1 }], 12_000);
    await seedFleet(db, shop.modelId, 4);
    const made = [
      booked(await createStaffBooking(db, staffInput(shop, { guest: HANAKO }), NOW, CTX), "with an email"),
      booked(await createStaffBooking(db, staffInput(shop, { guest: { ...RURI, email: "" } }), NOW + HOUR_MS, CTX), "blank"),
      booked(await createStaffBooking(db, staffInput(shop, { guest: NA }), NOW + 2 * HOUR_MS, CTX), "later cancelled"),
    ];
    // Cancelled by staff afterwards, so it sits in the payment scope as a CANCELLED booking would.
    const cancelled = made[2] as Booking;
    await db
      .prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?2, cancel_reason = ?3, updated_at = ?2 WHERE id = ?1")
      .bind(cancelled.id, NOW + 3 * HOUR_MS, "Cancelled by staff")
      .run();

    // A web booking with no payment in Square beside them, which the check does report, so it ran.
    const web = await seedBooking(db, {
      model_id: shop.modelId,
      payment_id: `sq-${randomUUID()}`,
      paid_jpy: 5000,
      confirmed_at: NOW,
      created_at: NOW - HOUR_MS,
      updated_at: NOW,
    });

    const { issues } = await reconcileSquare({ db, square: emptySquare(), now: NOW + DAY_MS });
    const missing = issues.filter((issue) => issue.type === "booking_without_payment").map((issue) => issue.bookingRef);
    assert.deepEqual(missing, [web.ref], "only the web booking misses its payment");
    for (const booking of made) {
      const flagged = issues.filter((issue) => issue.bookingRef === booking.ref);
      assert.deepEqual(flagged, [], `${booking.ref}: ${JSON.stringify(flagged)}`);
    }
  });
});

test("the Bookings tab row shows source staff and nothing paid", async () => {
  await withShop(async (db) => {
    await seedPackage(db, { id: "day-1-staff-tab", days: 1 });
    const model = await seedModel(db, { id: "pcx-125-staff-tab" });
    await seedPrice(db, { rate_class_id: model.rate_class_id, package_id: "day-1-staff-tab", price_jpy: 6_600 });
    await seedVehicle(db, { plate: "わ1234", model_id: model.id, base_usage_days: 0 });
    await seedVehicle(db, { plate: "わ5678", model_id: model.id, base_usage_days: 3 });
    const shop = { modelId: model.id, packageId: "day-1-staff-tab" };
    const guests: [Guest, Locale][] = [
      [HANAKO, "en"],
      [{ ...RURI, email: "" }, "ja"],
    ];
    const made: Booking[] = [];
    for (const [guest, locale] of guests) {
      made.push(booked(await createStaffBooking(db, staffInput(shop, { guest, locale }), NOW, CTX), guest.familyName));
    }

    // The outbox delivers as the cron does: the sheet items go to syncBookingRows, against a tab that only has its header.
    const sheet = createFakeSheets({
      Config: [
        ["key", "value"],
        ["shop_open", "09:00"],
      ],
      Bookings: [[...BOOKINGS_COLUMNS]],
    });
    const synced: string[] = [];
    await drainOutbox({
      db,
      now: NOW + MINUTE_MS,
      sendEmail: async () => ({ ok: true }),
      syncBookings: async (ids) => {
        synced.push(...ids);
        return syncBookingRows({ db, sheets: sheet }, ids);
      },
    });
    assert.deepEqual(sorted(synced), sorted(made.map((booking) => booking.id)));

    const [header, ...rows] = sheet.grid("Bookings");
    assert.ok(header, "the tab lost its header");
    assert.equal(rows.length, made.length, "one row per booking");
    const byId = new Map(rows.map((row) => [String(named(header, row).booking_id), named(header, row)]));
    for (const [n, booking] of made.entries()) {
      const [guest] = guests[n] as [Guest, Locale];
      const label = `${booking.ref}, ${guest.familyName}`;
      const cells = byId.get(booking.id);
      assert.ok(cells, `${label}: no row`);
      assertHas(
        cells,
        {
          booking_ref: booking.ref,
          status: "CONFIRMED",
          source: "staff",
          model_id: model.id,
          plate: ["わ1234", "わ5678"][n],
          package_id: "day-1-staff-tab",
          guest_name: `${guest.familyName} ${guest.givenName}`,
          guest_email: guest.email,
          guest_phone: guest.phone,
          price_jpy: 6_600,
          deposit_jpy: DEPOSIT_JPY,
          paid_jpy: 0,
          refund_jpy: 0,
          refund_status: "",
        },
        label,
      );
      const stored = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(booking.id).first<BookingRow>();
      assert.ok(stored, `${label}: not stored`);
      assert.deepEqual(cells, expectedCells(stored), `${label}: every column`);
    }
  });
});
