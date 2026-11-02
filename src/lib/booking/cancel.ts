// What a guest gets back for cancelling, and the signed link that lets them. Tiers count JST calendar days, and online
// cancellation closes at pickup.
import { hmacSha256Base64, timingSafeEqual } from "../crypto.ts";
import { readCancellationTiers } from "../db/config.ts";
import type { Locale } from "../locale.ts";
import { daysBetweenDates, jstToday } from "../time.ts";
import type { Booking, BookingSource, BookingStatus, CancellationTier } from "../types.ts";

export type CancellationRefund = { daysBefore: number; refundPercent: number; refundJpy: number };

export type CancellationReason = "NOT_FOUND" | "NOT_CANCELLABLE" | "ALREADY_CANCELLED" | "STARTED";

export type CancellationQuote =
  | ({ ok: true; booking: Booking } & CancellationRefund)
  | { ok: false; reason: CancellationReason };

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
};

const TOKEN_LENGTH = 32;

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
  const daysBefore = daysBetweenDates(jstToday(now), jstToday(startAt));
  const byDaysDesc = tiers.toSorted((a, b) => b.minDaysBefore - a.minDaysBefore);
  const refundPercent = byDaysDesc.find((tier) => tier.minDaysBefore <= daysBefore)?.refundPercent ?? 0;
  // Multiplying first keeps the product a whole number; paid * (percent / 100) lands just under some whole yen.
  return { daysBefore, refundPercent, refundJpy: Math.floor((paidJpy * refundPercent) / 100) };
}

/** Reads only. A guest's refund is quoted for a CONFIRMED web booking, up to but not including the pickup instant. */
export async function quoteCancellation(db: D1Database, bookingId: string, now: number): Promise<CancellationQuote> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(bookingId).first<BookingRow>();
  if (row === null) return { ok: false, reason: "NOT_FOUND" };

  const booking = toBooking(row);
  if (booking.source !== "web") return { ok: false, reason: "NOT_CANCELLABLE" };
  if (booking.status === "CANCELLED") return { ok: false, reason: "ALREADY_CANCELLED" };
  if (booking.status !== "CONFIRMED") return { ok: false, reason: "NOT_CANCELLABLE" };
  if (now >= booking.startAt) return { ok: false, reason: "STARTED" };

  const tiers = await readCancellationTiers(db);
  return { ok: true, booking, ...refundForCancellation(tiers, booking.paidJpy, booking.startAt, now) };
}
