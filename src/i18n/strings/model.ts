// The strings of the model page and its booking form. License names follow the FAQ's license classes. Agent drafts,
// awaiting native-speaker review (see epic #3).
import type { Dictionary } from "../t.ts";

const PACKAGE_REFUSED = {
  ja: "このプランはこの車両では予約できません。一覧から選んでください。",
  en: "That package cannot be booked for this model. Choose one from the list.",
  "zh-cn": "此车型无法预订该套餐，请从列表中选择。",
  ko: "이 차량은 해당 패키지로 예약할 수 없습니다. 목록에서 선택해 주세요.",
};

export const model: Dictionary = {
  "model.details.type": { ja: "車両タイプ", en: "Type", "zh-cn": "类型", ko: "종류" },
  "model.details.engine": { ja: "排気量", en: "Engine", "zh-cn": "排气量", ko: "배기량" },
  "model.details.license": { ja: "必要な免許", en: "License required", "zh-cn": "所需驾照", ko: "필요한 면허" },
  "model.license.moped": { ja: "原付免許", en: "Moped license", "zh-cn": "原付驾照", ko: "원동기 면허" },
  "model.license.small": {
    ja: "小型限定普通二輪免許",
    en: "Small-motorcycle license",
    "zh-cn": "小型二轮驾照",
    ko: "소형 이륜 면허",
  },
  "model.license.standard": {
    ja: "普通二輪免許",
    en: "Standard motorcycle license",
    "zh-cn": "普通二轮驾照",
    ko: "보통 이륜 면허",
  },
  "model.license.large": {
    ja: "大型二輪免許",
    en: "Large motorcycle license",
    "zh-cn": "大型二轮驾照",
    ko: "대형 이륜 면허",
  },
  "model.license.car": { ja: "普通自動車免許", en: "Car license", "zh-cn": "汽车驾照", ko: "자동차 면허" },
  "model.license.none": { ja: "免許不要", en: "No license required", "zh-cn": "无需驾照", ko: "면허 불필요" },
  "model.license.more": {
    ja: "免許の区分について",
    en: "About license classes",
    "zh-cn": "了解驾照类别",
    ko: "면허 종류 안내",
  },

  "model.prices.heading": { ja: "料金", en: "Prices", "zh-cn": "价格", ko: "요금" },
  "model.prices.price": { ja: "料金", en: "Price", "zh-cn": "价格", ko: "요금" },
  "model.deposit": {
    ja: "予約時にオンラインで支払う予約金：{amount}",
    en: "Deposit, paid online when you book: {amount}",
    "zh-cn": "预订时在线支付的订金：{amount}",
    ko: "예약 시 온라인으로 결제하는 예약금: {amount}",
  },

  "model.booking.heading": { ja: "予約する", en: "Book this vehicle", "zh-cn": "预订此车", ko: "예약하기" },
  "model.booking.submit": { ja: "予約に進む", en: "Continue", "zh-cn": "继续预订", ko: "예약 계속하기" },
  "model.booking.unavailable": {
    ja: "この車両はオンラインではまだ予約できません。",
    en: "This model cannot be booked online yet.",
    "zh-cn": "此车型暂时无法在线预订。",
    ko: "이 차량은 아직 온라인으로 예약할 수 없습니다.",
  },
  "model.available": {
    ja: "ご希望の受取日時で空きがあります。",
    en: "Available for the pickup you chose.",
    "zh-cn": "您选择的取车时间有空车。",
    ko: "선택하신 픽업 일시에 예약할 수 있습니다.",
  },
  "model.soldOut": {
    ja: "ご希望の受取日時は満車です。",
    en: "Sold out for the pickup you chose.",
    "zh-cn": "您选择的取车时间已满。",
    ko: "선택하신 픽업 일시는 예약이 마감되었습니다.",
  },

  // One key per reason createHold gives, by `model.error.{reason}`.
  "model.error.SOLD_OUT": {
    ja: "申し訳ありません。この車両は空きがなくなりました。別の日付かプランをお試しください。",
    en: "Sorry, there is no vehicle of this model left for that pickup. Try another date or package.",
    "zh-cn": "抱歉，此车型在该时间已无空车。请尝试其他日期或套餐。",
    ko: "죄송합니다. 해당 일시에 이 차량의 여유가 없습니다. 다른 날짜나 패키지를 선택해 주세요.",
  },
  "model.error.TOO_SOON": {
    ja: "受取日時が近すぎます。もっと後の日時を選んでください。",
    en: "That pickup is too soon. Choose a later date or time.",
    "zh-cn": "取车时间太近，请选择更晚的日期或时间。",
    ko: "픽업 일시가 너무 가깝습니다. 더 늦은 일시를 선택해 주세요.",
  },
  "model.error.TOO_FAR": {
    ja: "受取日が先すぎます。もっと早い日付を選んでください。",
    en: "That pickup is too far ahead. Choose an earlier date.",
    "zh-cn": "取车日期太远，请选择更早的日期。",
    ko: "픽업 날짜가 너무 멉니다. 더 이른 날짜를 선택해 주세요.",
  },
  // Also the answer to a date or time that is no date or time at all.
  "model.error.OFF_SLOT": {
    ja: "受取日と、一覧にある受取時間を選んでください。",
    en: "Choose a pickup date, and a pickup time from the list.",
    "zh-cn": "请选择取车日期，并从列表中选择取车时间。",
    ko: "픽업 날짜를 선택하고 목록에서 픽업 시간을 선택해 주세요.",
  },
  "model.error.OUTSIDE_HOURS": {
    ja: "その時間は営業時間外です。一覧から時間を選んでください。",
    en: "That time is outside shop hours. Choose a time from the list.",
    "zh-cn": "该时间不在营业时间内，请从列表中选择时间。",
    ko: "해당 시간은 영업시간이 아닙니다. 목록에서 시간을 선택해 주세요.",
  },
  "model.error.CLOSED_PICKUP": {
    ja: "その受取日は休業日です。別の日付を選んでください。",
    en: "The shop is closed on that pickup date. Choose another date.",
    "zh-cn": "该取车日期为停业日，请选择其他日期。",
    ko: "해당 픽업 날짜는 휴업일입니다. 다른 날짜를 선택해 주세요.",
  },
  "model.error.RETURN_OUTSIDE_HOURS": {
    ja: "このプランは閉店時間までにご返却いただく必要があります。もっと早い受取時間を選んでください。",
    en: "This package must be back by closing time. Choose an earlier pickup time.",
    "zh-cn": "此套餐须在闭店前还车，请选择更早的取车时间。",
    ko: "이 패키지는 폐점 시간까지 반납해야 합니다. 더 이른 픽업 시간을 선택해 주세요.",
  },
  "model.error.CLOSED_RETURN": {
    ja: "このプランの返却日は休業日です。別の日付かプランを選んでください。",
    en: "The shop is closed on the return date of that package. Choose another date or package.",
    "zh-cn": "该套餐的还车日期为停业日，请选择其他日期或套餐。",
    ko: "이 패키지의 반납 날짜는 휴업일입니다. 다른 날짜나 패키지를 선택해 주세요.",
  },
  "model.error.UNKNOWN_PACKAGE": PACKAGE_REFUSED,
  "model.error.NO_PRICE": PACKAGE_REFUSED,
  "model.error.CONFLICT": {
    ja: "予約を開始できませんでした。もう一度お試しください。",
    en: "That booking could not be started. Please try again.",
    "zh-cn": "无法开始预订，请重试。",
    ko: "예약을 시작할 수 없습니다. 다시 시도해 주세요.",
  },
};
