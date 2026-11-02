// The fee schedule, through the built Worker, over catalogs that go through validateCatalog and replaceCatalog as a publish
// does. Expected prices come from the hand-written fixture or from literals here. The tables are read the way a browser reads
// them: <tr> rows, real <th> headers, and each cell matched to its headers by position. Anything under a `hidden` attribute
// does not count as shown, so a page may render a row and hide it. Filters are the query params `group` (bike or car), `class`
// (a rate class id) and `duration` (a package id). These hooks are the page's contract with this file:
//   data-fee-table="bike|car"          on each <table> of prices. A group with nothing to show has none
//   data-rates-error                   the message about invalid params
//   data-extension="<class id>"        the element with a class's name and its hourly extension price
//   data-option="<option id>"          the <tr> of an option: its name, then its base, per-hour and per-24-hours prices
//   data-draft-note="coverage|peak"    each note that waits for the shop to confirm it
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { common } from "../../src/i18n/strings/common.ts";
import { validateCatalog } from "../../src/lib/catalog/sheet-schema.ts";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import type { Catalog } from "../../src/lib/types.ts";
import { mainOf, tagsIn, visibleText, type Tag } from "../helpers/html.ts";
import { appendCopy, expectedCatalog, setCell, validWorkbook, type Workbook } from "../helpers/sheet-workbook.ts";
import { startWorker, type TestWorker } from "../helpers/worker.ts";

const base = "http://localhost/";

/** The publish time validateCatalog is given, fixed so the fixture's closed dates stay inside its window as the years pass. */
const SHEET_NOW = Date.parse("2026-11-02T12:00:00+09:00");

type Layout = Partial<Record<"bike" | "car", { classes: string[]; packages: string[] }>>;

const BIKES = ["scooter-50", "bike-125", "bike-400"];
const BIKE_PACKAGES = ["hours-6", "day-1", "day-3"];
/** The fixture has no hours-6 price for car-k, so no car class prices that package. */
const CAR_PACKAGES = ["day-1", "day-3"];

const BIKE_TABLE = { classes: BIKES, packages: BIKE_PACKAGES };
const CAR_TABLE = { classes: ["car-k"], packages: CAR_PACKAGES };
const WHOLE: Layout = { bike: BIKE_TABLE, car: CAR_TABLE };

let worker: TestWorker;

before(async () => {
  worker = await startWorker();
});

after(async () => {
  await worker?.stop();
});

/** The fixture sheet after `edit`, as a publish reads it. */
function sheetCatalog(edit: (workbook: Workbook) => void = () => {}): Catalog {
  const workbook = validWorkbook();
  edit(workbook);
  const { catalog, fatal } = validateCatalog(workbook, SHEET_NOW);
  assert.deepEqual(fatal, []);
  assert.ok(catalog, "the fixture does not validate");
  return catalog;
}

async function publish(catalog: Catalog): Promise<void> {
  await replaceCatalog(worker.db, catalog, { now: Date.now(), source: "sheet" });
}

async function pageHtml(path: string, target: TestWorker = worker): Promise<string> {
  const res = await target.fetch(path, { redirect: "manual" });
  const html = await res.text();
  assert.equal(res.status, 200, path);
  return html;
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

const VOID_TAGS = ["input", "img", "br", "hr", "col", "link", "meta"];

/** `html` without the elements `drop` picks. */
function without(html: string, drop: (tag: Tag) => boolean): string {
  for (;;) {
    const tag = tagsIn(html).find((candidate) => drop(candidate));
    if (tag === undefined) return html;
    const whole = VOID_TAGS.includes(tag.name) ? "" : elementAt(html, tag);
    const end = whole === "" ? html.indexOf(">", tag.index) + 1 : tag.index + whole.length;
    html = html.slice(0, tag.index) + html.slice(end);
  }
}

/** The content of `<main>` a guest sees. */
async function schedule(path: string, target: TestWorker = worker): Promise<string> {
  return without(mainOf(await pageHtml(path, target), path), ({ attributes }) => "hidden" in attributes);
}

/** The elements with `hook`, or with `hook` set to `value`. */
function hooked(html: string, hook: string, value?: string): Tag[] {
  return tagsIn(html).filter(({ attributes }) => {
    const found = attributes[hook];
    return found !== undefined && (value === undefined || found === value);
  });
}

/** The text of the element with `hook`, or undefined when the page has none. */
function hookText(html: string, hook: string): string | undefined {
  const tag = hooked(html, hook)[0];
  return tag === undefined ? undefined : visibleText(elementAt(html, tag));
}

/** Every amount written as yen, as its digits and separators. visibleText has folded ￥ and full-width digits to ASCII. */
function yenIn(text: string): string[] {
  const amount = String.raw`\d{1,3}(?:,\d{3})*(?!\d|,\d)|\d+(?!\d|,\d)`;
  const pattern = new RegExp(`¥\\s*(${amount})|(?<![\\d,])(${amount})\\s*(?:円|엔|日元|日圆)`, "g");
  return [...text.matchAll(pattern)].map((match) => (match[1] ?? match[2]) as string);
}

/** 1234500 as 1,234,500, worked out here and not with Intl, which is what the page may use. */
function grouped(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+$)/g, ",");
}

/** A name as visibleText gives it. */
function shownName({ texts }: { texts: Record<Locale, { name: string }> }, locale: Locale): string {
  return texts[locale].name.normalize("NFKC");
}

type Cell = { tag: Tag; html: string; text: string };
type Row = { head: Cell; cells: Cell[] };
type FeeTable = { group: string; columns: Cell[]; rows: Row[] };

function cellsIn(row: string): Cell[] {
  return tagsIn(row)
    .filter(({ name }) => name === "th" || name === "td")
    .map((tag) => {
      const html = elementAt(row, tag);
      return { tag, html, text: visibleText(html) };
    });
}

function assertHeader({ tag, text }: Cell, scope: string, label: string): void {
  assert.equal(tag.name, "th", `${label}: "${text}" is not a <th>`);
  assert.equal(tag.attributes.scope, scope, `${label}: the scope of "${text}"`);
}

/** The page's price tables. Packages must be column headers, classes row headers, prices <td> under them. */
function feeTables(main: string, label: string): FeeTable[] {
  return hooked(main, "data-fee-table").map((tag) => {
    const group = tag.attributes["data-fee-table"] as string;
    const where = `${label}: the ${group} table`;
    assert.equal(tag.name, "table", `${where} is not a <table>`);
    const table = elementAt(main, tag);
    const lines = tagsIn(table)
      .filter(({ name }) => name === "tr")
      .map((row) => cellsIn(elementAt(table, row)));
    const [header, ...body] = lines;
    assert.ok(header, `${where} has no rows`);
    const columns = header.slice(1);
    for (const column of columns) assertHeader(column, "col", where);
    const rows = body.map(([head, ...cells]) => {
      assert.ok(head, `${where} has an empty row`);
      assertHeader(head, "row", where);
      assert.equal(cells.length, columns.length, `${where}: the cells of "${head.text}" do not line up with the headers`);
      for (const { tag: cell, text } of cells) assert.equal(cell.name, "td", `${where}: "${text}" is not a <td>`);
      return { head, cells };
    });
    return { group, columns, rows };
  });
}

/** The prices of a table as a grid, null for a cell without one. */
function grid({ rows }: FeeTable): (string | null)[][] {
  return rows.map(({ cells }) => cells.map(({ text }) => yenIn(text)[0] ?? null));
}

function tableOf(main: string, group: string, label: string): FeeTable {
  const table = feeTables(main, label).find((candidate) => candidate.group === group);
  assert.ok(table, `${label}: no ${group} table`);
  return table;
}

function priceOf(sheet: Catalog, rateClassId: string, packageId: string): number | undefined {
  return sheet.prices.find((row) => row.rateClassId === rateClassId && row.packageId === packageId)?.priceJpy;
}

function assertEmpty(cell: Cell, label: string): void {
  assert.equal(cell.text, "", `${label}: an empty cell holds "${cell.text}"`);
  assert.deepEqual(tagsIn(cell.html).filter(({ name }) => name === "a"), [], `${label}: an empty cell holds a link`);
}

/** The page shows `expected` and no other table: headers in the locale, and in each cell the sheet's price or nothing. */
function assertLayout(main: string, sheet: Catalog, locale: Locale, expected: Layout, label: string): void {
  const tables = feeTables(main, label);
  assert.deepEqual(tables.map(({ group }) => group).sort(), Object.keys(expected).sort(), `${label}: tables`);
  for (const table of tables) {
    const { classes, packages } = expected[table.group as "bike" | "car"] as { classes: string[]; packages: string[] };
    const where = `${label}: ${table.group}`;
    const named = <T extends { id: string; texts: Record<Locale, { name: string }> }>(all: T[], id: string) => {
      const found = all.find((row) => row.id === id);
      assert.ok(found, `the sheet has no ${id}`);
      return shownName(found, locale);
    };
    const columns = packages.map((id) => named(sheet.packages, id));
    assert.deepEqual(table.columns.map(({ text }) => text), columns, `${where} columns`);
    const rows = classes.map((id) => named(sheet.rateClasses, id));
    assert.deepEqual(table.rows.map(({ head }) => head.text), rows, `${where} rows`);
    table.rows.forEach(({ cells }, row) => {
      cells.forEach((cell, column) => {
        const [classId, packageId] = [classes[row] as string, packages[column] as string];
        const price = priceOf(sheet, classId, packageId);
        const at = `${where}: ${classId}/${packageId}`;
        if (price === undefined) assertEmpty(cell, at);
        else assert.deepEqual(yenIn(cell.text), [grouped(price)], at);
      });
    });
  }
}

/** Below the table: each class's hourly extension and each option, with their names, equal the sheet. */
function assertExtras(main: string, sheet: Catalog, locale: Locale, label: string): void {
  for (const rateClass of sheet.rateClasses) {
    const tags = hooked(main, "data-extension", rateClass.id);
    const where = `${label}: extension of ${rateClass.id}`;
    if (rateClass.extensionPerHourJpy === null) {
      for (const tag of tags) assert.deepEqual(yenIn(visibleText(elementAt(main, tag))), [], where);
      continue;
    }
    assert.equal(tags.length, 1, where);
    const text = visibleText(elementAt(main, tags[0] as Tag));
    assert.ok(text.includes(shownName(rateClass, locale)), `${where}: no name in "${text}"`);
    assert.deepEqual(yenIn(text), [grouped(rateClass.extensionPerHourJpy)], where);
  }

  for (const option of sheet.options) {
    const tags = hooked(main, "data-option", option.id);
    const where = `${label}: option ${option.id}`;
    assert.equal(tags.length, 1, where);
    const tag = tags[0] as Tag;
    assert.equal(tag.name, "tr", `${where} is not a table row`);
    const text = visibleText(elementAt(main, tag));
    assert.ok(text.includes(shownName(option, locale)), `${where}: no name in "${text}"`);

    // A free option may say so instead of ¥0, but a price the sheet leaves blank is never a zero.
    const sheetPrices = [option.baseJpy, option.extraPerHourJpy, option.extraPer24hJpy];
    const expected = sheetPrices.flatMap((jpy) => (jpy === null ? [] : [grouped(jpy)]));
    const shown = yenIn(text);
    const paid = (amounts: string[]) => amounts.filter((amount) => amount !== "0");
    assert.deepEqual(paid(shown), paid(expected), where);
    const zeros = (amounts: string[]) => amounts.length - paid(amounts).length;
    assert.ok(zeros(shown) <= zeros(expected), `${where}: a zero the sheet does not have in "${text}"`);
  }
}

/** Every amount in `main` outside the draft notes is a value of the sheet, so none is written into the page. */
function assertOnlySheetAmounts(main: string, sheet: Catalog, label: string): void {
  const values = [
    ...sheet.prices.map(({ priceJpy }) => priceJpy),
    ...sheet.rateClasses.map(({ extensionPerHourJpy }) => extensionPerHourJpy),
    ...sheet.options.flatMap((option) => [option.baseJpy, option.extraPerHourJpy, option.extraPer24hJpy]),
  ];
  const allowed = new Set(values.flatMap((value) => (value === null ? [] : [grouped(value)])));
  const shown = yenIn(visibleText(without(main, ({ attributes }) => "data-draft-note" in attributes)));
  assert.ok(shown.length > 0, `${label}: no amounts`);
  for (const amount of shown) assert.ok(allowed.has(amount), `${label}: ${amount} is not on the sheet`);
}

/** Text that can only be this locale's, so one locale's sentences cannot stand in for another's. */
const script: Record<Locale, { must: RegExp; mustNot: RegExp }> = {
  ja: { must: /\p{Script=Hiragana}|\p{Script=Katakana}/u, mustNot: /\p{Script=Hangul}/u },
  en: { must: /[A-Za-z]{3}/, mustNot: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  "zh-cn": { must: /\p{Script=Han}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  ko: { must: /\p{Script=Hangul}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}/u },
};

function assertInLocale(text: string | undefined, locale: Locale, label: string): void {
  assert.ok(text, `${label}: no text`);
  assert.match(text, script[locale].must, `${label} is not in the locale's script: ${text}`);
  assert.doesNotMatch(text, script[locale].mustNot, `${label} holds another locale's text: ${text}`);
}

/** The one form that holds the control `name`. */
function formWith(main: string, name: string, label: string): string {
  const forms = [...main.matchAll(/<form\b[\s\S]*?<\/form\s*>/gi)]
    .map(([form]) => form)
    .filter((form) => tagsIn(form).some(({ attributes }) => attributes.name === name));
  assert.equal(forms.length, 1, `${label}: forms with ${name}`);
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

type Target = { path: string; href: string; params: Record<string, string> };

/** Where a cell's one link goes. */
function linkOf(cell: Cell, from: string, label: string): Target {
  const links = tagsIn(cell.html).filter(({ name }) => name === "a");
  assert.equal(links.length, 1, `${label}: links in "${cell.text}"`);
  const target = new URL((links[0] as Tag).attributes.href ?? "", new URL(from, base));
  return {
    path: target.pathname.replace(/\/$/, ""),
    href: target.pathname + target.search,
    params: Object.fromEntries(target.searchParams),
  };
}

function assertNoMessage(main: string, label: string): void {
  assert.equal(hookText(main, "data-rates-error"), undefined, `${label}: a message with nothing invalid`);
}

// The published sheet on the page.

test("prices on the fee schedule equal the fixture sheet in each locale", async () => {
  const sheet = expectedCatalog();
  await publish(sheetCatalog());

  // Worked out from the sheet by eye, so a change of the fixture cannot slip past both this table and the comparison.
  const en = await schedule("/en/rates");
  assert.deepEqual(grid(tableOf(en, "bike", "/en/rates")), [
    ["2,500", "3,500", "9,000"],
    ["3,600", "5,200", "13,800"],
    ["6,100", "9,100", "24,700"],
  ]);
  assert.deepEqual(grid(tableOf(en, "car", "/en/rates")), [["7,300", "18,900"]]);

  for (const locale of LOCALES) {
    const path = `/${locale}/rates`;
    const main = await schedule(path);
    assertLayout(main, sheet, locale, WHOLE, path);
    assertExtras(main, sheet, locale, path);
    assertOnlySheetAmounts(main, sheet, path);
    assertNoMessage(main, path);
  }
});

test("a class with no price for a package shows an empty cell", async () => {
  // bike-600 has one price of three and bike-900 has none, in a group where other classes have those packages.
  const catalog = sheetCatalog((workbook) => {
    const names = (name: string) => ({ name_ja: name, name_en: name, name_zh: name, name_ko: name });
    appendCopy(workbook, "RateClasses", "bike-400", { rate_class_id: "bike-600", sort: 8, ...names("600cc") });
    appendCopy(workbook, "RateClasses", "bike-400", { rate_class_id: "bike-900", sort: 9, ...names("900cc") });
    appendCopy(workbook, "Prices", "bike-400/day-3", { rate_class_id: "bike-600", price_jpy: 19800 });
  });
  await publish(catalog);

  const bikes = { classes: [...BIKES, "bike-600", "bike-900"], packages: BIKE_PACKAGES };
  const layout: Layout = { bike: bikes, car: CAR_TABLE };
  for (const locale of LOCALES) {
    const path = `/${locale}/rates`;
    const main = await schedule(path);
    assertLayout(main, catalog, locale, layout, path);

    const table = tableOf(main, "bike", path);
    assert.deepEqual(grid(table).slice(-2), [
      [null, null, "19,800"],
      [null, null, null],
    ]);
    const [partial, none] = table.rows.slice(-2) as [Row, Row];
    assertEmpty(partial.cells[0] as Cell, `${path}: bike-600/hours-6`);
    assertEmpty(partial.cells[1] as Cell, `${path}: bike-600/day-1`);
    for (const cell of none.cells) assertEmpty(cell, `${path}: bike-900`);

    // The price it has and the class name still link, and a class with no price is still a link to its vehicles.
    assert.deepEqual(linkOf(partial.cells[2] as Cell, path, path).params, { class: "bike-600", package: "day-3" });
    assert.deepEqual(linkOf(none.head, path, path).params, { class: "bike-900" });
  }
});

test("republishing changes prices and adds classes", async () => {
  const first = sheetCatalog();
  await publish(first);
  const path = "/en/rates";
  assert.deepEqual(grid(tableOf(await schedule(path), "bike", path))[1], ["3,600", "5,200", "13,800"]);

  // Below a thousand, a round ten thousand and over a million, so a separator cut at a fixed place shows. bike-750 sorts between
  // two classes that were neighbours, a new car class comes after the last, and a new package gets its column.
  const changed = sheetCatalog((workbook) => {
    setCell(workbook, "Prices", "scooter-50/day-1", "price_jpy", 980);
    setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", 1234500);
    setCell(workbook, "Prices", "bike-400/day-1", "price_jpy", 10000);
    setCell(workbook, "Prices", "car-k/day-3", "price_jpy", 7777);
    setCell(workbook, "RateClasses", "bike-125", "extension_per_hour_jpy", 1234);
    setCell(workbook, "Options", "child-seat", "base_jpy", 2222);
    setCell(workbook, "Options", "child-seat", "extra_per_24h_jpy", 660);

    setCell(workbook, "RateClasses", "bike-400", "sort", 10);
    appendCopy(workbook, "RateClasses", "bike-400", {
      rate_class_id: "bike-750",
      sort: 5,
      extension_per_hour_jpy: 1700,
      name_ja: "750ccクラス",
      name_en: "750cc class",
      name_zh: "750cc级",
      name_ko: "750cc 클래스",
    });
    appendCopy(workbook, "Prices", "bike-400/day-1", { rate_class_id: "bike-750", price_jpy: 31415 });
    appendCopy(workbook, "Prices", "bike-400/day-3", { rate_class_id: "bike-750", price_jpy: 88000 });

    appendCopy(workbook, "RateClasses", "car-k", {
      rate_class_id: "car-van",
      sort: 11,
      name_ja: "バン",
      name_en: "Van",
      name_zh: "面包车",
      name_ko: "밴",
    });
    appendCopy(workbook, "Prices", "car-k/day-1", { rate_class_id: "car-van", price_jpy: 8000 });
    appendCopy(workbook, "Prices", "car-k/day-3", { rate_class_id: "car-van", price_jpy: 21000 });

    appendCopy(workbook, "Packages", "day-3", {
      package_id: "day-7",
      days: 7,
      sort: 4,
      name_ja: "7日",
      name_en: "7 days",
      name_zh: "7天",
      name_ko: "7일",
    });
    appendCopy(workbook, "Prices", "bike-125/day-3", { package_id: "day-7", price_jpy: 33000 });
    appendCopy(workbook, "Prices", "car-k/day-3", { rate_class_id: "car-van", package_id: "day-7", price_jpy: 45000 });
  });
  await publish(changed);

  const layout: Layout = {
    bike: { classes: ["scooter-50", "bike-125", "bike-750", "bike-400"], packages: [...BIKE_PACKAGES, "day-7"] },
    car: { classes: ["car-k", "car-van"], packages: [...CAR_PACKAGES, "day-7"] },
  };
  for (const locale of LOCALES) {
    const rates = `/${locale}/rates`;
    const main = await schedule(rates);
    assert.deepEqual(grid(tableOf(main, "bike", rates)), [
      ["2,500", "980", "9,000", null],
      ["3,600", "1,234,500", "13,800", "33,000"],
      [null, "31,415", "88,000", null],
      ["6,100", "10,000", "24,700", null],
    ]);
    assert.deepEqual(grid(tableOf(main, "car", rates)), [
      ["7,300", "7,777", null],
      ["8,000", "21,000", "45,000"],
    ]);
    assertLayout(main, changed, locale, layout, rates);
    assertExtras(main, changed, locale, rates);
    assertOnlySheetAmounts(main, changed, rates);

    // The new class is a filter and a link like any other.
    assert.ok(offered(formWith(main, "class", rates), "class").includes("bike-750"), `${rates}: bike-750 is not offered`);
    assert.ok(offered(formWith(main, "duration", rates), "duration").includes("day-7"), `${rates}: day-7 is not offered`);
    const filtered = `${rates}?class=bike-750`;
    const narrowed = await schedule(filtered);
    const packages = layout.bike?.packages ?? [];
    assertLayout(narrowed, changed, locale, { bike: { classes: ["bike-750"], packages } }, filtered);
    assertNoMessage(narrowed, filtered);
    const [row] = tableOf(narrowed, "bike", filtered).rows as [Row];
    assert.deepEqual(linkOf(row.head, filtered, filtered).params, { class: "bike-750" });
    assert.deepEqual(linkOf(row.cells[1] as Cell, filtered, filtered).params, { class: "bike-750", package: "day-1" });
  }

  // Leaving the sheet takes them off the page on the next request, and a link to the old class is now an invalid filter.
  await publish(first);
  for (const locale of LOCALES) {
    const rates = `/${locale}/rates`;
    assertLayout(await schedule(rates), first, locale, WHOLE, rates);
    const stale = `${rates}?class=bike-750`;
    const main = await schedule(stale);
    assertLayout(main, first, locale, WHOLE, stale);
    assertInLocale(hookText(main, "data-rates-error"), locale, stale);
  }
});

// The filters.

test("group, class and duration filters narrow the table", async () => {
  const sheet = expectedCatalog();
  await publish(sheetCatalog());

  const cases: { query: string; expected: Layout }[] = [
    { query: "", expected: WHOLE },
    // What a plain form sends when its filters are left on "any".
    { query: "?group=&class=&duration=", expected: WHOLE },
    { query: "?group=bike", expected: { bike: BIKE_TABLE } },
    { query: "?group=car", expected: { car: CAR_TABLE } },
    { query: "?class=scooter-50", expected: { bike: { classes: ["scooter-50"], packages: BIKE_PACKAGES } } },
    { query: "?class=bike-125", expected: { bike: { classes: ["bike-125"], packages: BIKE_PACKAGES } } },
    { query: "?class=bike-400", expected: { bike: { classes: ["bike-400"], packages: BIKE_PACKAGES } } },
    { query: "?class=car-k", expected: { car: CAR_TABLE } },
    {
      query: "?duration=day-1",
      expected: { bike: { classes: BIKES, packages: ["day-1"] }, car: { classes: ["car-k"], packages: ["day-1"] } },
    },
    {
      query: "?duration=day-3",
      expected: { bike: { classes: BIKES, packages: ["day-3"] }, car: { classes: ["car-k"], packages: ["day-3"] } },
    },
    { query: "?duration=hours-6", expected: { bike: { classes: BIKES, packages: ["hours-6"] } } },
    { query: "?group=bike&duration=day-3", expected: { bike: { classes: BIKES, packages: ["day-3"] } } },
    { query: "?group=car&duration=day-1", expected: { car: { classes: ["car-k"], packages: ["day-1"] } } },
    { query: "?group=bike&class=bike-400", expected: { bike: { classes: ["bike-400"], packages: BIKE_PACKAGES } } },
    { query: "?class=scooter-50&duration=day-1", expected: { bike: { classes: ["scooter-50"], packages: ["day-1"] } } },
    {
      query: "?group=bike&class=bike-125&duration=hours-6",
      expected: { bike: { classes: ["bike-125"], packages: ["hours-6"] } },
    },
    { query: "?group=car&class=car-k&duration=day-3", expected: { car: { classes: ["car-k"], packages: ["day-3"] } } },
  ];
  for (const locale of LOCALES) {
    for (const { query, expected } of cases) {
      const path = `/${locale}/rates${query}`;
      const main = await schedule(path);
      assertLayout(main, sheet, locale, expected, path);
      assertNoMessage(main, path);
    }
  }

  // Literals, so the narrowed cell is known without the sheet.
  const one = await schedule("/en/rates?group=bike&class=bike-125&duration=hours-6");
  assert.deepEqual(grid(tableOf(one, "bike", "one cell")), [["3,600"]]);
  const other = await schedule("/en/rates?class=bike-400&duration=day-3");
  assert.deepEqual(grid(tableOf(other, "bike", "another cell")), [["24,700"]]);
});

test("the filters are a plain GET form that keeps the choices", async () => {
  const sheet = expectedCatalog();
  await publish(sheetCatalog());

  for (const locale of LOCALES) {
    const path = `/${locale}/rates`;
    const main = await schedule(path);
    const form = formWith(main, "group", path);
    assert.equal(formWith(main, "class", path), form, `${path}: class is in another form`);
    assert.equal(formWith(main, "duration", path), form, `${path}: duration is in another form`);

    const { method, action } = (tagsIn(form)[0] as Tag).attributes;
    assert.equal((method ?? "get").toLowerCase(), "get", `${path} method`);
    assert.equal(new URL(action ?? "", new URL(path, base)).pathname.replace(/\/$/, ""), path, `${path} action`);

    assert.deepEqual(offered(form, "group").sort(), ["bike", "car"], `${path} groups`);
    assert.deepEqual(offered(form, "class").sort(), [...BIKES, "car-k"].sort(), `${path} classes`);
    assert.deepEqual(offered(form, "duration").sort(), ["day-1", "day-3", "hours-6"], `${path} durations`);

    // Sending the form as it stands asks for nothing, or a guest could never get back to the whole table.
    const untouched = new URLSearchParams();
    for (const name of ["group", "class", "duration"]) untouched.set(name, chosen(form, name) ?? "");
    const resent = `${path}?${untouched}`;
    const whole = await schedule(resent);
    assertLayout(whole, sheet, locale, WHOLE, resent);
    assertNoMessage(whole, resent);

    const cases = [
      { group: "bike", class: "bike-125", duration: "day-3" },
      { group: "car", class: "car-k", duration: "day-1" },
    ];
    for (const filters of cases) {
      const filtered = `${path}?${new URLSearchParams(filters)}`;
      const kept = formWith(await schedule(filtered), "group", filtered);
      for (const [name, value] of Object.entries(filters)) assert.equal(chosen(kept, name), value, `${filtered} ${name}`);
    }
  }
});

test("filters that match nothing are not a blank table", async () => {
  await publish(sheetCatalog());

  // Each param is valid on its own, and a guest gets here by changing one select and leaving the others.
  const queries = [
    "?group=car&duration=hours-6",
    "?class=car-k&duration=hours-6",
    "?group=car&class=bike-125",
    "?group=bike&class=car-k",
  ];
  for (const locale of LOCALES) {
    for (const query of queries) {
      const path = `/${locale}/rates${query}`;
      const main = await schedule(path);
      const cells = feeTables(main, path).flatMap(({ rows }) => rows.flatMap(({ cells: row }) => row));
      const priced = cells.filter(({ text }) => yenIn(text).length > 0);
      const message = hookText(main, "data-rates-error");
      assert.ok(priced.length > 0 || message !== undefined, `${path}: no prices and no word why`);
      for (const cell of cells) if (!priced.includes(cell)) assertEmpty(cell, path);
      if (message !== undefined) assertInLocale(message, locale, path);
    }
  }
});

test("invalid params do not fail", async () => {
  const sheet = expectedCatalog();
  await publish(sheetCatalog());

  const bad: Record<string, string[]> = {
    group: ["plane", "BIKE", "bike ", "constructor", "__proto__", "toString"],
    class: ["nope", "BIKE-125", "day-1", "__proto__", "valueOf"],
    duration: ["week", "7", "scooter-50", "constructor", "__proto__"],
  };
  for (const [param, values] of Object.entries(bad)) {
    for (const value of values) {
      // Alone, and among filters that are valid, so "the whole table" means those are dropped too.
      const filters = [{ [param]: value }, { group: "bike", class: "bike-125", duration: "day-1", [param]: value }];
      for (const params of filters) {
        const path = `/en/rates?${new URLSearchParams(params)}`;
        const main = await schedule(path);
        assertLayout(main, sheet, "en", WHOLE, path);
        assertInLocale(hookText(main, "data-rates-error"), "en", path);
      }
    }
  }

  // The message comes in the reader's locale.
  for (const locale of LOCALES) {
    const path = `/${locale}/rates?group=plane&class=nope&duration=week`;
    const main = await schedule(path);
    assertLayout(main, sheet, locale, WHOLE, path);
    assertInLocale(hookText(main, "data-rates-error"), locale, path);
  }

  // What a request can throw at the page. Each comes back as text, never as markup, and never as a 500.
  const hostile: { query: string; injected?: string }[] = [
    { query: "group=<script>alert(1)</script>", injected: "<script>alert(1)" },
    { query: "class=<script>alert(1)</script>", injected: "<script>alert(1)" },
    { query: "duration=<script>alert(1)</script>", injected: "<script>alert(1)" },
    { query: `group="><img src=x onerror=alert(1)>`, injected: "<img src=x" },
    { query: `class="><img src=x onerror=alert(1)>`, injected: "<img src=x" },
    { query: `duration="><img src=x onerror=alert(1)>`, injected: "<img src=x" },
    { query: "group=%FF%FE&class=%00" },
    { query: "class=%" },
    { query: `duration=${"9".repeat(5000)}` },
    { query: "group=bike&group=plane&class=nope&class=bike-125" },
    { query: "group[]=x&class[$gt]=1" },
  ];
  for (const { query, injected } of hostile) {
    const path = `/en/rates?${query.replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll('"', "%22")}`;
    const html = await pageHtml(path);
    if (injected !== undefined) assert.ok(!html.includes(injected), `${path} puts the param into the page unescaped`);
  }
});

// The links.

test("price cells and class names link to the listing", async () => {
  await publish(sheetCatalog());

  /** The classes and packages of each table, in the order the page must show them. */
  const shown = (table: FeeTable) => WHOLE[table.group as "bike" | "car"] as { classes: string[]; packages: string[] };

  for (const locale of LOCALES) {
    const path = `/${locale}/rates`;
    const main = await schedule(path);
    const listing = `/${locale}/rentals`;
    let linked = 0;
    for (const table of feeTables(main, path)) {
      const { classes, packages } = shown(table);
      table.rows.forEach(({ head, cells }, row) => {
        const classId = classes[row] as string;
        const name = linkOf(head, path, path);
        assert.equal(name.path, listing, `${path}: where ${classId} goes`);
        assert.deepEqual(name.params, { class: classId }, `${path}: the link of ${classId}`);
        cells.forEach((cell, column) => {
          const packageId = packages[column] as string;
          const price = linkOf(cell, path, path);
          assert.equal(price.path, listing, `${path}: where ${classId}/${packageId} goes`);
          const label = `${path}: the link of ${classId}/${packageId}`;
          assert.deepEqual(price.params, { class: classId, package: packageId }, label);
          linked += 1;
        });
      });
    }
    assert.equal(linked, 11, `${path}: the sheet has 11 prices`);

    // A narrowed table links the same way, and carries nothing of the filter.
    const filtered = `${path}?group=bike&class=bike-125&duration=day-1`;
    const [row] = tableOf(await schedule(filtered), "bike", filtered).rows as [Row];
    assert.deepEqual(linkOf(row.head, filtered, filtered).params, { class: "bike-125" });
    assert.deepEqual(linkOf(row.cells[0] as Cell, filtered, filtered).params, { class: "bike-125", package: "day-1" });
  }

  // Following them: the listing takes the guest to the vehicles at that price.
  const vehicles: Record<string, string[]> = {
    "scooter-50": ["today-50"],
    "bike-125": ["pcx-125"],
    "bike-400": ["rebel-250"],
    "car-k": ["nbox-660"],
  };
  const path = "/en/rates";
  for (const table of feeTables(await schedule(path), path)) {
    const { classes, packages } = shown(table);
    for (const [row, { head, cells }] of table.rows.entries()) {
      const classId = classes[row] as string;
      const targets = [{ href: linkOf(head, path, path).href, packageId: undefined as string | undefined }];
      for (const [column, cell] of cells.entries()) {
        targets.push({ href: linkOf(cell, path, path).href, packageId: packages[column] });
      }
      for (const { href, packageId } of targets) {
        const listing = mainOf(await pageHtml(href), href);
        const cards = hooked(listing, "data-model-id").map(({ attributes }) => attributes["data-model-id"]);
        assert.deepEqual(cards, vehicles[classId], href);
        assert.equal(hookText(listing, "data-search-error"), undefined, `${href}: the listing refuses it`);
        if (packageId !== undefined) assert.equal(chosen(formWith(listing, "package", href), "package"), packageId, href);
      }
    }
  }
});

test("the table uses real headers and every price is a keyboard stop", async () => {
  await publish(sheetCatalog());

  for (const locale of LOCALES) {
    const path = `/${locale}/rates`;
    const main = await schedule(path);
    // feeTables holds the header checks: <th scope="col"> for packages, <th scope="row"> for classes, <td> for prices.
    const tables = feeTables(main, path);
    assert.deepEqual(tables.map(({ group }) => group).sort(), ["bike", "car"], `${path} tables`);
    for (const { rows } of tables) {
      for (const { head, cells } of rows) {
        for (const cell of [head, ...cells]) {
          const links = tagsIn(cell.html).filter(({ name }) => name === "a");
          assert.equal(links.length, 1, `${path}: links in "${cell.text}"`);
          const { attributes } = links[0] as Tag;
          assert.ok(attributes.href, `${path}: the link in "${cell.text}" has no href, so no focus`);
          assert.ok(Number(attributes.tabindex ?? 0) >= 0, `${path}: the link in "${cell.text}" is out of the tab order`);
          // The name or the amount is the link's own text, so the keyboard does not land on a blank target.
          const text = visibleText(elementAt(cell.html, links[0] as Tag));
          assert.ok(text, `${path}: the link in "${cell.text}" has no text`);
          assert.deepEqual(yenIn(text), yenIn(cell.text), `${path}: the amount in "${cell.text}" is outside the link`);
        }
      }
    }
  }
});

// The rest of the page.

test("coverage and peak notes are marked as drafts in each locale", async () => {
  await publish(sheetCatalog());

  for (const locale of LOCALES) {
    const path = `/${locale}/rates`;
    const main = await schedule(path);
    for (const note of ["coverage", "peak"]) {
      const tags = hooked(main, "data-draft-note", note);
      assert.equal(tags.length, 1, `${path}: ${note} notes`);
      assertInLocale(visibleText(elementAt(main, tags[0] as Tag)), locale, `${path}: the ${note} note`);
    }
  }
});

test("Rates is in the header nav of every page", async () => {
  await publish(sheetCatalog());

  const labels: string[] = [];
  for (const locale of LOCALES) {
    for (const page of ["/", "/rentals", "/faq", "/rates"]) {
      const path = `/${locale}${page}`;
      const html = await pageHtml(path);
      const label = common["nav.label"][locale];
      const nav = tagsIn(html).find(({ name, attributes }) => name === "nav" && attributes["aria-label"] === label);
      assert.ok(nav, `${path}: no main menu`);
      const menu = elementAt(html, nav);
      const pathOf = (href = "") => new URL(href, new URL(path, base)).pathname;
      const links = tagsIn(menu).filter(({ name, attributes }) => {
        return name === "a" && pathOf(attributes.href).replace(/\/$/, "") === `/${locale}/rates`;
      });
      assert.equal(links.length, 1, `${path}: links to the fee schedule in the main menu`);
      const link = links[0] as Tag;
      assert.ok(visibleText(elementAt(menu, link)), `${path}: the link has no text`);
      if (page === "/") labels.push(visibleText(elementAt(menu, link)));

      // The link works as the menu writes it.
      await pageHtml(pathOf(link.attributes.href));
    }
  }
  assert.equal(new Set(labels).size, LOCALES.length, `the labels are not translated: ${labels.join(", ")}`);
});

test("the fee schedule returns 200 for each locale and 404 for unknown ones", async () => {
  const langs: Record<Locale, string> = { ja: "ja", en: "en", "zh-cn": "zh-CN", ko: "ko" };
  await publish(sheetCatalog());

  // Without these the test would pass on a site with no such route.
  for (const [index, locale] of LOCALES.entries()) {
    // The header of another locale must not move the reader.
    const headers = { "Accept-Language": LOCALES[(index + 1) % LOCALES.length] as Locale };
    for (const page of ["/rates", "/rates/", "/rates?group=bike"]) {
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
    for (const page of ["/rates", "/rates/", "/rates?group=bike"]) {
      const path = `/${segment}${page}`;
      const res = await worker.fetch(path, { redirect: "manual" });
      await res.text();
      assert.equal(res.status, 404, path);
    }
  }
});

test("the fee schedule renders before the first publish", async () => {
  // A worker of its own, because the others in this file publish into theirs.
  const empty = await startWorker();
  try {
    for (const locale of LOCALES) {
      for (const query of ["", "?group=plane", "?group=bike&class=bike-125&duration=day-1"]) {
        const path = `/${locale}/rates${query}`;
        const main = await schedule(path, empty);
        assert.deepEqual(feeTables(main, path).flatMap(({ rows }) => rows), [], `${path}: rows with no catalog`);
      }
    }
  } finally {
    await empty.stop();
  }
});
