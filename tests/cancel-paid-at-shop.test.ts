// Cancelling a paid-at-shop booking (#151), src/lib/booking/cancel.ts: a phone or walk-in reservation, source 'staff', is
// cancelled by the guest's link (quoteCancellation, cancelBooking) or by staff (quoteStaffCancellation, cancelByStaff).
// Nothing was paid online, so nothing is refunded and Square is never called, whatever paid_jpy or payment_id hold. On a
// real D1 with Square scripted, as tests/cancel.test.ts and tests/staff-cancel.test.ts do. Every shop here refunds all of
// paid_jpy on every day, so a cancellation that read paid_jpy as a web booking's would move money and show. Staff bookings
// are made by createStaffBooking, as the Dashboard makes them, wherever the bike they hold counts; elsewhere they are
// seeded with paid_jpy and payment_id set. A web booking in the same shop is the yardstick for "as before" and "as a web
// one is". Instants come from Date.parse on an explicit +09:00 offset, and amounts are literals.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - A staff booking's quote is pinned to ok and refundJpy 0; its daysBefore and refundPercent are left to the code.
// - A staff cancel that asks for money back on a staff booking is QUOTE_CHANGED with the fresh quote, as for any amount
//   that is not what the choice gives, and changes nothing.
// - refund_due_jpy of a staff-cancelled staff booking, the paidJpy the mails carry, and whether the staff mail carries
//   paidAtShop are left to the code. The guest mail must carry paidAtShop: true.
// - Past pickup the guest's link is refused (STARTED), and staff may still cancel a no-show, as for a web booking.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { searchAvailability } from "../src/lib/booking/availability.ts";
import { createHold } from "../src/lib/booking/holds.ts";
import { createStaffBooking } from "../src/lib/booking/staff-booking.ts";
import { LOCALES } from "../src/lib/locale.ts";
import type { Locale } from "../src/lib/locale.ts";
import { renderEmail } from "../src/lib/mail/templates.ts";
import type { EmailPayload } from "../src/lib/outbox.ts";
import type { RefundPaymentInput, RefundResult, SquareClient } from "../src/lib/square/client.ts";
import type { Booking } from "../src/lib/types.ts";
import { createTestDb } from "./helpers/d1.ts";
import {
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedTiers,
  seedVehicle,
} from "./helpers/seed.ts";
import type { BookingRow, TierRow } from "./helpers/seed.ts";

/** Loaded inside each test, after its fixtures, so a test fails on these functions alone and a bad fixture shows first. */
const cancelModule = () => import("../src/lib/booking/cancel.ts");

type Shop = { db: D1Database; packageId: string };

type Choice = "tier" | "full" | "none";

type RefundRow = { id: string; booking_id: string; amount_jpy: number; status: string; idempotency_key: string | null };

type OutboxRow = { id: number; kind: string; dedupe_key: string; payload: string; status: string };

type Answer = (input: RefundPaymentInput) => RefundResult | Promise<RefundResult>;

type Deps = { db: D1Database; square: SquareClient; now: number; staffEmail: string; siteUrl: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const STAFF_EMAIL = "desk@okinawa-dream.example";
const SITE_URL = "https://okinawa-dream.example";
const REQUESTED_BY = "staff@okinawa-dream.example";
const CTX = { siteUrl: SITE_URL, cancelSecret: `cancel-secret-${randomUUID()}`, staffEmail: STAFF_EMAIL };
const SHOP_OPEN = "08:30";
const SHOP_CLOSE = "19:00";

/** The instant of a JST wall clock written "YYYY-MM-DD HH:mm". */
function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

/** All of paid_jpy back on every day, so a staff booking cancelled as a web one would be refunds everything it holds. */
const FULL_BACK: TierRow[] = [{ min_days_before: 0, refund_percent: 100 }];

const PICKUP = "2030-06-10 09:00";
/** Nine JST days before PICKUP. */
const NOW = jst("2030-06-01 12:00");

const CHOICES: Choice[] = ["tier", "full", "none"];

const GUESTS = [
  { familyName: "Yamada", givenName: "Hanako", email: "hanako@example.jp", phone: "090-1234-5678" },
  { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929" },
];

// [what, paid_jpy, payment_id]: what a staff booking may hold. The first is how createStaffBooking leaves it.
const ON_RECORD: [string, number, string | null][] = [
  ["as the Dashboard books it", 0, null],
  ["one yen on record", 1, null],
  ["a deposit on record", 6400, null],
  ["a deposit and a payment id on record", 7001, "square-payment-at-shop"],
];

function localeTexts(name: string): string {
  return JSON.stringify(
    Object.fromEntries(LOCALES.map((locale) => [locale, { name: `${name} ${locale}`, summary: "s", description: "d" }])),
  );
}

/** A published shop on a fresh database with a one-day package. Models come per case, each with its own bikes. */
async function withShop(run: (shop: Shop) => Promise<void>, tiers: TierRow[] = FULL_BACK): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedConfig(db, { shop_open: SHOP_OPEN, shop_close: SHOP_CLOSE });
    await seedCatalogMeta(db);
    await seedTiers(db, tiers);
    const pkg = await seedPackage(db, { days: 1, texts: localeTexts("One day") });
    await run({ db, packageId: pkg.id });
  } finally {
    await dispose();
  }
}

/** A model of its own, priced for the package, with `bikes` bikes. */
async function modelWithBikes(shop: Shop, name: string, bikes: number): Promise<string> {
  const model = await seedModel(shop.db, { texts: localeTexts(name) });
  await seedPrice(shop.db, { rate_class_id: model.rate_class_id, package_id: shop.packageId });
  for (let n = 0; n < bikes; n += 1) await seedVehicle(shop.db, { model_id: model.id });
  return model.id;
}

/** A staff booking of `modelId` for PICKUP, made as the Dashboard makes it. */
async function staffBooked(shop: Shop, modelId: string, locale: Locale, guest = GUESTS[0]): Promise<Booking> {
  const made = await createStaffBooking(
    shop.db,
    { id: randomUUID(), modelId, packageId: shop.packageId, startAt: jst(PICKUP), locale, guest, requestedBy: REQUESTED_BY },
    NOW,
    CTX,
  );
  assert.ok(made.ok, `the staff booking fixture: ${JSON.stringify(made)}`);
  assert.equal(made.booking.source, "staff", "the staff booking fixture");
  return made.booking;
}

/** What `id` holds on record, as a sheet edit or an old row may leave it. */
async function putOnRecord(db: D1Database, id: string, paid: number, paymentId: string | null): Promise<void> {
  await db.prepare("UPDATE bookings SET paid_jpy = ?1, payment_id = ?2 WHERE id = ?3").bind(paid, paymentId, id).run();
}

let lastBooking = 0;

/** A CONFIRMED booking of `source` with paid, deposit and price all different. A staff one has no payment id. */
function bookingOf(
  shop: Shop,
  source: "web" | "staff",
  paid: number,
  change: Partial<BookingRow> = {},
): Promise<BookingRow> {
  lastBooking += 1;
  const start_at = jst(PICKUP);
  return seedBooking(shop.db, {
    id: randomUUID(),
    ref: `P${String(lastBooking).padStart(7, "0")}`,
    source,
    package_id: shop.packageId,
    start_at,
    end_at: start_at + 3 * DAY_MS,
    paid_jpy: paid,
    deposit_jpy: paid + 1000,
    price_jpy: paid + 20_000,
    payment_id: source === "web" ? `square-payment-${lastBooking}` : null,
    guest_family_name: `Higa${lastBooking}`,
    guest_given_name: `Naomi${lastBooking}`,
    guest_email: `guest-${lastBooking}@example.com`,
    guest_phone: `+81-90-0000-${String(lastBooking).padStart(4, "0")}`,
    ...change,
  });
}

function refundIs(status: string): Answer {
  return ({ idempotencyKey, amountJpy, paymentId }) => ({
    kind: "ok",
    refund: { id: `square-${idempotencyKey}`, status, amount: amountJpy, currency: "JPY", payment_id: paymentId },
  });
}

/** A client that answers every refund with `answer` and keeps what it was asked. Anything else it is asked throws. */
function fakeSquare(answer: Answer = refundIs("COMPLETED")): { square: SquareClient; calls: RefundPaymentInput[] } {
  const calls: RefundPaymentInput[] = [];
  const notHere = async (): Promise<never> => {
    throw new Error("only refundPayment belongs in a cancellation");
  };
  const square: SquareClient = {
    createPayment: notHere,
    getPayment: notHere,
    listPayments: notHere,
    listRefunds: notHere,
    async refundPayment(input) {
      calls.push(input);
      return answer(input);
    },
  };
  return { square, calls };
}

function depsOf(shop: Shop, square: SquareClient, now: number): Deps {
  return { db: shop.db, square, now, staffEmail: STAFF_EMAIL, siteUrl: SITE_URL };
}

async function staffCancel(deps: Deps, bookingId: string, choice: Choice, refundJpy: number) {
  const { cancelByStaff } = await cancelModule();
  return cancelByStaff(deps, bookingId, { choice, refundJpy, requestedBy: REQUESTED_BY });
}

async function storedBooking(db: D1Database, id: string): Promise<BookingRow> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  if (row === null) throw new Error(`no booking ${id}`);
  return row;
}

async function refundsOf(db: D1Database, bookingId: string): Promise<RefundRow[]> {
  return (await db.prepare("SELECT * FROM refunds WHERE booking_id = ?1 ORDER BY id").bind(bookingId).all<RefundRow>())
    .results;
}

/** The last outbox id, so what one cancellation queues can be told from what the booking queued when it was made. */
async function outboxTop(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COALESCE(MAX(id), 0) AS top FROM outbox").first<number>("top")) ?? 0;
}

async function queuedSince(db: D1Database, top: number): Promise<OutboxRow[]> {
  return (await db.prepare("SELECT * FROM outbox WHERE id > ?1 ORDER BY id").bind(top).all<OutboxRow>()).results;
}

/** The three items every cancellation queues, by dedupe key. */
function receiptKeys(bookingId: string): string[] {
  return [
    `email:guest_cancellation:${bookingId}`,
    `email:staff_cancellation:${bookingId}`,
    `sheet:${bookingId}:CANCELLED`,
  ].sort();
}

function keysOf(rows: OutboxRow[]): string[] {
  return rows.map(({ dedupe_key }) => dedupe_key).sort();
}

function emailOf(rows: OutboxRow[], template: string): EmailPayload {
  const found = rows
    .filter(({ kind }) => kind === "email")
    .map(({ payload }) => JSON.parse(payload) as EmailPayload)
    .filter((email) => email.template === template);
  assert.equal(found.length, 1, `${template} queued ${found.length} times`);
  return found[0] as EmailPayload;
}

/** Everything a refused cancellation must leave alone. */
async function everything(db: D1Database): Promise<unknown[]> {
  const rows = async (sql: string) => (await db.prepare(sql).all()).results;
  return [
    await rows("SELECT * FROM bookings ORDER BY id"),
    await rows("SELECT * FROM refunds ORDER BY id"),
    await rows("SELECT * FROM outbox ORDER BY id"),
  ];
}

const MISSING_VALUE = /undefined|null|NaN|\[object Object\]/;

function assertRenders(email: EmailPayload, label: string): void {
  const { subject, text, html } = renderEmail(email);
  for (const part of [subject, text, html]) assert.doesNotMatch(part, MISSING_VALUE, `${label}: ${part}`);
}

/** The booking as a cancellation at `now` by `by` leaves it. */
async function assertCancelled(db: D1Database, id: string, now: number, by: "guest" | "staff", label: string) {
  const booking = await storedBooking(db, id);
  assert.equal(booking.status, "CANCELLED", `${label}: status`);
  assert.equal(booking.cancel_reason, by, `${label}: cancel_reason`);
  assert.equal(booking.cancelled_at, now, `${label}: cancelled_at`);
  assert.equal(booking.updated_at, now, `${label}: updated_at`);
}

/**
 * Two staff bookings of a model of its own, on its only two bikes, for the same rental, and what a web guest would find
 * for that rental: `free()` the model's vacancies, `hold(id)` a web hold of it.
 */
async function bothBikesBooked(shop: Shop, name: string, locale: Locale) {
  const { db, packageId } = shop;
  const modelId = await modelWithBikes(shop, name, 2);
  const first = await staffBooked(shop, modelId, locale, GUESTS[0]);
  const second = await staffBooked(shop, modelId, locale, GUESTS[1]);
  assert.notEqual(first.vehiclePlate, second.vehiclePlate, `${name}: the fixture books both bikes`);
  const startAt = jst(PICKUP);
  const free = async () =>
    (await searchAvailability(db, { startAt, packageId, now: NOW }))
      .filter((found) => found.modelId === modelId)
      .map(({ vacancies }) => vacancies);
  const hold = (id: string) => createHold(db, { id, modelId, packageId, startAt, locale: "en" }, NOW);
  return { first, second, free, hold };
}

const SOLD_OUT = { ok: false, reason: "SOLD_OUT" };

test("a guest cancels a paid-at-shop booking, refunds nothing and frees the bike", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const { cancelBooking, quoteCancellation } = await cancelModule();

    for (const [index, [what, paid, paymentId]] of ON_RECORD.entries()) {
      const locale = LOCALES[index % LOCALES.length] as Locale;
      const { first, second, free, hold } = await bothBikesBooked(shop, `Bike ${index}`, locale);
      await putOnRecord(db, first.id, paid, paymentId);
      assert.deepEqual(await free(), [], `${what}: free before the cancel`);
      assert.deepEqual(await hold(`before-${index}`), SOLD_OUT, `${what}: a hold before the cancel`);

      // The link's page: a quote of nothing, and nothing written.
      const before = await everything(db);
      const quote = await quoteCancellation(db, first.id, NOW);
      assert.ok(quote.ok, `${what}: the quote ${JSON.stringify(quote)}`);
      assert.equal(quote.booking.id, first.id, `${what}: the quoted booking`);
      assert.equal(quote.booking.source, "staff", `${what}: the quoted booking`);
      assert.equal(quote.refundJpy, 0, `${what}: the quoted refund`);
      assert.deepEqual(await everything(db), before, `${what}: the quote wrote something`);

      // The POST.
      const top = await outboxTop(db);
      const { square, calls } = fakeSquare();
      const result = await cancelBooking(depsOf(shop, square, NOW), first.id);
      assert.deepEqual(result, { ok: true, refundJpy: 0, refundStatus: "NONE" }, what);
      assert.deepEqual(calls, [], `${what}: Square was called`);
      assert.deepEqual(await refundsOf(db, first.id), [], `${what}: a refund row`);
      await assertCancelled(db, first.id, NOW, "guest", what);
      assert.deepEqual(keysOf(await queuedSince(db, top)), receiptKeys(first.id), `${what}: the queue`);

      // The bike it held is free again, that bike and no other.
      assert.deepEqual(await free(), [1], `${what}: free after the cancel`);
      const held = await hold(`after-${index}`);
      assert.ok(held.ok, `${what}: ${JSON.stringify(held)}`);
      assert.equal(held.booking.vehiclePlate, first.vehiclePlate, `${what}: the bike that came free`);
      assert.deepEqual(await hold(`past-${index}`), SOLD_OUT, `${what}: a hold past the free bike`);
      assert.equal((await storedBooking(db, second.id)).status, "CONFIRMED", `${what}: the other staff booking`);

      // A repeat POST: already cancelled, and nothing more happens.
      const after = await everything(db);
      assert.deepEqual(await cancelBooking(depsOf(shop, square, NOW + MINUTE_MS), first.id), {
        ok: false,
        reason: "ALREADY_CANCELLED",
      });
      assert.deepEqual(calls, [], `${what}: Square was called on a repeat POST`);
      assert.deepEqual(await everything(db), after, `${what}: a repeat POST changed something`);
    }

    // A web booking in the same shop, on the same day, still refunds what was paid, through Square.
    const web = await bookingOf(shop, "web", 7001);
    const { square, calls } = fakeSquare();
    const webQuote = await quoteCancellation(db, web.id, NOW);
    assert.ok(webQuote.ok, `the web quote ${JSON.stringify(webQuote)}`);
    assert.equal(webQuote.refundJpy, 7001, "the web quote");
    assert.deepEqual(await cancelBooking(depsOf(shop, square, NOW), web.id), {
      ok: true,
      refundJpy: 7001,
      refundStatus: "COMPLETED",
    });
    assert.deepEqual(
      calls.map(({ idempotencyKey, paymentId, amountJpy }) => ({ idempotencyKey, paymentId, amountJpy })),
      [{ idempotencyKey: `rf:${web.id}`, paymentId: web.payment_id, amountJpy: 7001 }],
      "the web refund",
    );
    assert.deepEqual((await refundsOf(db, web.id)).map(({ amount_jpy }) => amount_jpy), [7001], "the web refund row");
  });
});

// [what, paid_jpy, payment_id, now]: before pickup, and a no-show staff cancel after it, as a web booking allows.
const STAFF_CASES: [string, number, string | null, number][] = [
  ...ON_RECORD.map(([what, paid, paymentId]): [string, number, string | null, number] => [what, paid, paymentId, NOW]),
  ["a no-show with a deposit on record", 6400, null, jst("2030-06-10 10:00")],
];

test("staff cancel a paid-at-shop booking without calling Square", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const { quoteStaffCancellation } = await cancelModule();

    for (const [what, paid, paymentId, now] of STAFF_CASES) {
      for (const choice of CHOICES) {
        const label = `${what}, ${choice}`;
        const row = await bookingOf(shop, "staff", paid, { payment_id: paymentId });

        // The panel's quote: nothing back, whichever choice.
        const quote = await quoteStaffCancellation(db, row.id, now);
        assert.ok(quote.ok, `${label}: the quote ${JSON.stringify(quote)}`);
        assert.equal(quote.booking.id, row.id, label);
        assert.deepEqual(quote.amounts, { tier: 0, full: 0, none: 0 }, `${label}: the amounts`);

        // Asking for money back is turned away with the fresh quote, and nothing moves.
        const { square, calls } = fakeSquare();
        const before = await everything(db);
        const asked = Math.max(paid, 1);
        const greedy = await staffCancel(depsOf(shop, square, now), row.id, choice, asked);
        assert.ok(!greedy.ok, `${label}: ${asked} back was accepted: ${JSON.stringify(greedy)}`);
        assert.equal(greedy.reason, "QUOTE_CHANGED", `${label}: ${asked} back`);
        const fresh = greedy.quote;
        assert.ok(fresh?.ok, `${label}: the fresh quote ${JSON.stringify(fresh)}`);
        assert.deepEqual(fresh.amounts, { tier: 0, full: 0, none: 0 }, `${label}: the fresh quote`);
        assert.deepEqual(calls, [], `${label}: Square was called for ${asked} back`);
        assert.deepEqual(await everything(db), before, `${label}: asking ${asked} back changed something`);

        // The choice at 0 cancels, without Square.
        const top = await outboxTop(db);
        const result = await staffCancel(depsOf(shop, square, now), row.id, choice, 0);
        assert.deepEqual(result, { ok: true, choice, refundJpy: 0, refundStatus: "NONE" }, label);
        assert.deepEqual(calls, [], `${label}: Square was called`);
        assert.deepEqual(await refundsOf(db, row.id), [], `${label}: a refund row`);
        await assertCancelled(db, row.id, now, "staff", label);
        assert.deepEqual(keysOf(await queuedSince(db, top)), receiptKeys(row.id), `${label}: the queue`);

        // Once cancelled, staff are told so, and nothing more happens.
        const after = await everything(db);
        assert.partialDeepStrictEqual(await staffCancel(depsOf(shop, square, now), row.id, choice, 0), {
          ok: false,
          reason: "ALREADY_CANCELLED",
        });
        assert.deepEqual(await everything(db), after, `${label}: a second cancel changed something`);
      }
    }

    // The bike comes free, as from a guest's cancel.
    for (const [index, choice] of CHOICES.entries()) {
      const { first, second, free, hold } = await bothBikesBooked(shop, `Staff bike ${choice}`, "ja");
      const { square, calls } = fakeSquare();
      assert.deepEqual(await free(), [], `${choice}: free before the cancel`);
      const result = await staffCancel(depsOf(shop, square, NOW), first.id, choice, 0);
      assert.deepEqual(result, { ok: true, choice, refundJpy: 0, refundStatus: "NONE" }, `${choice}: the cancel`);
      assert.deepEqual(calls, [], `${choice}: Square was called`);
      assert.deepEqual(await free(), [1], `${choice}: free after the cancel`);
      const held = await hold(`staff-after-${index}`);
      assert.ok(held.ok, `${choice}: ${JSON.stringify(held)}`);
      assert.equal(held.booking.vehiclePlate, first.vehiclePlate, `${choice}: the bike that came free`);
      assert.equal((await storedBooking(db, second.id)).status, "CONFIRMED", `${choice}: the other staff booking`);
    }

    // A web booking still refunds through Square what staff chose.
    const web = await bookingOf(shop, "web", 7001);
    const { square, calls } = fakeSquare();
    assert.deepEqual(await staffCancel(depsOf(shop, square, NOW), web.id, "full", 7001), {
      ok: true,
      choice: "full",
      refundJpy: 7001,
      refundStatus: "COMPLETED",
    });
    assert.deepEqual(
      calls.map(({ idempotencyKey, amountJpy }) => ({ idempotencyKey, amountJpy })),
      [{ idempotencyKey: `rf:${web.id}`, amountJpy: 7001 }],
      "the web refund",
    );
  });
});

type Path = "guest" | { staff: Choice };

const PATHS: Path[] = ["guest", { staff: "none" }, { staff: "tier" }, { staff: "full" }];

function pathName(path: Path): string {
  return path === "guest" ? "the guest's link" : `staff, ${path.staff}`;
}

async function cancelBy(path: Path, deps: Deps, bookingId: string): Promise<unknown> {
  if (path === "guest") return (await cancelModule()).cancelBooking(deps, bookingId);
  return staffCancel(deps, bookingId, path.staff, 0);
}

test("the cancellation emails carry paidAtShop and the Bookings row is queued", async () => {
  await withShop(async (shop) => {
    const { db } = shop;

    // The coordinator's ruling: a walk-in who gave no email got no confirmation, and gets no cancellation mail either when
    // staff cancel. Staff still get theirs, the Bookings row still goes, the bike comes free and Square is not called.
    // Beside it a walk-in with an email gets all three, so the guest mail goes missing for the blank address alone.
    for (const [index, email] of ["", "walk-in@example.jp"].entries()) {
      const label = email === "" ? "a walk-in with no email" : "a walk-in with an email";
      const ownModel = await modelWithBikes(shop, `Counter ${index}`, 1);
      const made = await staffBooked(shop, ownModel, "ja", { ...GUESTS[0], email });
      const row = await storedBooking(db, made.id);
      const free = async () =>
        (await searchAvailability(db, { startAt: row.start_at, packageId: shop.packageId, now: NOW }))
          .filter((found) => found.modelId === ownModel)
          .map(({ vacancies }) => vacancies);
      assert.deepEqual(await free(), [], `${label}: free before the cancel`);
      const top = await outboxTop(db);
      const { square, calls } = fakeSquare();

      const result = await staffCancel(depsOf(shop, square, NOW), row.id, "tier", 0);

      assert.deepEqual(result, { ok: true, choice: "tier", refundJpy: 0, refundStatus: "NONE" }, label);
      assert.deepEqual(calls, [], `${label}: Square was called`);
      await assertCancelled(db, row.id, NOW, "staff", label);
      assert.deepEqual(await free(), [1], `${label}: free after the cancel`);

      const queued = await queuedSince(db, top);
      const expected = email === "" ? [`email:staff_cancellation:${row.id}`, `sheet:${row.id}:CANCELLED`].sort() : receiptKeys(row.id);
      assert.deepEqual(keysOf(queued), expected, `${label}: the queue`);
      assert.ok(queued.every(({ status }) => status === "pending"), `${label}: ${JSON.stringify(queued)}`);
      const staff = emailOf(queued, "staff_cancellation");
      assert.partialDeepStrictEqual(
        staff,
        { to: STAFF_EMAIL, data: { ref: row.ref, vehiclePlate: row.vehicle_plate, refundJpy: 0, refundStatus: "NONE" } },
        `${label}: the staff mail`,
      );
      assertRenders(staff, `${label}: the staff mail`);
      const sheet = queued.find(({ kind }) => kind === "sheet_booking");
      assert.deepEqual(JSON.parse(sheet?.payload ?? "null"), { bookingId: row.id }, `${label}: the Bookings row`);
      if (email !== "") {
        const guest = emailOf(queued, "guest_cancellation");
        assert.partialDeepStrictEqual(guest, { to: email, data: { paidAtShop: true, refundJpy: 0 } }, `${label}: the guest mail`);
      }

      // No mail anywhere in the queue is addressed to nobody.
      const { results } = await db.prepare("SELECT payload FROM outbox WHERE kind = 'email'").all<{ payload: string }>();
      const blank = results.filter(({ payload }) => {
        const to = (JSON.parse(payload) as { to?: unknown }).to;
        return typeof to !== "string" || to === "";
      });
      assert.deepEqual(blank, [], `${label}: a mail with no address`);
    }

    const modelId = await modelWithBikes(shop, "Vino", 0);

    // Each locale by each path, on a staff booking with something on record or nothing, made as the Dashboard makes it
    // or seeded. The Dashboard's own needs a bike, so those are of a model of their own.
    let n = 0;
    for (const locale of LOCALES) {
      for (const path of PATHS) {
        n += 1;
        const label = `${locale}, ${pathName(path)}, booking ${n}`;
        const [, paid, paymentId] = ON_RECORD[n % ON_RECORD.length] as [string, number, string | null];
        let row: BookingRow;
        let modelName = `Vino ${locale}`;
        let modelNameJa = "Vino ja";
        if (n % 3 === 0) {
          const ownModel = await modelWithBikes(shop, `Walk-in ${n}`, 1);
          row = await storedBooking(db, (await staffBooked(shop, ownModel, locale, GUESTS[n % 2])).id);
          modelName = `Walk-in ${n} ${locale}`;
          modelNameJa = `Walk-in ${n} ja`;
        } else {
          row = await bookingOf(shop, "staff", paid, { locale, model_id: modelId, payment_id: paymentId });
        }
        const top = await outboxTop(db);
        const { square, calls } = fakeSquare();

        assert.partialDeepStrictEqual(await cancelBy(path, depsOf(shop, square, NOW), row.id), { ok: true }, label);
        assert.deepEqual(calls, [], `${label}: Square was called`);

        const queued = await queuedSince(db, top);
        assert.deepEqual(keysOf(queued), receiptKeys(row.id), `${label}: the queue`);
        assert.ok(queued.every(({ status }) => status === "pending"), `${label}: ${JSON.stringify(queued)}`);

        const dates = { ref: row.ref, startAt: row.start_at, endAt: row.end_at };
        const nothingBack = { refundJpy: 0, refundStatus: "NONE" };
        const guest = emailOf(queued, "guest_cancellation");
        assert.partialDeepStrictEqual(
          guest,
          {
            to: row.guest_email,
            locale,
            data: {
              ...dates,
              ...nothingBack,
              paidAtShop: true,
              modelName,
              packageName: `One day ${locale}`,
              shopOpen: SHOP_OPEN,
              shopClose: SHOP_CLOSE,
              guest: { familyName: row.guest_family_name, givenName: row.guest_given_name },
            },
          },
          `${label}: the guest's mail`,
        );
        const staff = emailOf(queued, "staff_cancellation");
        assert.partialDeepStrictEqual(
          staff,
          {
            to: STAFF_EMAIL,
            locale: "ja",
            data: {
              ...dates,
              ...nothingBack,
              modelNameJa,
              packageNameJa: "One day ja",
              vehiclePlate: row.vehicle_plate,
              guest: {
                familyName: row.guest_family_name,
                givenName: row.guest_given_name,
                email: row.guest_email,
                phone: row.guest_phone,
              },
            },
          },
          `${label}: the staff mail`,
        );
        for (const email of [guest, staff]) assertRenders(email, `${label}: ${email.template}`);

        const sheet = queued.find(({ kind }) => kind === "sheet_booking");
        assert.equal(sheet?.dedupe_key, `sheet:${row.id}:CANCELLED`, `${label}: the Bookings row`);
        assert.deepEqual(JSON.parse(sheet?.payload ?? "null"), { bookingId: row.id }, `${label}: the Bookings row`);
      }
    }

    // A web booking's guest mail does not say it was paid at the shop, by either path, and still tells of its refund.
    for (const path of PATHS) {
      const label = `a web booking, ${pathName(path)}`;
      const row = await bookingOf(shop, "web", 5000, { model_id: modelId });
      const top = await outboxTop(db);
      const { square } = fakeSquare();
      const deps = depsOf(shop, square, NOW);
      const result =
        path === "guest"
          ? await cancelBy(path, deps, row.id)
          : await staffCancel(deps, row.id, path.staff, path.staff === "none" ? 0 : 5000);
      assert.partialDeepStrictEqual(result, { ok: true }, label);
      const guest = emailOf(await queuedSince(db, top), "guest_cancellation");
      assert.notEqual(guest.data.paidAtShop, true, `${label}: paidAtShop`);
      assert.equal(guest.data.refundJpy, path === "guest" || path.staff !== "none" ? 5000 : 0, `${label}: refundJpy`);
    }
  });
});

test("a started or cancelled paid-at-shop booking is refused as a web one is", async () => {
  await withShop(async (shop) => {
    const { db } = shop;
    const modelId = await modelWithBikes(shop, "Vino", 0);
    const startAt = jst(PICKUP);
    const week = startAt - 7 * DAY_MS;
    const cancelledBy = (reason: string): Partial<BookingRow> => ({
      status: "CANCELLED",
      cancel_reason: reason,
      cancelled_at: week - DAY_MS,
    });
    const twins = async (change: Partial<BookingRow>) => ({
      web: await bookingOf(shop, "web", 5000, { model_id: modelId, ...change }),
      staff: await bookingOf(shop, "staff", 5000, { model_id: modelId, ...change }),
    });

    // [what, booking state, now, reason] for the guest's link. A full refund on every day, so anything that gets
    // through moves money.
    const byLink: [string, Partial<BookingRow>, number, string][] = [
      ["at its pickup instant", {}, startAt, "STARTED"],
      ["under way", {}, startAt + HOUR_MS, "STARTED"],
      ["past its return", {}, startAt + 30 * DAY_MS, "STARTED"],
      ["cancelled by the guest", cancelledBy("guest"), week, "ALREADY_CANCELLED"],
      ["cancelled by staff", cancelledBy("staff"), week, "ALREADY_CANCELLED"],
      ["cancelled, then its pickup instant", cancelledBy("staff"), startAt, "ALREADY_CANCELLED"],
      ["cancelled, then past pickup", cancelledBy("guest"), startAt + HOUR_MS, "ALREADY_CANCELLED"],
    ];
    // [what, booking state, now] for staff: a cancelled booking is ALREADY_CANCELLED whatever the choice.
    const byStaff: [string, Partial<BookingRow>, number][] = [
      ["cancelled by the guest", cancelledBy("guest"), week],
      ["cancelled by staff", cancelledBy("staff"), week],
      ["cancelled, then past pickup", cancelledBy("staff"), startAt + HOUR_MS],
    ];
    type Twins = { web: BookingRow; staff: BookingRow };
    const linkCases: ({ what: string; now: number; reason: string } & Twins)[] = [];
    for (const [what, change, now, reason] of byLink) linkCases.push({ what, now, reason, ...(await twins(change)) });
    const staffCases: ({ what: string; now: number } & Twins)[] = [];
    for (const [what, change, now] of byStaff) staffCases.push({ what, now, ...(await twins(change)) });
    const block = await bookingOf(shop, "web", 5000, { model_id: modelId, source: "block", external_ref: "block-151" });

    const { cancelBooking, quoteCancellation, quoteStaffCancellation } = await cancelModule();
    const { square, calls } = fakeSquare();
    const before = await everything(db);

    for (const { what, now, reason, web, staff } of linkCases) {
      for (const [source, row] of [["web", web], ["paid-at-shop", staff]] as const) {
        const label = `a ${source} booking ${what}`;
        assert.deepEqual(await quoteCancellation(db, row.id, now), { ok: false, reason }, `${label}: the link's page`);
        assert.deepEqual(await cancelBooking(depsOf(shop, square, now), row.id), { ok: false, reason }, `${label}: POST`);
      }
    }
    for (const { what, now, web, staff } of staffCases) {
      for (const [source, row] of [["web", web], ["paid-at-shop", staff]] as const) {
        const label = `a ${source} booking ${what}, by staff`;
        const reason = "ALREADY_CANCELLED";
        assert.deepEqual(await quoteStaffCancellation(db, row.id, now), { ok: false, reason }, `${label}: the quote`);
        for (const choice of CHOICES) {
          const result = await staffCancel(depsOf(shop, square, now), row.id, choice, 0);
          assert.partialDeepStrictEqual(result, { ok: false, reason }, `${label}, ${choice}`);
        }
      }
    }

    // A block is no guest's booking and no staff cancel's: refused on every path, as before.
    assert.deepEqual(await quoteCancellation(db, block.id, week), { ok: false, reason: "NOT_CANCELLABLE" }, "a block");
    assert.deepEqual(await cancelBooking(depsOf(shop, square, week), block.id), { ok: false, reason: "NOT_CANCELLABLE" });
    assert.deepEqual(await quoteStaffCancellation(db, block.id, week), { ok: false, reason: "NOT_CANCELLABLE" });
    for (const choice of CHOICES) {
      const result = await staffCancel(depsOf(shop, square, week), block.id, choice, 0);
      assert.partialDeepStrictEqual(result, { ok: false, reason: "NOT_CANCELLABLE" }, `a block, staff ${choice}`);
    }

    assert.deepEqual(calls, [], "a refused cancel called Square");
    assert.deepEqual(await everything(db), before, "a refused cancel changed something");

    // The last millisecond before pickup still cancels a paid-at-shop booking by its link, so the refusals above came
    // from the rules.
    const lastChance = await bookingOf(shop, "staff", 5000, { model_id: modelId });
    assert.deepEqual(await cancelBooking(depsOf(shop, square, startAt - 1), lastChance.id), {
      ok: true,
      refundJpy: 0,
      refundStatus: "NONE",
    });
    assert.deepEqual(calls, [], "the last-chance cancel called Square");
  });
});
