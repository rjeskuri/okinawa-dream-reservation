// The photo copy: syncPhotos against a fake Drive folder and a fake R2 bucket over a real D1, the Drive client against a
// fake fetch that speaks the API's JSON, and the name-to-URL helpers for pages. Expected keys and rows are worked out here
// from the fixtures with node:crypto, and rows are read through SQL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { replaceCatalog } from "../src/lib/db/catalog-store.ts";
import { createTestDb } from "./helpers/d1.ts";
import { md5Hex, photoBytes, photoCatalog, type PhotoModel } from "./helpers/photos.ts";
import { insertRow, type SqlRow } from "./helpers/seed.ts";

/** Loaded where they are needed, so each test reports its own failure until the modules exist. */
const photos = () => import("../src/lib/catalog/photos.ts");
const driveModule = () => import("../src/lib/google/drive.ts");

type SyncDeps = Parameters<Awaited<ReturnType<typeof photos>>["syncPhotos"]>[0];
type SyncResult = Awaited<ReturnType<Awaited<ReturnType<typeof photos>>["syncPhotos"]>>;
type DriveFile = Awaited<ReturnType<SyncDeps["drive"]["listFolder"]>>[number];

/** A Drive entry and the bytes behind it. Google Docs have no md5Checksum and no size. */
type FolderFile = {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: number;
  bytes: Uint8Array<ArrayBuffer>;
};

const NOW = Date.parse("2030-03-01T12:00:00+09:00");
const FOLDER = "1photoFolderAbC-dEf_0123456789";
const MAX_BYTES = 5_000_000;

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function photoFile(name: string, mimeType: string, seed: number, length?: number, id = `drive-${seed}`): FolderFile {
  const bytes = photoBytes(seed, length);
  return { id, name, mimeType, md5Checksum: md5Hex(bytes), size: bytes.length, bytes };
}

function keyOf(file: FolderFile): string {
  return `photos/${md5Hex(file.bytes)}.${EXTENSIONS[file.mimeType]}`;
}

function rowOf(file: FolderFile, copiedAt: number): SqlRow {
  return {
    name: file.name,
    drive_file_id: file.id,
    md5: md5Hex(file.bytes),
    r2_key: keyOf(file),
    content_type: file.mimeType,
    bytes: file.bytes.length,
    copied_at: copiedAt,
  };
}

/** A folder answering only for `folderId`, so a sync of any other folder finds nothing. */
function fakeFolder(files: FolderFile[], folderId = FOLDER) {
  const downloads: string[] = [];
  const drive: SyncDeps["drive"] = {
    async listFolder(id) {
      const entries = files.map(({ bytes: _bytes, ...entry }) => entry);
      return (id === folderId ? entries : []) as unknown as DriveFile[];
    },
    async download(fileId) {
      downloads.push(fileId);
      const file = files.find(({ id }) => id === fileId);
      if (file === undefined) throw new Error(`the fake Drive has no file ${fileId}`);
      return file.bytes.slice().buffer;
    },
  };
  return { drive, downloads };
}

function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const media = {
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { key, size: bytes.length };
    },
    async put(key: string, value: BodyInit) {
      puts.push(key);
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, bytes);
      return { key, size: bytes.length };
    },
  } as unknown as SyncDeps["media"];
  return { media, objects, puts };
}

type Bucket = ReturnType<typeof fakeBucket>;
type Folder = ReturnType<typeof fakeFolder>;

type RunOptions = { folderId?: string; now?: number; maxPerRun?: number; maxBytes?: number };

async function run(db: D1Database, bucket: Bucket, folder: Folder, options: RunOptions = {}): Promise<SyncResult> {
  const { syncPhotos } = await photos();
  const { folderId = FOLDER, now = NOW, maxBytes = MAX_BYTES } = options;
  const deps: SyncDeps = { db, media: bucket.media, drive: folder.drive, folderId, now, maxBytes };
  return syncPhotos(options.maxPerRun === undefined ? deps : { ...deps, maxPerRun: options.maxPerRun });
}

const sorted = (list: string[]): string[] => [...list].sort();

const namesOf = (files: FolderFile[]): string[] => sorted(files.map(({ name }) => name));

async function publish(db: D1Database, models: PhotoModel[]): Promise<void> {
  await replaceCatalog(db, photoCatalog(models), { now: NOW, source: "sheet" });
}

/** Every row of `photos` by name. */
async function photoRows(db: D1Database): Promise<Record<string, SqlRow>> {
  const { results } = await db.prepare("SELECT * FROM photos").all<SqlRow>();
  return Object.fromEntries(results.map((row) => [row.name, row]));
}

const expectedRows = (files: FolderFile[], copiedAt: number): Record<string, SqlRow> =>
  Object.fromEntries(files.map((file) => [file.name, rowOf(file, copiedAt)]));

function assertStored(bucket: Bucket, files: FolderFile[], label: string): void {
  assert.deepEqual(sorted([...bucket.objects.keys()]), sorted([...new Set(files.map(keyOf))]), label);
  for (const file of files) {
    assert.deepEqual(bucket.objects.get(keyOf(file)), file.bytes, `${label}: the bytes of ${file.name}`);
  }
}

function assertReported(result: SyncResult, names: string[], label: string): void {
  assert.deepEqual(sorted(result.errors.map(({ name }) => name)), sorted(names), label);
  for (const { name, message } of result.errors) {
    assert.ok(typeof message === "string" && message.trim() !== "", `${label}: ${name} has no message`);
  }
}

test("referenced photos are copied to R2 under their md5", async () => {
  const front = photoFile("front.jpg", "image/jpeg", 1);
  const side = photoFile("vespa's side.png", "image/png", 2);
  const rear = photoFile("沖縄 リア.webp", "image/webp", 3);
  const unnamedType = photoFile("IMG_0042", "image/png", 4);
  const onInactive = photoFile("inactive.jpg", "image/jpeg", 5);
  const shared = photoFile("shared.webp", "image/webp", 6);
  const unused = photoFile("unused.png", "image/png", 7);
  const doc: FolderFile = {
    id: "doc-1",
    name: "price notes",
    mimeType: "application/vnd.google-apps.document",
    bytes: new Uint8Array(0),
  };

  type Case = {
    label: string;
    models: PhotoModel[];
    folder: FolderFile[];
    copied: FolderFile[];
    folderId: string;
    now: number;
  };
  const cases: Case[] = [
    {
      label: "one photo",
      models: [{ id: "cub", photos: ["front.jpg"] }],
      folder: [front],
      copied: [front],
      folderId: FOLDER,
      now: NOW,
    },
    {
      label: "every type, a name shared by two models, and files no active model names",
      models: [
        { id: "vespa", photos: ["front.jpg", "vespa's side.png"] },
        { id: "cub", photos: ["沖縄 リア.webp", "front.jpg", "IMG_0042"] },
        { id: "retired", active: false, photos: ["inactive.jpg"] },
      ],
      folder: [unused, front, onInactive, side, doc, rear, unnamedType],
      copied: [front, side, rear, unnamedType],
      folderId: "another-folder-id",
      now: NOW + 12_345,
    },
    {
      label: "a name on an active and an inactive model",
      models: [
        { id: "gone", active: false, photos: ["shared.webp"] },
        { id: "here", photos: ["shared.webp"] },
      ],
      folder: [shared, unused],
      copied: [shared],
      folderId: FOLDER,
      now: NOW + 1,
    },
    {
      label: "no photos named",
      models: [{ id: "bare", photos: [] }],
      folder: [front, side],
      copied: [],
      folderId: FOLDER,
      now: NOW + 2,
    },
  ];

  const { db, dispose } = await createTestDb();
  try {
    for (const { label, models, folder: files, copied, folderId, now } of cases) {
      await db.prepare("DELETE FROM photos").run();
      await publish(db, models);
      const bucket = fakeBucket();
      const folder = fakeFolder(files, folderId);

      const result = await run(db, bucket, folder, { folderId, now });

      assert.deepEqual(sorted(result.copied), namesOf(copied), label);
      assert.deepEqual(result.skipped, [], label);
      assert.deepEqual(result.errors, [], label);
      assert.equal(result.remaining, 0, label);
      assertStored(bucket, copied, label);
      assert.deepEqual(await photoRows(db), expectedRows(copied, now), label);
      assert.deepEqual(sorted(folder.downloads), sorted(copied.map(({ id }) => id)), label);
    }
  } finally {
    await dispose();
  }
});

test("unchanged photos are skipped and changed ones recopied", async () => {
  const kept = photoFile("kept.jpg", "image/jpeg", 10);
  const original = photoFile("changing.png", "image/png", 11, 64);
  const reuploaded = photoFile("reuploaded.webp", "image/webp", 12);
  const all = [kept, original, reuploaded];
  const models = [{ id: "vespa", photos: all.map(({ name }) => name) }];

  // A new revision keeps its Drive id, and a file deleted and uploaded again gets a new one.
  const changes: [string, FolderFile][] = [
    ["a larger file", photoFile(original.name, original.mimeType, 13, 90, original.id)],
    ["a file of the same size", photoFile(original.name, original.mimeType, 14, 64, original.id)],
    ["a new Drive file", photoFile(original.name, original.mimeType, 15, 70, "drive-replacement")],
  ];

  const { db, dispose } = await createTestDb();
  try {
    await publish(db, models);
    for (const [label, changed] of changes) {
      await db.prepare("DELETE FROM photos").run();
      const bucket = fakeBucket();
      await run(db, bucket, fakeFolder(all), { now: NOW });
      assertStored(bucket, all, label);
      bucket.puts.length = 0;

      // Nothing changed, so nothing is fetched or written, and the rows still say when they were copied.
      const same = fakeFolder(all);
      const again = await run(db, bucket, same, { now: NOW + 1 });
      assert.deepEqual(again.copied, [], label);
      assert.deepEqual(sorted(again.skipped), namesOf(all), label);
      assert.deepEqual(again.errors, [], label);
      assert.equal(again.remaining, 0, label);
      assert.deepEqual(same.downloads, [], label);
      assert.deepEqual(bucket.puts, [], label);
      assert.deepEqual(await photoRows(db), expectedRows(all, NOW), label);

      // The same bytes under a new Drive id are the same photo. Only the changed name is fetched.
      const newer = fakeFolder([kept, changed, { ...reuploaded, id: "drive-reuploaded-again" }]);
      const later = await run(db, bucket, newer, { now: NOW + 2 });
      assert.deepEqual(later.copied, [changed.name], label);
      assert.deepEqual(sorted(later.skipped), sorted([kept.name, reuploaded.name]), label);
      assert.deepEqual(later.errors, [], label);
      assert.equal(later.remaining, 0, label);
      assert.deepEqual(newer.downloads, [changed.id], label);
      assert.deepEqual(bucket.puts, [keyOf(changed)], label);
      assert.notEqual(keyOf(changed), keyOf(original), label);
      assert.deepEqual(bucket.objects.get(keyOf(changed)), changed.bytes, label);

      const rows = await photoRows(db);
      assert.deepEqual(rows[changed.name], rowOf(changed, NOW + 2), label);
      assert.deepEqual(rows[kept.name], rowOf(kept, NOW), label);
      assert.equal(rows[reuploaded.name].r2_key, keyOf(reuploaded), label);
      assert.equal(rows[reuploaded.name].copied_at, NOW, label);

      // Staff go back to the first version: its object is still there, and the row has to follow it.
      const back = await run(db, bucket, fakeFolder(all), { now: NOW + 3 });
      assert.deepEqual(back.errors, [], label);
      assert.equal(back.remaining, 0, label);
      const reverted = (await photoRows(db))[original.name];
      assert.equal(reverted.md5, md5Hex(original.bytes), label);
      assert.equal(reverted.r2_key, keyOf(original), label);
      assert.deepEqual(bucket.objects.get(keyOf(original)), original.bytes, label);
    }
  } finally {
    await dispose();
  }
});

test("copies per call are capped and remaining is reported", async () => {
  const files = (count: number): FolderFile[] =>
    Array.from({ length: count }, (_, i) => photoFile(`photo-${i}.jpg`, "image/jpeg", 100 + i));
  const modelsFor = (list: FolderFile[]) => [{ id: "fleet", photos: list.map(({ name }) => name) }];

  const { db, dispose } = await createTestDb();
  try {
    // Call after call finishes the folder, each one copying a full batch of what is left and never a file twice.
    const seven = files(7);
    await publish(db, modelsFor(seven));
    for (const maxPerRun of [1, 2, 3, 7, 10]) {
      const label = `maxPerRun ${maxPerRun}`;
      await db.prepare("DELETE FROM photos").run();
      const bucket = fakeBucket();
      const done = new Set<string>();
      let call = 0;
      while (done.size < seven.length) {
        call += 1;
        assert.ok(call <= seven.length, `${label}: no end after ${call} calls`);
        const folder = fakeFolder(seven);
        const puts = bucket.puts.length;

        const result = await run(db, bucket, folder, { maxPerRun, now: NOW + call });

        const expected = Math.min(maxPerRun, seven.length - done.size);
        assert.equal(result.copied.length, expected, `${label}, call ${call}`);
        assert.deepEqual(sorted(result.skipped), sorted([...done]), `${label}, call ${call}`);
        for (const name of result.copied) {
          assert.equal(done.has(name), false, `${label}: ${name} was copied twice`);
          done.add(name);
        }
        assert.equal(result.remaining, seven.length - done.size, `${label}, call ${call}`);
        assert.equal(folder.downloads.length, expected, `${label}, call ${call}: downloads`);
        assert.equal(bucket.puts.length - puts, expected, `${label}, call ${call}: puts`);
      }
      assert.deepEqual(sorted([...done]), namesOf(seven), label);
      assertStored(bucket, seven, label);

      const finished = await run(db, bucket, fakeFolder(seven), { maxPerRun, now: NOW + 100 });
      assert.deepEqual(finished.copied, [], label);
      assert.equal(finished.remaining, 0, label);
    }

    // The default is 15, on either side of that number.
    const defaults: [number, number][] = [
      [14, 0],
      [15, 0],
      [16, 1],
      [31, 16],
    ];
    for (const [count, remaining] of defaults) {
      const label = `${count} files with the default cap`;
      const list = files(count);
      await publish(db, modelsFor(list));
      await db.prepare("DELETE FROM photos").run();
      const bucket = fakeBucket();
      const folder = fakeFolder(list);
      const result = await run(db, bucket, folder);
      assert.equal(result.copied.length, count - remaining, label);
      assert.equal(result.remaining, remaining, label);
      assert.equal(folder.downloads.length, count - remaining, label);
    }

    // Only copies use up the cap: skipping a file costs neither a Drive GET nor an R2 put.
    const eight = files(8);
    const first = eight.slice(0, 3);
    await publish(db, modelsFor(first));
    await db.prepare("DELETE FROM photos").run();
    const bucket = fakeBucket();
    await run(db, bucket, fakeFolder(first));
    await publish(db, modelsFor(eight));
    const mixed = await run(db, bucket, fakeFolder(eight), { maxPerRun: 2, now: NOW + 1 });
    assert.equal(mixed.copied.length, 2);
    assert.deepEqual(sorted(mixed.skipped), namesOf(first));
    assert.equal(mixed.remaining, 3);
  } finally {
    await dispose();
  }
});

test("missing, oversized and wrong-type files are reported", async () => {
  const { db, dispose } = await createTestDb();
  try {
    for (const maxBytes of [64, 1000]) {
      const label = `limit of ${maxBytes} bytes`;
      const good = [
        photoFile("at-the-limit.jpg", "image/jpeg", 50, maxBytes),
        photoFile("under-the-limit.png", "image/png", 51, maxBytes - 1),
        photoFile("small.webp", "image/webp", 52, 8),
      ];
      const oversized = [
        photoFile("one-byte-over.jpg", "image/jpeg", 53, maxBytes + 1),
        photoFile("far-over.webp", "image/webp", 54, maxBytes * 3),
      ];
      const wrongType = [
        photoFile("animated.gif", "image/gif", 55),
        photoFile("logo.svg", "image/svg+xml", 56),
        photoFile("iphone.heic", "image/heic", 57),
        photoFile("brochure.pdf", "application/pdf", 58),
        photoFile("notes.txt", "text/plain", 59),
        // Over the limit and of the wrong type, and still one report for the one name.
        photoFile("large.gif", "image/gif", 60, maxBytes + 1),
        { id: "doc-2", name: "a google doc", mimeType: "application/vnd.google-apps.document", bytes: new Uint8Array(0) },
      ];
      const missing = ["not-in-the-folder.jpg", "also-gone.png"];
      const bad = [...namesOf([...oversized, ...wrongType]), ...missing];
      const listed = [...oversized, ...wrongType, ...good];

      // The bad names come first, so a file that used up the cap would leave a good one behind.
      await publish(db, [
        { id: "first", photos: [...bad.slice(0, 5), good[0].name] },
        { id: "second", photos: [...bad.slice(5), good[1].name, good[2].name] },
      ]);
      await db.prepare("DELETE FROM photos").run();
      const bucket = fakeBucket();
      const folder = fakeFolder(listed);

      const result = await run(db, bucket, folder, { maxBytes, maxPerRun: 15 });

      assert.deepEqual(sorted(result.copied), namesOf(good), label);
      assert.deepEqual(result.skipped, [], label);
      assertReported(result, bad, label);
      assert.equal(result.remaining, 0, `${label}: a file that can never be copied does not remain`);
      assertStored(bucket, good, label);
      assert.deepEqual(await photoRows(db), expectedRows(good, NOW), label);
      assert.deepEqual(sorted(folder.downloads), sorted(good.map(({ id }) => id)), `${label}: downloads`);

      // Every call reports every bad name, and `remaining` counts down to 0 past them, or a caller would never stop.
      await db.prepare("DELETE FROM photos").run();
      const capped = fakeBucket();
      for (const [call, remaining] of [2, 1, 0].entries()) {
        const step = await run(db, capped, fakeFolder(listed), { maxBytes, maxPerRun: 1, now: NOW + call });
        assert.equal(step.copied.length, 1, `${label}, call ${call}`);
        assert.equal(step.remaining, remaining, `${label}, call ${call}`);
        assertReported(step, bad, `${label}, call ${call}`);
      }

      // A file that leaves the folder after its copy is reported, not skipped.
      const [gone, ...stayed] = good;
      const after = await run(db, capped, fakeFolder(listed.filter((file) => file !== gone)), { maxBytes, now: NOW + 10 });
      assert.deepEqual(after.copied, [], label);
      assert.deepEqual(sorted(after.skipped), namesOf(stayed), label);
      assertReported(after, [...bad, gone.name], label);
      assert.equal(after.remaining, 0, label);
    }
  } finally {
    await dispose();
  }
});

test("a photo whose object is already in R2 still gets its row", async () => {
  const file = photoFile("front.jpg", "image/jpeg", 70);
  const twin: FolderFile = { ...file, id: "drive-twin", name: "front copy.jpg" };
  const other = photoFile("side.png", "image/png", 71);

  const { db, dispose } = await createTestDb();
  try {
    // A call that stopped between the put and the row leaves the object behind.
    await publish(db, [{ id: "crashed", photos: [file.name] }]);
    const left = fakeBucket();
    left.objects.set(keyOf(file), file.bytes);
    const resumed = await run(db, left, fakeFolder([file]));
    assert.deepEqual(resumed.errors, []);
    assert.equal(resumed.remaining, 0);
    assert.deepEqual(sorted([...resumed.copied, ...resumed.skipped]), [file.name]);
    assert.deepEqual(await photoRows(db), expectedRows([file], NOW));
    assertStored(left, [file], "after the resumed call");

    // Two names with the same bytes share one object, and each name has its own row.
    await db.prepare("DELETE FROM photos").run();
    await publish(db, [{ id: "twins", photos: [file.name, twin.name, other.name] }]);
    const bucket = fakeBucket();
    const shared = await run(db, bucket, fakeFolder([file, twin, other]));
    assert.deepEqual(shared.errors, []);
    assert.equal(shared.remaining, 0);
    assert.deepEqual(sorted([...shared.copied, ...shared.skipped]), namesOf([file, twin, other]));
    assert.deepEqual(await photoRows(db), expectedRows([file, twin, other], NOW));
    assertStored(bucket, [file, twin, other], "twins");
  } finally {
    await dispose();
  }
});

// The Drive client.

const API = "https://www.googleapis.com/drive/v3/files";
const TOKEN = "ya29.test-drive-token";

type SentRequest = { url: URL; method: string; authorization: string | null };

function fakeFetch(reply: (request: Request) => Response) {
  const requests: SentRequest[] = [];
  // A function and not an arrow, so that it can see `this`. The real fetch throws "Illegal invocation" in workerd when it
  // is called as a method, like `opts.fetch(...)`.
  const fetchFake: typeof fetch = async function (this: unknown, input, init) {
    assert.ok(this === undefined || this === globalThis, "the injected fetch must be called unbound");
    const request = new Request(input, init);
    requests.push({ url: new URL(request.url), method: request.method, authorization: request.headers.get("authorization") });
    return reply(request);
  };
  return { fetch: fetchFake, requests };
}

test("listFolder asks Drive for the folder and returns its files", async () => {
  const { createDriveClient } = await driveModule();
  const jpeg = { id: "file-1", name: "front.jpg", mimeType: "image/jpeg", md5Checksum: "0".repeat(32) };
  const png = { id: "file-2", name: "沖縄 side.png", mimeType: "image/png", md5Checksum: "a".repeat(32) };
  const doc = { id: "file-3", name: "notes", mimeType: "application/vnd.google-apps.document" };

  // Drive sends int64 values as JSON strings, and has no checksum or size for a Google Doc.
  type Sent = { id: string; name: string; mimeType: string; md5Checksum?: string; size?: string };
  const cases: [string, Sent[]][] = [
    ["1photoFolderAbC-dEf_0123456789", [{ ...jpeg, size: "1234" }]],
    ["another-folder", [{ ...png, size: "5000000" }, { ...jpeg, size: "1" }, doc]],
    ["empty-folder", []],
  ];
  for (const [folderId, files] of cases) {
    const { fetch: fetchFake, requests } = fakeFetch(() => Response.json({ kind: "drive#fileList", files }));
    const client = createDriveClient({ getToken: async () => TOKEN, fetch: fetchFake });

    const listed = await client.listFolder(folderId);

    assert.equal(requests.length, 1, folderId);
    const [{ url, method, authorization }] = requests;
    assert.equal(method, "GET", folderId);
    assert.equal(authorization, `Bearer ${TOKEN}`, folderId);
    assert.equal(`${url.origin}${url.pathname}`, API, folderId);
    assert.equal(url.searchParams.get("q"), `'${folderId}' in parents and trashed = false`, folderId);
    assert.equal(url.searchParams.get("fields"), "files(id,name,mimeType,md5Checksum,size)", folderId);
    assert.equal(url.searchParams.get("pageSize"), "1000", folderId);

    assert.equal(listed.length, files.length, folderId);
    for (const [i, sent] of files.entries()) {
      const { id, name, mimeType, md5Checksum, size } = listed[i];
      assert.deepEqual({ id, name, mimeType }, { id: sent.id, name: sent.name, mimeType: sent.mimeType }, sent.name);
      if (sent.size !== undefined) {
        assert.equal(md5Checksum, sent.md5Checksum, sent.name);
        assert.strictEqual(size, Number(sent.size), `${sent.name}: size is a number`);
      }
    }
  }
});

test("download returns the file's bytes", async () => {
  const { createDriveClient } = await driveModule();
  // Every byte value, so a trip through text shows.
  const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);
  const cases: [string, Uint8Array<ArrayBuffer>][] = [
    ["1AbC-dEf_ghI", everyByte],
    ["another-file", photoBytes(80)],
    ["empty-file", new Uint8Array(0)],
  ];
  for (const [fileId, bytes] of cases) {
    const { fetch: fetchFake, requests } = fakeFetch(() => new Response(bytes));
    const client = createDriveClient({ getToken: async () => TOKEN, fetch: fetchFake });

    const body = await client.download(fileId);

    assert.ok(body instanceof ArrayBuffer, fileId);
    assert.deepEqual(new Uint8Array(body), bytes, fileId);
    assert.equal(requests.length, 1, fileId);
    const [{ url, method, authorization }] = requests;
    assert.equal(method, "GET", fileId);
    assert.equal(authorization, `Bearer ${TOKEN}`, fileId);
    assert.equal(`${url.origin}${url.pathname}`, `${API}/${fileId}`, fileId);
    assert.equal(url.searchParams.get("alt"), "media", fileId);
  }
});

test("each Drive call sends the current bearer token", async () => {
  const { createDriveClient } = await driveModule();
  let issued = 0;
  const { fetch: fetchFake, requests } = fakeFetch((request) =>
    new URL(request.url).searchParams.get("alt") === "media" ? new Response(photoBytes(81)) : Response.json({ files: [] }),
  );
  const client = createDriveClient({
    getToken: async () => {
      issued += 1;
      return `token-${issued}`;
    },
    fetch: fetchFake,
  });

  await client.listFolder("folder");
  await client.download("file");
  await client.listFolder("folder");
  assert.deepEqual(
    requests.map(({ authorization }) => authorization),
    ["Bearer token-1", "Bearer token-2", "Bearer token-3"],
  );
});

test("a Drive failure rejects and does not carry the bearer token", async () => {
  const { createDriveClient } = await driveModule();
  const operations: [string, (client: ReturnType<typeof createDriveClient>) => Promise<unknown>][] = [
    ["listFolder", (client) => client.listFolder("folder")],
    ["download", (client) => client.download("file")],
  ];
  // An error page saved as a photo is what this guards against, so a download has to reject too. Google's message can
  // quote what it was sent.
  for (const [name, call] of operations) {
    for (const status of [400, 401, 403, 404]) {
      const label = `${name}, ${status}`;
      const body = JSON.stringify({ error: { code: status, message: `Refused Authorization: Bearer ${TOKEN}` } });
      const { fetch: fetchFake } = fakeFetch(() => new Response(body, { status }));
      const client = createDriveClient({ getToken: async () => TOKEN, fetch: fetchFake });

      await assert.rejects(call(client), (error: Error) => {
        const views = [error.message, String(error), error.stack ?? "", inspect(error, { depth: null, showHidden: true })];
        for (const view of views) assert.equal(view.includes(TOKEN), false, `${label}: the error carries the token`);
        return true;
      }, label);
    }
  }
});

// The helpers for pages.

test("photoUrl maps a photo name to its media path", async () => {
  const { photoUrl, readPhotoIndex } = await photos();
  const stored = [
    photoFile("front.jpg", "image/jpeg", 90),
    photoFile("vespa's side.png", "image/png", 91),
    photoFile("沖縄 リア.webp", "image/webp", 92),
  ];
  const { db, dispose } = await createTestDb();
  try {
    assert.ok(!photoUrl("front.jpg", await readPhotoIndex(db)), "nothing is copied yet");

    for (const file of stored) await insertRow(db, "photos", rowOf(file, NOW));
    const index = await readPhotoIndex(db);
    for (const file of stored) {
      assert.equal(photoUrl(file.name, index), `/media/${keyOf(file)}`, file.name);
    }
    assert.ok(!photoUrl("never-copied.jpg", index), "a name with no row has no URL");

    // A changed file gets a new key, and the next index says so.
    const changed = photoFile("front.jpg", "image/jpeg", 93);
    await insertRow(db, "photos", rowOf(changed, NOW + 1), "name");
    assert.equal(photoUrl("front.jpg", await readPhotoIndex(db)), `/media/${keyOf(changed)}`);
  } finally {
    await dispose();
  }
});
