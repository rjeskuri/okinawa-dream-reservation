// runDaily, src/lib/cron/daily.ts: the daily check runs reconcileSquare and reconcileSheet, rewrites the Reconciliation
// tab and queues one staff email a day when anything disagrees. A real in-memory D1, a fake SheetsClient that models the
// sheet, and Square faked at the SquareClient seam, the external things the ticket names. Every expected issue is worked
// out here from the seeded values, never by running reconcileSquare, reconcileSheet or the code under test.
//
// What the ticket leaves open and this file decides, each one a Ruling in the PR:
// - runDaily({ db, sheets, square, now, staffEmail }) resolves to { issues, emailed }: `issues` is how many issues the run
//   found, and `emailed` whether this run queued the report (false when the day's report was already queued).
// - The Reconciliation tab, as Set up tabs creates it, is: row 1 the header (SHEET_TABS.Reconciliation), row 2 the run
//   row (run_at the JST wall clock of `now` as text "YYYY-MM-DD HH:mm", counts what the run counted, any non-empty text,
//   and no type), then one row per issue with type, booking_ref, payment_id, refund_id, expected_jpy, actual_jpy and
//   detail. An absent field is an empty cell and an amount is an integer number. An issue row's run_at is empty or the
//   run's; its counts is free. Nothing else is left on the tab: a shorter report clears the rows of a longer one.
// - A dead outbox item is an issue row of type `dead_outbox_item` whose detail names the item's dedupe_key; it has no
//   payment, refund or amount, and its booking_ref is free. Items that are pending, sending or sent are not listed.
//   Whether dead items alone queue the email, and so whether `issues` counts them, is left open: no test here pins it.
// - The report is queued as kind email, template reconcile_report, to staffEmail, with data { runAt: now, issues }, under
//   dedupe key email:reconcile_report:{JST date of now}, so a second run the same JST day queues nothing.
// - runDaily runs reconcileSquare over its own default window (35 days, #43) and the sheet check over its 35 days: an
//   issue 30 to 35 days back is reported, and a booking that ended then is copied to the Bookings tab.
// - The budgets are for the whole cron invocation. runCron's cron_runs insert and the Google token cache's read and
//   write are three D1 queries outside runDaily, and the token exchange is one subrequest outside it, so runDaily alone
//   must stay under 45 - 3 queries and 40 - 1 subrequests. A subrequest is a Sheets call or a Square call.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { test } from "node:test";
import { BOOKINGS_COLUMNS, SHEET_TABS } from "../src/lib/catalog/sheet-schema.ts";
import type { SquareClient, SquareRecord, SquareTimeWindow } from "../src/lib/square/client.ts";
import {
  at,
  expectedCells,
  isBlank,
  jstDate,
  named,
  rowUnder,
  schemaCells,
  seedRefund,
  wall,
  type RefundFact,
} from "./helpers/bookings-tab.ts";
import { createTestDb } from "./helpers/d1.ts";
import { createFakeSheets, type FakeSheets } from "./helpers/fake-sheets.ts";
import {
  insertRow,
  seedBooking,
  seedCatalogMeta,
  seedConfig,
  seedModel,
  seedTiers,
  seedVehicle,
  type BookingRow,
} from "./helpers/seed.ts";

/** Loaded inside each test, after its fixtures, so a test fails on this module alone and a bad fixture shows first. */
const dailyModule = () => import("../src/lib/cron/daily.ts");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 03:00 JST, when the cron fires: 2030-05-31 18:00 UTC, so the UTC date is the day before. */
const NOW = at("2030-06-01 03:00");

const RECON_HEADER: string[] = [...SHEET_TABS.Reconciliation];
const BOOKINGS_HEADER: string[] = [...BOOKINGS_COLUMNS];

/** The whole invocation may make fewer than these; runCron and the Google token take the rest. */
const QUERY_LIMIT = 45;
const SUBREQUEST_LIMIT = 40;
const QUERIES_OUTSIDE = 3;
const SUBREQUESTS_OUTSIDE = 1;

type Daily = { issues: unknown; emailed: unknown };

/** The two fields the ticket names; anything else runDaily returns is its own business. */
function outcome({ issues, emailed }: Daily): Daily {
  return { issues, emailed };
}

type FakeSquare = { client: SquareClient; payments: SquareRecord[]; refunds: SquareRecord[]; calls: string[] };

/** Square as the test holds it, listing what was created inside the window. It never moves money. */
function fakeSquare(): FakeSquare {
  const payments: SquareRecord[] = [];
  const refunds: SquareRecord[] = [];
  const calls: string[] = [];
  const within = (record: SquareRecord, { beginTime, endTime }: SquareTimeWindow) => {
    const when = Date.parse(record.created_at ?? "");
    return when >= beginTime && when <= endTime;
  };
  const client: SquareClient = {
    async createPayment() {
      calls.push("createPayment");
      throw new Error("the daily run takes no payment");
    },
    async refundPayment() {
      calls.push("refundPayment");
      throw new Error("the daily run sends no refund");
    },
    async getPayment(id) {
      calls.push("getPayment");
      const payment = payments.find((record) => record.id === id);
      if (payment === undefined) return { kind: "error", code: "NOT_FOUND", detail: `no payment ${id}` };
      return { kind: "ok", payment: { ...payment } };
    },
    async listPayments(window) {
      calls.push("listPayments");
      return { kind: "ok", payments: payments.filter((p) => within(p, window)).map((p) => ({ ...p })) };
    },
    async listRefunds(window) {
      calls.push("listRefunds");
      return { kind: "ok", refunds: refunds.filter((r) => within(r, window)).map((r) => ({ ...r })) };
    },
  };
  return { client, payments, refunds, calls };
}

type Spec = Partial<BookingRow> & { start: string; end?: string; created?: string };

interface World {
  db: D1Database;
  sheet: FakeSheets;
  square: FakeSquare;
  staffEmail: string;
  modelId: string;
  plates: string[];
  book(spec: Spec): Promise<BookingRow>;
  /** A web booking confirmed at `confirmed`, and unless `inSquare` is false its COMPLETED payment for paid_jpy. */
  paid(spec: Spec & { confirmed: string; inSquare?: boolean }): Promise<{ booking: BookingRow; payment?: SquareRecord }>;
  /** A payment staff took in the Square Dashboard, which names no booking. */
  stray(when: string, amount: number): SquareRecord;
  /** Appends these rows to the Bookings tab, as staff or an earlier sync left them. */
  lay(rows: unknown[][]): void;
  row(b: BookingRow, staff?: Record<string, unknown>, refunds?: RefundFact[]): unknown[];
  /** An outbox item, dead unless `status` says otherwise. */
  outbox(kind: "email" | "sheet_booking", dedupeKey: string, created: number, status?: string): Promise<void>;
  run(now: number, db?: D1Database): Promise<Daily>;
}

let serial = 0;

async function withWorld(run: (world: World) => Promise<void>, plateCount = 6): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await seedConfig(db);
    await seedCatalogMeta(db);
    await seedTiers(db);
    const model = await seedModel(db);
    const plates: string[] = [];
    for (let n = 0; n < plateCount; n += 1) {
      plates.push((await seedVehicle(db, { plate: `わ${randomUUID().slice(0, 4)}-${n}`, model_id: model.id })).plate);
    }
    const sheet = createFakeSheets({ Bookings: [[...BOOKINGS_HEADER]], Reconciliation: [[...RECON_HEADER]] });
    const square = fakeSquare();
    const staffEmail = `ops-${randomUUID().slice(0, 8)}@example.com`;
    const book: World["book"] = async ({ start, end, created, ...rest }) => {
      serial += 1;
      const startAt = at(start);
      const createdAt =
        created === undefined ? Math.min(startAt - 9 * DAY_MS, NOW - 2 * DAY_MS - (serial % 5) * HOUR_MS) : at(created);
      const deposit = 1500 + 41 * serial;
      return seedBooking(db, {
        id: randomUUID(),
        ref: `OD-${randomUUID().slice(0, 8).toUpperCase()}`,
        vehicle_plate: plates[serial % plates.length],
        model_id: model.id,
        start_at: startAt,
        end_at: end === undefined ? startAt + 9 * HOUR_MS : at(end),
        created_at: createdAt,
        updated_at: createdAt + HOUR_MS,
        price_jpy: 6000 + 97 * serial,
        deposit_jpy: deposit,
        paid_jpy: deposit,
        guest_email: `guest${serial}@example.com`,
        guest_phone: `+81-90-${String(2000 + serial)}-0000`,
        ...rest,
      });
    };
    await run({
      db,
      sheet,
      square,
      staffEmail,
      modelId: model.id,
      plates,
      book,
      async paid({ confirmed, inSquare = true, ...spec }) {
        const paymentId = `pay-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
        const booking = await book({ ...spec, payment_id: paymentId, confirmed_at: at(confirmed) });
        if (!inSquare) return { booking };
        const payment: SquareRecord = {
          id: paymentId,
          status: "COMPLETED",
          amount: booking.paid_jpy,
          currency: "JPY",
          reference_id: booking.id,
          created_at: new Date(at(confirmed) - MINUTE_MS).toISOString(),
        };
        square.payments.push(payment);
        return { booking, payment };
      },
      stray(when, amount) {
        const payment: SquareRecord = {
          id: `pay-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
          status: "COMPLETED",
          amount,
          currency: "JPY",
          created_at: new Date(at(when)).toISOString(),
        };
        square.payments.push(payment);
        return payment;
      },
      lay(rows) {
        const first = sheet.grid("Bookings").length;
        rows.forEach((row, i) => row.forEach((value, c) => sheet.setCell("Bookings", first + i, c, value)));
      },
      row(b, staff = {}, refunds = []) {
        return rowUnder(BOOKINGS_HEADER, { ...expectedCells(b, refunds), ...staff });
      },
      async outbox(kind, dedupeKey, created, status = "dead") {
        const payload =
          kind === "email"
            ? { template: "guest_confirmation", to: "guest@example.com", locale: "en", data: {} }
            : { bookingId: dedupeKey.split(":")[1] };
        await insertRow(db, "outbox", {
          kind,
          dedupe_key: dedupeKey,
          payload: JSON.stringify(payload),
          status,
          attempts: status === "dead" ? 8 : 1,
          next_attempt_at: created,
          last_error: status === "dead" ? "the mail service answered 500" : null,
          created_at: created,
        });
      },
      async run(now, counted = db) {
        const { runDaily } = await dailyModule();
        return (await runDaily({ db: counted, sheets: sheet, square: square.client, now, staffEmail })) as Daily;
      },
    });
  } finally {
    await dispose();
  }
}

type WantRow = {
  type: string;
  bookingRef?: string;
  paymentId?: string;
  refundId?: string;
  expectedJpy?: number;
  actualJpy?: number;
};

function trimmed(row: unknown[] | undefined): unknown[] {
  const cells = (row ?? []).map((cell) => (cell === undefined || cell === null ? "" : cell));
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** The Reconciliation tab as staff see it: its header, its run row and its issue rows, with blank rows below dropped. */
function report(sheet: FakeSheets) {
  const grid = sheet.grid("Reconciliation").map(trimmed);
  while (grid.length > 0 && isBlank(grid[grid.length - 1])) grid.pop();
  const [header, run, ...issues] = grid;
  return { header, run: named(RECON_HEADER, run), issues: issues.map((row) => named(RECON_HEADER, row)) };
}

function rowKey(row: Record<string, unknown>): string {
  return JSON.stringify([row.type, row.booking_ref, row.payment_id, row.refund_id, row.expected_jpy, row.actual_jpy]);
}

function wantKey(want: WantRow): string {
  return JSON.stringify([
    want.type,
    want.bookingRef ?? "",
    want.paymentId ?? "",
    want.refundId ?? "",
    want.expectedJpy ?? "",
    want.actualJpy ?? "",
  ]);
}

/**
 * Checks the whole tab: the header, the run row of `now`, exactly the `want` issues and one row per dead item named by
 * its dedupe key, and nothing else. Returns the run row's counts.
 */
function assertReport(sheet: FakeSheets, now: number, want: WantRow[], deadKeys: string[], label: string): unknown {
  const tab = report(sheet);
  assert.deepEqual(tab.header, RECON_HEADER, `${label}: the header row`);
  const runAt = tab.run.run_at;
  assert.equal(typeof runAt, "string", `${label}: run_at is text`);
  const clock = wall(now).replace(/[-:]/g, (c) => `\\${c}`);
  assert.match(runAt as string, new RegExp(`^${clock}(:\\d{2})?( JST)?$`), `${label}: run_at is the run's JST wall clock`);
  const counts = tab.run.counts;
  assert.ok(
    (typeof counts === "string" && counts.trim() !== "") || typeof counts === "number",
    `${label}: the run row has counts`,
  );
  assert.equal(tab.run.type, "", `${label}: the run row is not an issue`);

  for (const row of tab.issues) {
    assert.ok(
      typeof row.type === "string" && row.type !== "",
      `${label}: every row below the run row is an issue, got ${JSON.stringify(row)}`,
    );
    assert.ok(row.run_at === "" || row.run_at === runAt, `${label}: an issue row's run_at is empty or the run's`);
    assert.ok(typeof row.detail === "string" && row.detail.trim() !== "", `${label}: ${rowKey(row)} has a detail`);
    for (const money of ["expected_jpy", "actual_jpy"]) {
      const value = row[money];
      assert.ok(value === "" || Number.isInteger(value), `${label}: ${money} is an integer or empty, got ${JSON.stringify(value)}`);
    }
  }
  const dead = tab.issues.filter((row) => row.type === "dead_outbox_item");
  const rest = tab.issues.filter((row) => row.type !== "dead_outbox_item");
  assert.deepEqual(rest.map(rowKey).sort(), want.map(wantKey).sort(), `${label}: the issues of both checks`);
  assert.equal(dead.length, deadKeys.length, `${label}: one row per dead outbox item`);
  for (const key of deadKeys) {
    const naming = dead.filter((row) => String(row.detail).includes(key));
    assert.equal(naming.length, 1, `${label}: one dead row names ${key}`);
    const [row] = naming;
    assert.deepEqual([row.payment_id, row.refund_id, row.expected_jpy, row.actual_jpy], ["", "", "", ""], key);
  }
  return counts;
}

type OutboxRow = { kind: string; dedupe_key: string; payload: string; status: string };

async function reports(db: D1Database): Promise<OutboxRow[]> {
  const { results } = await db
    .prepare(
      "SELECT kind, dedupe_key, payload, status FROM outbox WHERE dedupe_key LIKE 'email:reconcile_report:%' ORDER BY id",
    )
    .all<OutboxRow>();
  return results;
}

function issueKey(issue: Record<string, unknown>): string {
  return JSON.stringify([
    issue.type,
    issue.bookingRef ?? null,
    issue.paymentId ?? null,
    issue.refundId ?? null,
    issue.expectedJpy ?? null,
    issue.actualJpy ?? null,
  ]);
}

/** The report queued under the day's key, read back as the outbox holds it. */
function assertQueued(
  row: OutboxRow | undefined,
  { staffEmail, runAt, want }: { staffEmail: string; runAt: number; want: WantRow[] },
): void {
  assert.ok(row, "a report is queued");
  assert.equal(row.kind, "email");
  assert.equal(row.status, "pending", "queued, not sent by the run");
  assert.equal(row.dedupe_key, `email:reconcile_report:${jstDate(runAt)}`);
  const payload = JSON.parse(row.payload) as { template: string; to: string; locale: string; data: Record<string, unknown> };
  assert.equal(payload.template, "reconcile_report");
  assert.equal(payload.to, staffEmail);
  assert.equal(typeof payload.locale, "string");
  assert.equal(payload.data.runAt, runAt);
  assert.ok(Array.isArray(payload.data.issues), "the report carries its issues");
  assert.deepEqual(
    (payload.data.issues as Record<string, unknown>[]).map(issueKey).sort(),
    want.map((issue) => issueKey(issue)).sort(),
    "the report lists the run's issues",
  );
}

function ghostOf(): { id: string; ref: string } {
  return { id: randomUUID(), ref: `OD-${randomUUID().slice(0, 8).toUpperCase()}` };
}

/** The 0-based Bookings rows holding this booking_id. */
function rowsOf(sheet: FakeSheets, id: string): number[] {
  return sheet.grid("Bookings").flatMap((row, i) => (i > 0 && named(BOOKINGS_HEADER, row).booking_id === id ? [i] : []));
}

/** What staff do to remove a row by hand: empty its cells. */
function clearRow(sheet: FakeSheets, index: number): void {
  sheet.grid("Bookings")[index].forEach((_, c) => sheet.setCell("Bookings", index, c, ""));
}

test("the report tab lists every issue", async () => {
  await withWorld(async (world) => {
    const { db, sheet, plates } = world;

    // Square: one booking paid as D1 says, one Square never charged, one charged another amount, and a Dashboard sale.
    const clean = await world.paid({ start: "2030-06-20 09:00", confirmed: "2030-05-25 10:00" });
    const unpaid = await world.paid({ start: "2030-06-22 09:00", confirmed: "2030-05-26 11:30", inSquare: false });
    const mismatch = await world.paid({ start: "2030-06-24 09:00", confirmed: "2030-05-27 15:10" });
    const extra = randomInt(300, 4000);
    assert.ok(mismatch.payment, "fixture: the mismatched payment is in Square");
    mismatch.payment.amount = mismatch.booking.paid_jpy + extra;
    const strayAmount = randomInt(1000, 30_000);
    const stray = world.stray("2030-05-20 13:40", strayAmount);

    // Either side of 30 days back, where a shorter window than the checks' 35 days would cut: a Dashboard sale and a
    // booking the sync never wrote whose every time is 30 to 35 days back, and the same 37 days back.
    const bandAmount = randomInt(1000, 30_000);
    const bandStray = world.stray("2030-04-29 13:40", bandAmount);
    world.stray("2030-04-24 11:00", randomInt(1000, 30_000));
    const bandMissing = await world.book({ start: "2030-04-29 09:00", end: "2030-04-29 18:00", created: "2030-04-27 12:00" });
    const pastBand = await world.book({ start: "2030-04-24 09:00", end: "2030-04-24 18:00" });
    const times = (b: BookingRow) => [b.start_at, b.end_at, b.created_at, b.updated_at];
    for (const ms of [at("2030-04-29 13:40"), ...times(bandMissing)]) {
      assert.ok(ms >= NOW - 35 * DAY_MS && ms < NOW - 30 * DAY_MS, "fixture: 30 to 35 days back");
    }
    for (const ms of [at("2030-04-24 11:00"), ...times(pastBand)]) {
      assert.ok(ms < NOW - 35 * DAY_MS, "fixture: before the window");
    }

    // The sheet: a pending override, two rows D1 never had, and a booking the sync never wrote.
    const overridden = await world.book({ start: "2030-06-26 09:00", vehicle_plate: plates[0] });
    const missing = await world.book({ start: "2030-06-27 09:00" });
    const ghosts = [ghostOf(), ghostOf()];
    world.lay([
      world.row(clean.booking),
      world.row({ ...clean.booking, ...ghosts[0] }),
      world.row(unpaid.booking),
      world.row(mismatch.booking),
      world.row(overridden, { override_plate: plates[1] }),
      world.row({ ...unpaid.booking, ...ghosts[1], status: "CANCELLED" }),
    ]);

    // The outbox: two dead items, and three that are not dead.
    const deadKeys = [`email:guest_confirmation:${randomUUID()}`, `sheet:${overridden.id}:moved:${NOW - 3 * HOUR_MS}`];
    await world.outbox("email", deadKeys[0], NOW - 2 * DAY_MS);
    await world.outbox("sheet_booking", deadKeys[1], NOW - 3 * HOUR_MS);
    await world.outbox("email", `email:staff_new_booking:${randomUUID()}`, NOW - DAY_MS, "sent");
    await world.outbox("email", `email:guest_cancellation:${randomUUID()}`, NOW - HOUR_MS, "pending");
    await world.outbox("sheet_booking", `sheet:${missing.id}:moved:${NOW - 5 * MINUTE_MS}`, NOW - 5 * MINUTE_MS, "sending");

    // Last run's report, longer than this one, still on the tab.
    for (let r = 1; r <= 12; r += 1) {
      RECON_HEADER.forEach((_, c) => sheet.setCell("Reconciliation", r, c, `old ${r}/${c}`));
    }

    const squareIssues: WantRow[] = [
      { type: "payment_without_booking", paymentId: stray.id, actualJpy: strayAmount },
      {
        type: "booking_without_payment",
        bookingRef: unpaid.booking.ref,
        paymentId: unpaid.booking.payment_id ?? undefined,
        expectedJpy: unpaid.booking.paid_jpy,
      },
      {
        type: "amount_mismatch",
        bookingRef: mismatch.booking.ref,
        paymentId: mismatch.payment.id,
        expectedJpy: mismatch.booking.paid_jpy,
        actualJpy: mismatch.booking.paid_jpy + extra,
      },
      { type: "payment_without_booking", paymentId: bandStray.id, actualJpy: bandAmount },
    ];
    const sheetIssues: WantRow[] = [
      { type: "unknown_sheet_row", bookingRef: ghosts[0].ref },
      { type: "unknown_sheet_row", bookingRef: ghosts[1].ref },
      { type: "pending_override", bookingRef: overridden.ref },
    ];

    const first = await world.run(NOW);

    const firstCounts = assertReport(sheet, NOW, [...squareIssues, ...sheetIssues], deadKeys, "first run");
    assert.equal(first.emailed, true);
    const found = squareIssues.length + sheetIssues.length;
    assert.ok(
      first.issues === found || first.issues === found + deadKeys.length,
      `issues counts what both checks found, got ${String(first.issues)}`,
    );
    // The sheet check's repairs ran too.
    for (const b of [missing, bandMissing]) {
      const missingRows = rowsOf(sheet, b.id);
      assert.equal(missingRows.length, 1, `the missing booking ${b.ref} was appended`);
      assert.deepEqual(schemaCells(named(BOOKINGS_HEADER, sheet.grid("Bookings")[missingRows[0]])), expectedCells(b));
    }
    assert.deepEqual(rowsOf(sheet, pastBand.id), [], "a booking that ended before the window is not copied");

    // The next day: D1 took Square's amount, staff cleared one stray row, and Publish applied the override.
    const fixedAt = NOW + 6 * HOUR_MS;
    await db
      .prepare("UPDATE bookings SET paid_jpy = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(mismatch.booking.paid_jpy + extra, fixedAt, mismatch.booking.id)
      .run();
    await db
      .prepare("UPDATE bookings SET vehicle_plate = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(plates[1], fixedAt, overridden.id)
      .run();
    clearRow(sheet, rowsOf(sheet, ghosts[1].id)[0]);

    const nextDay = NOW + DAY_MS;
    await world.run(nextDay);

    const secondCounts = assertReport(
      sheet,
      nextDay,
      [squareIssues[0], squareIssues[1], squareIssues[3], sheetIssues[0]],
      deadKeys,
      "second run, with fewer issues: no row of the first run is left",
    );
    assert.notDeepEqual(secondCounts, firstCounts, "counts says what this run counted");
  });
});

test("email only when issues exist, once per day", async () => {
  await withWorld(async (world) => {
    const { db, sheet, staffEmail } = world;
    // A clean shop: paid bookings Square agrees with, on the tab, one booking the sync missed, and no dead item.
    const paidRows = [
      await world.paid({ start: "2030-06-05 09:00", confirmed: "2030-05-22 10:00" }),
      await world.paid({ start: "2030-06-15 09:00", confirmed: "2030-05-28 18:20" }),
    ];
    const synced = await world.book({ start: "2030-06-09 09:00" });
    const missed = await world.book({ start: "2030-06-11 09:00" });
    world.lay([...paidRows.map(({ booking }) => world.row(booking)), world.row(synced)]);
    await world.outbox("email", `email:staff_new_booking:${paidRows[0].booking.id}`, NOW - 2 * DAY_MS, "sent");
    await world.outbox("sheet_booking", `sheet:${missed.id}:moved:${NOW - HOUR_MS}`, NOW - HOUR_MS, "pending");

    // 03:00 JST: nothing disagrees, and a repaired row is no issue.
    assert.deepEqual(outcome(await world.run(NOW)), { issues: 0, emailed: false });
    assert.deepEqual(await reports(db), [], "no issues, no email");
    assertReport(sheet, NOW, [], [], "a clean run still writes its run row");
    assert.equal(rowsOf(sheet, missed.id).length, 1, "the missed booking was repaired");

    // A Dashboard sale and a row D1 never had turn up; the run at 04:00 JST queues the day's report.
    const strayAmount = randomInt(500, 20_000);
    const stray = world.stray("2030-06-01 03:30", strayAmount);
    const ghost = ghostOf();
    world.lay([world.row({ ...synced, ...ghost })]);
    const want: WantRow[] = [
      { type: "payment_without_booking", paymentId: stray.id, actualJpy: strayAmount },
      { type: "unknown_sheet_row", bookingRef: ghost.ref },
    ];

    const morning = at("2030-06-01 04:00");
    assert.deepEqual(outcome(await world.run(morning)), { issues: 2, emailed: true });
    let queued = await reports(db);
    assert.equal(queued.length, 1);
    assertQueued(queued[0], { staffEmail, runAt: morning, want });

    // 23:30 JST is still the same JST day, though a later UTC one: no second email.
    const lateNight = at("2030-06-01 23:30");
    assert.deepEqual(outcome(await world.run(lateNight)), { issues: 2, emailed: false });
    queued = await reports(db);
    assert.equal(queued.length, 1, "at most one report a day");
    assertQueued(queued[0], { staffEmail, runAt: morning, want });
    assertReport(sheet, lateNight, want, [], "the tab is still rewritten");

    // 00:30 JST is the next JST day, though the same UTC one: the next report.
    const pastMidnight = at("2030-06-02 00:30");
    assert.deepEqual(outcome(await world.run(pastMidnight)), { issues: 2, emailed: true });
    queued = await reports(db);
    assert.equal(queued.length, 2);
    assertQueued(queued[1], { staffEmail, runAt: pastMidnight, want });

    // Weeks later the sale has left Square's window and staff removed the row: nothing to say, nothing queued.
    clearRow(sheet, rowsOf(sheet, ghost.id)[0]);
    const later = at("2030-07-10 03:00");
    assert.deepEqual(outcome(await world.run(later)), { issues: 0, emailed: false });
    assert.equal((await reports(db)).length, 2);
    assertReport(sheet, later, [], [], "a clean run after issues");
  });
});

/**
 * `db` that counts each statement sent, one for each of a batch. The real statements go to the real database, so a
 * counted run behaves as any other.
 */
function probe(db: D1Database): { db: D1Database; statements: () => number } {
  let statements = 0;
  const unwrapped = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "bind") return wrap(value.apply(target, args));
          statements += 1;
          return value.apply(target, args);
        };
      },
    });
    unwrapped.set(wrapped, statement);
    return wrapped;
  };
  const probed = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch") {
        return (list: D1PreparedStatement[]) => {
          statements += list.length;
          return target.batch(list.map((statement) => unwrapped.get(statement) ?? statement));
        };
      }
      if (property === "exec") {
        return (sql: string) => {
          statements += sql.split(";").filter((part) => part.trim() !== "").length;
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: probed, statements: () => statements };
}

type SeedRow = Record<string, string | number | null>;

const SEED_COLUMNS = [
  "id", "ref", "status", "source", "model_id", "package_id", "vehicle_plate", "start_at", "end_at", "price_jpy",
  "deposit_jpy", "locale", "guest_family_name", "guest_given_name", "guest_email", "guest_phone", "payment_id",
  "paid_jpy", "created_at", "updated_at", "confirmed_at", "external_ref",
];

const SEED_SQL =
  `INSERT INTO bookings (${SEED_COLUMNS.join(", ")}) ` +
  `VALUES (${SEED_COLUMNS.map((_, i) => `?${i + 1}`).join(", ")})`;

/** Many bookings in a few batches, read back as stored. */
async function seedMany(db: D1Database, rows: SeedRow[]): Promise<Map<string, BookingRow>> {
  for (let i = 0; i < rows.length; i += 50) {
    await db.batch(rows.slice(i, i + 50).map((row) => db.prepare(SEED_SQL).bind(...SEED_COLUMNS.map((c) => row[c] ?? null))));
  }
  const { results } = await db.prepare("SELECT * FROM bookings").all<BookingRow>();
  return new Map(results.map((b) => [b.id, b]));
}

test("a run stays within its subrequest and query budgets", async () => {
  await withWorld(async (world) => {
    const { db, sheet, plates, modelId } = world;

    // 250 bookings in the window and 300 that ended long before it: too many for a statement per booking, a bound
    // parameter per id, or a Sheets call per row. The window's web bookings confirmed in the last 30 days are paid in
    // Square, three of them for another amount.
    const recentRows: SeedRow[] = [];
    const charged = new Map<string, number>();
    let inScope = 0;
    for (let i = 0; i < 250; i += 1) {
      const start = at("2030-05-05 09:00") + i * 18 * HOUR_MS;
      const cancelled = i % 7 === 3;
      const web = i % 5 !== 4;
      const paidAt = start - 4 * DAY_MS;
      const paidInWindow = web && !cancelled && i % 2 === 0 && paidAt > NOW - 30 * DAY_MS && paidAt < NOW;
      const deposit = 2000 + 13 * i;
      const id = randomUUID();
      if (paidInWindow) {
        inScope += 1;
        charged.set(id, deposit + ([2, 6, 11].includes(inScope) ? 1000 + i : 0));
      }
      recentRows.push({
        id,
        ref: `OD-W${String(i).padStart(4, "0")}-${randomUUID().slice(0, 4)}`,
        status: cancelled ? "CANCELLED" : "CONFIRMED",
        source: web ? "web" : "block",
        model_id: modelId,
        package_id: i % 3 === 0 ? "day-1" : null,
        vehicle_plate: plates[i % plates.length],
        start_at: start,
        end_at: start + 8 * HOUR_MS,
        price_jpy: web ? 5000 + 71 * i : null,
        deposit_jpy: web ? deposit : null,
        locale: web ? ["ja", "en", "ko", "zh-cn"][i % 4] : null,
        guest_family_name: web ? `Family${i}` : null,
        guest_given_name: web ? `Given${i}` : null,
        guest_email: web ? `w${i}@example.com` : null,
        guest_phone: web ? `+81-90-0000-${String(i).padStart(4, "0")}` : null,
        payment_id: paidInWindow ? `pay-w${i}-${randomUUID().slice(0, 6)}` : null,
        paid_jpy: web ? deposit : 0,
        created_at: Math.min(start - 6 * DAY_MS, NOW - DAY_MS),
        updated_at: Math.min(start - 5 * DAY_MS, NOW - DAY_MS + HOUR_MS),
        confirmed_at: paidInWindow ? paidAt : null,
        external_ref: web ? null : `OTA-${i}-${randomUUID().slice(0, 4)}`,
      });
    }
    const oldRows: SeedRow[] = [];
    for (let i = 0; i < 300; i += 1) {
      const start = at("2029-01-02 09:00") + i * DAY_MS;
      oldRows.push({
        id: randomUUID(),
        ref: `OD-O${String(i).padStart(4, "0")}-${randomUUID().slice(0, 4)}`,
        status: i % 6 === 0 ? "CANCELLED" : "CONFIRMED",
        source: "web",
        model_id: modelId,
        vehicle_plate: plates[i % plates.length],
        start_at: start,
        end_at: start + 8 * HOUR_MS,
        price_jpy: 7000,
        deposit_jpy: 3000,
        locale: "ja",
        guest_family_name: `Old${i}`,
        guest_given_name: "Guest",
        guest_email: `o${i}@example.com`,
        guest_phone: "+81-90-1111-2222",
        paid_jpy: 3000,
        created_at: start - 10 * DAY_MS,
        updated_at: start - 10 * DAY_MS,
      });
    }
    const stored = await seedMany(db, [...recentRows, ...oldRows]);
    assert.equal(stored.size, 550, "fixture: every booking stored");
    const recent = recentRows.map((row) => stored.get(row.id as string) as BookingRow);
    const old = oldRows.map((row) => stored.get(row.id as string) as BookingRow);

    const mismatched = recent.filter((b) => charged.has(b.id) && charged.get(b.id) !== b.paid_jpy);
    assert.equal(mismatched.length, 3, "fixture: three amounts differ");
    assert.ok(charged.size >= 10, `fixture: ${charged.size} payments in the window`);
    for (const b of recent.filter((x) => charged.has(x.id))) {
      world.square.payments.push({
        id: b.payment_id as string,
        status: "COMPLETED",
        amount: charged.get(b.id) as number,
        currency: "JPY",
        reference_id: b.id,
        created_at: new Date((b.confirmed_at as number) - MINUTE_MS).toISOString(),
      });
    }
    const strays = [world.stray("2030-05-09 12:00", 4400), world.stray("2030-05-30 17:45", 13_200)];

    // A refund on each cancelled web booking of the window.
    const refunds = new Map<string, RefundFact[]>();
    for (const b of recent.filter((x) => x.status === "CANCELLED" && x.source === "web")) {
      refunds.set(b.id, [await seedRefund(db, b.id, { amount: Math.floor(b.paid_jpy / 2), status: "COMPLETED", at: b.updated_at })]);
    }

    // The tab: by i % 10, 125 rows in sync, 75 stale and 50 missing, so a Sheets call per missing row, or per stale row,
    // is over the subrequest budget by itself; eleven rows D1 never had; four overrides waiting on bookings that have
    // not started; and every old booking's row. Of the stale rows only a third have an older updated_at cell: the rest
    // differ in paid_jpy alone, or in a plate staff typed over.
    const overrideAt = new Set([41, 61, 81, 121]);
    const laid: unknown[][] = [];
    const ghosts: string[] = [];
    const pending: string[] = [];
    let missing = 0;
    let stale = 0;
    let keptStamp = 0;
    for (const [i, b] of recent.entries()) {
      if (i % 24 === 0) {
        const ghost = ghostOf();
        ghosts.push(ghost.ref);
        laid.push(world.row({ ...b, ...ghost }));
      }
      const kind = i % 10;
      if (kind >= 8) {
        missing += 1;
        continue;
      }
      if (kind === 5) {
        stale += 1;
        laid.push(world.row({ ...b, status: "CONFIRMED", paid_jpy: b.paid_jpy + 1, updated_at: b.updated_at - DAY_MS }));
        continue;
      }
      if (kind >= 6) {
        stale += 1;
        const drift = kind === 6 ? { paid_jpy: b.paid_jpy + 1 } : { vehicle_plate: plates[(i + 3) % plates.length] };
        const row = world.row({ ...b, ...drift }, {}, refunds.get(b.id));
        assert.equal(named(BOOKINGS_HEADER, row).updated_at, wall(b.updated_at), "fixture: the updated_at cell is D1's");
        keptStamp += 1;
        laid.push(row);
        continue;
      }
      const overriding = overrideAt.has(i);
      if (overriding) {
        assert.ok(b.status === "CONFIRMED" && b.start_at > NOW, `fixture: booking ${i} can still move`);
        pending.push(b.ref);
      }
      laid.push(world.row(b, overriding ? { override_plate: plates[(i + 1) % plates.length] } : {}, refunds.get(b.id)));
    }
    for (const b of old) laid.push(world.row(b));
    world.lay(laid);
    assert.equal(pending.length, 4, "fixture: four pending overrides");
    assert.equal(ghosts.length, 11, "fixture: eleven unknown rows");
    assert.equal(keptStamp, 50, "fixture: 50 stale rows keep D1's updated_at cell");
    assert.equal(missing, 50, "fixture: 50 missing bookings");
    assert.equal(stale, 75, "fixture: 75 stale rows");
    assert.ok(
      Math.min(missing, stale) + SUBREQUESTS_OUTSIDE >= SUBREQUEST_LIMIT,
      "fixture: a Sheets call per missing row, or per stale row, is over the subrequest budget by itself",
    );

    const deadKeys = [0, 1, 2].map((n) => `email:guest_confirmation:dead-${n}-${randomUUID()}`);
    for (const [n, key] of deadKeys.entries()) await world.outbox("email", key, NOW - (n + 1) * DAY_MS);
    for (let r = 1; r <= 30; r += 1) RECON_HEADER.forEach((_, c) => sheet.setCell("Reconciliation", r, c, `old ${r}`));

    const want: WantRow[] = [
      ...mismatched.map((b) => ({
        type: "amount_mismatch",
        bookingRef: b.ref,
        paymentId: b.payment_id as string,
        expectedJpy: b.paid_jpy,
        actualJpy: charged.get(b.id) as number,
      })),
      ...strays.map((p) => ({ type: "payment_without_booking", paymentId: p.id, actualJpy: p.amount })),
      ...ghosts.map((ref) => ({ type: "unknown_sheet_row", bookingRef: ref })),
      ...pending.map((ref) => ({ type: "pending_override", bookingRef: ref })),
    ];

    const tabBefore = sheet.grid("Bookings");
    sheet.calls.length = 0;
    sheet.writes.length = 0;
    world.square.calls.length = 0;
    const counted = probe(db);

    await world.run(NOW, counted.db);

    const queries = counted.statements();
    const subrequests = sheet.calls.length + world.square.calls.length;
    assert.ok(queries > 0, "the probe saw the run's queries");
    assert.ok(
      queries + QUERIES_OUTSIDE < QUERY_LIMIT,
      `${queries} D1 queries in runDaily, ${queries + QUERIES_OUTSIDE} with the cron's own; the limit is under ${QUERY_LIMIT}`,
    );
    assert.ok(
      subrequests + SUBREQUESTS_OUTSIDE < SUBREQUEST_LIMIT,
      `${subrequests} subrequests in runDaily (${sheet.calls.length} Sheets, ${world.square.calls.length} Square), ` +
        `${subrequests + SUBREQUESTS_OUTSIDE} with the token; the limit is under ${SUBREQUEST_LIMIT}`,
    );

    // And the run did all its work within them.
    assertReport(sheet, NOW, want, deadKeys, "the big run's report");
    const grid = sheet.grid("Bookings");
    assert.equal(grid.length, tabBefore.length + missing, `the ${missing} missing bookings appended`);
    for (const b of recent) {
      const found = rowsOf(sheet, b.id);
      assert.equal(found.length, 1, `${b.ref} is on the tab once`);
      const { override_plate: _p, override_status: _s, ...cells } = schemaCells(named(BOOKINGS_HEADER, grid[found[0]]));
      const { override_plate: _ep, override_status: _es, ...expected } = expectedCells(b, refunds.get(b.id));
      assert.deepEqual(cells, expected, `the row of ${b.ref}`);
    }
    const oldIds = new Set(old.map((b) => b.id));
    for (const [i, row] of tabBefore.entries()) {
      if (i > 0 && oldIds.has(named(BOOKINGS_HEADER, row).booking_id as string)) {
        assert.deepEqual(grid[i], row, "a row outside the window is left as it is");
      }
    }
  }, 10);
});
