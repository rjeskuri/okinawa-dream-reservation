// The Square Payments and Refunds APIs over an injected fetch. Every call ends in one result kind: ok; declined, where
// the card was refused; error, where no money moved; or unknown, where money may have moved and the caller has to find
// out which. Nothing here reads `env`: src/server/square.ts builds the client.

const SQUARE_VERSION = "2026-09-16";

const BASE_URLS = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 45;
const MAX_REFERENCE_ID_LENGTH = 40;
const PAGE_SIZE = 100;
const PAGE_CAP = 100;
const REDACTED = "[redacted]";

type Json = Record<string, unknown>;

type Ok<Key extends string, Value> = { kind: "ok" } & Record<Key, Value>;

export type SquareEnv = keyof typeof BASE_URLS;

/** A payment or a refund, flat. `amount` and `currency` come from amount_money, and `created_at` stays RFC 3339. */
export type SquareRecord = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  reference_id?: string;
  payment_id?: string;
  created_at?: string;
};

export type SquareFailure =
  | { kind: "declined"; code: string; detail: string }
  | { kind: "error"; code: string; detail: string }
  | { kind: "unknown"; detail: string };

export type PaymentResult = Ok<"payment", SquareRecord> | SquareFailure;
export type RefundResult = Ok<"refund", SquareRecord> | SquareFailure;
export type PaymentListResult = Ok<"payments", SquareRecord[]> | SquareFailure;
export type RefundListResult = Ok<"refunds", SquareRecord[]> | SquareFailure;

export type SquareClientOptions = {
  accessToken: string;
  env: SquareEnv;
  locationId: string;
  fetch: typeof fetch;
  timeoutMs?: number;
};

export type CreatePaymentInput = {
  idempotencyKey: string;
  sourceId: string;
  amountJpy: number;
  referenceId: string;
  buyerEmail?: string;
  note?: string;
};

export type RefundPaymentInput = {
  idempotencyKey: string;
  paymentId: string;
  amountJpy: number;
  reason: string;
};

/** Epoch ms UTC. */
export type SquareTimeWindow = { beginTime: number; endTime: number };

export type SquareClient = {
  createPayment(input: CreatePaymentInput): Promise<PaymentResult>;
  getPayment(id: string): Promise<PaymentResult>;
  listPayments(window: SquareTimeWindow): Promise<PaymentListResult>;
  refundPayment(input: RefundPaymentInput): Promise<RefundResult>;
  listRefunds(window: SquareTimeWindow): Promise<RefundListResult>;
};

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function rejectionText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" ? reason : "no reason given";
}

/** Refuses a call before any request, so the bearer token never leaves. */
function refused(code: string, detail: string): SquareFailure {
  return { kind: "error", code, detail };
}

function keyTooLong(): SquareFailure {
  return refused("IDEMPOTENCY_KEY_TOO_LONG", `An idempotency key has at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
}

/**
 * The one check of a payment or a refund, for single results and list rows alike. Null means it says nothing usable
 * about that money. A Dashboard payment has no reference_id and an unlinked refund has no payment_id, so those can be
 * missing.
 */
function readRecord(value: unknown): SquareRecord | null {
  if (!isRecord(value) || !isRecord(value.amount_money)) return null;
  const { id, status, reference_id, payment_id, created_at } = value;
  const { amount, currency } = value.amount_money;
  if (!isText(id) || !isText(status) || !isText(currency)) return null;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) return null;
  return {
    id,
    status,
    amount,
    currency,
    reference_id: isText(reference_id) ? reference_id : undefined,
    payment_id: isText(payment_id) ? payment_id : undefined,
    created_at: isText(created_at) ? created_at : undefined,
  };
}

/**
 * One 200 page of a list, or null when it cannot be trusted. Stuck-payment expiry and reconciliation read "no payment
 * found" from these lists, so a missing list is an empty one only when the body holds nothing but a cursor.
 */
function readPage(body: unknown, key: "payments" | "refunds"): { records: SquareRecord[]; cursor: string } | null {
  if (!isRecord(body)) return null;
  const { errors, cursor = "", [key]: list } = body;
  if (typeof cursor !== "string") return null;
  if (errors !== undefined && !(Array.isArray(errors) && errors.length === 0)) return null;
  if (list === undefined) {
    return Object.keys(body).every((field) => field === "cursor") ? { records: [], cursor } : null;
  }
  if (!Array.isArray(list)) return null;

  const records: SquareRecord[] = [];
  for (const row of list) {
    const record = readRecord(row);
    if (record === null) return null;
    records.push(record);
  }
  return { records, cursor };
}

/** Throws on an env that is not sandbox or production, so a bad value never falls through to a default. */
export function createSquareClient(options: SquareClientOptions): SquareClient {
  const { accessToken, env, locationId, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (!Object.hasOwn(BASE_URLS, env)) throw new Error("The Square env must be sandbox or production");
  const baseUrl = BASE_URLS[env];
  // A local reference on purpose: the Workers fetch throws Illegal invocation when called as a method of `options`.
  const send = options.fetch;

  function scrub(text: string): string {
    return accessToken === "" ? text : text.replaceAll(accessToken, REDACTED);
  }

  function unknown(detail: string): SquareFailure {
    return { kind: "unknown", detail: scrub(detail) };
  }

  /** One timer per request, over the fetch and the body read. A fetch that ignores the abort still loses the race. */
  async function exchange(path: string, init: RequestInit): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`no answer within ${timeoutMs} ms`));
        controller.abort();
      }, timeoutMs);
    });
    const answered = (async () => {
      const response = await send(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Square-Version": SQUARE_VERSION,
          "Content-Type": "application/json",
        },
        // Following a redirect would hide the 3xx that maps to unknown, and could carry the bearer token elsewhere.
        redirect: "manual",
        signal: controller.signal,
      });
      return { status: response.status, text: await response.text() };
    })();
    try {
      return await Promise.race([answered, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Any 4xx: no money moved. The category decides a decline, whatever the code says. */
  function clientFailure(status: number, text: string): SquareFailure {
    const body = parseJson(text);
    const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors.filter(isRecord) : [];
    const decline = errors.find((error) => error.category === "PAYMENT_METHOD_ERROR");
    const first = decline ?? errors[0];
    const code = isText(first?.code) ? first.code : `HTTP_${status}`;
    const detail = isText(first?.detail) ? first.detail : `Square answered HTTP ${status}`;
    return { kind: decline ? "declined" : "error", code: scrub(code), detail: scrub(detail) };
  }

  async function call(path: string, init: RequestInit): Promise<{ kind: "ok"; body: unknown } | SquareFailure> {
    let reply: { status: number; text: string };
    try {
      reply = await exchange(path, init);
    } catch (reason) {
      return unknown(`Square request failed: ${rejectionText(reason)}`);
    }
    const { status, text } = reply;
    if (status >= 200 && status < 300) return { kind: "ok", body: parseJson(text) };
    if (status >= 400 && status < 500) return clientFailure(status, text);
    // A 5xx may follow the charge, whatever its body claims, and nothing in a 3xx says that no money moved.
    return unknown(`Square answered HTTP ${status}`);
  }

  async function one<Key extends "payment" | "refund">(
    key: Key,
    path: string,
    init: RequestInit,
  ): Promise<Ok<Key, SquareRecord> | SquareFailure> {
    const answer = await call(path, init);
    if (answer.kind !== "ok") return answer;
    const record = isRecord(answer.body) ? readRecord(answer.body[key]) : null;
    if (record === null) return unknown(`Square answered with no usable ${key}`);
    return { kind: "ok", [key]: record } as Ok<Key, SquareRecord>;
  }

  /** Walks every page or fails as a whole: a list cut short must not read as a complete one. */
  async function all<Key extends "payments" | "refunds">(
    key: Key,
    path: string,
    { beginTime, endTime }: SquareTimeWindow,
  ): Promise<Ok<Key, SquareRecord[]> | SquareFailure> {
    const query = new URLSearchParams({
      begin_time: new Date(beginTime).toISOString(),
      end_time: new Date(endTime).toISOString(),
      location_id: locationId,
      limit: String(PAGE_SIZE),
    });
    const records: SquareRecord[] = [];
    for (let page = 0; page < PAGE_CAP; page += 1) {
      const answer = await call(`${path}?${query}`, { method: "GET" });
      if (answer.kind !== "ok") return answer;
      const read = readPage(answer.body, key);
      if (read === null) return unknown(`Square answered with an unusable page of ${key}`);
      records.push(...read.records);
      if (read.cursor === "") return { kind: "ok", [key]: records } as Ok<Key, SquareRecord[]>;
      query.set("cursor", read.cursor);
    }
    return unknown(`The ${key} listing did not end within ${PAGE_CAP} pages`);
  }

  function post(body: Json): RequestInit {
    return { method: "POST", body: JSON.stringify(body) };
  }

  return {
    async createPayment({ idempotencyKey, sourceId, amountJpy, referenceId, buyerEmail, note }) {
      if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) return keyTooLong();
      if (referenceId.length > MAX_REFERENCE_ID_LENGTH) {
        return refused("REFERENCE_ID_TOO_LONG", `A reference id has at most ${MAX_REFERENCE_ID_LENGTH} characters`);
      }
      return one(
        "payment",
        "/v2/payments",
        post({
          source_id: sourceId,
          idempotency_key: idempotencyKey,
          amount_money: { amount: amountJpy, currency: "JPY" },
          location_id: locationId,
          reference_id: referenceId,
          autocomplete: true,
          buyer_email_address: buyerEmail,
          note,
        }),
      );
    },

    async getPayment(id) {
      // Escaping leaves dots alone and the URL parser resolves them, so "." and ".." would send the bearer token to
      // another path. encodeURIComponent throws on a lone surrogate.
      if (id === "" || id === "." || id === ".." || !id.isWellFormed()) {
        return refused("INVALID_PAYMENT_ID", "A payment id must name one payment");
      }
      return one("payment", `/v2/payments/${encodeURIComponent(id)}`, { method: "GET" });
    },

    listPayments(window) {
      return all("payments", "/v2/payments", window);
    },

    async refundPayment({ idempotencyKey, paymentId, amountJpy, reason }) {
      if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) return keyTooLong();
      return one(
        "refund",
        "/v2/refunds",
        post({
          idempotency_key: idempotencyKey,
          amount_money: { amount: amountJpy, currency: "JPY" },
          payment_id: paymentId,
          reason,
        }),
      );
    },

    listRefunds(window) {
      return all("refunds", "/v2/refunds", window);
    },
  };
}
