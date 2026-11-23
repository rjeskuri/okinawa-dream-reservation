// reconcileSquare, src/lib/reconcile/square.ts, on a real D1 against Square's payments and refunds. Square is faked at the
// SquareClient seam, the one external thing here, and for pages and locations the real createSquareClient runs over a fake
// fetch. Ids, refs and amounts are drawn fresh on every run. Each tier is worked out by hand from JST dates whose day count
// is written beside them, and every expected amount is arithmetic on the drawn values, so no expected value passes through
// src/lib/booking/cancel.ts, src/lib/time.ts or the code under test. One test reads #35's quote afterwards, as an outcome.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - expectedJpy is what D1 holds and actualJpy what Square holds, for the money the issue is about. A side with no record of
//   that money leaves its field out (0 is accepted too). status_mismatch may give the booking's deposit or paid as expected.
// - retained_mismatch covers CANCELLED bookings whose confirmed_at or cancelled_at is in the window, under today's tiers,
//   and a RETRY row still there at the daily run is stuck. It reports retained amounts: expectedJpy = paid -
//   the tier's refund, actualJpy = paid - refunded. The tier is the one at cancelled_at (JST calendar days to pickup), never
//   at `now`. Refunded counts PENDING and COMPLETED refunds, as #35's quote does, after this run's fixes: REJECTED, FAILED
//   and RETRY never count, and a refund just recorded does.
// - Only COMPLETED payments are reconciled: a FAILED one, such as a declined card, moved no money.
// - A payment belongs to the booking whose payment_id it is, or else to the booking its reference_id names (#34 sets it to
//   the booking id). The window is [now - days, now] for both lists. booking_without_payment and amount_mismatch cover a
//   booking whose confirmed_at is in it, since an older payment is not in the listing.
// - A Square refund belongs to a booking (recorded, counted) only when its payment_id is that booking's payment_id, whether
//   or not that payment is in the window's listing. A refund of any other payment is never recorded.
// - A COMPLETED payment no booking holds but whose reference_id names one is a #34 send-back. It is no issue when its
//   PENDING and COMPLETED refunds in Square add up to all of it. Short of that it is status_mismatch on a booking neither
//   CONFIRMED nor CANCELLED, and payment_without_booking with that booking's ref on one another payment settled.
// - A Square refund of a payment no booking holds or names, or one D1 lacks that is FAILED or REJECTED, is neither recorded
//   nor reported. A partial refund on a CONFIRMED booking shows once, as refund_not_recorded.
// - A PAYMENT_PENDING booking with no payment, and a RETRY refund row with no Square id, are the ten-minute cron's: no issue.
// - A failed listing rejects with an Error that carries Square's detail, and changes nothing in D1.
// - A payment or refund from another location never counts, even when Square's answer holds one: the reconciler has no
//   location to compare with, so the client has to drop such rows.
// - A staff cancellation (#145, #146) is checked against the refund staff chose, refund_due_jpy: expectedJpy = paid -
//   refund_due_jpy, whatever the tiers said then or say now, so a refund beyond it is reported as surely as one that
//   never came. A guest's, with refund_due_jpy NULL, is checked against the tier at cancelled_at as above. A staff
//   retained_mismatch's detail says staff cancelled, names the refund they chose (when it is more than 0) and what the
//   shop keeps, paid less what went back; amounts as whole yen, with thousands commas or without.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { test } from "node:test";
import { quoteCancellation } from "../src/lib/booking/cancel.ts";
import { createSquareClient } from "../src/lib/square/client.ts";
import type { SquareClient, SquareFailure, SquareRecord, SquareTimeWindow } from "../src/lib/square/client.ts";
import { createTestDb } from "./helpers/d1.ts";
import { insertRow, seedBooking, seedCatalogMeta, seedConfig, seedModel, seedTiers } from "./helpers/seed.ts";
import type { BookingRow, TierRow } from "./helpers/seed.ts";

/** Loaded inside each test, after its fixtures, so a test fails on this module alone and a bad fixture shows first. */
const reconcileModule = () => import("../src/lib/reconcile/square.ts");

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The instant of a JST wall clock written "YYYY-MM-DD HH:mm". */
function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 14 days or more 100%, 7 to 13 days 50%, 2 to 6 days 30%, less 0%. */
const TIERS: TierRow[] = [
  { min_days_before: 14, refund_percent: 100 },
  { min_days_before: 7, refund_percent: 50 },
  { min_days_before: 2, refund_percent: 30 },
];

/** 03:00 JST, when the daily cron runs. The default window opens at 2030-04-27 03:00. */
const NOW = jst("2030-06-01 03:00");

const ISSUE_TYPES = [
  "payment_without_booking",
  "booking_without_payment",
  "amount_mismatch",
  "status_mismatch",
  "refund_not_recorded",
  "refund_status_mismatch",
  "refund_amount_mismatch",
  "retained_mismatch",
] as const;

type IssueType = (typeof ISSUE_TYPES)[number];

type Json = Record<string, unknown>;

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

/** An issue as it comes back, read loosely so that the assertions decide its shape. */
type Issue = Record<string, unknown>;

type Value = string | number | undefined;

/** A field the ticket leaves open between a few values. */
class OneOf {
  readonly values: Value[];
  constructor(values: Value[]) {
    this.values = values;
  }
}

function oneOf(...values: Value[]): OneOf {
  return new OneOf(values);
}

/** No record of the money on that side. */
const ABSENT = oneOf(undefined, 0);

/** A field the ticket leaves to the code: any well-formed value, or none. */
const ANY = Symbol("any");

type Field = Value | OneOf | typeof ANY;

/** Every field named, so a case says what each one is; undefined means the issue leaves it out. */
type ExpectedIssue = {
  type: IssueType;
  bookingRef: Field;
  paymentId: Field;
  refundId: Field;
  expectedJpy: Field;
  actualJpy: Field;
};

const ID_FIELDS = ["bookingRef", "paymentId", "refundId"] as const;
const AMOUNT_FIELDS = ["expectedJpy", "actualJpy"] as const;
const FIELDS = [...ID_FIELDS, ...AMOUNT_FIELDS] as const;

/** A change to D1 the reconciler may make. */
type Fix = { kind: "status"; row: RefundRow; status: string } | { kind: "insert"; booking: BookingRow; square: SquareRecord };

type Outcome = { issues: ExpectedIssue[]; fixes: Fix[] };

type Case = { type: IssueType; what: string; seed: (world: World) => Promise<Outcome> };

/** A fresh shop's D1 and what Square holds for it, every payment and refund of every location this test serves. */
class World {
  readonly payments: SquareRecord[] = [];
  readonly refunds: SquareRecord[] = [];
  readonly db: D1Database;
  readonly modelId: string;
  constructor(db: D1Database, modelId: string) {
    this.db = db;
    this.modelId = modelId;
  }
}

async function withWorld(run: (world: World) => Promise<void>): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedConfig(db);
    await seedCatalogMeta(db);
    await seedTiers(db, TIERS);
    const model = await seedModel(db);
    await run(new World(db, model.id));
  } finally {
    await dispose();
  }
}

function yen(low = 3000, high = 40_000): number {
  return randomInt(low, high + 1);
}

/** What a tier gives back, rounded down to the yen. */
function tierRefund(paid: number, percent: number): number {
  return Math.floor((paid * percent) / 100);
}

function newRef(): string {
  return `OD-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
}

function newPaymentId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 26);
}

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`fixture: no ${what}`);
  return value;
}

/** A payment as the client lists it. With no reference id it is one staff took in the Dashboard. */
function squarePayment(
  world: World,
  { at, amount, referenceId, status = "COMPLETED" }: { at: string; amount: number; referenceId?: string; status?: string },
): SquareRecord {
  const payment: SquareRecord = {
    id: newPaymentId(),
    status,
    amount,
    currency: "JPY",
    ...(referenceId === undefined ? {} : { reference_id: referenceId }),
    created_at: iso(jst(at)),
  };
  world.payments.push(payment);
  return payment;
}

type PaidBooking = {
  confirmed: string;
  pickup: string;
  paid?: number;
  /** Cancelled by the guest at this wall clock. */
  cancelled?: string;
  /**
   * Cancelled by staff instead, as #145's cancelByStaff leaves it: cancel_reason 'staff' and refund_due_jpy this total
   * refund it settled on, the refunds before it plus its own.
   */
  staffRefundDue?: number;
  /** What Square charged, when it differs from what D1 holds. */
  squareAmount?: number;
  /** What Square says of the payment, when it is not COMPLETED. */
  squareStatus?: string;
  /** False when the payment never reached Square's records. */
  inSquare?: boolean;
};

/** A web booking confirmed as #34 confirms one, and the COMPLETED payment that did it. */
async function paidBooking(world: World, spec: PaidBooking): Promise<{ booking: BookingRow; payment: SquareRecord }> {
  const paid = spec.paid ?? yen();
  const confirmedAt = jst(spec.confirmed);
  const heldAt = confirmedAt - 7 * MINUTE_MS;
  const startAt = jst(spec.pickup);
  const cancelledAt = spec.cancelled === undefined ? null : jst(spec.cancelled);
  const paymentId = newPaymentId();
  const booking = await seedBooking(world.db, {
    id: randomUUID(),
    ref: newRef(),
    status: cancelledAt === null ? "CONFIRMED" : "CANCELLED",
    source: "web",
    model_id: world.modelId,
    start_at: startAt,
    end_at: startAt + 2 * DAY_MS,
    expires_at: heldAt + 15 * MINUTE_MS,
    price_jpy: paid + yen(8000, 30_000),
    deposit_jpy: paid,
    payment_id: paymentId,
    payment_attempt: 1,
    paid_jpy: paid,
    cancel_reason: cancelledAt === null ? null : spec.staffRefundDue === undefined ? "guest" : "staff",
    created_at: heldAt,
    updated_at: cancelledAt ?? confirmedAt,
    confirmed_at: confirmedAt,
    cancelled_at: cancelledAt,
    refund_due_jpy: cancelledAt === null ? undefined : spec.staffRefundDue,
  });
  const payment: SquareRecord = {
    id: paymentId,
    status: spec.squareStatus ?? "COMPLETED",
    amount: spec.squareAmount ?? paid,
    currency: "JPY",
    reference_id: booking.id,
    created_at: iso(confirmedAt - 3000),
  };
  if (spec.inSquare !== false) world.payments.push(payment);
  return { booking, payment };
}

/** A web booking that never got as far as a confirmed payment. */
function unpaidBooking(world: World, status: string, createdAt: string): Promise<BookingRow> {
  const created = jst(createdAt);
  return seedBooking(world.db, {
    id: randomUUID(),
    ref: newRef(),
    status,
    source: "web",
    model_id: world.modelId,
    expires_at: created + 15 * MINUTE_MS,
    deposit_jpy: yen(),
    payment_attempt: status === "ON_HOLD" ? 0 : 1,
    created_at: created,
    updated_at: created + MINUTE_MS,
  });
}

type RefundSide = { amount: number; status: string };

type RefundSpec = {
  at: string;
  origin: "cancel" | "dashboard";
  amount: number;
  status: string;
  /** How D1 differs from Square, or null for a refund D1 never heard of. */
  d1?: Partial<RefundSide> | null;
};

/** One refund of a booking's payment, as Square lists it and as D1's refunds row holds it. */
async function refundOf(
  world: World,
  booking: BookingRow,
  spec: RefundSpec,
): Promise<{ square: SquareRecord; row: RefundRow | null }> {
  const at = jst(spec.at);
  const paymentId = must(booking.payment_id, "payment on the refunded booking");
  const squareId = `${paymentId}_${randomUUID().slice(0, 8)}`;
  const square: SquareRecord = {
    id: squareId,
    status: spec.status,
    amount: spec.amount,
    currency: "JPY",
    payment_id: paymentId,
    created_at: iso(at + 1000),
  };
  world.refunds.push(square);
  if (spec.d1 === null) return { square, row: null };
  const row = await insertRow<RefundRow>(world.db, "refunds", {
    id: randomUUID(),
    booking_id: booking.id,
    square_refund_id: squareId,
    amount_jpy: spec.d1?.amount ?? spec.amount,
    status: spec.d1?.status ?? spec.status,
    origin: spec.origin,
    idempotency_key: spec.origin === "cancel" ? `rf:${booking.id}` : null,
    created_at: at,
    updated_at: at + 2000,
  });
  return { square, row };
}

/** A refunds row with no Square id, as #35 leaves one before Square answers or after Square refused the call. */
function unsentRefund(
  world: World,
  booking: BookingRow,
  { at, origin, amount, status }: { at: string; origin: "cancel" | "dashboard"; amount: number; status: string },
): Promise<RefundRow> {
  const when = jst(at);
  return insertRow<RefundRow>(world.db, "refunds", {
    id: randomUUID(),
    booking_id: booking.id,
    square_refund_id: null,
    amount_jpy: amount,
    status,
    origin,
    idempotency_key: origin === "cancel" ? `rf:${booking.id}` : null,
    created_at: when,
    updated_at: when + 2000,
  });
}

/** A refund in Square of any payment, which D1 has no row for. */
function squareRefund(
  world: World,
  payment: SquareRecord,
  { at, amount, status }: { at: string; amount: number; status: string },
): SquareRecord {
  const refund: SquareRecord = {
    id: `${payment.id}_${randomUUID().slice(0, 8)}`,
    status,
    amount,
    currency: "JPY",
    payment_id: payment.id,
    created_at: iso(jst(at) + 30_000),
  };
  world.refunds.push(refund);
  return refund;
}

/**
 * Two payments #34 sent back in full, which D1 records nowhere: one that came in after its hold expired, and a wrong amount
 * on a booking a second payment then confirmed, sent back in two parts with one still pending.
 */
async function seedSentBack(world: World): Promise<{ expired: BookingRow; confirmed: BookingRow }> {
  const expired = await unpaidBooking(world, "EXPIRED", "2030-05-17 10:00");
  const late = squarePayment(world, { at: "2030-05-17 10:20", amount: must(expired.deposit_jpy, "deposit"), referenceId: expired.id });
  squareRefund(world, late, { at: "2030-05-17 10:20", amount: late.amount, status: "COMPLETED" });

  const { booking: confirmed } = await paidBooking(world, { confirmed: "2030-05-23 16:12", pickup: "2030-06-21 09:00" });
  const wrong = squarePayment(world, { at: "2030-05-23 16:05", amount: confirmed.paid_jpy + randomInt(1, 3000), referenceId: confirmed.id });
  const part = randomInt(1, wrong.amount);
  squareRefund(world, wrong, { at: "2030-05-23 16:05", amount: part, status: "COMPLETED" });
  squareRefund(world, wrong, { at: "2030-05-23 16:06", amount: wrong.amount - part, status: "PENDING" });
  return { expired, confirmed };
}

/** A payment #34 should have sent back, on a booking another payment confirmed. */
function strayIssue(booking: BookingRow, stray: SquareRecord): ExpectedIssue {
  return {
    type: "payment_without_booking",
    bookingRef: booking.ref,
    paymentId: stray.id,
    refundId: undefined,
    expectedJpy: oneOf(undefined, 0, booking.deposit_jpy ?? undefined),
    actualJpy: stray.amount,
  };
}

/**
 * Everything that agrees: the bookings, payments and refunds of an ordinary month, including the ones a careless reading
 * would flag. Each tier comment counts JST calendar days from the cancellation to the pickup date.
 */
async function seedClean(world: World): Promise<void> {
  await paidBooking(world, { confirmed: "2030-05-22 14:10", pickup: "2030-06-15 09:00" });
  await paidBooking(world, { confirmed: "2030-05-03 10:00", pickup: "2030-06-20 09:00" });

  // The card was declined, and the second try paid: two payments name this booking and only the second took money.
  const retried = await paidBooking(world, { confirmed: "2030-05-28 18:03", pickup: "2030-06-02 09:00" });
  squarePayment(world, {
    at: "2030-05-28 18:00",
    amount: must(retried.booking.deposit_jpy, "deposit"),
    referenceId: retried.booking.id,
    status: "FAILED",
  });

  // A hold that expired after a declined card.
  const expired = await unpaidBooking(world, "EXPIRED", "2030-05-15 11:00");
  squarePayment(world, {
    at: "2030-05-15 11:05",
    amount: must(expired.deposit_jpy, "deposit"),
    referenceId: expired.id,
    status: "FAILED",
  });

  // A live hold, and a staff block, which has no guest and nothing to pay.
  await unpaidBooking(world, "ON_HOLD", "2030-06-01 02:50");
  const blockedAt = jst("2030-05-20 12:00");
  await seedBooking(world.db, {
    id: randomUUID(),
    ref: newRef(),
    status: "CONFIRMED",
    source: "block",
    model_id: world.modelId,
    external_ref: `block-${randomUUID()}`,
    external_channel: "phone",
    price_jpy: null,
    deposit_jpy: null,
    catalog_version: null,
    locale: null,
    guest_family_name: null,
    guest_given_name: null,
    guest_email: null,
    guest_phone: null,
    created_at: blockedAt,
    updated_at: blockedAt,
    confirmed_at: blockedAt,
  });

  // 25 days, 100%. Counted from `now`, 5 days and 30%.
  const early = await paidBooking(world, { confirmed: "2030-05-01 09:30", pickup: "2030-06-06 09:00", cancelled: "2030-05-12 20:00" });
  await refundOf(world, early.booking, { at: "2030-05-12 20:00", origin: "cancel", amount: early.booking.paid_jpy, status: "COMPLETED" });

  // 7 days, 50% of an odd amount rounded down, still on its way. 6 days 23 hours elapsed, which a count of whole days
  // would put at 30%.
  const odd = 2 * randomInt(1500, 20_000) + 1;
  const halfway = await paidBooking(world, { confirmed: "2030-05-05 08:00", pickup: "2030-05-27 09:00", cancelled: "2030-05-20 10:00", paid: odd });
  await refundOf(world, halfway.booking, { at: "2030-05-20 10:00", origin: "cancel", amount: tierRefund(odd, 50), status: "PENDING" });

  // 6 days in JST, so 30%. In UTC the cancellation falls on 2030-05-13, 7 days and 50%.
  const lateNight = await paidBooking(world, { confirmed: "2030-05-02 12:00", pickup: "2030-05-20 09:00", cancelled: "2030-05-14 00:30" });
  await refundOf(world, lateNight.booking, {
    at: "2030-05-14 00:30",
    origin: "cancel",
    amount: tierRefund(lateNight.booking.paid_jpy, 30),
    status: "COMPLETED",
  });

  // 10 days, 50%. Staff refunded part in the Dashboard first, and the cancellation sent the rest of the tier.
  const shared = await paidBooking(world, { confirmed: "2030-05-08 09:00", pickup: "2030-06-10 09:00", cancelled: "2030-05-31 15:00", paid: yen(8000, 40_000) });
  const sharedTier = tierRefund(shared.booking.paid_jpy, 50);
  const byStaff = randomInt(500, sharedTier - 500);
  await refundOf(world, shared.booking, { at: "2030-05-25 10:00", origin: "dashboard", amount: byStaff, status: "COMPLETED" });
  await refundOf(world, shared.booking, { at: "2030-05-31 15:00", origin: "cancel", amount: sharedTier - byStaff, status: "COMPLETED" });

  // 1 day, 0%: nothing goes back.
  await paidBooking(world, { confirmed: "2030-05-10 09:00", pickup: "2030-05-26 09:00", cancelled: "2030-05-25 09:00" });

  // 38 days, 100%. Square rejected the cancellation's refund and staff refunded it in the Dashboard instead.
  const rejected = await paidBooking(world, { confirmed: "2030-04-30 09:00", pickup: "2030-06-25 09:00", cancelled: "2030-05-18 09:00" });
  await refundOf(world, rejected.booking, { at: "2030-05-18 09:00", origin: "cancel", amount: rejected.booking.paid_jpy, status: "REJECTED" });
  await refundOf(world, rejected.booking, { at: "2030-05-19 10:00", origin: "dashboard", amount: rejected.booking.paid_jpy, status: "COMPLETED" });

  // Paid before the window opened and cancelled inside it: 41 days, 100%. Its payment is not in the window's listing, but
  // its cancellation is, so the retained check covers it and finds the tier back.
  const paidEarlier = await paidBooking(world, { confirmed: "2030-04-20 09:00", pickup: "2030-07-01 09:00", cancelled: "2030-05-21 09:00" });
  await refundOf(world, paidEarlier.booking, { at: "2030-05-21 09:00", origin: "cancel", amount: paidEarlier.booking.paid_jpy, status: "COMPLETED" });

  // Confirmed before the window opened.
  await paidBooking(world, { confirmed: "2030-04-15 09:00", pickup: "2030-06-30 09:00" });

  // All of it long before the window: 10 days, 50%.
  const longAgo = await paidBooking(world, { confirmed: "2030-03-01 09:00", pickup: "2030-03-20 09:00", cancelled: "2030-03-10 09:00" });
  await refundOf(world, longAgo.booking, {
    at: "2030-03-10 09:00",
    origin: "cancel",
    amount: tierRefund(longAgo.booking.paid_jpy, 50),
    status: "COMPLETED",
  });

  await seedSentBack(world);

  // A charge Square has not answered yet: the ten-minute resolver's.
  await unpaidBooking(world, "PAYMENT_PENDING", "2030-06-01 02:40");

  // 24 days, 100%. A webhook recorded Square's refund in a row of its own, and the cancellation's row still waits as RETRY
  // with no Square id (#35's note for #36). Counted, the RETRY row would make it twice the tier.
  const stuck = await paidBooking(world, { confirmed: "2030-05-09 09:00", pickup: "2030-06-17 09:00", cancelled: "2030-05-24 13:00" });
  await unsentRefund(world, stuck.booking, { at: "2030-05-24 13:00", origin: "cancel", amount: stuck.booking.paid_jpy, status: "RETRY" });
  await refundOf(world, stuck.booking, { at: "2030-05-24 13:00", origin: "dashboard", amount: stuck.booking.paid_jpy, status: "COMPLETED" });

  // Refunds Square refused that D1 never heard of: no money moved, on a confirmed booking and on a cancelled one.
  const tried = await paidBooking(world, { confirmed: "2030-05-18 11:00", pickup: "2030-06-27 09:00" });
  await refundOf(world, tried.booking, {
    at: "2030-05-26 15:00",
    origin: "dashboard",
    amount: randomInt(500, tried.booking.paid_jpy),
    status: "FAILED",
    d1: null,
  });
  await refundOf(world, early.booking, { at: "2030-05-13 09:00", origin: "dashboard", amount: early.booking.paid_jpy, status: "REJECTED", d1: null });

  // Dashboard payments that took no money, or none yet: only a COMPLETED payment is reconciled.
  const tookNothing: [string, string][] = [
    ["2030-05-16 12:10", "CANCELED"],
    ["2030-05-29 15:45", "APPROVED"],
    ["2030-05-31 10:20", "PENDING"],
  ];
  for (const [at, status] of tookNothing) squarePayment(world, { at, amount: yen(), status });

  // Booked and cancelled before even a 60-day window opened: out of scope both ways, so its refused refund, which a
  // retained check would flag, is not looked at. 21 days, 100%.
  const outOfScope = await paidBooking(world, { confirmed: "2030-02-20 09:00", pickup: "2030-04-05 09:00", cancelled: "2030-03-15 09:00" });
  await unsentRefund(world, outOfScope.booking, { at: "2030-03-15 09:00", origin: "cancel", amount: outOfScope.booking.paid_jpy, status: "REJECTED" });
}

const DISCREPANCIES: Case[] = [
  {
    type: "payment_without_booking",
    what: "a Dashboard payment with no reference id",
    seed: async (world) => {
      const payment = squarePayment(world, { at: "2030-05-24 13:00", amount: yen() });
      const issue: ExpectedIssue = {
        type: "payment_without_booking",
        bookingRef: undefined,
        paymentId: payment.id,
        refundId: undefined,
        expectedJpy: ABSENT,
        actualJpy: payment.amount,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "payment_without_booking",
    what: "a payment whose reference id names no booking",
    seed: async (world) => {
      const payment = squarePayment(world, { at: "2030-05-12 16:40", amount: yen(), referenceId: randomUUID() });
      const issue: ExpectedIssue = {
        type: "payment_without_booking",
        bookingRef: undefined,
        paymentId: payment.id,
        refundId: undefined,
        expectedJpy: ABSENT,
        actualJpy: payment.amount,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "booking_without_payment",
    what: "a confirmed booking whose payment Square does not have",
    seed: async (world) => {
      const { booking } = await paidBooking(world, { confirmed: "2030-05-16 09:00", pickup: "2030-06-18 09:00", inSquare: false });
      const issue: ExpectedIssue = {
        type: "booking_without_payment",
        bookingRef: booking.ref,
        paymentId: must(booking.payment_id, "payment id"),
        refundId: undefined,
        expectedJpy: booking.paid_jpy,
        actualJpy: ABSENT,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "amount_mismatch",
    what: "Square took more than D1 holds",
    seed: async (world) => {
      const paid = yen();
      const charged = paid + randomInt(1, 5000);
      const { booking, payment } = await paidBooking(world, { confirmed: "2030-05-21 11:00", pickup: "2030-06-12 09:00", paid, squareAmount: charged });
      const issue: ExpectedIssue = {
        type: "amount_mismatch",
        bookingRef: booking.ref,
        paymentId: payment.id,
        refundId: undefined,
        expectedJpy: paid,
        actualJpy: charged,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "amount_mismatch",
    what: "Square took less than D1 holds",
    seed: async (world) => {
      const paid = yen(6000, 40_000);
      const charged = paid - randomInt(1, 5000);
      const { booking, payment } = await paidBooking(world, { confirmed: "2030-05-09 15:00", pickup: "2030-06-08 09:00", paid, squareAmount: charged });
      const issue: ExpectedIssue = {
        type: "amount_mismatch",
        bookingRef: booking.ref,
        paymentId: payment.id,
        refundId: undefined,
        expectedJpy: paid,
        actualJpy: charged,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "amount_mismatch",
    what: "Square took more than D1 holds, on a booking cancelled with all of D1's paid back",
    seed: async (world) => {
      // 40 days, 100%. Retained is worked out from D1's paid, which went back in full, so only the payment is wrong.
      const paid = yen();
      const charged = paid + randomInt(1, 5000);
      const { booking, payment } = await paidBooking(world, {
        confirmed: "2030-05-14 13:00",
        pickup: "2030-06-30 09:00",
        cancelled: "2030-05-21 18:00",
        paid,
        squareAmount: charged,
      });
      await refundOf(world, booking, { at: "2030-05-21 18:00", origin: "cancel", amount: paid, status: "COMPLETED" });
      const issue: ExpectedIssue = {
        type: "amount_mismatch",
        bookingRef: booking.ref,
        paymentId: payment.id,
        refundId: undefined,
        expectedJpy: paid,
        actualJpy: charged,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "booking_without_payment",
    what: "a booking cancelled with nothing back, whose payment Square does not have",
    seed: async (world) => {
      // 1 day, 0%: no refund was due, so retained agrees and only the payment is missing.
      const { booking } = await paidBooking(world, {
        confirmed: "2030-05-06 16:00",
        pickup: "2030-05-24 09:00",
        cancelled: "2030-05-23 12:00",
        inSquare: false,
      });
      const issue: ExpectedIssue = {
        type: "booking_without_payment",
        bookingRef: booking.ref,
        paymentId: must(booking.payment_id, "payment id"),
        refundId: undefined,
        expectedJpy: booking.paid_jpy,
        actualJpy: ABSENT,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "booking_without_payment",
    what: "a confirmed booking whose payment Square lists only as canceled",
    seed: async (world) => {
      const { booking } = await paidBooking(world, { confirmed: "2030-05-25 10:30", pickup: "2030-06-26 09:00", squareStatus: "CANCELED" });
      const issue: ExpectedIssue = {
        type: "booking_without_payment",
        bookingRef: booking.ref,
        paymentId: must(booking.payment_id, "payment id"),
        refundId: undefined,
        expectedJpy: booking.paid_jpy,
        actualJpy: oneOf(undefined, 0, booking.paid_jpy),
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "status_mismatch",
    what: "a completed payment on a hold that expired",
    seed: async (world) => {
      const booking = await unpaidBooking(world, "EXPIRED", "2030-05-19 15:50");
      const deposit = must(booking.deposit_jpy, "deposit");
      const payment = squarePayment(world, { at: "2030-05-19 16:00", amount: deposit, referenceId: booking.id });
      const issue: ExpectedIssue = {
        type: "status_mismatch",
        bookingRef: booking.ref,
        paymentId: payment.id,
        refundId: undefined,
        expectedJpy: oneOf(undefined, 0, deposit),
        actualJpy: deposit,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "status_mismatch",
    what: "a completed payment on a booking still in payment",
    seed: async (world) => {
      const booking = await unpaidBooking(world, "PAYMENT_PENDING", "2030-05-30 20:00");
      const deposit = must(booking.deposit_jpy, "deposit");
      const payment = squarePayment(world, { at: "2030-05-30 20:01", amount: deposit, referenceId: booking.id });
      const issue: ExpectedIssue = {
        type: "status_mismatch",
        bookingRef: booking.ref,
        paymentId: payment.id,
        refundId: undefined,
        expectedJpy: oneOf(undefined, 0, deposit),
        actualJpy: deposit,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "status_mismatch",
    what: "a payment on an expired hold whose send-back failed",
    seed: async (world) => {
      // The failed refund moved no money, so it is neither recorded nor reported.
      const booking = await unpaidBooking(world, "EXPIRED", "2030-05-08 14:00");
      const deposit = must(booking.deposit_jpy, "deposit");
      const payment = squarePayment(world, { at: "2030-05-08 14:25", amount: deposit, referenceId: booking.id });
      squareRefund(world, payment, { at: "2030-05-08 14:25", amount: deposit, status: "FAILED" });
      const issue: ExpectedIssue = {
        type: "status_mismatch",
        bookingRef: booking.ref,
        paymentId: payment.id,
        refundId: undefined,
        expectedJpy: oneOf(undefined, 0, deposit),
        actualJpy: deposit,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "payment_without_booking",
    what: "a wrong amount on a booking another payment confirmed, never sent back",
    seed: async (world) => {
      const { booking } = await paidBooking(world, { confirmed: "2030-05-19 12:40", pickup: "2030-06-24 09:00" });
      const stray = squarePayment(world, { at: "2030-05-19 12:31", amount: booking.paid_jpy - randomInt(1, 2000), referenceId: booking.id });
      return { issues: [strayIssue(booking, stray)], fixes: [] };
    },
  },
  {
    type: "payment_without_booking",
    what: "a wrong amount on a booking another payment confirmed, sent back short",
    seed: async (world) => {
      // The refund is of a payment the booking does not hold, so it is not recorded against the booking.
      const { booking } = await paidBooking(world, { confirmed: "2030-05-27 09:15", pickup: "2030-07-03 09:00" });
      const stray = squarePayment(world, { at: "2030-05-27 09:08", amount: booking.paid_jpy + randomInt(1, 3000), referenceId: booking.id });
      squareRefund(world, stray, { at: "2030-05-27 09:08", amount: stray.amount - randomInt(1, 1000), status: "COMPLETED" });
      return { issues: [strayIssue(booking, stray)], fixes: [] };
    },
  },
  {
    type: "payment_without_booking",
    what: "a walk-in Dashboard sale, partly refunded",
    seed: async (world) => {
      // The payment's own issue covers its refund, which belongs to no booking.
      const payment = squarePayment(world, { at: "2030-05-13 17:20", amount: yen(5000, 40_000) });
      squareRefund(world, payment, { at: "2030-05-14 10:00", amount: randomInt(1000, payment.amount), status: "COMPLETED" });
      const issue: ExpectedIssue = {
        type: "payment_without_booking",
        bookingRef: undefined,
        paymentId: payment.id,
        refundId: undefined,
        expectedJpy: ABSENT,
        actualJpy: payment.amount,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "refund_not_recorded",
    what: "a Dashboard refund D1 never heard of",
    seed: async (world) => {
      // 10 days, 50%. With the Dashboard refund the booking has had its tier back, so nothing else is wrong with it.
      const { booking } = await paidBooking(world, { confirmed: "2030-05-04 10:00", pickup: "2030-06-09 09:00", cancelled: "2030-05-30 12:00", paid: yen(8000, 40_000) });
      const tier = tierRefund(booking.paid_jpy, 50);
      const byStaff = randomInt(500, tier - 500);
      await refundOf(world, booking, { at: "2030-05-30 12:00", origin: "cancel", amount: tier - byStaff, status: "COMPLETED" });
      const { square } = await refundOf(world, booking, { at: "2030-05-26 17:00", origin: "dashboard", amount: byStaff, status: "COMPLETED", d1: null });
      const issue: ExpectedIssue = {
        type: "refund_not_recorded",
        bookingRef: booking.ref,
        paymentId: oneOf(undefined, must(booking.payment_id, "payment id")),
        refundId: square.id,
        expectedJpy: ABSENT,
        actualJpy: byStaff,
      };
      return { issues: [issue], fixes: [{ kind: "insert", booking, square }] };
    },
  },
  {
    type: "refund_status_mismatch",
    what: "a refund D1 still has as pending that Square completed",
    seed: async (world) => {
      // 32 days, 100%.
      const { booking } = await paidBooking(world, { confirmed: "2030-05-06 09:00", pickup: "2030-06-28 09:00", cancelled: "2030-05-27 09:00" });
      const refund = await refundOf(world, booking, {
        at: "2030-05-27 09:00",
        origin: "cancel",
        amount: booking.paid_jpy,
        status: "COMPLETED",
        d1: { status: "PENDING" },
      });
      const issue: ExpectedIssue = {
        type: "refund_status_mismatch",
        bookingRef: booking.ref,
        paymentId: oneOf(undefined, must(booking.payment_id, "payment id")),
        refundId: refund.square.id,
        expectedJpy: booking.paid_jpy,
        actualJpy: booking.paid_jpy,
      };
      return { issues: [issue], fixes: [{ kind: "status", row: must(refund.row, "refund row"), status: "COMPLETED" }] };
    },
  },
  {
    type: "refund_amount_mismatch",
    what: "two refunds whose amounts differ from Square's, by as much each way",
    seed: async (world) => {
      // 9 days, 50%. The differences cancel out, so the booking's total is its tier on either side.
      const { booking } = await paidBooking(world, { confirmed: "2030-05-11 09:00", pickup: "2030-06-04 09:00", cancelled: "2030-05-26 18:00", paid: yen(8000, 40_000) });
      const tier = tierRefund(booking.paid_jpy, 50);
      const first = randomInt(1000, tier - 1000);
      const second = tier - first;
      const gap = randomInt(1, Math.min(first, second));
      const over = await refundOf(world, booking, { at: "2030-05-26 18:00", origin: "cancel", amount: first + gap, status: "COMPLETED", d1: { amount: first } });
      const under = await refundOf(world, booking, { at: "2030-05-28 10:00", origin: "dashboard", amount: second - gap, status: "COMPLETED", d1: { amount: second } });
      const paymentId = oneOf(undefined, must(booking.payment_id, "payment id"));
      const issues: ExpectedIssue[] = [
        { type: "refund_amount_mismatch", bookingRef: booking.ref, paymentId, refundId: over.square.id, expectedJpy: first, actualJpy: first + gap },
        { type: "refund_amount_mismatch", bookingRef: booking.ref, paymentId, refundId: under.square.id, expectedJpy: second, actualJpy: second - gap },
      ];
      return { issues, fixes: [] };
    },
  },
  {
    type: "retained_mismatch",
    what: "less went back than the tier gives",
    seed: async (world) => {
      // 35 days, 100%.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-13 09:00", pickup: "2030-06-27 09:00", cancelled: "2030-05-23 09:00", paid });
      const back = randomInt(1000, paid - 1000);
      await refundOf(world, booking, { at: "2030-05-23 09:00", origin: "cancel", amount: back, status: "COMPLETED" });
      const issue: ExpectedIssue = {
        type: "retained_mismatch",
        bookingRef: booking.ref,
        paymentId: must(booking.payment_id, "payment id"),
        refundId: ANY,
        expectedJpy: 0,
        actualJpy: paid - back,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "retained_mismatch",
    what: "more went back than the tier gives",
    seed: async (world) => {
      // 4 days, 30%. Cancelled at 01:00 on the cron's own day.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-07 09:00", pickup: "2030-06-05 09:00", cancelled: "2030-06-01 01:00", paid });
      const tier = tierRefund(paid, 30);
      const back = randomInt(tier + 1, paid);
      await refundOf(world, booking, { at: "2030-06-01 01:30", origin: "dashboard", amount: back, status: "COMPLETED" });
      const issue: ExpectedIssue = {
        type: "retained_mismatch",
        bookingRef: booking.ref,
        paymentId: must(booking.payment_id, "payment id"),
        refundId: ANY,
        expectedJpy: paid - tier,
        actualJpy: paid - back,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "retained_mismatch",
    what: "a cancellation whose refund failed, with nothing in Square",
    seed: async (world) => {
      // 10 days, 50%. The failed refund gave nothing back.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-12 09:00", pickup: "2030-06-08 09:00", cancelled: "2030-05-29 09:00", paid });
      const tier = tierRefund(paid, 50);
      await unsentRefund(world, booking, { at: "2030-05-29 09:00", origin: "cancel", amount: tier, status: "FAILED" });
      const issue: ExpectedIssue = {
        type: "retained_mismatch",
        bookingRef: booking.ref,
        paymentId: must(booking.payment_id, "payment id"),
        refundId: ANY,
        expectedJpy: paid - tier,
        actualJpy: paid,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "refund_not_recorded",
    what: "a Dashboard refund of a payment older than the window, on a cancelled booking",
    seed: async (world) => {
      // Paid 49 days back, so the payment is not in the listing. 43 days, 100%, all of it in this refund.
      const { booking } = await paidBooking(world, { confirmed: "2030-04-12 09:00", pickup: "2030-07-08 09:00", cancelled: "2030-05-26 09:00" });
      const { square } = await refundOf(world, booking, {
        at: "2030-05-26 11:00",
        origin: "dashboard",
        amount: booking.paid_jpy,
        status: "COMPLETED",
        d1: null,
      });
      const issue: ExpectedIssue = {
        type: "refund_not_recorded",
        bookingRef: booking.ref,
        paymentId: oneOf(undefined, must(booking.payment_id, "payment id")),
        refundId: square.id,
        expectedJpy: ABSENT,
        actualJpy: booking.paid_jpy,
      };
      return { issues: [issue], fixes: [{ kind: "insert", booking, square }] };
    },
  },
  {
    type: "refund_not_recorded",
    what: "a partial Dashboard refund of a payment older than the window, on a confirmed booking",
    seed: async (world) => {
      // Paid 43 days back, so the payment is not in the listing.
      const { booking } = await paidBooking(world, { confirmed: "2030-04-18 09:00", pickup: "2030-07-15 09:00", paid: yen(5000, 40_000) });
      const back = randomInt(500, booking.paid_jpy - 500);
      const { square } = await refundOf(world, booking, { at: "2030-05-19 14:00", origin: "dashboard", amount: back, status: "COMPLETED", d1: null });
      const issue: ExpectedIssue = {
        type: "refund_not_recorded",
        bookingRef: booking.ref,
        paymentId: oneOf(undefined, must(booking.payment_id, "payment id")),
        refundId: square.id,
        expectedJpy: ABSENT,
        actualJpy: back,
      };
      return { issues: [issue], fixes: [{ kind: "insert", booking, square }] };
    },
  },
  {
    type: "retained_mismatch",
    what: "a booking made before the window and cancelled inside it, whose refund Square refused",
    seed: async (world) => {
      // Booked 92 days back for a pickup months out. 46 days, 100%. The refused call left the row REJECTED with no Square
      // id, so nothing went back. Its payment is not in the listing, which is no booking_without_payment.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-03-01 10:00", pickup: "2030-07-10 09:00", cancelled: "2030-05-25 14:00", paid });
      await unsentRefund(world, booking, { at: "2030-05-25 14:00", origin: "cancel", amount: paid, status: "REJECTED" });
      const issue: ExpectedIssue = {
        type: "retained_mismatch",
        bookingRef: booking.ref,
        paymentId: must(booking.payment_id, "payment id"),
        refundId: ANY,
        expectedJpy: 0,
        actualJpy: paid,
      };
      return { issues: [issue], fixes: [] };
    },
  },
  {
    type: "retained_mismatch",
    what: "a booking made before the window and cancelled inside it, whose refund is stuck in RETRY",
    seed: async (world) => {
      // Booked 60 days back. 9 days, 50%. A RETRY row still there at the daily run is stuck, and nothing went back.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-04-02 09:00", pickup: "2030-06-06 09:00", cancelled: "2030-05-28 11:00", paid });
      const tier = tierRefund(paid, 50);
      await unsentRefund(world, booking, { at: "2030-05-28 11:00", origin: "cancel", amount: tier, status: "RETRY" });
      const issue: ExpectedIssue = {
        type: "retained_mismatch",
        bookingRef: booking.ref,
        paymentId: must(booking.payment_id, "payment id"),
        refundId: ANY,
        expectedJpy: paid - tier,
        actualJpy: paid,
      };
      return { issues: [issue], fixes: [] };
    },
  },
];

/** More of what the two fixes have to get right, for the test of the fixes. */
const MORE_FIXES: Case[] = [
  {
    type: "refund_not_recorded",
    what: "a pending Dashboard refund D1 never heard of",
    seed: async (world) => {
      // 31 days, 100%, all of it in this one refund.
      const { booking } = await paidBooking(world, { confirmed: "2030-05-14 09:00", pickup: "2030-06-29 09:00", cancelled: "2030-05-29 09:00" });
      const { square } = await refundOf(world, booking, { at: "2030-05-29 10:00", origin: "dashboard", amount: booking.paid_jpy, status: "PENDING", d1: null });
      const issue: ExpectedIssue = {
        type: "refund_not_recorded",
        bookingRef: booking.ref,
        paymentId: oneOf(undefined, must(booking.payment_id, "payment id")),
        refundId: square.id,
        expectedJpy: ABSENT,
        actualJpy: booking.paid_jpy,
      };
      return { issues: [issue], fixes: [{ kind: "insert", booking, square }] };
    },
  },
  {
    type: "refund_status_mismatch",
    what: "a pending refund Square rejected, which leaves the shop holding the tier",
    seed: async (world) => {
      // 10 days, 50%. Once D1 has the rejection, nothing has gone back.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-15 09:00", pickup: "2030-06-07 09:00", cancelled: "2030-05-28 09:00", paid });
      const tier = tierRefund(paid, 50);
      const refund = await refundOf(world, booking, { at: "2030-05-28 09:00", origin: "cancel", amount: tier, status: "REJECTED", d1: { status: "PENDING" } });
      const paymentId = must(booking.payment_id, "payment id");
      const issues: ExpectedIssue[] = [
        { type: "refund_status_mismatch", bookingRef: booking.ref, paymentId: oneOf(undefined, paymentId), refundId: refund.square.id, expectedJpy: tier, actualJpy: tier },
        { type: "retained_mismatch", bookingRef: booking.ref, paymentId, refundId: ANY, expectedJpy: paid - tier, actualJpy: paid },
      ];
      return { issues, fixes: [{ kind: "status", row: must(refund.row, "refund row"), status: "REJECTED" }] };
    },
  },
  {
    type: "refund_status_mismatch",
    what: "a pending refund Square failed, which leaves the shop holding all of it",
    seed: async (world) => {
      // 15 days, 100%. Once D1 has the failure, nothing has gone back.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-19 09:00", pickup: "2030-06-14 09:00", cancelled: "2030-05-30 15:00", paid });
      const refund = await refundOf(world, booking, { at: "2030-05-30 15:00", origin: "cancel", amount: paid, status: "FAILED", d1: { status: "PENDING" } });
      const paymentId = must(booking.payment_id, "payment id");
      const issues: ExpectedIssue[] = [
        { type: "refund_status_mismatch", bookingRef: booking.ref, paymentId: oneOf(undefined, paymentId), refundId: refund.square.id, expectedJpy: paid, actualJpy: paid },
        { type: "retained_mismatch", bookingRef: booking.ref, paymentId, refundId: ANY, expectedJpy: 0, actualJpy: paid },
      ];
      return { issues, fixes: [{ kind: "status", row: must(refund.row, "refund row"), status: "FAILED" }] };
    },
  },
  {
    type: "refund_status_mismatch",
    what: "a refund whose status and amount both differ: the status moves and the amount stays",
    seed: async (world) => {
      // 11 days, 50%. A second refund differs the other way, so the total is the tier on either side.
      const { booking } = await paidBooking(world, { confirmed: "2030-05-17 09:00", pickup: "2030-06-11 09:00", cancelled: "2030-05-31 20:00", paid: yen(10_000, 40_000) });
      const tier = tierRefund(booking.paid_jpy, 50);
      const first = randomInt(1000, tier - 1000);
      const second = tier - first;
      const gap = randomInt(1, Math.min(first, second));
      const moved = await refundOf(world, booking, {
        at: "2030-05-31 20:00",
        origin: "cancel",
        amount: first + gap,
        status: "COMPLETED",
        d1: { amount: first, status: "PENDING" },
      });
      const other = await refundOf(world, booking, { at: "2030-05-31 21:00", origin: "dashboard", amount: second - gap, status: "COMPLETED", d1: { amount: second } });
      const paymentId = oneOf(undefined, must(booking.payment_id, "payment id"));
      const issues: ExpectedIssue[] = [
        { type: "refund_status_mismatch", bookingRef: booking.ref, paymentId, refundId: moved.square.id, expectedJpy: first, actualJpy: first + gap },
        { type: "refund_amount_mismatch", bookingRef: booking.ref, paymentId, refundId: moved.square.id, expectedJpy: first, actualJpy: first + gap },
        { type: "refund_amount_mismatch", bookingRef: booking.ref, paymentId, refundId: other.square.id, expectedJpy: second, actualJpy: second - gap },
      ];
      return { issues, fixes: [{ kind: "status", row: must(moved.row, "refund row"), status: "COMPLETED" }] };
    },
  },
];

type Fake = {
  square: SquareClient;
  windows: { payments: SquareTimeWindow[]; refunds: SquareTimeWindow[] };
  /** Calls that move money, which a reconciliation never makes. */
  moneyCalls: string[];
};

/** Square as the world holds it, listing what was created inside the window as Square does, or failing a listing. */
function fakeSquare(world: World, fail: { payments?: SquareFailure; refunds?: SquareFailure } = {}): Fake {
  const windows: Fake["windows"] = { payments: [], refunds: [] };
  const moneyCalls: string[] = [];
  const within = (record: SquareRecord, { beginTime, endTime }: SquareTimeWindow) => {
    const at = Date.parse(record.created_at ?? "");
    return at >= beginTime && at <= endTime;
  };
  const square: SquareClient = {
    async createPayment() {
      moneyCalls.push("createPayment");
      throw new Error("a reconciliation takes no payment");
    },
    async refundPayment() {
      moneyCalls.push("refundPayment");
      throw new Error("a reconciliation sends no refund");
    },
    async getPayment(id) {
      const payment = world.payments.find((record) => record.id === id);
      if (payment === undefined) return { kind: "error", code: "NOT_FOUND", detail: `Could not find payment with id: ${id}` };
      return { kind: "ok", payment: { ...payment } };
    },
    async listPayments(window) {
      windows.payments.push({ ...window });
      if (fail.payments) return fail.payments;
      return { kind: "ok", payments: world.payments.filter((record) => within(record, window)).map((record) => ({ ...record })) };
    },
    async listRefunds(window) {
      windows.refunds.push({ ...window });
      if (fail.refunds) return fail.refunds;
      return { kind: "ok", refunds: world.refunds.filter((record) => within(record, window)).map((record) => ({ ...record })) };
    },
  };
  return { square, windows, moneyCalls };
}

type Result = { issues: unknown; fixed: unknown };

async function reconcile(world: World, square: SquareClient, opts?: { days?: number }): Promise<Result> {
  const { reconcileSquare } = await reconcileModule();
  const deps = { db: world.db, square, now: NOW };
  return opts === undefined ? reconcileSquare(deps) : reconcileSquare(deps, opts);
}

function fits(issue: Issue, want: ExpectedIssue): boolean {
  if (issue.type !== want.type) return false;
  return FIELDS.every((key) => {
    const expected = want[key];
    const actual = issue[key];
    if (expected === ANY) return true;
    return expected instanceof OneOf ? expected.values.some((value) => Object.is(value, actual)) : Object.is(expected, actual);
  });
}

function show(want: ExpectedIssue): string {
  const one = (value: Value) => (value === undefined ? "absent" : JSON.stringify(value));
  const field = (value: Field) => {
    if (value === ANY) return "any";
    return value instanceof OneOf ? `one of ${value.values.map(one).join("/")}` : one(value);
  };
  return `${want.type} {${FIELDS.map((key) => `${key}: ${field(want[key])}`).join(", ")}}`;
}

/** The issues are exactly these, each once, whatever their order, and each one well formed. */
function assertIssues(issues: unknown, expected: ExpectedIssue[], label: string): void {
  assert.ok(Array.isArray(issues), `${label}: issues is not an array`);
  for (const issue of issues as Issue[]) {
    const text = JSON.stringify(issue);
    assert.ok((ISSUE_TYPES as readonly unknown[]).includes(issue.type), `${label}: an unknown type in ${text}`);
    assert.ok(typeof issue.detail === "string" && issue.detail.trim() !== "", `${label}: no detail in ${text}`);
    for (const key of ID_FIELDS) {
      const value = issue[key];
      assert.ok(value === undefined || (typeof value === "string" && value !== ""), `${label}: ${key} in ${text}`);
    }
    for (const key of AMOUNT_FIELDS) {
      const value = issue[key];
      assert.ok(value === undefined || Number.isSafeInteger(value), `${label}: ${key} in ${text}`);
    }
  }
  const unmatched = [...(issues as Issue[])];
  const missing: string[] = [];
  for (const want of expected) {
    const index = unmatched.findIndex((issue) => fits(issue, want));
    if (index === -1) missing.push(show(want));
    else unmatched.splice(index, 1);
  }
  assert.deepEqual({ missing, unexpected: unmatched.map((issue) => JSON.stringify(issue)) }, { missing: [], unexpected: [] }, label);
}

const TABLES_SQL = `SELECT name FROM sqlite_master
  WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND substr(name, 1, 4) <> '_cf_' ORDER BY name`;

type Snapshot = { tables: Record<string, unknown[]>; refunds: RefundRow[] };

/** Every row of every table, with refunds apart so their changes can be told one by one. */
async function snapshot(db: D1Database): Promise<Snapshot> {
  const { results: names } = await db.prepare(TABLES_SQL).all<{ name: string }>();
  const tables: Record<string, unknown[]> = {};
  for (const { name } of names) {
    if (name !== "refunds") tables[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
  }
  assert.ok("bookings" in tables && "outbox" in tables, "snapshot: the tables were not found");
  const { results: refunds } = await db.prepare("SELECT * FROM refunds ORDER BY id").all<RefundRow>();
  return { tables, refunds };
}

/** D1 went from `before` to `after` by these fixes and nothing else. */
function assertOnlyFixes(before: Snapshot, after: Snapshot, fixes: Fix[], label: string): void {
  assert.deepEqual(after.tables, before.tables, `${label}: a table other than refunds changed`);

  const statuses = new Map(fixes.flatMap((fix) => (fix.kind === "status" ? [[fix.row.id, fix.status] as const] : [])));
  const inserts = new Map(fixes.flatMap((fix) => (fix.kind === "insert" ? [[fix.square.id, fix] as const] : [])));
  const afterById = new Map(after.refunds.map((row) => [row.id, row]));
  const beforeIds = new Set(before.refunds.map(({ id }) => id));

  for (const old of before.refunds) {
    const now = afterById.get(old.id);
    assert.ok(now, `${label}: refund ${old.square_refund_id} was deleted`);
    const status = statuses.get(old.id);
    if (status === undefined) {
      assert.deepEqual(now, old, `${label}: refund ${old.square_refund_id} changed`);
      continue;
    }
    assert.deepEqual({ ...now, updated_at: old.updated_at }, { ...old, status }, `${label}: refund ${old.square_refund_id} takes Square's status and nothing else`);
    assert.ok([old.updated_at, NOW].includes(now.updated_at), `${label}: refund ${old.square_refund_id} updated_at ${now.updated_at}`);
  }

  const added = after.refunds.filter(({ id }) => !beforeIds.has(id));
  assert.deepEqual(added.map((row) => row.square_refund_id).sort(), [...inserts.keys()].sort(), `${label}: the refunds recorded`);
  for (const row of added) {
    const fix = inserts.get(row.square_refund_id ?? "");
    assert.ok(fix && fix.kind === "insert", label);
    assert.deepEqual(
      {
        booking_id: row.booking_id,
        amount_jpy: row.amount_jpy,
        status: row.status,
        origin: row.origin,
        idempotency_key: row.idempotency_key,
      },
      {
        booking_id: fix.booking.id,
        amount_jpy: fix.square.amount,
        status: fix.square.status,
        origin: "dashboard",
        idempotency_key: null,
      },
      `${label}: refund ${row.square_refund_id} as recorded`,
    );
    assert.ok(typeof row.id === "string" && row.id !== "", `${label}: a recorded refund's id`);
    const squareAt = Date.parse(fix.square.created_at ?? "");
    assert.ok([NOW, squareAt].includes(row.created_at), `${label}: refund ${row.square_refund_id} created_at ${row.created_at}`);
    assert.ok([NOW, squareAt].includes(row.updated_at), `${label}: refund ${row.square_refund_id} updated_at ${row.updated_at}`);
  }
}

test("a clean state has no issues", async () => {
  await withWorld(async (world) => {
    await seedClean(world);
    const fake = fakeSquare(world);
    const before = await snapshot(world.db);

    const result = await reconcile(world, fake.square);

    assertIssues(result.issues, [], "a clean state");
    assert.equal(result.fixed, 0, "fixed");
    assertOnlyFixes(before, await snapshot(world.db), [], "a clean state");
    assert.deepEqual(fake.moneyCalls, [], "money moved");
    assert.ok(fake.windows.payments.length > 0 && fake.windows.refunds.length > 0, "both listings were read");
  });
});

test("each discrepancy is reported", async () => {
  assert.deepEqual([...new Set(DISCREPANCIES.map(({ type }) => type))].sort(), [...ISSUE_TYPES].sort(), "a row for every issue type");

  for (const { what, seed } of DISCREPANCIES) {
    await withWorld(async (world) => {
      await seedClean(world);
      const { issues, fixes } = await seed(world);
      const fake = fakeSquare(world);
      const before = await snapshot(world.db);

      const result = await reconcile(world, fake.square);

      assertIssues(result.issues, issues, what);
      assert.equal(result.fixed, fixes.length, `${what}: fixed`);
      assertOnlyFixes(before, await snapshot(world.db), fixes, what);
      assert.deepEqual(fake.moneyCalls, [], `${what}: money moved`);
    });
  }
});

test("only refund status and dashboard refunds are fixed", async () => {
  await withWorld(async (world) => {
    await seedClean(world);
    const outcomes: Outcome[] = [];
    for (const { seed } of [...DISCREPANCIES, ...MORE_FIXES]) outcomes.push(await seed(world));
    const issues = outcomes.flatMap((outcome) => outcome.issues);
    const fixes = outcomes.flatMap((outcome) => outcome.fixes);
    const fake = fakeSquare(world);
    const before = await snapshot(world.db);

    const first = await reconcile(world, fake.square);

    assertIssues(first.issues, issues, "every discrepancy at once");
    assert.equal(first.fixed, fixes.length, "fixed");
    const fixed = await snapshot(world.db);
    assertOnlyFixes(before, fixed, fixes, "every discrepancy at once");
    assert.deepEqual(fake.moneyCalls, [], "money moved");

    // The next day the fixes are on record: what they settled is gone, the rest is still reported, and nothing changes.
    const settled = new Set<IssueType>(["refund_not_recorded", "refund_status_mismatch"]);
    const again = await reconcile(world, fakeSquare(world).square);
    assertIssues(again.issues, issues.filter(({ type }) => !settled.has(type)), "the run after");
    assert.equal(again.fixed, 0, "fixed by the run after");
    assertOnlyFixes(fixed, await snapshot(world.db), [], "the run after");
  });
});

test("payments sent back in full are not counted against a booking", async () => {
  await withWorld(async (world) => {
    const { expired, confirmed } = await seedSentBack(world);
    const fake = fakeSquare(world);
    const before = await snapshot(world.db);

    const result = await reconcile(world, fake.square);

    assertIssues(result.issues, [], "sent back in full");
    assert.equal(result.fixed, 0, "fixed");
    assertOnlyFixes(before, await snapshot(world.db), [], "sent back in full");
    for (const booking of [expired, confirmed]) {
      const { results } = await world.db.prepare("SELECT id FROM refunds WHERE booking_id = ?1").bind(booking.id).all();
      assert.deepEqual(results, [], `${booking.status}: a refund recorded on the booking`);
    }
    // 20 days from now to the pickup, 100%: the guest still gets back all of the payment that confirmed the booking.
    const quote = await quoteCancellation(world.db, confirmed.id, NOW);
    assert.ok(quote.ok, JSON.stringify(quote));
    assert.equal(quote.refundJpy, confirmed.paid_jpy, "a cancellation quoted after the reconciliation");
  });
});

/** A fake of Square's list endpoints, serving fixed pages whatever the location asked for. */
function squareApi(pages: { payments: Json[][]; refunds: Json[][] }) {
  const cursors = {
    payments: pages.payments.map((_, index) => `p${index}+/=${randomUUID()}`),
    refunds: pages.refunds.map((_, index) => `r${index}+/=${randomUUID()}`),
  };
  const served = { payments: new Set<number>(), refunds: new Set<number>() };
  const requests: URL[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);
    const key = url.pathname === "/v2/payments" ? "payments" : url.pathname === "/v2/refunds" ? "refunds" : null;
    if (request.method !== "GET" || key === null) {
      return json(404, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND", detail: "Not served in this test" }] });
    }
    const cursor = url.searchParams.get("cursor");
    const index = cursor === null ? 0 : cursors[key].indexOf(cursor) + 1;
    if (cursor !== null && index === 0) {
      return json(400, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "INVALID_CURSOR", detail: "Unknown cursor" }] });
    }
    served[key].add(index);
    const last = index === pages[key].length - 1;
    return json(200, { [key]: pages[key][index], ...(last ? {} : { cursor: cursors[key][index] }) });
  };
  return { fetch, served, requests };
}

const LOCATION = `L${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
const OTHER_LOCATION = `L${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;

/** A record as Square's API writes it, at a location. */
function wire(record: SquareRecord, locationId: string): Json {
  const { amount, currency, ...rest } = record;
  return { ...rest, amount_money: { amount, currency }, location_id: locationId, updated_at: rest.created_at };
}

function realClient(fetch: typeof globalThis.fetch): SquareClient {
  return createSquareClient({ accessToken: `EAAA${randomUUID()}`, env: "sandbox", locationId: LOCATION, fetch });
}

/** Every record the world holds is on exactly one page. */
function assertLaidOut(pages: SquareRecord[][], all: SquareRecord[], what: string): void {
  const ids = (records: SquareRecord[]) => records.map(({ id }) => id).sort();
  assert.deepEqual(ids(pages.flat()), ids(all), `fixture: the ${what} pages`);
}

test("pages are followed", async () => {
  await withWorld(async (world) => {
    const confirmed: { booking: BookingRow; payment: SquareRecord }[] = [];
    const dates: [string, string][] = [
      ["2030-05-02 10:00", "2030-06-03 09:00"],
      ["2030-05-09 13:30", "2030-06-16 09:00"],
      ["2030-05-14 08:45", "2030-06-22 09:00"],
      ["2030-05-23 19:20", "2030-07-02 09:00"],
      ["2030-05-30 07:55", "2030-07-09 09:00"],
    ];
    for (const [when, pickup] of dates) confirmed.push(await paidBooking(world, { confirmed: when, pickup }));
    const declined = squarePayment(world, {
      at: "2030-05-14 08:41",
      amount: confirmed[2].booking.paid_jpy,
      referenceId: confirmed[2].booking.id,
      status: "FAILED",
    });
    const orphan = squarePayment(world, { at: "2030-05-27 11:10", amount: yen() });

    // 35, 32 and 37 days: 100% each.
    const settled = await paidBooking(world, { confirmed: "2030-05-03 09:00", pickup: "2030-06-24 09:00", cancelled: "2030-05-20 09:00" });
    const settledRefund = await refundOf(world, settled.booking, { at: "2030-05-20 09:00", origin: "cancel", amount: settled.booking.paid_jpy, status: "COMPLETED" });
    const waiting = await paidBooking(world, { confirmed: "2030-05-06 09:00", pickup: "2030-06-26 09:00", cancelled: "2030-05-25 09:00" });
    const waitingRefund = await refundOf(world, waiting.booking, {
      at: "2030-05-25 09:00",
      origin: "cancel",
      amount: waiting.booking.paid_jpy,
      status: "COMPLETED",
      d1: { status: "PENDING" },
    });
    const unrecorded = await paidBooking(world, { confirmed: "2030-05-10 09:00", pickup: "2030-07-04 09:00", cancelled: "2030-05-28 09:00" });
    const unrecordedRefund = await refundOf(world, unrecorded.booking, {
      at: "2030-05-28 10:00",
      origin: "dashboard",
      amount: unrecorded.booking.paid_jpy,
      status: "COMPLETED",
      d1: null,
    });

    // An empty page with a cursor is not the end, and what the last pages hold is what a first page alone would miss.
    const paymentPages = [
      [confirmed[0].payment, confirmed[1].payment, declined],
      [],
      [settled.payment, confirmed[2].payment, waiting.payment],
      [confirmed[3].payment, unrecorded.payment],
      [confirmed[4].payment, orphan],
    ];
    const refundPages = [[settledRefund.square], [waitingRefund.square], [], [unrecordedRefund.square]];
    assertLaidOut(paymentPages, world.payments, "payment");
    assertLaidOut(refundPages, world.refunds, "refund");
    const api = squareApi({
      payments: paymentPages.map((page) => page.map((record) => wire(record, LOCATION))),
      refunds: refundPages.map((page) => page.map((record) => wire(record, LOCATION))),
    });
    const before = await snapshot(world.db);

    const result = await reconcile(world, realClient(api.fetch));

    const paymentId = (booking: BookingRow) => oneOf(undefined, must(booking.payment_id, "payment id"));
    assertIssues(
      result.issues,
      [
        { type: "payment_without_booking", bookingRef: undefined, paymentId: orphan.id, refundId: undefined, expectedJpy: ABSENT, actualJpy: orphan.amount },
        {
          type: "refund_status_mismatch",
          bookingRef: waiting.booking.ref,
          paymentId: paymentId(waiting.booking),
          refundId: waitingRefund.square.id,
          expectedJpy: waiting.booking.paid_jpy,
          actualJpy: waiting.booking.paid_jpy,
        },
        {
          type: "refund_not_recorded",
          bookingRef: unrecorded.booking.ref,
          paymentId: paymentId(unrecorded.booking),
          refundId: unrecordedRefund.square.id,
          expectedJpy: ABSENT,
          actualJpy: unrecorded.booking.paid_jpy,
        },
      ],
      "across pages",
    );
    const fixes: Fix[] = [
      { kind: "status", row: must(waitingRefund.row, "refund row"), status: "COMPLETED" },
      { kind: "insert", booking: unrecorded.booking, square: unrecordedRefund.square },
    ];
    assert.equal(result.fixed, fixes.length, "fixed");
    assertOnlyFixes(before, await snapshot(world.db), fixes, "across pages");

    assert.deepEqual([...api.served.payments].sort(), paymentPages.map((_, index) => index), "payment pages read");
    assert.deepEqual([...api.served.refunds].sort(), refundPages.map((_, index) => index), "refund pages read");
    for (const url of api.requests.filter(({ pathname }) => pathname === "/v2/payments" || pathname === "/v2/refunds")) {
      assert.equal(url.searchParams.get("begin_time"), iso(NOW - 35 * DAY_MS), `${url}: the window's start`);
      assert.equal(url.searchParams.get("end_time"), iso(NOW), `${url}: the window's end`);
    }
  });
});

test("payments from other locations are ignored", async () => {
  await withWorld(async (world) => {
    const first = await paidBooking(world, { confirmed: "2030-05-05 12:00", pickup: "2030-06-13 09:00" });
    const second = await paidBooking(world, { confirmed: "2030-05-26 16:30", pickup: "2030-06-19 09:00" });
    const orphan = squarePayment(world, { at: "2030-05-18 10:30", amount: yen() });
    const expired = await unpaidBooking(world, "EXPIRED", "2030-05-22 09:00");
    // 34 days, 100%, all of it back and on record.
    const refunded = await paidBooking(world, { confirmed: "2030-05-01 09:00", pickup: "2030-06-21 09:00", cancelled: "2030-05-18 09:00" });
    const refundedRefund = await refundOf(world, refunded.booking, { at: "2030-05-18 09:00", origin: "cancel", amount: refunded.booking.paid_jpy, status: "COMPLETED" });

    // Each of these would be an issue, or a refund recorded on one of our bookings, if it were ours.
    const foreign = (record: SquareRecord) => wire(record, OTHER_LOCATION);
    const noBooking: SquareRecord = { id: newPaymentId(), status: "COMPLETED", amount: yen(), currency: "JPY", created_at: iso(jst("2030-05-21 12:00")) };
    const onExpired: SquareRecord = {
      id: newPaymentId(),
      status: "COMPLETED",
      amount: must(expired.deposit_jpy, "deposit"),
      currency: "JPY",
      reference_id: expired.id,
      created_at: iso(jst("2030-05-22 09:05")),
    };
    const refundOn = (booking: BookingRow, at: string): SquareRecord => {
      const paymentId = must(booking.payment_id, "payment id");
      return { id: `${paymentId}_${randomUUID().slice(0, 8)}`, status: "COMPLETED", amount: yen(500, 2500), currency: "JPY", payment_id: paymentId, created_at: iso(jst(at)) };
    };

    const ours = (record: SquareRecord) => wire(record, LOCATION);
    const api = squareApi({
      payments: [
        [ours(first.payment), foreign(noBooking)],
        [foreign(onExpired), ours(second.payment), ours(refunded.payment)],
        [ours(orphan)],
      ],
      refunds: [[foreign(refundOn(refunded.booking, "2030-05-24 10:00"))], [ours(refundedRefund.square), foreign(refundOn(first.booking, "2030-05-29 15:00"))]],
    });
    const before = await snapshot(world.db);

    const result = await reconcile(world, realClient(api.fetch));

    assertIssues(
      result.issues,
      [{ type: "payment_without_booking", bookingRef: undefined, paymentId: orphan.id, refundId: undefined, expectedJpy: ABSENT, actualJpy: orphan.amount }],
      "two locations",
    );
    assert.equal(result.fixed, 0, "fixed");
    assertOnlyFixes(before, await snapshot(world.db), [], "two locations");
  });
});

test("the window is the last 35 days unless opts.days sets it", async () => {
  await withWorld(async (world) => {
    await seedClean(world);
    // Confirmed 52 days back, and its payment never reached Square.
    const old = await paidBooking(world, { confirmed: "2030-04-10 09:00", pickup: "2030-07-05 09:00", inSquare: false });
    // A payment of no booking, 6 days back.
    const recent = squarePayment(world, { at: "2030-05-25 13:00", amount: yen() });

    const recentIssue: ExpectedIssue = {
      type: "payment_without_booking",
      bookingRef: undefined,
      paymentId: recent.id,
      refundId: undefined,
      expectedJpy: ABSENT,
      actualJpy: recent.amount,
    };
    const oldIssue: ExpectedIssue = {
      type: "booking_without_payment",
      bookingRef: old.booking.ref,
      paymentId: must(old.booking.payment_id, "payment id"),
      refundId: undefined,
      expectedJpy: old.booking.paid_jpy,
      actualJpy: ABSENT,
    };
    // [what, opts, the days the window spans, the issues inside it]
    const runs: [string, { days?: number } | undefined, number, ExpectedIssue[]][] = [
      ["no opts", undefined, 35, [recentIssue]],
      ["empty opts", {}, 35, [recentIssue]],
      ["35 days", { days: 35 }, 35, [recentIssue]],
      ["60 days", { days: 60 }, 60, [recentIssue, oldIssue]],
      ["5 days", { days: 5 }, 5, []],
    ];

    for (const [what, opts, days, issues] of runs) {
      const fake = fakeSquare(world);
      const before = await snapshot(world.db);

      const result = await reconcile(world, fake.square, opts);

      const window = { beginTime: NOW - days * DAY_MS, endTime: NOW };
      for (const list of ["payments", "refunds"] as const) {
        assert.ok(fake.windows[list].length > 0, `${what}: ${list} listed`);
        for (const asked of fake.windows[list]) assert.deepEqual(asked, window, `${what}: the ${list} window`);
      }
      assertIssues(result.issues, issues, what);
      assert.equal(result.fixed, 0, `${what}: fixed`);
      assertOnlyFixes(before, await snapshot(world.db), [], what);
    }
  });
});

test("a failed Square listing is not read as no payments", async () => {
  const detail = () => `no answer within 15000 ms ${randomUUID()}`;
  const failures: [string, "payments" | "refunds", SquareFailure][] = [
    ["payments unknown", "payments", { kind: "unknown", detail: detail() }],
    ["payments refused", "payments", { kind: "error", code: "UNAUTHORIZED", detail: detail() }],
    ["refunds unknown", "refunds", { kind: "unknown", detail: detail() }],
    ["refunds refused", "refunds", { kind: "error", code: "RATE_LIMITED", detail: detail() }],
  ];

  await withWorld(async (world) => {
    await seedClean(world);
    // Fixes the run would make if it had both lists.
    const pending = DISCREPANCIES.filter(({ type }) => type === "refund_status_mismatch" || type === "refund_not_recorded");
    let pendingFixes = 0;
    for (const { seed } of pending) pendingFixes += (await seed(world)).fixes.length;
    const { reconcileSquare } = await reconcileModule();

    for (const [what, list, failure] of failures) {
      const fake = fakeSquare(world, list === "payments" ? { payments: failure } : { refunds: failure });
      const before = await snapshot(world.db);

      await assert.rejects(reconcileSquare({ db: world.db, square: fake.square, now: NOW }), (error: unknown) => {
        assert.ok(error instanceof Error, `${what}: rejected with ${String(error)}`);
        assert.ok(error.message.includes(failure.detail), `${what}: the error does not say what Square said: ${error.message}`);
        return true;
      });

      assertOnlyFixes(before, await snapshot(world.db), [], what);
      assert.deepEqual(fake.moneyCalls, [], `${what}: money moved`);
    }

    // With both lists the same state has its fixes, so the failures above held them back.
    const result = await reconcileSquare({ db: world.db, square: fakeSquare(world).square, now: NOW });
    assert.equal(result.fixed, pendingFixes, "fixed once Square answers");
  });
});

// Staff cancellations (#146). Each case is a cancelled booking and what the reconciliation has to make of it, among the
// ordinary month of seedClean, except the tier cases, which change the shop's tiers and so run alone. Most staff cases settle on a refund the tier would not give, so a check against the tier
// flags them; the guest cases beside them are checked against the tier as before.

/** 30 days or more 100%, 9 to 29 days 70%, 3 to 8 days 20%, less 0%: the shop's tiers after it republishes the sheet. */
const NEW_TIERS: TierRow[] = [
  { min_days_before: 30, refund_percent: 100 },
  { min_days_before: 9, refund_percent: 70 },
  { min_days_before: 3, refund_percent: 20 },
];

/** What the detail of a booking's retained_mismatch has to say. */
type Said = { by: "staff"; refundDueJpy: number; keptJpy: number } | { by: "guest" };

/** A booking and the issues it has, exactly; `said` when one of them is a retained_mismatch whose detail is checked. */
type Checked = { booking: BookingRow; issues: ExpectedIssue[]; said?: Said };

type CancelledCase = { what: string; seed: (world: World) => Promise<Checked & { fixes: Fix[] }> };

/** A case run twice: once as seeded, and again after `settle` and the shop's new tiers, when it has `after`. */
type SettlingCase = {
  what: string;
  seed: (world: World) => Promise<Checked & { fixes: Fix[]; settle?: () => Promise<void>; after: Omit<Checked, "booking"> }>;
};

function retained(booking: BookingRow, expectedJpy: number, actualJpy: number): ExpectedIssue {
  return {
    type: "retained_mismatch",
    bookingRef: booking.ref,
    paymentId: must(booking.payment_id, "payment id"),
    refundId: ANY,
    expectedJpy,
    actualJpy,
  };
}

/** D1 had the cancellation's refund as PENDING and Square has it as `status`: reported, and D1 takes Square's. */
function statusMoved(booking: BookingRow, refund: { square: SquareRecord; row: RefundRow | null }, status: string): { issue: ExpectedIssue; fix: Fix } {
  return {
    issue: {
      type: "refund_status_mismatch",
      bookingRef: booking.ref,
      paymentId: oneOf(undefined, must(booking.payment_id, "payment id")),
      refundId: refund.square.id,
      expectedJpy: refund.square.amount,
      actualJpy: refund.square.amount,
    },
    fix: { kind: "status", row: must(refund.row, "refund row"), status },
  };
}

/** `amount` written in `text` as whole yen, with or without thousands commas, and not as part of a longer number. */
function mentionsYen(text: string, amount: number): boolean {
  const forms = [...new Set([String(amount), amount.toLocaleString("en-US")])];
  return new RegExp(`(?<![\\d,])(?:${forms.join("|")})(?!\\d|,\\d)`).test(text);
}

function assertSaid(issue: Issue | undefined, said: Said, label: string): void {
  assert.ok(issue !== undefined, `${label}: no retained_mismatch whose detail could be read`);
  const detail = String(issue.detail);
  if (said.by === "guest") {
    assert.doesNotMatch(detail, /staff/i, `${label}: a guest's cancellation told as staff's: ${detail}`);
    return;
  }
  assert.match(detail, /staff/i, `${label}: the detail does not say staff cancelled: ${detail}`);
  if (said.refundDueJpy > 0) {
    assert.ok(mentionsYen(detail, said.refundDueJpy), `${label}: the detail does not name the refund chosen, ${said.refundDueJpy}: ${detail}`);
  }
  assert.ok(mentionsYen(detail, said.keptJpy), `${label}: the detail does not say the shop keeps ${said.keptJpy}: ${detail}`);
}

/** Each case's booking has exactly its issues, and no other booking has any. Every failure is listed at once. */
function assertCases(issues: unknown, cases: (Checked & { what: string })[], label: string): void {
  assert.ok(Array.isArray(issues), `${label}: issues is not an array`);
  const all = issues as Issue[];
  const refs = new Set(cases.map(({ booking }) => booking.ref));
  const failures: string[] = [];
  const check = (run: () => void) => {
    try {
      run();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  };
  for (const { what, booking, issues: expected, said } of cases) {
    const own = all.filter((issue) => issue.bookingRef === booking.ref);
    check(() => assertIssues(own, expected, `${label}, ${what}`));
    if (said !== undefined) {
      check(() => assertSaid(own.find((issue) => issue.type === "retained_mismatch"), said, `${label}, ${what}`));
    }
  }
  const rest = all.filter((issue) => typeof issue.bookingRef !== "string" || !refs.has(issue.bookingRef));
  check(() => assertIssues(rest, [], `${label}, the rest of the month`));
  if (failures.length > 0) assert.fail(failures.join("\n\n"));
}

/** One run over an ordinary month with these cases in it: their issues, only their fixes, and no money moved. */
async function reconcileCases(cases: CancelledCase[], label: string): Promise<void> {
  await withWorld(async (world) => {
    await seedClean(world);
    const seeded: (Checked & { what: string; fixes: Fix[] })[] = [];
    for (const { what, seed } of cases) seeded.push({ what, ...(await seed(world)) });
    const fixes = seeded.flatMap((outcome) => outcome.fixes);
    const fake = fakeSquare(world);
    const before = await snapshot(world.db);

    const result = await reconcile(world, fake.square);

    assertCases(result.issues, seeded, label);
    assert.equal(result.fixed, fixes.length, `${label}: fixed`);
    assertOnlyFixes(before, await snapshot(world.db), fixes, label);
    assert.deepEqual(fake.moneyCalls, [], `${label}: money moved`);
  });
}

const STAFF_FULL_REFUNDS: CancelledCase[] = [
  {
    what: "a full refund 9 days before pickup, where the tier gives half",
    seed: async (world) => {
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-06 09:00", pickup: "2030-05-31 09:00", cancelled: "2030-05-22 11:00", paid, staffRefundDue: paid });
      await refundOf(world, booking, { at: "2030-05-22 11:00", origin: "cancel", amount: paid, status: "COMPLETED" });
      return { booking, issues: [], fixes: [] };
    },
  },
  {
    what: "a full refund 3 days before pickup, the rest of what a Dashboard refund left",
    seed: async (world) => {
      // 3 days, 30%. Staff refunded part in the Dashboard first, and the cancellation sent the rest of what was paid.
      const paid = yen(8000, 40_000);
      const byStaff = randomInt(500, paid - 500);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-08 09:00", pickup: "2030-05-30 09:00", cancelled: "2030-05-27 16:00", paid, staffRefundDue: paid });
      await refundOf(world, booking, { at: "2030-05-20 10:00", origin: "dashboard", amount: byStaff, status: "COMPLETED" });
      await refundOf(world, booking, { at: "2030-05-27 16:00", origin: "cancel", amount: paid - byStaff, status: "COMPLETED" });
      return { booking, issues: [], fixes: [] };
    },
  },
  {
    what: "a no-show's full refund, cancelled the day after pickup",
    seed: async (world) => {
      // -1 day: past pickup, below every tier, so the tier gives nothing back.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-02 09:00", pickup: "2030-05-24 09:00", cancelled: "2030-05-25 10:00", paid, staffRefundDue: paid });
      await refundOf(world, booking, { at: "2030-05-25 10:00", origin: "cancel", amount: paid, status: "COMPLETED" });
      return { booking, issues: [], fixes: [] };
    },
  },
  {
    what: "a full refund 1 day before pickup that D1 still has as pending and Square completed",
    seed: async (world) => {
      // 1 day, 0%. The status is put right, and the refund counts as gone back either way.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-15 09:00", pickup: "2030-05-31 09:00", cancelled: "2030-05-30 18:00", paid, staffRefundDue: paid });
      const refund = await refundOf(world, booking, { at: "2030-05-30 18:00", origin: "cancel", amount: paid, status: "COMPLETED", d1: { status: "PENDING" } });
      const { issue, fix } = statusMoved(booking, refund, "COMPLETED");
      return { booking, issues: [issue], fixes: [fix] };
    },
  },
  {
    what: "a full refund 20 days before pickup, where the tier gives all of it too",
    seed: async (world) => {
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-01 09:00", pickup: "2030-06-01 09:00", cancelled: "2030-05-12 09:00", paid, staffRefundDue: paid });
      await refundOf(world, booking, { at: "2030-05-12 09:00", origin: "cancel", amount: paid, status: "COMPLETED" });
      return { booking, issues: [], fixes: [] };
    },
  },
  {
    what: "a guest given all of it back 9 days before pickup, more than the tier",
    seed: async (world) => {
      // 9 days, 50%. The cancellation sent the tier and staff the rest in the Dashboard, with no staff cancellation.
      const paid = yen(6000, 40_000);
      const tier = tierRefund(paid, 50);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-04 09:00", pickup: "2030-05-28 09:00", cancelled: "2030-05-19 13:00", paid });
      await refundOf(world, booking, { at: "2030-05-19 13:00", origin: "cancel", amount: tier, status: "COMPLETED" });
      await refundOf(world, booking, { at: "2030-05-20 10:00", origin: "dashboard", amount: paid - tier, status: "COMPLETED" });
      return { booking, issues: [retained(booking, paid - tier, 0)], fixes: [], said: { by: "guest" } };
    },
  },
];

const STAFF_NO_REFUNDS: CancelledCase[] = [
  {
    what: "nothing back 20 days before pickup, where the tier gives all of it",
    seed: async (world) => {
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-03 09:00", pickup: "2030-05-31 09:00", cancelled: "2030-05-11 10:00", paid, staffRefundDue: 0 });
      return { booking, issues: [], fixes: [] };
    },
  },
  {
    what: "nothing more 10 days before pickup, after a Dashboard refund short of the tier",
    seed: async (world) => {
      // 10 days, 50%. The cancellation settled on what had already gone back.
      const paid = yen(8000, 40_000);
      const byStaff = randomInt(500, tierRefund(paid, 50) - 500);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-05 09:00", pickup: "2030-06-02 09:00", cancelled: "2030-05-23 10:00", paid, staffRefundDue: byStaff });
      await refundOf(world, booking, { at: "2030-05-15 10:00", origin: "dashboard", amount: byStaff, status: "COMPLETED" });
      return { booking, issues: [], fixes: [] };
    },
  },
  {
    what: "nothing back 4 days before pickup, after a Dashboard refund Square failed",
    seed: async (world) => {
      // 4 days, 30%. The failed refund moved no money, so the cancellation settled on nothing.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-10 09:00", pickup: "2030-05-30 09:00", cancelled: "2030-05-26 10:00", paid, staffRefundDue: 0 });
      await refundOf(world, booking, { at: "2030-05-25 10:00", origin: "dashboard", amount: randomInt(500, paid), status: "FAILED" });
      return { booking, issues: [], fixes: [] };
    },
  },
  {
    what: "nothing back for a no-show, cancelled on the pickup day",
    seed: async (world) => {
      // 0 days, 0%.
      const { booking } = await paidBooking(world, { confirmed: "2030-05-09 09:00", pickup: "2030-05-23 09:00", cancelled: "2030-05-23 18:00", staffRefundDue: 0 });
      return { booking, issues: [], fixes: [] };
    },
  },
  {
    what: "nothing chosen 15 days before pickup, and a Dashboard refund that went out after all",
    seed: async (world) => {
      // 15 days, 100%. Staff settled on keeping it all, so the shop keeps less than they chose.
      const paid = yen(6000, 40_000);
      const after = randomInt(500, paid - 500);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-07 09:00", pickup: "2030-06-08 09:00", cancelled: "2030-05-24 10:00", paid, staffRefundDue: 0 });
      await refundOf(world, booking, { at: "2030-05-26 12:00", origin: "dashboard", amount: after, status: "COMPLETED" });
      return {
        booking,
        issues: [retained(booking, paid, paid - after)],
        fixes: [],
        said: { by: "staff", refundDueJpy: 0, keptJpy: paid - after },
      };
    },
  },
  {
    what: "a guest given nothing back 23 days before pickup, whose refund failed",
    seed: async (world) => {
      // 23 days, 100%.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-02 09:00", pickup: "2030-06-05 09:00", cancelled: "2030-05-13 10:00", paid });
      await unsentRefund(world, booking, { at: "2030-05-13 10:00", origin: "cancel", amount: paid, status: "FAILED" });
      return { booking, issues: [retained(booking, 0, paid)], fixes: [], said: { by: "guest" } };
    },
  },
];

const STAFF_REFUNDS_NOT_MADE: CancelledCase[] = [
  {
    what: "a full refund 9 days before pickup that Square rejected at the call",
    seed: async (world) => {
      // 9 days, 50%. The refused call left the row REJECTED with no Square id, so nothing went back.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-05 09:00", pickup: "2030-06-01 09:00", cancelled: "2030-05-23 09:00", paid, staffRefundDue: paid });
      await unsentRefund(world, booking, { at: "2030-05-23 09:00", origin: "cancel", amount: paid, status: "REJECTED" });
      return { booking, issues: [retained(booking, 0, paid)], fixes: [], said: { by: "staff", refundDueJpy: paid, keptJpy: paid } };
    },
  },
  {
    what: "a full refund 3 days before pickup that D1 has as pending and Square rejected",
    seed: async (world) => {
      // 3 days, 30%. Once D1 has the rejection, nothing has gone back.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-11 09:00", pickup: "2030-05-31 09:00", cancelled: "2030-05-28 12:00", paid, staffRefundDue: paid });
      const refund = await refundOf(world, booking, { at: "2030-05-28 12:00", origin: "cancel", amount: paid, status: "REJECTED", d1: { status: "PENDING" } });
      const { issue, fix } = statusMoved(booking, refund, "REJECTED");
      return {
        booking,
        issues: [issue, retained(booking, 0, paid)],
        fixes: [fix],
        said: { by: "staff", refundDueJpy: paid, keptJpy: paid },
      };
    },
  },
  {
    what: "a no-show's full refund stuck in RETRY, never made",
    seed: async (world) => {
      // -1 day, below every tier: the tier gives nothing back, so the shop keeping all of it would pass a tier check.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-01 09:00", pickup: "2030-05-26 09:00", cancelled: "2030-05-27 11:00", paid, staffRefundDue: paid });
      await unsentRefund(world, booking, { at: "2030-05-27 11:00", origin: "cancel", amount: paid, status: "RETRY" });
      return { booking, issues: [retained(booking, 0, paid)], fixes: [], said: { by: "staff", refundDueJpy: paid, keptJpy: paid } };
    },
  },
  {
    what: "a full refund 12 days before pickup that failed, after a Dashboard refund that went through",
    seed: async (world) => {
      // 12 days, 50%. Only the Dashboard part went back.
      const paid = yen(8000, 40_000);
      const byStaff = randomInt(500, paid - 500);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-04 09:00", pickup: "2030-06-05 09:00", cancelled: "2030-05-24 10:00", paid, staffRefundDue: paid });
      await refundOf(world, booking, { at: "2030-05-18 10:00", origin: "dashboard", amount: byStaff, status: "COMPLETED" });
      await unsentRefund(world, booking, { at: "2030-05-24 10:00", origin: "cancel", amount: paid - byStaff, status: "FAILED" });
      return {
        booking,
        issues: [retained(booking, 0, paid - byStaff)],
        fixes: [],
        said: { by: "staff", refundDueJpy: paid, keptJpy: paid - byStaff },
      };
    },
  },
  {
    what: "a full refund 20 days before pickup that Square rejected, where the tier gives all of it too",
    seed: async (world) => {
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-02 09:00", pickup: "2030-06-04 09:00", cancelled: "2030-05-15 09:00", paid, staffRefundDue: paid });
      await refundOf(world, booking, { at: "2030-05-15 09:00", origin: "cancel", amount: paid, status: "REJECTED" });
      return { booking, issues: [retained(booking, 0, paid)], fixes: [], said: { by: "staff", refundDueJpy: paid, keptJpy: paid } };
    },
  },
  {
    what: "a guest's tier refund 9 days before pickup that Square rejected, checked against the tier",
    seed: async (world) => {
      // 9 days, 50%.
      const paid = yen(6000, 40_000);
      const tier = tierRefund(paid, 50);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-06 09:00", pickup: "2030-05-31 09:00", cancelled: "2030-05-22 09:00", paid });
      await unsentRefund(world, booking, { at: "2030-05-22 09:00", origin: "cancel", amount: tier, status: "REJECTED" });
      return { booking, issues: [retained(booking, paid - tier, paid)], fixes: [], said: { by: "guest" } };
    },
  },
];

/**
 * Staff cancellations on the tier as it stood when they cancelled, and a guest's beside them. Day counts are JST calendar
 * days to pickup, with the percent under TIERS and then under NEW_TIERS.
 */
const STAFF_TIER_REFUNDS: SettlingCase[] = [
  {
    what: "the tier 10 days before pickup, completed",
    seed: async (world) => {
      // 10 days: 50%, then 70%.
      const paid = yen(6000, 40_000);
      const tier = tierRefund(paid, 50);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-03 09:00", pickup: "2030-05-31 09:00", cancelled: "2030-05-21 10:00", paid, staffRefundDue: tier });
      await refundOf(world, booking, { at: "2030-05-21 10:00", origin: "cancel", amount: tier, status: "COMPLETED" });
      return { booking, issues: [], fixes: [], after: { issues: [] } };
    },
  },
  {
    what: "the tier 20 days before pickup, all of it, pending in D1 and completed in Square",
    seed: async (world) => {
      // 20 days: 100%, then 70%.
      const paid = yen(6000, 40_000);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-01 09:00", pickup: "2030-06-01 09:00", cancelled: "2030-05-12 10:00", paid, staffRefundDue: paid });
      const refund = await refundOf(world, booking, { at: "2030-05-12 10:00", origin: "cancel", amount: paid, status: "COMPLETED", d1: { status: "PENDING" } });
      const { issue, fix } = statusMoved(booking, refund, "COMPLETED");
      return { booking, issues: [issue], fixes: [fix], after: { issues: [] } };
    },
  },
  {
    what: "the tier 4 days before pickup, nothing more after a Dashboard refund that passed it",
    seed: async (world) => {
      // 4 days: 30%, then 20%. The Dashboard refund was more than the tier, so the cancellation settled on it.
      const paid = yen(8000, 40_000);
      const byStaff = randomInt(tierRefund(paid, 30) + 500, paid - 500);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-06 09:00", pickup: "2030-05-31 09:00", cancelled: "2030-05-27 10:00", paid, staffRefundDue: byStaff });
      await refundOf(world, booking, { at: "2030-05-20 10:00", origin: "dashboard", amount: byStaff, status: "COMPLETED" });
      return { booking, issues: [], fixes: [], after: { issues: [] } };
    },
  },
  {
    what: "the tier 8 days before pickup, the rest of it after a smaller Dashboard refund",
    seed: async (world) => {
      // 8 days: 50%, then 20%.
      const paid = yen(8000, 40_000);
      const tier = tierRefund(paid, 50);
      const byStaff = randomInt(500, tier - 500);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-07 09:00", pickup: "2030-05-31 09:00", cancelled: "2030-05-23 10:00", paid, staffRefundDue: tier });
      await refundOf(world, booking, { at: "2030-05-18 10:00", origin: "dashboard", amount: byStaff, status: "COMPLETED" });
      await refundOf(world, booking, { at: "2030-05-23 10:00", origin: "cancel", amount: tier - byStaff, status: "COMPLETED" });
      return { booking, issues: [], fixes: [], after: { issues: [] } };
    },
  },
  {
    what: "the tier 5 days before pickup, stuck in RETRY until the cron sends it",
    seed: async (world) => {
      // 5 days: 30%, then 20%. Nothing has gone back until the retry goes through.
      const paid = yen(6000, 40_000);
      const tier = tierRefund(paid, 30);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-09 09:00", pickup: "2030-06-03 09:00", cancelled: "2030-05-29 10:00", paid, staffRefundDue: tier });
      const row = await unsentRefund(world, booking, { at: "2030-05-29 10:00", origin: "cancel", amount: tier, status: "RETRY" });
      const settle = async () => {
        const paymentId = must(booking.payment_id, "payment id");
        const squareId = `${paymentId}_${randomUUID().slice(0, 8)}`;
        const at = jst("2030-05-31 10:00");
        world.refunds.push({ id: squareId, status: "COMPLETED", amount: tier, currency: "JPY", payment_id: paymentId, created_at: iso(at) });
        await world.db
          .prepare("UPDATE refunds SET square_refund_id = ?1, status = 'COMPLETED', updated_at = ?2 WHERE id = ?3")
          .bind(squareId, at, row.id)
          .run();
      };
      return {
        booking,
        issues: [retained(booking, paid - tier, paid)],
        fixes: [],
        said: { by: "staff", refundDueJpy: tier, keptJpy: paid },
        settle,
        after: { issues: [] },
      };
    },
  },
  {
    what: "a guest's tier refund 10 days before pickup, checked against the shop's tiers of the day",
    seed: async (world) => {
      // 10 days: 50%, then 70%.
      const paid = yen(6000, 40_000);
      const tier = tierRefund(paid, 50);
      const { booking } = await paidBooking(world, { confirmed: "2030-05-04 09:00", pickup: "2030-05-31 09:00", cancelled: "2030-05-21 11:00", paid });
      await refundOf(world, booking, { at: "2030-05-21 11:00", origin: "cancel", amount: tier, status: "COMPLETED" });
      return {
        booking,
        issues: [],
        fixes: [],
        after: { issues: [retained(booking, paid - tierRefund(paid, 70), paid - tier)], said: { by: "guest" } },
      };
    },
  },
];

test("a staff cancellation with a completed full refund is no issue", async () => {
  await reconcileCases(STAFF_FULL_REFUNDS, "staff full refunds");
});

test("a staff cancellation with no refund is no issue", async () => {
  await reconcileCases(STAFF_NO_REFUNDS, "staff cancellations with no refund");
});

test("a staff cancellation with the tier refund is no issue once it settles", async () => {
  await withWorld(async (world) => {
    const seeded: ({ what: string } & Awaited<ReturnType<SettlingCase["seed"]>>)[] = [];
    for (const { what, seed } of STAFF_TIER_REFUNDS) seeded.push({ what, ...(await seed(world)) });
    const fixes = seeded.flatMap((outcome) => outcome.fixes);
    const fake = fakeSquare(world);
    const before = await snapshot(world.db);

    const first = await reconcile(world, fake.square);

    assertCases(first.issues, seeded, "the tier, as staff cancelled");
    assert.equal(first.fixed, fixes.length, "fixed");
    assertOnlyFixes(before, await snapshot(world.db), fixes, "the tier, as staff cancelled");
    assert.deepEqual(fake.moneyCalls, [], "money moved");

    // The stuck refund goes through, and the shop then publishes new tiers, which every day count above falls under
    // differently. What staff settled on stands; a guest's cancellation is checked against the tiers of the day.
    for (const { settle } of seeded) await settle?.();
    await world.db.prepare("DELETE FROM cancellation_tiers").run();
    await seedTiers(world.db, NEW_TIERS);
    const later = fakeSquare(world);
    const settled = await snapshot(world.db);

    const again = await reconcile(world, later.square);

    assertCases(again.issues, seeded.map(({ what, booking, after }) => ({ what, booking, ...after })), "the tier, settled and under new tiers");
    assert.equal(again.fixed, 0, "fixed by the run after");
    assertOnlyFixes(settled, await snapshot(world.db), [], "the tier, settled and under new tiers");
    assert.deepEqual(later.moneyCalls, [], "money moved in the run after");
  });
});

test("a staff full refund that Square rejected is a retained_mismatch with both amounts", async () => {
  await reconcileCases(STAFF_REFUNDS_NOT_MADE, "staff full refunds not made");
});
