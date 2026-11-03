// The sheet's Blocks rows become bookings that hold a bike through the overlap rule. D1 has no transactions and a guest's
// hold can land between any two statements, so a write that takes a bike picks it inside that one statement, as a hold
// does, and what the row is told comes from what the write did. docs/sheet-schema.md is the staff's view of the rules.
import type { ValidBlock } from "../catalog/sheet-schema.ts";
import { randomRef, sha256Hex } from "../crypto.ts";
import { BLOCKING_SQL, OVERLAP_SQL } from "../db/blocking.ts";
import { readShopConfig } from "../db/config.ts";
import type { BookingStatus } from "../types.ts";
import { assignFreeVehicleSql } from "./holds.ts";

/** blockId is "" for a problem of the tab as a whole. */
export type BlockStatus = { blockId: string; level: "ok" | "warning" | "error"; message: string };

export type SyncOptions = {
  maxChanges?: number;
  /** The ids of rows the sheet check rejected. They count as still on the sheet. */
  skippedBlockIds?: string[];
  /** How many rows the sheet check rejected for a blank block_id: any stored block may be one of them. */
  blankIdRows?: number;
  /** The `cursor` of the call before, to go on from it. */
  cursor?: string | null;
};

export type SyncResult = {
  /** Each row once, except a change an earlier call of this pass already tried. A cancel has no row to tell. */
  statuses: BlockStatus[];
  processed: number;
  remaining: number;
  /** Where the next call of this pass starts, or null when nothing remains. */
  cursor: string | null;
  /** Whether the call went on from `cursor`. False for a first call, and for a cursor that restarted the pass. */
  resumed: boolean;
};

/** A row of `bookings`, as far as a sync reads it. */
type StoredBlock = {
  id: string;
  blockId: string;
  status: BookingStatus;
  plate: string;
  modelId: string;
  startAt: number;
  endAt: number;
  hash: string | null;
};

const MINUTE_MS = 60_000;

/** Workers Free allows 50 D1 queries per invocation, and a failed change costs two: the write and the read of why. */
const MAX_CHANGES = 20;

const CURSOR_PREFIX = "next:";

const CANCEL_REASON = "The row left the Blocks tab";

const EMPTY_TAB =
  "The tab has no data rows, so no stored block was cancelled. To cancel them, keep one row while removing the others.";

const BLANK_ID =
  "A row has a blank block_id and may be a stored block, so no block was cancelled. Fill it in and Publish again.";

const NOT_TRIED = "Not synced yet: this Publish stopped at its limit. Press Publish again.";

const ENDED = "This block has ended, so the change was not applied.";

// The rows the sheet names and the blocks still to run: a sync can act on no others, and old blocks only grow. The ids go
// as one JSON parameter, so a tab of any size stays within D1's 100 bound parameters.
const STORED_SQL = `SELECT id, external_ref AS blockId, status, vehicle_plate AS plate, model_id AS modelId,
    start_at AS startAt, end_at AS endAt, content_hash AS hash
  FROM bookings
  WHERE source = 'block' AND (external_ref IN (SELECT value FROM json_each(?1)) OR (status = 'CONFIRMED' AND end_at > ?2))
  ORDER BY external_ref`;

// What a move binds, in a statement of its own or as the read that says why it failed: ?1 to ?5 are q, ?6 is the booking,
// which never stands in its own way, ?7 the plate it asks for and ?8 is 1 for a blank plate, when any free active bike
// of the model will do. Then ?7 is the bike the block stands on, if it is stored.
const ASKED_SQL = "WITH q(s, e, buf, now, model) AS (SELECT ?1, ?2, ?3, ?4, ?5)";

// A named plate need not be active, but a blank-plate block keeps its bike only while that bike is active. Otherwise it
// moves, so that a bike taken out of service sheds it. assignFreeVehicleSql counts the booking's own row as busy, which
// does no harm: it runs only once ?7, the one bike that row can be on, has been refused.
const PICK_SQL = `${ASKED_SQL},
  pick(plate) AS (SELECT COALESCE(
    (SELECT v.plate FROM vehicles v
      WHERE v.plate = ?7 AND v.model_id = (SELECT model FROM q) AND (?8 = 0 OR v.status = 'active')
        AND NOT EXISTS (
          SELECT 1 FROM bookings b WHERE b.vehicle_plate = v.plate AND b.id <> ?6 AND ${BLOCKING_SQL} AND ${OVERLAP_SQL}
        )),
    CASE WHEN ?8 = 1 THEN (${assignFreeVehicleSql}) END
  ))`;

// ?9 and on follow ASKED_SQL. A taken external_ref or ref inserts nothing, which reads as no free bike until the next run.
const INSERT_SQL = `${PICK_SQL}
  INSERT INTO bookings (id, ref, status, source, model_id, vehicle_plate, start_at, end_at, external_ref,
    external_channel, content_hash, created_at, updated_at, confirmed_at)
  SELECT ?6, ?9, 'CONFIRMED', 'block', ?5, plate, ?1, ?2, ?10, ?11, ?12, ?4, ?4, ?4 FROM pick WHERE plate IS NOT NULL
  ON CONFLICT DO NOTHING
  RETURNING vehicle_plate`;

// A row that returned after its block was cancelled comes through here too, so this statement also reinstates.
const MOVE_SQL = `${PICK_SQL}
  UPDATE bookings SET vehicle_plate = pick.plate, model_id = ?5, start_at = ?1, end_at = ?2, external_channel = ?9,
    content_hash = ?10, status = 'CONFIRMED', cancelled_at = NULL, cancel_reason = NULL, updated_at = ?4
  FROM pick
  WHERE bookings.id = ?6 AND pick.plate IS NOT NULL
  RETURNING vehicle_plate`;

// Only the bikes PICK_SQL may take, so the row is never told of a booking on a bike it could not have had.
const BLOCKER_SQL = `${ASKED_SQL}
  SELECT CASE b.source WHEN 'block' THEN b.external_ref ELSE b.ref END AS name, v.plate AS plate
  FROM vehicles v JOIN bookings b ON b.vehicle_plate = v.plate
  WHERE v.model_id = (SELECT model FROM q) AND (v.plate = ?7 OR ?8 = 1) AND (?8 = 0 OR v.status = 'active')
    AND b.id <> ?6 AND ${BLOCKING_SQL} AND ${OVERLAP_SQL}
  ORDER BY v.plate, b.start_at, b.id
  LIMIT 1`;

// Nothing moves, so no bike has to be free: an overlap the block predates stays its own business.
const TEXT_SQL = "UPDATE bookings SET external_channel = ?1, content_hash = ?2, updated_at = ?3 WHERE id = ?4";

const CANCEL_SQL = `UPDATE bookings SET status = 'CANCELLED', cancel_reason = ?3, cancelled_at = ?2, updated_at = ?2
  WHERE source = 'block' AND status = 'CONFIRMED' AND end_at > ?2 AND external_ref IN (SELECT value FROM json_each(?1))`;

function ok(blockId: string): BlockStatus {
  return { blockId, level: "ok", message: "ok" };
}

/**
 * What content_hash keeps of the row: a digest of the whole row, so that an unchanged row costs no write, then after a
 * dot one of its plate alone. A staff override moves the bike and leaves content_hash as it was, so the second part is
 * how a later sync tells an edit to the plate column from a bike staff chose. JSON keeps each column to its own place,
 * so text moved from one column to the next is a change.
 */
async function contentHash({ modelId, plate, startAt, endAt, channel, reference, note }: ValidBlock): Promise<string> {
  const row = await sha256Hex(JSON.stringify([modelId, plate, startAt, endAt, channel, reference, note]));
  return `${row}.${await sha256Hex(JSON.stringify(plate))}`;
}

/** The digest of the plate a content hash was made from. A hash from before it had one gives undefined. */
function plateDigest(hash: string | null): string | undefined {
  return hash?.split(".")[1];
}

/** What the row is told without a write, or null when it is a change. Ended blocks are left alone in every path. */
function settledStatus(block: ValidBlock, hash: string, row: StoredBlock | undefined, now: number): BlockStatus | null {
  if (row === undefined) return null;
  if (row.status === "CONFIRMED" && row.hash === hash) return ok(block.blockId);
  return row.endAt <= now ? { blockId: block.blockId, level: "warning", message: ENDED } : null;
}

/**
 * Whether the change must take a bike through the overlap rule. A named plate counts only when the row changed it since
 * the last sync, because the block may stand where a staff override put it, and only when the block is not on it yet.
 */
function movesBike(block: ValidBlock, hash: string, row: StoredBlock): boolean {
  return (
    row.status !== "CONFIRMED" ||
    row.startAt !== block.startAt ||
    row.endAt !== block.endAt ||
    row.modelId !== block.modelId ||
    (block.plate !== null && block.plate !== row.plate && plateDigest(hash) !== plateDigest(row.hash))
  );
}

/** One write, conditional where it takes a bike. A write that finds none leaves every column as it was. */
async function applyChange(
  db: D1Database,
  block: ValidBlock,
  hash: string,
  row: StoredBlock | undefined,
  bufMs: number,
  now: number,
): Promise<BlockStatus> {
  const { blockId, channel, modelId, startAt, endAt } = block;
  if (row !== undefined && !movesBike(block, hash, row)) {
    await db.prepare(TEXT_SQL).bind(channel, hash, now, row.id).run();
    return ok(blockId);
  }

  const id = row?.id ?? crypto.randomUUID();
  const asked = [startAt, endAt, bufMs, now, modelId, id, block.plate ?? row?.plate ?? null, block.plate === null ? 1 : 0];
  const write =
    row === undefined
      ? db.prepare(INSERT_SQL).bind(...asked, randomRef(), blockId, channel, hash)
      : db.prepare(MOVE_SQL).bind(...asked, channel, hash);
  if ((await write.first()) !== null) return ok(blockId);

  const blocker = await db.prepare(BLOCKER_SQL).bind(...asked).first<{ name: string; plate: string }>();
  if (blocker === null) return { blockId, level: "error", message: `No vehicle of ${modelId} is free` };
  return { blockId, level: "error", message: `Conflicts with ${blocker.name} on ${blocker.plate}` };
}

/**
 * Brings the stored blocks in line with the valid rows of the tab. Each call makes at most `maxChanges` changes, cancels
 * first so that a row can take what a deleted one freed. A failed attempt counts and stays a change, so a pass goes on
 * through the returned `cursor` past the rows it has tried; one that names no pending change restarts it. A call with a
 * cursor leaves out the tab's status too, since its first round told it. A tab with no rows at all, or any row with a
 * blank block_id, cancels nothing: a row that cannot be read must never free a bike an OTA sold.
 */
export async function syncBlocks(
  db: D1Database,
  blocks: ValidBlock[],
  now: number,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const { maxChanges = MAX_CHANGES, skippedBlockIds = [], blankIdRows = 0, cursor = null } = opts;
  const bufMs = (await readShopConfig(db)).turnaroundMinutes * MINUTE_MS;
  const sheetIds = blocks.map(({ blockId }) => blockId);
  const { results } = await db.prepare(STORED_SQL).bind(JSON.stringify(sheetIds), now).all<StoredBlock>();

  const present = new Set([...sheetIds, ...skippedBlockIds]);
  const missing = results
    .filter(({ blockId, status, endAt }) => status === "CONFIRMED" && endAt > now && !present.has(blockId))
    .map(({ blockId }) => blockId);
  const cancelsHeld = blankIdRows > 0 || present.size === 0;

  const stored = new Map(results.map((row) => [row.blockId, row]));
  const rows = await Promise.all(
    blocks.map(async (block) => {
      const hash = await contentHash(block);
      const row = stored.get(block.blockId);
      return { block, hash, row, settled: settledStatus(block, hash, row, now) };
    }),
  );

  const changed = rows.filter(({ settled }) => settled === null).map(({ block }) => block.blockId);
  const pending = [...(cancelsHeld ? [] : missing), ...changed];
  const resumeAt = cursor?.startsWith(CURSOR_PREFIX) ? pending.indexOf(cursor.slice(CURSOR_PREFIX.length)) : -1;
  const resumed = resumeAt >= 0;
  const from = Math.max(resumeAt, 0);
  const to = from + maxChanges;
  const passed = new Set(pending.slice(0, from));
  const trying = new Set(pending.slice(from, to));

  const cancels = missing.filter((blockId) => trying.has(blockId));
  if (cancels.length > 0) await db.prepare(CANCEL_SQL).bind(JSON.stringify(cancels), now, CANCEL_REASON).run();

  const statuses: BlockStatus[] = [];
  if (cancelsHeld && missing.length > 0 && !resumed) {
    statuses.push({ blockId: "", level: "error", message: blankIdRows > 0 ? BLANK_ID : EMPTY_TAB });
  }
  for (const { block, hash, row, settled } of rows) {
    const { blockId } = block;
    if (settled !== null) statuses.push(settled);
    else if (trying.has(blockId)) statuses.push(await applyChange(db, block, hash, row, bufMs, now));
    else if (!passed.has(blockId)) statuses.push({ blockId, level: "warning", message: NOT_TRIED });
  }

  const next = pending[to];
  return {
    statuses,
    processed: trying.size,
    remaining: Math.max(pending.length - to, 0),
    cursor: next === undefined ? null : `${CURSOR_PREFIX}${next}`,
    resumed,
  };
}
