// One-row mutations of the valid workbook and what each must do: the rows that must carry an error, the column each
// error names, and what leaves the catalog. Dependents are spelled out from the fixture, so a row that takes others
// with it lists them here. A key names a row of the valid workbook; APPENDED is the row the mutation added at the end.
//
// A duplicate keeps the first row and rejects the later one. A bad Config row cannot be left out of a ShopConfig, whose
// fields are all required, so the key then counts as missing: the row has its error, and `fatal` names the key.
import type { Catalog } from "../../../src/lib/types.ts";
import { appendCopy, appendRow, setCell, type Workbook } from "../../helpers/sheet-workbook.ts";

export const APPENDED = "(the appended row)";

export type BadRow = {
  tab: string;
  key: string;
  /** The column its error must name; with several, any one of them. */
  column: string | string[];
};

/** What leaves the catalog, by id, plate or "class/package". */
export type Dropped = {
  vehicleTypes?: string[];
  rateClasses?: string[];
  models?: string[];
  vehicles?: string[];
  packages?: string[];
  prices?: string[];
  options?: string[];
  cancellationTiers?: number[];
  closedDates?: string[];
};

type Effect = { errors: BadRow[]; drop?: Dropped; fatal?: string };

export type RuleCase = Effect & { name: string; mutate: (workbook: Workbook) => void };

/** A value at the edge of a rule that stays valid, and the change it makes to the expected catalog. */
export type BoundaryCase = { name: string; mutate: (workbook: Workbook) => void; change: (catalog: Catalog) => void };

const VEHICLES_OF_MODEL: Record<string, string[]> = {
  "today-50": ["わ1001"],
  "pcx-125": ["わ1002", "わ1003"],
  "cub-110": ["わ1004"],
  "rebel-250": ["わ1005"],
  "nbox-660": ["わ1006"],
};

const MODELS_OF_CLASS: Record<string, string[]> = {
  "scooter-50": ["today-50"],
  "bike-125": ["pcx-125", "cub-110"],
  "bike-400": ["rebel-250"],
  "car-k": ["nbox-660"],
};

const MODELS_OF_TYPE: Record<string, string[]> = {
  scooter: ["today-50", "pcx-125"],
  motorcycle: ["cub-110", "rebel-250"],
  car: ["nbox-660"],
};

const PRICES_OF_CLASS: Record<string, string[]> = {
  "scooter-50": ["scooter-50/hours-6", "scooter-50/day-1", "scooter-50/day-3"],
  "bike-125": ["bike-125/hours-6", "bike-125/day-1", "bike-125/day-3"],
  "bike-400": ["bike-400/hours-6", "bike-400/day-1", "bike-400/day-3"],
  "car-k": ["car-k/day-1", "car-k/day-3"],
};

const PRICES_OF_PACKAGE: Record<string, string[]> = {
  "hours-6": ["scooter-50/hours-6", "bike-125/hours-6", "bike-400/hours-6"],
  "day-1": ["scooter-50/day-1", "bike-125/day-1", "bike-400/day-1", "car-k/day-1"],
  "day-3": ["scooter-50/day-3", "bike-125/day-3", "bike-400/day-3", "car-k/day-3"],
};

function show(value: unknown): string {
  return JSON.stringify(value);
}

function set(tab: string, key: string, column: string, value: unknown) {
  return (workbook: Workbook) => setCell(workbook, tab, key, column, value);
}

function dependents(tab: string, keys: string[], column: string): BadRow[] {
  return keys.map((key) => ({ tab, key, column }));
}

function skipsModels(ids: string[], column: string): Effect {
  const plates = ids.flatMap((id) => VEHICLES_OF_MODEL[id]);
  return {
    errors: [...dependents("Models", ids, column), ...dependents("Vehicles", plates, "model_id")],
    drop: { models: ids, vehicles: plates },
  };
}

function skipsRateClass(id: string, column: string): Effect {
  const models = skipsModels(MODELS_OF_CLASS[id], "rate_class_id");
  const prices = PRICES_OF_CLASS[id];
  return {
    errors: [
      { tab: "RateClasses", key: id, column },
      ...models.errors,
      ...dependents("Prices", prices, "rate_class_id"),
    ],
    drop: { ...models.drop, rateClasses: [id], prices },
  };
}

function skipsPackage(id: string, column: string | string[]): Effect {
  const prices = PRICES_OF_PACKAGE[id];
  return {
    errors: [{ tab: "Packages", key: id, column }, ...dependents("Prices", prices, "package_id")],
    drop: { packages: [id], prices },
  };
}

function skipsType(id: string, column: string): Effect {
  const models = skipsModels(MODELS_OF_TYPE[id], "type_id");
  return {
    errors: [{ tab: "Types", key: id, column }, ...models.errors],
    drop: { ...models.drop, vehicleTypes: [id] },
  };
}

const MODELS: RuleCase[] = [
  ...["Bad_Slug", "UPPER", "-leading", "trailing-", "two--dashes", "with space", "a".repeat(41)].map((slug) => ({
    name: `model_id ${show(slug)} is not a slug`,
    mutate: set("Models", "rebel-250", "model_id", slug),
    ...skipsModels(["rebel-250"], "model_id"),
  })),
  {
    name: "a Models type_id outside the three types",
    mutate: set("Models", "rebel-250", "type_id", "truck"),
    ...skipsModels(["rebel-250"], "type_id"),
  },
  ...["abc", "125cc", 0, -50, 12.5, ""].map((cc) => ({
    name: `engine_cc ${show(cc)}`,
    mutate: set("Models", "pcx-125", "engine_cc", cc),
    ...skipsModels(["pcx-125"], "engine_cc"),
  })),
  ...[126, 400].map((cc) => ({
    name: `a moped override on ${cc} cc`,
    mutate: (workbook: Workbook) => {
      setCell(workbook, "Models", "rebel-250", "engine_cc", cc);
      setCell(workbook, "Models", "rebel-250", "license_class", "moped");
    },
    ...skipsModels(["rebel-250"], "license_class"),
  })),
  {
    name: "a license_class outside the five classes",
    mutate: set("Models", "rebel-250", "license_class", "huge"),
    ...skipsModels(["rebel-250"], "license_class"),
  },
  {
    name: "a model with an unknown rate class",
    mutate: set("Models", "nbox-660", "rate_class_id", "ghost"),
    ...skipsModels(["nbox-660"], "rate_class_id"),
  },
  { name: "a blank brand", mutate: set("Models", "cub-110", "brand", ""), ...skipsModels(["cub-110"], "brand") },
  ...["first", ""].map((sort) => ({
    name: `Models sort ${show(sort)}`,
    mutate: set("Models", "today-50", "sort", sort),
    ...skipsModels(["today-50"], "sort"),
  })),
  ...["maybe", ""].map((active) => ({
    name: `active ${show(active)}`,
    mutate: set("Models", "today-50", "active", active),
    ...skipsModels(["today-50"], "active"),
  })),
  ...[0, -1, "two"].map((seats) => ({
    name: `seats ${show(seats)}`,
    mutate: set("Models", "pcx-125", "seats", seats),
    ...skipsModels(["pcx-125"], "seats"),
  })),
  {
    name: "a model with no name in any language",
    mutate: (workbook: Workbook) => {
      for (const column of ["name_ja", "name_en", "name_zh", "name_ko"]) {
        setCell(workbook, "Models", "rebel-250", column, "");
      }
    },
    ...skipsModels(["rebel-250"], "name_"),
  },
  {
    name: "a duplicate model id keeps the first row",
    mutate: (workbook: Workbook) => appendCopy(workbook, "Models", "pcx-125", {}),
    errors: [{ tab: "Models", key: APPENDED, column: "model_id" }],
  },
  {
    name: "a duplicate model id that only NFKC reveals",
    mutate: (workbook: Workbook) => appendCopy(workbook, "Models", "pcx-125", { model_id: "ｐｃｘ－１２５" }),
    errors: [{ tab: "Models", key: APPENDED, column: "model_id" }],
  },
];

const VEHICLES: RuleCase[] = [
  {
    name: "a duplicate plate keeps the first row",
    mutate: (workbook: Workbook) => appendCopy(workbook, "Vehicles", "わ1001", { model_id: "pcx-125" }),
    errors: [{ tab: "Vehicles", key: APPENDED, column: "plate" }],
  },
  {
    name: "a duplicate plate that only NFKC reveals",
    mutate: (workbook: Workbook) => appendCopy(workbook, "Vehicles", "わ1001", { plate: "わ１００１" }),
    errors: [{ tab: "Vehicles", key: APPENDED, column: "plate" }],
  },
  {
    name: "a vehicle with an unknown model",
    mutate: set("Vehicles", "わ1002", "model_id", "ghost"),
    errors: [{ tab: "Vehicles", key: "わ1002", column: "model_id" }],
    drop: { vehicles: ["わ1002"] },
  },
  ...["parked", ""].map((status) => ({
    name: `vehicle status ${show(status)}`,
    mutate: set("Vehicles", "わ1006", "status", status),
    errors: [{ tab: "Vehicles", key: "わ1006", column: "status" }],
    drop: { vehicles: ["わ1006"] },
  })),
  {
    name: "a non-numeric odometer_km",
    mutate: set("Vehicles", "わ1001", "odometer_km", "far"),
    errors: [{ tab: "Vehicles", key: "わ1001", column: "odometer_km" }],
    drop: { vehicles: ["わ1001"] },
  },
  {
    name: "a non-numeric base_usage_days",
    mutate: set("Vehicles", "わ1005", "base_usage_days", "many"),
    errors: [{ tab: "Vehicles", key: "わ1005", column: "base_usage_days" }],
    drop: { vehicles: ["わ1005"] },
  },
];

const TYPES: RuleCase[] = [
  {
    name: "a Types type_id outside the three types",
    mutate: set("Types", "car", "type_id", "truck"),
    ...skipsType("car", "type_id"),
  },
  ...[-1, "abc", "", "¥", 1000.5].map((deposit) => ({
    name: `deposit_jpy ${show(deposit)}`,
    mutate: set("Types", "motorcycle", "deposit_jpy", deposit),
    ...skipsType("motorcycle", "deposit_jpy"),
  })),
  {
    name: "a duplicate type keeps the first row",
    mutate: (workbook: Workbook) => appendCopy(workbook, "Types", "scooter", {}),
    errors: [{ tab: "Types", key: APPENDED, column: "type_id" }],
  },
];

const RATE_CLASSES: RuleCase[] = [
  ...["Bike_125", "b".repeat(41)].map((slug) => ({
    name: `rate_class_id ${show(slug)} is not a slug`,
    mutate: set("RateClasses", "bike-125", "rate_class_id", slug),
    ...skipsRateClass("bike-125", "rate_class_id"),
  })),
  {
    name: "a rate class group that is not bike or car",
    mutate: set("RateClasses", "scooter-50", "group", "boat"),
    ...skipsRateClass("scooter-50", "group"),
  },
  {
    name: "a negative extension_per_hour_jpy",
    mutate: set("RateClasses", "car-k", "extension_per_hour_jpy", -1),
    ...skipsRateClass("car-k", "extension_per_hour_jpy"),
  },
  {
    name: "a duplicate rate class keeps the first row",
    mutate: (workbook: Workbook) => appendCopy(workbook, "RateClasses", "bike-400", {}),
    errors: [{ tab: "RateClasses", key: APPENDED, column: "rate_class_id" }],
  },
];

const PACKAGES: RuleCase[] = [
  {
    name: "package_id that is not a slug",
    mutate: set("Packages", "hours-6", "package_id", "Hours_6"),
    ...skipsPackage("hours-6", "package_id"),
  },
  {
    name: "a package past its day limit",
    mutate: set("Packages", "day-3", "days", 61),
    ...skipsPackage("day-3", "days"),
  },
  {
    name: "a duplicate package keeps the first row",
    mutate: (workbook: Workbook) => appendCopy(workbook, "Packages", "day-1", {}),
    errors: [{ tab: "Packages", key: APPENDED, column: "package_id" }],
  },
];

const PRICES: RuleCase[] = [
  {
    name: "a price with an unknown rate class",
    mutate: set("Prices", "bike-400/day-1", "rate_class_id", "ghost"),
    errors: [{ tab: "Prices", key: "bike-400/day-1", column: "rate_class_id" }],
    drop: { prices: ["bike-400/day-1"] },
  },
  {
    name: "a price with an unknown package",
    mutate: set("Prices", "car-k/day-3", "package_id", "ghost"),
    errors: [{ tab: "Prices", key: "car-k/day-3", column: "package_id" }],
    drop: { prices: ["car-k/day-3"] },
  },
  ...[0, -100, "¥0", "free", "¥", "12a", 1000.5, ""].map((price) => ({
    name: `price_jpy ${show(price)}`,
    mutate: set("Prices", "scooter-50/day-3", "price_jpy", price),
    errors: [{ tab: "Prices", key: "scooter-50/day-3", column: "price_jpy" }],
    drop: { prices: ["scooter-50/day-3"] },
  })),
  {
    name: "a second price for one pair keeps the first row",
    mutate: (workbook: Workbook) => appendRow(workbook, "Prices", {
      rate_class_id: "bike-125",
      package_id: "day-1",
      price_jpy: 9999,
    }),
    errors: [{ tab: "Prices", key: APPENDED, column: ["rate_class_id", "package_id"] }],
  },
];

const OPTIONS: RuleCase[] = [
  {
    name: "option_id that is not a slug",
    mutate: set("Options", "helmet", "option_id", "Helmet!"),
    errors: [{ tab: "Options", key: "helmet", column: "option_id" }],
    drop: { options: ["helmet"] },
  },
  {
    name: "an option group that is not bike or car",
    mutate: set("Options", "child-seat", "group", "boat"),
    errors: [{ tab: "Options", key: "child-seat", column: "group" }],
    drop: { options: ["child-seat"] },
  },
  ...[-1, ""].map((base) => ({
    name: `base_jpy ${show(base)}`,
    mutate: set("Options", "helmet", "base_jpy", base),
    errors: [{ tab: "Options", key: "helmet", column: "base_jpy" }],
    drop: { options: ["helmet"] },
  })),
  {
    name: "a negative extra_per_hour_jpy",
    mutate: set("Options", "child-seat", "extra_per_hour_jpy", -5),
    errors: [{ tab: "Options", key: "child-seat", column: "extra_per_hour_jpy" }],
    drop: { options: ["child-seat"] },
  },
  {
    name: "a non-numeric extra_per_24h_jpy",
    mutate: set("Options", "child-seat", "extra_per_24h_jpy", "a lot"),
    errors: [{ tab: "Options", key: "child-seat", column: "extra_per_24h_jpy" }],
    drop: { options: ["child-seat"] },
  },
  {
    name: "a duplicate option keeps the first row",
    mutate: (workbook: Workbook) => appendCopy(workbook, "Options", "helmet", {}),
    errors: [{ tab: "Options", key: APPENDED, column: "option_id" }],
  },
];

const CANCELLATION: RuleCase[] = [
  ...[101, 150, -1, 12.5, "half", ""].map((percent) => ({
    name: `refund_percent ${show(percent)}`,
    mutate: set("Cancellation", "3", "refund_percent", percent),
    errors: [{ tab: "Cancellation", key: "3", column: "refund_percent" }],
    drop: { cancellationTiers: [3] },
  })),
  ...[-1, 1.5, ""].map((days) => ({
    name: `min_days_before ${show(days)}`,
    mutate: set("Cancellation", "7", "min_days_before", days),
    errors: [{ tab: "Cancellation", key: "7", column: "min_days_before" }],
    drop: { cancellationTiers: [7] },
  })),
  {
    name: "a duplicate tier keeps the first row",
    mutate: (workbook: Workbook) => appendRow(workbook, "Cancellation", { min_days_before: 3, refund_percent: 25 }),
    errors: [{ tab: "Cancellation", key: APPENDED, column: "min_days_before" }],
  },
];

function badConfig(key: string, value: unknown): RuleCase {
  return {
    name: `Config ${key} ${show(value)}`,
    mutate: set("Config", key, "value", value),
    errors: [{ tab: "Config", key, column: key }],
    fatal: key,
  };
}

const CONFIG: RuleCase[] = [
  ...["25:00", "12:60", "noon"].flatMap((time) => [badConfig("shop_open", time), badConfig("shop_close", time)]),
  ...["09:00", "08:59"].map((time) => badConfig("shop_close", time)),
  badConfig("shop_close", 0.25),
  {
    name: "shop_open as a serial at the same time as shop_close",
    mutate: set("Config", "shop_open", "value", 0.75),
    errors: [{ tab: "Config", key: "shop_close", column: "shop_close" }],
    fatal: "shop_close",
  },
  ...["slot_minutes", "hold_minutes", "photo_max_mb"].flatMap((key) =>
    [0, -5, 1.5, "abc", ""].map((value) => badConfig(key, value)),
  ),
  ...["turnaround_minutes", "min_lead_hours", "max_days_ahead"].flatMap((key) =>
    [-1, 1.5, "abc", ""].map((value) => badConfig(key, value)),
  ),
];

const CLOSED_DATES: RuleCase[] = [
  ...["soon", "2026-02-30", "2026-13-01", true, 1e12].map((date) => ({
    name: `closed date ${show(date)} is not a date`,
    mutate: set("ClosedDates", "2027-01-01", "date", date),
    errors: [{ tab: "ClosedDates", key: "2027-01-01", column: "date" }],
    drop: { closedDates: ["2027-01-01"] },
  })),
  {
    name: "a closed date repeated as text keeps the first row",
    mutate: (workbook: Workbook) => appendRow(workbook, "ClosedDates", { date: "2027-01-01" }),
    errors: [{ tab: "ClosedDates", key: APPENDED, column: "date" }],
  },
  {
    name: "a closed date repeated as text after its serial keeps the first row",
    mutate: (workbook: Workbook) => appendRow(workbook, "ClosedDates", { date: "2026-12-31" }),
    errors: [{ tab: "ClosedDates", key: APPENDED, column: "date" }],
  },
];

export const RULE_TABLE: RuleCase[] = [
  ...MODELS,
  ...VEHICLES,
  ...TYPES,
  ...RATE_CLASSES,
  ...PACKAGES,
  ...PRICES,
  ...OPTIONS,
  ...CANCELLATION,
  ...CONFIG,
  ...CLOSED_DATES,
];

function only<T>(rows: T[], matches: (row: T) => boolean): T {
  const found = rows.find(matches);
  if (found === undefined) throw new Error("the fixture has no such row");
  return found;
}

const FORTY_CHARACTERS = "a".repeat(40);

export const ACCEPTED_BOUNDARIES: BoundaryCase[] = [
  {
    name: "a slug of exactly 40 characters",
    mutate: set("Options", "child-seat", "option_id", FORTY_CHARACTERS),
    change: (catalog) => {
      only(catalog.options, (option) => option.id === "child-seat").id = FORTY_CHARACTERS;
    },
  },
  {
    name: "shop_close one minute after shop_open",
    mutate: set("Config", "shop_close", "value", "09:01"),
    change: (catalog) => {
      catalog.config.shopClose = "09:01";
    },
  },
  {
    name: "slot_minutes of 1",
    mutate: set("Config", "slot_minutes", "value", 1),
    change: (catalog) => {
      catalog.config.slotMinutes = 1;
    },
  },
  {
    name: "hold_minutes of 1",
    mutate: set("Config", "hold_minutes", "value", 1),
    change: (catalog) => {
      catalog.config.holdMinutes = 1;
    },
  },
  {
    name: "photo_max_mb of 1",
    mutate: set("Config", "photo_max_mb", "value", 1),
    change: (catalog) => {
      catalog.config.photoMaxMb = 1;
    },
  },
  {
    name: "turnaround_minutes of 0",
    mutate: set("Config", "turnaround_minutes", "value", 0),
    change: (catalog) => {
      catalog.config.turnaroundMinutes = 0;
    },
  },
  {
    name: "min_lead_hours of 0",
    mutate: set("Config", "min_lead_hours", "value", 0),
    change: (catalog) => {
      catalog.config.minLeadHours = 0;
    },
  },
  {
    name: "max_days_ahead of 0",
    mutate: set("Config", "max_days_ahead", "value", 0),
    change: (catalog) => {
      catalog.config.maxDaysAhead = 0;
    },
  },
  {
    name: "a deposit of 0",
    mutate: set("Types", "car", "deposit_jpy", 0),
    change: (catalog) => {
      only(catalog.vehicleTypes, (type) => type.id === "car").depositJpy = 0;
    },
  },
  {
    name: "a price of 1",
    mutate: set("Prices", "car-k/day-1", "price_jpy", 1),
    change: (catalog) => {
      only(catalog.prices, (price) => price.rateClassId === "car-k" && price.packageId === "day-1").priceJpy = 1;
    },
  },
  {
    name: "refund_percent of 100 on a lower tier",
    mutate: set("Cancellation", "0", "refund_percent", 100),
    change: (catalog) => {
      only(catalog.cancellationTiers, (tier) => tier.minDaysBefore === 0).refundPercent = 100;
    },
  },
];

/** `catalog` without the rows `dropped` names. */
export function withoutDropped(catalog: Catalog, dropped: Dropped): Catalog {
  const keeps = <T>(names: T[] | undefined, name: T) => !(names ?? []).includes(name);
  return {
    ...catalog,
    vehicleTypes: catalog.vehicleTypes.filter(({ id }) => keeps(dropped.vehicleTypes, id)),
    rateClasses: catalog.rateClasses.filter(({ id }) => keeps(dropped.rateClasses, id)),
    models: catalog.models.filter(({ id }) => keeps(dropped.models, id)),
    vehicles: catalog.vehicles.filter(({ plate }) => keeps(dropped.vehicles, plate)),
    packages: catalog.packages.filter(({ id }) => keeps(dropped.packages, id)),
    prices: catalog.prices.filter(({ rateClassId, packageId }) => keeps(dropped.prices, `${rateClassId}/${packageId}`)),
    options: catalog.options.filter(({ id }) => keeps(dropped.options, id)),
    cancellationTiers: catalog.cancellationTiers.filter(({ minDaysBefore }) =>
      keeps(dropped.cancellationTiers, minDaysBefore),
    ),
    closedDates: catalog.closedDates.filter((date) => keeps(dropped.closedDates, date)),
  };
}
