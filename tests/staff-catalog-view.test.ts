// What the staff panels of the Dashboard (#140) are offered: staffCatalogView over a published catalog. Expected values
// are literals written out by hand from tests/fixtures/sheet/valid-catalog.json and from the variant built below, never
// from the code under test or from pickupSlots.
//
// Rulings these tests pin where the ticket is silent:
// - `prices` has no order of its own: it is compared as a set, keyed by model and package.
// - Plates compare as plain strings. The plates here differ only in ASCII digits after the same kana, so a code-unit sort
//   and localeCompare agree on them.
// - Each entry has exactly the fields the ticket lists: nothing of a model's rate class, engine, photos or texts beyond
//   nameJa and nameEn.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublishedCatalog } from "../src/lib/db/catalog-store.ts";
import { staffCatalogView } from "../src/lib/staff/catalog-view.ts";
import type { Model, Package, Price, RateClass, ShopConfig, Vehicle, VehicleStatus } from "../src/lib/types.ts";
import {
  EBIKE_MODEL_ROW,
  EBIKE_RATE_CLASS,
  EBIKE_VEHICLE_TYPE,
  EBIKE_VEHICLES,
} from "./fixtures/sheet/ebike.ts";
import { expectedCatalog } from "./helpers/sheet-workbook.ts";

type Plate = { plate: string; status: VehicleStatus };
type ModelView = {
  id: string;
  nameJa: string;
  nameEn: string;
  typeId: string;
  active: boolean;
  depositJpy: number;
  plates: Plate[];
};
type PackageView = { id: string; nameJa: string; nameEn: string; days: number | null; hours: number | null };
type PriceView = { modelId: string; packageId: string; priceJpy: number; advancePriceJpy: number | null };

function published(version: number, catalog = expectedCatalog()): PublishedCatalog {
  return { ...catalog, version, publishedAt: 1_790_000_000_000 + version };
}

function names(ja: string, en: string, zh: string, ko: string) {
  return { ja: { name: ja }, en: { name: en }, "zh-cn": { name: zh }, ko: { name: ko } };
}

function modelTexts(ja: string, en: string, zh: string, ko: string): Model["texts"] {
  const text = (name: string) => ({ name, summary: `${name} summary`, description: `${name} description` });
  return { ja: text(ja), en: text(en), "zh-cn": text(zh), ko: text(ko) };
}

function sortedPrices(prices: PriceView[]): PriceView[] {
  return [...prices].sort((a, b) =>
    `${a.modelId}/${a.packageId}` < `${b.modelId}/${b.packageId}` ? -1 : 1,
  );
}

/** Rows for one model at `[packageId, priceJpy, advancePriceJpy?]`. */
function rowsOf(modelId: string, rows: [string, number, (number | null)?][]): PriceView[] {
  return rows.map(([packageId, priceJpy, advancePriceJpy = null]) => ({ modelId, packageId, priceJpy, advancePriceJpy }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The fixture as the ticket's example reads it.

const FIXTURE_MODELS: ModelView[] = [
  {
    id: "today-50",
    nameJa: "トゥデイ",
    nameEn: "Today",
    typeId: "scooter",
    active: true,
    depositJpy: 3000,
    plates: [{ plate: "わ1001", status: "active" }],
  },
  {
    id: "pcx-125",
    nameJa: "ピーシーエックス",
    nameEn: "PCX",
    typeId: "scooter",
    active: true,
    depositJpy: 3000,
    plates: [
      { plate: "わ1002", status: "active" },
      { plate: "わ1003", status: "maintenance" },
    ],
  },
  {
    id: "cub-110",
    nameJa: "カブ",
    nameEn: "Cub",
    typeId: "motorcycle",
    active: false,
    depositJpy: 5000,
    plates: [{ plate: "わ1004", status: "retired" }],
  },
  {
    id: "rebel-250",
    nameJa: "レブル",
    nameEn: "Rebel",
    typeId: "motorcycle",
    active: true,
    depositJpy: 5000,
    plates: [{ plate: "わ1005", status: "active" }],
  },
  {
    id: "nbox-660",
    nameJa: "エヌボックス",
    nameEn: "N-BOX",
    typeId: "car",
    active: true,
    depositJpy: 10000,
    plates: [{ plate: "わ1006", status: "active" }],
  },
];

const FIXTURE_PRICES: PriceView[] = [
  ...rowsOf("today-50", [["hours-6", 2500], ["day-1", 3500], ["day-3", 9000]]),
  ...rowsOf("pcx-125", [["hours-6", 3600], ["day-1", 5200], ["day-3", 13800]]),
  // Inactive, and still priced through its class: a block or a phone booking may name it.
  ...rowsOf("cub-110", [["hours-6", 3600], ["day-1", 5200], ["day-3", 13800]]),
  ...rowsOf("rebel-250", [["hours-6", 6100], ["day-1", 9100], ["day-3", 24700]]),
  // car-k prices no 6-hour package.
  ...rowsOf("nbox-660", [["day-1", 7300], ["day-3", 18900]]),
];

const FIXTURE_PACKAGES: PackageView[] = [
  { id: "hours-6", nameJa: "6時間", nameEn: "6 hours", days: null, hours: 6 },
  { id: "day-1", nameJa: "1日", nameEn: "1 day", days: 1, hours: null },
  { id: "day-3", nameJa: "3日", nameEn: "3 days", days: 3, hours: null },
];

/** 09:00 to 18:00 every 30 minutes, the last start a whole slot before closing. */
const FIXTURE_SLOTS = [
  "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00",
  "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
];

// ---------------------------------------------------------------------------------------------------------------------
// A second catalog, so nothing of the fixture can be special-cased: other deposits and sort orders, ties broken by id, an
// e-bike type with a deposit of 0, a class that prices one package only, a model with no vehicles, rows given in an order
// that is not the view's, advance prices, and other shop hours.

const BIKE_160: RateClass = {
  id: "bike-160",
  grp: "bike",
  sort: 6,
  extensionPerHourJpy: 800,
  texts: names("160cc", "160cc bike", "160cc摩托车", "160cc 오토바이"),
};

function variantCatalog(): PublishedCatalog {
  const base = expectedCatalog();
  const model = (id: string) => {
    const found = base.models.find((m) => m.id === id);
    assert.ok(found, id);
    return found;
  };
  const vehicle = (plate: string, modelId: string, status: VehicleStatus): Vehicle => ({
    plate,
    modelId,
    status,
    odometerKm: null,
    baseUsageDays: 0,
  });
  const pkg = (id: string, sort: number, length: { days: number; hours: null } | { days: null; hours: number }, ja: string, en: string): Package => ({
    id,
    sort,
    ...length,
    texts: names(ja, en, `${en} zh`, `${en} ko`),
  });
  const price = (rateClassId: string, packageId: string, priceJpy: number, advancePriceJpy: number | null = null): Price => ({
    rateClassId,
    packageId,
    priceJpy,
    advancePriceJpy,
  });

  const models: Model[] = [
    { ...model("cub-110"), sort: 0 },
    { ...model("nbox-660"), sort: 1 },
    // Ties with rebel-250 on sort, and comes first by id.
    {
      ...model("pcx-125"),
      id: "adv-160",
      sort: 2,
      rateClassId: "bike-160",
      texts: modelTexts("エーディーブイ", "ADV", "ADV踏板", "에이디브이"),
    },
    { ...model("rebel-250"), sort: 2 },
    // Ties with today-50 on sort, and comes first by id.
    { ...model("pcx-125"), sort: 3 },
    { ...model("today-50"), sort: 3 },
    EBIKE_MODEL_ROW,
    // Inactive, with no vehicles at all.
    {
      ...model("rebel-250"),
      id: "forza-250",
      sort: 9,
      active: false,
      texts: modelTexts("フォルツァ", "Forza", "佛沙", "포르자"),
    },
  ].reverse();

  return {
    ...base,
    config: {
      shopOpen: "08:30",
      shopClose: "17:00",
      slotMinutes: 45,
      turnaroundMinutes: 30,
      holdMinutes: 10,
      minLeadHours: 6,
      maxDaysAhead: 90,
      photoMaxMb: 8,
    },
    vehicleTypes: [
      ...base.vehicleTypes.map((type) => ({
        ...type,
        depositJpy: ({ scooter: 3500, motorcycle: 6000, car: 15000 } as Record<string, number>)[type.id],
      })),
      EBIKE_VEHICLE_TYPE,
    ],
    rateClasses: [...base.rateClasses, EBIKE_RATE_CLASS, BIKE_160],
    models,
    vehicles: [
      vehicle("わ1001", "today-50", "active"),
      vehicle("わ1007", "pcx-125", "retired"),
      vehicle("わ1003", "pcx-125", "maintenance"),
      vehicle("わ1002", "pcx-125", "active"),
      vehicle("わ0999", "pcx-125", "active"),
      vehicle("わ1004", "cub-110", "retired"),
      vehicle("わ1005", "rebel-250", "active"),
      vehicle("わ1006", "nbox-660", "maintenance"),
      vehicle("わ1010", "adv-160", "active"),
      { ...EBIKE_VEHICLES[1], status: "maintenance" },
      EBIKE_VEHICLES[0],
    ],
    packages: [
      pkg("hours-4", 4, { days: null, hours: 4 }, "4時間", "4 hours"),
      pkg("hours-6", 3, { days: null, hours: 6 }, "6時間", "6 hours"),
      pkg("day-3", 2, { days: 3, hours: null }, "3日", "3 days"),
      pkg("day-1", 1, { days: 1, hours: null }, "1日", "1 day"),
      pkg("day-7", 0, { days: 7, hours: null }, "7日", "7 days"),
    ],
    prices: [
      price("scooter-50", "hours-6", 2500),
      price("scooter-50", "day-1", 3500, 3000),
      price("scooter-50", "day-3", 9000),
      price("scooter-50", "hours-4", 1800),
      price("scooter-50", "day-7", 18000),
      price("bike-125", "hours-6", 3600),
      price("bike-125", "day-1", 5400, 4900),
      price("bike-125", "day-3", 13800),
      price("bike-400", "hours-6", 6100),
      price("bike-400", "day-1", 9100),
      price("bike-400", "day-3", 24700),
      price("bike-400", "hours-4", 4800),
      price("car-k", "day-1", 7300),
      price("car-k", "day-3", 18900),
      price("car-k", "day-7", 39000),
      price("ebike-std", "hours-6", 2500),
      price("ebike-std", "day-1", 4500),
      price("ebike-std", "day-3", 10000),
      price("bike-160", "day-1", 6000, 5500),
    ],
    version: 12,
    publishedAt: 1_790_000_000_012,
  };
}

const VARIANT_MODELS: ModelView[] = [
  {
    id: "cub-110",
    nameJa: "カブ",
    nameEn: "Cub",
    typeId: "motorcycle",
    active: false,
    depositJpy: 6000,
    plates: [{ plate: "わ1004", status: "retired" }],
  },
  {
    id: "nbox-660",
    nameJa: "エヌボックス",
    nameEn: "N-BOX",
    typeId: "car",
    active: true,
    depositJpy: 15000,
    plates: [{ plate: "わ1006", status: "maintenance" }],
  },
  {
    id: "adv-160",
    nameJa: "エーディーブイ",
    nameEn: "ADV",
    typeId: "scooter",
    active: true,
    depositJpy: 3500,
    plates: [{ plate: "わ1010", status: "active" }],
  },
  {
    id: "rebel-250",
    nameJa: "レブル",
    nameEn: "Rebel",
    typeId: "motorcycle",
    active: true,
    depositJpy: 6000,
    plates: [{ plate: "わ1005", status: "active" }],
  },
  {
    id: "pcx-125",
    nameJa: "ピーシーエックス",
    nameEn: "PCX",
    typeId: "scooter",
    active: true,
    depositJpy: 3500,
    plates: [
      { plate: "わ0999", status: "active" },
      { plate: "わ1002", status: "active" },
      { plate: "わ1003", status: "maintenance" },
      { plate: "わ1007", status: "retired" },
    ],
  },
  {
    id: "today-50",
    nameJa: "トゥデイ",
    nameEn: "Today",
    typeId: "scooter",
    active: true,
    depositJpy: 3500,
    plates: [{ plate: "わ1001", status: "active" }],
  },
  {
    id: "assist-26",
    nameJa: "アシスト26",
    nameEn: "Assist 26",
    typeId: "ebike",
    active: true,
    depositJpy: 0,
    plates: [
      { plate: "わ2001", status: "active" },
      { plate: "わ2002", status: "maintenance" },
    ],
  },
  {
    id: "forza-250",
    nameJa: "フォルツァ",
    nameEn: "Forza",
    typeId: "motorcycle",
    active: false,
    depositJpy: 6000,
    plates: [],
  },
];

const BIKE_125_ROWS: [string, number, (number | null)?][] = [["hours-6", 3600], ["day-1", 5400, 4900], ["day-3", 13800]];
const BIKE_400_ROWS: [string, number, (number | null)?][] = [
  ["hours-6", 6100],
  ["day-1", 9100],
  ["day-3", 24700],
  ["hours-4", 4800],
];

const VARIANT_PRICES: PriceView[] = [
  ...rowsOf("cub-110", BIKE_125_ROWS),
  ...rowsOf("nbox-660", [["day-1", 7300], ["day-3", 18900], ["day-7", 39000]]),
  ...rowsOf("adv-160", [["day-1", 6000, 5500]]),
  ...rowsOf("rebel-250", BIKE_400_ROWS),
  ...rowsOf("pcx-125", BIKE_125_ROWS),
  ...rowsOf("today-50", [["hours-6", 2500], ["day-1", 3500, 3000], ["day-3", 9000], ["hours-4", 1800], ["day-7", 18000]]),
  ...rowsOf("assist-26", [["hours-6", 2500], ["day-1", 4500], ["day-3", 10000]]),
  ...rowsOf("forza-250", BIKE_400_ROWS),
];

const VARIANT_PACKAGES: PackageView[] = [
  { id: "day-7", nameJa: "7日", nameEn: "7 days", days: 7, hours: null },
  { id: "day-1", nameJa: "1日", nameEn: "1 day", days: 1, hours: null },
  { id: "day-3", nameJa: "3日", nameEn: "3 days", days: 3, hours: null },
  { id: "hours-6", nameJa: "6時間", nameEn: "6 hours", days: null, hours: 6 },
  { id: "hours-4", nameJa: "4時間", nameEn: "4 hours", days: null, hours: 4 },
];

/** 08:30 to 17:00 every 45 minutes: 16:00 is the last start that leaves a whole slot, and 16:45 would not. */
const VARIANT_SLOTS = ["08:30", "09:15", "10:00", "10:45", "11:30", "12:15", "13:00", "13:45", "14:30", "15:15", "16:00"];

// ---------------------------------------------------------------------------------------------------------------------

test("the view lists each model with its deposit, plates and prices", () => {
  const view = staffCatalogView(published(7));
  assert.equal(view.ok, true);
  assert.equal(view.version, 7);
  assert.deepEqual(view.models, FIXTURE_MODELS);
  assert.deepEqual(sortedPrices(view.prices), sortedPrices(FIXTURE_PRICES));

  // The ticket's example, as it reads.
  const pcx = view.models.find((m: ModelView) => m.id === "pcx-125");
  assert.deepEqual(pcx?.plates, [
    { plate: "わ1002", status: "active" },
    { plate: "わ1003", status: "maintenance" },
  ]);
  assert.equal(pcx?.depositJpy, 3000);
  assert.ok(
    view.prices.some(
      (p: PriceView) =>
        p.modelId === "pcx-125" && p.packageId === "day-1" && p.priceJpy === 5200 && p.advancePriceJpy === null,
    ),
  );

  // Other deposits, sorts, classes and advance prices: everything follows the catalog it is given.
  const variant = staffCatalogView(variantCatalog());
  assert.equal(variant.ok, true);
  assert.equal(variant.version, 12);
  assert.deepEqual(variant.models, VARIANT_MODELS);
  assert.deepEqual(sortedPrices(variant.prices), sortedPrices(VARIANT_PRICES));
});

test("inactive models and vehicles in maintenance or retired are listed with their status", () => {
  // A fleet with nothing bookable at all: every model inactive, every bike out of service. A block or a phone booking may
  // still name any of them, so none is left out.
  const base = variantCatalog();
  const statuses: VehicleStatus[] = ["maintenance", "retired"];
  const catalog: PublishedCatalog = {
    ...base,
    models: base.models.map((m) => ({ ...m, active: false })),
    vehicles: base.vehicles.map((v, at) => ({ ...v, status: statuses[at % 2] })),
  };
  const view = staffCatalogView(catalog);

  assert.deepEqual(
    view.models.map((m: ModelView) => m.id),
    VARIANT_MODELS.map((m) => m.id),
  );
  for (const m of view.models as ModelView[]) assert.equal(m.active, false, m.id);

  // Every vehicle of the input, once, under its own model, with its own status.
  const listed = (view.models as ModelView[]).flatMap((m) => m.plates.map((p) => ({ ...p, modelId: m.id })));
  const given = catalog.vehicles.map(({ plate, modelId, status }) => ({ plate, modelId, status }));
  const byPlate = (a: { plate: string }, b: { plate: string }) => (a.plate < b.plate ? -1 : 1);
  assert.deepEqual([...listed].sort(byPlate), [...given].sort(byPlate));

  // The mixed fleet of the variant: each flag as given.
  const mixed = staffCatalogView(variantCatalog());
  const flags = Object.fromEntries((mixed.models as ModelView[]).map((m) => [m.id, m.active]));
  assert.deepEqual(flags, {
    "cub-110": false,
    "nbox-660": true,
    "adv-160": true,
    "rebel-250": true,
    "pcx-125": true,
    "today-50": true,
    "assist-26": true,
    "forza-250": false,
  });
  const plateStatus = Object.fromEntries(
    (mixed.models as ModelView[]).flatMap((m) => m.plates.map((p) => [p.plate, p.status])),
  );
  assert.deepEqual(plateStatus, {
    わ0999: "active",
    わ1001: "active",
    わ1002: "active",
    わ1003: "maintenance",
    わ1004: "retired",
    わ1005: "active",
    わ1006: "maintenance",
    わ1007: "retired",
    わ1010: "active",
    わ2001: "active",
    わ2002: "maintenance",
  });
  // A model with no vehicles is still listed, with no plates.
  assert.deepEqual((mixed.models as ModelView[]).find((m) => m.id === "forza-250")?.plates, []);
});

test("packages keep their sort and the slots follow the shop hours", () => {
  const fixture = staffCatalogView(published(7));
  assert.deepEqual(fixture.packages, FIXTURE_PACKAGES);
  // The 6-hour package is in the catalog, and the slots are still the whole day's: the view does not cut them to the
  // starts a 6-hour rental returns in hours from.
  assert.deepEqual(fixture.slots, FIXTURE_SLOTS);
  assert.deepEqual(fixture.config, {
    shopOpen: "09:00",
    shopClose: "18:00",
    slotMinutes: 30,
    minLeadHours: 24,
    maxDaysAhead: 180,
  });

  const variant = staffCatalogView(variantCatalog());
  assert.deepEqual(variant.packages, VARIANT_PACKAGES);
  assert.deepEqual(variant.slots, VARIANT_SLOTS);
  assert.deepEqual(variant.config, {
    shopOpen: "08:30",
    shopClose: "17:00",
    slotMinutes: 45,
    minLeadHours: 6,
    maxDaysAhead: 90,
  });

  // Only the hours change, on the fixture catalog otherwise.
  const HOURS: [Pick<ShopConfig, "shopOpen" | "shopClose" | "slotMinutes">, string[]][] = [
    [{ shopOpen: "10:00", shopClose: "12:00", slotMinutes: 60 }, ["10:00", "11:00"]],
    [{ shopOpen: "07:15", shopClose: "08:30", slotMinutes: 20 }, ["07:15", "07:35", "07:55"]],
    [{ shopOpen: "09:00", shopClose: "10:00", slotMinutes: 15 }, ["09:00", "09:15", "09:30", "09:45"]],
  ];
  for (const [hours, slots] of HOURS) {
    const base = expectedCatalog();
    const view = staffCatalogView(published(3, { ...base, config: { ...base.config, ...hours } }));
    assert.deepEqual(view.slots, slots, JSON.stringify(hours));
    assert.deepEqual(view.config, { ...hours, minLeadHours: 24, maxDaysAhead: 180 }, JSON.stringify(hours));
  }
});

test("a model whose class has no price for a package has no price row for it", () => {
  // The variant plus a class with no prices at all, and a model in it.
  const base = variantCatalog();
  const bare: RateClass = { ...BIKE_160, id: "bike-300", sort: 7, texts: names("300cc", "300cc bike", "300cc", "300cc") };
  const catalog: PublishedCatalog = {
    ...base,
    rateClasses: [...base.rateClasses, bare],
    models: [
      ...base.models,
      { ...base.models[0], id: "xmax-300", rateClassId: "bike-300", sort: 10, texts: modelTexts("エックスマックス", "XMAX", "XMAX", "XMAX") },
    ],
  };
  const view = staffCatalogView(catalog);
  const prices = view.prices as PriceView[];
  const has = (modelId: string, packageId: string) => prices.some((p) => p.modelId === modelId && p.packageId === packageId);

  // car-k prices no hours package, bike-160 only one day, and bike-300 nothing.
  assert.equal(has("nbox-660", "hours-6"), false);
  assert.equal(has("nbox-660", "hours-4"), false);
  assert.deepEqual(
    prices.filter((p) => p.modelId === "adv-160"),
    [{ modelId: "adv-160", packageId: "day-1", priceJpy: 6000, advancePriceJpy: 5500 }],
  );
  assert.deepEqual(prices.filter((p) => p.modelId === "xmax-300"), []);
  // The model with no prices is still a model of the view.
  assert.ok((view.models as ModelView[]).some((m) => m.id === "xmax-300"));

  // Over every model and package: a row exactly when the model's class prices the package, once, at that price.
  for (const model of catalog.models) {
    for (const pack of catalog.packages) {
      const source = catalog.prices.find((p) => p.rateClassId === model.rateClassId && p.packageId === pack.id);
      const rows = prices.filter((p) => p.modelId === model.id && p.packageId === pack.id);
      const label = `${model.id}/${pack.id}`;
      if (source === undefined) {
        assert.deepEqual(rows, [], label);
      } else {
        assert.deepEqual(
          rows,
          [{ modelId: model.id, packageId: pack.id, priceJpy: source.priceJpy, advancePriceJpy: source.advancePriceJpy }],
          label,
        );
      }
    }
  }
  assert.equal(prices.length, VARIANT_PRICES.length, "one row per priced model and package, and no others");
});
