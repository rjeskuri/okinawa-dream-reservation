// validateCatalog and validateBlocks over a workbook in the shape values.batchGet returns. Every expected value is a
// literal, a hand-written fixture or Date.parse on an explicit +09:00 offset, never the code under test. Row order in a
// Catalog is not part of the contract, so catalogs are compared sorted by key. A row may carry several statuses, so
// checks look for a status naming the column, not for one status per problem.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { BOOKINGS_COLUMNS, SHEET_TABS, validateBlocks, validateCatalog } from "../src/lib/catalog/sheet-schema.ts";
import type { Catalog, Model, Package } from "../src/lib/types.ts";
import {
  addEbike,
  EBIKE_MODEL,
  EBIKE_MODEL_ROW,
  EBIKE_PLATES,
  ebikeModelCells,
  withEbike,
} from "./fixtures/sheet/ebike.ts";
import { ACCEPTED_BOUNDARIES, APPENDED, RULE_TABLE, withoutDropped } from "./fixtures/sheet/rule-table.ts";
import {
  appendCopy,
  appendRow,
  CATALOG_TABS,
  expectedCatalog,
  rearrangeColumns,
  removeColumn,
  removeRow,
  rowWith,
  setCell,
  sheetRow,
  sheetSerial,
  validWorkbook,
  type Workbook,
} from "./helpers/sheet-workbook.ts";

// The publish time each validator is given. The valid workbook's ClosedDates (2026-12-31 to 2027-01-02) and Blocks
// (2030-07 and 2030-08) are 3.6 years apart, so no one `now` has both inside the window of 2 years either side.
const CATALOG_NOW = Date.parse("2026-11-02T12:00:00+09:00");
const BLOCKS_NOW = Date.parse("2030-01-01T12:00:00+09:00");

type RowStatus = { tab: string; row: number; level: "ok" | "warning" | "error"; message: string };

type Block = {
  blockId: string;
  modelId: string;
  plate: string | null;
  startAt: number;
  endAt: number;
  channel: string;
  reference: string;
  note: string;
};

const EXPECTED_BLOCKS: Block[] = [
  {
    blockId: "BLK-1",
    modelId: "pcx-125",
    plate: null,
    startAt: Date.parse("2030-07-15T09:00:00+09:00"),
    endAt: Date.parse("2030-07-16T18:00:00+09:00"),
    channel: "Klook",
    reference: "KL-1001",
    note: "Group of two",
  },
  {
    blockId: "BLK-2",
    modelId: "rebel-250",
    plate: "わ1005",
    startAt: Date.parse("2030-08-01T10:00:00+09:00"),
    endAt: Date.parse("2030-08-03T17:30:00+09:00"),
    channel: "Rakuten",
    reference: "RT-2002",
    note: "Two nights",
  },
  {
    blockId: "BLK-3",
    modelId: "today-50",
    plate: "わ1001",
    startAt: Date.parse("2030-08-01T10:00:00+09:00"),
    endAt: Date.parse("2030-08-02T09:00:00+09:00"),
    channel: "Walk-in",
    reference: "WI-3003",
    note: "Paid at the shop",
  },
];

function sortedBy<T>(rows: T[], key: (row: T) => string | number): T[] {
  return [...rows].sort((a, b) => String(key(a)).localeCompare(String(key(b))));
}

function canonical(catalog: Catalog | null) {
  assert.ok(catalog, "no catalog was produced");
  return {
    ...catalog,
    vehicleTypes: sortedBy(catalog.vehicleTypes, (type) => type.id),
    rateClasses: sortedBy(catalog.rateClasses, (rateClass) => rateClass.id),
    models: sortedBy(catalog.models, (model) => model.id),
    vehicles: sortedBy(catalog.vehicles, (vehicle) => vehicle.plate),
    packages: sortedBy(catalog.packages, (pack) => pack.id),
    prices: sortedBy(catalog.prices, (price) => `${price.rateClassId}/${price.packageId}`),
    options: sortedBy(catalog.options, (option) => option.id),
    cancellationTiers: sortedBy(catalog.cancellationTiers, (tier) => tier.minDaysBefore),
    closedDates: [...catalog.closedDates].sort(),
  };
}

function statusesAt(statuses: RowStatus[], tab: string, row: number, level: RowStatus["level"]): RowStatus[] {
  return statuses.filter((status) => status.tab === tab && status.row === row && status.level === level);
}

/** "Tab row" of each distinct row with a status passing `matches`, sorted. */
function rowsWhere(statuses: RowStatus[], matches: (status: RowStatus) => boolean): string[] {
  return [...new Set(statuses.filter(matches).map(({ tab, row }) => `${tab} ${row}`))].sort();
}

function notOk(statuses: RowStatus[]): string[] {
  return rowsWhere(statuses, (status) => status.level !== "ok");
}

function errors(statuses: RowStatus[]): string[] {
  return rowsWhere(statuses, (status) => status.level === "error");
}

/** The sheet rows of `tab` that hold a row of data. */
function dataRows(workbook: Workbook, tab: string): number[] {
  return workbook[tab].flatMap((row, index) => (index === 0 || row.length === 0 ? [] : [index + 1]));
}

function assertEveryRowHasAStatus(workbook: Workbook, statuses: RowStatus[], tabs: string[]): void {
  for (const tab of tabs) {
    const rows = new Set(statuses.filter((status) => status.tab === tab).map((status) => status.row));
    assert.deepEqual(
      dataRows(workbook, tab).filter((row) => !rows.has(row)),
      [],
      `${tab} rows without a status`,
    );
  }
}

/** The workbook publishes clean: `expected` as the catalog, nothing fatal, no row above ok. */
function assertPublishes(workbook: Workbook, expected: Catalog): void {
  const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);
  assert.deepEqual(fatal, []);
  assert.deepEqual(notOk(statuses), []);
  assert.deepEqual(canonical(catalog), canonical(expected));
  assertEveryRowHasAStatus(workbook, statuses, CATALOG_TABS);
}

function assertError(statuses: RowStatus[], tab: string, row: number, columns: string[]): void {
  const messages = statusesAt(statuses, tab, row, "error").map((status) => status.message);
  assert.ok(
    messages.some((message) => columns.some((column) => message.includes(column))),
    `${tab} row ${row} needs an error naming ${columns.join(" or ")}, and has ${inspect(messages)}`,
  );
}

function assertWarning(statuses: RowStatus[], tab: string, row: number, column: string): void {
  const messages = statusesAt(statuses, tab, row, "warning").map((status) => status.message);
  assert.ok(
    messages.some((message) => message.includes(column)),
    `${tab} row ${row} needs a warning naming ${column}, and has ${inspect(messages)}`,
  );
}

function assertFatal(workbook: Workbook, reasons: string[][]): void {
  const { catalog, fatal } = validateCatalog(workbook, CATALOG_NOW);
  assert.equal(catalog, null);
  for (const reason of reasons) {
    assert.ok(
      fatal.some((message: string) => reason.every((part) => message.includes(part))),
      `no fatal reason names ${reason.join(" and ")}: ${inspect(fatal)}`,
    );
  }
}

function modelOf(catalog: Catalog, id: string): Model {
  const model = catalog.models.find((candidate) => candidate.id === id);
  assert.ok(model, `no model ${id}`);
  return model;
}

function packageOf(catalog: Catalog, id: string): Package {
  const found = catalog.packages.find((candidate) => candidate.id === id);
  assert.ok(found, `no package ${id}`);
  return found;
}

function textsOf(catalog: Catalog, tab: string, id: string): Record<string, Record<string, string>> {
  const rows: Record<string, { id: string; texts: object }[]> = {
    Types: catalog.vehicleTypes,
    RateClasses: catalog.rateClasses,
    Packages: catalog.packages,
    Models: catalog.models,
    Options: catalog.options,
  };
  const row = rows[tab].find((candidate) => candidate.id === id);
  assert.ok(row, `${tab} has no ${id}`);
  return row.texts as Record<string, Record<string, string>>;
}

test("the valid fixture produces the expected catalog", () => {
  const workbook = validWorkbook();
  const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);

  assert.deepEqual(fatal, []);
  assert.deepEqual(canonical(catalog), canonical(expectedCatalog()));

  // Exactly one status per row, ok, and numbered as the sheet numbers its rows: the header is row 1.
  for (const tab of CATALOG_TABS) {
    const onTab: RowStatus[] = statuses.filter((status: RowStatus) => status.tab === tab);
    assert.deepEqual(onTab.map((status) => status.row).sort((a, b) => a - b), dataRows(workbook, tab), tab);
    assert.deepEqual(onTab.filter((status) => status.level !== "ok"), [], tab);
  }
  assert.deepEqual(
    rowsWhere(statuses, ({ tab }) => tab === "Cancellation"),
    ["Cancellation 2", "Cancellation 3", "Cancellation 4"],
  );
});

test("each rule rejects its bad row and skips dependents", async (t) => {
  for (const rule of RULE_TABLE) {
    await t.test(rule.name, () => {
      const pristine = validWorkbook();
      const workbook = validWorkbook();
      rule.mutate(workbook);
      const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);

      const bad = rule.errors.map(({ tab, key, column }) => ({
        tab,
        row: key === APPENDED ? workbook[tab].length : sheetRow(pristine, tab, key),
        columns: [column].flat(),
      }));
      for (const { tab, row, columns } of bad) assertError(statuses, tab, row, columns);
      assert.deepEqual(errors(statuses), [...new Set(bad.map(({ tab, row }) => `${tab} ${row}`))].sort());

      if (rule.fatal === undefined) {
        assert.deepEqual(fatal, []);
        assert.deepEqual(canonical(catalog), canonical(withoutDropped(expectedCatalog(), rule.drop ?? {})));
        assertEveryRowHasAStatus(workbook, statuses, CATALOG_TABS);
      } else {
        assertFatal(workbook, [[rule.fatal]]);
      }
    });
  }

  for (const boundary of ACCEPTED_BOUNDARIES) {
    await t.test(`stays valid: ${boundary.name}`, () => {
      const workbook = validWorkbook();
      boundary.mutate(workbook);
      const expected = expectedCatalog();
      boundary.change(expected);
      assertPublishes(workbook, expected);
    });
  }

  // A message that names only the column would pass every row above. Values and numbers are masked, so two messages
  // differ only in what they say is wrong.
  await t.test("two problems in one column read differently", () => {
    const problemOf = (workbook: Workbook, row: number, value: string): string => {
      const [status] = statusesAt(validateCatalog(workbook, CATALOG_NOW).statuses, "Models", row, "error");
      assert.ok(status, `Models row ${row} has no error`);
      return status.message.replaceAll(value, "#").replace(/\d+/g, "#");
    };

    const badSlug = validWorkbook();
    const row = sheetRow(badSlug, "Models", "rebel-250");
    setCell(badSlug, "Models", "rebel-250", "model_id", "Bad_Slug");
    const duplicate = validWorkbook();
    appendCopy(duplicate, "Models", "pcx-125", {});
    assert.notEqual(problemOf(badSlug, row, "Bad_Slug"), problemOf(duplicate, duplicate.Models.length, "pcx-125"));

    const badClass = validWorkbook();
    setCell(badClass, "Models", "rebel-250", "license_class", "huge");
    const overMoped = validWorkbook();
    setCell(overMoped, "Models", "rebel-250", "license_class", "moped");
    assert.notEqual(problemOf(badClass, row, "huge"), problemOf(overMoped, row, "moped"));
  });
});

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

test("missing tabs, headers and config keys are fatal", async (t) => {
  for (const tab of CATALOG_TABS) {
    await t.test(`no ${tab} tab`, () => {
      const workbook = validWorkbook();
      delete workbook[tab];
      assertFatal(workbook, [[tab]]);
    });

    await t.test(`a ${tab} tab with no rows, as batchGet returns an empty tab`, () => {
      const workbook = validWorkbook();
      workbook[tab] = [];
      assertFatal(workbook, [[tab]]);
    });
  }

  // Every column is required, the fixture's header rows being SHEET_TABS. Optional means the cell may be empty.
  for (const tab of CATALOG_TABS) {
    for (const header of validWorkbook()[tab][0].map(String)) {
      await t.test(`${tab} without ${header}`, () => {
        const workbook = validWorkbook();
        removeColumn(workbook, tab, header);
        assertFatal(workbook, [[tab, header]]);
      });
    }
  }

  for (const key of CONFIG_KEYS) {
    await t.test(`no ${key} row`, () => {
      const workbook = validWorkbook();
      removeRow(workbook, "Config", key);
      assertFatal(workbook, [[key]]);
    });
  }

  await t.test("every reason is listed, not only the first", () => {
    const workbook = validWorkbook();
    delete workbook.Options;
    delete workbook.Cancellation;
    removeColumn(workbook, "Vehicles", "plate");
    removeColumn(workbook, "Prices", "price_jpy");
    removeRow(workbook, "Config", "hold_minutes");
    removeRow(workbook, "Config", "shop_close");
    assertFatal(workbook, [
      ["Options"],
      ["Cancellation"],
      ["Vehicles", "plate"],
      ["Prices", "price_jpy"],
      ["hold_minutes"],
      ["shop_close"],
    ]);
  });

  await t.test("a tab with only its header is present, and empty", () => {
    const workbook = validWorkbook();
    workbook.ClosedDates = workbook.ClosedDates.slice(0, 1);
    assertPublishes(workbook, { ...expectedCatalog(), closedDates: [] });
  });

  await t.test("the catalog tabs are all a publish needs", () => {
    const workbook = validWorkbook();
    assertPublishes(Object.fromEntries(CATALOG_TABS.map((tab) => [tab, workbook[tab]])), expectedCatalog());
  });
});

function reversed(indexes: number[]): number[] {
  return [...indexes].reverse();
}

function fullWidth(text: string): string {
  return text.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));
}

const LAYOUTS: [string, (indexes: number[]) => number[], (header: string) => string][] = [
  ["reversed and upper case", reversed, (header) => header.toUpperCase()],
  [
    "rotated and padded with spaces",
    (indexes) => [...indexes.slice(2), ...indexes.slice(0, 2)],
    (header) => `  ${header} `,
  ],
  [
    "even columns last and capitalized",
    (indexes) => [...indexes.filter((index) => index % 2 === 1), ...indexes.filter((index) => index % 2 === 0)],
    (header) => header.charAt(0).toUpperCase() + header.slice(1),
  ],
  ["reversed and full-width", reversed, fullWidth],
];

test("headers match in any order and case", async (t) => {
  for (const [name, reorder, respell] of LAYOUTS) {
    await t.test(name, () => {
      const workbook = validWorkbook();
      for (const tab of Object.keys(workbook)) rearrangeColumns(workbook, tab, reorder, respell);
      assertPublishes(workbook, expectedCatalog());

      const { blocks, statuses } = validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW);
      assert.deepEqual(notOk(statuses), []);
      assert.deepEqual(sortedBy(blocks, (block: Block) => block.blockId), EXPECTED_BLOCKS);
    });
  }
});

// Spelled the ways the ticket names, in several amounts, so that no amount can be read from the spelling alone.
const MONEY_SPELLINGS: [unknown, number][] = [
  [5000, 5000],
  ["5,000", 5000],
  ["¥5,000", 5000],
  ["5000円", 5000],
  ["7300", 7300],
  ["7,300", 7300],
  ["¥7,300", 7300],
  ["7300円", 7300],
  ["￥５，０００", 5000],
  ["５０００円", 5000],
  ["５，２５０", 5250],
  ["¥1,234,567", 1234567],
  ["1,234円", 1234],
];

const MONEY_CELLS: [string, string, string, (catalog: Catalog) => number | null | undefined][] = [
  ["Types", "car", "deposit_jpy", (c) => c.vehicleTypes.find(({ id }) => id === "car")?.depositJpy],
  [
    "RateClasses",
    "bike-125",
    "extension_per_hour_jpy",
    (c) => c.rateClasses.find(({ id }) => id === "bike-125")?.extensionPerHourJpy,
  ],
  [
    "Prices",
    "bike-400/day-3",
    "price_jpy",
    (c) => c.prices.find((p) => p.rateClassId === "bike-400" && p.packageId === "day-3")?.priceJpy,
  ],
  ["Options", "child-seat", "base_jpy", (c) => c.options.find(({ id }) => id === "child-seat")?.baseJpy],
  [
    "Options",
    "child-seat",
    "extra_per_hour_jpy",
    (c) => c.options.find(({ id }) => id === "child-seat")?.extraPerHourJpy,
  ],
  [
    "Options",
    "child-seat",
    "extra_per_24h_jpy",
    (c) => c.options.find(({ id }) => id === "child-seat")?.extraPer24hJpy,
  ],
];

const BOOLEAN_SPELLINGS: [unknown, boolean][] = [
  [true, true],
  [false, false],
  ["TRUE", true],
  ["FALSE", false],
  ["ＴＲＵＥ", true],
  ["ＦＡＬＳＥ", false],
];

type Spelling = { name: string; edit: [string, string, string, unknown]; change?: (catalog: Catalog) => void };

/** One edited cell of the valid workbook and the change it makes to the expected catalog, if any. */
const TEXT_SPELLINGS: Spelling[] = [
  {
    name: "full-width digits in a whole number",
    edit: ["Models", "rebel-250", "engine_cc", "３９９"],
    change: (catalog) => {
      modelOf(catalog, "rebel-250").engineCc = 399;
    },
  },
  {
    name: "full-width digits in a config value",
    edit: ["Config", "slot_minutes", "value", "４５"],
    change: (catalog) => {
      catalog.config.slotMinutes = 45;
    },
  },
  {
    name: "a full-width time",
    edit: ["Config", "shop_open", "value", "０８：３０"],
    change: (catalog) => {
      catalog.config.shopOpen = "08:30";
    },
  },
  {
    name: "a time cell as a serial",
    edit: ["Config", "shop_close", "value", 0.8125],
    change: (catalog) => {
      catalog.config.shopClose = "19:30";
    },
  },
  {
    name: "another time cell as a serial",
    edit: ["Config", "shop_open", "value", 0.3958333333333333],
    change: (catalog) => {
      catalog.config.shopOpen = "09:30";
    },
  },
  {
    name: "a full-width slug still matches what refers to it",
    edit: ["Models", "rebel-250", "model_id", "ｒｅｂｅｌ－２５０"],
  },
  { name: "a full-width reference to a rate class", edit: ["Models", "nbox-660", "rate_class_id", "ｃａｒ－ｋ"] },
  { name: "a full-width type_id", edit: ["Types", "car", "type_id", "ｃａｒ"] },
  {
    name: "a full-width vehicle status",
    edit: ["Vehicles", "わ1002", "status", "ｒｅｔｉｒｅｄ"],
    change: (catalog) => {
      const vehicle = catalog.vehicles.find(({ plate }) => plate === "わ1002");
      assert.ok(vehicle);
      vehicle.status = "retired";
    },
  },
  {
    name: "a full-width group",
    edit: ["RateClasses", "car-k", "group", "ｂｉｋｅ"],
    change: (catalog) => {
      const rateClass = catalog.rateClasses.find(({ id }) => id === "car-k");
      assert.ok(rateClass);
      rateClass.grp = "bike";
    },
  },
  {
    name: "a full-width plate",
    edit: ["Vehicles", "わ1002", "plate", "わ２００２"],
    change: (catalog) => {
      const vehicle = catalog.vehicles.find(({ plate }) => plate === "わ1002");
      assert.ok(vehicle);
      vehicle.plate = "わ2002";
    },
  },
  {
    name: "a plate that arrives as a number",
    edit: ["Vehicles", "わ1006", "plate", 2002],
    change: (catalog) => {
      const vehicle = catalog.vehicles.find(({ plate }) => plate === "わ1006");
      assert.ok(vehicle);
      vehicle.plate = "2002";
    },
  },
  {
    name: "full-width letters in a brand",
    edit: ["Models", "pcx-125", "brand", "Ｙａｍａｈａ"],
    change: (catalog) => {
      modelOf(catalog, "pcx-125").brand = "Yamaha";
    },
  },
  {
    name: "a full-width date",
    edit: ["ClosedDates", "2027-01-01", "date", "２０２７－０２－１１"],
    change: (catalog) => {
      catalog.closedDates = catalog.closedDates.map((date) => (date === "2027-01-01" ? "2027-02-11" : date));
    },
  },
  {
    name: "a date as a serial",
    edit: ["ClosedDates", "2027-01-01", "date", sheetSerial("2027-05-03")],
    change: (catalog) => {
      catalog.closedDates = catalog.closedDates.map((date) => (date === "2027-01-01" ? "2027-05-03" : date));
    },
  },
];

// [the photos cell, the names it gives]. These are Drive file names, which #17 matches against the Drive listing, so
// they keep their exact spelling. Only whitespace around a name goes, and both commas separate: staff type either.
const PHOTO_CELLS: [string, string[]][] = [
  ["レブル（赤）１.jpg, ｐｃｘ.jpg", ["レブル（赤）１.jpg", "ｐｃｘ.jpg"]],
  ["ﾚﾌﾞﾙ.jpg", ["ﾚﾌﾞﾙ.jpg"]],
  ["バイク.jpg", ["バイク.jpg"]],
  ["赤　バイク １.jpg", ["赤　バイク １.jpg"]],
  ["Ａ.jpg，Ｂ.jpg", ["Ａ.jpg", "Ｂ.jpg"]],
  ["a.jpg，b.jpg,c.jpg", ["a.jpg", "b.jpg", "c.jpg"]],
  ["  ａ.jpg  ,　ｂ.jpg　", ["ａ.jpg", "ｂ.jpg"]],
  ["ａ.jpg,,ｂ.jpg，，ｃ.jpg,", ["ａ.jpg", "ｂ.jpg", "ｃ.jpg"]],
  ["，,  ，", []],
  ["", []],
];

test("normalizes full-width digits and yen formatting", async (t) => {
  for (const [tab, key, column, read] of MONEY_CELLS) {
    for (const [spelling, amount] of MONEY_SPELLINGS) {
      await t.test(`${column} ${JSON.stringify(spelling)}`, () => {
        const workbook = validWorkbook();
        setCell(workbook, tab, key, column, spelling);
        const { catalog, statuses } = validateCatalog(workbook, CATALOG_NOW);
        assert.deepEqual(notOk(statuses), []);
        assert.ok(catalog);
        assert.equal(read(catalog), amount);
      });
    }
  }

  for (const [spelling, active] of BOOLEAN_SPELLINGS) {
    await t.test(`active ${JSON.stringify(spelling)}`, () => {
      const workbook = validWorkbook();
      setCell(workbook, "Models", "pcx-125", "active", spelling);
      const expected = expectedCatalog();
      modelOf(expected, "pcx-125").active = active;
      assertPublishes(workbook, expected);
    });
  }

  for (const { name, edit, change } of TEXT_SPELLINGS) {
    await t.test(name, () => {
      const workbook = validWorkbook();
      const [tab, key, column, value] = edit;
      setCell(workbook, tab, key, column, value);
      const expected = expectedCatalog();
      change?.(expected);
      assertPublishes(workbook, expected);
    });
  }

  for (const [cell, names] of PHOTO_CELLS) {
    await t.test(`photos ${JSON.stringify(cell)}`, () => {
      const workbook = validWorkbook();
      setCell(workbook, "Models", "rebel-250", "photos", cell);
      const expected = expectedCatalog();
      modelOf(expected, "rebel-250").photos = names;
      assertPublishes(workbook, expected);
    });
  }

  await t.test("photos keep their spelling beside a brand that is normalized", () => {
    const workbook = validWorkbook();
    setCell(workbook, "Models", "pcx-125", "brand", "Ｙａｍａｈａ");
    setCell(workbook, "Models", "pcx-125", "photos", "ｐｃｘ（１）.jpg");
    const expected = expectedCatalog();
    modelOf(expected, "pcx-125").brand = "Yamaha";
    modelOf(expected, "pcx-125").photos = ["ｐｃｘ（１）.jpg"];
    assertPublishes(workbook, expected);
  });
});

// Display text is published as typed (#78): NFKC only helps where a cell is parsed or matched, and here it would turn
// the full-width punctuation and circled digits staff type on a Japanese keyboard into something else. (The old
// "half-width katakana in a name" entry of the list above expected ﾃﾞｲﾘｰ to publish as デイリー; that is the rule this
// ticket removes, and the same text is now pinned as kept below.)
const LOCALE_COLUMNS: [string, string][] = [
  ["ja", "ja"],
  ["en", "en"],
  ["zh", "zh-cn"],
  ["ko", "ko"],
];

/** [tab, key, field] of every localized text column. */
const TEXT_TARGETS: [string, string, string][] = [
  ["Types", "car", "name"],
  ["RateClasses", "bike-125", "name"],
  ["Packages", "day-1", "name"],
  ["Models", "rebel-250", "name"],
  ["Models", "rebel-250", "summary"],
  ["Models", "pcx-125", "description"],
  ["Options", "child-seat", "name"],
];

// Each one changes under NFKC, in a different way.
const TYPED_TEXTS = [
  "价格含税，押金另付！",
  "①免許証",
  "Ｒｅｂｅｌ　２５０（赤）",
  "ﾃﾞｲﾘｰ",
  "㈱沖縄　㎏・Ⅳ～",
  "ご予約は１２時まで：ｅｍａｉｌ？",
];

test("text columns keep what staff typed", async (t) => {
  for (const [tab, key, field] of TEXT_TARGETS) {
    for (const [index, first] of TYPED_TEXTS.entries()) {
      await t.test(`${tab} ${key} ${field} from ${JSON.stringify(first)}`, () => {
        const workbook = validWorkbook();
        const expected = expectedCatalog();
        const texts = textsOf(expected, tab, key);
        // A different text in each locale, so a column cannot borrow another's.
        LOCALE_COLUMNS.forEach(([suffix, locale], at) => {
          const typed = TYPED_TEXTS[(index + at) % TYPED_TEXTS.length];
          setCell(workbook, tab, key, `${field}_${suffix}`, typed);
          texts[locale][field] = typed;
        });
        assertPublishes(workbook, expected);
      });
    }
  }

  await t.test("the two examples of the ticket", () => {
    const workbook = validWorkbook();
    setCell(workbook, "Models", "pcx-125", "description_zh", "价格含税，押金另付！");
    setCell(workbook, "Models", "pcx-125", "name_ja", "①免許証");
    const expected = expectedCatalog();
    textsOf(expected, "Models", "pcx-125")["zh-cn"].description = "价格含税，押金另付！";
    textsOf(expected, "Models", "pcx-125").ja.name = "①免許証";
    assertPublishes(workbook, expected);
  });

  // Padding is the one change made to a text: ASCII, ideographic and no-break spaces, tabs and line breaks.
  const PADDED: [string, string][] = [
    ["  ①免許証  ", "①免許証"],
    ["　価格含税，押金另付！　", "価格含税，押金另付！"],
    ["　 　Ｒｅｂｅｌ　２５０\t", "Ｒｅｂｅｌ　２５０"],
    [" ﾃﾞｲﾘｰ\n", "ﾃﾞｲﾘｰ"],
    ["　内側　の　空白　　", "内側　の　空白"],
  ];
  for (const [tab, key, field] of TEXT_TARGETS) {
    await t.test(`${tab} ${key} ${field} is trimmed and nothing else`, () => {
      const workbook = validWorkbook();
      const expected = expectedCatalog();
      const texts = textsOf(expected, tab, key);
      LOCALE_COLUMNS.forEach(([suffix, locale], at) => {
        const [padded, trimmed] = PADDED[(at + key.length) % PADDED.length];
        setCell(workbook, tab, key, `${field}_${suffix}`, padded);
        texts[locale][field] = trimmed;
      });
      assertPublishes(workbook, expected);
    });
  }
});

test("columns that are parsed still normalize beside text that is kept", () => {
  const workbook = validWorkbook();
  setCell(workbook, "Models", "rebel-250", "engine_cc", "３９９");
  setCell(workbook, "Models", "rebel-250", "active", "ＦＡＬＳＥ");
  setCell(workbook, "Models", "rebel-250", "sort", "９");
  setCell(workbook, "Models", "rebel-250", "seats", "２");
  setCell(workbook, "Models", "rebel-250", "brand", "Ｈｏｎｄａ");
  setCell(workbook, "Models", "rebel-250", "name_ja", "レブル　２５０（赤）①");
  setCell(workbook, "Models", "rebel-250", "name_en", "Ｒｅｂｅｌ，２５０");
  setCell(workbook, "Types", "car", "deposit_jpy", "￥１２，０００");
  setCell(workbook, "Types", "car", "name_ko", "자동차，ＣＡＲ");
  setCell(workbook, "Vehicles", "わ1002", "status", "ｍａｉｎｔｅｎａｎｃｅ");
  setCell(workbook, "ClosedDates", "2027-01-01", "date", "２０２７－０３－０４");
  setCell(workbook, "Config", "slot_minutes", "value", "４５");

  const expected = expectedCatalog();
  const model = modelOf(expected, "rebel-250");
  model.engineCc = 399;
  model.active = false;
  model.sort = 9;
  model.seats = 2;
  model.brand = "Honda";
  textsOf(expected, "Models", "rebel-250").ja.name = "レブル　２５０（赤）①";
  textsOf(expected, "Models", "rebel-250").en.name = "Ｒｅｂｅｌ，２５０";
  const car = expected.vehicleTypes.find(({ id }) => id === "car");
  assert.ok(car);
  car.depositJpy = 12000;
  textsOf(expected, "Types", "car").ko.name = "자동차，ＣＡＲ";
  const vehicle = expected.vehicles.find(({ plate }) => plate === "わ1002");
  assert.ok(vehicle);
  vehicle.status = "maintenance";
  expected.closedDates = expected.closedDates.map((date) => (date === "2027-01-01" ? "2027-03-04" : date));
  expected.config.slotMinutes = 45;
  assertPublishes(workbook, expected);
});

// [the photos cell, the names it gives]. 、 is what a Japanese keyboard types between two file names.
const JAPANESE_COMMA_CELLS: [string, string[]][] = [
  ["a.jpg、b.jpg", ["a.jpg", "b.jpg"]],
  ["front.jpg、side.jpg、rear.png", ["front.jpg", "side.jpg", "rear.png"]],
  ["  a.jpg 、 b.jpg  ", ["a.jpg", "b.jpg"]],
  ["　a.jpg　、　b.jpg　", ["a.jpg", "b.jpg"]],
  ["a.jpg、b.jpg,c.jpg，d.jpg", ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]],
  ["a.jpg,b.jpg，c.jpg、d.jpg、e.jpg", ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"]],
  ["レブル（赤）１.jpg、ｐｃｘ（１）.jpg", ["レブル（赤）１.jpg", "ｐｃｘ（１）.jpg"]],
  ["ﾚﾌﾞﾙ.jpg、赤　バイク １.jpg", ["ﾚﾌﾞﾙ.jpg", "赤　バイク １.jpg"]],
  ["Ａ・Ｂ.jpg、c·d.jpg", ["Ａ・Ｂ.jpg", "c·d.jpg"]],
  ["、、a.jpg、、b.jpg、", ["a.jpg", "b.jpg"]],
  ["、a.jpg,，、", ["a.jpg"]],
  ["、，,  、", []],
  ["a.jpg", ["a.jpg"]],
];

test("the photos cell splits on the Japanese comma", async (t) => {
  for (const [at, [cell, names]] of JAPANESE_COMMA_CELLS.entries()) {
    const key = at % 2 === 0 ? "rebel-250" : "nbox-660";
    await t.test(`${key} photos ${JSON.stringify(cell)}`, () => {
      const workbook = validWorkbook();
      setCell(workbook, "Models", key, "photos", cell);
      const expected = expectedCatalog();
      modelOf(expected, key).photos = names;
      assertPublishes(workbook, expected);
    });
  }
});

// [tab, row, the columns left blank, and for each resulting text its locale, field and the locale it falls back to].
const FALLBACKS: [string, string, string[], [string, string, string][]][] = [
  ["Models", "rebel-250", ["name_ko"], [["ko", "name", "en"]]],
  ["Models", "rebel-250", ["name_zh"], [["zh-cn", "name", "en"]]],
  ["Models", "pcx-125", ["name_ja"], [["ja", "name", "en"]]],
  [
    "Models",
    "pcx-125",
    ["name_en", "name_ko"],
    [
      ["en", "name", "ja"],
      ["ko", "name", "ja"],
    ],
  ],
  [
    "Models",
    "today-50",
    ["name_en", "name_zh"],
    [
      ["en", "name", "ja"],
      ["zh-cn", "name", "ja"],
    ],
  ],
  ["Models", "today-50", ["summary_ko"], [["ko", "summary", "en"]]],
  ["Models", "cub-110", ["summary_ja"], [["ja", "summary", "en"]]],
  [
    "Models",
    "nbox-660",
    ["description_zh", "description_en"],
    [
      ["zh-cn", "description", "ja"],
      ["en", "description", "ja"],
    ],
  ],
  ["Types", "car", ["name_ko"], [["ko", "name", "en"]]],
  [
    "RateClasses",
    "bike-400",
    ["name_zh", "name_en"],
    [
      ["zh-cn", "name", "ja"],
      ["en", "name", "ja"],
    ],
  ],
  ["Packages", "day-1", ["name_ko"], [["ko", "name", "en"]]],
  ["Options", "child-seat", ["name_ja"], [["ja", "name", "en"]]],
];

test("missing translations warn and fall back to en then ja", async (t) => {
  for (const [tab, key, blanks, fallbacks] of FALLBACKS) {
    await t.test(`${tab} ${key} without ${blanks.join(" and ")}`, () => {
      const workbook = validWorkbook();
      for (const column of blanks) setCell(workbook, tab, key, column, "");
      const row = sheetRow(workbook, tab, key);

      const expected = expectedCatalog();
      const texts = textsOf(expected, tab, key);
      for (const [locale, field, from] of fallbacks) texts[locale][field] = texts[from][field];

      const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);
      assert.deepEqual(fatal, []);
      assert.deepEqual(canonical(catalog), canonical(expected));
      assert.deepEqual(notOk(statuses), [`${tab} ${row}`]);
      assert.deepEqual(errors(statuses), []);
      for (const column of blanks) assertWarning(statuses, tab, row, column);
    });
  }
});

const BLANKS = ["　", " ", "　 　", "\t\n", " "];

// [tab, key, field, the cells set by suffix, the text each locale ends up with].
type TypedFallback = [string, string, string, Record<string, string>, Record<string, string>];
const TYPED_FALLBACKS: TypedFallback[] = [
  [
    "Models",
    "rebel-250",
    "name",
    { ja: "レブル　２５０", en: "Ｒｅｂｅｌ，２５０", zh: "　", ko: "" },
    { ja: "レブル　２５０", en: "Ｒｅｂｅｌ，２５０", "zh-cn": "Ｒｅｂｅｌ，２５０", ko: "Ｒｅｂｅｌ，２５０" },
  ],
  [
    "Models",
    "rebel-250",
    "summary",
    { ja: "①免許証が必要", en: "　", zh: "简介", ko: "" },
    { ja: "①免許証が必要", en: "①免許証が必要", "zh-cn": "简介", ko: "①免許証が必要" },
  ],
  [
    "Packages",
    "day-1",
    "name",
    { ja: " ", en: "", zh: "", ko: "ｋｏ　名前！" },
    { ja: "ｋｏ　名前！", en: "ｋｏ　名前！", "zh-cn": "ｋｏ　名前！", ko: "ｋｏ　名前！" },
  ],
  [
    "Options",
    "child-seat",
    "name",
    { ja: "チャイルドシート（１歳～）", en: "", zh: "儿童座椅，１岁起", ko: "" },
    {
      ja: "チャイルドシート（１歳～）",
      en: "チャイルドシート（１歳～）",
      "zh-cn": "儿童座椅，１岁起",
      ko: "チャイルドシート（１歳～）",
    },
  ],
];

test("a text cell of only whitespace is blank, and a fallback is kept as typed", async (t) => {
  for (const [tab, key, blanks, fallbacks] of FALLBACKS) {
    await t.test(`${tab} ${key} with ${blanks.join(" and ")} left as spaces`, () => {
      const workbook = validWorkbook();
      blanks.forEach((column, at) => setCell(workbook, tab, key, column, BLANKS[at % BLANKS.length]));
      const row = sheetRow(workbook, tab, key);

      const expected = expectedCatalog();
      const texts = textsOf(expected, tab, key);
      for (const [locale, field, from] of fallbacks) texts[locale][field] = texts[from][field];

      const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);
      assert.deepEqual(fatal, []);
      assert.deepEqual(canonical(catalog), canonical(expected));
      assert.deepEqual(notOk(statuses), [`${tab} ${row}`]);
      assert.deepEqual(errors(statuses), []);
      for (const column of blanks) assertWarning(statuses, tab, row, column);
    });
  }

  for (const [tab, key, field, cells, want] of TYPED_FALLBACKS) {
    await t.test(`${tab} ${key} ${field} falls back to the text as typed`, () => {
      const workbook = validWorkbook();
      for (const [suffix, value] of Object.entries(cells)) setCell(workbook, tab, key, `${field}_${suffix}`, value);
      const row = sheetRow(workbook, tab, key);
      const expected = expectedCatalog();
      const texts = textsOf(expected, tab, key);
      for (const [locale, text] of Object.entries(want)) texts[locale][field] = text;

      const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);
      assert.deepEqual(fatal, []);
      assert.deepEqual(canonical(catalog), canonical(expected));
      assert.deepEqual(errors(statuses), []);
      for (const [suffix, value] of Object.entries(cells)) {
        if (value.trim() === "") assertWarning(statuses, tab, row, `${field}_${suffix}`);
      }
    });
  }

  await t.test("a name of only whitespace in every language is still an error", () => {
    const workbook = validWorkbook();
    const row = sheetRow(workbook, "Models", "pcx-125");
    LOCALE_COLUMNS.forEach(([suffix], at) => setCell(workbook, "Models", "pcx-125", `name_${suffix}`, BLANKS[at]));
    const { catalog, statuses } = validateCatalog(workbook, CATALOG_NOW);
    assertError(statuses, "Models", row, ["name_ja", "name_en"]);
    assert.ok(catalog);
    assert.equal(
      catalog.models.some((model) => model.id === "pcx-125"),
      false,
    );
  });
});

// [type, cc, override, the class that results].
const LICENSE_CLASSES: [string, number, string, string][] = [
  ["motorcycle", 50, "", "moped"],
  ["scooter", 50, "", "moped"],
  ["scooter", 1, "", "moped"],
  ["motorcycle", 51, "", "small"],
  ["scooter", 51, "", "small"],
  ["motorcycle", 125, "", "small"],
  ["scooter", 125, "", "small"],
  ["motorcycle", 126, "", "standard"],
  ["scooter", 250, "", "standard"],
  ["motorcycle", 400, "", "standard"],
  ["motorcycle", 401, "", "large"],
  ["scooter", 650, "", "large"],
  ["motorcycle", 1800, "", "large"],
  ["car", 50, "", "car"],
  ["car", 660, "", "car"],
  ["car", 2000, "", "car"],
  ["car", 660, "car", "car"],
  ["car", 1500, "car", "car"],
  ["motorcycle", 125, "moped", "moped"],
  ["scooter", 125, "moped", "moped"],
  ["motorcycle", 90, "moped", "moped"],
  ["motorcycle", 50, "moped", "moped"],
  ["motorcycle", 125, "standard", "standard"],
  ["motorcycle", 400, "large", "large"],
];

// [cc, override]: a car stays a car. A moped override on a car is a warning at any size, not the bike's 125 cc error.
const CAR_OVERRIDES: [number, string][] = [
  [100, "moped"],
  [660, "moped"],
  [660, "small"],
  [1500, "standard"],
  [2000, "large"],
];

test("license class defaults from cc and type", async (t) => {
  for (const [type, cc, override, licenseClass] of LICENSE_CLASSES) {
    await t.test(`${type} ${cc} cc${override ? `, override ${override}` : ""}`, () => {
      const workbook = validWorkbook();
      setCell(workbook, "Models", "rebel-250", "type_id", type);
      setCell(workbook, "Models", "rebel-250", "engine_cc", cc);
      setCell(workbook, "Models", "rebel-250", "license_class", override);

      const expected = expectedCatalog();
      const model = modelOf(expected, "rebel-250");
      model.typeId = type as Model["typeId"];
      model.engineCc = cc;
      model.licenseClass = licenseClass as Model["licenseClass"];
      assertPublishes(workbook, expected);
    });
  }

  for (const [cc, override] of CAR_OVERRIDES) {
    await t.test(`car ${cc} cc, override ${override} stays car with a warning`, () => {
      const workbook = validWorkbook();
      setCell(workbook, "Models", "nbox-660", "engine_cc", cc);
      setCell(workbook, "Models", "nbox-660", "license_class", override);
      const row = sheetRow(workbook, "Models", "nbox-660");

      const expected = expectedCatalog();
      modelOf(expected, "nbox-660").engineCc = cc;

      const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);
      assert.deepEqual(fatal, []);
      assert.deepEqual(canonical(catalog), canonical(expected));
      assert.deepEqual(notOk(statuses), [`Models ${row}`]);
      assert.deepEqual(errors(statuses), []);
      assertWarning(statuses, "Models", row, "license_class");
    });
  }
});

// E-bikes (#130): no engine, no license. The rows of tests/fixtures/sheet/ebike.ts are appended to the valid fixture.

/** Each sheet row of `tab` named by `keys`, as "Tab row", sorted like `errors`. */
function rowsOf(workbook: Workbook, tab: string, keys: string[]): string[] {
  return keys.map((key) => `${tab} ${sheetRow(workbook, tab, key)}`);
}

/** The model is an error naming `column`, its vehicles errors naming model_id, and nothing else is. */
function assertModelSkipped(workbook: Workbook, id: string, plates: string[], column: string, expected: Catalog): void {
  const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);
  assert.deepEqual(fatal, []);
  assertError(statuses, "Models", sheetRow(workbook, "Models", id), [column]);
  for (const plate of plates) assertError(statuses, "Vehicles", sheetRow(workbook, "Vehicles", plate), ["model_id"]);
  assert.deepEqual(errors(statuses), [...rowsOf(workbook, "Models", [id]), ...rowsOf(workbook, "Vehicles", plates)].sort());
  assert.deepEqual(canonical(catalog), canonical(withoutDropped(expected, { models: [id], vehicles: plates })));
}

test("an e-bike publishes with no engine and no license", async (t) => {
  await t.test("a Types row ebike, a class in group ebike, its prices, an e-bike model and an ebike option", () => {
    const workbook = validWorkbook();
    addEbike(workbook);
    assertPublishes(workbook, withEbike(expectedCatalog()));
  });

  // Every way a cell reads as blank, and license_class none as typed, which is no override and so no warning.
  for (const [blank, engineCc] of [["empty", ""], ["spaces", "   "], ["an ideographic space", "　"]]) {
    for (const licenseClass of ["", "none", " none "]) {
      await t.test(`engine_cc ${blank}, license_class ${JSON.stringify(licenseClass)}`, () => {
        const workbook = validWorkbook();
        addEbike(workbook, { engine_cc: engineCc, license_class: licenseClass });
        assertPublishes(workbook, withEbike(expectedCatalog()));
      });
    }
  }

  await t.test("a second e-bike model of other values publishes beside the first", () => {
    const workbook = validWorkbook();
    addEbike(workbook);
    appendRow(workbook, "Models", ebikeModelCells({ model_id: "cargo-e", sort: 7, brand: "Yamaha", seats: 2, active: "FALSE" }));

    const expected = withEbike(expectedCatalog());
    expected.models.push({ ...EBIKE_MODEL_ROW, id: "cargo-e", sort: 7, brand: "Yamaha", seats: 2, active: false });
    assertPublishes(workbook, expected);
  });
});

test("an e-bike with an engine_cc is a row error", async (t) => {
  // Valid and invalid numbers alike: staff most likely picked the wrong type. The rest of the e-bike rows still publish.
  for (const cc of [1, 20, 250, 660, "50", "５０", "0", -5, 12.5, "abc"]) {
    await t.test(`an e-bike with engine_cc ${JSON.stringify(cc)}`, () => {
      const workbook = validWorkbook();
      addEbike(workbook, { engine_cc: cc });
      assertModelSkipped(workbook, EBIKE_MODEL, EBIKE_PLATES, "engine_cc", withEbike(expectedCatalog()));
    });
  }

  // engine_cc stays required for every other type, beside a published e-bike.
  for (const [id, type, plates] of [
    ["today-50", "scooter", ["わ1001"]],
    ["rebel-250", "motorcycle", ["わ1005"]],
    ["nbox-660", "car", ["わ1006"]],
  ] as const) {
    await t.test(`a ${type} with a blank engine_cc`, () => {
      const workbook = validWorkbook();
      addEbike(workbook);
      setCell(workbook, "Models", id, "engine_cc", "");
      assertModelSkipped(workbook, id, [...plates], "engine_cc", withEbike(expectedCatalog()));
    });
  }
});

test("license_class none is only for e-bikes", async (t) => {
  for (const [id, type, plates] of [
    ["today-50", "scooter", ["わ1001"]],
    ["rebel-250", "motorcycle", ["わ1005"]],
    ["nbox-660", "car", ["わ1006"]],
  ] as const) {
    await t.test(`license_class none on a ${type} is a row error`, () => {
      const workbook = validWorkbook();
      addEbike(workbook);
      setCell(workbook, "Models", id, "license_class", "none");
      assertModelSkipped(workbook, id, [...plates], "license_class", withEbike(expectedCatalog()));
    });
  }

  // none is a class the sheet knows, refused for the type: its message is not the one for a class that does not exist.
  await t.test("none on a motorcycle reads differently from an unknown class", () => {
    const problemOf = (value: string): string => {
      const workbook = validWorkbook();
      addEbike(workbook);
      setCell(workbook, "Models", "rebel-250", "license_class", value);
      const row = sheetRow(workbook, "Models", "rebel-250");
      const [status] = statusesAt(validateCatalog(workbook, CATALOG_NOW).statuses, "Models", row, "error");
      assert.ok(status, `license_class ${value} has no error`);
      return status.message.replaceAll(value, "#");
    };
    assert.notEqual(problemOf("none"), problemOf("huge"));
  });

  // As for a car: an e-bike is always none, and any other class typed there is ignored with a warning.
  for (const override of ["moped", "small", "standard", "large", "car"]) {
    await t.test(`an e-bike with license_class ${override} stays none with a warning`, () => {
      const workbook = validWorkbook();
      addEbike(workbook, { license_class: override });
      const row = sheetRow(workbook, "Models", EBIKE_MODEL);

      const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);
      assert.deepEqual(fatal, []);
      assert.deepEqual(canonical(catalog), canonical(withEbike(expectedCatalog())));
      assert.deepEqual(notOk(statuses), [`Models ${row}`]);
      assert.deepEqual(errors(statuses), []);
      assertWarning(statuses, "Models", row, "license_class");
    });
  }
});

// [days, hours, as the Package reads them].
const PACKAGE_LENGTHS: [unknown, unknown, number | null, number | null][] = [
  [1, "", 1, null],
  [2, "", 2, null],
  [60, "", 60, null],
  ["", 1, null, 1],
  ["", 24, null, 24],
  ["", 72, null, 72],
  ["７", "", 7, null],
];

const BAD_PACKAGE_LENGTHS: [unknown, unknown][] = [
  ["", ""],
  [3, 6],
  [0, ""],
  ["", 0],
  [0, 24],
  [3, 0],
  [61, ""],
  ["", 73],
  [-1, ""],
  ["", -2],
  [1.5, ""],
  ["", 2.5],
  ["abc", ""],
  ["", "abc"],
];

test("a package needs exactly one of days or hours", async (t) => {
  for (const [days, hours, readDays, readHours] of PACKAGE_LENGTHS) {
    await t.test(`days ${JSON.stringify(days)}, hours ${JSON.stringify(hours)} is valid`, () => {
      const workbook = validWorkbook();
      setCell(workbook, "Packages", "day-3", "days", days);
      setCell(workbook, "Packages", "day-3", "hours", hours);
      const expected = expectedCatalog();
      Object.assign(packageOf(expected, "day-3"), { days: readDays, hours: readHours });
      assertPublishes(workbook, expected);
    });
  }

  const pricesOfDay3 = ["scooter-50/day-3", "bike-125/day-3", "bike-400/day-3", "car-k/day-3"];
  for (const [days, hours] of BAD_PACKAGE_LENGTHS) {
    await t.test(`days ${JSON.stringify(days)}, hours ${JSON.stringify(hours)} is rejected`, () => {
      const workbook = validWorkbook();
      setCell(workbook, "Packages", "day-3", "days", days);
      setCell(workbook, "Packages", "day-3", "hours", hours);
      const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);

      assert.deepEqual(fatal, []);
      assertError(statuses, "Packages", sheetRow(workbook, "Packages", "day-3"), ["days", "hours"]);
      for (const key of pricesOfDay3) {
        assertError(statuses, "Prices", sheetRow(workbook, "Prices", key), ["package_id"]);
      }
      const expected = withoutDropped(expectedCatalog(), { packages: ["day-3"], prices: pricesOfDay3 });
      assert.deepEqual(canonical(catalog), canonical(expected));
    });
  }
});

// What each model of the fixture costs, written out from its rate class's rows in the Prices tab.
const INHERITED_PRICES: Record<string, Record<string, number>> = {
  "today-50": { "hours-6": 2500, "day-1": 3500, "day-3": 9000 },
  "pcx-125": { "hours-6": 3600, "day-1": 5200, "day-3": 13800 },
  "cub-110": { "hours-6": 3600, "day-1": 5200, "day-3": 13800 },
  "rebel-250": { "hours-6": 6100, "day-1": 9100, "day-3": 24700 },
  "nbox-660": { "day-1": 7300, "day-3": 18900 },
};

function pricesOfModel(catalog: Catalog, id: string): Record<string, number> {
  const { rateClassId } = modelOf(catalog, id);
  const prices = catalog.prices.filter((price) => price.rateClassId === rateClassId);
  return Object.fromEntries(prices.map((price) => [price.packageId, price.priceJpy]));
}

test("a model with a rate class needs no price rows of its own", async (t) => {
  await t.test("the fixture's models inherit their class's prices", () => {
    const { catalog } = validateCatalog(validWorkbook(), CATALOG_NOW);
    assert.ok(catalog);
    for (const [id, prices] of Object.entries(INHERITED_PRICES)) {
      assert.deepEqual(pricesOfModel(catalog, id), prices, id);
    }
  });

  for (const [rateClass, sibling] of [
    ["bike-125", "pcx-125"],
    ["car-k", "nbox-660"],
    ["scooter-50", "today-50"],
  ]) {
    await t.test(`a new model and vehicle in ${rateClass} add no price rows`, () => {
      const workbook = validWorkbook();
      appendCopy(workbook, "Models", sibling, { model_id: "new-model", rate_class_id: rateClass });
      appendRow(workbook, "Vehicles", { plate: "わ7777", model_id: "new-model", status: "active" });

      const expected = expectedCatalog();
      expected.models.push({ ...modelOf(expected, sibling), id: "new-model", rateClassId: rateClass });
      expected.vehicles.push({
        plate: "わ7777",
        modelId: "new-model",
        status: "active",
        odometerKm: null,
        baseUsageDays: 0,
      });
      assertPublishes(workbook, expected);

      const { catalog } = validateCatalog(workbook, CATALOG_NOW);
      assert.ok(catalog);
      assert.deepEqual(pricesOfModel(catalog, "new-model"), INHERITED_PRICES[sibling]);
    });
  }
});

/** [what the row does wrong, the mutation, the column its error names, the row's block id, its skippedBlockIds]. */
type BadBlock = [string, (workbook: Workbook) => void, string, string, string[]];

const BAD_BLOCKS: BadBlock[] = [
  ...["soon", "", true, 1e12, "2030-02-30 10:00", "2030-07-15 25:00"].map(
    (start): BadBlock => [
      `start ${JSON.stringify(start)}`,
      (workbook) => setCell(workbook, "Blocks", "BLK-2", "start", start),
      "start",
      "BLK-2",
      ["BLK-2"],
    ],
  ),
  ...["whenever", "", false, 1e12, "2030-13-01 10:00"].map(
    (end): BadBlock => [
      `end ${JSON.stringify(end)}`,
      (workbook) => setCell(workbook, "Blocks", "BLK-2", "end", end),
      "end",
      "BLK-2",
      ["BLK-2"],
    ],
  ),
  [
    "an end equal to the start, as text",
    (workbook) => setCell(workbook, "Blocks", "BLK-1", "end", "2030-07-15 09:00"),
    "end",
    "BLK-1",
    ["BLK-1"],
  ],
  [
    "an end before the start, as text",
    (workbook) => setCell(workbook, "Blocks", "BLK-1", "end", "2030-07-15 08:59"),
    "end",
    "BLK-1",
    ["BLK-1"],
  ],
  [
    "an end equal to the start, as serials",
    (workbook) => setCell(workbook, "Blocks", "BLK-2", "end", sheetSerial("2030-08-01", "10:00")),
    "end",
    "BLK-2",
    ["BLK-2"],
  ],
  [
    "an end before the start, a serial against text",
    (workbook) => setCell(workbook, "Blocks", "BLK-1", "end", sheetSerial("2030-07-14", "09:00")),
    "end",
    "BLK-1",
    ["BLK-1"],
  ],
  [
    "an unknown model",
    (workbook) => setCell(workbook, "Blocks", "BLK-1", "model_id", "ghost"),
    "model_id",
    "BLK-1",
    ["BLK-1"],
  ],
  [
    "a blank model",
    (workbook) => setCell(workbook, "Blocks", "BLK-3", "model_id", ""),
    "model_id",
    "BLK-3",
    ["BLK-3"],
  ],
  [
    "an unknown plate",
    (workbook) => setCell(workbook, "Blocks", "BLK-1", "plate", "わ9999"),
    "plate",
    "BLK-1",
    ["BLK-1"],
  ],
  [
    "a plate of another model",
    (workbook) => setCell(workbook, "Blocks", "BLK-3", "plate", "わ1005"),
    "plate",
    "BLK-3",
    ["BLK-3"],
  ],
  // The id in skippedBlockIds is the one a stored block carries, so these two read as the valid rows would.
  [
    "a bad date on a block_id that arrives as a number",
    (workbook) => {
      setCell(workbook, "Blocks", "BLK-2", "start", "soon");
      setCell(workbook, "Blocks", "BLK-2", "block_id", 2002);
    },
    "start",
    "BLK-2",
    ["2002"],
  ],
  [
    "a bad date on a full-width block_id",
    (workbook) => {
      setCell(workbook, "Blocks", "BLK-2", "start", "soon");
      setCell(workbook, "Blocks", "BLK-2", "block_id", "ＢＬＫ－２");
    },
    "start",
    "BLK-2",
    ["BLK-2"],
  ],
  ["a blank block_id", (workbook) => setCell(workbook, "Blocks", "BLK-2", "block_id", ""), "block_id", "BLK-2", []],
  ["a duplicate block_id", (workbook) => appendCopy(workbook, "Blocks", "BLK-1", {}), "block_id", APPENDED, []],
];

// [what is special, the row's block id, the cells to edit, and the change that makes to that block].
const GOOD_BLOCKS: [string, string, Record<string, unknown>, (block: Block) => void][] = [
  ["a full-width plate", "BLK-2", { plate: "わ１００５" }, () => {}],
  [
    "a blank plate",
    "BLK-3",
    { plate: "" },
    (block) => {
      block.plate = null;
    },
  ],
  ["a full-width model_id", "BLK-1", { model_id: "ｐｃｘ－１２５" }, () => {}],
  [
    "a block_id that arrives as a number",
    "BLK-2",
    { block_id: 2002 },
    (block) => {
      block.blockId = "2002";
    },
  ],
  [
    "a reference that arrives as a number",
    "BLK-2",
    { reference: 778899 },
    (block) => {
      block.reference = "778899";
    },
  ],
  [
    "a text start in full-width characters",
    "BLK-1",
    { start: "２０３０－０７－１４　１８：４５" },
    (block) => {
      block.startAt = Date.parse("2030-07-14T18:45:00+09:00");
    },
  ],
  [
    "a text end after midnight JST, the UTC day before",
    "BLK-1",
    { end: "2030-07-16 00:30" },
    (block) => {
      block.endAt = Date.UTC(2030, 6, 15, 15, 30);
    },
  ],
  [
    "an end one minute after the start",
    "BLK-1",
    { end: "2030-07-15 09:01" },
    (block) => {
      block.endAt = Date.parse("2030-07-15T09:01:00+09:00");
    },
  ],
  [
    "a serial end with minutes",
    "BLK-3",
    { end: sheetSerial("2030-08-02", "16:15") },
    (block) => {
      block.endAt = Date.parse("2030-08-02T16:15:00+09:00");
    },
  ],
  [
    "an inactive model",
    "BLK-1",
    { model_id: "cub-110" },
    (block) => {
      block.modelId = "cub-110";
    },
  ],
  [
    "a plate in maintenance",
    "BLK-1",
    { plate: "わ1003" },
    (block) => {
      block.plate = "わ1003";
    },
  ],
  [
    "a retired plate",
    "BLK-3",
    { model_id: "cub-110", plate: "わ1004" },
    (block) => {
      block.modelId = "cub-110";
      block.plate = "わ1004";
    },
  ],
];

const BLOCKS_HEADERS = validWorkbook().Blocks[0].map(String);

function sortedBlocks(blocks: Block[]): Block[] {
  return sortedBy(blocks, (block) => block.blockId);
}

/** Nothing comes back from a broken tab, and a fatal reason says which of `names` is at fault, as a whole word. */
function assertBlocksFatal(workbook: Workbook, names: string[]): void {
  const { blocks, fatal } = validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW);
  assert.deepEqual(blocks, []);
  assert.ok(
    fatal.some((message: string) => names.some((name) => new RegExp(`\\b${name}\\b`).test(message))),
    `no fatal reason names ${names.join(" or ")}: ${inspect(fatal)}`,
  );
}

test("validateBlocks checks dates, model, optional plate and duplicate ids", async (t) => {
  await t.test("the valid fixture gives its blocks, serial and text datetimes alike", () => {
    const workbook = validWorkbook();
    const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW);
    assert.deepEqual(sortedBlocks(blocks), EXPECTED_BLOCKS);
    assert.deepEqual(notOk(statuses), []);
    assert.deepEqual(rowsWhere(statuses, ({ tab }) => tab === "Blocks"), ["Blocks 2", "Blocks 3", "Blocks 4"]);
    assert.deepEqual(fatal, []);
    assert.deepEqual(skippedBlockIds, []);
  });

  for (const [name, mutate, column, key, skipped] of BAD_BLOCKS) {
    await t.test(`rejects ${name}`, () => {
      const pristine = validWorkbook();
      const workbook = validWorkbook();
      mutate(workbook);
      const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW);

      const row = key === APPENDED ? workbook.Blocks.length : sheetRow(pristine, "Blocks", key);
      assertError(statuses, "Blocks", row, [column]);
      assert.deepEqual(errors(statuses), [`Blocks ${row}`]);
      assert.deepEqual(
        sortedBlocks(blocks),
        EXPECTED_BLOCKS.filter(({ blockId }) => key === APPENDED || blockId !== key),
      );
      assertEveryRowHasAStatus(workbook, statuses, ["Blocks"]);
      assert.deepEqual(fatal, []);
      assert.deepEqual(skippedBlockIds, skipped);
    });
  }

  await t.test("every rejected block is listed", () => {
    const workbook = validWorkbook();
    setCell(workbook, "Blocks", "BLK-1", "start", "soon");
    setCell(workbook, "Blocks", "BLK-3", "plate", "わ9999");
    const { blocks, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW);
    assert.deepEqual(fatal, []);
    assert.deepEqual([...skippedBlockIds].sort(), ["BLK-1", "BLK-3"]);
    assert.deepEqual(sortedBlocks(blocks), EXPECTED_BLOCKS.filter(({ blockId }) => blockId === "BLK-2"));
  });

  for (const [name, key, cells, change] of GOOD_BLOCKS) {
    await t.test(`accepts ${name}`, () => {
      const workbook = validWorkbook();
      for (const [column, value] of Object.entries(cells)) setCell(workbook, "Blocks", key, column, value);
      const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW);

      const expected = structuredClone(EXPECTED_BLOCKS);
      const block = expected.find(({ blockId }) => blockId === key);
      assert.ok(block);
      change(block);
      assert.deepEqual(notOk(statuses), []);
      assert.deepEqual(sortedBlocks(blocks), sortedBlocks(expected));
      assert.deepEqual(fatal, []);
      assert.deepEqual(skippedBlockIds, []);
    });
  }

  // #21 cancels any future block missing from `blocks`, so a broken tab has to stop it, not read as deleted rows.
  await t.test("no Blocks tab is fatal", () => {
    const workbook = validWorkbook();
    delete workbook.Blocks;
    assertBlocksFatal(workbook, ["Blocks"]);
  });

  await t.test("a Blocks tab with no rows, as batchGet returns an empty tab, is fatal", () => {
    const workbook = validWorkbook();
    workbook.Blocks = [];
    assertBlocksFatal(workbook, ["Blocks", ...BLOCKS_HEADERS]);
  });

  for (const header of BLOCKS_HEADERS) {
    await t.test(`Blocks without ${header} is fatal`, () => {
      const workbook = validWorkbook();
      removeColumn(workbook, "Blocks", header);
      assertBlocksFatal(workbook, [header]);
    });
  }

  await t.test("a Blocks tab with only its header has no blocks, and nothing is fatal", () => {
    const workbook = validWorkbook();
    workbook.Blocks = workbook.Blocks.slice(0, 1);
    const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW);
    assert.deepEqual(blocks, []);
    assert.deepEqual(notOk(statuses), []);
    assert.deepEqual(fatal, []);
    assert.deepEqual(skippedBlockIds, []);
  });

  await t.test("a model is known by the catalog it is given", () => {
    const skipped = expectedCatalog();
    skipped.models = skipped.models.filter(({ id }) => id !== "pcx-125");
    skipped.vehicles = skipped.vehicles.filter(({ modelId }) => modelId !== "pcx-125");
    const workbook = validWorkbook();
    const rejected = validateBlocks(workbook, skipped, BLOCKS_NOW);
    assertError(rejected.statuses, "Blocks", sheetRow(workbook, "Blocks", "BLK-1"), ["model_id"]);
    assert.deepEqual(sortedBlocks(rejected.blocks), EXPECTED_BLOCKS.filter(({ blockId }) => blockId !== "BLK-1"));
    assert.deepEqual(rejected.skippedBlockIds, ["BLK-1"]);

    const added = expectedCatalog();
    added.models.push({ ...modelOf(added, "pcx-125"), id: "new-model" });
    added.vehicles.push({
      plate: "わ7777",
      modelId: "new-model",
      status: "active",
      odometerKm: null,
      baseUsageDays: 0,
    });
    setCell(workbook, "Blocks", "BLK-1", "model_id", "new-model");
    setCell(workbook, "Blocks", "BLK-1", "plate", "わ7777");
    const accepted = validateBlocks(workbook, added, BLOCKS_NOW);
    assert.deepEqual(notOk(accepted.statuses), []);
    const expected = structuredClone(EXPECTED_BLOCKS);
    Object.assign(expected[0], { modelId: "new-model", plate: "わ7777" });
    assert.deepEqual(sortedBlocks(accepted.blocks), expected);
  });
});

/** The ts-ignore covers the field for lint until #21 adds it, and nothing else. */
function blankIdRowsOf(workbook: Workbook): number {
  // @ts-ignore
  return validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW).blankIdRows;
}

// #21 stops its cancel pass for a row it cannot name, so a blank block_id has to be counted apart from readable ones.
test("validateBlocks counts the rows rejected for a blank block_id", async (t) => {
  const BLANK_ID: [string, (workbook: Workbook) => void, number][] = [
    ["a clean tab", () => {}, 0],
    ["a row rejected with a readable id", (workbook) => setCell(workbook, "Blocks", "BLK-2", "start", "soon"), 0],
    ["a duplicate id", (workbook) => appendCopy(workbook, "Blocks", "BLK-1", {}), 0],
    ["a blank id", (workbook) => setCell(workbook, "Blocks", "BLK-2", "block_id", ""), 1],
    ["an id of spaces", (workbook) => setCell(workbook, "Blocks", "BLK-1", "block_id", "   "), 1],
    ["an id of ideographic spaces", (workbook) => setCell(workbook, "Blocks", "BLK-3", "block_id", "　　"), 1],
    [
      "two blank ids",
      (workbook) => {
        setCell(workbook, "Blocks", "BLK-1", "block_id", "");
        setCell(workbook, "Blocks", "BLK-3", "block_id", "");
      },
      2,
    ],
    [
      "every id blank",
      (workbook) => {
        for (const key of ["BLK-1", "BLK-2", "BLK-3"]) setCell(workbook, "Blocks", key, "block_id", "");
      },
      3,
    ],
    [
      "a blank id on a row wrong in other ways too",
      (workbook) => {
        setCell(workbook, "Blocks", "BLK-2", "start", "soon");
        setCell(workbook, "Blocks", "BLK-2", "model_id", "ghost");
        setCell(workbook, "Blocks", "BLK-2", "block_id", "");
      },
      1,
    ],
    [
      "a blank id beside a readable rejected id",
      (workbook) => {
        setCell(workbook, "Blocks", "BLK-1", "start", "soon");
        setCell(workbook, "Blocks", "BLK-2", "block_id", "");
      },
      1,
    ],
    ["a wholly blank row, which is no data row", (workbook) => workbook.Blocks.splice(2, 0, []), 0],
    ["only a stale publish_status", (workbook) => appendRow(workbook, "Blocks", { publish_status: "error: stale" }), 0],
    ["only an unticked box", (workbook) => appendRow(workbook, "Blocks", { note: false }), 0],
    ["a tab with only its header", (workbook) => workbook.Blocks.splice(1), 0],
    ["a tab with no rows, which is fatal", (workbook) => workbook.Blocks.splice(0), 0],
    ["a missing header, which is fatal", (workbook) => removeColumn(workbook, "Blocks", "start"), 0],
  ];

  for (const [name, mutate, expected] of BLANK_ID) {
    await t.test(name, () => {
      const workbook = validWorkbook();
      mutate(workbook);
      assert.equal(blankIdRowsOf(workbook), expected);
    });
  }

  await t.test("no Blocks tab counts none", () => {
    const workbook = validWorkbook();
    delete workbook.Blocks;
    assert.equal(blankIdRowsOf(workbook), 0);
  });

  await t.test("a blank id still lists nothing in skippedBlockIds", () => {
    const workbook = validWorkbook();
    setCell(workbook, "Blocks", "BLK-1", "start", "soon");
    setCell(workbook, "Blocks", "BLK-2", "block_id", "");
    const { blocks, skippedBlockIds } = validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW);
    assert.deepEqual(skippedBlockIds, ["BLK-1"]);
    assert.equal(blankIdRowsOf(workbook), 1);
    assert.deepEqual(sortedBlocks(blocks), EXPECTED_BLOCKS.filter(({ blockId }) => blockId === "BLK-3"));
  });
});

// What Insert > Checkbox on a whole column leaves in a row nobody filled in: boolean false there, and nothing else.
const UNTICKED_ROWS: [string, Record<string, unknown>][] = [
  ["only an unticked box", { active: false }],
  ["an unticked box and a stale publish_status", { active: false, publish_status: "error: a stale message" }],
];

test("row numbers in statuses are 1-based sheet rows, past a blank row too", async (t) => {
  const workbook = validWorkbook();
  // Sheet row 3 left blank, which batchGet returns as an empty row, so the last model moves down to row 7.
  workbook.Models.splice(2, 0, []);
  setCell(workbook, "Models", "nbox-660", "engine_cc", "abc");
  setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", "free");

  const { statuses } = validateCatalog(workbook, CATALOG_NOW);

  assert.deepEqual(errors(statuses), ["Models 7", "Prices 6", "Vehicles 7"]);
  assert.deepEqual(
    rowsWhere(statuses, ({ tab, level }) => tab === "Models" && level === "ok").filter((row) => row !== "Models 3"),
    ["Models 2", "Models 4", "Models 5", "Models 6"],
  );

  for (const [name, cells] of UNTICKED_ROWS) {
    for (const count of [1, 3]) {
      await t.test(`${count} of a row with ${name}: ignored, and later rows keep their numbers`, () => {
        const workbook = validWorkbook();
        const rows = Array.from({ length: count }, () => rowWith(workbook, "Models", cells));
        workbook.Models.splice(2, 0, ...rows);

        const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);

        assert.deepEqual(fatal, []);
        assert.deepEqual(canonical(catalog), canonical(expectedCatalog()));
        assert.deepEqual(notOk(statuses), []);
        // Row 2 is today-50. The other four models sit below the blank rows.
        const numbers = [2, 3 + count, 4 + count, 5 + count, 6 + count];
        assert.deepEqual(
          rowsWhere(statuses, ({ tab }) => tab === "Models"),
          numbers.map((row) => `Models ${row}`),
        );
      });
    }
  }

  await t.test("a run of unticked boxes gives the same statuses as none at all", () => {
    const workbook = validWorkbook();
    for (let row = 0; row < 20; row += 1) appendRow(workbook, "Models", { active: false });

    const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);

    assert.deepEqual(fatal, []);
    assert.deepEqual(statuses, validateCatalog(validWorkbook(), CATALOG_NOW).statuses);
    assert.deepEqual(canonical(catalog), canonical(expectedCatalog()));
  });

  await t.test("an unticked box counts as blank on any tab", () => {
    const workbook = validWorkbook();
    appendRow(workbook, "Vehicles", { notes: false });
    appendRow(workbook, "Blocks", { note: false });

    assert.deepEqual(validateCatalog(workbook, CATALOG_NOW).statuses, validateCatalog(validWorkbook(), CATALOG_NOW).statuses);
    assert.deepEqual(
      validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW).statuses,
      validateBlocks(validWorkbook(), expectedCatalog(), BLOCKS_NOW).statuses,
    );
  });

  await t.test("a real row with active false stays an inactive model", () => {
    const workbook = validWorkbook();
    setCell(workbook, "Models", "pcx-125", "active", false);
    const expected = expectedCatalog();
    modelOf(expected, "pcx-125").active = false;
    assertPublishes(workbook, expected);
  });

  // A ticked box is a staff action, and only the boolean false is a checkbox's empty state.
  for (const cell of [true, "FALSE"]) {
    await t.test(`a row holding only ${JSON.stringify(cell)} is data and gets errors`, () => {
      const workbook = validWorkbook();
      workbook.Models.splice(2, 0, rowWith(workbook, "Models", { active: cell }));

      const { catalog, statuses, fatal } = validateCatalog(workbook, CATALOG_NOW);

      assert.deepEqual(fatal, []);
      assertError(statuses, "Models", 3, ["model_id"]);
      assert.deepEqual(errors(statuses), ["Models 3"]);
      assert.deepEqual(canonical(catalog), canonical(expectedCatalog()));
    });
  }
});

// The plausible window for Blocks start and end and for ClosedDates: 2 years either side of the publish date in JST, by
// calendar date and inclusive at both ends. The first publish is 00:30 JST, which is still the day before in UTC. A
// publish on Feb 29 has no anniversary, so its bounds fall on Feb 28.
type Window = { now: string; lo: string; hi: string };
const NOV_2: Window = { now: "2026-11-02T00:30:00+09:00", lo: "2024-11-02", hi: "2028-11-02" };
const NOV_3: Window = { now: "2026-11-03T12:00:00+09:00", lo: "2024-11-03", hi: "2028-11-03" };
const LEAP_DAY: Window = { now: "2028-02-29T10:00:00+09:00", lo: "2026-02-28", hi: "2030-02-28" };

type When = [date: string, time: string];
type Kind = "text" | "serial";
type Column = "start" | "end";

/** The cell in the form staff type: text, or the serial Sheets stores for the same wall clock. */
function cellOf([date, time]: When, kind: Kind): string | number {
  return kind === "text" ? `${date} ${time}` : sheetSerial(date, time);
}

function at([date, time]: When): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/**
 * The row gives a window reason for each column in `bad` and none for a column in `good`. The reason is any error that
 * holds both dates of the window, so no one sentence is pinned.
 */
function assertWindowReason(
  statuses: RowStatus[],
  tab: string,
  row: number,
  { lo, hi }: Pick<Window, "lo" | "hi">,
  bad: string[],
  good: string[] = [],
): void {
  const reasons = statusesAt(statuses, tab, row, "error")
    .map((status) => status.message)
    .filter((message) => message.includes(lo) && message.includes(hi));
  const names = (column: string) => reasons.some((message) => new RegExp(`\\b${column}\\b`).test(message));
  for (const column of bad) {
    assert.ok(names(column), `${tab} row ${row} needs an error naming ${column}, ${lo} and ${hi}: ${inspect(statuses)}`);
  }
  for (const column of good) {
    assert.ok(!names(column), `${tab} row ${row} blames ${column}, which is inside the window: ${inspect(reasons)}`);
  }
}

/** A Blocks tab holding only the rows given, each [block_id, start, end], all of model pcx-125. */
function blocksOf(rows: [string, unknown, unknown][]): Workbook {
  const workbook = validWorkbook();
  workbook.Blocks = workbook.Blocks.slice(0, 1);
  for (const [block_id, start, end] of rows) {
    appendRow(workbook, "Blocks", { block_id, model_id: "pcx-125", start, end });
  }
  return workbook;
}

function span({ blockId, startAt, endAt }: Block) {
  return { blockId, startAt, endAt };
}

test("validateBlocks skips serials outside the plausible window", () => {
  // Today is 46328 as a serial. 260105 and 202601 are dates typed as digits, which Sheets reads as days: 2612-02-21
  // and 2454-09-12.
  const now = Date.parse("2026-11-02T12:00:00+09:00");
  const workbook = blocksOf([
    ["DIGITS-1", 260105, 260106],
    ["DIGITS-2", 202601, 202602],
    ["TODAY", 46328.5, 46329.25],
  ]);
  const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog(), now);

  assert.deepEqual(fatal, []);
  assert.deepEqual(blocks.map(span), [
    {
      blockId: "TODAY",
      startAt: Date.parse("2026-11-02T12:00:00+09:00"),
      endAt: Date.parse("2026-11-03T06:00:00+09:00"),
    },
  ]);
  assert.deepEqual([...skippedBlockIds].sort(), ["DIGITS-1", "DIGITS-2"]);
  assert.deepEqual(errors(statuses), ["Blocks 2", "Blocks 3"]);
  assertWindowReason(statuses, "Blocks", 2, NOV_2, ["start"]);
  assertWindowReason(statuses, "Blocks", 3, NOV_2, ["start"]);
  assert.deepEqual(notOk(statuses.filter((status) => status.row === 4)), []);
  assertEveryRowHasAStatus(workbook, statuses, ["Blocks"]);
});

// [what was typed, the year Sheets reads it as]. A year before the window is also before the in-window time that the
// other column holds, and a year after it is also after.
const TYPED_DIGITS: [number, number][] = [
  [260105, 2612],
  [202601, 2454],
  [100000, 2173],
  [60105, 2064],
  [26105, 1971],
];

test("validateBlocks refuses dates typed as digits, in either column", async (t) => {
  const inside = sheetSerial("2026-11-05", "10:00");
  const now = Date.parse(NOV_2.now);
  for (const [digits, year] of TYPED_DIGITS) {
    const past = year < 2024;
    const cases: [Column, unknown, unknown, string[]][] = [
      ["start", digits, past ? inside : digits + 1, past ? ["end"] : []],
      ["end", past ? digits - 1 : inside, digits, past ? [] : ["start"]],
    ];
    for (const [column, start, end, good] of cases) {
      await t.test(`${digits} (year ${year}) as the ${column}`, () => {
        const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(
          blocksOf([["B-1", start, end]]),
          expectedCatalog(),
          now,
        );
        assert.deepEqual(fatal, []);
        assert.deepEqual(blocks, []);
        assert.deepEqual(skippedBlockIds, ["B-1"]);
        assert.deepEqual(errors(statuses), ["Blocks 2"]);
        assertWindowReason(statuses, "Blocks", 2, NOV_2, [column], good);
      });
    }
  }
});

// [what is on the edge, the publish, start, end, the columns refused]. Each of start and end is checked on its own.
const BLOCK_EDGES: [string, Window, When, When, Column[]][] = [
  ["the first allowed moment, midnight", NOV_2, ["2024-11-02", "00:00"], ["2024-11-02", "01:00"], []],
  ["the last minute before the window", NOV_2, ["2024-11-01", "23:59"], ["2024-11-02", "01:00"], ["start"]],
  ["the last allowed minute", NOV_2, ["2028-11-02", "22:00"], ["2028-11-02", "23:59"], []],
  ["midnight after the last allowed day", NOV_2, ["2028-11-02", "23:00"], ["2028-11-03", "00:00"], ["end"]],
  ["a start and an end both after the window", NOV_2, ["2028-11-03", "00:00"], ["2028-11-03", "01:00"], ["start", "end"]],
  ["a start and an end both before the window", NOV_2, ["2024-11-01", "10:00"], ["2024-11-01", "11:00"], ["start", "end"]],
  ["the day before a later publish's window", NOV_3, ["2024-11-02", "23:59"], ["2024-11-03", "01:00"], ["start"]],
  ["the last minute of a later publish's window", NOV_3, ["2028-11-03", "22:00"], ["2028-11-03", "23:59"], []],
  ["midnight after a later publish's window", NOV_3, ["2028-11-03", "23:00"], ["2028-11-04", "00:00"], ["end"]],
  ["Feb 28, the lower bound of a Feb 29 publish", LEAP_DAY, ["2026-02-28", "00:00"], ["2026-02-28", "01:00"], []],
  ["Feb 27, before a Feb 29 publish's window", LEAP_DAY, ["2026-02-27", "23:00"], ["2026-02-28", "01:00"], ["start"]],
  ["Feb 28, the upper bound of a Feb 29 publish", LEAP_DAY, ["2030-02-28", "22:00"], ["2030-02-28", "23:59"], []],
  ["Mar 1, after a Feb 29 publish's window", LEAP_DAY, ["2030-02-28", "23:00"], ["2030-03-01", "00:00"], ["end"]],
];

// Text and serial cells reach the same check, so every edge is tried with each column written either way.
const KINDS: [Kind, Kind][] = [
  ["text", "text"],
  ["serial", "serial"],
  ["text", "serial"],
  ["serial", "text"],
];

test("validateBlocks window: calendar dates in JST, inclusive, each of start and end on its own", async (t) => {
  for (const [name, window, start, end, bad] of BLOCK_EDGES) {
    for (const [startKind, endKind] of KINDS) {
      await t.test(`${name}, start as ${startKind} and end as ${endKind}`, () => {
        const workbook = blocksOf([["B-1", cellOf(start, startKind), cellOf(end, endKind)]]);
        const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(
          workbook,
          expectedCatalog(),
          Date.parse(window.now),
        );
        assert.deepEqual(fatal, []);
        assertEveryRowHasAStatus(workbook, statuses, ["Blocks"]);
        if (bad.length === 0) {
          assert.deepEqual(blocks.map(span), [{ blockId: "B-1", startAt: at(start), endAt: at(end) }]);
          assert.deepEqual(notOk(statuses), []);
          assert.deepEqual(skippedBlockIds, []);
        } else {
          assert.deepEqual(blocks, []);
          assert.deepEqual(skippedBlockIds, ["B-1"]);
          assert.deepEqual(errors(statuses), ["Blocks 2"]);
          assertWindowReason(
            statuses,
            "Blocks",
            2,
            window,
            bad,
            (["start", "end"] as Column[]).filter((column) => !bad.includes(column)),
          );
        }
      });
    }
  }
});

test("validateBlocks refuses a text date far outside the window, and the rest of the tab still publishes", () => {
  const workbook = validWorkbook();
  appendRow(workbook, "Blocks", {
    block_id: "TYPO-1",
    model_id: "pcx-125",
    start: "2612-02-21 10:00",
    end: "2612-02-22 10:00",
  });
  appendRow(workbook, "Blocks", {
    block_id: "TYPO-2",
    model_id: "pcx-125",
    start: "2030-07-20 10:00",
    end: "2612-02-21 10:00",
  });
  const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog(), BLOCKS_NOW);
  const window = { lo: "2028-01-01", hi: "2032-01-01" };

  assert.deepEqual(fatal, []);
  assert.deepEqual(sortedBlocks(blocks), EXPECTED_BLOCKS);
  assert.deepEqual([...skippedBlockIds].sort(), ["TYPO-1", "TYPO-2"]);
  assert.deepEqual(errors(statuses), ["Blocks 5", "Blocks 6"]);
  assertWindowReason(statuses, "Blocks", 5, window, ["start"]);
  assertWindowReason(statuses, "Blocks", 6, window, ["end"], ["start"]);
  assertEveryRowHasAStatus(workbook, statuses, ["Blocks"]);
});

// [what is on the edge, the publish, the date, whether it stays]. ClosedDates take the same window as Blocks.
const CLOSED_EDGES: [string, Window, string, boolean][] = [
  ["the first allowed day", NOV_2, "2024-11-02", true],
  ["the day before the window", NOV_2, "2024-11-01", false],
  ["the last allowed day", NOV_2, "2028-11-02", true],
  ["the day after the window", NOV_2, "2028-11-03", false],
  ["the first day of a later publish's window", NOV_3, "2024-11-03", true],
  ["the day before a later publish's window", NOV_3, "2024-11-02", false],
  ["the last day of a later publish's window", NOV_3, "2028-11-03", true],
  ["the day after a later publish's window", NOV_3, "2028-11-04", false],
  ["Feb 28, the lower bound of a Feb 29 publish", LEAP_DAY, "2026-02-28", true],
  ["Feb 27, before a Feb 29 publish's window", LEAP_DAY, "2026-02-27", false],
  ["Feb 28, the upper bound of a Feb 29 publish", LEAP_DAY, "2030-02-28", true],
  ["Mar 1, after a Feb 29 publish's window", LEAP_DAY, "2030-03-01", false],
];

/** The valid workbook with one more closed date written as `cell`, published at `window`. */
function publishClosedDate(window: Window, cell: unknown, expectedDate: string | null) {
  const workbook = validWorkbook();
  appendRow(workbook, "ClosedDates", { date: cell });
  const row = workbook.ClosedDates.length;
  const { catalog, statuses, fatal } = validateCatalog(workbook, Date.parse(window.now));
  const expected = expectedCatalog();
  if (expectedDate !== null) expected.closedDates.push(expectedDate);

  assert.deepEqual(fatal, []);
  assert.deepEqual(canonical(catalog), canonical(expected));
  assertEveryRowHasAStatus(workbook, statuses, CATALOG_TABS);
  return { statuses, row };
}

test("validateCatalog window: closed dates are kept or dropped by the same dates as blocks", async (t) => {
  for (const [name, window, date, stays] of CLOSED_EDGES) {
    for (const kind of ["text", "serial"] as const) {
      await t.test(`${name}, as ${kind}`, () => {
        const cell = kind === "text" ? date : sheetSerial(date);
        const { statuses, row } = publishClosedDate(window, cell, stays ? date : null);
        if (stays) {
          assert.deepEqual(notOk(statuses), []);
        } else {
          assert.deepEqual(errors(statuses), [`ClosedDates ${row}`]);
          assertError(statuses, "ClosedDates", row, ["date"]);
          assertWindowReason(statuses, "ClosedDates", row, window, ["date"]);
        }
      });
    }
  }

  for (const cell of ["2612-02-21", "２６１２－０２－２１", 260105, 202601, 100000, 60105, 26105]) {
    await t.test(`${JSON.stringify(cell)} is dropped`, () => {
      const { statuses, row } = publishClosedDate(NOV_2, cell, null);
      assert.deepEqual(errors(statuses), [`ClosedDates ${row}`]);
      assertWindowReason(statuses, "ClosedDates", row, NOV_2, ["date"]);
    });
  }
});

test("SHEET_TABS names every tab's headers and BOOKINGS_COLUMNS the Bookings columns", () => {
  const tabs = SHEET_TABS as Record<string, readonly string[]>;
  const workbook = validWorkbook();

  assert.deepEqual(Object.keys(tabs).sort(), [
    "Blocks",
    "Bookings",
    "Cancellation",
    "ClosedDates",
    "Config",
    "Models",
    "Options",
    "Packages",
    "Prices",
    "PublishLog",
    "RateClasses",
    "Reconciliation",
    "Types",
    "Vehicles",
  ]);
  for (const [tab, rows] of Object.entries(workbook)) {
    assert.deepEqual([...tabs[tab]], rows[0], tab);
    assert.equal(tabs[tab].at(-1), "publish_status", tab);
  }

  assert.deepEqual(
    [...tabs.PublishLog],
    ["time", "user", "version", "counts", "blocks", "photos", "assignments", "message"],
  );

  const bookings = [
    "booking_ref",
    "booking_id",
    "status",
    "source",
    "model_id",
    "plate",
    "override_plate",
    "override_status",
    "start",
    "end",
    "package_id",
    "guest_name",
    "guest_email",
    "guest_phone",
    "locale",
    "price_jpy",
    "deposit_jpy",
    "paid_jpy",
    "refund_jpy",
    "refund_status",
    "created_at",
    "updated_at",
  ];
  assert.deepEqual([...BOOKINGS_COLUMNS], bookings);
  assert.deepEqual([...tabs.Bookings], bookings);
});
