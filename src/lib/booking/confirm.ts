// Paying the deposit on a hold. A conditional UPDATE takes a live hold to PAYMENT_PENDING, which is the lock: only that call
// charges, under a key made from the attempt the row counts. A booking is confirmed only by a COMPLETED payment of its
// deposit in JPY, and markConfirmed is the one place that happens, for this confirm, the webhook (#36) and the resolver (#41)
// alike. A payment that cannot confirm its booking goes back in full under a key of the payment's own, never #35's rf:{id}.
import { pages } from "../../i18n/strings/pages.ts";
import { t } from "../../i18n/t.ts";
import { type Guest, validateGuest } from "../checkout.ts";
import { sha256Hex } from "../crypto.ts";
import { isBlocking } from "../db/blocking.ts";
import { readCancellationTiers, readShopConfig } from "../db/config.ts";
import type { Locale } from "../locale.ts";
import { enqueueWhereStatements, type OutboxItem } from "../outbox.ts";
import type { SquareClient } from "../square/client.ts";
import type { Booking, CancellationTier } from "../types.ts";
import { cancelToken, cancelUrl, nameIn } from "./cancel.ts";
import { getBooking } from "./holds.ts";

export type ConfirmContext = { square: SquareClient; siteUrl: string; cancelSecret: string; staffEmail: string };

export type ConfirmDeps = ConfirmContext & { db: D1Database; now: () => number };

export type ConfirmInput = { sourceId: string; guest: Guest; locale: Locale };

export type ConfirmReason =
  | "NOT_FOUND"
  | "HOLD_EXPIRED"
  | "IN_PROGRESS"
  | "PAYMENT_DECLINED"
  | "PAYMENT_UNKNOWN"
  | "INVALID_GUEST";

export type ConfirmResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: ConfirmReason; message?: string; fields?: string[] };

/** A payment as Square reports it, from the charge, a webhook or a listing. */
export type DepositPayment = { id: string; amountJpy: number; currency: string; status: string };

/**
 * confirmed: this payment confirmed the booking now. already: it had, or it is the payment a cancelled booking settled.
 * lost: it confirms nothing, and money it took for a web booking is on its way back.
 */
export type MarkResult = "confirmed" | "already" | "lost";

/** The columns markConfirmed decides on and mails from, with the names of the model and the package. */
type PaymentRow = {
  id: string;
  ref: string;
  status: Booking["status"];
  source: Booking["source"];
  vehicle_plate: string;
  start_at: number;
  end_at: number;
  price_jpy: number | null;
  deposit_jpy: number | null;
  locale: Locale | null;
  guest_family_name: string | null;
  guest_given_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  payment_id: string | null;
  payment_attempt: number;
  model_texts: string | null;
  package_texts: string | null;
};

/** Statuses of a payment that took no money. */
export const NOTHING_TAKEN: ReadonlySet<string> = new Set(["FAILED", "CANCELED"]);

/** Fixed, because Square compares the whole request under one key, and a mismatch and a lost payment share theirs. */
const SEND_BACK_REASON = "Payment returned: it did not confirm a booking";

/** Square's cap on an idempotency key. */
const MAX_KEY_LENGTH = 45;
const SEND_BACK_PREFIX = "rp:";

/** The deposit is the hold's own, copied from its type when it was made, whatever the catalog says now. */
const START_SQL = `UPDATE bookings
  SET status = 'PAYMENT_PENDING', payment_attempt = payment_attempt + 1, locale = ?2,
    guest_family_name = ?3, guest_given_name = ?4, guest_email = ?5, guest_phone = ?6, updated_at = ?7
  WHERE id = ?1 AND source = 'web' AND status = 'ON_HOLD' AND expires_at > ?7
  RETURNING payment_attempt, deposit_jpy`;

/** Back to the hold it was, guest and expiry kept, unless the row has moved on from this attempt's charge. */
const RELEASE_SQL = `UPDATE bookings SET status = 'ON_HOLD', updated_at = ?3
  WHERE id = ?1 AND status = 'PAYMENT_PENDING' AND payment_attempt = ?2`;

/** No expiry here: a charge already out keeps the bike, however late Square answers. */
const CONFIRM_SQL = `UPDATE bookings
  SET status = 'CONFIRMED', payment_id = ?2, paid_jpy = ?3, confirmed_at = ?4, updated_at = ?4
  WHERE id = ?1 AND status = 'PAYMENT_PENDING'`;

/**
 * The outbox items go in only if the booking is CONFIRMED on this payment once CONFIRM_SQL has run in the same batch, so a
 * booking another payment took gets no second set. The same payment twice finds its items there under the same keys.
 * Reads ?5 the booking and ?6 the payment.
 */
const CONFIRMED_BY_SQL = "EXISTS (SELECT 1 FROM bookings WHERE id = ?5 AND status = 'CONFIRMED' AND payment_id = ?6)";

/** The model may be off sale and the package gone, so neither join may drop the booking. */
const PAYMENT_ROW_SQL = `SELECT b.*, m.texts AS model_texts, p.texts AS package_texts FROM bookings b
  LEFT JOIN models m ON m.id = b.model_id LEFT JOIN packages p ON p.id = b.package_id
  WHERE b.id = ?1`;

function refuse(reason: ConfirmReason): ConfirmResult {
  return { ok: false, reason };
}

/** What a call that did not get to charge answers, by the booking as it stands. */
function answerFor(booking: Booking | null, now: number): ConfirmResult {
  // A staff block has no guest of ours and nothing to pay, as its checkout page says.
  if (booking === null || booking.source !== "web") return refuse("NOT_FOUND");
  if (booking.status === "CONFIRMED") return { ok: true, booking };
  // A charge in flight, or one that was a moment ago and has just ended.
  if (isBlocking(booking, now)) return refuse("IN_PROGRESS");
  return refuse("HOLD_EXPIRED");
}

/** What markConfirmed takes as the deposit paid: the booking's deposit to the yen, in JPY. */
export function matchesDeposit(payment: DepositPayment, depositJpy: number | null): boolean {
  return payment.amountJpy === depositJpy && payment.currency === "JPY";
}

/** The payment's own key: a hash, since an id may run to 192 characters, so a replay of one payment moves money once. */
async function sendBackKey(paymentId: string): Promise<string> {
  const digest = await sha256Hex(paymentId);
  return `${SEND_BACK_PREFIX}${digest.slice(0, MAX_KEY_LENGTH - SEND_BACK_PREFIX.length)}`;
}

/** Refunds the whole payment. A refusal or no answer is left to reconciliation (#43): nothing here waits on it. */
async function sendBack(square: SquareClient, payment: DepositPayment): Promise<void> {
  const answer = await square.refundPayment({
    idempotencyKey: await sendBackKey(payment.id),
    paymentId: payment.id,
    amountJpy: payment.amountJpy,
    reason: SEND_BACK_REASON,
  });
  if (answer.kind !== "ok") console.warn(`Refund of payment ${payment.id} not confirmed: ${answer.kind}`);
}

async function release(db: D1Database, id: string, attempt: number, now: number): Promise<void> {
  await db.prepare(RELEASE_SQL).bind(id, attempt, now).run();
}

/** The published tiers in the policies page's words, highest first, as readCancellationTiers gives them. */
function policySummary(tiers: CancellationTier[], locale: Locale): string {
  const say = (key: string) => t(locale, pages, key);
  const lines = tiers.map(({ minDaysBefore, refundPercent }) =>
    say(minDaysBefore === 0 ? "policies.tier.pickupDay" : "policies.tier.days")
      .replace("{days}", String(minDaysBefore))
      .replace("{percent}", String(refundPercent)),
  );
  return [...lines, say("policies.cancellation.noMatch"), say("policies.cancellation.note")].join("\n");
}

/** Every field each template reads, from the row alone, since the webhook and the resolver have no request behind them. */
async function confirmationItems(
  db: D1Database,
  row: PaymentRow,
  payment: DepositPayment,
  ctx: ConfirmContext,
): Promise<OutboxItem[]> {
  const [config, tiers] = await Promise.all([readShopConfig(db), readCancellationTiers(db)]);
  const { id, ref, start_at: startAt, end_at: endAt } = row;
  const locale = row.locale ?? "ja";
  const facts = { ref, startAt, endAt, priceJpy: row.price_jpy ?? 0, paidJpy: payment.amountJpy };
  const familyName = row.guest_family_name ?? "";
  const givenName = row.guest_given_name ?? "";
  return [
    {
      kind: "email",
      dedupeKey: `email:guest_confirmation:${id}`,
      payload: {
        template: "guest_confirmation",
        to: row.guest_email ?? "",
        locale,
        data: {
          ...facts,
          modelName: nameIn(row.model_texts, locale),
          packageName: nameIn(row.package_texts, locale),
          shopOpen: config.shopOpen,
          shopClose: config.shopClose,
          guest: { familyName, givenName },
          cancelUrl: cancelUrl(ctx.siteUrl, locale, id, await cancelToken(ctx.cancelSecret, id)),
          policySummary: policySummary(tiers, locale),
        },
      },
    },
    {
      kind: "email",
      dedupeKey: `email:staff_new_booking:${id}`,
      payload: {
        template: "staff_new_booking",
        to: ctx.staffEmail,
        locale: "ja",
        data: {
          ...facts,
          modelNameJa: nameIn(row.model_texts, "ja"),
          packageNameJa: nameIn(row.package_texts, "ja"),
          vehiclePlate: row.vehicle_plate,
          guest: { familyName, givenName, email: row.guest_email ?? "", phone: row.guest_phone ?? "" },
        },
      },
    },
    { kind: "sheet_booking", dedupeKey: `sheet:${id}:CONFIRMED`, payload: { bookingId: id } },
  ];
}

/** Whether the booking already settled this payment: confirmed on it, or cancelled with it, under #35's tier. */
function settledBy(row: Pick<PaymentRow, "status" | "payment_id">, payment: DepositPayment): boolean {
  return (row.status === "CONFIRMED" || row.status === "CANCELLED") && row.payment_id === payment.id;
}

/**
 * Confirms the booking on a payment, checking the payment's status, then its amount and currency against the deposit, then
 * the row. The update and the three outbox items are one batch, so a write that fails leaves the row PAYMENT_PENDING and
 * rejects, for the caller to try again. Square is called only to send money back.
 */
export async function markConfirmed(
  db: D1Database,
  id: string,
  payment: DepositPayment,
  now: number,
  ctx: ConfirmContext,
): Promise<MarkResult> {
  // Money that never moved, or has not moved yet, confirms nothing and has nothing to send back.
  if (payment.status !== "COMPLETED") return "lost";

  const row = await db.prepare(PAYMENT_ROW_SQL).bind(id).first<PaymentRow>();
  // No web booking of ours: staff may have taken it in the Dashboard, so it stays where it is.
  if (row === null || row.source !== "web") return "lost";

  if (!matchesDeposit(payment, row.deposit_jpy)) {
    // The refund first: a crash after it leaves the row PAYMENT_PENDING, where the resolver finds this payment again.
    await sendBack(ctx.square, payment);
    if (row.status === "PAYMENT_PENDING") await release(db, id, row.payment_attempt, now);
    return "lost";
  }

  if (settledBy(row, payment)) return "already";

  if (row.status === "PAYMENT_PENDING") {
    const items = await confirmationItems(db, row, payment, ctx);
    const [update] = await db.batch([
      db.prepare(CONFIRM_SQL).bind(id, payment.id, payment.amountJpy, now),
      ...enqueueWhereStatements(db, items, now, CONFIRMED_BY_SQL, [id, payment.id]),
    ]);
    if (update.meta.changes > 0) return "confirmed";

    const moved = await db
      .prepare("SELECT status, payment_id FROM bookings WHERE id = ?1")
      .bind(id)
      .first<Pick<PaymentRow, "status" | "payment_id">>();
    if (moved !== null && settledBy(moved, payment)) return "already";
  }

  await sendBack(ctx.square, payment);
  return "lost";
}

/**
 * Charges the deposit on a live hold and confirms it. `input` comes from a request body, so the guest is checked here. Square
 * is never called for a hold that has expired, and a hold whose charge is out answers IN_PROGRESS to every other call.
 */
export async function confirmHold(deps: ConfirmDeps, id: string, input: ConfirmInput): Promise<ConfirmResult> {
  const { db, square } = deps;
  const { sourceId, guest, locale } = input;
  const fields = validateGuest(guest);
  if (fields.length > 0) return { ok: false, reason: "INVALID_GUEST", fields };

  const startedAt = deps.now();
  const held = await db
    .prepare(START_SQL)
    .bind(id, locale, guest.familyName, guest.givenName, guest.email, guest.phone, startedAt)
    .first<{ payment_attempt: number; deposit_jpy: number }>();
  if (held === null) return answerFor(await getBooking(db, id), startedAt);

  const { payment_attempt: attempt, deposit_jpy: depositJpy } = held;
  const answer = await square.createPayment({
    idempotencyKey: `${id}:${attempt}`,
    sourceId,
    amountJpy: depositJpy,
    referenceId: id,
  });
  const now = deps.now();

  // Money may have moved: the row keeps the bike in PAYMENT_PENDING until the webhook or the resolver settles it.
  if (answer.kind === "unknown") return refuse("PAYMENT_UNKNOWN");
  // Square's code and detail stay here: told which check failed, a card tester knows what to change.
  if (answer.kind !== "ok" || NOTHING_TAKEN.has(answer.payment.status)) {
    await release(db, id, attempt, now);
    return refuse("PAYMENT_DECLINED");
  }
  if (answer.payment.status !== "COMPLETED") return refuse("PAYMENT_UNKNOWN");

  const { id: paymentId, amount, currency, status } = answer.payment;
  const payment: DepositPayment = { id: paymentId, amountJpy: amount, currency, status };
  if (!matchesDeposit(payment, depositJpy)) {
    await sendBack(square, payment);
    await release(db, id, attempt, now);
    return refuse("PAYMENT_DECLINED");
  }

  let outcome: MarkResult;
  try {
    outcome = await markConfirmed(db, id, payment, now, deps);
  } catch (error) {
    // The money has moved and the row still holds the bike, so the webhook or the resolver confirms it later.
    console.error(`Payment ${paymentId} for booking ${id} not yet recorded`, error);
    return refuse("PAYMENT_UNKNOWN");
  }
  if (outcome === "lost") return refuse("HOLD_EXPIRED");
  return answerFor(await getBooking(db, id), now);
}
