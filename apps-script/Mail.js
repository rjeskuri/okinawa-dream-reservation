// The mail web app: the Worker posts a signed message here and the staff Gmail account sends it. Web apps cannot read
// request headers, so the signature travels in the body. It is deployed as Execute as me, Who has access: Anyone, which
// leaves that signature as the only protection: nothing an unsigned request carries may reach the cache or MailApp.

const FRESH_WINDOW_MS_ = 300000;

/** An envelope signed a whole window ahead stays fresh for two windows, and what records it has to outlast them. */
const SEEN_TTL_SECONDS_ = 660;

/** The longest CacheService keeps anything. */
const SENT_TTL_SECONDS_ = 21600;

const SENDER_NAME_ = "Okinawa Dream";

/** MailApp's words for the daily limit. Its limit by the minute reads "too many times in a short time". */
const DAILY_LIMIT_ = /too many times for one day/;

/**
 * Checks in the order of verifyEnvelope in src/lib/crypto.ts, then settles the repeats. A refusal the next attempt could
 * get past is retryable, since the Worker signs every attempt afresh: a missing or mismatched secret and a wrong clock
 * are fixed by staff, and until then mail waits in the outbox. Only what would fail the same way every time is not.
 */
function doPost(e) {
  const secret = PropertiesService.getScriptProperties().getProperty("MAIL_SECRET");
  // Before anything else, because an empty key is one an attacker can sign with too.
  if (!secret) return refusal_("MAIL_SECRET is not set", true);

  const { ts, payload, sig } = parsedJson_(e?.postData?.contents);
  if (!Number.isFinite(ts) || typeof payload !== "string" || typeof sig !== "string") {
    return refusal_("not an envelope", false);
  }

  const expected = hmacHex_(`${ts}.${payload}`, secret);
  if (!sameText_(sig, expected)) return refusal_("bad signature", true);
  if (Math.abs(Date.now() - ts) > FRESH_WINDOW_MS_) return refusal_("stale envelope", true);

  const message = parsedJson_(payload);
  if (!isMessage_(message)) return refusal_("not a whole message", false);

  // Keyed on the signature, not the body: the same envelope in other whitespace is the same envelope. It is recorded
  // whatever becomes of it below, because the Worker's retry is a new envelope and anything else is a replay.
  const cache = CacheService.getScriptCache();
  const seenKey = `mail:seen:${expected}`;
  if (cache.get(seenKey) !== null) return refusal_("replayed envelope", true);
  cache.put(seenKey, "1", SEEN_TTL_SECONDS_);

  // Before the quota, so that a retry of the day's last email is ok rather than six hours of waiting. Hashed because a
  // cache key has a limit of 250 characters and a messageId has none.
  const sentKey = `mail:sent:${hmacHex_(message.messageId, secret)}`;
  const quota = MailApp.getRemainingDailyQuota();
  if (cache.get(sentKey) !== null) return reply_({ ok: true, remainingQuota: quota });
  if (quota <= 0) return quotaRefusal_("the daily mail quota is used up");

  try {
    MailApp.sendEmail(mailOf_(message));
  } catch (error) {
    // Other sends on the account can use up the day after the check above, so the limit can show up here as well.
    return DAILY_LIMIT_.test(error.message) ? quotaRefusal_(error.message) : refusal_(error.message, true);
  }
  // Only now, so that a failed send leaves the messageId free for the retry.
  cache.put(sentKey, "1", SENT_TTL_SECONDS_);
  return reply_({ ok: true, remainingQuota: quota - 1 });
}

/** The value in `text`, or an empty object if that is not JSON or is null, so that a caller can always read fields. */
function parsedJson_(text) {
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
}

function hmacHex_(value, secret) {
  return toHex_(Utilities.computeHmacSha256Signature(value, secret, Utilities.Charset.UTF_8));
}

/** Compares without stopping at the first difference, so the time taken does not show how much of a guess was right. */
function sameText_(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function isMessage_(message) {
  const { messageId, to, subject, text, html } = message;
  const allText = [messageId, to, subject, text, html].every((field) => typeof field === "string");
  return allText && messageId !== "" && to !== "";
}

function mailOf_(message) {
  const mail = {
    to: message.to,
    subject: message.subject,
    body: message.text,
    htmlBody: message.html,
    name: SENDER_NAME_,
  };
  if (message.replyTo) mail.replyTo = message.replyTo;
  return mail;
}

function refusal_(error, retryable) {
  return reply_({ ok: false, error, retryable });
}

/** `quotaExhausted` is how the Worker tells this from other retryable refusals: it waits 6 hours, not its backoff. */
function quotaRefusal_(error) {
  return reply_({ ok: false, error, retryable: true, quotaExhausted: true });
}

function reply_(answer) {
  return ContentService.createTextOutput(JSON.stringify(answer)).setMimeType(ContentService.MimeType.JSON);
}
