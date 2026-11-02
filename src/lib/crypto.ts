// HMAC, hashing, booking references and the signed envelope shared with the sheet's Apps Script. WebCrypto only, so the
// file runs unchanged in Node and in Workers.

type Envelope = { ts: number; payload: string; sig: string };

type VerifyResult = { ok: true; payload: unknown } | { ok: false; reason: "malformed" | "stale" | "bad_signature" };

const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const HMAC_SHA256 = { name: "HMAC", hash: "SHA-256" };

const encoder = new TextEncoder();

async function hmacSha256(key: string, msg: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), HMAC_SHA256, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(msg));
}

function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  return toHex(await hmacSha256(key, msg));
}

export async function hmacSha256Base64(key: string, msg: string): Promise<string> {
  return btoa(String.fromCharCode(...new Uint8Array(await hmacSha256(key, msg))));
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
}

/**
 * Compares two strings without stopping at the first difference, so the time taken says nothing about how many leading
 * characters match. Only the length can show, and a signature's length is public.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/** 8 characters of Crockford base32. The alphabet has 32 symbols, so the low 5 bits of a byte pick one without bias. */
export function randomRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => REF_ALPHABET[byte & 31]).join("");
}

function signatureOf(secret: string, ts: number, payload: string): Promise<string> {
  return hmacSha256Hex(secret, `${ts}.${payload}`);
}

function isEnvelope(body: unknown): body is Envelope {
  if (typeof body !== "object" || body === null) return false;
  const { ts, payload, sig } = body as Record<string, unknown>;
  return typeof ts === "number" && Number.isFinite(ts) && typeof payload === "string" && typeof sig === "string";
}

/** The Apps Script side computes `sig` the same way, so this format must not change on one side alone. */
export async function signEnvelope(secret: string, payload: unknown, now: number): Promise<Envelope> {
  const text = JSON.stringify(payload);
  return { ts: now, payload: text, sig: await signatureOf(secret, now, text) };
}

/**
 * Checks a raw `{ ts, payload, sig }` body in this order: body shape, signature, freshness, then JSON-parsing the
 * payload, so nothing unauthenticated decides the outcome beyond shape. The signature covers the payload text as sent,
 * and a `ts` exactly maxSkewMs from `now`, on either side, is still fresh.
 */
export async function verifyEnvelope(
  secret: string,
  bodyText: string,
  now: number,
  maxSkewMs = 300_000,
): Promise<VerifyResult> {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isEnvelope(body)) return { ok: false, reason: "malformed" };

  const expected = await signatureOf(secret, body.ts, body.payload);
  if (!timingSafeEqual(body.sig, expected)) return { ok: false, reason: "bad_signature" };

  // Written so that a NaN `now` or maxSkewMs comes out stale rather than fresh.
  if (!(Math.abs(now - body.ts) <= maxSkewMs)) return { ok: false, reason: "stale" };

  try {
    return { ok: true, payload: JSON.parse(body.payload) };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
