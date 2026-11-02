// verifySquareSignature against forged and tampered notifications. Every signature is built here with node:crypto, the
// way Square signs a notification: the base64 HMAC-SHA256 of the notification URL followed by the raw body.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { verifySquareSignature } from "../src/lib/square/webhook-signature.ts";

const NOTIFICATION_URL = "https://okinawa-dream.example/api/webhooks/square";

function squareSignature(key: string, notificationUrl: string, rawBody: string): string {
  return createHmac("sha256", key).update(notificationUrl + rawBody, "utf8").digest("base64");
}

function verify(signatureKey: string, notificationUrl: string, rawBody: string, signature: string | null) {
  return verifySquareSignature({ signatureKey, notificationUrl, rawBody, signature });
}

/** A payment.updated notification, with fresh ids so that no signature can be stored ahead of the run. */
function notification(): string {
  const payment = {
    id: `pay_${randomUUID()}`,
    status: "COMPLETED",
    reference_id: randomUUID(),
    amount_money: { amount: 5000, currency: "JPY" },
  };
  return JSON.stringify({
    merchant_id: "MERCHANT",
    type: "payment.updated",
    event_id: randomUUID(),
    created_at: "2026-11-02T01:02:03Z",
    data: { type: "payment", id: payment.id, object: { payment } },
  });
}

test("accepts a valid signature and rejects tampering", async () => {
  // [key, notification URL, raw body]
  const valid: [string, string, string][] = [
    [randomUUID(), NOTIFICATION_URL, notification()],
    [randomUUID(), NOTIFICATION_URL, notification()],
    [randomUUID(), "http://localhost:4321/api/webhooks/square", notification()],
    [randomUUID(), "https://a-tunnel.trycloudflare.com/api/webhooks/square?source=square&x=1", notification()],
    // The raw text is what was signed: spacing, key order and a final newline all stay.
    [randomUUID(), NOTIFICATION_URL, '{ "b" : 1,\n  "a" : 2 }\n'],
    ["秘密の鍵", NOTIFICATION_URL, '{"note":"沖縄のレンタルバイク 🏍️"}'],
    ["k".repeat(65), NOTIFICATION_URL, "m".repeat(5000)],
  ];
  for (const [key, url, body] of valid) {
    const label = `${url}, body ${JSON.stringify(body.slice(0, 20))}`;
    assert.equal(await verify(key, url, body, squareSignature(key, url, body)), true, label);
  }

  const key = `wbhk-${randomUUID()}`;
  const body = notification();
  const signature = squareSignature(key, NOTIFICATION_URL, body);
  assert.equal(await verify(key, NOTIFICATION_URL, body, signature), true);

  const parsed: unknown = JSON.parse(body);
  const changedBodies = [
    body.replace("5000", "5001"),
    body.replace("COMPLETED", "FAILED"),
    body.replace("payment.updated", "refund.updated"),
    `${body} `,
    `${body}\n`,
    ` ${body}`,
    body.slice(0, -1),
    "",
    // The same JSON value in another text is still another body.
    JSON.stringify(parsed, null, 2),
    JSON.stringify(Object.fromEntries(Object.entries(parsed as object).reverse())),
  ];
  for (const changed of changedBodies) {
    assert.notEqual(changed, body);
    assert.equal(await verify(key, NOTIFICATION_URL, changed, signature), false, `body ${changed.slice(0, 40)}`);
  }

  // The URL must equal SQUARE_WEBHOOK_URL exactly, so forms that normalise to the same address are refused too.
  const changedUrls = [
    NOTIFICATION_URL.replace("https:", "http:"),
    `${NOTIFICATION_URL}/`,
    `${NOTIFICATION_URL}?`,
    `${NOTIFICATION_URL}?retry=1`,
    `${NOTIFICATION_URL}#top`,
    NOTIFICATION_URL.replace("/square", "/Square"),
    NOTIFICATION_URL.replace("okinawa-dream", "OKINAWA-DREAM"),
    NOTIFICATION_URL.replace(".example", ".example:443"),
    NOTIFICATION_URL.replace("okinawa-dream", "okinawa-scheme"),
    "http://localhost:4321/api/webhooks/square",
    "",
  ];
  for (const changed of changedUrls) {
    assert.equal(await verify(key, changed, body, signature), false, `URL ${changed}`);
  }

  const changedKeys = [`${key} `, ` ${key}`, key.slice(0, -1), key.toUpperCase(), randomUUID(), "秘密の鍵"];
  for (const changed of changedKeys) {
    assert.equal(await verify(changed, NOTIFICATION_URL, body, signature), false, `verified under ${changed}`);
    const forged = squareSignature(changed, NOTIFICATION_URL, body);
    assert.equal(await verify(key, NOTIFICATION_URL, body, forged), false, `signed with ${changed}`);
  }

  const message = NOTIFICATION_URL + body;
  const hmac = (text: string) => createHmac("sha256", key).update(text, "utf8");
  const forgeries: [string, string][] = [
    ["over the body alone", hmac(body).digest("base64")],
    ["over the URL alone", hmac(NOTIFICATION_URL).digest("base64")],
    ["over the body then the URL", hmac(body + NOTIFICATION_URL).digest("base64")],
    ["with a dot between the URL and the body", hmac(`${NOTIFICATION_URL}.${body}`).digest("base64")],
    ["with a newline between the URL and the body", hmac(`${NOTIFICATION_URL}\n${body}`).digest("base64")],
    ["in hex", hmac(message).digest("hex")],
    ["in base64url", hmac(message).digest("base64url")],
    ["without its padding", signature.replace(/=+$/, "")],
    ["an unkeyed SHA-256", createHash("sha256").update(message, "utf8").digest("base64")],
    ["an HMAC-SHA1", createHmac("sha1", key).update(message, "utf8").digest("base64")],
    ["after a space", ` ${signature}`],
    ["before a space", `${signature} `],
    ["with a scheme prefix", `sha256=${signature}`],
    ["in lower case", signature.toLowerCase()],
    ["in upper case", signature.toUpperCase()],
    ["one character short", signature.slice(0, -1)],
    ["one character long", `${signature}A`],
    ["twice over", signature + signature],
    ["of the right length, not base64", "!".repeat(signature.length)],
    ["of the right length, multi-byte", "署".repeat(signature.length)],
  ];
  for (const [label, forged] of forgeries) {
    assert.notEqual(forged, signature, label);
    assert.equal(await verify(key, NOTIFICATION_URL, body, forged), false, label);
  }
  for (let i = 0; i < signature.length; i += 1) {
    const flipped = signature.slice(0, i) + (signature[i] === "A" ? "B" : "A") + signature.slice(i + 1);
    assert.equal(await verify(key, NOTIFICATION_URL, body, flipped), false, `flipped at ${i}`);
  }
});

test("a missing signature or signature key is refused without throwing", async () => {
  const key = randomUUID();
  const body = notification();
  // Headers.get gives null when the header is absent.
  assert.equal(await verify(key, NOTIFICATION_URL, body, null), false);
  assert.equal(await verify(key, NOTIFICATION_URL, body, ""), false);
  assert.equal(await verify("", NOTIFICATION_URL, body, null), false);

  // An unset secret must not become a key anyone can sign with.
  assert.equal(await verify("", NOTIFICATION_URL, body, squareSignature("", NOTIFICATION_URL, body)), false);
  assert.equal(await verify("", NOTIFICATION_URL, body, ""), false);
});
