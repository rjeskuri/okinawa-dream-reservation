// The checkout page, through the built Worker, over bookings written straight into D1. Each behaviour runs on two stays that
// share no value, so a literal in the page shows. Times come from Date.parse on an explicit +09:00 offset, never from
// src/lib/time.ts. The Worker reads the real clock, so an expiry is set from now, with a margin that outlasts the test.
//
// Facts are looked for by their values, so the wording stays free. What the page has to name for these tests to find it is
// the seam with src/scripts/checkout.ts, set out at the top of tests/helpers/checkout-client.ts: `<form id="checkout">` and
// its data attributes, the card mount `#card-container`, the button `#pay-button`, inputs named after the guest fields of
// the confirm contract with their `data-error-for` elements, `#checkout-message` and `#countdown`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import {
  assertSameStructure,
  nativeSubmitUrl,
  openCheckout,
  readHoldPage,
  respond,
  tagsOutsideCode,
  type Guest as GuestInput,
} from "../helpers/checkout-client.ts";
import { blocksOf, decodeEntities, mainOf, tagsIn, visibleText, withoutCode, type Tag } from "../helpers/html.ts";
import {
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedType,
  seedVehicle,
  type BookingRow,
} from "../helpers/seed.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const SANDBOX_SDK = "https://sandbox.web.squarecdn.com/v1/square.js";
const PRODUCTION_SDK = "https://web.squarecdn.com/v1/square.js";

/** The `guest` fields of the confirm contract (task #34). */
const GUEST_FIELDS = ["familyName", "givenName", "email", "phone"];

/** What the catalog says today, which a booking's own price and deposit must win over. */
const TYPE_DEPOSIT_JPY = 33_000;

type Moment = { date: string; time: string; at: number; utcDate: string; utcTime: string };

function moment(date: string, time: string): Moment {
  const at = Date.parse(`${date}T${time}:00+09:00`);
  const utc = new Date(at).toISOString();
  return { date, time, at, utcDate: utc.slice(0, 10), utcTime: utc.slice(11, 16) };
}

type Stay = {
  modelNames: Record<Locale, string>;
  packageNames: Record<Locale, string>;
  priceJpy: number;
  depositJpy: number;
  /** The same amounts by hand, with their thousands separators, so a page's own formatting cannot be the expected value. */
  priceDigits: string;
  depositDigits: string;
  catalogPriceJpy: number;
  pickup: Moment;
  dropoff: Moment;
  /** The locale of the booking row, which is not the locale of the URL. */
  bookedIn: Locale;
};

type PublishedStay = Stay & { modelId: string; packageId: string };

/** Both pickups are on the day before in UTC. The first return is on the same date, so only its clock can show UTC. */
const FIRST: Stay = {
  modelNames: { ja: "沖縄カブ 110", en: "Okinawa Cub 110", "zh-cn": "冲绳小狼 110", ko: "오키나와 커브 110" },
  packageNames: { ja: "三日間ツーリング", en: "Three day ride", "zh-cn": "三日骑行", ko: "사흘 라이드" },
  priceJpy: 18_700,
  depositJpy: 7_300,
  priceDigits: "18,700",
  depositDigits: "7,300",
  catalogPriceJpy: 91_000,
  pickup: moment("2031-03-15", "08:30"),
  dropoff: moment("2031-03-17", "17:45"),
  bookedIn: "ja",
};

/** Crosses a year in UTC at the pickup and a day at the return. */
const SECOND: Stay = {
  modelNames: { ja: "琉球フォルツァ 250", en: "Ryukyu Forza 250", "zh-cn": "琉球佛沙 250", ko: "류큐 포르자 250" },
  packageNames: { ja: "一週間の旅", en: "Week away", "zh-cn": "一周之旅", ko: "일주일 여행" },
  priceJpy: 64_250,
  depositJpy: 12_500,
  priceDigits: "64,250",
  depositDigits: "12,500",
  catalogPriceJpy: 87_000,
  pickup: moment("2032-01-01", "00:45"),
  dropoff: moment("2032-01-08", "07:20"),
  bookedIn: "ko",
};

type Guest = Pick<BookingRow, "guest_family_name" | "guest_given_name" | "guest_email" | "guest_phone">;

const ADA: Guest = {
  guest_family_name: "Zanzibarova",
  guest_given_name: "Quillette",
  guest_email: "quillette.z@sentinel-one.example",
  guest_phone: "+81 90-4242-7171",
};

const BEN: Guest = {
  guest_family_name: "鵜久森",
  guest_given_name: "瑠璃香",
  guest_email: "ruri.ukumori@sentinel-two.example",
  guest_phone: "090-8686-3535",
};

const CAROL: Guest = {
  guest_family_name: "Xenophilius",
  guest_given_name: "Wintermoth",
  guest_email: "x.wintermoth@sentinel-three.example",
  guest_phone: "+82 10-5151-2929",
};

let worker: TestWorker;
let first: PublishedStay;
let second: PublishedStay;

function textsOf(names: Record<Locale, string>, more: Record<string, string> = {}): string {
  return JSON.stringify(Object.fromEntries(LOCALES.map((locale) => [locale, { name: names[locale], ...more }])));
}

async function openShop(db: D1Database): Promise<void> {
  await seedType(db, { deposit_jpy: TYPE_DEPOSIT_JPY });
  await seedConfig(db);
  await seedCatalogMeta(db);
}

async function publish(db: D1Database, stay: Stay): Promise<PublishedStay> {
  const rate = await seedRateClass(db);
  const model = await seedModel(db, {
    rate_class_id: rate.id,
    texts: textsOf(stay.modelNames, { summary: "A summary", description: "A description" }),
  });
  const pack = await seedPackage(db, { texts: textsOf(stay.packageNames) });
  await seedPrice(db, { rate_class_id: rate.id, package_id: pack.id, price_jpy: stay.catalogPriceJpy });
  return { ...stay, modelId: model.id, packageId: pack.id };
}

/** A booking of `stay`. Its guest fields stay empty, as a new hold's do, unless `row` names them. */
function book(stay: PublishedStay, row: Partial<BookingRow>, db: D1Database = worker.db): Promise<BookingRow> {
  return seedBooking(db, {
    model_id: stay.modelId,
    package_id: stay.packageId,
    start_at: stay.pickup.at,
    end_at: stay.dropoff.at,
    price_jpy: stay.priceJpy,
    deposit_jpy: stay.depositJpy,
    locale: stay.bookedIn,
    guest_family_name: null,
    guest_given_name: null,
    guest_email: null,
    guest_phone: null,
    ...row,
  });
}

function holdRow(expires_at: number | null = Date.now() + 12 * MINUTE_MS): Partial<BookingRow> {
  return { status: "ON_HOLD", expires_at };
}

/**
 * A row in each status past a hold. `expires_at` stays on the row after a hold moves on, so every one of these is past it,
 * and only the EXPIRED one may read as expired.
 */
function laterRows(stay: Stay, now: number) {
  const paid = { payment_id: "square-payment-id", paid_jpy: stay.depositJpy, confirmed_at: now - 2 * DAY_MS };
  return {
    PAYMENT_PENDING: { status: "PAYMENT_PENDING", expires_at: now - MINUTE_MS, payment_attempt: 1 },
    CONFIRMED: { status: "CONFIRMED", expires_at: now - 2 * DAY_MS, ...paid },
    EXPIRED: { status: "EXPIRED", expires_at: now - HOUR_MS },
    CANCELLED: { status: "CANCELLED", expires_at: now - 2 * DAY_MS, ...paid, cancelled_at: now - HOUR_MS },
  } satisfies Record<string, Partial<BookingRow>>;
}

before(async () => {
  worker = await startWorker();
  await openShop(worker.db);
  first = await publish(worker.db, FIRST);
  second = await publish(worker.db, SECOND);
});

after(async () => {
  await worker?.stop();
});

type Page = { path: string; html: string; main: string; text: string };

async function page(locale: Locale, id: string, target: TestWorker = worker): Promise<Page> {
  const path = `/${locale}/checkout/${id}`;
  const res = await target.fetch(path, { redirect: "manual" });
  const html = await res.text();
  assert.equal(res.status, 200, `${path}\n${html.slice(0, 400)}`);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
  const main = mainOf(html, path);
  const text = visibleText(main);
  assert.doesNotMatch(text, /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|\{\w+\}/, `${path} prints a missing value`);
  return { path, html, main, text };
}

async function assertNotFound(path: string): Promise<void> {
  const res = await worker.fetch(path, { redirect: "manual" });
  await res.text();
  assert.equal(res.status, 404, path);
}

function hasAttributeValue(html: string, value: string): boolean {
  return tagsOutsideCode(html).some(({ attributes }) => Object.values(attributes).includes(value));
}

/** `jpy` as a page may write it, with or without thousands separators, whatever stands around it. */
function yen(jpy: number): RegExp {
  return new RegExp(`(?<![\\d.,])(?:${jpy}|${jpy.toLocaleString("en-US")})(?!\\d|[.,]\\d)`);
}

/** Money as the site writes it: `email.amount` and every page since, with a bare ¥ kept from a Chinese reader. */
const moneyForm: Record<Locale, (digits: string) => string> = {
  ja: (digits) => `¥${digits}`,
  en: (digits) => `¥${digits}`,
  "zh-cn": (digits) => `${digits}日元`,
  ko: (digits) => `${digits}엔`,
};

/** `digits` in `locale`'s form and no longer number around it. */
function money(locale: Locale, digits: string): RegExp {
  return new RegExp(`(?<![\\d,])${moneyForm[locale](digits)}(?![\\d,])`);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `date` as a page may write it: 2031-03-15, 2031/3/15, 2031. 3. 15., 3/15/2031, 3月15日, 3월 15일, Mar 15, 15 March. */
function dateOnPage(date: string): RegExp {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const name = MONTHS[month - 1];
  return new RegExp(
    [
      `(?<!\\d)${year}\\s*[-/.年년]\\s*0?${month}\\s*[-/.月월]\\s*0?${day}(?!\\d)`,
      `(?<![\\d/])0?${month}/0?${day}/${year}(?!\\d)`,
      `(?<![\\d/.])0?${month}\\s*[月월]\\s*0?${day}\\s*[日일]`,
      `\\b${name}[a-z]*\\.?\\s+0?${day}(?!\\d)`,
      `(?<![\\d/.])0?${day}\\s+${name}`,
    ].join("|"),
    "i",
  );
}

/** A time of day, with or without its leading zero. */
function clock(time: string): RegExp {
  return new RegExp(`(?<![\\d:])${time.replace(/^0/, "0?")}(?![\\d:])`);
}

function assertMoment(text: string, { date, time, utcDate, utcTime }: Moment, label: string): void {
  assert.match(text, dateOnPage(date), `${label}: no JST date ${date} in\n${text}`);
  assert.match(text, clock(time), `${label}: no JST time ${time} in\n${text}`);
  assert.doesNotMatch(text, clock(utcTime), `${label}: the UTC time ${utcTime}`);
  if (utcDate !== date) assert.doesNotMatch(text, dateOnPage(utcDate), `${label}: the UTC date ${utcDate}`);
}

function assertStayDates(text: string, stay: Stay, label: string): void {
  assertMoment(text, stay.pickup, `${label} pickup`);
  assertMoment(text, stay.dropoff, `${label} return`);
  const pickup = text.search(dateOnPage(stay.pickup.date));
  const dropoff = text.search(dateOnPage(stay.dropoff.date));
  assert.ok(pickup < dropoff, `${label}: the return comes before the pickup`);
}

/** The name in `locale` is on the page, and no other locale's. */
function assertName(text: string, names: Record<Locale, string>, locale: Locale, label: string): void {
  for (const other of LOCALES) {
    assert.equal(text.includes(names[other]), other === locale, `${label}: ${names[other]} in\n${text}`);
  }
}

/** Text that can only be this locale's, so one locale's sentences cannot stand in for another's. */
const script: Record<Locale, { must: RegExp; mustNot: RegExp }> = {
  ja: { must: /\p{Script=Hiragana}|\p{Script=Katakana}/u, mustNot: /\p{Script=Hangul}/u },
  en: { must: /[A-Za-z]{3}/, mustNot: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  "zh-cn": { must: /\p{Script=Han}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  ko: { must: /\p{Script=Hangul}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}/u },
};

/** The page's own words are in the locale, with the sheet's names taken out, since those are in it already. */
function assertWordsIn(locale: Locale, { text, path }: Page, stay: Stay): void {
  let words = text;
  for (const name of [...Object.values(stay.modelNames), ...Object.values(stay.packageNames)]) {
    words = words.replaceAll(name, " ");
  }
  assert.match(words, script[locale].must, `${path}: no text in the locale's script\n${words}`);
  assert.doesNotMatch(words, script[locale].mustNot, `${path}: text from another locale\n${words}`);
}

/** The word for what is left to pay. "Remaining" is not in this list, since a countdown may use it. */
const balanceWord: Record<Locale, RegExp> = {
  ja: /残金|残額/,
  en: /\bbalance\b/i,
  "zh-cn": /余款|尾款|余额/,
  ko: /잔금|잔액/,
};

/** The deposit question of epic #4 is open, so no page says what is left to pay. */
function assertNoBalance({ text, path }: Page, stay: Stay, locale: Locale): void {
  assert.doesNotMatch(text, yen(stay.priceJpy - stay.depositJpy), `${path}: a balance due`);
  assert.doesNotMatch(text, balanceWord[locale], `${path}: a balance due`);
}

function hasCardMount(main: string): boolean {
  return tagsIn(main).some(({ attributes }) => attributes.id === "card-container");
}

function payButton(main: string): Tag | undefined {
  return tagsIn(main).find(({ attributes }) => attributes.id === "pay-button");
}

/** The controls a guest types in, which a hidden field, a submit input or a button is not. */
function typedControls(main: string): Tag[] {
  const untyped = ["hidden", "submit", "button"];
  return tagsIn(main).filter(
    ({ name, attributes }) =>
      ["select", "textarea"].includes(name) || (name === "input" && !untyped.includes(attributes.type ?? "")),
  );
}

function assertCardForm({ main, path }: Page, stay: Stay): void {
  assert.ok(hasCardMount(main), `${path}: no #card-container`);
  assert.ok(tagsIn(main).some(({ name }) => name === "form"), `${path}: no form`);

  const names = typedControls(main).map(({ attributes }) => attributes.name);
  for (const field of GUEST_FIELDS) assert.ok(names.includes(field), `${path}: no input ${field} in ${names.join(", ")}`);

  const button = payButton(main);
  assert.ok(button, `${path}: no #pay-button`);
  assert.equal(button.name, "button", `${path}: #pay-button`);
  assert.ok("disabled" in button.attributes, `${path}: #pay-button renders live, before any card has mounted`);
  const label = visibleText(main.slice(button.index, main.indexOf("</button", button.index)));
  assert.match(label, yen(stay.depositJpy), `${path}: the button shows ${label}`);
  assert.doesNotMatch(label, yen(stay.priceJpy), `${path}: the button shows the rental price`);
}

/** The same detectors as assertCardForm, so an absence here cannot come from looking for the wrong thing. */
function assertNoCardForm({ html, main, path }: Page): void {
  assert.equal(hasCardMount(main), false, `${path}: #card-container`);
  assert.equal(payButton(main), undefined, `${path}: #pay-button`);
  assert.deepEqual(typedControls(main), [], `${path}: guest inputs`);
  assert.doesNotMatch(html, /squarecdn/i, `${path}: the Square SDK`);
}

/** The URL is where the client looks for it, which tests/checkout-client.test.ts holds it to, and on no other tag. */
function assertSdk({ html, path }: Page, sdk: string, other: string): void {
  assert.equal(readHoldPage(html, path).sdkUrl, sdk, `${path}: ${sdk} is not the SDK the client will load`);
  const carriers = tagsOutsideCode(html).filter(({ attributes }) => Object.values(attributes).includes(sdk));
  assert.equal(carriers.length, 1, `${path}: ${carriers.length} tags carry ${sdk}`);
  assert.equal(html.includes(other), false, `${path}: ${other} is on the page`);
}

const cardTerms: Record<Locale, { brands: RegExp[]; unionPay: RegExp; online: RegExp }> = {
  ja: {
    brands: [
      /Visa|ビザ/i,
      /Master\s?Card|マスターカード/i,
      /American Express|アメリカン・?エキスプレス|アメックス/i,
      /Discover|ディスカバー/i,
      /Diners|ダイナース/i,
      /JCB/,
    ],
    unionPay: /UnionPay|ユニオンペイ|銀聯/i,
    online: /オンライン|ネット|ウェブ/,
  },
  en: {
    brands: [/Visa/i, /Master\s?Card/i, /American Express/i, /Discover/i, /Diners/i, /JCB/],
    unionPay: /Union\s?Pay/i,
    online: /online/i,
  },
  "zh-cn": {
    brands: [/Visa|维萨/i, /Master\s?Card|万事达/i, /American Express|运通/i, /Discover|发现卡/i, /Diners|大来/i, /JCB/],
    unionPay: /UnionPay|银联/i,
    online: /在线|线上|网上|网站/,
  },
  ko: {
    brands: [
      /Visa|비자/i,
      /Master\s?Card|마스터\s?카드/i,
      /American Express|아메리칸\s?익스프레스/i,
      /Discover|디스커버/i,
      /Diners|다이너스/i,
      /JCB/,
    ],
    unionPay: /UnionPay|유니온\s?페이|은련/i,
    online: /온라인|인터넷|웹/,
  },
};

const negation: Record<Locale, RegExp> = {
  ja: /ません|ない|不可|無効|対象外/,
  en: /\b(?:not|no|cannot|never)\b|n't\b|invalid/i,
  "zh-cn": /不|无法|无效/,
  ko: /않|없|불가|무효|아닙/,
};

function assertCardTerms({ main, text, path }: Page, locale: Locale): void {
  const terms = cardTerms[locale];
  for (const brand of terms.brands) assert.match(text, brand, `${path}: no ${brand} in\n${text}`);

  // An accepted-cards list that names UnionPay leaves a sentence with no negation here.
  const sentences = blocksOf(main).flatMap((block) => block.split(/(?<=[。！？；!?;])|(?<=\.)\s+/));
  const unionPay = sentences.filter((sentence) => terms.unionPay.test(sentence));
  assert.ok(unionPay.length > 0, `${path}: UnionPay is not mentioned`);
  for (const sentence of unionPay) assert.match(sentence, negation[locale], `${path}: UnionPay is not refused: ${sentence}`);
  assert.ok(
    unionPay.some((sentence) => terms.online.test(sentence)),
    `${path}: the refusal does not say online\n${unionPay.join("\n")}`,
  );
}

/** Where the page's links go, as paths with no trailing slash. */
function linkPaths({ main, path }: Page): string[] {
  return tagsIn(main)
    .filter(({ name, attributes }) => name === "a" && attributes.href !== undefined)
    .map(({ attributes }) => new URL(attributes.href as string, `http://localhost${path}`).pathname.replace(/\/$/, ""));
}

/** The model page of task #26, and the search on the listing of task #25 or the home page. */
function assertExpiredLinks(view: Page, stay: PublishedStay, locale: Locale): void {
  const paths = linkPaths(view);
  assert.ok(paths.includes(`/${locale}/rentals/${stay.modelId}`), `${view.path}: no model link in ${paths.join(", ")}`);
  assert.ok(
    paths.includes(`/${locale}/rentals`) || paths.includes(`/${locale}`),
    `${view.path}: no search link in ${paths.join(", ")}`,
  );
}

function assertRefresh({ main, path }: Page): void {
  const refresh = tagsIn(main).some(
    ({ name, attributes }) =>
      name === "button" ||
      (name === "a" &&
        attributes.href !== undefined &&
        new URL(attributes.href, `http://localhost${path}`).pathname.replace(/\/$/, "") === path),
  );
  assert.ok(refresh, `${path}: no way to refresh`);
}

/** The page's text with what two bookings of one stay cannot share taken out, so the two can be compared. */
function stateText({ text }: Page, booking: BookingRow): string {
  return text.replaceAll(booking.ref, "").replaceAll(booking.id, "").replace(/\s+/g, " ").trim();
}

/** `text` with what two bookings of one stay cannot share taken out. */
function withoutBooking(text: string, booking: BookingRow): string {
  return text.replaceAll(booking.ref, "").replaceAll(booking.id, "").replace(/\s+/g, " ").trim();
}

/** The state's one `<h1>`, so a page has a headline of its own and a link elsewhere on it cannot tell two states apart. */
function headline({ main, path }: Page, booking: BookingRow): string {
  const headings = main.match(/<h1\b[\s\S]*?<\/h1\s*>/gi) ?? [];
  assert.equal(headings.length, 1, `${path}: ${headings.length} h1`);
  const words = withoutBooking(visibleText(headings[0] as string), booking);
  assert.notEqual(words, "", `${path}: an empty h1`);
  return words;
}

/** The word for a cancelled booking, in that state's headline. */
const cancelledWord: Record<Locale, RegExp> = {
  ja: /キャンセル|取り?消/,
  en: /cancel/i,
  "zh-cn": /取消/,
  ko: /취소/,
};

function guestPieces(guest: Guest): string[] {
  const { guest_family_name, guest_given_name, guest_email, guest_phone } = guest as Record<keyof Guest, string>;
  const at = guest_email.indexOf("@");
  return [
    guest_family_name,
    guest_given_name,
    guest_email,
    guest_email.slice(0, at),
    guest_email.slice(at + 1),
    guest_phone.replace(/^\+/, ""),
    guest_phone.replace(/\D/g, ""),
  ];
}

/** Over the whole document, so an attribute, a title or a script's data counts as much as a line of text. */
function assertNoGuest(html: string, guest: Guest, label: string): void {
  const document = html.toLowerCase();
  for (const piece of guestPieces(guest)) {
    assert.equal(document.includes(piece.toLowerCase()), false, `${label}: ${piece} is on the page`);
  }
  // Four digits are short enough to turn up in a color or a file hash, so these are looked for in what a reader sees.
  const lastFour = (guest.guest_phone as string).slice(-4);
  assert.equal(visibleText(withoutCode(html)).includes(lastFour), false, `${label}: the phone's last four are on the page`);
}

/** `html` with what two renders of one state cannot share taken out: the booking's own ids, the time left and the clock. */
function pageShape(html: string, booking: BookingRow): string {
  const countdown = tagsIn(html).find(({ attributes }) => attributes.id === "countdown");
  const steady =
    countdown === undefined
      ? html
      : html.slice(0, countdown.index) + html.slice(html.indexOf(`</${countdown.name}`, countdown.index));
  return steady.replaceAll(booking.id, "BOOKING").replaceAll(booking.ref, "REF").replace(/\b\d{13}\b/g, "CLOCK");
}

/** The page's client code: its inline scripts and the built files it loads, with what those import. */
function clientCode(html: string): string {
  const client = new URL("../../dist/client/", import.meta.url);
  const read = new Map<string, string>();
  const load = (url: URL): void => {
    if (read.has(url.href)) return;
    const code = readFileSync(url, "utf8");
    read.set(url.href, code);
    for (const [, file] of code.matchAll(/["'](\.\.?\/[^"']+\.js)["']/g)) load(new URL(file as string, url));
  };
  for (const { name, attributes } of tagsOutsideCode(html)) {
    if (name === "script" && attributes.src?.startsWith("/")) load(new URL(attributes.src.slice(1), client));
  }
  const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(([, code]) => code);
  return [...inline, ...read.values()].join("\n");
}

test("an active hold shows the summary and the sandbox SDK", async () => {
  const cases: [PublishedStay, number][] = [
    [first, 11 * MINUTE_MS],
    [second, 13 * MINUTE_MS + 17_000],
  ];
  for (const [stay, left] of cases) {
    const expiresAt = Date.now() + left;
    const hold = await book(stay, holdRow(expiresAt));
    const other = stay === first ? second : first;

    for (const locale of LOCALES) {
      const view = await page(locale, hold.id);
      const { html, text, path } = view;

      assertName(text, stay.modelNames, locale, `${path} model`);
      assertName(text, stay.packageNames, locale, `${path} package`);
      assertStayDates(text, stay, path);
      assert.match(text, yen(stay.priceJpy), `${path}: no rental price in\n${text}`);
      assert.match(text, yen(stay.depositJpy), `${path}: no deposit in\n${text}`);

      // The booking keeps what the guest was quoted, whatever the catalog says now.
      assert.doesNotMatch(text, yen(stay.catalogPriceJpy), `${path}: today's catalog price`);
      assert.doesNotMatch(text, yen(TYPE_DEPOSIT_JPY), `${path}: today's catalog deposit`);
      assert.doesNotMatch(text, yen(other.priceJpy), `${path}: the other stay's price`);
      assert.doesNotMatch(text, yen(other.depositJpy), `${path}: the other stay's deposit`);

      assert.ok(
        tagsOutsideCode(html).some(({ attributes }) => attributes["data-expires-at"] === String(expiresAt)),
        `${path}: no data-expires-at of ${expiresAt}`,
      );

      assertCardForm(view, stay);
      assertSdk(view, SANDBOX_SDK, PRODUCTION_SDK);
      // What the client runs on: the URL's locale, which is not the row's, and this booking's own deposit and expiry.
      assert.deepEqual(readHoldPage(html, path), {
        bookingId: hold.id,
        locale,
        depositJpy: stay.depositJpy,
        sdkUrl: SANDBOX_SDK,
        applicationId: testVars.SQUARE_APPLICATION_ID,
        locationId: testVars.SQUARE_LOCATION_ID,
        expiresAt,
      });
      assertCardTerms(view, locale);
      assertWordsIn(locale, view, stay);
      assertNoBalance(view, stay, locale);
    }
  }
});

test("the deposit and the rental price read as the site writes money, in every locale", async () => {
  for (const stay of [first, second]) {
    const hold = await book(stay, holdRow());
    const confirmed = await book(stay, laterRows(stay, Date.now()).CONFIRMED);
    for (const locale of LOCALES) {
      const { main, path } = await page(locale, hold.id);
      const button = payButton(main) as Tag;
      const end = main.indexOf("</button", button.index);
      const label = visibleText(main.slice(button.index, end));
      const summary = visibleText(main.slice(0, button.index) + main.slice(end));

      assert.match(label, money(locale, stay.depositDigits), `${path}: the button says ${label}`);
      assert.match(summary, money(locale, stay.depositDigits), `${path}: no deposit in the summary\n${summary}`);
      assert.match(summary, money(locale, stay.priceDigits), `${path}: no rental price in the summary\n${summary}`);

      const paid = await page(locale, confirmed.id);
      assert.match(paid.text, money(locale, stay.depositDigits), `${paid.path}: no deposit paid in\n${paid.text}`);
    }
  }
});

test("a native submit of the hold form puts no guest detail in a URL", async () => {
  // What a click would do with no client to stop it: the client's script failed, or has not run yet.
  const guests: GuestInput[] = [
    { familyName: "Yamada", givenName: "Hanako", email: "hanako@example.jp", phone: "+81 90-1234-5678" },
    { familyName: "鵜久森", givenName: "瑠璃香", email: "ruri.u@example.co.jp", phone: "090-8686-3535" },
  ];
  for (const stay of [first, second]) {
    const hold = await book(stay, holdRow());
    for (const locale of LOCALES) {
      const { html, path } = await page(locale, hold.id);
      for (const guest of guests) {
        const url = nativeSubmitUrl(html, guest, `http://localhost${path}`);
        const names = [...url.searchParams.keys()];
        const values = [...url.searchParams.values()];
        for (const field of GUEST_FIELDS) assert.equal(names.includes(field), false, `${path}: ${field} in ${url.search}`);
        for (const value of Object.values(guest)) assert.equal(values.includes(value), false, `${path}: ${value} in the URL`);
      }
    }
  }
});

test("the SDK and the Square ids follow the Worker's env", async () => {
  const cases = [
    {
      vars: { SQUARE_ENV: "sandbox", SQUARE_APPLICATION_ID: "sandbox-sq0idb-first", SQUARE_LOCATION_ID: "LFIRST123" },
      sdk: SANDBOX_SDK,
      other: PRODUCTION_SDK,
    },
    {
      vars: { SQUARE_ENV: "production", SQUARE_APPLICATION_ID: "sq0idp-second", SQUARE_LOCATION_ID: "LSECOND456" },
      sdk: PRODUCTION_SDK,
      other: SANDBOX_SDK,
    },
  ];
  for (const { vars, sdk, other } of cases) {
    const target = await startWorker({ vars });
    try {
      await openShop(target.db);
      const stay = await publish(target.db, FIRST);
      const hold = await book(stay, holdRow(), target.db);
      for (const locale of LOCALES) {
        const view = await page(locale, hold.id, target);
        assertSdk(view, sdk, other);
        assert.ok(hasAttributeValue(view.html, vars.SQUARE_APPLICATION_ID), `${view.path}: no application id`);
        assert.ok(hasAttributeValue(view.html, vars.SQUARE_LOCATION_ID), `${view.path}: no location id`);
        const seam = readHoldPage(view.html, view.path);
        assert.equal(seam.applicationId, vars.SQUARE_APPLICATION_ID, `${view.path}: the client gets another application id`);
        assert.equal(seam.locationId, vars.SQUARE_LOCATION_ID, `${view.path}: the client gets another location id`);
        for (const secret of ["SQUARE_ACCESS_TOKEN", "SQUARE_WEBHOOK_SIGNATURE_KEY"]) {
          assert.equal(view.html.includes(testVars[secret] as string), false, `${view.path}: ${secret} is on the page`);
        }
      }
    } finally {
      await target.stop();
    }
  }
});

test("the hold page loads the client that tokenizes and confirms", async () => {
  const hold = await book(first, holdRow());
  const code = clientCode((await page("en", hold.id)).html);
  assert.match(code, /\.payments\(/, "the SDK is never asked for a payments object");
  assert.match(code, /\.attach\(/, "the card is never attached");
  assert.match(code, /\.tokenize\(/, "the card is never tokenized");
  assert.match(code, /sellerKeyedIn/, "the verification details are never built, so there is no 3-D Secure");
  assert.doesNotMatch(code, /verifyBuyer/, "verifyBuyer is being deprecated");
  assert.doesNotMatch(code, /astro:page-load/, "that event needs <ClientRouter />, so a plain page never fires it");
  assert.match(code, /\/api\/holds\/[\s\S]{0,80}\/confirm/, "the confirm endpoint is never called");
});

test("the real client runs on the page the Worker renders", async (t) => {
  const cases: { stay: () => PublishedStay; locale: Locale; guest: GuestInput }[] = [
    {
      stay: () => first,
      locale: "ja",
      guest: { familyName: "山田", givenName: "花子", email: "hanako@example.jp", phone: "090-1234-5678" },
    },
    {
      // zh-cn is the locale whose <html lang> is spelled otherwise, and the confirm contract wants the site's spelling.
      stay: () => second,
      locale: "zh-cn",
      guest: { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000" },
    },
  ];
  for (const { stay: published, locale, guest } of cases) {
    const stay = published();
    const now = Date.now();
    const hold = await book(stay, holdRow(now + 9 * MINUTE_MS));
    const { html, path } = await page(locale, hold.id);
    const message = `Declined ${stay.depositJpy}`;
    const token = `cnon:${hold.id}`;

    const checkout = await openCheckout(t, html, {
      now,
      tokens: [token],
      confirms: [respond(402, { ok: false, reason: "PAYMENT_DECLINED", message })],
    });
    assert.deepEqual(checkout.sdkRequests, [SANDBOX_SDK], path);
    assert.deepEqual(checkout.square.payments, [[testVars.SQUARE_APPLICATION_ID, testVars.SQUARE_LOCATION_ID]], path);
    assert.deepEqual(checkout.square.attach, ["#card-container"], path);

    const shown = checkout.countdown();
    await checkout.tick(2_000);
    assert.notEqual(checkout.countdown(), shown, `${path}: the countdown does not tick`);

    // What the page's own markup has to let through: an error that shows, a button that works, a message that is seen.
    checkout.fill({ ...guest, email: "hanako@" });
    await checkout.pay();
    assert.notEqual(checkout.fieldError("email"), "", `${path}: the error does not show on the real page`);
    assert.deepEqual(checkout.confirms, [], `${path}: posted a bad email`);

    // The form as a guest leaves it, and what goes out is the trimmed guest.
    checkout.fill({
      familyName: ` ${guest.familyName} `,
      givenName: `　${guest.givenName}　`,
      email: `  ${guest.email}`,
      phone: `${guest.phone}\t`,
    });
    await checkout.pay();
    const details = {
      amount: String(stay.depositJpy),
      currencyCode: "JPY",
      intent: "CHARGE",
      customerInitiated: true,
      sellerKeyedIn: false,
      billingContact: guest,
    };
    assert.deepEqual(checkout.square.tokenize, [[details]], path);
    assert.deepEqual(
      checkout.confirms,
      [
        {
          method: "POST",
          path: `/api/holds/${hold.id}/confirm`,
          contentType: "application/json",
          body: { sourceId: token, guest, locale },
        },
      ],
      path,
    );
    assert.ok(checkout.message().includes(message), `${path}: the decline does not show on the real page`);
    assert.equal(checkout.payable(), true, `${path}: the pay button does not come back on the real page`);

    // `page` reads the real clock and the real fetch, and this page has both faked.
    checkout.close();
  }
});

test("the real page tells the guest when the card form fails or the time runs out", async (t) => {
  for (const [stay, locale] of [
    [first, "ko"],
    [second, "ja"],
  ] as [PublishedStay, Locale][]) {
    const now = Date.now();
    const left = 4 * MINUTE_MS;
    const hold = await book(stay, holdRow(now + left));
    const { html, path } = await page(locale, hold.id);

    const failed = await openCheckout(t, html, { now, sdk: "fails" });
    assert.match(failed.message(), script[locale].must, `${path}: a failed SDK shows no message on the real page`);
    assert.equal(failed.payable(), false, `${path}: a failed SDK leaves the real button live`);
    failed.submit();
    await failed.settle();
    assert.deepEqual(failed.confirms, [], `${path}: posted with no card`);
    failed.close();

    const ran = await openCheckout(t, html, { now });
    await ran.tick(left + 1_000);
    assert.ok(
      ran.reloads > 0 || script[locale].must.test(ran.message()),
      `${path}: nothing on the real page says the time ran out`,
    );
    assert.equal(ran.payable(), false, `${path}: the real button is live past the expiry`);

    // `page` reads the real clock and the real fetch, and this page has both faked.
    ran.close();
  }
});

test("each other status renders its own state without a card form", async () => {
  for (const stay of [first, second]) {
    const bookings = new Map<string, BookingRow>();
    for (const [status, row] of Object.entries(laterRows(stay, Date.now()))) {
      bookings.set(status, await book(stay, { ...row, ...ADA }));
    }
    const inFlight = await book(stay, {
      ...laterRows(stay, Date.now()).PAYMENT_PENDING,
      ...ADA,
      expires_at: Date.now() + 12 * MINUTE_MS,
    });
    const onHold = await book(stay, holdRow());

    for (const locale of LOCALES) {
      const views = new Map<string, Page>();
      for (const [status, booking] of bookings) {
        const view = await page(locale, booking.id);
        views.set(status, view);
        assertNoCardForm(view);
        assertWordsIn(locale, view, stay);
      }

      // Bookings of one stay, so all that can differ is the state each page reports.
      const texts = [...bookings].map(([status, booking]) => stateText(views.get(status) as Page, booking));
      assert.equal(new Set(texts).size, texts.length, `${locale}: two states read the same\n${texts.join("\n")}`);

      // The headline is what a guest reads first, so a copied one is the wrong state however the rest of the page differs.
      const headlines = new Map([
        ["ON_HOLD", headline(await page(locale, onHold.id), onHold)],
        ...[...bookings].map(([status, booking]) => [status, headline(views.get(status) as Page, booking)] as const),
      ]);
      const seen = [...headlines].map(([status, words]) => `${status}: ${words}`).join("\n");
      assert.equal(new Set(headlines.values()).size, headlines.size, `${locale}: two states share a headline\n${seen}`);
      assert.match(headlines.get("CANCELLED") as string, cancelledWord[locale], `${locale}: not headed cancelled\n${seen}`);

      // A charge in flight must not read as paid, in a title or an attribute any more than in the text.
      const paidWords = headlines.get("CONFIRMED") as string;
      const pendingHtml = decodeEntities((views.get("PAYMENT_PENDING") as Page).html).normalize("NFKC");
      const pendingWords = withoutBooking(pendingHtml, bookings.get("PAYMENT_PENDING") as BookingRow);
      assert.equal(pendingWords.includes(paidWords), false, `${locale}: the pending page says ${paidWords}`);

      const confirmed = views.get("CONFIRMED") as Page;
      const { ref } = bookings.get("CONFIRMED") as BookingRow;
      assert.ok(confirmed.text.includes(ref), `${confirmed.path}: no ref ${ref}`);
      assertName(confirmed.text, stay.modelNames, locale, `${confirmed.path} model`);
      assertStayDates(confirmed.text, stay, confirmed.path);
      assert.match(confirmed.text, yen(stay.depositJpy), `${confirmed.path}: no deposit paid in\n${confirmed.text}`);
      assertNoBalance(confirmed, stay, locale);

      const pending = views.get("PAYMENT_PENDING") as Page;
      assertRefresh(pending);
      assertExpiredLinks(views.get("EXPIRED") as Page, stay, locale);

      // A charge in flight inside the hold's time is no more payable than one past it, and reads the same.
      const stillHeld = await page(locale, inFlight.id);
      assertNoCardForm(stillHeld);
      assert.equal(stateText(stillHeld, inFlight), stateText(pending, bookings.get("PAYMENT_PENDING") as BookingRow));
    }
  }
});

test("a hold past its expiry reads as expired, whatever the status column says", async () => {
  const now = Date.now();
  // Eight hours is inside JST's offset, so a clock read in JST would still call that one active.
  const expiries: (number | null)[] = [now - 1_000, now - MINUTE_MS, now - 8 * HOUR_MS, now - 30 * DAY_MS, null];
  for (const stay of [first, second]) {
    const expired = await book(stay, { status: "EXPIRED", expires_at: now - HOUR_MS });
    const holds: BookingRow[] = [];
    for (const expiry of expiries) holds.push(await book(stay, holdRow(expiry)));

    for (const locale of LOCALES) {
      const expected = stateText(await page(locale, expired.id), expired);
      for (const hold of holds) {
        const view = await page(locale, hold.id);
        assertNoCardForm(view);
        assertExpiredLinks(view, stay, locale);
        assert.equal(stateText(view, hold), expected, `${view.path}: expires_at ${hold.expires_at}`);
      }
    }
  }
});

test("a hold with time left keeps its form", async () => {
  // Eight hours is inside JST's offset, so a clock read in JST would call that one over.
  for (const left of [MINUTE_MS, 8 * HOUR_MS]) {
    const hold = await book(second, holdRow(Date.now() + left));
    for (const locale of LOCALES) assertCardForm(await page(locale, hold.id), second);
  }
});

test("unknown ids return 404", async () => {
  const hold = await book(first, holdRow());

  // Without these the test would pass on a site with no such route.
  for (const locale of LOCALES) {
    await page(locale, hold.id);
    await page(locale, `${hold.id}/`);
  }

  const unknown = [
    "nope",
    "00000000-0000-4000-8000-000000000000",
    // The ref is on the guest's email and is short, so it must not open the page.
    hold.ref,
    hold.id.toUpperCase(),
    `${hold.id}x`,
    "x".repeat(500),
    "undefined",
    "null",
    // Names every object inherits, for a guard built on a lookup.
    "constructor",
    "__proto__",
    // Input a route must treat as data.
    "%27%20OR%201%3D1--",
    "%3Cscript%3Ealert(1)%3C%2Fscript%3E",
  ];
  for (const locale of LOCALES) {
    for (const id of unknown) {
      await assertNotFound(`/${locale}/checkout/${id}`);
    }
  }
});

test("unknown locales return 404 on this route, even with a valid booking id", async () => {
  const hold = await book(second, holdRow());
  for (const locale of LOCALES) await page(locale, hold.id);

  const unknown = [
    "fr",
    "xx",
    // Near misses of the four codes. Astro's own check ignores case, so it passes /JA/.
    "zh",
    "zh-tw",
    "zh_cn",
    "zh-CN",
    "ZH-CN",
    "JA",
    "En",
    "en-us",
    // Names every object inherits, for a guard built on a lookup.
    "constructor",
    "toString",
    "__proto__",
    "0",
    // Not codes at all.
    "%E6%97%A5%E6%9C%AC",
    "ja%20",
  ];
  for (const segment of unknown) {
    await assertNotFound(`/${segment}/checkout/${hold.id}`);
    await assertNotFound(`/${segment}/checkout/${hold.id}/`);
    await assertNotFound(`/${segment}/checkout/nope`);
  }
});

test("no personal data renders before confirmation", async () => {
  // A declined card returns the hold to ON_HOLD with the guest on it, and a charge in flight has them too.
  const now = Date.now();
  const rows: [string, Partial<BookingRow>][] = [
    ["an active hold", holdRow(now + 12 * MINUTE_MS)],
    ["a hold past its expiry", holdRow(now - MINUTE_MS)],
    ["a hold that lapsed", { status: "EXPIRED", expires_at: now - HOUR_MS }],
    ["a charge in flight", { status: "PAYMENT_PENDING", expires_at: now + 12 * MINUTE_MS, payment_attempt: 1 }],
    ["a charge past the expiry", { status: "PAYMENT_PENDING", expires_at: now - MINUTE_MS, payment_attempt: 1 }],
    ["a cancellation with no payment", { status: "CANCELLED", expires_at: now - HOUR_MS, cancelled_at: now - MINUTE_MS }],
    // The cancelled page is a message, and a guest's details have no place on a link that outlives the booking.
    ["a cancellation of a paid booking", laterRows(first, now).CANCELLED],
  ];
  for (const [label, row] of rows) {
    const bare = await book(first, row);
    const bookings = [
      { guest: ADA, booking: await book(first, { ...row, ...ADA }) },
      { guest: BEN, booking: await book(first, { ...row, ...BEN }) },
    ];
    for (const locale of LOCALES) {
      const expected = pageShape((await page(locale, bare.id)).html, bare);
      for (const { guest, booking } of bookings) {
        const { html, path } = await page(locale, booking.id);
        assertNoGuest(html, guest, `${label} at ${path}`);
        // A mask, a domain, an initial or a hash shows here whatever its form: a guest's page reads as if it had no guest.
        assert.equal(pageShape(html, booking), expected, `${label} at ${path}: the guest changed the page`);
      }
    }
  }
});

test("no state of this page echoes a query string", async () => {
  const now = Date.now();
  const typed = {
    familyName: "Querylastname",
    givenName: "Queryfirstname",
    email: "query.sentinel@leak-check.example",
    phone: "+81 90-6363-2828",
  };
  const searches = [
    // What a native GET writes, and the same address as a person would type it.
    `?${new URLSearchParams(typed).toString()}`,
    `?email=${typed.email}&phone=${typed.phone}&familyName=${typed.familyName}&givenName=${typed.givenName}`,
    // Markup stays out as well as data, for an echo that escapes one and not the other.
    `?email="><script>alert(1)</script>`,
  ];
  const seen = [
    ...Object.values(typed),
    "query.sentinel",
    "leak-check",
    encodeURIComponent(typed.email),
    encodeURIComponent(typed.phone),
    "alert(1)",
  ];
  const rows: [string, Partial<BookingRow>][] = [
    ["an active hold", holdRow(now + 12 * MINUTE_MS)],
    ["a hold past its expiry", holdRow(now - MINUTE_MS)],
    ...Object.entries(laterRows(first, now)),
  ];
  for (const [label, row] of rows) {
    const booking = await book(first, { ...row, ...ADA });
    for (const locale of LOCALES) {
      // Both spellings of the path, each against its own plain page, since the language links keep a trailing slash.
      for (const id of [booking.id, `${booking.id}/`]) {
        const expected = pageShape((await page(locale, id)).html, booking);
        for (const search of searches) {
          const { html, path } = await page(locale, `${id}${search}`);
          for (const piece of seen) assert.equal(html.includes(piece), false, `${label} at ${path}: ${piece} is on the page`);
          assert.equal(pageShape(html, booking), expected, `${label} at ${path}: the query changed the page`);
        }
      }
    }
  }
});

test("a confirmed page shows no other guest's data", async () => {
  const now = Date.now();
  // One model and one stay, so a page that looks a guest up by either finds the wrong one.
  const ada = await book(first, { ...laterRows(first, now).CONFIRMED, ...ADA });
  const ben = await book(first, { ...laterRows(first, now).CONFIRMED, ...BEN, vehicle_plate: ada.vehicle_plate });
  await book(first, { ...holdRow(now + 12 * MINUTE_MS), ...CAROL, vehicle_plate: ada.vehicle_plate });

  const cases: [BookingRow, Guest[]][] = [
    [ada, [BEN, CAROL]],
    [ben, [ADA, CAROL]],
  ];
  for (const [booking, others] of cases) {
    for (const locale of LOCALES) {
      const { html, text, path } = await page(locale, booking.id);
      assert.ok(text.includes(booking.ref), `${path}: not this booking's page`);
      for (const other of others) assertNoGuest(html, other, path);
    }
  }
});

test("a booking's page shows none of the row's staff-only fields", async () => {
  const now = Date.now();
  const stays = [
    [first, "sentinel-a7"],
    [second, "sentinel-b3"],
  ] as const;
  for (const [stay, mark] of stays) {
    const plate = `plate-${mark}`;
    await seedVehicle(worker.db, { plate, model_id: stay.modelId });
    const staffOnly = {
      vehicle_plate: plate,
      payment_id: `payment-${mark}`,
      external_ref: `external-ref-${mark}`,
      external_channel: `external-channel-${mark}`,
      content_hash: `content-hash-${mark}`,
      cancel_reason: `cancel-reason-${mark}`,
    };
    const later = laterRows(stay, now);
    const rows = [later.CONFIRMED, later.CANCELLED, later.PAYMENT_PENDING, later.EXPIRED, holdRow(now + 12 * MINUTE_MS)];
    for (const row of rows) {
      const booking = await book(stay, { ...row, ...ADA, ...staffOnly });
      for (const locale of LOCALES) {
        const { html, path } = await page(locale, booking.id);
        assert.equal(html.includes(mark), false, `${path}, ${row.status}: a staff-only field is on the page`);
      }
    }

    // The sentinels above can only mean something on a page that shows the booking at all.
    const confirmed = await book(stay, { ...later.CONFIRMED, ...ADA, ...staffOnly });
    const { text, path } = await page("en", confirmed.id);
    assert.ok(text.includes(confirmed.ref), `${path}: not this booking's page`);
  }
});

test("a guest's own text cannot write markup on the confirmed page", async () => {
  // Each one is written for a place on the page: text, either kind of attribute, a script's strings, a raw-text element.
  const hostile = [
    "<img src=x onerror=alert(1)>",
    "<script>alert(2)</script>",
    "</script><script>alert(3)</script>",
    "</SCRIPT ><img src=x onerror=alert(4)>",
    "x</script>y",
    "<!--<script>",
    '"><svg onload=alert(5)>',
    "'><svg onload=alert(6)>",
    '" onmouseover="alert(7)',
    "' onfocus='alert(8)",
    '";alert(9);//',
    "';alert(10);//",
    "`;alert(11);//",
    "${alert(12)}",
    "</title><script>alert(13)</script>",
    "</style><img src=x onerror=alert(14)>",
    "</textarea><img src=x onerror=alert(15)>",
    "javascript:alert(16)",
    "<b onclick=alert(17)>090</b>",
  ];
  const now = Date.now();
  const clean = await book(first, { ...laterRows(first, now).CONFIRMED, ...ADA });
  const cleanPages = new Map<Locale, string>();
  for (const locale of LOCALES) cleanPages.set(locale, (await page(locale, clean.id)).html);

  // Every text in every field in turn, with its neighbours in the others, so no field is left out of any of them.
  for (const [turn] of hostile.entries()) {
    const nth = (offset: number): string => hostile[(turn + offset) % hostile.length] as string;
    const guest = {
      guest_family_name: nth(0),
      guest_given_name: nth(1),
      guest_email: `${nth(2)}@example.jp`,
      guest_phone: nth(3),
    };
    const booking = await book(first, { ...laterRows(first, now).CONFIRMED, ...guest });
    for (const locale of LOCALES) {
      const { html, text, path } = await page(locale, booking.id);
      assert.ok(text.includes(booking.ref), `${path}: not this booking's page`);
      assertSameStructure(html, cleanPages.get(locale) as string, `${path} with ${JSON.stringify(guest)}`);
    }
  }
});

test("a booking outlives its package and its model in the catalog", async () => {
  // A publish can drop a package or take a model off sale while bookings of them stand, and the guest has still paid.
  const now = Date.now();
  const rate = await seedRateClass(worker.db);
  const retired = await seedModel(worker.db, {
    rate_class_id: rate.id,
    active: 0,
    texts: textsOf(FIRST.modelNames, { summary: "A summary", description: "A description" }),
  });
  const stay = { ...first, modelId: retired.id, packageId: "package-gone-from-the-catalog" };

  const hold = await book(stay, holdRow(now + 12 * MINUTE_MS));
  const confirmed = await book(stay, laterRows(stay, now).CONFIRMED);
  for (const locale of LOCALES) {
    const view = await page(locale, hold.id);
    assertName(view.text, stay.modelNames, locale, `${view.path} model`);
    assert.match(view.text, yen(stay.depositJpy), `${view.path}: no deposit`);
    assertCardForm(view, stay);

    const paid = await page(locale, confirmed.id);
    assertName(paid.text, stay.modelNames, locale, `${paid.path} model`);
    assert.ok(paid.text.includes(confirmed.ref), `${paid.path}: no ref`);
  }
});

test("a staff block has no checkout page", async () => {
  // A block is a CONFIRMED row of the sheet's, with no guest of ours and no price or deposit to show.
  const web = await book(first, laterRows(first, Date.now()).CONFIRMED);
  const block = await book(first, {
    source: "block",
    status: "CONFIRMED",
    package_id: null,
    price_jpy: null,
    deposit_jpy: null,
    catalog_version: null,
    locale: null,
    external_ref: "ota-sentinel-ref",
    external_channel: "ota-sentinel-channel",
  });
  for (const locale of LOCALES) {
    await page(locale, web.id);
    await assertNotFound(`/${locale}/checkout/${block.id}`);
  }
});
