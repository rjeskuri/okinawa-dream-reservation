// A fake SheetsClient that models a spreadsheet: tabs of cells, A1 ranges read and written the way the Sheets API does,
// and a record of every call and of every cell a call wrote. Tests assert on the cells that end up in the grid, not on
// how the code under test builds its calls. Row and column numbers in this file are zero-based.
import type { SheetsClient } from "../../src/lib/google/sheets.ts";

export type Call =
  | { method: "batchGet"; tabs: string[] }
  | { method: "batchUpdate"; data: { range: string; values: unknown[][] }[] }
  | { method: "append"; range: string; rows: unknown[][] };

export type CellWrite = { tab: string; row: number; col: number; via: "batchUpdate" | "append"; value: unknown };

export interface FakeSheets extends SheetsClient {
  calls: Call[];
  /** Every cell written by a batchUpdate or an append, in order. */
  writes: CellWrite[];
  /** A copy of a tab's rows, as stored, with "" for an empty cell inside a row. */
  grid(tab: string): unknown[][];
  /** What staff do by hand: set one cell without it counting as a call or a write. */
  setCell(tab: string, row: number, col: number, value: unknown): void;
  count(method: Call["method"]): number;
  /** The next call of `method` throws `error`, once. */
  failNext(method: Call["method"], error: unknown): void;
}

type Area = { tab: string; col1: number; col2: number | null; row1: number | null; row2: number | null };

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A1 notation: `Tab`, `'Tab'!A1`, `Tab!A1:B2`, `Tab!A:B`, `Tab!A5:V`, `Tab!5:5`. */
function parseRange(range: string): Area {
  const m = /^(?:'((?:[^']|'')*)'|([^'!]+))(?:!(.+))?$/.exec(range);
  if (m === null) throw new Error(`fake sheets: cannot read range ${range}`);
  const tab = m[1] === undefined ? m[2] : m[1].replaceAll("''", "'");
  const spec = m[3];
  if (spec === undefined) return { tab, col1: 0, col2: null, row1: null, row2: null };
  const rows = /^(\d+)(?::(\d+))?$/.exec(spec);
  if (rows !== null) {
    const row1 = Number(rows[1]) - 1;
    return { tab, col1: 0, col2: null, row1, row2: rows[2] === undefined ? row1 : Number(rows[2]) - 1 };
  }
  const cells = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(spec);
  if (cells === null) throw new Error(`fake sheets: cannot read range ${range}`);
  const col1 = colIndex(cells[1]);
  const row1 = cells[2] === undefined ? null : Number(cells[2]) - 1;
  if (cells[3] === undefined) {
    if (row1 === null) throw new Error(`fake sheets: cannot read range ${range}`);
    return { tab, col1, col2: col1, row1, row2: row1 };
  }
  return { tab, col1, col2: colIndex(cells[3]), row1, row2: cells[4] === undefined ? null : Number(cells[4]) - 1 };
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function trimTrailing(cells: unknown[]): unknown[] {
  const out = [...cells];
  while (out.length > 0 && isEmpty(out[out.length - 1])) out.pop();
  return out;
}

/** What survives JSON to the API as a cell: a string, a finite number or a boolean. Anything else is a bug. */
function checkValues(values: unknown[][], where: string): void {
  values.forEach((row, r) => {
    if (!Array.isArray(row)) throw new Error(`fake sheets: ${where} row ${r} is not an array`);
    row.forEach((value, c) => {
      const fine =
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value));
      if (!fine) throw new Error(`fake sheets: ${where} row ${r} column ${c} holds ${String(value)}`);
    });
  });
}

export function createFakeSheets(initial: Record<string, unknown[][]>): FakeSheets {
  const tabs: Record<string, unknown[][]> = {};
  for (const [name, rows] of Object.entries(initial)) tabs[name] = rows.map((row) => [...row]);
  const calls: Call[] = [];
  const writes: CellWrite[] = [];
  const failures: Record<string, unknown[]> = {};

  function tabRows(tab: string): unknown[][] {
    const rows = tabs[tab];
    if (rows === undefined) throw new Error(`fake sheets: no tab ${tab}`);
    return rows;
  }

  function put(tab: string, row: number, col: number, value: unknown): void {
    const rows = tabRows(tab);
    while (rows.length <= row) rows.push([]);
    while (rows[row].length <= col) rows[row].push("");
    rows[row][col] = value;
  }

  function lastUsedRow(tab: string): number {
    const rows = tabRows(tab);
    for (let r = rows.length - 1; r >= 0; r -= 1) if (rows[r].some((value) => !isEmpty(value))) return r;
    return -1;
  }

  function failIfAsked(method: Call["method"]): void {
    const queue = failures[method];
    if (queue !== undefined && queue.length > 0) throw queue.shift();
  }

  return {
    calls,
    writes,

    grid: (tab) => tabRows(tab).map((row) => [...row]),

    setCell: (tab, row, col, value) => put(tab, row, col, value),

    count: (method) => calls.filter((call) => call.method === method).length,

    failNext(method, error) {
      (failures[method] ??= []).push(error);
    },

    async batchGet(requested) {
      calls.push({ method: "batchGet", tabs: [...requested] });
      failIfAsked("batchGet");
      const out: Record<string, unknown[][]> = {};
      for (const request of requested) {
        const area = parseRange(request);
        const last = Math.min(area.row2 ?? Infinity, lastUsedRow(area.tab));
        const slice: unknown[][] = [];
        for (let r = area.row1 ?? 0; r <= last; r += 1) {
          const cells = tabRows(area.tab)[r] ?? [];
          slice.push(trimTrailing(cells.slice(area.col1, area.col2 === null ? undefined : area.col2 + 1)));
        }
        while (slice.length > 0 && slice[slice.length - 1].length === 0) slice.pop();
        out[area.tab] = slice;
      }
      return out;
    },

    async batchUpdate(data) {
      calls.push({ method: "batchUpdate", data: data.map(({ range, values }) => ({ range, values })) });
      failIfAsked("batchUpdate");
      for (const { range, values } of data) {
        const area = parseRange(range);
        if (area.row1 === null || area.row2 === null || area.col2 === null) {
          throw new Error(`fake sheets: batchUpdate range ${range} is not bounded`);
        }
        checkValues(values, `batchUpdate ${range}`);
        if (values.length > area.row2 - area.row1 + 1) throw new Error(`fake sheets: too many rows for ${range}`);
        values.forEach((row, r) => {
          if (row.length > area.col2! - area.col1 + 1) throw new Error(`fake sheets: too many columns for ${range}`);
          row.forEach((value, c) => {
            put(area.tab, area.row1! + r, area.col1 + c, value);
            writes.push({ tab: area.tab, row: area.row1! + r, col: area.col1 + c, via: "batchUpdate", value });
          });
        });
      }
    },

    async append(range, rows) {
      calls.push({ method: "append", range, rows: rows.map((row) => [...row]) });
      failIfAsked("append");
      const area = parseRange(range);
      checkValues(rows, `append ${range}`);
      const first = lastUsedRow(area.tab) + 1;
      rows.forEach((row, r) => {
        if (area.col2 !== null && row.length > area.col2 - area.col1 + 1) {
          throw new Error(`fake sheets: too many columns for ${range}`);
        }
        row.forEach((value, c) => {
          put(area.tab, first + r, area.col1 + c, value);
          writes.push({ tab: area.tab, row: first + r, col: area.col1 + c, via: "append", value });
        });
      });
    },
  };
}
