// The cron entry. The registry maps each expression in wrangler.jsonc to its jobs (later tickets add them),
// and every run, known or not, leaves one cron_runs row.
import { dailyCheck } from "./daily.ts";

export type CronJob = (env: Env, scheduledTime: number) => Promise<void>;

export const registry: Record<string, CronJob[]> = {
  "*/10 * * * *": [],
  "0 18 * * *": [dailyCheck],
};

export type CronStatus = "ok" | "error" | "unknown";

/**
 * Runs every job registered for `cron` in order, then records the run. A failing job or an unregistered
 * expression is recorded rather than thrown; the returned promise rejects only if the insert itself fails.
 */
export async function runCron(cron: string, scheduledTime: number, env: Env): Promise<void> {
  const jobs = registry[cron];
  let status: CronStatus = "ok";
  const errors: string[] = [];
  if (jobs === undefined) {
    status = "unknown";
  } else {
    for (const job of jobs) {
      try {
        await job(env, scheduledTime);
      } catch (error) {
        status = "error";
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  await env.DB.prepare(
    "INSERT INTO cron_runs (cron, scheduled_at, ran_at, status, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(cron, scheduledTime, Date.now(), status, errors.length ? errors.join("; ") : null)
    .run();
}
