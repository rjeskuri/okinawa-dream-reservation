// POST /api/staff/reservations: the sheet's "Add a reservation" panel books a phone or walk-in guest, paid at the shop. The
// body is the `{ ts, payload, sig }` envelope signed with PUBLISH_SECRET, and anything unsigned is a 401. A body past the
// limit is a 413, an empty or unset secret a 500 and a payload of the wrong shape a 400, each before anything is written,
// in plain words because the panel shows staff a failure's body as it stands. The payload's `id` is the panel's
// idempotency key, so a replay of the envelope, which stands for five minutes, answers the same booking. Everything past
// the shape is createStaffBooking's: the answer is the booking, or `{ ok: false, reason }` with `fields` for INVALID_GUEST.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { pickupInstant } from "../../../lib/booking/pickup-window.ts";
import { createStaffBooking, type StaffBookingInput } from "../../../lib/booking/staff-booking.ts";
import type { Guest } from "../../../lib/checkout.ts";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { isLocale } from "../../../lib/locale.ts";
import { readBody } from "../../../lib/request-body.ts";
import { drainSoon } from "../../../server/outbox.ts";

/** As holds.ts keys its ids: the panel sends a UUID, and anything longer is not one. */
const MAX_ID_LENGTH = 200;

type Reservation = Omit<StaffBookingInput, "startAt"> & { date: string; time: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isGuest(x: unknown): x is Guest {
  if (!isRecord(x)) return false;
  const { familyName, givenName, email, phone } = x;
  return (
    typeof familyName === "string" && typeof givenName === "string" && typeof email === "string" && typeof phone === "string"
  );
}

/**
 * The reservation the payload asks for, or null when it is not in the shape the panel sends. Blank strings pass: blank
 * guest fields are createStaffBooking's INVALID_GUEST, and a date or time that is no real one is pickupInstant's NaN.
 */
function parseReservation(payload: unknown): Reservation | null {
  if (!isRecord(payload)) return null;
  const { requestedBy, id, modelId, packageId, date, time, locale, guest } = payload;
  if (
    typeof requestedBy !== "string" ||
    typeof id !== "string" ||
    typeof modelId !== "string" ||
    typeof packageId !== "string" ||
    typeof date !== "string" ||
    typeof time !== "string"
  ) {
    return null;
  }
  if (id.length === 0 || id.length > MAX_ID_LENGTH || !isLocale(locale) || !isGuest(guest)) return null;
  const { familyName, givenName, email, phone } = guest;
  return { requestedBy, id, modelId, packageId, date, time, locale, guest: { familyName, givenName, email, phone } };
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
    return new Response("Publishing is not set up on the Worker, so no reservation was made.", { status: 500 });
  }
  if (!verified.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

  // The payload has passed its signature, but it can still be any JSON.
  const reservation = parseReservation(verified.payload);
  if (reservation === null) {
    return new Response("The reservation is not in the shape the Worker reads, so nothing was booked.", { status: 400 });
  }

  const { date, time, ...rest } = reservation;
  const input: StaffBookingInput = { ...rest, startAt: pickupInstant(date, time) };
  const ctx = { siteUrl: env.SITE_URL, cancelSecret: env.CANCEL_LINK_SECRET, staffEmail: env.STAFF_EMAIL };
  const result = await createStaffBooking(env.DB, input, now, ctx);
  if (!result.ok) {
    const { reason, fields } = result;
    return Response.json(fields === undefined ? { ok: false, reason } : { ok: false, reason, fields });
  }

  // The booking's emails and Bookings row, committed with it, go out after this answer. A replay finds them queued
  // already, and the drain sends only what is still pending.
  drainSoon(locals.cfContext, env);
  const { id, ref, modelId, packageId, vehiclePlate, startAt, endAt, priceJpy, depositJpy } = result.booking;
  return Response.json({
    ok: true,
    booking: { id, ref, modelId, packageId, plate: vehiclePlate, startAt, endAt, priceJpy, depositJpy },
  });
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { Allow: "POST" } });
