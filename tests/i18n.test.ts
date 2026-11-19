// The i18n helpers: language negotiation, the html lang tag, the sheet-text fallback order, t(), and the
// string dictionaries, found by reading src/i18n/strings/ at run time so modules added later are checked too.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fallbackOrder, htmlLang, localePath, negotiateLocale } from "../src/i18n/locales.ts";
import { calendar } from "../src/i18n/strings/calendar.ts";
import { model } from "../src/i18n/strings/model.ts";
import { rentals } from "../src/i18n/strings/rentals.ts";
import { t } from "../src/i18n/t.ts";
import { isLocale, LOCALES, type Locale } from "../src/lib/locale.ts";
import { FIELD_PLACEHOLDERS } from "./helpers/return-summary.ts";

test("negotiateLocale picks the best supported language", () => {
  const table: [string | null, Locale][] = [
    // Each language and its regions.
    ["ja", "ja"],
    ["ja-JP", "ja"],
    ["ko", "ko"],
    ["ko-KR", "ko"],
    ["en", "en"],
    ["en-US", "en"],
    ["en-GB", "en"],
    // Every Chinese variant goes to Simplified, the only Chinese the site has.
    ["zh", "zh-cn"],
    ["zh-CN", "zh-cn"],
    ["zh-SG", "zh-cn"],
    ["zh-Hans", "zh-cn"],
    ["zh-Hans-CN", "zh-cn"],
    ["zh-TW", "zh-cn"],
    ["zh-HK", "zh-cn"],
    ["zh-Hant", "zh-cn"],
    ["zh-Hant-TW", "zh-cn"],

    // Nothing usable falls back to en.
    [null, "en"],
    ["", "en"],
    ["   ", "en"],
    [",", "en"],
    [",,;;", "en"],
    ["garbage", "en"],
    ["q=1", "en"],
    ["fr", "en"],
    ["de-DE", "en"],
    ["th", "en"],
    ["pt-BR, es;q=0.9", "en"],

    // Headers as browsers send them.
    ["ja,en-US;q=0.9,en;q=0.8", "ja"],
    ["en-US,en;q=0.9,ja;q=0.8", "en"],
    ["ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7", "ko"],
    ["zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7", "zh-cn"],
    ["fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7", "en"],
    ["de-DE,de;q=0.9,ja;q=0.8", "ja"],

    // An unsupported first choice gives way to the next supported one.
    ["fr, ja;q=0.5", "ja"],
    ["fr, ko;q=0.5", "ko"],
    ["fr;q=1, de;q=0.9, zh-TW;q=0.5, en;q=0.4", "zh-cn"],
    ["fr-CA, en-GB;q=0.9, ko;q=0.8", "en"],

    // q-values outrank position, in both directions.
    ["ja;q=0.5, ko;q=0.9", "ko"],
    ["ko;q=0.5, ja;q=0.9", "ja"],
    ["en;q=0.8, ja", "ja"],
    ["ja;q=0.8, en", "en"],
    ["ja;q=0.9, en-US;q=0.95, ko;q=0.92", "en"],
    ["ja;q=1.0, ko;q=0.999", "ja"],
    ["ko;q=0.1, ja;q=0.11", "ja"],
    ["ja;q=0.1, ko;q=0.11", "ko"],
    ["ja;q=0.7, en-US;q=0.5, en;q=0.9", "en"],
    ["ko;q=0.2, zh-TW;q=0.1, zh-CN;q=0.3", "zh-cn"],

    // Equal weights keep the header's order.
    ["ko;q=0.9, ja;q=0.9", "ko"],
    ["ja;q=0.9, ko;q=0.9", "ja"],
    ["zh-CN, ja, ko", "zh-cn"],
    ["ko;q=0.5, ja;q=0.50", "ko"],

    // q=0 means "not this one".
    ["ja;q=0", "en"],
    ["ko;q=0.000", "en"],
    ["ja;q=0, ko", "ko"],
    ["ko;q=0, ja;q=0.001", "ja"],
    ["ja;q=0.000, ko;q=0.001", "ko"],
    ["en;q=0, ja;q=0.2", "ja"],
    ["en;q=0, zh-CN;q=0.2", "zh-cn"],
    ["ko;q=0, ja;q=0.0, zh;q=0.000", "en"],

    // Tags and the q parameter ignore case.
    ["JA", "ja"],
    ["KO-kr", "ko"],
    ["ZH-hans", "zh-cn"],
    ["zh-hant-tw", "zh-cn"],
    ["En-Us", "en"],
    ["ja;Q=0.5, ko;Q=0.9", "ko"],

    // Optional whitespace.
    ["  ko  ", "ko"],
    ["ja ; q=0.2 , ko ; q=0.8", "ko"],
    ["ja;q=0.8,\tko;q=0.2", "ja"],

    // The wildcard matches any language not listed, at its own q, and resolves to the en fallback.
    ["*", "en"],
    ["*;q=0.5", "en"],
    ["*;q=0", "en"],
    ["fr, *;q=0.5", "en"],
    ["ko, *;q=0.5", "ko"],
    ["ja;q=0.9, *;q=0.1", "ja"],
    ["*;q=0, ja", "ja"],
    ["ko;q=0.5, *", "en"],
    ["*;q=0.5, ko", "ko"],

    // Other languages whose code starts with a supported one.
    ["jam", "en"],
    ["kok", "en"],
    ["zha", "en"],
    ["jam, ko;q=0.5", "ko"],
    ["kok, ja;q=0.5", "ja"],
    ["zha, ko;q=0.5", "ko"],
    ["enm, ko;q=0.5", "ko"],

    // Names every object inherits, for a lookup table keyed by language.
    ["constructor", "en"],
    ["__proto__", "en"],
    ["toString, ko;q=0.5", "ko"],
  ];
  for (const [header, expected] of table) {
    assert.equal(negotiateLocale(header), expected, `negotiateLocale(${JSON.stringify(header)})`);
  }
});

test("negotiateLocale returns a locale for any malformed header", () => {
  const headers = [
    "ja;q=abc",
    "ko;q=",
    "ko;q",
    "ja;q=2",
    "ko;q=-1",
    "en;q=NaN",
    "zh;q=Infinity",
    "*;q=abc",
    ";q=0.5",
    "=",
    "\u0000",
    "日本語",
    "😀;q=1",
    "../../etc/passwd",
    "a".repeat(100_000),
    "ja,".repeat(10_000),
  ];
  for (const header of headers) {
    const locale = negotiateLocale(header);
    assert.equal(isLocale(locale), true, `negotiateLocale(${JSON.stringify(header.slice(0, 40))}) gave ${locale}`);
  }
});

test("htmlLang gives each locale's BCP 47 tag", () => {
  const expected: Record<Locale, string> = { ja: "ja", en: "en", "zh-cn": "zh-CN", ko: "ko" };
  for (const locale of LOCALES) {
    assert.equal(htmlLang(locale), expected[locale], locale);
  }
});

test("fallbackOrder tries the requested locale, then en, then ja, each once", () => {
  const expected: Record<Locale, Locale[]> = {
    ja: ["ja", "en"],
    en: ["en", "ja"],
    "zh-cn": ["zh-cn", "en", "ja"],
    ko: ["ko", "en", "ja"],
  };
  for (const locale of LOCALES) {
    assert.deepEqual([...fallbackOrder(locale)], expected[locale], locale);
  }
});

test("localePath swaps only the leading locale segment", () => {
  const table: [pathname: string, search: string, target: Locale, expected: string][] = [
    // A locale's home.
    ["/ja/", "", "ko", "/ko/"],
    ["/ko/", "", "zh-cn", "/zh-cn/"],
    ["/zh-cn/", "", "en", "/en/"],
    // A nested path keeps the rest and its trailing slash, or the lack of one.
    ["/en/rentals/pcx-160/", "", "ja", "/ja/rentals/pcx-160/"],
    ["/en/rentals/pcx-160", "", "ko", "/ko/rentals/pcx-160"],
    ["/zh-cn/faq/", "", "ja", "/ja/faq/"],
    ["/ja/caf%C3%A9/", "", "en", "/en/caf%C3%A9/"],
    // No trailing slash stays that way.
    ["/ja", "", "ko", "/ko"],
    ["/zh-cn", "", "ja", "/ja"],
    ["/ja", "?a=1", "zh-cn", "/zh-cn?a=1"],
    // A later segment equal to a locale stays put, and so does one that only starts like a locale.
    ["/ja/en/ko/", "", "zh-cn", "/zh-cn/en/ko/"],
    ["/ja/en/ko/", "", "en", "/en/en/ko/"],
    ["/ja/ja/", "", "en", "/en/ja/"],
    ["/en/english/", "", "ja", "/ja/english/"],
    // The search string is kept byte for byte, however much it looks like the path.
    ["/ja/rentals/", "?next=/ja/rentals&back=/ja/", "ko", "/ko/rentals/?next=/ja/rentals&back=/ja/"],
    ["/ja/", "?q=a+b%20c&tag=%E6%B2%96&empty=", "en", "/en/?q=a+b%20c&tag=%E6%B2%96&empty="],
    ["/en/", "?b=2&a=1&a=0", "ja", "/ja/?b=2&a=1&a=0"],
    // A target equal to the current locale changes nothing.
    ["/ko/", "", "ko", "/ko/"],
    ["/zh-cn/rentals/", "?a=/zh-cn/", "zh-cn", "/zh-cn/rentals/?a=/zh-cn/"],
  ];
  for (const [pathname, search, target, expected] of table) {
    assert.equal(
      localePath(pathname, search, target),
      expected,
      `localePath(${JSON.stringify(pathname)}, ${JSON.stringify(search)}, ${JSON.stringify(target)})`,
    );
  }

  // Every locale to every locale, so no pair is special-cased.
  for (const from of LOCALES) {
    for (const to of LOCALES) {
      assert.equal(localePath(`/${from}/faq/`, `?from=/${from}/`, to), `/${to}/faq/?from=/${from}/`, `${from} to ${to}`);
    }
  }
});

test("t reads the key's text for the locale from the dictionary it is given", () => {
  const first = {
    "nav.rentals": { ja: "レンタル", en: "Rentals", "zh-cn": "租赁", ko: "대여" },
    "nav.access": { ja: "アクセス", en: "Access", "zh-cn": "交通", ko: "오시는 길" },
  };
  // The same key in another dictionary must answer from that dictionary.
  const second = {
    "nav.rentals": { ja: "一", en: "two", "zh-cn": "三", ko: "넷" },
  };
  for (const locale of LOCALES) {
    assert.equal(t(locale, first, "nav.rentals"), first["nav.rentals"][locale], locale);
    assert.equal(t(locale, first, "nav.access"), first["nav.access"][locale], locale);
    assert.equal(t(locale, second, "nav.rentals"), second["nav.rentals"][locale], locale);
  }
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Everything wrong with one exported dictionary. An empty list means every key is filled in all four locales. */
function dictionaryProblems(label: string, dict: unknown): string[] {
  if (!isPlainObject(dict)) return [`${label} is not a dictionary`];
  const keys = Object.keys(dict);
  if (keys.length === 0) return [`${label} has no keys`];
  const problems: string[] = [];
  for (const key of keys) {
    const entry = dict[key];
    if (!isPlainObject(entry)) {
      problems.push(`${label}.${key} is not a per-locale record`);
      continue;
    }
    for (const locale of LOCALES) {
      const text = entry[locale];
      if (typeof text !== "string" || text.trim() === "") problems.push(`${label}.${key} has no ${locale} text`);
    }
    for (const code of Object.keys(entry)) {
      if (!isLocale(code)) problems.push(`${label}.${key} has text for ${code}, which is not a site locale`);
    }
  }
  return problems;
}

test("every string key exists in all four locales", async () => {
  // The check itself must be able to fail, or a broken module would pass unnoticed.
  const full = { ja: "あ", en: "a", "zh-cn": "阿", ko: "아" };
  assert.deepEqual(dictionaryProblems("good", { a: full, b: full }), []);
  const bad: unknown[] = [
    null,
    "text",
    42,
    [],
    {},
    { a: "text" },
    { a: null },
    { a: full, b: { ja: "あ", en: "a", "zh-cn": "阿" } },
    { a: { ...full, ko: "" } },
    { a: { ...full, en: "   " } },
    { a: { ...full, ja: 7 } },
    { a: { ...full, zh: "阿" } },
  ];
  for (const dict of bad) {
    assert.notDeepEqual(dictionaryProblems("bad", dict), [], `the check let ${JSON.stringify(dict)} through`);
  }

  const dir = new URL("../src/i18n/strings/", import.meta.url);
  assert.ok(existsSync(dir), "src/i18n/strings/ does not exist");
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
  assert.ok(files.includes("common.ts"), `src/i18n/strings/ has no common.ts, only ${JSON.stringify(files)}`);

  const problems: string[] = [];
  for (const file of files) {
    const loaded = (await import(new URL(file, dir).href)) as Record<string, unknown>;
    const exported = Object.entries(loaded);
    if (exported.length === 0) problems.push(`${file} exports nothing`);
    for (const [name, dict] of exported) {
      problems.push(...dictionaryProblems(`${file}:${name}`, dict));
    }
  }
  assert.deepEqual(problems, []);
});

// #137: the date field's strings, each with exactly the placeholders tests/helpers/return-summary.ts fills for its kind,
// so a locale that drops the return day or the closing time shows.
test("the date field's strings exist in all four locales with their placeholders", () => {
  for (const [key, placeholders] of Object.entries(FIELD_PLACEHOLDERS)) {
    for (const locale of LOCALES) {
      const text = calendar[key]?.[locale];
      assert.ok(typeof text === "string" && text.trim() !== "", `calendar.ts: ${key} has no ${locale} text`);
      const found = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(found, placeholders, `calendar.ts: the placeholders of ${key} in ${locale}: ${JSON.stringify(text)}`);
      assert.ok(!/[{}]/.test(text.replace(/\{\w+\}/g, "")), `calendar.ts: a stray brace in ${key} in ${locale}`);
    }
  }
});

/** Every reason pickupWindowError gives. RETURN_OUTSIDE_HOURS is #50's: an hours package back after closing time. */
const WINDOW_REASONS = [
  "TOO_SOON",
  "TOO_FAR",
  "OFF_SLOT",
  "OUTSIDE_HOURS",
  "CLOSED_PICKUP",
  "RETURN_OUTSIDE_HOURS",
  "CLOSED_RETURN",
];

// The model page shows `model.error.<reason>` and the listing `rentals.error.<reason>`, and neither has a fallback.
test("every pickup-window reason has a guest message on the model page and the listing", () => {
  const pages = [
    ["model", model, "model.error."],
    ["rentals", rentals, "rentals.error."],
  ] as const;
  for (const [name, dict, prefix] of pages) {
    for (const reason of WINDOW_REASONS) {
      for (const locale of LOCALES) {
        const text = dict[`${prefix}${reason}`]?.[locale];
        assert.ok(typeof text === "string" && text.trim() !== "", `${name}: ${prefix}${reason} has no ${locale} text`);
      }
    }
    // A late return is not the pickup's hours nor a closed return day, so the guest is told something else.
    for (const locale of LOCALES) {
      const late = dict[`${prefix}RETURN_OUTSIDE_HOURS`]?.[locale];
      for (const other of ["OUTSIDE_HOURS", "CLOSED_RETURN"]) {
        assert.notEqual(late, dict[`${prefix}${other}`]?.[locale], `${name}: ${locale} says the same for ${other}`);
      }
    }
  }
});
