// POST /api/staff/cancel: the Dashboard's "Cancel a booking" panel quotes a cancellation, then confirms it with the refund
// staff chose. The body is the `{ ts, payload, sig }` envelope signed with PUBLISH_SECRET, which also authorizes refunds
// (owner decision 5), its payload `{ requestedBy, bookingId, confirm?: { choice, refundJpy } }`, and anything unsigned is a
// 401. A body past the limit is a 413, an empty or unset secret a 500 and a payload of the wrong shape a 400, each in plain
// words and before D1 or Square, as the panel shows staff the body as it stands. Without `confirm` it reads only and
// answers the quote. With it, cancelByStaff cancels and refunds `refundJpy` only if `choice` still gives that amount, and
// otherwise answers QUOTE_CHANGED with the fresh quote. The envelope has no nonce: a replay inside its window meets the
// cancel guard and answers ALREADY_CANCELLED.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  cancelByStaff,
  quoteStaffCancellation,
  type StaffCancellationQuote,
  type StaffRefundChoice,
} from "../../../lib/booking/cancel.ts";
import { staffGuestName } from "../../../lib/booking/staff-search.ts";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { readBody } from "../../../lib/request-body.ts";
import { drainSoon } from "../../../server/outbox.ts";
import { squareClient } from "../../../server/square.ts";

type CancelPayload = { requestedBy: string; bookingId: string; confirm?: { choice: string; refundJpy: number } };

type Quoted = Extract<StaffCancellationQuote, { ok: true }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a signed payload asks for, or null when it is not in the shape the panel sends. Only types are checked here: a
 * choice that is none of the three, or an amount that is not a whole number of yen, goes on to cancelByStaff, which
 * answers BAD_CHOICE before it reads anything.
 */
function parsePayload(payload: unknown): CancelPayload | null {
  if (!isObject(payload)) return null;
  const { requestedBy, bookingId, confirm } = payload;
  if (typeof requestedBy !== "string" || typeof bookingId !== "string" || bookingId === "") return null;
  if (confirm === undefined) return { requestedBy, bookingId };
  if (!isObject(confirm)) return null;
  const { choice, refundJpy } = confirm;
  if (typeof choice !== "string" || typeof refundJpy !== "number") return null;
  return { requestedBy, bookingId, confirm: { choice, refundJpy } };
}

/** A quote as the panel shows it: the booking in the fields staff need, and what each choice would refund. */
function quoteView({ booking, daysBefore, refundPercent, refundedJpy, amounts }: Quoted) {
  return {
    booking: {
      id: booking.id,
      ref: booking.ref,
      source: booking.source,
      status: booking.status,
      modelId: booking.modelId,
      plate: booking.vehiclePlate,
      startAt: booking.startAt,
      endAt: booking.endAt,
      guestName: staffGuestName(booking.guestFamilyName, booking.guestGivenName),
      guestEmail: booking.guestEmail,
      paidJpy: booking.paidJpy,
    },
    daysBefore,
    refundPercent,
    refundedJpy,
    amounts,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await readBody(request);
  if (body === null) return new Response("The request is too large.", { status: 413 });

  const now = Date.now();
  let verified: Awaited<ReturnType<typeof verifyEnvelope>>;
  try {
    verified = await verifyEnvelope(env.PUBLISH_SECRET, body, now);
  } catch {
    // WebCrypto refuses an empty key, so this is an empty or unset PUBLISH_SECRET, and no request can pass.
    return new Response("Publishing is not set up on the Worker, so no booking was quoted or cancelled.", {
      status: 500,
    });
  }
  if (!verified.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

  // The payload has passed its signature, but it can still be any JSON.
  const parsed = parsePayload(verified.payload);
  if (parsed === null) {
    return new Response("The cancellation is not in the shape the Worker reads, so no booking was quoted or cancelled.", {
      status: 400,
    });
  }
  const { requestedBy, bookingId, confirm } = parsed;

  if (confirm === undefined) {
    const quote = await quoteStaffCancellation(env.DB, bookingId, now);
    return Response.json(quote.ok ? { ok: true, quote: quoteView(quote) } : { ok: false, reason: quote.reason });
  }

  const { choice, refundJpy } = confirm;
  const deps = { db: env.DB, square: squareClient(env), now, staffEmail: env.STAFF_EMAIL, siteUrl: env.SITE_URL };
  let outcome = "an error";
  try {
    // cancelByStaff takes the choice as the caller sent it and answers BAD_CHOICE to anything but the three.
    const result = await cancelByStaff(deps, bookingId, { choice: choice as StaffRefundChoice, refundJpy, requestedBy });
    outcome = result.ok ? `cancelled, refund ${result.refundStatus}` : result.reason;
    if (result.ok) {
      // The cancellation's emails and Bookings row, committed with it, go out after this answer.
      drainSoon(locals.cfContext, env);
      return Response.json({ ok: true, choice: result.choice, refundJpy: result.refundJpy, refundStatus: result.refundStatus });
    }
    if (result.reason === "QUOTE_CHANGED" && result.quote?.ok) {
      return Response.json({ ok: false, reason: result.reason, quote: quoteView(result.quote) });
    }
    return Response.json({ ok: false, reason: result.reason });
  } finally {
    // The one record of who ordered a refund: cancelByStaff does not store requestedBy. Each value the payload sent is
    // quoted, so a line break in one cannot split the line.
    const who = `booking ${JSON.stringify(bookingId)} by ${JSON.stringify(requestedBy)}`;
    console.log(`Staff cancel of ${who}: ${JSON.stringify(choice)} refunding ${JSON.stringify(refundJpy)} JPY, ${outcome}`);
  }
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { Allow: "POST" } });
