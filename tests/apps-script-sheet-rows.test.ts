// The sheet-bound Apps Script's row helpers (apps-script/SheetRows.js) run in node:vm against fake Google services.
// Expected rows and keys are written out by hand, never taken from the script or the Worker's headerKey.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AppsScriptWorld, loadAppsScript, sheetsApiValues } from "./helpers/apps-script.ts";

// Values cross out of the script's realm with another Object prototype, which deepEqual refuses. A copy is plain.
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** A tab as the sheet shows it: every row padded with '' to the width, which hides the fake's sparse arrays. */
function grid(world: AppsScriptWorld, tab: string, width: number): unknown[][] {
  const rows = world.tabs.get(tab)?.rows ?? [];
  return Array.from(rows, (cells) => Array.from({ length: width }, (_, i) => cells?.[i] ?? ""));
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { message: string }).message;
  }
  assert.fail("expected a throw, and nothing was thrown");
}

// ' Plate' has a leading space, so only a trim and lower case match it to plate. 'my notes' is a column staff added.
const VEHICLE_HEADERS = [
  " Plate",
  "model_id",
  "status",
  "notes",
  "odometer_km",
  "base_usage_days",
  "publish_status",
  "my notes",
];
const VEHICLES: unknown[][] = [
  VEHICLE_HEADERS,
  ["わ1111", "pcx-125", "active", "", 1200, 3, "published", "keep"],
  ["わ2222", "forza-250", "retired", "scratched", 800, 9, "", ""],
];

test("appendRecord_ writes each value under its header in any column order and answers the row", () => {
  // Headers in an order unlike Vehicles, one of them in capitals and one in full-width letters.
  const blocksHeaders = ["End_At", "ｐｌａｔｅ", "start_at", "staff note", "reason", "active"];
  const world = loadAppsScript({
    tabs: {
      Vehicles: VEHICLES,
      Blocks: [blocksHeaders, ["2026-01-01", "わ1111", 5, "x", "service", true]],
    },
  });

  // The spec's example: row 4 is the next free row, and the columns nobody named stay empty.
  assert.equal(world.call("appendRecord_", "Vehicles", { plate: "わ9999", model_id: "pcx-125", status: "active" }), 4);
  const afterOne = grid(world, "Vehicles", 8);
  assert.deepEqual(afterOne[3], ["わ9999", "pcx-125", "active", "", "", "", "", ""]);
  assert.equal(afterOne.length, 4);
  // Rows above it and the header row are as they were.
  assert.deepEqual(afterOne.slice(0, 3), grid(loadAppsScript({ tabs: { Vehicles: VEHICLES } }), "Vehicles", 8));

  // A second append lands under the first, and the keys come in another order than the columns.
  assert.equal(
    world.call("appendRecord_", "Vehicles", { odometer_km: 15, status: "retired", plate: "わ8888", "base_usage_days": 2 }),
    5,
  );
  assert.deepEqual(grid(world, "Vehicles", 8)[4], ["わ8888", "", "retired", "", 15, 2, "", ""]);

  // Another tab with another order: each value follows its header, and the staff column is left empty.
  assert.equal(
    world.call("appendRecord_", "Blocks", { reason: "crash", plate: "わ2222", start_at: 1700000000000, end_at: 1700003600000 }),
    3,
  );
  assert.deepEqual(grid(world, "Blocks", 6)[2], [1700003600000, "わ2222", 1700000000000, "", "crash", ""]);
  assert.deepEqual(grid(world, "Blocks", 6)[1], ["2026-01-01", "わ1111", 5, "x", "service", true]);
});

test("readRecords_ reads rows by normalized header and keeps sheet row numbers past blank rows", () => {
  const world = loadAppsScript({
    tabs: {
      Vehicles: [
        // Full-width letters, a full-width space around, capitals and a trailing space all normalize.
        ["　Ｐｌａｔｅ　", "MODEL_ID", "ＳＴＡＴＵＳ", "Notes ", "odometer_km", "my notes"],
        ["わ1111", "pcx-125", "active", "", 1200, "keep"], // row 2
        ["", "", "", "", "", false], // row 3: every cell empty or false
        [], // row 4: nothing at all
        ["", "", "", "", 0, ""], // row 5: a 0 is a value, so the row stays
        ["わ2222", "forza-250"], // row 6: shorter than the header
        ["", "", "", "", "", ""], // row 7
        ["わ3333", "adv-160", "active", "x", 5, true], // row 8
      ],
    },
  });

  const found = plain(world.call("readRecords_", "Vehicles"));
  assert.deepEqual(found, {
    headers: ["plate", "model_id", "status", "notes", "odometer_km", "my notes"],
    records: [
      { row: 2, cells: { plate: "わ1111", model_id: "pcx-125", status: "active", notes: "", odometer_km: 1200, "my notes": "keep" } },
      { row: 5, cells: { plate: "", model_id: "", status: "", notes: "", odometer_km: 0, "my notes": "" } },
      { row: 6, cells: { plate: "わ2222", model_id: "forza-250", status: "", notes: "", odometer_km: "", "my notes": "" } },
      { row: 8, cells: { plate: "わ3333", model_id: "adv-160", status: "active", notes: "x", odometer_km: 5, "my notes": true } },
    ],
  });

  // A tab holding only its header has no records, and a tab that does not exist is null, not an empty answer.
  const bare = loadAppsScript({ tabs: { Blocks: [["plate", "start_at"]] } });
  assert.deepEqual(plain(bare.call("readRecords_", "Blocks")), { headers: ["plate", "start_at"], records: [] });
  assert.equal(bare.call("readRecords_", "Vehicles"), null);
  assert.equal(bare.tabs.has("Vehicles"), false);
});

test("appendRecord_ refuses a key with no column and a missing tab without writing", () => {
  const world = loadAppsScript({ tabs: { Vehicles: VEHICLES } });
  const before = grid(world, "Vehicles", 8);

  // The message names the tab and the key, in the words staff are shown.
  assert.equal(
    thrownMessage(() => world.call("appendRecord_", "Vehicles", { plate: "わ9999", colour: "red" })),
    "Vehicles: the header colour is missing",
  );
  // A different key and tab change the message, and the valid keys before the bad one are not written.
  assert.equal(
    thrownMessage(() => world.call("appendRecord_", "Vehicles", { status: "active", plate: "わ7", engine_cc: 125 })),
    "Vehicles: the header engine_cc is missing",
  );
  assert.deepEqual(grid(world, "Vehicles", 8), before);
  assert.deepEqual(world.tabs.get("Vehicles")?.touches, []);

  assert.equal(
    thrownMessage(() => world.call("appendRecord_", "Blocks", { plate: "わ9999" })),
    "Blocks: the tab is missing, use Set up tabs",
  );
  assert.equal(
    thrownMessage(() => world.call("appendRecord_", "Models", {})),
    "Models: the tab is missing, use Set up tabs",
  );
  assert.equal(world.tabs.has("Blocks"), false);
  assert.deepEqual(world.inserted, []);

  // The cell helpers refuse the same two cases and write nothing either.
  assert.equal(
    thrownMessage(() => world.call("setCellValue_", "Vehicles", 2, "colour", "red")),
    "Vehicles: the header colour is missing",
  );
  assert.equal(
    thrownMessage(() => world.call("setCellValue_", "Blocks", 2, "plate", "わ1")),
    "Blocks: the tab is missing, use Set up tabs",
  );
  assert.equal(
    thrownMessage(() => world.call("cellValue_", "Vehicles", 2, "colour")),
    "Vehicles: the header colour is missing",
  );
  assert.deepEqual(grid(world, "Vehicles", 8), before);
  assert.deepEqual(world.tabs.get("Vehicles")?.touches, []);
});

// Text staff type that Sheets would read as something else if it were typed into a cell: a number (leading zeros, a
// sign, a decimal, a thousands comma, a percent, an exponent), a date, a date-time, a time, a boolean or a formula.
const PARSED_BY_SHEETS = [
  "2002",
  "0123",
  "007",
  "-5",
  "+81 98 000 0000",
  "3.50",
  "1,000",
  "50%",
  "1e3",
  "2027-07-15",
  "2027/07/15",
  "2027-07-15 09:00",
  "7/15/2027",
  "09:30",
  "TRUE",
  "false",
  "=SUM(A1:A2)",
  "=1+1",
];
// Text Sheets keeps as it is in any case, which must stay so.
const KEPT_BY_SHEETS = ["@home", "a=b", "x+1", "わ1001", "沖縄 あ 35-80", "Scratch on the left mirror", ""];
// Values that are not text keep their type: money and counts, booleans, and a date-time meant as one.
const VALUES: unknown[] = [12, -5, 0, 3.5, 1_000_000, true, false, new Date(Date.UTC(2027, 6, 15, 0, 30))];
// 00:30 UTC is 09:30 in Japan: the serial of that wall clock, days since 1899-12-30, worked out by hand.
const VALUES_SERIAL_AT = 7;
const DATE_SERIAL = (Date.UTC(2027, 6, 15, 9, 30) - Date.UTC(1899, 11, 30)) / 86_400_000;

test("every string appendRecord_ and setCellValue_ write is stored as the exact text typed, and values as values", () => {
  // The fake reads each of these as Sheets does when it is written as it is, so keeping them as text means something.
  const raw = loadAppsScript({ timeZone: "Asia/Tokyo", tabs: { Raw: [] } });
  raw.evaluate(
    `SpreadsheetApp.getActive().getSheetByName("Raw").getRange(1, 1, 1, ${PARSED_BY_SHEETS.length})` +
      `.setValues([${JSON.stringify(PARSED_BY_SHEETS)}]); null`,
  );
  PARSED_BY_SHEETS.forEach((typed, i) => {
    assert.notStrictEqual(raw.tabs.get("Raw")?.rows[0][i], typed, `the fake parses ${JSON.stringify(typed)} written as is`);
  });

  const strings = [...PARSED_BY_SHEETS, ...KEPT_BY_SHEETS];
  const stringHeaders = strings.map((_, i) => `text_${i}`);
  const valueHeaders = VALUES.map((_, i) => `value_${i}`);
  const headers = [...stringHeaders, ...valueHeaders];
  const width = headers.length;
  const world = loadAppsScript({ timeZone: "Asia/Tokyo", tabs: { Probe: [headers, ["old"]] } });

  const record = Object.fromEntries([
    ...strings.map((typed, i) => [stringHeaders[i], typed]),
    ...VALUES.map((value, i) => [valueHeaders[i], value]),
  ]);
  assert.equal(world.call("appendRecord_", "Probe", record), 3);
  const appended = grid(world, "Probe", width)[2];
  strings.forEach((typed, i) => {
    assert.strictEqual(appended[i], typed, `appendRecord_ stores ${JSON.stringify(typed)} as typed`);
  });
  VALUES.forEach((value, i) => {
    assert.deepEqual(appended[strings.length + i], value, `appendRecord_ stores ${String(value)} as it was`);
  });

  // The Worker reads the same through the Sheets API: the text, the numbers and booleans, and the date as its serial.
  const api = sheetsApiValues(world, "Probe")[2];
  strings.forEach((typed, i) => {
    assert.strictEqual(api[i] ?? "", typed, `the Sheets API reads ${JSON.stringify(typed)} back`);
  });
  VALUES.forEach((value, i) => {
    const expected = i === VALUES_SERIAL_AT ? DATE_SERIAL : value;
    assert.strictEqual(api[strings.length + i], expected, `the Sheets API reads ${String(value)} back`);
  });

  // One cell at a time, over the row a test seeded: each string as typed, and a number as a number.
  strings.forEach((typed, i) => {
    world.call("setCellValue_", "Probe", 2, stringHeaders[i], typed);
    assert.strictEqual(world.call("cellValue_", "Probe", 2, stringHeaders[i]), typed, `setCellValue_ keeps ${JSON.stringify(typed)}`);
  });
  world.call("setCellValue_", "Probe", 2, valueHeaders[0], 42);
  world.call("setCellValue_", "Probe", 2, valueHeaders[5], false);
  const set = grid(world, "Probe", width)[1];
  assert.deepEqual(set.slice(0, strings.length), strings, "every string set on row 2 is as typed");
  assert.strictEqual(set[strings.length], 42);
  assert.strictEqual(set[strings.length + 5], false);
});

test("cellValue_ and setCellValue_ find the cell by header", () => {
  const world = loadAppsScript({
    tabs: {
      Vehicles: [
        ...VEHICLES,
        ["わ3333"], // a row shorter than the header
      ],
    },
  });

  // Reads differ by row and by header, with headers matched as the Worker matches them (' Plate' is plate).
  assert.equal(world.call("cellValue_", "Vehicles", 2, "plate"), "わ1111");
  assert.equal(world.call("cellValue_", "Vehicles", 3, "plate"), "わ2222");
  assert.equal(world.call("cellValue_", "Vehicles", 2, "odometer_km"), 1200);
  assert.equal(world.call("cellValue_", "Vehicles", 3, "odometer_km"), 800);
  assert.equal(world.call("cellValue_", "Vehicles", 3, "notes"), "scratched");
  assert.equal(world.call("cellValue_", "Vehicles", 2, "my notes"), "keep");
  // Past the end of a short row, and of the tab, Google answers an empty cell.
  assert.equal(world.call("cellValue_", "Vehicles", 4, "status"), "");
  assert.equal(world.call("cellValue_", "Vehicles", 4, "my notes"), "");

  const before = grid(world, "Vehicles", 8);
  world.call("setCellValue_", "Vehicles", 3, "status", "active");
  const expected = before.map((cells) => [...cells]);
  expected[2][2] = "active";
  assert.deepEqual(grid(world, "Vehicles", 8), expected);

  // A cell of the short row, in a column beyond what the row held, and a number.
  world.call("setCellValue_", "Vehicles", 4, "publish_status", "published");
  world.call("setCellValue_", "Vehicles", 2, "odometer_km", 1250);
  expected[3][6] = "published";
  expected[1][4] = 1250;
  assert.deepEqual(grid(world, "Vehicles", 8), expected);
  assert.equal(world.call("cellValue_", "Vehicles", 2, "odometer_km"), 1250);
  assert.equal(world.call("cellValue_", "Vehicles", 4, "publish_status"), "published");
});

test("a repeated header uses its first column, as the Worker does", () => {
  // Status appears twice, the second time in capitals; plate is repeated with a space and full-width letters.
  const headers = ["plate", "Status", "notes", "STATUS", "ｐｌａｔｅ ", "extra"];
  const world = loadAppsScript({ tabs: { Vehicles: [headers, ["わ1", "active", "n", "retired", "わ-dup", "e"]] } });

  assert.equal(world.call("appendRecord_", "Vehicles", { plate: "わ2", status: "hold", notes: "m" }), 3);
  assert.deepEqual(grid(world, "Vehicles", 6)[2], ["わ2", "hold", "m", "", "", ""]);

  const records = plain(world.call("readRecords_", "Vehicles")) as { records: { row: number; cells: unknown }[] };
  assert.deepEqual(records.records[0], {
    row: 2,
    cells: { plate: "わ1", status: "active", notes: "n", extra: "e" },
  });

  assert.equal(world.call("cellValue_", "Vehicles", 2, "status"), "active");
  assert.equal(world.call("cellValue_", "Vehicles", 2, "plate"), "わ1");
  world.call("setCellValue_", "Vehicles", 2, "status", "blocked");
  world.call("setCellValue_", "Vehicles", 2, "plate", "わ9");
  assert.deepEqual(grid(world, "Vehicles", 6)[1], ["わ9", "blocked", "n", "retired", "わ-dup", "e"]);
});
