// The 0 18 * * * job (03:00 JST): the daily check of src/lib/cron/daily.ts, with the Worker's Square and Google clients and
// `now` at the scheduled time. src/server/google.ts reads `cloudflare:workers`, which Node cannot load, and Node loads
// this registry in tests/cron.test.ts, so that factory is imported when the job runs.
import { runDaily } from "../lib/cron/daily.ts";
import { squareClient } from "../server/square.ts";

export async function dailyCheck(env: Env, scheduledTime: number): Promise<void> {
  const { createGoogleClients } = await import("../server/google.ts");
  await runDaily({
    db: env.DB,
    sheets: createGoogleClients().sheets,
    square: squareClient(env),
    now: scheduledTime,
    staffEmail: env.STAFF_EMAIL,
  });
}
