// The four site locales.

export const LOCALES = ["ja", "en", "zh-cn", "ko"] as const;

export type Locale = (typeof LOCALES)[number];

export function isLocale(x: unknown): x is Locale {
  return (LOCALES as readonly unknown[]).includes(x);
}
