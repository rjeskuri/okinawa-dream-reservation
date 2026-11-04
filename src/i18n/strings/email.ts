// The strings of the outbox emails. `{name}` marks a value that src/lib/mail/templates.ts fills in. Agent drafts, awaiting
// native-speaker review (see epic #3).
import type { Locale } from "../../lib/locale.ts";
import type { Dictionary } from "../t.ts";

/** Text only staff read. Their mail is always Japanese, so no other locale is rendered, and each just repeats it. */
function japanese(text: string): Record<Locale, string> {
  return { ja: text, en: text, "zh-cn": text, ko: text };
}

export const email: Dictionary = {
  // A bare ¥ reads as yuan to a Chinese reader.
  "email.amount": { ja: "¥{amount}", en: "¥{amount}", "zh-cn": "{amount}日元", ko: "{amount}엔" },
  "email.greeting": {
    ja: "{familyName} {givenName} 様",
    en: "Dear {givenName} {familyName},",
    "zh-cn": "{familyName} {givenName}，您好：",
    ko: "{familyName} {givenName} 고객님, 안녕하세요.",
  },
  "email.closing": {
    ja: "Okinawa Dream をご利用いただきありがとうございます。",
    en: "Thank you for choosing Okinawa Dream.",
    "zh-cn": "感谢您选择 Okinawa Dream。",
    ko: "Okinawa Dream을 이용해 주셔서 감사합니다.",
  },

  "email.label.ref": { ja: "予約番号", en: "Booking reference", "zh-cn": "预订编号", ko: "예약 번호" },
  "email.label.model": { ja: "車種", en: "Model", "zh-cn": "车型", ko: "차종" },
  "email.label.package": { ja: "パッケージ", en: "Package", "zh-cn": "套餐", ko: "패키지" },
  "email.label.pickup": { ja: "受取", en: "Pickup", "zh-cn": "取车", ko: "픽업" },
  "email.label.return": { ja: "返却", en: "Return", "zh-cn": "还车", ko: "반납" },
  "email.label.price": { ja: "料金", en: "Price", "zh-cn": "费用", ko: "요금" },
  "email.label.paid": { ja: "お支払い済みの予約金", en: "Deposit paid", "zh-cn": "已付订金", ko: "결제한 예약금" },
  "email.label.hours": { ja: "営業時間", en: "Shop hours", "zh-cn": "营业时间", ko: "영업시간" },
  "email.label.policy": { ja: "キャンセルポリシー", en: "Cancellation policy", "zh-cn": "取消政策", ko: "취소 정책" },
  "email.label.refund": { ja: "返金額", en: "Refund", "zh-cn": "退款金额", ko: "환불 금액" },

  "email.confirmation.subject": {
    ja: "【Okinawa Dream】ご予約の確認 {ref}",
    en: "Okinawa Dream: booking confirmed {ref}",
    "zh-cn": "Okinawa Dream：预订确认 {ref}",
    ko: "Okinawa Dream: 예약 확인 {ref}",
  },
  "email.confirmation.intro": {
    ja: "ご予約を承りました。内容は次のとおりです。",
    en: "Your booking is confirmed. Here are the details.",
    "zh-cn": "您的预订已确认，详情如下。",
    ko: "예약이 확정되었습니다. 내용은 다음과 같습니다.",
  },
  "email.confirmation.cancelLink": {
    ja: "キャンセルはこちらから:",
    en: "To cancel this booking:",
    "zh-cn": "如需取消预订：",
    ko: "예약을 취소하려면:",
  },

  "email.cancellation.subject": {
    ja: "【Okinawa Dream】ご予約のキャンセル {ref}",
    en: "Okinawa Dream: booking cancelled {ref}",
    "zh-cn": "Okinawa Dream：预订已取消 {ref}",
    ko: "Okinawa Dream: 예약 취소 {ref}",
  },
  "email.cancellation.intro": {
    ja: "ご予約をキャンセルしました。内容は次のとおりです。",
    en: "Your booking has been cancelled. Here are the details.",
    "zh-cn": "您的预订已取消，详情如下。",
    ko: "예약이 취소되었습니다. 내용은 다음과 같습니다.",
  },
  "email.refund.none": {
    ja: "今回のキャンセルに返金はありません。",
    en: "No refund applies to this cancellation.",
    "zh-cn": "本次取消没有退款。",
    ko: "이번 취소에는 환불이 없습니다.",
  },
  "email.refund.pending": {
    ja: "返金の手続きを進めています。",
    en: "Your refund is being processed.",
    "zh-cn": "退款正在处理中。",
    ko: "환불을 처리하고 있습니다.",
  },
  "email.refund.completed": {
    ja: "返金が完了しました。",
    en: "Your refund is complete.",
    "zh-cn": "退款已完成。",
    ko: "환불이 완료되었습니다.",
  },
  "email.refund.failed": {
    ja: "返金を完了できませんでした。店舗からご連絡いたします。",
    en: "We could not complete your refund. We will contact you.",
    "zh-cn": "退款未能完成，我们会与您联系。",
    ko: "환불을 완료하지 못했습니다. 저희가 연락드리겠습니다.",
  },

  "email.staff.label.plate": japanese("車両ナンバー"),
  "email.staff.label.guest": japanese("お客様"),
  "email.staff.label.email": japanese("メール"),
  "email.staff.label.phone": japanese("電話"),
  "email.staff.label.refundStatus": japanese("返金状況"),
  "email.staff.label.issueType": japanese("種別"),
  "email.staff.label.paymentId": japanese("決済ID"),
  "email.staff.label.refundId": japanese("返金ID"),
  "email.staff.label.expected": japanese("想定額"),
  "email.staff.label.actual": japanese("実額"),
  "email.staff.label.detail": japanese("詳細"),

  "email.staff.new.subject": japanese("【新規予約】{ref}"),
  "email.staff.new.intro": japanese("新しい予約が入りました。"),
  "email.staff.cancel.subject": japanese("【予約キャンセル】{ref}"),
  "email.staff.cancel.intro": japanese("予約がキャンセルされました。"),
  "email.staff.refund.none": japanese("返金はありません"),
  "email.staff.refund.pending": japanese("返金処理中です"),
  "email.staff.refund.completed": japanese("返金が完了しました"),
  "email.staff.refund.failed": japanese("返金できませんでした。Square を確認してください"),
  "email.staff.alert.subject": japanese("【要確認】{title}"),
  "email.staff.alert.intro": japanese("確認が必要な問題があります。"),
  "email.staff.alert.refund.title": japanese("キャンセルの返金が拒否されました"),
  "email.staff.alert.refund.action": japanese("予約はキャンセル済みです。Square を確認し、お客様にご連絡ください。"),
  "email.staff.alert.outbox.title": japanese("メールまたはシート更新を送れませんでした"),
  "email.staff.alert.outbox.action": japanese("これらは自動では再送されません。内容を確認し、必要ならお客様やシートに直接対応してください。"),
  "email.staff.reconcile.subject": japanese("【照合レポート】{runAt} {count}件"),
  "email.staff.reconcile.subjectPartial": japanese("【照合レポート・一部未実行】{runAt} {count}件"),
  "email.staff.reconcile.intro": japanese("{runAt} の照合で {count} 件の問題が見つかりました。"),
  "email.staff.reconcile.failed.square": japanese("Square との照合を実行できませんでした。その結果はこのレポートに含まれていません。"),
  "email.staff.reconcile.failed.sheet": japanese("Bookings シートとの照合を実行できませんでした。その結果はこのレポートに含まれていません。"),
};
