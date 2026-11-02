// Copying bookings to the Bookings tab: a real in-memory D1 and a fake SheetsClient that models the sheet, so every
// test asserts on the cells that end up in the grid. Expected cells are written out here or derived from the seeded
// rows, never from src/lib/sheets/bookings-sync.ts.
//
// Rulings these tests pin where the ticket is silent:
// - guest_name is "family given", with a missing part left out; a missing text is "".
// - A booking without refunds shows refund_jpy 0 and refund_status "". With refunds, refund_jpy is the sum of the
//   amounts of those whose status is PENDING, COMPLETED or RETRY (REJECTED and FAILED moved no money), and
//   refund_status is the status of the latest refund as stored, latest by created_at then rowid, also when that
//   one is REJECTED or FAILED. (Replaces the earlier "sum of all refund amounts" ruling.)
// - Columns are found by header name in the live header row of the tab (any order, case and surrounding spaces
//   ignored, extra columns left alone), as docs/sheet-schema.md promises. A missing required header, or a tab with no
//   header row, is a non-retryable failure that names the header and writes nothing.
// - Only CONFIRMED and CANCELLED bookings are appended; ON_HOLD, PAYMENT_PENDING and EXPIRED are skipped, not an error.
// - An appended row has "" in the override cells; an update never writes them.
// - A call with nothing in it (no ranges, no rows) is never made.
// - An unknown booking id does not stop the others: they are synced and the result is a non-retryable failure that
//   names the id. A Sheets 429, 5xx or network failure is retryable; any other HTTP status is not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOKINGS_COLUMNS } from "../src/lib/catalog/sheet-schema.ts";
import { SheetsError } from "../src/lib/google/sheets.ts";
import { syncBookingRows } from "../src/lib/sheets/bookings-sync.ts";
import { createTestDb } from "./helpers/d1.ts";
import { createFakeSheets } from "./helpers/fake-sheets.ts";
import type { FakeSheets } from "./helpers/fake-sheets.ts";
import { insertRow, seedBooking, seedModel, seedPackage, seedVehicle } from "./helpers/seed.ts";
import type { BookingRow } from "./helpers/seed.ts";

type Column = (typeof BOOKINGS_COLUMNS)[number];
type Cells = Record<Column, string | number>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const COLUMN_COUNT = BOOKINGS_COLUMNS.length;
const OVERRIDE_COLUMNS = [BOOKINGS_COLUMNS.indexOf("override_plate"), BOOKINGS_COLUMNS.indexOf("override_status")];
const ID_COLUMN = BOOKINGS_COLUMNS.indexOf("booking_id");
const CONFIG_TAB = [
  ["key", "value"],
  ["shop_open", "09:00"],
];

/** The columns of the Bookings tab by canonical name, left to right; a name outside the schema is a staff column. */
type Layout = string[];

interface World {
  db: D1Database;
  sheet: FakeSheets;
  layout: Layout;
  modelId: string;
  /** Seeds a vehicle of the shared model. */
  vehicle(plate: string): Promise<string>;
  sync(ids: string[]): ReturnType<typeof syncBookingRows>;
}

/**
 * `shape.layout` is the order of the columns on the tab, `shape.headers` the header text typed over them (the layout's
 * names when left out), and `shape.grid` replaces the whole starting grid, for a tab with a missing or empty header.
 */
async function withWorld(
  run: (world: World) => Promise<void>,
  shape: { layout?: Layout; headers?: string[]; grid?: unknown[][] } = {},
): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    const model = await seedModel(db, { id: "pcx-125" });
    const layout = shape.layout ?? [...BOOKINGS_COLUMNS];
    const grid = shape.grid ?? [[...(shape.headers ?? layout)]];
    const sheet = createFakeSheets({ Config: CONFIG_TAB, Bookings: grid });
    await run({
      db,
      sheet,
      layout,
      modelId: model.id,
      vehicle: async (plate) => (await seedVehicle(db, { plate, model_id: model.id })).plate,
      sync: (ids) => syncBookingRows({ db, sheets: sheet }, ids),
    });
  } finally {
    await dispose();
  }
}

/** The JST wall clock of an instant as YYYY-MM-DD HH:mm, worked out from the +9 hour offset alone. */
function jst(ms: number): string {
  return new Date(ms + 9 * HOUR_MS).toISOString().slice(0, 16).replace("T", " ");
}

/** The cells a booking row should hold, from the seeded D1 row. `extra` overrides what comes from other tables. */
function expectedCells(b: BookingRow, extra: Partial<Cells> = {}): Cells {
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
    refund_jpy: 0,
    refund_status: "",
    created_at: jst(b.created_at),
    updated_at: jst(b.updated_at),
    ...extra,
  };
}

function asCells(row: unknown[]): Cells {
  return Object.fromEntries(BOOKINGS_COLUMNS.map((column, i) => [column, row[i] ?? ""])) as Cells;
}

/** The Bookings tab below the header, as named cells. */
function dataRows(sheet: FakeSheets): Cells[] {
  return sheet
    .grid("Bookings")
    .slice(1)
    .map((row) => asCells(row));
}

/** The 0-based grid row of a booking, or -1. */
function rowIndexOf(sheet: FakeSheets, id: string): number {
  return sheet.grid("Bookings").findIndex((row, i) => i > 0 && row[ID_COLUMN] === id);
}

async function stored(db: D1Database, id: string): Promise<BookingRow> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `booking ${id} is in D1`);
  return row;
}

async function change(db: D1Database, id: string, columns: Record<string, string | number>): Promise<void> {
  const names = Object.keys(columns);
  const sets = names.map((name, i) => `${name} = ?${i + 1}`).join(", ");
  await db
    .prepare(`UPDATE bookings SET ${sets} WHERE id = ?${names.length + 1}`)
    .bind(...Object.values(columns), id)
    .run();
}

async function seedRefund(
  db: D1Database,
  bookingId: string,
  fields: { id: string; amount: number; status: string; at: number },
): Promise<void> {
  await insertRow(db, "refunds", {
    id: fields.id,
    booking_id: bookingId,
    square_refund_id: `sq-${fields.id}`,
    amount_jpy: fields.amount,
    status: fields.status,
    origin: "cancel",
    idempotency_key: `idem-${fields.id}`,
    created_at: fields.at,
    updated_at: fields.at,
  });
}

function assertNoEmptyCalls(sheet: FakeSheets): void {
  for (const call of sheet.calls) {
    if (call.method === "batchUpdate") assert.ok(call.data.length > 0, "a batchUpdate with no ranges");
    if (call.method === "append") assert.ok(call.rows.length > 0, "an append with no rows");
  }
}

/** Three synced bookings on three vehicles, plus a spare vehicle of the same model. */
async function threeSynced(world: World) {
  const plates = [await world.vehicle("わ1001"), await world.vehicle("わ1002"), await world.vehicle("わ1003")];
  await world.vehicle("わ1004");
  const [a, b, c] = [
    await seedBooking(world.db, { id: "bk-a", ref: "OD-0001", vehicle_plate: plates[0], model_id: world.modelId }),
    await seedBooking(world.db, {
      id: "bk-b",
      ref: "OD-0002",
      vehicle_plate: plates[1],
      model_id: world.modelId,
      start_at: Date.UTC(2030, 7, 1, 1, 0),
      end_at: Date.UTC(2030, 7, 1, 9, 0),
      guest_family_name: "Suzuki",
      guest_given_name: "Mei",
      locale: "ko",
      price_jpy: 9800,
    }),
    await seedBooking(world.db, {
      id: "bk-c",
      ref: "OD-0003",
      vehicle_plate: plates[2],
      model_id: world.modelId,
      start_at: Date.UTC(2030, 8, 9, 0, 0),
      end_at: Date.UTC(2030, 8, 9, 9, 0),
      locale: "zh-cn",
      price_jpy: 15000,
    }),
  ];
  assert.deepEqual(await world.sync([a.id, b.id, c.id]), { ok: true });
  return { a, b, c };
}

test("new bookings are appended with every column", async () => {
  await withWorld(async (world) => {
    const { db, sheet } = world;
    await seedPackage(db, { id: "day-1" });
    const a = await seedBooking(db, {
      id: "bk-a",
      ref: "OD-0001",
      vehicle_plate: await world.vehicle("わ1234"),
      model_id: world.modelId,
      package_id: "day-1",
      start_at: Date.UTC(2030, 6, 14, 23, 30),
      end_at: Date.UTC(2030, 6, 15, 9, 0),
      price_jpy: 12345,
      deposit_jpy: 5000,
      paid_jpy: 5000,
      locale: "ja",
      guest_family_name: "Yamada",
      guest_given_name: "Taro",
      guest_email: "taro@example.com",
      guest_phone: "+81-90-1111-2222",
      created_at: Date.UTC(2030, 5, 30, 15, 0),
      updated_at: Date.UTC(2030, 6, 1, 3, 15),
    });
    await seedRefund(db, a.id, { id: "r-a", amount: 2500, status: "COMPLETED", at: Date.UTC(2030, 6, 2, 0, 0) });
    const b = await seedBooking(db, {
      id: "bk-b",
      ref: "OD-0002",
      vehicle_plate: await world.vehicle("品川500あ7777"),
      model_id: world.modelId,
      start_at: Date.UTC(2031, 0, 1, 0, 0),
      end_at: Date.UTC(2031, 0, 1, 9, 0),
      price_jpy: 8000,
      deposit_jpy: 3000,
      paid_jpy: 3000,
      locale: "ko",
      guest_family_name: null,
      guest_given_name: "Mei",
      guest_email: "mei@example.com",
      guest_phone: "+82-10-0000-0000",
    });
    const c = await seedBooking(db, {
      id: "bk-c",
      ref: "BLK-KL-1",
      source: "block",
      external_ref: "KL-1",
      external_channel: "Klook",
      vehicle_plate: await world.vehicle("わ1235"),
      model_id: world.modelId,
      price_jpy: null,
      deposit_jpy: null,
      locale: null,
      guest_family_name: null,
      guest_given_name: null,
      guest_email: null,
      guest_phone: null,
    });

    assert.deepEqual(await world.sync([a.id, b.id, c.id, a.id]), { ok: true });

    const appends = sheet.calls.flatMap((call) => (call.method === "append" ? [call] : []));
    assert.equal(appends.length, 1);
    assert.equal(appends[0].rows.length, 3, "one row per booking, the repeated id once");
    for (const row of appends[0].rows) assert.equal(row.length, COLUMN_COUNT, "every column of the schema");
    assert.equal(sheet.count("batchUpdate"), 0, "nothing to update");

    const byId = new Map(dataRows(sheet).map((cells) => [cells.booking_id, cells]));
    assert.equal(byId.size, 3);
    assert.equal(dataRows(sheet).length, 3);
    assert.deepEqual(byId.get(a.id), expectedCells(a, { refund_jpy: 2500, refund_status: "COMPLETED" }));
    assert.deepEqual(byId.get(b.id), expectedCells(b));
    assert.equal(expectedCells(b).guest_name, "Mei");
    // A block has no guest, price or deposit: its text cells are empty, never "null" or "undefined".
    const { price_jpy, deposit_jpy, ...blockRest } = byId.get(c.id) as Cells;
    const { price_jpy: _p, deposit_jpy: _d, ...blockExpected } = expectedCells(c);
    assert.deepEqual(blockRest, blockExpected);
    assert.equal(blockRest.source, "block");
    assert.ok([0, ""].includes(price_jpy as never) && [0, ""].includes(deposit_jpy as never));

    // A later booking goes below the rows already there and leaves them alone.
    const before = sheet.grid("Bookings");
    const d = await seedBooking(db, {
      id: "bk-d",
      ref: "OD-0004",
      vehicle_plate: await world.vehicle("わ1236"),
      model_id: world.modelId,
      locale: "zh-cn",
      price_jpy: 20000,
    });
    assert.deepEqual(await world.sync([d.id]), { ok: true });
    assert.deepEqual(sheet.grid("Bookings").slice(0, before.length), before);
    assert.equal(sheet.grid("Bookings").length, before.length + 1);
    assert.deepEqual(dataRows(sheet)[3], expectedCells(d));
    assert.deepEqual(sheet.grid("Config"), CONFIG_TAB, "other tabs are untouched");
    assertNoEmptyCalls(sheet);
  });
});

test("changes update the existing row", async () => {
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const { a, b, c } = await threeSynced(world);
    const rowOf = { a: rowIndexOf(sheet, a.id), b: rowIndexOf(sheet, b.id), c: rowIndexOf(sheet, c.id) };
    assert.deepEqual(Object.values(rowOf).sort(), [1, 2, 3]);
    const untouchedC = sheet.grid("Bookings")[rowOf.c];

    // A is cancelled and a refund starts; B is moved to another bike; C changes in D1 but is not asked for.
    await change(db, a.id, { status: "CANCELLED", cancelled_at: Date.UTC(2030, 6, 10, 5, 0), updated_at: Date.UTC(2030, 6, 10, 5, 0) });
    await seedRefund(db, a.id, { id: "r-1", amount: 4000, status: "PENDING", at: Date.UTC(2030, 6, 10, 5, 1) });
    await change(db, b.id, { vehicle_plate: "わ1004", updated_at: Date.UTC(2030, 6, 11, 0, 0) });
    await change(db, c.id, { status: "CANCELLED", updated_at: Date.UTC(2030, 6, 12, 0, 0) });
    sheet.calls.length = 0;

    assert.deepEqual(await world.sync([b.id, a.id]), { ok: true });
    assert.equal(sheet.count("append"), 0, "a change adds no row");
    assert.equal(sheet.grid("Bookings").length, 4);
    assert.deepEqual(
      dataRows(sheet).map((cells) => cells.booking_id).sort(),
      ["bk-a", "bk-b", "bk-c"],
      "each booking is on the sheet once",
    );
    assert.equal(rowIndexOf(sheet, a.id), rowOf.a);
    assert.equal(rowIndexOf(sheet, b.id), rowOf.b);
    assert.deepEqual(
      asCells(sheet.grid("Bookings")[rowOf.a]),
      expectedCells(await stored(db, a.id), { refund_jpy: 4000, refund_status: "PENDING" }),
    );
    assert.equal(asCells(sheet.grid("Bookings")[rowOf.a]).status, "CANCELLED");
    assert.equal(asCells(sheet.grid("Bookings")[rowOf.a]).updated_at, "2030-07-10 14:00");
    assert.deepEqual(asCells(sheet.grid("Bookings")[rowOf.b]), expectedCells(await stored(db, b.id)));
    assert.equal(asCells(sheet.grid("Bookings")[rowOf.b]).plate, "わ1004");
    assert.deepEqual(sheet.grid("Bookings")[rowOf.c], untouchedC, "a booking not asked for is not rewritten");

    // The refund completes: same row again.
    await db.prepare("UPDATE refunds SET status = 'COMPLETED', updated_at = ?1 WHERE id = 'r-1'").bind(Date.UTC(2030, 6, 14, 0, 0)).run();
    await change(db, a.id, { updated_at: Date.UTC(2030, 6, 14, 0, 0) });
    assert.deepEqual(await world.sync([a.id]), { ok: true });
    assert.equal(sheet.grid("Bookings").length, 4);
    assert.equal(rowIndexOf(sheet, a.id), rowOf.a);
    assert.deepEqual(
      asCells(sheet.grid("Bookings")[rowOf.a]),
      expectedCells(await stored(db, a.id), { refund_jpy: 4000, refund_status: "COMPLETED" }),
    );

    // Syncing again with nothing new changes nothing.
    const settled = sheet.grid("Bookings");
    assert.deepEqual(await world.sync([a.id, b.id]), { ok: true });
    assert.deepEqual(sheet.grid("Bookings"), settled);
    assertNoEmptyCalls(sheet);
  });
});

test("override columns are never written", async () => {
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const { a, b, c } = await threeSynced(world);
    const staff = {
      a: { plate: "わ9001", status: "" },
      b: { plate: "", status: "refused: bike busy" },
      c: { plate: "わ9002", status: "moved" },
    };
    for (const [key, id] of [["a", a.id], ["b", b.id], ["c", c.id]] as const) {
      const row = rowIndexOf(sheet, id);
      sheet.setCell("Bookings", row, OVERRIDE_COLUMNS[0], staff[key].plate);
      sheet.setCell("Bookings", row, OVERRIDE_COLUMNS[1], staff[key].status);
    }
    sheet.writes.length = 0;
    sheet.calls.length = 0;

    // Every booking changes, and a new one arrives in the same sync.
    for (const [i, id] of [a.id, b.id, c.id].entries()) {
      await change(db, id, { status: "CANCELLED", paid_jpy: 1000 * (i + 1), updated_at: Date.UTC(2030, 6, 20 + i, 0, 0) });
    }
    const d = await seedBooking(db, {
      id: "bk-d",
      ref: "OD-0004",
      vehicle_plate: await world.vehicle("わ1005"),
      model_id: world.modelId,
    });
    assert.deepEqual(await world.sync([a.id, b.id, c.id, d.id]), { ok: true });

    assert.deepEqual(
      sheet.writes.filter((w) => w.via === "batchUpdate" && OVERRIDE_COLUMNS.includes(w.col)),
      [],
      "no update touches an override cell",
    );
    assert.ok(sheet.writes.some((w) => w.via === "batchUpdate"), "the other cells were updated");
    for (const [key, id] of [["a", a.id], ["b", b.id], ["c", c.id]] as const) {
      const cells = asCells(sheet.grid("Bookings")[rowIndexOf(sheet, id)]);
      assert.equal(cells.override_plate, staff[key].plate);
      assert.equal(cells.override_status, staff[key].status);
      assert.equal(cells.status, "CANCELLED");
    }
    assert.equal(asCells(sheet.grid("Bookings")[rowIndexOf(sheet, b.id)]).paid_jpy, 2000);
    assert.deepEqual(asCells(sheet.grid("Bookings")[rowIndexOf(sheet, d.id)]), expectedCells(d));
    assert.equal(sheet.writes.filter((w) => w.via === "append" && OVERRIDE_COLUMNS.includes(w.col) && w.value !== "").length, 0);
    assertNoEmptyCalls(sheet);
  });
});

test("many bookings use three calls at most", async () => {
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const plate = await world.vehicle("わ2000");
    const total = 120; // past D1's 100 parameters per statement
    const baseStart = Date.UTC(2030, 8, 1, 0, 0);
    const seeded: BookingRow[] = [];
    for (let i = 0; i < total; i += 1) {
      seeded.push(
        await seedBooking(db, {
          id: `bk-${String(i).padStart(3, "0")}`,
          ref: `OD-${String(i).padStart(4, "0")}`,
          vehicle_plate: plate,
          model_id: world.modelId,
          start_at: baseStart + i * DAY_MS,
          end_at: baseStart + i * DAY_MS + 8 * HOUR_MS,
          price_jpy: 5000 + 137 * i,
          deposit_jpy: 1000 + i,
          paid_jpy: i % 2 === 0 ? 1000 + i : 0,
        }),
      );
    }
    const shuffled = (ids: string[]) => ids.map((_, i) => ids[(i * 7) % ids.length]);

    // 40 are on the sheet already, and then all 120 change or arrive in one sync.
    const early = seeded.slice(0, 40);
    assert.deepEqual(await world.sync(shuffled(early.map((b) => b.id))), { ok: true });
    for (const [i, b] of early.entries()) {
      await change(db, b.id, { status: "CANCELLED", updated_at: Date.UTC(2030, 9, 1, 0, i) });
    }
    sheet.calls.length = 0;

    assert.deepEqual(await world.sync(shuffled(seeded.map((b) => b.id))), { ok: true });

    assert.ok(sheet.count("batchGet") <= 1, "at most one read");
    assert.ok(sheet.count("batchUpdate") <= 1, "at most one batchUpdate");
    assert.ok(sheet.count("append") <= 1, "at most one append");
    assert.ok(sheet.calls.length <= 3, "three calls at most");
    assert.equal(sheet.count("batchUpdate"), 1);
    assert.equal(sheet.count("append"), 1);
    assertNoEmptyCalls(sheet);

    const rows = dataRows(sheet);
    assert.equal(rows.length, total);
    assert.equal(new Set(rows.map((r) => r.booking_id)).size, total);
    for (const row of rows) {
      const index = Number(row.booking_id.toString().slice(3));
      const current = await stored(db, seeded[index].id);
      assert.deepEqual(row, expectedCells(current), `row of ${row.booking_id}`);
    }
    assert.equal(rows.filter((r) => r.status === "CANCELLED").length, 40);
  });
});

test("only the calls that have something to do are made", async () => {
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const a = await seedBooking(db, { id: "bk-a", ref: "OD-0001", vehicle_plate: await world.vehicle("わ3001"), model_id: world.modelId });
    const b = await seedBooking(db, { id: "bk-b", ref: "OD-0002", vehicle_plate: await world.vehicle("わ3002"), model_id: world.modelId });

    assert.deepEqual(await world.sync([]), { ok: true });
    assert.equal(sheet.count("batchUpdate") + sheet.count("append"), 0, "no ids, no writes");
    assert.deepEqual(dataRows(sheet), []);

    assert.deepEqual(await world.sync([a.id, b.id]), { ok: true });
    assert.equal(sheet.count("batchUpdate"), 0, "only new rows: no batchUpdate");
    assert.equal(sheet.count("append"), 1);
    assert.equal(sheet.count("batchGet"), 1);

    sheet.calls.length = 0;
    await change(db, a.id, { status: "CANCELLED", updated_at: Date.UTC(2030, 6, 20, 0, 0) });
    assert.deepEqual(await world.sync([a.id, b.id]), { ok: true });
    assert.equal(sheet.count("append"), 0, "only existing rows: no append");
    assert.equal(sheet.count("batchUpdate"), 1);
    assert.equal(sheet.count("batchGet"), 1);
    assert.equal(dataRows(sheet).length, 2);
    assertNoEmptyCalls(sheet);
  });
});

test("times are JST text and money is integer numbers", async () => {
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const first = await seedBooking(db, {
      id: "bk-1",
      ref: "OD-0001",
      vehicle_plate: await world.vehicle("わ4001"),
      model_id: world.modelId,
      start_at: Date.UTC(2030, 6, 14, 23, 30),
      end_at: Date.UTC(2030, 6, 15, 9, 0),
      created_at: Date.UTC(2030, 5, 30, 15, 0),
      updated_at: Date.UTC(2030, 11, 31, 14, 59),
      price_jpy: 1234567,
      deposit_jpy: 4321,
      paid_jpy: 4321,
    });
    await seedRefund(db, first.id, { id: "r-1", amount: 1111, status: "COMPLETED", at: Date.UTC(2030, 6, 20, 0, 0) });
    const second = await seedBooking(db, {
      id: "bk-2",
      ref: "OD-0002",
      vehicle_plate: await world.vehicle("わ4002"),
      model_id: world.modelId,
      start_at: Date.UTC(2031, 0, 1, 0, 0),
      end_at: Date.UTC(2031, 0, 3, 9, 0),
      created_at: Date.UTC(2030, 0, 1, 0, 0),
      updated_at: Date.UTC(2030, 1, 28, 15, 30),
      price_jpy: 987,
      deposit_jpy: 0,
      paid_jpy: 0,
    });

    assert.deepEqual(await world.sync([first.id, second.id]), { ok: true });
    const cells = new Map(dataRows(sheet).map((row) => [row.booking_id, row]));
    const one = cells.get("bk-1") as Cells;
    const two = cells.get("bk-2") as Cells;

    assert.deepEqual(
      [one.start, one.end, one.created_at, one.updated_at],
      ["2030-07-15 08:30", "2030-07-15 18:00", "2030-07-01 00:00", "2030-12-31 23:59"],
    );
    assert.deepEqual(
      [two.start, two.end, two.created_at, two.updated_at],
      ["2031-01-01 09:00", "2031-01-03 18:00", "2030-01-01 09:00", "2030-03-01 00:30"],
    );
    assert.deepEqual(
      [one.price_jpy, one.deposit_jpy, one.paid_jpy, one.refund_jpy],
      [1234567, 4321, 4321, 1111],
    );
    assert.deepEqual(
      [two.price_jpy, two.deposit_jpy, two.paid_jpy, two.refund_jpy],
      [987, 0, 0, 0],
    );
    for (const row of [one, two]) {
      for (const name of ["start", "end", "created_at", "updated_at"] as const) assert.equal(typeof row[name], "string");
      for (const name of ["price_jpy", "deposit_jpy", "paid_jpy", "refund_jpy"] as const) {
        assert.equal(typeof row[name], "number", name);
        assert.ok(Number.isInteger(row[name]), name);
      }
    }
  });
});

test("a Sheets failure comes back as a SendResult and a retry adds each row once", async () => {
  const cases: [string, "batchGet" | "batchUpdate" | "append", unknown, boolean][] = [
    ["read 503", "batchGet", new SheetsError(503), true],
    ["read 400", "batchGet", new SheetsError(400), false],
    ["update 429", "batchUpdate", new SheetsError(429), true],
    ["update 400", "batchUpdate", new SheetsError(400), false],
    ["append 503", "append", new SheetsError(503), true],
    ["append 400", "append", new SheetsError(400), false],
    ["network error", "append", new TypeError("fetch failed"), true],
  ];
  for (const [name, method, error, retryable] of cases) {
    await withWorld(async (world) => {
      const { db, sheet } = world;
      const a = await seedBooking(db, { id: "bk-a", ref: "OD-0001", vehicle_plate: await world.vehicle("わ5001"), model_id: world.modelId });
      assert.deepEqual(await world.sync([a.id]), { ok: true });
      const rowOfA = rowIndexOf(sheet, a.id);
      await change(db, a.id, { status: "CANCELLED", updated_at: Date.UTC(2030, 6, 20, 0, 0) });
      const b = await seedBooking(db, { id: "bk-b", ref: "OD-0002", vehicle_plate: await world.vehicle("わ5002"), model_id: world.modelId });

      sheet.failNext(method, error);
      const result = await world.sync([a.id, b.id]);
      assert.equal(result.ok, false, name);
      assert.ok(!result.ok && result.retryable === retryable, `${name}: retryable is ${retryable}`);
      assert.ok(!result.ok && typeof result.error === "string" && result.error.length > 0, `${name}: has an error`);

      assert.deepEqual(await world.sync([a.id, b.id]), { ok: true }, name);
      assert.equal(sheet.grid("Bookings").length, 3, `${name}: header and two rows`);
      assert.equal(rowIndexOf(sheet, a.id), rowOfA, name);
      assert.deepEqual(asCells(sheet.grid("Bookings")[rowOfA]), expectedCells(await stored(db, a.id)), name);
      assert.deepEqual(asCells(sheet.grid("Bookings")[rowIndexOf(sheet, b.id)]), expectedCells(b), name);
    });
  }
});

test("an unknown booking id fails without stopping the others", async () => {
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const existing = await seedBooking(db, { id: "bk-e", ref: "OD-0001", vehicle_plate: await world.vehicle("わ6001"), model_id: world.modelId });
    assert.deepEqual(await world.sync([existing.id]), { ok: true });
    await change(db, existing.id, { status: "CANCELLED", updated_at: Date.UTC(2030, 6, 20, 0, 0) });
    const fresh = await seedBooking(db, { id: "bk-f", ref: "OD-0002", vehicle_plate: await world.vehicle("わ6002"), model_id: world.modelId });

    const result = await world.sync([fresh.id, "ghost-17", existing.id]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.retryable === false, "retrying cannot make the booking exist");
    assert.ok(!result.ok && result.error.includes("ghost-17"), "the error names the id");
    assert.equal(dataRows(sheet).length, 2);
    assert.equal(asCells(sheet.grid("Bookings")[rowIndexOf(sheet, existing.id)]).status, "CANCELLED");
    assert.deepEqual(asCells(sheet.grid("Bookings")[rowIndexOf(sheet, fresh.id)]), expectedCells(fresh));
    assert.ok(!JSON.stringify(sheet.grid("Bookings")).includes("ghost-17"), "no row for the unknown id");

    sheet.calls.length = 0;
    const only = await world.sync(["ghost-18"]);
    assert.ok(!only.ok && only.retryable === false && only.error.includes("ghost-18"));
    assert.equal(sheet.count("batchUpdate") + sheet.count("append"), 0);
  });
});

test("bookings that are not confirmed are not appended", async () => {
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const base = Date.UTC(2030, 6, 1, 0, 0);
    const held = await seedBooking(db, { id: "bk-h", ref: "OD-0001", status: "ON_HOLD", expires_at: base + HOUR_MS, vehicle_plate: await world.vehicle("わ7001"), model_id: world.modelId });
    const pending = await seedBooking(db, { id: "bk-p", ref: "OD-0002", status: "PAYMENT_PENDING", vehicle_plate: await world.vehicle("わ7002"), model_id: world.modelId });
    const expired = await seedBooking(db, { id: "bk-x", ref: "OD-0003", status: "EXPIRED", vehicle_plate: await world.vehicle("わ7003"), model_id: world.modelId });
    const confirmed = await seedBooking(db, { id: "bk-c", ref: "OD-0004", vehicle_plate: await world.vehicle("わ7004"), model_id: world.modelId });

    assert.deepEqual(await world.sync([held.id, pending.id, expired.id, confirmed.id]), { ok: true });
    assert.deepEqual(dataRows(sheet).map((row) => row.booking_id), ["bk-c"]);
    assertNoEmptyCalls(sheet);
  });
});

test("refund_jpy counts only refunds that moved money and refund_status is the latest one", async () => {
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const at = (minutes: number) => Date.UTC(2030, 6, 1, 0, 0) + minutes * 60_000;
    const make = (n: number, plate: string) =>
      world.vehicle(plate).then((vehicle_plate) =>
        seedBooking(db, { id: `bk-${n}`, ref: `OD-000${n}`, vehicle_plate, model_id: world.modelId }),
      );
    const [a, b, c, d, e, f] = [
      await make(1, "わ8001"),
      await make(2, "わ8002"),
      await make(3, "わ8003"),
      await make(4, "わ8004"),
      await make(5, "わ8005"),
      await make(6, "わ8006"),
    ];
    // Each refund is inserted in an order that differs from its created_at order, so neither the last row inserted nor
    // a plain sum of every row gives the right answer.
    await seedRefund(db, a.id, { id: "r-a1", amount: 4000, status: "COMPLETED", at: at(20) });
    await seedRefund(db, a.id, { id: "r-a2", amount: 4000, status: "REJECTED", at: at(10) });
    await seedRefund(db, a.id, { id: "r-a3", amount: 500, status: "RETRY", at: at(30) });
    await seedRefund(db, a.id, { id: "r-a4", amount: 2000, status: "FAILED", at: at(5) });
    await seedRefund(db, b.id, { id: "r-b1", amount: 3000, status: "REJECTED", at: at(10) });
    await seedRefund(db, c.id, { id: "r-c1", amount: 900, status: "FAILED", at: at(20) });
    await seedRefund(db, c.id, { id: "r-c2", amount: 2000, status: "COMPLETED", at: at(5) });
    await seedRefund(db, c.id, { id: "r-c3", amount: 1000, status: "PENDING", at: at(10) });
    // Equal created_at: the later row wins, whichever status it has.
    await seedRefund(db, d.id, { id: "r-d1", amount: 100, status: "COMPLETED", at: at(10) });
    await seedRefund(db, d.id, { id: "r-d2", amount: 200, status: "REJECTED", at: at(10) });
    await seedRefund(db, f.id, { id: "r-f1", amount: 700, status: "REJECTED", at: at(10) });
    await seedRefund(db, f.id, { id: "r-f2", amount: 800, status: "COMPLETED", at: at(10) });

    const everyone = [a, b, c, d, e, f];
    const expected = (stage: Record<string, [number, string]>) =>
      Object.fromEntries(
        everyone.map((booking) => [booking.id, expectedCells(booking, { refund_jpy: stage[booking.id][0], refund_status: stage[booking.id][1] })]),
      );
    const rowsById = () => Object.fromEntries(dataRows(sheet).map((cells) => [cells.booking_id, cells]));

    assert.deepEqual(await world.sync(everyone.map((x) => x.id)), { ok: true });
    assert.deepEqual(
      rowsById(),
      expected({
        "bk-1": [4500, "RETRY"],
        "bk-2": [0, "REJECTED"],
        "bk-3": [3000, "FAILED"],
        "bk-4": [100, "REJECTED"],
        "bk-5": [0, ""],
        "bk-6": [800, "COMPLETED"],
      }),
    );
    for (const cells of dataRows(sheet)) assert.equal(typeof cells.refund_jpy, "number");

    // The update path says the same: a rejected refund reissued as a completed one counts once.
    await seedRefund(db, a.id, { id: "r-a5", amount: 250, status: "COMPLETED", at: at(40) });
    await seedRefund(db, b.id, { id: "r-b2", amount: 3000, status: "COMPLETED", at: at(50) });
    await seedRefund(db, c.id, { id: "r-c4", amount: 5000, status: "REJECTED", at: at(60) });
    sheet.calls.length = 0;
    assert.deepEqual(await world.sync(everyone.map((x) => x.id)), { ok: true });
    assert.equal(sheet.count("append"), 0);
    assert.deepEqual(
      rowsById(),
      expected({
        "bk-1": [4750, "COMPLETED"],
        "bk-2": [3000, "COMPLETED"],
        "bk-3": [3000, "REJECTED"],
        "bk-4": [100, "REJECTED"],
        "bk-5": [0, ""],
        "bk-6": [800, "COMPLETED"],
      }),
    );
    assert.equal(dataRows(sheet).length, 6);
  });
});

// --- The columns come from the live header row -------------------------------------------------------------------

const isSchemaColumn = (name: string): boolean => (BOOKINGS_COLUMNS as readonly string[]).includes(name);

/** The BOOKINGS_COLUMNS with `extra` names placed before the given columns (or last), in one layout. */
function withStaffColumns(placements: [before: string | null, name: string][]): Layout {
  const layout: Layout = [...BOOKINGS_COLUMNS];
  for (const [before, name] of placements) {
    if (before === null) layout.push(name);
    else layout.splice(layout.indexOf(before), 0, name);
  }
  return layout;
}

/** Puts a row on the tab the way staff and an earlier sync would have left it: each value under its own column. */
function placeRow(sheet: FakeSheets, layout: Layout, row: number, cells: Record<string, string | number>): void {
  layout.forEach((name, col) => {
    const value = cells[name];
    if (value !== undefined && value !== "") sheet.setCell("Bookings", row, col, value);
  });
}

/** One grid row of the tab as cells by canonical name; "" for an empty or missing cell. */
function named(sheet: FakeSheets, layout: Layout, row: number): Record<string, unknown> {
  const cells = sheet.grid("Bookings")[row] ?? [];
  return Object.fromEntries(layout.map((name, col) => [name, cells[col] ?? ""]));
}

function schemaPart(cells: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(BOOKINGS_COLUMNS.map((name) => [name, cells[name]]));
}

function staffPart(layout: Layout, cells: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(layout.filter((name) => !isSchemaColumn(name)).map((name) => [name, cells[name]]));
}

/** The 0-based grid row of a booking by looking under its booking_id column, or -1. */
function rowOfId(sheet: FakeSheets, layout: Layout, id: string): number {
  const col = layout.indexOf("booking_id");
  return sheet.grid("Bookings").findIndex((row, i) => i > 0 && row[col] === id);
}

const STAFF_VALUES: Record<string, { override_plate: string; override_status: string }> = {
  "bk-a": { override_plate: "わ9001", override_status: "" },
  "bk-b": { override_plate: "", override_status: "refused: bike busy" },
  "bk-c": { override_plate: "わ9002", override_status: "moved" },
};

/** What staff typed into their own columns for a booking. */
function staffNotes(layout: Layout, id: string): Record<string, string> {
  return Object.fromEntries(layout.filter((name) => !isSchemaColumn(name)).map((name) => [name, `${name} of ${id}`]));
}

/**
 * Three bookings already on the tab in this layout, with staff values in the override and staff columns. Then a is
 * cancelled with a refund, b moves to another bike, and c changes in D1 but is not asked for.
 */
async function staleSheet(world: World) {
  const { db, sheet, layout } = world;
  const plates = [await world.vehicle("わ1001"), await world.vehicle("わ1002"), await world.vehicle("わ1003")];
  await world.vehicle("わ1004");
  const [a, b, c] = [
    await seedBooking(db, { id: "bk-a", ref: "OD-0001", vehicle_plate: plates[0], model_id: world.modelId }),
    await seedBooking(db, {
      id: "bk-b",
      ref: "OD-0002",
      vehicle_plate: plates[1],
      model_id: world.modelId,
      start_at: Date.UTC(2030, 7, 1, 1, 0),
      end_at: Date.UTC(2030, 7, 1, 9, 0),
      guest_family_name: "Suzuki",
      guest_given_name: "Mei",
      locale: "ko",
      price_jpy: 9800,
    }),
    await seedBooking(db, {
      id: "bk-c",
      ref: "OD-0003",
      vehicle_plate: plates[2],
      model_id: world.modelId,
      start_at: Date.UTC(2030, 8, 9, 0, 0),
      end_at: Date.UTC(2030, 8, 9, 9, 0),
      locale: "zh-cn",
      price_jpy: 15000,
    }),
  ];
  [a, b, c].forEach((booking, i) =>
    placeRow(sheet, layout, i + 1, { ...expectedCells(booking, STAFF_VALUES[booking.id]), ...staffNotes(layout, booking.id) }),
  );
  await change(db, a.id, { status: "CANCELLED", cancelled_at: Date.UTC(2030, 6, 10, 5, 0), updated_at: Date.UTC(2030, 6, 10, 5, 0) });
  await seedRefund(db, a.id, { id: "r-1", amount: 4000, status: "PENDING", at: Date.UTC(2030, 6, 10, 5, 1) });
  await change(db, b.id, { vehicle_plate: "わ1004", updated_at: Date.UTC(2030, 6, 11, 0, 0) });
  await change(db, c.id, { status: "CANCELLED", updated_at: Date.UTC(2030, 6, 12, 0, 0) });
  return { a, b, c };
}

/**
 * Syncs a and b (and a new booking d when `fresh`) onto the stale sheet of this world and checks the cells: the
 * existing rows are updated where they are, nothing but the sync's own columns changes in them, and a new row lands
 * under the right headers.
 */
async function checkSyncOnLayout(world: World, { fresh }: { fresh: boolean }): Promise<void> {
  const { db, sheet, layout } = world;
  const { a, b, c } = await staleSheet(world);
  const d = fresh
    ? await seedBooking(db, { id: "bk-d", ref: "OD-0004", vehicle_plate: await world.vehicle("わ1005"), model_id: world.modelId })
    : null;
  const rowsBefore = { a: rowOfId(sheet, layout, a.id), b: rowOfId(sheet, layout, b.id), c: rowOfId(sheet, layout, c.id) };
  assert.deepEqual(Object.values(rowsBefore).sort(), [1, 2, 3], "the starting sheet holds the three rows");
  const untouchedC = sheet.grid("Bookings")[rowsBefore.c];
  sheet.calls.length = 0;
  sheet.writes.length = 0;

  assert.deepEqual(await world.sync(d === null ? [b.id, a.id] : [b.id, a.id, d.id]), { ok: true });

  assert.equal(sheet.count("append"), fresh ? 1 : 0, fresh ? "only the new booking is appended" : "a change adds no row");
  assert.equal(sheet.grid("Bookings").length, fresh ? 5 : 4, "no second row for a booking already there");
  assert.equal(rowOfId(sheet, layout, a.id), rowsBefore.a);
  assert.equal(rowOfId(sheet, layout, b.id), rowsBefore.b);
  assert.deepEqual(sheet.grid("Bookings")[rowsBefore.c], untouchedC, "a booking not asked for is not rewritten");

  const rowA = named(sheet, layout, rowsBefore.a);
  const rowB = named(sheet, layout, rowsBefore.b);
  assert.deepEqual(
    schemaPart(rowA),
    expectedCells(await stored(db, a.id), { ...STAFF_VALUES[a.id], refund_jpy: 4000, refund_status: "PENDING" }),
  );
  assert.deepEqual(schemaPart(rowB), expectedCells(await stored(db, b.id), STAFF_VALUES[b.id]));
  assert.equal(rowA.status, "CANCELLED");
  assert.equal(rowB.plate, "わ1004");
  assert.equal(rowB.override_status, "refused: bike busy", "staff values survive");
  assert.equal(rowA.override_plate, "わ9001", "staff values survive");
  assert.deepEqual(staffPart(layout, rowA), staffNotes(layout, a.id), "staff columns are untouched");
  assert.deepEqual(staffPart(layout, rowB), staffNotes(layout, b.id), "staff columns are untouched");

  const protectedCols = layout.flatMap((name, col) => (isSchemaColumn(name) && !OVERRIDE_NAMES.includes(name) ? [] : [col]));
  assert.deepEqual(
    sheet.writes.filter((w) => w.via === "batchUpdate" && protectedCols.includes(w.col)),
    [],
    "no update touches an override or a staff cell",
  );
  assert.ok(sheet.writes.some((w) => w.via === "batchUpdate"), "the other cells were updated");

  if (d !== null) {
    const rowD = named(sheet, layout, 4);
    assert.deepEqual(schemaPart(rowD), expectedCells(d), "each value of the new row is under its own header");
    assert.equal(rowD.booking_id, "bk-d");
    assert.deepEqual(Object.values(staffPart(layout, rowD)).filter((v) => v !== ""), [], "nothing under a staff column");
    for (const w of sheet.writes.filter((x) => x.via === "append")) {
      if (!isSchemaColumn(layout[w.col]) || OVERRIDE_NAMES.includes(layout[w.col])) assert.equal(w.value, "");
    }
  }
  assert.ok(sheet.count("batchGet") <= 1 && sheet.count("batchUpdate") <= 1 && sheet.count("append") <= 1);
  assertNoEmptyCalls(sheet);
}

const OVERRIDE_NAMES = ["override_plate", "override_status"];

test("a notes column inserted at A: a change updates the existing row", async () => {
  const layout = withStaffColumns([[BOOKINGS_COLUMNS[0], "notes"]]);
  assert.equal(layout[0], "notes");
  await withWorld((world) => checkSyncOnLayout(world, { fresh: false }), { layout });
});

test("a notes column inserted before override_plate: a change keeps the override cells", async () => {
  const layout = withStaffColumns([["override_plate", "notes"]]);
  assert.equal(layout.indexOf("notes") + 1, layout.indexOf("override_plate"));
  await withWorld((world) => checkSyncOnLayout(world, { fresh: false }), { layout });
});

test("columns in a shuffled order: an update and an append put every value under its own header", async () => {
  const reversed = [...BOOKINGS_COLUMNS].reverse();
  const layout = [...reversed.slice(7), ...reversed.slice(0, 7)];
  assert.notDeepEqual(layout.slice().sort(), layout, "not alphabetical by accident");
  assert.notEqual(layout.indexOf("booking_id"), ID_COLUMN);
  await withWorld((world) => checkSyncOnLayout(world, { fresh: true }), { layout });
});

test("headers match with any case and surrounding spaces", async () => {
  const layout = withStaffColumns([
    ["status", "notes"],
    [null, "memo"],
  ]);
  [layout[1], layout[5]] = [layout[5], layout[1]];
  const headers = layout.map((name, i) => {
    if (i % 3 === 0) return name.toUpperCase();
    if (i % 3 === 1) return `  ${name} `;
    return ` ${name[0].toUpperCase()}${name.slice(1)}`;
  });
  assert.ok(headers.every((h, i) => h !== layout[i]), "every header is written differently");
  await withWorld((world) => checkSyncOnLayout(world, { fresh: true }), { layout, headers });
});

test("a new row on a tab with extra columns puts each value under its own header", async () => {
  const layout = withStaffColumns([
    [BOOKINGS_COLUMNS[0], "notes"],
    ["plate", "staff_comment"],
    ["refund_jpy", "who_called"],
    [null, "memo"],
  ]);
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const a = await seedBooking(db, { id: "bk-a", ref: "OD-0001", vehicle_plate: await world.vehicle("わ1001"), model_id: world.modelId });
    placeRow(sheet, layout, 1, { ...expectedCells(a), ...staffNotes(layout, a.id) });
    const before = sheet.grid("Bookings");
    const b = await seedBooking(db, {
      id: "bk-b",
      ref: "OD-0002",
      vehicle_plate: await world.vehicle("わ1002"),
      model_id: world.modelId,
      guest_family_name: "Suzuki",
      guest_given_name: "Mei",
      locale: "ko",
      price_jpy: 9800,
      deposit_jpy: 3000,
      paid_jpy: 3000,
    });
    await seedRefund(db, b.id, { id: "r-b", amount: 1200, status: "COMPLETED", at: Date.UTC(2030, 6, 2, 0, 0) });
    const c = await seedBooking(db, {
      id: "bk-c",
      ref: "OD-0003",
      status: "CANCELLED",
      vehicle_plate: await world.vehicle("わ1003"),
      model_id: world.modelId,
    });
    sheet.calls.length = 0;
    sheet.writes.length = 0;

    assert.deepEqual(await world.sync([b.id, c.id]), { ok: true });

    assert.equal(sheet.count("append"), 1);
    assert.equal(sheet.count("batchUpdate"), 0);
    assert.deepEqual(sheet.grid("Bookings").slice(0, 2), before, "the rows already there are untouched");
    assert.equal(sheet.grid("Bookings").length, 4);
    const rowB = named(sheet, layout, rowOfId(sheet, layout, b.id));
    const rowC = named(sheet, layout, rowOfId(sheet, layout, c.id));
    assert.deepEqual(schemaPart(rowB), expectedCells(b, { refund_jpy: 1200, refund_status: "COMPLETED" }));
    assert.deepEqual(schemaPart(rowC), expectedCells(c));
    for (const row of [rowB, rowC]) {
      assert.deepEqual(staffPart(layout, row), { notes: "", staff_comment: "", who_called: "", memo: "" });
      assert.equal(row.override_plate, "");
      assert.equal(row.override_status, "");
    }
    assertNoEmptyCalls(sheet);
  }, { layout });
});

test("a missing required header is a non-retryable failure that writes nothing", async () => {
  for (const missing of ["booking_id", "override_plate", "override_status", "refund_status"]) {
    const layout = withStaffColumns([[BOOKINGS_COLUMNS[0], "notes"]]).filter((name) => name !== missing);
    await withWorld(async (world) => {
      const { db, sheet } = world;
      const existing = await seedBooking(db, { id: "bk-e", ref: "OD-0001", vehicle_plate: await world.vehicle("わ1001"), model_id: world.modelId });
      placeRow(sheet, layout, 1, { ...expectedCells(existing), ...staffNotes(layout, existing.id) });
      await change(db, existing.id, { status: "CANCELLED", updated_at: Date.UTC(2030, 6, 20, 0, 0) });
      const fresh = await seedBooking(db, { id: "bk-f", ref: "OD-0002", vehicle_plate: await world.vehicle("わ1002"), model_id: world.modelId });
      const before = sheet.grid("Bookings");
      sheet.calls.length = 0;

      const result = await world.sync([existing.id, fresh.id]);

      assert.equal(result.ok, false, missing);
      assert.ok(!result.ok && result.retryable === false, `${missing}: only staff can fix the tab`);
      assert.ok(!result.ok && result.error.includes(missing), `${missing}: the error names the header, got: ${!result.ok && result.error}`);
      assert.equal(sheet.count("batchUpdate") + sheet.count("append"), 0, `${missing}: no write at all`);
      assert.deepEqual(sheet.grid("Bookings"), before, `${missing}: the tab is unchanged`);
    }, { layout });
  }
});

test("a tab with no header row is a non-retryable failure that writes nothing", async () => {
  for (const [name, grid] of [["empty tab", []], ["blank first row", [[]]]] as [string, unknown[][]][]) {
    await withWorld(async (world) => {
      const { db, sheet } = world;
      const a = await seedBooking(db, { id: "bk-a", ref: "OD-0001", vehicle_plate: await world.vehicle("わ1001"), model_id: world.modelId });
      const result = await world.sync([a.id]);
      assert.equal(result.ok, false, name);
      assert.ok(!result.ok && result.retryable === false, `${name}: only staff can fix the tab`);
      assert.ok(!result.ok && result.error.length > 0, `${name}: has an error`);
      assert.equal(sheet.count("batchUpdate") + sheet.count("append"), 0, `${name}: no write at all`);
      assert.deepEqual(sheet.grid("Bookings"), grid, `${name}: the tab is unchanged`);
    }, { grid });
  }
});

test("a tab with an extra column still takes three calls at most", async () => {
  const layout = withStaffColumns([
    ["status", "notes"],
    [null, "memo"],
  ]);
  await withWorld(async (world) => {
    const { db, sheet } = world;
    const plate = await world.vehicle("わ2000");
    const total = 100; // past the 90 ids a D1 statement takes
    const baseStart = Date.UTC(2030, 8, 1, 0, 0);
    const seeded: BookingRow[] = [];
    for (let i = 0; i < total; i += 1) {
      seeded.push(
        await seedBooking(db, {
          id: `bk-${String(i).padStart(3, "0")}`,
          ref: `OD-${String(i).padStart(4, "0")}`,
          vehicle_plate: plate,
          model_id: world.modelId,
          start_at: baseStart + i * DAY_MS,
          end_at: baseStart + i * DAY_MS + 8 * HOUR_MS,
          price_jpy: 5000 + 137 * i,
          paid_jpy: i % 2 === 0 ? 1000 + i : 0,
        }),
      );
    }
    // 30 are on the sheet already with staff notes, and then all 100 change or arrive in one sync.
    seeded.slice(0, 30).forEach((b, i) => placeRow(sheet, layout, i + 1, { ...expectedCells(b), ...staffNotes(layout, b.id) }));
    for (const [i, b] of seeded.slice(0, 30).entries()) {
      await change(db, b.id, { status: "CANCELLED", updated_at: Date.UTC(2030, 9, 1, 0, i) });
    }
    sheet.calls.length = 0;

    assert.deepEqual(await world.sync(seeded.map((b, i) => seeded[(i * 7) % total].id)), { ok: true });

    assert.ok(sheet.count("batchGet") <= 1, "at most one read");
    assert.ok(sheet.count("batchUpdate") <= 1, "at most one batchUpdate");
    assert.ok(sheet.count("append") <= 1, "at most one append");
    assert.ok(sheet.calls.length <= 3, "three calls at most");
    assert.equal(sheet.count("batchUpdate"), 1);
    assert.equal(sheet.count("append"), 1);
    assertNoEmptyCalls(sheet);

    assert.equal(sheet.grid("Bookings").length, total + 1);
    for (const [i, b] of seeded.entries()) {
      const row = rowOfId(sheet, layout, b.id);
      assert.ok(row > 0, `${b.id} is on the tab`);
      const cells = named(sheet, layout, row);
      assert.deepEqual(schemaPart(cells), expectedCells(await stored(db, b.id)), `row of ${b.id}`);
      assert.deepEqual(staffPart(layout, cells), i < 30 ? staffNotes(layout, b.id) : { notes: "", memo: "" }, `staff cells of ${b.id}`);
    }
    assert.equal(new Set(sheet.grid("Bookings").slice(1).map((r) => r[layout.indexOf("booking_id")])).size, total);
  }, { layout });
});
