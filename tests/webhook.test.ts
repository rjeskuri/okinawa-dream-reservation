// handleSquareEvent, src/lib/square/webhook-handler.ts, on a real D1 with Square faked at the SquareClient seam, the one thing
// here that is external. Events follow Square's documented shape, with the fields a real one carries beside the ones the
// handler reads. What the rows hold, what waits in the outbox and what went back to Square as a refund are the outcomes; the
// outbox is read back through drainOutbox and renderEmail, as the cron reads it. Expected values are literals, worked out by
// hand, or come from node:crypto, never from the code under test. cancelBooking and retryRefunds (#35) run as they are, to
// show that a webhook which beats cancelBooking's answer leaves the cancellation's refund settled.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - handleSquareEvent's deps also carry `square`, as markConfirmed's ctx does: a payment for a booking that lost its bike goes
//   back through markConfirmed's refund, which has no other way to Square.
// - A new event of a handled type (payment.created, payment.updated, refund.created, refund.updated) answers 'processed', even
//   when it changes nothing. 'ignored' is for every other type and for anything that is not an event object.
// - A COMPLETED payment that names a booking goes to markConfirmed whatever the booking's status, which is what sends a lost
//   payment back. A payment with no reference, or one that names no web booking, is the shop's own sale and stays where it is.
// - FAILED or CANCELED moves only a PAYMENT_PENDING row, to ON_HOLD with updated_at = now, keeping guest, attempt and expiry.
// - (Ruling, 2026-11-03, for the owner to confirm in the PR) ...and only when the payment is the row's current attempt's, judged by time:
//   Date.parse(payment.created_at) >= the row's updated_at, which confirmHold set when it started that attempt. An earlier
//   attempt's late failure, or a payment with no created_at or one that does not parse, changes nothing, and the row waits
//   for confirmHold's own answer or the resolver (#41). Strict, no tolerance. The envelope's created_at and the payment's
//   updated_at say nothing about which attempt it was: an earlier attempt's payment can change late.
// - A refund belongs to the booking whose payment_id is the refund's payment_id, and to no other. markConfirmed's send-backs of
//   payments that never confirmed anything are no booking's refund, so a later cancellation quote does not count them.
// - A webhook refund that no row knows by square_refund_id is the cancellation's own when the booking has a cancel row with no
//   square_refund_id yet and the same amount. Square refunds exactly what the cancellation asked, so another amount is a
//   Dashboard refund, and a cancel row that already has its id is never taken over.
// - A Dashboard row has idempotency_key NULL, the amount of amount_money, and created_at = updated_at = now.
// - A refund in COMPLETED, REJECTED or FAILED stays there when a PENDING event arrives late: Square does not promise order.
// - An event whose handling throws is not kept as seen: the handler rejects, the route answers 5xx, and Square's redelivery is
//   handled. Two deliveries of one event at once are handled once.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { LOCALES, type Locale } from "../src/lib/locale.ts";
import { renderEmail } from "../src/lib/mail/templates.ts";
import { drainOutbox, type EmailPayload } from "../src/lib/outbox.ts";
import type {
  CreatePaymentInput,
  PaymentResult,
  RefundPaymentInput,
  RefundResult,
  SquareClient,
  SquareRecord,
} from "../src/lib/square/client.ts";
import { createTestDb } from "./helpers/d1.ts";
import {
  insertRow,
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedTiers,
  seedType,
  type BookingRow,
  type TierRow,
} from "./helpers/seed.ts";

/** Loaded at each call, so a test's fixtures run first, a bad fixture shows first, and each test fails on this module alone. */
const webhookModule = () => import("../src/lib/square/webhook-handler.ts");
type Webhook = Awaited<ReturnType<typeof webhookModule>>;
const handleSquareEvent: Webhook["handleSquareEvent"] = async (...args) => (await webhookModule()).handleSquareEvent(...args);

const cancelModule = () => import("../src/lib/booking/cancel.ts");
const confirmModule = () => import("../src/lib/booking/confirm.ts");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SITE_URL = "https://ride.okinawa-dream.example";
const STAFF_EMAIL = "front-desk@okinawa-dream.example";
const CANCEL_SECRET = `cancel-secret-${randomUUID()}`;

/** Square's cap on an idempotency key. */
const MAX_KEY_LENGTH = 45;

function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

const NOW = jst("2030-06-01 12:00");

/** Nine JST days after NOW, so 50% under TIERS. */
const HALF_BACK_PICKUP = jst("2030-06-10 09:00");

const TIERS: TierRow[] = [
  { min_days_before: 14, refund_percent: 100 },
  { min_days_before: 7, refund_percent: 50 },
  { min_days_before: 0, refund_percent: 0 },
];

type Guest = { familyName: string; givenName: string; email: string; phone: string };

const HANAKO: Guest = { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.jp", phone: "090-8686-3535" };
const MINHO: Guest = { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929" };
const NA: Guest = { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000" };
const ADA: Guest = { familyName: "Zanzibarova", givenName: "Quillette", email: "q.z@example.com", phone: "+1 415 555 0134" };

type Stay = {
  modelNames: Record<Locale, string>;
  packageNames: Record<Locale, string>;
  priceJpy: number;
  depositJpy: number;
  /** The deposit as written by hand, so the mail's own formatting cannot be the expected value. */
  depositDigits: string;
  /** Half the deposit, worked out by hand: what a cancellation at HALF_BACK_PICKUP gives back. */
  halfBackJpy: number;
  pickup: string;
  dropoff: string;
};

type Published = Stay & { modelId: string; packageId: string };

const FIRST: Stay = {
  modelNames: { ja: "沖縄カブ 110", en: "Okinawa Cub 110", "zh-cn": "冲绳小狼 110", ko: "오키나와 커브 110" },
  packageNames: { ja: "三日間ツーリング", en: "Three day ride", "zh-cn": "三日骑行", ko: "사흘 라이드" },
  priceJpy: 18_700,
  depositJpy: 7_300,
  depositDigits: "7,300",
  halfBackJpy: 3_650,
  pickup: "2030-06-15 08:30",
  dropoff: "2030-06-17 17:45",
};

const SECOND: Stay = {
  modelNames: { ja: "琉球フォルツァ 250", en: "Ryukyu Forza 250", "zh-cn": "琉球佛沙 250", ko: "류큐 포르자 250" },
  packageNames: { ja: "一週間の旅", en: "Week away", "zh-cn": "一周之旅", ko: "일주일 여행" },
  priceJpy: 64_250,
  depositJpy: 12_500,
  depositDigits: "12,500",
  halfBackJpy: 6_250,
  pickup: "2030-08-01 00:45",
  dropoff: "2030-08-08 07:20",
};

type Shop = { db: D1Database; first: Published; second: Published };

function textsOf(names: Record<Locale, string>, more: Record<string, string> = {}): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, { name: names[locale], ...more }])));
}

async function publish(db: D1Database, stay: Stay): Promise<Published> {
  const rate = await seedRateClass(db);
  const model = await seedModel(db, {
    rate_class_id: rate.id,
    texts: textsOf(stay.modelNames, { summary: "A summary", description: "A description" }),
  });
  const pack = await seedPackage(db, { texts: textsOf(stay.packageNames) });
  await seedPrice(db, { rate_class_id: rate.id, package_id: pack.id, price_jpy: stay.priceJpy });
  return { ...stay, modelId: model.id, packageId: pack.id };
}

async function withShop(run: (shop: Shop) => Promise<void>): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedType(db, { deposit_jpy: 33_000 });
    await seedConfig(db, { shop_open: "09:00", shop_close: "18:00" });
    await seedCatalogMeta(db);
    await seedTiers(db, TIERS);
    await run({ db, first: await publish(db, FIRST), second: await publish(db, SECOND) });
  } finally {
    await dispose();
  }
}

function guestColumns(guest: Guest): Partial<BookingRow> {
  return {
    guest_family_name: guest.familyName,
    guest_given_name: guest.givenName,
    guest_email: guest.email,
    guest_phone: guest.phone,
  };
}

/** A web booking of `stay`, a hold by default, with a UUID as createHold makes one. Its bike is its own. */
function seedWeb(db: D1Database, stay: Published, row: Partial<BookingRow> = {}): Promise<BookingRow> {
  return seedBooking(db, {
    id: randomUUID(),
    status: "ON_HOLD",
    model_id: stay.modelId,
    package_id: stay.packageId,
    start_at: jst(stay.pickup),
    end_at: jst(stay.dropoff),
    expires_at: NOW + 10 * MINUTE_MS,
    price_jpy: stay.priceJpy,
    deposit_jpy: stay.depositJpy,
    locale: "en",
    guest_family_name: null,
    guest_given_name: null,
    guest_email: null,
    guest_phone: null,
    created_at: NOW - 5 * MINUTE_MS,
    updated_at: NOW - 5 * MINUTE_MS,
    ...row,
  });
}

/** A hold whose charge went out and has not been answered, as confirmHold leaves it. */
function pendingRow(guest: Guest, locale: Locale, attempt = 1): Partial<BookingRow> {
  return { status: "PAYMENT_PENDING", payment_attempt: attempt, locale, ...guestColumns(guest) };
}

/** A booking its deposit confirmed a day ago, still standing or since cancelled by the guest. */
function paidRow(stay: Stay, guest: Guest, paymentId: string, status: "CONFIRMED" | "CANCELLED"): Partial<BookingRow> {
  const cancelled = status === "CANCELLED" ? { cancelled_at: NOW - HOUR_MS, cancel_reason: "guest" } : {};
  return {
    status,
    payment_attempt: 1,
    payment_id: paymentId,
    paid_jpy: stay.depositJpy,
    confirmed_at: NOW - DAY_MS,
    updated_at: NOW - DAY_MS,
    ...guestColumns(guest),
    ...cancelled,
  };
}

/** A staff block from the sheet: no guest of ours and nothing paid. */
function blockRow(): Partial<BookingRow> {
  return {
    source: "block",
    status: "CONFIRMED",
    external_ref: `ota-${randomUUID()}`,
    expires_at: null,
    price_jpy: null,
    deposit_jpy: null,
    locale: null,
  };
}

type Json = Record<string, unknown>;

/**
 * `createdAt` is the payment's own created_at: epoch ms, a raw string sent as it is, or null for none at all. Left out, it is
 * PAYMENT_CREATED_AT. `tipJpy` goes into total_money and approved_money beside amount_money, which is the deposit, so a
 * handler that reads another field than amount_money decides otherwise.
 */
type PaymentFacts = {
  id: string;
  status: string;
  amount: number;
  currency?: string;
  reference_id?: string;
  createdAt?: number | string | null;
  tipJpy?: number;
};

/** Two seconds before NOW, after every row seeded here started its attempt (seedWeb's updated_at is NOW - 5 min). */
const PAYMENT_CREATED_AT = NOW - 2_000;
type RefundFacts = { id: string; status: string; amount: number; payment_id: string; currency?: string };

/** What Square holds of each payment an event here has named, for a handler that asks Square again. */
const squarePayments = new Map<string, SquareRecord>();

const MERCHANT_ID = "MLQ8EXAMPLEOKINAWA";
const LOCATION_ID = "L8EXAMPLEOKINAWA";

function eventOf(type: string, dataType: string, id: string, object: Json): Json {
  return {
    merchant_id: MERCHANT_ID,
    type,
    event_id: randomUUID(),
    created_at: "2030-06-01T03:00:01.123Z",
    data: { type: dataType, id, object },
  };
}

function newPaymentId(): string {
  return `sq-pay-${randomUUID()}`;
}

function newRefundId(): string {
  return `sq-refund-${randomUUID()}`;
}

/** A payment event as Square sends one, with a new event_id each time. */
function paymentEvent(type: string, facts: PaymentFacts): Json {
  const money = { amount: facts.amount, currency: facts.currency ?? "JPY" };
  const tip = facts.tipJpy ?? 0;
  const total = { amount: facts.amount + tip, currency: money.currency };
  const reference = facts.reference_id === undefined ? {} : { reference_id: facts.reference_id };
  const created = facts.createdAt === undefined ? PAYMENT_CREATED_AT : facts.createdAt;
  const createdAt = created === null ? {} : { created_at: typeof created === "number" ? new Date(created).toISOString() : created };
  squarePayments.set(facts.id, {
    id: facts.id,
    status: facts.status,
    amount: money.amount,
    currency: money.currency,
    ...reference,
    ...createdAt,
  });
  // The payment's updated_at, like the envelope's created_at, is a second after NOW whatever the payment's age.
  const payment: Json = {
    id: facts.id,
    ...createdAt,
    updated_at: "2030-06-01T03:00:01.000Z",
    amount_money: money,
    ...(tip === 0 ? {} : { tip_money: { amount: tip, currency: money.currency } }),
    total_money: total,
    approved_money: total,
    status: facts.status,
    delay_duration: "PT168H",
    source_type: "CARD",
    card_details: { status: facts.status === "COMPLETED" ? "CAPTURED" : "FAILED", card: { card_brand: "VISA", last_4: "1111" } },
    location_id: LOCATION_ID,
    order_id: `order-${randomUUID()}`,
    ...reference,
    version: 4,
  };
  return eventOf(type, "payment", facts.id, { payment });
}

/** A refund event as Square sends one, with a new event_id each time. */
function refundEvent(type: string, facts: RefundFacts): Json {
  const refund: Json = {
    id: facts.id,
    status: facts.status,
    amount_money: { amount: facts.amount, currency: facts.currency ?? "JPY" },
    payment_id: facts.payment_id,
    order_id: `order-${randomUUID()}`,
    location_id: LOCATION_ID,
    reason: "Requested by the guest",
    destination_type: "CARD",
    created_at: "2030-06-01T03:00:00.000Z",
    updated_at: "2030-06-01T03:00:02.000Z",
    version: 2,
  };
  return eventOf(type, "refund", facts.id, { refund });
}

type FakeSquare = SquareClient & { refunds: RefundPaymentInput[]; charges: CreatePaymentInput[] };

function pendingRefund(input: RefundPaymentInput): RefundResult {
  return {
    kind: "ok",
    refund: { id: newRefundId(), status: "PENDING", amount: input.amountJpy, currency: "JPY", payment_id: input.paymentId },
  };
}

type Charge = (input: CreatePaymentInput, nth: number) => PaymentResult | Promise<PaymentResult>;

const NO_CHARGE: Charge = () => ({ kind: "error", code: "NOT_FAKED", detail: "a webhook charges nothing" });

/** Records every refund and charge asked of it. A refund is on its way by default, and a charge is refused. */
function fakeSquare(
  answer: (input: RefundPaymentInput) => RefundResult | Promise<RefundResult> = pendingRefund,
  charge: Charge = NO_CHARGE,
): FakeSquare {
  const refunds: RefundPaymentInput[] = [];
  const charges: CreatePaymentInput[] = [];
  return {
    refunds,
    charges,
    async createPayment(input) {
      charges.push(input);
      return charge(input, charges.length);
    },
    async getPayment(id) {
      const payment = squarePayments.get(id);
      return payment === undefined ? { kind: "error", code: "NOT_FOUND", detail: id } : { kind: "ok", payment };
    },
    async listPayments() {
      return { kind: "error", code: "NOT_FAKED", detail: "listPayments" };
    },
    async listRefunds() {
      return { kind: "error", code: "NOT_FAKED", detail: "listRefunds" };
    },
    async refundPayment(input) {
      refunds.push(input);
      return answer(input);
    },
  };
}

function depsAt(db: D1Database, square: SquareClient, now: number) {
  return { db, now, siteUrl: SITE_URL, cancelSecret: CANCEL_SECRET, staffEmail: STAFF_EMAIL, square };
}

async function stored(db: D1Database, id: string): Promise<BookingRow> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `no booking ${id}`);
  return row;
}

type RefundRow = {
  id: string;
  booking_id: string;
  square_refund_id: string | null;
  amount_jpy: number;
  status: string;
  origin: string;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
};

function seedRefund(db: D1Database, row: RefundRow): Promise<RefundRow> {
  return insertRow<RefundRow>(db, "refunds", row);
}

/** By id, the order SQLite and JavaScript agree on for these ids. */
async function refundsOf(db: D1Database, bookingId: string): Promise<RefundRow[]> {
  const sql = "SELECT * FROM refunds WHERE booking_id = ?1 ORDER BY id";
  return (await db.prepare(sql).bind(bookingId).all<RefundRow>()).results;
}

function byId(rows: RefundRow[]): RefundRow[] {
  return rows.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Every outbox key that names the booking, delivered or not, so a repeat counts as much as one still waiting. */
async function keysFor(db: D1Database, bookingId: string): Promise<string[]> {
  const sql = "SELECT dedupe_key FROM outbox WHERE instr(dedupe_key, ?1) > 0 ORDER BY dedupe_key";
  const { results } = await db.prepare(sql).bind(bookingId).all<{ dedupe_key: string }>();
  return results.map(({ dedupe_key }) => dedupe_key);
}

/** The keys of the confirm path's three items, as #34 writes them. */
function confirmationKeys(id: string): string[] {
  return [`email:guest_confirmation:${id}`, `email:staff_new_booking:${id}`, `sheet:${id}:CONFIRMED`];
}

/** Everything a webhook that changes nothing must leave alone. */
async function everything(db: D1Database): Promise<unknown[]> {
  const rows = async (sql: string) => (await db.prepare(sql).all()).results;
  return [
    await rows("SELECT * FROM bookings ORDER BY id"),
    await rows("SELECT * FROM refunds ORDER BY id"),
    await rows("SELECT * FROM outbox ORDER BY id"),
  ];
}

async function assertSheetItem(db: D1Database, bookingId: string, status: string, label = status): Promise<void> {
  const key = `sheet:${bookingId}:refund:${status}`;
  const row = await db
    .prepare("SELECT kind, payload FROM outbox WHERE dedupe_key = ?1")
    .bind(key)
    .first<{ kind: string; payload: string }>();
  assert.ok(row, `${label}: no ${key} in the outbox`);
  assert.equal(row.kind, "sheet_booking", label);
  assert.deepEqual(JSON.parse(row.payload), { bookingId }, label);
}

/** A refund of this payment in full, under a key Square accepts and #35's cancel refund of the booking does not use. */
function assertRefund(
  refund: RefundPaymentInput | undefined,
  bookingId: string,
  paymentId: string,
  amountJpy: number,
  label: string,
): void {
  assert.ok(refund, `${label}: no refund`);
  assert.equal(refund.paymentId, paymentId, label);
  assert.equal(refund.amountJpy, amountJpy, label);
  assert.ok(refund.reason.length > 0, `${label}: a refund with no reason`);
  assert.ok(refund.idempotencyKey.length > 0, `${label}: an empty key`);
  assert.ok(refund.idempotencyKey.length <= MAX_KEY_LENGTH, `${label}: the key ${refund.idempotencyKey}`);
  assert.notEqual(refund.idempotencyKey, `rf:${bookingId}`, `${label}: the cancel refund's key`);
}

/** What the cron would deliver next, which also leaves the outbox with nothing waiting. */
async function drain(db: D1Database, at: number): Promise<{ emails: EmailPayload[]; sheets: string[] }> {
  const emails: EmailPayload[] = [];
  const sheets: string[] = [];
  await drainOutbox({
    db,
    now: at + DAY_MS,
    limit: 100,
    sendEmail: async (payload) => {
      emails.push(payload);
      return { ok: true };
    },
    syncBookings: async (ids) => {
      sheets.push(...ids);
      return { ok: true };
    },
  });
  return { emails, sheets };
}

function cancelUrlFor(locale: Locale, id: string): string {
  const token = createHmac("sha256", CANCEL_SECRET).update(`cancel:${id}`).digest("base64url").slice(0, 32);
  return `${SITE_URL}/${locale}/booking/cancel?b=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
}

/** Money as the emails write it, with a bare ¥ kept from a Chinese reader. */
const MONEY: Record<Locale, (digits: string) => string> = {
  ja: (digits) => `¥${digits}`,
  en: (digits) => `¥${digits}`,
  "zh-cn": (digits) => `${digits}日元`,
  ko: (digits) => `${digits}엔`,
};

const MISSING_VALUE = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|\{\w+\}/;

function renderWhole(email: EmailPayload, label: string): string {
  const { subject, text, html } = renderEmail(email);
  for (const part of [subject, text, html]) assert.doesNotMatch(part, MISSING_VALUE, `${label}: a missing value\n${part}`);
  return text;
}

function assertShows(text: string, pieces: string[], label: string): void {
  for (const piece of pieces) assert.ok(text.includes(piece), `${label}: no ${piece} in\n${text}`);
}

function emailOf(emails: EmailPayload[], template: EmailPayload["template"]): EmailPayload {
  const found = emails.filter((email) => email.template === template);
  assert.equal(found.length, 1, `${found.length} ${template} in ${emails.map((email) => email.template).join(", ")}`);
  return found[0] as EmailPayload;
}

/** The confirm path's items for this booking, read as the cron reads them, which leaves the outbox with nothing waiting. */
async function assertConfirmationItems(
  db: D1Database,
  stay: Stay,
  row: BookingRow,
  guest: Guest,
  locale: Locale,
  at: number,
): Promise<void> {
  const { emails, sheets } = await drain(db, at);
  assert.deepEqual(sheets, [row.id]);
  assert.equal(emails.length, 2, emails.map(({ template }) => template).join(", "));

  const guestMail = emailOf(emails, "guest_confirmation");
  const label = `guest_confirmation in ${locale}`;
  assert.equal(guestMail.to, guest.email, label);
  assert.equal(guestMail.locale, locale, label);
  assertShows(
    renderWhole(guestMail, label),
    [
      row.ref,
      guest.familyName,
      guest.givenName,
      stay.modelNames[locale],
      stay.packageNames[locale],
      `${stay.pickup} JST`,
      MONEY[locale](stay.depositDigits),
      cancelUrlFor(locale, row.id),
    ],
    label,
  );

  const staffMail = emailOf(emails, "staff_new_booking");
  assert.equal(staffMail.to, STAFF_EMAIL, "staff_new_booking");
  assert.equal(staffMail.locale, "ja", "staff_new_booking");
  assertShows(
    renderWhole(staffMail, "staff_new_booking"),
    [row.ref, stay.modelNames.ja, MONEY.ja(stay.depositDigits), row.vehicle_plate, guest.email, guest.phone],
    "staff_new_booking",
  );
}

/**
 * `db`, where every write to the outbox fails as a missing table does and everything else goes through. A D1 batch is one
 * transaction, so whatever shares a batch with that write is undone with it. `wrote` says an outbox write was prepared.
 */
function failOutboxWrites(db: D1Database): { db: D1Database; wrote: () => boolean } {
  const intoOutbox = /(\bINTO\s+["`[]?)outbox\b/gi;
  let wrote = false;
  const failing = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property !== "prepare") return value.bind(target);
      return (sql: string) => {
        if (!sql.match(intoOutbox)) return value.call(target, sql);
        wrote = true;
        return value.call(target, sql.replace(intoOutbox, "$1outbox_unreachable"));
      };
    },
  });
  return { db: failing, wrote: () => wrote };
}

test("completed payments confirm pending bookings once", async () => {
  await withShop(async ({ db, first, second }) => {
    // [stay, guest, locale, attempt, event type, tip]. The deposit is amount_money; Square's total_money adds any tip, and a
    // total that is not the deposit must not decide.
    const cases: [Published, Guest, Locale, number, string, number][] = [
      [first, HANAKO, "ja", 1, "payment.updated", 500],
      [first, MINHO, "ko", 3, "payment.created", 0],
      [second, NA, "zh-cn", 1, "payment.created", 1_200],
      [second, ADA, "en", 2, "payment.updated", 300],
    ];
    for (const [index, [stay, guest, locale, attempt, type, tipJpy]] of cases.entries()) {
      const label = `${type} for ${guest.email} in ${locale}`;
      const pending = await seedWeb(db, stay, pendingRow(guest, locale, attempt));
      const square = fakeSquare();
      const at = NOW + (index + 1) * MINUTE_MS;
      const payment: PaymentFacts = {
        id: newPaymentId(),
        status: "COMPLETED",
        amount: stay.depositJpy,
        reference_id: pending.id,
        tipJpy,
      };

      // Square tells of the payment before it completes: the charge is still out, and nothing moves.
      for (const status of ["APPROVED", "PENDING"]) {
        const early = paymentEvent("payment.created", { ...payment, status });
        assert.equal(await handleSquareEvent(depsAt(db, square, at - 1), early), "processed", `${label}: ${status}`);
        assert.deepEqual(await stored(db, pending.id), pending, `${label}: ${status}`);
      }
      assert.deepEqual(await keysFor(db, pending.id), [], label);

      assert.equal(await handleSquareEvent(depsAt(db, square, at), paymentEvent(type, payment)), "processed", label);

      const confirmed = await stored(db, pending.id);
      assert.deepEqual(
        confirmed,
        { ...pending, status: "CONFIRMED", payment_id: payment.id, paid_jpy: stay.depositJpy, confirmed_at: at, updated_at: at },
        label,
      );
      assert.deepEqual(await keysFor(db, pending.id), confirmationKeys(pending.id), label);

      // Square's other event about the same payment, and a later one: each is a new event, and still one confirmation.
      const other = type === "payment.created" ? "payment.updated" : "payment.created";
      for (const [later, when] of [
        [other, at + MINUTE_MS],
        [type, at + DAY_MS],
      ] as const) {
        const context = `${label}, then ${later}`;
        assert.equal(await handleSquareEvent(depsAt(db, square, when), paymentEvent(later, payment)), "processed", context);
        assert.deepEqual(await stored(db, pending.id), confirmed, context);
        assert.deepEqual(await keysFor(db, pending.id), confirmationKeys(pending.id), context);
      }
      assert.deepEqual(square.refunds, [], `${label}: a good payment went back`);
      assert.deepEqual(square.charges, [], label);

      await assertConfirmationItems(db, stay, confirmed, guest, locale, at);
    }
  });
});

test("failed payments return pending bookings to ON_HOLD", async () => {
  await withShop(async ({ db, first, second }) => {
    // [status, event type, stay, attempt, the hold's expiry, yen off the deposit, ms from the attempt's start to the payment's
    // creation]. A payment that failed took nothing, so its amount does not matter, and a hold whose charge outlived it comes
    // back with its own expiry, passed or not. Every payment here was created once its attempt had started, so it is that
    // attempt's: a late one from an earlier attempt has a test of its own below.
    const cases: [string, string, Published, number, number, number, number][] = [
      ["FAILED", "payment.updated", first, 1, NOW + 4 * MINUTE_MS, 0, 1_000],
      ["CANCELED", "payment.updated", second, 2, NOW + 9 * MINUTE_MS, 0, 4 * MINUTE_MS],
      ["FAILED", "payment.created", second, 1, NOW - HOUR_MS, 0, 2],
      ["CANCELED", "payment.created", first, 5, NOW + MINUTE_MS, 900, 90_000],
      ["FAILED", "payment.updated", first, 1, NOW + MINUTE_MS, -1, 30_000],
    ];
    for (const [index, [status, type, stay, attempt, expires_at, off, after]] of cases.entries()) {
      const label = `${type} ${status}, attempt ${attempt}`;
      const pending = await seedWeb(db, stay, { ...pendingRow(MINHO, "ko", attempt), expires_at });
      const square = fakeSquare();
      const at = NOW + index * MINUTE_MS;
      const event = paymentEvent(type, {
        id: newPaymentId(),
        status,
        amount: stay.depositJpy + off,
        reference_id: pending.id,
        createdAt: pending.updated_at + after,
      });

      assert.equal(await handleSquareEvent(depsAt(db, square, at), event), "processed", label);

      // The guest, the attempt and the expiry stay, so the guest can pay again on the same hold while it lasts.
      assert.deepEqual(await stored(db, pending.id), { ...pending, status: "ON_HOLD", updated_at: at }, label);
      assert.deepEqual(square.refunds, [], `${label}: a refund of money never taken`);
      assert.deepEqual(await keysFor(db, pending.id), [], label);
    }

    // A booking no longer waiting on a charge is not a failed payment's to move.
    const others: [string, () => Partial<BookingRow>][] = [
      ["on hold", () => ({ status: "ON_HOLD", payment_attempt: 1, ...guestColumns(HANAKO) })],
      ["expired", () => ({ status: "EXPIRED", payment_attempt: 1, ...guestColumns(HANAKO) })],
      ["confirmed", () => paidRow(first, HANAKO, newPaymentId(), "CONFIRMED")],
      ["cancelled", () => paidRow(first, HANAKO, newPaymentId(), "CANCELLED")],
      ["a staff block", blockRow],
    ];
    for (const [label, row] of others) {
      for (const status of ["FAILED", "CANCELED"]) {
        const context = `${status} on a booking ${label}`;
        const booking = await seedWeb(db, first, row());
        const square = fakeSquare();
        const before = await everything(db);
        const event = paymentEvent("payment.updated", { id: newPaymentId(), status, amount: first.depositJpy, reference_id: booking.id });

        assert.equal(await handleSquareEvent(depsAt(db, square, NOW), event), "processed", context);

        assert.deepEqual(await everything(db), before, context);
        assert.deepEqual(square.refunds, [], context);
      }
    }

    // A declined card at the counter names no booking of ours.
    for (const reference of [undefined, `counter-${randomUUID()}`, ""]) {
      const square = fakeSquare();
      const before = await everything(db);
      const event = paymentEvent("payment.updated", { id: newPaymentId(), status: "FAILED", amount: 2_200, reference_id: reference });
      assert.equal(await handleSquareEvent(depsAt(db, square, NOW), event), "processed", `a reference of ${reference}`);
      assert.deepEqual(await everything(db), before, `a reference of ${reference}`);
      assert.deepEqual(square.refunds, []);
    }
  });
});

test("a late failure from an earlier attempt leaves the current attempt pending", async () => {
  await withShop(async ({ db, first, second }) => {
    // When confirmHold took each row here to PAYMENT_PENDING for its current attempt. The envelope (NOW + 1.123 s) and the
    // payment's updated_at (NOW + 1 s) come after it in every event, so only the payment's created_at tells the attempts apart.
    const STARTED = NOW - 30_000;
    const pendingFor = (stay: Published, attempt: number) =>
      seedWeb(db, stay, { ...pendingRow(MINHO, "ko", attempt), updated_at: STARTED });

    // [what, the payment's created_at]: before the attempt started, or no time at all to judge it by.
    const notThisAttempt: [string, number | string | null][] = [
      ["a millisecond before the attempt started", STARTED - 1],
      ["a minute before", STARTED - MINUTE_MS],
      ["a day before", STARTED - DAY_MS],
      ["no created_at", null],
      ["an empty created_at", ""],
      ["a created_at that is no date", "not-a-date"],
      ["a created_at out of range", "2030-13-45T99:00:00Z"],
    ];
    for (const [stayIndex, stay] of [first, second].entries()) {
      const pending = await pendingFor(stay, 2);
      const square = fakeSquare();
      for (const [label, createdAt] of notThisAttempt) {
        for (const status of ["FAILED", "CANCELED"]) {
          for (const type of ["payment.created", "payment.updated"]) {
            const context = `${type} ${status}, ${label}`;
            const before = await everything(db);
            const event = paymentEvent(type, { id: newPaymentId(), status, amount: stay.depositJpy, reference_id: pending.id, createdAt });

            assert.equal(await handleSquareEvent(depsAt(db, square, NOW + MINUTE_MS), event), "processed", context);

            assert.deepEqual(await everything(db), before, `${context}: something changed`);
          }
        }
      }
      // Still the current attempt's: PAYMENT_PENDING, its guest, attempt and time untouched, nothing queued, nothing sent back.
      assert.deepEqual(await stored(db, pending.id), pending);
      assert.deepEqual(await keysFor(db, pending.id), []);
      assert.deepEqual(square.refunds, []);

      // The current attempt's own payment completes and confirms it.
      const at = NOW + (2 + stayIndex) * MINUTE_MS;
      const current: PaymentFacts = {
        id: newPaymentId(),
        status: "COMPLETED",
        amount: stay.depositJpy,
        reference_id: pending.id,
        createdAt: STARTED + 2_000,
      };
      assert.equal(await handleSquareEvent(depsAt(db, square, at), paymentEvent("payment.updated", current)), "processed");
      const confirmed = await stored(db, pending.id);
      assert.deepEqual(confirmed, {
        ...pending,
        status: "CONFIRMED",
        payment_id: current.id,
        paid_jpy: stay.depositJpy,
        confirmed_at: at,
        updated_at: at,
      });
      assert.deepEqual(await keysFor(db, pending.id), confirmationKeys(pending.id));
      assert.deepEqual(square.refunds, []);
      await assertConfirmationItems(db, stay, confirmed, MINHO, "ko", at);
    }

    // From the moment the attempt started, a failure is that attempt's: the same millisecond releases it, as does any later.
    const thisAttempt: [string, number, string, string][] = [
      ["created as the attempt started", 0, "FAILED", "payment.updated"],
      ["created as the attempt started", 0, "CANCELED", "payment.created"],
      ["created a millisecond after", 1, "CANCELED", "payment.updated"],
      ["created a millisecond after", 1, "FAILED", "payment.created"],
      ["created 45 s after", 45_000, "FAILED", "payment.created"],
    ];
    for (const [index, [label, after, status, type]] of thisAttempt.entries()) {
      const context = `${type} ${status}, ${label}`;
      const stay = index % 2 === 0 ? first : second;
      const pending = await pendingFor(stay, 1);
      const square = fakeSquare();
      const at = NOW + index * MINUTE_MS;
      const event = paymentEvent(type, {
        id: newPaymentId(),
        status,
        amount: stay.depositJpy,
        reference_id: pending.id,
        createdAt: STARTED + after,
      });

      assert.equal(await handleSquareEvent(depsAt(db, square, at), event), "processed", context);

      assert.deepEqual(await stored(db, pending.id), { ...pending, status: "ON_HOLD", updated_at: at }, context);
      assert.deepEqual(await keysFor(db, pending.id), [], context);
      assert.deepEqual(square.refunds, [], context);
    }

    // The case the rule is for, through confirmHold: attempt 1 is declined, the guest pays again, and attempt 1's FAILED lands
    // while attempt 2's charge is out. The guest is charged once, confirmed, and nothing goes back.
    const { confirmHold } = await confirmModule();
    const hold = await seedWeb(db, second);
    const firstTry = NOW;
    const secondTry = NOW + 2 * MINUTE_MS;
    let clock = firstTry;
    const declinedId = newPaymentId();
    const paidId = newPaymentId();
    const square = fakeSquare(pendingRefund, async (input, nth) => {
      if (nth === 1) return { kind: "declined", code: "GENERIC_DECLINE", detail: "Authorization error" };
      const late = paymentEvent("payment.updated", {
        id: declinedId,
        status: "FAILED",
        amount: input.amountJpy,
        reference_id: input.referenceId,
        createdAt: firstTry + 400,
      });
      assert.equal(await handleSquareEvent(depsAt(db, square, secondTry + 500), late), "processed", "the late FAILED");
      assert.equal((await stored(db, hold.id)).status, "PAYMENT_PENDING", "the late FAILED took the new charge's hold");
      return {
        kind: "ok",
        payment: { id: paidId, status: "COMPLETED", amount: input.amountJpy, currency: "JPY", reference_id: input.referenceId },
      };
    });
    const deps = { db, now: () => clock, square, siteUrl: SITE_URL, cancelSecret: CANCEL_SECRET, staffEmail: STAFF_EMAIL };
    const body = { sourceId: `cnon:${randomUUID()}`, guest: HANAKO, locale: "ja" as const };

    const declined = await confirmHold(deps, hold.id, body);
    assert.equal(declined.ok, false, JSON.stringify(declined));
    clock = secondTry;
    const paid = await confirmHold(deps, hold.id, { ...body, sourceId: `cnon:${randomUUID()}` });

    assert.ok(paid.ok, JSON.stringify(paid));
    assert.equal(square.charges.length, 2);
    assert.deepEqual(square.refunds, [], "the guest's good payment went back");
    const row = await stored(db, hold.id);
    assert.equal(row.status, "CONFIRMED");
    assert.equal(row.payment_id, paidId);
    assert.equal(row.payment_attempt, 2);
    assert.equal(row.paid_jpy, second.depositJpy);
  });
});

test("completed payments for bookings that lost their bike go back in full", async () => {
  await withShop(async ({ db, first, second }) => {
    for (const stay of [first, second]) {
      const lost: [string, () => Partial<BookingRow>][] = [
        ["expired", () => ({ status: "EXPIRED", payment_attempt: 1, ...guestColumns(HANAKO) })],
        ["back on hold", () => ({ status: "ON_HOLD", payment_attempt: 1, ...guestColumns(HANAKO) })],
        ["cancelled", () => paidRow(stay, NA, newPaymentId(), "CANCELLED")],
        ["confirmed by another payment", () => paidRow(stay, NA, newPaymentId(), "CONFIRMED")],
      ];
      for (const [label, row] of lost) {
        // In full is what the payment took, which need not be the deposit.
        for (const amount of [stay.depositJpy, stay.depositJpy + 900]) {
          const context = `${label}, ${amount} JPY`;
          const booking = await seedWeb(db, stay, row());
          const square = fakeSquare();
          const paymentId = newPaymentId();
          const event = paymentEvent("payment.updated", { id: paymentId, status: "COMPLETED", amount, reference_id: booking.id });

          assert.equal(await handleSquareEvent(depsAt(db, square, NOW), event), "processed", context);

          assert.equal(square.refunds.length, 1, context);
          assertRefund(square.refunds[0], booking.id, paymentId, amount, context);
          assert.deepEqual(await stored(db, booking.id), booking, context);
          assert.deepEqual(await keysFor(db, booking.id), [], context);
        }
      }

      // The wrong money on a pending booking goes back too, and the hold returns for the guest to pay again.
      const wrong: [number, string][] = [
        [stay.depositJpy - 1, "JPY"],
        [stay.depositJpy + 900, "JPY"],
        [stay.depositJpy, "USD"],
      ];
      for (const [amount, currency] of wrong) {
        const context = `a pending booking paid ${amount} ${currency}`;
        const pending = await seedWeb(db, stay, pendingRow(HANAKO, "ja"));
        const square = fakeSquare();
        const paymentId = newPaymentId();
        const at = NOW + MINUTE_MS;
        const event = paymentEvent("payment.updated", { id: paymentId, status: "COMPLETED", amount, currency, reference_id: pending.id });

        assert.equal(await handleSquareEvent(depsAt(db, square, at), event), "processed", context);

        assert.equal(square.refunds.length, 1, context);
        assertRefund(square.refunds[0], pending.id, paymentId, amount, context);
        assert.deepEqual(await stored(db, pending.id), { ...pending, status: "ON_HOLD", updated_at: at }, context);
        assert.deepEqual(await keysFor(db, pending.id), [], context);
      }

      // A cancelled booking's own payment, told of again: #35 settled it under the sheet's tier, so nothing more goes back.
      const settledId = newPaymentId();
      const cancelled = await seedWeb(db, stay, paidRow(stay, MINHO, settledId, "CANCELLED"));
      const square = fakeSquare();
      for (const type of ["payment.updated", "payment.created"]) {
        const event = paymentEvent(type, { id: settledId, status: "COMPLETED", amount: stay.depositJpy, reference_id: cancelled.id });
        assert.equal(await handleSquareEvent(depsAt(db, square, NOW), event), "processed", type);
      }
      assert.deepEqual(square.refunds, [], "the cancelled booking's own payment went back");
      assert.deepEqual(await stored(db, cancelled.id), cancelled);
    }

    // Money that is no web booking's stays with the shop: a sale at the counter has no reference, or one of its own.
    const block = await seedWeb(db, first, blockRow());
    const strangers: [string, string | undefined][] = [
      ["no reference", undefined],
      ["an empty reference", ""],
      ["a reference of the shop's own", `counter-${randomUUID()}`],
      ["a staff block", block.id],
    ];
    for (const [label, reference] of strangers) {
      const square = fakeSquare();
      const before = await everything(db);
      const event = paymentEvent("payment.updated", { id: newPaymentId(), status: "COMPLETED", amount: 4_400, reference_id: reference });

      assert.equal(await handleSquareEvent(depsAt(db, square, NOW), event), "processed", label);

      assert.deepEqual(square.refunds, [], `${label}: the shop's own money went back`);
      assert.deepEqual(await everything(db), before, label);
    }
  });
});

test("refund updates change refund status", async () => {
  await withShop(async ({ db, first, second }) => {
    // [stay, the row's origin, event type, Square's status]
    const cases: [Published, string, string, string][] = [
      [first, "cancel", "refund.updated", "COMPLETED"],
      [second, "cancel", "refund.updated", "REJECTED"],
      [first, "cancel", "refund.updated", "FAILED"],
      [second, "dashboard", "refund.updated", "COMPLETED"],
      [first, "dashboard", "refund.created", "FAILED"],
      [second, "cancel", "refund.created", "COMPLETED"],
    ];
    for (const [index, [stay, origin, type, status]] of cases.entries()) {
      const label = `a ${origin} refund, ${type} ${status}`;
      const paymentId = newPaymentId();
      const booking = await seedWeb(db, stay, paidRow(stay, HANAKO, paymentId, "CANCELLED"));
      const squareRefundId = newRefundId();
      const target = await seedRefund(db, {
        id: randomUUID(),
        booking_id: booking.id,
        square_refund_id: squareRefundId,
        amount_jpy: stay.halfBackJpy,
        status: "PENDING",
        origin,
        idempotency_key: origin === "cancel" ? `rf:${booking.id}` : null,
        created_at: NOW - HOUR_MS,
        updated_at: NOW - HOUR_MS,
      });
      // Another refund of the same payment, which this event is not about.
      const bystander = await seedRefund(db, {
        id: randomUUID(),
        booking_id: booking.id,
        square_refund_id: newRefundId(),
        amount_jpy: 1_000,
        status: "PENDING",
        origin: "dashboard",
        idempotency_key: null,
        created_at: NOW - 2 * HOUR_MS,
        updated_at: NOW - 2 * HOUR_MS,
      });
      const square = fakeSquare();
      const at = NOW + index * MINUTE_MS;
      const facts = { id: squareRefundId, amount: target.amount_jpy, payment_id: paymentId };

      assert.equal(await handleSquareEvent(depsAt(db, square, at), refundEvent(type, { ...facts, status })), "processed", label);

      assert.deepEqual(await refundsOf(db, booking.id), byId([{ ...target, status, updated_at: at }, bystander]), label);
      assert.deepEqual(await stored(db, booking.id), booking, label);
      assert.deepEqual(await keysFor(db, booking.id), [`sheet:${booking.id}:refund:${status}`], label);
      await assertSheetItem(db, booking.id, status, label);
      assert.deepEqual(square.refunds, [], label);

      // Square does not promise order: a PENDING that arrives late leaves a refund that has settled as it settled.
      const late = refundEvent("refund.created", { ...facts, status: "PENDING" });
      assert.equal(await handleSquareEvent(depsAt(db, square, at + MINUTE_MS), late), "processed", `${label}, then PENDING`);
      const rows = await refundsOf(db, booking.id);
      assert.equal(rows.length, 2, `${label}, then PENDING`);
      assert.equal(rows.find(({ id }) => id === target.id)?.status, status, `${label}, then PENDING`);
    }
  });
});

test("dashboard refunds are recorded", async () => {
  await withShop(async ({ db, first, second }) => {
    // Staff give part of a deposit back from the Dashboard, on a booking that stands.
    const paymentId = newPaymentId();
    const booking = await seedWeb(db, first, paidRow(first, ADA, paymentId, "CONFIRMED"));
    const square = fakeSquare();
    const refundId = newRefundId();
    const at = NOW + MINUTE_MS;

    const created = refundEvent("refund.created", { id: refundId, status: "PENDING", amount: 2_000, payment_id: paymentId });
    assert.equal(await handleSquareEvent(depsAt(db, square, at), created), "processed");

    const [row, ...more] = await refundsOf(db, booking.id);
    assert.deepEqual(more, [], "one refund, one row");
    assert.ok(row, "the Dashboard refund was not recorded");
    assert.ok(typeof row.id === "string" && row.id.length > 0, `the row's id ${row.id}`);
    assert.deepEqual(row, {
      id: row.id,
      booking_id: booking.id,
      square_refund_id: refundId,
      amount_jpy: 2_000,
      status: "PENDING",
      origin: "dashboard",
      idempotency_key: null,
      created_at: at,
      updated_at: at,
    });
    await assertSheetItem(db, booking.id, "PENDING");

    // Square's word that it completed moves that row, and no other row appears.
    const later = at + 5 * MINUTE_MS;
    const updated = refundEvent("refund.updated", { id: refundId, status: "COMPLETED", amount: 2_000, payment_id: paymentId });
    assert.equal(await handleSquareEvent(depsAt(db, square, later), updated), "processed");
    assert.deepEqual(await refundsOf(db, booking.id), [{ ...row, status: "COMPLETED", updated_at: later }]);
    await assertSheetItem(db, booking.id, "COMPLETED");
    assert.deepEqual(await stored(db, booking.id), booking);

    // A cancelled booking whose own refund has settled is topped up for the same amount, and Square's first word of it is an
    // update. The cancellation's row already has its id, so the top-up is a row of its own.
    const cancelledPayment = newPaymentId();
    const cancelled = await seedWeb(db, second, paidRow(second, NA, cancelledPayment, "CANCELLED"));
    const own = await seedRefund(db, {
      id: randomUUID(),
      booking_id: cancelled.id,
      square_refund_id: newRefundId(),
      amount_jpy: second.halfBackJpy,
      status: "COMPLETED",
      origin: "cancel",
      idempotency_key: `rf:${cancelled.id}`,
      created_at: NOW - DAY_MS,
      updated_at: NOW - DAY_MS,
    });
    const topUpId = newRefundId();
    const topUpAt = NOW + 2 * MINUTE_MS;
    const topUp = refundEvent("refund.updated", {
      id: topUpId,
      status: "COMPLETED",
      amount: second.halfBackJpy,
      payment_id: cancelledPayment,
    });
    assert.equal(await handleSquareEvent(depsAt(db, square, topUpAt), topUp), "processed");

    const rows = await refundsOf(db, cancelled.id);
    assert.equal(rows.length, 2, "the top-up took over the cancellation's row");
    assert.deepEqual(
      rows.find(({ id }) => id === own.id),
      own,
      "the cancellation's own refund",
    );
    const added = rows.find(({ id }) => id !== own.id);
    assert.deepEqual(added, {
      id: added?.id,
      booking_id: cancelled.id,
      square_refund_id: topUpId,
      amount_jpy: second.halfBackJpy,
      status: "COMPLETED",
      origin: "dashboard",
      idempotency_key: null,
      created_at: topUpAt,
      updated_at: topUpAt,
    });
    await assertSheetItem(db, cancelled.id, "COMPLETED");

    // A payment that confirmed nothing goes back through markConfirmed. Its refund is not the booking's, which another payment
    // confirmed, or a later cancellation would count it against the tier.
    const standing = await seedWeb(db, first, paidRow(first, HANAKO, newPaymentId(), "CONFIRMED"));
    const sendBack = fakeSquare();
    const strayId = newPaymentId();
    const stray = paymentEvent("payment.updated", { id: strayId, status: "COMPLETED", amount: first.depositJpy, reference_id: standing.id });
    assert.equal(await handleSquareEvent(depsAt(db, sendBack, NOW), stray), "processed");
    assert.equal(sendBack.refunds.length, 1, "the stray payment did not go back");
    const strayRefund = refundEvent("refund.created", {
      id: newRefundId(),
      status: "PENDING",
      amount: first.depositJpy,
      payment_id: strayId,
    });
    assert.equal(await handleSquareEvent(depsAt(db, square, NOW + MINUTE_MS), strayRefund), "processed");
    assert.deepEqual(await refundsOf(db, standing.id), [], "a send-back recorded as the booking's refund");

    // A refund of a payment no booking holds, a sale at the counter, is not the site's to record.
    const before = await everything(db);
    for (const type of ["refund.created", "refund.updated"]) {
      const counter = refundEvent(type, { id: newRefundId(), status: "COMPLETED", amount: 3_300, payment_id: newPaymentId() });
      assert.equal(await handleSquareEvent(depsAt(db, square, NOW), counter), "processed", type);
    }
    assert.deepEqual(await everything(db), before);
    assert.deepEqual(square.refunds, []);
  });
});

test("a refund event that beats cancelBooking's answer settles the cancellation's own row", async () => {
  await withShop(async ({ db, first, second }) => {
    const { cancelBooking, retryRefunds } = await cancelModule();
    // A failure below has to be the handler's, not a module that does not load inside the fake.
    await webhookModule();
    const cancelDeps = (square: SquareClient, now: number) => ({ db, square, now, staffEmail: STAFF_EMAIL, siteUrl: SITE_URL });
    const halfBack = (stay: Published, guest: Guest, paymentId: string) =>
      seedWeb(db, stay, { ...paidRow(stay, guest, paymentId, "CONFIRMED"), start_at: HALF_BACK_PICKUP, end_at: HALF_BACK_PICKUP + 2 * DAY_MS });

    // What Square answers cancelBooking once refund.created has already landed.
    const answers: [string, (made: SquareRecord) => RefundResult][] = [
      ["then Square answers PENDING", (made) => ({ kind: "ok", refund: made })],
      ["then Square answers COMPLETED", (made) => ({ kind: "ok", refund: { ...made, status: "COMPLETED" } })],
      ["then Square's answer is lost", () => ({ kind: "unknown", detail: "no answer within 15000 ms" })],
    ];
    for (const [index, [label, answer]] of answers.entries()) {
      const stay = index % 2 === 0 ? first : second;
      const paymentId = newPaymentId();
      const booking = await halfBack(stay, HANAKO, paymentId);
      const squareRefundId = newRefundId();
      const delivered: string[] = [];
      const square = fakeSquare(async (input) => {
        const made: SquareRecord = {
          id: squareRefundId,
          status: "PENDING",
          amount: input.amountJpy,
          currency: "JPY",
          payment_id: input.paymentId,
        };
        // Square has made the refund, and its refund.created lands before this answer does.
        const event = refundEvent("refund.created", { id: squareRefundId, status: "PENDING", amount: input.amountJpy, payment_id: input.paymentId });
        delivered.push(await handleSquareEvent(depsAt(db, fakeSquare(), NOW + 1_000), event));
        return answer(made);
      });

      const result = await cancelBooking(cancelDeps(square, NOW), booking.id);

      assert.ok(result.ok, `${label}: ${JSON.stringify(result)}`);
      assert.deepEqual(delivered, ["processed"], label);
      assert.equal(square.refunds.length, 1, label);
      assert.equal(square.refunds[0]?.amountJpy, stay.halfBackJpy, label);
      const [row, ...more] = await refundsOf(db, booking.id);
      assert.deepEqual(more, [], `${label}: a second row for one refund`);
      assert.ok(row, `${label}: no refund row`);
      assert.partialDeepStrictEqual(
        row,
        {
          booking_id: booking.id,
          square_refund_id: squareRefundId,
          amount_jpy: stay.halfBackJpy,
          origin: "cancel",
          idempotency_key: `rf:${booking.id}`,
        },
        label,
      );
      assert.ok(["PENDING", "COMPLETED"].includes(row.status), `${label}: the row is ${row.status}`);
      await assertSheetItem(db, booking.id, "PENDING", label);

      // The retry has nothing of this booking's left to send.
      const retrySquare = fakeSquare();
      await retryRefunds({ db, square: retrySquare, now: NOW + HOUR_MS, staffEmail: STAFF_EMAIL }, 100);
      assert.deepEqual(
        retrySquare.refunds.filter((sent) => sent.paymentId === paymentId),
        [],
        `${label}: the refund was sent again`,
      );

      // Square's word that it completed moves the same row.
      const done = NOW + 2 * HOUR_MS;
      const completed = refundEvent("refund.updated", { id: squareRefundId, status: "COMPLETED", amount: stay.halfBackJpy, payment_id: paymentId });
      assert.equal(await handleSquareEvent(depsAt(db, fakeSquare(), done), completed), "processed", label);
      const settled = (await refundsOf(db, booking.id)).map(({ square_refund_id, origin, status }) => ({ square_refund_id, origin, status }));
      assert.deepEqual(settled, [{ square_refund_id: squareRefundId, origin: "cancel", status: "COMPLETED" }], label);
      await assertSheetItem(db, booking.id, "COMPLETED", label);
    }

    // A refund staff make in the Dashboard while the cancellation's own still waits is the Dashboard's: another amount, so
    // another refund, and the cancellation's row keeps waiting for its own.
    const paymentId = newPaymentId();
    const booking = await halfBack(first, MINHO, paymentId);
    const silent = fakeSquare(() => ({ kind: "unknown", detail: "no answer within 15000 ms" }));
    const cancelled = await cancelBooking(cancelDeps(silent, NOW), booking.id);
    assert.deepEqual(cancelled, { ok: true, refundJpy: first.halfBackJpy, refundStatus: "RETRY" });

    const dashboardId = newRefundId();
    const dashboard = refundEvent("refund.created", { id: dashboardId, status: "COMPLETED", amount: 1_000, payment_id: paymentId });
    assert.equal(await handleSquareEvent(depsAt(db, fakeSquare(), NOW + MINUTE_MS), dashboard), "processed");

    const rows = await refundsOf(db, booking.id);
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.partialDeepStrictEqual(rows.find(({ origin }) => origin === "cancel"), {
      status: "RETRY",
      square_refund_id: null,
      amount_jpy: first.halfBackJpy,
      idempotency_key: `rf:${booking.id}`,
    });
    assert.partialDeepStrictEqual(rows.find(({ origin }) => origin === "dashboard"), {
      square_refund_id: dashboardId,
      amount_jpy: 1_000,
      status: "COMPLETED",
      idempotency_key: null,
    });

    // The cancellation's retry then settles its own row under its own id.
    const retry = fakeSquare((input) => ({
      kind: "ok",
      refund: { id: `sq-refund-${input.idempotencyKey}`, status: "COMPLETED", amount: input.amountJpy, currency: "JPY", payment_id: input.paymentId },
    }));
    await retryRefunds({ db, square: retry, now: NOW + HOUR_MS, staffEmail: STAFF_EMAIL }, 100);
    const after = await refundsOf(db, booking.id);
    assert.equal(after.length, 2, JSON.stringify(after));
    assert.partialDeepStrictEqual(after.find(({ origin }) => origin === "cancel"), {
      status: "COMPLETED",
      square_refund_id: `sq-refund-rf:${booking.id}`,
    });
    assert.partialDeepStrictEqual(after.find(({ origin }) => origin === "dashboard"), { square_refund_id: dashboardId });
  });
});

test("duplicate events are processed once", async () => {
  await withShop(async ({ db, first, second }) => {
    // A completed payment for a hold that expired: every pass through it would send it back again.
    const lapsed = await seedWeb(db, first, { status: "EXPIRED", payment_attempt: 1, ...guestColumns(HANAKO) });
    const square = fakeSquare();
    const payment: PaymentFacts = { id: newPaymentId(), status: "COMPLETED", amount: first.depositJpy, reference_id: lapsed.id };
    const event = paymentEvent("payment.updated", payment);

    // Square sends the same event again, the same text, whenever it missed the 200.
    const results: string[] = [];
    for (const at of [NOW, NOW + MINUTE_MS, NOW + DAY_MS]) {
      results.push(await handleSquareEvent(depsAt(db, square, at), structuredClone(event)));
    }

    assert.deepEqual(results, ["processed", "duplicate", "duplicate"]);
    assert.equal(square.refunds.length, 1);
    assertRefund(square.refunds[0], lapsed.id, payment.id, payment.amount, "the first delivery");
    const seen = await db.prepare("SELECT * FROM webhook_events WHERE event_id = ?1").bind(event.event_id as string).all();
    assert.deepEqual(seen.results, [{ event_id: event.event_id, type: "payment.updated", received_at: NOW }]);

    // A failed payment sent again after the guest has paid again: the repeat must not take the new charge's hold.
    const pending = await seedWeb(db, second, pendingRow(MINHO, "ko"));
    // The payment was created a second after its attempt started, so it is that attempt's and releases it.
    const failedPayment: PaymentFacts = {
      id: newPaymentId(),
      status: "FAILED",
      amount: second.depositJpy,
      reference_id: pending.id,
      createdAt: pending.updated_at + 1_000,
    };
    const failed = paymentEvent("payment.updated", failedPayment);
    assert.equal(await handleSquareEvent(depsAt(db, square, NOW), failed), "processed");
    assert.equal((await stored(db, pending.id)).status, "ON_HOLD");
    // The guest's second try, as confirmHold starts one: after that payment was created.
    await db
      .prepare("UPDATE bookings SET status = 'PAYMENT_PENDING', payment_attempt = payment_attempt + 1, updated_at = ?2 WHERE id = ?1")
      .bind(pending.id, NOW + MINUTE_MS)
      .run();
    const retrying = await stored(db, pending.id);
    assert.equal(await handleSquareEvent(depsAt(db, square, NOW + 2 * MINUTE_MS), structuredClone(failed)), "duplicate");
    assert.deepEqual(await stored(db, pending.id), retrying);
    // Told of again under an event of its own, it is still the earlier attempt's payment, and the new charge keeps its hold.
    const told = paymentEvent("payment.created", failedPayment);
    assert.equal(await handleSquareEvent(depsAt(db, square, NOW + 3 * MINUTE_MS), told), "processed");
    assert.deepEqual(await stored(db, pending.id), retrying);

    // A Dashboard refund's created event sent again after its update: one row, and it stays completed.
    const paymentId = newPaymentId();
    const confirmed = await seedWeb(db, second, paidRow(second, ADA, paymentId, "CONFIRMED"));
    const refund = { id: newRefundId(), amount: 4_000, payment_id: paymentId };
    const created = refundEvent("refund.created", { ...refund, status: "PENDING" });
    const updated = refundEvent("refund.updated", { ...refund, status: "COMPLETED" });
    const deliveries: [Json, string][] = [
      [created, "processed"],
      [updated, "processed"],
      [created, "duplicate"],
      [updated, "duplicate"],
    ];
    for (const [index, [delivery, expected]] of deliveries.entries()) {
      const result = await handleSquareEvent(depsAt(db, square, NOW + index * MINUTE_MS), structuredClone(delivery));
      assert.equal(result, expected, `delivery ${index + 1}`);
    }
    const rows = await refundsOf(db, confirmed.id);
    assert.deepEqual(
      rows.map(({ square_refund_id, status, origin }) => ({ square_refund_id, status, origin })),
      [{ square_refund_id: refund.id, status: "COMPLETED", origin: "dashboard" }],
    );

    // Two deliveries of one event at once: one of them handles it.
    const raced = await seedWeb(db, second, { status: "EXPIRED", payment_attempt: 1, ...guestColumns(NA) });
    const racedSquare = fakeSquare();
    const racedEvent = paymentEvent("payment.created", { id: newPaymentId(), status: "COMPLETED", amount: second.depositJpy, reference_id: raced.id });
    const both = await Promise.all([1, 2].map(() => handleSquareEvent(depsAt(db, racedSquare, NOW), structuredClone(racedEvent))));
    assert.deepEqual(both.toSorted(), ["duplicate", "processed"]);
    assert.equal(racedSquare.refunds.length, 1);
  });
});

test("an event that could not be handled is handled when Square sends it again", async () => {
  await withShop(async ({ db, first, second }) => {
    // A rejection below has to be the failed write's, not a module that does not load.
    await webhookModule();
    // Square sends again only what got no 200, so a handler that kept such an event as seen would drop it for good.
    const pending = await seedWeb(db, first, pendingRow(NA, "zh-cn"));
    const payment: PaymentFacts = { id: newPaymentId(), status: "COMPLETED", amount: first.depositJpy, reference_id: pending.id };
    const event = paymentEvent("payment.updated", payment);
    const square = fakeSquare();
    const failing = failOutboxWrites(db);

    await assert.rejects(handleSquareEvent(depsAt(failing.db, square, NOW), event));

    assert.ok(failing.wrote(), "nothing was written to the outbox");
    assert.deepEqual(await stored(db, pending.id), pending);
    assert.deepEqual(await keysFor(db, pending.id), []);

    const at = NOW + MINUTE_MS;
    assert.equal(await handleSquareEvent(depsAt(db, square, at), structuredClone(event)), "processed");
    const confirmed = await stored(db, pending.id);
    assert.deepEqual(confirmed, {
      ...pending,
      status: "CONFIRMED",
      payment_id: payment.id,
      paid_jpy: first.depositJpy,
      confirmed_at: at,
      updated_at: at,
    });
    assert.deepEqual(square.refunds, []);
    await assertConfirmationItems(db, first, confirmed, NA, "zh-cn", at);

    // The same for a refund's update, whose sheet item is the write that fails.
    const paymentId = newPaymentId();
    const cancelled = await seedWeb(db, second, paidRow(second, MINHO, paymentId, "CANCELLED"));
    const target = await seedRefund(db, {
      id: randomUUID(),
      booking_id: cancelled.id,
      square_refund_id: newRefundId(),
      amount_jpy: second.halfBackJpy,
      status: "PENDING",
      origin: "cancel",
      idempotency_key: `rf:${cancelled.id}`,
      created_at: NOW - HOUR_MS,
      updated_at: NOW - HOUR_MS,
    });
    const update = refundEvent("refund.updated", {
      id: target.square_refund_id as string,
      status: "COMPLETED",
      amount: target.amount_jpy,
      payment_id: paymentId,
    });
    const failingAgain = failOutboxWrites(db);

    await assert.rejects(handleSquareEvent(depsAt(failingAgain.db, square, NOW), update));

    assert.ok(failingAgain.wrote(), "nothing was written to the outbox");
    assert.equal(await handleSquareEvent(depsAt(db, square, at), structuredClone(update)), "processed");
    const [row, ...more] = await refundsOf(db, cancelled.id);
    assert.deepEqual(more, []);
    assert.ok(row && [NOW, at].includes(row.updated_at), `updated at ${row?.updated_at}`);
    assert.deepEqual(row, { ...target, status: "COMPLETED", updated_at: row.updated_at });
    await assertSheetItem(db, cancelled.id, "COMPLETED");
  });
});

test("unknown event types are ignored", async () => {
  await withShop(async ({ db, first }) => {
    const pending = await seedWeb(db, first, pendingRow(HANAKO, "ja"));
    const paymentId = newPaymentId();
    const cancelled = await seedWeb(db, first, paidRow(first, NA, paymentId, "CANCELLED"));
    const refundId = newRefundId();
    await seedRefund(db, {
      id: randomUUID(),
      booking_id: cancelled.id,
      square_refund_id: refundId,
      amount_jpy: first.halfBackJpy,
      status: "PENDING",
      origin: "cancel",
      idempotency_key: `rf:${cancelled.id}`,
      created_at: NOW - HOUR_MS,
      updated_at: NOW - HOUR_MS,
    });

    // Each carries an object a handled type would act on, so only its type keeps it out.
    const payment: PaymentFacts = { id: newPaymentId(), status: "COMPLETED", amount: first.depositJpy, reference_id: pending.id };
    const refund: RefundFacts = { id: refundId, status: "COMPLETED", amount: first.halfBackJpy, payment_id: paymentId };
    const types = [
      "dispute.created",
      "invoice.payment_made",
      "order.updated",
      "payout.paid",
      "payment.deleted",
      "refund.deleted",
      "PAYMENT.UPDATED",
      "Refund.Updated",
      "payment",
      "",
    ];
    const untyped = paymentEvent("payment.updated", payment);
    delete untyped.type;
    const events: [string, unknown][] = [
      ...types.flatMap((type): [string, unknown][] => [
        [`${type} with a payment`, paymentEvent(type, payment)],
        [`${type} with a refund`, refundEvent(type, refund)],
      ]),
      ["no type", untyped],
      ["a type that is not a string", { ...paymentEvent("payment.updated", payment), type: ["payment.updated"] }],
      ["null", null],
      ["nothing", undefined],
      ["a number", 42],
      ["a string", "payment.updated"],
      ["a list", [paymentEvent("payment.updated", payment)]],
      ["an empty object", {}],
    ];
    const square = fakeSquare();
    const before = await everything(db);

    for (const [label, event] of events) {
      assert.equal(await handleSquareEvent(depsAt(db, square, NOW), event), "ignored", label);
      assert.deepEqual(await everything(db), before, label);
    }

    assert.deepEqual(square.refunds, []);
    assert.deepEqual(square.charges, []);

    // The same payment under its own type confirms the booking, so what kept it out above was the type.
    assert.equal(await handleSquareEvent(depsAt(db, square, NOW), paymentEvent("payment.updated", payment)), "processed");
    assert.equal((await stored(db, pending.id)).status, "CONFIRMED");
  });
});
