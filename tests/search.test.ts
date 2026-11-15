// parseSearch over the listing's query params. Expected values are literals, with the clock and the window rules worked out
// by hand on the fixture catalog: 24 hours of lead, 180 days ahead, slots of 30 minutes from 09:00 to 17:30.
import assert from "node:assert/strict";
import { test } from "node:test";
import { searchAvailability } from "../src/lib/booking/availability.ts";
import { createHold } from "../src/lib/booking/holds.ts";
import { readCatalog, replaceCatalog } from "../src/lib/db/catalog-store.ts";
import { cardPrice, carriedQuery, findModels, listedModels, parseSearch, type ParsedSearch } from "../src/lib/search.ts";
import type { Catalog, ShopConfig } from "../src/lib/types.ts";
import { EBIKE_CLASS, EBIKE_MODEL, EBIKE_PLATES, EBIKE_PRICES, withEbike } from "./fixtures/sheet/ebike.ts";
import { createTestDb } from "./helpers/d1.ts";
import { expectedCatalog } from "./helpers/sheet-workbook.ts";

type Parsed = {
  date?: string | null;
  time?: string | null;
  packageId?: string | null;
  typeId?: string | null;
  ccBand?: string | null;
  rateClassId?: string | null;
  errors: { field: string; reason: string }[];
};

type Values = Record<"date" | "time" | "packageId" | "typeId" | "ccBand" | "rateClassId", string | null>;

const CATALOG = expectedCatalog();
const NOW = Date.parse("2030-06-01T12:00:00+09:00");
const BLANK: Values = { date: null, time: null, packageId: null, typeId: null, ccBand: null, rateClassId: null };

/** A search that passes on its own, for the cases that spoil one param of it. */
const VALID = { date: "2030-06-10", time: "10:00", package: "day-1" };

/**
 * Loaded here, so each test fails on its own while the module is missing. The ts-ignore covers that missing module for lint
 * and nothing else: once the module exists, this call is checked against its real types.
 */
async function parse(
  query: string | Record<string, string>,
  { closed = [], config = {}, now = NOW }: { closed?: string[]; config?: Partial<ShopConfig>; now?: number } = {},
): Promise<Parsed> {
  // @ts-ignore
  const { parseSearch } = await import("../src/lib/search.ts");
  return parseSearch(new URLSearchParams(query), CATALOG, { ...CATALOG.config, ...config }, closed, now);
}

/** The parsed fields, with a field that is left out and a null field the same. */
function values(parsed: Parsed): Values {
  return {
    date: parsed.date ?? null,
    time: parsed.time ?? null,
    packageId: parsed.packageId ?? null,
    typeId: parsed.typeId ?? null,
    ccBand: parsed.ccBand ?? null,
    rateClassId: parsed.rateClassId ?? null,
  };
}

function invalidFields(parsed: Parsed): string[] {
  return parsed.errors.map(({ field }) => field).sort();
}

const ACCEPTED: { query: string; expected: Partial<Values> }[] = [
  { query: "", expected: {} },
  { query: "date=&time=&package=&type=&cc=&class=", expected: {} },
  {
    query: "date=2030-06-10&time=10:00&package=day-3&type=scooter&cc=51to125&class=bike-125",
    expected: {
      date: "2030-06-10",
      time: "10:00",
      packageId: "day-3",
      typeId: "scooter",
      ccBand: "51to125",
      rateClassId: "bike-125",
    },
  },
  {
    query: "date=2030-08-21&time=17:30&package=day-1&type=motorcycle&cc=over400&class=bike-400",
    expected: {
      date: "2030-08-21",
      time: "17:30",
      packageId: "day-1",
      typeId: "motorcycle",
      ccBand: "over400",
      rateClassId: "bike-400",
    },
  },
  {
    query: "date=2030-06-10&time=09:00&package=day-1",
    expected: { date: "2030-06-10", time: "09:00", packageId: "day-1" },
  },
  // Exactly 24 hours ahead, and exactly 180 days ahead.
  {
    query: "date=2030-06-02&time=12:00&package=day-1",
    expected: { date: "2030-06-02", time: "12:00", packageId: "day-1" },
  },
  {
    query: "date=2030-11-28&time=12:00&package=day-1",
    expected: { date: "2030-11-28", time: "12:00", packageId: "day-1" },
  },
  // A search in the making has nothing to check yet.
  { query: "date=2030-06-10", expected: { date: "2030-06-10" } },
  { query: "time=10:00", expected: { time: "10:00" } },
  { query: "package=day-3", expected: { packageId: "day-3" } },
  { query: "type=car", expected: { typeId: "car" } },
  { query: "type=motorcycle", expected: { typeId: "motorcycle" } },
  { query: "cc=upto50", expected: { ccBand: "upto50" } },
  { query: "cc=126to400", expected: { ccBand: "126to400" } },
  { query: "class=car-k", expected: { rateClassId: "car-k" } },
  { query: "class=scooter-50&package=day-1", expected: { rateClassId: "scooter-50", packageId: "day-1" } },
];

const REJECTED: { param: string; field: keyof Values; bad: string[] }[] = [
  {
    param: "date",
    field: "date",
    bad: ["tomorrow", "2030-6-10", "10/06/2030", "2030-02-30", "2030-13-01", "2030-06-10T10:00", "20300610", "99999-01-01"],
  },
  { param: "time", field: "time", bad: ["noon", "25:00", "10:60", "24:00", "10:00:00", "1000", "-1:00"] },
  { param: "package", field: "packageId", bad: ["week", "DAY-1", "constructor", "__proto__", "toString"] },
  { param: "type", field: "typeId", bad: ["plane", "Car", "constructor", "__proto__", "toString"] },
  { param: "cc", field: "ccBand", bad: ["all", "50", "upto51", "constructor", "__proto__"] },
  { param: "class", field: "rateClassId", bad: ["nope", "BIKE-125", "constructor", "__proto__", "valueOf"] },
];

test("parseSearch accepts valid queries and reports each invalid field", async () => {
  for (const { query, expected } of ACCEPTED) {
    const parsed = await parse(query);
    assert.deepEqual(parsed.errors, [], query);
    assert.deepEqual(values(parsed), { ...BLANK, ...expected }, query);
  }

  for (const { param, field, bad } of REJECTED) {
    for (const value of bad) {
      const label = `${param}=${value}`;

      // Among valid params, so a bad value is reported by its own name and leaves the others as they are.
      const parsed = await parse({ ...VALID, type: "scooter", [param]: value });
      assert.deepEqual(invalidFields(parsed), [param], label);
      assert.equal(values(parsed)[field], null, `${label} must not come back as a value`);
      assert.ok(parsed.errors[0]?.reason, `${label} has no reason`);

      // And alone, where no search is complete enough to reach the pickup window.
      const alone = await parse({ [param]: value });
      assert.deepEqual(invalidFields(alone), [param], `${label} alone`);
    }
  }

  const everything = await parse("date=soon&time=later&package=week&type=plane&cc=all&class=nope");
  assert.deepEqual(invalidFields(everything), ["cc", "class", "date", "package", "time", "type"]);
  assert.deepEqual(values(everything), BLANK);
});

const WINDOW_CASES: {
  label: string;
  date: string;
  time: string;
  packageId?: string;
  closed?: string[];
  config?: Partial<ShopConfig>;
  /** The field and the pickupWindowError reason, or null when the search passes. */
  expected: { field: string; reason: string } | null;
}[] = [
  { label: "before the lead time", date: "2030-06-02", time: "11:30", expected: { field: "date", reason: "TOO_SOON" } },
  { label: "in the past", date: "2030-05-01", time: "10:00", expected: { field: "date", reason: "TOO_SOON" } },
  { label: "past the horizon", date: "2030-11-28", time: "12:30", expected: { field: "date", reason: "TOO_FAR" } },
  {
    label: "a longer lead time",
    date: "2030-06-03",
    time: "11:30",
    config: { minLeadHours: 48 },
    expected: { field: "date", reason: "TOO_SOON" },
  },
  { label: "the same pickup with the usual lead", date: "2030-06-03", time: "11:30", expected: null },
  {
    label: "a nearer horizon",
    date: "2030-07-02",
    time: "12:30",
    config: { maxDaysAhead: 31 },
    expected: { field: "date", reason: "TOO_FAR" },
  },
  { label: "before opening", date: "2030-06-10", time: "08:30", expected: { field: "time", reason: "OUTSIDE_HOURS" } },
  { label: "closing time", date: "2030-06-10", time: "18:00", expected: { field: "time", reason: "OUTSIDE_HOURS" } },
  {
    label: "an earlier close",
    date: "2030-06-10",
    time: "17:00",
    config: { shopClose: "17:00" },
    expected: { field: "time", reason: "OUTSIDE_HOURS" },
  },
  { label: "off the grid", date: "2030-06-10", time: "10:15", expected: { field: "time", reason: "OFF_SLOT" } },
  {
    label: "off an hourly grid",
    date: "2030-06-10",
    time: "10:30",
    config: { slotMinutes: 60 },
    expected: { field: "time", reason: "OFF_SLOT" },
  },
  { label: "the same time on the usual grid", date: "2030-06-10", time: "10:30", expected: null },
  {
    label: "a closed pickup day",
    date: "2030-06-10",
    time: "10:00",
    closed: ["2030-06-10"],
    expected: { field: "date", reason: "CLOSED_PICKUP" },
  },
  // The return day comes from the package, so one closed date stops three days and not one.
  {
    label: "a closed return day",
    date: "2030-06-10",
    time: "10:00",
    packageId: "day-3",
    closed: ["2030-06-12"],
    expected: { field: "date", reason: "CLOSED_RETURN" },
  },
  { label: "one day before that closed date", date: "2030-06-10", time: "10:00", closed: ["2030-06-12"], expected: null },
  {
    label: "a closed date past the return day",
    date: "2030-06-10",
    time: "10:00",
    packageId: "day-3",
    closed: ["2030-06-13"],
    expected: null,
  },
];

test("parseSearch checks a complete search against the pickup window of its config and package", async () => {
  for (const { label, date, time, packageId = "day-1", closed, config, expected } of WINDOW_CASES) {
    const parsed = await parse({ date, time, package: packageId }, { closed, config });
    assert.deepEqual(
      parsed.errors.map(({ field, reason }) => ({ field, reason })),
      expected === null ? [] : [expected],
      label,
    );
  }
});

test("parseSearch checks the pickup against the clock it is given", async () => {
  const query = { date: "2030-06-10", time: "10:00", package: "day-1" };

  assert.deepEqual((await parse(query, { now: Date.parse("2030-06-09T10:00:00+09:00") })).errors, []);

  const tooSoon = await parse(query, { now: Date.parse("2030-06-09T10:30:00+09:00") });
  assert.deepEqual(tooSoon.errors.map(({ reason }) => reason), ["TOO_SOON"]);

  const tooFar = await parse(query, { now: Date.parse("2029-12-01T10:00:00+09:00") });
  assert.deepEqual(tooFar.errors.map(({ reason }) => reason), ["TOO_FAR"]);
});

// An hours package has no return day until task #50, but the fee schedule links to its prices.
test("parseSearch accepts an hours package without a return day to check", async () => {
  assert.deepEqual((await parse("package=hours-6")).errors, []);
  assert.equal((await parse("package=hours-6")).packageId, "hours-6");

  const search = await parse("date=2030-06-10&time=10:00&package=hours-6&class=bike-125");
  assert.deepEqual(search.errors, []);
  assert.deepEqual(values(search), {
    ...BLANK,
    date: "2030-06-10",
    time: "10:00",
    packageId: "hours-6",
    rateClassId: "bike-125",
  });
});

// E-bikes (#130). The fixture catalog with tests/fixtures/sheet/ebike.ts added: one model, two active bicycles, ¥4,500 a
// day and ¥10,000 for three, no deposit. The D1 case publishes it with replaceCatalog and runs what the listing runs:
// parseSearch, findModels over searchAvailability, listedModels and cardPrice. Then holds take the bicycles one by one.

const BANDS = ["upto50", "51to125", "126to400", "over400"];
const EBIKE_PICKUP = Date.parse("2030-06-10T10:00:00+09:00");

function parseOn(catalog: Catalog, query: Record<string, string>, now = NOW): ParsedSearch {
  return parseSearch(new URLSearchParams(query), catalog, catalog.config, catalog.closedDates, now);
}

test("an e-bike search ignores the engine band", async (t) => {
  const catalog = withEbike(expectedCatalog());

  await t.test("parseSearch drops a band for type=ebike, with or without a pickup", () => {
    for (const band of BANDS) {
      const queries = [
        { type: "ebike", cc: band },
        { ...VALID, type: "ebike", cc: band },
        { date: VALID.date, time: VALID.time, package: "", type: "ebike", cc: band },
      ];
      for (const query of queries) {
        const label = new URLSearchParams(query).toString();
        const parsed = parseOn(catalog, query);
        assert.deepEqual(parsed.errors, [], label);
        assert.equal(parsed.typeId, "ebike", label);
        assert.equal(parsed.ccBand ?? null, null, `${label}: the band is kept`);
        assert.ok(!carriedQuery(parsed).includes("cc="), `${label}: a card carries the band`);
      }
      // A type with an engine keeps it.
      assert.equal(parseOn(catalog, { type: "scooter", cc: band }).ccBand, band);
    }
  });

  await t.test("the e-bike is listed with its price for any band, and a hold takes its bicycles", async () => {
    const { db, dispose } = await createTestDb();
    try {
      await replaceCatalog(db, catalog, { now: NOW, source: "sheet" });
      const stored = await readCatalog(db);
      assert.ok(stored, "no catalog was stored");

      const search = async (query: Record<string, string>) => {
        const parsed = parseOn(stored, query);
        assert.deepEqual(parsed.errors, [], JSON.stringify(query));
        const found = await findModels(parsed, stored.models, NOW, (q) => searchAvailability(db, q));
        assert.ok(found, `${JSON.stringify(query)} ran no search`);
        return { parsed, found, listed: listedModels(stored.models, parsed, found).map(({ id }) => id) };
      };

      // A band that would apply leaves nothing for a model without an engine, so each of them must be dropped.
      for (const band of [...BANDS, ""]) {
        for (const pkg of ["day-1", "day-3", ""]) {
          const query = { ...VALID, package: pkg, type: "ebike", cc: band };
          const label = new URLSearchParams(query).toString();
          const priceJpy = EBIKE_PRICES[pkg || "day-1"];
          const { parsed, found, listed } = await search(query);
          assert.deepEqual(found, [{ modelId: EBIKE_MODEL, vacancies: 2, priceJpy, depositJpy: 0 }], label);
          assert.deepEqual(listed, [EBIKE_MODEL], label);
          assert.equal(cardPrice(stored.packages, stored.prices, EBIKE_CLASS, parsed)?.priceJpy, priceJpy, label);
        }
      }
      // The band still narrows a scooter search: only today-50 is up to 50 cc.
      assert.deepEqual((await search({ ...VALID, type: "scooter", cc: "upto50" })).listed, ["today-50"]);

      const hold = (n: number) =>
        createHold(
          db,
          { id: `ebike-hold-${n}`, modelId: EBIKE_MODEL, packageId: "day-1", startAt: EBIKE_PICKUP, locale: "en" },
          NOW,
        );
      const query = { ...VALID, type: "ebike", cc: "over400" };
      const plates: string[] = [];
      for (const [n, left] of [
        [1, 1],
        [2, 0],
      ]) {
        const result = await hold(n);
        assert.ok(result.ok, `hold ${n}: ${JSON.stringify(result)}`);
        const { booking } = result;
        assert.deepEqual(
          { modelId: booking.modelId, status: booking.status, priceJpy: booking.priceJpy, depositJpy: booking.depositJpy },
          { modelId: EBIKE_MODEL, status: "ON_HOLD", priceJpy: 4500, depositJpy: 0 },
          `hold ${n}`,
        );
        plates.push(booking.vehiclePlate);
        const { found } = await search(query);
        assert.deepEqual(found.map(({ vacancies }) => vacancies), left === 0 ? [] : [left], `after hold ${n}`);
      }
      assert.deepEqual(plates.sort(), [...EBIKE_PLATES].sort());
      assert.deepEqual(await hold(3), { ok: false, reason: "SOLD_OUT" });
    } finally {
      await dispose();
    }
  });
});
