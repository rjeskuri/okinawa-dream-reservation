// The hold page's card form: mounts Square's card, keeps the countdown, and turns a submit into a tokenize with verification
// details and a POST to the confirm endpoint. It reads the page through the seam set out at the top of
// tests/helpers/checkout-client.ts, and it logs nothing, so a guest's details stay in the form and those two calls.
import { checkoutClient } from "../i18n/strings/checkout.ts";
import { t } from "../i18n/t.ts";
import {
  buildVerificationDetails,
  confirmOutcome,
  GUEST_CODES,
  GUEST_FIELDS,
  timeLeftText,
  validateGuest,
} from "../lib/checkout.ts";
import type { ConfirmOutcome, Guest, GuestField, VerificationDetails } from "../lib/checkout.ts";
import type { Locale } from "../lib/locale.ts";

type Card = {
  attach(selector: string): Promise<void>;
  tokenize(details: VerificationDetails): Promise<{ status: string; token?: string }>;
};

type Payments = { card(): Promise<Card> };

type SquareSdk = { payments(applicationId: string, locationId: string): Payments | Promise<Payments> };

/** Only `ready` starts a payment. `over` is final: the hold has ended, or a charge may be out, or the page is reloading. */
type State = "loading" | "ready" | "paying" | "failed" | "over";

const TICK_MS = 1_000;

const form = document.getElementById("checkout") as HTMLFormElement;

// First of all, so that no submit can leave with the form whatever goes wrong below.
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void pay();
});

const button = document.getElementById("pay-button") as HTMLButtonElement;
const message = document.getElementById("checkout-message") as HTMLElement;
const countdown = document.getElementById("countdown") as HTMLElement;
const { bookingId, sdkUrl, applicationId, locationId } = form.dataset as Record<string, string>;
const locale = form.dataset.locale as Locale;
const depositJpy = Number(form.dataset.depositJpy);
const expiresAt = Number(form.dataset.expiresAt);

let state: State = "loading";
let card: Card | null = null;

const say = (key: string): string => t(locale, checkoutClient, `checkout.error.${key}`);

const input = (field: GuestField) => form.querySelector(`[name="${field}"]`) as HTMLInputElement;

const errorOf = (field: GuestField) => form.querySelector(`[data-error-for="${field}"]`) as HTMLElement;

function show(element: HTMLElement, text: string): void {
  element.textContent = text;
  element.hidden = text === "";
}

function clearWords(): void {
  show(message, "");
  for (const field of GUEST_FIELDS) show(errorOf(field), "");
}

/** Shows the error of each field that `codes` names, and says whether any did. */
function markFields(codes: readonly string[]): boolean {
  const bad = GUEST_FIELDS.filter((field) => codes.includes(GUEST_CODES[field]));
  for (const field of bad) show(errorOf(field), say(GUEST_CODES[field]));
  if (bad[0] !== undefined) input(bad[0]).focus();
  return bad.length > 0;
}

function endHold(): void {
  state = "over";
  button.disabled = true;
  clearWords();
  show(message, say("expired"));
}

/** Read from the clock each time, because a sleeping tab skips ticks and wakes with one. */
function tick(): void {
  const left = expiresAt - Date.now();
  countdown.textContent = timeLeftText(left);
  if (left > 0) return;
  clearInterval(timer);
  // A payment in flight may yet land, and its answer decides what the guest reads.
  if (state !== "paying" && state !== "over") endHold();
}

function handBack(): void {
  if (Date.now() >= expiresAt) return endHold();
  state = "ready";
  button.disabled = false;
}

/** Adds the SDK's script, and gives window.Square once it has loaded. */
function loadSdk(): Promise<SquareSdk> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = sdkUrl;
    script.addEventListener("load", () => {
      const { Square } = window as unknown as { Square?: SquareSdk };
      if (Square === undefined) reject(new Error("the SDK left no window.Square"));
      else resolve(Square);
    });
    script.addEventListener("error", () => reject(new Error("the SDK did not load")));
    document.head.appendChild(script);
  });
}

async function mountCard(): Promise<Card> {
  const square = await loadSdk();
  const payments = await square.payments(applicationId, locationId);
  const mounted = await payments.card();
  await mounted.attach("#card-container");
  return mounted;
}

/** The source id for one charge, or null if Square gave none. Only the status says a token is good to use. */
async function tokenize(from: Card, guest: Guest): Promise<string | null> {
  try {
    const { status, token } = await from.tokenize(buildVerificationDetails(depositJpy, guest));
    return status === "OK" && token ? token : null;
  } catch {
    return null;
  }
}

/** Whatever keeps a real answer from arriving may hide a charge that went through, so it reads as unknown. */
async function confirm(sourceId: string, guest: Guest): Promise<ConfirmOutcome> {
  try {
    const response = await fetch(`/api/holds/${bookingId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId, guest, locale }),
    });
    return confirmOutcome(response.status, await response.json().catch(() => null));
  } catch {
    return confirmOutcome(0, null);
  }
}

function act(outcome: ConfirmOutcome): void {
  if (outcome.kind === "declined") {
    show(message, outcome.message || say("declined"));
  } else if (outcome.kind === "invalid-guest") {
    if (!markFields(outcome.fields)) show(message, say("guest"));
  } else {
    state = "over";
    // The server knows how these two ended, so the page it renders next says so. Only it can tell a guest they have paid.
    if (outcome.kind === "ok" || outcome.kind === "expired") location.reload();
    else show(message, say(outcome.kind === "unknown" ? "unknown" : "inProgress"));
    return;
  }
  handBack();
}

async function pay(): Promise<void> {
  // The guard on a second charge: Enter in a field and requestSubmit reach here without asking the button.
  if (state !== "ready" || card === null) return;
  if (Date.now() >= expiresAt) return endHold();

  clearWords();
  const guest = Object.fromEntries(GUEST_FIELDS.map((field) => [field, input(field).value.trim()])) as Guest;
  if (markFields(validateGuest(guest))) return;

  state = "paying";
  button.disabled = true;
  const sourceId = await tokenize(card, guest);
  if (sourceId === null) {
    show(message, say("card"));
    return handBack();
  }
  act(await confirm(sourceId, guest));
}

const timer = setInterval(tick, TICK_MS);
tick();

mountCard().then(
  (mounted) => {
    card = mounted;
    if (state !== "loading") return;
    state = "ready";
    button.disabled = false;
  },
  () => {
    if (state !== "loading") return;
    state = "failed";
    show(message, say("form"));
  },
);
