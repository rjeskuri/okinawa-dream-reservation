// POST /api/holds/{id}/confirm: the hold page's card form sends the nonce from Square's Card.tokenize(), the guest and the
// page's locale, and confirmHold charges the deposit. The status codes are the ones confirmOutcome in src/lib/checkout.ts
// reads. No answer carries the booking or Square's words: a 200 answers whoever holds the checkout URL, and a decline shows
// the page's own translated text. A body the Worker cannot use is a 400 that reaches neither Square nor the row.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { confirmHold, type ConfirmReason } from "../../../../lib/booking/confirm.ts";
import type { Guest } from "../../../../lib/checkout.ts";
import { isLocale } from "../../../../lib/locale.ts";
import { drainSoon } from "../../../../server/outbox.ts";
import { squareClient } from "../../../../server/square.ts";

/** Far past a guest's details and a nonce, and far short of what D1 stores in one value. */
const MAX_BODY_BYTES = 16 * 1024;

const STATUS: Record<ConfirmReason, number> = {
  NOT_FOUND: 404,
  HOLD_EXPIRED: 409,
  IN_PROGRESS: 409,
  PAYMENT_DECLINED: 402,
  PAYMENT_UNKNOWN: 202,
  INVALID_GUEST: 400,
};

/**
 * The body as text, or null past the limit. It reads to the end whatever the size, keeping only what fits: an answer sent
 * while the client is still sending resets its connection, and the page would never see the status.
 */
async function readBody(request: Request): Promise<string | null> {
  if (request.body === null) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes <= MAX_BODY_BYTES) text += decoder.decode(chunk, { stream: true });
  }
  return bytes > MAX_BODY_BYTES ? null : text + decoder.decode();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function refuse(status: number, reason: string): Response {
  return Response.json({ ok: false, reason }, { status });
}

export const POST: APIRoute = async ({ params, request, locals }) => {
  const text = await readBody(request);
  if (text === null) return refuse(413, "TOO_LARGE");
  const body = parseJson(text);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse(400, "BAD_REQUEST");
  const { sourceId, guest, locale } = body as Record<string, unknown>;
  if (typeof sourceId !== "string" || sourceId === "" || !isLocale(locale)) return refuse(400, "BAD_REQUEST");

  const deps = {
    db: env.DB,
    square: squareClient(env),
    now: () => Date.now(),
    siteUrl: env.SITE_URL,
    cancelSecret: env.CANCEL_LINK_SECRET,
    staffEmail: env.STAFF_EMAIL,
  };
  // confirmHold checks the guest itself and answers INVALID_GUEST, naming each field that fails.
  const result = await confirmHold(deps, params.id ?? "", { sourceId, guest: guest as Guest, locale });
  if (result.ok) {
    // The confirmation's emails and Bookings row, committed with the booking, go out after this answer.
    drainSoon(locals.cfContext, env);
    return Response.json({ ok: true });
  }

  const { reason, fields } = result;
  const answer = fields === undefined ? { ok: false, reason } : { ok: false, reason, fields };
  return Response.json(answer, { status: STATUS[reason] });
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { Allow: "POST" } });
