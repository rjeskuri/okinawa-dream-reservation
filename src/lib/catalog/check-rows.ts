// The rows the sheet's "Add a bike" panel proposes, checked the way a publish would check them: each is added below its
// tab's last row and validateCatalog judges the whole sheet, so a proposed vehicle can rest on a proposed model. Only the
// proposed rows are answered, and nothing is written anywhere. Nothing here reads `env`.
import { CATALOG_TABS, headerKey, validateCatalog } from "./sheet-schema.ts";

export type CatalogTab = (typeof CATALOG_TABS)[number];

export type ProposedRows = Partial<Record<CatalogTab, Record<string, string | number | boolean>[]>>;

export type RowCheck = { level: "ok" | "warning" | "error"; messages: string[] };

export type CheckAnswer = { fatal: string[]; rows: Partial<Record<CatalogTab, RowCheck[]>> };

/** What one check may propose in all, across the tabs. */
const MAX_ROWS = 50;

const LEVELS: RowCheck["level"][] = ["ok", "warning", "error"];

function isCatalogTab(key: string): key is CatalogTab {
  return (CATALOG_TABS as readonly string[]).includes(key);
}

/** An object as JSON.parse builds one: no array, no class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRow(value: unknown): value is Record<string, string | number | boolean> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((cell) => typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean")
  );
}

/**
 * The payload's `rows` as ProposedRows, or null when it is not one: a tab outside CATALOG_TABS, a tab that is not an
 * array of plain objects, a value that is not a string, number or boolean, or more than MAX_ROWS rows in all.
 */
export function parseProposedRows(payloadRows: unknown): ProposedRows | null {
  if (!isPlainObject(payloadRows)) return null;
  let count = 0;
  for (const [tab, rows] of Object.entries(payloadRows)) {
    if (!isCatalogTab(tab) || !Array.isArray(rows) || !rows.every(isRow)) return null;
    count += rows.length;
  }
  return count > MAX_ROWS ? null : (payloadRows as ProposedRows);
}

/** Where each proposed row sits in its tab, as validateCatalog numbers sheet rows, and what it could not place. */
type Placed = { sheetRow: number; unknownKeys: string[] };

/**
 * One RowCheck per proposed row of each tab, in order, as validateCatalog judges `workbook` with them added below each
 * tab's last row. A value goes under the first header whose headerKey is its key, and a key with no such header makes its
 * row an error. A sheet with a fatal problem answers its reasons and no row. `workbook` is left as it was.
 */
export function checkProposedRows(workbook: Record<string, unknown[][]>, rows: ProposedRows, now: number): CheckAnswer {
  const merged: Record<string, unknown[][]> = { ...workbook };
  const placed = new Map<CatalogTab, Placed[]>();
  for (const tab of CATALOG_TABS) {
    const proposed = rows[tab];
    const grid = workbook[tab];
    if (proposed === undefined || proposed.length === 0 || grid === undefined || grid.length === 0) continue;

    const header = grid[0];
    const indexes = new Map<string, number>();
    header.forEach((name, index) => {
      const column = headerKey(name);
      if (!indexes.has(column)) indexes.set(column, index);
    });
    const added = proposed.map((row) => {
      const cells: unknown[] = header.map(() => "");
      const unknownKeys: string[] = [];
      for (const [key, value] of Object.entries(row)) {
        const index = indexes.get(key);
        if (index === undefined) unknownKeys.push(key);
        else cells[index] = value;
      }
      return { cells, unknownKeys };
    });
    merged[tab] = [...grid, ...added.map(({ cells }) => cells)];
    placed.set(tab, added.map(({ unknownKeys }, index) => ({ sheetRow: grid.length + index + 1, unknownKeys })));
  }

  const { statuses, fatal } = validateCatalog(merged, now);
  if (fatal.length > 0) return { fatal, rows: {} };

  const answer: CheckAnswer = { fatal: [], rows: {} };
  for (const tab of CATALOG_TABS) {
    const proposed = rows[tab];
    if (proposed === undefined) continue;
    const places = placed.get(tab) ?? [];
    answer.rows[tab] = places.map(({ sheetRow, unknownKeys }) => {
      const own = statuses.filter((status) => status.tab === tab && status.row === sheetRow);
      const checks = [
        ...unknownKeys.map((key) => ({ level: "error" as const, message: `${key}: ${tab} has no such column` })),
        ...own.filter(({ level }) => level !== "ok"),
      ];
      // validateCatalog leaves out a row with no data at all, so it reports nothing for one.
      if (own.length === 0) checks.push({ level: "error", message: "the row is blank, so a publish would skip it" });
      const level = LEVELS[Math.max(0, ...checks.map(({ level }) => LEVELS.indexOf(level)))];
      return { level, messages: checks.map(({ message }) => message) };
    });
  }
  return answer;
}
