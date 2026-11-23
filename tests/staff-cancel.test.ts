// quoteStaffCancellation and cancelByStaff, src/lib/booking/cancel.ts (#145): staff cancel a web booking from the Dashboard
// with the tier refund, a full refund or none. On a real D1 with Square scripted, as tests/cancel.test.ts does. Amounts are
// worked out by hand and written as literals, instants come from Date.parse on an explicit +09:00 offset, and the guest
// cancel is the yardstick where the ticket says "as a guest cancel would", so no expected value comes from the new code.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { searchAvailability } from "../src/lib/booking/availability.ts";
import { createHold } from "../src/lib/booking/holds.ts";
import { LOCALES } from "../src/lib/locale.ts";
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

/** StaffRefundChoice, as the ticket spells it. */
type Choice = "tier" | "full" | "none";

/** A bookings row with the column this ticket adds. */
type StoredBooking = BookingRow & { refund_due_jpy: number | null };

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

type Deps = { db: D1Database; square: SquareClient; now: number; staffEmail: string; siteUrl: string };

type Earlier = Pick<RefundRow, "amount_jpy" | "status" | "origin">;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const STAFF_EMAIL = "desk@okinawa-dream.example";
const SITE_URL = "https://okinawa-dream.example";
const REQUESTED_BY = "staff@okinawa-dream.example";
const SHOP_OPEN = "08:30";
const SHOP_CLOSE = "19:00";

/** The instant of a JST wall clock written "YYYY-MM-DD HH:mm". */
function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

/** DEFAULT_TIERS of tests/helpers/seed.ts, written out: the ticket's example is worked on these. */
const SHOP_TIERS: TierRow[] = [
  { min_days_before: 7, refund_percent: 100 },
  { min_days_before: 3, refund_percent: 50 },
  { min_days_before: 0, refund_percent: 0 },
];

const PICKUP = "2030-06-10 09:00";
/** JST days before PICKUP, and what SHOP_TIERS give back then. */
const NINE_DAYS = "2030-06-01 12:00"; // 100%
const FOUR_DAYS = "2030-06-06 12:00"; // 50%, the ticket's example
const TWO_DAYS = "2030-06-08 00:00"; // 0%

const CHOICES: Choice[] = ["tier", "full", "none"];

/** The three items every cancellation queues, by dedupe key. */
function receiptKeys(bookingId: string): string[] {
  return [`email:guest_cancellation:${bookingId}`, `email:staff_cancellation:${bookingId}`, `sheet:${bookingId}:CANCELLED`].sort();
}

function localeTexts(name: string): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, { name: `${name} ${locale}`, summary: "s", description: "d" }])));
}

/** A published shop on a fresh database: a model with no vehicles yet and a one-day package priced for it. */
async function withShop(run: (shop: Shop) => Promise<void>, tiers: TierRow[] = SHOP_TIERS): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedConfig(db, { shop_open: SHOP_OPEN, shop_close: SHOP_CLOSE });
    await seedCatalogMeta(db);
    await seedTiers(db, tiers);
    const model = await seedModel(db, { texts: localeTexts("Vino") });
    const pkg = await seedPackage(db, { days: 1, texts: localeTexts("One day") });
    await seedPrice(db, { rate_class_id: model.rate_class_id, package_id: pkg.id });
    await run({ db, modelId: model.id, packageId: pkg.id });
  } finally {
    await dispose();
  }
}

let lastBooking = 0;

/** A CONFIRMED web booking whose paid, deposit and price all differ, so a refund shows which one it came from. */
function bookingOf(shop: Shop, pickup: string, paid: number, change: Partial<BookingRow> = {}): Promise<BookingRow> {
  lastBooking += 1;
  const start_at = jst(pickup);
  return seedBooking(shop.db, {
    id: randomUUID(),
    ref: `S${String(lastBooking).padStart(7, "0")}`,
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

/** A refund a booking has before it is cancelled, by default one staff made in the Dashboard. */
function earlier(amount_jpy: number, status = "COMPLETED", origin = "dashboard"): Earlier {
  return { amount_jpy, status, origin };
}

/** The rows as stored, by id, as refundsOf reads them back. */
async function earlierRefunds(shop: Shop, booking: BookingRow, rows: Earlier[]): Promise<RefundRow[]> {
  const stored: RefundRow[] = [];
  for (const row of rows) {
    stored.push(
      await insertRow<RefundRow>(shop.db, "refunds", {
        id: randomUUID(),
        booking_id: booking.id,
        square_refund_id: `earlier-${randomUUID()}`,
        idempotency_key: row.origin === "cancel" ? `earlier-${randomUUID()}` : null,
        created_at: jst("2030-05-01 12:00"),
        updated_at: jst("2030-05-01 12:00"),
        ...row,
      }),
    );
  }
  return stored.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A refund with the id Square would give this key, in `status`. */
function refundIs(status: string): Answer {
  return ({ idempotencyKey, amountJpy, paymentId }) => ({
    kind: "ok",
    refund: { id: `square-${idempotencyKey}`, status, amount: amountJpy, currency: "JPY", payment_id: paymentId },
  });
}

const unknownResult: Answer = () => ({ kind: "unknown", detail: "no answer within 15000 ms" });
const declined: Answer = () => ({ kind: "declined", code: "REFUND_DECLINED", detail: "The refund was declined" });
const thrown: Answer = () => {
  throw new Error("connection reset");
};

/** A client that answers the nth refund with the nth answer, the last one repeating, and keeps what it was asked. */
function fakeSquare(...answers: Answer[]): { square: SquareClient; calls: RefundPaymentInput[] } {
  const calls: RefundPaymentInput[] = [];
  const notHere = async (): Promise<never> => {
    throw new Error("only refundPayment belongs in a cancellation");
  };
  const square: SquareClient = {
    createPayment: notHere,
    getPayment: notHere,
    listPayments: notHere,
    listRefunds: notHere,
    async refundPayment(input) {
      calls.push(input);
      const answer = answers[Math.min(calls.length, answers.length) - 1];
      if (answer === undefined) throw new Error("this test expected no refund call");
      return answer(input);
    },
  };
  return { square, calls };
}

function depsOf(shop: Shop, square: SquareClient, now: number): Deps {
  return { db: shop.db, square, now, staffEmail: STAFF_EMAIL, siteUrl: SITE_URL };
}

async function staffCancel(deps: Deps, bookingId: string, choice: Choice, refundJpy: number) {
  const { cancelByStaff } = await cancelModule();
  return cancelByStaff(deps, bookingId, { choice, refundJpy, requestedBy: REQUESTED_BY });
}

/** What cancelByStaff answers for a cancellation that went through. */
function cancelled(choice: Choice, refundJpy: number, squareSays = "COMPLETED") {
  return { ok: true, choice, refundJpy, refundStatus: refundJpy === 0 ? "NONE" : squareSays };
}

async function storedBooking(db: D1Database, id: string): Promise<StoredBooking> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<StoredBooking>();
  if (row === null) throw new Error(`no booking ${id}`);
  return row;
}

async function refundsOf(db: D1Database, bookingId: string): Promise<RefundRow[]> {
  return (await db.prepare("SELECT * FROM refunds WHERE booking_id = ?1 ORDER BY id").bind(bookingId).all<RefundRow>()).results;
}

/** The refund row a cancellation writes: the one under the booking's own key. */
async function cancelRefundsOf(db: D1Database, booking: BookingRow): Promise<RefundRow[]> {
  return (await refundsOf(db, booking.id)).filter(({ idempotency_key }) => idempotency_key === `rf:${booking.id}`);
}

/** The queue for one booking. A sheet item holds its id, and a staff alert may name it by ref. */
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

function assertRenders(email: EmailPayload, label: string): void {
  const { subject, text, html } = renderEmail(email);
  for (const part of [subject, text, html]) assert.doesNotMatch(part, MISSING_VALUE, `${label}: ${part}`);
}

/** The booking as a cancellation by staff leaves it. */
async function assertCancelledByStaff(db: D1Database, row: BookingRow, now: number, label: string): Promise<void> {
  const booking = await storedBooking(db, row.id);
  assert.equal(booking.status, "CANCELLED", label);
  assert.equal(booking.cancel_reason, "staff", label);
  assert.equal(booking.cancelled_at, now, label);
  assert.equal(booking.updated_at, now, label);
}

/** The reason a guest's refund goes to Square with, read off a guest cancel: staff refunds must send the same one. */
async function guestRefundReason(shop: Shop): Promise<string> {
  const row = await bookingOf(shop, PICKUP, 7001);
  const { square, calls } = fakeSquare(refundIs("COMPLETED"));
  const { cancelBooking } = await cancelModule();
  await cancelBooking(depsOf(shop, square, jst(NINE_DAYS)), row.id);
  assert.equal(calls.length, 1, "the guest cancel the reason is read from");
  return calls[0].reason;
}

/**
 * Two bikes of a model of their own booked for the same rental, and staff cancel the first with `choice` nine days out
 * (100% under SHOP_TIERS, so tier and full are both 7001). The first bike, and only it, comes free. The model is new, so
 * the bikes other bookings in this shop came with stay out of the count.
 */
async function assertFreesTheBike(shop: Shop, choice: Choice, refundJpy: number): Promise<void> {
  const { db, packageId } = shop;
  const label = `a ${choice} cancel`;
  const model = await seedModel(db, { texts: localeTexts(`Bike for ${choice}`) });
  await seedPrice(db, { rate_class_id: model.rate_class_id, package_id: packageId });
  const modelId = model.id;
  const startAt = jst(PICKUP);
  // A one-day package ends at closing time, so these two bookings are the rental a new hold would be.
  const rental = { start_at: startAt, end_at: jst("2030-06-10 19:00"), model_id: modelId };
  const first = await seedVehicle(db, { model_id: modelId });
  const second = await seedVehicle(db, { model_id: modelId });
  const row = await bookingOf(shop, PICKUP, 7001, { ...rental, vehicle_plate: first.plate });
  await bookingOf(shop, PICKUP, 7001, { ...rental, vehicle_plate: second.plate });
  const now = jst(NINE_DAYS);
  const free = async () =>
    (await searchAvailability(db, { startAt, packageId, now })).filter((found) => found.modelId === modelId).map(({ vacancies }) => vacancies);
  const hold = (id: string) => createHold(db, { id, modelId, packageId, startAt, locale: "en" }, now);
  const soldOut = { ok: false, reason: "SOLD_OUT" };

  assert.deepEqual(await free(), [], `${label}: free before the cancel`);
  assert.deepEqual(await hold(`before-${choice}`), soldOut, `${label}: a hold before the cancel`);

  const { square } = fakeSquare(refundIs("COMPLETED"));
  assert.deepEqual(await staffCancel(depsOf(shop, square, now), row.id, choice, refundJpy), cancelled(choice, refundJpy), label);

  assert.deepEqual(await free(), [1], `${label}: free after the cancel`);
  const held = await hold(`after-${choice}`);
  assert.ok(held.ok, `${label}: ${JSON.stringify(held)}`);
  assert.equal(held.booking.vehiclePlate, first.plate, `${label}: the bike that came free`);
  assert.deepEqual(await hold(`past-${choice}`), soldOut, `${label}: a hold past the free bike`);
}

/** Puts `tiers` in place of the sheet's, as a publish does. */
async function replaceTiers(db: D1Database, tiers: TierRow[]): Promise<void> {
  await db.prepare("DELETE FROM cancellation_tiers").run();
  await seedTiers(db, tiers);
}

// [what, now, paid, earlier refunds, daysBefore (null: not pinned past pickup), percent, refunded, tier, full], each
// worked out by hand from the JST days and the rule: tier = floor(paid x percent / 100) less PENDING and COMPLETED
// refunds, never below 0; full = paid less the same refunds; none = 0.
type QuoteCase = [string, string, number, Earlier[], number | null, number, number, number, number];

const QUOTE_SETS: { tiers: TierRow[]; cases: QuoteCase[] }[] = [
  {
    tiers: SHOP_TIERS,
    cases: [
      ["the ticket's example", FOUR_DAYS, 5000, [], 4, 50, 0, 2500, 5000],
      ["a week out at the first minute of the day", "2030-06-03 00:00", 7001, [], 7, 100, 0, 7001, 7001],
      ["half of an odd amount, rounded down", "2030-06-07 23:59", 7001, [], 3, 50, 0, 3500, 7001],
      ["a day the tiers give nothing back", TWO_DAYS, 7001, [], 2, 0, 0, 0, 7001],
      ["a Dashboard refund off both", FOUR_DAYS, 10_000, [earlier(4000)], 4, 50, 4000, 1000, 6000],
      ["refunds past the tier", FOUR_DAYS, 10_000, [earlier(6000)], 4, 50, 6000, 0, 4000],
      [
        "only pending and completed refunds count",
        NINE_DAYS,
        10_000,
        [earlier(1000), earlier(500, "PENDING"), earlier(700, "REJECTED"), earlier(300, "FAILED"), earlier(200, "RETRY")],
        9,
        100,
        1500,
        8500,
        8500,
      ],
      ["nothing paid", NINE_DAYS, 0, [], 9, 100, 0, 0, 0],
      ["a no-show, the 0-day tier giving nothing", "2030-06-11 12:00", 5000, [], null, 0, 0, 0, 5000],
    ],
  },
  {
    // Other tiers, with money back on pickup day, so the percent moves with the sheet and the 0-day tier shows past pickup.
    tiers: [
      { min_days_before: 5, refund_percent: 75 },
      { min_days_before: 0, refund_percent: 25 },
    ],
    cases: [
      ["75% of an odd amount", NINE_DAYS, 7001, [], 9, 75, 0, 5250, 7001],
      ["75% at the last minute of its last day", "2030-06-05 23:59", 7001, [], 5, 75, 0, 5250, 7001],
      ["25% from the next midnight, rounded down from 1750.25", "2030-06-06 00:00", 7001, [], 4, 25, 0, 1750, 7001],
      ["25% on pickup day", "2030-06-10 08:59", 7001, [], 0, 25, 0, 1750, 7001],
      ["75% after a pending refund", NINE_DAYS, 7001, [earlier(2000, "PENDING")], 9, 75, 2000, 3250, 5001],
      ["a no-show takes the 0-day tier", "2030-06-12 12:00", 7001, [], null, 25, 0, 1750, 7001],
      ["a no-show after a refund", "2030-06-12 12:00", 7001, [earlier(1000)], null, 25, 1000, 750, 6001],
    ],
  },
];

test("a staff quote gives the tier, full and no-refund amounts of a web booking", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const { quoteStaffCancellation } = await cancelModule();

    for (const { tiers, cases } of QUOTE_SETS) {
      await replaceTiers(db, tiers);
      // One database for every row, so a sum over the whole table misses here too.
      for (const [what, now, paid, rows, daysBefore, refundPercent, refundedJpy, tier, full] of cases) {
        const row = await bookingOf(shop, PICKUP, paid);
        await earlierRefunds(shop, row, rows);
        const before = await everything(db);

        const quote = await quoteStaffCancellation(db, row.id, jst(now));

        assert.ok(quote.ok, `${what}: ${JSON.stringify(quote)}`);
        assert.equal(quote.booking.id, row.id, what);
        assert.deepEqual(
          { refundPercent: quote.refundPercent, refundedJpy: quote.refundedJpy, amounts: quote.amounts },
          { refundPercent, refundedJpy, amounts: { tier, full, none: 0 } },
          what,
        );
        if (daysBefore !== null) assert.equal(quote.daysBefore, daysBefore, `${what}: days before`);
        assert.deepEqual(await everything(db), before, `${what}: a quote wrote something`);
      }
    }
  });
});

test("cancelling with the tier refund matches what a guest cancel would refund", async () => {
  // [what, now, paid, earlier refunds, the tier refund worked out by hand, Square's answer]. Each runs on twin bookings:
  // the guest cancels one, staff cancel the other with the tier, at the same moment.
  const cases: [string, string, number, Earlier[], number, string][] = [
    ["all back a week out", "2030-06-03 00:00", 7001, [], 7001, "COMPLETED"],
    ["half of an odd amount", "2030-06-07 23:59", 7001, [], 3500, "PENDING"],
    ["the ticket's example", FOUR_DAYS, 5000, [], 2500, "COMPLETED"],
    ["a day the tiers give nothing back", TWO_DAYS, 7001, [], 0, "COMPLETED"],
    ["after a Dashboard refund", FOUR_DAYS, 10_000, [earlier(4000)], 1000, "COMPLETED"],
    ["after refunds past the tier", FOUR_DAYS, 10_000, [earlier(3000), earlier(3000, "PENDING")], 0, "COMPLETED"],
  ];

  await withShop(async (shop) => {
    const { db } = shop;
    const { cancelBooking } = await cancelModule();

    for (const [what, at, paid, rows, refund, squareSays] of cases) {
      const now = jst(at);
      const guestRow = await bookingOf(shop, PICKUP, paid);
      await earlierRefunds(shop, guestRow, rows);
      const staffRow = await bookingOf(shop, PICKUP, paid);
      await earlierRefunds(shop, staffRow, rows);
      const forGuest = fakeSquare(refundIs(squareSays));
      const forStaff = fakeSquare(refundIs(squareSays));

      const guest = await cancelBooking(depsOf(shop, forGuest.square, now), guestRow.id);
      const staff = await staffCancel(depsOf(shop, forStaff.square, now), staffRow.id, "tier", refund);

      const refundStatus = refund === 0 ? "NONE" : squareSays;
      assert.deepEqual(guest, { ok: true, refundJpy: refund, refundStatus }, `${what}: the guest cancel it is held to`);
      assert.deepEqual(staff, { ok: true, choice: "tier", refundJpy: refund, refundStatus }, what);

      // The same request to Square, but for the booking's own key.
      const sent = (calls: RefundPaymentInput[], row: BookingRow) =>
        calls.map(({ idempotencyKey, paymentId, amountJpy, reason }) => ({
          ownKey: idempotencyKey === `rf:${row.id}`,
          ownPayment: paymentId === row.payment_id,
          amountJpy,
          reason,
        }));
      assert.deepEqual(sent(forStaff.calls, staffRow), sent(forGuest.calls, guestRow), `${what}: the refund call`);
      assert.equal(forStaff.calls.length, refund === 0 ? 0 : 1, `${what}: refund calls`);

      const amounts = async (row: BookingRow) => (await cancelRefundsOf(db, row)).map(({ amount_jpy, status, origin }) => ({ amount_jpy, status, origin }));
      assert.deepEqual(await amounts(staffRow), await amounts(guestRow), `${what}: the refund rows`);
      await assertCancelledByStaff(db, staffRow, now, what);
    }
  });
});

test("a full refund sends what was paid less earlier refunds under the booking's refund key", async () => {
  // [what, now, paid, earlier refunds, the refund, Square's answer]
  const cases: [string, string, number, Earlier[], number, string][] = [
    ["the ticket's example, half back by the tiers", FOUR_DAYS, 5000, [], 5000, "COMPLETED"],
    ["a day the tiers give nothing back", TWO_DAYS, 7001, [], 7001, "PENDING"],
    [
      "after earlier refunds, pending and completed ones counting",
      NINE_DAYS,
      10_000,
      [earlier(1500), earlier(500, "PENDING"), earlier(700, "REJECTED"), earlier(300, "FAILED")],
      8000,
      "COMPLETED",
    ],
    ["after a refund from the Dashboard on a 50% day", FOUR_DAYS, 9999, [earlier(4000)], 5999, "COMPLETED"],
  ];

  await withShop(async (shop) => {
    const { db } = shop;
    const reason = await guestRefundReason(shop);

    for (const [what, at, paid, rows, refund, squareSays] of cases) {
      const now = jst(at);
      const row = await bookingOf(shop, PICKUP, paid);
      const before = await earlierRefunds(shop, row, rows);
      // What is on record at the moment Square is asked: the batch lands first, so a crash leaves a refund to retry.
      const atCall: { status: string; refunds: string[] }[] = [];
      const { square, calls } = fakeSquare(async (input) => {
        atCall.push({
          status: (await storedBooking(db, row.id)).status,
          refunds: (await cancelRefundsOf(db, row)).map(({ status }) => status),
        });
        return refundIs(squareSays)(input);
      });

      const result = await staffCancel(depsOf(shop, square, now), row.id, "full", refund);

      assert.deepEqual(result, cancelled("full", refund, squareSays), what);
      assert.deepEqual(
        calls.map(({ idempotencyKey, paymentId, amountJpy, reason: sentReason }) => ({ idempotencyKey, paymentId, amountJpy, reason: sentReason })),
        [{ idempotencyKey: `rf:${row.id}`, paymentId: row.payment_id, amountJpy: refund, reason }],
        `${what}: the refund call`,
      );
      assert.deepEqual(atCall, [{ status: "CANCELLED", refunds: ["RETRY"] }], `${what}: on record when Square was called`);

      const stored = await refundsOf(db, row.id);
      const known = new Set(before.map(({ id }) => id));
      assert.deepEqual(stored.filter(({ id }) => known.has(id)), before, `${what}: an earlier refund changed`);
      const added = stored.filter(({ id }) => !known.has(id));
      assert.equal(added.length, 1, `${what}: new refund rows`);
      assert.partialDeepStrictEqual(
        added[0],
        {
          booking_id: row.id,
          amount_jpy: refund,
          status: squareSays,
          origin: "cancel",
          idempotency_key: `rf:${row.id}`,
          square_refund_id: `square-rf:${row.id}`,
          created_at: now,
        },
        what,
      );
      await assertCancelledByStaff(db, row, now, what);
    }
  });
});

test("no refund cancels the booking and frees the bike without calling Square", async () => {
  // [what, now, paid, earlier refunds]: each a day the tiers would give money back, so a call would move money.
  const cases: [string, string, number, Earlier[]][] = [
    ["all back by the tiers", NINE_DAYS, 7001, []],
    ["half back by the tiers, after an earlier refund", FOUR_DAYS, 10_000, [earlier(1500)]],
    ["a no-show", "2030-06-11 12:00", 7001, []],
  ];

  await withShop(async (shop) => {
    const { db } = shop;
    for (const [what, at, paid, rows] of cases) {
      const now = jst(at);
      const row = await bookingOf(shop, PICKUP, paid);
      const before = await earlierRefunds(shop, row, rows);
      const { square, calls } = fakeSquare(refundIs("COMPLETED"));

      const result = await staffCancel(depsOf(shop, square, now), row.id, "none", 0);

      assert.deepEqual(result, { ok: true, choice: "none", refundJpy: 0, refundStatus: "NONE" }, what);
      assert.deepEqual(calls, [], `${what}: Square was called`);
      assert.deepEqual(await refundsOf(db, row.id), before, `${what}: a refund row`);
      await assertCancelledByStaff(db, row, now, what);
      for (const template of ["guest_cancellation", "staff_cancellation"]) {
        const [email] = emailsOf(await queuedFor(db, row), template);
        assert.equal(email?.data.refundJpy, 0, `${what}: ${template}`);
        assert.equal(email?.data.refundStatus, "NONE", `${what}: ${template}`);
      }
    }

    await assertFreesTheBike(shop, "none", 0);
  });
});

test("the cancellation queues the guest and staff emails and the Bookings row", async () => {
  // Four days out on 5000 paid, so each choice refunds a different amount: [choice, refund].
  const amounts: [Choice, number][] = [
    ["tier", 2500],
    ["full", 5000],
    ["none", 0],
  ];

  await withShop(async (shop) => {
    const { db } = shop;
    const now = jst(FOUR_DAYS);
    for (const [choice, refund] of amounts) {
      const row = await bookingOf(shop, PICKUP, 5000);
      const { square } = fakeSquare(refundIs("COMPLETED"));

      assert.deepEqual(await staffCancel(depsOf(shop, square, now), row.id, choice, refund), cancelled(choice, refund), choice);

      const queued = await queuedFor(db, row);
      assert.deepEqual(queued.map(({ dedupe_key }) => dedupe_key).sort(), receiptKeys(row.id), `${choice}: the queue`);
      assert.ok(queued.every(({ status }) => status === "pending"), `${choice}: ${JSON.stringify(queued)}`);

      const [guest] = emailsOf(queued, "guest_cancellation");
      assert.partialDeepStrictEqual(
        guest,
        {
          to: row.guest_email,
          locale: row.locale,
          data: { ref: row.ref, startAt: row.start_at, paidJpy: row.paid_jpy, refundJpy: refund },
        },
        `${choice}: the guest's mail`,
      );
      const [staff] = emailsOf(queued, "staff_cancellation");
      assert.partialDeepStrictEqual(
        staff,
        { to: STAFF_EMAIL, data: { ref: row.ref, vehiclePlate: row.vehicle_plate, refundJpy: refund } },
        `${choice}: the staff mail`,
      );
      for (const email of [guest, staff]) {
        assert.equal(email.data.refundStatus === "NONE", refund === 0, `${choice}: ${email.template} ${email.data.refundStatus}`);
        assertRenders(email, `${choice}: ${email.template}`);
      }
      const sheet = queued.find(({ kind }) => kind === "sheet_booking");
      assert.deepEqual(JSON.parse(sheet?.payload ?? "null"), { bookingId: row.id }, `${choice}: the Bookings row`);

      await assertCancelledByStaff(db, row, now, choice);
    }

    await assertFreesTheBike(shop, "tier", 7001);
    await assertFreesTheBike(shop, "full", 7001);
  });
});

test("an amount that no longer matches the choice changes nothing and answers the fresh quote", async () => {
  // On 5000 paid, the cancel four days out: { tier: 2500, full: 5000, none: 0 } unless something moved.
  type Stale = {
    what: string;
    choice: Choice;
    asked: number;
    /** What happens between the panel's quote and the confirm. */
    between?: (shop: Shop, row: BookingRow) => Promise<void>;
    at?: string;
    refundedJpy: number;
    fresh: Record<Choice, number>;
  };
  const asQuoted = { tier: 2500, full: 5000, none: 0 };
  const cases: Stale[] = [
    { what: "the ticket's example: full at 4000", choice: "full", asked: 4000, refundedJpy: 0, fresh: asQuoted },
    { what: "full at the tier amount", choice: "full", asked: 2500, refundedJpy: 0, fresh: asQuoted },
    { what: "the tier at the full amount", choice: "tier", asked: 5000, refundedJpy: 0, fresh: asQuoted },
    { what: "the tier a yen short", choice: "tier", asked: 2499, refundedJpy: 0, fresh: asQuoted },
    { what: "no refund with money in it", choice: "none", asked: 1, refundedJpy: 0, fresh: asQuoted },
    {
      what: "the tier quoted the last day of 100%, confirmed past midnight",
      choice: "tier",
      asked: 5000,
      at: "2030-06-04 00:00",
      between: async (shop, row) => {
        const { quoteStaffCancellation } = await cancelModule();
        const stale = await quoteStaffCancellation(shop.db, row.id, jst("2030-06-03 23:59"));
        assert.ok(stale.ok && stale.amounts.tier === 5000, `the quote the panel showed: ${JSON.stringify(stale)}`);
      },
      refundedJpy: 0,
      fresh: { tier: 2500, full: 5000, none: 0 },
    },
    {
      what: "the full amount, with a Dashboard refund landing after the quote",
      choice: "full",
      asked: 5000,
      between: async (shop, row) => {
        await earlierRefunds(shop, row, [earlier(1000)]);
      },
      refundedJpy: 1000,
      fresh: { tier: 1500, full: 4000, none: 0 },
    },
  ];

  await withShop(async (shop) => {
    const { db } = shop;
    const { quoteStaffCancellation } = await cancelModule();

    for (const { what, choice, asked, between, at = FOUR_DAYS, refundedJpy, fresh } of cases) {
      const now = jst(at);
      const row = await bookingOf(shop, PICKUP, 5000);
      if (between) await between(shop, row);
      const before = await everything(db);
      const { square, calls } = fakeSquare(refundIs("COMPLETED"));

      const result = await staffCancel(depsOf(shop, square, now), row.id, choice, asked);

      assert.ok(!result.ok, `${what}: ${JSON.stringify(result)}`);
      assert.equal(result.reason, "QUOTE_CHANGED", what);
      const quote = result.quote;
      assert.ok(quote?.ok, `${what}: the fresh quote ${JSON.stringify(quote)}`);
      assert.equal(quote.booking.id, row.id, what);
      assert.deepEqual({ refundedJpy: quote.refundedJpy, amounts: quote.amounts }, { refundedJpy, amounts: fresh }, `${what}: the fresh quote`);
      assert.deepEqual(quote, await quoteStaffCancellation(db, row.id, now), `${what}: the quote at this moment`);
      assert.deepEqual(calls, [], `${what}: Square was called`);
      assert.deepEqual(await everything(db), before, `${what}: something changed`);

      // Confirmed again at the fresh amount, it goes through: the refusal was the amount's.
      const again = await staffCancel(depsOf(shop, square, now), row.id, choice, fresh[choice]);
      assert.deepEqual(again, cancelled(choice, fresh[choice]), `${what}: confirmed at the fresh amount`);
    }
  });
});

/**
 * One proxy of `db` per caller, each holding its first batch until every caller has reached theirs, then letting the
 * batches through one at a time in caller order. By then each has read the booking as CONFIRMED, so only the guard
 * inside the batch can turn the later ones away, and the first caller is the winner. `arrived` says how many got there,
 * so a case cannot pass without the race. The timer only ends a test that would otherwise hang.
 */
function racingDbs(db: D1Database, callers: number): { dbs: D1Database[]; arrived: () => number } {
  let arrived = 0;
  const releases: (() => void)[] = [];
  const turns = Array.from({ length: callers }, () => new Promise<void>((resolve) => releases.push(resolve)));
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const stall = setTimeout(() => {
    open();
    for (const release of releases) release();
  }, 2000);
  releases[0]();

  const racing = (index: number): D1Database => {
    let held = false;
    return new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property !== "batch") return value.bind(target);
        return async (statements: D1PreparedStatement[]) => {
          if (held) return target.batch(statements);
          held = true;
          arrived += 1;
          if (arrived === callers) {
            clearTimeout(stall);
            open();
          }
          await gate;
          await turns[index];
          try {
            return await target.batch(statements);
          } finally {
            releases[index + 1]?.();
          }
        };
      },
    });
  };
  return { dbs: Array.from({ length: callers }, (_, index) => racing(index)), arrived: () => arrived };
}

type Caller = { by: "guest" } | { by: "staff"; choice: Choice };

const GUEST: Caller = { by: "guest" };
const byStaff = (choice: Choice): Caller => ({ by: "staff", choice });

/** Four days out on 5000 paid: the guest's tier is 2500, and staff's amounts are { tier: 2500, full: 5000, none: 0 }. */
function amountOf(caller: Caller): number {
  if (caller.by === "guest") return 2500;
  return { tier: 2500, full: 5000, none: 0 }[caller.choice];
}

async function cancelAs(caller: Caller, deps: Deps, bookingId: string): Promise<unknown> {
  if (caller.by === "guest") return (await cancelModule()).cancelBooking(deps, bookingId);
  return staffCancel(deps, bookingId, caller.choice, amountOf(caller));
}

/** One refund, one set of items and the booking as the winner left it, whoever lost. */
async function assertOneCancellation(db: D1Database, row: BookingRow, winner: Caller, calls: RefundPaymentInput[], label: string) {
  const amount = amountOf(winner);
  assert.deepEqual(
    calls.map(({ idempotencyKey, amountJpy }) => ({ idempotencyKey, amountJpy })),
    amount === 0 ? [] : [{ idempotencyKey: `rf:${row.id}`, amountJpy: amount }],
    `${label}: refund calls`,
  );
  assert.deepEqual((await refundsOf(db, row.id)).map(({ amount_jpy }) => amount_jpy), amount === 0 ? [] : [amount], `${label}: refund rows`);
  assert.deepEqual((await queuedFor(db, row)).map(({ dedupe_key }) => dedupe_key).sort(), receiptKeys(row.id), `${label}: the queue`);
  const booking = await storedBooking(db, row.id);
  assert.equal(booking.status, "CANCELLED", label);
  assert.equal(booking.cancel_reason, winner.by, `${label}: who cancelled`);
  assert.equal(booking.refund_due_jpy, winner.by === "staff" ? amount : null, `${label}: refund_due_jpy`);
}

test("concurrent staff and guest cancels refund once", async () => {
  // The first caller of each race wins it.
  const races: Caller[][] = [
    [byStaff("full"), byStaff("full")],
    [byStaff("tier"), byStaff("full")],
    [byStaff("full"), GUEST],
    [GUEST, byStaff("full")],
    [byStaff("none"), GUEST],
    [GUEST, byStaff("none")],
    [byStaff("full"), GUEST, byStaff("tier"), GUEST, byStaff("none"), byStaff("full")],
  ];

  await withShop(async (shop) => {
    const { db } = shop;
    const now = jst(FOUR_DAYS);

    for (const callers of races) {
      const label = callers.map((caller) => (caller.by === "guest" ? "guest" : `staff ${caller.choice}`)).join(" against ");
      const row = await bookingOf(shop, PICKUP, 5000);
      const { square, calls } = fakeSquare(refundIs("COMPLETED"));
      const { dbs, arrived } = racingDbs(db, callers.length);

      const results = await Promise.all(callers.map((caller, index) => cancelAs(caller, { ...depsOf(shop, square, now), db: dbs[index] }, row.id)));

      assert.equal(arrived(), callers.length, `${label}: not every caller reached its batch`);
      const [winner] = callers;
      const amount = amountOf(winner);
      const won =
        winner.by === "guest"
          ? { ok: true, refundJpy: amount, refundStatus: amount === 0 ? "NONE" : "COMPLETED" }
          : cancelled(winner.choice, amount);
      assert.deepEqual(results[0], won, `${label}: the winner`);
      for (const [index, result] of results.slice(1).entries()) {
        assert.partialDeepStrictEqual(result, { ok: false, reason: "ALREADY_CANCELLED" }, `${label}: caller ${index + 2}`);
      }
      await assertOneCancellation(db, row, winner, calls, label);
    }

    // Without the gate too, as the requests really arrive: whoever wins, one of everything.
    const row = await bookingOf(shop, PICKUP, 5000);
    const { square, calls } = fakeSquare(refundIs("COMPLETED"));
    const callers = Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? byStaff("full") : GUEST));
    const results = await Promise.all(callers.map((caller) => cancelAs(caller, depsOf(shop, square, now), row.id)));
    assert.equal(results.filter((result) => (result as { ok: boolean }).ok).length, 1, "ten callers, no gate");
    const winner = (await storedBooking(db, row.id)).cancel_reason === "staff" ? byStaff("full") : GUEST;
    await assertOneCancellation(db, row, winner, calls, "ten callers, no gate");
  });
});

test("block, unconfirmed and cancelled bookings are refused unchanged", async () => {
  await withShop(
    async (shop) => {
      const { db } = shop;
      const startAt = jst(PICKUP);
      const week = startAt - 7 * DAY_MS;
      const cancelledBy = (reason: string) => ({ status: "CANCELLED", cancel_reason: reason, cancelled_at: week - DAY_MS });
      const refunded = await bookingOf(shop, PICKUP, 5000, cancelledBy("guest"));
      await earlierRefunds(shop, refunded, [earlier(5000, "COMPLETED", "cancel")]);

      // [what, booking, now, reason]. A full refund on every day, so anything that gets through moves money.
      const refusals: [string, BookingRow, number, string][] = [
        ["a staff block", await bookingOf(shop, PICKUP, 5000, { source: "block", external_ref: "block-1" }), week, "NOT_CANCELLABLE"],
        ["a staff block under way", await bookingOf(shop, PICKUP, 5000, { source: "block", external_ref: "block-2" }), startAt + HOUR_MS, "NOT_CANCELLABLE"],
        ["a hold", await bookingOf(shop, PICKUP, 5000, { status: "ON_HOLD", expires_at: week + HOUR_MS }), week, "NOT_CANCELLABLE"],
        ["a booking in payment", await bookingOf(shop, PICKUP, 5000, { status: "PAYMENT_PENDING" }), week, "NOT_CANCELLABLE"],
        ["an expired hold", await bookingOf(shop, PICKUP, 5000, { status: "EXPIRED" }), week, "NOT_CANCELLABLE"],
        ["a booking in payment past its pickup", await bookingOf(shop, PICKUP, 5000, { status: "PAYMENT_PENDING" }), startAt + DAY_MS, "NOT_CANCELLABLE"],
        ["a booking the guest cancelled", await bookingOf(shop, PICKUP, 5000, cancelledBy("guest")), week, "ALREADY_CANCELLED"],
        ["a booking staff cancelled", await bookingOf(shop, PICKUP, 5000, cancelledBy("staff")), week, "ALREADY_CANCELLED"],
        ["a cancelled and refunded booking", refunded, week, "ALREADY_CANCELLED"],
        ["a cancelled booking past its pickup", await bookingOf(shop, PICKUP, 5000, cancelledBy("guest")), startAt + HOUR_MS, "ALREADY_CANCELLED"],
      ];
      const asked: [Choice, number][] = [
        ["tier", 5000],
        ["full", 5000],
        ["none", 0],
      ];

      const { square, calls } = fakeSquare(refundIs("COMPLETED"));
      const { quoteStaffCancellation } = await cancelModule();
      const before = await everything(db);

      for (const [what, row, now, reason] of refusals) {
        assert.deepEqual(await quoteStaffCancellation(db, row.id, now), { ok: false, reason }, `${what}: the quote`);
        for (const [choice, amount] of asked) {
          const result = await staffCancel(depsOf(shop, square, now), row.id, choice, amount);
          assert.partialDeepStrictEqual(result, { ok: false, reason }, `${what}, ${choice}`);
        }
      }
      for (const id of ["no-such-booking", "", "' OR '1'='1", "%"]) {
        assert.deepEqual(await quoteStaffCancellation(db, id, week), { ok: false, reason: "NOT_FOUND" }, `quote of ${JSON.stringify(id)}`);
        const result = await staffCancel(depsOf(shop, square, week), id, "full", 5000);
        assert.partialDeepStrictEqual(result, { ok: false, reason: "NOT_FOUND" }, `cancel of ${JSON.stringify(id)}`);
      }

      assert.deepEqual(calls, [], "a refused cancel called Square");
      assert.deepEqual(await everything(db), before, "a refused cancel changed something");

      // A CONFIRMED web booking on the same day cancels, so the refusals above came from the rules.
      const confirmed = await bookingOf(shop, PICKUP, 5000);
      assert.deepEqual(await staffCancel(depsOf(shop, square, week), confirmed.id, "full", 5000), cancelled("full", 5000));
    },
    [{ min_days_before: 0, refund_percent: 100 }],
  );
});

test("a booking whose pickup has passed (a no-show) can be cancelled with each of the three choices", async () => {
  // 20% is the tier at 0 days. Past pickup the days before go below every tier, which would give nothing: the ticket
  // gives the 0-day tier instead. [what, now, earlier refunds, tier, full] on 7001 paid, 20% being 1400.2 rounded down.
  const moments: [string, string, Earlier[], number, number][] = [
    ["at the pickup instant", PICKUP, [], 1400, 7001],
    ["an hour after pickup", "2030-06-10 10:00", [], 1400, 7001],
    ["two days after pickup, after a Dashboard refund", "2030-06-12 12:00", [earlier(500)], 900, 6501],
    ["after the rental's return", "2030-06-20 12:00", [], 1400, 7001],
  ];

  await withShop(
    async (shop) => {
      const { db } = shop;
      const { quoteCancellation, quoteStaffCancellation } = await cancelModule();

      for (const [what, at, rows, tier, full] of moments) {
        const now = jst(at);
        const amounts = { tier, full, none: 0 };
        for (const choice of CHOICES) {
          const label = `${what}, ${choice}`;
          const row = await bookingOf(shop, PICKUP, 7001);
          await earlierRefunds(shop, row, rows);

          // The guest's link stays closed.
          assert.deepEqual(await quoteCancellation(db, row.id, now), { ok: false, reason: "STARTED" }, `${label}: the guest's quote`);

          const quote = await quoteStaffCancellation(db, row.id, now);
          assert.ok(quote.ok, `${label}: ${JSON.stringify(quote)}`);
          assert.deepEqual({ refundPercent: quote.refundPercent, amounts: quote.amounts }, { refundPercent: 20, amounts }, `${label}: the quote`);

          const { square, calls } = fakeSquare(refundIs("COMPLETED"));
          const result = await staffCancel(depsOf(shop, square, now), row.id, choice, amounts[choice]);

          assert.deepEqual(result, cancelled(choice, amounts[choice]), label);
          assert.deepEqual(
            calls.map(({ idempotencyKey, amountJpy }) => ({ idempotencyKey, amountJpy })),
            amounts[choice] === 0 ? [] : [{ idempotencyKey: `rf:${row.id}`, amountJpy: amounts[choice] }],
            `${label}: refund calls`,
          );
          await assertCancelledByStaff(db, row, now, label);
        }
      }
    },
    [
      { min_days_before: 7, refund_percent: 100 },
      { min_days_before: 3, refund_percent: 50 },
      { min_days_before: 0, refund_percent: 20 },
    ],
  );
});

/** A database that throws on every use and keeps what was asked of it. */
function untouchableDb(): { db: D1Database; used: string[] } {
  const used: string[] = [];
  const db = new Proxy({} as D1Database, {
    get(_target, property) {
      if (property === "then") return undefined;
      return () => {
        used.push(String(property));
        throw new Error(`the database was used: ${String(property)}`);
      };
    },
  });
  return { db, used };
}

test("an unknown choice or an amount that is no whole number is refused before any read", async () => {
  // [what, choice, refundJpy]. Names on Object.prototype are there for a check that asks `in` an object of amounts.
  const bad: [string, unknown, unknown][] = [
    ["a choice that is none of the three", "partial", 0],
    ["a choice in capitals", "TIER", 2500],
    ["a capitalised choice", "Full", 5000],
    ["an empty choice", "", 0],
    ["no choice", undefined, 0],
    ["a null choice", null, 0],
    ["a number for a choice", 1, 0],
    ["a name every object has", "constructor", 0],
    ["another name every object has", "toString", 0],
    ["a negative amount", "full", -1],
    ["a large negative amount", "tier", -5000],
    ["a fraction", "full", 4999.5],
    ["a fraction below one", "none", 0.5],
    ["NaN", "tier", Number.NaN],
    ["Infinity", "full", Number.POSITIVE_INFINITY],
    ["minus Infinity", "none", Number.NEGATIVE_INFINITY],
    ["the amount as text", "full", "5000"],
    ["zero as text", "none", "0"],
    ["a null amount", "none", null],
    ["no amount", "tier", undefined],
  ];
  const { cancelByStaff } = await cancelModule();

  for (const [what, choice, refundJpy] of bad) {
    const { db, used } = untouchableDb();
    const { square, calls } = fakeSquare();
    const deps = { db, square, now: jst(FOUR_DAYS), staffEmail: STAFF_EMAIL, siteUrl: SITE_URL };
    const request = { choice: choice as Choice, refundJpy: refundJpy as number, requestedBy: REQUESTED_BY };

    let result: unknown;
    try {
      result = await cancelByStaff(deps, "booking-1", request);
    } catch (error) {
      assert.fail(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }

    assert.partialDeepStrictEqual(result, { ok: false, reason: "BAD_CHOICE" }, what);
    assert.equal((result as { quote?: unknown }).quote, undefined, `${what}: a quote with nothing read`);
    assert.deepEqual(used, [], `${what}: the database was used`);
    assert.deepEqual(calls, [], `${what}: Square was called`);
  }

  // Each choice with a whole amount gets past the check to the database, so the refusals above were the input's.
  for (const [choice, refundJpy] of [["tier", 2500], ["full", 0], ["none", 0]] as [Choice, number][]) {
    const { db, used } = untouchableDb();
    const { square } = fakeSquare();
    const deps = { db, square, now: jst(FOUR_DAYS), staffEmail: STAFF_EMAIL, siteUrl: SITE_URL };
    try {
      await cancelByStaff(deps, "booking-1", { choice, refundJpy, requestedBy: REQUESTED_BY });
    } catch {
      // The database throws, which is the point.
    }
    assert.ok(used.length > 0, `${choice} at ${refundJpy} never reached the database`);
  }
});

test("the refund staff settled on is recorded on the booking", async () => {
  // [what, now, paid, earlier refunds, choice, the refund, refund_due_jpy: the refunds before it plus this one, Square]
  const cases: [string, string, number, Earlier[], Choice, number, number, Answer][] = [
    ["full, nothing refunded before", FOUR_DAYS, 5000, [], "full", 5000, 5000, refundIs("COMPLETED")],
    [
      "full after earlier refunds, a rejected one not counting",
      NINE_DAYS,
      10_000,
      [earlier(1500), earlier(500, "PENDING"), earlier(700, "REJECTED")],
      "full",
      8000,
      10_000,
      refundIs("COMPLETED"),
    ],
    ["the tier after an earlier refund", FOUR_DAYS, 10_000, [earlier(1000)], "tier", 4000, 5000, refundIs("PENDING")],
    ["the tier on an odd amount", "2030-06-07 23:59", 7001, [], "tier", 3500, 3500, refundIs("COMPLETED")],
    ["the tier when earlier refunds passed it", FOUR_DAYS, 10_000, [earlier(6000)], "tier", 0, 6000, refundIs("COMPLETED")],
    ["no refund, nothing before", NINE_DAYS, 7001, [], "none", 0, 0, refundIs("COMPLETED")],
    ["no refund after an earlier one", NINE_DAYS, 7001, [earlier(1500)], "none", 0, 1500, refundIs("COMPLETED")],
    ["a refund Square then declines", FOUR_DAYS, 5000, [], "full", 5000, 5000, declined],
    ["a refund Square has not answered", FOUR_DAYS, 5000, [], "tier", 2500, 2500, unknownResult],
  ];

  await withShop(async (shop) => {
    const { db } = shop;
    for (const [what, at, paid, rows, choice, refund, due, answer] of cases) {
      const row = await bookingOf(shop, PICKUP, paid);
      await earlierRefunds(shop, row, rows);
      assert.equal((await storedBooking(db, row.id)).refund_due_jpy, null, `${what}: a confirmed booking has none`);
      const { square } = fakeSquare(answer);

      const result = await staffCancel(depsOf(shop, square, jst(at)), row.id, choice, refund);

      assert.partialDeepStrictEqual(result, { ok: true, choice, refundJpy: refund }, what);
      assert.equal((await storedBooking(db, row.id)).refund_due_jpy, due, what);
    }

    // A guest cancellation leaves it NULL, with money back and without.
    const { cancelBooking } = await cancelModule();
    for (const [at, refund] of [
      [FOUR_DAYS, 2500],
      [TWO_DAYS, 0],
    ] as [string, number][]) {
      const row = await bookingOf(shop, PICKUP, 5000);
      const { square } = fakeSquare(refundIs("COMPLETED"));
      const result = await cancelBooking(depsOf(shop, square, jst(at)), row.id);
      assert.partialDeepStrictEqual(result, { ok: true, refundJpy: refund }, `a guest cancel at ${at}`);
      const booking = await storedBooking(db, row.id);
      assert.equal(booking.cancel_reason, "guest", `a guest cancel at ${at}`);
      assert.equal(booking.refund_due_jpy, null, `a guest cancel at ${at}`);
    }
  });
});

test("a staff refund left in RETRY goes out again under the same key and amount", async () => {
  // [what, choice, now, paid, earlier refunds, the refund, the first attempt]
  const cases: [string, Choice, string, number, Earlier[], number, Answer][] = [
    ["a full refund Square did not answer", "full", FOUR_DAYS, 5000, [], 5000, unknownResult],
    ["a tier refund whose client threw", "tier", FOUR_DAYS, 10_000, [earlier(1000)], 4000, thrown],
    ["a no-show's full refund", "full", "2030-06-11 12:00", 7001, [earlier(1001)], 6000, unknownResult],
  ];

  await withShop(async (shop) => {
    const { db } = shop;
    const reason = await guestRefundReason(shop);

    for (const [what, choice, at, paid, rows, refund, first] of cases) {
      await replaceTiers(db, SHOP_TIERS);
      const row = await bookingOf(shop, PICKUP, paid);
      await earlierRefunds(shop, row, rows);
      const { square, calls } = fakeSquare(first, refundIs("COMPLETED"));
      const { retryRefunds } = await cancelModule();
      const now = jst(at);

      const result = await staffCancel(depsOf(shop, square, now), row.id, choice, refund);

      assert.deepEqual(result, cancelled(choice, refund, "RETRY"), what);
      const [waiting, ...others] = await cancelRefundsOf(db, row);
      assert.deepEqual(others, [], `${what}: refund rows`);
      assert.partialDeepStrictEqual(waiting, { status: "RETRY", amount_jpy: refund, square_refund_id: null, origin: "cancel" }, what);

      // The sheet's tiers change before the retry: it sends what staff settled on, not a new quote.
      await replaceTiers(db, [{ min_days_before: 0, refund_percent: 100 }]);
      const retried = await retryRefunds(depsOf(shop, square, now + 10 * MINUTE_MS));
      assert.deepEqual(retried, { retried: 1, completed: 1, stillPending: 0 }, what);

      const expected = { idempotencyKey: `rf:${row.id}`, paymentId: row.payment_id, amountJpy: refund, reason };
      assert.deepEqual(
        calls.map(({ idempotencyKey, paymentId, amountJpy, reason: sentReason }) => ({ idempotencyKey, paymentId, amountJpy, reason: sentReason })),
        [expected, expected],
        `${what}: the first attempt and the retry`,
      );
      const [done] = await cancelRefundsOf(db, row);
      assert.partialDeepStrictEqual(done, { status: "COMPLETED", amount_jpy: refund, square_refund_id: `square-rf:${row.id}` }, what);
      assert.equal((await storedBooking(db, row.id)).refund_due_jpy, refund + rows.reduce((sum, { amount_jpy }) => sum + amount_jpy, 0), what);
    }
  });
});
