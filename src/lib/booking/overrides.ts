// Staff overrides from the Bookings tab. Rows run top to bottom, each against what the rows before it did. Refusals are
// decided from chunked reads, so a refused row costs no statement of its own and only a row likely to move spends an
// UPDATE. The moves are capped, which keeps a call inside the 50 D1 statements of a Workers Free invocation: one chunk
// per 90 bookings with an override typed, a few more for the bikes and the config, MOVE_CAP, and one to queue the
// moves. D1 has no transactions but runs one statement at a time, so as for a hold the statement is the lock: the
// UPDATE checks the booking and the bike again, because a rival can land after any of the reads.
import { BLOCKING_SQL, OVERLAP_SQL, conflicts } from "../db/blocking.ts";
import { readShopConfig } from "../db/config.ts";
import { enqueueInOneStatement } from "../outbox.ts";
import type { OutboxItem } from "../outbox.ts";
import type { BookingStatus, VehicleStatus } from "../types.ts";

export type OverrideRow = { row: number; bookingId: string; overridePlate: string };

export type OverrideResult = { row: number; level: "ok" | "error"; message: string; plate?: string };

type Rental = { id: string; startAt: number; endAt: number };

type StoredBooking = Rental & { status: BookingStatus; modelId: string; plate: string };

type StoredVehicle = { plate: string; status: VehicleStatus; modelId: string };

/** A booking that may move, and the plate its row asks for. */
type Wanted = { booking: StoredBooking; plate: string };

const MINUTE_MS = 60_000;

// Well under D1's 100 parameters per statement, with room for the four of the rival read.
const CHUNK = 90;

/** How many rows of one call reach the UPDATE. The rest wait for the next Publish. */
const MOVE_CAP = 20;

// What staff read in override_status. None repeats the override cell, which sits beside it and can be any length.
const NO_BOOKING = "No booking has this booking_id.";
const ENDED = "This booking has ended, so it keeps its bike.";
const NO_BIKE = "No vehicle has this plate.";
const OTHER_MODEL = "This bike is another model, and a booking stays on its own model.";
const BUSY = "This bike is taken during this booking, turnaround included.";
const NOT_APPLIED = `Not applied: one Publish moves at most ${MOVE_CAP} bookings. Publish again to apply this row.`;
const OVERTAKEN = "Not moved: the booking or the bike changed during this Publish. Publish again to check this row.";

function placeholders(count: number, first = 1): string {
  return Array.from({ length: count }, (_, i) => `?${first + i}`).join(", ");
}

const BOOKINGS_SQL = (count: number) =>
  "SELECT id, status, model_id AS modelId, vehicle_plate AS plate, start_at AS startAt, end_at AS endAt " +
  `FROM bookings WHERE id IN (${placeholders(count)})`;

const VEHICLES_SQL = (count: number) =>
  `SELECT plate, status, model_id AS modelId FROM vehicles WHERE plate IN (${placeholders(count)})`;

/** Whatever blocks these plates at q.now and reaches q's span, from the first pickup wanted to the last return. */
const RIVALS_SQL = (count: number) => `WITH q(s, e, buf, now) AS (SELECT ?1, ?2, ?3, ?4)
  SELECT b.id, b.vehicle_plate AS plate, b.start_at AS startAt, b.end_at AS endAt
  FROM bookings b WHERE b.vehicle_plate IN (${placeholders(count, 5)}) AND ${BLOCKING_SQL} AND ${OVERLAP_SQL}`;

/**
 * ?1 the booking, ?2 the turnaround in ms, ?3 now, ?4 the plate. The booking's span and model are read inside the
 * statement, so that it decides on the row as it stands and not on the reads before it.
 */
const MOVE_SQL = `WITH q(s, e, buf, now, model) AS (
    SELECT start_at, end_at, ?2, ?3, model_id FROM bookings WHERE id = ?1
  )
  UPDATE bookings SET vehicle_plate = ?4, updated_at = ?3
  WHERE id = ?1 AND status = 'CONFIRMED' AND end_at > ?3
    AND EXISTS (
      SELECT 1 FROM vehicles v WHERE v.plate = ?4 AND v.status = 'active' AND v.model_id = (SELECT model FROM q)
    )
    AND NOT EXISTS (
      SELECT 1 FROM bookings b WHERE b.vehicle_plate = ?4 AND b.id <> ?1 AND ${BLOCKING_SQL} AND ${OVERLAP_SQL}
    )`;

/** The rows of `statementFor` over the distinct `keys`, one statement per chunk of them. */
async function readInChunks<T>(keys: string[], statementFor: (chunk: string[]) => D1PreparedStatement): Promise<T[]> {
  const distinct = [...new Set(keys)];
  const found: T[] = [];
  for (let i = 0; i < distinct.length; i += CHUNK) {
    found.push(...(await statementFor(distinct.slice(i, i + CHUNK)).all<T>()).results);
  }
  return found;
}

/** Why this booking stays where it is, whatever bike is named, or null if it may move. */
function bookingRefusal(booking: StoredBooking, now: number): string | null {
  if (booking.status !== "CONFIRMED") return `Only a CONFIRMED booking can move, and this one is ${booking.status}.`;
  return booking.endAt > now ? null : ENDED;
}

/** Why this bike cannot take this booking at any time, or null if it can. */
function bikeRefusal(vehicle: StoredVehicle | undefined, booking: StoredBooking): string | null {
  if (vehicle === undefined) return NO_BIKE;
  if (vehicle.status !== "active") return `This bike is ${vehicle.status}, not active.`;
  return vehicle.modelId === booking.modelId ? null : OTHER_MODEL;
}

/** The rentals standing on each bike that `wanted` names, for as much of the calendar as `wanted` reaches. */
async function readRivals(
  db: D1Database,
  wanted: Wanted[],
  bufMs: number,
  now: number,
): Promise<Map<string, Rental[]>> {
  const start = Math.min(...wanted.map(({ booking }) => booking.startAt));
  const end = Math.max(...wanted.map(({ booking }) => booking.endAt));
  const rivals = await readInChunks<Rental & { plate: string }>(
    wanted.map(({ plate }) => plate),
    (plates) => db.prepare(RIVALS_SQL(plates.length)).bind(start, end, bufMs, now, ...plates),
  );
  const onBike = new Map<string, Rental[]>();
  for (const rival of rivals) onBike.set(rival.plate, [...(onBike.get(rival.plate) ?? []), rival]);
  return onBike;
}

/**
 * Queues a Bookings sync for each booking moved: if the sheet write fails, the next Publish finds these rows a no-op,
 * so only that sync can write their plates. `now` is in the key because an item of an earlier move can still be
 * pending, and INSERT OR IGNORE would keep it in place of this one. Two moves of a booking in one call need one item,
 * which reads the booking as it stands when it is drained. A failure is logged and goes no further: a move's own error
 * must reach the caller, and with no such error the sheet write is still to come and can write the plates itself.
 */
async function queueSyncs(db: D1Database, moved: Set<string>, now: number): Promise<void> {
  if (moved.size === 0) return;
  const items = [...moved].map(
    (bookingId): OutboxItem => ({
      kind: "sheet_booking",
      dedupeKey: `sheet:${bookingId}:moved:${now}`,
      payload: { bookingId },
    }),
  );
  try {
    await enqueueInOneStatement(db, items, now).run();
  } catch (error) {
    console.error("Queueing the Bookings sync failed for these moved bookings:", [...moved], error);
  }
}

/**
 * Moves each booking to the plate its row names, if that bike is active, of the booking's model and free for its time.
 * A row that already matches is not touched and has no result, and a row past MOVE_CAP is told to publish again. Rows
 * are reported in order, with `row` as given, and `plate` is set only on a move. The moves made are queued for the
 * Bookings sync, also when a D1 error stops the rows part-way and rejects the call.
 */
export async function applyOverrides(
  db: D1Database,
  rows: OverrideRow[],
  now: number,
): Promise<{ results: OverrideResult[] }> {
  const storedBookings = await readInChunks<StoredBooking>(
    rows.map(({ bookingId }) => bookingId),
    (ids) => db.prepare(BOOKINGS_SQL(ids.length)).bind(...ids),
  );
  const bookings = new Map(storedBookings.map((booking) => [booking.id, booking]));

  // Rows that match are kept here: an earlier row can have moved the booking off that plate.
  const live = rows.flatMap(({ bookingId, overridePlate: plate }): Wanted[] => {
    const booking = bookings.get(bookingId);
    return booking !== undefined && bookingRefusal(booking, now) === null ? [{ booking, plate }] : [];
  });
  const storedVehicles = await readInChunks<StoredVehicle>(
    live.map(({ plate }) => plate),
    (plates) => db.prepare(VEHICLES_SQL(plates.length)).bind(...plates),
  );
  const vehicles = new Map(storedVehicles.map((vehicle) => [vehicle.plate, vehicle]));

  // A row that gets no further needs no turnaround, and this way a tab of them never meets an unpublished config.
  const wanted = live.filter(({ booking, plate }) => bikeRefusal(vehicles.get(plate), booking) === null);
  const bufMs = wanted.length === 0 ? 0 : (await readShopConfig(db)).turnaroundMinutes * MINUTE_MS;
  const onBike = await readRivals(db, wanted, bufMs, now);

  const results: OverrideResult[] = [];
  const moved = new Set<string>();
  let attempts = 0;
  try {
    for (const { row, bookingId, overridePlate: plate } of rows) {
      const booking = bookings.get(bookingId);
      if (booking === undefined) {
        results.push({ row, level: "error", message: NO_BOOKING });
        continue;
      }
      // First of all, or the record of an old override would be refused on every Publish once its rental ended.
      if (booking.plate === plate) continue;

      const taken = onBike.get(plate)?.some((rival) => rival.id !== bookingId && conflicts(rival, booking, bufMs));
      const refusal =
        bookingRefusal(booking, now) ??
        bikeRefusal(vehicles.get(plate), booking) ??
        (taken ? BUSY : null) ??
        (attempts >= MOVE_CAP ? NOT_APPLIED : null);
      if (refusal !== null) {
        results.push({ row, level: "error", message: refusal });
        continue;
      }

      attempts += 1;
      const { meta } = await db.prepare(MOVE_SQL).bind(bookingId, bufMs, now, plate).run();
      if (meta.changes === 0) {
        results.push({ row, level: "error", message: OVERTAKEN });
        continue;
      }
      moved.add(bookingId);
      onBike.set(booking.plate, (onBike.get(booking.plate) ?? []).filter(({ id }) => id !== bookingId));
      onBike.set(plate, [...(onBike.get(plate) ?? []), booking]);
      booking.plate = plate;
      results.push({ row, level: "ok", message: `Moved to ${plate}.`, plate });
    }
  } finally {
    await queueSyncs(db, moved, now);
  }
  return { results };
}
