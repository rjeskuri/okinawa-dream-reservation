// The single rule that decides whether two rentals of one vehicle conflict, once in JS and once in SQL, and the rule for
// when a rental ends. docs/data-model.md states both.
import { addDaysToDate, epochToJst, jstToEpoch } from "../time.ts";
import type { BookingStatus, PackageLength, ShopConfig } from "../types.ts";

const HOUR_MS = 3_600_000;

/** Whether a booking holds its vehicle at `now`. A hold stops blocking at its expiry, with no cleanup job. */
export function isBlocking(b: { status: BookingStatus; expiresAt: number | null }, now: number): boolean {
  if (b.status === "CONFIRMED" || b.status === "PAYMENT_PENDING") return true;
  return b.status === "ON_HOLD" && b.expiresAt !== null && b.expiresAt > now;
}

/** Whether two rentals of one vehicle sit closer than `bufMs`, the turnaround buffer. The order of `a` and `b` is free. */
export function conflicts(
  a: { startAt: number; endAt: number },
  b: { startAt: number; endAt: number },
  bufMs: number,
): boolean {
  return b.startAt < a.endAt + bufMs && a.startAt < b.endAt + bufMs;
}

/** A package length the schema can hold: a whole number of at least 1. */
function isLength(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1;
}

/**
 * When a rental ends. A days package returns at shop_close (JST) on the pickup's JST date plus days - 1, so a one-day
 * package returns the same day. An hours package returns `hours` after the pickup, whatever the shop's hours: keeping that
 * inside them is pickupWindowError's. This is the only place a rental's end is computed. A package that does not set
 * exactly one of days and hours, to a whole number of at least 1, is a RangeError.
 */
export function rentalEnd(startAt: number, pkg: PackageLength, config: ShopConfig): number {
  const { days, hours } = pkg;
  if (days === null && isLength(hours)) return startAt + hours * HOUR_MS;
  if (hours !== null || !isLength(days)) throw new RangeError(`not a package length: ${JSON.stringify(pkg)}`);
  const lastDay = addDaysToDate(epochToJst(startAt).date, days - 1);
  return jstToEpoch(lastDay, config.shopClose);
}

// The SQL form of the two functions above. Each fragment reads booking alias `b` and the parameter CTE a statement
// declares once, `WITH q(s, e, buf, now) AS (SELECT ?1, ?2, ?3, ?4)`, because D1 has no named parameters. Scalar
// subqueries read q, so the fragments work where q is not in the FROM clause, such as inside a NOT EXISTS. Both are
// parenthesized to compose with AND.

/** isBlocking(b, q.now). */
export const BLOCKING_SQL =
  "(b.status IN ('CONFIRMED', 'PAYMENT_PENDING') OR (b.status = 'ON_HOLD' AND b.expires_at > (SELECT now FROM q)))";

/** conflicts([q.s, q.e), b, q.buf). */
export const OVERLAP_SQL =
  "(b.start_at < (SELECT e + buf FROM q) AND (SELECT s FROM q) < b.end_at + (SELECT buf FROM q))";
