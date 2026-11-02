// The sheet's tabs and the checks a row passes before it publishes, over the shape values.batchGet returns:
// docs/sheet-schema.md is the staff's view of the same rules. A bad row is reported and left out, and so is every row
// that depends on it. One pass over the cells with Map and Set lookups, because #15 runs this with 10 ms of CPU.
import type { Locale } from "../locale.ts";
import { epochToJst, formatHHmm, jstToEpoch, parseHHmm, sheetSerialToEpoch } from "../time.ts";
import type {
  CancellationTier, Catalog, LicenseClass, LocalizedTexts, Model, Option, Package, Price, RateClass, RateGroup,
  ShopConfig, Vehicle, VehicleStatus, VehicleType, VehicleTypeId,
} from "../types.ts";

export type RowStatus = { tab: string; row: number; level: "ok" | "warning" | "error"; message: string };

export type ValidBlock = {
  blockId: string;
  modelId: string;
  plate: string | null;
  startAt: number;
  endAt: number;
  channel: string;
  reference: string;
  note: string;
};

type Workbook = Record<string, unknown[][]>;

type Cell = string | number | boolean;

/** Each locale and the suffix of its columns: the sheet writes zh-cn as `_zh`. */
const LOCALE_SUFFIXES: [Locale, string][] = [["ja", "ja"], ["en", "en"], ["zh-cn", "zh"], ["ko", "ko"]];

function inEachLocale(field: string): string[] {
  return LOCALE_SUFFIXES.map(([, suffix]) => `${field}_${suffix}`);
}

const NAMES = inEachLocale("name");

const STATUS = "publish_status";

export const BOOKINGS_COLUMNS = [
  "booking_ref", "booking_id", "status", "source", "model_id", "plate", "override_plate", "override_status",
  "start", "end", "package_id", "guest_name", "guest_email", "guest_phone", "locale",
  "price_jpy", "deposit_jpy", "paid_jpy", "refund_jpy", "refund_status", "created_at", "updated_at",
] as const;

/** Every tab's headers, in order. Each one is required, also where the cell under it may be empty. */
export const SHEET_TABS = {
  Config: ["key", "value", STATUS],
  Types: ["type_id", "deposit_jpy", "sort", ...NAMES, STATUS],
  RateClasses: ["rate_class_id", "group", "sort", "extension_per_hour_jpy", ...NAMES, STATUS],
  Packages: ["package_id", "days", "hours", "sort", ...NAMES, STATUS],
  Prices: ["rate_class_id", "package_id", "price_jpy", STATUS],
  Models: [
    "model_id", "type_id", "rate_class_id", "brand", "seats", "engine_cc", "license_class", "sort", "active",
    ...NAMES, ...inEachLocale("summary"), ...inEachLocale("description"), "photos", STATUS,
  ],
  Vehicles: ["plate", "model_id", "status", "odometer_km", "base_usage_days", "notes", STATUS],
  Options: ["option_id", "group", "base_jpy", "extra_per_hour_jpy", "extra_per_24h_jpy", "sort", ...NAMES, STATUS],
  Cancellation: ["min_days_before", "refund_percent", STATUS],
  ClosedDates: ["date", "note", STATUS],
  Blocks: ["block_id", "model_id", "plate", "start", "end", "channel", "reference", "note", STATUS],
  Bookings: [...BOOKINGS_COLUMNS],
  Reconciliation: [
    "run_at", "counts", "type", "booking_ref", "payment_id", "refund_id", "expected_jpy", "actual_jpy", "detail",
  ],
  PublishLog: ["time", "user", "version", "counts", "blocks", "photos", "assignments", "message"],
} satisfies Record<string, string[]>;

type Tab = keyof typeof SHEET_TABS;

/** What one publish reads, each tab after those it depends on. */
const CATALOG_TABS = [
  "Config", "Types", "RateClasses", "Packages", "Prices", "Models", "Vehicles", "Options", "Cancellation",
  "ClosedDates",
] as const;

const TYPE_IDS: readonly VehicleTypeId[] = ["scooter", "motorcycle", "car"];
const GROUPS: readonly RateGroup[] = ["bike", "car"];
const VEHICLE_STATUSES: readonly VehicleStatus[] = ["active", "maintenance", "retired"];
const LICENSE_CLASSES: readonly LicenseClass[] = ["moped", "small", "standard", "large", "car"];

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 40;
const WHOLE_NUMBER = /^\d+$/;
const YEN = /^¥?(\d{1,3}(?:,\d{3})+|\d+)円?$/;
const DATE_TIME = /^(\S+) (\S+)$/;
const COMMAS = /[,，]/;
const MINUTES_PER_DAY = 1440;
const MOPED_OVERRIDE_MAX_CC = 125;

function show(value: unknown): string {
  return JSON.stringify(value);
}

/** The value of a time.ts parser, or null where it throws the RangeError of a bad value. */
function attempt<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** Text is normalized before any check, and "" stands for every kind of empty cell. */
function readCell(value: unknown): Cell {
  if (typeof value === "string") return value.normalize("NFKC").trim();
  return typeof value === "number" || typeof value === "boolean" ? value : "";
}

function wholeOf(cell: Cell): number {
  if (typeof cell === "number") return cell;
  return typeof cell === "string" && WHOLE_NUMBER.test(cell) ? Number(cell) : NaN;
}

function yenOf(cell: Cell): number {
  const match = typeof cell === "string" ? YEN.exec(cell) : null;
  return wholeOf(match === null ? cell : match[1].replaceAll(",", ""));
}

/**
 * One data row and what its checks found. A reader records an error for a bad cell and still returns a value of its
 * type, so one pass reports every problem in the row. `ok` then decides whether what was built from it is kept.
 */
class Row {
  readonly tab: string;
  readonly sheetRow: number;
  readonly cells: Map<string, Cell>;
  readonly raw: (column: string) => unknown;
  readonly statuses: RowStatus[] = [];
  ok = true;

  constructor(tab: string, sheetRow: number, cells: Map<string, Cell>, raw: (column: string) => unknown) {
    this.tab = tab;
    this.sheetRow = sheetRow;
    this.cells = cells;
    this.raw = raw;
  }

  error(message: string): void {
    this.ok = false;
    this.statuses.push({ tab: this.tab, row: this.sheetRow, level: "error", message });
  }

  warn(message: string): void {
    this.statuses.push({ tab: this.tab, row: this.sheetRow, level: "warning", message });
  }

  cell(column: string): Cell {
    return this.cells.get(column) ?? "";
  }

  blank(column: string): boolean {
    return this.cell(column) === "";
  }

  text(column: string): string {
    return String(this.cell(column));
  }

  required(column: string): string {
    if (this.blank(column)) this.error(`${column} is blank`);
    return this.text(column);
  }

  /** Claims `key` for this row, false if it cannot. The first row owns a key, whether that row was kept or not. */
  unique(column: string, key: string, seen: Set<string>): boolean {
    if (key === "") return false;
    if (seen.has(key)) {
      this.error(`${column} ${show(key)} repeats an earlier row`);
      return false;
    }
    seen.add(key);
    return true;
  }

  uniqueSlug(column: string, seen: Set<string>): string {
    const id = this.text(column);
    if (id.length > SLUG_MAX_LENGTH || !SLUG.test(id)) {
      this.error(`${column} ${show(id)} is not a slug: lower-case letters, digits and single hyphens, 40 at most`);
    }
    this.unique(column, id, seen);
    return id;
  }

  /** A reference to a kept row of `tab`, so a row that points at a skipped row is skipped too. */
  known(column: string, ids: Set<string>, tab: Tab): string {
    const id = this.text(column);
    if (!ids.has(id)) this.error(`${column} ${show(id)} has no valid row in ${tab}`);
    return id;
  }

  oneOf<T extends string>(column: string, allowed: readonly T[]): T {
    const value = this.text(column) as T;
    if (!allowed.includes(value)) this.error(`${column} ${show(value)} must be one of ${allowed.join(", ")}`);
    return value;
  }

  private inRange(column: string, value: number, min: number, max: number): number {
    if (this.blank(column)) {
      this.error(`${column} is blank`);
    } else if (!Number.isSafeInteger(value) || value < min || value > max) {
      const range = max === Infinity ? `of at least ${min}` : `from ${min} to ${max}`;
      this.error(`${column} ${show(this.cell(column))} must be a whole number ${range}`);
    }
    return value;
  }

  whole(column: string, min = 0, max = Infinity): number {
    return this.inRange(column, wholeOf(this.cell(column)), min, max);
  }

  money(column: string, min = 0): number {
    return this.inRange(column, yenOf(this.cell(column)), min, Infinity);
  }

  bool(column: string): boolean {
    const value = this.text(column).toUpperCase();
    if (value !== "TRUE" && value !== "FALSE") this.error(`${column} ${show(this.cell(column))} must be TRUE or FALSE`);
    return value === "TRUE";
  }

  /** HH:mm from text or from the fraction of a day that a time serial holds. */
  clock(column: string): string {
    const cell = this.cell(column);
    const time = attempt(() =>
      formatHHmm(typeof cell === "number" ? Math.round(cell * MINUTES_PER_DAY) : parseHHmm(String(cell))),
    );
    if (time === null) this.error(`${column} ${show(cell)} is not a time: use HH:mm`);
    return time ?? "";
  }

  /** YYYY-MM-DD from text or a serial, so one day written both ways reads equal. */
  date(column: string): string {
    const cell = this.cell(column);
    const date = attempt(
      () => epochToJst(typeof cell === "number" ? sheetSerialToEpoch(cell) : jstToEpoch(String(cell))).date,
    );
    if (date === null) this.error(`${column} ${show(cell)} is not a date: use YYYY-MM-DD`);
    return date ?? "";
  }

  /** The instant of a serial, or of text in YYYY-MM-DD HH:mm JST. */
  instant(column: string): number {
    const cell = this.cell(column);
    const instant = attempt(() => {
      if (typeof cell === "number") return sheetSerialToEpoch(cell);
      const match = DATE_TIME.exec(String(cell));
      return match && jstToEpoch(match[1], match[2]);
    });
    if (instant === null) this.error(`${column} ${show(cell)} is not a date and time: use YYYY-MM-DD HH:mm`);
    return instant ?? NaN;
  }

  /** Every field in every locale. A blank cell takes en, then ja, then whatever language the row does have. */
  texts<F extends string>(fields: readonly F[]): LocalizedTexts<Record<F, string>> {
    const texts = { ja: {}, en: {}, "zh-cn": {}, ko: {} } as LocalizedTexts<Record<F, string>>;
    for (const field of fields) {
      const inLocale = (suffix: string): string => this.text(`${field}_${suffix}`);
      const fallback = inLocale("en") || inLocale("ja") || inLocale("zh") || inLocale("ko");
      if (field === "name" && fallback === "") {
        this.error(`${inEachLocale(field).join(", ")}: no name in any language`);
        continue;
      }
      for (const [locale, suffix] of LOCALE_SUFFIXES) {
        if (inLocale(suffix) === "") this.warn(`${field}_${suffix}: missing translation, falling back to en, then ja`);
        texts[locale][field] = inLocale(suffix) || fallback;
      }
    }
    return texts;
  }
}

/**
 * The data rows of `tab`, or null with the reasons in `fatal` when its header row is missing or short. Blank rows are
 * left out, keeping the sheet numbers of the rows below them. Boolean false does not count as data, because Insert >
 * Checkbox on a whole column stores it in every empty row. publish_status is never read: a stale message there neither
 * fails a row nor keeps an otherwise blank one.
 */
function readTab(raw: Workbook, tab: Tab, fatal: string[]): Row[] | null {
  const [header, ...body] = raw[tab] ?? [];
  if (header === undefined) {
    fatal.push(`${tab}: the tab is missing or has no header row`);
    return null;
  }

  const indexes = new Map<string, number>();
  header.forEach((name, index) => {
    const column = String(readCell(name)).toLowerCase();
    if (!indexes.has(column)) indexes.set(column, index);
  });
  const columns: readonly string[] = SHEET_TABS[tab];
  const missing = columns.filter((column) => !indexes.has(column));
  fatal.push(...missing.map((column) => `${tab}: the header ${column} is missing`));
  if (missing.length > 0) return null;

  const dataColumns = columns.filter((column) => column !== STATUS);
  const rows: Row[] = [];
  body.forEach((cells, index) => {
    const raw = (column: string): unknown => cells[indexes.get(column) as number];
    const read = new Map(dataColumns.map((column) => [column, readCell(raw(column))]));
    if ([...read.values()].some((cell) => cell !== "" && cell !== false)) rows.push(new Row(tab, index + 2, read, raw));
  });
  return rows;
}

/** One status for a clean row, and otherwise whatever its checks reported. */
function statusesOf(rows: Row[]): RowStatus[] {
  return rows.flatMap((row): RowStatus[] =>
    row.statuses.length > 0 ? row.statuses : [{ tab: row.tab, row: row.sheetRow, level: "ok", message: "ok" }],
  );
}

/** What `read` builds from each row, for the rows that come through it without an error. */
function keep<T>(rows: Row[], read: (row: Row) => T): T[] {
  return rows.flatMap((row) => {
    const value = read(row);
    return row.ok ? [value] : [];
  });
}

function idsOf(rows: { id: string }[]): Set<string> {
  return new Set(rows.map(({ id }) => id));
}

/** Each Config key, the ShopConfig field it fills, and how its value reads. */
const CONFIG_KEYS = new Map<string, [keyof ShopConfig, (row: Row, key: string) => string | number]>([
  ["shop_open", ["shopOpen", (row, key) => row.clock(key)]],
  ["shop_close", ["shopClose", (row, key) => row.clock(key)]],
  ["slot_minutes", ["slotMinutes", (row, key) => row.whole(key, 1)]],
  ["turnaround_minutes", ["turnaroundMinutes", (row, key) => row.whole(key)]],
  ["hold_minutes", ["holdMinutes", (row, key) => row.whole(key, 1)]],
  ["min_lead_hours", ["minLeadHours", (row, key) => row.whole(key)]],
  ["max_days_ahead", ["maxDaysAhead", (row, key) => row.whole(key)]],
  ["photo_max_mb", ["photoMaxMb", (row, key) => row.whole(key, 1)]],
]);

/** The ShopConfig, or null with `fatal` naming each key that is absent or bad: a ShopConfig cannot go without one. */
function readConfig(rows: Row[], fatal: string[]): ShopConfig | null {
  const seen = new Set<string>();
  const found = new Map<keyof ShopConfig, string | number>();
  let closeRow: Row | undefined;
  for (const row of rows) {
    const key = row.required("key");
    row.unique("key", key, seen);
    const setting = CONFIG_KEYS.get(key);
    if (setting === undefined) {
      if (key !== "") row.warn(`key ${show(key)} is not a setting the site reads`);
      continue;
    }
    // The error then names the setting, where `value` would not say which row of the tab is wrong.
    row.cells.set(key, row.cell("value"));
    const [field, read] = setting;
    const value = read(row, key);
    if (row.ok) found.set(field, value);
    if (row.ok && field === "shopClose") closeRow = row;
  }

  const [open, close] = [found.get("shopOpen"), found.get("shopClose")];
  if (open !== undefined && close !== undefined && close <= open) {
    closeRow?.error(`shop_close ${close} must be after shop_open ${open}`);
    found.delete("shopClose");
  }

  const missing = [...CONFIG_KEYS].filter(([, [field]]) => !found.has(field)).map(([key]) => key);
  fatal.push(...missing.map((key) => `Config: ${key} is missing or invalid`));
  return missing.length === 0 ? (Object.fromEntries(found) as ShopConfig) : null;
}

function readTypes(rows: Row[]): VehicleType[] {
  const seen = new Set<string>();
  return keep(rows, (row) => {
    const id = row.oneOf("type_id", TYPE_IDS);
    row.unique("type_id", id, seen);
    return { id, depositJpy: row.money("deposit_jpy"), sort: row.whole("sort"), texts: row.texts(["name"]) };
  });
}

function readRateClasses(rows: Row[]): RateClass[] {
  const seen = new Set<string>();
  return keep(rows, (row) => ({
    id: row.uniqueSlug("rate_class_id", seen),
    grp: row.oneOf("group", GROUPS),
    sort: row.whole("sort"),
    extensionPerHourJpy: row.blank("extension_per_hour_jpy") ? null : row.money("extension_per_hour_jpy"),
    texts: row.texts(["name"]),
  }));
}

function readLength(row: Row): { days: number; hours: null } | { days: null; hours: number } {
  const [hasDays, hasHours] = [!row.blank("days"), !row.blank("hours")];
  if (hasDays === hasHours) row.error("days and hours: fill in exactly one of them");
  return hasDays ? { days: row.whole("days", 1, 60), hours: null } : { days: null, hours: row.whole("hours", 1, 72) };
}

function readPackages(rows: Row[]): Package[] {
  const seen = new Set<string>();
  return keep(rows, (row) => ({
    id: row.uniqueSlug("package_id", seen),
    sort: row.whole("sort"),
    ...readLength(row),
    texts: row.texts(["name"]),
  }));
}

function readPrices(rows: Row[], rateClassIds: Set<string>, packageIds: Set<string>): Price[] {
  const seen = new Set<string>();
  return keep(rows, (row) => {
    const rateClassId = row.known("rate_class_id", rateClassIds, "RateClasses");
    const packageId = row.known("package_id", packageIds, "Packages");
    row.unique("rate_class_id and package_id", `${rateClassId}/${packageId}`, seen);
    return { rateClassId, packageId, priceJpy: row.money("price_jpy", 1) };
  });
}

function licenseClassOfCc(cc: number): LicenseClass {
  if (cc <= 50) return "moped";
  if (cc <= 125) return "small";
  return cc <= 400 ? "standard" : "large";
}

function readLicenseClass(row: Row, typeId: string, engineCc: number): LicenseClass {
  const override = row.blank("license_class") ? null : row.oneOf("license_class", LICENSE_CLASSES);
  if (typeId === "car") {
    if (row.ok && override !== null && override !== "car") {
      row.warn(`license_class ${override} is ignored: a car is always car`);
    }
    return "car";
  }
  if (override === "car") row.error(`license_class car is only for type_id car`);
  if (override === "moped" && engineCc > MOPED_OVERRIDE_MAX_CC) {
    row.error(`license_class moped is only for engines up to ${MOPED_OVERRIDE_MAX_CC} cc`);
  }
  return override ?? licenseClassOfCc(engineCc);
}

/** Drive file names, which #17 matches against the Drive listing, so text in this one column skips normalizing. */
function readPhotos(row: Row): string[] {
  const cell = row.raw("photos");
  return (typeof cell === "string" ? cell : row.text("photos"))
    .split(COMMAS)
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

function readModels(rows: Row[], typeIds: Set<string>, rateClassIds: Set<string>): Model[] {
  const seen = new Set<string>();
  return keep(rows, (row) => {
    const id = row.uniqueSlug("model_id", seen);
    const typeId = row.known("type_id", typeIds, "Types") as VehicleTypeId;
    const engineCc = row.whole("engine_cc", 1);
    return {
      id,
      typeId,
      engineCc,
      licenseClass: readLicenseClass(row, typeId, engineCc),
      sort: row.whole("sort"),
      active: row.bool("active"),
      rateClassId: row.known("rate_class_id", rateClassIds, "RateClasses"),
      brand: row.required("brand"),
      seats: row.blank("seats") ? null : row.whole("seats", 1),
      texts: row.texts(["name", "summary", "description"]),
      photos: readPhotos(row),
    };
  });
}

function readVehicles(rows: Row[], modelIds: Set<string>): Vehicle[] {
  const seen = new Set<string>();
  return keep(rows, (row) => {
    const plate = row.required("plate");
    row.unique("plate", plate, seen);
    return {
      plate,
      modelId: row.known("model_id", modelIds, "Models"),
      status: row.oneOf("status", VEHICLE_STATUSES),
      odometerKm: row.blank("odometer_km") ? null : row.whole("odometer_km"),
      baseUsageDays: row.blank("base_usage_days") ? 0 : row.whole("base_usage_days"),
    };
  });
}

function readOptions(rows: Row[]): Option[] {
  const seen = new Set<string>();
  return keep(rows, (row) => ({
    id: row.uniqueSlug("option_id", seen),
    grp: row.oneOf("group", GROUPS),
    sort: row.whole("sort"),
    baseJpy: row.money("base_jpy"),
    extraPerHourJpy: row.blank("extra_per_hour_jpy") ? null : row.money("extra_per_hour_jpy"),
    extraPer24hJpy: row.blank("extra_per_24h_jpy") ? null : row.money("extra_per_24h_jpy"),
    texts: row.texts(["name"]),
  }));
}

function readCancellation(rows: Row[]): CancellationTier[] {
  const seen = new Set<string>();
  return keep(rows, (row) => {
    const minDaysBefore = row.whole("min_days_before");
    if (row.ok) row.unique("min_days_before", String(minDaysBefore), seen);
    return { minDaysBefore, refundPercent: row.whole("refund_percent", 0, 100) };
  });
}

function readClosedDates(rows: Row[]): string[] {
  const seen = new Set<string>();
  return keep(rows, (row) => {
    const date = row.date("date");
    row.unique("date", date, seen);
    return date;
  });
}

/**
 * Checks the catalog tabs. A tab or header problem stops the row checks, because every row below it would fail for the
 * same reason, but Config is still read so that `fatal` lists all that is wrong. A bad Config row leaves the catalog
 * null and the other tabs checked. `statuses` numbers rows as the sheet does.
 */
export function validateCatalog(raw: Workbook): { catalog: Catalog | null; statuses: RowStatus[]; fatal: string[] } {
  const fatal: string[] = [];
  const tabs = Object.fromEntries(CATALOG_TABS.map((tab) => [tab, readTab(raw, tab, fatal)]));
  const config = tabs.Config && readConfig(tabs.Config, fatal);
  if (Object.values(tabs).includes(null)) return { catalog: null, statuses: statusesOf(tabs.Config ?? []), fatal };

  const rows = tabs as Record<string, Row[]>;
  const vehicleTypes = readTypes(rows.Types);
  const rateClasses = readRateClasses(rows.RateClasses);
  const packages = readPackages(rows.Packages);
  const prices = readPrices(rows.Prices, idsOf(rateClasses), idsOf(packages));
  const models = readModels(rows.Models, idsOf(vehicleTypes), idsOf(rateClasses));
  const vehicles = readVehicles(rows.Vehicles, idsOf(models));
  const options = readOptions(rows.Options);
  const cancellationTiers = readCancellation(rows.Cancellation);
  const closedDates = readClosedDates(rows.ClosedDates);
  return {
    catalog: config && {
      config, vehicleTypes, rateClasses, models, vehicles, packages, prices, options, cancellationTiers, closedDates,
    },
    statuses: CATALOG_TABS.flatMap((tab) => statusesOf(rows[tab])),
    fatal,
  };
}

/**
 * Checks the Blocks tab against the published catalog. A broken tab is fatal, because #21 cancels any future block
 * missing from `blocks` and must not read it as deleted rows. For the same reason `skippedBlockIds` lists the id of
 * each rejected row, as `blockId` would hold it, so that #21 leaves those stored blocks alone. A blank channel,
 * reference or note passes: rejecting the row would free the bike it holds.
 */
export function validateBlocks(
  raw: Workbook,
  catalog: Catalog,
): { blocks: ValidBlock[]; statuses: RowStatus[]; fatal: string[]; skippedBlockIds: string[] } {
  const fatal: string[] = [];
  const rows = readTab(raw, "Blocks", fatal);
  if (rows === null) return { blocks: [], statuses: [], fatal, skippedBlockIds: [] };

  const modelIds = idsOf(catalog.models);
  const modelOfPlate = new Map(catalog.vehicles.map(({ plate, modelId }) => [plate, modelId]));
  const seen = new Set<string>();
  const skippedBlockIds: string[] = [];
  const blocks = keep(rows, (row) => {
    const blockId = row.required("block_id");
    const ownsId = row.unique("block_id", blockId, seen);
    const modelId = row.known("model_id", modelIds, "Models");
    const plate = row.text("plate");
    if (plate !== "" && modelOfPlate.get(plate) !== modelId) {
      row.error(`plate ${show(plate)} is not a vehicle of model ${show(modelId)}`);
    }
    const startAt = row.instant("start");
    const endAt = row.instant("end");
    if (endAt <= startAt) row.error("end must be after start");
    if (!row.ok && ownsId) skippedBlockIds.push(blockId);
    return {
      blockId,
      modelId,
      plate: plate || null,
      startAt,
      endAt,
      channel: row.text("channel"),
      reference: row.text("reference"),
      note: row.text("note"),
    };
  });
  return { blocks, statuses: statusesOf(rows), fatal, skippedBlockIds };
}
