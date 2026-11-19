// POST /api/staff/catalog: the published choices the Dashboard panels of #140 offer staff, the ones the Worker checks a
// booking or a block against. The body is the `{ ts, payload, sig }` envelope signed with PUBLISH_SECRET, and anything
// else is a 401. A body past the limit is a 413 and an empty or unset secret a 500, as on the publish routes. It reads
// only: before the first publish it answers `{ ok: false, reason: "NOT_PUBLISHED" }`.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { readCatalog } from "../../../lib/db/catalog-store.ts";
import { readBody } from "../../../lib/request-body.ts";
import { staffCatalogView } from "../../../lib/staff/catalog-view.ts";

export const POST: APIRoute = async ({ request }) => {
  const body = await readBody(request);
  if (body === null) return new Response("The request is too large.", { status: 413 });

  let authorized: boolean;
  try {
    authorized = (await verifyEnvelope(env.PUBLISH_SECRET, body, Date.now())).ok;
  } catch {
    // WebCrypto refuses an empty key, so this is an empty or unset PUBLISH_SECRET, and no request can pass.
    return new Response("Publishing is not set up on the Worker, so the catalog cannot be read.", { status: 500 });
  }
  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });

  const catalog = await readCatalog(env.DB);
  if (catalog === null) return Response.json({ ok: false, reason: "NOT_PUBLISHED" });
  return Response.json(staffCatalogView(catalog));
};
