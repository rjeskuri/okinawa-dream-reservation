// The Add a bike panel's server side (apps-script/AddBike.js), run in node:vm against the fake Google services. A
// vehicle of a model already in the sheet: the options, the signed check, and the save that writes the row and runs
// Publish. Signatures go through the Worker's real verifyEnvelope, the proposed rows through the endpoint's own
// parseProposedRows, and expected cells are written out here by hand. The fake Worker writes the publish_status cell into
// the sheet during /api/publish, as the real one does through the Sheets API. Message text is free: tests look for facts
// in it (a status, a number, the word publish), not for sentences.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import { parseProposedRows } from "../src/lib/catalog/check-rows.ts";
import { SHEET_TABS, validateCatalog } from "../src/lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../src/lib/crypto.ts";
import { type AppsScriptWorld, loadAppsScript, type Options, type Route, sheetsApiValues } from "./helpers/apps-script.ts";
import { type FakeDocument, type FakeElement, FakeEvent, FakeText, isShown, parsePage, settle, visibleText } from "./helpers/checkout-client.ts";
import { validWorkbook } from "./helpers/sheet-workbook.ts";

const SCRIPT_DIR = new URL("../apps-script/", import.meta.url);

const BASE_URL = "https://reservation-one.example.dev";
const SECRET = "publish-secret-one";
const USER = "staff@okinawa-dream.example";
const PROPERTIES = { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: SECRET };

const CHECK = "/api/staff/check-rows";
const PUBLISH = "/api/publish";
const BLOCKS = "/api/publish/blocks";
const PHOTOS = "/api/publish/photos";
const ASSIGNMENTS = "/api/publish/assignments";
const PUBLISH_PATHS = [PUBLISH, BLOCKS, PHOTOS, ASSIGNMENTS];

// As in apps-script-publish.test.ts.
const STACK_TRACE = /\n\s+at\s|\.js:\d+|(Type|Reference|Syntax|Range)Error|Cannot read|\bundefined\b|\[object Object\]/;
const FAILED =
  /fail|could not|couldn't|unable|invalid|unexpected|unreadable|incomplete|not (finish|complet)|stopped|unchanged|失敗|エラー/i;

// Values cross out of the script's realm with another Object prototype, which deepEqual refuses. A copy is plain.
const plain = (value: unknown): any => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

type Cells = Record<string, string | number | boolean>;

/** A tab from header cells and records keyed by the plain header name. A header cell matches its key after trim and lower case. */
function tab(headers: string[], records: (Cells | null)[]): unknown[][] {
  const key = (header: string) => header.trim().toLowerCase();
  return [
    headers,
    ...records.map((record) => headers.map((header) => (record === null ? "" : (record[key(header)] ?? "")))),
  ];
}

// Models in an order unlike SHEET_TABS, one header in capitals with spaces around, and a column staff added.
const MODEL_HEADERS = [
  "photos",
  "name_en",
  " Model_ID ",
  "staff memo",
  ...SHEET_TABS.Models.filter((header) => !["photos", "name_en", "model_id"].includes(header)),
];

type Model = { id: string; nameJa: string; nameEn: string; typeId: string; rateClassId: string; photos: string[] };

function modelCells(model: Model, photosCell: string, extra: Cells = {}): Cells {
  return {
    model_id: model.id,
    name_ja: model.nameJa,
    name_en: model.nameEn,
    type_id: model.typeId,
    rate_class_id: model.rateClassId,
    photos: photosCell,
    brand: "Honda",
    sort: 1,
    active: true,
    ...extra,
  };
}

const PCX: Model = {
  id: "pcx-125",
  nameJa: "PCX",
  nameEn: "PCX125",
  typeId: "scooter",
  rateClassId: "bike-125",
  photos: ["pcx-1.jpg", "pcx-2.jpg"],
};
const REBEL: Model = {
  id: "rebel-250",
  nameJa: "レブル250",
  nameEn: "Rebel 250",
  typeId: "bike",
  rateClassId: "bike-250",
  photos: ["rebel-1.jpg", "rebel-2.jpg", "rebel-3.jpg"],
};
const NBOX: Model = { id: "nbox-660", nameJa: "N-BOX", nameEn: "N-BOX", typeId: "car", rateClassId: "car-k", photos: [] };
const CUB: Model = {
  id: "cub-110",
  nameJa: "スーパーカブ",
  nameEn: "Super Cub 110",
  typeId: "bike",
  rateClassId: "bike-110",
  photos: ["cub.jpg"],
};
const TODAY: Model = {
  id: "today-50",
  nameJa: "トゥデイ",
  nameEn: "Today",
  typeId: "scooter",
  rateClassId: "bike-50",
  photos: ["today-a.jpg", "today-b.jpg"],
};

// Vehicles in another order, `plate` and `status` spelled loosely, and a column staff added.
const VEHICLE_HEADERS = ["notes", " Plate", "my notes", "publish_status", "base_usage_days", "model_id", "STATUS", "odometer_km"];

type Sheet = { tabs: Record<string, unknown[][]>; models: Model[]; plates: string[] };

/** Two sheets with nothing in common, so options that do not read the sheet cannot match both. */
const SHEET_A: Sheet = {
  tabs: {
    Models: tab(MODEL_HEADERS, [
      modelCells(PCX, "pcx-1.jpg, pcx-2.jpg"),
      null,
      modelCells(REBEL, "rebel-1.jpg、rebel-2.jpg，rebel-3.jpg", { "staff memo": "new tyres" }),
      modelCells(NBOX, ""),
    ]),
    Vehicles: tab(VEHICLE_HEADERS, [
      { plate: "わ1001", model_id: "pcx-125", status: "active", odometer_km: 1200, publish_status: "ok" },
      { plate: "わ1002", model_id: "rebel-250", status: "retired", notes: "sold", publish_status: "ok" },
      null,
      // A line staff keep for themselves, with no plate: no plate is used by it.
      { "my notes": "order a third PCX" },
      { plate: "沖縄 あ 35-80", model_id: "nbox-660", status: "maintenance", publish_status: "warning: odometer_km" },
    ]),
    PublishLog: [[...SHEET_TABS.PublishLog]],
  },
  models: [PCX, REBEL, NBOX],
  plates: ["わ1001", "わ1002", "沖縄 あ 35-80"],
};

const SHEET_B: Sheet = {
  tabs: {
    Models: tab(MODEL_HEADERS, [modelCells(CUB, "cub.jpg"), modelCells(TODAY, "today-a.jpg ,today-b.jpg")]),
    Vehicles: tab(VEHICLE_HEADERS, [
      { plate: "わ7001", model_id: "cub-110", status: "active", base_usage_days: 4 },
      { plate: "わ7002", model_id: "today-50", status: "active" },
    ]),
    PublishLog: [[...SHEET_TABS.PublishLog]],
  },
  models: [CUB, TODAY],
  plates: ["わ7001", "わ7002"],
};

const REPORT = { ok: true, version: 412, counts: { ok: 120, warning: 3, error: 0 }, fatal: [], affectedBookings: [] };

const STEP_ROUTES: Record<string, Route> = {
  [BLOCKS]: { body: { processed: 4, remaining: 0, errors: [] } },
  [PHOTOS]: { body: { copied: 2, skipped: [], errors: [], remaining: 0 } },
  [ASSIGNMENTS]: { body: { applied: 1, errors: [] } },
};

const OK_CHECK = { fatal: [], rows: { Vehicles: [{ level: "ok", messages: [] }] } };

function world(sheet: Sheet, overrides: Options = {}): AppsScriptWorld {
  return loadAppsScript({ properties: PROPERTIES, user: USER, tabs: sheet.tabs, ...overrides });
}

type Draft = { mode: string; modelId: string; vehicle: { plate: string; odometerKm?: number; baseUsageDays?: number; notes?: string } };

/** The row the ticket names for a draft, with '' for an optional cell the draft left out. */
function expectedVehicle(draft: Draft): Record<string, string> {
  const { plate, odometerKm, baseUsageDays, notes } = draft.vehicle;
  return {
    plate,
    model_id: draft.modelId,
    status: "active",
    odometer_km: odometerKm === undefined ? "" : String(odometerKm),
    base_usage_days: baseUsageDays === undefined ? "" : String(baseUsageDays),
    notes: notes ?? "",
  };
}

/** A row's cells as text, keyed by the plain header name, for comparing with a row written out by hand. */
function asText(row: Record<string, unknown>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, row[key] === undefined || row[key] === null ? "" : String(row[key])]));
}

function headerIndex(headers: unknown[], name: string): number {
  return headers.findIndex((header) => String(header).trim().toLowerCase() === name);
}

/** The sheet row (1-based) as `{ header: cell }`, read from the fake's cells with the header row it holds. */
function sheetRow(script: AppsScriptWorld, tabName: string, row: number): Record<string, unknown> {
  const rows = script.tabs.get(tabName)?.rows ?? [];
  const headers = rows[0] ?? [];
  const cells = rows[row - 1] ?? [];
  return Object.fromEntries(headers.map((header, i) => [String(header).trim().toLowerCase(), cells[i] ?? ""]));
}

/** What the Worker does during /api/publish: writes the status of the row with this plate. Answers whether it found it. */
function writeStatus(script: AppsScriptWorld, plate: string, status: string): boolean {
  const rows = script.tabs.get("Vehicles")?.rows ?? [];
  const plateAt = headerIndex(rows[0] ?? [], "plate");
  const statusAt = headerIndex(rows[0] ?? [], "publish_status");
  let found = false;
  rows.forEach((cells, i) => {
    if (i > 0 && String(cells?.[plateAt] ?? "").trim() === plate) {
      cells[statusAt] = status;
      found = true;
    }
  });
  return found;
}

function paths(script: AppsScriptWorld): string[] {
  return script.fetches.map((call) => call.path);
}

function logRows(script: AppsScriptWorld): unknown[][] {
  return (script.tabs.get("PublishLog")?.rows ?? []).slice(1);
}

function logCell(row: unknown[], column: (typeof SHEET_TABS.PublishLog)[number]): string {
  return String(row[SHEET_TABS.PublishLog.indexOf(column)] ?? "");
}

function hasNumber(text: string, value: number): boolean {
  return new RegExp(`(?<!\\d)${value}(?!\\d)`).test(text);
}

/** Photos as a list of names, whether the options hand over the cell or the names it holds. */
function photoNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "")
    .split(/[,，、]/)
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** Both the check and the save are refused before a call for these; every one names a model the sheet has, but for the model cases. */
function assertNothingHappened(script: AppsScriptWorld, sheet: Sheet, what: string): void {
  assert.deepEqual(script.tabs.get("Vehicles")?.rows, sheet.tabs.Vehicles, `${what}: Vehicles is as it was`);
  assert.deepEqual(script.tabs.get("Vehicles")?.touches, [], `${what}: nothing wrote to Vehicles`);
  assert.deepEqual(logRows(script), [], `${what}: no PublishLog row`);
  assert.deepEqual(
    paths(script).filter((path) => PUBLISH_PATHS.includes(path)),
    [],
    `${what}: no Publish request`,
  );
  assert.equal(script.lock.held(), false, `${what}: the lock is free`);
}

function assertReadable(text: unknown, what: string): void {
  assert.equal(typeof text, "string", `${what}: a message`);
  assert.notEqual(String(text).trim(), "", `${what}: a message`);
  assert.doesNotMatch(String(text), STACK_TRACE, what);
  assert.ok(!String(text).includes(SECRET), `${what}: the secret stays out of what staff see`);
}

test("Add a bike is a dashboard action that opens the AddBike dialog", () => {
  const script = world(SHEET_A);
  const actions = plain(script.evaluate("DASHBOARD_ACTIONS_")) as { label: string; fn: string }[];
  assert.deepEqual(
    actions.filter(({ fn }) => fn === "openAddBike"),
    [{ label: "Add a bike", fn: "openAddBike" }],
    `DASHBOARD_ACTIONS_ lists Add a bike once: ${JSON.stringify(actions)}`,
  );

  // On the menu and on the home.
  script.call("onOpen");
  assert.ok(
    script.menus.some((menu) => menu.items.some((item) => Array.isArray(item) && item[0] === "Add a bike" && item[1] === "openAddBike")),
    `the menu has Add a bike: ${JSON.stringify(script.menus)}`,
  );
  const home = plain(script.call("dashboardHome")) as { actions: { label: string; fn: string }[] };
  assert.ok(
    home.actions.some(({ label, fn }) => label === "Add a bike" && fn === "openAddBike"),
    `the home lists Add a bike: ${JSON.stringify(home)}`,
  );

  // One modal dialog: the shell, then AddBikePanel.html, titled Add a bike.
  const opened = world(SHEET_A);
  opened.call("openAddBike");
  assert.deepEqual(
    opened.shown.map(({ kind, title }) => ({ kind, title })),
    [{ kind: "modal", title: "Add a bike" }],
  );
  const shell = readFileSync(new URL("PanelShell.html", SCRIPT_DIR), "utf8");
  const panel = readFileSync(new URL("AddBikePanel.html", SCRIPT_DIR), "utf8");
  assert.notEqual(panel.trim(), "", "AddBikePanel.html has content");
  const html = opened.shown[0].html;
  const at = html.indexOf(shell);
  assert.ok(at >= 0, "the dialog holds PanelShell.html");
  assert.ok(html.indexOf(panel, at + shell.length) >= 0, "the dialog holds AddBikePanel.html after the shell");
  assert.deepEqual(opened.fetches, [], "opening the dialog calls nothing");
  assert.deepEqual(opened.tabs.get("Vehicles")?.touches, []);

  // The panel reaches the three server steps: options, check and save.
  for (const fn of ["addBikeOptions", "addBikeCheck", "addBikeSave"]) {
    assert.match(panel, new RegExp(`callServer\\s*\\(\\s*["'\`]${fn}["'\`]`), `AddBikePanel.html calls ${fn}`);
  }
});

test("addBikeOptions lists the models and plates from the sheet", () => {
  for (const [label, sheet] of [
    ["sheet A", SHEET_A],
    ["sheet B", SHEET_B],
  ] as [string, Sheet][]) {
    const script = world(sheet);
    const options = plain(script.call("addBikeOptions")) as { ok: unknown; models: Record<string, unknown>[]; plates: unknown[] };

    assert.equal(options.ok, true, `${label}: ${JSON.stringify(options)}`);
    assert.ok(Array.isArray(options.models), `${label}: models is a list`);
    const models = options.models
      .map((model) => ({
        id: String(model.id),
        nameJa: String(model.nameJa),
        nameEn: String(model.nameEn),
        typeId: String(model.typeId),
        rateClassId: String(model.rateClassId),
        photos: photoNames(model.photos),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const expected = [...sheet.models].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(models, expected, `${label}: every model of the sheet, each once`);

    assert.ok(Array.isArray(options.plates), `${label}: plates is a list`);
    assert.deepEqual(
      options.plates.map(String).sort(),
      [...sheet.plates].sort(),
      `${label}: every plate in Vehicles, whatever its status, and no blank one`,
    );
    assert.deepEqual(script.fetches, [], `${label}: the options come from the sheet, not the Worker`);
    assert.deepEqual(script.tabs.get("Vehicles")?.touches, [], label);
    assert.deepEqual(script.tabs.get("Models")?.touches, [], label);
  }
});

test("addBikeCheck sends the proposed Vehicles row signed, with requestedBy", async () => {
  const cases: { label: string; sheet: Sheet; user: string; draft: Draft; answer: unknown }[] = [
    {
      label: "plate only",
      sheet: SHEET_A,
      user: USER,
      draft: { mode: "existing", modelId: "pcx-125", vehicle: { plate: "わ9999" } },
      answer: OK_CHECK,
    },
    {
      label: "every cell, a warning back",
      sheet: SHEET_A,
      user: "manager@example.jp",
      draft: {
        mode: "existing",
        modelId: "rebel-250",
        vehicle: { plate: "沖縄 い 12-34", odometerKm: 8000, baseUsageDays: 30, notes: "Scratch on the left mirror" },
      },
      answer: { fatal: [], rows: { Vehicles: [{ level: "warning", messages: ["odometer_km: high for a new bike"] }] } },
    },
    {
      label: "zeros are values, an error back",
      sheet: SHEET_B,
      user: USER,
      draft: { mode: "existing", modelId: "today-50", vehicle: { plate: "わ7001", odometerKm: 0, baseUsageDays: 0 } },
      answer: { fatal: [], rows: { Vehicles: [{ level: "error", messages: ["plate: わ7001 is used twice"] }] } },
    },
    {
      label: "a fatal reason back",
      sheet: SHEET_B,
      user: "",
      draft: { mode: "existing", modelId: "cub-110", vehicle: { plate: "わ7003", notes: "白いカブ" } },
      answer: { fatal: ["Models: the header model_id is missing"], rows: {} },
    },
  ];
  for (const { label, sheet, user, draft, answer } of cases) {
    const script = world(sheet, { user, routes: { [CHECK]: { body: answer } } });
    const result = plain(script.call("addBikeCheck", draft));

    assert.deepEqual(result, { ok: true, fatal: (answer as any).fatal, rows: (answer as any).rows }, label);
    assert.deepEqual(paths(script), [CHECK], `${label}: one request, to the check`);
    const [call] = script.fetches;
    assert.equal(call.url, `${BASE_URL}${CHECK}`, label);

    const verified = await verifyEnvelope(SECRET, String(call.payload), Date.now());
    assert.equal(verified.ok, true, `${label}: signed with PUBLISH_SECRET: ${JSON.stringify(verified)}`);
    const payload = (verified as { payload: { requestedBy?: unknown; rows?: unknown } }).payload;
    assert.equal(payload.requestedBy, user, `${label}: requestedBy is the signed-in user`);
    assert.notEqual(parseProposedRows(payload.rows), null, `${label}: rows the endpoint reads: ${JSON.stringify(payload.rows)}`);
    const rows = payload.rows as Record<string, Record<string, unknown>[]>;
    assert.deepEqual(Object.keys(rows), ["Vehicles"], `${label}: only a Vehicles row for a model already there`);
    assert.equal(rows.Vehicles.length, 1, label);
    const keys = Object.keys(expectedVehicle(draft));
    assert.deepEqual(asText(rows.Vehicles[0], keys), expectedVehicle(draft), `${label}: the proposed row`);
    assert.deepEqual(script.tabs.get("Vehicles")?.touches, [], `${label}: the check writes nothing`);
    assert.deepEqual(logRows(script), [], label);
  }

  // A check that cannot run answers a message for staff, and never throws.
  for (const [label, reply] of [
    ["a 500", { status: 500, body: "Could not read the sheet from Google, so no rows were checked." }],
    ["a thrown fetch", { throws: "Address unavailable: reservation-one.example.dev" }],
  ] as const) {
    const script = world(SHEET_A, { routes: { [CHECK]: reply } });
    let result: any;
    assert.doesNotThrow(() => {
      result = plain(script.call("addBikeCheck", { mode: "existing", modelId: "pcx-125", vehicle: { plate: "わ9999" } }));
    }, label);
    assert.equal(result?.ok, false, `${label}: ${JSON.stringify(result)}`);
    assertReadable(result.message, label);
    if ("status" in reply) assert.ok(hasNumber(result.message, 500), `${label}: shows the status: ${result.message}`);
  }
});

test("addBikeSave writes the vehicle row under its headers, publishes and answers the row's publish_status", async () => {
  const cases: { label: string; sheet: Sheet; draft: Draft; check: unknown; version: number; status: string; row: number }[] = [
    {
      label: "every cell, sheet A",
      sheet: SHEET_A,
      draft: {
        mode: "existing",
        modelId: "rebel-250",
        vehicle: { plate: "わ9999", odometerKm: 8000, baseUsageDays: 30, notes: "Scratch on the left mirror" },
      },
      check: OK_CHECK,
      version: 412,
      status: "ok",
      // The header and five rows, the blank one included.
      row: 7,
    },
    {
      label: "plate only, a warning, sheet B",
      sheet: SHEET_B,
      draft: { mode: "existing", modelId: "today-50", vehicle: { plate: "わ7003" } },
      check: { fatal: [], rows: { Vehicles: [{ level: "warning", messages: ["photos: none for today-50"] }] } },
      version: 77,
      status: "warning: photos missing for today-50",
      row: 4,
    },
    {
      label: "zeros, sheet B",
      sheet: SHEET_B,
      draft: { mode: "existing", modelId: "cub-110", vehicle: { plate: "沖縄 う 56-78", odometerKm: 0, baseUsageDays: 0 } },
      check: OK_CHECK,
      version: 1309,
      status: "公開済み",
      row: 4,
    },
  ];
  for (const { label, sheet, draft, check, version, status, row } of cases) {
    let script: AppsScriptWorld | undefined;
    let publishSawRow = false;
    script = world(sheet, {
      routes: {
        [CHECK]: { body: check },
        [PUBLISH]: () => {
          publishSawRow = writeStatus(script as AppsScriptWorld, draft.vehicle.plate, status);
          return { body: { ...REPORT, version } };
        },
        ...STEP_ROUTES,
      },
    });
    const result = plain(script.call("addBikeSave", draft));

    assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);
    // The Worker reads through the Sheets API, which sees a write only once Apps Script has applied it.
    assert.ok(publishSawRow, `${label}: the row was in the sheet when Publish ran`);
    assert.deepEqual(result.written, [{ tab: "Vehicles", row, status }], `${label}: the row and its status after Publish`);

    // The row, under each header wherever its column is; the staff column stays empty.
    const written = sheetRow(script, "Vehicles", row);
    const expected = { ...expectedVehicle(draft), publish_status: status, "my notes": "" };
    assert.deepEqual(asText(written, Object.keys(expected)), expected, `${label}: the cells of row ${row}`);
    const rows = script.tabs.get("Vehicles")?.rows ?? [];
    assert.equal(rows.length, row, `${label}: one row added, at the end`);
    assert.deepEqual(rows.slice(0, row - 1), sheet.tabs.Vehicles, `${label}: the rows above are as they were`);

    // The check ran again, signed with the row; then the whole Publish.
    const checks = script.fetches.filter((call) => call.path === CHECK);
    assert.ok(checks.length >= 1, `${label}: the save checks the row: ${JSON.stringify(paths(script))}`);
    const verified = await verifyEnvelope(SECRET, String(checks[checks.length - 1].payload), Date.now());
    assert.equal(verified.ok, true, label);
    const payload = (verified as { payload: { requestedBy: unknown; rows: Record<string, Record<string, unknown>[]> } }).payload;
    assert.equal(payload.requestedBy, USER, label);
    assert.equal(payload.rows.Vehicles?.[0]?.plate, draft.vehicle.plate, label);
    for (const path of PUBLISH_PATHS) {
      assert.equal(paths(script).filter((called) => called === path).length, 1, `${label}: ${path} once`);
    }

    assert.equal(result.publish?.version, version, `${label}: the version Publish made`);
    assert.ok(Array.isArray(result.publish.messages), `${label}: the Publish messages are a list`);
    for (const message of result.publish.messages) assertReadable(message, label);
    assert.ok(
      result.publish.messages.some((message: string) => hasNumber(message, version)),
      `${label}: the messages name version ${version}: ${JSON.stringify(result.publish.messages)}`,
    );

    // One PublishLog row, as for any Publish, and the lock free again.
    const log = logRows(script);
    assert.equal(log.length, 1, `${label}: one PublishLog row`);
    assert.equal(logCell(log[0], "user"), USER, label);
    assert.equal(logCell(log[0], "version"), String(version), label);
    assert.equal(script.lock.held(), false, `${label}: the lock is released`);
    assert.ok(script.lock.timeouts.includes(10000), `${label}: waits 10 s for the lock: ${script.lock.timeouts}`);
  }
});

test("addBikeSave writes nothing and does not publish when the check has an error or a fatal reason", () => {
  const draft: Draft = { mode: "existing", modelId: "pcx-125", vehicle: { plate: "わ1001", odometerKm: 50 } };
  const cases: { label: string; check: { fatal: string[]; rows: Record<string, unknown> } }[] = [
    { label: "an error row", check: { fatal: [], rows: { Vehicles: [{ level: "error", messages: ["plate: わ1001 is used twice"] }] } } },
    {
      label: "an error among warnings",
      check: {
        fatal: [],
        rows: { Vehicles: [{ level: "error", messages: ["model_id: has no valid row in Models", "notes: too long"] }] },
      },
    },
    { label: "a fatal reason", check: { fatal: ["Vehicles: the header plate is missing"], rows: {} } },
    {
      label: "a fatal reason with an ok row",
      check: { fatal: ["Config: the tab is missing"], rows: { Vehicles: [{ level: "ok", messages: [] }] } },
    },
  ];
  for (const { label, check } of cases) {
    const script = world(SHEET_A, {
      routes: { [CHECK]: { body: check }, [PUBLISH]: { body: REPORT }, ...STEP_ROUTES },
    });
    const result = plain(script.call("addBikeSave", draft));

    assert.equal(result?.ok, false, `${label}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.check, { ok: true, fatal: check.fatal, rows: check.rows }, `${label}: the check, for staff`);
    assert.ok(paths(script).includes(CHECK), `${label}: the save checked`);
    assertNothingHappened(script, SHEET_A, label);
  }

  // A check that could not run is no pass either.
  const script = world(SHEET_A, {
    routes: { [CHECK]: { status: 502, body: "Could not read the sheet from Google" }, [PUBLISH]: { body: REPORT }, ...STEP_ROUTES },
  });
  const result = plain(script.call("addBikeSave", draft));
  assert.equal(result?.ok, false, `a failed check: ${JSON.stringify(result)}`);
  assert.equal(result.check?.ok, false, "a failed check: the check's own answer");
  assertReadable(result.check.message, "a failed check");
  assertNothingHappened(script, SHEET_A, "a failed check");
});

test("addBikeSave writes nothing while another Publish holds the lock", () => {
  for (const sheet of [SHEET_A, SHEET_B]) {
    const draft: Draft = { mode: "existing", modelId: sheet.models[0].id, vehicle: { plate: "わ9001", odometerKm: 10 } };
    const script = world(sheet, {
      lockHeldElsewhere: true,
      routes: { [CHECK]: { body: OK_CHECK }, [PUBLISH]: { body: REPORT }, ...STEP_ROUTES },
    });
    let result: any;
    assert.doesNotThrow(() => {
      result = plain(script.call("addBikeSave", draft));
    });

    assert.equal(result?.ok, false, JSON.stringify(result));
    assertReadable(result.message, "lock held");
    assert.match(result.message, /publish/i, `says a Publish is running: ${result.message}`);
    assert.ok(script.lock.timeouts.includes(10000), `waits 10 s for the lock: ${script.lock.timeouts}`);
    assert.deepEqual(script.tabs.get("Vehicles")?.rows, sheet.tabs.Vehicles, "Vehicles is as it was");
    assert.deepEqual(script.tabs.get("Vehicles")?.touches, [], "nothing wrote to Vehicles");
    assert.deepEqual(logRows(script), [], "no PublishLog row");
    assert.deepEqual(paths(script).filter((path) => PUBLISH_PATHS.includes(path)), [], "no Publish request");
  }
});

test("a Publish that fails after the write is reported with the written rows, not a stack trace", () => {
  const draft: Draft = { mode: "existing", modelId: "nbox-660", vehicle: { plate: "沖縄 え 90-12", baseUsageDays: 3 } };
  const row = 7;
  const cases: {
    label: string;
    publish: "writes" | "silent";
    routes: Record<string, Route>;
    status: string;
    shows: string[];
  }[] = [
    {
      label: "/api/publish answers 500",
      publish: "silent",
      routes: { [PUBLISH]: { status: 500, body: "Publish misconfigured" } },
      status: "",
      shows: ["500"],
    },
    {
      label: "/api/publish cannot be reached",
      publish: "silent",
      routes: { [PUBLISH]: { throws: "Address unavailable: reservation-one.example.dev" } },
      status: "",
      shows: [],
    },
    {
      label: "Publish stops on a fatal reason",
      publish: "silent",
      routes: {
        [PUBLISH]: { body: { ok: false, counts: { ok: 1, warning: 0, error: 0 }, fatal: ["Prices: the tab is missing"] } },
      },
      status: "",
      shows: ["Prices: the tab is missing"],
    },
    {
      label: "the blocks step answers 503 after the catalog published",
      publish: "writes",
      routes: { [BLOCKS]: { status: 503, body: "upstream busy" } },
      status: "ok",
      shows: ["503"],
    },
  ];
  for (const { label, publish, routes, status, shows } of cases) {
    let script: AppsScriptWorld | undefined;
    let publishSawRow = false;
    const publishRoute: Route =
      publish === "writes"
        ? () => {
            publishSawRow = writeStatus(script as AppsScriptWorld, draft.vehicle.plate, status);
            return { body: REPORT };
          }
        : (routes[PUBLISH] as Route);
    script = world(SHEET_A, {
      routes: { [CHECK]: { body: OK_CHECK }, ...STEP_ROUTES, ...routes, [PUBLISH]: publishRoute },
    });
    let result: any;
    assert.doesNotThrow(() => {
      result = plain(script?.call("addBikeSave", draft));
    }, label);

    // The row stays written, and the answer says so with its status as the sheet holds it.
    if (publish === "writes") assert.ok(publishSawRow, `${label}: the row was in the sheet when Publish ran`);
    assert.deepEqual(result?.written, [{ tab: "Vehicles", row, status }], `${label}: ${JSON.stringify(result)}`);
    const expected = { ...expectedVehicle(draft), publish_status: status };
    assert.deepEqual(asText(sheetRow(script, "Vehicles", row), Object.keys(expected)), expected, `${label}: the row`);

    // The Publish messages, readable, with what went wrong.
    const messages = result.publish?.messages;
    assert.ok(Array.isArray(messages) && messages.length > 0, `${label}: the Publish messages: ${JSON.stringify(result)}`);
    for (const message of messages) assertReadable(message, label);
    const text = messages.join("\n");
    assert.match(text, FAILED, `${label}: the messages say Publish failed: ${text}`);
    for (const fact of shows) assert.ok(text.includes(fact), `${label}: the messages show ${fact}: ${text}`);
    assert.doesNotMatch(JSON.stringify(result), /\\n\s+at\s|\.js:\d+|"stack"/, `${label}: no stack trace in the answer`);
    if (publish === "writes") assert.equal(result.publish.version, REPORT.version, `${label}: the version that published`);

    // Logged as any Publish is, and the lock free again.
    const log = logRows(script);
    assert.equal(log.length, 1, `${label}: one PublishLog row`);
    assert.equal(logCell(log[0], "user"), USER, label);
    for (const fact of shows) assert.ok(logCell(log[0], "message").includes(fact), `${label}: the log shows ${fact}`);
    assert.equal(script.lock.held(), false, `${label}: the lock is released`);
  }
});

test("a draft for an unknown model or without a plate is refused before any call", () => {
  const known = "pcx-125";
  const drafts: { label: string; draft: unknown }[] = [
    { label: "a model not in Models", draft: { mode: "existing", modelId: "adv-160", vehicle: { plate: "わ9999" } } },
    // On the other sheet, but not on this one.
    { label: "a model of another sheet", draft: { mode: "existing", modelId: "cub-110", vehicle: { plate: "わ9999" } } },
    { label: "a blank model", draft: { mode: "existing", modelId: "", vehicle: { plate: "わ9999" } } },
    { label: "no model", draft: { mode: "existing", vehicle: { plate: "わ9999" } } },
    { label: "an empty plate", draft: { mode: "existing", modelId: known, vehicle: { plate: "" } } },
    { label: "a plate of spaces", draft: { mode: "existing", modelId: known, vehicle: { plate: "   " } } },
    { label: "a plate of a wide space", draft: { mode: "existing", modelId: known, vehicle: { plate: "　" } } },
    { label: "no plate", draft: { mode: "existing", modelId: known, vehicle: { odometerKm: 10 } } },
    { label: "no vehicle", draft: { mode: "existing", modelId: known } },
    { label: "no draft", draft: null },
  ];
  for (const fn of ["addBikeCheck", "addBikeSave"]) {
    for (const { label, draft } of drafts) {
      const what = `${fn}, ${label}`;
      const script = world(SHEET_A, {
        routes: { [CHECK]: { body: OK_CHECK }, [PUBLISH]: { body: REPORT }, ...STEP_ROUTES },
      });
      let result: any;
      assert.doesNotThrow(() => {
        result = plain(script.call(fn, draft));
      }, what);

      assert.equal(result?.ok, false, `${what}: ${JSON.stringify(result)}`);
      assertReadable(result.message, what);
      assert.deepEqual(script.fetches, [], `${what}: no request at all`);
      assertNothingHappened(script, SHEET_A, what);
    }
  }

  // The same calls with the model and plate in place do go out, so the refusals above are about the draft.
  const script = world(SHEET_A, { routes: { [CHECK]: { body: OK_CHECK } } });
  const result = plain(script.call("addBikeCheck", { mode: "existing", modelId: known, vehicle: { plate: "わ9999" } }));
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.deepEqual(paths(script), [CHECK]);
});

test("addBikeSave keeps a digit-only plate and notes that look like a date or boolean as typed, and Publish reads them back", () => {
  // The valid fixture, so the Worker's own validateCatalog can read the whole sheet the way Publish does.
  const cases: Draft[] = [
    { mode: "existing", modelId: "pcx-125", vehicle: { plate: "0123", odometerKm: 8000, baseUsageDays: 3, notes: "2027-07-15" } },
    { mode: "existing", modelId: "today-50", vehicle: { plate: "2002", notes: "TRUE" } },
    { mode: "existing", modelId: "pcx-125", vehicle: { plate: "000", odometerKm: 0, baseUsageDays: 0, notes: "09:30" } },
    { mode: "existing", modelId: "today-50", vehicle: { plate: "2027-07-15", odometerKm: 1500, notes: "1,500" } },
    { mode: "existing", modelId: "pcx-125", vehicle: { plate: "わ0123", baseUsageDays: 12, notes: "Scratch on the left mirror" } },
  ];
  for (const draft of cases) {
    const { plate, odometerKm, baseUsageDays, notes } = draft.vehicle;
    const label = `plate ${JSON.stringify(plate)}, notes ${JSON.stringify(notes)}`;
    const tabs: Record<string, unknown[][]> = { ...validWorkbook(), PublishLog: [[...SHEET_TABS.PublishLog]] };
    let script: AppsScriptWorld | undefined;
    let read: ReturnType<typeof validateCatalog> | undefined;
    script = loadAppsScript({
      properties: PROPERTIES,
      user: USER,
      timeZone: "Asia/Tokyo",
      tabs,
      routes: {
        [CHECK]: { body: OK_CHECK },
        // What Publish reads: every tab through the Sheets API, checked by the Worker's own validateCatalog.
        [PUBLISH]: () => {
          const world = script as AppsScriptWorld;
          read = validateCatalog(Object.fromEntries([...world.tabs.keys()].map((name) => [name, sheetsApiValues(world, name)])), Date.now());
          return { body: REPORT };
        },
        ...STEP_ROUTES,
      },
    });
    const result = plain(script.call("addBikeSave", draft));
    assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);

    // The row as the sheet holds it: text as typed, numbers as numbers, and nothing for what the draft left out.
    const rows = script.tabs.get("Vehicles")?.rows ?? [];
    const row = rows.length;
    assert.equal(row, tabs.Vehicles.length + 1, `${label}: one row added`);
    const written = sheetRow(script, "Vehicles", row);
    assert.strictEqual(written.plate, plate, `${label}: the plate as typed`);
    assert.strictEqual(written.notes, notes, `${label}: the notes as typed`);
    assert.strictEqual(written.model_id, draft.modelId, label);
    assert.strictEqual(written.status, "active", label);
    assert.strictEqual(written.odometer_km, odometerKm ?? "", `${label}: the odometer as a number`);
    assert.strictEqual(written.base_usage_days, baseUsageDays ?? "", `${label}: the usage days as a number`);

    // Publish reads back the plate staff typed, with the numbers they meant.
    assert.ok(read !== undefined, `${label}: Publish ran`);
    const errors = read.statuses.filter((status) => status.tab === "Vehicles" && status.row === row && status.level === "error");
    assert.deepEqual(errors, [], `${label}: the Worker takes the row`);
    const vehicle = read.catalog?.vehicles.find((each) => each.plate === plate);
    assert.deepEqual(
      vehicle,
      { plate, modelId: draft.modelId, status: "active", odometerKm: odometerKm ?? null, baseUsageDays: baseUsageDays ?? 0 },
      `${label}: the vehicle Publish reads: ${JSON.stringify(read.catalog?.vehicles.map((each) => each.plate))}`,
    );
  }
});

// ---- A save that fails partway (#191) ----

test("a write that throws after the first row answers the rows already written, each with its tab and row number", () => {
  // Each sheet's Vehicles lacks one header the vehicle row needs, so the photos land in Models and the Vehicles write
  // throws. The Models row is counted by hand: the header row, then each record, a blank one included.
  const cases: {
    label: string;
    models: (Cells | null)[];
    vehicles: Cells[];
    missing: string;
    draft: Draft & { photos: string[] };
    row: number;
    status: string;
    photosBefore: string;
  }[] = [
    {
      label: "Rebel on sheet A, no notes column",
      models: [
        modelCells(PCX, "pcx-1.jpg, pcx-2.jpg"),
        null,
        modelCells(REBEL, "rebel-1.jpg", { publish_status: "ok" }),
        modelCells(NBOX, ""),
      ],
      vehicles: [{ plate: "わ1001", model_id: "pcx-125", status: "active" }],
      missing: "notes",
      draft: { mode: "existing", modelId: "rebel-250", photos: ["rebel-4.jpg"], vehicle: { plate: "わ9100", notes: "left mirror" } },
      row: 4,
      status: "ok",
      photosBefore: "rebel-1.jpg",
    },
    {
      label: "Today on sheet B, no odometer_km column",
      models: [modelCells(CUB, "cub.jpg"), modelCells(TODAY, "")],
      vehicles: [
        { plate: "わ7001", model_id: "cub-110", status: "active" },
        { plate: "わ7002", model_id: "today-50", status: "active" },
      ],
      missing: "odometer_km",
      draft: {
        mode: "existing",
        modelId: "today-50",
        photos: ["today-50-1.webp", "today-50-2.png"],
        vehicle: { plate: "わ7010", odometerKm: 300 },
      },
      row: 3,
      status: "",
      photosBefore: "",
    },
    {
      label: "N-BOX on sheet A, no base_usage_days column",
      models: [
        modelCells(PCX, "pcx-1.jpg"),
        null,
        null,
        modelCells(REBEL, "rebel-1.jpg"),
        modelCells(NBOX, "nbox-1.jpg", { publish_status: "warning: summary_en is blank" }),
      ],
      vehicles: [{ plate: "沖縄 あ 35-80", model_id: "nbox-660", status: "active" }],
      missing: "base_usage_days",
      draft: { mode: "existing", modelId: "nbox-660", photos: ["nbox-660-1.jpg"], vehicle: { plate: "沖縄 あ 35-81", baseUsageDays: 2 } },
      row: 6,
      status: "warning: summary_en is blank",
      photosBefore: "nbox-1.jpg",
    },
  ];
  for (const { label, models, vehicles, missing, draft, row, status, photosBefore } of cases) {
    const headers = VEHICLE_HEADERS.filter((header) => header.trim().toLowerCase() !== missing);
    const tabs = {
      Models: tab(MODEL_HEADERS, models),
      Vehicles: tab(headers, vehicles),
      PublishLog: [[...SHEET_TABS.PublishLog]],
    };
    const script = loadAppsScript({
      properties: PROPERTIES,
      user: USER,
      tabs,
      routes: { [CHECK]: { body: OK_CHECK }, [PUBLISH]: { body: REPORT }, ...STEP_ROUTES },
    });
    let result: any;
    assert.doesNotThrow(() => {
      result = plain(script.call("addBikeSave", draft));
    }, label);

    assert.equal(result?.ok, false, `${label}: ${JSON.stringify(result)}`);
    assertReadable(result.message, label);
    assert.ok(String(result.message).includes(missing), `${label}: the message names what failed: ${result.message}`);
    assert.deepEqual(result.written, [{ tab: "Models", row, status }], `${label}: the row written before the throw`);

    // The answer is the sheet's truth: the photos went into that row, and Vehicles is as it was.
    const added = draft.photos.join(", ");
    const written = sheetRow(script, "Models", row);
    assert.equal(written.model_id, draft.modelId, `${label}: row ${row} is the model's`);
    assert.equal(String(written.photos), photosBefore === "" ? added : `${photosBefore}, ${added}`, `${label}: the photos of row ${row}`);
    assert.deepEqual(script.tabs.get("Vehicles")?.rows, tabs.Vehicles, `${label}: no Vehicles row`);
    assert.deepEqual(paths(script).filter((path) => PUBLISH_PATHS.includes(path)), [], `${label}: no Publish request`);
    assert.deepEqual(logRows(script), [], `${label}: no PublishLog row`);
    assert.equal(script.lock.held(), false, `${label}: the lock is released`);
  }
});

// The panel itself: the shell and AddBikePanel.html as openAddBike shows them, their scripts run in node:vm on the fake
// DOM of tests/helpers/checkout-client.ts, with a fake google.script.run that answers each server function in the shape
// AddBike.js answers. Staff go through the steps of a bike of an existing model, then press Save on the check step. The
// adapters below fill in the few browser features that DOM lacks: select.options, Element.after, :checked and Option.

type SaveAnswer = { ok: false; message: string; written?: { tab: string; row: number; status: string }[] };
type ServerCall = { name: string; arg: unknown };

const PANEL_OPTIONS = {
  ok: true,
  models: [
    { id: "pcx-125", nameJa: "PCX", nameEn: "PCX125", typeId: "scooter", rateClassId: "bike-125", photos: [] },
    { id: "nbox-660", nameJa: "N-BOX", nameEn: "N-BOX", typeId: "car", rateClassId: "car-k", photos: ["nbox-1.jpg"] },
  ],
  plates: ["わ1001"],
  types: [
    { id: "scooter", depositJpy: 5000, hasRow: true },
    { id: "motorcycle", depositJpy: 10000, hasRow: true },
    { id: "car", depositJpy: 20000, hasRow: true },
    { id: "ebike", depositJpy: null, hasRow: false },
  ],
  rateClasses: [
    { id: "bike-125", group: "bike", nameJa: "125cc", prices: [] },
    { id: "car-k", group: "car", nameJa: "軽", prices: [] },
  ],
  packages: [],
};

const BLOCK_TAGS = new Set([
  ...["body", "div", "section", "p", "ul", "ol", "li", "h1", "h2", "h3", "h4", "pre", "br", "dl", "dt", "dd"],
  ...["table", "thead", "tbody", "tr", "td", "th", "fieldset", "legend", "label"],
]);

/** The lines a reader sees under `root`: block elements and newlines break lines; hidden elements and controls show none. */
function visibleLines(root: FakeElement, skip: FakeElement | null = null): string[] {
  let text = "";
  const walk = (node: FakeElement | FakeText): void => {
    if (node instanceof FakeText) {
      text += node.data;
      return;
    }
    if (node === skip || node.hidden || node.style.display === "none") return;
    if (["script", "style", "template", "select", "option", "input", "textarea"].includes(node.localName)) return;
    const block = BLOCK_TAGS.has(node.localName);
    if (block) text += "\n";
    for (const child of node.childNodes) walk(child as FakeElement | FakeText);
    if (block) text += "\n";
  };
  walk(root);
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

type Panel = { document: FakeDocument; calls: ServerCall[]; step(): string; next(): Promise<void>; set(id: string, value: string): void };

async function openBikePanel(save: SaveAnswer): Promise<Panel> {
  const opened = world(SHEET_A);
  opened.call("openAddBike");
  const document = parsePage(`<html><body>${opened.shown[0].html}</body></html>`);

  for (const select of document.querySelectorAll("select")) {
    Object.defineProperty(select, "options", { get: () => select.querySelectorAll("option") });
  }
  for (const element of document.querySelectorAll("*")) {
    Object.defineProperty(element, "after", {
      value: (...nodes: FakeElement[]) => {
        const parent = element.parentNode as FakeElement;
        const following = parent.childNodes[parent.childNodes.indexOf(element) + 1] ?? null;
        for (const node of nodes) parent.insertBefore(node, following);
      },
    });
  }
  const query = document.querySelector.bind(document);
  (document as unknown as { querySelector(selector: string): FakeElement | null }).querySelector = (selector: string) => {
    const checked = /^(.*):checked$/.exec(selector);
    if (checked === null) return query(selector);
    return document.querySelectorAll(checked[1]).find((input) => input.hasAttribute("checked")) ?? null;
  };
  function Option(text: unknown, value?: unknown): FakeElement {
    const option = document.createElement("option");
    option.textContent = String(text);
    if (value !== undefined) option.setAttribute("value", String(value));
    return option;
  }

  const calls: ServerCall[] = [];
  const server: Record<string, (arg: unknown) => unknown> = {
    addBikeOptions: () => PANEL_OPTIONS,
    addBikeCheck: () => ({ ok: true, fatal: [], rows: { Vehicles: [{ level: "ok", messages: [] }] } }),
    addBikeSave: () => save,
  };
  type Handler = ((value: unknown) => void) | undefined;
  const runner = (success: Handler, failure: Handler): unknown =>
    new Proxy(
      {},
      {
        get: (_, key) => {
          if (key === "withSuccessHandler") return (handler: Handler) => runner(handler, failure);
          if (key === "withFailureHandler") return (handler: Handler) => runner(success, handler);
          if (typeof key !== "string") return undefined;
          return (arg?: unknown) => {
            calls.push({ name: key, arg: plain(arg) });
            setImmediate(() => {
              const fn = server[key];
              if (fn === undefined) failure?.(new Error(`Script function not found: ${key}`));
              else success?.(plain(fn(plain(arg))));
            });
          };
        },
      },
    );

  const google = { script: { run: runner(undefined, undefined) } };
  const context = createContext({ document, window: document.window, google, Option, console });
  for (const script of document.querySelectorAll("script")) {
    new Script(script.textContent, { filename: "AddBike dialog" }).runInContext(context);
  }
  document.dispatchEvent(new FakeEvent("DOMContentLoaded"));
  await settle();

  return {
    document,
    calls,
    step: () => document.querySelectorAll("[data-step]").find((section) => isShown(section))?.dataset.step ?? "",
    async next() {
      const button = document.querySelectorAll(".panel-nav button").find((each) => each.classList.contains("primary"));
      assert.ok(button !== undefined && isShown(button) && !button.disabled, "a Next button to press");
      button.click();
      await settle();
    },
    set(id: string, value: string) {
      const control = document.getElementById(id);
      assert.ok(control !== null, `the panel has #${id}`);
      control.value = value;
    },
  };
}

/** Through the steps of a bike of an existing model, to the check step with a clean check. */
async function reachCheck(panel: Panel, modelId: string, plate: string): Promise<void> {
  const error = () => visibleText(panel.document.getElementById("panel-error"));
  for (let i = 0; i < 8 && panel.step() !== "check"; i += 1) {
    if (panel.step() === "model") panel.set("bike-model", modelId);
    if (panel.step() === "vehicle") panel.set("bike-plate", plate);
    await panel.next();
    assert.equal(error(), "", `no error on the way to the check, at ${panel.step()}`);
  }
  assert.equal(panel.step(), "check", "the panel reaches the check step");
  assert.ok(
    panel.calls.some(({ name }) => name === "addBikeCheck"),
    `the panel checked: ${JSON.stringify(panel.calls.map(({ name }) => name))}`,
  );
}

const SAVE_FAILED = "Could not write the row, so nothing was published:";

test("a save that fails partway shows its message and every row it wrote, by tab and row number; one that wrote nothing shows the message alone", async () => {
  const cases: { label: string; modelId: string; plate: string; save: SaveAnswer }[] = [
    {
      label: "photos into Models, then the Vehicles write threw",
      modelId: "pcx-125",
      plate: "わ9100",
      save: { ok: false, message: `${SAVE_FAILED} Vehicles: the header notes is missing`, written: [{ tab: "Models", row: 17, status: "" }] },
    },
    {
      label: "a new model's Types, RateClasses and two Prices rows, then Models threw",
      modelId: "nbox-660",
      plate: "沖縄 あ 35-81",
      save: {
        ok: false,
        message: `${SAVE_FAILED} Models: the header brand is missing`,
        written: [
          { tab: "Types", row: 6, status: "" },
          { tab: "RateClasses", row: 23, status: "" },
          { tab: "Prices", row: 41, status: "" },
          { tab: "Prices", row: 42, status: "" },
        ],
      },
    },
    {
      label: "every row written, then the flush failed",
      modelId: "pcx-125",
      plate: "わ0123",
      save: {
        ok: false,
        message: `${SAVE_FAILED} Service Spreadsheets timed out while accessing document`,
        written: [
          { tab: "RateClasses", row: 8, status: "" },
          { tab: "Prices", row: 115, status: "" },
          { tab: "Models", row: 33, status: "ok" },
          { tab: "Vehicles", row: 210, status: "" },
        ],
      },
    },
    {
      label: "the first write threw",
      modelId: "nbox-660",
      plate: "わ7010",
      save: { ok: false, message: `${SAVE_FAILED} Types: the header deposit_jpy is missing`, written: [] },
    },
    {
      label: "refused before any write",
      modelId: "pcx-125",
      plate: "わ9001",
      save: { ok: false, message: "A Publish is running, so nothing was saved. Try again when it has finished." },
    },
  ];
  for (const { label, modelId, plate, save } of cases) {
    const panel = await openBikePanel(save);
    await reachCheck(panel, modelId, plate);
    const body = panel.document.body as FakeElement;
    const errorBox = panel.document.getElementById("panel-error") as FakeElement;
    const before = visibleLines(body);
    const beforeOutsideError = visibleLines(body, errorBox);

    await panel.next();

    const saves = panel.calls.filter(({ name }) => name === "addBikeSave");
    assert.equal(saves.length, 1, `${label}: Save called addBikeSave once`);
    assert.equal((saves[0].arg as Draft).vehicle.plate, plate, `${label}: with the draft`);
    assert.equal((saves[0].arg as Draft).modelId, modelId, `${label}: with the draft`);

    // The message, as the server wrote it.
    const shown = visibleText(body);
    assert.ok(shown.includes(save.message), `${label}: the message shows: ${shown}`);

    const written = save.written ?? [];
    if (written.length === 0) {
      // As today: the message in the error box, and nothing else on the panel changed.
      assert.equal(visibleText(errorBox), save.message, `${label}: the error box holds the message`);
      assert.deepEqual(visibleLines(body, errorBox), beforeOutsideError, `${label}: the message alone`);
      continue;
    }

    // Each written row on a line that was not there before Save, with its tab and its row number.
    const added = visibleLines(body).filter((line) => !before.includes(line));
    for (const { tab: tabName, row } of written) {
      const word = new RegExp(`(?<![A-Za-z_])${tabName}(?![A-Za-z_])`);
      assert.ok(
        added.some((line) => word.test(line) && hasNumber(line, row)),
        `${label}: ${tabName} row ${row} shows after Save: ${JSON.stringify(added)}`,
      );
    }
  }
});
