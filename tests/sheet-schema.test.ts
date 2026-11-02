// validateCatalog and validateBlocks over a workbook in the shape values.batchGet returns. Every expected value is a
// literal, a hand-written fixture or Date.parse on an explicit +09:00 offset, never the code under test. Row order in a
// Catalog is not part of the contract, so catalogs are compared sorted by key. A row may carry several statuses, so
// checks look for a status naming the column, not for one status per problem.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { BOOKINGS_COLUMNS, SHEET_TABS, validateBlocks, validateCatalog } from "../src/lib/catalog/sheet-schema.ts";
import type { Catalog, Model, Package } from "../src/lib/types.ts";
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
  const { catalog, statuses, fatal } = validateCatalog(workbook);
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
  const { catalog, fatal } = validateCatalog(workbook);
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
  const { catalog, statuses, fatal } = validateCatalog(workbook);

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
      const { catalog, statuses, fatal } = validateCatalog(workbook);

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
      const [status] = statusesAt(validateCatalog(workbook).statuses, "Models", row, "error");
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

      const { blocks, statuses } = validateBlocks(workbook, expectedCatalog());
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
    name: "half-width katakana in a name",
    edit: ["Packages", "day-1", "name_ja", "ﾃﾞｲﾘｰ"],
    change: (catalog) => {
      textsOf(catalog, "Packages", "day-1").ja.name = "デイリー";
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
        const { catalog, statuses } = validateCatalog(workbook);
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

      const { catalog, statuses, fatal } = validateCatalog(workbook);
      assert.deepEqual(fatal, []);
      assert.deepEqual(canonical(catalog), canonical(expected));
      assert.deepEqual(notOk(statuses), [`${tab} ${row}`]);
      assert.deepEqual(errors(statuses), []);
      for (const column of blanks) assertWarning(statuses, tab, row, column);
    });
  }
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

      const { catalog, statuses, fatal } = validateCatalog(workbook);
      assert.deepEqual(fatal, []);
      assert.deepEqual(canonical(catalog), canonical(expected));
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
      const { catalog, statuses, fatal } = validateCatalog(workbook);

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
    const { catalog } = validateCatalog(validWorkbook());
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

      const { catalog } = validateCatalog(workbook);
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
  const { blocks, fatal } = validateBlocks(workbook, expectedCatalog());
  assert.deepEqual(blocks, []);
  assert.ok(
    fatal.some((message: string) => names.some((name) => new RegExp(`\\b${name}\\b`).test(message))),
    `no fatal reason names ${names.join(" or ")}: ${inspect(fatal)}`,
  );
}

test("validateBlocks checks dates, model, optional plate and duplicate ids", async (t) => {
  await t.test("the valid fixture gives its blocks, serial and text datetimes alike", () => {
    const workbook = validWorkbook();
    const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog());
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
      const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog());

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
    const { blocks, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog());
    assert.deepEqual(fatal, []);
    assert.deepEqual([...skippedBlockIds].sort(), ["BLK-1", "BLK-3"]);
    assert.deepEqual(sortedBlocks(blocks), EXPECTED_BLOCKS.filter(({ blockId }) => blockId === "BLK-2"));
  });

  for (const [name, key, cells, change] of GOOD_BLOCKS) {
    await t.test(`accepts ${name}`, () => {
      const workbook = validWorkbook();
      for (const [column, value] of Object.entries(cells)) setCell(workbook, "Blocks", key, column, value);
      const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog());

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
    const { blocks, statuses, fatal, skippedBlockIds } = validateBlocks(workbook, expectedCatalog());
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
    const rejected = validateBlocks(workbook, skipped);
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
    const accepted = validateBlocks(workbook, added);
    assert.deepEqual(notOk(accepted.statuses), []);
    const expected = structuredClone(EXPECTED_BLOCKS);
    Object.assign(expected[0], { modelId: "new-model", plate: "わ7777" });
    assert.deepEqual(sortedBlocks(accepted.blocks), expected);
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

  const { statuses } = validateCatalog(workbook);

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

        const { catalog, statuses, fatal } = validateCatalog(workbook);

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

    const { catalog, statuses, fatal } = validateCatalog(workbook);

    assert.deepEqual(fatal, []);
    assert.deepEqual(statuses, validateCatalog(validWorkbook()).statuses);
    assert.deepEqual(canonical(catalog), canonical(expectedCatalog()));
  });

  await t.test("an unticked box counts as blank on any tab", () => {
    const workbook = validWorkbook();
    appendRow(workbook, "Vehicles", { notes: false });
    appendRow(workbook, "Blocks", { note: false });

    assert.deepEqual(validateCatalog(workbook).statuses, validateCatalog(validWorkbook()).statuses);
    assert.deepEqual(
      validateBlocks(workbook, expectedCatalog()).statuses,
      validateBlocks(validWorkbook(), expectedCatalog()).statuses,
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

      const { catalog, statuses, fatal } = validateCatalog(workbook);

      assert.deepEqual(fatal, []);
      assertError(statuses, "Models", 3, ["model_id"]);
      assert.deepEqual(errors(statuses), ["Models 3"]);
      assert.deepEqual(canonical(catalog), canonical(expectedCatalog()));
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
