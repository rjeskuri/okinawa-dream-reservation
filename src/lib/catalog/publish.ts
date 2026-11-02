// One Publish: reads the catalog tabs, checks them, replaces the catalog in D1 and writes each row's status back to the
// sheet, in that order. A bad row is left out and reported, and a fatal sheet stops before anything changes. It makes
// one batchGet, one D1 batch and one batchUpdate, because this runs with 10 ms of CPU. docs/sheet-schema.md is the
// staff's view of the statuses. Nothing here reads `env`.
import { replaceCatalog, type AffectedBooking } from "../db/catalog-store.ts";
import type { SheetsClient } from "../google/sheets.ts";
import { CATALOG_TABS, headerKey, STATUS, validateCatalog, type RowStatus } from "./sheet-schema.ts";

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

/**
 * Rejects with a PublishError on a failure, because a report answers 200. The writes are built before the commit, so
 * only the write itself can fail after `store`, and a failure anywhere else leaves the catalog alone.
 */
export async function publishCatalog({ db, sheets, now }: PublishDeps): Promise<PublishReport> {
  const workbook = await step("read", () => sheets.batchGet([...CATALOG_TABS]));

  const { catalog, statuses, fatal } = validateCatalog(workbook, now);
  if (catalog === null || fatal.length > 0) {
    return { ok: false, counts: { ok: 0, warning: 0, error: 0 }, fatal, affectedBookings: [] };
  }
  const rows = rowResults(statuses);
  const writes = statusWrites(workbook, rows);

  const stored = await step("store", () => replaceCatalog(db, catalog, { now, source: "sheet" }));
  await step("write-back", () => sheets.batchUpdate(writes));

  const { version, affectedBookings } = stored;
  return { ok: true, version, counts: countRows(rows), fatal: [], affectedBookings };
}
