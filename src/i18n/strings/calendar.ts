// The strings of the pickup calendar. Month and weekday names come from Intl.DateTimeFormat. Agent drafts, awaiting
// native-speaker review (see epic #3).
import type { Dictionary } from "../t.ts";

export const calendar: Dictionary = {
  "calendar.pickup": { ja: "受取日", en: "Pickup date", "zh-cn": "取车日期", ko: "픽업 날짜" },
  "calendar.return": { ja: "返却日", en: "Return date", "zh-cn": "还车日期", ko: "반납 날짜" },
  "calendar.previousMonth": { ja: "前の月", en: "Previous month", "zh-cn": "上个月", ko: "이전 달" },
  "calendar.nextMonth": { ja: "次の月", en: "Next month", "zh-cn": "下个月", ko: "다음 달" },
  "calendar.reason.past": {
    ja: "予約可能日より前です",
    en: "Before the first bookable date",
    "zh-cn": "早于最早可预订日期",
    ko: "예약 가능일 이전입니다",
  },
  "calendar.reason.too_far": {
    ja: "予約可能期間を過ぎています",
    en: "Beyond the booking window",
    "zh-cn": "超出可预订期限",
    ko: "예약 가능 기간을 넘었습니다",
  },
  "calendar.reason.closed": { ja: "休業日", en: "Closed", "zh-cn": "停业日", ko: "휴업일" },
  // The date field (#137), filled by returnSummary in src/lib/calendar.ts: {pickup} and {return} are the day and short
  // month as Intl writes them, {close} the shop's closing time and {hours} an hours package's hours.
  "calendar.field.empty": { ja: "日付を選択", en: "Pick a date", "zh-cn": "选择日期", ko: "날짜 선택" },
  "calendar.field.days": {
    ja: "{pickup} → {return} {close}までに返却",
    en: "{pickup} → back {return} by {close}",
    "zh-cn": "{pickup} → {return} {close}前还车",
    ko: "{pickup} → {return} {close}까지 반납",
  },
  "calendar.field.sameDay": {
    ja: "{pickup}、{close}までに返却",
    en: "{pickup}, back by {close}",
    "zh-cn": "{pickup}，{close}前还车",
    ko: "{pickup}, {close}까지 반납",
  },
  "calendar.field.hours": {
    ja: "{pickup}、{hours}時間、閉店までに返却",
    en: "{pickup}, {hours} hours, back by closing",
    "zh-cn": "{pickup}，{hours}小时，打烊前还车",
    ko: "{pickup}, {hours}시간, 영업 종료 전 반납",
  },
  "calendar.field.fullDay": {
    ja: "{pickup} → {return} 同時刻に返却",
    en: "{pickup} → back {return}, same time",
    "zh-cn": "{pickup} → {return} 同一时间还车",
    ko: "{pickup} → {return} 같은 시간 반납",
  },
};
