// Builds the mail sender from the Worker's vars and secrets. `env` is an argument because `scheduled()` hands the cron
// jobs theirs, so the routes and the jobs can share this one factory.
import { type MailMessage, sendMail } from "../lib/mail/transport.ts";
import type { SendResult } from "../lib/outbox.ts";

type MailVars = Pick<Env, "APPS_SCRIPT_MAIL_URL" | "MAIL_SECRET">;

/** The clock is read at each send: a drain builds one sender and can outlast the web app's 5-minute window. */
export function mailSender(env: MailVars): (message: MailMessage) => Promise<SendResult> {
  return (message) =>
    sendMail({ url: env.APPS_SCRIPT_MAIL_URL, secret: env.MAIL_SECRET, fetch, now: Date.now() }, message);
}
