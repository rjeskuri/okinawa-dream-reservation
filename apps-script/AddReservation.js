// The Add a reservation panel: staff book a phone or walk-in guest who pays at the shop. The panel offers what a guest can
// book in the published catalog, and the Worker alone picks the bike, books it CONFIRMED with no Square payment and emails
// the guest. A form is the payload /api/staff/reservations reads, `{ id, modelId, packageId, date, time, locale, guest:
// { familyName, givenName, email, phone } }`, and its id is the Worker's idempotency key: one form keeps one id for every
// retry, so a retry after a timeout answers the booking the first try made instead of making a second. The guest's phone
// and email go only to the Worker, never into a sheet cell from here.
// Apps Script files share one global scope and have no modules. Helpers end in `_`, which keeps them off the Run list.

const RESERVATION_PANEL_TITLE_ = "Add a reservation";
const RESERVATION_LOCALES_ = ["ja", "en", "zh-cn", "ko"];
const RESERVATION_GUEST_NAMES_ = { familyName: "family name", givenName: "given name", email: "email", phone: "phone" };
/** INVALID_GUEST's codes, as GUEST_CODES in src/lib/checkout.ts names them: the guest field and what is wrong with it. */
const RESERVATION_GUEST_CODES_ = {
  FAMILY_NAME_EMPTY: { field: "familyName", problem: "the family name is blank" },
  GIVEN_NAME_EMPTY: { field: "givenName", problem: "the given name is blank" },
  EMAIL_MALFORMED: { field: "email", problem: "the email is not an address (leave it blank if the guest gave none)" },
  PHONE_NO_DIGITS: { field: "phone", problem: "the phone number has no digits" },
};
/** A sentence for each reason createStaffBooking answers besides INVALID_GUEST, the pickup-window ones included. */
const RESERVATION_REASONS_ = {
  SOLD_OUT: "Every bike of this model is booked or blocked for that pickup and return. Choose another time, date, package or model.",
  UNKNOWN_MODEL:
    "The website has no bookable model by that id, so the catalog may have changed. Close the panel and open Add a reservation again.",
  UNKNOWN_PACKAGE:
    "The website has no package by that id, so the catalog may have changed. Close the panel and open Add a reservation again.",
  NO_PRICE: "The website has no price for this model with this package. Choose another package, or add the price in Prices and Publish.",
  CONFLICT:
    "This form's id already belongs to a different booking, perhaps one an earlier try made before the form changed. Look for the guest on the Bookings tab, then close the panel and open Add a reservation again for a new form.",
  OUTSIDE_HOURS: "The pickup time is outside shop hours. Choose one of the listed times.",
  OFF_SLOT: "The pickup time is not one of the pickup slots. Choose one of the listed times.",
  CLOSED_PICKUP: "The shop is closed on the pickup date. Choose another date.",
  RETURN_OUTSIDE_HOURS: "From that pickup time the package comes back outside shop hours. Choose another time or package.",
  CLOSED_RETURN: "The shop is closed on the return date. Choose another date or package.",
  TOO_SOON: "That pickup slot has already ended. Choose a later time or date.",
  TOO_FAR: "That pickup date is further ahead than the website takes bookings. Choose an earlier date.",
};

function openAddReservation() {
  openPanel_("AddReservation", RESERVATION_PANEL_TITLE_);
}

/**
 * The published choices a guest can book: the active models with at least one active plate and a price, the packages
 * they are priced for, their prices, and the pickup slots and shop config. No plate: the Worker alone picks the bike.
 * Answers `{ ok: true, models, packages, prices, slots, config }` or `{ ok: false, message }`.
 */
function reservationPanelOptions() {
  const answer = staffPost_("/api/staff/catalog", {});
  if (!answer.ok) return answer;
  const catalog = answer.result;
  if (catalog.ok === false) {
    return { ok: false, message: "The catalog is not published yet. Press Publish first, then open Add a reservation again." };
  }
  const { models, packages, prices, slots, config } = catalog;
  if (![models, packages, prices, slots].every(Array.isArray)) {
    return { ok: false, message: "The website sent a catalog that could not be read." };
  }

  const bookable = new Set(
    models
      .filter((model) => model?.active === true && Array.isArray(model.plates))
      .filter((model) => model.plates.some((each) => each?.status === "active"))
      .map((model) => model.id),
  );
  const kept = prices.filter((price) => bookable.has(price?.modelId));
  const priced = new Set(kept.map((price) => price.modelId));
  const offered = new Set(kept.map((price) => price.packageId));
  return {
    ok: true,
    models: models
      .filter((model) => priced.has(model?.id))
      .map(({ id, nameJa, nameEn, typeId, depositJpy }) => ({ id, nameJa, nameEn, typeId, depositJpy })),
    packages: packages
      .filter((pkg) => offered.has(pkg?.id))
      .map(({ id, nameJa, nameEn, days, hours }) => ({ id, nameJa, nameEn, days, hours })),
    prices: kept.map(({ modelId, packageId, priceJpy, advancePriceJpy }) => ({ modelId, packageId, priceJpy, advancePriceJpy })),
    slots,
    config,
  };
}

/** A new form's id. The panel keeps it for every retry of that form, and asks again only for a new reservation. */
function reservationPanelNewId() {
  return Utilities.getUuid();
}

/**
 * Books the form with the Worker under the form's own id. A form whose shape cannot be sent is refused without calling;
 * everything past the shape is the Worker's. Answers `{ ok: true, booking }` with the booking as the Worker sent it, or
 * `{ ok: false, message }`, with the Worker's `reason` when it refused, and `fields` for INVALID_GUEST.
 */
function reservationPanelCreate(form) {
  const problem = reservationFormProblem_(form);
  if (problem !== "") return { ok: false, message: problem };

  const { id, modelId, packageId, date, time, locale, guest } = form;
  const { familyName, givenName, email, phone } = guest;
  const sent = staffPost_("/api/staff/reservations", {
    id,
    modelId,
    packageId,
    date,
    time,
    locale,
    guest: { familyName, givenName, email, phone },
  });
  if (!sent.ok) return sent;
  const answer = sent.result;
  if (answer.ok === true && answer.booking !== null && typeof answer.booking === "object") {
    return { ok: true, booking: answer.booking };
  }
  if (answer.ok === false && typeof answer.reason === "string") return reservationRefusal_(answer);
  return { ok: false, message: "The website sent an answer that could not be read, so the booking is not confirmed." };
}

/** Why the form cannot be sent, as a sentence for staff, or '' when it can. */
function reservationFormProblem_(form) {
  const again = "Close the panel and open Add a reservation again.";
  if (!reservationIsRecord_(form)) return `The form could not be read, so nothing was sent. ${again}`;
  if (typeof form.id !== "string" || form.id.trim() === "") return `The form has no id, so nothing was sent. ${again}`;
  if (!reservationIsDate_(form.date)) return "Pickup date: choose a date, written YYYY-MM-DD such as 2027-07-15.";
  if (typeof form.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)) {
    return "Pickup time: choose a time, written HH:mm such as 09:30.";
  }
  if (!RESERVATION_LOCALES_.includes(form.locale)) return "Language: choose Japanese, English, Chinese or Korean.";
  if (!reservationIsRecord_(form.guest)) return `The form has no guest, so nothing was sent. ${again}`;
  for (const [field, name] of Object.entries(RESERVATION_GUEST_NAMES_)) {
    if (typeof form.guest[field] !== "string") return `The guest's ${name} must be text, so nothing was sent.`;
  }
  return "";
}

function reservationIsRecord_(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A real calendar date written YYYY-MM-DD. */
function reservationIsDate_(value) {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (match === null) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The Worker's `{ ok: false, reason }` as a refusal staff can read. A reason this panel does not know still shows. */
function reservationRefusal_(answer) {
  const { reason } = answer;
  if (reason === "INVALID_GUEST") {
    const codes = Array.isArray(answer.fields) ? answer.fields : [];
    const known = codes.map((code) => reservationOwn_(RESERVATION_GUEST_CODES_, code));
    const fields = codes.map((code, i) => known[i]?.field ?? String(code));
    const problems = codes.map((code, i) => known[i]?.problem ?? `the website named ${String(code)}`);
    const what = problems.length > 0 ? `: ${problems.join("; ")}` : "";
    return {
      ok: false,
      reason,
      fields,
      message: `The website did not take the guest's details${what}. Fix them in the Guest step. Nothing was booked.`,
    };
  }
  const message =
    reservationOwn_(RESERVATION_REASONS_, reason) ??
    `The website did not book it, for a reason this panel does not know: ${reason}. Nothing was booked.`;
  return { ok: false, reason, message };
}

/** `table[key]` when the table has that key itself, so a code like `constructor` reads as unknown. */
function reservationOwn_(table, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
