// The Add a reservation panel (apps-script/AddReservation.js and AddReservationPanel.html) run in node:vm against the fake
// Google services. The fake Worker answers in the shapes of /api/staff/catalog (staffCatalogView) and
// /api/staff/reservations, typed from their own modules so the fakes cannot drift from them. Signatures go through the
// Worker's real verifyEnvelope, and every expected value is written out here by hand, never taken from the script.
// Message text is free: tests look for facts in it (a status, a reason, the word publish), not for sentences. Node cannot
// run the panel's own script, so the HTML is held to the ticket by scanning it.
//
// Rulings these tests pin where the ticket is silent:
// - The form is the payload /api/staff/reservations reads, `{ id, modelId, packageId, date, time, locale, guest }`, with
//   the language as `locale`, since create sends the form as it stands.
// - Create answers `{ ok: true, booking }` with the Worker's booking fields as the Worker sent them (endAt in epoch ms,
//   which the panel shows in Japan time). Extra fields are free.
// - Only the refusals the ticket lists happen before the call. A guest field that is a string, blank or malformed, goes
//   to the Worker, which owns the guest check and answers INVALID_GUEST.
// - INVALID_GUEST's `fields` are the Worker's codes as sent, or the guest field each one names; either reads.
// - /api/staff/catalog has no package `active` flag, so a package is bookable when a kept model has a price for it.
// - Whether a kept model with no price at all stays in the options is left free: no fixture here has one.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { HoldReason } from "../src/lib/booking/holds.ts";
import { SHEET_TABS } from "../src/lib/catalog/sheet-schema.ts";
import type { GuestCode } from "../src/lib/checkout.ts";
import { verifyEnvelope } from "../src/lib/crypto.ts";
import type { StaffCatalog } from "../src/lib/staff/catalog-view.ts";
import { type AppsScriptWorld, loadAppsScript, type Options, type Reply, type Route } from "./helpers/apps-script.ts";
import { tagsIn } from "./helpers/html.ts";

const SCRIPT_DIR = new URL("../apps-script/", import.meta.url);

const BASE_URL = "https://reservation-one.example.dev";
const SECRET = "publish-secret-one";
const USER = "staff@okinawa-dream.example";
const PROPERTIES = { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: SECRET };

const CATALOG_PATH = "/api/staff/catalog";
const RESERVATIONS = "/api/staff/reservations";

// As in apps-script-publish.test.ts.
const STACK_TRACE = /\n\s+at\s|\.js:\d+|(Type|Reference|Syntax|Range)Error|Cannot read|\bundefined\b|\[object Object\]/;

const UUID_A = "5f0c2a8e-1b7d-4c3a-9e61-2d4b8f7a0c13";
const UUID_B = "9f3c1e2a-1111-4111-8111-000000000002";
const UUID_C = "c0ffee11-3333-4333-8333-000000000004";

// Values cross out of the script's realm with another Object prototype, which deepEqual refuses. A copy is plain.
const plain = (value: unknown): any => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------------------------------------------------------------
// The published catalogs, as /api/staff/catalog answers them.

type StaffModel = StaffCatalog["models"][number];
type StaffPackage = StaffCatalog["packages"][number];
type StaffPrice = StaffCatalog["prices"][number];

function model(id: string, nameJa: string, nameEn: string, active: boolean, plates: StaffModel["plates"]): StaffModel {
  const typeId = id.startsWith("jimny") || id.startsWith("nbox") ? "car" : "scooter";
  return { id, nameJa, nameEn, typeId, active, depositJpy: typeId === "car" ? 10000 : 3000, plates };
}

function pkg(id: string, nameJa: string, nameEn: string, days: number | null, hours: number | null): StaffPackage {
  return { id, nameJa, nameEn, days, hours };
}

function price(modelId: string, packageId: string, priceJpy: number, advancePriceJpy: number | null = null): StaffPrice {
  return { modelId, packageId, priceJpy, advancePriceJpy };
}

type Kept = { id: string; nameJa: string; nameEn: string };
type KeptPrice = { modelId: string; packageId: string; priceJpy: number };

type OptionCase = { label: string; catalog: StaffCatalog; models: Kept[]; packages: Kept[]; prices: KeptPrice[] };

/**
 * Catalog A: pcx-125 and jimny-660 are bookable. forza-250 has only plates in maintenance or retired, old-50 is inactive
 * though its plate is active, and nbox-660 has no plate at all. week-7 is priced only for dropped models, and hours-2
 * only for nbox-660, so both packages go too.
 */
const CATALOG_A: StaffCatalog = {
  ok: true,
  version: 412,
  models: [
    model("pcx-125", "ピーシーエックス", "PCX", true, [
      { plate: "わ1001", status: "active" },
      { plate: "わ1002", status: "maintenance" },
    ]),
    model("forza-250", "フォルツァ", "Forza", true, [
      { plate: "わ2001", status: "maintenance" },
      { plate: "わ2002", status: "retired" },
    ]),
    model("jimny-660", "ジムニー", "Jimny", true, [{ plate: "わ3003", status: "active" }]),
    model("old-50", "旧型", "Old 50", false, [{ plate: "わ5005", status: "active" }]),
    model("nbox-660", "エヌボックス", "N-BOX", true, []),
  ],
  packages: [
    pkg("day-1", "1日", "1 day", 1, null),
    pkg("hours-4", "4時間", "4 hours", null, 4),
    pkg("day-3", "3日", "3 days", 3, null),
    pkg("week-7", "1週間", "1 week", 7, null),
    pkg("hours-2", "2時間", "2 hours", null, 2),
  ],
  prices: [
    price("pcx-125", "day-1", 2500),
    price("pcx-125", "hours-4", 1500, 1300),
    price("forza-250", "day-1", 4000),
    price("forza-250", "week-7", 20000),
    price("jimny-660", "day-1", 8000),
    price("jimny-660", "day-3", 21000, 19000),
    price("old-50", "week-7", 9000),
    price("nbox-660", "hours-2", 3000),
  ],
  slots: ["09:00", "09:30", "10:00", "17:30"],
  config: { shopOpen: "09:00", shopClose: "18:00", slotMinutes: 30, minLeadHours: 2, maxDaysAhead: 365 },
};

/**
 * Catalog B, with nothing in common with A: cub-110 (one retired plate, one active) and today-50 are bookable,
 * rebel-250 is inactive, adv-160 has a plate in maintenance only. day-2 is priced for adv-160 too, and that price goes;
 * day-5 is priced only for dropped models.
 */
const CATALOG_B: StaffCatalog = {
  ok: true,
  version: 7,
  models: [
    model("cub-110", "スーパーカブ", "Super Cub 110", true, [
      { plate: "わ7001", status: "retired" },
      { plate: "わ7002", status: "active" },
    ]),
    model("rebel-250", "レブル250", "Rebel 250", false, [{ plate: "わ8001", status: "active" }]),
    model("today-50", "トゥデイ", "Today", true, [
      { plate: "わ9001", status: "active" },
      { plate: "わ9002", status: "active" },
    ]),
    model("adv-160", "エーディーブイ", "ADV160", true, [{ plate: "わ6001", status: "maintenance" }]),
  ],
  packages: [pkg("half-6", "6時間", "6 hours", null, 6), pkg("day-2", "2日", "2 days", 2, null), pkg("day-5", "5日", "5 days", 5, null)],
  prices: [
    price("cub-110", "half-6", 1800),
    price("cub-110", "day-2", 5200, 4800),
    price("rebel-250", "day-5", 15000),
    price("today-50", "half-6", 1200),
    price("adv-160", "day-5", 16000),
    price("adv-160", "day-2", 6000),
  ],
  slots: ["10:00", "11:00", "12:00", "16:00"],
  config: { shopOpen: "10:00", shopClose: "17:00", slotMinutes: 60, minLeadHours: 0, maxDaysAhead: 90 },
};

const OPTION_CASES: OptionCase[] = [
  {
    label: "catalog A",
    catalog: CATALOG_A,
    models: [
      { id: "pcx-125", nameJa: "ピーシーエックス", nameEn: "PCX" },
      { id: "jimny-660", nameJa: "ジムニー", nameEn: "Jimny" },
    ],
    packages: [
      { id: "day-1", nameJa: "1日", nameEn: "1 day" },
      { id: "hours-4", nameJa: "4時間", nameEn: "4 hours" },
      { id: "day-3", nameJa: "3日", nameEn: "3 days" },
    ],
    prices: [
      { modelId: "pcx-125", packageId: "day-1", priceJpy: 2500 },
      { modelId: "pcx-125", packageId: "hours-4", priceJpy: 1500 },
      { modelId: "jimny-660", packageId: "day-1", priceJpy: 8000 },
      { modelId: "jimny-660", packageId: "day-3", priceJpy: 21000 },
    ],
  },
  {
    label: "catalog B",
    catalog: CATALOG_B,
    models: [
      { id: "cub-110", nameJa: "スーパーカブ", nameEn: "Super Cub 110" },
      { id: "today-50", nameJa: "トゥデイ", nameEn: "Today" },
    ],
    packages: [
      { id: "half-6", nameJa: "6時間", nameEn: "6 hours" },
      { id: "day-2", nameJa: "2日", nameEn: "2 days" },
    ],
    prices: [
      { modelId: "cub-110", packageId: "half-6", priceJpy: 1800 },
      { modelId: "cub-110", packageId: "day-2", priceJpy: 5200 },
      { modelId: "today-50", packageId: "half-6", priceJpy: 1200 },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// Forms and the bookings the Worker answers for them.

type Guest = { familyName: string; givenName: string; email: string; phone: string };
type Form = {
  id: string;
  modelId: string;
  packageId: string;
  date: string;
  time: string;
  locale: string;
  guest: Guest;
  requestedBy?: string;
};

/** The booking /api/staff/reservations answers: result.booking with vehiclePlate as `plate`. */
type Booking = {
  id: string;
  ref: string;
  modelId: string;
  packageId: string;
  plate: string;
  startAt: number;
  endAt: number;
  priceJpy: number;
  depositJpy: number;
};

const FORM: Form = {
  id: UUID_A,
  modelId: "pcx-125",
  packageId: "day-1",
  date: "2027-07-15",
  time: "09:30",
  locale: "ja",
  guest: { familyName: "比嘉", givenName: "花子", email: "hanako@example.jp", phone: "090-1234-5678" },
};

// 09:30 in Japan is 00:30 UTC, and the day package returns at 18:00 in Japan, 09:00 UTC.
const BOOKING: Booking = {
  id: UUID_A,
  ref: "7K2MQ9XA",
  modelId: "pcx-125",
  packageId: "day-1",
  plate: "わ1001",
  startAt: Date.UTC(2027, 6, 15, 0, 30),
  endAt: Date.UTC(2027, 6, 15, 9, 0),
  priceJpy: 2500,
  depositJpy: 3000,
};

const booked = (booking: Booking): Reply => ({ body: { ok: true, booking } });

const TABS = {
  Bookings: [[...SHEET_TABS.Bookings]],
  PublishLog: [[...SHEET_TABS.PublishLog]],
};

type World = Omit<Options, "tabs" | "routes"> & { catalog?: unknown; routes?: Record<string, Route> };

function world({ catalog = CATALOG_A, routes = {}, ...rest }: World = {}): AppsScriptWorld {
  return loadAppsScript({
    properties: PROPERTIES,
    user: USER,
    ...rest,
    tabs: structuredClone(TABS),
    routes: { [CATALOG_PATH]: { body: catalog }, [RESERVATIONS]: booked(BOOKING), ...routes },
  });
}

/** Each argument is a copy, so a script that changes the form it is given cannot change the next case's. */
function call(script: AppsScriptWorld, name: string, ...args: unknown[]) {
  assert.ok(script.isFunction(name), `${name} is a global function`);
  return plain(script.call(name, ...args.map((arg) => structuredClone(arg))));
}

/** `{ ok: false, message }` with a reason for staff, not a stack trace. */
function assertRefused(answer: unknown, what: string): string {
  const { ok, message } = (answer ?? {}) as { ok?: unknown; message?: unknown };
  assert.equal(ok, false, `${what}: ${JSON.stringify(answer)}`);
  assert.equal(typeof message, "string", `${what}: a message for staff: ${JSON.stringify(answer)}`);
  assert.notEqual(String(message).trim(), "", `${what}: a message for staff`);
  assert.doesNotMatch(String(message), STACK_TRACE, `${what}: ${message}`);
  assert.ok(!String(message).includes(SECRET), `${what}: the secret stays out`);
  return String(message);
}

function paths(script: AppsScriptWorld, path: string): number {
  return script.fetches.filter((fetched) => fetched.path === path).length;
}

async function signedPayloads(script: AppsScriptWorld, path: string): Promise<unknown[]> {
  const payloads: unknown[] = [];
  for (const fetched of script.fetches.filter((each) => each.path === path)) {
    assert.equal(fetched.url, `${BASE_URL}${path}`);
    assert.equal(String(fetched.method).toLowerCase(), "post");
    const verified = await verifyEnvelope(SECRET, String(fetched.payload), Date.now());
    assert.ok(verified.ok, `${path}: ${JSON.stringify(verified)}`);
    payloads.push(verified.payload);
  }
  return payloads;
}

/** The guest's phone and email go only to the Worker: no tab is written, made or changed from here. */
function assertSheetUntouched(script: AppsScriptWorld, what: string): void {
  assert.deepEqual(script.inserted, [], `${what}: no tab is made`);
  for (const [name, rows] of Object.entries(TABS)) {
    assert.deepEqual(script.tabs.get(name)?.touches, [], `${what}: nothing wrote to ${name}`);
    assert.deepEqual(script.tabs.get(name)?.rows, rows, `${what}: ${name} is as it was`);
  }
}

function withoutComments(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function panelFile(name: string): string {
  assert.ok(existsSync(new URL(name, SCRIPT_DIR)), `apps-script/${name} exists`);
  const text = readFileSync(new URL(name, SCRIPT_DIR), "utf8");
  assert.notEqual(text.trim(), "", `${name} has content`);
  return text;
}

function callServerNames(code: string): string[] {
  return Array.from(code.matchAll(/\bcallServer\s*\(\s*(["'`])([^"'`]*)\1/g), (match) => match[2]);
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byPair = (a: KeptPrice, b: KeptPrice) =>
  `${a.modelId}/${a.packageId}` < `${b.modelId}/${b.packageId}` ? -1 : 1;

// ---------------------------------------------------------------------------------------------------------------------

test("Add a reservation is a dashboard action that opens the AddReservation dialog", () => {
  const script = world();
  const actions = script.evaluate("DASHBOARD_ACTIONS_") as { label: string; fn: string }[];
  assert.deepEqual(
    actions.filter(({ fn, label }) => fn === "openAddReservation" || label === "Add a reservation"),
    [{ label: "Add a reservation", fn: "openAddReservation" }],
    `one Add a reservation action: ${JSON.stringify(actions)}`,
  );
  for (const fn of ["openAddBike", "openBlockBike"]) {
    assert.ok(actions.some((action) => action.fn === fn), `${fn} stays on the list: ${JSON.stringify(actions)}`);
  }

  script.call("onOpen");
  const items = script.menus.flatMap((menu) => menu.items);
  assert.ok(
    items.some((item) => Array.isArray(item) && item[0] === "Add a reservation" && item[1] === "openAddReservation"),
    `the menu lists Add a reservation: ${JSON.stringify(items)}`,
  );
  const home = plain(script.call("dashboardHome")) as { actions: { label: string; fn: string }[] };
  assert.ok(
    home.actions.some(({ label, fn }) => label === "Add a reservation" && fn === "openAddReservation"),
    `the home lists Add a reservation: ${JSON.stringify(home.actions)}`,
  );

  const opened = world();
  assert.ok(opened.isFunction("openAddReservation"), "openAddReservation is a global function");
  opened.call("openAddReservation");
  assert.equal(opened.shown.length, 1, "one dialog");
  const [shown] = opened.shown;
  assert.equal(shown.kind, "modal");
  assert.equal(shown.title, "Add a reservation");
  assert.equal(shown.width, 720);
  assert.equal(shown.height, 640);
  const shell = panelFile("PanelShell.html");
  const at = shown.html.indexOf(shell);
  assert.ok(at >= 0, "the dialog holds PanelShell.html");
  assert.ok(shown.html.indexOf(panelFile("AddReservationPanel.html"), at + shell.length) >= 0, "then AddReservationPanel.html");
  assert.deepEqual(opened.fetches, [], "opening the dialog sends nothing");
  assertSheetUntouched(opened, "opening the dialog");

  // The panel reads its choices, draws its id and creates through the public functions.
  const called = callServerNames(withoutComments(panelFile("AddReservationPanel.html")));
  for (const fn of ["reservationPanelOptions", "reservationPanelNewId", "reservationPanelCreate"]) {
    assert.ok(called.includes(fn), `AddReservationPanel.html calls ${fn}: ${JSON.stringify(called)}`);
  }
});

test("options keep the bookable models and packages of the published catalog", async () => {
  for (const { label, catalog, models, packages, prices } of OPTION_CASES) {
    const script = world({ catalog });
    const answer = call(script, "reservationPanelOptions");
    assert.equal(answer?.ok, true, `${label}: ${JSON.stringify(answer)}`);
    for (const field of ["models", "packages", "prices", "slots"]) {
      assert.ok(Array.isArray(answer[field]), `${label}: ${field} is a list: ${JSON.stringify(answer)}`);
    }

    // Active models with at least one active plate, each with its names.
    const keptModels = (answer.models as Kept[]).map(({ id, nameJa, nameEn }) => ({ id, nameJa, nameEn }));
    assert.deepEqual(keptModels.sort(byId), [...models].sort(byId), `${label}: the bookable models`);

    // The packages a kept model has a price for, each with its names.
    const keptPackages = (answer.packages as Kept[]).map(({ id, nameJa, nameEn }) => ({ id, nameJa, nameEn }));
    assert.deepEqual(keptPackages.sort(byId), [...packages].sort(byId), `${label}: the packages a kept model is priced for`);

    // Each kept model's prices, and no price of a dropped model.
    const keptPrices = (answer.prices as KeptPrice[]).map(({ modelId, packageId, priceJpy }) => ({ modelId, packageId, priceJpy }));
    assert.deepEqual(keptPrices.sort(byPair), [...prices].sort(byPair), `${label}: the prices of the kept models`);

    assert.deepEqual(answer.slots, catalog.slots, `${label}: the slots`);
    assert.deepEqual(answer.config, catalog.config, `${label}: the shop config`);

    assert.equal(paths(script, CATALOG_PATH), 1, `${label}: one catalog read`);
    assert.equal(paths(script, RESERVATIONS), 0, `${label}: nothing is booked`);
    assert.deepEqual(await signedPayloads(script, CATALOG_PATH), [{ requestedBy: USER }], label);
    assertSheetUntouched(script, label);
  }

  // Not published yet, or no answer: `{ ok: false, message }` with what staff need to know.
  const failures: { label: string; properties?: Record<string, string>; reply: Reply; says: RegExp; requests: number }[] = [
    { label: "NOT_PUBLISHED", reply: { body: { ok: false, reason: "NOT_PUBLISHED" } }, says: /publish/i, requests: 1 },
    { label: "a 401", reply: { status: 401, body: { error: "unauthorized" } }, says: /(?<!\d)401(?!\d)/, requests: 1 },
    { label: "a 500", reply: { status: 500, body: "Publishing is not set up on the Worker" }, says: /(?<!\d)500(?!\d)/, requests: 1 },
    { label: "a thrown fetch", reply: { throws: "Address unavailable: reservation-one.example.dev" }, says: /\S/, requests: 1 },
    { label: "no Script Properties", properties: {}, reply: { body: CATALOG_A }, says: /WORKER_BASE_URL/, requests: 0 },
  ];
  for (const { label, properties, reply, says, requests } of failures) {
    const script = world({ ...(properties === undefined ? {} : { properties }), routes: { [CATALOG_PATH]: reply } });
    const message = assertRefused(call(script, "reservationPanelOptions"), label);
    assert.match(message, says, `${label}: ${message}`);
    assert.equal(script.fetches.length, requests, `${label}: ${requests} requests`);
    assertSheetUntouched(script, label);
  }
});

test("create sends the form signed to /api/staff/reservations with requestedBy and answers the booking", async () => {
  const cases: { label: string; form: Form; booking: Booking }[] = [
    { label: "a Japanese guest with an email", form: FORM, booking: BOOKING },
    {
      label: "an English guest who gave no email",
      form: {
        id: UUID_B,
        modelId: "jimny-660",
        packageId: "day-3",
        date: "2027-12-30",
        time: "17:30",
        locale: "en",
        guest: { familyName: "Smith", givenName: "John", email: "", phone: "+1 555 0100" },
      },
      booking: {
        id: UUID_B,
        ref: "B3TZ8VWN",
        modelId: "jimny-660",
        packageId: "day-3",
        plate: "わ3003",
        startAt: Date.UTC(2027, 11, 30, 8, 30),
        endAt: Date.UTC(2028, 0, 1, 9, 0),
        priceJpy: 21000,
        depositJpy: 10000,
      },
    },
    {
      label: "a Chinese guest with full-width digits on 29 February",
      form: {
        id: "walk-in-2028-02-29-001",
        modelId: "cub-110",
        packageId: "half-6",
        date: "2028-02-29",
        time: "10:00",
        locale: "zh-cn",
        guest: { familyName: "王", givenName: "小明", email: "wang@example.cn", phone: "１３８００１３８０００" },
      },
      booking: {
        id: "walk-in-2028-02-29-001",
        ref: "P3Y2F7BV",
        modelId: "cub-110",
        packageId: "half-6",
        plate: "わ7002",
        startAt: Date.UTC(2028, 1, 29, 1, 0),
        endAt: Date.UTC(2028, 1, 29, 7, 0),
        priceJpy: 1800,
        depositJpy: 3000,
      },
    },
    // The signed requestedBy is the signed-in user's, whatever the form says.
    {
      label: "a Korean guest on a form that names another user",
      form: {
        id: UUID_C,
        modelId: "today-50",
        packageId: "half-6",
        date: "2027-03-01",
        time: "16:00",
        locale: "ko",
        guest: { familyName: "김", givenName: "민수", email: "minsu@example.kr", phone: "010-1234-5678" },
        requestedBy: "someone-else@example.com",
      },
      booking: {
        id: UUID_C,
        ref: "Q8RW4KTD",
        modelId: "today-50",
        packageId: "half-6",
        plate: "わ9002",
        startAt: Date.UTC(2027, 2, 1, 7, 0),
        endAt: Date.UTC(2027, 2, 1, 13, 0),
        priceJpy: 1200,
        depositJpy: 3000,
      },
    },
  ];
  for (const { label, form, booking } of cases) {
    const script = world({ routes: { [RESERVATIONS]: booked(booking) } });
    const answer = call(script, "reservationPanelCreate", form);

    assert.equal(answer?.ok, true, `${label}: ${JSON.stringify(answer)}`);
    assert.equal(typeof answer.booking, "object", `${label}: the booking: ${JSON.stringify(answer)}`);
    for (const [field, value] of Object.entries(booking)) {
      assert.deepEqual(answer.booking?.[field], value, `${label}: the booking's ${field}`);
    }

    assert.equal(paths(script, RESERVATIONS), 1, `${label}: one booking request`);
    assert.deepEqual(
      await signedPayloads(script, RESERVATIONS),
      [{ ...form, requestedBy: USER }],
      `${label}: the form as given, signed, with the signed-in user`,
    );
    assertSheetUntouched(script, label);
  }
});

test("each new form gets a new id and create sends the id it is given", async () => {
  // Each new form draws its id from Utilities.getUuid, and asks nothing of the Worker.
  for (const uuids of [[UUID_A, UUID_B, UUID_C], [UUID_C, UUID_A, UUID_B], []]) {
    const script = world({ uuids });
    const drawn = [1, 2, 3].map(() => call(script, "reservationPanelNewId"));
    const expected = uuids.length > 0 ? uuids : ["uuid-1", "uuid-2", "uuid-3"];
    assert.deepEqual(drawn, expected, `the ids Utilities.getUuid gives, in order: ${JSON.stringify(drawn)}`);
    assert.deepEqual(script.fetches, [], "a new id asks nothing of the Worker");
    assertSheetUntouched(script, "a new id");
  }

  // Create sends the id it is given and draws none: the next new form still gets the first uuid.
  for (const id of [UUID_B, "walk-in-0001", UUID_C.toUpperCase()]) {
    const script = world({ uuids: [UUID_A], routes: { [RESERVATIONS]: booked({ ...BOOKING, id }) } });
    const answer = call(script, "reservationPanelCreate", { ...FORM, id });
    assert.equal(answer?.ok, true, `${id}: ${JSON.stringify(answer)}`);
    assert.deepEqual(
      (await signedPayloads(script, RESERVATIONS)).map((payload) => (payload as Form).id),
      [id],
      `${id}: sent as given`,
    );
    assert.equal(call(script, "reservationPanelNewId"), UUID_A, `${id}: create drew no uuid`);
  }

  // One form's retries, after a timeout and a 502, all go under its one id, and the replay answers the same booking.
  const script = world({
    uuids: [UUID_A, UUID_B],
    routes: {
      [RESERVATIONS]: [{ throws: "Timeout: https://reservation-one.example.dev" }, { status: 502, body: "Bad gateway" }, booked(BOOKING)],
    },
  });
  const id = call(script, "reservationPanelNewId");
  assert.equal(id, UUID_A);
  const form = { ...FORM, id };
  assertRefused(call(script, "reservationPanelCreate", form), "a timeout");
  assertRefused(call(script, "reservationPanelCreate", form), "a 502");
  const first = call(script, "reservationPanelCreate", form);
  const replay = call(script, "reservationPanelCreate", form);
  for (const answer of [first, replay]) {
    assert.equal(answer?.ok, true, JSON.stringify(answer));
    assert.equal(answer.booking?.ref, BOOKING.ref);
    assert.equal(answer.booking?.plate, BOOKING.plate);
  }
  const sent = (await signedPayloads(script, RESERVATIONS)) as Form[];
  assert.deepEqual(sent.map((payload) => payload.id), [UUID_A, UUID_A, UUID_A, UUID_A], "every retry under the one id");
  assert.deepEqual(sent, Array(4).fill({ ...form, requestedBy: USER }), "every retry sends the same form");

  // The next form gets a new id.
  const next = call(script, "reservationPanelNewId");
  assert.equal(next, UUID_B);
  assert.notEqual(next, id);
});

test("a form with no id, a bad date or time or an unknown language is refused without calling the Worker", async () => {
  const guest = FORM.guest;
  const refused: { label: string; form: unknown }[] = [
    { label: "no form", form: undefined },
    { label: "a null form", form: null },
    { label: "a form that is text", form: "比嘉 花子 pcx-125 2027-07-15 09:30" },
    { label: "a form that is a list", form: [FORM] },
    { label: "no id", form: { ...FORM, id: undefined } },
    { label: "a blank id", form: { ...FORM, id: "" } },
    { label: "a null id", form: { ...FORM, id: null } },
    { label: "an id that is a number", form: { ...FORM, id: 42 } },
    { label: "no date", form: { ...FORM, date: undefined } },
    { label: "a blank date", form: { ...FORM, date: "" } },
    { label: "a month without its zero", form: { ...FORM, date: "2027-7-15" } },
    { label: "a date with slashes", form: { ...FORM, date: "2027/07/15" } },
    { label: "a date day first", form: { ...FORM, date: "15-07-2027" } },
    { label: "a date with a time", form: { ...FORM, date: "2027-07-15T09:30" } },
    { label: "a date that is a number", form: { ...FORM, date: 20270715 } },
    { label: "no time", form: { ...FORM, time: undefined } },
    { label: "a blank time", form: { ...FORM, time: "" } },
    { label: "an hour without its zero", form: { ...FORM, time: "9:30" } },
    { label: "a time with seconds", form: { ...FORM, time: "09:30:00" } },
    { label: "a time without a colon", form: { ...FORM, time: "0930" } },
    { label: "a time in words", form: { ...FORM, time: "9am" } },
    { label: "a time that is a number", form: { ...FORM, time: 930 } },
    { label: "no language", form: { ...FORM, locale: undefined } },
    { label: "a blank language", form: { ...FORM, locale: "" } },
    { label: "French", form: { ...FORM, locale: "fr" } },
    { label: "zh without its region", form: { ...FORM, locale: "zh" } },
    { label: "zh-CN in capitals", form: { ...FORM, locale: "zh-CN" } },
    { label: "jp for Japanese", form: { ...FORM, locale: "jp" } },
    { label: "no guest", form: { ...FORM, guest: undefined } },
    { label: "a null guest", form: { ...FORM, guest: null } },
    { label: "a guest that is text", form: { ...FORM, guest: "比嘉 花子" } },
    { label: "a family name that is a number", form: { ...FORM, guest: { ...guest, familyName: 1 } } },
    { label: "no given name", form: { ...FORM, guest: { ...guest, givenName: undefined } } },
    { label: "a null email", form: { ...FORM, guest: { ...guest, email: null } } },
    { label: "a phone that is a number", form: { ...FORM, guest: { ...guest, phone: 9012345678 } } },
    { label: "a family name that is an object", form: { ...FORM, guest: { ...guest, familyName: { ja: "比嘉" } } } },
  ];
  for (const { label, form } of refused) {
    const script = world();
    assert.ok(script.isFunction("reservationPanelCreate"), "reservationPanelCreate is a global function");
    let answer: unknown;
    assert.doesNotThrow(() => {
      answer = plain(
        form === undefined ? script.call("reservationPanelCreate") : script.call("reservationPanelCreate", structuredClone(form)),
      );
    }, label);
    assertRefused(answer, label);
    assert.deepEqual(script.fetches, [], `${label}: the Worker is not called`);
    assertSheetUntouched(script, label);
  }

  // Every other form goes to the Worker as it stands: each language, a blank email (owner: optional), and guest text
  // that is blank or malformed, which the Worker checks and answers INVALID_GUEST for.
  const sent: { label: string; form: Form }[] = [
    ...["ja", "en", "zh-cn", "ko"].map((locale) => ({ label: `language ${locale}`, form: { ...FORM, locale } })),
    { label: "a blank email", form: { ...FORM, guest: { ...guest, email: "" } } },
    { label: "a blank family name", form: { ...FORM, guest: { ...guest, familyName: "" } } },
    { label: "a malformed email", form: { ...FORM, guest: { ...guest, email: "hanako@example..jp" } } },
    { label: "a phone with no digits", form: { ...FORM, guest: { ...guest, phone: "なし" } } },
    { label: "midnight on 29 February", form: { ...FORM, date: "2028-02-29", time: "00:00" } },
    { label: "the last slot of the year", form: { ...FORM, date: "2027-12-31", time: "23:30" } },
    { label: "a model the catalog does not have", form: { ...FORM, modelId: "nope-999" } },
  ];
  for (const { label, form } of sent) {
    const script = world();
    call(script, "reservationPanelCreate", form);
    assert.equal(paths(script, RESERVATIONS), 1, `${label}: sent to the Worker`);
    assert.deepEqual(await signedPayloads(script, RESERVATIONS), [{ ...form, requestedBy: USER }], `${label}: as given`);
  }
});

test("SOLD_OUT and INVALID_GUEST come back as readable messages with the fields", () => {
  // Every reason createStaffBooking answers, the pickup-window ones included. The panel shows whatever reason it gets.
  const reasons = [
    "SOLD_OUT",
    "UNKNOWN_MODEL",
    "UNKNOWN_PACKAGE",
    "NO_PRICE",
    "CONFLICT",
    "OUTSIDE_HOURS",
    "OFF_SLOT",
    "CLOSED_PICKUP",
    "RETURN_OUTSIDE_HOURS",
    "CLOSED_RETURN",
    "TOO_SOON",
    "TOO_FAR",
  ] as const satisfies readonly HoldReason[];
  const messages = new Map<string, string>();
  for (const reason of reasons) {
    const script = world({ routes: { [RESERVATIONS]: { body: { ok: false, reason } } } });
    const answer = call(script, "reservationPanelCreate", FORM);
    const message = assertRefused(answer, reason);
    assert.equal(answer.reason, reason, `${reason}: the reason comes back: ${JSON.stringify(answer)}`);
    assert.notEqual(message.trim(), reason, `${reason}: a sentence for staff, not the bare code`);
    messages.set(reason, message);
    assert.equal(paths(script, RESERVATIONS), 1, reason);
    assertSheetUntouched(script, reason);
  }
  assert.equal(new Set(messages.values()).size, reasons.length, `each reason reads its own way: ${JSON.stringify([...messages])}`);

  // A reason the panel has never heard of still shows, as the Worker named it.
  const later = world({ routes: { [RESERVATIONS]: { body: { ok: false, reason: "BIKE_RECALLED" } } } });
  const unknown = call(later, "reservationPanelCreate", FORM);
  assert.equal(unknown.reason, "BIKE_RECALLED");
  assert.ok(assertRefused(unknown, "an unknown reason").includes("BIKE_RECALLED"), JSON.stringify(unknown));

  // INVALID_GUEST comes back with the fields the Worker named, as its codes or as the guest fields they name.
  const FIELD_OF: Record<GuestCode, keyof Guest> = {
    FAMILY_NAME_EMPTY: "familyName",
    GIVEN_NAME_EMPTY: "givenName",
    EMAIL_MALFORMED: "email",
    PHONE_NO_DIGITS: "phone",
  };
  const fieldLists: GuestCode[][] = [
    ["FAMILY_NAME_EMPTY"],
    ["PHONE_NO_DIGITS"],
    ["GIVEN_NAME_EMPTY", "EMAIL_MALFORMED"],
    ["FAMILY_NAME_EMPTY", "GIVEN_NAME_EMPTY", "EMAIL_MALFORMED", "PHONE_NO_DIGITS"],
  ];
  for (const fields of fieldLists) {
    const what = `INVALID_GUEST ${fields.join(", ")}`;
    const script = world({ routes: { [RESERVATIONS]: { body: { ok: false, reason: "INVALID_GUEST", fields } } } });
    const answer = call(script, "reservationPanelCreate", { ...FORM, guest: { ...FORM.guest, familyName: "" } });
    assertRefused(answer, what);
    assert.equal(answer.reason, "INVALID_GUEST", what);
    assert.ok(Array.isArray(answer.fields), `${what}: the fields come back: ${JSON.stringify(answer)}`);
    const named = fields.map((code) => FIELD_OF[code]);
    assert.ok(
      JSON.stringify(answer.fields) === JSON.stringify(fields) || JSON.stringify(answer.fields) === JSON.stringify(named),
      `${what}: the fields the Worker named, ${JSON.stringify(fields)} or ${JSON.stringify(named)}: ${JSON.stringify(answer.fields)}`,
    );
  }

  // The Worker's own failures read too: a 400 for a shape it cannot read, a 401, a 500, no answer.
  const failures: { label: string; reply: Reply; says: RegExp }[] = [
    { label: "a 400", reply: { status: 400, body: "The reservation is not in the shape the Worker reads, so nothing was booked." }, says: /(?<!\d)400(?!\d)/ },
    { label: "a 401", reply: { status: 401, body: { error: "unauthorized" } }, says: /(?<!\d)401(?!\d)/ },
    { label: "a 500", reply: { status: 500, body: "Publishing is not set up on the Worker, so no reservation was made." }, says: /(?<!\d)500(?!\d)/ },
    { label: "a thrown fetch", reply: { throws: "Address unavailable: reservation-one.example.dev" }, says: /\S/ },
  ];
  for (const { label, reply, says } of failures) {
    const script = world({ routes: { [RESERVATIONS]: reply } });
    const message = assertRefused(call(script, "reservationPanelCreate", FORM), label);
    assert.match(message, says, `${label}: ${message}`);
    assert.equal(paths(script, RESERVATIONS), 1, `${label}: one request, no retry`);
    assertSheetUntouched(script, label);
  }
});

test("the panel asks for the guest, model, package and pickup, shows the booking and offers no plate", () => {
  const html = panelFile("AddReservationPanel.html");
  const code = withoutComments(html);

  // Step by step on the shell: guest, model, package, date and time, review, then the result.
  const steps = tagsIn(code).filter(({ attributes }) => "data-step" in attributes);
  assert.ok(steps.length >= 5, `a step-by-step panel: ${JSON.stringify(steps.map(({ attributes }) => attributes["data-step"]))}`);

  // It builds the form the Worker reads, offering exactly the four languages the Worker takes.
  for (const field of ["familyName", "givenName", "locale", "modelId", "packageId"]) {
    assert.match(code, new RegExp(`\\b${field}\\b`), `the form carries ${field}`);
  }
  for (const locale of ["ja", "en", "zh-cn", "ko"]) {
    assert.match(code, new RegExp(`(["'\`])${locale}\\1`), `the panel offers ${locale}`);
  }

  // The result reads the booking: its ref, plate, return time and the deposit to collect at the shop.
  for (const field of ["ref", "plate", "endAt", "depositJpy"]) {
    assert.match(code, new RegExp(`\\b${field}\\b`), `the result shows the booking's ${field}`);
  }

  // A blank email: the review says no confirmation email goes out. And a New reservation that draws a new id.
  assert.match(code, /confirmation e-?mail/i, "the review speaks of the confirmation email");
  assert.match(code, /new reservation/i, "a New reservation control");
  assert.ok(callServerNames(code).includes("reservationPanelNewId"), "a new form draws its id from reservationPanelNewId");

  // The Worker alone picks the bike: no control names a plate.
  const plateControls = tagsIn(code).filter(
    ({ name, attributes }) =>
      ["input", "select", "textarea"].includes(name) && /plate/i.test(`${attributes.id ?? ""} ${attributes.name ?? ""}`),
  );
  assert.deepEqual(plateControls, [], "no plate control");
});
