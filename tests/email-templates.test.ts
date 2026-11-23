// renderEmail: subject, text and HTML for every outbox template.
//
// The `data` of an EmailPayload is deliberately loose, so the fixtures below are the contract the enqueuers write to:
//   guest_confirmation: ref, modelName, packageName, startAt, endAt, priceJpy, paidJpy, shopOpen, shopClose,
//     guest { familyName, givenName }, cancelUrl, policySummary
//   guest_cancellation: the same without cancelUrl and policySummary, plus refundJpy and refundStatus
//   Both guest templates may also carry paidAtShop: true (#150): the deposit is paid at the shop, nothing online.
//     guest_confirmation then also has depositJpy, the amount due at the shop (paidJpy is 0).
//   staff_new_booking: ref, modelNameJa, packageNameJa, startAt, endAt, priceJpy, paidJpy, vehiclePlate,
//     guest { familyName, givenName, email, phone }
//   staff_cancellation: the same, plus refundJpy and refundStatus
//   staff_alert: title, detail, optional ref
//   reconcile_report: runAt, issues (ReconcileIssue[] of task #43), and optional failedChecks: the checks that did not
//     run, each "square" or "sheet" (the Bookings tab); absent or [] when both ran (#128)
// startAt, endAt and runAt are epoch ms, money is integer JPY. Fixtures also pass the name fields a template does not
// show, as an enqueuer holding the whole booking would, so showing the wrong language's name is a visible bug.
//
// Expected values are literals or derived here, never through src/lib/time.ts or the code under test. Content checks
// read the text and the HTML with its tags removed, so the markup stays free; the escaping tests read the raw HTML.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { email } from "../src/i18n/strings/email.ts";
import { t } from "../src/i18n/t.ts";
import { LOCALES, type Locale } from "../src/lib/locale.ts";
import { renderEmail } from "../src/lib/mail/templates.ts";
import type { EmailPayload } from "../src/lib/outbox.ts";

type Template = EmailPayload["template"];
type Rendered = { subject: string; text: string; html: string };
type Needle = string | RegExp;
type Data = Record<string, unknown>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", yen: "¥" };

/** One pass, so `&amp;lt;` becomes `&lt;` and no further. An entity this does not know is left as it stands. */
function decodeEntities(html: string): string {
  return html.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? entity;
  });
}

/** What a reader of the HTML sees. */
function visible(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "));
}

/** Every link target in the HTML, decoded. A raw quote inside a value ends the match early, so the value differs. */
function hrefs(html: string): string[] {
  const links = html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi);
  return [...links].map((link) => decodeEntities(link[1] ?? link[2]));
}

/** `value` as it must stand in HTML: each of & < > " ' as an entity, and nothing encoded twice. */
function escapedPattern(value: string): RegExp {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&(?:quot|#34|#[xX]22);",
    "'": "&(?:#39|#039|#[xX]27|apos);",
  };
  const source = [...value].map((char) => entities[char] ?? char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")).join("");
  return new RegExp(source);
}

function commas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+$)/g, ",");
}

/**
 * `n` written as yen with thousands separators. The mark is the writer's choice, per language: U+00A5, U+FFE5 (what
 * Intl gives ja), JPY, or a suffix such as 円, 日元 or 엔. The bounds keep 12,000 from matching inside 112,000.
 */
function yen(n: number, flags = "i"): RegExp {
  const digits = commas(n);
  const prefixed = `(?:[\\u00a5\\uffe5]|JPY)\\s?${digits}(?![\\d,])`;
  const suffixed = `(?<![\\d,.])${digits}\\s?(?:円|日元|日圆|엔|JPY|yen)`;
  return new RegExp(`${prefixed}|${suffixed}`, flags);
}

function contains(body: string, needle: Needle): boolean {
  return typeof needle === "string" ? body.includes(needle) : needle.test(body);
}

function assertShows(rendered: Rendered, needles: Needle[], context: string): void {
  for (const [part, body] of [["text", rendered.text], ["html", visible(rendered.html)]]) {
    for (const needle of needles) {
      assert.ok(contains(body, needle), `${context}: the ${part} does not show ${needle}\n${body}`);
    }
  }
}

function assertHides(rendered: Rendered, needles: Needle[], context: string): void {
  for (const [part, body] of [["text", rendered.text], ["html", visible(rendered.html)]]) {
    for (const needle of needles) {
      assert.ok(!contains(body, needle), `${context}: the ${part} shows ${needle}\n${body}`);
    }
  }
}

const KANA = /[぀-ヿ]/;
const HAN = /[一-鿿]/;
const HANGUL = /[가-힯]/;

/** For data with no CJK in it, so the Japanese can only come from the template. A short subject may be all kanji. */
function assertJapanese(rendered: Rendered, context: string): void {
  assert.ok(KANA.test(rendered.subject) || HAN.test(rendered.subject), `${context}: subject ${rendered.subject}`);
  assert.ok(!HANGUL.test(rendered.subject), `${context}: subject ${rendered.subject}`);
  for (const [part, body] of [["text", rendered.text], ["html", visible(rendered.html)]]) {
    assert.ok(KANA.test(body), `${context}: the ${part} has no kana\n${body}`);
    assert.ok(!HANGUL.test(body), `${context}: the ${part} has Hangul\n${body}`);
  }
}

function render(template: Template, locale: Locale, data: Data): Rendered {
  return renderEmail({ template, to: "someone@example.test", locale, data });
}

type BookingFixture = {
  ref: string;
  modelNames: Record<Locale, string>;
  packageNames: Record<Locale, string>;
  startAt: number;
  endAt: number;
  pickupJst: string;
  returnJst: string;
  /** The pickup's UTC date, which a missing offset would print. */
  pickupUtcDate: string;
  priceJpy: number;
  paidJpy: number;
  refundJpy: number;
  shopOpen: string;
  shopClose: string;
  vehiclePlate: string;
  guest: { familyName: string; givenName: string; email: string; phone: string };
  bookingId: string;
  token: string;
  policy: string;
};

const BOOKINGS: BookingFixture[] = [
  {
    ref: "OD-A7K2Q",
    modelNames: { ja: "ホンダ ディオ110", en: "Honda Dio 110", "zh-cn": "本田 Dio 110", ko: "혼다 디오 110" },
    packageNames: { ja: "3日間", en: "3 days", "zh-cn": "3天", ko: "3일" },
    startAt: Date.UTC(2026, 11, 31, 23, 30),
    endAt: Date.UTC(2027, 0, 2, 15, 30),
    pickupJst: "2027-01-01 08:30 JST",
    returnJst: "2027-01-03 00:30 JST",
    pickupUtcDate: "2026-12-31",
    priceJpy: 12_000,
    paidJpy: 5_500,
    refundJpy: 2_750,
    shopOpen: "09:00",
    shopClose: "18:00",
    vehiclePlate: "OKINAWA-NA-12-34",
    guest: {
      familyName: "Yamada",
      givenName: "Taro",
      email: "taro.yamada@example.test",
      phone: "+81 90-1234-5678",
    },
    bookingId: "bk-alpha",
    token: "tokAlphaZZ",
    policy: "Free cancellation up to 7 days before pickup.",
  },
  {
    ref: "OD-M3X9T",
    modelNames: { ja: "ヤマハ セロー250", en: "Yamaha Serow 250", "zh-cn": "雅马哈 Serow 250", ko: "야마하 세로 250" },
    packageNames: { ja: "7日間", en: "7 days", "zh-cn": "7天", ko: "7일" },
    startAt: Date.UTC(2027, 1, 28, 15, 5),
    endAt: Date.UTC(2027, 2, 6, 14, 59),
    pickupJst: "2027-03-01 00:05 JST",
    returnJst: "2027-03-06 23:59 JST",
    pickupUtcDate: "2027-02-28",
    priceJpy: 86_400,
    paidJpy: 30_000,
    refundJpy: 15_000,
    shopOpen: "08:30",
    shopClose: "19:30",
    vehiclePlate: "OKINAWA-RA-98-76",
    guest: {
      familyName: "Kim",
      givenName: "Minji",
      email: "minji.kim@example.test",
      phone: "+82 10-9876-5432",
    },
    bookingId: "bk-bravo",
    token: "tokBravoYY",
    policy: "Half back from 3 days before pickup.",
  },
];

function cancelUrl(booking: BookingFixture, locale: Locale): string {
  return `https://okinawa.example/${locale}/booking/cancel?b=${booking.bookingId}&t=${booking.token}`;
}

function bookingData(booking: BookingFixture, locale: Locale): Data {
  const { ref, startAt, endAt, priceJpy, paidJpy, shopOpen, shopClose, guest } = booking;
  return {
    ref,
    modelName: booking.modelNames[locale],
    modelNameJa: booking.modelNames.ja,
    packageName: booking.packageNames[locale],
    packageNameJa: booking.packageNames.ja,
    startAt,
    endAt,
    priceJpy,
    paidJpy,
    shopOpen,
    shopClose,
    guest,
  };
}

function confirmationData(booking: BookingFixture, locale: Locale): Data {
  return {
    ...bookingData(booking, locale),
    cancelUrl: cancelUrl(booking, locale),
    policySummary: `${booking.policy} (${locale})`,
  };
}

function cancellationData(booking: BookingFixture, locale: Locale, refundJpy: number, refundStatus: string): Data {
  return { ...bookingData(booking, locale), refundJpy, refundStatus };
}

function staffNewData(booking: BookingFixture, locale: Locale): Data {
  return { ...bookingData(booking, locale), vehiclePlate: booking.vehiclePlate };
}

function staffCancelData(booking: BookingFixture, locale: Locale, refundJpy: number, refundStatus: string): Data {
  return { ...staffNewData(booking, locale), refundJpy, refundStatus };
}

/** What both guest templates must show, in the booking's own language. */
function guestFacts(booking: BookingFixture, locale: Locale): Needle[] {
  const { ref, pickupJst, returnJst, paidJpy, shopOpen, shopClose, guest } = booking;
  return [
    ref,
    booking.modelNames[locale],
    booking.packageNames[locale],
    pickupJst,
    returnJst,
    yen(paidJpy),
    shopOpen,
    shopClose,
    guest.familyName,
    guest.givenName,
  ];
}

function guestAbsences(booking: BookingFixture, locale: Locale): Needle[] {
  const otherLanguage = locale === "ja" ? [] : [booking.modelNames.ja, booking.packageNames.ja];
  return [booking.pickupUtcDate, ...otherLanguage];
}

/** What both staff templates must show. */
function staffFacts(booking: BookingFixture): Needle[] {
  const { ref, pickupJst, returnJst, vehiclePlate, guest } = booking;
  return [
    ref,
    booking.modelNames.ja,
    booking.packageNames.ja,
    pickupJst,
    returnJst,
    vehiclePlate,
    guest.familyName,
    guest.givenName,
    guest.email,
    guest.phone,
  ];
}

/** The statuses tasks #35 and #36 use, grouped by what they mean to a reader; a group may share its wording. */
const REFUND_STATUS_GROUPS = [["NONE"], ["PENDING", "RETRY"], ["COMPLETED"], ["REJECTED", "FAILED"]];
const REFUND_STATUSES = REFUND_STATUS_GROUPS.flat();

/** The amount that goes with a status: NONE is the 0% tier, where no refund exists. */
function refundOf(booking: BookingFixture, status: string): number {
  return status === "NONE" ? 0 : booking.refundJpy;
}

/** Two renderings of different groups must differ in more than the amount. */
function assertStatusesDiffer(view: (status: string) => string, context: string): void {
  for (const [index, group] of REFUND_STATUS_GROUPS.entries()) {
    for (const later of REFUND_STATUS_GROUPS.slice(index + 1)) {
      for (const one of group) {
        for (const other of later) {
          assert.notEqual(view(one), view(other), `${context}: ${one} and ${other} read the same`);
        }
      }
    }
  }
}

/** A message with ASCII values only, so anything in another script came from the template. */
const NEUTRAL_BOOKING: BookingFixture = {
  ...BOOKINGS[0],
  modelNames: { ja: "Dio 110", en: "Dio 110", "zh-cn": "Dio 110", ko: "Dio 110" },
  packageNames: { ja: "3D", en: "3D", "zh-cn": "3D", ko: "3D" },
  policy: "Policy text",
};

function issue(index: number): Record<string, unknown> {
  return {
    type: `type_${index}_mismatch`,
    bookingRef: `OD-REF-${index}-X`,
    paymentId: `pay_${index}_q`,
    refundId: `rf_${index}_q`,
    expectedJpy: (index + 1) * 1_001,
    actualJpy: (index + 1) * 2_003,
    detail: `Issue ${index}: Square and D1 disagree.`,
  };
}

test("guest confirmation renders in each locale with the cancel link", () => {
  for (const booking of BOOKINGS) {
    for (const locale of LOCALES) {
      const rendered = render("guest_confirmation", locale, confirmationData(booking, locale));
      const context = `${booking.ref} ${locale}`;
      const url = cancelUrl(booking, locale);

      assertShows(
        rendered,
        [...guestFacts(booking, locale), yen(booking.priceJpy), url, `${booking.policy} (${locale})`],
        context,
      );
      assertHides(rendered, guestAbsences(booking, locale), context);
      assert.ok(hrefs(rendered.html).includes(url), `${context}: no link to ${url} in ${rendered.html}`);
      assert.match(rendered.html, escapedPattern(url), `${context}: the link's & is raw`);
    }
  }
});

test("cancellation shows the refund amount and status", () => {
  for (const booking of BOOKINGS) {
    for (const locale of LOCALES) {
      for (const status of REFUND_STATUSES) {
        const refund = refundOf(booking, status);
        const rendered = render("guest_cancellation", locale, cancellationData(booking, locale, refund, status));
        const context = `guest ${booking.ref} ${locale} ${status}`;

        assertShows(rendered, [...guestFacts(booking, locale), yen(refund)], context);
        assertHides(rendered, [...guestAbsences(booking, locale), ...REFUND_STATUSES], context);
      }

      const guestView = (status: string): string => {
        const refund = refundOf(booking, status);
        const { text } = render("guest_cancellation", locale, cancellationData(booking, locale, refund, status));
        return text.replace(yen(refund, "gi"), "AMOUNT");
      };
      assertStatusesDiffer(guestView, `guest ${booking.ref} ${locale}`);
    }

    for (const status of REFUND_STATUSES) {
      const refund = refundOf(booking, status);
      const rendered = render("staff_cancellation", "ja", staffCancelData(booking, "en", refund, status));
      assertShows(rendered, [...staffFacts(booking), yen(refund)], `staff ${booking.ref} ${status}`);
    }
    const staffView = (status: string): string => {
      const refund = refundOf(booking, status);
      const { text } = render("staff_cancellation", "ja", staffCancelData(booking, "en", refund, status));
      return text.replace(yen(refund, "gi"), "AMOUNT");
    };
    assertStatusesDiffer(staffView, `staff ${booking.ref}`);
  }
});

test("staff notices are Japanese and include the plate", () => {
  const staffPayloads = (booking: BookingFixture, bookingLocale: Locale): [Template, Data, Needle[]][] => [
    ["staff_new_booking", staffNewData(booking, bookingLocale), [yen(booking.priceJpy), yen(booking.paidJpy)]],
    [
      "staff_cancellation",
      staffCancelData(booking, bookingLocale, booking.refundJpy, "PENDING"),
      [yen(booking.refundJpy)],
    ],
  ];

  for (const booking of BOOKINGS) {
    for (const bookingLocale of ["en", "zh-cn", "ko"] as const) {
      for (const [template, data, amounts] of staffPayloads(booking, bookingLocale)) {
        const context = `${template} ${booking.ref} booked in ${bookingLocale}`;
        const rendered = render(template, "ja", data);

        assertShows(rendered, [...staffFacts(booking), ...amounts], context);
        assertHides(
          rendered,
          [booking.modelNames[bookingLocale], booking.packageNames[bookingLocale], booking.pickupUtcDate],
          context,
        );
        // The payload's locale may be the guest's: staff read the same Japanese whatever it says.
        for (const locale of LOCALES) {
          assert.deepEqual(render(template, locale, data), rendered, `${context} as ${locale}`);
        }
      }
    }
  }

  for (const locale of LOCALES) {
    for (const [template, data] of staffPayloads(NEUTRAL_BOOKING, "en")) {
      assertJapanese(render(template, locale, data), `${template} as ${locale}`);
    }
  }
});

test("guest input is escaped", () => {
  const hostileValues = [
    `<script>alert('x')</script>`,
    `O'Brien & "Sons" <b>`,
    `&lt;already&gt; &amp; encoded`,
    `"><img src=x onerror=alert(1)>`,
    `' onmouseover='alert(1)`,
  ];
  const guestNames = ["familyName", "givenName"];
  const staffFields = ["ref", "modelNameJa", "packageNameJa", "vehiclePlate", ...guestNames, "email", "phone"];
  const shown: Partial<Record<Template, string[]>> = {
    guest_confirmation: ["ref", "modelName", "packageName", "policySummary", "shopOpen", "familyName", "givenName"],
    guest_cancellation: ["ref", "modelName", "packageName", "shopOpen", "familyName", "givenName"],
    staff_new_booking: staffFields,
    staff_cancellation: staffFields,
  };

  for (const hostile of hostileValues) {
    // Each field gets its own marked value, so a field left raw is told apart from one that was escaped.
    const value = (field: string): string => `${field}:${hostile}`;
    const url = `https://okinawa.example/en/booking/cancel?b=${hostile}&t='tok"`;
    const data: Data = {
      ...confirmationData(BOOKINGS[0], "en"),
      refundJpy: 1_000,
      refundStatus: "PENDING",
      ref: value("ref"),
      modelName: value("modelName"),
      modelNameJa: value("modelNameJa"),
      packageName: value("packageName"),
      packageNameJa: value("packageNameJa"),
      policySummary: value("policySummary"),
      vehiclePlate: value("vehiclePlate"),
      shopOpen: value("shopOpen"),
      cancelUrl: url,
      guest: {
        familyName: value("familyName"),
        givenName: value("givenName"),
        email: value("email"),
        phone: value("phone"),
      },
    };

    for (const [template, fields] of Object.entries(shown) as [Template, string[]][]) {
      for (const locale of template.startsWith("guest") ? LOCALES : (["ja"] as const)) {
        const { text, html } = render(template, locale, data);
        const context = `${template} ${locale} ${hostile}`;

        assert.doesNotMatch(html, /<script|<img/i, context);
        for (const field of fields) {
          assert.match(html, escapedPattern(value(field)), `${context}: ${field} is not escaped in the html`);
          assert.ok(!html.includes(value(field)), `${context}: ${field} is raw in the html`);
          assert.ok(text.includes(value(field)), `${context}: ${field} is not plain in the text`);
        }
      }
    }

    for (const locale of LOCALES) {
      const { text, html } = render("guest_confirmation", locale, data);
      assert.ok(hrefs(html).includes(url), `${locale} ${hostile}: the href does not decode to the url\n${html}`);
      assert.match(html, escapedPattern(url), `${locale} ${hostile}: the href is not escaped`);
      assert.ok(!html.includes(url), `${locale} ${hostile}: the href is raw`);
      assert.ok(text.includes(url), `${locale} ${hostile}: the url is not plain in the text`);
    }
  }
});

test("reconcile report lists every issue", () => {
  for (const count of [1, 2, 23, 120]) {
    const issues = Array.from({ length: count }, (_, index) => issue(index));
    const rendered = render("reconcile_report", "ja", { runAt: Date.UTC(2026, 10, 1, 18, 0), issues });

    assertShows(rendered, ["2026-11-02 03:00 JST"], `${count} issues`);
    assertHides(rendered, ["2026-11-01"], `${count} issues`);
    for (const [index, listed] of issues.entries()) {
      assertShows(
        rendered,
        [
          listed.type as string,
          listed.bookingRef as string,
          listed.paymentId as string,
          listed.refundId as string,
          listed.detail as string,
          yen(listed.expectedJpy as number),
          yen(listed.actualJpy as number),
        ],
        `issue ${index + 1} of ${count}`,
      );
    }
  }

  // A zero is an amount, as in booking_without_payment; a missing field is left out.
  const sparse = render("reconcile_report", "ja", {
    runAt: Date.UTC(2026, 10, 1, 18, 0),
    issues: [
      { type: "booking_without_payment", bookingRef: "OD-ZERO", expectedJpy: 5_000, actualJpy: 0, detail: "Unpaid." },
      { type: "unknown_sheet_row", detail: "Row 12 is unknown." },
    ],
  });
  assertShows(
    sparse,
    ["booking_without_payment", "OD-ZERO", yen(5_000), yen(0), "Unpaid.", "unknown_sheet_row", "Row 12 is unknown."],
    "sparse issues",
  );
  assertHides(sparse, [/\bundefined\b/, /\bnull\b/, /\bNaN\b/], "sparse issues");

  // Staff read it in Japanese whatever the payload says.
  const data = { runAt: Date.UTC(2026, 10, 1, 18, 0), issues: [issue(0), issue(1)] };
  for (const locale of LOCALES) {
    const rendered = render("reconcile_report", locale, data);
    assertJapanese(rendered, `reconcile_report as ${locale}`);
    assert.deepEqual(rendered, render("reconcile_report", "ja", data), `reconcile_report as ${locale}`);
  }

  // Refund and payment details can quote guest input, so all of an issue's text is untrusted.
  for (const hostile of [`<script>alert('x')</script>`, `Tom & "Jerry" <i>O'Neil</i>`, `&lt;kept&gt;`]) {
    const value = (field: string): string => `${field}:${hostile}`;
    const fields = ["type", "bookingRef", "paymentId", "refundId", "detail"];
    const hostileIssue = Object.fromEntries(fields.map((field) => [field, value(field)]));
    const { text, html } = render("reconcile_report", "ja", {
      runAt: Date.UTC(2026, 10, 1, 18, 0),
      issues: [issue(0), { ...hostileIssue, expectedJpy: 1_000, actualJpy: 2_000 }],
    });

    assert.doesNotMatch(html, /<script/i, hostile);
    for (const field of fields) {
      assert.match(html, escapedPattern(value(field)), `${field} is not escaped in the html: ${hostile}`);
      assert.ok(!html.includes(value(field)), `${field} is raw in the html: ${hostile}`);
      assert.ok(text.includes(value(field)), `${field} is not plain in the text: ${hostile}`);
    }
  }
});

/** An issue whose text names neither check, so a name in the report can only come from the template. */
function neutralIssue(index: number) {
  return {
    type: `type_${index}_gap`,
    bookingRef: `OD-NTR-${index}-Z`,
    paymentId: `pid_${index}_n`,
    expectedJpy: (index + 3) * 1_009,
    actualJpy: (index + 2) * 997,
    detail: `Issue ${index}: the two ledgers disagree.`,
  };
}

/** The Square check is named when the report says Square; the Bookings sheet check when it says Bookings, シート or タブ. */
const SQUARE_NAMED = /Square|スクエア/;
const SHEET_NAMED = /Bookings|シート|タブ/;

test("the reconcile report states a failed check", () => {
  const runAt = Date.UTC(2026, 10, 1, 18, 0);
  const cases: [failedChecks: string[], named: RegExp[]][] = [
    [["square"], [SQUARE_NAMED]],
    [["sheet"], [SHEET_NAMED]],
    [["square", "sheet"], [SQUARE_NAMED, SHEET_NAMED]],
  ];

  for (const count of [0, 1, 3]) {
    const issues = Array.from({ length: count }, (_, index) => neutralIssue(index));
    const facts = issues.flatMap((listed) => [
      listed.type,
      listed.bookingRef,
      listed.paymentId,
      listed.detail,
      yen(listed.expectedJpy),
      yen(listed.actualJpy),
    ]);
    const plain = render("reconcile_report", "ja", { runAt, issues });
    assertHides(plain, [SQUARE_NAMED, SHEET_NAMED], `${count} issues, both checks ran`);
    assert.deepEqual(
      render("reconcile_report", "ja", { runAt, issues, failedChecks: [] }),
      plain,
      `${count} issues: no failed check is the plain report`,
    );
    const plainLines = new Set(plain.text.split("\n"));

    const statements = new Map<string, string>();
    for (const [failedChecks, named] of cases) {
      const data = { runAt, issues, failedChecks };
      const context = `${count} issues, ${failedChecks.join(" and ")} failed`;
      const rendered = render("reconcile_report", "ja", data);

      // The failed check is named, in text and HTML, and every issue the other check found is still listed.
      assertShows(rendered, ["2026-11-02 03:00 JST", ...named, ...facts], context);
      assertHides(rendered, [/\bundefined\b/, /\bnull\b/, /\bNaN\b/, /\[object /], context);
      assertJapanese(rendered, context);

      // What the failure adds to the report is said in Japanese.
      const statement = rendered.text
        .split("\n")
        .filter((line) => !plainLines.has(line))
        .join("\n");
      assert.ok(KANA.test(statement), `${context}: the failure is stated in Japanese, got:\n${statement}`);
      statements.set(failedChecks.join("+"), statement);

      // Staff read it in Japanese whatever the payload's locale.
      for (const locale of LOCALES) {
        assert.deepEqual(render("reconcile_report", locale, data), rendered, `${context} as ${locale}`);
      }
    }
    assert.notEqual(statements.get("square"), statements.get("sheet"), `${count} issues: the report says which check failed`);
  }
});

test("each locale has its own text", () => {
  const scripts: Record<Locale, { required: RegExp; forbidden: RegExp[] }> = {
    ja: { required: KANA, forbidden: [HANGUL] },
    en: { required: /[a-z]{3}/i, forbidden: [KANA, HAN, HANGUL] },
    "zh-cn": { required: HAN, forbidden: [KANA, HANGUL] },
    ko: { required: HANGUL, forbidden: [KANA, HAN] },
  };
  // The same data under every locale: only the template's own words can make the renderings differ.
  const payloads: [Template, Data][] = [
    ["guest_confirmation", confirmationData(NEUTRAL_BOOKING, "en")],
    ["guest_cancellation", cancellationData(NEUTRAL_BOOKING, "en", 2_750, "PENDING")],
  ];

  for (const [template, data] of payloads) {
    const renderings = LOCALES.map((locale) => render(template, locale, data));
    for (const part of ["subject", "text", "html"] as const) {
      assert.equal(new Set(renderings.map((rendered) => rendered[part])).size, LOCALES.length, `${template} ${part}`);
    }
    for (const [index, rendered] of renderings.entries()) {
      const locale = LOCALES[index];
      const { required, forbidden } = scripts[locale];
      const subjectRequired = locale === "ja" ? new RegExp(`${KANA.source}|${HAN.source}`) : required;
      const bodies = [rendered.text, visible(rendered.html)];
      assert.match(rendered.subject, subjectRequired, `${template} ${locale} subject`);
      for (const body of bodies) assert.match(body, required, `${template} ${locale}`);
      for (const body of [rendered.subject, ...bodies]) {
        for (const script of forbidden) assert.doesNotMatch(body, script, `${template} ${locale}`);
      }
    }
  }
});

test("amounts are yen with thousands separators", () => {
  const amounts = [0, 7, 999, 1_000, 12_000, 100_000, 1_000_000, 1_234_567];
  const booking = BOOKINGS[0];

  for (const amount of amounts) {
    const plainDigits = String(amount);
    const unseparated = amount >= 1_000 ? [new RegExp(`(?<![\\d,])${plainDigits}(?!\\d)`)] : [];

    for (const locale of LOCALES) {
      const context = `${amount} ${locale}`;
      const confirmation = render("guest_confirmation", locale, {
        ...confirmationData(booking, locale),
        priceJpy: amount,
        paidJpy: amount,
      });
      assertShows(confirmation, [yen(amount)], `confirmation ${context}`);
      assertHides(confirmation, unseparated, `confirmation ${context}`);

      const cancellation = render("guest_cancellation", locale, cancellationData(booking, locale, amount, "PENDING"));
      assertShows(cancellation, [yen(amount)], `cancellation ${context}`);
      assertHides(cancellation, unseparated, `cancellation ${context}`);
    }

    const staff = render("staff_new_booking", "ja", {
      ...staffNewData(booking, "en"),
      priceJpy: amount,
      paidJpy: amount,
    });
    assertShows(staff, [yen(amount)], `staff ${amount}`);
    assertHides(staff, unseparated, `staff ${amount}`);
  }
});

test("dates are JST whatever the host zone", () => {
  const instants: [number, string][] = [
    // The UTC calendar date differs: the year, a month end, a leap day and exact midnight.
    [Date.UTC(2026, 11, 31, 23, 30), "2027-01-01 08:30 JST"],
    [Date.UTC(2027, 0, 2, 15, 0), "2027-01-03 00:00 JST"],
    [Date.UTC(2028, 1, 28, 15, 5), "2028-02-29 00:05 JST"],
    [Date.UTC(2027, 3, 30, 20, 45), "2027-05-01 05:45 JST"],
    // The same calendar date, up to the last minute of it. Seconds are dropped, not rounded.
    [Date.UTC(2027, 5, 15, 14, 59), "2027-06-15 23:59 JST"],
    [Date.UTC(2027, 6, 1, 3, 59, 59), "2027-07-01 12:59 JST"],
  ];
  const hostZones: [string, number][] = [
    ["UTC", 0],
    ["America/Los_Angeles", 480],
    ["Asia/Tokyo", -540],
  ];
  const originalZone = process.env.TZ;
  const booking = BOOKINGS[0];

  try {
    for (const [zone, offsetMinutes] of hostZones) {
      process.env.TZ = zone;
      assert.equal(new Date(Date.UTC(2027, 0, 1)).getTimezoneOffset(), offsetMinutes, `the host zone did not change`);

      for (const [index, [startAt, pickup]] of instants.entries()) {
        const [endAt, dropoff] = instants[(index + 1) % instants.length];
        const times = { startAt, endAt };
        const context = `${pickup} on a ${zone} host`;
        const expected = [pickup, dropoff];

        assertShows(
          render("guest_confirmation", "ko", { ...confirmationData(booking, "ko"), ...times }),
          expected,
          context,
        );
        assertShows(
          render("guest_cancellation", "en", { ...cancellationData(booking, "en", 1_000, "PENDING"), ...times }),
          expected,
          context,
        );
        assertShows(render("staff_new_booking", "ja", { ...staffNewData(booking, "en"), ...times }), expected, context);
        assertShows(
          render("staff_cancellation", "ja", { ...staffCancelData(booking, "en", 1_000, "PENDING"), ...times }),
          expected,
          context,
        );
        assertShows(render("reconcile_report", "ja", { runAt: startAt, issues: [issue(0)] }), [pickup], context);
      }
    }
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});

test("staff alerts carry the problem in Japanese", () => {
  const alerts = [
    { title: "Refund rejected", detail: "Square refused the refund for bk-alpha.", ref: "OD-A7K2Q" },
    { title: "Refund failed", detail: "Square answered FAILED, 2,750 yen unpaid.", ref: "OD-M3X9T" },
  ];

  for (const alert of alerts) {
    for (const locale of LOCALES) {
      const rendered = render("staff_alert", locale, alert);
      const context = `${alert.title} as ${locale}`;

      assert.ok(rendered.subject.includes(alert.title), `${context}: subject ${rendered.subject}`);
      assertShows(rendered, [alert.title, alert.detail, alert.ref], context);
      assertJapanese(rendered, context);
      assert.deepEqual(rendered, render("staff_alert", "ja", alert), context);
    }
  }

  // An alert need not be about one booking.
  const unbooked = render("staff_alert", "ja", { title: "Quota", detail: "The mail quota ran out." });
  assertShows(unbooked, ["Quota", "The mail quota ran out."], "no ref");
  assertHides(unbooked, [/\bundefined\b/, /\bnull\b/], "no ref");

  for (const hostile of [`<script>alert('x')</script>`, `A&B "C" 'D'`, `&lt;kept&gt;`]) {
    const alert = { title: `title:${hostile}`, detail: `detail:${hostile}`, ref: `ref:${hostile}` };
    const { subject, text, html } = render("staff_alert", "ja", alert);

    assert.ok(subject.includes(alert.title), `subject ${subject}`);
    assert.doesNotMatch(html, /<script/i, hostile);
    for (const value of Object.values(alert)) {
      assert.match(html, escapedPattern(value), `not escaped: ${value}`);
      assert.ok(!html.includes(value), `raw in the html: ${value}`);
      assert.ok(text.includes(value), `not plain in the text: ${value}`);
    }
  }
});

test("subjects stay one plain line whatever the values", () => {
  const hostile = `A&B <C> "D" 'E'\r\nBcc: evil@example.test\nX-Hdr: y`;
  const booking = {
    ...confirmationData(BOOKINGS[0], "en"),
    ...staffNewData(BOOKINGS[0], "en"),
    refundJpy: 1_000,
    refundStatus: "PENDING",
    ref: hostile,
    modelName: hostile,
    modelNameJa: hostile,
    packageName: hostile,
    packageNameJa: hostile,
    guest: { familyName: hostile, givenName: hostile, email: hostile, phone: hostile },
  };
  const payloads: [Template, Data][] = [
    ["guest_confirmation", booking],
    ["guest_cancellation", booking],
    ["staff_new_booking", booking],
    ["staff_cancellation", booking],
    ["staff_alert", { title: hostile, detail: hostile, ref: hostile }],
    ["reconcile_report", { runAt: Date.UTC(2026, 10, 1, 18, 0), issues: [{ type: hostile, detail: hostile }] }],
  ];

  for (const [template, data] of payloads) {
    for (const locale of LOCALES) {
      const { subject } = render(template, locale, data);
      assert.doesNotMatch(subject, /[\r\n]/, `${template} ${locale}: ${JSON.stringify(subject)}`);
      assert.doesNotMatch(subject, /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i, `${template} ${locale}: ${subject}`);
    }
  }

  const { subject } = render("staff_alert", "ja", { title: `A&B <C> "D" 'E'`, detail: "Detail." });
  assert.ok(subject.includes(`A&B <C> "D" 'E'`), `the title is not plain in ${subject}`);
});

// --- Paid at the shop (#150) ---------------------------------------------------------------------------------------
// The new wording is read back through the locale's own string lookup, so these tests pin where it appears and what is
// gone, never the sentences. The coder adds these keys to src/i18n/strings/email.ts, each static text with no {marks}:
//   email.label.paidAtShop               the row label "Deposit to pay at the shop" (its value is depositJpy)
//   email.confirmation.introPaidAtShop   one sentence added after the usual intro: the deposit is paid at pickup
//   email.confirmation.policyPaidAtShop  the value of the policy row: nothing paid online, so cancelling refunds nothing
//   email.cancellation.paidAtShop        one line: nothing was paid online, so nothing is refunded
const PAID_AT_SHOP_KEYS = [
  "email.label.paidAtShop",
  "email.confirmation.introPaidAtShop",
  "email.confirmation.policyPaidAtShop",
  "email.cancellation.paidAtShop",
];

function say(locale: Locale, key: string): string {
  return t(locale, email, key);
}

/** The deposit due at the shop; the booking's paidJpy fixture is reused, so it differs from the price. */
function paidAtShopConfirmation(booking: BookingFixture, locale: Locale): Data {
  return { ...confirmationData(booking, locale), paidAtShop: true, paidJpy: 0, depositJpy: booking.paidJpy };
}

function paidAtShopCancellation(booking: BookingFixture, locale: Locale, refundJpy: number, status: string): Data {
  return { ...cancellationData(booking, locale, refundJpy, status), paidAtShop: true, paidJpy: 0 };
}

/** The row labels a reader sees: the text before ": " on each line, and the header cells of the HTML. */
function rowLabels(rendered: Rendered): { text: string[]; html: string[] } {
  const text = rendered.text
    .split("\n")
    .filter((line) => line.includes(": "))
    .map((line) => line.split(": ")[0]);
  const html = [...rendered.html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => decodeEntities(m[1]));
  return { text, html };
}

function assertNoRow(rendered: Rendered, label: string, context: string): void {
  const { text, html } = rowLabels(rendered);
  assert.ok(!text.includes(label), `${context}: the text has a "${label}" row\n${rendered.text}`);
  assert.ok(!html.includes(label), `${context}: the html has a "${label}" row\n${rendered.html}`);
}

/** The value of the row called `label`, from the plain text and from the HTML. */
function rowValues(rendered: Rendered, label: string): { text?: string; html?: string } {
  const line = rendered.text.split("\n").find((l) => l.startsWith(`${label}: `));
  const cells = rendered.html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi);
  const cell = [...cells].find((m) => decodeEntities(m[1]) === label);
  return { text: line?.slice(label.length + 2), html: cell ? decodeEntities(cell[2]) : undefined };
}

test("a paid-at-shop confirmation shows the deposit due at the shop and the cancel link, not a deposit paid", () => {
  for (const booking of BOOKINGS) {
    for (const locale of LOCALES) {
      const rendered = render("guest_confirmation", locale, paidAtShopConfirmation(booking, locale));
      const context = `${booking.ref} ${locale}`;
      const url = cancelUrl(booking, locale);
      const label = say(locale, "email.label.paidAtShop");
      const { ref, pickupJst, returnJst, shopOpen, shopClose, guest } = booking;

      assertShows(
        rendered,
        [
          ref,
          booking.modelNames[locale],
          booking.packageNames[locale],
          pickupJst,
          returnJst,
          yen(booking.priceJpy),
          shopOpen,
          shopClose,
          guest.familyName,
          guest.givenName,
          url,
          label,
          say(locale, "email.confirmation.introPaidAtShop"),
          say(locale, "email.confirmation.intro"),
        ],
        context,
      );
      // The deposit due sits in its own row, with the amount from depositJpy.
      const row = rowValues(rendered, label);
      assert.ok(row.text !== undefined && yen(booking.paidJpy).test(row.text), `${context}: text row ${row.text}`);
      assert.ok(row.html !== undefined && yen(booking.paidJpy).test(row.html), `${context}: html row ${row.html}`);
      // No Deposit paid row, and no zero amount standing for one.
      assertNoRow(rendered, say(locale, "email.label.paid"), context);
      assertHides(rendered, [yen(0)], context);
      // The link stays.
      assert.ok(hrefs(rendered.html).includes(url), `${context}: no link to ${url} in ${rendered.html}`);
      assertHides(rendered, guestAbsences(booking, locale), context);
    }
  }
});

test("a paid-at-shop confirmation says cancelling refunds nothing instead of the refund tiers", () => {
  for (const booking of BOOKINGS) {
    for (const locale of LOCALES) {
      const rendered = render("guest_confirmation", locale, paidAtShopConfirmation(booking, locale));
      const context = `${booking.ref} ${locale}`;
      const policyLabel = say(locale, "email.label.policy");
      const line = say(locale, "email.confirmation.policyPaidAtShop");

      // One policy row whose value is the one new line, and the payload's refund tiers nowhere.
      const row = rowValues(rendered, policyLabel);
      assert.equal(row.text, line, `${context}: text policy row`);
      assert.equal(row.html, line, `${context}: html policy row`);
      assertHides(rendered, [`${booking.policy} (${locale})`], context);
      assert.equal(rowLabels(rendered).text.filter((label) => label === policyLabel).length, 1, context);
    }
  }
});

test("a paid-at-shop cancellation shows no refund rows", () => {
  for (const booking of BOOKINGS) {
    for (const locale of LOCALES) {
      for (const status of REFUND_STATUSES) {
        // A payload that wrongly carries a refund must still not show one.
        const refunds = status === "NONE" ? [0] : [0, booking.refundJpy];
        for (const refundJpy of refunds) {
          const rendered = render("guest_cancellation", locale, paidAtShopCancellation(booking, locale, refundJpy, status));
          const context = `${booking.ref} ${locale} ${status} ${refundJpy}`;
          const { ref, pickupJst, returnJst, shopOpen, shopClose, guest } = booking;

          assertShows(
            rendered,
            [
              ref,
              booking.modelNames[locale],
              booking.packageNames[locale],
              pickupJst,
              returnJst,
              yen(booking.priceJpy),
              shopOpen,
              shopClose,
              guest.familyName,
              guest.givenName,
              say(locale, "email.cancellation.intro"),
              say(locale, "email.cancellation.paidAtShop"),
            ],
            context,
          );
          assertNoRow(rendered, say(locale, "email.label.paid"), context);
          assertNoRow(rendered, say(locale, "email.label.refund"), context);
          assertHides(
            rendered,
            [
              yen(0),
              ...(refundJpy > 0 ? [yen(refundJpy)] : []),
              ...["none", "pending", "completed", "failed"].map((word) => say(locale, `email.refund.${word}`)),
            ],
            context,
          );
        }
      }
    }
  }
});

test("emails without paidAtShop are unchanged, and paidAtShop alone changes them", () => {
  // The golden file is today's output, captured before #150, for booking OD-A7K2Q in every locale.
  const goldenFile = new URL("./fixtures/email/guest-without-paid-at-shop.json", import.meta.url);
  const golden = JSON.parse(readFileSync(goldenFile, "utf8")) as Record<string, Rendered>;
  const booking = BOOKINGS[0];
  for (const locale of LOCALES) {
    const confirmation = { ...confirmationData(booking, locale), depositJpy: 5_500 };
    const cases: [string, Template, Data][] = [
      [`guest_confirmation|${locale}`, "guest_confirmation", confirmation],
      [`guest_cancellation|${locale}|COMPLETED`, "guest_cancellation", cancellationData(booking, locale, 2_750, "COMPLETED")],
      [`guest_cancellation|${locale}|NONE`, "guest_cancellation", cancellationData(booking, locale, 0, "NONE")],
    ];
    for (const [key, template, data] of cases) {
      const expected = golden[key];
      assert.ok(expected, `no golden for ${key}`);
      assert.deepEqual(render(template, locale, data), expected, `${key}: without paidAtShop`);
      assert.deepEqual(render(template, locale, { ...data, paidAtShop: false }), expected, `${key}: paidAtShop false`);
      assert.notDeepEqual(render(template, locale, { ...data, paidAtShop: true }), expected, `${key}: paidAtShop true`);
    }
  }
});

test("the paid-at-shop strings exist in all four locales, each its own wording", () => {
  for (const key of PAID_AT_SHOP_KEYS) {
    const texts = LOCALES.map((locale) => say(locale, key));
    for (const [index, text] of texts.entries()) {
      assert.ok(text.trim().length > 0, `${key} ${LOCALES[index]} is empty`);
      assert.ok(!/[{}]/.test(text), `${key} ${LOCALES[index]} has a {mark}, but the template fills none: ${text}`);
    }
    assert.equal(new Set(texts).size, LOCALES.length, `${key}: two locales share one text`);
  }
  for (const locale of LOCALES) {
    assert.notEqual(say(locale, "email.label.paidAtShop"), say(locale, "email.label.paid"), locale);
    assert.notEqual(say(locale, "email.cancellation.paidAtShop"), say(locale, "email.refund.none"), locale);
    assert.notEqual(say(locale, "email.confirmation.introPaidAtShop"), say(locale, "email.confirmation.intro"), locale);
  }
});

test("every template gives a subject, plain text and HTML with nothing missing", () => {
  const payloads: [Template, Locale, Data][] = [];
  for (const booking of BOOKINGS) {
    for (const locale of LOCALES) {
      payloads.push(["guest_confirmation", locale, confirmationData(booking, locale)]);
      payloads.push(["guest_confirmation", locale, paidAtShopConfirmation(booking, locale)]);
      payloads.push(["guest_cancellation", locale, paidAtShopCancellation(booking, locale, 0, "NONE")]);
      for (const status of REFUND_STATUSES) {
        const refund = refundOf(booking, status);
        payloads.push(["guest_cancellation", locale, cancellationData(booking, locale, refund, status)]);
        payloads.push(["staff_cancellation", locale, staffCancelData(booking, locale, refund, status)]);
      }
      payloads.push(["staff_new_booking", locale, staffNewData(booking, locale)]);
    }
  }
  payloads.push(["staff_alert", "ja", { title: "Refund rejected", detail: "Square refused it.", ref: "OD-A7K2Q" }]);
  payloads.push(["reconcile_report", "ja", { runAt: Date.UTC(2026, 10, 1, 18, 0), issues: [issue(0), issue(1)] }]);

  for (const [template, locale, data] of payloads) {
    const { subject, text, html } = render(template, locale, data);
    const context = `${template} ${locale}`;

    assert.ok(subject.trim().length > 0, `${context}: empty subject`);
    assert.doesNotMatch(text, /<\/?[a-z][^>]*>/i, `${context}: markup in the text`);
    assert.match(html, /<[a-z][^>]*>/i, `${context}: no markup in the html`);
    for (const body of [subject, text, html]) {
      assert.doesNotMatch(body, /\bundefined\b|\bNaN\b|\bnull\b|\[object /, context);
    }
  }
});
