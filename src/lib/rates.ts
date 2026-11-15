// The fee schedule: parseRatesFilter reads the page's query params against the catalog, and buildFeeTable lays out the prices
// they ask for. src/scripts/rates.ts narrows the rendered table by the same rules.
import { paramReader } from "./search.ts";
import type { Catalog, Package, RateClass, RateGroup } from "./types.ts";

export const RATE_GROUPS: readonly RateGroup[] = ["bike", "car", "ebike"];

/** Each is the name of a query param. */
export type RatesField = "group" | "class" | "duration";

/** An absent or invalid param is undefined. */
export type RatesFilter = {
  group?: RateGroup;
  rateClassId?: string;
  packageId?: string;
  errors: { field: RatesField }[];
};

/** What buildFeeTable reads of a filter. */
type FeeFilter = {
  group?: string | null;
  rateClassId?: string | null;
  packageId?: string | null;
  errors: unknown[];
};

/** Both prices of a class and package (#131): null without a price row, and advancePriceJpy null on a row without one. */
export type FeeCell = { packageId: string; priceJpy: number | null; advancePriceJpy: number | null };

export type FeeRow = { rateClass: RateClass; cells: FeeCell[] };

/** One table. Each row's cells line up with `packages`. */
export type FeeGroup = { group: RateGroup; packages: Package[]; rows: FeeRow[] };

function bySort(a: { sort: number }, b: { sort: number }): number {
  return a.sort - b.sort;
}

/** The params of a fee schedule request. A class or package is valid if the catalog has it. */
export function parseRatesFilter(
  params: URLSearchParams,
  catalog: Pick<Catalog, "rateClasses" | "packages">,
): RatesFilter {
  const errors: RatesFilter["errors"] = [];
  const read = paramReader<RatesField>(params, (field) => errors.push({ field }));
  return {
    group: read("group", (value) => RATE_GROUPS.find((group) => group === value)),
    rateClassId: read("class", (value) => catalog.rateClasses.find(({ id }) => id === value)?.id),
    packageId: read("duration", (value) => catalog.packages.find(({ id }) => id === value)?.id),
    errors,
  };
}

/**
 * The tables to show, in sort order, with a null price for a class without that package. A group's columns are the packages
 * its classes are priced for, since the packages table does not say whose they are, and a class filter keeps those columns.
 * A group left with no price at all has no table. An invalid request drops its valid filters too, as the listing does.
 */
export function buildFeeTable(catalog: Pick<Catalog, "rateClasses" | "packages" | "prices">, filter: FeeFilter): FeeGroup[] {
  const { group, rateClassId, packageId }: Partial<FeeFilter> = filter.errors.length > 0 ? {} : filter;
  const classes = [...catalog.rateClasses].sort(bySort);
  const packages = [...catalog.packages].sort(bySort);
  const rowOf = (classId: string, pkgId: string) =>
    catalog.prices.find((row) => row.rateClassId === classId && row.packageId === pkgId);
  const priceOf = (classId: string, pkgId: string) => rowOf(classId, pkgId)?.priceJpy ?? null;
  const cellOf = (classId: string, pkgId: string): FeeCell => {
    const row = rowOf(classId, pkgId);
    return { packageId: pkgId, priceJpy: row?.priceJpy ?? null, advancePriceJpy: row?.advancePriceJpy ?? null };
  };

  return RATE_GROUPS.flatMap((grp) => {
    if (group && group !== grp) return [];
    const inGroup = classes.filter((rateClass) => rateClass.grp === grp);
    const columns = packages
      .filter(({ id }) => inGroup.some((rateClass) => priceOf(rateClass.id, id) !== null))
      .filter(({ id }) => !packageId || id === packageId);
    const rows = inGroup
      .filter(({ id }) => !rateClassId || id === rateClassId)
      .map((rateClass) => ({
        rateClass,
        cells: columns.map(({ id }) => cellOf(rateClass.id, id)),
      }));
    return rows.some(({ cells }) => cells.some(({ priceJpy }) => priceJpy !== null))
      ? [{ group: grp, packages: columns, rows }]
      : [];
  });
}
