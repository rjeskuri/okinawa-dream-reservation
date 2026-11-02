// The FAQ, through the built Worker. Every fact is looked for inside its own section, between that section's
// anchor and the next one, and tied to its neighbours by block (a list item, table row or paragraph, with any
// heading above it), so the wording stays free and a stray number elsewhere on the page proves nothing.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { startWorker, type TestWorker } from "../helpers/worker.ts";

const base = "http://localhost/";

const ANCHORS = [
  "license-classes",
  "international-permits",
  "payment-cards",
  "deposit-and-cancellation",
  "pickup-and-return",
] as const;

type Anchor = (typeof ANCHORS)[number];

let worker: TestWorker;

before(async () => {
  worker = await startWorker();
});

after(async () => {
  await worker?.stop();
});

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLowerCase()] ?? "";
  });
}

interface Tag {
  name: string;
  index: number;
  attributes: Record<string, string>;
}

/** Every start tag in `html`, in document order, with lower-case names and decoded attribute values. */
function tagsIn(html: string): Tag[] {
  const tag = /<([a-z][a-z0-9-]*)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  return [...html.matchAll(tag)].map((match) => {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[2] ?? "").matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      attributes[String(attribute[1]).toLowerCase()] = decodeEntities(value);
    }
    return { name: String(match[1]).toLowerCase(), index: match.index, attributes };
  });
}

/** The ids in `html`, in document order. */
function idsIn(html: string): { id: string; index: number }[] {
  return tagsIn(html).flatMap(({ attributes, index }) => (attributes.id ? [{ id: attributes.id, index }] : []));
}

/** The text a reader sees, with full-width digits, letters and units (１２５ｃｃ, ㎾) folded to ASCII. */
function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/** The content of `<main>` on the locale's FAQ, without comments, scripts or styles. */
async function faqMain(locale: Locale): Promise<string> {
  const res = await worker.fetch(`/${locale}/faq`, { redirect: "manual" });
  const html = await res.text();
  assert.equal(res.status, 200, `/${locale}/faq`);
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  const main = cleaned.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1];
  assert.ok(main, `/${locale}/faq has no <main>`);
  return main;
}

/** Each named section's HTML, from its anchor to the next named anchor or the end of `<main>`. */
function sectionsIn(main: string, locale: Locale): Record<Anchor, string> {
  const marks = idsIn(main).filter(({ id }) => (ANCHORS as readonly string[]).includes(id));
  const sections = {} as Record<Anchor, string>;
  for (const anchor of ANCHORS) {
    const start = marks.find(({ id }) => id === anchor);
    assert.ok(start, `/${locale}/faq has no element with id="${anchor}"`);
    const next = marks.find(({ index }) => index > start.index);
    sections[anchor] = main.slice(start.index, next?.index ?? main.length);
  }
  return sections;
}

async function faqSections(locale: Locale): Promise<Record<Anchor, string>> {
  return sectionsIn(await faqMain(locale), locale);
}

/** A section's blocks. Headings and `<dt>` stay with the text below them. */
function blocksOf(section: string): string[] {
  return section
    .split(/<\/(?:li|tr|p|dd)\s*>/i)
    .map(visibleText)
    .filter((block) => block !== "");
}

function sentencesOf(section: string): string[] {
  return blocksOf(section).flatMap((block) => block.split(/(?<=[。！？；!?;])|(?<=\.)\s+/));
}

/** The section without its headings, so an anchor on a lone heading does not count as content. */
function bodyOf(section: string): string {
  return visibleText(section.replace(/<h[1-6]\b[\s\S]*?<\/h[1-6]\s*>/gi, " "));
}

function assertTogether(blocks: string[], label: string, ...patterns: RegExp[]): void {
  assert.ok(
    blocks.some((block) => patterns.every((pattern) => pattern.test(block))),
    `${label}: no block holds all of ${patterns.join(" ")}\n${blocks.join("\n")}`,
  );
}

/** An engine size: `cc(50)` matches 50cc and 50 cc, but not 250cc or 1,250. */
function cc(size: number): RegExp {
  return new RegExp(`(?<![\\d.,])${size}\\s*(?:cc|cm3|ml|毫升|시시)`, "i");
}

function year(value: number): RegExp {
  return new RegExp(`(?<!\\d)${value}(?!\\d)`);
}

/** A standalone letter, so the A of JAF or a word does not count. */
function letter(value: string): RegExp {
  return new RegExp(`(?<![A-Za-z])${value}(?![A-Za-z])`);
}

const fourKilowatts = /(?<![\d.])4\.0\s*(?:kW|千瓦|킬로와트)/i;

/** Words that make a statement negative. Each is checked in the sentence that names the thing refused. */
const negation: Record<Locale, RegExp> = {
  ja: /ません|ない|不可|無効|対象外/,
  en: /\b(?:not|no|cannot|never)\b|n't\b|invalid/i,
  "zh-cn": /不|无法|无效/,
  ko: /않|없|불가|무효|아닙/,
};

/** Text that can only be this locale's, so the page cannot be another locale's entry. */
const script: Record<Locale, { must: RegExp; mustNot?: RegExp }> = {
  ja: { must: /\p{Script=Hiragana}|\p{Script=Katakana}/u },
  en: { must: /[A-Za-z]{3}/ },
  "zh-cn": { must: /\p{Script=Han}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  ko: { must: /\p{Script=Hangul}/u },
};

const licenseTerms: Record<
  Locale,
  { moped: RegExp; car: RegExp; small: RegExp; standard: RegExp; large: RegExp; since: RegExp }
> = {
  ja: {
    moped: /原付|原動機付/,
    car: /普通自動車|普通免許|普通車|自動車免許/,
    small: /小型限定|小型(?:自動)?二輪/,
    standard: /普通/,
    large: /大型/,
    since: /2025年\s*4月\s*1日|令和7年\s*4月\s*1日|2025-04-01/,
  },
  en: {
    moped: /\bmoped/i,
    car: /\b(?:car|automobile)\b/i,
    small: /\bsmall\b/i,
    standard: /\bstandard\b/i,
    large: /\blarge\b/i,
    since: /April 1,? 2025|1 April 2025|Apr\.? 1,? 2025|2025-04-01/i,
  },
  "zh-cn": {
    moped: /原付|原动机|轻便/,
    car: /汽车|轿车|小客车/,
    small: /小型/,
    standard: /普通|标准/,
    large: /大型/,
    since: /2025年\s*4月\s*1日|2025-04-01/,
  },
  ko: {
    moped: /원동기|모페드|원부|겐츠키|原付/,
    car: /자동차|승용차/,
    small: /소형/,
    standard: /보통|일반|표준/,
    large: /대형/,
    since: /2025년\s*4월\s*1일|2025-04-01/,
  },
};

const permitTerms: Record<
  Locale,
  {
    permit: RegExp;
    geneva: RegExp;
    vienna: RegExp;
    categoryA: RegExp;
    motorcycle: RegExp;
    car: RegExp;
    translation: RegExp;
    oneYear: RegExp;
    arrival: RegExp;
    places: RegExp[];
  }
> = {
  ja: {
    permit: /国際(?:運転)?免許/,
    geneva: /ジュネーブ|ジュネーヴ/,
    vienna: /ウィーン/,
    categoryA: letter("A"),
    motorcycle: /バイク|二輪|オートバイ/,
    car: /自動車|四輪/,
    translation: /翻訳|日本語訳/,
    oneYear: /(?<!\d)1\s*年(?!\d)|一年/,
    arrival: /入国|上陸/,
    places: [/スイス/, /ドイツ/, /フランス/, /ベルギー/, /モナコ/, /台湾/],
  },
  en: {
    permit: /international driving permit|\bIDP\b/i,
    geneva: /Geneva/i,
    vienna: /Vienna/i,
    // The article "A" would match a bare letter here.
    categoryA: /\bcategor(?:y|ies)\s+A\b/i,
    motorcycle: /motorcycle|motorbike/i,
    car: /\b(?:car|automobile)s?\b/i,
    translation: /translation/i,
    oneYear: /\b(?:1|one)[- ]year\b/i,
    arrival: /arriv|\bentry\b/i,
    places: [/Switzerland/, /Germany/, /France/, /Belgium/, /Monaco/, /Taiwan/],
  },
  "zh-cn": {
    permit: /国际驾照|国际驾驶/,
    geneva: /日内瓦/,
    vienna: /维也纳/,
    categoryA: letter("A"),
    motorcycle: /摩托/,
    car: /汽车|轿车|小客车/,
    translation: /翻译|译文/,
    oneYear: /(?<!\d)1\s*年(?!\d)|一年/,
    arrival: /入境|抵达|到达/,
    places: [/瑞士/, /德国/, /法国/, /比利时/, /摩纳哥/, /台湾/],
  },
  ko: {
    permit: /국제\s*(?:운전)?\s*면허/,
    geneva: /제네바/,
    vienna: /비엔나|빈\s*협약/,
    categoryA: letter("A"),
    motorcycle: /오토바이|이륜|모터사이클/,
    car: /자동차|승용차/,
    translation: /번역/,
    oneYear: /(?<!\d)1\s*년|일\s*년/,
    arrival: /입국|도착/,
    places: [/스위스/, /독일/, /프랑스/, /벨기에/, /모나코/, /대만|타이완/],
  },
};

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

test("each locale states the license classes", async () => {
  for (const locale of LOCALES) {
    const section = (await faqSections(locale))["license-classes"];
    const blocks = blocksOf(section);
    const terms = licenseTerms[locale];
    const label = `${locale} license-classes`;

    assertTogether(blocks, label, cc(50), terms.moped);
    assertTogether(blocks, label, cc(50), terms.car);
    assertTogether(blocks, label, fourKilowatts, cc(125), terms.moped);
    assertTogether(blocks, label, cc(125), terms.small);
    assertTogether(blocks, label, cc(400), terms.standard);
    assertTogether(blocks, label, cc(400), terms.large);
    assert.match(visibleText(section), terms.since, `${label}: the date of the 4.0 kW rule`);
  }
});

test("each locale explains permits", async () => {
  for (const locale of LOCALES) {
    const section = (await faqSections(locale))["international-permits"];
    const blocks = blocksOf(section);
    const text = visibleText(section);
    const terms = permitTerms[locale];
    const label = `${locale} international-permits`;

    assertTogether(blocks, label, year(1949), terms.geneva, terms.permit);
    assertTogether(blocks, label, terms.categoryA, terms.motorcycle);
    assertTogether(blocks, label, letter("B"), terms.car);

    assertTogether(blocks, label, terms.translation, /JAF/);
    for (const place of terms.places) {
      assert.match(text, place, label);
    }

    assertTogether(blocks, label, terms.oneYear, terms.arrival);

    assertTogether(sentencesOf(section), `${label}, as a refusal`, year(1968), terms.vienna, negation[locale]);
  }
});

test("each locale lists cards and excludes UnionPay", async () => {
  for (const locale of LOCALES) {
    const section = (await faqSections(locale))["payment-cards"];
    const text = visibleText(section);
    const terms = cardTerms[locale];
    const label = `${locale} payment-cards`;

    for (const brand of terms.brands) {
      assert.match(text, brand, label);
    }

    // An accepted-cards list that names UnionPay leaves a sentence with no negation here.
    const unionPay = sentencesOf(section).filter((sentence) => terms.unionPay.test(sentence));
    assert.ok(unionPay.length > 0, `${label}: UnionPay is not mentioned`);
    for (const sentence of unionPay) {
      assert.match(sentence, negation[locale], `${label}: UnionPay is not refused here`);
    }
    assert.ok(
      unionPay.some((sentence) => terms.online.test(sentence)),
      `${label}: the refusal does not say online\n${unionPay.join("\n")}`,
    );
  }
});

test("anchors match across locales", async () => {
  const idsByLocale = new Map<Locale, string[]>();

  for (const locale of LOCALES) {
    const main = await faqMain(locale);
    const ids = idsIn(main).map(({ id }) => id);
    idsByLocale.set(locale, ids);

    for (const anchor of ANCHORS) {
      assert.equal(ids.filter((id) => id === anchor).length, 1, `${locale}: elements with id="${anchor}"`);
    }

    const sections = sectionsIn(main, locale);
    for (const anchor of ANCHORS) {
      const body = bodyOf(sections[anchor]);
      assert.match(body, script[locale].must, `${locale} ${anchor}: no text in the locale's script`);
      const { mustNot } = script[locale];
      if (mustNot) assert.doesNotMatch(body, mustNot, `${locale} ${anchor}: text from another locale`);
    }

    const page = new URL(`/${locale}/faq`, base);
    const links = tagsIn(sections["deposit-and-cancellation"]).flatMap(({ name, attributes }) =>
      name === "a" && attributes.href !== undefined
        ? [new URL(attributes.href, page).pathname.replace(/\/$/, "")]
        : [],
    );
    assert.ok(
      links.includes(`/${locale}/policies`),
      `${locale} deposit-and-cancellation links to ${JSON.stringify(links)}, not /${locale}/policies`,
    );
  }

  // Every id, not only the five, so a heading's own slug in one language cannot make a locale's anchors differ.
  const [first, ...others] = LOCALES;
  for (const locale of others) {
    assert.deepEqual(idsByLocale.get(locale), idsByLocale.get(first), `${locale} ids against ${first}`);
  }
});

test("faq returns 200 for each locale and 404 for unknown ones", async () => {
  const langs: Record<Locale, string> = { ja: "ja", en: "en", "zh-cn": "zh-CN", ko: "ko" };

  // Without these the test would pass on a site with no FAQ route at all.
  for (const [index, locale] of LOCALES.entries()) {
    // The nav links with a trailing slash, and the header of another locale must not move the reader.
    const otherLocale = LOCALES[(index + 1) % LOCALES.length] as Locale;
    for (const path of [`/${locale}/faq`, `/${locale}/faq/`]) {
      const res = await worker.fetch(path, { headers: { "Accept-Language": otherLocale }, redirect: "manual" });
      const html = await res.text();
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
      assert.equal(tagsIn(html).find(({ name }) => name === "html")?.attributes.lang, langs[locale], `${path} lang`);
    }
  }

  const unknown = [
    "fr",
    "de",
    "th",
    "xx",
    // Near misses of the four codes. Astro's own check ignores case, so it passes /JA/.
    "zh",
    "zh-tw",
    "zh-hans",
    "zh_cn",
    "zh-CN",
    "ZH-CN",
    "JA",
    "En",
    "en-us",
    "ja-jp",
    "ko-kr",
    "jp",
    "kr",
    "cn",
    // Names every object inherits, for a guard built on a lookup.
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "length",
    "0",
    // Not codes at all.
    "%E6%97%A5%E6%9C%AC",
    "ja%20",
  ];
  for (const segment of unknown) {
    for (const path of [`/${segment}/faq`, `/${segment}/faq/`]) {
      const res = await worker.fetch(path, { redirect: "manual" });
      await res.text();
      assert.equal(res.status, 404, path);
    }
  }
});
