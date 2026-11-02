// parseSearch over the listing's query params. Expected values are literals, with the clock and the window rules worked out
// by hand on the fixture catalog: 24 hours of lead, 180 days ahead, slots of 30 minutes from 09:00 to 17:30.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShopConfig } from "../src/lib/types.ts";
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
