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
import type { Catalog } from "../src/lib/types.ts";
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
  Prices: { column: "D", lastRow: 12 },
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
    ["skipped as a bad row", (workbook) => setCell(workbook, "Vehicles", PLATE, "status", "lost")],
    ["skipped with its model", (workbook) => setCell(workbook, "Models", "pcx-125", "engine_cc", "big")],
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
