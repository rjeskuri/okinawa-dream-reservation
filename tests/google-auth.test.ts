// Google service-account auth: the RS256 JWT, the token exchange, the two token caches and what a failure may say. Keys
// are generated here with WebCrypto and signatures are checked with the public half. Expected claims and expiries are
// worked out from the fake clock and the fake token response, never from src/lib/google/auth.ts.
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { test } from "node:test";
import { inspect } from "node:util";
import { createGoogleAuth, type TokenCache } from "../src/lib/google/auth.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const SPREADSHEETS = "https://www.googleapis.com/auth/spreadsheets";
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
const EMAIL = "publisher@okinawa-dream-test.iam.gserviceaccount.com";
const OTHER_EMAIL = "reader@another-project.iam.gserviceaccount.com";

const FIVE_MINUTES_MS = 300_000;
const NOW = Date.UTC(2026, 9, 31, 15);
const NOWS = [NOW, 1_700_000_000_123, Date.UTC(2030, 0, 1, 1, 2, 3, 4)];

type TestKey = { pem: string; publicKey: CryptoKey };
type Clock = { ms: number };
type Entry = { token: string; expiresAt: number };
type TokenCall = { url: string; method: string; contentType: string; grantType: string | null; assertion: string };
type AuthOptions = { email?: string; scopes?: string[]; pem?: string; cache?: TokenCache };

async function generateKey(): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  // node:crypto writes the PEM armor: 64-character lines and a trailing newline, like a key file from Google.
  const privateKey = createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: pair.publicKey };
}

const KEY = await generateKey();
const OTHER_KEY = await generateKey();

const PEM_LINES = KEY.pem.split("\n").filter((line) => line !== "" && !line.startsWith("-----"));
const KEY_SECRETS = [KEY.pem, PEM_LINES.join(""), ...PEM_LINES.filter((line) => line.length === 64)];

/** A fake token endpoint. `respond` gets the 1-based number of the call and the assertion it was sent. */
function tokenServer(respond: (call: number, assertion: string) => Response) {
  const calls: TokenCall[] = [];
  // A function and not an arrow, so that it can see `this`. The real fetch throws "Illegal invocation" in workerd when it
  // is called as a method, like `opts.fetch(...)`, and these tests are the only place that shows before the e2e of #15.
  const fetchFake: typeof fetch = async function (this: unknown, input, init) {
    assert.ok(this === undefined || this === globalThis, "the injected fetch must be called unbound");
    const request = new Request(input, init);
    const form = new URLSearchParams(await request.text());
    const assertion = form.get("assertion") ?? "";
    calls.push({
      url: request.url,
      method: request.method,
      contentType: request.headers.get("content-type") ?? "",
      grantType: form.get("grant_type"),
      assertion,
    });
    return respond(calls.length, assertion);
  };
  return { fetch: fetchFake, calls };
}

function tokenResponse(token: string, expiresIn = 3600): Response {
  return Response.json({ access_token: token, expires_in: expiresIn, token_type: "Bearer" });
}

function numberedTokens(expiresIn = 3600) {
  return tokenServer((call) => tokenResponse(`token-${call}`, expiresIn));
}

function authFor(server: { fetch: typeof fetch }, clock: Clock, options: AuthOptions = {}) {
  return createGoogleAuth({
    clientEmail: options.email ?? EMAIL,
    privateKeyPem: options.pem ?? KEY.pem,
    scopes: options.scopes ?? [SPREADSHEETS],
    fetch: server.fetch,
    now: () => clock.ms,
    cache: options.cache,
  });
}

/** A Map-backed TokenCache. `seed` answers any key not written yet, since the key format is the code's own. */
function memoryCache(seed: Entry | null = null) {
  const entries = new Map<string, Entry>();
  const writes: { key: string; value: Entry }[] = [];
  const stats = { reads: 0 };
  const cache: TokenCache = {
    async get(key: string) {
      stats.reads += 1;
      return entries.get(key) ?? seed;
    },
    async set(key: string, value: Entry) {
      writes.push({ key, value });
      entries.set(key, value);
    },
  };
  return { cache, writes, stats };
}

/** Splits a JWT by hand. Buffer's base64url decoder also accepts + and /, so the alphabet is checked first. */
function decodeJwt(assertion: string): { header: unknown; claims: Record<string, unknown>; parts: string[] } {
  const parts = assertion.split(".");
  assert.equal(parts.length, 3, "a JWT has three parts");
  for (const part of parts) {
    assert.match(part, /^[A-Za-z0-9_-]+$/, "each part is base64url without padding");
  }
  const decoded = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  return { header: decoded(parts[0]), claims: decoded(parts[1]), parts };
}

async function signatureVerifies(assertion: string, publicKey: CryptoKey): Promise<boolean> {
  const [header, payload, signature] = assertion.split(".");
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    Buffer.from(signature, "base64url"),
    Buffer.from(`${header}.${payload}`, "ascii"),
  );
}

/** iat is in whole seconds and comes from the clock. Rounding a fraction of a second either way is fine. */
function assertIssuedAt(iat: unknown, nowMs: number, label: string): void {
  assert.ok(typeof iat === "number" && Number.isInteger(iat), `${label}: iat is ${iat}`);
  assert.ok(Math.abs(iat * 1000 - nowMs) < 1000, `${label}: iat ${iat} is not the clock in seconds, ${nowMs}`);
}

/** Every form of an error a log line could show. inspect walks the cause and any properties attached to it. */
function errorViews(error: Error): string[] {
  return [
    error.message,
    String(error),
    error.stack ?? "",
    inspect(error, { depth: null, showHidden: true }),
    JSON.stringify(error) ?? "",
  ];
}

function assertNoSecrets(error: Error, secrets: string[], label: string): void {
  for (const view of errorViews(error)) {
    for (const secret of secrets) {
      assert.equal(view.includes(secret), false, `${label}: the error carries part of a secret`);
    }
  }
}

function secretsOf(assertion: string): string[] {
  const parts = assertion.split(".");
  return [...KEY_SECRETS, assertion, ...parts, parts[2].slice(0, 24), parts[2].slice(-24)];
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to reject");
}

test("the assertion is a valid RS256 JWT for the service account", async () => {
  // [client email, scopes, the scope claim written out, clock]
  const cases: [string, string[], string, number][] = [
    [EMAIL, [SPREADSHEETS], SPREADSHEETS, NOW],
    [EMAIL, [SPREADSHEETS, DRIVE_READONLY], `${SPREADSHEETS} ${DRIVE_READONLY}`, NOW + 1],
    [OTHER_EMAIL, [DRIVE_READONLY, SPREADSHEETS], `${DRIVE_READONLY} ${SPREADSHEETS}`, 1_700_000_000_000],
    [OTHER_EMAIL, [DRIVE_READONLY], DRIVE_READONLY, 1_700_000_000_999],
    ["a@b.iam.gserviceaccount.com", ["scope-a", "scope-b", "scope-c"], "scope-a scope-b scope-c", NOWS[2]],
  ];

  for (const [i, [email, scopes, scope, now]] of cases.entries()) {
    const label = `${email}, ${scopes.length} scopes, at ${now}`;
    const [key, otherKey] = i % 2 === 0 ? [KEY, OTHER_KEY] : [OTHER_KEY, KEY];
    const token = `access-token-${i}`;
    // expires_in sets how long the token is cached and must not feed the JWT's own exp.
    const server = tokenServer(() => tokenResponse(token, 1800 + i));

    const returned = await authFor(server, { ms: now }, { email, scopes, pem: key.pem }).getToken();

    assert.equal(returned, token, label);
    assert.equal(server.calls.length, 1, label);
    const [call] = server.calls;
    assert.equal(call.url, TOKEN_URL, label);
    assert.equal(call.method, "POST", label);
    assert.match(call.contentType, /^application\/x-www-form-urlencoded/i, label);
    assert.equal(call.grantType, GRANT_TYPE, label);

    const { header, claims } = decodeJwt(call.assertion);
    assert.deepEqual(header, { alg: "RS256", typ: "JWT" }, label);
    assertIssuedAt(claims.iat, now, label);
    assert.deepEqual(
      claims,
      { iss: email, scope, aud: TOKEN_URL, iat: claims.iat, exp: Number(claims.iat) + 3600 },
      label,
    );
    assert.equal(await signatureVerifies(call.assertion, key.publicKey), true, label);
    assert.equal(await signatureVerifies(call.assertion, otherKey.publicKey), false, label);
  }
});

test("every JWT part is unpadded base64url whatever bytes the claims encode to", async () => {
  // Three ? in a row always put a / in standard base64 and three > a +, at any offset. Lengthening the address one
  // character at a time moves the claims through every length mod 3, so padding turns up as well.
  const seen = new Set<string>();
  for (const prefix of ["", "a", "aa", "aaa"]) {
    const email = `${prefix}???>>>~~~@example.iam.gserviceaccount.com`;
    const server = numberedTokens();
    await authFor(server, { ms: NOW }, { email }).getToken();

    const [{ assertion }] = server.calls;
    const { claims, parts } = decodeJwt(assertion);
    assert.equal(claims.iss, email);
    assert.equal(await signatureVerifies(assertion, KEY.publicKey), true, email);
    for (const character of "+/=") {
      if (Buffer.from(parts[1], "base64url").toString("base64").includes(character)) {
        seen.add(character);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["+", "/", "="], "the addresses above reach all three characters");
});

test("a key signs however its line breaks were pasted", async () => {
  const lines = KEY.pem.trim().split("\n");
  const forms: [string, string][] = [
    ["real newlines", KEY.pem],
    ["no trailing newline", KEY.pem.trimEnd()],
    ["literal backslash-n sequences", KEY.pem.replaceAll("\n", "\\n")],
    ["literal backslash-n, none at the end", KEY.pem.trimEnd().replaceAll("\n", "\\n")],
    ["CRLF line ends", KEY.pem.replaceAll("\n", "\r\n")],
    ["surrounding whitespace", `\n  ${KEY.pem}  \n`],
    ["the base64 on one line", [lines[0], lines.slice(1, -1).join(""), lines.at(-1)].join("\n")],
  ];
  for (const [label, pem] of forms) {
    const server = numberedTokens();
    await authFor(server, { ms: NOW }, { pem }).getToken();
    assert.equal(await signatureVerifies(server.calls[0].assertion, KEY.publicKey), true, label);
  }
});

test("tokens are cached until five minutes before expiry", async () => {
  // The boundary is inclusive. The ticket says a call "within 5 minutes of expiry" fetches a new token, and exactly
  // five minutes before expiry is within five minutes, so that instant fetches and the millisecond before it does not.
  // [expires_in of the first token, of the second and later ones]
  const lifetimes: [number, number][] = [
    [3600, 3600],
    [3599, 1800],
    [1800, 7200],
    [7200, 3599],
    [301, 3600],
    [86_400, 301],
  ];

  for (const start of NOWS) {
    for (const [first, second] of lifetimes) {
      const label = `from ${start}, expires_in ${first} then ${second}`;
      const clock = { ms: start };
      const server = tokenServer((call) => tokenResponse(`token-${call}`, call === 1 ? first : second));
      const auth = authFor(server, clock);

      const firstRefresh = start + first * 1000 - FIVE_MINUTES_MS;
      const midway = Math.floor((start + firstRefresh) / 2);
      for (const at of [start, start, start + 1, midway, midway, firstRefresh - 1, firstRefresh - 1]) {
        clock.ms = at;
        assert.equal(await auth.getToken(), "token-1", `${label}, at ${at}`);
      }
      assert.equal(server.calls.length, 1, label);

      clock.ms = firstRefresh;
      assert.equal(await auth.getToken(), "token-2", label);
      assert.equal(server.calls.length, 2, label);
      // A new request carries a new JWT, not the first one kept.
      assertIssuedAt(decodeJwt(server.calls[1].assertion).claims.iat, firstRefresh, label);

      // The second token's own expires_in sets the next window.
      const secondRefresh = firstRefresh + second * 1000 - FIVE_MINUTES_MS;
      clock.ms = secondRefresh - 1;
      assert.equal(await auth.getToken(), "token-2", label);
      assert.equal(server.calls.length, 2, label);
      clock.ms = secondRefresh;
      assert.equal(await auth.getToken(), "token-3", label);
      assert.equal(server.calls.length, 3, label);
    }
  }

  // Anywhere inside the last five minutes, at expiry and long after it, a call fetches.
  const offsetsFromExpiry = [-FIVE_MINUTES_MS, -FIVE_MINUTES_MS + 1, -60_000, -1, 0, 1, 86_400_000];
  for (const offset of offsetsFromExpiry) {
    const clock = { ms: NOW };
    const server = numberedTokens();
    const auth = authFor(server, clock);
    assert.equal(await auth.getToken(), "token-1");
    clock.ms = NOW + 3_600_000 + offset;
    assert.equal(await auth.getToken(), "token-2", `${offset} ms from expiry`);
  }
});

test("concurrent getToken calls share one token request", async () => {
  for (const cached of [false, true]) {
    const label = cached ? "with a TokenCache" : "memory only";
    const clock = { ms: NOW };
    const server = numberedTokens();
    const auth = authFor(server, clock, cached ? { cache: memoryCache().cache } : {});
    const burst = () => Promise.all(Array.from({ length: 20 }, () => auth.getToken()));

    assert.deepEqual(await burst(), Array(20).fill("token-1"), `${label}, cold`);
    assert.equal(server.calls.length, 1, `${label}, cold`);

    clock.ms = NOW + 3_600_000 - FIVE_MINUTES_MS;
    assert.deepEqual(await burst(), Array(20).fill("token-2"), `${label}, at the refresh point`);
    assert.equal(server.calls.length, 2, `${label}, at the refresh point`);
  }
});

test("a cached token in the TokenCache is reused by a new instance", async (t) => {
  // [expires_in, ms between the two instances], the last rows one millisecond short of the refresh point.
  const cases: [number, number][] = [
    [3600, 0],
    [3600, 1],
    [3599, 1_800_000],
    [3600, 3_299_999],
    [7200, 6_899_999],
    [301, 999],
  ];
  for (const [expiresIn, elapsed] of cases) {
    const label = `expires_in ${expiresIn}, ${elapsed} ms later`;
    const clock = { ms: NOW };
    const store = memoryCache();
    const token = `token-${expiresIn}-${elapsed}`;
    await authFor(
      tokenServer(() => tokenResponse(token, expiresIn)),
      clock,
      { cache: store.cache },
    ).getToken();

    clock.ms = NOW + elapsed;
    const server = numberedTokens();
    const auth = authFor(server, clock, { cache: store.cache });
    assert.equal(await auth.getToken(), token, label);
    assert.equal(server.calls.length, 0, label);

    // Memory comes before the TokenCache, so a token found there is read only once.
    const { reads } = store.stats;
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await auth.getToken(), token, label);
    }
    assert.equal(store.stats.reads, reads, label);
    assert.equal(server.calls.length, 0, label);

    // The entry's expiry follows the token into memory.
    clock.ms = NOW + expiresIn * 1000 - FIVE_MINUTES_MS;
    assert.equal(await auth.getToken(), "token-1", label);
    assert.equal(server.calls.length, 1, label);
  }

  // A miss signs one JWT with WebCrypto. The spy seeing that signature is what gives the zero below its meaning.
  const sign = t.mock.method(crypto.subtle, "sign");
  const written = memoryCache();
  const miss = numberedTokens();
  const auth = authFor(miss, { ms: NOW }, { cache: written.cache });
  assert.equal(await auth.getToken(), "token-1");
  assert.equal(miss.calls.length, 1);
  assert.equal(sign.mock.callCount(), 1, "a cache miss signs once through crypto.subtle.sign");

  // A hit costs no RSA signature, which is why the token is cached at all: not from memory, not from an entry this code
  // wrote, and not from one it did not, whose stored shape is the ticket's rather than a private one.
  sign.mock.resetCalls();
  const none = numberedTokens();
  const seeded = memoryCache({ token: "seeded-token", expiresAt: NOW + 3_600_000 });
  assert.equal(await auth.getToken(), "token-1");
  assert.equal(await authFor(none, { ms: NOW }, { cache: written.cache }).getToken(), "token-1");
  assert.equal(await authFor(none, { ms: NOW }, { cache: seeded.cache }).getToken(), "seeded-token");
  assert.equal(miss.calls.length, 1);
  assert.equal(none.calls.length, 0);
  assert.equal(sign.mock.callCount(), 0, "a cache hit signs nothing");
});

test("a fetched token is written to the TokenCache with its expiry in epoch ms", async () => {
  for (const start of NOWS) {
    for (const expiresIn of [3600, 3599, 1800, 7200]) {
      const label = `from ${start}, expires_in ${expiresIn}`;
      const clock = { ms: start };
      const store = memoryCache();
      const server = numberedTokens(expiresIn);
      const auth = authFor(server, clock, { cache: store.cache });

      await auth.getToken();
      assert.equal(store.writes.length, 1, label);
      const firstExpiry = start + expiresIn * 1000;
      assert.deepEqual(store.writes[0].value, { token: "token-1", expiresAt: firstExpiry }, label);

      // Calls served from memory write nothing, and a refresh writes the new token.
      await auth.getToken();
      assert.equal(store.writes.length, 1, label);
      clock.ms = firstExpiry - FIVE_MINUTES_MS;
      await auth.getToken();
      assert.equal(store.writes.length, 2, label);
      assert.deepEqual(
        store.writes[1].value,
        { token: "token-2", expiresAt: clock.ms + expiresIn * 1000 },
        label,
      );
    }
  }
});

test("a TokenCache entry within five minutes of expiry is not used", async () => {
  // Each row is expiresAt minus now, with the boundary inclusive as for the memory cache.
  const usable = [3_600_000, 600_000, FIVE_MINUTES_MS + 1];
  const tooLate = [FIVE_MINUTES_MS, FIVE_MINUTES_MS - 1, 60_000, 1, 0, -1, -86_400_000];

  for (const now of NOWS) {
    for (const remaining of usable) {
      const label = `${remaining} ms left at ${now}`;
      const store = memoryCache({ token: "cached-token", expiresAt: now + remaining });
      const server = numberedTokens();
      assert.equal(await authFor(server, { ms: now }, { cache: store.cache }).getToken(), "cached-token", label);
      assert.equal(server.calls.length, 0, label);
    }

    for (const remaining of tooLate) {
      const label = `${remaining} ms left at ${now}`;
      const store = memoryCache({ token: "cached-token", expiresAt: now + remaining });
      const server = numberedTokens();
      assert.equal(await authFor(server, { ms: now }, { cache: store.cache }).getToken(), "token-1", label);
      assert.equal(server.calls.length, 1, label);
      assert.deepEqual(store.writes.at(-1)?.value, { token: "token-1", expiresAt: now + 3_600_000 }, label);

      // The replacement is what the next instance finds.
      const next = numberedTokens();
      assert.equal(await authFor(next, { ms: now }, { cache: store.cache }).getToken(), "token-1", label);
      assert.equal(next.calls.length, 0, label);
    }
  }
});

test("the TokenCache key separates client emails and scopes", async () => {
  const first = { email: EMAIL, scopes: [SPREADSHEETS] };
  const others: [string, AuthOptions][] = [
    ["another client email", { email: OTHER_EMAIL, scopes: [SPREADSHEETS] }],
    ["an email that extends the first", { email: `${EMAIL}.test`, scopes: [SPREADSHEETS] }],
    ["another scope", { email: EMAIL, scopes: [DRIVE_READONLY] }],
    ["one more scope", { email: EMAIL, scopes: [SPREADSHEETS, DRIVE_READONLY] }],
  ];
  for (const [label, other] of others) {
    const clock = { ms: NOW };
    const store = memoryCache();
    const { cache } = store;
    const serverA = tokenServer(() => tokenResponse("token-a"));
    const serverB = tokenServer(() => tokenResponse("token-b"));

    assert.equal(await authFor(serverA, clock, { ...first, cache }).getToken(), "token-a", label);
    assert.equal(await authFor(serverB, clock, { ...other, cache }).getToken(), "token-b", label);
    assert.equal(serverB.calls.length, 1, label);
    assert.notEqual(store.writes[0].key, store.writes[1].key, label);

    // Neither entry replaced the other.
    const none = numberedTokens();
    assert.equal(await authFor(none, clock, { ...first, cache }).getToken(), "token-a", label);
    assert.equal(await authFor(none, clock, { ...other, cache }).getToken(), "token-b", label);
    assert.equal(none.calls.length, 0, label);
  }
});

test("token errors do not leak the key", async () => {
  const google = (error: string, description: string) => JSON.stringify({ error, error_description: description });
  // [label, status, body given the assertion, Google's error field]. The bodies that quote the assertion are the
  // reason a raw body cannot go into the message: the ticket says never, whatever the other side sends back.
  const rows: [string, number, (assertion: string) => string, string | null][] = [
    ["bad signature", 400, () => google("invalid_grant", "Invalid JWT Signature."), "invalid_grant"],
    ["unknown scope", 400, () => google("invalid_scope", "Bad scope."), "invalid_scope"],
    ["unknown client", 401, () => google("invalid_client", "The OAuth client was not found."), "invalid_client"],
    ["denied", 403, () => google("access_denied", "Denied."), "access_denied"],
    ["rate limited", 429, () => google("rate_limit_exceeded", "Slow down."), "rate_limit_exceeded"],
    ["server error", 500, () => google("internal_failure", "Try again."), "internal_failure"],
    ["unavailable", 503, () => google("temporarily_unavailable", "Try again."), "temporarily_unavailable"],
    ["no description", 400, () => JSON.stringify({ error: "invalid_request" }), "invalid_request"],
    ["description quoting the assertion", 400, (a) => google("invalid_target", `Bad JWT ${a}`), "invalid_target"],
    ["no error field", 500, () => "{}", null],
    ["HTML", 502, () => "<html><body>Bad Gateway</body></html>", null],
    ["empty body", 503, () => "", null],
    ["text quoting the assertion", 502, (a) => `upstream refused assertion=${a}`, null],
  ];

  for (const [label, status, body, field] of rows) {
    const store = memoryCache();
    const server = tokenServer((_call, assertion) => new Response(body(assertion), { status }));

    const error = await rejection(authFor(server, { ms: NOW }, { cache: store.cache }).getToken());

    assert.ok(error instanceof Error, label);
    assert.match(error.message, new RegExp(`\\b${status}\\b`), label);
    if (field !== null) {
      assert.ok(error.message.includes(field), `${label}: ${error.message}`);
    }
    assertNoSecrets(error, secretsOf(server.calls[0].assertion), label);
    assert.equal(store.writes.length, 0, label);
  }
});

test("a 200 without an access_token throws a clean error", async () => {
  const bodies: [string, string][] = [
    ["no access_token", JSON.stringify({ expires_in: 3600, token_type: "Bearer" })],
    ["empty object", "{}"],
    ["empty access_token", JSON.stringify({ access_token: "", expires_in: 3600 })],
    ["null access_token", JSON.stringify({ access_token: null, expires_in: 3600 })],
    ["JSON null", "null"],
    ["HTML", "<html><body>Sign in</body></html>"],
    ["empty body", ""],
  ];
  for (const [label, body] of bodies) {
    const store = memoryCache();
    const server = tokenServer(() => new Response(body, { status: 200 }));

    const error = await rejection(authFor(server, { ms: NOW }, { cache: store.cache }).getToken());

    assert.ok(error instanceof Error, label);
    // A deliberate error, not a stray one from reading a field of null or parsing HTML.
    assert.ok(!(error instanceof TypeError) && !(error instanceof SyntaxError), `${label}: ${error.name}`);
    assertNoSecrets(error, secretsOf(server.calls[0].assertion), label);
    assert.equal(store.writes.length, 0, label);
  }
});

test("a failed token request is not remembered", async () => {
  const failures: [string, () => Response][] = [
    ["a 500", () => new Response("{}", { status: 500 })],
    ["a 400", () => Response.json({ error: "invalid_grant" }, { status: 400 })],
    ["a 200 without a token", () => Response.json({})],
    [
      "a rejected fetch",
      () => {
        throw new TypeError("network connection lost");
      },
    ],
  ];
  for (const [label, failure] of failures) {
    const server = tokenServer((call) => (call === 1 ? failure() : tokenResponse("recovered")));
    const auth = authFor(server, { ms: NOW });

    await assert.rejects(auth.getToken(), label);
    assert.equal(await auth.getToken(), "recovered", label);
    assert.equal(server.calls.length, 2, label);
  }
});
