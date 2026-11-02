// GET /media/photos/{md5}.{ext}: serves a copied photo from R2. The key holds the md5, so the bytes behind a URL never
// change and can be cached for good. The rest of the bucket is not served, whatever the path.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isPhotoKey } from "../../lib/catalog/photos.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";

export const GET: APIRoute = async ({ params }) => {
  const { key } = params;
  if (key === undefined || !isPhotoKey(key)) return new Response(null, { status: 404 });

  const object = await env.MEDIA.get(key);
  if (object === null) return new Response(null, { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", IMMUTABLE);
  return new Response(object.body, { headers });
};
