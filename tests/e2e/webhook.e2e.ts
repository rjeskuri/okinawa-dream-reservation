// POST /api/webhooks/square through the built Worker in Miniflare. Every signature is built here with node:crypto, the way
// Square signs a notification: the base64 HMAC-SHA256, under SQUARE_WEBHOOK_SIGNATURE_KEY, of SQUARE_WEBHOOK_URL followed by
// the raw body, both from testVars. Square's HTTP API is faked in `outbound`, so a refund the Worker sends shows there, mapped
// by the real client. Events follow Square's documented shape. The Worker reads the real clock, so times are checked only
// against it. Expected values are literals, testVars, or come from node:crypto, never from the code under test.
//
// Every POST says Content-Type: application/json, as Square's do.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - Only the status is the route's to answer for; the body of a 200, 401, 413 or 5xx is free, since Square reads the status.
// - The signature is checked against SQUARE_WEBHOOK_URL as configured, never the URL the request arrived on, which behind a
//   tunnel or a proxy is not the one Square signed.
// - A body past 64 KiB, counted in bytes as src/lib/request-body.ts counts them, gets 413 before the signature is checked,
//   the status the publish routes give past the same limit. A body of exactly 64 KiB is read and handled.
// - An event the handler fails on gets a 5xx and is left unseen, so Square's redelivery is handled. It never gets a 200.
//
// A signature header with whitespace after it is not among the forgeries: the Fetch spec strips a header value's leading and
// trailing whitespace before the Worker sees it, so it arrives as the valid signature. tests/square-webhook-signature.test.ts
// refuses it at verifySquareSignature itself.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { drainOutbox, type EmailPayload } from "../../src/lib/outbox.ts";
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
} from "../helpers/seed.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const ROUTE = "/api/webhooks/square";
const SIGNATURE_HEADER = "x-square-hmacsha256-signature";

const SQUARE_HOST = "https://connect.squareupsandbox.com";
const REFUNDS = "/v2/refunds";

/** Square's cap on an idempotency key. */
const MAX_KEY_LENGTH = 45;

/** 64 * 1024, the limit of src/lib/request-body.ts. A body of this many bytes is read and one more is not. */
const LIMIT_BYTES = 65_536;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type Json = Record<string, unknown>;
type Guest = { familyName: string; givenName: string; email: string; phone: string };
type Stay = { names: Record<Locale, string>; priceJpy: number; depositJpy: number; modelId: string; packageId: string };
type Sent = { url: URL; method: string; authorization: string | null; body: Json };

const HANAKO: Guest = { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.jp", phone: "090-8686-3535" };
const MINHO: Guest = { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929" };

let worker: TestWorker;
let first: Stay;
let second: Stay;
let sent: Sent[] = [];

function textsOf(names: Record<Locale, string>, more: Record<string, string> = {}): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, { name: names[locale], ...more }])));
}

async function publish(db: D1Database, names: Record<Locale, string>, priceJpy: number, depositJpy: number): Promise<Stay> {
  const rate = await seedRateClass(db);
  const model = await seedModel(db, { rate_class_id: rate.id, texts: textsOf(names, { summary: "A summary", description: "A description" }) });
  const pack = await seedPackage(db, { texts: textsOf(names) });
  await seedPrice(db, { rate_class_id: rate.id, package_id: pack.id, price_jpy: priceJpy });
  return { names, priceJpy, depositJpy, modelId: model.id, packageId: pack.id };
}

/** Square's reply to a refund: on its way, for what was asked. */
function refundReply(call: Sent): Response {
  return Response.json({
    refund: {
      id: `sq-refund-${randomUUID()}`,
      status: "PENDING",
      amount_money: call.body.amount_money,
      payment_id: call.body.payment_id,
      created_at: new Date().toISOString(),
    },
  });
}

before(async () => {
  worker = await startWorker({
    outbound: async (request) => {
      // A handled event drains the outbox after it commits (#42). The mail web app and Google are down in this file, so the
      // items stay for deliver(), and `sent` holds only what the Worker asked of Square.
      if (new URL(request.url).origin !== SQUARE_HOST) {
        await request.body?.cancel();
        return new Response("the mail web app and Google are down in this file", { status: 503 });
      }
      const text = await request.text();
      const call: Sent = {
        url: new URL(request.url),
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: text === "" ? {} : (JSON.parse(text) as Json),
      };
      sent.push(call);
      return call.url.pathname === REFUNDS ? refundReply(call) : new Response("not faked in this file", { status: 500 });
    },
  });
  const { db } = worker;
  await seedType(db, { deposit_jpy: 33_000 });
  await seedConfig(db);
  await seedCatalogMeta(db);
  await seedTiers(db);
  first = await publish(db, { ja: "沖縄カブ 110", en: "Okinawa Cub 110", "zh-cn": "冲绳小狼 110", ko: "오키나와 커브 110" }, 18_700, 7_300);
  second = await publish(
    db,
    { ja: "琉球フォルツァ 250", en: "Ryukyu Forza 250", "zh-cn": "琉球佛沙 250", ko: "류큐 포르자 250" },
    64_250,
    12_500,
  );
});

after(async () => {
  await worker?.stop();
});

beforeEach(async () => {
  sent = [];
  // What an earlier test left waiting is delivered, so each one reads only its own.
  await deliver();
});

function guestColumns(guest: Guest): Partial<BookingRow> {
  return {
    guest_family_name: guest.familyName,
    guest_given_name: guest.givenName,
    guest_email: guest.email,
    guest_phone: guest.phone,
  };
}

/**
 * A web booking, a hold by default. Its times are set from the real clock, as confirmHold sets updated_at when it starts an
 * attempt: seedBooking's own default is a day before the 2031 pickup, after every payment here was created.
 */
function book(stay: Stay, row: Partial<BookingRow> = {}): Promise<BookingRow> {
  return seedBooking(worker.db, {
    created_at: Date.now() - 10 * MINUTE_MS,
    updated_at: Date.now() - 5 * MINUTE_MS,
    id: randomUUID(),
    status: "ON_HOLD",
    model_id: stay.modelId,
    package_id: stay.packageId,
    start_at: Date.parse("2031-03-15T09:00:00+09:00"),
    end_at: Date.parse("2031-03-17T18:00:00+09:00"),
    expires_at: Date.now() + 10 * MINUTE_MS,
    price_jpy: stay.priceJpy,
    deposit_jpy: stay.depositJpy,
    locale: "en",
    guest_family_name: null,
    guest_given_name: null,
    guest_email: null,
    guest_phone: null,
    ...row,
  });
}

function pendingRow(guest: Guest, locale: Locale): Partial<BookingRow> {
  return { status: "PAYMENT_PENDING", payment_attempt: 1, locale, ...guestColumns(guest) };
}

function paidRow(stay: Stay, guest: Guest, paymentId: string, status: "CONFIRMED" | "CANCELLED"): Partial<BookingRow> {
  const cancelled = status === "CANCELLED" ? { cancelled_at: Date.now() - HOUR_MS, cancel_reason: "guest" } : {};
  return {
    status,
    payment_attempt: 1,
    payment_id: paymentId,
    paid_jpy: stay.depositJpy,
    confirmed_at: Date.now() - DAY_MS,
    ...guestColumns(guest),
    ...cancelled,
  };
}

async function stored(id: string): Promise<BookingRow> {
  const row = await worker.db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
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
};

async function refundsOf(bookingId: string): Promise<RefundRow[]> {
  const sql = "SELECT * FROM refunds WHERE booking_id = ?1 ORDER BY created_at, id";
  return (await worker.db.prepare(sql).bind(bookingId).all<RefundRow>()).results;
}

/** Everything a refused delivery must leave alone, the record of events seen included. */
async function snapshot(withEvents = true): Promise<unknown[]> {
  const rows = async (sql: string) => (await worker.db.prepare(sql).all()).results;
  const tables = [
    await rows("SELECT * FROM bookings ORDER BY id"),
    await rows("SELECT * FROM refunds ORDER BY id"),
    await rows("SELECT * FROM outbox ORDER BY id"),
  ];
  return withEvents ? [...tables, await rows("SELECT * FROM webhook_events ORDER BY event_id")] : tables;
}

/** Items queued and not delivered. The drain after an event (#42) may hold them as 'sending' when this reads. */
async function waitingItems(): Promise<number> {
  const sql = "SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending', 'sending')";
  const row = await worker.db.prepare(sql).first<{ n: number }>();
  return row?.n ?? -1;
}

/** Every email and sheet item due, which also leaves the outbox with nothing waiting. */
async function deliver(): Promise<{ emails: EmailPayload[]; sheets: string[] }> {
  const emails: EmailPayload[] = [];
  const sheets: string[] = [];
  await drainOutbox({
    db: worker.db,
    now: Date.now() + DAY_MS,
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

function hmac(key: string, text: string) {
  return createHmac("sha256", key).update(text, "utf8");
}

/** As Square signs a notification to the configured URL. */
function sign(body: string): string {
  return hmac(testVars.SQUARE_WEBHOOK_SIGNATURE_KEY, testVars.SQUARE_WEBHOOK_URL + body).digest("base64");
}

async function post(body: string, signature: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Square Connect v2" };
  if (signature !== null) headers[SIGNATURE_HEADER] = signature;
  return worker.fetch(ROUTE, { method: "POST", headers, body });
}

/** The paths the Worker called on Square. A call, so an assertion on it does not narrow `sent` for the rest of a test. */
function paths(): string[] {
  return sent.map(({ url }) => url.pathname);
}

/** The status, with the body read off so that the connection closes. */
async function statusOf(res: Response): Promise<{ status: number; text: string }> {
  return { status: res.status, text: (await res.text()).slice(0, 300) };
}

/**
 * `createdAt` is the payment's created_at in epoch ms, now when left out. `tipJpy` goes into total_money and approved_money
 * beside amount_money, which is the deposit, so a handler that reads another field than amount_money decides otherwise.
 */
type PaymentFacts = {
  id: string;
  status: string;
  amount: number;
  currency?: string;
  reference_id?: string;
  createdAt?: number;
  tipJpy?: number;
};
type RefundFacts = { id: string; status: string; amount: number; payment_id: string };

function eventOf(type: string, dataType: string, id: string, object: Json): Json {
  return {
    merchant_id: "MLQ8EXAMPLEOKINAWA",
    type,
    event_id: randomUUID(),
    created_at: new Date().toISOString(),
    data: { type: dataType, id, object },
  };
}

function paymentEvent(type: string, facts: PaymentFacts): Json {
  const currency = facts.currency ?? "JPY";
  const money = { amount: facts.amount, currency };
  const tip = facts.tipJpy ?? 0;
  const total = { amount: facts.amount + tip, currency };
  const payment: Json = {
    id: facts.id,
    created_at: new Date(facts.createdAt ?? Date.now()).toISOString(),
    updated_at: new Date().toISOString(),
    amount_money: money,
    ...(tip === 0 ? {} : { tip_money: { amount: tip, currency } }),
    total_money: total,
    approved_money: total,
    status: facts.status,
    source_type: "CARD",
    location_id: testVars.SQUARE_LOCATION_ID,
    order_id: `order-${randomUUID()}`,
    ...(facts.reference_id === undefined ? {} : { reference_id: facts.reference_id }),
    version: 4,
  };
  return eventOf(type, "payment", facts.id, { payment });
}

function refundEvent(type: string, facts: RefundFacts): Json {
  const refund: Json = {
    id: facts.id,
    status: facts.status,
    amount_money: { amount: facts.amount, currency: "JPY" },
    payment_id: facts.payment_id,
    location_id: testVars.SQUARE_LOCATION_ID,
    order_id: `order-${randomUUID()}`,
    reason: "Requested by the guest",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 2,
  };
  return eventOf(type, "refund", facts.id, { refund });
}

/** A payment `event` as text of exactly `bytes` bytes, the room taken by a note on the payment, as Square's payments carry. */
function padded(event: Json, bytes: number, filler: string): string {
  const data = event.data as Json;
  const payment = (data.object as Json).payment as Json;
  const withNote = (note: string) => JSON.stringify({ ...event, data: { ...data, object: { payment: { ...payment, note } } } });
  const room = bytes - Buffer.byteLength(withNote(""));
  const count = Math.floor(room / Buffer.byteLength(filler));
  const body = withNote(filler.repeat(count) + "x".repeat(room - count * Buffer.byteLength(filler)));
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}

/** `signature` with the character at `at` changed, its length kept. */
function changedAt(signature: string, at: number): string {
  return `${signature.slice(0, at)}${signature[at] === "A" ? "B" : "A"}${signature.slice(at + 1)}`;
}

test("bad signatures get 401", async () => {
  const pending = await book(first, pendingRow(HANAKO, "ja"));
  const lapsed = await book(second, { status: "EXPIRED", payment_attempt: 1, ...guestColumns(MINHO) });
  const paymentId = `sq-pay-${randomUUID()}`;
  const confirmed = await book(first, paidRow(first, HANAKO, paymentId, "CONFIRMED"));
  // Each would leave a mark if it got through: a confirmation, a refund sent to Square, a refund row.
  const events: [string, string][] = [
    [
      "a completed payment for a pending booking",
      JSON.stringify(
        paymentEvent("payment.updated", {
          id: `sq-pay-${randomUUID()}`,
          status: "COMPLETED",
          amount: first.depositJpy,
          reference_id: pending.id,
          tipJpy: 300,
        }),
      ),
    ],
    [
      "a completed payment for an expired hold",
      JSON.stringify(
        paymentEvent("payment.created", { id: `sq-pay-${randomUUID()}`, status: "COMPLETED", amount: second.depositJpy, reference_id: lapsed.id }),
      ),
    ],
    [
      "a refund made in the Dashboard",
      JSON.stringify(refundEvent("refund.created", { id: `sq-refund-${randomUUID()}`, status: "COMPLETED", amount: 1_500, payment_id: paymentId })),
    ],
  ];
  const key = testVars.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const url = testVars.SQUARE_WEBHOOK_URL;

  for (const [index, [label, body]] of events.entries()) {
    const valid = sign(body);
    const otherBody = (events[(index + 1) % events.length] as [string, string])[1];
    const changed = body.replace(/"amount":(\d+)/, (_, digits: string) => `"amount":${Number(digits) + 1}`);
    assert.notEqual(changed, body);
    // [what, the signature header, the body sent]
    const forgeries: [string, string | null, string][] = [
      ["no signature", null, body],
      ["an empty signature", "", body],
      ["signed with another key", hmac(`${key}-old`, url + body).digest("base64"), body],
      ["signed over the URL the request arrived on", hmac(key, `http://localhost${ROUTE}${body}`).digest("base64"), body],
      ["signed over the URL in https", hmac(key, url.replace(/^http:/, "https:") + body).digest("base64"), body],
      ["signed over the body alone", hmac(key, body).digest("base64"), body],
      ["in hex", hmac(key, url + body).digest("hex"), body],
      ["in lower case", valid.toLowerCase(), body],
      ["another event's signature", sign(otherBody), body],
      // A compare that walks the signature it was sent, and stops where that ends, takes any prefix of the real one.
      ["its first character", valid.slice(0, 1), body],
      ["its first half", valid.slice(0, valid.length >> 1), body],
      ["all but its last character", valid.slice(0, -1), body],
      ["all but its last four characters", valid.slice(0, -4), body],
      ["one padding character more", `${valid}=`, body],
      ["the signature twice over", valid + valid, body],
      ["one character changed in the middle", changedAt(valid, valid.length >> 1), body],
      ["its first character changed", changedAt(valid, 0), body],
      ["a space inside it", `${valid.slice(0, 20)} ${valid.slice(20)}`, body],
      ["a body changed after signing", valid, changed],
      ["a body cut short", valid, body.slice(0, -1)],
    ];
    for (const [what, signature, sentBody] of forgeries) {
      const context = `${label}, ${what}`;
      if (signature !== null && sentBody === body) assert.notEqual(signature, valid, context);
      const before = await snapshot();
      sent = [];

      const res = await statusOf(await post(sentBody, signature));

      assert.equal(res.status, 401, `${context}: ${res.text}`);
      assert.deepEqual(paths(), [], `${context}: Square was called`);
      assert.deepEqual(await snapshot(), before, `${context}: something changed`);
    }
  }

  // Signed as Square signs them, the same events go through: nothing above was refused for the event itself, and no refusal
  // kept its event id.
  sent = [];
  for (const [label, body] of events) {
    const res = await statusOf(await post(body, sign(body)));
    assert.equal(res.status, 200, `${label}: ${res.text}`);
  }
  assert.equal((await stored(pending.id)).status, "CONFIRMED");
  assert.deepEqual(paths(), [REFUNDS], "the expired hold's payment did not go back");
  assert.equal((await refundsOf(confirmed.id)).length, 1, "the Dashboard refund was not recorded");
});

test("valid events get 200", async () => {
  // A completed payment for a hold whose charge was out confirms it, with the mail the page's own confirmation sends.
  const pending = await book(second, pendingRow(MINHO, "ko"));
  const paymentId = `sq-pay-${randomUUID()}`;
  // The deposit is amount_money. Square's total_money adds any tip, so a total of 13,200 must not decide.
  const completed = paymentEvent("payment.updated", {
    id: paymentId,
    status: "COMPLETED",
    amount: second.depositJpy,
    reference_id: pending.id,
    tipJpy: 700,
  });
  // Square's spacing is its own, and the text as sent is what was signed.
  const body = `${JSON.stringify(completed, null, 2)}\n`;
  const startedAt = Date.now();

  const res = await statusOf(await post(body, sign(body)));

  assert.equal(res.status, 200, res.text);
  const confirmed = await stored(pending.id);
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(confirmed.payment_id, paymentId);
  assert.equal(confirmed.paid_jpy, second.depositJpy);
  const confirmedAt = confirmed.confirmed_at as number;
  assert.ok(confirmedAt >= startedAt && confirmedAt <= Date.now(), `confirmed at ${confirmedAt}`);
  assert.deepEqual(paths(), [], "a good payment reached Square");

  const { emails, sheets } = await deliver();
  assert.deepEqual(sheets, [pending.id]);
  assert.deepEqual(emails.map(({ template }) => template).toSorted(), ["guest_confirmation", "staff_new_booking"]);
  const token = createHmac("sha256", testVars.CANCEL_LINK_SECRET).update(`cancel:${pending.id}`).digest("base64url").slice(0, 32);
  const guestMail = emails.find(({ template }) => template === "guest_confirmation") as EmailPayload;
  assert.equal(guestMail.to, MINHO.email);
  assert.equal(guestMail.locale, "ko");
  assert.equal(guestMail.data.cancelUrl, `${testVars.SITE_URL}/ko/booking/cancel?b=${pending.id}&t=${encodeURIComponent(token)}`);
  const staffMail = emails.find(({ template }) => template === "staff_new_booking") as EmailPayload;
  assert.equal(staffMail.to, testVars.STAFF_EMAIL);

  // Square sends it again when it missed the 200: acknowledged, and nothing more happens.
  const again = await statusOf(await post(body, sign(body)));
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(await stored(pending.id), confirmed);
  assert.equal(await waitingItems(), 0);
  assert.deepEqual(paths(), []);

  // A payment that failed, created once its attempt had started, gives the guest the hold back.
  const failing = await book(first, pendingRow(HANAKO, "ja"));
  const failed = JSON.stringify(
    paymentEvent("payment.created", {
      id: `sq-pay-${randomUUID()}`,
      status: "FAILED",
      amount: first.depositJpy,
      reference_id: failing.id,
      createdAt: failing.updated_at + 1_000,
    }),
  );
  const failedRes = await statusOf(await post(failed, sign(failed)));
  assert.equal(failedRes.status, 200, failedRes.text);
  const released = await stored(failing.id);
  assert.equal(released.status, "ON_HOLD");
  assert.equal(released.guest_email, HANAKO.email);

  // One created before the current attempt started is an earlier attempt's, and the charge still out keeps its hold.
  const retrying = await book(first, { ...pendingRow(HANAKO, "ja"), payment_attempt: 2, updated_at: Date.now() - MINUTE_MS });
  const stale = JSON.stringify(
    paymentEvent("payment.updated", {
      id: `sq-pay-${randomUUID()}`,
      status: "FAILED",
      amount: first.depositJpy,
      reference_id: retrying.id,
      createdAt: retrying.updated_at - 2 * MINUTE_MS,
    }),
  );
  const staleRes = await statusOf(await post(stale, sign(stale)));
  assert.equal(staleRes.status, 200, staleRes.text);
  assert.deepEqual(await stored(retrying.id), retrying);

  // A payment for a hold that has expired goes back through Square, in full.
  const lapsed = await book(first, { status: "EXPIRED", payment_attempt: 1, ...guestColumns(HANAKO) });
  const latePaymentId = `sq-pay-${randomUUID()}`;
  const late = JSON.stringify(
    paymentEvent("payment.updated", { id: latePaymentId, status: "COMPLETED", amount: first.depositJpy, reference_id: lapsed.id }),
  );
  const lateRes = await statusOf(await post(late, sign(late)));
  assert.equal(lateRes.status, 200, lateRes.text);
  assert.equal(sent.length, 1, sent.map(({ url }) => url.pathname).join(", "));
  const [refund] = sent as [Sent];
  assert.equal(refund.url.origin, SQUARE_HOST);
  assert.equal(refund.url.pathname, REFUNDS);
  assert.equal(refund.method, "POST");
  assert.equal(refund.authorization, `Bearer ${testVars.SQUARE_ACCESS_TOKEN}`);
  assert.equal(refund.body.payment_id, latePaymentId);
  assert.deepEqual(refund.body.amount_money, { amount: first.depositJpy, currency: "JPY" });
  const refundKey = refund.body.idempotency_key as string;
  assert.ok(typeof refundKey === "string" && refundKey.length > 0 && refundKey.length <= MAX_KEY_LENGTH, `the key ${refundKey}`);
  assert.notEqual(refundKey, `rf:${lapsed.id}`);
  assert.equal((await stored(lapsed.id)).status, "EXPIRED");

  // Square's word on a cancellation's refund settles its row.
  const cancelledPayment = `sq-pay-${randomUUID()}`;
  const cancelled = await book(first, paidRow(first, HANAKO, cancelledPayment, "CANCELLED"));
  const squareRefundId = `sq-refund-${randomUUID()}`;
  await insertRow(worker.db, "refunds", {
    id: randomUUID(),
    booking_id: cancelled.id,
    square_refund_id: squareRefundId,
    amount_jpy: 3_650,
    status: "PENDING",
    origin: "cancel",
    idempotency_key: `rf:${cancelled.id}`,
    created_at: Date.now() - HOUR_MS,
    updated_at: Date.now() - HOUR_MS,
  });
  const settled = JSON.stringify(
    refundEvent("refund.updated", { id: squareRefundId, status: "COMPLETED", amount: 3_650, payment_id: cancelledPayment }),
  );
  const settledRes = await statusOf(await post(settled, sign(settled)));
  assert.equal(settledRes.status, 200, settledRes.text);
  const settledRows = await refundsOf(cancelled.id);
  assert.equal(settledRows.length, 1, JSON.stringify(settledRows));
  assert.partialDeepStrictEqual(settledRows[0], {
    square_refund_id: squareRefundId,
    status: "COMPLETED",
    origin: "cancel",
    amount_jpy: 3_650,
  });

  // A refund staff made in the Dashboard is recorded as theirs.
  const dashboardId = `sq-refund-${randomUUID()}`;
  const dashboard = JSON.stringify(
    refundEvent("refund.created", { id: dashboardId, status: "PENDING", amount: 2_500, payment_id: cancelledPayment }),
  );
  const dashboardRes = await statusOf(await post(dashboard, sign(dashboard)));
  assert.equal(dashboardRes.status, 200, dashboardRes.text);
  const rows = await refundsOf(cancelled.id);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  assert.partialDeepStrictEqual(
    rows.find(({ square_refund_id }) => square_refund_id === dashboardId),
    { booking_id: cancelled.id, amount_jpy: 2_500, status: "PENDING", origin: "dashboard", idempotency_key: null },
  );
});

test("unknown event types get 200 and change nothing", async () => {
  const pending = await book(first, pendingRow(HANAKO, "ja"));
  const payment = { id: `sq-pay-${randomUUID()}`, status: "COMPLETED", amount: first.depositJpy, reference_id: pending.id };
  sent = [];
  // Each carries a payment its own type would act on, so only the type keeps it out.
  for (const type of ["dispute.created", "invoice.payment_made", "order.updated", "payment.deleted"]) {
    const body = JSON.stringify(paymentEvent(type, payment));
    const before = await snapshot(false);

    const res = await statusOf(await post(body, sign(body)));

    assert.equal(res.status, 200, `${type}: ${res.text}`);
    assert.deepEqual(await snapshot(false), before, type);
  }
  assert.deepEqual(paths(), []);
  assert.equal((await stored(pending.id)).status, "PAYMENT_PENDING");
});

test("a body over 64 KiB gets 413 and changes nothing", async () => {
  const pending = await book(first, pendingRow(HANAKO, "ja"));
  const event = paymentEvent("payment.updated", {
    id: `sq-pay-${randomUUID()}`,
    status: "COMPLETED",
    amount: first.depositJpy,
    reference_id: pending.id,
  });
  sent = [];

  // Anyone can send these, so the limit comes before the signature: junk and Square's own signature over the same bytes get
  // the same answer. The limit counts bytes, so one byte past it in three-byte characters is past it too.
  for (const filler of ["x", "沖"]) {
    for (const size of [LIMIT_BYTES + 1, 100_000]) {
      const body = padded(event, size, filler);
      const signatures: [string, string][] = [
        ["a junk signature", hmac("not-the-key", body).digest("base64")],
        ["a valid signature", sign(body)],
      ];
      for (const [what, signature] of signatures) {
        const context = `${size} bytes of "${filler}" padding, ${what}`;
        const before = await snapshot();

        const res = await statusOf(await post(body, signature));

        assert.equal(res.status, 413, `${context}: ${res.text}`);
        assert.deepEqual(paths(), [], `${context}: Square was called`);
        assert.deepEqual(await snapshot(), before, `${context}: something changed`);
      }
    }
  }

  // The same event at exactly the limit, signed, goes through, so what refused the ones above was their size, and none of
  // them kept the event id.
  const atLimit = padded(event, LIMIT_BYTES, "沖");
  const res = await statusOf(await post(atLimit, sign(atLimit)));
  assert.equal(res.status, 200, res.text);
  assert.equal((await stored(pending.id)).status, "CONFIRMED");
});

test("an event the Worker fails on gets 5xx and is handled when Square sends it again", async () => {
  const pending = await book(second, pendingRow(MINHO, "ko"));
  const paymentId = `sq-pay-${randomUUID()}`;
  const body = JSON.stringify(
    paymentEvent("payment.updated", {
      id: paymentId,
      status: "COMPLETED",
      amount: second.depositJpy,
      reference_id: pending.id,
      tipJpy: 400,
    }),
  );
  const before = await snapshot();
  sent = [];

  // The outbox is out of reach for this one delivery, as a D1 write that fails leaves it: the confirmation's batch cannot
  // land, so the handler fails partway through.
  await worker.db.prepare("ALTER TABLE outbox RENAME TO outbox_parked").run();
  let failed: { status: number; text: string };
  try {
    failed = await statusOf(await post(body, sign(body)));
  } finally {
    await worker.db.prepare("ALTER TABLE outbox_parked RENAME TO outbox").run();
  }

  // Square sends again only what got no 2xx, so a 200 here would lose the payment's confirmation for good.
  assert.ok(failed.status >= 500 && failed.status <= 599, `got ${failed.status}: ${failed.text}`);
  assert.deepEqual(await snapshot(), before, "the failed delivery left something behind, the event id included");
  assert.deepEqual(paths(), [], "a good payment reached Square");

  // Square sends the same text again, and this time it is handled in full.
  const again = await statusOf(await post(body, sign(body)));
  assert.equal(again.status, 200, again.text);
  const confirmed = await stored(pending.id);
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(confirmed.payment_id, paymentId);
  assert.equal(confirmed.paid_jpy, second.depositJpy);
  assert.deepEqual(paths(), []);
  const { emails, sheets } = await deliver();
  assert.deepEqual(sheets, [pending.id]);
  assert.deepEqual(emails.map(({ template }) => template).toSorted(), ["guest_confirmation", "staff_new_booking"]);
  assert.equal(emails.find(({ template }) => template === "guest_confirmation")?.to, MINHO.email);
});
