// cancelBooking and retryRefunds, src/lib/booking/cancel.ts, on a real D1 with Square scripted. Refunds are worked out by
// hand and written as literals, and instants come from Date.parse on an explicit +09:00 offset, so no expected value
// passes through src/lib/time.ts or the code under test. Mail goes through the real templates, because the ticket asks
// that what the outbox holds renders. Total refunds equal the tier, so refunds a booking already has come off its quote:
// the fixtures before AFTER_EARLIER have none, and the tests from there on pin the rule.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { searchAvailability } from "../src/lib/booking/availability.ts";
import { createHold } from "../src/lib/booking/holds.ts";
import { LOCALES } from "../src/lib/locale.ts";
import type { Locale } from "../src/lib/locale.ts";
import { renderEmail } from "../src/lib/mail/templates.ts";
import type { EmailPayload } from "../src/lib/outbox.ts";
import type { RefundPaymentInput, RefundResult, SquareClient } from "../src/lib/square/client.ts";
import { createTestDb } from "./helpers/d1.ts";
import {
  insertRow,
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedTiers,
  seedVehicle,
} from "./helpers/seed.ts";
import type { BookingRow, TierRow } from "./helpers/seed.ts";

/** Loaded inside each test, after its fixtures, so a test fails on these functions alone and a bad fixture shows first. */
const cancelModule = () => import("../src/lib/booking/cancel.ts");

type Shop = { db: D1Database; modelId: string; packageId: string };

type RefundRow = {
  id: string;
  booking_id: string;
  square_refund_id: string | null;
  amount_jpy: number;
  status: string;
  origin: string;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
};

type OutboxRow = { id: number; kind: string; dedupe_key: string; payload: string; status: string };

/** What Square does with one refundPayment call. A throw stands for a client that broke. */
type Answer = (input: RefundPaymentInput) => RefundResult | Promise<RefundResult>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const STAFF_EMAIL = "desk@okinawa-dream.example";
const SITE_URL = "https://okinawa-dream.example";
const SHOP_OPEN = "08:30";
const SHOP_CLOSE = "19:00";

/** The instant of a JST wall clock written "YYYY-MM-DD HH:mm". */
function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

const TIERS: TierRow[] = [
  { min_days_before: 14, refund_percent: 100 },
  { min_days_before: 7, refund_percent: 50 },
  { min_days_before: 2, refund_percent: 33 },
];

/** Nine days before PICKUP, so 50% under TIERS. */
const NOW = jst("2030-06-01 12:00");
const PICKUP = "2030-06-10 09:00";

const MAIL_RECEIPT = ["guest_cancellation", "sheet_booking", "staff_cancellation"];

/** The same fields under every locale, each name marked with its locale, so one locale's text standing in for another's shows. */
function localeTexts(name: string, fields: Record<string, string> = {}): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, { ...fields, name: `${name} ${locale}` }])));
}

/** A published shop on a fresh database: a model with no vehicles yet and a one-day package priced for it. */
async function withShop(run: (shop: Shop) => Promise<void>, tiers: TierRow[] = TIERS): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedConfig(db, { shop_open: SHOP_OPEN, shop_close: SHOP_CLOSE });
    await seedCatalogMeta(db);
    await seedTiers(db, tiers);
    const model = await seedModel(db, { texts: localeTexts("Vino", { summary: "A summary", description: "A description" }) });
    const pkg = await seedPackage(db, { days: 1, texts: localeTexts("One day") });
    await seedPrice(db, { rate_class_id: model.rate_class_id, package_id: pkg.id });
    await run({ db, modelId: model.id, packageId: pkg.id });
  } finally {
    await dispose();
  }
}

let lastBooking = 0;

/**
 * A CONFIRMED web booking with a real-shaped id, whose paid, deposit and price all differ, so the refund shows which one
 * it came from. Refs have one width, so that no ref is found inside another.
 */
function bookingOf(shop: Shop, pickup: string, paid: number, change: Partial<BookingRow> = {}): Promise<BookingRow> {
  lastBooking += 1;
  const start_at = jst(pickup);
  return seedBooking(shop.db, {
    id: randomUUID(),
    ref: `R${String(lastBooking).padStart(7, "0")}`,
    model_id: shop.modelId,
    package_id: shop.packageId,
    start_at,
    end_at: start_at + 3 * DAY_MS,
    paid_jpy: paid,
    deposit_jpy: paid + 1000,
    price_jpy: paid + 20_000,
    payment_id: `square-payment-${lastBooking}`,
    guest_family_name: `Higa${lastBooking}`,
    guest_given_name: `Naomi${lastBooking}`,
    guest_email: `guest-${lastBooking}@example.com`,
    guest_phone: `+81-90-0000-${String(lastBooking).padStart(4, "0")}`,
    ...change,
  });
}

/** The refund row of `booking`, by default as cancelBooking leaves it when the first attempt had no clear result. */
async function refundOf(shop: Shop, booking: BookingRow, partial: Partial<RefundRow> = {}): Promise<RefundRow> {
  return insertRow<RefundRow>(shop.db, "refunds", {
    id: randomUUID(),
    booking_id: booking.id,
    square_refund_id: null,
    amount_jpy: 1500,
    status: "RETRY",
    origin: "cancel",
    idempotency_key: `rf:${booking.id}`,
    created_at: NOW,
    updated_at: NOW,
    ...partial,
  });
}

function cancelledBooking(shop: Shop, paid = 3000): Promise<BookingRow> {
  return bookingOf(shop, PICKUP, paid, { status: "CANCELLED", cancel_reason: "guest", cancelled_at: NOW });
}

/** A refund with the id Square would give this key, in `status`. */
function refundIs(status: string): Answer {
  return ({ idempotencyKey, amountJpy, paymentId }) => ({
    kind: "ok",
    refund: {
      id: `square-${idempotencyKey}`,
      status,
      amount: amountJpy,
      currency: "JPY",
      payment_id: paymentId,
    },
  });
}

const unknownResult: Answer = () => ({ kind: "unknown", detail: "no answer within 15000 ms" });
const declined: Answer = () => ({ kind: "declined", code: "REFUND_DECLINED", detail: "The refund was declined" });
const refused: Answer = () => ({ kind: "error", code: "INVALID_VALUE", detail: "The payment cannot be refunded" });
const thrown: Answer = () => {
  throw new Error("connection reset");
};

/** A client that answers the nth refund with the nth answer, the last one repeating, and keeps what it was asked. */
function fakeSquare(...answers: Answer[]): { square: SquareClient; calls: RefundPaymentInput[] } {
  const calls: RefundPaymentInput[] = [];
  const notInThisTicket = async (): Promise<never> => {
    throw new Error("only refundPayment belongs in a cancellation");
  };
  const square: SquareClient = {
    createPayment: notInThisTicket,
    getPayment: notInThisTicket,
    listPayments: notInThisTicket,
    listRefunds: notInThisTicket,
    async refundPayment(input) {
      calls.push(input);
      const answer = answers[Math.min(calls.length, answers.length) - 1];
      if (answer === undefined) throw new Error("this test expected no refund call");
      return answer(input);
    },
  };
  return { square, calls };
}

/**
 * Both functions get the same deps here. The ticket's retryRefunds takes { db, square, now }, but a refusal on retry has
 * to address a staff alert and that signature has nowhere to read the address from, so these tests pass staffEmail too.
 * Task #42's runFrequent has staffEmail to hand on.
 */
function depsOf(shop: Shop, square: SquareClient, now: number) {
  return { db: shop.db, square, now, staffEmail: STAFF_EMAIL, siteUrl: SITE_URL };
}

async function storedBooking(db: D1Database, id: string): Promise<BookingRow> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  if (row === null) throw new Error(`no booking ${id}`);
  return row;
}

async function refundsOf(db: D1Database, bookingId: string): Promise<RefundRow[]> {
  return (await db.prepare("SELECT * FROM refunds WHERE booking_id = ?1").bind(bookingId).all<RefundRow>()).results;
}

/** The queue for one booking. A sheet item holds its id, and a staff alert may name it by ref in any field. */
async function queuedFor(db: D1Database, booking: BookingRow): Promise<OutboxRow[]> {
  const { results } = await db.prepare("SELECT * FROM outbox ORDER BY id").all<OutboxRow>();
  return results.filter(({ payload }) => payload.includes(booking.id) || payload.includes(booking.ref));
}

function emailsOf(rows: OutboxRow[], template: string): EmailPayload[] {
  return rows
    .filter(({ kind }) => kind === "email")
    .map(({ payload }) => JSON.parse(payload) as EmailPayload)
    .filter((email) => email.template === template);
}

/** What the queue holds, by template for an email and by kind otherwise, sorted. */
function queuedNames(rows: OutboxRow[]): string[] {
  const name = ({ kind, payload }: OutboxRow) => (kind === "email" ? (JSON.parse(payload) as EmailPayload).template : kind);
  return rows.map(name).sort();
}

/** Everything a refused cancellation must leave alone. */
async function everything(db: D1Database): Promise<unknown[]> {
  const rows = async (sql: string) => (await db.prepare(sql).all()).results;
  return [
    await rows("SELECT * FROM bookings ORDER BY id"),
    await rows("SELECT * FROM refunds ORDER BY id"),
    await rows("SELECT * FROM outbox ORDER BY id"),
  ];
}

const MISSING_VALUE = /undefined|null|NaN|\[object Object\]/;

function assertRenders(email: EmailPayload, label: string): string {
  const { subject, text, html } = renderEmail(email);
  for (const part of [subject, text, html]) assert.doesNotMatch(part, MISSING_VALUE, `${label}: ${part}`);
  return text;
}

function assertOneStaffAlert(rows: OutboxRow[], booking: BookingRow, label: string): void {
  const alerts = emailsOf(rows, "staff_alert");
  assert.equal(alerts.length, 1, `${label}: staff alerts`);
  const [alert] = alerts;
  assert.equal(alert.to, STAFF_EMAIL, `${label}: alert address`);
  assert.ok(LOCALES.includes(alert.locale), `${label}: alert locale ${alert.locale}`);
  assert.ok(assertRenders(alert, label).includes(booking.ref), `${label}: the alert does not name the booking`);
}

// [now, paid, refund] for a pickup of 2030-06-20 09:00 under TIERS. Each refund is worked out by hand from the JST days.
const PICKUP_LATER = "2030-06-20 09:00";
const REFUNDS: [string, number, number][] = [
  // 19 days, 100%.
  ["2030-06-01 12:00", 7001, 7001],
  // 14 days at the first minute of the day, 100%.
  ["2030-06-06 00:00", 7001, 7001],
  // 13 days, 50% of an odd amount, rounded down from 3500.5.
  ["2030-06-07 00:00", 7001, 3500],
  // 7 days at the last minute of the day, 50%, rounded down from 4999.5.
  ["2030-06-13 23:59", 9999, 4999],
  // 6 days, 33%, rounded down from 330.33.
  ["2030-06-14 00:00", 1001, 330],
  // 2 days at the last minute of the day, 33%.
  ["2030-06-18 23:59", 3000, 990],
];

test("cancelling refunds the tier amount once", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const { cancelBooking, quoteCancellation } = await cancelModule();

    for (const [index, [now, paid, refund]] of REFUNDS.entries()) {
      const label = `${paid} paid at ${now}`;
      const status = index % 2 === 0 ? "PENDING" : "COMPLETED";
      const row = await bookingOf(shop, PICKUP_LATER, paid);
      const { square, calls } = fakeSquare(refundIs(status));
      const deps = depsOf(shop, square, jst(now));

      const quote = await quoteCancellation(db, row.id, jst(now));
      assert.ok(quote.ok, label);
      assert.equal(quote.refundJpy, refund, `${label}: the quote`);

      assert.deepEqual(await cancelBooking(deps, row.id), { ok: true, refundJpy: refund, refundStatus: status }, label);

      assert.equal(calls.length, 1, `${label}: refund calls`);
      assert.equal(calls[0].idempotencyKey, `rf:${row.id}`, label);
      assert.ok(calls[0].idempotencyKey.length <= 45, `${label}: Square's limit on a key`);
      assert.equal(calls[0].paymentId, row.payment_id, label);
      assert.equal(calls[0].amountJpy, refund, label);

      const booking = await storedBooking(db, row.id);
      assert.equal(booking.status, "CANCELLED", label);
      assert.equal(booking.cancelled_at, jst(now), label);
      assert.equal(booking.updated_at, jst(now), label);
      assert.equal(booking.cancel_reason, "guest", label);

      const refunds = await refundsOf(db, row.id);
      assert.equal(refunds.length, 1, `${label}: refund rows`);
      assert.partialDeepStrictEqual(
        refunds[0],
        {
          booking_id: row.id,
          square_refund_id: `square-rf:${row.id}`,
          amount_jpy: refund,
          status,
          origin: "cancel",
          idempotency_key: `rf:${row.id}`,
          created_at: jst(now),
        },
        label,
      );
      assert.deepEqual(queuedNames(await queuedFor(db, row)), MAIL_RECEIPT, label);

      // A second cancel of the same booking, as a double click or a repeat POST sends: nothing more happens.
      const after = await everything(db);
      const again = await cancelBooking(deps, row.id);
      assert.deepEqual(again, { ok: false, reason: "ALREADY_CANCELLED" }, `${label}, again`);
      assert.equal(calls.length, 1, `${label}: refund calls after a second cancel`);
      assert.deepEqual(await everything(db), after, `${label}: a second cancel changed something`);
    }
  });
});

// [what, tiers, now, paid] for PICKUP. Every one is a refund of nothing, reached a different way.
const NOTHING_BACK: [string, TierRow[], string, number][] = [
  ["a 0% tier", [{ min_days_before: 7, refund_percent: 100 }, { min_days_before: 0, refund_percent: 0 }], "2030-06-08 12:00", 7001],
  ["days below the last tier", TIERS, "2030-06-09 12:00", 7001],
  ["no tiers at all", [], "2030-06-01 12:00", 7001],
  ["nothing paid", TIERS, "2030-06-01 12:00", 0],
  ["1% of 99 yen, rounded down to nothing", [{ min_days_before: 0, refund_percent: 1 }], "2030-06-01 12:00", 99],
];

test("zero-percent cancels without a refund call", async () => {
  for (const [what, tiers, now, paid] of NOTHING_BACK) {
    await withShop(async (shop) => {
      const { db } = shop;
      const row = await bookingOf(shop, PICKUP, paid);
      const { square, calls } = fakeSquare();
      const { cancelBooking } = await cancelModule();

      const result = await cancelBooking(depsOf(shop, square, jst(now)), row.id);

      assert.deepEqual(result, { ok: true, refundJpy: 0, refundStatus: "NONE" }, what);
      assert.deepEqual(calls, [], `${what}: Square was called`);
      assert.deepEqual(await refundsOf(db, row.id), [], `${what}: a refund row`);
      const booking = await storedBooking(db, row.id);
      assert.equal(booking.status, "CANCELLED", what);
      assert.equal(booking.cancelled_at, jst(now), what);
      assert.equal(booking.cancel_reason, "guest", what);

      const queued = await queuedFor(db, row);
      assert.deepEqual(queuedNames(queued), MAIL_RECEIPT, what);
      for (const template of ["guest_cancellation", "staff_cancellation"]) {
        const [email] = emailsOf(queued, template);
        assert.equal(email.data.refundJpy, 0, `${what}: ${template}`);
        assert.equal(email.data.refundStatus, "NONE", `${what}: ${template}`);
      }
    }, tiers);
  }
});

test("unknown refund results are retried with the same key", async () => {
  const firstAttempts: [string, Answer][] = [
    ["an unknown result", unknownResult],
    ["a client that throws", thrown],
  ];
  for (const [what, first] of firstAttempts) {
    await withShop(async (shop) => {
      const { db } = shop;
      const row = await bookingOf(shop, PICKUP, 7001);
      const { square, calls } = fakeSquare(first, unknownResult, thrown, refundIs("COMPLETED"));
      const { cancelBooking, retryRefunds } = await cancelModule();

      const result = await cancelBooking(depsOf(shop, square, NOW), row.id);
      assert.deepEqual(result, { ok: true, refundJpy: 3500, refundStatus: "RETRY" }, what);

      const [waiting, ...others] = await refundsOf(db, row.id);
      assert.deepEqual(others, [], `${what}: refund rows`);
      assert.equal(waiting.status, "RETRY", what);
      assert.equal(waiting.square_refund_id, null, what);
      assert.equal(waiting.idempotency_key, `rf:${row.id}`, what);
      assert.equal(waiting.amount_jpy, 3500, what);

      assert.equal((await storedBooking(db, row.id)).status, "CANCELLED", what);
      assert.deepEqual(queuedNames(await queuedFor(db, row)), MAIL_RECEIPT, `${what}: no alert for an unknown result`);

      // A repeat cancel leaves the waiting refund to retryRefunds.
      await cancelBooking(depsOf(shop, square, NOW + MINUTE_MS), row.id);
      assert.equal(calls.length, 1, `${what}: a repeat cancel called Square`);

      const stillWaiting = { retried: 1, completed: 0, stillPending: 1 };
      for (const minutes of [10, 20]) {
        const retried = await retryRefunds(depsOf(shop, square, NOW + minutes * MINUTE_MS));
        assert.deepEqual(retried, stillWaiting, `${what}, after ${minutes} minutes`);
        const [unsettled] = await refundsOf(db, row.id);
        assert.equal(unsettled.status, "RETRY", `${what}, after ${minutes} minutes`);
        assert.equal(unsettled.square_refund_id, null, `${what}, after ${minutes} minutes`);
      }

      const settledAt = NOW + 30 * MINUTE_MS;
      const settled = await retryRefunds(depsOf(shop, square, settledAt));
      assert.deepEqual(settled, { retried: 1, completed: 1, stillPending: 0 }, what);
      const [done, ...extra] = await refundsOf(db, row.id);
      assert.deepEqual(extra, [], `${what}: refund rows after the retries`);
      assert.equal(done.status, "COMPLETED", what);
      assert.equal(done.square_refund_id, `square-rf:${row.id}`, what);
      assert.equal(done.updated_at, settledAt, what);

      assert.deepEqual(await retryRefunds(depsOf(shop, square, settledAt + 10 * MINUTE_MS)), {
        retried: 0,
        completed: 0,
        stillPending: 0,
      });

      assert.equal(calls.length, 4, `${what}: refund calls`);
      for (const call of calls) {
        assert.equal(call.idempotencyKey, `rf:${row.id}`, what);
        assert.equal(call.paymentId, row.payment_id, what);
        assert.equal(call.amountJpy, 3500, what);
      }
    });
  }
});

// [what, answer, the row statuses that fit]. The ticket names REJECTED and FAILED for a definite refusal, and it leaves
// open which of them a refused call is. cancelBooking's own result has one word for all of these.
const REFUSALS: [string, Answer, string[]][] = [
  ["Square rejects the refund", refundIs("REJECTED"), ["REJECTED"]],
  ["Square declines the refund", declined, ["REJECTED"]],
  ["Square fails the refund", refundIs("FAILED"), ["FAILED"]],
  ["Square refuses the call", refused, ["REJECTED", "FAILED"]],
];

test("rejected refunds are recorded and staff alerted", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const { cancelBooking, retryRefunds } = await cancelModule();

    for (const [what, answer, statuses] of REFUSALS) {
      const row = await bookingOf(shop, PICKUP, 7001);
      const { square, calls } = fakeSquare(answer);

      const result = await cancelBooking(depsOf(shop, square, NOW), row.id);
      assert.deepEqual(result, { ok: true, refundJpy: 3500, refundStatus: "REJECTED" }, what);
      assert.equal(calls.length, 1, `${what}: refund calls`);

      const booking = await storedBooking(db, row.id);
      assert.equal(booking.status, "CANCELLED", what);
      assert.equal(booking.cancelled_at, NOW, what);

      const [refund, ...others] = await refundsOf(db, row.id);
      assert.deepEqual(others, [], `${what}: refund rows`);
      assert.ok(statuses.includes(refund.status), `${what}: a row in ${refund.status}`);
      assert.equal(refund.amount_jpy, 3500, what);

      const queued = await queuedFor(db, row);
      assert.deepEqual(queuedNames(queued), [...MAIL_RECEIPT, "staff_alert"].sort(), what);
      assertOneStaffAlert(queued, row, what);
    }

    // A definite refusal is staff's now, so no retry sends it again.
    const { square, calls } = fakeSquare(refundIs("COMPLETED"));
    assert.deepEqual(await retryRefunds(depsOf(shop, square, NOW + HOUR_MS)), { retried: 0, completed: 0, stillPending: 0 });
    assert.deepEqual(calls, [], "a retry of a refused refund");
  });
});

test("cancelled bookings free the bike", async () => {
  const endings: [string, Answer, TierRow[]][] = [
    ["a completed refund", refundIs("COMPLETED"), TIERS],
    ["a refund left to retry", unknownResult, TIERS],
    ["a rejected refund", declined, TIERS],
    ["no refund", refundIs("COMPLETED"), []],
  ];
  const soldOut = { ok: false, reason: "SOLD_OUT" };

  for (const [what, answer, tiers] of endings) {
    await withShop(async (shop) => {
      const { db, modelId, packageId } = shop;
      const startAt = jst(PICKUP);
      // A one-day package ends at closing time, so these two bookings are the rental a new hold would be.
      const rental = { start_at: startAt, end_at: jst("2030-06-10 19:00") };
      const first = await seedVehicle(db, { model_id: modelId });
      const second = await seedVehicle(db, { model_id: modelId });
      const cancelled = await bookingOf(shop, PICKUP, 7001, { ...rental, vehicle_plate: first.plate });
      await bookingOf(shop, PICKUP, 7001, { ...rental, vehicle_plate: second.plate });

      const free = () => searchAvailability(db, { startAt, packageId, now: NOW });
      const hold = (id: string) => createHold(db, { id, modelId, packageId, startAt, locale: "en" }, NOW);

      assert.deepEqual(await free(), [], `${what}: free before the cancel`);
      assert.deepEqual(await hold("before-the-cancel"), soldOut, `${what}: a hold before the cancel`);

      const { square } = fakeSquare(answer);
      const { cancelBooking } = await cancelModule();
      const result = await cancelBooking(depsOf(shop, square, NOW), cancelled.id);
      assert.equal(result.ok, true, what);

      assert.deepEqual((await free()).map(({ vacancies }) => vacancies), [1], `${what}: free after the cancel`);
      const held = await hold("after-the-cancel");
      assert.ok(held.ok, `${what}: ${JSON.stringify(held)}`);
      assert.equal(held.booking.vehiclePlate, first.plate, `${what}: the bike that came free`);

      // The other bike stays booked, so the cancel freed this one bike and no more.
      assert.deepEqual(await hold("one-too-many"), soldOut, `${what}: a hold past the free bike`);
    }, tiers);
  }
});

/**
 * One proxy of `db` per caller, each holding its first batch until every caller has reached theirs. By then each has
 * read the booking as CONFIRMED, so only a guard inside the batch can pick one winner. `arrived` says how many got
 * there, so a case cannot pass without the race. The timer only ends a test that would otherwise hang.
 */
function racingDbs(db: D1Database, callers: number): { dbs: D1Database[]; arrived: () => number } {
  let arrived = 0;
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const stall = setTimeout(() => open(), 2000);
  const racing = (): D1Database => {
    let held = false;
    return new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property !== "batch") return value.bind(target);
        return async (statements: D1PreparedStatement[]) => {
          if (!held) {
            held = true;
            arrived += 1;
            if (arrived === callers) {
              clearTimeout(stall);
              open();
            }
            await gate;
          }
          return target.batch(statements);
        };
      },
    });
  };
  return { dbs: Array.from({ length: callers }, racing), arrived: () => arrived };
}

test("concurrent cancels refund once", async () => {
  // [callers, tiers, answer, refund, what the winner reports, the row's status, what the queue holds]
  const races: [number, TierRow[], Answer, number, string, string | null, string[]][] = [
    [2, TIERS, refundIs("COMPLETED"), 3500, "COMPLETED", "COMPLETED", MAIL_RECEIPT],
    [6, TIERS, refundIs("PENDING"), 3500, "PENDING", "PENDING", MAIL_RECEIPT],
    [6, TIERS, unknownResult, 3500, "RETRY", "RETRY", MAIL_RECEIPT],
    [6, TIERS, declined, 3500, "REJECTED", "REJECTED", [...MAIL_RECEIPT, "staff_alert"].sort()],
    [6, [], refundIs("COMPLETED"), 0, "NONE", null, MAIL_RECEIPT],
  ];

  for (const [callers, tiers, answer, refund, reported, rowStatus, queuedAfter] of races) {
    const label = `${callers} callers ending in ${reported}`;
    await withShop(async (shop) => {
      const { db } = shop;
      const row = await bookingOf(shop, PICKUP, 7001);
      const { square, calls } = fakeSquare(answer);
      const { dbs, arrived } = racingDbs(db, callers);
      const { cancelBooking } = await cancelModule();

      const results = await Promise.all(dbs.map((raced) => cancelBooking({ ...depsOf(shop, square, NOW), db: raced }, row.id)));

      assert.equal(arrived(), callers, `${label}: not every caller reached its batch`);
      assert.deepEqual(results.filter(({ ok }) => ok), [{ ok: true, refundJpy: refund, refundStatus: reported }], label);
      const losers = Array.from({ length: callers - 1 }, () => ({ ok: false, reason: "ALREADY_CANCELLED" }));
      assert.deepEqual(results.filter(({ ok }) => !ok), losers, label);

      assert.equal(calls.length, rowStatus === null ? 0 : 1, `${label}: refund calls`);
      const refunds = await refundsOf(db, row.id);
      assert.deepEqual(refunds.map(({ status }) => status), rowStatus === null ? [] : [rowStatus], label);
      assert.deepEqual(queuedNames(await queuedFor(db, row)), queuedAfter, label);
    }, tiers);
  }

  // Without the gate too, as the requests really arrive.
  await withShop(async (shop) => {
    const row = await bookingOf(shop, PICKUP, 7001);
    const { square, calls } = fakeSquare(refundIs("COMPLETED"));
    const { cancelBooking } = await cancelModule();

    const deps = depsOf(shop, square, NOW);
    const results = await Promise.all(Array.from({ length: 10 }, () => cancelBooking(deps, row.id)));

    assert.equal(results.filter(({ ok }) => ok).length, 1, "ten callers, no gate");
    assert.equal(calls.length, 1, "ten callers, no gate");
    assert.equal((await refundsOf(shop.db, row.id)).length, 1, "ten callers, no gate");
  });
});

test("bookings that cannot be cancelled change nothing", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const startAt = jst(PICKUP);
    const week = startAt - 7 * DAY_MS;
    const cancelled = { status: "CANCELLED", cancel_reason: "guest", cancelled_at: week - DAY_MS };
    const refunded = await bookingOf(shop, PICKUP, 5000, cancelled);
    await refundOf(shop, refunded, { status: "COMPLETED", square_refund_id: "already-refunded" });

    // Each [what, booking, now, reason]. A full refund on every day, so anything that gets through moves money.
    const refusals: [string, BookingRow, number, string][] = [
      ["a hold", await bookingOf(shop, PICKUP, 5000, { status: "ON_HOLD", expires_at: week + HOUR_MS }), week, "NOT_CANCELLABLE"],
      ["a booking in payment", await bookingOf(shop, PICKUP, 5000, { status: "PAYMENT_PENDING" }), week, "NOT_CANCELLABLE"],
      ["an expired hold", await bookingOf(shop, PICKUP, 5000, { status: "EXPIRED" }), week, "NOT_CANCELLABLE"],
      ["a staff block", await bookingOf(shop, PICKUP, 5000, { source: "block", external_ref: "block-1" }), week, "NOT_CANCELLABLE"],
      ["a cancelled booking", await bookingOf(shop, PICKUP, 5000, cancelled), week, "ALREADY_CANCELLED"],
      ["a cancelled and refunded booking", refunded, week, "ALREADY_CANCELLED"],
      // ALREADY_CANCELLED outranks STARTED, or a repeat POST after pickup would tell the guest it cannot be cancelled.
      ["a cancelled booking at pickup", await bookingOf(shop, PICKUP, 5000, cancelled), startAt, "ALREADY_CANCELLED"],
      ["a cancelled booking after pickup", await bookingOf(shop, PICKUP, 5000, cancelled), startAt + HOUR_MS, "ALREADY_CANCELLED"],
      ["a booking at its pickup instant", await bookingOf(shop, PICKUP, 5000), startAt, "STARTED"],
      ["a booking under way", await bookingOf(shop, PICKUP, 5000), startAt + HOUR_MS, "STARTED"],
      ["a booking past its return", await bookingOf(shop, PICKUP, 5000), startAt + 30 * DAY_MS, "STARTED"],
    ];

    const { square, calls } = fakeSquare(refundIs("COMPLETED"));
    const { cancelBooking } = await cancelModule();
    const before = await everything(db);

    for (const [what, row, now, reason] of refusals) {
      const result = await cancelBooking(depsOf(shop, square, now), row.id);
      assert.deepEqual(result, { ok: false, reason }, what);
    }
    for (const id of ["no-such-booking", "", "' OR '1'='1", "%"]) {
      const result = await cancelBooking(depsOf(shop, square, week), id);
      assert.deepEqual(result, { ok: false, reason: "NOT_FOUND" }, `id ${JSON.stringify(id)}`);
    }

    assert.deepEqual(calls, [], "a refused cancel called Square");
    assert.deepEqual(await everything(db), before, "a refused cancel changed something");

    // The last millisecond before pickup still cancels, so the refusals above came from the rules.
    const lastChance = await bookingOf(shop, PICKUP, 5000);
    const result = await cancelBooking(depsOf(shop, square, startAt - 1), lastChance.id);
    assert.deepEqual(result, { ok: true, refundJpy: 5000, refundStatus: "COMPLETED" });
  }, [{ min_days_before: 0, refund_percent: 100 }]);
});

test("the cancellation is on record before Square is called", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const row = await bookingOf(shop, PICKUP, 7001);
    const seen: { status: string; refunds: RefundRow[]; queued: string[] }[] = [];
    const { square } = fakeSquare(async (input) => {
      seen.push({
        status: (await storedBooking(db, row.id)).status,
        refunds: await refundsOf(db, row.id),
        queued: queuedNames(await queuedFor(db, row)),
      });
      return refundIs("COMPLETED")(input);
    });
    const { cancelBooking } = await cancelModule();

    await cancelBooking(depsOf(shop, square, NOW), row.id);

    // A Worker that dies during the call leaves a cancelled booking, its mail, and a refund for the retry to finish.
    assert.equal(seen.length, 1, "refund calls");
    const [moment] = seen;
    assert.equal(moment.status, "CANCELLED");
    assert.deepEqual(moment.queued, MAIL_RECEIPT);
    assert.equal(moment.refunds.length, 1);
    assert.partialDeepStrictEqual(moment.refunds[0], {
      status: "RETRY",
      idempotency_key: `rf:${row.id}`,
      amount_jpy: 3500,
      square_refund_id: null,
    });
  });
});

/** What a statement starts with when it only reads. `first`, `all` and `raw` run an UPDATE ... RETURNING just as well. */
const READS = /^\s*SELECT\b/i;

/**
 * `db` in a Worker that dies at its `crashAt`th write, before that write lands or, with `lands`, just after. A write is a
 * `batch` call, which D1 commits whole, an `exec`, a `.run()`, or a `first`, `all` or `raw` of anything but a SELECT, so
 * which of those the code uses stays its own choice. A dead Worker does nothing more, so a caller that catches the crash
 * cannot carry on: every later use of `db` throws too.
 */
function crashingDb(db: D1Database, crashAt: number, lands = false): { db: D1Database; crashed: () => boolean } {
  let writes = 0;
  let crashed = false;
  const realStatements = new WeakMap<object, D1PreparedStatement>();

  const alive = (): void => {
    if (crashed) throw new Error("the Worker is dead");
  };

  const write = async <T>(send: () => Promise<T>): Promise<T> => {
    alive();
    writes += 1;
    if (writes !== crashAt) return send();
    if (lands) await send();
    crashed = true;
    throw new Error(`the Worker died at write ${crashAt}`);
  };

  const statementOf = (real: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const statement = new Proxy(real, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        const call = value.bind(target);
        if (property === "bind") return (...values: unknown[]) => statementOf(call(...values), sql);
        const isWrite = property === "run" || (["first", "all", "raw"].includes(String(property)) && !READS.test(sql));
        return (...args: unknown[]) => {
          if (isWrite) return write(() => call(...args));
          alive();
          return call(...args);
        };
      },
    });
    realStatements.set(statement, real);
    return statement;
  };

  const crashing = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      const call = value.bind(target);
      if (property === "prepare") {
        return (sql: string) => {
          alive();
          return statementOf(call(sql), sql);
        };
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => write(() => call(statements.map((sent) => realStatements.get(sent) ?? sent)));
      }
      if (property === "exec") return (sql: string) => write(() => call(sql));
      return call;
    },
  });
  return { db: crashing, crashed: () => crashed };
}

/** crashingDb on plain SQL, ahead of the import: a proxy that missed a write would pass the crash test by never crashing. */
async function checkCrashingDb(shop: Shop): Promise<void> {
  const { db } = shop;
  const row = await bookingOf(shop, PICKUP, 7001);
  const update = "UPDATE bookings SET guest_phone = ?1 WHERE id = ?2";
  const phone = async () => (await storedBooking(db, row.id)).guest_phone;
  const ways: [string, (on: D1Database, value: string) => Promise<unknown>][] = [
    ["a batch", (on, value) => on.batch([on.prepare(update).bind(value, row.id)])],
    ["run", (on, value) => on.prepare(update).bind(value, row.id).run()],
    ["first", (on, value) => on.prepare(`${update} RETURNING id`).bind(value, row.id).first()],
    ["all", (on, value) => on.prepare(`${update} RETURNING id`).bind(value, row.id).all()],
    ["raw", (on, value) => on.prepare(`${update} RETURNING id`).bind(value, row.id).raw()],
  ];

  for (const [index, [what, way]] of ways.entries()) {
    const before = await phone();
    const stops = crashingDb(db, 1);
    await assert.rejects(way(stops.db, `dropped-${index}`), /died at write 1/, what);
    assert.equal(stops.crashed(), true, what);
    assert.equal(await phone(), before, `${what}: the crash came first and it landed anyway`);
    await assert.rejects(async () => stops.db.prepare("SELECT 1").first(), /is dead/, `${what}: a read after the crash`);

    const lands = crashingDb(db, 1, true);
    await assert.rejects(way(lands.db, `landed-${index}`), /died at write 1/, what);
    assert.equal(await phone(), `landed-${index}`, `${what}: the write was meant to land`);

    // The write before the crash is an ordinary write.
    const second = crashingDb(db, 2);
    await way(second.db, `first-of-two-${index}`);
    assert.equal(second.crashed(), false, what);
    assert.equal(await phone(), `first-of-two-${index}`, what);
  }

  const reading = crashingDb(db, 1);
  await reading.db.prepare("SELECT id FROM bookings WHERE id = ?1").bind(row.id).first();
  assert.equal(reading.crashed(), false, "a read counted as a write");
}

test("a crash before Square leaves all of the cancellation or none of it", async () => {
  await withShop(checkCrashingDb);

  // [what, tiers, the refund of 7001 paid]. With no refund there is no call to reach, and no refund row to lose.
  const cases: [string, TierRow[], number][] = [
    ["a refund", TIERS, 3500],
    ["no refund", [], 0],
  ];

  for (const [what, tiers, refund] of cases) {
    await withShop(async (shop) => {
      const { db } = shop;
      const { cancelBooking, retryRefunds } = await cancelModule();

      for (const lands of [false, true]) {
        // Up to the first write past Square, or past the last write there is, so how many there are stays the code's own.
        for (let crashAt = 1; ; crashAt += 1) {
          const label = `${what}, the Worker dying ${lands ? "after" : "before"} write ${crashAt}`;
          const row = await bookingOf(shop, PICKUP, 7001);
          const crash = crashingDb(db, crashAt, lands);
          const deadAtCall: boolean[] = [];
          const { square, calls } = fakeSquare((input) => {
            deadAtCall.push(crash.crashed());
            return refundIs("COMPLETED")(input);
          });

          try {
            await cancelBooking({ ...depsOf(shop, square, NOW), db: crash.db }, row.id);
          } catch (error) {
            if (!crash.crashed()) throw error;
          }

          assert.ok(!deadAtCall.includes(true), `${label}: Square was called after the crash`);
          if (crashAt === 1) {
            assert.ok(crash.crashed(), `${label}: cancelling wrote nothing through the db it was given`);
            assert.deepEqual(calls, [], `${label}: Square was called before anything was on record`);
          }
          if (!crash.crashed() || calls.length > 0) break;

          const booking = await storedBooking(db, row.id);
          const refunds = await refundsOf(db, row.id);
          const queued = queuedNames(await queuedFor(db, row));
          const afterwards = depsOf(shop, square, NOW + MINUTE_MS);

          if (booking.status === "CONFIRMED") {
            assert.deepEqual(refunds, [], `${label}: a refund row on a confirmed booking`);
            assert.deepEqual(queued, [], `${label}: mail for a confirmed booking`);
            // Nothing happened, so the guest presses the button again.
            const status = refund === 0 ? "NONE" : "COMPLETED";
            assert.deepEqual(await cancelBooking(afterwards, row.id), { ok: true, refundJpy: refund, refundStatus: status }, label);
          } else {
            assert.equal(booking.status, "CANCELLED", label);
            assert.deepEqual(queued, MAIL_RECEIPT, `${label}: mail`);
            assert.equal(refunds.length, refund === 0 ? 0 : 1, `${label}: a cancelled booking and its refund row`);
            if (refund > 0) {
              assert.partialDeepStrictEqual(
                refunds[0],
                { status: "RETRY", amount_jpy: refund, idempotency_key: `rf:${row.id}`, square_refund_id: null },
                label,
              );
            }
            // The cron finds what is left, which is how a deposit is not kept.
            await retryRefunds(afterwards);
          }

          // By this booking's key, because the run that ended a loop may have left its own row for the retry.
          const sent = calls.filter(({ idempotencyKey }) => idempotencyKey === `rf:${row.id}`).map(({ amountJpy }) => amountJpy);
          assert.deepEqual(sent, refund === 0 ? [] : [refund], `${label}: the refund`);
        }
      }
    }, tiers);
  }
});

test("enqueued emails render with nothing missing", async () => {
  // [locale, paid, refund, the statuses that fit mail written before Square answers]: each locale, money back or not.
  // COMPLETED is not one of them, though Square answers it here: a guest whose refund is later rejected keeps that mail.
  const cases: [Locale, number, number, string[]][] = LOCALES.flatMap((locale): [Locale, number, number, string[]][] => [
    [locale, 7001, 3500, ["RETRY", "PENDING"]],
    [locale, 0, 0, ["NONE"]],
  ]);

  await withShop(async (shop) => {
    const { db } = shop;
    const { cancelBooking } = await cancelModule();

    for (const [index, [locale, paid, refund, statuses]] of cases.entries()) {
      const label = `${locale}, ${paid} paid`;
      const row = await bookingOf(shop, PICKUP, paid, { locale });
      const staffEmail = `staff-${index}@okinawa-dream.example`;
      const { square } = fakeSquare(refundIs("COMPLETED"));

      await cancelBooking({ ...depsOf(shop, square, NOW), staffEmail }, row.id);

      const queued = await queuedFor(db, row);
      assert.deepEqual(queuedNames(queued), MAIL_RECEIPT, label);

      const money = { priceJpy: row.price_jpy, paidJpy: row.paid_jpy, refundJpy: refund };
      const dates = { ref: row.ref, startAt: row.start_at, endAt: row.end_at };
      const [guest] = emailsOf(queued, "guest_cancellation");
      assert.partialDeepStrictEqual(
        guest,
        {
          to: row.guest_email,
          locale,
          data: {
            ...dates,
            ...money,
            modelName: `Vino ${locale}`,
            packageName: `One day ${locale}`,
            shopOpen: SHOP_OPEN,
            shopClose: SHOP_CLOSE,
            guest: { familyName: row.guest_family_name, givenName: row.guest_given_name },
          },
        },
        label,
      );
      assert.ok(statuses.includes(String(guest.data.refundStatus)), `${label}: guest ${guest.data.refundStatus}`);

      const [staff] = emailsOf(queued, "staff_cancellation");
      assert.partialDeepStrictEqual(
        staff,
        {
          to: staffEmail,
          data: {
            ...dates,
            ...money,
            modelNameJa: "Vino ja",
            packageNameJa: "One day ja",
            vehiclePlate: row.vehicle_plate,
            guest: {
              familyName: row.guest_family_name,
              givenName: row.guest_given_name,
              email: row.guest_email,
              phone: row.guest_phone,
            },
          },
        },
        label,
      );
      assert.ok(statuses.includes(String(staff.data.refundStatus)), `${label}: staff ${staff.data.refundStatus}`);

      const guestText = assertRenders(guest, `${label}: guest`);
      assert.ok(guestText.includes(row.guest_family_name ?? "?"), `${label}: the guest's name`);
      assert.ok(guestText.includes(`Vino ${locale}`), `${label}: the model`);
      const staffText = assertRenders(staff, `${label}: staff`);
      assert.ok(staffText.includes(row.guest_given_name ?? "?"), `${label}: the guest's name for staff`);
      assert.ok(staffText.includes(row.vehicle_plate), `${label}: the plate`);

      const sheet = queued.find(({ kind }) => kind === "sheet_booking");
      assert.deepEqual(JSON.parse(sheet?.payload ?? "null"), { bookingId: row.id }, label);
    }
  });
});

test("a package that left the catalog still cancels and refunds", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const row = await bookingOf(shop, PICKUP, 7001, { package_id: "left-the-catalog" });
    const { square, calls } = fakeSquare(refundIs("COMPLETED"));
    const { cancelBooking } = await cancelModule();

    const result = await cancelBooking(depsOf(shop, square, NOW), row.id);

    assert.deepEqual(result, { ok: true, refundJpy: 3500, refundStatus: "COMPLETED" });
    assert.equal(calls.length, 1, "refund calls");
    const queued = await queuedFor(db, row);
    assert.deepEqual(queuedNames(queued), MAIL_RECEIPT);
    assertRenders(emailsOf(queued, "guest_cancellation")[0], "guest");
    assertRenders(emailsOf(queued, "staff_cancellation")[0], "staff");
  });
});

test("outbox keys are stable and belong to one booking", async () => {
  // One booking id cancelled at two moments, so a key that carries the clock would let a repeat through.
  const same = { id: randomUUID(), ref: "R9999999" };
  const keysAt: string[][] = [];
  for (const now of [NOW, NOW + 3 * HOUR_MS]) {
    await withShop(async (shop) => {
      const row = await bookingOf(shop, PICKUP, 7001, same);
      const { square } = fakeSquare(declined);
      const { cancelBooking } = await cancelModule();
      await cancelBooking(depsOf(shop, square, now), row.id);
      keysAt.push((await queuedFor(shop.db, row)).map(({ dedupe_key }) => dedupe_key).sort());
    });
  }
  assert.equal(keysAt[0].length, 4, "three items and an alert");
  assert.deepEqual(keysAt[1], keysAt[0], "keys moved with the clock");

  // Two refused bookings: a key shared between bookings would drop one's mail, since a queued key keeps its first item.
  await withShop(async (shop) => {
    const { db } = shop;
    const { cancelBooking } = await cancelModule();
    const { square } = fakeSquare(declined);
    const rows = [await bookingOf(shop, PICKUP, 7001), await bookingOf(shop, PICKUP, 7001)];
    for (const row of rows) await cancelBooking(depsOf(shop, square, NOW), row.id);
    for (const row of rows) {
      assert.deepEqual(queuedNames(await queuedFor(db, row)), [...MAIL_RECEIPT, "staff_alert"].sort(), row.ref);
    }
  });
});

test("retryRefunds takes only RETRY rows", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const settled: RefundRow[] = [];
    for (const status of ["PENDING", "COMPLETED", "REJECTED", "FAILED"]) {
      const booking = await cancelledBooking(shop);
      settled.push(await refundOf(shop, booking, { status, square_refund_id: `settled-${status}` }));
    }
    const dashboard = await cancelledBooking(shop);
    settled.push(
      await refundOf(shop, dashboard, { status: "COMPLETED", origin: "dashboard", idempotency_key: null, square_refund_id: "from-the-dashboard" }),
    );
    const waiting = await cancelledBooking(shop, 4500);
    await refundOf(shop, waiting, { amount_jpy: 2250 });

    const { square, calls } = fakeSquare(refundIs("COMPLETED"));
    const { retryRefunds } = await cancelModule();

    const result = await retryRefunds(depsOf(shop, square, NOW + HOUR_MS));

    assert.deepEqual(result, { retried: 1, completed: 1, stillPending: 0 });
    assert.equal(calls.length, 1, "refund calls");
    assert.partialDeepStrictEqual(calls[0], {
      idempotencyKey: `rf:${waiting.id}`,
      paymentId: waiting.payment_id,
      amountJpy: 2250,
    });
    for (const row of settled) {
      const [stored] = await refundsOf(db, row.booking_id);
      assert.deepEqual(stored, row, `a ${row.status} row changed`);
    }
  });
});

test("retryRefunds respects its limit", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const rows: BookingRow[] = [];
    for (let i = 0; i < 16; i += 1) {
      const booking = await cancelledBooking(shop);
      await refundOf(shop, booking, { created_at: NOW + i * MINUTE_MS });
      rows.push(booking);
    }
    const { square, calls } = fakeSquare(refundIs("COMPLETED"));
    const { retryRefunds } = await cancelModule();
    const at = NOW + HOUR_MS;

    assert.deepEqual(await retryRefunds(depsOf(shop, square, at), 3), { retried: 3, completed: 3, stillPending: 0 });
    assert.equal(calls.length, 3, "a limit of 3");

    // The default is 10.
    assert.deepEqual(await retryRefunds(depsOf(shop, square, at)), { retried: 10, completed: 10, stillPending: 0 });
    assert.equal(calls.length, 13, "the default limit");

    // A limit past what is left takes the rest.
    assert.deepEqual(await retryRefunds(depsOf(shop, square, at), 50), { retried: 3, completed: 3, stillPending: 0 });
    assert.equal(calls.length, 16, "a limit past the rest");

    const keys = calls.map(({ idempotencyKey }) => idempotencyKey).sort();
    assert.deepEqual(keys, rows.map(({ id }) => `rf:${id}`).sort(), "each refund went exactly once");
    for (const { id } of rows) assert.equal((await refundsOf(db, id))[0].status, "COMPLETED", id);
  });
});

// [what, answer, row statuses, Square's id on the row, how the result counts it]. A null id is the ticket's silence: a
// refused refund may keep the id Square gave it or not. A null count is a refusal, which only `retried` counts.
const RETRY_ENDINGS: [string, Answer, string[], boolean | null, "completed" | "stillPending" | null][] = [
  ["Square completes it", refundIs("COMPLETED"), ["COMPLETED"], true, "completed"],
  ["Square takes it", refundIs("PENDING"), ["PENDING"], true, "stillPending"],
  ["Square does not answer", unknownResult, ["RETRY"], false, "stillPending"],
  // Fourth of eight in any order a query would take, so a throw that ended the run leaves rows untried.
  ["the client throws", thrown, ["RETRY"], false, "stillPending"],
  ...REFUSALS.map(([what, answer, statuses]): [string, Answer, string[], null, null] => [what, answer, statuses, null, null]),
];

test("retryRefunds settles every result the way the first attempt does", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const answers = new Map<string, Answer>();
    const rows: { what: string; booking: BookingRow; statuses: string[]; hasId: boolean | null; refusal: boolean }[] = [];
    for (const [index, [what, answer, statuses, hasId, counted]] of RETRY_ENDINGS.entries()) {
      const booking = await cancelledBooking(shop);
      await refundOf(shop, booking, { id: `refund-${index}`, created_at: NOW + index * MINUTE_MS });
      answers.set(`rf:${booking.id}`, answer);
      rows.push({ what, booking, statuses, hasId, refusal: counted === null });
    }
    const { square } = fakeSquare((input) => {
      const answer = answers.get(input.idempotencyKey);
      if (answer === undefined) throw new Error(`no answer for ${input.idempotencyKey}`);
      return answer(input);
    });
    const { retryRefunds } = await cancelModule();
    const at = NOW + HOUR_MS;

    const result = await retryRefunds(depsOf(shop, square, at), 50);

    assert.deepEqual(result, { retried: RETRY_ENDINGS.length, completed: 1, stillPending: 3 });

    for (const { what, booking, statuses, hasId, refusal } of rows) {
      const [stored, ...others] = await refundsOf(db, booking.id);
      assert.deepEqual(others, [], `${what}: refund rows`);
      assert.ok(statuses.includes(stored.status), `${what}: a row in ${stored.status}`);
      if (hasId === true) assert.equal(stored.square_refund_id, `square-rf:${booking.id}`, what);
      if (hasId === false) assert.equal(stored.square_refund_id, null, what);
      if (stored.status !== "RETRY") assert.equal(stored.updated_at, at, what);
      assert.equal((await storedBooking(db, booking.id)).status, "CANCELLED", what);

      const queued = await queuedFor(db, booking);
      if (refusal) assertOneStaffAlert(queued, booking, what);
      else assert.deepEqual(queuedNames(queued), [], `${what}: mail`);
    }

    // Only what was left waiting goes again, and the refused ones stay with staff.
    const { square: next, calls } = fakeSquare(refundIs("COMPLETED"));
    await retryRefunds(depsOf(shop, next, at + HOUR_MS), 50);
    const waiting = rows.filter(({ statuses }) => statuses.includes("RETRY")).map(({ booking }) => `rf:${booking.id}`);
    assert.deepEqual(calls.map(({ idempotencyKey }) => idempotencyKey).sort(), waiting.sort());
  });
});

test("a retry sends the amount on record, not a new quote", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const row = await bookingOf(shop, PICKUP, 7001);
    const { square, calls } = fakeSquare(unknownResult, refundIs("COMPLETED"));
    const { cancelBooking, retryRefunds } = await cancelModule();

    await cancelBooking(depsOf(shop, square, NOW), row.id);

    // The sheet changes the tiers and pickup passes. A new amount under the same key is an error at Square, and it would
    // also move money the guest was not quoted.
    await db.prepare("DELETE FROM cancellation_tiers").run();
    await seedTiers(db, [{ min_days_before: 0, refund_percent: 100 }]);
    await retryRefunds(depsOf(shop, square, jst(PICKUP) + 2 * DAY_MS));

    assert.deepEqual(
      calls.map(({ idempotencyKey, amountJpy, paymentId }) => ({ idempotencyKey, amountJpy, paymentId })),
      Array.from({ length: 2 }, () => ({ idempotencyKey: `rf:${row.id}`, amountJpy: 3500, paymentId: row.payment_id })),
    );
    assert.equal((await refundsOf(db, row.id))[0].status, "COMPLETED");
  });
});

type Earlier = Pick<RefundRow, "amount_jpy" | "status" | "origin">;

/** A refund a booking has before it is cancelled, by default one staff made in the Dashboard. */
function earlier(amount_jpy: number, status = "COMPLETED", origin = "dashboard"): Earlier {
  return { amount_jpy, status, origin };
}

async function earlierRefunds(shop: Shop, booking: BookingRow, rows: Earlier[]): Promise<RefundRow[]> {
  const stored: RefundRow[] = [];
  for (const row of rows) {
    const idempotency_key = row.origin === "cancel" ? `earlier-${randomUUID()}` : null;
    stored.push(await refundOf(shop, booking, { ...row, idempotency_key, square_refund_id: `earlier-${randomUUID()}` }));
  }
  return stored;
}

// [pickup, days before, percent] from NOW under TIERS.
const HALF_BACK: [string, number, number] = [PICKUP, 9, 50];
const ALL_BACK: [string, number, number] = [PICKUP_LATER, 19, 100];
const NOTHING_LEFT_BACK: [string, number, number] = ["2030-06-02 09:00", 1, 0];

// [what, tier, paid, refunds the booking already has, refund], each refund worked out by hand from the ticket's rule:
// floor(paid x percent / 100) less what is PENDING or COMPLETED, never below 0.
const AFTER_EARLIER: [string, [string, number, number], number, Earlier[], number][] = [
  ["nothing refunded yet", HALF_BACK, 10_000, [], 5000],
  // The ticket's two worked examples. The tier of what is left would give 3000 and 6000, and the gross amount 5000 and 10000.
  ["4000 refunded in the Dashboard, on 50%", HALF_BACK, 10_000, [earlier(4000)], 1000],
  ["4000 refunded in the Dashboard, on 100%", ALL_BACK, 10_000, [earlier(4000)], 6000],
  ["a pending Dashboard refund", HALF_BACK, 10_000, [earlier(4000, "PENDING")], 1000],
  ["a completed refund from a cancel", HALF_BACK, 10_000, [earlier(4000, "COMPLETED", "cancel")], 1000],
  ["a pending refund from a cancel", HALF_BACK, 10_000, [earlier(4000, "PENDING", "cancel")], 1000],
  // Rounded down first, 3500 less 1000. The tier of what is left would give 3000.
  ["an odd amount paid", HALF_BACK, 7001, [earlier(1000)], 2500],
  ["several refunds", HALF_BACK, 10_000, [earlier(1000), earlier(1500, "PENDING"), earlier(500, "COMPLETED", "cancel")], 2000],
  // The rule names PENDING and COMPLETED only.
  ["a rejected refund", HALF_BACK, 10_000, [earlier(4000, "REJECTED")], 5000],
  ["a failed refund", HALF_BACK, 10_000, [earlier(4000, "FAILED")], 5000],
  ["a refund waiting to retry", HALF_BACK, 10_000, [earlier(4000, "RETRY")], 5000],
  [
    "one refund in each status",
    HALF_BACK,
    10_000,
    [earlier(1000), earlier(700, "PENDING"), earlier(400, "REJECTED"), earlier(300, "FAILED"), earlier(200, "RETRY")],
    3300,
  ],
  // Never below nothing.
  ["refunds that reach the tier", HALF_BACK, 10_000, [earlier(5000)], 0],
  ["refunds past the tier", HALF_BACK, 10_000, [earlier(6000)], 0],
  ["two refunds past the tier", HALF_BACK, 10_000, [earlier(3000), earlier(3000, "PENDING")], 0],
  ["a refund on a tier of nothing", NOTHING_LEFT_BACK, 10_000, [earlier(4000)], 0],
];

test("a quote takes off what the booking has already had back", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const { quoteCancellation } = await cancelModule();

    // One database for every row, so a sum over the whole table misses here too.
    for (const [what, [pickup, daysBefore, refundPercent], paid, rows, refund] of AFTER_EARLIER) {
      const row = await bookingOf(shop, pickup, paid);
      await earlierRefunds(shop, row, rows);
      const before = await everything(db);

      const quote = await quoteCancellation(db, row.id, NOW);

      assert.ok(quote.ok, what);
      const { daysBefore: days, refundPercent: percent, refundJpy } = quote;
      assert.deepEqual({ days, percent, refundJpy }, { days: daysBefore, percent: refundPercent, refundJpy: refund }, what);
      assert.deepEqual(await everything(db), before, `${what}: a quote wrote something`);
    }
  });
});

test("a cancel refunds what the tier leaves after earlier refunds", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const { cancelBooking } = await cancelModule();

    for (const [what, [pickup], paid, rows, refund] of AFTER_EARLIER) {
      const row = await bookingOf(shop, pickup, paid);
      const before = await earlierRefunds(shop, row, rows);
      const { square, calls } = fakeSquare(refundIs("COMPLETED"));

      // A row for a refund of nothing breaks the CHECK on amount_jpy, and this throws.
      const result = await cancelBooking(depsOf(shop, square, NOW), row.id);

      const refundStatus = refund === 0 ? "NONE" : "COMPLETED";
      assert.deepEqual(result, { ok: true, refundJpy: refund, refundStatus }, what);
      assert.equal((await storedBooking(db, row.id)).status, "CANCELLED", what);

      const sent = calls.map(({ idempotencyKey, paymentId, amountJpy }) => ({ idempotencyKey, paymentId, amountJpy }));
      const expected = { idempotencyKey: `rf:${row.id}`, paymentId: row.payment_id, amountJpy: refund };
      assert.deepEqual(sent, refund === 0 ? [] : [expected], `${what}: the refund call`);

      const stored = await refundsOf(db, row.id);
      const known = new Set(before.map(({ id }) => id));
      assert.deepEqual(stored.filter(({ id }) => known.has(id)), before, `${what}: an earlier refund changed`);
      const added = stored.filter(({ id }) => !known.has(id));
      assert.equal(added.length, refund === 0 ? 0 : 1, `${what}: new refund rows`);
      if (refund > 0) {
        assert.partialDeepStrictEqual(
          added[0],
          { amount_jpy: refund, status: "COMPLETED", origin: "cancel", idempotency_key: `rf:${row.id}` },
          what,
        );
      }

      const queued = await queuedFor(db, row);
      assert.deepEqual(queuedNames(queued), MAIL_RECEIPT, what);
      for (const template of ["guest_cancellation", "staff_cancellation"]) {
        const [email] = emailsOf(queued, template);
        assert.equal(email.data.refundJpy, refund, `${what}: ${template}`);
        assertRenders(email, `${what}: ${template}`);
      }
    }
  });
});

test("another booking's refunds never count", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const { cancelBooking, quoteCancellation } = await cancelModule();
    const quoted = async (booking: BookingRow) => {
      const quote = await quoteCancellation(db, booking.id, NOW);
      assert.ok(quote.ok, booking.ref);
      return quote.refundJpy;
    };

    const neighbour = await bookingOf(shop, PICKUP, 10_000);
    await earlierRefunds(shop, neighbour, [earlier(4000)]);
    const row = await bookingOf(shop, PICKUP, 10_000);

    assert.equal(await quoted(row), 5000, "a booking with no refunds of its own");
    assert.equal(await quoted(neighbour), 1000, "the booking with the refund");

    const first = fakeSquare(refundIs("COMPLETED"));
    const result = await cancelBooking(depsOf(shop, first.square, NOW), row.id);
    assert.deepEqual(result, { ok: true, refundJpy: 5000, refundStatus: "COMPLETED" });
    assert.deepEqual(first.calls.map(({ amountJpy }) => amountJpy), [5000]);

    // That refund is the first booking's, so it does not come off this one either.
    assert.equal(await quoted(neighbour), 1000, "after the other booking's refund");
    const second = fakeSquare(refundIs("COMPLETED"));
    const next = await cancelBooking(depsOf(shop, second.square, NOW), neighbour.id);
    assert.deepEqual(next, { ok: true, refundJpy: 1000, refundStatus: "COMPLETED" });
    assert.deepEqual(second.calls.map(({ amountJpy }) => amountJpy), [1000]);
  });
});
