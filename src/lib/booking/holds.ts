// A hold takes the least-used free bike of a model in one conditional INSERT. D1 has no transactions, but it runs one
// statement at a time per database, so that statement is the lock: which bike a hold gets, and every catalog value it
// keeps, is read inside it.
import { randomRef } from "../crypto.ts";
import { BLOCKING_SQL, OVERLAP_SQL, rentalEnd } from "../db/blocking.ts";
import { readClosedDates, readShopConfig } from "../db/config.ts";
import { isLocale } from "../locale.ts";
import type { Locale } from "../locale.ts";
import { bookedAhead } from "../pricing.ts";
import { JST_OFFSET_MS, jstToday } from "../time.ts";
import type { Booking, BookingSource, BookingStatus, PackageLength } from "../types.ts";
import { pickupWindowError } from "./pickup-window.ts";
import type { PickupWindowReason } from "./pickup-window.ts";

export type HoldInput = { id: string; modelId: string; packageId: string; startAt: number; locale: Locale };

export type HoldReason = "SOLD_OUT" | "UNKNOWN_MODEL" | "UNKNOWN_PACKAGE" | "NO_PRICE" | "CONFLICT" | PickupWindowReason;

export type HoldResult = { ok: true; booking: Booking } | { ok: false; reason: HoldReason };

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

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The last date YYYY-MM-DD can write. */
const LAST_DATE = "9999-12-31";

/** Longer than any id the site makes, so a guest's megabyte string stops here and never meets D1's limit on a value. */
const MAX_KEY_LENGTH = 200;

/** How many refs one hold tries. */
const REF_ATTEMPTS = 2;

/** The number of the JST date of an epoch ms column, by SQLite's integer division. */
function jstDaySql(column: string): string {
  return `(${column} + ${JST_OFFSET_MS}) / ${DAY_MS}`;
}

/**
 * A vehicle's rental days: base_usage_days plus each CONFIRMED booking, past and future, as one day when it lasts 24 hours
 * or less (owner, 2026-11-15: an hourly rental is one day) and as the JST dates it touches when longer. A booking counts by
 * its own start and end, because a staff block has no package and a package can change or leave after the booking.
 * Reads vehicle alias `v`.
 */
const USAGE_SQL = `(v.base_usage_days + COALESCE((
  SELECT SUM(CASE WHEN u.end_at - u.start_at <= ${DAY_MS} THEN 1
    ELSE ${jstDaySql("u.end_at")} - ${jstDaySql("u.start_at")} + 1 END)
  FROM bookings u WHERE u.vehicle_plate = v.plate AND u.status = 'CONFIRMED'), 0))`;

/**
 * The SELECT that picks a bike: the plate of the least-used free active vehicle of `q.model`, then the lowest odometer
 * with unknown last, then the lowest plate, or no row when none is free. Embed it as a subquery of one statement that
 * declares `WITH q(s, e, buf, now, model) AS (SELECT ?1, ?2, ?3, ?4, ?5)`: picked in an earlier statement, the bike can
 * be gone by the time it is written.
 */
export const assignFreeVehicleSql = `SELECT v.plate FROM vehicles v
  WHERE v.model_id = (SELECT model FROM q) AND v.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.vehicle_plate = v.plate AND ${BLOCKING_SQL} AND ${OVERLAP_SQL})
  ORDER BY ${USAGE_SQL} ASC, v.odometer_km ASC NULLS LAST, v.plate ASC
  LIMIT 1`;

/**
 * The hold. Prices and the type join through the model here, not through keys read earlier, because a publish can move
 * them between that read and this statement. ?11 is 1 when the hold is booked ahead of the pickup's JST date (#131), and
 * then the row's advance price is locked where it has one: the row's prices are read here too, for the same reason. A taken
 * id or ref inserts nothing, as no free bike does, and createHold tells the three apart.
 */
const HOLD_SQL = `WITH q(s, e, buf, now, model) AS (SELECT ?1, ?2, ?3, ?4, ?5)
  INSERT INTO bookings (id, ref, status, source, model_id, package_id, vehicle_plate, start_at, end_at, expires_at,
    price_jpy, deposit_jpy, catalog_version, locale, created_at, updated_at)
  SELECT ?6, ?7, 'ON_HOLD', 'web', m.id, p.package_id, v.plate, ?1, ?2, ?8,
    CASE WHEN ?11 = 1 AND p.advance_price_jpy IS NOT NULL THEN p.advance_price_jpy ELSE p.price_jpy END,
    t.deposit_jpy, c.version, ?9, ?4, ?4
  FROM vehicles v
  JOIN models m ON m.id = v.model_id
  JOIN prices p ON p.rate_class_id = m.rate_class_id AND p.package_id = ?10
  JOIN vehicle_types t ON t.id = m.type_id
  JOIN catalog_meta c ON c.id = 1
  WHERE m.active = 1 AND v.plate = (${assignFreeVehicleSql})
  ON CONFLICT DO NOTHING
  RETURNING *`;

/** One row whatever exists, with a null for each of the model, package and price that does not. */
const CATALOG_SQL = `SELECT m.id AS model, pk.id AS package, pk.days, pk.hours, pr.price_jpy AS price
  FROM (SELECT ?1 AS model_id, ?2 AS package_id) AS asked
  LEFT JOIN models m ON m.id = asked.model_id AND m.active = 1
  LEFT JOIN packages pk ON pk.id = asked.package_id
  LEFT JOIN prices pr ON pr.rate_class_id = m.rate_class_id AND pr.package_id = pk.id`;

type CatalogRow = {
  model: string | null;
  package: string | null;
  days: number | null;
  hours: number | null;
  price: number | null;
};

function isKey(x: unknown): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= MAX_KEY_LENGTH;
}

function refuse(reason: HoldReason): HoldResult {
  return { ok: false, reason };
}

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

export async function getBooking(db: D1Database, id: string): Promise<Booking | null> {
  if (!isKey(id)) return null;
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  return row === null ? null : toBooking(row);
}

/**
 * Holds the least-used free bike of the model, or names why not. `input` comes from a request body, so nothing about it
 * is taken from its type. `input.id` is the caller's idempotency key: a replay gets the booking as it now stands, and a
 * different request under a stored id gets CONFLICT.
 */
export async function createHold(db: D1Database, input: HoldInput, now: number): Promise<HoldResult> {
  // Object() because null or a number has no fields to read.
  const { id, modelId, packageId, startAt, locale } = Object(input) as Record<keyof HoldInput, unknown>;

  // No reason is declared for either of these, and CONFLICT is the one that says the request cannot stand as written.
  if (!isKey(id) || !isLocale(locale)) return refuse("CONFLICT");

  const settle = (booking: Booking): HoldResult => {
    const same =
      booking.modelId === modelId &&
      booking.packageId === packageId &&
      booking.startAt === startAt &&
      booking.locale === locale;
    return same ? { ok: true, booking } : refuse("CONFLICT");
  };

  // Before anything else, so that a replay is answered from the booking, whatever the catalog or the clock now say.
  const stored = await getBooking(db, id);
  if (stored !== null) return settle(stored);

  if (!isKey(modelId)) return refuse("UNKNOWN_MODEL");
  if (!isKey(packageId)) return refuse("UNKNOWN_PACKAGE");
  const catalog = await db
    .prepare(CATALOG_SQL)
    .bind(modelId, packageId)
    .first<CatalogRow>();
  if (!catalog?.model) return refuse("UNKNOWN_MODEL");
  if (!catalog.package) return refuse("UNKNOWN_PACKAGE");
  if (!catalog.price) return refuse("NO_PRICE");
  // The packages table's CHECK sets exactly one of the two.
  const length = { days: catalog.days, hours: catalog.hours } as PackageLength;

  const config = await readShopConfig(db);
  // Every closed date from today on, not only to the horizon, because a rental may return past it.
  const closedDates = await readClosedDates(db, jstToday(now), LAST_DATE);
  const windowError = pickupWindowError(config, closedDates, startAt as number, length, now);
  if (windowError !== null) return refuse(windowError);

  const start = startAt as number;
  const endAt = rentalEnd(start, length, config);
  const bufMs = config.turnaroundMinutes * MINUTE_MS;
  const expiresAt = now + config.holdMinutes * MINUTE_MS;
  const ahead = bookedAhead(now, start) ? 1 : 0;
  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt += 1) {
    const ref = randomRef();
    const row = await db
      .prepare(HOLD_SQL)
      .bind(start, endAt, bufMs, now, modelId, id, ref, expiresAt, locale, packageId, ahead)
      .first<BookingRow>();
    if (row !== null) return { ok: true, booking: toBooking(row) };

    // Nothing was inserted. A rival under this id decides it, a taken ref earns another try, and otherwise no bike was free.
    const rival = await getBooking(db, id);
    if (rival !== null) return settle(rival);
    const refTaken = await db.prepare("SELECT 1 FROM bookings WHERE ref = ?1").bind(ref).first();
    if (refTaken === null) break;
  }
  return refuse("SOLD_OUT");
}
