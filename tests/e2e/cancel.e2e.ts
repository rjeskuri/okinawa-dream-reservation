// The cancel page, through the built Worker, with Square faked in `outbound` at the sandbox URL, so the real client runs
// and no seam is needed. The Worker reads the real clock, so a pickup is a whole number of days from now, and a run that
// crosses midnight JST starts again. Tokens are signed here with node:crypto. The booking and the token come from the
// link's URL alone: the form has no action and no fields, so it posts back to the link, and the body is never read. A POST
// sends what the page's own form sends, and tampering changes the value wherever it sits, or in one place at a time to set
// two places against each other. A booking that cannot be cancelled answers as no booking at all, and so does a bad token
// in every state. Quotes are looked for by their numbers, and the pickup by its JST month, day, hour and minute, so the
// wording and the date format stay free. Every test ends on a request that must work, because a 404 or an unchanged
// database proves nothing about a route that does not exist.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { mainOf, tagsIn, visibleText, withoutCode, type Tag } from "../helpers/html.ts";
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

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const SECRET = "e2e-cancel-link-secret";
const STAFF_EMAIL = "e2e-staff@example.com";
const ACCESS_TOKEN = "e2e-square-access-token";
const REFUNDS_URL = "https://connect.squareupsandbox.com/v2/refunds";
/** The origin `worker.fetch` requests, which a browser's same-origin POST would name. */
const ORIGIN = "http://localhost";

const TIERS: TierRow[] = [
  { min_days_before: 14, refund_percent: 80 },
  { min_days_before: 5, refund_percent: 40 },
  { min_days_before: 2, refund_percent: 15 },
  { min_days_before: 0, refund_percent: 0 },
];
const FULL_REFUND: TierRow[] = [{ min_days_before: 0, refund_percent: 100 }];

const RECEIPT = ["guest_cancellation", "sheet_booking", "staff_cancellation"];

type RefundBody = {
  idempotency_key: string;
  payment_id: string;
  amount_money: { amount: number; currency: string };
};

type RefundCall = { authorization: string | null; key: string; paymentId: string; amount: number; currency: string };

type RefundRow = {
  booking_id: string;
  square_refund_id: string | null;
  amount_jpy: number;
  status: string;
  origin: string;
  idempotency_key: string | null;
};

/** What a browser would send for a form: the URL it posts to and the fields in order. */
type Submission = { url: URL; fields: [string, string][] };

let worker: TestWorker;
let modelId = "";
let packageId = "";

const refundCalls: RefundCall[] = [];
const strayRequests: string[] = [];

function refundAs(status: string): (body: RefundBody) => Response {
  return ({ idempotency_key, amount_money, payment_id }) =>
    Response.json({
      refund: { id: `square-${idempotency_key}`, status, amount_money, payment_id, created_at: new Date().toISOString() },
    });
}

let answerRefund = refundAs("PENDING");

async function fakeSquare(request: Request): Promise<Response> {
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

before(async () => {
  // Not the values of testVars, so a secret or an address written into the source shows.
  const vars = { CANCEL_LINK_SECRET: SECRET, STAFF_EMAIL, SQUARE_ACCESS_TOKEN: ACCESS_TOKEN };
  worker = await startWorker({ vars, outbound: fakeSquare });
  await seedConfig(worker.db);
  await seedCatalogMeta(worker.db);
  // Names with a digit, the same in every locale, so a page that shows them still counts as written in its locale.
  const texts = (fields: Record<string, string>) => JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, fields])));
  const model = await seedModel(worker.db, {
    brand: "Y",
    texts: texts({ name: "V9", summary: "A summary", description: "A description" }),
  });
  const pkg = await seedPackage(worker.db, { texts: texts({ name: "D1" }) });
  await seedPrice(worker.db, { rate_class_id: model.rate_class_id, package_id: pkg.id });
  modelId = model.id;
  packageId = pkg.id;
});

after(async () => {
  await worker?.stop();
});

beforeEach(() => {
  refundCalls.length = 0;
  strayRequests.length = 0;
  answerRefund = refundAs("PENDING");
});

afterEach(() => {
  assert.deepEqual(strayRequests, [], "the Worker called out to something other than the refund endpoint");
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

function sign(secret: string, id: string): string {
  return createHmac("sha256", secret).update(`cancel:${id}`, "utf8").digest("base64url").slice(0, 32);
}

const tokenOf = (id: string): string => sign(SECRET, id);

let lastBooking = 0;

/** A CONFIRMED web booking `days` whole days from now, whose paid, deposit and price all differ. */
function confirmed(days: number, paid: number, change: Partial<BookingRow> = {}): Promise<BookingRow> {
  lastBooking += 1;
  const start_at = Date.now() + days * DAY_MS;
  return seedBooking(worker.db, {
    id: randomUUID(),
    model_id: modelId,
    package_id: packageId,
    start_at,
    end_at: start_at + 8 * HOUR_MS,
    paid_jpy: paid,
    deposit_jpy: paid + 1000,
    price_jpy: paid + 20_000,
    payment_id: `square-payment-${lastBooking}`,
    guest_family_name: `Higa${lastBooking}`,
    guest_given_name: `Naomi${lastBooking}`,
    guest_email: `guest-${lastBooking}@example.com`,
    ...change,
  });
}

function linkTo(locale: string, id: string, token: string): string {
  return `/${locale}/booking/cancel?b=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
}

function getPage(path: string, method = "GET"): Promise<Response> {
  return worker.fetch(path, { method, redirect: "manual" });
}

/** The status of `res`, with its body read, so nothing stays open. */
async function statusOf(res: Response): Promise<number> {
  await res.text();
  return res.status;
}

/** Everything a request can change. Delivery fields of the outbox are left out, because a drain moves them on its own. */
async function stored(): Promise<unknown[]> {
  const rows = async (sql: string) => (await worker.db.prepare(sql).all()).results;
  return [
    await rows("SELECT * FROM bookings ORDER BY id"),
    await rows("SELECT * FROM refunds ORDER BY id"),
    await rows("SELECT kind, dedupe_key, payload FROM outbox ORDER BY dedupe_key"),
  ];
}

async function bookingNow(id: string): Promise<BookingRow> {
  const row = await worker.db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  if (row === null) throw new Error(`no booking ${id}`);
  return row;
}

async function refundsOf(id: string): Promise<RefundRow[]> {
  return (await worker.db.prepare("SELECT * FROM refunds WHERE booking_id = ?1").bind(id).all<RefundRow>()).results;
}

/** The queue for one booking: template or kind, address and locale, sorted by name. */
async function queuedFor(booking: BookingRow): Promise<{ name: string; to?: string; locale?: string }[]> {
  const { results } = await worker.db.prepare("SELECT kind, payload FROM outbox").all<{ kind: string; payload: string }>();
  return results
    .filter(({ payload }) => payload.includes(booking.id) || payload.includes(booking.ref))
    .map(({ kind, payload }) => {
      if (kind !== "email") return { name: kind };
      const { template, to, locale } = JSON.parse(payload) as { template: string; to: string; locale: string };
      return { name: template, to, locale };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mainText(html: string, label: string): string {
  return visibleText(mainOf(html, label));
}

function postForms(html: string): string[] {
  const forms = [...withoutCode(html).matchAll(/<form\b[\s\S]*?<\/form\s*>/gi)].map(([form]) => form);
  return forms.filter((form) => tagsIn(form)[0]?.attributes.method?.toLowerCase() === "post");
}

/** What a browser sends for `form` when its first submit control is pressed, which may be unnamed or name its own action. */
function submissionOf(form: string, page: URL): Submission {
  const tags = tagsIn(form);
  const controls = tags.filter(({ name, attributes }) => (name === "input" || name === "button") && !("disabled" in attributes));
  const typeOf = ({ name, attributes }: Tag) => (attributes.type ?? (name === "button" ? "submit" : "text")).toLowerCase();
  const pressed = controls.find((tag) => typeOf(tag) === "submit");
  const sent = controls.filter((tag) => tag === pressed || !["submit", "button", "reset", "image"].includes(typeOf(tag)));
  const named = sent.filter(({ attributes }) => attributes.name !== undefined);
  const fields = named.map(({ attributes }): [string, string] => [attributes.name as string, attributes.value ?? ""]);
  return { url: new URL(pressed?.attributes.formaction ?? tags[0]?.attributes.action ?? "", page), fields };
}

function carries({ url, fields }: Submission, value: string): boolean {
  return [...url.searchParams, ...fields].some(([, held]) => held === value);
}

/** `form` with every value of its URL and its fields through `change`. A null drops the value. */
function changed({ url, fields }: Submission, change: (value: string) => string | null): Submission {
  const mapped = (pairs: [string, string][]): [string, string][] =>
    pairs.flatMap(([name, value]): [string, string][] => {
      const next = change(value);
      return next === null ? [] : [[name, next]];
    });
  const moved = new URL(url);
  moved.search = new URLSearchParams(mapped([...url.searchParams])).toString();
  return { url: moved, fields: mapped(fields) };
}

/** How many of `form`'s URL values and fields hold `value`. */
function placesOf({ url, fields }: Submission, value: string): number {
  return [...url.searchParams, ...fields].filter(([, held]) => held === value).length;
}

/** `form` with `to` in the `nth` place that holds `from`, counting the URL first, and every other place as it was. */
function swappedAt({ url, fields }: Submission, nth: number, from: string, to: string): Submission {
  let seen = -1;
  const swap = ([name, value]: [string, string]): [string, string] => {
    if (value !== from) return [name, value];
    seen += 1;
    return [name, seen === nth ? to : value];
  };
  const moved = new URL(url);
  moved.search = new URLSearchParams([...url.searchParams].map(swap)).toString();
  return { url: moved, fields: fields.map(swap) };
}

function send({ url, fields }: Submission, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(`${url.pathname}${url.search}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The page's form for a booking it quotes, after checking the form names the booking, so tampering has a target. */
async function cancelForm(locale: Locale, booking: BookingRow): Promise<Submission> {
  const path = linkTo(locale, booking.id, tokenOf(booking.id));
  const res = await getPage(path);
  const html = await res.text();
  assert.equal(res.status, 200, path);
  const forms = postForms(html);
  assert.equal(forms.length, 1, `${path}: POST forms`);
  const link = new URL(path, ORIGIN);
  const form = submissionOf(forms[0] as string, link);
  assert.ok(carries(form, booking.id), `${path}: the form does not name the booking`);
  assert.ok(carries(form, tokenOf(booking.id)), `${path}: the form carries no token`);
  // b and t come from the URL alone. With no action the form posts back to the link itself; an action that comes to the
  // same path with the same b and t sends the same request. It sends no fields, so there is no body for a page to read.
  assert.equal(form.url.pathname, link.pathname, `${path}: the form posts to another path`);
  assert.deepEqual(paramsOf(form.url), paramsOf(link), `${path}: the form posts to another query`);
  assert.deepEqual(form.fields, [], `${path}: the form sends fields`);
  return form;
}

/** The query of `url` as sorted pairs, so the order b and t come in does not count. */
function paramsOf(url: URL): [string, string][] {
  return [...url.searchParams].sort(([a], [b]) => a.localeCompare(b));
}

/** The form a browser holds for `target`, which the page itself offers none for, made from a live booking's. */
async function formFor(locale: Locale, target: Pick<BookingRow, "id">): Promise<Submission> {
  const live = await confirmed(10, 1000);
  const liveToken = tokenOf(live.id);
  return changed(await cancelForm(locale, live), (value) => {
    if (value === live.id) return target.id;
    return value === liveToken ? tokenOf(target.id) : value;
  });
}

/** `value` as a page may write it, with or without thousands separators, and never as part of a longer number. */
function figure(value: number): RegExp {
  const digits = String(value).replace(/\B(?=(\d{3})+$)/g, ",?");
  return new RegExp(`(?<![\\d.,])${digits}(?![\\d,])`);
}

function percent(value: number): RegExp {
  return new RegExp(`(?<![\\d.,])${value}\\s*%`);
}

/** `value` as written, never as part of a longer word or ref, so REF-1 does not count inside REF-12. */
function standalone(value: string): RegExp {
  return new RegExp(`(?<![\\w-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
}

/** The JST wall clock of `at`, worked out here by adding the offset: JST has no clock changes. */
function jstClock(at: number): { month: number; day: number; hour: number; minute: number } {
  const wall = new Date(at + 9 * HOUR_MS);
  return { month: wall.getUTCMonth() + 1, day: wall.getUTCDate(), hour: wall.getUTCHours(), minute: wall.getUTCMinutes() };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The JST date of `at` as a page may write it: month and day as numbers side by side in either order, as in 2026-11-23,
 * 11/23, 23.11, 11月23日 or 11월 23일, or the month by its English name. The year, the weekday and the order are free.
 */
function pickupDate(at: number): RegExp {
  const { month, day } = jstClock(at);
  const [m, d, name] = [`0?${month}`, `0?${day}`, `${MONTH_NAMES[month - 1]}[a-z]*\\.?`];
  const ways = [
    `(?<!\\d)${m}\\D{1,3}${d}(?!\\d)`,
    `(?<!\\d)${d}\\D{1,3}${m}(?!\\d)`,
    `\\b${name}\\s*${d}(?!\\d)`,
    `(?<!\\d)${d}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${name}`,
  ];
  return new RegExp(ways.join("|"), "i");
}

/** The JST time of `at` as a clock, 24-hour or 12-hour, as in 07:05, 9:48 PM, 21時48分, 21点48分 or 오후 9시 48분. */
function pickupTime(at: number): RegExp {
  const { hour, minute } = jstClock(at);
  return new RegExp(`(?<!\\d)(?:0?${hour}|0?${hour % 12 || 12})\\s*(?::|時|时|시|点|點)\\s*0?${minute}(?!\\d)`);
}

/** A pickup `days` JST dates from now at the JST clock `time`, so its day count is `days` and its time is not the run's. */
function pickupAt(days: number, time: string): number {
  return Date.parse(`${jstDate(Date.now() + days * DAY_MS)}T${time}:00+09:00`);
}

const HTML_LANG: Record<Locale, string> = { ja: "ja", en: "en", "zh-cn": "zh-CN", ko: "ko" };

/** Text that can only be this locale's, so one locale's sentences cannot stand in for another's. */
const script: Record<Locale, { must: RegExp; mustNot: RegExp }> = {
  ja: { must: /\p{Script=Hiragana}|\p{Script=Katakana}/u, mustNot: /\p{Script=Hangul}/u },
  en: { must: /[A-Za-z]{3}/, mustNot: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  "zh-cn": { must: /\p{Script=Han}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  ko: { must: /\p{Script=Hangul}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}/u },
};

/** Two English words side by side, which no page off English has of its own. */
const ENGLISH_WORDS = /[A-Za-z]{3,}\s+[A-Za-z]{3,}/;

/**
 * The page's own words: not the shop's name, which is Latin in every locale, and no token with a digit or an @, which is a
 * ref, a guest's name or address, a date or a sum. These fixtures keep those Latin, and side by side they read as English.
 */
function ownWords(text: string): string {
  const words = text.replaceAll("Okinawa Dream", " ").split(/\s+/);
  return words.filter((word) => !/[\d@]/.test(word)).join(" ");
}

/** `text` is written in `locale`, so a sentence left in English, or in another locale, shows. */
function assertInLocale(text: string, locale: Locale, label: string): void {
  assert.match(text, script[locale].must, `${label}: no text in the locale's script`);
  assert.doesNotMatch(text, script[locale].mustNot, `${label}: text from another locale`);
  if (locale !== "en") assert.doesNotMatch(ownWords(text), ENGLISH_WORDS, `${label}: English in\n${text}`);
}

/** How each language says "already cancelled". Tight, so "already started, so it cannot be cancelled" does not count. */
const alreadyCancelled: Record<Locale, RegExp> = {
  ja: /(?:既に|すでに)キャンセル|キャンセル済/,
  en: /\balready\s+(?:been\s+)?cancell?ed\b/i,
  "zh-cn": /已(?:经|被)?取消/,
  ko: /이미\s*취소/,
};

async function assertAlreadyCancelled(res: Response, locale: Locale, label: string): Promise<string> {
  const html = await res.text();
  assert.equal(res.status, 200, label);
  const text = mainText(html, label);
  assert.match(text, alreadyCancelled[locale], `${label}: not shown as already cancelled in\n${text}`);
  assertInLocale(text, locale, label);
  assert.deepEqual(postForms(html), [], `${label}: a form to cancel a cancelled booking`);
  return text;
}

/** The page of a booking past its pickup: it says so in the locale's words, and offers nothing to press. */
async function assertStartedPage(res: Response, locale: Locale, label: string): Promise<void> {
  const html = await res.text();
  assert.equal(res.status, 200, label);
  const text = mainText(html, label);
  assertInLocale(text, locale, label);
  assert.doesNotMatch(text, alreadyCancelled[locale], `${label}: shown as cancelled`);
  assert.deepEqual(postForms(html), [], `${label}: a form to cancel`);
}

async function movePickup(id: string, startAt: number): Promise<void> {
  await worker.db
    .prepare("UPDATE bookings SET start_at = ?1, end_at = ?2 WHERE id = ?3")
    .bind(startAt, startAt + 8 * HOUR_MS, id)
    .run();
}

// [days to pickup, paid, percent, refund] under TIERS, each refund worked out by hand. Day counts stay inside their tier
// if the run crosses midnight, so only the shown count can move, and `steady` covers that.
const QUOTES: [number, number, number, number][] = [
  [20, 7001, 80, 5600],
  [10, 7001, 40, 2800],
  [9, 5000, 40, 2000],
  [3, 1001, 15, 150],
  [1, 9000, 0, 0],
];

// [days to pickup, JST clock]. One morning before 09:00 JST, and one evening, where a 12-hour clock reads differently.
const PICKUP_CLOCKS: [number, string][] = [
  [10, "07:05"],
  [12, "21:48"],
];

test("GET shows the quote and changes nothing", async () => {
  await setTiers(TIERS);
  await steady(async () => {
    for (const locale of LOCALES) {
      for (const [days, paid, refundPercent, refund] of QUOTES) {
        const label = `${locale}, ${days} days, ${paid} paid`;
        const booking = await confirmed(days, paid);
        const path = linkTo(locale, booking.id, tokenOf(booking.id));
        const before = await stored();

        const res = await getPage(path);
        const html = await res.text();
        assert.equal(res.status, 200, label);
        assert.match(res.headers.get("content-type") ?? "", /text\/html/, label);
        assert.equal(tagsIn(html).find(({ name }) => name === "html")?.attributes.lang, HTML_LANG[locale], label);

        const text = mainText(html, label);
        assert.match(text, figure(days), `${label}: days before pickup in\n${text}`);
        assert.match(text, percent(refundPercent), `${label}: percent in\n${text}`);
        assert.match(text, figure(refund), `${label}: refund in\n${text}`);
        assert.match(text, standalone(booking.ref), `${label}: the booking ref in\n${text}`);
        assert.match(text, pickupDate(booking.start_at), `${label}: the pickup date in\n${text}`);
        assert.match(text, pickupTime(booking.start_at), `${label}: the pickup time in\n${text}`);
        assertInLocale(text, locale, label);
        assert.equal(postForms(html).length, 1, `${label}: POST forms`);

        // A prefetching scanner may GET the link repeatedly, or ask with HEAD or OPTIONS, which reach the same page code.
        for (const method of ["GET", "GET", "HEAD", "OPTIONS"]) await statusOf(await getPage(path, method));

        assert.deepEqual(await stored(), before, `${label}: reading the page changed something`);
        assert.deepEqual(refundCalls, [], `${label}: reading the page called Square`);
      }
    }
  });

  // The quotes above pick up at the time of day the run started. These pick up at a set time, so the page shows the
  // booking's own clock and not the run's, and one is before 09:00 JST, when the UTC date is still the day before.
  for (const locale of LOCALES) {
    for (const [days, time] of PICKUP_CLOCKS) {
      const label = `${locale}, pickup at ${time} JST in ${days} days`;
      const start_at = pickupAt(days, time);
      const booking = await confirmed(days, 9000, { start_at, end_at: start_at + 8 * HOUR_MS });

      const res = await getPage(linkTo(locale, booking.id, tokenOf(booking.id)));
      const html = await res.text();
      assert.equal(res.status, 200, label);
      const text = mainText(html, label);
      assert.match(text, standalone(booking.ref), `${label}: the booking ref in\n${text}`);
      assert.match(text, pickupDate(start_at), `${label}: the pickup date in\n${text}`);
      assert.match(text, pickupTime(start_at), `${label}: the pickup time in\n${text}`);
    }
  }
});

// [page locale, booking locale, paid, refund at 40%]. The booking's own locale differs from the page's: the page answers
// in the language of the link, and mail goes out in the language the guest booked in.
const POSTS: [Locale, Locale, number, number][] = [
  ["ja", "en", 9001, 3600],
  ["en", "ko", 10_001, 4000],
  ["zh-cn", "ja", 11_001, 4400],
  ["ko", "zh-cn", 12_001, 4800],
];

test("POST cancels and a second POST does not refund again", async () => {
  await setTiers(TIERS);
  for (const [locale, bookingLocale, paid, refund] of POSTS) {
    const label = `${locale}, ${paid} paid`;
    const booking = await confirmed(10, paid, { locale: bookingLocale });
    const form = await cancelForm(locale, booking);
    const postedAt = Date.now();
    const callsBefore = refundCalls.length;

    const first = await send(form);
    const firstHtml = await first.text();
    assert.equal(first.status, 200, label);
    const firstText = mainText(firstHtml, label);
    assert.match(firstText, figure(refund), `${label}: the refund on the result page`);
    assertInLocale(firstText, locale, label);
    assert.deepEqual(postForms(firstHtml), [], `${label}: a form on the result page`);

    assert.deepEqual(refundCalls.slice(callsBefore), [
      {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        key: `rf:${booking.id}`,
        paymentId: booking.payment_id,
        amount: refund,
        currency: "JPY",
      },
    ]);

    const cancelled = await bookingNow(booking.id);
    assert.equal(cancelled.status, "CANCELLED", label);
    assert.equal(cancelled.cancel_reason, "guest", label);
    assert.ok(cancelled.cancelled_at !== null && cancelled.cancelled_at >= postedAt, `${label}: cancelled_at`);
    assert.ok((cancelled.cancelled_at ?? Infinity) <= Date.now(), `${label}: cancelled_at`);

    const refunds = await refundsOf(booking.id);
    assert.equal(refunds.length, 1, `${label}: refund rows`);
    assert.partialDeepStrictEqual(
      refunds[0],
      {
        square_refund_id: `square-rf:${booking.id}`,
        amount_jpy: refund,
        status: "PENDING",
        origin: "cancel",
        idempotency_key: `rf:${booking.id}`,
      },
      label,
    );

    const queued = await queuedFor(booking);
    assert.deepEqual(queued.map(({ name }) => name), RECEIPT, label);
    assert.partialDeepStrictEqual(queued[0], { to: booking.guest_email, locale: bookingLocale }, label);
    assert.equal(queued[2]?.to, STAFF_EMAIL, label);

    const after = await stored();
    const secondText = await assertAlreadyCancelled(await send(form), locale, `${label}, second POST`);
    assert.notEqual(secondText, firstText, `${label}: the second POST reads as the first`);
    assert.equal(refundCalls.length, callsBefore + 1, `${label}: a second refund`);
    assert.deepEqual(await stored(), after, `${label}: a second POST changed something`);

    const path = linkTo(locale, booking.id, tokenOf(booking.id));
    await assertAlreadyCancelled(await getPage(path), locale, `${label}, GET after the cancel`);
    assert.equal(refundCalls.length, callsBefore + 1, `${label}: a refund on GET`);
  }
});

test("POSTs at the same moment cancel once and each gets a page", async () => {
  await setTiers(TIERS);
  const booking = await confirmed(10, 9000);
  const form = await cancelForm("en", booking);

  const answers = await Promise.all(Array.from({ length: 6 }, () => send(form)));
  const pages = await Promise.all(answers.map(async (res) => ({ status: res.status, html: await res.text() })));

  // The loser of the race takes a path a POST after the fact never takes: the quote was fine and the cancel was refused.
  assert.deepEqual(pages.map(({ status }) => status), Array.from({ length: 6 }, () => 200));
  const shown = pages.map(({ html }) => mainText(html, "a POST in the race"));
  assert.equal(shown.filter((text) => !alreadyCancelled.en.test(text)).length, 1, `the pages:\n${shown.join("\n")}`);

  assert.equal(refundCalls.length, 1, "refund calls");
  assert.equal((await refundsOf(booking.id)).length, 1, "refund rows");
  assert.deepEqual((await queuedFor(booking)).map(({ name }) => name), RECEIPT);
  assert.equal((await bookingNow(booking.id)).status, "CANCELLED");
});

test("the loser of a race gets the already-cancelled page and no refund", async () => {
  await setTiers(TIERS);
  for (const locale of LOCALES) {
    const label = `${locale}, the loser of a race`;
    const booking = await confirmed(10, 9000);
    // The update comes to nothing while the booking still reads CONFIRMED, as for a request that passed the page's check
    // just before another won. Real POSTs reach this path 1 run in 15, which leaves the page to luck.
    await worker.db
      .prepare(
        `CREATE TRIGGER lose_race BEFORE UPDATE ON bookings WHEN OLD.id = '${booking.id}' AND NEW.status = 'CANCELLED' ` +
          "BEGIN SELECT RAISE(IGNORE); END",
      )
      .run();
    try {
      const update = worker.db.prepare("UPDATE bookings SET status = 'CANCELLED' WHERE id = ?1 AND status = 'CONFIRMED'");
      assert.equal((await update.bind(booking.id).run()).meta.changes, 0, `${label}: the trigger let an update through`);

      const form = await cancelForm(locale, booking);
      await assertAlreadyCancelled(await send(form), locale, label);
      assert.deepEqual(refundCalls, [], `${label}: Square was called`);
    } finally {
      await worker.db.prepare("DROP TRIGGER lose_race").run();
    }
  }
});

test("bad tokens get 404", async () => {
  await setTiers(FULL_REFUND);
  const booking = await confirmed(10, 9000);
  const other = await confirmed(10, 8000);
  const ghost = randomUUID();
  const good = tokenOf(booking.id);
  const flip = good.endsWith("A") ? "B" : "A";
  const swapCase = Array.from(good, (char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase())).join("");

  // Each is refused for `booking`, whose real token is `good`. [what, token]
  const badTokens: [string, string][] = [
    ["another booking's token", tokenOf(other.id)],
    ["the token of testVars' secret", sign(testVars.CANCEL_LINK_SECRET as string, booking.id)],
    ["a forged token", sign("guessed-secret", booking.id)],
    ["an HMAC of the bare id", createHmac("sha256", SECRET).update(booking.id, "utf8").digest("base64url").slice(0, 32)],
    ["one character short", good.slice(0, -1)],
    ["one character long", `${good}A`],
    ["the last character changed", good.slice(0, -1) + flip],
    ["swapped case", swapCase],
    ["the whole digest", createHmac("sha256", SECRET).update(`cancel:${booking.id}`, "utf8").digest("base64url")],
    ["a double-encoded token", `%${good.charCodeAt(0).toString(16).toUpperCase()}${good.slice(1)}`],
    ["an empty token", ""],
  ];

  const encodedId = encodeURIComponent(booking.id);
  const hostile = "' OR '1'='1";
  // Links that are not `?b=<booking>&t=<token>`. [what, query]
  const badQueries: [string, string][] = [
    ["no query", ""],
    ["no token", `?b=${encodedId}`],
    ["no booking", `?t=${good}`],
    ["both empty", "?b=&t="],
    ["the two swapped", `?b=${good}&t=${encodedId}`],
    ["another booking with this token", `?b=${other.id}&t=${good}`],
    ["a booking that does not exist, signed", `?b=${ghost}&t=${tokenOf(ghost)}`],
    ["a booking that does not exist, unsigned", `?b=${ghost}&t=${good}`],
    ["hostile text for a booking", `?b=${encodeURIComponent(hostile)}&t=${good}`],
    ["hostile text, signed", `?b=${encodeURIComponent(hostile)}&t=${tokenOf(hostile)}`],
    ["a stray percent", "?b=%&t=%"],
  ];

  const forms = new Map<Locale, Submission>();
  for (const locale of LOCALES) forms.set(locale, await cancelForm(locale, booking));
  const unchanged = await stored();
  const details = [booking.ref, booking.guest_family_name, booking.guest_email, booking.payment_id, booking.vehicle_plate];

  for (const locale of LOCALES) {
    const form = forms.get(locale) as Submission;
    const refusedPages = { GET: new Set<string>(), POST: new Set<string>() };
    const assertRefused = async (res: Response, method: "GET" | "POST", what: string): Promise<void> => {
      const label = `${locale} ${method}, ${what}`;
      const body = await res.text();
      assert.equal(res.status, 404, label);
      for (const detail of details) assert.ok(!body.includes(String(detail)), `${label}: the 404 shows ${detail}`);
      refusedPages[method].add(body);
    };

    for (const [what, token] of badTokens) {
      await assertRefused(await getPage(linkTo(locale, booking.id, token)), "GET", what);
      // The form came from a good GET, so this is a token that was valid there and is tampered with on POST.
      await assertRefused(await send(changed(form, (value) => (value === good ? token : value))), "POST", what);
    }

    for (const [what, query] of badQueries) {
      await assertRefused(await getPage(`/${locale}/booking/cancel${query}`), "GET", what);
    }

    const posts: [string, (value: string) => string | null][] = [
      ["no token", (value) => (value === good ? null : value)],
      ["no booking", (value) => (value === booking.id ? null : value)],
      ["neither", (value) => (value === good || value === booking.id ? null : value)],
      ["another booking with this token", (value) => (value === booking.id ? other.id : value)],
      [
        "a booking that does not exist, signed",
        (value) => {
          if (value === booking.id) return ghost;
          return value === good ? tokenOf(ghost) : value;
        },
      ],
      ["hostile text for a booking", (value) => (value === booking.id ? hostile : value)],
      [
        "hostile text, signed",
        (value) => {
          if (value === booking.id) return hostile;
          return value === good ? tokenOf(hostile) : value;
        },
      ],
    ];
    for (const [what, change] of posts) await assertRefused(await send(changed(form, change)), "POST", what);

    // No detail: a real booking with a bad token reads exactly as no booking at all.
    assert.equal(refusedPages.GET.size, 1, `${locale}: GET 404s differ, which tells a guessed id from a real one`);
    assert.equal(refusedPages.POST.size, 1, `${locale}: POST 404s differ, which tells a guessed id from a real one`);
  }

  assert.deepEqual(await stored(), unchanged, "a refused request changed something");
  assert.deepEqual(refundCalls, [], "a refused request called Square");

  assert.equal(await statusOf(await send(forms.get("en") as Submission)), 200, "the untampered form");
  assert.equal((await bookingNow(booking.id)).status, "CANCELLED", "the untampered form");
});

test("bad tokens get the same 404 whatever state the booking is in", async () => {
  await setTiers(FULL_REFUND);
  const now = Date.now();
  const cancelled = { status: "CANCELLED", cancel_reason: "guest", cancelled_at: now - HOUR_MS };
  const started = { start_at: now - HOUR_MS, end_at: now + DAY_MS };
  // [what, booking, what its own link answers]. A 404 is a booking no real link names, because it is not a confirmed web
  // booking: NOT_CANCELLABLE gets the 404 of NOT_FOUND, so even its real token answers as no booking at all.
  const targets: [string, BookingRow, 200 | 404][] = [
    ["a cancelled booking", await confirmed(10, 9000, cancelled), 200],
    ["a booking past its pickup", await confirmed(0, 9000, started), 200],
    ["a cancelled booking past its pickup", await confirmed(0, 9000, { ...started, ...cancelled }), 200],
    ["a hold", await confirmed(10, 9000, { status: "ON_HOLD", expires_at: now + HOUR_MS }), 404],
    ["a booking in payment", await confirmed(10, 9000, { status: "PAYMENT_PENDING" }), 404],
    ["an expired hold", await confirmed(10, 9000, { status: "EXPIRED" }), 404],
    ["a staff block", await confirmed(10, 9000, { source: "block", external_ref: "e2e-block-bad-token" }), 404],
  ];
  const other = await confirmed(10, 8000);

  for (const locale of LOCALES) {
    // A page that answers from the booking's state before it checks the token tells who booked what to anyone with an id.
    const ghost = randomUUID();
    const ghostForm = await formFor(locale, { id: ghost });
    const ghostPages = { GET: await getPage(linkTo(locale, ghost, tokenOf(ghost))), POST: await send(ghostForm) };
    assert.equal(ghostPages.GET.status, 404, `${locale}: GET of no booking`);
    assert.equal(ghostPages.POST.status, 404, `${locale}: POST of no booking`);
    const nothing = { GET: await ghostPages.GET.text(), POST: await ghostPages.POST.text() };

    for (const [what, target, ownLink] of targets) {
      const good = tokenOf(target.id);
      const form = await formFor(locale, target);
      const assertRefused = async (res: Response, method: "GET" | "POST", how: string): Promise<void> => {
        const label = `${locale} ${method}, ${what}, ${how}`;
        assert.equal(res.status, 404, label);
        assert.equal(await res.text(), nothing[method], `${label}: this 404 is not the 404 of no booking`);
      };

      const tokens: [string, string][] = [
        ["another booking's token", tokenOf(other.id)],
        ["a forged token", sign("guessed-secret", target.id)],
        ["the last character changed", good.slice(0, -1) + (good.endsWith("A") ? "B" : "A")],
        ["an empty token", ""],
      ];
      for (const [how, token] of tokens) {
        await assertRefused(await getPage(linkTo(locale, target.id, token)), "GET", how);
        await assertRefused(await send(changed(form, (value) => (value === good ? token : value))), "POST", how);
      }

      await assertRefused(await getPage(`/${locale}/booking/cancel?b=${encodeURIComponent(target.id)}`), "GET", "no token");
      const tampered: [string, (value: string) => string | null][] = [
        ["no token", (value) => (value === good ? null : value)],
        ["no booking", (value) => (value === target.id ? null : value)],
        ["another booking with this token", (value) => (value === target.id ? other.id : value)],
      ];
      for (const [how, change] of tampered) await assertRefused(await send(changed(form, change)), "POST", how);

      // The booking and the page are there: this link with its real token gets past the check, and one that cannot be
      // cancelled then reads exactly as no booking, on GET and on POST.
      if (ownLink === 404) {
        await assertRefused(await getPage(linkTo(locale, target.id, good)), "GET", "its own link");
        await assertRefused(await send(form), "POST", "its own link");
      } else {
        assert.equal(await statusOf(await getPage(linkTo(locale, target.id, good))), ownLink, `${locale}, ${what}: its own link`);
        assert.equal(await statusOf(await send(form)), ownLink, `${locale} POST, ${what}: its own link`);
      }
    }
  }

  for (const [what, target] of targets) {
    assert.deepEqual(await bookingNow(target.id), target, `${what}: a refused request changed it`);
    assert.deepEqual(await refundsOf(target.id), [], `${what}: a refund row`);
    assert.deepEqual(await queuedFor(target), [], `${what}: mail`);
  }
  assert.deepEqual(refundCalls, [], "a refused request called Square");
});

/** Names a page could read an id from without its own form ever sending them. */
const ID_NAMES = ["b", "id", "booking", "bookingId", "booking_id"];

/** A request made from a booking's form. A true says only a refusal fits. */
type Move = [string, (form: Submission, own: string) => Submission, boolean];

test("a POST cannot aim one booking's token at another", async () => {
  await setTiers(FULL_REFUND);
  const victim = await confirmed(10, 8000);
  const unchanged = await bookingNow(victim.id);
  const sample = await confirmed(10, 7000);
  const places = placesOf(await cancelForm("en", sample), sample.id);

  /** `pairs`, then the victim's id under each name of ID_NAMES that `pairs` does not use. */
  const aimed = (pairs: [string, string][]): [string, string][] => {
    const free = ID_NAMES.filter((name) => !pairs.some(([used]) => used === name));
    return [...pairs, ...free.map((name): [string, string] => [name, victim.id])];
  };

  // The id in one place only and the token left alone, for a page that verifies what it reads from one place and cancels
  // what it reads from another. Field names are the page's, so these go by value, once per place that holds the id. With
  // two places an honest page may refuse or may go by the one it reads, which is the link's own booking, so all that is
  // pinned is the victim. With a single place, as in a form with no id field, nothing else can sign for the id, so a swap
  // must be refused. Names the form never sends are all that is left to try on such a page, so they go last, for a page
  // with a fallback: the body for a form that sends none, and the query for a form that posts to a bare URL.
  const moves: Move[] = [
    ...Array.from({ length: places }, (_, nth): Move => [
      `the id changed in place ${nth + 1} of ${places}`,
      (form, own) => swappedAt(form, nth, own, victim.id),
      places === 1,
    ]),
    ["id names the form does not send, in the body", ({ url, fields }) => ({ url, fields: aimed(fields) }), false],
    [
      "id names the form does not send, in the query",
      ({ url, fields }) => {
        const moved = new URL(url);
        moved.search = new URLSearchParams(aimed([...url.searchParams])).toString();
        return { url: moved, fields };
      },
      false,
    ],
  ];

  for (const [what, move, refused] of moves) {
    const attacker = await confirmed(10, 7000);
    const sent = move(await cancelForm("en", attacker), attacker.id);
    assert.ok(carries(sent, victim.id), `${what}: this request does not name the other booking, so it proves nothing`);

    const res = await send(sent);
    const body = await res.text();
    assert.ok(res.status < 500, `${what}: status ${res.status}`);
    for (const detail of [victim.ref, victim.guest_family_name, victim.guest_email]) {
      assert.ok(!body.includes(String(detail)), `${what}: the answer shows ${detail}`);
    }

    assert.deepEqual(await bookingNow(victim.id), unchanged, `${what}: the other booking changed`);
    assert.deepEqual(await refundsOf(victim.id), [], `${what}: the other booking was refunded`);
    assert.deepEqual(await queuedFor(victim), [], `${what}: mail for the other booking`);
    for (const { paymentId } of refundCalls) assert.notEqual(paymentId, victim.payment_id, `${what}: refunded the other booking`);

    if (refused) {
      assert.equal(res.status, 404, what);
      assert.equal((await bookingNow(attacker.id)).status, "CONFIRMED", `${what}: a refused request cancelled`);
    }
  }

  // The route is there, and the victim's own link still works.
  assert.equal(await statusOf(await send(await cancelForm("en", victim))), 200);
  assert.equal((await bookingNow(victim.id)).status, "CANCELLED");
});

test("POST charges the tier at POST time and ignores what the client sends", async () => {
  // A number no tier gives, sent under names a page might read and over any value in the form that equals the quote.
  const forged = "999999";
  const FORGED_FIELDS = ["amount", "amountJpy", "amount_jpy", "refund", "refundJpy", "refund_jpy", "percent", "refundPercent"];
  const quoted = { percent: 40, refund: 3600 };

  // [what, tiers published between GET and POST, the refund they give]. Up, down and to nothing.
  const changes: [string, TierRow[], number][] = [
    ["a better tier", [{ min_days_before: 0, refund_percent: 70 }], 6300],
    ["a worse tier", [{ min_days_before: 0, refund_percent: 10 }], 900],
    ["no refund any more", [{ min_days_before: 0, refund_percent: 0 }], 0],
  ];

  for (const [what, tiers, refund] of changes) {
    await setTiers(TIERS);
    refundCalls.length = 0;
    const booking = await confirmed(10, 9000);
    const page = await (await getPage(linkTo("en", booking.id, tokenOf(booking.id)))).text();
    assert.match(mainText(page, what), figure(quoted.refund), `${what}: the quote on GET`);

    const form = await cancelForm("en", booking);
    const replaced = changed(form, (value) => (value === String(quoted.refund) || value === String(quoted.percent) ? forged : value));
    const url = new URL(replaced.url);
    for (const name of FORGED_FIELDS) url.searchParams.set(name, forged);
    const padded: Submission = { url, fields: [...replaced.fields, ...FORGED_FIELDS.map((name): [string, string] => [name, forged])] };

    await setTiers(tiers);
    const res = await send(padded);
    const html = await res.text();

    assert.equal(res.status, 200, what);
    assert.match(mainText(html, what), figure(refund), `${what}: the refund on the result page`);
    assert.doesNotMatch(mainText(html, what), figure(quoted.refund), `${what}: the old quote on the result page`);
    assert.deepEqual(refundCalls.map(({ amount }) => amount), refund === 0 ? [] : [refund], what);
    assert.deepEqual((await refundsOf(booking.id)).map(({ amount_jpy }) => amount_jpy), refund === 0 ? [] : [refund], what);
    assert.equal((await bookingNow(booking.id)).status, "CANCELLED", what);
  }
});

/** Names a page might carry the time of a quote under, on top of any field of its own. */
const TIME_FIELDS = ["quotedAt", "quoted_at", "quoteTime", "now", "at", "time", "timestamp", "ts", "daysBefore"];

// [what, the forged value for a booking]. Each is a time long before pickup, the best tier there is.
const FORGED_TIMES: [string, (booking: BookingRow) => string][] = [
  ["an old time", (booking) => String(booking.start_at - 40 * DAY_MS)],
  ["zero", () => "0"],
];

/** `form` with `value` in place of everything but the booking's id and token, and under TIME_FIELDS in the body and URL. */
function forgedForm(form: Submission, booking: BookingRow, value: string): Submission {
  const token = tokenOf(booking.id);
  const { url, fields } = changed(form, (held) => (held === booking.id || held === token ? held : value));
  const moved = new URL(url);
  for (const name of TIME_FIELDS) moved.searchParams.set(name, value);
  return { url: moved, fields: [...fields, ...TIME_FIELDS.map((name): [string, string] => [name, value])] };
}

test("a time in the form does not move the tier", async () => {
  await setTiers(TIERS);
  for (const [what, forge] of FORGED_TIMES) {
    refundCalls.length = 0;
    // Three days out is 15%, 1500. The forged time would make it 80%, 8000.
    const booking = await confirmed(3, 10_000);
    const form = await cancelForm("en", booking);
    const before = await stored();

    let res = await send(forgedForm(form, booking, forge(booking)));

    // A page may refuse a form it did not write, with nothing moved. Its own form must still get the tier.
    if (res.status === 404) {
      await res.text();
      assert.deepEqual(await stored(), before, `${what}: a refused form changed something`);
      assert.deepEqual(refundCalls, [], `${what}: a refused form called Square`);
      res = await send(form);
    }

    const html = await res.text();
    assert.equal(res.status, 200, what);
    const text = mainText(html, what);
    assert.match(text, figure(1500), `${what}: the refund on the result page`);
    assert.doesNotMatch(text, figure(8000), `${what}: the forged tier on the result page`);
    assert.deepEqual(refundCalls.map(({ amount }) => amount), [1500], `${what}: the refund call`);
    assert.deepEqual((await refundsOf(booking.id)).map(({ amount_jpy }) => amount_jpy), [1500], `${what}: the refund row`);
    assert.equal((await bookingNow(booking.id)).status, "CANCELLED", what);
  }
});

test("a form taken before pickup cancels nothing after it", async () => {
  await setTiers(FULL_REFUND);
  for (const locale of LOCALES) {
    const booking = await confirmed(10, 9000);
    const form = await cancelForm(locale, booking);
    await movePickup(booking.id, Date.now() - HOUR_MS);
    const before = await stored();

    await assertStartedPage(await send(form), locale, `${locale}, the form as it came`);

    for (const [what, forge] of FORGED_TIMES) {
      const res = await send(forgedForm(form, booking, forge(booking)));
      if (res.status === 404) await res.text();
      else await assertStartedPage(res, locale, `${locale}, ${what}`);
    }

    assert.deepEqual(refundCalls, [], `${locale}: a refund`);
    assert.deepEqual(await stored(), before, `${locale}: something changed`);
    assert.equal((await bookingNow(booking.id)).status, "CONFIRMED", locale);
  }
});

test("the page quotes and refunds what the tier leaves after earlier refunds", async () => {
  const half: TierRow[] = [{ min_days_before: 0, refund_percent: 50 }];
  // [what, tiers, paid, refunded in the Dashboard, refund]: the ticket's two worked examples, then a refund used up.
  const cases: [string, TierRow[], number, number, number][] = [
    ["50% of 10000, 4000 gone", half, 10_000, 4000, 1000],
    ["100% of 10000, 4000 gone", FULL_REFUND, 10_000, 4000, 6000],
    ["50% of 8000, 4000 gone", half, 8000, 4000, 0],
  ];

  for (const [what, tiers, paid, earlier, refund] of cases) {
    await setTiers(tiers);
    refundCalls.length = 0;
    const booking = await confirmed(10, paid);
    await insertRow(worker.db, "refunds", {
      id: randomUUID(),
      booking_id: booking.id,
      square_refund_id: `dashboard-${booking.id}`,
      amount_jpy: earlier,
      status: "COMPLETED",
      origin: "dashboard",
      idempotency_key: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const quote = await getPage(linkTo("en", booking.id, tokenOf(booking.id)));
    const quoteHtml = await quote.text();
    assert.equal(quote.status, 200, what);
    assert.match(mainText(quoteHtml, what), figure(refund), `${what}: the quote on GET`);

    const res = await send(await cancelForm("en", booking));
    const html = await res.text();
    assert.equal(res.status, 200, what);
    assert.match(mainText(html, what), figure(refund), `${what}: the refund on the result page`);

    assert.deepEqual(refundCalls.map(({ amount }) => amount), refund === 0 ? [] : [refund], `${what}: the refund call`);
    const made = (await refundsOf(booking.id)).filter(({ origin }) => origin === "cancel");
    assert.deepEqual(made.map(({ amount_jpy }) => amount_jpy), refund === 0 ? [] : [refund], `${what}: the refund row`);
    assert.equal((await bookingNow(booking.id)).status, "CANCELLED", what);
  }
});

test("a zero-percent cancel does not call Square", async () => {
  await setTiers(TIERS);
  // [what, days, paid]: a 0% tier, and a 40% tier of nothing paid.
  const bookings: [string, number, number][] = [
    ["the 0% tier", 1, 9000],
    ["nothing paid", 10, 0],
  ];
  for (const locale of LOCALES) {
    for (const [what, days, paid] of bookings) {
      const label = `${locale}, ${what}`;
      const booking = await confirmed(days, paid);
      const form = await cancelForm(locale, booking);

      const res = await send(form);
      const html = await res.text();
      assert.equal(res.status, 200, label);
      assert.match(mainText(html, label), figure(0), `${label}: the refund on the result page`);
      assertInLocale(mainText(html, label), locale, label);

      assert.deepEqual(refundCalls, [], `${label}: Square was called`);
      assert.deepEqual(await refundsOf(booking.id), [], `${label}: a refund row`);
      assert.equal((await bookingNow(booking.id)).status, "CANCELLED", label);
      assert.deepEqual((await queuedFor(booking)).map(({ name }) => name), RECEIPT, label);

      await assertAlreadyCancelled(await send(form), locale, `${label}, second POST`);
      assert.deepEqual(refundCalls, [], `${label}: Square was called on the second POST`);
    }
  }
});

function squareError(status: number, category: string, code: string): () => Response {
  return () => Response.json({ errors: [{ category, code, detail: "Refused in the test" }] }, { status });
}

// [what, answer, row statuses, Square's id on the row, a staff alert]
const OUTCOMES: [string, (body: RefundBody) => Response, string[], boolean, boolean][] = [
  ["a completed refund", refundAs("COMPLETED"), ["COMPLETED"], true, false],
  ["a pending refund", refundAs("PENDING"), ["PENDING"], true, false],
  ["a 500", () => new Response("upstream failed", { status: 500 }), ["RETRY"], false, false],
  ["a 408", () => new Response("timed out", { status: 408 }), ["RETRY"], false, false],
  ["a 200 with no refund in it", () => Response.json({}), ["RETRY"], false, false],
  ["a rejected refund", refundAs("REJECTED"), ["REJECTED"], false, true],
  ["a declined refund", squareError(400, "PAYMENT_METHOD_ERROR", "REFUND_DECLINED"), ["REJECTED"], false, true],
  ["a refused request", squareError(400, "INVALID_REQUEST_ERROR", "INVALID_VALUE"), ["REJECTED", "FAILED"], false, true],
];

test("every refund result leaves the booking cancelled and the guest a page", async () => {
  await setTiers(TIERS);
  for (const locale of LOCALES) {
    for (const [what, answer, statuses, hasSquareId, alert] of OUTCOMES) {
      const label = `${locale}, ${what}`;
      refundCalls.length = 0;
      answerRefund = answer;
      const booking = await confirmed(10, 9000);
      const form = await cancelForm(locale, booking);

      const res = await send(form);
      const html = await res.text();
      assert.equal(res.status, 200, label);
      assert.match(mainText(html, label), figure(3600), `${label}: the refund on the result page`);
      assertInLocale(mainText(html, label), locale, label);

      assert.equal((await bookingNow(booking.id)).status, "CANCELLED", label);
      assert.equal(refundCalls.length, 1, `${label}: refund calls`);
      const [refund, ...others] = await refundsOf(booking.id);
      assert.deepEqual(others, [], `${label}: refund rows`);
      assert.ok(refund !== undefined && statuses.includes(refund.status), `${label}: a row in ${refund?.status}`);
      if (hasSquareId) assert.equal(refund.square_refund_id, `square-rf:${booking.id}`, label);

      const queued = await queuedFor(booking);
      const alerts = queued.filter(({ name }) => name === "staff_alert");
      assert.deepEqual(alerts.map(({ to }) => to), alert ? [STAFF_EMAIL] : [], `${label}: staff alerts`);

      // A refund left to retry is not sent again by the guest pressing the button again.
      await assertAlreadyCancelled(await send(form), locale, `${label}, second POST`);
      assert.equal(refundCalls.length, 1, `${label}: a second refund call`);
    }
  }
});

test("a repeat POST after pickup still shows the booking as already cancelled", async () => {
  await setTiers(FULL_REFUND);
  for (const locale of LOCALES) {
    const booking = await confirmed(10, 9000);
    const form = await cancelForm(locale, booking);
    assert.equal(await statusOf(await send(form)), 200, locale);
    refundCalls.length = 0;

    // Pickup passes. An hour in, and with the rental over.
    for (const hoursAgo of [1, 48]) {
      const label = `${locale}, pickup ${hoursAgo} hours ago`;
      await movePickup(booking.id, Date.now() - hoursAgo * HOUR_MS);
      const before = await stored();

      await assertAlreadyCancelled(await send(form), locale, `${label}, POST`);
      await assertAlreadyCancelled(await getPage(linkTo(locale, booking.id, tokenOf(booking.id))), locale, `${label}, GET`);

      assert.deepEqual(refundCalls, [], `${label}: a refund`);
      assert.deepEqual(await stored(), before, `${label}: something changed`);
    }
  }
});

test("a booking past its pickup cannot be cancelled", async () => {
  await setTiers(FULL_REFUND);
  for (const locale of LOCALES) {
    for (const hoursAgo of [1, 48]) {
      const label = `${locale}, pickup ${hoursAgo} hours ago`;
      const started = await confirmed(0, 9000, { start_at: Date.now() - hoursAgo * HOUR_MS, end_at: Date.now() + DAY_MS });
      const form = await formFor(locale, started);
      const before = await stored();

      await assertStartedPage(await getPage(linkTo(locale, started.id, tokenOf(started.id))), locale, `${label}, GET`);
      await assertStartedPage(await send(form), locale, `${label}, POST`);

      assert.deepEqual(refundCalls, [], `${label}: a refund`);
      assert.deepEqual(await stored(), before, `${label}: something changed`);
      assert.equal((await bookingNow(started.id)).status, "CONFIRMED", label);
    }
  }
});

test("only confirmed web bookings can be cancelled", async () => {
  await setTiers(FULL_REFUND);
  // A real link can only exist for a confirmed booking, so these are links signed by the one who holds the secret. The
  // page answers them as it answers no booking at all: NOT_CANCELLABLE gets the 404 of NOT_FOUND, body and all, and
  // nothing moves.
  const ghost = randomUUID();
  const ghostPages = { GET: await getPage(linkTo("en", ghost, tokenOf(ghost))), POST: await send(await formFor("en", { id: ghost })) };
  assert.equal(ghostPages.GET.status, 404, "GET of no booking");
  assert.equal(ghostPages.POST.status, 404, "POST of no booking");
  const nothing = { GET: await ghostPages.GET.text(), POST: await ghostPages.POST.text() };

  const states: [string, Partial<BookingRow>][] = [
    ["a hold", { status: "ON_HOLD", expires_at: Date.now() + HOUR_MS }],
    ["a booking in payment", { status: "PAYMENT_PENDING" }],
    ["an expired hold", { status: "EXPIRED" }],
    ["a staff block", { source: "block", external_ref: "e2e-block" }],
  ];
  for (const [what, change] of states) {
    const booking = await confirmed(10, 9000, change);
    const form = await formFor("en", booking);
    const before = await stored();

    const answers = { GET: await getPage(linkTo("en", booking.id, tokenOf(booking.id))), POST: await send(form) };
    for (const method of ["GET", "POST"] as const) {
      const res = answers[method];
      const html = await res.text();
      assert.equal(res.status, 404, `${what} ${method}: status ${res.status}`);
      assert.equal(html, nothing[method], `${what} ${method}: this 404 is not the 404 of no booking`);
      assert.deepEqual(postForms(html), [], `${what}: a form to cancel`);
    }

    assert.deepEqual(refundCalls, [], `${what}: a refund`);
    assert.deepEqual(await stored(), before, `${what}: something changed`);
  }

  // The same link on a confirmed booking does cancel.
  const booking = await confirmed(10, 9000);
  assert.equal(await statusOf(await send(await formFor("en", booking))), 200);
  assert.equal((await bookingNow(booking.id)).status, "CANCELLED");
});

test("unknown locales get 404 on GET and POST", async () => {
  await setTiers(FULL_REFUND);
  const booking = await confirmed(10, 9000);
  const form = await cancelForm("en", booking);
  const token = tokenOf(booking.id);
  const before = await stored();

  // Near misses of the four codes, and names every object inherits. A valid token must not get a POST past this.
  const segments = ["fr", "xx", "zh", "zh-tw", "zh_cn", "zh-CN", "ZH-CN", "JA", "En", "en-us", "constructor", "__proto__", "0"];
  for (const segment of segments) {
    assert.equal(await statusOf(await getPage(linkTo(segment, booking.id, token))), 404, `GET /${segment}`);

    const url = new URL(form.url);
    url.pathname = url.pathname.replace("/en/", `/${segment}/`);
    assert.equal(await statusOf(await send({ url, fields: form.fields })), 404, `POST /${segment}`);
  }

  assert.deepEqual(await stored(), before, "a request under an unknown locale changed something");
  assert.deepEqual(refundCalls, [], "a request under an unknown locale called Square");

  assert.equal(await statusOf(await send(form)), 200, "the same form under a real locale");
});

// Miniflare itself answers 403 to an Origin on a hostname that is not local, before any Worker code runs, so a check with
// https://evil.example would pass with Astro's own check turned off. These stay on localhost to reach Astro's.
const CROSS_SITE: [string, Record<string, string>][] = [
  ["a form on another port", { Origin: "http://localhost:8787" }],
  ["a form over another scheme", { Origin: "https://localhost" }],
  ["a form that says it is cross-site", { "Sec-Fetch-Site": "cross-site" }],
  ["text/plain from another port", { Origin: "http://localhost:8787", "Content-Type": "text/plain" }],
];

test("a POST from another origin is refused", async () => {
  await setTiers(FULL_REFUND);
  const booking = await confirmed(10, 9000);
  const form = await cancelForm("en", booking);
  const before = await stored();

  for (const [what, headers] of CROSS_SITE) assert.equal(await statusOf(await send(form, headers)), 403, what);

  assert.deepEqual(await stored(), before, "a cross-site POST changed something");
  assert.deepEqual(refundCalls, [], "a cross-site POST called Square");

  assert.equal(await statusOf(await send(form)), 200, "the same form from the site");
  assert.equal((await bookingNow(booking.id)).status, "CANCELLED", "the same form from the site");
});

/** [what, content type, body] of bodies that do not read as a form, with broken escapes under the form's own names too. */
function unreadableBodies({ fields }: Submission): [string, string, string][] {
  const names = [...fields.map(([name]) => name), "b", "t"];
  return [
    ["multipart with no parts", "multipart/form-data; boundary=x", "garbage"],
    ["multipart with no boundary", "multipart/form-data", "garbage"],
    ["broken JSON", "application/json", "{"],
    ["broken escapes", "application/x-www-form-urlencoded", names.map((name) => `${encodeURIComponent(name)}=%E0%A4%A`).join("&")],
    ["nothing", "application/x-www-form-urlencoded", ""],
  ];
}

function postRaw(path: string, contentType: string, body: string): Promise<Response> {
  return worker.fetch(path, { method: "POST", redirect: "manual", headers: { "Content-Type": contentType, Origin: ORIGIN }, body });
}

test("a POST with an unreadable body gets 404", async () => {
  // Only a route that exists can answer 404 on purpose, so the page has to be there first.
  await setTiers(FULL_REFUND);
  const bodies = unreadableBodies(await cancelForm("en", await confirmed(10, 9000)));

  for (const locale of LOCALES) {
    for (const [what, contentType, body] of bodies) {
      assert.equal(await statusOf(await postRaw(`/${locale}/booking/cancel`, contentType, body)), 404, `${locale}, ${what}`);
    }
  }
});

test("an unreadable body on a good link does not break the page", async () => {
  await setTiers(FULL_REFUND);
  const first = await confirmed(10, 9000);
  const bodies = unreadableBodies(await cancelForm("en", first));

  // Sent to the link itself, which is where the form posts back to. The page goes by the URL alone and never reads the
  // body, so whatever the body is, the booking is cancelled, once. A page that reads the body, or throws on it, fails here.
  for (const [what, contentType, body] of bodies) {
    const booking = await confirmed(10, 9000);
    await cancelForm("en", booking);
    const callsBefore = refundCalls.length;

    const status = await statusOf(await postRaw(linkTo("en", booking.id, tokenOf(booking.id)), contentType, body));

    assert.equal(status, 200, `${what}: status ${status}`);
    assert.equal((await bookingNow(booking.id)).status, "CANCELLED", what);
    assert.equal(refundCalls.length, callsBefore + 1, `${what}: refund calls`);
    assert.equal(refundCalls.at(-1)?.paymentId, booking.payment_id, `${what}: the refund call`);
  }

  assert.equal(await statusOf(await send(await cancelForm("en", first))), 200, "the page's own form");
  assert.equal((await bookingNow(first.id)).status, "CANCELLED", "the page's own form");
});
