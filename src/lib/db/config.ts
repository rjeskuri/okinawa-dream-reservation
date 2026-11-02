// Readers for the published settings: the shop config, closed dates and refund tiers.
import { parseHHmm } from "../time.ts";
import type { CancellationTier, ShopConfig } from "../types.ts";

const WHOLE_NUMBER = /^\d+$/;
const DECIMAL_NUMBER = /^\d+(\.\d+)?$/;

/** The site has nothing to read until the first publish fills the config table. */
export class CatalogNotPublished extends Error {
  constructor() {
    super("no catalog has been published");
    this.name = "CatalogNotPublished";
  }
}

/**
 * The number written in `value`, which must match `pattern`. Number alone reads "" as 0, parseInt reads "30 min" as 30,
 * and a NaN that reached a ShopConfig would make `conflicts` return false for a real overlap.
 */
function parseNumber(key: string, value: string, pattern: RegExp): number {
  const parsed = Number(value);
  if (!pattern.test(value) || !Number.isFinite(parsed)) {
    throw new Error(`config ${key} is not a valid number: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** The config table as a ShopConfig. Throws CatalogNotPublished when it is empty, and an Error on a bad or missing key. */
export async function readShopConfig(db: D1Database): Promise<ShopConfig> {
  const { results } = await db.prepare("SELECT key, value FROM config").all<{ key: string; value: string }>();
  if (results.length === 0) throw new CatalogNotPublished();

  const stored = new Map(results.map(({ key, value }) => [key, value]));
  const text = (key: string): string => {
    const value = stored.get(key);
    if (value === undefined) throw new Error(`config has no ${key}`);
    return value;
  };
  const time = (key: string): string => {
    const value = text(key);
    parseHHmm(value);
    return value;
  };
  const whole = (key: string): number => parseNumber(key, text(key), WHOLE_NUMBER);

  return {
    shopOpen: time("shop_open"),
    shopClose: time("shop_close"),
    slotMinutes: whole("slot_minutes"),
    turnaroundMinutes: whole("turnaround_minutes"),
    holdMinutes: whole("hold_minutes"),
    minLeadHours: whole("min_lead_hours"),
    maxDaysAhead: whole("max_days_ahead"),
    photoMaxMb: parseNumber("photo_max_mb", text("photo_max_mb"), DECIMAL_NUMBER),
  };
}

/** The closed dates from `from` to `to`, both YYYY-MM-DD and both included, earliest first. */
export async function readClosedDates(db: D1Database, from: string, to: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT date FROM closed_dates WHERE date >= ?1 AND date <= ?2 ORDER BY date")
    .bind(from, to)
    .all<{ date: string }>();
  return results.map(({ date }) => date);
}

/** The refund tiers, highest min_days_before first. */
export async function readCancellationTiers(db: D1Database): Promise<CancellationTier[]> {
  const { results } = await db
    .prepare("SELECT min_days_before, refund_percent FROM cancellation_tiers ORDER BY min_days_before DESC")
    .all<{ min_days_before: number; refund_percent: number }>();
  return results.map((row) => ({ minDaysBefore: row.min_days_before, refundPercent: row.refund_percent }));
}
