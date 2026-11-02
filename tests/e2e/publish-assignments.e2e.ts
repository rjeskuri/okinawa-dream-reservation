// The assignments step of Publish, through the built Worker: a signed POST reads the Bookings tab, moves the bookings
// staff overrode in the real (Miniflare) D1, and writes the results back to the sheet. Google is faked in `outbound` and
// the tab is a FakeSheets, so these assert on cells and rows. Bodies are signed here with node:crypto, the way the Apps
// Script side signs them. The rules of an override are tests/overrides.test.ts: here is what the route adds to them.
//
// Rulings these tests pin where the ticket is silent:
// - The answer is `{ applied, errors }`: `applied` is how many bookings moved, and `errors` lists `{ row, message }`,
//   the sheet row and what override_status says, which is what the fake answers of task #16 hold.
// - A touched row is one with a result. A blank override cell, a blank row and a row that matches the stored plate are
//   not touched: none of their cells is written and they count for nothing, so a rerun of Publish changes nothing.
// - "Matches" means the plate in D1, not the plate cell, which can lag behind it.
// - Only plate and override_status are written, by a batchUpdate, and plate only on a move.
// - An override cell is read by the sheet's rules for every tab (docs/sheet-schema.md): a number is text, spaces around
//   a value go, and full-width characters match their half-width forms. That is where Vehicles plates come from.
// - Columns are found by header, as for the Bookings sync, and a tab without a column this step needs moves nothing.
// - A row with an override and a blank booking_id is reported as an unknown booking in its override_status, counts in
//   `errors` and moves nothing. A blank override cell is still skipped silently, whatever else the row holds.
// - When writing the cells fails, the route answers 5xx, the booking stays moved, and the next Publish sees a no-op for
//   that row. So its cells stay as they were until the Bookings sync writes the plate.
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { after, before, test } from "node:test";
import { BOOKINGS_COLUMNS } from "../../src/lib/catalog/sheet-schema.ts";
import { fakeGoogleSheets } from "../helpers/fake-google.ts";
import { createFakeSheets, type FakeSheets } from "../helpers/fake-sheets.ts";
import {
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedVehicle,
  type BookingRow,
  type VehicleRow,
} from "../helpers/seed.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const PATH = "/api/publish/assignments";
const DAY_MS = 86_400_000;
const TEN_MINUTES_MS = 600_000;
/** A Worker's clock stands still between I/O, so it can read a little behind the test's. */
const CLOCK_SLACK_MS = 5000;
const WRITABLE = ["plate", "override_status"];

// The service account signs for real inside the Worker, so the placeholder key in testVars will not do.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

type Cell = string | number;
type Named = Record<string, Cell>;
type SyncResponse = { applied: number; errors: { row: number; message: string }[] };

/** What the fake sheet holds. Each test sets it. */
let sheet: FakeSheets = createFakeSheets({ Bookings: [] });
/** While true, Google answers a batchUpdate with a 503. */
let batchUpdateDown = false;
const outboundRequests: string[] = [];

let worker: TestWorker;

before(async () => {
  const google = fakeGoogleSheets(
    () => sheet,
    testVars.GOOGLE_SHEET_ID,
    () => batchUpdateDown,
  );
  worker = await startWorker({
    vars: { GOOGLE_SA_PRIVATE_KEY: privateKey },
    outbound: (request) => {
      outboundRequests.push(`${request.method} ${request.url}`);
      return google(request);
    },
  });
  await seedConfig(worker.db);
  await seedCatalogMeta(worker.db);
});

after(async () => {
  await worker?.stop();
});

function signature(secret: string, ts: number, payload: string): string {
  return createHmac("sha256", secret).update(`${ts}.${payload}`, "utf8").digest("hex");
}

function signedBody(secret = testVars.PUBLISH_SECRET, ts = Date.now(), payload = '{"requestedBy":"staff@example.com"}'): string {
  return JSON.stringify({ ts, payload, sig: signature(secret, ts, payload) });
}

function postSync(body?: string): Promise<Response> {
  return worker.fetch(PATH, { method: "POST", headers: { "content-type": "application/json" }, body });
}

async function signedSync(): Promise<SyncResponse> {
  const res = await postSync(signedBody());
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as SyncResponse;
}

/** A model of its own with helpers for its bikes and rentals, so that no test can see another's bookings. */
async function fleet() {
  const { db } = worker;
  const model = await seedModel(db);
  const bike = async (partial: Partial<VehicleRow> = {}): Promise<string> =>
    (await seedVehicle(db, { model_id: model.id, ...partial })).plate;
  const rental = async (partial: Partial<BookingRow> = {}): Promise<BookingRow> =>
    seedBooking(db, { vehicle_plate: await bike(), model_id: model.id, ...partial });
  return { model, bike, rental };
}

/** A booking's cells as the Bookings sync leaves them, with what staff typed over them. */
function rowOf(b: BookingRow, cells: Named = {}): Named {
  return {
    booking_ref: b.ref,
    booking_id: b.id,
    status: b.status,
    source: b.source,
    model_id: b.model_id,
    plate: b.vehicle_plate,
    override_plate: "",
    override_status: "",
    guest_email: b.guest_email ?? "",
    price_jpy: b.price_jpy ?? 0,
    paid_jpy: b.paid_jpy,
    ...cells,
  };
}

/** Puts this tab on a new fake sheet. A null is a blank row. `headers` is what is typed over the layout's columns. */
function openSheet(rows: (Named | null)[], layout: readonly string[] = BOOKINGS_COLUMNS, headers = layout): void {
  sheet = createFakeSheets({
    Bookings: [[...headers], ...rows.map((row) => (row === null ? [] : layout.map((name) => row[name] ?? "")))],
  });
}

/** Rows and columns here are the sheet's: the header is row 1. */
function cell(row: number, name: string, layout: readonly string[] = BOOKINGS_COLUMNS): unknown {
  return sheet.grid("Bookings")[row - 1]?.[layout.indexOf(name)] ?? "";
}

/** The names of the columns of a row that differ between two grids. */
function changedColumns(earlier: unknown[][], row: number, layout: readonly string[] = BOOKINGS_COLUMNS): string[] {
  const now = sheet.grid("Bookings")[row - 1] ?? [];
  return layout.filter((_, col) => String(earlier[row - 1]?.[col] ?? "") !== String(now[col] ?? ""));
}

async function stored(id: string): Promise<BookingRow> {
  const row = await worker.db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<BookingRow>();
  assert.ok(row, `booking ${id} is in D1`);
  return row;
}

/** The booking is on `plate`, stamped by the Worker since `since`, and nothing else about it changed. */
async function assertMoved(booking: BookingRow, plate: string, since: number, label: string): Promise<void> {
  const row = await stored(booking.id);
  assert.ok(row.updated_at >= since - CLOCK_SLACK_MS, `${label}: updated_at`);
  assert.deepEqual(row, { ...booking, vehicle_plate: plate, updated_at: row.updated_at }, label);
}

async function assertKept(booking: BookingRow, label: string): Promise<void> {
  assert.deepEqual(await stored(booking.id), booking, label);
}

test("signed assignment sync writes override_status back", async () => {
  const { bike, rental } = await fleet();
  const otherModel = await seedModel(worker.db);
  const oldStatus = "the result of an older publish";

  const mover = await rental();
  const free = await bike();
  const refused = await rental();
  const taken = (await rental()).vehicle_plate;
  const quiet = await rental();
  const toWorkshop = await rental();
  const inWorkshop = await bike({ status: "maintenance" });
  const toNowhere = await rental();
  const toOtherModel = await rental();
  const foreign = (await seedVehicle(worker.db, { model_id: otherModel.id })).plate;
  const settled = await rental();
  const ended = await rental({ start_at: Date.now() - 3 * DAY_MS, end_at: Date.now() - 2 * DAY_MS });
  const cancelled = await rental({ status: "CANCELLED" });
  const spare = await bike();
  const firstRival = await rental();
  const secondRival = await rental();
  const wanted = await bike();
  const lagging = await rental();
  const laggingTarget = await bike();
  const laggingSettled = await rental();

  openSheet([
    /* row 2 */ rowOf(mover, { override_plate: free, override_status: oldStatus }),
    /* row 3 */ rowOf(refused, { override_plate: taken }),
    /* row 4 */ rowOf(quiet, { override_status: oldStatus }),
    /* row 5 */ null,
    /* row 6 */ rowOf(toWorkshop, { override_plate: inWorkshop, override_status: oldStatus }),
    /* row 7 */ rowOf(toNowhere, { override_plate: "no-such-plate" }),
    /* row 8 */ rowOf(toOtherModel, { override_plate: foreign }),
    /* row 9 */ rowOf(settled, { override_plate: settled.vehicle_plate, override_status: oldStatus }),
    /* row 10 */ rowOf(ended, { override_plate: spare }),
    /* row 11 */ rowOf(cancelled, { override_plate: spare }),
    /* row 12 */ rowOf(quiet, { booking_id: "no-such-booking", booking_ref: "OD-NONE", override_plate: spare }),
    /* row 13 */ rowOf(firstRival, { override_plate: wanted }),
    /* row 14 */ rowOf(secondRival, { override_plate: wanted }),
    // The plate cell lags D1 in both of these: the first still has to move, and the second has nothing to do.
    /* row 15 */ rowOf(lagging, { plate: laggingTarget, override_plate: laggingTarget }),
    /* row 16 */ rowOf(laggingSettled, { plate: "an-older-plate", override_plate: laggingSettled.vehicle_plate }),
  ]);
  const original = sheet.grid("Bookings");
  const since = Date.now();

  const result = await signedSync();

  // The bookings.
  await assertMoved(mover, free, since, "the valid override");
  await assertMoved(firstRival, wanted, since, "the higher of two competing rows");
  await assertMoved(lagging, laggingTarget, since, "the row whose plate cell lags");
  const kept = { refused, toWorkshop, toNowhere, toOtherModel, ended, cancelled, secondRival, quiet, settled, laggingSettled };
  for (const [label, booking] of Object.entries(kept)) await assertKept(booking, label);

  // The answer.
  const errorRows = [3, 6, 7, 8, 10, 11, 12, 14];
  assert.equal(result.applied, 3);
  assert.deepEqual(result.errors.map(({ row }) => row).sort((a, b) => a - b), errorRows);

  // The cells of the touched rows.
  assert.deepEqual(changedColumns(original, 2), ["plate", "override_status"]);
  assert.equal(cell(2, "plate"), free);
  assert.deepEqual(changedColumns(original, 13), ["plate", "override_status"]);
  assert.equal(cell(13, "plate"), wanted);
  assert.deepEqual(changedColumns(original, 15), ["override_status"], "the plate cell already said so");
  for (const row of [2, 13, 15]) assert.ok(String(cell(row, "override_status")).trim() !== "", `row ${row}`);

  const messages = new Map(result.errors.map(({ row, message }) => [row, message]));
  for (const row of errorRows) {
    assert.deepEqual(changedColumns(original, row), ["override_status"], `row ${row}`);
    const status = cell(row, "override_status");
    assert.ok(typeof status === "string" && status.trim() !== "", `row ${row}`);
    assert.equal(messages.get(row), status, `row ${row}: the answer and the cell say the same`);
  }

  // Everything else.
  for (const row of [1, 4, 5, 9, 16]) assert.deepEqual(changedColumns(original, row), [], `row ${row}`);
  assert.deepEqual(sheet.writes.filter(({ col }) => !WRITABLE.includes(BOOKINGS_COLUMNS[col])), [], "no other column is written");
  assert.deepEqual(sheet.writes.filter(({ tab, via }) => tab !== "Bookings" || via !== "batchUpdate"), []);
  assert.equal(sheet.count("append"), 0);
  assert.equal(sheet.grid("Bookings").length, original.length);

  // Publish runs again with the sheet as it now stands: the moves are done, and the refused rows are refused again.
  const afterFirst = sheet.grid("Bookings");
  const movedAt = (await stored(mover.id)).updated_at;
  sheet.writes.length = 0;

  const again = await signedSync();

  assert.equal(again.applied, 0);
  assert.deepEqual(again.errors.map(({ row }) => row).sort((a, b) => a - b), errorRows);
  assert.deepEqual(sheet.grid("Bookings"), afterFirst);
  assert.deepEqual(sheet.writes.filter(({ row }) => [2, 13, 15].includes(row + 1)), [], "a done move is not written again");
  assert.equal((await stored(mover.id)).updated_at, movedAt);
  assert.equal((await stored(mover.id)).vehicle_plate, free);
});

test("the columns of the Bookings tab are found by their headers", async () => {
  const { bike, rental } = await fleet();
  const mover = await rental();
  const free = await bike();
  const refused = await rental();
  const taken = (await rental()).vehicle_plate;

  // Shuffled, with staff columns among them, and the headers typed loosely, as docs/sheet-schema.md allows.
  const reversed = [...BOOKINGS_COLUMNS].reverse();
  const layout = ["notes", ...reversed.slice(9), "who_called", ...reversed.slice(0, 9), "memo"];
  const headers = layout.map((name, i) => (i % 2 === 0 ? ` ${name.toUpperCase()} ` : name));
  assert.notEqual(layout.indexOf("override_plate"), BOOKINGS_COLUMNS.indexOf("override_plate"));
  assert.notEqual(layout.indexOf("plate"), BOOKINGS_COLUMNS.indexOf("plate"));
  assert.notEqual(layout.indexOf("booking_id"), BOOKINGS_COLUMNS.indexOf("booking_id"));
  const staff = { notes: "ring first", who_called: "Mei", memo: "ok" };
  openSheet(
    [rowOf(mover, { override_plate: free, ...staff }), rowOf(refused, { override_plate: taken, ...staff })],
    layout,
    headers,
  );
  const original = sheet.grid("Bookings");
  const since = Date.now();

  const result = await signedSync();

  assert.equal(result.applied, 1);
  assert.deepEqual(result.errors.map(({ row }) => row), [3]);
  await assertMoved(mover, free, since, "the valid override");
  await assertKept(refused, "the busy bike");

  assert.deepEqual(changedColumns(original, 2, layout).sort(), ["override_status", "plate"]);
  assert.equal(cell(2, "plate", layout), free);
  assert.ok(String(cell(2, "override_status", layout)).trim() !== "");
  assert.deepEqual(changedColumns(original, 3, layout), ["override_status"]);
  assert.ok(String(cell(3, "override_status", layout)).trim() !== "");
  assert.deepEqual(sheet.grid("Bookings")[0], original[0], "the header row");
});

test("an override cell is read by the sheet's rules for text", async () => {
  const { bike, rental } = await fleet();

  // What the Sheets API sends for what staff typed, and the plate Publish stored for the Vehicles row.
  const typed: { label: string; plate: string; typed: Cell }[] = [
    { label: "digits, which the API sends as a number", plate: "2002", typed: 2002 },
    { label: "full-width letters and digits", plate: "PCX-9", typed: "ＰＣＸ－９" },
    { label: "full-width digits after a kana", plate: "わ5678", typed: "わ５６７８" },
    { label: "spaces around it, the wide one too", plate: "わ5679", typed: "　わ5679 " },
  ];
  const rows: Named[] = [];
  const moves: { label: string; booking: BookingRow; plate: string }[] = [];
  for (const { label, plate, typed: override_plate } of typed) {
    await bike({ plate });
    const booking = await rental();
    moves.push({ label, booking, plate });
    rows.push(rowOf(booking, { override_plate }));
  }

  // A plate of digits matches itself, and a cell of nothing but spaces is a blank cell.
  const digits = await rental({ vehicle_plate: await bike({ plate: "3003" }) });
  const blank = await rental();
  rows.push(rowOf(digits, { override_plate: 3003 }), rowOf(blank, { override_plate: "　 " }));
  openSheet(rows);
  const original = sheet.grid("Bookings");
  const since = Date.now();

  const result = await signedSync();

  assert.deepEqual(result.errors, []);
  assert.equal(result.applied, typed.length);
  for (const [i, { label, booking, plate }] of moves.entries()) {
    await assertMoved(booking, plate, since, label);
    assert.equal(String(cell(i + 2, "plate")), plate, label);
  }
  await assertKept(digits, "a matching number");
  await assertKept(blank, "a cell of spaces");
  for (const row of [typed.length + 2, typed.length + 3]) assert.deepEqual(changedColumns(original, row), [], `row ${row}`);
});

test("a tab with nothing to do writes nothing", async () => {
  const { rental } = await fleet();
  const tabs: [string, (Named | null)[]][] = [
    ["a header and no rows", []],
    ["no override typed", [rowOf(await rental()), null, rowOf(await rental(), { override_status: "kept" })]],
  ];
  for (const [label, rows] of tabs) {
    openSheet(rows);
    const original = sheet.grid("Bookings");

    assert.deepEqual(await signedSync(), { applied: 0, errors: [] }, label);

    assert.equal(sheet.count("batchUpdate") + sheet.count("append"), 0, `${label}: an empty write is refused by Google`);
    assert.deepEqual(sheet.grid("Bookings"), original, label);
  }
});

test("a tab without a column it needs moves nothing and writes nothing", async () => {
  for (const missing of ["booking_id", "plate", "override_plate", "override_status"]) {
    const { bike, rental } = await fleet();
    const booking = await rental();
    const plate = await bike();
    const row = rowOf(booking, { override_plate: plate });
    openSheet(
      [row],
      BOOKINGS_COLUMNS.filter((name) => name !== missing),
    );
    const original = sheet.grid("Bookings");

    const res = await postSync(signedBody());
    const text = await res.text();

    assert.ok(res.status >= 400 || (JSON.parse(text) as SyncResponse).errors.length > 0, `${missing}: staff are told: ${text}`);
    await assertKept(booking, missing);
    assert.equal(sheet.writes.length, 0, missing);
    assert.deepEqual(sheet.grid("Bookings"), original, missing);

    // The same row under every header goes through, so the refusal above was about the column.
    openSheet([row]);
    const since = Date.now();
    assert.equal((await signedSync()).applied, 1, missing);
    await assertMoved(booking, plate, since, missing);
  }
});

test("an override on a row with no booking id is reported as an unknown booking", async () => {
  const { bike, rental } = await fleet();
  const spare = await bike();
  const free = await bike();
  const blankId = await rental();
  const spacesForId = await rental();
  const toNowhere = await rental();
  const mover = await rental();
  const quiet = await rental();
  const oldStatus = "the result of an older publish";

  openSheet([
    /* row 2 */ rowOf(blankId, { booking_id: "", override_plate: spare }),
    /* row 3 */ rowOf(spacesForId, { booking_id: "　 ", override_plate: spare }),
    /* row 4 */ rowOf(toNowhere, { override_plate: "no-such-plate" }),
    /* row 5 */ rowOf(mover, { override_plate: free }),
    // A blank override cell is skipped, with or without a booking id.
    /* row 6 */ rowOf(quiet, { booking_id: "" }),
    /* row 7 */ rowOf(quiet, { booking_id: "", override_plate: "　 ", override_status: oldStatus }),
  ]);
  const original = sheet.grid("Bookings");
  const since = Date.now();

  const result = await signedSync();

  assert.equal(result.applied, 1);
  assert.deepEqual(result.errors.map(({ row }) => row).sort((a, b) => a - b), [2, 3, 4]);
  const messages = new Map(result.errors.map(({ row, message }) => [row, message]));
  for (const row of [2, 3]) {
    assert.deepEqual(changedColumns(original, row), ["override_status"], `row ${row}`);
    const status = cell(row, "override_status");
    assert.ok(typeof status === "string" && status.trim() !== "", `row ${row}`);
    assert.equal(messages.get(row), status, `row ${row}: the answer and the cell say the same`);
    assert.notEqual(status, messages.get(4), `row ${row}: this is about the booking, not the bike`);
  }

  await assertKept(blankId, "a blank booking id");
  await assertKept(spacesForId, "a booking id of spaces");
  await assertKept(quiet, "a row with nothing typed");
  await assertMoved(mover, free, since, "the row after them");
  const onSpare = await worker.db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE vehicle_plate = ?1")
    .bind(spare)
    .first<{ n: number }>();
  assert.equal(onSpare?.n, 0, "the spare bike stayed free");
  for (const row of [6, 7]) assert.deepEqual(changedColumns(original, row), [], `row ${row}`);
});

test("a failed write to the sheet leaves the move made, and the next Publish finds a no-op", async () => {
  const { bike, rental } = await fleet();
  const mover = await rental();
  const free = await bike();
  const refused = await rental();
  const taken = (await rental()).vehicle_plate;
  openSheet([rowOf(mover, { override_plate: free }), rowOf(refused, { override_plate: taken })]);
  const original = sheet.grid("Bookings");
  const writeAttempts = (): number => outboundRequests.filter((request) => request.includes(":batchUpdate")).length;
  const attemptsBefore = writeAttempts();
  const since = Date.now();

  batchUpdateDown = true;
  try {
    const res = await postSync(signedBody());
    await res.text();
    assert.ok(res.status >= 500 && res.status <= 599, `a failed write is a failed Publish, not a ${res.status}`);
  } finally {
    batchUpdateDown = false;
  }

  assert.ok(writeAttempts() > attemptsBefore, "the failure came from the write");
  await assertMoved(mover, free, since, "the move stands");
  await assertKept(refused, "the busy bike");
  assert.deepEqual(sheet.grid("Bookings"), original, "nothing reached the sheet");
  const movedAt = (await stored(mover.id)).updated_at;

  const again = await signedSync();

  assert.equal(again.applied, 0);
  assert.deepEqual(again.errors.map(({ row }) => row), [3], "the refused row is refused again");
  assert.equal(cell(3, "override_status"), again.errors[0].message);
  assert.deepEqual(changedColumns(original, 2), [], "a no-op is not touched");
  assert.deepEqual(changedColumns(original, 3), ["override_status"]);
  await assertMoved(mover, free, since, "the move still stands");
  assert.equal((await stored(mover.id)).updated_at, movedAt, "and was not made twice");
  await assertKept(refused, "the busy bike, again");
});

/** A valid override on a fresh tab, ready to go through for whoever signs the request properly. */
async function pendingOverride(): Promise<{ booking: BookingRow; plate: string; grid: unknown[][] }> {
  const { bike, rental } = await fleet();
  const booking = await rental();
  const plate = await bike();
  openSheet([rowOf(booking, { override_plate: plate })]);
  return { booking, plate, grid: sheet.grid("Bookings") };
}

test("an unsigned assignment sync gets 401 and changes nothing", async () => {
  const { booking, grid } = await pendingOverride();
  const calls = outboundRequests.length;

  const bodies: [string, string | undefined][] = [
    ["no body", undefined],
    ["an empty body", ""],
    ["not JSON", "assign please"],
    ["an empty object", "{}"],
    ["a payload with no signature", JSON.stringify({ ts: Date.now(), payload: "{}" })],
  ];
  for (const [label, body] of bodies) {
    const res = await postSync(body);
    await res.text();
    assert.equal(res.status, 401, label);
  }

  assert.equal(outboundRequests.length, calls, "an unsigned request reached Google");
  assert.equal(sheet.calls.length, 0, "an unsigned request read the sheet");
  assert.deepEqual(sheet.grid("Bookings"), grid);
  await assertKept(booking, "unsigned");
});

test("a tampered or stale signature on assignment sync gets 401", async () => {
  const { booking, plate, grid } = await pendingOverride();
  const calls = outboundRequests.length;

  const now = Date.now();
  const good = JSON.parse(signedBody(testVars.PUBLISH_SECRET, now)) as { ts: number; payload: string; sig: string };
  const bodies: [string, string][] = [
    ["signed with another secret", signedBody("not-the-publish-secret", now)],
    ["signed with the mail secret", signedBody(testVars.MAIL_SECRET, now)],
    ["a payload changed after signing", JSON.stringify({ ...good, payload: '{"requestedBy":"someone-else"}' })],
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
  assert.equal(sheet.calls.length, 0, "a badly signed request read the sheet");
  assert.deepEqual(sheet.grid("Bookings"), grid);
  await assertKept(booking, "badly signed");

  // The same signing with the right secret gets through, so the refusals above were about the signature.
  const since = Date.now();
  assert.equal((await signedSync()).applied, 1);
  await assertMoved(booking, plate, since, "properly signed");
  assert.equal(cell(2, "plate"), plate);
});
