// The listing's query params: parseSearch reads them against the catalog and the pickup window, and the functions below
// turn the result into what the page asks searchAvailability, lists, preselects and links to.
import { CC_BANDS, type AvailabilityQuery, type AvailableModel, type CcBand } from "./booking/availability.ts";
import { pickupWindowError, type PickupWindowReason } from "./booking/pickup-window.ts";
import { jstToEpoch, parseHHmm } from "./time.ts";
import type { Catalog, Model, Package, Price, ShopConfig, VehicleTypeId } from "./types.ts";

/** Each is the name of a query param. */
export type SearchField = "date" | "time" | "package" | "type" | "cc" | "class";

export type SearchError = { field: SearchField; reason: PickupWindowReason | "INVALID" };

/** An absent or invalid param is undefined, which is also what AvailabilityQuery takes for "no filter". */
export type ParsedSearch = {
  date?: string;
  time?: string;
  packageId?: string;
  typeId?: VehicleTypeId;
  ccBand?: CcBand;
  rateClassId?: string;
  /**
   * With a type and no package, a pickup the window accepts sets this: each class to search, by id, with the id of its
   * default package. It can be empty, a search that finds nothing.
   */
  classPackages?: Map<string, string>;
  errors: SearchError[];
};

type DayPackage = Package & { days: number };

/** Whether the engine (cc) filter applies to a type: a car is chosen by class and an e-bike has no engine. */
export function hasEngineBand(typeId: VehicleTypeId): boolean {
  return typeId !== "car" && typeId !== "ebike";
}

const TIME_FIELD_REASONS: readonly PickupWindowReason[] = ["OFF_SLOT", "OUTSIDE_HOURS"];

function parses(parse: (value: string) => unknown, value: string): boolean {
  try {
    parse(value);
    return true;
  } catch {
    return false;
  }
}

/** Reads a param through `find`, which returns undefined for a value it refuses. An empty param counts as absent. */
export function paramReader<Field extends string>(params: URLSearchParams, onInvalid: (field: Field) => void) {
  return <T>(field: Field, find: (value: string) => T | undefined): T | undefined => {
    const value = params.get(field);
    if (value === null || value === "") return undefined;
    const found = find(value);
    if (found === undefined) onInvalid(field);
    return found;
  };
}

/** A class's default package, the one its card is priced on with none chosen: its first day package with a price. */
function defaultPackage(packages: Package[], prices: Price[], rateClassId: string): DayPackage | undefined {
  const priced = ({ id }: Package) => prices.some((entry) => entry.rateClassId === rateClassId && entry.packageId === id);
  return packages.filter((pkg): pkg is DayPackage => pkg.days !== null).find(priced);
}

/**
 * The window of a pickup with a type and no package. Only the return date depends on a package, so everything else refuses
 * the pickup as it would with one. A class whose default package returns on a closed date is left out, and only a type with
 * no class left to search for that reason is refused, since a type with no class to begin with has no return to blame.
 */
function typeWindow(
  { packages, prices, models }: Pick<Catalog, "packages" | "prices" | "models">,
  typeId: VehicleTypeId,
  config: ShopConfig,
  closedDates: string[],
  startAt: number,
  now: number,
): { refusal: PickupWindowReason | null; classPackages?: Map<string, string> } {
  // A one-day rental returns on the pickup day, so this is every check but the return. It comes first because the calendar
  // helpers throw on a start the clock checks refuse.
  const refusal = pickupWindowError(config, closedDates, startAt, 1, now);
  if (refusal !== null) return { refusal };

  const classIds = new Set(models.filter((m) => m.active && m.typeId === typeId).map(({ rateClassId }) => rateClassId));
  const defaults = [...classIds].flatMap((rateClassId) => {
    const pkg = defaultPackage(packages, prices, rateClassId);
    return pkg === undefined ? [] : [{ rateClassId, pkg }];
  });
  const open = defaults.filter(({ pkg }) => pickupWindowError(config, closedDates, startAt, pkg.days, now) === null);
  if (defaults.length > 0 && open.length === 0) return { refusal: "CLOSED_RETURN" };
  return { refusal: null, classPackages: new Map(open.map(({ rateClassId, pkg }) => [rateClassId, pkg.id])) };
}

/**
 * The params of a listing request. The pickup window is checked only for a valid date and time with a valid day package, or
 * with a valid type and no package at all, and the date or time it refuses comes back undefined like any other invalid
 * param. An hours package has no return day until task #50, so it has no window to check. cc means nothing for a car or an
 * e-bike (the guest may have left a band behind when switching type), so it is dropped.
 */
export function parseSearch(
  params: URLSearchParams,
  catalog: Pick<Catalog, "packages" | "prices" | "models" | "vehicleTypes" | "rateClasses">,
  config: ShopConfig,
  closedDates: string[],
  now: number,
): ParsedSearch {
  const errors: SearchError[] = [];
  const read = paramReader<SearchField>(params, (field) => errors.push({ field, reason: "INVALID" }));

  let date = read("date", (value) => (parses(jstToEpoch, value) ? value : undefined));
  // parseHHmm takes H:mm too, and the param is HH:mm.
  let time = read("time", (value) => (value.length === 5 && parses(parseHHmm, value) ? value : undefined));
  const pkg = read("package", (value) => catalog.packages.find(({ id }) => id === value));
  const typeId = read("type", (value) => catalog.vehicleTypes.find(({ id }) => id === value)?.id);
  const ccBand = read("cc", (value) => (Object.hasOwn(CC_BANDS, value) ? (value as CcBand) : undefined));
  const rateClassId = read("class", (value) => catalog.rateClasses.find(({ id }) => id === value)?.id);

  let refusal: PickupWindowReason | null = null;
  let classPackages: Map<string, string> | undefined;
  if (date !== undefined && time !== undefined) {
    const startAt = jstToEpoch(date, time);
    if (pkg !== undefined && pkg.days !== null) {
      refusal = pickupWindowError(config, closedDates, startAt, pkg.days, now);
    } else if (pkg === undefined && typeId !== undefined && !errors.some(({ field }) => field === "package")) {
      ({ refusal, classPackages } = typeWindow(catalog, typeId, config, closedDates, startAt, now));
    }
  }
  if (refusal !== null && TIME_FIELD_REASONS.includes(refusal)) {
    errors.push({ field: "time", reason: refusal });
    time = undefined;
  } else if (refusal !== null) {
    errors.push({ field: "date", reason: refusal });
    date = undefined;
  }

  const band = typeId !== undefined && !hasEngineBand(typeId) ? undefined : ccBand;
  return { date, time, packageId: pkg?.id, typeId, ccBand: band, rateClassId, classPackages, errors };
}

/**
 * The searches to run, or null without a complete and valid one: a date and time with a package, which is one search, or
 * with classPackages, which is one search for each package the classes default to.
 */
function availabilityQueries(search: ParsedSearch, now: number): AvailabilityQuery[] | null {
  const { date, time, packageId, classPackages, typeId, ccBand, errors } = search;
  const packageIds = packageId === undefined ? classPackages && new Set(classPackages.values()) : [packageId];
  if (errors.length > 0 || date === undefined || time === undefined || packageIds === undefined) return null;
  return [...packageIds].map((id) => ({ startAt: jstToEpoch(date, time), packageId: id, typeId, ccBand, now }));
}

/**
 * What a complete, valid search finds, or null without one. `find` runs one search. With classPackages a model counts only in
 * the search of its own class's package, and the result follows `models`, not the searches: readCatalog returns them by sort,
 * then id, the order of one search.
 */
export async function findModels(
  search: ParsedSearch,
  models: Model[],
  now: number,
  find: (query: AvailabilityQuery) => Promise<AvailableModel[]>,
): Promise<AvailableModel[] | null> {
  const queries = availabilityQueries(search, now);
  if (queries === null) return null;
  const searched = await Promise.all(queries.map(async (query) => [query.packageId, await find(query)] as const));
  const { classPackages } = search;
  if (classPackages === undefined) return searched.flatMap(([, found]) => found);

  const foundOn = new Map(searched);
  return models.flatMap(({ id, rateClassId }) => {
    const found = foundOn.get(classPackages.get(rateClassId) ?? "");
    return found?.find(({ modelId }) => modelId === id) ?? [];
  });
}

/**
 * The models to show: what `found` holds, in its order, or every active model when no search ran. The class narrows both.
 * An invalid request drops its valid filters too, so a guest sees why nothing was filtered rather than a partial list.
 */
export function listedModels(models: Model[], search: ParsedSearch, found: AvailableModel[] | null): Model[] {
  const listed =
    found === null
      ? models.filter(({ active }) => active)
      : found.flatMap(({ modelId }) => models.find(({ id }) => id === modelId) ?? []);
  const { rateClassId, errors } = search;
  return rateClassId === undefined || errors.length > 0
    ? listed
    : listed.filter((model) => model.rateClassId === rateClassId);
}

/**
 * The package the guest chose, or undefined when none: the select starts on "Any", so no default is invented, not even for a
 * search that ran on each class's default package.
 */
export function chosenPackage(packages: Package[], search: ParsedSearch): Package | undefined {
  return packages.find(({ id }) => id === search.packageId);
}

/**
 * The package and price a card shows for its rate class. A chosen package prices every card, and a class without a price for
 * it gets none. With none chosen, each class takes its own first day package that has a price: bikes and cars have separate
 * packages, and an hours package never stands in. `packages` is in sort order, as readCatalog returns it.
 */
export function cardPrice(
  packages: Package[],
  prices: Price[],
  rateClassId: string,
  search: ParsedSearch,
): { pkg: Package; priceJpy: number } | undefined {
  const pkg = chosenPackage(packages, search) ?? defaultPackage(packages, prices, rateClassId);
  if (pkg === undefined) return undefined;
  const price = prices.find((entry) => entry.rateClassId === rateClassId && entry.packageId === pkg.id);
  return price && { pkg, priceJpy: price.priceJpy };
}

/** The search for a card to carry, `?` included, or "" when there is none. An invalid request carries nothing. */
export function carriedQuery(search: ParsedSearch): string {
  if (search.errors.length > 0) return "";
  const { date, time, packageId, typeId, ccBand, rateClassId } = search;
  const params = { date, time, package: packageId, type: typeId, cc: ccBand, class: rateClassId };
  const chosen = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return chosen.length === 0 ? "" : `?${new URLSearchParams(chosen)}`;
}
