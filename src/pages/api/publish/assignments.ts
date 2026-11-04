// POST /api/publish/assignments: the last step of Publish, which applies the bike overrides typed on the Bookings tab.
// The body is the `{ ts, payload, sig }` envelope signed with PUBLISH_SECRET, and anything else is a 401, before any
// call to Google. A body past the limit is a 413 and an empty or unset secret a 500, before any call to Google too, in
// plain words because signedPost_ in apps-script/Publish.js shows staff a failure's body as it stands.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { readBody } from "../../../lib/request-body.ts";
import { syncAssignments } from "../../../lib/sheets/assignments-sync.ts";
import { createGoogleClients } from "../../../server/google.ts";

export const POST: APIRoute = async ({ request }) => {
  const body = await readBody(request);
  if (body === null) return new Response("The request is too large.", { status: 413 });

  const now = Date.now();
  let authorized: boolean;
  try {
    authorized = (await verifyEnvelope(env.PUBLISH_SECRET, body, now)).ok;
  } catch {
    // WebCrypto refuses an empty key, so this is an empty or unset PUBLISH_SECRET, and no request can pass.
    return new Response("Publishing is not set up on the Worker, so no bookings were moved.", { status: 500 });
  }
  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });

  return Response.json(await syncAssignments({ db: env.DB, sheets: createGoogleClients(env).sheets, now }));
};
