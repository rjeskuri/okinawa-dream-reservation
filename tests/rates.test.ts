// parseRatesFilter and buildFeeTable over the fixture catalog. Expected tables are literals worked out by hand from the sheet.
// The contract read here, and nothing more of the module:
//   parseRatesFilter(params: URLSearchParams, catalog) gives { group?, rateClassId?, packageId?, errors: { field }[] }, as
//   parseSearch does: an absent or invalid param is undefined, and `field` names the query param (group, class, duration).
//   buildFeeTable(catalog, filter) gives one { group, packages, rows } per group with something to show. A row is
//   { rateClass, cells }, and cells line up with packages, each { priceJpy }, null when the class has no such price.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCALES } from "../src/lib/locale.ts";
import type { Catalog, Package, RateClass } from "../src/lib/types.ts";
import { expectedCatalog } from "./helpers/sheet-workbook.ts";

type Parsed = { group?: string | null; rateClassId?: string | null; packageId?: string | null; errors: { field: string }[] };

type FeeGroup = {
  group: string;
  packages: { id: string }[];
  rows: { rateClass: { id: string }; cells: { priceJpy?: number | null }[] }[];
};

type Rejected = [query: Record<string, string>, fields: string[]];

/** A group's table as data: package ids, then one line per class, its id followed by its prices. */
type Layout = Record<string, { packages: string[]; rows: (string | number | null)[][] }>;

const CATALOG = expectedCatalog();

const BIKE_ROWS = [
  ["scooter-50", 2500, 3500, 9000],
  ["bike-125", 3600, 5200, 13800],
  ["bike-400", 6100, 9100, 24700],
];

const BIKE = { packages: ["hours-6", "day-1", "day-3"], rows: BIKE_ROWS };
/** The fixture has no hours-6 price for car-k, so no car class prices that package. */
const CAR = { packages: ["day-1", "day-3"], rows: [["car-k", 7300, 18900]] };
const WHOLE: Layout = { bike: BIKE, car: CAR };

/** The bike table cut down to one package, by its index in BIKE.packages. */
function bikeColumn(index: number): Layout[string] {
  const packages = BIKE.packages.slice(index, index + 1);
  return { packages, rows: BIKE_ROWS.map(([id, ...prices]) => [id as string, prices[index] as number]) };
}

/**
 * Loaded here, so each test fails on its own while the module is missing. The ts-ignore covers that missing module for lint
 * and nothing else: once the module exists, this call is checked against its real types.
 */
async function rates() {
  // @ts-ignore
  return await import("../src/lib/rates.ts");
}

async function parse(query: string | Record<string, string>, catalog: Catalog = CATALOG): Promise<Parsed> {
  const { parseRatesFilter } = await rates();
  return parseRatesFilter(new URLSearchParams(query), catalog);
}

/** What the page would lay out for `query`, by group, so the order of the groups is left open. */
async function layout(query: string | Record<string, string>, catalog: Catalog = CATALOG): Promise<Layout> {
  const { buildFeeTable } = await rates();
  const groups = buildFeeTable(catalog, await parse(query, catalog)) as FeeGroup[];
  return Object.fromEntries(
    groups.map(({ group, packages, rows }) => [
      group,
      {
        packages: packages.map(({ id }) => id),
        rows: rows.map(({ rateClass, cells }) => [rateClass.id, ...cells.map(({ priceJpy }) => priceJpy ?? null)]),
      },
    ]),
  );
}

function filterValues({ group, rateClassId, packageId }: Parsed) {
  return { group: group ?? null, class: rateClassId ?? null, duration: packageId ?? null };
}

function invalidFields({ errors }: Parsed): string[] {
  return errors.map(({ field }) => field).sort();
}

function rateClass(id: string, grp: RateClass["grp"], sort: number): RateClass {
  const copied = CATALOG.rateClasses.find(({ grp: group }) => group === grp) as RateClass;
  return { ...copied, id, grp, sort };
}

function dayPackage(id: string, days: number, sort: number): Package {
  const copied = CATALOG.packages.find((pkg) => pkg.days !== null) as Package;
  return { ...copied, id, days, hours: null, sort };
}

function price(rateClassId: string, packageId: string, priceJpy: number) {
  return { rateClassId, packageId, priceJpy };
}

test("buildFeeTable lays out classes and packages in sort order", async () => {
  assert.deepEqual(await layout(""), WHOLE);

  // The sort column decides, not the rows' order on the sheet: arrays backwards with the same sorts change nothing.
  const backwards = {
    ...CATALOG,
    rateClasses: [...CATALOG.rateClasses].reverse(),
    packages: [...CATALOG.packages].reverse(),
    prices: [...CATALOG.prices].reverse(),
  };
  assert.deepEqual(await layout("", backwards), WHOLE);

  // Sorts running against the ids and the fixture's order turn the table around.
  const turned = {
    ...CATALOG,
    rateClasses: CATALOG.rateClasses.map((row) => ({ ...row, sort: 100 - row.sort })),
    packages: CATALOG.packages.map((row) => ({ ...row, sort: 100 - row.sort })),
  };
  assert.deepEqual(await layout("", turned), {
    bike: {
      packages: ["day-3", "day-1", "hours-6"],
      rows: [
        ["bike-400", 24700, 9100, 6100],
        ["bike-125", 13800, 5200, 3600],
        ["scooter-50", 9000, 3500, 2500],
      ],
    },
    car: { packages: ["day-3", "day-1"], rows: [["car-k", 18900, 7300]] },
  });

  // The prices are the catalog's, whatever they are.
  const repriced = { ...CATALOG, prices: CATALOG.prices.map((row) => ({ ...row, priceJpy: row.priceJpy * 3 + 7 })) };
  assert.deepEqual(await layout("", repriced), {
    bike: {
      packages: ["hours-6", "day-1", "day-3"],
      rows: [
        ["scooter-50", 7507, 10507, 27007],
        ["bike-125", 10807, 15607, 41407],
        ["bike-400", 18307, 27307, 74107],
      ],
    },
    car: { packages: ["day-1", "day-3"], rows: [["car-k", 21907, 56707]] },
  });

  // A new class takes its place by sort, in its own group, and a new package gets its column.
  const grown = {
    ...CATALOG,
    rateClasses: [
      ...CATALOG.rateClasses.map((row) => (row.id === "bike-400" ? { ...row, sort: 9 } : row)),
      rateClass("bike-750", "bike", 5),
      rateClass("car-van", "car", 0),
    ],
    packages: [
      ...CATALOG.packages.map((row) => (row.id === "day-3" ? { ...row, sort: 9 } : row)),
      dayPackage("day-7", 7, 5),
    ],
    prices: [
      ...CATALOG.prices,
      price("bike-750", "day-1", 31415),
      price("bike-750", "day-7", 88000),
      price("car-van", "day-1", 10000),
      price("car-van", "day-3", 27000),
      price("car-van", "day-7", 63000),
    ],
  };
  assert.deepEqual(await layout("", grown), {
    bike: {
      packages: ["hours-6", "day-1", "day-7", "day-3"],
      rows: [
        ["scooter-50", 2500, 3500, null, 9000],
        ["bike-125", 3600, 5200, null, 13800],
        ["bike-750", null, 31415, 88000, null],
        ["bike-400", 6100, 9100, null, 24700],
      ],
    },
    car: {
      packages: ["day-1", "day-7", "day-3"],
      rows: [
        ["car-van", 10000, 63000, 27000],
        ["car-k", 7300, null, 18900],
      ],
    },
  });
});

test("buildFeeTable shows each group only the packages its classes are priced for", async () => {
  // The shop's real shape: bikes and cars share no package, and the packages table does not say which is whose.
  const shop = {
    ...CATALOG,
    rateClasses: [rateClass("cc-50", "bike", 1), rateClass("k-car", "car", 2)],
    packages: [
      dayPackage("bike-24h", 1, 3),
      dayPackage("car-1d", 1, 4),
      dayPackage("car-2d", 2, 5),
      dayPackage("nobody", 3, 6),
    ],
    prices: [price("cc-50", "bike-24h", 6000), price("k-car", "car-1d", 6000), price("k-car", "car-2d", 11000)],
  };
  assert.deepEqual(await layout("", shop), {
    bike: { packages: ["bike-24h"], rows: [["cc-50", 6000]] },
    car: { packages: ["car-1d", "car-2d"], rows: [["k-car", 6000, 11000]] },
  });
});

test("buildFeeTable leaves a missing price empty, not zero", async () => {
  const gaps = {
    ...CATALOG,
    rateClasses: [...CATALOG.rateClasses, rateClass("bike-600", "bike", 8), rateClass("bike-900", "bike", 9)],
    prices: [...CATALOG.prices, price("bike-600", "day-3", 19800)],
  };
  const { bike } = await layout("", gaps);
  assert.deepEqual(bike?.packages, ["hours-6", "day-1", "day-3"]);
  assert.deepEqual(bike?.rows.slice(-2), [
    ["bike-600", null, null, 19800],
    ["bike-900", null, null, null],
  ]);

  // Filtering to the class keeps the group's columns: the class is the row, and a gap is still a gap.
  assert.deepEqual(await layout("class=bike-600", gaps), {
    bike: { packages: ["hours-6", "day-1", "day-3"], rows: [["bike-600", null, null, 19800]] },
  });
});

test("buildFeeTable narrows by group, class and duration", async () => {
  const carDayOne = { packages: ["day-1"], rows: [["car-k", 7300]] };
  const carDayThree = { packages: ["day-3"], rows: [["car-k", 18900]] };
  const cases: [query: string, expected: Layout][] = [
    ["group=bike", { bike: BIKE }],
    ["group=car", { car: CAR }],
    ["class=scooter-50", { bike: { packages: BIKE.packages, rows: [["scooter-50", 2500, 3500, 9000]] } }],
    ["class=bike-400", { bike: { packages: BIKE.packages, rows: [["bike-400", 6100, 9100, 24700]] } }],
    ["class=car-k", { car: CAR }],
    ["duration=day-1", { bike: bikeColumn(1), car: carDayOne }],
    ["duration=day-3", { bike: bikeColumn(2), car: carDayThree }],
    // No car class has this package, so there is nothing to show for cars.
    ["duration=hours-6", { bike: bikeColumn(0) }],
    ["group=bike&duration=day-1", { bike: bikeColumn(1) }],
    ["group=car&duration=day-3", { car: carDayThree }],
    ["class=bike-125&duration=day-1", { bike: { packages: ["day-1"], rows: [["bike-125", 5200]] } }],
    ["class=car-k&duration=day-3", { car: carDayThree }],
    ["group=bike&class=bike-400&duration=hours-6", { bike: { packages: ["hours-6"], rows: [["bike-400", 6100]] } }],
  ];
  for (const [query, expected] of cases) assert.deepEqual(await layout(query), expected, query);
});

test("buildFeeTable shows the whole table for an invalid filter", async () => {
  const queries = [
    "group=plane",
    "class=nope",
    "duration=week",
    // The filters that were valid are dropped too, so a guest does not get half of what they asked for.
    "group=bike&class=nope",
    "class=car-k&duration=week",
    "group=plane&class=bike-125&duration=day-1",
    "group=plane&class=nope&duration=week",
  ];
  for (const query of queries) assert.deepEqual(await layout(query), WHOLE, query);
});

test("parseRatesFilter accepts valid filters and reports invalid ones", async () => {
  const accepted: [query: string, expected: Partial<ReturnType<typeof filterValues>>][] = [
    ["", {}],
    // A plain form sends its "any" choices as empty params.
    ["group=&class=&duration=", {}],
    ["group=bike", { group: "bike" }],
    ["group=car", { group: "car" }],
    ["class=scooter-50", { class: "scooter-50" }],
    ["class=bike-400", { class: "bike-400" }],
    ["class=car-k", { class: "car-k" }],
    ["duration=hours-6", { duration: "hours-6" }],
    ["duration=day-3", { duration: "day-3" }],
    ["group=bike&class=bike-125&duration=day-1", { group: "bike", class: "bike-125", duration: "day-1" }],
    ["group=car&class=car-k&duration=day-3", { group: "car", class: "car-k", duration: "day-3" }],
    ["group=&class=bike-125&duration=", { class: "bike-125" }],
    // Other params are none of its business, and the listing's own are not filters here.
    ["utm_source=mail&group=car", { group: "car" }],
    ["package=day-1&type=car", {}],
  ];
  for (const [query, expected] of accepted) {
    const parsed = await parse(query);
    assert.deepEqual(filterValues(parsed), { group: null, class: null, duration: null, ...expected }, query);
    assert.deepEqual(parsed.errors, [], query);
  }

  const alone = (param: string, values: string[]): Rejected[] => values.map((value) => [{ [param]: value }, [param]]);
  const rejected: Rejected[] = [
    ...alone("group", ["plane", "BIKE", "Bike", "bike ", " car", "cars", "constructor", "__proto__", "toString"]),
    // A package id is no class, and a class id no package.
    ...alone("class", ["nope", "BIKE-125", "bike-125 ", "day-1", "bike", "constructor", "__proto__", "valueOf"]),
    ...alone("duration", ["week", "DAY-1", "day-1 ", "7", "scooter-50", "constructor", "__proto__", "valueOf"]),
    [{ group: "bike", class: "nope" }, ["class"]],
    [{ group: "plane", duration: "day-1" }, ["group"]],
    [{ class: "bike-125", duration: "week" }, ["duration"]],
    [{ group: "plane", class: "nope", duration: "week" }, ["class", "duration", "group"]],
  ];
  for (const [query, fields] of rejected) {
    const parsed = await parse(query);
    const label = JSON.stringify(query);
    assert.deepEqual(invalidFields(parsed), fields, label);
    const values = filterValues(parsed);
    for (const field of fields) assert.equal(values[field as keyof typeof values], null, `${label}: ${field} is kept`);
  }

  // What counts as valid is the catalog's, not a list in the code.
  const grown = {
    ...CATALOG,
    rateClasses: [...CATALOG.rateClasses, rateClass("bike-750", "bike", 9)],
    packages: [...CATALOG.packages, dayPackage("day-7", 7, 9)],
  };
  const query = "class=bike-750&duration=day-7";
  assert.deepEqual(invalidFields(await parse(query)), ["class", "duration"]);
  const found = await parse(query, grown);
  assert.deepEqual(invalidFields(found), []);
  assert.deepEqual(filterValues(found), { group: null, class: "bike-750", duration: "day-7" });

  const shrunk = {
    ...CATALOG,
    rateClasses: CATALOG.rateClasses.filter(({ id }) => id !== "bike-125"),
    packages: CATALOG.packages.filter(({ id }) => id !== "day-3"),
  };
  assert.deepEqual(invalidFields(await parse("class=bike-125&duration=day-3", shrunk)), ["class", "duration"]);
});

test("the rates strings hold text for all four locales", async () => {
  // @ts-ignore
  const loaded = (await import("../src/i18n/strings/rates.ts")) as Record<string, Record<string, Record<string, string>>>;
  const dictionaries = Object.values(loaded);
  assert.ok(dictionaries.length > 0, "src/i18n/strings/rates.ts exports nothing");
  for (const dictionary of dictionaries) {
    for (const [key, entry] of Object.entries(dictionary)) {
      for (const locale of LOCALES) assert.ok(entry[locale]?.trim(), `${key} has no ${locale} text`);
    }
  }
});
