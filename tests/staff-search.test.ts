// findBookingsForStaff over the in-memory D1: the bookings the sheet's Dashboard lets staff act on, found by ref, guest
// name or JST pickup date. Expected lists are written out from the seeded rows (refs, names, JST wall clocks parsed with
// an explicit +09:00 offset), never from the code under test. `now` is in 2030, so code that reads the real clock instead
// of its `now` lists bookings that have ended.
//
// The schema allows only the sources 'web' and 'block' today, so the `staff` source of the epic's task 9 cannot be seeded
// here; the tests pin "every source but block" through 'web' bookings.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { LOCALES } from "../src/lib/locale.ts";
import { createTestDb, type TestDb } from "./helpers/d1.ts";
import { seedBooking, seedModel, seedPackage, seedVehicle, type BookingRow } from "./helpers/seed.ts";

type StaffBookingSummary = {
  id: string;
  ref: string;
  status: string;
  source: string;
  modelId: string;
  modelNameJa: string;
  packageId: string | null;
  packageNameJa: string | null;
  plate: string;
  startAt: number;
  endAt: number;
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  priceJpy: number | null;
  depositJpy: number | null;
  paidJpy: number;
};
type Query = { text?: string; date?: string };
type Shop = { modelId: string; packageId: string; plate: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The instant of a JST wall clock written `YYYY-MM-DD HH:mm`. */
function jst(text: string): number {
  const ms = Date.parse(`${text.replace(" ", "T")}:00+09:00`);
  if (Number.isNaN(ms)) throw new Error(`not a JST wall clock: ${text}`);
  return ms;
}

const NOW = jst("2030-06-01 12:00");

/**
 * Loaded here, so each test seeds its fixtures and fails on its own while the module is missing. The ts-ignore covers
 * that missing module for lint and nothing else.
 */
async function find(db: D1Database, query: Query, now = NOW): Promise<StaffBookingSummary[]> {
  // @ts-ignore
  const { findBookingsForStaff } = await import("../src/lib/booking/staff-search.ts");
  return findBookingsForStaff(db, query, now);
}

let testDb: TestDb;

// One database for the file, emptied for each test.
before(async () => {
  testDb = await createTestDb();
});

after(() => testDb.dispose());

const CLEAR_SQL = ["bookings", "vehicles", "prices", "packages", "models", "rate_classes"].map(
  (table) => `DELETE FROM ${table}`,
);

async function withDb(run: (db: D1Database) => Promise<void>): Promise<void> {
  const { db } = testDb;
  await db.batch(CLEAR_SQL.map((sql) => db.prepare(sql)));
  await run(db);
}

/** A texts column whose Japanese name differs from every other locale's, so reading the wrong locale shows. */
function texts(nameJa: string, nameElsewhere: string): string {
  return JSON.stringify(
    Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        {
          name: locale === "ja" ? nameJa : `${nameElsewhere} (${locale})`,
          summary: "s",
          description: "d",
        },
      ]),
    ),
  );
}

async function seedShop(db: D1Database, nameJa = "トリシティ125", plate = "沖縄 わ 12-34"): Promise<Shop> {
  const model = await seedModel(db, { texts: texts(nameJa, "Tricity 125") });
  const pkg = await seedPackage(db, {
    days: 1,
    texts: texts("1日パック", "One day"),
  });
  await seedVehicle(db, { plate, model_id: model.id });
  return { modelId: model.id, packageId: pkg.id, plate };
}

/** A CONFIRMED web booking of the shop's bike, eight hours long unless `end_at` is named. */
function book(db: D1Database, shop: Shop, partial: Partial<BookingRow>): Promise<BookingRow> {
  return seedBooking(db, {
    model_id: shop.modelId,
    vehicle_plate: shop.plate,
    package_id: shop.packageId,
    ...partial,
  });
}

function guest(family: string | null, given: string | null): Partial<BookingRow> {
  return { guest_family_name: family, guest_given_name: given };
}

/** The refs of `rows`, earliest pickup first: the order every answer must have. */
function inPickupOrder(rows: BookingRow[]): string[] {
  return [...rows].sort((a, b) => a.start_at - b.start_at).map(({ ref }) => ref);
}

async function assertFinds(db: D1Database, query: Query, expected: BookingRow[], now = NOW): Promise<void> {
  const found = await find(db, query, now);
  assert.deepEqual(
    found.map(({ ref }) => ref),
    inPickupOrder(expected),
    `${JSON.stringify(query)} found ${JSON.stringify(found.map(({ ref, guestName }) => [ref, guestName]))}`,
  );
}

test("a ref finds its booking whatever the case", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db);
    const otherShop = await seedShop(db, "PCX125", "沖縄 わ 56-78");
    const target = await book(db, shop, {
      ref: "7K2MQ9XA",
      ...guest("Yamada", "Hanako"),
      guest_email: "hanako@example.com",
      guest_phone: "+81-90-1234-5678",
      price_jpy: 15400,
      deposit_jpy: 6000,
      paid_jpy: 4500,
      start_at: jst("2030-07-15 10:30"),
      end_at: jst("2030-07-16 10:30"),
    });
    const neighbour = await book(db, shop, {
      ref: "7K2MQ9XB",
      ...guest("Tanaka", "Jiro"),
      start_at: jst("2030-07-16 09:00"),
    });
    const other = await book(db, otherShop, {
      ref: "QW3RT8ZP",
      ...guest("Higa", "Kenta"),
      package_id: null,
      start_at: jst("2030-07-17 09:00"),
    });

    const FINDS: [string, BookingRow[]][] = [
      ["7K2MQ9XA", [target]],
      ["7k2mq9xa", [target]],
      ["7k2MQ9xA", [target]],
      ["  7k2mq9xa\t", [target]],
      // Full-width letters and digits, which NFKC makes ASCII.
      ["７Ｋ２ＭＱ９ＸＡ", [target]],
      ["7k2mq9xb", [neighbour]],
      ["qw3rt8zp", [other]],
      // A ref matches only whole.
      ["7K2MQ9X", []],
      ["K2MQ9XA", []],
      ["7K2MQ9XA7", []],
      ["NOSUCHRF", []],
    ];
    for (const [text, expected] of FINDS) await assertFinds(db, { text }, expected);

    // Every field of the summary, the names from the Japanese texts.
    const [found] = await find(db, { text: "7k2mq9xa" });
    assert.ok(found, "the ref found nothing");
    const { guestName, ...rest } = found;
    assert.deepEqual(rest, {
      id: target.id,
      ref: "7K2MQ9XA",
      status: "CONFIRMED",
      source: "web",
      modelId: shop.modelId,
      modelNameJa: "トリシティ125",
      packageId: shop.packageId,
      packageNameJa: "1日パック",
      plate: "沖縄 わ 12-34",
      startAt: jst("2030-07-15 10:30"),
      endAt: jst("2030-07-16 10:30"),
      guestEmail: "hanako@example.com",
      guestPhone: "+81-90-1234-5678",
      priceJpy: 15400,
      depositJpy: 6000,
      paidJpy: 4500,
    });
    assert.match(guestName, /Yamada/);
    assert.match(guestName, /Hanako/);

    // Each booking carries its own model and plate; a booking with no package says so.
    const [elsewhere] = await find(db, { text: "QW3RT8ZP" });
    assert.ok(elsewhere, "the second ref found nothing");
    assert.equal(elsewhere.modelId, otherShop.modelId);
    assert.equal(elsewhere.modelNameJa, "PCX125");
    assert.equal(elsewhere.plate, "沖縄 わ 56-78");
    assert.equal(elsewhere.packageId, null);
    assert.match(elsewhere.guestName, /Higa/);
    assert.match(elsewhere.guestName, /Kenta/);
  });
});

test("part of a guest name finds the booking in either name order", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db);
    const at = (hour: number) => jst(`2030-07-15 ${String(hour).padStart(2, "0")}:00`);
    const yamadaHanako = await book(db, shop, {
      ...guest("Yamada", "Hanako"),
      start_at: at(9),
    });
    const yamadaTaro = await book(db, shop, {
      ...guest("Yamada", "Taro"),
      start_at: at(10),
    });
    const tanakaHanako = await book(db, shop, {
      ...guest("Tanaka", "Hanako"),
      start_at: at(11),
    });
    // No given name, and "hanako" in the email, which is not searched.
    const suzuki = await book(db, shop, {
      ...guest("Suzuki", null),
      guest_email: "hanako.fan@example.com",
      start_at: at(12),
    });
    const kanji = await book(db, shop, {
      ...guest("山田", "花子"),
      start_at: at(13),
    });
    // "taro" is in this ref, which matches only whole.
    const kana = await book(db, shop, {
      ...guest("サトウ", "ケン"),
      ref: "TAROYAMA",
      start_at: at(14),
    });

    const FINDS: [string, BookingRow[]][] = [
      ["yamada", [yamadaHanako, yamadaTaro]],
      ["YAMADA", [yamadaHanako, yamadaTaro]],
      ["ＹＡＭＡＤＡ", [yamadaHanako, yamadaTaro]],
      ["hanako", [yamadaHanako, tanakaHanako]],
      ["Taro", [yamadaTaro]],
      ["  taro  ", [yamadaTaro]],
      ["Yamada Hanako", [yamadaHanako]],
      ["Hanako Yamada", [yamadaHanako]],
      ["hanako yamada", [yamadaHanako]],
      ["Tanaka Hanako", [tanakaHanako]],
      ["Hanako Tanaka", [tanakaHanako]],
      // Spanning the space, in family-given order and in given-family order.
      ["ada Han", [yamadaHanako]],
      ["ako Yam", [yamadaHanako]],
      ["o Y", [yamadaHanako, yamadaTaro]],
      ["Taro Tanaka", []],
      ["Yamada Hanako Tanaka", []],
      ["suzuki", [suzuki]],
      ["uzu", [suzuki]],
      ["山田", [kanji]],
      ["花子", [kanji]],
      ["山田 花子", [kanji]],
      ["花子 山田", [kanji]],
      // An ideographic space, which NFKC makes a plain one.
      ["山田　花子", [kanji]],
      // Half-width katakana, which NFKC makes full-width.
      ["ｻﾄｳ", [kana]],
      ["ｹﾝ ｻﾄｳ", [kana]],
      ["example", []],
    ];
    for (const [text, expected] of FINDS) await assertFinds(db, { text }, expected);
  });
});

test("a date finds the bookings picked up that JST day", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db);
    const at = (wall: string, partial: Partial<BookingRow> = {}) => book(db, shop, { start_at: jst(wall), ...partial });
    // 2030-07-14 15:00 UTC.
    const midnight = await at("2030-07-15 00:00");
    const morning = await at("2030-07-15 09:00");
    // 2030-07-15 14:30 UTC.
    const late = await at("2030-07-15 23:30");
    const lastMinute = await at("2030-07-15 23:59");
    const nextMidnight = await at("2030-07-16 00:00");
    // 2030-07-15 23:00 UTC: the 15th by UTC, the 16th in Okinawa.
    const nextMorning = await at("2030-07-16 08:00");
    const previousLate = await at("2030-07-14 23:30");
    // Picked up the day before and still out on the 15th.
    const twoDays = await at("2030-07-14 09:00", {
      end_at: jst("2030-07-16 09:00"),
    });

    const FINDS: [string, BookingRow[]][] = [
      ["2030-07-15", [midnight, morning, late, lastMinute]],
      ["2030-07-16", [nextMidnight, nextMorning]],
      ["2030-07-14", [twoDays, previousLate]],
      ["2030-07-13", []],
      ["2031-07-15", []],
      ["2030-08-15", []],
    ];
    for (const [date, expected] of FINDS) await assertFinds(db, { date }, expected);
  });
});

test("text and date together must both match", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db);
    const a = await book(db, shop, {
      ref: "AAAA1111",
      ...guest("Yamada", "Hanako"),
      start_at: jst("2030-07-15 10:00"),
    });
    const b = await book(db, shop, {
      ...guest("Yamada", "Hanako"),
      start_at: jst("2030-07-16 10:00"),
    });
    const c = await book(db, shop, {
      ...guest("Tanaka", "Hanako"),
      start_at: jst("2030-07-15 11:00"),
    });
    const d = await book(db, shop, {
      ...guest("Higa", "Kenta"),
      start_at: jst("2030-07-15 12:00"),
    });

    const FINDS: [Query, BookingRow[]][] = [
      [{ text: "hanako", date: "2030-07-15" }, [a, c]],
      [{ text: "Hanako Yamada", date: "2030-07-16" }, [b]],
      [{ text: "yamada", date: "2030-07-15" }, [a]],
      [{ text: "aaaa1111", date: "2030-07-15" }, [a]],
      [{ text: "aaaa1111", date: "2030-07-16" }, []],
      [{ text: "kenta", date: "2030-07-16" }, []],
      [{ text: "suzuki", date: "2030-07-15" }, []],
      [{ text: "hanako" }, [a, b, c]],
      [{ date: "2030-07-15" }, [a, c, d]],
      [{}, [a, b, c, d]],
    ];
    for (const [query, expected] of FINDS) await assertFinds(db, query, expected);
  });
});

test("blocks, holds, cancelled and ended bookings are not listed", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db);
    const kenta = guest("Higa", "Kenta");
    const on15 = (hour: number) => jst(`2030-07-15 ${String(hour).padStart(2, "0")}:00`);

    // NOW is 2030-06-01 12:00 JST.
    const future = await book(db, shop, { ...kenta, start_at: on15(9) });
    const underway = await book(db, shop, {
      ...kenta,
      start_at: NOW - 2 * HOUR_MS,
      end_at: NOW + 6 * HOUR_MS,
    });
    const endsJustAfter = await book(db, shop, {
      ...kenta,
      start_at: NOW - 8 * HOUR_MS,
      end_at: NOW + 1,
    });
    const visible = [future, underway, endsJustAfter];

    const hidden = [
      await book(db, shop, {
        ...kenta,
        start_at: NOW - 8 * HOUR_MS,
        end_at: NOW,
      }),
      await book(db, shop, {
        ...kenta,
        start_at: NOW - 9 * HOUR_MS,
        end_at: NOW - 1,
      }),
      await book(db, shop, {
        ...kenta,
        source: "block",
        package_id: null,
        external_ref: "BLK-1",
        start_at: on15(10),
      }),
      await book(db, shop, {
        ...kenta,
        status: "ON_HOLD",
        expires_at: NOW + 15 * MINUTE_MS,
        start_at: on15(11),
      }),
      await book(db, shop, {
        ...kenta,
        status: "PAYMENT_PENDING",
        expires_at: NOW + 15 * MINUTE_MS,
        start_at: on15(12),
      }),
      await book(db, shop, {
        ...kenta,
        status: "CANCELLED",
        cancelled_at: NOW - HOUR_MS,
        start_at: on15(13),
      }),
      await book(db, shop, { ...kenta, status: "EXPIRED", start_at: on15(14) }),
    ];

    const FINDS: [Query, BookingRow[]][] = [
      [{}, visible],
      [{ text: "kenta" }, visible],
      [{ text: "Higa Kenta" }, visible],
      [{ date: "2030-07-15" }, [future]],
      // Both underway bookings were picked up on the morning of NOW, as were the two that have ended.
      [{ date: "2030-06-01" }, [underway, endsJustAfter]],
      ...hidden.map((row): [Query, BookingRow[]] => [{ text: row.ref }, []]),
    ];
    for (const [query, expected] of FINDS) await assertFinds(db, query, expected);

    // Later the same day the underway booking has ended too.
    await assertFinds(db, {}, [future], NOW + 7 * HOUR_MS);
  });
});

test("percent and underscore match themselves", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db);
    const at = (hour: number) => jst(`2030-07-15 ${String(hour).padStart(2, "0")}:00`);
    const percent = await book(db, shop, {
      ...guest("Ka%to", "Test"),
      start_at: at(9),
    });
    const underscore = await book(db, shop, {
      ...guest("Ka_to", "Test"),
      start_at: at(10),
    });
    const backslash = await book(db, shop, {
      ...guest("Ka\\to", "Test"),
      start_at: at(11),
    });
    // Each of these would match a wildcard.
    await book(db, shop, { ...guest("Kaito", "Test"), start_at: at(12) });
    await book(db, shop, { ...guest("Kazuto", "Test"), start_at: at(13) });
    await book(db, shop, {
      ref: "7K2MQ9XA",
      ...guest("Higa", "Kenta"),
      start_at: at(14),
    });

    const FINDS: [string, BookingRow[]][] = [
      ["Ka%to", [percent]],
      ["ka%TO", [percent]],
      ["Ka_to", [underscore]],
      ["%", [percent]],
      ["_", [underscore]],
      ["%%", []],
      ["%a%", []],
      ["K_", []],
      ["Ka_to Test", [underscore]],
      // The escape character a LIKE might use matches itself too.
      ["a\\t", [backslash]],
      ["\\", [backslash]],
      // A ref matches only whole, wildcards or not.
      ["7k2mq9x_", []],
      ["7K2MQ9X%", []],
      ["%7K2MQ9XA", []],
    ];
    for (const [text, expected] of FINDS) await assertFinds(db, { text }, expected);
  });
});

test("at most 20 bookings come back, earliest pickup first", async () => {
  await withDb(async (db) => {
    const shop = await seedShop(db);
    const nakama = guest("Nakama", "Yui");
    // 25 bookings on 2030-07-01, half an hour apart from 09:00, seeded out of order with refs and created_at that run
    // against pickup order, so only start_at can order them.
    const SLOTS = [13, 2, 24, 7, 19, 0, 11, 22, 5, 16, 9, 1, 20, 14, 3, 23, 8, 17, 4, 12, 21, 6, 18, 10, 15];
    const onTheFirst: BookingRow[] = [];
    for (const [index, slot] of SLOTS.entries()) {
      onTheFirst.push(
        await book(db, shop, {
          ...nakama,
          ref: `R${String(99 - index).padStart(7, "0")}`,
          start_at: jst("2030-07-01 09:00") + slot * 30 * MINUTE_MS,
          created_at: NOW - index * MINUTE_MS,
          updated_at: NOW - index * MINUTE_MS,
        }),
      );
    }
    const dayBefore = [
      await book(db, shop, { ...nakama, start_at: jst("2030-06-30 15:00") }),
      await book(db, shop, { ...nakama, start_at: jst("2030-06-30 10:00") }),
    ];
    const underway = await book(db, shop, {
      ...nakama,
      start_at: NOW - HOUR_MS,
      end_at: NOW + HOUR_MS,
    });
    // Earlier than all of those, and never listed.
    await book(db, shop, {
      ...nakama,
      status: "CANCELLED",
      start_at: jst("2030-06-02 08:00"),
    });
    await book(db, shop, {
      ...nakama,
      source: "block",
      start_at: jst("2030-06-02 08:30"),
    });
    await book(db, shop, {
      ...nakama,
      start_at: NOW - 9 * HOUR_MS,
      end_at: NOW - HOUR_MS,
    });

    const firstOfDay = inPickupOrder(onTheFirst).slice(0, 20);
    const overall = [...inPickupOrder([underway, ...dayBefore]), ...inPickupOrder(onTheFirst).slice(0, 17)];

    const FINDS: [Query, string[]][] = [
      [{}, overall],
      [{ text: "nakama" }, overall],
      [{ text: "Yui Nakama" }, overall],
      [{ date: "2030-07-01" }, firstOfDay],
      [{ text: "nakama", date: "2030-07-01" }, firstOfDay],
    ];
    for (const [query, expected] of FINDS) {
      const found = await find(db, query);
      assert.equal(found.length, 20, JSON.stringify(query));
      assert.deepEqual(
        found.map(({ ref }) => ref),
        expected,
        JSON.stringify(query),
      );
    }
  });
});
