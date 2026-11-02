// POST /api/publish/photos: copies one batch of photos from Drive to R2. The body is the `{ ts, payload, sig }` envelope
// signed with PUBLISH_SECRET, and anything else is a 401, before any call to Google. The caller repeats it until
// `remaining` is 0.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { syncPhotos } from "../../../lib/catalog/photos.ts";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { CatalogNotPublished, readShopConfig } from "../../../lib/db/config.ts";
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
  const now = Date.now();
  const verified = await verifyEnvelope(env.PUBLISH_SECRET, await request.text(), now);
  if (!verified.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await syncPhotos({
    db: env.DB,
    media: env.MEDIA,
    drive: createGoogleClients().drive,
    folderId: env.GOOGLE_DRIVE_FOLDER_ID,
    now,
    maxBytes: await readMaxBytes(env.DB),
  });
  return Response.json(result);
};
