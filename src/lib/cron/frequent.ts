// The ten-minute cron's work (#42), and the outbox delivery it shares with the drain after a request (src/server/outbox.ts).
// Each step runs whether or not an earlier one failed. A step that fails, or reports errors of its own as the stuck-payment
// resolver does, leaves its own messages in `errors` under the step's name, and the cron entry records them in cron_runs.
//
// The limits keep one run inside Workers Free's 50 D1 queries per invocation (a batch counts as one) and 50 subrequests.
// D1, at worst: the cron_runs row 1; the drain of 10 items 18 (recover and claim, a settle per email, the Bookings sync's
// two reads, its settle and the Google token cache's read and write, the dead items' lookup and their alert); the expiry
// 1; ten refunds 11; the stuck-payment read 1, then at most 5 for each booking it resolves (markConfirmed's row, config,
// tiers, batch and a re-read after a lost race). 32 + 3 × 5 = 47. Outbound: at most 13 for the drain, Square's listing
// and a send-back for each stuck booking, and 10 refunds.
import { email } from "../../i18n/strings/email.ts";
import { t } from "../../i18n/t.ts";
import { type RetryResult, retryRefunds } from "../booking/cancel.ts";
import { resolveStuckPayments, type StuckPaymentResult } from "../booking/stuck-payments.ts";
import type { SheetsClient } from "../google/sheets.ts";
import { renderEmail } from "../mail/templates.ts";
import type { MailMessage } from "../mail/transport.ts";
import { drainOutbox, enqueueStatements, type OutboxItem, type SendResult } from "../outbox.ts";
import { syncBookingRows } from "../sheets/bookings-sync.ts";
import type { SquareClient } from "../square/client.ts";

export type DeliveryDeps = {
  db: D1Database;
  now: number;
  sheets: SheetsClient;
  /** What src/server/mail.ts's mailSender(env) returns. */
  sendMail: (message: MailMessage) => Promise<SendResult>;
  staffEmail: string;
};

export type FrequentDeps = DeliveryDeps & { square: SquareClient; siteUrl: string; cancelSecret: string };

type DrainResult = Awaited<ReturnType<typeof drainOutbox>>;

export type FrequentResult = {
  outbox: DrainResult;
  expired: number;
  stuck: StuckPaymentResult;
  refunds: RetryResult;
  errors: string[];
};

const DRAIN_LIMIT = 10;
const REFUND_LIMIT = 10;
/** From the D1 budget above, at the resolver's worst cost per booking. The next run takes the rest, oldest charge first. */
const STUCK_LIMIT = 3;

/** An alert about dead items is keyed by their ids: an item dies once, so each death is alerted once. */
const DEAD_ALERT_PREFIX = "email:staff_alert:outbox-dead:";

/** Only holds: a PAYMENT_PENDING row keeps its bike until the resolver settles it, however old its expires_at. */
const EXPIRE_SQL = "UPDATE bookings SET status = 'EXPIRED', updated_at = ?1 WHERE status = 'ON_HOLD' AND expires_at <= ?1";

/** The ids are one parameter, a JSON array, as many as the drain's limit. */
const DEAD_KEYS_SQL = "SELECT id, dedupe_key FROM outbox WHERE id IN (SELECT value FROM json_each(?1))";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One staff_alert naming each item by its id and dedupe key, with why it died. An alert about dead items that died itself
 * is left out: it went to the same staff address, and another would only die the same way.
 */
async function alertDead({ db, now, staffEmail }: DeliveryDeps, dead: DrainResult["dead"]): Promise<void> {
  const { results } = await db
    .prepare(DEAD_KEYS_SQL)
    .bind(JSON.stringify(dead.map(({ id }) => id)))
    .all<{ id: number; dedupe_key: string }>();
  const keys = new Map(results.map(({ id, dedupe_key }) => [id, dedupe_key]));
  const named = dead.filter(({ id }) => !keys.get(id)?.startsWith(DEAD_ALERT_PREFIX));
  if (named.length === 0) return;

  const say = (key: string) => t("ja", email, key);
  const lines = named.map(({ id, kind, lastError }) => `#${id} ${keys.get(id) ?? kind}: ${lastError}`);
  const alert: OutboxItem = {
    kind: "email",
    dedupeKey: `${DEAD_ALERT_PREFIX}${named.map(({ id }) => id).join(",")}`,
    payload: {
      template: "staff_alert",
      to: staffEmail,
      locale: "ja",
      data: {
        title: say("email.staff.alert.outbox.title"),
        detail: [...lines, say("email.staff.alert.outbox.action")].join("\n"),
      },
    },
  };
  await db.batch(enqueueStatements(db, [alert], now));
}

/**
 * Sends up to `limit` due items: each email rendered from its payload and sent under its dedupe key, the sheet items in one
 * Bookings sync. Items that died in this drain get one staff_alert, queued for the next drain.
 */
export async function deliverOutbox(deps: DeliveryDeps, limit: number): Promise<DrainResult> {
  const { db, now, sheets, sendMail } = deps;
  const result = await drainOutbox({
    db,
    now,
    limit,
    sendEmail: (payload, messageId) => sendMail({ messageId, to: payload.to, ...renderEmail(payload) }),
    syncBookings: (ids) => syncBookingRows({ db, sheets }, ids),
  });
  if (result.dead.length > 0) await alertDead(deps, result.dead);
  return result;
}

async function expireHolds(db: D1Database, now: number): Promise<number> {
  const { meta } = await db.prepare(EXPIRE_SQL).bind(now).run();
  return meta.changes;
}

/** Drain, expire, resolve stuck payments, retry refunds. Resolves whatever fails; the failures are in `errors`. */
export async function runFrequent(deps: FrequentDeps): Promise<FrequentResult> {
  const errors: string[] = [];
  async function step<T>(name: string, work: () => Promise<T>, nothing: T): Promise<T> {
    try {
      return await work();
    } catch (error) {
      errors.push(`${name}: ${messageOf(error)}`);
      return nothing;
    }
  }

  const outbox = await step("drain", () => deliverOutbox(deps, DRAIN_LIMIT), { sent: 0, retried: 0, dead: [] });
  const expired = await step("hold expiry", () => expireHolds(deps.db, deps.now), 0);
  const stuck = await step("stuck payments", () => resolveStuckPayments(deps, STUCK_LIMIT), {
    confirmed: 0,
    reopened: 0,
    expired: 0,
    errors: [],
  });
  errors.push(...stuck.errors.map((error) => `stuck payments: ${error}`));
  const refunds = await step("refund retry", () => retryRefunds(deps, REFUND_LIMIT), {
    retried: 0,
    completed: 0,
    stillPending: 0,
  });
  return { outbox, expired, stuck, refunds, errors };
}
