// POST /api/publish/photos: copies one batch of photos from Drive to R2. The body is the `{ ts, payload, sig }` envelope
// signed with PUBLISH_SECRET, and anything else is a 401, before any call to Google. The caller repeats it until
// `remaining` is 0. Its 401 and its report are JSON, which the Apps Script reads already; the answers that stop it are
// plain words, which the Apps Script shows to staff after "Photos failed: the Worker answered 500:", and none carries the
// text of the failure, which can quote Google's URL or the folder.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { syncPhotos } from "../../../lib/catalog/photos.ts";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { CatalogNotPublished, readShopConfig } from "../../../lib/db/config.ts";
import { readBody } from "../../../lib/request-body.ts";
import { createGoogleClients } from "../../../server/google.ts";

const BYTES_PER_MB = 1_000_000;

/** Before the first publish no limit exists, and syncPhotos has nothing to apply one to. */
async function readMaxBytes(db: D1Database): Promise<number> {
  try {
    return (await readShopConfig(db)).photoMaxMb * BYTES_PER_MB;
  } catch (error) {
    if (error instanceof CatalogNotPublished) return 0;
    throw error;
  }
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
    return new Response("Publishing is not set up on the Worker, so no photos were copied.", { status: 500 });
  }
  if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const result = await syncPhotos({
      db: env.DB,
      media: env.MEDIA,
      drive: createGoogleClients().drive,
      folderId: env.GOOGLE_DRIVE_FOLDER_ID,
      now,
      maxBytes: await readMaxBytes(env.DB),
    });
    return Response.json(result);
  } catch (error) {
    console.error(error);
    // syncPhotos catches each copy's failure, so what reaches here stopped before the first copy. Left uncaught, it
    // would get Astro's page for /500, which /[locale] takes for a locale and answers with an empty 404.
    return new Response("Could not start the photo copy, so no photos were copied.", { status: 500 });
  }
};
