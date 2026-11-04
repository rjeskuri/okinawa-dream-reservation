// The */10 job: runFrequent over clients built from the env `scheduled()` hands it. It throws when a step failed, so runCron
// records the run as an error with every step's message in cron_runs.detail; the steps that worked have done their work.
import { runFrequent } from "../lib/cron/frequent.ts";
import { createGoogleClients } from "../server/google.ts";
import { mailSender } from "../server/mail.ts";
import { squareClient } from "../server/square.ts";

/** The clock at the start of the run, not scheduledTime: a late trigger still expires and claims by the real time. */
export async function frequentJob(env: Env): Promise<void> {
  const { errors } = await runFrequent({
    db: env.DB,
    now: Date.now(),
    square: squareClient(env),
    sheets: createGoogleClients(env).sheets,
    sendMail: mailSender(env),
    siteUrl: env.SITE_URL,
    cancelSecret: env.CANCEL_LINK_SECRET,
    staffEmail: env.STAFF_EMAIL,
  });
  if (errors.length > 0) throw new Error(errors.join("; "));
}
