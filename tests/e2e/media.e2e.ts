// The photo routes, through the built Worker: /media over the real (Miniflare) R2 bucket, and the signed sync with Google
// faked in `outbound`. Bodies are signed here with node:crypto, the way the Apps Script side signs them. The fake Drive
// sends sizes as JSON strings, as the real one does.
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { after, before, test } from "node:test";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { md5Hex, photoBytes, photoCatalog, type PhotoModel } from "../helpers/photos.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

/** Loaded where it is needed, so each test reports its own failure until the module exists. */
const photos = () => import("../../src/lib/catalog/photos.ts");

const SYNC_PATH = "/api/publish/photos";
const IMMUTABLE = "public, max-age=31536000, immutable";
const FOLDER = "e2e-photo-folder";
const TOKEN = "e2e-drive-token";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_ORIGIN = "https://www.googleapis.com";
const TEN_MINUTES_MS = 600_000;

// The service account signs for real inside the Worker, so the placeholder key in testVars will not do.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

type DriveEntry = { id: string; name: string; mimeType: string; bytes: Uint8Array<ArrayBuffer>; size: string };

/** What the fake Drive folder holds. Each test sets it. */
let folder: DriveEntry[] = [];
const outboundRequests: string[] = [];

function driveFile(name: string, mimeType: string, seed: number, claimedSize?: number): DriveEntry {
  const bytes = photoBytes(seed);
  return { id: `drive-${seed}`, name, mimeType, bytes, size: String(claimedSize ?? bytes.length) };
}

function fakeGoogle(request: Request): Response {
  outboundRequests.push(`${request.method} ${request.url}`);
  if (request.url === TOKEN_URL) return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });

  const url = new URL(request.url);
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no bearer token", { status: 401 });
  if (url.origin === DRIVE_ORIGIN && url.pathname === "/drive/v3/files") {
    const inFolder = url.searchParams.get("q") === `'${FOLDER}' in parents and trashed = false`;
    const files = folder.map(({ id, name, mimeType, bytes, size }) => ({ id, name, mimeType, md5Checksum: md5Hex(bytes), size }));
    return Response.json({ files: inFolder ? files : [] });
  }
  const file = folder.find(({ id }) => url.pathname === `/drive/v3/files/${id}`);
  if (url.origin === DRIVE_ORIGIN && file !== undefined && url.searchParams.get("alt") === "media") {
    return new Response(file.bytes);
  }
  return new Response(`no fake for ${request.url}`, { status: 502 });
}

const downloads = (): number => outboundRequests.filter((line) => line.includes("alt=media")).length;

let worker: TestWorker;

before(async () => {
  worker = await startWorker({
    vars: { GOOGLE_SA_PRIVATE_KEY: privateKey, GOOGLE_DRIVE_FOLDER_ID: FOLDER },
    outbound: fakeGoogle,
  });
});

after(async () => {
  await worker?.stop();
});

async function publish(models: PhotoModel[], photoMaxMb = 5): Promise<void> {
  await replaceCatalog(worker.db, photoCatalog(models, photoMaxMb), { now: Date.now(), source: "sheet" });
}

function signature(secret: string, ts: number, payload: string): string {
  return createHmac("sha256", secret).update(`${ts}.${payload}`, "utf8").digest("hex");
}

function signedBody(secret = testVars.PUBLISH_SECRET, ts = Date.now(), payload = "{}"): string {
  return JSON.stringify({ ts, payload, sig: signature(secret, ts, payload) });
}

function postSync(body?: string): Promise<Response> {
  return worker.fetch(SYNC_PATH, { method: "POST", headers: { "content-type": "application/json" }, body });
}

type SyncResponse = {
  copied: string[];
  skipped: string[];
  errors: { name: string; message: string }[];
  remaining: number;
};

async function signedSync(): Promise<SyncResponse> {
  const res = await postSync(signedBody());
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as SyncResponse;
}

const sorted = (list: string[]): string[] => [...list].sort();

async function storedBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

async function photoRow(name: string) {
  return worker.db.prepare("SELECT r2_key FROM photos WHERE name = ?1").bind(name).first<{ r2_key: string }>();
}

test("media serves stored photos with immutable caching", async () => {
  const stored: [string, string, Uint8Array<ArrayBuffer>][] = [
    ["jpg", "image/jpeg", photoBytes(1)],
    ["png", "image/png", photoBytes(2)],
    ["webp", "image/webp", Uint8Array.from({ length: 256 }, (_, i) => i)],
  ];
  const etags = new Set<string>();
  for (const [extension, contentType, bytes] of stored) {
    const key = `photos/${md5Hex(bytes)}.${extension}`;
    await worker.media.put(key, bytes, { httpMetadata: { contentType } });
    const object = await worker.media.head(key);
    assert.ok(object, key);

    const res = await worker.fetch(`/media/${key}`);

    assert.equal(res.status, 200, key);
    assert.deepEqual(await storedBytes(res), bytes, key);
    assert.equal(res.headers.get("content-type"), contentType, key);
    assert.equal(res.headers.get("cache-control"), IMMUTABLE, key);
    // An ETag header is a quoted string, which the object's bare etag is not.
    assert.equal(res.headers.get("etag"), `"${object.etag}"`, key);
    etags.add(res.headers.get("etag") ?? "");
  }
  assert.equal(etags.size, stored.length);
});

test("unknown and out-of-prefix keys return 404", async () => {
  const served = photoBytes(3);
  const servedKey = `photos/${md5Hex(served)}.jpg`;
  const unknownKey = `photos/${md5Hex(photoBytes(4))}.jpg`;
  const secretText = "secret-object-outside-the-photos-prefix";
  const secret = new TextEncoder().encode(secretText);
  const md5 = md5Hex(secret);

  await worker.media.put(servedKey, served, { httpMetadata: { contentType: "image/jpeg" } });
  // Each of these exists in the bucket, so only the route can keep it from being served.
  const outside = [
    "secret.txt",
    `private/${md5}.jpg`,
    `photos-private/${md5}.jpg`,
    `photosecret-${md5}.jpg`,
    `PHOTOS/${md5}.jpg`,
    "photos/../secret.txt",
  ];
  for (const key of outside) await worker.media.put(key, secret, { httpMetadata: { contentType: "image/jpeg" } });

  // The route is there: a 404 below is the route saying no, not the site having no such page.
  const control = await worker.fetch(`/media/${servedKey}`);
  assert.equal(control.status, 200);
  assert.deepEqual(await storedBytes(control), served);

  const paths = [
    `/media/${unknownKey}`,
    "/media/secret.txt",
    `/media/private/${md5}.jpg`,
    `/media/photos-private/${md5}.jpg`,
    `/media/photosecret-${md5}.jpg`,
    `/media/PHOTOS/${md5}.jpg`,
    "/media/photos",
    "/media/photos/",
    "/media/",
    "/media",
    // Tampered paths. The URL parser folds the first two, and the rest reach the route with the dots still in them.
    "/media/photos/../secret.txt",
    "/media/photos/%2e%2e/secret.txt",
    "/media/photos/..%2fsecret.txt",
    "/media/photos/..%2Fsecret.txt",
    "/media/photos/%2e%2e%2fsecret.txt",
    "/media/photos/..%5csecret.txt",
    `/media/photos/..%2fprivate/${md5}.jpg`,
  ];
  for (const path of paths) {
    const res = await worker.fetch(path);
    const body = await res.text();
    assert.equal(res.status, 404, path);
    assert.equal(body.includes(secretText), false, `${path} served the object`);
  }
});

test("unsigned photo sync gets 401", async () => {
  const file = driveFile("unsigned.jpg", "image/jpeg", 10);
  folder = [file];
  await publish([{ id: "unsigned-model", photos: [file.name] }]);
  const calls = outboundRequests.length;

  const bodies: [string, string | undefined][] = [
    ["no body", undefined],
    ["an empty body", ""],
    ["not JSON", "sync please"],
    ["an empty object", "{}"],
    ["a payload with no signature", JSON.stringify({ ts: Date.now(), payload: "{}" })],
  ];
  for (const [label, body] of bodies) {
    const res = await postSync(body);
    await res.text();
    assert.equal(res.status, 401, label);
  }

  assert.equal(outboundRequests.length, calls, "an unsigned request reached Google");
  assert.equal(await photoRow(file.name), null);
  assert.equal(await worker.media.head(`photos/${md5Hex(file.bytes)}.jpg`), null);
});

test("a tampered or stale signature on photo sync gets 401", async () => {
  const file = driveFile("tampered.png", "image/png", 11);
  folder = [file];
  await publish([{ id: "tampered-model", photos: [file.name] }]);
  const calls = outboundRequests.length;

  const now = Date.now();
  const good = JSON.parse(signedBody(testVars.PUBLISH_SECRET, now)) as { ts: number; payload: string; sig: string };
  const bodies: [string, string][] = [
    ["signed with another secret", signedBody("not-the-publish-secret", now)],
    ["signed with the mail secret", signedBody(testVars.MAIL_SECRET, now)],
    ["a payload changed after signing", JSON.stringify({ ...good, payload: '{"maxPerRun":1000}' })],
    ["a timestamp changed after signing", JSON.stringify({ ...good, ts: now + 1 })],
    ["a signature cut short", JSON.stringify({ ...good, sig: good.sig.slice(0, 32) })],
    ["an empty signature", JSON.stringify({ ...good, sig: "" })],
    ["signed too long ago", signedBody(testVars.PUBLISH_SECRET, now - TEN_MINUTES_MS)],
    ["signed in the future", signedBody(testVars.PUBLISH_SECRET, now + TEN_MINUTES_MS)],
  ];
  for (const [label, body] of bodies) {
    const res = await postSync(body);
    await res.text();
    assert.equal(res.status, 401, label);
  }
  assert.equal(outboundRequests.length, calls, "a badly signed request reached Google");
  assert.equal(await photoRow(file.name), null);

  // The same signing with the right secret gets through, so the refusals above were about the signature.
  const result = await signedSync();
  assert.deepEqual(result.copied, [file.name]);
});

test("a signed photo sync copies referenced photos for media to serve", async () => {
  const { photoUrl, readPhotoIndex } = await photos();
  const files = [
    driveFile("sync-front.jpg", "image/jpeg", 20),
    driveFile("sync-side.png", "image/png", 21),
    driveFile("sync-rear.webp", "image/webp", 22),
  ];
  const onInactive = driveFile("sync-inactive.jpg", "image/jpeg", 23);
  folder = [...files, onInactive];
  await publish([
    { id: "sync-a", photos: ["sync-front.jpg", "sync-side.png", "sync-missing.jpg"] },
    { id: "sync-b", photos: ["sync-rear.webp"] },
    { id: "sync-old", active: false, photos: [onInactive.name] },
  ]);

  const result = await signedSync();

  assert.deepEqual(sorted(result.copied), sorted(files.map(({ name }) => name)));
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(
    result.errors.map(({ name }) => name),
    ["sync-missing.jpg"],
  );
  assert.equal(result.remaining, 0);
  assert.equal(await photoRow(onInactive.name), null);

  // What the sync stored is what a page's URL serves, with the type Drive reported.
  const index = await readPhotoIndex(worker.db);
  for (const { name, mimeType, bytes } of files) {
    const url = photoUrl(name, index);
    assert.ok(url, name);
    assert.ok(url.startsWith("/media/photos/"), url);
    const res = await worker.fetch(url);
    assert.equal(res.status, 200, name);
    assert.deepEqual(await storedBytes(res), bytes, name);
    assert.equal(res.headers.get("content-type"), mimeType, name);
    assert.equal(res.headers.get("cache-control"), IMMUTABLE, name);
    assert.ok(res.headers.get("etag"), name);
  }

  // A second publish of the same folder fetches nothing.
  const fetched = downloads();
  const again = await signedSync();
  assert.deepEqual(again.copied, []);
  assert.deepEqual(sorted(again.skipped), sorted(files.map(({ name }) => name)));
  assert.equal(downloads(), fetched);
});

test("photo sync takes its size limit from photo_max_mb", async () => {
  // 3 MB by either meaning of the word, reported by Drive as a string. The limits sit well to each side of it.
  const file = driveFile("sync-large.jpg", "image/jpeg", 30, 3_000_000);
  folder = [file];
  const models = [{ id: "sync-large", photos: [file.name] }];

  await publish(models, 2.5);
  const refused = await signedSync();
  assert.deepEqual(refused.copied, []);
  assert.deepEqual(
    refused.errors.map(({ name }) => name),
    [file.name],
  );
  assert.equal(await photoRow(file.name), null);

  await publish(models, 3.5);
  const allowed = await signedSync();
  assert.deepEqual(allowed.copied, [file.name]);
  assert.deepEqual(allowed.errors, []);
});
