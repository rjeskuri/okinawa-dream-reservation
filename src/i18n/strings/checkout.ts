// The strings of the checkout page. Agent drafts, awaiting native-speaker review (see epic #3). `{name}` marks a value the
// page fills in. Two dictionaries, so the browser's bundle carries only what src/scripts/checkout.ts says.
import type { Dictionary } from "../t.ts";

export const checkout: Dictionary = {
  "checkout.heading.ON_HOLD": { ja: "予約金のお支払い", en: "Pay your deposit", "zh-cn": "支付订金", ko: "예약금 결제" },
  "checkout.heading.PAYMENT_PENDING": {
    ja: "お支払いを確認しています",
    en: "Checking your payment",
    "zh-cn": "正在确认您的付款",
    ko: "결제를 확인하고 있습니다",
  },
  "checkout.heading.CONFIRMED": {
    ja: "ご予約が確定しました",
    en: "Your booking is confirmed",
    "zh-cn": "您的预订已确认",
    ko: "예약이 확정되었습니다",
  },
  "checkout.heading.EXPIRED": {
    ja: "お支払いの期限が過ぎました",
    en: "This hold has expired",
    "zh-cn": "保留时间已结束",
    ko: "보류 시간이 끝났습니다",
  },
  "checkout.heading.CANCELLED": {
    ja: "このご予約はキャンセルされました",
    en: "This booking was cancelled",
    "zh-cn": "此预订已取消",
    ko: "이 예약은 취소되었습니다",
  },

  "checkout.label.model": { ja: "車種", en: "Model", "zh-cn": "车型", ko: "차종" },
  "checkout.label.package": { ja: "プラン", en: "Package", "zh-cn": "套餐", ko: "패키지" },
  "checkout.label.pickup": { ja: "受取", en: "Pickup", "zh-cn": "取车", ko: "픽업" },
  "checkout.label.return": { ja: "返却", en: "Return", "zh-cn": "还车", ko: "반납" },
  "checkout.label.price": { ja: "レンタル料金", en: "Rental price", "zh-cn": "租赁费用", ko: "렌탈 요금" },
  "checkout.label.deposit": {
    ja: "今回お支払いいただく予約金",
    en: "Deposit to pay now",
    "zh-cn": "现在需支付的订金",
    ko: "지금 결제할 예약금",
  },
  "checkout.label.ref": { ja: "予約番号", en: "Booking reference", "zh-cn": "预订编号", ko: "예약 번호" },
  "checkout.label.paid": { ja: "お支払い済みの予約金", en: "Deposit paid", "zh-cn": "已付订金", ko: "결제한 예약금" },
  "checkout.label.name": { ja: "お名前", en: "Name", "zh-cn": "姓名", ko: "성함" },
  "checkout.label.timeLeft": { ja: "残り時間", en: "Time left", "zh-cn": "剩余时间", ko: "남은 시간" },

  "checkout.hold.intro": {
    ja: "この車両を確保しています。時間内に予約金をお支払いください。",
    en: "We are holding this vehicle for you. Pay the deposit before the time runs out.",
    "zh-cn": "我们正在为您保留此车辆。请在时间结束前支付订金。",
    ko: "이 차량을 보류해 두었습니다. 시간이 끝나기 전에 예약금을 결제해 주세요.",
  },
  "checkout.guest.heading": { ja: "お客様情報", en: "Your details", "zh-cn": "您的信息", ko: "고객 정보" },
  "checkout.guest.familyName": { ja: "姓", en: "Family name", "zh-cn": "姓", ko: "성" },
  "checkout.guest.givenName": { ja: "名", en: "Given name", "zh-cn": "名", ko: "이름" },
  "checkout.guest.email": { ja: "メールアドレス", en: "Email", "zh-cn": "电子邮箱", ko: "이메일" },
  "checkout.guest.phone": { ja: "電話番号", en: "Phone", "zh-cn": "电话号码", ko: "전화번호" },
  "checkout.guest.fullName": {
    ja: "{familyName} {givenName}",
    en: "{givenName} {familyName}",
    "zh-cn": "{familyName} {givenName}",
    ko: "{familyName} {givenName}",
  },

  "checkout.card.heading": { ja: "カード情報", en: "Card details", "zh-cn": "银行卡信息", ko: "카드 정보" },
  "checkout.card.accepted": {
    ja: "ご利用いただけるカード：Visa、Mastercard、American Express、Discover、Diners Club、JCB。",
    en: "We accept Visa, Mastercard, American Express, Discover, Diners Club and JCB.",
    "zh-cn": "可使用的银行卡：Visa、Mastercard、American Express、Discover、Diners Club、JCB。",
    ko: "사용 가능한 카드: Visa, Mastercard, American Express, Discover, Diners Club, JCB.",
  },
  "checkout.card.unionPay": {
    ja: "UnionPay（銀聯）はオンライン決済ではご利用いただけません。",
    en: "UnionPay is not accepted online.",
    "zh-cn": "在线支付不支持银联（UnionPay）卡。",
    ko: "UnionPay(은련) 카드는 온라인 결제에 사용할 수 없습니다.",
  },
  "checkout.pay": { ja: "{amount}を支払う", en: "Pay {amount}", "zh-cn": "支付 {amount}", ko: "{amount} 결제하기" },

  "checkout.pending.body": {
    ja: "カード会社に確認しています。もう一度お支払いにならないでください。しばらくしてからこのページを更新してください。",
    en: "We are confirming your payment with the card company. Please do not pay again. Refresh this page in a moment.",
    "zh-cn": "我们正在向发卡机构确认您的付款。请勿重复付款，并稍后刷新此页面。",
    ko: "카드사에 결제를 확인하고 있습니다. 다시 결제하지 마시고 잠시 후 이 페이지를 새로고침해 주세요.",
  },
  "checkout.pending.refresh": {
    ja: "このページを更新",
    en: "Refresh this page",
    "zh-cn": "刷新此页面",
    ko: "이 페이지 새로고침",
  },

  "checkout.confirmed.next": { ja: "次のステップ", en: "What happens next", "zh-cn": "接下来", ko: "다음 단계" },
  "checkout.confirmed.email": {
    ja: "確認メールをお送りします。キャンセルが必要な場合は、メール内のリンクをご利用ください。",
    en: "We are emailing your confirmation. It has a link to use if you need to cancel.",
    "zh-cn": "我们将通过电子邮件发送预订确认，如需取消，请使用邮件中的链接。",
    ko: "예약 확인 메일을 보내 드립니다. 취소가 필요하면 메일의 링크를 이용해 주세요.",
  },
  "checkout.confirmed.pickup": {
    ja: "受取時間に運転免許証をお持ちのうえ、店舗へお越しください。",
    en: "Come to the shop at your pickup time and bring your driving licence.",
    "zh-cn": "请在取车时间携带驾驶证前往门店。",
    ko: "픽업 시간에 운전면허증을 지참하고 매장으로 와 주세요.",
  },
  "checkout.confirmed.access": {
    ja: "店舗へのアクセス",
    en: "How to find the shop",
    "zh-cn": "如何前往门店",
    ko: "매장 오시는 길",
  },
  "checkout.confirmed.policies": {
    ja: "キャンセルポリシー",
    en: "Cancellation policy",
    "zh-cn": "取消政策",
    ko: "취소 정책",
  },

  "checkout.expired.body": {
    ja: "時間内にお支払いが完了しなかったため、車両の確保は終了しました。",
    en: "The time to pay ran out, so this vehicle is no longer held for you.",
    "zh-cn": "付款时间已结束，此车辆不再为您保留。",
    ko: "결제 시간이 끝나 이 차량은 더 이상 보류되지 않습니다.",
  },
  "checkout.expired.model": {
    ja: "この車両のページに戻る",
    en: "Back to this vehicle",
    "zh-cn": "返回此车辆",
    ko: "이 차량으로 돌아가기",
  },
  "checkout.cancelled.body": {
    ja: "返金がある場合は、キャンセルのメールに詳細を記載しています。",
    en: "If a refund applies, the cancellation email has the details.",
    "zh-cn": "如有退款，详情请见取消确认邮件。",
    ko: "환불이 있는 경우 취소 안내 메일에서 자세한 내용을 확인할 수 있습니다.",
  },
  "checkout.search": { ja: "車両を探す", en: "Find a vehicle", "zh-cn": "查找车辆", ko: "차량 찾기" },
};

export const checkoutClient: Dictionary = {
  "checkout.error.FAMILY_NAME_EMPTY": {
    ja: "姓を入力してください。",
    en: "Enter your family name.",
    "zh-cn": "请输入姓。",
    ko: "성을 입력해 주세요.",
  },
  "checkout.error.GIVEN_NAME_EMPTY": {
    ja: "名を入力してください。",
    en: "Enter your given name.",
    "zh-cn": "请输入名。",
    ko: "이름을 입력해 주세요.",
  },
  "checkout.error.EMAIL_MALFORMED": {
    ja: "メールアドレスを確認してください。",
    en: "Check your email address.",
    "zh-cn": "请检查电子邮箱地址。",
    ko: "이메일 주소를 확인해 주세요.",
  },
  "checkout.error.PHONE_NO_DIGITS": {
    ja: "電話番号を数字で入力してください。",
    en: "Enter a phone number with digits.",
    "zh-cn": "请输入包含数字的电话号码。",
    ko: "숫자가 포함된 전화번호를 입력해 주세요.",
  },
  "checkout.error.guest": {
    ja: "入力内容を確認して、もう一度お試しください。",
    en: "Check your details and try again.",
    "zh-cn": "请检查您填写的信息后重试。",
    ko: "입력 내용을 확인하고 다시 시도해 주세요.",
  },
  "checkout.error.declined": {
    ja: "カードがご利用いただけませんでした。もう一度お試しいただくか、別のカードをご利用ください。",
    en: "Your card was declined. Try again, or use another card.",
    "zh-cn": "您的银行卡被拒绝。请重试或使用其他银行卡。",
    ko: "카드가 승인되지 않았습니다. 다시 시도하거나 다른 카드를 사용해 주세요.",
  },
  "checkout.error.card": {
    ja: "カードを処理できませんでした。カード情報を確認して、もう一度お試しください。",
    en: "We could not process your card. Check its details and try again.",
    "zh-cn": "无法处理您的银行卡。请检查卡片信息后重试。",
    ko: "카드를 처리하지 못했습니다. 카드 정보를 확인하고 다시 시도해 주세요.",
  },
  "checkout.error.wallet": {
    ja: "お支払いを完了できませんでした。もう一度お試しいただくか、カードでお支払いください。",
    en: "The payment did not go through. Try again, or pay by card.",
    "zh-cn": "付款未能完成。请重试，或使用银行卡支付。",
    ko: "결제를 완료하지 못했습니다. 다시 시도하거나 카드로 결제해 주세요.",
  },
  "checkout.wallet.total": {
    ja: "Okinawa Dream 予約金",
    en: "Okinawa Dream deposit",
    "zh-cn": "Okinawa Dream 订金",
    ko: "Okinawa Dream 예약금",
  },
  "checkout.error.form": {
    ja: "カード入力欄を読み込めませんでした。ページを更新してください。",
    en: "The card form could not load. Refresh the page to try again.",
    "zh-cn": "银行卡表单无法加载。请刷新页面重试。",
    ko: "카드 입력란을 불러오지 못했습니다. 페이지를 새로고침해 주세요.",
  },
  "checkout.error.expired": {
    ja: "お支払いの時間が終了しました。ページを更新してご確認ください。",
    en: "The time to pay has run out. Refresh the page to see your options.",
    "zh-cn": "付款时间已结束。请刷新页面查看后续选项。",
    ko: "결제 시간이 끝났습니다. 페이지를 새로고침해 확인해 주세요.",
  },
  "checkout.error.inProgress": {
    ja: "このご予約のお支払いはすでに処理中です。もう一度お支払いにならないでください。しばらくしてからページを更新してください。",
    en: "A payment for this booking is already being processed. Please do not pay again. Refresh the page in a moment.",
    "zh-cn": "此预订的付款正在处理中。请勿重复付款，并稍后刷新页面。",
    ko: "이 예약의 결제가 이미 처리 중입니다. 다시 결제하지 마시고 잠시 후 페이지를 새로고침해 주세요.",
  },
  "checkout.error.unknown": {
    ja: "お支払いの結果を確認できませんでした。もう一度お支払いにならないでください。数分後にページを更新して結果をご確認ください。",
    en: "We could not tell whether your payment went through. Please do not pay again. Refresh the page in a few minutes to see the result.",
    "zh-cn": "我们无法确认您的付款是否成功。请勿重复付款，并在几分钟后刷新页面查看结果。",
    ko: "결제 결과를 확인하지 못했습니다. 다시 결제하지 마시고 몇 분 후 페이지를 새로고침해 결과를 확인해 주세요.",
  },
};
