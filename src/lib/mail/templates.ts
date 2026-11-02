// The outbox emails. A template composes a Message of plain strings, and that one Message becomes the text and the HTML,
// so the two say the same. Guests read their own language; staff read Japanese whatever the payload's locale.
import { htmlLang } from "../../i18n/locales.ts";
import { email } from "../../i18n/strings/email.ts";
import { t } from "../../i18n/t.ts";
import type { EmailPayload } from "../outbox.ts";
import { epochToJst } from "../time.ts";

type Rendered = { subject: string; text: string; html: string };

type Row = [label: string, value: string];
type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "rows"; rows: Row[] }
  | { kind: "link"; label: string; href: string };
type Message = { subject: string; blocks: Block[] };

/** The text of a key in the message's language, its `{name}` marks filled in. */
type Say = (key: string, values?: Record<string, string>) => string;

type Booking = { ref: string; startAt: number; endAt: number; priceJpy: number; paidJpy: number };
type GuestBooking = Booking & {
  modelName: string;
  packageName: string;
  shopOpen: string;
  shopClose: string;
  guest: { familyName: string; givenName: string };
};
type GuestConfirmation = GuestBooking & { cancelUrl: string; policySummary: string };
type StaffBooking = Booking & {
  modelNameJa: string;
  packageNameJa: string;
  vehiclePlate: string;
  guest: { familyName: string; givenName: string; email: string; phone: string };
};

type RefundStatus = "NONE" | "PENDING" | "COMPLETED" | "RETRY" | "REJECTED" | "FAILED";
type Refund = { refundJpy: number; refundStatus: RefundStatus };

type StaffAlert = { title: string; detail: string; ref?: string };

// Task #43 defines this type for what it returns; the report only reads the fields.
type ReconcileIssue = {
  type: string;
  bookingRef?: string;
  paymentId?: string;
  refundId?: string;
  expectedJpy?: number;
  actualJpy?: number;
  detail: string;
};
type ReconcileReport = { runAt: number; issues: ReconcileIssue[] };

/** The wording a refund status reads as, under `email.refund.` and `email.staff.refund.`. */
const REFUND_WORDING: Record<RefundStatus, string> = {
  NONE: "none",
  PENDING: "pending",
  RETRY: "pending",
  COMPLETED: "completed",
  REJECTED: "failed",
  FAILED: "failed",
};

const BODY_STYLE = "font-family:sans-serif;font-size:14px;line-height:1.6;color:#222222;white-space:pre-line";
const BLOCK_STYLE = "margin:0 0 16px";
const TABLE_STYLE = "margin:0 0 16px;border-collapse:collapse";
const LABEL_STYLE = "padding:2px 16px 2px 0;text-align:left;vertical-align:top;font-weight:normal;color:#666666";
const VALUE_STYLE = "padding:2px 0;vertical-align:top";

const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

type HtmlNode = string | { tag: string; attributes: Record<string, string>; children: HtmlNode[] };

function element(tag: string, attributes: Record<string, string>, ...children: HtmlNode[]): HtmlNode {
  return { tag, attributes, children };
}

/** The one place HTML is written: every string here is text or an attribute value, and none is ever taken as markup. */
function serialize(node: HtmlNode): string {
  if (typeof node === "string") return escapeHtml(node);
  const attributes = Object.entries(node.attributes).map(([name, value]) => ` ${name}="${escapeHtml(value)}"`);
  return `<${node.tag}${attributes.join("")}>${node.children.map(serialize).join("")}</${node.tag}>`;
}

function blockHtml(block: Block): HtmlNode {
  switch (block.kind) {
    case "paragraph":
      return element("p", { style: BLOCK_STYLE }, block.text);
    case "rows": {
      const lines = block.rows.map(([label, value]) =>
        element("tr", {}, element("th", { style: LABEL_STYLE }, label), element("td", { style: VALUE_STYLE }, value)),
      );
      return element("table", { style: TABLE_STYLE }, ...lines);
    }
    case "link":
      return element("p", { style: BLOCK_STYLE }, `${block.label}\n`, element("a", { href: block.href }, block.href));
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "paragraph":
      return block.text;
    case "rows":
      return block.rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    case "link":
      return `${block.label}\n${block.href}`;
  }
}

function paragraph(text: string): Block {
  return { kind: "paragraph", text };
}

function table(rows: Row[]): Block {
  return { kind: "rows", rows };
}

/** The rows that have a value, so a missing optional field leaves no line. A zero amount is a value. */
function present(rows: [label: string, value: string | undefined][]): Block {
  return table(rows.filter((row): row is Row => row[1] !== undefined));
}

/** One pass with a function, so a value holding `{name}` or `$&` stays as it is. */
function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, name: string) => values[name]);
}

function jst(ms: number): string {
  const { date, time } = epochToJst(ms);
  return `${date} ${time} JST`;
}

function money(say: Say, jpy: number): string {
  return say("email.amount", { amount: jpy.toLocaleString("en-US") });
}

function bookingRows(say: Say, booking: Booking, modelName: string, packageName: string): Row[] {
  return [
    [say("email.label.ref"), booking.ref],
    [say("email.label.model"), modelName],
    [say("email.label.package"), packageName],
    [say("email.label.pickup"), jst(booking.startAt)],
    [say("email.label.return"), jst(booking.endAt)],
    [say("email.label.price"), money(say, booking.priceJpy)],
    [say("email.label.paid"), money(say, booking.paidJpy)],
  ];
}

function guestRows(say: Say, booking: GuestBooking): Row[] {
  return [
    ...bookingRows(say, booking, booking.modelName, booking.packageName),
    [say("email.label.hours"), `${booking.shopOpen}-${booking.shopClose}`],
  ];
}

function staffRows(say: Say, booking: StaffBooking): Row[] {
  const { guest } = booking;
  return [
    ...bookingRows(say, booking, booking.modelNameJa, booking.packageNameJa),
    [say("email.staff.label.plate"), booking.vehiclePlate],
    [say("email.staff.label.guest"), `${guest.familyName} ${guest.givenName}`],
    [say("email.staff.label.email"), guest.email],
    [say("email.staff.label.phone"), guest.phone],
  ];
}

function guestConfirmation(say: Say, booking: GuestConfirmation): Message {
  return {
    subject: say("email.confirmation.subject", { ref: booking.ref }),
    blocks: [
      paragraph(say("email.greeting", booking.guest)),
      paragraph(say("email.confirmation.intro")),
      table([...guestRows(say, booking), [say("email.label.policy"), booking.policySummary]]),
      { kind: "link", label: say("email.confirmation.cancelLink"), href: booking.cancelUrl },
      paragraph(say("email.closing")),
    ],
  };
}

function guestCancellation(say: Say, booking: GuestBooking & Refund): Message {
  return {
    subject: say("email.cancellation.subject", { ref: booking.ref }),
    blocks: [
      paragraph(say("email.greeting", booking.guest)),
      paragraph(say("email.cancellation.intro")),
      table([...guestRows(say, booking), [say("email.label.refund"), money(say, booking.refundJpy)]]),
      paragraph(say(`email.refund.${REFUND_WORDING[booking.refundStatus]}`)),
      paragraph(say("email.closing")),
    ],
  };
}

function staffNewBooking(say: Say, booking: StaffBooking): Message {
  return {
    subject: say("email.staff.new.subject", { ref: booking.ref }),
    blocks: [paragraph(say("email.staff.new.intro")), table(staffRows(say, booking))],
  };
}

function staffCancellation(say: Say, booking: StaffBooking & Refund): Message {
  return {
    subject: say("email.staff.cancel.subject", { ref: booking.ref }),
    blocks: [
      paragraph(say("email.staff.cancel.intro")),
      table([
        ...staffRows(say, booking),
        [say("email.label.refund"), money(say, booking.refundJpy)],
        [say("email.staff.label.refundStatus"), say(`email.staff.refund.${REFUND_WORDING[booking.refundStatus]}`)],
      ]),
    ],
  };
}

function staffAlert(say: Say, { title, detail, ref }: StaffAlert): Message {
  return {
    subject: say("email.staff.alert.subject", { title }),
    blocks: [
      paragraph(say("email.staff.alert.intro")),
      paragraph(title),
      present([[say("email.label.ref"), ref]]),
      paragraph(detail),
    ],
  };
}

function issueBlock(say: Say, issue: ReconcileIssue): Block {
  const amount = (jpy: number | undefined) => (jpy === undefined ? undefined : money(say, jpy));
  return present([
    [say("email.staff.label.issueType"), issue.type],
    [say("email.label.ref"), issue.bookingRef],
    [say("email.staff.label.paymentId"), issue.paymentId],
    [say("email.staff.label.refundId"), issue.refundId],
    [say("email.staff.label.expected"), amount(issue.expectedJpy)],
    [say("email.staff.label.actual"), amount(issue.actualJpy)],
    [say("email.staff.label.detail"), issue.detail],
  ]);
}

function reconcileReport(say: Say, { runAt, issues }: ReconcileReport): Message {
  const values = { runAt: jst(runAt), count: String(issues.length) };
  return {
    subject: say("email.staff.reconcile.subject", values),
    blocks: [paragraph(say("email.staff.reconcile.intro", values)), ...issues.map((issue) => issueBlock(say, issue))],
  };
}

function compose(say: Say, { template, data }: EmailPayload): Message {
  switch (template) {
    case "guest_confirmation":
      return guestConfirmation(say, data as GuestConfirmation);
    case "guest_cancellation":
      return guestCancellation(say, data as GuestBooking & Refund);
    case "staff_new_booking":
      return staffNewBooking(say, data as StaffBooking);
    case "staff_cancellation":
      return staffCancellation(say, data as StaffBooking & Refund);
    case "staff_alert":
      return staffAlert(say, data as StaffAlert);
    case "reconcile_report":
      return reconcileReport(say, data as ReconcileReport);
  }
}

/** The subject, text and HTML of an outbox email. The subject stays one plain line, so no value can add a mail header. */
export function renderEmail(p: EmailPayload): Rendered {
  const locale = p.template.startsWith("guest_") ? p.locale : "ja";
  const say: Say = (key, values = {}) => fill(t(locale, email, key), values);
  const { subject, blocks } = compose(say, p);
  return {
    subject: subject.replace(/[\r\n]+/g, " "),
    text: blocks.map(blockText).join("\n\n"),
    html: serialize(element("div", { lang: htmlLang(locale), style: BODY_STYLE }, ...blocks.map(blockHtml))),
  };
}
