// The daily cron through the built Worker: the `0 18 * * *` scheduled event runs the daily check against the real
// (Miniflare) D1, with Google's token and Sheets endpoints answered from a FakeSheets and Square's list endpoints faked in
// `outbound`, so these assert on cells, outbox rows and the cron_runs row. The rules of each check are
// tests/reconcile-sheet.test.ts and tests/cron-daily.test.ts: here is that the Worker wires them together.
//
// Rulings this file pins where the ticket is silent:
// - The job reads STAFF_EMAIL for the report's address, and runs with `now` at the scheduled time (the run row's run_at is
//   that minute, in JST).
// - The whole invocation, the token exchange included, makes fewer than 40 outbound requests.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { BOOKINGS_COLUMNS, SHEET_TABS } from "../../src/lib/catalog/sheet-schema.ts";
import { at, expectedCells, isBlank, jstDate, named, rowUnder, schemaCells } from "../helpers/bookings-tab.ts";
import { fakeGoogleSheets } from "../helpers/fake-google.ts";
import { createFakeSheets, type FakeSheets } from "../helpers/fake-sheets.ts";
import { seedBooking, seedCatalogMeta, seedConfig, seedModel, seedTiers, seedVehicle, type BookingRow } from "../helpers/seed.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const CRON = "0 18 * * *";
const SQUARE_HOST = "https://connect.squareupsandbox.com";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BOOKINGS_HEADER: string[] = [...BOOKINGS_COLUMNS];
const RECON_HEADER: string[] = [...SHEET_TABS.Reconciliation];
const STAFF_EMAIL = `daily-${randomUUID().slice(0, 8)}@example.com`;

// The service account signs for real inside the Worker, so the placeholder key in testVars will not do.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** What the fake sheet holds. The test sets it before the run. */
let sheet: FakeSheets = createFakeSheets({ Bookings: [[...BOOKINGS_HEADER]], Reconciliation: [[...RECON_HEADER]] });
/** Square's payments as its API writes them. */
const squarePayments: Record<string, unknown>[] = [];
const outboundRequests: string[] = [];
const google = fakeGoogleSheets(() => sheet, testVars.GOOGLE_SHEET_ID);

/** Square's two list endpoints, one page each; anything else is not served. */
function square(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.origin !== SQUARE_HOST) return null;
  if (request.method === "GET" && url.pathname === "/v2/payments") {
    return Response.json(squarePayments.length > 0 ? { payments: squarePayments } : {});
  }
  if (request.method === "GET" && url.pathname === "/v2/refunds") return Response.json({});
  return Response.json(
    { errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND", detail: "not served in this test" }] },
    { status: 404 },
  );
}

async function outbound(request: Request): Promise<Response> {
  outboundRequests.push(`${request.method} ${request.url}`);
  return square(request) ?? google(request);
}

let worker: TestWorker;

before(async () => {
  worker = await startWorker({ vars: { GOOGLE_SA_PRIVATE_KEY: privateKey, STAFF_EMAIL }, outbound });
  await seedConfig(worker.db);
  await seedCatalogMeta(worker.db);
  await seedTiers(worker.db);
});

after(async () => {
  await worker?.stop();
});

/** Polls `read` until it returns a value, for up to `timeoutMs`. */
async function poll<T>(read: () => Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`nothing arrived within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function rowsOf(id: string): number[] {
  return sheet.grid("Bookings").flatMap((row, i) => (i > 0 && named(BOOKINGS_HEADER, row).booking_id === id ? [i] : []));
}

test("the daily cron runs on the built Worker", async () => {
  const { db } = worker;
  const scheduledTime = Date.now();
  const model = await seedModel(db);
  const plates: string[] = [];
  for (let n = 0; n < 3; n += 1) {
    plates.push((await seedVehicle(db, { plate: `わ${randomUUID().slice(0, 4)}-${n}`, model_id: model.id })).plate);
  }
  const hour = Math.floor(scheduledTime / HOUR_MS) * HOUR_MS;
  const book = (n: number, days: number): Promise<BookingRow> =>
    seedBooking(db, {
      id: randomUUID(),
      ref: `OD-${randomUUID().slice(0, 8).toUpperCase()}`,
      vehicle_plate: plates[n],
      model_id: model.id,
      start_at: hour + days * DAY_MS,
      end_at: hour + days * DAY_MS + 8 * HOUR_MS,
      created_at: scheduledTime - 3 * DAY_MS,
      updated_at: scheduledTime - 3 * DAY_MS + HOUR_MS,
      price_jpy: 6000 + 100 * n,
      paid_jpy: 5000,
    });

  // On the tab: one row in sync, one the sync never updated, and one D1 never had. One booking is not on it at all.
  const inSync = await book(0, 5);
  const stale = await book(1, 8);
  const staleRow = rowUnder(BOOKINGS_HEADER, expectedCells(stale));
  await db
    .prepare("UPDATE bookings SET guest_phone = ?1, updated_at = ?2 WHERE id = ?3")
    .bind("+81-80-4444-0202", scheduledTime - DAY_MS, stale.id)
    .run();
  const missing = await book(2, 12);
  const ghost = { id: randomUUID(), ref: `OD-${randomUUID().slice(0, 8).toUpperCase()}` };
  const inSyncRow = rowUnder(BOOKINGS_HEADER, expectedCells(inSync));
  const ghostRow = rowUnder(BOOKINGS_HEADER, expectedCells({ ...inSync, ...ghost }));
  const oldReport = Array.from({ length: 6 }, (_, r) => RECON_HEADER.map((_, c) => `old ${r}/${c}`));
  sheet = createFakeSheets({
    Bookings: [BOOKINGS_HEADER, inSyncRow, staleRow, ghostRow],
    Reconciliation: [RECON_HEADER, ...oldReport],
  });

  // Square: a Dashboard sale two days ago that names no booking.
  const strayId = `pay-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const strayAmount = randomInt(1000, 20_000);
  const strayAt = new Date(scheduledTime - 2 * DAY_MS).toISOString();
  squarePayments.push({
    id: strayId,
    status: "COMPLETED",
    amount_money: { amount: strayAmount, currency: "JPY" },
    location_id: testVars.SQUARE_LOCATION_ID,
    created_at: strayAt,
    updated_at: strayAt,
  });

  await worker.scheduled(CRON, scheduledTime);
  const run = await poll(() =>
    db
      .prepare("SELECT cron, status, detail FROM cron_runs WHERE scheduled_at = ?1")
      .bind(scheduledTime)
      .first<{ cron: string; status: string; detail: string | null }>(),
  );
  assert.deepEqual(run, { cron: CRON, status: "ok", detail: null });
  const finished = Date.now();

  // The Bookings tab is repaired, and the row D1 never had is still there.
  const grid = sheet.grid("Bookings");
  assert.deepEqual(grid.slice(0, 4).map((row, i) => (i === 2 ? null : row)), [BOOKINGS_HEADER, inSyncRow, null, ghostRow]);
  assert.deepEqual(rowsOf(stale.id), [2]);
  const storedStale = await db.prepare("SELECT * FROM bookings WHERE id = ?1").bind(stale.id).first<BookingRow>();
  assert.ok(storedStale);
  assert.deepEqual(schemaCells(named(BOOKINGS_HEADER, grid[2])), expectedCells(storedStale));
  const appended = rowsOf(missing.id);
  assert.equal(appended.length, 1, "the missing booking is appended");
  assert.deepEqual(schemaCells(named(BOOKINGS_HEADER, grid[appended[0]])), expectedCells(missing));

  // The Reconciliation tab is rewritten: header, run row, and one row per issue of both checks.
  const report = sheet.grid("Reconciliation").filter((row) => !isBlank(row));
  assert.deepEqual(report[0].slice(0, RECON_HEADER.length), RECON_HEADER);
  const runRow = named(RECON_HEADER, report[1]);
  assert.match(String(runRow.run_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "run_at is a JST wall clock");
  const ranAt = at(String(runRow.run_at).slice(0, 16));
  assert.ok(ranAt >= scheduledTime - MINUTE_MS && ranAt <= finished + MINUTE_MS, `run_at ${String(runRow.run_at)}`);
  assert.equal(runRow.type, "");
  const issues = report.slice(2).map((row) => {
    const cells = named(RECON_HEADER, row);
    return [cells.type, cells.booking_ref, cells.payment_id, cells.actual_jpy];
  });
  assert.deepEqual(
    issues.sort(),
    [
      ["payment_without_booking", "", strayId, strayAmount],
      ["unknown_sheet_row", ghost.ref, "", ""],
    ].sort(),
    "the stray payment and the unknown row, and nothing of the old report",
  );

  // The day's report is queued for staff.
  const { results: queued } = await db
    .prepare("SELECT kind, dedupe_key, payload FROM outbox WHERE dedupe_key LIKE 'email:reconcile_report:%'")
    .all<{ kind: string; dedupe_key: string; payload: string }>();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "email");
  assert.ok(
    [jstDate(scheduledTime), jstDate(finished)].map((date) => `email:reconcile_report:${date}`).includes(queued[0].dedupe_key),
    queued[0].dedupe_key,
  );
  const payload = JSON.parse(queued[0].payload) as { template: string; to: string; data: { issues: unknown[] } };
  assert.equal(payload.template, "reconcile_report");
  assert.equal(payload.to, STAFF_EMAIL);
  assert.equal(payload.data.issues.length, 2);

  assert.ok(outboundRequests.some((line) => line.includes("/v2/payments")), "Square was asked");
  assert.ok(outboundRequests.length < 40, `${outboundRequests.length} outbound requests`);
});
