// Google service-account auth: an RS256 JWT exchanged for an access token, which is kept in memory and then in a
// TokenCache so that a token costs one RSA signature for its whole lifetime. WebCrypto only, so the file runs unchanged
// in Node and in Workers.

export type CachedToken = { token: string; expiresAt: number };

export type TokenCache = {
  get(key: string): Promise<CachedToken | null>;
  set(key: string, value: CachedToken): Promise<void>;
};

type GoogleAuthOptions = {
  clientEmail: string;
  privateKeyPem: string;
  scopes: string[];
  fetch: typeof fetch;
  now: () => number;
  cache?: TokenCache;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

const JWT_LIFETIME_S = 3600;

const REFRESH_MARGIN_MS = 300_000;

// OAuth error codes are lowercase words. Anything wider would let a JWT quoted back in the field reach the message.
const ERROR_CODE = /^[a-z_]{1,64}$/;

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

/** Keys pasted into .dev.vars can carry literal \n sequences. Base64 has no backslash, so removing them is safe. */
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem
    .replace(/\\[nr]/g, "")
    .replace(/-----[^-]*-----/g, "")
    .replace(/\s/g, "");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function signAssertion(options: GoogleAuthOptions, nowMs: number): Promise<string> {
  const { clientEmail, privateKeyPem, scopes } = options;
  const iat = Math.floor(nowMs / 1000);
  const claims = { iss: clientEmail, scope: scopes.join(" "), aud: TOKEN_URL, iat, exp: iat + JWT_LIFETIME_S };
  const signingInput = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson(claims)}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(privateKeyPem), RS256, false, ["sign"]);
  const signature = await crypto.subtle.sign(RS256.name, key, encoder.encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Exchanges a new JWT for a token. The response body stays out of every error, whatever it holds: it can quote the
 * assertion, so only a status and an `error` field that passes ERROR_CODE leave this function.
 */
async function requestToken(options: GoogleAuthOptions): Promise<CachedToken> {
  // Destructured because workerd's fetch throws "Illegal invocation" when it is called as `options.fetch(...)`.
  const { fetch, now } = options;
  // Taken before the request, so that the token's lifetime is never overstated by the time the exchange took.
  const issuedAt = now();
  const assertion = await signAssertion(options, issuedAt);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }).toString(),
  });
  const body = parseObject(await response.text());

  if (response.status !== 200) {
    const code = typeof body.error === "string" && ERROR_CODE.test(body.error) ? ` ${body.error}` : "";
    throw new Error(`Google token request failed: ${response.status}${code}`);
  }
  const { access_token: token, expires_in: expiresIn } = body;
  if (typeof token !== "string" || token === "") {
    throw new Error("Google token response has no access_token");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Google token response has no usable expires_in");
  }
  return { token, expiresAt: issuedAt + expiresIn * 1000 };
}

/** The TokenCache only saves a signature, so a failing one (D1 down) counts as a miss rather than failing the call. */
async function readCache(cache: TokenCache | undefined, key: string): Promise<CachedToken | null> {
  try {
    return (await cache?.get(key)) ?? null;
  } catch {
    console.warn("Google token cache read failed; requesting a new token");
    return null;
  }
}

async function writeCache(cache: TokenCache | undefined, key: string, value: CachedToken): Promise<void> {
  try {
    await cache?.set(key, value);
  } catch {
    console.warn("Google token cache write failed; the token is kept in memory only");
  }
}

export function createGoogleAuth(options: GoogleAuthOptions): { getToken(): Promise<string> } {
  const { clientEmail, scopes, now, cache } = options;
  // A space appears in neither an email address nor a scope, so no two pairs of them make the same key.
  const cacheKey = `google-token:${clientEmail} ${scopes.join(" ")}`;
  let held: CachedToken | null = null;
  let pending: Promise<string> | null = null;

  // Written so that a NaN `now` or `expiresAt` comes out stale rather than fresh.
  const isFresh = (entry: CachedToken) => now() < entry.expiresAt - REFRESH_MARGIN_MS;

  async function load(): Promise<string> {
    const stored = await readCache(cache, cacheKey);
    if (stored !== null && isFresh(stored)) {
      held = stored;
      return stored.token;
    }
    const fetched = await requestToken(options);
    held = fetched;
    await writeCache(cache, cacheKey, fetched);
    return fetched.token;
  }

  return {
    async getToken() {
      if (held !== null && isFresh(held)) return held.token;
      pending ??= load().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
