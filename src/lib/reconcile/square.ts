// D1 against Square over a window of days, for the daily cron (#44): every COMPLETED payment and every refund Square
// lists there, every web booking confirmed there, and every web booking cancelled there. Two differences are put right here, a refund's status and a
// refund taken in the Dashboard that D1 never heard of; the rest is only reported. Both lists are read before any
// write, so a listing that fails leaves D1 as it was, and the fixes land in one batch. expectedJpy is what D1 holds
// and actualJpy what Square holds. Nothing here moves money.
import { refundForCancellation } from "../booking/cancel.ts";
import { readCancellationTiers } from "../db/config.ts";
import type { SquareClient, SquareFailure, SquareRecord, SquareTimeWindow } from "../square/client.ts";
import type { BookingStatus, CancellationTier } from "../types.ts";

export type ReconcileIssueType =
  | "payment_without_booking"
  | "booking_without_payment"
  | "amount_mismatch"
  | "status_mismatch"
  | "refund_not_recorded"
  | "refund_status_mismatch"
  | "refund_amount_mismatch"
  | "retained_mismatch"
  // The Bookings tab's, from src/lib/reconcile/sheet.ts.
  | "unknown_sheet_row"
  | "pending_override";

export type ReconcileIssue = {
  type: ReconcileIssueType;
  bookingRef?: string;
  paymentId?: string;
  refundId?: string;
  expectedJpy?: number;
  actualJpy?: number;
  detail: string;
};

export type ReconcileDeps = { db: D1Database; square: SquareClient; now: number };

export type ReconcileOptions = { days?: number };

export type ReconcileResult = { issues: ReconcileIssue[]; fixed: number };

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 35;

/** The refunds that count as gone back, as #35's quote counts them. */
const MONEY_STATUSES = new Set(["PENDING", "COMPLETED"]);

/** Refunds Square refused, which moved no money. */
const REFUSED_STATUSES = new Set(["REJECTED", "FAILED"]);

/** A booking a payment has settled. */
const SETTLED_STATUSES = new Set<string>(["CONFIRMED", "CANCELLED"]);

/*
 * Two scopes, ?1 and ?2 being the window. Blocks have no payment, and only a confirmed booking has a confirmed_at.
 * - The payment check, booking_without_payment: a web booking confirmed in the window. One confirmed before it paid
 *   before it too, so its payment is not in the listing.
 * - The retained check, retained_mismatch: a CANCELLED web booking confirmed or cancelled in the window. Bookings run
 *   months ahead, so a cancellation in the window is checked however long before it the booking was paid.
 */
const PAYMENT_SCOPE_SQL = "source = 'web' AND status IN ('CONFIRMED', 'CANCELLED') AND confirmed_at BETWEEN ?1 AND ?2";
const RETAINED_SCOPE_SQL =
  "source = 'web' AND status = 'CANCELLED' AND (confirmed_at BETWEEN ?1 AND ?2 OR cancelled_at BETWEEN ?1 AND ?2)";

/**
 * The bookings in either scope, and any booking that holds or is named by a listed payment, or holds a listed refund's
 * payment, whenever it was confirmed. ?3 the payment ids and ?4 the reference ids go as one JSON parameter each, so a
 * listing of any size stays within D1's 100 bound parameters.
 */
const BOOKINGS_SQL = `SELECT id, ref, status, start_at, deposit_jpy, payment_id, paid_jpy, cancelled_at, refund_due_jpy,
    (${PAYMENT_SCOPE_SQL}) AS payment_scope, (${RETAINED_SCOPE_SQL}) AS retained_scope
  FROM bookings
  WHERE (${PAYMENT_SCOPE_SQL}) OR (${RETAINED_SCOPE_SQL})
    OR payment_id IN (SELECT value FROM json_each(?3))
    OR id IN (SELECT value FROM json_each(?4))`;

/** The rows of the listed refunds, ?3, and every row of a booking in the retained scope. */
const REFUNDS_SQL = `SELECT r.id, r.booking_id, r.square_refund_id, r.amount_jpy, r.status, b.ref
  FROM refunds r JOIN bookings b ON b.id = r.booking_id
  WHERE r.square_refund_id IN (SELECT value FROM json_each(?3))
    OR r.booking_id IN (SELECT id FROM bookings WHERE ${RETAINED_SCOPE_SQL})`;

/** Only from the status this run read, so a webhook that moved the row since keeps what it wrote. */
const SET_STATUS_SQL = "UPDATE refunds SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4";

/** A webhook may have recorded the refund since this run read, and then its row stands. */
const RECORD_REFUND_SQL = `INSERT INTO refunds
    (id, booking_id, square_refund_id, amount_jpy, status, origin, idempotency_key, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, 'dashboard', NULL, ?6, ?7)
  ON CONFLICT (square_refund_id) DO NOTHING`;

type BookingRow = {
  id: string;
  ref: string;
  status: BookingStatus;
  start_at: number;
  deposit_jpy: number | null;
  payment_id: string | null;
  paid_jpy: number;
  cancelled_at: number | null;
  /** The total refund a staff cancellation settled on (#145); NULL on a guest's. */
  refund_due_jpy: number | null;
  /** 1 in the payment check's scope, else 0 or null. */
  payment_scope: number | null;
  /** 1 in the retained check's scope, else 0 or null. */
  retained_scope: number | null;
};

type RefundRow = {
  id: string;
  booking_id: string;
  square_refund_id: string | null;
  amount_jpy: number;
  status: string;
  /** The booking's. */
  ref: string;
};

/** A refund as the retained check counts it. */
type Counted = { status: string; amountJpy: number };

/** What the refund fixes change, so that the retained check counts D1 as it will be once they land. */
type Fixes = {
  statements: D1PreparedStatement[];
  /** A refund row's new status, by row id. */
  statusOf: Map<string, string>;
  /** The refunds this run records, by booking id. */
  recorded: Map<string, Counted[]>;
};

function listingFailed(what: "payments" | "refunds", failure: SquareFailure): Error {
  const said = failure.kind === "unknown" ? failure.detail : `${failure.code}: ${failure.detail}`;
  return new Error(`Square's ${what} listing failed (${failure.kind}), so nothing was reconciled: ${said}`);
}

function jsonIds(ids: (string | null | undefined)[]): string {
  return JSON.stringify([...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))]);
}

function yen(amount: number): string {
  return `${amount.toLocaleString("en-US")} JPY`;
}

function groupBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (value !== undefined) groups.set(value, [...(groups.get(value) ?? []), item]);
  }
  return groups;
}

function refundedJpy(refunds: Counted[]): number {
  return refunds.reduce((sum, { status, amountJpy }) => sum + (MONEY_STATUSES.has(status) ? amountJpy : 0), 0);
}

/** Square's created_at as epoch ms, or `fallback` when it has none that parses. */
function instantOf(record: SquareRecord, fallback: number): number {
  const at = Date.parse(record.created_at ?? "");
  return Number.isFinite(at) ? at : fallback;
}

/**
 * Each COMPLETED payment against the booking that holds it, or else the booking its reference_id names. A payment no
 * booking holds but one names is #34 sending it back, which is no issue once Square's refunds of it add up to all of
 * it.
 */
function paymentIssues(
  payments: SquareRecord[],
  refundsOf: Map<string, SquareRecord[]>,
  byPayment: Map<string, BookingRow>,
  byId: Map<string, BookingRow>,
): ReconcileIssue[] {
  const issues: ReconcileIssue[] = [];
  for (const payment of payments) {
    const { id: paymentId, amount } = payment;
    const holder = byPayment.get(paymentId);
    if (holder !== undefined) {
      if (holder.paid_jpy !== amount) {
        issues.push({
          type: "amount_mismatch",
          bookingRef: holder.ref,
          paymentId,
          expectedJpy: holder.paid_jpy,
          actualJpy: amount,
          detail: `Booking ${holder.ref} holds ${yen(holder.paid_jpy)} paid, and its payment took ${yen(amount)}.`,
        });
      }
      continue;
    }

    const named = payment.reference_id === undefined ? undefined : byId.get(payment.reference_id);
    if (named === undefined) {
      issues.push({
        type: "payment_without_booking",
        paymentId,
        actualJpy: amount,
        detail: `Square took ${yen(amount)} in a payment that is no booking's and names no booking.`,
      });
      continue;
    }

    const refunds = refundsOf.get(paymentId) ?? [];
    const sentBack = refundedJpy(refunds.map((refund) => ({ status: refund.status, amountJpy: refund.amount })));
    if (sentBack >= amount) continue;
    if (!SETTLED_STATUSES.has(named.status)) {
      issues.push({
        type: "status_mismatch",
        bookingRef: named.ref,
        paymentId,
        expectedJpy: named.deposit_jpy ?? undefined,
        actualJpy: amount,
        detail:
          `Square completed a payment of ${yen(amount)} for booking ${named.ref}, which is ${named.status}, ` +
          `and ${yen(sentBack)} of it went back.`,
      });
    } else {
      issues.push({
        type: "payment_without_booking",
        bookingRef: named.ref,
        paymentId,
        actualJpy: amount,
        detail:
          `A payment of ${yen(amount)} names booking ${named.ref}, which another payment settled, ` +
          `and ${yen(sentBack)} of it went back.`,
      });
    }
  }
  return issues;
}

/**
 * Each refund Square lists against D1's row of it. A refund D1 lacks is recorded as a Dashboard refund when it is of
 * the payment a booking holds and moved money; a refund of any other payment is never a booking's.
 */
function refundIssues(
  { db, now }: { db: D1Database; now: number },
  refunds: SquareRecord[],
  rowOf: Map<string, RefundRow>,
  byPayment: Map<string, BookingRow>,
  fixes: Fixes,
): ReconcileIssue[] {
  const issues: ReconcileIssue[] = [];
  for (const refund of refunds) {
    const { id: refundId, payment_id: paymentId, amount, status } = refund;
    const row = rowOf.get(refundId);
    if (row !== undefined) {
      if (row.status !== status) {
        // Square's four refund statuses are all D1 takes besides its own RETRY. Any other is reported and left alone.
        const fixable = MONEY_STATUSES.has(status) || REFUSED_STATUSES.has(status);
        if (fixable) {
          fixes.statements.push(db.prepare(SET_STATUS_SQL).bind(status, now, row.id, row.status));
          fixes.statusOf.set(row.id, status);
        }
        issues.push({
          type: "refund_status_mismatch",
          bookingRef: row.ref,
          paymentId,
          refundId,
          expectedJpy: row.amount_jpy,
          actualJpy: amount,
          detail: `The refund is ${row.status} in D1 and ${status} in Square${fixable ? "; D1 takes Square's" : ""}.`,
        });
      }
      if (row.amount_jpy !== amount) {
        issues.push({
          type: "refund_amount_mismatch",
          bookingRef: row.ref,
          paymentId,
          refundId,
          expectedJpy: row.amount_jpy,
          actualJpy: amount,
          detail: `The refund is ${yen(row.amount_jpy)} in D1 and ${yen(amount)} in Square.`,
        });
      }
      continue;
    }

    const holder = paymentId === undefined ? undefined : byPayment.get(paymentId);
    if (holder === undefined || REFUSED_STATUSES.has(status)) continue;
    const recordable = MONEY_STATUSES.has(status) && amount > 0;
    if (recordable) {
      fixes.statements.push(
        db
          .prepare(RECORD_REFUND_SQL)
          .bind(crypto.randomUUID(), holder.id, refundId, amount, status, instantOf(refund, now), now),
      );
      fixes.recorded.set(holder.id, [...(fixes.recorded.get(holder.id) ?? []), { status, amountJpy: amount }]);
    }
    issues.push({
      type: "refund_not_recorded",
      bookingRef: holder.ref,
      paymentId,
      refundId,
      actualJpy: amount,
      detail:
        `Square has a ${status} refund of ${yen(amount)} that D1 had no row for` +
        `${recordable ? "; recorded as a Dashboard refund" : ""}.`,
    });
  }
  return issues;
}

/**
 * Each booking in the payment scope against its payment and, in the retained scope, what the shop keeps: paid less the
 * refund staff settled on (refund_due_jpy), or for a guest's cancellation the tier's refund at cancelled_at, against
 * paid less what has gone back, counted after this run's fixes.
 */
function bookingIssues(
  bookings: BookingRow[],
  completed: Set<string>,
  tiers: CancellationTier[],
  rowsOf: Map<string, RefundRow[]>,
  fixes: Fixes,
): ReconcileIssue[] {
  const issues: ReconcileIssue[] = [];
  for (const booking of bookings) {
    const { ref: bookingRef, status, paid_jpy: paid } = booking;
    const paymentId = booking.payment_id ?? undefined;
    if (booking.payment_scope === 1 && (paymentId === undefined || !completed.has(paymentId))) {
      issues.push({
        type: "booking_without_payment",
        bookingRef,
        paymentId,
        expectedJpy: paid,
        detail: `The booking is ${status} on ${yen(paid)} paid, and Square lists no COMPLETED payment for it.`,
      });
    }
    if (booking.retained_scope !== 1) continue;

    const refunded = refundedJpy([
      ...(rowsOf.get(booking.id) ?? []).map((row) => ({
        status: fixes.statusOf.get(row.id) ?? row.status,
        amountJpy: row.amount_jpy,
      })),
      ...(fixes.recorded.get(booking.id) ?? []),
    ]);
    const actual = paid - refunded;
    const kept = `with ${yen(refunded)} refunded the shop keeps ${yen(actual)} of ${yen(paid)}`;
    const due = booking.refund_due_jpy;
    if (due !== null) {
      // Staff chose the refund, so the tiers then or now do not count.
      if (paid - due === actual) continue;
      issues.push({
        type: "retained_mismatch",
        bookingRef,
        paymentId,
        expectedJpy: paid - due,
        actualJpy: actual,
        detail: `Cancelled by staff with ${due > 0 ? `a refund of ${yen(due)}` : "no refund"}; ${kept}.`,
      });
      continue;
    }
    // A cancellation always writes cancelled_at; without one the tier cannot be told, and that is reported too.
    const tier =
      booking.cancelled_at === null ? null : refundForCancellation(tiers, paid, booking.start_at, booking.cancelled_at);
    const expected = tier === null ? undefined : paid - tier.refundJpy;
    if (expected === actual) continue;
    issues.push({
      type: "retained_mismatch",
      bookingRef,
      paymentId,
      expectedJpy: expected,
      actualJpy: actual,
      detail:
        tier === null
          ? `The booking is CANCELLED with no cancelled_at, so its tier cannot be told; ${kept}.`
          : `Cancelled ${tier.daysBefore} days before pickup, ${tier.refundPercent}% back; ${kept}.`,
    });
  }
  return issues;
}

/**
 * Lists Square's payments and refunds over the last `days` (35 by default) up to `now`, compares them with D1 and
 * returns what differs. Rejects with an Error carrying Square's detail, before any write, when either listing fails.
 */
export async function reconcileSquare(deps: ReconcileDeps, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const { db, square, now } = deps;
  const days = opts.days ?? DEFAULT_DAYS;
  if (!(Number.isFinite(days) && days > 0)) throw new RangeError(`days must be a positive number: ${days}`);
  const window: SquareTimeWindow = { beginTime: now - days * DAY_MS, endTime: now };

  const [paymentList, refundList] = await Promise.all([square.listPayments(window), square.listRefunds(window)]);
  if (paymentList.kind !== "ok") throw listingFailed("payments", paymentList);
  if (refundList.kind !== "ok") throw listingFailed("refunds", refundList);
  // A payment that is not COMPLETED, such as a declined card, moved no money.
  const payments = paymentList.payments.filter((payment) => payment.status === "COMPLETED");
  const { refunds } = refundList;

  // One batch is one snapshot, so a booking cancelled during the run never shows without its refund row.
  const paymentIds = jsonIds([...payments.map(({ id }) => id), ...refunds.map((refund) => refund.payment_id)]);
  const referenceIds = jsonIds(payments.map((payment) => payment.reference_id));
  const [bookingRead, refundRead] = (await db.batch([
    db.prepare(BOOKINGS_SQL).bind(window.beginTime, window.endTime, paymentIds, referenceIds),
    db.prepare(REFUNDS_SQL).bind(window.beginTime, window.endTime, jsonIds(refunds.map(({ id }) => id))),
  ])) as [D1Result<BookingRow>, D1Result<RefundRow>];
  const bookings = bookingRead.results;
  const rows = refundRead.results;

  const byId = new Map(bookings.map((booking) => [booking.id, booking]));
  const byPayment = new Map<string, BookingRow>();
  for (const booking of bookings) {
    if (booking.payment_id !== null && !byPayment.has(booking.payment_id)) byPayment.set(booking.payment_id, booking);
  }
  const rowOf = new Map<string, RefundRow>();
  for (const row of rows) if (row.square_refund_id !== null) rowOf.set(row.square_refund_id, row);

  const tiers = bookings.some((booking) => booking.retained_scope === 1) ? await readCancellationTiers(db) : [];
  const completed = new Set(payments.map(({ id }) => id));
  const fixes: Fixes = { statements: [], statusOf: new Map(), recorded: new Map() };
  const issues = paymentIssues(payments, groupBy(refunds, (refund) => refund.payment_id), byPayment, byId);
  issues.push(...refundIssues({ db, now }, refunds, rowOf, byPayment, fixes));
  // After refundIssues, which fills `fixes` for the retained check to count.
  issues.push(...bookingIssues(bookings, completed, tiers, groupBy(rows, (row) => row.booking_id), fixes));

  let fixed = 0;
  if (fixes.statements.length > 0) {
    for (const result of await db.batch(fixes.statements)) fixed += result.meta.changes ?? 0;
  }
  return { issues, fixed };
}
