// buildPaymentRequest (task #47): what Square's payments.paymentRequest() takes for Google Pay and Apple Pay, from a hold's
// deposit. The shop and its money are in Japan, and yen has no minor unit, so the total is the whole deposit as a string of
// digits, with no separator, decimals or sign. The label is the line the wallet's sheet shows, and its wording is free.
// Expected values are literals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCALES } from "../src/lib/locale.ts";
import { buildPaymentRequest } from "../src/lib/wallets.ts";

/** Each deposit with its amount written out by hand. */
const DEPOSITS: [depositJpy: number, amount: string][] = [
  [1, "1"],
  [500, "500"],
  [1_000, "1000"],
  [4_800, "4800"],
  [9_999, "9999"],
  [21_350, "21350"],
  [100_000, "100000"],
  [1_234_567, "1234567"],
];

test("payment request matches the deposit in JPY", () => {
  // Every request is made before any is read, so one that shares an object with the next shows here.
  const made = LOCALES.flatMap((locale) =>
    DEPOSITS.map(([depositJpy, amount]) => ({
      locale,
      depositJpy,
      amount,
      request: buildPaymentRequest(depositJpy, locale),
    })),
  );
  for (const { locale, depositJpy, amount, request } of made) {
    const label = `${locale}, a deposit of ${depositJpy}`;
    const text = request?.total?.label;
    assert.equal(typeof text, "string", `${label}: the total has no label`);
    assert.notEqual(text.trim(), "", `${label}: the total's label is empty`);
    assert.doesNotMatch(text, /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|\{\w+\}/, `${label}: ${text}`);
    assert.deepEqual(
      request,
      { countryCode: "JP", currencyCode: "JPY", total: { amount, label: text } },
      `${label}: ${JSON.stringify(request)}`,
    );
  }
});
