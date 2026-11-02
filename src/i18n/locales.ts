// Language negotiation, the html lang tag, the sheet-text fallback order and the path swap of the language switcher.
import type { Locale } from "../lib/locale.ts";

const DEFAULT_LOCALE: Locale = "en";

/** The site locale for each primary language subtag. Every Chinese variant goes to Simplified, the only Chinese here. */
const LOCALE_BY_LANGUAGE = new Map<string, Locale>([
  ["ja", "ja"],
  ["en", "en"],
  ["zh", "zh-cn"],
  ["ko", "ko"],
]);

const QVALUE = /^(?:0(?:\.\d*)?|1(?:\.0*)?)$/;

/** One Accept-Language range as its lower-case primary subtag and weight. A malformed q weighs 0, like "not this one". */
function parseRange(range: string): { language: string; q: number } {
  const [tag = "", ...params] = range.split(";");
  const language = tag.trim().toLowerCase().split("-")[0] ?? "";
  const q = params.map((param) => param.trim()).find((param) => /^q=/i.test(param));
  if (q === undefined) return { language, q: 1 };
  const value = q.slice(2);
  return { language, q: QVALUE.test(value) ? Number(value) : 0 };
}

/**
 * The best supported locale for an Accept-Language header: the highest q, then the header's order, and en when nothing
 * matches. `*` stands for any language the header does not list, so it counts as en unless en is listed.
 */
export function negotiateLocale(acceptLanguage: string | null): Locale {
  const ranges = (acceptLanguage ?? "").split(",").map(parseRange);
  const enListed = ranges.some(({ language }) => language === "en");
  let best = DEFAULT_LOCALE;
  let bestQ = 0;
  for (const { language, q } of ranges) {
    const locale = language === "*" && !enListed ? DEFAULT_LOCALE : LOCALE_BY_LANGUAGE.get(language);
    if (locale !== undefined && q > bestQ) {
      best = locale;
      bestQ = q;
    }
  }
  return best;
}

/** The BCP 47 tag for `<html lang>` and hreflang. */
export function htmlLang(locale: Locale): string {
  return locale === "zh-cn" ? "zh-CN" : locale;
}

/** The locales to try for text from the sheet, in order: the requested one, then en, then ja. */
export function fallbackOrder(locale: Locale): Locale[] {
  return [...new Set<Locale>([locale, "en", "ja"])];
}

/** The same page in `target`: swaps the leading locale segment of `pathname` and appends `search` unchanged. */
export function localePath(pathname: string, search: string, target: Locale): string {
  return pathname.replace(/^\/[^/]+/, `/${target}`) + search;
}
