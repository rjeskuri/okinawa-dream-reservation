// The listing's query params: parseSearch reads them against the catalog and the pickup window, and the functions below
// turn the result into what the page asks searchAvailability, lists, preselects and links to.
import { CC_BANDS, type AvailabilityQuery, type AvailableModel, type CcBand } from "./booking/availability.ts";
import { pickupWindowError, type PickupWindowReason } from "./booking/pickup-window.ts";
import { jstToEpoch, parseHHmm } from "./time.ts";
import type { Catalog, Model, Package, ShopConfig, VehicleTypeId } from "./types.ts";

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
  errors: SearchError[];
};

const TIME_FIELD_REASONS: readonly PickupWindowReason[] = ["OFF_SLOT", "OUTSIDE_HOURS"];

function parses(parse: (value: string) => unknown, value: string): boolean {
  try {
    parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The params of a listing request. An empty param counts as absent. The pickup window is checked only for a date, time and
 * day package that are each valid, and the date or time it refuses comes back undefined like any other invalid param. An
 * hours package has no return day until task #50, so it has no window to check. cc means nothing for a car (the guest may
 * have left a band behind when switching type), so it is dropped.
 */
export function parseSearch(
  params: URLSearchParams,
  catalog: Pick<Catalog, "packages" | "vehicleTypes" | "rateClasses">,
  config: ShopConfig,
  closedDates: string[],
  now: number,
): ParsedSearch {
  const errors: SearchError[] = [];
  const read = <T>(field: SearchField, find: (value: string) => T | undefined): T | undefined => {
    const value = params.get(field);
    if (value === null || value === "") return undefined;
    const found = find(value);
    if (found === undefined) errors.push({ field, reason: "INVALID" });
    return found;
  };

  let date = read("date", (value) => (parses(jstToEpoch, value) ? value : undefined));
  // parseHHmm takes H:mm too, and the param is HH:mm.
  let time = read("time", (value) => (value.length === 5 && parses(parseHHmm, value) ? value : undefined));
  const pkg = read("package", (value) => catalog.packages.find(({ id }) => id === value));
  const typeId = read("type", (value) => catalog.vehicleTypes.find(({ id }) => id === value)?.id);
  const ccBand = read("cc", (value) => (Object.hasOwn(CC_BANDS, value) ? (value as CcBand) : undefined));
  const rateClassId = read("class", (value) => catalog.rateClasses.find(({ id }) => id === value)?.id);

  if (date !== undefined && time !== undefined && pkg !== undefined && pkg.days !== null) {
    const reason = pickupWindowError(config, closedDates, jstToEpoch(date, time), pkg.days, now);
    if (reason !== null && TIME_FIELD_REASONS.includes(reason)) {
      errors.push({ field: "time", reason });
      time = undefined;
    } else if (reason !== null) {
      errors.push({ field: "date", reason });
      date = undefined;
    }
  }

  return { date, time, packageId: pkg?.id, typeId, ccBand: typeId === "car" ? undefined : ccBand, rateClassId, errors };
}

/** The search to run, or null without a complete and valid one. */
export function availabilityQuery(search: ParsedSearch, now: number): AvailabilityQuery | null {
  const { date, time, packageId, typeId, ccBand, errors } = search;
  if (errors.length > 0 || date === undefined || time === undefined || packageId === undefined) return null;
  return { startAt: jstToEpoch(date, time), packageId, typeId, ccBand, now };
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
 * The package the select shows and the cards price, so the two cannot disagree: the chosen one, else the first the search
 * can find something for. Hours packages sort first on the sheet, and a default that finds nothing would empty every search.
 */
export function shownPackage(packages: Package[], search: ParsedSearch): Package | undefined {
  return packages.find(({ id }) => id === search.packageId) ?? packages.find(({ days }) => days !== null) ?? packages[0];
}

/** The search for a card to carry, `?` included, or "" when there is none. An invalid request carries nothing. */
export function carriedQuery(search: ParsedSearch): string {
  if (search.errors.length > 0) return "";
  const { date, time, packageId, typeId, ccBand, rateClassId } = search;
  const params = { date, time, package: packageId, type: typeId, cc: ccBand, class: rateClassId };
  const chosen = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return chosen.length === 0 ? "" : `?${new URLSearchParams(chosen)}`;
}
