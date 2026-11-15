// Per-model availability for a pickup and a package: which models have a free bike, how many, and at what price.
// Pickup-window validation (shop hours, slots, closed dates, lead time) is the caller's, before this runs.
import { BLOCKING_SQL, OVERLAP_SQL, rentalEnd } from "../db/blocking.ts";
import { readShopConfig } from "../db/config.ts";
import { bookedAhead } from "../pricing.ts";
import type { VehicleTypeId } from "../types.ts";

export type CcBand = "upto50" | "51to125" | "126to400" | "over400";

export type AvailabilityQuery = {
  startAt: number;
  packageId: string;
  typeId?: VehicleTypeId;
  ccBand?: CcBand;
  now: number;
};

export type AvailableModel = { modelId: string; vacancies: number; priceJpy: number; depositJpy: number };

const MINUTE_MS = 60_000;

/** Engine sizes in cc, both ends included, one band per bike license class: moped, small, standard, large. */
export const CC_BANDS: Record<CcBand, [min: number, max: number]> = {
  upto50: [1, 50],
  "51to125": [51, 125],
  "126to400": [126, 400],
  over400: [401, Number.MAX_SAFE_INTEGER],
};

// ?1 to ?4 are q(s, e, buf, now), then ?5 the package, ?6 the type and ?7, ?8 the band's ends. A null ?6 or ?7 turns its
// filter off. ?9 is 1 for a search made ahead of the pickup's JST date, which prices it as a hold would (#131). The joins to
// prices and vehicles drop a model with no price or no free active bike, so vacancies >= 1.
const SEARCH_SQL = `
WITH q(s, e, buf, now) AS (SELECT ?1, ?2, ?3, ?4)
SELECT m.id AS modelId, COUNT(*) AS vacancies,
  CASE WHEN ?9 = 1 AND p.advance_price_jpy IS NOT NULL THEN p.advance_price_jpy ELSE p.price_jpy END AS priceJpy,
  t.deposit_jpy AS depositJpy
FROM models m
JOIN prices p ON p.rate_class_id = m.rate_class_id AND p.package_id = ?5
JOIN vehicle_types t ON t.id = m.type_id
JOIN vehicles v ON v.model_id = m.id AND v.status = 'active'
WHERE m.active = 1
  AND (?6 IS NULL OR m.type_id = ?6)
  AND (?7 IS NULL OR (m.type_id <> 'car' AND m.engine_cc BETWEEN ?7 AND ?8))
  AND NOT EXISTS (
    SELECT 1 FROM bookings b WHERE b.vehicle_plate = v.plate AND ${BLOCKING_SQL} AND ${OVERLAP_SQL}
  )
GROUP BY m.id
ORDER BY m.sort, m.id`;

/**
 * The models with at least one free bike for `q`, by model sort, then id. An unknown package and an hours package,
 * which has no end rule until task #50, return nothing. Throws CatalogNotPublished before the first publish, whatever
 * the package, so a site with no catalog is not mistaken for a sold-out one.
 */
export async function searchAvailability(db: D1Database, q: AvailabilityQuery): Promise<AvailableModel[]> {
  const [config, pkg] = await Promise.all([
    readShopConfig(db),
    db.prepare("SELECT days FROM packages WHERE id = ?1").bind(q.packageId).first<{ days: number | null }>(),
  ]);
  if (pkg === null || pkg.days === null) return [];

  const endAt = rentalEnd(q.startAt, { days: pkg.days }, config);
  const bufMs = config.turnaroundMinutes * MINUTE_MS;
  const [minCc, maxCc] = q.ccBand === undefined ? [null, null] : CC_BANDS[q.ccBand];
  const ahead = bookedAhead(q.now, q.startAt) ? 1 : 0;
  const { results } = await db
    .prepare(SEARCH_SQL)
    .bind(q.startAt, endAt, bufMs, q.now, q.packageId, q.typeId ?? null, minCc, maxCc, ahead)
    .all<AvailableModel>();
  return results;
}
