// Test data for D1-backed tests: one helper per table, with defaults that satisfy every constraint of the schema.
// Each returns what the database stored, snake_case as `SELECT *` gives it, so column defaults are filled in, and
// partials use the same column names. A parent the caller does not name is created; a parent the caller names must
// already exist. Only the D1 API is used, so the helpers work on `createTestDb().db` and on the e2e Worker's `db`.
import { LOCALES } from "../../src/lib/locale.ts";

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export type VehicleTypeRow = { id: string; deposit_jpy: number; sort: number; texts: string };

export type RateClassRow = {
  id: string;
  grp: string;
  sort: number;
  extension_per_hour_jpy: number | null;
  texts: string;
};

export type ModelRow = {
  id: string;
  type_id: string;
  /** NULL only for an e-bike. */
  engine_cc: number | null;
  license_class: string;
  sort: number;
  active: number;
  rate_class_id: string;
  brand: string;
  seats: number | null;
  texts: string;
  photos: string;
};

export type VehicleRow = {
  plate: string;
  model_id: string;
  status: string;
  odometer_km: number | null;
  base_usage_days: number;
};

export type PackageRow = { id: string; days: number | null; hours: number | null; sort: number; texts: string };

/** advance_price_jpy (#131) is nullable and left out unless named, so it takes the column's NULL. */
export type PriceRow = { rate_class_id: string; package_id: string; price_jpy: number; advance_price_jpy?: number | null };

export type TierRow = { min_days_before: number; refund_percent: number };

export type CatalogMetaRow = { id: number; version: number; published_at: number; source: string };

export type BookingRow = {
  id: string;
  ref: string;
  status: string;
  source: string;
  model_id: string;
  package_id: string | null;
  vehicle_plate: string;
  start_at: number;
  end_at: number;
  expires_at: number | null;
  price_jpy: number | null;
  deposit_jpy: number | null;
  catalog_version: number | null;
  locale: string | null;
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
  /** The total refund a staff cancellation settled on (#145), NULL on any other booking. Left out unless named. */
  refund_due_jpy?: number | null;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_TYPE_ID = "motorcycle";
/** 2030-07-15 09:00 JST: fixed, and far enough ahead to stay an upcoming rental for tests that read the real clock. */
const DEFAULT_START_AT = Date.UTC(2030, 6, 15, 0, 0);
const DEFAULT_RENTAL_MS = 8 * HOUR_MS;

const DEFAULT_CONFIG: Record<string, string | number> = {
  shop_open: "09:00",
  shop_close: "18:00",
  slot_minutes: 30,
  turnaround_minutes: 60,
  hold_minutes: 15,
  min_lead_hours: 24,
  max_days_ahead: 180,
  photo_max_mb: 5,
};

const DEFAULT_TIERS: TierRow[] = [
  { min_days_before: 7, refund_percent: 100 },
  { min_days_before: 3, refund_percent: 50 },
  { min_days_before: 0, refund_percent: 0 },
];

let lastId = 0;

/** A value no other helper call in this process returns. */
function unique(prefix: string): string {
  lastId += 1;
  return `${prefix}-${lastId}`;
}

/** The JSON of a `texts` column: the same fields under every locale. */
function localized(fields: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, fields])));
}

/**
 * Inserts `row` and returns it as stored. A column left undefined takes its default. With `upsertKey`, a row that
 * already has that key is updated in place, which keeps the foreign keys pointing at it valid.
 */
export async function insertRow<T>(
  db: D1Database,
  table: string,
  row: Record<string, SqlValue | undefined>,
  upsertKey?: string,
): Promise<T> {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  const columns = entries.map(([column]) => column);
  const params = entries.map((_, index) => `?${index + 1}`);
  const updates = columns.filter((column) => column !== upsertKey).map((column) => `${column} = excluded.${column}`);
  const onConflict = upsertKey === undefined ? "" : ` ON CONFLICT (${upsertKey}) DO UPDATE SET ${updates.join(", ")}`;
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${params.join(", ")})${onConflict} RETURNING *`;
  const stored = await db
    .prepare(sql)
    .bind(...entries.map(([, value]) => value))
    .first<T>();
  if (stored === null) throw new Error(`INSERT INTO ${table} returned no row`);
  return stored;
}

/** Only four type ids can exist, so seeding one again updates it. */
export async function seedType(db: D1Database, partial: Partial<VehicleTypeRow> = {}): Promise<VehicleTypeRow> {
  const row = { id: DEFAULT_TYPE_ID, deposit_jpy: 5000, sort: 0, texts: localized({ name: "Test type" }), ...partial };
  return insertRow<VehicleTypeRow>(db, "vehicle_types", row, "id");
}

/** The default type's id, seeding it only when missing so an earlier seedType keeps its values. */
async function defaultTypeId(db: D1Database): Promise<string> {
  const found = await db.prepare("SELECT id FROM vehicle_types WHERE id = ?1").bind(DEFAULT_TYPE_ID).first();
  if (found === null) await seedType(db);
  return DEFAULT_TYPE_ID;
}

export async function seedRateClass(db: D1Database, partial: Partial<RateClassRow> = {}): Promise<RateClassRow> {
  return insertRow<RateClassRow>(db, "rate_classes", {
    id: unique("rate"),
    grp: "bike",
    sort: 0,
    extension_per_hour_jpy: 1000,
    texts: localized({ name: "Test rate class" }),
    ...partial,
  });
}

export async function seedModel(db: D1Database, partial: Partial<ModelRow> = {}): Promise<ModelRow> {
  const type_id = partial.type_id ?? (await defaultTypeId(db));
  const rate_class_id = partial.rate_class_id ?? (await seedRateClass(db)).id;
  return insertRow<ModelRow>(db, "models", {
    id: unique("model"),
    engine_cc: 125,
    license_class: "small",
    sort: 0,
    active: 1,
    brand: "Test",
    seats: null,
    texts: localized({ name: "Test model", summary: "A summary", description: "A description" }),
    photos: "[]",
    ...partial,
    type_id,
    rate_class_id,
  });
}

export async function seedVehicle(db: D1Database, partial: Partial<VehicleRow> = {}): Promise<VehicleRow> {
  const model_id = partial.model_id ?? (await seedModel(db)).id;
  return insertRow<VehicleRow>(db, "vehicles", {
    plate: unique("plate"),
    status: "active",
    odometer_km: null,
    ...partial,
    model_id,
  });
}

/** A one-day package by default. Naming `hours` alone makes an hours package, since a package has exactly one of them. */
export async function seedPackage(db: D1Database, partial: Partial<PackageRow> = {}): Promise<PackageRow> {
  const hours = partial.hours ?? null;
  return insertRow<PackageRow>(db, "packages", {
    id: unique("package"),
    days: hours === null ? 1 : null,
    hours,
    sort: 0,
    texts: localized({ name: "Test package" }),
    ...partial,
  });
}

export async function seedPrice(db: D1Database, partial: Partial<PriceRow> = {}): Promise<PriceRow> {
  const rate_class_id = partial.rate_class_id ?? (await seedRateClass(db)).id;
  const package_id = partial.package_id ?? (await seedPackage(db)).id;
  return insertRow<PriceRow>(db, "prices", { price_jpy: 8000, ...partial, rate_class_id, package_id });
}

/**
 * Writes every key the shop config needs, `partial` over the defaults, and returns the stored rows as key to value.
 * Keys are the config table's, for example `{ turnaround_minutes: 30 }`. Seeding again updates the keys in place.
 */
export async function seedConfig(
  db: D1Database,
  partial: Record<string, string | number> = {},
): Promise<Record<string, string>> {
  const stored: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...DEFAULT_CONFIG, ...partial })) {
    const row = await insertRow<{ key: string; value: string }>(db, "config", { key, value: String(value) }, "key");
    stored[row.key] = row.value;
  }
  return stored;
}

export async function seedTiers(db: D1Database, tiers: TierRow[] = DEFAULT_TIERS): Promise<TierRow[]> {
  const stored: TierRow[] = [];
  for (const tier of tiers) stored.push(await insertRow<TierRow>(db, "cancellation_tiers", tier, "min_days_before"));
  return stored;
}

/** The table holds one row, so seeding again updates it, as a publish does. */
export async function seedCatalogMeta(db: D1Database, partial: Partial<CatalogMetaRow> = {}): Promise<CatalogMetaRow> {
  const row = { id: 1, version: 1, published_at: DEFAULT_START_AT - DAY_MS, source: "sheet", ...partial };
  return insertRow<CatalogMetaRow>(db, "catalog_meta", row, "id");
}

export async function seedClosedDates(db: D1Database, dates: string[]): Promise<void> {
  for (const date of dates) await insertRow(db, "closed_dates", { date });
}

/** The vehicle and model of a booking: both named, the named vehicle's model, or a new vehicle. */
async function bookingVehicle(
  db: D1Database,
  partial: Partial<BookingRow>,
): Promise<{ vehicle_plate: string; model_id: string }> {
  const { vehicle_plate, model_id } = partial;
  if (vehicle_plate === undefined) {
    const vehicle = await seedVehicle(db, model_id === undefined ? {} : { model_id });
    return { vehicle_plate: vehicle.plate, model_id: vehicle.model_id };
  }
  if (model_id !== undefined) return { vehicle_plate, model_id };
  const found = await db
    .prepare("SELECT model_id FROM vehicles WHERE plate = ?1")
    .bind(vehicle_plate)
    .first<{ model_id: string }>();
  if (found === null) throw new Error(`seedBooking: no vehicle ${vehicle_plate}; seed it first or name model_id too`);
  return { vehicle_plate, model_id: found.model_id };
}

/** A CONFIRMED web booking by default. An ON_HOLD booking needs its own `expires_at`, which defaults to null. */
export async function seedBooking(db: D1Database, partial: Partial<BookingRow> = {}): Promise<BookingRow> {
  const { vehicle_plate, model_id } = await bookingVehicle(db, partial);
  const start_at = partial.start_at ?? DEFAULT_START_AT;
  return insertRow<BookingRow>(db, "bookings", {
    id: unique("booking"),
    ref: unique("REF"),
    status: "CONFIRMED",
    source: "web",
    package_id: null,
    start_at,
    end_at: start_at + DEFAULT_RENTAL_MS,
    expires_at: null,
    price_jpy: 12000,
    deposit_jpy: 5000,
    catalog_version: 1,
    locale: "en",
    guest_family_name: "Test",
    guest_given_name: "Guest",
    guest_email: "guest@example.com",
    guest_phone: "+81-90-0000-0000",
    created_at: start_at - DAY_MS,
    updated_at: start_at - DAY_MS,
    ...partial,
    vehicle_plate,
    model_id,
  });
}
