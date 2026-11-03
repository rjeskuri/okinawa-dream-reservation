// What the hold page's client shares with the page and the confirm endpoint (task #34): the verification details for
// Square's Card.tokenize(), the check on a guest, what each confirm response means, and how the time left reads.

export type Guest = { familyName: string; givenName: string; email: string; phone: string };

export type GuestField = keyof Guest;

/** Each guest field and the code it fails with, which is also what the confirm endpoint answers in `fields`. */
export const GUEST_CODES = {
  familyName: "FAMILY_NAME_EMPTY",
  givenName: "GIVEN_NAME_EMPTY",
  email: "EMAIL_MALFORMED",
  phone: "PHONE_NO_DIGITS",
} as const;

export type GuestCode = (typeof GUEST_CODES)[GuestField];

export const GUEST_FIELDS = Object.keys(GUEST_CODES) as GuestField[];

export type VerificationDetails = {
  amount: string;
  currencyCode: "JPY";
  intent: "CHARGE";
  customerInitiated: true;
  sellerKeyedIn: false;
  billingContact: Guest;
};

export type ConfirmOutcome =
  | { kind: "ok" | "expired" | "in-progress" | "unknown"; retry: false }
  | { kind: "declined"; retry: true; message: string }
  | { kind: "invalid-guest"; retry: true; fields: string[] };

/**
 * One @ and a dotted domain with no empty label, so a slip like hanako@example..jp fails while the local part keeps its
 * dots. Markup characters are refused because an address is written into pages and emails. The classes exclude what ends
 * them, so a megabyte from a request body is read in one pass.
 */
const EMAIL = /^[^\s@<>"]+@[^\s@<>".]+(?:\.[^\s@<>".]+)+$/;

/** Any decimal digit, since a Japanese input method types full-width ones. */
const DIGIT = /\p{Nd}/u;

const GUEST_CHECKS: Record<GuestField, (value: string) => boolean> = {
  familyName: (value) => value.trim() !== "",
  givenName: (value) => value.trim() !== "",
  email: (value) => EMAIL.test(value),
  phone: (value) => DIGIT.test(value),
};

/** For `Card.tokenize()`. Yen has no minor unit, so the amount is the whole deposit as a string. */
export function buildVerificationDetails(depositJpy: number, guest: Guest): VerificationDetails {
  const { familyName, givenName, email, phone } = guest;
  return {
    amount: String(depositJpy),
    currencyCode: "JPY",
    intent: "CHARGE",
    customerInitiated: true,
    sellerKeyedIn: false,
    billingContact: { familyName, givenName, email, phone },
  };
}

/**
 * The code of each field that fails, or an empty list. `guest` can be a request body, so nothing is taken from its type. It
 * checks and does not change, so a padded email fails: the client trims first, and the endpoint stores what it is given.
 */
export function validateGuest(guest: unknown): GuestCode[] {
  // Object() because null or a number has no fields to read.
  const fields = Object(guest) as Record<GuestField, unknown>;
  const passes = (field: GuestField, value: unknown) => typeof value === "string" && GUEST_CHECKS[field](value);
  return GUEST_FIELDS.filter((field) => !passes(field, fields[field])).map((field) => GUEST_CODES[field]);
}

/**
 * What a confirm response means, by the contract of task #34. Anything else may be a charge that went through, so it is
 * unknown: never paid, and never retryable. Only a status and a reason that agree count.
 */
export function confirmOutcome(status: number, body: unknown): ConfirmOutcome {
  const unknown: ConfirmOutcome = { kind: "unknown", retry: false };
  if (typeof body !== "object" || body === null) return unknown;
  const { ok, reason, message, fields } = body as Record<string, unknown>;

  if (status === 200 && ok === true) return { kind: "ok", retry: false };
  if (ok !== false) return unknown;

  if (status === 409 && reason === "HOLD_EXPIRED") return { kind: "expired", retry: false };
  if (status === 409 && reason === "IN_PROGRESS") return { kind: "in-progress", retry: false };
  if (status === 402 && reason === "PAYMENT_DECLINED") {
    return { kind: "declined", retry: true, message: typeof message === "string" ? message : "" };
  }
  if (status === 400 && reason === "INVALID_GUEST") {
    const named = Array.isArray(fields) ? fields.filter((field) => typeof field === "string") : [];
    return { kind: "invalid-guest", retry: true, fields: named };
  }
  return unknown;
}

/** `ms` as 12:05, rounded up so that 00:00 means no time is left. */
export function timeLeftText(ms: number): string {
  const seconds = Math.max(Math.ceil(ms / 1000), 0);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}
