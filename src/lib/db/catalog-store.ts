// The catalog store: replaceCatalog writes a whole publish in one D1 batch, and readCatalog reads it back for pages and
// bookings. Nothing here knows about Sheets, so a later admin panel writes through the same function. docs/data-model.md
// says what a publish keeps.
import { BLOCKING_SQL } from "./blocking.ts";
import { parseShopConfig } from "./config.ts";
import type {
  CancellationTier,
  Catalog,
  Model,
  Option,
  Package,
  Price,
  RateClass,
  ShopConfig,
  Vehicle,
  VehicleType,
} from "../types.ts";

export type PublishedCatalog = Catalog & { version: number; publishedAt: number };

export type AffectedBooking = { bookingId: string; ref: string; plate: string; startAt: number };

export type ReplaceResult = {
  version: number;
  /** Plates this publish took from a non-retired status to 'retired'. */
  retiredVehicles: string[];
  /** Models this publish took from active to inactive. */
  deactivatedModels: string[];
  /** Blocking bookings that end after now, on a vehicle whose status is no longer 'active'. */
  affectedBookings: AffectedBooking[];
};

/**
 * A catalog table: each column and the field that holds it on the domain type. Each list goes to its statement as one JSON
 * parameter, so a table of any size stays within D1's 100 bound parameters. With `key`, inserts update existing rows.
 */
type Table = { name: string; columns: Record<string, string>; order: string; key?: string };

const VEHICLE_TYPES: Table = {
  name: "vehicle_types",
  columns: { id: "id", deposit_jpy: "depositJpy", sort: "sort", texts: "texts" },
  order: "sort, id",
  key: "id",
};

const RATE_CLASSES: Table = {
  name: "rate_classes",
  columns: { id: "id", grp: "grp", sort: "sort", extension_per_hour_jpy: "extensionPerHourJpy", texts: "texts" },
  order: "sort, id",
  key: "id",
};

const MODELS: Table = {
  name: "models",
  columns: {
    id: "id",
    type_id: "typeId",
    engine_cc: "engineCc",
    license_class: "licenseClass",
    sort: "sort",
    active: "active",
    rate_class_id: "rateClassId",
    brand: "brand",
    seats: "seats",
    texts: "texts",
    photos: "photos",
  },
  order: "sort, id",
  key: "id",
};

const VEHICLES: Table = {
  name: "vehicles",
  columns: {
    plate: "plate",
    model_id: "modelId",
    status: "status",
    odometer_km: "odometerKm",
    base_usage_days: "baseUsageDays",
  },
  order: "plate",
  key: "plate",
};

const PACKAGES: Table = {
  name: "packages",
  columns: { id: "id", days: "days", hours: "hours", sort: "sort", texts: "texts" },
  order: "sort, id",
};

const PRICES: Table = {
  name: "prices",
  columns: { rate_class_id: "rateClassId", package_id: "packageId", price_jpy: "priceJpy" },
  order: "rate_class_id, package_id",
};

const OPTIONS: Table = {
  name: "options",
  columns: {
    id: "id",
    grp: "grp",
    sort: "sort",
    base_jpy: "baseJpy",
    extra_per_hour_jpy: "extraPerHourJpy",
    extra_per_24h_jpy: "extraPer24hJpy",
    texts: "texts",
  },
  order: "sort, id",
};

const TIERS: Table = {
  name: "cancellation_tiers",
  columns: { min_days_before: "minDaysBefore", refund_percent: "refundPercent" },
  order: "min_days_before DESC",
};

/** Inserts the rows of the JSON array in ?1. The `WHERE true` keeps SQLite from reading ON CONFLICT as a join constraint. */
function insertSql({ name, columns, key }: Table): string {
  const names = Object.keys(columns);
  const fields = Object.values(columns).map((field) => `json_extract(value, '$.${field}')`);
  const updates = names.filter((column) => column !== key).map((column) => `${column} = excluded.${column}`);
  const upsert = key === undefined ? "" : ` ON CONFLICT (${key}) DO UPDATE SET ${updates.join(", ")}`;
  return `INSERT INTO ${name} (${names.join(", ")}) SELECT ${fields.join(", ")} FROM json_each(?1) WHERE true${upsert}`;
}

function selectSql({ name, columns, order }: Table): string {
  const aliased = Object.entries(columns).map(([column, field]) => `${column} AS ${field}`);
  return `SELECT ${aliased.join(", ")} FROM ${name} ORDER BY ${order}`;
}

// The two reports run first in the batch, so they compare the rows as they stand with the catalog in ?1, in the same
// transaction as the writes. A row is listed when it is not yet retired or inactive and the catalog either leaves it out
// or marks it so. A row new in this catalog has no earlier state, so it is never listed.
const RETIRING_SQL = `SELECT plate FROM vehicles WHERE status <> 'retired' AND plate NOT IN (
  SELECT json_extract(value, '$.plate') FROM json_each(?1) WHERE json_extract(value, '$.status') <> 'retired'
) ORDER BY plate`;

const DEACTIVATING_SQL = `SELECT id FROM models WHERE active = 1 AND id NOT IN (
  SELECT json_extract(value, '$.id') FROM json_each(?1) WHERE json_extract(value, '$.active') = 1
) ORDER BY id`;

const DEACTIVATE_MISSING_SQL = `UPDATE models SET active = 0 WHERE active = 1 AND id NOT IN (
  SELECT json_extract(value, '$.id') FROM json_each(?1)
)`;

const RETIRE_MISSING_SQL = `UPDATE vehicles SET status = 'retired' WHERE status <> 'retired' AND plate NOT IN (
  SELECT json_extract(value, '$.plate') FROM json_each(?1)
)`;

// A row the catalog no longer names leaves unless a model, kept inactive ones included, still references it. These need
// the models and prices already written, since this same publish may be what lets go of the row.
const DROP_RATE_CLASSES_SQL = `DELETE FROM rate_classes WHERE id NOT IN (
  SELECT json_extract(value, '$.id') FROM json_each(?1)
) AND id NOT IN (SELECT rate_class_id FROM models)`;

const DROP_VEHICLE_TYPES_SQL = `DELETE FROM vehicle_types WHERE id NOT IN (
  SELECT json_extract(value, '$.id') FROM json_each(?1)
) AND id NOT IN (SELECT type_id FROM models)`;

const INSERT_CONFIG_SQL = "INSERT INTO config (key, value) SELECT key, value FROM json_each(?1)";

const INSERT_CLOSED_DATES_SQL = "INSERT INTO closed_dates (date) SELECT value FROM json_each(?1)";

const BUMP_VERSION_SQL = `INSERT INTO catalog_meta (id, version, published_at, source) VALUES (1, 1, ?1, ?2)
ON CONFLICT (id) DO UPDATE SET version = catalog_meta.version + 1, published_at = excluded.published_at, source = excluded.source
RETURNING version`;

// Inside the batch and not after it: a failed read after the batch would reject a publish that had already landed.
const AFFECTED_SQL = `WITH q(now) AS (SELECT ?1)
SELECT b.id AS bookingId, b.ref AS ref, b.vehicle_plate AS plate, b.start_at AS startAt
FROM bookings b JOIN vehicles v ON v.plate = b.vehicle_plate
WHERE v.status <> 'active' AND b.end_at > (SELECT now FROM q) AND ${BLOCKING_SQL}
ORDER BY b.start_at, b.id`;

/** The config table's rows, as an object json_each expands into key and value. */
function configRows(config: ShopConfig): Record<string, string> {
  return {
    shop_open: config.shopOpen,
    shop_close: config.shopClose,
    slot_minutes: String(config.slotMinutes),
    turnaround_minutes: String(config.turnaroundMinutes),
    hold_minutes: String(config.holdMinutes),
    min_lead_hours: String(config.minLeadHours),
    max_days_ahead: String(config.maxDaysAhead),
    photo_max_mb: String(config.photoMaxMb),
  };
}

/**
 * Replaces the catalog in one atomic batch: a failure on any statement leaves the previous catalog and version. Models
 * and vehicles are never deleted: those missing from `catalog` stay, as inactive and retired, with their bookings.
 */
export async function replaceCatalog(
  db: D1Database,
  catalog: Catalog,
  { now, source }: { now: number; source: "sheet" | "admin" },
): Promise<ReplaceResult> {
  const withList = (sql: string, list: unknown) => db.prepare(sql).bind(JSON.stringify(list));

  const results = await db.batch([
    withList(RETIRING_SQL, catalog.vehicles),
    withList(DEACTIVATING_SQL, catalog.models),
    // D1 enforces foreign keys at each statement, so parents go before children.
    withList(insertSql(VEHICLE_TYPES), catalog.vehicleTypes),
    withList(insertSql(RATE_CLASSES), catalog.rateClasses),
    withList(insertSql(MODELS), catalog.models),
    withList(DEACTIVATE_MISSING_SQL, catalog.models),
    withList(insertSql(VEHICLES), catalog.vehicles),
    withList(RETIRE_MISSING_SQL, catalog.vehicles),
    db.prepare("DELETE FROM prices"),
    db.prepare("DELETE FROM packages"),
    withList(insertSql(PACKAGES), catalog.packages),
    withList(insertSql(PRICES), catalog.prices),
    withList(DROP_RATE_CLASSES_SQL, catalog.rateClasses),
    withList(DROP_VEHICLE_TYPES_SQL, catalog.vehicleTypes),
    db.prepare("DELETE FROM options"),
    withList(insertSql(OPTIONS), catalog.options),
    db.prepare("DELETE FROM config"),
    withList(INSERT_CONFIG_SQL, configRows(catalog.config)),
    db.prepare("DELETE FROM cancellation_tiers"),
    withList(insertSql(TIERS), catalog.cancellationTiers),
    db.prepare("DELETE FROM closed_dates"),
    withList(INSERT_CLOSED_DATES_SQL, catalog.closedDates),
    db.prepare(BUMP_VERSION_SQL).bind(now, source),
    db.prepare(AFFECTED_SQL).bind(now),
  ]);

  const [retiring, deactivating] = results;
  const [bumped, affected] = results.slice(-2);
  return {
    version: (bumped.results as { version: number }[])[0].version,
    retiredVehicles: (retiring.results as { plate: string }[]).map(({ plate }) => plate),
    deactivatedModels: (deactivating.results as { id: string }[]).map(({ id }) => id),
    affectedBookings: affected.results as AffectedBooking[],
  };
}

const READ_CATALOG_SQL = [
  "SELECT version, published_at AS publishedAt FROM catalog_meta",
  "SELECT key, value FROM config",
  selectSql(VEHICLE_TYPES),
  selectSql(RATE_CLASSES),
  selectSql(MODELS),
  selectSql(VEHICLES),
  selectSql(PACKAGES),
  selectSql(PRICES),
  selectSql(OPTIONS),
  selectSql(TIERS),
  "SELECT date FROM closed_dates ORDER BY date",
];

/** A result's rows with their `texts` JSON decoded. */
function decodeTexts<T>(result: D1Result): T[] {
  return (result.results as { texts: string }[]).map((row) => ({ ...row, texts: JSON.parse(row.texts) }) as T);
}

/**
 * The published catalog, or null before the first publish: only catalog_meta records one. Holds every row in the tables,
 * including models and vehicles a publish kept as inactive or retired, so callers filter.
 */
export async function readCatalog(db: D1Database): Promise<PublishedCatalog | null> {
  const [meta, config, vehicleTypes, rateClasses, models, vehicles, packages, prices, options, tiers, closedDates] =
    await db.batch(READ_CATALOG_SQL.map((sql) => db.prepare(sql)));

  const [published] = meta.results as { version: number; publishedAt: number }[];
  if (published === undefined) return null;

  type ModelRow = Omit<Model, "active" | "photos"> & { active: number; photos: string };
  return {
    config: parseShopConfig(config.results as { key: string; value: string }[]),
    vehicleTypes: decodeTexts<VehicleType>(vehicleTypes),
    rateClasses: decodeTexts<RateClass>(rateClasses),
    models: decodeTexts<ModelRow>(models).map((row) => ({
      ...row,
      active: row.active === 1,
      photos: JSON.parse(row.photos) as string[],
    })),
    vehicles: vehicles.results as Vehicle[],
    packages: decodeTexts<Package>(packages),
    prices: prices.results as Price[],
    options: decodeTexts<Option>(options),
    cancellationTiers: tiers.results as CancellationTier[],
    closedDates: (closedDates.results as { date: string }[]).map(({ date }) => date),
    version: published.version,
    publishedAt: published.publishedAt,
  };
}
