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

/** A fresh in-memory D1 (Miniflare, no persistence) with every migration applied. */
export async function createTestDb(): Promise<TestDb> {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
      compatibilityDate: "2026-10-01",
      d1Databases: { DB: "test-db" },
    }),
  );
  try {
    const db = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applyMigrations(db);
    return { db, dispose: () => mf.dispose() };
  } catch (error) {
    // A live Miniflare keeps the process open, so never leak one from a failed start.
    await mf.dispose();
    throw error;
  }
}
