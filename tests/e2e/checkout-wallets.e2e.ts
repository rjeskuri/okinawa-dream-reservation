// Google Pay and Apple Pay on the hold page (task #47), each behind its var, through the built Worker and the real client.
// ENABLE_GOOGLE_PAY and ENABLE_APPLE_PAY are strings, and only "true" turns a wallet on. Anything else, unset, "false",
// "TRUE" or "1", leaves it off, so a slip in the dashboard fails closed.
//
// The seam with src/scripts/checkout.ts is set out at the top of tests/helpers/checkout-client.ts:
//   #google-pay-button, the mount for googlePay.attach and what the guest clicks for Google Pay;
//   #apple-pay-button, what the guest clicks for Apple Pay;
// each on the hold page when its flag is on and on no page otherwise. The client starts a wallet when its mount is there:
// payments.paymentRequest() from data-deposit-jpy and data-locale, then payments.googlePay() or payments.applePay() with
// what that returned. A wallet's token goes to the card's confirm endpoint in the card's body.
//
// "Wallet code", of which a page with both flags off loads none:
// - in its markup: a wallet's mount, an <apple-pay-button> or <google-pay-button> element, or an attribute that names a
//   wallet's own script (pay.google.com, applepay.cdn-apple.com, apple-pay-sdk) or holds a payment request (countryCode);
// - in what it runs as it opens: its inline scripts, the built files its <script src> and modulepreload tags name, and what
//   those import statically. None of it may call the SDK's paymentRequest, googlePay or applePay, hold a payment request's
//   countryCode or name a wallet's script. Wallet code may sit in a chunk the client reaches with import(), when a mount is
//   on the page. Square's own SDK is the card's, and does not count;
// - when it runs: the client asks Square for no payment request and no wallet, and adds no script but the SDK's.
// With a flag on, the same detectors find that wallet: its mount, its call in the code the page can reach with import()
// included, and its start when the client runs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import {
  openCheckout,
  readHoldPage,
  readWallets,
  respond,
  tagsOutsideCode,
  WALLET_MOUNTS,
  WALLETS,
  type Checkout,
  type Guest,
  type OpenOptions,
  type Wallet,
} from "../helpers/checkout-client.ts";
import { mainOf, visibleText } from "../helpers/html.ts";
import {
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedPackage,
  seedPrice,
  seedRateClass,
  seedType,
  type BookingRow,
} from "../helpers/seed.ts";
import { startWorker, type TestWorker } from "../helpers/worker.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const SANDBOX_SDK = "https://sandbox.web.squarecdn.com/v1/square.js";

/** What the catalog says today, which a booking's own deposit must win over. */
const TYPE_DEPOSIT_JPY = 33_000;

/** How long a page with no wallet on is watched for one starting anyway, through an import() or a later turn. */
const LINGER_MS = 400;

const FLAG_VARS: Record<Wallet, string> = { googlePay: "ENABLE_GOOGLE_PAY", applePay: "ENABLE_APPLE_PAY" };

/** A wallet's name as a guest reads it, which a page with that wallet off has no reason to print. */
const WALLET_NAMES: Record<Wallet, RegExp> = { googlePay: /google\s*pay/i, applePay: /apple\s*pay/i };

/** The SDK call that starts each wallet, as it stands in built code. */
const WALLET_CALLS: Record<Wallet, RegExp> = { googlePay: /\.\s*googlePay\s*\(/, applePay: /\.\s*applePay\s*\(/ };

const WALLET_CODE =
  /\.\s*(?:paymentRequest|googlePay|applePay)\s*\(|\bcountryCode\b|pay\.google\.com|applepay\.cdn-apple\.com|apple-pay-sdk/i;

const WALLET_URLS = /pay\.google\.com|applepay\.cdn-apple\.com|apple-pay-sdk|countryCode/i;

/** Two stays that share no amount, with each deposit written out by hand as the wallet's total. */
type Stay = { priceJpy: number; depositJpy: number; amount: string };

const FIRST: Stay = { priceJpy: 21_900, depositJpy: 6_400, amount: "6400" };
const SECOND: Stay = { priceJpy: 48_300, depositJpy: 15_750, amount: "15750" };

type PublishedStay = Stay & { modelId: string; packageId: string };

type Shop = { worker: TestWorker; stays: [PublishedStay, PublishedStay] };

type Flags = Record<Wallet, string | undefined>;

type Page = { path: string; html: string };

function varsOf(flags: Flags): Record<string, string | undefined> {
  return { [FLAG_VARS.googlePay]: flags.googlePay, [FLAG_VARS.applePay]: flags.applePay };
}

function flagLabel(flags: Flags): string {
  return WALLETS.map((wallet) => `${FLAG_VARS[wallet]}=${JSON.stringify(flags[wallet]) ?? "unset"}`).join(" ");
}

/** A Worker with `flags`, a catalog and the two stays. */
async function openShop(flags: Flags): Promise<Shop> {
  const worker = await startWorker({ vars: varsOf(flags) });
  try {
    await seedType(worker.db, { deposit_jpy: TYPE_DEPOSIT_JPY });
    await seedConfig(worker.db);
    await seedCatalogMeta(worker.db);
    const publish = async (stay: Stay): Promise<PublishedStay> => {
      const rate = await seedRateClass(worker.db);
      const model = await seedModel(worker.db, { rate_class_id: rate.id });
      const pack = await seedPackage(worker.db);
      await seedPrice(worker.db, { rate_class_id: rate.id, package_id: pack.id, price_jpy: 91_000 });
      return { ...stay, modelId: model.id, packageId: pack.id };
    };
    return { worker, stays: [await publish(FIRST), await publish(SECOND)] };
  } catch (error) {
    await worker.stop();
    throw error;
  }
}

function book(shop: Shop, stay: PublishedStay, row: Partial<BookingRow>): Promise<BookingRow> {
  return seedBooking(shop.worker.db, {
    model_id: stay.modelId,
    package_id: stay.packageId,
    price_jpy: stay.priceJpy,
    deposit_jpy: stay.depositJpy,
    locale: "en",
    guest_family_name: null,
    guest_given_name: null,
    guest_email: null,
    guest_phone: null,
    ...row,
  });
}

function holdRow(): Partial<BookingRow> {
  return { status: "ON_HOLD", expires_at: Date.now() + 12 * MINUTE_MS };
}

/** Fetched with the real fetch and clock, so no checkout may be open. */
async function page(shop: Shop, locale: Locale, id: string): Promise<Page> {
  const path = `/${locale}/checkout/${id}`;
  const res = await shop.worker.fetch(path, { redirect: "manual" });
  const html = await res.text();
  assert.equal(res.status, 200, `${path}\n${html.slice(0, 400)}`);
  return { path, html };
}

/** Each page of a hold of each stay, in every locale. */
async function holdPages(shop: Shop): Promise<{ stay: PublishedStay; locale: Locale; view: Page }[]> {
  const pages = [];
  for (const stay of shop.stays) {
    const hold = await book(shop, stay, holdRow());
    for (const locale of LOCALES) pages.push({ stay, locale, view: await page(shop, locale, hold.id) });
  }
  return pages;
}

/** The markup of `html` that belongs to a wallet. */
function walletMarkup(html: string): string[] {
  return tagsOutsideCode(html).flatMap(({ name, attributes }) => {
    const found = /^(?:apple|google)-pay-button$/.test(name) ? [`<${name}>`] : [];
    for (const [attribute, value] of Object.entries(attributes)) {
      if (attribute === "id" && Object.values(WALLET_MOUNTS).includes(value)) found.push(`#${value}`);
      else if (WALLET_URLS.test(value)) found.push(`${attribute}="${value.slice(0, 80)}"`);
    }
    return found;
  });
}

/** A built file's static imports and re-exports, which are not import(). Paths are relative or from the site's root. */
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["']((?:\.\.?\/|\/(?!\/))[^"']+\.js)["']/g;
/** Any path to a built file, import() included. */
const ANY_IMPORT = /["']((?:\.\.?\/|\/(?!\/))[^"']+\.js)["']/g;

const BUILT_CLIENT = new URL("../../dist/client/", import.meta.url);

/** A path in a built file, or on the page when `from` is the client's root. */
function builtFile(path: string, from: URL): URL {
  return path.startsWith("/") ? new URL(path.slice(1), BUILT_CLIENT) : new URL(path, from);
}

/**
 * The page's client code: its inline scripts and the built files its script and modulepreload tags name, with what those
 * import. "opens" follows static imports only, which is what runs as the page opens; "reachable" follows import() too.
 */
function clientCode(html: string, reach: "opens" | "reachable"): string {
  const read = new Map<string, string>();
  const load = (url: URL): void => {
    // A path that names no built file, such as one in a string of the SDK's, is no code of the page's.
    if (read.has(url.href) || !existsSync(url)) return;
    const code = readFileSync(url, "utf8");
    read.set(url.href, code);
    for (const [, file] of code.matchAll(reach === "opens" ? STATIC_IMPORT : ANY_IMPORT))
      load(builtFile(file as string, url));
  };
  for (const { name, attributes } of tagsOutsideCode(html)) {
    const preload = name === "link" && /\bmodulepreload\b/i.test(attributes.rel ?? "");
    const file = name === "script" ? attributes.src : preload ? attributes.href : undefined;
    if (file?.startsWith("/")) load(builtFile(file, BUILT_CLIENT));
  }
  const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(([, code]) => code);
  return [...inline, ...read.values()].join("\n");
}

function assertNoWalletCode({ html, path }: Page, label: string): void {
  assert.deepEqual(walletMarkup(html), [], `${path} ${label}: wallet markup`);
  const found = clientCode(html, "opens").match(WALLET_CODE);
  assert.equal(found, null, `${path} ${label}: the page loads wallet code as it opens: ${found?.[0]}`);
}

/** The page as the flags leave it, by the same detectors whether a wallet is on or off. */
function assertWalletsOnPage(view: Page, on: Wallet[], label: string): void {
  const { html, path } = view;
  const mounts = readWallets(html, path);
  const markup = walletMarkup(html);
  const text = visibleText(mainOf(html, path));
  for (const wallet of WALLETS) {
    const want = on.includes(wallet);
    assert.equal(mounts[wallet], want, `${path} ${label}: #${WALLET_MOUNTS[wallet]} ${want ? "missing" : "rendered"}`);
    assert.equal(markup.includes(`#${WALLET_MOUNTS[wallet]}`), want, `${path} ${label}: ${markup.join(", ")}`);
    if (want) {
      assert.match(
        clientCode(html, "reachable"),
        WALLET_CALLS[wallet],
        `${path} ${label}: no client code starts ${wallet}`,
      );
    } else {
      assert.doesNotMatch(text, WALLET_NAMES[wallet], `${path} ${label}: ${wallet} is named with its flag off`);
    }
  }
  if (on.length === 0) assertNoWalletCode(view, label);
}

function walletCalls(checkout: Checkout): number {
  const { paymentRequest, googlePay, applePay } = checkout.square;
  return paymentRequest.length + googlePay.length + applePay.length;
}

/** Until each wallet in `on` has started, or a while with none started when `on` is empty. */
async function startWallets(checkout: Checkout, on: Wallet[]): Promise<void> {
  const { square } = checkout;
  if (on.length === 0) {
    await checkout.waitFor(() => walletCalls(checkout) > 0, LINGER_MS);
    return;
  }
  const started = (wallet: Wallet): boolean =>
    square[wallet].length > 0 && (wallet !== "googlePay" || square.googlePayAttach.length > 0);
  await checkout.waitFor(() => on.every(started));
}

/** The element a googlePay.attach target names on the page. */
function attachedTo(checkout: Checkout, target: unknown): string | undefined {
  const element = typeof target === "string" ? checkout.document.querySelector(target) : target;
  return (element as { id?: string } | null)?.id;
}

/** Runs the real client on `view` and checks which wallets it starts, with what request, and that the card is as before. */
async function assertClientWallets(t: TestContext, view: Page, stay: Stay, on: Wallet[], label: string): Promise<void> {
  const where = `${view.path} ${label}`;
  const checkout = await openCheckout(t, view.html, { now: Date.now() });
  await startWallets(checkout, on);
  const { square } = checkout;

  assert.deepEqual(checkout.sdkRequests, [SANDBOX_SDK], `${where}: scripts the client added`);
  for (const wallet of WALLETS) {
    const want = on.includes(wallet);
    assert.equal(square[wallet].length > 0, want, `${where}: ${wallet} ${want ? "never started" : "started"}`);
  }
  if (on.length === 0) assert.deepEqual(square.paymentRequest, [], `${where}: a payment request with no wallet on`);

  for (const request of square.paymentRequest) {
    const { countryCode, currencyCode, total } = request as {
      countryCode?: unknown;
      currencyCode?: unknown;
      total?: { amount?: unknown; label?: unknown };
    };
    assert.equal(countryCode, "JP", `${where}: ${JSON.stringify(request)}`);
    assert.equal(currencyCode, "JPY", `${where}: ${JSON.stringify(request)}`);
    assert.equal(total?.amount, stay.amount, `${where}: the wallet's total is not the deposit ${stay.depositJpy}`);
    const label = total?.label;
    assert.ok(typeof label === "string" && label.trim() !== "", `${where}: the total has no label`);
  }
  for (const wallet of on) {
    for (const request of square[wallet]) {
      assert.ok(square.requests.includes(request as object), `${where}: ${wallet} got no request from paymentRequest`);
    }
    assert.equal(checkout.wallet(wallet).shown(), true, `${where}: ${wallet} started and does not show`);
  }
  if (on.includes("googlePay")) {
    const targets = square.googlePayAttach.map((target) => attachedTo(checkout, target));
    assert.deepEqual([...new Set(targets)], [WALLET_MOUNTS.googlePay], `${where}: Google Pay attached to ${targets}`);
  }

  // The card form is as it was.
  assert.deepEqual(square.attach, ["#card-container"], `${where}: the card mount`);
  assert.equal(checkout.payable(), true, `${where}: the card cannot pay`);
  assert.equal(checkout.message(), "", `${where}: the client spoke: ${checkout.message()}`);
  checkout.close();
}

test("flags control the wallet buttons", async (t) => {
  // Every combination of on and off, then the strings a dashboard may hold that are not "true", which are off too. Unset
  // and "TRUE" stand next to an "on", so a client reading one flag for both, or any value but "false", shows.
  const combos: Flags[] = [
    { googlePay: "false", applePay: "false" },
    { googlePay: "true", applePay: "false" },
    { googlePay: undefined, applePay: "true" },
    { googlePay: "true", applePay: "true" },
    { googlePay: "true", applePay: "TRUE" },
    { googlePay: "TRUE", applePay: " true" },
    { googlePay: "1", applePay: "on" },
  ];
  for (const flags of combos) {
    const label = flagLabel(flags);
    const on = WALLETS.filter((wallet) => flags[wallet] === "true");
    const shop = await openShop(flags);
    try {
      const pages = await holdPages(shop);
      for (const { stay, view } of pages) {
        assertWalletsOnPage(view, on, label);
        // The card's seam stays as it was, the deposit included.
        assert.equal(readHoldPage(view.html, view.path).depositJpy, stay.depositJpy, `${view.path} ${label}`);
      }

      // The real client on one page of each stay, so the two deposits meet the same code.
      const [first, second] = shop.stays;
      const runs = [
        pages.find(({ stay, locale }) => stay === first && locale === "ja"),
        pages.find(({ stay, locale }) => stay === second && locale === "en"),
      ];
      for (const run of runs) {
        assert.ok(run !== undefined);
        await assertClientWallets(t, run.view, run.stay, on, label);
      }

      // Nothing is left to pay once a hold has moved on, so no other state has a wallet.
      const now = Date.now();
      const later: Partial<BookingRow>[] = [
        {
          status: "CONFIRMED",
          expires_at: now - DAY_MS,
          payment_id: "square-payment-id",
          paid_jpy: first.depositJpy,
          confirmed_at: now - DAY_MS,
        },
        { status: "PAYMENT_PENDING", expires_at: now - MINUTE_MS, payment_attempt: 1 },
        { status: "EXPIRED", expires_at: now - MINUTE_MS },
        { status: "ON_HOLD", expires_at: now - MINUTE_MS },
      ];
      for (const row of later) {
        const booking = await book(shop, first, row);
        for (const locale of LOCALES) {
          const view = await page(shop, locale, booking.id);
          assertNoWalletCode(view, `${label} ${row.status} expires ${row.expires_at}`);
        }
      }
    } finally {
      await shop.worker.stop();
    }
  }
});

test("a wallet's token is confirmed as a card's is", async (t) => {
  const shop = await openShop({ googlePay: "true", applePay: "true" });
  try {
    const cases: { stay: PublishedStay; locale: Locale; wallet: Wallet; guest: Guest }[] = [
      {
        // zh-cn is the locale whose <html lang> is spelled otherwise, and the confirm contract wants the site's spelling.
        stay: shop.stays[0],
        locale: "zh-cn",
        wallet: "googlePay",
        guest: { familyName: "李", givenName: "娜", email: "na.li@example.cn", phone: "+86 138 0013 8000" },
      },
      {
        stay: shop.stays[1],
        locale: "ja",
        wallet: "applePay",
        guest: { familyName: "山田", givenName: "花子", email: "hanako@example.jp", phone: "090-1234-5678" },
      },
    ];
    for (const { stay, locale, wallet, guest } of cases) {
      const other: Wallet = wallet === "googlePay" ? "applePay" : "googlePay";
      const hold = await book(shop, stay, holdRow());
      const { html, path } = await page(shop, locale, hold.id);
      const token = `cnon:${wallet}-${hold.id}`;
      const retry = `cnon:${wallet}-again-${hold.id}`;
      const declined = `Declined ${stay.depositJpy}`;
      let answer: (() => void) | undefined;
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });

      const checkout = await openCheckout(t, html, {
        now: Date.now(),
        walletTokens: { [wallet]: [{ status: "Cancel" }, token, retry] },
        confirms: [
          respond(402, { ok: false, reason: "PAYMENT_DECLINED", message: declined }),
          async () => {
            await answered;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        ],
      });
      await startWallets(checkout, [...WALLETS]);
      const pay = checkout.wallet(wallet);
      assert.equal(pay.shown(), true, `${path}: ${wallet} does not show`);

      // A guest the server would refuse goes no further than with a card.
      checkout.fill({ ...guest, email: "hanako@" });
      await pay.pay();
      assert.notEqual(checkout.fieldError("email"), "", `${path}: no error on the email`);
      assert.deepEqual(checkout.square.walletTokenize[wallet], [], `${path}: ${wallet} tokenized for a bad guest`);
      assert.deepEqual(checkout.confirms, [], `${path}: posted a bad guest`);

      // The guest closes the wallet's sheet: nothing is posted, and every way to pay is still there.
      checkout.fill({
        familyName: ` ${guest.familyName} `,
        givenName: `　${guest.givenName}　`,
        email: `  ${guest.email}`,
        phone: `${guest.phone}\t`,
      });
      await pay.pay();
      assert.equal(checkout.square.walletTokenize[wallet].length, 1, `${path}: ${wallet} was not tokenized`);
      assert.deepEqual(checkout.confirms, [], `${path}: posted a cancelled ${wallet}`);
      assert.equal(pay.shown(), true, `${path}: ${wallet} is gone after a cancel`);
      assert.equal(checkout.payable(), true, `${path}: the card cannot pay after a cancel`);

      // The token goes where a card's does, in the same body with the trimmed guest, and the answer reads the same.
      await pay.pay();
      const confirm = (sourceId: string) => ({
        method: "POST",
        path: `/api/holds/${hold.id}/confirm`,
        contentType: "application/json",
        body: { sourceId, guest, locale },
      });
      assert.deepEqual(checkout.confirms, [confirm(token)], path);
      assert.ok(checkout.message().includes(declined), `${path}: the decline does not show`);
      assert.equal(checkout.payable(), true, `${path}: the card cannot pay after a decline`);
      assert.equal(pay.shown(), true, `${path}: ${wallet} is gone after a decline`);

      // One payment at a time, whichever way it started.
      await pay.pay();
      assert.deepEqual(checkout.confirms, [confirm(token), confirm(retry)], path);
      pay.click();
      checkout.wallet(other).click();
      checkout.click();
      checkout.submit();
      await checkout.settle();
      assert.equal(checkout.square.walletTokenize[wallet].length, 3, `${path}: ${wallet} tokenized during a payment`);
      assert.deepEqual(checkout.square.walletTokenize[other], [], `${path}: ${other} tokenized during a payment`);
      assert.deepEqual(checkout.square.tokenize, [], `${path}: the card was tokenized`);
      assert.equal(checkout.confirms.length, 2, `${path}: a second charge was posted`);

      answer?.();
      await checkout.settle();
      assert.equal(checkout.reloads, 1, `${path}: a paid hold does not reload as it does after a card`);
      checkout.close();
    }
  } finally {
    await shop.worker.stop();
  }
});

test("a wallet that cannot start leaves the card form as it was", async (t) => {
  const shop = await openShop({ googlePay: "true", applePay: "true" });
  const refused = () => Promise.reject(new Error("not supported here"));
  try {
    const cases: { stay: PublishedStay; locale: Locale; fails: Wallet[]; options: Omit<OpenOptions, "now"> }[] = [
      // As in any browser but Safari, and in Safari off the domain registered with Square.
      { stay: shop.stays[0], locale: "en", fails: ["applePay"], options: { wallets: { applePay: refused } } },
      { stay: shop.stays[1], locale: "ko", fails: ["googlePay"], options: { wallets: { googlePay: refused } } },
      {
        stay: shop.stays[0],
        locale: "ja",
        fails: ["googlePay", "applePay"],
        options: { googlePayAttach: refused, wallets: { applePay: refused } },
      },
    ];
    for (const { stay, locale, fails, options } of cases) {
      const hold = await book(shop, stay, holdRow());
      const { html, path } = await page(shop, locale, hold.id);
      const guest: Guest = {
        familyName: "Higa",
        givenName: "Mei",
        email: `mei.${hold.id}@example.jp`,
        phone: "098-111-2222",
      };
      const token = `cnon:card-${hold.id}`;
      const checkout = await openCheckout(t, html, { ...options, now: Date.now(), tokens: [token] });
      // Google Pay gets as far as its attach unless payments.googlePay() itself is refused.
      const attaches = options.wallets?.googlePay === undefined;
      const { square } = checkout;
      await checkout.waitFor(
        () =>
          square.googlePay.length > 0 && square.applePay.length > 0 && (!attaches || square.googlePayAttach.length > 0),
      );
      const label = `${path} with ${fails.join(" and ")} failing`;

      for (const wallet of WALLETS) {
        assert.ok(checkout.square[wallet].length > 0, `${label}: ${wallet} was never asked for`);
        const works = !fails.includes(wallet);
        assert.equal(
          checkout.wallet(wallet).shown(),
          works,
          `${label}: ${wallet} ${works ? "does not show" : "shows"}`,
        );
      }
      assert.equal(checkout.message(), "", `${label}: the client spoke: ${checkout.message()}`);
      assert.equal(checkout.payable(), true, `${label}: the card cannot pay`);

      checkout.fill(guest);
      await checkout.pay();
      assert.equal(checkout.square.tokenize.length, 1, `${label}: the card was not tokenized`);
      assert.deepEqual(
        checkout.confirms.map(({ path: posted, body }) => ({ posted, body })),
        [{ posted: `/api/holds/${hold.id}/confirm`, body: { sourceId: token, guest, locale } }],
        label,
      );
      checkout.close();
    }
  } finally {
    await shop.worker.stop();
  }
});
