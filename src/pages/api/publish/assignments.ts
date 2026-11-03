// POST /api/publish/assignments: the last step of Publish, which applies the bike overrides typed on the Bookings tab.
// The body is the `{ ts, payload, sig }` envelope signed with PUBLISH_SECRET, and anything else is a 401, before any
// call to Google.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { syncAssignments } from "../../../lib/sheets/assignments-sync.ts";
import { createGoogleClients } from "../../../server/google.ts";

export const POST: APIRoute = async ({ request }) => {
  const now = Date.now();
  const verified = await verifyEnvelope(env.PUBLISH_SECRET, await request.text(), now);
  if (!verified.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

  return Response.json(await syncAssignments({ db: env.DB, sheets: createGoogleClients().sheets, now }));
};
