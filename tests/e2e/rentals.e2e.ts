// The listing, through the built Worker, over catalogs that go through validateCatalog and replaceCatalog as a publish does.
// The Worker reads the real clock, so pickups are computed from today in JST. Expected prices come from the hand-written
// fixture or from literals here. A card is an `<a data-model-id>`; these hooks are the page's contract with this file:
//   data-model-id   on the card's link, the model's id
//   data-available  on the card's link, only for a model searchAvailability returned
//   data-price, data-deposit   the elements inside a card that show those amounts
//   data-search-prompt, data-search-error   the prompt to choose dates, and the message about invalid params
//   data-engine-filter   the element that holds the cc select, carrying `hidden` while the type is car
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { searchAvailability, type CcBand } from "../../src/lib/booking/availability.ts";
import { validateCatalog } from "../../src/lib/catalog/sheet-schema.ts";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { addDaysToDate, epochToJst, formatHHmm, jstToday, jstToEpoch, parseHHmm } from "../../src/lib/time.ts";
import type { Catalog, ShopConfig, VehicleTypeId } from "../../src/lib/types.ts";
import { mainOf, tagsIn, visibleText, type Tag } from "../helpers/html.ts";
import { insertRow, seedBooking } from "../helpers/seed.ts";
import {
  appendCopy,
  appendRow,
  expectedCatalog,
  removeRow,
  setCell,
  validWorkbook,
  type Workbook,
} from "../helpers/sheet-workbook.ts";
import { startWorker, type TestWorker } from "../helpers/worker.ts";

const HOUR_MS = 3_600_000;
const base = "http://localhost/";

/** The active models of the fixture, by sort. cub-110 is inactive. */
const ACTIVE = ["today-50", "pcx-125", "rebel-250", "nbox-660"];

let worker: TestWorker;

before(async () => {
  worker = await startWorker();
});

after(async () => {
  await worker?.stop();
});

beforeEach(async () => {
  await worker.db.batch([worker.db.prepare("DELETE FROM bookings"), worker.db.prepare("DELETE FROM photos")]);
});

/** The fixture sheet after `edit`, as a publish reads it. */
function sheetCatalog(edit: (workbook: Workbook) => void = () => {}): Catalog {
  const workbook = validWorkbook();
  edit(workbook);
  // The date of the fixture's closed dates, fixed so that they stay plausible whatever day this runs.
  const { catalog, fatal } = validateCatalog(workbook, Date.parse("2026-11-02T12:00:00+09:00"));
  assert.deepEqual(fatal, []);
  assert.ok(catalog, "the fixture does not validate");
  return catalog;
}

async function publish(catalog: Catalog): Promise<void> {
  await replaceCatalog(worker.db, catalog, { now: Date.now(), source: "sheet" });
}

/** Days from three days ahead on with three open days in a row, so any fixture lead time and package can start there. */
function openDates(catalog: Catalog, now = Date.now()): string[] {
  const today = jstToday(now);
  const days = Array.from({ length: 60 }, (_, ahead) => addDaysToDate(today, ahead + 3));
  return days.filter((date) => [0, 1, 2].every((n) => !catalog.closedDates.includes(addDaysToDate(date, n))));
}

function searchQuery(date: string, params: Record<string, string> = {}): string {
  return new URLSearchParams({ date, time: "10:00", package: "day-1", ...params }).toString();
}

async function pageHtml(path: string, target: TestWorker = worker): Promise<string> {
  const res = await target.fetch(path, { redirect: "manual" });
  const html = await res.text();
  assert.equal(res.status, 200, path);
  return html;
}

async function listing(path: string): Promise<string> {
  return mainOf(await pageHtml(path), path);
}

/** The element that starts at `tag`, whatever it holds. */
function elementAt(html: string, tag: Tag): string {
  const edges = new RegExp(`<(/?)${tag.name}(?=[\\s/>])`, "gi");
  edges.lastIndex = tag.index;
  let depth = 0;
  for (let edge = edges.exec(html); edge !== null; edge = edges.exec(html)) {
    depth += edge[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(tag.index, html.indexOf(">", edge.index) + 1);
  }
  throw new Error(`no closing tag for <${tag.name}> at ${tag.index}`);
}

type Card = { id: string; tag: Tag; html: string; text: string };

/** The page's cards in order. The whole card is one link. */
function cardsIn(main: string): Card[] {
  return tagsIn(main)
    .filter(({ attributes }) => attributes["data-model-id"] !== undefined)
    .map((tag) => {
      assert.equal(tag.name, "a", `the card of ${tag.attributes["data-model-id"]} is not a link`);
      const html = elementAt(main, tag);
      return { id: tag.attributes["data-model-id"] as string, tag, html, text: visibleText(html) };
    });
}

function idsIn(main: string): string[] {
  return cardsIn(main).map(({ id }) => id);
}

function card(main: string, id: string, label: string): Card {
  const found = cardsIn(main).find((candidate) => candidate.id === id);
  assert.ok(found, `${label}: no card for ${id} in ${idsIn(main).join(", ")}`);
  return found;
}

function isAvailable({ tag }: Card): boolean {
  return "data-available" in tag.attributes;
}

/** The text of the element with `hook`, or undefined when the page has none. */
function hookText(html: string, hook: string): string | undefined {
  const tag = tagsIn(html).find(({ attributes }) => hook in attributes);
  return tag === undefined ? undefined : visibleText(elementAt(html, tag));
}

/** Every amount written as yen, as its digits and separators. visibleText has folded ￥ and full-width digits to ASCII. */
function yenIn(text: string): string[] {
  const amount = String.raw`\d{1,3}(?:,\d{3})*(?!\d|,\d)|\d+(?!\d|,\d)`;
  const pattern = new RegExp(`¥\\s*(${amount})|(?<![\\d,])(${amount})\\s*(?:円|엔|日元|日圆)`, "g");
  return [...text.matchAll(pattern)].map((match) => (match[1] ?? match[2]) as string);
}

/** The amounts shown by the card's elements with `hook`. */
function amounts({ html }: Card, hook: "data-price" | "data-deposit"): string[] {
  const tags = tagsIn(html).filter(({ attributes }) => hook in attributes);
  return tags.flatMap((tag) => yenIn(visibleText(elementAt(html, tag))));
}

/** 1234500 as 1,234,500, worked out here and not with Intl, which is what the page may use. */
function grouped(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+$)/g, ",");
}

/** The class price of `id` for the package and the deposit of its type, from `sheet`. */
function money(sheet: Catalog, id: string, packageId: string): { price: number | undefined; deposit: number } {
  const model = sheet.models.find((candidate) => candidate.id === id);
  assert.ok(model, `the sheet has no model ${id}`);
  const type = sheet.vehicleTypes.find((candidate) => candidate.id === model.typeId);
  assert.ok(type, `the sheet has no type ${model.typeId}`);
  const price = sheet.prices.find((row) => row.rateClassId === model.rateClassId && row.packageId === packageId);
  return { price: price?.priceJpy, deposit: type.depositJpy };
}

/** Each card shows the sheet's price and deposit, once each, and the deposit is not read off the price. */
function assertMoney(main: string, sheet: Catalog, packageId: string, label: string): void {
  for (const shown of cardsIn(main)) {
    const { price, deposit } = money(sheet, shown.id, packageId);
    assert.ok(price !== undefined, `${label}: the sheet has no ${packageId} price for ${shown.id}`);
    assert.deepEqual(amounts(shown, "data-price"), [grouped(price)], `${label}: price of ${shown.id}`);
    assert.deepEqual(amounts(shown, "data-deposit"), [grouped(deposit)], `${label}: deposit of ${shown.id}`);
  }
}

/** Text that can only be this locale's, so one locale's sentences cannot stand in for another's. */
const script: Record<Locale, { must: RegExp; mustNot: RegExp }> = {
  ja: { must: /\p{Script=Hiragana}|\p{Script=Katakana}/u, mustNot: /\p{Script=Hangul}/u },
  en: { must: /[A-Za-z]{3}/, mustNot: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  "zh-cn": { must: /\p{Script=Han}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  ko: { must: /\p{Script=Hangul}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}/u },
};

function assertNotice(main: string, hook: string, locale: Locale, label: string): void {
  const text = hookText(main, hook);
  assert.ok(text, `${label}: no ${hook} text`);
  assert.match(text, script[locale].must, `${label}: ${hook} is not in the locale's script: ${text}`);
  assert.doesNotMatch(text, script[locale].mustNot, `${label}: ${hook} holds another locale's text: ${text}`);
}

/** A complete, valid search: results only, no prompt to choose dates and no message. */
function assertResults(main: string, expected: string[], label: string): void {
  assert.deepEqual(idsIn(main), expected, label);
  for (const shown of cardsIn(main)) assert.ok(isAvailable(shown), `${label}: ${shown.id} is not shown as available`);
  assert.equal(hookText(main, "data-search-prompt"), undefined, `${label}: a prompt beside results`);
  assert.equal(hookText(main, "data-search-error"), undefined, `${label}: a message on a valid search`);
}

/** No complete search: `expected` in any order, none shown as available. */
function assertBrowsing(main: string, expected: string[], label: string): void {
  assert.deepEqual(idsIn(main).sort(), [...expected].sort(), label);
  const available = cardsIn(main).filter(isAvailable);
  assert.deepEqual(available.map(({ id }) => id), [], `${label}: shown as available`);
}

/** Runs `check` with the current time, again if it fails and the JST date of now or now + `leadHours` has changed since. */
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

/** The one form that holds the package choice. */
function filterForm(main: string, label: string): string {
  const forms = [...main.matchAll(/<form\b[\s\S]*?<\/form\s*>/gi)]
    .map(([form]) => form)
    .filter((form) => tagsIn(form).some(({ attributes }) => attributes.name === "package"));
  assert.equal(forms.length, 1, `${label}: filter forms`);
  return forms[0] as string;
}

/** The form's choices for `name`: a select's options or its radio buttons, in order. */
function choices(form: string, name: string): Tag[] {
  const tags = tagsIn(form);
  const select = tags.find((tag) => tag.name === "select" && tag.attributes.name === name);
  if (select) return tagsIn(elementAt(form, select)).filter((tag) => tag.name === "option");
  return tags.filter((tag) => tag.name === "input" && tag.attributes.type === "radio" && tag.attributes.name === name);
}

/** The non-empty values the form offers for `name`. An empty value means "any". */
function offered(form: string, name: string): string[] {
  return choices(form, name)
    .map(({ attributes }) => attributes.value)
    .filter((value): value is string => value !== undefined && value !== "");
}

/** What a guest who leaves `name` alone submits: the last selected or checked choice, else a select's first option. */
function chosen(form: string, name: string): string | undefined {
  const all = choices(form, name);
  const marked = all.filter(({ attributes }) => "selected" in attributes || "checked" in attributes).at(-1);
  return (marked ?? all.find((tag) => tag.name === "option"))?.attributes.value;
}

function dateInput(form: string, label: string): { picker: Tag; input: Tag } {
  const tags = tagsIn(form);
  const picker = tags.find(({ name }) => name === "date-picker");
  assert.ok(picker, `${label}: no DatePicker`);
  const input = tags.find(
    ({ name, attributes, index }) =>
      name === "input" && attributes.type === "date" && attributes.name === "date" && index > picker.index,
  );
  assert.ok(input, `${label}: no date input in the DatePicker`);
  return { picker, input };
}

// The published sheet on the page.

test("prices on the listing equal the fixture sheet", async () => {
  const catalog = sheetCatalog();
  const sheet = expectedCatalog();
  await publish(catalog);
  const [date] = openDates(catalog);

  // Worked out from the sheet by eye, so a change of the fixture cannot slip past both this table and the comparison.
  const pcx = card(
    await listing(`/en/rentals?${searchQuery(date, { package: "day-3" })}`),
    "pcx-125",
    "the sheet's 3-day PCX",
  );
  assert.deepEqual(amounts(pcx, "data-price"), ["13,800"]);
  assert.deepEqual(amounts(pcx, "data-deposit"), ["3,000"]);

  for (const locale of LOCALES) {
    for (const packageId of ["day-1", "day-3"]) {
      const path = `/${locale}/rentals?${searchQuery(date, { package: packageId })}`;
      const main = await listing(path);
      assertResults(main, ACTIVE, path);
      assertMoney(main, sheet, packageId, path);
    }
  }
});

test("prices follow the next publish in every locale, as yen with thousands separators", async () => {
  // Below a thousand, a round ten thousand and over a million, so a separator cut at a fixed place shows.
  const catalog = sheetCatalog((workbook) => {
    setCell(workbook, "Prices", "scooter-50/day-1", "price_jpy", 980);
    setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", 1234500);
    setCell(workbook, "Prices", "bike-400/day-1", "price_jpy", 10000);
    setCell(workbook, "Prices", "car-k/day-1", "price_jpy", 7777);
    setCell(workbook, "Types", "scooter", "deposit_jpy", 12345);
    setCell(workbook, "Types", "motorcycle", "deposit_jpy", 999);
    setCell(workbook, "Types", "car", "deposit_jpy", 100000);
  });
  await publish(catalog);
  const [date] = openDates(catalog);

  const expected: Record<string, { price: string; deposit: string }> = {
    "today-50": { price: "980", deposit: "12,345" },
    "pcx-125": { price: "1,234,500", deposit: "12,345" },
    "rebel-250": { price: "10,000", deposit: "999" },
    "nbox-660": { price: "7,777", deposit: "100,000" },
  };
  for (const locale of LOCALES) {
    const path = `/${locale}/rentals?${searchQuery(date)}`;
    const main = await listing(path);
    assert.deepEqual(idsIn(main), ACTIVE, path);
    for (const [id, { price, deposit }] of Object.entries(expected)) {
      const shown = card(main, id, path);
      assert.deepEqual(amounts(shown, "data-price"), [price], `${path}: price of ${id}`);
      assert.deepEqual(amounts(shown, "data-deposit"), [deposit], `${path}: deposit of ${id}`);
    }
  }
});

test("a model added by republishing appears in the grid", async () => {
  const first = sheetCatalog();
  await publish(first);
  const [date] = openDates(first);
  const search = `?${searchQuery(date)}`;
  for (const query of ["", search]) {
    assert.deepEqual(idsIn(await listing(`/en/rentals${query}`)).sort(), [...ACTIVE].sort(), `before, ${query}`);
  }

  // One model in a class the sheet has, sorted between two others, and one in a class of its own.
  const added = sheetCatalog((workbook) => {
    const names = { name_ja: "ビーノ", name_en: "Vino", name_zh: "维诺", name_ko: "비노" };
    appendCopy(workbook, "Models", "pcx-125", { model_id: "vino-125", sort: 3, photos: "", ...names });
    appendCopy(workbook, "Vehicles", "わ1002", { plate: "わ1010", model_id: "vino-125" });

    appendCopy(workbook, "RateClasses", "bike-400", { rate_class_id: "bike-750", sort: 9, name_en: "750cc bike" });
    appendCopy(workbook, "Prices", "bike-400/day-1", { rate_class_id: "bike-750", price_jpy: 31415 });
    appendCopy(workbook, "Models", "rebel-250", {
      model_id: "hawk-750",
      rate_class_id: "bike-750",
      engine_cc: 750,
      sort: 9,
      photos: "",
      name_ja: "ホーク",
      name_en: "Hawk",
      name_zh: "鹰",
      name_ko: "호크",
    });
    appendCopy(workbook, "Vehicles", "わ1005", { plate: "わ1011", model_id: "hawk-750" });
  });
  await publish(added);

  const names: Record<Locale, [string, string]> = {
    ja: ["ビーノ", "ホーク"],
    en: ["Vino", "Hawk"],
    "zh-cn": ["维诺", "鹰"],
    ko: ["비노", "호크"],
  };
  for (const locale of LOCALES) {
    const [vino, hawk] = names[locale];
    for (const query of ["", search]) {
      const path = `/${locale}/rentals${query}`;
      const main = await listing(path);
      assert.deepEqual(idsIn(main).sort(), [...ACTIVE, "hawk-750", "vino-125"].sort(), path);
      assert.ok(card(main, "vino-125", path).text.includes(vino), `${path}: name of vino-125`);
      assert.ok(card(main, "hawk-750", path).text.includes(hawk), `${path}: name of hawk-750`);
    }
    const path = `/${locale}/rentals${search}`;
    const main = await listing(path);
    assert.deepEqual(amounts(card(main, "vino-125", path), "data-price"), ["5,200"], `${path}: price of vino-125`);
    assert.deepEqual(amounts(card(main, "hawk-750", path), "data-price"), ["31,415"], `${path}: price of hawk-750`);
    assert.deepEqual(amounts(card(main, "hawk-750", path), "data-deposit"), ["5,000"], `${path}: deposit of hawk-750`);
  }

  // Leaving the sheet takes it off the grid on the next request.
  await publish(first);
  for (const query of ["", search]) {
    assert.deepEqual(idsIn(await listing(`/en/rentals${query}`)).sort(), [...ACTIVE].sort(), `after, ${query}`);
  }
});

test("model names use the locale's text, then en, then ja", async () => {
  const blanked = sheetCatalog();
  const stored = (id: string) => blanked.models.find((model) => model.id === id)?.texts;
  const pcx = stored("pcx-125");
  const rebel = stored("rebel-250");
  assert.ok(pcx && rebel);
  pcx.ko.name = "";
  rebel.en.name = "";
  rebel["zh-cn"].name = "";

  const expected: Record<Locale, Record<string, string>> = {
    ja: { "today-50": "トゥデイ", "pcx-125": "ピーシーエックス", "rebel-250": "レブル" },
    en: { "today-50": "Today", "pcx-125": "PCX", "rebel-250": "レブル" },
    "zh-cn": { "today-50": "今日", "pcx-125": "PCX踏板", "rebel-250": "レブル" },
    ko: { "today-50": "투데이", "pcx-125": "PCX", "rebel-250": "레블" },
  };

  // Blank in the sheet, where validateCatalog fills the gap, and blank in the published row itself.
  const fromSheet = sheetCatalog((workbook) => {
    setCell(workbook, "Models", "pcx-125", "name_ko", "");
    setCell(workbook, "Models", "rebel-250", "name_en", "");
    setCell(workbook, "Models", "rebel-250", "name_zh", "");
  });

  for (const catalog of [fromSheet, blanked]) {
    await publish(catalog);
    for (const locale of LOCALES) {
      const path = `/${locale}/rentals`;
      const main = await listing(path);
      for (const [id, name] of Object.entries(expected[locale])) {
        assert.ok(card(main, id, path).text.includes(name.normalize("NFKC")), `${path}: ${id} is not ${name}`);
      }
    }
  }

  // The other locale's name does not stand in where this locale has its own.
  await publish(sheetCatalog());
  const ko = await listing("/ko/rentals");
  assert.ok(!card(ko, "pcx-125", "/ko/rentals").text.includes("PCX"), "/ko/rentals shows the en name");
  const ja = await listing("/ja/rentals");
  assert.ok(!card(ja, "today-50", "/ja/rentals").text.includes("Today"), "/ja/rentals shows the en name");
});

// A complete search.

test("a complete search lists the models searchAvailability returns, in its order", async () => {
  // Sort runs against the ids and the sheet's rows, with a tie that falls to the id.
  const catalog = sheetCatalog((workbook) => {
    setCell(workbook, "Models", "today-50", "sort", 40);
    setCell(workbook, "Models", "pcx-125", "sort", 30);
    setCell(workbook, "Models", "rebel-250", "sort", 20);
    setCell(workbook, "Models", "nbox-660", "sort", 30);
    // Active with no bike, so it has nothing to rent.
    appendCopy(workbook, "Models", "pcx-125", { model_id: "no-bike-125", sort: 1, photos: "" });
    // A bike, but no 1-day price.
    appendCopy(workbook, "RateClasses", "bike-400", { rate_class_id: "bike-600", sort: 9 });
    appendCopy(workbook, "Prices", "bike-400/day-3", { rate_class_id: "bike-600" });
    appendCopy(workbook, "Models", "rebel-250", {
      model_id: "cbr-600",
      rate_class_id: "bike-600",
      engine_cc: 600,
      sort: 2,
      photos: "",
    });
    appendCopy(workbook, "Vehicles", "わ1005", { plate: "わ1012", model_id: "cbr-600" });
  });
  await publish(catalog);
  const [pickup] = openDates(catalog);

  const cases: { packageId: string; typeId?: VehicleTypeId; ccBand?: CcBand; expected: string[] }[] = [
    { packageId: "day-1", expected: ["rebel-250", "nbox-660", "pcx-125", "today-50"] },
    { packageId: "day-3", expected: ["cbr-600", "rebel-250", "nbox-660", "pcx-125", "today-50"] },
    { packageId: "day-1", typeId: "scooter", expected: ["pcx-125", "today-50"] },
    { packageId: "day-3", ccBand: "126to400", expected: ["rebel-250"] },
  ];
  for (const { packageId, typeId, ccBand, expected } of cases) {
    const found = await searchAvailability(worker.db, {
      startAt: jstToEpoch(pickup, "10:00"),
      packageId,
      typeId,
      ccBand,
      now: Date.now(),
    });
    assert.deepEqual(found.map(({ modelId }) => modelId), expected, "the expected order is not searchAvailability's");

    const filters = { ...(typeId && { type: typeId }), ...(ccBand && { cc: ccBand }) };
    for (const locale of LOCALES) {
      const path = `/${locale}/rentals?${searchQuery(pickup, { package: packageId, ...filters })}`;
      assertResults(await listing(path), expected, path);
    }
  }
});

test("sold-out models are not listed", async () => {
  // pcx-125 has one active bike and one in maintenance, and rebel-250 gets a second.
  const catalog = sheetCatalog((workbook) => {
    appendCopy(workbook, "Vehicles", "わ1005", { plate: "わ1007" });
  });
  await publish(catalog);
  const open = openDates(catalog);
  const date = open[0] as string;
  const otherDay = open.at(-1) as string;

  const results = () => listing(`/en/rentals?${searchQuery(date)}`);
  const book = (plate: string) =>
    seedBooking(worker.db, {
      vehicle_plate: plate,
      start_at: jstToEpoch(date, "10:00"),
      end_at: jstToEpoch(date, "18:00"),
    });

  assertResults(await results(), ACTIVE, "nothing booked");

  await book("わ1002");
  assertResults(await results(), ["today-50", "rebel-250", "nbox-660"], "the only active bike of pcx-125 is booked");

  await book("わ1005");
  assertResults(await results(), ["today-50", "rebel-250", "nbox-660"], "rebel-250 still has a free bike");

  await book("わ1007");
  assertResults(await results(), ["today-50", "nbox-660"], "every bike of rebel-250 is booked");

  // Sold out on that day alone, and still part of the shop when no dates are chosen.
  const elsewhere = `/en/rentals?${searchQuery(otherDay)}`;
  assertResults(await listing(elsewhere), ACTIVE, elsewhere);
  assertBrowsing(await listing("/en/rentals"), ACTIVE, "no dates");
});

test("type and engine filters narrow the list", async () => {
  const catalog = sheetCatalog((workbook) => {
    appendCopy(workbook, "Models", "rebel-250", {
      model_id: "busa-1300",
      engine_cc: 1300,
      sort: 6,
      photos: "",
      name_en: "Busa",
    });
    appendCopy(workbook, "Vehicles", "わ1005", { plate: "わ1013", model_id: "busa-1300" });
  });
  await publish(catalog);
  const [date] = openDates(catalog);

  const cases: { filters: Record<string, string>; expected: string[] }[] = [
    { filters: {}, expected: [...ACTIVE, "busa-1300"] },
    { filters: { type: "scooter" }, expected: ["today-50", "pcx-125"] },
    { filters: { type: "motorcycle" }, expected: ["rebel-250", "busa-1300"] },
    { filters: { type: "car" }, expected: ["nbox-660"] },
    { filters: { cc: "upto50" }, expected: ["today-50"] },
    { filters: { cc: "51to125" }, expected: ["pcx-125"] },
    { filters: { cc: "126to400" }, expected: ["rebel-250"] },
    { filters: { cc: "over400" }, expected: ["busa-1300"] },
    { filters: { type: "scooter", cc: "51to125" }, expected: ["pcx-125"] },
    { filters: { type: "motorcycle", cc: "over400" }, expected: ["busa-1300"] },
    { filters: { type: "motorcycle", cc: "51to125" }, expected: [] },
  ];
  for (const locale of ["en", "ko"] as const) {
    for (const { filters, expected } of cases) {
      const path = `/${locale}/rentals?${searchQuery(date, filters)}`;
      assertResults(await listing(path), expected, path);
    }
  }

  // The example from the ticket, written the way a link writes it.
  const path = `/en/rentals?date=${date}&time=10:00&package=day-3&type=scooter&cc=51to125`;
  assertResults(await listing(path), ["pcx-125"], path);
});

// Without a complete search.

test("without dates every active model is listed with a prompt", async () => {
  // Active with no bike at all, so a list of what can be rented is not a list of what is active.
  const catalog = sheetCatalog((workbook) => {
    appendCopy(workbook, "Models", "pcx-125", { model_id: "no-bike-125", sort: 7, photos: "" });
  });
  await publish(catalog);
  const active = [...ACTIVE, "no-bike-125"];
  const [date] = openDates(catalog);

  const queries = [
    "",
    "?date=&time=&package=&type=&cc=&class=",
    "?package=day-1",
    "?time=10:00&package=day-3",
    `?date=${date}`,
    `?date=${date}&time=10:00`,
    `?date=${date}&package=day-1`,
  ];
  for (const locale of LOCALES) {
    for (const query of queries) {
      const path = `/${locale}/rentals${query}`;
      const main = await listing(path);
      assertBrowsing(main, active, path);
      assertNotice(main, "data-search-prompt", locale, path);
      assert.equal(hookText(main, "data-search-error"), undefined, `${path}: a message with nothing invalid`);
    }

    // With no package chosen, a price shown is still one of the model's, and the deposit is its type's.
    const path = `/${locale}/rentals`;
    for (const shown of cardsIn(await listing(path))) {
      const classPrices = ["hours-6", "day-1", "day-3"].flatMap((id) => money(catalog, shown.id, id).price ?? []);
      for (const amount of amounts(shown, "data-price")) {
        assert.ok(classPrices.map(grouped).includes(amount), `${path}: ${amount} is no price of ${shown.id}`);
      }
      const { deposit } = money(catalog, shown.id, "day-1");
      assert.deepEqual(amounts(shown, "data-deposit"), [grouped(deposit)], `${path}: deposit of ${shown.id}`);
    }
  }
});

test("invalid params do not fail", async () => {
  const catalog = { ...sheetCatalog(), closedDates: [] };
  const [pickup] = openDates(catalog);
  const closed = addDaysToDate(pickup, 5);
  await publish({ ...catalog, closedDates: [closed] });
  const today = jstToday(Date.now());

  const bad: Record<string, string[]> = {
    date: [
      "not-a-date",
      "2030-02-30",
      "2030-13-01",
      "99999-01-01",
      "0000-00-00",
      "2030-6-1",
      "2000-01-01",
      today,
      addDaysToDate(today, 500),
      closed,
    ],
    time: ["25:00", "10:60", "noon", "10:15", "08:00", "18:00", "00:00"],
    package: ["week", "constructor", "__proto__"],
    type: ["plane", "CAR", "toString"],
    cc: ["all", "50", "constructor"],
    class: ["nope", "__proto__", "valueOf"],
  };

  for (const [param, values] of Object.entries(bad)) {
    for (const value of values) {
      // In a search that also filters, so "unfiltered" means the filters that were valid are dropped too.
      const search = `/en/rentals?${searchQuery(pickup, { type: "scooter", [param]: value })}`;
      const main = await listing(search);
      assertBrowsing(main, ACTIVE, search);
      assertNotice(main, "data-search-error", "en", search);
    }
  }

  // Alone, each param that can be wrong without a search around it.
  for (const param of ["package", "type", "cc", "class"]) {
    for (const value of bad[param] as string[]) {
      const path = `/en/rentals?${new URLSearchParams({ [param]: value })}`;
      const main = await listing(path);
      assertBrowsing(main, ACTIVE, path);
      assertNotice(main, "data-search-error", "en", path);
    }
  }

  // The message comes in the reader's locale.
  for (const locale of LOCALES) {
    const path = `/${locale}/rentals?${searchQuery(pickup, { date: "2030-02-30", cc: "all" })}`;
    const main = await listing(path);
    assertBrowsing(main, ACTIVE, path);
    assertNotice(main, "data-search-error", locale, path);
  }

  // What a request can throw at the page. Each comes back as text, never as markup, and never as a 500.
  const hostile: { query: string; injected?: string }[] = [
    { query: "date=<script>alert(1)</script>", injected: "<script>alert(1)" },
    { query: "time=<script>alert(1)</script>", injected: "<script>alert(1)" },
    { query: `date=${pickup}"><img src=x onerror=alert(1)>`, injected: "<img src=x" },
    { query: `package="><img src=x onerror=alert(1)>`, injected: "<img src=x" },
    { query: `type="><img src=x onerror=alert(1)>`, injected: "<img src=x" },
    { query: `class="><img src=x onerror=alert(1)>`, injected: "<img src=x" },
    { query: `cc="><img src=x onerror=alert(1)>`, injected: "<img src=x" },
    { query: "date=%FF%FE&time=%00" },
    { query: "date=%" },
    { query: `date=${"9".repeat(5000)}` },
    { query: "type=car&type=plane&cc=all&cc=upto50" },
    { query: "date[]=x&time[$gt]=1" },
  ];
  for (const { query, injected } of hostile) {
    const path = `/en/rentals?${query.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll('"', "%22")}`;
    const html = await pageHtml(path);
    if (injected !== undefined) assert.ok(!html.includes(injected), `${path} puts the param into the page unescaped`);
  }
});

test("the date input carries min and max from config", async () => {
  const configs: Partial<ShopConfig>[] = [
    { minLeadHours: 30, maxDaysAhead: 120 },
    { minLeadHours: 54, maxDaysAhead: 45 },
    { minLeadHours: 1, maxDaysAhead: 200 },
  ];
  for (const config of configs) {
    const fixture = sheetCatalog();
    await steady(config.minLeadHours as number, async (now) => {
      const today = jstToday(now);
      const closedDates = [addDaysToDate(today, 9), addDaysToDate(today, 40)];
      await publish({ ...fixture, config: { ...fixture.config, ...config }, closedDates });
      for (const locale of LOCALES) {
        for (const query of ["", "?package=day-3"]) {
          const path = `/${locale}/rentals${query}`;
          const { picker, input } = dateInput(filterForm(await listing(path), path), path);
          const lead = (config.minLeadHours as number) * HOUR_MS;
          assert.equal(input.attributes.min, epochToJst(now + lead).date, `${path} min`);
          assert.equal(input.attributes.max, addDaysToDate(today, config.maxDaysAhead as number), `${path} max`);

          const shown = JSON.parse(picker.attributes["data-config"] ?? "{}") as { closedDates?: string[] };
          assert.deepEqual(shown.closedDates, closedDates, `${path} closed dates`);
        }
      }
    });
  }
});

/** The pickup times of a config, as task #20 defines them: from opening to one slot before closing. */
function slotsOf({ shopOpen, shopClose, slotMinutes }: ShopConfig): string[] {
  const slots: string[] = [];
  for (let at = parseHHmm(shopOpen); at <= parseHHmm(shopClose) - slotMinutes; at += slotMinutes) {
    slots.push(formatHHmm(at));
  }
  return slots;
}

test("the filter form is a GET form that offers the filters and keeps the search", async () => {
  const fixture = sheetCatalog();
  const catalog = {
    ...fixture,
    config: { ...fixture.config, shopOpen: "08:30", shopClose: "17:00", slotMinutes: 45 },
  };
  await publish(catalog);
  const [date] = openDates(catalog);

  for (const locale of LOCALES) {
    const path = `/${locale}/rentals?${searchQuery(date, {
      time: "11:30",
      package: "day-3",
      type: "motorcycle",
      cc: "126to400",
    })}`;
    const main = await listing(path);
    const form = filterForm(main, path);
    assert.equal((tagsIn(form)[0]?.attributes.method ?? "get").toLowerCase(), "get", `${path} method`);

    assert.deepEqual(offered(form, "time"), slotsOf(catalog.config), `${path} times`);
    assert.deepEqual(offered(form, "type").sort(), ["car", "motorcycle", "scooter"], `${path} types`);
    assert.deepEqual(offered(form, "cc").sort(), ["126to400", "51to125", "over400", "upto50"].sort(), `${path} bands`);
    assert.ok(offered(form, "package").includes("day-3"), `${path} packages`);

    assert.equal(dateInput(form, path).input.attributes.value, date, `${path} date`);
    assert.equal(chosen(form, "time"), "11:30", `${path} time`);
    assert.equal(chosen(form, "package"), "day-3", `${path} package`);
    assert.equal(chosen(form, "type"), "motorcycle", `${path} type`);
    assert.equal(chosen(form, "cc"), "126to400", `${path} cc`);
  }
});

// The links the fee schedule makes.

test("the class param narrows the list without dates", async () => {
  // bike-125 holds two active models and the inactive cub-110, and bike-950 is a class with no model.
  const catalog = sheetCatalog((workbook) => {
    appendCopy(workbook, "Models", "pcx-125", { model_id: "lead-125", sort: 3, photos: "" });
    appendCopy(workbook, "RateClasses", "bike-400", { rate_class_id: "bike-950", sort: 9 });
    appendCopy(workbook, "Prices", "bike-400/day-1", { rate_class_id: "bike-950" });
  });
  await publish(catalog);

  const cases: Record<string, string[]> = {
    "scooter-50": ["today-50"],
    "bike-125": ["pcx-125", "lead-125"],
    "bike-400": ["rebel-250"],
    "car-k": ["nbox-660"],
    "bike-950": [],
  };
  for (const locale of LOCALES) {
    for (const [classId, expected] of Object.entries(cases)) {
      for (const query of [`?class=${classId}`, `?class=${classId}&package=day-1`]) {
        const path = `/${locale}/rentals${query}`;
        const main = await listing(path);
        assertBrowsing(main, expected, path);
        assertNotice(main, "data-search-prompt", locale, path);
        assert.equal(hookText(main, "data-search-error"), undefined, `${path}: a message on a valid class`);
      }
    }
  }
});

test("the class param narrows the list with dates", async () => {
  const catalog = sheetCatalog((workbook) => {
    appendCopy(workbook, "Models", "pcx-125", { model_id: "lead-125", sort: 3, photos: "" });
    appendCopy(workbook, "Vehicles", "わ1002", { plate: "わ1014", model_id: "lead-125" });
  });
  await publish(catalog);
  const [pickup] = openDates(catalog);

  const cases: { filters: Record<string, string>; expected: string[] }[] = [
    { filters: { class: "scooter-50" }, expected: ["today-50"] },
    { filters: { class: "bike-125" }, expected: ["pcx-125", "lead-125"] },
    { filters: { class: "bike-400" }, expected: ["rebel-250"] },
    { filters: { class: "car-k" }, expected: ["nbox-660"] },
    { filters: { class: "bike-125", package: "day-3" }, expected: ["pcx-125", "lead-125"] },
    { filters: { class: "bike-125", type: "motorcycle" }, expected: [] },
    { filters: { class: "bike-125", type: "scooter", cc: "51to125" }, expected: ["pcx-125", "lead-125"] },
  ];
  for (const locale of LOCALES) {
    for (const { filters, expected } of cases) {
      const path = `/${locale}/rentals?${searchQuery(pickup, filters)}`;
      assertResults(await listing(path), expected, path);
    }
  }

  // The class narrows what is free, not what the class holds.
  await seedBooking(worker.db, {
    vehicle_plate: "わ1002",
    start_at: jstToEpoch(pickup, "10:00"),
    end_at: jstToEpoch(pickup, "18:00"),
  });
  const path = `/en/rentals?${searchQuery(pickup, { class: "bike-125" })}`;
  assertResults(await listing(path), ["lead-125"], path);
});

test("the package param preselects the package", async () => {
  const catalog = sheetCatalog();
  const sheet = expectedCatalog();
  await publish(catalog);
  const [date] = openDates(catalog);

  // Both day packages, so a select left on its first option cannot pass.
  for (const packageId of ["day-1", "day-3"]) {
    const queries = [
      `?package=${packageId}`,
      `?class=bike-125&package=${packageId}`,
      `?${searchQuery(date, { package: packageId })}`,
    ];
    for (const locale of LOCALES) {
      for (const query of queries) {
        const path = `/${locale}/rentals${query}`;
        const main = await listing(path);
        assert.equal(chosen(filterForm(main, path), "package"), packageId, `${path} package`);
        assertMoney(main, sheet, packageId, path);
        assert.ok(cardsIn(main).length > 0, `${path} lists nothing`);
      }
    }
  }
});

test("an hours package shows its prices but finds no pickup yet", async () => {
  const catalog = sheetCatalog();
  await publish(catalog);
  const [date] = openDates(catalog);

  // The fee schedule links its hours prices here. car-k has none, so its card has no price, and no price of zero.
  const main = await listing("/en/rentals?package=hours-6");
  assertBrowsing(main, ACTIVE, "hours package");
  assert.equal(hookText(main, "data-search-error"), undefined, "hours package: a message");
  assert.deepEqual(amounts(card(main, "pcx-125", "hours package"), "data-price"), ["3,600"]);
  assert.deepEqual(amounts(card(main, "nbox-660", "hours package"), "data-price"), []);
  assert.deepEqual(amounts(card(main, "nbox-660", "hours package"), "data-deposit"), ["10,000"]);

  const linked = await listing("/en/rentals?class=bike-125&package=hours-6");
  assertBrowsing(linked, ["pcx-125"], "hours package and class");
  assert.equal(hookText(linked, "data-search-error"), undefined, "hours package and class: a message");

  // searchAvailability finds nothing for an hours package until task #50.
  const path = `/en/rentals?${searchQuery(date, { package: "hours-6" })}`;
  assertResults(await listing(path), [], path);
});

// Each card's own price.

/** The package names the fixture and the split catalog below use, per locale, written out here. */
const PACKAGE_NAMES: Record<string, Record<Locale, string>> = {
  "hours-6": { ja: "6時間", en: "6 hours", "zh-cn": "6小时", ko: "6시간" },
  "day-1": { ja: "1日", en: "1 day", "zh-cn": "1天", ko: "1일" },
  "day-3": { ja: "3日", en: "3 days", "zh-cn": "3天", ko: "3일" },
  "car-same": { ja: "当日", en: "Same day", "zh-cn": "当天", ko: "당일" },
  "car-two": { ja: "2日", en: "2 days", "zh-cn": "2天", ko: "2일" },
};

/**
 * Bikes and cars on separate day packages, as the shop's sheet has them: the cars have no day-1 or day-3 price, and have
 * car-same (sort 4) and car-two (sort 5) instead. The car rows are written in the opposite order to their sort.
 */
function splitPackages(workbook: Workbook): void {
  removeRow(workbook, "Prices", "car-k/day-1");
  removeRow(workbook, "Prices", "car-k/day-3");
  const row = (id: string, days: number, sort: number) => ({
    package_id: id,
    days,
    sort,
    name_ja: PACKAGE_NAMES[id]["ja"],
    name_en: PACKAGE_NAMES[id]["en"],
    name_zh: PACKAGE_NAMES[id]["zh-cn"],
    name_ko: PACKAGE_NAMES[id]["ko"],
  });
  appendRow(workbook, "Packages", row("car-two", 2, 5));
  appendRow(workbook, "Packages", row("car-same", 1, 4));
  appendRow(workbook, "Prices", {
    rate_class_id: "car-k",
    package_id: "car-two",
    price_jpy: 15500,
  });
  appendRow(workbook, "Prices", {
    rate_class_id: "car-k",
    package_id: "car-same",
    price_jpy: 8000,
  });
}

/** The package and price each model shows on the split catalog with no package chosen, and its deposit. */
const OWN: Record<string, { packageId: string; price: string; deposit: string }> = {
  "today-50": { packageId: "day-1", price: "3,500", deposit: "3,000" },
  "pcx-125": { packageId: "day-1", price: "5,200", deposit: "3,000" },
  "rebel-250": { packageId: "day-1", price: "9,100", deposit: "5,000" },
  "nbox-660": { packageId: "car-same", price: "8,000", deposit: "10,000" },
};

/** The card shows `price` and the name of `packageId` in this locale, and no other package's name. */
function assertPriced(shown: Card, locale: Locale, packageId: string, price: string, label: string): void {
  const name = PACKAGE_NAMES[packageId]?.[locale] as string;
  assert.deepEqual(amounts(shown, "data-price"), [price], `${label}: price of ${shown.id}`);
  assert.ok(shown.text.includes(name), `${label}: ${shown.id} does not name ${packageId} (${name}): ${shown.text}`);
  for (const [other, names] of Object.entries(PACKAGE_NAMES)) {
    if (other === packageId) continue;
    assert.ok(!shown.text.includes(names[locale]), `${label}: ${shown.id} names ${other} too: ${shown.text}`);
  }
}

test("with no package chosen every card shows its own class's price", async () => {
  await publish(sheetCatalog(splitPackages));

  const queries: { query: string; expected: string[] }[] = [
    { query: "", expected: ACTIVE },
    { query: "?class=car-k", expected: ["nbox-660"] },
    { query: "?class=bike-125", expected: ["pcx-125"] },
    { query: "?class=bike-400", expected: ["rebel-250"] },
    { query: "?class=scooter-50", expected: ["today-50"] },
    { query: "?type=car", expected: ACTIVE },
  ];
  for (const locale of LOCALES) {
    for (const { query, expected } of queries) {
      const path = `/${locale}/rentals${query}`;
      const main = await listing(path);
      assertBrowsing(main, expected, path);
      for (const id of expected) {
        const own = OWN[id] as (typeof OWN)[string];
        const shown = card(main, id, path);
        assertPriced(shown, locale, own.packageId, own.price, path);
        assert.deepEqual(amounts(shown, "data-deposit"), [own.deposit], `${path}: deposit of ${id}`);
      }
    }
  }
});

test("with no package chosen a class takes the first day package it has a price for", async () => {
  // bike-400 has no day-1 price, so its first day package is day-3 (the hours package does not count), and car-k has
  // no car-same price, so its first is car-two.
  await publish(
    sheetCatalog((workbook) => {
      splitPackages(workbook);
      removeRow(workbook, "Prices", "bike-400/day-1");
      removeRow(workbook, "Prices", "car-k/car-same");
    }),
  );

  const main = await listing("/en/rentals");
  assertBrowsing(main, ACTIVE, "first priced day package");
  assertPriced(card(main, "today-50", "first"), "en", "day-1", "3,500", "today-50");
  assertPriced(card(main, "rebel-250", "first"), "en", "day-3", "24,700", "rebel-250");
  assertPriced(card(main, "nbox-660", "first"), "en", "car-two", "15,500", "nbox-660");

  // The same holds in the other locales, and for a class that is listed alone.
  const alone = await listing("/ko/rentals?class=bike-400");
  assertPriced(card(alone, "rebel-250", "alone"), "ko", "day-3", "24,700", "ko rebel-250");
});

test("a chosen package prices every card from that package, or from none", async () => {
  const catalog = sheetCatalog(splitPackages);
  await publish(catalog);

  // Every package that has a price, the hours one included, including those that only the other type has.
  const chosenPrices: Record<string, Record<string, string | undefined>> = {
    "day-1": {
      "today-50": "3,500",
      "pcx-125": "5,200",
      "rebel-250": "9,100",
      "nbox-660": undefined,
    },
    "day-3": {
      "today-50": "9,000",
      "pcx-125": "13,800",
      "rebel-250": "24,700",
      "nbox-660": undefined,
    },
    "car-same": {
      "today-50": undefined,
      "pcx-125": undefined,
      "rebel-250": undefined,
      "nbox-660": "8,000",
    },
    "car-two": {
      "today-50": undefined,
      "pcx-125": undefined,
      "rebel-250": undefined,
      "nbox-660": "15,500",
    },
    "hours-6": {
      "today-50": "2,500",
      "pcx-125": "3,600",
      "rebel-250": "6,100",
      "nbox-660": undefined,
    },
  };
  for (const locale of LOCALES) {
    for (const [packageId, expected] of Object.entries(chosenPrices)) {
      const path = `/${locale}/rentals?package=${packageId}`;
      const main = await listing(path);
      assertBrowsing(main, ACTIVE, path);
      assert.equal(chosen(filterForm(main, path), "package"), packageId, `${path}: package select`);
      for (const [id, price] of Object.entries(expected)) {
        const shown = card(main, id, path);
        if (price === undefined) {
          assert.deepEqual(amounts(shown, "data-price"), [], `${path}: a price on ${id}`);
          // The deposit is the only amount on a card without a price.
          assert.deepEqual(yenIn(shown.text), amounts(shown, "data-deposit"), `${path}: amounts on ${id}`);
        } else {
          assert.deepEqual(amounts(shown, "data-price"), [price], `${path}: price of ${id}`);
          // No other package's price shows beside it: the amounts are the price and the deposit.
          assert.equal(yenIn(shown.text).length, 2, `${path}: amounts on ${id}: ${shown.text}`);
        }
      }
    }
  }

  // With dates the package is required, and the cards are for it.
  const [date] = openDates(catalog);
  const path = `/en/rentals?${searchQuery(date, { package: "car-same", type: "car" })}`;
  const main = await listing(path);
  assertResults(main, ["nbox-660"], path);
  assertPriced(card(main, "nbox-660", path), "en", "car-same", "8,000", path);
});

test("a class with no priced day package shows no price", async () => {
  // The class that is left with its hours price only, which is no day package, and the deposit its card shows. The other
  // classes keep the prices of the split catalog.
  const scenarios: {
    bare: string;
    deposit: string;
    edit: (workbook: Workbook) => void;
  }[] = [
    {
      bare: "rebel-250",
      deposit: "5,000",
      edit: (workbook) => {
        removeRow(workbook, "Prices", "bike-400/day-1");
        removeRow(workbook, "Prices", "bike-400/day-3");
      },
    },
    {
      bare: "nbox-660",
      deposit: "10,000",
      edit: (workbook) => {
        removeRow(workbook, "Prices", "car-k/car-same");
        removeRow(workbook, "Prices", "car-k/car-two");
        appendRow(workbook, "Prices", {
          rate_class_id: "car-k",
          package_id: "hours-6",
          price_jpy: 4000,
        });
      },
    },
  ];
  for (const { bare, deposit, edit } of scenarios) {
    await publish(
      sheetCatalog((workbook) => {
        splitPackages(workbook);
        edit(workbook);
      }),
    );
    for (const locale of LOCALES) {
      for (const query of ["", "?class=bike-400", "?class=car-k", "?type=car"]) {
        const path = `/${locale}/rentals${query}`;
        const main = await listing(path);
        for (const id of idsIn(main)) {
          const shown = card(main, id, path);
          if (id === bare) {
            assert.deepEqual(amounts(shown, "data-price"), [], `${path}: a price on ${id}`);
            // Not the hours price and not a zero: the deposit is the only amount.
            assert.deepEqual(yenIn(shown.text), [deposit], `${path}: amounts on ${id}: ${shown.text}`);
            assert.deepEqual(amounts(shown, "data-deposit"), [deposit], `${path}: deposit of ${id}`);
          } else {
            const own = OWN[id] as (typeof OWN)[string];
            assertPriced(shown, locale, own.packageId, own.price, path);
          }
        }
      }
    }
  }
});

// What a guest gets who presses Search without touching the form.

/** The text of the package select's "any" option per locale, written out here. */
const ANY: Record<Locale, string> = { ja: "すべて", en: "Any", "zh-cn": "全部", ko: "전체" };

/** The no-results sentence per locale, enough of it to tell it from the rest of the page. */
const NO_VEHICLES: Record<Locale, string> = {
  ja: "条件に合う車両はありません",
  en: "No vehicles match",
  "zh-cn": "没有符合条件的车辆",
  ko: "조건에 맞는 차량이 없습니다",
};

/** The sentence of a card with no price for the package, enough of it to tell it from the rest of the page. */
const NOT_OFFERED: Record<Locale, string> = {
  ja: "このプランはありません",
  en: "Not offered on this package",
  "zh-cn": "此套餐不提供",
  ko: "이 패키지에는 없습니다",
};

/** The query a browser sends from the form as rendered, untouched: each named control's default, and the empty ones too. */
function defaultsOf(form: string): URLSearchParams {
  const query = new URLSearchParams();
  for (const { name, attributes } of tagsIn(form)) {
    const field = attributes.name;
    if (field === undefined || query.has(field)) continue;
    if (name === "select") query.append(field, chosen(form, field) ?? "");
    else if (name === "input" && !["submit", "button", "checkbox", "radio"].includes(attributes.type ?? "text")) {
      query.append(field, attributes.value ?? "");
    }
  }
  return query;
}

/** The package select's options with their text, in order. */
function packageOptions(form: string): { value: string | undefined; selected: boolean; text: string }[] {
  const select = tagsIn(form).find((tag) => tag.name === "select" && tag.attributes.name === "package");
  assert.ok(select, "no package select");
  const html = elementAt(form, select);
  return tagsIn(html)
    .filter((tag) => tag.name === "option")
    .map((tag) => ({
      value: tag.attributes.value,
      selected: "selected" in tag.attributes,
      text: visibleText(elementAt(html, tag)),
    }));
}

test("searching with the form's own defaults keeps every card priced from its own class", async () => {
  await publish(sheetCatalog(splitPackages));

  const queries: { query: string; expected: string[] }[] = [
    { query: "", expected: ACTIVE },
    { query: "?class=car-k", expected: ["nbox-660"] },
    { query: "?type=car", expected: ACTIVE },
    { query: "?class=bike-125", expected: ["pcx-125"] },
  ];
  for (const locale of LOCALES) {
    for (const { query, expected } of queries) {
      const first = `/${locale}/rentals${query}`;
      const sent = defaultsOf(filterForm(await listing(first), first));
      const path = `/${locale}/rentals?${sent}`;
      const main = await listing(path);
      assertBrowsing(main, expected, `${path} (from ${first})`);
      assert.equal(hookText(main, "data-search-error"), undefined, `${path}: a message`);
      for (const id of expected) {
        const own = OWN[id] as (typeof OWN)[string];
        const shown = card(main, id, path);
        assertPriced(shown, locale, own.packageId, own.price, `${path} (from ${first})`);
        assert.deepEqual(amounts(shown, "data-deposit"), [own.deposit], `${path}: deposit of ${id}`);
      }
    }
  }
});

test("the package select offers an empty choice, selected when no package is chosen", async () => {
  await publish(sheetCatalog(splitPackages));

  for (const locale of LOCALES) {
    for (const query of ["", "?class=car-k", "?type=car", "?time=10:00", "?package="]) {
      const path = `/${locale}/rentals${query}`;
      const form = filterForm(await listing(path), path);
      const [first, ...rest] = packageOptions(form);
      assert.equal(first?.value, "", `${path}: the first option`);
      assert.equal(first?.text, ANY[locale], `${path}: the first option's text`);
      assert.equal(chosen(form, "package"), "", `${path}: what is submitted`);
      // Every package is still offered, and none of them is the default.
      assert.deepEqual(
        rest.map(({ value }) => value).sort(),
        ["car-same", "car-two", "day-1", "day-3", "hours-6"],
        `${path}: packages`,
      );
      assert.deepEqual(rest.filter(({ selected }) => selected), [], `${path}: a package selected by default`);
    }

    // A chosen package is the selected one, and the empty choice is not.
    for (const packageId of ["day-1", "car-same", "car-two", "hours-6"]) {
      const path = `/${locale}/rentals?package=${packageId}`;
      const form = filterForm(await listing(path), path);
      assert.equal(chosen(form, "package"), packageId, `${path}: what is submitted`);
      const selected = packageOptions(form).filter(({ selected }) => selected);
      assert.deepEqual(selected.map(({ value }) => value), [packageId], `${path}: selected options`);
    }
  }
});

test("searching with the form's defaults and a date and time browses, with the prompt", async () => {
  const catalog = sheetCatalog(splitPackages);
  await publish(catalog);
  const [date] = openDates(catalog);

  const queries: { query: string; expected: string[] }[] = [
    { query: "", expected: ACTIVE },
    { query: "?class=car-k", expected: ["nbox-660"] },
  ];
  for (const locale of LOCALES) {
    for (const { query, expected } of queries) {
      const first = `/${locale}/rentals${query}`;
      const sent = defaultsOf(filterForm(await listing(first), first));
      sent.set("date", date);
      sent.set("time", "10:00");
      const path = `/${locale}/rentals?${sent}`;
      const main = await listing(path);
      assertBrowsing(main, expected, path);
      assertNotice(main, "data-search-prompt", locale, path);
      assert.equal(hookText(main, "data-search-error"), undefined, `${path}: a message`);
      assert.ok(!visibleText(main).includes(NO_VEHICLES[locale]), `${path}: says no vehicles match`);
      assert.ok(idsIn(main).includes("nbox-660"), `${path}: the car is not listed`);
      // The search keeps what the guest chose.
      const form = filterForm(main, path);
      assert.equal(dateInput(form, path).input.attributes.value, date, `${path}: date`);
      assert.equal(chosen(form, "time"), "10:00", `${path}: time`);
    }
  }
});

test("the date picker takes its package's days, and none when no package is chosen", async () => {
  await publish(sheetCatalog(splitPackages));

  for (const locale of LOCALES) {
    for (const query of ["", "?class=car-k", "?type=car", "?package="]) {
      const path = `/${locale}/rentals${query}`;
      const { picker } = dateInput(filterForm(await listing(path), path), path);
      assert.equal(picker.attributes["package-days"], undefined, `${path}: package-days`);
    }
    // Day packages of 1, 3, 1 and 2 days, so a fixed value cannot pass.
    const days: Record<string, string> = { "day-1": "1", "day-3": "3", "car-same": "1", "car-two": "2" };
    for (const [packageId, expected] of Object.entries(days)) {
      const path = `/${locale}/rentals?package=${packageId}`;
      const { picker } = dateInput(filterForm(await listing(path), path), path);
      assert.equal(picker.attributes["package-days"], expected, `${path}: package-days`);
    }
  }
});

test("a valid cc with type=car is ignored", async () => {
  const catalog = sheetCatalog(splitPackages);
  await publish(catalog);
  const [date] = openDates(catalog);

  // None of these bands fits the 660 cc car, so a cc that was applied would empty the list or hide the car's price.
  const bands = ["upto50", "51to125", "126to400", "over400"];
  for (const band of bands) {
    for (const locale of ["en", "ja"] as const) {
      const complete = `/${locale}/rentals?${searchQuery(date, { package: "car-same", type: "car", cc: band })}`;
      const main = await listing(complete);
      assertResults(main, ["nbox-660"], complete);
      const shown = card(main, "nbox-660", complete);
      assertPriced(shown, locale, "car-same", "8,000", complete);
      assert.deepEqual(amounts(shown, "data-deposit"), ["10,000"], `${complete}: deposit`);
      // The band is not selected in the form and is not carried to the model page.
      assert.ok(!bands.includes(chosen(filterForm(main, complete), "cc") ?? ""), `${complete}: the band is selected`);
      const href = shown.tag.attributes["href"] ?? "";
      assert.ok(!href.includes("cc="), `${complete}: the card carries the band: ${href}`);
      assert.ok(href.includes("type=car"), `${complete}: the card drops the type: ${href}`);
      assert.equal(hookText(main, "data-search-error"), undefined, `${complete}: a message for the ignored cc`);

      // Browsing the car's class with no package: the cc changes nothing about the car's own price.
      const browsing = `/${locale}/rentals?type=car&cc=${band}&class=car-k`;
      const listed = await listing(browsing);
      assertBrowsing(listed, ["nbox-660"], browsing);
      assertPriced(card(listed, "nbox-660", browsing), locale, "car-same", "8,000", browsing);
      assert.equal(hookText(listed, "data-search-error"), undefined, `${browsing}: a message for the ignored cc`);
    }
  }

  // A scooter search keeps its cc, so the band is ignored for cars only.
  const scooter = `/en/rentals?${searchQuery(date, { package: "day-1", type: "scooter", cc: "51to125" })}`;
  assertResults(await listing(scooter), ["pcx-125"], scooter);
});

// A search with a type and no package: each rate class of the type is checked on its own default package.

/** A search with a type and the package left on "Any", which the form sends as an empty param. */
function anyPackage(date: string, type: string, params: Record<string, string> = {}): string {
  return new URLSearchParams({ date, time: "10:00", package: "", type, ...params }).toString();
}

/**
 * The split catalog with classes of one type on different packages, so that no one package fits a whole type, and with
 * model sort running against the order of those packages. Each model has one active vehicle:
 *   scooter     pcx-125 (bike-125, day-3 only, わ1002), today-50 (scooter-50, day-1, わ1001), tied with pcx-125 on sort,
 *               and vino-50 (scooter-50, わ1016)
 *   motorcycle  rebel-250 (bike-400, day-3 only, わ1005), hawk-750 (bike-750, day-1, わ1017)
 *   car         note-1300 (car-m, car-two only, わ1018), nbox-660 (car-k, car-same, わ1006)
 */
function ownPackages(workbook: Workbook): void {
  splitPackages(workbook);
  removeRow(workbook, "Prices", "bike-125/day-1");
  removeRow(workbook, "Prices", "bike-400/day-1");
  setCell(workbook, "Models", "pcx-125", "sort", 1);

  appendCopy(workbook, "Models", "today-50", { model_id: "vino-50", sort: 3, photos: "" });
  appendCopy(workbook, "Vehicles", "わ1001", { plate: "わ1016", model_id: "vino-50" });

  appendCopy(workbook, "RateClasses", "bike-400", { rate_class_id: "bike-750", sort: 9 });
  appendRow(workbook, "Prices", { rate_class_id: "bike-750", package_id: "day-1", price_jpy: 31415 });
  appendCopy(workbook, "Models", "rebel-250", {
    model_id: "hawk-750",
    rate_class_id: "bike-750",
    engine_cc: 750,
    sort: 9,
    photos: "",
  });
  appendCopy(workbook, "Vehicles", "わ1005", { plate: "わ1017", model_id: "hawk-750" });

  appendCopy(workbook, "RateClasses", "car-k", { rate_class_id: "car-m", sort: 9 });
  appendRow(workbook, "Prices", { rate_class_id: "car-m", package_id: "car-two", price_jpy: 21000 });
  appendCopy(workbook, "Models", "nbox-660", {
    model_id: "note-1300",
    rate_class_id: "car-m",
    engine_cc: 1300,
    sort: 1,
    photos: "",
  });
  appendCopy(workbook, "Vehicles", "わ1006", { plate: "わ1018", model_id: "note-1300" });
}

/** Everything ownPackages lists with nothing booked, by type, in the order of a search. */
const OWN_RESULTS: Record<VehicleTypeId, { id: string; packageId: string; price: string; deposit: string }[]> = {
  scooter: [
    { id: "pcx-125", packageId: "day-3", price: "13,800", deposit: "3,000" },
    { id: "today-50", packageId: "day-1", price: "3,500", deposit: "3,000" },
    { id: "vino-50", packageId: "day-1", price: "3,500", deposit: "3,000" },
  ],
  motorcycle: [
    { id: "rebel-250", packageId: "day-3", price: "24,700", deposit: "5,000" },
    { id: "hawk-750", packageId: "day-1", price: "31,415", deposit: "5,000" },
  ],
  car: [
    { id: "note-1300", packageId: "car-two", price: "21,000", deposit: "10,000" },
    { id: "nbox-660", packageId: "car-same", price: "8,000", deposit: "10,000" },
  ],
};

/** The active models of ownPackages, whatever their order. */
const OWN_ACTIVE = Object.values(OWN_RESULTS).flatMap((models) => models.map(({ id }) => id));

test("a type with a date and time and no package searches that type", async () => {
  // Active with nothing to rent, and inactive with a free vehicle, so neither the fleet nor the flag decides alone.
  const catalog = sheetCatalog((workbook) => {
    splitPackages(workbook);
    appendCopy(workbook, "Models", "pcx-125", { model_id: "no-bike-125", sort: 7, photos: "" });
    setCell(workbook, "Vehicles", "わ1004", "status", "active");
  });
  await publish(catalog);
  const [date] = openDates(catalog);

  const expected: Record<VehicleTypeId, string[]> = {
    scooter: ["today-50", "pcx-125"],
    motorcycle: ["rebel-250"],
    car: ["nbox-660"],
  };
  for (const locale of LOCALES) {
    for (const [type, ids] of Object.entries(expected)) {
      for (const time of ["09:30", "14:00"]) {
        // Left on "Any" and left out, which a link may do.
        for (const query of [anyPackage(date, type, { time }), `date=${date}&time=${time}&type=${type}`]) {
          const path = `/${locale}/rentals?${query}`;
          const main = await listing(path);
          assertResults(main, ids, path);
          for (const id of ids) {
            const own = OWN[id] as (typeof OWN)[string];
            const shown = card(main, id, path);
            assertPriced(shown, locale, own.packageId, own.price, path);
            assert.deepEqual(amounts(shown, "data-deposit"), [own.deposit], `${path}: deposit of ${id}`);
          }
          assert.ok(!visibleText(main).includes(NOT_OFFERED[locale]), `${path}: says not offered`);
          assert.ok(!visibleText(main).includes(NO_VEHICLES[locale]), `${path}: says no vehicles match`);
        }
      }
    }
  }
});

test("each class of the type searches on its own package, and the models keep their sort", async () => {
  const catalog = sheetCatalog(ownPackages);
  await publish(catalog);
  const [date] = openDates(catalog);

  for (const locale of LOCALES) {
    for (const [type, models] of Object.entries(OWN_RESULTS)) {
      const path = `/${locale}/rentals?${anyPackage(date, type)}`;
      const main = await listing(path);
      assertResults(main, models.map(({ id }) => id), path);
      for (const { id, packageId, price, deposit } of models) {
        const shown = card(main, id, path);
        assertPriced(shown, locale, packageId, price, path);
        assert.deepEqual(amounts(shown, "data-deposit"), [deposit], `${path}: deposit of ${id}`);
      }
    }
  }
});

test("a package's whole window decides whether its class is free", async () => {
  const catalog = sheetCatalog(ownPackages);
  await publish(catalog);
  const open = openDates(catalog);
  const date = open[0] as string;
  const otherDay = open.at(-1) as string;

  const results = async (type: string, expected: string[], label: string) => {
    const path = `/en/rentals?${anyPackage(date, type)}`;
    assertResults(await listing(path), expected, `${label}: ${path}`);
  };
  const book = (plate: string, days: number) =>
    seedBooking(worker.db, {
      vehicle_plate: plate,
      start_at: jstToEpoch(addDaysToDate(date, days), "10:00"),
      end_at: jstToEpoch(addDaysToDate(date, days), "18:00"),
    });

  // The third day is past today-50's one day, and it is the return day of pcx-125's three.
  await book("わ1001", 2);
  await results("scooter", ["pcx-125", "today-50", "vino-50"], "today-50 is booked after its rental");
  await book("わ1002", 2);
  await results("scooter", ["today-50", "vino-50"], "pcx-125 is booked on its last day");
  await book("わ1001", 0);
  await results("scooter", ["vino-50"], "today-50 is booked on the day");

  // The same across the car packages, one day and two.
  await book("わ1006", 1);
  await results("car", ["note-1300", "nbox-660"], "nbox-660 is booked after its rental");
  await book("わ1018", 1);
  await results("car", ["nbox-660"], "note-1300 is booked on its last day");

  // The class left over is no fallback for one that has nothing free: a type sold out is a search with no results.
  await book("わ1006", 0);
  await results("car", [], "every car is booked");
  const path = `/en/rentals?${anyPackage(date, "car")}`;
  assert.ok(visibleText(await listing(path)).includes(NO_VEHICLES.en), `${path}: says nothing about the empty list`);

  // Sold out on those days alone.
  const free = `/en/rentals?${anyPackage(otherDay, "car")}`;
  assertResults(await listing(free), ["note-1300", "nbox-660"], free);
});

test("an hours package never stands in for a class's day package", async () => {
  // hours-6 sorts first. bike-400 keeps its hours price alone here, and car-k gets one in front of its day packages.
  const catalog = sheetCatalog((workbook) => {
    ownPackages(workbook);
    removeRow(workbook, "Prices", "bike-400/day-3");
    appendRow(workbook, "Prices", { rate_class_id: "car-k", package_id: "hours-6", price_jpy: 4000 });
  });
  await publish(catalog);
  const [date] = openDates(catalog);

  for (const locale of LOCALES) {
    // A class with no day package has nothing to search on.
    const bikes = `/${locale}/rentals?${anyPackage(date, "motorcycle")}`;
    const bikeResults = await listing(bikes);
    assertResults(bikeResults, ["hawk-750"], bikes);
    assertPriced(card(bikeResults, "hawk-750", bikes), locale, "day-1", "31,415", bikes);

    const cars = `/${locale}/rentals?${anyPackage(date, "car")}`;
    const carResults = await listing(cars);
    assertResults(carResults, ["note-1300", "nbox-660"], cars);
    assertPriced(card(carResults, "nbox-660", cars), locale, "car-same", "8,000", cars);
  }
});

test("the pickup window holds with a type and no package", async () => {
  const catalog = { ...sheetCatalog(ownPackages), closedDates: [] };
  const [pickup] = openDates(catalog);
  const closed = addDaysToDate(pickup, 5);
  await publish({ ...catalog, closedDates: [closed] });
  const today = jstToday(Date.now());

  // Each spoils a good search, which then gets what the same search with a chosen package gets. The last ones are what a
  // request can throw at the page.
  const spoiled: Record<string, string>[] = [
    { date: closed },
    { date: today },
    { date: addDaysToDate(today, -1) },
    { date: addDaysToDate(today, 500) },
    { date: "9999-12-31" },
    { time: "10:15" },
    { time: "08:00" },
    { time: "18:00" },
    { date: "2030-02-30" },
    { date: "99999-01-01" },
    { date: "not-a-date" },
    { time: "25:00" },
    { time: "noon" },
    { type: "plane" },
    { type: "toString" },
    { package: "week" },
    { cc: "all" },
    { class: "nope" },
  ];
  for (const type of ["car", "scooter"]) {
    for (const params of spoiled) {
      const label = JSON.stringify({ type, ...params });
      const path = `/en/rentals?${anyPackage(pickup, type, params)}`;
      const main = await listing(path);
      assertBrowsing(main, OWN_ACTIVE, path);
      assertNotice(main, "data-search-error", "en", path);

      const with1Day = `/en/rentals?${anyPackage(pickup, type, { package: "day-1", ...params })}`;
      const expected = await listing(with1Day);
      assert.equal(hookText(main, "data-search-error"), hookText(expected, "data-search-error"), `${label}: message`);
      assert.deepEqual(idsIn(main), idsIn(expected), `${label}: list`);
      const form = filterForm(main, path);
      const formExpected = filterForm(expected, with1Day);
      assert.equal(
        dateInput(form, path).input.attributes.value,
        dateInput(formExpected, with1Day).input.attributes.value,
        `${label}: date`,
      );
      assert.equal(chosen(form, "time"), chosen(formExpected, "time"), `${label}: time`);
    }
  }

  // The message comes in the reader's locale.
  for (const locale of LOCALES) {
    const path = `/${locale}/rentals?${anyPackage(closed, "car")}`;
    const main = await listing(path);
    assertBrowsing(main, OWN_ACTIVE, path);
    assertNotice(main, "data-search-error", locale, path);
  }
});

test("a class whose own package returns on a closed date is not listed", async () => {
  const catalog = { ...sheetCatalog(ownPackages), closedDates: [] };
  const [pickup] = openDates(catalog);

  // A return the guest never chose is no error of theirs: the classes that can start here are still found.
  await publish({ ...catalog, closedDates: [addDaysToDate(pickup, 2)] });
  const scooters = `/en/rentals?${anyPackage(pickup, "scooter")}`;
  assertResults(await listing(scooters), ["today-50", "vino-50"], scooters);
  const bikes = `/en/rentals?${anyPackage(pickup, "motorcycle")}`;
  assertResults(await listing(bikes), ["hawk-750"], bikes);
  const cars = `/en/rentals?${anyPackage(pickup, "car")}`;
  assertResults(await listing(cars), ["note-1300", "nbox-660"], cars);

  await publish({ ...catalog, closedDates: [addDaysToDate(pickup, 1)] });
  assertResults(await listing(cars), ["nbox-660"], cars);

  // The closed date past every return stops nothing.
  await publish({ ...catalog, closedDates: [addDaysToDate(pickup, 3)] });
  assertResults(await listing(scooters), ["pcx-125", "today-50", "vino-50"], scooters);
});

test("a type whose every class returns on a closed date gets the closed-return message", async () => {
  // Every car on car-two and every motorcycle on day-3, while the scooters keep a class on day-1.
  const fixture = sheetCatalog((workbook) => {
    ownPackages(workbook);
    removeRow(workbook, "Prices", "car-k/car-same");
    removeRow(workbook, "Prices", "bike-750/day-1");
    appendRow(workbook, "Prices", { rate_class_id: "bike-750", package_id: "day-3", price_jpy: 31415 });
  });
  const catalog = { ...fixture, closedDates: [] };
  const [pickup] = openDates(catalog);

  // One type refused and the others searched on the same date, so a message over the whole date cannot pass.
  const cases: { closedIn: number; type: string; packageId: string; others: Record<string, string[]> }[] = [
    {
      closedIn: 1,
      type: "car",
      packageId: "car-two",
      others: { scooter: ["pcx-125", "today-50", "vino-50"], motorcycle: ["rebel-250", "hawk-750"] },
    },
    {
      closedIn: 2,
      type: "motorcycle",
      packageId: "day-3",
      others: { scooter: ["today-50", "vino-50"], car: ["note-1300", "nbox-660"] },
    },
  ];
  for (const { closedIn, type, packageId, others } of cases) {
    await publish({ ...catalog, closedDates: [addDaysToDate(pickup, closedIn)] });
    for (const locale of LOCALES) {
      const path = `/${locale}/rentals?${anyPackage(pickup, type)}`;
      const main = await listing(path);
      assertBrowsing(main, OWN_ACTIVE, path);
      assertNotice(main, "data-search-error", locale, path);
      assert.ok(!visibleText(main).includes(NO_VEHICLES[locale]), `${path}: says no vehicles match`);

      // What the guest would get with the package chosen, except that the package stays theirs to choose.
      const withPackage = `/${locale}/rentals?${anyPackage(pickup, type, { package: packageId })}`;
      const expected = await listing(withPackage);
      assert.equal(hookText(main, "data-search-error"), hookText(expected, "data-search-error"), `${path}: message`);
      assert.equal(hookText(main, "data-search-prompt"), hookText(expected, "data-search-prompt"), `${path}: prompt`);
      const form = filterForm(main, path);
      assert.equal(dateInput(form, path).input.attributes.value, undefined, `${path}: the date stays in the form`);
      assert.equal(chosen(form, "time"), "10:00", `${path}: time`);
      assert.equal(chosen(form, "type"), type, `${path}: type`);
      assert.equal(chosen(form, "package"), "", `${path}: a package was chosen for the guest`);
      assert.equal(dateInput(form, path).picker.attributes["package-days"], undefined, `${path}: package-days`);

      for (const [other, ids] of Object.entries(others)) {
        const search = `/${locale}/rentals?${anyPackage(pickup, other)}`;
        assertResults(await listing(search), ids, search);
      }
    }
  }

  // A class left out by the closed return is not sold out, and the classes that were searched truly are.
  const scooters = `/en/rentals?${anyPackage(pickup, "scooter")}`;
  for (const plate of ["わ1001", "わ1016"]) {
    await seedBooking(worker.db, {
      vehicle_plate: plate,
      start_at: jstToEpoch(pickup, "10:00"),
      end_at: jstToEpoch(pickup, "18:00"),
    });
  }
  const soldOut = await listing(scooters);
  assertResults(soldOut, [], scooters);
  assert.ok(visibleText(soldOut).includes(NO_VEHICLES.en), `${scooters}: says nothing about the empty list`);
});

test("no package is invented by a search with a type", async () => {
  const catalog = sheetCatalog(ownPackages);
  await publish(catalog);
  const [date] = openDates(catalog);

  for (const locale of LOCALES) {
    for (const [type, models] of Object.entries(OWN_RESULTS)) {
      const path = `/${locale}/rentals?${anyPackage(date, type, { time: "11:30" })}`;
      const main = await listing(path);
      const ids = models.map(({ id }) => id);
      assertResults(main, ids, path);

      const form = filterForm(main, path);
      assert.equal(chosen(form, "package"), "", `${path}: what the package select submits`);
      assert.deepEqual(packageOptions(form).filter(({ selected }) => selected), [], `${path}: a package selected`);
      assert.equal(packageOptions(form)[0]?.text, ANY[locale], `${path}: the first option's text`);
      assert.equal(dateInput(form, path).picker.attributes["package-days"], undefined, `${path}: package-days`);
      assert.equal(dateInput(form, path).input.attributes.value, date, `${path}: date`);
      assert.equal(chosen(form, "time"), "11:30", `${path}: time`);
      assert.equal(chosen(form, "type"), type, `${path}: type`);

      // The form sent again as it stands is the same search.
      const again = `/${locale}/rentals?${defaultsOf(form)}`;
      assertResults(await listing(again), ids, again);
    }
  }
});

test("a card of a search with a type carries the search and no package", async () => {
  const catalog = sheetCatalog(ownPackages);
  await publish(catalog);
  const [date] = openDates(catalog);

  const cases: { params: Record<string, string>; expected: string[] }[] = [
    { params: { date, time: "13:30", type: "scooter" }, expected: ["pcx-125", "today-50", "vino-50"] },
    { params: { date, time: "09:00", type: "car" }, expected: ["note-1300", "nbox-660"] },
    { params: { date, time: "10:00", type: "scooter", cc: "51to125" }, expected: ["pcx-125"] },
    { params: { date, time: "10:00", type: "motorcycle", class: "bike-750" }, expected: ["hawk-750"] },
  ];
  for (const locale of LOCALES) {
    for (const { params, expected } of cases) {
      const path = `/${locale}/rentals?${new URLSearchParams(params)}`;
      const main = await listing(path);
      assertResults(main, expected, path);
      for (const { id, tag } of cardsIn(main)) {
        const target = new URL(tag.attributes.href ?? "", new URL(path, base));
        assert.equal(target.pathname.replace(/\/$/, ""), `/${locale}/rentals/${id}`, `${path}: link of ${id}`);
        assert.deepEqual(Object.fromEntries(target.searchParams), params, `${path}: search carried by ${id}`);
        // The model page offers its own choice of package.
        await pageHtml(`${target.pathname}${target.search}`);
      }
    }
  }
});

test("class and engine narrow a search with a type, and a chosen package is searched alone", async () => {
  const catalog = sheetCatalog(ownPackages);
  await publish(catalog);
  const [date] = openDates(catalog);

  const narrowed: { type: string; filters: Record<string, string>; expected: string[] }[] = [
    { type: "scooter", filters: { class: "bike-125" }, expected: ["pcx-125"] },
    { type: "scooter", filters: { class: "scooter-50" }, expected: ["today-50", "vino-50"] },
    { type: "motorcycle", filters: { class: "bike-750" }, expected: ["hawk-750"] },
    { type: "car", filters: { class: "car-m" }, expected: ["note-1300"] },
    { type: "car", filters: { class: "bike-125" }, expected: [] },
    { type: "scooter", filters: { cc: "51to125" }, expected: ["pcx-125"] },
    { type: "scooter", filters: { cc: "upto50" }, expected: ["today-50", "vino-50"] },
    { type: "scooter", filters: { cc: "over400" }, expected: [] },
    { type: "motorcycle", filters: { cc: "over400" }, expected: ["hawk-750"] },
    { type: "motorcycle", filters: { cc: "126to400" }, expected: ["rebel-250"] },
    // A band means nothing for a car.
    { type: "car", filters: { cc: "upto50" }, expected: ["note-1300", "nbox-660"] },
  ];
  for (const locale of ["en", "ko"] as const) {
    for (const { type, filters, expected } of narrowed) {
      const path = `/${locale}/rentals?${anyPackage(date, type, filters)}`;
      assertResults(await listing(path), expected, path);
    }
  }

  // The same catalog with a package chosen: that package alone decides, for the models it prices, and so does its window.
  const chosenSearches: { type: string; packageId: string; expected: string[] }[] = [
    { type: "scooter", packageId: "day-1", expected: ["today-50", "vino-50"] },
    { type: "scooter", packageId: "day-3", expected: ["pcx-125", "today-50", "vino-50"] },
    { type: "motorcycle", packageId: "day-3", expected: ["rebel-250"] },
    { type: "car", packageId: "car-same", expected: ["nbox-660"] },
    { type: "car", packageId: "car-two", expected: ["note-1300", "nbox-660"] },
    // What the guest chose stands, even across types.
    { type: "scooter", packageId: "car-same", expected: [] },
    { type: "car", packageId: "day-1", expected: [] },
  ];
  for (const { type, packageId, expected } of chosenSearches) {
    const path = `/en/rentals?${anyPackage(date, type, { package: packageId })}`;
    const main = await listing(path);
    assertResults(main, expected, path);
    assert.equal(chosen(filterForm(main, path), "package"), packageId, `${path}: package select`);
    assertMoney(main, catalog, packageId, path);
  }

  // A search is still a date and a time: without either the type waits for it.
  for (const query of [`type=car&date=${date}`, `type=car&date=${date}&time=&package=`, "type=car&time=10:00"]) {
    const path = `/en/rentals?${query}`;
    const main = await listing(path);
    assertBrowsing(main, OWN_ACTIVE, path);
    assertNotice(main, "data-search-prompt", "en", path);
  }
});

// The card.

test("a card links to the model page and carries the search", async () => {
  const catalog = sheetCatalog();
  await publish(catalog);
  const [date] = openDates(catalog);

  const cases: { locale: Locale; params: Record<string, string>; expected: string[] }[] = [
    {
      locale: "ko",
      params: { date: date, time: "10:30", package: "day-3", type: "scooter", cc: "51to125", class: "bike-125" },
      expected: ["pcx-125"],
    },
    {
      locale: "ja",
      params: { date: date, time: "14:00", package: "day-1" },
      expected: ACTIVE,
    },
    { locale: "en", params: { package: "day-3" }, expected: ACTIVE },
    { locale: "zh-cn", params: { class: "bike-400", package: "day-1" }, expected: ["rebel-250"] },
  ];
  for (const { locale, params, expected } of cases) {
    const query = Object.entries(params)
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const path = `/${locale}/rentals?${query}`;
    const shown = cardsIn(await listing(path));
    assert.deepEqual(shown.map(({ id }) => id).sort(), [...expected].sort(), path);
    for (const { id, tag } of shown) {
      const target = new URL(tag.attributes.href ?? "", new URL(path, base));
      assert.equal(target.pathname.replace(/\/$/, ""), `/${locale}/rentals/${id}`, `${path}: link of ${id}`);
      assert.deepEqual(Object.fromEntries(target.searchParams), params, `${path}: search carried by ${id}`);
    }
  }

  // With no search there is no pickup to carry.
  for (const { id, tag } of cardsIn(await listing("/en/rentals"))) {
    const target = new URL(tag.attributes.href ?? "", new URL("/en/rentals", base));
    assert.equal(target.pathname.replace(/\/$/, ""), `/en/rentals/${id}`, `link of ${id}`);
    assert.ok(!target.searchParams.has("date"), `${id} links with a date nobody chose`);
  }
});

test("a card shows the model's photo, or a placeholder without one", async () => {
  const catalog = sheetCatalog((workbook) => {
    setCell(workbook, "Models", "today-50", "photos", "");
  });
  await publish(catalog);

  const copied = async (name: string, md5: string, key: string) => {
    const row = { name, drive_file_id: `drive-${name}`, md5, r2_key: key, content_type: "image/jpeg", bytes: 10 };
    await insertRow(worker.db, "photos", { ...row, copied_at: Date.now() });
  };
  const pcxKey = `photos/${"a".repeat(32)}.jpg`;
  const rebelKey = `photos/${"b".repeat(32)}.webp`;
  await copied("pcx-1.jpg", "a".repeat(32), pcxKey);
  await copied("rebel-1.jpg", "b".repeat(32), rebelKey);

  const images = (shown: Card) => tagsIn(shown.html).filter(({ name }) => name === "img" || name === "svg");
  const sources = (shown: Card) =>
    images(shown).flatMap(({ name, attributes }) => (name === "img" ? [attributes.src ?? ""] : []));

  for (const locale of LOCALES) {
    const path = `/${locale}/rentals`;
    const main = await listing(path);
    assert.equal(sources(card(main, "pcx-125", path)).at(0), `/media/${pcxKey}`, `${path}: photo of pcx-125`);
    assert.equal(sources(card(main, "rebel-250", path)).at(0), `/media/${rebelKey}`, `${path}: photo of rebel-250`);

    // today-50 names no photo, and nbox-660 names one that has not been copied yet.
    for (const id of ["today-50", "nbox-660"]) {
      const shown = card(main, id, path);
      assert.ok(images(shown).length > 0, `${path}: ${id} has no image`);
      for (const src of sources(shown)) {
        assert.notEqual(src, "", `${path}: ${id} has an image with no source`);
        assert.ok(!src.startsWith("/media/"), `${path}: ${id} points at a photo it does not have: ${src}`);
      }
    }
  }
});

test("the engine select is hidden for cars", async () => {
  const catalog = sheetCatalog();
  await publish(catalog);
  const [date] = openDates(catalog);

  /** Whether a guest sees the cc select. Absent counts as hidden. */
  const engineShown = (form: string, label: string): boolean => {
    const tags = tagsIn(form);
    if (!tags.some(({ name, attributes }) => name === "select" && attributes.name === "cc")) return false;
    const holder = tags.find(({ attributes }) => "data-engine-filter" in attributes);
    assert.ok(holder, `${label}: the cc select has no data-engine-filter around it`);
    return !("hidden" in holder.attributes);
  };

  for (const locale of LOCALES) {
    const carQueries = ["?type=car", `?${searchQuery(date, { type: "car" })}`];
    for (const query of carQueries) {
      const path = `/${locale}/rentals${query}`;
      assert.equal(engineShown(filterForm(await listing(path), path), path), false, `${path}: engine select shown`);
    }

    const otherQueries = ["", "?type=scooter", "?type=motorcycle", `?${searchQuery(date, { type: "scooter" })}`];
    for (const query of otherQueries) {
      const path = `/${locale}/rentals${query}`;
      assert.equal(engineShown(filterForm(await listing(path), path), path), true, `${path}: engine select hidden`);
    }
  }
});

// Routing.

test("the listing returns 200 for each locale and 404 for unknown ones", async () => {
  const langs: Record<Locale, string> = { ja: "ja", en: "en", "zh-cn": "zh-CN", ko: "ko" };
  await publish(sheetCatalog());

  for (const [index, locale] of LOCALES.entries()) {
    // The header of another locale must not move the reader.
    const headers = { "Accept-Language": LOCALES[(index + 1) % LOCALES.length] as Locale };
    for (const page of ["/rentals", "/rentals/", "/rentals?type=scooter"]) {
      const path = `/${locale}${page}`;
      const res = await worker.fetch(path, { headers, redirect: "manual" });
      const html = await res.text();
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
      assert.equal(tagsIn(html).find(({ name }) => name === "html")?.attributes.lang, langs[locale], `${path} lang`);
    }
  }

  const unknown = ["fr", "zh", "zh-tw", "zh-CN", "ZH-CN", "JA", "En", "en-us", "constructor", "__proto__", "0", "ja%20"];
  for (const segment of unknown) {
    for (const page of ["/rentals", "/rentals/", "/rentals?type=scooter"]) {
      const path = `/${segment}${page}`;
      const res = await worker.fetch(path, { redirect: "manual" });
      await res.text();
      assert.equal(res.status, 404, path);
    }
  }
});

test("the listing renders before the first publish", async () => {
  // A worker of its own, because the others in this file publish into theirs. searchAvailability throws here.
  const empty = await startWorker();
  try {
    const date = addDaysToDate(jstToday(Date.now()), 5);
    for (const locale of LOCALES) {
      for (const query of ["", "?type=plane", `?date=${date}&time=10:00&package=day-1`, "?class=bike-125&package=day-1"]) {
        const path = `/${locale}/rentals${query}`;
        assert.deepEqual(idsIn(mainOf(await pageHtml(path, empty), path)), [], path);
      }
    }
  } finally {
    await empty.stop();
  }
});
