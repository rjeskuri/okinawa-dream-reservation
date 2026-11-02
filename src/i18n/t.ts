// UI text lookup. Each feature keeps its own dictionary under src/i18n/strings/.
import type { Locale } from "../lib/locale.ts";

export type Dictionary = Record<string, Record<Locale, string>>;

/** The text of `key` in `locale`. Keys are written in code, so an unknown one is a bug and throws. */
export function t(locale: Locale, dict: Dictionary, key: string): string {
  const text = dict[key]?.[locale];
  if (text === undefined) throw new Error(`no ${locale} text for string key ${key}`);
  return text;
}
