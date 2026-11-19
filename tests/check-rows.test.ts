// parseProposedRows and checkProposedRows: the rows the sheet's "Add a bike" panel proposes, checked as validateCatalog
// judges the valid fixture sheet with them added below each tab's last row. Expected levels come from the rules in
// docs/sheet-schema.md, written out here by hand. Messages are matched on fragments that name the column, never whole:
// the wording is validateCatalog's, and a row may carry several messages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProposedRows, parseProposedRows } from "../src/lib/catalog/check-rows.ts";
import {
  appendRow,
  CATALOG_TABS,
  rearrangeColumns,
  removeColumn,
  removeRow,
  setCell,
  validWorkbook,
  type Workbook,
} from "./helpers/sheet-workbook.ts";

/** Inside two years of the fixture's ClosedDates, so the sheet as it stands has no error rows. */
const NOW = Date.parse("2026-11-02T12:00:00+09:00");

type Level = "ok" | "warning" | "error";
type RowCheck = { level: Level; messages: string[] };
type Proposed = Record<string, Record<string, string | number | boolean>[]>;
type Answer = { fatal: string[]; rows: Record<string, RowCheck[] | undefined> };

/** A new scooter model with only its English name: every other name, summary and description is a missing translation. */
const ADV_160 = {
  model_id: "adv-160",
  type_id: "scooter",
  rate_class_id: "bike-400",
  brand: "Honda",
  engine_cc: 160,
  sort: 9,
  active: true,
  name_en: "ADV160",
};

/** The same model with every text in every language. */
const ADV_160_TRANSLATED = {
  ...ADV_160,
  name_ja: "エーディーブイ",
  name_zh: "ADV踏板",
  name_ko: "에이디브이",
  summary_ja: "ADVの概要",
  summary_en: "ADV summary",
  summary_zh: "ADV简介",
  summary_ko: "ADV 요약",
  description_ja: "ADVの説明",
  description_en: "ADV description",
  description_zh: "ADV说明",
  description_ko: "ADV 설명",
};

const LOCALE_COLUMNS = ["ja", "en", "zh", "ko"].flatMap((suffix) =>
  ["name", "summary", "description"].map((field) => `${field}_${suffix}`),
);

/**
 * Runs the check and asserts what holds of every answer: one RowCheck per proposed row of each tab, nothing for a tab
 * with none proposed, and messages only where the level is not ok.
 */
function check(workbook: Workbook, rows: Proposed, label = ""): Answer {
  const answer = checkProposedRows(workbook, rows, NOW) as Answer;
  const shown = `${label} ${JSON.stringify(answer)}`;
  assert.ok(Array.isArray(answer.fatal), shown);
  if (answer.fatal.length > 0) return answer;
  for (const tab of CATALOG_TABS) {
    const checks = answer.rows[tab] ?? [];
    assert.equal(checks.length, rows[tab]?.length ?? 0, `${tab}: one result per proposed row: ${shown}`);
    for (const { level, messages } of checks) {
      assert.ok(["ok", "warning", "error"].includes(level), shown);
      assert.ok(Array.isArray(messages) && messages.every((message) => typeof message === "string"), shown);
      assert.equal(level === "ok", messages.length === 0, `${tab}: only a row that is not ok has messages: ${shown}`);
      assert.ok(!messages.includes("ok"), `${tab}: "ok" is no message: ${shown}`);
    }
  }
  return answer;
}

function levels(answer: Answer, tab: string): Level[] {
  return (answer.rows[tab] ?? []).map(({ level }) => level);
}

/** True when one message of `row` holds every fragment. */
function says(row: RowCheck | undefined, ...fragments: string[]): boolean {
  return (row?.messages ?? []).some((message) => fragments.every((fragment) => message.includes(fragment)));
}

function vehicle(plate: string, model_id: string, extra: Record<string, string | number | boolean> = {}) {
  return { plate, model_id, status: "active", ...extra };
}

test("a proposed vehicle of a published model checks ok", () => {
  // The example of the ticket, word for word.
  const answer = check(validWorkbook(), { Vehicles: [vehicle("わ9999", "pcx-125")] });
  assert.deepEqual(answer.fatal, []);
  assert.deepEqual(answer.rows.Vehicles, [{ level: "ok", messages: [] }]);

  // Every model of the sheet, every status and the optional cells filled in, typed as numbers or as text.
  const varied = [
    vehicle("わ9001", "today-50", { status: "maintenance" }),
    vehicle("わ9002", "cub-110", { status: "retired", odometer_km: 15000 }),
    vehicle("わ9003", "rebel-250", { odometer_km: "1200", base_usage_days: 7 }),
    vehicle("わ9004", "nbox-660", { notes: "Child seat in the boot" }),
    vehicle("わ9005", "pcx-125", { base_usage_days: "0", notes: "" }),
  ];
  const all = check(validWorkbook(), { Vehicles: varied }, "varied");
  assert.deepEqual(all.fatal, []);
  assert.deepEqual(all.rows.Vehicles, varied.map(() => ({ level: "ok", messages: [] })));

  // The judgment is the live sheet's: once its pcx-125 row is broken, the same vehicle is not ok.
  const broken = validWorkbook();
  setCell(broken, "Models", "pcx-125", "engine_cc", "abc");
  const against = check(broken, { Vehicles: [vehicle("わ9999", "pcx-125")] }, "broken pcx-125");
  assert.deepEqual(levels(against, "Vehicles"), ["error"]);
  assert.ok(says(against.rows.Vehicles?.[0], "model_id", "has no valid row in Models"), JSON.stringify(against));

  // Each value goes under the header that reads as its key, wherever that column is and however it is spelled.
  const rearranged = validWorkbook();
  rearrangeColumns(rearranged, "Vehicles", (indexes) => [...indexes].reverse(), (header) => ` ${header.toUpperCase()} `);
  const moved = check(
    rearranged,
    {
      Vehicles: [
        vehicle("わ9006", "rebel-250", { status: "retired", odometer_km: 100 }),
        vehicle("わ9007", "pcx-125", { status: "parked" }),
      ],
    },
    "rearranged",
  );
  assert.deepEqual(levels(moved, "Vehicles"), ["ok", "error"]);
  assert.ok(says(moved.rows.Vehicles?.[1], "status", "parked"), JSON.stringify(moved));
});

test("a new model and its vehicle check together, with the model's missing translations as warnings", () => {
  // The example of the ticket. Vehicles comes first in the payload: the order of the tabs there does not matter.
  const answer = check(validWorkbook(), { Vehicles: [vehicle("わ9998", "adv-160")], Models: [ADV_160] });
  assert.deepEqual(answer.fatal, []);
  assert.deepEqual(answer.rows.Vehicles, [{ level: "ok", messages: [] }]);
  const [model] = answer.rows.Models ?? [];
  assert.equal(model?.level, "warning");
  // A warning for each text that is missing, and none for the one that is there.
  for (const column of LOCALE_COLUMNS.filter((column) => column !== "name_en")) {
    assert.ok(says(model, column, "missing translation"), `${column}: ${JSON.stringify(model)}`);
  }
  assert.ok(!says(model, "name_en"), JSON.stringify(model));

  // With every translation the model is ok too.
  const translated = check(validWorkbook(), { Models: [ADV_160_TRANSLATED], Vehicles: [vehicle("わ9998", "adv-160")] });
  assert.deepEqual(translated.rows.Models, [{ level: "ok", messages: [] }]);
  assert.deepEqual(translated.rows.Vehicles, [{ level: "ok", messages: [] }]);

  // Without its model the same vehicle has nothing to point at.
  const alone = check(validWorkbook(), { Vehicles: [vehicle("わ9998", "adv-160")] }, "alone");
  assert.deepEqual(levels(alone, "Vehicles"), ["error"]);
  assert.ok(says(alone.rows.Vehicles?.[0], "model_id", "has no valid row in Models"), JSON.stringify(alone));

  // Two new models, each with vehicles, answered in the order they were proposed.
  const two = check(validWorkbook(), {
    Models: [ADV_160_TRANSLATED, { ...ADV_160_TRANSLATED, model_id: "forza-250", engine_cc: 250, sort: 10 }],
    Vehicles: [vehicle("わ9101", "forza-250"), vehicle("わ9102", "adv-160"), vehicle("わ9103", "forza-125")],
  });
  assert.deepEqual(levels(two, "Models"), ["ok", "ok"]);
  assert.deepEqual(levels(two, "Vehicles"), ["ok", "ok", "error"]);
});

test("a repeated plate, an unknown model and an advance price above the price are errors that name the column", () => {
  const answer = check(validWorkbook(), {
    Vehicles: [
      vehicle("わ1002", "pcx-125"),
      vehicle("わ9995", "no-such-model"),
      vehicle("わ9994", "pcx-125"),
      vehicle("わ9994", "rebel-250"),
    ],
    Prices: [{ rate_class_id: "car-k", package_id: "hours-6", price_jpy: 4000, advance_price_jpy: 4500 }],
  });
  assert.deepEqual(answer.fatal, []);
  const shown = JSON.stringify(answer);
  // In order: a plate the sheet has, a model it does not, a new plate, and that new plate again.
  assert.deepEqual(levels(answer, "Vehicles"), ["error", "error", "ok", "error"], shown);
  const [repeated, unknown, , again] = answer.rows.Vehicles ?? [];
  assert.ok(says(repeated, "plate", "repeats an earlier row"), shown);
  assert.ok(says(unknown, "model_id", "has no valid row in Models"), shown);
  assert.ok(says(again, "plate", "repeats an earlier row"), shown);
  assert.deepEqual(levels(answer, "Prices"), ["error"], shown);
  assert.ok(says(answer.rows.Prices?.[0], "advance_price_jpy"), shown);

  // An advance price at or below the price is fine.
  for (const advance of [4000, 3500]) {
    const fine = check(validWorkbook(), {
      Prices: [{ rate_class_id: "car-k", package_id: "hours-6", price_jpy: 4000, advance_price_jpy: advance }],
    });
    assert.deepEqual(fine.rows.Prices, [{ level: "ok", messages: [] }], `advance ${advance}`);
  }

  // More of the sheet's rules, each on its own: the row is an error, and a message names the column.
  const CASES: [string, Record<string, string | number | boolean>, string][] = [
    ["Vehicles", vehicle("わ9980", "pcx-125", { status: "parked" }), "status"],
    ["Vehicles", vehicle("わ9981", "pcx-125", { odometer_km: "far" }), "odometer_km"],
    ["Vehicles", vehicle("", "pcx-125", { notes: "no plate" }), "plate"],
    ["Models", { ...ADV_160_TRANSLATED, model_id: "ADV 160" }, "model_id"],
    ["Models", { ...ADV_160_TRANSLATED, rate_class_id: "bike-999" }, "rate_class_id"],
    ["Models", { ...ADV_160_TRANSLATED, active: "maybe" }, "active"],
    ["Prices", { rate_class_id: "car-k", package_id: "hours-6", price_jpy: 0 }, "price_jpy"],
    ["Prices", { rate_class_id: "bike-125", package_id: "day-1", price_jpy: 5000 }, "repeats an earlier row"],
    ["Packages", { package_id: "day-7", days: 7, hours: 5, sort: 9, name_en: "7 days" }, "days and hours"],
  ];
  for (const [tab, row, column] of CASES) {
    const label = `${tab} ${JSON.stringify(row)}`;
    const one = check(validWorkbook(), { [tab]: [row] }, label);
    assert.deepEqual(levels(one, tab), ["error"], label);
    assert.ok(says(one.rows[tab]?.[0], column), `${label}: no message names ${column}: ${JSON.stringify(one)}`);
  }
});

test("a vehicle of a proposed model with an error is an error too", () => {
  // The example of the ticket: the model's engine_cc is no number.
  const answer = check(validWorkbook(), {
    Models: [{ ...ADV_160, engine_cc: "abc" }],
    Vehicles: [vehicle("わ9998", "adv-160")],
  });
  assert.deepEqual(answer.fatal, []);
  const shown = JSON.stringify(answer);
  const [model] = answer.rows.Models ?? [];
  const [bike] = answer.rows.Vehicles ?? [];
  // The worst status decides the level, and the warnings stay among the messages.
  assert.equal(model?.level, "error", shown);
  assert.ok(says(model, "engine_cc"), shown);
  assert.ok(says(model, "name_ja", "missing translation"), shown);
  assert.equal(bike?.level, "error", shown);
  assert.ok(says(bike, "model_id", "has no valid row in Models"), shown);

  // Other errors in the model take its vehicle with it, and a vehicle of a sound model next to it is unaffected.
  const CASES: [Record<string, string | number | boolean>, string][] = [
    [{ ...ADV_160_TRANSLATED, type_id: "boat" }, "type_id"],
    [{ ...ADV_160_TRANSLATED, brand: "" }, "brand"],
    [{ ...ADV_160_TRANSLATED, sort: -1 }, "sort"],
  ];
  for (const [row, column] of CASES) {
    const label = JSON.stringify(row);
    const one = check(validWorkbook(), {
      Models: [row],
      Vehicles: [vehicle("わ9998", "adv-160"), vehicle("わ9997", "pcx-125")],
    }, label);
    assert.deepEqual(levels(one, "Models"), ["error"], label);
    assert.ok(says(one.rows.Models?.[0], column), `${label}: ${JSON.stringify(one)}`);
    assert.deepEqual(levels(one, "Vehicles"), ["error", "ok"], label);
    assert.ok(says(one.rows.Vehicles?.[0], "has no valid row in Models"), label);
  }
});

test("a key with no column in the tab is an error for that row", () => {
  const answer = check(validWorkbook(), {
    Vehicles: [vehicle("わ9989", "pcx-125", { colour: "red" }), vehicle("わ9988", "pcx-125")],
  });
  assert.deepEqual(answer.fatal, []);
  const shown = JSON.stringify(answer);
  assert.deepEqual(levels(answer, "Vehicles"), ["error", "ok"], shown);
  assert.ok(says(answer.rows.Vehicles?.[0], "colour"), shown);

  // A column of another tab is still no column of this one. Each row is otherwise sound.
  const CASES: [string, Record<string, string | number | boolean>, string][] = [
    ["Models", { ...ADV_160_TRANSLATED, plate: "わ9987" }, "plate"],
    ["Vehicles", vehicle("わ9986", "pcx-125", { brand: "Honda" }), "brand"],
    ["Prices", { rate_class_id: "car-k", package_id: "hours-6", price_jpy: 4000, yen_price: 4000 }, "yen_price"],
  ];
  for (const [tab, row, key] of CASES) {
    const label = `${tab} ${JSON.stringify(row)}`;
    const one = check(validWorkbook(), { [tab]: [row] }, label);
    assert.deepEqual(levels(one, tab), ["error"], label);
    assert.ok(says(one.rows[tab]?.[0], key), `${label}: no message names ${key}: ${JSON.stringify(one)}`);
  }
});

test("a sheet with a fatal problem answers its reasons and checks no row", () => {
  const rows: Proposed = { Models: [ADV_160], Vehicles: [vehicle("わ9998", "adv-160"), vehicle("わ1002", "pcx-125")] };

  const missingHeader = validWorkbook();
  removeColumn(missingHeader, "Types", "sort");
  const missingConfig = validWorkbook();
  removeRow(missingConfig, "Config", "shop_open");
  const missingTab = validWorkbook();
  delete missingTab.Options;

  const CASES: [string, Workbook, RegExp][] = [
    ["a header missing", missingHeader, /Types.*sort/],
    // The other tabs are sound here, so validateCatalog still reports their rows; the answer still checks none.
    ["a Config setting missing", missingConfig, /Config.*shop_open/],
    ["a tab missing", missingTab, /Options/],
  ];
  for (const [name, workbook, reason] of CASES) {
    const answer = checkProposedRows(workbook, rows, NOW) as Answer;
    assert.ok(answer.fatal.length > 0, `${name}: ${JSON.stringify(answer)}`);
    assert.ok(answer.fatal.some((message) => reason.test(message)), `${name}: ${JSON.stringify(answer.fatal)}`);
    assert.deepEqual(answer.rows, {}, name);
  }

  // The same rows on the sound sheet are checked.
  const sound = check(validWorkbook(), rows);
  assert.deepEqual(sound.fatal, []);
  assert.deepEqual(levels(sound, "Vehicles"), ["ok", "error"]);
});

test("the rows already in the sheet are not reported", () => {
  // The sheet's own rows have problems of their own: the last vehicle and a model are errors, a type has a warning, and a
  // blank row sits among the vehicles.
  const workbook = validWorkbook();
  setCell(workbook, "Vehicles", "わ1006", "status", "parked");
  setCell(workbook, "Models", "cub-110", "brand", "");
  setCell(workbook, "Types", "car", "name_ko", "");
  workbook.Vehicles.splice(3, 0, []);
  appendRow(workbook, "Prices", { rate_class_id: "car-k", package_id: "hours-6", price_jpy: 0 });
  const before = structuredClone(workbook);

  const answer = check(workbook, { Vehicles: [vehicle("わ9999", "pcx-125"), vehicle("わ9996", "nbox-660")] });

  assert.deepEqual(answer.fatal, []);
  // Only the proposed rows, both sound, and no tab that had none proposed.
  assert.deepEqual(answer.rows.Vehicles, [{ level: "ok", messages: [] }, { level: "ok", messages: [] }]);
  for (const tab of CATALOG_TABS.filter((tab) => tab !== "Vehicles")) {
    assert.deepEqual(answer.rows[tab] ?? [], [], tab);
  }
  // And the sheet handed in is left as it was.
  assert.deepEqual(workbook, before);

  // A proposed row that repeats a broken row's plate is still judged against it: the sheet's first row owns a plate.
  const repeat = check(workbook, { Vehicles: [vehicle("わ1006", "nbox-660")] });
  assert.deepEqual(levels(repeat, "Vehicles"), ["error"]);
  assert.ok(says(repeat.rows.Vehicles?.[0], "plate", "repeats an earlier row"), JSON.stringify(repeat));
});

test("parseProposedRows refuses unknown tabs, non-array tabs, non-object rows, non-scalar values and more than 50 rows", () => {
  const rowsOf = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => vehicle(`${prefix}${index}`, "pcx-125"));

  // What the panel sends comes back as it is.
  const ACCEPTED: [string, unknown][] = [
    ["one vehicle", { Vehicles: [vehicle("わ9999", "pcx-125")] }],
    ["a model and its vehicle", { Models: [ADV_160], Vehicles: [vehicle("わ9998", "adv-160", { odometer_km: 0 })] }],
    ["strings, numbers and booleans", { Models: [{ ...ADV_160, active: false, sort: 0, name_en: "" }] }],
    ["a row with no cells", { Prices: [{}] }],
    ["every catalog tab", Object.fromEntries(CATALOG_TABS.map((tab) => [tab, [{ key: tab }]]))],
    ["50 rows in one tab", { Vehicles: rowsOf(50, "A") }],
    ["50 rows across tabs", { Vehicles: rowsOf(30, "B"), Models: rowsOf(20, "C") }],
  ];
  for (const [name, payload] of ACCEPTED) {
    assert.deepEqual(parseProposedRows(structuredClone(payload)), payload, name);
  }
  for (const empty of [{}, { Vehicles: [] }]) {
    assert.notEqual(parseProposedRows(empty), null, JSON.stringify(empty));
  }

  const REFUSED: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "Vehicles"],
    ["a boolean", true],
    ["an array", [vehicle("わ9999", "pcx-125")]],
    ["the Blocks tab, which is not a catalog tab", { Blocks: [{ block_id: "BLK-9" }] }],
    ["the Bookings tab", { Bookings: [{ booking_ref: "X" }] }],
    ["a tab in lower case", { vehicles: [vehicle("わ9999", "pcx-125")] }],
    ["a tab named after an object property", JSON.parse('{"__proto__": [{"plate": "x"}]}')],
    ["toString as a tab", { toString: [{ plate: "x" }] }],
    ["a known tab next to an unknown one", { Vehicles: [vehicle("わ9999", "pcx-125")], Cars: [] }],
    ["a tab of one object", { Vehicles: vehicle("わ9999", "pcx-125") }],
    ["a tab of a string", { Vehicles: "わ9999" }],
    ["a tab of null", { Vehicles: null }],
    ["a row of null", { Vehicles: [null] }],
    ["a row of a string", { Vehicles: ["わ9999"] }],
    ["a row of a number", { Vehicles: [7] }],
    ["a row that is an array", { Vehicles: [["わ9999", "pcx-125", "active"]] }],
    ["a bad row after a good one", { Vehicles: [vehicle("わ9999", "pcx-125"), null] }],
    ["a null value", { Vehicles: [{ plate: "わ9999", model_id: null }] }],
    ["an object value", { Vehicles: [{ plate: { text: "わ9999" } }] }],
    ["an array value", { Vehicles: [{ plate: ["わ9999"] }] }],
    ["51 rows in one tab", { Vehicles: rowsOf(51, "D") }],
    ["51 rows across tabs", { Vehicles: rowsOf(26, "E"), Models: rowsOf(25, "F") }],
  ];
  for (const [name, payload] of REFUSED) {
    assert.equal(parseProposedRows(payload), null, name);
  }
});
