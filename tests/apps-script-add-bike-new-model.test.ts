// The Add a bike panel's new-model path (apps-script/AddBike.js), run in node:vm against the fake Google services as in
// apps-script-add-bike.test.ts. A draft `{ mode: 'new', model, rateClass, prices?, type?, vehicle }` becomes the Types,
// RateClasses, Prices, Models and Vehicles rows it needs. Unless a test hands it a canned answer, the fake Worker checks
// the proposed rows with the endpoint's own checkProposedRows over the sheet as it stands, so the rows must also be rows
// the real schema accepts. Expected cells are written out here from the draft and the fixture, by hand.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProposedRows, parseProposedRows } from "../src/lib/catalog/check-rows.ts";
import { SHEET_TABS, validateCatalog } from "../src/lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../src/lib/crypto.ts";
import { type AppsScriptWorld, type FetchCall, loadAppsScript, type Route, sheetsApiValues } from "./helpers/apps-script.ts";
import { validWorkbook } from "./helpers/sheet-workbook.ts";

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

/** The tabs a new model can add to, in the order they depend on each other. */
const ORDER = ["Types", "RateClasses", "Prices", "Models", "Vehicles"] as const;
type NewTab = (typeof ORDER)[number];

/** The cells that name a row of each tab. */
const KEYS: Record<NewTab, string[]> = {
  Types: ["type_id"],
  RateClasses: ["rate_class_id"],
  Prices: ["rate_class_id", "package_id"],
  Models: ["model_id"],
  Vehicles: ["plate"],
};

const LOCALES = [
  ["ja", "ja"],
  ["en", "en"],
  ["zh", "zh"],
  ["ko", "ko"],
] as const;

const STACK_TRACE = /\n\s+at\s|\.js:\d+|(Type|Reference|Syntax|Range)Error|Cannot read|\bundefined\b|\[object Object\]/;

const REPORT = { ok: true, version: 412, counts: { ok: 120, warning: 3, error: 0 }, fatal: [], affectedBookings: [] };
const STEP_ROUTES: Record<string, Route> = {
  [BLOCKS]: { body: { processed: 4, remaining: 0, errors: [] } },
  [PHOTOS]: { body: { copied: 2, skipped: [], errors: [], remaining: 0 } },
  [ASSIGNMENTS]: { body: { applied: 1, errors: [] } },
};

const plain = (value: unknown): any => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

type Texts = { ja: string; en: string; zh: string; ko: string };
type ModelTexts = { name: Texts; summary: Texts; description: Texts };
type Vehicle = { plate: string; odometerKm?: number; baseUsageDays?: number; notes?: string };
type Price = { packageId: string; priceJpy: number; advancePriceJpy?: number };
type NewClass = { id: string; group: string; sort?: number; extensionPerHourJpy?: number; names: Texts };
type NewDraft = {
  mode: "new";
  model: {
    modelId: string;
    typeId: string;
    brand: string;
    engineCc?: number;
    seats?: number;
    licenseClass?: string;
    sort?: number;
    active: true;
    texts: ModelTexts;
  };
  rateClass: { id: string } | { new: NewClass };
  prices?: Price[];
  type?: { depositJpy: number; sort?: number; names: Texts };
  vehicle: Vehicle;
};

// ---------------------------------------------------------------------------------------------------------------------
// Two sheets. Sheet A is the valid fixture: Types has no ebike row, and every sort column runs 1, 2, 3... Sheet B has no
// car type, an ebike class, other packages, and sorts whose highest is in the middle of the tab, not the last row.

type Sheet = { label: string; tabs: Record<string, unknown[][]> };

function sheetA(): Sheet {
  return { label: "sheet A", tabs: { ...validWorkbook(), PublishLog: [[...SHEET_TABS.PublishLog]] } };
}

function fixtureModel(id: string, typeId: string, classId: string, brand: string, seats: unknown, cc: unknown, sort: number) {
  const each = (field: string) => [`${id}の${field}`, `${id} ${field}`, `${id}${field}中文`, `${id} ${field} 한국어`];
  return [id, typeId, classId, brand, seats, cc, "", sort, true, ...each("name"), ...each("summary"), ...each("description"), `${id}.jpg`];
}

function sheetB(): Sheet {
  const base = validWorkbook();
  return {
    label: "sheet B",
    tabs: {
      ...base,
      Types: [
        [...SHEET_TABS.Types],
        ["scooter", 2500, 4, "スクーター", "Scooter", "踏板车", "스쿠터"],
        [],
        ["ebike", 1500, 9, "電動アシスト自転車", "E-bike", "电动助力自行车", "전기자전거"],
        ["motorcycle", 6000, 6, "バイク", "Motorcycle", "摩托车", "오토바이"],
      ],
      RateClasses: [
        [...SHEET_TABS.RateClasses],
        ["bike-50", "bike", 3, 400, "50ccクラス", "50cc class", "50cc级", "50cc 클래스"],
        ["ebike-day", "ebike", 12, "", "電動クラス", "E-bike class", "电动级", "전기 클래스"],
        ["bike-250", "bike", 8, 900, "250ccクラス", "250cc class", "250cc级", "250cc 클래스"],
      ],
      Packages: [
        [...SHEET_TABS.Packages],
        ["day-1", 1, "", 1, "1日", "1 day", "1天", "1일"],
        ["hours-4", "", 4, 2, "4時間", "4 hours", "4小时", "4시간"],
        ["day-2", 2, "", 3, "2日", "2 days", "2天", "2일"],
      ],
      Prices: [
        [...SHEET_TABS.Prices],
        ["bike-50", "day-1", 2800],
        ["bike-50", "hours-4", 1900, 1700],
        ["ebike-day", "day-1", 3000, 2600],
        ["ebike-day", "day-2", 5400],
        ["bike-250", "day-1", 7600, 7000],
        ["bike-250", "hours-4", 4800],
        ["bike-250", "day-2", 14000, 12800],
      ],
      Models: [
        [...SHEET_TABS.Models],
        fixtureModel("dio-50", "scooter", "bike-50", "Honda", "", 49, 15),
        fixtureModel("pas-city", "ebike", "ebike-day", "Yamaha", "", "", 40),
        fixtureModel("cb250r", "motorcycle", "bike-250", "Honda", 2, 249, 22),
      ],
      Vehicles: [
        [...SHEET_TABS.Vehicles],
        ["わ3001", "dio-50", "active", 500],
        ["わ3002", "pas-city", "active"],
        ["わ3003", "cb250r", "maintenance", 1200, 10],
      ],
      Blocks: [[...SHEET_TABS.Blocks]],
      PublishLog: [[...SHEET_TABS.PublishLog]],
    },
  };
}

/** The highest sort of a tab's fixture rows, read here from the fixture itself. */
function highestSort(sheet: Sheet, tab: string): number {
  const [header, ...rows] = sheet.tabs[tab];
  const at = header.indexOf("sort");
  return Math.max(...rows.map((cells) => Number(cells[at])).filter((value) => Number.isFinite(value) && value > 0));
}

// ---------------------------------------------------------------------------------------------------------------------
// Drafts and the rows they should become.

function texts(label: string): ModelTexts {
  return {
    name: { ja: `${label}（名前）`, en: `${label} name`, zh: `${label}名称`, ko: `${label} 이름` },
    summary: { ja: `${label}の概要`, en: `${label} summary`, zh: `${label}简介`, ko: `${label} 요약` },
    description: { ja: `${label}の説明`, en: `${label} description`, zh: `${label}说明`, ko: `${label} 설명` },
  };
}

function names(label: string): Texts {
  return { ja: `${label}（日）`, en: `${label} EN`, zh: `${label}中文`, ko: `${label} 한국어` };
}

function classIdOf(draft: NewDraft): string {
  return "new" in draft.rateClass ? draft.rateClass.new.id : draft.rateClass.id;
}

const text = (value: unknown): string => (value === undefined || value === null ? "" : String(value));

function localeCells(field: string, values: Texts): Record<string, string> {
  return Object.fromEntries(LOCALES.map(([key, suffix]) => [`${field}_${suffix}`, values[key]]));
}

function expectedModel(draft: NewDraft, sort: number): Record<string, string> {
  const m = draft.model;
  return {
    model_id: m.modelId,
    type_id: m.typeId,
    rate_class_id: classIdOf(draft),
    brand: m.brand,
    seats: text(m.seats),
    engine_cc: m.typeId === "ebike" ? "" : text(m.engineCc),
    license_class: text(m.licenseClass),
    sort: String(sort),
    ...localeCells("name", m.texts.name),
    ...localeCells("summary", m.texts.summary),
    ...localeCells("description", m.texts.description),
  };
}

function expectedVehicle(draft: NewDraft): Record<string, string> {
  const { plate, odometerKm, baseUsageDays, notes } = draft.vehicle;
  return {
    plate,
    model_id: draft.model.modelId,
    status: "active",
    odometer_km: text(odometerKm),
    base_usage_days: text(baseUsageDays),
    notes: text(notes),
  };
}

function expectedClass(cls: NewClass, sort: number): Record<string, string> {
  return {
    rate_class_id: cls.id,
    group: cls.group,
    sort: String(sort),
    extension_per_hour_jpy: text(cls.extensionPerHourJpy),
    ...localeCells("name", cls.names),
  };
}

function expectedPrices(classId: string, prices: Price[]): Record<string, string>[] {
  return prices
    .map((price) => ({
      rate_class_id: classId,
      package_id: price.packageId,
      price_jpy: String(price.priceJpy),
      advance_price_jpy: text(price.advancePriceJpy),
    }))
    .sort((a, b) => a.package_id.localeCompare(b.package_id));
}

function expectedType(typeId: string, type: NonNullable<NewDraft["type"]>, sort: number): Record<string, string> {
  return { type_id: typeId, deposit_jpy: String(type.depositJpy), sort: String(sort), ...localeCells("name", type.names) };
}

/** A row's cells as text, keyed by the plain header name, for comparing with a row written out by hand. */
function asText(row: Record<string, unknown> | undefined, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, text(row?.[key])]));
}

function assertRow(row: Record<string, unknown> | undefined, expected: Record<string, string>, what: string): void {
  assert.deepEqual(asText(row, Object.keys(expected)), expected, `${what}: ${JSON.stringify(row)}`);
}

function assertActive(row: Record<string, unknown> | undefined, what: string): void {
  const value = row?.active;
  assert.ok(value === true || String(value).trim().toUpperCase() === "TRUE", `${what}: active is TRUE, not ${JSON.stringify(value)}`);
}

const byPackage = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) => String(a.package_id).localeCompare(String(b.package_id)));

// ---------------------------------------------------------------------------------------------------------------------
// The fake Worker.

type ProposedRows = Record<string, Record<string, unknown>[]>;

/** The rows of a check call, read out of its envelope without checking the signature (one test does that). */
function rowsOf(call: FetchCall | undefined): ProposedRows {
  const envelope = JSON.parse(String(call?.payload));
  return JSON.parse(envelope.payload).rows as ProposedRows;
}

function checkCalls(script: AppsScriptWorld): FetchCall[] {
  return script.fetches.filter((call) => call.path === CHECK);
}

/** The rows of the last check call. */
function proposed(script: AppsScriptWorld): ProposedRows {
  const calls = checkCalls(script);
  assert.ok(calls.length > 0, `a check was sent: ${JSON.stringify(script.fetches.map((call) => call.path))}`);
  return rowsOf(calls[calls.length - 1]);
}

function workbookOf(script: AppsScriptWorld): Record<string, unknown[][]> {
  return Object.fromEntries([...script.tabs].map(([name, tab]) => [name, tab.rows.map((cells) => [...cells])]));
}

function keyOf(tab: NewTab, cells: Record<string, unknown>): string {
  return KEYS[tab].map((column) => text(cells[column]).trim()).join("/");
}

function headerIndex(headers: unknown[], name: string): number {
  return headers.findIndex((header) => String(header).trim().toLowerCase() === name);
}

/** The sheet row (1-based) as `{ header: cell }`. */
function sheetRow(script: AppsScriptWorld, tab: string, row: number): Record<string, unknown> {
  const rows = script.tabs.get(tab)?.rows ?? [];
  const headers = rows[0] ?? [];
  const cells = rows[row - 1] ?? [];
  return Object.fromEntries(headers.map((header, i) => [String(header).trim().toLowerCase(), cells[i] ?? ""]));
}

/** The 1-based sheet row whose key cells read `key`, or 0. */
function rowOf(script: AppsScriptWorld, tab: NewTab, key: string): number {
  const rows = script.tabs.get(tab)?.rows ?? [];
  for (let row = 2; row <= rows.length; row += 1) {
    if (keyOf(tab, sheetRow(script, tab, row)) === key) return row;
  }
  return 0;
}

/** What the Worker does during /api/publish: writes each named row's status. Answers whether it found every one. */
function writeStatuses(script: AppsScriptWorld, statuses: Record<string, string>): boolean {
  let all = true;
  for (const [name, status] of Object.entries(statuses)) {
    const [tab, key] = [name.slice(0, name.indexOf(":")) as NewTab, name.slice(name.indexOf(":") + 1)];
    const row = rowOf(script, tab, key);
    if (row === 0) {
      all = false;
      continue;
    }
    const rows = script.tabs.get(tab)?.rows ?? [];
    rows[row - 1][headerIndex(rows[0], "publish_status")] = status;
  }
  return all;
}

type Fake = { script: AppsScriptWorld; publishSawRows: () => boolean };

/**
 * A world whose Worker checks with the real checkProposedRows (or answers `check`), and whose /api/publish writes
 * `statuses` (`"Tab:key": status`) into the sheet.
 */
function fake(
  sheet: Sheet,
  options: { check?: unknown; statuses?: Record<string, string>; version?: number; user?: string } = {},
): Fake {
  let script: AppsScriptWorld | undefined;
  let saw = false;
  const checkRoute: Route =
    options.check === undefined
      ? () => {
          const world = script as AppsScriptWorld;
          const rows = parseProposedRows(rowsOf(checkCalls(world).at(-1)));
          if (rows === null) return { status: 400, body: "The rows could not be read" };
          return { body: checkProposedRows(workbookOf(world), rows, Date.now()) };
        }
      : { body: options.check };
  script = loadAppsScript({
    properties: PROPERTIES,
    user: options.user ?? USER,
    tabs: sheet.tabs,
    routes: {
      [CHECK]: checkRoute,
      [PUBLISH]: () => {
        saw = writeStatuses(script as AppsScriptWorld, options.statuses ?? {});
        return { body: { ...REPORT, version: options.version ?? REPORT.version } };
      },
      ...STEP_ROUTES,
    },
  });
  return { script, publishSawRows: () => saw };
}

/** No proposed row is an error or fatal under the real check. */
function assertClean(result: any, what: string): void {
  assert.equal(result?.ok, true, `${what}: ${JSON.stringify(result)}`);
  assert.deepEqual(result.fatal, [], `${what}: no fatal reason`);
  for (const [tab, checks] of Object.entries(result.rows as Record<string, { level: string; messages: string[] }[]>)) {
    checks.forEach((check, i) => assert.notEqual(check.level, "error", `${what}: ${tab} row ${i + 1}: ${check.messages}`));
  }
}

function assertUnchanged(script: AppsScriptWorld, sheet: Sheet, tabs: string[], what: string): void {
  for (const tab of tabs) {
    assert.deepEqual(script.tabs.get(tab)?.rows, sheet.tabs[tab], `${what}: ${tab} is as it was`);
    assert.deepEqual(script.tabs.get(tab)?.touches, [], `${what}: nothing wrote to ${tab}`);
  }
}

function paths(script: AppsScriptWorld): string[] {
  return script.fetches.map((call) => call.path);
}

function assertReadable(value: unknown, what: string): void {
  assert.equal(typeof value, "string", `${what}: a message`);
  assert.notEqual(String(value).trim(), "", `${what}: a message`);
  assert.doesNotMatch(String(value), STACK_TRACE, what);
}

// ---------------------------------------------------------------------------------------------------------------------

test("a new model in an existing class adds a Models and a Vehicles row and no Prices row", async () => {
  const cases: { sheet: Sheet; user: string; draft: NewDraft; sort: number }[] = [
    {
      sheet: sheetA(),
      user: USER,
      draft: {
        mode: "new",
        model: { modelId: "adv-160", typeId: "scooter", brand: "Honda", engineCc: 156, seats: 2, active: true, texts: texts("ADV") },
        rateClass: { id: "bike-125" },
        vehicle: { plate: "わ2001", odometerKm: 300 },
      },
      sort: 6,
    },
    {
      sheet: sheetA(),
      user: "manager@example.jp",
      draft: {
        mode: "new",
        model: { modelId: "sienta", typeId: "car", brand: "Toyota", engineCc: 1490, seats: 7, active: true, texts: texts("シエンタ") },
        rateClass: { id: "car-k" },
        vehicle: { plate: "沖縄 さ 12-34", baseUsageDays: 0, notes: "Child seat fitted" },
      },
      sort: 6,
    },
    {
      sheet: sheetB(),
      user: USER,
      draft: {
        mode: "new",
        model: {
          modelId: "gb350",
          typeId: "motorcycle",
          brand: "Honda",
          engineCc: 348,
          licenseClass: "standard",
          sort: 7,
          active: true,
          texts: texts("GB"),
        },
        rateClass: { id: "bike-250" },
        vehicle: { plate: "わ3101", odometerKm: 0 },
      },
      sort: 7,
    },
  ];

  for (const { sheet, user, draft, sort } of cases) {
    const label = `${sheet.label}, ${draft.model.modelId}`;

    // The check: one signed request with exactly a Models and a Vehicles row, which the real check accepts.
    const { script } = fake(sheet, { user });
    assertClean(plain(script.call("addBikeCheck", draft)), `${label}: the real check`);
    assert.deepEqual(paths(script), [CHECK], `${label}: one request, to the check`);
    const verified = await verifyEnvelope(SECRET, String(script.fetches[0].payload), Date.now());
    assert.equal(verified.ok, true, `${label}: signed with PUBLISH_SECRET`);
    const payload = (verified as { payload: { requestedBy?: unknown; rows?: unknown } }).payload;
    assert.equal(payload.requestedBy, user, `${label}: requestedBy`);
    assert.notEqual(parseProposedRows(payload.rows), null, `${label}: rows the endpoint reads`);
    const rows = payload.rows as ProposedRows;
    assert.deepEqual(Object.keys(rows).sort(), ["Models", "Vehicles"], `${label}: no Prices, RateClasses or Types row`);
    assert.equal(rows.Models.length, 1, label);
    assert.equal(rows.Vehicles.length, 1, label);
    assertRow(rows.Models[0], expectedModel(draft, sort), `${label}: the Models row`);
    assertActive(rows.Models[0], label);
    assertRow(rows.Vehicles[0], expectedVehicle(draft), `${label}: the Vehicles row`);

    // The save adds one row to each of Models and Vehicles and leaves the others alone.
    const { script: saved, publishSawRows } = fake(sheet, {
      statuses: { [`Models:${draft.model.modelId}`]: "ok", [`Vehicles:${draft.vehicle.plate}`]: "warning: odometer_km" },
    });
    const result = plain(saved.call("addBikeSave", draft));
    assert.equal(result?.ok, true, `${label}: save: ${JSON.stringify(result)}`);
    assert.ok(publishSawRows(), `${label}: both rows were in the sheet when Publish ran`);
    assert.equal(saved.tabs.get("Models")?.rows.length, sheet.tabs.Models.length + 1, `${label}: one Models row`);
    assert.equal(saved.tabs.get("Vehicles")?.rows.length, sheet.tabs.Vehicles.length + 1, `${label}: one Vehicles row`);
    assertUnchanged(saved, sheet, ["Types", "RateClasses", "Prices"], label);
    const modelRow = rowOf(saved, "Models", draft.model.modelId);
    const vehicleRow = rowOf(saved, "Vehicles", draft.vehicle.plate);
    assertRow(sheetRow(saved, "Models", modelRow), expectedModel(draft, sort), `${label}: the written Models row`);
    assertRow(sheetRow(saved, "Vehicles", vehicleRow), expectedVehicle(draft), `${label}: the written Vehicles row`);
    assert.deepEqual(
      result.written,
      [
        { tab: "Models", row: modelRow, status: "ok" },
        { tab: "Vehicles", row: vehicleRow, status: "warning: odometer_km" },
      ],
      label,
    );
  }

  // Prices handed in with an existing class never become rows: its prices are read-only (owner decision 4).
  const sheet = sheetA();
  const draft: NewDraft = {
    ...cases[0].draft,
    prices: [{ packageId: "day-1", priceJpy: 1, advancePriceJpy: 1 }],
  };
  const { script } = fake(sheet, { statuses: { "Models:adv-160": "ok", "Vehicles:わ2001": "ok" } });
  script.call("addBikeCheck", draft);
  for (const call of checkCalls(script)) assert.equal(rowsOf(call).Prices, undefined, "no Prices row is proposed");
  script.call("addBikeSave", draft);
  for (const call of checkCalls(script)) assert.equal(rowsOf(call).Prices, undefined, "no Prices row is proposed");
  assertUnchanged(script, sheet, ["Prices", "RateClasses", "Types"], "prices with an existing class");
});

test("a new class adds its RateClasses row and one Prices row per priced package, advance price included", () => {
  const cases: { sheet: Sheet; draft: NewDraft; classSort: number }[] = [
    {
      sheet: sheetA(),
      draft: {
        mode: "new",
        model: { modelId: "nmax-155", typeId: "scooter", brand: "Yamaha", engineCc: 155, seats: 2, active: true, texts: texts("NMAX") },
        rateClass: { new: { id: "bike-155", group: "bike", sort: 9, extensionPerHourJpy: 800, names: names("155cc") } },
        prices: [
          { packageId: "hours-6", priceJpy: 3900, advancePriceJpy: 3500 },
          { packageId: "day-1", priceJpy: 5600 },
          { packageId: "day-3", priceJpy: 14800, advancePriceJpy: 13900 },
        ],
        vehicle: { plate: "わ2101" },
      },
      classSort: 9,
    },
    {
      sheet: sheetB(),
      draft: {
        mode: "new",
        model: { modelId: "cb400", typeId: "motorcycle", brand: "Honda", engineCc: 399, seats: 2, active: true, texts: texts("CB400") },
        rateClass: { new: { id: "bike-400x", group: "bike", names: names("400cc") } },
        prices: [{ packageId: "day-2", priceJpy: 9800, advancePriceJpy: 9000 }],
        vehicle: { plate: "わ3201", odometerKm: 15 },
      },
      classSort: 13,
    },
  ];

  for (const { sheet, draft, classSort } of cases) {
    const label = `${sheet.label}, ${classIdOf(draft)}`;
    const cls = (draft.rateClass as { new: NewClass }).new;
    const prices = draft.prices ?? [];

    const { script } = fake(sheet);
    assertClean(plain(script.call("addBikeCheck", draft)), `${label}: the real check`);
    assert.equal(checkCalls(script).length, 1, `${label}: one check call`);
    const rows = proposed(script);
    assert.deepEqual(Object.keys(rows).sort(), ["Models", "Prices", "RateClasses", "Vehicles"], `${label}: no Types row`);
    assert.equal(rows.RateClasses.length, 1, label);
    assertRow(rows.RateClasses[0], expectedClass(cls, classSort), `${label}: the RateClasses row`);
    assert.equal(rows.Prices.length, prices.length, `${label}: one Prices row per priced package`);
    byPackage(rows.Prices).forEach((row, i) =>
      assertRow(row, expectedPrices(cls.id, prices)[i], `${label}: Prices row ${i + 1}`),
    );
    assert.equal(rows.Models[0]?.rate_class_id, cls.id, `${label}: the model is in the new class`);

    // Saved, the rows are in the sheet under their headers.
    const statuses: Record<string, string> = {
      [`RateClasses:${cls.id}`]: "ok",
      [`Models:${draft.model.modelId}`]: "ok",
      [`Vehicles:${draft.vehicle.plate}`]: "ok",
    };
    for (const price of prices) statuses[`Prices:${cls.id}/${price.packageId}`] = "ok";
    const saved = fake(sheet, { statuses }).script;
    const result = plain(saved.call("addBikeSave", draft));
    assert.equal(result?.ok, true, `${label}: save: ${JSON.stringify(result)}`);
    assert.equal(saved.tabs.get("RateClasses")?.rows.length, sheet.tabs.RateClasses.length + 1, label);
    assert.equal(saved.tabs.get("Prices")?.rows.length, sheet.tabs.Prices.length + prices.length, label);
    assertUnchanged(saved, sheet, ["Types"], label);
    assertRow(sheetRow(saved, "RateClasses", rowOf(saved, "RateClasses", cls.id)), expectedClass(cls, classSort), label);
    for (const expected of expectedPrices(cls.id, prices)) {
      const row = rowOf(saved, "Prices", `${cls.id}/${expected.package_id}`);
      assert.ok(row > sheet.tabs.Prices.length, `${label}: ${expected.package_id} is a new row below the others`);
      assertRow(sheetRow(saved, "Prices", row), expected, `${label}: the written Prices row`);
    }
  }
});

test("a type with no row adds a Types row with the deposit and an existing type adds none", () => {
  // Sheet A has no ebike row, sheet B no car row.
  const added: { sheet: Sheet; draft: NewDraft; typeSort: number }[] = [
    {
      sheet: sheetA(),
      draft: {
        mode: "new",
        model: { modelId: "e-cruiser", typeId: "ebike", brand: "Panasonic", active: true, texts: texts("イークルーザー") },
        rateClass: { new: { id: "ebike", group: "ebike", sort: 5, names: names("電動") } },
        prices: [{ packageId: "day-1", priceJpy: 4500, advancePriceJpy: 4000 }],
        type: { depositJpy: 2000, names: names("E-bike") },
        vehicle: { plate: "わ2201" },
      },
      typeSort: 4,
    },
    {
      sheet: sheetB(),
      draft: {
        mode: "new",
        model: { modelId: "sienta", typeId: "car", brand: "Toyota", engineCc: 1490, seats: 7, active: true, texts: texts("シエンタ") },
        rateClass: { new: { id: "car-m", group: "car", sort: 20, names: names("普通車") } },
        prices: [
          { packageId: "day-1", priceJpy: 9900 },
          { packageId: "day-2", priceJpy: 18500, advancePriceJpy: 17000 },
        ],
        type: { depositJpy: 15000, sort: 2, names: names("Car") },
        vehicle: { plate: "沖縄 な 56-78" },
      },
      typeSort: 2,
    },
  ];
  for (const { sheet, draft, typeSort } of added) {
    const label = `${sheet.label}, type ${draft.model.typeId}`;
    const type = draft.type as NonNullable<NewDraft["type"]>;
    const { script } = fake(sheet);
    assertClean(plain(script.call("addBikeCheck", draft)), `${label}: the real check`);
    const rows = proposed(script);
    assert.equal(rows.Types?.length, 1, `${label}: one Types row: ${JSON.stringify(rows)}`);
    assertRow(rows.Types[0], expectedType(draft.model.typeId, type, typeSort), `${label}: the Types row`);

    const saved = fake(sheet).script;
    const result = plain(saved.call("addBikeSave", draft));
    assert.equal(result?.ok, true, `${label}: save: ${JSON.stringify(result)}`);
    assert.equal(saved.tabs.get("Types")?.rows.length, sheet.tabs.Types.length + 1, `${label}: one Types row written`);
    const row = rowOf(saved, "Types", draft.model.typeId);
    assertRow(sheetRow(saved, "Types", row), expectedType(draft.model.typeId, type, typeSort), `${label}: the written row`);
  }

  // A type that has its row adds none, also when the draft carries a deposit for it: the deposit is read-only.
  const kept: { sheet: Sheet; draft: NewDraft }[] = [
    {
      sheet: sheetA(),
      draft: {
        mode: "new",
        model: { modelId: "adv-160", typeId: "scooter", brand: "Honda", engineCc: 156, active: true, texts: texts("ADV") },
        rateClass: { id: "bike-125" },
        type: { depositJpy: 99999, sort: 1, names: names("Scooter") },
        vehicle: { plate: "わ2202" },
      },
    },
    {
      sheet: sheetB(),
      draft: {
        mode: "new",
        model: { modelId: "pas-slim", typeId: "ebike", brand: "Yamaha", active: true, texts: texts("PAS") },
        rateClass: { id: "ebike-day" },
        vehicle: { plate: "わ3301" },
      },
    },
  ];
  for (const { sheet, draft } of kept) {
    const label = `${sheet.label}, existing type ${draft.model.typeId}`;
    const { script } = fake(sheet, { statuses: { [`Models:${draft.model.modelId}`]: "ok", [`Vehicles:${draft.vehicle.plate}`]: "ok" } });
    script.call("addBikeCheck", draft);
    script.call("addBikeSave", draft);
    for (const call of checkCalls(script)) assert.equal(rowsOf(call).Types, undefined, `${label}: no Types row proposed`);
    assertUnchanged(script, sheet, ["Types"], label);
  }
  // Without a deposit in the draft, the existing type's model is saved with no Types row.
  const { sheet, draft } = kept[1];
  const { script } = fake(sheet, { statuses: { [`Models:${draft.model.modelId}`]: "ok", [`Vehicles:${draft.vehicle.plate}`]: "ok" } });
  const result = plain(script.call("addBikeSave", draft));
  assert.equal(result?.ok, true, `existing ebike: ${JSON.stringify(result)}`);
  assert.deepEqual(
    result.written.map((entry: { tab: string }) => entry.tab),
    ["Models", "Vehicles"],
    "existing ebike: only the model and vehicle",
  );
});

test("the translations land in the _ja, _en, _zh and _ko columns as typed", () => {
  // Full-width punctuation, half-width katakana, circled digits and full-width letters: NFKC would change each.
  const modelTexts: ModelTexts = {
    name: { ja: "ﾋﾞｰﾉ①号", en: "Vino ＸＬ，city", zh: "维诺（城市）！", ko: "비노！ 시티" },
    summary: { ja: "街乗り向け，軽い！", en: "Light ｃｉｔｙ scooter", zh: "城市踏板，轻便", ko: "가벼운 스쿠터，도시" },
    description: { ja: "ﾍﾙﾒｯﾄ付き。②人乗り不可", en: "Helmet included — one rider", zh: "附头盔。单人", ko: "헬멧 포함。1인" },
  };
  const typeNames: Texts = { ja: "電動ｱｼｽﾄ", en: "E‐bike！", zh: "电动助力车（新）", ko: "전기자전거，신규" };
  const classNames: Texts = { ja: "電動①日", en: "Ｅ-bike day", zh: "电动一日，", ko: "전기 하루！" };
  const cases: { sheet: Sheet; draft: NewDraft }[] = [
    {
      sheet: sheetA(),
      draft: {
        mode: "new",
        model: { modelId: "vino-e", typeId: "ebike", brand: "Yamaha", active: true, texts: modelTexts },
        rateClass: { new: { id: "ebike-city", group: "ebike", sort: 6, names: classNames } },
        prices: [{ packageId: "day-1", priceJpy: 4200 }],
        type: { depositJpy: 1000, sort: 4, names: typeNames },
        vehicle: { plate: "わ2301" },
      },
    },
    {
      // The same texts in other places, so a field cannot be filled from another field.
      sheet: sheetB(),
      draft: {
        mode: "new",
        model: {
          modelId: "vino-x",
          typeId: "scooter",
          brand: "Yamaha",
          engineCc: 49,
          active: true,
          texts: { name: modelTexts.description, summary: modelTexts.name, description: modelTexts.summary },
        },
        rateClass: { new: { id: "bike-49", group: "bike", sort: 1, names: typeNames } },
        prices: [{ packageId: "day-1", priceJpy: 2600 }],
        vehicle: { plate: "わ3401" },
      },
    },
  ];
  for (const { sheet, draft } of cases) {
    const label = `${sheet.label}, ${draft.model.modelId}`;
    const m = draft.model.texts;
    const modelCells = { ...localeCells("name", m.name), ...localeCells("summary", m.summary), ...localeCells("description", m.description) };
    const cls = (draft.rateClass as { new: NewClass }).new;

    const { script } = fake(sheet);
    assertClean(plain(script.call("addBikeCheck", draft)), `${label}: the real check`);
    const rows = proposed(script);
    assertRow(rows.Models?.[0], modelCells, `${label}: Models texts`);
    assertRow(rows.RateClasses?.[0], localeCells("name", cls.names), `${label}: RateClasses names`);
    if (draft.type) assertRow(rows.Types?.[0], localeCells("name", draft.type.names), `${label}: Types names`);

    const saved = fake(sheet).script;
    const result = plain(saved.call("addBikeSave", draft));
    assert.equal(result?.ok, true, `${label}: save: ${JSON.stringify(result)}`);
    assertRow(sheetRow(saved, "Models", rowOf(saved, "Models", draft.model.modelId)), modelCells, `${label}: written Models texts`);
    assertRow(
      sheetRow(saved, "RateClasses", rowOf(saved, "RateClasses", cls.id)),
      localeCells("name", cls.names),
      `${label}: written RateClasses names`,
    );
    if (draft.type) {
      assertRow(
        sheetRow(saved, "Types", rowOf(saved, "Types", draft.model.typeId)),
        localeCells("name", draft.type.names),
        `${label}: written Types names`,
      );
    }
  }
});

test("an e-bike leaves engine_cc blank", () => {
  const sheet = sheetB();
  const draft = (modelId: string, typeId: string, rateClassId: string, engineCc?: number): NewDraft => ({
    mode: "new",
    model: { modelId, typeId, brand: "Yamaha", engineCc, active: true, texts: texts(modelId) },
    rateClass: { id: rateClassId },
    vehicle: { plate: `わ-${modelId}` },
  });
  const cases: { draft: NewDraft; engineCc: string }[] = [
    { draft: draft("pas-with", "ebike", "ebike-day"), engineCc: "" },
    // A number left over from an earlier step of the panel still leaves the e-bike's cell blank.
    { draft: draft("pas-babby", "ebike", "ebike-day", 250), engineCc: "" },
    { draft: draft("jog-125", "scooter", "bike-50", 125), engineCc: "125" },
    { draft: draft("xsr-155", "motorcycle", "bike-250", 155), engineCc: "155" },
  ];
  for (const { draft: bike, engineCc } of cases) {
    const label = `${bike.model.modelId} (${bike.model.typeId})`;
    const { script } = fake(sheet);
    assertClean(plain(script.call("addBikeCheck", bike)), `${label}: the real check`);
    assert.equal(text(proposed(script).Models?.[0]?.engine_cc).trim(), engineCc, `${label}: engine_cc proposed`);

    const saved = fake(sheet).script;
    const result = plain(saved.call("addBikeSave", bike));
    assert.equal(result?.ok, true, `${label}: save: ${JSON.stringify(result)}`);
    const row = sheetRow(saved, "Models", rowOf(saved, "Models", bike.model.modelId));
    assert.equal(text(row.engine_cc).trim(), engineCc, `${label}: engine_cc written`);
  }
});

test("sort defaults to one past the tab's highest", () => {
  // Sheet A has no ebike type, sheet B no car type; each draft adds a type, a class and a model.
  const cases: { sheet: Sheet; typeId: string; group: string; packageId: string; engineCc?: number }[] = [
    { sheet: sheetA(), typeId: "ebike", group: "ebike", packageId: "day-1" },
    { sheet: sheetB(), typeId: "car", group: "car", packageId: "day-2", engineCc: 1000 },
  ];
  for (const { sheet, typeId, group, packageId, engineCc } of cases) {
    const label = sheet.label;
    const blank: NewDraft = {
      mode: "new",
      model: { modelId: `sorted-${typeId}`, typeId, brand: "Brand", engineCc, active: true, texts: texts("Sorted") },
      rateClass: { new: { id: `sorted-${group}`, group, names: names("Sorted") } },
      prices: [{ packageId, priceJpy: 5000 }],
      type: { depositJpy: 3000, names: names("Sorted") },
      vehicle: { plate: `わ-sorted-${typeId}` },
    };
    const expected = {
      Types: highestSort(sheet, "Types") + 1,
      RateClasses: highestSort(sheet, "RateClasses") + 1,
      Models: highestSort(sheet, "Models") + 1,
    };
    const { script } = fake(sheet);
    assertClean(plain(script.call("addBikeCheck", blank)), `${label}: the real check`);
    const rows = proposed(script);
    for (const tab of ["Types", "RateClasses", "Models"] as const) {
      assert.equal(text(rows[tab]?.[0]?.sort), String(expected[tab]), `${label}: ${tab} sort is one past ${expected[tab] - 1}`);
    }

    // A sort the draft gives, 0 too, is kept.
    const given: NewDraft = {
      ...blank,
      model: { ...blank.model, sort: 0 },
      rateClass: { new: { ...(blank.rateClass as { new: NewClass }).new, sort: 2 } },
      type: { ...(blank.type as NonNullable<NewDraft["type"]>), sort: 1 },
    };
    const again = fake(sheet).script;
    again.call("addBikeCheck", given);
    const givenRows = proposed(again);
    assert.equal(text(givenRows.Models?.[0]?.sort), "0", `${label}: a model sort of 0 is kept`);
    assert.equal(text(givenRows.RateClasses?.[0]?.sort), "2", `${label}: the class sort is kept`);
    assert.equal(text(givenRows.Types?.[0]?.sort), "1", `${label}: the type sort is kept`);
  }
});

test("addBikeOptions lists types with their deposit, classes with their prices and the packages", () => {
  const blankOr = (value: unknown) => (value === undefined || value === null || value === "" ? null : Number(value));
  const records = (grid: unknown[][]) => {
    const [header, ...rows] = grid;
    return rows
      .filter((cells) => cells.some((cell) => cell !== "" && cell !== undefined))
      .map((cells) => Object.fromEntries(header.map((name, i) => [String(name), cells[i] ?? ""])));
  };

  for (const sheet of [sheetA(), sheetB()]) {
    const label = sheet.label;
    // Expected, read from the fixture grids by the plain header names.
    const typeRows = records(sheet.tabs.Types);
    const expectedTypes = ["scooter", "motorcycle", "car", "ebike"]
      .map((id) => {
        const row = typeRows.find((cells) => cells.type_id === id);
        return row === undefined ? { id, hasRow: false } : { id, depositJpy: Number(row.deposit_jpy), hasRow: true };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const priceRows = records(sheet.tabs.Prices);
    const expectedClasses = records(sheet.tabs.RateClasses)
      .map((cells) => ({
        id: String(cells.rate_class_id),
        group: String(cells.group),
        nameJa: String(cells.name_ja),
        prices: priceRows
          .filter((price) => price.rate_class_id === cells.rate_class_id)
          .map((price) => ({
            packageId: String(price.package_id),
            priceJpy: Number(price.price_jpy),
            advancePriceJpy: blankOr(price.advance_price_jpy),
          }))
          .sort((a, b) => a.packageId.localeCompare(b.packageId)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const expectedPackages = records(sheet.tabs.Packages)
      .map((cells) => ({
        id: String(cells.package_id),
        nameJa: String(cells.name_ja),
        days: blankOr(cells.days),
        hours: blankOr(cells.hours),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const { script } = fake(sheet);
    const options = plain(script.call("addBikeOptions"));
    assert.equal(options?.ok, true, `${label}: ${JSON.stringify(options)}`);

    assert.ok(Array.isArray(options.types), `${label}: types is a list: ${JSON.stringify(options)}`);
    const types = options.types
      .map((type: Record<string, unknown>) =>
        type.hasRow === true
          ? { id: String(type.id), depositJpy: Number(type.depositJpy), hasRow: true }
          : { id: String(type.id), hasRow: type.hasRow },
      )
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
    assert.deepEqual(types, expectedTypes, `${label}: the four types, each with its deposit or without a row`);

    assert.ok(Array.isArray(options.rateClasses), `${label}: rateClasses is a list`);
    const classes = options.rateClasses
      .map((cls: Record<string, any>) => ({
        id: String(cls.id),
        group: String(cls.group),
        nameJa: String(cls.nameJa),
        prices: (Array.isArray(cls.prices) ? cls.prices : [])
          .map((price: Record<string, unknown>) => ({
            packageId: String(price.packageId),
            priceJpy: Number(price.priceJpy),
            advancePriceJpy: blankOr(price.advancePriceJpy),
          }))
          .sort((a: { packageId: string }, b: { packageId: string }) => a.packageId.localeCompare(b.packageId)),
      }))
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
    assert.deepEqual(classes, expectedClasses, `${label}: every class with its group, Japanese name and prices`);

    assert.ok(Array.isArray(options.packages), `${label}: packages is a list`);
    const packages = options.packages
      .map((pkg: Record<string, unknown>) => ({
        id: String(pkg.id),
        nameJa: String(pkg.nameJa),
        days: blankOr(pkg.days),
        hours: blankOr(pkg.hours),
      }))
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
    assert.deepEqual(packages, expectedPackages, `${label}: every package with its days or hours`);

    assert.deepEqual(script.fetches, [], `${label}: the options come from the sheet`);
    for (const tab of ["Types", "RateClasses", "Prices", "Packages", "Models", "Vehicles"]) {
      assert.deepEqual(script.tabs.get(tab)?.touches, [], `${label}: nothing wrote to ${tab}`);
    }
  }
});

test("save writes the rows in dependency order and answers each row's publish_status", async () => {
  const cases: { sheet: Sheet; draft: NewDraft; version: number; statuses: Record<string, string> }[] = [
    {
      sheet: sheetA(),
      draft: {
        mode: "new",
        model: { modelId: "e-cruiser", typeId: "ebike", brand: "Panasonic", active: true, texts: texts("イークルーザー") },
        rateClass: { new: { id: "ebike", group: "ebike", sort: 5, names: names("電動") } },
        prices: [
          { packageId: "day-1", priceJpy: 4500, advancePriceJpy: 4000 },
          { packageId: "day-3", priceJpy: 12000 },
        ],
        type: { depositJpy: 2000, names: names("E-bike") },
        vehicle: { plate: "わ2401", odometerKm: 12 },
      },
      version: 413,
      statuses: {
        "Types:ebike": "ok",
        "RateClasses:ebike": "warning: extension_per_hour_jpy blank",
        "Prices:ebike/day-1": "ok",
        "Prices:ebike/day-3": "warning: no advance price",
        "Models:e-cruiser": "warning: photos missing",
        "Vehicles:わ2401": "公開済み",
      },
    },
    {
      sheet: sheetB(),
      draft: {
        mode: "new",
        model: { modelId: "sienta", typeId: "car", brand: "Toyota", engineCc: 1490, seats: 7, active: true, texts: texts("シエンタ") },
        rateClass: { new: { id: "car-m", group: "car", names: names("普通車") } },
        prices: [
          { packageId: "day-2", priceJpy: 18500, advancePriceJpy: 17000 },
          { packageId: "hours-4", priceJpy: 6000 },
        ],
        type: { depositJpy: 15000, names: names("Car") },
        vehicle: { plate: "沖縄 な 90-12" },
      },
      version: 1310,
      statuses: {
        "Types:car": "warning: name_zh blank",
        "RateClasses:car-m": "ok",
        "Prices:car-m/day-2": "ok",
        "Prices:car-m/hours-4": "ok: 2",
        "Models:sienta": "ok",
        "Vehicles:沖縄 な 90-12": "warning: odometer_km",
      },
    },
  ];

  for (const { sheet, draft, version, statuses } of cases) {
    const label = `${sheet.label}, ${draft.model.modelId}`;
    const { script, publishSawRows } = fake(sheet, { statuses, version });
    const result = plain(script.call("addBikeSave", draft));

    assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);
    assert.ok(publishSawRows(), `${label}: every new row was in the sheet when Publish ran`);

    // Every check call carries all the rows at once.
    const checks = checkCalls(script);
    assert.ok(checks.length >= 1, `${label}: the save checks`);
    for (const call of checks) {
      assert.deepEqual(Object.keys(rowsOf(call)).sort(), [...ORDER].sort(), `${label}: one check gets every tab's rows`);
      assert.equal(rowsOf(call).Prices.length, 2, `${label}: both Prices rows in the same check`);
    }
    const verified = await verifyEnvelope(SECRET, String(checks.at(-1)?.payload), Date.now());
    assert.equal(verified.ok, true, `${label}: the check is signed`);

    // The answer lists each new row in dependency order, with the status Publish wrote.
    assert.ok(Array.isArray(result.written), `${label}: written is a list`);
    assert.deepEqual(
      result.written.map((entry: { tab: string }) => entry.tab),
      ["Types", "RateClasses", "Prices", "Prices", "Models", "Vehicles"],
      `${label}: in the order Types, RateClasses, Prices, Models, Vehicles`,
    );
    const expected = Object.entries(statuses)
      .map(([name, status]) => {
        const tab = name.slice(0, name.indexOf(":")) as NewTab;
        const row = rowOf(script, tab, name.slice(name.indexOf(":") + 1));
        assert.ok(row > sheet.tabs[tab].length, `${label}: ${name} is below the tab's rows`);
        return { tab, row, status };
      })
      .sort((a, b) => `${a.tab}${a.row}`.localeCompare(`${b.tab}${b.row}`));
    const written = [...result.written].sort((a: { tab: string; row: number }, b: { tab: string; row: number }) =>
      `${a.tab}${a.row}`.localeCompare(`${b.tab}${b.row}`),
    );
    assert.deepEqual(written, expected, `${label}: each row's sheet number and publish_status`);
    for (const tab of ORDER) {
      const added = Object.keys(statuses).filter((name) => name.startsWith(`${tab}:`)).length;
      assert.equal(script.tabs.get(tab)?.rows.length, sheet.tabs[tab].length + added, `${label}: ${added} ${tab} row(s) added`);
    }

    // One whole Publish, logged, and the lock free again.
    for (const path of PUBLISH_PATHS) {
      assert.equal(paths(script).filter((called) => called === path).length, 1, `${label}: ${path} once`);
    }
    assert.equal(result.publish?.version, version, `${label}: the version Publish made`);
    assert.equal((script.tabs.get("PublishLog")?.rows ?? []).length - 1, 1, `${label}: one PublishLog row`);
    assert.equal(script.lock.held(), false, `${label}: the lock is released`);
  }

  // A write that fails part way never leaves a model or a vehicle without the rows it depends on.
  const sheet = sheetA();
  delete sheet.tabs.Prices;
  const draft = cases[0].draft;
  const okRows = Object.fromEntries(ORDER.map((tab) => [tab, [{ level: "ok", messages: [] }]]));
  okRows.Prices = [
    { level: "ok", messages: [] },
    { level: "ok", messages: [] },
  ];
  const { script } = fake(sheet, { check: { fatal: [], rows: okRows } });
  let result: any;
  assert.doesNotThrow(() => {
    result = plain(script.call("addBikeSave", draft));
  });
  assert.equal(result?.ok, false, `Prices tab missing: ${JSON.stringify(result)}`);
  assertReadable(result.message ?? result.check?.message, "Prices tab missing");
  assertUnchanged(script, sheet, ["Models", "Vehicles"], "Prices tab missing");
  assert.deepEqual(paths(script).filter((path) => PUBLISH_PATHS.includes(path)), [], "Prices tab missing: no Publish");
  assert.equal(script.lock.held(), false, "Prices tab missing: the lock is released");
});

test("check errors come back per tab and row", () => {
  const sheet = sheetA();
  const draft: NewDraft = {
    mode: "new",
    model: { modelId: "nmax-155", typeId: "scooter", brand: "Yamaha", engineCc: 155, active: true, texts: texts("NMAX") },
    rateClass: { new: { id: "bike-155", group: "bike", names: names("155cc") } },
    prices: [
      { packageId: "day-1", priceJpy: 5600, advancePriceJpy: 5000 },
      // Above its own price: the columns are most likely swapped, an error on this row only.
      { packageId: "day-3", priceJpy: 12000, advancePriceJpy: 13000 },
    ],
    vehicle: { plate: "わ2501" },
  };
  const allTabs = ["Types", "RateClasses", "Prices", "Models", "Vehicles"];

  // The real check: the answer is per tab, one entry per proposed row, and the error sits on the second Prices row.
  const real = fake(sheet).script;
  const answer = plain(real.call("addBikeCheck", draft));
  assert.equal(answer?.ok, true, JSON.stringify(answer));
  const sent = proposed(real);
  for (const tab of Object.keys(sent)) {
    assert.equal(answer.rows[tab]?.length, sent[tab].length, `${tab}: one check per proposed row: ${JSON.stringify(answer.rows)}`);
  }
  const day1At = sent.Prices.findIndex((row) => row.package_id === "day-1");
  const day3At = sent.Prices.findIndex((row) => row.package_id === "day-3");
  assert.ok(day1At >= 0 && day3At >= 0, `both prices proposed: ${JSON.stringify(sent.Prices)}`);
  assert.equal(answer.rows.Prices[day3At]?.level, "error", `the day-3 price is an error: ${JSON.stringify(answer.rows.Prices)}`);
  assert.notEqual(answer.rows.Prices[day1At]?.level, "error", "the day-1 price is not");

  // A canned answer comes back to the panel as the Worker sent it, tab by tab and row by row.
  const canned = {
    fatal: [],
    rows: {
      Types: [{ level: "ok", messages: [] }],
      RateClasses: [{ level: "warning", messages: ["extension_per_hour_jpy: blank"] }],
      Prices: [
        { level: "ok", messages: [] },
        { level: "error", messages: ["advance_price_jpy: 13000 is above price_jpy 12000"] },
      ],
      Models: [{ level: "error", messages: ["model_id: nmax-155 is used twice"] }],
      Vehicles: [{ level: "ok", messages: [] }],
    },
  };
  const withType: NewDraft = {
    ...draft,
    model: { ...draft.model, typeId: "ebike", engineCc: undefined },
    rateClass: { new: { id: "ebike-155", group: "ebike", names: names("E") } },
    type: { depositJpy: 2000, names: names("E") },
  };
  for (const [label, body] of [
    ["the canned answer", draft],
    ["the canned answer, with a type", withType],
  ] as const) {
    const checked = fake(sheet, { check: canned }).script;
    assert.deepEqual(plain(checked.call("addBikeCheck", body)), { ok: true, ...canned }, label);

    // And the save refuses it: nothing written in any tab, no Publish.
    const saved = fake(sheet, { check: canned }).script;
    const result = plain(saved.call("addBikeSave", body));
    assert.equal(result?.ok, false, `${label}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.check, { ok: true, ...canned }, `${label}: the check, for staff`);
    assertUnchanged(saved, sheet, allTabs, label);
    assert.deepEqual(paths(saved).filter((path) => PUBLISH_PATHS.includes(path)), [], `${label}: no Publish`);
    assert.equal(saved.lock.held(), false, `${label}: the lock is free`);
  }

  // The real check's error stops the save too.
  const saved = fake(sheet).script;
  const result = plain(saved.call("addBikeSave", draft));
  assert.equal(result?.ok, false, `real check error: ${JSON.stringify(result)}`);
  assert.equal(result.check?.rows?.Prices?.some((row: { level: string }) => row.level === "error"), true, "the Prices error");
  assertUnchanged(saved, sheet, allTabs, "real check error");
});

test("a new model keeps ids, names and a plate of digits or date-like text as typed, and Publish reads them back", () => {
  type Case = { draft: NewDraft; typeNames?: Texts };
  const cases: Case[] = [
    {
      draft: {
        mode: "new",
        model: {
          modelId: "007",
          typeId: "motorcycle",
          brand: "0123",
          engineCc: 250,
          seats: 2,
          sort: 9,
          active: true,
          texts: { ...texts("007"), name: { ja: "0123", en: "2002", zh: "2027-07-15", ko: "TRUE" } },
        },
        rateClass: {
          new: { id: "0250", group: "bike", sort: 8, extensionPerHourJpy: 900, names: { ja: "0250", en: "250", zh: "09:30", ko: "FALSE" } },
        },
        prices: [
          { packageId: "day-1", priceJpy: 6000, advancePriceJpy: 5500 },
          { packageId: "day-3", priceJpy: 15000 },
        ],
        vehicle: { plate: "0042", odometerKm: 120, notes: "2027/07/15" },
      },
    },
    {
      // Sheet A has no ebike row in Types, so this one also adds a Types row.
      draft: {
        mode: "new",
        model: {
          modelId: "2027",
          typeId: "ebike",
          brand: "1,000",
          sort: 7,
          active: true,
          texts: { ...texts("2027"), name: { ja: "7/15/2027", en: "50%", zh: "-5", ko: "=1+1" } },
        },
        rateClass: { new: { id: "0001", group: "ebike", sort: 6, names: { ja: "0001", en: "1e3", zh: "3.50", ko: "true" } } },
        prices: [{ packageId: "day-1", priceJpy: 2500 }],
        type: { depositJpy: 2000, sort: 4, names: { ja: "0123", en: "2002", zh: "TRUE", ko: "09:30" } },
        vehicle: { plate: "1234", baseUsageDays: 2, notes: "FALSE" },
      },
      typeNames: { ja: "0123", en: "2002", zh: "TRUE", ko: "09:30" },
    },
  ];

  for (const { draft, typeNames } of cases) {
    const sheet = sheetA();
    const label = `model ${draft.model.modelId}`;
    const cls = (draft.rateClass as { new: NewClass }).new;
    const prices = draft.prices ?? [];
    const { script } = fake(sheet);
    const result = plain(script.call("addBikeSave", draft));
    assert.equal(result?.ok, true, `${label}: save: ${JSON.stringify(result)}`);

    /** The last `count` rows of a tab, keyed by header, as the sheet holds them. */
    const added = (tab: string, count = 1) => {
      const rows = script.tabs.get(tab)?.rows ?? [];
      assert.equal(rows.length, sheet.tabs[tab].length + count, `${label}: ${count} ${tab} rows added`);
      return Array.from({ length: count }, (_, i) => sheetRow(script, tab, sheet.tabs[tab].length + 1 + i));
    };
    const localized = (field: string, values: Texts) =>
      Object.fromEntries(LOCALES.map(([key, suffix]) => [`${field}_${suffix}`, values[key]]));
    const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((key) => [key, row[key]]));

    // Text as typed, numbers as numbers, in every tab the save wrote.
    const m = draft.model;
    const modelCells = {
      model_id: m.modelId,
      type_id: m.typeId,
      rate_class_id: cls.id,
      brand: m.brand,
      engine_cc: m.engineCc ?? "",
      seats: m.seats ?? "",
      sort: m.sort,
      active: true,
      ...localized("name", m.texts.name),
    };
    const [modelRow] = added("Models");
    assert.deepEqual(pick(modelRow, Object.keys(modelCells)), modelCells, `${label}: the Models row`);
    const classCells = {
      rate_class_id: cls.id,
      group: cls.group,
      sort: cls.sort,
      extension_per_hour_jpy: cls.extensionPerHourJpy ?? "",
      ...localized("name", cls.names),
    };
    const [classRow] = added("RateClasses");
    assert.deepEqual(pick(classRow, Object.keys(classCells)), classCells, `${label}: the RateClasses row`);
    const priceKeys = ["rate_class_id", "package_id", "price_jpy", "advance_price_jpy"];
    assert.deepEqual(
      byPackage(added("Prices", prices.length)).map((row) => pick(row, priceKeys)),
      byPackage(prices.map((p) => ({ rate_class_id: cls.id, package_id: p.packageId, price_jpy: p.priceJpy, advance_price_jpy: p.advancePriceJpy ?? "" }))),
      `${label}: the Prices rows`,
    );
    const { plate, odometerKm, baseUsageDays, notes } = draft.vehicle;
    const vehicleCells = { plate, model_id: m.modelId, status: "active", odometer_km: odometerKm ?? "", base_usage_days: baseUsageDays ?? "", notes };
    const [vehicleRow] = added("Vehicles");
    assert.deepEqual(pick(vehicleRow, Object.keys(vehicleCells)), vehicleCells, `${label}: the Vehicles row`);
    if (typeNames !== undefined && draft.type !== undefined) {
      const typeCells = { type_id: m.typeId, deposit_jpy: draft.type.depositJpy, sort: draft.type.sort, ...localized("name", typeNames) };
      const [typeRow] = added("Types");
      assert.deepEqual(pick(typeRow, Object.keys(typeCells)), typeCells, `${label}: the Types row`);
    }

    // Publish reads every tab through the Sheets API with the Worker's own validateCatalog, and gets what was typed.
    const read = validateCatalog(
      Object.fromEntries([...script.tabs.keys()].map((name) => [name, sheetsApiValues(script, name)])),
      Date.now(),
    );
    const newRows = new Set(["Models", "RateClasses", "Prices", "Vehicles", "Types"]);
    const errors = read.statuses.filter(
      (status) => newRows.has(status.tab) && status.row > sheet.tabs[status.tab].length && status.level === "error",
    );
    assert.deepEqual(errors, [], `${label}: the Worker takes every new row`);
    const model = read.catalog?.models.find((each) => each.id === m.modelId);
    assert.ok(model !== undefined, `${label}: Publish reads model ${m.modelId}: ${JSON.stringify(read.catalog?.models.map((each) => each.id))}`);
    assert.equal(model.brand, m.brand, `${label}: the brand read back`);
    assert.equal(model.rateClassId, cls.id, `${label}: the class read back`);
    assert.deepEqual(
      [model.texts.ja.name, model.texts.en.name, model.texts["zh-cn"].name, model.texts.ko.name],
      [m.texts.name.ja, m.texts.name.en, m.texts.name.zh, m.texts.name.ko],
      `${label}: the names read back`,
    );
    const rateClass = read.catalog?.rateClasses.find((each) => each.id === cls.id);
    assert.ok(rateClass !== undefined, `${label}: Publish reads class ${cls.id}`);
    assert.deepEqual(
      [rateClass.texts.ja.name, rateClass.texts.en.name, rateClass.texts["zh-cn"].name, rateClass.texts.ko.name],
      [cls.names.ja, cls.names.en, cls.names.zh, cls.names.ko],
      `${label}: the class names read back`,
    );
    assert.deepEqual(
      read.catalog?.prices.filter((price) => price.rateClassId === cls.id).sort((a, b) => a.packageId.localeCompare(b.packageId)),
      prices
        .map((p) => ({ rateClassId: cls.id, packageId: p.packageId, priceJpy: p.priceJpy, advancePriceJpy: p.advancePriceJpy ?? null }))
        .sort((a, b) => a.packageId.localeCompare(b.packageId)),
      `${label}: the prices read back`,
    );
    assert.deepEqual(
      read.catalog?.vehicles.find((each) => each.plate === plate),
      { plate, modelId: m.modelId, status: "active", odometerKm: odometerKm ?? null, baseUsageDays: baseUsageDays ?? 0 },
      `${label}: the vehicle read back`,
    );
    if (typeNames !== undefined) {
      const type = read.catalog?.vehicleTypes.find((each) => each.id === m.typeId);
      assert.deepEqual(
        [type?.texts.ja.name, type?.texts.en.name, type?.texts["zh-cn"].name, type?.texts.ko.name],
        [typeNames.ja, typeNames.en, typeNames.zh, typeNames.ko],
        `${label}: the type names read back`,
      );
    }
  }
});
