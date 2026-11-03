// resolveStuckPayments, src/lib/booking/stuck-payments.ts, on a real D1 with Square faked at the SquareClient seam, the one
// thing here that is external. The fake lists payments as Square does, by created_at within the window asked for, both ends
// included, so a window that misses a payment shows in what becomes of its booking. What the rows hold, what waits in the
// outbox, whether a rival can hold the bike, what went to Square and what the run returns are the outcomes. Ids, refs,
// plates, deposits and payment ids are fresh on every run, and instants come from Date.parse on an explicit +09:00 offset,
// so no expected value passes through src/lib/time.ts or the code under test. The normal path's outbox comes from
// markConfirmed (#34) itself, called on a twin database built from the same rows, because the ticket asks for its items.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - "More than 5 minutes" and "more than 30 minutes" are strict: a booking exactly that old is left alone, one millisecond
//   older is not. Both ages read updated_at, when the charge went out; created_at only opens the window.
// - The window opens a minute before the oldest created_at among the bookings the run looks at, not among all bookings.
// - A COMPLETED payment under a booking's reference confirms it, whatever else shares the reference: a FAILED or CANCELED
//   attempt, an unsettled one (PENDING, APPROVED), or one in a status this code does not know (VOIDED, say).
// - Without a COMPLETED one, a payment Square has in any status but FAILED and CANCELED was seen and was not declined, so
//   its booking is left alone however old, even when a FAILED or CANCELED attempt shares the reference. That covers
//   PENDING, APPROVED and any status this code does not know: read as a decline or as no payment, it would free a bike
//   Square may yet be paid for. A decline reopens only when every attempt under the reference is FAILED or CANCELED.
//   Whether the run mentions a status it does not know in `errors` is left open.
// - Which attempt is listed first, and which is older, never matters.
// - Two COMPLETED payments under one reference (the owner's answer, 2026-11-03): the run confirms on one of them, which one
//   is left open, and refunds neither; the duplicate is for reconciliation (#43) to report to staff. Whether the run
//   mentions it in `errors` is left open.
// - Reopening and expiring change status and updated_at only, so a reopened hold keeps its expiry as docs/data-model.md
//   says, and neither enqueues anything: the booking never reached the guest's inbox or the sheet. That an expiry queues
//   nothing to the guest is the owner's answer (2026-11-03).
// - A COMPLETED payment of another amount or currency goes to markConfirmed like any other, which sends it back and reopens
//   the hold; the run does not count it confirmed. Which count it lands in is left open.
// - A Square failure, whether an error result, an unknown one or a rejected call, is reported in `errors` and the run still
//   resolves, writing nothing. With nothing stuck, the run asks Square nothing.
// - Past 20 stuck bookings, which 20 go first is left open; the rest go on the next run.
// - A booking that moves while the run is under way stays as it moved, and the run does not count it. That includes one
//   declined and charged again meanwhile: PAYMENT_PENDING as before, but on a later attempt, so the write the run planned
//   from what it read is out of date for it too. And one the webhook confirms on the very payment the run found: the
//   webhook's confirmation is the one that counts, its items are queued once, and the run counts it nowhere. Whether the
//   run mentions a lost race in `errors` is left open.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { test } from "node:test";
import { type ConfirmContext, type DepositPayment, type MarkResult, markConfirmed } from "../src/lib/booking/confirm.ts";
import { createHold } from "../src/lib/booking/holds.ts";
import type { Locale } from "../src/lib/locale.ts";
import type {
  CreatePaymentInput,
  PaymentListResult,
  RefundPaymentInput,
  SquareClient,
  SquareRecord,
  SquareTimeWindow,
} from "../src/lib/square/client.ts";
import { createTestDb } from "./helpers/d1.ts";
import {
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedTiers,
  seedType,
  seedVehicle,
  type BookingRow,
} from "./helpers/seed.ts";

/** Loaded at each call, so a test's fixtures run first, a bad fixture shows first, and each test fails on this module alone. */
const stuckModule = () => import("../src/lib/booking/stuck-payments.ts");

type ResolveDeps = {
  db: D1Database;
  square: SquareClient;
  now: number;
  siteUrl: string;
  cancelSecret: string;
  staffEmail: string;
};

type Counts = { confirmed: number; reopened: number; expired: number };
type Outcome = Counts & { errors: string[] };

/** The ticket's four fields of the result, so a field the module adds of its own does not fail a comparison. */
async function resolveStuck(deps: ResolveDeps): Promise<Outcome> {
  const { resolveStuckPayments } = await stuckModule();
  const { confirmed, reopened, expired, errors } = await resolveStuckPayments(deps);
  return { confirmed, reopened, expired, errors };
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** The seeded config's hold_minutes. */
const HOLD_MS = 15 * MINUTE_MS;
/** Square's cap on an idempotency key. */
const MAX_KEY_LENGTH = 45;

const SITE_URL = "https://ride.okinawa-dream.example";
const STAFF_EMAIL = "night-desk@okinawa-dream.example";
const CANCEL_SECRET = `cancel-secret-${randomUUID()}`;

function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

const NOW = jst("2030-06-01 12:00");
/** A slot a real createHold accepts at NOW, and the close of that day, where a one-day package returns. */
const OPEN_PICKUP = jst("2030-06-10 09:00");
const OPEN_RETURN = jst("2030-06-10 18:00");

type Guest = { familyName: string; givenName: string; email: string; phone: string; locale: Locale };

const GUESTS: Guest[] = [
  { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.jp", phone: "090-8686-3535", locale: "ja" },
  { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929", locale: "ko" },
  { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000", locale: "zh-cn" },
  { familyName: "Zanzibarova", givenName: "Quillette", email: "q.z@example.com", phone: "+1 415 555 0134", locale: "en" },
];

type Shop = { db: D1Database; modelId: string; packageId: string };

/** A published shop whose ids all come from `tag`, so two databases opened with one tag hold the same rows. */
async function openShop(tag: string): Promise<Shop & { dispose: () => Promise<void> }> {
  const { db, dispose } = await createTestDb();
  try {
    await seedType(db, { deposit_jpy: 33_000 });
    await seedConfig(db);
    await seedCatalogMeta(db);
    await seedTiers(db);
    const rate = await seedRateClass(db, { id: `rate-${tag}` });
    const model = await seedModel(db, { id: `model-${tag}`, rate_class_id: rate.id });
    const pack = await seedPackage(db, { id: `package-${tag}`, days: 1 });
    await seedPrice(db, { rate_class_id: rate.id, package_id: pack.id, price_jpy: 18_700 });
    return { db, dispose, modelId: model.id, packageId: pack.id };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function withShop(run: (shop: Shop) => Promise<void>): Promise<void> {
  const { dispose, ...shop } = await openShop(randomUUID().slice(0, 8));
  try {
    await run(shop);
  } finally {
    await dispose();
  }
}

type Row = Partial<BookingRow> & {
  id: string;
  model_id: string;
  vehicle_plate: string;
  deposit_jpy: number;
  created_at: number;
  updated_at: number;
};

let turn = 0;

/**
 * A web booking whose charge went out at `updatedAt` and was never answered. Its hold was made a few minutes before and
 * had fifteen minutes to run from then. Id, ref, plate, deposit and guest are fresh for each row; `more` overrides any.
 */
function stuckRow(shop: Shop, updatedAt: number, more: Partial<BookingRow> = {}): Row {
  turn += 1;
  const guest = GUESTS[turn % GUESTS.length] as Guest;
  const createdAt = more.created_at ?? updatedAt - randomInt(1, 10) * MINUTE_MS - randomInt(0, 60) * SECOND_MS;
  const deposit = 1_000 + randomInt(0, 400) * 50;
  return {
    id: randomUUID(),
    ref: randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase(),
    status: "PAYMENT_PENDING",
    source: "web",
    model_id: shop.modelId,
    package_id: shop.packageId,
    vehicle_plate: `OKI-${randomUUID().slice(0, 13)}`,
    start_at: OPEN_PICKUP,
    end_at: OPEN_RETURN,
    expires_at: createdAt + HOLD_MS,
    price_jpy: deposit * 2 + 1_100,
    deposit_jpy: deposit,
    locale: guest.locale,
    guest_family_name: guest.familyName,
    guest_given_name: guest.givenName,
    guest_email: guest.email,
    guest_phone: guest.phone,
    payment_attempt: 1 + randomInt(0, 3),
    created_at: createdAt,
    updated_at: updatedAt,
    ...more,
  } as Row;
}

/** Seeds `row` as it stands, and its bike too unless that plate is already in the fleet. */
async function seedRow(db: D1Database, row: Row): Promise<BookingRow> {
  const known = await db.prepare("SELECT 1 FROM vehicles WHERE plate = ?1").bind(row.vehicle_plate).first();
  if (known === null) await seedVehicle(db, { plate: row.vehicle_plate, model_id: row.model_id });
  return seedBooking(db, row);
}

/** Square's record of one payment, as listPayments gives it, under an id of its own. Null is a Dashboard sale's reference. */
function squarePayment(
  reference: string | null,
  status: string,
  amount: number,
  createdAt: number,
  currency = "JPY",
): SquareRecord {
  const payment: SquareRecord = {
    id: `sq-${randomUUID()}`,
    status,
    amount,
    currency,
    created_at: new Date(createdAt).toISOString(),
  };
  if (reference !== null) payment.reference_id = reference;
  return payment;
}

/** The payment a booking's charge made, by default COMPLETED for its deposit a few seconds after the charge went out. */
function paid(row: Row, fields: { status?: string; at?: number; amount?: number; currency?: string } = {}): SquareRecord {
  const {
    status = "COMPLETED",
    at = row.updated_at + randomInt(1, 30) * SECOND_MS,
    amount = row.deposit_jpy,
    currency = "JPY",
  } = fields;
  return squarePayment(row.id, status, amount, at, currency);
}

/** A listed payment as markConfirmed takes it. */
function asDeposit({ id, amount, currency, status }: SquareRecord): DepositPayment {
  return { id, amountJpy: amount, currency, status };
}

/** What the webhook (#36) and the normal path hand markConfirmed besides the payment. */
function confirmContext(square: SquareClient): ConfirmContext {
  return { square, siteUrl: SITE_URL, cancelSecret: CANCEL_SECRET, staffEmail: STAFF_EMAIL };
}

type ListAnswer = () => PaymentListResult | Promise<PaymentListResult>;

type FakeSquare = SquareClient & {
  listings: SquareTimeWindow[];
  refunds: RefundPaymentInput[];
  charges: CreatePaymentInput[];
};

/**
 * Square as the resolver meets it. listPayments answers from `ledger` in the ledger's order, keeping a payment when its
 * created_at falls within the window, or `ledger` scripts the answer. Refunds go through; nothing else is faked.
 */
function fakeSquare(ledger: SquareRecord[] | ListAnswer): FakeSquare {
  const listings: SquareTimeWindow[] = [];
  const refunds: RefundPaymentInput[] = [];
  const charges: CreatePaymentInput[] = [];
  const unused = { kind: "error", code: "NOT_FAKED", detail: "resolving stuck payments only lists them" } as const;
  return {
    listings,
    refunds,
    charges,
    async listPayments(window) {
      listings.push({ beginTime: window.beginTime, endTime: window.endTime });
      if (typeof ledger === "function") return ledger();
      const payments = ledger.filter((payment) => {
        const at = Date.parse(payment.created_at ?? "");
        return at >= window.beginTime && at <= window.endTime;
      });
      return { kind: "ok", payments: payments.map((payment) => ({ ...payment })) };
    },
    async refundPayment(input) {
      refunds.push(input);
      const refund: SquareRecord = {
        id: `sq-refund-${randomUUID()}`,
        status: "PENDING",
        amount: input.amountJpy,
        currency: "JPY",
        payment_id: input.paymentId,
      };
      return { kind: "ok", refund };
    },
    async createPayment(input) {
      charges.push(input);
      return unused;
    },
    async getPayment() {
      return unused;
    },
    async listRefunds() {
      return unused;
    },
  };
}

function depsOf(db: D1Database, square: SquareClient, now = NOW): ResolveDeps {
  return { db, square, now, siteUrl: SITE_URL, cancelSecret: CANCEL_SECRET, staffEmail: STAFF_EMAIL };
}

async function stored(db: D1Database, id: string): Promise<BookingRow> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `no booking ${id}`);
  return row;
}

async function allBookings(db: D1Database): Promise<BookingRow[]> {
  return (await db.prepare("SELECT * FROM bookings ORDER BY id").all<BookingRow>()).results;
}

type OutboxRow = {
  kind: string;
  dedupe_key: string;
  payload: string;
  status: string;
  next_attempt_at: number;
  created_at: number;
};

/** Every row, whatever became of it, without the autoincrement id. */
async function outbox(db: D1Database): Promise<OutboxRow[]> {
  const sql = "SELECT kind, dedupe_key, payload, status, next_attempt_at, created_at FROM outbox ORDER BY dedupe_key";
  return (await db.prepare(sql).all<OutboxRow>()).results;
}

/** The items that name a booking, in their key or their payload. */
function itemsOf(rows: OutboxRow[], bookingId: string): OutboxRow[] {
  return rows.filter((row) => row.dedupe_key.includes(bookingId) || row.payload.includes(bookingId));
}

/** Confirmed on this payment at `at`, as markConfirmed leaves a booking, with one confirmation's three items. */
async function assertConfirmed(db: D1Database, booking: BookingRow, payment: SquareRecord, at: number, label: string) {
  assert.deepEqual(
    await stored(db, booking.id),
    { ...booking, status: "CONFIRMED", payment_id: payment.id, paid_jpy: payment.amount, confirmed_at: at, updated_at: at },
    label,
  );
  const kinds = itemsOf(await outbox(db), booking.id).map(({ kind }) => kind);
  assert.deepEqual(kinds.sort(), ["email", "email", "sheet_booking"], `${label}: the outbox`);
}

/** Back to the hold it was, expiry and guest kept, with nothing enqueued. */
async function assertReopened(db: D1Database, booking: BookingRow, at: number, label: string) {
  assert.deepEqual(await stored(db, booking.id), { ...booking, status: "ON_HOLD", updated_at: at }, label);
  assert.deepEqual(itemsOf(await outbox(db), booking.id), [], `${label}: the outbox`);
}

async function assertExpired(db: D1Database, booking: BookingRow, at: number, label: string) {
  assert.deepEqual(await stored(db, booking.id), { ...booking, status: "EXPIRED", updated_at: at }, label);
  assert.deepEqual(itemsOf(await outbox(db), booking.id), [], `${label}: the outbox`);
}

async function assertUntouched(db: D1Database, booking: BookingRow, label: string) {
  assert.deepEqual(await stored(db, booking.id), booking, label);
  assert.deepEqual(itemsOf(await outbox(db), booking.id), [], `${label}: the outbox`);
}

/** A model of the shop's with one bike, priced for the shop's package, so a rival's hold says whether that bike is free. */
async function soloBike(shop: Shop): Promise<{ modelId: string; plate: string }> {
  const rate = await seedRateClass(shop.db);
  const model = await seedModel(shop.db, { rate_class_id: rate.id });
  await seedPrice(shop.db, { rate_class_id: rate.id, package_id: shop.packageId, price_jpy: 8_800 });
  const vehicle = await seedVehicle(shop.db, { model_id: model.id });
  return { modelId: model.id, plate: vehicle.plate };
}

function rivalHold(shop: Shop, modelId: string, at: number) {
  return createHold(
    shop.db,
    { id: randomUUID(), modelId, packageId: shop.packageId, startAt: OPEN_PICKUP, locale: "en" },
    at,
  );
}

/** A rival gets the bike, and from then on holds it. */
async function assertBikeFree(shop: Shop, modelId: string, at: number, label: string) {
  const rival = await rivalHold(shop, modelId, at);
  assert.ok(rival.ok, `${label}: ${JSON.stringify(rival)}`);
}

async function assertBikeHeld(shop: Shop, modelId: string, at: number, label: string) {
  assert.deepEqual(await rivalHold(shop, modelId, at), { ok: false, reason: "SOLD_OUT" }, label);
}

/** As #36's webhook confirms a booking on a payment of its own. Binds id, payment id, time. */
const CONFIRMED_BY_ANOTHER =
  "UPDATE bookings SET status = 'CONFIRMED', payment_id = ?2, paid_jpy = deposit_jpy, confirmed_at = ?3, updated_at = ?3 WHERE id = ?1";

/** As a decline (#34 releases the hold) and the guest's next charge leave a booking: pending again, one attempt on. Binds id, time. */
const CHARGED_AGAIN =
  "UPDATE bookings SET status = 'PAYMENT_PENDING', payment_attempt = payment_attempt + 1, updated_at = ?2 WHERE id = ?1";

/**
 * `db`, with `beforeUpdate` run once just before its first `UPDATE bookings` goes out, alone or in a batch. Whatever was read
 * from the row before that moment is out of date by then. Other statements pass through untouched. `raced` says the moment came.
 */
function raceBeforeUpdate(db: D1Database, beforeUpdate: () => Promise<unknown>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const race = async () => {
    if (raced) return;
    raced = true;
    await beforeUpdate();
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
          return /\bUPDATE\s+bookings\b/i.test(sql) ? watch(statement) : statement;
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

test("completed payments confirm stuck bookings", async () => {
  const tag = randomUUID().slice(0, 8);
  const main = await openShop(tag);
  const twin = await openShop(tag);
  try {
    const rows = [
      stuckRow(main, NOW - 6 * MINUTE_MS),
      // Past the expiry age: a payment Square has completed wins over the clock.
      stuckRow(main, NOW - 31 * MINUTE_MS, { payment_attempt: 3 }),
      stuckRow(main, NOW - 3 * HOUR_MS),
      stuckRow(main, NOW - 12 * MINUTE_MS - 1),
    ];
    const unpaid = stuckRow(main, NOW - 9 * MINUTE_MS);
    const payments = rows.map((row) => paid(row));
    for (const db of [main.db, twin.db]) for (const row of [...rows, unpaid]) await seedRow(db, row);
    const seeded = await Promise.all(rows.map((row) => stored(main.db, row.id)));
    const unpaidRow = await stored(main.db, unpaid.id);
    const noise = squarePayment(randomUUID(), "COMPLETED", 4_400, NOW - 20 * MINUTE_MS);
    const square = fakeSquare([...payments, noise].reverse());

    const result = await resolveStuck(depsOf(main.db, square));

    assert.deepEqual(result, { confirmed: rows.length, reopened: 0, expired: 0, errors: [] });
    for (const [index, booking] of seeded.entries()) {
      await assertConfirmed(main.db, booking, payments[index] as SquareRecord, NOW, `stuck booking ${index}`);
    }
    await assertUntouched(main.db, unpaidRow, "the booking Square has no payment for, 9 minutes on");
    assert.deepEqual(square.refunds, []);
    assert.deepEqual(square.charges, []);

    // The normal path, given the same payments at the same moment, on the same rows.
    const ctx = { square: fakeSquare([]), siteUrl: SITE_URL, cancelSecret: CANCEL_SECRET, staffEmail: STAFF_EMAIL };
    for (const [index, row] of rows.entries()) {
      const { id, amount, currency, status } = payments[index] as SquareRecord;
      assert.equal(await markConfirmed(twin.db, row.id, { id, amountJpy: amount, currency, status }, NOW, ctx), "confirmed");
    }
    assert.deepEqual(await outbox(main.db), await outbox(twin.db), "the outbox of the normal path");
    assert.deepEqual(await allBookings(main.db), await allBookings(twin.db), "the bookings of the normal path");

    // A later run finds nothing left to confirm and queues nothing twice.
    const later = await resolveStuck(depsOf(main.db, fakeSquare(payments), NOW + 10 * MINUTE_MS));
    assert.deepEqual(later, { confirmed: 0, reopened: 0, expired: 0, errors: [] });
    assert.equal((await outbox(main.db)).length, 3 * rows.length);
  } finally {
    await main.dispose();
    await twin.dispose();
  }
});

test("failed payments return to ON_HOLD", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const lapsedBike = await soloBike(shop);
    const liveBike = await soloBike(shop);
    const cases: [string, string, Row][] = [
      [
        "FAILED after its hold ran out",
        "FAILED",
        stuckRow(shop, NOW - 14 * MINUTE_MS, {
          created_at: NOW - 25 * MINUTE_MS,
          model_id: lapsedBike.modelId,
          vehicle_plate: lapsedBike.plate,
        }),
      ],
      ["CANCELED after its hold ran out", "CANCELED", stuckRow(shop, NOW - 20 * MINUTE_MS, { created_at: NOW - 30 * MINUTE_MS })],
      [
        "FAILED within its hold",
        "FAILED",
        stuckRow(shop, NOW - 7 * MINUTE_MS, {
          created_at: NOW - 9 * MINUTE_MS,
          model_id: liveBike.modelId,
          vehicle_plate: liveBike.plate,
        }),
      ],
      ["CANCELED within its hold", "CANCELED", stuckRow(shop, NOW - 6 * MINUTE_MS - 1, { created_at: NOW - 12 * MINUTE_MS })],
      // Square saw this one, so it is no unseen payment, however long it has waited.
      ["FAILED an hour ago", "FAILED", stuckRow(shop, NOW - HOUR_MS, { payment_attempt: 4 })],
    ];
    const seeded: BookingRow[] = [];
    for (const [, , row] of cases) seeded.push(await seedRow(db, row));
    const ledger = cases.map(([, status, row]) => paid(row, { status }));
    ledger.push(squarePayment(randomUUID(), "FAILED", 9_900, NOW - 10 * MINUTE_MS));
    await assertBikeHeld(shop, lapsedBike.modelId, NOW, "the charge in flight holds the bike");
    const square = fakeSquare(ledger);

    const result = await resolveStuck(depsOf(db, square));

    assert.deepEqual(result, { confirmed: 0, reopened: cases.length, expired: 0, errors: [] });
    for (const [index, [label]] of cases.entries()) await assertReopened(db, seeded[index] as BookingRow, NOW, label);
    assert.deepEqual(square.refunds, [], "a refund of money never taken");
    assert.deepEqual(square.charges, []);
    // An expired hold stops blocking once it is a hold again; a live one is still the guest's to pay.
    await assertBikeFree(shop, lapsedBike.modelId, NOW, "the bike of the lapsed hold");
    await assertBikeHeld(shop, liveBike.modelId, NOW, "the bike of the live hold");
  });
});

test("unseen payments expire after 30 minutes only", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const lateBike = await soloBike(shop);
    const youngBike = await soloBike(shop);
    const at31 = stuckRow(shop, NOW - 31 * MINUTE_MS, {
      created_at: NOW - 33 * MINUTE_MS,
      model_id: lateBike.modelId,
      vehicle_plate: lateBike.plate,
    });
    // Its hold was made 40 minutes ago, so an age read from created_at would expire it.
    const at29 = stuckRow(shop, NOW - 29 * MINUTE_MS, {
      created_at: NOW - 40 * MINUTE_MS,
      model_id: youngBike.modelId,
      vehicle_plate: youngBike.plate,
    });
    const at30 = stuckRow(shop, NOW - 30 * MINUTE_MS);
    const past30 = stuckRow(shop, NOW - 30 * MINUTE_MS - 1);
    const hoursAgo = stuckRow(shop, NOW - 5 * HOUR_MS);
    // Square has payments for these two, neither settled yet: seen, so never expired.
    const pending = stuckRow(shop, NOW - 45 * MINUTE_MS);
    const approved = stuckRow(shop, NOW - 2 * HOUR_MS);
    const seeded = new Map<string, BookingRow>();
    for (const row of [at31, at29, at30, past30, hoursAgo, pending, approved]) seeded.set(row.id, await seedRow(db, row));
    const before = (row: Row) => seeded.get(row.id) as BookingRow;
    const ledger = [
      paid(pending, { status: "PENDING" }),
      paid(approved, { status: "APPROVED" }),
      squarePayment(randomUUID(), "COMPLETED", 4_000, NOW - 20 * MINUTE_MS),
    ];
    await assertBikeHeld(shop, lateBike.modelId, NOW, "the charge in flight holds the bike");

    const first = await resolveStuck(depsOf(db, fakeSquare(ledger)));

    assert.deepEqual(first, { confirmed: 0, reopened: 0, expired: 3, errors: [] });
    await assertExpired(db, before(at31), NOW, "31 minutes");
    await assertExpired(db, before(past30), NOW, "30 minutes and a millisecond");
    await assertExpired(db, before(hoursAgo), NOW, "5 hours");
    await assertUntouched(db, before(at29), "29 minutes");
    await assertUntouched(db, before(at30), "30 minutes to the millisecond");
    await assertUntouched(db, before(pending), "a PENDING payment");
    await assertUntouched(db, before(approved), "an APPROVED payment");
    await assertBikeHeld(shop, youngBike.modelId, NOW, "the bike of the 29-minute booking");
    await assertBikeFree(shop, lateBike.modelId, NOW, "the bike of the expired booking");

    // Two minutes on, the 29- and the 30-minute ones are past it too, by the clock the run is given.
    const later = NOW + 2 * MINUTE_MS;
    const square = fakeSquare(ledger);
    const second = await resolveStuck(depsOf(db, square, later));

    assert.deepEqual(second, { confirmed: 0, reopened: 0, expired: 2, errors: [] });
    await assertExpired(db, before(at29), later, "29 minutes, two minutes on");
    await assertExpired(db, before(at30), later, "30 minutes, two minutes on");
    await assertUntouched(db, before(pending), "a PENDING payment, two minutes on");
    await assertUntouched(db, before(approved), "an APPROVED payment, two minutes on");
    await assertBikeFree(shop, youngBike.modelId, later, "the bike of the 29-minute booking, two minutes on");
    assert.deepEqual(square.refunds, []);
    assert.deepEqual(square.charges, []);
  });
});

test("the completed attempt wins over a declined one", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const rows = [0, 1, 2, 3, 4].map((index) => stuckRow(shop, NOW - (8 + 3 * index) * MINUTE_MS));
    const [r1, r2, r3, r4, r5] = rows as [Row, Row, Row, Row, Row];
    const seeded = await Promise.all(rows.map((row) => seedRow(db, row)));
    const attempt = (row: Row, status: string, seconds: number) =>
      squarePayment(row.id, status, row.deposit_jpy, row.updated_at + seconds * SECOND_MS);
    const winners = [attempt(r1, "COMPLETED", 40), attempt(r2, "COMPLETED", 5), attempt(r3, "COMPLETED", 90), attempt(r4, "COMPLETED", 10)];
    // Whichever comes first, last, newest or oldest, some booking's COMPLETED payment is not it.
    const ledger = [
      attempt(r1, "FAILED", 2),
      winners[1] as SquareRecord,
      attempt(r3, "FAILED", 3),
      winners[0] as SquareRecord,
      attempt(r4, "CANCELED", 50),
      attempt(r5, "FAILED", 1),
      attempt(r2, "FAILED", 60),
      winners[2] as SquareRecord,
      attempt(r3, "CANCELED", 30),
      attempt(r5, "CANCELED", 20),
      winners[3] as SquareRecord,
    ];
    const square = fakeSquare(ledger);

    const result = await resolveStuck(depsOf(db, square));

    assert.deepEqual(result, { confirmed: 4, reopened: 1, expired: 0, errors: [] });
    for (const [index, winner] of winners.entries()) {
      await assertConfirmed(db, seeded[index] as BookingRow, winner, NOW, `booking ${index + 1}`);
    }
    // Two declines and no COMPLETED payment: a decline, not a confirmation.
    await assertReopened(db, seeded[4] as BookingRow, NOW, "two declines");
    assert.deepEqual(square.refunds, [], "a refund of the payment that confirmed");
    assert.deepEqual(square.charges, []);
  });
});

test("the completed attempt wins over an unsettled one", async () => {
  const tag = randomUUID().slice(0, 8);
  const main = await openShop(tag);
  const twin = await openShop(tag);
  try {
    // [the unsettled attempt's status, the COMPLETED one is the older, the ledger lists it first]. Each status in both
    // orders and both ages, so neither the first listed, the last listed, the newest nor the oldest attempt is the one to
    // go by in every case.
    const plans: [string, boolean, boolean][] = [];
    for (const unsettled of ["PENDING", "APPROVED"]) {
      for (const completedOlder of [true, false]) {
        for (const completedFirst of [true, false]) plans.push([unsettled, completedOlder, completedFirst]);
      }
    }
    const cases: { label: string; row: Row; booking: BookingRow; completed: SquareRecord }[] = [];
    const ledger: SquareRecord[] = [];
    for (const [index, [unsettled, completedOlder, completedFirst]] of plans.entries()) {
      // From 6 to 41 minutes on, so some are past the age at which an unseen payment would expire.
      const row = stuckRow(main, NOW - (6 + 5 * index) * MINUTE_MS);
      for (const db of [main.db, twin.db]) await seedRow(db, row);
      const earlier = row.created_at + randomInt(10, 50) * SECOND_MS;
      const later = row.updated_at + randomInt(1, 30) * SECOND_MS;
      const completed = paid(row, { at: completedOlder ? earlier : later });
      const open = paid(row, { status: unsettled, at: completedOlder ? later : earlier });
      ledger.push(...(completedFirst ? [completed, open] : [open, completed]));
      const age = completedOlder ? "older" : "newer";
      const label = `${unsettled} beside COMPLETED, the COMPLETED one ${age} and listed ${completedFirst ? "first" : "last"}`;
      cases.push({ label, row, booking: await stored(main.db, row.id), completed });
    }
    // A declined, a completed and an unsettled attempt under one reference, the completed one in the middle by list and age.
    const three = stuckRow(main, NOW - 44 * MINUTE_MS);
    for (const db of [main.db, twin.db]) await seedRow(db, three);
    const threeCompleted = paid(three, { at: three.updated_at + randomInt(1, 15) * SECOND_MS });
    ledger.push(
      paid(three, { status: "PENDING", at: three.updated_at + randomInt(16, 30) * SECOND_MS }),
      threeCompleted,
      paid(three, { status: "FAILED", at: three.created_at + randomInt(10, 50) * SECOND_MS }),
    );
    cases.push({
      label: "FAILED, COMPLETED and PENDING attempts",
      row: three,
      booking: await stored(main.db, three.id),
      completed: threeCompleted,
    });
    const square = fakeSquare(ledger);

    const result = await resolveStuck(depsOf(main.db, square));

    assert.deepEqual(result, { confirmed: cases.length, reopened: 0, expired: 0, errors: [] });
    for (const { label, booking, completed } of cases) await assertConfirmed(main.db, booking, completed, NOW, label);
    assert.deepEqual(square.refunds, [], "a refund of the payment that confirmed, or of one not yet settled");
    assert.deepEqual(square.charges, []);

    // The normal path, given each booking's COMPLETED payment at the same moment, on the same rows.
    const ctx = confirmContext(fakeSquare([]));
    for (const { label, row, completed } of cases) {
      assert.equal(await markConfirmed(twin.db, row.id, asDeposit(completed), NOW, ctx), "confirmed", label);
    }
    assert.deepEqual(await outbox(main.db), await outbox(twin.db), "the outbox of the normal path");
    assert.deepEqual(await allBookings(main.db), await allBookings(twin.db), "the bookings of the normal path");
  } finally {
    await main.dispose();
    await twin.dispose();
  }
});

test("two completed payments under one reference confirm the booking once and refund neither", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    // [label, minutes since the charge, the older payment is listed first]
    const plans: [string, number, boolean][] = [
      ["the older listed first", 9, true],
      ["the newer listed first", 33, false],
    ];
    const cases: { label: string; booking: BookingRow; payments: SquareRecord[] }[] = [];
    const ledger: SquareRecord[] = [];
    for (const [label, minutes, olderFirst] of plans) {
      const row = stuckRow(shop, NOW - minutes * MINUTE_MS);
      const booking = await seedRow(db, row);
      const older = paid(row, { at: row.updated_at + randomInt(1, 20) * SECOND_MS });
      const newer = paid(row, { at: row.updated_at + randomInt(21, 40) * SECOND_MS });
      ledger.push(...(olderFirst ? [older, newer] : [newer, older]));
      cases.push({ label, booking, payments: [older, newer] });
    }
    const square = fakeSquare(ledger);

    const result = await resolveStuck(depsOf(db, square));

    assert.deepEqual(
      { confirmed: result.confirmed, reopened: result.reopened, expired: result.expired },
      { confirmed: plans.length, reopened: 0, expired: 0 },
    );
    for (const { label, booking, payments } of cases) {
      const { payment_id: paymentId } = await stored(db, booking.id);
      const chosen = payments.find(({ id }) => id === paymentId);
      assert.ok(chosen, `${label}: confirmed on ${paymentId}, which is neither of its payments`);
      await assertConfirmed(db, booking, chosen, NOW, label);
    }
    assert.deepEqual(square.refunds, [], "a refund of the duplicate, which is #43's to report");
    assert.deepEqual(square.charges, []);
  });
});

test("an unsettled attempt beside a declined one leaves the booking alone", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    // [label, the declined attempt's status, the unsettled one's, the decline is the older, the ledger lists it first].
    // Each pair in both orders, and the decline older in one pair and newer in the other, so neither the first listed,
    // the last listed, the newest nor the oldest attempt is the one to go by in every case.
    const plans: [string, string, string, boolean, boolean][] = [
      ["a PENDING retry listed after its FAILED attempt", "FAILED", "PENDING", true, true],
      ["a PENDING retry listed before its FAILED attempt", "FAILED", "PENDING", true, false],
      ["an APPROVED attempt listed after a later CANCELED one", "CANCELED", "APPROVED", false, true],
      ["an APPROVED attempt listed before a later CANCELED one", "CANCELED", "APPROVED", false, false],
    ];
    const cases: { label: string; booking: BookingRow; modelId: string }[] = [];
    const ledger: SquareRecord[] = [];
    for (const [index, [label, declined, unsettled, declineOlder, declineFirst]] of plans.entries()) {
      const bike = await soloBike(shop);
      // Past 30 minutes and past its hold, so a reopening or an expiry would each free the bike.
      const row = stuckRow(shop, NOW - (34 + 4 * index) * MINUTE_MS, { model_id: bike.modelId, vehicle_plate: bike.plate });
      const booking = await seedRow(db, row);
      const earlier = row.created_at + randomInt(10, 50) * SECOND_MS;
      const later = row.updated_at + randomInt(1, 30) * SECOND_MS;
      const decline = squarePayment(row.id, declined, row.deposit_jpy, declineOlder ? earlier : later);
      const open = squarePayment(row.id, unsettled, row.deposit_jpy, declineOlder ? later : earlier);
      ledger.push(...(declineFirst ? [decline, open] : [open, decline]));
      cases.push({ label, booking, modelId: bike.modelId });
    }
    // A decline with nothing beside it, in the same run, which does reopen.
    const aloneBike = await soloBike(shop);
    const alone = stuckRow(shop, NOW - 36 * MINUTE_MS, { model_id: aloneBike.modelId, vehicle_plate: aloneBike.plate });
    const aloneBooking = await seedRow(db, alone);
    ledger.splice(3, 0, paid(alone, { status: "FAILED" }));
    for (const { label, modelId } of cases) await assertBikeHeld(shop, modelId, NOW, `${label}: the charge in flight`);
    const square = fakeSquare(ledger);

    const result = await resolveStuck(depsOf(db, square));

    assert.deepEqual(result, { confirmed: 0, reopened: 1, expired: 0, errors: [] });
    for (const { label, booking } of cases) await assertUntouched(db, booking, label);
    await assertReopened(db, aloneBooking, NOW, "a decline alone");
    assert.deepEqual(square.refunds, [], "a refund of money not yet settled");
    assert.deepEqual(square.charges, []);
    for (const { label, modelId } of cases) await assertBikeHeld(shop, modelId, NOW, `${label}: its bike`);
    await assertBikeFree(shop, aloneBike.modelId, NOW, "the bike of the decline alone");
  });
});

test("a payment in a status the run does not know leaves its booking alone", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    // [label, minutes since the charge, each attempt as its status and its seconds from the charge, in ledger order]. All
    // past 30 minutes and past their holds, so a reopening or an expiry would each free the bike.
    const plans: [string, number, [string, number][]][] = [
      ["VOIDED alone", 45, [["VOIDED", 20]]],
      ["DISPUTED alone, two hours on", 120, [["DISPUTED", 5]]],
      [
        "a VOIDED retry listed after its FAILED attempt",
        35,
        [
          ["FAILED", -40],
          ["VOIDED", 15],
        ],
      ],
      [
        "a DISPUTED attempt listed after a later CANCELED one",
        52,
        [
          ["CANCELED", 25],
          ["DISPUTED", -30],
        ],
      ],
    ];
    const cases: { label: string; booking: BookingRow; modelId: string }[] = [];
    const ledger: SquareRecord[] = [];
    for (const [label, minutes, attempts] of plans) {
      const bike = await soloBike(shop);
      const row = stuckRow(shop, NOW - minutes * MINUTE_MS, { model_id: bike.modelId, vehicle_plate: bike.plate });
      cases.push({ label, booking: await seedRow(db, row), modelId: bike.modelId });
      for (const [status, seconds] of attempts) ledger.push(paid(row, { status, at: row.updated_at + seconds * SECOND_MS }));
    }
    // A COMPLETED attempt beside one of a status the run does not know confirms, in either order.
    const confirmable: { label: string; booking: BookingRow; completed: SquareRecord }[] = [];
    for (const [label, minutes, completedFirst] of [
      ["COMPLETED listed before a later VOIDED attempt", 14, true],
      ["COMPLETED listed after an earlier DISPUTED attempt", 38, false],
    ] as [string, number, boolean][]) {
      const row = stuckRow(shop, NOW - minutes * MINUTE_MS);
      const completed = paid(row, { at: row.updated_at + randomInt(1, 15) * SECOND_MS });
      const other = completedFirst
        ? paid(row, { status: "VOIDED", at: row.updated_at + randomInt(16, 30) * SECOND_MS })
        : paid(row, { status: "DISPUTED", at: row.created_at + randomInt(10, 50) * SECOND_MS });
      ledger.push(...(completedFirst ? [completed, other] : [other, completed]));
      confirmable.push({ label, booking: await seedRow(db, row), completed });
    }
    // In the same run, a decline alone, which reopens, and a booking Square has nothing for, which expires.
    const declinedBike = await soloBike(shop);
    const declined = stuckRow(shop, NOW - 38 * MINUTE_MS, { model_id: declinedBike.modelId, vehicle_plate: declinedBike.plate });
    const declinedBooking = await seedRow(db, declined);
    ledger.splice(2, 0, paid(declined, { status: "FAILED" }));
    const unseenBike = await soloBike(shop);
    const unseen = stuckRow(shop, NOW - 41 * MINUTE_MS, { model_id: unseenBike.modelId, vehicle_plate: unseenBike.plate });
    const unseenBooking = await seedRow(db, unseen);
    for (const { label, modelId } of cases) await assertBikeHeld(shop, modelId, NOW, `${label}: the charge in flight`);
    const square = fakeSquare(ledger);

    const result = await resolveStuck(depsOf(db, square));

    assert.deepEqual(
      { confirmed: result.confirmed, reopened: result.reopened, expired: result.expired },
      { confirmed: confirmable.length, reopened: 1, expired: 1 },
    );
    for (const { label, booking } of cases) await assertUntouched(db, booking, label);
    for (const { label, booking, completed } of confirmable) await assertConfirmed(db, booking, completed, NOW, label);
    await assertReopened(db, declinedBooking, NOW, "a decline alone");
    await assertExpired(db, unseenBooking, NOW, "no payment, 41 minutes on");
    assert.deepEqual(square.refunds, [], "a refund of money in a state the run does not know");
    assert.deepEqual(square.charges, []);
    for (const { label, modelId } of cases) await assertBikeHeld(shop, modelId, NOW, `${label}: its bike`);
    await assertBikeFree(shop, declinedBike.modelId, NOW, "the bike of the decline alone");
    await assertBikeFree(shop, unseenBike.modelId, NOW, "the bike of the expired booking");
  });
});

test("Square errors change nothing", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const toConfirm = stuckRow(shop, NOW - 10 * MINUTE_MS);
    const toReopen = stuckRow(shop, NOW - 15 * MINUTE_MS);
    // With no list to read, an expiry here would free a bike Square may well have been paid for.
    const toExpire = stuckRow(shop, NOW - 2 * HOUR_MS);
    const young = stuckRow(shop, NOW - 8 * MINUTE_MS);
    for (const row of [toConfirm, toReopen, toExpire, young]) await seedRow(db, row);
    const before = await allBookings(db);
    const queued = await outbox(db);
    const failures: [string, ListAnswer][] = [
      ["an error", () => ({ kind: "error", code: "UNAUTHORIZED", detail: `Not authorized ${randomUUID()}` })],
      ["a rate limit", () => ({ kind: "error", code: "RATE_LIMITED", detail: "Too many requests" })],
      ["no answer", () => ({ kind: "unknown", detail: "Square answered HTTP 503" })],
      ["an unusable page", () => ({ kind: "unknown", detail: "Square answered with an unusable page of payments" })],
      [
        "a rejected call",
        async () => {
          throw new Error(`socket hang up ${randomUUID()}`);
        },
      ],
    ];

    for (const [label, answer] of failures) {
      const square = fakeSquare(answer);

      const result = await resolveStuck(depsOf(db, square));

      assert.deepEqual({ ...result, errors: [] }, { confirmed: 0, reopened: 0, expired: 0, errors: [] }, label);
      assert.ok(result.errors.length > 0, `${label}: not reported`);
      for (const error of result.errors) assert.ok(typeof error === "string" && error.length > 0, `${label}: ${error}`);
      assert.deepEqual(await allBookings(db), before, `${label}: the bookings`);
      assert.deepEqual(await outbox(db), queued, `${label}: the outbox`);
      assert.deepEqual(square.refunds, [], label);
      assert.deepEqual(square.charges, [], label);
    }

    // The same rows do move once Square answers, so nothing above stayed put for want of a reason to move.
    const answered = await resolveStuck(depsOf(db, fakeSquare([paid(toConfirm), paid(toReopen, { status: "FAILED" })])));
    assert.deepEqual(answered, { confirmed: 1, reopened: 1, expired: 1, errors: [] });
  });
});

test("one listPayments call spans the stuck bookings from a minute before the oldest was made", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const at = NOW + randomInt(1, 10 * MINUTE_MS);
    const oldest = stuckRow(shop, at - 2 * HOUR_MS - 55 * MINUTE_MS, { created_at: at - 3 * HOUR_MS });
    const failed = stuckRow(shop, at - 38 * MINUTE_MS);
    const unseenOld = stuckRow(shop, at - 45 * MINUTE_MS);
    const unseenYoung = stuckRow(shop, at - 7 * MINUTE_MS);
    // Older rows the run has no business with, which must not stretch the window, and one not yet stuck.
    const confirmedAt = at - 19 * DAY_MS;
    const others = [
      stuckRow(shop, confirmedAt, {
        status: "CONFIRMED",
        created_at: at - 20 * DAY_MS,
        payment_id: `sq-${randomUUID()}`,
        paid_jpy: 3_000,
        confirmed_at: confirmedAt,
      }),
      stuckRow(shop, at - 5 * HOUR_MS, { status: "ON_HOLD", created_at: at - 5 * HOUR_MS - 5 * MINUTE_MS }),
      stuckRow(shop, at - 6 * HOUR_MS, { status: "EXPIRED", created_at: at - 6 * HOUR_MS - MINUTE_MS }),
      stuckRow(shop, at - 2 * MINUTE_MS),
    ];
    const seeded = new Map<string, BookingRow>();
    for (const row of [oldest, failed, unseenOld, unseenYoung, ...others]) seeded.set(row.id, await seedRow(db, row));
    const before = (row: Row) => seeded.get(row.id) as BookingRow;
    // Square's clock runs 30 seconds behind the Worker's, which the minute's margin is for.
    const skewed = paid(oldest, { at: oldest.created_at - 30 * SECOND_MS });
    const ledger = [skewed, paid(failed, { status: "FAILED" }), paid(others[3] as Row, { at: at - MINUTE_MS })];
    const square = fakeSquare(ledger);

    const result = await resolveStuck(depsOf(db, square, at));

    assert.equal(square.listings.length, 1, "listPayments calls");
    const [asked] = square.listings as [SquareTimeWindow];
    assert.equal(asked.beginTime, oldest.created_at - MINUTE_MS, "the window's begin");
    assert.equal(asked.endTime, at, "the window's end");
    assert.deepEqual(result, { confirmed: 1, reopened: 1, expired: 1, errors: [] });
    await assertConfirmed(db, before(oldest), skewed, at, "the oldest, paid on Square's clock");
    await assertReopened(db, before(failed), at, "the declined one");
    await assertExpired(db, before(unseenOld), at, "the unseen one, 45 minutes on");
    await assertUntouched(db, before(unseenYoung), "the unseen one, 7 minutes on");
    for (const row of others) await assertUntouched(db, before(row), `a ${row.status} booking`);
  });
});

test("only PAYMENT_PENDING bookings untouched for more than 5 minutes are resolved", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const old = NOW - 2 * HOUR_MS;
    const settled = { payment_id: `sq-${randomUUID()}`, confirmed_at: old - HOUR_MS };
    const staffBlock = {
      status: "CONFIRMED",
      source: "block",
      price_jpy: null,
      deposit_jpy: null,
      guest_family_name: null,
      guest_given_name: null,
      guest_email: null,
      guest_phone: null,
      external_ref: `OTA-${randomUUID().slice(0, 8)}`,
      external_channel: "rakuten",
    };
    // Each with a payment Square has under its id: [label, row, the payment's status].
    const left: [string, Row, string][] = [
      ["an ON_HOLD booking whose hold ran out", stuckRow(shop, old, { status: "ON_HOLD" }), "COMPLETED"],
      ["another ON_HOLD booking", stuckRow(shop, old, { status: "ON_HOLD" }), "FAILED"],
      ["a CONFIRMED booking", stuckRow(shop, old, { status: "CONFIRMED", ...settled }), "COMPLETED"],
      [
        "a CANCELLED booking",
        stuckRow(shop, old, { status: "CANCELLED", ...settled, cancelled_at: old, cancel_reason: "guest" }),
        "COMPLETED",
      ],
      ["an EXPIRED booking", stuckRow(shop, old, { status: "EXPIRED" }), "FAILED"],
      ["a staff block", stuckRow(shop, old, staffBlock), "COMPLETED"],
      ["charged 4 minutes ago", stuckRow(shop, NOW - 4 * MINUTE_MS), "COMPLETED"],
      ["charged 5 minutes ago to the millisecond", stuckRow(shop, NOW - 5 * MINUTE_MS), "FAILED"],
      ["charged just now", stuckRow(shop, NOW), "COMPLETED"],
    ];
    const due = stuckRow(shop, NOW - 5 * MINUTE_MS - 1);
    const dueBooking = await seedRow(db, due);
    const seeded: BookingRow[] = [];
    for (const [, row] of left) seeded.push(await seedRow(db, row));
    const duePayment = paid(due, { at: NOW - 5 * MINUTE_MS });
    // Every one inside the window the due booking opens, so the fake lists them all.
    const inWindow = (row: Row) => Math.max(row.updated_at, NOW - 3 * MINUTE_MS);
    const ledger = [
      ...left.map(([, row, status]) => squarePayment(row.id, status, row.deposit_jpy ?? 5_000, inWindow(row))),
      duePayment,
    ];
    const square = fakeSquare(ledger);

    const result = await resolveStuck(depsOf(db, square));

    assert.deepEqual(result, { confirmed: 1, reopened: 0, expired: 0, errors: [] });
    await assertConfirmed(db, dueBooking, duePayment, NOW, "charged 5 minutes and a millisecond ago");
    for (const [index, [label]] of left.entries()) await assertUntouched(db, seeded[index] as BookingRow, label);
    assert.equal((await outbox(db)).length, 3, "the outbox holds one confirmation");
    assert.deepEqual(square.refunds, [], "a refund for a booking the run has no business with");
    assert.deepEqual(square.charges, []);
  });
});

test("a payment confirms only the booking its reference_id names", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const quiet = stuckRow(shop, NOW - 10 * MINUTE_MS);
    const lapsed = stuckRow(shop, NOW - 40 * MINUTE_MS);
    const paidFor = stuckRow(shop, NOW - 20 * MINUTE_MS);
    const fresh = stuckRow(shop, NOW - MINUTE_MS);
    const hold = stuckRow(shop, NOW - HOUR_MS, { status: "ON_HOLD" });
    const seeded = new Map<string, BookingRow>();
    for (const row of [quiet, lapsed, paidFor, fresh, hold]) seeded.set(row.id, await seedRow(db, row));
    const before = (row: Row) => seeded.get(row.id) as BookingRow;
    /** References a forged or mangled payment could carry, each close to `id` and none of them it. */
    const nearMisses = (id: string) =>
      [id.toUpperCase(), ` ${id}`, `${id} `, id.slice(0, -1), `${id}0`, id.replaceAll("-", "")].filter((ref) => ref !== id);
    const own = paid(paidFor);
    const ledger = [
      ...nearMisses(quiet.id).map((ref) => squarePayment(ref, "COMPLETED", quiet.deposit_jpy, NOW - 9 * MINUTE_MS)),
      ...nearMisses(lapsed.id).map((ref) => squarePayment(ref, "FAILED", lapsed.deposit_jpy, NOW - 39 * MINUTE_MS)),
      ...nearMisses(paidFor.id).map((ref) => squarePayment(ref, "COMPLETED", paidFor.deposit_jpy + 1, NOW - 19 * MINUTE_MS)),
      own,
      // Payments of bookings outside the stuck set, of no booking, and a Dashboard sale with no reference.
      paid(fresh),
      paid(hold, { at: NOW - 15 * MINUTE_MS }),
      squarePayment(randomUUID(), "COMPLETED", quiet.deposit_jpy, NOW - 14 * MINUTE_MS),
      squarePayment(null, "COMPLETED", lapsed.deposit_jpy, NOW - 12 * MINUTE_MS),
    ];
    const square = fakeSquare(ledger);

    const result = await resolveStuck(depsOf(db, square));

    assert.deepEqual(result, { confirmed: 1, reopened: 0, expired: 1, errors: [] });
    await assertConfirmed(db, before(paidFor), own, NOW, "the booking with its own payment");
    await assertExpired(db, before(lapsed), NOW, "40 minutes with only others' payments");
    await assertUntouched(db, before(quiet), "10 minutes with only others' payments");
    await assertUntouched(db, before(fresh), "a booking not yet stuck, though Square has its payment");
    await assertUntouched(db, before(hold), "an ON_HOLD booking Square has a payment for");
    assert.deepEqual(square.refunds, [], "a refund of a payment that names another booking");
    assert.deepEqual(square.charges, []);
  });
});

test("a run handles at most 20 bookings and the next run the rest", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const plan = [...Array<string>(12).fill("COMPLETED"), ...Array<string>(7).fill("FAILED"), ...Array<null>(6).fill(null)];
    const rows = plan.map((status, index) => stuckRow(shop, NOW - (status === null ? 31 + index : 6 + index) * MINUTE_MS));
    for (const row of rows) await seedRow(db, row);
    const ledger = rows.flatMap((row, index) => {
      const status = plan[index] ?? null;
      return status === null ? [] : [paid(row, { status })];
    });
    const tally = async () => {
      const counts: Record<string, number> = {};
      for (const { status } of await allBookings(db)) counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    };

    const firstSquare = fakeSquare(ledger);
    const first = await resolveStuck(depsOf(db, firstSquare));

    assert.deepEqual(first.errors, []);
    assert.equal(first.confirmed + first.reopened + first.expired, 20, JSON.stringify(first));
    const afterFirst = await tally();
    assert.equal(afterFirst.PAYMENT_PENDING, 5, JSON.stringify(afterFirst));
    assert.equal(afterFirst.CONFIRMED ?? 0, first.confirmed, "confirmed");
    assert.equal(afterFirst.ON_HOLD ?? 0, first.reopened, "reopened");
    assert.equal(afterFirst.EXPIRED ?? 0, first.expired, "expired");
    assert.equal(firstSquare.listings.length, 1, "listPayments calls");
    const moved = (await allBookings(db)).filter(({ status }) => status !== "PAYMENT_PENDING");
    const asked = firstSquare.listings[0] as SquareTimeWindow;
    assert.ok(asked.beginTime <= Math.min(...moved.map(({ created_at }) => created_at)) - MINUTE_MS, "the window's begin");
    assert.equal(asked.endTime, NOW, "the window's end");

    const later = NOW + MINUTE_MS;
    const second = await resolveStuck(depsOf(db, fakeSquare(ledger), later));

    assert.deepEqual(second.errors, []);
    assert.deepEqual(
      { confirmed: first.confirmed + second.confirmed, reopened: first.reopened + second.reopened, expired: first.expired + second.expired },
      { confirmed: 12, reopened: 7, expired: 6 },
    );
    assert.deepEqual(await tally(), { CONFIRMED: 12, ON_HOLD: 7, EXPIRED: 6 });
    assert.equal((await outbox(db)).length, 3 * 12, "one confirmation each");

    const third = await resolveStuck(depsOf(db, fakeSquare(ledger), later + MINUTE_MS));
    assert.deepEqual(third, { confirmed: 0, reopened: 0, expired: 0, errors: [] });
  });
});

test("a completed payment of the wrong amount goes back as markConfirmed sends it", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const right = stuckRow(shop, NOW - 9 * MINUTE_MS);
    const wrong: [string, Row, (row: Row) => SquareRecord][] = [
      ["a yen over", stuckRow(shop, NOW - 11 * MINUTE_MS), (row) => paid(row, { amount: row.deposit_jpy + 1 })],
      ["a yen short", stuckRow(shop, NOW - 13 * MINUTE_MS), (row) => paid(row, { amount: row.deposit_jpy - 1 })],
      ["the deposit in dollars", stuckRow(shop, NOW - 15 * MINUTE_MS), (row) => paid(row, { currency: "USD" })],
      ["the whole price", stuckRow(shop, NOW - 40 * MINUTE_MS), (row) => paid(row, { amount: row.price_jpy ?? 0 })],
    ];
    const rightBooking = await seedRow(db, right);
    const rightPayment = paid(right);
    const seeded: BookingRow[] = [];
    const payments: SquareRecord[] = [];
    for (const [, row, pay] of wrong) {
      seeded.push(await seedRow(db, row));
      payments.push(pay(row));
    }
    const square = fakeSquare([...payments, rightPayment]);

    const result = await resolveStuck(depsOf(db, square));

    assert.deepEqual(result.errors, []);
    assert.equal(result.confirmed, 1, "confirmed");
    assert.equal(result.expired, 0, "expired");
    await assertConfirmed(db, rightBooking, rightPayment, NOW, "the deposit to the yen");
    assert.equal(square.refunds.length, wrong.length, "refunds");
    for (const [index, [label]] of wrong.entries()) {
      const booking = seeded[index] as BookingRow;
      const payment = payments[index] as SquareRecord;
      await assertReopened(db, booking, NOW, label);
      const refunds = square.refunds.filter(({ paymentId }) => paymentId === payment.id);
      assert.equal(refunds.length, 1, `${label}: refunds of its payment`);
      const [refund] = refunds as [RefundPaymentInput];
      assert.equal(refund.amountJpy, payment.amount, `${label}: the refund is the whole payment`);
      assert.ok(refund.idempotencyKey.length <= MAX_KEY_LENGTH, `${label}: the key ${refund.idempotencyKey}`);
      assert.notEqual(refund.idempotencyKey, `rf:${booking.id}`, `${label}: the cancel refund's key`);
    }
    assert.deepEqual(square.charges, []);
  });
});

test("with nothing stuck, Square is not asked", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const empty = fakeSquare([]);
    assert.deepEqual(await resolveStuck(depsOf(db, empty)), { confirmed: 0, reopened: 0, expired: 0, errors: [] });
    assert.deepEqual(empty.listings, [], "an empty table");

    const fresh = stuckRow(shop, NOW - 3 * MINUTE_MS);
    const rows = [
      stuckRow(shop, NOW - DAY_MS, { status: "CONFIRMED", payment_id: `sq-${randomUUID()}`, confirmed_at: NOW - DAY_MS }),
      stuckRow(shop, NOW - HOUR_MS, { status: "ON_HOLD" }),
      stuckRow(shop, NOW - 2 * HOUR_MS, { status: "EXPIRED" }),
      fresh,
    ];
    const seeded: BookingRow[] = [];
    for (const row of rows) seeded.push(await seedRow(db, row));
    const square = fakeSquare([paid(fresh)]);

    assert.deepEqual(await resolveStuck(depsOf(db, square)), { confirmed: 0, reopened: 0, expired: 0, errors: [] });
    assert.deepEqual(square.listings, [], "rows none of which is stuck");
    for (const booking of seeded) await assertUntouched(db, booking, `a ${booking.status} booking`);

    // Three minutes on, the fresh one is stuck, and Square is asked about it.
    const later = NOW + 3 * MINUTE_MS;
    const asked = fakeSquare([paid(fresh)]);
    assert.deepEqual(await resolveStuck(depsOf(db, asked, later)), { confirmed: 1, reopened: 0, expired: 0, errors: [] });
    assert.equal(asked.listings.length, 1, "listPayments calls once a booking is stuck");
  });
});

test("a booking the webhook confirms during the run stays confirmed", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const scenarios: [string, (row: Row) => SquareRecord[], keyof Counts][] = [
      ["an expiry", () => [], "expired"],
      ["a reopening", (row) => [paid(row, { status: "FAILED" })], "reopened"],
    ];
    for (const [label, ledgerOf, count] of scenarios) {
      const row = stuckRow(shop, NOW - 40 * MINUTE_MS);
      const booking = await seedRow(db, row);
      const webhookPayment = `sq-${randomUUID()}`;
      const confirmedAt = NOW - SECOND_MS;
      const { db: racing, raced } = raceBeforeUpdate(db, () =>
        db.prepare(CONFIRMED_BY_ANOTHER).bind(row.id, webhookPayment, confirmedAt).run(),
      );

      const result = await resolveStuck(depsOf(racing, fakeSquare(ledgerOf(row))));

      assert.ok(raced(), `${label}: the run never wrote the booking`);
      assert.deepEqual(
        await stored(db, row.id),
        {
          ...booking,
          status: "CONFIRMED",
          payment_id: webhookPayment,
          paid_jpy: booking.deposit_jpy,
          confirmed_at: confirmedAt,
          updated_at: confirmedAt,
        },
        `${label}: the webhook's confirmation`,
      );
      assert.equal(result[count], 0, `${label}: counted a change it did not make`);
    }
  });
});

test("a booking the webhook confirms on the same payment during the run is confirmed once and not counted", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    // One stuck booking per run, so the first write the run makes is this booking's.
    for (const [label, minutes] of [
      ["12 minutes on", 12],
      ["past 30 minutes", 41],
    ] as [string, number][]) {
      const row = stuckRow(shop, NOW - minutes * MINUTE_MS);
      const booking = await seedRow(db, row);
      const payment = paid(row);
      // The webhook's moment is its own, so the row says whose write confirmed it.
      const confirmedAt = NOW - randomInt(1, 30) * SECOND_MS;
      const webhookSquare = fakeSquare([]);
      let webhook: MarkResult | undefined;
      let queuedByWebhook: OutboxRow[] = [];
      const { db: racing, raced } = raceBeforeUpdate(db, async () => {
        webhook = await markConfirmed(db, row.id, asDeposit(payment), confirmedAt, confirmContext(webhookSquare));
        queuedByWebhook = await outbox(db);
      });
      const square = fakeSquare([payment]);

      const result = await resolveStuck(depsOf(racing, square));

      assert.ok(raced(), `${label}: the run never wrote the booking`);
      assert.equal(webhook, "confirmed", `${label}: the webhook's own confirmation`);
      assert.deepEqual(
        { confirmed: result.confirmed, reopened: result.reopened, expired: result.expired },
        { confirmed: 0, reopened: 0, expired: 0 },
        `${label}: counted a confirmation the webhook made`,
      );
      await assertConfirmed(db, booking, payment, confirmedAt, `${label}: the webhook's confirmation`);
      assert.deepEqual(await outbox(db), queuedByWebhook, `${label}: the webhook's items, once`);
      assert.deepEqual(square.refunds, [], `${label}: a refund of the payment that confirmed`);
      assert.deepEqual(webhookSquare.refunds, [], `${label}: a refund on the webhook's side`);
      assert.deepEqual(square.charges, [], label);
    }
  });
});

test("a booking declined and charged again during the run is left to its new charge", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    // What the run read would expire or reopen the booking; by the time it writes, the booking is on a later attempt.
    const scenarios: [string, (row: Row) => SquareRecord[]][] = [
      ["an expiry", () => []],
      ["a reopening", (row) => [paid(row, { status: "FAILED" })]],
    ];
    for (const [label, ledgerOf] of scenarios) {
      const row = stuckRow(shop, NOW - 40 * MINUTE_MS);
      const booking = await seedRow(db, row);
      const { db: racing, raced } = raceBeforeUpdate(db, () => db.prepare(CHARGED_AGAIN).bind(row.id, NOW).run());
      const square = fakeSquare(ledgerOf(row));

      const result = await resolveStuck(depsOf(racing, square));

      assert.ok(raced(), `${label}: the run never wrote the booking`);
      assert.deepEqual(
        await stored(db, row.id),
        { ...booking, payment_attempt: booking.payment_attempt + 1, updated_at: NOW },
        `${label}: the new charge`,
      );
      assert.deepEqual(itemsOf(await outbox(db), row.id), [], `${label}: the outbox`);
      assert.deepEqual(
        { confirmed: result.confirmed, reopened: result.reopened, expired: result.expired },
        { confirmed: 0, reopened: 0, expired: 0 },
        `${label}: counted a change it did not make`,
      );
      assert.deepEqual(square.refunds, [], label);
      assert.deepEqual(square.charges, [], label);
    }
  });
});
