// The ten-minute cron and the drain after a request, through the built Worker in Miniflare. `outbound` fakes everything the
// Worker reaches: the mail web app, which checks each envelope with the real verifyEnvelope under testVars.MAIL_SECRET and
// records the message; Google's token and the Sheets API over a FakeSheets (tests/helpers/fake-google.ts), so Bookings rows
// are read from the grid; and Square's payments and refunds. Anything else is a stray and fails the test. The Worker reads the
// real clock, so times are set from now. Cancel links are signed here with node:crypto, and webhook signatures too.
//
// Outbox items a test queues itself come from markConfirmed, run in Node against the Worker's own D1, so nothing but the cron
// can have sent them. Each test starts with nothing waiting: what an earlier one left is delivered first.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - A failing step leaves the run's cron_runs row with status error and the step's error in detail, and the other steps
//   still do their work in that run.
// - "Within that request's waitUntil": the response does not wait for the mail web app, and the guest's and staff's emails
//   and the Bookings row land afterwards with no cron run. The same holds after the cancel page's POST and after a Square
//   webhook that confirms a booking.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type DepositPayment, markConfirmed } from "../../src/lib/booking/confirm.ts";
import { BOOKINGS_COLUMNS } from "../../src/lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../../src/lib/crypto.ts";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import type { MailMessage } from "../../src/lib/mail/transport.ts";
import { drainOutbox, enqueueStatements } from "../../src/lib/outbox.ts";
import type { SquareClient } from "../../src/lib/square/client.ts";
import { fakeGoogleSheets, GOOGLE_PRIVATE_KEY } from "../helpers/fake-google.ts";
import { createFakeSheets, type FakeSheets } from "../helpers/fake-sheets.ts";
import {
  type BookingRow,
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
} from "../helpers/seed.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const FREQUENT = "*/10 * * * *";
const SQUARE_HOST = "https://connect.squareupsandbox.com";
/** How long a response may take while the mail web app has not answered: a request that waits on it never comes back. */
const RESPONSE_MS = 8_000;
/** How long the drain after a request, or a cron run, may take to show. */
const SETTLE_MS = 10_000;

type Json = Record<string, unknown>;
type Guest = { familyName: string; givenName: string; email: string; phone: string };
type Stay = { modelId: string; packageId: string; priceJpy: number; depositJpy: number; names: Record<Locale, string> };

const HANAKO: Guest = { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.jp", phone: "090-8686-3535" };
const MINHO: Guest = { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929" };
const NA: Guest = { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000" };

let worker: TestWorker;
let stay: Stay;
const sheet: FakeSheets = createFakeSheets({ Bookings: [[...BOOKINGS_COLUMNS]] });
const google = fakeGoogleSheets(() => sheet, testVars.GOOGLE_SHEET_ID);

/** The messages the mail web app accepted, and why it refused any envelope it could not verify. */
const mails: MailMessage[] = [];
const badEnvelopes: string[] = [];
/** While set, the mail web app answers nothing until it settles. */
let mailGate: Promise<void> | null = null;

/** Square's payments, listed by created_at within the window asked for, and the refunds it was asked for. */
const ledger: Json[] = [];
const refundCalls: Json[] = [];

const strays: string[] = [];

async function mailApp(request: Request): Promise<Response> {
  const text = await request.text();
  if (mailGate !== null) await mailGate;
  const verified = await verifyEnvelope(testVars.MAIL_SECRET, text, Date.now());
  if (!verified.ok) {
    badEnvelopes.push(verified.reason);
    return Response.json({ ok: false, error: verified.reason, retryable: false });
  }
  mails.push(verified.payload as MailMessage);
  return Response.json({ ok: true, remainingQuota: 90 });
}

async function square(request: Request, url: URL): Promise<Response> {
  const at = new Date().toISOString();
  if (request.method === "GET" && url.pathname === "/v2/payments") {
    const begin = Date.parse(url.searchParams.get("begin_time") ?? "");
    const end = Date.parse(url.searchParams.get("end_time") ?? "");
    const payments = ledger.filter((payment) => {
      const created = Date.parse(payment.created_at as string);
      return created >= begin && created <= end;
    });
    return Response.json({ payments });
  }
  if (request.method === "POST" && url.pathname === "/v2/payments") {
    const body = (await request.json()) as Json;
    return Response.json({
      payment: {
        id: `sq-pay-${randomUUID()}`,
        status: "COMPLETED",
        amount_money: body.amount_money,
        reference_id: body.reference_id,
        location_id: testVars.SQUARE_LOCATION_ID,
        created_at: at,
      },
    });
  }
  if (request.method === "POST" && url.pathname === "/v2/refunds") {
    const body = (await request.json()) as Json;
    refundCalls.push(body);
    return Response.json({
      refund: {
        id: `sq-refund-${randomUUID()}`,
        status: "COMPLETED",
        amount_money: body.amount_money,
        payment_id: body.payment_id,
        location_id: testVars.SQUARE_LOCATION_ID,
        created_at: at,
      },
    });
  }
  strays.push(`${request.method} ${request.url}`);
  return Response.json({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND", detail: "not faked" }] }, { status: 404 });
}

async function outbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (`${url.origin}${url.pathname}` === testVars.APPS_SCRIPT_MAIL_URL) return mailApp(request);
  if (url.hostname === "oauth2.googleapis.com" || url.hostname === "sheets.googleapis.com") return google(request);
  if (url.origin === SQUARE_HOST) return square(request, url);
  strays.push(`${request.method} ${request.url}`);
  return new Response(`no fake for ${request.url}`, { status: 502 });
}

function textsOf(names: Record<Locale, string>, more: Record<string, string> = {}): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, { name: names[locale], ...more }])));
}

before(async () => {
  worker = await startWorker({ vars: { GOOGLE_SA_PRIVATE_KEY: GOOGLE_PRIVATE_KEY }, outbound });
  const { db } = worker;
  await seedType(db, { deposit_jpy: 33_000 });
  await seedConfig(db);
  await seedCatalogMeta(db);
  await seedTiers(db);
  const names = { ja: "琉球フォルツァ 250", en: "Ryukyu Forza 250", "zh-cn": "琉球佛沙 250", ko: "류큐 포르자 250" };
  const rate = await seedRateClass(db);
  const model = await seedModel(db, {
    rate_class_id: rate.id,
    texts: textsOf(names, { summary: "A summary", description: "A description" }),
  });
  const pack = await seedPackage(db, { texts: textsOf({ ja: "1日", en: "One day", "zh-cn": "一天", ko: "하루" }) });
  await seedPrice(db, { rate_class_id: rate.id, package_id: pack.id, price_jpy: 64_250 });
  stay = { modelId: model.id, packageId: pack.id, priceJpy: 64_250, depositJpy: 12_500, names };
});

after(async () => {
  await worker?.stop();
});

beforeEach(async () => {
  // What an earlier test left waiting is delivered, so each test's drain reaches its own items.
  await drainOutbox({
    db: worker.db,
    now: Date.now() + DAY_MS,
    limit: 100,
    sendEmail: async () => ({ ok: true }),
    syncBookings: async () => ({ ok: true }),
  });
  strays.length = 0;
  badEnvelopes.length = 0;
});

afterEach(() => {
  assert.deepEqual(strays, [], "the Worker called out to something no fake answers");
  assert.deepEqual(badEnvelopes, [], "the mail web app got envelopes it could not verify");
});

/** Polls `read` until it gives a value, for up to `timeoutMs`. */
async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, timeoutMs = SETTLE_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await sleep(50);
  }
}

function guestColumns(guest: Guest, locale: Locale): Partial<BookingRow> {
  return {
    locale,
    guest_family_name: guest.familyName,
    guest_given_name: guest.givenName,
    guest_email: guest.email,
    guest_phone: guest.phone,
  };
}

/** A web booking of the stay, a hold with ten minutes left unless `row` says otherwise. */
function book(row: Partial<BookingRow> = {}): Promise<BookingRow> {
  const startAt = Date.parse("2031-03-15T09:00:00+09:00");
  return seedBooking(worker.db, {
    id: randomUUID(),
    status: "ON_HOLD",
    model_id: stay.modelId,
    package_id: stay.packageId,
    start_at: startAt,
    end_at: startAt + 9 * HOUR_MS,
    expires_at: Date.now() + 10 * MINUTE_MS,
    price_jpy: stay.priceJpy,
    deposit_jpy: stay.depositJpy,
    locale: null,
    guest_family_name: null,
    guest_given_name: null,
    guest_email: null,
    guest_phone: null,
    created_at: Date.now() - 20 * MINUTE_MS,
    updated_at: Date.now() - 20 * MINUTE_MS,
    ...row,
  });
}

/** A booking whose charge went out at `chargedAt`, five minutes after its hold was made. */
function charged(guest: Guest, locale: Locale, chargedAt: number): Promise<BookingRow> {
  return book({
    status: "PAYMENT_PENDING",
    payment_attempt: 1,
    ...guestColumns(guest, locale),
    created_at: chargedAt - 5 * MINUTE_MS,
    expires_at: chargedAt + 10 * MINUTE_MS,
    updated_at: chargedAt,
  });
}

/** markConfirmed calls Square only to send money back, which a payment of the deposit never needs. */
const NO_SQUARE = new Proxy({} as SquareClient, {
  get: (_target, name) => () => Promise.reject(new Error(`fixture: markConfirmed called Square's ${String(name)}`)),
});

function cancelToken(id: string): string {
  return createHmac("sha256", testVars.CANCEL_LINK_SECRET).update(`cancel:${id}`).digest("base64url").slice(0, 32);
}

function cancelUrl(locale: Locale, id: string): string {
  return `${testVars.SITE_URL}/${locale}/booking/cancel?b=${encodeURIComponent(id)}&t=${encodeURIComponent(cancelToken(id))}`;
}

async function stored(id: string): Promise<BookingRow> {
  const row = await worker.db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `no booking ${id}`);
  return row;
}

async function outboxStatus(dedupeKey: string): Promise<string | null> {
  const row = await worker.db
    .prepare("SELECT status FROM outbox WHERE dedupe_key = ?1")
    .bind(dedupeKey)
    .first<{ status: string }>();
  return row?.status ?? null;
}

/** The one message the mail web app accepted under `messageId`, if any. */
function mailOf(messageId: string): MailMessage | undefined {
  const found = mails.filter((mail) => mail.messageId === messageId);
  assert.ok(found.length <= 1, `${messageId} was delivered ${found.length} times`);
  return found[0];
}

/** Every key's email accepted by the mail web app, and every key's outbox row sent. */
async function delivered(keys: string[]): Promise<boolean> {
  for (const key of keys) {
    if (key.startsWith("email:") && mailOf(key) === undefined) return false;
    if ((await outboxStatus(key)) !== "sent") return false;
  }
  return true;
}

/** The Bookings rows of a booking, as cells by header. */
function sheetRows(bookingId: string): Record<string, unknown>[] {
  const [header = [], ...rows] = sheet.grid("Bookings");
  const at = header.indexOf("booking_id");
  return rows
    .filter((cells) => cells[at] === bookingId)
    .map((cells) => Object.fromEntries(header.map((name, i) => [String(name), cells[i]])));
}

/** What a confirmation queues, by markConfirmed's keys. */
function confirmationKeys(id: string): string[] {
  return [`email:guest_confirmation:${id}`, `email:staff_new_booking:${id}`, `sheet:${id}:CONFIRMED`];
}

/** The guest's and the staff's confirmation emails as they must reach the mail web app, and the Bookings row. */
function assertConfirmationDelivered(booking: BookingRow, guest: Guest, locale: Locale): void {
  const guestMail = mailOf(`email:guest_confirmation:${booking.id}`);
  assert.ok(guestMail, "the guest's confirmation");
  assert.equal(guestMail.to, guest.email);
  assert.ok(guestMail.subject.includes(booking.ref), guestMail.subject);
  assert.ok(guestMail.text.includes(cancelUrl(locale, booking.id)), `no cancel link in\n${guestMail.text}`);
  assert.ok(guestMail.text.includes(stay.names[locale]), `no ${stay.names[locale]} in\n${guestMail.text}`);
  const staffMail = mailOf(`email:staff_new_booking:${booking.id}`);
  assert.ok(staffMail, "the staff's notice");
  assert.equal(staffMail.to, testVars.STAFF_EMAIL);
  assert.ok(staffMail.text.includes(booking.vehicle_plate), staffMail.text);
  const rows = sheetRows(booking.id);
  assert.equal(rows.length, 1, `${booking.id} on the Bookings tab ${rows.length} times`);
  assert.equal(rows[0]?.status, "CONFIRMED");
  assert.equal(rows[0]?.booking_ref, booking.ref);
}

type CronRow = { cron: string; status: string; detail: string | null };

async function cronRunsAt(scheduledAt: number): Promise<CronRow[]> {
  const sql = "SELECT cron, status, detail FROM cron_runs WHERE scheduled_at = ?1";
  return (await worker.db.prepare(sql).bind(scheduledAt).all<CronRow>()).results;
}

async function cronRunCount(): Promise<number> {
  return (await worker.db.prepare("SELECT COUNT(*) AS n FROM cron_runs").first<{ n: number }>())?.n ?? -1;
}

/** Triggers the ten-minute cron at now and waits for the row its run leaves. */
async function runTenMinuteCron(): Promise<CronRow[]> {
  const scheduledAt = Date.now();
  await worker.scheduled(FREQUENT, scheduledAt);
  await until(async () => (await cronRunsAt(scheduledAt)).length > 0, `the cron_runs row of the run at ${scheduledAt}`);
  return cronRunsAt(scheduledAt);
}

test("the ten-minute cron sends queued email on the built Worker", async () => {
  // A booking confirmed two minutes ago, whose three items wait in the outbox.
  const confirmedAt = Date.now() - 2 * MINUTE_MS;
  const pending = await charged(MINHO, "ko", confirmedAt - MINUTE_MS);
  const payment: DepositPayment = { id: `sq-pay-${randomUUID()}`, amountJpy: stay.depositJpy, currency: "JPY", status: "COMPLETED" };
  const context = {
    square: NO_SQUARE,
    siteUrl: testVars.SITE_URL,
    cancelSecret: testVars.CANCEL_LINK_SECRET,
    staffEmail: testVars.STAFF_EMAIL,
  };
  assert.equal(await markConfirmed(worker.db, pending.id, payment, confirmedAt, context), "confirmed", "fixture");
  const booking = await stored(pending.id);

  // A hold that ran out a minute ago and one with time left; a charge whose answer was lost and that Square took; a refund
  // waiting to be sent again.
  const lapsed = await book({ expires_at: Date.now() - MINUTE_MS });
  const live = await book({ expires_at: Date.now() + 30 * MINUTE_MS });
  const lost = await charged(HANAKO, "ja", Date.now() - 12 * MINUTE_MS);
  const lostPayment = {
    id: `sq-pay-${randomUUID()}`,
    status: "COMPLETED",
    amount_money: { amount: stay.depositJpy, currency: "JPY" },
    reference_id: lost.id,
    location_id: testVars.SQUARE_LOCATION_ID,
    created_at: new Date(lost.updated_at + 5 * SECOND_MS).toISOString(),
  };
  ledger.push(lostPayment);
  const gone = await book({
    status: "CANCELLED",
    payment_attempt: 1,
    ...guestColumns(NA, "zh-cn"),
    payment_id: `sq-pay-${randomUUID()}`,
    paid_jpy: stay.depositJpy,
    confirmed_at: Date.now() - 3 * DAY_MS,
    cancelled_at: Date.now() - HOUR_MS,
    cancel_reason: "guest",
  });
  const refundId = randomUUID();
  await insertRow(worker.db, "refunds", {
    id: refundId,
    booking_id: gone.id,
    amount_jpy: 6_250,
    status: "RETRY",
    origin: "cancel",
    idempotency_key: `rf:${gone.id}`,
    created_at: Date.now() - HOUR_MS,
    updated_at: Date.now() - HOUR_MS,
  });

  const runs = await runTenMinuteCron();

  assert.deepEqual(runs, [{ cron: FREQUENT, status: "ok", detail: null }]);
  for (const key of confirmationKeys(booking.id)) assert.equal(await outboxStatus(key), "sent", key);
  assertConfirmationDelivered(booking, MINHO, "ko");
  assert.equal((await stored(lapsed.id)).status, "EXPIRED");
  assert.equal((await stored(live.id)).status, "ON_HOLD");
  const settled = await stored(lost.id);
  assert.equal(settled.status, "CONFIRMED", "the lost charge Square took");
  assert.equal(settled.payment_id, lostPayment.id);
  const refund = await worker.db
    .prepare("SELECT status FROM refunds WHERE id = ?1")
    .bind(refundId)
    .first<{ status: string }>();
  assert.equal(refund?.status, "COMPLETED");
  const sentBack = refundCalls.filter((call) => call.idempotency_key === `rf:${gone.id}`);
  assert.equal(sentBack.length, 1);
  assert.deepEqual(sentBack[0]?.amount_money, { amount: 6_250, currency: "JPY" });
  assert.equal(sentBack[0]?.payment_id, gone.payment_id);
});

test("a failing step is recorded in cron_runs.detail and the other steps still run", async () => {
  const key = `email:staff_alert:note-${randomUUID()}`;
  await worker.db.batch(
    enqueueStatements(
      worker.db,
      [
        {
          kind: "email",
          dedupeKey: key,
          payload: {
            template: "staff_alert",
            to: testVars.STAFF_EMAIL,
            locale: "ja",
            data: { title: "A note for staff", detail: "Something staff should know." },
          },
        },
      ],
      Date.now() - 3 * MINUTE_MS,
    ),
  );
  const lapsed = await book({ expires_at: Date.now() - 2 * MINUTE_MS });

  // The refunds table is out of reach for this run, as a D1 that fails leaves it: the refund step fails.
  await worker.db.prepare("ALTER TABLE refunds RENAME TO refunds_parked").run();
  let runs: CronRow[];
  try {
    runs = await runTenMinuteCron();
  } finally {
    await worker.db.prepare("ALTER TABLE refunds_parked RENAME TO refunds").run();
  }

  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.equal(runs[0]?.status, "error", JSON.stringify(runs));
  assert.match(runs[0]?.detail ?? "", /refunds/, JSON.stringify(runs));
  assert.equal(await outboxStatus(key), "sent");
  assert.equal(mailOf(key)?.to, testVars.STAFF_EMAIL);
  assert.equal((await stored(lapsed.id)).status, "EXPIRED");
});

test("a confirm sends its emails through waitUntil", async () => {
  const hold = await book();
  const cronRuns = await cronRunCount();
  let release = () => {};
  mailGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const answer = (async () => {
      const res = await worker.fetch(`/api/holds/${hold.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: `cnon:${randomUUID()}`, guest: HANAKO, locale: "ja" }),
      });
      return { status: res.status, text: await res.text() };
    })();
    answer.catch(() => {});
    const first = await Promise.race([answer, sleep(RESPONSE_MS).then(() => null)]);
    assert.ok(first !== null, `the confirm's response waited ${RESPONSE_MS} ms on the mail web app`);
    assert.equal(first.status, 200, first.text);
  } finally {
    release();
    mailGate = null;
  }

  const booking = await stored(hold.id);
  assert.equal(booking.status, "CONFIRMED");
  await until(() => delivered(confirmationKeys(hold.id)), "the confirmation's emails and Bookings row");
  assertConfirmationDelivered(booking, HANAKO, "ja");
  assert.equal(await cronRunCount(), cronRuns, "a cron ran");
});

test("the cancel page's POST sends its emails through waitUntil", async () => {
  const startAt = Date.now() + 20 * DAY_MS;
  const booking = await book({
    status: "CONFIRMED",
    payment_attempt: 1,
    ...guestColumns(MINHO, "en"),
    start_at: startAt,
    end_at: startAt + 9 * HOUR_MS,
    expires_at: Date.now() - DAY_MS,
    payment_id: `sq-pay-${randomUUID()}`,
    paid_jpy: stay.depositJpy,
    confirmed_at: Date.now() - DAY_MS,
  });
  const cronRuns = await cronRunCount();

  const res = await worker.fetch(`/en/booking/cancel?b=${encodeURIComponent(booking.id)}&t=${encodeURIComponent(cancelToken(booking.id))}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost" },
    body: "",
  });
  await res.text();
  assert.equal(res.status, 200);
  assert.equal((await stored(booking.id)).status, "CANCELLED");

  const keys = [
    `email:guest_cancellation:${booking.id}`,
    `email:staff_cancellation:${booking.id}`,
    `sheet:${booking.id}:CANCELLED`,
  ];
  await until(() => delivered(keys), "the cancellation's emails and Bookings row");
  assert.equal(mailOf(keys[0] as string)?.to, MINHO.email);
  assert.ok(mailOf(keys[0] as string)?.subject.includes(booking.ref));
  assert.equal(mailOf(keys[1] as string)?.to, testVars.STAFF_EMAIL);
  const rows = sheetRows(booking.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "CANCELLED");
  assert.equal(await cronRunCount(), cronRuns, "a cron ran");
});

test("a Square webhook that confirms a booking sends its emails through waitUntil", async () => {
  const pending = await charged(NA, "zh-cn", Date.now() - MINUTE_MS);
  const paymentId = `sq-pay-${randomUUID()}`;
  const money = { amount: stay.depositJpy, currency: "JPY" };
  const body = JSON.stringify({
    merchant_id: "MLQ8EXAMPLEOKINAWA",
    type: "payment.updated",
    event_id: randomUUID(),
    created_at: new Date().toISOString(),
    data: {
      type: "payment",
      id: paymentId,
      object: {
        payment: {
          id: paymentId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          amount_money: money,
          total_money: money,
          approved_money: money,
          status: "COMPLETED",
          source_type: "CARD",
          location_id: testVars.SQUARE_LOCATION_ID,
          order_id: `order-${randomUUID()}`,
          reference_id: pending.id,
          version: 4,
        },
      },
    },
  });
  const signature = createHmac("sha256", testVars.SQUARE_WEBHOOK_SIGNATURE_KEY)
    .update(testVars.SQUARE_WEBHOOK_URL + body)
    .digest("base64");
  const cronRuns = await cronRunCount();

  const res = await worker.fetch("/api/webhooks/square", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-square-hmacsha256-signature": signature },
    body,
  });
  await res.text();
  assert.equal(res.status, 200);

  const booking = await stored(pending.id);
  assert.equal(booking.status, "CONFIRMED");
  await until(() => delivered(confirmationKeys(pending.id)), "the confirmation's emails and Bookings row");
  assertConfirmationDelivered(booking, NA, "zh-cn");
  assert.equal(await cronRunCount(), cronRuns, "a cron ran");
});
