// POST /api/staff/check-rows through the built Worker in Miniflare: the "Add a bike" panel's proposed rows, checked
// against the live sheet and never written anywhere. Sheets is the fake grid of tests/helpers/fake-sheets.ts behind the
// REST paths (fakeGoogleSheets), so a test sees every read and write the Worker made of it. Envelopes are signed here
// with node:crypto, the way the Apps Script signs them, and because WebCrypto refuses the empty secret one test needs.
//
// Every POST says Content-Type: application/json as the Apps Script does: Astro's origin check answers 403 to a
// cross-site POST with no type, or with a form type, which is what a bare string body gets.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { fakeGoogleSheets, GOOGLE_PRIVATE_KEY } from "../helpers/fake-google.ts";
import { createFakeSheets, type FakeSheets } from "../helpers/fake-sheets.ts";
import { CATALOG_TABS, removeColumn, setCell, validWorkbook, type Workbook } from "../helpers/sheet-workbook.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const PATH = "/api/staff/check-rows";
const SECRET = testVars.PUBLISH_SECRET;
const JSON_HEADERS = { "Content-Type": "application/json" };
const MINUTE_MS = 60_000;

/** In every faked failure, so that any of Google's body reaching the response shows. */
const UPSTREAM = "UPSTREAM-DETAIL-FOR-NOBODY";

type Level = "ok" | "warning" | "error";
type RowCheck = { level: Level; messages: string[] };
type CheckAnswer = { fatal: string[]; rows: Record<string, RowCheck[] | undefined> };

const ADV_160 = {
  model_id: "adv-160",
  type_id: "scooter",
  rate_class_id: "bike-400",
  brand: "Honda",
  engine_cc: 160,
  sort: 9,
  active: true,
  name_en: "ADV160",
};

function vehicle(plate: string, model_id: string, extra: Record<string, string | number | boolean> = {}) {
  return { plate, model_id, status: "active", ...extra };
}

/** The spreadsheet behind the fake API, read on each request. Each test starts on a copy of the valid workbook. */
let sheets: FakeSheets;
/** What a batchGet answers instead of the grid. */
let readFault: (() => Response) | null = null;
const outboundRequests: string[] = [];
const sheetsApi = fakeGoogleSheets(() => sheets, testVars.GOOGLE_SHEET_ID);

async function outbound(request: Request): Promise<Response> {
  outboundRequests.push(`${request.method} ${request.url}`);
  if (readFault !== null && new URL(request.url).pathname.endsWith("/values:batchGet")) return readFault();
  return sheetsApi(request);
}

let worker: TestWorker;

before(async () => {
  worker = await startWorker({ vars: { GOOGLE_SA_PRIVATE_KEY: GOOGLE_PRIVATE_KEY, PUBLISH_SECRET: SECRET }, outbound });
});

after(async () => {
  await worker?.stop();
});

beforeEach(() => {
  sheets = createFakeSheets(validWorkbook());
  readFault = null;
  outboundRequests.length = 0;
});

/** The envelope the Apps Script sends: an HMAC-SHA256 in hex over `ts.payload`, with the payload as JSON text. */
function envelope(secret: string, payload: unknown, ts = Date.now()) {
  const text = JSON.stringify(payload);
  return { ts, payload: text, sig: createHmac("sha256", secret).update(`${ts}.${text}`).digest("hex") };
}

function post(body: string, to: TestWorker = worker): Promise<Response> {
  return to.fetch(PATH, { method: "POST", headers: JSON_HEADERS, body });
}

function postWithLength(body: string): Promise<Response> {
  const headers = { ...JSON_HEADERS, "Content-Length": String(Buffer.byteLength(body)) };
  return worker.fetch(PATH, { method: "POST", headers, body });
}

function signedPost(payload: unknown): Promise<Response> {
  return post(JSON.stringify(envelope(SECRET, payload)));
}

async function checked(rows: unknown): Promise<CheckAnswer> {
  const res = await signedPost({ rows });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as CheckAnswer;
}

function levels(answer: CheckAnswer, tab: string): Level[] {
  return (answer.rows[tab] ?? []).map(({ level }) => level);
}

function says(row: RowCheck | undefined, ...fragments: string[]): boolean {
  return (row?.messages ?? []).some((message) => fragments.every((fragment) => message.includes(fragment)));
}

/** Every table of D1 but the token cache, which reading the sheet may fill. */
async function d1Contents(): Promise<Record<string, unknown[]>> {
  const { results: tables } = await worker.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
        "AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'kv_cache' ORDER BY name",
    )
    .all<{ name: string }>();
  const contents: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    contents[name] = (await worker.db.prepare(`SELECT * FROM "${name}"`).all()).results;
  }
  return contents;
}

function grids(): Record<string, unknown[][]> {
  return Object.fromEntries(CATALOG_TABS.map((tab) => [tab, sheets.grid(tab)]));
}

/** No write reached the sheet, D1 or R2. */
async function assertNothingWritten(d1Before: Record<string, unknown[]>, gridsBefore: Record<string, unknown[][]>, label = "") {
  assert.equal(sheets.count("batchUpdate"), 0, `${label}: a batchUpdate reached the sheet`);
  assert.equal(sheets.count("append"), 0, `${label}: an append reached the sheet`);
  assert.deepEqual(sheets.writes, [], label);
  assert.deepEqual(grids(), gridsBefore, label);
  assert.deepEqual(await d1Contents(), d1Before, `${label}: D1 changed`);
  assert.deepEqual((await worker.media.list()).objects, [], `${label}: R2 changed`);
}

/** What staff read as it stands: short words, no document, nothing of Google's, no URL. */
function assertPlainWords(text: string, label: string): void {
  assert.ok(text.trim().length > 0 && text.length <= 200, `${label}: expected a short message, got ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, /^\s*[{[<"]/, `${label}: staff would read this as it stands: ${text}`);
  assert.doesNotMatch(text, /https?:/i, `${label}: the response carries a URL: ${text}`);
  const keyLine = GOOGLE_PRIVATE_KEY.split("\n")[1];
  for (const secret of [UPSTREAM, SECRET, keyLine, testVars.GOOGLE_SHEET_ID, "e2e-sheets-token"]) {
    assert.equal(text.includes(secret), false, `${label}: the response carries ${secret}`);
  }
}

test("a signed check reads the sheet and answers each proposed row without writing", async () => {
  const d1Before = await d1Contents();
  const gridsBefore = grids();

  const answer = await checked({
    Models: [ADV_160],
    Vehicles: [vehicle("わ9998", "adv-160"), vehicle("わ1002", "pcx-125"), vehicle("わ9999", "pcx-125")],
  });

  const shown = JSON.stringify(answer);
  assert.deepEqual(answer.fatal, [], shown);
  assert.deepEqual(levels(answer, "Models"), ["warning"], shown);
  assert.ok(says(answer.rows.Models?.[0], "name_ja", "missing translation"), shown);
  assert.deepEqual(levels(answer, "Vehicles"), ["ok", "error", "ok"], shown);
  assert.deepEqual(answer.rows.Vehicles?.[0], { level: "ok", messages: [] }, shown);
  assert.ok(says(answer.rows.Vehicles?.[1], "plate", "repeats an earlier row"), shown);
  for (const tab of CATALOG_TABS.filter((tab) => tab !== "Models" && tab !== "Vehicles")) {
    assert.deepEqual(answer.rows[tab] ?? [], [], `${tab}: ${shown}`);
  }
  assert.equal(sheets.count("batchGet"), 1, "the sheet is read once");
  await assertNothingWritten(d1Before, gridsBefore, "the first check");

  // Each check reads the sheet as it is then: once its pcx-125 row is broken, the same vehicle is an error.
  const broken = validWorkbook();
  setCell(broken, "Models", "pcx-125", "engine_cc", "abc");
  sheets = createFakeSheets(broken);
  const again = await checked({ Vehicles: [vehicle("わ9999", "pcx-125")] });
  assert.deepEqual(levels(again, "Vehicles"), ["error"], JSON.stringify(again));
  assert.ok(says(again.rows.Vehicles?.[0], "model_id", "has no valid row in Models"), JSON.stringify(again));
  await assertNothingWritten(d1Before, grids(), "the second check");

  // A sheet with a fatal problem answers its reasons and checks no row.
  const fatal: Workbook = validWorkbook();
  removeColumn(fatal, "Types", "sort");
  sheets = createFakeSheets(fatal);
  const stopped = await checked({ Vehicles: [vehicle("わ9999", "pcx-125")] });
  assert.ok(stopped.fatal.some((reason) => /Types.*sort/.test(reason)), JSON.stringify(stopped));
  assert.deepEqual(stopped.rows, {});
  await assertNothingWritten(d1Before, grids(), "the fatal check");
});

test("unsigned, tampered and stale requests get 401 before any Google call", async () => {
  const PAYLOAD = { rows: { Vehicles: [vehicle("わ9999", "pcx-125")] } };
  const good = () => envelope(SECRET, PAYLOAD);
  const flipped = (sig: string) => `${sig[0] === "0" ? "1" : "0"}${sig.slice(1)}`;
  const without = (field: "ts" | "payload" | "sig") => {
    const { [field]: _dropped, ...rest } = good();
    return JSON.stringify(rest);
  };
  const forged = JSON.stringify({ rows: { Vehicles: [vehicle("わ6666", "pcx-125")] } });

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
    ["signed with the mail secret", () => JSON.stringify(envelope(testVars.MAIL_SECRET, PAYLOAD))],
    ["payload changed after signing", () => JSON.stringify({ ...good(), payload: forged })],
    ["ts changed after signing", () => JSON.stringify({ ...good(), ts: Date.now() + 1000 })],
    ["one sig character changed", () => JSON.stringify({ ...good(), sig: flipped(good().sig) })],
    ["a cut-off sig", () => JSON.stringify({ ...good(), sig: good().sig.slice(0, 32) })],
    ["stale by ten minutes", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - 10 * MINUTE_MS))],
    ["stale by a day", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() - 1440 * MINUTE_MS))],
    ["ten minutes in the future", () => JSON.stringify(envelope(SECRET, PAYLOAD, Date.now() + 10 * MINUTE_MS))],
  ];

  for (const [name, body] of REFUSED) {
    const res = await post(body());
    assert.equal(res.status, 401, name);
    assert.deepEqual(await res.json(), { error: "unauthorized" }, name);
  }
  assert.deepEqual(outboundRequests, [], "a refused request reached Google");
  assert.deepEqual(sheets.calls, []);

  // The same signing with the right secret gets through, so what turned those down was the signature check.
  const answer = await checked(PAYLOAD.rows);
  assert.deepEqual(answer.rows.Vehicles, [{ level: "ok", messages: [] }]);
});

test("a body over 64 KB gets 413 and an empty PUBLISH_SECRET gets 500, before any Google call", async () => {
  const TOO_LARGE = "The request is too large.";

  /** A good envelope of exactly `bytes`, its one proposed vehicle's notes padded with "x". */
  const sized = (bytes: number): string => {
    const ts = Date.now();
    const body = (notes: string) =>
      JSON.stringify(envelope(SECRET, { rows: { Vehicles: [vehicle("わ9999", "pcx-125", { notes })] } }, ts));
    const text = body("x".repeat(bytes - Buffer.byteLength(body(""))));
    assert.equal(Buffer.byteLength(text), bytes);
    return text;
  };

  const SENDS: [string, (body: string) => Promise<Response>][] = [
    ["as a string", (body) => post(body)],
    ["with a Content-Length", postWithLength],
  ];
  // Signed, so only the limit can refuse them, and one byte over 64 KiB, the larger reading of 64 KB.
  const BODIES: [string, string][] = [
    ["a signed envelope one byte past 64 KiB", sized(65_537)],
    ["a signed envelope of 100,000 bytes", sized(100_000)],
    ["junk", "x".repeat(70_000)],
  ];
  for (const [name, body] of BODIES) {
    for (const [how, send] of SENDS) {
      const label = `${name} ${how}`;
      const res = await send(body);
      assert.equal(res.status, 413, label);
      assert.equal(await res.text(), TOO_LARGE, label);
    }
  }
  assert.deepEqual(outboundRequests, [], "a refused request reached Google");

  // 64,000 bytes is within the limit on either reading.
  for (const [how, send] of SENDS) {
    const res = await send(sized(64_000));
    const text = await res.text();
    assert.equal(res.status, 200, `${how}: ${text}`);
    assert.deepEqual((JSON.parse(text) as CheckAnswer).rows.Vehicles, [{ level: "ok", messages: [] }], how);
  }

  // A Worker with no secret refuses everyone, even a body signed with the key anyone can compute for it.
  const CASES: [string, string | undefined][] = [
    ["empty", ""],
    ["unset", undefined],
  ];
  for (const [name, secret] of CASES) {
    const requests: string[] = [];
    const lonely = await startWorker({
      vars: { GOOGLE_SA_PRIVATE_KEY: GOOGLE_PRIVATE_KEY, PUBLISH_SECRET: secret },
      outbound: (request) => {
        requests.push(`${request.method} ${request.url}`);
        return sheetsApi(request);
      },
    });
    try {
      for (const key of ["", "undefined"]) {
        const label = `${name}, signed with ${JSON.stringify(key)}`;
        const body = JSON.stringify(envelope(key, { rows: { Vehicles: [vehicle("わ9999", "pcx-125")] } }));
        const res = await post(body, lonely);
        const text = await res.text();
        assert.equal(res.status, 500, label);
        assertPlainWords(text, label);
        assert.doesNotMatch(text, /DataError|HMAC|importKey|key length/i, label);
      }
      assert.deepEqual(requests, [], `${name}: a request reached Google`);
    } finally {
      await lonely.stop();
    }
  }
});

test("a payload of the wrong shape gets 400 in plain words", async () => {
  const rowsOf = (count: number) => Array.from({ length: count }, (_, index) => vehicle(`わ${8000 + index}`, "pcx-125"));
  const PAYLOADS: [string, unknown][] = [
    ["a number", 42],
    ["a string", "rows"],
    ["null", null],
    ["an array", [vehicle("わ9999", "pcx-125")]],
    ["no rows", {}],
    ["rows of null", { rows: null }],
    ["rows as an array", { rows: [vehicle("わ9999", "pcx-125")] }],
    ["rows as text", { rows: "Vehicles" }],
    ["a tab outside the catalog", { rows: { Bookings: [{ booking_ref: "X" }] } }],
    ["the Blocks tab", { rows: { Blocks: [{ block_id: "BLK-9" }] } }],
    ["a tab of one object", { rows: { Vehicles: vehicle("わ9999", "pcx-125") } }],
    ["a row of null", { rows: { Vehicles: [null] } }],
    ["a row of a string", { rows: { Vehicles: ["わ9999"] } }],
    ["a null value", { rows: { Vehicles: [{ plate: "わ9999", model_id: null }] } }],
    ["an object value", { rows: { Vehicles: [{ plate: { text: "わ9999" } }] } }],
    ["51 rows", { rows: { Vehicles: rowsOf(51) } }],
  ];

  for (const [name, payload] of PAYLOADS) {
    const res = await signedPost(payload);
    const text = await res.text();
    assert.equal(res.status, 400, `${name}: ${text}`);
    assertPlainWords(text, name);
  }
  assert.equal(sheets.count("batchGet"), 0, "a payload of the wrong shape had the sheet read");

  // 50 rows are within the limit.
  const answer = await checked({ Vehicles: rowsOf(50) });
  assert.deepEqual(levels(answer, "Vehicles"), rowsOf(50).map(() => "ok"));
});

test("a Sheets failure answers 502 in plain words", async () => {
  const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${testVars.GOOGLE_SHEET_ID}`;
  const quoted = (status: number) =>
    Response.json(
      { error: { code: status, message: `${UPSTREAM} ${sheetUrl}/values:batchGet`, status: "REFUSED" } },
      { status },
    );
  // Statuses the client does not retry, so nothing waits for backoff.
  const FAULTS: [string, () => Response][] = [
    ["batchGet forbidden", () => quoted(403)],
    ["batchGet not found", () => new Response(`${UPSTREAM} at ${sheetUrl}`, { status: 404 })],
    ["batchGet refused as malformed", () => quoted(400)],
    ["a batchGet reply of the wrong shape", () => Response.json({ detail: `${UPSTREAM} ${sheetUrl}` })],
  ];
  const d1Before = await d1Contents();
  const gridsBefore = grids();

  for (const [name, fault] of FAULTS) {
    readFault = fault;
    const res = await signedPost({ rows: { Vehicles: [vehicle("わ9999", "pcx-125")] } });
    const text = await res.text();
    assert.equal(res.status, 502, `${name}: ${text}`);
    assertPlainWords(text, name);
    await assertNothingWritten(d1Before, gridsBefore, name);
  }
  assert.ok(outboundRequests.some((line) => line.includes("values:batchGet")), "the sheet was never asked for");

  // The same Worker answers once Sheets is back, so what failed was Sheets.
  readFault = null;
  const answer = await checked({ Vehicles: [vehicle("わ9999", "pcx-125")] });
  assert.deepEqual(answer.rows.Vehicles, [{ level: "ok", messages: [] }]);
});
