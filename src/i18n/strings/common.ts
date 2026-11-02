// The strings of the base layout. Agent drafts, awaiting native-speaker review (see epic #3).
import type { Locale } from "../../lib/locale.ts";
import type { Dictionary } from "../t.ts";

/** Text that reads the same in every locale: a language's own name and the shop's name. */
function same(text: string): Record<Locale, string> {
  return { ja: text, en: text, "zh-cn": text, ko: text };
}

export const common: Dictionary = {
  "site.name": same("Okinawa Dream"),
  "site.tagline": {
    ja: "沖縄のバイク・スクーター・レンタカー",
    en: "Motorcycle, scooter and car rental in Okinawa",
    "zh-cn": "冲绳摩托车、踏板车和汽车租赁",
    ko: "오키나와 오토바이·스쿠터·자동차 렌탈",
  },
  "nav.label": { ja: "メインメニュー", en: "Main menu", "zh-cn": "主菜单", ko: "메인 메뉴" },
  "nav.rentals": { ja: "レンタル", en: "Rentals", "zh-cn": "租赁", ko: "렌탈" },
  "nav.faq": { ja: "よくある質問", en: "FAQ", "zh-cn": "常见问题", ko: "자주 묻는 질문" },
  "nav.policies": { ja: "規約・ポリシー", en: "Policies", "zh-cn": "条款与政策", ko: "약관 및 정책" },
  "nav.access": { ja: "アクセス", en: "Access", "zh-cn": "交通指南", ko: "오시는 길" },
  "language.label": { ja: "言語", en: "Language", "zh-cn": "语言", ko: "언어" },
  "language.ja": same("日本語"),
  "language.en": same("English"),
  "language.zh-cn": same("简体中文"),
  "language.ko": same("한국어"),
  "footer.rights": {
    ja: "© Okinawa Dream. 無断転載を禁じます。",
    en: "© Okinawa Dream. All rights reserved.",
    "zh-cn": "© Okinawa Dream. 保留所有权利。",
    ko: "© Okinawa Dream. 모든 권리 보유.",
  },
};
