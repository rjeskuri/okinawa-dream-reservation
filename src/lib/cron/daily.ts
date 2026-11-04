// The daily check (#44), which the 0 18 * * * cron runs at 03:00 JST: D1 against Square and against the Bookings tab, the
// Reconciliation tab rewritten with what both found and with the outbox items that died, and one report a JST day to
// staff when either check found an issue. A dead item goes on the tab but sends no report by itself: it stays dead, so it
// would send one every day. A check that fails does not stop the other. The tab and the report carry what was found, the
// run row says what failed, and the run then throws, so that cron_runs records the failure.
import { SHEET_TABS } from "../catalog/sheet-schema.ts";
import type { SheetsClient } from "../google/sheets.ts";
import { enqueueStatements } from "../outbox.ts";
import { reconcileSheet } from "../reconcile/sheet.ts";
import { reconcileSquare, type ReconcileIssue } from "../reconcile/square.ts";
import { columnLetters } from "../sheets/bookings-sync.ts";
import type { SquareClient } from "../square/client.ts";
import { epochToJst, jstToday } from "../time.ts";

export type DailyDeps = { db: D1Database; sheets: SheetsClient; square: SquareClient; now: number; staffEmail: string };

/** `issues` is what the two checks found, and `emailed` whether this run queued the day's report. */
export type DailyResult = { issues: number; emailed: boolean };

type Column = (typeof SHEET_TABS.Reconciliation)[number];

/** A row below the run row: an issue of either check, or a dead outbox item. */
type ReportRow = Omit<ReconcileIssue, "type"> & { type: ReconcileIssue["type"] | "dead_outbox_item" };

type DeadItem = {
  kind: string;
  dedupe_key: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  /** How many dead items the window holds, LIMIT aside. */
  total: number;
};

const TAB = "Reconciliation";
const COLUMNS = SHEET_TABS.Reconciliation;
const LAST_COLUMN = columnLetters(COLUMNS.length - 1);

const DAY_MS = 86_400_000;

/** The dead items listed are those queued in the last DEAD_DAYS, newest first, at most DEAD_LIMIT of them. */
const DEAD_DAYS = 35;
const DEAD_LIMIT = 50;

const DEAD_SQL =
  "SELECT kind, dedupe_key, attempts, last_error, created_at, COUNT(*) OVER () AS total FROM outbox " +
  "WHERE status = 'dead' AND created_at >= ?1 ORDER BY created_at DESC, id DESC LIMIT ?2";

function jst(ms: number): string {
  const { date, time } = epochToJst(ms);
  return `${date} ${time}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A row of the tab, each value under its column and "" under the rest. */
function cellsOf(values: Partial<Record<Column, string | number>>): (string | number)[] {
  return COLUMNS.map((column) => values[column] ?? "");
}

function issueCells(row: ReportRow): (string | number)[] {
  return cellsOf({
    type: row.type,
    booking_ref: row.bookingRef,
    payment_id: row.paymentId,
    refund_id: row.refundId,
    expected_jpy: row.expectedJpy,
    actual_jpy: row.actualJpy,
    detail: row.detail,
  });
}

function deadRow(item: DeadItem): ReportRow {
  const error = (item.last_error ?? "no error recorded").slice(0, 300);
  return {
    type: "dead_outbox_item",
    detail:
      `The ${item.kind} item ${item.dedupe_key}, queued ${jst(item.created_at)}, gave up after ${item.attempts} ` +
      `attempts: ${error}`,
  };
}

/** Overwrites the tab from A1: the header, then `rows`, then blank rows over whatever a longer report left below. */
async function writeReport(sheets: SheetsClient, rows: (string | number)[][]): Promise<void> {
  const before = (await sheets.batchGet([`${TAB}!A:${LAST_COLUMN}`]))[TAB] ?? [];
  const values = [[...COLUMNS], ...rows];
  while (values.length < before.length) values.push(cellsOf({}));
  await sheets.batchUpdate([{ range: `${TAB}!A1:${LAST_COLUMN}${values.length}`, values }]);
}

/** Runs both checks and reports them. Throws after the report when a check or the tab write failed. */
export async function runDaily({ db, sheets, square, now, staffEmail }: DailyDeps): Promise<DailyResult> {
  const failures: string[] = [];
  const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      failures.push(`${what} failed: ${messageOf(error)}`);
      return null;
    }
  };

  const squareCheck = await attempt("The Square check", () => reconcileSquare({ db, square, now }));
  const sheetCheck = await attempt("The Bookings tab check", () => reconcileSheet({ db, sheets, now }));
  const { results: dead } = await db
    .prepare(DEAD_SQL)
    .bind(now - DEAD_DAYS * DAY_MS, DEAD_LIMIT)
    .all<DeadItem>();
  const issues = [...(squareCheck?.issues ?? []), ...(sheetCheck?.issues ?? [])];

  const deadTotal = dead[0]?.total ?? 0;
  const counts = [
    squareCheck === null ? "Square: failed" : `Square: ${squareCheck.issues.length} issues, ${squareCheck.fixed} fixed`,
    sheetCheck === null
      ? "Bookings tab: failed"
      : `Bookings tab: ${sheetCheck.issues.length} issues, ${sheetCheck.repaired} rows repaired`,
    `dead outbox items: ${deadTotal}${deadTotal > dead.length ? ` (the newest ${dead.length} listed)` : ""}`,
  ].join("; ");
  const runRow = cellsOf({ run_at: jst(now), counts, detail: failures.join("; ") });
  await attempt("Writing the Reconciliation tab", () =>
    writeReport(sheets, [runRow, ...[...issues, ...dead.map(deadRow)].map(issueCells)]),
  );

  let emailed = false;
  if (issues.length > 0) {
    const [queue] = enqueueStatements(
      db,
      [
        {
          kind: "email",
          dedupeKey: `email:reconcile_report:${jstToday(now)}`,
          payload: { template: "reconcile_report", to: staffEmail, locale: "ja", data: { runAt: now, issues } },
        },
      ],
      now,
    );
    // INSERT OR IGNORE: the day's report, once queued, keeps its place.
    emailed = ((await queue.run()).meta.changes ?? 0) > 0;
  }

  if (failures.length > 0) throw new Error(failures.join("; "));
  return { issues: issues.length, emailed };
}
