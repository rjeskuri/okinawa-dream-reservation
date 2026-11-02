// POST /api/publish: the sheet's Publish menu replaces the catalog. The body is the `{ ts, payload, sig }` envelope
// signed with PUBLISH_SECRET, and anything else is a 401, before any call to Google. A report answers 200, a fatal
// sheet's too. Every other answer is plain words, because the Apps Script shows them to staff after "Publish failed:
// the Worker answered 502:", and none carries the text of the failure, which can quote a URL or the database.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { publishCatalog, PublishError, type PublishStep } from "../../../lib/catalog/publish.ts";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { createGoogleClients } from "../../../server/google.ts";

const MAX_BODY_BYTES = 64 * 1024;

/** Only `write-back` runs after the commit, so it alone may say that the catalog published. */
const FAILURES: Record<PublishStep, { status: number; message: string }> = {
  read: { status: 502, message: "Could not read the sheet from Google, so nothing was published." },
  store: { status: 500, message: "Could not store the new catalog, so nothing was published." },
  "write-back": {
    status: 502,
    message: "The catalog did publish, but the row statuses did not reach the sheet, so press Publish again.",
  },
};

/** The body as text, or null past the limit. Counted as it arrives, so a sender cannot keep the Worker reading. */
async function readBody(request: Request): Promise<string | null> {
  if (request.body === null) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) return null;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export const POST: APIRoute = async ({ request }) => {
  const body = await readBody(request);
  if (body === null) return new Response("The request is too large.", { status: 413 });

  const now = Date.now();
  let authorized: boolean;
  try {
    authorized = (await verifyEnvelope(env.PUBLISH_SECRET, body, now)).ok;
  } catch {
    // WebCrypto refuses an empty key, so this is an empty or unset PUBLISH_SECRET, and no request can pass.
    return new Response("Publishing is not set up on the Worker, so nothing was published.", { status: 500 });
  }
  if (!authorized) return new Response("Unauthorized", { status: 401 });

  try {
    return Response.json(await publishCatalog({ db: env.DB, sheets: createGoogleClients().sheets, now }));
  } catch (error) {
    console.error(error);
    // Every step that writes is marked, so an unmarked error stopped before the commit.
    const { status, message } = error instanceof PublishError ? FAILURES[error.step] : FAILURES.store;
    return new Response(message, { status });
  }
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { Allow: "POST" } });
