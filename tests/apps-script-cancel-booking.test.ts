// The Cancel a booking panel (apps-script/CancelBooking.js and CancelBookingPanel.html) run in node:vm against the fake
// Google services. The fake Worker answers in the shapes of the real /api/staff/bookings and /api/staff/cancel (#148):
// `{ ok: true, bookings }`, `{ ok: true, quote }`, `{ ok: true, choice, refundJpy, refundStatus }`, `{ ok: false, reason }`
// and QUOTE_CHANGED with the fresh quote. Signatures go through the Worker's real verifyEnvelope at the script's fixed
// clock, and the HTML is read from apps-script/ here. Node cannot run the panel's own script, so the HTML is held to the
// Dashboard's rules by scanning it, and the choice-to-payload path in the browser is checked by hand (task 19). Messages
// are free text: tests look for facts in them (a status code, the absence of a stack trace), not for sentences.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { verifyEnvelope } from "../src/lib/crypto.ts";
import { type AppsScriptWorld, loadAppsScript, type Options, type Reply, type Route, type WebState } from "./helpers/apps-script.ts";

const SCRIPT_DIR = new URL("../apps-script/", import.meta.url);

const BASE_URL = "https://reservation-one.example.dev";
const SECRET = "publish-secret-one";
const USER = "staff@okinawa-dream.example";
const PROPERTIES = { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: SECRET };

const SEARCH = "/api/staff/bookings";
const CANCEL = "/api/staff/cancel";

// As in apps-script-publish.test.ts.
const STACK_TRACE = /\n\s+at\s|\.js:\d+|(Type|Reference|Syntax|Range)Error|Cannot read|\bundefined\b|\[object Object\]/;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The instant of a JST wall clock written "YYYY-MM-DD HH:mm". */
function jst(wall: string): number {
  return Date.parse(`${wall.replace(" ", "T")}:00+09:00`);
}

// Two clocks far apart, so a default worked out from a fixed date cannot pass both.
const NOW = jst("2026-11-23 12:00");
const LATER = jst("2027-03-02 08:45");

// Values cross out of the script's realm with another Object prototype, which deepEqual refuses. A copy is plain.
const plain = (value: unknown): any => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const clock = (now: number): WebState => ({ now, quota: 100, sent: [], sendCalls: 0, sendFailures: [], cache: new Map() });

type World = Omit<Options, "routes" | "web"> & { now?: number; routes?: Record<string, Route> };

function world({ now = NOW, routes = {}, ...rest }: World = {}): AppsScriptWorld {
  return loadAppsScript({ properties: PROPERTIES, user: USER, ...rest, web: clock(now), routes });
}

function call(script: AppsScriptWorld, fn: string, ...args: unknown[]): any {
  assert.ok(script.isFunction(fn), `${fn} is a global function`);
  return plain(script.call(fn, ...args));
}

/** The payloads sent to `path`, each verified with the shared secret at the script's clock. */
async function signedPayloads(script: AppsScriptWorld, path: string, now: number): Promise<unknown[]> {
  const payloads: unknown[] = [];
  for (const fetched of script.fetches.filter((each) => each.path === path)) {
    assert.equal(fetched.url, `${BASE_URL}${path}`, "sent to the Worker");
    assert.equal(String(fetched.method).toLowerCase(), "post");
    const verified = await verifyEnvelope(SECRET, String(fetched.payload), now);
    assert.ok(verified.ok, `${path}: ${JSON.stringify(verified)}`);
    payloads.push(verified.payload);
  }
  return payloads;
}

function paths(script: AppsScriptWorld): string[] {
  return script.fetches.map(({ path }) => path);
}

function assertReadable(text: unknown, what: string): void {
  assert.equal(typeof text, "string", `${what}: a message`);
  assert.notEqual(String(text).trim(), "", `${what}: a message`);
  assert.doesNotMatch(String(text), STACK_TRACE, `${what}: ${String(text)}`);
  assert.ok(!String(text).includes(SECRET), `${what}: the secret stays out of what staff see`);
}

/** A refusal made before any call is a throw or `{ ok: false, message }`. Either way it names a reason, not a stack trace. */
function refusal(script: AppsScriptWorld, fn: string, args: unknown[], what: string): string {
  // Outside the try, so a missing function is a failure here and never counts as a refusal.
  assert.ok(script.isFunction(fn), `${fn} is a global function`);
  let answer: unknown;
  try {
    answer = script.call(fn, ...args);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    assertReadable(message, `${what}: thrown`);
    return message;
  }
  const { ok, message } = (plain(answer) ?? {}) as { ok?: unknown; message?: unknown };
  assert.equal(ok, false, `${what}: ${JSON.stringify(answer)}`);
  assertReadable(message, what);
  return String(message);
}

function withoutComments(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function panelFile(name: string): string {
  const text = readFileSync(new URL(name, SCRIPT_DIR), "utf8");
  assert.notEqual(text.trim(), "", `${name} has content`);
  return text;
}

// ---- The Worker's answers, in the shapes of src/pages/api/staff/bookings.ts and cancel.ts ----

type Summary = {
  id: string;
  ref: string;
  status: string;
  source: string;
  modelId: string;
  modelNameJa: string;
  packageId: string | null;
  packageNameJa: string | null;
  plate: string;
  startAt: number;
  endAt: number;
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  priceJpy: number | null;
  depositJpy: number | null;
  paidJpy: number;
};

const HIGA: Summary = {
  id: "bk_01JD7K2MQ9XA",
  ref: "7K2MQ9XA",
  status: "CONFIRMED",
  source: "web",
  modelId: "pcx-125",
  modelNameJa: "PCX",
  packageId: "day",
  packageNameJa: "1日",
  plate: "わ1001",
  startAt: jst("2026-11-25 09:00"),
  endAt: jst("2026-11-26 18:00"),
  guestName: "比嘉 太郎",
  guestEmail: "taro@example.jp",
  guestPhone: "+81 90-1111-2222",
  priceJpy: 9000,
  depositJpy: 3000,
  paidJpy: 3000,
};

const SMITH: Summary = {
  ...HIGA,
  id: "bk_01JDP3Y2F7BV",
  ref: "P3Y2F7BV",
  modelId: "forza-250",
  modelNameJa: "フォルツァ",
  packageId: null,
  packageNameJa: null,
  plate: "沖縄 あ 35-80",
  startAt: jst("2027-07-15 10:30"),
  endAt: jst("2027-07-18 17:00"),
  guestName: "Smith Jane",
  guestEmail: "jane@example.com",
  guestPhone: null,
  priceJpy: 24000,
  depositJpy: 5000,
  paidJpy: 5000,
};

// Booked by staff and paid at the shop: nothing paid online.
const AT_SHOP: Summary = {
  ...HIGA,
  id: "bk_01JDB3TZ8VWN",
  ref: "B3TZ8VWN",
  source: "staff",
  modelId: "jimny",
  modelNameJa: "ジムニー",
  plate: "わ3003",
  startAt: jst("2026-12-01 09:00"),
  endAt: jst("2026-12-03 18:00"),
  guestName: "ﾋｶﾞ",
  guestEmail: null,
  priceJpy: null,
  depositJpy: null,
  paidJpy: 0,
};

type Amounts = { tier: number; full: number; none: number };

type Quote = {
  booking: {
    id: string;
    ref: string;
    source: string;
    status: string;
    modelId: string;
    plate: string;
    startAt: number;
    endAt: number;
    guestName: string;
    guestEmail: string | null;
    paidJpy: number;
  };
  daysBefore: number;
  refundPercent: number;
  refundedJpy: number;
  amounts: Amounts;
};

/** The quote view the endpoint answers for a booking, priced as given. */
function quoteOf(
  summary: Summary,
  priced: { daysBefore: number; refundPercent: number; refundedJpy: number; amounts: Amounts },
  startAt: number = summary.startAt,
): Quote {
  const { id, ref, source, status, modelId, plate, endAt, guestName, guestEmail, paidJpy } = summary;
  return {
    booking: { id, ref, source, status, modelId, plate, startAt, endAt, guestName, guestEmail, paidJpy },
    ...priced,
  };
}

/** Each booking answered carries every field the Worker sent, in the Worker's order. Added fields are the script's. */
function assertBookings(answered: unknown, sent: Summary[], what: string): void {
  assert.ok(Array.isArray(answered), `${what}: bookings is a list: ${JSON.stringify(answered)}`);
  assert.equal(answered.length, sent.length, `${what}: every booking the Worker found`);
  sent.forEach((booking, i) => assert.partialDeepStrictEqual(answered[i], booking, `${what}: booking ${i}`));
}

function assertQuote(answered: unknown, sent: Quote, what: string): void {
  assert.ok(answered !== null && typeof answered === "object", `${what}: a quote: ${JSON.stringify(answered)}`);
  assert.partialDeepStrictEqual(answered, sent, what);
  assert.deepEqual((answered as Quote).amounts, sent.amounts, `${what}: the three amounts as the Worker gave them`);
}

// ---- The dialog ----

test("Cancel a booking is a dashboard action that opens the CancelBooking dialog", () => {
  const script = world();
  const actions = plain(script.evaluate("DASHBOARD_ACTIONS_")) as { label: string; fn: string }[];
  assert.deepEqual(
    actions.filter(({ fn, label }) => fn === "openCancelBooking" || label === "Cancel a booking"),
    [{ label: "Cancel a booking", fn: "openCancelBooking" }],
    `one Cancel a booking action: ${JSON.stringify(actions)}`,
  );

  script.call("onOpen");
  const items = script.menus.flatMap((menu) => menu.items);
  assert.ok(
    items.some((item) => Array.isArray(item) && item[0] === "Cancel a booking" && item[1] === "openCancelBooking"),
    `the menu lists Cancel a booking: ${JSON.stringify(items)}`,
  );
  const home = plain(script.call("dashboardHome")) as { actions: { label: string; fn: string }[] };
  assert.ok(
    home.actions.some(({ label, fn }) => label === "Cancel a booking" && fn === "openCancelBooking"),
    `the home lists Cancel a booking: ${JSON.stringify(home.actions)}`,
  );

  const opened = world();
  opened.call("openCancelBooking");
  assert.equal(opened.shown.length, 1, "one dialog");
  const [shown] = opened.shown;
  assert.equal(shown.kind, "modal");
  assert.equal(shown.title, "Cancel a booking");
  assert.equal(shown.width, 720);
  assert.equal(shown.height, 640);
  const shell = panelFile("PanelShell.html");
  const at = shown.html.indexOf(shell);
  assert.ok(at >= 0, "the dialog holds PanelShell.html");
  assert.ok(shown.html.indexOf(panelFile("CancelBookingPanel.html"), at + shell.length) >= 0, "then CancelBookingPanel.html");
  assert.deepEqual(opened.fetches, [], "opening the dialog sends nothing");
});

test("the panel shows data with textContent only and calls only the public cancel functions", () => {
  const code = withoutComments(panelFile("CancelBookingPanel.html"));
  const script = world();

  // No markup from data: the Dashboard's scan, on this panel.
  const MARKUP_WRITES = /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\s*\.\s*write|<\?/;
  const line = code.split("\n").find((text) => MARKUP_WRITES.test(text));
  assert.equal(line, undefined, `CancelBookingPanel.html writes markup: ${line?.trim()}`);

  // Every server call goes through the shell's callServer, so the scan below sees all of them.
  assert.doesNotMatch(code, /google\s*\.\s*script\s*\.\s*run/, "CancelBookingPanel.html calls the server through callServer only");
  const called = Array.from(code.matchAll(/\bcallServer\s*\(\s*(["'`])([^"'`]*)\1/g), (match) => match[2]);
  for (const fn of ["cancelPanelSearch", "cancelPanelQuote", "cancelPanelConfirm"]) {
    assert.ok(called.includes(fn), `CancelBookingPanel.html calls ${fn}: ${JSON.stringify(called)}`);
  }
  for (const fn of called) {
    assert.ok(!fn.endsWith("_"), `google.script.run cannot call the private ${fn}`);
    assert.ok(script.isFunction(fn), `callServer('${fn}') names a global function`);
  }
});

// ---- Search ----

test("search sends the text and date signed to /api/staff/bookings and answers the bookings", async () => {
  const cases: { label: string; user: string; text: string; date: string; bookings: Summary[] }[] = [
    { label: "a ref alone", user: USER, text: "7K2MQ9XA", date: "", bookings: [HIGA] },
    { label: "a name and a date", user: "manager@example.jp", text: "比嘉", date: "2026-11-25", bookings: [HIGA, AT_SHOP] },
    { label: "a date alone", user: USER, text: "", date: "2027-07-15", bookings: [SMITH] },
    { label: "half-width katakana, three found", user: "desk@example.jp", text: "ﾋｶﾞ 太郎", date: "2028-02-29", bookings: [AT_SHOP, HIGA, SMITH] },
    { label: "nothing found", user: USER, text: "nobody", date: "2026-12-31", bookings: [] },
  ];
  for (const { label, user, text, date, bookings } of cases) {
    const script = world({ user, routes: { [SEARCH]: { body: { ok: true, bookings } } } });
    const answer = call(script, "cancelPanelSearch", { text, date });

    assert.equal(answer?.ok, true, `${label}: ${JSON.stringify(answer)}`);
    assertBookings(answer.bookings, bookings, label);

    assert.deepEqual(paths(script), [SEARCH], `${label}: one search request`);
    const [payload] = (await signedPayloads(script, SEARCH, NOW)) as Record<string, unknown>[];
    assert.equal(payload.requestedBy, user, `${label}: requestedBy is the signed-in user`);
    // A blank filter may be sent blank, null or not at all: the Worker leaves it off either way.
    for (const [name, given] of [
      ["text", text],
      ["date", date],
    ] as const) {
      if (given === "") assert.ok([undefined, null, ""].includes(payload[name] as never), `${label}: ${name} is blank`);
      else assert.equal(payload[name], given, `${label}: ${name} is sent as typed`);
    }
    assert.deepEqual(
      Object.keys(payload).filter((name) => !["requestedBy", "text", "date"].includes(name)),
      [],
      `${label}: nothing else in the payload: ${JSON.stringify(payload)}`,
    );
  }
});

// ---- Quote ----

test("a quote asks /api/staff/cancel without a confirm", async () => {
  const cases: { label: string; user: string; summary: Summary; quote: Quote }[] = [
    {
      label: "ten days ahead, the whole deposit back",
      user: USER,
      summary: SMITH,
      quote: quoteOf(SMITH, { daysBefore: 10, refundPercent: 100, refundedJpy: 0, amounts: { tier: 5000, full: 5000, none: 0 } }),
    },
    {
      label: "two days ahead with an earlier refund",
      user: "manager@example.jp",
      summary: HIGA,
      quote: quoteOf(HIGA, { daysBefore: 2, refundPercent: 50, refundedJpy: 500, amounts: { tier: 1000, full: 2500, none: 0 } }),
    },
    {
      label: "paid at the shop, nothing to refund",
      user: USER,
      summary: AT_SHOP,
      quote: quoteOf(AT_SHOP, { daysBefore: 8, refundPercent: 100, refundedJpy: 0, amounts: { tier: 0, full: 0, none: 0 } }),
    },
  ];
  for (const { label, user, summary, quote } of cases) {
    const script = world({ user, routes: { [CANCEL]: { body: { ok: true, quote } } } });
    const answer = call(script, "cancelPanelQuote", summary.id);

    assert.equal(answer?.ok, true, `${label}: ${JSON.stringify(answer)}`);
    assertQuote(answer.quote, quote, label);

    assert.deepEqual(paths(script), [CANCEL], `${label}: one request`);
    assert.deepEqual(
      await signedPayloads(script, CANCEL, NOW),
      [{ bookingId: summary.id, requestedBy: user }],
      `${label}: the booking id and requestedBy, and no confirm`,
    );
  }
});

test("a booking whose pickup has passed starts on no refund, with every choice still offered", () => {
  // The Worker's staff quote clamps daysBefore at 0, so a pickup a minute away and one a minute gone are priced alike:
  // only the pickup time against the clock tells them apart.
  const offsets: { label: string; fromNow: number; started: boolean }[] = [
    { label: "ten days ahead", fromNow: 10 * DAY_MS, started: false },
    { label: "a minute ahead", fromNow: MINUTE_MS, started: false },
    { label: "a minute ago", fromNow: -MINUTE_MS, started: true },
    { label: "two days ago, a no-show", fromNow: -2 * DAY_MS, started: true },
  ];
  for (const now of [NOW, LATER]) {
    for (const { label, fromNow, started } of offsets) {
      const what = `${new Date(now).toISOString()}, ${label}`;
      const startAt = now + fromNow;
      const priced = started || fromNow < DAY_MS
        ? { daysBefore: 0, refundPercent: 0, refundedJpy: 0, amounts: { tier: 0, full: 3000, none: 0 } }
        : { daysBefore: 10, refundPercent: 100, refundedJpy: 0, amounts: { tier: 3000, full: 3000, none: 0 } };
      const quote = quoteOf(HIGA, priced, startAt);
      const script = world({ now, routes: { [CANCEL]: { body: { ok: true, quote } } } });
      const answer = call(script, "cancelPanelQuote", HIGA.id);

      assert.equal(answer?.ok, true, `${what}: ${JSON.stringify(answer)}`);
      assertQuote(answer.quote, quote, what);
      assert.equal(answer.defaultChoice, started ? "none" : "tier", `${what}: the choice the panel starts on`);
    }
  }
});

// ---- Confirm ----

type Confirm = { bookingId: string; choice: string; refundJpy: number };

test("confirm sends the choice and the amount staff saw and answers the refund status", async () => {
  const cases: (Confirm & { label: string; user: string; refundStatus: string })[] = [
    { label: "the tier refund", user: USER, bookingId: HIGA.id, choice: "tier", refundJpy: 1500, refundStatus: "PENDING" },
    { label: "a full refund", user: "manager@example.jp", bookingId: SMITH.id, choice: "full", refundJpy: 5000, refundStatus: "COMPLETED" },
    { label: "no refund", user: USER, bookingId: SMITH.id, choice: "none", refundJpy: 0, refundStatus: "NONE" },
    { label: "a tier that gives nothing", user: USER, bookingId: HIGA.id, choice: "tier", refundJpy: 0, refundStatus: "NONE" },
    { label: "a full refund Square will retry", user: "desk@example.jp", bookingId: HIGA.id, choice: "full", refundJpy: 2500, refundStatus: "RETRY" },
    { label: "a refund Square rejected", user: USER, bookingId: SMITH.id, choice: "tier", refundJpy: 1350, refundStatus: "REJECTED" },
    { label: "paid at the shop", user: USER, bookingId: AT_SHOP.id, choice: "full", refundJpy: 0, refundStatus: "NONE" },
  ];
  for (const { label, user, bookingId, choice, refundJpy, refundStatus } of cases) {
    const script = world({ user, routes: { [CANCEL]: { body: { ok: true, choice, refundJpy, refundStatus } } } });
    const answer = call(script, "cancelPanelConfirm", { bookingId, choice, refundJpy });

    assert.equal(answer?.ok, true, `${label}: ${JSON.stringify(answer)}`);
    assert.equal(answer.refundStatus, refundStatus, `${label}: the refund status`);
    assert.equal(answer.refundJpy, refundJpy, `${label}: the amount refunded`);

    assert.deepEqual(paths(script), [CANCEL], `${label}: one request, no quote before it`);
    const sent = (await signedPayloads(script, CANCEL, NOW)) as Record<string, unknown>[];
    assert.deepStrictEqual(sent, [{ bookingId, confirm: { choice, refundJpy }, requestedBy: user }], label);
    assert.deepStrictEqual(sent[0].confirm, { choice, refundJpy }, `${label}: exactly the choice and amount given`);
  }

  // What else the panel hands over stays out: requestedBy is the signed-in user's, and a confirm of its own is ignored.
  const script = world({ routes: { [CANCEL]: { body: { ok: true, choice: "full", refundJpy: 5000, refundStatus: "PENDING" } } } });
  const answer = call(script, "cancelPanelConfirm", {
    bookingId: SMITH.id,
    choice: "full",
    refundJpy: 5000,
    requestedBy: "someone-else@example.com",
    confirm: { choice: "none", refundJpy: 0 },
    note: "guest called",
  });
  assert.equal(answer?.ok, true, JSON.stringify(answer));
  assert.deepStrictEqual(await signedPayloads(script, CANCEL, NOW), [
    { bookingId: SMITH.id, confirm: { choice: "full", refundJpy: 5000 }, requestedBy: USER },
  ]);
});

test("confirm refuses an unknown choice, a bad amount or a blank id without calling the Worker", () => {
  const good: Confirm = { bookingId: HIGA.id, choice: "tier", refundJpy: 1500 };
  const answered: Reply = { body: { ok: true, choice: "tier", refundJpy: 1500, refundStatus: "PENDING" } };

  const badChoices: unknown[] = [
    "TIER",
    "Full",
    "tier ",
    " none",
    "",
    "partial",
    "refund",
    "toString",
    "constructor",
    "__proto__",
    undefined,
    null,
    0,
    true,
    ["tier"],
    { choice: "tier" },
  ];
  const badAmounts: unknown[] = [-1, -1500, 0.5, 1500.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1500", "", null, undefined, true, false, [1500], {}];
  const blankIds: unknown[] = ["", " ", "   ", "\t\n", "　", undefined, null];

  const inputs: { label: string; args: unknown[] }[] = [
    ...badChoices.map((choice) => ({ label: `choice ${JSON.stringify(choice) ?? "undefined"}`, args: [{ ...good, choice }] })),
    // Each choice with each bad amount, so a check made for one choice alone is caught.
    ...["tier", "full", "none"].flatMap((choice) =>
      badAmounts.map((refundJpy) => ({
        label: `${choice} with refundJpy ${String(refundJpy)} (${typeof refundJpy})`,
        args: [{ ...good, choice, refundJpy }],
      })),
    ),
    ...blankIds.map((bookingId) => ({ label: `bookingId ${JSON.stringify(bookingId) ?? "undefined"}`, args: [{ ...good, bookingId }] })),
    { label: "no bookingId at all", args: [{ choice: "tier", refundJpy: 1500 }] },
    { label: "a null input", args: [null] },
    { label: "no input", args: [] },
  ];
  for (const { label, args } of inputs) {
    const script = world({ routes: { [CANCEL]: answered, [SEARCH]: { body: { ok: true, bookings: [] } } } });
    refusal(script, "cancelPanelConfirm", args, label);
    assert.deepEqual(script.fetches, [], `${label}: no request at all`);
  }

  // The same call with every value in place does go out, so the refusals above are about the values.
  for (const choice of ["tier", "full", "none"]) {
    const script = world({ routes: { [CANCEL]: answered } });
    const answer = call(script, "cancelPanelConfirm", { ...good, choice, refundJpy: choice === "none" ? 0 : 1500 });
    assert.equal(answer?.ok, true, `${choice}: ${JSON.stringify(answer)}`);
    assert.deepEqual(paths(script), [CANCEL], choice);
  }
});

test("QUOTE_CHANGED comes back with the fresh quote", async () => {
  const cases: { label: string; sent: Confirm; fresh: Quote }[] = [
    {
      label: "the tier fell a band at midnight",
      sent: { bookingId: SMITH.id, choice: "tier", refundJpy: 5000 },
      fresh: quoteOf(SMITH, { daysBefore: 6, refundPercent: 50, refundedJpy: 0, amounts: { tier: 2500, full: 5000, none: 0 } }),
    },
    {
      label: "a refund landed meanwhile",
      sent: { bookingId: HIGA.id, choice: "full", refundJpy: 3000 },
      fresh: quoteOf(HIGA, { daysBefore: 2, refundPercent: 50, refundedJpy: 700, amounts: { tier: 800, full: 2300, none: 0 } }),
    },
    {
      label: "the tiers were republished",
      sent: { bookingId: HIGA.id, choice: "tier", refundJpy: 0 },
      fresh: quoteOf(HIGA, { daysBefore: 2, refundPercent: 90, refundedJpy: 0, amounts: { tier: 2700, full: 3000, none: 0 } }),
    },
  ];
  for (const { label, sent, fresh } of cases) {
    const script = world({ routes: { [CANCEL]: { body: { ok: false, reason: "QUOTE_CHANGED", quote: fresh } } } });
    const answer = call(script, "cancelPanelConfirm", sent);

    assert.equal(answer?.ok, false, `${label}: ${JSON.stringify(answer)}`);
    assert.equal(answer.reason, "QUOTE_CHANGED", label);
    assertQuote(answer.quote, fresh, `${label}: the fresh quote`);
    assertReadable(answer.message, `${label}: why the panel went back to the choices`);

    // Staff confirm the new amounts themselves: nothing is sent again on their behalf.
    assert.deepEqual(paths(script), [CANCEL], `${label}: one request`);
    assert.deepStrictEqual(
      await signedPayloads(script, CANCEL, NOW),
      [{ bookingId: sent.bookingId, confirm: { choice: sent.choice, refundJpy: sent.refundJpy }, requestedBy: USER }],
      label,
    );
  }
});

// ---- Failures ----

test("Worker failures come back as readable messages, not stack traces", () => {
  type Failure = { label: string; properties?: Record<string, string>; reply: Reply; status?: number; reason?: string };
  const transport: Failure[] = [
    { label: "no Script Properties", properties: {}, reply: { body: { ok: true, bookings: [] } } },
    { label: "a thrown fetch", reply: { throws: "Address unavailable: reservation-one.example.dev" } },
    { label: "a 401", reply: { status: 401, body: { error: "unauthorized" } }, status: 401 },
    {
      label: "a 400 in words",
      reply: { status: 400, body: "The cancellation is not in the shape the Worker reads, so no booking was quoted or cancelled." },
      status: 400,
    },
    { label: "a 413", reply: { status: 413, body: "The request is too large." }, status: 413 },
    {
      label: "a 500 in words",
      reply: { status: 500, body: "Publishing is not set up on the Worker, so no booking was quoted or cancelled." },
      status: 500,
    },
    { label: "a 502 page", reply: { status: 502, body: "<html>Bad gateway</html>" }, status: 502 },
    { label: "a 200 that is not JSON", reply: { body: "<html><body>Error 1101</body></html>" } },
    { label: "a refusal with no reason", reply: { body: { ok: false } } },
  ];
  const refusedFor = (reasons: string[]): Failure[] =>
    reasons.map((reason) => ({ label: `the Worker's ${reason}`, reply: { body: { ok: false, reason } }, reason }));

  const quoteReasons = ["NOT_FOUND", "NOT_CANCELLABLE", "ALREADY_CANCELLED"];
  const confirmReasons = ["BAD_CHOICE", "NOT_FOUND", "NOT_CANCELLABLE", "ALREADY_CANCELLED"];
  const panels: { fn: string; path: string; args: unknown[]; failures: Failure[]; reasons: string[] }[] = [
    {
      fn: "cancelPanelSearch",
      path: SEARCH,
      args: [{ text: "比嘉", date: "2026-11-25" }],
      failures: [...transport, ...refusedFor(["BAD_QUERY"])],
      reasons: [],
    },
    {
      fn: "cancelPanelQuote",
      path: CANCEL,
      args: [HIGA.id],
      failures: [...transport, ...refusedFor([...quoteReasons, "SOMETHING_NEW"])],
      reasons: quoteReasons,
    },
    {
      fn: "cancelPanelConfirm",
      path: CANCEL,
      args: [{ bookingId: HIGA.id, choice: "full", refundJpy: 3000 }],
      failures: [...transport, ...refusedFor([...confirmReasons, "SOMETHING_NEW"])],
      reasons: confirmReasons,
    },
  ];

  for (const { fn, path, args, failures, reasons } of panels) {
    const messages = new Map<string, string>();
    for (const failure of failures) {
      const what = `${fn}, ${failure.label}`;
      const script = world({ properties: failure.properties ?? PROPERTIES, routes: { [path]: failure.reply } });
      assert.ok(script.isFunction(fn), `${fn} is a global function`);
      let answer: any;
      assert.doesNotThrow(() => {
        answer = plain(script.call(fn, ...args));
      }, what);

      assert.equal(answer?.ok, false, `${what}: ${JSON.stringify(answer)}`);
      assertReadable(answer.message, what);
      const message = String(answer.message);

      if (failure.properties !== undefined) {
        assert.deepEqual(script.fetches, [], `${what}: nothing is sent`);
      } else {
        // No retry: a confirm that failed is never sent twice on its own.
        assert.deepEqual(paths(script), [path], `${what}: one request`);
      }
      if (failure.status !== undefined) {
        assert.match(message, new RegExp(`(?<!\\d)${failure.status}(?!\\d)`), `${what}: shows the status: ${message}`);
      }
      if (failure.reason !== undefined) {
        if (fn !== "cancelPanelSearch") assert.equal(answer.reason, failure.reason, `${what}: the Worker's reason`);
        assert.notEqual(message.trim(), failure.reason, `${what}: a sentence for staff, not the code`);
        messages.set(failure.reason, message);
      }
    }
    // Each refusal staff can meet says its own thing.
    const said = reasons.map((reason) => messages.get(reason));
    assert.equal(new Set(said).size, reasons.length, `${fn}: one message per reason: ${JSON.stringify(said)}`);
  }
});
