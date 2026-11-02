// HMAC, hashing, references and the signed envelope shared with the sheet's Apps Script. Expected digests come from the
// RFC and FIPS vectors or from node:crypto, so an envelope is built here the way the Apps Script side builds it.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  hmacSha256Base64,
  hmacSha256Hex,
  randomRef,
  sha256Hex,
  signEnvelope,
  timingSafeEqual,
  verifyEnvelope,
} from "../src/lib/crypto.ts";

const SECRET = "sheet-secret";
const SKEW_MS = 300_000;
const NOW = Date.UTC(2026, 9, 31, 15);
const NOWS = [NOW, 1_700_000_000_000, Date.UTC(2030, 0, 1, 1, 2, 3, 4)];

// Each differs in a way a shortcut would lose: falsy values, key order, escapes, multi-byte text.
const PAYLOADS: unknown[] = [
  { rows: [{ id: 1, name: "Cub" }], publishedBy: "staff" },
  { z: 1, a: 2 },
  [1, "two", null],
  "plain string",
  "",
  0,
  42.5,
  false,
  true,
  null,
  {},
  [],
  { name: "沖縄 🛵", note: 'quotes " and \\ backslash' },
];

function hexSig(secret: string, ts: unknown, payload: unknown): string {
  return createHmac("sha256", secret).update(`${ts}.${payload}`, "utf8").digest("hex");
}

/** The raw body the Apps Script sends: signed here with node:crypto, not with signEnvelope. */
function signedBody(secret: string, ts: number, payload: string): string {
  return JSON.stringify({ ts, payload, sig: hexSig(secret, ts, payload) });
}

test("hmacSha256Hex matches RFC 4231 test case 2", async () => {
  const digest = await hmacSha256Hex("Jefe", "what do ya want for nothing?");
  assert.equal(digest, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

test("hmacSha256Base64 matches RFC 4231 test cases 1 and 2", async () => {
  assert.equal(
    await hmacSha256Base64("Jefe", "what do ya want for nothing?"),
    "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=",
  );
  assert.equal(
    await hmacSha256Base64("\x0b".repeat(20), "Hi There"),
    Buffer.from("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7", "hex").toString("base64"),
  );
});

test("the HMAC helpers match RFC 4231 test case 1 and node:crypto over varied keys and messages", async () => {
  assert.equal(
    await hmacSha256Hex("\x0b".repeat(20), "Hi There"),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );

  const inputs: [string, string][] = [
    ["k", ""],
    ["k", "a"],
    ["Jefe", "what do ya want for nothing!"],
    ["jefe", "what do ya want for nothing?"],
    ["x".repeat(64), "a key of exactly one block"],
    ["x".repeat(65), "a key longer than one block"],
    ["x".repeat(200), "m".repeat(1000)],
    ["秘密の鍵", "沖縄のレンタルバイク 🏍️"],
    ["key with \n and \0", "message with \n and \0"],
  ];
  for (const [key, message] of inputs) {
    const label = `key ${JSON.stringify(key.slice(0, 12))}, message ${JSON.stringify(message.slice(0, 12))}`;
    const mac = createHmac("sha256", key).update(message, "utf8");
    const digest = mac.digest();
    assert.equal(await hmacSha256Hex(key, message), digest.toString("hex"), label);
    assert.equal(await hmacSha256Base64(key, message), digest.toString("base64"), label);
  }
});

test("sha256Hex matches the FIPS 180 vectors and node:crypto", async () => {
  assert.equal(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const text of ["a", "abd", "沖縄 🛵", "m".repeat(1000)]) {
    assert.equal(await sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"), text.slice(0, 12));
  }
});

test("timingSafeEqual returns false for strings of different lengths without throwing", () => {
  const hex = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
  const pairs: [string, string][] = [
    ["", "a"],
    ["abc", "ab"],
    ["abc", "abcd"],
    ["abc", "abcabc"],
    [hex, hex.slice(0, 63)],
    [hex, `${hex}0`],
    ["日本", "日本語"],
    ["é", "ee"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(timingSafeEqual(a, b), false, `${a} against ${b}`);
    assert.equal(timingSafeEqual(b, a), false, `${b} against ${a}`);
  }
});

test("timingSafeEqual compares every character of equal-length strings", () => {
  for (const text of ["", "a", "abc", "日本語", "🏍️", "x".repeat(1000)]) {
    assert.equal(timingSafeEqual(text, `${text}`), true, text.slice(0, 12));
  }

  const pairs: [string, string][] = [
    ["abc", "xbc"],
    ["abc", "axc"],
    ["abc", "abx"],
    ["a", "A"],
    // Differences that cancel out if they are summed, or vanish if each character is cut to a byte.
    ["ab", "ba"],
    ["ac", "bb"],
    ["š", "a"],
    ["Ā", "\u0000"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(timingSafeEqual(a, b), false, `${a} against ${b}`);
    assert.equal(timingSafeEqual(b, a), false, `${b} against ${a}`);
  }

  const hex = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
  assert.equal(timingSafeEqual(hex, `${hex}`), true);
  for (let i = 0; i < hex.length; i += 1) {
    const flipped = hex.slice(0, i) + (hex[i] === "0" ? "1" : "0") + hex.slice(i + 1);
    assert.equal(timingSafeEqual(hex, flipped), false, `flipped at ${i}`);
  }
});

test("randomRef gives 8 Crockford base32 characters without repeats over 10000 draws", () => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const shape = new RegExp(`^[${alphabet}]{8}$`);
  const draws = Array.from({ length: 10_000 }, () => randomRef());
  for (const ref of draws) {
    assert.equal(typeof ref, "string");
    assert.match(ref, shape);
  }
  assert.equal(new Set(draws).size, draws.length);

  // Every symbol turns up in every position, so a counter or a narrower alphabet fails. Over 10000 uniform draws the
  // odds of missing one symbol in one position are about e^-317.
  for (let position = 0; position < 8; position += 1) {
    const seen = new Set(draws.map((ref) => ref[position]));
    assert.equal(seen.size, alphabet.length, `position ${position} saw only ${[...seen].sort().join("")}`);
  }
});

test("randomRef does not draw from Math.random", (t) => {
  // t.mock restores Math.random when the test ends.
  t.mock.method(Math, "random", () => 0);
  const draws = Array.from({ length: 100 }, () => randomRef());
  assert.equal(new Set(draws).size, draws.length);
});

test("randomRef draws from crypto.getRandomValues", (t) => {
  // t.mock restores crypto.getRandomValues when the test ends. The fake returns the buffer, as the real method does.
  const spy = t.mock.method(globalThis.crypto, "getRandomValues", (buf) => buf.fill(0));
  assert.equal(randomRef(), randomRef());
  assert.ok(spy.mock.callCount() > 0);
});

test("signEnvelope sends ts, the JSON payload and the hex HMAC of ts.payload", async () => {
  for (const secret of [SECRET, "another secret", "秘密の鍵"]) {
    for (const now of NOWS) {
      for (const payload of PAYLOADS) {
        const json = JSON.stringify(payload);
        const envelope = await signEnvelope(secret, payload, now);
        assert.deepEqual(envelope, { ts: now, payload: json, sig: hexSig(secret, now, json) }, json);
      }
    }
  }
});

test("verifyEnvelope accepts a fresh envelope and returns its payload", async () => {
  for (const now of NOWS) {
    for (const payload of PAYLOADS) {
      const label = `${JSON.stringify(payload)} at ${now}`;
      const envelope = await signEnvelope(SECRET, payload, now);
      const fromSignEnvelope = await verifyEnvelope(SECRET, JSON.stringify(envelope), now);
      assert.deepEqual(fromSignEnvelope, { ok: true, payload }, label);

      // What the Apps Script sends is accepted too, so the two helpers cannot share a private format.
      const fromAppsScript = await verifyEnvelope(SECRET, signedBody(SECRET, now, JSON.stringify(payload)), now);
      assert.deepEqual(fromAppsScript, { ok: true, payload }, label);
    }
  }

  // The signature covers the payload text as sent, and the body is parsed, not sliced.
  const spaced = '{ "b" : 1,\n  "a" : 2 }';
  const accepted = await verifyEnvelope(SECRET, signedBody(SECRET, NOW, spaced), NOW);
  assert.deepEqual(accepted, { ok: true, payload: { b: 1, a: 2 } });
  const reordered = JSON.stringify({ sig: hexSig(SECRET, NOW, "[1]"), payload: "[1]", ts: NOW });
  assert.deepEqual(await verifyEnvelope(SECRET, reordered, NOW), { ok: true, payload: [1] });
  const indented = JSON.stringify(JSON.parse(signedBody(SECRET, NOW, "[2]")), null, 2);
  assert.deepEqual(await verifyEnvelope(SECRET, indented, NOW), { ok: true, payload: [2] });

  // Up to and including the allowed skew, on either side of now. [offset of ts from now, maxSkewMs]
  const insideWindow: [number, number | undefined][] = [
    [-SKEW_MS, undefined],
    [-SKEW_MS + 1, undefined],
    [-1, undefined],
    [1, undefined],
    [SKEW_MS - 1, undefined],
    [SKEW_MS, undefined],
    [-1000, 1000],
    [1000, 1000],
    [0, 0],
    [-599_999, 600_000],
    [600_000, 600_000],
  ];
  for (const now of NOWS) {
    for (const [offset, maxSkewMs] of insideWindow) {
      const result = await verifyEnvelope(SECRET, signedBody(SECRET, now + offset, '{"n":7}'), now, maxSkewMs);
      assert.deepEqual(result, { ok: true, payload: { n: 7 } }, `offset ${offset}, skew ${maxSkewMs}, now ${now}`);
    }
  }
});

test("verifyEnvelope rejects tampering, another secret, skew and malformed bodies", async () => {
  const text = '{"rows":[1,2,3]}';
  const sig = hexSig(SECRET, NOW, text);
  const macOf = (message: string) => createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
  const rejects = async (bodyText: string, reason: string, label: string, now = NOW, maxSkewMs?: number) => {
    assert.deepEqual(await verifyEnvelope(SECRET, bodyText, now, maxSkewMs), { ok: false, reason }, label);
  };
  const forged = "0".repeat(64);
  const staleTs = NOW - 2 * SKEW_MS;
  const futureTs = NOW + 2 * SKEW_MS;

  // A body with several faults gets the reason of the first check it fails, in this order: body shape, signature,
  // freshness, then JSON-parsing the payload. Nothing unauthenticated influences the outcome beyond shape.

  // Tampering: each body is well formed and its signature is wrong, so bad_signature wins over everything after it.
  const tampered: [string, unknown][] = [
    ["payload changed", { ts: NOW, payload: '{"rows":[1,2,4]}', sig }],
    ["payload respaced to the same JSON value", { ts: NOW, payload: '{"rows": [1,2,3]}', sig }],
    ["ts moved inside the window", { ts: NOW + 1, payload: text, sig }],
    ["an old signature on a fresh ts", { ts: NOW, payload: text, sig: hexSig(SECRET, NOW - 2 * SKEW_MS, text) }],
    ["sig one character short", { ts: NOW, payload: text, sig: sig.slice(0, -1) }],
    ["sig one character long", { ts: NOW, payload: text, sig: `${sig}0` }],
    ["sig of a few characters", { ts: NOW, payload: text, sig: "abc" }],
    ["sig that is not hex", { ts: NOW, payload: text, sig: "z".repeat(64) }],
    ["sig over the payload alone", { ts: NOW, payload: text, sig: macOf(text) }],
    ["sig with another separator", { ts: NOW, payload: text, sig: macOf(`${NOW}:${text}`) }],
    // Signature before parsing the payload.
    ["payload changed to text that is not JSON", { ts: NOW, payload: "not json", sig }],
    ["payload changed to the empty string", { ts: NOW, payload: "", sig }],
    // Signature before freshness.
    ["stale ts with a forged sig", { ts: staleTs, payload: text, sig: forged }],
    ["future ts with a forged sig", { ts: futureTs, payload: text, sig: forged }],
    ["ts moved back out of the window under the original sig", { ts: staleTs, payload: text, sig }],
    ["ts moved ahead out of the window under the original sig", { ts: futureTs, payload: text, sig }],
    // All three at once.
    ["stale ts, forged sig, payload that is not JSON", { ts: staleTs, payload: "not json", sig: forged }],
    ["future ts, forged sig, empty payload", { ts: futureTs, payload: "", sig: forged }],
  ];
  for (const [label, body] of tampered) {
    await rejects(JSON.stringify(body), "bad_signature", label);
  }
  for (let i = 0; i < sig.length; i += 1) {
    const flipped = sig.slice(0, i) + (sig[i] === "0" ? "1" : "0") + sig.slice(i + 1);
    await rejects(JSON.stringify({ ts: NOW, payload: text, sig: flipped }), "bad_signature", `sig flipped at ${i}`);
  }

  // Another secret, either way round.
  for (const other of ["sheet-secreT", "sheet-secret ", "sheet-secre", "another secret", "秘密の鍵"]) {
    await rejects(signedBody(other, NOW, text), "bad_signature", `signed with ${other}`);
    assert.deepEqual(
      await verifyEnvelope(other, signedBody(SECRET, NOW, text), NOW),
      { ok: false, reason: "bad_signature" },
      `verified with ${other}`,
    );
    const envelope = await signEnvelope(other, { rows: [1] }, NOW);
    await rejects(JSON.stringify(envelope), "bad_signature", `signEnvelope with ${other}`);
  }

  // Skew: correctly signed, too old or too far ahead, and stale wins over a payload that is not JSON.
  // [offset of ts from now, maxSkewMs]
  const outsideWindow: [number, number | undefined][] = [
    [-SKEW_MS - 1, undefined],
    [SKEW_MS + 1, undefined],
    [-3_600_000, undefined],
    [3_600_000, undefined],
    [-86_400_000, undefined],
    [86_400_000, undefined],
    [-1001, 1000],
    [1001, 1000],
    [-1, 0],
    [1, 0],
    [-600_001, 600_000],
    [600_001, 600_000],
  ];
  for (const now of NOWS) {
    for (const [offset, maxSkewMs] of outsideWindow) {
      const label = `offset ${offset}, skew ${maxSkewMs}, now ${now}`;
      await rejects(signedBody(SECRET, now + offset, text), "stale", label, now, maxSkewMs);
      await rejects(signedBody(SECRET, now + offset, "not json"), "stale", `${label}, not JSON`, now, maxSkewMs);
      await rejects(signedBody(SECRET, now + offset, ""), "stale", `${label}, empty payload`, now, maxSkewMs);
    }
  }

  // Malformed bodies resolve with a reason, never reject. The wrong-type rows carry the signature a coercing verifier
  // would compute for them, so only a type check can turn them away.
  const good = { ts: NOW, payload: text, sig };
  const malformed: [string, string][] = [
    ["empty body", ""],
    ["not JSON", "not json"],
    ["truncated JSON", JSON.stringify(good).slice(0, -1)],
    ["JSON null", "null"],
    ["JSON number", "123"],
    ["JSON string", '"abc"'],
    ["JSON boolean", "true"],
    ["JSON array of the fields", JSON.stringify([good.ts, good.payload, good.sig])],
    ["array holding the envelope", JSON.stringify([good])],
    ["empty object", "{}"],
    ["no ts", JSON.stringify({ payload: text, sig })],
    ["no payload", JSON.stringify({ ts: NOW, sig })],
    ["no sig", JSON.stringify({ ts: NOW, payload: text })],
    ["ts null", JSON.stringify({ ...good, ts: null })],
    ["ts as a string", JSON.stringify({ ...good, ts: String(NOW) })],
    ["ts as an array", JSON.stringify({ ...good, ts: [NOW] })],
    ["payload null", JSON.stringify({ ts: NOW, payload: null, sig: hexSig(SECRET, NOW, null) })],
    ["payload as a number", JSON.stringify({ ts: NOW, payload: 123, sig: hexSig(SECRET, NOW, 123) })],
    ["payload as an object", JSON.stringify({ ts: NOW, payload: { a: 1 }, sig: hexSig(SECRET, NOW, { a: 1 }) })],
    ["sig null", JSON.stringify({ ...good, sig: null })],
    ["sig as a number", JSON.stringify({ ...good, sig: 123 })],
    ["sig as an array", JSON.stringify({ ...good, sig: [sig] })],
    // Correctly signed and fresh, but the payload is not the JSON text signEnvelope writes.
    ["signed payload that is not JSON", signedBody(SECRET, NOW, "not json")],
    ["signed empty payload", signedBody(SECRET, NOW, "")],
    // Shape comes first, so a wrong-type field stays malformed when the sig is also forged or the ts also stale.
    ["payload as a number, forged sig", JSON.stringify({ ts: NOW, payload: 123, sig: forged })],
    ["payload as a number, stale ts", JSON.stringify({ ts: staleTs, payload: 123, sig: hexSig(SECRET, staleTs, 123) })],
    ["ts as a string, forged sig", JSON.stringify({ ts: String(NOW), payload: text, sig: forged })],
    [
      "ts as a string, stale",
      JSON.stringify({ ts: String(staleTs), payload: text, sig: hexSig(SECRET, staleTs, text) }),
    ],
    ["no sig, stale ts", JSON.stringify({ ts: staleTs, payload: text })],
  ];
  for (const [label, bodyText] of malformed) {
    await rejects(bodyText, "malformed", label);
  }

  // Refused whichever reason an implementation gives.
  const refused: [string, string][] = [
    ["empty sig", JSON.stringify({ ...good, sig: "" })],
    ["infinite ts", `{"ts":1e999,"payload":${JSON.stringify(text)},"sig":"${sig}"}`],
  ];
  for (const [label, bodyText] of refused) {
    const result = await verifyEnvelope(SECRET, bodyText, NOW);
    assert.equal(result.ok, false, label);
  }
});

test("a valid signature in another case is bad_signature", async () => {
  const payload = { rows: [1, 2, 3] };
  const envelope = await signEnvelope(SECRET, payload, NOW);
  assert.deepEqual(await verifyEnvelope(SECRET, JSON.stringify(envelope), NOW), { ok: true, payload });

  // A digest of digits alone would have no other case, and this row would compare the signature with itself.
  const upper = envelope.sig.toUpperCase();
  assert.notEqual(upper, envelope.sig);
  assert.deepEqual(await verifyEnvelope(SECRET, JSON.stringify({ ...envelope, sig: upper }), NOW), {
    ok: false,
    reason: "bad_signature",
  });
});
