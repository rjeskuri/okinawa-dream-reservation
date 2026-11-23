// What a guest gets back for cancelling, the signed link that lets them, and the cancellation itself, and the same for
// staff cancelling from the Dashboard with a refund they choose (#145). Tiers count JST calendar days, and online
// cancellation closes at pickup; staff can cancel after it. A cancellation lands whole in one batch and calls Square only
// afterwards, so a refund row left in RETRY is what a crash leaves behind, and retryRefunds picks it up from there.
import { email } from "../../i18n/strings/email.ts";
import { t } from "../../i18n/t.ts";
import { hmacSha256Base64, timingSafeEqual } from "../crypto.ts";
import { readCancellationTiers, readShopConfig } from "../db/config.ts";
import type { Locale } from "../locale.ts";
import { enqueueStatements, enqueueWhereStatements } from "../outbox.ts";
import type { OutboxItem } from "../outbox.ts";
import type { RefundResult, SquareClient } from "../square/client.ts";
import { daysBetweenDates, jstToday } from "../time.ts";
import type { Booking, BookingSource, BookingStatus, CancellationTier, ShopConfig } from "../types.ts";

export type CancellationRefund = { daysBefore: number; refundPercent: number; refundJpy: number };

export type CancellationReason = "NOT_FOUND" | "NOT_CANCELLABLE" | "ALREADY_CANCELLED" | "STARTED";

export type CancellationQuote =
  | ({ ok: true; booking: Booking } & CancellationRefund)
  | { ok: false; reason: CancellationReason };

export type CancelDeps = { db: D1Database; square: SquareClient; now: number; staffEmail: string; siteUrl: string };

export type RefundDeps = Omit<CancelDeps, "siteUrl">;

export type CancelRefundStatus = "NONE" | "PENDING" | "COMPLETED" | "RETRY" | "REJECTED";

export type CancelResult =
  | { ok: true; refundJpy: number; refundStatus: CancelRefundStatus }
  | { ok: false; reason: CancellationReason };

/** What staff give back when they cancel from the Dashboard: what the tiers give, all that is left, or nothing. */
export type StaffRefundChoice = "tier" | "full" | "none";

export type StaffCancellationQuote =
  | {
      ok: true;
      booking: Booking;
      daysBefore: number;
      refundPercent: number;
      refundedJpy: number;
      amounts: Record<StaffRefundChoice, number>;
    }
  | { ok: false; reason: CancellationReason };

/** `refundJpy` is the amount the panel showed for `choice`. `requestedBy` is for the caller's log and is not stored. */
export type StaffCancelRequest = { choice: StaffRefundChoice; refundJpy: number; requestedBy: string };

export type StaffCancelResult =
  | { ok: true; choice: StaffRefundChoice; refundJpy: number; refundStatus: CancelRefundStatus }
  | { ok: false; reason: CancellationReason | "QUOTE_CHANGED" | "BAD_CHOICE"; quote?: StaffCancellationQuote };

export type RetryResult = { retried: number; completed: number; stillPending: number };

/** A row of `bookings` as `SELECT *` gives it. */
type BookingRow = {
  id: string;
  ref: string;
  status: BookingStatus;
  source: BookingSource;
  model_id: string;
  package_id: string | null;
  vehicle_plate: string;
  start_at: number;
  end_at: number;
  expires_at: number | null;
  price_jpy: number | null;
  deposit_jpy: number | null;
  catalog_version: number | null;
  locale: Locale | null;
  guest_family_name: string | null;
  guest_given_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  external_ref: string | null;
  external_channel: string | null;
  content_hash: string | null;
  payment_id: string | null;
  payment_attempt: number;
  paid_jpy: number;
  cancel_reason: string | null;
  created_at: number;
  updated_at: number;
  confirmed_at: number | null;
  cancelled_at: number | null;
  refund_due_jpy: number | null;
};

/** A refund to send to Square, as the refunds row and its booking hold it. */
type RefundAttempt = { id: string; ref: string; idempotencyKey: string; paymentId: string; amountJpy: number };

type RefundRowStatus = "PENDING" | "COMPLETED" | "REJECTED" | "FAILED" | "RETRY";

/** What a refund's row becomes. `refusal` says why when staff have to step in. */
type Settlement = { status: RefundRowStatus; squareRefundId: string | null; refusal: string | null };

const TOKEN_LENGTH = 32;

const STAFF_REFUND_CHOICES: readonly StaffRefundChoice[] = ["tier", "full", "none"];

/**
 * Fixed, because Square compares the whole request under one key and a retry has to send the same one. Staff refunds
 * send it too: retryRefunds cannot tell a staff refund from a guest's, and must resend each exactly as first sent.
 */
const REFUND_REASON = "Guest cancellation";

const NO_ANSWER: Settlement = { status: "RETRY", squareRefundId: null, refusal: null };

/** Square saying "not now". The client calls a 429 an error, but nothing was refused and the key is still good. */
const NOT_NOW_CODES = new Set(["RATE_LIMITED", "HTTP_429"]);

const REFUNDED_SQL =
  "SELECT COALESCE(SUM(amount_jpy), 0) AS total FROM refunds " +
  "WHERE booking_id = ?1 AND status IN ('PENDING', 'COMPLETED')";

/**
 * The guard, and with it the decision: this statement picks the one winner, at any number of callers, because D1 runs one
 * statement at a time. It also holds everything the amount was worked out from, so a booking that moved between the quote
 * and here stays as it is and refunds nothing. The quote already held start_at against `now`, which is fixed for the call,
 * so a start_at that has not moved is a pickup that has not been reached. Staff may cancel past pickup, and for them the
 * held start_at keeps the tier the amount was quoted at.
 */
const CANCEL_GUARD_SQL = `WHERE id = ?1 AND status = 'CONFIRMED' AND source = 'web' AND start_at = ?3 AND paid_jpy = ?4
    AND (${REFUNDED_SQL}) = ?5`;

const CANCEL_SQL = `UPDATE bookings
  SET status = 'CANCELLED', cancelled_at = ?2, cancel_reason = 'guest', updated_at = ?2
  ${CANCEL_GUARD_SQL}`;

/** CANCEL_SQL for staff, recording ?6 the total refund they settled on. */
const STAFF_CANCEL_SQL = `UPDATE bookings
  SET status = 'CANCELLED', cancelled_at = ?2, cancel_reason = 'staff', refund_due_jpy = ?6, updated_at = ?2
  ${CANCEL_GUARD_SQL}`;

/**
 * Whether CANCEL_SQL in this same batch is the one that moved the booking, for everything after it to go by: a batch is
 * one transaction, so a loser's inserts reach this with the UPDATE already spent. The booking has to read as cancelled at
 * this call's `now`, which a guard that came to nothing never leaves, and the batch's last outbox item must not be there
 * yet, which tells two calls in one millisecond apart: a winner's batch lands whole, so a loser always finds that item.
 * Plain reads rather than changes(), so that nothing rests on what D1 leaves on its connection between statements. The
 * UNIQUE key on a refund is no part of this: a loser that reached it would fail the batch instead of being turned away.
 * Reads ?5 the booking, ?6 `now` and ?7 the last item's dedupe key.
 */
const WON_SQL = `EXISTS (SELECT 1 FROM bookings WHERE id = ?5 AND status = 'CANCELLED' AND cancelled_at = ?6)
  AND NOT EXISTS (SELECT 1 FROM outbox WHERE dedupe_key = ?7)`;

const INSERT_REFUND_SQL = `INSERT INTO refunds
    (id, booking_id, amount_jpy, status, origin, idempotency_key, created_at, updated_at)
  SELECT ?1, ?5, ?2, 'RETRY', 'cancel', ?3, ?4, ?4 WHERE ${WON_SQL}`;

// RETRY only, so a webhook that moved the row first keeps what it wrote.
const SETTLE_REFUND_SQL =
  "UPDATE refunds SET status = ?1, square_refund_id = ?2, updated_at = ?3 WHERE id = ?4 AND status = 'RETRY'";

// Longest untouched first, and a retry that stays RETRY touches its row, so a stuck refund cannot keep others out.
const WAITING_REFUNDS_SQL = `SELECT r.id, b.ref, r.idempotency_key AS idempotencyKey,
    COALESCE(b.payment_id, '') AS paymentId, r.amount_jpy AS amountJpy
  FROM refunds r JOIN bookings b ON b.id = r.booking_id
  WHERE r.status = 'RETRY' ORDER BY r.updated_at, r.id LIMIT ?1`;

const NAMES_SQL = `SELECT m.texts AS model_texts, p.texts AS package_texts
  FROM models m LEFT JOIN packages p ON p.id = ?2 WHERE m.id = ?1`;

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    ref: row.ref,
    status: row.status,
    source: row.source,
    modelId: row.model_id,
    packageId: row.package_id,
    vehiclePlate: row.vehicle_plate,
    startAt: row.start_at,
    endAt: row.end_at,
    expiresAt: row.expires_at,
    priceJpy: row.price_jpy,
    depositJpy: row.deposit_jpy,
    catalogVersion: row.catalog_version,
    locale: row.locale,
    guestFamilyName: row.guest_family_name,
    guestGivenName: row.guest_given_name,
    guestEmail: row.guest_email,
    guestPhone: row.guest_phone,
    externalRef: row.external_ref,
    externalChannel: row.external_channel,
    contentHash: row.content_hash,
    paymentId: row.payment_id,
    paymentAttempt: row.payment_attempt,
    paidJpy: row.paid_jpy,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
  };
}

/** base64url of HMAC-SHA256 over 'cancel:' + id. The cut drops the padding, which is past character 32. */
export async function cancelToken(secret: string, bookingId: string): Promise<string> {
  const digest = await hmacSha256Base64(secret, `cancel:${bookingId}`);
  return digest.replaceAll("+", "-").replaceAll("/", "_").slice(0, TOKEN_LENGTH);
}

/** `searchParams.get` has already decoded the query, so a decode here would let a double-encoded token through. */
export async function verifyCancelToken(secret: string, bookingId: string, token: string): Promise<boolean> {
  return timingSafeEqual(token, await cancelToken(secret, bookingId));
}

export function cancelUrl(siteUrl: string, locale: Locale, bookingId: string, token: string): string {
  return `${siteUrl}/${locale}/booking/cancel?b=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(token)}`;
}

/** `tiers` can come in any order. Past the pickup date daysBefore is negative: below every tier, so a 0% refund. */
export function refundForCancellation(
  tiers: CancellationTier[],
  paidJpy: number,
  startAt: number,
  now: number,
): CancellationRefund {
  return refundAtDays(tiers, paidJpy, daysBetweenDates(jstToday(now), jstToday(startAt)));
}

function refundAtDays(tiers: CancellationTier[], paidJpy: number, daysBefore: number): CancellationRefund {
  const byDaysDesc = tiers.toSorted((a, b) => b.minDaysBefore - a.minDaysBefore);
  const refundPercent = byDaysDesc.find((tier) => tier.minDaysBefore <= daysBefore)?.refundPercent ?? 0;
  // Multiplying first keeps the product a whole number; paid * (percent / 100) lands just under some whole yen.
  return { daysBefore, refundPercent, refundJpy: Math.floor((paidJpy * refundPercent) / 100) };
}

/**
 * The quote and what it took off, which the guard of a cancellation has to hold still. A guest's quote closes at pickup.
 * Staff may cancel a no-show, at the tier for 0 days before, so for them daysBefore stops at 0.
 */
async function priceCancellation(
  db: D1Database,
  bookingId: string,
  now: number,
  byStaff = false,
): Promise<{ quote: CancellationQuote; refundedJpy: number }> {
  const refuse = (reason: CancellationReason) => ({ quote: { ok: false as const, reason }, refundedJpy: 0 });

  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(bookingId).first<BookingRow>();
  if (row === null) return refuse("NOT_FOUND");

  const booking = toBooking(row);
  if (booking.source !== "web") return refuse("NOT_CANCELLABLE");
  if (booking.status === "CANCELLED") return refuse("ALREADY_CANCELLED");
  if (booking.status !== "CONFIRMED") return refuse("NOT_CANCELLABLE");
  if (!byStaff && now >= booking.startAt) return refuse("STARTED");

  const tiers = await readCancellationTiers(db);
  const guestTier = refundForCancellation(tiers, booking.paidJpy, booking.startAt, now);
  const tier = byStaff ? refundAtDays(tiers, booking.paidJpy, Math.max(0, guestTier.daysBefore)) : guestTier;
  const refundedJpy = (await db.prepare(REFUNDED_SQL).bind(bookingId).first<number>("total")) ?? 0;
  const refundJpy = Math.max(0, tier.refundJpy - refundedJpy);
  return { quote: { ok: true, booking, ...tier, refundJpy }, refundedJpy };
}

/**
 * Reads only. A guest's refund is quoted for a CONFIRMED web booking, up to but not including the pickup instant. Total
 * refunds equal the tier, so what the booking has already had back, from any origin, comes off the amount.
 */
export async function quoteCancellation(db: D1Database, bookingId: string, now: number): Promise<CancellationQuote> {
  return (await priceCancellation(db, bookingId, now)).quote;
}

/**
 * Reads only. What staff can give back on cancelling a CONFIRMED web booking, before or after pickup: the guest's tier
 * refund, all that was paid, or nothing, each less what the booking has already had back and never below 0.
 */
export async function quoteStaffCancellation(
  db: D1Database,
  bookingId: string,
  now: number,
): Promise<StaffCancellationQuote> {
  const { quote, refundedJpy } = await priceCancellation(db, bookingId, now, true);
  if (!quote.ok) return quote;
  const { booking, daysBefore, refundPercent, refundJpy } = quote;
  const amounts = { tier: refundJpy, full: Math.max(0, booking.paidJpy - refundedJpy), none: 0 };
  return { ok: true, booking, daysBefore, refundPercent, refundedJpy, amounts };
}

/** A package can leave the catalog while its bookings stay, and mail prints a missing value literally. */
export function nameIn(texts: string | null | undefined, locale: Locale): string {
  return texts ? (JSON.parse(texts) as Record<Locale, { name: string }>)[locale].name : "-";
}

/**
 * What a cancellation queues, the sheet item last, which is the item WON_SQL looks for. Written before Square answers, so
 * the status is RETRY and the mail says only that a refund is under way: a guest keeps this mail if it is later rejected.
 */
function cancellationItems(
  booking: Booking,
  refundJpy: number,
  names: { model_texts: string; package_texts: string | null } | null,
  { shopOpen, shopClose }: ShopConfig,
  staffEmail: string,
): OutboxItem[] {
  const { id, ref, startAt, endAt, paidJpy, vehiclePlate } = booking;
  const locale = booking.locale ?? "ja";
  const familyName = booking.guestFamilyName ?? "";
  const givenName = booking.guestGivenName ?? "";
  const facts = {
    ref,
    startAt,
    endAt,
    paidJpy,
    priceJpy: booking.priceJpy ?? 0,
    refundJpy,
    refundStatus: refundJpy > 0 ? "RETRY" : "NONE",
  };
  return [
    {
      kind: "email",
      dedupeKey: `email:guest_cancellation:${id}`,
      payload: {
        template: "guest_cancellation",
        to: booking.guestEmail ?? "",
        locale,
        data: {
          ...facts,
          modelName: nameIn(names?.model_texts, locale),
          packageName: nameIn(names?.package_texts, locale),
          shopOpen,
          shopClose,
          guest: { familyName, givenName },
        },
      },
    },
    {
      kind: "email",
      dedupeKey: `email:staff_cancellation:${id}`,
      payload: {
        template: "staff_cancellation",
        to: staffEmail,
        locale: "ja",
        data: {
          ...facts,
          modelNameJa: nameIn(names?.model_texts, "ja"),
          packageNameJa: nameIn(names?.package_texts, "ja"),
          vehiclePlate,
          guest: { familyName, givenName, email: booking.guestEmail ?? "", phone: booking.guestPhone ?? "" },
        },
      },
    },
    { kind: "sheet_booking", dedupeKey: `sheet:${id}:CANCELLED`, payload: { bookingId: id } },
  ];
}

function refundAlert(refund: RefundAttempt, refusal: string, staffEmail: string): OutboxItem {
  const say = (key: string) => t("ja", email, key);
  const amount = say("email.amount").replace("{amount}", refund.amountJpy.toLocaleString("en-US"));
  const detail = [
    `${say("email.label.refund")}: ${amount}`,
    `${say("email.staff.label.paymentId")}: ${refund.paymentId}`,
    `${say("email.staff.label.detail")}: ${refusal}`,
    say("email.staff.alert.refund.action"),
  ];
  return {
    kind: "email",
    dedupeKey: `email:staff_alert:${refund.idempotencyKey}`,
    payload: {
      template: "staff_alert",
      to: staffEmail,
      locale: "ja",
      data: { title: say("email.staff.alert.refund.title"), ref: refund.ref, detail: detail.join("\n") },
    },
  };
}

/** Only a definite refusal stops the retries: an answer that says nothing about the money must stay safe to send again. */
function settlementOf(result: RefundResult): Settlement {
  if (result.kind === "ok") {
    const { id, status } = result.refund;
    if (status === "PENDING" || status === "COMPLETED") return { status, squareRefundId: id, refusal: null };
    if (status === "REJECTED" || status === "FAILED") return { status, squareRefundId: id, refusal: status };
    return NO_ANSWER;
  }
  if (result.kind === "unknown" || NOT_NOW_CODES.has(result.code)) return NO_ANSWER;
  return { status: "REJECTED", squareRefundId: null, refusal: `${result.code}: ${result.detail}` };
}

/**
 * Sends a RETRY row's refund and records the answer, with any staff alert in the same write. Nothing here throws: the
 * cancellation stands whatever happens now, and a row left in RETRY goes out again under the same key.
 */
async function attemptRefund(
  { db, square, now, staffEmail }: RefundDeps,
  refund: RefundAttempt,
): Promise<RefundRowStatus> {
  try {
    const { idempotencyKey, paymentId, amountJpy } = refund;
    const answer = await square.refundPayment({ idempotencyKey, paymentId, amountJpy, reason: REFUND_REASON });
    const { status, squareRefundId, refusal } = settlementOf(answer);
    const settle = db.prepare(SETTLE_REFUND_SQL).bind(status, squareRefundId, now, refund.id);
    if (refusal === null) await settle.run();
    else await db.batch([settle, ...enqueueStatements(db, [refundAlert(refund, refusal, staffEmail)], now)]);
    return status;
  } catch (error) {
    console.warn(`Refund ${refund.id} left to retry: ${error instanceof Error ? error.message : String(error)}`);
    return "RETRY";
  }
}

/**
 * Writes a cancellation of `booking` that refunds `refundJpy`, behind `cancel`, its guarded UPDATE, and answers how the
 * refund went, or null when the guard refused it. One batch writes the cancellation, the refund row and the outbox items,
 * and Square hears about it only after that batch landed, from the one call that won.
 */
async function writeCancellation(
  deps: CancelDeps,
  booking: Booking,
  refundJpy: number,
  cancel: D1PreparedStatement,
): Promise<CancelRefundStatus | null> {
  const { db, now, staffEmail } = deps;
  const names = await db
    .prepare(NAMES_SQL)
    .bind(booking.modelId, booking.packageId)
    .first<{ model_texts: string; package_texts: string | null }>();
  const items = cancellationItems(booking, refundJpy, names, await readShopConfig(db), staffEmail);
  const won = [booking.id, now, items[items.length - 1].dedupeKey];

  const refund: RefundAttempt | null =
    refundJpy === 0
      ? null
      : {
          id: crypto.randomUUID(),
          ref: booking.ref,
          idempotencyKey: `rf:${booking.id}`,
          paymentId: booking.paymentId ?? "",
          amountJpy: refundJpy,
        };
  const [cancelled] = await db.batch([
    cancel,
    ...(refund === null
      ? []
      : [db.prepare(INSERT_REFUND_SQL).bind(refund.id, refundJpy, refund.idempotencyKey, now, ...won)]),
    ...enqueueWhereStatements(db, items, now, WON_SQL, won),
  ]);

  if (cancelled.meta.changes === 0) return null;

  if (refund === null) return "NONE";
  const status = await attemptRefund(deps, refund);
  return status === "FAILED" ? "REJECTED" : status;
}

/** One try at a guest's cancellation, quoting at this moment, or null when the guard refused it. */
async function tryCancel(deps: CancelDeps, bookingId: string): Promise<CancelResult | null> {
  const { db, now } = deps;
  const { quote, refundedJpy } = await priceCancellation(db, bookingId, now);
  if (!quote.ok) return quote;

  const { booking, refundJpy } = quote;
  const cancel = db.prepare(CANCEL_SQL).bind(booking.id, now, booking.startAt, booking.paidJpy, refundedJpy);
  const refundStatus = await writeCancellation(deps, booking, refundJpy, cancel);
  return refundStatus === null ? null : { ok: true, refundJpy, refundStatus };
}

/**
 * Cancels a guest's booking and refunds what the tier leaves. A refused guard earns one more try, which quotes afresh, so
 * a call that lost the race reads the booking as already cancelled, and a booking that moved after the quote is cancelled
 * at what it is worth now, not told it was cancelled when it was not.
 */
export async function cancelBooking(deps: CancelDeps, bookingId: string): Promise<CancelResult> {
  const result = (await tryCancel(deps, bookingId)) ?? (await tryCancel(deps, bookingId));
  return result ?? { ok: false, reason: "ALREADY_CANCELLED" };
}

/**
 * One try at a staff cancellation, quoting at this moment, or null when the guard refused it. An amount that is not what
 * the choice gives now writes nothing and answers the fresh quote.
 */
async function tryStaffCancel(
  deps: CancelDeps,
  bookingId: string,
  { choice, refundJpy }: StaffCancelRequest,
): Promise<StaffCancelResult | null> {
  const { db, now } = deps;
  const quote = await quoteStaffCancellation(db, bookingId, now);
  if (!quote.ok) return quote;
  if (quote.amounts[choice] !== refundJpy) return { ok: false, reason: "QUOTE_CHANGED", quote };

  const { booking, refundedJpy } = quote;
  const cancel = db
    .prepare(STAFF_CANCEL_SQL)
    .bind(booking.id, now, booking.startAt, booking.paidJpy, refundedJpy, refundedJpy + refundJpy);
  const refundStatus = await writeCancellation(deps, booking, refundJpy, cancel);
  return refundStatus === null ? null : { ok: true, choice, refundJpy, refundStatus };
}

/**
 * Cancels a web booking for staff, from the Dashboard, at any time while it is CONFIRMED, refunding the amount they chose
 * from a quote: `refundJpy` has to be what `choice` gives now. It lands as a guest's cancellation does, under the same
 * guard and refund key, with cancel_reason 'staff' and refund_due_jpy the total it settles on. A refused guard earns one
 * more try, as in cancelBooking, which answers ALREADY_CANCELLED to a call that lost the race.
 */
export async function cancelByStaff(
  deps: CancelDeps,
  bookingId: string,
  request: StaffCancelRequest,
): Promise<StaffCancelResult> {
  const { choice, refundJpy } = request;
  // The caller's input is checked before anything is read, and a choice is looked up only once it is one of the three.
  if (!(STAFF_REFUND_CHOICES as readonly unknown[]).includes(choice)) return { ok: false, reason: "BAD_CHOICE" };
  if (!Number.isSafeInteger(refundJpy) || refundJpy < 0) return { ok: false, reason: "BAD_CHOICE" };

  const result = (await tryStaffCancel(deps, bookingId, request)) ?? (await tryStaffCancel(deps, bookingId, request));
  return result ?? { ok: false, reason: "ALREADY_CANCELLED" };
}

/** Sends RETRY rows again with the key and the amount on record, never a new quote. For the cron, task #42. */
export async function retryRefunds(deps: RefundDeps, limit = 10): Promise<RetryResult> {
  const { results } = await deps.db.prepare(WAITING_REFUNDS_SQL).bind(limit).all<RefundAttempt>();
  const result: RetryResult = { retried: 0, completed: 0, stillPending: 0 };
  for (const refund of results) {
    const status = await attemptRefund(deps, refund);
    result.retried += 1;
    if (status === "COMPLETED") result.completed += 1;
    else if (status === "PENDING" || status === "RETRY") result.stillPending += 1;
  }
  return result;
}
