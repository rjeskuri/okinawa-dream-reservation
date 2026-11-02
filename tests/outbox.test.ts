// The D1 outbox: enqueueing inside a caller's batch, atomic claims, retries and stale claims.
// Expected times are literal offsets from each test's own clock, never from src/lib/outbox.ts. Rows are enqueued
// through enqueueStatements and then patched, so these tests do not depend on how the payload column is encoded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCALES } from "../src/lib/locale.ts";
import { drainOutbox, enqueueStatements } from "../src/lib/outbox.ts";
import type { EmailPayload, OutboxItem, SendResult } from "../src/lib/outbox.ts";
import { createTestDb } from "./helpers/d1.ts";
import { seedBooking } from "./helpers/seed.ts";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const T0 = Date.UTC(2026, 10, 2, 3, 0);

/** The wait after a failure, indexed by the attempts made before it. The eighth failure has no wait: it is dead. */
const BACKOFF_MS = [
  MINUTE_MS,
  5 * MINUTE_MS,
  30 * MINUTE_MS,
  2 * HOUR_MS,
  6 * HOUR_MS,
  6 * HOUR_MS,
  6 * HOUR_MS,
];
const MAX_ATTEMPTS = 8;

const NOTHING = { sent: 0, retried: 0, dead: [] };
const OK: SendResult = { ok: true };

type EmailItem = Extract<OutboxItem, { kind: "email" }>;

interface OutboxRow {
  id: number;
  kind: string;
  dedupe_key: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  claimed_at: number | null;
  last_error: string | null;
  created_at: number;
}

function emailItem(bookingId: string, template: EmailPayload["template"] = "guest_confirmation"): EmailItem {
  return {
    kind: "email",
    dedupeKey: `email:${template}:${bookingId}`,
    payload: { template, to: `${bookingId}@example.com`, locale: "en", data: { bookingId } },
  };
}

function sheetItem(bookingId: string, status = "CONFIRMED"): OutboxItem {
  return { kind: "sheet_booking", dedupeKey: `sheet:${bookingId}:${status}`, payload: { bookingId } };
}

/** One item of each kind, so a test can run the same steps through both senders. */
const BOTH_KINDS: { kind: OutboxItem["kind"]; item: (id: string) => OutboxItem }[] = [
  { kind: "email", item: (id) => emailItem(id) },
  { kind: "sheet_booking", item: (id) => sheetItem(id) },
];

async function withDb(run: (db: D1Database) => Promise<void>): Promise<void> {
  const { db, dispose } = await createTestDb();
  try {
    await run(db);
  } finally {
    await dispose();
  }
}

async function enqueue(db: D1Database, items: OutboxItem[], now: number): Promise<void> {
  await db.batch(enqueueStatements(db, items, now));
}

async function clearOutbox(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM outbox").run();
}

async function allRows(db: D1Database): Promise<OutboxRow[]> {
  return (await db.prepare("SELECT * FROM outbox ORDER BY id").all<OutboxRow>()).results;
}

async function rowOf(db: D1Database, item: OutboxItem): Promise<OutboxRow> {
  const row = await db.prepare("SELECT * FROM outbox WHERE dedupe_key = ?1").bind(item.dedupeKey).first<OutboxRow>();
  if (row === null) throw new Error(`no outbox row for ${item.dedupeKey}`);
  return row;
}

/** Puts an enqueued row in the state a test starts from. */
async function patchRow(
  db: D1Database,
  item: OutboxItem,
  fields: Partial<Pick<OutboxRow, "status" | "attempts" | "claimed_at">>,
): Promise<void> {
  const entries = Object.entries(fields);
  const assignments = entries.map(([column], index) => `${column} = ?${index + 2}`).join(", ");
  await db
    .prepare(`UPDATE outbox SET ${assignments} WHERE dedupe_key = ?1`)
    .bind(item.dedupeKey, ...entries.map(([, value]) => value))
    .run();
}

interface Senders {
  emails: { payload: EmailPayload; messageId: string }[];
  syncs: string[][];
  sendEmail(payload: EmailPayload, messageId: string): Promise<SendResult>;
  syncBookings(ids: string[]): Promise<SendResult>;
}

/**
 * Senders that record what they are given and answer `reply(n)` for the nth call of either. `during` runs while the
 * call is in flight, which is where a test puts a slow network, a rival drain or a crash.
 */
function senders(reply: (call: number) => SendResult = () => OK, during?: () => Promise<void>): Senders {
  let calls = 0;
  const finish = async (): Promise<SendResult> => {
    calls += 1;
    const answer = reply(calls);
    await during?.();
    return answer;
  };
  const emails: Senders["emails"] = [];
  const syncs: Senders["syncs"] = [];
  return {
    emails,
    syncs,
    sendEmail: (payload, messageId) => {
      emails.push({ payload, messageId });
      return finish();
    },
    syncBookings: (ids) => {
      syncs.push(ids);
      return finish();
    },
  };
}

function drain(db: D1Database, now: number, s: Senders, limit?: number) {
  return drainOutbox({ db, now, limit, sendEmail: s.sendEmail, syncBookings: s.syncBookings });
}

/** Every booking id the senders were handed, sorted, one entry per delivery. */
function delivered(...all: Senders[]): string[] {
  return all
    .flatMap((s) => [...s.emails.map((email) => String(email.payload.data.bookingId)), ...s.syncs.flat()])
    .sort();
}

function outage(call: number): SendResult {
  return { ok: false, retryable: true, error: `outage ${call}` };
}

function byId<T extends { id: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.id - b.id);
}

test("enqueued items commit with the caller's batch", (t) =>
  withDb(async (db) => {
    const confirm = (id: string, status = "CONFIRMED") =>
      db.prepare("UPDATE bookings SET status = ?2 WHERE id = ?1").bind(id, status);
    const bookingStatus = (id: string) => db.prepare("SELECT status FROM bookings WHERE id = ?1").bind(id).first("status");

    await t.test("statements do nothing until the caller runs them", async () => {
      enqueueStatements(db, [emailItem("unrun")], T0);
      assert.deepEqual(await allRows(db), []);
    });

    const committed: [string, OutboxItem[], number][] = [
      ["no items", [], T0],
      ["one item", [emailItem("b-1")], T0 + 7],
      ["both kinds", [emailItem("b-2"), emailItem("b-2", "staff_new_booking"), sheetItem("b-2")], T0 + HOUR_MS],
    ];
    for (const [name, items, now] of committed) {
      await t.test(`a committed batch keeps the booking change and ${name}`, async () => {
        await clearOutbox(db);
        const booking = await seedBooking(db, { status: "PAYMENT_PENDING" });

        await db.batch([confirm(booking.id), ...enqueueStatements(db, items, now)]);

        assert.equal(await bookingStatus(booking.id), "CONFIRMED");
        const stored = (await allRows(db)).map((row) => ({ ...row, id: undefined, payload: undefined }));
        assert.deepEqual(
          stored,
          items.map((item) => ({
            id: undefined,
            payload: undefined,
            kind: item.kind,
            dedupe_key: item.dedupeKey,
            status: "pending",
            attempts: 0,
            next_attempt_at: now,
            claimed_at: null,
            last_error: null,
            created_at: now,
          })),
        );
      });
    }

    // A status the CHECK constraint refuses fails the batch wherever the bad statement sits.
    const positions: [string, (good: D1PreparedStatement[], bad: D1PreparedStatement) => D1PreparedStatement[]][] = [
      ["first", (good, bad) => [bad, ...good]],
      ["in the middle", (good, bad) => [good[0], bad, ...good.slice(1)]],
      ["last", (good, bad) => [...good, bad]],
    ];
    for (const [name, arrange] of positions) {
      await t.test(`a batch that fails with the bad statement ${name} leaves no item`, async () => {
        await clearOutbox(db);
        const booking = await seedBooking(db, { status: "PAYMENT_PENDING" });
        const items = [emailItem(booking.id), sheetItem(booking.id)];
        const good = [confirm(booking.id), ...enqueueStatements(db, items, T0)];

        await assert.rejects(db.batch(arrange(good, confirm(booking.id, "NOT_A_STATUS"))), /CHECK constraint failed/);

        assert.deepEqual(await allRows(db), []);
        assert.equal(await bookingStatus(booking.id), "PAYMENT_PENDING");
      });
    }
  }));

test("dedupe keys enqueue once", (t) =>
  withDb(async (db) => {
    await t.test("again later, the first enqueue wins", async () => {
      await clearOutbox(db);
      const first = emailItem("b-1");
      const second = { ...first, payload: { ...first.payload, to: "someone-else@example.com" } };
      await enqueue(db, [first], T0);
      await enqueue(db, [second], T0 + HOUR_MS);

      const rows = await allRows(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].created_at, T0);
      assert.equal(rows[0].next_attempt_at, T0);

      const s = senders();
      assert.deepEqual(await drain(db, T0 + HOUR_MS, s), { ...NOTHING, sent: 1 });
      assert.deepEqual(
        s.emails.map((email) => email.payload),
        [first.payload],
      );
    });

    await t.test("twice in one batch", async () => {
      await clearOutbox(db);
      await enqueue(db, [sheetItem("b-2"), sheetItem("b-2"), emailItem("b-2"), emailItem("b-2")], T0);
      assert.equal((await allRows(db)).length, 2);
    });

    await t.test("keys that differ by template or status stay separate items", async () => {
      await clearOutbox(db);
      const items = [
        emailItem("b-3", "guest_confirmation"),
        emailItem("b-3", "staff_new_booking"),
        emailItem("b-3", "guest_cancellation"),
        emailItem("b-4", "guest_confirmation"),
        sheetItem("b-3", "CONFIRMED"),
        sheetItem("b-3", "CANCELLED"),
        sheetItem("b-4", "CONFIRMED"),
      ];
      await enqueue(db, items, T0);
      assert.deepEqual(
        (await allRows(db)).map((row) => row.dedupe_key),
        [
          "email:guest_confirmation:b-3",
          "email:staff_new_booking:b-3",
          "email:guest_cancellation:b-3",
          "email:guest_confirmation:b-4",
          "sheet:b-3:CONFIRMED",
          "sheet:b-3:CANCELLED",
          "sheet:b-4:CONFIRMED",
        ],
      );
    });

    for (const [settled, reply] of [
      ["sent", () => OK],
      ["dead", () => ({ ok: false, retryable: false, error: "bad address" })],
    ] as [string, () => SendResult][]) {
      await t.test(`a key already ${settled} is not sent again`, async () => {
        await clearOutbox(db);
        const item = emailItem("b-5");
        await enqueue(db, [item], T0);
        await drain(db, T0, senders(reply));
        assert.equal((await rowOf(db, item)).status, settled);

        await enqueue(db, [item], T0 + DAY_MS);

        const later = senders();
        assert.deepEqual(await drain(db, T0 + DAY_MS, later), NOTHING);
        assert.equal(later.emails.length, 0);
        assert.equal((await rowOf(db, item)).status, settled);
      });
    }
  }));

test("concurrent drains do not double-send", (t) =>
  withDb(async (db) => {
    const round = (name: string) => {
      const emails = Array.from({ length: 8 }, (_, index) => `${name}-e${index}`);
      const sheets = Array.from({ length: 4 }, (_, index) => `${name}-s${index}`);
      return {
        items: [...emails.map((id) => emailItem(id)), ...sheets.map((id) => sheetItem(id))],
        expected: [...emails, ...sheets].sort(),
      };
    };

    await t.test("drains started together share the items out", async () => {
      // The senders hold each call open so that any drain still deciding what to take sees the others' claims.
      const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
      for (let index = 0; index < 5; index += 1) {
        await clearOutbox(db);
        const { items, expected } = round(`together-${index}`);
        await enqueue(db, items, T0);

        const rivals = [senders(undefined, slow), senders(undefined, slow), senders(undefined, slow), senders(undefined, slow)];
        const results = await Promise.all(rivals.map((s) => drain(db, T0, s, 100)));

        assert.deepEqual(delivered(...rivals), expected);
        assert.equal(results.reduce((sum, result) => sum + result.sent, 0), items.length);
        assert.equal(results.reduce((sum, result) => sum + result.retried, 0), 0);
        assert.deepEqual(results.flatMap((result) => result.dead), []);
        assert.ok((await allRows(db)).every((row) => row.status === "sent"));
      }
    });

    await t.test("a drain that starts while another is mid-send takes nothing that drain holds", async () => {
      await clearOutbox(db);
      const { items, expected } = round("nested");
      await enqueue(db, items, T0);

      const inner = senders();
      let rival: ReturnType<typeof drain> | undefined;
      const outer = senders(undefined, async () => {
        rival ??= drain(db, T0, inner, 100);
        await rival;
      });
      const result = await drain(db, T0, outer, 100);

      assert.notEqual(rival, undefined);
      assert.deepEqual(delivered(outer, inner), expected);
      assert.equal(result.sent + (await rival)!.sent, items.length);
    });
  }));

test("failures back off and die after eight attempts", (t) =>
  withDb(async (db) => {
    for (const { kind, item } of BOTH_KINDS) {
      await t.test(`one ${kind} item through every attempt`, async () => {
        await clearOutbox(db);
        const entry = item("walk");
        await enqueue(db, [entry], T0);
        const s = senders(outage);
        const calls = () => s.emails.length + s.syncs.length;

        let due = T0;
        for (const [index, wait] of BACKOFF_MS.entries()) {
          const attempt = index + 1;
          assert.deepEqual(await drain(db, due - 1, s), NOTHING, `attempt ${attempt}, a millisecond early`);
          assert.equal(calls(), attempt - 1);

          // Drains run late, so the wait must count from the failure and not from the time the item fell due.
          const now = due + attempt * 1_234;
          assert.deepEqual(await drain(db, now, s), { sent: 0, retried: 1, dead: [] }, `attempt ${attempt}`);
          assert.equal(calls(), attempt);

          const row = await rowOf(db, entry);
          assert.equal(row.status, "pending", `attempt ${attempt}`);
          assert.equal(row.attempts, attempt);
          assert.equal(row.next_attempt_at, now + wait, `attempt ${attempt}`);
          assert.equal(row.last_error, `outage ${attempt}`);
          due = row.next_attempt_at;
        }

        const { id } = await rowOf(db, entry);
        assert.deepEqual(await drain(db, due, s), {
          sent: 0,
          retried: 0,
          dead: [{ id, kind, lastError: `outage ${MAX_ATTEMPTS}` }],
        });
        const row = await rowOf(db, entry);
        assert.equal(row.status, "dead");
        assert.equal(row.attempts, MAX_ATTEMPTS);
        assert.equal(row.last_error, `outage ${MAX_ATTEMPTS}`);

        // Dead is final, and an item is reported dead once.
        assert.deepEqual(await drain(db, due + 30 * DAY_MS, s), NOTHING);
        assert.equal(calls(), MAX_ATTEMPTS);
      });
    }

    await t.test("each item keeps its own count when a whole drain fails", async () => {
      await clearOutbox(db);
      const now = T0 + DAY_MS;
      const cases = Array.from({ length: MAX_ATTEMPTS }, (_, attempts) => ({
        attempts,
        email: emailItem(`e${attempts}`),
        sheet: sheetItem(`s${attempts}`),
      }));
      await enqueue(db, cases.flatMap(({ email, sheet }) => [email, sheet]), T0);
      for (const { attempts, email, sheet } of cases) {
        await patchRow(db, email, { attempts });
        await patchRow(db, sheet, { attempts });
      }

      const s = senders(() => ({ ok: false, retryable: true, error: "down" }));
      const result = await drain(db, now, s, 100);

      assert.equal(result.sent, 0);
      assert.equal(result.retried, 2 * (MAX_ATTEMPTS - 1));
      const last = cases[MAX_ATTEMPTS - 1];
      assert.deepEqual(
        byId(result.dead),
        byId([
          { id: (await rowOf(db, last.email)).id, kind: "email", lastError: "down" },
          { id: (await rowOf(db, last.sheet)).id, kind: "sheet_booking", lastError: "down" },
        ]),
      );
      assert.equal(s.syncs.length, 1);
      for (const { attempts, email, sheet } of cases) {
        for (const entry of [email, sheet]) {
          const row = await rowOf(db, entry);
          assert.equal(row.attempts, attempts + 1, entry.dedupeKey);
          if (attempts === MAX_ATTEMPTS - 1) {
            assert.equal(row.status, "dead", entry.dedupeKey);
          } else {
            assert.equal(row.status, "pending", entry.dedupeKey);
            assert.equal(row.next_attempt_at, now + BACKOFF_MS[attempts], entry.dedupeKey);
          }
        }
      }
    });
  }));

test("retryAt from a sender is honoured", (t) =>
  withDb(async (db) => {
    const fail = (retryAt: number): SendResult => ({ ok: false, retryable: true, retryAt, error: "quota" });

    // [attempts already made, how far ahead retryAt is]. It wins whether it is sooner or later than the backoff.
    const cases: [number, number][] = [
      [0, 10 * SECOND_MS],
      [0, 3 * DAY_MS],
      [3, 45 * MINUTE_MS],
      [5, 7 * MINUTE_MS],
      [6, 17 * HOUR_MS],
    ];
    for (const { kind, item } of BOTH_KINDS) {
      for (const [attempts, ahead] of cases) {
        await t.test(`${kind} after ${attempts} attempts, ${ahead} ms ahead`, async () => {
          await clearOutbox(db);
          const entry = item("quota");
          const now = T0 + HOUR_MS;
          const retryAt = now + ahead;
          await enqueue(db, [entry], T0);
          await patchRow(db, entry, { attempts });

          const s = senders(() => fail(retryAt));
          assert.deepEqual(await drain(db, now, s), { sent: 0, retried: 1, dead: [] });

          const row = await rowOf(db, entry);
          assert.equal(row.status, "pending");
          assert.equal(row.attempts, attempts + 1);
          assert.equal(row.next_attempt_at, retryAt);
          assert.equal(row.last_error, "quota");

          const retry = senders();
          assert.deepEqual(await drain(db, retryAt - 1, retry), NOTHING);
          assert.deepEqual(await drain(db, retryAt, retry), { sent: 1, retried: 0, dead: [] });
          assert.equal((await rowOf(db, entry)).status, "sent");
        });
      }

      await t.test(`${kind}: a plain failure after retryAt resumes the schedule`, async () => {
        await clearOutbox(db);
        const entry = item("resume");
        await enqueue(db, [entry], T0);
        const retryAt = T0 + 3 * DAY_MS;
        await drain(db, T0, senders(() => fail(retryAt)));

        await drain(db, retryAt, senders(outage));

        const row = await rowOf(db, entry);
        assert.equal(row.attempts, 2);
        assert.equal(row.next_attempt_at, retryAt + BACKOFF_MS[1]);
      });

      await t.test(`${kind}: retryAt does not save the eighth failure`, async () => {
        await clearOutbox(db);
        const entry = item("eighth");
        await enqueue(db, [entry], T0);
        await patchRow(db, entry, { attempts: MAX_ATTEMPTS - 1 });

        const result = await drain(db, T0, senders(() => fail(T0 + DAY_MS)));

        const { id, status } = await rowOf(db, entry);
        assert.equal(status, "dead");
        assert.deepEqual(result, { sent: 0, retried: 0, dead: [{ id, kind, lastError: "quota" }] });
      });
    }
  }));

test("sheet items are batched into one call", (t) =>
  withDb(async (db) => {
    // [sheet items, emails, limit]. 120 ids is more than one D1 statement can bind, so the row updates must cope.
    const cases: [number, number, number | undefined][] = [
      [1, 0, undefined],
      [2, 1, undefined],
      [7, 3, undefined],
      [120, 0, 200],
    ];
    for (const [sheets, emails, limit] of cases) {
      await t.test(`${sheets} sheet items and ${emails} emails`, async () => {
        await clearOutbox(db);
        const ids = Array.from({ length: sheets }, (_, index) => `s-${index}`);
        const items = [
          ...ids.map((id) => sheetItem(id)),
          ...Array.from({ length: emails }, (_, index) => emailItem(`e-${index}`)),
        ];
        await enqueue(db, items, T0);

        const s = senders();
        const result = await drain(db, T0, s, limit);

        assert.equal(s.syncs.length, 1);
        assert.deepEqual([...s.syncs[0]].sort(), [...ids].sort());
        assert.equal(s.emails.length, emails);
        assert.deepEqual(result, { sent: sheets + emails, retried: 0, dead: [] });
        assert.ok((await allRows(db)).every((row) => row.status === "sent"));
      });
    }

    await t.test("the sheet sender is not called when no sheet item is due", async () => {
      await clearOutbox(db);
      await enqueue(db, [emailItem("e-1"), emailItem("e-2")], T0);
      await enqueue(db, [sheetItem("later")], T0 + DAY_MS);

      const s = senders();
      assert.deepEqual(await drain(db, T0, s), { sent: 2, retried: 0, dead: [] });
      assert.deepEqual(s.syncs, []);
    });

    await t.test("two statuses of one booking both finish with that call", async () => {
      await clearOutbox(db);
      const items = [sheetItem("b-1", "CONFIRMED"), sheetItem("b-1", "CANCELLED"), sheetItem("b-2")];
      await enqueue(db, items, T0);

      const s = senders();
      assert.deepEqual(await drain(db, T0, s), { sent: 3, retried: 0, dead: [] });

      assert.equal(s.syncs.length, 1);
      assert.deepEqual([...new Set(s.syncs[0])].sort(), ["b-1", "b-2"]);
      assert.ok((await allRows(db)).every((row) => row.status === "sent"));
    });
  }));

test("stale claims return to pending", (t) =>
  withDb(async (db) => {
    await t.test("a drain that dies mid-send frees its item after ten minutes and no sooner", async () => {
      await clearOutbox(db);
      const item = emailItem("crash");
      const claimAt = T0 + 5 * MINUTE_MS;
      await enqueue(db, [item], T0);

      let sending!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        sending = resolve;
      });
      let release!: () => void;
      const hung = new Promise<void>((resolve) => {
        release = resolve;
      });
      const crashed = senders(undefined, () => {
        sending();
        return hung;
      });
      const abandoned = drain(db, claimAt, crashed);

      try {
        await inFlight;
        const claimed = await rowOf(db, item);
        assert.equal(claimed.status, "sending");
        assert.equal(claimed.claimed_at, claimAt);

        const retry = senders();
        assert.deepEqual(await drain(db, claimAt + 10 * MINUTE_MS, retry), NOTHING);
        assert.equal(retry.emails.length, 0);
        assert.equal((await rowOf(db, item)).status, "sending");

        await drain(db, claimAt + 10 * MINUTE_MS + 1, retry);
        assert.notEqual((await rowOf(db, item)).status, "sending");

        await drain(db, claimAt + HOUR_MS, retry);
        assert.equal(retry.emails.length, 1);
        assert.equal((await rowOf(db, item)).status, "sent");

        // The first send may have gone out before the crash, so the mail service must see the same message id.
        assert.equal(retry.emails[0].messageId, crashed.emails[0].messageId);
      } finally {
        release();
        await abandoned;
      }
    });

    await t.test("claims are judged by their age and status", async () => {
      await clearOutbox(db);
      const now = T0 + DAY_MS;
      const freshAges = [0, MINUTE_MS, 10 * MINUTE_MS - 1, 10 * MINUTE_MS];
      const staleAges = [10 * MINUTE_MS + 1, 11 * MINUTE_MS, HOUR_MS];
      const claim = async (make: (id: string) => OutboxItem, id: string, age: number) => {
        const item = make(id);
        await enqueue(db, [item], T0);
        await patchRow(db, item, { status: "sending", claimed_at: now - age });
        return item;
      };

      const fresh: { item: OutboxItem; age: number }[] = [];
      const stale: OutboxItem[] = [];
      const staleIds: string[] = [];
      for (const { kind, item: make } of BOTH_KINDS) {
        for (const age of freshAges) fresh.push({ item: await claim(make, `fresh-${kind}-${age}`, age), age });
        for (const age of staleAges) {
          const id = `stale-${kind}-${age}`;
          stale.push(await claim(make, id, age));
          staleIds.push(id);
        }
      }

      // Finished rows keep their old claimed_at, which must not bring them back.
      const finished: [OutboxItem, string][] = [
        [emailItem("finished-sent"), "sent"],
        [emailItem("finished-dead"), "dead"],
        [sheetItem("finished-sheet"), "sent"],
      ];
      for (const [item, status] of finished) {
        await enqueue(db, [item], T0);
        await patchRow(db, item, { status, claimed_at: now - DAY_MS });
      }

      const first = senders();
      await drain(db, now, first, 100);

      for (const { item, age } of fresh) {
        const row = await rowOf(db, item);
        assert.equal(row.status, "sending", item.dedupeKey);
        assert.equal(row.claimed_at, now - age, item.dedupeKey);
      }
      for (const item of stale) {
        assert.notEqual((await rowOf(db, item)).status, "sending", item.dedupeKey);
      }

      const second = senders();
      await drain(db, now + HOUR_MS, second, 100);

      const sentOnce = delivered(first, second).filter((id) => id.startsWith("stale-"));
      assert.deepEqual(sentOnce, [...staleIds].sort());
      for (const item of stale) assert.equal((await rowOf(db, item)).status, "sent", item.dedupeKey);
      for (const [item, status] of finished) assert.equal((await rowOf(db, item)).status, status, item.dedupeKey);
      assert.equal(delivered(first, second).filter((id) => id.startsWith("finished-")).length, 0);
    });
  }));

test("payloads reach the senders unchanged", () =>
  withDb(async (db) => {
    const templates: EmailPayload["template"][] = [
      "guest_confirmation",
      "guest_cancellation",
      "staff_new_booking",
      "staff_cancellation",
      "staff_alert",
      "reconcile_report",
    ];
    const hostile = `O'Brien"; DROP TABLE outbox; --`;
    const items = templates.flatMap((template) =>
      LOCALES.map((locale): EmailItem => {
        const bookingId = `${template}-${locale}-${hostile}`;
        return {
          kind: "email",
          dedupeKey: `email:${template}:${bookingId}`,
          payload: {
            template,
            locale,
            to: `${locale}+'quoted'@example.com`,
            data: { bookingId, guest: "山田 太郎", total: 12000, nested: { list: [1, "二", null], flag: false } },
          },
        };
      }),
    );
    const sheet: OutboxItem = { kind: "sheet_booking", dedupeKey: `sheet:${hostile}:CONFIRMED`, payload: { bookingId: hostile } };
    await enqueue(db, [...items, sheet], T0);

    const s = senders();
    assert.deepEqual(await drain(db, T0, s, 100), { sent: items.length + 1, retried: 0, dead: [] });

    const received = new Map(s.emails.map(({ payload }) => [`${payload.template}/${payload.locale}`, payload]));
    assert.equal(s.emails.length, items.length);
    for (const { payload } of items) {
      assert.deepEqual(received.get(`${payload.template}/${payload.locale}`), payload);
    }
    assert.deepEqual(s.syncs, [[hostile]]);
  }));

test("only due items are claimed, up to the limit", (t) =>
  withDb(async (db) => {
    await t.test("an item falls due at its next_attempt_at", async () => {
      await clearOutbox(db);
      await enqueue(db, [emailItem("soon")], T0);
      await enqueue(db, [emailItem("later")], T0 + HOUR_MS);

      const s = senders();
      assert.deepEqual(await drain(db, T0 - 1, s), NOTHING);
      assert.deepEqual(await drain(db, T0, s), { sent: 1, retried: 0, dead: [] });
      assert.deepEqual(await drain(db, T0 + HOUR_MS - 1, s), NOTHING);
      assert.deepEqual(await drain(db, T0 + HOUR_MS, s), { sent: 1, retried: 0, dead: [] });
      assert.deepEqual(delivered(s), ["later", "soon"]);
      assert.deepEqual(await drain(db, T0 + DAY_MS, s), NOTHING);
    });

    // [limit, items sent by each drain until five are done]. Both kinds count towards the same limit.
    const cases: [number, number[]][] = [
      [1, [1, 1, 1, 1, 1]],
      [2, [2, 2, 1]],
      [3, [3, 2]],
      [5, [5]],
      [9, [5]],
    ];
    for (const [limit, expected] of cases) {
      await t.test(`limit ${limit}`, async () => {
        await clearOutbox(db);
        const items = [emailItem("a"), sheetItem("b"), emailItem("c"), sheetItem("d"), emailItem("e")];
        await enqueue(db, items, T0);

        const s = senders();
        for (const [index, count] of expected.entries()) {
          assert.deepEqual(await drain(db, T0, s, limit), { sent: count, retried: 0, dead: [] }, `drain ${index + 1}`);
        }
        assert.deepEqual(delivered(s), ["a", "b", "c", "d", "e"]);
        assert.deepEqual(await drain(db, T0, s, limit), NOTHING);
      });
    }
  }));

test("a non-retryable failure goes dead at once", (t) =>
  withDb(async (db) => {
    const fail = (error: string, retryAt?: number): SendResult => ({ ok: false, retryable: false, retryAt, error });

    // [attempts already made, a retryAt the sender also gave]. Neither buys another try.
    const cases: [number, number | undefined][] = [
      [0, undefined],
      [3, undefined],
      [0, T0 + HOUR_MS],
    ];
    for (const { kind, item } of BOTH_KINDS) {
      for (const [attempts, retryAt] of cases) {
        await t.test(`${kind} after ${attempts} attempts, retryAt ${retryAt}`, async () => {
          await clearOutbox(db);
          const entry = item("refused");
          const error = `refused at attempt ${attempts}`;
          await enqueue(db, [entry], T0);
          await patchRow(db, entry, { attempts });

          const s = senders(() => fail(error, retryAt));
          const result = await drain(db, T0, s);

          const row = await rowOf(db, entry);
          assert.deepEqual(result, { sent: 0, retried: 0, dead: [{ id: row.id, kind, lastError: error }] });
          assert.equal(row.status, "dead");
          assert.equal(row.attempts, attempts + 1);
          assert.equal(row.last_error, error);

          assert.deepEqual(await drain(db, T0 + 30 * DAY_MS, s), NOTHING);
          assert.equal(s.emails.length + s.syncs.length, 1);
        });
      }
    }

    await t.test("a refused sheet call kills every item it carried", async () => {
      await clearOutbox(db);
      const items = [sheetItem("a"), sheetItem("b"), sheetItem("c")];
      await enqueue(db, items, T0);

      const result = await drain(db, T0, senders(() => fail("sheet is gone")));

      assert.equal(result.retried, 0);
      assert.deepEqual(
        byId(result.dead),
        (await allRows(db)).map(({ id }) => ({ id, kind: "sheet_booking", lastError: "sheet is gone" })),
      );
      assert.ok((await allRows(db)).every((row) => row.status === "dead"));
    });
  }));

test("messageId is stable across retries and differs between items", () =>
  withDb(async (db) => {
    const items = [emailItem("a"), emailItem("b"), emailItem("a", "staff_new_booking")];
    await enqueue(db, items, T0);

    let failing = true;
    const s = senders((call) => (failing ? outage(call) : OK));
    for (const day of [0, 1, 2]) await drain(db, T0 + day * DAY_MS, s);
    failing = false;
    assert.deepEqual(await drain(db, T0 + 3 * DAY_MS, s), { sent: 3, retried: 0, dead: [] });

    const seen = new Map<string, Set<string>>();
    for (const { payload, messageId } of s.emails) {
      const key = `${payload.template}:${payload.to}`;
      seen.set(key, (seen.get(key) ?? new Set()).add(messageId));
    }
    assert.equal(s.emails.length, 4 * items.length);
    assert.equal(seen.size, items.length);
    for (const [key, ids] of seen) {
      assert.equal(ids.size, 1, `${key} got ${[...ids].join(", ")}`);
      assert.ok([...ids][0].length > 0, key);
    }
    assert.equal(new Set([...seen.values()].flatMap((ids) => [...ids])).size, items.length);
  }));

test("one failure does not hold back the rest of a drain", (t) =>
  withDb(async (db) => {
    const later: SendResult = { ok: false, retryable: true, error: "try later" };
    const refused: SendResult = { ok: false, retryable: false, error: "bad address" };

    // Failing items are enqueued first, so a drain that stopped at its first failure would leave the rest behind.
    const cases: { name: string; emails: [string, SendResult][]; sheet: SendResult; expected: object }[] = [
      {
        name: "failing emails, then good emails and sheet items",
        emails: [["later", later], ["refused", refused], ["good", OK]],
        sheet: OK,
        expected: { sent: 3, retried: 1 },
      },
      {
        name: "a failing sheet call, with good emails",
        emails: [["good-1", OK], ["good-2", OK]],
        sheet: later,
        expected: { sent: 2, retried: 2 },
      },
      {
        name: "failing emails, with a refused sheet call",
        emails: [["later", later], ["good", OK]],
        sheet: refused,
        expected: { sent: 1, retried: 1 },
      },
    ];
    for (const { name, emails, sheet, expected } of cases) {
      await t.test(name, async () => {
        await clearOutbox(db);
        const emailItems = emails.map(([id]) => emailItem(id));
        const sheetItems = [sheetItem("row-1"), sheetItem("row-2")];
        await enqueue(db, [...emailItems, ...sheetItems], T0);

        const answers = new Map(emails);
        const seen: string[] = [];
        const result = await drainOutbox({
          db,
          now: T0,
          sendEmail: async (payload) => {
            const id = String(payload.data.bookingId);
            seen.push(id);
            return answers.get(id) ?? OK;
          },
          syncBookings: async (ids) => {
            seen.push(...ids);
            return sheet;
          },
        });

        assert.deepEqual([...seen].sort(), [...emails.map(([id]) => id), "row-1", "row-2"].sort());
        assert.deepEqual({ sent: result.sent, retried: result.retried }, expected);

        const statusFor = (answer: SendResult) => {
          if (answer.ok) return "sent";
          return answer.retryable ? "pending" : "dead";
        };
        for (const [index, [, answer]] of emails.entries()) {
          assert.equal((await rowOf(db, emailItems[index])).status, statusFor(answer), emails[index][0]);
        }
        for (const entry of sheetItems) assert.equal((await rowOf(db, entry)).status, statusFor(sheet));
        const deadCount = (await allRows(db)).filter((row) => row.status === "dead").length;
        assert.equal(result.dead.length, deadCount);
      });
    }
  }));

test("a thrown sender error is a retryable failure", (t) =>
  withDb(async (db) => {
    const now = T0 + HOUR_MS;

    // A sender can fail with a rejected promise, or throw before it has returned one.
    const raises: [string, (error: Error) => Promise<SendResult>][] = [
      ["rejects", (error) => Promise.reject(error)],
      [
        "throws",
        (error) => {
          throw error;
        },
      ],
    ];
    for (const [how, raise] of raises) {
      for (const { kind, item } of BOTH_KINDS) {
        for (const attempts of [0, 3, 6, MAX_ATTEMPTS - 1]) {
          await t.test(`${kind} ${how} after ${attempts} attempts`, async () => {
            await clearOutbox(db);
            const error = `${how} ${kind} ${attempts}`;
            const broken = item("broken");
            // Enqueued after the broken item, so a drain that stopped at the throw would leave them behind. A sheet
            // sibling only for email: sheet items share one call, so they would share the throw.
            const siblings = [emailItem("sibling-email"), ...(kind === "email" ? [sheetItem("sibling-sheet")] : [])];
            await enqueue(db, [broken, ...siblings], T0);
            await patchRow(db, broken, { attempts });

            const seen: string[] = [];
            const result = await drainOutbox({
              db,
              now,
              sendEmail: (payload) => {
                const id = String(payload.data.bookingId);
                if (id === "broken") return raise(new Error(error));
                seen.push(id);
                return Promise.resolve(OK);
              },
              syncBookings: (ids) => {
                if (ids.includes("broken")) return raise(new Error(error));
                seen.push(...ids);
                return Promise.resolve(OK);
              },
            });

            // Reaching this line is the proof that the drain resolved.
            const row = await rowOf(db, broken);
            const dies = attempts === MAX_ATTEMPTS - 1;
            assert.deepEqual(result, {
              sent: siblings.length,
              retried: dies ? 0 : 1,
              dead: dies ? [{ id: row.id, kind, lastError: error }] : [],
            });
            assert.equal(row.attempts, attempts + 1);
            assert.equal(row.last_error, error);
            assert.equal(row.status, dies ? "dead" : "pending");
            if (!dies) assert.equal(row.next_attempt_at, now + BACKOFF_MS[attempts]);

            assert.deepEqual(
              [...seen].sort(),
              siblings.map((sibling) => (sibling.kind === "email" ? "sibling-email" : "sibling-sheet")).sort(),
            );
            for (const sibling of siblings) assert.equal((await rowOf(db, sibling)).status, "sent", sibling.dedupeKey);
          });
        }
      }
    }
  }));
