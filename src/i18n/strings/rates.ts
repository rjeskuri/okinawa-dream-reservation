// The strings of the fee schedule. Agent drafts, awaiting native-speaker review (see epic #3). The notes are placeholders until
// the shop confirms them, and show under the draft mark. Prices in the tables come from the catalog, never from here.
import type { Dictionary } from "../t.ts";

export const rates: Dictionary = {
  "rates.unpublished": {
    ja: "料金表はまだご覧いただけません。しばらくしてからご確認ください。",
    en: "The fee schedule is not available yet. Please check back soon.",
    "zh-cn": "价目表暂未开放，请稍后再来查看。",
    ko: "요금표는 아직 볼 수 없습니다. 잠시 후 다시 확인해 주세요.",
  },

  "rates.form.group": { ja: "車両区分", en: "Vehicle group", "zh-cn": "车辆类别", ko: "차량 구분" },
  "rates.form.duration": { ja: "期間", en: "Duration", "zh-cn": "租期", ko: "기간" },
  "rates.form.submit": { ja: "絞り込む", en: "Filter", "zh-cn": "筛选", ko: "필터 적용" },
  "rates.class": { ja: "クラス", en: "Class", "zh-cn": "车型级别", ko: "클래스" },
  "rates.group.bike": { ja: "バイク", en: "Bikes", "zh-cn": "摩托车", ko: "오토바이" },
  "rates.group.car": { ja: "レンタカー", en: "Cars", "zh-cn": "汽车", ko: "자동차" },
  "rates.group.ebike": { ja: "電動アシスト自転車", en: "E-bikes", "zh-cn": "电动助力自行车", ko: "전기자전거" },
  // The two prices of a row with an advance price (#131): booked by 23:59 JST the day before the pickup, or on the day.
  "rates.price.advance": {
    ja: "前日までに予約",
    en: "Book by the day before",
    "zh-cn": "最晚前一天预订",
    ko: "전날까지 예약",
  },
  "rates.price.sameDay": { ja: "当日予約", en: "Same day", "zh-cn": "当天预订", ko: "당일 예약" },

  "rates.error.invalid": {
    ja: "絞り込み条件の一部を読み取れませんでした。料金表全体を表示しています。",
    en: "Part of this filter could not be read. The whole fee schedule is shown.",
    "zh-cn": "部分筛选条件无法识别。现显示完整价目表。",
    ko: "필터 조건 일부를 읽을 수 없습니다. 전체 요금표를 표시합니다.",
  },
  "rates.error.empty": {
    ja: "この条件に合う料金はありません。条件を変えてお試しください。",
    en: "No prices match these filters. Try a different choice.",
    "zh-cn": "没有符合这些条件的价格，请更改筛选条件。",
    ko: "이 조건에 맞는 요금이 없습니다. 다른 조건을 선택해 주세요.",
  },

  "rates.extension.heading": { ja: "延長料金", en: "Extra hours", "zh-cn": "超时费用", ko: "연장 요금" },
  "rates.extension.price": { ja: "1時間ごと", en: "Per extra hour", "zh-cn": "每超1小时", ko: "1시간당" },

  "rates.options.heading": { ja: "オプション", en: "Options", "zh-cn": "附加选项", ko: "옵션" },
  "rates.options.name": { ja: "品目", en: "Option", "zh-cn": "项目", ko: "항목" },
  "rates.options.base": { ja: "最初の24時間", en: "First 24 hours", "zh-cn": "首24小时", ko: "최초 24시간" },
  "rates.options.perHour": { ja: "追加1時間ごと", en: "Each extra hour", "zh-cn": "每增加1小时", ko: "추가 1시간당" },
  "rates.options.per24h": { ja: "追加24時間ごと", en: "Each extra 24 hours", "zh-cn": "每增加24小时", ko: "추가 24시간당" },
  "rates.free": { ja: "無料", en: "Free", "zh-cn": "免费", ko: "무료" },

  "rates.notes.heading": {
    ja: "補償と繁忙期料金",
    en: "Coverage and peak pricing",
    "zh-cn": "保障与旺季价格",
    ko: "보상 및 성수기 요금",
  },
  "rates.note.coverage": {
    ja: "自動車のNOC補償は1日あたり1,500〜2,000円です。正確な料金は店舗の確認待ちです。",
    en: "NOC cover for cars is ¥1,500 to ¥2,000 a day. The shop has yet to confirm exact prices.",
    "zh-cn": "汽车NOC保障为每天1,500至2,000日元。具体价格有待店铺确认。",
    ko: "자동차 NOC 보상은 하루 1,500~2,000엔입니다. 정확한 요금은 매장 확인을 기다리고 있습니다.",
  },
  "rates.note.peak": {
    ja: "繁忙期の料金はこの表と異なる場合があります。対象期間と金額は店舗の確認待ちです。",
    en: "Prices in peak periods may differ from this schedule. The shop has yet to confirm the dates and amounts.",
    "zh-cn": "旺季价格可能与本表不同。具体日期和金额有待店铺确认。",
    ko: "성수기 요금은 이 표와 다를 수 있습니다. 해당 기간과 금액은 매장 확인을 기다리고 있습니다.",
  },
};
