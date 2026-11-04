// The Bookings tab as tests see it: the cells a booking's row holds, worked out here from the seeded D1 rows the way
// tests/bookings-sync.test.ts states them (never through src/lib/sheets/bookings-sync.ts), rows laid out under any
// header, and rows read back by header name. Also wall clocks in Japan time, written out from the +9 hour offset alone.
import { BOOKINGS_COLUMNS } from "../../src/lib/catalog/sheet-schema.ts";
import { insertRow } from "./seed.ts";
import type { BookingRow } from "./seed.ts";

export type Column = (typeof BOOKINGS_COLUMNS)[number];
export type Cells = Record<Column, string | number>;

/** A refund as the row counts it. */
export type RefundFact = { amount_jpy: number; status: string; created_at: number };

const HOUR_MS = 3_600_000;

/** Refunds in these statuses moved money, or will (the Bookings sync's ruling). */
const MONEY_STATUSES = new Set(["PENDING", "COMPLETED", "RETRY"]);

/** The instant of a JST wall clock written "YYYY-MM-DD HH:mm". */
export function at(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

/** The JST wall clock of an instant as "YYYY-MM-DD HH:mm". */
export function wall(ms: number): string {
  return new Date(ms + 9 * HOUR_MS).toISOString().slice(0, 16).replace("T", " ");
}

/** The JST calendar date of an instant as "YYYY-MM-DD". */
export function jstDate(ms: number): string {
  return wall(ms).slice(0, 10);
}

/** The cells of a booking's row. refund_status is the latest refund's by created_at; fixtures never tie. */
export function expectedCells(b: BookingRow, refunds: RefundFact[] = []): Cells {
  const latest = [...refunds].sort((x, y) => x.created_at - y.created_at).at(-1);
  return {
    booking_ref: b.ref,
    booking_id: b.id,
    status: b.status,
    source: b.source,
    model_id: b.model_id,
    plate: b.vehicle_plate,
    override_plate: "",
    override_status: "",
    start: wall(b.start_at),
    end: wall(b.end_at),
    package_id: b.package_id ?? "",
    guest_name: [b.guest_family_name, b.guest_given_name].filter((part) => part).join(" "),
    guest_email: b.guest_email ?? "",
    guest_phone: b.guest_phone ?? "",
    locale: b.locale ?? "",
    price_jpy: b.price_jpy ?? 0,
    deposit_jpy: b.deposit_jpy ?? 0,
    paid_jpy: b.paid_jpy,
    refund_jpy: refunds.filter((r) => MONEY_STATUSES.has(r.status)).reduce((sum, r) => sum + r.amount_jpy, 0),
    refund_status: latest?.status ?? "",
    created_at: wall(b.created_at),
    updated_at: wall(b.updated_at),
  };
}

/** A header cell as the sheet rules match it: spaces around it and upper or lower case do not matter. */
export function headerName(cell: unknown): string {
  return String(cell ?? "").trim().toLowerCase();
}

/** A row under `header`, each cell under the header of its name and "" under any other. */
export function rowUnder(header: unknown[], cells: Partial<Record<string, unknown>>): unknown[] {
  return header.map((name) => cells[headerName(name)] ?? "");
}

/** A row read back by header name; a cell past the row's end is "". */
export function named(header: unknown[], row: unknown[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  header.forEach((name, i) => {
    const key = headerName(name);
    if (!(key in out)) out[key] = row?.[i] ?? "";
  });
  return out;
}

/** The schema columns of a named row, for a deepEqual against expectedCells. */
export function schemaCells(row: Record<string, unknown>): Record<Column, unknown> {
  return Object.fromEntries(BOOKINGS_COLUMNS.map((column) => [column, row[column] ?? ""])) as Record<Column, unknown>;
}

/** A refund row of a booking, returned as the Bookings row counts it. */
export async function seedRefund(
  db: D1Database,
  bookingId: string,
  fields: { amount: number; status: string; at: number },
): Promise<RefundFact> {
  const id = crypto.randomUUID();
  await insertRow(db, "refunds", {
    id,
    booking_id: bookingId,
    square_refund_id: `sqr-${id}`,
    amount_jpy: fields.amount,
    status: fields.status,
    origin: "cancel",
    idempotency_key: `idem-${id}`,
    created_at: fields.at,
    updated_at: fields.at,
  });
  return { amount_jpy: fields.amount, status: fields.status, created_at: fields.at };
}

/** Whether a row holds nothing. */
export function isBlank(row: unknown[] | undefined): boolean {
  return (row ?? []).every((cell) => cell === undefined || cell === null || cell === "");
}
