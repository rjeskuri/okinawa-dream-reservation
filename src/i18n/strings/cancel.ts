// The strings of the cancel page. Agent drafts, awaiting native-speaker review (see epic #3).
import type { Dictionary } from "../t.ts";

export const cancel: Dictionary = {
  "cancel.heading": { ja: "ご予約のキャンセル", en: "Booking cancellation", "zh-cn": "取消预订", ko: "예약 취소" },
  "cancel.intro": {
    ja: "内容をご確認のうえ、キャンセルしてください。キャンセルは取り消せません。",
    en: "Please check the details below. A cancellation cannot be undone.",
    "zh-cn": "请确认以下内容后再取消。取消后无法恢复。",
    ko: "아래 내용을 확인한 후 취소해 주세요. 취소 후에는 되돌릴 수 없습니다.",
  },
  "cancel.label.daysBefore": {
    ja: "受取日までの日数",
    en: "Days before pickup",
    "zh-cn": "距取车日天数",
    ko: "픽업일까지 남은 일수",
  },
  "cancel.label.percent": { ja: "返金率", en: "Refund rate", "zh-cn": "退款比例", ko: "환불 비율" },
  "cancel.paidAtShop": {
    ja: "オンラインでのお支払いはないため、キャンセルによる返金はありません。",
    en: "Nothing was paid online, so cancelling refunds nothing.",
    "zh-cn": "由于没有在线支付，取消后不会产生退款。",
    ko: "온라인 결제 내역이 없어 취소하셔도 환불되는 금액은 없습니다.",
  },
  "cancel.submit": {
    ja: "このご予約をキャンセルする",
    en: "Cancel this booking",
    "zh-cn": "取消此预订",
    ko: "이 예약 취소하기",
  },
  "cancel.done": {
    ja: "ご予約をキャンセルしました。確認のメールをお送りします。",
    en: "Your booking has been cancelled. We will send you a confirmation email.",
    "zh-cn": "您的预订已取消，我们将向您发送确认邮件。",
    ko: "예약이 취소되었습니다. 확인 메일을 보내 드리겠습니다.",
  },
  "cancel.already": {
    ja: "このご予約はすでにキャンセルされています。",
    en: "This booking has already been cancelled.",
    "zh-cn": "此预订已被取消。",
    ko: "이 예약은 이미 취소되었습니다.",
  },
  "cancel.started": {
    ja: "受取時刻を過ぎているため、オンラインではキャンセルできません。店舗へお問い合わせください。",
    en: "The pickup time has passed, so this booking cannot be cancelled online. Please contact the shop.",
    "zh-cn": "取车时间已过，无法在线取消。请联系店铺。",
    ko: "픽업 시간이 지나 온라인으로 취소할 수 없습니다. 매장에 문의해 주세요.",
  },
};
