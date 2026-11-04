// Settles bookings left in PAYMENT_PENDING when the Worker never learned how their charge ended (a timeout, a 5xx), from
// Square's own list of payments. A booking is stuck once its charge went out more than five minutes ago, by updated_at. One
// listing covers every booking a run looks at, matched on reference_id, which the charge sets to the booking id (#34). A
// COMPLETED payment confirms through markConfirmed, as the charge and the webhook (#36) do; declines alone reopen the hold;
// no payment at all, more than half an hour after the charge, expires the booking and frees its bike. Anything else Square
// has under the reference was seen and not declined, so the booking waits. Task #42 runs this from the cron.
import type { SquareClient, SquareFailure, SquareRecord } from "../square/client.ts";
import { type DepositPayment, markConfirmed, matchesDeposit, NOTHING_TAKEN } from "./confirm.ts";

export type StuckPaymentDeps = {
  db: D1Database;
  square: SquareClient;
  now: number;
  siteUrl: string;
  cancelSecret: string;
  staffEmail: string;
};

type Counts = { confirmed: number; reopened: number; expired: number };

export type StuckPaymentResult = Counts & { errors: string[] };

const MINUTE_MS = 60_000;
/** A charge unanswered for longer than this is stuck. */
const STUCK_AFTER_MS = 5 * MINUTE_MS;
/** A stuck charge Square has no payment for after longer than this never reached Square. */
const UNSEEN_AFTER_MS = 30 * MINUTE_MS;
/** How far the listing reaches before the oldest booking was made, for a Square clock behind the Worker's. */
const WINDOW_MARGIN_MS = MINUTE_MS;
/** Bookings per run; the next run takes the rest. */
const RUN_LIMIT = 20;

type StuckRow = {
  id: string;
  deposit_jpy: number | null;
  payment_attempt: number;
  created_at: number;
  updated_at: number;
};

/** Only a web booking is ever charged, so only one can be stuck. Oldest charge first. */
const STUCK_SQL = `SELECT id, deposit_jpy, payment_attempt, created_at, updated_at FROM bookings
  WHERE status = 'PAYMENT_PENDING' AND source = 'web' AND updated_at < ?1
  ORDER BY updated_at, id LIMIT ?2`;

/**
 * ?1 the booking, ?2 its new status, ?3 now, ?4 and ?5 the attempt and updated_at the run read. Writes only a row still as
 * the run read it, so one the webhook confirmed or the guest charged again meanwhile stays as it moved.
 */
const SETTLE_SQL = `UPDATE bookings SET status = ?2, updated_at = ?3
  WHERE id = ?1 AND status = 'PAYMENT_PENDING' AND payment_attempt = ?4 AND updated_at = ?5`;

function asDeposit({ id, amount, currency, status }: SquareRecord): DepositPayment {
  return { id, amountJpy: amount, currency, status };
}

function reasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" ? reason : "no reason given";
}

function failureText(failure: SquareFailure): string {
  return failure.kind === "unknown" ? failure.detail : `${failure.code}: ${failure.detail}`;
}

/** Every payment Square has in the window, or why there is no list to go by. */
async function listed(square: SquareClient, beginTime: number, endTime: number): Promise<SquareRecord[] | string> {
  try {
    const answer = await square.listPayments({ beginTime, endTime });
    if (answer.kind === "ok") return answer.payments;
    return `Square listPayments failed (${answer.kind}): ${failureText(answer)}`;
  } catch (reason) {
    return `Square listPayments rejected: ${reasonText(reason)}`;
  }
}

/** One booking, by the payments under its reference. The count it lands in, or null when the run changed nothing. */
async function settle(
  deps: StuckPaymentDeps,
  row: StuckRow,
  payments: SquareRecord[],
): Promise<keyof Counts | null> {
  const { db, now } = deps;
  const completed = payments.filter(({ status }) => status === "COMPLETED").map(asDeposit);
  const [first] = completed;
  if (first !== undefined) {
    // A second COMPLETED payment is #43's to report. Taking the one of the deposit's amount leaves both with Square.
    const payment = completed.find((each) => matchesDeposit(each, row.deposit_jpy)) ?? first;
    // "already" and "lost" are confirmations the webhook made, or money markConfirmed sent back: not this run's.
    return (await markConfirmed(db, row.id, payment, now, deps)) === "confirmed" ? "confirmed" : null;
  }

  // Seen and not declined, as PENDING, APPROVED or a status this code does not know: Square may yet be paid.
  if (!payments.every(({ status }) => NOTHING_TAKEN.has(status))) return null;
  const declined = payments.length > 0;
  if (!declined && row.updated_at >= now - UNSEEN_AFTER_MS) return null;

  // A reopened hold keeps its expiry. Neither write queues anything: the booking never reached the guest or the sheet.
  const status = declined ? "ON_HOLD" : "EXPIRED";
  const { meta } = await db.prepare(SETTLE_SQL).bind(row.id, status, now, row.payment_attempt, row.updated_at).run();
  if (meta.changes === 0) return null;
  return declined ? "reopened" : "expired";
}

/**
 * Resolves up to `limit` stuck bookings (20 unless the caller says fewer) from one listPayments call over [a minute before
 * the oldest was made, now]. With nothing stuck, Square is not asked. A Square failure writes nothing and is reported in
 * `errors`; so is a booking whose write fails, and the run goes on to the next.
 */
export async function resolveStuckPayments(deps: StuckPaymentDeps, limit = RUN_LIMIT): Promise<StuckPaymentResult> {
  const { db, square, now } = deps;
  const result: StuckPaymentResult = { confirmed: 0, reopened: 0, expired: 0, errors: [] };
  const { results: stuck } = await db.prepare(STUCK_SQL).bind(now - STUCK_AFTER_MS, limit).all<StuckRow>();
  if (stuck.length === 0) return result;

  const oldest = Math.min(...stuck.map(({ created_at }) => created_at));
  const payments = await listed(square, oldest - WINDOW_MARGIN_MS, now);
  if (typeof payments === "string") {
    result.errors.push(payments);
    return result;
  }

  // An exact match only: a reference close to a booking id names no booking of ours.
  const byBooking = new Map<string, SquareRecord[]>(stuck.map(({ id }) => [id, []]));
  for (const payment of payments) {
    if (payment.reference_id !== undefined) byBooking.get(payment.reference_id)?.push(payment);
  }

  for (const row of stuck) {
    try {
      const outcome = await settle(deps, row, byBooking.get(row.id) ?? []);
      if (outcome !== null) result[outcome] += 1;
    } catch (reason) {
      result.errors.push(`Booking ${row.id} not resolved: ${reasonText(reason)}`);
    }
  }
  return result;
}
