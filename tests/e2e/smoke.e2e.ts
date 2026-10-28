// The e2e smoke tests: the built Worker serves Astro routes, deferred work completes, and crons run.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startWorker, type TestWorker } from "../helpers/worker.ts";

let worker: TestWorker;

before(async () => {
  worker = await startWorker();
});

after(async () => {
  await worker?.stop();
});

/** Polls `read` until it returns a value, for up to `timeoutMs`. */
async function poll<T>(read: () => Promise<T | null | undefined>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`nothing arrived within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cronRun(scheduledAt: number) {
  return poll(() =>
    worker.db
      .prepare("SELECT cron, scheduled_at, status, detail FROM cron_runs WHERE scheduled_at = ?1")
      .bind(scheduledAt)
      .first<{ cron: string; scheduled_at: number; status: string; detail: string | null }>(),
  );
}

test("GET /api/health answers ok with the database reachable", async () => {
  const res = await worker.fetch("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, db: true });
});

test("health schedules a meta write through waitUntil", async () => {
  const before = Date.now();
  const res = await worker.fetch("/api/health");
  assert.equal(res.status, 200);
  const row = await poll(() =>
    worker.db
      .prepare("SELECT value, updated_at FROM meta WHERE key = ?1 AND updated_at >= ?2")
      .bind("last_health_at", before)
      .first<{ value: string; updated_at: number }>(),
  );
  assert.ok(Number(row.value) >= before, `last_health_at ${row.value} is before the request at ${before}`);
  assert.equal(row.updated_at, Number(row.value));
});

test("the ten-minute cron records a cron_runs row", async () => {
  const scheduledAt = 1_800_000_000_000;
  await worker.scheduled("*/10 * * * *", scheduledAt);
  const row = await cronRun(scheduledAt);
  assert.deepEqual(row, { cron: "*/10 * * * *", scheduled_at: scheduledAt, status: "ok", detail: null });
});

test("the daily cron records its own expression", async () => {
  const scheduledAt = 1_800_000_060_000;
  await worker.scheduled("0 18 * * *", scheduledAt);
  const row = await cronRun(scheduledAt);
  assert.equal(row.cron, "0 18 * * *");
  assert.equal(row.status, "ok");
});

test("an unregistered cron is recorded as unknown", async () => {
  const scheduledAt = 1_800_000_120_000;
  await assert.doesNotReject(worker.scheduled("1 2 3 4 5", scheduledAt));
  const row = await cronRun(scheduledAt);
  assert.equal(row.cron, "1 2 3 4 5");
  assert.equal(row.status, "unknown");
});

test("an unknown path returns 404", async () => {
  const res = await worker.fetch("/no-such-page");
  assert.equal(res.status, 404);
});
