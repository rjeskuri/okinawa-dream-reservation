// What POST /api/publish/photos refuses, through the built Worker in Miniflare with a fake Drive behind `outbound`. Each
// test gets its own Worker, with a catalog that names a photo the folder holds: syncPhotos returns before its first
// Google call when no catalog is published, so without one "no Google calls" would hold whatever the route did. Each test
// also ends with a request the route accepts, which copies that photo, so the refusals before it were the route's.
//
// Envelopes are signed here with node:crypto, as in publish.e2e.ts, and every POST says Content-Type: application/json,
// because Astro's origin check answers 403 to anything else before the route runs.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { GOOGLE_PRIVATE_KEY, GOOGLE_TOKEN, type Fault } from "../helpers/fake-google.ts";
import { md5Hex, photoBytes, photoCatalog } from "../helpers/photos.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const PATH = "/api/publish/photos";
const CATALOG_PATH = "/api/publish";
const SECRET = "e2e-photos-secret";
const PAYLOAD = { requestedBy: "staff@example.com" };
const JSON_HEADERS = { "Content-Type": "application/json" };

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const FOLDER = "e2e-photo-folder";
const PHOTO = { id: "drive-file-1", name: "front.jpg", mimeType: "image/jpeg", bytes: photoBytes(1) };
const PHOTO_KEY = `photos/${md5Hex(PHOTO.bytes)}.jpg`;
const FIRST_COPY = { copied: [PHOTO.name], skipped: [], errors: [], remaining: 0 };

/** 64 * 1024, the limit of both publish routes. A body of this many bytes is allowed and one more is not. */
const LIMIT_BYTES = 65_536;

/**
 * Both routes' answer past the limit, as /api/publish gave it before the reader moved. The Apps Script prints an answer
 * as it stands, after "the Worker answered 413: ", so it is these words and no document.
 */
const TOO_LARGE = "The request is too large.";

/** This route's one answer to a request the signature check turns down, which the Apps Script reads already. */
const UNAUTHORIZED = JSON.stringify({ error: "unauthorized" });

/** In every faked failure, so that any of Google's body reaching the response shows. */
const UPSTREAM = "UPSTREAM-DETAIL-FOR-NOBODY";

/** A folder of one photo. A fault replaces the normal answer to that call. */
function fakeDrive() {
  const drive = {
    faults: {} as { token?: Fault; list?: Fault },
    /** Every outbound request, whatever it was for. */
    requests: [] as string[],
    outbound,
  };

  function list(url: URL): Response {
    if (drive.faults.list) return drive.faults.list();
    const { id, name, mimeType, bytes } = PHOTO;
    const file = { id, name, mimeType, md5Checksum: md5Hex(bytes), size: String(bytes.length) };
    const inFolder = url.searchParams.get("q") === `'${FOLDER}' in parents and trashed = false`;
    return Response.json({ files: inFolder ? [file] : [] });
  }

  function outbound(request: Request): Response {
    drive.requests.push(`${request.method} ${request.url}`);
    if (request.url === TOKEN_URL) {
      if (drive.faults.token) return drive.faults.token();
      return Response.json({ access_token: GOOGLE_TOKEN, expires_in: 3600, token_type: "Bearer" });
    }
    if (request.headers.get("authorization") !== `Bearer ${GOOGLE_TOKEN}`) {
      return new Response("no bearer token", { status: 401 });
    }
    const url = new URL(request.url);
    if (`${url.origin}${url.pathname}` === DRIVE_FILES) return list(url);
    if (`${url.origin}${url.pathname}` === `${DRIVE_FILES}/${PHOTO.id}`) return new Response(PHOTO.bytes);
    return new Response(`no fake for ${request.url}`, { status: 502 });
  }

  return drive;
}

type FakeDrive = ReturnType<typeof fakeDrive>;

async function withWorker(
  drive: FakeDrive,
  vars: Record<string, string | undefined>,
  run: (worker: TestWorker) => Promise<void>,
): Promise<void> {
  const worker = await startWorker({
    outbound: drive.outbound,
    vars: { GOOGLE_SA_PRIVATE_KEY: GOOGLE_PRIVATE_KEY, GOOGLE_DRIVE_FOLDER_ID: FOLDER, PUBLISH_SECRET: SECRET, ...vars },
  });
  try {
    const catalog = photoCatalog([{ id: "a-model", photos: [PHOTO.name] }]);
    await replaceCatalog(worker.db, catalog, { now: Date.now(), source: "sheet" });
    await run(worker);
  } finally {
    await worker.stop();
  }
}

/** The envelope the Apps Script sends: an HMAC-SHA256 in hex over `ts.payload`, with the payload as JSON text. */
function envelope(secret: string, payload: unknown, ts = Date.now()) {
  const text = JSON.stringify(payload);
  return { ts, payload: text, sig: createHmac("sha256", secret).update(`${ts}.${text}`).digest("hex") };
}

/** A good envelope of exactly `bytes`, padded with `filler`, and then with "x" where the filler no longer fits. */
function sized(bytes: number, filler: string): string {
  const ts = Date.now();
  const room = bytes - Buffer.byteLength(JSON.stringify(envelope(SECRET, { requestedBy: "" }, ts)));
  const count = Math.floor(room / Buffer.byteLength(filler));
  const padding = filler.repeat(count) + "x".repeat(room - count * Buffer.byteLength(filler));
  const body = JSON.stringify(envelope(SECRET, { requestedBy: padding }, ts));
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}

function flipped(sig: string): string {
  return `${sig[0] === "0" ? "1" : "0"}${sig.slice(1)}`;
}

/** `body` with its signature broken and its length kept. */
function tampered(body: string): string {
  const parsed = JSON.parse(body) as ReturnType<typeof envelope>;
  return JSON.stringify({ ...parsed, sig: flipped(parsed.sig) });
}

function post(worker: TestWorker, body?: string | Buffer<ArrayBuffer>, path = PATH): Promise<Response> {
  return worker.fetch(path, { method: "POST", headers: JSON_HEADERS, body });
}

function signedPost(worker: TestWorker): Promise<Response> {
  return post(worker, JSON.stringify(envelope(SECRET, PAYLOAD)));
}

// Miniflare's fetch sends every body as Transfer-Encoding: chunked unless the request names a Content-Length, which then
// arrives in place of it, so a test that cares which one the Worker sees uses one of these two.
function postWithLength(worker: TestWorker, body: string | Buffer<ArrayBuffer>, path = PATH): Promise<Response> {
  const headers = { ...JSON_HEADERS, "Content-Length": String(Buffer.byteLength(body)) };
  return worker.fetch(path, { method: "POST", headers, body });
}

function postStream(worker: TestWorker, body: ReadableStream<Uint8Array>, path = PATH): Promise<Response> {
  return worker.fetch(path, { method: "POST", headers: JSON_HEADERS, body, duplex: "half" } as RequestInit);
}

/** The bytes of `body` in chunks of `size`. */
function chunksOf(body: string | Buffer, size: number): ReadableStream<Uint8Array> {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(bytes.subarray(at, at + size));
      at += size;
      if (at >= bytes.length) controller.close();
    },
  });
}

// A stream has no Content-Length to go by, so its bytes have to be counted as they arrive. Each chunk is far below the
// limit, so the count has to run across them, and 1000 is no multiple of 3, so chunks end inside the multi-byte filler
// too, which has to survive that.
function streamed(worker: TestWorker, body: string, path = PATH): Promise<Response> {
  return postStream(worker, chunksOf(body, 1000), path);
}

const SENDS: [string, (worker: TestWorker, body: string, path?: string) => Promise<Response>][] = [
  ["as a string", post],
  ["with a Content-Length", postWithLength],
  ["as a stream with no Content-Length", streamed],
];

/**
 * 413 in TOO_LARGE's words, or null when the end of an upload the Worker stopped reading failed before the answer got
 * through.
 */
async function assertTooLarge(res: Response | null, label: string): Promise<void> {
  if (res === null) return;
  assert.equal(res.status, 413, `${label} got ${res.status}`);
  const text = await res.text();
  assert.equal(text, TOO_LARGE, `${label}: staff would read ${JSON.stringify(text)}`);
}

/**
 * A good envelope's bytes with some that no UTF-8 decoder takes as they are, put where a sender could put them: in place
 * of a character of the signature or of the payload, or around the whole.
 */
function notUtf8(good: string): [string, Buffer<ArrayBuffer>][] {
  const bytes = Buffer.from(good);
  const swapped = (at: number, ...replacement: number[]) =>
    Buffer.concat([bytes.subarray(0, at), Buffer.from(replacement), bytes.subarray(at + 1)]);
  const sigStart = bytes.indexOf('"sig":"') + '"sig":"'.length;
  assert.ok(sigStart > 0 && bytes.indexOf("@") > 0, good);
  return [
    ["a lone 0xFF", Buffer.from([0xff])],
    ["0xFF in place of the first sig character", swapped(sigStart, 0xff)],
    ["two of the three bytes of 沖 in place of the payload's @", swapped(bytes.indexOf("@"), 0xe6, 0xb2)],
    ["0xFF after the envelope", Buffer.concat([bytes, Buffer.from([0xff])])],
  ];
}

async function assertNothingCopied(worker: TestWorker, label: string): Promise<void> {
  const row = await worker.db.prepare("SELECT r2_key FROM photos WHERE name = ?1").bind(PHOTO.name).first();
  assert.equal(row, null, label);
  assert.equal(await worker.media.head(PHOTO_KEY), null, label);
}

/** The route still works after the refusals before this, and what they refused was still there to copy. */
async function assertCopiesThePhoto(worker: TestWorker, drive: FakeDrive): Promise<void> {
  const calls = drive.requests.length;
  const res = await signedPost(worker);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), FIRST_COPY);
  assert.ok(drive.requests.length > calls, "an accepted request reaches Google");
  assert.ok(await worker.media.head(PHOTO_KEY), "the photo reaches R2");
}

function assertNoLeak(text: string, label: string): void {
  const keyLine = GOOGLE_PRIVATE_KEY.split("\n")[1];
  for (const secret of [SECRET, GOOGLE_TOKEN, UPSTREAM, keyLine, FOLDER]) {
    assert.equal(text.includes(secret), false, `${label}: the response carries ${secret}`);
  }
  assert.doesNotMatch(text, /googleapis/i, `${label}: the response carries Google's URL: ${text}`);
}

/** What the Apps Script prints as it stands, after "Photos failed: the Worker answered 500: ", so words and no document. */
function assertShortMessage(text: string, label: string): void {
  assert.ok(text.length > 0 && text.length <= 200, `${label}: expected a short message, got ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /^\s*[{[<"]/, `${label}: staff would read this as it stands: ${text}`);
  assertNoLeak(text, label);
}

test("unsigned, stale and tampered requests get 401 without Google calls", async () => {
  const MINUTE_MS = 60_000;
  const good = () => envelope(SECRET, PAYLOAD);
  const without = (field: "ts" | "payload" | "sig") => {
    const { [field]: _dropped, ...rest } = good();
    return JSON.stringify(rest);
  };

  const REFUSED: [string, () => string | undefined][] = [
    ["no body", () => undefined],
    ["an empty body", () => ""],
    ["not JSON", () => "{not json"],
    ["JSON null", () => "null"],
    ["a JSON array", () => "[]"],
    ["a payload with no envelope", () => JSON.stringify(PAYLOAD)],
    ["no sig", () => without("sig")],
    ["no ts", () => without("ts")],
    ["no payload", () => without("payload")],
    ["an empty sig", () => JSON.stringify({ ...good(), sig: "" })],
    ["ts as text", () => JSON.stringify({ ...good(), ts: String(Date.now()) })],
    ["the payload as an object", () => JSON.stringify({ ...good(), payload: PAYLOAD })],
    ["signed with another secret", () => JSON.stringify(envelope("another-secret", PAYLOAD))],
    ["signed with the default test secret", () => JSON.stringify(envelope(testVars.PUBLISH_SECRET, PAYLOAD))],
    ["signed with the empty secret", () => JSON.stringify(envelope("", PAYLOAD))],
    ["payload changed after signing", () => JSON.stringify({ ...good(), payload: '{"requestedBy":"mallory"}' })],
    ["ts changed after signing", () => JSON.stringify({ ...good(), ts: Date.now() + 1000 })],
    ["one sig character changed", () => JSON.stringify({ ...good(), sig: flipped(good().sig) })],
    ["a cut-off sig", () => JSON.stringify({ ...good(), sig: good().sig.slice(0, 32) })],
    ["stale by ten minutes", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - 10 * MINUTE_MS))],
    ["stale by a day", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - 1440 * MINUTE_MS))],
    ["ten minutes in the future", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() + 10 * MINUTE_MS))],
  ];

  const drive = fakeDrive();
  await withWorker(drive, {}, async (worker) => {
    for (const [name, body] of REFUSED) {
      const res = await post(worker, body());
      assert.equal(res.status, 401, name);
      // The Apps Script's shape stays, and every refusal reads the same, so none says which check failed.
      assert.deepEqual(await res.json(), { error: "unauthorized" }, name);
    }

    assert.deepEqual(drive.requests, [], "no Google calls");
    await assertNothingCopied(worker, "a refused request");
    await assertCopiesThePhoto(worker, drive);
  });
});

test("a tampered body that is not UTF-8 gets 401 without Google calls", async () => {
  // Anyone can send any bytes. Read as text, with U+FFFD for what is not UTF-8, these reach the signature check and get
  // its answer, and not the empty 404 of an error the route did not catch. The stream's chunks of one byte split them.
  const BYTE_SENDS: [string, (worker: TestWorker, body: Buffer<ArrayBuffer>) => Promise<Response>][] = [
    ["with a Content-Length", (worker, body) => postWithLength(worker, body)],
    ["as a stream of 1-byte chunks", (worker, body) => postStream(worker, chunksOf(body, 1))],
  ];

  const drive = fakeDrive();
  await withWorker(drive, {}, async (worker) => {
    for (const [name, body] of notUtf8(JSON.stringify(envelope(SECRET, PAYLOAD)))) {
      for (const [how, send] of BYTE_SENDS) {
        const label = `${name} ${how}`;
        const res = await send(worker, body);
        assert.equal(res.status, 401, `${label} got ${res.status}`);
        assert.equal(await res.text(), UNAUTHORIZED, label);
      }
    }

    assert.deepEqual(drive.requests, [], "no Google calls");
    await assertNothingCopied(worker, "a refused request");
    await assertCopiesThePhoto(worker, drive);
  });
});

test("a body over 64 KB is refused without Google calls", async () => {
  const drive = fakeDrive();
  await withWorker(drive, {}, async (worker) => {
    // Signed, so only the limit can refuse them. At the first size the second padding is under the limit in characters,
    // and over it in the bytes that arrive.
    for (const filler of ["x", "沖"]) {
      for (const size of [LIMIT_BYTES + 1, 70_000, 100_000]) {
        for (const [how, send] of SENDS) {
          const label = `${size} bytes of "${filler}" padding ${how}`;
          // The Worker stops reading a stream it refuses, so the end of the upload can fail before the answer gets through.
          const res = await send(worker, sized(size, filler)).catch((error: Error) => {
            assert.equal(send, streamed, `${label}: ${error.message}`);
            return null;
          });
          await assertTooLarge(res, label);
          assert.deepEqual(drive.requests, [], label);
        }
      }
    }

    // Anyone can send these: the limit has to come before the signature, so these are 413 and not 401.
    const signed = sized(70_000, "x");
    // The limit counts bytes before anything decodes them, so junk that is not UTF-8 is refused by its size as well.
    const UNSIGNED: [string, string | Buffer<ArrayBuffer>][] = [
      ["junk", "x".repeat(70_000)],
      ["junk that is not UTF-8", Buffer.alloc(70_000, 0xff)],
      ["a broken signature", tampered(signed)],
      ["no signature", JSON.stringify({ ...(JSON.parse(signed) as object), sig: "" })],
    ];
    for (const [name, body] of UNSIGNED) {
      await assertTooLarge(await post(worker, body), name);
    }

    assert.deepEqual(drive.requests, [], "no Google calls");
    await assertNothingCopied(worker, "a refused request");
    await assertCopiesThePhoto(worker, drive);
  });
});

test("a body at the limit reaches the signature check and one byte past it does not", async () => {
  const drive = fakeDrive();
  await withWorker(drive, {}, async (worker) => {
    // The whole of the limit is usable, however it arrives, and a stream's chunks that end inside the second padding
    // still decode to the text that was signed.
    for (const filler of ["x", "沖"]) {
      for (const [how, send] of SENDS) {
        const label = `"${filler}" padding ${how}`;
        const calls = drive.requests.length;
        const res = await send(worker, sized(LIMIT_BYTES, filler));
        assert.equal(res.status, 200, label);
        await res.text();
        assert.ok(drive.requests.length > calls, `${label}: the request did not reach Google`);
      }
    }

    // /api/publish is here because this is the one limit, moved and now shared. A broken signature tells the two answers
    // apart on either route: 401 is the signature check and 413 is the limit, and neither calls Google.
    const calls = drive.requests.length;
    for (const path of [PATH, CATALOG_PATH]) {
      for (const [how, send] of SENDS) {
        const label = `${path} ${how}`;
        const at = await send(worker, tampered(sized(LIMIT_BYTES, "x")), path);
        assert.equal(at.status, 401, `${label}, at the limit`);
        await at.text();

        const past = await send(worker, tampered(sized(LIMIT_BYTES + 1, "x")), path).catch((error: Error) => {
          assert.equal(send, streamed, `${label}: ${error.message}`);
          return null;
        });
        await assertTooLarge(past, `${label}, one byte past the limit`);
      }
    }
    assert.equal(drive.requests.length, calls, "no Google calls");
  });
});

test("a fast stream past 64 KB is refused without reading the rest", async () => {
  // This one needs no signature, and it ends, so a Worker that reads all of it before measuring answers in time. What
  // tells them apart is how much the sender gave up. A sender stays ahead of the Worker by what the sockets between them
  // hold: about 1 MiB on a Mac, and at most 10 MiB by Linux's default TCP buffer limits, where CI runs. A Worker that reads
  // on took the whole cap, even on overloaded cores, so MOST_BYTES sits between the two.
  const CHUNK_BYTES = 16 * 1024;
  const CAP_BYTES = 32 * 1024 * 1024;
  const MOST_BYTES = 16 * 1024 * 1024;
  const chunk = Buffer.alloc(CHUNK_BYTES, "x");

  const drive = fakeDrive();
  await withWorker(drive, {}, async (worker) => {
    let pulled = 0;
    const flood = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        pulled += CHUNK_BYTES;
        if (pulled >= CAP_BYTES) controller.close();
      },
    });

    // As in "a body over 64 KB is refused": the end of a refused upload can fail before the answer gets through.
    const res = await postStream(worker, flood).catch(() => null);
    await res?.text().catch(() => "");

    assert.ok(pulled > LIMIT_BYTES, `the sender gave up only ${pulled} bytes, which never reached the limit`);
    assert.ok(pulled < MOST_BYTES, `the sender gave up ${pulled} bytes, so the Worker read on past the limit`);
    // The end of the flood can cut its answer off, so the words of the 413 are checked in the tests before this one.
    assert.ok(res === null || res.status === 413, `the flood got ${res?.status}`);
    assert.deepEqual(drive.requests, [], "no Google calls");
    await assertNothingCopied(worker, "a refused request");
    await assertCopiesThePhoto(worker, drive);
  });
});

test("a body that stalls past 64 KB is refused without waiting for the rest", async () => {
  // Anyone can send this, since it needs no signature. Reading a body to its end before measuring it would leave the
  // Worker waiting for as long as the sender likes.
  const WAIT_MS = 5_000;
  const drive = fakeDrive();
  await withWorker(drive, {}, async (worker) => {
    // Nothing closes this stream.
    const stalled = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(Buffer.alloc(LIMIT_BYTES + 1, "x")),
    });

    const res = await Promise.race([postStream(worker, stalled), sleep(WAIT_MS, null, { ref: false })]);

    assert.ok(res, `no answer in ${WAIT_MS} ms: the Worker is waiting for the end of the body`);
    assert.equal(res.status, 413);
    assert.deepEqual(drive.requests, [], "no Google calls");
    await assertNothingCopied(worker, "a refused request");
    await assertCopiesThePhoto(worker, drive);
  });
});

test("an empty or unset PUBLISH_SECRET gets 500 and never authorizes a publish", async () => {
  // A Worker can only have one secret, so this control has a Worker of its own: the same catalog and folder, with a
  // secret, reach Google. That is what the empty lists below are measured against.
  const healthy = fakeDrive();
  await withWorker(healthy, {}, (worker) => assertCopiesThePhoto(worker, healthy));

  const MINUTE_MS = 60_000;
  const ENVELOPES: [string, () => string][] = [
    ["the signature anyone can compute for an empty secret", () => JSON.stringify(envelope("", PAYLOAD))],
    ["the same signature, stale", () => JSON.stringify(envelope("", PAYLOAD, Date.now() - 10 * MINUTE_MS))],
    ["the signature for the word undefined", () => JSON.stringify(envelope("undefined", PAYLOAD))],
    ["the signature a healthy Worker takes", () => JSON.stringify(envelope(SECRET, PAYLOAD))],
    ["an empty sig", () => JSON.stringify({ ...envelope("", PAYLOAD), sig: "" })],
  ];
  const CASES: [string, string | undefined][] = [
    ["empty", ""],
    ["unset", undefined],
  ];
  for (const [name, secret] of CASES) {
    const drive = fakeDrive();
    await withWorker(drive, { PUBLISH_SECRET: secret }, async (worker) => {
      for (const [how, body] of ENVELOPES) {
        const label = `${name}, ${how}`;
        const res = await post(worker, body());

        assert.equal(res.status, 500, label);
        const text = await res.text();
        assertShortMessage(text, label);
        assert.doesNotMatch(text, /DataError|HMAC|importKey|key length|secret/i, label);
      }

      // verifyEnvelope turns this down before it touches the secret, so either answer refuses it.
      const notAnEnvelope = await post(worker, "{}");
      assert.ok([401, 500].includes(notAnEnvelope.status), `${name}, not an envelope: got ${notAnEnvelope.status}`);
      assertNoLeak(await notAnEnvelope.text(), `${name}, not an envelope`);

      assert.deepEqual(drive.requests, [], `${name}: no Google calls`);
      await assertNothingCopied(worker, name);
    });
  }
});

test("a Google failure gets a 5xx and not the 404 of an uncaught error", async () => {
  // Astro answers an error a route did not catch by rendering the page for /500. This site has none, so /[locale] matches
  // it, with 500 as the locale, and answers its empty 404. A route that lets an error go reads as a route that is not there.
  const refused = (status: number) => () =>
    new Response(`${UPSTREAM} Authorization: Bearer ${GOOGLE_TOKEN}`, { status });
  const FAULTS: [string, "token" | "list", Fault][] = [
    [
      "the token refused",
      "token",
      () => Response.json({ error: "invalid_grant", error_description: UPSTREAM }, { status: 400 }),
    ],
    ["the folder forbidden", "list", refused(403)],
    ["the folder not found", "list", refused(404)],
    ["Drive down", "list", refused(500)],
    ["a list of the wrong shape", "list", () => Response.json({ detail: UPSTREAM })],
    // A redirect loop stands in for a dropped connection: the Worker's own fetch rejects with a TypeError that quotes the
    // folder's URL, and no client has stripped it.
    ["a connection lost", "list", () => new Response(UPSTREAM, { status: 307, headers: { Location: "./files" } })],
  ];

  const answers = new Map<string, string>();
  const drive = fakeDrive();
  await withWorker(drive, {}, async (worker) => {
    for (const [name, call, fault] of FAULTS) {
      // A token left in D1 would keep a token fault from being reached.
      await worker.db.prepare("DELETE FROM kv_cache").run();
      drive.faults = { [call]: fault };
      const calls = drive.requests.length;

      const res = await signedPost(worker);

      assert.ok(res.status >= 500 && res.status < 600, `${name} got ${res.status}`);
      const text = await res.text();
      assertNoLeak(text, name);
      answers.set(name, text);
      assert.ok(drive.requests.length > calls, `${name}: the request never reached the fault`);
      await assertNothingCopied(worker, name);
    }

    // The same Worker copies the photo once Google is back, so what failed was Google.
    drive.faults = {};
    await assertCopiesThePhoto(worker, drive);
  });

  // Staff act on these words, and nothing is wrong with Google on a Worker with no secret, so its answer is not any of
  // these. One catch around both the signature check and the copy would give the same answer to both.
  for (const secret of ["", undefined]) {
    const untouched = fakeDrive();
    await withWorker(untouched, { PUBLISH_SECRET: secret }, async (worker) => {
      const label = `PUBLISH_SECRET ${JSON.stringify(secret)}`;
      const res = await signedPost(worker);
      assert.equal(res.status, 500, label);
      const text = await res.text();
      for (const [name, answer] of answers) {
        assert.notEqual(text, answer, `${label} answers the same as ${name}: ${text}`);
      }
    });
  }
});
