// POST /api/webhooks/square: Square's payment and refund notifications. Anyone can send one, so the body is read up to the
// publish routes' limit before anything else, and past it is a 413. The signature is checked over SQUARE_WEBHOOK_URL as
// configured, never the URL the request arrived on, which behind a tunnel or a proxy is not the one Square signed. Square
// reads only the status: a 2xx ends its deliveries of the event and anything else has it send the event again, so an
// event the Worker fails on answers 500, and handleSquareEvent has given its claim back for that redelivery.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { readBody } from "../../../lib/request-body.ts";
import { handleSquareEvent } from "../../../lib/square/webhook-handler.ts";
import { verifySquareSignature } from "../../../lib/square/webhook-signature.ts";
import { squareClient } from "../../../server/square.ts";

const SIGNATURE_HEADER = "x-square-hmacsha256-signature";

/** Signed text that is not JSON is no event, and the handler acknowledges it as one it ignores. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const body = await readBody(request);
  if (body === null) return new Response("The request is too large.", { status: 413 });

  const signed = await verifySquareSignature({
    signatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY,
    notificationUrl: env.SQUARE_WEBHOOK_URL,
    rawBody: body,
    signature: request.headers.get(SIGNATURE_HEADER),
  });
  if (!signed) return new Response("Unauthorized", { status: 401 });

  try {
    const deps = {
      db: env.DB,
      square: squareClient(env),
      now: Date.now(),
      siteUrl: env.SITE_URL,
      cancelSecret: env.CANCEL_LINK_SECRET,
      staffEmail: env.STAFF_EMAIL,
    };
    await handleSquareEvent(deps, parseJson(body));
  } catch (error) {
    console.error("A Square event was not handled, and Square will send it again", error);
    return new Response("The event was not handled.", { status: 500 });
  }
  return new Response("OK");
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { Allow: "POST" } });
