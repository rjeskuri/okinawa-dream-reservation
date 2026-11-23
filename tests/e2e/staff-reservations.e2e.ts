// POST /api/staff/reservations through the built Worker in Miniflare (#152): the Add a reservation panel books a phone or
// walk-in guest, paid at the shop. The body is the `{ ts, payload, sig }` envelope signed with PUBLISH_SECRET (owner
// decision 5), signed here with node:crypto the way the Apps Script signs it, and because WebCrypto refuses the empty
// secret one test needs. `outbound` fakes all the Worker may reach: the mail web app, which checks each envelope under
// testVars.MAIL_SECRET and records the message, and Google's token and Sheets over a FakeSheets Bookings tab. Anything else,
// Square included, is a stray and fails the test.
//
// The Worker reads the real clock. Every booking here is years ahead, and the shop's min_lead_hours is ten years, so each
// one is inside a guest's lead time: staff bookings have none (owner decision 1). Instants come from
// Date.parse on an explicit +09:00 offset, cancel tokens from node:crypto, and plates, prices, deposits and reasons are
// literals worked out by hand from the assignment rule (least usage, then the lowest odometer, then the lowest plate), so
// no expected value passes through the code under test. Each test seeds its own model and bikes.
//
// Every POST says Content-Type: application/json as the Apps Script does: Astro's origin check answers 403 to a cross-site
// POST with no type.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - The payload's shape is checked before any booking: it is an object; requestedBy, id, modelId, packageId, date and time
//   are strings; locale passes isLocale; guest is an object whose four fields are strings; id is 1 to 200 characters.
//   Anything else is a 400 in plain words. A blank string is no shape fault: the guest's go to INVALID_GUEST, and a date or
//   time that is no real one goes to the pickup rules as pickupInstant's NaN, which is OFF_SLOT.
// - requestedBy may be "", which currentUser_ in apps-script/Publish.js sends when it cannot read the user.
// - A booking answers exactly `{ ok: true, booking }` with the outline's nine fields. A refusal answers 200 with exactly
//   `{ ok: false, reason }`, plus `fields` for INVALID_GUEST. An id already used for another request is CONFLICT.
// - The 401 body is `{ error: "unauthorized" }`, as on the other signed routes. The 413, 500 and 400 bodies are short plain
//   words, since the panel shows staff a failure's body as it stands.
// - A guest with a blank email (owner decision 2) books, gets no confirmation, and the staff email and Bookings row still
//   go out. It may be stored as "" or NULL.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { BOOKINGS_COLUMNS } from "../../src/lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../../src/lib/crypto.ts";
import type { Locale } from "../../src/lib/locale.ts";
import type { MailMessage } from "../../src/lib/mail/transport.ts";
import { fakeGoogleSheets, GOOGLE_PRIVATE_KEY } from "../helpers/fake-google.ts";
import { createFakeSheets, type FakeSheets } from "../helpers/fake-sheets.ts";
import {
  seedBooking,
  seedCatalogMeta,
  seedClosedDates,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedTiers,
  seedType,
  seedVehicle,
  type BookingRow,
} from "../helpers/seed.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const PATH = "/api/staff/reservations";
const JSON_HEADERS = { "Content-Type": "application/json" };
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** How long the drain after an answer may take to deliver what the booking queued. */
const SETTLE_MS = 10_000;

/** Set apart from testVars, so that what the Worker signs, links and sends to can only come from its own env. */
const SECRET = `publish-secret-${randomUUID()}`;
const SITE_URL = "https://ride.okinawa-dream.example";
const STAFF_EMAIL = `front-desk-${randomUUID().slice(0, 8)}@okinawa-dream.example`;
const CANCEL_SECRET = `cancel-secret-${randomUUID()}`;
const REQUESTED_BY = "counter@okinawa-dream.example";

/** Ten years each way: every pickup of this file is inside a guest's lead time and inside the horizon. */
const LEAD_HOURS = 24 * 3650;
const HORIZON_DAYS = 3650;
const CLOSED_DATES = ["2030-08-20", "2030-08-27"];

type Json = Record<string, unknown>;
type Guest = { familyName: string; givenName: string; email: string; phone: string };

const RURI: Guest = { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.jp", phone: "090-8686-3535" };
const MINHO: Guest = { familyName: "이", givenName: "민호", email: "minho@example.kr", phone: "+82 10-5151-2929" };
const NA: Guest = { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000" };
const HANAKO: Guest = { familyName: "Yamada", givenName: "Hanako", email: "hanako@example.jp", phone: "090-1234-5678" };

type Kind = "cub" | "forza";
type PackageKey = "day" | "three" | "fourHours";

const PACKAGE_KEYS: PackageKey[] = ["day", "three", "fourHours"];
const LENGTHS: Record<PackageKey, { days: number } | { hours: number }> = {
  day: { days: 1 },
  three: { days: 3 },
  fourHours: { hours: 4 },
};

/** Two rate classes of two types, so the price follows the package and the class, and the deposit follows the type. */
const KINDS: Record<Kind, { type: string; deposit: number; prices: Record<PackageKey, number> }> = {
  cub: { type: "motorcycle", deposit: 7_300, prices: { day: 18_700, three: 47_300, fourHours: 6_900 } },
  forza: { type: "scooter", deposit: 3_000, prices: { day: 26_400, three: 64_250, fourHours: 9_800 } },
};

type Shop = { db: D1Database; packages: Record<PackageKey, string>; rateClasses: Record<Kind, string> };
type Line = { kind: Kind; modelId: string; packages: Record<PackageKey, string>; plates: Record<string, string> };

type Payload = {
  requestedBy: string;
  id: string;
  modelId: string;
  packageId: string;
  date: string;
  time: string;
  locale: Locale;
  guest: Guest;
};

type Answered = {
  id: string;
  ref: string;
  modelId: string;
  packageId: string;
  plate: string;
  startAt: number;
  endAt: number;
  priceJpy: number;
  depositJpy: number;
};

// ---------------------------------------------------------------------------------------------------------------------
// The Worker and its fakes.

const sheet: FakeSheets = createFakeSheets({ Bookings: [[...BOOKINGS_COLUMNS]] });
const google = fakeGoogleSheets(() => sheet, testVars.GOOGLE_SHEET_ID);

/** The messages the mail web app accepted, and why it refused any envelope it could not verify. */
const mails: MailMessage[] = [];
const badEnvelopes: string[] = [];
const strays: string[] = [];

async function mailApp(request: Request): Promise<Response> {
  const verified = await verifyEnvelope(testVars.MAIL_SECRET, await request.text(), Date.now());
  if (!verified.ok) {
    badEnvelopes.push(verified.reason);
    return Response.json({ ok: false, error: verified.reason, retryable: false });
  }
  mails.push(verified.payload as MailMessage);
  return Response.json({ ok: true, remainingQuota: 90 });
}

async function outbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (`${url.origin}${url.pathname}` === testVars.APPS_SCRIPT_MAIL_URL) return mailApp(request);
  if (url.hostname === "oauth2.googleapis.com" || url.hostname === "sheets.googleapis.com") return google(request);
  strays.push(`${request.method} ${request.url}`);
  await request.body?.cancel();
  return new Response(`no fake for ${request.url}`, { status: 502 });
}

const VARS = {
  GOOGLE_SA_PRIVATE_KEY: GOOGLE_PRIVATE_KEY,
  PUBLISH_SECRET: SECRET,
  SITE_URL,
  STAFF_EMAIL,
  CANCEL_LINK_SECRET: CANCEL_SECRET,
};

let worker: TestWorker;
let shop: Shop;

before(async () => {
  worker = await startWorker({ vars: VARS, outbound });
  shop = await openShop(worker.db);
});

after(async () => {
  await worker?.stop();
});

afterEach(() => {
  assert.deepEqual(strays, [], "the Worker called out to something no fake answers");
  assert.deepEqual(badEnvelopes, [], "the mail web app got envelopes it could not verify");
});

/** The published shop: 09:00 to 18:00, 30-minute slots, a 60-minute turnaround, two closed dates, both rate classes. */
async function openShop(db: D1Database): Promise<Shop> {
  for (const { type, deposit } of Object.values(KINDS)) await seedType(db, { id: type, deposit_jpy: deposit });
  await seedConfig(db, { min_lead_hours: LEAD_HOURS, max_days_ahead: HORIZON_DAYS });
  await seedCatalogMeta(db);
  await seedTiers(db);
  await seedClosedDates(db, CLOSED_DATES);
  const packages = {} as Record<PackageKey, string>;
  for (const key of PACKAGE_KEYS) packages[key] = (await seedPackage(db, LENGTHS[key])).id;
  const rateClasses = {} as Record<Kind, string>;
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const rate = await seedRateClass(db);
    rateClasses[kind] = rate.id;
    for (const key of PACKAGE_KEYS) {
      await seedPrice(db, { rate_class_id: rate.id, package_id: packages[key], price_jpy: KINDS[kind].prices[key] });
    }
  }
  return { db, packages, rateClasses };
}

let lineCount = 0;

/** A model of its own with these bikes, each named and with its base usage days, all at the same odometer. */
async function line(on: Shop, kind: Kind, bikes: [name: string, baseUsageDays: number][]): Promise<Line> {
  lineCount += 1;
  const model = await seedModel(on.db, { type_id: KINDS[kind].type, rate_class_id: on.rateClasses[kind] });
  const tag = `${kind.toUpperCase()}${lineCount}-${randomUUID().slice(0, 4)}`;
  const plates: Record<string, string> = {};
  for (const [name, base_usage_days] of bikes) {
    const vehicle = await seedVehicle(on.db, { plate: `${tag}-${name}`, model_id: model.id, base_usage_days, odometer_km: 100 });
    plates[name] = vehicle.plate;
  }
  return { kind, modelId: model.id, packages: on.packages, plates };
}

function plateOf(of: Line, name: string): string {
  const plate = of.plates[name];
  assert.ok(plate !== undefined, `fixture: no bike ${name}`);
  return plate;
}

/** A valid reservation on `of` with a new id: a one-day rental from 2030-07-15 10:00, unless `partial` says. */
function ask(of: Line, partial: Partial<Payload> = {}): Payload {
  return {
    requestedBy: REQUESTED_BY,
    id: randomUUID(),
    modelId: of.modelId,
    packageId: of.packages.day,
    date: "2030-07-15",
    time: "10:00",
    locale: "ja",
    guest: RURI,
    ...partial,
  };
}

/** The instant of a JST wall clock written "YYYY-MM-DD HH:mm". */
function jst(wall: string): number {
  const instant = Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
  assert.ok(Number.isFinite(instant), `fixture: bad wall clock ${wall}`);
  return instant;
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests.

/** The envelope the Apps Script sends: an HMAC-SHA256 in hex over `ts.payload`, with the payload as JSON text. */
function envelope(secret: string, payload: unknown, ts = Date.now(), text = JSON.stringify(payload)) {
  return { ts, payload: text, sig: createHmac("sha256", secret).update(`${ts}.${text}`).digest("hex") };
}

function post(body: string, to: TestWorker = worker, headers: Record<string, string> = JSON_HEADERS): Promise<Response> {
  return to.fetch(PATH, { method: "POST", headers, body });
}

function signed(payload: unknown): string {
  return JSON.stringify(envelope(SECRET, payload));
}

/** The JSON of a 200. */
async function answerOf(res: Response): Promise<Json> {
  const text = await res.text();
  assert.equal(res.status, 200, `${res.status}: ${text.slice(0, 300)}`);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/, text.slice(0, 300));
  return JSON.parse(text) as Json;
}

async function reserve(payload: unknown): Promise<Json> {
  return answerOf(await post(signed(payload)));
}

function booked(answer: Json, label: string): Answered {
  assert.equal(answer.ok, true, `${label}: ${JSON.stringify(answer)}`);
  const booking = answer.booking as Answered;
  assert.equal(typeof booking?.ref, "string", `${label}: ${JSON.stringify(answer)}`);
  assert.ok(booking.ref.length > 0, `${label}: an empty ref`);
  return booking;
}

/** What staff read as it stands: short words, no document, no URL, nothing secret. */
function assertPlainWords(text: string, label: string): void {
  assert.ok(text.trim().length > 0 && text.length <= 200, `${label}: expected a short message, got ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /^\s*[{[<"]/, `${label}: staff would read this as it stands: ${text}`);
  assert.doesNotMatch(text, /https?:/i, `${label}: the response carries a URL: ${text}`);
  const keyLine = GOOGLE_PRIVATE_KEY.split("\n")[1] ?? GOOGLE_PRIVATE_KEY;
  for (const secret of [SECRET, CANCEL_SECRET, testVars.MAIL_SECRET, testVars.PUBLISH_SECRET, keyLine]) {
    assert.equal(text.includes(secret), false, `${label}: the response carries a secret`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What the Worker stored and queued.

async function stored(id: string, db: D1Database = worker.db): Promise<BookingRow | null> {
  return db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
}

async function idsOn(of: Line, source = "staff"): Promise<string[]> {
  const sql = "SELECT id FROM bookings WHERE model_id = ?1 AND source = ?2 ORDER BY id";
  const { results } = await worker.db.prepare(sql).bind(of.modelId, source).all<{ id: string }>();
  return results.map(({ id }) => id);
}

type Queued = { kind: string; dedupe_key: string; payload: string };

/** The outbox items of one booking, by dedupe key. */
async function queuedFor(id: string): Promise<Queued[]> {
  const sql = "SELECT kind, dedupe_key, payload FROM outbox ORDER BY dedupe_key";
  const { results } = await worker.db.prepare(sql).all<Queued>();
  return results.filter(({ dedupe_key, payload }) => dedupe_key.includes(id) || payload.includes(id));
}

const GUEST_KEY = (id: string) => `email:guest_confirmation:${id}`;
const STAFF_KEY = (id: string) => `email:staff_new_booking:${id}`;
const SHEET_KEY = (id: string) => `sheet:${id}:CONFIRMED`;

/** What a staff booking queues: no guest confirmation for a guest with no email. */
function keysFor(id: string, guestEmail: string): string[] {
  const keys = guestEmail === "" ? [STAFF_KEY(id), SHEET_KEY(id)] : [GUEST_KEY(id), STAFF_KEY(id), SHEET_KEY(id)];
  return keys.sort();
}

function itemOf(items: Queued[], key: string): Json {
  const found = items.filter(({ dedupe_key }) => dedupe_key === key);
  assert.equal(found.length, 1, `outbox ${key}`);
  return JSON.parse((found[0] as Queued).payload) as Json;
}

/** HMAC-SHA256 over 'cancel:' + id, base64url, cut to 32 characters, as the cancel link's ticket (#35) states it. */
function cancelUrl(locale: Locale, id: string): string {
  const token = createHmac("sha256", CANCEL_SECRET).update(`cancel:${id}`).digest("base64url").slice(0, 32);
  return `${SITE_URL}/${locale}/booking/cancel?b=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
}

/**
 * Everything a request can write to D1. The outbox's delivery fields are left out, because a drain after an earlier answer
 * moves them on its own, and so is kv_cache, which holds Google's token.
 */
async function written(db: D1Database = worker.db): Promise<Record<string, unknown[]>> {
  const { results: tables } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
        "AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'kv_cache' ORDER BY name",
    )
    .all<{ name: string }>();
  const contents: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const columns = name === "outbox" ? "id, kind, dedupe_key, payload" : "*";
    contents[name] = (await db.prepare(`SELECT ${columns} FROM "${name}" ORDER BY rowid`).all()).results;
  }
  return contents;
}

async function count(db: D1Database, table: "bookings" | "outbox"): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;
}

// ---------------------------------------------------------------------------------------------------------------------
// Delivery.

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

/** The one message the mail web app accepted under `messageId`, if any. */
function mailOf(messageId: string): MailMessage | undefined {
  const found = mails.filter((mail) => mail.messageId === messageId);
  assert.ok(found.length <= 1, `${messageId} was delivered ${found.length} times`);
  return found[0];
}

async function outboxStatus(dedupeKey: string): Promise<string | null> {
  const sql = "SELECT status FROM outbox WHERE dedupe_key = ?1";
  return (await worker.db.prepare(sql).bind(dedupeKey).first<{ status: string }>())?.status ?? null;
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

function without(value: object, key: string): Json {
  const copy: Json = { ...value };
  delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------------

test("a signed reservation confirms a paid-at-shop booking and queues its emails and Bookings row", async () => {
  const cub = await line(shop, "cub", [
    ["A", 0],
    ["B", 2],
    ["C", 4],
  ]);
  const forza = await line(shop, "forza", [
    ["P", 1],
    ["Q", 0],
  ]);
  const NO_EMAIL: Guest = { ...HANAKO, email: "" };

  // Worked out by hand, in order: each pickup takes the least-used bike free for it, a day of usage per booking.
  const CASES: {
    label: string;
    of: Line;
    pkg: PackageKey;
    date: string;
    time: string;
    end: string;
    locale: Locale;
    guest: Guest;
    requestedBy: string;
    bike: string;
  }[] = [
    { label: "a day", of: cub, pkg: "day", date: "2030-07-15", time: "10:00", end: "2030-07-15 18:00", locale: "ja", guest: RURI, requestedBy: REQUESTED_BY, bike: "A" },
    { label: "4 hours while A is out", of: cub, pkg: "fourHours", date: "2030-07-15", time: "13:30", end: "2030-07-15 17:30", locale: "ko", guest: MINHO, requestedBy: REQUESTED_BY, bike: "B" },
    { label: "3 days of another model", of: forza, pkg: "three", date: "2030-07-16", time: "09:30", end: "2030-07-18 18:00", locale: "zh-cn", guest: NA, requestedBy: "second@okinawa-dream.example", bike: "Q" },
    { label: "no email, asked by nobody known", of: cub, pkg: "day", date: "2030-07-15", time: "09:00", end: "2030-07-15 18:00", locale: "en", guest: NO_EMAIL, requestedBy: "", bike: "C" },
    { label: "a day while Q is out", of: forza, pkg: "day", date: "2030-07-17", time: "11:00", end: "2030-07-17 18:00", locale: "ja", guest: HANAKO, requestedBy: REQUESTED_BY, bike: "P" },
  ];

  const made: { id: string; ref: string; plate: string; guest: Guest }[] = [];
  for (const { label, of, pkg, date, time, end, locale, guest, requestedBy, bike } of CASES) {
    const payload = ask(of, { packageId: of.packages[pkg], date, time, locale, guest, requestedBy });
    const answer = await reserve(payload);
    const { ref } = booked(answer, label);
    const plate = plateOf(of, bike);
    const startAt = jst(`${date} ${time}`);
    const priceJpy = KINDS[of.kind].prices[pkg];
    const depositJpy = KINDS[of.kind].deposit;
    assert.deepEqual(
      answer,
      {
        ok: true,
        booking: { id: payload.id, ref, modelId: of.modelId, packageId: payload.packageId, plate, startAt, endAt: jst(end), priceJpy, depositJpy },
      },
      label,
    );

    // CONFIRMED with nothing paid online: the deposit is collected at the shop.
    const row = await stored(payload.id);
    assert.ok(row !== null, `${label}: no booking stored`);
    assert.deepEqual(
      {
        ref: row.ref,
        status: row.status,
        source: row.source,
        model_id: row.model_id,
        package_id: row.package_id,
        vehicle_plate: row.vehicle_plate,
        start_at: row.start_at,
        end_at: row.end_at,
        price_jpy: row.price_jpy,
        deposit_jpy: row.deposit_jpy,
        paid_jpy: row.paid_jpy,
        payment_id: row.payment_id,
        locale: row.locale,
        guest_family_name: row.guest_family_name,
        guest_given_name: row.guest_given_name,
        guest_phone: row.guest_phone,
      },
      {
        ref,
        status: "CONFIRMED",
        source: "staff",
        model_id: of.modelId,
        package_id: payload.packageId,
        vehicle_plate: plate,
        start_at: startAt,
        end_at: jst(end),
        price_jpy: priceJpy,
        deposit_jpy: depositJpy,
        paid_jpy: 0,
        payment_id: null,
        locale,
        guest_family_name: guest.familyName,
        guest_given_name: guest.givenName,
        guest_phone: guest.phone,
      },
      label,
    );
    const email = row.guest_email ?? "";
    assert.equal(email, guest.email, `${label}: the guest's email`);

    // Queued with the booking, built from the Worker's own SITE_URL, CANCEL_LINK_SECRET and STAFF_EMAIL.
    const items = await queuedFor(payload.id);
    assert.deepEqual(items.map(({ dedupe_key }) => dedupe_key), keysFor(payload.id, guest.email), `${label}: the outbox`);
    if (guest.email !== "") {
      const confirmation = itemOf(items, GUEST_KEY(payload.id));
      assert.equal(confirmation.to, guest.email, label);
      assert.equal(confirmation.locale, locale, label);
      const data = confirmation.data as Json;
      assert.equal(data.ref, ref, label);
      assert.equal(data.paidAtShop, true, label);
      assert.equal(data.cancelUrl, cancelUrl(locale, payload.id), label);
    }
    const staffMail = itemOf(items, STAFF_KEY(payload.id));
    assert.equal(staffMail.to, STAFF_EMAIL, label);
    assert.equal((staffMail.data as Json).ref, ref, label);
    assert.equal((staffMail.data as Json).vehiclePlate, plate, label);
    assert.deepEqual(itemOf(items, SHEET_KEY(payload.id)), { bookingId: payload.id }, label);
    made.push({ id: payload.id, ref, plate, guest });
  }
  assert.equal(new Set(made.map(({ ref }) => ref)).size, made.length, "two bookings share a ref");

  // The drain after each answer delivers them, with no cron run.
  const keys = made.flatMap(({ id, guest }) => keysFor(id, guest.email));
  await until(() => delivered(keys), "the bookings' emails and Bookings rows");
  for (const { id, ref, plate, guest } of made) {
    assert.equal(mailOf(STAFF_KEY(id))?.to, STAFF_EMAIL, ref);
    assert.equal(mailOf(GUEST_KEY(id))?.to, guest.email === "" ? undefined : guest.email, ref);
    const rows = sheetRows(id);
    assert.equal(rows.length, 1, `${ref}: Bookings rows ${JSON.stringify(rows)}`);
    const [cells = {}] = rows;
    assert.equal(cells.booking_ref, ref, ref);
    assert.equal(cells.status, "CONFIRMED", ref);
    assert.equal(cells.source, "staff", ref);
    assert.equal(cells.plate, plate, ref);
    assert.ok(cells.paid_jpy === 0 || cells.paid_jpy === "0", `${ref}: paid_jpy ${JSON.stringify(cells.paid_jpy)}`);
  }
});

test("the same request again answers the same booking and makes no second one", async () => {
  const cub = await line(shop, "cub", [
    ["X", 0],
    ["Y", 1],
  ]);
  const payload = ask(cub, { guest: MINHO, locale: "ko", date: "2030-09-03", time: "11:30" });
  const body = signed(payload);
  const first = await answerOf(await post(body));
  assert.equal(booked(first, "the first request").plate, plateOf(cub, "X"));

  // The envelope stands for five minutes, and the panel may send the request again: the id makes each the same booking.
  const AGAIN: [string, () => string][] = [
    ["the same envelope again", () => body],
    ["the same request in a new envelope", () => signed(payload)],
    ["the same request from another staff member", () => signed({ ...payload, requestedBy: "second@okinawa-dream.example" })],
  ];
  for (const [label, again] of AGAIN) {
    assert.deepEqual(await answerOf(await post(again())), first, label);
  }

  // A double click sends one request twice or more at once.
  const twin = ask(cub, { guest: NA, locale: "zh-cn", date: "2030-09-03", time: "11:30" });
  const answers = await Promise.all([0, 1, 2].map(() => reserve(twin)));
  for (const answer of answers) assert.deepEqual(answer, answers[0], "the same request at once");
  assert.equal(booked(answers[0] as Json, "the twin").plate, plateOf(cub, "Y"));

  assert.deepEqual(await idsOn(cub), [payload.id, twin.id].sort(), "the bookings of the model");
  for (const [id, guest] of [
    [payload.id, MINHO],
    [twin.id, NA],
  ] as const) {
    const items = await queuedFor(id);
    assert.deepEqual(items.map(({ dedupe_key }) => dedupe_key), keysFor(id, guest.email), `the outbox of ${id}`);
  }

  // Another request under a used id books nothing and changes nothing.
  const before = await written();
  const OTHERS: [string, Partial<Payload>][] = [
    ["another guest", { guest: RURI }],
    ["another pickup time", { time: "12:00" }],
    ["another date", { date: "2030-09-04" }],
    ["another package", { packageId: cub.packages.three }],
    ["another locale", { locale: "en" }],
  ];
  for (const [label, change] of OTHERS) {
    assert.deepEqual(await reserve({ ...payload, ...change }), { ok: false, reason: "CONFLICT" }, label);
  }
  assert.deepEqual(await written(), before, "a conflicting request wrote");
});

test("the last free bike goes to one of two reservations and the other is SOLD_OUT", async () => {
  const solo = await line(shop, "forza", [["S", 0]]);
  const pair = await line(shop, "cub", [
    ["T", 0],
    ["U", 3],
  ]);
  // T is out on a web booking over both pickups below, so U is the last bike of its model then.
  await seedBooking(worker.db, {
    vehicle_plate: plateOf(pair, "T"),
    model_id: pair.modelId,
    start_at: jst("2030-10-01 09:00"),
    end_at: jst("2030-10-02 18:00"),
  });

  // The loser's own request on a later day books the bike usage now favours: T has 2 days, U its base 3 and the winner's 1.
  const ROUNDS: { label: string; of: Line; requests: Payload[]; bike: string; laterBike: string }[] = [
    {
      label: "one bike, the same pickup",
      of: solo,
      requests: [
        ask(solo, { date: "2030-10-01", time: "10:00", guest: RURI }),
        ask(solo, { date: "2030-10-01", time: "10:00", guest: MINHO, locale: "ko" }),
      ],
      bike: "S",
      laterBike: "S",
    },
    {
      label: "the other bike booked on the web, overlapping pickups",
      of: pair,
      requests: [
        ask(pair, { date: "2030-10-01", time: "13:30", packageId: pair.packages.fourHours, guest: NA, locale: "zh-cn" }),
        ask(pair, { date: "2030-10-01", time: "09:00", guest: HANAKO, locale: "en" }),
      ],
      bike: "U",
      laterBike: "T",
    },
  ];

  for (const { label, of, requests, bike, laterBike } of ROUNDS) {
    const answers = await Promise.all(requests.map((request) => reserve(request)));
    const winners = answers.flatMap((answer, index) => (answer.ok === true ? [index] : []));
    assert.equal(winners.length, 1, `${label}: ${JSON.stringify(answers)}`);
    const won = winners[0] as number;
    const lost = 1 - won;
    const winner = requests[won] as Payload;
    const loser = requests[lost] as Payload;

    const booking = booked(answers[won] as Json, label);
    assert.equal(booking.id, winner.id, label);
    assert.equal(booking.plate, plateOf(of, bike), label);
    assert.equal(booking.startAt, jst(`${winner.date} ${winner.time}`), label);
    assert.deepEqual(answers[lost], { ok: false, reason: "SOLD_OUT" }, label);

    assert.equal(await stored(loser.id), null, `${label}: the loser has a booking`);
    assert.deepEqual(await queuedFor(loser.id), [], `${label}: the loser queued`);
    assert.deepEqual(await idsOn(of), [winner.id], `${label}: the bookings of the model`);

    // A third request for that time finds the bike gone too, and the loser's id is still free to book another day.
    const third = await reserve(ask(of, { date: winner.date, time: winner.time, packageId: winner.packageId, guest: RURI }));
    assert.deepEqual(third, { ok: false, reason: "SOLD_OUT" }, `${label}: a third request`);
    const later = booked(await reserve({ ...loser, date: "2030-10-10" }), `${label}: the loser's request on a later day`);
    assert.equal(later.id, loser.id, label);
    assert.equal(later.plate, plateOf(of, laterBike), `${label}: the later booking's bike`);
    assert.deepEqual(await idsOn(of), [winner.id, loser.id].sort(), `${label}: the bookings of the model after`);
  }
});

test("a pickup outside the rules answers its reason and writes nothing", async () => {
  const cub = await line(shop, "cub", [
    ["R", 0],
    ["W", 1],
  ]);
  const { three, fourHours } = cub.packages;
  // From 2030-08-12 10:00 for a day unless the row says. 2030-08-20 and 2030-08-27 are closed.
  const TABLE: [string, Partial<Payload>, string][] = [
    ["before opening", { time: "08:30" }, "OUTSIDE_HOURS"],
    ["at closing", { time: "18:00" }, "OUTSIDE_HOURS"],
    ["between slots", { time: "10:15" }, "OFF_SLOT"],
    ["a date that does not exist", { date: "2030-02-30" }, "OFF_SLOT"],
    ["a time that does not exist", { time: "24:30" }, "OFF_SLOT"],
    ["closed on the pickup date", { date: "2030-08-20" }, "CLOSED_PICKUP"],
    ["closed on the return date", { date: "2030-08-25", packageId: three }, "CLOSED_RETURN"],
    ["4 hours back past closing", { time: "14:30", packageId: fourHours }, "RETURN_OUTSIDE_HOURS"],
    ["a day gone by", { date: "2020-08-12" }, "TOO_SOON"],
    ["past the horizon", { date: "2045-08-12" }, "TOO_FAR"],
    ["a model the catalog does not have", { modelId: "no-such-model" }, "UNKNOWN_MODEL"],
    ["a package the catalog does not have", { packageId: "no-such-package" }, "UNKNOWN_PACKAGE"],
  ];
  const before = await written();
  for (const [label, partial, reason] of TABLE) {
    const answer = await reserve(ask(cub, { date: "2030-08-12", time: "10:00", ...partial }));
    assert.deepEqual(answer, { ok: false, reason }, label);
  }
  assert.deepEqual(await written(), before, "a refused pickup wrote");

  // The same model books pickups inside the rules: back at closing, and a day over neither closed date.
  booked(await reserve(ask(cub, { date: "2030-08-12", time: "14:00", packageId: fourHours })), "4 hours back at closing");
  booked(await reserve(ask(cub, { date: "2030-08-17", time: "09:00", packageId: three })), "3 days to 2030-08-19");
  assert.equal((await idsOn(cub)).length, 2);
});

test("bad guest details answer INVALID_GUEST with the fields", async () => {
  // One bike: a refused request that took it would leave the good one below SOLD_OUT.
  const solo = await line(shop, "forza", [["G", 0]]);
  const BAD_GUESTS: [string, Partial<Guest>, string[]][] = [
    ["no family name", { familyName: "" }, ["FAMILY_NAME_EMPTY"]],
    ["a given name of spaces", { givenName: "   " }, ["GIVEN_NAME_EMPTY"]],
    ["an email with no domain", { email: "ruri" }, ["EMAIL_MALFORMED"]],
    ["an email with an empty label", { email: "ruri@example..jp" }, ["EMAIL_MALFORMED"]],
    ["a padded email", { email: " ruri.u@example.jp" }, ["EMAIL_MALFORMED"]],
    ["markup in the email", { email: "<b>@example.jp" }, ["EMAIL_MALFORMED"]],
    ["no phone", { phone: "" }, ["PHONE_NO_DIGITS"]],
    ["a phone with no digits", { phone: "+- ()" }, ["PHONE_NO_DIGITS"]],
    ["several at once", { familyName: " ", email: "x@y", phone: "" }, ["FAMILY_NAME_EMPTY", "EMAIL_MALFORMED", "PHONE_NO_DIGITS"]],
    [
      "every field",
      { familyName: "", givenName: "\t", email: "@", phone: "-" },
      ["FAMILY_NAME_EMPTY", "GIVEN_NAME_EMPTY", "EMAIL_MALFORMED", "PHONE_NO_DIGITS"],
    ],
  ];
  const GUESTS = [RURI, MINHO, NA, HANAKO];
  const before = await written();
  const ids: string[] = [];
  for (const [n, [label, change, codes]] of BAD_GUESTS.entries()) {
    const guest = { ...(GUESTS[n % GUESTS.length] as Guest), ...change };
    const payload = ask(solo, { guest });
    ids.push(payload.id);
    const answer = await reserve(payload);
    assert.ok(Array.isArray(answer.fields), `${label}: ${JSON.stringify(answer)}`);
    const fields = [...(answer.fields as string[])].sort();
    assert.deepEqual({ ...answer, fields }, { ok: false, reason: "INVALID_GUEST", fields: [...codes].sort() }, label);
  }
  assert.deepEqual(await written(), before, "a refused guest wrote");

  // The first id with the guest put right books the bike nothing took.
  const fixed = booked(await reserve(ask(solo, { id: ids[0] as string })), "the guest put right");
  assert.equal(fixed.plate, plateOf(solo, "G"));
});

test("unsigned, tampered and stale requests get 401 and write nothing", async () => {
  const solo = await line(shop, "cub", [["K", 0]]);
  const payload = ask(solo, { date: "2030-11-05", guest: NA, locale: "zh-cn" });
  const good = () => envelope(SECRET, payload);
  const flipped = (sig: string) => `${sig[0] === "0" ? "1" : "0"}${sig.slice(1)}`;
  const dropped = (field: "ts" | "payload" | "sig") => JSON.stringify(without(good(), field));
  const forged = JSON.stringify({ ...payload, id: randomUUID(), guest: MINHO, locale: "ko" });

  const REFUSED: [string, () => string][] = [
    ["no body", () => ""],
    ["not JSON", () => "{not json"],
    ["JSON null", () => "null"],
    ["a JSON array", () => "[]"],
    ["the payload with no envelope", () => JSON.stringify(payload)],
    ["no sig", () => dropped("sig")],
    ["no ts", () => dropped("ts")],
    ["no payload", () => dropped("payload")],
    ["an empty sig", () => JSON.stringify({ ...good(), sig: "" })],
    ["ts as text", () => JSON.stringify({ ...good(), ts: String(Date.now()) })],
    ["the payload as an object", () => JSON.stringify({ ...good(), payload })],
    ["signed with another secret", () => JSON.stringify(envelope("another-secret", payload))],
    ["signed with the mail secret", () => JSON.stringify(envelope(testVars.MAIL_SECRET, payload))],
    ["signed with the cancel-link secret", () => JSON.stringify(envelope(CANCEL_SECRET, payload))],
    ["the payload changed after signing", () => JSON.stringify({ ...good(), payload: forged })],
    ["ts changed after signing", () => JSON.stringify({ ...good(), ts: Date.now() + 1000 })],
    ["one sig character changed", () => JSON.stringify({ ...good(), sig: flipped(good().sig) })],
    ["a cut-off sig", () => JSON.stringify({ ...good(), sig: good().sig.slice(0, 32) })],
    ["stale by six minutes", () => JSON.stringify(envelope(SECRET, payload, Date.now() - 6 * MINUTE_MS))],
    ["stale by a day", () => JSON.stringify(envelope(SECRET, payload, Date.now() - DAY_MS))],
    ["six minutes in the future", () => JSON.stringify(envelope(SECRET, payload, Date.now() + 6 * MINUTE_MS))],
  ];

  const before = await written();
  for (const [label, body] of REFUSED) {
    const res = await post(body());
    const text = await res.text();
    assert.equal(res.status, 401, `${label}: ${text.slice(0, 300)}`);
    assert.deepEqual(JSON.parse(text), { error: "unauthorized" }, label);
  }
  assert.deepEqual(await written(), before, "a refused request wrote");

  // The same request signed with PUBLISH_SECRET books, so what turned those down was the signature check.
  const booking = booked(await reserve(payload), "the signed request");
  assert.equal(booking.plate, plateOf(solo, "K"));
  assert.deepEqual(await idsOn(solo), [payload.id]);
});

test("a body over 64 KB gets 413 and an empty PUBLISH_SECRET gets 500", async () => {
  const pair = await line(shop, "forza", [
    ["M", 0],
    ["N", 1],
  ]);

  /** A good envelope of exactly `bytes`, the signed payload text padded with spaces, which JSON.parse passes over. */
  const sized = (payload: Payload, bytes: number): string => {
    const ts = Date.now();
    const text = JSON.stringify(payload);
    const body = (padding: number) => JSON.stringify(envelope(SECRET, payload, ts, text + " ".repeat(padding)));
    const exact = body(bytes - Buffer.byteLength(body(0)));
    assert.equal(Buffer.byteLength(exact), bytes);
    return exact;
  };
  const SENDS: [string, (body: string) => Promise<Response>][] = [
    ["as a string", (body) => post(body)],
    ["with a Content-Length", (body) => post(body, worker, { ...JSON_HEADERS, "Content-Length": String(Buffer.byteLength(body)) })],
  ];
  const at = { date: "2030-12-02", time: "10:00" };

  // A Worker with no secret refuses everyone, even a body signed with the key anyone can compute for it. Small bodies come
  // first, as a route that never reads a 65 KB body can have its connection reset before any status shows.
  const SECRETS: [string, string | undefined][] = [
    ["empty", ""],
    ["unset", undefined],
  ];
  for (const [name, secret] of SECRETS) {
    const requests: string[] = [];
    const lonely = await startWorker({
      vars: { ...VARS, PUBLISH_SECRET: secret },
      outbound: async (request) => {
        requests.push(`${request.method} ${request.url}`);
        await request.body?.cancel();
        return new Response("nothing is reachable from this Worker", { status: 502 });
      },
    });
    try {
      // A shop with a free bike, so a request let through would book it.
      const free = await line(await openShop(lonely.db), "cub", [["L", 0]]);
      for (const key of ["", "undefined"]) {
        const label = `${name}, signed with ${JSON.stringify(key)}`;
        const res = await post(JSON.stringify(envelope(key, ask(free, at))), lonely);
        const text = await res.text();
        assert.equal(res.status, 500, `${label}: ${text.slice(0, 300)}`);
        assertPlainWords(text, label);
        assert.doesNotMatch(text, /DataError|HMAC|importKey|key length/i, label);
      }
      assert.equal(await count(lonely.db, "bookings"), 0, `${name}: a booking was made`);
      assert.equal(await count(lonely.db, "outbox"), 0, `${name}: something was queued`);
      assert.deepEqual(requests, [], `${name}: the Worker called out`);
    } finally {
      await lonely.stop();
    }
  }

  // 64,000 bytes is within the limit on either reading, and books.
  for (const [how, send] of SENDS) {
    booked(await answerOf(await send(sized(ask(pair, at), 64_000))), `64,000 bytes ${how}`);
  }
  assert.equal((await idsOn(pair)).length, 2);

  // Signed, so only the limit can refuse them, and one byte over 64 KiB, the larger reading of 64 KB.
  const before = await written();
  const BODIES: [string, () => string][] = [
    ["a signed reservation one byte past 64 KiB", () => sized(ask(pair, at), 65_537)],
    ["a signed reservation of 100,000 bytes", () => sized(ask(pair, at), 100_000)],
    ["junk", () => "x".repeat(70_000)],
  ];
  for (const [name, body] of BODIES) {
    for (const [how, send] of SENDS) {
      const label = `${name} ${how}`;
      const res = await send(body());
      const text = await res.text();
      assert.equal(res.status, 413, `${label}: ${text.slice(0, 300)}`);
      assertPlainWords(text, label);
    }
  }
  assert.deepEqual(await written(), before, "an oversized request wrote");
});

test("a payload of the wrong shape answers 400 and writes nothing", async () => {
  const solo = await line(shop, "cub", [["H", 0]]);
  const base = ask(solo, { date: "2031-01-14", time: "11:00" });
  const SHAPES: [string, unknown][] = [
    ["a number", 42],
    ["a string", "reserve"],
    ["null", null],
    ["a list", [base]],
    ["an empty object", {}],
    ["no id", without(base, "id")],
    ["an empty id", { ...base, id: "" }],
    ["an id past 200 characters", { ...base, id: "x".repeat(201) }],
    ["a number for an id", { ...base, id: 7 }],
    ["null for an id", { ...base, id: null }],
    ["no modelId", without(base, "modelId")],
    ["a number for a modelId", { ...base, modelId: 125 }],
    ["no packageId", without(base, "packageId")],
    ["an object for a packageId", { ...base, packageId: { id: base.packageId } }],
    ["no date", without(base, "date")],
    ["a number for a date", { ...base, date: 20310114 }],
    ["no time", without(base, "time")],
    ["a number for a time", { ...base, time: 1100 }],
    ["no requestedBy", without(base, "requestedBy")],
    ["a number for requestedBy", { ...base, requestedBy: 1 }],
    ["no locale", without(base, "locale")],
    ["a locale the site does not have", { ...base, locale: "fr" }],
    ["a locale in the wrong case", { ...base, locale: "ZH-CN" }],
    ["a list for a locale", { ...base, locale: ["ja"] }],
    ["a name every object inherits", { ...base, locale: "__proto__" }],
    ["no guest", without(base, "guest")],
    ["null for a guest", { ...base, guest: null }],
    ["a string for a guest", { ...base, guest: "鵜久森 瑠璃香" }],
    ["a list for a guest", { ...base, guest: [RURI] }],
    ["a guest with no phone", { ...base, guest: without(RURI, "phone") }],
    ["a number for a phone", { ...base, guest: { ...RURI, phone: 9086863535 } }],
    ["null for an email", { ...base, guest: { ...RURI, email: null } }],
    ["an object for a family name", { ...base, guest: { ...RURI, familyName: { ja: "鵜久森" } } }],
  ];

  const before = await written();
  for (const [label, payload] of SHAPES) {
    const res = await post(signed(payload));
    const text = await res.text();
    assert.equal(res.status, 400, `${label}: ${text.slice(0, 300)}`);
    assertPlainWords(text, label);
  }
  assert.deepEqual(await written(), before, "a payload of the wrong shape wrote");

  // The payload they were made from books, so what turned them down was the shape.
  assert.equal(booked(await reserve(base), "the whole payload").plate, plateOf(solo, "H"));
});
