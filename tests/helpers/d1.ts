// Shared D1 helpers: an in-memory D1 with every migration applied, and the migration runner itself.
// Node runs this file directly (type stripping), so relative imports end in .ts and types are erased.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Every statement of every `migrations/*.sql`, in filename order, split on a `;` at the end of a line. */
export function migrationStatements(): string[] {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const statements: string[] = [];
  for (const name of files) {
    const sql = readFileSync(new URL(name, `file://${migrationsDir}`), "utf8");
    for (const part of sql.split(/;[ \t]*\r?\n/)) {
      const statement = part
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (statement) statements.push(statement);
    }
  }
  return statements;
}

/** Applies every migration to `db`, one statement at a time. Migrations never contain triggers. */
export async function applyMigrations(db: D1Database): Promise<void> {
  for (const statement of migrationStatements()) {
    await db.prepare(statement).run();
  }
}

export interface TestDb {
  db: D1Database;
  dispose(): Promise<void>;
}

// #177: two costs made the D1 tests slow, and both are paid less here, with D1 itself unchanged.
// - Each statement went through Miniflare's object proxy, about 4 ms a round trip. Here a statement whose bound values are
//   plain (null, string, finite number, boolean) is one HTTP request to a bridge Worker that runs it on the same D1 binding,
//   about 1 ms. Any other value, and every statement of a batch that holds one, still goes through the proxy, so D1 alone
//   decides what it accepts and how it fails.
// - Each database was a Miniflare of its own, about a third of a second to start and migrate. A disposed database now goes
//   back to a small per-process pool, emptied of every row; a later createTestDb reuses it only if its schema is still
//   exactly what the migrations made (a test that renamed a table or added a trigger gets a new Miniflare instead). A
//   database handed out once refuses every statement after its dispose, so a stray promise of one test can never write
//   into the next one's rows, and its requests still in flight are awaited before the rows are cleared.

/** Runs one statement, batch or exec on env.DB, and sends back the value or the error as JSON. */
const BRIDGE = `
function statement(env, { sql, params, bound }) {
  const prepared = env.DB.prepare(sql);
  return bound ? prepared.bind(...params) : prepared;
}
function encode(value) {
  if (value instanceof ArrayBuffer) return { $blob: [...new Uint8Array(value)] };
  if (ArrayBuffer.isView(value)) return { $blob: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, encode(inner)]));
  }
  return value;
}
function describe(error) {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  return { name: error.name, message: error.message, cause: error.cause === undefined ? undefined : describe(error.cause) };
}
export default {
  async fetch(request, env) {
    const job = await request.json();
    try {
      let value;
      if (job.op === "statement") value = await statement(env, job)[job.method](...job.args);
      else if (job.op === "batch") value = await env.DB.batch(job.statements.map((one) => statement(env, one)));
      else if (job.op === "exec") value = await env.DB.exec(job.sql);
      else throw new Error("unknown bridge op " + job.op);
      return Response.json({ ok: true, value: encode(value === undefined ? null : value) });
    } catch (error) {
      return Response.json({ ok: false, error: describe(error) });
    }
  },
};
`;

type Plain = null | string | number | boolean;
type Wire = { name: string; message: string; cause?: Wire };
type Answer = { ok: true; value: unknown } | { ok: false; error: Wire };

/** Values that cross JSON unchanged, so the bridge binds exactly what the test bound. */
function isPlain(value: unknown): value is Plain {
  return (
    value === null ||
    (typeof value === "string" && value.isWellFormed()) ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))
  );
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const blob = (value as { $blob?: number[] }).$blob;
    if (Array.isArray(blob) && Object.keys(value).length === 1) return Uint8Array.from(blob).buffer;
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, decode(inner)]));
  }
  return value;
}

function rebuild(wire: Wire): Error {
  const error = new Error(wire.message, wire.cause === undefined ? undefined : { cause: rebuild(wire.cause) });
  error.name = wire.name;
  return error;
}

// Captured at load, before any test mocks the timers.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** One Miniflare with its D1, either leased to one TestDb or idle in the pool. */
class Instance {
  readonly mf: Miniflare;
  readonly inFlight = new Set<Promise<unknown>>();
  real: D1Database | null = null;
  schema = "";
  tables: string[] = [];
  lastRowId = 0;
  timer: ReturnType<typeof setTimeout> | undefined;

  constructor(mf: Miniflare) {
    this.mf = mf;
  }

  async proxy(): Promise<D1Database> {
    this.real ??= (await this.mf.getD1Database("DB")) as unknown as D1Database;
    return this.real;
  }

  async send(job: Record<string, unknown>): Promise<unknown> {
    const response = await this.mf.dispatchFetch("http://d1.test/", { method: "POST", body: JSON.stringify(job) });
    const answer = (await response.json()) as Answer;
    if (!answer.ok) throw rebuild(answer.error);
    return decode(answer.value);
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    const done = () => this.inFlight.delete(work);
    work.then(done, done);
    return work;
  }

  async settle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}

type Lease = { instance: Instance; released: boolean };

function use(lease: Lease): Instance {
  if (lease.released) throw new Error("tests/helpers/d1.ts: this test database was disposed, so it takes no more statements");
  return lease.instance;
}

// Plain properties, not #private ones, so a test's Proxy around the database or a statement works with or without
// binding the methods it hands on.
class TestStatement {
  readonly lease: Lease;
  readonly sql: string;
  readonly params: unknown[];
  readonly bound: boolean;
  /** The proxy's own statement, made at bind time, when a bound value is not plain. */
  readonly proxied: D1PreparedStatement | null;

  constructor(lease: Lease, sql: string, params: unknown[], bound: boolean, real: D1PreparedStatement | null) {
    this.lease = lease;
    this.sql = sql;
    this.params = params;
    this.bound = bound;
    this.proxied = real;
  }

  bind(...values: unknown[]): TestStatement {
    if (values.every(isPlain)) return new TestStatement(this.lease, this.sql, values, true, null);
    const real = use(this.lease).real;
    if (real === null) throw new Error("tests/helpers/d1.ts: the D1 proxy is not ready");
    return new TestStatement(this.lease, this.sql, values, true, real.prepare(this.sql).bind(...values));
  }

  call<T>(method: string, args: unknown[]): Promise<T> {
    const instance = use(this.lease);
    const real = this.proxied as unknown as Record<string, (...a: unknown[]) => Promise<T>> | null;
    const work =
      real !== null
        ? real[method](...args)
        : (instance.send({ op: "statement", sql: this.sql, params: this.params, bound: this.bound, method, args }) as Promise<T>);
    return instance.track(work);
  }

  first<T = unknown>(column?: string): Promise<T | null> {
    return this.call("first", column === undefined ? [] : [column]);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    return this.call("all", []);
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    return this.call("run", []);
  }

  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    return this.call("raw", options === undefined ? [] : [options]);
  }
}

class TestD1 {
  readonly lease: Lease;

  constructor(lease: Lease) {
    this.lease = lease;
  }

  /** Miniflare's own proxy to this D1, for tests/d1-helper.test.ts to hold the bridge against. */
  get viaProxy(): D1Database {
    return use(this.lease).real as D1Database;
  }

  prepare(sql: string): TestStatement {
    use(this.lease);
    return new TestStatement(this.lease, sql, [], false, null);
  }

  batch<T = unknown>(statements: TestStatement[]): Promise<D1Result<T>[]> {
    const instance = use(this.lease);
    if (statements.some((one) => one.proxied !== null)) {
      const real = instance.real as D1Database;
      const made = statements.map((one) => one.proxied ?? (one.bound ? real.prepare(one.sql).bind(...one.params) : real.prepare(one.sql)));
      return instance.track(real.batch<T>(made));
    }
    const jobs = statements.map(({ sql, params, bound }) => ({ sql, params, bound }));
    return instance.track(instance.send({ op: "batch", statements: jobs }) as Promise<D1Result<T>[]>);
  }

  exec(sql: string): Promise<D1ExecResult> {
    const instance = use(this.lease);
    return instance.track(instance.send({ op: "exec", sql }) as Promise<D1ExecResult>);
  }

  withSession(constraint?: string): unknown {
    const instance = use(this.lease);
    return (instance.real as unknown as { withSession(c?: string): unknown }).withSession(constraint);
  }
}

/** Idle instances, newest last. Each disposes itself unless a test takes it back within IDLE_MS. */
const idle: Instance[] = [];
const IDLE_MS = 250;
const POOL_MAX = 4;

const SCHEMA_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid";

async function schemaOf(instance: Instance): Promise<{ text: string; tables: string[]; lastRowId: number }> {
  const { results, meta } = (await instance.send({ op: "statement", sql: SCHEMA_SQL, params: [], bound: false, method: "all", args: [] })) as {
    results: { type: string; name: string }[];
    meta: { last_row_id: number };
  };
  const tables = results
    .filter(({ type, name }) => type === "table" && !name.startsWith("sqlite_") && !name.startsWith("_cf_"))
    .map(({ name }) => name);
  return { text: JSON.stringify(results), tables, lastRowId: meta.last_row_id };
}

/** How many Miniflares this process has started for createTestDb. */
let started = 0;

export function testDbStarts(): number {
  return started;
}

/** Miniflare's own proxy to a createTestDb database: the same D1, without the bridge. */
export function proxyOf(db: D1Database): D1Database {
  if (!(db instanceof TestD1)) throw new Error("proxyOf takes a database from createTestDb");
  return db.viaProxy;
}

async function startInstance(): Promise<Instance> {
  started += 1;
  const mf = new Miniflare(
    convertV4MiniflareOptions({ modules: true, script: BRIDGE, compatibilityDate: "2026-10-01", d1Databases: { DB: "test-db" } }),
  );
  const instance = new Instance(mf);
  try {
    await instance.proxy();
    const lease: Lease = { instance, released: false };
    await applyMigrations(new TestD1(lease) as unknown as D1Database);
    const { text, tables, lastRowId } = await schemaOf(instance);
    instance.lastRowId = lastRowId;
    instance.schema = text;
    instance.tables = tables;
    return instance;
  } catch (error) {
    // A live Miniflare keeps the process open, so never leak one from a failed start.
    await mf.dispose();
    throw error;
  }
}

/** Empties every table, child tables first. False when the schema is no longer the migrations' own. */
async function reset(instance: Instance): Promise<boolean> {
  try {
    const before = await schemaOf(instance);
    if (before.text !== instance.schema) return false;
    const deletes = [...instance.tables].reverse().map((table) => ({ sql: `DELETE FROM "${table}"`, params: [], bound: false }));
    // D1 reports the connection's last insert rowid in every meta, so put it back to what the new one reported. Should
    // cron_runs ever go, this fails and every createTestDb starts a Miniflare again: slower, never wrong.
    const rowidBack = [
      `INSERT INTO cron_runs (id, cron, scheduled_at, ran_at, status) VALUES (${instance.lastRowId}, '', 0, 0, '')`,
      "DELETE FROM cron_runs",
    ].map((sql) => ({ sql, params: [], bound: false }));
    await instance.send({ op: "batch", statements: [...deletes, ...rowidBack] });
    const rows = `SELECT ${instance.tables.map((table) => `(SELECT COUNT(*) FROM "${table}")`).join(" + ")} AS n`;
    const left = await instance.send({ op: "statement", sql: rows, params: [], bound: false, method: "first", args: ["n"] });
    return left === 0;
  } catch {
    return false;
  }
}

async function release(instance: Instance): Promise<void> {
  await instance.settle();
  if (idle.length >= POOL_MAX || !(await reset(instance))) {
    await instance.mf.dispose();
    return;
  }
  instance.timer = realSetTimeout(() => {
    const at = idle.indexOf(instance);
    if (at === -1) return;
    idle.splice(at, 1);
    instance.mf.dispose().catch(() => {});
  }, IDLE_MS);
  idle.push(instance);
}

/**
 * An empty D1 (Miniflare, no persistence) with every migration applied, as if new: no rows, and the migrations' schema
 * exactly. It may be a Miniflare an earlier test of this process disposed, emptied for this one.
 */
export async function createTestDb(): Promise<TestDb> {
  const reused = idle.pop();
  if (reused !== undefined) realClearTimeout(reused.timer);
  const instance = reused ?? (await startInstance());
  const lease: Lease = { instance, released: false };
  let disposed: Promise<void> | null = null;
  return {
    db: new TestD1(lease) as unknown as D1Database,
    dispose: () => {
      if (disposed === null) {
        lease.released = true;
        disposed = release(instance);
      }
      return disposed;
    },
  };
}
