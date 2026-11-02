// The outbox: emails and sheet updates that go in a caller's D1 batch and are delivered later through injected senders,
// with retries. Delivery is at least once, so a send can repeat after a crash; the stable messageId lets the mail service
// drop the repeat, and a sheet item reads the booking's current state when it is drained.
import type { Locale } from "./locale.ts";

export type EmailPayload = {
  template:
    | "guest_confirmation"
    | "guest_cancellation"
    | "staff_new_booking"
    | "staff_cancellation"
    | "staff_alert"
    | "reconcile_report";
  to: string;
  locale: Locale;
  data: Record<string, unknown>;
};

export type OutboxItem =
  | { kind: "email"; dedupeKey: string; payload: EmailPayload }
  | { kind: "sheet_booking"; dedupeKey: string; payload: { bookingId: string } };

export type SendResult = { ok: true } | { ok: false; retryable: boolean; retryAt?: number; error: string };

type DrainDeps = {
  db: D1Database;
  now: number;
  limit?: number;
  sendEmail(p: EmailPayload, messageId: string): Promise<SendResult>;
  syncBookings(ids: string[]): Promise<SendResult>;
};

type DrainResult = { sent: number; retried: number; dead: { id: number; kind: string; lastError: string }[] };

type Claim = { id: number; kind: OutboxItem["kind"]; dedupe_key: string; payload: string; attempts: number };

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;

/** The wait after a failure, by the attempts made before it. The last wait repeats. */
const BACKOFF_MS = [MINUTE_MS, 5 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS, 6 * HOUR_MS];

const MAX_ATTEMPTS = 8;

const STALE_CLAIM_MS = 10 * MINUTE_MS;

// Sends run one at a time, so this keeps a slow mail service well inside STALE_CLAIM_MS.
const DEFAULT_LIMIT = 50;

const INSERT_SQL =
  "INSERT OR IGNORE INTO outbox (kind, dedupe_key, payload, status, next_attempt_at, created_at) " +
  "VALUES (?1, ?2, ?3, 'pending', ?4, ?4)";

const RECOVER_SQL = "UPDATE outbox SET status = 'pending' WHERE status = 'sending' AND claimed_at < ?1";

// One statement, so concurrent drains are serialized by D1 and no two can return the same row.
const CLAIM_SQL =
  "UPDATE outbox SET status = 'sending', claimed_at = ?1 WHERE id IN (" +
  "SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= ?1 ORDER BY next_attempt_at, id LIMIT ?2" +
  ") RETURNING id, kind, dedupe_key, payload, attempts";

// The claim must still be this drain's: one that outlived STALE_CLAIM_MS may belong to another drain by now.
const SETTLE_SQL =
  "UPDATE outbox SET status = ?1, attempts = attempts + 1, next_attempt_at = COALESCE(?2, next_attempt_at), " +
  "last_error = ?3 WHERE id = ?4 AND status = 'sending' AND claimed_at = ?5";

/** The statements that queue `items`, for the caller's own batch. A dedupe_key already queued keeps its first item. */
export function enqueueStatements(db: D1Database, items: OutboxItem[], now: number): D1PreparedStatement[] {
  const insert = db.prepare(INSERT_SQL);
  return items.map((item) => insert.bind(item.kind, item.dedupeKey, JSON.stringify(item.payload), now));
}

/** What an outcome makes of a claim with `attempts` made before it. A null nextAttemptAt keeps the row's time. */
function nextState(attempts: number, now: number, outcome: SendResult) {
  if (outcome.ok) return { status: "sent", nextAttemptAt: null, lastError: null };
  if (!outcome.retryable || attempts + 1 >= MAX_ATTEMPTS) {
    return { status: "dead", nextAttemptAt: null, lastError: outcome.error };
  }
  const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
  return { status: "pending", nextAttemptAt: outcome.retryAt ?? now + wait, lastError: outcome.error };
}

/** Runs a send, turning a throw of any kind into a retryable failure. */
async function attempt(send: () => Promise<SendResult>): Promise<SendResult> {
  try {
    return await send();
  } catch (error) {
    return { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Sends what is due, emails one by one and all sheet items in a single call, and records each outcome as it comes, so a
 * crash loses as little as possible. Stale claims go back to pending first, and are due again in this same drain.
 */
export async function drainOutbox(deps: DrainDeps): Promise<DrainResult> {
  const { db, now, limit = DEFAULT_LIMIT } = deps;
  await db.prepare(RECOVER_SQL).bind(now - STALE_CLAIM_MS).run();
  const claims = (await db.prepare(CLAIM_SQL).bind(now, limit).all<Claim>()).results;

  const result: DrainResult = { sent: 0, retried: 0, dead: [] };
  const settle = async (settled: Claim[], outcome: SendResult): Promise<void> => {
    const states = settled.map((claim) => nextState(claim.attempts, now, outcome));
    const writes = await db.batch(
      settled.map((claim, index) => {
        const { status, nextAttemptAt, lastError } = states[index];
        return db.prepare(SETTLE_SQL).bind(status, nextAttemptAt, lastError, claim.id, now);
      }),
    );
    settled.forEach((claim, index) => {
      if (writes[index].meta.changes === 0) return;
      if (outcome.ok) result.sent += 1;
      else if (states[index].status === "pending") result.retried += 1;
      else result.dead.push({ id: claim.id, kind: claim.kind, lastError: outcome.error });
    });
  };

  for (const claim of claims.filter(({ kind }) => kind === "email")) {
    await settle([claim], await attempt(() => deps.sendEmail(JSON.parse(claim.payload), claim.dedupe_key)));
  }

  const sheets = claims.filter(({ kind }) => kind === "sheet_booking");
  if (sheets.length > 0) {
    const bookingId = (claim: Claim): string => (JSON.parse(claim.payload) as { bookingId: string }).bookingId;
    await settle(sheets, await attempt(() => deps.syncBookings([...new Set(sheets.map(bookingId))])));
  }

  return result;
}
