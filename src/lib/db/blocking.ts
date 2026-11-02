// The single rule that decides whether two rentals of one vehicle conflict, once in JS and once in SQL, and the rule for
// when a rental ends. docs/data-model.md states both.
import { addDaysToDate, epochToJst, jstToEpoch } from "../time.ts";
import type { BookingStatus, ShopConfig } from "../types.ts";

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

/**
 * When a rental of a days package ends: shop_close (JST) on the pickup's JST date plus days - 1, so a one-day package
 * returns the same day. This is the only place a rental's end is computed. An hours package has no end rule yet.
 */
export function rentalEnd(startAt: number, pkg: { days: number }, config: ShopConfig): number {
  if (!Number.isInteger(pkg.days) || pkg.days < 1) throw new RangeError(`not a days package: ${JSON.stringify(pkg)}`);
  const lastDay = addDaysToDate(epochToJst(startAt).date, pkg.days - 1);
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
