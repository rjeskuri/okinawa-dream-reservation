// The assignments step of Publish: one read of the Bookings tab, the overrides staff typed applied, and one batchUpdate
// of the override_status and plate cells of the rows that were touched. Columns are found by header, as for the
// Bookings sync, and an override cell is read by the sheet's rules for text, as the Vehicles plates were.
import { applyOverrides } from "../booking/overrides.ts";
import { headerKey, readCell } from "../catalog/sheet-schema.ts";
import type { SheetsClient } from "../google/sheets.ts";
import { columnLetters } from "./bookings-sync.ts";

type SyncDeps = { db: D1Database; sheets: SheetsClient; now: number };

export type AssignmentsResult = { applied: number; errors: { row: number; message: string }[] };

const TAB = "Bookings";
const NEEDED_COLUMNS = ["booking_id", "plate", "override_plate", "override_status"];

/** A cell as text. An unticked checkbox counts as blank, as it does on every tab. */
function textOf(value: unknown): string {
  const cell = readCell(value);
  return cell === false ? "" : String(cell);
}

/**
 * Applies the overrides on the tab. A blank override cell is skipped, and a row that matches its booking's plate in D1
 * is not touched, so a rerun changes nothing. A missing column moves nothing and is reported on the header row. A
 * failed write throws: the moves stand, and the Bookings sync writes their plates.
 */
export async function syncAssignments({ db, sheets, now }: SyncDeps): Promise<AssignmentsResult> {
  const [header = [], ...body] = (await sheets.batchGet([TAB]))[TAB] ?? [];
  const columnOf = (name: string): number => header.findIndex((cell) => headerKey(cell) === name);
  const missing = NEEDED_COLUMNS.filter((name) => columnOf(name) < 0);
  if (missing.length > 0) {
    return { applied: 0, errors: [{ row: 1, message: `${TAB}: the header ${missing.join(", ")} is missing` }] };
  }

  const [idAt, plateAt, overrideAt, statusAt] = NEEDED_COLUMNS.map(columnOf);
  const rows = body.flatMap((cells, index) => {
    const overridePlate = textOf(cells[overrideAt]);
    // Row 1 is the header.
    return overridePlate === "" ? [] : [{ row: index + 2, bookingId: textOf(cells[idAt]), overridePlate }];
  });
  const { results } = await applyOverrides(db, rows, now);

  const rangeOf = (column: number, row: number): string => `${TAB}!${columnLetters(column)}${row}`;
  const updates = results.flatMap(({ row, message, plate }) => [
    { range: rangeOf(statusAt, row), values: [[message]] },
    ...(plate === undefined ? [] : [{ range: rangeOf(plateAt, row), values: [[plate]] }]),
  ]);
  if (updates.length > 0) await sheets.batchUpdate(updates);

  const errors = results.filter(({ level }) => level === "error").map(({ row, message }) => ({ row, message }));
  return { applied: results.length - errors.length, errors };
}
