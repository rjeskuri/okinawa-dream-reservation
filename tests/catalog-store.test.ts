// The catalog store: replaceCatalog writes a whole publish in one D1 batch, and readCatalog reads it back. Expected values
// are the hand-written fixtures below and literals, and rows are read through SQL where the store's own reader would
// prove nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readCancellationTiers, readClosedDates, readShopConfig } from "../src/lib/db/config.ts";
import { LOCALES } from "../src/lib/locale.ts";
import type { Catalog, LocalizedTexts, Model, Vehicle, VehicleStatus } from "../src/lib/types.ts";
import { createTestDb } from "./helpers/d1.ts";
import { seedBooking, seedConfig, seedVehicle } from "./helpers/seed.ts";
import type { BookingRow, SqlRow } from "./helpers/seed.ts";

/** Loaded where it is needed, so each test reports its own failure until the module exists. */
const store = () => import("../src/lib/db/catalog-store.ts");

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse("2030-03-01T12:00:00+09:00");
const LATER = NOW + 3 * DAY_MS;

/** Differs by locale, so storing one locale for all of them shows. */
function names(en: string): LocalizedTexts<{ name: string }> {
  return { ja: { name: `${en} 日本語` }, en: { name: en }, "zh-cn": { name: `${en} 中文` }, ko: { name: `${en} 한국어` } };
}

function modelTexts(en: string): Model["texts"] {
  const fields = (name: string) => ({ name, summary: `${name}: summary`, description: `${name}: description` });
  return { ja: fields(`${en} 日本語`), en: fields(en), "zh-cn": fields(`${en} 中文`), ko: fields(`${en} 한국어`) };
}

/** A price row. advancePriceJpy (#131) is null where the row has none. */
function price(rateClassId: string, packageId: string, priceJpy: number, advancePriceJpy: number | null = null) {
  return { rateClassId, packageId, priceJpy, advancePriceJpy };
}

// Both fixtures are written in the order readCatalog returns, which the store has to fix because vehicles and prices have
// no sort column and upserted rows keep their old place: vehicle types, rate classes, models, packages and options by
// sort then id, vehicles by plate, prices by rate class id then package id, refund tiers by min_days_before, highest
// first, and closed dates earliest first. The last two match readCancellationTiers and readClosedDates.
//
// Ids run against sort, so ordering by id alone shows, and the sort values differ in digits, so ordering them as text does.
const FIRST: Catalog = {
  config: {
    shopOpen: "09:00",
    shopClose: "18:00",
    slotMinutes: 30,
    turnaroundMinutes: 60,
    holdMinutes: 15,
    minLeadHours: 24,
    maxDaysAhead: 180,
    photoMaxMb: 5,
  },
  vehicleTypes: [
    { id: "scooter", depositJpy: 3000, sort: 9, texts: names("Scooter") },
    { id: "motorcycle", depositJpy: 5000, sort: 10, texts: names("Motorcycle") },
    { id: "car", depositJpy: 10000, sort: 100, texts: names("Car") },
  ],
  rateClasses: [
    { id: "r-400cc", grp: "bike", sort: 9, extensionPerHourJpy: 1500, texts: names("400cc") },
    { id: "r-125cc", grp: "bike", sort: 10, extensionPerHourJpy: 1000, texts: names("125cc") },
    { id: "k-car", grp: "car", sort: 100, extensionPerHourJpy: null, texts: names("K-Car") },
  ],
  models: [
    {
      id: "vespa-125",
      typeId: "scooter",
      engineCc: 125,
      licenseClass: "small",
      sort: 9,
      active: true,
      rateClassId: "r-125cc",
      brand: "Piaggio",
      seats: null,
      texts: modelTexts("Vespa"),
      photos: ["vespa front.jpg", "vespa's side.jpg"],
    },
    {
      // An apostrophe in an id, and text a statement built by concatenation would choke on.
      id: "o'neal-400",
      typeId: "motorcycle",
      engineCc: 399,
      licenseClass: "standard",
      sort: 10,
      active: true,
      rateClassId: "r-400cc",
      brand: "Kawasaki",
      seats: null,
      texts: modelTexts(`O'Neal "400"; DROP TABLE models; -- 100% \\ back\nslash`),
      photos: [],
    },
    {
      id: "n-box",
      typeId: "car",
      engineCc: 658,
      licenseClass: "car",
      sort: 100,
      active: false,
      rateClassId: "k-car",
      brand: "Honda",
      seats: 4,
      texts: modelTexts("N-Box"),
      photos: ["n-box.jpg"],
    },
  ],
  vehicles: [
    { plate: "O'KI-400", modelId: "o'neal-400", status: "active", odometerKm: 4500, baseUsageDays: 3 },
    { plate: "OKI-100", modelId: "vespa-125", status: "active", odometerKm: 12000, baseUsageDays: 0 },
    { plate: "OKI-200", modelId: "vespa-125", status: "maintenance", odometerKm: null, baseUsageDays: 12 },
    { plate: "OKI-300", modelId: "o'neal-400", status: "active", odometerKm: 0, baseUsageDays: 7 },
    { plate: "OKI-500", modelId: "vespa-125", status: "active", odometerKm: 300, baseUsageDays: 5 },
    { plate: "沖縄 あ 12-34", modelId: "n-box", status: "retired", odometerKm: 99000, baseUsageDays: 40 },
  ],
  packages: [
    { id: "week", days: 7, hours: null, sort: 9, texts: names("One week") },
    { id: "three-days", days: 3, hours: null, sort: 10, texts: names("Three days") },
    { id: "four-hours", days: null, hours: 4, sort: 100, texts: names("Four hours") },
  ],
  // An advance price (#131) on some rows only, each below its regular price.
  prices: [
    price("k-car", "three-days", 15000),
    price("k-car", "week", 30000, 28000),
    price("r-125cc", "four-hours", 3000),
    price("r-125cc", "three-days", 9000, 8500),
    price("r-125cc", "week", 18000),
    price("r-400cc", "three-days", 12000),
    price("r-400cc", "week", 24000),
  ],
  options: [
    { id: "insurance", grp: "bike", sort: 9, baseJpy: 500, extraPerHourJpy: 100, extraPer24hJpy: null, texts: names("Insurance") },
    { id: "child-seat", grp: "car", sort: 10, baseJpy: 0, extraPerHourJpy: null, extraPer24hJpy: 300, texts: names("Child seat") },
  ],
  cancellationTiers: [
    { minDaysBefore: 7, refundPercent: 100 },
    { minDaysBefore: 3, refundPercent: 50 },
    { minDaysBefore: 0, refundPercent: 0 },
  ],
  closedDates: ["2026-12-31", "2027-01-01"],
};

// The same ids with every column changed, plus new rows in each list, so nothing of FIRST survives a replace by luck.
const SECOND: Catalog = {
  config: {
    shopOpen: "08:30",
    shopClose: "19:45",
    slotMinutes: 20,
    turnaroundMinutes: 0,
    holdMinutes: 10,
    minLeadHours: 0,
    maxDaysAhead: 365,
    photoMaxMb: 2.5,
  },
  vehicleTypes: [
    { id: "car", depositJpy: 0, sort: 1, texts: names("Car, second") },
    { id: "motorcycle", depositJpy: 7000, sort: 2, texts: names("Motorcycle, second") },
    { id: "scooter", depositJpy: 4000, sort: 3, texts: names("Scooter, second") },
  ],
  rateClasses: [
    { id: "k-car", grp: "bike", sort: 1, extensionPerHourJpy: 2000, texts: names("K-Car, second") },
    { id: "r-125cc", grp: "car", sort: 2, extensionPerHourJpy: null, texts: names("125cc, second") },
    { id: "r-400cc", grp: "bike", sort: 3, extensionPerHourJpy: 0, texts: names("400cc, second") },
    { id: "z-new-class", grp: "car", sort: 4, extensionPerHourJpy: 900, texts: names("New class") },
  ],
  models: [
    {
      id: "n-box",
      typeId: "scooter",
      engineCc: 660,
      licenseClass: "moped",
      sort: 1,
      active: true,
      rateClassId: "z-new-class",
      brand: "Daihatsu",
      seats: 5,
      texts: modelTexts("N-Box, second"),
      photos: ["n1.jpg"],
    },
    {
      id: "o'neal-400",
      typeId: "car",
      engineCc: 400,
      licenseClass: "large",
      sort: 2,
      active: false,
      rateClassId: "k-car",
      brand: "Yamaha",
      seats: 2,
      texts: modelTexts("O'Neal, second"),
      photos: ["o1.jpg", "o2.jpg"],
    },
    {
      id: "vespa-125",
      typeId: "motorcycle",
      engineCc: 150,
      licenseClass: "standard",
      sort: 3,
      active: true,
      rateClassId: "r-400cc",
      brand: "Honda",
      seats: 1,
      texts: modelTexts("Vespa, second"),
      photos: [],
    },
    {
      id: "z-new-model",
      typeId: "car",
      engineCc: 1000,
      licenseClass: "car",
      sort: 4,
      active: true,
      rateClassId: "z-new-class",
      brand: "Toyota",
      seats: null,
      texts: modelTexts("New model"),
      photos: ["z.jpg"],
    },
  ],
  vehicles: [
    { plate: "O'KI-400", modelId: "vespa-125", status: "maintenance", odometerKm: null, baseUsageDays: 9 },
    { plate: "OKI-100", modelId: "n-box", status: "maintenance", odometerKm: 12500, baseUsageDays: 1 },
    { plate: "OKI-200", modelId: "o'neal-400", status: "active", odometerKm: 800, baseUsageDays: 2 },
    { plate: "OKI-300", modelId: "z-new-model", status: "active", odometerKm: 20, baseUsageDays: 8 },
    { plate: "OKI-500", modelId: "n-box", status: "retired", odometerKm: 301, baseUsageDays: 6 },
    { plate: "OKI-600", modelId: "z-new-model", status: "active", odometerKm: null, baseUsageDays: 0 },
    { plate: "沖縄 あ 12-34", modelId: "vespa-125", status: "active", odometerKm: 99100, baseUsageDays: 41 },
  ],
  packages: [
    { id: "four-hours", days: 1, hours: null, sort: 1, texts: names("Four hours, second") },
    { id: "three-days", days: null, hours: 72, sort: 2, texts: names("Three days, second") },
    { id: "week", days: 14, hours: null, sort: 3, texts: names("One week, second") },
    { id: "z-new-package", days: 60, hours: null, sort: 4, texts: names("New package") },
  ],
  // r-125cc/three-days loses its advance price, r-400cc/week gains one equal to its price, and a new row has its own.
  prices: [
    price("k-car", "four-hours", 4000),
    price("k-car", "z-new-package", 60000),
    price("r-125cc", "three-days", 9500),
    price("r-400cc", "week", 25000, 25000),
    price("z-new-class", "week", 33000),
    price("z-new-class", "z-new-package", 70000, 65000),
  ],
  options: [
    { id: "child-seat", grp: "bike", sort: 1, baseJpy: 700, extraPerHourJpy: 50, extraPer24hJpy: null, texts: names("Seat 2") },
    { id: "insurance", grp: "car", sort: 2, baseJpy: 0, extraPerHourJpy: null, extraPer24hJpy: 200, texts: names("Cover 2") },
    { id: "z-new-option", grp: "bike", sort: 3, baseJpy: 100, extraPerHourJpy: 10, extraPer24hJpy: 20, texts: names("New") },
  ],
  cancellationTiers: [
    { minDaysBefore: 30, refundPercent: 100 },
    { minDaysBefore: 14, refundPercent: 75 },
    { minDaysBefore: 1, refundPercent: 25 },
  ],
  closedDates: ["2027-05-03", "2027-05-04", "2027-05-05"],
};

/** 60 models, 200 vehicles and 600 prices, each list already in the order readCatalog returns. */
function largeCatalog(): Catalog {
  const pad = (n: number) => String(n).padStart(3, "0");
  const rateClasses = Array.from({ length: 20 }, (_, i) => ({
    id: `rate-${pad(i)}`,
    grp: "bike" as const,
    sort: i,
    extensionPerHourJpy: 1000 + i,
    texts: names(`Rate ${i}`),
  }));
  const packages = Array.from({ length: 30 }, (_, i) => ({
    id: `package-${pad(i)}`,
    days: i + 1,
    hours: null,
    sort: i,
    texts: names(`Package ${i}`),
  }));
  const models = Array.from({ length: 60 }, (_, i) => ({
    id: `model-${pad(i)}`,
    typeId: "motorcycle" as const,
    engineCc: 50 + i,
    licenseClass: "small" as const,
    sort: i,
    active: true,
    rateClassId: rateClasses[i % rateClasses.length].id,
    brand: `Brand ${i}`,
    seats: null,
    texts: modelTexts(`Model ${i}`),
    photos: [`model-${i}.jpg`],
  }));
  const vehicles = Array.from({ length: 200 }, (_, i) => ({
    plate: `PLATE-${pad(i)}`,
    modelId: models[i % models.length].id,
    status: "active" as const,
    odometerKm: i * 10,
    baseUsageDays: i,
  }));
  const prices = rateClasses.flatMap((rateClass, r) =>
    packages.map((pkg, p) => price(rateClass.id, pkg.id, 1000 + 100 * r + p, p % 2 === 0 ? 900 + 100 * r + p : null)),
  );
  return { ...FIRST, rateClasses, models, vehicles, packages, prices };
}

function published(catalog: Catalog, version: number, publishedAt: number): Catalog & { version: number; publishedAt: number } {
  return { ...catalog, version, publishedAt };
}

/** `catalog` with these models and vehicles left out. */
function without(catalog: Catalog, gone: { models?: string[]; plates?: string[] }): Catalog {
  return {
    ...catalog,
    models: catalog.models.filter((model) => !gone.models?.includes(model.id)),
    vehicles: catalog.vehicles.filter((vehicle) => !gone.plates?.includes(vehicle.plate)),
  };
}

/** The models with these ids inactive, and otherwise as they stood. */
function deactivated(models: Model[], ids: string[]): Model[] {
  return models.map((model) => (ids.includes(model.id) ? { ...model, active: false } : model));
}

/** The vehicles with these plates retired, and otherwise as they stood. */
function retired(vehicles: Vehicle[], plates: string[]): Vehicle[] {
  return vehicles.map((vehicle) => (plates.includes(vehicle.plate) ? { ...vehicle, status: "retired" } : vehicle));
}

const sorted = (list: string[]): string[] => [...list].sort();

/** Every row of `table`, in an order that depends only on what the rows hold. */
async function rows(db: D1Database, table: string): Promise<SqlRow[]> {
  const { results } = await db.prepare(`SELECT * FROM ${table}`).all<SqlRow>();
  const key = (row: SqlRow) => JSON.stringify(row);
  return [...results].sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

const STORE_TABLES = [
  "catalog_meta",
  "vehicle_types",
  "rate_classes",
  "models",
  "vehicles",
  "packages",
  "prices",
  "options",
  "config",
  "cancellation_tiers",
  "closed_dates",
  "bookings",
];

async function snapshot(db: D1Database): Promise<Record<string, SqlRow[]>> {
  const tables: Record<string, SqlRow[]> = {};
  for (const table of STORE_TABLES) tables[table] = await rows(db, table);
  return tables;
}

/** The statements of a SQL file, split the way tests/helpers/d1.ts splits a migration. */
function sqlStatements(sql: string): string[] {
  return sql
    .split(/;[ \t]*\r?\n/)
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement !== "");
}

/** What ran through a `watch`ed database. Every statement counts once, on its own or as an entry of a batch. */
interface Spy {
  statements: number;
  /** Statements run on their own, outside any batch. */
  direct: number;
  batches: number;
  /** Whether the failure this watcher was asked for has happened. */
  injected: boolean;
}

/**
 * `db` behind a counter over prepare and batch. With `failAt`, the statement of that index (from 0, in the order they
 * run) fails instead of running: inside a batch it becomes a statement D1 refuses, so the real batch aborts on it, and on
 * its own it throws.
 */
function watch(db: D1Database, failAt = -1): { db: D1Database; spy: Spy } {
  const spy: Spy = { statements: 0, direct: 0, batches: 0, injected: false };
  const reals = new WeakMap<object, D1PreparedStatement>();

  const nextFails = (): boolean => {
    const fails = spy.statements === failAt;
    spy.statements += 1;
    if (fails) spy.injected = true;
    return fails;
  };
  const runDirect = () => {
    spy.direct += 1;
    if (nextFails()) throw new Error("injected failure");
  };

  const wrap = (real: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(real.bind(...values)),
      run: async () => {
        runDirect();
        return real.run();
      },
      all: async () => {
        runDirect();
        return real.all();
      },
      first: async (column?: string) => {
        runDirect();
        return column === undefined ? real.first() : real.first(column);
      },
      raw: async (options?: { columnNames: true }) => {
        runDirect();
        return real.raw(options as { columnNames: true });
      },
    } as unknown as D1PreparedStatement;
    reals.set(wrapped, real);
    return wrapped;
  };

  const watched = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      spy.batches += 1;
      const batch = statements.map((statement) =>
        nextFails() ? db.prepare("INSERT INTO no_such_table (x) VALUES (1)") : (reals.get(statement) as D1PreparedStatement),
      );
      return db.batch(batch);
    },
  } as unknown as D1Database;
  return { db: watched, spy };
}

test("replace then read returns the same catalog", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const cases: [Catalog, number][] = [
    [FIRST, NOW],
    [SECOND, NOW + 12_345],
  ];
  for (const [catalog, now] of cases) {
    const { db, dispose } = await createTestDb();
    try {
      const result = await replaceCatalog(db, catalog, { now, source: "sheet" });
      assert.equal(result.version, 1);
      assert.deepEqual(result.affectedBookings, []);
      assert.deepEqual(await readCatalog(db), published(catalog, 1, now));

      // The rows are in the tables, under the keys the other readers use.
      const counts: Record<string, number> = {
        vehicle_types: catalog.vehicleTypes.length,
        rate_classes: catalog.rateClasses.length,
        models: catalog.models.length,
        vehicles: catalog.vehicles.length,
        packages: catalog.packages.length,
        prices: catalog.prices.length,
        options: catalog.options.length,
        cancellation_tiers: catalog.cancellationTiers.length,
        closed_dates: catalog.closedDates.length,
      };
      for (const [table, count] of Object.entries(counts)) assert.equal((await rows(db, table)).length, count, table);
      assert.deepEqual(await readShopConfig(db), catalog.config);
      assert.deepEqual(await readCancellationTiers(db), catalog.cancellationTiers);
      assert.deepEqual(await readClosedDates(db, "2000-01-01", "2100-01-01"), catalog.closedDates);
    } finally {
      await dispose();
    }
  }
});

test("a later replace rewrites every column of every row", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });
    await replaceCatalog(db, SECOND, { now: NOW + 1, source: "admin" });
    assert.deepEqual(await readCatalog(db), published(SECOND, 2, NOW + 1));
  } finally {
    await dispose();
  }
});

test("readCatalog keeps one order whatever the input order", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    const reversed = <T>(list: T[]): T[] => [...list].reverse();
    await replaceCatalog(
      db,
      {
        ...FIRST,
        vehicleTypes: reversed(FIRST.vehicleTypes),
        rateClasses: reversed(FIRST.rateClasses),
        models: reversed(FIRST.models),
        vehicles: reversed(FIRST.vehicles),
        packages: reversed(FIRST.packages),
        prices: reversed(FIRST.prices),
        options: reversed(FIRST.options),
        cancellationTiers: reversed(FIRST.cancellationTiers),
        closedDates: reversed(FIRST.closedDates),
      },
      { now: NOW, source: "sheet" },
    );
    assert.deepEqual(await readCatalog(db), published(FIRST, 1, NOW));

    // Rows that share a sort value fall back to their id.
    const tied = <T extends { sort: number }>(list: T[]): T[] => list.map((row) => ({ ...row, sort: 5 }));
    await replaceCatalog(
      db,
      {
        ...FIRST,
        vehicleTypes: tied(FIRST.vehicleTypes),
        rateClasses: tied(FIRST.rateClasses),
        models: tied(FIRST.models),
        packages: tied(FIRST.packages),
        options: tied(FIRST.options),
      },
      { now: NOW + 1, source: "sheet" },
    );
    const read = await readCatalog(db);
    assert.ok(read);
    const ids = (list: { id: string }[]) => list.map((row) => row.id);
    assert.deepEqual(ids(read.vehicleTypes), ["car", "motorcycle", "scooter"]);
    assert.deepEqual(ids(read.rateClasses), ["k-car", "r-125cc", "r-400cc"]);
    assert.deepEqual(ids(read.models), ["n-box", "o'neal-400", "vespa-125"]);
    assert.deepEqual(ids(read.packages), ["four-hours", "three-days", "week"]);
    assert.deepEqual(ids(read.options), ["child-seat", "insurance"]);
  } finally {
    await dispose();
  }
});

test("readCatalog returns null before the first publish", async () => {
  const { readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    assert.equal(await readCatalog(db), null);
    // Rows alone are not a publish: only catalog_meta records one.
    await seedConfig(db);
    await seedVehicle(db);
    assert.equal(await readCatalog(db), null);
  } finally {
    await dispose();
  }
});

test("readCatalog runs its SELECTs in one batch", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });
    const { db: watched, spy } = watch(db);
    assert.deepEqual(await readCatalog(watched), published(FIRST, 1, NOW));
    assert.equal(spy.batches, 1);
    assert.equal(spy.direct, 0);
  } finally {
    await dispose();
  }
});

test("each replace increments the version", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    // The same catalog again still counts, and `now` is recorded as given, even when it is earlier than the last one.
    const publishes = [
      { catalog: FIRST, now: NOW, source: "sheet" },
      { catalog: SECOND, now: NOW + 60_000, source: "admin" },
      { catalog: SECOND, now: NOW + 120_000, source: "sheet" },
      { catalog: SECOND, now: NOW - 1, source: "admin" },
    ] as const;
    for (const [index, { catalog, now, source }] of publishes.entries()) {
      const version = index + 1;
      const result = await replaceCatalog(db, catalog, { now, source });
      assert.equal(result.version, version);
      assert.deepEqual(await readCatalog(db), published(catalog, version, now));
      assert.deepEqual(await rows(db, "catalog_meta"), [{ id: 1, version, published_at: now, source }]);
    }

    // The count lives in the table: it goes on from whatever version stands there.
    await db.prepare("UPDATE catalog_meta SET version = 41").run();
    assert.equal((await replaceCatalog(db, SECOND, { now: LATER, source: "sheet" })).version, 42);
    assert.deepEqual(await rows(db, "catalog_meta"), [{ id: 1, version: 42, published_at: LATER, source: "sheet" }]);
  } finally {
    await dispose();
  }
});

test("a failing replace leaves the previous catalog", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });
    const before = await snapshot(db);

    // SECOND changes every list and the bad row is a price, the child written after its parents. The foreign key error
    // shows the batch reached that statement: nothing else in these catalogs can raise one.
    const noClass = price("no-such-class", "week", 9000);
    const noPackage = price("k-car", "no-such-package", 9000);
    const bad: Catalog[] = [
      { ...SECOND, prices: [...SECOND.prices, noClass] },
      { ...SECOND, prices: [noClass, ...SECOND.prices] },
      { ...SECOND, prices: [...SECOND.prices, noPackage] },
    ];
    for (const catalog of bad) {
      await assert.rejects(replaceCatalog(db, catalog, { now: NOW + 1, source: "admin" }), /FOREIGN KEY constraint failed/);
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual(await readCatalog(db), published(FIRST, 1, NOW));
    }

    // The failures used up no version.
    const result = await replaceCatalog(db, SECOND, { now: NOW + 2, source: "admin" });
    assert.equal(result.version, 2);
    assert.deepEqual(await readCatalog(db), published(SECOND, 2, NOW + 2));
  } finally {
    await dispose();
  }
});

test("a failure on any statement leaves the previous catalog", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });
    await seedBooking(db, { vehicle_plate: "OKI-100" });
    const before = await snapshot(db);

    // Whatever list holds the bad row, the database refuses it and the refusal reaches the caller.
    const refused: Catalog[] = [
      { ...SECOND, vehicleTypes: SECOND.vehicleTypes.map((row) => ({ ...row, depositJpy: -1 })) },
      { ...SECOND, rateClasses: SECOND.rateClasses.map((row) => ({ ...row, extensionPerHourJpy: -1 })) },
      { ...SECOND, models: SECOND.models.map((row) => ({ ...row, engineCc: 0 })) },
      { ...SECOND, vehicles: SECOND.vehicles.map((row) => ({ ...row, modelId: "no-such-model" })) },
      { ...SECOND, packages: SECOND.packages.map((row) => ({ ...row, days: 61, hours: null })) },
      { ...SECOND, prices: SECOND.prices.map((row) => ({ ...row, priceJpy: 0 })) },
      { ...SECOND, options: SECOND.options.map((row) => ({ ...row, baseJpy: -1 })) },
      { ...SECOND, cancellationTiers: SECOND.cancellationTiers.map((row) => ({ ...row, refundPercent: 101 })) },
    ];
    for (const catalog of refused) {
      await assert.rejects(replaceCatalog(db, catalog, { now: NOW + 1, source: "admin" }), /constraint failed/);
      assert.deepEqual(await snapshot(db), before);
    }

    // Every list changes, so a statement that got through before the failure would show. Each attempt fails one statement
    // further on, until one has nothing left to fail. A replace split over several batches, or one that writes outside its
    // batch, fails here, and so does a read after the batch: that failure would reject a publish that had already landed.
    for (const key of Object.keys(SECOND) as (keyof Catalog)[]) assert.notDeepEqual(SECOND[key], FIRST[key], key);
    let finished = false;
    for (let failAt = 0; !finished; failAt += 1) {
      assert.ok(failAt < 200, "the replace never finished");
      const { db: failing, spy } = watch(db, failAt);
      const outcome = await replaceCatalog(failing, SECOND, { now: NOW + 1, source: "admin" }).then(
        () => "resolved",
        () => "rejected",
      );
      if (spy.injected) {
        assert.equal(outcome, "rejected", `a failure on statement ${failAt} should reach the caller`);
        assert.deepEqual(await snapshot(db), before, `after a failure on statement ${failAt}`);
      } else {
        assert.equal(outcome, "resolved", "with no failure the same replace goes through");
        assert.ok(failAt > 0, "the replace ran no statement");
        finished = true;
      }
    }
    assert.deepEqual(await readCatalog(db), published(SECOND, 2, NOW + 1));
  } finally {
    await dispose();
  }
});

test("removed vehicles retire and keep their bookings", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });
    for (const { plate } of FIRST.vehicles) {
      await seedBooking(db, { vehicle_plate: plate });
      await seedBooking(db, { vehicle_plate: plate, status: "CANCELLED", start_at: NOW - 5 * DAY_MS });
    }
    const bookings = await rows(db, "bookings");

    // A model leaves with its vehicles, and a vehicle in maintenance leaves alone. n-box and 沖縄 あ 12-34 were already
    // inactive and retired, so this publish changes neither and does not list them.
    const gone = {
      models: ["o'neal-400", "n-box"],
      plates: ["O'KI-400", "OKI-200", "OKI-300", "沖縄 あ 12-34"],
    };
    const next = without(FIRST, gone);
    const result = await replaceCatalog(db, next, { now: NOW + 1, source: "sheet" });
    assert.deepEqual(sorted(result.retiredVehicles), ["O'KI-400", "OKI-200", "OKI-300"]);
    assert.deepEqual(result.deactivatedModels, ["o'neal-400"]);

    assert.deepEqual(await rows(db, "bookings"), bookings);
    assert.deepEqual(Object.fromEntries((await rows(db, "vehicles")).map((row) => [row.plate, row.status])), {
      "O'KI-400": "retired",
      "OKI-100": "active",
      "OKI-200": "retired",
      "OKI-300": "retired",
      "OKI-500": "active",
      "沖縄 あ 12-34": "retired",
    });
    assert.deepEqual(Object.fromEntries((await rows(db, "models")).map((row) => [row.id, row.active])), {
      "vespa-125": 1,
      "o'neal-400": 0,
      "n-box": 0,
    });

    // A kept row reads as it stood, apart from its flag. Its other columns and its place in the list do not change.
    const kept = { ...next, models: deactivated(FIRST.models, gone.models), vehicles: retired(FIRST.vehicles, gone.plates) };
    assert.deepEqual(await readCatalog(db), published(kept, 2, NOW + 1));

    // The lists report what this publish changed, so the same catalog again has nothing to report.
    const again = await replaceCatalog(db, next, { now: NOW + 2, source: "sheet" });
    assert.deepEqual(again.retiredVehicles, []);
    assert.deepEqual(again.deactivatedModels, []);
    assert.deepEqual(await rows(db, "bookings"), bookings);
  } finally {
    await dispose();
  }
});

test("retired vehicles and inactive models return with a later catalog", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    const leaving = { models: ["o'neal-400"], plates: ["O'KI-400", "OKI-300"] };
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });
    await seedBooking(db, { vehicle_plate: "OKI-300", start_at: NOW + DAY_MS });

    const gone = await replaceCatalog(db, without(FIRST, leaving), { now: NOW + 1, source: "sheet" });
    assert.equal(gone.affectedBookings.length, 1);

    // Named again, they are what the catalog says, and the booking no longer sits on a vehicle out of service.
    const back = await replaceCatalog(db, FIRST, { now: NOW + 2, source: "sheet" });
    assert.deepEqual(back.retiredVehicles, []);
    assert.deepEqual(back.deactivatedModels, []);
    assert.deepEqual(back.affectedBookings, []);
    assert.deepEqual(await readCatalog(db), published(FIRST, 3, NOW + 2));

    // Leaving a second time reports them a second time.
    const goneAgain = await replaceCatalog(db, without(FIRST, leaving), { now: NOW + 3, source: "sheet" });
    assert.deepEqual(sorted(goneAgain.retiredVehicles), leaving.plates);
    assert.deepEqual(goneAgain.deactivatedModels, leaving.models);

    // A row can come back in any state the catalog gives it, not only as active. o'neal-400 returns inactive, which
    // changes nothing, while the catalog itself takes vespa-125 from active to inactive, which is listed.
    const changed: Catalog = {
      ...FIRST,
      models: deactivated(FIRST.models, ["o'neal-400", "vespa-125"]),
      vehicles: FIRST.vehicles.map((vehicle) => (vehicle.plate === "OKI-300" ? { ...vehicle, status: "maintenance" } : vehicle)),
    };
    const result = await replaceCatalog(db, changed, { now: NOW + 4, source: "sheet" });
    assert.deepEqual(result.deactivatedModels, ["vespa-125"]);
    assert.deepEqual(result.retiredVehicles, []);
    assert.deepEqual(await readCatalog(db), published(changed, 5, NOW + 4));
  } finally {
    await dispose();
  }
});

test("a rate class and a vehicle type stay while a kept model needs them", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });

    // The kept o'neal-400 still references both, and the foreign keys hold them in place. Their prices do leave.
    const gone = { models: ["o'neal-400"], plates: ["O'KI-400", "OKI-300"] };
    const next: Catalog = {
      ...without(FIRST, gone),
      vehicleTypes: FIRST.vehicleTypes.filter((type) => type.id !== "motorcycle"),
      rateClasses: FIRST.rateClasses.filter((rateClass) => rateClass.id !== "r-400cc"),
      prices: FIRST.prices.filter((price) => price.rateClassId !== "r-400cc"),
    };
    const result = await replaceCatalog(db, next, { now: NOW + 1, source: "sheet" });
    assert.deepEqual(result.deactivatedModels, gone.models);

    const kept = {
      ...next,
      vehicleTypes: FIRST.vehicleTypes,
      rateClasses: FIRST.rateClasses,
      models: deactivated(FIRST.models, gone.models),
      vehicles: retired(FIRST.vehicles, gone.plates),
    };
    assert.deepEqual(await readCatalog(db), published(kept, 2, NOW + 1));
  } finally {
    await dispose();
  }
});

test("a rate class and a vehicle type no model needs leave with the catalog", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    const ids = async (table: string) => sorted((await rows(db, table)).map((row) => String(row.id)));
    const onMotorcycle = (model: Model): Model => ({ ...model, typeId: "motorcycle", rateClassId: "r-400cc" });
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });

    // vespa-125 moves off r-125cc and scooter in the publish that drops them, so they have no reference only once the
    // models are written, and r-125cc has no prices only once the prices are.
    const moved: Catalog = {
      ...FIRST,
      vehicleTypes: FIRST.vehicleTypes.filter((type) => type.id !== "scooter"),
      rateClasses: FIRST.rateClasses.filter((rateClass) => rateClass.id !== "r-125cc"),
      models: FIRST.models.map((model) => (model.id === "vespa-125" ? onMotorcycle(model) : model)),
      prices: FIRST.prices.filter((price) => price.rateClassId !== "r-125cc"),
    };
    await replaceCatalog(db, moved, { now: NOW + 1, source: "sheet" });
    assert.deepEqual(await readCatalog(db), published(moved, 2, NOW + 1));
    assert.deepEqual(await ids("vehicle_types"), ["car", "motorcycle"]);
    assert.deepEqual(await ids("rate_classes"), ["k-car", "r-400cc"]);

    // n-box moves away too, but the catalog still names car and k-car: having no model is not a reason to leave.
    const unused: Catalog = {
      ...moved,
      models: moved.models.map((model) => (model.id === "n-box" ? onMotorcycle(model) : model)),
    };
    await replaceCatalog(db, unused, { now: NOW + 2, source: "sheet" });
    assert.deepEqual(await readCatalog(db), published(unused, 3, NOW + 2));
    assert.deepEqual(await ids("vehicle_types"), ["car", "motorcycle"]);
    assert.deepEqual(await ids("rate_classes"), ["k-car", "r-400cc"]);

    // Its prices go as well. With no model and no price k-car still stays, because the catalog names it.
    const unpriced: Catalog = { ...unused, prices: unused.prices.filter((price) => price.rateClassId !== "k-car") };
    await replaceCatalog(db, unpriced, { now: NOW + 3, source: "sheet" });
    assert.deepEqual(await readCatalog(db), published(unpriced, 4, NOW + 3));
    assert.deepEqual(await ids("vehicle_types"), ["car", "motorcycle"]);
    assert.deepEqual(await ids("rate_classes"), ["k-car", "r-400cc"]);

    // Now the catalog stops naming them, and they leave with no model and no price on them at all.
    const last: Catalog = {
      ...unpriced,
      vehicleTypes: unpriced.vehicleTypes.filter((type) => type.id !== "car"),
      rateClasses: unpriced.rateClasses.filter((rateClass) => rateClass.id !== "k-car"),
    };
    await replaceCatalog(db, last, { now: NOW + 4, source: "sheet" });
    assert.deepEqual(await readCatalog(db), published(last, 5, NOW + 4));
    assert.deepEqual(await ids("vehicle_types"), ["motorcycle"]);
    assert.deepEqual(await ids("rate_classes"), ["r-400cc"]);
  } finally {
    await dispose();
  }
});

// Each row's state in two publishes, null where the catalog does not name it, and whether the second publish lists it. A
// row is listed when that publish moves it out of service, whether it left the catalog or the catalog itself says so. A
// row with no earlier state, and one already out of service, has not been moved.
const VEHICLE_CHANGES: { before: VehicleStatus | null; after: VehicleStatus | null; listed: boolean }[] = [
  { before: "active", after: null, listed: true },
  { before: "active", after: "retired", listed: true },
  { before: "active", after: "maintenance", listed: false },
  { before: "active", after: "active", listed: false },
  { before: "maintenance", after: null, listed: true },
  { before: "maintenance", after: "retired", listed: true },
  { before: "maintenance", after: "maintenance", listed: false },
  { before: "maintenance", after: "active", listed: false },
  { before: "retired", after: null, listed: false },
  { before: "retired", after: "retired", listed: false },
  { before: "retired", after: "maintenance", listed: false },
  { before: "retired", after: "active", listed: false },
  { before: null, after: "retired", listed: false },
  { before: null, after: "active", listed: false },
];

const MODEL_CHANGES: { before: boolean | null; after: boolean | null; listed: boolean }[] = [
  { before: true, after: null, listed: true },
  { before: true, after: false, listed: true },
  { before: true, after: true, listed: false },
  { before: false, after: null, listed: false },
  { before: false, after: false, listed: false },
  { before: false, after: true, listed: false },
  { before: null, after: false, listed: false },
  { before: null, after: true, listed: false },
];

const changeKey = ({ before, after }: { before: unknown; after: unknown }) => `${before}-to-${after}`;

/** FIRST plus a row for each change above, in its state at that moment. */
function catalogAt(moment: "before" | "after"): Catalog {
  const [model] = FIRST.models;
  const models = MODEL_CHANGES.flatMap((change) => {
    const active = change[moment];
    return active === null ? [] : [{ ...model, id: changeKey(change), active }];
  });
  const vehicles = VEHICLE_CHANGES.flatMap((change) => {
    const status = change[moment];
    return status === null ? [] : [{ plate: changeKey(change), modelId: model.id, status, odometerKm: null, baseUsageDays: 0 }];
  });
  return { ...FIRST, models: [...FIRST.models, ...models], vehicles: [...FIRST.vehicles, ...vehicles] };
}

test("retiredVehicles and deactivatedModels list the rows this replace takes out of service", async () => {
  const { replaceCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    await replaceCatalog(db, catalogAt("before"), { now: NOW, source: "sheet" });
    const result = await replaceCatalog(db, catalogAt("after"), { now: NOW + 1, source: "sheet" });

    const listed = <T extends { before: unknown; after: unknown; listed: boolean }>(changes: T[]) =>
      sorted(changes.filter((change) => change.listed).map(changeKey));
    assert.deepEqual(sorted(result.retiredVehicles), listed(VEHICLE_CHANGES));
    assert.deepEqual(sorted(result.deactivatedModels), listed(MODEL_CHANGES));

    // The rows did change as the tables say, and the ones FIRST brought along are never listed.
    const statuses = new Map((await rows(db, "vehicles")).map((row) => [row.plate, row.status]));
    for (const change of VEHICLE_CHANGES) {
      assert.equal(statuses.get(changeKey(change)), change.after ?? "retired", changeKey(change));
    }
    const actives = new Map((await rows(db, "models")).map((row) => [row.id, row.active]));
    for (const change of MODEL_CHANGES) {
      assert.equal(actives.get(changeKey(change)), change.after === true ? 1 : 0, changeKey(change));
    }
  } finally {
    await dispose();
  }
});

test("a package and a price can leave while bookings of them remain", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });
    const booking = await seedBooking(db, { vehicle_plate: "OKI-100", package_id: "week", price_jpy: 18000 });

    // "week" goes with all its prices, while one price leaves a package that stays.
    const next: Catalog = {
      ...FIRST,
      packages: FIRST.packages.filter((pkg) => pkg.id !== "week"),
      prices: FIRST.prices.filter(
        (price) => price.packageId !== "week" && !(price.rateClassId === "r-125cc" && price.packageId === "four-hours"),
      ),
    };
    await replaceCatalog(db, next, { now: NOW + 1, source: "sheet" });
    assert.deepEqual(await readCatalog(db), published(next, 2, NOW + 1));
    assert.deepEqual(await rows(db, "bookings"), [booking]);
  } finally {
    await dispose();
  }
});

test("empty lists replace earlier rows", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    const emptied: Catalog[] = [
      { ...FIRST, options: [] },
      { ...FIRST, closedDates: [] },
      { ...FIRST, cancellationTiers: [] },
      { ...FIRST, prices: [] },
      { ...FIRST, packages: [], prices: [] },
      { ...FIRST, packages: [], prices: [], options: [], cancellationTiers: [], closedDates: [] },
    ];
    let version = 0;
    for (const catalog of emptied) {
      await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });
      await replaceCatalog(db, catalog, { now: NOW + 1, source: "sheet" });
      version += 2;
      assert.deepEqual(await readCatalog(db), published(catalog, version, NOW + 1));
    }

    // With no models and no vehicles left, everything that was still in service leaves it.
    await replaceCatalog(db, FIRST, { now: NOW, source: "sheet" });
    const result = await replaceCatalog(db, { ...FIRST, models: [], vehicles: [] }, { now: NOW + 1, source: "sheet" });
    version += 2;
    assert.deepEqual(sorted(result.retiredVehicles), ["O'KI-400", "OKI-100", "OKI-200", "OKI-300", "OKI-500"]);
    assert.deepEqual(sorted(result.deactivatedModels), ["o'neal-400", "vespa-125"]);
    const kept = {
      ...FIRST,
      models: FIRST.models.map((model) => ({ ...model, active: false })),
      vehicles: FIRST.vehicles.map((vehicle) => ({ ...vehicle, status: "retired" as const })),
    };
    assert.deepEqual(await readCatalog(db), published(kept, version, NOW + 1));
  } finally {
    await dispose();
  }
});

// A rental that runs past both moments. A booking with no status here is the seed helper's CONFIRMED.
const AHEAD = { start_at: NOW + DAY_MS, end_at: NOW + 5 * DAY_MS };

// atNow and atLater say whether the booking still blocks its vehicle at NOW and at LATER, worked out by hand from the
// blocking rule and "ends after now".

const BLOCKING_CASES: { label: string; booking: Partial<BookingRow>; atNow: boolean; atLater: boolean }[] = [
  { label: "confirmed", booking: { ...AHEAD, status: "CONFIRMED" }, atNow: true, atLater: true },
  { label: "payment pending", booking: { ...AHEAD, status: "PAYMENT_PENDING" }, atNow: true, atLater: true },
  { label: "a staff block", booking: { ...AHEAD, status: "CONFIRMED", source: "block" }, atNow: true, atLater: true },
  { label: "a hold past both", booking: { ...AHEAD, status: "ON_HOLD", expires_at: LATER + 1 }, atNow: true, atLater: true },
  { label: "a hold expiring", booking: { ...AHEAD, status: "ON_HOLD", expires_at: NOW + 1 }, atNow: true, atLater: false },
  { label: "a hold at its expiry", booking: { ...AHEAD, status: "ON_HOLD", expires_at: NOW }, atNow: false, atLater: false },
  { label: "a lapsed hold", booking: { ...AHEAD, status: "ON_HOLD", expires_at: NOW - HOUR_MS }, atNow: false, atLater: false },
  { label: "a hold with no expiry", booking: { ...AHEAD, status: "ON_HOLD", expires_at: null }, atNow: false, atLater: false },
  { label: "cancelled", booking: { ...AHEAD, status: "CANCELLED", expires_at: LATER + 1 }, atNow: false, atLater: false },
  { label: "expired", booking: { ...AHEAD, status: "EXPIRED", expires_at: LATER + 1 }, atNow: false, atLater: false },
  { label: "under way", booking: { start_at: NOW - DAY_MS, end_at: NOW + HOUR_MS }, atNow: true, atLater: false },
  { label: "ending in a millisecond", booking: { start_at: NOW - DAY_MS, end_at: NOW + 1 }, atNow: true, atLater: false },
  { label: "ending right now", booking: { start_at: NOW - DAY_MS, end_at: NOW }, atNow: false, atLater: false },
  { label: "ended", booking: { start_at: NOW - 2 * DAY_MS, end_at: NOW - DAY_MS }, atNow: false, atLater: false },
  { label: "ending at LATER", booking: { start_at: NOW + DAY_MS, end_at: LATER }, atNow: true, atLater: false },
  { label: "ending just past LATER", booking: { start_at: NOW + DAY_MS, end_at: LATER + 1 }, atNow: true, atLater: true },
];

test("affected bookings are reported for vehicles leaving service", async () => {
  const { replaceCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    const first = await replaceCatalog(db, FIRST, { now: NOW - DAY_MS, source: "sheet" });
    assert.deepEqual(first.affectedBookings, []);

    // OKI-300 leaves the catalog, OKI-100 goes to maintenance, OKI-200 is marked retired in the catalog itself, and
    // 沖縄 あ 12-34 was retired from the start. OKI-500 stays in service, so nothing on it is ever listed. Nor is anything on
    // O'KI-400, which stays active under a model this catalog deactivates: the rule goes by the vehicle's status alone.
    const outOfService = ["OKI-300", "OKI-100", "OKI-200", "沖縄 あ 12-34"];
    const inService = ["OKI-500", "O'KI-400"];
    const statuses: Record<string, VehicleStatus> = { "OKI-100": "maintenance", "OKI-200": "retired" };
    const remaining = without(FIRST, { plates: ["OKI-300"] });
    const next: Catalog = {
      ...remaining,
      models: deactivated(remaining.models, ["o'neal-400"]),
      vehicles: remaining.vehicles.map((vehicle) => ({ ...vehicle, status: statuses[vehicle.plate] ?? vehicle.status })),
    };

    const seeded: { row: BookingRow; atNow: boolean; atLater: boolean }[] = [];
    for (const plate of [...outOfService, ...inService]) {
      for (const { booking, atNow, atLater } of BLOCKING_CASES) {
        const row = await seedBooking(db, { ...booking, vehicle_plate: plate });
        if (outOfService.includes(plate)) seeded.push({ row, atNow, atLater });
      }
    }
    type Affected = { bookingId: string; ref: string; plate: string; startAt: number };
    const inIdOrder = (list: Affected[]) => [...list].sort((a, b) => (a.bookingId < b.bookingId ? -1 : 1));
    const expected = (entries: typeof seeded) =>
      inIdOrder(entries.map(({ row }) => ({ bookingId: row.id, ref: row.ref, plate: row.vehicle_plate, startAt: row.start_at })));

    // OKI-300 left the catalog and the catalog itself retires OKI-200, so both are listed. OKI-100 only went to maintenance
    // and 沖縄 あ 12-34 was retired already.
    const result = await replaceCatalog(db, next, { now: NOW, source: "sheet" });
    assert.deepEqual(sorted(result.retiredVehicles), ["OKI-200", "OKI-300"]);
    assert.deepEqual(inIdOrder(result.affectedBookings), expected(seeded.filter((entry) => entry.atNow)));

    // Three days on, the same catalog retires nothing new. OKI-300 left in the publish before this one and still counts,
    // and bookings that have ended or lapsed since have dropped out.
    const later = await replaceCatalog(db, next, { now: LATER, source: "sheet" });
    assert.deepEqual(later.retiredVehicles, []);
    assert.deepEqual(inIdOrder(later.affectedBookings), expected(seeded.filter((entry) => entry.atLater)));
  } finally {
    await dispose();
  }
});

test("a large catalog stays within the statement budget", async () => {
  const { db, dispose } = await createTestDb();
  try {
    // The counter sees a statement run on its own, and each entry of a batch, however few were prepared.
    const probe = watch(db);
    await probe.db.prepare("SELECT 1").first();
    await probe.db.prepare("SELECT ?1").bind(2).all();
    const repeated = probe.db.prepare("SELECT ?1");
    await probe.db.batch([repeated.bind(3), repeated.bind(4)]);
    assert.deepEqual(probe.spy, { statements: 4, direct: 2, batches: 1, injected: false });

    const { replaceCatalog, readCatalog } = await store();
    const large = largeCatalog();
    assert.deepEqual([large.models.length, large.vehicles.length, large.prices.length], [60, 200, 600]);

    const first = watch(db);
    await replaceCatalog(first.db, large, { now: NOW, source: "sheet" });
    assert.ok(first.spy.statements < 50, `the first publish ran ${first.spy.statements} statements`);
    assert.ok(first.spy.batches >= 1, "the replace goes through db.batch");
    assert.deepEqual(await readCatalog(db), published(large, 1, NOW));

    // A second publish retires and deactivates as well: 10 models leave, with the 30 vehicles assigned to them.
    const gone = {
      models: large.models.slice(50).map((model) => model.id),
      plates: large.vehicles.filter((_, i) => i % 60 >= 50).map((vehicle) => vehicle.plate),
    };
    const second = watch(db);
    const result = await replaceCatalog(second.db, without(large, gone), { now: NOW + 1, source: "sheet" });
    assert.ok(second.spy.statements < 50, `the second publish ran ${second.spy.statements} statements`);
    assert.deepEqual(sorted(result.deactivatedModels), gone.models);
    assert.deepEqual(sorted(result.retiredVehicles), gone.plates);
    assert.equal(gone.plates.length, 30);

    const kept = { ...large, models: deactivated(large.models, gone.models), vehicles: retired(large.vehicles, gone.plates) };
    assert.deepEqual(await readCatalog(db), published(kept, 2, NOW + 1));
  } finally {
    await dispose();
  }
});

test("seed/local.sql loads", async () => {
  const { replaceCatalog, readCatalog } = await store();
  const { db, dispose } = await createTestDb();
  try {
    const sql = readFileSync(new URL("../seed/local.sql", import.meta.url), "utf8");
    for (const statement of sqlStatements(sql)) await db.prepare(statement).run();

    // readCatalog returns null without a catalog_meta row, so the seed writes one too.
    const seeded = await readCatalog(db);
    assert.ok(seeded, "seed/local.sql left no published catalog");
    assert.equal(seeded.vehicleTypes.length, 2);
    assert.equal(seeded.rateClasses.length, 2);
    assert.equal(seeded.models.length, 3);
    assert.equal(seeded.vehicles.length, 5);
    assert.equal(seeded.packages.length, 3);
    assert.ok(seeded.prices.length > 0, "no prices");
    assert.ok(seeded.cancellationTiers.length > 0, "no refund tiers");
    assert.deepEqual(seeded.config, await readShopConfig(db));

    // The site reads every locale of these columns.
    for (const row of [...seeded.vehicleTypes, ...seeded.rateClasses, ...seeded.models, ...seeded.packages]) {
      assert.deepEqual(sorted(Object.keys(row.texts)), sorted([...LOCALES]), row.id);
    }
    for (const model of seeded.models) {
      for (const locale of LOCALES) {
        const { name, summary, description } = model.texts[locale];
        for (const text of [name, summary, description]) assert.ok(text, `${model.id} ${locale} is missing a text`);
      }
    }

    // What the seed wrote is a catalog the store can write back unchanged.
    const { version, publishedAt, ...catalog } = seeded;
    const result = await replaceCatalog(db, catalog, { now: publishedAt + 1, source: "admin" });
    assert.equal(result.version, version + 1);
    assert.deepEqual(result.retiredVehicles, []);
    assert.deepEqual(result.deactivatedModels, []);
    assert.deepEqual(await readCatalog(db), published(catalog, version + 1, publishedAt + 1));
  } finally {
    await dispose();
  }
});
