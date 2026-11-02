// The mail web app's client: signs a message into the envelope of src/lib/crypto.ts, posts it to apps-script/Mail.js and
// maps the answer to the outbox's SendResult. Nothing here reads `env`: src/server/mail.ts builds the sender.
import { signEnvelope } from "../crypto.ts";
import type { SendResult } from "../outbox.ts";

/** The wait after the daily quota runs out, in place of the outbox's backoff. */
const QUOTA_RETRY_MS = 6 * 60 * 60_000;

type MailDeps = { url: string; secret: string; fetch: typeof fetch; now: number };

export type MailMessage = {
  messageId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
};

type Answer = { ok?: unknown; error?: unknown; retryable?: unknown; quotaExhausted?: unknown };

function retryLater(error: string): SendResult {
  return { ok: false, retryable: true, error };
}

/** The JSON in `body`. Whatever is not an object reads as an answer with no fields. */
function parsedAnswer(body: string): Answer {
  try {
    return JSON.parse(body) ?? {};
  } catch {
    return {};
  }
}

/**
 * The web app always answers a 200 with a JSON object holding a boolean `ok`. Anything else is not its answer, so it
 * says nothing about the message and is retryable: a lapsed authorization serves a login page, and mail has to wait for
 * that to be restored instead of dying. An answer that leaves out `retryable` waits as well.
 */
function toSendResult(status: number, body: string, now: number): SendResult {
  if (status !== 200) return retryLater(`the mail web app answered ${status}`);

  const answer = parsedAnswer(body);
  if (answer.ok === true) return { ok: true };
  if (answer.ok !== false) return retryLater("the mail web app sent a response that could not be read");

  const error = typeof answer.error === "string" && answer.error !== "" ? answer.error : "the mail web app refused";
  if (answer.quotaExhausted === true) return { ok: false, retryable: true, retryAt: now + QUOTA_RETRY_MS, error };
  return { ok: false, retryable: answer.retryable !== false, error };
}

// `fetch` is destructured because workerd's throws "Illegal invocation" when it is called as `deps.fetch(...)`.
export async function sendMail({ url, secret, fetch, now }: MailDeps, m: MailMessage): Promise<SendResult> {
  try {
    const envelope = await signEnvelope(secret, m, now);
    const response = await fetch(url, {
      method: "POST",
      // The charset is what tells Google how to decode the Japanese the signature was computed over.
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(envelope),
      // The web app answers through a 302 to script.googleusercontent.com.
      redirect: "follow",
    });
    // Read whatever the status, to free the connection. It goes into no error: a login page is no use in last_error.
    return toSendResult(response.status, await response.text(), now);
  } catch (error) {
    return retryLater(error instanceof Error ? error.message : String(error));
  }
}
