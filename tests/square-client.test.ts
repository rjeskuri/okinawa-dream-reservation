// The Square client through an injected fetch: what goes out on the wire, and the one result kind each response maps
// to. Replies follow Square's documented shapes and carry decoys (total_money, updated_at) that differ from the fields
// the client keeps. Tokens, keys, amounts and ids are fresh on every run, so none of them can be hard-coded around, and
// no expected value comes from the code under test.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";
import { createSquareClient } from "../src/lib/square/client.ts";

// The release marked Latest when the ticket was checked. Moving a money seam to a new API version is a decision, so a
// bump changes this line too.
const SQUARE_VERSION = "2026-09-16";
const BASE_URLS = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
} as const;
const ENVS = ["sandbox", "production"] as const;
const DEFAULT_TIMEOUT_MS = 15_000;
// Far above any cap worth having: 1000 pages of 100 is 100000 payments for one rental shop.
const PAGE_CAP_LIMIT = 1000;

const TOKEN = `EAAA${randomUUID()}`;
const LOCATION = `LOC-${randomUUID().slice(0, 8)}`;

type Env = keyof typeof BASE_URLS;
type Json = Record<string, unknown>;
type Client = ReturnType<typeof createSquareClient>;
type TimeWindow = { beginTime: number; endTime: number };

/** Read loosely, so that the assertions decide the shape of a result rather than the compiler. */
interface Result {
  kind: string;
  code?: unknown;
  detail?: unknown;
  payment?: Json;
  refund?: Json;
  payments?: Json[];
  refunds?: Json[];
}

interface Recorded {
  url: URL;
  method: string;
  headers: Headers;
  text: string;
}

interface ClientOptions {
  accessToken?: string;
  env?: Env;
  locationId?: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

function clientWith(options: ClientOptions): Client {
  return createSquareClient({ accessToken: TOKEN, env: "sandbox", locationId: LOCATION, ...options });
}

/** A fetch that records each request, whether the client passes a URL and init or a Request. */
function recordingFetch(reply: (call: Recorded, index: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const call: Recorded = {
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      text: await request.text(),
    };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  return { fetch: fake, calls };
}

function signalOf(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

const neverResolves: typeof fetch = () => new Promise<Response>(() => {});

/** The way the real fetch hangs: until the signal it was given aborts. */
const hangsUntilAborted: typeof fetch = (input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = signalOf(input, init);
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

const HANGING_FETCHES: [string, typeof fetch][] = [
  ["a fetch that never resolves", neverResolves],
  ["a fetch that hangs until aborted", hangsUntilAborted],
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorsBody(...errors: Json[]): string {
  return JSON.stringify({ errors });
}

function randomText(length: number): string {
  let text = "";
  while (text.length < length) text += randomUUID().replaceAll("-", "");
  return text.slice(0, length);
}

function randomInstant(): string {
  return new Date(Date.UTC(2026, 0, 1) + randomInt(0, 2 ** 33)).toISOString();
}

function randomWindow(): TimeWindow {
  const beginTime = Date.UTC(2026, 0, 1) + randomInt(0, 2 ** 33);
  return { beginTime, endTime: beginTime + randomInt(1, 2 ** 33) };
}

/** A Square Payment. The money and time decoys differ from what the client keeps, so reading the wrong field shows. */
function wirePayment(
  fields: { status?: string; amount?: number; currency?: string; referenceId?: string; locationId?: string } = {},
) {
  const amount = fields.amount ?? randomInt(1, 1_000_000);
  const currency = fields.currency ?? "JPY";
  return {
    id: `pay_${randomUUID()}`,
    status: fields.status ?? "COMPLETED",
    amount_money: { amount, currency },
    approved_money: { amount: amount + 1, currency },
    total_money: { amount: amount + 2, currency },
    reference_id: fields.referenceId ?? randomUUID(),
    location_id: fields.locationId ?? LOCATION,
    source_type: "CARD",
    created_at: randomInstant(),
    updated_at: randomInstant(),
  };
}

/** A Square PaymentRefund, with the same decoys. */
function wireRefund(
  fields: { status?: string; amount?: number; currency?: string; paymentId?: string; locationId?: string } = {},
) {
  const amount = fields.amount ?? randomInt(1, 1_000_000);
  const currency = fields.currency ?? "JPY";
  return {
    id: `ref_${randomUUID()}`,
    status: fields.status ?? "PENDING",
    amount_money: { amount, currency },
    app_fee_money: { amount: amount + 1, currency },
    payment_id: fields.paymentId ?? `pay_${randomUUID()}`,
    location_id: fields.locationId ?? LOCATION,
    order_id: randomUUID(),
    created_at: randomInstant(),
    updated_at: randomInstant(),
  };
}

function assertPayment(actual: Json | undefined, wire: ReturnType<typeof wirePayment>, label: string) {
  assert.ok(actual, `${label}: no payment`);
  assert.equal(actual.id, wire.id, label);
  assert.equal(actual.status, wire.status, label);
  assert.equal(actual.amount, wire.amount_money.amount, label);
  assert.equal(actual.currency, wire.amount_money.currency, label);
  assert.equal(actual.reference_id, wire.reference_id, label);
  assert.equal(actual.created_at, wire.created_at, label);
}

function assertRefund(actual: Json | undefined, wire: ReturnType<typeof wireRefund>, label: string) {
  assert.ok(actual, `${label}: no refund`);
  assert.equal(actual.id, wire.id, label);
  assert.equal(actual.status, wire.status, label);
  assert.equal(actual.amount, wire.amount_money.amount, label);
  assert.equal(actual.currency, wire.amount_money.currency, label);
  assert.equal(actual.payment_id, wire.payment_id, label);
  assert.equal(actual.created_at, wire.created_at, label);
}

function paymentInput() {
  const bookingId = randomUUID();
  return {
    idempotencyKey: `${bookingId}:${randomInt(1, 9)}`,
    sourceId: `cnon:${randomUUID()}`,
    amountJpy: randomInt(1, 500_000),
    referenceId: bookingId,
  };
}

function refundInput() {
  return {
    idempotencyKey: `rf:${randomUUID()}`,
    paymentId: `pay_${randomUUID()}`,
    amountJpy: randomInt(1, 500_000),
    reason: `Cancelled ${randomInt(1, 60)} days before pickup`,
  };
}

interface Method {
  name: string;
  /** The key of a successful reply. */
  resource: "payment" | "refund" | "payments" | "refunds";
  call: (client: Client) => Promise<unknown>;
}

const METHODS: Method[] = [
  { name: "createPayment", resource: "payment", call: (client) => client.createPayment(paymentInput()) },
  { name: "getPayment", resource: "payment", call: (client) => client.getPayment(`pay_${randomUUID()}`) },
  { name: "refundPayment", resource: "refund", call: (client) => client.refundPayment(refundInput()) },
  { name: "listPayments", resource: "payments", call: (client) => client.listPayments(randomWindow()) },
  { name: "listRefunds", resource: "refunds", call: (client) => client.listRefunds(randomWindow()) },
];

const MONEY_MOVERS = METHODS.filter((method) => method.name === "createPayment" || method.name === "refundPayment");
const SINGLE_RESULT_METHODS = METHODS.filter((method) => method.resource === "payment" || method.resource === "refund");

function okReply(resource: Method["resource"]): Response {
  if (resource === "payment") return json(200, { payment: wirePayment() });
  if (resource === "refund") return json(200, { refund: wireRefund() });
  return json(200, { [resource]: [] });
}

interface Row {
  label: string;
  status: number;
  body: string | null;
  kind: "declined" | "error" | "unknown";
  code?: string;
  detail?: string;
}

function declinedRow(status: number, code: string): Row {
  const detail = `Authorization error: '${code}'`;
  const body = errorsBody({ category: "PAYMENT_METHOD_ERROR", code, detail });
  return { label: `${status} ${code}`, status, body, kind: "declined", code, detail };
}

function errorRow(status: number, category: string, code: string, note = ""): Row {
  const detail = `${code} from Square ${randomUUID()}`;
  const body = errorsBody({ category, code, detail });
  return { label: `${status} ${category} ${code} ${note}`, status, body, kind: "error", code, detail };
}

function errorBodyRow(status: number, label: string, body: string): Row {
  return { label: `${status} ${label}`, status, body, kind: "error" };
}

function unknownRow(status: number, label: string, body: string | null): Row {
  return { label: `${status} ${label}`, status, body, kind: "unknown" };
}

const DECLINE_CODES = [
  "CARD_DECLINED",
  "CVV_FAILURE",
  "INSUFFICIENT_FUNDS",
  "GENERIC_DECLINE",
  "ADDRESS_VERIFICATION_FAILURE",
  "CARD_DECLINED_VERIFICATION_REQUIRED",
  "VERIFY_CVV_FAILURE",
  "VERIFY_AVS_FAILURE",
  "EXPIRED_CARD",
  // The category decides, so a code nobody listed still declines.
  "A_CODE_SQUARE_ADDS_LATER",
];

const twoDeclines = errorsBody(
  { category: "PAYMENT_METHOD_ERROR", code: "CVV_FAILURE", detail: "CVV" },
  { category: "PAYMENT_METHOD_ERROR", code: "ADDRESS_VERIFICATION_FAILURE", detail: "AVS" },
);
const declineWithPayment = JSON.stringify({
  errors: [{ category: "PAYMENT_METHOD_ERROR", code: "CARD_DECLINED", detail: "Declined" }],
  payment: wirePayment({ status: "FAILED" }),
});

const ROWS: Row[] = [
  ...DECLINE_CODES.flatMap((code) => [declinedRow(400, code), declinedRow(402, code)]),
  { label: "400 two declines", status: 400, body: twoDeclines, kind: "declined", code: "CVV_FAILURE", detail: "CVV" },
  {
    label: "400 decline with the FAILED payment",
    status: 400,
    body: declineWithPayment,
    kind: "declined",
    code: "CARD_DECLINED",
    detail: "Declined",
  },

  errorRow(400, "INVALID_REQUEST_ERROR", "INVALID_VALUE"),
  errorRow(400, "INVALID_REQUEST_ERROR", "MISSING_REQUIRED_PARAMETER"),
  errorRow(400, "INVALID_REQUEST_ERROR", "IDEMPOTENCY_KEY_REUSED"),
  errorRow(400, "INVALID_REQUEST_ERROR", "CARD_DECLINED", "(the category decides, not the code)"),
  errorRow(401, "AUTHENTICATION_ERROR", "UNAUTHORIZED"),
  errorRow(403, "AUTHENTICATION_ERROR", "FORBIDDEN"),
  errorRow(404, "INVALID_REQUEST_ERROR", "NOT_FOUND"),
  errorRow(409, "INVALID_REQUEST_ERROR", "CONFLICT"),
  errorRow(429, "RATE_LIMIT_ERROR", "RATE_LIMITED"),
  errorBodyRow(400, "an error without detail", errorsBody({ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST" })),
  errorBodyRow(400, "plain text", "Bad Request"),
  errorBodyRow(403, "an HTML page", "<html><body>Forbidden</body></html>"),
  errorBodyRow(404, "an empty body", ""),
  errorBodyRow(429, "JSON without errors", "{}"),
  errorBodyRow(400, "an empty errors list", '{"errors":[]}'),
  errorBodyRow(400, "errors that are not a list", '{"errors":"nope"}'),
  errorBodyRow(400, "a null in errors", '{"errors":[null]}'),
  errorBodyRow(422, "JSON null", "null"),

  unknownRow(500, "API_ERROR", errorsBody({ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR", detail: "Boom" })),
  unknownRow(502, "API_ERROR", errorsBody({ category: "API_ERROR", code: "BAD_GATEWAY", detail: "Bad gateway" })),
  unknownRow(503, "API_ERROR", errorsBody({ category: "API_ERROR", code: "SERVICE_UNAVAILABLE", detail: "Down" })),
  unknownRow(504, "API_ERROR", errorsBody({ category: "API_ERROR", code: "GATEWAY_TIMEOUT", detail: "Slow" })),
  unknownRow(599, "the top of the class", errorsBody({ category: "API_ERROR", code: "UNKNOWN", detail: "?" })),
  // A 5xx may follow the charge, whatever its body claims.
  unknownRow(500, "PAYMENT_METHOD_ERROR", errorsBody({ category: "PAYMENT_METHOD_ERROR", code: "CARD_DECLINED" })),
  unknownRow(503, "AUTHENTICATION_ERROR", errorsBody({ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED" })),
  unknownRow(500, "an HTML page", "<html><body>Internal Server Error</body></html>"),
  unknownRow(502, "plain text", "upstream connect error"),
  unknownRow(503, "an empty body", ""),
  unknownRow(504, "no body", null),
  // Not 2xx, not 4xx and not 5xx: nothing says that no money moved.
  unknownRow(302, "a redirect", "Found"),
  unknownRow(304, "not modified", null),
];

/** Each way one payment or refund cannot be used, as [label, field, value]. Single results and list rows share it. */
function unusableFields(): [string, string, unknown][] {
  const amount = randomInt(1, 1_000_000);
  return [
    ["no id", "id", undefined],
    ["no status", "status", undefined],
    ["no amount_money", "amount_money", undefined],
    ["no amount", "amount_money", { currency: "JPY" }],
    ["no currency", "amount_money", { amount }],
    ["a string amount", "amount_money", { amount: String(amount), currency: "JPY" }],
  ];
}

/** A 2xx whose body cannot say what happened. The status says Square took the request, so money may have moved. */
function unusableBodies(resource: "payment" | "refund"): [string, number, string | null][] {
  const whole = resource === "payment" ? wirePayment() : wireRefund();
  const other = resource === "payment" ? "refund" : "payment";
  const withField = (field: string, value: unknown) => JSON.stringify({ [resource]: { ...whole, [field]: value } });
  return [
    ["no body", 200, null],
    ["204", 204, null],
    ["empty text", 200, ""],
    ["an HTML page", 200, "<html><body>ok</body></html>"],
    ["truncated JSON", 201, JSON.stringify({ [resource]: whole }).slice(0, -2)],
    ["JSON null", 200, "null"],
    ["a JSON list", 200, "[]"],
    ["a JSON string", 200, '"ok"'],
    ["an empty object", 200, "{}"],
    ["the other resource", 200, JSON.stringify({ [other]: whole })],
    ["a null resource", 200, JSON.stringify({ [resource]: null })],
    ["an empty resource", 200, JSON.stringify({ [resource]: {} })],
    ["a string for a resource", 200, JSON.stringify({ [resource]: "ok" })],
    ...unusableFields().map(([label, field, value]): [string, number, string] => [label, 200, withField(field, value)]),
  ];
}

/**
 * Values of an errors key other than an empty array, as [label, value]. The falsy and empty ones are here because
 * reading errors by truthiness, length or key count lets them through.
 */
function notEmptyErrors(): [string, unknown][] {
  return [
    ["an object", { code: "INTERNAL_SERVER_ERROR" }],
    ["an empty object", {}],
    ["a string", "upstream failed"],
    ["an empty string", ""],
    ["a number", randomInt(1, 1_000_000)],
    ["a zero", 0],
    ["a true", true],
    ["a false", false],
    ["a null", null],
    ["a list holding a null", [null]],
  ];
}

/**
 * 200 bodies that do not say the list is empty. A missing list is an empty one only when nothing else but a cursor came
 * back, because stuck-payment expiry and reconciliation read "no payment found" from these lists. An errors key says
 * the list cannot be trusted even beside one, whatever it holds, unless it is an empty array beside a present list.
 */
function notEmptyListBodies(key: "payments" | "refunds"): [string, Json][] {
  const whole = key === "payments" ? wirePayment() : wireRefund();
  const other = key === "payments" ? "refunds" : "payments";
  const serverError = { errors: [{ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR" }] };
  const clientError = { errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", detail: "Rejected" }] };
  return [
    ["a null list", { [key]: null }],
    ["a false list", { [key]: false }],
    ["the other resource's list", { [other]: [whole] }],
    ["the other resource's empty list", { [other]: [] }],
    ["errors on a 200", serverError],
    ["client errors on a 200", clientError],
    ["an empty errors list and no list", { errors: [] }],
    ["errors beside a list", { [key]: [whole], ...serverError }],
    ["errors beside an empty list", { [key]: [], ...serverError }],
    ...notEmptyErrors().flatMap(([label, errors]): [string, Json][] => [
      [`errors as ${label} beside rows`, { [key]: [whole], errors }],
      [`errors as ${label} beside an empty list`, { [key]: [], errors }],
      [`errors as ${label} and no list`, { errors }],
    ]),
    ["other content", { message: "ok" }],
    // A fresh name, so a list of the names to refuse cannot pass.
    ["a field nobody listed", { [`field_${randomUUID().slice(0, 8)}`]: "ok" }],
  ];
}

/**
 * Cursors that are neither absent nor a string, as [label, value]. Ending the walk on one would let a cut-short list
 * read as complete, so each is unknown whatever sits beside it. An empty string is a string, and ends the walk.
 */
function nonStringCursors(): [string, unknown][] {
  const next = `next+/=${randomUUID()}`;
  return [
    ["a null", null],
    ["a zero", 0],
    ["a number", randomInt(1, 1_000_000)],
    ["a false", false],
    ["a true", true],
    ["an empty object", {}],
    // These two hold a usable cursor, so unwrapping or coercing one reads on and shows in the request count.
    ["an object", { cursor: next }],
    ["an array", [next]],
    ["an empty array", []],
  ];
}

function unusableListBodies(key: "payments" | "refunds"): [string, string][] {
  const whole = key === "payments" ? wirePayment() : wireRefund();
  return [
    ...notEmptyListBodies(key).flatMap(([label, body]): [string, string][] => [
      [label, JSON.stringify(body)],
      // A cursor changes nothing about these: it does not make the page an empty one.
      [`${label} with a cursor`, JSON.stringify({ ...body, cursor: `next+/=${randomUUID()}` })],
    ]),
    ...nonStringCursors().flatMap(([label, cursor]): [string, string][] => [
      [`${label} cursor beside rows`, JSON.stringify({ [key]: [whole], cursor })],
      [`${label} cursor beside an empty list`, JSON.stringify({ [key]: [], cursor })],
      [`${label} cursor and no list`, JSON.stringify({ cursor })],
    ]),
    ["empty text", ""],
    ["an HTML page", "<html><body>ok</body></html>"],
    ["JSON null", "null"],
    ["a JSON list", "[]"],
    ["a string for the list", JSON.stringify({ [key]: "nope" })],
    ["an object for the list", JSON.stringify({ [key]: {} })],
    ["a null row", JSON.stringify({ [key]: [null] })],
    ["an empty row", JSON.stringify({ [key]: [{}] })],
    ...unusableFields().map(([label, field, value]): [string, string] => [
      `a row with ${label}`,
      JSON.stringify({ [key]: [{ ...whole, [field]: value }] }),
    ]),
  ];
}

function assertRow(result: Result, row: Row, label: string) {
  assert.equal(result.kind, row.kind, label);
  assert.equal(typeof result.detail, "string", `${label}: detail`);
  if (row.kind === "unknown") return;
  assert.equal(typeof result.code, "string", `${label}: code`);
  assert.notEqual(result.code, "", `${label}: code`);
  if (row.code !== undefined) assert.equal(result.code, row.code, `${label}: code`);
  if (row.detail !== undefined) assert.equal(result.detail, row.detail, `${label}: detail`);
}

function assertUnknown(result: Result, label: string) {
  assert.equal(result.kind, "unknown", label);
  assert.equal(typeof result.detail, "string", `${label}: detail`);
}

/** Refused before any request: the bearer token never left. */
function assertRejected(result: Result, calls: Recorded[], label: string) {
  assert.equal(calls.length, 0, `${label}: a request went out`);
  assert.equal(result.kind, "error", label);
  assert.equal(typeof result.code, "string", `${label}: code`);
  assert.notEqual(result.code, "", `${label}: code`);
  assert.equal(typeof result.detail, "string", `${label}: detail`);
}

test("createPayment sends a JPY payment with idempotency and reference", async () => {
  const id = () => randomUUID();
  const ids = [id(), id(), id(), id(), id()];
  const cases: {
    label: string;
    env: Env;
    input: {
      idempotencyKey: string;
      sourceId: string;
      amountJpy: number;
      referenceId: string;
      buyerEmail?: string;
      note?: string;
    };
    answer?: { amount: number; currency: string };
  }[] = [
    {
      label: "the usual deposit",
      env: "sandbox",
      input: {
        idempotencyKey: `${ids[0]}:1`,
        sourceId: "cnon:card-nonce-ok",
        amountJpy: 5000,
        referenceId: ids[0],
        buyerEmail: "taro@example.com",
      },
    },
    {
      label: "no buyer email",
      env: "production",
      input: { idempotencyKey: `${ids[1]}:2`, sourceId: `cnon:${id()}`, amountJpy: 1, referenceId: ids[1] },
    },
    {
      label: "a note and no buyer email",
      env: "sandbox",
      input: {
        idempotencyKey: `${ids[2]}:3`,
        sourceId: `cnon:${id()}`,
        amountJpy: 12_345,
        referenceId: ids[2],
        note: "Class B deposit",
      },
    },
    {
      label: "a random amount, an email and a multi-byte note",
      env: "production",
      input: {
        idempotencyKey: `${ids[3]}:4`,
        sourceId: `cnon:${id()}`,
        amountJpy: randomInt(2, 1_000_000),
        referenceId: ids[3],
        buyerEmail: `guest+${randomInt(1, 1000)}@example.jp`,
        note: "沖縄 🛵",
      },
    },
    {
      // The caller compares what Square charged with the deposit, so an echo of the request would hide a mismatch.
      label: "Square answers with another amount and currency",
      env: "sandbox",
      input: { idempotencyKey: `${ids[4]}:1`, sourceId: `cnon:${id()}`, amountJpy: 3000, referenceId: ids[4] },
      answer: { amount: 3100, currency: "USD" },
    },
  ];

  for (const { label, env, input, answer } of cases) {
    const accessToken = `EAAA${randomUUID()}`;
    const locationId = `LOC-${randomUUID().slice(0, 8)}`;
    const wire = wirePayment({
      amount: answer?.amount ?? input.amountJpy,
      currency: answer?.currency ?? "JPY",
      referenceId: input.referenceId,
      locationId,
    });
    const { fetch, calls } = recordingFetch(() => json(200, { payment: wire }));

    const result = (await clientWith({ accessToken, env, locationId, fetch }).createPayment(input)) as Result;

    assert.equal(calls.length, 1, label);
    const [call] = calls;
    assert.equal(call.method, "POST", label);
    assert.equal(call.url.href, `${BASE_URLS[env]}/v2/payments`, label);
    assert.equal(call.headers.get("authorization"), `Bearer ${accessToken}`, label);
    assert.equal(call.headers.get("square-version"), SQUARE_VERSION, label);
    assert.match(call.headers.get("content-type") ?? "", /^application\/json/, label);

    const expected: Json = {
      source_id: input.sourceId,
      idempotency_key: input.idempotencyKey,
      amount_money: { amount: input.amountJpy, currency: "JPY" },
      location_id: locationId,
      reference_id: input.referenceId,
      autocomplete: true,
    };
    if (input.buyerEmail !== undefined) expected.buyer_email_address = input.buyerEmail;
    if (input.note !== undefined) expected.note = input.note;
    assert.deepEqual(JSON.parse(call.text), expected, label);

    assert.equal(result.kind, "ok", label);
    assertPayment(result.payment, wire, label);
  }
});

test("responses map to ok, declined, error and unknown", { timeout: 30_000 }, async () => {
  // ok: a 2xx with a usable resource, whatever status Square reports. The caller judges COMPLETED and the amount.
  for (const httpStatus of [200, 201]) {
    for (const status of ["COMPLETED", "APPROVED", "PENDING", "FAILED", "CANCELED"]) {
      for (const method of ["createPayment", "getPayment"]) {
        const label = `${httpStatus} ${status} ${method}`;
        const wire = wirePayment({ status });
        const { fetch } = recordingFetch(() => json(httpStatus, { payment: wire }));
        const client = clientWith({ fetch });
        const pending = method === "createPayment" ? client.createPayment(paymentInput()) : client.getPayment(wire.id);
        const result = (await pending) as Result;
        assert.equal(result.kind, "ok", label);
        assertPayment(result.payment, wire, label);
      }
    }
    for (const status of ["PENDING", "COMPLETED", "REJECTED", "FAILED"]) {
      const label = `${httpStatus} ${status} refundPayment`;
      const wire = wireRefund({ status });
      const { fetch } = recordingFetch(() => json(httpStatus, { refund: wire }));
      const result = (await clientWith({ fetch }).refundPayment(refundInput())) as Result;
      assert.equal(result.kind, "ok", label);
      assertRefund(result.refund, wire, label);
    }
  }

  // Declines only come back from the calls that charge or refund; the other rows hold for every method.
  for (const row of ROWS) {
    for (const method of row.kind === "declined" ? MONEY_MOVERS : METHODS) {
      const { fetch } = recordingFetch(() => new Response(row.body, { status: row.status }));
      const result = (await method.call(clientWith({ fetch }))) as Result;
      assertRow(result, row, `${row.label}, ${method.name}`);
    }
  }

  for (const method of SINGLE_RESULT_METHODS) {
    for (const [label, status, body] of unusableBodies(method.resource === "refund" ? "refund" : "payment")) {
      const { fetch } = recordingFetch(() => new Response(body, { status }));
      const result = (await method.call(clientWith({ fetch }))) as Result;
      assertUnknown(result, `${status} with ${label}, ${method.name}`);
    }
  }
  for (const [name, key] of [
    ["listPayments", "payments"],
    ["listRefunds", "refunds"],
  ] as const) {
    const method = METHODS.find((candidate) => candidate.name === name);
    assert.ok(method);
    for (const [label, body] of unusableListBodies(key)) {
      const { fetch } = recordingFetch(() => new Response(body, { status: 200 }));
      const result = (await method.call(clientWith({ fetch }))) as Result;
      assertUnknown(result, `200 with ${label}, ${name}`);
      assert.equal(result[key], undefined, `200 with ${label}, ${name}`);
    }
  }

  const rejections: [string, () => unknown][] = [
    ["a network TypeError", () => new TypeError("fetch failed")],
    ["an AbortError", () => new DOMException("The operation was aborted", "AbortError")],
    ["a TimeoutError", () => new DOMException("The operation timed out", "TimeoutError")],
    ["a reset socket", () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["a rejected string", () => "connection lost"],
    ["a rejected undefined", () => undefined],
  ];
  for (const method of METHODS) {
    for (const [label, reason] of rejections) {
      const rejecting = (() => Promise.reject(reason())) as typeof fetch;
      const rejected = (await method.call(clientWith({ fetch: rejecting }))) as Result;
      assertUnknown(rejected, `${label} rejected, ${method.name}`);

      const throwing = (() => {
        throw reason();
      }) as typeof fetch;
      const thrown = (await method.call(clientWith({ fetch: throwing }))) as Result;
      assertUnknown(thrown, `${label} thrown, ${method.name}`);
    }

    for (const [label, hanging] of HANGING_FETCHES) {
      const result = (await method.call(clientWith({ fetch: hanging, timeoutMs: 10 }))) as Result;
      assertUnknown(result, `${label}, ${method.name}`);
    }
  }
});

test("over-long keys and references are rejected locally", async () => {
  // [idempotency key length, reference id length]
  const accepted: [number, number][] = [
    [1, 1],
    [36, 36],
    [44, 39],
    [45, 36],
    [36, 40],
    [45, 40],
  ];
  for (const [keyLength, referenceLength] of accepted) {
    const label = `key ${keyLength}, reference ${referenceLength}`;
    const input = {
      ...paymentInput(),
      idempotencyKey: randomText(keyLength),
      referenceId: randomText(referenceLength),
    };
    const { fetch, calls } = recordingFetch(() => json(200, { payment: wirePayment() }));
    const result = (await clientWith({ fetch }).createPayment(input)) as Result;
    assert.equal(result.kind, "ok", label);
    assert.equal(calls.length, 1, label);
    const body = JSON.parse(calls[0].text);
    assert.equal(body.idempotency_key, input.idempotencyKey, label);
    assert.equal(body.reference_id, input.referenceId, label);
  }

  const rejected: [number, number][] = [
    [46, 36],
    [47, 40],
    [100, 1],
    [36, 41],
    [45, 41],
    [1, 42],
    [36, 100],
    [46, 41],
  ];
  for (const [keyLength, referenceLength] of rejected) {
    const input = {
      ...paymentInput(),
      idempotencyKey: randomText(keyLength),
      referenceId: randomText(referenceLength),
    };
    const { fetch, calls } = recordingFetch(() => json(200, { payment: wirePayment() }));
    const result = (await clientWith({ fetch }).createPayment(input)) as Result;
    assertRejected(result, calls, `key ${keyLength}, reference ${referenceLength}`);
  }

  for (const keyLength of [1, 44, 45]) {
    const input = { ...refundInput(), idempotencyKey: randomText(keyLength) };
    const { fetch, calls } = recordingFetch(() => json(200, { refund: wireRefund() }));
    const result = (await clientWith({ fetch }).refundPayment(input)) as Result;
    assert.equal(result.kind, "ok", `refund key ${keyLength}`);
    assert.equal(JSON.parse(calls[0].text).idempotency_key, input.idempotencyKey, `refund key ${keyLength}`);
  }

  for (const keyLength of [46, 47, 200]) {
    const input = { ...refundInput(), idempotencyKey: randomText(keyLength) };
    const { fetch, calls } = recordingFetch(() => json(200, { refund: wireRefund() }));
    const result = (await clientWith({ fetch }).refundPayment(input)) as Result;
    assertRejected(result, calls, `refund key ${keyLength}`);
  }
});

test("refundPayment sends the amount and idempotency key", async () => {
  const cases: {
    label: string;
    env: Env;
    amountJpy: number;
    status: string;
    answer?: { amount: number; currency: string };
  }[] = [
    { label: "a whole deposit", env: "sandbox", amountJpy: 5000, status: "PENDING" },
    { label: "half a deposit", env: "production", amountJpy: 2500, status: "COMPLETED" },
    { label: "one yen", env: "sandbox", amountJpy: 1, status: "PENDING" },
    { label: "a random amount", env: "production", amountJpy: randomInt(2, 1_000_000), status: "PENDING" },
    {
      label: "Square answers with another amount and currency",
      env: "sandbox",
      amountJpy: 3000,
      status: "PENDING",
      answer: { amount: 2900, currency: "USD" },
    },
  ];

  for (const { label, env, amountJpy, status, answer } of cases) {
    const accessToken = `EAAA${randomUUID()}`;
    const input = { ...refundInput(), amountJpy };
    const wire = wireRefund({
      status,
      amount: answer?.amount ?? amountJpy,
      currency: answer?.currency ?? "JPY",
      paymentId: input.paymentId,
    });
    const { fetch, calls } = recordingFetch(() => json(200, { refund: wire }));

    const result = (await clientWith({ accessToken, env, fetch }).refundPayment(input)) as Result;

    assert.equal(calls.length, 1, label);
    const [call] = calls;
    assert.equal(call.method, "POST", label);
    assert.equal(call.url.href, `${BASE_URLS[env]}/v2/refunds`, label);
    assert.equal(call.headers.get("authorization"), `Bearer ${accessToken}`, label);
    assert.equal(call.headers.get("square-version"), SQUARE_VERSION, label);
    assert.match(call.headers.get("content-type") ?? "", /^application\/json/, label);
    assert.deepEqual(
      JSON.parse(call.text),
      {
        idempotency_key: input.idempotencyKey,
        amount_money: { amount: amountJpy, currency: "JPY" },
        payment_id: input.paymentId,
        reason: input.reason,
      },
      label,
    );

    assert.equal(result.kind, "ok", label);
    assertRefund(result.refund, wire, label);
  }
});

interface Listing {
  name: string;
  path: string;
  key: "payments" | "refunds";
  run: (client: Client, window: TimeWindow) => Promise<unknown>;
  /** A wire row at the client's location, and the check of what the client made of it. */
  row: (locationId?: string) => { wire: Json; check: (actual: Json | undefined, label: string) => void };
}

const LISTINGS: Listing[] = [
  {
    name: "listPayments",
    path: "/v2/payments",
    key: "payments",
    run: (client, window) => client.listPayments(window),
    row: (locationId) => {
      const status = ["COMPLETED", "FAILED", "CANCELED", "APPROVED"][randomInt(0, 4)];
      const wire = wirePayment({ status, locationId });
      return { wire, check: (actual, label) => assertPayment(actual, wire, label) };
    },
  },
  {
    name: "listRefunds",
    path: "/v2/refunds",
    key: "refunds",
    run: (client, window) => client.listRefunds(window),
    row: (locationId) => {
      const status = ["PENDING", "COMPLETED", "REJECTED", "FAILED"][randomInt(0, 4)];
      const wire = wireRefund({ status, locationId });
      return { wire, check: (actual, label) => assertRefund(actual, wire, label) };
    },
  },
];

function assertInstant(value: string | null, epochMs: number, label: string) {
  assert.match(value ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, label);
  assert.equal(Date.parse(value ?? ""), epochMs, label);
}

test("list calls follow cursors", async () => {
  // Rows per page. An empty page with a cursor is not the end.
  const pageSizes = [[3], [2, 1], [1, 4, 2, 3, 1], [0, 2], [2, 0, 1]];
  const windows: TimeWindow[] = [
    { beginTime: Date.UTC(2026, 9, 1, 0, 0, 0, 250), endTime: Date.UTC(2026, 10, 2, 14, 59, 59, 999) },
    { beginTime: Date.UTC(2025, 11, 31, 15), endTime: Date.UTC(2026, 0, 1, 15) },
    randomWindow(),
  ];

  for (const listing of LISTINGS) {
    for (const sizes of pageSizes) {
      // An empty cursor and an absent one both end the list.
      for (const lastCursor of [undefined, ""]) {
        for (const window of windows) {
          const locationId = `LOC-${randomUUID().slice(0, 8)}`;
          const pages = sizes.map((size, index) => ({
            rows: Array.from({ length: size }, () => listing.row(locationId)),
            // Square's cursors are base64, so a query built by hand loses the plus signs.
            cursor: index === sizes.length - 1 ? lastCursor : `c${index}+/=&${randomUUID()}`,
          }));
          const { fetch, calls } = recordingFetch((_call, index) => {
            const page = pages[index];
            if (!page) return new Response("past the last page", { status: 400 });
            const cursor = page.cursor === undefined ? {} : { cursor: page.cursor };
            return json(200, { [listing.key]: page.rows.map((row) => row.wire), ...cursor });
          });
          const label = `${listing.name}, pages ${sizes.join("+")}, last cursor ${JSON.stringify(lastCursor)}`;

          const result = (await listing.run(clientWith({ locationId, fetch }), window)) as Result;

          assert.equal(result.kind, "ok", label);
          assert.equal(calls.length, sizes.length, label);
          calls.forEach((call, index) => {
            const pageLabel = `${label}, request ${index}`;
            const query = call.url.searchParams;
            assert.equal(call.method, "GET", pageLabel);
            assert.equal(`${call.url.origin}${call.url.pathname}`, `${BASE_URLS.sandbox}${listing.path}`, pageLabel);
            assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`, pageLabel);
            assert.equal(call.headers.get("square-version"), SQUARE_VERSION, pageLabel);
            assert.deepEqual(query.getAll("location_id"), [locationId], pageLabel);
            assertInstant(query.get("begin_time"), window.beginTime, pageLabel);
            assertInstant(query.get("end_time"), window.endTime, pageLabel);
            assert.deepEqual(query.getAll("cursor"), index === 0 ? [] : [pages[index - 1].cursor], pageLabel);
            const limit = query.get("limit");
            if (limit !== null) {
              assert.ok(Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 100, pageLabel);
            }
          });

          const rows = pages.flatMap((page) => page.rows);
          const listed = result[listing.key];
          assert.equal(listed?.length, rows.length, label);
          rows.forEach((row, index) => row.check(listed?.[index], `${label}, row ${index}`));
        }
      }
    }
  }

  // Square sends {} when nothing matches, and that is an empty list rather than an unusable reply.
  for (const listing of LISTINGS) {
    for (const body of [{}, { [listing.key]: [] }]) {
      const { fetch, calls } = recordingFetch(() => json(200, body));
      const result = (await listing.run(clientWith({ fetch }), randomWindow())) as Result;
      assert.equal(result.kind, "ok", `${listing.name} ${JSON.stringify(body)}`);
      assert.deepEqual(result[listing.key], [], `${listing.name} ${JSON.stringify(body)}`);
      assert.equal(calls.length, 1, `${listing.name} ${JSON.stringify(body)}`);
    }
  }

  // A payment taken in the Square Dashboard has no reference_id, and reconciliation has to see it.
  const dashboard = wirePayment();
  const { reference_id: _reference, ...withoutReference } = dashboard;
  const { fetch } = recordingFetch(() => json(200, { payments: [withoutReference] }));
  const result = (await clientWith({ fetch }).listPayments(randomWindow())) as Result;
  assert.equal(result.kind, "ok");
  assert.equal(result.payments?.[0]?.id, dashboard.id);
  assert.equal(result.payments?.[0]?.amount, dashboard.amount_money.amount);
});

/** A fetch that answers 200 with each body in turn. Reading on past them gets a 400, which fails the walk. */
function pagesInTurn(bodies: string[]) {
  return recordingFetch((_call, index) =>
    index < bodies.length
      ? new Response(bodies[index], { status: 200 })
      : new Response("past the last page", { status: 400 }),
  );
}

test("malformed 200 list bodies map to unknown", async () => {
  // One such body decides for the whole walk, wherever it comes: unknown, no list, no partial list, no reading on.
  for (const listing of LISTINGS) {
    for (const [label, body] of unusableListBodies(listing.key)) {
      for (const goodPages of [0, 1, 2]) {
        const before = Array.from({ length: goodPages }, (_, index) =>
          JSON.stringify({ [listing.key]: [listing.row().wire], cursor: `next+/=${index}` }),
        );
        const { fetch, calls } = pagesInTurn([...before, body]);

        const result = (await listing.run(clientWith({ fetch }), randomWindow())) as Result;

        const description = `${listing.name}, ${label} after ${goodPages} good pages`;
        assertUnknown(result, description);
        assert.equal(result[listing.key], undefined, description);
        assert.equal(calls.length, goodPages + 1, description);
      }
    }
  }

  // A body of nothing but a string cursor is an empty page and the walk goes on. {} and an empty cursor end it, as they
  // do a page with rows or an empty list.
  const walks: ("rows" | "empty list" | "no list")[][] = [
    ["no list"],
    ["no list", "no list"],
    ["no list", "rows"],
    ["rows", "no list"],
    ["rows", "no list", "rows"],
    ["no list", "no list", "rows"],
    ["empty list"],
    ["rows", "empty list"],
  ];
  for (const listing of LISTINGS) {
    for (const walk of walks) {
      for (const lastCursor of [undefined, ""]) {
        const pages = walk.map((kind, index) => ({
          kind,
          rows: kind === "rows" ? Array.from({ length: randomInt(1, 4) }, () => listing.row()) : [],
          cursor: index === walk.length - 1 ? lastCursor : `c${index}+/=&${randomUUID()}`,
        }));
        const { fetch, calls } = pagesInTurn(
          pages.map(({ kind, rows, cursor }) =>
            JSON.stringify({
              ...(kind === "no list" ? {} : { [listing.key]: rows.map((row) => row.wire) }),
              ...(cursor === undefined ? {} : { cursor }),
            }),
          ),
        );
        const label = `${listing.name}, ${walk.join(" then ")}, last cursor ${JSON.stringify(lastCursor)}`;

        const result = (await listing.run(clientWith({ fetch }), randomWindow())) as Result;

        assert.equal(result.kind, "ok", label);
        assert.equal(calls.length, walk.length, label);
        calls.forEach((call, index) => {
          const sent = index === 0 ? [] : [pages[index - 1].cursor];
          assert.deepEqual(call.url.searchParams.getAll("cursor"), sent, `${label}, request ${index}`);
        });
        const rows = pages.flatMap((page) => page.rows);
        assert.equal(result[listing.key]?.length, rows.length, label);
        rows.forEach((row, index) => row.check(result[listing.key]?.[index], `${label}, row ${index}`));
      }
    }
  }

  // A present list is Square's own answer, so a field the client does not know leaves it alone, and an empty errors
  // list reports nothing. Every other errors value is in notEmptyListBodies.
  for (const listing of LISTINGS) {
    const added = `field_${randomUUID().slice(0, 8)}`;
    const extras: Json[] = [{ message: "ok" }, { [added]: { added: true } }, { errors: [] }];
    for (const extra of extras) {
      for (const sizes of [[2, 1], [0, 1], [1, 0], [0]]) {
        const pages = sizes.map((size) => Array.from({ length: size }, () => listing.row()));
        const { fetch, calls } = pagesInTurn(
          pages.map((page, index) =>
            JSON.stringify({
              [listing.key]: page.map((row) => row.wire),
              ...extra,
              ...(index < pages.length - 1 ? { cursor: `next+/=${randomUUID()}` } : {}),
            }),
          ),
        );
        const label = `${listing.name}, pages ${sizes.join("+")} beside ${Object.keys(extra).join()}`;

        const result = (await listing.run(clientWith({ fetch }), randomWindow())) as Result;

        assert.equal(result.kind, "ok", label);
        assert.equal(calls.length, sizes.length, label);
        const rows = pages.flat();
        assert.equal(result[listing.key]?.length, rows.length, label);
        rows.forEach((row, index) => row.check(result[listing.key]?.[index], `${label}, row ${index}`));
      }
    }
  }
});

test("sandbox and production base URLs", async () => {
  for (const env of ENVS) {
    for (const method of METHODS) {
      const label = `${env} ${method.name}`;
      const accessToken = `EAAA${randomUUID()}`;
      const { fetch, calls } = recordingFetch(() => okReply(method.resource));

      const result = (await method.call(clientWith({ accessToken, env, fetch }))) as Result;

      assert.equal(result.kind, "ok", label);
      assert.equal(calls.length, 1, label);
      assert.equal(calls[0].url.origin, BASE_URLS[env], label);
      assert.equal(calls[0].headers.get("square-version"), SQUARE_VERSION, label);
      assert.equal(calls[0].headers.get("authorization"), `Bearer ${accessToken}`, label);
    }
  }
});

test("errors never contain the access token", { timeout: 30_000 }, async (t) => {
  const logged: string[] = [];
  for (const level of ["debug", "error", "info", "log", "warn"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => {
      logged.push(inspect(args, { depth: null, showHidden: true }));
    });
  }

  const token = `EAAA${randomUUID()}`;
  const echo = `Authorization: Bearer ${token}`;
  const assertClean = (result: unknown, label: string) => {
    assert.equal(typeof (result as Result).kind, "string", label);
    assert.ok(!inspect(result, { depth: null, showHidden: true }).includes(token), `${label}: token in the result`);
    assert.ok(!JSON.stringify(result).includes(token), `${label}: token in the serialised result`);
  };

  const client = clientWith({ accessToken: token, fetch: neverResolves });
  assert.ok(!inspect(client, { depth: null, showHidden: true }).includes(token), "token on the client object");

  const replies: [string, number, string][] = [
    ["a decline", 400, errorsBody({ category: "PAYMENT_METHOD_ERROR", code: "CARD_DECLINED", detail: echo })],
    ["a 401", 401, errorsBody({ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: `Bad ${token}.` })],
    ["an error code", 400, errorsBody({ category: "INVALID_REQUEST_ERROR", code: token, detail: "Rejected" })],
    ["an error field", 400, errorsBody({ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", field: echo })],
    ["a 4xx in plain text", 400, `Bad header ${echo}`],
    ["a 500", 500, errorsBody({ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR", detail: echo })],
    ["a 503 in plain text", 503, `upstream refused ${echo}`],
    // JSON.parse quotes the start of what it could not parse in its own message.
    ["a 2xx that is not JSON", 200, `${token} is not JSON`],
    ["a 2xx without the resource", 200, JSON.stringify({ echo })],
    ["a 2xx with an unexpected field name", 200, JSON.stringify({ [echo]: "ok" })],
    ["errors on a 2xx", 200, errorsBody({ category: "API_ERROR", code: token, detail: echo })],
  ];
  const rejections: [string, () => unknown][] = [
    ["an Error", () => new TypeError(`fetch failed: ${echo}`)],
    ["an Error with a cause", () => new Error("fetch failed", { cause: new Error(echo) })],
    ["a string", () => echo],
    ["an object", () => ({ request: { headers: { authorization: `Bearer ${token}` } } })],
  ];

  for (const method of METHODS) {
    for (const [label, status, body] of replies) {
      const { fetch } = recordingFetch(() => new Response(body, { status }));
      const result = await method.call(clientWith({ accessToken: token, fetch }));
      assertClean(result, `${label}, ${method.name}`);
    }
    for (const [label, reason] of rejections) {
      const rejecting = (() => Promise.reject(reason())) as typeof fetch;
      assertClean(await method.call(clientWith({ accessToken: token, fetch: rejecting })), `${label}, ${method.name}`);
      const throwing = (() => {
        throw reason();
      }) as typeof fetch;
      assertClean(await method.call(clientWith({ accessToken: token, fetch: throwing })), `${label}, ${method.name}`);
    }
    for (const [label, hanging] of HANGING_FETCHES) {
      const result = await method.call(clientWith({ accessToken: token, fetch: hanging, timeoutMs: 10 }));
      assertClean(result, `${label}, ${method.name}`);
    }
  }

  const { fetch: unused } = recordingFetch(() => json(200, {}));
  const local = clientWith({ accessToken: token, fetch: unused });
  assertClean(await local.createPayment({ ...paymentInput(), idempotencyKey: randomText(46) }), "long key");
  assertClean(await local.createPayment({ ...paymentInput(), referenceId: randomText(41) }), "long reference");
  assertClean(await local.refundPayment({ ...refundInput(), idempotencyKey: randomText(46) }), "long refund key");

  assert.ok(!logged.join("\n").includes(token), "token in the logs");
});

test("getPayment asks for one payment by id", async () => {
  for (const env of ENVS) {
    for (const status of ["COMPLETED", "FAILED"]) {
      const label = `${env} ${status}`;
      const wire = wirePayment({ status });
      const { fetch, calls } = recordingFetch(() => json(200, { payment: wire }));
      const result = (await clientWith({ env, fetch }).getPayment(wire.id)) as Result;
      assert.equal(calls.length, 1, label);
      assert.equal(calls[0].method, "GET", label);
      assert.equal(calls[0].url.href, `${BASE_URLS[env]}/v2/payments/${wire.id}`, label);
      assert.equal(calls[0].text, "", label);
      assert.equal(result.kind, "ok", label);
      assertPayment(result.payment, wire, label);
    }
  }

  // Whatever the id holds, it stays inside its own path segment: refused locally or sent escaped.
  for (const id of ["../refunds", "a/b", "pay?location_id=other", "pay#fragment", "pay%2F..%2Frefunds", "支払い 1"]) {
    const { fetch, calls } = recordingFetch(() => json(200, { payment: wirePayment() }));
    await clientWith({ fetch }).getPayment(id);
    for (const call of calls) {
      const prefix = "/v2/payments/";
      assert.ok(call.url.pathname.startsWith(prefix), id);
      const segment = call.url.pathname.slice(prefix.length);
      assert.ok(!segment.includes("/"), id);
      assert.equal(decodeURIComponent(segment), id);
      assert.equal(call.url.search, "", id);
      assert.equal(call.url.hash, "", id);
    }
  }

  // These cannot stay in a segment. Escaping leaves dots alone and the URL parser resolves them, so ".." would send the
  // bearer token to /v2/ and "." to /v2/payments/.
  // Ruling: an empty id is refused the same way, because it would ask for /v2/payments/ and not for one payment.
  for (const id of ["", ".", ".."]) {
    const { fetch, calls } = recordingFetch(() => json(200, { payment: wirePayment() }));
    const result = (await clientWith({ fetch }).getPayment(id)) as Result;
    assertRejected(result, calls, `id ${JSON.stringify(id)}`);
  }
});

/** Puts every timer a client could reach for on the test's clock: setTimeout, and AbortSignal.timeout through it. */
function mockClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), ms);
    return controller.signal;
  });
}

/** Lets promise callbacks and stream reads run. setImmediate stays real under mockClock. */
async function settle() {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function track(pending: Promise<unknown>) {
  const state: { settled: boolean; result?: Result } = { settled: false };
  pending.then(
    (value) => {
      state.settled = true;
      state.result = value as Result;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

test("a timeout maps to unknown at timeoutMs, and at 15 s by default", { timeout: 10_000 }, async (t) => {
  mockClock(t);
  const budgets: [number | undefined, number][] = [
    [undefined, DEFAULT_TIMEOUT_MS],
    [1234, 1234],
    [40_000, 40_000],
  ];

  for (const [timeoutMs, elapsed] of budgets) {
    for (const [fetchLabel, hanging] of HANGING_FETCHES) {
      for (const method of METHODS) {
        const label = `${fetchLabel}, timeoutMs ${timeoutMs}, ${method.name}`;
        const options: ClientOptions = timeoutMs === undefined ? { fetch: hanging } : { fetch: hanging, timeoutMs };
        const state = track(method.call(clientWith(options)));
        await settle();
        t.mock.timers.tick(elapsed - 1);
        await settle();
        assert.equal(state.settled, false, `${label}: gave up early`);
        t.mock.timers.tick(1);
        await settle();
        assert.equal(state.settled, true, `${label}: still waiting`);
        assert.ok(state.result, `${label}: rejected`);
        assertUnknown(state.result, label);
      }
    }
  }
});

test("a response body that stalls or breaks maps to unknown", { timeout: 10_000 }, async () => {
  // The status line has arrived, so only the body can tell what Square did. Honours the signal as the real body does.
  const stalledBody =
    (status: number): typeof fetch =>
    async (input, init) => {
      const signal = signalOf(input, init);
      const body = new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      return new Response(body, { status });
    };
  const brokenBody =
    (status: number): typeof fetch =>
    async () => {
      const body = new ReadableStream({
        pull(controller) {
          controller.error(new TypeError("terminated"));
        },
      });
      return new Response(body, { status });
    };

  for (const method of METHODS) {
    for (const status of [200, 500]) {
      const stalled = (await method.call(clientWith({ fetch: stalledBody(status), timeoutMs: 10 }))) as Result;
      assertUnknown(stalled, `${status} stalled, ${method.name}`);
      const broken = (await method.call(clientWith({ fetch: brokenBody(status) }))) as Result;
      assertUnknown(broken, `${status} broken, ${method.name}`);
    }
  }
});

test("list calls stop at the page cap and never report a cut-short listing as complete", async () => {
  // Stuck-payment expiry reads "no payment found" from these lists, so a partial list must not look like a whole one.
  for (const listing of LISTINGS) {
    for (const nextCursor of [(index: number) => `next-${index}`, () => "the-same-cursor"]) {
      const { fetch, calls } = recordingFetch((_call, index) =>
        json(200, { [listing.key]: [listing.row().wire], cursor: nextCursor(index) }),
      );

      const result = (await listing.run(clientWith({ fetch }), randomWindow())) as Result;

      assert.ok(calls.length > 1, `${listing.name}: stopped after ${calls.length} request`);
      assert.ok(calls.length <= PAGE_CAP_LIMIT, `${listing.name}: ${calls.length} requests`);
      assertUnknown(result, listing.name);
      assert.equal(result[listing.key], undefined, listing.name);
    }
  }
});

test("a failure on any page fails the whole listing", { timeout: 10_000 }, async () => {
  const failures: [string, "error" | "unknown", () => Response | Promise<Response>][] = [
    ["a 500", "unknown", () => json(500, { errors: [{ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR" }] })],
    ["a 503 page", "unknown", () => new Response("<html>down</html>", { status: 503 })],
    ["a 2xx that is not JSON", "unknown", () => new Response("<html>ok</html>", { status: 200 })],
    ["a rejection", "unknown", () => Promise.reject(new TypeError("fetch failed"))],
    ["a hang", "unknown", () => new Promise<Response>(() => {})],
    ["a 400", "error", () => json(400, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "INVALID_CURSOR" }] })],
    ["a 429", "error", () => json(429, { errors: [{ category: "RATE_LIMIT_ERROR", code: "RATE_LIMITED" }] })],
  ];

  for (const listing of LISTINGS) {
    for (const failingPage of [1, 2]) {
      for (const [label, kind, fail] of failures) {
        const { fetch, calls } = recordingFetch((_call, index) =>
          index === failingPage ? fail() : json(200, { [listing.key]: [listing.row().wire], cursor: `next-${index}` }),
        );

        const result = (await listing.run(clientWith({ fetch, timeoutMs: 10 }), randomWindow())) as Result;

        const description = `${listing.name}, ${label} on request ${failingPage}`;
        assert.equal(result.kind, kind, description);
        assert.equal(calls.length, failingPage + 1, description);
        assert.equal(result[listing.key], undefined, description);
      }
    }
  }
});

test("an unusable row on any page fails the whole listing", async () => {
  // Reconciliation reads these lists. A 2xx with a row missing its id, status, or numeric amount and currency says
  // nothing about that money, so the listing is unknown as a whole, with no list and no partial list.
  const layouts: ("good" | "bad")[][][] = [
    [["good", "bad"]],
    [["bad", "good"]],
    [["good"], ["bad"]],
    [
      ["good", "good"],
      ["good", "bad"],
    ],
    [["good"], ["bad", "good"], ["good"]],
    [["bad"], ["good"]],
  ];

  const listPages = (listing: Listing, pages: Json[][]) => {
    const { fetch } = recordingFetch((_call, index) => {
      const rows = pages[index];
      if (!rows) return new Response("past the last page", { status: 400 });
      const cursor = index < pages.length - 1 ? { cursor: `next+/=${randomUUID()}` } : {};
      return json(200, { [listing.key]: rows, ...cursor });
    });
    return listing.run(clientWith({ fetch }), randomWindow()) as Promise<Result>;
  };

  for (const listing of LISTINGS) {
    for (const layout of layouts) {
      const shape = JSON.stringify(layout);

      // The same pages with nothing wrong are a whole list, so only the bad row can fail the ones below.
      const sound = layout.map((page) => page.map(() => listing.row()));
      const whole = await listPages(
        listing,
        sound.map((page) => page.map((row) => row.wire)),
      );
      assert.equal(whole.kind, "ok", `${listing.name}, ${shape} with nothing wrong`);
      sound.flat().forEach((row, index) => {
        row.check(whole[listing.key]?.[index], `${listing.name}, ${shape} with nothing wrong, row ${index}`);
      });

      for (const [label, field, value] of unusableFields()) {
        const pages = layout.map((page) =>
          page.map((row) => {
            const { wire } = listing.row();
            return row === "good" ? wire : { ...wire, [field]: value };
          }),
        );

        const result = await listPages(listing, pages);

        const description = `${listing.name}, ${shape}, a row with ${label}`;
        assertUnknown(result, description);
        assert.equal(result[listing.key], undefined, description);
      }
    }
  }
});
