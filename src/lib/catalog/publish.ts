// One Publish: reads the catalog tabs, checks them, replaces the catalog in D1 and writes each row's status back to the
// sheet, in that order. A bad row is left out and reported, and a fatal sheet stops before anything changes, but a bad
// Prices row keeps the price the site has (#135). It makes one batchGet, one D1 batch and one batchUpdate, plus one D1
// read when a Prices row is bad, because this runs with 10 ms of CPU. docs/sheet-schema.md is the staff's view of the
// statuses. Nothing here reads `env`.
import { readPrices, replaceCatalog, type AffectedBooking } from "../db/catalog-store.ts";
import type { SheetsClient } from "../google/sheets.ts";
import type { Price } from "../types.ts";
import {
  CATALOG_TABS, headerKey, STATUS, validateCatalog, type RowStatus, type SkippedPriceKey,
} from "./sheet-schema.ts";

type PublishDeps = { db: D1Database; sheets: SheetsClient; now: number };

export type PublishReport = {
  ok: boolean;
  version?: number;
  counts: { ok: number; warning: number; error: number };
  fatal: string[];
  affectedBookings: AffectedBooking[];
};

/** `write-back` is the only step after the commit: `read` has changed nothing, and a failed `store` rolled back. */
export type PublishStep = "read" | "store" | "write-back";

/** Names the step that failed, since that decides what staff must hear. The original error is on `cause`. */
export class PublishError extends Error {
  readonly step: PublishStep;

  constructor(step: PublishStep, cause: unknown) {
    super(`Publish failed at the ${step} step`, { cause });
    this.name = "PublishError";
    this.step = step;
  }
}

/** One row, however many messages it has. */
type RowResult = { tab: string; row: number; level: RowStatus["level"]; cell: string };

/** Sorts a row's worst message first, so its cell opens with the level that says whether the row published. */
const SEVERITY = { error: 0, warning: 1, ok: 2 };

async function step<T>(name: PublishStep, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new PublishError(name, error);
  }
}

function rowResult(statuses: RowStatus[]): RowResult {
  const ordered = statuses.toSorted((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
  const [{ tab, row, level }] = ordered;
  return {
    tab,
    row,
    level,
    cell: level === "ok" ? "ok" : ordered.map((status) => `${status.level}: ${status.message}`).join("; "),
  };
}

/** Each row once, under its worst level: validateCatalog gives every data row a status, and a row one per message. */
function rowResults(statuses: RowStatus[]): RowResult[] {
  return [...Map.groupBy(statuses, ({ tab, row }) => `${tab} ${row}`).values()].map(rowResult);
}

function countRows(rows: RowResult[]): PublishReport["counts"] {
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const { level } of rows) counts[level] += 1;
  return counts;
}

/** A column's A1 name from its 0-based index: 25 is Z, 26 is AA. */
function columnName(index: number): string {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

/**
 * One range per tab that has data, from row 2 to its last data row, so a stale message above that row goes. A blank row
 * gets "": Google skips null in a RAW write, which would leave its old message standing.
 */
function statusWrites(workbook: Record<string, unknown[][]>, rows: RowResult[]) {
  return [...Map.groupBy(rows, ({ tab }) => tab)].map(([tab, tabRows]) => {
    const column = columnName(workbook[tab][0].findIndex((name) => headerKey(name) === STATUS));
    const lastRow = Math.max(...tabRows.map(({ row }) => row));
    const values = Array.from({ length: lastRow - 1 }, () => [""]);
    for (const { row, cell } of tabRows) values[row - 2] = [cell];
    return { range: `'${tab}'!${column}2:${column}${lastRow}`, values };
  });
}

const yen = (jpy: number): string => jpy.toLocaleString("en-US");

/**
 * What the site does for each Prices row skipped for an error of its own, by sheet row: it keeps the stored price and
 * advance price unchanged (#135), or, with none stored, the package cannot be booked on that rate class.
 */
function keptPriceNotes(skipped: SkippedPriceKey[], kept: Price[]): Map<number, string> {
  const keptByKey = new Map(kept.map((price) => [`${price.rateClassId}/${price.packageId}`, price]));
  return new Map(
    skipped.map(({ rateClassId, packageId, row }) => {
      const price = keptByKey.get(`${rateClassId}/${packageId}`);
      if (price === undefined) return [row, "there is no published price to keep, so this package is not bookable"];
      const advance = price.advancePriceJpy === null ? "" : ` and advance price ${yen(price.advancePriceJpy)}`;
      return [row, `the site keeps the last published price ${yen(price.priceJpy)}${advance}`];
    }),
  );
}

/**
 * Rejects with a PublishError on a failure, because a report answers 200. The writes are built before the commit, so
 * only the write itself can fail after `store`, and a failure anywhere else leaves the catalog alone.
 */
export async function publishCatalog({ db, sheets, now }: PublishDeps): Promise<PublishReport> {
  const workbook = await step("read", () => sheets.batchGet([...CATALOG_TABS]));

  const { catalog, statuses, fatal, skippedPriceKeys } = validateCatalog(workbook, now);
  if (catalog === null || fatal.length > 0) {
    return { ok: false, counts: { ok: 0, warning: 0, error: 0 }, fatal, affectedBookings: [] };
  }
  // A D1 failure here has changed nothing, as at `store`.
  const kept = skippedPriceKeys.length === 0 ? [] : await step("store", () => readPrices(db, skippedPriceKeys));
  const notes = keptPriceNotes(skippedPriceKeys, kept);
  const rows = rowResults(statuses).map((row) => {
    const note = row.tab === "Prices" ? notes.get(row.row) : undefined;
    return note === undefined ? row : { ...row, cell: `${row.cell}; ${note}` };
  });
  const writes = statusWrites(workbook, rows);

  const published = { ...catalog, prices: [...catalog.prices, ...kept] };
  const stored = await step("store", () => replaceCatalog(db, published, { now, source: "sheet" }));
  await step("write-back", () => sheets.batchUpdate(writes));

  const { version, affectedBookings } = stored;
  return { ok: true, version, counts: countRows(rows), fatal: [], affectedBookings };
}
