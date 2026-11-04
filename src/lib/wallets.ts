// What Square's payments.paymentRequest() takes for Google Pay and Apple Pay (task #47), from a hold's deposit. Only the
// wallet code that src/scripts/checkout.ts loads with import() reads this, so a page with both wallets off carries none of it.
import { checkoutClient } from "../i18n/strings/checkout.ts";
import { t } from "../i18n/t.ts";
import type { Locale } from "./locale.ts";

export type PaymentRequestOptions = {
  countryCode: "JP";
  currencyCode: "JPY";
  total: { amount: string; label: string };
};

/**
 * The shop and its money are in Japan, and yen has no minor unit, so the total is the whole deposit as a string, as in
 * buildVerificationDetails. The label is the line the wallet's sheet shows, in the guest's language.
 */
export function buildPaymentRequest(depositJpy: number, locale: Locale): PaymentRequestOptions {
  return {
    countryCode: "JP",
    currencyCode: "JPY",
    total: { amount: String(depositJpy), label: t(locale, checkoutClient, "checkout.wallet.total") },
  };
}
