// D1's bookings against the Bookings tab, for the daily cron (#44). The window is every CONFIRMED or CANCELLED booking
// whose rental ends in the last 35 days or later. A booking of the window that is not on the tab is appended, and a row
// whose cells the Worker owns differ from D1 is rewritten, whatever its updated_at cell says: that cell is minute-precise,
// a refund settling leaves it as it was, and staff can type over any cell. The override and staff columns are never
// written. Only staff can act on the rest, so it is reported and left as it is: a row whose booking_id no booking in D1
// has, and an override_plate that is not the booking's plate yet. One read of the tab, one D1 batch, one batchUpdate and
// one append, whatever the number of rows.
import type { SheetsClient } from "../google/sheets.ts";
import { textOf } from "../sheets/assignments-sync.ts";
import { appendRange, appendedRow, readTab, rowOf, rowUpdates, BOOKING_FIELDS } from "../sheets/bookings-sync.ts";
import type { BookingCells, BookingRecord, RefundRecord, TabLayout } from "../sheets/bookings-sync.ts";
import type { ReconcileIssue } from "./square.ts";

export type SheetReconcileDeps = { db: D1Database; sheets: SheetsClient; now: number };

/** `repaired` counts the rows appended or rewritten, which are no issue. */
export type SheetReconcileResult = { issues: ReconcileIssue[]; repaired: number };

const DAY_MS = 86_400_000;

/** As reconcileSquare's default window. */
const WINDOW_DAYS = 35;

/** ?1 the window's start. A rental that ended before it is left alone, on the tab or not. */
const WINDOW_SQL = "status IN ('CONFIRMED', 'CANCELLED') AND end_at >= ?1";

// Oldest first: appended rows follow the order the bookings were made, and a booking's last refund is its latest.
const BOOKINGS_SQL = `SELECT ${BOOKING_FIELDS} FROM bookings WHERE ${WINDOW_SQL} ORDER BY created_at, id`;
const REFUNDS_SQL =
  "SELECT booking_id, amount_jpy, status FROM refunds " +
  `WHERE booking_id IN (SELECT id FROM bookings WHERE ${WINDOW_SQL}) ORDER BY created_at, rowid`;

/** Which of the tab's booking ids, ?1 as one JSON array, D1 has, whatever their status or time. */
const KNOWN_SQL = "SELECT id FROM bookings WHERE id IN (SELECT value FROM json_each(?1))";

/** Whether any cell an update writes differs from D1's. A cell past the row's end is empty. */
function isStale({ nameAt, spans }: TabLayout, row: unknown[], cells: BookingCells): boolean {
  return spans.some(([first, last]) => {
    for (let i = first; i <= last; i += 1) {
      const name = nameAt.get(i);
      if (name !== undefined && (row[i] ?? "") !== cells[name]) return true;
    }
    return false;
  });
}

/**
 * Repairs the Bookings tab from D1 over the window ending `now` and reports what only staff can fix. Throws, before any
 * write, when the tab cannot be read or its header lacks a column.
 */
export async function reconcileSheet({ db, sheets, now }: SheetReconcileDeps): Promise<SheetReconcileResult> {
  const layout = await readTab(sheets);
  const { grid, rows, nameAt } = layout;
  const columnOf = new Map([...nameAt].map(([index, name]) => [name, index]));
  const [idAt, refAt, overrideAt] = (["booking_id", "booking_ref", "override_plate"] as const).map(
    (name) => columnOf.get(name) as number,
  );

  // One batch is one snapshot, so no booking shows without its refunds.
  const since = now - WINDOW_DAYS * DAY_MS;
  const [bookingRead, refundRead, knownRead] = (await db.batch([
    db.prepare(BOOKINGS_SQL).bind(since),
    db.prepare(REFUNDS_SQL).bind(since),
    db.prepare(KNOWN_SQL).bind(JSON.stringify([...rows.keys()])),
  ])) as [D1Result<BookingRecord>, D1Result<RefundRecord>, D1Result<{ id: string }>];
  const refundsOf = new Map<string, RefundRecord[]>();
  for (const refund of refundRead.results) {
    refundsOf.set(refund.booking_id, [...(refundsOf.get(refund.booking_id) ?? []), refund]);
  }

  const issues: ReconcileIssue[] = [];
  const updates: { range: string; values: unknown[][] }[] = [];
  const appends: unknown[][] = [];
  let rewritten = 0;
  for (const booking of bookingRead.results) {
    const cells = rowOf(booking, refundsOf.get(booking.id) ?? []);
    const at = rows.get(booking.id);
    if (at === undefined) {
      appends.push(appendedRow(layout, cells));
      continue;
    }
    const row = grid[at - 1];
    if (isStale(layout, row, cells)) {
      updates.push(...rowUpdates(layout, cells, at));
      rewritten += 1;
    }
    // Publish moves only a CONFIRMED booking that has not ended, and tells staff in override_status why it moved no other.
    const plate = textOf(row[overrideAt]);
    if (booking.status === "CONFIRMED" && booking.end_at > now && plate !== "" && plate !== booking.vehicle_plate) {
      issues.push({
        type: "pending_override",
        bookingRef: booking.ref,
        detail:
          `Row ${at} of the Bookings tab asks for ${plate}, and the booking is still on ${booking.vehicle_plate}. ` +
          "Press Publish to move it, or clear override_plate.",
      });
    }
  }

  const known = new Set(knownRead.results.map(({ id }) => id));
  grid.forEach((row, index) => {
    // Row 1 is the header, and a blank row is nothing.
    if (index === 0 || row.every((cell) => textOf(cell) === "")) return;
    const id = row[idAt];
    if (typeof id === "string" && known.has(id)) return;
    const ref = textOf(row[refAt]);
    const named = textOf(id);
    issues.push({
      type: "unknown_sheet_row",
      bookingRef: ref === "" ? undefined : ref,
      detail:
        `Row ${index + 1} of the Bookings tab ${named === "" ? "has no booking_id" : `has booking_id ${named}`}, ` +
        "and D1 has no such booking. The row was left as it is: remove it by hand if it is no booking.",
    });
  });

  if (updates.length > 0) await sheets.batchUpdate(updates);
  if (appends.length > 0) await sheets.append(appendRange(layout), appends);
  return { issues, repaired: rewritten + appends.length };
}
