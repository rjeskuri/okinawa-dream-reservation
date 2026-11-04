// The demo catalog: seed/demo.sql over the real migrations in an in-memory D1, read back with readCatalog, then
// scripts/demo.sh in a copy of the checkout with npm, npx, wrangler and astro faked, so no test builds, starts a server or
// reaches Cloudflare. The shop's figures are not repeated here: only the shape the ticket states is, and photos are
// checked against their own bytes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isPhotoKey, photoUrl, readPhotoIndex } from "../src/lib/catalog/photos.ts";
import { readCatalog, replaceCatalog } from "../src/lib/db/catalog-store.ts";
import type { PublishedCatalog } from "../src/lib/db/catalog-store.ts";
import { LOCALES } from "../src/lib/locale.ts";
import type { Locale } from "../src/lib/locale.ts";
import { createTestDb } from "./helpers/d1.ts";
import { md5Hex } from "./helpers/photos.ts";
import { seedBooking } from "./helpers/seed.ts";

const repoRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const seedFile = join(repoRoot, "seed", "demo.sql");
const photosDir = join(repoRoot, "seed", "photos");
const script = join(repoRoot, "scripts", "demo.sh");

const BIKE_CLASSES = 9;
const CAR_CLASSES = 3;
const CATALOG_TABLES = [
  "catalog_meta",
  "vehicle_types",
  "rate_classes",
  "models",
  "vehicles",
  "packages",
  "prices",
  "options",
  "config",
  "cancellation_tiers",
  "closed_dates",
  "photos",
];

type PhotoRow = { name: string; md5: string; r2_key: string; content_type: string; bytes: number };

/** The statements of a SQL file, split the way tests/helpers/d1.ts splits a migration. */
function sqlStatements(sql: string): string[] {
  return sql
    .split(/;[ \t]*\r?\n/)
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement !== "");
}

async function loadDemoSeed(db: D1Database): Promise<void> {
  for (const statement of sqlStatements(readFileSync(seedFile, "utf8"))) await db.prepare(statement).run();
}

async function withDemoDb(body: (db: D1Database) => Promise<void>): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await loadDemoSeed(db);
    await body(db);
  } finally {
    await dispose();
  }
}

async function demoCatalog(db: D1Database): Promise<PublishedCatalog> {
  const catalog = await readCatalog(db);
  assert.ok(catalog, "seed/demo.sql left no published catalog");
  return catalog;
}

async function photoRows(db: D1Database): Promise<PhotoRow[]> {
  const { results } = await db.prepare("SELECT * FROM photos ORDER BY name").all<PhotoRow>();
  return results;
}

async function rowCounts(db: D1Database): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of CATALOG_TABLES) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

/** A catalog without what a load may legitimately change: its version and when it was published. */
function content({ version: _version, publishedAt: _publishedAt, ...catalog }: PublishedCatalog) {
  return catalog;
}

const sorted = (list: string[]): string[] => [...list].sort();

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** What real text of each locale must look like, so English pasted into every locale cannot pass. */
const LOCALE_SCRIPT: Record<Locale, (text: string) => boolean> = {
  ja: (text) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text),
  en: (text) => !CJK.test(text),
  "zh-cn": (text) => /\p{Script=Han}/u.test(text),
  ko: (text) => /\p{Script=Hangul}/u.test(text),
};

/** The image type a file's first bytes say it is, whatever its name or its row claims. */
function sniffImageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const KEY_EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

test("the demo seed loads and covers all three vehicle types", async () => {
  await withDemoDb(async (db) => {
    const catalog = await demoCatalog(db);

    assert.deepEqual(sorted(catalog.vehicleTypes.map(({ id }) => id)), ["car", "motorcycle", "scooter"]);
    const bookable = new Set(catalog.vehicles.filter(({ status }) => status === "active").map(({ modelId }) => modelId));
    for (const { id } of catalog.vehicleTypes) {
      const models = catalog.models.filter(({ typeId, active }) => typeId === id && active);
      assert.ok(models.some((model) => bookable.has(model.id)), `no active vehicle of type ${id}`);
    }

    assert.equal(catalog.rateClasses.filter(({ grp }) => grp === "bike").length, BIKE_CLASSES);
    assert.equal(catalog.rateClasses.filter(({ grp }) => grp === "car").length, CAR_CLASSES);

    // The fee schedule by group: a package counts for a group when one of the group's classes has a price for it.
    const classGroup = new Map(catalog.rateClasses.map(({ id, grp }) => [id, grp]));
    const pricedIn = (grp: string) => {
      const ids = new Set(catalog.prices.filter(({ rateClassId }) => classGroup.get(rateClassId) === grp).map(({ packageId }) => packageId));
      return catalog.packages.filter(({ id }) => ids.has(id));
    };
    const bikePackages = pricedIn("bike");
    assert.ok(bikePackages.length >= 3, "the bike fee schedule needs 4-hour, same-day and 24-hour packages");
    assert.ok(bikePackages.some(({ hours }) => hours === 4), "no 4-hour bike package");
    assert.ok(bikePackages.some(({ hours, days }) => hours === 24 || days === 1), "no 24-hour bike package");
    const carDays = pricedIn("car").map(({ days }) => days);
    for (const days of [1, 2, 3, 4, 5, 6, 7]) assert.ok(carDays.includes(days), `no ${days}-day car package`);

    assert.ok(catalog.rateClasses.some(({ extensionPerHourJpy }) => extensionPerHourJpy !== null), "no hourly extension");
    assert.ok(catalog.options.length > 0, "no options");
    assert.ok(catalog.cancellationTiers.length > 0, "no refund tiers");
    assert.ok(catalog.closedDates.length > 0, "no closed dates");
    for (const date of catalog.closedDates) {
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(!Number.isNaN(Date.parse(`${date}T00:00:00Z`)), `${date} is not a date`);
    }
  });
});

test("every locale has text for every type, model and package", async () => {
  await withDemoDb(async (db) => {
    const catalog = await demoCatalog(db);
    const locales = sorted([...LOCALES]);

    const named = [...catalog.vehicleTypes, ...catalog.rateClasses, ...catalog.packages, ...catalog.options];
    for (const { id, texts } of named) {
      assert.deepEqual(sorted(Object.keys(texts)), locales, id);
      for (const locale of LOCALES) assert.ok(texts[locale].name.trim(), `${id} has no ${locale} name`);
      assert.ok(LOCALE_SCRIPT.en(texts.en.name), `${id} en name is not English: ${texts.en.name}`);
    }

    // Class and option names can be the same everywhere (125cc, ETC); these are words, so each locale has its own.
    for (const { id, texts } of [...catalog.vehicleTypes, ...catalog.packages]) {
      for (const locale of LOCALES) {
        assert.ok(LOCALE_SCRIPT[locale](texts[locale].name), `${id} ${locale} name is not ${locale}: ${texts[locale].name}`);
      }
    }

    for (const { id, texts } of catalog.models) {
      assert.deepEqual(sorted(Object.keys(texts)), locales, id);
      for (const field of ["name", "summary", "description"] as const) {
        for (const locale of LOCALES) assert.ok(texts[locale][field].trim(), `${id} has no ${locale} ${field}`);
      }
      assert.ok(LOCALE_SCRIPT.en(texts.en.name), `${id} en name is not English: ${texts.en.name}`);
      for (const field of ["summary", "description"] as const) {
        const values = LOCALES.map((locale) => texts[locale][field]);
        assert.equal(new Set(values).size, LOCALES.length, `${id} repeats a ${field} across locales: ${values.join(" | ")}`);
        for (const locale of LOCALES) {
          assert.ok(LOCALE_SCRIPT[locale](texts[locale][field]), `${id} ${locale} ${field} is not ${locale}: ${texts[locale][field]}`);
        }
      }
    }
  });
});

test("every model names a photo that has a photos row and a file", async () => {
  await withDemoDb(async (db) => {
    const catalog = await demoCatalog(db);
    const rows = new Map((await photoRows(db)).map((row) => [row.name, row]));
    const index = await readPhotoIndex(db);
    const maxBytes = catalog.config.photoMaxMb * 1024 * 1024;
    const firstPhotos: string[] = [];

    for (const model of catalog.models) {
      assert.ok(model.photos.length > 0, `${model.id} names no photo`);
      firstPhotos.push(rows.get(model.photos[0])?.md5 ?? model.photos[0]);

      for (const name of model.photos) {
        const row = rows.get(name);
        assert.ok(row, `${model.id} names ${name}, which has no photos row`);
        const file = join(photosDir, name);
        assert.ok(existsSync(file), `${name} is not in seed/photos`);
        const bytes = readFileSync(file);

        // The row describes these bytes, as a real copy from Drive would.
        const type = sniffImageType(bytes);
        assert.ok(type, `${name} is not a JPEG, PNG or WebP file`);
        assert.equal(row.content_type, type, name);
        assert.equal(row.md5, md5Hex(bytes), name);
        assert.equal(row.bytes, bytes.length, name);
        assert.ok(row.bytes <= maxBytes, `${name} is over photo_max_mb`);

        // What /media serves: a key of the md5 and the type, or a 404.
        assert.equal(row.r2_key, `photos/${md5Hex(bytes)}.${KEY_EXTENSIONS[type]}`, name);
        assert.ok(isPhotoKey(row.r2_key), `/media refuses ${row.r2_key}`);
        assert.equal(photoUrl(name, index), `/media/${row.r2_key}`);
      }
    }

    assert.equal(new Set(firstPhotos).size, catalog.models.length, "models share a placeholder: one per model");
  });
});

test("every vehicle and price references a seeded model and package", async () => {
  await withDemoDb(async (db) => {
    const catalog = await demoCatalog(db);
    const modelIds = new Set(catalog.models.map(({ id }) => id));
    const packageIds = new Set(catalog.packages.map(({ id }) => id));
    const classes = new Map(catalog.rateClasses.map((rateClass) => [rateClass.id, rateClass]));
    const typeIds = new Set(catalog.vehicleTypes.map(({ id }) => id));

    assert.ok(catalog.vehicles.length > 0, "no vehicles");
    for (const { plate, modelId } of catalog.vehicles) assert.ok(modelIds.has(modelId), `${plate}: no model ${modelId}`);

    assert.ok(catalog.prices.length > 0, "no prices");
    for (const { rateClassId, packageId, priceJpy } of catalog.prices) {
      assert.ok(classes.has(rateClassId), `price of unknown class ${rateClassId}`);
      assert.ok(packageIds.has(packageId), `price of unknown package ${packageId}`);
      assert.ok(Number.isInteger(priceJpy) && priceJpy > 0, `${rateClassId} ${packageId}: ${priceJpy} is not whole yen`);
    }

    // Nothing is left dangling the other way: what a guest can pick has a price, and what is priced can be picked.
    const pricedClasses = new Set(catalog.prices.map(({ rateClassId }) => rateClassId));
    const pricedPackages = new Set(catalog.prices.map(({ packageId }) => packageId));
    for (const id of classes.keys()) assert.ok(pricedClasses.has(id), `class ${id} has no price`);
    for (const id of packageIds) assert.ok(pricedPackages.has(id), `package ${id} has no price`);

    const withVehicle = new Set(catalog.vehicles.filter(({ status }) => status === "active").map(({ modelId }) => modelId));
    for (const { id, typeId, rateClassId, licenseClass, active } of catalog.models) {
      assert.ok(typeIds.has(typeId), `${id}: no type ${typeId}`);
      const rateClass = classes.get(rateClassId);
      assert.ok(rateClass, `${id}: no class ${rateClassId}`);
      assert.equal(rateClass.grp, typeId === "car" ? "car" : "bike", `${id} is priced in the wrong group`);
      assert.equal(licenseClass === "car", typeId === "car", `${id} has license class ${licenseClass}`);
      if (active) assert.ok(withVehicle.has(id), `${id} is active with no active vehicle, so it cannot be booked`);
    }
  });
});

test("loading the demo seed twice leaves the same rows", async () => {
  await withDemoDb(async (db) => {
    const counts = await rowCounts(db);
    const catalog = await demoCatalog(db);
    const photos = await readPhotoIndex(db);
    for (const table of CATALOG_TABLES) assert.ok(counts[table] > 0, `${table} is empty`);

    await loadDemoSeed(db);

    assert.deepEqual(await rowCounts(db), counts);
    assert.deepEqual(content(await demoCatalog(db)), content(catalog));
    assert.deepEqual(await readPhotoIndex(db), photos);
  });
});

test("loading the demo seed again does not fail on a booking made in between", async () => {
  await withDemoDb(async (db) => {
    const counts = await rowCounts(db);
    const catalog = await demoCatalog(db);
    const vehicle = catalog.vehicles.find(({ status }) => status === "active");
    assert.ok(vehicle, "no active vehicle");

    // Bookings reference models and vehicles, so a seed that clears those first fails here and not on a fresh database.
    await seedBooking(db, { vehicle_plate: vehicle.plate, model_id: vehicle.modelId });
    await loadDemoSeed(db);

    assert.deepEqual(await rowCounts(db), counts);
  });
});

test("the demo catalog writes back through replaceCatalog unchanged", async () => {
  await withDemoDb(async (db) => {
    const seeded = await demoCatalog(db);
    const { version, publishedAt } = seeded;

    const result = await replaceCatalog(db, content(seeded), { now: publishedAt + 1, source: "admin" });

    assert.equal(result.version, version + 1);
    assert.deepEqual(result.retiredVehicles, []);
    assert.deepEqual(result.deactivatedModels, []);
    assert.deepEqual(await readCatalog(db), { ...seeded, version: version + 1, publishedAt: publishedAt + 1 });
  });
});

// scripts/demo.sh. A fake logs each call and does nothing, so these cover what the script asks wrangler to do. The real
// site starting is not proved here: it needs a real build and server.

/** What a call amounts to, however it was spelled: a package.json script, npx, or the binary itself. */
function resolved(tool: string, args: string[], scripts: Record<string, string>): string[] {
  if (tool === "npx") return args.slice(args.findIndex((arg) => !arg.startsWith("-")));
  if (tool === "npm" && args[0] === "run" && scripts[args[1]] !== undefined) return scripts[args[1]].split(" ");
  return [tool, ...args];
}

/** The value of a flag written `--flag value` or `--flag=value`. */
function flag(call: string[], ...names: string[]): string | undefined {
  for (const [index, arg] of call.entries()) {
    for (const name of names) {
      if (arg === name) return call[index + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

type Call = { cwd: string; argv: string[] };
type Run = { status: number | null; output: string; calls: Call[] };

const isWrangler = (call: Call, ...words: string[]): boolean =>
  call.argv[0] === "wrangler" && words.every((word, index) => call.argv[index + 1] === word);

/** The file a call's `--file` names, resolved from where the call ran. */
function fileOf(call: Call): string | undefined {
  const file = flag(call.argv, "--file");
  return file === undefined ? undefined : resolve(call.cwd, file);
}

/** A copy of what a clean checkout holds for the script, with no .dev.vars and no seed/photos-local, and fakes for the tools. */
function withCheckout<T>(body: (root: string, run: () => Run) => T): T {
  assert.ok(existsSync(script), "scripts/demo.sh does not exist");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "demo-script-")));
  try {
    const root = join(base, "checkout");
    const bin = join(base, "bin");
    const log = join(base, "calls.log");
    mkdirSync(bin);
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    for (const path of ["scripts", "migrations", ".dev.vars.example", "wrangler.jsonc", "package.json"]) {
      cpSync(join(repoRoot, path), join(root, path), { recursive: true });
    }
    cpSync(join(repoRoot, "seed"), join(root, "seed"), {
      recursive: true,
      filter: (source) => !source.includes(join("seed", "photos-local")),
    });

    // The fakes stand in on PATH and in node_modules/.bin, so the script may call the tools either way.
    const fake = (tool: string) =>
      `#!/bin/sh\n{ printf '%s' "$(pwd -P)"; printf '\\t%s' ${tool} "$@"; printf '\\n'; } >> '${log}'\n`;
    for (const tool of ["npm", "npx", "wrangler", "astro"]) {
      writeFileSync(join(bin, tool), fake(tool));
      chmodSync(join(bin, tool), 0o755);
    }
    for (const tool of ["wrangler", "astro"]) {
      writeFileSync(join(root, "node_modules", ".bin", tool), fake(tool));
      chmodSync(join(root, "node_modules", ".bin", tool), 0o755);
    }

    const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const run = (): Run => {
      rmSync(log, { force: true });
      // No Cloudflare credentials and no real home: a clean machine, and /sbin is where macOS keeps md5.
      const result = spawnSync(join(root, "scripts", "demo.sh"), [], {
        cwd: root,
        env: {
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: base,
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.ifError(result.error);
      const lines = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
      const calls = lines.map((line) => {
        const [cwd, tool, ...args] = line.split("\t");
        return { cwd, argv: resolved(tool, args, scripts) };
      });
      return { status: result.status, output: result.stdout + result.stderr, calls };
    };
    return body(root, run);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function demoPhotoRows(): Promise<PhotoRow[]> {
  const { db, dispose } = await createTestDb();
  try {
    await loadDemoSeed(db);
    return await photoRows(db);
  } finally {
    await dispose();
  }
}

const bucket = (): string => {
  const match = /"bucket_name":\s*"([^"]+)"/.exec(readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8"));
  assert.ok(match, "no bucket in wrangler.jsonc");
  return match[1];
};

/** Each `wrangler r2 object put`, as the object it writes and the file it reads. */
function puts(run: Run): { call: Call; object: string; file: string | undefined }[] {
  const prefix = `${bucket()}/`;
  return run.calls
    .filter((call) => isWrangler(call, "r2", "object", "put"))
    .map((call) => ({
      call,
      object: call.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? "",
      file: fileOf(call),
    }));
}

test("scripts/demo.sh builds, seeds and starts the Worker on a clean checkout with no Cloudflare login", () => {
  withCheckout((root, run) => {
    const result = run();
    assert.equal(result.status, 0, result.output);
    const { calls } = result;

    const build = calls.findIndex(({ argv }) => argv[0] === "astro" && argv[1] === "build");
    const migrate = calls.findIndex((call) => isWrangler(call, "d1", "migrations", "apply"));
    const seed = calls.findIndex((call) => isWrangler(call, "d1", "execute") && fileOf(call) === join(root, "seed", "demo.sql"));
    const dev = calls.findIndex((call) => isWrangler(call, "dev"));
    assert.ok(build >= 0, "no astro build");
    assert.ok(migrate >= 0, "no migrations applied");
    assert.ok(seed >= 0, "seed/demo.sql was not loaded");
    assert.ok(dev >= 0, "no wrangler dev");
    assert.ok(migrate < seed, "the seed needs the tables first");
    assert.equal(dev, calls.length - 1, "wrangler dev blocks, so it comes last");

    // Only the local D1 and R2: nothing here may need an account.
    for (const call of calls.filter(({ argv }) => argv[0] === "wrangler")) {
      const text = call.argv.join(" ");
      assert.ok(!call.argv.includes("--remote"), text);
      assert.ok(!["login", "whoami", "deploy"].includes(call.argv[1]), text);
      if (isWrangler(call, "d1") || isWrangler(call, "r2")) assert.ok(call.argv.includes("--local"), text);
    }

    // Without this flag wrangler dev answers 404 to the documented cron curl.
    assert.ok(calls[dev].argv.includes("--test-scheduled"), calls[dev].argv.join(" "));

    // The example alone is enough: its values reach the Worker.
    const example = readFileSync(join(root, ".dev.vars.example"), "utf8");
    const devVars = join(root, ".dev.vars");
    const fromExample = flag(calls[dev].argv, "--env-file") === ".dev.vars.example";
    assert.ok(fromExample || (existsSync(devVars) && readFileSync(devVars, "utf8") === example), "the Worker gets no secrets");
  });
});

test("scripts/demo.sh puts every seeded photo in the local bucket under its row's key", async () => {
  const rows = await demoPhotoRows();
  assert.ok(rows.length > 0, "no photos rows");
  withCheckout((root, run) => {
    const result = run();
    assert.equal(result.status, 0, result.output);
    const written = puts(result);

    for (const row of rows) {
      const put = written.find(({ object }) => object === row.r2_key);
      assert.ok(put, `${row.name} was not put at ${row.r2_key}`);
      assert.equal(put.file, join(root, "seed", "photos", row.name));
      assert.ok(put.call.argv.includes("--local"), put.call.argv.join(" "));
      // /media sends what the object stores, so without this the local site serves photos with no type.
      assert.equal(flag(put.call.argv, "--content-type", "--ct"), row.content_type, row.name);
    }
  });
});

test("scripts/demo.sh uses a photo from seed/photos-local in place of its placeholder", async () => {
  const rows = await demoPhotoRows();
  assert.ok(rows.length >= 2, "needs two photos rows");
  const [replaced, ...kept] = rows;

  // Their rights are unconfirmed, so the folder must never be committed.
  const ignored = spawnSync("git", ["check-ignore", "-q", "seed/photos-local/shop-photo.jpg"], { cwd: repoRoot });
  assert.equal(ignored.status, 0, "seed/photos-local is not gitignored");

  withCheckout((root, run) => {
    mkdirSync(join(root, "seed", "photos-local"));
    const local = join(root, "seed", "photos-local", replaced.name);
    writeFileSync(local, randomUUID());

    const result = run();
    assert.equal(result.status, 0, result.output);
    const written = puts(result);

    assert.deepEqual(
      written.filter(({ object }) => object === replaced.r2_key).map(({ file }) => file),
      [local],
    );
    for (const row of kept) {
      const put = written.find(({ object }) => object === row.r2_key);
      assert.equal(put?.file, join(root, "seed", "photos", row.name), `${row.name} has no local photo, so it stays the placeholder`);
    }
  });
});

test("scripts/demo.sh runs twice and leaves an existing .dev.vars alone", () => {
  withCheckout((root, run) => {
    const first = run();
    assert.equal(first.status, 0, first.output);

    // By now the owner may have put real values here, which no copy of the example may overwrite.
    const devVars = join(root, ".dev.vars");
    const values = `SQUARE_ACCESS_TOKEN=${randomUUID()}\n`;
    writeFileSync(devVars, values);

    const second = run();
    assert.equal(second.status, 0, second.output);
    assert.ok(second.calls.some((call) => isWrangler(call, "dev")), "the second run did not start the site");
    assert.equal(readFileSync(devVars, "utf8"), values);
  });
});

// What wrangler.jsonc and `npm run dev` hold today, for astro dev on its own port: this ticket leaves them as they are.
const JSONC_SITE_URL = "http://localhost:4321";
const JSONC_WEBHOOK_URL = "http://localhost:4321/api/webhooks/square";
const WRANGLER_DEFAULT_PORT = 8787;

/** The vars a call passes with `--var KEY:VALUE` (wrangler's form), several to one `--var` or one each, or `--var=KEY:VALUE`. */
function cliVars(call: string[]): Map<string, string> {
  const vars = new Map<string, string>();
  const add = (pair: string) => {
    const colon = pair.indexOf(":");
    if (colon > 0) vars.set(pair.slice(0, colon), pair.slice(colon + 1));
  };
  for (const [index, arg] of call.entries()) {
    if (arg.startsWith("--var=")) add(arg.slice("--var=".length));
    if (arg !== "--var") continue;
    for (const value of call.slice(index + 1)) {
      if (value.startsWith("-")) break;
      add(value);
    }
  }
  return vars;
}

/** The port wrangler dev listens on: its `--port`, else the `dev.port` of the config, else wrangler's default. */
function devPort(call: string[], root: string): number {
  const port = flag(call, "--port");
  if (port !== undefined) return Number(port);
  const config = /"dev"\s*:\s*\{[^}]*"port"\s*:\s*(\d+)/.exec(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  return config ? Number(config[1]) : WRANGLER_DEFAULT_PORT;
}

test("the demo serves SITE_URL on its own port", () => {
  withCheckout((root, run) => {
    const result = run();
    assert.equal(result.status, 0, result.output);
    const dev = result.calls.find((call) => isWrangler(call, "dev"));
    assert.ok(dev, "no wrangler dev");
    const text = dev.argv.join(" ");

    const port = devPort(dev.argv, root);
    assert.ok(Number.isInteger(port) && port > 0, `wrangler dev listens on no port: ${text}`);
    const vars = cliVars(dev.argv);

    // Every link the Worker builds starts from SITE_URL, so it must be the server this script starts.
    const site = vars.get("SITE_URL");
    assert.ok(site, `wrangler dev gets no --var SITE_URL: ${text}`);
    const siteUrl = new URL(site);
    assert.equal(siteUrl.protocol, "http:", site);
    assert.ok(["localhost", "127.0.0.1"].includes(siteUrl.hostname), site);
    assert.equal(Number(siteUrl.port), port, `SITE_URL ${site} is not the port wrangler dev serves (${port})`);
    assert.equal(site, siteUrl.origin, `SITE_URL is an origin with no path, as in wrangler.jsonc: ${site}`);

    // Square posts to the same server, at the path wrangler.jsonc gives the webhook.
    const webhook = vars.get("SQUARE_WEBHOOK_URL");
    assert.ok(webhook, `wrangler dev gets no --var SQUARE_WEBHOOK_URL: ${text}`);
    assert.equal(webhook, `${siteUrl.origin}${new URL(JSONC_WEBHOOK_URL).pathname}`);
  });

  // The demo overrides them on its own command line; the config astro dev reads is unchanged.
  const config = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
  assert.equal(/"SITE_URL":\s*"([^"]+)"/.exec(config)?.[1], JSONC_SITE_URL);
  assert.equal(/"SQUARE_WEBHOOK_URL":\s*"([^"]+)"/.exec(config)?.[1], JSONC_WEBHOOK_URL);
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(scripts.dev, "astro dev");
});
