// The signed block sync through the built Worker: it reads the Blocks tab, syncs it into `bookings` and writes each
// row's publish_status back. Bodies are signed here with node:crypto, the way the Apps Script side signs them. Sheets is
// the fake grid of tests/helpers/fake-sheets.ts behind the REST paths, faked in `outbound`, so a test reads the cells
// that end up in the sheet and never how the Worker built its calls. Sheet rows are literals, counted by hand. Their
// dates are counted from today, because the Worker judges them by the real clock.
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { createFakeSheets, type FakeSheets } from "../helpers/fake-sheets.ts";
import { seedBooking, type BookingRow } from "../helpers/seed.ts";
import {
  appendCopy,
  appendRow,
  expectedCatalog,
  rearrangeColumns,
  removeColumn,
  setCell,
  sheetSerial,
  validWorkbook,
  type Workbook,
} from "../helpers/sheet-workbook.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const SYNC_PATH = "/api/publish/blocks";
const TOKEN = "e2e-sheets-token";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_ORIGIN = "https://sheets.googleapis.com";
const VALUES_PATH = `/v4/spreadsheets/${testVars.GOOGLE_SHEET_ID}/values`;
const TEN_MINUTES_MS = 600_000;
const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 32_400_000;

const STATUS = "publish_status";
const STAFF = "staff@okinawa-dream.example";

/** One reading of the clock, so a run that crosses midnight in Japan keeps its rows and its expected values equal. */
const TODAY_MS = Date.now();

/** The JST date `days` from today. validateBlocks refuses a date more than 2 years from the Worker's clock. */
function inDays(days: number): string {
  return new Date(TODAY_MS + JST_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
}

// The fixture's rows keep their gaps and their times of day. BLK-1 is overnight, and later BLK-2 runs over three days
// and BLK-3 over the first two of them. Nothing here reads shop hours or ClosedDates, so the weekday does not matter.
const BLK_1_START = inDays(60);
const BLK_1_END = inDays(61);
const BLK_2_START = inDays(77);
const BLK_2_MIDDLE = inDays(78);
const BLK_2_END = inDays(79);
/** The day of the rows that all want one bike. */
const CROWDED_DAY = inDays(108);
const STORED_DAY = inDays(138);
const LATER_STORED_DAY = inDays(147);
const PAST_DAY = inDays(-30);

// The service account signs for real inside the Worker, so the placeholder key in testVars will not do.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** The spreadsheet behind the fake API. Each test starts on a copy of the valid workbook. */
let sheets: FakeSheets;
/** What a read answers instead of the grid. */
let readFailure: (() => Response) | null = null;
/** What a write answers instead of reaching the grid. */
let writeFailure: (() => Response) | null = null;
const outboundRequests: string[] = [];

function jst(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/** The valid workbook with its rows moved to the dates above, each cell in its own form: a serial stays a serial. */
function blocksWorkbook(): Workbook {
  const workbook = validWorkbook();
  const dates: [blockId: string, start: string | number, end: string | number][] = [
    ["BLK-1", `${BLK_1_START} 09:00`, `${BLK_1_END} 18:00`],
    ["BLK-2", sheetSerial(BLK_2_START, "10:00"), sheetSerial(BLK_2_END, "17:30")],
    ["BLK-3", sheetSerial(BLK_2_START, "10:00"), `${BLK_2_MIDDLE} 09:00`],
  ];
  for (const [blockId, start, end] of dates) {
    setCell(workbook, "Blocks", blockId, "start", start);
    setCell(workbook, "Blocks", blockId, "end", end);
  }
  return workbook;
}

/** The cells of a row on the crowded day. */
function crowded(blockId: string, modelId: string): Record<string, string> {
  return {
    block_id: blockId,
    model_id: modelId,
    start: `${CROWDED_DAY} 09:00`,
    end: `${CROWDED_DAY} 18:00`,
    channel: "Klook",
  };
}

const FAILING = Array.from({ length: 23 }, (_, index) => `CON-${index + 1}`);

/** From row 2: `above`, 23 rows for the bike `webRival(CROWDED_DAY)` takes, and one that goes through. */
function longWorkbook(above: Record<string, string>[] = []): Workbook {
  const workbook = blocksWorkbook();
  workbook.Blocks.splice(1);
  for (const cells of above) appendRow(workbook, "Blocks", cells);
  for (const blockId of FAILING) appendRow(workbook, "Blocks", crowded(blockId, "rebel-250"));
  appendRow(workbook, "Blocks", crowded("GOOD", "nbox-660"));
  return workbook;
}

/** The API's shape: `values` is left out of an empty range, and a range on a tab that does not exist is a 400. */
async function readRanges(ranges: string[]): Promise<Response> {
  const valueRanges: { range: string; values?: unknown[][] }[] = [];
  for (const range of ranges) {
    let values: unknown[][];
    try {
      [values] = Object.values(await sheets.batchGet([range]));
    } catch {
      return new Response("Unable to parse range", { status: 400 });
    }
    valueRanges.push(values.length === 0 ? { range } : { range, values });
  }
  return Response.json({ valueRanges });
}

async function fakeGoogle(request: Request): Promise<Response> {
  outboundRequests.push(`${request.method} ${request.url}`);
  if (request.url === TOKEN_URL) return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });

  const url = new URL(request.url);
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no bearer token", { status: 401 });
  if (url.origin === SHEETS_ORIGIN && url.pathname === `${VALUES_PATH}:batchGet`) {
    return readFailure === null ? readRanges(url.searchParams.getAll("ranges")) : readFailure();
  }
  if (url.origin === SHEETS_ORIGIN && url.pathname === `${VALUES_PATH}:batchUpdate`) {
    if (writeFailure !== null) return writeFailure();
    const { data } = (await request.json()) as { data: { range: string; values: unknown[][] }[] };
    await sheets.batchUpdate(data);
    return Response.json({});
  }
  return new Response(`no fake for ${request.url}`, { status: 502 });
}

let worker: TestWorker;

before(async () => {
  worker = await startWorker({ vars: { GOOGLE_SA_PRIVATE_KEY: privateKey }, outbound: fakeGoogle });
});

after(async () => {
  await worker?.stop();
});

beforeEach(async () => {
  await worker.db.prepare("DELETE FROM bookings").run();
  await replaceCatalog(worker.db, expectedCatalog(), { now: Date.now(), source: "sheet" });
  sheets = createFakeSheets(blocksWorkbook());
  readFailure = null;
  writeFailure = null;
  outboundRequests.length = 0;
});

function signature(secret: string, ts: number, payload: string): string {
  return createHmac("sha256", secret).update(`${ts}.${payload}`, "utf8").digest("hex");
}

function signedBody(secret = testVars.PUBLISH_SECRET, ts = Date.now(), payload = "{}"): string {
  return JSON.stringify({ ts, payload, sig: signature(secret, ts, payload) });
}

function postSync(body?: string): Promise<Response> {
  return worker.fetch(SYNC_PATH, { method: "POST", headers: { "content-type": "application/json" }, body });
}

/** The shape namedErrorLines_ in apps-script/Publish.js lists for staff, as `name: message`. */
type SyncError = { name: string; message: string };
type SyncResponse = { processed: number; remaining: number; errors: SyncError[]; cursor: string | null };

async function signedSync(payload: unknown = {}): Promise<SyncResponse> {
  const res = await postSync(signedBody(testVars.PUBLISH_SECRET, Date.now(), JSON.stringify(payload)));
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text) as SyncResponse;
  assert.ok(body.cursor === null || typeof body.cursor === "string", `cursor: ${text}`);
  assert.ok(
    Array.isArray(body.errors) &&
      body.errors.every((error) => typeof error?.name === "string" && typeof error?.message === "string"),
    text,
  );
  return body;
}

/** The one error under `name`. */
function errorNamed(result: SyncResponse, name: string): SyncError {
  const found = result.errors.filter((error) => error.name === name);
  assert.equal(found.length, 1, `${name}: ${JSON.stringify(result.errors)}`);
  return found[0];
}

function namesOf(...results: SyncResponse[]): string[] {
  return results.flatMap(({ errors }) => errors.map(({ name }) => name)).sort();
}

function assertNamesRival(text: string): void {
  assert.ok(text.includes("WEBRIVAL") && text.includes("わ1005"), text);
}

/** At least one error, all of them the tab's, and one that says `names`. */
function assertTabProblem(result: SyncResponse, names = ""): void {
  const shown = JSON.stringify(result.errors);
  assert.notEqual(result.errors.length, 0, shown);
  assert.ok(result.errors.every(({ name }) => name === "Blocks"), shown);
  assert.ok(result.errors.some(({ name, message }) => `${name}: ${message}`.includes(names)), shown);
}

async function allBookings(): Promise<BookingRow[]> {
  const { results } = await worker.db.prepare("SELECT * FROM bookings ORDER BY id").all<BookingRow>();
  return results;
}

async function stored(blockId: string): Promise<BookingRow | null> {
  return worker.db
    .prepare("SELECT * FROM bookings WHERE source = 'block' AND external_ref = ?1")
    .bind(blockId)
    .first<BookingRow>();
}

/** A guest's booking, on `day`, of the one bike of the rebel-250. On the default day it overlaps BLK-2. */
function webRival(day = BLK_2_MIDDLE): Promise<BookingRow> {
  return seedBooking(worker.db, {
    vehicle_plate: "わ1005",
    model_id: "rebel-250",
    ref: "WEBRIVAL",
    start_at: jst(day, "09:00"),
    end_at: jst(day, "18:00"),
  });
}

/** A block already in place on the nbox-660, from `start` to the same time the next day, under an old hash. */
function storedBlock(blockId: string, start = STORED_DAY): Promise<BookingRow> {
  return seedBooking(worker.db, {
    vehicle_plate: "わ1006",
    model_id: "nbox-660",
    source: "block",
    external_ref: blockId,
    external_channel: "Klook",
    content_hash: "a-hash-from-an-earlier-sync",
    start_at: jst(start, "09:00"),
    end_at: jst(start, "09:00") + DAY_MS,
    package_id: null,
    price_jpy: null,
    deposit_jpy: null,
    catalog_version: null,
    locale: null,
    guest_family_name: null,
    guest_given_name: null,
    guest_email: null,
    guest_phone: null,
  });
}

/** What the sheet shows for `row`, a 1-based sheet row, in the status column of the grid as it now stands. */
function shownOn(row: number, column = STATUS): string {
  const [header, ...rows] = sheets.grid("Blocks");
  const index = header.map((name) => String(name).toLowerCase()).indexOf(column);
  assert.notEqual(index, -1, `no column ${column}`);
  return String(rows[row - 2]?.[index] ?? "");
}

function withoutStatus(grid: unknown[][]): unknown[][] {
  const index = grid[0].map((name) => String(name).toLowerCase()).indexOf(STATUS);
  return grid.map((row) => {
    const cells = row.filter((_, at) => at !== index);
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    return cells;
  });
}

const SHOWS_OK = /^ok\b/i;

test("signed block sync writes statuses back", async () => {
  const workbook = blocksWorkbook();
  // The rows are BLK-1, a blank row, BLK-2 and BLK-3, so BLK-2 and BLK-3 sit on sheet rows 4 and 5.
  workbook.Blocks.splice(2, 0, []);
  setCell(workbook, "Blocks", "BLK-1", STATUS, "error: a stale message");
  setCell(workbook, "Blocks", "BLK-3", "start", "soon");
  sheets = createFakeSheets(workbook);
  const original = sheets.grid("Blocks");
  const rival = await webRival();

  const result = await signedSync();

  assert.equal(result.processed, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.errors.length, 2, JSON.stringify(result.errors));
  assertNamesRival(errorNamed(result, "BLK-2").message);
  assert.match(errorNamed(result, "BLK-3").message, /\bstart\b/);

  const taken = await stored("BLK-1");
  assert.ok(taken);
  assert.equal(taken.status, "CONFIRMED");
  assert.equal(taken.vehicle_plate, "わ1002");
  assert.equal(taken.model_id, "pcx-125");
  assert.equal(taken.start_at, jst(BLK_1_START, "09:00"));
  assert.equal(taken.end_at, jst(BLK_1_END, "18:00"));
  assert.equal(taken.external_channel, "Klook");
  assert.equal(await stored("BLK-2"), null);
  assert.equal(await stored("BLK-3"), null);
  assert.equal((await allBookings()).length, 2);
  assert.deepEqual((await allBookings()).find(({ id }) => id === rival.id), rival);

  assert.match(shownOn(2), SHOWS_OK);
  assert.equal(shownOn(3), "", "the blank row got a status");
  assertNamesRival(shownOn(4));
  assert.match(shownOn(5), /\bstart\b/);
  assert.deepEqual(withoutStatus(sheets.grid("Blocks")), withoutStatus(original), "a cell other than the status moved");
});

const ABOVE_A_VALID_ROW: [label: string, breakIt: (workbook: Workbook) => void, name: string, shows: RegExp[]][] = [
  ["a bad start", (workbook) => setCell(workbook, "Blocks", "BLK-1", "start", "soon"), "BLK-1", [/\bstart\b/]],
  [
    "two errors",
    (workbook) => {
      setCell(workbook, "Blocks", "BLK-1", "start", "soon");
      setCell(workbook, "Blocks", "BLK-1", "model_id", "ghost");
    },
    "BLK-1",
    [/\bstart\b/, /\bmodel_id\b/],
  ],
  ["a blank block_id", (workbook) => setCell(workbook, "Blocks", "BLK-1", "block_id", ""), "row 2", [/\bblock_id\b/]],
];

// `statuses` has a line per message and `blocks` drops rejected rows, so a row's place in one says nothing of the other.
for (const [label, breakIt, name, shows] of ABOVE_A_VALID_ROW) {
  test(`${label} on the top row leaves every status on its own row`, async () => {
    const workbook = blocksWorkbook();
    breakIt(workbook);
    sheets = createFakeSheets(workbook);
    const original = sheets.grid("Blocks");
    await webRival();

    const result = await signedSync();

    // BLK-2 tried and failed, and BLK-3 stored.
    assert.equal(result.processed, 2);
    assert.equal(result.remaining, 0);
    assert.equal(await stored("BLK-1"), null);
    assert.equal(await stored("BLK-2"), null);
    assert.equal((await stored("BLK-3"))?.vehicle_plate, "わ1001");

    const told = result.errors.filter((error) => error.name === name).map(({ message }) => message);
    for (const column of shows) {
      assert.match(shownOn(2), column);
      assert.match(told.join("\n"), column);
    }
    assert.ok(!shownOn(2).includes("WEBRIVAL"), shownOn(2));
    assertNamesRival(shownOn(3));
    assert.match(shownOn(4), SHOWS_OK);

    assertNamesRival(errorNamed(result, "BLK-2").message);
    assert.deepEqual([...new Set(namesOf(result))], [name, "BLK-2"].sort());
    assert.deepEqual(withoutStatus(sheets.grid("Blocks")), withoutStatus(original), "a cell besides the status moved");
  });
}

test("statuses find their rows by header and by the id as it reads", async () => {
  const workbook = blocksWorkbook();
  setCell(workbook, "Blocks", "BLK-2", "block_id", 2002);
  setCell(workbook, "Blocks", "BLK-3", "block_id", "ＢＬＫ－３");
  // A second BLK-1 on row 5: the row that owns the id gets the sync's status, and this one keeps its own error.
  appendCopy(workbook, "Blocks", "BLK-1", {});
  rearrangeColumns(workbook, "Blocks", (indexes) => [...indexes].reverse(), (header) => header.toUpperCase());
  sheets = createFakeSheets(workbook);
  const original = sheets.grid("Blocks");

  const result = await signedSync();

  assert.equal(result.processed, 3);
  assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
  assert.match(errorNamed(result, "BLK-1").message, /\bblock_id\b/);
  assert.equal((await stored("BLK-1"))?.vehicle_plate, "わ1002");
  assert.equal((await stored("2002"))?.vehicle_plate, "わ1005");
  assert.equal((await stored("BLK-3"))?.vehicle_plate, "わ1001");
  assert.match(shownOn(2), SHOWS_OK);
  assert.match(shownOn(3), SHOWS_OK);
  assert.match(shownOn(4), SHOWS_OK);
  assert.match(shownOn(5), /\bblock_id\b/);
  assert.deepEqual(withoutStatus(sheets.grid("Blocks")), withoutStatus(original), "a cell other than the status moved");
});

test("unsigned block sync gets 401", async () => {
  await storedBlock("BLK-OLD");
  const rows = await allBookings();

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

  assert.deepEqual(outboundRequests, [], "an unsigned request reached Google");
  assert.deepEqual(await allBookings(), rows);
});

test("a tampered or stale signature on block sync gets 401", async () => {
  await storedBlock("BLK-OLD");
  const rows = await allBookings();

  const now = Date.now();
  const good = JSON.parse(signedBody(testVars.PUBLISH_SECRET, now)) as { ts: number; payload: string; sig: string };
  const bodies: [string, string][] = [
    ["signed with another secret", signedBody("not-the-publish-secret", now)],
    ["signed with the mail secret", signedBody(testVars.MAIL_SECRET, now)],
    ["a payload changed after signing", JSON.stringify({ ...good, payload: '{"cursor":"forged"}' })],
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
  assert.deepEqual(outboundRequests, [], "a badly signed request reached Google");
  assert.deepEqual(await allBookings(), rows);

  // The same signing with the right secret gets through, so the refusals above were about the signature.
  await signedSync();
  assert.ok(await stored("BLK-1"));
});

// Miniflare's fetch sends every body as Transfer-Encoding: chunked unless the request names a Content-Length, which then
// arrives in place of it, so a test that cares which one the Worker sees uses one of these two.
function postWithLength(body: string): Promise<Response> {
  const headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
  return worker.fetch(SYNC_PATH, { method: "POST", headers, body });
}

function postStream(body: ReadableStream<Uint8Array>): Promise<Response> {
  const headers = { "content-type": "application/json" };
  return worker.fetch(SYNC_PATH, { method: "POST", headers, body, duplex: "half" } as RequestInit);
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

// A stream has no Content-Length to go by, so its bytes have to be counted as they arrive. Each chunk is far below the
// limit, so the count has to run across them, and 1000 is no multiple of 3, so chunks end inside the multi-byte filler
// too, which has to survive that.
function postChunks(body: string): Promise<Response> {
  return postStream(chunksOf(body, 1000));
}

const SENDS: [how: string, send: (body: string) => Promise<Response>][] = [
  ["as a string", (body) => postSync(body)],
  ["with a Content-Length", postWithLength],
  ["as a stream with no Content-Length", postChunks],
];

/** A good envelope of at least `bytes`, padded with `filler`. */
function paddedBody(bytes: number, filler: string): string {
  const ts = Date.now();
  const padded = (count: number) =>
    signedBody(testVars.PUBLISH_SECRET, ts, JSON.stringify({ requestedBy: filler.repeat(count) }));
  return padded(Math.ceil((bytes - Buffer.byteLength(padded(0))) / Buffer.byteLength(filler)));
}

/** A refused request reached neither Google nor the sheet, and left every booking in `rows` as it was. */
async function assertLeftAlone(rows: BookingRow[], label: string): Promise<void> {
  assert.deepEqual(outboundRequests, [], `${label}: a refused request reached Google`);
  assert.equal(sheets.count("batchUpdate"), 0, `${label}: a status was written`);
  assert.deepEqual(await allBookings(), rows, `${label}: a booking changed`);
}

/** Runs `run` with `worker` standing for a Worker of its own, so the helpers above all reach it. It has a catalog. */
async function withPublishSecret(secret: string | undefined, run: () => Promise<void>): Promise<void> {
  const shared = worker;
  const vars = { GOOGLE_SA_PRIVATE_KEY: privateKey, PUBLISH_SECRET: secret };
  worker = await startWorker({ vars, outbound: fakeGoogle });
  try {
    await replaceCatalog(worker.db, expectedCatalog(), { now: Date.now(), source: "sheet" });
    await run();
  } finally {
    await worker.stop();
    worker = shared;
  }
}

test("a body over 64 KB is refused without Google calls", async () => {
  // A sync that ran would cancel this block and take the three rows of the sheet.
  await storedBlock("BLK-OLD");
  const rows = await allBookings();

  // Signed, so only the limit can refuse them, and one byte over 64 KiB, the larger reading of 64 KB. The second is
  // under the limit in characters, and over it in the bytes that arrive.
  for (const filler of ["x", "沖"]) {
    for (const [how, send] of SENDS) {
      const label = `"${filler}" padding ${how}`;
      const body = paddedBody(65_537, filler);
      assert.ok(Buffer.byteLength(body) >= 65_537, label);

      // The Worker stops reading a stream it refuses, so the end of the upload can fail before the answer gets through.
      // That still has to leave Google and D1 alone, and the other sends always get an answer to read.
      const res = await send(body).catch((error: Error) => {
        assert.equal(send, postChunks, `${label}: ${error.message}`);
        return null;
      });
      await res?.text().catch(() => "");

      assert.ok(res === null || res.status === 413, `${label} got ${res?.status}`);
      await assertLeftAlone(rows, label);
    }
  }
});

test("a fast stream past 64 KB is refused without reading the rest", async () => {
  // This needs no signature, and it ends, so a Worker that reads all of it before measuring answers in time. What tells
  // them apart is how much the sender gave up. A sender stays ahead of the Worker by what the sockets between them hold:
  // about 1 MiB on a Mac, and at most 10 MiB by Linux's default TCP buffer limits, where CI runs. A Worker that reads on
  // took the whole cap, even on overloaded cores, so MOST_BYTES sits between the two.
  const CHUNK_BYTES = 16 * 1024;
  const CAP_BYTES = 32 * 1024 * 1024;
  const MOST_BYTES = 16 * 1024 * 1024;
  const chunk = Buffer.alloc(CHUNK_BYTES, "x");

  await storedBlock("BLK-OLD");
  const rows = await allBookings();

  let pulled = 0;
  const flood = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
      pulled += CHUNK_BYTES;
      if (pulled >= CAP_BYTES) controller.close();
    },
  });

  // As in "a body over 64 KB is refused": the end of a refused upload can fail before the answer gets through.
  const res = await postStream(flood).catch(() => null);
  await res?.text().catch(() => "");

  // 64,000 bytes is the smaller reading of the limit, so the Worker cannot have refused this on fewer.
  assert.ok(pulled > 64_000, `the sender gave up only ${pulled} bytes, which never reached the limit`);
  assert.ok(pulled < MOST_BYTES, `the sender gave up ${pulled} bytes, so the Worker read on past the limit`);
  assert.ok(res === null || res.status === 413, `got ${res?.status}`);
  await assertLeftAlone(rows, "the flood");

  // The refusal left the route working.
  await signedSync();
  assert.equal((await stored("BLK-1"))?.status, "CONFIRMED");
});

test("an empty or unset PUBLISH_SECRET gets 500 and never authorizes", async () => {
  const CASES: [string, string | undefined][] = [
    ["empty", ""],
    ["unset", undefined],
  ];
  // The signature anyone can compute for an empty key, and the one for an unset secret that was turned into text.
  const KEYS = ["", "undefined"];
  // The caller here has proved nothing, and what workerd throws for the key names it: "Imported HMAC key length (0) ...".
  const CRYPTO_DETAIL = /DataError|HMAC|importKey/i;

  for (const [name, secret] of CASES) {
    await withPublishSecret(secret, async () => {
      await storedBlock("BLK-OLD");
      const rows = await allBookings();

      for (const key of KEYS) {
        const label = `${name}, signed with ${JSON.stringify(key)}`;
        const res = await postSync(signedBody(key));
        const text = await res.text();
        assert.equal(res.status, 500, label);
        assert.doesNotMatch(text, CRYPTO_DETAIL, label);
      }

      await assertLeftAlone(rows, name);
    });
  }
});

test("a large signed body within 64 KB still syncs", async () => {
  // 64,000 bytes is within the limit on either reading of 64 KB, however it arrives. The second padding comes in threes,
  // so it asks for less to stay within that, and its stream only keeps its signature if chunks that end inside a
  // character are put back together.
  for (const [filler, bytes] of [["x", 64_000], ["沖", 63_998]] as const) {
    for (const [how, send] of SENDS) {
      const label = `"${filler}" padding ${how}`;
      await worker.db.prepare("DELETE FROM bookings").run();
      sheets = createFakeSheets(blocksWorkbook());
      const body = paddedBody(bytes, filler);
      const size = Buffer.byteLength(body);
      assert.ok(size >= bytes && size <= 64_000, `${label}: ${size} bytes`);

      const res = await send(body);
      const text = await res.text();

      assert.equal(res.status, 200, `${label}: ${text}`);
      const result = JSON.parse(text) as SyncResponse;
      assert.equal(result.processed, 3, label);
      assert.equal(result.remaining, 0, label);
      assert.deepEqual(result.errors, [], label);
      for (const blockId of ["BLK-1", "BLK-2", "BLK-3"]) {
        assert.equal((await stored(blockId))?.status, "CONFIRMED", `${label}: ${blockId}`);
      }
      for (const row of [2, 3, 4]) assert.match(shownOn(row), SHOWS_OK, `${label}: row ${row}`);
    }
  }
});

const BROKEN_TABS: [label: string, breakIt: (workbook: Workbook) => void, names: string][] = [
  ["a tab with no header row", (workbook) => workbook.Blocks.splice(0), "Blocks"],
  ["a missing end header", (workbook) => removeColumn(workbook, "Blocks", "end"), "end"],
  ["a missing block_id header", (workbook) => removeColumn(workbook, "Blocks", "block_id"), "block_id"],
];

for (const [label, breakIt, names] of BROKEN_TABS) {
  test(`${label} stops the sync and cancels nothing`, async () => {
    await storedBlock("BLK-OLD");
    const rows = await allBookings();
    const workbook = blocksWorkbook();
    breakIt(workbook);
    sheets = createFakeSheets(workbook);

    const result = await signedSync();

    assert.equal(result.processed, 0);
    assertTabProblem(result, names);
    assert.deepEqual(await allBookings(), rows);
    assert.equal(sheets.count("batchUpdate"), 0, "a fatal tab is not written to");
  });
}

test("a header-only Blocks tab cancels nothing and reports an error", async () => {
  await storedBlock("BLK-OLD");
  const rows = await allBookings();
  const workbook = blocksWorkbook();
  workbook.Blocks.splice(1);
  sheets = createFakeSheets(workbook);

  const result = await signedSync();

  assert.equal(result.processed, 0);
  assert.equal(result.remaining, 0);
  assertTabProblem(result);
  assert.deepEqual(await allBookings(), rows);
});

test("a header-only Blocks tab with only past blocks is no error", async () => {
  await storedBlock("BLK-PAST", PAST_DAY);
  const workbook = blocksWorkbook();
  workbook.Blocks.splice(1);
  sheets = createFakeSheets(workbook);

  const result = await signedSync();

  assert.deepEqual(result.errors, []);
});

const READ_FAILURES: [label: string, answer: () => Response][] = [
  ["a 403", () => new Response("the caller does not have permission", { status: 403 })],
  ["a 404", () => new Response("no such spreadsheet", { status: 404 })],
  ["a 200 with no valueRanges", () => Response.json({ spreadsheetId: testVars.GOOGLE_SHEET_ID })],
];

for (const [label, answer] of READ_FAILURES) {
  test(`${label} from Sheets cancels nothing`, async () => {
    await storedBlock("BLK-OLD");
    const rows = await allBookings();
    readFailure = answer;

    const res = await postSync(signedBody());
    await res.text();

    assert.ok(
      outboundRequests.some((line) => line.includes(":batchGet")),
      `the sync never read the sheet: status ${res.status}`,
    );
    assert.ok(res.status < 200 || res.status >= 300, `status ${res.status}`);
    assert.deepEqual(await allBookings(), rows);
    assert.equal(sheets.count("batchUpdate"), 0);
  });
}

test("a status write that fails answers non-2xx, and the next run writes the statuses and moves no booking", async () => {
  const gone = await storedBlock("BLK-OLD");
  await webRival();
  writeFailure = () => new Response("the caller does not have permission", { status: 403 });

  const res = await postSync(signedBody());
  const text = await res.text();

  assert.ok(
    outboundRequests.some((line) => line.includes(":batchUpdate")),
    `the sync never wrote the statuses: status ${res.status}: ${text}`,
  );
  assert.ok(res.status < 200 || res.status >= 300, `status ${res.status}: ${text}`);
  assert.equal(sheets.count("batchUpdate"), 0);
  assert.equal((await stored("BLK-OLD"))?.status, "CANCELLED");
  assert.equal((await stored("BLK-OLD"))?.id, gone.id);
  assert.equal((await stored("BLK-1"))?.status, "CONFIRMED");
  assert.equal(await stored("BLK-2"), null);
  assert.equal((await stored("BLK-3"))?.status, "CONFIRMED");
  const rows = await allBookings();

  writeFailure = null;
  const rerun = await signedSync();

  // The clock has moved, so a write to any booking would show in updated_at.
  assert.deepEqual(await allBookings(), rows);
  assert.equal(rerun.processed, 1, "only the row that still fails is a change");
  assert.equal(rerun.remaining, 0);
  assert.equal(rerun.errors.length, 1, JSON.stringify(rerun.errors));
  assertNamesRival(errorNamed(rerun, "BLK-2").message);
  assert.match(shownOn(2), SHOWS_OK);
  assertNamesRival(shownOn(3));
  assert.match(shownOn(4), SHOWS_OK);
});

/** On an empty inventory, `payload` takes every row of the valid sheet from the first, as a new pass does. */
async function assertStartsThePass(payload: unknown): Promise<void> {
  const label = JSON.stringify(payload);
  await worker.db.prepare("DELETE FROM bookings").run();
  sheets = createFakeSheets(blocksWorkbook());

  const result = await signedSync(payload);

  assert.equal(result.processed, 3, label);
  assert.equal(result.remaining, 0, label);
  assert.deepEqual(result.errors, [], label);
  for (const blockId of ["BLK-1", "BLK-2", "BLK-3"]) {
    assert.equal((await stored(blockId))?.status, "CONFIRMED", `${label}: ${blockId}`);
  }
  for (const row of [2, 3, 4]) assert.match(shownOn(row), SHOWS_OK, `${label}: row ${row}`);
}

test("a cursor in the signed payload that is no string restarts the pass", async () => {
  for (const cursor of [42, 1, true, ["BLK-2"], { blockId: "BLK-2" }]) await assertStartsThePass({ cursor });
});

test("a signed payload that is no object restarts the pass", async () => {
  for (const payload of [[], null, 7, "BLK-2", true]) await assertStartsThePass(payload);
});

test("a cursor that restarts the pass reports the whole sheet, as a first round does", async () => {
  const workbook = blocksWorkbook();
  setCell(workbook, "Blocks", "BLK-1", "start", "soon");
  sheets = createFakeSheets(workbook);
  await webRival();

  for (const cursor of ["%%% not a cursor %%%", "", 42, ["BLK-2"]]) {
    const result = await signedSync({ requestedBy: STAFF, cursor });

    assert.match(errorNamed(result, "BLK-1").message, /\bstart\b/, JSON.stringify(cursor));
    assertNamesRival(errorNamed(result, "BLK-2").message);
  }
});

test("a cursor from rows that have gone restarts the pass and reports the rows there now", async () => {
  sheets = createFakeSheets(longWorkbook());
  await webRival(CROWDED_DAY);
  const first = await signedSync({ requestedBy: STAFF });
  assert.equal(typeof first.cursor, "string");

  const workbook = blocksWorkbook();
  setCell(workbook, "Blocks", "BLK-1", "start", "soon");
  sheets = createFakeSheets(workbook);

  const result = await signedSync({ requestedBy: STAFF, cursor: first.cursor });

  assert.deepEqual(namesOf(result), ["BLK-1"]);
  assert.match(errorNamed(result, "BLK-1").message, /\bstart\b/);
  assert.equal((await stored("BLK-2"))?.status, "CONFIRMED");
  assert.equal((await stored("BLK-3"))?.status, "CONFIRMED");
  assert.match(shownOn(2), /\bstart\b/);
  assert.match(shownOn(3), SHOWS_OK);
  assert.match(shownOn(4), SHOWS_OK);
});

const TABS_LOST_IN_A_PASS: [label: string, breakIt: (workbook: Workbook) => void, names: string][] = [
  ...BROKEN_TABS,
  ["a tab down to its header", (workbook) => workbook.Blocks.splice(1), "Blocks"],
];

for (const [label, breakIt, names] of TABS_LOST_IN_A_PASS) {
  test(`${label} part way through a pass is still reported and cancels nothing`, async () => {
    sheets = createFakeSheets(longWorkbook());
    await webRival(CROWDED_DAY);
    const first = await signedSync({ requestedBy: STAFF });
    assert.equal(typeof first.cursor, "string");

    await storedBlock("BLK-OLD");
    const rows = await allBookings();
    const workbook = longWorkbook();
    breakIt(workbook);
    sheets = createFakeSheets(workbook);

    const result = await signedSync({ requestedBy: STAFF, cursor: first.cursor });

    assert.equal(result.processed, 0);
    assertTabProblem(result, names);
    assert.deepEqual(await allBookings(), rows);
  });
}

test("block sync with no catalog published writes nothing", async () => {
  await worker.db.prepare("DELETE FROM catalog_meta").run();
  await worker.db.prepare("DELETE FROM config").run();

  const res = await postSync(signedBody());
  const text = await res.text();

  assert.ok(res.status < 500, `status ${res.status}: ${text}`);
  assert.match(text, /catalog/i);
  assert.deepEqual(await allBookings(), []);
  assert.equal(sheets.count("batchUpdate"), 0);
});

test("a row rejected with a readable id keeps its stored block", async () => {
  await storedBlock("BLK-3");
  const kept = await stored("BLK-3");
  const missing = await storedBlock("BLK-OLD", LATER_STORED_DAY);
  const workbook = blocksWorkbook();
  setCell(workbook, "Blocks", "BLK-3", "start", "soon");
  sheets = createFakeSheets(workbook);

  const result = await signedSync();

  assert.deepEqual(await stored("BLK-3"), kept);
  assert.equal((await stored("BLK-OLD"))?.status, "CANCELLED");
  assert.equal((await stored("BLK-OLD"))?.id, missing.id);
  assert.match(shownOn(4), /\bstart\b/);
  assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
  assert.match(errorNamed(result, "BLK-3").message, /\bstart\b/);
});

test("a row with a blank block_id stops the cancels and reports why", async () => {
  const missing = await storedBlock("BLK-OLD");
  const workbook = blocksWorkbook();
  setCell(workbook, "Blocks", "BLK-3", "block_id", "");
  sheets = createFakeSheets(workbook);

  const result = await signedSync();

  assert.deepEqual(await stored("BLK-OLD"), missing);
  assert.ok(await stored("BLK-1"), "the other rows still go through");
  assert.ok(await stored("BLK-2"), "the other rows still go through");
  assert.match(shownOn(4), /\bblock_id\b/);
  // The row's own error, and the one saying stored blocks were kept.
  assert.equal(result.errors.length, 2, JSON.stringify(result.errors));
  assert.match(errorNamed(result, "row 4").message, /\bblock_id\b/);
  assert.notEqual(errorNamed(result, "Blocks").message, "");
  assert.equal(result.remaining, 0);
});

test("a long sync reaches the end on its cursor and keeps each row's status", async () => {
  sheets = createFakeSheets(longWorkbook());
  await webRival(CROWDED_DAY);

  const first = await signedSync();

  assert.equal(first.processed, 20);
  assert.equal(first.remaining, 4);
  assert.equal(first.errors.length, 20, "a change not yet tried is a warning, not an error");
  assert.equal(await stored("GOOD"), null);

  const second = await signedSync({ cursor: first.cursor });

  assert.equal(second.processed, 4);
  assert.equal(second.remaining, 0);
  assert.equal(second.errors.length, 3, "the 20 told already stay with round one");
  assert.deepEqual(namesOf(first, second), [...FAILING].sort());
  assert.equal((await stored("GOOD"))?.status, "CONFIRMED");
  for (const [index, blockId] of FAILING.entries()) {
    const shown = shownOn(index + 2);
    assert.ok(shown.includes("WEBRIVAL") && shown.includes("わ1005"), `${blockId}: ${shown}`);
  }
  assert.match(shownOn(25), SHOWS_OK);
});

test("a round on a cursor answers its own sync problems, and the first round the rest", async () => {
  // Row 2 is rejected, row 3 has no id, rows 4 to 26 want the rival's bike and row 27 goes through.
  const bad = { ...crowded("BAD", "rebel-250"), start: "soon" };
  sheets = createFakeSheets(longWorkbook([bad, crowded("", "rebel-250")]));
  await webRival(CROWDED_DAY);
  const kept = await storedBlock("BLK-OLD");

  const first = await signedSync({ requestedBy: STAFF });

  assert.equal(first.processed, 20);
  assert.equal(first.remaining, 4);
  assert.equal(typeof first.cursor, "string");
  assert.equal(first.errors.length, 23, JSON.stringify(first.errors));
  assert.match(errorNamed(first, "BAD").message, /\bstart\b/);
  assert.match(errorNamed(first, "row 3").message, /\bblock_id\b/);
  assert.notEqual(errorNamed(first, "Blocks").message, "");

  const second = await signedSync({ requestedBy: STAFF, cursor: first.cursor });

  assert.equal(second.processed, 4);
  assert.equal(second.remaining, 0);
  assert.equal(second.errors.length, 3, JSON.stringify(second.errors));
  const tried = namesOf(first, second).filter((name) => name.startsWith("CON-"));
  assert.deepEqual(tried, [...FAILING].sort(), "each failing row is told once over the pass");
  for (const name of ["BAD", "row 3", "Blocks"]) assert.ok(!namesOf(second).includes(name), `round two has ${name}`);

  assert.match(shownOn(2), /\bstart\b/, "the rejected row keeps its status");
  assert.match(shownOn(3), /\bblock_id\b/, "the row with no id keeps its status");
  for (const [index, blockId] of FAILING.entries()) {
    const shown = shownOn(index + 4);
    assert.ok(shown.includes("WEBRIVAL") && shown.includes("わ1005"), `${blockId}: ${shown}`);
  }
  assert.match(shownOn(27), SHOWS_OK);
  assert.deepEqual(await stored("BLK-OLD"), kept);
});
