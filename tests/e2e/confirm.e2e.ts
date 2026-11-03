// POST /api/holds/{id}/confirm through the built Worker in Miniflare, with Square's HTTP API faked in `outbound`, so the real
// client maps its replies and its own caps apply. Replies follow Square's documented shapes. The Worker reads the real clock,
// so an expiry is set from now. Expected values are literals, testVars or Date.parse, and the cancel token comes from
// node:crypto, never from the code under test. The status codes are read back through confirmOutcome, which is what the
// hold page's client does with them, so the endpoint and that client cannot drift apart.
//
// Every POST says Content-Type: application/json: Astro's origin check answers 403 to a cross-site POST with no type.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - A body the Worker cannot use, or a bad sourceId or locale, is a 400 that reaches neither Square nor the row. The reason
//   is free, since INVALID_GUEST speaks only of the guest and the client reads any other as unknown.
// - A 200 carries no guest details and none of the row's staff-only fields: an already-confirmed booking answers 200 to
//   whoever holds its URL, and that URL is the checkout page's.
// - Square's words never reach the guest: a 402 carries no message, so the page's own translated `declined` text is what shows.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { confirmOutcome, type ConfirmOutcome } from "../../src/lib/checkout.ts";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { renderEmail } from "../../src/lib/mail/templates.ts";
import { drainOutbox, type EmailPayload } from "../../src/lib/outbox.ts";
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
  type BookingRow,
} from "../helpers/seed.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SQUARE_HOST = "https://connect.squareupsandbox.com";
const PAYMENTS = "/v2/payments";
const REFUNDS = "/v2/refunds";
const JSON_HEADERS = { "Content-Type": "application/json" };

/** What the catalog says today, which the deposit on a hold must win over. */
const CATALOG_DEPOSIT_JPY = 33_000;

type Json = Record<string, unknown>;
type Guest = { familyName: string; givenName: string; email: string; phone: string };

const HANAKO: Guest = { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.jp", phone: "090-8686-3535" };
const MINHO: Guest = { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929" };

type Stay = { names: Record<Locale, string>; priceJpy: number; depositJpy: number; modelId: string; packageId: string };

type Sent = { url: URL; method: string; authorization: string | null; body: Json };
type Reply = (call: Sent) => Response;

let worker: TestWorker;
let first: Stay;
let second: Stay;
let sent: Sent[] = [];
let reply: Reply = () => new Response("no reply was set for this test", { status: 500 });

function textsOf(names: Record<Locale, string>, more: Record<string, string> = {}): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, { name: names[locale], ...more }])));
}

async function publish(db: D1Database, names: Record<Locale, string>, priceJpy: number, depositJpy: number): Promise<Stay> {
  const rate = await seedRateClass(db);
  const texts = textsOf(names, { summary: "A summary", description: "A description" });
  const model = await seedModel(db, { rate_class_id: rate.id, texts });
  const pack = await seedPackage(db, { texts: textsOf(names) });
  await seedPrice(db, { rate_class_id: rate.id, package_id: pack.id, price_jpy: priceJpy });
  return { names, priceJpy, depositJpy, modelId: model.id, packageId: pack.id };
}

before(async () => {
  worker = await startWorker({
    outbound: async (request) => {
      const text = await request.text();
      const call: Sent = {
        url: new URL(request.url),
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: text === "" ? {} : (JSON.parse(text) as Json),
      };
      sent.push(call);
      return call.url.pathname === REFUNDS ? refundReply(call) : reply(call);
    },
  });
  const { db } = worker;
  await seedType(db, { deposit_jpy: CATALOG_DEPOSIT_JPY });
  await seedConfig(db);
  await seedCatalogMeta(db);
  await seedTiers(db);
  first = await publish(
    db,
    { ja: "沖縄カブ 110", en: "Okinawa Cub 110", "zh-cn": "冲绳小狼 110", ko: "오키나와 커브 110" },
    18_700,
    7_300,
  );
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

function moneyOf(call: Sent): { amount: number; currency: string } {
  return call.body.amount_money as { amount: number; currency: string };
}

/** Decoys that differ from the fields the client keeps, as in tests/square-client.test.ts. */
function paymentReply(call: Sent, part: { amount?: number; currency?: string; status?: string } = {}): Response {
  const { amount, currency } = moneyOf(call);
  return Response.json({
    payment: {
      id: `sq-${randomUUID()}`,
      status: part.status ?? "COMPLETED",
      amount_money: { amount: part.amount ?? amount, currency: part.currency ?? currency },
      total_money: { amount: 1, currency: "JPY" },
      reference_id: call.body.reference_id,
      created_at: new Date().toISOString(),
    },
  });
}

function refundReply(call: Sent): Response {
  return Response.json({
    refund: { id: `sq-refund-${randomUUID()}`, status: "PENDING", amount_money: moneyOf(call), payment_id: call.body.payment_id },
  });
}

/** The categories and codes Square's failures carry in these tests. Told which check failed, a card tester knows what to change. */
const SQUARE_CODES = [
  "PAYMENT_METHOD_ERROR",
  "INVALID_REQUEST_ERROR",
  "GENERIC_DECLINE",
  "CVV_FAILURE",
  "INSUFFICIENT_FUNDS",
  "CARD_DECLINED_VERIFICATION_REQUIRED",
  "INVALID_VALUE",
];

/**
 * What a failure of Square's says, and what the client says for one whose body it does not read. The hold page shows a 402's
 * message over its own translated `declined` text, and Square's is English and internal, so none of it may leave the Worker,
 * in a message or in any other field.
 */
const SQUARE_WORDS = new RegExp(["UPSTREAM-DETAIL", "Square answered", ...SQUARE_CODES].join("|"));

function failureReply(status: number, category: string, code: string): Response {
  return Response.json({ errors: [{ category, code, detail: "UPSTREAM-DETAIL" }] }, { status });
}

const declinedReply: Reply = () => failureReply(402, "PAYMENT_METHOD_ERROR", "GENERIC_DECLINE");
const refusedReply: Reply = () => failureReply(400, "INVALID_REQUEST_ERROR", "INVALID_VALUE");
const noAnswerReply: Reply = () => new Response("upstream fell over", { status: 503 });

function book(stay: Stay, row: Partial<BookingRow> = {}): Promise<BookingRow> {
  return seedBooking(worker.db, {
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

function guestColumns(guest: Guest): Partial<BookingRow> {
  return {
    guest_family_name: guest.familyName,
    guest_given_name: guest.givenName,
    guest_email: guest.email,
    guest_phone: guest.phone,
  };
}

async function stored(id: string): Promise<BookingRow> {
  const row = await worker.db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `no booking ${id}`);
  return row;
}

function payBody(guest: unknown, locale: unknown, sourceId: unknown = `cnon:${randomUUID()}`) {
  return { sourceId, guest, locale };
}

async function postText(id: string, body: string): Promise<Response> {
  return worker.fetch(`/api/holds/${id}/confirm`, { method: "POST", headers: JSON_HEADERS, body });
}

async function post(id: string, body: unknown): Promise<{ status: number; text: string; body: Json }> {
  const res = await postText(id, JSON.stringify(body));
  const text = await res.text();
  assert.match(res.headers.get("content-type") ?? "", /application\/json/, `${res.status}: ${text.slice(0, 200)}`);
  return { status: res.status, text, body: JSON.parse(text) as Json };
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

async function waitingItems(): Promise<number> {
  const row = await worker.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").first<{ n: number }>();
  return row?.n ?? -1;
}

function paths(): string[] {
  return sent.map(({ url }) => url.pathname);
}

type Case = {
  label: string;
  row: () => Partial<BookingRow>;
  guest?: unknown;
  answer?: Reply;
  status: number;
  reason?: string;
  fields?: string[];
  kind: ConfirmOutcome["kind"];
  after: string;
  outbound: string[];
  items: number;
};

const live = () => ({});
const expired = () => ({ expires_at: Date.now() - MINUTE_MS });
const inFlight = () => ({ status: "PAYMENT_PENDING", payment_attempt: 1, ...guestColumns(MINHO) });

const CASES: Case[] = [
  {
    label: "a completed payment",
    row: live,
    answer: paymentReply,
    status: 200,
    kind: "ok",
    after: "CONFIRMED",
    outbound: [PAYMENTS],
    items: 3,
  },
  {
    label: "a declined card",
    row: live,
    answer: declinedReply,
    status: 402,
    reason: "PAYMENT_DECLINED",
    kind: "declined",
    after: "ON_HOLD",
    outbound: [PAYMENTS],
    items: 0,
  },
  ...(
    [
      ["a wrong security code", "CVV_FAILURE"],
      ["no funds", "INSUFFICIENT_FUNDS"],
      ["a card that wants verifying", "CARD_DECLINED_VERIFICATION_REQUIRED"],
    ] as const
  ).map(
    ([label, code]): Case => ({
      label,
      row: live,
      answer: () => failureReply(402, "PAYMENT_METHOD_ERROR", code),
      status: 402,
      reason: "PAYMENT_DECLINED",
      kind: "declined",
      after: "ON_HOLD",
      outbound: [PAYMENTS],
      items: 0,
    }),
  ),
  {
    label: "a refused request",
    row: live,
    answer: refusedReply,
    status: 402,
    reason: "PAYMENT_DECLINED",
    kind: "declined",
    after: "ON_HOLD",
    outbound: [PAYMENTS],
    items: 0,
  },
  {
    label: "no answer from Square",
    row: live,
    answer: noAnswerReply,
    status: 202,
    reason: "PAYMENT_UNKNOWN",
    kind: "unknown",
    after: "PAYMENT_PENDING",
    outbound: [PAYMENTS],
    items: 0,
  },
  {
    label: "a payment for a yen less",
    row: live,
    answer: (call) => paymentReply(call, { amount: moneyOf(call).amount - 1 }),
    status: 402,
    reason: "PAYMENT_DECLINED",
    kind: "declined",
    after: "ON_HOLD",
    outbound: [PAYMENTS, REFUNDS],
    items: 0,
  },
  {
    label: "a payment in dollars",
    row: live,
    answer: (call) => paymentReply(call, { currency: "USD" }),
    status: 402,
    reason: "PAYMENT_DECLINED",
    kind: "declined",
    after: "ON_HOLD",
    outbound: [PAYMENTS, REFUNDS],
    items: 0,
  },
  {
    label: "an expired hold",
    row: expired,
    status: 409,
    reason: "HOLD_EXPIRED",
    kind: "expired",
    after: "ON_HOLD",
    outbound: [],
    items: 0,
  },
  {
    label: "a charge in flight",
    row: inFlight,
    status: 409,
    reason: "IN_PROGRESS",
    kind: "in-progress",
    after: "PAYMENT_PENDING",
    outbound: [],
    items: 0,
  },
  {
    label: "a confirmed booking",
    row: () => ({ status: "CONFIRMED", payment_attempt: 1, payment_id: "sq-earlier", paid_jpy: 7_300, ...guestColumns(MINHO) }),
    status: 200,
    kind: "ok",
    after: "CONFIRMED",
    outbound: [],
    items: 0,
  },
  {
    label: "an invalid guest",
    row: live,
    guest: { ...HANAKO, email: "ruri@", phone: "---" },
    status: 400,
    reason: "INVALID_GUEST",
    fields: ["EMAIL_MALFORMED", "PHONE_NO_DIGITS"],
    kind: "invalid-guest",
    after: "ON_HOLD",
    outbound: [],
    items: 0,
  },
];

test("the endpoint maps results to status codes", async () => {
  for (const stay of [first, second]) {
    for (const { label, row, guest = HANAKO, answer, status, reason, fields, kind, after: next, outbound, items } of CASES) {
      const booking = await book(stay, row());
      const context = `${label}, deposit ${stay.depositJpy}`;
      sent = [];
      if (answer !== undefined) reply = answer;
      const sourceId = `cnon:${randomUUID()}`;

      const res = await post(booking.id, payBody(guest, "ja", sourceId));

      assert.equal(res.status, status, `${context}: ${res.text.slice(0, 300)}`);
      assert.equal(res.body.ok, reason === undefined, context);
      assert.equal(res.body.reason, reason, context);
      const outcome = confirmOutcome(res.status, res.body);
      assert.equal(outcome.kind, kind, context);
      if (fields !== undefined) assert.deepEqual((res.body.fields as string[]).toSorted(), fields, context);
      assert.doesNotMatch(res.text, SQUARE_WORDS, context);
      if (outcome.kind === "declined") assert.equal(outcome.message, "", `${context}: a message over the page's own`);

      assert.equal((await stored(booking.id)).status, next, context);
      assert.deepEqual(paths(), outbound, context);
      assert.equal(await waitingItems(), items, context);
      await deliver();

      const [charge, refund] = sent;
      if (charge !== undefined) {
        assert.equal(charge.url.origin, SQUARE_HOST, context);
        assert.equal(charge.method, "POST", context);
        assert.equal(charge.authorization, `Bearer ${testVars.SQUARE_ACCESS_TOKEN}`, context);
        assert.equal(charge.body.idempotency_key, `${booking.id}:1`, context);
        assert.equal(charge.body.reference_id, booking.id, context);
        assert.equal(charge.body.source_id, sourceId, context);
        assert.equal(charge.body.location_id, testVars.SQUARE_LOCATION_ID, context);
        assert.deepEqual(charge.body.amount_money, { amount: stay.depositJpy, currency: "JPY" }, context);
      }
      if (refund !== undefined) assert.equal(typeof refund.body.payment_id, "string", context);
    }
  }
});

test("a declined card can be paid again under a new key", async () => {
  const hold = await book(first);
  reply = (call) => (sent.length === 1 ? declinedReply(call) : paymentReply(call));

  assert.equal((await post(hold.id, payBody(HANAKO, "ja"))).status, 402);
  assert.equal((await post(hold.id, payBody(HANAKO, "ja"))).status, 200);

  assert.deepEqual(sent.map(({ body }) => body.idempotency_key), [`${hold.id}:1`, `${hold.id}:2`]);
  const row = await stored(hold.id);
  assert.equal(row.status, "CONFIRMED");
  assert.equal(row.paid_jpy, first.depositJpy);
  assert.equal(row.expires_at, hold.expires_at);
});

test("a confirmed booking's items wait in the outbox, built from the Worker's own settings", async () => {
  const cases: [Stay, Guest, Locale][] = [
    [first, HANAKO, "ja"],
    [second, MINHO, "ko"],
  ];
  for (const [stay, guest, locale] of cases) {
    const hold = await book(stay);
    sent = [];
    reply = paymentReply;

    assert.equal((await post(hold.id, payBody(guest, locale))).status, 200);

    // Immediate sending comes with #42, so until then Square is the only thing a confirm talks to.
    assert.deepEqual(paths(), [PAYMENTS]);
    const { emails, sheets } = await deliver();
    assert.deepEqual(sheets, [hold.id]);
    assert.deepEqual(emails.map(({ template }) => template).toSorted(), ["guest_confirmation", "staff_new_booking"]);

    const signed = createHmac("sha256", testVars.CANCEL_LINK_SECRET).update(`cancel:${hold.id}`);
    const token = signed.digest("base64url").slice(0, 32);
    const cancelUrl = `${testVars.SITE_URL}/${locale}/booking/cancel?b=${hold.id}&t=${encodeURIComponent(token)}`;

    const guestMail = emails.find(({ template }) => template === "guest_confirmation") as EmailPayload;
    assert.equal(guestMail.to, guest.email);
    assert.equal(guestMail.locale, locale);
    assert.equal(guestMail.data.cancelUrl, cancelUrl);
    assert.ok(renderEmail(guestMail).text.includes(stay.names[locale]), locale);

    const staffMail = emails.find(({ template }) => template === "staff_new_booking") as EmailPayload;
    assert.equal(staffMail.to, testVars.STAFF_EMAIL);
    assert.equal(staffMail.locale, "ja");
    assert.ok(renderEmail(staffMail).text.includes(stay.names.ja), locale);

    for (const email of emails) {
      for (const part of Object.values(renderEmail(email))) {
        assert.doesNotMatch(part, /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/, email.template);
      }
    }
  }
});

test("what the body says about money, ids or status counts for nothing", async () => {
  const stranger = await book(second);
  const forged = {
    amountJpy: 1,
    depositJpy: 1,
    deposit_jpy: 1,
    amount: 1,
    amount_money: { amount: 1, currency: "JPY" },
    paidJpy: 1,
    paid_jpy: 1,
    paymentId: "sq-forged",
    payment_id: "sq-forged",
    status: "CONFIRMED",
    id: stranger.id,
    bookingId: stranger.id,
    referenceId: stranger.id,
    reference_id: stranger.id,
    idempotencyKey: "forged-key",
    expiresAt: Date.now() + 30 * DAY_MS,
    expires_at: Date.now() + 30 * DAY_MS,
  };
  reply = paymentReply;

  const hold = await book(first);
  const paid = await post(hold.id, { ...payBody(HANAKO, "ja"), ...forged });

  assert.equal(paid.status, 200, paid.text.slice(0, 300));
  const [charge] = sent;
  assert.deepEqual(charge?.body.amount_money, { amount: first.depositJpy, currency: "JPY" });
  assert.equal(charge?.body.reference_id, hold.id);
  assert.equal(charge?.body.idempotency_key, `${hold.id}:1`);
  const row = await stored(hold.id);
  assert.equal(row.paid_jpy, first.depositJpy);
  assert.notEqual(row.payment_id, "sq-forged");
  assert.equal(row.expires_at, hold.expires_at);
  assert.deepEqual(await stored(stranger.id), stranger);

  // A later expiry in the body revives nothing.
  sent = [];
  const lapsed = await book(first, expired());
  const refused = await post(lapsed.id, { ...payBody(HANAKO, "ja"), ...forged });
  assert.equal(refused.status, 409, refused.text.slice(0, 300));
  assert.equal(refused.body.reason, "HOLD_EXPIRED");
  assert.deepEqual(sent, []);
  assert.deepEqual(await stored(lapsed.id), lapsed);
});

test("a body it cannot use gets 400 and reaches neither Square nor the row", async () => {
  const good = payBody(HANAKO, "ja");
  const bodies: [string, string][] = [
    ["nothing", ""],
    ["not JSON", "sourceId=cnon:x&locale=ja"],
    ["JSON cut short", '{"sourceId":"cnon:x"'],
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"cnon:x"'],
    ["a list", JSON.stringify([good])],
    ["an empty object", "{}"],
    ["no guest", JSON.stringify({ sourceId: good.sourceId, locale: "ja" })],
    ["no sourceId", JSON.stringify({ guest: HANAKO, locale: "ja" })],
    ["an empty sourceId", JSON.stringify(payBody(HANAKO, "ja", ""))],
    ["a number for a sourceId", JSON.stringify(payBody(HANAKO, "ja", 7))],
    ["null for a sourceId", JSON.stringify(payBody(HANAKO, "ja", null))],
    ["an object for a sourceId", JSON.stringify(payBody(HANAKO, "ja", { token: "cnon:x" }))],
    ["no locale", JSON.stringify({ sourceId: good.sourceId, guest: HANAKO })],
    ["a locale the site does not have", JSON.stringify(payBody(HANAKO, "fr"))],
    ["a locale in the wrong case", JSON.stringify(payBody(HANAKO, "ZH-CN"))],
    ["a list for a locale", JSON.stringify(payBody(HANAKO, ["ja"]))],
    ["a name every object inherits", JSON.stringify(payBody(HANAKO, "__proto__"))],
  ];
  const hold = await book(first);
  reply = paymentReply;
  for (const [label, body] of bodies) {
    const res = await postText(hold.id, body);
    assert.equal(res.status, 400, label);
    assert.equal(((await res.json()) as Json).ok, false, label);
    assert.deepEqual(sent, [], `${label}: Square was called`);
    assert.deepEqual(await stored(hold.id), hold, label);
  }

  // Past any name or nonce, and past what D1 stores in one value, so an unread body cannot end as a 500.
  const huge = await postText(hold.id, JSON.stringify(payBody({ ...HANAKO, familyName: "x".repeat(3 * 1024 * 1024) }, "ja")));
  await huge.body?.cancel();
  assert.ok([400, 413].includes(huge.status), `a body of 3 MB got ${huge.status}`);
  assert.deepEqual(sent, [], "a body of 3 MB reached Square");
  assert.deepEqual(await stored(hold.id), hold);
});

test("unknown ids get 404", async () => {
  // Without this the test would pass on a site with no such route.
  const hold = await book(first);
  reply = paymentReply;
  assert.equal((await post(hold.id, payBody(HANAKO, "ja"))).status, 200);
  sent = [];

  const block = await book(first, { source: "block", status: "CONFIRMED", external_ref: `ota-${randomUUID()}`, locale: null });
  const unknown = [
    randomUUID(),
    "nope",
    // The ref is on the guest's email and is short, so it must not stand in for the id.
    hold.ref,
    hold.id.toUpperCase(),
    `${hold.id}x`,
    "x".repeat(500),
    "undefined",
    "null",
    "constructor",
    "__proto__",
    "%27%20OR%201%3D1--",
    block.id,
  ];
  for (const id of unknown) {
    const res = await post(id, payBody(HANAKO, "ja"));
    assert.equal(res.status, 404, id.slice(0, 60));
    assert.equal(res.body.ok, false, id.slice(0, 60));
    assert.equal(res.body.reason, "NOT_FOUND", id.slice(0, 60));
  }

  // A slash in the id may stop at the router, so only the status is the endpoint's to answer for.
  const markup = await postText("%3Cscript%3Ealert(1)%3C%2Fscript%3E", JSON.stringify(payBody(HANAKO, "ja")));
  await markup.body?.cancel();
  assert.equal(markup.status, 404, "markup for an id");
  assert.deepEqual(sent, [], "Square was called");
});

test("a 200 shows nothing of the booking, and a second payer changes nothing", async () => {
  const mark = randomUUID();
  const confirmed = await book(first, {
    status: "CONFIRMED",
    expires_at: Date.now() - HOUR_MS,
    payment_attempt: 1,
    payment_id: `sq-${mark}`,
    paid_jpy: first.depositJpy,
    confirmed_at: Date.now() - HOUR_MS,
    ...guestColumns(MINHO),
  });

  const res = await post(confirmed.id, payBody(HANAKO, "ja"));

  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal(res.body.ok, true);
  assert.deepEqual(sent, [], "Square was called");
  assert.deepEqual(await stored(confirmed.id), confirmed);
  assert.equal(await waitingItems(), 0);
  for (const piece of [...Object.values(MINHO), mark, confirmed.vehicle_plate]) {
    assert.equal(res.text.includes(piece), false, `the response holds ${piece}`);
  }

  // The paying guest's own 200 keeps the row's staff-only fields too.
  const hold = await book(second);
  reply = paymentReply;
  const paid = await post(hold.id, payBody(HANAKO, "ja"));
  assert.equal(paid.status, 200, paid.text.slice(0, 300));
  const row = await stored(hold.id);
  for (const piece of [row.payment_id as string, row.vehicle_plate]) {
    assert.equal(paid.text.includes(piece), false, `the response holds ${piece}`);
  }
});

test("methods other than POST get 405 and charge nothing", async () => {
  const hold = await book(first);
  reply = paymentReply;
  const path = `/api/holds/${hold.id}/confirm`;

  const get = await worker.fetch(path);
  await get.body?.cancel();
  assert.equal(get.status, 405, "GET");

  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const res = await worker.fetch(path, { method, headers: JSON_HEADERS, body: JSON.stringify(payBody(HANAKO, "ja")) });
    await res.body?.cancel();
    assert.equal(res.status, 405, method);
  }

  assert.deepEqual(sent, [], "Square was called");
  assert.deepEqual(await stored(hold.id), hold);
});
