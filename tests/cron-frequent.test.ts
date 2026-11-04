// runFrequent, src/lib/cron/frequent.ts: the ten-minute cron's work, on a real D1, with the real clients over one fake fetch.
// The Square client, the Sheets client with its Google token, and the mail transport all go through it, so every outbound
// request a run makes is counted where Workers would count it. The mail web app's side checks each envelope with the real
// verifyEnvelope and records the message; Google is tests/helpers/fake-google.ts over a FakeSheets, so Bookings rows are read
// from the grid. Fixtures come from the code that makes them in production (markConfirmed's three items, cancelBooking's), so
// the payloads are the ones the templates get. An expected email is renderEmail of the stored payload under the outbox row's
// dedupe key; the cancel link is signed here with node:crypto.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - deps.sendMail is what mailSender(env) returns: one MailMessage in, a SendResult out. The messageId is the dedupe key.
// - A step that fails has its error's own message in `errors`. A step that reports errors of its own, as resolveStuckPayments
//   does when Square's listing fails, has failed too, and those errors go into `errors`, and from there into cron_runs.
// - The hold expiry moves ON_HOLD rows whose expires_at <= now to EXPIRED and changes nothing else of theirs but updated_at,
//   which may stay or become `now`. No row in another status is touched, however old its expires_at.
// - A run drains exactly 10 items when more are due: the outline's limit, which keeps the run inside the subrequest budget.
// - The staff_alert for dead items names each by its outbox id or its dedupe key, and no item that did not die. One per run
//   that killed any, none for a run that killed none, and a later run's dead get an alert of their own.
import assert from "node:assert/strict";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { test } from "node:test";
import { cancelBooking } from "../src/lib/booking/cancel.ts";
import { type ConfirmContext, type DepositPayment, markConfirmed } from "../src/lib/booking/confirm.ts";
import { BOOKINGS_COLUMNS } from "../src/lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../src/lib/crypto.ts";
import { createGoogleAuth } from "../src/lib/google/auth.ts";
import { createSheetsClient, type SheetsClient } from "../src/lib/google/sheets.ts";
import { LOCALES, type Locale } from "../src/lib/locale.ts";
import { renderEmail } from "../src/lib/mail/templates.ts";
import { type MailMessage, sendMail } from "../src/lib/mail/transport.ts";
import { enqueueStatements, type EmailPayload, type OutboxItem, type SendResult } from "../src/lib/outbox.ts";
import { createSquareClient, type SquareClient } from "../src/lib/square/client.ts";
import { createTestDb } from "./helpers/d1.ts";
import { fakeGoogleSheets, GOOGLE_PRIVATE_KEY } from "./helpers/fake-google.ts";
import { createFakeSheets, type FakeSheets } from "./helpers/fake-sheets.ts";
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
} from "./helpers/seed.ts";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SITE_URL = "https://ride.okinawa-dream.example";
const STAFF_EMAIL = "front-desk@okinawa-dream.example";
const CANCEL_SECRET = `cancel-secret-${randomUUID()}`;
const MAIL_URL = "https://script.google.com/macros/s/AKfycb-ten-minute-cron/exec";
const MAIL_SECRET = `mail-secret-${randomUUID()}`;
const SHEET_ID = "sheet-of-the-ten-minute-cron";
const LOCATION = "L-OKINAWA-CRON";
const SQUARE_ORIGIN = "https://connect.squareupsandbox.com";

function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

const NOW = jst("2030-06-01 12:00");
const PICKUP = jst("2030-06-25 09:00");
const RETURN = jst("2030-06-25 18:00");

/** The deps of the ticket: what the cron entry builds from env. */
type FrequentDeps = {
  db: D1Database;
  now: number;
  square: SquareClient;
  sheets: SheetsClient;
  sendMail: (message: MailMessage) => Promise<SendResult>;
  siteUrl: string;
  cancelSecret: string;
  staffEmail: string;
};

/** The fields of the result this file reads. A field the module adds of its own is left alone. */
type FrequentResult = {
  outbox: { sent: number; retried: number; dead: { id: number; kind: string; lastError: string }[] };
  expired: number;
  stuck: { confirmed: number; reopened: number; expired: number; errors: string[] };
  refunds: { retried: number; completed: number; stillPending: number };
  errors: string[];
};

/** Loaded at each run, so a test's fixtures run first and each test fails on this module alone. */
async function runFrequent(deps: FrequentDeps): Promise<FrequentResult> {
  const { runFrequent: run } = await import("../src/lib/cron/frequent.ts");
  return (run as unknown as (deps: FrequentDeps) => Promise<FrequentResult>)(deps);
}

type Guest = { familyName: string; givenName: string; email: string; phone: string; locale: Locale };

const GUESTS: [Guest, Guest, Guest, Guest] = [
  { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.jp", phone: "090-8686-3535", locale: "ja" },
  { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929", locale: "ko" },
  { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000", locale: "zh-cn" },
  { familyName: "Zanzibarova", givenName: "Quillette", email: "q.z@example.com", phone: "+1 415 555 0134", locale: "en" },
];

type Shop = { modelId: string; packageId: string; depositJpy: number; priceJpy: number };

/** A payment as Square lists it. */
type SquarePayment = {
  id: string;
  status: string;
  amount_money: { amount: number; currency: string };
  reference_id: string;
  created_at: string;
  location_id: string;
};

type RefundBody = {
  idempotency_key: string;
  payment_id: string;
  amount_money: { amount: number; currency: string };
  reason?: string;
};

type MailReply = { status?: number; body: unknown };

type World = {
  db: D1Database;
  shop: Shop;
  sheet: FakeSheets;
  square: SquareClient;
  /** The clock of the current run, which the mail transport signs with and the mail web app checks against. */
  clock: number;
  /** Every outbound request, "METHOD url", in order. */
  calls: string[];
  /** The messages the mail web app accepted. */
  mails: MailMessage[];
  /** Why an envelope was refused, for each one the mail web app could not verify. */
  badMail: string[];
  /** The mail web app's answer to a verified message. */
  mailReply: (message: MailMessage) => MailReply;
  /** Square's payments, listed by created_at within the window asked for. */
  ledger: SquarePayment[];
  listDown: boolean;
  refundCalls: RefundBody[];
  /** The status Square gives a refund it is asked for. */
  refundStatus: (body: RefundBody) => string;
  /** The deps of a run at `now`, over this world's clients. */
  deps(now: number): FrequentDeps;
  run(now: number): Promise<FrequentResult>;
};

const ACCEPTED: MailReply = { body: { ok: true, remainingQuota: 90 } };

function textsOf(names: Record<Locale, string>, more: Record<string, string> = {}): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, { name: names[locale], ...more }])));
}

async function openShop(db: D1Database): Promise<Shop> {
  const depositJpy = 1_000 + randomInt(0, 300) * 50;
  const priceJpy = depositJpy * 3 + 700;
  await seedType(db, { deposit_jpy: depositJpy });
  await seedConfig(db);
  await seedCatalogMeta(db);
  await seedTiers(db);
  const rate = await seedRateClass(db);
  const names = { ja: "沖縄カブ 110", en: "Okinawa Cub 110", "zh-cn": "冲绳小狼 110", ko: "오키나와 커브 110" };
  const model = await seedModel(db, {
    rate_class_id: rate.id,
    texts: textsOf(names, { summary: "A summary", description: "A description" }),
  });
  const pack = await seedPackage(db, {
    texts: textsOf({ ja: "1日", en: "One day", "zh-cn": "一天", ko: "하루" }),
  });
  await seedPrice(db, { rate_class_id: rate.id, package_id: pack.id, price_jpy: priceJpy });
  return { modelId: model.id, packageId: pack.id, depositJpy, priceJpy };
}

async function mailApp(w: World, request: Request): Promise<Response> {
  const verified = await verifyEnvelope(MAIL_SECRET, await request.text(), w.clock);
  if (!verified.ok) {
    w.badMail.push(verified.reason);
    return Response.json({ ok: false, error: verified.reason, retryable: false });
  }
  const message = verified.payload as MailMessage;
  const reply = w.mailReply(message);
  const status = reply.status ?? 200;
  if (status === 200 && (reply.body as { ok?: unknown }).ok === true) w.mails.push(message);
  return new Response(JSON.stringify(reply.body), { status, headers: { "content-type": "application/json" } });
}

async function squareApi(w: World, request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/v2/payments") {
    if (w.listDown) return new Response("Service Unavailable", { status: 503 });
    const begin = Date.parse(url.searchParams.get("begin_time") ?? "");
    const end = Date.parse(url.searchParams.get("end_time") ?? "");
    const payments = w.ledger.filter(({ created_at }) => {
      const at = Date.parse(created_at);
      return at >= begin && at <= end;
    });
    return Response.json({ payments });
  }
  if (request.method === "POST" && url.pathname === "/v2/refunds") {
    const body = (await request.json()) as RefundBody;
    w.refundCalls.push(body);
    return Response.json({
      refund: {
        id: `sq-refund-${randomUUID()}`,
        status: w.refundStatus(body),
        amount_money: body.amount_money,
        payment_id: body.payment_id,
        location_id: LOCATION,
        created_at: new Date(w.clock).toISOString(),
      },
    });
  }
  const detail = `no fake for ${request.method} ${url.pathname}`;
  return Response.json({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND", detail }] }, { status: 404 });
}

/** The one fetch every client of the run goes through. */
function network(w: World): typeof fetch {
  const google = fakeGoogleSheets(() => w.sheet, SHEET_ID);
  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    w.calls.push(`${request.method} ${request.url}`);
    const url = new URL(request.url);
    if (`${url.origin}${url.pathname}` === MAIL_URL) return mailApp(w, request);
    if (url.hostname === "oauth2.googleapis.com" || url.hostname === "sheets.googleapis.com") return google(request);
    if (url.origin === SQUARE_ORIGIN) return squareApi(w, request, url);
    return new Response(`no fake for ${request.url}`, { status: 502 });
  };
  return fake;
}

async function withWorld(run: (w: World) => Promise<void>): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    const w = {
      db,
      shop: await openShop(db),
      sheet: createFakeSheets({ Bookings: [[...BOOKINGS_COLUMNS]] }),
      clock: NOW,
      calls: [],
      mails: [],
      badMail: [],
      mailReply: () => ACCEPTED,
      ledger: [],
      listDown: false,
      refundCalls: [],
      refundStatus: () => "PENDING",
    } as unknown as World;
    const fetch = network(w);
    w.square = createSquareClient({ accessToken: `EAAA-${randomUUID()}`, env: "sandbox", locationId: LOCATION, fetch });
    const auth = createGoogleAuth({
      clientEmail: "cron@okinawa-dream.iam.gserviceaccount.com",
      privateKeyPem: GOOGLE_PRIVATE_KEY,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      fetch,
      now: () => w.clock,
    });
    const sheets = createSheetsClient({ getToken: auth.getToken, fetch, spreadsheetId: SHEET_ID, sleep: async () => {} });
    const mail = (message: MailMessage) => sendMail({ url: MAIL_URL, secret: MAIL_SECRET, fetch, now: w.clock }, message);
    w.deps = (now) => ({
      db,
      now,
      square: w.square,
      sheets,
      sendMail: mail,
      siteUrl: SITE_URL,
      cancelSecret: CANCEL_SECRET,
      staffEmail: STAFF_EMAIL,
    });
    w.run = (now) => {
      w.clock = now;
      return runFrequent(w.deps(now));
    };
    await run(w);
  } finally {
    await dispose();
  }
}

/** Forgets what the fixtures sent, so a test reads only its run's requests. */
function quiet(w: World): void {
  w.calls.length = 0;
  w.mails.length = 0;
  w.badMail.length = 0;
  w.refundCalls.length = 0;
}

function refOf(): string {
  return `R${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
}

function guestColumns(guest: Guest): Partial<BookingRow> {
  return {
    locale: guest.locale,
    guest_family_name: guest.familyName,
    guest_given_name: guest.givenName,
    guest_email: guest.email,
    guest_phone: guest.phone,
  };
}

/** A web booking of the shop's model on a bike of its own: a hold made an hour ago, unless `row` says otherwise. */
function book(w: World, row: Partial<BookingRow> = {}): Promise<BookingRow> {
  return seedBooking(w.db, {
    id: randomUUID(),
    ref: refOf(),
    status: "ON_HOLD",
    source: "web",
    model_id: w.shop.modelId,
    package_id: w.shop.packageId,
    start_at: PICKUP,
    end_at: RETURN,
    expires_at: NOW + 10 * MINUTE_MS,
    price_jpy: w.shop.priceJpy,
    deposit_jpy: w.shop.depositJpy,
    locale: null,
    guest_family_name: null,
    guest_given_name: null,
    guest_email: null,
    guest_phone: null,
    created_at: NOW - HOUR_MS,
    updated_at: NOW - HOUR_MS,
    ...row,
  });
}

/** A hold that runs out at `expiresAt`, made fifteen minutes before. */
function holdUntil(w: World, expiresAt: number): Promise<BookingRow> {
  return book(w, { expires_at: expiresAt, created_at: expiresAt - 15 * MINUTE_MS, updated_at: expiresAt - 15 * MINUTE_MS });
}

/** A web booking whose charge went out at `chargedAt` and was never answered: the hold was made five minutes before. */
function charged(w: World, guest: Guest, chargedAt: number): Promise<BookingRow> {
  const createdAt = chargedAt - 5 * MINUTE_MS;
  return book(w, {
    status: "PAYMENT_PENDING",
    payment_attempt: 1 + randomInt(0, 3),
    ...guestColumns(guest),
    expires_at: createdAt + 15 * MINUTE_MS,
    created_at: createdAt,
    updated_at: chargedAt,
  });
}

/** A booking the guest has cancelled, paid with a payment of its own. */
function cancelled(w: World, guest: Guest): Promise<BookingRow> {
  return book(w, {
    status: "CANCELLED",
    payment_attempt: 1,
    ...guestColumns(guest),
    payment_id: `sq-pay-${randomUUID()}`,
    paid_jpy: w.shop.depositJpy,
    confirmed_at: NOW - 3 * DAY_MS,
    cancelled_at: NOW - 2 * HOUR_MS,
    cancel_reason: "guest",
    expires_at: NOW - 3 * DAY_MS,
  });
}

function context(w: World): ConfirmContext {
  return { square: w.square, siteUrl: SITE_URL, cancelSecret: CANCEL_SECRET, staffEmail: STAFF_EMAIL };
}

/** A booking confirmed at `at` by markConfirmed, which queues its guest email, staff email and sheet row then. */
async function confirmedAt(w: World, guest: Guest, at: number): Promise<BookingRow> {
  const pending = await charged(w, guest, at - MINUTE_MS);
  const payment: DepositPayment = {
    id: `sq-pay-${randomUUID()}`,
    amountJpy: w.shop.depositJpy,
    currency: "JPY",
    status: "COMPLETED",
  };
  assert.equal(await markConfirmed(w.db, pending.id, payment, at, context(w)), "confirmed", "fixture: markConfirmed");
  return stored(w.db, pending.id);
}

/** A booking the guest cancelled at `at` through cancelBooking, which queues its two emails and its sheet row then. */
async function cancelledAt(w: World, guest: Guest, at: number): Promise<BookingRow> {
  const booking = await book(w, {
    status: "CONFIRMED",
    payment_attempt: 1,
    ...guestColumns(guest),
    payment_id: `sq-pay-${randomUUID()}`,
    paid_jpy: w.shop.depositJpy,
    confirmed_at: at - 2 * DAY_MS,
    start_at: at + 20 * DAY_MS,
    end_at: at + 20 * DAY_MS + 9 * HOUR_MS,
    expires_at: at - 2 * DAY_MS,
  });
  const deps = { db: w.db, square: w.square, now: at, staffEmail: STAFF_EMAIL, siteUrl: SITE_URL };
  const result = await cancelBooking(deps, booking.id);
  assert.equal(result.ok, true, `fixture: cancelBooking ${JSON.stringify(result)}`);
  return stored(w.db, booking.id);
}

type Refund = { id: string; key: string; amountJpy: number; paymentId: string };

/** A refund row waiting for its first or next try, for `booking` as a cancellation leaves it. */
async function retryRow(w: World, booking: BookingRow, amountJpy: number, status = "RETRY"): Promise<Refund> {
  const row: Refund = { id: randomUUID(), key: `rf:${booking.id}`, amountJpy, paymentId: booking.payment_id as string };
  await insertRow(w.db, "refunds", {
    id: row.id,
    booking_id: booking.id,
    square_refund_id: status === "RETRY" ? null : `sq-refund-${randomUUID()}`,
    amount_jpy: amountJpy,
    status,
    origin: "cancel",
    idempotency_key: row.key,
    created_at: NOW - 2 * HOUR_MS,
    updated_at: NOW - 2 * HOUR_MS,
  });
  return row;
}

type RefundRow = { id: string; status: string; square_refund_id: string | null; amount_jpy: number; updated_at: number };

async function refundRow(db: D1Database, id: string): Promise<RefundRow> {
  const row = await db.prepare("SELECT * FROM refunds WHERE id = ?1").bind(id).first<RefundRow>();
  assert.ok(row, `no refund ${id}`);
  return row;
}

/** Square's record of a payment under `reference`. */
function squarePayment(reference: string, status: string, amount: number, at: number): SquarePayment {
  return {
    id: `sq-pay-${randomUUID()}`,
    status,
    amount_money: { amount, currency: "JPY" },
    reference_id: reference,
    created_at: new Date(at).toISOString(),
    location_id: LOCATION,
  };
}

async function stored(db: D1Database, id: string): Promise<BookingRow> {
  const row = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `no booking ${id}`);
  return row;
}

type OutboxRow = {
  id: number;
  kind: string;
  dedupe_key: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
};

async function outboxRows(db: D1Database): Promise<OutboxRow[]> {
  const sql = "SELECT id, kind, dedupe_key, payload, status, attempts, next_attempt_at FROM outbox ORDER BY id";
  return (await db.prepare(sql).all<OutboxRow>()).results;
}

async function outboxRow(db: D1Database, dedupeKey: string): Promise<OutboxRow> {
  const row = (await outboxRows(db)).find(({ dedupe_key }) => dedupe_key === dedupeKey);
  assert.ok(row, `no outbox row ${dedupeKey}`);
  return row;
}

async function enqueue(db: D1Database, items: OutboxItem[], at: number): Promise<void> {
  await db.batch(enqueueStatements(db, items, at));
}

/** An email for staff that every template field is given for. */
function staffNote(tag: string): OutboxItem {
  return {
    kind: "email",
    dedupeKey: `email:staff_alert:note-${tag}`,
    payload: {
      template: "staff_alert",
      to: STAFF_EMAIL,
      locale: "ja",
      data: { title: `Note ${tag}`, detail: `Something staff should know, ${tag}.`, ref: refOf() },
    },
  };
}

/** What the run should hand the transport for an email row: its payload rendered, under its dedupe key. */
function expectedMessage(row: OutboxRow) {
  const payload = JSON.parse(row.payload) as EmailPayload;
  const { subject, text, html } = renderEmail(payload);
  return { messageId: row.dedupe_key, to: payload.to, subject, text, html };
}

function asSent({ messageId, to, subject, text, html }: MailMessage) {
  return { messageId, to, subject, text, html };
}

function byMessageId(a: { messageId: string }, b: { messageId: string }): number {
  return a.messageId.localeCompare(b.messageId);
}

function mailOf(w: World, messageId: string): MailMessage {
  const found = w.mails.filter((mail) => mail.messageId === messageId);
  assert.equal(found.length, 1, `${messageId}: sent ${found.length} times`);
  return found[0] as MailMessage;
}

/** The link in the guest's confirmation, signed here the way the cancel page checks it. */
function cancelLink(locale: Locale, id: string): string {
  const token = createHmac("sha256", CANCEL_SECRET).update(`cancel:${id}`).digest("base64url").slice(0, 32);
  return `${SITE_URL}/${locale}/booking/cancel?b=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
}

/** The Bookings rows of a booking, as cells by header. */
function sheetRows(sheet: FakeSheets, bookingId: string): Record<string, unknown>[] {
  const [header = [], ...rows] = sheet.grid("Bookings");
  const at = header.indexOf("booking_id");
  return rows
    .filter((cells) => cells[at] === bookingId)
    .map((cells) => Object.fromEntries(header.map((name, i) => [String(name), cells[i]])));
}

/** Expired, with nothing else of the hold changed but updated_at, which may stay as it was or become the run's now. */
async function assertExpired(db: D1Database, hold: BookingRow, now: number, label: string): Promise<void> {
  const row = await stored(db, hold.id);
  assert.equal(row.status, "EXPIRED", `${label}: status`);
  assert.ok(
    row.updated_at === hold.updated_at || row.updated_at === now,
    `${label}: updated_at ${row.updated_at}, neither ${hold.updated_at} nor the run's ${now}`,
  );
  assert.deepEqual({ ...row, updated_at: hold.updated_at }, { ...hold, status: "EXPIRED" }, label);
}

async function assertUntouched(db: D1Database, rows: BookingRow[], label: string): Promise<void> {
  for (const row of rows) assert.deepEqual(await stored(db, row.id), row, `${label}: ${row.status} ${row.id}`);
}

test("drains the outbox through templates, transport and sheet sync", async () => {
  await withWorld(async (w) => {
    const queuedAt = NOW - 4 * MINUTE_MS;
    const confirmed = [
      await confirmedAt(w, GUESTS[0], queuedAt),
      await confirmedAt(w, GUESTS[1], queuedAt + SECOND_MS),
    ];
    const gone = await cancelledAt(w, GUESTS[2], queuedAt + 2 * SECOND_MS);
    const queued = await outboxRows(w.db);
    assert.equal(queued.length, 9, "fixture: three items for each booking");
    quiet(w);

    const result = await w.run(NOW);

    // Every email, rendered from its payload, under its dedupe key, through the transport the web app verified.
    const emails = queued.filter(({ kind }) => kind === "email");
    assert.deepEqual(w.mails.map(asSent).sort(byMessageId), emails.map(expectedMessage).sort(byMessageId));
    assert.deepEqual(w.badMail, []);
    for (const booking of confirmed) {
      const guestMail = mailOf(w, `email:guest_confirmation:${booking.id}`);
      assert.equal(guestMail.to, booking.guest_email);
      assert.ok(guestMail.subject.includes(booking.ref), `the subject names ${booking.ref}: ${guestMail.subject}`);
      assert.ok(guestMail.text.includes(cancelLink(booking.locale as Locale, booking.id)), guestMail.text);
      const staffMail = mailOf(w, `email:staff_new_booking:${booking.id}`);
      assert.equal(staffMail.to, STAFF_EMAIL);
      assert.ok(staffMail.text.includes(booking.vehicle_plate), staffMail.text);
    }
    assert.equal(mailOf(w, `email:guest_cancellation:${gone.id}`).to, gone.guest_email);
    assert.equal(mailOf(w, `email:staff_cancellation:${gone.id}`).to, STAFF_EMAIL);

    // Each booking once on the Bookings tab, as it stands now.
    for (const [booking, status] of [
      [confirmed[0], "CONFIRMED"],
      [confirmed[1], "CONFIRMED"],
      [gone, "CANCELLED"],
    ] as const) {
      const rows = sheetRows(w.sheet, booking.id);
      assert.equal(rows.length, 1, `${booking.id} on the Bookings tab ${rows.length} times`);
      assert.equal(rows[0]?.status, status, booking.id);
      assert.equal(rows[0]?.booking_ref, booking.ref, booking.id);
    }

    const after = await outboxRows(w.db);
    for (const row of queued) {
      assert.equal(after.find(({ dedupe_key }) => dedupe_key === row.dedupe_key)?.status, "sent", row.dedupe_key);
    }
    assert.equal(result.outbox.sent, 9);
    assert.deepEqual(result.outbox.dead, []);
    assert.deepEqual(result.errors, []);
  });
});

test("expires old holds", async () => {
  await withWorld(async (w) => {
    // Up to and including now. A handful more at random, so the count is not one number.
    const runOut = [NOW - 3 * HOUR_MS, NOW - 16 * MINUTE_MS, NOW - 1, NOW];
    const more = Array.from({ length: randomInt(1, 6) }, () => NOW - randomInt(2, 600) * SECOND_MS);
    const expiring: BookingRow[] = [];
    for (const at of [...runOut, ...more]) expiring.push(await holdUntil(w, at));
    const [nextMs, later] = [await holdUntil(w, NOW + 1), await holdUntil(w, NOW + 5 * MINUTE_MS)];

    // Other statuses, each with an expires_at long past, keep their rows. The charge in flight went out two minutes ago, so
    // it is not stuck either, and only a lost charge may ever free its bike.
    const others = [
      await book(w, {
        status: "PAYMENT_PENDING",
        payment_attempt: 1,
        ...guestColumns(GUESTS[3]),
        expires_at: NOW - 10 * MINUTE_MS,
        created_at: NOW - 25 * MINUTE_MS,
        updated_at: NOW - 2 * MINUTE_MS,
      }),
      await book(w, {
        status: "CONFIRMED",
        payment_attempt: 1,
        ...guestColumns(GUESTS[0]),
        payment_id: `sq-pay-${randomUUID()}`,
        paid_jpy: w.shop.depositJpy,
        confirmed_at: NOW - DAY_MS,
        expires_at: NOW - DAY_MS,
      }),
      await cancelled(w, GUESTS[1]),
      await book(w, { status: "EXPIRED", expires_at: NOW - 2 * DAY_MS }),
      await book(w, {
        status: "CONFIRMED",
        source: "block",
        external_ref: `ota-${randomUUID()}`,
        external_channel: "rakuten",
        price_jpy: null,
        deposit_jpy: null,
        expires_at: NOW - DAY_MS,
      }),
    ];

    const result = await w.run(NOW);

    assert.equal(result.expired, expiring.length);
    for (const hold of expiring) {
      await assertExpired(w.db, hold, NOW, `a hold that ran out ${NOW - (hold.expires_at as number)} ms before now`);
    }
    await assertUntouched(w.db, [nextMs, later, ...others], "at NOW");
    assert.deepEqual(result.errors, []);

    // Run again at the same moment: nothing is left to expire. A millisecond on, the next hold has run out.
    const again = await w.run(NOW);
    assert.equal(again.expired, 0);
    await assertUntouched(w.db, [nextMs, later, ...others], "again at NOW");

    const next = await w.run(NOW + 1);
    assert.equal(next.expired, 1);
    await assertExpired(w.db, nextMs, NOW + 1, "the hold that ran out a millisecond after NOW");
    await assertUntouched(w.db, [later, ...others], "at NOW + 1");
  });
});

type FourSteps = {
  emails: string[];
  holds: BookingRow[];
  stuck: BookingRow;
  refund: { id: string; key: string; amountJpy: number; paymentId: string };
};

/** One piece of work for each step, none of which needs another step's table. */
async function fourSteps(w: World): Promise<FourSteps> {
  const notes = [staffNote(randomUUID()), staffNote(randomUUID())];
  await enqueue(w.db, notes, NOW - 3 * MINUTE_MS);
  const holds = [await holdUntil(w, NOW - 2 * MINUTE_MS), await holdUntil(w, NOW - HOUR_MS)];
  // A charge that went out 45 minutes ago and that Square has no payment for: the resolver expires it.
  const stuck = await charged(w, GUESTS[1], NOW - 45 * MINUTE_MS);
  const refund = await retryRow(w, await cancelled(w, GUESTS[2]), 1_000 + randomInt(1, 40) * 50);
  w.refundStatus = () => "COMPLETED";
  return { emails: notes.map(({ dedupeKey }) => dedupeKey), holds, stuck, refund };
}

/** What each step leaves behind when it has done its work, as a list of what is missing. */
const DONE: Record<string, (w: World, fixture: FourSteps) => Promise<string[]>> = {
  drain: async (w, { emails }) => {
    const missing: string[] = [];
    for (const key of emails) {
      if (!w.mails.some(({ messageId }) => messageId === key)) missing.push(`${key} was not sent`);
      const row = (await outboxRows(w.db)).find(({ dedupe_key }) => dedupe_key === key);
      if (row?.status !== "sent") missing.push(`${key} is ${row?.status}`);
    }
    return missing;
  },
  expire: async (w, { holds }) => {
    const missing: string[] = [];
    for (const hold of holds) {
      const { status } = await stored(w.db, hold.id);
      if (status !== "EXPIRED") missing.push(`hold ${hold.id} is ${status}`);
    }
    return missing;
  },
  stuck: async (w, { stuck }) => {
    const { status } = await stored(w.db, stuck.id);
    return status === "EXPIRED" ? [] : [`the lost charge ${stuck.id} is ${status}`];
  },
  refunds: async (w, { refund }) => {
    const missing: string[] = [];
    if (!w.refundCalls.some(({ idempotency_key }) => idempotency_key === refund.key)) missing.push("the refund was not sent");
    const { status } = await refundRow(w.db, refund.id);
    if (status !== "COMPLETED") missing.push(`the refund row is ${status}`);
    return missing;
  },
};

type Breakage = {
  /** The step that fails, or null for a run where nothing does. */
  step: keyof typeof DONE | null;
  label: string;
  breaks(w: World): Promise<void>;
  mends(w: World): Promise<void>;
  /** What the run's errors must say. */
  cause: RegExp | null;
};

const NOTHING = async () => {};

const BREAKAGES: Breakage[] = [
  { step: null, label: "nothing fails", breaks: NOTHING, mends: NOTHING, cause: null },
  {
    step: "drain",
    label: "the outbox is out of reach",
    breaks: async (w) => {
      await w.db.prepare("ALTER TABLE outbox RENAME TO outbox_parked").run();
    },
    mends: async (w) => {
      await w.db.prepare("ALTER TABLE outbox_parked RENAME TO outbox").run();
    },
    cause: /outbox/,
  },
  {
    step: "expire",
    label: "the database refuses to expire a hold",
    breaks: async (w) => {
      await w.db
        .prepare(
          "CREATE TRIGGER refuse_expiry BEFORE UPDATE OF status ON bookings " +
            "WHEN OLD.status = 'ON_HOLD' AND NEW.status = 'EXPIRED' " +
            "BEGIN SELECT RAISE(ABORT, 'expiry refused by the test'); END",
        )
        .run();
    },
    mends: async (w) => {
      await w.db.prepare("DROP TRIGGER refuse_expiry").run();
    },
    cause: /expiry refused by the test/,
  },
  {
    step: "stuck",
    label: "Square cannot list payments",
    breaks: async (w) => {
      w.listDown = true;
    },
    mends: NOTHING,
    cause: /503/,
  },
  {
    step: "refunds",
    label: "the refunds table is out of reach",
    breaks: async (w) => {
      await w.db.prepare("ALTER TABLE refunds RENAME TO refunds_parked").run();
    },
    mends: async (w) => {
      await w.db.prepare("ALTER TABLE refunds_parked RENAME TO refunds").run();
    },
    cause: /refunds/,
  },
];

test("a failing step does not stop the rest", async () => {
  for (const { step, label, breaks, mends, cause } of BREAKAGES) {
    await withWorld(async (w) => {
      const fixture = await fourSteps(w);
      quiet(w);
      await breaks(w);
      let result: FrequentResult;
      try {
        result = await w.run(NOW);
      } catch (error) {
        assert.fail(`${label}: the run rejected instead of recording the failure: ${String(error)}`);
      } finally {
        await mends(w);
      }

      for (const [name, done] of Object.entries(DONE)) {
        const missing = await done(w, fixture);
        if (name === step) assert.notDeepEqual(missing, [], `${label}: the ${name} step did its work, so nothing failed`);
        else assert.deepEqual(missing, [], `${label}: the ${name} step`);
      }
      if (cause === null) assert.deepEqual(result.errors, [], label);
      else assert.match(result.errors.join("\n"), cause, `${label}: errors ${JSON.stringify(result.errors)}`);
    });
  }
});

test("stays within the subrequest budget", async () => {
  await withWorld(async (w) => {
    // Thirty items due, oldest first, one a minute: three bookings' sheet rows among twenty-seven emails, the sheet rows within
    // the first ten, so the run reaches the transport, Google's token, the Bookings tab and Square in one go.
    const onSheet = [
      await book(w, { status: "CONFIRMED", payment_attempt: 1, ...guestColumns(GUESTS[0]), paid_jpy: w.shop.depositJpy }),
      await book(w, { status: "CONFIRMED", payment_attempt: 1, ...guestColumns(GUESTS[1]), paid_jpy: w.shop.depositJpy }),
      await book(w, { status: "CONFIRMED", payment_attempt: 1, ...guestColumns(GUESTS[3]), paid_jpy: w.shop.depositJpy }),
    ];
    const keys: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const sheetAt = [1, 4, 7].indexOf(i);
      const booking = onSheet[sheetAt];
      const item: OutboxItem =
        booking === undefined
          ? staffNote(`${i}-${randomUUID()}`)
          : { kind: "sheet_booking", dedupeKey: `sheet:${booking.id}:CONFIRMED`, payload: { bookingId: booking.id } };
      keys.push(item.dedupeKey);
      await enqueue(w.db, [item], NOW - (40 - i) * MINUTE_MS);
    }
    // Three charges whose answers were lost, all paid, and twelve refunds waiting to be sent again.
    const lost: BookingRow[] = [];
    for (const guest of [GUESTS[0], GUESTS[2], GUESTS[3]]) {
      const booking = await charged(w, guest, NOW - randomInt(6, 25) * MINUTE_MS);
      w.ledger.push(squarePayment(booking.id, "COMPLETED", w.shop.depositJpy, booking.updated_at + 10 * SECOND_MS));
      lost.push(booking);
    }
    const waiting: Refund[] = [];
    for (let i = 0; i < 12; i += 1) waiting.push(await retryRow(w, await cancelled(w, GUESTS[i % 4] as Guest), 500 + i * 50));
    w.refundStatus = () => "COMPLETED";
    quiet(w);

    await w.run(NOW);

    assert.ok(w.calls.length < 40, `${w.calls.length} outbound requests in one run:\n${w.calls.join("\n")}`);
    // And the run did its work within them: ten of the thirty items, the listing that settles the lost charges, ten refunds.
    const sentNow = async () => (await outboxRows(w.db)).filter((row) => keys.includes(row.dedupe_key) && row.status === "sent");
    assert.equal((await sentNow()).length, 10, "items of the thirty sent");
    assert.equal(w.mails.length, 7);
    for (const booking of onSheet) assert.equal(sheetRows(w.sheet, booking.id).length, 1, booking.id);
    for (const booking of lost) assert.equal((await stored(w.db, booking.id)).status, "CONFIRMED", booking.id);
    assert.equal(w.refundCalls.length, 10);

    // The next run takes the next ten, also within the budget.
    quiet(w);
    await w.run(NOW + 10 * MINUTE_MS);
    assert.ok(w.calls.length < 40, `${w.calls.length} outbound requests in the second run:\n${w.calls.join("\n")}`);
    assert.equal((await sentNow()).length, 20, "items of the thirty sent after two runs");
    assert.equal(w.refundCalls.length, 2);
    for (const { id } of waiting) assert.equal((await refundRow(w.db, id)).status, "COMPLETED", id);
  });
});

test("stuck payments and RETRY refunds are settled by their own functions", async () => {
  await withWorld(async (w) => {
    // A charge Square took, one it never saw, one it declined, and one still within its five minutes.
    const paid = await charged(w, GUESTS[0], NOW - 9 * MINUTE_MS);
    const payment = squarePayment(paid.id, "COMPLETED", w.shop.depositJpy, paid.updated_at + 10 * SECOND_MS);
    const unseen = await charged(w, GUESTS[1], NOW - 45 * MINUTE_MS);
    // Declined: the hold it goes back to runs out seven minutes from now, so no step of this run may expire it.
    const declined = await book(w, {
      status: "PAYMENT_PENDING",
      payment_attempt: 2,
      ...guestColumns(GUESTS[2]),
      created_at: NOW - 8 * MINUTE_MS,
      expires_at: NOW + 7 * MINUTE_MS,
      updated_at: NOW - 6 * MINUTE_MS,
    });
    const fresh = await charged(w, GUESTS[3], NOW - 2 * MINUTE_MS);
    w.ledger.push(payment, squarePayment(declined.id, "FAILED", w.shop.depositJpy, declined.updated_at + 5 * SECOND_MS));

    // Three refunds waiting to be sent again, answered three ways, and one Square already has.
    const answers = ["COMPLETED", "PENDING", "REJECTED"];
    const retries: Refund[] = [];
    for (const [i, guest] of [GUESTS[0], GUESTS[1], GUESTS[3]].entries()) {
      retries.push(await retryRow(w, await cancelled(w, guest), 1_200 + i * 350 + randomInt(0, 20) * 50));
    }
    const settled = await retryRow(w, await cancelled(w, GUESTS[2]), 2_000, "PENDING");
    const settledBefore = await refundRow(w.db, settled.id);
    w.refundStatus = ({ idempotency_key }) => answers[retries.findIndex(({ key }) => key === idempotency_key)] ?? "FAILED";
    quiet(w);

    const result = await w.run(NOW);

    assert.partialDeepStrictEqual(result.stuck, { confirmed: 1, reopened: 1, expired: 1, errors: [] });
    const confirmed = await stored(w.db, paid.id);
    assert.equal(confirmed.status, "CONFIRMED");
    assert.equal(confirmed.payment_id, payment.id);
    assert.equal(confirmed.paid_jpy, w.shop.depositJpy);
    for (const key of [`email:guest_confirmation:${paid.id}`, `email:staff_new_booking:${paid.id}`, `sheet:${paid.id}:CONFIRMED`]) {
      await outboxRow(w.db, key);
    }
    assert.equal((await stored(w.db, unseen.id)).status, "EXPIRED");
    assert.deepEqual(await stored(w.db, declined.id), { ...declined, status: "ON_HOLD", updated_at: NOW });
    assert.deepEqual(await stored(w.db, fresh.id), fresh);
    // The resolver's expiry is its own: the hold count is of holds that ran out.
    assert.equal(result.expired, 0);

    assert.partialDeepStrictEqual(result.refunds, { retried: 3, completed: 1, stillPending: 1 });
    assert.deepEqual(
      w.refundCalls.map(({ idempotency_key, payment_id, amount_money }) => ({ idempotency_key, payment_id, amount_money })).sort(
        (a, b) => a.idempotency_key.localeCompare(b.idempotency_key),
      ),
      retries
        .map(({ key, paymentId, amountJpy }) => ({
          idempotency_key: key,
          payment_id: paymentId,
          amount_money: { amount: amountJpy, currency: "JPY" },
        }))
        .sort((a, b) => a.idempotency_key.localeCompare(b.idempotency_key)),
    );
    for (const [i, { id }] of retries.entries()) {
      const row = await refundRow(w.db, id);
      assert.equal(row.status, answers[i], `refund ${i}`);
      assert.notEqual(row.square_refund_id, null, `refund ${i}`);
    }
    assert.deepEqual(await refundRow(w.db, settled.id), settledBefore);
    // A refused refund is staff's to handle, and retryRefunds tells them so.
    await outboxRow(w.db, `email:staff_alert:${(retries[2] as { key: string }).key}`);
    assert.deepEqual(result.errors, []);
  });
});

/** An email that renders from what it is given and that is no staff_alert, so the run's own alerts can be told apart. */
function report(tag: string): OutboxItem {
  return {
    kind: "email",
    dedupeKey: `email:reconcile_report:${tag}`,
    payload: { template: "reconcile_report", to: STAFF_EMAIL, locale: "ja", data: { runAt: NOW - DAY_MS, issues: [] } },
  };
}

const usedIds = new Set<number>();

/** A six-digit id no other row of this file has, so a mention of it cannot be a coincidence. */
function distinctId(): number {
  for (;;) {
    const id = randomInt(100_000, 1_000_000);
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}

/** Queues `item` at `at` under an id of its own, with `attempts` already made. */
async function queueAs(db: D1Database, item: OutboxItem, at: number, attempts = 0): Promise<OutboxRow> {
  await enqueue(db, [item], at);
  await db
    .prepare("UPDATE outbox SET id = ?1, attempts = ?2 WHERE dedupe_key = ?3")
    .bind(distinctId(), attempts, item.dedupeKey)
    .run();
  return outboxRow(db, item.dedupeKey);
}

async function staffAlerts(db: D1Database): Promise<OutboxRow[]> {
  const rows = await outboxRows(db);
  return rows.filter((row) => row.kind === "email" && (JSON.parse(row.payload) as EmailPayload).template === "staff_alert");
}

/** Whether `words` name the item: its id as a number of its own, or its dedupe key. */
function names(words: string, item: OutboxRow): boolean {
  return new RegExp(`(?<!\\d)${item.id}(?!\\d)`).test(words) || words.includes(item.dedupe_key);
}

function assertNames(alert: OutboxRow, named: OutboxRow[], unnamed: OutboxRow[], label: string): void {
  const payload = JSON.parse(alert.payload) as EmailPayload;
  assert.equal(payload.to, STAFF_EMAIL, `${label}: the alert's address`);
  const { subject, text } = renderEmail(payload);
  const words = `${subject}\n${text}`;
  for (const item of named) assert.ok(names(words, item), `${label}: item ${item.id} (${item.dedupe_key}) not named in\n${words}`);
  for (const item of unnamed) assert.ok(!names(words, item), `${label}: item ${item.id} (${item.dedupe_key}) named in\n${words}`);
}

test("dead outbox items enqueue one staff_alert naming them", async () => {
  await withWorld(async (w) => {
    const queuedAt = NOW - 5 * MINUTE_MS;
    const ghost = randomUUID();
    // Refused for good by the web app; failing on its eighth try; a sheet row for a booking that does not exist; delivered;
    // failing on its first try.
    const refused = await queueAs(w.db, report(`refused-${randomUUID()}`), queuedAt);
    const worn = await queueAs(w.db, report(`worn-${randomUUID()}`), queuedAt, 7);
    const orphan = await queueAs(
      w.db,
      { kind: "sheet_booking", dedupeKey: `sheet:${ghost}:CONFIRMED`, payload: { bookingId: ghost } },
      queuedAt,
    );
    const delivered = await queueAs(w.db, report(`delivered-${randomUUID()}`), queuedAt);
    const retried = await queueAs(w.db, report(`retried-${randomUUID()}`), queuedAt);
    const refusedLater = report(`refused-later-${randomUUID()}`);
    const replies: Record<string, MailReply> = {
      [refused.dedupe_key]: { body: { ok: false, error: "Invalid email address", retryable: false } },
      [refusedLater.dedupeKey]: { body: { ok: false, error: "Invalid email address", retryable: false } },
      [worn.dedupe_key]: { status: 503, body: { error: "unavailable" } },
      [retried.dedupe_key]: { status: 503, body: { error: "unavailable" } },
    };
    w.mailReply = ({ messageId }) => replies[messageId] ?? ACCEPTED;

    const first = await w.run(NOW);

    assert.deepEqual(
      first.outbox.dead.map(({ id }) => id).sort(),
      [refused.id, worn.id, orphan.id].sort(),
      "fixture: the items that die",
    );
    const firstAlerts = await staffAlerts(w.db);
    assert.equal(firstAlerts.length, 1, `staff_alerts after the first run: ${JSON.stringify(firstAlerts)}`);
    assertNames(firstAlerts[0] as OutboxRow, [refused, worn, orphan], [delivered, retried], "the first run");

    // A later run that kills another item alerts once more, for that item alone.
    const late = await queueAs(w.db, refusedLater, NOW + HOUR_MS);
    const second = await w.run(NOW + 2 * HOUR_MS);
    assert.deepEqual(second.outbox.dead.map(({ id }) => id), [late.id], "fixture: the item that dies in the second run");
    const secondAlerts = (await staffAlerts(w.db)).filter(({ id }) => !firstAlerts.some((alert) => alert.id === id));
    assert.equal(secondAlerts.length, 1, `new staff_alerts after the second run: ${JSON.stringify(secondAlerts)}`);
    assertNames(secondAlerts[0] as OutboxRow, [late], [refused, worn, orphan, delivered, retried], "the second run");

    // A run that kills nothing alerts nobody.
    const third = await w.run(NOW + 4 * HOUR_MS);
    assert.deepEqual(third.outbox.dead, [], "fixture: nothing dies in the third run");
    assert.equal((await staffAlerts(w.db)).length, 2, "staff_alerts after a run that killed nothing");
  });
});
