// What the checkout page does in the browser that can run without one: the verification details for Card.tokenize(), the
// guest check it shares with the confirm endpoint (task #34), and what each confirm response means for the page. Expected
// values are literals. The real card flow and the 3DS challenge are checked by hand against the sandbox (task #37).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVerificationDetails, confirmOutcome, validateGuest } from "../src/lib/checkout.ts";

type GuestFields = { familyName: string; givenName: string; email: string; phone: string };
type Field = keyof GuestFields;

const CODES: Record<Field, string> = {
  familyName: "FAMILY_NAME_EMPTY",
  givenName: "GIVEN_NAME_EMPTY",
  email: "EMAIL_MALFORMED",
  phone: "PHONE_NO_DIGITS",
};

const FIELDS = Object.keys(CODES) as Field[];

const GOOD: GuestFields = {
  familyName: "Yamada",
  givenName: "Hanako",
  email: "hanako@example.jp",
  phone: "+81 90-1234-5678",
};

/** U+3000 is the space a Japanese input method types. */
const BLANK_NAMES = ["", " ", "   ", "\t", "\n", " \t\n ", "　", " 　 "];

const BAD: Record<Field, string[]> = {
  familyName: BLANK_NAMES,
  givenName: BLANK_NAMES,
  email: [
    "",
    "   ",
    "plainaddress",
    "hanako.example.jp",
    "@example.jp",
    "hanako@",
    "hanako@example",
    "hanako@example.",
    "hanako@.jp",
    "hanako@@example.jp",
    "hana@ko@example.jp",
    "hana ko@example.jp",
    "hanako@exam ple.jp",
    "hanako@example.jp and more",
    // A slip in the domain, which no mail server would answer to.
    "hanako@example..jp",
    "hanako@example.jp.",
    "hanako@example.jp..",
    "hanako@.example.jp",
    "hanako@example...jp",
    // Markup, which breaks out of a script block or an attribute wherever an address is written unescaped.
    "a</script>@example.jp",
    "a</SCRIPT>@example.jp",
    "<a@example.jp",
    "a>b@example.jp",
    "<script>alert(1)</script>@example.jp",
    '"><svg/onload=alert(1)>@example.jp',
    'hana"ko@example.jp',
    "hanako@example.jp<script>",
    "hanako@exam<ple.jp",
    "hanako@example.jp>",
    "hanako@<b>example.jp",
    // validateGuest checks and does not change, and the confirm endpoint stores what it is given, so a padded address is
    // refused here. The client trims before it gets this far.
    " hanako@example.jp",
    "hanako@example.jp ",
    " hanako@example.jp ",
    "\thanako@example.jp\n",
    "　hanako@example.jp　",
  ],
  // The last two are full-width punctuation, which a Japanese input method types, with no digit among it.
  phone: ["", "   ", "+", "-", "()", "+ - ( )", "...", "phone", "abc-defg-hijk", "なし", "없음", "＋－（）", "（　）－"],
};

const GOOD_VALUES: Record<Field, string[]> = {
  familyName: ["Yamada", "山田", "김", "李", "O'Brien", "de la Cruz", "Núñez", "x"],
  givenName: ["Hanako", "花子", "민지", "娜", "Jean-Luc", "Mary Ann", "y"],
  email: [
    "a@b.co",
    "hanako@example.jp",
    "hanako.yamada+rental@mail.example.co.jp",
    "MIN_JI-99@Example.KR",
    "1234567890@example.com",
    // A real address, so the check on markup stops at what is markup.
    "o'brien@example.ie",
  ],
  phone: [
    "+81 90-1234-5678",
    "090-1234-5678",
    "09012345678",
    "(098) 123-4567",
    "+1 (415) 555-0100",
    "+82 10 1234 5678",
    "+86 138 0013 8000",
    "090.1234.5678",
    // A Japanese input method types these digits, and the check only refuses a phone with none.
    "０９０-１２３４-５６７８",
    "０９０１２３４５６７８",
  ],
};

test("verification details match the deposit and guest", () => {
  const table: [depositJpy: number, amount: string, guest: GuestFields][] = [
    [5000, "5000", GOOD],
    [3000, "3000", { familyName: "山田", givenName: "太郎", email: "taro@example.co.jp", phone: "090-1234-5678" }],
    [12345, "12345", { familyName: "김", givenName: "민지", email: "minji@example.kr", phone: "+82 10 1234 5678" }],
    // A separator, a decimal or a grouped form would be another amount, or none, to Square.
    [1000000, "1000000", { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000" }],
    [1, "1", { familyName: "O'Brien", givenName: "Mary Ann", email: "m+a@example.ie", phone: "(098) 123-4567" }],
    // The schema allows a class with no deposit, and a falsy amount must stay an amount.
    [0, "0", { familyName: "Núñez", givenName: "Inés", email: "ines@example.es", phone: "+34 600 000 000" }],
  ];
  for (const [depositJpy, amount, guest] of table) {
    assert.deepEqual(
      buildVerificationDetails(depositJpy, guest),
      {
        amount,
        currencyCode: "JPY",
        intent: "CHARGE",
        customerInitiated: true,
        sellerKeyedIn: false,
        billingContact: {
          familyName: guest.familyName,
          givenName: guest.givenName,
          email: guest.email,
          phone: guest.phone,
        },
      },
      `${depositJpy} for ${guest.familyName}`,
    );
  }
});

test("a guest's other keys stay out of the billing contact", () => {
  const guest = { ...GOOD, locale: "ja", sourceId: "cnon:card-nonce", notes: "call first" };
  assert.deepEqual(buildVerificationDetails(7300, guest), {
    amount: "7300",
    currencyCode: "JPY",
    intent: "CHARGE",
    customerInitiated: true,
    sellerKeyedIn: false,
    billingContact: { familyName: "Yamada", givenName: "Hanako", email: "hanako@example.jp", phone: "+81 90-1234-5678" },
  });
});

test("validateGuest flags each bad field", () => {
  assert.equal(new Set(Object.values(CODES)).size, FIELDS.length, "each field has its own code");

  // Each bad value alone reports its own field and no other.
  for (const field of FIELDS) {
    for (const value of BAD[field]) {
      const guest = { ...GOOD, [field]: value };
      assert.deepEqual(validateGuest(guest), [CODES[field]], `${field} = ${JSON.stringify(value)}`);
    }
  }

  // Every mix of bad fields reports exactly those fields.
  for (let mask = 1; mask < 2 ** FIELDS.length; mask += 1) {
    const bad = FIELDS.filter((_, bit) => (mask & (1 << bit)) !== 0);
    const guest = { ...GOOD };
    for (const field of bad) guest[field] = BAD[field][mask % BAD[field].length] as string;
    const expected = bad.map((field) => CODES[field]).sort();
    assert.deepEqual([...validateGuest(guest)].sort(), expected, JSON.stringify(guest));
  }
});

test("validateGuest passes valid guests in any language and format", () => {
  assert.deepEqual(validateGuest(GOOD), []);
  for (const field of FIELDS) {
    for (const value of GOOD_VALUES[field]) {
      assert.deepEqual(validateGuest({ ...GOOD, [field]: value }), [], `${field} = ${JSON.stringify(value)}`);
    }
  }
});

test("validateGuest refuses a malformed body without throwing", () => {
  // The confirm endpoint hands it a request body, so nothing about the input can be taken from its type.
  const everyCode = Object.values(CODES).sort();
  for (const body of [null, undefined, 42, true, "guest", [], {}]) {
    assert.deepEqual([...validateGuest(body)].sort(), everyCode, `body ${JSON.stringify(body)}`);
  }
  for (const value of [null, undefined, 42, 0, true, [], {}]) {
    const guest = { familyName: value, givenName: value, email: value, phone: value };
    assert.deepEqual([...validateGuest(guest)].sort(), everyCode, `every field ${JSON.stringify(value)}`);
  }

  // A value that reads as good once it is coerced to a string.
  const coerced: [Field, unknown][] = [
    ["familyName", ["Yamada"]],
    ["givenName", ["Hanako"]],
    ["email", ["hanako@example.jp"]],
    ["phone", 9012345678],
    ["phone", ["090-1234-5678"]],
  ];
  for (const [field, value] of coerced) {
    assert.deepEqual(validateGuest({ ...GOOD, [field]: value }), [CODES[field]], `${field} = ${JSON.stringify(value)}`);
  }
});

test("confirmOutcome maps each confirm response", () => {
  const table: [status: number, body: unknown, expected: unknown][] = [
    [200, { ok: true }, { kind: "ok", retry: false }],
    [409, { ok: false, reason: "HOLD_EXPIRED" }, { kind: "expired", retry: false }],
    [409, { ok: false, reason: "IN_PROGRESS" }, { kind: "in-progress", retry: false }],
    [202, { ok: false, reason: "PAYMENT_UNKNOWN" }, { kind: "unknown", retry: false }],
    [
      402,
      { ok: false, reason: "PAYMENT_DECLINED", message: "Your card was declined." },
      { kind: "declined", retry: true, message: "Your card was declined." },
    ],
    [
      402,
      { ok: false, reason: "PAYMENT_DECLINED", message: "カードが利用できません。" },
      { kind: "declined", retry: true, message: "カードが利用できません。" },
    ],
    [
      400,
      { ok: false, reason: "INVALID_GUEST", fields: ["EMAIL_MALFORMED"] },
      { kind: "invalid-guest", retry: true, fields: ["EMAIL_MALFORMED"] },
    ],
    [
      400,
      { ok: false, reason: "INVALID_GUEST", fields: ["FAMILY_NAME_EMPTY", "PHONE_NO_DIGITS"] },
      { kind: "invalid-guest", retry: true, fields: ["FAMILY_NAME_EMPTY", "PHONE_NO_DIGITS"] },
    ],
  ];
  for (const [status, body, expected] of table) {
    assert.deepEqual(confirmOutcome(status, body), expected, `${status} ${JSON.stringify(body)}`);
  }
});

test("confirmOutcome reads any other response as unknown, never as paid or retryable", () => {
  // A charge may have gone through, so the guest must not be told it did, and must not be offered a second try.
  const table: [status: number, body: unknown][] = [
    [500, null],
    [500, {}],
    [500, "Internal Server Error"],
    [502, "bad gateway"],
    [503, undefined],
    [200, null],
    [200, {}],
    [200, { ok: false }],
    [404, { ok: false, reason: "NOT_FOUND" }],
    [409, { ok: false }],
    [409, { ok: false, reason: "SOMETHING_NEW" }],
    [402, { ok: false }],
    [400, { ok: false }],
    // Names every object inherits, for a lookup table keyed by reason.
    [409, { ok: false, reason: "constructor" }],
    [409, { ok: false, reason: "__proto__" }],
    [409, { ok: false, reason: "toString" }],
    // `ok` is the boolean true or nothing counts as paid, and only `ok: false` carries a reason.
    [200, { ok: 1 }],
    [200, { ok: "true" }],
    [200, []],
    [402, "PAYMENT_DECLINED"],
    [409, { ok: true, reason: "HOLD_EXPIRED" }],
    [402, { ok: true, reason: "PAYMENT_DECLINED", message: "x" }],
    [400, { ok: true, reason: "INVALID_GUEST", fields: [] }],
    [202, { ok: true, reason: "PAYMENT_UNKNOWN" }],
  ];
  for (const [status, body] of table) {
    assert.deepEqual(confirmOutcome(status, body), { kind: "unknown", retry: false }, `${status} ${JSON.stringify(body)}`);
  }
});

test("confirmOutcome counts each answer only on the status the contract gives it", () => {
  const unknown = { kind: "unknown", retry: false };
  const contract: [status: number, body: unknown, expected: unknown][] = [
    [200, { ok: true }, { kind: "ok", retry: false }],
    [409, { ok: false, reason: "HOLD_EXPIRED" }, { kind: "expired", retry: false }],
    [409, { ok: false, reason: "IN_PROGRESS" }, { kind: "in-progress", retry: false }],
    [202, { ok: false, reason: "PAYMENT_UNKNOWN" }, unknown],
    [402, { ok: false, reason: "PAYMENT_DECLINED", message: "x" }, { kind: "declined", retry: true, message: "x" }],
    [
      400,
      { ok: false, reason: "INVALID_GUEST", fields: ["EMAIL_MALFORMED"] },
      { kind: "invalid-guest", retry: true, fields: ["EMAIL_MALFORMED"] },
    ],
  ];
  // A 500 that says paid, or a 200 that says declined, is a response nobody wrote, so it cannot be trusted either way.
  const statuses = [0, 200, 201, 202, 204, 301, 400, 401, 402, 403, 404, 409, 410, 422, 429, 500, 502, 503, 504];
  for (const status of statuses) {
    for (const [declared, body, expected] of contract) {
      assert.deepEqual(
        confirmOutcome(status, body),
        status === declared ? expected : unknown,
        `${status} ${JSON.stringify(body)}`,
      );
    }
  }
});

test("confirmOutcome keeps a declared answer whose detail is missing or bad", () => {
  // The status and the reason agree, so the outcome stands, and the client falls back to its own words.
  const declined = { kind: "declined", retry: true, message: "" };
  for (const body of [
    { ok: false, reason: "PAYMENT_DECLINED" },
    { ok: false, reason: "PAYMENT_DECLINED", message: "" },
    { ok: false, reason: "PAYMENT_DECLINED", message: null },
    { ok: false, reason: "PAYMENT_DECLINED", message: 42 },
    { ok: false, reason: "PAYMENT_DECLINED", message: true },
    { ok: false, reason: "PAYMENT_DECLINED", message: ["x"] },
    { ok: false, reason: "PAYMENT_DECLINED", message: { text: "x" } },
  ]) {
    assert.deepEqual(confirmOutcome(402, body), declined, JSON.stringify(body));
  }

  const invalid = { kind: "invalid-guest", retry: true, fields: [] };
  for (const body of [
    { ok: false, reason: "INVALID_GUEST" },
    { ok: false, reason: "INVALID_GUEST", fields: [] },
    { ok: false, reason: "INVALID_GUEST", fields: null },
    { ok: false, reason: "INVALID_GUEST", fields: 42 },
    { ok: false, reason: "INVALID_GUEST", fields: "EMAIL_MALFORMED" },
    { ok: false, reason: "INVALID_GUEST", fields: { 0: "EMAIL_MALFORMED", length: 1 } },
    { ok: false, reason: "INVALID_GUEST", fields: [1, null, {}, ["EMAIL_MALFORMED"]] },
  ]) {
    assert.deepEqual(confirmOutcome(400, body), invalid, JSON.stringify(body));
  }

  assert.deepEqual(
    confirmOutcome(400, { ok: false, reason: "INVALID_GUEST", fields: [1, "EMAIL_MALFORMED", null, "PHONE_NO_DIGITS", {}] }),
    { kind: "invalid-guest", retry: true, fields: ["EMAIL_MALFORMED", "PHONE_NO_DIGITS"] },
  );
});
