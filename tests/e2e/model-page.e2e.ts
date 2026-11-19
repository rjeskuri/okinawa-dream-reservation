// The model page and the booking form, through the built Worker, over catalogs published with replaceCatalog. Expected
// prices and deposits are read off the catalog object each test published, and every number in the two catalogs is
// unique, so a price of the wrong class or a stale one shows. Posts use the fields the page's own form renders, so where
// the form carries the model is the page's choice, and the name of the error's query param is too: an error is any param
// outside the search. Facts are tied together by block, so the wording stays free. /{locale}/checkout/{id} is task #29's
// and is never followed. The Worker reads the real clock, so dates are computed from today in JST.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { addDaysToDate, epochToJst, formatHHmm, jstToday, parseHHmm } from "../../src/lib/time.ts";
import type {
  Catalog,
  LicenseClass,
  LocalizedTexts,
  Model,
  Package,
  Price,
  ShopConfig,
  Vehicle,
  VehicleType,
  VehicleTypeId,
} from "../../src/lib/types.ts";
import { blocksOf, mainOf, tagsIn, visibleText, withoutCode, type Tag } from "../helpers/html.ts";
import { insertRow, seedBooking, type BookingRow } from "../helpers/seed.ts";
import { startWorker, type TestWorker } from "../helpers/worker.ts";

const base = "http://localhost/";
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEARCH_PARAMS = ["date", "time", "package", "type", "cc", "class"];
const FORM_TYPE = "application/x-www-form-urlencoded";
/** What a browser sends with a form posted from the site. */
const SAME_SITE = { "Content-Type": FORM_TYPE, Origin: "http://localhost" };
const PAYLOAD = `"><script>alert(1)</script>`;

let worker: TestWorker;

before(async () => {
  worker = await startWorker();
});

after(async () => {
  await worker?.stop();
});

beforeEach(async () => {
  await worker.db.prepare("DELETE FROM bookings").run();
});

// The catalogs.

const SUFFIX: Record<Locale, string> = { ja: "日本語", en: "English", "zh-cn": "中文", ko: "한국어" };

/** Differs by locale, so one locale's text standing in for the rest shows. */
function names(en: string): LocalizedTexts<{ name: string }> {
  return {
    ja: { name: `${en} 日本語` },
    en: { name: en },
    "zh-cn": { name: `${en} 中文` },
    ko: { name: `${en} 한국어` },
  };
}

function modelTexts(en: string): Model["texts"] {
  const texts = (locale: Locale) => ({
    name: `${en} ${SUFFIX[locale]}`,
    summary: `${en} summary ${SUFFIX[locale]}`,
    description: `${en} description ${SUFFIX[locale]}`,
  });
  return { ja: texts("ja"), en: texts("en"), "zh-cn": texts("zh-cn"), ko: texts("ko") };
}

function dayPackage(id: string, days: number, sort: number, name: string): Package {
  return { id, days, hours: null, sort, texts: names(name) };
}

function hoursPackage(id: string, hours: number, sort: number, name: string): Package {
  return { id, days: null, hours, sort, texts: names(name) };
}

function model(
  id: string,
  typeId: VehicleTypeId,
  engineCc: number,
  licenseClass: LicenseClass,
  rateClassId: string,
  sort: number,
  name: string,
  extra: Partial<Model> = {},
): Model {
  return {
    id,
    typeId,
    engineCc,
    licenseClass,
    sort,
    active: true,
    rateClassId,
    brand: "Test",
    seats: null,
    texts: modelTexts(name),
    photos: [],
    ...extra,
  };
}

function vehicle(plate: string, modelId: string, status: Vehicle["status"] = "active"): Vehicle {
  return { plate, modelId, status, odometerKm: null, baseUsageDays: 0 };
}

function vehicleTypes(scooter: number, motorcycle: number, car: number): VehicleType[] {
  return [
    { id: "scooter", depositJpy: scooter, sort: 1, texts: names("Scooter") },
    { id: "motorcycle", depositJpy: motorcycle, sort: 2, texts: names("Motorcycle") },
    { id: "car", depositJpy: car, sort: 3, texts: names("Car") },
  ];
}

function priceList(rateClassId: string, prices: Record<string, number>): Price[] {
  return Object.entries(prices).map(([packageId, priceJpy]) => ({ rateClassId, packageId, priceJpy, advancePriceJpy: null }));
}

const CONFIG: ShopConfig = {
  shopOpen: "09:00",
  shopClose: "18:00",
  slotMinutes: 30,
  turnaroundMinutes: 60,
  holdMinutes: 12,
  minLeadHours: 24,
  maxDaysAhead: 180,
  photoMaxMb: 5,
};

// Ids run against sort, so listing by id shows.
const VINO = model("m-z-vino", "scooter", 49, "moped", "r-50cc", 1, "Vino");
const PCX = model("m-a-pcx", "motorcycle", 125, "small", "r-125cc", 2, "PCX", {
  photos: ["pcx-side.jpg", "pcx-unsynced.jpg", "pcx-front.jpg"],
});
const NOTE = model("m-k-note", "car", 1300, "car", "r-k-car", 3, "Note", { seats: 5 });
const GONE = model("m-gone", "scooter", 110, "small", "r-50cc", 4, "Gone", { active: false });

const MODELS = [VINO, PCX, NOTE, GONE];

const VEHICLES = [
  vehicle("vino-1", VINO.id),
  vehicle("vino-2", VINO.id),
  vehicle("vino-3", VINO.id),
  vehicle("vino-4", VINO.id),
  vehicle("vino-5", VINO.id, "maintenance"),
  vehicle("vino-6", VINO.id, "retired"),
  vehicle("pcx-1", PCX.id),
  vehicle("pcx-2", PCX.id),
  vehicle("pcx-3", PCX.id, "maintenance"),
  vehicle("note-1", NOTE.id),
  vehicle("note-2", NOTE.id),
  // An inactive model keeps a free active bike, so the model's flag decides, not its fleet.
  vehicle("gone-1", GONE.id),
];

const PACKAGES = [
  hoursPackage("p-b-6h", 6, 1, "Six hours"),
  dayPackage("p-z-1d", 1, 2, "One day"),
  dayPackage("p-a-3d", 3, 3, "Three days"),
  dayPackage("p-m-7d", 7, 4, "Full week"),
  dayPackage("p-car-only", 4, 5, "Car package"),
];

const PRICES = [
  ...priceList("r-50cc", { "p-b-6h": 1870, "p-z-1d": 2410, "p-a-3d": 6130, "p-m-7d": 12970 }),
  ...priceList("r-125cc", { "p-b-6h": 2590, "p-z-1d": 3260, "p-a-3d": 8470, "p-m-7d": 17330 }),
  ...priceList("r-k-car", { "p-z-1d": 6720, "p-a-3d": 18650, "p-m-7d": 38140, "p-car-only": 9210 }),
];

/**
 * Hours packages first in sort order, stored out of it, with three classes that start differently when no package is
 * chosen: on a three-day package past a four-hour one, on the one-day package past a 24-hour one, and, with only hours
 * packages priced, on the first of those. Other hours and slots than CONFIG's, so a fixed slot list shows.
 */
function hoursFirst(): Catalog {
  return catalogWith({
    config: { shopOpen: "08:30", shopClose: "17:00", slotMinutes: 45 },
    packages: [
      dayPackage("p-x-1d", 1, 4, "Same day"),
      hoursPackage("p-e-2h", 2, 5, "Two hours"),
      hoursPackage("p-c-24h", 24, 1, "Day and night"),
      dayPackage("p-w-7d", 7, 6, "Long week"),
      hoursPackage("p-d-4h", 4, 2, "Four hours"),
      dayPackage("p-y-3d", 3, 3, "Long weekend"),
    ],
    prices: [
      ...priceList("r-50cc", { "p-d-4h": 1490, "p-y-3d": 5870, "p-x-1d": 2230 }),
      ...priceList("r-125cc", { "p-c-24h": 4390, "p-x-1d": 3050, "p-e-2h": 1630, "p-w-7d": 16420 }),
      ...priceList("r-k-car", { "p-e-2h": 3370, "p-d-4h": 5190 }),
    ],
  });
}

/** Everything a page or a hold reads, with `overrides` on top. */
function catalogWith({
  config,
  ...overrides
}: Partial<Omit<Catalog, "config">> & { config?: Partial<ShopConfig> } = {}): Catalog {
  return {
    config: { ...CONFIG, ...config },
    vehicleTypes: vehicleTypes(3100, 5300, 10700),
    rateClasses: [
      { id: "r-50cc", grp: "bike", sort: 1, extensionPerHourJpy: 500, texts: names("50cc") },
      { id: "r-125cc", grp: "bike", sort: 2, extensionPerHourJpy: 700, texts: names("125cc") },
      { id: "r-k-car", grp: "car", sort: 3, extensionPerHourJpy: 900, texts: names("K-Car") },
    ],
    models: MODELS,
    vehicles: VEHICLES,
    packages: PACKAGES,
    prices: PRICES,
    options: [],
    cancellationTiers: [{ minDaysBefore: 0, refundPercent: 0 }],
    closedDates: [],
    ...overrides,
  };
}

/** A later publish: other hours, deposits, prices and packages, with nothing kept from the first. */
function repriced(): Catalog {
  return catalogWith({
    config: {
      shopOpen: "08:30",
      shopClose: "17:00",
      slotMinutes: 45,
      turnaroundMinutes: 30,
      holdMinutes: 20,
    },
    vehicleTypes: vehicleTypes(3700, 6900, 12500),
    packages: [
      dayPackage("p-week", 7, 1, "Week ride"),
      dayPackage("p-2d", 2, 2, "Weekend"),
      dayPackage("p-a-14d", 14, 3, "Fortnight"),
    ],
    prices: [
      ...priceList("r-50cc", { "p-week": 11930, "p-2d": 4740, "p-a-14d": 20510 }),
      ...priceList("r-125cc", { "p-week": 15860, "p-2d": 6290, "p-a-14d": 27370 }),
      ...priceList("r-k-car", { "p-week": 33420, "p-2d": 13580, "p-a-14d": 59640 }),
    ],
  });
}

async function publish(catalog: Catalog): Promise<number> {
  const { version } = await replaceCatalog(worker.db, catalog, { now: Date.now(), source: "sheet" });
  return version;
}

/** The packages the model has a price for, in sort order, with that price. */
function pricedPackages(catalog: Catalog, target: Model): { pkg: Package; priceJpy: number }[] {
  return [...catalog.packages]
    .sort((a, b) => a.sort - b.sort)
    .flatMap((pkg) => {
      const price = catalog.prices.find(
        ({ rateClassId, packageId }) => rateClassId === target.rateClassId && packageId === pkg.id,
      );
      return price === undefined ? [] : [{ pkg, priceJpy: price.priceJpy }];
    });
}

function priceOf(catalog: Catalog, target: Model, packageId: string): number {
  const found = pricedPackages(catalog, target).find(({ pkg }) => pkg.id === packageId);
  if (found === undefined) throw new Error(`no price of ${packageId} for ${target.id}`);
  return found.priceJpy;
}

function depositOf(catalog: Catalog, target: Model): number {
  const type = catalog.vehicleTypes.find(({ id }) => id === target.typeId);
  if (type === undefined) throw new Error(`no type ${target.typeId}`);
  return type.depositJpy;
}

/**
 * When a rental of the package from `date` and `time` returns, without the code under test: closing time on the last day
 * of a day package, or `hours` after the pickup for an hours package (#50).
 */
function returnOf(catalog: Catalog, packageId: string, date: string, time: string): number {
  const pkg = catalog.packages.find(({ id }) => id === packageId);
  if (pkg === undefined) throw new Error(`no package ${packageId}`);
  if (pkg.hours !== null) return jstInstant(date, time) + pkg.hours * HOUR_MS;
  return jstInstant(addDaysToDate(date, pkg.days - 1), catalog.config.shopClose);
}

// Reading pages.

function today(): string {
  return jstToday(Date.now());
}

function inDays(days: number): string {
  return addDaysToDate(today(), days);
}

/** A JST wall clock as an instant, without the code under test. */
function jstInstant(date: string, time: string): number {
  return Date.parse(`${date}T${time.padStart(5, "0")}:00+09:00`);
}

/**
 * Runs `check` with the current time, again if it fails and the JST date of now or of now + `leadHours` has changed since,
 * because the Worker and this test then read different days.
 */
async function steady(leadHours: number, check: (now: number) => Promise<void>): Promise<void> {
  const dates = (at: number) => `${jstToday(at)} ${jstToday(at + leadHours * HOUR_MS)}`;
  for (;;) {
    const now = Date.now();
    try {
      await check(now);
      return;
    } catch (error) {
      if (dates(Date.now()) === dates(now)) throw error;
    }
  }
}

function modelPath(locale: string, id: string): string {
  return `/${locale}/rentals/${id}`;
}

async function pageHtml(path: string, target: TestWorker = worker): Promise<string> {
  const res = await target.fetch(path, { redirect: "manual" });
  const html = await res.text();
  assert.equal(res.status, 200, path);
  return html;
}

async function mainText(path: string): Promise<string> {
  return visibleText(mainOf(await pageHtml(path), path));
}

async function statusOf(path: string, init: RequestInit = {}, target: TestWorker = worker): Promise<number> {
  const res = await target.fetch(path, { redirect: "manual", ...init });
  await res.text();
  return res.status;
}

/** An amount as a page may write it: 12970, 12,970, ¥12,970 or 12,970円, but not 112,970 or 12,9701. */
function yen(value: number): RegExp {
  const digits = value.toLocaleString("en-US").replace(/,/g, "[,.\\s]?");
  return new RegExp(`(?<![\\d.,])${digits}(?!\\d)`);
}

/** An engine size: `cc(125)` matches 125cc and 125 cc, but not 1125cc. */
function cc(size: number): RegExp {
  const digits = size.toLocaleString("en-US").replace(/,/g, ",?");
  return new RegExp(`(?<![\\d.,])${digits}\\s*(?:cc|cm3|ml|毫升|시시)`, "i");
}

/** Text that can only be this locale's, so one locale's sentences cannot stand in for another's. */
const script: Record<Locale, { must: RegExp; mustNot: RegExp }> = {
  ja: { must: /\p{Script=Hiragana}|\p{Script=Katakana}/u, mustNot: /\p{Script=Hangul}/u },
  en: { must: /[A-Za-z]{3}/, mustNot: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  "zh-cn": { must: /\p{Script=Han}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  ko: { must: /\p{Script=Hangul}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}/u },
};

function assertLocaleText(text: string, locale: Locale, label: string): void {
  assert.match(text, script[locale].must, `${label}: no text in the locale's script: ${text}`);
  assert.doesNotMatch(text, script[locale].mustNot, `${label}: text from another locale: ${text}`);
}

// The booking form.

type BookingForm = { html: string; action: string; hidden: [string, string][] };
type Search = { date?: string; time?: string; package?: string };

/** The one form on the page that posts to book, with what it sends besides the fields a guest fills in. */
function bookingFormIn(html: string, locale: Locale, label: string): BookingForm {
  const page = new URL(`/${locale}/`, base);
  const forms = [...withoutCode(html).matchAll(/<form\b[\s\S]*?<\/form\s*>/gi)].map(([form]) => form);
  const found = forms.filter((form) => {
    const action = tagsIn(form)[0]?.attributes.action;
    if (action === undefined) return false;
    const target = new URL(action, page);
    return target.origin === page.origin && target.pathname.replace(/\/$/, "") === `/${locale}/book`;
  });
  assert.equal(found.length, 1, `${label}: forms to /${locale}/book`);
  const form = found[0] as string;
  const tags = tagsIn(form);
  assert.equal(tags[0]?.attributes.method?.toLowerCase(), "post", `${label}: the form's method`);
  const target = new URL(tags[0]?.attributes.action as string, page);
  const hidden = tags
    .filter(
      ({ name, attributes }) =>
        name === "input" &&
        attributes.type === "hidden" &&
        attributes.name !== undefined &&
        !("disabled" in attributes),
    )
    .map(({ attributes }): [string, string] => [attributes.name as string, attributes.value ?? ""]);
  return { html: form, action: target.pathname + target.search, hidden };
}

async function loadForm(locale: Locale, modelId: string, query = ""): Promise<BookingForm> {
  const path = modelPath(locale, modelId) + query;
  return bookingFormIn(await pageHtml(path), locale, path);
}

/** The form's body, with `search` in the guest's fields and `extra` on top. A field left undefined is not sent. */
function formBody(form: BookingForm, search: Search, extra: Record<string, string> = {}): string {
  const body = new URLSearchParams();
  for (const [name, value] of form.hidden) {
    if (!["date", "time", "package"].includes(name)) body.append(name, value);
  }
  for (const [name, value] of Object.entries({ ...search, ...extra })) {
    if (value !== undefined) body.set(name, value);
  }
  return body.toString();
}

function post(action: string, body: string, target: TestWorker = worker): Promise<Response> {
  return target.fetch(action, { method: "POST", headers: SAME_SITE, body, redirect: "manual" });
}

function submit(form: BookingForm, search: Search, extra: Record<string, string> = {}): Promise<Response> {
  return post(form.action, formBody(form, search, extra));
}

/** The same post for a model the form did not name, wherever the form carries it. */
function retargeted(form: BookingForm, from: string, to: string, search: Search): { action: string; body: string } {
  const named = form.hidden.some(([, value]) => value === from) || form.action.includes(from);
  assert.ok(named, `the form does not carry ${from}`);
  const hidden = form.hidden.map(([name, value]): [string, string] => [name, value === from ? to : value]);
  const action = form.action.replaceAll(from, encodeURIComponent(to));
  return { action, body: formBody({ ...form, hidden, action }, search) };
}

function choices(form: string, name: string): Tag[] {
  const tags = tagsIn(form);
  const select = tags.find((tag) => tag.name === "select" && tag.attributes.name === name);
  if (select) {
    const body = form.slice(select.index, form.indexOf("</select", select.index));
    return tagsIn(body).filter((tag) => tag.name === "option");
  }
  return tags.filter(
    ({ name: tag, attributes }) => tag === "input" && attributes.type === "radio" && attributes.name === name,
  );
}

/** The non-empty values the form offers for `name`, as select options or radio buttons. */
function offered(form: string, name: string): string[] {
  return choices(form, name)
    .map((tag) => tag.attributes.value)
    .filter((value): value is string => value !== undefined && value !== "");
}

/** What a guest who leaves `name` alone submits: the last selected or checked choice, else a select's first option. */
function defaultChoice(form: string, name: string): string | undefined {
  const all = choices(form, name);
  const marked = all.filter(({ attributes }) => "selected" in attributes || "checked" in attributes).at(-1);
  return (marked ?? all.find((tag) => tag.name === "option"))?.attributes.value;
}

function datePickerOf(form: string, label: string): { picker: Tag; input: Tag } {
  const tags = tagsIn(form);
  const picker = tags.find(({ name }) => name === "date-picker");
  assert.ok(picker, `${label}: the form has no DatePicker`);
  const input = tags.find(
    ({ name, attributes, index }) =>
      name === "input" && attributes.type === "date" && attributes.name === "date" && index > picker.index,
  );
  assert.ok(input, `${label}: the DatePicker has no date input`);
  return { picker, input };
}

/** The pickup times of a config: every slot from opening to one slot before closing, as task #20 defines them. */
function slotsOf({ shopOpen, shopClose, slotMinutes }: ShopConfig): string[] {
  const slots: string[] = [];
  for (let at = parseHHmm(shopOpen); at <= parseHHmm(shopClose) - slotMinutes; at += slotMinutes) {
    slots.push(formatHHmm(at));
  }
  return slots;
}

function queryOf(search: Search): string {
  return `?${new URLSearchParams(search as Record<string, string>).toString()}`;
}

const DAY_MINUTES = 24 * 60;

/**
 * The pickups a package can start from, without the code under test: every slot for a day package, and for an hours
 * package the slots it is back from between opening and closing, both included, on whichever day it returns (owner,
 * 2026-11-15).
 */
function slotsFor(config: ShopConfig, pkg: Package): string[] {
  const { hours } = pkg;
  if (hours === null) return slotsOf(config);
  const [open, close] = [parseHHmm(config.shopOpen), parseHHmm(config.shopClose)];
  return slotsOf(config).filter((slot) => {
    const back = (parseHHmm(slot) + hours * 60) % DAY_MINUTES;
    return back >= open && back <= close;
  });
}

/**
 * The `package-days` the date picker gets for a package, without the code under test: a day package's days, and for an
 * hours package the calendar days a rental of it touches from a pickup at opening, so 1 for 2 to 6 hours and 2 for 24.
 */
function daysFor(config: ShopConfig, pkg: Package): number {
  if (pkg.days !== null) return pkg.days;
  return Math.floor((parseHHmm(config.shopOpen) + pkg.hours * 60) / DAY_MINUTES) + 1;
}

/**
 * The package the form starts on when the query names no bookable one, without the code under test: the one the listing
 * prices the model's card on, its class's first priced day package in sort order, or the first priced package when the
 * class has no priced day package (ruling on #50's review).
 */
function startingPackage(catalog: Catalog, target: Model): Package {
  const priced = pricedPackages(catalog, target).map(({ pkg }) => pkg);
  const start = priced.find(({ days }) => days !== null) ?? priced[0];
  if (start === undefined) throw new Error(`no priced package for ${target.id}`);
  return start;
}

/**
 * That the form starts on `pkg`: it is the package a guest who leaves the select alone submits, the date picker shows
 * its return, the time select offers its pickups and no others, and each package option carries its own pickups for
 * the script that swaps them in.
 */
function assertStartsOn(form: string, catalog: Catalog, pkg: Package, label: string): void {
  assert.equal(defaultChoice(form, "package"), pkg.id, `${label}: the package the form starts on`);
  assert.deepEqual(offered(form, "time"), slotsFor(catalog.config, pkg), `${label}: time values for ${pkg.id}`);
  assert.equal(
    datePickerOf(form, label).picker.attributes["package-days"],
    String(daysFor(catalog.config, pkg)),
    `${label}: package-days for ${pkg.id}`,
  );
  for (const option of choices(form, "package")) {
    const own = catalog.packages.find(({ id }) => id === option.attributes.value);
    assert.ok(own, `${label}: an option for no package: ${option.attributes.value}`);
    const slots = (option.attributes["data-slots"] ?? "").split(/\s+/).filter((slot) => slot !== "");
    assert.deepEqual(slots, slotsFor(catalog.config, own), `${label}: data-slots of ${own.id}`);
  }
}

// Reading the answer to a post.

function redirectOf(res: Response, label: string): URL {
  const location = res.headers.get("location");
  assert.ok(location, `${label}: no Location, status ${res.status}`);
  return new URL(location, base);
}

function backAtModel(res: Response, locale: Locale, modelId: string, label: string): URL {
  assert.equal(res.status, 303, `${label}: status`);
  const target = redirectOf(res, label);
  assert.equal(target.origin, new URL(base).origin, `${label}: origin of ${target.href}`);
  assert.equal(target.pathname.replace(/\/$/, ""), modelPath(locale, modelId), `${label}: where it goes back to`);
  return target;
}

function assertCode(target: URL, code: string, label: string): void {
  assert.ok([...target.searchParams.values()].includes(code), `${label}: no ${code} in ${target.search}`);
}

function assertSearchCarried(target: URL, search: Search, fields: (keyof Search)[], label: string): void {
  for (const field of fields) {
    assert.equal(target.searchParams.get(field), search[field], `${label}: ${field} in ${target.search}`);
  }
}

function errorParams(target: URL): string[] {
  return [...target.searchParams.keys()].filter((name) => !SEARCH_PARAMS.includes(name));
}

/** The text in `shown` that `plain` does not have, by cutting what the two share at each end. */
function insertedText(plain: string, shown: string): string {
  let start = 0;
  while (start < plain.length && plain[start] === shown[start]) start += 1;
  let end = 0;
  while (end < plain.length - start && plain.at(-1 - end) === shown.at(-1 - end)) end += 1;
  return shown.slice(start, shown.length - end).trim();
}

/** The message a redirect back puts on the page: what the same search shows with the error and does not without it. */
async function shownError(target: URL, label: string): Promise<string> {
  const params = errorParams(target);
  assert.ok(params.length > 0, `${label}: no error in ${target.search}`);
  const plain = new URL(target);
  for (const name of params) plain.searchParams.delete(name);
  const message = insertedText(
    await mainText(plain.pathname + plain.search),
    await mainText(target.pathname + target.search),
  );
  assert.notEqual(message, "", `${label}: ${target.search} shows nothing the same search does not show without it`);
  return message;
}

// The database.

async function bookings(): Promise<BookingRow[]> {
  const { results } = await worker.db.prepare("SELECT * FROM bookings ORDER BY start_at, id").all<BookingRow>();
  return results;
}

async function holds(): Promise<BookingRow[]> {
  return (await bookings()).filter(({ status }) => status === "ON_HOLD");
}

async function bookingById(id: string): Promise<BookingRow | null> {
  return worker.db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
}

/** A rental that blocks each plate over the whole of `date` and the days around it. */
async function occupy(plates: string[], modelId: string, date: string): Promise<void> {
  for (const plate of plates) {
    await seedBooking(worker.db, {
      vehicle_plate: plate,
      model_id: modelId,
      start_at: jstInstant(addDaysToDate(date, -1), "09:00"),
      end_at: jstInstant(addDaysToDate(date, 8), "17:00"),
    });
  }
}

function checkoutId(target: URL, locale: Locale): string | null {
  const prefix = `/${locale}/checkout/`;
  return target.pathname.startsWith(prefix) ? target.pathname.slice(prefix.length).replace(/\/$/, "") : null;
}

// A request a guest cannot be helped with: no hold, nothing kept, and the answer stays on the site.

async function assertRefused(res: Response, label: string, target: TestWorker = worker): Promise<void> {
  await res.text();
  assert.ok(res.status >= 300 && res.status < 500, `${label}: status ${res.status}`);
  assert.equal(res.headers.get("set-cookie"), null, `${label}: a header got through`);
  const location = res.headers.get("location");
  if (location === null) return;
  const next = new URL(location, base);
  assert.equal(next.origin, new URL(base).origin, `${label}: goes off the site to ${next.href}`);
  assert.doesNotMatch(next.pathname, /\/checkout\//, `${label}: goes on to checkout`);
  const page = await target.fetch(next.pathname + next.search, { redirect: "manual" });
  const html = await page.text();
  assert.ok([200, 404].includes(page.status), `${label}: ${next.href} answers ${page.status}`);
  assert.ok(!html.includes(PAYLOAD), `${label}: ${next.href} echoes the payload`);
}

// The price table and the rest of the page.

/** Each locale's page for each active model: one row per priced package in sort order, and only this model's numbers. */
async function assertPriceTables(catalog: Catalog): Promise<void> {
  for (const locale of LOCALES) {
    for (const target of catalog.models.filter(({ active }) => active)) {
      const label = `${locale} ${target.id}`;
      const main = mainOf(await pageHtml(modelPath(locale, target.id)), label);
      const blocks = blocksOf(main);
      const rows = pricedPackages(catalog, target);
      const rowNames = rows.map(({ pkg }) => pkg.texts[locale].name);

      let previous = -1;
      for (const { pkg, priceJpy } of rows) {
        const name = pkg.texts[locale].name;
        const others = rowNames.filter((other) => other !== name);
        // Rows of their own, so a list of package names beside a list of prices, or a select of the names, does not count.
        const place = blocks.findIndex(
          (block) =>
            block.includes(name) && yen(priceJpy).test(block) && !others.some((other) => block.includes(other)),
        );
        assert.notEqual(place, -1, `${label}: no row with ${name} at ${priceJpy} in\n${blocks.join("\n")}`);
        assert.ok(place > previous, `${label}: ${name} is out of order in\n${blocks.join("\n")}`);
        previous = place;
      }

      const text = visibleText(main);
      assert.match(text, yen(depositOf(catalog, target)), `${label}: the deposit`);
      for (const { id, depositJpy } of catalog.vehicleTypes) {
        if (id !== target.typeId) assert.doesNotMatch(text, yen(depositJpy), `${label}: the deposit of ${id}`);
      }
      for (const { rateClassId, packageId, priceJpy } of catalog.prices) {
        if (rateClassId !== target.rateClassId) {
          assert.doesNotMatch(text, yen(priceJpy), `${label}: the price of ${rateClassId} for ${packageId}`);
        }
      }
    }
  }
}

test("the model page lists every package price and the deposit", async () => {
  const first = catalogWith();
  await publish(first);
  await assertPriceTables(first);

  // Every number follows the next publish, and none of the old ones stay.
  const second = repriced();
  await publish(second);
  await assertPriceTables(second);
  const stale = [
    ...first.prices.map(({ priceJpy }) => priceJpy),
    ...first.vehicleTypes.map(({ depositJpy }) => depositJpy),
  ];
  for (const locale of LOCALES) {
    for (const target of [VINO, PCX, NOTE]) {
      const text = await mainText(modelPath(locale, target.id));
      for (const value of stale) assert.doesNotMatch(text, yen(value), `${locale} ${target.id}: the old ${value}`);
    }
  }
});

test("the model page shows the model's details and links the license classes", async () => {
  const copied = [
    { name: "pcx-side.jpg", key: `photos/${"a".repeat(32)}.jpg` },
    { name: "pcx-front.jpg", key: `photos/${"b".repeat(32)}.webp` },
  ];
  for (const { name, key } of copied) {
    const row = {
      name,
      drive_file_id: `drive-${name}`,
      md5: key.slice(7, 39),
      r2_key: key,
      content_type: "image/jpeg",
      bytes: 10,
      copied_at: Date.now(),
    };
    await insertRow(worker.db, "photos", row, "name");
  }
  const catalog = catalogWith();
  await publish(catalog);

  for (const locale of LOCALES) {
    for (const target of [VINO, PCX, NOTE]) {
      const path = modelPath(locale, target.id);
      const main = mainOf(await pageHtml(path), path);
      const text = visibleText(main);
      const { name, summary, description } = target.texts[locale];
      for (const value of [name, summary, description]) assert.ok(text.includes(value), `${path}: ${value}`);
      for (const other of [VINO, PCX, NOTE]) {
        if (other !== target) assert.ok(!text.includes(other.texts[locale].name), `${path}: ${other.id}`);
      }

      const type = catalog.vehicleTypes.find(({ id }) => id === target.typeId) as VehicleType;
      assert.ok(text.includes(type.texts[locale].name), `${path}: the type`);
      const engineCc = target.engineCc;
      assert.ok(engineCc !== null, `${target.id} has an engine`);
      assert.match(text, cc(engineCc), `${path}: the engine size`);

      const page = new URL(path, base);
      const links = tagsIn(main).flatMap(({ name: tag, attributes }) =>
        tag === "a" && attributes.href !== undefined ? [new URL(attributes.href, page)] : [],
      );
      assert.ok(
        links.some((link) => link.pathname.replace(/\/$/, "") === `/${locale}/faq` && link.hash === "#license-classes"),
        `${path}: no link to the FAQ's license classes in ${links.map(({ href }) => href).join(", ")}`,
      );

      const images = tagsIn(main).flatMap(({ name: tag, attributes }) =>
        tag === "img" && attributes.src !== undefined ? [attributes.src] : [],
      );
      const expected = target === PCX ? copied.map(({ key }) => `/media/${key}`) : [];
      assert.deepEqual(
        images.filter((src) => src.includes("/media/")),
        expected,
        `${path}: photos`,
      );
      assert.ok(!images.some((src) => src.includes("unsynced")), `${path}: a photo with no copy`);
    }
  }

  // The class is the model's own: moved to another class with all else the same, the page says something else.
  const small = new Map<Locale, string>();
  for (const locale of LOCALES) small.set(locale, await mainText(modelPath(locale, PCX.id)));
  await publish(
    catalogWith({ models: MODELS.map((row) => (row === PCX ? { ...row, licenseClass: "standard" as const } : row)) }),
  );
  for (const locale of LOCALES) {
    assert.notEqual(await mainText(modelPath(locale, PCX.id)), small.get(locale), `${locale}: the license class`);
  }
});

test("the booking form offers the published slots and every priced package", async () => {
  const configs = [
    { shopOpen: "09:00", shopClose: "18:00", slotMinutes: 30, minLeadHours: 30, maxDaysAhead: 120 },
    { shopOpen: "08:30", shopClose: "17:00", slotMinutes: 45, minLeadHours: 54, maxDaysAhead: 45 },
  ];
  for (const config of configs) {
    await steady(config.minLeadHours, async (now) => {
      const date = (days: number) => addDaysToDate(jstToday(now), days);
      const catalog = catalogWith({ config, closedDates: [date(9), date(33)] });
      await publish(catalog);

      for (const locale of LOCALES) {
        for (const target of [VINO, PCX, NOTE]) {
          const label = `${locale} ${target.id}`;
          const form = await loadForm(locale, target.id);
          const tags = tagsIn(form.html);

          // A guest sees these three and nothing else: no personal data is collected here.
          const fields = tags.filter(
            ({ name, attributes }) =>
              ["input", "select", "textarea"].includes(name) &&
              attributes.name !== undefined &&
              attributes.type !== "hidden" &&
              !("disabled" in attributes),
          );
          assert.deepEqual(
            [...new Set(fields.map(({ attributes }) => attributes.name))].sort(),
            ["date", "package", "time"],
            `${label}: fields`,
          );
          assert.ok(
            tags.some(
              ({ name, attributes }) =>
                (name === "button" && (attributes.type ?? "submit").toLowerCase() === "submit") ||
                (name === "input" && attributes.type?.toLowerCase() === "submit"),
            ),
            `${label}: no submit control`,
          );

          // With no package chosen the form starts on the class's first priced day package, which every slot fits.
          const start = startingPackage(catalog, target);
          assert.deepEqual(offered(form.html, "time"), slotsFor(catalog.config, start), `${label}: time values`);
          // A hold refuses a package with no price, so it is no choice. Hours packages are bookable (#50), so they are.
          const bookable = pricedPackages(catalog, target);
          assert.deepEqual(
            offered(form.html, "package"),
            bookable.map(({ pkg }) => pkg.id),
            `${label}: package values`,
          );

          const { picker, input } = datePickerOf(form.html, label);
          assert.equal(input.attributes.min, epochToJst(now + config.minLeadHours * HOUR_MS).date, `${label}: min`);
          assert.equal(input.attributes.max, date(config.maxDaysAhead), `${label}: max`);
          const { closedDates } = JSON.parse(picker.attributes["data-config"] ?? "{}") as { closedDates?: string[] };
          assert.deepEqual(closedDates, catalog.closedDates, `${label}: closed dates`);
        }
      }

      // The carried search is what the form starts from, whichever of the choices it names.
      const slots = slotsOf(catalog.config);
      for (const [index, target] of [VINO, PCX, NOTE].entries()) {
        const bookable = pricedPackages(catalog, target);
        const search = {
          date: date(11 + index),
          time: slots[index + 2] as string,
          package: bookable[index]?.pkg.id as string,
        };
        const label = `${target.id} ${queryOf(search)}`;
        const form = await loadForm("en", target.id, queryOf(search));
        assert.equal(datePickerOf(form.html, label).input.attributes.value, search.date, `${label}: date`);
        assert.equal(defaultChoice(form.html, "time"), search.time, `${label}: time`);
        assert.equal(defaultChoice(form.html, "package"), search.package, `${label}: package`);
      }
    });
  }
});

// The package the form starts on (#50 review): the time select and the date picker follow it, so a guest who leaves the
// package alone can book the pickup the listing found free.

test("with no bookable package in the query the form starts on the class's default package", async () => {
  for (const catalog of [catalogWith(), hoursFirst()]) {
    await publish(catalog);
    for (const [index, locale] of LOCALES.entries()) {
      for (const target of [VINO, PCX, NOTE]) {
        const start = startingPackage(catalog, target);
        const priced = new Set(pricedPackages(catalog, target).map(({ pkg }) => pkg.id));
        const unpriced = [...catalog.packages].sort((a, b) => a.sort - b.sort).find(({ id }) => !priced.has(id));
        assert.ok(unpriced, `${target.id} has no unpriced package to name`);
        // What the listing's card links with, which carries no package: the date, the time and the type.
        const listed = new URLSearchParams({ date: inDays(20 + index), time: slotsOf(catalog.config)[0] as string });
        listed.set("type", target.typeId);
        const queries = ["", "?package=", "?package=p-nope", `?package=${unpriced.id}`, `?${listed}`];
        for (const query of queries) {
          const label = `${locale} ${target.id} ${query || "no query"}`;
          assertStartsOn((await loadForm(locale, target.id, query)).html, catalog, start, label);
        }
      }
    }
  }
});

test("a package the query names starts the form, and an hours package offers only pickups back by close", async () => {
  for (const catalog of [catalogWith(), hoursFirst()]) {
    await publish(catalog);
    const close = parseHHmm(catalog.config.shopClose);
    for (const [index, target] of [VINO, PCX, NOTE].entries()) {
      for (const [n, { pkg }] of pricedPackages(catalog, target).entries()) {
        const locale = LOCALES[(index + n) % LOCALES.length] as Locale;
        const label = `${locale} ${target.id} ?package=${pkg.id}`;
        const form = (await loadForm(locale, target.id, `?package=${pkg.id}`)).html;
        assertStartsOn(form, catalog, pkg, label);
        const { hours } = pkg;
        if (hours === null || hours >= 24) continue;

        // A pickup later than closing less the hours is not back by closing, and the fixture has some.
        const late = slotsOf(catalog.config).filter((slot) => parseHHmm(slot) > close - hours * 60);
        assert.ok(late.length > 0, `${label}: the fixture has no late slot`);
        for (const slot of late) assert.ok(!offered(form, "time").includes(slot), `${label}: offers ${slot}`);
      }
    }
  }
});

test("a guest who comes from the listing books the pickup it found on the package the form starts on", async () => {
  type Case = { locale: Locale; target: Model; days: number; time: string; named?: string; start: string };
  const groups: { catalog: Catalog; cases: Case[] }[] = [
    {
      catalog: catalogWith(),
      cases: [
        // The listing found these on the one-day package. Six hours from 15:00 or 17:30 is back after the 18:00 close.
        { locale: "en", target: VINO, days: 21, time: "15:00", start: "p-z-1d" },
        { locale: "ko", target: PCX, days: 22, time: "17:30", start: "p-z-1d" },
        { locale: "zh-cn", target: NOTE, days: 23, time: "16:30", start: "p-z-1d" },
        // Named in the query, six hours from 12:00 is back at closing, so the time stays.
        { locale: "ja", target: PCX, days: 24, time: "12:00", named: "p-b-6h", start: "p-b-6h" },
      ],
    },
    {
      catalog: hoursFirst(),
      cases: [
        // VINO's first option is four hours, back at 20:00 from 16:00. PCX's is the 24-hour package, which the listing
        // does not price its card on.
        { locale: "zh-cn", target: VINO, days: 25, time: "16:00", start: "p-y-3d" },
        { locale: "en", target: PCX, days: 26, time: "15:15", start: "p-x-1d" },
        // Only hours packages are priced: four hours from 13:00 is back at the 17:00 close.
        { locale: "ja", target: NOTE, days: 27, time: "13:00", start: "p-d-4h" },
        { locale: "ko", target: NOTE, days: 28, time: "09:15", start: "p-d-4h" },
      ],
    },
  ];

  for (const { catalog, cases } of groups) {
    const version = await publish(catalog);
    for (const { locale, target, days, time, named, start } of cases) {
      const date = inDays(days);
      const query = new URLSearchParams({ date, time, type: target.typeId });
      if (named !== undefined) query.set("package", named);
      const label = `${locale} ${target.id} ?${query}`;
      const form = await loadForm(locale, target.id, `?${query}`);

      // The carried time is one the starting package allows, so it stays selected.
      const sent = {
        date: datePickerOf(form.html, label).input.attributes.value,
        time: defaultChoice(form.html, "time"),
        package: defaultChoice(form.html, "package"),
      };
      assert.deepEqual({ date: sent.date, time: sent.time }, { date, time }, `${label}: the carried search`);

      // What a guest who changes nothing books.
      const res = await submit(form, sent);
      await res.text();
      assert.equal(res.status, 303, `${label}: status`);
      const next = redirectOf(res, label);
      const id = checkoutId(next, locale);
      assert.ok(id !== null, `${label}: Book went to ${next.pathname}${next.search}, not checkout`);
      const row = await bookingById(id);
      assert.deepEqual(
        row && { package_id: row.package_id, start_at: row.start_at, end_at: row.end_at, version: row.catalog_version },
        { package_id: start, start_at: jstInstant(date, time), end_at: returnOf(catalog, start, date, time), version },
        label,
      );
    }
  }
});

test("the model page shows availability for the carried search", async () => {
  await publish(catalogWith());
  const date = inDays(15);
  const query = queryOf({ date, time: "11:00", package: "p-a-3d" });

  const free = new Map<Locale, string>();
  const other = new Map<Locale, string>();
  for (const locale of LOCALES) {
    free.set(locale, await mainText(modelPath(locale, PCX.id) + query));
    other.set(locale, await mainText(modelPath(locale, VINO.id) + query));
  }

  await occupy(["pcx-1", "pcx-2"], PCX.id, date);

  for (const locale of LOCALES) {
    const label = `${locale} ${query}`;
    assert.notEqual(
      await mainText(modelPath(locale, PCX.id) + query),
      free.get(locale),
      `${label}: the booked-out model`,
    );
    assert.equal(await mainText(modelPath(locale, VINO.id) + query), other.get(locale), `${label}: another model`);
  }
});

// Holds.

test("a valid booking form creates a hold and redirects to checkout", async () => {
  const cases = [
    { locale: "ja", target: PCX, package: "p-z-1d", date: inDays(14), time: "09:00" },
    { locale: "en", target: VINO, package: "p-a-3d", date: inDays(45), time: "13:30" },
    { locale: "zh-cn", target: NOTE, package: "p-m-7d", date: inDays(90), time: "17:30" },
    { locale: "ko", target: PCX, package: "p-m-7d", date: inDays(3), time: "11:00" },
    // The six-hour package (#50): back six hours after the pickup, here at closing time and two hours before it.
    { locale: "en", target: VINO, package: "p-b-6h", date: inDays(46), time: "12:00" },
    { locale: "ja", target: PCX, package: "p-b-6h", date: inDays(33), time: "10:00" },
  ] as const;
  const laterCases = [
    { locale: "ko", target: VINO, package: "p-2d", date: inDays(21), time: "16:00" },
    { locale: "en", target: NOTE, package: "p-a-14d", date: inDays(60), time: "09:15" },
  ] as const;

  const run = async (catalog: Catalog, version: number, c: (typeof cases)[number] | (typeof laterCases)[number]) => {
    const label = `${c.locale} ${c.target.id} ${c.package} ${c.date} ${c.time}`;
    const form = await loadForm(c.locale, c.target.id);
    const sentAt = Date.now();
    const res = await submit(form, { date: c.date, time: c.time, package: c.package });
    await res.text();
    const answeredAt = Date.now();

    assert.equal(res.status, 303, `${label}: status`);
    const target = redirectOf(res, label);
    const id = checkoutId(target, c.locale);
    assert.ok(id !== null, `${label}: went to ${target.pathname}`);
    assert.match(id, UUID, `${label}: the id`);

    const row = await bookingById(id);
    assert.ok(row, `${label}: no booking ${id}`);
    assert.deepEqual(
      {
        status: row.status,
        source: row.source,
        model_id: row.model_id,
        package_id: row.package_id,
        start_at: row.start_at,
        end_at: row.end_at,
        price_jpy: row.price_jpy,
        deposit_jpy: row.deposit_jpy,
        locale: row.locale,
        catalog_version: row.catalog_version,
        guest_family_name: row.guest_family_name,
        guest_given_name: row.guest_given_name,
        guest_email: row.guest_email,
        guest_phone: row.guest_phone,
      },
      {
        status: "ON_HOLD",
        source: "web",
        model_id: c.target.id,
        package_id: c.package,
        start_at: jstInstant(c.date, c.time),
        end_at: returnOf(catalog, c.package, c.date, c.time),
        price_jpy: priceOf(catalog, c.target, c.package),
        deposit_jpy: depositOf(catalog, c.target),
        locale: c.locale,
        catalog_version: version,
        guest_family_name: null,
        guest_given_name: null,
        guest_email: null,
        guest_phone: null,
      },
      label,
    );
    const plates = catalog.vehicles.filter(({ modelId, status }) => modelId === c.target.id && status === "active");
    assert.ok(
      plates.some(({ plate }) => plate === row.vehicle_plate),
      `${label}: the plate ${row.vehicle_plate}`,
    );
    assert.ok(row.created_at >= sentAt && row.created_at <= answeredAt, `${label}: created_at`);
    assert.equal(row.expires_at, row.created_at + catalog.config.holdMinutes * MINUTE_MS, `${label}: expires_at`);
  };

  const catalog = catalogWith();
  const version = await publish(catalog);
  for (const c of cases) await run(catalog, version, c);
  assert.equal((await holds()).length, cases.length, "one hold per post");

  // Hours, deposits, prices and packages are the last publish's.
  const later = repriced();
  const laterVersion = await publish(later);
  for (const c of laterCases) await run(later, laterVersion, c);
});

test("the server decides the hold's id and every value the form does not choose", async () => {
  const catalog = catalogWith();
  await publish(catalog);
  const form = await loadForm("en", PCX.id);

  const earlier = inDays(16);
  const first = await submit(form, { date: earlier, time: "10:00", package: "p-z-1d" });
  await first.text();
  const firstId = checkoutId(redirectOf(first, "first"), "en") as string;

  // The same search again is a second guest, with a bike of their own.
  const second = await submit(form, { date: earlier, time: "10:00", package: "p-z-1d" });
  await second.text();
  const secondId = checkoutId(redirectOf(second, "second"), "en") as string;
  assert.notEqual(secondId, firstId);
  const [one, two] = await Promise.all([bookingById(firstId), bookingById(secondId)]);
  assert.notEqual(one?.vehicle_plate, two?.vehicle_plate, "both guests on one bike");

  // Fields a tampered post adds change nothing, and an id already in use hands over nothing.
  const date = inDays(17);
  const res = await submit(
    form,
    { date, time: "12:30", package: "p-a-3d" },
    {
      id: firstId,
      price: "1",
      price_jpy: "1",
      priceJpy: "1",
      deposit: "1",
      deposit_jpy: "1",
      depositJpy: "1",
      locale: "ko",
      status: "CONFIRMED",
      vehicle_plate: "note-1",
    },
  );
  await res.text();
  assert.equal(res.status, 303, "tampered post");
  const id = checkoutId(redirectOf(res, "tampered post"), "en");
  assert.ok(id !== null && id !== firstId && id !== secondId, `the id ${id}`);
  const row = await bookingById(id);
  assert.equal(row?.status, "ON_HOLD");
  assert.equal(row?.price_jpy, priceOf(catalog, PCX, "p-a-3d"));
  assert.equal(row?.deposit_jpy, depositOf(catalog, PCX));
  assert.equal(row?.locale, "en");
  assert.equal(row?.model_id, PCX.id);
  assert.equal((await bookingById(firstId))?.start_at, one?.start_at, "the earlier booking changed");
  assert.equal((await holds()).length, 3);
});

/** 15 posts at once for `target`, whose free bikes are `free`: two go on to checkout and the rest come back. */
async function race(locale: Locale, target: Model, search: Required<Search>, free: string[]): Promise<void> {
  const form = await loadForm(locale, target.id);
  const responses = await Promise.all(Array.from({ length: 15 }, () => submit(form, search)));
  await Promise.all(responses.map((res) => res.text()));

  const won: string[] = [];
  for (const [index, res] of responses.entries()) {
    const label = `${target.id} post ${index}`;
    assert.equal(res.status, 303, `${label}: status`);
    const id = checkoutId(redirectOf(res, label), locale);
    if (id !== null) {
      won.push(id);
    } else {
      const back = backAtModel(res, locale, target.id, label);
      assertCode(back, "SOLD_OUT", label);
      assertSearchCarried(back, search, ["date", "time", "package"], label);
    }
  }
  assert.equal(won.length, 2, `${target.id}: redirects to checkout`);

  const rows = (await holds()).filter(({ model_id, start_at }) => {
    return model_id === target.id && start_at === jstInstant(search.date, search.time);
  });
  assert.deepEqual(rows.map(({ id }) => id).sort(), [...won].sort(), `${target.id}: the holds are the two that won`);
  assert.deepEqual(rows.map(({ vehicle_plate }) => vehicle_plate).sort(), [...free].sort(), `${target.id}: bikes held`);
}

test("concurrent posts never oversell over HTTP", async () => {
  await publish(catalogWith());

  // Two active bikes and one in maintenance.
  await race("en", PCX, { date: inDays(25), time: "10:00", package: "p-z-1d" }, ["pcx-1", "pcx-2"]);

  // Six hours from 09:00 is back at 15:00 (#50), so with the 60-minute turnaround the same two bikes go again from 16:00.
  const sameDay = inDays(27);
  await race("zh-cn", PCX, { date: sameDay, time: "09:00", package: "p-b-6h" }, ["pcx-1", "pcx-2"]);
  await race("ko", PCX, { date: sameDay, time: "16:00", package: "p-z-1d" }, ["pcx-1", "pcx-2"]);

  // Four active bikes, of which a booking and a live hold take two, and an expired hold takes none.
  const date = inDays(40);
  const time = "14:30";
  const now = Date.now();
  const stay = {
    model_id: VINO.id,
    start_at: jstInstant(date, "09:00"),
    end_at: jstInstant(addDaysToDate(date, 2), "18:00"),
  };
  await seedBooking(worker.db, { ...stay, vehicle_plate: "vino-1" });
  await seedBooking(worker.db, {
    ...stay,
    vehicle_plate: "vino-2",
    status: "ON_HOLD",
    expires_at: now + 10 * MINUTE_MS,
  });
  await seedBooking(worker.db, { ...stay, vehicle_plate: "vino-3", status: "ON_HOLD", expires_at: now - MINUTE_MS });
  await race("ja", VINO, { date, time, package: "p-a-3d" }, ["vino-3", "vino-4"]);
});

/** Why each post is refused. Each locale runs these against one of the two models. */
function refusals(): { code: string; search: Required<Search>; carried: (keyof Search)[] }[] {
  const all: (keyof Search)[] = ["date", "time", "package"];
  const day = inDays(12);
  return [
    { code: "SOLD_OUT", search: { date: inDays(30), time: "10:00", package: "p-z-1d" }, carried: all },
    { code: "TOO_SOON", search: { date: today(), time: "17:30", package: "p-z-1d" }, carried: all },
    { code: "TOO_FAR", search: { date: inDays(183), time: "10:00", package: "p-z-1d" }, carried: all },
    { code: "OFF_SLOT", search: { date: day, time: "10:15", package: "p-z-1d" }, carried: all },
    { code: "OFF_SLOT", search: { date: day, time: "09:01", package: "p-a-3d" }, carried: all },
    { code: "OUTSIDE_HOURS", search: { date: day, time: "08:30", package: "p-z-1d" }, carried: all },
    { code: "OUTSIDE_HOURS", search: { date: day, time: "18:00", package: "p-a-3d" }, carried: all },
    { code: "CLOSED_PICKUP", search: { date: inDays(20), time: "10:00", package: "p-z-1d" }, carried: all },
    { code: "CLOSED_RETURN", search: { date: inDays(18), time: "10:00", package: "p-a-3d" }, carried: all },
    { code: "UNKNOWN_PACKAGE", search: { date: day, time: "10:00", package: "p-nope" }, carried: ["date", "time"] },
    // Six hours from 12:30 is back at 18:30, past closing (#50).
    { code: "RETURN_OUTSIDE_HOURS", search: { date: day, time: "12:30", package: "p-b-6h" }, carried: all },
    { code: "RETURN_OUTSIDE_HOURS", search: { date: inDays(13), time: "17:30", package: "p-b-6h" }, carried: all },
    { code: "NO_PRICE", search: { date: day, time: "10:00", package: "p-car-only" }, carried: ["date", "time"] },
  ];
}

/** A month's 31st that does not exist, inside the booking window, which a date that rolls over would turn into a real day. */
function impossibleDate(): string {
  for (let days = 5; ; days += 1) {
    const date = inDays(days);
    if (date.endsWith("-30") && addDaysToDate(date, 1).endsWith("-01")) return `${date.slice(0, 8)}31`;
  }
}

test("sold-out and invalid posts come back with an error", async () => {
  await publish(catalogWith({ closedDates: [inDays(20)] }));
  const soldOut = inDays(30);
  await occupy(["pcx-1", "pcx-2"], PCX.id, soldOut);
  await occupy(["vino-1", "vino-2", "vino-3", "vino-4"], VINO.id, soldOut);
  const seeded = (await bookings()).length;

  const messages = new Map<string, string>();
  for (const [index, locale] of LOCALES.entries()) {
    const target = [PCX, VINO][index % 2] as Model;
    const form = await loadForm(locale, target.id);
    for (const { code, search, carried } of refusals()) {
      const label = `${locale} ${target.id} ${code} ${search.date} ${search.time} ${search.package}`;
      const res = await submit(form, search);
      await res.text();

      const back = backAtModel(res, locale, target.id, label);
      assertCode(back, code, label);
      assertSearchCarried(back, search, carried, label);
      assert.equal((await bookings()).length, seeded, `${label}: wrote a booking`);

      const message = await shownError(back, label);
      assertLocaleText(message, locale, label);
      assert.ok(!message.includes(code), `${label}: the raw code on the page: ${message}`);
      messages.set(`${code} ${locale}`, message);

      // The guest comes back to the choices they made.
      if (code === "SOLD_OUT") {
        const again = bookingFormIn(await pageHtml(back.pathname + back.search), locale, label);
        assert.equal(datePickerOf(again.html, label).input.attributes.value, search.date, `${label}: date kept`);
        assert.equal(defaultChoice(again.html, "time"), search.time, `${label}: time kept`);
        assert.equal(defaultChoice(again.html, "package"), search.package, `${label}: package kept`);
      }
    }
  }

  for (const { code } of refusals()) {
    const shown = LOCALES.map((locale) => messages.get(`${code} ${locale}`));
    assert.equal(new Set(shown).size, LOCALES.length, `${code}: the same text in two locales: ${shown.join(" / ")}`);
  }
  // Which of these it was changes what the guest does next.
  for (const locale of LOCALES) {
    const shown = ["SOLD_OUT", "TOO_SOON", "CLOSED_PICKUP"].map((code) => messages.get(`${code} ${locale}`));
    assert.equal(new Set(shown).size, 3, `${locale}: one text for different errors: ${shown.join(" / ")}`);
    const hours = ["OUTSIDE_HOURS", "RETURN_OUTSIDE_HOURS", "CLOSED_RETURN"].map((code) => messages.get(`${code} ${locale}`));
    assert.equal(new Set(hours).size, 3, `${locale}: one text for different errors: ${hours.join(" / ")}`);
  }

  // Fields that are no date or time at all never reach createHold as such, and still come back in the locale.
  const day = inDays(12);
  const malformed: { label: string; search: Search }[] = [
    { label: "a day that does not exist", search: { date: impossibleDate(), time: "10:00", package: "p-z-1d" } },
    { label: "no date", search: { time: "10:00", package: "p-z-1d" } },
    { label: "an empty date", search: { date: "", time: "10:00", package: "p-z-1d" } },
    { label: "not a date", search: { date: "not-a-date", time: "10:00", package: "p-z-1d" } },
    { label: "the wrong date order", search: { date: "12-25-2031", time: "10:00", package: "p-z-1d" } },
    { label: "no time", search: { date: day, package: "p-z-1d" } },
    { label: "an empty time", search: { date: day, time: "", package: "p-z-1d" } },
    { label: "an hour that does not exist", search: { date: day, time: "25:00", package: "p-z-1d" } },
    { label: "not a time", search: { date: day, time: "noon", package: "p-z-1d" } },
    { label: "no package", search: { date: day, time: "10:00" } },
    { label: "an empty package", search: { date: day, time: "10:00", package: "" } },
  ];
  for (const [index, { label, search }] of malformed.entries()) {
    const locale = LOCALES[index % LOCALES.length] as Locale;
    const where = `${locale} ${label}`;
    const res = await submit(await loadForm(locale, PCX.id), search);
    await res.text();
    const back = backAtModel(res, locale, PCX.id, where);
    assert.equal((await bookings()).length, seeded, `${where}: wrote a booking`);
    assertLocaleText(await shownError(back, where), locale, where);
  }
});

test("hostile posts hold nothing and stay on the site", async () => {
  await publish(catalogWith());
  const form = await loadForm("en", PCX.id);
  const search = { date: inDays(12), time: "10:00", package: "p-z-1d" };

  const fields: [string, Search][] = [
    ["a header in the package", { ...search, package: "x\r\nSet-Cookie: pwned=1" }],
    ["a header in the date", { ...search, date: "x\r\nSet-Cookie: pwned=1" }],
    ["a header in the time", { ...search, time: "x\r\nSet-Cookie: pwned=1" }],
    ["markup in the package", { ...search, package: PAYLOAD }],
    ["markup in the date", { ...search, date: PAYLOAD }],
    ["markup in the time", { ...search, time: PAYLOAD }],
    ["a name every object inherits", { ...search, package: "__proto__" }],
  ];
  for (const [label, tampered] of fields) await assertRefused(await submit(form, tampered), label);

  const models = [
    "no-such-model",
    "M-A-PCX",
    "constructor",
    "__proto__",
    "//evil.example/",
    "https://evil.example/",
    "\\\\evil.example",
    "../../../evil",
    `x\r\nSet-Cookie: pwned=1`,
    PAYLOAD,
    "",
  ];
  for (const model of models) {
    const { action, body } = retargeted(form, PCX.id, model, search);
    await assertRefused(await post(action, body), `model ${JSON.stringify(model)}`);
  }

  // What a post without the form sends.
  await assertRefused(await post(`/en/book`, ""), "an empty form");
  await assertRefused(
    await worker.fetch("/en/book", { method: "POST", headers: { Origin: "http://localhost" }, redirect: "manual" }),
    "no body at all",
  );
  await assertRefused(
    await worker.fetch("/en/book", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(search),
      redirect: "manual",
    }),
    "a JSON body",
  );

  // Another site's page cannot spend the shop's bikes on a visitor's behalf.
  const crossSite = await worker.fetch(form.action, {
    method: "POST",
    headers: { "Content-Type": FORM_TYPE, Origin: "http://evil.example" },
    body: formBody(form, search),
    redirect: "manual",
  });
  await assertRefused(crossSite, "a post from another site");

  assert.deepEqual(await bookings(), [], "wrote a booking");

  // The form still works after all that.
  const res = await submit(form, search);
  await res.text();
  assert.notEqual(checkoutId(redirectOf(res, "the valid post"), "en"), null, "the valid post");
});

test("a post for a model that left the catalog holds nothing", async () => {
  await publish(catalogWith());
  const form = await loadForm("en", PCX.id);
  const search = { date: inDays(12), time: "10:00", package: "p-z-1d" };

  // A page left open across the publish that took the model off the site.
  await publish(catalogWith({ models: MODELS.map((row) => (row === PCX ? { ...row, active: false } : row)) }));
  await assertRefused(await submit(form, search), "a stale form");

  // A model that was always inactive, posted by hand, with free active bikes to hold.
  const { action, body } = retargeted(form, PCX.id, GONE.id, search);
  await assertRefused(await post(action, body), "an inactive model");
  assert.deepEqual(await bookings(), [], "wrote a booking");

  // Back on the site, the same form holds a bike.
  await publish(catalogWith());
  const res = await submit(form, search);
  await res.text();
  assert.notEqual(checkoutId(redirectOf(res, "the valid post"), "en"), null, "the valid post");
});

test("a tampered query leaves the model page standing", async () => {
  const catalog = catalogWith({ closedDates: [inDays(20)] });
  await publish(catalog);
  const day = inDays(12);

  // The name of the error param, from a real redirect.
  const res = await submit(await loadForm("en", PCX.id), { date: today(), time: "10:00", package: "p-z-1d" });
  await res.text();
  const [param] = errorParams(redirectOf(res, "the redirect"));
  assert.ok(param !== undefined, "the redirect carries no error");

  const payload = encodeURIComponent(PAYLOAD);
  const queries = [
    // The search, in every way a link can spoil it. The time helpers throw on several of these if read as they stand.
    `?date=not-a-date&time=10:00&package=p-z-1d`,
    `?date=${impossibleDate()}&time=10:00&package=p-z-1d`,
    `?date=9999-12-31&time=10:00&package=p-a-3d`,
    `?date=0000-01-01&time=10:00&package=p-a-3d`,
    `?date=${day}&time=25:00&package=p-z-1d`,
    `?date=${day}&time=noon&package=p-z-1d`,
    `?date=${day}&time=10:15&package=p-z-1d`,
    `?date=${day}&time=10:00&package=p-nope`,
    `?date=${day}&time=10:00&package=p-b-6h`,
    `?date=${day}&time=17:30&package=p-b-6h`,
    `?date=9999-12-31&time=17:30&package=p-b-6h`,
    `?date=${inDays(20)}&time=10:00&package=p-z-1d`,
    `?date=${day}&time=10:00`,
    `?date=${day}&package=p-z-1d`,
    `?time=10:00&package=p-z-1d`,
    `?date=${day}`,
    `?time=10:00`,
    `?package=p-z-1d`,
    `?date=&time=&package=`,
    `?date=${day}&date=2030-01-01&time=10:00&time=11:00&package=p-z-1d&package=p-a-3d`,
    `?date=${payload}&time=${payload}&package=${payload}`,
    // An error no post sends. A dictionary looked up with it throws on a miss, or finds what every object inherits.
    `?${param}=NOPE`,
    `?${param}=constructor`,
    `?${param}=__proto__`,
    `?${param}=toString`,
    `?${param}=`,
    `?${param}=${payload}`,
  ];
  for (const query of queries) {
    for (const locale of ["en", "ko"] as const) {
      const path = modelPath(locale, PCX.id) + query;
      const html = await pageHtml(path);
      assert.ok(!html.includes(PAYLOAD), `${path}: echoes the payload`);
      assert.match(visibleText(mainOf(html, path)), yen(priceOf(catalog, PCX, "p-z-1d")), `${path}: the price table`);
    }
  }
});

test("GET on book answers 405", async () => {
  await publish(catalogWith());
  const query = queryOf({ date: inDays(12), time: "10:00", package: "p-z-1d" });
  for (const locale of LOCALES) {
    for (const path of [`/${locale}/book`, `/${locale}/book${query}`]) {
      assert.equal(await statusOf(path), 405, path);
    }
  }
  assert.deepEqual(await bookings(), [], "wrote a booking");
});

test("unknown and inactive models return 404", async () => {
  const unknown = [
    "no-such-model",
    "M-A-PCX",
    "m-a-pcx-2",
    "m-a",
    "r-125cc",
    "p-z-1d",
    "pcx-1",
    // Names every object inherits, for a lookup that is not a list.
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "0",
    "m-a-pcx%20",
  ];

  await publish(catalogWith());
  // Without these the test would pass on a site with no model pages at all.
  for (const locale of LOCALES) {
    for (const target of [VINO, PCX, NOTE]) {
      for (const suffix of ["", "/"]) {
        const path = modelPath(locale, target.id) + suffix;
        assert.equal(await statusOf(path), 200, path);
      }
    }
    assert.equal(await statusOf(modelPath(locale, GONE.id)), 404, `${locale} inactive`);
    assert.equal(await statusOf(`${modelPath(locale, GONE.id)}/`), 404, `${locale} inactive, with a slash`);
    for (const id of unknown) {
      const path = modelPath(locale, id);
      assert.equal(await statusOf(path), 404, path);
    }
  }

  // The flag decides, not the id: swapped by a publish, the pages swap too.
  await publish(catalogWith({ models: MODELS.map((row) => ({ ...row, active: row === GONE || row === VINO })) }));
  for (const locale of LOCALES) {
    assert.equal(await statusOf(modelPath(locale, GONE.id)), 200, `${locale} activated`);
    assert.equal(await statusOf(modelPath(locale, VINO.id)), 200, `${locale} kept`);
    assert.equal(await statusOf(modelPath(locale, PCX.id)), 404, `${locale} deactivated`);
    assert.equal(await statusOf(modelPath(locale, NOTE.id)), 404, `${locale} deactivated`);
  }

  // A model the next publish leaves out is kept as inactive.
  await publish(
    catalogWith({ models: [VINO, NOTE, GONE], vehicles: VEHICLES.filter(({ modelId }) => modelId !== PCX.id) }),
  );
  for (const locale of LOCALES) {
    assert.equal(await statusOf(modelPath(locale, PCX.id)), 404, `${locale} left out`);
  }

  // Before the first publish there is no model to show or to hold.
  await publish(catalogWith());
  const form = await loadForm("en", PCX.id);
  // A worker of its own, because the others in this file publish into theirs.
  const empty = await startWorker();
  try {
    for (const locale of LOCALES) {
      const path = modelPath(locale, PCX.id);
      assert.equal(await statusOf(path, {}, empty), 404, `${path} before the first publish`);
    }
    const search = { date: inDays(12), time: "10:00", package: "p-z-1d" };
    await assertRefused(
      await post(form.action, formBody(form, search), empty),
      "a post before the first publish",
      empty,
    );
  } finally {
    await empty.stop();
  }
});

test("unknown locales return 404 on the model page and book", async () => {
  await publish(catalogWith());
  const search = { time: "10:00", package: "p-z-1d" };

  // Without these the test would pass on a site with neither route.
  for (const [index, locale] of LOCALES.entries()) {
    const form = await loadForm(locale, NOTE.id);
    const res = await submit(form, { ...search, date: inDays(30 + index) });
    await res.text();
    assert.equal(res.status, 303, `${locale} post`);
    assert.notEqual(checkoutId(redirectOf(res, locale), locale), null, `${locale} post`);
  }

  const form = await loadForm("en", NOTE.id);
  const body = formBody(form, { ...search, date: inDays(40) });
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
  const held = (await bookings()).length;
  for (const segment of unknown) {
    assert.equal(await statusOf(modelPath(segment, NOTE.id)), 404, `model page under ${segment}`);
    assert.equal(await statusOf(`/${segment}/book`), 404, `GET book under ${segment}`);
    const res = await post(form.action.replace("/en/", `/${segment}/`), body);
    await res.text();
    assert.equal(res.status, 404, `POST book under ${segment}`);
  }
  assert.equal((await bookings()).length, held, "a post under an unknown locale wrote a booking");
});
