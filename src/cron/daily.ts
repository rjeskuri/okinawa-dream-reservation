// The 0 18 * * * job (03:00 JST): the daily check of src/lib/cron/daily.ts, with clients built from the env `scheduled()`
// hands it and `now` at the scheduled time.
import { runDaily } from "../lib/cron/daily.ts";
import { createGoogleClients } from "../server/google.ts";
import { squareClient } from "../server/square.ts";

export async function dailyCheck(env: Env, scheduledTime: number): Promise<void> {
  await runDaily({
    db: env.DB,
    sheets: createGoogleClients(env).sheets,
    square: squareClient(env),
    now: scheduledTime,
    staffEmail: env.STAFF_EMAIL,
  });
}
