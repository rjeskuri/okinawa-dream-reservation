// publishCatalog over a fake SheetsClient and a real in-memory D1. Columns, last rows and counts are worked out by hand
// from tests/fixtures/sheet/valid-workbook.json, and the stored catalog is compared with the hand-written
// valid-catalog.json, read back through SQL by readCatalog. The wording of a message is #12's: past its first word, a
// cell only has to name the column at fault and the bad value, as docs/sheet-schema.md promises staff. The endpoint's
// tests are in tests/e2e/publish.e2e.ts.
//
// Two rulings on this ticket, both implementation choices recorded in the PR's Notes:
// - A status cell leads with its level, so that staff can tell a row that published from one that did not. An errored
//   row's cell starts with `error`, a warning row's with `warning`, and a row with both leads with `error`, because the
//   row is not published. How several messages share the rest of the cell is the coder's.
// - `counts` counts rows, each row once under its worst level, so a row with an error and a warning is one error. #16
//   shows these numbers to staff as `Rows: N ok, N warning, N error`, and the write-back is one value per data row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHEET_TABS, validateCatalog } from "../src/lib/catalog/sheet-schema.ts";
import { readCatalog } from "../src/lib/db/catalog-store.ts";
import { SheetsError, type SheetsClient } from "../src/lib/google/sheets.ts";
import type { Catalog, Model, Vehicle } from "../src/lib/types.ts";
import { withoutDropped, type Dropped } from "./fixtures/sheet/rule-table.ts";
import { createTestDb } from "./helpers/d1.ts";
import { seedBooking, type BookingRow, type SqlRow } from "./helpers/seed.ts";
import {
  appendCopy,
  appendRow,
  canonicalCatalog,
  CATALOG_TABS,
  expectedCatalog,
  parseStatusRange,
  rearrangeColumns,
  removeColumn,
  removeRow,
  rowWith,
  setCell,
  sheetRow,
  statusWrite,
  validWorkbook,
  type StatusWrite,
  type Workbook,
} from "./helpers/sheet-workbook.ts";

/** Loaded where it is needed, so each test reports its own failure until the module exists. */
const publish = () => import("../src/lib/catalog/publish.ts");

const DAY_MS = 86_400_000;
// Within two years of the fixture's ClosedDates, 2026-12-31 to 2027-01-02, or they become error rows. In the past, and
// far enough back that its bookings are over by the real clock, so that code reading Date.now() for `now` shows.
const NOW = Date.parse("2026-03-01T12:00:00+09:00");

/** Each catalog tab's publish_status column and last data row in the valid workbook, counted by hand. */
const STATUS_COLUMNS: Record<string, { column: string; lastRow: number }> = {
  Config: { column: "C", lastRow: 9 },
  Types: { column: "H", lastRow: 4 },
  RateClasses: { column: "I", lastRow: 5 },
  Packages: { column: "I", lastRow: 4 },
  // advance_price_jpy (#131) sits before publish_status.
  Prices: { column: "E", lastRow: 12 },
  Models: { column: "W", lastRow: 6 },
  Vehicles: { column: "G", lastRow: 7 },
  Options: { column: "K", lastRow: 3 },
  Cancellation: { column: "C", lastRow: 4 },
  ClosedDates: { column: "C", lastRow: 4 },
};

/** The data rows of the valid workbook. */
const ROWS = 48;

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

const sorted = (list: string[]): string[] => [...list].sort();

/** A SheetsClient over `workbook`. A failure is thrown after the call is counted, as the real client would. */
function fakeSheets(workbook: Workbook, failures: { batchGet?: Error; batchUpdate?: Error } = {}) {
  const calls = { gets: [] as string[][], updates: [] as StatusWrite[][], appends: 0 };
  const sheets: SheetsClient = {
    async batchGet(tabs) {
      calls.gets.push([...tabs]);
      if (failures.batchGet) throw failures.batchGet;
      return Object.fromEntries(tabs.map((tab) => [tab, structuredClone(workbook[tab] ?? [])]));
    },
    async batchUpdate(data) {
      calls.updates.push(structuredClone(data));
      if (failures.batchUpdate) throw failures.batchUpdate;
    },
    async append() {
      calls.appends += 1;
    },
  };
  return { sheets, calls };
}

async function withDb(run: (db: D1Database) => Promise<void>): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await run(db);
  } finally {
    await dispose();
  }
}

async function snapshot(db: D1Database): Promise<Record<string, SqlRow[]>> {
  const tables: Record<string, SqlRow[]> = {};
  for (const table of STORE_TABLES) {
    const { results } = await db.prepare(`SELECT * FROM ${table}`).all<SqlRow>();
    const key = (row: SqlRow) => JSON.stringify(row);
    tables[table] = [...results].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  }
  return tables;
}

async function catalogMeta(db: D1Database): Promise<SqlRow[]> {
  return (await db.prepare("SELECT * FROM catalog_meta").all<SqlRow>()).results;
}

/** The fixture's catalog after `change`. Each call reads the file again, so a change stays with its caller. */
function changed(change: (catalog: Catalog) => void): Catalog {
  const catalog = expectedCatalog();
  change(catalog);
  return catalog;
}

/** A booking as a report lists it. */
function affected({ id, ref, vehicle_plate, start_at }: BookingRow) {
  return { bookingId: id, ref, plate: vehicle_plate, startAt: start_at };
}

function assertNames(cell: unknown, label: string, words: string[]): void {
  assert.equal(typeof cell, "string", `${label}: ${JSON.stringify(cell)}`);
  for (const word of words) assert.ok((cell as string).includes(word), `${label}: "${cell}" does not name ${word}`);
}

/** The cell of a row that is not published. */
function assertError(cell: unknown, label: string, words: string[]): void {
  assertNames(cell, label, words);
  assert.match(cell as string, /^error\b/i, `${label} leads with its level`);
}

/** The cell of a row that is published, but that staff should check. */
function assertWarning(cell: unknown, label: string, words: string[]): void {
  assertNames(cell, label, words);
  assert.match(cell as string, /^warning\b/i, `${label} leads with its level`);
}

/** Every catalog tab's cells: `ok`, except the rows in `errors`, which name the words given for `Tab row`. */
function assertCells(data: StatusWrite[], errors: Record<string, string[]>): void {
  for (const [tab, { lastRow }] of Object.entries(STATUS_COLUMNS)) {
    const { cells } = statusWrite(data, tab);
    assert.equal(cells.length, lastRow - 1, `${tab} has one cell per row`);
    for (const [index, cell] of cells.entries()) {
      const label = `${tab} ${index + 2}`;
      if (errors[label]) assertError(cell, label, errors[label]);
      else assert.equal(cell, "ok", label);
    }
  }
}

test("publishing the valid fixture stores the catalog and writes ok statuses", async () => {
  const { publishCatalog } = await publish();
  await withDb(async (db) => {
    const { sheets, calls } = fakeSheets(validWorkbook());
    const report = await publishCatalog({ db, sheets, now: NOW });

    assert.deepEqual(report, {
      ok: true,
      version: 1,
      counts: { ok: ROWS, warning: 0, error: 0 },
      fatal: [],
      affectedBookings: [],
    });
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expectedCatalog()));
    assert.deepEqual(await catalogMeta(db), [{ id: 1, version: 1, published_at: NOW, source: "sheet" }]);

    assert.equal(calls.updates.length, 1);
    // The fixture holds a stale error in Config row 4, and this overwrites it too.
    assertCells(calls.updates[0], {});
  });
});

test("each publish stores what the sheet says now", async () => {
  const { publishCatalog } = await publish();
  const steps: {
    name: string;
    edit: (workbook: Workbook) => void;
    change: (catalog: Catalog) => void;
    rows: number;
    lastRows?: Record<string, number>;
  }[] = [
    {
      name: "a new price",
      edit: (workbook) => setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", 5300),
      change: (catalog) => {
        const price = catalog.prices.find(
          ({ rateClassId, packageId }) => rateClassId === "bike-125" && packageId === "day-1",
        );
        assert.ok(price);
        price.priceJpy = 5300;
      },
      rows: ROWS,
    },
    {
      name: "a new Config value",
      edit: (workbook) => setCell(workbook, "Config", "hold_minutes", "value", 45),
      change: (catalog) => {
        catalog.config.holdMinutes = 45;
      },
      rows: ROWS,
    },
    {
      name: "a vehicle added below the last",
      edit: (workbook) => appendCopy(workbook, "Vehicles", "わ1001", { plate: "わ1007" }),
      change: (catalog) => {
        const copied = catalog.vehicles.find(({ plate }) => plate === "わ1001");
        assert.ok(copied);
        catalog.vehicles.push({ ...copied, plate: "わ1007" });
      },
      rows: ROWS + 1,
      lastRows: { Vehicles: 8 },
    },
    {
      name: "an option removed and a refund tier added",
      edit: (workbook) => {
        removeRow(workbook, "Options", "helmet");
        appendRow(workbook, "Cancellation", { min_days_before: 1, refund_percent: 25 });
      },
      change: (catalog) => {
        catalog.options = catalog.options.filter(({ id }) => id !== "helmet");
        catalog.cancellationTiers.push({ minDaysBefore: 1, refundPercent: 25 });
      },
      rows: ROWS,
      lastRows: { Options: 2, Cancellation: 5 },
    },
  ];

  for (const [index, { name, edit, change, rows, lastRows }] of steps.entries()) {
    await withDb(async (db) => {
      const workbook = validWorkbook();
      edit(workbook);
      const { sheets, calls } = fakeSheets(workbook);

      const report = await publishCatalog({ db, sheets, now: NOW + index });

      assert.deepEqual(report.counts, { ok: rows, warning: 0, error: 0 }, name);
      assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(changed(change)), name);
      for (const [tab, { lastRow }] of Object.entries(STATUS_COLUMNS)) {
        const expected = lastRows?.[tab] ?? lastRow;
        assert.equal(statusWrite(calls.updates[0], tab).lastRow, expected, `${name}: ${tab}`);
      }
    });
  }
});

test("each publish raises the version and records its time", async () => {
  const { publishCatalog } = await publish();
  await withDb(async (db) => {
    const publishAt = async (now: number) => publishCatalog({ db, now, sheets: fakeSheets(validWorkbook()).sheets });

    assert.equal((await publishAt(NOW)).version, 1);
    assert.equal((await publishAt(NOW + 60_000)).version, 2);
    assert.deepEqual(await catalogMeta(db), [{ id: 1, version: 2, published_at: NOW + 60_000, source: "sheet" }]);

    await db.prepare("UPDATE catalog_meta SET version = 41").run();
    assert.equal((await publishAt(NOW + 120_000)).version, 42);
    assert.deepEqual(await catalogMeta(db), [{ id: 1, version: 42, published_at: NOW + 120_000, source: "sheet" }]);
  });
});

test("a publish makes one batchGet, one batchUpdate and one D1 batch", async () => {
  const { publishCatalog } = await publish();
  await withDb(async (db) => {
    const spy = { batches: 0, batched: 0, prepared: 0 };
    const counted = {
      prepare(sql: string) {
        spy.prepared += 1;
        return db.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        spy.batches += 1;
        spy.batched += statements.length;
        return db.batch(statements);
      },
    } as unknown as D1Database;
    const { sheets, calls } = fakeSheets(validWorkbook());

    await publishCatalog({ db: counted, sheets, now: NOW });

    assert.equal(calls.gets.length, 1);
    assert.deepEqual(sorted(calls.gets[0]), sorted(CATALOG_TABS), "the catalog tabs and no others");
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.appends, 0, "PublishLog is the Apps Script's");
    assert.equal(spy.batches, 1);
    assert.equal(spy.prepared, spy.batched, "every statement goes through the one batch");
  });
});

test("the write-back covers each catalog tab's publish_status column from row 2 to its last data row", async () => {
  // Blocks has a publish_status column too, but this publish does not read it: #21 writes that column.
  const withStatus = Object.entries(SHEET_TABS).flatMap(([tab, columns]) =>
    (columns as readonly string[]).includes("publish_status") ? [tab] : [],
  );
  assert.deepEqual(sorted(withStatus), sorted([...Object.keys(STATUS_COLUMNS), "Blocks"]));

  const { publishCatalog } = await publish();
  await withDb(async (db) => {
    const { sheets, calls } = fakeSheets(validWorkbook());
    await publishCatalog({ db, sheets, now: NOW });

    const [data] = calls.updates;
    const written = data.map(({ range }) => parseStatusRange(range).tab);
    assert.deepEqual(sorted(written), sorted(Object.keys(STATUS_COLUMNS)));
    for (const [tab, { column, lastRow }] of Object.entries(STATUS_COLUMNS)) {
      const write = statusWrite(data, tab);
      assert.deepEqual([write.column, write.firstRow, write.lastRow], [column, 2, lastRow], tab);
    }
  });
});

// Each sheet breaks rows at the top, middle and bottom of their tabs and in the rows that depend on them, so errors that
// drift to one end of a column show, and the two sheets differ so that no list of rows passes both. Every bad row here
// carries one message: "a row with several messages takes one cell" has those that do not.
const BAD_SHEETS: {
  name: string;
  edits: [tab: string, key: string, column: string, value: unknown][];
  errors: Record<string, string[]>;
  drop: Dropped;
}[] = [
  {
    name: "single bad rows",
    edits: [
      ["Prices", "scooter-50/hours-6", "price_jpy", "abc"],
      ["Prices", "bike-400/day-1", "price_jpy", 0],
      ["Prices", "car-k/day-3", "price_jpy", -5],
      ["Vehicles", "わ1006", "status", "lost"],
      ["Options", "helmet", "group", "boat"],
      ["Cancellation", "3", "refund_percent", 150],
      ["ClosedDates", "2027-01-01", "date", "soon"],
      ["Models", "cub-110", "engine_cc", "big"],
    ],
    errors: {
      "Prices 2": ["price_jpy", "abc"],
      "Prices 9": ["price_jpy", "0"],
      "Prices 12": ["price_jpy", "-5"],
      "Vehicles 7": ["status", "lost"],
      "Options 2": ["group", "boat"],
      "Cancellation 3": ["refund_percent", "150"],
      "ClosedDates 3": ["date", "soon"],
      "Models 4": ["engine_cc", "big"],
      "Vehicles 5": ["model_id", "cub-110"],
    },
    drop: {
      prices: ["scooter-50/hours-6", "bike-400/day-1", "car-k/day-3"],
      vehicles: ["わ1006", "わ1004"],
      options: ["helmet"],
      cancellationTiers: [3],
      closedDates: ["2027-01-01"],
      models: ["cub-110"],
    },
  },
  {
    name: "a bad rate class and the rows that hang on it",
    edits: [
      ["RateClasses", "bike-400", "group", "boat"],
      ["Prices", "bike-125/hours-6", "price_jpy", "free"],
      ["Vehicles", "わ1001", "status", "gone"],
    ],
    errors: {
      "RateClasses 4": ["group", "boat"],
      "Prices 5": ["price_jpy", "free"],
      "Prices 8": ["rate_class_id", "bike-400"],
      "Prices 9": ["rate_class_id", "bike-400"],
      "Prices 10": ["rate_class_id", "bike-400"],
      "Models 5": ["rate_class_id", "bike-400"],
      "Vehicles 2": ["status", "gone"],
      "Vehicles 6": ["model_id", "rebel-250"],
    },
    drop: {
      rateClasses: ["bike-400"],
      prices: ["bike-125/hours-6", "bike-400/hours-6", "bike-400/day-1", "bike-400/day-3"],
      models: ["rebel-250"],
      vehicles: ["わ1001", "わ1005"],
    },
  },
];

test("bad rows are skipped and their errors written back in row order", async () => {
  const { publishCatalog } = await publish();
  for (const { name, edits, errors, drop } of BAD_SHEETS) {
    await withDb(async (db) => {
      const workbook = validWorkbook();
      for (const [tab, key, column, value] of edits) setCell(workbook, tab, key, column, value);
      const { sheets, calls } = fakeSheets(workbook);

      const report = await publishCatalog({ db, sheets, now: NOW });

      const bad = Object.keys(errors).length;
      assert.equal(report.ok, true, name);
      assert.equal(report.version, 1, name);
      assert.deepEqual(report.fatal, [], name);
      assert.deepEqual(report.counts, { ok: ROWS - bad, warning: 0, error: bad }, name);
      assert.deepEqual(
        canonicalCatalog(await readCatalog(db)),
        canonicalCatalog(withoutDropped(expectedCatalog(), drop)),
        name,
      );
      assert.equal(calls.updates.length, 1, name);
      assertCells(calls.updates[0], errors);
    });
  }
});

test("publishCatalog checks ClosedDates against the now it is given, not the real clock", async () => {
  const { publishCatalog } = await publish();
  // The fixture's dates are 2026-12-31 to 2027-01-02, and a publish takes dates within two years of its `now`. The
  // second clock keeps one of them, so it still tells the two clocks apart once the real one has left all three behind.
  const CLOCKS: { name: string; now: number; errors: Record<string, string[]>; drop: Dropped }[] = [
    {
      name: "a clock past all three dates",
      now: Date.parse("2029-03-01T12:00:00+09:00"),
      errors: {
        "ClosedDates 2": ["date", "46387"],
        "ClosedDates 3": ["date", "2027-01-01"],
        "ClosedDates 4": ["date", "46389"],
      },
      drop: { closedDates: ["2026-12-31", "2027-01-01", "2027-01-02"] },
    },
    {
      name: "a clock that reaches only the first date",
      now: Date.parse("2024-12-31T12:00:00+09:00"),
      errors: {
        "ClosedDates 3": ["date", "2027-01-01"],
        "ClosedDates 4": ["date", "46389"],
      },
      drop: { closedDates: ["2027-01-01", "2027-01-02"] },
    },
  ];

  for (const { name, now, errors, drop } of CLOCKS) {
    await withDb(async (db) => {
      const { sheets, calls } = fakeSheets(validWorkbook());

      const report = await publishCatalog({ db, sheets, now });

      // Everything but those rows publishes as usual, so what failed here is the clock.
      const bad = Object.keys(errors).length;
      const counts = { ok: ROWS - bad, warning: 0, error: bad };
      assert.deepEqual(report, { ok: true, version: 1, counts, fatal: [], affectedBookings: [] }, name);
      assert.deepEqual(
        canonicalCatalog(await readCatalog(db)),
        canonicalCatalog(withoutDropped(expectedCatalog(), drop)),
        name,
      );
      assert.deepEqual(await catalogMeta(db), [{ id: 1, version: 1, published_at: now, source: "sheet" }], name);
      assert.equal(calls.updates.length, 1, name);
      assertCells(calls.updates[0], errors);
    });
  }
});

test("a warning publishes the row and shows in its cell", async () => {
  const { publishCatalog } = await publish();
  await withDb(async (db) => {
    const workbook = validWorkbook();
    setCell(workbook, "Types", "car", "name_ko", "");
    appendRow(workbook, "Config", { key: "mystery", value: "1" });
    const { sheets, calls } = fakeSheets(workbook);

    const report = await publishCatalog({ db, sheets, now: NOW });

    // The Types row turns from ok to warning, and the Config row is a new one.
    assert.deepEqual(report.counts, { ok: ROWS - 1, warning: 2, error: 0 });
    assert.equal(report.ok, true);

    const expected = changed((catalog) => {
      const car = catalog.vehicleTypes.find(({ id }) => id === "car");
      assert.ok(car);
      car.texts.ko.name = car.texts.en.name;
    });
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expected));

    const [data] = calls.updates;
    assertWarning(statusWrite(data, "Types").cells[2], "Types 4", ["name_ko"]);
    const config = statusWrite(data, "Config");
    assert.equal(config.lastRow, 10);
    assertWarning(config.cells[8], "Config 10", ["mystery"]);
  });
});

test("a row with several messages takes one cell", async () => {
  const { publishCatalog } = await publish();
  await withDb(async (db) => {
    const workbook = validWorkbook();
    // Two warnings on a row that publishes, two errors on a row that does not, and one of each in both orders: the
    // validator reports cub-110's error first, and nbox-660's warning first, since the licence of a car is read before
    // its brand.
    setCell(workbook, "Types", "car", "name_ko", "");
    setCell(workbook, "Types", "car", "name_zh", "");
    setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", "abc");
    setCell(workbook, "Prices", "bike-125/day-1", "rate_class_id", "nope");
    setCell(workbook, "Models", "cub-110", "engine_cc", "big");
    setCell(workbook, "Models", "cub-110", "name_ko", "");
    setCell(workbook, "Models", "nbox-660", "license_class", "large");
    setCell(workbook, "Models", "nbox-660", "brand", "");
    const { sheets, calls } = fakeSheets(workbook);

    const report = await publishCatalog({ db, sheets, now: NOW });

    assert.equal(report.ok, true);
    // By message this would be 4 warnings and 6 errors. The errors are Prices 6, the two models and their two vehicles.
    assert.deepEqual(report.counts, { ok: ROWS - 6, warning: 1, error: 5 });

    const [data] = calls.updates;
    const types = statusWrite(data, "Types");
    const prices = statusWrite(data, "Prices");
    const models = statusWrite(data, "Models");
    assert.equal(types.cells.length, 3);
    assert.equal(prices.cells.length, 11);
    assert.equal(models.cells.length, 5);
    assertWarning(types.cells[2], "Types 4", ["name_ko", "name_zh"]);
    assertError(prices.cells[4], "Prices 6", ["price_jpy", "rate_class_id"]);
    assertError(models.cells[2], "Models 4", ["engine_cc", "name_ko"]);
    assertError(models.cells[4], "Models 6", ["license_class", "brand"]);
    // The rows after each one sit where they did.
    assert.equal(prices.cells[5], "ok");
    assert.equal(models.cells[3], "ok");

    const stored = await readCatalog(db);
    assert.ok(stored);
    assert.ok(stored.vehicleTypes.some(({ id }) => id === "car"), "warnings do not stop a row");
    assert.ok(!stored.models.some(({ id }) => id === "cub-110"), "an error among warnings stops it");
    assert.ok(!stored.models.some(({ id }) => id === "nbox-660"), "an error after a warning stops it too");
  });
});

test("rows with no data take no status and lose their old message", async () => {
  const { publishCatalog } = await publish();
  await withDb(async (db) => {
    const workbook = validWorkbook();

    // Vehicles: a row cleared by hand that kept its old message, then a wholly blank row, then a bad row below both.
    setCell(workbook, "Vehicles", "わ1005", "status", "lost");
    workbook.Vehicles.splice(2, 0, rowWith(workbook, "Vehicles", { publish_status: "error: from an old publish" }));
    workbook.Vehicles.splice(4, 0, []);

    // Models: a checkbox column stores false in every row, so the blank rows are not blank to Google. One sits among the
    // models and three below them, and none of those is the tab's last data row.
    const unticked = rowWith(workbook, "Models", { active: false });
    workbook.Models.splice(3, 0, unticked);
    workbook.Models.push(unticked, unticked, unticked);

    // These two tabs have nothing below the header.
    workbook.Options = [workbook.Options[0]];
    workbook.ClosedDates = [workbook.ClosedDates[0]];

    const { sheets, calls } = fakeSheets(workbook);
    const report = await publishCatalog({ db, sheets, now: NOW });

    // A row with no data is not a row: the 5 rows taken from Options and ClosedDates are gone, and no blank row counts.
    assert.deepEqual(report.counts, { ok: ROWS - 6, warning: 0, error: 1 });

    const [data] = calls.updates;
    // "" clears a cell. null would leave the old message in place, because Google skips null in a RAW write.
    const vehicles = statusWrite(data, "Vehicles");
    assert.equal(vehicles.lastRow, 9);
    assertNames(vehicles.cells[6], "Vehicles 8", ["status", "lost"]);
    assert.deepEqual(vehicles.cells.toSpliced(6, 1), ["ok", "", "ok", "", "ok", "ok", "ok"]);

    const models = statusWrite(data, "Models");
    assert.equal(models.lastRow, 7);
    assert.deepEqual(models.cells, ["ok", "ok", "", "ok", "ok", "ok"]);

    for (const tab of ["Options", "ClosedDates"]) {
      const writes = data.filter(({ range }) => parseStatusRange(range).tab === tab);
      assert.deepEqual(writes.flatMap(({ values }) => values), [], `${tab} has no row to write`);
    }

    const stored = await readCatalog(db);
    assert.ok(stored);
    assert.deepEqual([stored.options, stored.closedDates], [[], []]);
  });
});

test("a message from the last publish is replaced", async () => {
  const { publishCatalog } = await publish();
  await withDb(async (db) => {
    const workbook = validWorkbook();
    setCell(workbook, "Options", "child-seat", "group", "boat");
    const first = fakeSheets(workbook);
    await publishCatalog({ db, sheets: first.sheets, now: NOW });
    const message = statusWrite(first.calls.updates[0], "Options").cells[1];
    assertNames(message, "Options 3", ["group", "boat"]);

    // The next sheet holds what that write left there. The row is fixed, and another row breaks under a stale ok.
    setCell(workbook, "Options", "child-seat", "group", "car");
    setCell(workbook, "Options", "child-seat", "publish_status", message);
    setCell(workbook, "Options", "helmet", "publish_status", "ok");
    setCell(workbook, "Options", "helmet", "group", "boat");
    const second = fakeSheets(workbook);
    await publishCatalog({ db, sheets: second.sheets, now: NOW + 1 });

    const { cells } = statusWrite(second.calls.updates[0], "Options");
    assertNames(cells[0], "Options 2", ["group", "boat"]);
    assert.equal(cells[1], "ok");
  });
});

test("the write-back follows the publish_status header wherever it stands", async () => {
  const { publishCatalog } = await publish();

  /** Adds staff columns ahead of publish_status, which the checks ignore. */
  const pushStatusAlong = (workbook: Workbook, tab: string, count: number) => {
    const [header, ...rows] = workbook[tab];
    const at = header.indexOf("publish_status");
    const added = Array.from({ length: count }, (_, index) => `staff_note_${index}`);
    header.splice(at, 0, ...added);
    for (const row of rows) if (row.length > at) row.splice(at, 0, ...added.map(() => ""));
  };

  await withDb(async (db) => {
    const workbook = validWorkbook();
    rearrangeColumns(workbook, "Prices", (indexes) => [...indexes].reverse(), (header) => header.toUpperCase());
    rearrangeColumns(
      workbook,
      "Vehicles",
      (indexes) => [indexes[0], indexes[6], ...indexes.slice(1, 6)],
      (header) => ` ${header[0].toUpperCase()}${header.slice(1)} `,
    );
    pushStatusAlong(workbook, "Models", 3);
    pushStatusAlong(workbook, "Types", 19);
    pushStatusAlong(workbook, "Packages", 44);
    const { sheets, calls } = fakeSheets(workbook);

    const report = await publishCatalog({ db, sheets, now: NOW });

    assert.deepEqual(report.counts, { ok: ROWS, warning: 0, error: 0 });
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expectedCatalog()));
    const columns = { Prices: "A", Vehicles: "B", Models: "Z", Types: "AA", Packages: "BA", Config: "C" };
    for (const [tab, column] of Object.entries(columns)) {
      const write = statusWrite(calls.updates[0], tab);
      assert.equal(write.column, column, tab);
      assert.equal(write.lastRow, STATUS_COLUMNS[tab].lastRow, tab);
      assert.ok(write.cells.every((cell) => cell === "ok"), tab);
    }
  });
});

test("bookings on a bike leaving service are reported", async () => {
  const { publishCatalog } = await publish();
  const PLATE = "わ1002";
  const LEAVES: [string, (workbook: Workbook) => void][] = [
    ["retired in the sheet", (workbook) => setCell(workbook, "Vehicles", PLATE, "status", "retired")],
    ["sent to maintenance", (workbook) => setCell(workbook, "Vehicles", PLATE, "status", "maintenance")],
    ["removed from the sheet", (workbook) => removeRow(workbook, "Vehicles", PLATE)],
    // Since #136 a bad Vehicles or Models row keeps the bike it had, so only these take it out of service now.
    ["its model removed from the sheet", (workbook) => removeRow(workbook, "Models", "pcx-125")],
    ["skipped with its rate class", (workbook) => setCell(workbook, "RateClasses", "bike-125", "group", "boat")],
  ];

  for (const [name, edit] of LEAVES) {
    await withDb(async (db) => {
      await publishCatalog({ db, sheets: fakeSheets(validWorkbook()).sheets, now: NOW - DAY_MS });

      const start_at = NOW + 2 * DAY_MS;
      const later = await seedBooking(db, { vehicle_plate: PLATE, start_at: start_at + DAY_MS });
      const sooner = await seedBooking(db, { vehicle_plate: PLATE, start_at });
      // None of these three counts: ended before now, cancelled, and on a bike that stays.
      await seedBooking(db, { vehicle_plate: PLATE, start_at: NOW - 3 * DAY_MS, end_at: NOW });
      await seedBooking(db, { vehicle_plate: PLATE, status: "CANCELLED", start_at });
      await seedBooking(db, { vehicle_plate: "わ1001", start_at });

      const workbook = validWorkbook();
      edit(workbook);
      const report = await publishCatalog({ db, sheets: fakeSheets(workbook).sheets, now: NOW });

      assert.equal(report.ok, true, name);
      assert.deepEqual(report.affectedBookings, [affected(sooner), affected(later)], name);
    });
  }
});

test("a fatal sheet changes nothing", async () => {
  const { publishCatalog } = await publish();
  const FATAL: [string, (workbook: Workbook) => void, string[]][] = [
    ["a missing header", (workbook) => removeColumn(workbook, "Types", "sort"), ["Types", "sort"]],
    [
      "a missing publish_status header",
      (workbook) => removeColumn(workbook, "Prices", "publish_status"),
      ["Prices", "publish_status"],
    ],
    [
      "two missing headers",
      (workbook) => {
        removeColumn(workbook, "Types", "sort");
        removeColumn(workbook, "Models", "brand");
      },
      ["Types", "sort", "Models", "brand"],
    ],
    [
      "an empty tab",
      (workbook) => {
        workbook.Vehicles = [];
      },
      ["Vehicles"],
    ],
    ["a missing Config key", (workbook) => removeRow(workbook, "Config", "slot_minutes"), ["slot_minutes"]],
    ["a bad Config value", (workbook) => setCell(workbook, "Config", "hold_minutes", "value", "soon"), ["hold_minutes"]],
    [
      "shop hours the wrong way round",
      (workbook) => setCell(workbook, "Config", "shop_close", "value", "08:00"),
      ["shop_close"],
    ],
    [
      "a bad row beside a missing header",
      (workbook) => {
        setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", "abc");
        removeColumn(workbook, "Options", "sort");
      },
      ["Options", "sort"],
    ],
  ];

  for (const [name, edit, words] of FATAL) {
    const workbook = validWorkbook();
    edit(workbook);
    const fatal = validateCatalog(structuredClone(workbook), NOW).fatal;

    const check = async (db: D1Database, label: string) => {
      const before = await snapshot(db);
      const { sheets, calls } = fakeSheets(workbook);

      const report = await publishCatalog({ db, sheets, now: NOW });

      assert.equal(report.ok, false, label);
      assert.deepEqual(report.fatal, fatal, label);
      assert.ok(report.fatal.length > 0, label);
      for (const word of words) assert.ok(report.fatal.join(" ").includes(word), `${label}: no mention of ${word}`);
      assert.equal(report.version, undefined, label);
      assert.deepEqual(report.affectedBookings, [], label);
      for (const count of Object.values(report.counts)) assert.equal(typeof count, "number", label);

      assert.equal(calls.gets.length, 1, label);
      assert.deepEqual(calls.updates, [], `${label}: nothing is written to the sheet`);
      assert.equal(calls.appends, 0, label);
      assert.deepEqual(await snapshot(db), before, `${label}: nothing changes in D1`);
    };

    // With a catalog in place, whose bookings the sheet would otherwise touch, and before any publish.
    await withDb(async (db) => {
      await publishCatalog({ db, sheets: fakeSheets(validWorkbook()).sheets, now: NOW - DAY_MS });
      await seedBooking(db, { vehicle_plate: "わ1002" });
      await check(db, `${name}, after a publish`);
    });
    await withDb(async (db) => {
      await check(db, `${name}, before any publish`);
      assert.equal(await readCatalog(db), null, name);
    });
  }
});

test("a Sheets failure leaves the catalog unchanged", async () => {
  const { publishCatalog } = await publish();
  const FAILURES: [string, Error][] = [
    ["a 503 after the retries ran out", new SheetsError(503)],
    ["a 403", new SheetsError(403)],
    ["a 200 of the wrong shape", new SheetsError(200, "Sheets response has no valueRanges")],
    ["a network failure", new TypeError("fetch failed")],
    ["no token", new Error("Google token request failed: 400 invalid_grant")],
  ];

  await withDb(async (db) => {
    await publishCatalog({ db, sheets: fakeSheets(validWorkbook()).sheets, now: NOW - DAY_MS });
    await seedBooking(db, { vehicle_plate: "わ1002" });
    const before = await snapshot(db);

    // A resolved report answers 200, so a failure the endpoint turns into a 502 has to reject.
    for (const [name, error] of FAILURES) {
      const workbook = validWorkbook();
      setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", 5300);
      const { sheets, calls } = fakeSheets(workbook, { batchGet: error });

      await assert.rejects(publishCatalog({ db, sheets, now: NOW }), name);

      assert.deepEqual(calls.updates, [], name);
      assert.deepEqual(await snapshot(db), before, name);
    }
  });
});

test("a failed status write rejects the publish", async () => {
  const { publishCatalog } = await publish();
  // The owner's ruling on the ticket: the outline's order stands, so D1 commits before this write and the new catalog
  // stays. A resolved report answers 200, so the publish still rejects, and pressing Publish again rewrites the statuses.
  // That costs one more version and loses nothing: the bike has left by then, but AFFECTED_SQL reads current state, so
  // the second press reports the bookings the first would have. The message for staff is in tests/e2e/publish.e2e.ts.
  const PLATE = "わ1002";
  const workbook = validWorkbook();
  setCell(workbook, "Vehicles", PLATE, "status", "retired");
  setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", 5300);
  setCell(workbook, "Options", "helmet", "group", "boat");
  const errors = { "Options 2": ["group", "boat"] };
  const expected = withoutDropped(
    changed((catalog) => {
      const vehicle = catalog.vehicles.find(({ plate }) => plate === PLATE);
      const price = catalog.prices.find(
        ({ rateClassId, packageId }) => rateClassId === "bike-125" && packageId === "day-1",
      );
      assert.ok(vehicle && price);
      vehicle.status = "retired";
      price.priceJpy = 5300;
    }),
    { options: ["helmet"] },
  );

  for (const error of [new SheetsError(403), new SheetsError(503), new TypeError("fetch failed")]) {
    await withDb(async (db) => {
      await publishCatalog({ db, sheets: fakeSheets(validWorkbook()).sheets, now: NOW - DAY_MS });
      const start_at = NOW + 2 * DAY_MS;
      const later = await seedBooking(db, { vehicle_plate: PLATE, start_at: start_at + DAY_MS });
      const sooner = await seedBooking(db, { vehicle_plate: PLATE, start_at });
      await seedBooking(db, { vehicle_plate: "わ1001", start_at });

      const failed = fakeSheets(workbook, { batchUpdate: error });
      await assert.rejects(publishCatalog({ db, sheets: failed.sheets, now: NOW }));

      assert.equal(failed.calls.updates.length, 1, "the client already retries, so this does not");
      assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expected), "the commit stands");
      assert.deepEqual(await catalogMeta(db), [{ id: 1, version: 2, published_at: NOW, source: "sheet" }]);

      const working = fakeSheets(workbook);
      const report = await publishCatalog({ db, sheets: working.sheets, now: NOW + 60_000 });

      assert.deepEqual(report, {
        ok: true,
        version: 3,
        counts: { ok: ROWS - 1, warning: 0, error: 1 },
        fatal: [],
        affectedBookings: [affected(sooner), affected(later)],
      });
      assert.equal(working.calls.updates.length, 1);
      assertCells(working.calls.updates[0], errors);
      assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expected));
      assert.deepEqual(await catalogMeta(db), [{ id: 1, version: 3, published_at: NOW + 60_000, source: "sheet" }]);
    });
  }
});

test("a failed D1 write leaves the sheet alone", async () => {
  const { publishCatalog } = await publish();
  await withDb(async (db) => {
    const refusing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async () => {
        throw new Error("D1_ERROR: refused by the test");
      },
    } as unknown as D1Database;
    const { sheets, calls } = fakeSheets(validWorkbook());

    await assert.rejects(publishCatalog({ db: refusing, sheets, now: NOW }));

    // `ok` tells staff the row is published, and none is.
    assert.deepEqual(calls.updates, []);
    assert.equal(await readCatalog(db), null);
  });
});

// #135: a Prices row with an error of its own keeps the price the site already has, so the package stays bookable. The
// row is still an error, and its cell names the problem and the price kept, both prices where the stored row has an
// advance price. A row with no stored price is left out as before, and its cell says the package is not bookable. A
// removed row, a skipped rate class or package and a repeat row behave as before. Every stored price below is checked
// against the hand-written fixture catalog plus the advance prices FIRST_ADVANCE adds, never against the code's output.

/** Advance prices the first publish of a #135 test adds, so a kept row has both prices to keep. */
const FIRST_ADVANCE: Record<string, number> = { "bike-125/day-1": 4800, "car-k/day-1": 6900, "bike-400/hours-6": 5550 };

/** The fixture's workbook with FIRST_ADVANCE in its cells. */
function publishedWorkbook(): Workbook {
  const workbook = validWorkbook();
  for (const [key, advance] of Object.entries(FIRST_ADVANCE)) setCell(workbook, "Prices", key, "advance_price_jpy", advance);
  return workbook;
}

/** The catalog publishedWorkbook stores. */
function publishedCatalog(): Catalog {
  const catalog = expectedCatalog();
  for (const price of catalog.prices) {
    price.advancePriceJpy = FIRST_ADVANCE[`${price.rateClassId}/${price.packageId}`] ?? null;
  }
  return catalog;
}

/** A price as a person reads it, as the ticket writes 4,000: thousands grouped by commas. */
const grouped = (jpy: number): string => jpy.toLocaleString("en-US");

type StoredPrice = { price_jpy: number; advance_price_jpy: number | null };

async function storedPrice(db: D1Database, key: string): Promise<StoredPrice | null> {
  const [rateClassId, packageId] = key.split("/");
  return db
    .prepare("SELECT price_jpy, advance_price_jpy FROM prices WHERE rate_class_id = ?1 AND package_id = ?2")
    .bind(rateClassId, packageId)
    .first<StoredPrice>();
}

/** Publishes `workbook` and returns the report with the Prices tab's cells. */
async function publishPrices(db: D1Database, workbook: Workbook, now: number) {
  const { publishCatalog } = await publish();
  const { sheets, calls } = fakeSheets(workbook);
  const report = await publishCatalog({ db, sheets, now });
  assert.equal(calls.updates.length, 1, "one status write");
  return { report, data: calls.updates[0], prices: statusWrite(calls.updates[0], "Prices").cells };
}

/** The Prices cell of the row named `key` in `workbook`. */
function priceCell(workbook: Workbook, cells: unknown[], key: string): unknown {
  return cells[sheetRow(workbook, "Prices", key) - 2];
}

/** The cell of a row that keeps the stored price: an error naming its problem and every price kept, not "not bookable". */
function assertKeptCell(cell: unknown, label: string, problem: string[], kept: StoredPrice): void {
  const prices = [kept.price_jpy, kept.advance_price_jpy].flatMap((jpy) => (jpy === null ? [] : [grouped(jpy)]));
  assertError(cell, label, [...problem, ...prices]);
  assert.doesNotMatch(cell as string, /not bookable/i, `${label}: the package stays bookable`);
}

/** The cell of a row left out with no price to keep. */
function assertNotBookableCell(cell: unknown, label: string, problem: string[]): void {
  assertError(cell, label, problem);
  assert.match(cell as string, /not bookable/i, `${label} says the package is not bookable`);
}

/** The stored price of each key in `catalog`, as the prices table holds it. */
function priceOf(catalog: Catalog, key: string): StoredPrice {
  const price = catalog.prices.find(({ rateClassId, packageId }) => `${rateClassId}/${packageId}` === key);
  assert.ok(price, `the catalog has no price ${key}`);
  return { price_jpy: price.priceJpy, advance_price_jpy: price.advancePriceJpy };
}

test("a bad Prices row keeps the last published price", async () => {
  // [row, bad price_jpy]: rows with and without an advance price, at the top, middle and bottom of the tab.
  const BAD: [key: string, cell: unknown][] = [
    ["scooter-50/hours-6", -5],
    ["bike-125/day-1", "abc"],
    ["bike-400/hours-6", 0],
    ["car-k/day-3", "-1,000"],
  ];
  await withDb(async (db) => {
    const first = await publishPrices(db, publishedWorkbook(), NOW);
    assert.equal(first.report.version, 1);
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(publishedCatalog()));

    const workbook = publishedWorkbook();
    for (const [key, cell] of BAD) setCell(workbook, "Prices", key, "price_jpy", cell);
    const { report, data, prices } = await publishPrices(db, workbook, NOW + 60_000);

    // The catalog changes, as the rows stay errors.
    assert.equal(report.ok, true);
    assert.equal(report.version, 2);
    assert.deepEqual(report.counts, { ok: ROWS - BAD.length, warning: 0, error: BAD.length });
    assert.deepEqual(await catalogMeta(db), [{ id: 1, version: 2, published_at: NOW + 60_000, source: "sheet" }]);

    // Each bad row's key keeps the first publish's row, both prices, and nothing else in the catalog moves.
    for (const [key] of BAD) assert.deepEqual(await storedPrice(db, key), priceOf(publishedCatalog(), key), key);
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(publishedCatalog()));

    for (const [key, cell] of BAD) {
      assertKeptCell(priceCell(workbook, prices, key), key, ["price_jpy", String(cell)], priceOf(publishedCatalog(), key));
    }
    const badRows = new Set(BAD.map(([key]) => sheetRow(workbook, "Prices", key)));
    for (const [index, cell] of prices.entries()) {
      if (!badRows.has(index + 2)) assert.equal(cell, "ok", `Prices ${index + 2}`);
    }
    // The other tabs are untouched by the rule.
    const { Prices: _prices, ...others } = STATUS_COLUMNS;
    for (const tab of Object.keys(others)) {
      assert.ok(statusWrite(data, tab).cells.every((cell) => cell === "ok"), tab);
    }
  });
});

test("a bad advance_price_jpy keeps the whole stored row", async () => {
  // [row, new price_jpy, bad advance_price_jpy]. Each new price_jpy is valid on its own and differs from the stored
  // one, so a row that took it with the stored advance price, or with none, shows.
  const BAD: [key: string, price: number, advance: unknown][] = [
    // Stored with an advance price: above the new price, and not a number.
    ["bike-125/day-1", 6000, 6500],
    ["car-k/day-1", 8100, "free"],
    // Stored without one: 0 and above the new price.
    ["bike-400/day-3", 26_000, 0],
    ["scooter-50/day-3", 9400, 9401],
  ];
  await withDb(async (db) => {
    await publishPrices(db, publishedWorkbook(), NOW);

    const workbook = publishedWorkbook();
    for (const [key, price, advance] of BAD) {
      setCell(workbook, "Prices", key, "price_jpy", price);
      setCell(workbook, "Prices", key, "advance_price_jpy", advance);
    }
    const { report, prices } = await publishPrices(db, workbook, NOW + 60_000);

    assert.equal(report.version, 2);
    assert.deepEqual(report.counts, { ok: ROWS - BAD.length, warning: 0, error: BAD.length });
    for (const [key] of BAD) assert.deepEqual(await storedPrice(db, key), priceOf(publishedCatalog(), key), key);
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(publishedCatalog()));
    for (const [key, , advance] of BAD) {
      const cell = priceCell(workbook, prices, key);
      assertKeptCell(cell, key, ["advance_price_jpy", String(advance)], priceOf(publishedCatalog(), key));
    }
  });
});

test("a bad new Prices row is skipped", async (t) => {
  await t.test("a key the last publish had no price for", async () => {
    await withDb(async (db) => {
      await publishPrices(db, publishedWorkbook(), NOW);

      // car-k/hours-6 has no row in the fixture, and day-7 is a package new in this publish. bike-125/day-1 was published
      // and keeps its price in the same publish, so each cell says what its own row does.
      const workbook = publishedWorkbook();
      appendRow(workbook, "Packages", { package_id: "day-7", days: 7, sort: 4, name_ja: "7日", name_en: "7 days", name_zh: "7天", name_ko: "7일" });
      appendRow(workbook, "Prices", { rate_class_id: "car-k", package_id: "hours-6", price_jpy: -5 });
      appendRow(workbook, "Prices", { rate_class_id: "bike-125", package_id: "day-7", price_jpy: "lots" });
      setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", -5);
      const { report, prices } = await publishPrices(db, workbook, NOW + 60_000);

      assert.equal(report.version, 2);
      assert.deepEqual(report.counts, { ok: ROWS, warning: 0, error: 3 });
      assert.equal(await storedPrice(db, "car-k/hours-6"), null);
      assert.equal(await storedPrice(db, "bike-125/day-7"), null);
      assert.deepEqual(await storedPrice(db, "bike-125/day-1"), priceOf(publishedCatalog(), "bike-125/day-1"));

      const stored = await readCatalog(db);
      assert.ok(stored);
      assert.ok(stored.packages.some(({ id }) => id === "day-7"), "the new package publishes");
      assert.deepEqual(canonicalCatalog({ ...stored, packages: stored.packages.filter(({ id }) => id !== "day-7") }), canonicalCatalog(publishedCatalog()));

      assertNotBookableCell(priceCell(workbook, prices, "car-k/hours-6"), "car-k/hours-6", ["price_jpy", "-5"]);
      assertNotBookableCell(priceCell(workbook, prices, "bike-125/day-7"), "bike-125/day-7", ["price_jpy", "lots"]);
      assertKeptCell(priceCell(workbook, prices, "bike-125/day-1"), "bike-125/day-1", ["price_jpy", "-5"], priceOf(publishedCatalog(), "bike-125/day-1"));
    });
  });

  await t.test("the first publish, with nothing stored", async () => {
    await withDb(async (db) => {
      const workbook = publishedWorkbook();
      setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", -5);
      setCell(workbook, "Prices", "scooter-50/day-3", "advance_price_jpy", 9001);
      const { report, prices } = await publishPrices(db, workbook, NOW);

      assert.equal(report.version, 1);
      assert.deepEqual(report.counts, { ok: ROWS - 2, warning: 0, error: 2 });
      assert.equal(await storedPrice(db, "bike-125/day-1"), null);
      assert.equal(await storedPrice(db, "scooter-50/day-3"), null);
      assert.deepEqual(
        canonicalCatalog(await readCatalog(db)),
        canonicalCatalog(withoutDropped(publishedCatalog(), { prices: ["bike-125/day-1", "scooter-50/day-3"] })),
      );
      assertNotBookableCell(priceCell(workbook, prices, "bike-125/day-1"), "bike-125/day-1", ["price_jpy", "-5"]);
      assertNotBookableCell(priceCell(workbook, prices, "scooter-50/day-3"), "scooter-50/day-3", ["advance_price_jpy", "9001"]);
    });
  });
});

test("a removed Prices row still removes its price", async (t) => {
  // Taken out of the sheet, or with its cells cleared, a row is no row at all: only an error keeps a price. Each case
  // keeps bike-125/day-3 by a bad price in the same publish, so a publish that kept every stored price shows.
  const REMOVALS: [name: string, remove: (workbook: Workbook, key: string) => void][] = [
    ["the row deleted", (workbook, key) => removeRow(workbook, "Prices", key)],
    ["the row's cells cleared", (workbook, key) => workbook.Prices.splice(sheetRow(workbook, "Prices", key) - 1, 1, [])],
  ];
  for (const [name, remove] of REMOVALS) {
    await t.test(name, async () => {
      await withDb(async (db) => {
        await publishPrices(db, publishedWorkbook(), NOW);

        const workbook = publishedWorkbook();
        setCell(workbook, "Prices", "bike-125/day-3", "price_jpy", -5);
        remove(workbook, "car-k/day-1");
        remove(workbook, "scooter-50/day-1");
        await publishPrices(db, workbook, NOW + 60_000);

        assert.equal(await storedPrice(db, "car-k/day-1"), null, "car-k/day-1, which had an advance price");
        assert.equal(await storedPrice(db, "scooter-50/day-1"), null, "scooter-50/day-1");
        assert.deepEqual(await storedPrice(db, "bike-125/day-3"), priceOf(publishedCatalog(), "bike-125/day-3"));
        assert.deepEqual(
          canonicalCatalog(await readCatalog(db)),
          canonicalCatalog(withoutDropped(publishedCatalog(), { prices: ["car-k/day-1", "scooter-50/day-1"] })),
        );
      });
    });
  }
});

test("a skipped Packages row still drops its prices", async () => {
  await withDb(async (db) => {
    await publishPrices(db, publishedWorkbook(), NOW);

    // day-3 is skipped, so all four of its prices go, bike-125/day-3 with its own bad price too. bike-125/day-1, on a kept
    // package, keeps its price in the same publish.
    const workbook = publishedWorkbook();
    setCell(workbook, "Packages", "day-3", "days", "three");
    setCell(workbook, "Prices", "bike-125/day-3", "price_jpy", -5);
    setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", -5);
    const { report, prices } = await publishPrices(db, workbook, NOW + 60_000);

    assert.equal(report.version, 2);
    const dayThree = ["scooter-50/day-3", "bike-125/day-3", "bike-400/day-3", "car-k/day-3"];
    for (const key of dayThree) assert.equal(await storedPrice(db, key), null, key);
    assert.deepEqual(await storedPrice(db, "bike-125/day-1"), priceOf(publishedCatalog(), "bike-125/day-1"));
    assert.deepEqual(
      canonicalCatalog(await readCatalog(db)),
      canonicalCatalog(withoutDropped(publishedCatalog(), { packages: ["day-3"], prices: dayThree })),
    );
    for (const key of dayThree) assertError(priceCell(workbook, prices, key), key, ["package_id", "day-3"]);
    assertKeptCell(priceCell(workbook, prices, "bike-125/day-1"), "bike-125/day-1", ["price_jpy", "-5"], priceOf(publishedCatalog(), "bike-125/day-1"));
  });
});

test("a skipped RateClasses row still drops its prices", async () => {
  await withDb(async (db) => {
    await publishPrices(db, publishedWorkbook(), NOW);

    // bike-400 is skipped, so its three prices go, bike-400/day-1 with its own bad price and bike-400/hours-6 with its
    // advance price. rebel-250 rides bike-400, so it goes with it, and its vehicle わ1005 too.
    const workbook = publishedWorkbook();
    setCell(workbook, "RateClasses", "bike-400", "group", "boat");
    setCell(workbook, "Prices", "bike-400/day-1", "price_jpy", -5);
    setCell(workbook, "Prices", "car-k/day-1", "price_jpy", -5);
    const { report, prices } = await publishPrices(db, workbook, NOW + 60_000);

    assert.equal(report.version, 2);
    const bike400 = ["bike-400/hours-6", "bike-400/day-1", "bike-400/day-3"];
    for (const key of bike400) assert.equal(await storedPrice(db, key), null, key);
    assert.deepEqual(await storedPrice(db, "car-k/day-1"), priceOf(publishedCatalog(), "car-k/day-1"));
    for (const key of bike400) assertError(priceCell(workbook, prices, key), key, ["rate_class_id", "bike-400"]);
    assertKeptCell(priceCell(workbook, prices, "car-k/day-1"), "car-k/day-1", ["price_jpy", "-5"], priceOf(publishedCatalog(), "car-k/day-1"));
  });
});

test("a repeat Prices row changes nothing", async (t) => {
  // The first row of a key owns it, kept or not: a repeat's value never publishes, and a repeat is never what keeps a
  // stored price, nor what stops one being kept.
  const CASES: { name: string; first: unknown; repeat: unknown; stored: (published: StoredPrice) => StoredPrice }[] = [
    { name: "a good row, then a bad repeat", first: 5300, repeat: -5, stored: () => ({ price_jpy: 5300, advance_price_jpy: null }) },
    { name: "a good row, then a good repeat", first: 5400, repeat: 9999, stored: () => ({ price_jpy: 5400, advance_price_jpy: null }) },
    { name: "a bad row, then a good repeat", first: -5, repeat: 9999, stored: (published) => published },
    { name: "a bad row, then a bad repeat", first: -5, repeat: "abc", stored: (published) => published },
  ];
  for (const { name, first, repeat, stored } of CASES) {
    await t.test(name, async () => {
      await withDb(async (db) => {
        // bike-125/day-3 was published at 13,800 with no advance price.
        await publishPrices(db, publishedWorkbook(), NOW);
        const published = priceOf(publishedCatalog(), "bike-125/day-3");

        const workbook = publishedWorkbook();
        setCell(workbook, "Prices", "bike-125/day-3", "price_jpy", first);
        appendRow(workbook, "Prices", { rate_class_id: "bike-125", package_id: "day-3", price_jpy: repeat });
        const { prices } = await publishPrices(db, workbook, NOW + 60_000);

        assert.deepEqual(await storedPrice(db, "bike-125/day-3"), stored(published));
        // The repeat stays an error, whichever row is bad.
        assertError(prices[workbook.Prices.length - 2], "the repeat", []);
      });
    });
  }
});

test("the next good Publish replaces the kept price with the sheet's value", async () => {
  // [row, bad price_jpy for the second publish, the third publish's price_jpy and advance_price_jpy ("" is blank)]
  const ROWS_FIXED: [key: string, bad: unknown, price: number, advance: number | ""][] = [
    ["bike-125/day-1", -5, 5600, ""],
    ["car-k/day-1", "abc", 7700, 7100],
    ["scooter-50/hours-6", 0, 2650, 2400],
  ];
  await withDb(async (db) => {
    await publishPrices(db, publishedWorkbook(), NOW);

    const broken = publishedWorkbook();
    for (const [key, bad] of ROWS_FIXED) setCell(broken, "Prices", key, "price_jpy", bad);
    await publishPrices(db, broken, NOW + 60_000);
    for (const [key] of ROWS_FIXED) assert.deepEqual(await storedPrice(db, key), priceOf(publishedCatalog(), key), `${key} kept`);

    const fixed = publishedWorkbook();
    for (const [key, , price, advance] of ROWS_FIXED) {
      setCell(fixed, "Prices", key, "price_jpy", price);
      setCell(fixed, "Prices", key, "advance_price_jpy", advance);
    }
    const { report, prices } = await publishPrices(db, fixed, NOW + 120_000);

    assert.equal(report.version, 3);
    assert.deepEqual(report.counts, { ok: ROWS, warning: 0, error: 0 });
    for (const [key, , price, advance] of ROWS_FIXED) {
      assert.deepEqual(await storedPrice(db, key), { price_jpy: price, advance_price_jpy: advance === "" ? null : advance }, key);
    }
    assert.ok(prices.every((cell) => cell === "ok"), `Prices cells: ${JSON.stringify(prices)}`);
  });
});

// #136: a Models or Vehicles row with an error of its own keeps what the site already has, as #135 does for a Prices row,
// so a typo does not take a model or a bike off the site. A model is kept when the site has it as active and its stored
// type and rate class both publish; a vehicle when the site has it as not retired and its stored model publishes or is
// kept. The kept row is the stored one, every column, never mixed with the bad row's new values. The row stays an error,
// and its cell names the problem, the model or plate, and says the site keeps the last published row; a row with nothing
// to keep says it is not on the site. A kept model counts as published for its vehicles, so their good rows publish. A
// removed row, a skipped Types or RateClasses row and a repeat row behave as before. Every expected row below is the
// hand-written fixture catalog with the changes spelled out here, never the code's output.

/** A kept row's cell: the problem, then that the site keeps the last published row. */
const KEPT = [/\bkeeps\b/i, /\blast published\b/i];
/** A cell of a row with nothing stored to keep. */
const NOT_ON_SITE = /(?:not|n't) on the site/i;

/** Publishes `workbook` and returns the report and the one status write. */
async function publishSheet(db: D1Database, workbook: Workbook, now: number) {
  const { publishCatalog } = await publish();
  const { sheets, calls } = fakeSheets(workbook);
  const report = await publishCatalog({ db, sheets, now });
  assert.equal(calls.updates.length, 1, "one status write");
  return { report, data: calls.updates[0] };
}

/** The status cell of the row named `key` in `tab` of `workbook`. */
function cellAt(data: StatusWrite[], workbook: Workbook, tab: string, key: string): unknown {
  return statusWrite(data, tab).cells[sheetRow(workbook, tab, key) - 2];
}

function assertKeptRow(cell: unknown, label: string, words: string[]): void {
  assertError(cell, label, words);
  for (const pattern of KEPT) assert.match(cell as string, pattern, `${label} says the site keeps the last published row`);
  assert.doesNotMatch(cell as string, NOT_ON_SITE, label);
}

function assertNotOnSite(cell: unknown, label: string, words: string[]): void {
  assertError(cell, label, words);
  assert.match(cell as string, NOT_ON_SITE, `${label} says the row is not on the site`);
  assert.doesNotMatch(cell as string, /\blast published\b/i, label);
}

/** An error row that keeps nothing, whatever else its cell says. */
function assertNotKept(cell: unknown, label: string, words: string[]): void {
  assertError(cell, label, words);
  assert.doesNotMatch(cell as string, /\blast published\b/i, `${label} keeps nothing`);
}

function modelIn(catalog: Catalog, id: string): Model {
  const model = catalog.models.find((candidate) => candidate.id === id);
  assert.ok(model, `the catalog has no model ${id}`);
  return model;
}

function vehicleIn(catalog: Catalog, plate: string): Vehicle {
  const vehicle = catalog.vehicles.find((candidate) => candidate.plate === plate);
  assert.ok(vehicle, `the catalog has no vehicle ${plate}`);
  return vehicle;
}

async function bookingRows(db: D1Database): Promise<SqlRow[]> {
  return (await db.prepare("SELECT * FROM bookings ORDER BY id").all<SqlRow>()).results;
}

/** Sets each named cell of the row named `key`. */
function setCells(workbook: Workbook, tab: string, key: string, cells: Record<string, unknown>): void {
  for (const [column, value] of Object.entries(cells)) setCell(workbook, tab, key, column, value);
}

/** Every cell of `tab` is "ok" except the rows in `except`, by key. */
function assertOtherCellsOk(data: StatusWrite[], workbook: Workbook, tab: string, except: string[]): void {
  const skip = new Set(except.map((key) => sheetRow(workbook, tab, key)));
  for (const [index, cell] of statusWrite(data, tab).cells.entries()) {
    if (!skip.has(index + 2)) assert.equal(cell, "ok", `${tab} ${index + 2}`);
  }
}

/**
 * Bad Models rows: the bad cell, the words its error names, and valid new values in other columns, texts and photos
 * among them, which would show in the stored row if it took any of the sheet's values. cub-110 is inactive in the
 * fixture, so it is not here.
 */
const BAD_MODELS: { id: string; bad: Record<string, unknown>; names: string[]; others: Record<string, unknown> }[] = [
  {
    id: "today-50",
    bad: { active: "maybe" },
    names: ["active", "maybe"],
    others: { name_en: "Today Deluxe", photos: "today-9.jpg", seats: 2 },
  },
  {
    id: "pcx-125",
    bad: { engine_cc: "big" },
    names: ["engine_cc", "big"],
    others: { rate_class_id: "scooter-50", brand: "Yamaha", summary_en: "A new summary", photos: "" },
  },
  {
    id: "rebel-250",
    bad: { sort: "tenth" },
    names: ["sort", "tenth"],
    others: { description_ja: "新しい説明", photos: "rebel-8.jpg, rebel-9.jpg", seats: 1 },
  },
  { id: "nbox-660", bad: { brand: "" }, names: ["brand"], others: { name_ko: "새 이름", sort: 9, engine_cc: 990 } },
];

test("a bad Models row keeps the last published model", async () => {
  await withDb(async (db) => {
    const first = await publishSheet(db, validWorkbook(), NOW);
    assert.equal(first.report.version, 1);
    // A future booking on a bike of each kept model.
    for (const plate of ["わ1001", "わ1002", "わ1005", "わ1006"]) {
      await seedBooking(db, { vehicle_plate: plate, start_at: NOW + 3 * DAY_MS });
    }
    const bookings = await bookingRows(db);

    const workbook = validWorkbook();
    for (const { id, bad, others } of BAD_MODELS) setCells(workbook, "Models", id, { ...others, ...bad });
    const { report, data } = await publishSheet(db, workbook, NOW + 60_000);

    assert.equal(report.ok, true);
    assert.equal(report.version, 2);
    assert.deepEqual(report.counts, { ok: ROWS - BAD_MODELS.length, warning: 0, error: BAD_MODELS.length });
    assert.deepEqual(report.affectedBookings, [], "no bike leaves service");
    assert.deepEqual(await catalogMeta(db), [{ id: 1, version: 2, published_at: NOW + 60_000, source: "sheet" }]);

    // Every model stays active with every stored column, and every vehicle and booking stays as it was.
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expectedCatalog()));
    assert.deepEqual(await bookingRows(db), bookings);

    for (const { id, names } of BAD_MODELS) assertKeptRow(cellAt(data, workbook, "Models", id), id, [...names, id]);
    assertOtherCellsOk(data, workbook, "Models", BAD_MODELS.map(({ id }) => id));
    const { Models: _models, ...others } = STATUS_COLUMNS;
    for (const tab of Object.keys(others)) assertOtherCellsOk(data, workbook, tab, []);
  });
});

/** Bad Vehicles rows: the bad cell, the words its error names, and valid new values in other columns. */
const BAD_VEHICLES: { plate: string; bad: Record<string, unknown>; names: string[]; others: Record<string, unknown> }[] = [
  // A bike moved to another model in the same edit keeps its stored model.
  { plate: "わ1002", bad: { status: "lost" }, names: ["status", "lost"], others: { model_id: "rebel-250", odometer_km: 9100 } },
  // In maintenance, and the edit would have made it active.
  { plate: "わ1003", bad: { odometer_km: "far" }, names: ["odometer_km", "far"], others: { status: "active", base_usage_days: 6 } },
  { plate: "わ1005", bad: { base_usage_days: -3 }, names: ["base_usage_days", "-3"], others: { odometer_km: 30_000 } },
  // The tradeoff the owner accepted: a typo in a status meant to retire the bike keeps it bookable.
  { plate: "わ1006", bad: { status: "retire" }, names: ["status", "retire"], others: { odometer_km: 46_000 } },
];

test("a bad Vehicles row keeps the last published vehicle", async (t) => {
  // The vehicles' models publish from their own rows, or are kept for bad rows of their own.
  const MODEL_CASES: { name: string; models: typeof BAD_MODELS }[] = [
    { name: "on a published model", models: [] },
    { name: "on a kept model", models: BAD_MODELS.filter(({ id }) => id === "pcx-125" || id === "rebel-250") },
  ];
  for (const { name, models } of MODEL_CASES) {
    await t.test(name, async () => {
      await withDb(async (db) => {
        await publishSheet(db, validWorkbook(), NOW);
        for (const plate of ["わ1002", "わ1005", "わ1006"]) {
          await seedBooking(db, { vehicle_plate: plate, start_at: NOW + 3 * DAY_MS });
        }
        const bookings = await bookingRows(db);

        const workbook = validWorkbook();
        for (const { plate, bad, others } of BAD_VEHICLES) setCells(workbook, "Vehicles", plate, { ...others, ...bad });
        for (const { id, bad, others } of models) setCells(workbook, "Models", id, { ...others, ...bad });
        const { report, data } = await publishSheet(db, workbook, NOW + 60_000);

        const bad = BAD_VEHICLES.length + models.length;
        assert.equal(report.version, 2);
        assert.deepEqual(report.counts, { ok: ROWS - bad, warning: 0, error: bad });
        assert.deepEqual(report.affectedBookings, [], "no bike leaves service");

        // Not retired, and its stored model, status and counters unchanged.
        const stored = await readCatalog(db);
        assert.ok(stored);
        for (const { plate } of BAD_VEHICLES) {
          assert.deepEqual(vehicleIn(stored, plate), vehicleIn(expectedCatalog(), plate), plate);
        }
        assert.deepEqual(canonicalCatalog(stored), canonicalCatalog(expectedCatalog()));
        assert.deepEqual(await bookingRows(db), bookings);

        for (const { plate, names } of BAD_VEHICLES) {
          assertKeptRow(cellAt(data, workbook, "Vehicles", plate), plate, [...names, plate]);
        }
        assertOtherCellsOk(data, workbook, "Vehicles", BAD_VEHICLES.map(({ plate }) => plate));
        for (const { id, names } of models) assertKeptRow(cellAt(data, workbook, "Models", id), id, [...names, id]);
        assertOtherCellsOk(data, workbook, "Models", models.map(({ id }) => id));
      });
    });
  }
});

test("a kept model's vehicles still publish", async () => {
  await withDb(async (db) => {
    await publishSheet(db, validWorkbook(), NOW);

    // pcx-125 goes bad and is kept. Its two bikes change, a bike moves to it and a new one joins it: all good rows,
    // which publish with the sheet's values, not the stored ones.
    const workbook = validWorkbook();
    setCell(workbook, "Models", "pcx-125", "engine_cc", "big");
    setCell(workbook, "Vehicles", "わ1002", "odometer_km", 9100);
    setCells(workbook, "Vehicles", "わ1003", { status: "active", base_usage_days: 6 });
    setCell(workbook, "Vehicles", "わ1001", "model_id", "pcx-125");
    appendRow(workbook, "Vehicles", { plate: "わ1007", model_id: "pcx-125", status: "active", odometer_km: 10 });
    const { report, data } = await publishSheet(db, workbook, NOW + 60_000);

    assert.equal(report.version, 2);
    assert.deepEqual(report.counts, { ok: ROWS, warning: 0, error: 1 });

    const expected = changed((catalog) => {
      vehicleIn(catalog, "わ1002").odometerKm = 9100;
      Object.assign(vehicleIn(catalog, "わ1003"), { status: "active", baseUsageDays: 6 });
      vehicleIn(catalog, "わ1001").modelId = "pcx-125";
      catalog.vehicles.push({ plate: "わ1007", modelId: "pcx-125", status: "active", odometerKm: 10, baseUsageDays: 0 });
    });
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expected));

    assertKeptRow(cellAt(data, workbook, "Models", "pcx-125"), "pcx-125", ["engine_cc", "big", "pcx-125"]);
    const vehicles = statusWrite(data, "Vehicles");
    assert.equal(vehicles.lastRow, 8);
    assert.ok(vehicles.cells.every((cell) => cell === "ok"), `Vehicles cells: ${JSON.stringify(vehicles.cells)}`);
  });
});

test("a bad new Models or Vehicles row is skipped", async (t) => {
  await t.test("rows the last publish did not have", async () => {
    await withDb(async (db) => {
      await publishSheet(db, validWorkbook(), NOW);

      // vino-125 and わ1008 are new and bad, わ1007 is a good row on vino-125. rebel-250 and わ1001 were published and are
      // kept in the same publish, so each cell says what its own row does.
      const workbook = validWorkbook();
      appendCopy(workbook, "Models", "pcx-125", { model_id: "vino-125", engine_cc: "big", sort: 6, photos: "" });
      appendRow(workbook, "Vehicles", { plate: "わ1007", model_id: "vino-125", status: "active" });
      appendRow(workbook, "Vehicles", { plate: "わ1008", model_id: "pcx-125", status: "lost" });
      setCell(workbook, "Models", "rebel-250", "sort", "tenth");
      setCell(workbook, "Vehicles", "わ1001", "status", "lost");
      const { report, data } = await publishSheet(db, workbook, NOW + 60_000);

      assert.equal(report.version, 2);
      assert.deepEqual(report.counts, { ok: ROWS - 2, warning: 0, error: 5 });
      assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expectedCatalog()));

      assertNotOnSite(cellAt(data, workbook, "Models", "vino-125"), "vino-125", ["engine_cc", "big"]);
      assertNotOnSite(cellAt(data, workbook, "Vehicles", "わ1008"), "わ1008", ["status", "lost"]);
      assertNotKept(cellAt(data, workbook, "Vehicles", "わ1007"), "わ1007", ["model_id", "vino-125"]);
      assertKeptRow(cellAt(data, workbook, "Models", "rebel-250"), "rebel-250", ["sort", "tenth", "rebel-250"]);
      assertKeptRow(cellAt(data, workbook, "Vehicles", "わ1001"), "わ1001", ["status", "lost", "わ1001"]);
    });
  });

  await t.test("the first publish, with nothing stored", async () => {
    await withDb(async (db) => {
      const workbook = validWorkbook();
      setCell(workbook, "Models", "pcx-125", "engine_cc", "big");
      setCell(workbook, "Vehicles", "わ1006", "status", "lost");
      const { report, data } = await publishSheet(db, workbook, NOW);

      assert.equal(report.version, 1);
      assert.deepEqual(report.counts, { ok: ROWS - 4, warning: 0, error: 4 });
      assert.deepEqual(
        canonicalCatalog(await readCatalog(db)),
        canonicalCatalog(withoutDropped(expectedCatalog(), { models: ["pcx-125"], vehicles: ["わ1002", "わ1003", "わ1006"] })),
      );
      assertNotOnSite(cellAt(data, workbook, "Models", "pcx-125"), "pcx-125", ["engine_cc", "big"]);
      assertNotOnSite(cellAt(data, workbook, "Vehicles", "わ1006"), "わ1006", ["status", "lost"]);
      for (const plate of ["わ1002", "わ1003"]) {
        assertNotKept(cellAt(data, workbook, "Vehicles", plate), plate, ["model_id", "pcx-125"]);
      }
    });
  });

  await t.test("a model the site has as inactive and a bike it has as retired", async () => {
    await withDb(async (db) => {
      await publishSheet(db, validWorkbook(), NOW);

      // cub-110 is inactive and わ1004 retired: neither is on the site, so there is nothing to keep. The rows' new
      // values would make both bookable.
      const workbook = validWorkbook();
      setCells(workbook, "Models", "cub-110", { engine_cc: "big", active: "TRUE" });
      setCells(workbook, "Vehicles", "わ1004", { status: "lost", model_id: "today-50" });
      const { report, data } = await publishSheet(db, workbook, NOW + 60_000);

      assert.equal(report.version, 2);
      assert.deepEqual(report.counts, { ok: ROWS - 2, warning: 0, error: 2 });
      assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expectedCatalog()));
      assertNotKept(cellAt(data, workbook, "Models", "cub-110"), "cub-110", ["engine_cc", "big"]);
      assertNotKept(cellAt(data, workbook, "Vehicles", "わ1004"), "わ1004", ["status", "lost"]);
    });
  });
});

test("a removed Models row still deactivates", async (t) => {
  // Taken out of the sheet, or with its cells cleared, a row is no row at all: only an error keeps a model or a bike.
  // Each case keeps another row by a bad cell in the same publish, so a publish that kept every stored row shows.
  const remove = {
    deleted: (workbook: Workbook, tab: string, key: string) => removeRow(workbook, tab, key),
    cleared: (workbook: Workbook, tab: string, key: string) => {
      workbook[tab].splice(sheetRow(workbook, tab, key) - 1, 1, []);
    },
  };
  for (const [how, removeOne] of Object.entries(remove)) {
    await t.test(`a Models row ${how}`, async () => {
      await withDb(async (db) => {
        await publishSheet(db, validWorkbook(), NOW);
        const booking = await seedBooking(db, { vehicle_plate: "わ1002", start_at: NOW + 3 * DAY_MS });

        // pcx-125 goes, and its bikes with it, わ1003 with a bad row of its own too: a bike is kept only on a model that
        // publishes or is kept. rebel-250 is kept.
        const workbook = validWorkbook();
        setCell(workbook, "Vehicles", "わ1003", "odometer_km", "far");
        setCell(workbook, "Models", "rebel-250", "sort", "tenth");
        removeOne(workbook, "Models", "pcx-125");
        const { report, data } = await publishSheet(db, workbook, NOW + 60_000);

        assert.equal(report.version, 2);
        assert.deepEqual(report.affectedBookings, [affected(booking)]);
        const expected = changed((catalog) => {
          modelIn(catalog, "pcx-125").active = false;
          vehicleIn(catalog, "わ1002").status = "retired";
          vehicleIn(catalog, "わ1003").status = "retired";
        });
        assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expected));
        assertNotKept(cellAt(data, workbook, "Vehicles", "わ1002"), "わ1002", ["model_id", "pcx-125"]);
        assertNotKept(cellAt(data, workbook, "Vehicles", "わ1003"), "わ1003", ["pcx-125"]);
        assertKeptRow(cellAt(data, workbook, "Models", "rebel-250"), "rebel-250", ["sort", "tenth", "rebel-250"]);
      });
    });

    await t.test(`a Vehicles row ${how}`, async () => {
      await withDb(async (db) => {
        await publishSheet(db, validWorkbook(), NOW);
        const booking = await seedBooking(db, { vehicle_plate: "わ1002", start_at: NOW + 3 * DAY_MS });

        const workbook = validWorkbook();
        setCell(workbook, "Vehicles", "わ1005", "status", "lost");
        removeOne(workbook, "Vehicles", "わ1002");
        const { report, data } = await publishSheet(db, workbook, NOW + 60_000);

        assert.equal(report.version, 2);
        assert.deepEqual(report.affectedBookings, [affected(booking)]);
        const expected = changed((catalog) => {
          vehicleIn(catalog, "わ1002").status = "retired";
        });
        assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expected));
        assertKeptRow(cellAt(data, workbook, "Vehicles", "わ1005"), "わ1005", ["status", "lost", "わ1005"]);
      });
    });
  }
});

test("a skipped RateClasses row still deactivates its models", async (t) => {
  // A model is kept only while its stored type and rate class publish. rebel-250 rides bike-400 and is a motorcycle, and
  // has a bad row of its own as well; わ1005 is its bike, with a bad row of its own too. Both go as before. Another model
  // and another bike are kept in the same publish.
  const SKIPS: { name: string; edit: (workbook: Workbook) => void; names: string[]; kept: (workbook: Workbook) => void; keptCells: [tab: string, key: string, words: string[]][] }[] = [
    {
      name: "a skipped RateClasses row",
      edit: (workbook) => setCell(workbook, "RateClasses", "bike-400", "group", "boat"),
      names: ["rate_class_id", "bike-400"],
      kept: (workbook) => {
        setCell(workbook, "Models", "nbox-660", "brand", "");
        setCell(workbook, "Vehicles", "わ1006", "status", "retire");
      },
      keptCells: [
        ["Models", "nbox-660", ["brand", "nbox-660"]],
        ["Vehicles", "わ1006", ["status", "retire", "わ1006"]],
      ],
    },
    {
      name: "a skipped Types row",
      edit: (workbook) => setCell(workbook, "Types", "motorcycle", "deposit_jpy", "abc"),
      names: ["type_id", "motorcycle"],
      kept: (workbook) => {
        setCell(workbook, "Models", "pcx-125", "engine_cc", "big");
        setCell(workbook, "Vehicles", "わ1002", "status", "lost");
      },
      keptCells: [
        ["Models", "pcx-125", ["engine_cc", "big", "pcx-125"]],
        ["Vehicles", "わ1002", ["status", "lost", "わ1002"]],
      ],
    },
  ];
  for (const { name, edit, names, kept, keptCells } of SKIPS) {
    await t.test(name, async () => {
      await withDb(async (db) => {
        await publishSheet(db, validWorkbook(), NOW);
        const booking = await seedBooking(db, { vehicle_plate: "わ1005", start_at: NOW + 3 * DAY_MS });

        const workbook = validWorkbook();
        edit(workbook);
        setCell(workbook, "Models", "rebel-250", "sort", "tenth");
        setCell(workbook, "Vehicles", "わ1005", "status", "lost");
        kept(workbook);
        const { report, data } = await publishSheet(db, workbook, NOW + 60_000);

        assert.equal(report.version, 2);
        assert.deepEqual(report.affectedBookings, [affected(booking)]);
        const stored = await readCatalog(db);
        assert.ok(stored);
        const expected = changed((catalog) => {
          modelIn(catalog, "rebel-250").active = false;
          vehicleIn(catalog, "わ1005").status = "retired";
        });
        assert.deepEqual(canonicalCatalog(stored).models, canonicalCatalog(expected).models);
        assert.deepEqual(canonicalCatalog(stored).vehicles, canonicalCatalog(expected).vehicles);

        assertNotKept(cellAt(data, workbook, "Models", "rebel-250"), "rebel-250", names);
        assertNotKept(cellAt(data, workbook, "Vehicles", "わ1005"), "わ1005", ["rebel-250"]);
        for (const [tab, key, words] of keptCells) assertKeptRow(cellAt(data, workbook, tab, key), key, words);
      });
    });
  }
});

test("a repeat Models or Vehicles row changes nothing", async (t) => {
  // The first row of an id owns it, kept or not: a repeat's values never publish, and a repeat is never what keeps a
  // stored row, nor what stops one being kept. pcx-125 was published with brand Honda, わ1002 with odometer 8,000.
  const CASES: { name: string; first: unknown; repeat: unknown; brand: string; odometer: number }[] = [
    { name: "a good row, then a bad repeat", first: "good", repeat: "bad", brand: "Yamaha", odometer: 9100 },
    { name: "a good row, then a good repeat", first: "good", repeat: "good", brand: "Yamaha", odometer: 9100 },
    { name: "a bad row, then a good repeat", first: "bad", repeat: "good", brand: "Honda", odometer: 8000 },
    { name: "a bad row, then a bad repeat", first: "bad", repeat: "bad", brand: "Honda", odometer: 8000 },
  ];
  const model = { good: { brand: "Yamaha" }, bad: { brand: "" } };
  const repeatModel = { good: { brand: "Suzuki" }, bad: { brand: "Suzuki", engine_cc: "big" } };
  const vehicle = { good: { odometer_km: 9100 }, bad: { odometer_km: "far" } };
  const repeatVehicle = { good: { odometer_km: 9200 }, bad: { odometer_km: 9200, status: "lost" } };
  for (const { name, first, repeat, brand, odometer } of CASES) {
    await t.test(name, async () => {
      await withDb(async (db) => {
        await publishSheet(db, validWorkbook(), NOW);

        const workbook = validWorkbook();
        const [f, r] = [first as "good" | "bad", repeat as "good" | "bad"];
        appendCopy(workbook, "Models", "pcx-125", repeatModel[r]);
        appendCopy(workbook, "Vehicles", "わ1002", repeatVehicle[r]);
        setCells(workbook, "Models", "pcx-125", model[f]);
        setCells(workbook, "Vehicles", "わ1002", vehicle[f]);
        const { data } = await publishSheet(db, workbook, NOW + 60_000);

        const stored = await readCatalog(db);
        assert.ok(stored);
        assert.deepEqual(modelIn(stored, "pcx-125"), { ...modelIn(expectedCatalog(), "pcx-125"), brand });
        assert.deepEqual(vehicleIn(stored, "わ1002"), { ...vehicleIn(expectedCatalog(), "わ1002"), odometerKm: odometer });
        // The repeats stay errors, whichever row is bad.
        assertError(statusWrite(data, "Models").cells[workbook.Models.length - 2], "the repeat model", ["pcx-125"]);
        assertError(statusWrite(data, "Vehicles").cells[workbook.Vehicles.length - 2], "the repeat vehicle", ["わ1002"]);
      });
    });
  }
});

test("the next good Publish replaces the kept model and vehicle with the sheet's values", async () => {
  await withDb(async (db) => {
    await publishSheet(db, validWorkbook(), NOW);

    const broken = validWorkbook();
    setCell(broken, "Models", "pcx-125", "engine_cc", "big");
    setCell(broken, "Models", "nbox-660", "brand", "");
    setCell(broken, "Vehicles", "わ1006", "status", "retire");
    await publishSheet(db, broken, NOW + 60_000);
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expectedCatalog()), "all three kept");

    // Fixed with new values: pcx-125 at 150 cc reads as standard, nbox-660 is taken off the site, わ1006 goes to
    // maintenance.
    const fixed = validWorkbook();
    setCells(fixed, "Models", "pcx-125", { engine_cc: 150, brand: "Yamaha", name_en: "PCX 160", photos: "pcx-9.jpg" });
    setCells(fixed, "Models", "nbox-660", { brand: "Daihatsu", active: "FALSE" });
    setCells(fixed, "Vehicles", "わ1006", { status: "maintenance", odometer_km: 46_000 });
    const { report, data } = await publishSheet(db, fixed, NOW + 120_000);

    assert.equal(report.version, 3);
    assert.deepEqual(report.counts, { ok: ROWS, warning: 0, error: 0 });
    const expected = changed((catalog) => {
      const pcx = modelIn(catalog, "pcx-125");
      Object.assign(pcx, { engineCc: 150, licenseClass: "standard", brand: "Yamaha", photos: ["pcx-9.jpg"] });
      pcx.texts.en.name = "PCX 160";
      Object.assign(modelIn(catalog, "nbox-660"), { brand: "Daihatsu", active: false });
      Object.assign(vehicleIn(catalog, "わ1006"), { status: "maintenance", odometerKm: 46_000 });
    });
    assert.deepEqual(canonicalCatalog(await readCatalog(db)), canonicalCatalog(expected));
    for (const tab of ["Models", "Vehicles"]) assertOtherCellsOk(data, fixed, tab, []);
  });
});
