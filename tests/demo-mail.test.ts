// scripts/demo-mail.ts, run as a child process the way a developer runs it: `node scripts/demo-mail.ts`, with the output
// directory in DEMO_MAIL_DIR. `wrangler` and `npx` are fakes on PATH that answer `d1 execute DB --local --json` from a
// real SQLite file holding the real migrations and outbox rows that the real enqueue helper wrote, and print the result
// in wrangler's `--json` shape (an array of { results, success, meta }). So the script's SQL is executed for real and its
// parsing of wrangler's output is exercised; nothing reaches Cloudflare or the repo's own .wrangler state.
// Expected file contents come from renderEmail on the payload that was enqueued, never from the script.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { cancelToken, cancelUrl, verifyCancelToken } from "../src/lib/booking/cancel.ts";
import type { Locale } from "../src/lib/locale.ts";
import { renderEmail } from "../src/lib/mail/templates.ts";
import { enqueueStatements } from "../src/lib/outbox.ts";
import type { EmailPayload, OutboxItem } from "../src/lib/outbox.ts";
import { createTestDb, migrationStatements } from "./helpers/d1.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "demo-mail.ts");
const SECRET = "test-cancel-secret";
const siteUrl = /"SITE_URL":\s*"([^"]+)"/.exec(readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8"))?.[1] ?? "";

// What `wrangler d1 execute DB --local --json` is asked, answered from the SQLite file in FAKE_D1_PATH, read-only.
const FAKE_WRANGLER = `#!${process.execPath}
const { DatabaseSync } = require("node:sqlite");
const { readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
const fail = (message) => { console.error("fake wrangler: " + message); process.exit(1); };
if (process.env.FAKE_WRANGLER_FAIL) fail("simulated failure");
if (argv[0] !== "d1" || argv[1] !== "execute" || argv[2] !== "DB") fail("unexpected command " + argv.join(" "));
if (!argv.includes("--local")) fail("missing --local");
if (!argv.includes("--json")) fail("missing --json");
let sql;
for (let i = 3; i < argv.length; i++) {
  if (argv[i] === "--command") sql = argv[i + 1];
  else if (argv[i].startsWith("--command=")) sql = argv[i].slice("--command=".length);
  else if (argv[i] === "--file") sql = readFileSync(argv[i + 1], "utf8");
  else if (argv[i].startsWith("--file=")) sql = readFileSync(argv[i].slice("--file=".length), "utf8");
}
if (!sql) fail("no --command or --file");
const db = new DatabaseSync(process.env.FAKE_D1_PATH, { readOnly: true });
let results;
try { results = db.prepare(sql).all(); } catch (error) { fail("SQL error: " + error.message + " in " + sql); }
process.stdout.write(JSON.stringify([{ results, success: true, meta: { served_by: "fake", duration: 1, changes: 0, rows_read: results.length, rows_written: 0 } }], null, 2) + "\\n");
`;

type Row = Record<string, string | number | null>;

type Env = { dir: string; out: string; bin: string; sqlite: string };

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "demo-mail-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "wrangler"), FAKE_WRANGLER);
  writeFileSync(join(bin, "npx"), '#!/bin/sh\nexec "$@"\n');
  chmodSync(join(bin, "wrangler"), 0o755);
  chmodSync(join(bin, "npx"), 0o755);
  return { dir, out: join(dir, "out"), bin, sqlite: join(dir, "local.sqlite") };
}

/** Queues `items` with the real enqueue statements, sets each row's status, and copies the rows into a SQLite file. */
async function writeOutbox(env: Env, items: OutboxItem[], statuses: string[] = []): Promise<number[]> {
  const { db, dispose } = await createTestDb();
  let rows: Row[];
  try {
    if (items.length > 0) await db.batch(enqueueStatements(db, items, 1_800_000_000_000));
    for (const [index, status] of statuses.entries()) {
      await db.prepare("UPDATE outbox SET status = ?1 WHERE dedupe_key = ?2").bind(status, items[index].dedupeKey).run();
    }
    rows = (await db.prepare("SELECT * FROM outbox ORDER BY id").all<Row>()).results;
  } finally {
    await dispose();
  }
  const sqlite = new DatabaseSync(env.sqlite);
  for (const statement of migrationStatements()) sqlite.exec(statement);
  for (const row of rows) {
    const columns = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO outbox (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map((column) => row[column]));
  }
  sqlite.close();
  return rows.map((row) => row.id as number);
}

function run(env: Env, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: `${env.bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: env.dir,
      DEMO_MAIL_DIR: env.out,
      FAKE_D1_PATH: env.sqlite,
      ...extra,
    // Deliberately minimal: worker-configuration.d.ts makes the Worker's vars required on ProcessEnv.
    } as unknown as NodeJS.ProcessEnv,
  });
}

/** The .html and .txt files directly in the output directory. */
function written(env: Env): string[] {
  if (!existsSync(env.out)) return [];
  return readdirSync(env.out)
    .filter((name) => name.endsWith(".html") || name.endsWith(".txt"))
    .sort();
}

const read = (env: Env, name: string): string => readFileSync(join(env.out, name), "utf8");

async function withEnv(body: (env: Env) => Promise<void>): Promise<void> {
  const env = makeEnv();
  try {
    await body(env);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
}

// --- payloads, in the shape the enqueuers write (see tests/email-templates.test.ts for the contract) ---

const guest = { familyName: "O'Brien", givenName: "Mina", email: "mina@example.test", phone: "+81 90-1111-2222" };
const jaGuest = { familyName: "山田", givenName: "太郎", email: "taro@example.test", phone: "090-3333-4444" };

function booking(ref: string, startAt: number, price: number, paid: number, who: typeof guest) {
  return {
    ref,
    startAt,
    endAt: startAt + 3 * 86_400_000,
    priceJpy: price,
    paidJpy: paid,
    modelName: ref === "OD-B2B2B" ? "Yamaha Serow 250" : "Honda Dio 110",
    modelNameJa: ref === "OD-B2B2B" ? "ヤマハ セロー250" : "ホンダ ディオ110",
    packageName: "3 days",
    packageNameJa: "3日間",
    shopOpen: "09:00",
    shopClose: "18:00",
    guest: { familyName: who.familyName, givenName: who.givenName },
  };
}

async function confirmation(id: string, locale: Locale, ref: string, startAt: number, to: string): Promise<EmailPayload> {
  return {
    template: "guest_confirmation",
    to,
    locale,
    data: {
      ...booking(ref, startAt, 12_000, 5_500, locale === "ja" ? jaGuest : guest),
      cancelUrl: cancelUrl(siteUrl, locale, id, await cancelToken(SECRET, id)),
      policySummary: "Free cancellation up to 7 days before pickup.",
    },
  };
}

const email = (payload: EmailPayload): OutboxItem => ({
  kind: "email",
  dedupeKey: `email:${payload.template}:${payload.to}:${String((payload.data as { ref?: string }).ref ?? payload.template)}`,
  payload,
});

const sheet = (bookingId: string): OutboxItem => ({
  kind: "sheet_booking",
  dedupeKey: `sheet:${bookingId}`,
  payload: { bookingId },
});

async function allTemplates(): Promise<EmailPayload[]> {
  const a = booking("OD-A1A1A", Date.UTC(2027, 0, 10, 0, 0), 12_000, 5_500, guest);
  const b = booking("OD-B2B2B", Date.UTC(2027, 2, 1, 1, 0), 86_400, 30_000, jaGuest);
  const staff = (x: typeof a, who: typeof guest) => ({
    ...x,
    vehiclePlate: "OKINAWA-NA-12-34",
    guest: who,
  });
  return [
    await confirmation("bk-1", "en", "OD-A1A1A", a.startAt, "mina@example.test"),
    await confirmation("bk-2", "ja", "OD-B2B2B", b.startAt, "taro@example.test"),
    { template: "guest_cancellation", to: "mina@example.test", locale: "ko", data: { ...a, refundJpy: 2_750, refundStatus: "PENDING" } },
    { template: "staff_new_booking", to: "staff@example.test", locale: "ja", data: staff(b, jaGuest) },
    { template: "staff_cancellation", to: "staff@example.test", locale: "ja", data: { ...staff(a, guest), refundJpy: 2_750, refundStatus: "COMPLETED" } },
    { template: "staff_alert", to: "staff@example.test", locale: "ja", data: { title: "Sheet sync is failing", detail: "5 attempts: \"HTTP 500\" <retry>", ref: "OD-A1A1A" } },
    {
      template: "reconcile_report",
      to: "staff@example.test",
      locale: "ja",
      data: { runAt: Date.UTC(2027, 0, 5, 3, 0), issues: [{ type: "missing_payment", bookingRef: "OD-B2B2B", detail: "No Square payment found." }] },
    },
  ];
}

test("writes one html and one text file per email item", async () => {
  await withEnv(async (env) => {
    const payloads = await allTemplates();
    // Sheet items sit between the emails so the email ids are not 1..n, and the statuses differ: every email item is
    // rendered whatever its delivery state.
    const items: OutboxItem[] = [
      sheet("bk-1"),
      email(payloads[0]),
      email(payloads[1]),
      sheet("bk-2"),
      email(payloads[2]),
      email(payloads[3]),
      sheet("bk-3"),
      email(payloads[4]),
      email(payloads[5]),
      email(payloads[6]),
    ];
    const ids = await writeOutbox(env, items, ["pending", "sent", "pending", "pending", "dead", "pending", "pending", "sent"]);

    const result = run(env);
    assert.equal(result.status, 0, `exit ${result.status}\n${result.stderr}`);

    const emailIds = ids.filter((_, index) => items[index].kind === "email");
    assert.equal(emailIds.length, payloads.length);
    assert.deepEqual(
      written(env),
      emailIds.flatMap((id) => [`${id}.html`, `${id}.txt`]).sort(),
    );

    for (const [index, item] of items.entries()) {
      if (item.kind !== "email") continue;
      const rendered = renderEmail(item.payload);
      const html = read(env, `${ids[index]}.html`);
      const text = read(env, `${ids[index]}.txt`);
      assert.ok(html.includes(rendered.html), `${ids[index]}.html (${item.payload.template}) does not hold the rendered html`);
      assert.ok(text.includes(rendered.text), `${ids[index]}.txt (${item.payload.template}) does not hold the rendered text`);
    }
    // Different payloads give different files, so one rendering reused for every item cannot pass.
    assert.equal(new Set(emailIds.map((id) => read(env, `${id}.txt`))).size, emailIds.length);
  });
});

test("non-email outbox items are skipped", async () => {
  await withEnv(async (env) => {
    const confirmationPayload = await confirmation("bk-9", "en", "OD-C3C3C", Date.UTC(2027, 4, 1), "c@example.test");
    const ids = await writeOutbox(env, [sheet("bk-7"), sheet("bk-8"), email(confirmationPayload), sheet("bk-9")]);

    const result = run(env);
    assert.equal(result.status, 0, `exit ${result.status}\n${result.stderr}`);
    // Only the email (the third row) is written; none of the sheet rows' ids appears.
    assert.deepEqual(written(env), [`${ids[2]}.html`, `${ids[2]}.txt`]);
  });
});

test("an outbox with only sheet items, or nothing, writes no files and succeeds", async () => {
  for (const items of [[sheet("bk-1"), sheet("bk-2")], []]) {
    await withEnv(async (env) => {
      await writeOutbox(env, items);
      const result = run(env);
      assert.equal(result.status, 0, `exit ${result.status}\n${result.stderr}`);
      assert.deepEqual(written(env), []);
    });
  }
});

test("a guest confirmation's files hold its working local cancel link", async () => {
  await withEnv(async (env) => {
    const first = await confirmation("bk-link-1", "en", "OD-D4D4D", Date.UTC(2027, 5, 1), "one@example.test");
    const second = await confirmation("bk-link-2", "ko", "OD-E5E5E", Date.UTC(2027, 6, 1), "two@example.test");
    const ids = await writeOutbox(env, [email(first), email(second)]);

    const result = run(env);
    assert.equal(result.status, 0, `exit ${result.status}\n${result.stderr}`);

    for (const [index, bookingId, locale] of [[0, "bk-link-1", "en"], [1, "bk-link-2", "ko"]] as const) {
      const link = (index === 0 ? first : second).data.cancelUrl as string;
      const text = read(env, `${ids[index]}.txt`);
      assert.ok(text.includes(link), `${ids[index]}.txt lacks ${link}`);

      const html = read(env, `${ids[index]}.html`);
      const hrefs = [...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*"([^"]*)"/gi)].map((m) =>
        m[1].replaceAll("&amp;", "&").replaceAll("&#38;", "&").replaceAll("&#x26;", "&"),
      );
      assert.ok(hrefs.includes(link), `${ids[index]}.html has no anchor to ${link}: ${hrefs.join(", ")}`);

      // Local, and valid: the origin is the local site, the path is this booking's cancel page, the token verifies.
      const url = new URL(link);
      assert.equal(url.origin, new URL(siteUrl).origin);
      assert.equal(url.origin, "http://localhost:4321");
      assert.equal(url.pathname, `/${locale}/booking/cancel`);
      assert.equal(url.searchParams.get("b"), bookingId);
      assert.ok(await verifyCancelToken(SECRET, bookingId, url.searchParams.get("t") ?? ""));
    }
    // Each file carries its own booking's link, not the other's.
    assert.ok(!read(env, `${ids[0]}.txt`).includes("bk-link-2"));
    assert.ok(!read(env, `${ids[1]}.txt`).includes("bk-link-1"));
  });
});

test("the script fails when wrangler fails, and writes nothing", async () => {
  await withEnv(async (env) => {
    const [id] = await writeOutbox(env, [
      email(await confirmation("bk-1", "en", "OD-F6F6F", Date.UTC(2027, 7, 1), "f@example.test")),
    ]);
    // The same outbox works, so the failure below is wrangler's.
    const ok = run(env);
    assert.equal(ok.status, 0, `exit ${ok.status}\n${ok.stderr}`);
    assert.deepEqual(written(env), [`${id}.html`, `${id}.txt`]);
    rmSync(env.out, { recursive: true, force: true });

    const result = run(env, { FAKE_WRANGLER_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(written(env), []);
  });
});

test(".demo-mail/ is gitignored", () => {
  const ignored = spawnSync("git", ["check-ignore", "-q", ".demo-mail/1.html"], { cwd: repoRoot });
  assert.equal(ignored.status, 0, ".demo-mail/ is not ignored");
});
