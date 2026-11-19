// POST /api/publish through the built Worker in Miniflare: a fake Google behind `outbound`, the Worker's own D1, and a
// service-account key made by the helper. Envelopes are signed here with node:crypto rather than signEnvelope, so the
// format is checked from outside, and because WebCrypto refuses the empty secret one test needs. Each test gets its own
// Worker, so a count of outbound calls starts at zero. Sheets failures use statuses the client does not retry, so
// nothing waits for backoff.
//
// Every POST says Content-Type: application/json as the Apps Script does: Astro's origin check answers 403 to a
// cross-site POST with no type, or with a form type, which is what a bare string body gets.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { readCatalog } from "../../src/lib/db/catalog-store.ts";
import type { Catalog } from "../../src/lib/types.ts";
import { fakeGoogle, GOOGLE_PRIVATE_KEY, GOOGLE_TOKEN, type FakeGoogle, type Fault } from "../helpers/fake-google.ts";
import {
  canonicalCatalog,
  CATALOG_TABS,
  expectedCatalog as fixtureCatalog,
  removeColumn,
  setCell,
  sheetSerial,
  statusWrite,
  validWorkbook as fixtureWorkbook,
  type Workbook,
} from "../helpers/sheet-workbook.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const PATH = "/api/publish";
const SECRET = "e2e-publish-secret";
const PAYLOAD = { requestedBy: "staff@example.com" };
const JSON_HEADERS = { "Content-Type": "application/json" };

/** In every faked failure, so that any of Google's body reaching the response shows. */
const UPSTREAM = "UPSTREAM-DETAIL-FOR-NOBODY";
const ROWS = 48;

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;

/**
 * The Worker reads the real clock, and a ClosedDates row more than two years from it is an error, so the fixture's own
 * dates would turn into error rows on 2029-01-01. Three days a month from now take their place here, and only here.
 */
const CLOSED_DATES = [30, 31, 32].map((days) =>
  new Date(Date.now() + JST_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10),
);

/** The fixture's sheet with CLOSED_DATES in its cells, written as those were: a serial, text and a serial. */
function validWorkbook(): Workbook {
  const workbook = fixtureWorkbook();
  const [first, second, third] = CLOSED_DATES;
  workbook.ClosedDates[1][0] = sheetSerial(first);
  workbook.ClosedDates[2][0] = second;
  workbook.ClosedDates[3][0] = sheetSerial(third);
  return workbook;
}

/** The fixture's catalog, closed on CLOSED_DATES. */
function expectedCatalog(): Catalog {
  return { ...fixtureCatalog(), closedDates: CLOSED_DATES };
}

async function withWorker(
  google: FakeGoogle,
  vars: Record<string, string | undefined>,
  run: (worker: TestWorker) => Promise<void>,
): Promise<void> {
  const worker = await startWorker({
    outbound: google.outbound,
    vars: { GOOGLE_SA_PRIVATE_KEY: GOOGLE_PRIVATE_KEY, PUBLISH_SECRET: SECRET, ...vars },
  });
  try {
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

function post(worker: TestWorker, body: string): Promise<Response> {
  return worker.fetch(PATH, { method: "POST", headers: JSON_HEADERS, body });
}

function signedPost(worker: TestWorker): Promise<Response> {
  return post(worker, JSON.stringify(envelope(SECRET, PAYLOAD)));
}

// Miniflare's fetch sends every body as Transfer-Encoding: chunked unless the request names a Content-Length, which then
// arrives in place of it, so a test that cares which one the Worker sees uses one of these two.
function postWithLength(worker: TestWorker, body: string): Promise<Response> {
  const headers = { ...JSON_HEADERS, "Content-Length": String(Buffer.byteLength(body)) };
  return worker.fetch(PATH, { method: "POST", headers, body });
}

function postStream(worker: TestWorker, body: ReadableStream<Uint8Array>): Promise<Response> {
  return worker.fetch(PATH, { method: "POST", headers: JSON_HEADERS, body, duplex: "half" } as RequestInit);
}

/** The bytes of `text` in chunks of `size`. */
function chunksOf(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = Buffer.from(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(bytes.subarray(at, at + size));
      at += size;
      if (at >= bytes.length) controller.close();
    },
  });
}

/** `body` as bytes, with a Content-Length, or as a stream of one byte to a chunk, which splits every sequence in it. */
const BYTE_SENDS: [string, (worker: TestWorker, body: Buffer<ArrayBuffer>) => Promise<Response>][] = [
  [
    "with a Content-Length",
    (worker, body) =>
      worker.fetch(PATH, {
        method: "POST",
        headers: { ...JSON_HEADERS, "Content-Length": String(body.length) },
        body,
      }),
  ],
  [
    "as a stream of 1-byte chunks",
    (worker, body) => {
      let at = 0;
      return postStream(
        worker,
        new ReadableStream({
          pull(controller) {
            controller.enqueue(body.subarray(at, at + 1));
            at += 1;
            if (at >= body.length) controller.close();
          },
        }),
      );
    },
  ],
];

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

async function storedCatalog(worker: TestWorker): Promise<Catalog> {
  return canonicalCatalog(await readCatalog(worker.db));
}

function assertShortAndClean(text: string, label: string): void {
  assert.ok(text.length > 0 && text.length <= 200, `${label}: expected a short message, got ${JSON.stringify(text)}`);
  const keyLine = GOOGLE_PRIVATE_KEY.split("\n")[1];
  for (const secret of [GOOGLE_TOKEN, UPSTREAM, SECRET, keyLine, testVars.GOOGLE_SHEET_ID]) {
    assert.equal(text.includes(secret), false, `${label}: the response carries ${secret}`);
  }
  // A lost connection's TypeError opens with the sheet's URL, so this holds where a shorter cut stops inside the ID.
  assert.doesNotMatch(text, /https?:/i, `${label}: the response carries a URL: ${text}`);
}

/**
 * A 500's or 502's body as staff get it. The Apps Script (#16, PR #88) prints it as it stands, cut at 300 characters,
 * after "Publish failed: the Worker answered 502: ", so it is words and not a document, and the 200 of
 * assertShortAndClean keeps every one of them ahead of the cut.
 */
function assertStaffMessage(text: string, label: string): void {
  assertShortAndClean(text, label);
  assert.doesNotMatch(text, /^\s*[{[<"]/, `${label}: staff would read this as it stands: ${text}`);
}

// What a 502 means to staff, whatever its wording, which is the coder's. These read clause by clause, so that "the
// catalog published" counts and "the catalog was not published" or "the catalog may have published" does not.
const CLAUSE_BREAK = /[.,;:!?()]+(?:\s+|$)|\s+[-–—]\s+|\s+(?:and|but|so|though|although|while|after)\s+/i;
const CATALOG_DONE = /\bcatalog\b.*\b(?:published|did publish|succeeded|went through|live)\b|^published\b.*\bcatalog\b/i;
const NEGATED = /\b(?:not|no|never|nothing|cannot|unable|fail(?:s|ed|ure)?|error|stale|unchanged)\b|n['’]t\b/i;
const HEDGED = /\b(?:stays?|remains?|still|previous|last|old|if|whether|may|might|maybe|perhaps|possibly|probably)\b/i;
const PUBLISH_AGAIN = /\bpublish\b[^.;:!?]{0,30}\b(?:again|once more|retry)\b|\bre-?publish\b/i;
// "Publish failed" is not a denial: the Apps Script's prefix says that already, of a publish that may have landed.
const DENIED = /\b(?:not|no|never|nothing|cannot)\b|n['’]t\b/i;
const UNSURE = /\b(?:if|whether|may|might|maybe|perhaps|possibly|probably)\b/i;

function saysNothingPublished(text: string): boolean {
  const denies = (clause: string) => /\bpublish/i.test(clause) && DENIED.test(clause) && !UNSURE.test(clause);
  return text.split(CLAUSE_BREAK).some(denies);
}

function saysCatalogPublished(text: string): boolean {
  const plainly = (clause: string) => !NEGATED.test(clause) && !HEDGED.test(clause);
  return text.split(CLAUSE_BREAK).some((clause) => CATALOG_DONE.test(clause) && plainly(clause));
}

function saysStatusesDidNot(text: string): boolean {
  return text.split(CLAUSE_BREAK).some((clause) => /status/i.test(clause) && NEGATED.test(clause));
}

/** The fixture's catalog with the price the tests below set in the sheet. */
function catalogWithPrice(priceJpy: number): Catalog {
  const catalog = expectedCatalog();
  const price = catalog.prices.find(({ rateClassId, packageId }) => rateClassId === "bike-125" && packageId === "day-1");
  assert.ok(price);
  price.priceJpy = priceJpy;
  return catalog;
}

test("a signed publish through the Worker stores the fixture catalog", async () => {
  const workbook = validWorkbook();
  const google = fakeGoogle(workbook);
  await withWorker(google, {}, async (worker) => {
    const res = await signedPost(worker);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      version: 1,
      counts: { ok: ROWS, warning: 0, error: 0 },
      fatal: [],
      affectedBookings: [],
    });
    assert.deepEqual(await storedCatalog(worker), canonicalCatalog(expectedCatalog()));
    const meta = await worker.db.prepare("SELECT version, source FROM catalog_meta").all();
    assert.deepEqual(meta.results, [{ version: 1, source: "sheet" }]);

    assert.equal(google.batchGets.length, 1);
    assert.deepEqual([...google.batchGets[0]].sort(), [...CATALOG_TABS].sort());
    assert.equal(google.batchUpdates.length, 1);
    for (const tab of CATALOG_TABS) {
      const { firstRow, lastRow, cells } = statusWrite(google.batchUpdates[0], tab);
      assert.equal(firstRow, 2, tab);
      assert.equal(lastRow, workbook[tab].length, tab);
      assert.ok(cells.every((cell) => cell === "ok"), `${tab}: ${cells}`);
    }

    // The next publish reads the sheet again and reports the next version.
    setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", 5300);
    const next = await signedPost(worker);
    assert.equal(next.status, 200);
    assert.equal(((await next.json()) as { version: number }).version, 2);
    const price = await worker.db
      .prepare("SELECT price_jpy FROM prices WHERE rate_class_id = ?1 AND package_id = ?2")
      .bind("bike-125", "day-1")
      .first("price_jpy");
    assert.equal(price, 5300);
  });
});

test("unsigned, stale and tampered requests get 401 without outbound calls", async () => {
  const MINUTE_MS = 60_000;
  const good = () => envelope(SECRET, PAYLOAD);
  const flipped = (sig: string) => `${sig[0] === "0" ? "1" : "0"}${sig.slice(1)}`;
  const without = (field: "ts" | "payload" | "sig") => {
    const { [field]: _dropped, ...rest } = good();
    return JSON.stringify(rest);
  };

  const REFUSED: [string, () => string][] = [
    ["no body", () => ""],
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
    ["payload changed after signing", () => JSON.stringify({ ...good(), payload: '{"requestedBy":"mallory"}' })],
    ["ts changed after signing", () => JSON.stringify({ ...good(), ts: Date.now() + 1000 })],
    ["one sig character changed", () => JSON.stringify({ ...good(), sig: flipped(good().sig) })],
    ["a cut-off sig", () => JSON.stringify({ ...good(), sig: good().sig.slice(0, 32) })],
    ["stale by ten minutes", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - 10 * MINUTE_MS))],
    ["stale by a day", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - 1440 * MINUTE_MS))],
    ["ten minutes in the future", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() + 10 * MINUTE_MS))],
  ];

  const google = fakeGoogle(validWorkbook());
  await withWorker(google, {}, async (worker) => {
    const bodies = new Set<string>();
    for (const [name, body] of REFUSED) {
      const res = await post(worker, body());
      assert.equal(res.status, 401, name);
      bodies.add(await res.text());
    }

    // No detail: every refusal reads the same, so none says which check failed.
    assert.equal(bodies.size, 1, `the refusals differ: ${[...bodies].join(" | ")}`);
    assert.doesNotMatch([...bodies][0], /stale|expired|malformed|signature|json/i);
    assert.deepEqual(google.requests, [], "no Google calls");
    assert.equal(await readCatalog(worker.db), null);
  });
});

test("a tampered body that is not UTF-8 gets 401 without outbound calls", async () => {
  // Anyone can send any bytes. Read as text, with U+FFFD for what is not UTF-8, these reach the signature check and get
  // its one answer, and not the empty 404 of an error the route did not catch.
  const google = fakeGoogle(validWorkbook());
  await withWorker(google, {}, async (worker) => {
    for (const [name, body] of notUtf8(JSON.stringify(envelope(SECRET, PAYLOAD)))) {
      for (const [how, send] of BYTE_SENDS) {
        const label = `${name} ${how}`;
        const res = await send(worker, body);
        assert.equal(res.status, 401, `${label} got ${res.status}`);
        assert.equal(await res.text(), "Unauthorized", label);
      }
    }

    assert.deepEqual(google.requests, [], "no Google calls");
    assert.equal(await readCatalog(worker.db), null);
    // The same Worker publishes a good envelope, so what turned these down was the signature check.
    assert.equal((await signedPost(worker)).status, 200);
  });
});

test("methods other than POST get 405 without outbound calls", async () => {
  const google = fakeGoogle(validWorkbook());
  await withWorker(google, {}, async (worker) => {
    assert.equal((await worker.fetch(PATH)).status, 405, "GET");
    // With a good envelope, which a handler shared by every method would act on.
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const body = JSON.stringify(envelope(SECRET, PAYLOAD));
      const res = await worker.fetch(PATH, { method, headers: JSON_HEADERS, body });
      assert.equal(res.status, 405, method);
    }
    assert.deepEqual(google.requests, []);
    assert.equal(await readCatalog(worker.db), null);
  });
});

test("a body over 64 KB is refused without Google calls", async () => {
  /** A good envelope of at least `bytes`, padded with `filler`. */
  const sized = (bytes: number, filler: string): string => {
    const ts = Date.now();
    const empty = Buffer.byteLength(JSON.stringify(envelope(SECRET, { requestedBy: "" }, ts)));
    const count = Math.ceil((bytes - empty) / Buffer.byteLength(filler));
    return JSON.stringify(envelope(SECRET, { requestedBy: filler.repeat(count) }, ts));
  };

  // A stream has no Content-Length to go by, so its bytes have to be counted as they arrive. Each chunk is far below the
  // limit, so the count has to run across them, and 1000 is no multiple of 3, so chunks end inside the multi-byte filler
  // too, which has to survive that.
  const streamed = (worker: TestWorker, body: string) => postStream(worker, chunksOf(body, 1000));
  const SENDS: [string, (worker: TestWorker, body: string) => Promise<Response>][] = [
    ["as a string", post],
    ["with a Content-Length", postWithLength],
    ["as a stream with no Content-Length", streamed],
  ];

  const google = fakeGoogle(validWorkbook());
  await withWorker(google, {}, async (worker) => {
    // Signed, so only the limit can refuse them, and one byte over 64 KiB, the larger reading of 64 KB. The second is
    // under the limit in characters, and over it in the bytes that arrive.
    for (const filler of ["x", "沖"]) {
      for (const [how, send] of SENDS) {
        const label = `"${filler}" padding ${how}`;
        const body = sized(65_537, filler);
        assert.ok(Buffer.byteLength(body) >= 65_537);
        // The Worker stops reading a stream it refuses, so the end of the upload can fail before the answer gets through.
        // That still has to leave Google and D1 alone, and the streams below have to publish.
        const res = await send(worker, body).catch((error: Error) => {
          assert.equal(send, streamed, `${label}: ${error.message}`);
          return null;
        });
        assert.ok(res === null || (res.status >= 400 && res.status < 500), `${label} got ${res?.status}`);
        assert.deepEqual(google.requests, [], label);
        assert.equal(await readCatalog(worker.db), null, label);
      }
    }

    // 64,000 bytes is within the limit on either reading, however it arrives. The second padding comes in threes, so it
    // asks for less to stay within that.
    for (const [filler, bytes] of [["x", 64_000], ["沖", 63_998]] as const) {
      for (const [how, send] of SENDS) {
        const label = `"${filler}" padding ${how}`;
        const body = sized(bytes, filler);
        assert.ok(Buffer.byteLength(body) <= 64_000);
        const res = await send(worker, body);
        assert.equal(res.status, 200, label);
        assert.equal(((await res.json()) as { ok: boolean }).ok, true, label);
      }
    }
  });
});

test("a body over 64 KB gets 413 in the words staff read", async () => {
  // apps-script/Publish.js prints an answer as it stands, after "Publish failed: the Worker answered 413: ", so this one
  // is words and no document, as it was before the reader moved to a helper both publish routes share (#103).
  const TOO_LARGE = "The request is too large.";

  /** A good envelope of exactly `bytes`, padded with "x". */
  const sized = (bytes: number): string => {
    const ts = Date.now();
    const room = bytes - Buffer.byteLength(JSON.stringify(envelope(SECRET, { requestedBy: "" }, ts)));
    const body = JSON.stringify(envelope(SECRET, { requestedBy: "x".repeat(room) }, ts));
    assert.equal(Buffer.byteLength(body), bytes);
    return body;
  };
  const BODIES: [string, string][] = [
    ["a signed envelope one byte past 64 KiB", sized(65_537)],
    ["a signed envelope of 100,000 bytes", sized(100_000)],
    ["junk", "x".repeat(70_000)],
  ];

  const SENDS: [string, (worker: TestWorker, body: string) => Promise<Response>][] = [
    ["as a string", post],
    ["with a Content-Length", postWithLength],
  ];

  const google = fakeGoogle(validWorkbook());
  await withWorker(google, {}, async (worker) => {
    for (const [name, body] of BODIES) {
      for (const [how, send] of SENDS) {
        const label = `${name} ${how}`;
        const res = await send(worker, body);
        assert.equal(res.status, 413, `${label} got ${res.status}`);
        const text = await res.text();
        assert.equal(text, TOO_LARGE, `${label}: staff would read ${JSON.stringify(text)}`);
      }
    }

    assert.deepEqual(google.requests, [], "no Google calls");
    assert.equal(await readCatalog(worker.db), null);
  });
});

test("a body that stalls past 64 KB is refused without waiting for the rest", async () => {
  // Anyone can send this, since it needs no signature. Reading a body to its end before measuring it would leave the
  // Worker waiting for as long as the sender likes.
  const WAIT_MS = 5_000;
  const google = fakeGoogle(validWorkbook());
  await withWorker(google, {}, async (worker) => {
    // Nothing closes this stream.
    const stalled = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(Buffer.alloc(65_537, "x")),
    });

    const res = await Promise.race([postStream(worker, stalled), sleep(WAIT_MS, null, { ref: false })]);

    assert.ok(res, `no answer in ${WAIT_MS} ms: the Worker is waiting for the end of the body`);
    assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
    assert.deepEqual(google.requests, []);
    assert.equal(await readCatalog(worker.db), null);

    // A 404 is a 4xx too. This shows that the route is there, and that the refusal left it working.
    assert.equal((await signedPost(worker)).status, 200);
  });
});

test("a fast stream past 64 KB is refused without reading the rest", async () => {
  // This one needs no signature either, and it ends, so a Worker that reads all of it before measuring answers in time.
  // What tells them apart is how much the sender gave up. A sender stays ahead of the Worker by what the sockets between
  // them hold: about 1 MiB on a Mac, and at most 10 MiB by Linux's default TCP buffer limits, where CI runs. A Worker
  // that reads on took the whole cap, even on overloaded cores, so MOST_BYTES sits between the two.
  const CHUNK_BYTES = 16 * 1024;
  const CAP_BYTES = 32 * 1024 * 1024;
  const MOST_BYTES = 16 * 1024 * 1024;
  const chunk = Buffer.alloc(CHUNK_BYTES, "x");

  const google = fakeGoogle(validWorkbook());
  await withWorker(google, {}, async (worker) => {
    // A 404 is a 4xx too, and reads nothing, so the route has to be there first.
    assert.equal((await signedPost(worker)).status, 200);
    const before = await readCatalog(worker.db);
    const calls = google.requests.length;

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

    assert.ok(res === null || (res.status >= 400 && res.status < 500), `got ${res?.status}`);
    assert.ok(pulled > 65_536, `the sender gave up only ${pulled} bytes, which never reached the limit`);
    assert.ok(pulled < MOST_BYTES, `the sender gave up ${pulled} bytes, so the Worker read on past the limit`);
    assert.deepEqual(google.requests.slice(calls), [], "no Google calls");
    assert.deepEqual(await readCatalog(worker.db), before);

    // The refusal left the route working.
    assert.equal((await signedPost(worker)).status, 200);
  });
});

test("an empty or unset PUBLISH_SECRET gets 500 and never authorizes a publish", async () => {
  const CASES: [string, string | undefined][] = [
    ["empty", ""],
    ["unset", undefined],
  ];
  for (const [name, secret] of CASES) {
    const google = fakeGoogle(validWorkbook());
    await withWorker(google, { PUBLISH_SECRET: secret }, async (worker) => {
      // The signature anyone can compute for an empty secret.
      const res = await post(worker, JSON.stringify(envelope("", PAYLOAD)));

      assert.equal(res.status, 500, name);
      const text = await res.text();
      assertShortAndClean(text, name);
      assert.doesNotMatch(text, /DataError|HMAC|importKey|key length/i, name);
      assert.deepEqual(google.requests, [], name);
      assert.equal(await readCatalog(worker.db), null, name);
    });
  }
});

test("Google failures before the commit get 502 with a short message and leave the catalog unchanged", async () => {
  const quoted = (status: number, text: string) =>
    Response.json({ error: { code: status, message: `${UPSTREAM} ${text}`, status: "REFUSED" } }, { status });
  const FAULTS: [string, "token" | "batchGet", Fault][] = [
    [
      "the token refused",
      "token",
      () => Response.json({ error: "invalid_grant", error_description: `${UPSTREAM} ${GOOGLE_TOKEN}` }, { status: 400 }),
    ],
    ["the token endpoint down", "token", () => new Response(`<html>${UPSTREAM}</html>`, { status: 500 })],
    ["a token reply with no token", "token", () => Response.json({ detail: UPSTREAM })],
    ["batchGet forbidden", "batchGet", () => quoted(403, `token ${GOOGLE_TOKEN}`)],
    [
      "batchGet not found",
      "batchGet",
      () => new Response(`${UPSTREAM} Authorization: Bearer ${GOOGLE_TOKEN}`, { status: 404 }),
    ],
    ["a batchGet reply of the wrong shape", "batchGet", () => Response.json({ detail: UPSTREAM })],
    // A redirect loop stands in for a dropped connection, as in the next test: the Worker's own fetch rejects with a
    // TypeError that quotes the sheet's URL, and no client has stripped it.
    [
      "a connection lost on batchGet",
      "batchGet",
      () => new Response(UPSTREAM, { status: 307, headers: { Location: "./values:batchGet" } }),
    ],
  ];

  const workbook = validWorkbook();
  const google = fakeGoogle(workbook);
  await withWorker(google, {}, async (worker) => {
    assert.equal((await signedPost(worker)).status, 200);
    const before = await readCatalog(worker.db);
    assert.ok(before);
    setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", 5300);

    for (const [name, call, fault] of FAULTS) {
      // The first publish left its token in D1, and a token fault has to reach the token endpoint.
      await worker.db.prepare("DELETE FROM kv_cache").run();
      google.faults = { [call]: fault };
      const writes = google.batchUpdates.length;

      const res = await signedPost(worker);

      assert.equal(res.status, 502, name);
      const text = await res.text();
      assertStaffMessage(text, name);
      assert.equal(saysCatalogPublished(text), false, `${name}: nothing published, but staff read: ${text}`);
      assert.equal(google.batchUpdates.length, writes, `${name}: nothing is written to the sheet`);
      assert.deepEqual(await readCatalog(worker.db), before, name);
    }

    // The same Worker publishes once Google is back, so what failed was Google.
    google.faults = {};
    assert.equal((await signedPost(worker)).status, 200);
    assert.notDeepEqual(await readCatalog(worker.db), before);
  });
});

test("a failed status write gets 502 with a short message", async () => {
  // The owner's ruling on the ticket: D1 has committed by this write, so the catalog stays and staff must hear that it
  // did publish, which the prefix "Publish failed:" would otherwise deny. A press of Publish then rewrites the statuses.
  const refused = (status: number, text: string) =>
    Response.json({ error: { code: status, message: `${UPSTREAM} ${text}`, status: "REFUSED" } }, { status });
  // [name, fault, the requests one press makes]. Miniflare answers 500 to an outbound that throws, which the client
  // retries with backoff, so a redirect loop stands in for a dropped connection: the Worker's own fetch rejects with a
  // TypeError, not a SheetsError, and quotes the sheet's URL. How many redirects that takes is workerd's business.
  const FAULTS: [string, Fault, number | "any"][] = [
    [
      "batchUpdate forbidden",
      () => new Response(`${UPSTREAM} Authorization: Bearer ${GOOGLE_TOKEN}`, { status: 403 }),
      1,
    ],
    ["batchUpdate not found", () => refused(404, `token ${GOOGLE_TOKEN}`), 1],
    ["batchUpdate refused as malformed", () => refused(400, "Invalid range"), 1],
    [
      "a connection lost",
      () => new Response(UPSTREAM, { status: 307, headers: { Location: "./values:batchUpdate" } }),
      "any",
    ],
  ];

  const workbook = validWorkbook();
  const google = fakeGoogle(workbook);
  await withWorker(google, {}, async (worker) => {
    // The first round has no catalog before it. Each has a price of its own, so D1 shows that round's publish.
    for (const [index, [name, fault, requests]] of FAULTS.entries()) {
      const price = 5300 + index;
      setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", price);
      google.faults = { batchUpdate: fault };
      const writes = google.batchUpdates.length;

      const res = await signedPost(worker);

      assert.equal(res.status, 502, name);
      const text = await res.text();
      assertStaffMessage(text, name);
      assert.ok(saysCatalogPublished(text), `${name}: this does not say plainly that the catalog published: ${text}`);
      assert.ok(saysStatusesDidNot(text), `${name}: this does not say that the statuses did not: ${text}`);
      assert.match(text, PUBLISH_AGAIN, name);

      assert.deepEqual(await storedCatalog(worker), canonicalCatalog(catalogWithPrice(price)), name);
      const meta = await worker.db.prepare("SELECT version, source FROM catalog_meta").all();
      assert.deepEqual(meta.results, [{ version: index + 1, source: "sheet" }], name);
      if (requests !== "any") assert.equal(google.batchUpdates.length, writes + requests, name);
    }

    // What the message tells staff to do works, with the same sheet.
    google.faults = {};
    const writes = google.batchUpdates.length;
    const again = await signedPost(worker);

    assert.equal(again.status, 200);
    const report = (await again.json()) as { ok: boolean; version: number };
    assert.deepEqual([report.ok, report.version], [true, FAULTS.length + 1]);
    assert.equal(google.batchUpdates.length, writes + 1);
    for (const tab of CATALOG_TABS) {
      const { cells } = statusWrite(google.batchUpdates[writes], tab);
      assert.ok(cells.every((cell) => cell === "ok"), `${tab}: ${cells}`);
    }
    const last = 5300 + FAULTS.length - 1;
    assert.deepEqual(await storedCatalog(worker), canonicalCatalog(catalogWithPrice(last)));
  });
});

test("a D1 failure gets 500 with a short message that nothing was published", async () => {
  // The ticket's ruling: Google did not fail, so this is not a 502, and nothing landed, so staff must not hear otherwise.
  // The trigger stops replaceCatalog's batch late, after it has emptied config and the tables before it, so what is
  // still there afterwards also shows the batch rolled back.
  const workbook = validWorkbook();
  const google = fakeGoogle(workbook);
  await withWorker(google, {}, async (worker) => {
    assert.equal((await signedPost(worker)).status, 200);
    const before = await readCatalog(worker.db);
    assert.ok(before);
    const reads = google.batchGets.length;
    const writes = google.batchUpdates.length;

    setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", 5300);
    const trigger = "CREATE TRIGGER boom BEFORE INSERT ON config BEGIN SELECT RAISE(ABORT, 'boom'); END";
    await worker.db.prepare(trigger).run();

    const res = await signedPost(worker);

    assert.equal(res.status, 500);
    const text = await res.text();
    assertStaffMessage(text, "the D1 failure");
    assert.doesNotMatch(text, /boom|D1_ERROR|SQLITE/i, `staff read the database's own error: ${text}`);
    assert.equal(saysCatalogPublished(text), false, `nothing published, but staff read: ${text}`);
    assert.ok(saysNothingPublished(text), `this does not say that nothing was published: ${text}`);

    assert.equal(google.batchGets.length, reads + 1, "the sheet was read, so what failed came after that");
    assert.equal(google.batchUpdates.length, writes, "no status says a row published");
    assert.deepEqual(await readCatalog(worker.db), before);

    // The same Worker publishes the same sheet once D1 works, so what failed was D1.
    await worker.db.prepare("DROP TRIGGER boom").run();
    const again = await signedPost(worker);

    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { version: number }).version, before.version + 1);
    assert.equal(google.batchUpdates.length, writes + 1);
    assert.deepEqual(await storedCatalog(worker), canonicalCatalog(catalogWithPrice(5300)));
  });
});

test("a fatal sheet answers ok false and writes nothing back", async () => {
  const workbook = validWorkbook();
  const google = fakeGoogle(workbook);
  await withWorker(google, {}, async (worker) => {
    assert.equal((await signedPost(worker)).status, 200);
    const before = await readCatalog(worker.db);

    removeColumn(workbook, "Types", "sort");
    removeColumn(workbook, "Models", "brand");
    const res = await signedPost(worker);

    // The outline answers 200 with the report: this is the sheet's problem, not a failure of the Worker or of Google.
    assert.equal(res.status, 200);
    const report = (await res.json()) as { ok: boolean; version?: number; fatal: string[] };
    assert.equal(report.ok, false);
    assert.equal(report.version, undefined);
    assert.equal(report.fatal.length, 2);
    assert.match(report.fatal.join(" "), /Types.*sort/);
    assert.match(report.fatal.join(" "), /Models.*brand/);

    assert.equal(google.batchGets.length, 2);
    assert.equal(google.batchUpdates.length, 1, "only the first publish wrote");
    assert.deepEqual(await readCatalog(worker.db), before);
  });
});

// #135: a bad Prices row keeps the price the site has, so a guest can still book the package, and pays the kept price.

/** The JST date `days` from today, worked out here from the clock and the offset, not by the code under test. */
function jstDateIn(days: number): string {
  return new Date(Date.now() + JST_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
}

/** A guest's post of the model page's booking form: the route reads model, package, date and time. */
function book(worker: TestWorker, hold: { model: string; package: string; date: string; time: string }) {
  return worker.fetch("/en/book", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost" },
    body: new URLSearchParams(hold).toString(),
    redirect: "manual",
  });
}

test("a hold on a package whose Prices row went bad charges the last published price", async () => {
  // bike-125/day-1 is published at 5,200 with an advance price of 4,800, and bike-125/day-3 at 13,800 with none. Both
  // rows then go bad. pcx-125 rides bike-125, and a guest booking weeks ahead pays the advance price where there is one.
  const workbook = validWorkbook();
  setCell(workbook, "Prices", "bike-125/day-1", "advance_price_jpy", 4800);
  const google = fakeGoogle(workbook);
  await withWorker(google, {}, async (worker) => {
    /** Holds pcx-125 on `packageId` from 10:00 on `date`, and checks the booking the hold made. */
    const assertHold = async (packageId: string, date: string, priceJpy: number, version: number) => {
      const label = `${packageId} on ${date}, catalog version ${version}`;
      const answer = await book(worker, { model: "pcx-125", package: packageId, date, time: "10:00" });
      await answer.text();
      assert.equal(answer.status, 303, label);
      const location = new URL(answer.headers.get("location") ?? "", "http://localhost/");
      assert.match(location.pathname, /^\/en\/checkout\/[^/]+\/?$/, `${label}: went to ${location.pathname}`);
      const id = location.pathname.split("/")[3];
      const booking = await worker.db
        .prepare("SELECT status, package_id, price_jpy, catalog_version FROM bookings WHERE id = ?1")
        .bind(id)
        .first();
      const expected = { status: "ON_HOLD", package_id: packageId, price_jpy: priceJpy, catalog_version: version };
      assert.deepEqual(booking, expected, label);
    };

    // pcx-125 has one active bike, so each hold has dates of its own, clear of CLOSED_DATES 30 to 32 days ahead.
    assert.equal((await signedPost(worker)).status, 200);
    await assertHold("day-1", jstDateIn(10), 4800, 1);
    await assertHold("day-3", jstDateIn(50), 13_800, 1);

    setCell(workbook, "Prices", "bike-125/day-1", "price_jpy", -5);
    setCell(workbook, "Prices", "bike-125/day-3", "price_jpy", "abc");
    const res = await signedPost(worker);
    assert.equal(res.status, 200);
    const report = (await res.json()) as { ok: boolean; version: number; counts: { error: number } };
    assert.equal(report.ok, true);
    assert.equal(report.version, 2);
    assert.equal(report.counts.error, 2);

    await assertHold("day-1", jstDateIn(20), 4800, 2);
    await assertHold("day-3", jstDateIn(40), 13_800, 2);

    const { cells } = statusWrite(google.batchUpdates[1], "Prices");
    const cellOf = (key: string) => String(cells[workbook.Prices.findIndex((row) => `${row[0]}/${row[1]}` === key) - 1]);
    assert.match(cellOf("bike-125/day-1"), /^error\b/i);
    for (const kept of ["5,200", "4,800"]) assert.ok(cellOf("bike-125/day-1").includes(kept), cellOf("bike-125/day-1"));
    assert.ok(cellOf("bike-125/day-3").includes("13,800"), cellOf("bike-125/day-3"));
  });
});
