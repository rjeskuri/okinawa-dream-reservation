// The home, policies and access pages, through the built Worker, over catalogs published with replaceCatalog. The Worker
// reads the real clock, so dates are computed from today in JST and a run that crosses midnight starts again. Facts are
// looked for by their numbers and tied together by block, so the wording stays free.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { addDaysToDate, epochToJst, formatHHmm, jstToday, parseHHmm } from "../../src/lib/time.ts";
import type { CancellationTier, Catalog, LocalizedTexts, Package, ShopConfig } from "../../src/lib/types.ts";
import { blocksOf, bodyOf, mainOf, sectionsIn, tagsIn, visibleText, withoutCode } from "../helpers/html.ts";
import { startWorker, type TestWorker } from "../helpers/worker.ts";

const base = "http://localhost/";
const HOUR_MS = 3_600_000;
const POLICY_SECTIONS = ["cancellation", "terms", "privacy"] as const;

let worker: TestWorker;

before(async () => {
  worker = await startWorker();
});

after(async () => {
  await worker?.stop();
});

/** Differs by locale, so one locale's text standing in for the rest shows. */
function names(en: string): LocalizedTexts<{ name: string }> {
  return { ja: { name: `${en} 日本語` }, en: { name: en }, "zh-cn": { name: `${en} 中文` }, ko: { name: `${en} 한국어` } };
}

function dayPackage(id: string, days: number, sort: number, name: string): Package {
  return { id, days, hours: null, sort, texts: names(name) };
}

const CONFIG: ShopConfig = {
  shopOpen: "09:00",
  shopClose: "18:00",
  slotMinutes: 30,
  turnaroundMinutes: 60,
  holdMinutes: 15,
  minLeadHours: 24,
  maxDaysAhead: 180,
  photoMaxMb: 5,
};

/** The smallest catalog the pages read, with `overrides` on top. Nothing here is a vehicle: these pages list none. */
function catalogWith({
  config,
  ...overrides
}: Partial<Omit<Catalog, "config">> & { config?: Partial<ShopConfig> } = {}): Catalog {
  return {
    config: { ...CONFIG, ...config },
    vehicleTypes: [
      { id: "scooter", depositJpy: 3000, sort: 1, texts: names("Scooter") },
      { id: "motorcycle", depositJpy: 5000, sort: 2, texts: names("Motorcycle") },
      { id: "car", depositJpy: 10000, sort: 3, texts: names("Car") },
    ],
    rateClasses: [],
    models: [],
    vehicles: [],
    packages: [dayPackage("p-1d", 1, 1, "One day")],
    prices: [],
    options: [],
    cancellationTiers: [{ minDaysBefore: 0, refundPercent: 0 }],
    closedDates: [],
    ...overrides,
  };
}

async function publish(catalog: Catalog): Promise<void> {
  await replaceCatalog(worker.db, catalog, { now: Date.now(), source: "sheet" });
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

async function pageHtml(path: string, target: TestWorker = worker): Promise<string> {
  const res = await target.fetch(path, { redirect: "manual" });
  const html = await res.text();
  assert.equal(res.status, 200, path);
  return html;
}

/** Text that can only be this locale's, so one locale's sentences cannot stand in for another's. */
const script: Record<Locale, { must: RegExp; mustNot: RegExp }> = {
  ja: { must: /\p{Script=Hiragana}|\p{Script=Katakana}/u, mustNot: /\p{Script=Hangul}/u },
  en: { must: /[A-Za-z]{3}/, mustNot: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  "zh-cn": { must: /\p{Script=Han}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  ko: { must: /\p{Script=Hangul}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}/u },
};

function assertLocaleText(text: string, locale: Locale, label: string): void {
  assert.match(text, script[locale].must, `${label}: no text in the locale's script`);
  assert.doesNotMatch(text, script[locale].mustNot, `${label}: text from another locale`);
}

// Policies.

async function policySections(locale: Locale): Promise<Record<(typeof POLICY_SECTIONS)[number], string>> {
  const path = `/${locale}/policies`;
  return sectionsIn(mainOf(await pageHtml(path), path), POLICY_SECTIONS, path);
}

function whole(value: number): RegExp {
  return new RegExp(`(?<![\\d.,])${value}(?!\\d)`);
}

function percent(value: number): RegExp {
  return new RegExp(`(?<![\\d.,])${value}\\s*%`);
}

/** How a sentence may say "the pickup day" instead of 0 days. */
const pickupDay: Record<Locale, RegExp> = {
  ja: /当日/,
  en: /\bsame day\b|\bday of\b|\bon the day\b|\bpickup day\b/i,
  "zh-cn": /当天|当日/,
  ko: /당일/,
};

/** How a sentence may say "no refund" instead of 0%. */
const noRefund: Record<Locale, RegExp> = {
  ja: /ません|ない|不可|なし/,
  en: /\b(?:not|no|non-refundable|nonrefundable)\b|n't\b/i,
  "zh-cn": /不|无/,
  ko: /않|없|불가/,
};

function holdsTier(block: string, tier: CancellationTier, locale: Locale): boolean {
  const days = whole(tier.minDaysBefore).test(block) || (tier.minDaysBefore === 0 && pickupDay[locale].test(block));
  const refund = percent(tier.refundPercent).test(block) || (tier.refundPercent === 0 && noRefund[locale].test(block));
  return days && refund;
}

/** Each tier stands in a block of its own in the locale's text, in the order of `tiers`. */
async function assertTiersListed(locale: Locale, tiers: CancellationTier[]): Promise<void> {
  const blocks = blocksOf((await policySections(locale)).cancellation);
  let previous = -1;
  for (const tier of tiers) {
    const label = `${locale}: ${tier.minDaysBefore} days, ${tier.refundPercent}%`;
    const place = blocks.findIndex((block) => holdsTier(block, tier, locale));
    assert.notEqual(place, -1, `${label} is not in one block of\n${blocks.join("\n")}`);
    assert.ok(place > previous, `${label} is out of order in\n${blocks.join("\n")}`);
    assertLocaleText(blocks[place] as string, locale, label);
    previous = place;
  }
}

test("policies list every tier in each locale", async () => {
  const first: CancellationTier[] = [
    { minDaysBefore: 7, refundPercent: 100 },
    { minDaysBefore: 3, refundPercent: 50 },
    { minDaysBefore: 0, refundPercent: 0 },
  ];
  const second: CancellationTier[] = [
    { minDaysBefore: 21, refundPercent: 95 },
    { minDaysBefore: 10, refundPercent: 60 },
    { minDaysBefore: 2, refundPercent: 15 },
    { minDaysBefore: 0, refundPercent: 5 },
  ];

  await publish(catalogWith({ cancellationTiers: first }));
  for (const locale of LOCALES) await assertTiersListed(locale, first);

  await publish(catalogWith({ cancellationTiers: second }));
  for (const locale of LOCALES) {
    await assertTiersListed(locale, second);
    const blocks = blocksOf((await policySections(locale)).cancellation);
    for (const gone of first.slice(0, 2)) {
      const stale = blocks.filter((block) => holdsTier(block, gone, locale));
      assert.deepEqual(stale, [], `${locale}: the replaced tier of ${gone.minDaysBefore} days is still listed`);
    }
  }
});

test("tiers stored out of order are listed highest first", async () => {
  // Written out of order, and with 30 and 14 around 7 and 3, so ordering the days as text shows too.
  const stored: CancellationTier[] = [
    { minDaysBefore: 3, refundPercent: 30 },
    { minDaysBefore: 14, refundPercent: 80 },
    { minDaysBefore: 0, refundPercent: 10 },
    { minDaysBefore: 30, refundPercent: 100 },
    { minDaysBefore: 7, refundPercent: 55 },
  ];
  const highestFirst: CancellationTier[] = [
    { minDaysBefore: 30, refundPercent: 100 },
    { minDaysBefore: 14, refundPercent: 80 },
    { minDaysBefore: 7, refundPercent: 55 },
    { minDaysBefore: 3, refundPercent: 30 },
    { minDaysBefore: 0, refundPercent: 10 },
  ];

  await publish(catalogWith({ cancellationTiers: stored }));
  for (const locale of LOCALES) await assertTiersListed(locale, highestFirst);
});

/** Words that mark text as a draft. */
const draftMark: Record<Locale, RegExp> = {
  ja: /下書き|草案|ドラフト|暫定/,
  en: /\bdraft\b/i,
  "zh-cn": /草案|草稿|初稿|暂定/,
  ko: /초안|임시|드래프트/,
};

test("draft legal text is marked", async () => {
  await publish(catalogWith());
  for (const locale of LOCALES) {
    const sections = await policySections(locale);
    for (const name of ["terms", "privacy"] as const) {
      const label = `${locale} ${name}`;
      assert.match(visibleText(sections[name]), draftMark[locale], `${label}: not marked as a draft`);
      assertLocaleText(bodyOf(sections[name]), locale, label);
    }
    // The tiers are the shop's published terms, so a mark over the whole page would tell guests they are not settled.
    assert.doesNotMatch(visibleText(sections.cancellation), draftMark[locale], `${locale} cancellation`);
  }
});

// Access.

async function accessText(locale: Locale): Promise<string> {
  const path = `/${locale}/access`;
  return visibleText(mainOf(await pageHtml(path), path));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `date` as a page may write it: 2026-11-03, 2026/11/3, 2026. 11. 3., 11/3/2026, 11月3日, 11월 3일, Nov 3, 3 November. */
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

/** A time of the config, with or without its leading zero. */
function clock(time: string): RegExp {
  return new RegExp(`(?<![\\d:])${time.replace(/^0/, "0?")}(?![\\d:])`);
}

function assertHours(text: string, open: string, close: string, label: string): void {
  const opens = text.search(clock(open));
  const closes = text.search(clock(close));
  assert.notEqual(opens, -1, `${label}: no opening time ${open} in\n${text}`);
  assert.notEqual(closes, -1, `${label}: no closing time ${close} in\n${text}`);
  assert.ok(opens < closes, `${label}: ${close} comes before ${open}`);
}

function assertDates(text: string, shown: string[], hidden: string[], label: string): void {
  for (const date of shown) assert.match(text, dateOnPage(date), `${label}: ${date} is not shown`);
  for (const date of hidden) assert.doesNotMatch(text, dateOnPage(date), `${label}: ${date} is shown`);
}

test("access shows hours and upcoming closed dates", async () => {
  await steady(0, async (now) => {
    const today = jstToday(now);
    const inDays = (days: number) => addDaysToDate(today, days);

    await publish(
      catalogWith({
        config: { shopOpen: "08:30", shopClose: "19:15" },
        closedDates: [inDays(3), inDays(37)],
      }),
    );
    for (const locale of LOCALES) {
      const text = await accessText(locale);
      assertHours(text, "08:30", "19:15", locale);
      assertDates(text, [inDays(3), inDays(37)], [inDays(4), inDays(36)], locale);
      assert.match(text, script[locale].must, `${locale}: no text in the locale's script`);
    }

    // The next request after a publish shows the new hours and dates and none of the old ones.
    await publish(
      catalogWith({
        config: { shopOpen: "10:00", shopClose: "17:45" },
        closedDates: [inDays(11), inDays(52)],
      }),
    );
    for (const locale of LOCALES) {
      const text = await accessText(locale);
      assertHours(text, "10:00", "17:45", locale);
      assertDates(text, [inDays(11), inDays(52)], [inDays(3), inDays(37)], locale);
      assert.doesNotMatch(text, clock("08:30"), `${locale}: the old opening time`);
      assert.doesNotMatch(text, clock("19:15"), `${locale}: the old closing time`);
    }
  });
});

test("access leaves out closed dates in the past and beyond 60 days", async () => {
  await steady(0, async (now) => {
    const today = jstToday(now);
    const inDays = (days: number) => addDaysToDate(today, days);

    // Today and today + 60 are the two ends of the window, and they show the page's date format to the negative checks.
    await publish(
      catalogWith({
        closedDates: [inDays(-30), inDays(-1), today, inDays(60), inDays(61), inDays(90)],
      }),
    );
    for (const locale of LOCALES) {
      const hidden = [inDays(-30), inDays(-1), inDays(61), inDays(90)];
      assertDates(await accessText(locale), [today, inDays(60)], hidden, locale);
    }

    // Nothing in the window still renders the page.
    await publish(catalogWith({ closedDates: [inDays(-1), inDays(61)] }));
    for (const locale of LOCALES) {
      const text = await accessText(locale);
      assertHours(text, CONFIG.shopOpen, CONFIG.shopClose, locale);
      assertDates(text, [], [inDays(-1), inDays(61)], locale);
    }
  });
});

// Home.

/** The one form on the page that goes to the listing. */
function rentalsForm(html: string, locale: Locale): string {
  const page = new URL(`/${locale}/`, base);
  const forms = [...withoutCode(html).matchAll(/<form\b[\s\S]*?<\/form\s*>/gi)].map(([form]) => form);
  const found = forms.filter((form) => {
    const action = tagsIn(form)[0]?.attributes.action;
    if (action === undefined) return false;
    const target = new URL(action, page);
    return target.origin === page.origin && target.pathname.replace(/\/$/, "") === `/${locale}/rentals`;
  });
  assert.equal(found.length, 1, `/${locale}/ forms to /${locale}/rentals`);
  return found[0] as string;
}

/** The non-empty values the form offers for `name`, as select options or radio buttons. An empty value means "any". */
function offered(form: string, name: string): string[] {
  const tags = tagsIn(form);
  const select = tags.find((tag) => tag.name === "select" && tag.attributes.name === name);
  let values: (string | undefined)[];
  if (select) {
    const body = form.slice(select.index, form.indexOf("</select", select.index));
    values = tagsIn(body)
      .filter((tag) => tag.name === "option")
      .map((tag) => tag.attributes.value);
  } else {
    values = tags
      .filter(({ name: tag, attributes }) => tag === "input" && attributes.type === "radio" && attributes.name === name)
      .map((tag) => tag.attributes.value);
  }
  return values.filter((value): value is string => value !== undefined && value !== "");
}

/** The pickup times of a config: every slot from opening to one slot before closing, as task #20 defines them. */
function slotsOf({ shopOpen, shopClose, slotMinutes }: ShopConfig): string[] {
  const slots: string[] = [];
  for (let at = parseHHmm(shopOpen); at <= parseHHmm(shopClose) - slotMinutes; at += slotMinutes) {
    slots.push(formatHHmm(at));
  }
  return slots;
}

/** The listing's query params, from task #25. */
const LISTING_PARAMS = ["date", "time", "package", "type", "cc", "class"];

/** The form on each locale's home page against `catalog`, with `now` the clock of the publish. */
async function assertSearchForm(catalog: Catalog, now: number): Promise<void> {
  const today = jstToday(now);
  const { config } = catalog;
  const packages = [...catalog.packages].sort((a, b) => a.sort - b.sort);

  for (const locale of LOCALES) {
    const form = rentalsForm(await pageHtml(`/${locale}/`), locale);
    const tags = tagsIn(form);
    assert.equal((tags[0]?.attributes.method ?? "get").toLowerCase(), "get", `${locale} form method`);

    // What a guest without JavaScript submits: each param once, and nothing the listing does not read.
    const controls = tags.filter(
      ({ name, attributes }) =>
        ["input", "select", "textarea"].includes(name) && attributes.name !== undefined && !("disabled" in attributes),
    );
    const single = controls.filter(({ attributes }) => attributes.type !== "radio").map((tag) => tag.attributes.name);
    assert.equal(new Set(single).size, single.length, `${locale} params sent twice: ${single.join(", ")}`);
    const params = new Set(controls.map((tag) => tag.attributes.name as string));
    for (const param of ["date", "time", "package", "type"]) {
      assert.ok(params.has(param), `${locale} form has no ${param}: ${[...params].join(", ")}`);
    }
    for (const param of params) assert.ok(LISTING_PARAMS.includes(param), `${locale} form sends ${param}`);

    assert.ok(
      tags.some(
        ({ name, attributes }) =>
          (name === "button" && (attributes.type ?? "submit").toLowerCase() === "submit") ||
          (name === "input" && attributes.type?.toLowerCase() === "submit"),
      ),
      `${locale} form has no submit control`,
    );

    assert.deepEqual(offered(form, "type").sort(), ["car", "motorcycle", "scooter"], `${locale} type values`);
    assert.deepEqual(
      offered(form, "package"),
      packages.map(({ id }) => id),
      `${locale} package values`,
    );
    for (const { texts } of packages) {
      assert.ok(visibleText(form).includes(texts[locale].name), `${locale} package label ${texts[locale].name}`);
    }
    assert.deepEqual(offered(form, "time"), slotsOf(config), `${locale} time values`);

    const picker = tags.find(({ name }) => name === "date-picker");
    assert.ok(picker, `${locale} form has no DatePicker`);
    const dateInput = tags.find(
      ({ name, attributes, index }) =>
        name === "input" && attributes.type === "date" && attributes.name === "date" && index > picker.index,
    );
    assert.ok(dateInput, `${locale} DatePicker has no date input`);
    const label = `${locale} date input`;
    assert.equal(dateInput.attributes.min, epochToJst(now + config.minLeadHours * HOUR_MS).date, `${label} min`);
    assert.equal(dateInput.attributes.max, addDaysToDate(today, config.maxDaysAhead), `${label} max`);

    const { closedDates } = JSON.parse(picker.attributes["data-config"] ?? "{}") as { closedDates?: string[] };
    assert.deepEqual(closedDates, catalog.closedDates, `${locale} DatePicker closed dates`);
  }
}

test("home search submits to rentals with the right params", async () => {
  const firstConfig = { shopOpen: "09:00", shopClose: "18:00", slotMinutes: 30, minLeadHours: 30, maxDaysAhead: 120 };
  await steady(firstConfig.minLeadHours, async (now) => {
    const today = jstToday(now);
    const catalog = catalogWith({
      config: firstConfig,
      // Ids run against sort, so listing them by id shows.
      packages: [dayPackage("p-z-1d", 1, 1, "One day"), dayPackage("p-a-3d", 3, 2, "Three days")],
      closedDates: [addDaysToDate(today, 9), addDaysToDate(today, 40)],
    });
    await publish(catalog);
    await assertSearchForm(catalog, now);
  });

  // Every value on the form follows the next publish.
  const secondConfig = { shopOpen: "08:30", shopClose: "17:00", slotMinutes: 45, minLeadHours: 54, maxDaysAhead: 45 };
  await steady(secondConfig.minLeadHours, async (now) => {
    const today = jstToday(now);
    const catalog = catalogWith({
      config: secondConfig,
      packages: [
        dayPackage("p-week", 7, 1, "Full week"),
        dayPackage("p-2d", 2, 2, "Weekend"),
        dayPackage("p-14d", 14, 3, "Fortnight"),
      ],
      closedDates: [addDaysToDate(today, 6), addDaysToDate(today, 33)],
    });
    await publish(catalog);
    await assertSearchForm(catalog, now);
  });
});

// Routing.

test("the pages return 200 for each locale and 404 for unknown ones", async () => {
  const langs: Record<Locale, string> = { ja: "ja", en: "en", "zh-cn": "zh-CN", ko: "ko" };
  await publish(catalogWith());

  // Without these the test would pass on a site with none of the routes. The nav links with a trailing slash.
  for (const [index, locale] of LOCALES.entries()) {
    // The header of another locale must not move the reader.
    const headers = { "Accept-Language": LOCALES[(index + 1) % LOCALES.length] as Locale };
    for (const page of ["", "/", "/policies", "/policies/", "/access", "/access/"]) {
      const path = `/${locale}${page}`;
      const res = await worker.fetch(path, { headers, redirect: "manual" });
      const html = await res.text();
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
      assert.equal(tagsIn(html).find(({ name }) => name === "html")?.attributes.lang, langs[locale], `${path} lang`);
    }
  }

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
    for (const page of ["/", "/policies", "/policies/", "/access", "/access/"]) {
      const path = `/${segment}${page}`;
      const res = await worker.fetch(path, { redirect: "manual" });
      await res.text();
      assert.equal(res.status, 404, path);
    }
  }
});

test("the pages render before the first publish", async () => {
  // A worker of its own, because the others in this file publish into theirs.
  const empty = await startWorker();
  try {
    for (const locale of LOCALES) {
      for (const path of [`/${locale}/`, `/${locale}/policies`, `/${locale}/access`]) {
        await pageHtml(path, empty);
      }
    }
  } finally {
    await empty.stop();
  }
});
