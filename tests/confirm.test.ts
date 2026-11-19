// confirmHold and markConfirmed, src/lib/booking/confirm.ts, on a real D1 with Square faked at the SquareClient seam, the one
// thing here that is external. What goes to Square, what the row holds and what waits in the outbox are the outcomes; the
// outbox is read back through drainOutbox and renderEmail, as the cron will read it. Expected instants come from Date.parse
// on an explicit +09:00 offset and tokens from node:crypto, so no expected value passes through src/lib/time.ts,
// src/lib/booking/cancel.ts or the code under test.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - markConfirmed's ctx also carries `square`, as confirmHold's deps do, since its refund has no other way to Square.
// - markConfirmed checks the payment itself, because #36 and #41 call it with no check of their own.
// - A wrong amount or currency goes back to ON_HOLD as a decline does. Left PAYMENT_PENDING, the resolver would find the same
//   COMPLETED payment on every run and the bike would stay blocked for good. A row that moved while Square answered stays as
//   it is, and the money still goes back.
// - No refund here uses `rf:{id}`, against the ticket's outline. #35 refunds a cancellation under that key and Square answers a
//   reused key with the first refund, so a late payment and a cancel would each swallow the other's money. A 'lost' refund's
//   key follows the payment: another payment gets another key, and the same payment replayed gets the same one.
// - A confirm that finds its hold lost answers HOLD_EXPIRED, which the page reloads on. So does a cancelled booking.
// - A staff block is NOT_FOUND, as its checkout page is.
// - A COMPLETED event for the payment a CANCELLED booking still holds is 'already', with no refund: #35 settled that payment
//   under the sheet's tier. Any other payment on a booking that lost its bike is 'lost' and goes back in full.
// - markConfirmed's own revert after a mismatch touches only a row still PAYMENT_PENDING for the attempt it read.
// - markConfirmed rejects when its batch cannot be written, so #36 and #41 try again; the row stays PAYMENT_PENDING. confirmHold
//   may then reject or answer PAYMENT_UNKNOWN: either way the page says the payment is being checked, which it is.
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createHold, getBooking } from "../src/lib/booking/holds.ts";
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
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedTiers,
  seedType,
  seedVehicle,
  type BookingRow,
  type TierRow,
} from "./helpers/seed.ts";

/** Loaded at each call, so a test's fixtures run first, a bad fixture shows first, and each test fails on this module alone. */
const confirmModule = () => import("../src/lib/booking/confirm.ts");
type Confirm = Awaited<ReturnType<typeof confirmModule>>;
const confirmHold: Confirm["confirmHold"] = async (...args) => (await confirmModule()).confirmHold(...args);
const markConfirmed: Confirm["markConfirmed"] = async (...args) => (await confirmModule()).markConfirmed(...args);

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SITE_URL = "https://ride.okinawa-dream.example";
const STAFF_EMAIL = "front-desk@okinawa-dream.example";
const CANCEL_SECRET = `cancel-secret-${randomUUID()}`;

/** Square's caps, from the ticket. */
const MAX_KEY_LENGTH = 45;
const MAX_REFERENCE_LENGTH = 40;
/** Square documents payment ids of up to this length, so one cannot sit in a refund key as it stands. */
const MAX_PAYMENT_ID_LENGTH = 192;

/** What the catalog says today, which the deposit on a hold must win over. */
const CATALOG_DEPOSIT_JPY = 33_000;

function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

const NOW = jst("2030-06-01 12:00");
/** A slot a real createHold accepts at NOW. */
const OPEN_PICKUP = jst("2030-06-10 09:00");

type Guest = { familyName: string; givenName: string; email: string; phone: string };

const HANAKO: Guest = { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.jp", phone: "090-8686-3535" };
const MINHO: Guest = { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929" };
const NA: Guest = { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000" };
const ADA: Guest = { familyName: "Zanzibarova", givenName: "Quillette", email: "q.z@example.com", phone: "+1 415 555 0134" };
const GUESTS = [HANAKO, MINHO, NA, ADA, { ...ADA, email: "fifth@example.com" }];

type Stay = {
  modelNames: Record<Locale, string>;
  packageNames: Record<Locale, string>;
  priceJpy: number;
  depositJpy: number;
  /** The amounts as written by hand, so the page's own formatting cannot be the expected value. */
  priceDigits: string;
  depositDigits: string;
  pickup: string;
  dropoff: string;
};

type Published = Stay & { modelId: string; packageId: string };

/** Both pickups fall on the day before in UTC, so a missing offset prints another date. */
const FIRST: Stay = {
  modelNames: { ja: "沖縄カブ 110", en: "Okinawa Cub 110", "zh-cn": "冲绳小狼 110", ko: "오키나와 커브 110" },
  packageNames: { ja: "三日間ツーリング", en: "Three day ride", "zh-cn": "三日骑行", ko: "사흘 라이드" },
  priceJpy: 18_700,
  depositJpy: 7_300,
  priceDigits: "18,700",
  depositDigits: "7,300",
  pickup: "2030-06-15 08:30",
  dropoff: "2030-06-17 17:45",
};

const SECOND: Stay = {
  modelNames: { ja: "琉球フォルツァ 250", en: "Ryukyu Forza 250", "zh-cn": "琉球佛沙 250", ko: "류큐 포르자 250" },
  packageNames: { ja: "一週間の旅", en: "Week away", "zh-cn": "一周之旅", ko: "일주일 여행" },
  priceJpy: 64_250,
  depositJpy: 12_500,
  priceDigits: "64,250",
  depositDigits: "12,500",
  pickup: "2030-08-01 00:45",
  dropoff: "2030-08-08 07:20",
};

type Settings = { open: string; close: string; tiers: TierRow[] };

const PLAIN_SHOP: Settings = {
  open: "09:00",
  close: "18:00",
  tiers: [
    { min_days_before: 7, refund_percent: 100 },
    { min_days_before: 3, refund_percent: 50 },
    { min_days_before: 0, refund_percent: 0 },
  ],
};

const LATE_SHOP: Settings = {
  open: "10:30",
  close: "19:15",
  tiers: [
    { min_days_before: 14, refund_percent: 80 },
    { min_days_before: 2, refund_percent: 25 },
  ],
};

type Shop = { db: D1Database; first: Published; second: Published; settings: Settings };

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

async function withShop(run: (shop: Shop) => Promise<void>, settings: Settings = PLAIN_SHOP): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedType(db, { deposit_jpy: CATALOG_DEPOSIT_JPY });
    await seedConfig(db, { shop_open: settings.open, shop_close: settings.close });
    await seedCatalogMeta(db);
    await seedTiers(db, settings.tiers);
    await run({ db, settings, first: await publish(db, FIRST), second: await publish(db, SECOND) });
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

/** A hold as createHold leaves one: a UUID, no guest and ten minutes left at NOW. Its bike is its own. */
function seedHold(db: D1Database, stay: Published, row: Partial<BookingRow> = {}): Promise<BookingRow> {
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

/** A hold whose first charge went out and has not been answered. */
function pendingRow(guest: Guest, locale: Locale): Partial<BookingRow> {
  return { status: "PAYMENT_PENDING", payment_attempt: 1, locale, ...guestColumns(guest) };
}

async function stored(db: D1Database, id: string): Promise<BookingRow> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `no booking ${id}`);
  return row;
}

type FakeSquare = SquareClient & { calls: string[]; payments: CreatePaymentInput[]; refunds: RefundPaymentInput[] };

function paymentOf(input: CreatePaymentInput, part: Partial<SquareRecord> = {}): PaymentResult {
  const payment: SquareRecord = {
    id: `sq-${randomUUID()}`,
    status: "COMPLETED",
    amount: input.amountJpy,
    currency: "JPY",
    reference_id: input.referenceId,
    ...part,
  };
  return { kind: "ok", payment };
}

function refundOf(input: RefundPaymentInput): RefundResult {
  const refund: SquareRecord = {
    id: `sq-refund-${randomUUID()}`,
    status: "PENDING",
    amount: input.amountJpy,
    currency: "JPY",
    payment_id: input.paymentId,
  };
  return { kind: "ok", refund };
}

const DECLINED: PaymentResult = { kind: "declined", code: "GENERIC_DECLINE", detail: "Authorization error" };
const ERROR: PaymentResult = { kind: "error", code: "INVALID_VALUE", detail: "The nonce is expired" };
const UNKNOWN: PaymentResult = { kind: "unknown", detail: "Square answered HTTP 503" };

/** Records every call. The answers default to a payment for what was asked and a refund on its way. */
function fakeSquare(
  charge: (input: CreatePaymentInput, nth: number) => PaymentResult | Promise<PaymentResult> = (input) => paymentOf(input),
  refund: (input: RefundPaymentInput) => RefundResult | Promise<RefundResult> = refundOf,
): FakeSquare {
  const calls: string[] = [];
  const payments: CreatePaymentInput[] = [];
  const refunds: RefundPaymentInput[] = [];
  const unused = (name: string) => {
    calls.push(name);
    return { kind: "error", code: "NOT_FAKED", detail: name } as const;
  };
  return {
    calls,
    payments,
    refunds,
    async createPayment(input) {
      calls.push("createPayment");
      payments.push(input);
      return charge(input, payments.length);
    },
    async refundPayment(input) {
      calls.push("refundPayment");
      refunds.push(input);
      return refund(input);
    },
    async getPayment() {
      return unused("getPayment");
    },
    async listPayments() {
      return unused("listPayments");
    },
    async listRefunds() {
      return unused("listRefunds");
    },
  };
}

/**
 * Square's side of a refund key: its first use moves the money, whatever `firstAnswer` tells the caller, and any later use gets
 * that same refund back and moves nothing. `paidBack` names the payments that really went back, once for each refund.
 */
function refundLedger(firstAnswer?: RefundResult) {
  const refunds = new Map<string, RefundPaymentInput>();
  return {
    answer(input: RefundPaymentInput): RefundResult {
      const kept = refunds.get(input.idempotencyKey);
      if (kept !== undefined) return refundOf(kept);
      refunds.set(input.idempotencyKey, input);
      return firstAnswer ?? refundOf(input);
    },
    paidBack: () => [...refunds.values()].map(({ paymentId }) => paymentId),
  };
}

function ctxOf(square: SquareClient) {
  return { siteUrl: SITE_URL, cancelSecret: CANCEL_SECRET, staffEmail: STAFF_EMAIL, square };
}

function depsAt(db: D1Database, square: SquareClient, at: number) {
  return { db, now: () => at, ...ctxOf(square) };
}

function payBody(guest: Guest, locale: Locale) {
  return { sourceId: `cnon:${randomUUID()}`, guest, locale };
}

function paymentFor(stay: Stay) {
  return { id: `sq-${randomUUID()}`, amountJpy: stay.depositJpy, currency: "JPY", status: "COMPLETED" };
}

function reasonOf(result: { ok: true } | { ok: false; reason: string }): string {
  return result.ok ? "ok" : result.reason;
}

/** Every row, whatever became of it, so a later delivery counts as much as one still waiting. */
async function outboxSize(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM outbox").first<{ n: number }>())?.n ?? -1;
}

async function waitingKinds(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT kind FROM outbox WHERE status = 'pending' ORDER BY kind").all<{ kind: string }>();
  return results.map(({ kind }) => kind);
}

/** What the cron would deliver next, which also leaves the outbox with nothing waiting. */
async function drain(db: D1Database, at: number): Promise<{ emails: EmailPayload[]; sheets: string[] }> {
  const emails: EmailPayload[] = [];
  const sheets: string[] = [];
  await drainOutbox({
    db,
    now: at + DAY_MS,
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

function emailOf(emails: EmailPayload[], template: EmailPayload["template"]): EmailPayload {
  const found = emails.filter((email) => email.template === template);
  assert.equal(found.length, 1, `${found.length} ${template} in ${emails.map((email) => email.template).join(", ")}`);
  return found[0] as EmailPayload;
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

const SCRIPT: Record<Locale, RegExp> = {
  ja: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u,
  en: /[A-Za-z]{3}/,
  "zh-cn": /\p{Script=Han}/u,
  ko: /\p{Script=Hangul}/u,
};

const MISSING_VALUE = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|\{\w+\}/;

/** renderEmail itself, which throws on a missing number and prints a missing string. */
function renderWhole(email: EmailPayload, label: string): string {
  const { subject, text, html } = renderEmail(email);
  for (const part of [subject, text, html]) assert.doesNotMatch(part, MISSING_VALUE, `${label}: a missing value\n${part}`);
  return text;
}

function assertShows(text: string, pieces: string[], label: string): void {
  for (const piece of pieces) assert.ok(text.includes(piece), `${label}: no ${piece} in\n${text}`);
}

/** The summary of the published tiers, in the reader's language. A tier that pays nothing may be left to "after that". */
function assertPolicy(summary: unknown, tiers: TierRow[], locale: Locale, label: string): void {
  assert.equal(typeof summary, "string", `${label}: policySummary`);
  const text = summary as string;
  assert.match(text, SCRIPT[locale], `${label}: the policy is not in ${locale}: ${text}`);
  for (const tier of tiers.filter(({ refund_percent }) => refund_percent > 0)) {
    for (const number of [tier.min_days_before, tier.refund_percent]) {
      assert.match(text, new RegExp(`(?<!\\d)${number}(?!\\d)`), `${label}: no ${number} in the policy: ${text}`);
    }
  }
}

function assertGuestEmail(email: EmailPayload, stay: Stay, row: BookingRow, guest: Guest, locale: Locale, settings: Settings) {
  const label = `guest_confirmation in ${locale}`;
  assert.equal(email.to, guest.email, label);
  assert.equal(email.locale, locale, label);
  const text = renderWhole(email, label);
  assertShows(
    text,
    [
      row.ref,
      guest.familyName,
      guest.givenName,
      stay.modelNames[locale],
      stay.packageNames[locale],
      `${stay.pickup} JST`,
      `${stay.dropoff} JST`,
      MONEY[locale](stay.priceDigits),
      MONEY[locale](stay.depositDigits),
      `${settings.open}-${settings.close}`,
      cancelUrlFor(locale, row.id),
    ],
    label,
  );
  for (const other of LOCALES.filter((name) => name !== locale)) {
    assert.equal(text.includes(stay.modelNames[other]), false, `${label}: the ${other} model name in\n${text}`);
  }
  assertPolicy(email.data.policySummary, settings.tiers, locale, label);
}

function assertStaffEmail(email: EmailPayload, stay: Stay, row: BookingRow, guest: Guest) {
  const label = "staff_new_booking";
  assert.equal(email.to, STAFF_EMAIL, label);
  assert.equal(email.locale, "ja", label);
  const text = renderWhole(email, label);
  assertShows(
    text,
    [
      row.ref,
      stay.modelNames.ja,
      stay.packageNames.ja,
      `${stay.pickup} JST`,
      `${stay.dropoff} JST`,
      MONEY.ja(stay.priceDigits),
      MONEY.ja(stay.depositDigits),
      row.vehicle_plate,
      guest.familyName,
      guest.givenName,
      guest.email,
      guest.phone,
    ],
    label,
  );
  assert.equal(text.includes(stay.modelNames.en), false, `${label}: the English model name in\n${text}`);
}

/** The three items of one confirmation, which leaves the outbox with nothing waiting. */
async function assertConfirmationItems(shop: Shop, stay: Stay, row: BookingRow, guest: Guest, locale: Locale): Promise<void> {
  assert.deepEqual(await waitingKinds(shop.db), ["email", "email", "sheet_booking"]);
  const { emails, sheets } = await drain(shop.db, NOW);
  assert.equal(emails.length, 2);
  assert.deepEqual(sheets, [row.id]);
  assertGuestEmail(emailOf(emails, "guest_confirmation"), stay, row, guest, locale, shop.settings);
  assertStaffEmail(emailOf(emails, "staff_new_booking"), stay, row, guest);
}

/** No guest told, no staff told, and no sheet row. */
async function assertNothingEnqueued(db: D1Database, label: string): Promise<void> {
  assert.deepEqual(await waitingKinds(db), [], `${label}: the outbox`);
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
  assert.ok(refund.idempotencyKey.length <= MAX_KEY_LENGTH, `${label}: the key ${refund.idempotencyKey}`);
  assert.notEqual(refund.idempotencyKey, `rf:${bookingId}`, `${label}: the cancel refund's key`);
}

/**
 * `db`, with `beforeBatch` run once just before its first batch. That is the moment a resolver or a webhook lands after
 * every earlier read, which only statements that decide on the row as it stands survive. `raced` says the moment came.
 */
function raceBeforeBatch(db: D1Database, beforeBatch: () => Promise<unknown>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const racing = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property !== "batch") return value.bind(target);
      return async (...args: unknown[]) => {
        if (!raced) {
          raced = true;
          await beforeBatch();
        }
        return value.apply(target, args);
      };
    },
  });
  return { db: racing, raced: () => raced };
}

/**
 * `db`, with `beforeUpdate` run once just before its first `UPDATE bookings` goes out, alone or in a batch. Whatever was read
 * from the row before that moment is out of date by then. Other statements pass through untouched. `raced` says the moment came.
 */
function raceBeforeUpdate(db: D1Database, beforeUpdate: () => Promise<unknown>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const race = async () => {
    if (raced) return;
    raced = true;
    await beforeUpdate();
  };
  /** A batch takes real statements only, so each stand-in keeps track of its own. */
  const realOf = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const watch = (statement: D1PreparedStatement): D1PreparedStatement => {
    const watched = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property === "bind") return (...args: unknown[]) => watch(value.apply(target, args));
        return async (...args: unknown[]) => {
          await race();
          return value.apply(target, args);
        };
      },
    });
    realOf.set(watched, statement);
    return watched;
  };
  const racing = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property === "prepare") {
        return (sql: string) => {
          const statement = value.call(target, sql);
          return /\bUPDATE\s+bookings\b/i.test(sql) ? watch(statement) : statement;
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[], ...rest: unknown[]) => {
          if (statements.some((statement) => realOf.has(statement))) await race();
          return value.call(target, statements.map((statement) => realOf.get(statement) ?? statement), ...rest);
        };
      }
      return value.bind(target);
    },
  });
  return { db: racing, raced: () => raced };
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

/** Another payment of this booking's, confirmed by #36 or #41 while this one was being answered. Binds id, payment id, time. */
const CONFIRMED_BY_ANOTHER =
  "UPDATE bookings SET status = 'CONFIRMED', payment_id = ?2, paid_jpy = deposit_jpy, confirmed_at = ?3, updated_at = ?3 WHERE id = ?1";

test("a completed payment confirms and enqueues three items", async () => {
  await withShop(async (shop) => {
    const { db, first, second } = shop;
    const cases: [Published, Partial<BookingRow>, Guest, Locale][] = [
      [first, {}, HANAKO, "ja"],
      // The guest's locale wins over the hold's, for the row and for the mail.
      [first, { locale: "ja" }, MINHO, "ko"],
      [second, { locale: "ko", payment_attempt: 2 }, NA, "zh-cn"],
      [second, { payment_attempt: 9_998 }, ADA, "en"],
    ];
    for (const [index, [stay, row, guest, locale]] of cases.entries()) {
      const hold = await seedHold(db, stay, row);
      const paymentId = `sq-${randomUUID()}`;
      const square = fakeSquare((input) => paymentOf(input, { id: paymentId }));
      const at = NOW + index * MINUTE_MS;
      const body = payBody(guest, locale);
      const label = `${guest.email} in ${locale}`;

      const result = await confirmHold(depsAt(db, square, at), hold.id, body);

      assert.ok(result.ok, `${label}: ${JSON.stringify(result)}`);
      const attempt = hold.payment_attempt + 1;
      const confirmed = await stored(db, hold.id);
      assert.deepEqual(confirmed, {
        ...hold,
        ...guestColumns(guest),
        status: "CONFIRMED",
        locale,
        payment_id: paymentId,
        paid_jpy: stay.depositJpy,
        payment_attempt: attempt,
        confirmed_at: at,
        updated_at: at,
      });
      assert.deepEqual(result.booking, await getBooking(db, hold.id), label);

      assert.equal(square.payments.length, 1, label);
      const [charge] = square.payments as [CreatePaymentInput];
      assert.equal(charge.idempotencyKey, `${hold.id}:${attempt}`, label);
      assert.equal(charge.referenceId, hold.id, label);
      assert.equal(charge.sourceId, body.sourceId, label);
      assert.equal(charge.amountJpy, stay.depositJpy, label);
      assert.ok(charge.idempotencyKey.length <= MAX_KEY_LENGTH, `${label}: the key ${charge.idempotencyKey}`);
      assert.ok(charge.referenceId.length <= MAX_REFERENCE_LENGTH, `${label}: the reference ${charge.referenceId}`);
      assert.deepEqual(square.refunds, [], label);

      await assertConfirmationItems(shop, stay, confirmed, guest, locale);
    }
  });
});

test("the enqueued emails render every field in their reader's language", async () => {
  for (const settings of [PLAIN_SHOP, LATE_SHOP]) {
    await withShop(async (shop) => {
      const { db, first, second } = shop;
      for (const [stay, guest] of [[first, HANAKO], [second, NA]] as const) {
        for (const [index, locale] of LOCALES.entries()) {
          const hold = await seedHold(db, stay, { locale: LOCALES[(index + 1) % LOCALES.length] });
          const paid = await confirmHold(depsAt(db, fakeSquare(), NOW), hold.id, payBody(guest, locale));
          assert.ok(paid.ok, JSON.stringify(paid));
          await assertConfirmationItems(shop, stay, await stored(db, hold.id), guest, locale);

          // As the webhook and the resolver call it, with no request behind it: everything comes from the row.
          const pending = await seedHold(db, stay, pendingRow(guest, locale));
          const outcome = await markConfirmed(db, pending.id, paymentFor(stay), NOW, ctxOf(fakeSquare()));
          assert.equal(outcome, "confirmed");
          await assertConfirmationItems(shop, stay, await stored(db, pending.id), guest, locale);
        }
      }
    }, settings);
  }
});

test("a model off sale and a package gone from the catalog still make whole emails", async () => {
  await withShop(async ({ db, first }) => {
    // A publish can do both while a hold stands, and the guest's money is about to move.
    const rate = await seedRateClass(db);
    const retired = await seedModel(db, {
      rate_class_id: rate.id,
      active: 0,
      texts: textsOf(FIRST.modelNames, { summary: "A summary", description: "A description" }),
    });
    const stay = { ...first, modelId: retired.id, packageId: "package-gone-from-the-catalog" };
    const hold = await seedHold(db, stay);

    const result = await confirmHold(depsAt(db, fakeSquare(), NOW), hold.id, payBody(MINHO, "ko"));

    assert.ok(result.ok, JSON.stringify(result));
    assert.equal((await stored(db, hold.id)).status, "CONFIRMED");
    const { emails, sheets } = await drain(db, NOW);
    assert.deepEqual(sheets, [hold.id]);
    assertShows(renderWhole(emailOf(emails, "guest_confirmation"), "guest"), [FIRST.modelNames.ko, hold.ref], "guest");
    assertShows(renderWhole(emailOf(emails, "staff_new_booking"), "staff"), [FIRST.modelNames.ja, hold.ref], "staff");
  });
});

test("declines return to ON_HOLD and retries use a new key", async () => {
  await withShop(async (shop) => {
    const { db, first, second } = shop;
    const cases: [string, Published, PaymentResult, number][] = [
      ["a declined card", first, DECLINED, 0],
      ["a Square error", second, ERROR, 0],
      // The key counts from the row, not from this call.
      ["an earlier attempt", first, DECLINED, 4],
    ];
    for (const [label, stay, failure, earlier] of cases) {
      const hold = await seedHold(db, stay, { payment_attempt: earlier });
      const square = fakeSquare((input, nth) => (nth <= 2 ? failure : paymentOf(input)));

      for (const [index, at] of [NOW, NOW + MINUTE_MS].entries()) {
        const result = await confirmHold(depsAt(db, square, at), hold.id, payBody(HANAKO, "ja"));
        assert.equal(reasonOf(result), "PAYMENT_DECLINED", label);
        assert.deepEqual(
          await stored(db, hold.id),
          { ...hold, ...guestColumns(HANAKO), locale: "ja", payment_attempt: earlier + index + 1, updated_at: at },
          `${label}: decline ${index + 1}`,
        );
        await assertNothingEnqueued(db, label);
      }

      // The guest fixes a typo and pays: the row and the mail take the last request.
      const last = await confirmHold(depsAt(db, square, NOW + 2 * MINUTE_MS), hold.id, payBody(NA, "zh-cn"));
      assert.ok(last.ok, `${label}: ${JSON.stringify(last)}`);

      const keys = square.payments.map(({ idempotencyKey }) => idempotencyKey);
      assert.deepEqual(keys, [1, 2, 3].map((n) => `${hold.id}:${earlier + n}`), label);
      assert.deepEqual(square.refunds, [], label);
      const confirmed = await stored(db, hold.id);
      assert.equal(confirmed.payment_attempt, earlier + 3, label);
      assert.equal(confirmed.expires_at, hold.expires_at, label);
      await assertConfirmationItems(shop, stay, confirmed, NA, "zh-cn");
    }
  });
});

/** What can happen to a booking while Square is answering for it. */
const LATE_MOVES: [string, string][] = [
  ["the resolver expired it", "UPDATE bookings SET status = 'EXPIRED' WHERE id = ?1"],
  ["a newer attempt has it", "UPDATE bookings SET payment_attempt = payment_attempt + 1 WHERE id = ?1"],
];

test("a late decline leaves a booking that moved on alone", async () => {
  await withShop(async ({ db, first }) => {
    // A payment Square reports as FAILED or CANCELED took nothing either, so it ends as a decline does, and nothing goes back
    // whatever its amount says.
    const failures: [string, (input: CreatePaymentInput) => PaymentResult][] = [
      ["a decline", () => DECLINED],
      ["an error", () => ERROR],
      ["a FAILED payment", (input) => paymentOf(input, { status: "FAILED" })],
      ["a CANCELED payment", (input) => paymentOf(input, { status: "CANCELED" })],
      ["a FAILED payment for a yen less", (input) => paymentOf(input, { status: "FAILED", amount: input.amountJpy - 1 })],
    ];
    for (const [move, sql] of LATE_MOVES) {
      for (const [answer, failure] of failures) {
        const label = `${move}, ${answer}`;
        const hold = await seedHold(db, first);
        let moved: BookingRow | undefined;
        const square = fakeSquare(async (input) => {
          await db.prepare(sql).bind(hold.id).run();
          moved = await stored(db, hold.id);
          return failure(input);
        });

        const result = await confirmHold(depsAt(db, square, NOW), hold.id, payBody(HANAKO, "ja"));

        assert.equal(result.ok, false, label);
        assert.deepEqual(await stored(db, hold.id), moved, label);
        assert.deepEqual(square.refunds, [], `${label}: a refund of money never taken`);
        await assertNothingEnqueued(db, label);
      }
    }
  });
});

test("a late mismatch goes back in full and leaves a booking that moved on alone", async () => {
  await withShop(async ({ db, first }) => {
    const wrong: [number, string][] = [
      [first.depositJpy - 1, "JPY"],
      [first.depositJpy + 900, "JPY"],
      [first.depositJpy, "USD"],
    ];
    for (const [label, move] of LATE_MOVES) {
      for (const [amount, currency] of wrong) {
        const context = `${label}, ${amount} ${currency}`;
        const hold = await seedHold(db, first);
        const paymentId = `sq-${randomUUID()}`;
        let moved: BookingRow | undefined;
        const square = fakeSquare(async (input) => {
          await db.prepare(move).bind(hold.id).run();
          moved = await stored(db, hold.id);
          return paymentOf(input, { id: paymentId, amount, currency });
        });

        const result = await confirmHold(depsAt(db, square, NOW), hold.id, payBody(HANAKO, "ja"));

        assert.equal(result.ok, false, context);
        // The money is owed back whatever became of the row, and the row is no longer this confirm's to change.
        assert.deepEqual(await stored(db, hold.id), moved, context);
        assert.equal(square.refunds.length, 1, context);
        assertRefund(square.refunds[0], hold.id, paymentId, amount, context);
        await assertNothingEnqueued(db, context);
      }
    }
  });
});

test("markConfirmed's mismatch leaves a booking that moved on alone", async () => {
  await withShop(async ({ db, first }) => {
    // As #36 calls it: it reads a row in PAYMENT_PENDING, finds the wrong money and sends it back. Whatever lands between that
    // read and its own update owns the row by then. A paid booking flipped to ON_HOLD loses its bike once the hold runs out,
    // and a newer attempt flipped to ON_HOLD loses it with a charge still out.
    const moves: [string, (id: string) => Promise<unknown>][] = [
      ...LATE_MOVES.map(([label, sql]): [string, (id: string) => Promise<unknown>] => [
        label,
        (id) => db.prepare(sql).bind(id).run(),
      ]),
      ["another payment confirmed it", (id) => db.prepare(CONFIRMED_BY_ANOTHER).bind(id, `sq-${randomUUID()}`, NOW - 1).run()],
    ];
    const wrong: [number, string][] = [
      [first.depositJpy - 1, "JPY"],
      [first.depositJpy + 900, "JPY"],
      [first.depositJpy, "USD"],
    ];
    for (const [label, move] of moves) {
      for (const [amountJpy, currency] of wrong) {
        const context = `${label}, ${amountJpy} ${currency}`;
        const pending = await seedHold(db, first, pendingRow(HANAKO, "ja"));
        let moved: BookingRow | undefined;
        const race = raceBeforeUpdate(db, async () => {
          await move(pending.id);
          moved = await stored(db, pending.id);
        });
        const square = fakeSquare();
        const payment = { ...paymentFor(first), amountJpy, currency };

        const outcome = await markConfirmed(race.db, pending.id, payment, NOW, ctxOf(square));

        assert.ok(race.raced(), `${context}: markConfirmed ran no UPDATE of bookings`);
        assert.equal(outcome, "lost", context);
        assert.deepEqual(await stored(db, pending.id), moved, context);
        assert.equal(square.refunds.length, 1, context);
        assertRefund(square.refunds[0], pending.id, payment.id, amountJpy, context);
        await assertNothingEnqueued(db, context);
      }
    }
  });
});

test("unknown results stay pending and keep the bike", async () => {
  await withShop(async ({ db }) => {
    const answers: [string, (input: CreatePaymentInput) => PaymentResult][] = [
      ["a timeout", () => UNKNOWN],
      // Money that has not landed either way, whatever kind the client gave it.
      ["a payment still PENDING", (input) => paymentOf(input, { status: "PENDING" })],
      ["a payment only APPROVED", (input) => paymentOf(input, { status: "APPROVED" })],
    ];
    /** A model with one bike, that bike held by a real createHold, and a rival's try at it. */
    const heldBike = async () => {
      const { modelId, packageId } = await publish(db, FIRST);
      await seedVehicle(db, { model_id: modelId });
      const tryHold = (at: number) =>
        createHold(db, { id: randomUUID(), modelId, packageId, startAt: OPEN_PICKUP, locale: "en" }, at);
      const made = await tryHold(NOW);
      assert.ok(made.ok, JSON.stringify(made));
      return { tryHold, hold: await stored(db, made.booking.id) };
    };

    for (const [label, answer] of answers) {
      const { tryHold, hold } = await heldBike();
      const square = fakeSquare(answer);
      const at = NOW + MINUTE_MS;

      const result = await confirmHold(depsAt(db, square, at), hold.id, payBody(HANAKO, "ja"));

      assert.equal(reasonOf(result), "PAYMENT_UNKNOWN", label);
      // updated_at is what the resolver of #41 ages a stuck payment by.
      assert.deepEqual(
        await stored(db, hold.id),
        { ...hold, ...guestColumns(HANAKO), status: "PAYMENT_PENDING", locale: "ja", payment_attempt: 1, updated_at: at },
        label,
      );
      assert.deepEqual(square.refunds, [], label);
      await assertNothingEnqueued(db, label);

      // Well past the hold's own expiry, the charge in flight still has the only bike.
      const later = (hold.expires_at as number) + HOUR_MS;
      assert.deepEqual(await tryHold(later), { ok: false, reason: "SOLD_OUT" }, label);

      const again = await confirmHold(depsAt(db, square, later), hold.id, payBody(HANAKO, "ja"));
      assert.equal(reasonOf(again), "IN_PROGRESS", label);
      assert.equal(square.payments.length, 1, label);
    }

    // The same rival, past the same expiry, gets a bike nothing is charging for, so SOLD_OUT above is the pending row's doing.
    const { tryHold, hold } = await heldBike();
    await confirmHold(depsAt(db, fakeSquare(() => DECLINED), NOW + MINUTE_MS), hold.id, payBody(HANAKO, "ja"));
    const rival = await tryHold((hold.expires_at as number) + HOUR_MS);
    assert.ok(rival.ok, JSON.stringify(rival));
  });
});

test("a failed or canceled payment confirms nothing and refunds nothing", async () => {
  await withShop(async ({ db, first }) => {
    for (const status of ["FAILED", "CANCELED"]) {
      const hold = await seedHold(db, first);
      const square = fakeSquare((input) => paymentOf(input, { status }));

      const result = await confirmHold(depsAt(db, square, NOW), hold.id, payBody(HANAKO, "ja"));

      assert.ok(["PAYMENT_DECLINED", "PAYMENT_UNKNOWN"].includes(reasonOf(result)), `${status}: ${JSON.stringify(result)}`);
      assert.notEqual((await stored(db, hold.id)).status, "CONFIRMED", status);
      assert.deepEqual(square.refunds, [], status);
      await assertNothingEnqueued(db, status);
    }

    // Whoever calls it, "COMPLETED" is what confirms a booking.
    for (const status of ["FAILED", "CANCELED", "PENDING", "APPROVED"]) {
      const pending = await seedHold(db, first, pendingRow(HANAKO, "ja"));
      const square = fakeSquare();
      await markConfirmed(db, pending.id, { ...paymentFor(first), status }, NOW, ctxOf(square));
      assert.notEqual((await stored(db, pending.id)).status, "CONFIRMED", status);
      assert.deepEqual(square.refunds, [], status);
      await assertNothingEnqueued(db, status);
    }

    // The status comes first: money never taken is not sent back, whatever the amount says or wherever the booking has gone.
    const offs: [number, string][] = [
      [-1, "JPY"],
      [900, "JPY"],
      [0, "USD"],
    ];
    for (const status of ["FAILED", "CANCELED"]) {
      for (const [off, currency] of offs) {
        const label = `${status} for ${off} ${currency} off the deposit`;
        const hold = await seedHold(db, first);
        const square = fakeSquare((input) => paymentOf(input, { status, amount: input.amountJpy + off, currency }));

        const result = await confirmHold(depsAt(db, square, NOW), hold.id, payBody(HANAKO, "ja"));

        assert.equal(result.ok, false, label);
        assert.deepEqual(square.refunds, [], label);
        assert.notEqual((await stored(db, hold.id)).status, "CONFIRMED", label);
        await assertNothingEnqueued(db, label);

        const pending = await seedHold(db, first, pendingRow(HANAKO, "ja"));
        const direct = fakeSquare();
        const payment = { ...paymentFor(first), amountJpy: first.depositJpy + off, currency, status };
        assert.notEqual(await markConfirmed(db, pending.id, payment, NOW, ctxOf(direct)), "confirmed", label);
        assert.deepEqual(direct.refunds, [], `${label}, as #36 calls it`);
        assert.notEqual((await stored(db, pending.id)).status, "CONFIRMED", label);
        await assertNothingEnqueued(db, label);
      }

      const paid = { payment_id: `sq-${randomUUID()}`, paid_jpy: first.depositJpy, confirmed_at: NOW - HOUR_MS };
      const gone: [string, Partial<BookingRow>][] = [
        ["expired", { status: "EXPIRED" }],
        ["cancelled", { status: "CANCELLED", ...paid, cancelled_at: NOW - MINUTE_MS, cancel_reason: "guest" }],
        ["back on hold", { status: "ON_HOLD" }],
        ["confirmed by another payment", { status: "CONFIRMED", ...paid }],
      ];
      for (const [where, row] of gone) {
        const label = `${status} on a booking ${where}`;
        const booking = await seedHold(db, first, { ...guestColumns(HANAKO), payment_attempt: 1, ...row });
        const square = fakeSquare();

        const outcome = await markConfirmed(db, booking.id, { ...paymentFor(first), status }, NOW, ctxOf(square));

        assert.notEqual(outcome, "confirmed", label);
        assert.deepEqual(square.refunds, [], `${label}: a refund of money never taken`);
        assert.deepEqual(await stored(db, booking.id), booking, label);
        await assertNothingEnqueued(db, label);
      }
    }
  });
});

test("expired holds are never charged", async () => {
  await withShop(async ({ db, first, second }) => {
    // Eight hours is inside JST's offset, so a clock read in JST would still call that hold active.
    const lateBy = [0, 1, MINUTE_MS, 8 * HOUR_MS, 30 * DAY_MS];
    const rows: [string, Partial<BookingRow>, number][] = [
      ...lateBy.map((late): [string, Partial<BookingRow>, number] => [`${late} ms late`, {}, NOW + 10 * MINUTE_MS + late]),
      ["no expiry", { expires_at: null }, NOW],
      ["status EXPIRED", { status: "EXPIRED", expires_at: NOW - HOUR_MS }, NOW],
      ["status EXPIRED, by a clock behind it", { status: "EXPIRED" }, NOW],
    ];
    for (const stay of [first, second]) {
      for (const [label, row, at] of rows) {
        const hold = await seedHold(db, stay, row);
        const square = fakeSquare();

        const result = await confirmHold(depsAt(db, square, at), hold.id, payBody(HANAKO, "ja"));

        assert.equal(reasonOf(result), "HOLD_EXPIRED", label);
        assert.deepEqual(square.calls, [], `${label}: Square was called`);
        // Never PAYMENT_PENDING, no attempt spent, and a guest's details do not stay on a hold they cannot pay for.
        assert.deepEqual(await stored(db, hold.id), hold, label);
        await assertNothingEnqueued(db, label);
      }
    }

    // One millisecond the other way is a live hold, so the boundary above is the rule and not the fixture.
    const live = await seedHold(db, first);
    const lastMoment = (live.expires_at as number) - 1;
    assert.ok((await confirmHold(depsAt(db, fakeSquare(), lastMoment), live.id, payBody(HANAKO, "ja"))).ok);
    await drain(db, NOW);

    // A decline does not buy time: past the original expiry the retry is refused too.
    const declined = await seedHold(db, first);
    const square = fakeSquare(() => DECLINED);
    await confirmHold(depsAt(db, square, NOW), declined.id, payBody(HANAKO, "ja"));
    const afterExpiry = (declined.expires_at as number) + 1;
    const retry = await confirmHold(depsAt(db, square, afterExpiry), declined.id, payBody(HANAKO, "ja"));
    assert.equal(reasonOf(retry), "HOLD_EXPIRED");
    assert.equal(square.payments.length, 1);
    assert.equal((await stored(db, declined.id)).status, "ON_HOLD");
  });
});

test("amount mismatches are refunded, not confirmed", async () => {
  await withShop(async (shop) => {
    const { db, first, second } = shop;
    for (const stay of [first, second]) {
      const wrong: [string, number, string][] = [
        ["a yen short", stay.depositJpy - 1, "JPY"],
        ["a yen over", stay.depositJpy + 1, "JPY"],
        ["the whole price", stay.priceJpy, "JPY"],
        ["the deposit in dollars", stay.depositJpy, "USD"],
        ["another amount in euros", 123, "EUR"],
      ];
      for (const [label, amount, currency] of wrong) {
        const hold = await seedHold(db, stay);
        const paymentId = `sq-${randomUUID()}`;
        const firstOff = { id: paymentId, amount, currency };
        const square = fakeSquare((input, nth) => paymentOf(input, nth === 1 ? firstOff : {}));
        const at = NOW + MINUTE_MS;

        const result = await confirmHold(depsAt(db, square, at), hold.id, payBody(MINHO, "ko"));

        assert.equal(reasonOf(result), "PAYMENT_DECLINED", label);
        assert.equal(square.refunds.length, 1, label);
        assertRefund(square.refunds[0], hold.id, paymentId, amount, label);
        assert.deepEqual(
          await stored(db, hold.id),
          { ...hold, ...guestColumns(MINHO), locale: "ko", payment_attempt: 1, updated_at: at },
          label,
        );
        await assertNothingEnqueued(db, label);

        // The hold is still the guest's, and a good charge under a new key confirms it.
        const retry = await confirmHold(depsAt(db, square, at + MINUTE_MS), hold.id, payBody(MINHO, "ko"));
        assert.ok(retry.ok, `${label}: ${JSON.stringify(retry)}`);
        assert.equal(square.refunds.length, 1, label);
        const confirmed = await stored(db, hold.id);
        assert.equal(confirmed.paid_jpy, stay.depositJpy, label);
        await assertConfirmationItems(shop, stay, confirmed, MINHO, "ko");
      }

      // As the webhook and the resolver call it, with no check of their own.
      for (const [label, amount, currency] of wrong) {
        const pending = await seedHold(db, stay, pendingRow(MINHO, "ko"));
        const payment = { id: `sq-${randomUUID()}`, amountJpy: amount, currency, status: "COMPLETED" };
        const square = fakeSquare();

        assert.equal(await markConfirmed(db, pending.id, payment, NOW, ctxOf(square)), "lost", label);

        assert.equal(square.refunds.length, 1, label);
        assertRefund(square.refunds[0], pending.id, payment.id, amount, label);
        assert.deepEqual(await stored(db, pending.id), { ...pending, status: "ON_HOLD", updated_at: NOW }, label);
        await assertNothingEnqueued(db, label);
      }
    }
  });
});

test("each mismatch gets a refund key of its own, and the cancel refund's stays free", async () => {
  await withShop(async ({ db, first }) => {
    const hold = await seedHold(db, first);
    const square = fakeSquare((input) => paymentOf(input, { amount: input.amountJpy - 1 }));

    for (const minute of [0, 1]) {
      const result = await confirmHold(depsAt(db, square, NOW + minute * MINUTE_MS), hold.id, payBody(HANAKO, "ja"));
      assert.equal(reasonOf(result), "PAYMENT_DECLINED");
    }

    assert.equal(square.refunds.length, 2);
    const [one, two] = square.refunds.map(({ idempotencyKey }) => idempotencyKey);
    // Square answers a reused key with the first refund, or an error, so the second payment would never go back.
    assert.notEqual(one, two);
    for (const key of [one, two]) {
      assert.notEqual(key, `rf:${hold.id}`);
      assert.ok((key as string).length <= MAX_KEY_LENGTH, `the key ${key}`);
    }
  });
});

test("a refund that fails confirms nothing", async () => {
  await withShop(async ({ db, first }) => {
    const failures: [string, RefundResult][] = [
      ["unknown", { kind: "unknown", detail: "Square answered HTTP 503" }],
      ["error", { kind: "error", code: "REFUND_AMOUNT_INVALID", detail: "refused" }],
      ["declined", { kind: "declined", code: "REFUND_DECLINED", detail: "refused" }],
    ];
    for (const [label, failure] of failures) {
      const hold = await seedHold(db, first);
      const short = fakeSquare((input) => paymentOf(input, { amount: input.amountJpy - 1 }), () => failure);
      const result = await confirmHold(depsAt(db, short, NOW), hold.id, payBody(HANAKO, "ja"));
      assert.equal(result.ok, false, label);
      assert.equal(short.refunds.length, 1, label);
      assert.notEqual((await stored(db, hold.id)).status, "CONFIRMED", label);
      await assertNothingEnqueued(db, label);

      const gone = await seedHold(db, first, { status: "EXPIRED" });
      const late = fakeSquare(undefined, () => failure);
      assert.equal(await markConfirmed(db, gone.id, paymentFor(first), NOW, ctxOf(late)), "lost", label);
      assert.equal(late.refunds.length, 1, label);
      assert.deepEqual(await stored(db, gone.id), gone, label);
      await assertNothingEnqueued(db, label);
    }
  });
});

test("markConfirmed is idempotent and accepts an earlier webhook", async () => {
  await withShop(async (shop) => {
    const { db, first, second } = shop;
    for (const stay of [first, second]) {
      const hold = await seedHold(db, stay, pendingRow(HANAKO, "ja"));
      const square = fakeSquare();
      const ctx = ctxOf(square);
      const payment = paymentFor(stay);
      const before = await outboxSize(db);

      assert.equal(await markConfirmed(db, hold.id, payment, NOW, ctx), "confirmed");

      const confirmed = await stored(db, hold.id);
      assert.deepEqual(confirmed, {
        ...hold,
        status: "CONFIRMED",
        payment_id: payment.id,
        paid_jpy: stay.depositJpy,
        confirmed_at: NOW,
        updated_at: NOW,
      });
      assert.equal(await outboxSize(db), before + 3);

      // A key that holds the clock would enqueue again on a later call, and one after a delivery would send again.
      assert.equal(await markConfirmed(db, hold.id, payment, NOW + MINUTE_MS, ctx), "already");
      assert.equal((await drain(db, NOW)).emails.length, 2);
      assert.equal(await markConfirmed(db, hold.id, payment, NOW + DAY_MS, ctx), "already");

      assert.deepEqual(await stored(db, hold.id), confirmed);
      assert.equal(await outboxSize(db), before + 3);
      assert.deepEqual(await drain(db, NOW + DAY_MS), { emails: [], sheets: [] });
      assert.deepEqual(square.calls, []);
    }

    // The webhook and the confirm path answering at once.
    const both = await seedHold(db, first, pendingRow(NA, "zh-cn"));
    const square = fakeSquare();
    const payment = paymentFor(first);
    const outcomes = await Promise.all([1, 2].map(() => markConfirmed(db, both.id, payment, NOW, ctxOf(square))));
    assert.deepEqual(outcomes.toSorted(), ["already", "confirmed"]);
    assert.deepEqual(square.calls, []);
    await assertConfirmationItems(shop, first, await stored(db, both.id), NA, "zh-cn");

    // The webhook lands while the charge is still being answered, so the guest's own call finds it done.
    const hold = await seedHold(db, second);
    const raced = fakeSquare(async (input) => {
      const paid = paymentOf(input);
      assert.equal(paid.kind, "ok");
      const { id, amount, currency, status } = (paid as Extract<PaymentResult, { kind: "ok" }>).payment;
      const webhook = { id, amountJpy: amount, currency, status };
      assert.equal(await markConfirmed(db, hold.id, webhook, NOW, ctxOf(fakeSquare())), "confirmed");
      return paid;
    });
    const result = await confirmHold(depsAt(db, raced, NOW), hold.id, payBody(MINHO, "ko"));
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.booking.status, "CONFIRMED");
    assert.deepEqual(raced.refunds, []);
    await assertConfirmationItems(shop, second, await stored(db, hold.id), MINHO, "ko");
  });
});

test("an outbox write that fails leaves the booking pending for a replay", async () => {
  await withShop(async (shop) => {
    const { db, first, second } = shop;
    // A rejection below has to be the failed write's, not a module that does not load.
    await confirmModule();
    // The update and the three items are one batch. Written apart, a failed outbox write would leave a paid booking that no
    // guest, staff member or sheet hears of, and every replay would answer 'already' and repair nothing.
    const cases: [Published, Guest, Locale][] = [
      [first, HANAKO, "ja"],
      [second, NA, "zh-cn"],
    ];
    for (const [stay, guest, locale] of cases) {
      const pending = await seedHold(db, stay, pendingRow(guest, locale));
      const square = fakeSquare();
      const payment = paymentFor(stay);
      const failing = failOutboxWrites(db);
      const before = await outboxSize(db);

      // An error is how #36 and #41 learn to try again: Square does not send again a webhook that was answered 200.
      await assert.rejects(markConfirmed(failing.db, pending.id, payment, NOW, ctxOf(square)), locale);

      assert.ok(failing.wrote(), `${locale}: markConfirmed wrote nothing to the outbox`);
      assert.deepEqual(await stored(db, pending.id), pending, locale);
      assert.equal(await outboxSize(db), before, locale);
      assert.deepEqual(square.refunds, [], `${locale}: a good payment went back`);

      const later = NOW + 5 * MINUTE_MS;
      assert.equal(await markConfirmed(db, pending.id, payment, later, ctxOf(square)), "confirmed", locale);

      const confirmed = await stored(db, pending.id);
      const paid = { payment_id: payment.id, paid_jpy: stay.depositJpy, confirmed_at: later, updated_at: later };
      assert.deepEqual(confirmed, { ...pending, status: "CONFIRMED", ...paid }, locale);
      assert.deepEqual(square.refunds, [], locale);
      await assertConfirmationItems(shop, stay, confirmed, guest, locale);
    }

    // The same failure inside confirmHold: the money has moved, so the booking keeps its bike and waits for #36 or #41.
    const hold = await seedHold(db, second);
    const paymentId = `sq-${randomUUID()}`;
    const square = fakeSquare((input) => paymentOf(input, { id: paymentId }));
    const failing = failOutboxWrites(db);
    const at = NOW + MINUTE_MS;

    const settled = await confirmHold(depsAt(failing.db, square, at), hold.id, payBody(MINHO, "ko")).then(reasonOf, () => "threw");

    assert.ok(failing.wrote(), "confirmHold wrote nothing to the outbox");
    assert.ok(["threw", "PAYMENT_UNKNOWN"].includes(settled), settled);
    const charging = { ...hold, ...guestColumns(MINHO), status: "PAYMENT_PENDING", locale: "ko", payment_attempt: 1, updated_at: at };
    assert.deepEqual(await stored(db, hold.id), charging);
    assert.deepEqual(square.refunds, []);
    await assertNothingEnqueued(db, "a failed outbox write");

    // The guest pressing again is told to wait and charged nothing more.
    assert.equal(reasonOf(await confirmHold(depsAt(db, square, at), hold.id, payBody(MINHO, "ko"))), "IN_PROGRESS");
    assert.equal(square.payments.length, 1);

    const webhook = { id: paymentId, amountJpy: second.depositJpy, currency: "JPY", status: "COMPLETED" };
    assert.equal(await markConfirmed(db, hold.id, webhook, at + MINUTE_MS, ctxOf(square)), "confirmed");
    assert.deepEqual(square.refunds, []);
    const confirmed = await stored(db, hold.id);
    assert.equal(confirmed.payment_id, paymentId);
    await assertConfirmationItems(shop, second, confirmed, MINHO, "ko");
  });
});

test("a charge that outlived its hold still confirms", async () => {
  await withShop(async (shop) => {
    const { db, first, second } = shop;
    // The expiry stops a charge from starting. One already out keeps the bike, so #36 or #41 can land long after it, and turning
    // that away would send a good payment back and leave the row in PAYMENT_PENDING.
    const cases: [Published, number][] = [
      [first, NOW],
      [first, NOW - 1],
      [second, NOW - HOUR_MS],
      [second, NOW - DAY_MS],
    ];
    for (const [stay, expires_at] of cases) {
      const pending = await seedHold(db, stay, { ...pendingRow(HANAKO, "ja"), expires_at });
      const square = fakeSquare();
      const payment = paymentFor(stay);
      const label = `${NOW - expires_at} ms past the expiry`;

      assert.equal(await markConfirmed(db, pending.id, payment, NOW, ctxOf(square)), "confirmed", label);

      assert.deepEqual(square.calls, [], `${label}: a refund of a good payment`);
      const confirmed = await stored(db, pending.id);
      const paid = { payment_id: payment.id, paid_jpy: stay.depositJpy, confirmed_at: NOW, updated_at: NOW };
      assert.deepEqual(confirmed, { ...pending, status: "CONFIRMED", ...paid }, label);
      await assertConfirmationItems(shop, stay, confirmed, HANAKO, "ja");
    }

    // The same thing inside confirmHold: the hold runs out while Square is answering.
    const hold = await seedHold(db, first);
    let clock = NOW;
    const square = fakeSquare((input) => {
      clock = (hold.expires_at as number) + MINUTE_MS;
      return paymentOf(input);
    });

    const result = await confirmHold({ ...depsAt(db, square, NOW), now: () => clock }, hold.id, payBody(MINHO, "ko"));

    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(square.refunds, []);
    await assertConfirmationItems(shop, first, await stored(db, hold.id), MINHO, "ko");
  });
});

test("confirmation after the hold was lost refunds in full", async () => {
  await withShop(async ({ db, first, second }) => {
    for (const stay of [first, second]) {
      const paid = { payment_id: `sq-${randomUUID()}`, paid_jpy: stay.depositJpy, confirmed_at: NOW - HOUR_MS };
      const rows: [string, Partial<BookingRow>][] = [
        ["expired", { status: "EXPIRED" }],
        ["cancelled", { status: "CANCELLED", cancelled_at: NOW - MINUTE_MS }],
        ["back on hold", { status: "ON_HOLD" }],
        ["confirmed by another payment", { status: "CONFIRMED", ...paid }],
      ];
      for (const [label, row] of rows) {
        const hold = await seedHold(db, stay, { ...guestColumns(HANAKO), payment_attempt: 1, ...row });
        const ledger = refundLedger();
        const square = fakeSquare(undefined, ledger.answer);
        const deposit = paymentFor(stay);
        // In full means what the payment took, which here is not what the deposit says.
        const larger = { ...paymentFor(stay), amountJpy: stay.depositJpy + 900 };

        for (const late of [deposit, larger]) {
          assert.equal(await markConfirmed(db, hold.id, late, NOW, ctxOf(square)), "lost", label);
        }

        assert.equal(square.refunds.length, 2, label);
        assertRefund(square.refunds[0], hold.id, deposit.id, deposit.amountJpy, label);
        assertRefund(square.refunds[1], hold.id, larger.id, larger.amountJpy, label);
        // Under one key the second payment would get the first one's refund and never go back.
        assert.deepEqual(ledger.paidBack(), [deposit.id, larger.id], label);
        assert.deepEqual(await stored(db, hold.id), hold, label);
        await assertNothingEnqueued(db, label);
      }

      // A cancelled booking's own payment, replayed: #35 settled it under the sheet's tier, a 0% one included, so its event
      // changes nothing. Another payment never held the bike, and goes back in full under a key of its own.
      const settledPayment = paymentFor(stay);
      const cancelled = await seedHold(db, stay, {
        ...guestColumns(MINHO),
        status: "CANCELLED",
        payment_attempt: 1,
        payment_id: settledPayment.id,
        paid_jpy: stay.depositJpy,
        confirmed_at: NOW - DAY_MS,
        cancelled_at: NOW - HOUR_MS,
        cancel_reason: "guest",
      });
      const cancelLedger = refundLedger();
      // #35's own refund of the cancellation, under its key, through the same Square.
      cancelLedger.answer({
        idempotencyKey: `rf:${cancelled.id}`,
        paymentId: settledPayment.id,
        amountJpy: Math.floor(stay.depositJpy / 2),
        reason: "cancellation",
      });
      const afterCancel = fakeSquare(undefined, cancelLedger.answer);
      const another = paymentFor(stay);
      const events: [typeof another, number, string][] = [
        [settledPayment, NOW, "already"],
        [another, NOW + MINUTE_MS, "lost"],
        [settledPayment, NOW + DAY_MS, "already"],
      ];
      for (const [payment, at, outcome] of events) {
        const label = `${outcome === "already" ? "its own payment" : "another payment"} on a cancelled booking`;
        assert.equal(await markConfirmed(db, cancelled.id, payment, at, ctxOf(afterCancel)), outcome, label);
        assert.deepEqual(await stored(db, cancelled.id), cancelled, label);
        await assertNothingEnqueued(db, label);
      }
      assert.deepEqual(afterCancel.calls, ["refundPayment"]);
      assertRefund(afterCancel.refunds[0], cancelled.id, another.id, another.amountJpy, "another payment on a cancelled booking");
      assert.deepEqual(cancelLedger.paidBack(), [settledPayment.id, another.id]);

      // The same thing inside confirmHold: the booking goes while Square is answering.
      const hold = await seedHold(db, stay);
      let lost: BookingRow | undefined;
      let paymentId: string | undefined;
      const square = fakeSquare(async (input) => {
        await db.prepare("UPDATE bookings SET status = 'EXPIRED' WHERE id = ?1").bind(hold.id).run();
        lost = await stored(db, hold.id);
        paymentId = `sq-${randomUUID()}`;
        return paymentOf(input, { id: paymentId });
      });

      const result = await confirmHold(depsAt(db, square, NOW), hold.id, payBody(HANAKO, "ja"));

      assert.equal(reasonOf(result), "HOLD_EXPIRED");
      assert.equal(square.refunds.length, 1);
      assertRefund(square.refunds[0], hold.id, paymentId as string, stay.depositJpy, "inside confirmHold");
      assert.deepEqual(await stored(db, hold.id), lost);
      await assertNothingEnqueued(db, "inside confirmHold");
    }
  });
});

test("the same lost payment replayed keeps its refund key and goes back once", async () => {
  await withShop(async ({ db, first }) => {
    const timedOut: RefundResult = { kind: "unknown", detail: "Square answered HTTP 503" };
    // A timeout is the likeliest reason #36 or #41 comes back with the same payment, so the money may already have moved.
    for (const firstAnswer of [undefined, timedOut]) {
      const hold = await seedHold(db, first, { status: "EXPIRED", payment_attempt: 1 });
      const ledger = refundLedger(firstAnswer);
      const square = fakeSquare(undefined, ledger.answer);
      const payment = paymentFor(first);
      const replay = (at: number) => markConfirmed(db, hold.id, payment, at, ctxOf(square));

      assert.equal(await replay(NOW), "lost");
      assert.equal(await replay(NOW + MINUTE_MS), "lost");
      // Neither the clock nor the row says which payment this is, so neither may change its key.
      await db.prepare("UPDATE bookings SET status = 'CANCELLED', payment_attempt = 2 WHERE id = ?1").bind(hold.id).run();
      assert.equal(await replay(NOW + DAY_MS), "lost");

      assertRefund(square.refunds[0], hold.id, payment.id, payment.amountJpy, "the first refund");
      assert.deepEqual(ledger.paidBack(), [payment.id]);
    }

    // Square reports every payment, so a wrong amount confirmHold has already sent back comes round again as a lost one.
    const hold = await seedHold(db, first);
    const paymentId = `sq-${randomUUID()}`;
    const amount = first.depositJpy - 1;
    const ledger = refundLedger();
    const square = fakeSquare((input) => paymentOf(input, { id: paymentId, amount }), ledger.answer);

    const result = await confirmHold(depsAt(db, square, NOW), hold.id, payBody(HANAKO, "ja"));

    assert.equal(reasonOf(result), "PAYMENT_DECLINED");
    const webhook = { id: paymentId, amountJpy: amount, currency: "JPY", status: "COMPLETED" };
    assert.equal(await markConfirmed(db, hold.id, webhook, NOW + MINUTE_MS, ctxOf(square)), "lost");
    assert.deepEqual(ledger.paidBack(), [paymentId]);
  });
});

test("a lost refund's key fits Square's cap and still tells payments apart", async () => {
  await withShop(async ({ db, first }) => {
    const hold = await seedHold(db, first, { status: "EXPIRED" });
    const ledger = refundLedger();
    const square = fakeSquare(undefined, ledger.answer);
    const digits = randomBytes(MAX_PAYMENT_ID_LENGTH / 2).toString("hex");
    /** Hex holds no x, so this always changes the id. */
    const changedAt = (id: string, at: number) => `${id.slice(0, at)}x${id.slice(at + 1)}`;
    // Each id beside its twins, one character apart: cut to fit at either end or around the middle, two of them share a key.
    const ids = [22, 39, 41, 42, 43, 44, 45, 46, MAX_PAYMENT_ID_LENGTH].flatMap((length) => {
      const id = digits.slice(0, length);
      return [id, changedAt(id, 0), changedAt(id, length >> 1), changedAt(id, length - 1)];
    });

    // The second round replays every id, long ones too, and must move no more money.
    for (const round of [1, 2]) {
      for (const id of ids) {
        const payment = { ...paymentFor(first), id };
        const label = `round ${round}, an id of ${id.length}`;
        assert.equal(await markConfirmed(db, hold.id, payment, NOW, ctxOf(square)), "lost", label);
        assertRefund(square.refunds.at(-1), hold.id, id, payment.amountJpy, label);
      }
      assert.deepEqual(ledger.paidBack(), ids, `round ${round}`);
    }

    // A wrong amount goes back under the same cap: the client refuses a longer key, and the money would stay with the shop.
    const wrong = await seedHold(db, first);
    const short = fakeSquare((input) => paymentOf(input, { id: digits, amount: input.amountJpy - 1 }));

    const result = await confirmHold(depsAt(db, short, NOW), wrong.id, payBody(HANAKO, "ja"));

    assert.equal(reasonOf(result), "PAYMENT_DECLINED");
    assertRefund(short.refunds[0], wrong.id, digits, first.depositJpy - 1, "a wrong amount");
  });
});

test("a booking that moves just before the batch gets no confirmation", async () => {
  await withShop(async (shop) => {
    const { db, first } = shop;
    // The update in the batch finds nothing, so nothing else in that batch may go through either: a guest must not be told
    // their booking stands, or staff told to expect them, for a payment that is on its way back.
    for (const status of ["EXPIRED", "CANCELLED"]) {
      const hold = await seedHold(db, first, pendingRow(HANAKO, "ja"));
      let moved: BookingRow | undefined;
      const race = raceBeforeBatch(db, async () => {
        await db.prepare("UPDATE bookings SET status = ?2 WHERE id = ?1").bind(hold.id, status).run();
        moved = await stored(db, hold.id);
      });
      const square = fakeSquare();
      const payment = paymentFor(first);

      const outcome = await markConfirmed(race.db, hold.id, payment, NOW, ctxOf(square));

      assert.ok(race.raced(), `${status}: markConfirmed ran no batch`);
      assert.equal(outcome, "lost", status);
      assert.equal(square.refunds.length, 1, status);
      assertRefund(square.refunds[0], hold.id, payment.id, payment.amountJpy, status);
      assert.deepEqual(await stored(db, hold.id), moved, status);
      await assertNothingEnqueued(db, status);
    }

    // Another payment confirmed it just before the batch. The booking stands, but not on this payment: this one goes back,
    // and its items must not go in on the strength of a CONFIRMED that is not its own.
    const taken = await seedHold(db, first, pendingRow(HANAKO, "ja"));
    let moved: BookingRow | undefined;
    const race = raceBeforeBatch(db, async () => {
      await db.prepare(CONFIRMED_BY_ANOTHER).bind(taken.id, `sq-${randomUUID()}`, NOW - 1).run();
      moved = await stored(db, taken.id);
    });
    const square = fakeSquare();
    const late = paymentFor(first);

    assert.equal(await markConfirmed(race.db, taken.id, late, NOW, ctxOf(square)), "lost");

    assert.ok(race.raced(), "markConfirmed ran no batch");
    assert.equal(square.refunds.length, 1);
    assertRefund(square.refunds[0], taken.id, late.id, late.amountJpy, "confirmed by another payment");
    assert.deepEqual(await stored(db, taken.id), moved);
    await assertNothingEnqueued(db, "confirmed by another payment");

    // The same race with that payment's own markConfirmed: the booking has one confirmation, the earlier payment's.
    const both = await seedHold(db, first, pendingRow(NA, "zh-cn"));
    const earlier = paymentFor(first);
    const earlierSquare = fakeSquare();
    let earlierOutcome: string | undefined;
    const racedBoth = raceBeforeBatch(db, async () => {
      earlierOutcome = await markConfirmed(db, both.id, earlier, NOW, ctxOf(earlierSquare));
    });
    const lateSquare = fakeSquare();
    const lost = paymentFor(first);
    const before = await outboxSize(db);

    assert.equal(await markConfirmed(racedBoth.db, both.id, lost, NOW, ctxOf(lateSquare)), "lost");

    assert.ok(racedBoth.raced(), "markConfirmed ran no batch");
    assert.equal(earlierOutcome, "confirmed");
    assert.deepEqual(earlierSquare.refunds, []);
    assert.equal(lateSquare.refunds.length, 1);
    assertRefund(lateSquare.refunds[0], both.id, lost.id, lost.amountJpy, "the later payment");
    const confirmed = await stored(db, both.id);
    assert.equal(confirmed.payment_id, earlier.id);
    assert.equal(await outboxSize(db), before + 3);
    await assertConfirmationItems(shop, first, confirmed, NA, "zh-cn");
  });
});

test("concurrent confirms charge once", async () => {
  await withShop(async (shop) => {
    const { db, first, second } = shop;
    for (const [stay, racers] of [[first, 2], [second, 5]] as const) {
      const hold = await seedHold(db, stay);
      let answered = 0;
      let letGo = (): void => {};
      const othersAnswered = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      // The charge waits for every other call, so all of them meet it in flight. The sleep only ends a run that charges twice.
      const square = fakeSquare(async (input) => {
        await Promise.race([othersAnswered, sleep(2_000, undefined, { ref: false })]);
        return paymentOf(input);
      });
      const deps = depsAt(db, square, NOW);
      const guests = GUESTS.slice(0, racers);

      const results = await Promise.all(
        guests.map(async (guest) => {
          const result = await confirmHold(deps, hold.id, payBody(guest, "en"));
          answered += 1;
          if (answered === racers - 1) letGo();
          return result;
        }),
      );

      assert.equal(square.payments.length, 1, `${racers} racers`);
      assert.equal(square.payments[0]?.idempotencyKey, `${hold.id}:1`);
      assert.deepEqual(results.map(reasonOf).toSorted(), [...Array(racers - 1).fill("IN_PROGRESS"), "ok"]);

      // The row and the mail are the winner's: a loser's details must not land on a charge it did not make.
      const winner = guests[results.findIndex(({ ok }) => ok)] as Guest;
      const confirmed = await stored(db, hold.id);
      assert.equal(confirmed.status, "CONFIRMED");
      assert.equal(confirmed.payment_attempt, 1);
      assert.equal(confirmed.guest_email, winner.email);
      await assertConfirmationItems(shop, stay, confirmed, winner, "en");
    }
  });
});

test("the attempt comes from the row, so a raced retry gets a new key", async () => {
  await withShop(async ({ db, first }) => {
    for (const earlier of [0, 3]) {
      const hold = await seedHold(db, first, { payment_attempt: earlier });
      const square = fakeSquare((input, nth) => (nth === 1 ? DECLINED : paymentOf(input)));
      // A whole declined confirm lands between this confirm's read and its update, and leaves the row ON_HOLD one attempt on, so
      // an attempt worked out from that read and guarded by the status alone would send the same key twice.
      const race = raceBeforeUpdate(db, () => confirmHold(depsAt(db, square, NOW), hold.id, payBody(MINHO, "ko")));

      const result = await confirmHold(depsAt(race.db, square, NOW), hold.id, payBody(HANAKO, "ja"));

      assert.ok(race.raced(), "confirmHold ran no UPDATE of bookings");
      assert.ok(result.ok, JSON.stringify(result));
      // Two keys, and not the same one twice: Square would answer a reused key with the decline.
      const keys = square.payments.map(({ idempotencyKey }) => idempotencyKey);
      assert.deepEqual(keys, [`${hold.id}:${earlier + 1}`, `${hold.id}:${earlier + 2}`]);
      const confirmed = await stored(db, hold.id);
      assert.equal(confirmed.status, "CONFIRMED");
      assert.equal(confirmed.payment_attempt, earlier + 2);
      assert.deepEqual(square.refunds, []);
    }
  });
});

test("only a live hold of a web booking is charged", async () => {
  await withShop(async ({ db, first }) => {
    const paid = { payment_id: `sq-${randomUUID()}`, paid_jpy: first.depositJpy, confirmed_at: NOW - HOUR_MS };
    const rows: [string, Partial<BookingRow>, string][] = [
      ["a charge in flight", { status: "PAYMENT_PENDING", payment_attempt: 1 }, "IN_PROGRESS"],
      // The hold's time ran out with the charge still out: that is still a charge, and the page says wait, not book again.
      ["a charge past the expiry", { status: "PAYMENT_PENDING", payment_attempt: 1, expires_at: NOW - HOUR_MS }, "IN_PROGRESS"],
      ["a cancelled booking", { status: "CANCELLED", ...paid, cancelled_at: NOW - MINUTE_MS }, "HOLD_EXPIRED"],
      // A second press after the charge went through, with the expiry long past, is a success and no new charge.
      ["a confirmed booking", { status: "CONFIRMED", expires_at: NOW - DAY_MS, ...paid, ...guestColumns(ADA) }, "ok"],
      ["a staff block", { source: "block", status: "CONFIRMED", external_ref: "ota-1", locale: null }, "NOT_FOUND"],
    ];
    for (const [label, row, reason] of rows) {
      const booking = await seedHold(db, first, row);
      const square = fakeSquare();

      const result = await confirmHold(depsAt(db, square, NOW), booking.id, payBody(HANAKO, "ja"));

      assert.equal(reasonOf(result), reason, label);
      assert.deepEqual(square.calls, [], `${label}: Square was called`);
      assert.deepEqual(await stored(db, booking.id), booking, label);
      await assertNothingEnqueued(db, label);
    }

    const hold = await seedHold(db, first);
    const strangers = [randomUUID(), hold.ref, hold.id.toUpperCase(), `${hold.id}x`, "", "x".repeat(500), "constructor", "__proto__"];
    for (const id of strangers) {
      const square = fakeSquare();
      const result = await confirmHold(depsAt(db, square, NOW), id, payBody(HANAKO, "ja"));
      assert.equal(reasonOf(result), "NOT_FOUND", id.slice(0, 40));
      assert.deepEqual(square.calls, [], `${id.slice(0, 40)}: Square was called`);
    }
  });
});

test("invalid guests never reach Square", async () => {
  const every = ["EMAIL_MALFORMED", "FAMILY_NAME_EMPTY", "GIVEN_NAME_EMPTY", "PHONE_NO_DIGITS"];
  const cases: [string, unknown, string[]][] = [
    ["no guest", undefined, every],
    ["null", null, every],
    ["a number", 7, every],
    ["a list", [HANAKO], every],
    ["an empty object", {}, every],
    ["no family name", { ...HANAKO, familyName: "" }, ["FAMILY_NAME_EMPTY"]],
    ["a blank given name", { ...HANAKO, givenName: "　" }, ["GIVEN_NAME_EMPTY"]],
    ["no domain", { ...HANAKO, email: "ruri@" }, ["EMAIL_MALFORMED"]],
    ["a padded email", { ...HANAKO, email: ` ${HANAKO.email}` }, ["EMAIL_MALFORMED"]],
    ["a header in the email", { ...HANAKO, email: `${HANAKO.email}\r\nBcc: x@example.jp` }, ["EMAIL_MALFORMED"]],
    ["markup for an email", { ...HANAKO, email: "<script>@example.jp" }, ["EMAIL_MALFORMED"]],
    ["no digits", { ...HANAKO, phone: "---" }, ["PHONE_NO_DIGITS"]],
    ["numbers for strings", { ...HANAKO, familyName: 1, phone: 90 }, ["FAMILY_NAME_EMPTY", "PHONE_NO_DIGITS"]],
  ];
  await withShop(async ({ db, first }) => {
    for (const [label, guest, codes] of cases) {
      const hold = await seedHold(db, first);
      const square = fakeSquare();
      const body = { ...payBody(HANAKO, "ja"), guest: guest as Guest };

      const result = await confirmHold(depsAt(db, square, NOW), hold.id, body);

      assert.equal(result.ok, false, label);
      assert.ok(!result.ok);
      assert.equal(result.reason, "INVALID_GUEST", label);
      assert.deepEqual(result.fields?.toSorted(), codes, label);
      assert.deepEqual(square.calls, [], `${label}: Square was called`);
      assert.deepEqual(await stored(db, hold.id), hold, label);
    }
  });
});

// #131: a real createHold locks the price, the advance one when the hold is made before the pickup's JST date, and confirm,
// both emails and the Bookings tab read it from the row. Between the hold and the payment a publish moves every price, so a
// price looked up again at either moment shows. Amounts are written out by hand, digits too.
type LockedCase = {
  label: string;
  held: string;
  paid: string;
  pickup: string;
  /** The package's key in the rows below. */
  pkg: "oneDay" | "threeDays" | "twoDays";
  guest: Guest;
  locale: Locale;
  lockedJpy: number;
  lockedDigits: string;
  /** Both prices the catalog gives this package once the publish has landed: a lookup at either moment finds one. */
  republishedDigits: [string, string];
};

/** [price_jpy, advance_price_jpy] */
type Prices = [number, number | null];

/** Each package's length and prices before the publish, and after it. Two-day rentals start with no advance price. */
type LockedRow = { days: number; before: Prices; after: Prices };

const LOCKED_ROWS: Record<LockedCase["pkg"], LockedRow> = {
  oneDay: { days: 1, before: [4500, 4000], after: [5200, 4300] },
  threeDays: { days: 3, before: [10_000, 9000], after: [10_700, 9300] },
  twoDays: { days: 2, before: [7700, null], after: [8400, 6100] },
};

const LOCKED_CASES: LockedCase[] = [
  {
    label: "held at 23:58 JST the day before, paid at 00:05 on the pickup date",
    held: "2030-06-09 23:58",
    paid: "2030-06-10 00:05",
    pickup: "2030-06-10 09:00",
    pkg: "oneDay",
    guest: HANAKO,
    locale: "ja",
    lockedJpy: 4000,
    lockedDigits: "4,000",
    republishedDigits: ["5,200", "4,300"],
  },
  {
    label: "held in the last minute of the day before, paid just after midnight",
    held: "2030-06-09 23:59",
    paid: "2030-06-10 00:01",
    pickup: "2030-06-10 10:30",
    pkg: "threeDays",
    guest: NA,
    locale: "zh-cn",
    lockedJpy: 9000,
    lockedDigits: "9,000",
    republishedDigits: ["10,700", "9,300"],
  },
  {
    label: "a row without an advance price, held at 23:58 and paid at 00:05",
    held: "2030-06-09 23:58",
    paid: "2030-06-10 00:05",
    pickup: "2030-06-10 11:00",
    pkg: "twoDays",
    guest: MINHO,
    locale: "ko",
    lockedJpy: 7700,
    lockedDigits: "7,700",
    republishedDigits: ["8,400", "6,100"],
  },
  {
    label: "held on the pickup date, paid minutes later",
    held: "2030-06-12 06:00",
    paid: "2030-06-12 06:05",
    pickup: "2030-06-12 13:00",
    pkg: "oneDay",
    guest: ADA,
    locale: "en",
    lockedJpy: 4500,
    lockedDigits: "4,500",
    republishedDigits: ["5,200", "4,300"],
  },
];

test("confirm keeps the locked price after midnight", async () => {
  const { createFakeSheets } = await import("./helpers/fake-sheets.ts");
  const { BOOKINGS_COLUMNS } = await import("../src/lib/catalog/sheet-schema.ts");
  const { syncBookingRows } = await import("../src/lib/sheets/bookings-sync.ts");

  const depositJpy = 1500;
  const settings = PLAIN_SHOP;
  const { db, dispose } = await createTestDb();
  try {
    await seedType(db, { id: "ebike", deposit_jpy: depositJpy });
    // A lead time of 0, so a hold on the pickup date can be made at all.
    await seedConfig(db, { shop_open: settings.open, shop_close: settings.close, min_lead_hours: 0, hold_minutes: 15 });
    await seedCatalogMeta(db);
    await seedTiers(db, settings.tiers);
    const rate = await seedRateClass(db, { grp: "ebike" });
    const model = await seedModel(db, {
      type_id: "ebike",
      engine_cc: null,
      license_class: "none",
      rate_class_id: rate.id,
      texts: textsOf(FIRST.modelNames, { summary: "A summary", description: "A description" }),
    });
    for (let i = 0; i < 4; i += 1) await seedVehicle(db, { model_id: model.id });
    const lockedRows = Object.entries(LOCKED_ROWS) as [LockedCase["pkg"], LockedRow][];
    const packageIds = {} as Record<LockedCase["pkg"], string>;
    for (const [key, { days, before }] of lockedRows) {
      const pack = await seedPackage(db, { days, texts: textsOf(FIRST.packageNames) });
      const [price_jpy, advance_price_jpy] = before;
      await seedPrice(db, { rate_class_id: rate.id, package_id: pack.id, price_jpy, advance_price_jpy });
      packageIds[key] = pack.id;
    }
    const setPrices = async (side: "before" | "after") => {
      for (const [key, row] of lockedRows) {
        await db
          .prepare("UPDATE prices SET price_jpy = ?1, advance_price_jpy = ?2 WHERE package_id = ?3")
          .bind(row[side][0], row[side][1], packageIds[key])
          .run();
      }
    };

    for (const testCase of LOCKED_CASES) {
      const { label, guest, locale, lockedJpy } = testCase;
      await setPrices("before");
      const input = {
        id: randomUUID(),
        modelId: model.id,
        packageId: packageIds[testCase.pkg],
        startAt: jst(testCase.pickup),
        locale: "en" as const,
      };
      const held = await createHold(db, input, jst(testCase.held));
      assert.ok(held.ok, `${label}: ${JSON.stringify(held)}`);
      assert.equal(held.booking.priceJpy, lockedJpy, `${label}: the hold`);

      // The publish lands after midnight, before the guest pays.
      await setPrices("after");
      const square = fakeSquare();
      const paid = await confirmHold(depsAt(db, square, jst(testCase.paid)), held.booking.id, payBody(guest, locale));
      assert.ok(paid.ok, `${label}: ${JSON.stringify(paid)}`);
      const row = await stored(db, held.booking.id);
      assert.equal(row.status, "CONFIRMED", label);
      assert.equal(row.price_jpy, lockedJpy, `${label}: the confirmed row`);
      assert.equal(paid.booking.priceJpy, lockedJpy, `${label}: the confirmed booking`);
      // The deposit is the type's, whatever the price.
      assert.equal(row.deposit_jpy, depositJpy, label);
      assert.deepEqual(
        square.payments.map(({ amountJpy }) => amountJpy),
        [depositJpy],
        `${label}: the charge`,
      );

      // The outbox as the cron delivers it, the Bookings tab written by the real sync.
      const sheets = createFakeSheets({ Bookings: [[...BOOKINGS_COLUMNS]] });
      const emails: EmailPayload[] = [];
      await drainOutbox({
        db,
        now: jst(testCase.paid) + DAY_MS,
        sendEmail: async (payload) => {
          emails.push(payload);
          return { ok: true };
        },
        syncBookings: (ids) => syncBookingRows({ db, sheets }, ids),
      });
      assert.deepEqual(await waitingKinds(db), [], `${label}: the outbox`);

      const guestEmail = emailOf(emails, "guest_confirmation");
      const staffEmail = emailOf(emails, "staff_new_booking");
      assert.equal(guestEmail.data.priceJpy, lockedJpy, `${label}: guest_confirmation`);
      assert.equal(staffEmail.data.priceJpy, lockedJpy, `${label}: staff_new_booking`);
      const guestText = renderWhole(guestEmail, `${label}: guest`);
      const staffText = renderWhole(staffEmail, `${label}: staff`);
      assertShows(guestText, [MONEY[locale](testCase.lockedDigits), MONEY[locale]("1,500")], `${label}: guest`);
      assertShows(staffText, [MONEY.ja(testCase.lockedDigits), MONEY.ja("1,500")], `${label}: staff`);
      for (const digits of testCase.republishedDigits) {
        assert.ok(!guestText.includes(MONEY[locale](digits)), `${label}: the guest sees ${digits}, a price looked up again`);
        assert.ok(!staffText.includes(MONEY.ja(digits)), `${label}: staff see ${digits}, a price looked up again`);
      }

      const [header, ...lines] = sheets.grid("Bookings");
      const at = (name: string) => header.indexOf(name);
      const line = lines.find((cells) => cells[at("booking_id")] === held.booking.id);
      assert.ok(line, `${label}: no Bookings row for ${held.booking.id} in ${JSON.stringify(lines)}`);
      assert.equal(line[at("price_jpy")], lockedJpy, `${label}: the Bookings tab`);
      assert.equal(line[at("deposit_jpy")], depositJpy, `${label}: the Bookings tab`);
    }
  } finally {
    await dispose();
  }
});

/** [hours, pickup, return, guest, locale]: the return written out by hand, `hours` after the pickup. */
const HOURLY_STAYS: [number, string, string, Guest, Locale][] = [
  [4, "2030-06-10 10:30", "2030-06-10 14:30", HANAKO, "ja"],
  [24, "2030-06-30 17:30", "2030-07-01 17:30", MINHO, "ko"],
  [2, "2030-07-15 09:00", "2030-07-15 11:00", ADA, "en"],
  [8, "2030-06-20 09:30", "2030-06-20 17:30", NA, "zh-cn"],
];

// #50: an hourly booking's emails give its return as the pickup plus its hours, which is not closing time on any day.
test("an hourly booking's emails show its return at pickup plus its hours", async () => {
  const settings = PLAIN_SHOP;
  const { db, dispose } = await createTestDb();
  try {
    await seedType(db, { deposit_jpy: CATALOG_DEPOSIT_JPY });
    await seedConfig(db, { shop_open: settings.open, shop_close: settings.close });
    await seedCatalogMeta(db);
    await seedTiers(db, settings.tiers);
    const rate = await seedRateClass(db);
    const model = await seedModel(db, {
      rate_class_id: rate.id,
      texts: textsOf(FIRST.modelNames, { summary: "A summary", description: "A description" }),
    });
    for (let i = 0; i < HOURLY_STAYS.length; i += 1) await seedVehicle(db, { model_id: model.id });

    for (const [index, [hours, pickup, dropoff, guest, locale]] of HOURLY_STAYS.entries()) {
      const label = `${hours} hours from ${pickup} in ${locale}`;
      const pack = await seedPackage(db, { hours, texts: textsOf(FIRST.packageNames) });
      await seedPrice(db, { rate_class_id: rate.id, package_id: pack.id, price_jpy: 2500 + index * 1000 });

      const input = { id: randomUUID(), modelId: model.id, packageId: pack.id, startAt: jst(pickup), locale };
      const held = await createHold(db, input, NOW);
      assert.ok(held.ok, `${label}: ${JSON.stringify(held)}`);
      assert.equal(held.booking.endAt, jst(dropoff), `${label}: the hold's return`);

      const paid = await confirmHold(depsAt(db, fakeSquare(), NOW + MINUTE_MS), held.booking.id, payBody(guest, locale));
      assert.ok(paid.ok, `${label}: ${JSON.stringify(paid)}`);
      const { emails } = await drain(db, NOW + MINUTE_MS);

      // Closing time on the pickup's date and on the return's, neither of which is this booking's return.
      const closings = [pickup, dropoff].map((wall) => `${wall.slice(0, 10)} ${settings.close} JST`);
      const texts: [string, string][] = [
        ["guest", renderWhole(emailOf(emails, "guest_confirmation"), `${label}: guest`)],
        ["staff", renderWhole(emailOf(emails, "staff_new_booking"), `${label}: staff`)],
      ];
      for (const [reader, text] of texts) {
        assertShows(text, [`${pickup} JST`, `${dropoff} JST`], `${label}: ${reader}`);
        for (const closing of closings) {
          assert.ok(!text.includes(closing), `${label}: the ${reader} email gives closing time ${closing}\n${text}`);
        }
      }
    }
  } finally {
    await dispose();
  }
});
