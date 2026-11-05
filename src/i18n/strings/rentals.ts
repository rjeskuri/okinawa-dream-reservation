// The strings of the rentals listing. Agent drafts, awaiting native-speaker review (see epic #3). License names follow the
// FAQ's in each locale.
import type { Dictionary } from "../t.ts";

export const rentals: Dictionary = {
  // A bare ¥ reads as yuan to a Chinese reader.
  "rentals.amount": { ja: "¥{amount}", en: "¥{amount}", "zh-cn": "{amount}日元", ko: "{amount}엔" },
  "rentals.prompt": {
    ja: "空き状況を見るには、受取日、受取時間、プランを選んでください。",
    en: "Choose a pickup date, time and package to see what is available.",
    "zh-cn": "请选择取车日期、时间和套餐以查看可租车辆。",
    ko: "예약 가능 여부를 보려면 픽업 날짜, 시간, 패키지를 선택해 주세요.",
  },
  "rentals.empty": {
    ja: "条件に合う車両はありません。日程や条件を変えてお試しください。",
    en: "No vehicles match this search. Try other dates or filters.",
    "zh-cn": "没有符合条件的车辆，请尝试其他日期或筛选条件。",
    ko: "조건에 맞는 차량이 없습니다. 다른 날짜나 조건으로 시도해 주세요.",
  },
  "rentals.unpublished": {
    ja: "車両はまだご覧いただけません。しばらくしてからご確認ください。",
    en: "Vehicles are not available yet. Please check back soon.",
    "zh-cn": "车辆暂未开放，请稍后再来查看。",
    ko: "차량은 아직 볼 수 없습니다. 잠시 후 다시 확인해 주세요.",
  },

  "rentals.form.time": { ja: "受取時間", en: "Pickup time", "zh-cn": "取车时间", ko: "픽업 시간" },
  "rentals.form.chooseTime": { ja: "時間を選択", en: "Choose a time", "zh-cn": "选择时间", ko: "시간 선택" },
  "rentals.form.package": { ja: "プラン", en: "Rental package", "zh-cn": "租赁套餐", ko: "렌탈 패키지" },
  "rentals.form.type": { ja: "車種", en: "Vehicle type", "zh-cn": "车辆类型", ko: "차량 종류" },
  "rentals.form.engine": { ja: "排気量", en: "Engine size", "zh-cn": "排气量", ko: "배기량" },
  "rentals.form.any": { ja: "すべて", en: "Any", "zh-cn": "全部", ko: "전체" },
  "rentals.form.submit": { ja: "検索", en: "Search", "zh-cn": "搜索", ko: "검색" },

  "rentals.cc.upto50": { ja: "50cc以下", en: "Up to 50cc", "zh-cn": "50cc及以下", ko: "50cc 이하" },
  "rentals.cc.51to125": { ja: "51〜125cc", en: "51 to 125cc", "zh-cn": "51至125cc", ko: "51~125cc" },
  "rentals.cc.126to400": { ja: "126〜400cc", en: "126 to 400cc", "zh-cn": "126至400cc", ko: "126~400cc" },
  "rentals.cc.over400": { ja: "400cc超", en: "Over 400cc", "zh-cn": "超过400cc", ko: "400cc 초과" },

  "rentals.card.deposit": { ja: "予約金", en: "Deposit", "zh-cn": "订金", ko: "예약금" },
  "rentals.card.noPrice": {
    ja: "このプランはありません",
    en: "Not offered on this package",
    "zh-cn": "此套餐不提供",
    ko: "이 패키지에는 없습니다",
  },

  "rentals.license.moped": { ja: "原付免許", en: "Moped license", "zh-cn": "原付驾照", ko: "원동기 면허" },
  "rentals.license.small": {
    ja: "小型限定普通二輪免許",
    en: "Small-motorcycle license",
    "zh-cn": "小型二轮驾照",
    ko: "소형 이륜 면허",
  },
  "rentals.license.standard": {
    ja: "普通二輪免許",
    en: "Standard motorcycle license",
    "zh-cn": "普通二轮驾照",
    ko: "보통 이륜 면허",
  },
  "rentals.license.large": {
    ja: "大型二輪免許",
    en: "Large motorcycle license",
    "zh-cn": "大型二轮驾照",
    ko: "대형 이륜 면허",
  },
  "rentals.license.car": { ja: "普通自動車免許", en: "Car license", "zh-cn": "汽车驾照", ko: "자동차 면허" },
  "rentals.license.none": { ja: "免許不要", en: "No license required", "zh-cn": "无需驾照", ko: "면허 불필요" },

  "rentals.error.showingAll": {
    ja: "すべての車両を表示しています。",
    en: "All vehicles are shown.",
    "zh-cn": "现显示全部车辆。",
    ko: "모든 차량을 표시합니다.",
  },
  "rentals.error.INVALID": {
    ja: "検索条件の一部を読み取れませんでした。",
    en: "Part of this search could not be read.",
    "zh-cn": "部分搜索条件无法识别。",
    ko: "검색 조건 일부를 읽을 수 없습니다.",
  },
  "rentals.error.TOO_SOON": {
    ja: "その受取日時は早すぎるため、ご予約いただけません。",
    en: "That pickup is too soon to book.",
    "zh-cn": "该取车时间过早，无法预订。",
    ko: "해당 픽업 일시는 너무 가까워 예약할 수 없습니다.",
  },
  "rentals.error.TOO_FAR": {
    ja: "その受取日はまだご予約いただけません。",
    en: "That pickup date is too far ahead to book.",
    "zh-cn": "该取车日期太远，暂时无法预订。",
    ko: "해당 픽업 날짜는 아직 예약할 수 없습니다.",
  },
  "rentals.error.CLOSED_PICKUP": {
    ja: "その受取日は休業日です。",
    en: "The shop is closed on that pickup date.",
    "zh-cn": "该取车日期为停业日。",
    ko: "해당 픽업 날짜는 휴업일입니다.",
  },
  "rentals.error.CLOSED_RETURN": {
    ja: "このプランの返却日は休業日です。",
    en: "The shop is closed on this package's return date.",
    "zh-cn": "此套餐的还车日期为停业日。",
    ko: "이 패키지의 반납 날짜는 휴업일입니다.",
  },
  "rentals.error.OFF_SLOT": {
    ja: "その受取時間は選択できません。",
    en: "That pickup time is not one of the shop's slots.",
    "zh-cn": "无法选择该取车时间。",
    ko: "해당 픽업 시간은 선택할 수 없습니다.",
  },
  "rentals.error.OUTSIDE_HOURS": {
    ja: "その受取時間は営業時間外です。",
    en: "That pickup time is outside shop hours.",
    "zh-cn": "该取车时间不在营业时间内。",
    ko: "해당 픽업 시간은 영업시간 외입니다.",
  },
};
