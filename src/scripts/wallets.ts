// Google Pay and Apple Pay on the hold page (task #47). src/scripts/checkout.ts loads this with import() only when a
// wallet's mount is on the page, so a page with both flags off carries none of it. A module runs once per page, so this one
// reads nothing at its top level and touches only the mounts it is handed.
import type { Locale } from "../lib/locale.ts";
import { buildPaymentRequest, type PaymentRequestOptions } from "../lib/wallets.ts";

/** What a wallet's tokenize() answers: "OK" with a token, "Cancel" when the guest closed its sheet, or another status. */
export type WalletResult = { status: string; token?: string };

export type Wallet = { tokenize(): Promise<WalletResult> };

export type WalletPayments = {
  paymentRequest(options: PaymentRequestOptions): object;
  googlePay(request: object): Promise<Wallet & { attach(target: string): Promise<void> }>;
  applePay(request: object): Promise<Wallet>;
};

export type WalletMounts = { googlePay: HTMLElement | null; applePay: HTMLElement | null };

/** A click on a started wallet's mount is a payment with it. Prevented, so a button drawn in the form cannot submit it. */
function listen(mount: HTMLElement, wallet: Wallet, pay: (wallet: Wallet) => void): void {
  mount.addEventListener("click", (event) => {
    event.preventDefault();
    pay(wallet);
  });
}

/** Square draws Google's button into the mount, which shows from just before that so the button can size itself. */
async function startGooglePay(payments: WalletPayments, mount: HTMLElement, request: object, pay: (wallet: Wallet) => void) {
  const wallet = await payments.googlePay(request);
  mount.hidden = false;
  await wallet.attach(`#${mount.id}`);
  listen(mount, wallet, pay);
}

/** Square's Apple Pay has no attach: the page draws the button, which shows once Apple Pay has started. */
async function startApplePay(payments: WalletPayments, mount: HTMLElement, request: object, pay: (wallet: Wallet) => void) {
  const wallet = await payments.applePay(request);
  listen(mount, wallet, pay);
  mount.hidden = false;
}

/**
 * Starts the wallet of each mount there is, each with its own payment request for the deposit, and hands a click on a
 * started one to `pay`. A wallet that cannot start, as Apple Pay outside Safari or off the domain registered with Square,
 * stays hidden and the guest hears nothing of it, since the card form is still there.
 */
export async function startWallets(
  payments: WalletPayments,
  mounts: WalletMounts,
  depositJpy: number,
  locale: Locale,
  pay: (wallet: Wallet) => void,
): Promise<void> {
  const request = (): object => payments.paymentRequest(buildPaymentRequest(depositJpy, locale));
  const quietly = async (mount: HTMLElement, start: () => Promise<void>): Promise<void> => {
    try {
      await start();
    } catch {
      mount.hidden = true;
    }
  };
  const { googlePay, applePay } = mounts;
  await Promise.all([
    googlePay && quietly(googlePay, () => startGooglePay(payments, googlePay, request(), pay)),
    applePay && quietly(applePay, () => startApplePay(payments, applePay, request(), pay)),
  ]);
}
