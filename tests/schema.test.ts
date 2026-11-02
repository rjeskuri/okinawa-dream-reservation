// The core schema of migrations/0002_core.sql, read back through D1, and the config readers on top of it. Expected
// columns and constraint cases are written out from the ticket's table definitions, never read from the migration.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { CancellationTier } from "../src/lib/types.ts";
import { createTestDb } from "./helpers/d1.ts";
import {
  insertRow,
  seedBooking,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedTiers,
  seedType,
  seedVehicle,
} from "./helpers/seed.ts";
import type { SqlRow, SqlValue, TierRow } from "./helpers/seed.ts";

/** Loaded where it is needed, so the schema tests run, and fail on the schema alone, whether or not this module does. */
const configModule = () => import("../src/lib/db/config.ts");

// Each column as `name TYPE`, then NOT NULL and DEFAULT as declared. A primary-key column reads PRIMARY KEY instead of
// NOT NULL, because SQLite implies it for some primary keys and not for others.
const TABLES: Record<string, string[]> = {
  catalog_meta: ["id INTEGER PRIMARY KEY", "version INTEGER NOT NULL", "published_at INTEGER NOT NULL", "source TEXT NOT NULL"],
  vehicle_types: ["id TEXT PRIMARY KEY", "deposit_jpy INTEGER NOT NULL", "sort INTEGER NOT NULL", "texts TEXT NOT NULL"],
  models: [
    "id TEXT PRIMARY KEY",
    "type_id TEXT NOT NULL",
    "engine_cc INTEGER NOT NULL",
    "license_class TEXT NOT NULL",
    "sort INTEGER NOT NULL",
    "active INTEGER NOT NULL",
    "rate_class_id TEXT NOT NULL",
    "brand TEXT NOT NULL",
    "seats INTEGER",
    "texts TEXT NOT NULL",
    "photos TEXT NOT NULL",
  ],
  rate_classes: [
    "id TEXT PRIMARY KEY",
    "grp TEXT NOT NULL",
    "sort INTEGER NOT NULL",
    "extension_per_hour_jpy INTEGER",
    "texts TEXT NOT NULL",
  ],
  packages: ["id TEXT PRIMARY KEY", "days INTEGER", "hours INTEGER", "sort INTEGER NOT NULL", "texts TEXT NOT NULL"],
  prices: ["rate_class_id TEXT PRIMARY KEY", "package_id TEXT PRIMARY KEY", "price_jpy INTEGER NOT NULL"],
  options: [
    "id TEXT PRIMARY KEY",
    "grp TEXT NOT NULL",
    "sort INTEGER NOT NULL",
    "base_jpy INTEGER NOT NULL",
    "extra_per_hour_jpy INTEGER",
    "extra_per_24h_jpy INTEGER",
    "texts TEXT NOT NULL",
  ],
  vehicles: [
    "plate TEXT PRIMARY KEY",
    "model_id TEXT NOT NULL",
    "status TEXT NOT NULL",
    "odometer_km INTEGER",
    "base_usage_days INTEGER NOT NULL DEFAULT 0",
  ],
  config: ["key TEXT PRIMARY KEY", "value TEXT NOT NULL"],
  cancellation_tiers: ["min_days_before INTEGER PRIMARY KEY", "refund_percent INTEGER NOT NULL"],
  closed_dates: ["date TEXT PRIMARY KEY"],
  bookings: [
    "id TEXT PRIMARY KEY",
    "ref TEXT NOT NULL",
    "status TEXT NOT NULL",
    "source TEXT NOT NULL",
    "model_id TEXT NOT NULL",
    "package_id TEXT",
    "vehicle_plate TEXT NOT NULL",
    "start_at INTEGER NOT NULL",
    "end_at INTEGER NOT NULL",
    "expires_at INTEGER",
    "price_jpy INTEGER",
    "deposit_jpy INTEGER",
    "catalog_version INTEGER",
    "locale TEXT",
    "guest_family_name TEXT",
    "guest_given_name TEXT",
    "guest_email TEXT",
    "guest_phone TEXT",
    "external_ref TEXT",
    "external_channel TEXT",
    "content_hash TEXT",
    "payment_id TEXT",
    "payment_attempt INTEGER NOT NULL DEFAULT 0",
    "paid_jpy INTEGER NOT NULL DEFAULT 0",
    "cancel_reason TEXT",
    "created_at INTEGER NOT NULL",
    "updated_at INTEGER NOT NULL",
    "confirmed_at INTEGER",
    "cancelled_at INTEGER",
  ],
  refunds: [
    "id TEXT PRIMARY KEY",
    "booking_id TEXT NOT NULL",
    "square_refund_id TEXT",
    "amount_jpy INTEGER NOT NULL",
    "status TEXT NOT NULL",
    "origin TEXT NOT NULL",
    "idempotency_key TEXT",
    "created_at INTEGER NOT NULL",
    "updated_at INTEGER NOT NULL",
  ],
  outbox: [
    "id INTEGER PRIMARY KEY",
    "kind TEXT NOT NULL",
    "dedupe_key TEXT NOT NULL",
    "payload TEXT NOT NULL",
    "status TEXT NOT NULL",
    "attempts INTEGER NOT NULL DEFAULT 0",
    "next_attempt_at INTEGER NOT NULL",
    "claimed_at INTEGER",
    "last_error TEXT",
    "created_at INTEGER NOT NULL",
  ],
  webhook_events: ["event_id TEXT PRIMARY KEY", "type TEXT NOT NULL", "received_at INTEGER NOT NULL"],
  photos: [
    "name TEXT PRIMARY KEY",
    "drive_file_id TEXT NOT NULL",
    "md5 TEXT NOT NULL",
    "r2_key TEXT NOT NULL",
    "content_type TEXT NOT NULL",
    "bytes INTEGER NOT NULL",
    "copied_at INTEGER NOT NULL",
  ],
  kv_cache: ["key TEXT PRIMARY KEY", "value TEXT NOT NULL", "expires_at INTEGER NOT NULL"],
};

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function describeColumn(column: ColumnInfo): string {
  const required = column.pk > 0 ? " PRIMARY KEY" : column.notnull === 1 ? " NOT NULL" : "";
  const fallback = column.dflt_value === null ? "" : ` DEFAULT ${column.dflt_value}`;
  return `${column.name} ${column.type.toUpperCase()}${required}${fallback}`;
}

test("migrations apply to an empty database and create every table", async () => {
  const files = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(files.slice(0, 2), ["0001_init.sql", "0002_core.sql"]);

  const { db, dispose } = await createTestDb();
  try {
    const master = await db.prepare("SELECT type, name FROM sqlite_master").all<{ type: string; name: string }>();
    const tables = master.results.filter((row) => row.type === "table").map((row) => row.name);
    for (const table of ["cron_runs", "meta", ...Object.keys(TABLES)]) {
      assert.ok(tables.includes(table), `no table ${table} in ${tables.join(", ")}`);
    }
    assert.deepEqual(master.results.filter((row) => row.type === "trigger"), [], "migrations contain no triggers");

    for (const [table, expected] of Object.entries(TABLES)) {
      const info = await db.prepare(`PRAGMA table_info(${table})`).all<ColumnInfo>();
      const actual = info.results.map(describeColumn);
      for (const column of expected) {
        assert.ok(actual.includes(column), `${table} has no column "${column}": ${actual.join(", ")}`);
      }
    }
  } finally {
    await dispose();
  }
});

type ConstraintKind = "CHECK" | "FOREIGN KEY" | "UNIQUE";

interface ConstraintCase {
  name: string;
  table: string;
  error: ConstraintKind;
  /** Changes to the table's valid row that the constraint refuses. */
  reject: SqlRow[];
  /** Changes to the same row that it lets through, so the refusal can only be about what differs. */
  accept: SqlRow[];
}

const START = Date.parse("2026-08-10T09:00:00+09:00");
const END = Date.parse("2026-08-10T18:00:00+09:00");

const TYPE_ID = "motorcycle";
const RATE_ID = "parent-rate";
const OTHER_RATE_ID = "parent-rate-2";
const PACKAGE_ID = "parent-package";
const MODEL_ID = "parent-model";
const PLATE = "parent-plate";
const BOOKING_ID = "parent-booking";
const TAKEN_REF = "TAKEN-REF";
const TAKEN_SQUARE_ID = "taken-square-refund";
const TAKEN_IDEMPOTENCY_KEY = "taken-idempotency-key";
const TAKEN_DEDUPE_KEY = "taken-dedupe-key";

/** One row each table accepts, leaving out what is nullable or defaulted, and the columns that identify it. */
const VALID: Record<string, { key: string[]; row: SqlRow }> = {
  catalog_meta: { key: ["id"], row: { id: 1, version: 3, published_at: START, source: "sheet" } },
  vehicle_types: { key: ["id"], row: { id: "scooter", deposit_jpy: 3000, sort: 1, texts: "{}" } },
  rate_classes: { key: ["id"], row: { id: "case-rate", grp: "bike", sort: 1, texts: "{}" } },
  packages: { key: ["id"], row: { id: "case-package", days: 3, hours: null, sort: 1, texts: "{}" } },
  options: { key: ["id"], row: { id: "case-option", grp: "car", sort: 1, base_jpy: 500, texts: "{}" } },
  cancellation_tiers: { key: ["min_days_before"], row: { min_days_before: 3, refund_percent: 50 } },
  models: {
    key: ["id"],
    row: {
      id: "case-model",
      type_id: TYPE_ID,
      engine_cc: 125,
      license_class: "small",
      sort: 1,
      active: 1,
      rate_class_id: RATE_ID,
      brand: "Case",
      texts: "{}",
      photos: "[]",
    },
  },
  prices: {
    key: ["rate_class_id", "package_id"],
    row: { rate_class_id: OTHER_RATE_ID, package_id: PACKAGE_ID, price_jpy: 8000 },
  },
  vehicles: { key: ["plate"], row: { plate: "case-plate", model_id: MODEL_ID, status: "active" } },
  bookings: {
    key: ["id"],
    row: {
      id: "case-booking",
      ref: "CASE-REF",
      status: "CONFIRMED",
      source: "web",
      model_id: MODEL_ID,
      vehicle_plate: PLATE,
      start_at: START,
      end_at: END,
      created_at: START,
      updated_at: START,
    },
  },
  refunds: {
    key: ["id"],
    row: {
      id: "case-refund",
      booking_id: BOOKING_ID,
      amount_jpy: 1000,
      status: "PENDING",
      origin: "cancel",
      created_at: START,
      updated_at: START,
    },
  },
  outbox: {
    key: ["dedupe_key"],
    row: { kind: "email", dedupe_key: "case-dedupe", payload: "{}", status: "pending", next_attempt_at: START, created_at: START },
  },
};

/** A constraint on one column: `rejected` values fail with `error`, and `accepted` values, its edges, go in. */
function column(
  table: string,
  name: string,
  rejected: SqlValue[],
  accepted: SqlValue[],
  error: ConstraintKind = "CHECK",
): ConstraintCase {
  return {
    name: `${table}.${name} (${error})`,
    table,
    error,
    reject: rejected.map((value) => ({ [name]: value })),
    accept: accepted.map((value) => ({ [name]: value })),
  };
}

// Tables with no parents. These run on an empty database: vehicle_types takes each of its three ids in turn.
const STANDALONE_CASES: ConstraintCase[] = [
  column("catalog_meta", "id", [0, 2], [1]),
  column("catalog_meta", "source", ["api", "SHEET"], ["sheet", "admin"]),
  column("vehicle_types", "id", ["truck", "Car"], ["scooter", "motorcycle", "car"]),
  column("vehicle_types", "deposit_jpy", [-1, -5000], [0, 1]),
  column("rate_classes", "grp", ["boat", "Bike"], ["bike", "car"]),
  column("rate_classes", "extension_per_hour_jpy", [-1], [0, 1, null]),
  column("packages", "days", [0, 61, -1], [1, 60]),
  {
    name: "packages.hours (CHECK)",
    table: "packages",
    error: "CHECK",
    reject: [
      { days: null, hours: 0 },
      { days: null, hours: 73 },
    ],
    accept: [
      { days: null, hours: 1 },
      { days: null, hours: 72 },
    ],
  },
  {
    name: "packages has exactly one of days and hours (CHECK)",
    table: "packages",
    error: "CHECK",
    reject: [
      { days: null, hours: null },
      { days: 3, hours: 24 },
    ],
    accept: [
      { days: 3, hours: null },
      { days: null, hours: 24 },
    ],
  },
  column("options", "grp", ["boat", "Car"], ["bike", "car"]),
  column("options", "base_jpy", [-1], [0, 1]),
  column("options", "extra_per_hour_jpy", [-1], [0, 1, null]),
  column("options", "extra_per_24h_jpy", [-1], [0, 1, null]),
  column("cancellation_tiers", "min_days_before", [-1], [0, 1]),
  column("cancellation_tiers", "refund_percent", [-1, 101], [0, 100]),
];

// Tables that reference others, run once seedParents has written what the valid rows point at.
const CHILD_CASES: ConstraintCase[] = [
  column("models", "type_id", ["scooter"], [TYPE_ID], "FOREIGN KEY"),
  column("models", "rate_class_id", ["no-such-class"], [RATE_ID], "FOREIGN KEY"),
  column("models", "engine_cc", [0, -125], [1, 125]),
  column("models", "license_class", ["medium", "Small"], ["moped", "small", "standard", "large", "car"]),
  column("models", "active", [2, -1], [0, 1]),
  column("models", "seats", [0, -2], [1, 5, null]),

  column("prices", "rate_class_id", ["no-such-class"], [OTHER_RATE_ID], "FOREIGN KEY"),
  column("prices", "package_id", ["no-such-package"], [PACKAGE_ID], "FOREIGN KEY"),
  column("prices", "price_jpy", [0, -1], [1, 8000]),
  {
    name: "prices primary key (UNIQUE)",
    table: "prices",
    error: "UNIQUE",
    reject: [{ rate_class_id: RATE_ID, package_id: PACKAGE_ID }],
    accept: [{ rate_class_id: OTHER_RATE_ID, package_id: PACKAGE_ID }],
  },

  column("vehicles", "model_id", ["no-such-model"], [MODEL_ID], "FOREIGN KEY"),
  column("vehicles", "status", ["sold", "ACTIVE"], ["active", "maintenance", "retired"]),

  column("bookings", "status", ["HOLD", "on_hold", ""], ["ON_HOLD", "PAYMENT_PENDING", "CONFIRMED", "CANCELLED", "EXPIRED"]),
  column("bookings", "source", ["phone", "WEB"], ["web", "block"]),
  column("bookings", "model_id", ["no-such-model"], [MODEL_ID], "FOREIGN KEY"),
  column("bookings", "vehicle_plate", ["no-such-plate"], [PLATE], "FOREIGN KEY"),
  column("bookings", "paid_jpy", [-1, -5000], [0, 1]),
  // A ruling on this ticket: its table definition left these two without a CHECK, yet negative money is refused. Null
  // stays valid, because a block booking carries no price.
  column("bookings", "price_jpy", [-1, -12000], [0, 1, null]),
  column("bookings", "deposit_jpy", [-1, -5000], [0, 1, null]),
  column("bookings", "end_at", [START, START - 1, START - 86_400_000], [START + 1, END]),
  column("bookings", "ref", [TAKEN_REF], ["FREE-REF"], "UNIQUE"),
  // A package can leave the catalog while bookings of it remain, so this column is deliberately not a foreign key.
  { name: "bookings.package_id takes any value", table: "bookings", error: "CHECK", reject: [], accept: [{ package_id: "gone" }] },

  column("refunds", "booking_id", ["no-such-booking"], [BOOKING_ID], "FOREIGN KEY"),
  column("refunds", "amount_jpy", [0, -1], [1, 5000]),
  column("refunds", "status", ["DONE", "pending"], ["PENDING", "COMPLETED", "REJECTED", "FAILED", "RETRY"]),
  column("refunds", "origin", ["admin", "CANCEL"], ["cancel", "dashboard"]),
  column("refunds", "square_refund_id", [TAKEN_SQUARE_ID], ["free-square-refund", null], "UNIQUE"),
  column("refunds", "idempotency_key", [TAKEN_IDEMPOTENCY_KEY], ["free-idempotency-key", null], "UNIQUE"),

  column("outbox", "kind", ["sms", "EMAIL"], ["email", "sheet_booking"]),
  column("outbox", "status", ["failed", "PENDING"], ["pending", "sending", "sent", "dead"]),
  column("outbox", "dedupe_key", [TAKEN_DEDUPE_KEY], ["free-dedupe-key"], "UNIQUE"),
];

async function countRows(db: D1Database, table: string): Promise<number | null> {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n");
}

async function deleteRow(db: D1Database, table: string, key: string[], row: SqlRow): Promise<void> {
  const where = key.map((name, index) => `${name} = ?${index + 1}`).join(" AND ");
  await db
    .prepare(`DELETE FROM ${table} WHERE ${where}`)
    .bind(...key.map((name) => row[name]))
    .run();
}

async function proveCase(db: D1Database, constraint: ConstraintCase): Promise<void> {
  const { table, error } = constraint;
  const { key, row } = VALID[table];
  const before = await countRows(db, table);

  for (const change of constraint.reject) {
    const label = `${table} ${JSON.stringify(change)}`;
    await assert.rejects(
      insertRow(db, table, { ...row, ...change }),
      (thrown: Error) => {
        assert.match(thrown.message, new RegExp(`${error} constraint failed`), label);
        return true;
      },
      `${label} should be refused`,
    );
    assert.equal(await countRows(db, table), before, `${label} left a row behind`);
  }

  for (const change of constraint.accept) {
    const candidate = { ...row, ...change };
    const stored = await insertRow<SqlRow>(db, table, candidate);
    for (const [name, value] of Object.entries(change)) assert.equal(stored[name], value, `${table}.${name}`);
    await deleteRow(db, table, key, candidate);
  }
}

async function seedParents(db: D1Database): Promise<void> {
  await seedType(db, { id: TYPE_ID });
  await seedRateClass(db, { id: RATE_ID });
  await seedRateClass(db, { id: OTHER_RATE_ID });
  await seedPackage(db, { id: PACKAGE_ID });
  await seedPrice(db, { rate_class_id: RATE_ID, package_id: PACKAGE_ID });
  await seedModel(db, { id: MODEL_ID, type_id: TYPE_ID, rate_class_id: RATE_ID });
  await seedVehicle(db, { plate: PLATE, model_id: MODEL_ID });
  await seedBooking(db, { id: BOOKING_ID, ref: TAKEN_REF, vehicle_plate: PLATE, model_id: MODEL_ID });
  await insertRow(db, "refunds", {
    ...VALID.refunds.row,
    id: "parent-refund",
    square_refund_id: TAKEN_SQUARE_ID,
    idempotency_key: TAKEN_IDEMPOTENCY_KEY,
  });
  await insertRow(db, "outbox", { ...VALID.outbox.row, dedupe_key: TAKEN_DEDUPE_KEY });
}

test("constraints reject bad rows", async (t) => {
  const { db, dispose } = await createTestDb();
  try {
    for (const constraint of STANDALONE_CASES) {
      await t.test(constraint.name, () => proveCase(db, constraint));
    }
    await seedParents(db);
    for (const constraint of CHILD_CASES) {
      await t.test(constraint.name, () => proveCase(db, constraint));
    }
  } finally {
    await dispose();
  }
});

interface IndexInfo {
  name: string;
  unique: number;
  partial: number;
}

/** The indexes of `table` the migrations declared, each with the columns it covers in order. */
async function declaredIndexes(db: D1Database, table: string): Promise<(IndexInfo & { columns: string[] })[]> {
  const { results } = await db.prepare(`PRAGMA index_list(${table})`).all<IndexInfo & { origin: string }>();
  const indexes = [];
  for (const index of results.filter((row) => row.origin === "c")) {
    const info = await db.prepare(`PRAGMA index_info(${index.name})`).all<{ name: string }>();
    indexes.push({ ...index, columns: info.results.map((row) => row.name) });
  }
  return indexes;
}

test("bookings are indexed for lookups and a block's external_ref is unique", async () => {
  const { db, dispose } = await createTestDb();
  try {
    const indexes = await declaredIndexes(db, "bookings");
    for (const columns of [["vehicle_plate", "start_at"], ["status", "expires_at"], ["payment_id"]]) {
      assert.ok(
        indexes.some((index) => index.partial === 0 && index.columns.join() === columns.join()),
        `no full index on (${columns.join(", ")}) in ${JSON.stringify(indexes)}`,
      );
    }
    assert.ok(
      indexes.some((index) => index.unique === 1 && index.partial === 1 && index.columns.join() === "external_ref"),
      `no partial unique index on external_ref in ${JSON.stringify(indexes)}`,
    );

    const { plate, model_id } = await seedVehicle(db);
    const other = await seedVehicle(db);

    await seedBooking(db, { source: "block", external_ref: "ical-1", vehicle_plate: plate, model_id });
    for (const vehicle of [
      { vehicle_plate: plate, model_id },
      { vehicle_plate: other.plate, model_id: other.model_id },
    ]) {
      await assert.rejects(seedBooking(db, { source: "block", external_ref: "ical-1", ...vehicle }), /UNIQUE constraint failed/);
    }

    // Each of these is allowed, because the rule covers only blocks that carry a reference.
    await seedBooking(db, { source: "block", external_ref: "ical-2", vehicle_plate: plate, model_id });
    await seedBooking(db, { source: "web", external_ref: "ical-1", vehicle_plate: plate, model_id });
    await seedBooking(db, { source: "web", external_ref: "web-1", vehicle_plate: plate, model_id });
    await seedBooking(db, { source: "web", external_ref: "web-1", vehicle_plate: plate, model_id });
    await seedBooking(db, { source: "block", external_ref: null, vehicle_plate: plate, model_id });
    await seedBooking(db, { source: "block", external_ref: null, vehicle_plate: plate, model_id });

    assert.equal(await countRows(db, "bookings"), 7);
  } finally {
    await dispose();
  }
});

// Every value differs within a set, so swapping two keys in the reader changes the result.
const CONFIG_SETS: { stored: Record<string, string | number>; parsed: Record<string, string | number> }[] = [
  {
    stored: {
      shop_open: "09:00",
      shop_close: "18:00",
      slot_minutes: 30,
      turnaround_minutes: 60,
      hold_minutes: 15,
      min_lead_hours: 24,
      max_days_ahead: 180,
      photo_max_mb: 5,
    },
    parsed: {
      shopOpen: "09:00",
      shopClose: "18:00",
      slotMinutes: 30,
      turnaroundMinutes: 60,
      holdMinutes: 15,
      minLeadHours: 24,
      maxDaysAhead: 180,
      photoMaxMb: 5,
    },
  },
  {
    stored: {
      shop_open: "08:30",
      shop_close: "19:45",
      slot_minutes: 20,
      turnaround_minutes: 45,
      hold_minutes: 10,
      min_lead_hours: 48,
      max_days_ahead: 365,
      photo_max_mb: 12,
    },
    parsed: {
      shopOpen: "08:30",
      shopClose: "19:45",
      slotMinutes: 20,
      turnaroundMinutes: 45,
      holdMinutes: 10,
      minLeadHours: 48,
      maxDaysAhead: 365,
      photoMaxMb: 12,
    },
  },
  {
    // Zero is a real setting for these two, and another key in the table is not part of ShopConfig.
    stored: {
      shop_open: "10:00",
      shop_close: "17:00",
      slot_minutes: 60,
      turnaround_minutes: 0,
      hold_minutes: 25,
      min_lead_hours: 0,
      max_days_ahead: 90,
      photo_max_mb: 3,
      some_later_setting: "ignored",
    },
    parsed: {
      shopOpen: "10:00",
      shopClose: "17:00",
      slotMinutes: 60,
      turnaroundMinutes: 0,
      holdMinutes: 25,
      minLeadHours: 0,
      maxDaysAhead: 90,
      photoMaxMb: 3,
    },
  },
  {
    // The first and last minutes of the day are times like any other.
    stored: {
      shop_open: "00:00",
      shop_close: "23:59",
      slot_minutes: 15,
      turnaround_minutes: 30,
      hold_minutes: 20,
      min_lead_hours: 6,
      max_days_ahead: 45,
      photo_max_mb: 1,
    },
    parsed: {
      shopOpen: "00:00",
      shopClose: "23:59",
      slotMinutes: 15,
      turnaroundMinutes: 30,
      holdMinutes: 20,
      minLeadHours: 6,
      maxDaysAhead: 45,
      photoMaxMb: 1,
    },
  },
];

const CONFIG_KEYS = [
  "shop_open",
  "shop_close",
  "slot_minutes",
  "turnaround_minutes",
  "hold_minutes",
  "min_lead_hours",
  "max_days_ahead",
  "photo_max_mb",
];

// Number reads "" and "   " as 0, parseInt reads "30 min" as 30, and Infinity gets past a NaN check. A NaN buffer makes
// conflicts return false for a real overlap, so none of these may reach a ShopConfig.
const NOT_A_NUMBER = ["abc", "", "   ", "30 min", "Infinity", "-1"];

// What parseHHmm in src/lib/time.ts refuses. rentalEnd reads shop_close, so a bad one moves or voids every return time.
const NOT_A_TIME = ["25:00", "24:00", "18:60", "9am", "1800", "abc", ""];

// Minutes, hours and days are whole numbers. The ticket does not say whether photo_max_mb may be fractional, so that is
// left open, and so is zero on every key CONFIG_SETS does not store it for.
const BAD_CONFIG_VALUES: Record<string, string[]> = {
  shop_open: NOT_A_TIME,
  shop_close: NOT_A_TIME,
  slot_minutes: [...NOT_A_NUMBER, "12.5"],
  turnaround_minutes: [...NOT_A_NUMBER, "12.5"],
  hold_minutes: [...NOT_A_NUMBER, "12.5"],
  min_lead_hours: [...NOT_A_NUMBER, "1.5"],
  max_days_ahead: [...NOT_A_NUMBER, "1.5"],
  photo_max_mb: NOT_A_NUMBER,
};

test("readShopConfig parses config and fails before the first publish", async () => {
  const { readShopConfig, CatalogNotPublished } = await configModule();
  const { db, dispose } = await createTestDb();
  try {
    await assert.rejects(() => readShopConfig(db), CatalogNotPublished);

    for (const { stored, parsed } of CONFIG_SETS) {
      await seedConfig(db, stored);
      assert.deepEqual(await readShopConfig(db), parsed);
    }

    // The reader's numbers come from text columns, so a key that is missing must not turn into NaN or undefined.
    for (const key of CONFIG_KEYS) {
      await seedConfig(db);
      await db.prepare("DELETE FROM config WHERE key = ?1").bind(key).run();
      await assert.rejects(() => readShopConfig(db), `a config without ${key} should not parse`);
    }

    // Nor may a value that is there but does not parse. The same rows then parse once corrected, so each refusal was
    // about that value.
    const [{ stored, parsed }] = CONFIG_SETS;
    for (const key of CONFIG_KEYS) {
      for (const value of BAD_CONFIG_VALUES[key]) {
        await seedConfig(db, { ...stored, [key]: value });
        await assert.rejects(() => readShopConfig(db), `${key} ${JSON.stringify(value)} should not parse`);
      }
      await seedConfig(db, stored);
      assert.deepEqual(await readShopConfig(db), parsed, `${key} corrected`);
    }
  } finally {
    await dispose();
  }
});

test("readClosedDates returns the closed dates in a range, both ends included", async () => {
  const { readClosedDates } = await configModule();
  const { db, dispose } = await createTestDb();
  try {
    for (const date of ["2026-12-31", "2026-08-15", "2027-01-01", "2026-08-11", "2026-08-14", "2026-07-31"]) {
      await insertRow(db, "closed_dates", { date });
    }
    const cases: [string, string, string[]][] = [
      ["2026-08-11", "2026-08-15", ["2026-08-11", "2026-08-14", "2026-08-15"]],
      ["2026-08-12", "2026-08-15", ["2026-08-14", "2026-08-15"]],
      ["2026-08-11", "2026-08-14", ["2026-08-11", "2026-08-14"]],
      ["2026-08-12", "2026-08-13", []],
      ["2026-08-14", "2026-08-14", ["2026-08-14"]],
      ["2026-08-13", "2026-08-13", []],
      ["2026-07-31", "2026-08-11", ["2026-07-31", "2026-08-11"]],
      ["2026-12-01", "2027-01-31", ["2026-12-31", "2027-01-01"]],
      ["2026-01-01", "2027-12-31", ["2026-07-31", "2026-08-11", "2026-08-14", "2026-08-15", "2026-12-31", "2027-01-01"]],
      ["2028-01-01", "2028-12-31", []],
      ["2026-08-15", "2026-08-11", []],
    ];
    for (const [from, to, expected] of cases) {
      const dates = await readClosedDates(db, from, to);
      assert.deepEqual([...dates].sort(), expected, `${from} to ${to}`);
    }
  } finally {
    await dispose();
  }
});

test("readCancellationTiers returns the tiers by min_days_before, highest first", async () => {
  const { readCancellationTiers } = await configModule();
  const { db, dispose } = await createTestDb();
  try {
    const sets: [TierRow[], CancellationTier[]][] = [
      [
        // In text order 100 would sort before 9.
        [
          { min_days_before: 0, refund_percent: 5 },
          { min_days_before: 100, refund_percent: 100 },
          { min_days_before: 9, refund_percent: 30 },
          { min_days_before: 30, refund_percent: 80 },
          { min_days_before: 1, refund_percent: 10 },
        ],
        [
          { minDaysBefore: 100, refundPercent: 100 },
          { minDaysBefore: 30, refundPercent: 80 },
          { minDaysBefore: 9, refundPercent: 30 },
          { minDaysBefore: 1, refundPercent: 10 },
          { minDaysBefore: 0, refundPercent: 5 },
        ],
      ],
      [
        [
          { min_days_before: 2, refund_percent: 90 },
          { min_days_before: 14, refund_percent: 20 },
        ],
        [
          { minDaysBefore: 14, refundPercent: 20 },
          { minDaysBefore: 2, refundPercent: 90 },
        ],
      ],
    ];
    for (const [tiers, expected] of sets) {
      await db.prepare("DELETE FROM cancellation_tiers").run();
      await seedTiers(db, tiers);
      assert.deepEqual(await readCancellationTiers(db), expected);
    }
  } finally {
    await dispose();
  }
});

test("docs/data-model.md documents every booking transition", () => {
  const lines = readFileSync(new URL("../docs/data-model.md", import.meta.url), "utf8").split("\n");
  // An arrow joins each pair, so a list of the statuses is not a transition and a chain line covers its adjacent pairs.
  // The last two also carry the reason the definition of done gives them, on the same line.
  const transitions: [string, string, RegExp?][] = [
    ["ON_HOLD", "PAYMENT_PENDING"],
    ["PAYMENT_PENDING", "CONFIRMED"],
    ["CONFIRMED", "CANCELLED"],
    ["ON_HOLD", "EXPIRED"],
    ["PAYMENT_PENDING", "ON_HOLD", /declined/i],
    ["PAYMENT_PENDING", "EXPIRED", /no payment/i],
  ];
  for (const [from, to, reason] of transitions) {
    const arrow = new RegExp(`${from}\\s*(->|→)\\s*${to}`);
    const found = lines.some((line) => arrow.test(line) && (reason === undefined || reason.test(line)));
    const wanted = reason === undefined ? `${from} -> ${to}` : `${from} -> ${to} with ${reason}`;
    assert.ok(found, `no line of docs/data-model.md has ${wanted}`);
  }
});

test("seed helpers fill defaults, create their parents and return the stored row", async () => {
  const { db, dispose } = await createTestDb();
  const one = async (sql: string, ...values: SqlValue[]) =>
    db
      .prepare(sql)
      .bind(...values)
      .first();
  try {
    const first = await seedBooking(db);
    const second = await seedBooking(db);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.ref, second.ref);
    assert.notEqual(first.vehicle_plate, second.vehicle_plate);
    assert.ok(first.end_at > first.start_at);
    assert.equal(first.paid_jpy, 0, "column defaults come back in the row");
    assert.deepEqual(first, await one("SELECT * FROM bookings WHERE id = ?1", first.id));

    const vehicle = await one("SELECT * FROM vehicles WHERE plate = ?1", first.vehicle_plate);
    assert.equal(vehicle?.model_id, first.model_id);
    const model = await one("SELECT * FROM models WHERE id = ?1", first.model_id);
    assert.ok(await one("SELECT id FROM vehicle_types WHERE id = ?1", model?.type_id as string));
    assert.ok(await one("SELECT id FROM rate_classes WHERE id = ?1", model?.rate_class_id as string));

    // A partial wins over the defaults, and a named vehicle supplies the model.
    const start_at = Date.parse("2026-09-01T10:00:00+09:00");
    const hold = await seedBooking(db, { status: "ON_HOLD", expires_at: 123, start_at, vehicle_plate: first.vehicle_plate });
    assert.equal(hold.status, "ON_HOLD");
    assert.equal(hold.expires_at, 123);
    assert.equal(hold.model_id, first.model_id);
    assert.ok(hold.end_at > start_at, "end_at follows a start_at given alone");

    // A second default parent reuses the type rather than colliding on its id, and keeps its values.
    const carType = await seedType(db, { id: "car", deposit_jpy: 20000 });
    assert.deepEqual(carType, await one("SELECT * FROM vehicle_types WHERE id = 'car'"));
    await seedType(db, { deposit_jpy: 7777 });
    await seedModel(db);
    assert.equal((await one("SELECT deposit_jpy FROM vehicle_types WHERE id = 'motorcycle'"))?.deposit_jpy, 7777);

    const rateClass = await seedRateClass(db, { grp: "car" });
    assert.deepEqual(rateClass, await one("SELECT * FROM rate_classes WHERE id = ?1", rateClass.id));

    const carModel = await seedModel(db, { type_id: "car", rate_class_id: rateClass.id, seats: 4 });
    assert.deepEqual(carModel, await one("SELECT * FROM models WHERE id = ?1", carModel.id));

    const car = await seedVehicle(db, { model_id: carModel.id, status: "maintenance" });
    assert.equal(car.base_usage_days, 0, "column defaults come back in the row");
    assert.deepEqual(car, await one("SELECT * FROM vehicles WHERE plate = ?1", car.plate));

    const daysPackage = await seedPackage(db);
    assert.deepEqual(daysPackage, await one("SELECT * FROM packages WHERE id = ?1", daysPackage.id));
    assert.equal(daysPackage.hours, null);
    assert.ok(daysPackage.days !== null);
    const threeDays = await seedPackage(db, { days: 3 });
    assert.equal(threeDays.days, 3);
    assert.equal(threeDays.hours, null);
    const fourHours = await seedPackage(db, { hours: 4 });
    assert.equal(fourHours.hours, 4);
    assert.equal(fourHours.days, null);

    const price = await seedPrice(db);
    assert.deepEqual(
      price,
      await one("SELECT * FROM prices WHERE rate_class_id = ?1 AND package_id = ?2", price.rate_class_id, price.package_id),
    );
    assert.equal((await seedPrice(db, { price_jpy: 4321 })).price_jpy, 4321);

    const config = await seedConfig(db, { turnaround_minutes: 75 });
    assert.equal(config.turnaround_minutes, "75");
    assert.equal(config.shop_close, (await one("SELECT value FROM config WHERE key = 'shop_close'"))?.value);
    assert.equal((await seedConfig(db, { turnaround_minutes: 80 })).turnaround_minutes, "80", "seeding again updates");

    const tiers = await seedTiers(db);
    assert.ok(tiers.length > 0);
    assert.equal(await countRows(db, "cancellation_tiers"), tiers.length);
    await seedTiers(db);
    assert.equal(await countRows(db, "cancellation_tiers"), tiers.length, "seeding again updates");
  } finally {
    await dispose();
  }
});
