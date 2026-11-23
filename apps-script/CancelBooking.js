// The Cancel a booking panel: staff find a booking by ref, guest name or pickup date, see what each refund choice gives
// back, and cancel it with the one they pick. The Worker cancels, refunds through Square, emails the guest and updates
// the Bookings tab (/api/staff/cancel); this file signs the requests and puts each answer in words for staff. Answers
// are flat: `{ ok: true, ... }`, or `{ ok: false, message }` with the Worker's `reason` when it gave one.
// Apps Script files share one global scope and have no modules. Helpers end in `_`, which keeps them off the Run list.

const CANCEL_PANEL_TITLE_ = "Cancel a booking";
const CANCEL_PATH_ = "/api/staff/cancel";
const CANCEL_CHOICES_ = ["tier", "full", "none"];

/** A sentence for each refusal of /api/staff/cancel, so staff read what happened rather than a code. */
const CANCEL_REASONS_ = {
  NOT_FOUND: "The website has no booking with this id. Search again and pick it from the list.",
  NOT_CANCELLABLE:
    "The website cannot cancel this booking: it is not a confirmed booking made on the website. Nothing was changed.",
  ALREADY_CANCELLED: "This booking is already cancelled, so nothing more was done. Search again to see where it stands.",
  BAD_CHOICE: "The website did not accept that refund choice or amount. Nothing was cancelled: choose the refund again.",
  QUOTE_CHANGED:
    "The refund amounts changed since the quote, so nothing was cancelled. Check the new amounts, choose again and confirm.",
};

function openCancelBooking() {
  openPanel_("CancelBooking", CANCEL_PANEL_TITLE_);
}

/**
 * The bookings staff can cancel that match `text` (a ref or part of a guest name) and `date` (a pickup date in Japan,
 * YYYY-MM-DD); either may be blank. Each booking is as the Worker sent it, with `pickupJst` added for the list.
 * Answers `{ ok: true, bookings }` or `{ ok: false, message }`.
 */
function cancelPanelSearch(input) {
  const { text, date } = input ?? {};
  const sent = staffPost_("/api/staff/bookings", { text: cancelString_(text), date: cancelString_(date) });
  if (!sent.ok) return { ok: false, message: sent.message };
  const answer = sent.result;
  if (answer.ok !== true) {
    const message =
      answer.reason === "BAD_QUERY"
        ? "Search for a ref or a name of at most 100 characters, and a real date. Nothing was searched."
        : cancelReasonText_(answer.reason);
    return { ok: false, message };
  }
  if (!Array.isArray(answer.bookings) || !answer.bookings.every(cancelIsObject_)) {
    return { ok: false, message: "The website sent bookings that could not be read." };
  }
  return { ok: true, bookings: answer.bookings.map(cancelWithPickup_) };
}

/**
 * What cancelling the booking would refund for each choice, without cancelling it. `defaultChoice` is the choice the
 * panel starts on: no refund once the pickup has passed (a no-show), the tier refund before it.
 * Answers `{ ok: true, quote, defaultChoice }` or `{ ok: false, reason?, message }`.
 */
function cancelPanelQuote(bookingId) {
  if (!cancelIsId_(bookingId)) return { ok: false, message: "Pick a booking from the list first." };
  const sent = staffPost_(CANCEL_PATH_, { bookingId });
  if (!sent.ok) return { ok: false, message: sent.message };
  const answer = sent.result;
  if (answer.ok !== true) return cancelRefusal_(answer);
  if (!cancelIsQuote_(answer.quote)) return { ok: false, message: "The website sent a quote that could not be read." };
  const defaultChoice = Date.now() >= answer.quote.booking.startAt ? "none" : "tier";
  return { ok: true, quote: cancelQuoteView_(answer.quote), defaultChoice };
}

/**
 * Cancels the booking with exactly the `choice` and `refundJpy` staff confirmed, which the Worker takes only while the
 * choice still gives that amount. A bad choice, amount or id is refused here, before anything is sent. Answers
 * `{ ok: true, choice, refundJpy, refundStatus, message }`, or `{ ok: false, reason?, message }`, which for QUOTE_CHANGED
 * carries the fresh `quote`. Nothing is sent again on staff's behalf: they confirm the new amounts themselves.
 */
function cancelPanelConfirm(input) {
  const { bookingId, choice, refundJpy } = input ?? {};
  if (!cancelIsId_(bookingId)) return { ok: false, message: "Pick a booking from the list first. Nothing was cancelled." };
  if (typeof choice !== "string" || !CANCEL_CHOICES_.includes(choice)) {
    return { ok: false, message: "Choose the tier refund, a full refund or no refund. Nothing was cancelled." };
  }
  if (!Number.isSafeInteger(refundJpy) || refundJpy < 0) {
    return { ok: false, message: "The refund must be a whole number of yen, 0 or more. Nothing was cancelled." };
  }

  const sent = staffPost_(CANCEL_PATH_, { bookingId, confirm: { choice, refundJpy } });
  if (!sent.ok) return { ok: false, message: sent.message };
  const answer = sent.result;
  if (answer.ok !== true) {
    const refusal = cancelRefusal_(answer);
    if (refusal.reason !== "QUOTE_CHANGED") return refusal;
    if (!cancelIsQuote_(answer.quote)) {
      refusal.message =
        "The refund amounts changed since the quote, so nothing was cancelled. " +
        "The new amounts could not be read: pick the booking from the list again.";
      return refusal;
    }
    return { ...refusal, quote: cancelQuoteView_(answer.quote) };
  }
  return {
    ok: true,
    choice: answer.choice,
    refundJpy: answer.refundJpy,
    refundStatus: answer.refundStatus,
    message: cancelResultText_(answer.refundStatus, answer.refundJpy),
  };
}

/** `{ ok: false, reason, message }` for a refusal the Worker answered, with no `reason` when it gave none. */
function cancelRefusal_(answer) {
  const refusal = { ok: false, message: cancelReasonText_(answer.reason) };
  if (typeof answer.reason === "string" && answer.reason !== "") refusal.reason = answer.reason;
  return refusal;
}

function cancelReasonText_(reason) {
  if (typeof reason !== "string" || reason === "") {
    return "The website refused the request without saying why. Check the booking on the Bookings tab before trying again.";
  }
  if (Object.prototype.hasOwnProperty.call(CANCEL_REASONS_, reason)) return CANCEL_REASONS_[reason];
  return `The website refused the request with the code ${reason}. Check the booking on the Bookings tab before trying again.`;
}

/** The refund status of a cancellation that went through, in words. */
function cancelResultText_(refundStatus, refundJpy) {
  const amount = Number.isSafeInteger(refundJpy) ? cancelYen_(refundJpy) : "the refund";
  switch (refundStatus) {
    case "NONE":
      return "The booking is cancelled. No refund goes back through Square.";
    case "PENDING":
      return `The booking is cancelled. Square accepted the refund of ${amount} and is completing it.`;
    case "COMPLETED":
      return `The booking is cancelled. Square has refunded ${amount}.`;
    case "RETRY":
      return `The booking is cancelled. Square has not taken the refund of ${amount} yet: the website sends it again on its own.`;
    case "REJECTED":
      return (
        `The booking is cancelled, but Square rejected the refund of ${amount}. ` +
        "The shop is emailed an alert: settle it with the guest in Square."
      );
    default:
      return "The booking is cancelled. The website did not say how the refund went: check the booking on the Bookings tab.";
  }
}

/** A quote the panel can show: the booking with a finite pickup, and each choice a whole number of yen, 0 or more. */
function cancelIsQuote_(quote) {
  if (!cancelIsObject_(quote) || !cancelIsObject_(quote.booking) || !cancelIsObject_(quote.amounts)) return false;
  if (!Number.isFinite(quote.booking.startAt)) return false;
  return CANCEL_CHOICES_.every((choice) => Number.isSafeInteger(quote.amounts[choice]) && quote.amounts[choice] >= 0);
}

function cancelQuoteView_(quote) {
  return { ...quote, booking: cancelWithPickup_(quote.booking) };
}

/** The booking with its pickup as `YYYY-MM-DD HH:mm` in Japan, or '' when the Worker sent no time. */
function cancelWithPickup_(booking) {
  const pickupJst = Number.isFinite(booking.startAt)
    ? Utilities.formatDate(new Date(booking.startAt), JST_, "yyyy-MM-dd HH:mm")
    : "";
  return { ...booking, pickupJst };
}

function cancelYen_(amount) {
  return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} JPY`;
}

function cancelIsId_(value) {
  return typeof value === "string" && value.trim() !== "";
}

function cancelIsObject_(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancelString_(value) {
  return typeof value === "string" ? value : "";
}
