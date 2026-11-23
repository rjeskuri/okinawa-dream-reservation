// The Block a bike panel: staff take a model, or one plate of it, out of service for a while. It appends one maintenance
// row to the Blocks tab and syncs it with the blocks step of Publish, so nobody edits Blocks by hand. It never edits or
// deletes another row: a row deleted from the tab cancels its block on the next Publish.
// Apps Script files share one global scope and have no modules. Helpers end in `_`, which keeps them off the Run list.

const BLOCK_PANEL_TITLE_ = "Block a bike";
const BLOCK_DATE_TIME_ = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const BLOCK_DATE_TIME_HINT_ = "write the date and time in Japan as YYYY-MM-DD HH:mm, such as 2027-07-15 09:00.";
/** Draws of a uuid before giving up on a block_id the tab does not hold yet. Each draw is new, so one is enough. */
const BLOCK_ID_DRAWS_ = 20;

function openBlockBike() {
  openPanel_("BlockBikePanel", BLOCK_PANEL_TITLE_);
}

/**
 * Every published model with all its plates and their status, a plate in maintenance or retired too, since a block may
 * name any of them. Answers `{ ok: true, models }` or `{ ok: false, message }`.
 */
function blockPanelOptions() {
  const catalog = blockCatalog_();
  if (!catalog.ok) return catalog;
  return { ok: true, models: catalog.models };
}

/**
 * Appends one maintenance row to Blocks and syncs it. `start` and `end` are `YYYY-MM-DD HH:mm` in Japan time; a plate
 * alone decides the model. Answers `{ ok: false, message }` when it wrote nothing, or `{ ok: true, blockId, row, ... }`
 * with `level` once the sync ran, or `synced: false` when the sync did not finish and the next Publish does it.
 */
function blockPanelSave(input) {
  const { modelId, plate, start, end, reason } = input ?? {};
  const startAt = blockDateTime_(start);
  if (startAt === null) return blockRefusal_(`Start: ${BLOCK_DATE_TIME_HINT_}`);
  const endAt = blockDateTime_(end);
  if (endAt === null) return blockRefusal_(`End: ${BLOCK_DATE_TIME_HINT_}`);
  if (endAt <= startAt) return blockRefusal_("The end must be after the start.");

  const catalog = blockCatalog_();
  if (!catalog.ok) return catalog;
  const bike = blockBike_(catalog.models, blockText_(modelId), blockText_(plate));
  if (!bike.ok) return bike;

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(LOCK_WAIT_MS_)) {
    return blockRefusal_("A Publish is running. Nothing was saved: try again when it has finished.");
  }
  try {
    let blockId;
    let row;
    try {
      blockId = newBlockId_();
      row = appendRecord_("Blocks", {
        block_id: blockId,
        model_id: bike.modelId,
        plate: bike.plate,
        start: start.trim(),
        end: end.trim(),
        channel: "maintenance",
        note: blockText_(reason),
      });
      // The sync reads the sheet through the Sheets API from the Worker, which does not see writes Apps Script still holds.
      SpreadsheetApp.flush();
    } catch (error) {
      return blockRefusal_(`Nothing was saved: ${error.message}`);
    }
    return syncBlock_(blockId, row);
  } finally {
    lock.releaseLock();
  }
}

function blockRefusal_(message) {
  return { ok: false, message };
}

function blockText_(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Minutes since 1970 for a real `YYYY-MM-DD HH:mm`, or null. Japan has one offset, so comparing these is enough. */
function blockDateTime_(value) {
  if (typeof value !== "string") return null;
  const match = BLOCK_DATE_TIME_.exec(value.trim());
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (hour > 23 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / 60000;
}

/** The published models as `{ id, nameJa, nameEn, typeId, active, plates: [{ plate, status }] }`, or a refusal. */
function blockCatalog_() {
  const answer = staffPost_("/api/staff/catalog", {});
  if (!answer.ok) return answer;
  const catalog = answer.result;
  if (catalog.ok === false) {
    return blockRefusal_("The catalog is not published yet. Press Publish first, then open Block a bike again.");
  }
  if (!Array.isArray(catalog.models)) return blockRefusal_("The website sent a catalog that could not be read.");
  const models = catalog.models.map((model) => ({
    id: String(model.id),
    nameJa: String(model.nameJa ?? ""),
    nameEn: String(model.nameEn ?? ""),
    typeId: String(model.typeId ?? ""),
    active: model.active === true,
    plates: (Array.isArray(model.plates) ? model.plates : []).map(({ plate, status }) => ({
      plate: String(plate),
      status: String(status ?? ""),
    })),
  }));
  return { ok: true, models };
}

/** The model and plate to write: a plate decides its model, and a model given with it must be that one. */
function blockBike_(models, modelId, plate) {
  if (plate !== "") {
    const owner = models.find((model) => model.plates.some((each) => each.plate === plate));
    if (owner === undefined) return blockRefusal_(`The plate ${plate} is not in the published catalog.`);
    if (modelId !== "" && modelId !== owner.id) {
      return blockRefusal_(`The plate ${plate} is a ${owner.id}, not a ${modelId}.`);
    }
    return { ok: true, modelId: owner.id, plate };
  }
  if (modelId === "") return blockRefusal_("Choose a model or a plate.");
  if (!models.some((model) => model.id === modelId)) {
    return blockRefusal_(`The model ${modelId} is not in the published catalog.`);
  }
  return { ok: true, modelId, plate: "" };
}

/** MNT-, the minute in Japan and 4 characters of a uuid, drawn again while the tab already holds the id. */
function newBlockId_() {
  const taken = new Set(
    (readRecords_("Blocks")?.records ?? []).map(({ cells }) => String(cells.block_id ?? "").normalize("NFKC").trim()),
  );
  const prefix = `MNT-${Utilities.formatDate(new Date(), JST_, "yyyyMMdd-HHmm")}-`;
  for (let draw = 0; draw < BLOCK_ID_DRAWS_; draw += 1) {
    const blockId = prefix + Utilities.getUuid().slice(0, 4);
    if (!taken.has(blockId)) return blockId;
  }
  throw new Error("no new block id could be drawn, try again in a minute");
}

/** Runs the blocks step as Publish does, logs it in PublishLog, and answers what happened to this row. */
function syncBlock_(blockId, row) {
  const run = { user: currentUser_(), version: "", counts: "", blocks: "", photos: "", assignments: "", messages: [] };
  run.messages.push(`Block a bike: ${blockId} added on Blocks row ${row}`);
  const outcome = {};
  run.blocks = runStep_(run, "Blocks", "/api/publish/blocks", "processed", outcome);
  const logProblem = appendLog_(run);

  const saved = `Saved ${blockId} on Blocks row ${row}.`;
  const ours = (Array.isArray(outcome.errors) ? outcome.errors : []).filter((error) => error?.name === blockId);
  let answer;
  if (outcome.failure !== "") {
    answer = {
      ok: true,
      blockId,
      row,
      synced: false,
      message: `${saved} The sync failed: ${outcome.failure}. The row stays on the tab and the next Publish syncs it.`,
    };
  } else if (ours.length > 0) {
    const reasons = ours.map((error) => String(error.message)).join("; ");
    answer = {
      ok: true,
      blockId,
      row,
      level: "error",
      message: `${saved} The website did not take it: ${reasons}. Change the row or delete it, then press Publish.`,
    };
  } else if (outcome.remaining > 0) {
    answer = {
      ok: true,
      blockId,
      row,
      synced: false,
      message: `${saved} The sync stopped with ${outcome.remaining} rows still to do. Press Publish to finish it.`,
    };
  } else {
    answer = { ok: true, blockId, row, level: "ok", message: `${saved} The website has it: the bike is blocked.` };
  }
  if (logProblem !== "") answer.message += ` ${logProblem}`;
  return answer;
}
