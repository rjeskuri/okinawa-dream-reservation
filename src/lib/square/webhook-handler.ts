// Square's payment and refund notifications, once the route has checked their signature. Each event is claimed in
// webhook_events before anything else, so a redelivery is acknowledged and handled once. An event whose handling fails
// gives its claim back and rejects: the route answers 5xx, and Square's next delivery of it is handled. A COMPLETED
// payment goes to markConfirmed (#34), the one place a booking is confirmed or a payment sent back; a payment that took
// nothing releases the hold of the attempt it belongs to; a refund moves its row, or is recorded as the cancellation's
// own or as one staff made in the Dashboard.
import { type ConfirmContext, markConfirmed } from "../booking/confirm.ts";
import { enqueueWhereStatements, type OutboxItem } from "../outbox.ts";

export type WebhookDeps = ConfirmContext & { db: D1Database; now: number };

/** processed: a new event of a handled type, whether or not it changed anything. ignored: anything else. */
export type WebhookOutcome = "processed" | "duplicate" | "ignored";

type Json = Record<string, unknown>;

/** `referenceId` is empty when the payment names nothing, and `createdAt` is NaN when it gives no time that parses. */
type Payment = { id: string; status: string; amountJpy: number; currency: string; referenceId: string; createdAt: number };

/** `paymentId` is empty when Square links the refund to no payment. */
type Refund = { id: string; status: string; amountJpy: number; currency: string; paymentId: string };

type HandledEvent =
  | { eventId: string; type: string; kind: "payment"; payment: Payment }
  | { eventId: string; type: string; kind: "refund"; refund: Refund };

const PAYMENT_TYPES = new Set(["payment.created", "payment.updated"]);
const REFUND_TYPES = new Set(["refund.created", "refund.updated"]);

/** Statuses of a payment that took no money. */
const NOTHING_TAKEN = new Set(["FAILED", "CANCELED"]);

/** The statuses a refunds row holds from Square. Another one Square may add later changes nothing here. */
const REFUND_STATUSES = new Set(["PENDING", "COMPLETED", "REJECTED", "FAILED"]);

const CLAIM_SQL = "INSERT OR IGNORE INTO webhook_events (event_id, type, received_at) VALUES (?1, ?2, ?3)";

const UNCLAIM_SQL = "DELETE FROM webhook_events WHERE event_id = ?1";

/**
 * Back to the hold it was, guest, attempt and expiry kept, only for the attempt the payment belongs to: confirmHold sets
 * updated_at as it starts an attempt, so a payment created before that is an earlier attempt's, however late it lands.
 * Reads ?2 the payment's created_at.
 */
const RELEASE_SQL = `UPDATE bookings SET status = 'ON_HOLD', updated_at = ?3
  WHERE id = ?1 AND source = 'web' AND status = 'PAYMENT_PENDING' AND updated_at <= ?2`;

const KNOWN_REFUND_SQL = "SELECT booking_id FROM refunds WHERE square_refund_id = ?1";

const PAID_BY_SQL = "SELECT id FROM bookings WHERE payment_id = ?1 LIMIT 1";

/**
 * The cancellation's own refund, which Square made before cancelBooking or retryRefunds heard back: its row waits in RETRY
 * with no Square id, for the amount the cancellation asked, which is the amount Square refunds. cancelBooking settles only
 * a RETRY row, so it leaves what this writes, and the UNIQUE square_refund_id is never written twice.
 */
const MATCH_CANCEL_SQL = `UPDATE refunds SET square_refund_id = ?1, status = ?2, updated_at = ?3
  WHERE id = (SELECT id FROM refunds WHERE booking_id = ?4 AND origin = 'cancel' AND status = 'RETRY'
      AND square_refund_id IS NULL AND amount_jpy = ?5 LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM refunds WHERE square_refund_id = ?1)`;

/** A refund no row knows, once the cancellation's own has not taken it, is one staff made in the Dashboard. */
const INSERT_DASHBOARD_SQL = `INSERT INTO refunds
    (id, booking_id, square_refund_id, amount_jpy, status, origin, idempotency_key, created_at, updated_at)
  SELECT ?1, ?2, ?3, ?4, ?5, 'dashboard', NULL, ?6, ?6
  WHERE NOT EXISTS (SELECT 1 FROM refunds WHERE square_refund_id = ?3)`;

/** Square does not promise order, so a PENDING that lands late never takes back a refund that has settled. */
const MOVE_REFUND_SQL = `UPDATE refunds SET status = ?2, updated_at = ?3
  WHERE square_refund_id = ?1 AND status <> ?2
    AND (?2 <> 'PENDING' OR status NOT IN ('COMPLETED', 'REJECTED', 'FAILED'))`;

/** The sheet item goes in only if the refund's row holds this status once the batch has run. Reads ?5 and ?6. */
const REFUND_HOLDS_SQL = "EXISTS (SELECT 1 FROM refunds WHERE square_refund_id = ?5 AND status = ?6)";

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isWholeYen(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Square omits an empty field, and an empty reference names nothing either way. */
function readPayment(value: unknown): Payment | null {
  if (!isRecord(value) || !isRecord(value.amount_money)) return null;
  const { id, status, reference_id = "", created_at } = value;
  const { amount, currency } = value.amount_money;
  if (!isText(id) || !isText(status) || !isText(currency) || !isWholeYen(amount)) return null;
  if (typeof reference_id !== "string") return null;
  const createdAt = typeof created_at === "string" ? Date.parse(created_at) : Number.NaN;
  return { id, status, amountJpy: amount, currency, referenceId: reference_id, createdAt };
}

/** A refund moves money back, so one of nothing is no refund: refunds.amount_jpy has to be above zero. */
function readRefund(value: unknown): Refund | null {
  if (!isRecord(value) || !isRecord(value.amount_money)) return null;
  const { id, status, payment_id = "" } = value;
  const { amount, currency } = value.amount_money;
  if (!isText(id) || !isText(status) || !isText(currency) || !isWholeYen(amount) || amount <= 0) return null;
  if (typeof payment_id !== "string") return null;
  return { id, status, amountJpy: amount, currency, paymentId: payment_id };
}

/**
 * The event, or null when it is not one this handles. A handled type whose object cannot be read is null too: an answer
 * that is not 2xx would have Square send it again for days, and no delivery of it could ever be handled.
 */
function readEvent(event: unknown): HandledEvent | null {
  if (!isRecord(event) || !isText(event.event_id) || typeof event.type !== "string") return null;
  const { event_id: eventId, type, data } = event;
  const object = isRecord(data) && isRecord(data.object) ? data.object : {};
  if (PAYMENT_TYPES.has(type)) {
    const payment = readPayment(object.payment);
    return payment === null ? null : { eventId, type, kind: "payment", payment };
  }
  if (REFUND_TYPES.has(type)) {
    const refund = readRefund(object.refund);
    return refund === null ? null : { eventId, type, kind: "refund", refund };
  }
  return null;
}

/**
 * A payment that names no booking is the shop's own sale and stays where it is. One still on its way (APPROVED, PENDING)
 * changes nothing until Square tells of it again.
 */
async function onPayment(deps: WebhookDeps, payment: Payment): Promise<void> {
  const { db, now } = deps;
  const { id, status, amountJpy, currency, referenceId, createdAt } = payment;
  if (referenceId === "") return;
  if (status === "COMPLETED") {
    await markConfirmed(db, referenceId, { id, amountJpy, currency, status }, now, deps);
    return;
  }
  // A payment with no time to judge it by may be an earlier attempt's: the row waits for confirmHold or the resolver (#41).
  if (NOTHING_TAKEN.has(status) && Number.isFinite(createdAt)) {
    await db.prepare(RELEASE_SQL).bind(referenceId, createdAt, now).run();
  }
}

/**
 * The booking whose payment the refund is of, and no other: a send-back of a payment that confirmed nothing is no
 * booking's refund. Only yen is recorded, since the row holds amount_jpy.
 */
async function bookingRefundedBy(db: D1Database, refund: Refund): Promise<string | null> {
  if (refund.paymentId === "" || refund.currency !== "JPY") return null;
  return db.prepare(PAID_BY_SQL).bind(refund.paymentId).first<string>("id");
}

/**
 * One batch: a refund no row knows yet is matched to the cancellation's row or recorded as the Dashboard's, then the row
 * takes Square's status, and the sheet hears of it. The move runs even after a match or an insert, so that a delivery
 * which lost a race with another for the same new refund still lands its status.
 */
async function onRefund({ db, now }: WebhookDeps, refund: Refund): Promise<void> {
  const { id, status, amountJpy } = refund;
  if (!REFUND_STATUSES.has(status)) return;

  const known = await db.prepare(KNOWN_REFUND_SQL).bind(id).first<string>("booking_id");
  const bookingId = known ?? (await bookingRefundedBy(db, refund));
  if (bookingId === null) return;

  const recordNew =
    known !== null
      ? []
      : [
          db.prepare(MATCH_CANCEL_SQL).bind(id, status, now, bookingId, amountJpy),
          db.prepare(INSERT_DASHBOARD_SQL).bind(crypto.randomUUID(), bookingId, id, amountJpy, status, now),
        ];
  const item: OutboxItem = {
    kind: "sheet_booking",
    dedupeKey: `sheet:${bookingId}:refund:${status}`,
    payload: { bookingId },
  };
  await db.batch([
    ...recordNew,
    db.prepare(MOVE_REFUND_SQL).bind(id, status, now),
    ...enqueueWhereStatements(db, [item], now, REFUND_HOLDS_SQL, [id, status]),
  ]);
}

/** A claim that cannot be given back leaves the event seen, and Square's redelivery is dropped, so it is logged loudly. */
async function unclaim(db: D1Database, eventId: string): Promise<void> {
  try {
    await db.prepare(UNCLAIM_SQL).bind(eventId).run();
  } catch (error) {
    console.error(`Square event ${eventId} failed and stays marked as seen: its redelivery will be dropped`, error);
  }
}

/** Rejects when the event could not be handled, with its claim given back, so the caller answers Square with a 5xx. */
export async function handleSquareEvent(deps: WebhookDeps, event: unknown): Promise<WebhookOutcome> {
  const handled = readEvent(event);
  if (handled === null) return "ignored";

  const { db, now } = deps;
  const claim = await db.prepare(CLAIM_SQL).bind(handled.eventId, handled.type, now).run();
  if (claim.meta.changes === 0) return "duplicate";

  try {
    if (handled.kind === "payment") await onPayment(deps, handled.payment);
    else await onRefund(deps, handled.refund);
  } catch (error) {
    await unclaim(db, handled.eventId);
    throw error;
  }
  return "processed";
}
