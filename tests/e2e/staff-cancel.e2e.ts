// POST /api/staff/cancel through the built Worker in Miniflare (#148): the Dashboard's "Cancel a booking" panel quotes a
// cancellation, then confirms it with the refund staff chose. Square is faked in `outbound` at the sandbox URL, as
// tests/e2e/cancel.e2e.ts does, so the real client runs and no seam is needed. The mail web app and Google are down in this
// file, and a request to them is the drain after a cancel. Envelopes are signed here with node:crypto, the way the Apps
// Script signs them, and because WebCrypto refuses the empty secret one test needs.
//
// Amounts are worked out by hand from TIERS and written as literals. Pickups sit in the middle of a tier, so a run that
// crosses midnight JST keeps its amounts, and only the tests that read daysBefore run again then. "Changes nothing" is the
// bookings, refunds and outbox rows as they were and no call to Square. Every test ends on a request that must work,
// because an unchanged database proves nothing about a route that does not exist.
//
// Every POST says Content-Type: application/json as the Apps Script does: Astro's origin check answers 403 to a
// cross-site POST with no type, or with a form type, which is what a bare string body gets.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LOCALES } from "../../src/lib/locale.ts";
import {
  insertRow,
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedTiers,
  type BookingRow,
  type TierRow,
} from "../helpers/seed.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const PATH = "/api/staff/cancel";
const JSON_HEADERS = { "Content-Type": "application/json" };
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Not the values of testVars, so a secret or an address written into the source shows.
const SECRET = "e2e-staff-cancel-key";
const STAFF_EMAIL = "e2e-desk@example.com";
const ACCESS_TOKEN = "e2e-sq-token-sc";
const REFUNDS_URL = "https://connect.squareupsandbox.com/v2/refunds";
const REQUESTED_BY = "staff@example.com";
/** How long the drain after a cancel may take to reach the mail web app. */
const SETTLE_MS = 10_000;

/** 14 days or more before pickup 80%, 5 to 13 days 40%, 2 to 4 days 15%, 0 or 1 day nothing. */
const TIERS: TierRow[] = [
  { min_days_before: 14, refund_percent: 80 },
  { min_days_before: 5, refund_percent: 40 },
  { min_days_before: 2, refund_percent: 15 },
  { min_days_before: 0, refund_percent: 0 },
];
/** A cancel past pickup is priced at 0 days before (owner decision 3), which these tiers make 25%, so it shows. */
const NO_SHOW_TIERS: TierRow[] = [
  { min_days_before: 14, refund_percent: 80 },
  { min_days_before: 5, refund_percent: 40 },
  { min_days_before: 0, refund_percent: 25 },
];

type Choice = "tier" | "full" | "none";
type Amounts = Record<Choice, number>;
type Answer = Record<string, unknown>;
type Quote = {
  booking: Record<string, unknown> & { guestName: string };
  daysBefore: number;
  refundPercent: number;
  refundedJpy: number;
  amounts: Amounts;
};
/** What a quote says beyond the booking. */
type Priced = Omit<Quote, "booking">;

/** A bookings row with the column #145 added. */
type StoredBooking = BookingRow & { refund_due_jpy: number | null };

type RefundRow = {
  id: string;
  booking_id: string;
  square_refund_id: string | null;
  amount_jpy: number;
  status: string;
  origin: string;
  idempotency_key: string | null;
};

type RefundBody = {
  idempotency_key: string;
  payment_id: string;
  amount_money: { amount: number; currency: string };
};

type RefundCall = { authorization: string | null; key: string; paymentId: string; amount: number; currency: string };

let worker: TestWorker;
let modelIds: string[] = [];
let packageId = "";

const refundCalls: RefundCall[] = [];
/** The bodies the Worker sent the mail web app and Google, which only the drain after a request sends here. */
const deliveries: string[] = [];
const strayRequests: string[] = [];

function refundAs(status: string): (body: RefundBody) => Response {
  return ({ idempotency_key, amount_money, payment_id }) =>
    Response.json({
      refund: { id: `square-${idempotency_key}`, status, amount_money, payment_id, created_at: new Date().toISOString() },
    });
}

const squareDown = (): Response => new Response("upstream failed", { status: 500 });

let answerRefund = refundAs("PENDING");

function isDelivery(request: Request): boolean {
  const url = new URL(request.url);
  return `${url.origin}${url.pathname}` === testVars.APPS_SCRIPT_MAIL_URL || url.hostname.endsWith(".googleapis.com");
}

async function outbound(request: Request): Promise<Response> {
  if (isDelivery(request)) {
    deliveries.push(await request.text());
    return new Response("the mail web app and Google are down in this file", { status: 503 });
  }
  if (request.method !== "POST" || request.url !== REFUNDS_URL) {
    strayRequests.push(`${request.method} ${request.url}`);
    return new Response(`no fake for ${request.url}`, { status: 502 });
  }
  const body = (await request.json()) as RefundBody;
  refundCalls.push({
    authorization: request.headers.get("authorization"),
    key: body.idempotency_key,
    paymentId: body.payment_id,
    amount: body.amount_money.amount,
    currency: body.amount_money.currency,
  });
  return answerRefund(body);
}

function texts(fields: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, fields])));
}

before(async () => {
  worker = await startWorker({
    vars: { PUBLISH_SECRET: SECRET, STAFF_EMAIL, SQUARE_ACCESS_TOKEN: ACCESS_TOKEN },
    outbound,
  });
  const { db } = worker;
  await seedConfig(db);
  await seedCatalogMeta(db);
  const tricity = await seedModel(db, { texts: texts({ name: "Tricity 125", summary: "s", description: "d" }) });
  const pcx = await seedModel(db, { texts: texts({ name: "PCX 160", summary: "s", description: "d" }) });
  const day = await seedPackage(db, { texts: texts({ name: "One day" }) });
  await seedPrice(db, { rate_class_id: tricity.rate_class_id, package_id: day.id });
  await seedPrice(db, { rate_class_id: pcx.rate_class_id, package_id: day.id });
  modelIds = [tricity.id, pcx.id];
  packageId = day.id;
});

after(async () => {
  await worker?.stop();
});

beforeEach(() => {
  refundCalls.length = 0;
  deliveries.length = 0;
  strayRequests.length = 0;
  answerRefund = refundAs("PENDING");
});

afterEach(() => {
  assert.deepEqual(strayRequests, [], "the Worker called out to something other than Square's refunds, mail or Google");
});

/** The date of `at` in JST, by adding the offset: JST has no clock changes. */
function jstDate(at: number): string {
  return new Date(at + 9 * HOUR_MS).toISOString().slice(0, 10);
}

/** Runs `check`, again if it fails and the JST date has changed since, because the Worker then counts one day fewer. */
async function steady(check: () => Promise<void>): Promise<void> {
  for (;;) {
    const startedOn = jstDate(Date.now());
    try {
      await check();
      return;
    } catch (error) {
      if (jstDate(Date.now()) === startedOn) throw error;
    }
  }
}

async function setTiers(tiers: TierRow[]): Promise<void> {
  await worker.db.prepare("DELETE FROM cancellation_tiers").run();
  await seedTiers(worker.db, tiers);
}

let lastBooking = 0;

/**
 * A CONFIRMED web booking whose pickup is `days` whole days from now, with paid, deposit and price all different. Refs and
 * names are fixed width, so none is part of another, and models and locales take turns.
 */
function confirmed(days: number, paid: number, change: Partial<BookingRow> = {}): Promise<BookingRow> {
  lastBooking += 1;
  const n = String(lastBooking).padStart(4, "0");
  const start_at = Date.now() + days * DAY_MS;
  return seedBooking(worker.db, {
    id: randomUUID(),
    ref: `SC${n}XQ`,
    model_id: modelIds[lastBooking % modelIds.length],
    package_id: packageId,
    start_at,
    end_at: start_at + 8 * HOUR_MS,
    paid_jpy: paid,
    deposit_jpy: paid + 1000,
    price_jpy: paid + 20_000,
    payment_id: `sq-pay-${n}`,
    payment_attempt: 1,
    locale: LOCALES[lastBooking % LOCALES.length],
    guest_family_name: `Higa${n}`,
    guest_given_name: `Naomi${n}`,
    guest_email: `guest-${n}@example.com`,
    guest_phone: `+81-90-1111-${n}`,
    confirmed_at: Date.now() - 30 * DAY_MS,
    ...change,
  });
}

/** A refund the booking already had, from the Square Dashboard. Only PENDING and COMPLETED ones count. */
async function refundedBefore(booking: BookingRow, amount: number, status: string): Promise<void> {
  const at = Date.now() - HOUR_MS;
  await insertRow(worker.db, "refunds", {
    id: randomUUID(),
    booking_id: booking.id,
    square_refund_id: `sq-earlier-${randomUUID()}`,
    amount_jpy: amount,
    status,
    origin: "dashboard",
    idempotency_key: `earlier-${randomUUID()}`,
    created_at: at,
    updated_at: at,
  });
}

/** The envelope the Apps Script sends: an HMAC-SHA256 in hex over `ts.payload`, with the payload as JSON text. */
function envelope(secret: string, payload: unknown, ts = Date.now()) {
  const text = JSON.stringify(payload);
  return { ts, payload: text, sig: createHmac("sha256", secret).update(`${ts}.${text}`).digest("hex") };
}

function post(body: string, to: TestWorker = worker): Promise<Response> {
  return to.fetch(PATH, { method: "POST", headers: JSON_HEADERS, body });
}

function postWithLength(body: string): Promise<Response> {
  const headers = { ...JSON_HEADERS, "Content-Length": String(Buffer.byteLength(body)) };
  return worker.fetch(PATH, { method: "POST", headers, body });
}

function signedPost(payload: unknown): Promise<Response> {
  return post(JSON.stringify(envelope(SECRET, payload)));
}

/** A response body cut short for a message, so a whole error page does not bury the failure. */
function brief(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  const path = /Path: [^<]*/.exec(flat)?.[0];
  return flat.length <= 200 ? flat : `${flat.slice(0, 120)}...${path ? ` (${path})` : ""}`;
}

/** The JSON of a 200. */
async function answerOf(res: Response, label: string): Promise<Answer> {
  const text = await res.text();
  assert.equal(res.status, 200, `${label}: ${res.status} ${brief(text)}`);
  return JSON.parse(text) as Answer;
}

function quotePayload(bookingId: string) {
  return { requestedBy: REQUESTED_BY, bookingId };
}

function confirmPayload(bookingId: string, choice: string, refundJpy: number) {
  return { requestedBy: REQUESTED_BY, bookingId, confirm: { choice, refundJpy } };
}

async function quote(bookingId: string, label: string): Promise<Answer> {
  return answerOf(await signedPost(quotePayload(bookingId)), `${label}, quote`);
}

async function confirm(bookingId: string, choice: string, refundJpy: number, label: string): Promise<Answer> {
  return answerOf(await signedPost(confirmPayload(bookingId, choice, refundJpy)), `${label}, confirm ${choice} ${refundJpy}`);
}

/** Everything a request can change. Delivery fields of the outbox are left out, because a drain moves them on its own. */
async function stored(db: D1Database = worker.db): Promise<unknown[]> {
  const rows = async (sql: string) => (await db.prepare(sql).all()).results;
  return [
    await rows("SELECT * FROM bookings ORDER BY id"),
    await rows("SELECT * FROM refunds ORDER BY id"),
    await rows("SELECT kind, dedupe_key, payload FROM outbox ORDER BY dedupe_key"),
  ];
}

async function bookingNow(id: string): Promise<StoredBooking> {
  const row = await worker.db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<StoredBooking>();
  if (row === null) throw new Error(`no booking ${id}`);
  return row;
}

async function refundsOf(id: string): Promise<RefundRow[]> {
  return (await worker.db.prepare("SELECT * FROM refunds WHERE booking_id = ?1").bind(id).all<RefundRow>()).results;
}

/** The new refund a cancellation wrote, under the booking's refund key, apart from any it already had. */
async function cancelRefundsOf(id: string): Promise<RefundRow[]> {
  return (await refundsOf(id)).filter(({ origin }) => origin === "cancel");
}

type Queued = { kind: string; template?: unknown; to?: unknown; locale?: unknown; refundJpy?: unknown; bookingId?: unknown };

/** The queue for one booking: each email's template, address, locale and refund, and each sheet item's booking. */
async function queuedFor(booking: BookingRow): Promise<Queued[]> {
  const { results } = await worker.db.prepare("SELECT kind, payload FROM outbox").all<{ kind: string; payload: string }>();
  return results
    .filter(({ payload }) => payload.includes(booking.id) || payload.includes(booking.ref))
    .map(({ kind, payload }): Queued => {
      const parsed = JSON.parse(payload) as Record<string, unknown> & { data?: Record<string, unknown> };
      if (kind !== "email") return { kind, bookingId: parsed.bookingId };
      const { template, to, locale } = parsed;
      return { kind, template, to, locale, refundJpy: parsed.data?.refundJpy };
    })
    .sort((a, b) => String(a.template ?? a.kind).localeCompare(String(b.template ?? b.kind)));
}

/** What a cancellation queues: the guest's email in their locale, the staff email and the Bookings row. */
function receipt(booking: BookingRow, refundJpy: number): Queued[] {
  return [
    { kind: "email", template: "guest_cancellation", to: booking.guest_email, locale: booking.locale, refundJpy },
    { kind: "sheet_booking", bookingId: booking.id },
    { kind: "email", template: "staff_cancellation", to: STAFF_EMAIL, locale: "ja", refundJpy },
  ];
}

/** The booking as the panel shows it, from the seeded row, but for guestName. */
function summaryOf(booking: BookingRow): Record<string, unknown> {
  return {
    id: booking.id,
    ref: booking.ref,
    source: "web",
    status: "CONFIRMED",
    modelId: booking.model_id,
    plate: booking.vehicle_plate,
    startAt: booking.start_at,
    endAt: booking.end_at,
    guestEmail: booking.guest_email,
    paidJpy: booking.paid_jpy,
  };
}

/** `answer` is `{ ok: true, quote }` for `booking`, priced as `priced`. */
function assertQuote(answer: Answer, booking: BookingRow, priced: Priced, label: string): void {
  assert.equal(answer.ok, true, `${label}: ${JSON.stringify(answer)}`);
  assert.deepEqual(Object.keys(answer).sort(), ["ok", "quote"], `${label}: ${JSON.stringify(answer)}`);
  const { booking: shown, ...rest } = answer.quote as Quote;
  assert.deepEqual(rest, priced, label);
  assert.deepEqual(
    Object.keys(shown).sort(),
    ["endAt", "guestEmail", "guestName", "id", "modelId", "paidJpy", "plate", "ref", "source", "startAt", "status"],
    label,
  );
  const { guestName, ...fields } = shown;
  assert.deepEqual(fields, summaryOf(booking), label);
  assert.equal(typeof guestName, "string", label);
  assert.ok(guestName.includes(booking.guest_family_name ?? "?"), `${label}: guestName ${guestName}`);
  assert.ok(guestName.includes(booking.guest_given_name ?? "?"), `${label}: guestName ${guestName}`);
}

/** The booking is cancelled by staff, between `postedAt` and now, having settled on `refundDue` in all. */
async function assertCancelled(booking: BookingRow, refundDue: number, postedAt: number, label: string): Promise<void> {
  const row = await bookingNow(booking.id);
  assert.equal(row.status, "CANCELLED", label);
  assert.equal(row.cancel_reason, "staff", label);
  assert.equal(row.refund_due_jpy, refundDue, `${label}: refund_due_jpy`);
  assert.ok(row.cancelled_at !== null && row.cancelled_at >= postedAt, `${label}: cancelled_at ${row.cancelled_at}`);
  assert.ok((row.cancelled_at ?? Infinity) <= Date.now(), `${label}: cancelled_at ${row.cancelled_at}`);
}

/** The one refund call `booking` should have made, of `amount`. */
function refundCall(booking: BookingRow, amount: number): RefundCall {
  return {
    authorization: `Bearer ${ACCESS_TOKEN}`,
    key: `rf:${booking.id}`,
    paymentId: booking.payment_id ?? "",
    amount,
    currency: "JPY",
  };
}

/** Polls `read` until it holds, for up to `timeoutMs`. */
async function until(read: () => boolean, what: string, timeoutMs = SETTLE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await sleep(50);
  }
}

/** A short line staff can read as it stands, carrying no secret. */
function assertPlainWords(text: string, label: string): void {
  assert.ok(text.trim().length > 0 && text.length <= 200, `${label}: expected a short message, got ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /^\s*[{[<"]/, `${label}: staff would read this as it stands: ${brief(text)}`);
  assert.equal(text.includes(SECRET), false, `${label}: the response carries the secret`);
}

test("a signed quote answers the three amounts and writes nothing", async () => {
  await setTiers(TIERS);
  // [what, days before pickup, paid, refunds it already had, what the quote says]
  const CASES: [string, number, number, [number, string][], Priced][] = [
    ["80% tier", 20, 9000, [], q(20, 80, 0, { tier: 7200, full: 9000, none: 0 })],
    ["40% tier, rounded down", 10, 7001, [], q(10, 40, 0, { tier: 2800, full: 7001, none: 0 })],
    ["15% tier, rounded down", 3, 9999, [], q(3, 15, 0, { tier: 1499, full: 9999, none: 0 })],
    ["0% tier", 1, 5000, [], q(1, 0, 0, { tier: 0, full: 5000, none: 0 })],
    ["a pending refund already", 10, 9000, [[1000, "PENDING"]], q(10, 40, 1000, { tier: 2600, full: 8000, none: 0 })],
    ["refunds past the tier", 10, 9000, [[3000, "COMPLETED"], [2000, "PENDING"]], q(10, 40, 5000, { tier: 0, full: 4000, none: 0 })],
    ["a rejected refund, which gave nothing", 10, 9000, [[2000, "REJECTED"]], q(10, 40, 0, { tier: 3600, full: 9000, none: 0 })],
    ["nothing paid", 20, 0, [], q(20, 80, 0, { tier: 0, full: 0, none: 0 })],
  ];
  function q(daysBefore: number, refundPercent: number, refundedJpy: number, amounts: Amounts): Priced {
    return { daysBefore, refundPercent, refundedJpy, amounts };
  }

  await steady(async () => {
    refundCalls.length = 0;
    const seeded: [string, BookingRow, Priced][] = [];
    for (const [what, days, paid, earlier, priced] of CASES) {
      const booking = await confirmed(days, paid);
      for (const [amount, status] of earlier) await refundedBefore(booking, amount, status);
      seeded.push([what, booking, priced]);
    }
    const before = await stored();

    for (const [what, booking, priced] of seeded) {
      assertQuote(await quote(booking.id, what), booking, priced, what);
    }
    // Asked again, a quote is the same: nothing it did moved the booking.
    const [what, booking, priced] = seeded[0] as [string, BookingRow, Priced];
    assertQuote(await quote(booking.id, `${what}, again`), booking, priced, `${what}, again`);

    assert.deepEqual(await stored(), before, "a quote changed D1");
    assert.deepEqual(refundCalls, [], "a quote called Square");
  });
});

test("a signed confirm with the full refund refunds through Square, cancels the booking and queues the emails and the Bookings row", async () => {
  await setTiers(TIERS);
  // [what, days before pickup, paid, a refund it already had, the full amount]. The 0% tier shows full is not the tier.
  const CASES: [string, number, number, number, number][] = [
    ["80% tier", 20, 9000, 0, 9000],
    ["after a pending refund of 1000", 10, 7001, 1000, 6001],
    ["0% tier", 1, 5000, 0, 5000],
  ];
  for (const [what, days, paid, earlier, full] of CASES) {
    const booking = await confirmed(days, paid);
    if (earlier > 0) await refundedBefore(booking, earlier, "PENDING");
    const callsBefore = refundCalls.length;
    const postedAt = Date.now();

    const answer = await confirm(booking.id, "full", full, what);
    assert.deepEqual(answer, { ok: true, choice: "full", refundJpy: full, refundStatus: "PENDING" }, what);

    assert.deepEqual(refundCalls.slice(callsBefore), [refundCall(booking, full)], `${what}: the call to Square`);
    await assertCancelled(booking, earlier + full, postedAt, what);
    const refunds = await cancelRefundsOf(booking.id);
    assert.deepEqual(
      refunds.map(({ square_refund_id, amount_jpy, status, idempotency_key }) => ({
        square_refund_id,
        amount_jpy,
        status,
        idempotency_key,
      })),
      [{ square_refund_id: `square-rf:${booking.id}`, amount_jpy: full, status: "PENDING", idempotency_key: `rf:${booking.id}` }],
      `${what}: the refund row`,
    );
    assert.equal((await refundsOf(booking.id)).length, earlier > 0 ? 2 : 1, `${what}: refund rows`);
    assert.deepEqual(await queuedFor(booking), receipt(booking, full), `${what}: the queue`);

    // The drain after the cancel sends the guest's email at once, rather than leaving it to the ten-minute cron.
    const address = booking.guest_email ?? "?";
    await until(() => deliveries.some((body) => body.includes(address)), `${what}: the drain after the cancel`);
  }
});

test("a confirm with the tier refund sends the tier amount", async () => {
  await setTiers(TIERS);
  // [what, days before pickup, paid, a refund it already had, what Square answers, the tier amount, refundStatus]
  const CASES: [string, number, number, number, (body: RefundBody) => Response, number, string][] = [
    ["80% tier", 20, 9000, 0, refundAs("PENDING"), 7200, "PENDING"],
    ["40% tier, rounded down", 10, 7001, 0, refundAs("COMPLETED"), 2800, "COMPLETED"],
    ["15% tier, rounded down, Square down", 3, 9999, 0, squareDown, 1499, "RETRY"],
    ["40% tier after a completed refund of 1000", 10, 9000, 1000, refundAs("COMPLETED"), 2600, "COMPLETED"],
  ];
  for (const [what, days, paid, earlier, answer, tier, refundStatus] of CASES) {
    answerRefund = answer;
    const booking = await confirmed(days, paid);
    if (earlier > 0) await refundedBefore(booking, earlier, "COMPLETED");
    const callsBefore = refundCalls.length;
    const postedAt = Date.now();

    assert.deepEqual(
      await confirm(booking.id, "tier", tier, what),
      { ok: true, choice: "tier", refundJpy: tier, refundStatus },
      what,
    );
    assert.deepEqual(refundCalls.slice(callsBefore), [refundCall(booking, tier)], `${what}: the call to Square`);
    await assertCancelled(booking, earlier + tier, postedAt, what);
    assert.deepEqual(
      (await cancelRefundsOf(booking.id)).map(({ amount_jpy, idempotency_key }) => ({ amount_jpy, idempotency_key })),
      [{ amount_jpy: tier, idempotency_key: `rf:${booking.id}` }],
      `${what}: the refund row`,
    );
    assert.deepEqual(await queuedFor(booking), receipt(booking, tier), `${what}: the queue`);
  }
});

test("a confirm with no refund cancels without calling Square", async () => {
  await setTiers(TIERS);
  // [what, days before pickup, paid, a refund it already had, the choice]: every one of them gives back nothing.
  const CASES: [string, number, number, number, Choice][] = [
    ["no refund", 20, 9000, 0, "none"],
    ["no refund after a completed refund of 1000", 10, 9000, 1000, "none"],
    ["the 0% tier", 1, 5000, 0, "tier"],
    ["all of nothing paid", 10, 0, 0, "full"],
  ];
  for (const [what, days, paid, earlier, choice] of CASES) {
    const booking = await confirmed(days, paid);
    if (earlier > 0) await refundedBefore(booking, earlier, "COMPLETED");
    const postedAt = Date.now();

    assert.deepEqual(
      await confirm(booking.id, choice, 0, what),
      { ok: true, choice, refundJpy: 0, refundStatus: "NONE" },
      what,
    );
    assert.deepEqual(refundCalls, [], `${what}: Square was called`);
    assert.deepEqual(await cancelRefundsOf(booking.id), [], `${what}: a refund row`);
    await assertCancelled(booking, earlier, postedAt, what);
    assert.deepEqual(await queuedFor(booking), receipt(booking, 0), `${what}: the queue`);
  }
});

test("a confirm whose amount no longer matches answers QUOTE_CHANGED and changes nothing", async () => {
  await setTiers(TIERS);
  await steady(async () => {
    refundCalls.length = 0;

    /** Confirms `[choice, refundJpy]` and checks the answer is QUOTE_CHANGED with the quote a fresh request gives. */
    const changed = async (booking: BookingRow, [choice, refundJpy]: [Choice, number], amounts: Amounts, label: string) => {
      const answer = await confirm(booking.id, choice, refundJpy, label);
      const fresh = await quote(booking.id, `${label}, fresh`);
      assert.equal(fresh.ok, true, `${label}: ${JSON.stringify(fresh)}`);
      assert.deepEqual((fresh.quote as Quote).amounts, amounts, `${label}: the fresh quote`);
      assert.deepEqual(answer, { ok: false, reason: "QUOTE_CHANGED", quote: fresh.quote }, label);
    };

    // 10 days before, 9000 paid: tier 3600, full 9000, none 0. Each of these is some other amount, or another choice's.
    const booking = await confirmed(10, 9000);
    const AMOUNTS: Amounts = { tier: 3600, full: 9000, none: 0 };
    const MISMATCHES: [Choice, number][] = [
      ["tier", 3601],
      ["tier", 3599],
      ["tier", 9000],
      ["tier", 0],
      ["full", 3600],
      ["full", 8999],
      ["full", 9001],
      ["none", 1],
      ["none", 3600],
    ];
    const before = await stored();
    for (const sent of MISMATCHES) await changed(booking, sent, AMOUNTS, `${sent[0]} ${sent[1]}`);
    assert.deepEqual(await stored(), before, "a confirm that did not match changed D1");
    assert.deepEqual(refundCalls, [], "a confirm that did not match called Square");

    // The panel quoted, then a refund of 500 landed from the Square Dashboard before staff pressed confirm.
    const refunded = await confirmed(10, 9000);
    assertQuote(await quote(refunded.id, "before the refund"), refunded, {
      daysBefore: 10,
      refundPercent: 40,
      refundedJpy: 0,
      amounts: AMOUNTS,
    }, "before the refund");
    await refundedBefore(refunded, 500, "COMPLETED");
    const afterRefund = await stored();
    await changed(refunded, ["tier", 3600], { tier: 3100, full: 8500, none: 0 }, "the tier quoted before a refund");
    await changed(refunded, ["full", 9000], { tier: 3100, full: 8500, none: 0 }, "the full amount quoted before a refund");
    assert.deepEqual(await stored(), afterRefund, "a stale confirm changed D1");

    // The panel quoted, then the pickup moved to 3 days away, into the 15% tier.
    const moved = await confirmed(10, 9000);
    const movedTo = Date.now() + 3 * DAY_MS;
    await worker.db
      .prepare("UPDATE bookings SET start_at = ?2, end_at = ?3 WHERE id = ?1")
      .bind(moved.id, movedTo, movedTo + 8 * HOUR_MS)
      .run();
    const afterMove = await stored();
    const stale = await confirm(moved.id, "tier", 3600, "the tier quoted before the pickup moved");
    assert.equal(stale.reason, "QUOTE_CHANGED", JSON.stringify(stale));
    const { booking: _shown, ...priced } = stale.quote as Quote;
    assert.deepEqual(priced, { daysBefore: 3, refundPercent: 15, refundedJpy: 0, amounts: { tier: 1350, full: 9000, none: 0 } });
    assert.deepEqual(await stored(), afterMove, "a stale confirm changed D1");
    assert.deepEqual(refundCalls, [], "a stale confirm called Square");

    // Each confirmed at what it gives now does cancel.
    const RIGHT: [BookingRow, Choice, number][] = [
      [booking, "tier", 3600],
      [refunded, "tier", 3100],
      [moved, "full", 9000],
    ];
    for (const [target, choice, amount] of RIGHT) {
      const label = `${target.ref} at ${choice} ${amount}`;
      assert.deepEqual(
        await confirm(target.id, choice, amount, label),
        { ok: true, choice, refundJpy: amount, refundStatus: "PENDING" },
        label,
      );
      assert.equal((await bookingNow(target.id)).status, "CANCELLED", label);
    }
    assert.deepEqual(refundCalls.map(({ amount }) => amount), [3600, 3100, 9000]);
  });
});

test("cancelled, block and unknown bookings answer their reason and change nothing", async () => {
  await setTiers(TIERS);
  const cancelledAt = { cancelled_at: Date.now() - HOUR_MS };
  const blockGone = { status: "CANCELLED", cancel_reason: "The row left the Blocks tab", ...cancelledAt };
  // [what, the row, the reason]
  const STATES: [string, Partial<BookingRow>, string][] = [
    ["a booking the guest cancelled", { status: "CANCELLED", cancel_reason: "guest", ...cancelledAt }, "ALREADY_CANCELLED"],
    ["a booking staff cancelled", { status: "CANCELLED", cancel_reason: "staff", ...cancelledAt }, "ALREADY_CANCELLED"],
    ["a staff block", { source: "block", external_ref: `e2e-block-${randomUUID()}` }, "NOT_CANCELLABLE"],
    ["an OTA block", { source: "block", external_ref: `e2e-ota-${randomUUID()}`, external_channel: "Klook" }, "NOT_CANCELLABLE"],
    ["a cancelled block", { source: "block", external_ref: `e2e-gone-${randomUUID()}`, ...blockGone }, "NOT_CANCELLABLE"],
    ["a hold", { status: "ON_HOLD", expires_at: Date.now() + HOUR_MS, paid_jpy: 0 }, "NOT_CANCELLABLE"],
    ["a booking in payment", { status: "PAYMENT_PENDING", paid_jpy: 0 }, "NOT_CANCELLABLE"],
    ["an expired hold", { status: "EXPIRED", paid_jpy: 0 }, "NOT_CANCELLABLE"],
  ];
  const targets: [string, string, string][] = [];
  for (const [what, change, reason] of STATES) targets.push([what, (await confirmed(10, 9000, change)).id, reason]);
  targets.push(["an unknown booking", randomUUID(), "NOT_FOUND"]);
  const before = await stored();

  for (const [what, id, reason] of targets) {
    assert.deepEqual(await quote(id, what), { ok: false, reason }, `${what}: quote`);
    for (const [choice, amount] of [["tier", 3600], ["full", 9000], ["none", 0]] as const) {
      assert.deepEqual(await confirm(id, choice, amount, what), { ok: false, reason }, `${what}: confirm ${choice}`);
    }
  }
  assert.deepEqual(await stored(), before, "a refused booking changed D1");
  assert.deepEqual(refundCalls, [], "a refused booking called Square");

  // A confirmed web booking does cancel.
  const booking = await confirmed(10, 9000);
  assert.deepEqual(await confirm(booking.id, "tier", 3600, "a confirmed booking"), {
    ok: true,
    choice: "tier",
    refundJpy: 3600,
    refundStatus: "PENDING",
  });
  assert.equal((await bookingNow(booking.id)).status, "CANCELLED");
});

test("a started booking (a no-show) is quoted and cancelled", async () => {
  await setTiers(NO_SHOW_TIERS);
  const now = Date.now();
  // [what, pickup, return, paid, a refund it already had, what the quote says, the choice staff confirm]. Past pickup
  // a staff cancel is priced at 0 days before, here 25%, however long ago the pickup was.
  const CASES: [string, number, number, number, number, Amounts, Choice][] = [
    ["picked up an hour ago", now - HOUR_MS, now + DAY_MS, 9000, 0, { tier: 2250, full: 9000, none: 0 }, "tier"],
    ["over a day ago, rental over", now - 2 * DAY_MS, now - DAY_MS, 7001, 0, { tier: 1750, full: 7001, none: 0 }, "full"],
    ["three hours ago, 1000 refunded", now - 3 * HOUR_MS, now + DAY_MS, 5000, 1000, { tier: 250, full: 4000, none: 0 }, "none"],
  ];
  for (const [what, start_at, end_at, paid, earlier, amounts, choice] of CASES) {
    const booking = await confirmed(0, paid, { start_at, end_at });
    if (earlier > 0) await refundedBefore(booking, earlier, "COMPLETED");
    const before = await stored();

    const priced = { daysBefore: 0, refundPercent: 25, refundedJpy: earlier, amounts };
    assertQuote(await quote(booking.id, what), booking, priced, what);
    assert.deepEqual(await stored(), before, `${what}: the quote changed D1`);

    const callsBefore = refundCalls.length;
    const postedAt = Date.now();
    const refund = amounts[choice];
    assert.deepEqual(
      await confirm(booking.id, choice, refund, what),
      { ok: true, choice, refundJpy: refund, refundStatus: refund > 0 ? "PENDING" : "NONE" },
      what,
    );
    await assertCancelled(booking, earlier + refund, postedAt, what);
    assert.deepEqual(refundCalls.slice(callsBefore), refund > 0 ? [refundCall(booking, refund)] : [], `${what}: Square`);
    assert.deepEqual(await queuedFor(booking), receipt(booking, refund), `${what}: the queue`);
  }
});

test("a replay of a signed confirm refunds once", async () => {
  await setTiers(TIERS);

  // One signed body, sent again within the envelope's five minutes: the envelope has no nonce, so the cancel guard is
  // what stops it. The second is also tried after Square failed, which leaves the refund row to the cron.
  const SEQUENTIAL: [string, (body: RefundBody) => Response, Choice, number, string][] = [
    ["a full refund", refundAs("PENDING"), "full", 9000, "PENDING"],
    ["a tier refund Square failed", squareDown, "tier", 3600, "RETRY"],
  ];
  for (const [what, answer, choice, amount, refundStatus] of SEQUENTIAL) {
    answerRefund = answer;
    const booking = await confirmed(10, 9000);
    const body = JSON.stringify(envelope(SECRET, confirmPayload(booking.id, choice, amount)));
    const callsBefore = refundCalls.length;

    assert.deepEqual(await answerOf(await post(body), what), { ok: true, choice, refundJpy: amount, refundStatus }, what);
    const afterFirst = await stored();
    for (const time of ["second", "third"]) {
      const label = `${what}, ${time} time`;
      assert.deepEqual(await answerOf(await post(body), label), { ok: false, reason: "ALREADY_CANCELLED" }, label);
    }
    assert.deepEqual(refundCalls.slice(callsBefore), [refundCall(booking, amount)], `${what}: calls to Square`);
    assert.deepEqual(await stored(), afterFirst, `${what}: a replay changed D1`);
    assert.equal((await cancelRefundsOf(booking.id)).length, 1, `${what}: refund rows`);
    assert.deepEqual(await queuedFor(booking), receipt(booking, amount), `${what}: the queue`);
  }

  // The same body six times at once: one cancels and refunds, and the rest are turned away. A loser is told the booking
  // is already cancelled, or, if its quote read the booking before the winner's batch and the refunds after Square
  // answered, that the quote changed; either way it refunds nothing.
  answerRefund = refundAs("PENDING");
  const booking = await confirmed(10, 9000);
  const body = JSON.stringify(envelope(SECRET, confirmPayload(booking.id, "tier", 3600)));
  const callsBefore = refundCalls.length;
  const answers = await Promise.all(Array.from({ length: 6 }, (_, index) => post(body).then((res) => answerOf(res, `burst ${index}`))));
  const won = answers.filter(({ ok }) => ok === true);
  assert.deepEqual(won, [{ ok: true, choice: "tier", refundJpy: 3600, refundStatus: "PENDING" }], JSON.stringify(answers));
  const lost = answers.filter(({ ok }) => ok !== true);
  assert.equal(lost.length, 5, JSON.stringify(answers));
  for (const answer of lost) {
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.ok(answer.reason === "ALREADY_CANCELLED" || answer.reason === "QUOTE_CHANGED", JSON.stringify(answer));
  }
  assert.deepEqual(refundCalls.slice(callsBefore), [refundCall(booking, 3600)], "the burst: calls to Square");
  assert.equal((await cancelRefundsOf(booking.id)).length, 1, "the burst: refund rows");
  assert.deepEqual(await queuedFor(booking), receipt(booking, 3600), "the burst: the queue");
  assert.equal((await bookingNow(booking.id)).status, "CANCELLED");
});

test("unsigned, tampered and stale requests get 401 and never reach Square", async () => {
  await setTiers(TIERS);
  const booking = await confirmed(10, 9000);
  const before = await stored();
  const PAYLOAD = confirmPayload(booking.id, "full", 9000);
  const good = () => envelope(SECRET, PAYLOAD);
  const flipped = (sig: string) => `${sig[0] === "0" ? "1" : "0"}${sig.slice(1)}`;
  const without = (field: "ts" | "payload" | "sig") => {
    const { [field]: _dropped, ...rest } = good();
    return JSON.stringify(rest);
  };
  // A real choice at its real amount, so the swap would cancel had it got through.
  const forged = JSON.stringify(confirmPayload(booking.id, "tier", 3600));

  const REFUSED: [string, () => string][] = [
    ["no body", () => ""],
    ["not JSON", () => "{not json"],
    ["JSON null", () => "null"],
    ["a JSON array", () => "[]"],
    ["a payload with no envelope", () => JSON.stringify(PAYLOAD)],
    ["no sig", () => without("sig")],
    ["no ts", () => without("ts")],
    ["no payload", () => without("payload")],
    ["an empty sig", () => JSON.stringify({ ...good(), sig: "" })],
    ["ts as text", () => JSON.stringify({ ...good(), ts: String(Date.now()) })],
    ["the payload as an object", () => JSON.stringify({ ...good(), payload: PAYLOAD })],
    ["signed with another secret", () => JSON.stringify(envelope("another-secret", PAYLOAD))],
    ["signed with the default test secret", () => JSON.stringify(envelope(testVars.PUBLISH_SECRET, PAYLOAD))],
    ["signed with the mail secret", () => JSON.stringify(envelope(testVars.MAIL_SECRET, PAYLOAD))],
    ["signed with the cancel-link secret", () => JSON.stringify(envelope(testVars.CANCEL_LINK_SECRET, PAYLOAD))],
    ["the amount changed after signing", () => JSON.stringify({ ...good(), payload: forged })],
    ["ts changed after signing", () => JSON.stringify({ ...good(), ts: Date.now() + 1000 })],
    ["one sig character changed", () => JSON.stringify({ ...good(), sig: flipped(good().sig) })],
    ["a cut-off sig", () => JSON.stringify({ ...good(), sig: good().sig.slice(0, 32) })],
    ["a replay six minutes on", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - 6 * MINUTE_MS))],
    ["stale by a day", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - DAY_MS))],
    ["ten minutes in the future", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() + 10 * MINUTE_MS))],
  ];
  for (const [name, body] of REFUSED) {
    const res = await post(body());
    const text = await res.text();
    assert.equal(res.status, 401, `${name}: ${brief(text)}`);
    assert.deepEqual(JSON.parse(text), { error: "unauthorized" }, name);
  }
  assert.deepEqual(await stored(), before, "a refused request changed D1");
  assert.deepEqual(refundCalls, [], "a refused request called Square");

  // The same payload signed with the right secret gets through, so what turned those down was the signature check.
  assert.deepEqual(await confirm(booking.id, "full", 9000, "signed"), {
    ok: true,
    choice: "full",
    refundJpy: 9000,
    refundStatus: "PENDING",
  });
  assert.deepEqual(refundCalls, [refundCall(booking, 9000)]);
});

test("a body over 64 KB gets 413 and an empty PUBLISH_SECRET gets 500, before D1 or Square", async () => {
  await setTiers(TIERS);
  const booking = await confirmed(10, 9000);
  const before = await stored();

  /**
   * A good confirm envelope of exactly `bytes`, padded with JSON whitespace after it, which the signature does not cover
   * and JSON.parse skips, so the payload stays one any route would take.
   */
  const sized = (target: BookingRow, bytes: number): string => {
    const signed = JSON.stringify(envelope(SECRET, confirmPayload(target.id, "full", 9000)));
    const text = `${signed}${" ".repeat(bytes - Buffer.byteLength(signed))}`;
    assert.equal(Buffer.byteLength(text), bytes);
    return text;
  };

  const SENDS: [string, (body: string) => Promise<Response>][] = [
    ["as a string", (body) => post(body)],
    ["with a Content-Length", postWithLength],
  ];
  // Signed, so only the limit can refuse them, and one byte over 64 KiB, the larger reading of 64 KB.
  const BODIES: [string, string][] = [
    ["a signed confirm one byte past 64 KiB", sized(booking, 65_537)],
    ["a signed confirm of 100,000 bytes", sized(booking, 100_000)],
    ["junk", "x".repeat(70_000)],
  ];
  for (const [name, body] of BODIES) {
    for (const [how, send] of SENDS) {
      const label = `${name} ${how}`;
      const res = await send(body);
      const text = await res.text();
      assert.equal(res.status, 413, `${label}: ${brief(text)}`);
      assertPlainWords(text, label);
    }
  }
  assert.deepEqual(await stored(), before, "a large request changed D1");
  assert.deepEqual(refundCalls, [], "a large request called Square");

  // 64,000 bytes is within the limit on either reading, and it cancels.
  for (const [how, send] of SENDS) {
    const within = await confirmed(10, 9000);
    const answer = await answerOf(await send(sized(within, 64_000)), `64,000 bytes ${how}`);
    assert.deepEqual(answer, { ok: true, choice: "full", refundJpy: 9000, refundStatus: "PENDING" }, how);
  }
  assert.equal(refundCalls.length, 2, "the requests within the limit");
  refundCalls.length = 0;

  // A Worker with no secret refuses everyone, even a body signed with the key anyone can compute for it.
  const CASES: [string, string | undefined][] = [
    ["empty", ""],
    ["unset", undefined],
  ];
  for (const [name, secret] of CASES) {
    const lonely = await startWorker({ vars: { PUBLISH_SECRET: secret, SQUARE_ACCESS_TOKEN: ACCESS_TOKEN }, outbound });
    try {
      await seedConfig(lonely.db);
      await seedTiers(lonely.db, TIERS);
      const start_at = Date.now() + 10 * DAY_MS;
      const target = await seedBooking(lonely.db, {
        start_at,
        end_at: start_at + 8 * HOUR_MS,
        paid_jpy: 9000,
        payment_id: "sq-pay-lonely",
        guest_family_name: "Yamada",
        guest_given_name: "Hanako",
      });
      const lonelyBefore = await stored(lonely.db);
      for (const key of ["", "undefined"]) {
        const PAYLOADS: [string, unknown][] = [
          ["quote", quotePayload(target.id)],
          ["confirm", confirmPayload(target.id, "full", 9000)],
        ];
        for (const [what, payload] of PAYLOADS) {
          const label = `${name}, signed with ${JSON.stringify(key)}, ${what}`;
          const res = await post(JSON.stringify(envelope(key, payload)), lonely);
          const text = await res.text();
          assert.equal(res.status, 500, `${label}: ${brief(text)}`);
          // Plain words staff can read, carrying no booking and nothing of the crypto that refused the key.
          assertPlainWords(text, label);
          assert.doesNotMatch(text, /Hanako|DataError|HMAC|importKey|key length/i, label);
        }
      }
      assert.deepEqual(await stored(lonely.db), lonelyBefore, `${name}: D1 changed`);
    } finally {
      await lonely.stop();
    }
  }
  assert.deepEqual(refundCalls, [], "a Worker with no secret called Square");
});

test("a payload without a bookingId or with a malformed confirm answers 400 and changes nothing", async () => {
  await setTiers(TIERS);
  // 10 days before, 9000 paid: tier 3600, full 9000, none 0, so every amount below that is a number is a real one.
  const booking = await confirmed(10, 9000);
  const id = booking.id;
  const withConfirm = (confirm: unknown) => ({ requestedBy: REQUESTED_BY, bookingId: id, confirm });

  // Not in the shape the payload is: 400 in plain words.
  const MALFORMED: [string, unknown][] = [
    ["a number", 42],
    ["a string", id],
    ["null", null],
    ["an array", [quotePayload(id)]],
    ["no bookingId", { requestedBy: REQUESTED_BY }],
    ["no bookingId with a confirm", { requestedBy: REQUESTED_BY, confirm: { choice: "full", refundJpy: 9000 } }],
    ["a null bookingId", { requestedBy: REQUESTED_BY, bookingId: null }],
    ["a bookingId of a number", { requestedBy: REQUESTED_BY, bookingId: 42, confirm: { choice: "none", refundJpy: 0 } }],
    ["a bookingId in an array", { requestedBy: REQUESTED_BY, bookingId: [id], confirm: { choice: "none", refundJpy: 0 } }],
    ["a bookingId in an object", { requestedBy: REQUESTED_BY, bookingId: { id }, confirm: { choice: "none", refundJpy: 0 } }],
    ["a confirm of a string", withConfirm("full")],
    ["a confirm of a number", withConfirm(9000)],
    ["a confirm of true", withConfirm(true)],
    ["a confirm of an array", withConfirm(["full", 9000])],
    ["an empty confirm", withConfirm({})],
    ["a confirm with no refundJpy", withConfirm({ choice: "full" })],
    ["a confirm with no choice", withConfirm({ refundJpy: 9000 })],
    ["a refundJpy of text", withConfirm({ choice: "full", refundJpy: "9000" })],
    ["a null refundJpy", withConfirm({ choice: "none", refundJpy: null })],
    ["a choice of a number", withConfirm({ choice: 1, refundJpy: 9000 })],
    ["a null choice", withConfirm({ choice: null, refundJpy: 0 })],
  ];
  // The right types with values no choice gives: refused, as a 400 or as BAD_CHOICE, either way before anything moves.
  const UNCHOOSABLE: [string, unknown][] = [
    ["a choice that is none of the three", withConfirm({ choice: "partial", refundJpy: 9000 })],
    ["a choice in capitals", withConfirm({ choice: "FULL", refundJpy: 9000 })],
    ["a fraction of a yen", withConfirm({ choice: "full", refundJpy: 9000.5 })],
    ["a negative amount", withConfirm({ choice: "full", refundJpy: -9000 })],
    ["an amount past a safe integer", withConfirm({ choice: "full", refundJpy: 1e21 })],
  ];
  const before = await stored();

  for (const [name, payload] of MALFORMED) {
    const res = await signedPost(payload);
    const text = await res.text();
    assert.equal(res.status, 400, `${name}: ${res.status} ${brief(text)}`);
    assertPlainWords(text, name);
  }
  for (const [name, payload] of UNCHOOSABLE) {
    const res = await signedPost(payload);
    const text = await res.text();
    if (res.status === 400) assertPlainWords(text, name);
    else {
      assert.equal(res.status, 200, `${name}: ${res.status} ${brief(text)}`);
      assert.deepEqual(JSON.parse(text), { ok: false, reason: "BAD_CHOICE" }, name);
    }
  }
  assert.deepEqual(await stored(), before, "a malformed payload changed D1");
  assert.deepEqual(refundCalls, [], "a malformed payload called Square");

  // The same booking, asked properly, is quoted and cancelled.
  assertQuote(await quote(id, "a proper quote"), booking, {
    daysBefore: 10,
    refundPercent: 40,
    refundedJpy: 0,
    amounts: { tier: 3600, full: 9000, none: 0 },
  }, "a proper quote");
  assert.deepEqual(await confirm(id, "full", 9000, "a proper confirm"), {
    ok: true,
    choice: "full",
    refundJpy: 9000,
    refundStatus: "PENDING",
  });
  assert.deepEqual(refundCalls, [refundCall(booking, 9000)]);
});
