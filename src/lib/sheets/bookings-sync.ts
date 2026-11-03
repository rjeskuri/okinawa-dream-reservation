// Copies bookings from D1 to the Bookings tab. One read of the whole tab gives the header row, which says where each
// column is (any order, extra columns allowed), and the booking_id column. The rows already there are updated in one
// batchUpdate, the rest are appended in one append. The two override columns belong to staff: an update writes only
// the runs of columns this function owns, and an append writes the override cells as empty ones.
import { BOOKINGS_COLUMNS, headerKey } from "../catalog/sheet-schema.ts";
import { SheetsError } from "../google/sheets.ts";
import type { SheetsClient } from "../google/sheets.ts";
import type { SendResult } from "../outbox.ts";
import { epochToJst } from "../time.ts";

type SyncDeps = { db: D1Database; sheets: SheetsClient };

type Cell = string | number;

type BookingRecord = {
  id: string;
  ref: string;
  status: string;
  source: string;
  model_id: string;
  package_id: string | null;
  vehicle_plate: string;
  start_at: number;
  end_at: number;
  price_jpy: number | null;
  deposit_jpy: number | null;
  locale: string | null;
  guest_family_name: string | null;
  guest_given_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  paid_jpy: number;
  created_at: number;
  updated_at: number;
};

type RefundRecord = { booking_id: string; amount_jpy: number; status: string };

const TAB = "Bookings";

// Well under D1's 100 parameters per statement.
const ID_CHUNK = 90;

/** Only these are copied to the sheet when they are not on it yet. */
const APPENDED_STATUSES = new Set(["CONFIRMED", "CANCELLED"]);

const OVERRIDE_COLUMNS: readonly string[] = ["override_plate", "override_status"];

/** A problem with the tab that only staff can fix. */
class TabError extends Error {}

/** The column letters of a zero-based column index. */
export function columnLetters(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

const BOOKING_SQL = (count: number) =>
  "SELECT id, ref, status, source, model_id, package_id, vehicle_plate, start_at, end_at, price_jpy, deposit_jpy, " +
  "locale, guest_family_name, guest_given_name, guest_email, guest_phone, paid_jpy, created_at, updated_at " +
  `FROM bookings WHERE id IN (${placeholders(count)})`;

// Oldest first, so the last row of a booking is its latest refund.
const REFUND_SQL = (count: number) =>
  "SELECT booking_id, amount_jpy, status FROM refunds " +
  `WHERE booking_id IN (${placeholders(count)}) ORDER BY created_at, rowid`;

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, i) => `?${i + 1}`).join(", ");
}

function jst(ms: number): string {
  const { date, time } = epochToJst(ms);
  return `${date} ${time}`;
}

/** Refunds in these statuses moved money, or will; REJECTED and FAILED did not. */
const MONEY_STATUSES = new Set(["PENDING", "COMPLETED", "RETRY"]);

type ColumnName = (typeof BOOKINGS_COLUMNS)[number];

/** The cells of a booking row by column name. */
function rowOf(b: BookingRecord, refunds: RefundRecord[]): Record<ColumnName, Cell> {
  return {
    booking_ref: b.ref,
    booking_id: b.id,
    status: b.status,
    source: b.source,
    model_id: b.model_id,
    plate: b.vehicle_plate,
    override_plate: "",
    override_status: "",
    start: jst(b.start_at),
    end: jst(b.end_at),
    package_id: b.package_id ?? "",
    guest_name: [b.guest_family_name, b.guest_given_name].filter((part) => part).join(" "),
    guest_email: b.guest_email ?? "",
    guest_phone: b.guest_phone ?? "",
    locale: b.locale ?? "",
    price_jpy: b.price_jpy ?? 0,
    deposit_jpy: b.deposit_jpy ?? 0,
    paid_jpy: b.paid_jpy,
    refund_jpy: refunds.filter((r) => MONEY_STATUSES.has(r.status)).reduce((sum, r) => sum + r.amount_jpy, 0),
    refund_status: refunds.length === 0 ? "" : refunds[refunds.length - 1].status,
    created_at: jst(b.created_at),
    updated_at: jst(b.updated_at),
  };
}

async function loadBookings(db: D1Database, ids: string[]): Promise<Map<string, BookingRecord>> {
  const found = new Map<string, BookingRecord>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { results } = await db
      .prepare(BOOKING_SQL(chunk.length))
      .bind(...chunk)
      .all<BookingRecord>();
    for (const row of results) found.set(row.id, row);
  }
  return found;
}

async function loadRefunds(db: D1Database, ids: string[]): Promise<Map<string, RefundRecord[]>> {
  const byBooking = new Map<string, RefundRecord[]>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { results } = await db
      .prepare(REFUND_SQL(chunk.length))
      .bind(...chunk)
      .all<RefundRecord>();
    for (const row of results) byBooking.set(row.booking_id, [...(byBooking.get(row.booking_id) ?? []), row]);
  }
  return byBooking;
}

type TabLayout = {
  /** The column name at each zero-based position of the header row; a staff column or a repeated header has none. */
  nameAt: Map<number, ColumnName>;
  /** The number of columns up to the last header. */
  width: number;
  /** The sheet row number (1-based) of each booking_id on the tab. A repeated id keeps its first row. */
  rows: Map<string, number>;
};

/** Reads the whole tab once: the header row says where each column is, and the booking_id column says which rows. */
async function readTab(sheets: SheetsClient): Promise<TabLayout> {
  const grid = (await sheets.batchGet([TAB]))[TAB] ?? [];
  const header = grid[0] ?? [];
  if (!header.some((name) => headerKey(name) !== "")) throw new TabError(`${TAB}: the tab is missing or has no header row`);

  // A values.append starts at the first column of the table Google detects, so a column with no name would shift what
  // it writes. Every column up to the last header needs a name; trailing blanks are not columns.
  const width = header.findLastIndex((name) => headerKey(name) !== "") + 1;
  const unnamed = header.slice(0, width).findIndex((name) => headerKey(name) === "");
  if (unnamed >= 0) throw new TabError(`${TAB}: column ${columnLetters(unnamed)} has no header`);

  const position = new Map<string, number>();
  header.forEach((name, index) => {
    const key = headerKey(name);
    if (!position.has(key)) position.set(key, index);
  });
  const missing = BOOKINGS_COLUMNS.filter((name) => !position.has(name));
  if (missing.length > 0) throw new TabError(`${TAB}: the header ${missing.join(", ")} is missing`);

  const nameAt = new Map(BOOKINGS_COLUMNS.map((name) => [position.get(name) as number, name]));
  const idAt = position.get("booking_id") as number;
  const rows = new Map<string, number>();
  grid.forEach((cells, i) => {
    const id = cells[idAt];
    // Row 1 is the header.
    if (i > 0 && typeof id === "string" && id !== "" && !rows.has(id)) rows.set(id, i + 1);
  });
  return { nameAt, width, rows };
}

/** The runs of adjacent columns an update may write: every schema column but the overrides, as [first, last] pairs. */
function updateSpans(nameAt: Map<number, ColumnName>): [number, number][] {
  const owned = [...nameAt].filter(([, name]) => !OVERRIDE_COLUMNS.includes(name)).map(([index]) => index);
  const spans: [number, number][] = [];
  for (const index of owned.sort((x, y) => x - y)) {
    const last = spans[spans.length - 1];
    if (last !== undefined && last[1] === index - 1) last[1] = index;
    else spans.push([index, index]);
  }
  return spans;
}

function failure(error: unknown): SendResult {
  if (error instanceof TabError) return { ok: false, retryable: false, error: error.message };
  if (error instanceof SheetsError) {
    return { ok: false, retryable: error.status === 429 || error.status >= 500, error: error.message };
  }
  // A network failure, or a D1 one: both may pass on a later try.
  return { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Writes the current state of these bookings to the Bookings tab: at most one read, one batchUpdate and one append.
 * A confirmed or cancelled booking not on the tab is appended; one already there is updated in place, except for the
 * override cells. An unknown id does not stop the others and makes the result a non-retryable failure.
 */
export async function syncBookingRows(deps: SyncDeps, bookingIds: string[]): Promise<SendResult> {
  try {
    const ids = [...new Set(bookingIds)];
    if (ids.length === 0) return { ok: true };
    const bookings = await loadBookings(deps.db, ids);
    const known = ids.filter((id) => bookings.has(id));
    const unknown = ids.filter((id) => !bookings.has(id));

    if (known.length > 0) {
      const refunds = await loadRefunds(deps.db, known);
      const { nameAt, width, rows } = await readTab(deps.sheets);
      const spans = updateSpans(nameAt);
      const updates: { range: string; values: unknown[][] }[] = [];
      const appends: Cell[][] = [];
      for (const id of known) {
        const booking = bookings.get(id) as BookingRecord;
        const cells = rowOf(booking, refunds.get(id) ?? []);
        const at = rows.get(id);
        if (at !== undefined) {
          for (const [first, last] of spans) {
            const range = `${TAB}!${columnLetters(first)}${at}:${columnLetters(last)}${at}`;
            const values = Array.from({ length: last - first + 1 }, (_, i) => cells[nameAt.get(first + i) as ColumnName]);
            updates.push({ range, values: [values] });
          }
        } else if (APPENDED_STATUSES.has(booking.status)) {
          // Each value under its own header; "" under the overrides, the staff columns and a repeated header.
          appends.push(
            Array.from({ length: width }, (_, i) => {
              const name = nameAt.get(i);
              return name === undefined || OVERRIDE_COLUMNS.includes(name) ? "" : cells[name];
            }),
          );
        }
      }
      if (updates.length > 0) await deps.sheets.batchUpdate(updates);
      if (appends.length > 0) await deps.sheets.append(`${TAB}!A:${columnLetters(width - 1)}`, appends);
    }

    if (unknown.length > 0) {
      return { ok: false, retryable: false, error: `unknown booking id: ${unknown.join(", ")}` };
    }
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
