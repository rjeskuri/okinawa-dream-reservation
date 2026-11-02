// The Google auth and Sheets clients, built from `env`, with the access token shared across requests through D1.
import { env } from "cloudflare:workers";
import { createGoogleAuth, type TokenCache } from "../lib/google/auth.ts";
import { createSheetsClient } from "../lib/google/sheets.ts";

// The Sheets client needs the first, the Drive photo copy of task #17 the second, and both use the one token.
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.readonly"];

function d1TokenCache(db: D1Database): TokenCache {
  return {
    async get(key) {
      const row = await db
        .prepare("SELECT value, expires_at FROM kv_cache WHERE key = ?1")
        .bind(key)
        .first<{ value: string; expires_at: number }>();
      return row === null ? null : { token: row.value, expiresAt: row.expires_at };
    },
    async set(key, { token, expiresAt }) {
      await db
        .prepare(
          "INSERT INTO kv_cache (key, value, expires_at) VALUES (?1, ?2, ?3) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        )
        .bind(key, token, expiresAt)
        .run();
    },
  };
}

/**
 * Builds both clients for one request or cron run. They are not kept at module level: a token request in flight belongs
 * to the request that started it in workerd, and a shared one would hang any other request if that one were cancelled.
 */
export function createGoogleClients() {
  const auth = createGoogleAuth({
    clientEmail: env.GOOGLE_SA_EMAIL,
    privateKeyPem: env.GOOGLE_SA_PRIVATE_KEY,
    scopes: SCOPES,
    fetch,
    now: Date.now,
    cache: d1TokenCache(env.DB),
  });
  const sheets = createSheetsClient({ getToken: auth.getToken, fetch, spreadsheetId: env.GOOGLE_SHEET_ID });
  return { auth, sheets };
}
