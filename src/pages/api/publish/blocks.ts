// POST /api/publish/blocks: syncs the Blocks tab into inventory and writes each row's publish_status back. The body is the
// `{ ts, payload, sig }` envelope signed with PUBLISH_SECRET, and anything else is a 401, before any call to Google. The
// caller repeats it, sending back the `cursor` it answered, until `remaining` is 0. A failure reading or writing the sheet
// answers non-2xx: the bookings stand, and a repeat run writes the statuses and moves none of them.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { syncBlocks, type BlockStatus } from "../../../lib/booking/blocks.ts";
import { headerKey, validateBlocks, type RowStatus } from "../../../lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../../../lib/crypto.ts";
import { readCatalogKeys } from "../../../lib/db/catalog-store.ts";
import { SheetsError } from "../../../lib/google/sheets.ts";
import { columnLetters } from "../../../lib/sheets/bookings-sync.ts";
import { createGoogleClients } from "../../../server/google.ts";

const TAB = "Blocks";
const STATUS_COLUMN = "publish_status";

/** The shape namedErrorLines_ in apps-script/Publish.js lists for staff, as `name: message`. */
type SyncError = { name: string; message: string };

type Answer = { processed: number; remaining: number; errors: SyncError[]; cursor: string | null };

/** What a tab that cannot be synced answers. Its messages may start with the tab's name, which `name` already says. */
function stopped(messages: string[]): Answer {
  const errors = messages.map((message) => ({ name: TAB, message: message.replace(/^Blocks: /, "") }));
  return { processed: 0, remaining: 0, errors, cursor: null };
}

/** The payload has passed its signature, but it can still be any JSON. What is no cursor starts the pass from the top. */
function cursorIn(payload: unknown): string | null {
  const { cursor } = Object(payload) as { cursor?: unknown };
  return typeof cursor === "string" ? cursor : null;
}

/**
 * Each sheet row's publish_status. A row keeps all of its messages. One with no status in `synced`, because an earlier
 * round of the pass tried it, is left out, so that it keeps what that round wrote.
 */
function statusCells(rejected: RowStatus[], synced: BlockStatus[], rowOfBlock: Map<string, number>): Map<number, string> {
  const cells = new Map<number, string>();
  const show = (row: number, level: string, message: string): void => {
    const shown = cells.get(row);
    cells.set(row, shown !== undefined ? `${shown}; ${message}` : level === "ok" ? "ok" : `${level}: ${message}`);
  };
  for (const { row, level, message } of rejected) show(row, level, message);
  for (const { blockId, level, message } of synced) {
    const row = rowOfBlock.get(blockId);
    if (row !== undefined) show(row, level, message);
  }
  return cells;
}

/** The catalog comes first: without one the tab cannot be checked, so there is no reason to read it. */
async function syncTab(cursor: string | null, now: number): Promise<Answer> {
  const catalog = await readCatalogKeys(env.DB);
  if (catalog === null) return stopped(["no catalog has been published, so the tab cannot be checked"]);

  const { sheets } = createGoogleClients();
  const workbook = await sheets.batchGet([TAB]);
  const validated = validateBlocks(workbook, catalog, now);
  if (validated.fatal.length > 0) return stopped(validated.fatal);

  const result = await syncBlocks(env.DB, validated.blocks, now, {
    skippedBlockIds: validated.skippedBlockIds,
    blankIdRows: validated.blankIdRows,
    cursor,
  });

  // The tab passed its header check, so the column is there.
  const column = columnLetters(workbook[TAB][0].findIndex((name) => headerKey(name) === STATUS_COLUMN));
  const rejected = validated.statuses.filter(({ level }) => level === "error");
  const rowOfBlock = new Map(validated.rows.filter(({ kept }) => kept).map(({ row, blockId }) => [blockId, row]));
  const cells = statusCells(rejected, result.statuses, rowOfBlock);
  const data = [...cells].map(([row, text]) => ({ range: `${TAB}!${column}${row}`, values: [[text]] }));
  if (data.length > 0) await sheets.batchUpdate(data);

  // A round on a cursor answers its own sync problems: the first round told the rest.
  const idOfRow = new Map(validated.rows.map(({ row, blockId }) => [row, blockId]));
  const told = result.resumed
    ? []
    : rejected.map(({ row, message }) => ({ name: idOfRow.get(row) || `row ${row}`, message }));
  const failed = result.statuses
    .filter(({ level }) => level === "error")
    .map(({ blockId, message }) => ({ name: blockId || TAB, message }));
  return { processed: result.processed, remaining: result.remaining, errors: [...told, ...failed], cursor: result.cursor };
}

export const POST: APIRoute = async ({ request }) => {
  const now = Date.now();
  const verified = await verifyEnvelope(env.PUBLISH_SECRET, await request.text(), now);
  if (!verified.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    return Response.json(await syncTab(cursorIn(verified.payload), now));
  } catch (error) {
    if (error instanceof SheetsError) return Response.json({ error: error.message }, { status: 502 });
    throw error;
  }
};
