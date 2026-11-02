// The valid sheet fixture as a fresh workbook for each test, and small edits that keep the shape values.batchGet
// returns: the header row first, "" for an empty cell inside a row, and trailing empty cells left off. A row is named
// by its key cell, so a test never counts rows by hand, and the sheet row of a key is its index in the tab plus one.
import { readFileSync } from "node:fs";
import type { Catalog } from "../../src/lib/types.ts";

export type Workbook = Record<string, unknown[][]>;

/** The tabs one publish reads. Blocks has its own endpoint, and the Worker writes the others. */
export const CATALOG_TABS = [
  "Config",
  "Types",
  "RateClasses",
  "Packages",
  "Prices",
  "Models",
  "Vehicles",
  "Options",
  "Cancellation",
  "ClosedDates",
];

const FIXTURES = new URL("../fixtures/sheet/", import.meta.url);
const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** The cells that name a row. A key spanning two columns reads "bike-125/day-1". */
const KEY_COLUMNS: Record<string, string[]> = {
  Config: ["key"],
  Types: ["type_id"],
  RateClasses: ["rate_class_id"],
  Packages: ["package_id"],
  Prices: ["rate_class_id", "package_id"],
  Models: ["model_id"],
  Vehicles: ["plate"],
  Options: ["option_id"],
  Cancellation: ["min_days_before"],
  ClosedDates: ["date"],
  Blocks: ["block_id"],
};

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

export function validWorkbook(): Workbook {
  return readFixture<Workbook>("valid-workbook.json");
}

/** The catalog of the valid workbook, written out by hand. */
export function expectedCatalog(): Catalog {
  return readFixture<Catalog>("valid-catalog.json");
}

/** The serial of a JST wall clock: days since 1899-12-30, with the time of day as the fraction. */
export function sheetSerial(date: string, time = "00:00"): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return (Date.UTC(year, month - 1, day, hour, minute) - SHEET_EPOCH_MS) / DAY_MS;
}

function columnIndex(workbook: Workbook, tab: string, column: string): number {
  const index = workbook[tab][0].indexOf(column);
  if (index === -1) throw new Error(`${tab} has no column ${column}`);
  return index;
}

/** Drops trailing empty cells, as batchGet does, and fills any gap below them with "". */
function batchGetRow(row: unknown[]): unknown[] {
  const cells = Array.from(row, (cell) => cell ?? "");
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function keyOf(workbook: Workbook, tab: string, row: unknown[]): string {
  const columns = KEY_COLUMNS[tab].map((column) => columnIndex(workbook, tab, column));
  return columns.map((index) => String(row[index])).join("/");
}

/** The 1-based sheet row of the row named `key`. */
export function sheetRow(workbook: Workbook, tab: string, key: string): number {
  const index = workbook[tab].findIndex((row, at) => at > 0 && keyOf(workbook, tab, row) === key);
  if (index === -1) throw new Error(`${tab} has no row ${key}`);
  return index + 1;
}

export function setCell(workbook: Workbook, tab: string, key: string, column: string, value: unknown): void {
  const index = sheetRow(workbook, tab, key) - 1;
  const row = [...workbook[tab][index]];
  row[columnIndex(workbook, tab, column)] = value;
  workbook[tab][index] = batchGetRow(row);
}

/** A row of `tab` as batchGet returns it, its cells named by column. */
export function rowWith(workbook: Workbook, tab: string, cells: Record<string, unknown>): unknown[] {
  const row: unknown[] = [];
  for (const [column, value] of Object.entries(cells)) row[columnIndex(workbook, tab, column)] = value;
  return batchGetRow(row);
}

/** Adds a row below the last, its cells named by column. */
export function appendRow(workbook: Workbook, tab: string, cells: Record<string, unknown>): void {
  workbook[tab].push(rowWith(workbook, tab, cells));
}

/** Adds a copy of the row named `key` below the last, with `changes` over its cells. */
export function appendCopy(workbook: Workbook, tab: string, key: string, changes: Record<string, unknown>): void {
  const copy = [...workbook[tab][sheetRow(workbook, tab, key) - 1]];
  for (const [column, value] of Object.entries(changes)) copy[columnIndex(workbook, tab, column)] = value;
  workbook[tab].push(batchGetRow(copy));
}

export function removeRow(workbook: Workbook, tab: string, key: string): void {
  workbook[tab].splice(sheetRow(workbook, tab, key) - 1, 1);
}

export function removeColumn(workbook: Workbook, tab: string, column: string): void {
  const index = columnIndex(workbook, tab, column);
  workbook[tab] = workbook[tab].map((row) => batchGetRow(row.filter((_, at) => at !== index)));
}

/** Moves every column of `tab` to the place `reorder` gives its index, and respells each header through `respell`. */
export function rearrangeColumns(
  workbook: Workbook,
  tab: string,
  reorder: (indexes: number[]) => number[],
  respell: (header: string) => string,
): void {
  const [header, ...rows] = workbook[tab];
  const order = reorder(header.map((_, index) => index));
  workbook[tab] = [
    order.map((index) => respell(String(header[index]))),
    ...rows.map((row) => batchGetRow(order.map((index) => row[index]))),
  ];
}
