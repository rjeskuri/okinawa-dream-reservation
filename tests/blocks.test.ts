// syncBlocks over the in-memory D1: rows of the sheet's Blocks tab become bookings that hold a bike through the overlap
// rule. Expected values are literals or Date.parse on an explicit +09:00 offset, never the code under test. `conflicts`
// and `isBlocking` are task #11's, with tests of their own, and here they only judge the concurrent runs. A sync is
// watched through its outcome: the rows of `bookings`, column by column, and what it returns. Statements are only ever
// counted, for the D1 budget, and only their text decides where a rival lands.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { searchAvailability } from "../src/lib/booking/availability.ts";
import { createHold } from "../src/lib/booking/holds.ts";
import { applyOverrides } from "../src/lib/booking/overrides.ts";
import type { ValidBlock } from "../src/lib/catalog/sheet-schema.ts";
import { conflicts, isBlocking } from "../src/lib/db/blocking.ts";
import type { BookingStatus } from "../src/lib/types.ts";
import { createTestDb, type TestDb } from "./helpers/d1.ts";
import { propertyRuns } from "../src/lib/property.ts";
import {
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedVehicle,
} from "./helpers/seed.ts";
import type { BookingRow } from "./helpers/seed.ts";

type Level = "ok" | "warning" | "error";
type SyncStatus = { blockId: string; level: Level; message: string };
type SyncResult = { statuses: SyncStatus[]; processed: number; remaining: number; cursor: string | null };
type SyncOptions = { maxChanges?: number; skippedBlockIds?: string[]; blankIdRows?: number; cursor?: string | null };
type Bike = { plate: string; base?: number; odometer?: number; status?: string };
type Shop = { modelId: string; packageId: string };
/** A booking's ref or a block's block_id, and the plate it holds. */
type Blocker = [name: string, plate: string];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const NOW = wall("06-01 12:00");
const LATER = NOW + HOUR_MS;
const PICKUP = wall("06-10 09:00");
const CLOSE = wall("06-10 18:00");
const SOLD_OUT = { ok: false, reason: "SOLD_OUT" };

/**
 * Loaded here, so each test seeds its fixtures and fails on its own while the module is missing. The ts-ignore covers
 * that missing module for lint and nothing else.
 */
async function syncBlocks(db: D1Database, blocks: ValidBlock[], now: number, opts?: SyncOptions): Promise<SyncResult> {
  // @ts-ignore
  const { syncBlocks: sync } = await import("../src/lib/booking/blocks.ts");
  return sync(db, blocks, now, opts);
}

/** The instant of a JST wall clock in 2030, written `MM-DD HH:mm`. */
function wall(text: string): number {
  return Date.parse(`2030-${text.replace(" ", "T")}:00+09:00`);
}

let testDb: TestDb;

// One database for the file, emptied for each case: a Miniflare of its own costs a case a third of a second, and there
// are a few hundred of them to pay for on every ticket.
before(async () => {
  testDb = await createTestDb();
});

after(() => testDb.dispose());

const CLEAR_SQL = ["bookings", "vehicles", "prices", "packages", "models", "rate_classes"].map(
  (table) => `DELETE FROM ${table}`,
);

/** The defaults are 09:00 to 18:00, 30-minute slots, a 60-minute turnaround and 15-minute holds. */
async function withShop(run: (db: D1Database) => Promise<void>, config: Record<string, string | number> = {}): Promise<void> {
  const { db } = testDb;
  await db.batch(CLEAR_SQL.map((sql) => db.prepare(sql)));
  await seedConfig(db, config);
  await seedCatalogMeta(db);
  await run(db);
}

/** A new model with these bikes and a one-day package it can be held on. */
async function seedShop(db: D1Database, bikes: (string | Bike)[] = [], active = 1): Promise<Shop> {
  const model = await seedModel(db, { active });
  const pkg = await seedPackage(db, { days: 1 });
  await seedPrice(db, { rate_class_id: model.rate_class_id, package_id: pkg.id });
  for (const bike of bikes) {
    const { plate, base = 0, odometer, status = "active" } = typeof bike === "string" ? { plate: bike } : bike;
    await seedVehicle(db, { plate, model_id: model.id, base_usage_days: base, odometer_km: odometer ?? null, status });
  }
  return { modelId: model.id, packageId: pkg.id };
}

let lastBlock = 0;

/** A valid row for `PICKUP` to `CLOSE` with a blank plate, and text of its own in every column. */
function aBlock(modelId: string, partial: Partial<ValidBlock> = {}): ValidBlock {
  lastBlock += 1;
  return {
    blockId: `BLK-${lastBlock}`,
    modelId,
    plate: null,
    startAt: PICKUP,
    endAt: CLOSE,
    channel: `channel-${lastBlock}`,
    reference: `reference-${lastBlock}`,
    note: `note-${lastBlock}`,
    ...partial,
  };
}

/** `count` rows that fit one bike: eight hours on each of `count` days from `from`. */
function dailyRows(modelId: string, count: number, from: number, partial: Partial<ValidBlock> = {}): ValidBlock[] {
  return Array.from({ length: count }, (_, day) =>
    aBlock(modelId, { startAt: from + day * DAY_MS, endAt: from + day * DAY_MS + 8 * HOUR_MS, ...partial }),
  );
}

let lastHold = 0;

function holdFor(shop: Shop, startAt = PICKUP) {
  lastHold += 1;
  return { id: `hold-${lastHold}`, modelId: shop.modelId, packageId: shop.packageId, startAt, locale: "en" as const };
}

async function vacancies(db: D1Database, shop: Shop, startAt = PICKUP): Promise<number> {
  const found = await searchAvailability(db, { startAt, packageId: shop.packageId, now: NOW });
  return found.find(({ modelId }) => modelId === shop.modelId)?.vacancies ?? 0;
}

/** Every column of every row, as a rerun must leave them. */
async function allBookings(db: D1Database): Promise<BookingRow[]> {
  const { results } = await db.prepare("SELECT * FROM bookings ORDER BY id").all<BookingRow>();
  return results;
}

async function stored(db: D1Database, blockId: string): Promise<BookingRow | null> {
  return db
    .prepare("SELECT * FROM bookings WHERE source = 'block' AND external_ref = ?1")
    .bind(blockId)
    .first<BookingRow>();
}

async function mustFind(db: D1Database, blockId: string): Promise<BookingRow> {
  const row = await stored(db, blockId);
  assert.ok(row, `${blockId} is not stored`);
  return row;
}

async function storedCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE source = 'block'").first<{ n: number }>();
  return row?.n ?? -1;
}

/** The one status of a row. */
function statusOf(result: SyncResult, blockId: string): SyncStatus {
  const found = result.statuses.filter((status) => status.blockId === blockId);
  assert.equal(found.length, 1, `${blockId}: ${JSON.stringify(result.statuses)}`);
  return found[0];
}

/** The one status for the tab as a whole, which is an error. */
function assertTabError(result: SyncResult): void {
  const found = result.statuses.filter(({ blockId }) => blockId === "");
  assert.equal(found.length, 1, JSON.stringify(result.statuses));
  assert.equal(found[0].level, "error");
  assert.ok(found[0].message.length > 0);
}

function assertNoTabStatus(result: SyncResult): void {
  assert.deepEqual(result.statuses.filter(({ blockId }) => blockId === ""), []);
}

function counts(result: SyncResult): [processed: number, remaining: number] {
  return [result.processed, result.remaining];
}

function assertNamesConflict(status: SyncStatus, blockers: Blocker[]): void {
  assert.equal(status.level, "error", status.message);
  assert.ok(
    blockers.some(([name, plate]) => status.message.includes(name) && status.message.includes(plate)),
    `${JSON.stringify(status.message)} names none of ${JSON.stringify(blockers)}`,
  );
}

function assertNamesNone(status: SyncStatus, others: string[]): void {
  for (const other of others) assert.ok(!status.message.includes(other), `${JSON.stringify(status.message)} names ${other}`);
}

/** The sync reports the row's error, naming one of `blockers`, and no column of any booking moved. */
async function assertRejected(
  db: D1Database,
  sheet: ValidBlock[],
  blockId: string,
  blockers: Blocker[],
  now = NOW,
): Promise<SyncResult> {
  const before = await allBookings(db);
  const result = await syncBlocks(db, sheet, now);
  assertNamesConflict(statusOf(result, blockId), blockers);
  assert.deepEqual(await allBookings(db), before);
  return result;
}

/** Stores `sheet`, every row of which must go through, and returns the row of its first block. */
async function storeSheet(db: D1Database, sheet: ValidBlock[], now = NOW): Promise<BookingRow> {
  const result = await syncBlocks(db, sheet, now, { maxChanges: sheet.length });
  for (const { blockId } of sheet) assert.equal(statusOf(result, blockId).level, "ok", blockId);
  return mustFind(db, sheet[0].blockId);
}

/** What `row` must be once a block is stored from it at `at` on `plate`. */
function assertStoredAs(row: BookingRow, block: ValidBlock, plate: string, at: number): void {
  const { id, ref, content_hash, locale, confirmed_at, catalog_version, payment_attempt, paid_jpy, ...rest } = row;
  assert.deepEqual(rest, {
    status: "CONFIRMED",
    source: "block",
    model_id: block.modelId,
    package_id: null,
    vehicle_plate: plate,
    start_at: block.startAt,
    end_at: block.endAt,
    expires_at: null,
    price_jpy: null,
    deposit_jpy: null,
    guest_family_name: null,
    guest_given_name: null,
    guest_email: null,
    guest_phone: null,
    external_ref: block.blockId,
    external_channel: block.channel,
    payment_id: null,
    cancel_reason: null,
    created_at: at,
    updated_at: at,
    cancelled_at: null,
    refund_due_jpy: null,
  });
  assert.ok(typeof content_hash === "string" && content_hash.length > 0, `content_hash ${content_hash}`);
}

/** `after` is `before` with these changes, a new content hash and updated_at at `at`, and nothing else. */
function assertEdited(after: BookingRow, before: BookingRow, changes: Partial<BookingRow>, at: number): void {
  assert.notEqual(after.content_hash, before.content_hash);
  assert.deepEqual(after, { ...before, ...changes, updated_at: at, content_hash: after.content_hash });
}

function assertCancelled(after: BookingRow, before: BookingRow, at: number): void {
  assert.equal(typeof after.cancel_reason, "string");
  assert.ok(String(after.cancel_reason).length > 0);
  assert.deepEqual(after, {
    ...before,
    status: "CANCELLED",
    cancelled_at: at,
    updated_at: at,
    cancel_reason: after.cancel_reason,
  });
}

/** Judged at `now`, by the rule of task #11. */
function assertNoOverlaps(rows: BookingRow[], now: number, bufMs: number, label: string): void {
  const blocking = rows.filter((row) =>
    isBlocking({ status: row.status as BookingStatus, expiresAt: row.expires_at }, now),
  );
  for (const [index, a] of blocking.entries()) {
    for (const b of blocking.slice(index + 1)) {
      if (a.vehicle_plate !== b.vehicle_plate) continue;
      const clash = conflicts({ startAt: a.start_at, endAt: a.end_at }, { startAt: b.start_at, endAt: b.end_at }, bufMs);
      assert.equal(clash, false, `${label}: ${a.id} and ${b.id} overlap on ${a.vehicle_plate}`);
    }
  }
}

/** Every call of one pass: the returned cursor goes back in until nothing remains. */
async function syncToEnd(db: D1Database, sheet: ValidBlock[], now: number, opts: SyncOptions = {}): Promise<SyncResult[]> {
  const calls: SyncResult[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: SyncResult = await syncBlocks(db, sheet, now, { ...opts, cursor });
    calls.push(result);
    if (result.remaining === 0) return calls;
    assert.ok(calls.length < 12, `${result.remaining} still remain after ${calls.length} calls`);
    cursor = result.cursor;
  }
}

/** The levels one row got over a pass, in order. */
function levelsOf(calls: SyncResult[], blockId: string): string {
  return calls
    .flatMap(({ statuses }) => statuses.filter((status) => status.blockId === blockId).map(({ level }) => level))
    .join(" ");
}

/**
 * `db` that counts each statement sent, one for each of a batch, and awaits `beforeSend` with the text of what is about
 * to go. The real statements go to the real database, so a counted sync behaves as any other.
 */
function probe(
  db: D1Database,
  beforeSend: (sql: string[]) => Promise<void> = async () => {},
): { db: D1Database; statements: () => number } {
  let statements = 0;
  const unwrapped = new WeakMap<object, { statement: D1PreparedStatement; sql: string }>();

  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "bind") return wrap(value.apply(target, args), sql);
          statements += 1;
          return beforeSend([sql]).then(() => value.apply(target, args));
        };
      },
    });
    unwrapped.set(wrapped, { statement, sql });
    return wrapped;
  };

  const probed = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") {
        return (list: D1PreparedStatement[]) => {
          const parts = list.map((statement) => unwrapped.get(statement));
          statements += list.length;
          const sql = parts.map((part) => part?.sql ?? "");
          return beforeSend(sql).then(() => target.batch(parts.map((part, at) => part?.statement ?? list[at])));
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: probed, statements: () => statements };
}

const BOOKING_WRITE = /\b(?:insert(?:\s+or\s+\w+)?\s+into|update(?:\s+or\s+\w+)?)\s+bookings\b/i;

/**
 * `db`, with `rival` run once just before the first write to bookings goes out. That is the moment a guest's hold lands
 * after every earlier read, which only a single conditional statement survives. `raced` says the moment came, so a case
 * cannot pass without it.
 */
function raceBeforeWrite(db: D1Database, rival: () => Promise<unknown>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const racing = probe(db, async (sql) => {
    if (raced || !sql.some((text) => BOOKING_WRITE.test(text))) return;
    raced = true;
    await rival();
  });
  return { db: racing.db, raced: () => raced };
}

const NEW_BLOCKS: [label: string, bikes: Bike[], plate: string | null, expected: string][] = [
  ["the least-used bike", [{ plate: "わ1", base: 9 }, { plate: "わ2", base: 2 }, { plate: "わ3", base: 5 }], null, "わ2"],
  ["the least-used of other usage", [{ plate: "わ1", base: 1 }, { plate: "わ2", base: 8 }, { plate: "わ3", base: 4 }], null, "わ1"],
  ["the last bike when it is least used", [{ plate: "わ1", base: 6 }, { plate: "わ2", base: 3 }, { plate: "わ3", base: 2 }], null, "わ3"],
  ["the lowest odometer on a usage tie", [{ plate: "わ1", base: 4, odometer: 900 }, { plate: "わ2", base: 4, odometer: 300 }], null, "わ2"],
  ["a known odometer before an unknown one", [{ plate: "わ1", base: 4 }, { plate: "わ2", base: 4, odometer: 900 }], null, "わ2"],
  ["the lowest plate on a full tie", [{ plate: "わ2", base: 4 }, { plate: "わ1", base: 4 }], null, "わ1"],
  ["past a bike in maintenance", [{ plate: "わ1", status: "maintenance" }, { plate: "わ2", base: 9 }], null, "わ2"],
  ["past a retired bike", [{ plate: "わ1", status: "retired" }, { plate: "わ2", base: 9 }], null, "わ2"],
  ["the named plate over a less-used one", [{ plate: "わ1" }, { plate: "わ2", base: 9 }], "わ2", "わ2"],
  ["a named plate in maintenance", [{ plate: "わ1" }, { plate: "わ2", status: "maintenance" }], "わ2", "わ2"],
  ["a named retired plate", [{ plate: "わ1" }, { plate: "わ2", status: "retired" }], "わ2", "わ2"],
];

test("new blocks take a named or least-used free bike", async (t) => {
  for (const [label, bikes, plate, expected] of NEW_BLOCKS) {
    await t.test(label, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, bikes);
        // A free bike of another model, which no block of this model may take.
        await seedShop(db, ["わ9"]);
        const row = aBlock(shop.modelId, { plate });

        const result = await syncBlocks(db, [row], NOW);

        assert.equal(statusOf(result, row.blockId).level, "ok");
        assert.deepEqual(counts(result), [1, 0]);
        assertStoredAs(await mustFind(db, row.blockId), row, expected, NOW);
      }),
    );
  }

  await t.test("each row keeps its own columns", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const other = await seedShop(db, ["わ2"]);
      const rows = [
        aBlock(shop.modelId, {
          startAt: wall("06-10 10:30"),
          endAt: wall("06-12 16:15"),
          channel: "Klook",
          reference: "KL-1",
          note: "Two riders",
        }),
        aBlock(other.modelId, {
          plate: "わ2",
          startAt: wall("07-01 09:00"),
          endAt: wall("07-03 18:00"),
          channel: "Rakuten",
          reference: "RT-2",
          note: "",
        }),
      ];

      await syncBlocks(db, rows, LATER);

      assertStoredAs(await mustFind(db, rows[0].blockId), rows[0], "わ1", LATER);
      assertStoredAs(await mustFind(db, rows[1].blockId), rows[1], "わ2", LATER);
    }),
  );

  await t.test("a stored block counts against availability and holds", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      assert.equal(await vacancies(db, shop), 2);

      const first = aBlock(shop.modelId);
      await syncBlocks(db, [first], NOW);
      assert.equal(await vacancies(db, shop), 1);

      await syncBlocks(db, [first, aBlock(shop.modelId)], NOW);
      assert.equal(await vacancies(db, shop), 0);
      assert.deepEqual(await createHold(db, holdFor(shop), NOW), SOLD_OUT);

      // Only the block's own times are taken.
      const dayAfter = PICKUP + 2 * DAY_MS;
      assert.equal(await vacancies(db, shop, dayAfter), 2);
      assert.equal((await createHold(db, holdFor(shop, dayAfter), NOW)).ok, true);
    }),
  );

  await t.test("rows of one call take one bike each", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2", "わ3"]);
      const rows = [aBlock(shop.modelId), aBlock(shop.modelId), aBlock(shop.modelId)];

      await syncBlocks(db, rows, NOW);

      const plates = (await allBookings(db)).map(({ vehicle_plate }) => vehicle_plate);
      assert.deepEqual(plates.sort(), ["わ1", "わ2", "わ3"]);
    }),
  );

  await t.test("a block just stored counts as usage for the next row", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, [{ plate: "わ1", base: 0 }, { plate: "わ2", base: 1 }]);
      // Three JST dates against one day of base usage, so whichever row goes first leaves the other bike least used.
      const rows = [
        aBlock(shop.modelId, { startAt: wall("06-10 09:00"), endAt: wall("06-12 18:00") }),
        aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-22 18:00") }),
      ];

      await syncBlocks(db, rows, NOW);

      const plates = (await allBookings(db)).map(({ vehicle_plate }) => vehicle_plate);
      assert.deepEqual(plates.sort(), ["わ1", "わ2"]);
    }),
  );

  await t.test("a bike busy at those times is passed over, and one busy at others is not", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, [{ plate: "わ1" }, { plate: "わ2", base: 9 }]);
      await seedBooking(db, { vehicle_plate: "わ1", start_at: PICKUP + HOUR_MS, end_at: CLOSE });
      const busy = aBlock(shop.modelId);
      const free = aBlock(shop.modelId, { startAt: wall("07-01 09:00"), endAt: wall("07-01 18:00") });

      await syncBlocks(db, [busy, free], NOW);

      assert.equal((await mustFind(db, busy.blockId)).vehicle_plate, "わ2");
      assert.equal((await mustFind(db, free.blockId)).vehicle_plate, "わ1");
    }),
  );

  await t.test("an inactive model can be blocked", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"], 0);
      const blank = aBlock(shop.modelId);
      const named = aBlock(shop.modelId, { plate: "わ2" });

      const result = await syncBlocks(db, [named, blank], NOW);

      assert.equal(statusOf(result, blank.blockId).level, "ok");
      assert.equal(statusOf(result, named.blockId).level, "ok");
      assert.equal((await mustFind(db, named.blockId)).vehicle_plate, "わ2");
      assert.equal((await mustFind(db, blank.blockId)).vehicle_plate, "わ1");
    }),
  );

  await t.test("a row that ended before it was ever stored goes through the same overlap rule", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const ended = aBlock(shop.modelId, { startAt: wall("05-20 09:00"), endAt: wall("05-20 18:00") });
      const endingNow = aBlock(shop.modelId, { plate: "わ1", startAt: NOW - 2 * HOUR_MS, endAt: NOW });

      const free = await syncBlocks(db, [ended, endingNow], NOW);

      assert.equal(statusOf(free, ended.blockId).level, "ok");
      assert.equal(statusOf(free, endingNow.blockId).level, "ok");
      assert.deepEqual(counts(free), [2, 0]);
      assertStoredAs(await mustFind(db, ended.blockId), ended, "わ1", NOW);
      assertStoredAs(await mustFind(db, endingNow.blockId), endingNow, "わ1", NOW);

      await seedBooking(db, {
        vehicle_plate: "わ1",
        ref: "WEB-PAST",
        start_at: wall("05-25 09:00"),
        end_at: wall("05-25 18:00"),
      });
      const taken = aBlock(shop.modelId, { startAt: wall("05-25 10:00"), endAt: wall("05-25 12:00") });

      await assertRejected(db, [ended, endingNow, taken], taken.blockId, [["WEB-PAST", "わ1"]], LATER);

      assert.equal(await stored(db, taken.blockId), null);
    }),
  );
});

/** A rental of 12:00 to 14:00, and [turnaround minutes, the row's start and end that day, whether the row conflicts]. */
const BUFFERS: [turnaround: number, start: string, end: string, conflicting: boolean][] = [
  [60, "14:30", "16:00", true],
  [60, "14:59", "16:00", true],
  [60, "15:00", "16:00", false],
  [60, "09:00", "11:30", true],
  [60, "09:00", "11:01", true],
  [60, "09:00", "11:00", false],
  [30, "14:29", "16:00", true],
  [30, "14:30", "16:00", false],
  [120, "15:59", "17:00", true],
  [120, "16:00", "17:00", false],
  [0, "13:59", "16:00", true],
  [0, "14:00", "16:00", false],
];

/** A booking on the bike at the row's times, and whether it holds the bike. */
const STATES: [label: string, partial: Partial<BookingRow>, blocking: boolean][] = [
  ["a confirmed booking", { status: "CONFIRMED" }, true],
  ["a payment in flight", { status: "PAYMENT_PENDING" }, true],
  ["a hold with a moment left", { status: "ON_HOLD", expires_at: NOW + 1 }, true],
  ["a hold expiring this instant", { status: "ON_HOLD", expires_at: NOW }, false],
  ["a hold long expired", { status: "ON_HOLD", expires_at: NOW - HOUR_MS }, false],
  ["an expired booking", { status: "EXPIRED" }, false],
  ["a cancelled booking", { status: "CANCELLED", cancelled_at: NOW - HOUR_MS }, false],
];

/**
 * WEB-LIVE, a rental of 12:00 to 14:00 on 06-10, among bookings on `plate` that stop nothing: one of each state above
 * that does not block, inside a 09:00 to 18:00 row, and a rental on another day. `first` puts them ahead of WEB-LIVE by
 * ref, by start and by insertion, and `last` behind it, so a read that skips the rule meets them whichever way it sorts.
 * Returns their refs.
 */
async function seedLiveAmongBystanders(db: D1Database, plate: string, sorted: "first" | "last"): Promise<string[]> {
  const live = () =>
    seedBooking(db, {
      vehicle_plate: plate,
      ref: "WEB-LIVE",
      start_at: wall("06-10 12:00"),
      end_at: wall("06-10 14:00"),
    });
  const [letter, from, until, otherDay] =
    sorted === "first"
      ? ["A", wall("06-10 09:00"), wall("06-10 11:00"), wall("06-02 09:00")]
      : ["Z", wall("06-10 15:00"), wall("06-10 17:00"), wall("06-25 09:00")];
  const idle = STATES.filter(([, , blocking]) => !blocking).map(([, partial]) => partial);

  if (sorted === "last") await live();
  const refs: string[] = [];
  for (const [index, partial] of idle.entries()) {
    const ref = `WEB-${letter}${index}`;
    await seedBooking(db, { vehicle_plate: plate, ref, start_at: from + index * MINUTE_MS, end_at: until, ...partial });
    refs.push(ref);
  }
  await seedBooking(db, {
    vehicle_plate: plate,
    ref: `WEB-${letter}${letter}`,
    start_at: otherDay,
    end_at: otherDay + 9 * HOUR_MS,
  });
  refs.push(`WEB-${letter}${letter}`);
  if (sorted === "first") await live();
  return refs;
}

test("conflicting blocks are rejected with an error", async (t) => {
  await t.test("every bike of the model is taken, while another model's is free", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      await seedShop(db, ["わ9"]);
      await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", start_at: PICKUP, end_at: CLOSE });
      await seedBooking(db, { vehicle_plate: "わ2", ref: "WEB-BBBB", start_at: PICKUP + 2 * HOUR_MS, end_at: CLOSE + DAY_MS });
      const row = aBlock(shop.modelId);

      const result = await assertRejected(db, [row], row.blockId, [["WEB-AAAA", "わ1"], ["WEB-BBBB", "わ2"]]);

      assert.deepEqual(counts(result), [1, 0]);
      assert.equal(await stored(db, row.blockId), null);
    }),
  );

  await t.test("a named plate that is busy has no fallback", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", { plate: "わ2", base: 9 }]);
      await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", start_at: PICKUP, end_at: CLOSE });
      const row = aBlock(shop.modelId, { plate: "わ1" });

      await assertRejected(db, [row], row.blockId, [["WEB-AAAA", "わ1"]]);

      assert.equal(await vacancies(db, shop), 1);
    }),
  );

  await t.test("a named plate in maintenance is checked too", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, [{ plate: "わ1", status: "maintenance" }, "わ2"]);
      await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", start_at: PICKUP, end_at: CLOSE });
      const row = aBlock(shop.modelId, { plate: "わ1" });

      await assertRejected(db, [row], row.blockId, [["WEB-AAAA", "わ1"]]);
    }),
  );

  for (const plate of [null, "わ1"]) {
    await t.test(`a booking inside the turnaround buffer conflicts, plate ${plate}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        for (const [turnaround, start, end, conflicting] of BUFFERS) {
          const label = `${turnaround} minutes, ${start} to ${end}`;
          await db.prepare("DELETE FROM bookings").run();
          await seedConfig(db, { turnaround_minutes: turnaround });
          await seedBooking(db, {
            vehicle_plate: "わ1",
            ref: "WEB-AAAA",
            start_at: wall("06-10 12:00"),
            end_at: wall("06-10 14:00"),
          });
          const row = aBlock(shop.modelId, { plate, startAt: wall(`06-10 ${start}`), endAt: wall(`06-10 ${end}`) });

          const status = statusOf(await syncBlocks(db, [row], NOW), row.blockId);

          if (conflicting) {
            assertNamesConflict(status, [["WEB-AAAA", "わ1"]]);
            assert.equal(await stored(db, row.blockId), null, label);
          } else {
            assert.equal(status.level, "ok", label);
            assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ1", label);
          }
        }
      }),
    );

    await t.test(`only a booking that blocks conflicts, plate ${plate}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        for (const [label, partial, blocking] of STATES) {
          await db.prepare("DELETE FROM bookings").run();
          await seedBooking(db, {
            vehicle_plate: "わ1",
            ref: "WEB-AAAA",
            start_at: PICKUP,
            end_at: CLOSE,
            ...partial,
          });
          const row = aBlock(shop.modelId, { plate });

          const status = statusOf(await syncBlocks(db, [row], NOW), row.blockId);

          if (blocking) assertNamesConflict(status, [["WEB-AAAA", "わ1"]]);
          else assert.equal(status.level, "ok", label);
          assert.equal((await stored(db, row.blockId)) === null, blocking, label);
        }
      }),
    );
  }

  /** How the row comes to ask for its times: new, or edited from another day. */
  const ASKED: [label: string, stage: (db: D1Database, row: ValidBlock) => Promise<unknown>][] = [
    ["a new row", async () => {}],
    ["an edit", (db, row) => storeSheet(db, [{ ...row, startAt: wall("07-01 09:00"), endAt: wall("07-01 18:00") }])],
  ];

  for (const [asked, stage] of ASKED) {
    for (const plate of [null, "わ1"]) {
      for (const sorted of ["first", "last"] as const) {
        await t.test(`${asked} names the booking that blocks, with others sorted ${sorted}, plate ${plate}`, () =>
          withShop(async (db) => {
            const shop = await seedShop(db, ["わ1"]);
            const row = aBlock(shop.modelId, { plate });
            await stage(db, row);
            const bystanders = await seedLiveAmongBystanders(db, "わ1", sorted);

            const result = await assertRejected(db, [row], row.blockId, [["WEB-LIVE", "わ1"]]);

            assertNamesNone(statusOf(result, row.blockId), bystanders);
          }),
        );
      }
    }

    // WEB-LIVE is at 12:00 on the named わ2. The busy plate of the row's model is ahead of it or behind it in each sort.
    const OTHER_PLATES: [label: string, plate: string, ref: string, start: string, end: string][] = [
      ["a lower plate and an earlier start", "わ1", "WEB-OTHER", "09:00", "11:00"],
      ["a lower plate and a lower ref", "わ1", "WEB-ANOTHER", "15:00", "17:00"],
      ["a lower ref and an earlier start", "わ3", "WEB-ANOTHER", "09:00", "11:00"],
    ];
    for (const [label, plate, ref, start, end] of OTHER_PLATES) {
      await t.test(`${asked} naming a plate is told of that plate, past ${label}`, () =>
        withShop(async (db) => {
          const shop = await seedShop(db, ["わ1", "わ2", "わ3"]);
          const row = aBlock(shop.modelId, { plate: "わ2" });
          await stage(db, row);
          await seedBooking(db, {
            vehicle_plate: plate,
            ref,
            start_at: wall(`06-10 ${start}`),
            end_at: wall(`06-10 ${end}`),
          });
          await seedBooking(db, {
            vehicle_plate: "わ2",
            ref: "WEB-LIVE",
            start_at: wall("06-10 12:00"),
            end_at: wall("06-10 14:00"),
          });

          const result = await assertRejected(db, [row], row.blockId, [["WEB-LIVE", "わ2"]]);

          assertNamesNone(statusOf(result, row.blockId), [ref]);
        }),
      );
    }
  }

  await t.test("a block in the way is named by its block_id", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const first = aBlock(shop.modelId, { blockId: "OTA-77" });
      await storeSheet(db, [first]);
      const blank = aBlock(shop.modelId, { blockId: "OTA-78", startAt: PICKUP + 3 * HOUR_MS });
      const named = aBlock(shop.modelId, { blockId: "OTA-79", plate: "わ1", startAt: PICKUP + 4 * HOUR_MS });

      const result = await assertRejected(db, [first, blank, named], blank.blockId, [["OTA-77", "わ1"]]);

      assertNamesConflict(statusOf(result, named.blockId), [["OTA-77", "わ1"]]);
    }),
  );

  await t.test("the second of two rows for one bike is told of the first", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const rows = [aBlock(shop.modelId, { blockId: "SAME-1" }), aBlock(shop.modelId, { blockId: "SAME-2" })];

      const result = await syncBlocks(db, rows, NOW);

      const winners = rows.filter(({ blockId }) => statusOf(result, blockId).level === "ok");
      const losers = rows.filter(({ blockId }) => statusOf(result, blockId).level === "error");
      assert.equal(winners.length, 1);
      assert.equal(losers.length, 1);
      assertNamesConflict(statusOf(result, losers[0].blockId), [[winners[0].blockId, "わ1"]]);
      assert.equal(await stored(db, losers[0].blockId), null);
      assert.equal(await storedCount(db), 1);
    }),
  );

  const NO_BIKE: [string, Bike[]][] = [
    ["a model with no vehicles", []],
    ["a model with only a bike in maintenance", [{ plate: "わ1", status: "maintenance" }]],
    ["a model with only a retired bike", [{ plate: "わ1", status: "retired" }]],
  ];
  for (const [label, bikes] of NO_BIKE) {
    await t.test(`${label} has nothing to give a blank plate`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, bikes);
        await seedShop(db, ["わ9"]);
        const row = aBlock(shop.modelId);

        const result = await syncBlocks(db, [row], NOW);

        const { level, message } = statusOf(result, row.blockId);
        assert.equal(level, "error");
        assert.ok(message.length > 0);
        assert.equal(await storedCount(db), 0);
      }),
    );
  }

  await t.test("a rejected row does not stop the next one", () =>
    withShop(async (db) => {
      const busy = await seedShop(db, ["わ1"]);
      const free = await seedShop(db, ["わ2"]);
      await seedBooking(db, { vehicle_plate: "わ1", start_at: PICKUP, end_at: CLOSE });
      const rejected = aBlock(busy.modelId);
      const taken = aBlock(free.modelId);

      const result = await syncBlocks(db, [rejected, taken], NOW);

      assert.equal(statusOf(result, rejected.blockId).level, "error");
      assert.equal(statusOf(result, taken.blockId).level, "ok");
      assert.deepEqual(counts(result), [2, 0]);
      assert.equal((await mustFind(db, taken.blockId)).vehicle_plate, "わ2");
    }),
  );
});

test("edited blocks move only when free", async (t) => {
  await t.test("to free times, on its own bike", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const row = aBlock(shop.modelId);
      const before = await storeSheet(db, [row]);
      const edited = { ...row, startAt: wall("06-20 10:00"), endAt: wall("06-21 12:00") };

      const result = await syncBlocks(db, [edited], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      assert.deepEqual(counts(result), [1, 0]);
      assertEdited(await mustFind(db, row.blockId), before, { start_at: edited.startAt, end_at: edited.endAt }, LATER);
      assert.equal(await storedCount(db), 1);
      assert.equal(await vacancies(db, shop), 2);
      assert.equal(await vacancies(db, shop, wall("06-20 10:00")), 1);
    }),
  );

  // The other bike is less used by then, so anything but the block's own overlap check leaves the bike it is on.
  const OVER_ITSELF: [string, string, string][] = [
    ["a later end", "10:00", "16:00"],
    ["an earlier start", "09:00", "15:00"],
    ["a move of half an hour", "10:30", "15:30"],
    ["a shorter stay", "11:00", "14:00"],
  ];
  for (const [label, start, end] of OVER_ITSELF) {
    await t.test(`${label} over its own times keeps the bike`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1", "わ2"]);
        const row = aBlock(shop.modelId, { startAt: wall("06-10 10:00"), endAt: wall("06-10 15:00") });
        const before = await storeSheet(db, [row]);
        assert.equal(before.vehicle_plate, "わ1");
        const edited = { ...row, startAt: wall(`06-10 ${start}`), endAt: wall(`06-10 ${end}`) };

        const result = await syncBlocks(db, [edited], LATER);

        assert.equal(statusOf(result, row.blockId).level, "ok");
        assertEdited(await mustFind(db, row.blockId), before, { start_at: edited.startAt, end_at: edited.endAt }, LATER);
      }),
    );
  }

  await t.test("a blank plate reassigns to the least-used free bike when its bike is taken", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", { plate: "わ2", base: 7 }, { plate: "わ3", base: 2 }]);
      const row = aBlock(shop.modelId);
      const before = await storeSheet(db, [row]);
      assert.equal(before.vehicle_plate, "わ1");
      await seedBooking(db, { vehicle_plate: "わ1", start_at: wall("06-20 09:00"), end_at: wall("06-20 18:00") });
      const edited = { ...row, startAt: wall("06-20 10:00"), endAt: wall("06-20 12:00") };

      const result = await syncBlocks(db, [edited], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      assertEdited(
        await mustFind(db, row.blockId),
        before,
        { vehicle_plate: "わ3", start_at: edited.startAt, end_at: edited.endAt },
        LATER,
      );
      assert.equal(await storedCount(db), 1);
    }),
  );

  await t.test("a named plate does not reassign", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const row = aBlock(shop.modelId, { plate: "わ1" });
      await storeSheet(db, [row]);
      await seedBooking(db, {
        vehicle_plate: "わ1",
        ref: "WEB-AAAA",
        start_at: wall("06-20 09:00"),
        end_at: wall("06-20 18:00"),
      });
      const edited = { ...row, startAt: wall("06-20 10:00"), endAt: wall("06-20 12:00") };

      await assertRejected(db, [edited], row.blockId, [["WEB-AAAA", "わ1"]], LATER);
    }),
  );

  await t.test("with nothing free the old block stays, the retry repeats the error, and it goes through once free", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const row = aBlock(shop.modelId);
      const before = await storeSheet(db, [row]);
      const span = { start_at: wall("06-20 09:00"), end_at: wall("06-20 18:00") };
      await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", ...span });
      await seedBooking(db, { vehicle_plate: "わ2", ref: "WEB-BBBB", ...span });
      const edited = { ...row, startAt: wall("06-20 10:00"), endAt: wall("06-20 12:00") };
      const blockers: Blocker[] = [["WEB-AAAA", "わ1"], ["WEB-BBBB", "わ2"]];

      const first = await assertRejected(db, [edited], row.blockId, blockers, LATER);
      assert.deepEqual(await mustFind(db, row.blockId), before);
      assert.deepEqual(counts(first), [1, 0]);

      const retry = await assertRejected(db, [edited], row.blockId, blockers, LATER + HOUR_MS);
      assert.deepEqual(retry.statuses, first.statuses);
      assert.deepEqual(counts(retry), [1, 0]);

      await db.prepare("UPDATE bookings SET status = 'CANCELLED' WHERE ref IN ('WEB-AAAA', 'WEB-BBBB')").run();
      const at = LATER + 2 * HOUR_MS;
      const freed = await syncBlocks(db, [edited], at);
      assert.equal(statusOf(freed, row.blockId).level, "ok");
      assertEdited(await mustFind(db, row.blockId), before, { start_at: edited.startAt, end_at: edited.endAt }, at);
    }),
  );

  // The block ends at [end] on 06-10, and a rental starts at 15:00 on its bike.
  const EDIT_BUFFERS: [turnaround: number, end: string, conflicting: boolean][] = [
    [60, "14:00", false],
    [60, "14:01", true],
    [30, "14:30", false],
    [30, "14:31", true],
  ];
  for (const [turnaround, end, conflicting] of EDIT_BUFFERS) {
    await t.test(`an end of ${end} with ${turnaround} minutes of turnaround`, () =>
      withShop(
        async (db) => {
          const shop = await seedShop(db, ["わ1"]);
          const row = aBlock(shop.modelId, { startAt: wall("06-10 09:00"), endAt: wall("06-10 12:00") });
          const before = await storeSheet(db, [row]);
          await seedBooking(db, {
            vehicle_plate: "わ1",
            ref: "WEB-AAAA",
            start_at: wall("06-10 15:00"),
            end_at: wall("06-10 17:00"),
          });
          const edited = { ...row, endAt: wall(`06-10 ${end}`) };

          if (conflicting) {
            await assertRejected(db, [edited], row.blockId, [["WEB-AAAA", "わ1"]], LATER);
          } else {
            const result = await syncBlocks(db, [edited], LATER);
            assert.equal(statusOf(result, row.blockId).level, "ok");
            assertEdited(await mustFind(db, row.blockId), before, { end_at: edited.endAt }, LATER);
          }
        },
        { turnaround_minutes: turnaround },
      ),
    );
  }

  for (const [label, partial, blocking] of STATES) {
    await t.test(`${label} at the new times, ${blocking ? "and the block stays" : "and the block moves"}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const row = aBlock(shop.modelId);
        const before = await storeSheet(db, [row]);
        const span = { start_at: wall("06-20 09:00"), end_at: wall("06-20 18:00") };
        await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", ...span, ...partial });
        const edited = { ...row, startAt: span.start_at, endAt: span.end_at };

        if (blocking) {
          await assertRejected(db, [edited], row.blockId, [["WEB-AAAA", "わ1"]], NOW);
        } else {
          await syncBlocks(db, [edited], NOW);
          assertEdited(await mustFind(db, row.blockId), before, { ...span }, NOW);
        }
      }),
    );
  }

  for (const plate of [null, "わ1"]) {
    await t.test(`an edit over its own times is told of the rental and not of itself, plate ${plate}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const row = aBlock(shop.modelId, { plate, startAt: wall("06-10 09:00"), endAt: wall("06-10 12:00") });
        await storeSheet(db, [row]);
        await seedBooking(db, {
          vehicle_plate: "わ1",
          ref: "WEB-LIVE",
          start_at: wall("06-10 14:00"),
          end_at: wall("06-10 16:00"),
        });
        const edited = { ...row, endAt: wall("06-10 14:00") };

        await assertRejected(db, [edited], row.blockId, [["WEB-LIVE", "わ1"]], LATER);
      }),
    );
  }

  await t.test("two blocks on one named plate that swap times both stay until staff move one out of the way", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const morning = aBlock(shop.modelId, {
        blockId: "SWAP-A",
        plate: "わ1",
        startAt: wall("06-10 09:00"),
        endAt: wall("06-10 12:00"),
      });
      const evening = aBlock(shop.modelId, {
        blockId: "SWAP-B",
        plate: "わ1",
        startAt: wall("06-10 14:00"),
        endAt: wall("06-10 18:00"),
      });
      await storeSheet(db, [morning, evening]);
      const swappedMorning = { ...morning, startAt: evening.startAt, endAt: evening.endAt };
      const swappedEvening = { ...evening, startAt: morning.startAt, endAt: morning.endAt };
      const swapped = [swappedMorning, swappedEvening];

      const first = await assertRejected(db, swapped, morning.blockId, [["SWAP-B", "わ1"]], LATER);
      assertNamesConflict(statusOf(first, evening.blockId), [["SWAP-A", "わ1"]]);
      assert.deepEqual(counts(first), [2, 0]);

      const retry = await assertRejected(db, swapped, morning.blockId, [["SWAP-B", "わ1"]], LATER + HOUR_MS);
      assertNamesConflict(statusOf(retry, evening.blockId), [["SWAP-A", "わ1"]]);
      assert.deepEqual(retry.statuses, first.statuses);
      assert.deepEqual(counts(retry), [2, 0]);

      // One row parked on another day frees its times. Two runs, because either row may be tried first.
      const parked = { ...morning, startAt: wall("06-20 09:00"), endAt: wall("06-20 12:00") };
      await syncBlocks(db, [parked, swappedEvening], LATER + 2 * HOUR_MS);
      await syncBlocks(db, [parked, swappedEvening], LATER + 3 * HOUR_MS);
      assert.equal((await mustFind(db, morning.blockId)).start_at, parked.startAt);
      assert.equal((await mustFind(db, evening.blockId)).start_at, morning.startAt);

      const done = await syncBlocks(db, swapped, LATER + 4 * HOUR_MS);

      assert.equal(statusOf(done, morning.blockId).level, "ok");
      assert.equal(statusOf(done, evening.blockId).level, "ok");
      assert.equal((await mustFind(db, morning.blockId)).start_at, evening.startAt);
      assert.equal((await mustFind(db, morning.blockId)).vehicle_plate, "わ1");
    }),
  );

  await t.test("the plate column moves a block to a named free bike", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const row = aBlock(shop.modelId, { plate: "わ1" });
      const before = await storeSheet(db, [row]);

      const result = await syncBlocks(db, [{ ...row, plate: "わ2" }], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      assertEdited(await mustFind(db, row.blockId), before, { vehicle_plate: "わ2" }, LATER);
    }),
  );

  await t.test("the plate column does not move a block to a named busy bike", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const row = aBlock(shop.modelId, { plate: "わ1" });
      await storeSheet(db, [row]);
      await seedBooking(db, { vehicle_plate: "わ2", ref: "WEB-BBBB", start_at: PICKUP, end_at: CLOSE });

      await assertRejected(db, [{ ...row, plate: "わ2" }], row.blockId, [["WEB-BBBB", "わ2"]], LATER);
    }),
  );

  await t.test("a plate blanked on a free block stays on its bike", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, [{ plate: "わ1", base: 9 }, "わ2"]);
      const row = aBlock(shop.modelId, { plate: "わ1" });
      const before = await storeSheet(db, [row]);

      const result = await syncBlocks(db, [{ ...row, plate: null }], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      assertEdited(await mustFind(db, row.blockId), before, {}, LATER);
    }),
  );

  await t.test("a plate in maintenance named on the row stays eligible", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, [{ plate: "わ1", status: "maintenance" }, "わ2"]);
      const row = aBlock(shop.modelId, { plate: "わ1" });
      const before = await storeSheet(db, [row]);
      const edited = { ...row, endAt: row.endAt + HOUR_MS };

      await syncBlocks(db, [edited], LATER);

      assertEdited(await mustFind(db, row.blockId), before, { end_at: edited.endAt }, LATER);
    }),
  );

  await t.test("a new model cannot keep the old model's bike", () =>
    withShop(async (db) => {
      const from = await seedShop(db, ["わ1"]);
      const to = await seedShop(db, [{ plate: "わ5", base: 9 }, { plate: "わ6", base: 1 }]);
      const row = aBlock(from.modelId);
      const before = await storeSheet(db, [row]);

      const result = await syncBlocks(db, [{ ...row, modelId: to.modelId }], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      assertEdited(await mustFind(db, row.blockId), before, { model_id: to.modelId, vehicle_plate: "わ6" }, LATER);
    }),
  );

  await t.test("a new model with a named plate takes that plate", () =>
    withShop(async (db) => {
      const from = await seedShop(db, ["わ1"]);
      const to = await seedShop(db, [{ plate: "わ5", base: 9 }, { plate: "わ6", base: 1 }]);
      const row = aBlock(from.modelId);
      const before = await storeSheet(db, [row]);

      await syncBlocks(db, [{ ...row, modelId: to.modelId, plate: "わ5" }], LATER);

      assertEdited(await mustFind(db, row.blockId), before, { model_id: to.modelId, vehicle_plate: "わ5" }, LATER);
    }),
  );

  await t.test("a new model with nothing free leaves the block on the old one", () =>
    withShop(async (db) => {
      const from = await seedShop(db, ["わ1"]);
      const to = await seedShop(db, ["わ5"]);
      const row = aBlock(from.modelId);
      await storeSheet(db, [row]);
      await seedBooking(db, { vehicle_plate: "わ5", ref: "WEB-EEEE", start_at: PICKUP, end_at: CLOSE });

      await assertRejected(db, [{ ...row, modelId: to.modelId }], row.blockId, [["WEB-EEEE", "わ5"]], LATER);
    }),
  );

  await t.test("a block in progress can still be edited", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const row = aBlock(shop.modelId, { startAt: wall("06-01 09:00"), endAt: wall("06-01 18:00") });
      const before = await storeSheet(db, [row]);
      const edited = { ...row, endAt: wall("06-02 18:00") };

      const result = await syncBlocks(db, [edited], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      assertEdited(await mustFind(db, row.blockId), before, { end_at: edited.endAt }, LATER);
    }),
  );
});

test("removed future blocks are cancelled and past ones kept", async (t) => {
  await t.test("past blocks stay, while running and future ones are cancelled", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const past = aBlock(shop.modelId, { startAt: wall("06-02 09:00"), endAt: wall("06-02 18:00") });
      const running = aBlock(shop.modelId, { startAt: wall("06-05 09:00"), endAt: wall("06-06 18:00") });
      const future = aBlock(shop.modelId, { startAt: wall("06-10 09:00"), endAt: wall("06-10 18:00") });
      const kept = aBlock(shop.modelId, { startAt: wall("06-12 09:00"), endAt: wall("06-12 18:00") });
      await storeSheet(db, [past, running, future, kept]);
      const before = new Map((await allBookings(db)).map((row) => [row.external_ref, row]));
      const at = wall("06-05 12:00");

      const result = await syncBlocks(db, [kept], at);

      assert.deepEqual(counts(result), [2, 0]);
      assertCancelled(await mustFind(db, running.blockId), before.get(running.blockId) as BookingRow, at);
      assertCancelled(await mustFind(db, future.blockId), before.get(future.blockId) as BookingRow, at);
      assert.deepEqual(await mustFind(db, past.blockId), before.get(past.blockId));
      assert.deepEqual(await mustFind(db, kept.blockId), before.get(kept.blockId));
    }),
  );

  // Where `now` falls against the block's end, in ms.
  const ENDINGS: [offset: number, cancelled: boolean][] = [
    [-HOUR_MS, true],
    [-1, true],
    [0, false],
    [1, false],
    [HOUR_MS, false],
  ];
  for (const [offset, cancelled] of ENDINGS) {
    await t.test(`a sync ${offset} ms from the block's end ${cancelled ? "cancels it" : "leaves it"}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const row = aBlock(shop.modelId);
        const other = aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") });
        const before = await storeSheet(db, [row, other]);
        const at = row.endAt + offset;

        const result = await syncBlocks(db, [other], at);

        if (cancelled) assertCancelled(await mustFind(db, row.blockId), before, at);
        else assert.deepEqual(await mustFind(db, row.blockId), before);
        assert.deepEqual(counts(result), [cancelled ? 1 : 0, 0]);
      }),
    );
  }

  await t.test("the bike is free again", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const row = aBlock(shop.modelId);
      const other = aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") });
      await storeSheet(db, [row, other]);
      assert.equal(await vacancies(db, shop), 0);

      await syncBlocks(db, [other], NOW);

      assert.equal(await vacancies(db, shop), 1);
      assert.equal((await createHold(db, holdFor(shop), NOW)).ok, true);
    }),
  );

  await t.test("a cancelled block stays as it was cancelled on later syncs", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const row = aBlock(shop.modelId);
      const other = aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") });
      await storeSheet(db, [row, other]);
      await syncBlocks(db, [other], NOW);
      const cancelled = await allBookings(db);

      const result = await syncBlocks(db, [other], LATER);

      assert.deepEqual(await allBookings(db), cancelled);
      assert.deepEqual(counts(result), [0, 0]);
    }),
  );
});

test("rows rejected with a readable id keep their stored blocks", () =>
  withShop(async (db) => {
    const shop = await seedShop(db, ["わ1", "わ2"]);
    const rejected = aBlock(shop.modelId);
    const missing = aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") });
    const present = aBlock(shop.modelId, { startAt: wall("06-25 09:00"), endAt: wall("06-25 18:00") });
    await storeSheet(db, [rejected, missing, present]);
    const before = await mustFind(db, rejected.blockId);
    const gone = await mustFind(db, missing.blockId);

    const result = await syncBlocks(db, [present], LATER, { skippedBlockIds: [rejected.blockId] });

    assert.deepEqual(await mustFind(db, rejected.blockId), before);
    assertCancelled(await mustFind(db, missing.blockId), gone, LATER);
    assert.deepEqual(counts(result), [1, 0]);
    assertNoTabStatus(result);
  }));

test("an emptied Blocks tab cancels nothing and reports an error", async (t) => {
  await t.test("future blocks are kept", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      await storeSheet(db, [aBlock(shop.modelId), aBlock(shop.modelId)]);
      const before = await allBookings(db);

      const result = await syncBlocks(db, [], LATER);

      assertTabError(result);
      assert.deepEqual(await allBookings(db), before);
      assert.deepEqual(counts(result), [0, 0]);
      assert.equal(await vacancies(db, shop), 0);
    }),
  );

  // Any one stored block that has not ended is enough, with an ended one beside it.
  const STILL_RUNNING: [label: string, now: number][] = [
    ["a block in progress", wall("06-10 12:00")],
    ["a block with a millisecond left", CLOSE - 1],
  ];
  for (const [label, now] of STILL_RUNNING) {
    await t.test(`${label} is kept`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const ended = aBlock(shop.modelId, { startAt: wall("06-02 09:00"), endAt: wall("06-02 18:00") });
        await storeSheet(db, [ended, aBlock(shop.modelId)]);
        const before = await allBookings(db);

        const result = await syncBlocks(db, [], now);

        assertTabError(result);
        assert.deepEqual(await allBookings(db), before);
      }),
    );
  }

  const NOTHING_TO_KEEP: [label: string, seed: (db: D1Database, shop: Shop) => Promise<unknown>, now: number][] = [
    ["nothing is stored", async () => {}, NOW],
    [
      "only web bookings are stored",
      (db) => seedBooking(db, { vehicle_plate: "わ1", start_at: PICKUP, end_at: CLOSE, external_ref: "KL-1" }),
      NOW,
    ],
    ["the only block ended long ago", (db, shop) => storeSheet(db, [aBlock(shop.modelId)]), CLOSE + DAY_MS],
    ["the only block ended this instant", (db, shop) => storeSheet(db, [aBlock(shop.modelId)]), CLOSE],
    [
      "the only block is cancelled",
      (db) =>
        seedBooking(db, {
          vehicle_plate: "わ1",
          source: "block",
          status: "CANCELLED",
          external_ref: "OTA-1",
          start_at: PICKUP,
          end_at: CLOSE,
          cancelled_at: NOW,
        }),
      NOW,
    ],
  ];
  for (const [label, seed, now] of NOTHING_TO_KEEP) {
    await t.test(`no error when ${label}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        await seed(db, shop);
        const before = await allBookings(db);

        const result = await syncBlocks(db, [], now);

        assert.deepEqual(result.statuses, []);
        assert.deepEqual(await allBookings(db), before);
      }),
    );
  }

  await t.test("every row rejected with a readable id is not an emptied tab", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const named = aBlock(shop.modelId);
      const unnamed = aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") });
      await storeSheet(db, [named, unnamed]);
      const kept = await mustFind(db, named.blockId);
      const gone = await mustFind(db, unnamed.blockId);

      const result = await syncBlocks(db, [], LATER, { skippedBlockIds: [named.blockId] });

      assert.deepEqual(await mustFind(db, named.blockId), kept);
      assertCancelled(await mustFind(db, unnamed.blockId), gone, LATER);
      assertNoTabStatus(result);
      assert.deepEqual(counts(result), [1, 0]);
    }),
  );

  await t.test("every stored block rejected with a readable id keeps them all with no tab error", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const rows = [aBlock(shop.modelId), aBlock(shop.modelId)];
      await storeSheet(db, rows);
      const before = await allBookings(db);

      const result = await syncBlocks(db, [], LATER, { skippedBlockIds: rows.map(({ blockId }) => blockId) });

      assert.deepEqual(await allBookings(db), before);
      assertNoTabStatus(result);
    }),
  );
});

test("a blank block_id stops the cancel pass and nothing else", async (t) => {
  await t.test("creates and edits run, the missing block stays, and fixing the row cancels it", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const unchanged = aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") });
      const edited = aBlock(shop.modelId, { startAt: wall("06-21 09:00"), endAt: wall("06-21 18:00") });
      const missing = aBlock(shop.modelId, { startAt: wall("06-22 09:00"), endAt: wall("06-22 18:00") });
      await storeSheet(db, [unchanged, edited, missing]);
      const before = await mustFind(db, missing.blockId);
      const editedBefore = await mustFind(db, edited.blockId);
      const created = aBlock(shop.modelId, { startAt: wall("06-23 09:00"), endAt: wall("06-23 18:00") });
      const sheet = [unchanged, { ...edited, note: "changed" }, created];

      const result = await syncBlocks(db, sheet, LATER, { blankIdRows: 1 });

      assert.deepEqual(await mustFind(db, missing.blockId), before);
      assertTabError(result);
      assert.equal(statusOf(result, created.blockId).level, "ok");
      assert.equal(statusOf(result, edited.blockId).level, "ok");
      assertEdited(await mustFind(db, edited.blockId), editedBefore, {}, LATER);
      assert.equal((await mustFind(db, created.blockId)).status, "CONFIRMED");
      assert.deepEqual(counts(result), [2, 0]);

      const at = LATER + HOUR_MS;
      const fixed = await syncBlocks(db, sheet, at);

      assertCancelled(await mustFind(db, missing.blockId), before, at);
      assertNoTabStatus(fixed);
    }),
  );

  await t.test("a tab of only blank ids keeps everything, with one status", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      await storeSheet(db, [aBlock(shop.modelId)]);
      const before = await allBookings(db);

      const result = await syncBlocks(db, [], LATER, { blankIdRows: 2 });

      assertTabError(result);
      assert.deepEqual(await allBookings(db), before);
      assert.deepEqual(counts(result), [0, 0]);
    }),
  );

  const NOTHING_TO_CANCEL: [
    label: string,
    sheet: (rows: ValidBlock[]) => ValidBlock[],
    skipped: (rows: ValidBlock[]) => string[],
    now: number,
  ][] = [
    ["every stored block is on the sheet", (rows) => rows, () => [], LATER],
    ["the missing block has ended", (rows) => rows.slice(0, 1), () => [], wall("06-16 12:00")],
    ["the missing block was rejected with a readable id", (rows) => rows.slice(0, 1), (rows) => [rows[1].blockId], LATER],
  ];
  for (const [label, sheet, skipped, now] of NOTHING_TO_CANCEL) {
    await t.test(`no status when ${label}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const rows = [
          aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") }),
          aBlock(shop.modelId, { startAt: wall("06-15 09:00"), endAt: wall("06-15 18:00") }),
        ];
        await storeSheet(db, rows);
        const before = await allBookings(db);

        const result = await syncBlocks(db, sheet(rows), now, { blankIdRows: 1, skippedBlockIds: skipped(rows) });

        assertNoTabStatus(result);
        assert.deepEqual(await allBookings(db), before);
      }),
    );
  }

  await t.test("no status when the missing block is already cancelled", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const row = aBlock(shop.modelId);
      const missing = aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") });
      await storeSheet(db, [row, missing]);
      await syncBlocks(db, [row], NOW);
      const before = await allBookings(db);

      const result = await syncBlocks(db, [row], LATER, { blankIdRows: 1 });

      assertNoTabStatus(result);
      assert.deepEqual(await allBookings(db), before);
    }),
  );
});

test("a row that returns after its block was cancelled blocks again", async (t) => {
  const CHANGES: [label: string, change: Partial<ValidBlock>, edits: Partial<BookingRow>][] = [
    ["the same content", {}, {}],
    ["a new note", { note: "Back again" }, {}],
    [
      "new times",
      { startAt: wall("06-11 10:00"), endAt: wall("06-11 16:00") },
      { start_at: wall("06-11 10:00"), end_at: wall("06-11 16:00") },
    ],
  ];

  /** `row` and a row that keeps the tab from reading as emptied, stored and then with `row` deleted. */
  async function cancelled(db: D1Database, shop: Shop, partial: Partial<ValidBlock> = {}) {
    const row = aBlock(shop.modelId, partial);
    const anchor = aBlock(shop.modelId, { startAt: wall("07-20 09:00"), endAt: wall("07-20 18:00") });
    const original = await storeSheet(db, [row, anchor]);
    await syncBlocks(db, [anchor], NOW);
    return { row, anchor, original };
  }

  for (const [label, change, edits] of CHANGES) {
    await t.test(`${label}, free`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const { row, anchor, original } = await cancelled(db, shop);
        const returned = { ...row, ...change };
        assert.equal(await vacancies(db, shop, returned.startAt), 1);

        const result = await syncBlocks(db, [returned, anchor], LATER);

        assert.equal(statusOf(result, row.blockId).level, "ok");
        assert.deepEqual(counts(result), [1, 0]);
        const after = await mustFind(db, row.blockId);
        const { content_hash, confirmed_at } = after;
        assert.deepEqual(after, { ...original, ...edits, updated_at: LATER, content_hash, confirmed_at });
        assert.equal((await allBookings(db)).length, 2);
        assert.equal(await vacancies(db, shop, returned.startAt), 0);
        assert.deepEqual(await createHold(db, holdFor(shop, returned.startAt), NOW), SOLD_OUT);

        // Back in place, it is an unchanged row like any other.
        const settled = await allBookings(db);
        const rerun = await syncBlocks(db, [returned, anchor], LATER + HOUR_MS);
        assert.deepEqual(await allBookings(db), settled);
        assert.deepEqual(counts(rerun), [0, 0]);
      }),
    );

    await t.test(`${label}, taken meanwhile`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const { row, anchor } = await cancelled(db, shop);
        const returned = { ...row, ...change };
        await seedBooking(db, {
          vehicle_plate: "わ1",
          ref: "WEB-AAAA",
          start_at: returned.startAt,
          end_at: returned.endAt,
        });

        const first = await assertRejected(db, [returned, anchor], row.blockId, [["WEB-AAAA", "わ1"]], LATER);

        assert.equal((await mustFind(db, row.blockId)).status, "CANCELLED");
        assert.deepEqual(counts(first), [1, 0]);
        const retry = await assertRejected(db, [returned, anchor], row.blockId, [["WEB-AAAA", "わ1"]], LATER + HOUR_MS);
        assert.deepEqual(retry.statuses, first.statuses);
      }),
    );
  }

  await t.test("a blank plate returns on another free bike", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", { plate: "わ2", base: 4 }]);
      const { row, anchor } = await cancelled(db, shop);
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ1");
      await seedBooking(db, { vehicle_plate: "わ1", start_at: row.startAt, end_at: row.endAt });

      const result = await syncBlocks(db, [row, anchor], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      const after = await mustFind(db, row.blockId);
      assert.equal(after.status, "CONFIRMED");
      assert.equal(after.vehicle_plate, "わ2");
      assert.equal(after.cancelled_at, null);
      assert.equal(after.cancel_reason, null);
    }),
  );

  await t.test("a named plate does not return on another bike", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const { row, anchor } = await cancelled(db, shop, { plate: "わ1" });
      await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", start_at: row.startAt, end_at: row.endAt });

      await assertRejected(db, [row, anchor], row.blockId, [["WEB-AAAA", "わ1"]], LATER);
    }),
  );

  await t.test("the turnaround buffer holds for a returning row", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const { row, anchor } = await cancelled(db, shop, { startAt: wall("06-10 09:00"), endAt: wall("06-10 12:00") });
      await seedBooking(db, {
        vehicle_plate: "わ1",
        ref: "WEB-AAAA",
        start_at: wall("06-10 12:30"),
        end_at: wall("06-10 15:00"),
      });

      await assertRejected(db, [row, anchor], row.blockId, [["WEB-AAAA", "わ1"]], LATER);
    }),
  );

  await t.test("a row rejected by the sheet does not bring its block back", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const { row, anchor } = await cancelled(db, shop);
      const before = await allBookings(db);

      await syncBlocks(db, [anchor], LATER, { skippedBlockIds: [row.blockId] });

      assert.deepEqual(await allBookings(db), before);
    }),
  );
});

test("ended blocks are left alone in every path", async (t) => {
  const ROW_EDITS: [label: string, change: (row: ValidBlock, other: Shop) => Partial<ValidBlock>][] = [
    ["new times", () => ({ startAt: wall("07-01 09:00"), endAt: wall("07-01 18:00") })],
    ["a later end", (row) => ({ endAt: row.endAt + DAY_MS })],
    ["a new note", () => ({ note: "Too late" })],
    ["a new channel", () => ({ channel: "Too late" })],
    ["a new plate", () => ({ plate: "わ2" })],
    ["a new model", (_, other) => ({ modelId: other.modelId })],
  ];

  for (const [label, change] of ROW_EDITS) {
    for (const [when, at] of [["at its end", CLOSE], ["long after", CLOSE + 2 * DAY_MS]] as const) {
      await t.test(`${label} ${when} writes nothing and warns`, () =>
        withShop(async (db) => {
          const shop = await seedShop(db, ["わ1", "わ2"]);
          const other = await seedShop(db, ["わ3"]);
          const row = aBlock(shop.modelId, { plate: "わ1" });
          await storeSheet(db, [row]);
          const before = await allBookings(db);

          const result = await syncBlocks(db, [{ ...row, ...change(row, other) }], at);

          assert.equal(statusOf(result, row.blockId).level, "warning");
          assert.deepEqual(await allBookings(db), before);
          assert.deepEqual(counts(result), [0, 0]);
        }),
      );
    }
  }

  await t.test("an unchanged row of an ended block is ok", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const row = aBlock(shop.modelId);
      await storeSheet(db, [row]);
      const before = await allBookings(db);

      const result = await syncBlocks(db, [row], CLOSE + DAY_MS);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      assert.deepEqual(await allBookings(db), before);
      assert.deepEqual(counts(result), [0, 0]);
    }),
  );

  await t.test("a cancelled block that has ended does not come back", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const row = aBlock(shop.modelId);
      const anchor = aBlock(shop.modelId, { startAt: wall("07-20 09:00"), endAt: wall("07-20 18:00") });
      await storeSheet(db, [row, anchor]);
      await syncBlocks(db, [anchor], NOW);
      const before = await allBookings(db);

      const result = await syncBlocks(db, [row, anchor], CLOSE + DAY_MS);

      assert.deepEqual(await allBookings(db), before);
      assert.deepEqual(counts(result), [0, 0]);
    }),
  );

  await t.test("an ended block takes no slot of the cap", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const ended = aBlock(shop.modelId);
      await storeSheet(db, [ended]);
      const fresh = aBlock(shop.modelId, { startAt: wall("07-01 09:00"), endAt: wall("07-01 18:00") });

      const result = await syncBlocks(db, [{ ...ended, note: "Too late" }, fresh], CLOSE + DAY_MS, { maxChanges: 1 });

      assert.deepEqual(counts(result), [1, 0]);
      assert.equal(statusOf(result, fresh.blockId).level, "ok");
      assert.equal((await mustFind(db, fresh.blockId)).status, "CONFIRMED");
    }),
  );
});

test("only block rows are ever touched", async (t) => {
  await t.test("a web booking under a removed id stays", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const removed = aBlock(shop.modelId);
      const kept = aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") });
      await storeSheet(db, [removed, kept]);
      const web = await seedBooking(db, {
        vehicle_plate: "わ2",
        external_ref: removed.blockId,
        start_at: wall("06-25 09:00"),
        end_at: wall("06-25 18:00"),
      });

      await syncBlocks(db, [kept], LATER);

      assert.equal((await mustFind(db, removed.blockId)).status, "CANCELLED");
      assert.deepEqual(await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(web.id).first(), web);
    }),
  );

  await t.test("web bookings with an external_ref are not stored blocks", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const web = await seedBooking(db, {
        vehicle_plate: "わ1",
        external_ref: "NOT-ON-THE-SHEET",
        start_at: PICKUP,
        end_at: CLOSE,
      });
      const pending = await seedBooking(db, {
        vehicle_plate: "わ2",
        status: "PAYMENT_PENDING",
        external_ref: "ALSO-NOT",
        start_at: PICKUP,
        end_at: CLOSE,
      });
      const row = aBlock(shop.modelId, { startAt: wall("06-20 09:00"), endAt: wall("06-20 18:00") });

      const result = await syncBlocks(db, [row], NOW);

      assert.deepEqual(counts(result), [1, 0]);
      const rows = await allBookings(db);
      assert.deepEqual(rows.find(({ id }) => id === web.id), web);
      assert.deepEqual(rows.find(({ id }) => id === pending.id), pending);
    }),
  );

  await t.test("a new row under a web booking's external_ref makes its own block", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const web = await seedBooking(db, {
        vehicle_plate: "わ1",
        external_ref: "SHARED-ID",
        start_at: PICKUP,
        end_at: CLOSE,
      });
      const row = aBlock(shop.modelId, {
        blockId: "SHARED-ID",
        startAt: wall("06-20 09:00"),
        endAt: wall("06-20 18:00"),
      });

      const result = await syncBlocks(db, [row], NOW);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      // The web booking is a day of usage on わ1.
      assertStoredAs(await mustFind(db, row.blockId), row, "わ2", NOW);
      assert.deepEqual((await allBookings(db)).find(({ id }) => id === web.id), web);
    }),
  );
});

test("a second sync with no changes is a no-op", async (t) => {
  await t.test("every column of every row stays, for rows of every kind", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", { plate: "わ2", base: 1 }, { plate: "わ3", status: "maintenance" }]);
      await seedBooking(db, { vehicle_plate: "わ1", start_at: wall("06-25 09:00"), end_at: wall("06-25 18:00") });
      const sheet = [
        aBlock(shop.modelId),
        aBlock(shop.modelId, { plate: "わ3" }),
        aBlock(shop.modelId, { startAt: wall("06-11 09:00"), endAt: wall("06-11 18:00"), channel: "", reference: "", note: "" }),
        aBlock(shop.modelId, { startAt: wall("06-02 09:00"), endAt: wall("06-02 18:00") }),
      ];
      const removed = aBlock(shop.modelId, { startAt: wall("06-15 09:00"), endAt: wall("06-15 18:00") });
      await storeSheet(db, [...sheet, removed]);
      await syncBlocks(db, sheet, LATER);
      assert.equal((await mustFind(db, removed.blockId)).status, "CANCELLED");
      const before = await allBookings(db);

      // Days later, with one block ended, the rows in another order, and the usage of each bike moved by the blocks.
      const result = await syncBlocks(db, [...sheet].reverse(), wall("06-05 12:00"));

      assert.deepEqual(await allBookings(db), before);
      assert.deepEqual(counts(result), [0, 0]);
      for (const { blockId } of sheet) assert.equal(statusOf(result, blockId).level, "ok", blockId);
    }),
  );

  await t.test("a rejected create writes nothing the second time either", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", start_at: PICKUP, end_at: CLOSE });
      const row = aBlock(shop.modelId);

      const first = await assertRejected(db, [row], row.blockId, [["WEB-AAAA", "わ1"]]);
      const second = await assertRejected(db, [row], row.blockId, [["WEB-AAAA", "わ1"]], LATER);

      assert.deepEqual(second.statuses, first.statuses);
      assert.deepEqual(counts(second), [1, 0]);
    }),
  );
});

test("blocks and concurrent holds never overlap", async (t) => {
  // The last round names a plate on every row, so each bike has a row that may not fall back to another.
  // Rounds 1 to 3 run the same race again, for the interleavings it may land in: three rounds in a full run
  // (PROPERTY_RUNS=full, or a count of its own), one by default.
  const repeats = propertyRuns(process.env, { bounded: 1, full: 3 });
  const ROUNDS: [round: string, named: boolean][] = [
    ...Array.from({ length: repeats }, (_, i): [string, boolean] => [`round ${i + 1}`, false]),
    ["round of named plates", true],
  ];

  for (const fleetSize of [1, 2, 3, 5]) {
    for (const [round, named] of ROUNDS) {
      await t.test(`${fleetSize} bikes, ${round}`, () =>
        withShop(async (db) => {
          const label = `${fleetSize} bikes, ${round}`;
          const bufMs = 60 * MINUTE_MS;
          const plates = Array.from({ length: fleetSize }, (_, i) => `わ${i + 1}`);
          const shop = await seedShop(db, plates);
          const contenders = fleetSize + 2;
          const sheet = Array.from({ length: contenders }, (_, at) =>
            aBlock(shop.modelId, { plate: named ? plates[at % fleetSize] : null }),
          );

          const holdsAt = (startAt: number) =>
            Array.from({ length: contenders }, () => createHold(db, holdFor(shop, startAt), NOW));

          // Holds go out on both sides of the sync, so the sync is neither first nor last to reach the bikes.
          const firstHolds = holdsAt(PICKUP);
          const created = syncBlocks(db, sheet, NOW);
          const moreHolds = holdsAt(PICKUP);
          const [holds, result] = await Promise.all([Promise.all([...firstHolds, ...moreHolds]), created]);

          for (const hold of holds) assert.ok(hold.ok || hold.reason === "SOLD_OUT", JSON.stringify(hold));
          const afterCreate = await allBookings(db);
          assertNoOverlaps(afterCreate, NOW, bufMs, label);
          assert.equal(afterCreate.length, fleetSize, `${label}: every bike is taken once`);
          for (const { blockId } of sheet) {
            const taken = (await stored(db, blockId)) !== null;
            assert.equal(statusOf(result, blockId).level, taken ? "ok" : "error", blockId);
          }

          // The same race for the next day, with each stored block now moving into it.
          const moved = sheet.map((row) => ({ ...row, startAt: row.startAt + DAY_MS, endAt: row.endAt + DAY_MS }));
          const nextHolds = holdsAt(PICKUP + DAY_MS);
          const edited = syncBlocks(db, moved, NOW);
          await Promise.all([...nextHolds, edited]);
          assertNoOverlaps(await allBookings(db), NOW, bufMs, `${label}, moved`);
        }),
      );
    }
  }

  await t.test("the block that takes the last bike ends availability and holds", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const held = await createHold(db, holdFor(shop), NOW);
      assert.equal(held.ok, true);
      assert.equal(await vacancies(db, shop), 1);
      const row = aBlock(shop.modelId);

      const result = await syncBlocks(db, [row], NOW);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      assert.equal(await vacancies(db, shop), 0);
      assert.deepEqual(await createHold(db, holdFor(shop), NOW), SOLD_OUT);
      assertNoOverlaps(await allBookings(db), NOW, 60 * MINUTE_MS, "last bike");
    }),
  );
});

test("a hold that lands just before the write is never overlapped", async (t) => {
  const BUF_MS = 60 * MINUTE_MS;

  for (const plate of [null, "わ1"]) {
    await t.test(`the last bike goes to the hold, plate ${plate}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const row = aBlock(shop.modelId, { plate });
        const race = raceBeforeWrite(db, () => createHold(db, holdFor(shop), NOW));

        const result = await syncBlocks(race.db, [row], NOW);

        assert.equal(race.raced(), true);
        assert.equal(statusOf(result, row.blockId).level, "error");
        assert.equal(await stored(db, row.blockId), null);
        assertNoOverlaps(await allBookings(db), NOW, BUF_MS, "new block");
      }),
    );
  }

  await t.test("a blank plate still finds the other free bike", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", { plate: "わ2", base: 9 }]);
      const row = aBlock(shop.modelId);
      const race = raceBeforeWrite(db, () => createHold(db, holdFor(shop), NOW));

      const result = await syncBlocks(race.db, [row], NOW);

      assert.equal(race.raced(), true);
      assert.equal(statusOf(result, row.blockId).level, "ok");
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ2");
      assertNoOverlaps(await allBookings(db), NOW, BUF_MS, "second bike");
    }),
  );

  for (const plate of [null, "わ1"]) {
    await t.test(`an edit leaves the block where it was, plate ${plate}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const row = aBlock(shop.modelId, { plate });
        const before = await storeSheet(db, [row]);
        const next = wall("06-20 09:00");
        const edited = { ...row, startAt: next, endAt: wall("06-20 18:00") };
        const race = raceBeforeWrite(db, () => createHold(db, holdFor(shop, next), NOW));

        const result = await syncBlocks(race.db, [edited], NOW);

        assert.equal(race.raced(), true);
        assert.equal(statusOf(result, row.blockId).level, "error");
        assert.deepEqual(await mustFind(db, row.blockId), before);
        assertNoOverlaps(await allBookings(db), NOW, BUF_MS, "edit");
      }),
    );
  }

  await t.test("an edit with a named plate does not reassign past the hold", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", { plate: "わ2", base: 50 }]);
      const row = aBlock(shop.modelId, { plate: "わ1" });
      const before = await storeSheet(db, [row]);
      const next = wall("06-20 09:00");
      const edited = { ...row, startAt: next, endAt: wall("06-20 18:00") };
      // わ2 has far more usage, so the hold takes the bike the row names and わ2 stays free.
      const race = raceBeforeWrite(db, () => createHold(db, holdFor(shop, next), NOW));

      const result = await syncBlocks(race.db, [edited], NOW);

      assert.equal(race.raced(), true);
      assert.equal(statusOf(result, row.blockId).level, "error");
      assert.deepEqual(await mustFind(db, row.blockId), before);
      assertNoOverlaps(await allBookings(db), NOW, BUF_MS, "edit, named");
    }),
  );

  await t.test("a plate-column move stays on its bike when a hold takes the named one", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const row = aBlock(shop.modelId, { plate: "わ1" });
      const before = await storeSheet(db, [row]);
      // The block itself holds わ1 at these times, so the hold can only land on わ2.
      const race = raceBeforeWrite(db, () => createHold(db, holdFor(shop), NOW));

      const result = await syncBlocks(race.db, [{ ...row, plate: "わ2" }], NOW);

      assert.equal(race.raced(), true);
      const hold = (await allBookings(db)).find(({ status }) => status === "ON_HOLD");
      assert.equal(hold?.vehicle_plate, "わ2");
      assert.equal(statusOf(result, row.blockId).level, "error");
      assert.deepEqual(await mustFind(db, row.blockId), before);
      assertNoOverlaps(await allBookings(db), NOW, BUF_MS, "plate column");
    }),
  );

  await t.test("an edit with a blank plate reassigns past the hold", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", { plate: "わ2", base: 50 }]);
      const row = aBlock(shop.modelId);
      const before = await storeSheet(db, [row]);
      assert.equal(before.vehicle_plate, "わ1");
      const next = wall("06-20 09:00");
      const edited = { ...row, startAt: next, endAt: wall("06-20 18:00") };
      // わ2 has far more usage, so the hold takes わ1 and the block's own bike is what the rival takes.
      const race = raceBeforeWrite(db, () => createHold(db, holdFor(shop, next), NOW));

      const result = await syncBlocks(race.db, [edited], NOW);

      assert.equal(race.raced(), true);
      assert.equal(statusOf(result, row.blockId).level, "ok");
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ2");
      assertNoOverlaps(await allBookings(db), NOW, BUF_MS, "edit, reassigned");
    }),
  );

  for (const plate of [null, "わ1"]) {
    await t.test(`a returning row stays cancelled, plate ${plate}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const row = aBlock(shop.modelId, { plate });
        const anchor = aBlock(shop.modelId, { startAt: wall("07-20 09:00"), endAt: wall("07-20 18:00") });
        await storeSheet(db, [row, anchor]);
        await syncBlocks(db, [anchor], NOW);
        const cancelled = await mustFind(db, row.blockId);
        const race = raceBeforeWrite(db, () => createHold(db, holdFor(shop), NOW));

        const result = await syncBlocks(race.db, [row, anchor], NOW);

        assert.equal(race.raced(), true);
        assert.equal(statusOf(result, row.blockId).level, "error");
        assert.equal((await mustFind(db, row.blockId)).status, "CANCELLED");
        assert.deepEqual(await mustFind(db, row.blockId), cancelled);
        assertNoOverlaps(await allBookings(db), NOW, BUF_MS, "returning row");
      }),
    );
  }
});

test("changes per call are capped and remaining reported", async (t) => {
  const FIRST_DAY = wall("07-01 09:00");

  for (const [label, next] of [
    ["with no cursor", (): SyncOptions => ({})],
    ["on the cursor", (previous: SyncResult): SyncOptions => ({ cursor: previous.cursor })],
  ] as const) {
    await t.test(`25 free new blocks go 20, 5 and none, ${label}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const sheet = dailyRows(shop.modelId, 25, FIRST_DAY);

        const first = await syncBlocks(db, sheet, NOW);
        assert.deepEqual(counts(first), [20, 5]);
        assert.equal(await storedCount(db), 20);

        const second = await syncBlocks(db, sheet, NOW, next(first));
        assert.deepEqual(counts(second), [5, 0]);
        assert.equal(await storedCount(db), 25);

        const done = await allBookings(db);
        const third = await syncBlocks(db, sheet, NOW, next(second));
        assert.deepEqual(counts(third), [0, 0]);
        assert.deepEqual(await allBookings(db), done);
      }),
    );
  }

  const CAPS: [rows: number, cap: number, expected: [number, number][]][] = [
    [5, 1, [[1, 4], [1, 3], [1, 2], [1, 1], [1, 0]]],
    [7, 3, [[3, 4], [3, 1], [1, 0]]],
    [4, 10, [[4, 0]]],
    [25, 22, [[22, 3], [3, 0]]],
  ];
  for (const [rows, cap, expected] of CAPS) {
    await t.test(`${rows} rows under a cap of ${cap}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const sheet = dailyRows(shop.modelId, rows, FIRST_DAY);

        const calls = await syncToEnd(db, sheet, NOW, { maxChanges: cap });

        assert.deepEqual(calls.map(counts), expected);
        assert.equal(await storedCount(db), rows);
      }),
    );
  }

  await t.test("each change not attempted gets a warning and each attempted one its result", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const rows = dailyRows(shop.modelId, 3, FIRST_DAY);
      await storeSheet(db, rows);
      const fresh = dailyRows(shop.modelId, 3, wall("08-01 09:00"));
      const edited = rows.map((row) => ({ ...row, note: "changed" }));
      const sheet = [...edited, ...fresh];

      const result = await syncBlocks(db, sheet, NOW, { maxChanges: 2 });

      assert.deepEqual(counts(result), [2, 4]);
      const levels = sheet.map(({ blockId }) => statusOf(result, blockId).level).sort();
      assert.deepEqual(levels, ["ok", "ok", "warning", "warning", "warning", "warning"]);
    }),
  );

  await t.test("cancels, edits and creates all count, and unchanged and ended rows do not", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const ended = dailyRows(shop.modelId, 2, wall("06-02 09:00"));
      const unchanged = dailyRows(shop.modelId, 4, wall("07-01 09:00"));
      const toEdit = dailyRows(shop.modelId, 3, wall("07-10 09:00"));
      const toCancel = dailyRows(shop.modelId, 3, wall("07-20 09:00"));
      await storeSheet(db, [...ended, ...unchanged, ...toEdit, ...toCancel]);
      const created = dailyRows(shop.modelId, 3, wall("08-01 09:00"));
      const edited = toEdit.map((row) => ({ ...row, endAt: row.endAt + HOUR_MS }));
      const lateEdits = ended.map((row) => ({ ...row, note: "Too late" }));
      const sheet = [...lateEdits, ...unchanged, ...edited, ...created];
      const at = wall("06-05 12:00");

      const calls = await syncToEnd(db, sheet, at, { maxChanges: 4 });

      assert.deepEqual(calls.map(counts), [[4, 5], [4, 1], [1, 0]]);
      for (const { blockId } of toCancel) assert.equal((await mustFind(db, blockId)).status, "CANCELLED");
      for (const { blockId, endAt } of edited) assert.equal((await mustFind(db, blockId)).end_at, endAt);
      for (const { blockId } of created) assert.equal((await mustFind(db, blockId)).status, "CONFIRMED");
    }),
  );

  await t.test("a failed attempt counts, because it spent queries", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      await seedBooking(db, { vehicle_plate: "わ1", start_at: PICKUP, end_at: CLOSE });
      const sheet = [
        aBlock(shop.modelId),
        aBlock(shop.modelId),
        aBlock(shop.modelId, { startAt: wall("07-01 09:00"), endAt: wall("07-01 18:00") }),
      ];

      const calls = await syncToEnd(db, sheet, NOW, { maxChanges: 1 });

      assert.deepEqual(calls.map(counts), [[1, 2], [1, 1], [1, 0]]);
    }),
  );

  await t.test("a reinstated row counts as a change", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const returning = dailyRows(shop.modelId, 2, FIRST_DAY);
      const anchor = aBlock(shop.modelId, { startAt: wall("08-20 09:00"), endAt: wall("08-20 18:00") });
      await storeSheet(db, [...returning, anchor]);
      await syncBlocks(db, [anchor], NOW);

      const calls = await syncToEnd(db, [...returning, anchor], LATER, { maxChanges: 1 });

      assert.deepEqual(calls.map(counts), [[1, 1], [1, 0]]);
      for (const { blockId } of returning) assert.equal((await mustFind(db, blockId)).status, "CONFIRMED");
    }),
  );
});

test("failed rows never starve the rows after them", async (t) => {
  const ORDERS: [label: string, order: (failing: ValidBlock[], good: ValidBlock[]) => ValidBlock[]][] = [
    ["the failing rows first", (failing, good) => [...failing, ...good]],
    ["the good rows first", (failing, good) => [...good, ...failing]],
    ["the good rows among them", (failing, good) => [...failing.slice(0, 22), ...good, ...failing.slice(22)]],
  ];

  async function seedRows(db: D1Database): Promise<{ failing: ValidBlock[]; good: ValidBlock[] }> {
    const busy = await seedShop(db, ["わ1"]);
    const free = await seedShop(db, ["わ2"]);
    await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", start_at: PICKUP, end_at: CLOSE });
    const failing = Array.from({ length: 25 }, () => aBlock(busy.modelId));
    return { failing, good: dailyRows(free.modelId, 5, wall("07-01 09:00")) };
  }

  for (const [label, order] of ORDERS) {
    await t.test(`${label}: a pass on the cursor reaches every row`, () =>
      withShop(async (db) => {
        const { failing, good } = await seedRows(db);

        const calls = await syncToEnd(db, order(failing, good), NOW);

        assert.ok(calls.length <= 3, `${calls.length} calls`);
        assert.equal(calls.reduce((sum, { processed }) => sum + processed, 0), 30);
        for (const { blockId } of good) {
          assert.equal((await mustFind(db, blockId)).status, "CONFIRMED", blockId);
          assert.match(levelsOf(calls, blockId), /^(warning )*ok( ok)*$/, blockId);
        }
        for (const { blockId } of failing) {
          assert.equal(await stored(db, blockId), null, blockId);
          // Told once, and never told otherwise by a later call of the pass.
          assert.match(levelsOf(calls, blockId), /^(warning )*error$/, blockId);
        }
      }),
    );
  }

  await t.test("a cap of 7 gets there too", () =>
    withShop(async (db) => {
      const { failing, good } = await seedRows(db);

      const calls = await syncToEnd(db, [...failing, ...good], NOW, { maxChanges: 7 });

      assert.equal(calls.reduce((sum, { processed }) => sum + processed, 0), 30);
      for (const { blockId } of good) assert.equal((await mustFind(db, blockId)).status, "CONFIRMED");
    }),
  );

  await t.test("a pass with no cursor starts over", () =>
    withShop(async (db) => {
      const { failing, good } = await seedRows(db);
      const sheet = [...failing, ...good];
      await syncToEnd(db, sheet, NOW);

      const fresh = await syncBlocks(db, sheet, NOW);

      // The five good rows are unchanged by now, and 25 failing rows are changes once more.
      assert.deepEqual(counts(fresh), [20, 5]);
      const errors = fresh.statuses.filter(({ level }) => level === "error");
      assert.equal(errors.length, 20);

      const again = await syncToEnd(db, sheet, NOW);
      assert.deepEqual(again.map(counts), [[20, 5], [5, 0]]);
      for (const { blockId } of failing) assert.match(levelsOf(again, blockId), /^(warning )*error$/, blockId);
    }),
  );
});

test("a malformed or stale cursor restarts the pass", async (t) => {
  const BAD_CURSORS: [label: string, cursor: string][] = [
    ["an empty string", ""],
    ["text that is no cursor", "%%% not a cursor %%%"],
    ["text sorting after every key", "￿￿"],
    ["text sorting before every key", "!"],
    ["a control character", "\u0000"],
    ["a number past the end", "999999"],
    ["a negative number", "-1"],
    ["a fraction", "1.5"],
    ["a block_id on no row", "BLK-GONE"],
    ["JSON", '{"at":1}'],
  ];

  for (const [label, cursor] of BAD_CURSORS) {
    await t.test(`${label} goes from the first change, as no cursor does`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", start_at: PICKUP, end_at: CLOSE });
        const sheet = Array.from({ length: 5 }, () => aBlock(shop.modelId));
        const before = await allBookings(db);
        const fresh = await syncBlocks(db, sheet, NOW, { maxChanges: 2 });
        assert.deepEqual(counts(fresh), [2, 3]);
        assert.equal(fresh.statuses.filter(({ level }) => level === "error").length, 2);

        const restarted = await syncBlocks(db, sheet, NOW, { maxChanges: 2, cursor });

        assert.deepEqual(counts(restarted), [2, 3]);
        assert.deepEqual(restarted.statuses, fresh.statuses);
        assert.deepEqual(await allBookings(db), before);
      }),
    );
  }

  await t.test("the block_id of an unchanged row is no pending change", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const free = await seedShop(db, ["わ2"]);
      await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", start_at: PICKUP, end_at: CLOSE });
      const unchanged = aBlock(free.modelId, { blockId: "ZZZ-KEPT" });
      await storeSheet(db, [unchanged]);
      const sheet = [unchanged, aBlock(shop.modelId), aBlock(shop.modelId), aBlock(shop.modelId)];
      const fresh = await syncBlocks(db, sheet, NOW, { maxChanges: 2 });
      assert.deepEqual(counts(fresh), [2, 1]);

      const restarted = await syncBlocks(db, sheet, NOW, { maxChanges: 2, cursor: unchanged.blockId });

      assert.deepEqual(counts(restarted), [2, 1]);
      assert.deepEqual(restarted.statuses, fresh.statuses);
    }),
  );

  await t.test("a cursor from a pass whose rows have gone reaches every new change", () =>
    withShop(async (db) => {
      const busy = await seedShop(db, ["わ1"]);
      const free = await seedShop(db, ["わ2"]);
      await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", start_at: PICKUP, end_at: CLOSE });
      const failing = Array.from({ length: 5 }, (_, at) => aBlock(busy.modelId, { blockId: `MID-${at}` }));
      const { cursor } = await syncBlocks(db, failing, NOW, { maxChanges: 2 });
      assert.equal(typeof cursor, "string");

      // Staff replace the tab: rows on both sides of the old ones by id, position and time, and more than the old offset.
      const replacing = [
        aBlock(free.modelId, { blockId: "AAA-1", startAt: wall("07-01 09:00"), endAt: wall("07-01 18:00") }),
        aBlock(free.modelId, { blockId: "MMM-2", startAt: wall("07-02 09:00"), endAt: wall("07-02 18:00") }),
        aBlock(free.modelId, { blockId: "ZZZ-3", startAt: wall("07-03 09:00"), endAt: wall("07-03 18:00") }),
      ];

      const result = await syncBlocks(db, replacing, NOW, { cursor });

      assert.deepEqual(counts(result), [3, 0]);
      for (const { blockId } of replacing) {
        assert.equal(statusOf(result, blockId).level, "ok", blockId);
        assert.equal((await mustFind(db, blockId)).status, "CONFIRMED", blockId);
      }
    }),
  );
});

test("cancels run before creates and edits", async (t) => {
  for (const plate of [null, "わ1"]) {
    await t.test(`a new row takes the times of a deleted one, plate ${plate}`, () =>
      withShop(async (db) => {
        const shop = await seedShop(db, ["わ1"]);
        const leaving = aBlock(shop.modelId, { plate });
        const anchor = aBlock(shop.modelId, { startAt: wall("07-20 09:00"), endAt: wall("07-20 18:00") });
        const before = await storeSheet(db, [leaving, anchor]);
        const arriving = aBlock(shop.modelId, { plate });

        const result = await syncBlocks(db, [arriving, anchor], LATER);

        assert.equal(statusOf(result, arriving.blockId).level, "ok");
        assert.deepEqual(counts(result), [2, 0]);
        assertCancelled(await mustFind(db, leaving.blockId), before, LATER);
        assertStoredAs(await mustFind(db, arriving.blockId), arriving, "わ1", LATER);
      }),
    );
  }

  await t.test("an edited row moves into the times of a deleted one", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const leaving = aBlock(shop.modelId);
      const moving = aBlock(shop.modelId, { startAt: wall("07-20 09:00"), endAt: wall("07-20 18:00") });
      const before = await storeSheet(db, [leaving, moving]);
      const edited = { ...moving, startAt: leaving.startAt, endAt: leaving.endAt };

      const result = await syncBlocks(db, [edited], LATER);

      assert.equal(statusOf(result, moving.blockId).level, "ok");
      assertCancelled(await mustFind(db, leaving.blockId), before, LATER);
      assert.equal((await mustFind(db, moving.blockId)).start_at, leaving.startAt);
    }),
  );

  await t.test("under a cap of one the cancel still goes first", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const leaving = aBlock(shop.modelId);
      const anchor = aBlock(shop.modelId, { startAt: wall("07-20 09:00"), endAt: wall("07-20 18:00") });
      await storeSheet(db, [leaving, anchor]);
      const arriving = aBlock(shop.modelId);
      const sheet = [arriving, anchor];

      const first = await syncBlocks(db, sheet, LATER, { maxChanges: 1 });

      assert.deepEqual(counts(first), [1, 1]);
      assert.equal((await mustFind(db, leaving.blockId)).status, "CANCELLED");
      assert.equal(await stored(db, arriving.blockId), null);
      assert.equal(statusOf(first, arriving.blockId).level, "warning");

      const second = await syncBlocks(db, sheet, LATER, { maxChanges: 1, cursor: first.cursor });

      assert.deepEqual(counts(second), [1, 0]);
      assert.equal(statusOf(second, arriving.blockId).level, "ok");
    }),
  );
});

test("one sync stays inside the D1 budget", async (t) => {
  // Workers Free allows 50 queries per invocation, and the endpoint's own reads need the rest.
  const BUDGET = 44;
  const WINDOW = { startAt: wall("09-01 09:00"), endAt: wall("09-01 18:00") };
  const PLATES = ["わ1", "わ2", "わ3"];

  /** Three bikes with `span` taken on each of them. */
  async function busyShop(db: D1Database, span: { start_at: number; end_at: number }): Promise<Shop> {
    const shop = await seedShop(db, PLATES);
    await holdBikes(db, span);
    return shop;
  }

  async function holdBikes(db: D1Database, span: { start_at: number; end_at: number }): Promise<void> {
    for (const plate of PLATES) await seedBooking(db, { vehicle_plate: plate, ...span });
  }

  async function assertWithinBudget(db: D1Database, sheet: ValidBlock[], now = NOW): Promise<SyncResult> {
    const counted = probe(db);
    const result = await syncBlocks(counted.db, sheet, now);
    assert.equal(result.processed, 20);
    assert.ok(counted.statements() > 0, "the probe saw nothing");
    assert.ok(counted.statements() <= BUDGET, `${counted.statements()} statements`);
    return result;
  }

  const WINDOW_ROW = { start_at: WINDOW.startAt, end_at: WINDOW.endAt };

  for (const plate of [null, "わ1"]) {
    await t.test(`twenty failing new blocks, plate ${plate}`, () =>
      withShop(async (db) => {
        const shop = await busyShop(db, WINDOW_ROW);
        const sheet = Array.from({ length: 25 }, () => aBlock(shop.modelId, { ...WINDOW, plate }));

        const result = await assertWithinBudget(db, sheet);

        assert.equal(result.statuses.filter(({ level }) => level === "error").length, 20);
      }),
    );

    await t.test(`twenty failing edits, plate ${plate}`, () =>
      withShop(async (db) => {
        const shop = await busyShop(db, WINDOW_ROW);
        const rows = dailyRows(shop.modelId, 25, wall("07-01 09:00"), { plate });
        await storeSheet(db, rows);

        const result = await assertWithinBudget(db, rows.map((row) => ({ ...row, ...WINDOW })));

        assert.equal(result.statuses.filter(({ level }) => level === "error").length, 20);
      }),
    );
  }

  await t.test("twenty failing rows that return from a cancel", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, PLATES);
      const rows = dailyRows(shop.modelId, 25, wall("07-01 09:00"));
      const anchor = aBlock(shop.modelId, { ...WINDOW });
      await storeSheet(db, [...rows, anchor]);
      await syncBlocks(db, [anchor], NOW, { maxChanges: 25 });
      await holdBikes(db, { start_at: wall("07-01 09:00"), end_at: wall("08-01 09:00") });

      const result = await assertWithinBudget(db, [...rows, anchor]);

      assert.equal(result.statuses.filter(({ level }) => level === "error").length, 20);
    }),
  );

  await t.test("ten failing edits and ten failing new blocks among more", () =>
    withShop(async (db) => {
      const shop = await busyShop(db, WINDOW_ROW);
      const rows = dailyRows(shop.modelId, 15, wall("07-01 09:00"));
      await storeSheet(db, rows);
      const edits = rows.map((row) => ({ ...row, ...WINDOW }));
      const creates = Array.from({ length: 15 }, () => aBlock(shop.modelId, { ...WINDOW }));

      const first = [...edits.slice(0, 10), ...creates.slice(0, 10)];
      await assertWithinBudget(db, [...first, ...edits.slice(10), ...creates.slice(10)]);
    }),
  );

  await t.test("twenty failing new blocks beside 120 unchanged rows", () =>
    withShop(async (db) => {
      const shop = await busyShop(db, WINDOW_ROW);
      const unchanged = dailyRows(shop.modelId, 120, Date.parse("2031-01-01T09:00:00+09:00"));
      await storeSheet(db, unchanged);
      const failing = Array.from({ length: 25 }, () => aBlock(shop.modelId, { ...WINDOW }));

      await assertWithinBudget(db, [...unchanged, ...failing]);
    }),
  );

  await t.test("twenty cancels", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, PLATES);
      const rows = dailyRows(shop.modelId, 25, wall("07-01 09:00"));
      await storeSheet(db, rows);

      const counted = probe(db);
      const result = await syncBlocks(counted.db, rows.slice(0, 1), NOW);

      assert.deepEqual(counts(result), [20, 4]);
      assert.ok(counted.statements() <= BUDGET, `${counted.statements()} statements`);
    }),
  );

  await t.test("twenty free new blocks", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, PLATES);

      await assertWithinBudget(db, dailyRows(shop.modelId, 25, wall("07-01 09:00")));
    }),
  );

  await t.test("twenty edits that go through", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, PLATES);
      const rows = dailyRows(shop.modelId, 25, wall("07-01 09:00"));
      await storeSheet(db, rows);

      await assertWithinBudget(db, rows.map((row) => ({ ...row, endAt: row.endAt + HOUR_MS })));
    }),
  );
});

test("the content hash sees every column and where text sits", async (t) => {
  /** Stores a row with `first`, syncs it again with `second`, and returns both forms. */
  async function hashesOf(
    db: D1Database,
    shop: Shop,
    first: Partial<ValidBlock>,
    second: Partial<ValidBlock>,
  ): Promise<[BookingRow, BookingRow, SyncResult]> {
    await db.prepare("DELETE FROM bookings").run();
    const row = aBlock(shop.modelId, first);
    const before = await storeSheet(db, [row]);
    const result = await syncBlocks(db, [{ ...row, ...second }], LATER);
    return [before, await mustFind(db, row.blockId), result];
  }

  await t.test("text moved between channel and reference is a change", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const [before, after] = await hashesOf(
        db,
        shop,
        { channel: "ab", reference: "c" },
        { channel: "a", reference: "bc" },
      );
      assertEdited(after, before, { external_channel: "a" }, LATER);
    }),
  );

  const DELIMITERS = ["", " ", "|", ",", ";", ":", "/", "-", "_", "\t", "\n", "\u0000", "\u001f", "\\", '"'];
  await t.test("no delimiter hides text moved between two columns", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      for (const mark of DELIMITERS) {
        const [before, after, result] = await hashesOf(
          db,
          shop,
          { reference: `a${mark}b`, note: "c" },
          { reference: "a", note: `b${mark}c` },
        );
        assert.deepEqual(counts(result), [1, 0], JSON.stringify(mark));
        assertEdited(after, before, {}, LATER);
      }
    }),
  );

  await t.test("every column of the row is in the hash", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const other = await seedShop(db, ["わ3"]);
      const COLUMNS: [string, Partial<ValidBlock>, Partial<ValidBlock>, Partial<BookingRow>][] = [
        ["reference", { reference: "KL-1" }, { reference: "KL-2" }, {}],
        ["note", { note: "one" }, { note: "two" }, {}],
        ["channel", { channel: "Klook" }, { channel: "Rakuten" }, { external_channel: "Rakuten" }],
        ["start", {}, { startAt: PICKUP + HOUR_MS }, { start_at: PICKUP + HOUR_MS }],
        ["end", {}, { endAt: CLOSE - HOUR_MS }, { end_at: CLOSE - HOUR_MS }],
        ["plate", { plate: "わ1" }, { plate: "わ2" }, { vehicle_plate: "わ2" }],
        ["model", {}, { modelId: other.modelId }, { model_id: other.modelId, vehicle_plate: "わ3" }],
      ];
      for (const [label, first, second, changes] of COLUMNS) {
        const [before, after, result] = await hashesOf(db, shop, first, second);
        assert.deepEqual(counts(result), [1, 0], label);
        assertEdited(after, before, changes, LATER);
      }
    }),
  );

  await t.test("a note edit moves nothing and needs no free bike", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1"]);
      const row = aBlock(shop.modelId);
      const before = await storeSheet(db, [row]);
      // An overlap the block predates, as a later change of the turnaround can leave behind.
      await seedBooking(db, { vehicle_plate: "わ1", start_at: row.startAt, end_at: row.endAt });

      const result = await syncBlocks(db, [{ ...row, note: "Moved to the morning ferry" }], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok");
      assert.deepEqual(counts(result), [1, 0]);
      assertEdited(await mustFind(db, row.blockId), before, {}, LATER);
    }),
  );

  await t.test("a note edit stays on its bike though another is less used", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, ["わ1", "わ2"]);
      const row = aBlock(shop.modelId);
      const before = await storeSheet(db, [row]);

      await syncBlocks(db, [{ ...row, note: "changed" }], LATER);

      assertEdited(await mustFind(db, row.blockId), before, {}, LATER);
    }),
  );
});

test("hostile text in a row stays data", () =>
  withShop(async (db) => {
    const shop = await seedShop(db, ["わ1"]);
    const hostile = aBlock(shop.modelId, {
      blockId: "x'); DROP TABLE bookings; --",
      channel: "' OR '1'='1",
      reference: "%_\\",
      note: '"; DELETE FROM bookings; --',
    });
    const quiet = aBlock(shop.modelId, { startAt: wall("07-20 09:00"), endAt: wall("07-20 18:00") });

    const first = await syncBlocks(db, [hostile, quiet], NOW);

    assert.equal(statusOf(first, hostile.blockId).level, "ok");
    assertStoredAs(await mustFind(db, hostile.blockId), hostile, "わ1", NOW);

    const rerun = await syncBlocks(db, [hostile, quiet], LATER);
    assert.deepEqual(counts(rerun), [0, 0]);

    const removed = await syncBlocks(db, [quiet], LATER);
    assert.deepEqual(counts(removed), [1, 0]);
    assert.equal((await mustFind(db, hostile.blockId)).status, "CANCELLED");
    assert.equal((await mustFind(db, quiet.blockId)).status, "CONFIRMED");
  }));

// --- Staff overrides and bikes that leave service (task #111) -------------------------------------------------------
// A staff override (task #22's applyOverrides, run here for real) moves a block's booking without touching its row on
// the Blocks tab. These cases compare the columns staff and guests see, through `placement`, rather than every column:
// where a sync keeps what it last read of a row is not theirs to pin.

const OVERRIDE_AT = NOW + 10 * MINUTE_MS;
const TURNAROUND_MS = 60 * MINUTE_MS;

/** Where and when a block holds a bike, whether it holds, and the channel the sheet gave it. */
function placement(row: BookingRow): Partial<BookingRow> {
  const { status, model_id, vehicle_plate, start_at, end_at, external_ref, external_channel } = row;
  const { cancelled_at, cancel_reason, updated_at } = row;
  return { status, model_id, vehicle_plate, start_at, end_at, external_ref, external_channel, cancelled_at, cancel_reason, updated_at };
}

/** Moves the booking to `plate` through the Bookings tab's override cell, as task #22 does, and returns its row. */
async function overrideTo(db: D1Database, bookingId: string, plate: string, at: number): Promise<BookingRow> {
  const { results } = await applyOverrides(db, [{ row: 2, bookingId, overridePlate: plate }], at);
  assert.deepEqual(
    results.map(({ level, plate: moved }) => ({ level, moved })),
    [{ level: "ok", moved: plate }],
    JSON.stringify(results),
  );
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(bookingId).first<BookingRow>();
  assert.ok(row, `booking ${bookingId} is gone`);
  assert.equal(row.vehicle_plate, plate);
  return row;
}

/** A rerun of `sheet` changes nothing, so the sync took the last edit in. */
async function assertSettled(db: D1Database, sheet: ValidBlock[], at: number): Promise<void> {
  const before = await allBookings(db);
  const rerun = await syncBlocks(db, sheet, at);
  assert.deepEqual(counts(rerun), [0, 0], JSON.stringify(rerun.statuses));
  assert.deepEqual(await allBookings(db), before);
}

// わ5 is the least used, so a block that falls back to any free bike lands there. わ4 is in maintenance, which a row may
// still name.
const OVERRIDE_BIKES: Bike[] = [
  { plate: "わ1", base: 5 },
  { plate: "わ2", base: 6 },
  { plate: "わ3", base: 4 },
  { plate: "わ4", base: 7, status: "maintenance" },
  { plate: "わ5", base: 0 },
];

/** A block stored from `partial` among OVERRIDE_BIKES, then moved to `to` by a staff override at OVERRIDE_AT. */
async function overriddenBlock(db: D1Database, partial: Partial<ValidBlock>, to: string) {
  const shop = await seedShop(db, OVERRIDE_BIKES);
  // A free bike of another model, which no block of this model may take.
  await seedShop(db, ["わ9"]);
  const row = aBlock(shop.modelId, partial);
  const stored = await storeSheet(db, [row]);
  const moved = await overrideTo(db, stored.id, to, OVERRIDE_AT);
  return { shop, row, stored, moved };
}

test("an override survives an edit to a block's note", async (t) => {
  const TEXT_EDITS: [label: string, change: Partial<ValidBlock>][] = [
    ["the note", { note: "Guest asked for two helmets" }],
    ["the reference", { reference: "KL-20300610-77" }],
    ["the channel", { channel: "Rakuten Travel" }],
    ["note, reference and channel at once", { note: "Ferry delayed", reference: "RK-5", channel: "Jalan" }],
  ];
  const OVERRIDES: [named: string, to: string][] = [
    ["わ1", "わ2"],
    ["わ3", "わ1"],
    ["わ4", "わ2"],
  ];

  for (const [label, change] of TEXT_EDITS) {
    for (const [named, to] of OVERRIDES) {
      await t.test(`${label}, on a row naming ${named} that staff moved to ${to}`, () =>
        withShop(async (db) => {
          const { row, moved } = await overriddenBlock(db, { plate: named }, to);
          const edited = { ...row, ...change };

          const result = await syncBlocks(db, [edited], LATER);

          assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
          assert.deepEqual(counts(result), [1, 0]);
          const kept = { ...placement(moved), external_channel: edited.channel };
          assert.deepEqual(placement(await mustFind(db, row.blockId)), { ...kept, updated_at: LATER });
          await assertSettled(db, [edited], LATER + HOUR_MS);

          // The next edit finds it on the same bike.
          const again = { ...edited, note: `${edited.note} again` };
          const second = await syncBlocks(db, [again], LATER + 2 * HOUR_MS);
          assert.equal(statusOf(second, row.blockId).level, "ok", statusOf(second, row.blockId).message);
          assert.deepEqual(placement(await mustFind(db, row.blockId)), { ...kept, updated_at: LATER + 2 * HOUR_MS });
        }),
      );
    }
  }

  await t.test("after the plate column had moved it", () =>
    withShop(async (db) => {
      const shop = await seedShop(db, OVERRIDE_BIKES);
      const row = aBlock(shop.modelId, { plate: "わ1" });
      const stored = await storeSheet(db, [row]);
      const replated = { ...row, plate: "わ3" };
      assert.equal(statusOf(await syncBlocks(db, [replated], NOW + MINUTE_MS), row.blockId).level, "ok");
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ3");
      const moved = await overrideTo(db, stored.id, "わ2", OVERRIDE_AT);
      const edited = { ...replated, note: "Pick-up at the port" };

      const result = await syncBlocks(db, [edited], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
      assert.deepEqual(placement(await mustFind(db, row.blockId)), { ...placement(moved), updated_at: LATER });
    }),
  );

  await t.test("after a second override", () =>
    withShop(async (db) => {
      const { row, stored } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
      await syncBlocks(db, [{ ...row, note: "first" }], LATER);
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ2");
      const moved = await overrideTo(db, stored.id, "わ3", LATER + 10 * MINUTE_MS);

      const result = await syncBlocks(db, [{ ...row, note: "second" }], LATER + HOUR_MS);

      assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
      assert.deepEqual(placement(await mustFind(db, row.blockId)), { ...placement(moved), updated_at: LATER + HOUR_MS });
    }),
  );

  await t.test("while a rental has taken the bike the row names", () =>
    withShop(async (db) => {
      const { row, moved } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
      const rental = await seedBooking(db, {
        vehicle_plate: "わ1",
        ref: "WEB-AAAA",
        start_at: row.startAt,
        end_at: row.endAt,
      });

      const result = await syncBlocks(db, [{ ...row, note: "Guest calls on arrival" }], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
      assert.deepEqual(placement(await mustFind(db, row.blockId)), { ...placement(moved), updated_at: LATER });
      const after = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(rental.id).first<BookingRow>();
      assert.deepEqual(after, rental);
      assertNoOverlaps(await allBookings(db), LATER, TURNAROUND_MS, "note edit");
    }),
  );

  await t.test("on a row with a blank plate", () =>
    withShop(async (db) => {
      const { row, stored, moved } = await overriddenBlock(db, { plate: null }, "わ2");
      assert.equal(stored.vehicle_plate, "わ5");

      const result = await syncBlocks(db, [{ ...row, note: "Blank plate, new note" }], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
      assert.deepEqual(placement(await mustFind(db, row.blockId)), { ...placement(moved), updated_at: LATER });
    }),
  );
});

test("a changed plate still moves an overridden block", async (t) => {
  // Every row names わ1, and staff move it to わ2 before the edit.
  const MOVES: [label: string, change: Partial<ValidBlock>, plate: string][] = [
    ["to a free bike", { plate: "わ3" }, "わ3"],
    ["to a bike in maintenance, which a row may name", { plate: "わ4" }, "わ4"],
    ["to a free bike with a new note in the same edit", { plate: "わ3", note: "Moved by the office" }, "わ3"],
  ];
  for (const [label, change, plate] of MOVES) {
    await t.test(label, () =>
      withShop(async (db) => {
        const { row, moved } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
        const edited = { ...row, ...change };

        const result = await syncBlocks(db, [edited], LATER);

        assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
        assert.deepEqual(counts(result), [1, 0]);
        const expected = { ...placement(moved), vehicle_plate: plate };
        assert.deepEqual(placement(await mustFind(db, row.blockId)), { ...expected, updated_at: LATER });
        await assertSettled(db, [edited], LATER + HOUR_MS);

        // A note edit after it leaves the block where the plate column put it.
        await syncBlocks(db, [{ ...edited, note: "Later note" }], LATER + 2 * HOUR_MS);
        assert.deepEqual(placement(await mustFind(db, row.blockId)), { ...expected, updated_at: LATER + 2 * HOUR_MS });
      }),
    );
  }

  await t.test("to a free bike after a note edit kept the override", () =>
    withShop(async (db) => {
      const { row, moved } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
      const noted = { ...row, note: "Kept on the override" };
      await syncBlocks(db, [noted], LATER);
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ2");

      const result = await syncBlocks(db, [{ ...noted, plate: "わ3" }], LATER + HOUR_MS);

      assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
      assert.deepEqual(placement(await mustFind(db, row.blockId)), {
        ...placement(moved),
        vehicle_plate: "わ3",
        updated_at: LATER + HOUR_MS,
      });
    }),
  );

  await t.test("back to the bike the row first named", () =>
    withShop(async (db) => {
      const { row } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
      await syncBlocks(db, [{ ...row, plate: "わ3" }], LATER);
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ3");

      const result = await syncBlocks(db, [row], LATER + HOUR_MS);

      assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ1");
    }),
  );

  await t.test("not to a busy bike, and not to any other", () =>
    withShop(async (db) => {
      const { row } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
      await seedBooking(db, { vehicle_plate: "わ3", ref: "WEB-CCCC", start_at: row.startAt, end_at: row.endAt });

      await assertRejected(db, [{ ...row, plate: "わ3" }], row.blockId, [["WEB-CCCC", "わ3"]], LATER);

      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ2");
    }),
  );

  await t.test("not when a hold takes the new plate just before the write", () =>
    withShop(async (db) => {
      const { shop, row } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
      const before = await mustFind(db, row.blockId);
      // わ5 is the least used of the free bikes, so that is where the hold lands.
      const race = raceBeforeWrite(db, () => createHold(db, holdFor(shop), LATER));

      const result = await syncBlocks(race.db, [{ ...row, plate: "わ5" }], LATER);

      assert.equal(race.raced(), true);
      const hold = (await allBookings(db)).find(({ status }) => status === "ON_HOLD");
      assert.equal(hold?.vehicle_plate, "わ5");
      assert.equal(statusOf(result, row.blockId).level, "error");
      assert.deepEqual(await mustFind(db, row.blockId), before);
      assertNoOverlaps(await allBookings(db), LATER, TURNAROUND_MS, "plate column after an override");
    }),
  );
});

test("new times still move an overridden block", async (t) => {
  // The row names わ1 and staff moved it to わ2. A time edit may take either of those two bikes, but no other.
  const SPAN = { startAt: wall("06-20 10:00"), endAt: wall("06-20 16:00") };
  const ITS_BIKES = ["わ1", "わ2"];

  for (const noteFirst of [false, true]) {
    await t.test(`to free times${noteFirst ? ", after a note edit kept the override" : ""}`, () =>
      withShop(async (db) => {
        const { row } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
        let sheet = row;
        if (noteFirst) {
          sheet = { ...row, note: "Before the new times" };
          await syncBlocks(db, [sheet], NOW + 30 * MINUTE_MS);
          assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ2");
        }
        const edited = { ...sheet, ...SPAN };

        const result = await syncBlocks(db, [edited], LATER);

        assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
        const after = await mustFind(db, row.blockId);
        assert.deepEqual(
          [after.status, after.start_at, after.end_at, after.updated_at],
          ["CONFIRMED", SPAN.startAt, SPAN.endAt, LATER],
        );
        assert.ok(ITS_BIKES.includes(after.vehicle_plate), after.vehicle_plate);
        await assertSettled(db, [edited], LATER + HOUR_MS);
      }),
    );
  }

  await t.test("not to times both of its bikes are taken, and not to any other bike", () =>
    withShop(async (db) => {
      const { row } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
      const span = { start_at: wall("06-20 09:00"), end_at: wall("06-20 18:00") };
      await seedBooking(db, { vehicle_plate: "わ1", ref: "WEB-AAAA", ...span });
      await seedBooking(db, { vehicle_plate: "わ2", ref: "WEB-BBBB", ...span });
      const blockers: Blocker[] = [
        ["WEB-AAAA", "わ1"],
        ["WEB-BBBB", "わ2"],
      ];

      await assertRejected(db, [{ ...row, ...SPAN }], row.blockId, blockers, LATER);
    }),
  );

  for (const busy of ITS_BIKES) {
    await t.test(`never onto ${busy} when a rental has it at the new times`, () =>
      withShop(async (db) => {
        const { row } = await overriddenBlock(db, { plate: "わ1" }, "わ2");
        await seedBooking(db, {
          vehicle_plate: busy,
          ref: "WEB-DDDD",
          start_at: wall("06-20 09:00"),
          end_at: wall("06-20 18:00"),
        });
        const before = await allBookings(db);

        const result = await syncBlocks(db, [{ ...row, ...SPAN }], LATER);

        const { level, message } = statusOf(result, row.blockId);
        const after = await mustFind(db, row.blockId);
        if (level === "ok") {
          assert.deepEqual([after.start_at, after.end_at], [SPAN.startAt, SPAN.endAt]);
          assert.ok(ITS_BIKES.includes(after.vehicle_plate) && after.vehicle_plate !== busy, after.vehicle_plate);
        } else {
          assertNamesConflict({ blockId: row.blockId, level, message }, [["WEB-DDDD", busy]]);
          assert.deepEqual(await allBookings(db), before);
        }
        assertNoOverlaps(await allBookings(db), LATER, TURNAROUND_MS, `${busy} taken`);
      }),
    );
  }
});

/**
 * A blank-plate block stored on わ1, then the only bike of its model, beside a row of another model that keeps the tab
 * from reading as emptied. With `cancelled`, the block's row is then deleted from the tab. Then `others` join the model
 * and わ1 goes to `status`. `before` is the block's row as it then stands.
 */
async function blockOnLeavingBike(
  db: D1Database,
  status: string,
  others: Bike[],
  opts: { plate?: string | null; base?: number; cancelled?: boolean } = {},
) {
  const shop = await seedShop(db, [{ plate: "わ1", base: opts.base ?? 0 }]);
  const other = await seedShop(db, ["わ9"]);
  const row = aBlock(shop.modelId, { plate: opts.plate ?? null });
  const anchor = aBlock(other.modelId, { startAt: wall("07-20 09:00"), endAt: wall("07-20 18:00") });
  await storeSheet(db, [row, anchor]);
  if (opts.cancelled) {
    await syncBlocks(db, [anchor], NOW);
    assert.equal((await mustFind(db, row.blockId)).status, "CANCELLED");
  }
  for (const { plate, base = 0, status: bikeStatus = "active" } of others) {
    await seedVehicle(db, { plate, model_id: shop.modelId, base_usage_days: base, odometer_km: null, status: bikeStatus });
  }
  await db.prepare("UPDATE vehicles SET status = ?1 WHERE plate = 'わ1'").bind(status).run();
  return { shop, row, anchor, before: await mustFind(db, row.blockId) };
}

test("a blank-plate block leaves a bike in maintenance", async (t) => {
  const NEW_SPAN = { startAt: wall("06-20 10:00"), endAt: wall("06-20 16:00") };

  for (const status of ["maintenance", "retired"]) {
    // わ4 is out of service too and the least used of all, so only an active bike may take the block.
    const MOVES: [label: string, change: Partial<ValidBlock>, others: Bike[], plate: string][] = [
      [
        "a later end over its own times",
        { endAt: wall("06-11 12:00") },
        [{ plate: "わ2", base: 7 }, { plate: "わ3", base: 2 }, { plate: "わ4", status }],
        "わ3",
      ],
      [
        "new times on another day",
        NEW_SPAN,
        [{ plate: "わ2", base: 1 }, { plate: "わ3", base: 6 }, { plate: "わ4", status }],
        "わ2",
      ],
    ];
    for (const [label, change, others, plate] of MOVES) {
      await t.test(`${status}: ${label} moves it to the least-used active bike`, () =>
        withShop(async (db) => {
          const { row, anchor, before } = await blockOnLeavingBike(db, status, others);
          const edited = { ...row, ...change };

          const result = await syncBlocks(db, [edited, anchor], LATER);

          assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
          assert.deepEqual(counts(result), [1, 0]);
          assert.deepEqual(placement(await mustFind(db, row.blockId)), {
            ...placement(before),
            vehicle_plate: plate,
            start_at: edited.startAt,
            end_at: edited.endAt,
            updated_at: LATER,
          });
          await assertSettled(db, [edited, anchor], LATER + HOUR_MS);
        }),
      );
    }

    await t.test(`${status}: a row back from a cancel returns on the least-used active bike`, () =>
      withShop(async (db) => {
        const others = [{ plate: "わ2", base: 8 }, { plate: "わ3", base: 3 }, { plate: "わ4", status }];
        const { row, anchor, before } = await blockOnLeavingBike(db, status, others, { cancelled: true });

        const result = await syncBlocks(db, [row, anchor], LATER);

        assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
        assert.deepEqual(placement(await mustFind(db, row.blockId)), {
          ...placement(before),
          status: "CONFIRMED",
          vehicle_plate: "わ3",
          cancelled_at: null,
          cancel_reason: null,
          updated_at: LATER,
        });
      }),
    );

    await t.test(`${status}: with every active bike taken it stays, reports an error, and moves once one is free`, () =>
      withShop(async (db) => {
        const others = [{ plate: "わ2" }, { plate: "わ4", status }];
        const { row, anchor, before } = await blockOnLeavingBike(db, status, others);
        await seedBooking(db, {
          vehicle_plate: "わ2",
          ref: "WEB-BBBB",
          start_at: wall("06-20 09:00"),
          end_at: wall("06-20 18:00"),
        });
        const edited = { ...row, ...NEW_SPAN };

        await assertRejected(db, [edited, anchor], row.blockId, [["WEB-BBBB", "わ2"]], LATER);

        await db.prepare("UPDATE bookings SET status = 'CANCELLED' WHERE ref = 'WEB-BBBB'").run();
        const freed = await syncBlocks(db, [edited, anchor], LATER + HOUR_MS);
        assert.equal(statusOf(freed, row.blockId).level, "ok", statusOf(freed, row.blockId).message);
        assert.deepEqual(placement(await mustFind(db, row.blockId)), {
          ...placement(before),
          vehicle_plate: "わ2",
          start_at: NEW_SPAN.startAt,
          end_at: NEW_SPAN.endAt,
          updated_at: LATER + HOUR_MS,
        });
      }),
    );

    await t.test(`${status}: with no active bike of its model it stays and reports an error`, () =>
      withShop(async (db) => {
        const { row, anchor } = await blockOnLeavingBike(db, status, [{ plate: "わ4", status }]);
        const edited = { ...row, ...NEW_SPAN };
        const before = await allBookings(db);

        for (const at of [LATER, LATER + HOUR_MS]) {
          const result = await syncBlocks(db, [edited, anchor], at);

          const { level, message } = statusOf(result, row.blockId);
          assert.equal(level, "error", message);
          assert.ok(message.length > 0);
          assert.deepEqual(await allBookings(db), before);
        }
      }),
    );

    await t.test(`${status}: a returning row with every active bike taken stays cancelled and reports an error`, () =>
      withShop(async (db) => {
        const { row, anchor } = await blockOnLeavingBike(db, status, [{ plate: "わ2" }], { cancelled: true });
        await seedBooking(db, { vehicle_plate: "わ2", ref: "WEB-BBBB", start_at: row.startAt, end_at: row.endAt });

        await assertRejected(db, [row, anchor], row.blockId, [["WEB-BBBB", "わ2"]], LATER);

        assert.equal((await mustFind(db, row.blockId)).status, "CANCELLED");
      }),
    );
  }

  await t.test("a hold that takes the least-used bike just before the write is never overlapped", () =>
    withShop(async (db) => {
      const others = [{ plate: "わ2", base: 7 }, { plate: "わ3", base: 2 }];
      const { shop, row, anchor } = await blockOnLeavingBike(db, "maintenance", others);
      const race = raceBeforeWrite(db, () => createHold(db, holdFor(shop, wall("06-20 09:00")), LATER));

      const result = await syncBlocks(race.db, [{ ...row, ...NEW_SPAN }, anchor], LATER);

      assert.equal(race.raced(), true);
      const hold = (await allBookings(db)).find(({ status }) => status === "ON_HOLD");
      assert.equal(hold?.vehicle_plate, "わ3");
      assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ2");
      assertNoOverlaps(await allBookings(db), LATER, TURNAROUND_MS, "off a bike in maintenance, raced");
    }),
  );

  await t.test("a bike still active keeps its block, though another is less used", () =>
    withShop(async (db) => {
      const { row, anchor } = await blockOnLeavingBike(db, "active", [{ plate: "わ3", base: 0 }], { base: 9 });
      const edited = { ...row, endAt: wall("06-11 12:00") };

      const result = await syncBlocks(db, [edited, anchor], LATER);

      assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
      assert.equal((await mustFind(db, row.blockId)).vehicle_plate, "わ1");
    }),
  );

  for (const cancelled of [false, true]) {
    await t.test(`a row naming a plate in maintenance keeps it${cancelled ? " when it returns" : ""}`, () =>
      withShop(async (db) => {
        const others = [{ plate: "わ3", base: 0 }];
        const { row, anchor } = await blockOnLeavingBike(db, "maintenance", others, { plate: "わ1", cancelled });
        const edited = cancelled ? row : { ...row, endAt: wall("06-11 12:00") };

        const result = await syncBlocks(db, [edited, anchor], LATER);

        assert.equal(statusOf(result, row.blockId).level, "ok", statusOf(result, row.blockId).message);
        const after = await mustFind(db, row.blockId);
        assert.deepEqual([after.status, after.vehicle_plate, after.end_at], ["CONFIRMED", "わ1", edited.endAt]);
      }),
    );
  }
});
