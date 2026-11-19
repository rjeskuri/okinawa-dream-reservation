// The Add a bike panel: a vehicle of a model already in the sheet. The panel lists the options, checks the proposed
// Vehicles row with the Worker, then saves it and runs Publish. A draft is
// `{ mode: 'existing', modelId, vehicle: { plate, odometerKm?, baseUsageDays?, notes? } }`.
// Apps Script files share one global scope and have no modules. Helpers end in `_`, which keeps them off the Run list.

function openAddBike() {
  openPanel_("AddBike", "Add a bike");
}

/** The sheet's models and every plate Vehicles already uses, whatever its status. Reads the sheet only. */
function addBikeOptions() {
  const models = readRecords_("Models");
  const vehicles = readRecords_("Vehicles");
  if (models === null) return { ok: false, message: "Models: the tab is missing, use Set up tabs" };
  if (vehicles === null) return { ok: false, message: "Vehicles: the tab is missing, use Set up tabs" };

  const seen = new Set();
  const list = [];
  for (const { cells } of models.records) {
    const id = addBikeText_(cells.model_id);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    list.push({
      id,
      nameJa: addBikeText_(cells.name_ja),
      nameEn: addBikeText_(cells.name_en),
      typeId: addBikeText_(cells.type_id),
      rateClassId: addBikeText_(cells.rate_class_id),
      photos: addBikeText_(cells.photos)
        .split(/[,，、]/)
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    });
  }
  const plates = new Set();
  for (const { cells } of vehicles.records) {
    const plate = addBikeText_(cells.plate);
    if (plate !== "") plates.add(plate);
  }
  return { ok: true, models: list, plates: Array.from(plates) };
}

/** Checks the draft's rows with the Worker, writing nothing. Answers `{ ok: true, fatal, rows }` or `{ ok: false, message }`. */
function addBikeCheck(draft) {
  const built = addBikeRows_(draft);
  if (!built.ok) return built;
  return addBikeCheckRows_(built.rows);
}

/**
 * Checks again under the document lock, then writes the rows and runs Publish. Nothing is written when the check cannot
 * run, has an error or a fatal reason, or another Publish holds the lock. A Publish that fails after the write still
 * answers the rows written, with the Publish messages.
 */
function addBikeSave(draft) {
  const built = addBikeRows_(draft);
  if (!built.ok) return built;

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(LOCK_WAIT_MS_)) {
    return { ok: false, message: "A Publish is running, so nothing was saved. Try again when it has finished." };
  }
  try {
    const check = addBikeCheckRows_(built.rows);
    if (!check.ok || check.fatal.length > 0 || addBikeHasError_(check.rows)) return { ok: false, check };

    const written = [];
    try {
      for (const tab of Object.keys(built.rows)) {
        for (const cells of built.rows[tab]) written.push({ tab, row: appendRecord_(tab, cells) });
      }
    } catch (error) {
      return {
        ok: false,
        message: `Could not write the row, so nothing was published: ${addBikeReason_(error)}`,
        written: written.map((entry) => ({ ...entry, status: addBikeStatus_(entry.tab, entry.row) })),
      };
    }

    const run = runPublish_();
    const logProblem = appendLog_(run);
    const messages = logProblem === "" ? run.messages : [...run.messages, logProblem];
    return {
      ok: true,
      written: written.map((entry) => ({ ...entry, status: addBikeStatus_(entry.tab, entry.row) })),
      publish: { version: run.version, messages },
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * The draft as `{ ok: true, rows: { Vehicles: [row] } }`, or `{ ok: false, message }` for a draft that cannot be sent:
 * no draft, a model not in Models, a blank plate, or an optional value that is not a number or text. An optional cell
 * left blank is left out of the row.
 */
function addBikeRows_(draft) {
  if (draft === null || typeof draft !== "object") return { ok: false, message: "Choose a model and enter a plate." };
  if (draft.mode !== "existing") return { ok: false, message: "Only a bike of a model already in Models can be added here." };

  const modelId = typeof draft.modelId === "string" ? draft.modelId.trim() : "";
  if (modelId === "") return { ok: false, message: "Choose a model." };
  const models = readRecords_("Models");
  if (models === null) return { ok: false, message: "Models: the tab is missing, use Set up tabs" };
  if (!models.records.some(({ cells }) => addBikeText_(cells.model_id) === modelId)) {
    return { ok: false, message: `Models has no model ${modelId}. Choose one from the list.` };
  }

  const vehicle = draft.vehicle;
  if (vehicle === null || typeof vehicle !== "object") return { ok: false, message: "Enter a plate." };
  const plate = typeof vehicle.plate === "string" ? vehicle.plate.trim() : "";
  if (plate === "") return { ok: false, message: "Enter a plate." };

  const row = { plate, model_id: modelId, status: "active" };
  for (const [key, value] of [
    ["odometer_km", vehicle.odometerKm],
    ["base_usage_days", vehicle.baseUsageDays],
    ["notes", vehicle.notes],
  ]) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "number" && typeof value !== "string") {
      return { ok: false, message: `${key}: enter a number or text.` };
    }
    row[key] = value;
  }
  return { ok: true, rows: { Vehicles: [row] } };
}

function addBikeCheckRows_(rows) {
  const sent = staffPost_("/api/staff/check-rows", { rows });
  if (!sent.ok) return { ok: false, message: sent.message };
  const { fatal, rows: checked } = sent.result;
  if (!Array.isArray(fatal) || checked === null || typeof checked !== "object" || Array.isArray(checked)) {
    return { ok: false, message: "The check sent an answer that could not be read." };
  }
  return { ok: true, fatal, rows: checked };
}

function addBikeHasError_(rows) {
  return Object.values(rows).some((checks) => Array.isArray(checks) && checks.some((check) => check?.level === "error"));
}

/** The row's publish_status as the sheet holds it, or '' when it cannot be read. */
function addBikeStatus_(tab, row) {
  try {
    return addBikeText_(cellValue_(tab, row, "publish_status"));
  } catch {
    return "";
  }
}

function addBikeText_(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function addBikeReason_(error) {
  return typeof error?.message === "string" ? error.message : String(error);
}
