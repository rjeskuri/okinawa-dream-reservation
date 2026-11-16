// POST /api/staff/check-rows: the sheet's "Add a bike" panel asks how a publish would judge the rows it proposes. The body
// is the `{ ts, payload, sig }` envelope signed with PUBLISH_SECRET, its payload `{ rows: ProposedRows }`, and anything
// unsigned is a 401, before any call to Google. A body past the limit is a 413, an empty or unset secret a 500 and a
// payload of the wrong shape a 400, before any call to Google too. The answer is a CheckAnswer for the live sheet with the
// rows added. Every failure is plain words, because the panel shows staff the body as it stands, and none carries the
// text of the failure, which can quote a URL. Nothing is written to the sheet, D1 or R2.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { checkProposedRows, parseProposedRows } from "../../../lib/catalog/check-rows.ts";
import { CATALOG_TABS } from "../../../lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { readBody } from "../../../lib/request-body.ts";
import { createGoogleClients } from "../../../server/google.ts";

export const POST: APIRoute = async ({ request }) => {
  const body = await readBody(request);
  if (body === null) return new Response("The request is too large.", { status: 413 });

  const now = Date.now();
  let verified: Awaited<ReturnType<typeof verifyEnvelope>>;
  try {
    verified = await verifyEnvelope(env.PUBLISH_SECRET, body, now);
  } catch {
    // WebCrypto refuses an empty key, so this is an empty or unset PUBLISH_SECRET, and no request can pass.
    return new Response("Publishing is not set up on the Worker, so no rows were checked.", { status: 500 });
  }
  if (!verified.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

  // The payload has passed its signature, but it can still be any JSON.
  const { rows: payloadRows } = Object(verified.payload) as { rows?: unknown };
  const rows = parseProposedRows(payloadRows);
  if (rows === null) {
    return new Response("The proposed rows are not in the shape the check reads, so no rows were checked.", {
      status: 400,
    });
  }

  let workbook: Record<string, unknown[][]>;
  try {
    workbook = await createGoogleClients(env).sheets.batchGet([...CATALOG_TABS]);
  } catch (error) {
    // A SheetsError, or the token request before it: either way the sheet was not read.
    console.error(error);
    return new Response("Could not read the sheet from Google, so no rows were checked.", { status: 502 });
  }
  return Response.json(checkProposedRows(workbook, rows, now));
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { Allow: "POST" } });
