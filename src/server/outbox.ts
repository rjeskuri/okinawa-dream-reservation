// The drain right after a request commits outbox items, so a guest's email does not wait for the ten-minute cron. It runs in
// `ctx.waitUntil`, after the response: the response never waits on the mail web app or Google, and whatever this drain does
// not send, the cron does.
import { deliverOutbox } from "../lib/cron/frequent.ts";
import { createGoogleClients } from "./google.ts";
import { mailSender } from "./mail.ts";

type OutboxVars = Pick<
  Env,
  "DB" | "APPS_SCRIPT_MAIL_URL" | "MAIL_SECRET" | "GOOGLE_SA_EMAIL" | "GOOGLE_SA_PRIVATE_KEY" | "GOOGLE_SHEET_ID" | "STAFF_EMAIL"
>;

/** A request queues three items or so; five also takes one or two an earlier request left, inside its subrequests. */
const SOON_LIMIT = 5;

/** Never rejects: a failure is logged, and the items stay for the cron. */
export function drainSoon(ctx: Pick<ExecutionContext, "waitUntil">, env: OutboxVars): void {
  const drain = async () => {
    const deps = {
      db: env.DB,
      now: Date.now(),
      sheets: createGoogleClients(env).sheets,
      sendMail: mailSender(env),
      staffEmail: env.STAFF_EMAIL,
    };
    await deliverOutbox(deps, SOON_LIMIT);
  };
  ctx.waitUntil(
    drain().catch((error: unknown) => {
      console.error("The drain after a request failed; the ten-minute cron sends what it left", error);
    }),
  );
}
