// reconcileSheet, src/lib/reconcile/sheet.ts: D1's bookings against the Bookings tab, on a real in-memory D1 and a fake
// SheetsClient that models the sheet, so every assertion is on the cells that end up in the grid and on what was not
// written. Expected cells come from tests/helpers/bookings-tab.ts, which states the Bookings sync's row from the seeded
// rows, never from src/lib/sheets/bookings-sync.ts or the code under test. Ids and refs are fresh UUIDs on every run.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - The window is the rental's time: a CONFIRMED or CANCELLED booking whose rental falls in the 35 days before `now` or
//   any time after it. Fixtures stay clear of the edge, and an in-window booking was also created and last changed in
//   the window, so reading the window off start_at, end_at, created_at or updated_at all agree on them.
// - A row repaired is a booking row appended or rewritten; `repaired` counts rows, however many cells differed. A repair
//   is not an issue: `issues` holds only what staff must act on.
// - A row is stale when any cell the Worker owns differs from D1, whatever its updated_at cell says. That cell is no
//   version stamp: it is minute-precise, a refund settling leaves the booking's updated_at as it was, and staff can type
//   over any cell. Staff text in a Worker-owned cell is put back.
// - A row "unknown to D1" is a row whose booking_id no booking in D1 has, whatever its status or time. A row of a
//   booking D1 knows but the window leaves out is not reported and not written. A blank row is nothing.
// - Sheet issues extend ReconcileIssueType: `unknown_sheet_row` (bookingRef is the row's booking_ref cell) and
//   `pending_override` (bookingRef is the booking's ref). Neither carries a payment, refund or amount.
// - A pending override is override_plate set and different from the booking's plate in D1, which the plate cell can lag
//   behind. Only CONFIRMED bookings that have not ended carry one here; what an override on a cancelled or ended booking
//   means is left open.
// - Columns are found by header name, as the Bookings sync finds them (any order, case and spaces around a header do not
//   matter), and a named staff column is never written, like the override columns.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BOOKINGS_COLUMNS } from "../src/lib/catalog/sheet-schema.ts";
import {
  at,
  expectedCells,
  isBlank,
  named,
  rowUnder,
  schemaCells,
  seedRefund,
  wall,
  type Cells,
  type RefundFact,
} from "./helpers/bookings-tab.ts";
import { createTestDb } from "./helpers/d1.ts";
import { createFakeSheets, type FakeSheets } from "./helpers/fake-sheets.ts";
import { seedBooking, seedCatalogMeta, seedConfig, seedModel, seedVehicle, type BookingRow } from "./helpers/seed.ts";

/** Loaded inside each test, after its fixtures, so a test fails on this module alone and a bad fixture shows first. */
const reconcileModule = () => import("../src/lib/reconcile/sheet.ts");

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 03:00 JST, when the daily cron runs. The window opens at 2030-04-27 03:00 JST. */
const NOW = at("2030-06-01 03:00");

const CONFIG_TAB = [
  ["key", "value"],
  ["shop_open", "09:00"],
];

type Want = {
  type: string;
  bookingRef?: string;
  paymentId?: string;
  refundId?: string;
  expectedJpy?: number;
  actualJpy?: number;
};

type Issue = Record<string, unknown>;

type Result = { issues: Issue[]; repaired: number };

type Spec = Partial<BookingRow> & { start: string; end: string; created?: string; updated?: string };

interface World {
  db: D1Database;
  sheet: FakeSheets;
  header: string[];
  plates: string[];
  /** A booking of the shared model on `plate` (the first plate when left out), with varied guest and money fields. */
  book(spec: Spec): Promise<BookingRow>;
  /** Puts these rows on the tab below the header, as they stand. */
  lay(rows: unknown[][]): void;
  reconcile(): Promise<Result>;
}

let serial = 0;

async function withWorld(run: (world: World) => Promise<void>, header: string[] = [...BOOKINGS_COLUMNS]): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedConfig(db);
    await seedCatalogMeta(db);
    const model = await seedModel(db, { id: `pcx-${randomUUID().slice(0, 6)}` });
    const plates: string[] = [];
    for (let n = 0; n < 8; n += 1) {
      plates.push((await seedVehicle(db, { plate: `わ${randomUUID().slice(0, 4)}-${n}`, model_id: model.id })).plate);
    }
    const sheet = createFakeSheets({ Config: CONFIG_TAB, Bookings: [[...header]] });
    await run({
      db,
      sheet,
      header,
      plates,
      async book({ start, end, created, updated, ...rest }) {
        serial += 1;
        const startAt = at(start);
        // Nine days before pickup, and never after `now`.
        const createdAt =
          created === undefined ? Math.min(startAt - 9 * DAY_MS, NOW - 2 * DAY_MS - (serial % 5) * HOUR_MS) : at(created);
        const deposit = 1000 + 37 * serial;
        return seedBooking(db, {
          id: randomUUID(),
          ref: `OD-${randomUUID().slice(0, 8).toUpperCase()}`,
          vehicle_plate: plates[0],
          model_id: model.id,
          start_at: startAt,
          end_at: at(end),
          created_at: createdAt,
          updated_at: updated === undefined ? createdAt + 2 * HOUR_MS : at(updated),
          price_jpy: 4000 + 113 * serial,
          deposit_jpy: deposit,
          paid_jpy: deposit,
          locale: ["ja", "en", "zh-cn", "ko"][serial % 4],
          guest_family_name: ["Yamada", "Suzuki", "Kim", "Chen"][serial % 4],
          guest_given_name: ["Taro", "Mei", "Minji", "Wei"][(serial + 1) % 4],
          guest_email: `guest${serial}@example.com`,
          guest_phone: `+81-90-${String(1000 + serial).padStart(4, "0")}-${String(7000 + serial * 3)}`,
          ...rest,
        });
      },
      lay(rows) {
        rows.forEach((row, i) => row.forEach((value, c) => sheet.setCell("Bookings", i + 1, c, value)));
      },
      async reconcile() {
        const { reconcileSheet } = await reconcileModule();
        return (await reconcileSheet({ db, sheets: sheet, now: NOW })) as Result;
      },
    });
  } finally {
    await dispose();
  }
}

/** The row a booking's cells make under the tab's header, with staff cells (memo, overrides) as given. */
function rowOf(world: World, cells: Cells, staff: Record<string, unknown> = {}): unknown[] {
  return rowUnder(world.header, { ...cells, ...staff });
}

function rows(sheet: FakeSheets): unknown[][] {
  return sheet.grid("Bookings");
}

/** The 0-based grid rows holding this booking_id. */
function rowsOf(world: World, id: string): number[] {
  const grid = rows(world.sheet);
  const header = grid[0];
  return grid.flatMap((row, i) => (i > 0 && named(header, row).booking_id === id ? [i] : []));
}

/** The one grid row of a booking. */
function onlyRowOf(world: World, id: string): number {
  const found = rowsOf(world, id);
  assert.equal(found.length, 1, `booking ${id} is on the tab once, found rows ${found.join(", ") || "none"}`);
  return found[0];
}

function cellsAt(world: World, index: number): Record<string, unknown> {
  const grid = rows(world.sheet);
  return named(grid[0], grid[index]);
}

/** Every cell written to these 0-based rows of the Bookings tab, by any call. */
function writesOn(sheet: FakeSheets, indexes: number[]) {
  return sheet.writes.filter((w) => w.tab === "Bookings" && indexes.includes(w.row));
}

function issueKey(issue: Issue | Want): string {
  const { type, bookingRef, paymentId, refundId, expectedJpy, actualJpy } = issue as Want;
  return JSON.stringify([type, bookingRef ?? null, paymentId ?? null, refundId ?? null, expectedJpy ?? null, actualJpy ?? null]);
}

function assertIssues(actual: unknown, want: Want[], label: string): void {
  assert.ok(Array.isArray(actual), `${label}: issues is an array`);
  for (const issue of actual as Issue[]) {
    assert.ok(typeof issue.detail === "string" && issue.detail.trim() !== "", `${label}: ${JSON.stringify(issue)} has a detail`);
  }
  assert.deepEqual((actual as Issue[]).map(issueKey).sort(), want.map(issueKey).sort(), label);
}

async function stored(db: D1Database, id: string): Promise<BookingRow> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `booking ${id} is in D1`);
  return row;
}

async function change(db: D1Database, id: string, columns: Record<string, string | number | null>): Promise<BookingRow> {
  const names = Object.keys(columns);
  const sets = names.map((name, i) => `${name} = ?${i + 1}`).join(", ");
  await db
    .prepare(`UPDATE bookings SET ${sets} WHERE id = ?${names.length + 1}`)
    .bind(...Object.values(columns), id)
    .run();
  return stored(db, id);
}

test("missing and stale rows are repaired", async () => {
  await withWorld(async (world) => {
    const { db, sheet, plates } = world;
    const refunds = new Map<string, RefundFact[]>();
    const refund = async (b: BookingRow, amount: number, status: string, when: string) => {
      refunds.set(b.id, [...(refunds.get(b.id) ?? []), await seedRefund(db, b.id, { amount, status, at: at(when) })]);
    };

    // On the tab and in sync: a future rental, a cancelled one of last month with refunds, and an OTA block.
    const syncedFuture = await world.book({ start: "2030-06-10 09:00", end: "2030-06-11 18:00", package_id: "day-2" });
    const syncedCancelled = await world.book({
      status: "CANCELLED",
      vehicle_plate: plates[1],
      start: "2030-05-12 10:00",
      end: "2030-05-12 18:00",
      created: "2030-05-02 12:00",
      updated: "2030-05-06 08:30",
      cancelled_at: at("2030-05-06 08:30"),
    });
    await refund(syncedCancelled, 1500, "COMPLETED", "2030-05-06 09:00");
    const syncedBlock = await world.book({
      source: "block",
      external_ref: `KL-${randomUUID().slice(0, 6)}`,
      external_channel: "Klook",
      vehicle_plate: plates[2],
      start: "2030-07-01 09:00",
      end: "2030-07-03 18:00",
      price_jpy: null,
      deposit_jpy: null,
      paid_jpy: 0,
      locale: null,
      guest_family_name: null,
      guest_given_name: null,
      guest_email: null,
      guest_phone: null,
    });

    // In D1 and never written to the tab.
    const missingFuture = await world.book({
      vehicle_plate: plates[3],
      start: "2030-06-20 09:30",
      end: "2030-06-22 18:00",
      package_id: "day-3",
      guest_family_name: null,
    });
    const missingCancelled = await world.book({
      status: "CANCELLED",
      vehicle_plate: plates[4],
      start: "2030-05-20 09:00",
      end: "2030-05-21 18:00",
      created: "2030-05-08 15:00",
      updated: "2030-05-15 11:00",
      cancelled_at: at("2030-05-15 11:00"),
    });
    await refund(missingCancelled, 2100, "COMPLETED", "2030-05-15 11:05");
    await refund(missingCancelled, 900, "REJECTED", "2030-05-15 11:20");
    const missingOngoing = await world.book({ vehicle_plate: plates[5], start: "2030-05-31 09:00", end: "2030-06-02 18:00" });
    const missingFarAhead = await world.book({
      vehicle_plate: plates[6],
      start: "2030-12-01 09:00",
      end: "2030-12-05 18:00",
      created: "2030-03-15 10:00",
    });
    // Booked, cancelled and due 30 to 35 days back, all of it in the window.
    const missingLastMonth = await world.book({
      status: "CANCELLED",
      start: "2030-04-30 09:00",
      end: "2030-04-30 18:00",
      created: "2030-04-27 15:00",
      updated: "2030-04-28 09:00",
      cancelled_at: at("2030-04-28 09:00"),
    });
    const { start_at, end_at, created_at, updated_at } = missingLastMonth;
    for (const ms of [start_at, end_at, created_at, updated_at]) {
      assert.ok(ms >= NOW - 35 * DAY_MS && ms < NOW - 30 * DAY_MS, "fixture: 30 to 35 days back");
    }

    // On the tab as they stood before a change that never reached it.
    const staleCancelled = await world.book({ vehicle_plate: plates[7], start: "2030-06-14 09:00", end: "2030-06-14 18:00" });
    const staleMoved = await world.book({ start: "2030-06-25 09:00", end: "2030-06-26 18:00" });
    const stalePhone = await world.book({ vehicle_plate: plates[2], start: "2030-05-25 13:00", end: "2030-05-25 18:00" });
    const staleTimes = await world.book({ vehicle_plate: plates[4], start: "2030-08-03 09:00", end: "2030-08-04 18:00" });
    const staleRows = [
      rowOf(world, expectedCells(staleCancelled)),
      rowOf(world, expectedCells(staleMoved)),
      rowOf(world, expectedCells(stalePhone)),
      rowOf(world, expectedCells(staleTimes)),
    ];
    const changedAt = at("2030-05-31 10:00");
    await change(db, staleCancelled.id, { status: "CANCELLED", cancelled_at: changedAt, updated_at: changedAt });
    await refund(staleCancelled, staleCancelled.paid_jpy, "PENDING", "2030-05-31 10:05");
    await change(db, staleMoved.id, { vehicle_plate: plates[6], updated_at: changedAt + HOUR_MS });
    await change(db, stalePhone.id, { guest_phone: "+81-80-5555-0101", price_jpy: 9870, updated_at: changedAt + 2 * HOUR_MS });
    await change(db, staleTimes.id, {
      start_at: staleTimes.start_at + DAY_MS,
      end_at: staleTimes.end_at + DAY_MS,
      updated_at: changedAt + 3 * HOUR_MS,
    });

    // Stale with the updated_at cell D1 has: staff typed over a phone number, a refund settled without touching the
    // booking, and a second change landed in the same JST minute as the one the sync wrote.
    const overtyped = await world.book({ vehicle_plate: plates[3], start: "2030-07-08 09:00", end: "2030-07-09 18:00" });
    const overtypedRow = rowOf(world, { ...expectedCells(overtyped), guest_phone: "+81-00-0000-0000" });
    const refundSettles = await world.book({
      status: "CANCELLED",
      vehicle_plate: plates[5],
      start: "2030-06-06 09:00",
      end: "2030-06-06 18:00",
      created: "2030-05-20 10:00",
      updated: "2030-05-29 16:00",
      cancelled_at: at("2030-05-29 16:00"),
    });
    await refund(refundSettles, 1300, "PENDING", "2030-05-29 16:02");
    const refundSettlesRow = rowOf(world, expectedCells(refundSettles, refunds.get(refundSettles.id)));
    await db
      .prepare("UPDATE refunds SET status = 'COMPLETED', updated_at = ?1 WHERE booking_id = ?2")
      .bind(at("2030-05-31 02:10"), refundSettles.id)
      .run();
    refunds.set(refundSettles.id, [{ amount_jpy: 1300, status: "COMPLETED", created_at: at("2030-05-29 16:02") }]);
    const sameMinute = await world.book({ vehicle_plate: plates[1], start: "2030-06-17 09:00", end: "2030-06-18 18:00" });
    const minute = at("2030-05-31 14:00");
    const syncedAt14 = await change(db, sameMinute.id, { paid_jpy: sameMinute.paid_jpy + 800, updated_at: minute + 5_000 });
    const sameMinuteRow = rowOf(world, expectedCells(syncedAt14));
    await change(db, sameMinute.id, { guest_email: "new-address@example.com", updated_at: minute + 41_000 });

    const synced = [syncedFuture, syncedCancelled, syncedBlock];
    const missing = [missingFuture, missingCancelled, missingOngoing, missingFarAhead, missingLastMonth];
    const stale = [staleCancelled, staleMoved, stalePhone, staleTimes, overtyped, refundSettles, sameMinute];
    world.lay([
      rowOf(world, expectedCells(syncedFuture)),
      staleRows[0],
      overtypedRow,
      rowOf(world, expectedCells(syncedCancelled, refunds.get(syncedCancelled.id))),
      staleRows[1],
      sameMinuteRow,
      staleRows[2],
      rowOf(world, expectedCells(syncedBlock)),
      refundSettlesRow,
      staleRows[3],
    ]);
    const before = rows(sheet);
    const placed = new Map([...synced, ...stale].map((b) => [b.id, onlyRowOf(world, b.id)]));
    for (const b of stale) {
      const current = await stored(db, b.id);
      const laid = cellsAt(world, placed.get(b.id) as number);
      assert.notDeepEqual(schemaCells(laid), expectedCells(current, refunds.get(b.id)), `fixture: ${b.ref}'s row is stale`);
      if ([overtyped, refundSettles, sameMinute].includes(b)) {
        assert.equal(laid.updated_at, wall(current.updated_at), `fixture: ${b.ref}'s updated_at cell is D1's`);
      }
    }
    sheet.writes.length = 0;
    sheet.calls.length = 0;

    const first = await world.reconcile();

    assert.equal(first.repaired, missing.length + stale.length, "each missing and each stale row, once");
    assertIssues(first.issues, [], "a repair is not an issue");
    assert.equal(rows(sheet).length, before.length + missing.length, "one row added per missing booking, none removed");
    for (const b of [...synced, ...stale, ...missing]) {
      const current = await stored(db, b.id);
      const index = onlyRowOf(world, b.id);
      if (placed.has(b.id)) assert.equal(index, placed.get(b.id), `${b.ref} keeps its row`);
      else assert.ok(index >= before.length, `${b.ref} goes below the rows already there`);
      assert.deepEqual(schemaCells(cellsAt(world, index)), expectedCells(current, refunds.get(b.id)), `the row of ${b.ref}`);
    }
    assert.equal(cellsAt(world, onlyRowOf(world, staleCancelled.id)).status, "CANCELLED");
    assert.equal(cellsAt(world, onlyRowOf(world, staleCancelled.id)).refund_status, "PENDING");
    assert.equal(cellsAt(world, onlyRowOf(world, staleMoved.id)).plate, plates[6]);
    assert.equal(cellsAt(world, onlyRowOf(world, stalePhone.id)).guest_phone, "+81-80-5555-0101");
    assert.equal(cellsAt(world, onlyRowOf(world, staleTimes.id)).start, "2030-08-04 09:00");
    assert.equal(cellsAt(world, onlyRowOf(world, missingCancelled.id)).refund_jpy, 2100);
    assert.equal(cellsAt(world, onlyRowOf(world, missingCancelled.id)).refund_status, "REJECTED");
    assert.equal(cellsAt(world, onlyRowOf(world, overtyped.id)).guest_phone, overtyped.guest_phone, "staff text is put back");
    assert.equal(cellsAt(world, onlyRowOf(world, refundSettles.id)).refund_status, "COMPLETED");
    assert.equal(cellsAt(world, onlyRowOf(world, sameMinute.id)).guest_email, "new-address@example.com");
    assert.deepEqual(writesOn(sheet, synced.map((b) => placed.get(b.id) as number)), [], "rows in sync are not written");
    assert.deepEqual(sheet.grid("Config"), CONFIG_TAB, "other tabs are untouched");

    // A second run finds nothing to do and writes nothing.
    const settled = rows(sheet);
    sheet.writes.length = 0;
    const second = await world.reconcile();
    assert.equal(second.repaired, 0);
    assertIssues(second.issues, [], "second run");
    assert.deepEqual(sheet.writes, [], "a tab in sync takes no write");
    assert.deepEqual(rows(sheet), settled);

    // One booking changes: only its row is written.
    const laterAt = at("2030-05-31 23:00");
    const farAhead = await change(db, missingFarAhead.id, {
      status: "CANCELLED",
      cancelled_at: laterAt,
      paid_jpy: 0,
      updated_at: laterAt,
    });
    const farRow = onlyRowOf(world, farAhead.id);
    sheet.writes.length = 0;
    const third = await world.reconcile();
    assert.equal(third.repaired, 1);
    assertIssues(third.issues, [], "third run");
    const thirdWrites = writesOn(sheet, rows(sheet).map((_, i) => i));
    assert.ok(thirdWrites.length > 0, "the changed row is written");
    assert.equal(thirdWrites.length, sheet.writes.length, "only the Bookings tab is written");
    assert.deepEqual(
      thirdWrites.filter((w) => w.row !== farRow),
      [],
      "only the changed booking's row is written",
    );
    assert.deepEqual(schemaCells(cellsAt(world, farRow)), expectedCells(farAhead));
    assert.equal(rows(sheet).length, settled.length);
  });
});

test("bookings outside the window or in other statuses are left alone", async () => {
  await withWorld(async (world) => {
    const { db, sheet, plates } = world;
    // Rentals that ended weeks before the window opened: one missing, one stale, one in sync.
    const oldMissing = await world.book({ start: "2030-04-01 09:00", end: "2030-04-01 18:00" });
    const oldStale = await world.book({
      vehicle_plate: plates[1],
      start: "2030-03-10 09:00",
      end: "2030-03-11 18:00",
      updated: "2030-03-05 10:00",
    });
    const oldStaleRow = rowOf(world, expectedCells(oldStale));
    await change(db, oldStale.id, { status: "CANCELLED", cancelled_at: at("2030-03-06 10:00"), updated_at: at("2030-03-06 10:00") });
    const oldSynced = await world.book({ vehicle_plate: plates[2], start: "2030-02-14 09:00", end: "2030-02-15 18:00" });

    // In the window, but neither confirmed nor cancelled.
    const held = await world.book({ status: "ON_HOLD", expires_at: NOW + 10 * 60_000, vehicle_plate: plates[3], start: "2030-06-15 09:00", end: "2030-06-15 18:00", paid_jpy: 0 });
    const pending = await world.book({ status: "PAYMENT_PENDING", vehicle_plate: plates[4], start: "2030-06-16 09:00", end: "2030-06-16 18:00", paid_jpy: 0 });
    const expiredPast = await world.book({ status: "EXPIRED", vehicle_plate: plates[5], start: "2030-05-20 09:00", end: "2030-05-20 18:00", paid_jpy: 0 });
    const expiredAhead = await world.book({ status: "EXPIRED", vehicle_plate: plates[6], start: "2030-07-20 09:00", end: "2030-07-21 18:00", paid_jpy: 0 });

    // Controls: in the window, confirmed or cancelled, not on the tab.
    const nearEdge = await world.book({
      vehicle_plate: plates[7],
      start: "2030-05-02 09:00",
      end: "2030-05-02 18:00",
      created: "2030-04-28 10:00",
    });
    const ahead = await world.book({ status: "CANCELLED", start: "2030-06-30 09:00", end: "2030-06-30 18:00" });

    // Either side of 30 days back, where a shorter window would cut: every time of the first two is 30 to 35 days
    // before `now`, so both are in the window; the third ended 37 days back, before it opened.
    const bandMissing = await world.book({
      vehicle_plate: plates[4],
      start: "2030-04-29 09:00",
      end: "2030-04-29 18:00",
      created: "2030-04-27 12:00",
    });
    const bandStale = await world.book({
      vehicle_plate: plates[5],
      start: "2030-04-30 10:00",
      end: "2030-04-30 17:00",
      created: "2030-04-27 09:30",
    });
    const bandStaleRow = rowOf(world, expectedCells(bandStale));
    const cancelledAt = at("2030-04-28 20:00");
    const bandCancelled = await change(db, bandStale.id, { status: "CANCELLED", cancelled_at: cancelledAt, updated_at: cancelledAt });
    const pastBand = await world.book({ vehicle_plate: plates[6], start: "2030-04-24 09:00", end: "2030-04-24 18:00" });
    const times = (b: BookingRow) => [b.start_at, b.end_at, b.created_at, b.updated_at];
    for (const b of [bandMissing, bandCancelled]) {
      assert.ok(
        times(b).every((ms) => ms >= NOW - 35 * DAY_MS && ms < NOW - 30 * DAY_MS),
        `fixture: ${b.ref} is 30 to 35 days back`,
      );
    }
    assert.ok(times(pastBand).every((ms) => ms < NOW - 35 * DAY_MS), "fixture: the third is before the window");
    assert.ok(pastBand.end_at > NOW - 38 * DAY_MS, "fixture: the third ended under 38 days back");

    world.lay([oldStaleRow, rowOf(world, expectedCells(oldSynced)), bandStaleRow]);
    const before = rows(sheet);
    const bandRow = onlyRowOf(world, bandStale.id);
    sheet.writes.length = 0;

    const result = await world.reconcile();

    assert.equal(result.repaired, 4, "the two controls and the two bookings 30 to 35 days back");
    assertIssues(result.issues, [], "a row of a booking D1 knows is not unknown, in the window or not");
    assert.deepEqual(rows(sheet).slice(0, 3), before.slice(0, 3), "rows outside the window are not rewritten");
    assert.deepEqual(writesOn(sheet, [1, 2]), []);
    assert.equal(rows(sheet).length, before.length + 3);
    assert.equal(onlyRowOf(world, bandStale.id), bandRow, "the stale row 30 to 35 days back keeps its row");
    assert.deepEqual(schemaCells(cellsAt(world, bandRow)), expectedCells(bandCancelled), "and is rewritten");
    assert.equal(cellsAt(world, bandRow).status, "CANCELLED");
    for (const b of [nearEdge, ahead, bandMissing]) {
      const index = onlyRowOf(world, b.id);
      assert.ok(index >= before.length, `${b.ref} is appended`);
      assert.deepEqual(schemaCells(cellsAt(world, index)), expectedCells(await stored(db, b.id)));
    }
    for (const b of [oldMissing, pastBand, held, pending, expiredPast, expiredAhead]) {
      assert.deepEqual(rowsOf(world, b.id), [], `${b.status} ${b.ref} is not copied to the tab`);
    }
  });
});

test("override columns are untouched", async () => {
  // A staff memo column first, the overrides last (so batchGet leaves their empty cells off), headers respelled.
  const moved = ["booking_id", "booking_ref", "status", "plate", "override_plate", "override_status"];
  const rest = BOOKINGS_COLUMNS.filter((c) => !moved.includes(c)).reverse();
  const header = ["memo", " Booking_ID ", "booking_ref", "STATUS", "plate", ...rest, "Override_Plate", " override_status "];
  await withWorld(async (world) => {
    const { db, sheet, plates } = world;
    const memoAt = 0;
    const overrideAt = [header.length - 2, header.length - 1];
    const staffCols = [memoAt, ...overrideAt];

    const staleWithOverride = await world.book({ start: "2030-06-08 09:00", end: "2030-06-08 18:00" });
    const matching = await world.book({ vehicle_plate: plates[1], start: "2030-06-09 09:00", end: "2030-06-10 18:00" });
    const movedByPublish = await world.book({ vehicle_plate: plates[2], start: "2030-06-12 09:00", end: "2030-06-12 18:00" });
    const cancelled = await world.book({ vehicle_plate: plates[4], start: "2030-05-20 09:00", end: "2030-05-20 18:00" });
    const missing = await world.book({ vehicle_plate: plates[5], start: "2030-06-18 09:00", end: "2030-06-19 18:00" });
    const inSyncPending = await world.book({ vehicle_plate: plates[6], start: "2030-07-02 09:00", end: "2030-07-02 18:00" });

    const staff = new Map<string, Record<string, unknown>>([
      [staleWithOverride.id, { memo: "call before pickup", override_plate: plates[5], override_status: "" }],
      [matching.id, { memo: "helmet x2", override_plate: plates[1], override_status: `Moved to ${plates[1]}.` }],
      [movedByPublish.id, { memo: "", override_plate: plates[3], override_status: "Moved." }],
      [
        cancelled.id,
        {
          memo: "refund by bank",
          override_plate: "",
          override_status: "Not moved: the booking or the bike changed during this Publish. Publish again to check this row.",
        },
      ],
      [inSyncPending.id, { memo: "VIP", override_plate: plates[7], override_status: "" }],
    ]);
    const laid = [staleWithOverride, matching, movedByPublish, cancelled, inSyncPending];
    world.lay(laid.map((b) => rowOf(world, expectedCells(b), staff.get(b.id))));

    // What changed in D1 since: the first paid more, Publish moved the third, the fourth was cancelled.
    const changedAt = at("2030-05-31 09:00");
    await change(db, staleWithOverride.id, { paid_jpy: staleWithOverride.paid_jpy + 2500, updated_at: changedAt });
    await change(db, movedByPublish.id, { vehicle_plate: plates[3], updated_at: changedAt + HOUR_MS });
    await change(db, cancelled.id, { status: "CANCELLED", cancelled_at: changedAt, updated_at: changedAt + 2 * HOUR_MS });

    const before = rows(sheet);
    const placed = new Map(laid.map((b) => [b.id, onlyRowOf(world, b.id)]));
    sheet.writes.length = 0;

    const result = await world.reconcile();

    assert.deepEqual(
      sheet.writes.filter((w) => w.via === "batchUpdate" && staffCols.includes(w.col)),
      [],
      "no update touches an override cell or a staff column",
    );
    assert.deepEqual(
      sheet.writes.filter((w) => w.via === "append" && staffCols.includes(w.col) && w.value !== ""),
      [],
      "an appended row leaves the override cells and staff columns empty",
    );
    for (const b of laid) {
      const index = placed.get(b.id) as number;
      assert.equal(onlyRowOf(world, b.id), index, `${b.ref} keeps its row`);
      const now = cellsAt(world, index);
      const was = named(header, before[index]);
      for (const column of ["memo", "override_plate", "override_status"]) {
        assert.equal(now[column], was[column], `${b.ref}: ${column} is as staff left it`);
      }
      const { override_plate: _p, override_status: _s, ...owned } = schemaCells(now);
      const { override_plate: _ep, override_status: _es, ...want } = expectedCells(await stored(db, b.id));
      assert.deepEqual(owned, want, `${b.ref}: the cells the Worker owns match D1`);
    }
    assert.equal(cellsAt(world, placed.get(movedByPublish.id) as number).plate, plates[3]);
    assert.equal(cellsAt(world, placed.get(cancelled.id) as number).status, "CANCELLED");
    assert.deepEqual(writesOn(sheet, [placed.get(matching.id) as number, placed.get(inSyncPending.id) as number]), []);

    const appended = cellsAt(world, onlyRowOf(world, missing.id));
    assert.deepEqual(schemaCells(appended), expectedCells(missing));
    assert.equal(appended.memo, "");

    assert.equal(result.repaired, 4, "three stale rows and one missing");
    assertIssues(
      result.issues,
      [
        { type: "pending_override", bookingRef: staleWithOverride.ref },
        { type: "pending_override", bookingRef: inSyncPending.ref },
      ],
      "an override that differs from the booking's plate in D1 waits for Publish",
    );

    // Until staff press Publish, every run says so again, and writes nothing.
    sheet.writes.length = 0;
    const again = await world.reconcile();
    assert.equal(again.repaired, 0);
    assert.deepEqual(sheet.writes, []);
    assertIssues(
      again.issues,
      [
        { type: "pending_override", bookingRef: staleWithOverride.ref },
        { type: "pending_override", bookingRef: inSyncPending.ref },
      ],
      "second run",
    );

    // Staff clear one override and Publish moves the other: nothing is pending.
    sheet.setCell("Bookings", placed.get(inSyncPending.id) as number, overrideAt[0], "");
    await change(db, staleWithOverride.id, { vehicle_plate: plates[5], updated_at: changedAt + 5 * HOUR_MS });
    sheet.writes.length = 0;
    const settled = await world.reconcile();
    assertIssues(settled.issues, [], "nothing pending");
    assert.equal(settled.repaired, 1, "the moved booking's plate");
    assert.equal(cellsAt(world, placed.get(staleWithOverride.id) as number).plate, plates[5]);
    assert.equal(cellsAt(world, placed.get(staleWithOverride.id) as number).override_plate, plates[5]);
  }, header);
});

test("unknown rows are reported, not deleted", async () => {
  await withWorld(async (world) => {
    const { db, sheet, plates } = world;
    const known = [
      await world.book({ start: "2030-06-05 09:00", end: "2030-06-05 18:00" }),
      await world.book({ vehicle_plate: plates[1], status: "CANCELLED", start: "2030-05-18 09:00", end: "2030-05-19 18:00" }),
      await world.book({ vehicle_plate: plates[2], start: "2030-09-01 09:00", end: "2030-09-03 18:00" }),
    ];
    const old = await world.book({ vehicle_plate: plates[3], start: "2030-02-14 09:00", end: "2030-02-15 18:00" });
    const missing = await world.book({ vehicle_plate: plates[4], start: "2030-06-21 09:00", end: "2030-06-21 18:00" });

    /** A row as a booking D1 never had would have written it: a deleted test row, or one pasted from another sheet. */
    const ghost = (status: string, source: string, plate: string) => {
      const id = randomUUID();
      const ref = `OD-${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        id,
        ref,
        row: rowOf(world, {
          ...expectedCells({ ...known[0], id, ref, status, source, vehicle_plate: plate }),
          guest_name: `Ghost ${ref.slice(3, 6)}`,
        }),
      };
    };
    const ghosts = [
      ghost("CONFIRMED", "web", plates[5]),
      ghost("CANCELLED", "web", plates[6]),
      ghost("CONFIRMED", "block", plates[7]),
    ];
    world.lay([
      rowOf(world, expectedCells(known[0])),
      ghosts[0].row,
      [],
      rowOf(world, expectedCells(known[1])),
      rowOf(world, expectedCells(old)),
      ghosts[1].row,
      rowOf(world, expectedCells(known[2])),
      ghosts[2].row,
    ]);
    const before = rows(sheet);
    const ghostRows = ghosts.map((g) => onlyRowOf(world, g.id));
    sheet.writes.length = 0;

    const result = await world.reconcile();

    assertIssues(
      result.issues,
      ghosts.map((g) => ({ type: "unknown_sheet_row", bookingRef: g.ref })),
      "each row D1 has no booking for, once",
    );
    assert.equal(result.repaired, 1, "the missing booking");
    assert.deepEqual(rows(sheet).slice(0, before.length), before, "every row is where it was, as it was");
    assert.deepEqual(writesOn(sheet, ghostRows), [], "nothing is written to an unknown row");
    assert.ok(isBlank(rows(sheet)[3]), "the blank row stays blank");
    assert.equal(rows(sheet).length, before.length + 1);
    assert.deepEqual(schemaCells(cellsAt(world, onlyRowOf(world, missing.id))), expectedCells(missing));

    // They are reported on every run until staff remove them, and never removed by the run.
    sheet.writes.length = 0;
    const again = await world.reconcile();
    assertIssues(again.issues, ghosts.map((g) => ({ type: "unknown_sheet_row", bookingRef: g.ref })), "second run");
    assert.equal(again.repaired, 0);
    assert.deepEqual(sheet.writes, []);

    const gone = ghostRows[1];
    before[gone].forEach((_, c) => sheet.setCell("Bookings", gone, c, ""));
    const third = await world.reconcile();
    assertIssues(
      third.issues,
      [ghosts[0], ghosts[2]].map((g) => ({ type: "unknown_sheet_row", bookingRef: g.ref })),
      "a row staff cleared is no longer reported",
    );
    for (const index of [ghostRows[0], ghostRows[2]]) assert.deepEqual(rows(sheet)[index], before[index]);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM bookings").first<{ n: number }>())?.n, 5, "D1 gains no booking");
  });
});
