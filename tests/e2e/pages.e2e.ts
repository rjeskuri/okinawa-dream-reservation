// The home, policies and access pages, through the built Worker, over catalogs published with replaceCatalog. The Worker
// reads the real clock, so dates are computed from today in JST and a run that crosses midnight starts again. Facts are
// looked for by their numbers and tied together by block, so the wording stays free.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { addDaysToDate, epochToJst, formatHHmm, jstToday, jstToEpoch, parseHHmm } from "../../src/lib/time.ts";
import type {
  CancellationTier,
  Catalog,
  LocalizedTexts,
  Model,
  Package,
  RateClass,
  ShopConfig,
  VehicleTypeId,
} from "../../src/lib/types.ts";
import { blocksOf, bodyOf, mainOf, sectionsIn, tagsIn, visibleText, withoutCode, type Tag } from "../helpers/html.ts";
import { seedBooking } from "../helpers/seed.ts";
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

function hoursPackage(id: string, hours: number, sort: number, name: string): Package {
  return { id, days: null, hours, sort, texts: names(name) };
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

/** How a sentence may say "the pickup day" or "the pickup time" instead of 0 days. */
const pickupDay: Record<Locale, RegExp> = {
  ja: /当日|受(?:け)?取(?:り)?時(?:刻|間)/,
  en: /\bsame day\b|\bday of\b|\bon the day\b|\bpickup day\b|\bpickup time\b/i,
  "zh-cn": /当天|当日|(?:取车|提车)时(?:间|刻)/,
  ko: /당일|(?:픽업|인수)\s*시(?:간|각)/,
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

/** "Before the pickup time", in each locale. The pickup time must be named and the sentence must put the refund ahead of it. */
const beforePickupTime: Record<Locale, RegExp> = {
  ja: /受(?:け)?取(?:り)?時(?:刻|間)[^。]{0,10}(?:前|まで|以前)/,
  en: /\b(?:before|until|till|up to|prior to)\b[^.:]{0,40}\bpickup time\b/i,
  "zh-cn": /(?:取车|提车)时(?:间|刻)[^。，]{0,6}(?:前|截止|为止)/,
  ko: /(?:픽업|인수)\s*시(?:간|각)[^.]{0,8}(?:전|까지)/,
};

/** What the page said before this ticket, or wording that reaches the pickup day or past the pickup time. */
const upToAndIncludingPickupDay: Record<Locale, RegExp> = {
  ja: /当日まで/,
  en: /up to and including|\bincluding\b|\bor after\b|\band after\b/i,
  "zh-cn": /直至取车当天|取车当天/,
  ko: /당일까지/,
};

/** "If no line above applies" and "there is no refund", each in the locale. A closing line must say both. */
const nothingApplies: Record<Locale, RegExp> = {
  ja: /当てはまらない|当てはまりません|該当しない|該当しません|適用されない|適用されません|あてはまらない|あてはまりません/,
  en: /\b(?:no|none|not|neither)\b[^.]*\b(?:appl|match|fit|cover)|\b(?:isn't|doesn't|don't)\b[^.]*\b(?:appl|match|fit)/i,
  "zh-cn": /(?:没有|无|均不|都不|不)[^。，]{0,12}(?:符合|适用|匹配)|不符合|不适用|均不适用/,
  ko: /(?:해당하는|맞는|적용되는|일치하는)[^.]*(?:없|않)|(?:해당|적용|일치)[^.]*(?:않|없)/,
};

const noRefundSaid: Record<Locale, RegExp> = {
  ja: /返金[^。]*(?:ません|ない|なし|不可)/,
  en: /\bno refund\b|\bnot (?:be )?refund|\bnon-?refundable\b|\brefund[^.]*\b(?:not|none|zero)\b/i,
  "zh-cn": /不(?:予)?退(?:款|还)?|无退款|没有退款|不可退|不能退|无法退/,
  ko: /환불[^.]*(?:않|없|불가)/,
};

/** The places of the blocks in the cancellation section that are the closing "no line applies, no refund" line. */
function closingLines(blocks: string[], locale: Locale): number[] {
  return blocks.flatMap((block, place) =>
    nothingApplies[locale].test(block) && noRefundSaid[locale].test(block) ? [place] : [],
  );
}

test("the pickup-day tier says before the pickup time in each locale", async () => {
  // Percents differ per catalog, and the other tiers carry other percents, so one fixed sentence cannot stand in.
  const catalogs: CancellationTier[][] = [
    [
      { minDaysBefore: 7, refundPercent: 100 },
      { minDaysBefore: 3, refundPercent: 50 },
      { minDaysBefore: 0, refundPercent: 25 },
    ],
    [
      { minDaysBefore: 14, refundPercent: 90 },
      { minDaysBefore: 1, refundPercent: 40 },
      { minDaysBefore: 0, refundPercent: 60 },
    ],
    [
      { minDaysBefore: 5, refundPercent: 80 },
      { minDaysBefore: 0, refundPercent: 100 },
    ],
    [
      { minDaysBefore: 2, refundPercent: 70 },
      { minDaysBefore: 0, refundPercent: 0 },
    ],
  ];

  for (const tiers of catalogs) {
    await publish(catalogWith({ cancellationTiers: tiers }));
    const pickup = tiers.find((tier) => tier.minDaysBefore === 0) as CancellationTier;
    for (const locale of LOCALES) {
      const blocks = blocksOf((await policySections(locale)).cancellation);
      const label = `${locale} (0 days: ${pickup.refundPercent}%)`;
      const sentences = blocks.filter((block) => beforePickupTime[locale].test(block));
      assert.equal(sentences.length, 1, `${label}: expected one before-the-pickup-time sentence in\n${blocks.join("\n")}`);
      const sentence = sentences[0] as string;
      assert.ok(
        percent(pickup.refundPercent).test(sentence) || (pickup.refundPercent === 0 && noRefund[locale].test(sentence)),
        `${label}: the pickup-time sentence does not carry the percent: ${sentence}`,
      );
      for (const other of tiers.filter((tier) => tier !== pickup && tier.refundPercent !== pickup.refundPercent)) {
        assert.doesNotMatch(sentence, percent(other.refundPercent), `${label}: carries another tier's percent: ${sentence}`);
      }
      assertLocaleText(sentence, locale, label);
      // Nowhere in the section does the old "up to and including the pickup day" survive.
      for (const block of blocks) {
        assert.doesNotMatch(block, upToAndIncludingPickupDay[locale], `${label}: old pickup-day wording in: ${block}`);
      }
    }
    for (const locale of LOCALES) await assertTiersListed(locale, tiers);
  }
});

test("the no-refund line appears in each locale", async () => {
  const withZeroDayRow: CancellationTier[] = [
    { minDaysBefore: 7, refundPercent: 100 },
    { minDaysBefore: 3, refundPercent: 50 },
    { minDaysBefore: 0, refundPercent: 20 },
  ];
  // Staff may publish tiers with no 0-day row; the system then refunds nothing in the last days.
  const withoutZeroDayRow: CancellationTier[] = [
    { minDaysBefore: 10, refundPercent: 90 },
    { minDaysBefore: 2, refundPercent: 45 },
  ];
  const single: CancellationTier[] = [{ minDaysBefore: 4, refundPercent: 35 }];

  for (const tiers of [withZeroDayRow, withoutZeroDayRow, single]) {
    await publish(catalogWith({ cancellationTiers: tiers }));
    for (const locale of LOCALES) {
      const blocks = blocksOf((await policySections(locale)).cancellation);
      const label = `${locale} (${tiers.map((tier) => `${tier.minDaysBefore}d`).join(", ")})`;
      const lines = closingLines(blocks, locale);
      assert.equal(lines.length, 1, `${label}: expected one no-refund line in\n${blocks.join("\n")}`);
      const place = lines[0] as number;
      const line = blocks[place] as string;
      assertLocaleText(line, locale, label);
      assert.ok(
        tiers.every((tier) => !holdsTier(line, tier, locale)),
        `${label}: the no-refund line is taken for a tier: ${line}`,
      );
      // It closes the list: every tier stands above it.
      const last = Math.max(...tiers.map((tier) => blocks.findIndex((block) => holdsTier(block, tier, locale))));
      assert.ok(place > last, `${label}: the no-refund line is not after the tiers in\n${blocks.join("\n")}`);
      await assertTiersListed(locale, tiers);
      // No 0-day row, no pickup-time tier sentence: the closing line stands in for it.
      if (!tiers.some((tier) => tier.minDaysBefore === 0)) {
        const pickupTier = blocks.filter((block) => beforePickupTime[locale].test(block));
        assert.deepEqual(pickupTier, [], `${label}: a pickup-time tier is listed with no 0-day row`);
      }
    }
  }

  // Nothing published to apply: the section lists no tier and quotes no number.
  await publish(catalogWith({ cancellationTiers: [] }));
  for (const locale of LOCALES) {
    const section = (await policySections(locale)).cancellation;
    assert.doesNotMatch(section, /<li\b/i, `${locale}: tier list with no tiers published`);
    assert.doesNotMatch(visibleText(section), /\d/, `${locale}: numbers with no tiers published`);
  }
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

/** The form's choices for `name`: a select's options or its radio buttons, in order. */
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

/** The non-empty values the form offers for `name`, as select options or radio buttons. An empty value means "any". */
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

/** The visible text of each option of the form's `name` select, in order. */
function optionLabels(form: string, name: string): string[] {
  const select = tagsIn(form).find((tag) => tag.name === "select" && tag.attributes.name === name);
  assert.ok(select, `no ${name} select`);
  const body = form.slice(select.index, form.indexOf("</select", select.index));
  return [...body.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option\s*>/gi)].map(([, label]) => visibleText(label ?? ""));
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

test("home search offers day packages only until hours packages can be searched", async () => {
  // Task #50 makes these bookable. Until then the listing finds nothing for one and a hold refuses it.
  const cases: { label: string; packages: Package[]; days: string[] }[] = [
    {
      label: "hours packages first, between and last",
      packages: [
        hoursPackage("hours-6", 6, 1, "Six hours"),
        dayPackage("p-z-1d", 1, 2, "One day"),
        hoursPackage("p-half", 4, 3, "Half day"),
        dayPackage("p-a-3d", 3, 4, "Three days"),
        hoursPackage("p-short", 1, 5, "Quick ride"),
      ],
      days: ["p-z-1d", "p-a-3d"],
    },
    {
      // Stored out of sort order, with ids that do not say hours, and with 24 and 72 hours, so a cut on length shows.
      label: "stored out of order, 24 and 72 hours",
      packages: [
        dayPackage("p-2d", 2, 4, "Weekend"),
        hoursPackage("p-m-long", 24, 3, "Round the clock"),
        dayPackage("p-a-14d", 14, 5, "Fortnight"),
        hoursPackage("p-b-max", 72, 1, "Three full turns"),
        dayPackage("p-week", 7, 2, "Full week"),
      ],
      days: ["p-week", "p-2d", "p-a-14d"],
    },
  ];

  for (const { label, packages, days } of cases) {
    await publish(catalogWith({ packages }));
    for (const locale of LOCALES) {
      const where = `${label}, ${locale}`;
      const form = rentalsForm(await pageHtml(`/${locale}/`), locale);
      assert.deepEqual(offered(form, "package"), days, `${where}: package values`);

      // No package is chosen until the guest chooses one: the default is an empty choice with a label of its own.
      assert.equal(defaultChoice(form, "package"), "", `${where}: the default package`);
      assert.equal(choices(form, "package")[0]?.attributes.value, "", `${where}: the first option`);
      assertLocaleText(optionLabels(form, "package")[0] ?? "", locale, `${where}: the empty option's label`);

      const text = visibleText(form);
      for (const { id, texts } of packages) {
        assert.equal(text.includes(texts[locale].name), days.includes(id), `${where}: label of ${id}`);
      }
    }
  }
});

/** The query a browser sends from `form` when a guest changes `changes` and leaves the rest: the empty controls too. */
function formQuery(form: string, changes: Record<string, string> = {}): URLSearchParams {
  const query = new URLSearchParams();
  for (const { name, attributes } of tagsIn(form)) {
    const field = attributes.name;
    if (field === undefined || query.has(field) || "disabled" in attributes) continue;
    if (name === "select") query.append(field, defaultChoice(form, field) ?? "");
    else if (name === "input" && !["submit", "button", "checkbox", "radio"].includes(attributes.type ?? "text")) {
      query.append(field, attributes.value ?? "");
    }
  }
  for (const [field, value] of Object.entries(changes)) {
    assert.ok(query.has(field), `the form has no ${field}`);
    query.set(field, value);
  }
  return query;
}

/** The listing's cards in order. The whole card is one link. A price is its digits, however the locale writes yen. */
function listingCards(main: string): { id: string; available: boolean; prices: string[]; text: string }[] {
  return tagsIn(main)
    .filter(({ attributes }) => attributes["data-model-id"] !== undefined)
    .map((tag) => {
      assert.equal(tag.name, "a", `the card of ${tag.attributes["data-model-id"]} is not a link`);
      const html = main.slice(tag.index, main.indexOf("</a", tag.index));
      const prices = tagsIn(html)
        .filter(({ attributes }) => "data-price" in attributes)
        .map(({ index }) => visibleText(html.slice(index, html.indexOf("</", index))).replace(/\D/g, ""));
      return {
        id: tag.attributes["data-model-id"] as string,
        available: "data-available" in tag.attributes,
        prices,
        text: visibleText(html),
      };
    });
}

/** The sentences a guest must never get for a package they did not choose, enough of each to tell it from the page. */
const NOT_OFFERED: Record<Locale, string> = {
  ja: "このプランはありません",
  en: "Not offered on this package",
  "zh-cn": "此套餐不提供",
  ko: "이 패키지에는 없습니다",
};
const NO_VEHICLES: Record<Locale, string> = {
  ja: "条件に合う車両はありません",
  en: "No vehicles match",
  "zh-cn": "没有符合条件的车辆",
  ko: "조건에 맞는 차량이 없습니다",
};

function rateClass(id: string, grp: RateClass["grp"], sort: number): RateClass {
  return { id, grp, sort, extensionPerHourJpy: null, texts: names(id) };
}

function vehicleModel(id: string, typeId: VehicleTypeId, rateClassId: string, sort: number, active = true): Model {
  const texts = (name: string) => ({ name, summary: `${name} summary`, description: `${name} description` });
  return {
    id,
    typeId,
    engineCc: typeId === "car" ? 1300 : 125,
    licenseClass: typeId === "car" ? "car" : "small",
    sort,
    active,
    rateClassId,
    brand: "Test",
    seats: null,
    texts: { ja: texts(`${id} ja`), en: texts(`${id} en`), "zh-cn": texts(`${id} zh`), ko: texts(`${id} ko`) },
    photos: [],
  };
}

/** Separate bike and car packages behind an hours package, and in each of the types a class on a later package only. */
const SEARCH_PACKAGES = [
  hoursPackage("p-h6", 6, 1, "Six hours"),
  dayPackage("p-bike-1", 1, 2, "Bike one day"),
  dayPackage("p-bike-3", 3, 3, "Bike three days"),
  dayPackage("p-car-1", 1, 4, "Car one day"),
  dayPackage("p-car-2", 2, 5, "Car two days"),
];

/** The package and price of each active model with none chosen, worked out by hand from homeSearchCatalog's prices. */
const SEARCH_CARDS: Record<string, { packageId: string; price: string }> = {
  "m-z-vino": { packageId: "p-bike-1", price: "2410" },
  "m-y-cub": { packageId: "p-bike-1", price: "3260" },
  "m-x-note": { packageId: "p-car-1", price: "6720" },
  "m-w-rebel": { packageId: "p-bike-3", price: "24700" },
  "m-v-hiace": { packageId: "p-car-2", price: "18650" },
  "m-u-lead": { packageId: "p-bike-1", price: "2410" },
  "m-t-aqua": { packageId: "p-car-1", price: "6720" },
};

/** What a search of each type finds: m-u-lead and m-t-aqua are booked, and sort runs against the ids. */
/** This catalog has no e-bike, so the e-bike has no entry. */
const FREE_OF_TYPE: Record<Exclude<VehicleTypeId, "ebike">, string[]> = {
  scooter: ["m-z-vino"],
  motorcycle: ["m-y-cub", "m-w-rebel"],
  car: ["m-x-note", "m-v-hiace"],
};

function homeSearchCatalog(): Catalog {
  const priced = (rateClassId: string, prices: Record<string, number>) =>
    Object.entries(prices).map(([packageId, priceJpy]) => ({ rateClassId, packageId, priceJpy, advancePriceJpy: null }));
  const models = [
    vehicleModel("m-z-vino", "scooter", "r-scoot", 1),
    vehicleModel("m-y-cub", "motorcycle", "r-bike", 2),
    vehicleModel("m-x-note", "car", "r-car", 3),
    vehicleModel("m-w-rebel", "motorcycle", "r-tour", 4),
    vehicleModel("m-v-hiace", "car", "r-van", 5),
    vehicleModel("m-u-lead", "scooter", "r-scoot", 6),
    vehicleModel("m-t-aqua", "car", "r-car", 7),
    vehicleModel("m-s-gone", "car", "r-car", 8, false),
  ];
  return catalogWith({
    // The form's first time is the shop's opening, so a time written into a test or the page shows.
    config: { shopOpen: "08:30", shopClose: "17:15", slotMinutes: 45 },
    rateClasses: [
      rateClass("r-scoot", "bike", 1),
      rateClass("r-bike", "bike", 2),
      rateClass("r-tour", "bike", 3),
      rateClass("r-car", "car", 4),
      rateClass("r-van", "car", 5),
    ],
    packages: SEARCH_PACKAGES,
    prices: [
      ...priced("r-scoot", { "p-h6": 1870, "p-bike-1": 2410, "p-bike-3": 6130 }),
      ...priced("r-bike", { "p-h6": 2590, "p-bike-1": 3260, "p-bike-3": 8470 }),
      ...priced("r-tour", { "p-h6": 9100, "p-bike-3": 24700 }),
      ...priced("r-car", { "p-car-1": 6720, "p-car-2": 12930 }),
      ...priced("r-van", { "p-car-2": 18650 }),
    ],
    models,
    vehicles: models.map(({ id }) => ({
      plate: `plate-${id}`,
      modelId: id,
      status: "active",
      odometerKm: null,
      baseUsageDays: 0,
    })),
  });
}

/** Each card names its own package and price, and no other package. */
function assertOwnCards(main: string, locale: Locale, label: string): void {
  for (const shown of listingCards(main)) {
    const own = SEARCH_CARDS[shown.id];
    assert.ok(own, `${label}: ${shown.id} is listed`);
    assert.deepEqual(shown.prices, [own.price], `${label}: price of ${shown.id}: ${shown.text}`);
    for (const { id, texts } of SEARCH_PACKAGES) {
      assert.equal(shown.text.includes(texts[locale].name), id === own.packageId, `${label}: ${shown.id} and ${id}`);
    }
  }
}

function assertNoPackageComplaint(main: string, locale: Locale, label: string): void {
  const text = visibleText(main);
  assert.ok(!text.includes(NOT_OFFERED[locale]), `${label}: a card says it is not offered on the package`);
  assert.ok(!text.includes(NO_VEHICLES[locale]), `${label}: says no vehicles match`);
}

function hooksIn(main: string): string[] {
  return tagsIn(main).flatMap(({ attributes }) => Object.keys(attributes));
}

test("the home form's defaults search the chosen type", async (t) => {
  await publish(homeSearchCatalog());
  t.after(() => worker.db.prepare("DELETE FROM bookings").run());

  const date = addDaysToDate(jstToday(Date.now()), 3);
  for (const id of ["m-u-lead", "m-t-aqua"]) {
    await seedBooking(worker.db, {
      vehicle_plate: `plate-${id}`,
      start_at: jstToEpoch(date, "08:30"),
      end_at: jstToEpoch(date, "17:15"),
    });
  }

  for (const locale of LOCALES) {
    const form = rentalsForm(await pageHtml(`/${locale}/`), locale);

    // Without a date: nothing touched, then each type. Every active model is listed with its own price, bikes and cars.
    const undated: Record<string, string>[] = [{}, { type: "scooter" }, { type: "motorcycle" }, { type: "car" }];
    for (const changes of undated) {
      const path = `/${locale}/rentals?${formQuery(form, changes)}`;
      const main = mainOf(await pageHtml(path), path);
      assertNoPackageComplaint(main, locale, path);
      assert.deepEqual(listingCards(main).map(({ id }) => id).sort(), Object.keys(SEARCH_CARDS).sort(), path);
      assertOwnCards(main, locale, path);
      assert.ok(hooksIn(main).includes("data-search-prompt"), `${path}: no prompt to choose dates`);
      assert.ok(!hooksIn(main).includes("data-search-error"), `${path}: a message for a form as it was rendered`);
    }

    // With a date: the free models of the type, available and priced. A bike type does not come back empty either.
    for (const [type, expected] of Object.entries(FREE_OF_TYPE)) {
      const path = `/${locale}/rentals?${formQuery(form, { type, date })}`;
      const main = mainOf(await pageHtml(path), path);
      assertNoPackageComplaint(main, locale, path);
      const cards = listingCards(main);
      assert.deepEqual(cards.map(({ id }) => id), expected, path);
      assert.deepEqual(cards.filter(({ available }) => !available).map(({ id }) => id), [], `${path}: not available`);
      assertOwnCards(main, locale, path);
      assert.ok(!hooksIn(main).includes("data-search-prompt"), `${path}: a prompt beside results`);
      assert.ok(!hooksIn(main).includes("data-search-error"), `${path}: a message on a valid search`);
    }
  }
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
