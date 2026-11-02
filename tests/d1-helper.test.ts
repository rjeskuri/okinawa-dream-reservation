// The shared D1 helper gives every test the same schema the Worker runs on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb, migrationStatements } from "./helpers/d1.ts";

test("createTestDb applies every migration, so cron_runs and meta exist", async () => {
  const { db, dispose } = await createTestDb();
  try {
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cron_runs', 'meta') ORDER BY name")
      .all<{ name: string }>();
    assert.deepEqual(
      rows.results.map((r) => r.name),
      ["cron_runs", "meta"],
    );
    await db.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)").bind("k", "v", 1).run();
    const meta = await db.prepare("SELECT value FROM meta WHERE key = ?1").bind("k").first<{ value: string }>();
    assert.equal(meta?.value, "v");
  } finally {
    await dispose();
  }
});

test("migrationStatements splits on a semicolon at the end of a line", () => {
  const statements = migrationStatements();
  assert.ok(statements.length >= 2, "expected at least the two tables of 0001_init.sql");
  for (const statement of statements) {
    assert.doesNotMatch(statement, /;\s*$/, `statement still ends in a semicolon: ${statement}`);
    assert.match(statement, /^(CREATE|INSERT|ALTER|DROP|PRAGMA)/i);
  }
});
