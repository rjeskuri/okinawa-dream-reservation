// sendMail through an injected fetch: what goes out on the wire, and the SendResult each answer maps to. The tests
// after the first two join the real pieces, sendMail to the real doPost and both to the real drainOutbox over D1, so how
// the script tells the Worker that the quota ran out stays theirs to settle. Envelopes are checked with the real
// verifyEnvelope, and expected times are literal offsets from each test's own clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyEnvelope } from "../src/lib/crypto.ts";
import { sendMail } from "../src/lib/mail/transport.ts";
import { drainOutbox, enqueueStatements, type OutboxItem, type SendResult } from "../src/lib/outbox.ts";
import { mailSender } from "../src/server/mail.ts";
import { loadWebApp, type WebApp, type WebAppOptions } from "./helpers/apps-script.ts";
import { createTestDb } from "./helpers/d1.ts";

const MAIL_URL = "https://script.google.com/macros/s/AKfycbx-deployment-one/exec";
const SECRET = "mail-secret-one";

const T0 = Date.UTC(2027, 2, 9, 1, 30, 15);

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SIX_HOURS_MS = 6 * HOUR_MS;

/** What MailApp.sendEmail throws once the day's recipients are used up. */
const DAILY_LIMIT = "Service invoked too many times for one day: email.";

const LOGIN_PAGE =
  '<!DOCTYPE html><html lang="en"><head><title>Sign in - Google Accounts</title></head><body>' +
  '<form action="https://accounts.google.com/v3/signin/identifier" method="post">' +
  '<input type="email" name="identifier"></form></body></html>';

type FetchFn = typeof globalThis.fetch;

type DrainResult = Awaited<ReturnType<typeof drainOutbox>>;

type Message = Parameters<typeof sendMail>[1];

type Recorded = { url: string; method: string; headers: Headers; body: string; redirect: string; unbound: boolean };

type Refusal = Extract<SendResult, { ok: false }>;

type Row = { status: string; attempts: number; next_attempt_at: number };

const MESSAGE: Message = {
  messageId: "email:guest_confirmation:bkg-7K2MQ9XA",
  to: "higa@example.jp",
  subject: "ご予約ありがとうございます 7K2MQ9XA",
  text: "沖縄でお待ちしております。",
  html: '<p lang="ja">沖縄でお待ちしております</p>',
  replyTo: "shop@okinawa-dream.example",
};

const ITEM: OutboxItem = {
  kind: "email",
  dedupeKey: MESSAGE.messageId,
  payload: { template: "guest_confirmation", to: MESSAGE.to, locale: "ja", data: {} },
};

function json(body: unknown, status = 200): () => Response {
  const headers = { "content-type": "application/json; charset=utf-8" };
  return () => new Response(JSON.stringify(body), { status, headers });
}

function page(status: number, body = LOGIN_PAGE): () => Response {
  return () => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** A fetch that records each request, whether sendMail passes a URL and init or a Request. */
function recordingFetch(reply: (call: Recorded) => Response) {
  const calls: Recorded[] = [];
  // A function and not an arrow, so that it can see `this`. The real fetch throws "Illegal invocation" in workerd when
  // it is called as a method, like `deps.fetch(...)`. The tests assert `unbound` on the record afterwards, because an
  // assertion thrown in here would land in sendMail's own catch and read as a network error.
  const fake: FetchFn = async function (this: unknown, input, init) {
    const request = new Request(input, init);
    const call: Recorded = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      redirect: request.redirect,
      unbound: this === undefined || this === globalThis,
    };
    calls.push(call);
    return reply(call);
  };
  return { fetch: fake, calls };
}

function webApp(overrides: Partial<WebAppOptions> = {}): WebApp {
  return loadWebApp({ properties: { MAIL_SECRET: SECRET }, now: T0, ...overrides });
}

/** doPost's answer as Google serves it at the end of the redirect: a 200, with the JSON type the script's output set. */
function served(app: WebApp, body: string): Response {
  const headers = { "content-type": "application/json; charset=utf-8" };
  return new Response(app.post(body).text, { status: 200, headers });
}

function webAppFetch(app: WebApp): FetchFn {
  return recordingFetch(({ body }) => served(app, body)).fetch;
}

function deps(fetcher: FetchFn, now = T0) {
  return { url: MAIL_URL, secret: SECRET, fetch: fetcher, now };
}

function refusal(result: SendResult, label: string): Refusal {
  assert.ok(!result.ok, `${label}: ${JSON.stringify(result)}`);
  assert.equal(typeof result.retryable, "boolean", `${label}: ${JSON.stringify(result)}`);
  assert.equal(typeof result.error, "string", `${label}: ${JSON.stringify(result)}`);
  assert.notEqual(result.error, "", label);
  assert.ok(!result.error.includes(SECRET), `${label}: the secret stays out of the error`);
  return result;
}

/** An email queued at T0, drained through sendMail as task #42 will, with the script's clock kept at the drain's. */
async function withQueuedEmail(
  app: WebApp,
  fetcher: FetchFn,
  run: (rig: { row(): Promise<Row>; drainAt(now: number): Promise<DrainResult> }) => Promise<void>,
): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await db.batch(enqueueStatements(db, [ITEM], T0));
    await run({
      async row() {
        const row = await db.prepare("SELECT status, attempts, next_attempt_at FROM outbox").first<Row>();
        assert.ok(row !== null, "the row is there");
        return { status: row.status, attempts: row.attempts, next_attempt_at: row.next_attempt_at };
      },
      drainAt(now) {
        app.state.now = now;
        return drainOutbox({
          db,
          now,
          sendEmail: (payload, messageId) => sendMail(deps(fetcher, now), { ...MESSAGE, messageId, to: payload.to }),
          syncBookings: async () => ({ ok: true }),
        });
      },
    });
  } finally {
    await dispose();
  }
}

test("sendMail signs, posts and maps responses", async () => {
  const sends: { url: string; secret: string; now: number; message: Message }[] = [
    { url: MAIL_URL, secret: SECRET, now: T0, message: MESSAGE },
    {
      url: "https://script.google.com/macros/s/AKfycbx-deployment-two/exec",
      secret: "another-secret-2",
      now: T0 + 86_400_123,
      // No replyTo here: it is optional, and an absent one stays absent on the wire.
      message: {
        messageId: "email:staff_alert:9",
        to: "staff@example.jp",
        subject: "Alert",
        text: "t",
        html: "<i>h</i>",
      },
    },
    {
      url: MAIL_URL,
      secret: "秘密 & symbols",
      now: T0 - 7,
      message: { ...MESSAGE, messageId: "email:n:3", subject: 'Quotes " \\', replyTo: "help@example.jp" },
    },
  ];
  for (const { url, secret, now, message } of sends) {
    const { fetch: fetcher, calls } = recordingFetch(json({ ok: true, remainingQuota: 57 }));
    const result = await sendMail({ url, secret, fetch: fetcher, now }, message);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.unbound, true, "the injected fetch must be called unbound");
    assert.equal(call.url, url);
    assert.equal(call.method, "POST");
    assert.equal(call.redirect, "follow", "the web app answers through a 302 to script.googleusercontent.com");
    assert.match(String(call.headers.get("content-type")), /^application\/json/);

    assert.deepEqual(await verifyEnvelope(secret, call.body, now), { ok: true, payload: message });
    const wrongKey = await verifyEnvelope(`${secret}-other`, call.body, now);
    assert.deepEqual(wrongKey, { ok: false, reason: "bad_signature" });
    assert.equal((JSON.parse(call.body) as { ts: unknown }).ts, now);

    const wire = [call.url, call.body, ...call.headers.values()];
    assert.ok(!wire.some((text) => text.includes(secret)), "the secret itself never leaves the Worker");
  }

  const answers: {
    name: string;
    response: () => Response;
    ok?: true;
    retryable?: boolean;
    error?: string;
  }[] = [
    { name: "ok", response: json({ ok: true, remainingQuota: 57 }), ok: true },
    { name: "ok, nothing left", response: json({ ok: true, remainingQuota: 0 }), ok: true },
    {
      name: "a refusal",
      response: json({ ok: false, error: "bad signature", retryable: false }),
      retryable: false,
      error: "bad signature",
    },
    {
      name: "another refusal",
      response: json({ ok: false, error: "Invalid email: guest", retryable: false }),
      retryable: false,
      error: "Invalid email: guest",
    },
    {
      name: "a retryable refusal",
      response: json({ ok: false, error: "Service error: MailApp", retryable: true }),
      retryable: true,
      error: "Service error: MailApp",
    },
    { name: "a refusal with no error", response: json({ ok: false, retryable: false }), retryable: false },
    { name: "a refusal with no retryable", response: json({ ok: false, error: "odd" }), error: "odd" },
    // 5xx is retryable whatever the body says.
    { name: "500 as HTML", response: page(500, "<html>Error</html>"), retryable: true },
    { name: "502 as HTML", response: page(502, "<html>Bad gateway</html>"), retryable: true },
    { name: "503 empty", response: page(503, ""), retryable: true },
    { name: "500 refusing", response: json({ ok: false, error: "no", retryable: false }, 500), retryable: true },
    { name: "503 claiming ok", response: json({ ok: true, remainingQuota: 5 }, 503), retryable: true },
    // Non-JSON is retryable whatever the status: Google's own 4xx pages are HTML, and a surfaced redirect has no body.
    { name: "400 as HTML", response: page(400), retryable: true },
    { name: "401 as HTML", response: page(401), retryable: true },
    { name: "403 as HTML", response: page(403), retryable: true },
    { name: "404 as HTML", response: page(404, "<html>Sorry, unable to open the file</html>"), retryable: true },
    { name: "429 as HTML", response: page(429), retryable: true },
    { name: "a surfaced 302", response: page(302, ""), retryable: true },
    { name: "200 as HTML", response: page(200), retryable: true },
    { name: "200 as text", response: page(200, "OK"), retryable: true },
    { name: "200 empty", response: page(200, ""), retryable: true },
    // JSON that is not the web app's answer says no more than a login page does.
    { name: "200 with null", response: json(null), retryable: true },
    { name: "200 with a list", response: json([]), retryable: true },
    { name: "200 with a number", response: json(42), retryable: true },
    { name: "200 with a string", response: json("ok"), retryable: true },
    { name: "200 with an empty object", response: json({}), retryable: true },
    // The ticket does not class a 4xx carrying JSON, and Google sends none. It is only not a success.
    { name: "403 as JSON", response: json({ error: "forbidden" }, 403) },
    { name: "400 refusing", response: json({ ok: false, error: "no", retryable: false }, 400) },
    { name: "403 claiming ok", response: json({ ok: true, remainingQuota: 5 }, 403) },
  ];
  for (const { name, response, ok, retryable, error } of answers) {
    const { fetch: fetcher } = recordingFetch(response);
    const result = await sendMail(deps(fetcher), MESSAGE);

    if (ok === true) {
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
      continue;
    }
    const refused = refusal(result, name);
    if (retryable !== undefined) assert.equal(refused.retryable, retryable, name);
    if (error !== undefined) assert.ok(refused.error.includes(error), `${name}: ${refused.error}`);
    assert.equal(refused.retryAt, undefined, `${name}: the wait is the outbox's backoff`);
  }

  const brokenBody = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new TypeError("Connection reset while reading"));
        },
      }),
    );
  const failures: { name: string; reply: () => Response; shows: string }[] = [
    {
      name: "a refused connection",
      reply: () => {
        throw new TypeError("fetch failed");
      },
      shows: "fetch failed",
    },
    {
      name: "a dropped connection",
      reply: () => {
        throw new Error("Network connection lost.");
      },
      shows: "Network connection lost.",
    },
    { name: "a body that breaks off", reply: brokenBody, shows: "Connection reset while reading" },
  ];
  for (const { name, reply, shows } of failures) {
    const { fetch: fetcher } = recordingFetch(reply);
    const refused = refusal(await sendMail(deps(fetcher), MESSAGE), name);
    assert.equal(refused.retryable, true, name);
    assert.equal(refused.retryAt, undefined, name);
    assert.ok(refused.error.includes(shows), `${name}: ${refused.error}`);
  }
});

test("a login page instead of JSON is retryable", async () => {
  for (const status of [200, 401, 403]) {
    const refused = refusal(await sendMail(deps(recordingFetch(page(status)).fetch), MESSAGE), `login page, ${status}`);
    assert.equal(refused.retryable, true, `login page, ${status}`);
  }

  const app = webApp();
  let lapsed = true;
  const { fetch: fetcher } = recordingFetch(({ body }) => (lapsed ? page(200)() : served(app, body)));
  await withQueuedEmail(app, fetcher, async ({ row, drainAt }) => {
    // The outbox's waits after the first three failures: 1, 5 and 30 minutes.
    for (const [failures, [drainedAt, nextAt]] of [
      [T0, T0 + MINUTE_MS],
      [T0 + MINUTE_MS, T0 + 6 * MINUTE_MS],
      [T0 + 6 * MINUTE_MS, T0 + 36 * MINUTE_MS],
    ].entries()) {
      assert.deepEqual(await drainAt(drainedAt), { sent: 0, retried: 1, dead: [] });
      assert.deepEqual(await row(), { status: "pending", attempts: failures + 1, next_attempt_at: nextAt });
    }
    assert.equal(app.state.sendCalls, 0);

    lapsed = false;
    assert.deepEqual(await drainAt(T0 + 36 * MINUTE_MS), { sent: 1, retried: 0, dead: [] });
    assert.equal((await row()).status, "sent");
    assert.equal(app.state.sent.length, 1);
  });
});

test("HTML and text bodies arrive unchanged", async () => {
  const bodies: Pick<Message, "text" | "html">[] = [
    {
      text: "ご予約ありがとうございます。\n沖縄でお待ちしております。",
      html: '<p lang="ja">ご予約ありがとうございます。<br>沖縄でお待ちしております。</p>',
    },
    {
      text: "Line one\r\nLine two\n\n  indented\ttabbed  \n",
      html: '<table>\n  <tr><td style="color:#123456">¥12,000</td></tr>\n</table>\n',
    },
    {
      text: "Cancel: https://example.dev/cancel?b=7K2MQ9XA&t=a+b%20c#end",
      html: '<a href="https://example.dev/cancel?b=7K2MQ9XA&amp;t=a+b%20c#end">Cancel</a>',
    },
    {
      text: `Quotes " ' and \\ backslash, \\n not a newline,   a separator`,
      html: `<script>alert("x")</script>&lt;kept&gt; &amp; &#39;`,
    },
    { text: "한국어 中文 🛵🏝️ ñ", html: "<p>한국어 中文 🛵🏝️ ñ</p>" },
  ];
  for (const [index, { text, html }] of bodies.entries()) {
    const app = webApp();
    const message = { ...MESSAGE, messageId: `email:bodies:${index}`, text, html };
    const result = await sendMail(deps(webAppFetch(app)), message);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(app.state.sent.length, 1);
    assert.equal(app.state.sent[0].body, text);
    assert.equal(app.state.sent[0].htmlBody, html);
    assert.equal(app.state.sent[0].subject, MESSAGE.subject);
  }
});

test("exhausted quota comes back for the outbox to retry 6 hours later", async () => {
  // A first failure, whose backoff is 1 minute, and clocks far from the real one, so neither that nor Date.now() passes.
  for (const now of [T0, T0 + 3 * HOUR_MS + 17]) {
    const app = webApp({ now, quota: 0 });
    const refused = refusal(await sendMail(deps(webAppFetch(app), now), MESSAGE), `no quota at ${now}`);
    assert.equal(refused.retryable, true);
    assert.equal(refused.retryAt, now + SIX_HOURS_MS);
    assert.equal(app.state.sendCalls, 0);
  }

  const app = webApp({ quota: 0 });
  await withQueuedEmail(app, webAppFetch(app), async ({ row, drainAt }) => {
    assert.deepEqual(await drainAt(T0), { sent: 0, retried: 1, dead: [] });
    assert.deepEqual(await row(), { status: "pending", attempts: 1, next_attempt_at: T0 + SIX_HOURS_MS });

    app.state.quota = 100;
    assert.deepEqual(await drainAt(T0 + SIX_HOURS_MS - 1), { sent: 0, retried: 0, dead: [] });
    assert.equal(app.state.sendCalls, 0, "not due a millisecond early");

    assert.deepEqual(await drainAt(T0 + SIX_HOURS_MS), { sent: 1, retried: 0, dead: [] });
    assert.equal((await row()).status, "sent");
    assert.equal(app.state.sent.length, 1);
  });
});

test("the daily limit met during the send counts as exhausted quota", async () => {
  // getRemainingDailyQuota can show room and the send still hit the limit, as other sends on the account use it up.
  for (const now of [T0, T0 + 3 * HOUR_MS + 17]) {
    const app = webApp({ now, sendFailures: [DAILY_LIMIT] });
    const refused = refusal(await sendMail(deps(webAppFetch(app), now), MESSAGE), `the limit at ${now}`);
    assert.equal(refused.retryable, true);
    assert.equal(refused.retryAt, now + SIX_HOURS_MS);
    assert.equal(app.state.sent.length, 0);
  }

  const app = webApp({ sendFailures: [DAILY_LIMIT] });
  await withQueuedEmail(app, webAppFetch(app), async ({ row, drainAt }) => {
    assert.deepEqual(await drainAt(T0), { sent: 0, retried: 1, dead: [] });
    assert.deepEqual(await row(), { status: "pending", attempts: 1, next_attempt_at: T0 + SIX_HOURS_MS });

    assert.deepEqual(await drainAt(T0 + SIX_HOURS_MS), { sent: 1, retried: 0, dead: [] });
    assert.equal((await row()).status, "sent");
    assert.equal(app.state.sent.length, 1);
  });
});

test("a retryable failure other than quota keeps the outbox's backoff", async () => {
  const failing = webApp({ sendFailures: ["Service error: MailApp"] });
  // A limit by the minute, worded close to the daily one, passes in a minute rather than six hours.
  const throttled = webApp({ sendFailures: ["Service invoked too many times in a short time: email"] });
  const unused = webApp();
  const failures: { name: string; app: WebApp; fetcher: FetchFn }[] = [
    { name: "a MailApp failure", app: failing, fetcher: webAppFetch(failing) },
    { name: "a rate limit", app: throttled, fetcher: webAppFetch(throttled) },
    {
      name: "a network error",
      app: unused,
      fetcher: recordingFetch(() => {
        throw new TypeError("fetch failed");
      }).fetch,
    },
    { name: "a 503", app: unused, fetcher: recordingFetch(page(503, "<html>Busy</html>")).fetch },
  ];
  for (const { name, app, fetcher } of failures) {
    await withQueuedEmail(app, fetcher, async ({ row, drainAt }) => {
      assert.deepEqual(await drainAt(T0), { sent: 0, retried: 1, dead: [] }, name);
      assert.deepEqual(await row(), { status: "pending", attempts: 1, next_attempt_at: T0 + MINUTE_MS }, name);
    });
  }
});

test("an answer lost on the way back does not send the email twice", async () => {
  const app = webApp();
  let answers = 0;
  const { fetch: fetcher } = recordingFetch(({ body }) => {
    const response = served(app, body);
    answers += 1;
    if (answers === 1) throw new TypeError("Network connection lost.");
    return response;
  });
  await withQueuedEmail(app, fetcher, async ({ row, drainAt }) => {
    assert.deepEqual(await drainAt(T0), { sent: 0, retried: 1, dead: [] });
    assert.equal(app.state.sent.length, 1, "Google sent it, and the Worker does not know");

    assert.deepEqual(await drainAt(T0 + MINUTE_MS), { sent: 1, retried: 0, dead: [] });
    assert.equal(app.state.sent.length, 1);
    assert.equal((await row()).status, "sent");
  });
});

test("the web app's own refusal comes back as a refusal", async () => {
  const app = webApp();
  const result = await sendMail({ ...deps(webAppFetch(app)), secret: "not-the-secret" }, MESSAGE);
  const refused = refusal(result, "the wrong secret");
  assert.equal(refused.retryAt, undefined);
  assert.equal(app.state.sendCalls, 0);
});

test("mailSender sends through env's web app, signed with env's secret at the time of each send", async (t) => {
  // src/server/square.ts's shape: `env` is an argument, so the cron jobs and the routes can share the factory, and the
  // file can be imported here. Global fetch is the only thing replaced, because the factory is what picks it.
  const { fetch: fetcher, calls } = recordingFetch(json({ ok: true, remainingQuota: 57 }));
  t.mock.method(globalThis, "fetch", fetcher);
  t.mock.timers.enable({ apis: ["Date"], now: T0 });

  const envs = [
    { APPS_SCRIPT_MAIL_URL: MAIL_URL, MAIL_SECRET: SECRET },
    {
      APPS_SCRIPT_MAIL_URL: "https://script.google.com/macros/s/AKfycbx-deployment-two/exec",
      MAIL_SECRET: "another-secret-2",
    },
  ];
  for (const env of envs) {
    const send = mailSender(env as Parameters<typeof mailSender>[0]);
    // A drain builds one sender and can outlast the web app's 5 minutes, so a time kept from the first send goes stale.
    for (const messageId of ["email:n:first", "email:n:second"]) {
      const message = { ...MESSAGE, messageId };
      const result = await send(message);

      assert.equal(result.ok, true, JSON.stringify(result));
      const call = calls[calls.length - 1];
      assert.equal(call.unbound, true, "the fetch it passes must work called unbound");
      assert.equal(call.url, env.APPS_SCRIPT_MAIL_URL);
      assert.deepEqual(await verifyEnvelope(env.MAIL_SECRET, call.body, Date.now()), { ok: true, payload: message });
      assert.equal((JSON.parse(call.body) as { ts: unknown }).ts, Date.now());

      t.mock.timers.tick(6 * MINUTE_MS);
    }
  }
});
