// runCron in Node against the in-memory D1: every run leaves exactly one cron_runs row with the right status.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { registry, runCron } from "../src/cron/index.ts";
import { createTestDb, type TestDb } from "./helpers/d1.ts";

let testDb: TestDb;

before(async () => {
  testDb = await createTestDb();
});

after(async () => {
  await testDb?.dispose();
});

function envWith(db: D1Database): Env {
  return { DB: db } as unknown as Env;
}

async function runRow(scheduledAt: number) {
  return testDb.db
    .prepare("SELECT cron, status, detail FROM cron_runs WHERE scheduled_at = ?1")
    .bind(scheduledAt)
    .all<{ cron: string; status: string; detail: string | null }>();
}

test("the registry names both crons from wrangler.jsonc and nothing else yet", () => {
  assert.deepEqual(Object.keys(registry).sort(), ["*/10 * * * *", "0 18 * * *"]);
});

test("a job that throws records status error with its message, and later jobs still run", async () => {
  const ran: string[] = [];
  registry["1 1 1 1 1"] = [
    async () => {
      throw new Error("sheet unreachable");
    },
    async () => {
      ran.push("second");
    },
  ];
  try {
    await assert.doesNotReject(runCron("1 1 1 1 1", 42, envWith(testDb.db)));
  } finally {
    delete registry["1 1 1 1 1"];
  }
  const { results } = await runRow(42);
  assert.deepEqual(results, [{ cron: "1 1 1 1 1", status: "error", detail: "sheet unreachable" }]);
  assert.deepEqual(ran, ["second"]);
});

test("a run with every job passing records status ok once", async () => {
  await runCron("*/10 * * * *", 43, envWith(testDb.db));
  const { results } = await runRow(43);
  assert.deepEqual(results, [{ cron: "*/10 * * * *", status: "ok", detail: null }]);
});
