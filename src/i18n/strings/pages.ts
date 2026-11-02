// The strings of the home, policies and access pages. Agent drafts, awaiting native-speaker review (see epic #3). The
// legal, address and map text is placeholder until the shop supplies the real text, and shows under the draft mark.
import type { Dictionary } from "../t.ts";

export const pages: Dictionary = {
  "draft.mark": {
    ja: "下書き（確定前の内容です）",
    en: "Draft: not final",
    "zh-cn": "草案（尚未定稿）",
    ko: "초안(확정 전 내용)",
  },

  "home.search.heading": { ja: "車両を探す", en: "Find a vehicle", "zh-cn": "查找车辆", ko: "차량 찾기" },
  "home.search.type": { ja: "車種", en: "Vehicle type", "zh-cn": "车辆类型", ko: "차량 종류" },
  "home.search.time": { ja: "受取時間", en: "Pickup time", "zh-cn": "取车时间", ko: "픽업 시간" },
  "home.search.package": { ja: "プラン", en: "Rental package", "zh-cn": "租赁套餐", ko: "렌탈 패키지" },
  "home.search.submit": { ja: "検索", en: "Search", "zh-cn": "搜索", ko: "검색" },
  "home.unpublished": {
    ja: "車両と予約はまだご利用いただけません。しばらくしてからご確認ください。",
    en: "Vehicles and booking are not available yet. Please check back soon.",
    "zh-cn": "车辆和预订暂未开放，请稍后再来查看。",
    ko: "차량과 예약은 아직 이용할 수 없습니다. 잠시 후 다시 확인해 주세요.",
  },

  "policies.cancellation.heading": {
    ja: "キャンセルについて",
    en: "Cancellation",
    "zh-cn": "取消政策",
    ko: "취소 규정",
  },
  "policies.cancellation.intro": {
    ja: "返金額は、受取日の何日前にキャンセルしたかで決まります。上から順に見て、最初に当てはまる行が適用されます。",
    en: "The refund depends on how many days before pickup you cancel. The first line below that fits applies.",
    "zh-cn": "退款金额取决于您在取车日前多少天取消。请从上往下看，以第一条符合的规定为准。",
    ko: "환불 금액은 픽업일 며칠 전에 취소하느냐에 따라 달라집니다. 위에서부터 보아 처음으로 맞는 항목이 적용됩니다.",
  },
  "policies.tier.days": {
    ja: "受取日の{days}日以上前：オンラインで支払った予約金の{percent}%を返金します。",
    en: "{days} or more days before pickup: {percent}% of the deposit paid online is refunded.",
    "zh-cn": "取车日前{days}天或更早：退还在线支付订金的{percent}%。",
    ko: "픽업 {days}일 이상 전: 온라인으로 결제한 예약금의 {percent}%를 환불합니다.",
  },
  "policies.tier.pickupDay": {
    ja: "受取時刻より前：オンラインで支払った予約金の{percent}%を返金します。",
    en: "Before the pickup time: {percent}% of the deposit paid online is refunded.",
    "zh-cn": "取车时间之前：退还在线支付订金的{percent}%。",
    ko: "픽업 시간 전: 온라인으로 결제한 예약금의 {percent}%를 환불합니다.",
  },
  "policies.cancellation.noMatch": {
    ja: "上のどの行にも当てはまらない場合は、返金はありません。",
    en: "If no line above applies, there is no refund.",
    "zh-cn": "如果以上各条都不适用，则不予退款。",
    ko: "위의 어느 항목에도 해당하지 않으면 환불되지 않습니다.",
  },
  "policies.cancellation.note": {
    ja: "日数は日本時間（JST）の暦日で数えます。",
    en: "Days are counted as calendar days in Japan time (JST).",
    "zh-cn": "天数按日本时间（JST）的日历日计算。",
    ko: "일수는 일본 시간(JST) 기준 달력일로 계산합니다.",
  },
  "policies.cancellation.unpublished": {
    ja: "返金の条件はまだ公開されていません。",
    en: "The refund tiers have not been published yet.",
    "zh-cn": "退款条件尚未发布。",
    ko: "환불 조건은 아직 게시되지 않았습니다.",
  },
  "policies.terms.heading": { ja: "利用規約", en: "Terms of rental", "zh-cn": "租赁条款", ko: "이용 약관" },
  "policies.terms.body": {
    ja: "これは仮の文章であり、当店の利用規約ではありません。正式な利用規約に差し替えます。",
    en: "This is placeholder text, not the shop's terms. The final terms will replace it.",
    "zh-cn": "此处为占位文字，并非本店的条款。正式条款确定后将替换此内容。",
    ko: "이 내용은 임시 문구이며 매장의 약관이 아닙니다. 확정된 약관으로 교체될 예정입니다.",
  },
  "policies.privacy.heading": {
    ja: "プライバシーポリシー",
    en: "Privacy policy",
    "zh-cn": "隐私政策",
    ko: "개인정보 처리방침",
  },
  "policies.privacy.body": {
    ja: "これは仮の文章であり、当店のプライバシーポリシーではありません。個人情報保護法（APPI）に沿った正式な方針に差し替えます。",
    en: "This is placeholder text, not the shop's privacy policy. A final policy under Japan's Act on the Protection of Personal Information (APPI) will replace it.",
    "zh-cn": "此处为占位文字，并非本店的隐私政策。符合日本《个人信息保护法》（APPI）的正式政策确定后将替换此内容。",
    ko: "이 내용은 임시 문구이며 매장의 개인정보 처리방침이 아닙니다. 일본 개인정보보호법(APPI)에 따른 확정 방침으로 교체될 예정입니다.",
  },

  "access.oneShop": {
    ja: "受取も返却も同じ店舗で行います。",
    en: "Pickup and return both take place at our one shop.",
    "zh-cn": "取车和还车都在同一家门店办理。",
    ko: "픽업과 반납은 모두 같은 매장에서 진행합니다.",
  },
  "access.unpublished": {
    ja: "営業時間と休業日はまだ公開されていません。",
    en: "Shop hours and closed dates have not been published yet.",
    "zh-cn": "营业时间和停业日尚未发布。",
    ko: "영업시간과 휴업일은 아직 게시되지 않았습니다.",
  },
  "access.hours.heading": { ja: "営業時間", en: "Shop hours", "zh-cn": "营业时间", ko: "영업시간" },
  "access.hours.value": {
    ja: "{open}〜{close}",
    en: "{open} to {close}",
    "zh-cn": "{open}至{close}",
    ko: "{open}~{close}",
  },
  "access.closed.heading": {
    ja: "今後{days}日間の休業日",
    en: "Closed dates in the next {days} days",
    "zh-cn": "未来{days}天的停业日",
    ko: "향후 {days}일간의 휴업일",
  },
  "access.closed.none": {
    ja: "この期間の休業日はありません。",
    en: "No closed dates in this period.",
    "zh-cn": "此期间没有停业日。",
    ko: "이 기간에는 휴업일이 없습니다.",
  },
  "access.address.heading": { ja: "住所・地図", en: "Address and map", "zh-cn": "地址与地图", ko: "주소 및 지도" },
  "access.address.body": {
    ja: "店舗の住所をここに掲載します。",
    en: "The shop's address will be shown here.",
    "zh-cn": "此处将显示店铺地址。",
    ko: "이곳에 매장 주소가 표시될 예정입니다.",
  },
  "access.map.body": {
    ja: "地図をここに掲載します。",
    en: "A map will be shown here.",
    "zh-cn": "此处将显示地图。",
    ko: "이곳에 지도가 표시될 예정입니다.",
  },
};
