// Shared e2e helper: builds the site once when the output is stale, then runs the built Worker in Miniflare
// with D1, R2 and test values for every var and secret. Outbound requests go to `opts.outbound`;
// by default every outbound request fails with a 502 so no test reaches the network.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { applyMigrations } from "./d1.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const watched = ["src", "migrations", "astro.config.mjs", "wrangler.jsonc"];
const deployConfigPath = join(root, ".wrangler", "deploy", "config.json");
const lockDir = join(root, ".wrangler", "e2e-build.lock");
const lockStaleMs = 10 * 60 * 1000;

/** Test values for every var and secret the Worker declares. Secrets are plainly fake. */
export const testVars: Record<string, string> = {
  SITE_URL: "http://localhost:4321",
  SQUARE_ENV: "sandbox",
  SQUARE_APPLICATION_ID: "test-square-application-id",
  SQUARE_LOCATION_ID: "test-square-location-id",
  SQUARE_WEBHOOK_URL: "http://localhost:4321/api/square/webhook",
  GOOGLE_SHEET_ID: "test-google-sheet-id",
  GOOGLE_DRIVE_FOLDER_ID: "test-google-drive-folder-id",
  APPS_SCRIPT_MAIL_URL: "https://script.example/mail",
  STAFF_EMAIL: "staff@example.com",
  ENABLE_GOOGLE_PAY: "false",
  ENABLE_APPLE_PAY: "false",
  SQUARE_ACCESS_TOKEN: "test-square-access-token",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "test-square-webhook-signature-key",
  GOOGLE_SA_EMAIL: "test-sa@example.iam.gserviceaccount.com",
  GOOGLE_SA_PRIVATE_KEY: "test-google-sa-private-key",
  PUBLISH_SECRET: "test-publish-secret",
  MAIL_SECRET: "test-mail-secret",
  CANCEL_LINK_SECRET: "test-cancel-link-secret",
};

export interface StartWorkerOptions {
  /** Overrides for vars and secrets. */
  vars?: Record<string, string>;
  /** Answers the Worker's outbound `fetch()` calls. Default: every outbound request fails with a 502. */
  outbound?: (request: Request) => Response | Promise<Response>;
}

export interface TestWorker {
  /** Fetches `path` from the built Worker. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Triggers the Worker's `scheduled()` handler for `cron`. */
  scheduled(cron: string, scheduledTime?: number): Promise<void>;
  db: D1Database;
  media: R2Bucket;
  stop(): Promise<void>;
}

function blockedOutbound(request: Request): Response {
  return new Response(`outbound request blocked by tests/helpers/worker.ts: ${request.method} ${request.url}`, {
    status: 502,
  });
}

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const name of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, name)));
  }
  return newest;
}

/** The built Worker's wrangler config and entry module, by following `.wrangler/deploy/config.json`. */
function builtOutput(): { configPath: string; main: string } | null {
  if (!existsSync(deployConfigPath)) return null;
  const deploy = JSON.parse(readFileSync(deployConfigPath, "utf8")) as { configPath?: string };
  if (!deploy.configPath) return null;
  const configPath = resolve(dirname(deployConfigPath), deploy.configPath);
  if (!existsSync(configPath)) return null;
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { main?: string };
  if (!config.main) return null;
  const main = resolve(dirname(configPath), config.main);
  return existsSync(main) ? { configPath, main } : null;
}

function needsBuild(): boolean {
  const built = builtOutput();
  if (!built) return true;
  const builtAt = statSync(built.main).mtimeMs;
  return watched.some((name) => newestMtime(join(root, name)) > builtAt);
}

function build(): void {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "astro", "bin", "astro.mjs"), "build"], {
    cwd: root,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`astro build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

/** Builds when the output is missing or older than the sources, under a lock so parallel runs build once. */
async function buildIfStale(): Promise<{ configPath: string; main: string }> {
  mkdirSync(dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - statSync(lockDir).mtimeMs > lockStaleMs) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      await sleep(250);
    }
  }
  try {
    if (needsBuild()) build();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
  const built = builtOutput();
  if (!built) throw new Error("astro build left no Worker behind .wrangler/deploy/config.json");
  return built;
}

/** Every `.mjs` module of the built Worker, entry first, so Miniflare loads the whole bundle. */
function builtModules(main: string): { type: "ESModule"; path: string }[] {
  const serverDir = dirname(main);
  const others = readdirSync(serverDir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => resolve(serverDir, name))
    .filter((path) => path !== main)
    .sort();
  return [main, ...others].map((path) => ({ type: "ESModule" as const, path }));
}

export async function startWorker(opts: StartWorkerOptions = {}): Promise<TestWorker> {
  const { configPath, main } = await buildIfStale();
  const { workerOptions } = unstable_getMiniflareWorkerOptions(configPath);
  // The v4-to-v5 converter refuses `modulesRules`; the explicit module list below replaces them.
  const { modulesRules: _modulesRules, ...worker } = workerOptions;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      ...worker,
      modulesRoot: dirname(main),
      modules: builtModules(main),
      bindings: { ...worker.bindings, ...testVars, ...opts.vars },
      outboundService: opts.outbound ?? blockedOutbound,
    }),
  );
  let db: D1Database;
  let media: R2Bucket;
  let fetcher: Awaited<ReturnType<Miniflare["getWorker"]>>;
  try {
    await mf.ready;
    db = (await mf.getD1Database("DB")) as unknown as D1Database;
    media = (await mf.getR2Bucket("MEDIA")) as unknown as R2Bucket;
    await applyMigrations(db);
    fetcher = await mf.getWorker();
  } catch (error) {
    // A live Miniflare keeps the process open, so never leak one from a failed start.
    await mf.dispose();
    throw error;
  }
  return {
    async fetch(path, init) {
      return (await fetcher.fetch(new URL(path, "http://localhost").href, init as never)) as unknown as Response;
    },
    async scheduled(cron, scheduledTime = Date.now()) {
      await fetcher.scheduled({ cron, scheduledTime });
    },
    db,
    media,
    stop: () => mf.dispose(),
  };
}
