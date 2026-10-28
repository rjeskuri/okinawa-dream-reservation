// GET /api/health: proves the Worker serves Astro routes and reaches D1, and leaves `last_health_at` in meta
// through waitUntil so deferred work is exercised on every call.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const GET: APIRoute = async ({ locals }) => {
  let db = false;
  try {
    const row = await env.DB.prepare("SELECT 1 AS one").first<{ one: number }>();
    db = row?.one === 1;
  } catch {
    db = false;
  }
  if (!db) {
    return Response.json({ ok: false, db: false }, { status: 503 });
  }
  const now = Date.now();
  locals.cfContext.waitUntil(
    env.DB.prepare(
      "INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
      .bind("last_health_at", String(now), now)
      .run(),
  );
  return Response.json({ ok: true, db: true });
};
