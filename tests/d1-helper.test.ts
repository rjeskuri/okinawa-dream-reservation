// The shared D1 helper gives every test the same schema the Worker runs on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb, migrationStatements, proxyOf, testDbStarts } from "./helpers/d1.ts";

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

// #177: createTestDb sends plain statements through a bridge Worker and reuses disposed Miniflares. Both must be invisible:
// every probe below answers the same through the bridge as through Miniflare's own D1 proxy, on two fresh databases,
// and a reused database is indistinguishable from a new one.

type Outcome = { value: unknown } | { error: { name: string; message: string; cause?: string } };

/** What a probe gave back, without the timings D1 puts in meta. */
async function outcome(work: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { value: stripTimings(await work()) };
  } catch (error) {
    const { name, message, cause } = error as Error;
    return { error: { name, message, cause: cause instanceof Error ? cause.message : undefined } };
  }
}

function stripTimings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTimings);
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (value !== null && typeof value === "object") {
    const skip = new Set(["duration", "timings", "served_by", "served_by_region", "served_by_primary", "size_after"]);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !skip.has(key)).map(([key, inner]) => [key, stripTimings(inner)]));
  }
  return value;
}

const MANY = Array.from({ length: 101 }, (_, i) => i);

/** Each probe runs once on a database through the bridge and once on another through the proxy. */
const PROBES: { label: string; run: (db: D1Database) => Promise<unknown> }[] = [
  { label: "plain values", run: (db) => db.prepare("SELECT ?1 AS s, ?2 AS i, ?3 AS f, ?4 AS n, ?5 AS t, ?6 AS big").bind("あ\u0000'\"", 42, -1.5, null, true, 2 ** 53).all() },
  { label: "a lone surrogate", run: (db) => db.prepare("SELECT ?1 AS s, length(?1) AS n").bind("x\ud800y").first() },
  { label: "first of no rows", run: (db) => db.prepare("SELECT 1 FROM meta WHERE key = ?1").bind("none").first() },
  { label: "first of a column", run: (db) => db.prepare("SELECT 7 AS seven, 8 AS eight").first("eight") },
  { label: "first of a missing column", run: (db) => db.prepare("SELECT 7 AS seven").first("nine") },
  { label: "raw", run: (db) => db.prepare("SELECT 1 AS a, 'b' AS b UNION ALL SELECT 2, 'c'").raw() },
  { label: "raw with column names", run: (db) => db.prepare("SELECT 1 AS a, 'b' AS b").raw({ columnNames: true }) },
  { label: "unbound prepare", run: (db) => db.prepare("SELECT 3 AS x").all() },
  { label: "a blob", run: (db) => db.prepare("SELECT X'00FF10' AS b").first() },
  {
    label: "an insert and what it changed",
    run: async (db) => [
      await db.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)").bind("k", "v", 1).run(),
      await db.prepare("INSERT INTO cron_runs (cron, scheduled_at, ran_at, status) VALUES ('c', 1, 2, 'ok')").run(),
      await db.prepare("UPDATE meta SET value = 'w'").run(),
      await db.prepare("SELECT * FROM meta").all(),
    ],
  },
  { label: "a syntax error", run: (db) => db.prepare("SELEC 1").all() },
  { label: "a missing table", run: (db) => db.prepare("SELECT * FROM nowhere").all() },
  {
    label: "a UNIQUE violation",
    run: async (db) => {
      await db.prepare("INSERT INTO config (key, value) VALUES ('a', 'b')").run();
      return db.prepare("INSERT INTO config (key, value) VALUES ('a', 'c')").run();
    },
  },
  { label: "a CHECK violation", run: (db) => db.prepare("INSERT INTO cancellation_tiers VALUES (?1, ?2)").bind(1, 101).run() },
  { label: "a FOREIGN KEY violation", run: (db) => db.prepare("INSERT INTO vehicles (plate, model_id, status) VALUES ('p', 'no-model', 'active')").run() },
  { label: "a STRICT type violation", run: (db) => db.prepare("INSERT INTO config (key, value) VALUES (?1, ?2)").bind("k", 5.5).run() },
  { label: "101 bound values", run: (db) => db.prepare(`SELECT ${MANY.map((i) => `?${i + 1}`).join(" + ")} AS total`).bind(...MANY).first() },
  { label: "an undefined value", run: async (db) => db.prepare("SELECT ?1 AS u").bind(undefined).first() },
  { label: "NaN", run: async (db) => db.prepare("SELECT ?1 AS u").bind(Number.NaN).first() },
  { label: "an object", run: async (db) => db.prepare("SELECT ?1 AS u").bind({ a: 1 }).first() },
  { label: "bytes", run: async (db) => db.prepare("SELECT hex(?1) AS h").bind(new Uint8Array([1, 2, 255])).first() },
  {
    label: "a batch that fails rolls back",
    run: async (db) => {
      const failed = await outcome(() =>
        db.batch([
          db.prepare("INSERT INTO config (key, value) VALUES ('x', 'y')"),
          db.prepare("INSERT INTO cancellation_tiers VALUES (?1, ?2)").bind(1, 500),
        ]),
      );
      return [failed, await db.prepare("SELECT * FROM config").all()];
    },
  },
  {
    label: "a batch of plain and other values",
    run: (db) =>
      db.batch([
        db.prepare("INSERT INTO config (key, value) VALUES (?1, ?2)").bind("x", "y"),
        db.prepare("SELECT ?1 AS h, ?2 AS k").bind(new Uint8Array([7]), "x"),
        db.prepare("SELECT * FROM config"),
      ]),
  },
  { label: "exec", run: (db) => db.exec("INSERT INTO config (key, value) VALUES ('e', 'f');\nSELECT * FROM config") },
];

test("the bridge answers every probe as Miniflare's D1 proxy does", async () => {
  for (const { label, run } of PROBES) {
    const bridged = await createTestDb();
    const proxied = await createTestDb();
    try {
      const viaBridge = await outcome(() => run(bridged.db));
      const viaProxy = await outcome(() => run(proxyOf(proxied.db)));
      assert.deepEqual(viaBridge, viaProxy, label);
    } finally {
      await bridged.dispose();
      await proxied.dispose();
    }
  }
});

/** The connection settings D1 lets a statement change, each read back as a value. */
const SETTINGS = ["foreign_keys", "defer_foreign_keys", "ignore_check_constraints", "legacy_alter_table", "recursive_triggers", "reverse_unordered_selects"];

/**
 * Every row of every table, SQLite's own (sqlite_sequence) included, the schema, the connection settings, and the id
 * the next outbox row gets. Inserts that row, so call it last on a database.
 */
async function everything(db: D1Database): Promise<unknown> {
  const { results: schema, meta } = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid")
    .all<{ type: string; name: string }>();
  // The connection's last insert rowid shows in every meta, so a reused one must start from a new one's.
  const rows: Record<string, unknown[]> = {};
  for (const { type, name } of schema) {
    if (type !== "table" || name.startsWith("_cf_")) continue;
    rows[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results;
  }
  const settings: Record<string, unknown> = {};
  for (const setting of SETTINGS) settings[setting] = (await db.prepare(`PRAGMA ${setting}`).all()).results;
  // case_sensitive_like cannot be read back, only seen in what LIKE answers.
  settings.case_sensitive_like = await db.prepare("SELECT 'a' LIKE 'A' AS folds").first("folds");
  // An AUTOINCREMENT id never reuses one sqlite_sequence remembers, so a reused database must hand out a new one's first id.
  const next = await db
    .prepare("INSERT INTO outbox (kind, dedupe_key, payload, status, next_attempt_at, created_at) VALUES ('email', 'next', '{}', 'pending', 0, 0)")
    .run();
  return { schema, rows, settings, lastRowId: meta.last_row_id, nextOutboxId: next.meta.last_row_id };
}

test("a reused database is as empty as a new one, whatever the test before did", async (t) => {
  const fresh = await createTestDb();
  const pristine = (await everything(fresh.db)) as { rows: Record<string, unknown[]>; settings: Record<string, unknown>; nextOutboxId: number };
  await fresh.dispose();
  // Earlier tests in this file may have used the database "fresh" got, so hold it to what SQLite gives a new one too.
  assert.deepEqual(pristine.rows.sqlite_sequence, []);
  assert.equal(pristine.nextOutboxId, 1);
  assert.deepEqual(pristine.settings, {
    foreign_keys: [{ foreign_keys: 1 }],
    defer_foreign_keys: [{ defer_foreign_keys: 0 }],
    ignore_check_constraints: [{ ignore_check_constraints: 0 }],
    legacy_alter_table: [{ legacy_alter_table: 0 }],
    recursive_triggers: [{ recursive_triggers: 0 }],
    reverse_unordered_selects: [{ reverse_unordered_selects: 0 }],
    case_sensitive_like: 1,
  });

  // What a test may leave behind: rows (and the AUTOINCREMENT ids they used), connection settings, a trigger, a renamed table.
  const LEFTOVERS: { label: string; leave: (db: D1Database) => Promise<unknown> }[] = [
    {
      label: "rows",
      leave: async (db) => {
        const { seedBooking } = await import("./helpers/seed.ts");
        await seedBooking(db, {});
        await db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('k', 'v', 1)").run();
        await db.prepare("INSERT INTO cron_runs (cron, scheduled_at, ran_at, status) VALUES ('c', 1, 2, 'ok')").run();
        // A high explicit id, as cron-frequent's dead-outbox test sets, then an automatic one after it.
        await db
          .prepare("INSERT INTO outbox (id, kind, dedupe_key, payload, status, next_attempt_at, created_at) VALUES (424242, 'email', 'a', '{}', 'dead', 0, 0)")
          .run();
        await db.prepare("INSERT INTO outbox (kind, dedupe_key, payload, status, next_attempt_at, created_at) VALUES ('sheet_booking', 'b', '{}', 'sent', 0, 0)").run();
      },
    },
    {
      label: "connection settings",
      leave: async (db) => {
        for (const sql of [
          "PRAGMA foreign_keys = off",
          "PRAGMA defer_foreign_keys = on",
          "PRAGMA case_sensitive_like = on",
          "PRAGMA ignore_check_constraints = on",
          "PRAGMA legacy_alter_table = on",
          "PRAGMA recursive_triggers = on",
          "PRAGMA reverse_unordered_selects = on",
        ])
          await db.prepare(sql).run();
      },
    },
    { label: "a trigger", leave: (db) => db.prepare("CREATE TRIGGER no_meta BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'no'); END").run() },
    { label: "a renamed table", leave: (db) => db.prepare("ALTER TABLE outbox RENAME TO outbox_parked").run() },
    { label: "a new table", leave: (db) => db.prepare("CREATE TABLE extra (x)").run() },
    { label: "an index", leave: (db) => db.prepare("CREATE INDEX meta_value ON meta (value)").run() },
  ];
  for (const { label, leave } of LEFTOVERS) {
    await t.test(label, async () => {
      const used = await createTestDb();
      await leave(used.db);
      await used.dispose();
      const next = await createTestDb();
      try {
        assert.deepEqual(await everything(next.db), pristine, label);
      } finally {
        await next.dispose();
      }
    });
  }
});

test("a disposed database takes no more statements, and its writes in flight land before the next test's", async () => {
  const first = await createTestDb();
  const prepared = first.db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('late', 'v', 1)");
  // A write still on its way when the test disposes, as a promise a test forgot to await would be.
  const inFlight = first.db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('stray', 'v', 1)").run();
  await first.dispose();
  await inFlight;

  assert.throws(() => first.db.prepare("SELECT 1"), /disposed/);
  await assert.rejects(async () => prepared.run(), /disposed/);
  await assert.rejects(async () => first.db.batch([prepared]), /disposed/);

  const next = await createTestDb();
  try {
    assert.deepEqual((await next.db.prepare("SELECT key FROM meta").all()).results, []);
  } finally {
    await next.dispose();
  }
});

test("disposed databases are reused, and two held at once are separate", async () => {
  const startedBefore = testDbStarts();
  for (let i = 0; i < 5; i += 1) {
    const { db, dispose } = await createTestDb();
    await db.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?1, 'v', 1)").bind(`k${i}`).run();
    await dispose();
  }
  assert.ok(testDbStarts() - startedBefore <= 1, `${testDbStarts() - startedBefore} Miniflares for five databases in turn`);

  const [a, b] = await Promise.all([createTestDb(), createTestDb()]);
  try {
    await a.db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('a', 'v', 1)").run();
    assert.deepEqual((await b.db.prepare("SELECT key FROM meta").all()).results, []);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});
