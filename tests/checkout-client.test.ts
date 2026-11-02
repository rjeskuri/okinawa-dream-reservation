// What src/scripts/checkout.ts does to a hold page, run for real on the fake page of tests/helpers/checkout-client.ts, which
// also holds the seam between the two. Each behaviour runs on two holds that share no value, so a literal in the client shows.
// Wording is free, so what the client says is found in the places the seam names and compared, not read.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Locale } from "../src/lib/locale.ts";
import { LOCALES } from "../src/lib/locale.ts";
import {
  fakeHoldPage,
  GUEST_FIELDS,
  openCheckout,
  respond,
  type Checkout,
  type Guest,
  type GuestField,
  type HoldPage,
  type OpenOptions,
} from "./helpers/checkout-client.ts";

const SANDBOX_SDK = "https://sandbox.web.squarecdn.com/v1/square.js";
const PRODUCTION_SDK = "https://web.squarecdn.com/v1/square.js";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

const NOW = Date.parse("2031-03-01T10:00:00+09:00");

type Fixture = { hold: HoldPage; guest: Guest; token: string; retryToken: string };

const FIRST: Fixture = {
  hold: {
    bookingId: "3f0c1c8e-7a52-4c1b-9d3e-5b1f6a2e0a11",
    locale: "en",
    depositJpy: 7_300,
    sdkUrl: SANDBOX_SDK,
    applicationId: "sandbox-sq0idb-first",
    locationId: "LFIRST123",
    expiresAt: NOW + 12 * MINUTE_MS + 5 * SECOND_MS,
  },
  guest: { familyName: "Yamada", givenName: "Hanako", email: "hanako@example.jp", phone: "+81 90-1234-5678" },
  token: "cnon:first-card",
  retryToken: "cnon:first-card-again",
};

const SECOND: Fixture = {
  hold: {
    bookingId: "b7e29d40-16fc-4f7e-8a60-c2d94e7713f2",
    locale: "ko",
    depositJpy: 12_500,
    sdkUrl: PRODUCTION_SDK,
    applicationId: "sq0idp-second",
    locationId: "LSECOND456",
    expiresAt: NOW + 3 * MINUTE_MS + 41 * SECOND_MS,
  },
  guest: { familyName: "김", givenName: "민지", email: "minji@example.kr", phone: "+82 10 1234 5678" },
  token: "cnon:second-card",
  retryToken: "cnon:second-card-again",
};

const FIXTURES = [FIRST, SECOND];

const EXPIRED = respond(409, { ok: false, reason: "HOLD_EXPIRED" });
const IN_PROGRESS = respond(409, { ok: false, reason: "IN_PROGRESS" });
const UNKNOWN = respond(202, { ok: false, reason: "PAYMENT_UNKNOWN" });

const DECLINED = respond(402, { ok: false, reason: "PAYMENT_DECLINED", message: "Declined by the bank" });

const BAD_VALUES: [GuestField, string][] = [
  ["familyName", "   "],
  ["givenName", ""],
  ["email", "hanako@"],
  ["phone", "なし"],
];

/** Each field with a value that fails it, and the code the server uses for the same thing. */
const FIELD_PROBLEMS: [GuestField, string, string][] = [
  ["familyName", "   ", "FAMILY_NAME_EMPTY"],
  ["givenName", "", "GIVEN_NAME_EMPTY"],
  ["email", "hanako@", "EMAIL_MALFORMED"],
  ["phone", "なし", "PHONE_NO_DIGITS"],
];

/** Each way the card form can fail to start. */
const BROKEN_SDK: [string, Partial<OpenOptions>][] = [
  ["the SDK's script fails to load", { sdk: "fails" }],
  ["the SDK loads without window.Square", { sdk: "no-global" }],
  [
    "Square refuses the ids",
    {
      payments: () => {
        throw new Error("InvalidApplicationIdError");
      },
    },
  ],
  ["Square gives no card", { card: () => Promise.reject(new Error("card failed")) }],
  ["card.attach rejects", { attach: () => Promise.reject(new Error("attach failed")) }],
];

function open(t: TestContext, hold: HoldPage, options: Partial<OpenOptions> = {}): Promise<Checkout> {
  return openCheckout(t, fakeHoldPage(hold), { now: NOW, ...options });
}

function verificationDetails(depositJpy: number, guest: Guest) {
  return {
    amount: String(depositJpy),
    currencyCode: "JPY",
    intent: "CHARGE",
    customerInitiated: true,
    sellerKeyedIn: false,
    billingContact: { ...guest },
  };
}

function assertNoStrayText(words: string, label: string): void {
  const missing = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|\{\w+\}/;
  assert.doesNotMatch(words, missing, `${label}: prints a missing value: ${words}`);
}

/** How an attempt ended, for telling one ending from another: the page came back from the server, or the client spoke. */
function ending(checkout: Checkout): string {
  return checkout.reloads > 0 ? "reloaded" : checkout.message();
}

/** The attempt is over, in the sense that nothing the guest can still do reaches Square or the confirm endpoint again. */
async function assertNoRetry(checkout: Checkout, label: string): Promise<void> {
  const tokenized = checkout.square.tokenize.length;
  const posted = checkout.confirms.length;
  // After a tick too, so a countdown that sets the button from the time left cannot hand it back.
  await checkout.tick(2 * SECOND_MS);
  if (checkout.reloads === 0) {
    assert.equal(checkout.payable(), false, `${label}: the pay button still works`);
    // A submit does not ask the button, and this one could be a second charge.
    checkout.submit();
    await checkout.settle();
  }
  await checkout.pay();
  assert.equal(checkout.square.tokenize.length, tokenized, `${label}: a second card was tokenized`);
  assert.equal(checkout.confirms.length, posted, `${label}: a second charge was posted`);
}

/** Nothing the client says to the guest is left on the page. */
function allSaid(checkout: Checkout): string {
  return [checkout.message(), ...GUEST_FIELDS.map((field) => checkout.fieldError(field))].join("");
}

/** `guest` as typed with spaces around every value. */
function padded(guest: Guest, before: string, after: string): Guest {
  const pad = (value: string): string => `${before}${value}${after}`;
  return {
    familyName: pad(guest.familyName),
    givenName: pad(guest.givenName),
    email: pad(guest.email),
    phone: pad(guest.phone),
  };
}

/** Runs one payment that ends in `reply`. */
async function attempt(t: TestContext, { hold, guest }: Fixture, reply: OpenOptions["confirms"]): Promise<Checkout> {
  const checkout = await open(t, hold, { confirms: reply ?? [] });
  checkout.fill(guest);
  await checkout.pay();
  assert.equal(checkout.confirms.length, 1, "the payment never reached the confirm endpoint");
  return checkout;
}

/** The seconds a countdown shows, read as digit groups in base 60, so 12:05 and 12分05秒 are both 725. */
function secondsIn(text: string): number {
  const groups = text.normalize("NFKC").match(/\d+/g) ?? [];
  assert.ok(groups.length > 0, `no time in the countdown: ${JSON.stringify(text)}`);
  return groups.reduce((total, group) => total * 60 + Number(group), 0);
}

function assertTimeLeft(checkout: Checkout, ms: number, label: string): void {
  const shown = secondsIn(checkout.countdown());
  const left = Math.round(ms / SECOND_MS);
  assert.ok(Math.abs(shown - left) <= 1, `${label}: ${checkout.countdown()} is ${shown}s, not ${left}s`);
}

test("the client loads the SDK the page names, then mounts the card", async (t) => {
  for (const { hold } of FIXTURES) {
    const checkout = await open(t, hold);
    assert.deepEqual(checkout.sdkRequests, [hold.sdkUrl]);
    assert.deepEqual(checkout.square.payments, [[hold.applicationId, hold.locationId]]);
    assert.equal(checkout.square.card, 1, "one card");
    assert.deepEqual(checkout.square.attach, ["#card-container"]);
    assert.deepEqual(checkout.square.tokenize, [], "nothing is tokenized until the guest pays");
    assert.deepEqual(checkout.confirms, [], "nothing is posted until the guest pays");
  }
});

test("the pay button goes live only once the card has mounted", async (t) => {
  for (const { hold } of FIXTURES) {
    const loading = await open(t, hold, { sdk: "waits" });
    assert.equal(loading.payable(), false, "live while the SDK loads");
    await loading.tick(2 * SECOND_MS);
    assert.equal(loading.payable(), false, "a tick of the countdown made it live");
    await loading.loadSdk();
    assert.equal(loading.payable(), true, "still dead with the card mounted");

    const attached = Promise.withResolvers<void>();
    const mounting = await open(t, hold, { attach: () => attached.promise });
    assert.deepEqual(mounting.square.attach, ["#card-container"], "the card never set out to mount");
    assert.equal(mounting.payable(), false, "live while the card mounts");
    attached.resolve();
    await mounting.settle();
    assert.equal(mounting.payable(), true, "still dead with the card mounted");
  }
});

/** A submit with no card to pay with: it goes nowhere, and whatever it started must not outlast it. */
async function assertSubmitDoesNothing(checkout: Checkout, label: string): Promise<void> {
  checkout.submit();
  await checkout.settle();
  assert.deepEqual(checkout.square.tokenize, [], `${label}: tokenized`);
  assert.deepEqual(checkout.confirms, [], `${label}: posted`);
  assert.equal(checkout.reloads, 0, `${label}: left the page`);
  assert.equal(checkout.payable(), false, `${label}: live with no card`);
}

async function assertPaysNow(checkout: Checkout, label: string): Promise<void> {
  assert.equal(checkout.payable(), true, `${label}: the early submit wedged the button`);
  assert.equal(allSaid(checkout), "", `${label}: words about the wait outlived it`);
  await checkout.pay();
  assert.equal(checkout.square.tokenize.length, 1, `${label}: the guest cannot pay`);
  assert.equal(checkout.confirms.length, 1, `${label}: the guest cannot pay`);
  assert.equal(checkout.reloads, 1, `${label}: the guest cannot pay`);
}

test("a submit before the card has mounted goes nowhere and wedges nothing", async (t) => {
  for (const { hold, guest } of FIXTURES) {
    let ran = false;
    const atStart = await open(t, hold, {
      sdk: "waits",
      onStart(checkout) {
        checkout.fill(guest);
        checkout.submit();
        ran = true;
      },
    });
    assert.ok(ran, "the first submit never ran");
    await assertSubmitDoesNothing(atStart, "as the script starts");
    await atStart.loadSdk();
    await assertPaysNow(atStart, "as the script starts");

    const loading = await open(t, hold, { sdk: "waits" });
    loading.fill(guest);
    await assertSubmitDoesNothing(loading, "while the SDK loads");
    await assertSubmitDoesNothing(loading, "again while the SDK loads");
    await loading.loadSdk();
    await assertPaysNow(loading, "while the SDK loads");

    const attached = Promise.withResolvers<void>();
    const mounting = await open(t, hold, { attach: () => attached.promise });
    mounting.fill(guest);
    await assertSubmitDoesNothing(mounting, "while the card mounts");
    attached.resolve();
    await mounting.settle();
    await assertPaysNow(mounting, "while the card mounts");
  }
});

test("a card form that cannot start says so and cannot be paid", async (t) => {
  for (const { hold, guest } of FIXTURES) {
    for (const [label, broken] of BROKEN_SDK) {
      const checkout = await open(t, hold, broken);
      assert.notEqual(checkout.message(), "", `${label}: a dead page`);
      assertNoStrayText(checkout.message(), label);
      assert.equal(checkout.payable(), false, `${label}: the pay button is live`);

      await checkout.tick(2 * SECOND_MS);
      assert.equal(checkout.payable(), false, `${label}: a tick of the countdown made it live`);
      assert.notEqual(checkout.message(), "", `${label}: a tick of the countdown took the message away`);

      checkout.fill(guest);
      await assertSubmitDoesNothing(checkout, label);
      assert.notEqual(checkout.message(), "", `${label}: the submit took the message away`);
    }
  }
});

test("a valid submit tokenizes with verification details and posts the confirm contract", async (t) => {
  const { buildVerificationDetails } = await import("../src/lib/checkout.ts");
  for (const { hold, guest, token } of FIXTURES) {
    const checkout = await open(t, hold, { tokens: [token] });
    checkout.fill(guest);
    await checkout.pay();

    const details = verificationDetails(hold.depositJpy, guest);
    assert.deepEqual(buildVerificationDetails(hold.depositJpy, guest), details);
    assert.deepEqual(checkout.square.tokenize, [[details]], "3-D Secure needs the details on the one tokenize call");
    assert.deepEqual(checkout.square.verifyBuyer, [], "verifyBuyer is being deprecated");
    assert.deepEqual(checkout.confirms, [
      {
        method: "POST",
        path: `/api/holds/${hold.bookingId}/confirm`,
        contentType: "application/json",
        body: { sourceId: token, guest, locale: hold.locale },
      },
    ]);
  }
});

test("the client trims the guest for Square and for the confirm endpoint alike", async (t) => {
  const paddings = [
    ["  ", "  "],
    ["\t", "\n"],
    // The space a Japanese input method types.
    ["　", "　"],
    [" ", ""],
    ["", " "],
  ];
  for (const { hold, guest, token, retryToken } of FIXTURES) {
    // The spaces inside a value are the guest's.
    const typed = { ...guest, givenName: `${guest.givenName} Ann` };
    const details = verificationDetails(hold.depositJpy, typed);
    for (const [before, after] of paddings as [string, string][]) {
      const label = JSON.stringify([before, after]);
      const checkout = await open(t, hold, { tokens: [token, retryToken], confirms: [DECLINED, respond(200, { ok: true })] });
      checkout.fill(padded(typed, before, after));
      await checkout.pay();

      for (const field of GUEST_FIELDS) assert.equal(checkout.fieldError(field), "", `${label}: ${field} was flagged`);
      assert.deepEqual(checkout.square.tokenize, [[details]], `${label}: Square got the padding`);
      assert.deepEqual(
        checkout.confirms[0]?.body,
        { sourceId: token, guest: typed, locale: hold.locale },
        `${label}: the confirm endpoint got the padding`,
      );

      // The form still holds what the guest typed, so a retry has it all to trim again.
      await checkout.pay();
      assert.deepEqual(checkout.square.tokenize[1], [details], `${label}: the retry sent Square the padding`);
      assert.deepEqual(
        checkout.confirms[1]?.body,
        { sourceId: retryToken, guest: typed, locale: hold.locale },
        `${label}: the retry sent the padding`,
      );
    }
  }
});

test("a bad field stops the payment and shows its error", async (t) => {
  for (const { hold, guest } of FIXTURES) {
    for (const [field, value] of BAD_VALUES) {
      const label = `${field} = ${JSON.stringify(value)}`;
      const checkout = await open(t, hold);
      checkout.fill({ ...guest, [field]: value });
      await checkout.pay();

      assert.deepEqual(checkout.square.tokenize, [], `${label}: tokenized`);
      assert.deepEqual(checkout.confirms, [], `${label}: posted`);
      assert.notEqual(checkout.fieldError(field), "", `${label}: no error shown`);
      assertNoStrayText(checkout.fieldError(field), label);
      for (const other of GUEST_FIELDS.filter((name) => name !== field)) {
        assert.equal(checkout.fieldError(other), "", `${label}: an error on ${other}`);
      }

      // Fixing it clears the error and the payment goes through.
      assert.equal(checkout.payable(), true, `${label}: the guest cannot try again`);
      checkout.fill(guest);
      await checkout.pay();
      assert.equal(checkout.fieldError(field), "", `${label}: the error outlived the fix`);
      assert.equal(checkout.confirms.length, 1, `${label}: the fixed form was not paid`);
    }

    const checkout = await open(t, hold);
    checkout.fill({ familyName: "", givenName: " ", email: "nope", phone: "---" });
    await checkout.pay();
    assert.deepEqual(checkout.square.tokenize, [], "every field bad: tokenized");
    assert.deepEqual(checkout.confirms, [], "every field bad: posted");
    for (const field of GUEST_FIELDS) assert.notEqual(checkout.fieldError(field), "", `every field bad: none on ${field}`);
  }
});

test("a field put right loses its error and the others keep theirs", async (t) => {
  const bad = Object.fromEntries(BAD_VALUES) as Guest;
  for (const { hold, guest } of FIXTURES) {
    for (const [fixed] of BAD_VALUES) {
      const checkout = await open(t, hold);
      checkout.fill(bad);
      await checkout.pay();
      for (const field of GUEST_FIELDS) assert.notEqual(checkout.fieldError(field), "", `no error on ${field}`);

      checkout.fill({ ...bad, [fixed]: guest[fixed] });
      await checkout.pay();
      assert.equal(checkout.fieldError(fixed), "", `${fixed} kept its error once it was right`);
      for (const other of GUEST_FIELDS.filter((field) => field !== fixed)) {
        assert.notEqual(checkout.fieldError(other), "", `fixing ${fixed} cleared the error on ${other}`);
      }
      assert.deepEqual(checkout.square.tokenize, [], `${fixed} fixed: tokenized`);
    }
  }
});

test("a new attempt clears what the last one said before it resolves", async (t) => {
  for (const fixture of FIXTURES) {
    const { hold, guest, token } = fixture;
    const leftovers: [string, Partial<OpenOptions>][] = [
      ["a decline", { confirms: [DECLINED] }],
      ["a failed tokenize", { tokens: [{ status: "Error" }] }],
      ["an invalid guest with no fields", { confirms: [respond(400, { ok: false, reason: "INVALID_GUEST" })] }],
      [
        "an invalid guest with fields",
        { confirms: [respond(400, { ok: false, reason: "INVALID_GUEST", fields: ["EMAIL_MALFORMED", "PHONE_NO_DIGITS"] })] },
      ],
    ];
    for (const [label, { tokens = [token], confirms }] of leftovers) {
      const tokenized = Promise.withResolvers<unknown>();
      const checkout = await open(t, hold, { tokens: [...tokens, () => tokenized.promise], confirms });
      checkout.fill(guest);
      await checkout.pay();
      assert.notEqual(allSaid(checkout), "", `${label}: nothing to clear`);

      await checkout.pay();
      assert.equal(checkout.square.tokenize.length, 2, `${label}: no second attempt`);
      assert.equal(allSaid(checkout), "", `${label}: still on the page through the retry`);

      tokenized.resolve({ status: "OK", token });
      await checkout.settle();
      assert.equal(checkout.reloads, 1, `${label}: the retry was not paid`);
    }

    // A new attempt can stop at the form, and the last answer is just as stale there.
    const declined = await attempt(t, fixture, [DECLINED]);
    assert.notEqual(declined.message(), "", "a decline says nothing");
    declined.fill({ ...guest, email: "hanako@" });
    await declined.pay();
    assert.equal(declined.message(), "", "the decline outlived a new attempt that stopped at the form");
    assert.notEqual(declined.fieldError("email"), "", "no error on the email");

    // The server marked a field the client's own check passes, and the guest then got another one wrong.
    const marked = await attempt(t, fixture, [
      respond(400, { ok: false, reason: "INVALID_GUEST", fields: ["EMAIL_MALFORMED"] }),
    ]);
    assert.notEqual(marked.fieldError("email"), "", "no error on the email");
    marked.fill({ ...guest, phone: "なし" });
    await marked.pay();
    assert.equal(marked.fieldError("email"), "", "the server's mark outlived a new attempt");
    assert.notEqual(marked.fieldError("phone"), "", "no error on the phone");
  }
});

test("a failed tokenize posts nothing and lets the guest retry", async (t) => {
  const failures: [string, () => unknown][] = [
    ["Invalid", () => ({ status: "Invalid", errors: [{ type: "VALIDATION_ERROR", message: "Card number is not valid" }] })],
    ["Error", () => ({ status: "Error" })],
    ["Cancel", () => ({ status: "Cancel" })],
    // The status decides, so a client that only looks for a token does not pass.
    ["a token without OK", () => ({ status: "Error", token: "cnon:not-to-be-used" })],
    ["a rejection", () => Promise.reject(new Error("tokenize failed"))],
  ];
  for (const { hold, guest, token } of FIXTURES) {
    for (const [label, failure] of failures) {
      const checkout = await open(t, hold, { tokens: [failure, token] });
      checkout.fill(guest);
      await checkout.pay();

      assert.equal(checkout.square.tokenize.length, 1, `${label}: tokenize`);
      assert.equal(checkout.confirms.length, 0, `${label}: posted without a token`);
      assert.equal(checkout.reloads, 0, `${label}: reloaded`);
      assert.notEqual(checkout.message(), "", `${label}: the page says nothing`);
      assertNoStrayText(checkout.message(), label);
      assert.equal(checkout.payable(), true, `${label}: the guest cannot try again`);

      await checkout.pay();
      assert.equal(checkout.square.tokenize.length, 2, `${label}: the retry did not tokenize`);
      assert.equal(checkout.confirms.length, 1, `${label}: the retry did not post`);
      assert.deepEqual(checkout.confirms[0]?.body, { sourceId: token, guest, locale: hold.locale }, label);
    }
  }
});

test("a confirmed payment reloads the page", async (t) => {
  for (const fixture of FIXTURES) {
    const checkout = await attempt(t, fixture, [respond(200, { ok: true })]);
    assert.equal(checkout.reloads, 1, "the page reloads once, for the server to render the confirmed state");
    assert.equal(checkout.button.disabled, true, "the pay button comes back before the page has gone");
  }
});

test("a declined card shows the server's message and allows a retry", async (t) => {
  const messages = [
    "Your card was declined.",
    "カードが利用できません。",
    // The server passes on words from Square, which are text and not the page's markup.
    "<img src=x onerror=alert(1)>Declined",
  ];
  for (const fixture of FIXTURES) {
    const { hold, guest, token, retryToken } = fixture;
    for (const message of messages) {
      const declined = respond(402, { ok: false, reason: "PAYMENT_DECLINED", message });
      const checkout = await open(t, hold, { tokens: [token, retryToken], confirms: [declined, respond(200, { ok: true })] });
      checkout.fill(guest);
      const pays = checkout.button.textContent;
      await checkout.pay();

      assert.equal(checkout.reloads, 0, `${message}: reloaded`);
      assert.ok(checkout.message().includes(message), `${message}: the page says ${checkout.message()}`);
      assert.equal(checkout.document.querySelector("img"), null, `${message}: written as markup`);
      assert.equal(checkout.payable(), true, `${message}: the guest cannot try again`);
      assert.equal(checkout.button.textContent, pays, `${message}: the button no longer shows the deposit`);

      // A source id works once, so a retry needs a new one, and the guest may have changed the form since.
      const changed = { ...guest, email: `retry.${guest.email}` };
      checkout.fill(changed);
      await checkout.pay();
      const details = verificationDetails(hold.depositJpy, changed);
      assert.deepEqual(checkout.square.tokenize[1], [details], `${message}: the retry tokenized old details`);
      assert.equal(checkout.confirms.length, 2, `${message}: the retry did not post`);
      assert.deepEqual(checkout.confirms[1]?.body, { sourceId: retryToken, guest: changed, locale: hold.locale }, message);
      assert.equal(checkout.reloads, 1, `${message}: the paid retry did not reload`);
    }

    // The server's detail is missing or bad: still a decline, in the client's own words.
    for (const body of [{ ok: false, reason: "PAYMENT_DECLINED" }, { ok: false, reason: "PAYMENT_DECLINED", message: 42 }]) {
      const checkout = await attempt(t, fixture, [respond(402, body)]);
      assert.notEqual(checkout.message(), "", "a decline with no message says nothing");
      assertNoStrayText(checkout.message(), "a decline with no message");
      assert.equal(checkout.payable(), true, "a decline with no message cannot be retried");
    }
  }
});

test("expired, in-progress and unknown each end the attempt in their own way", async (t) => {
  for (const fixture of FIXTURES) {
    const endings = new Map<string, string>();
    for (const [label, reply] of [
      ["HOLD_EXPIRED", EXPIRED],
      ["IN_PROGRESS", IN_PROGRESS],
      ["PAYMENT_UNKNOWN", UNKNOWN],
    ] as const) {
      const checkout = await attempt(t, fixture, [reply]);
      assert.notEqual(ending(checkout), "", `${label}: the page says nothing`);
      assertNoStrayText(ending(checkout), label);
      await assertNoRetry(checkout, label);
      endings.set(label, ending(checkout));
    }
    assert.equal(new Set(endings.values()).size, endings.size, `two read the same: ${[...endings.values()].join(" | ")}`);
  }
});

test("a failed request reads as unknown, never as a decline", async (t) => {
  // Each of these may be a charge that went through, so a guest told to try again could pay twice.
  const failures: [string, NonNullable<OpenOptions["confirms"]>[number]][] = [
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a gateway page", respond(502, "<html>Bad Gateway</html>")],
    ["an empty 500", respond(500, "")],
    ["a page where JSON belongs", respond(200, "<html>Welcome</html>")],
  ];
  for (const fixture of FIXTURES) {
    const unknown = ending(await attempt(t, fixture, [UNKNOWN]));
    const declined = ending(await attempt(t, fixture, [respond(402, { ok: false, reason: "PAYMENT_DECLINED" })]));
    for (const [label, failure] of failures) {
      const checkout = await attempt(t, fixture, [failure]);
      assert.equal(ending(checkout), unknown, `${label} does not read as unknown`);
      assert.notEqual(ending(checkout), declined, `${label} reads as a decline`);
      await assertNoRetry(checkout, label);
    }
  }
});

test("an invalid guest from the server marks the fields and allows a retry", async (t) => {
  // The endpoint runs the same check, so this answer is rare, but a guest who gets one has not been charged.
  for (const fixture of FIXTURES) {
    const { guest } = fixture;
    const checkout = await attempt(t, fixture, [
      respond(400, { ok: false, reason: "INVALID_GUEST", fields: ["EMAIL_MALFORMED", "PHONE_NO_DIGITS"] }),
    ]);
    assert.notEqual(checkout.fieldError("email"), "", "no error on the email");
    assert.notEqual(checkout.fieldError("phone"), "", "no error on the phone");
    assert.equal(checkout.fieldError("familyName"), "", "an error on the family name");
    assert.equal(checkout.fieldError("givenName"), "", "an error on the given name");
    assert.equal(checkout.payable(), true, "the guest cannot try again");

    checkout.fill(guest);
    await checkout.pay();
    assert.equal(checkout.confirms.length, 2, "the retry did not post");

    const bare = await attempt(t, fixture, [respond(400, { ok: false, reason: "INVALID_GUEST" })]);
    assert.notEqual(bare.message(), "", "an invalid guest with no fields says nothing");
    assert.equal(bare.payable(), true, "an invalid guest with no fields cannot be retried");
  }
});

test("the pay button is disabled while a payment is in flight", async (t) => {
  for (const { hold, guest, token } of FIXTURES) {
    const tokenized = Promise.withResolvers<unknown>();
    const answered = Promise.withResolvers<Response>();
    const checkout = await open(t, hold, { tokens: [() => tokenized.promise], confirms: [() => answered.promise] });
    checkout.fill(guest);

    // A double click: the second comes before anything the first started has finished.
    checkout.click();
    await checkout.pay();
    assert.equal(checkout.button.disabled, true, "enabled during tokenize, which a 3DS challenge can hold for minutes");
    assert.equal(checkout.square.tokenize.length, 1, "a double click tokenized twice");

    // The countdown goes on ticking through both waits, and must leave the button alone.
    await checkout.tick(2 * SECOND_MS);
    assert.equal(checkout.button.disabled, true, "a tick of the countdown enabled it during tokenize");

    tokenized.resolve({ status: "OK", token });
    await checkout.settle();
    assert.equal(checkout.button.disabled, true, "enabled while the confirm is out");
    assert.equal(checkout.confirms.length, 1, "no POST");

    await checkout.tick(2 * SECOND_MS);
    assert.equal(checkout.button.disabled, true, "a tick of the countdown enabled it during the confirm");
    await checkout.pay();
    assert.equal(checkout.confirms.length, 1, "a click during the confirm posted again");

    answered.resolve(await respond(402, { ok: false, reason: "PAYMENT_DECLINED", message: "Declined" })());
    await checkout.settle();
    assert.equal(checkout.button.disabled, false, "a decline hands the button back");
  }
});

test("a second submit while a payment is in flight is refused", async (t) => {
  // Enter in a field or requestSubmit, neither of which asks the button, and each of these could be a second charge.
  for (const { hold, guest, token, retryToken } of FIXTURES) {
    const tokenized = Promise.withResolvers<unknown>();
    const answered = Promise.withResolvers<Response>();
    const checkout = await open(t, hold, {
      tokens: [() => tokenized.promise, retryToken],
      confirms: [() => answered.promise, respond(200, { ok: true })],
    });
    checkout.fill(guest);

    checkout.click();
    checkout.submit();
    await checkout.settle();
    assert.equal(checkout.square.tokenize.length, 1, "a submit on the heels of the click tokenized again");

    checkout.submit();
    await checkout.settle();
    assert.equal(checkout.square.tokenize.length, 1, "a submit during tokenize tokenized again");
    assert.equal(checkout.confirms.length, 0, "a submit during tokenize posted");

    tokenized.resolve({ status: "OK", token });
    await checkout.settle();
    assert.equal(checkout.confirms.length, 1, "no POST");

    checkout.submit();
    await checkout.settle();
    assert.equal(checkout.square.tokenize.length, 1, "a submit during the confirm tokenized again");
    assert.equal(checkout.confirms.length, 1, "a submit during the confirm posted again");

    // The guard has let go, so the refusal above was not the page giving up.
    answered.resolve(await DECLINED());
    await checkout.settle();
    assert.equal(checkout.payable(), true, "a decline hands the button back");
    checkout.submit();
    await checkout.settle();
    assert.equal(checkout.square.tokenize.length, 2, "a submit after the decline did not retry");
    assert.equal(checkout.confirms.length, 2, "a submit after the decline did not retry");
    assert.equal(checkout.reloads, 1, "the paid retry did not reload");
  }
});

test("the countdown reads the page's expiry and ticks down", async (t) => {
  for (const { hold } of FIXTURES) {
    const left = hold.expiresAt - NOW;
    const checkout = await open(t, hold);
    assertTimeLeft(checkout, left, "at the start");

    const shown = checkout.countdown();
    await checkout.tick(SECOND_MS);
    assert.notEqual(checkout.countdown(), shown, "the countdown does not tick");
    assertTimeLeft(checkout, left - SECOND_MS, "after a second");

    await checkout.tick(90 * SECOND_MS);
    assertTimeLeft(checkout, left - 91 * SECOND_MS, "after a minute and a half");
  }
});

test("the countdown follows the clock through a sleeping tab", async (t) => {
  for (const { hold } of FIXTURES) {
    const left = hold.expiresAt - NOW;
    const checkout = await open(t, hold);
    await checkout.tick(2 * SECOND_MS);
    assertTimeLeft(checkout, left - 2 * SECOND_MS, "before the tab sleeps");

    // A timer slept through fires once on waking, so anything counting its own ticks is minutes out.
    const nap = Math.floor(left / 2);
    checkout.sleep(nap);
    await checkout.tick(SECOND_MS);
    assertTimeLeft(checkout, left - nap - 3 * SECOND_MS, "after the tab woke");

    await checkout.tick(2 * SECOND_MS);
    assertTimeLeft(checkout, left - nap - 5 * SECOND_MS, "ticking on after the tab woke");
  }
});

test("when the time runs out the page says so and cannot be paid", async (t) => {
  for (const fixture of FIXTURES) {
    const { hold, guest } = fixture;
    const left = hold.expiresAt - NOW;
    const runningOut: [string, (checkout: Checkout) => Promise<void>][] = [
      ["the countdown reaching zero", (checkout) => checkout.tick(left + SECOND_MS)],
      [
        "a tab waking past the expiry",
        async (checkout) => {
          checkout.sleep(left + 5 * MINUTE_MS);
          await checkout.tick(SECOND_MS);
        },
      ],
    ];
    for (const [label, runOut] of runningOut) {
      const checkout = await open(t, hold);
      checkout.fill(guest);
      assert.equal(ending(checkout), "", `${label}: speaks too soon`);

      await runOut(checkout);
      assert.notEqual(ending(checkout), "", `${label}: silent at the expiry`);
      assertNoStrayText(ending(checkout), label);
      assert.doesNotMatch(checkout.countdown(), /-\s*\d|NaN/, `${label}: the countdown went past zero`);
      await assertNoRetry(checkout, label);
      assert.deepEqual(checkout.square.tokenize, [], `${label}: tokenized`);
      assert.deepEqual(checkout.confirms, [], `${label}: posted`);
    }

    // What an earlier attempt said gives way, or a guest reads "declined" and keeps trying a hold that is gone.
    const declined = await attempt(t, fixture, [DECLINED]);
    const decline = ending(declined);
    await declined.tick(left + SECOND_MS);
    assert.notEqual(ending(declined), decline, "the page still reads as declined past the expiry");
    await assertNoRetry(declined, "a decline left standing at the expiry");

    // A click on waking can beat the first tick, and the clock already knows.
    const woken = await open(t, hold);
    woken.fill(guest);
    woken.sleep(left + MINUTE_MS);
    await woken.pay();
    assert.deepEqual(woken.square.tokenize, [], "a click on waking tokenized");
    assert.deepEqual(woken.confirms, [], "a click on waking posted");
    assert.notEqual(ending(woken), "", "a click on waking went unanswered");

    // The card comes up after the time has gone, and its mount must not bring the button back.
    const slow = await open(t, hold, { sdk: "waits" });
    await slow.tick(left + SECOND_MS);
    await slow.loadSdk();
    assert.equal(slow.payable(), false, "a card mounted past the expiry made the button live");
    assert.notEqual(ending(slow), "", "a card mounted past the expiry: silent");

    // The server rendered the hold a moment before it lapsed, and the guest's page came up a moment after.
    const stale = await open(t, hold, { now: hold.expiresAt + SECOND_MS });
    assert.equal(stale.payable(), false, "a page opened past the expiry can be paid");
    assert.notEqual(ending(stale), "", "a page opened past the expiry: silent");

    // A charge that set out in time and lands after is a paid booking, whatever the countdown says.
    const answered = Promise.withResolvers<Response>();
    const paid = await open(t, hold, { confirms: [() => answered.promise] });
    paid.fill(guest);
    await paid.tick(left - 5 * SECOND_MS);
    await paid.pay();
    assert.equal(paid.confirms.length, 1, "the payment set out in time");
    await paid.tick(6 * SECOND_MS);
    answered.resolve(await respond(200, { ok: true })());
    await paid.settle();
    assert.ok(paid.reloads > 0, "a charge that landed past the expiry left the guest on the hold page");
  }
});

test("past its expiry the hold cannot be paid", async (t) => {
  for (const { hold, guest } of FIXTURES) {
    const checkout = await open(t, hold);
    checkout.fill(guest);

    await checkout.tick(hold.expiresAt - NOW - 5 * SECOND_MS);
    assert.equal(checkout.reloads, 0, "the page gave up with time left");
    assert.equal(checkout.payable(), true, "the pay button stopped with five seconds left");

    await checkout.tick(6 * SECOND_MS);
    assert.doesNotMatch(checkout.countdown(), /-\s*\d|NaN/, `the countdown went past zero: ${checkout.countdown()}`);
    await assertNoRetry(checkout, "past the expiry");
    assert.deepEqual(checkout.square.tokenize, [], "tokenized past the expiry");
    assert.deepEqual(checkout.confirms, [], "posted past the expiry");

    // A payment that set out in time and came back declined after the expiry has nothing left to retry.
    const answered = Promise.withResolvers<Response>();
    const late = await open(t, hold, { confirms: [() => answered.promise] });
    late.fill(guest);
    await late.tick(hold.expiresAt - NOW - 5 * SECOND_MS);
    await late.pay();
    assert.equal(late.confirms.length, 1, "the payment set out in time");
    await late.tick(6 * SECOND_MS);
    answered.resolve(await respond(402, { ok: false, reason: "PAYMENT_DECLINED", message: "Declined" })());
    await late.settle();
    await assertNoRetry(late, "a decline past the expiry");
  }
});

/** Text that can only be this locale's, so one locale's sentences cannot stand in for another's. */
const script: Record<Locale, { must: RegExp; mustNot: RegExp }> = {
  ja: { must: /\p{Script=Hiragana}|\p{Script=Katakana}/u, mustNot: /\p{Script=Hangul}/u },
  en: { must: /[A-Za-z]{3}/, mustNot: /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  "zh-cn": { must: /\p{Script=Han}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u },
  ko: { must: /\p{Script=Hangul}/u, mustNot: /\p{Script=Hiragana}|\p{Script=Katakana}/u },
};

/** All the client says in `locale`, by what made it speak. Its strings are its own, so this is how they are reached. */
async function everythingSaidIn(t: TestContext, locale: Locale): Promise<Map<string, string>> {
  const hold = { ...FIRST.hold, locale };
  const fixture = { ...FIRST, hold };
  const said = new Map<string, string>();

  for (const [field, value, code] of FIELD_PROBLEMS) {
    const typed = await open(t, hold);
    typed.fill({ ...FIRST.guest, [field]: value });
    await typed.pay();
    said.set(`the client's own ${code}`, typed.fieldError(field));

    const answer = respond(400, { ok: false, reason: "INVALID_GUEST", fields: [code] });
    said.set(`the server's ${code}`, (await attempt(t, fixture, [answer])).fieldError(field));
  }

  const failed = await open(t, hold, { tokens: [{ status: "Error" }] });
  failed.fill(FIRST.guest);
  await failed.pay();
  said.set("a failed tokenize", failed.message());

  const answers = [
    ["an invalid guest with no fields", respond(400, { ok: false, reason: "INVALID_GUEST" })],
    ["a decline with no message", respond(402, { ok: false, reason: "PAYMENT_DECLINED" })],
    ["HOLD_EXPIRED", EXPIRED],
    ["IN_PROGRESS", IN_PROGRESS],
    ["PAYMENT_UNKNOWN", UNKNOWN],
  ] as const;
  for (const [label, reply] of answers) {
    const checkout = await attempt(t, fixture, [reply]);
    if (checkout.reloads === 0) said.set(label, checkout.message());
  }

  for (const [label, broken] of BROKEN_SDK) said.set(label, (await open(t, hold, broken)).message());

  const expired = await open(t, hold);
  await expired.tick(hold.expiresAt - NOW + SECOND_MS);
  if (expired.reloads === 0) said.set("the time running out", expired.message());

  return said;
}

test("the client speaks the page's locale", async (t) => {
  const english = await everythingSaidIn(t, "en");
  for (const locale of LOCALES) {
    const said = locale === "en" ? english : await everythingSaidIn(t, locale);
    assert.deepEqual([...said.keys()], [...english.keys()], `${locale} and en do not end the same ways`);
    for (const [label, words] of said) {
      assertNoStrayText(words, `${label} in ${locale}`);
      assert.match(words, script[locale].must, `${label} in ${locale}: ${JSON.stringify(words)}`);
      assert.doesNotMatch(words, script[locale].mustNot, `${label} in ${locale}: ${words}`);
      // No sentence of the client's reads the same in two of these languages, so none has an excuse to match the English.
      if (locale !== "en") assert.notEqual(words, english.get(label), `${label} in ${locale} is the English`);
    }
  }
});
