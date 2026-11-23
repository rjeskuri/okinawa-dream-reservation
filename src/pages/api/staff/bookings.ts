// POST /api/staff/bookings: the Dashboard's panels ask for the bookings staff can act on, by ref, guest name or JST
// pickup date. The body is the `{ ts, payload, sig }` envelope signed with PUBLISH_SECRET, its payload
// `{ requestedBy, text?, date? }`, and anything unsigned is a 401. A body past the limit is a 413, an empty or unset
// secret a 500 and a payload of the wrong shape a 400, each in plain words, as the panel shows staff the body as it
// stands. A text over 100 characters or a date that is not a real day answers `{ ok: false, reason: 'BAD_QUERY' }`, and
// a search `{ ok: true, bookings }`. It reads D1 only.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { findBookingsForStaff, parseStaffQuery } from "../../../lib/booking/staff-search.ts";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { readBody } from "../../../lib/request-body.ts";

export const POST: APIRoute = async ({ request }) => {
  const body = await readBody(request);
  if (body === null) return new Response("The request is too large.", { status: 413 });

  const now = Date.now();
  let verified: Awaited<ReturnType<typeof verifyEnvelope>>;
  try {
    verified = await verifyEnvelope(env.PUBLISH_SECRET, body, now);
  } catch {
    // WebCrypto refuses an empty key, so this is an empty or unset PUBLISH_SECRET, and no request can pass.
    return new Response("Publishing is not set up on the Worker, so no bookings were searched.", { status: 500 });
  }
  if (!verified.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

  // The payload has passed its signature, but it can still be any JSON.
  const parsed = parseStaffQuery(verified.payload);
  if (!parsed.ok && parsed.reason === "BAD_SHAPE") {
    return new Response("The search is not in the shape the Worker reads, so no bookings were searched.", {
      status: 400,
    });
  }
  if (!parsed.ok) return Response.json({ ok: false, reason: "BAD_QUERY" });

  const bookings = await findBookingsForStaff(env.DB, parsed.query, now);
  return Response.json({ ok: true, bookings });
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { Allow: "POST" } });
