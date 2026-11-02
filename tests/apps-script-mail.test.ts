// The mail web app: doPost in node:vm against fake Google services, with every POST a new execution. Envelopes come
// from the Worker's real signEnvelope, so a format that drifts on one side fails here, and each test moves the script's
// clock by hand. Expected values are written out here, never read from the script. The text of `error` is free: tests
// only require one. Whether a refused envelope is retryable is left open too, except where the ticket says.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hmacSha256Hex, signEnvelope } from "../src/lib/crypto.ts";
import { loadWebApp, type WebApp, type WebAppOptions, type WebReply } from "./helpers/apps-script.ts";

const SECRET = "mail-secret-one";
const PUBLISH_SECRET = "publish-secret-one";

const T0 = Date.UTC(2027, 2, 9, 1, 30, 15);

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const WINDOW_MS = 5 * MINUTE_MS;

type Message = { messageId: string; to: string; subject: string; text: string; html: string; replyTo?: string };

type Answer = { ok?: unknown; error?: unknown; retryable?: unknown; remainingQuota?: unknown };

const MESSAGE: Message = {
  messageId: "email:guest_confirmation:bkg-7K2MQ9XA",
  to: "higa@example.jp",
  subject: "ご予約ありがとうございます 7K2MQ9XA",
  text: "沖縄でお待ちしております。\nキャンセル: https://example.dev/cancel?b=7K2&t=a+b%20c",
  html: '<p lang="ja">沖縄でお待ちしております 🛵 <a href="https://example.dev/cancel?b=7K2&amp;t=a+b%20c">取消</a></p>',
  replyTo: "shop@okinawa-dream.example",
};

const MESSAGES: Message[] = [
  MESSAGE,
  {
    messageId: "email:staff_new_booking:bkg-B3TZ8VWN",
    to: "staff@okinawa-dream.example",
    subject: "New booking B3TZ8VWN",
    text: "Plain ASCII, one line.",
    html: "<b>Plain ASCII, one line.</b>",
  },
  {
    messageId: "email:guest_cancellation:bkg-2HRP5GDY",
    to: "guest+tag@example.com",
    subject: 'Quotes " and \\ backslash',
    text: 'He said "予約" \\o/\r\n\ttabbed',
    html: `<p title="a'b">¥12,000 &amp; 한국어 中文</p>`,
    replyTo: "help@example.jp",
  },
];

const SECRETS = [SECRET, "another-secret-2", "s3cret with spaces & symbols", "秘密の鍵-沖縄"];

function webApp(overrides: Partial<WebAppOptions> = {}): WebApp {
  return loadWebApp({ properties: { MAIL_SECRET: SECRET, PUBLISH_SECRET }, now: T0, ...overrides });
}

/** The body the Worker posts: the real signEnvelope, at `ts`. */
async function signed(message: Message, ts: number, secret = SECRET): Promise<string> {
  return JSON.stringify(await signEnvelope(secret, message, ts));
}

/** A correctly signed envelope around payload text that signEnvelope would not write. */
async function signedText(text: string, ts = T0): Promise<string> {
  return JSON.stringify({ ts, payload: text, sig: await hmacSha256Hex(SECRET, `${ts}.${text}`) });
}

/** An envelope signed with an empty key, which an attacker can make though signEnvelope's WebCrypto refuses it. */
function signedWithNoKey(message: Message, ts: number): string {
  const payload = JSON.stringify(message);
  return JSON.stringify({ ts, payload, sig: createHmac("sha256", "").update(`${ts}.${payload}`).digest("hex") });
}

/** The same signed envelope in other JSON whitespace: the same ts, payload and sig, so a replay all the same. */
function reformatted(envelope: string): string {
  return JSON.stringify(JSON.parse(envelope), null, 1);
}

function answerOf(reply: WebReply, label: string): Answer {
  assert.equal(reply.mimeType, "JSON", `${label}: served as JSON`);
  assert.ok(!reply.text.includes(SECRET), `${label}: the secret stays out of the answer`);
  const answer = JSON.parse(reply.text) as unknown;
  assert.ok(typeof answer === "object" && answer !== null, `${label}: ${reply.text}`);
  return answer;
}

function assertAccepted(reply: WebReply, label: string): Answer {
  const answer = answerOf(reply, label);
  assert.equal(answer.ok, true, `${label}: ${reply.text}`);
  return answer;
}

function assertRefused(reply: WebReply, label: string): Answer {
  const answer = answerOf(reply, label);
  assert.equal(answer.ok, false, `${label}: ${reply.text}`);
  assert.equal(typeof answer.retryable, "boolean", `${label}: ${reply.text}`);
  assert.equal(typeof answer.error, "string", `${label}: ${reply.text}`);
  assert.notEqual(answer.error, "", `${label}: ${reply.text}`);
  return answer;
}

function assertDelivered(mail: Record<string, unknown>, message: Message): void {
  assert.equal(mail.to, message.to);
  assert.equal(mail.subject, message.subject);
  assert.equal(mail.body, message.text);
  assert.equal(mail.htmlBody, message.html);
  assert.equal(mail.name, "Okinawa Dream");
  assert.equal(mail.replyTo ?? "", message.replyTo ?? "");
}

/** Bodies an attacker could send, none of them signed with the secret over what they carry. */
async function forgedBodies(): Promise<{ name: string; body: string }[]> {
  const good = await signEnvelope(SECRET, MESSAGE, T0);
  const changed = (fields: Record<string, unknown>) => JSON.stringify({ ...good, ...fields });
  const flippedFirst = good.sig.startsWith("0") ? "1" : "0";
  return [
    { name: "another secret", body: await signed(MESSAGE, T0, "mail-secret-two") },
    { name: "the publish secret", body: await signed(MESSAGE, T0, PUBLISH_SECRET) },
    { name: "an empty secret", body: signedWithNoKey(MESSAGE, T0) },
    { name: "a new recipient", body: changed({ payload: JSON.stringify({ ...MESSAGE, to: "attacker@example.net" }) }) },
    { name: "a new body", body: changed({ payload: JSON.stringify({ ...MESSAGE, html: "<a href=x>Pay here</a>" }) }) },
    { name: "a moved timestamp", body: changed({ ts: T0 + 1 }) },
    { name: "a flipped signature", body: changed({ sig: flippedFirst + good.sig.slice(1) }) },
    { name: "half a signature", body: changed({ sig: good.sig.slice(0, 32) }) },
    { name: "an empty signature", body: changed({ sig: "" }) },
    { name: "a signature of the payload alone", body: changed({ sig: await hmacSha256Hex(SECRET, good.payload) }) },
    { name: "a signature in a list", body: changed({ sig: [good.sig] }) },
    { name: "a numeric signature", body: changed({ sig: 12345 }) },
    { name: "no signature", body: changed({ sig: undefined }) },
    { name: "no timestamp", body: changed({ ts: undefined }) },
    { name: "a timestamp in a string", body: changed({ ts: String(T0) }) },
    { name: "a null timestamp", body: changed({ ts: null }) },
    { name: "no payload", body: changed({ payload: undefined }) },
    { name: "a payload that is an object", body: changed({ payload: MESSAGE }) },
  ];
}

test("doPost sends a correctly signed message once", async () => {
  for (const [index, secret] of SECRETS.entries()) {
    for (const message of MESSAGES) {
      const quota = 3 + 17 * index;
      const label = `${secret}, ${message.messageId}`;
      const app = webApp({ properties: { MAIL_SECRET: secret }, quota });

      const { remainingQuota } = assertAccepted(app.post(await signed(message, T0, secret)), label);

      assert.equal(app.state.sent.length, 1, label);
      assertDelivered(app.state.sent[0], message);
      assert.ok(remainingQuota === quota || remainingQuota === quota - 1, `${label}: quota ${String(remainingQuota)}`);

      app.state.now = T0 + SECOND_MS;
      assertAccepted(app.post(await signed(message, app.state.now, secret)), `${label}, again`);
      assert.equal(app.state.sent.length, 1, `${label}: once`);
    }
  }
});

test("bad, stale and replayed envelopes are refused", async () => {
  for (const { name, body } of await forgedBodies()) {
    const app = webApp();
    assertRefused(app.post(body), name);
    assert.equal(app.state.sendCalls, 0, `${name}: nothing was sent`);

    // A forgery leaves nothing behind, so it cannot use up the messageId of the real email.
    assert.deepEqual([...app.state.cache.keys()], [], `${name}: the cache stays empty`);
    assertAccepted(app.post(await signed(MESSAGE, T0 + 1)), `${name}, then the real one`);
    assert.equal(app.state.sent.length, 1, name);
    assertDelivered(app.state.sent[0], MESSAGE);
  }

  const good = await signEnvelope(SECRET, MESSAGE, T0);
  const wrongSig = webApp().post(JSON.stringify({ ...good, sig: "0".repeat(good.sig.length) }));
  assert.ok(!wrongSig.text.includes(good.sig), "the answer does not show the signature it wanted");

  for (const ts of [
    T0 - WINDOW_MS - 1,
    T0 + WINDOW_MS + 1,
    T0 - 6 * MINUTE_MS,
    T0 + 6 * MINUTE_MS,
    T0 - 6 * HOUR_MS,
    T0 + 6 * HOUR_MS,
    0,
  ]) {
    const app = webApp();
    assertRefused(app.post(await signed(MESSAGE, ts)), `signed ${ts - T0} ms away`);
    assert.equal(app.state.sendCalls, 0, `signed ${ts - T0} ms away: nothing was sent`);
  }

  const app = webApp();
  const captured = await signed(MESSAGE, T0);
  assertAccepted(app.post(captured), "the original");
  for (const later of [0, SECOND_MS, MINUTE_MS, WINDOW_MS, WINDOW_MS + 1]) {
    app.state.now = T0 + later;
    assertRefused(app.post(captured), `replayed ${later} ms later`);
    assert.equal(app.state.sent.length, 1, `replayed ${later} ms later: nothing more was sent`);
    assertRefused(app.post(reformatted(captured)), `reformatted, replayed ${later} ms later`);
    assert.equal(app.state.sent.length, 1, `reformatted, replayed ${later} ms later: nothing more was sent`);
  }

  // A replay is the same signed envelope again, however it is formatted and whatever became of it the first time. The
  // Worker re-signs every attempt, so its retry is a new envelope and still sends.
  const firstTries: { name: string; options: Partial<WebAppOptions> }[] = [
    { name: "refused for quota", options: { quota: 0 } },
    { name: "failed in MailApp", options: { sendFailures: ["Service error: MailApp"] } },
  ];
  for (const { name, options } of firstTries) {
    const retried = webApp(options);
    const envelope = await signed(MESSAGE, T0);
    assertRefused(retried.post(envelope), name);

    retried.state.quota = 100;
    retried.state.now = T0 + MINUTE_MS;
    assertRefused(retried.post(envelope), `${name}, then replayed`);
    assert.equal(retried.state.sent.length, 0, `${name}: the replay sent nothing`);
    assertRefused(retried.post(reformatted(envelope)), `${name}, then reformatted and replayed`);
    assert.equal(retried.state.sent.length, 0, `${name}: the reformatted replay sent nothing`);

    assertAccepted(retried.post(await signed(MESSAGE, retried.state.now)), `${name}, then re-signed`);
    assert.equal(retried.state.sent.length, 1, `${name}: the re-signed retry sent`);
    assertDelivered(retried.state.sent[0], MESSAGE);
  }

  // A retry that dedupe answered is an envelope seen too, though nothing was sent for it.
  const deduped = webApp();
  assertAccepted(deduped.post(await signed(MESSAGE, T0)), "the first envelope");
  deduped.state.now = T0 + MINUTE_MS;
  const retry = await signed(MESSAGE, deduped.state.now);
  assertAccepted(deduped.post(retry), "a retry after a lost answer");
  assertRefused(deduped.post(retry), "that retry, replayed");
  assert.equal(deduped.state.sent.length, 1);

  // An envelope signed 5 minutes ahead stays fresh for almost 10, so what records it has to last that long.
  const ahead = webApp({ quota: 0 });
  const early = await signed(MESSAGE, T0 + WINDOW_MS);
  assertRefused(ahead.post(early), "signed 5 minutes ahead");
  ahead.state.quota = 100;
  ahead.state.now = T0 + 2 * WINDOW_MS - SECOND_MS;
  assertRefused(ahead.post(early), "replayed while still fresh");
  assert.equal(ahead.state.sent.length, 0, "the replay sent nothing");
});

test("an envelope up to 5 minutes off is fresh, on either side", async () => {
  for (const offset of [0, 1, -1, 299_999, -299_999, WINDOW_MS, -WINDOW_MS]) {
    const app = webApp();
    assertAccepted(app.post(await signed(MESSAGE, T0 + offset)), `signed ${offset} ms away`);
    assert.equal(app.state.sent.length, 1, `signed ${offset} ms away`);
  }
});

test("a forged envelope cannot pass for a messageId already sent", async () => {
  for (const { name, body } of await forgedBodies()) {
    const app = webApp();
    assertAccepted(app.post(await signed(MESSAGE, T0)), name);
    assertRefused(app.post(body), name);
    assert.equal(app.state.sent.length, 1, name);
  }
});

test("a request that holds no envelope gets a JSON refusal, not an error page", () => {
  const events = [undefined, {}, { postData: null }, { postData: {} }, { postData: { contents: "" } }];
  for (const event of events) {
    const app = webApp();
    assertRefused(app.deliver(event), JSON.stringify(event) ?? "no event");
    assert.equal(app.state.sendCalls, 0);
  }
  for (const body of ["", "not json", "{", "null", "[]", "42", '"text"', "{}", '{"ts":1}', "<html></html>"]) {
    const app = webApp();
    assertRefused(app.post(body), body);
    assert.equal(app.state.sendCalls, 0, body);
  }
});

test("a signed payload that is not a whole message sends nothing", async () => {
  const fields = ["messageId", "to", "subject", "text", "html"];
  const texts = [
    "not json",
    "",
    "null",
    "[]",
    "42",
    '"text"',
    "{}",
    ...fields.map((field) => JSON.stringify({ ...MESSAGE, [field]: undefined })),
    JSON.stringify({ ...MESSAGE, messageId: "" }),
    JSON.stringify({ ...MESSAGE, messageId: 7 }),
    JSON.stringify({ ...MESSAGE, to: "" }),
    JSON.stringify({ ...MESSAGE, to: null }),
  ];
  for (const text of texts) {
    const app = webApp();
    assertRefused(app.post(await signedText(text)), text);
    assert.equal(app.state.sendCalls, 0, text);
  }
});

test("a messageId already sent returns ok without sending again", async () => {
  // The first is past CacheService's default of 10 minutes, the last a minute short of the 6 hours.
  for (const later of [10 * MINUTE_MS + 1, HOUR_MS, 6 * HOUR_MS - MINUTE_MS]) {
    const app = webApp();
    assertAccepted(app.post(await signed(MESSAGE, T0)), "the first send");

    app.state.now = T0 + later;
    const rerendered = { ...MESSAGE, subject: "A later render of the same email" };
    assertAccepted(app.post(await signed(rerendered, app.state.now)), `${later} ms later`);
    assert.equal(app.state.sent.length, 1, `${later} ms later`);
    assert.equal(app.state.sent[0].subject, MESSAGE.subject);
  }

  // It is the messageId that repeats, not the address or the words.
  const app = webApp();
  for (const messageId of ["email:staff_alert:one", "email:staff_alert:two", "email:staff_alert:three"]) {
    assertAccepted(app.post(await signed({ ...MESSAGE, messageId }, T0)), messageId);
  }
  assert.equal(app.state.sent.length, 3);

  // The last email of the day went out and its answer was lost. The retry is ok, not six hours of waiting.
  const lastOfTheDay = webApp({ quota: 1 });
  assertAccepted(lastOfTheDay.post(await signed(MESSAGE, T0)), "the last send of the day");
  assert.equal(lastOfTheDay.state.quota, 0);
  lastOfTheDay.state.now = T0 + MINUTE_MS;
  assertAccepted(lastOfTheDay.post(await signed(MESSAGE, T0 + MINUTE_MS)), "its retry");
  assert.equal(lastOfTheDay.state.sent.length, 1);
});

test("exhausted quota is retryable and sends nothing", async () => {
  for (const message of MESSAGES) {
    const app = webApp({ quota: 0 });
    const answer = assertRefused(app.post(await signed(message, T0)), message.messageId);
    assert.equal(answer.retryable, true, message.messageId);
    assert.equal(app.state.sendCalls, 0, `${message.messageId}: the quota is checked before MailApp is called`);

    // The refusal leaves the messageId free, so the retry after the quota resets does send.
    app.state.now = T0 + 6 * HOUR_MS;
    app.state.quota = 100;
    assertAccepted(app.post(await signed(message, app.state.now)), `${message.messageId}, retried`);
    assert.equal(app.state.sent.length, 1, message.messageId);
    assertDelivered(app.state.sent[0], message);
  }

  for (const quota of [1, 2, 3]) {
    const app = webApp({ quota });
    for (let i = 0; i < quota; i += 1) {
      assertAccepted(app.post(await signed({ ...MESSAGE, messageId: `email:n:${i}` }, T0)), `email ${i} of ${quota}`);
    }
    const over = assertRefused(app.post(await signed({ ...MESSAGE, messageId: "email:n:over" }, T0)), `past ${quota}`);
    assert.equal(over.retryable, true);
    assert.equal(app.state.sent.length, quota);
  }
});

test("a failed send answers retryable and leaves the messageId free for the retry", async () => {
  const failures = [
    "Service error: MailApp",
    "Service invoked too many times in a short time: email",
    "Service invoked too many times for one day: email.",
  ];
  for (const failure of failures) {
    const app = webApp({ sendFailures: [failure] });
    const answer = assertRefused(app.post(await signed(MESSAGE, T0)), failure);
    assert.equal(answer.retryable, true, failure);
    assert.equal(app.state.sent.length, 0, failure);

    app.state.now = T0 + MINUTE_MS;
    assertAccepted(app.post(await signed(MESSAGE, app.state.now)), `${failure}, retried`);
    assert.equal(app.state.sent.length, 1, failure);
    assertDelivered(app.state.sent[0], MESSAGE);
  }
});

test("a missing MAIL_SECRET refuses every envelope", async () => {
  const unset: Record<string, string>[] = [{}, { MAIL_SECRET: "" }, { PUBLISH_SECRET }];
  for (const properties of unset) {
    // What a key of nothing would verify, then the other secret, then the real one.
    const bodies = [signedWithNoKey(MESSAGE, T0)];
    for (const secret of ["null", "undefined", PUBLISH_SECRET, SECRET]) {
      bodies.push(await signed(MESSAGE, T0, secret));
    }
    for (const [index, body] of bodies.entries()) {
      const app = webApp({ properties });
      const label = `body ${index} under ${JSON.stringify(properties)}`;
      assertRefused(app.post(body), label);
      assert.equal(app.state.sendCalls, 0, label);
    }
  }
});

test("the manifest can send mail but not read the mailbox", () => {
  const manifest = JSON.parse(readFileSync(new URL("../apps-script/appsscript.json", import.meta.url), "utf8")) as {
    oauthScopes: string[];
  };
  assert.ok(manifest.oauthScopes.includes("https://www.googleapis.com/auth/script.send_mail"));
  const mailbox = manifest.oauthScopes.filter((scope) => /mail\.google\.com|\/auth\/gmail/.test(scope));
  assert.deepEqual(mailbox, []);
});
