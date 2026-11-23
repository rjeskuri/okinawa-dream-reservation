// The Add a bike panel: a vehicle of a model already in the sheet, or a new model with the rows it needs. The panel lists
// the options, checks the proposed rows with the Worker, then saves them and runs Publish. A draft is
// `{ mode: 'existing', modelId, vehicle: { plate, odometerKm?, baseUsageDays?, notes? } }` or
// `{ mode: 'new', model, rateClass, prices?, type?, vehicle }`, where `model` is
// `{ modelId, typeId, brand, engineCc?, seats?, licenseClass?, sort?, active, texts: { name, summary, description } }`,
// `rateClass` is `{ id }` for a class in RateClasses or `{ new: { id, group, sort?, extensionPerHourJpy?, names } }`,
// `prices` is `{ packageId, priceJpy, advancePriceJpy? }[]` and counts only with a new class, and `type` is
// `{ depositJpy, sort?, names }` and counts only when Types has no row for the model's type. Texts and names are
// `{ ja, en, zh, ko }`. A class's prices and a type's deposit already in the sheet are read-only here (owner decision 4).
// Apps Script files share one global scope and have no modules. Helpers end in `_`, which keeps them off the Run list.

const ADD_BIKE_TYPE_IDS_ = ["scooter", "motorcycle", "car", "ebike"];
const ADD_BIKE_LOCALES_ = ["ja", "en", "zh", "ko"];

function openAddBike() {
  openPanel_("AddBike", "Add a bike");
}

/**
 * The sheet's models, every plate Vehicles already uses whatever its status, the four types with their deposit, the
 * rate classes with their prices, and the packages. Reads the sheet only. A missing Types, RateClasses, Prices or
 * Packages tab lists nothing from it.
 */
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
  return {
    ok: true,
    models: list,
    plates: Array.from(plates),
    types: addBikeTypeOptions_(readRecords_("Types")),
    rateClasses: addBikeClassOptions_(readRecords_("RateClasses"), readRecords_("Prices")),
    packages: addBikePackageOptions_(readRecords_("Packages")),
  };
}

/** Each of the four types, with the deposit of its first Types row, or `hasRow: false` and no deposit. */
function addBikeTypeOptions_(types) {
  const records = types === null ? [] : types.records;
  return ADD_BIKE_TYPE_IDS_.map((id) => {
    const found = records.find(({ cells }) => addBikeText_(cells.type_id) === id);
    return found === undefined
      ? { id, depositJpy: null, hasRow: false }
      : { id, depositJpy: addBikeNumber_(found.cells.deposit_jpy), hasRow: true };
  });
}

function addBikeClassOptions_(classes, prices) {
  const priceRecords = prices === null ? [] : prices.records;
  return addBikeFirstRows_(classes, "rate_class_id").map(({ id, cells }) => ({
    id,
    group: addBikeText_(cells.group),
    nameJa: addBikeText_(cells.name_ja),
    prices: priceRecords
      .filter((price) => addBikeText_(price.cells.rate_class_id) === id)
      .map((price) => ({
        packageId: addBikeText_(price.cells.package_id),
        priceJpy: addBikeNumber_(price.cells.price_jpy),
        advancePriceJpy: addBikeNumber_(price.cells.advance_price_jpy),
      })),
  }));
}

function addBikePackageOptions_(packages) {
  return addBikeFirstRows_(packages, "package_id").map(({ id, cells }) => ({
    id,
    nameJa: addBikeText_(cells.name_ja),
    days: addBikeNumber_(cells.days),
    hours: addBikeNumber_(cells.hours),
  }));
}

/** The first row of each id in the tab, as `{ id, cells }`; none for a missing tab. */
function addBikeFirstRows_(tab, idColumn) {
  if (tab === null) return [];
  const seen = new Set();
  const rows = [];
  for (const { cells } of tab.records) {
    const id = addBikeText_(cells[idColumn]);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, cells });
  }
  return rows;
}

/** Checks the draft's rows with the Worker, writing nothing. Answers `{ ok: true, fatal, rows }` or `{ ok: false, message }`. */
function addBikeCheck(draft) {
  const built = addBikeRows_(draft);
  if (!built.ok) return built;
  return addBikeCheckRows_(built.rows);
}

/**
 * Checks again under the document lock, then writes the rows in the order Types, RateClasses, Prices, Models, Vehicles
 * and runs Publish. Nothing is written when the check cannot run, has an error or a fatal reason, or another Publish
 * holds the lock. A Publish that fails after the write still answers the rows written, with the Publish messages.
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
      // Publish reads the sheet through the Sheets API from the Worker, which does not see writes Apps Script still holds.
      SpreadsheetApp.flush();
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
 * The draft as `{ ok: true, rows }`, the rows keyed by tab in the order they are written, or `{ ok: false, message }`
 * for a draft that cannot be sent. An optional cell left blank is left out of its row.
 */
function addBikeRows_(draft) {
  if (draft === null || typeof draft !== "object") return { ok: false, message: "Choose a model and enter a plate." };
  if (draft.mode === "existing") return addBikeExistingRows_(draft);
  if (draft.mode === "new") return addBikeNewRows_(draft);
  return { ok: false, message: "Choose a model already in Models or a new model." };
}

/** One Vehicles row. Refused: a model not in Models, a blank plate, or an optional value that is not a number or text. */
function addBikeExistingRows_(draft) {
  const modelId = addBikeId_(draft.modelId);
  if (modelId === "") return { ok: false, message: "Choose a model." };
  const models = readRecords_("Models");
  if (models === null) return { ok: false, message: "Models: the tab is missing, use Set up tabs" };
  if (!models.records.some(({ cells }) => addBikeText_(cells.model_id) === modelId)) {
    return { ok: false, message: `Models has no model ${modelId}. Choose one from the list.` };
  }
  const vehicle = addBikeVehicleRow_(draft.vehicle, modelId);
  return vehicle.ok ? { ok: true, rows: { Vehicles: [vehicle.row] } } : vehicle;
}

/**
 * The Types, RateClasses, Prices, Models and Vehicles rows a new model needs, in that order: a Types row only when Types
 * has none for the model's type, and a RateClasses row and its Prices rows only for a new class. A blank sort takes one
 * past the tab's highest. Refused before any call: a blank model id or type, a class not in RateClasses, a class whose
 * group does not fit the type, a type with no row and no deposit, a blank plate, a missing tab, or a value that is not
 * a number or text. Every tab is read first, so a missing one never leaves a write half done.
 */
function addBikeNewRows_(draft) {
  const model = draft.model;
  if (model === null || typeof model !== "object") return { ok: false, message: "Enter the new model." };
  const modelId = addBikeId_(model.modelId);
  if (modelId === "") return { ok: false, message: "Enter the new model's id." };
  const typeId = addBikeId_(model.typeId);
  if (typeId === "") return { ok: false, message: "Choose the new model's type." };

  const tabs = {};
  for (const tab of ["Types", "RateClasses", "Prices", "Models", "Vehicles"]) {
    tabs[tab] = readRecords_(tab);
    if (tabs[tab] === null) return { ok: false, message: `${tab}: the tab is missing, use Set up tabs` };
  }
  const rows = {};

  if (!tabs.Types.records.some(({ cells }) => addBikeText_(cells.type_id) === typeId)) {
    const type = draft.type;
    if (type === null || typeof type !== "object") {
      return { ok: false, message: `Types has no row for ${typeId}: enter its deposit.` };
    }
    const row = { type_id: typeId };
    const problem = addBikeOptional_(row, [
      ["deposit_jpy", type.depositJpy],
      ["sort", addBikeSort_(type.sort, tabs.Types)],
      ...addBikeNames_("name", type.names),
    ]);
    if (problem !== "") return { ok: false, message: problem };
    rows.Types = [row];
  }

  const rateClass = draft.rateClass;
  if (rateClass === null || typeof rateClass !== "object") {
    return { ok: false, message: "Choose a rate class or enter a new one." };
  }
  let classId;
  let group;
  if (rateClass.new !== undefined && rateClass.new !== null) {
    const added = rateClass.new;
    if (typeof added !== "object") return { ok: false, message: "Enter the new rate class." };
    classId = addBikeId_(added.id);
    if (classId === "") return { ok: false, message: "Enter the new rate class's id." };
    group = addBikeId_(added.group);
    const row = { rate_class_id: classId, group };
    const problem = addBikeOptional_(row, [
      ["sort", addBikeSort_(added.sort, tabs.RateClasses)],
      ["extension_per_hour_jpy", added.extensionPerHourJpy],
      ...addBikeNames_("name", added.names),
    ]);
    if (problem !== "") return { ok: false, message: problem };
    rows.RateClasses = [row];

    const prices = draft.prices === undefined || draft.prices === null ? [] : draft.prices;
    if (!Array.isArray(prices)) return { ok: false, message: "prices: enter a price per package." };
    const priceRows = [];
    for (const price of prices) {
      const packageId = price !== null && typeof price === "object" ? addBikeId_(price.packageId) : "";
      if (packageId === "") return { ok: false, message: "prices: choose the package of each price." };
      const priceRow = { rate_class_id: classId, package_id: packageId };
      const priceProblem = addBikeOptional_(priceRow, [
        ["price_jpy", price.priceJpy],
        ["advance_price_jpy", price.advancePriceJpy],
      ]);
      if (priceProblem !== "") return { ok: false, message: priceProblem };
      priceRows.push(priceRow);
    }
    if (priceRows.length > 0) rows.Prices = priceRows;
  } else {
    // A class in the sheet keeps its prices: prices in the draft are left out (owner decision 4).
    classId = addBikeId_(rateClass.id);
    if (classId === "") return { ok: false, message: "Choose a rate class or enter a new one." };
    const found = tabs.RateClasses.records.find(({ cells }) => addBikeText_(cells.rate_class_id) === classId);
    if (found === undefined) return { ok: false, message: `RateClasses has no class ${classId}. Choose one from the list.` };
    group = addBikeText_(found.cells.group);
  }
  const fits = addBikeGroupOf_(typeId);
  if (group !== fits) {
    return { ok: false, message: `A ${typeId} goes in a rate class of group ${fits}, and ${classId} is ${group || "blank"}.` };
  }

  const modelRow = { model_id: modelId, type_id: typeId, rate_class_id: classId };
  const modelProblem = addBikeOptional_(modelRow, [
    ["brand", model.brand],
    ["seats", model.seats],
    // An e-bike has no engine, so a number left from an earlier choice of type stays out of the row.
    ["engine_cc", typeId === "ebike" ? undefined : model.engineCc],
    ["license_class", model.licenseClass],
    ["sort", addBikeSort_(model.sort, tabs.Models)],
    ...addBikeNames_("name", model.texts?.name),
    ...addBikeNames_("summary", model.texts?.summary),
    ...addBikeNames_("description", model.texts?.description),
  ]);
  if (modelProblem !== "") return { ok: false, message: modelProblem };
  modelRow.active = true;
  rows.Models = [modelRow];

  const vehicle = addBikeVehicleRow_(draft.vehicle, modelId);
  if (!vehicle.ok) return vehicle;
  rows.Vehicles = [vehicle.row];
  return { ok: true, rows };
}

function addBikeVehicleRow_(vehicle, modelId) {
  if (vehicle === null || typeof vehicle !== "object") return { ok: false, message: "Enter a plate." };
  const plate = addBikeId_(vehicle.plate);
  if (plate === "") return { ok: false, message: "Enter a plate." };
  const row = { plate, model_id: modelId, status: "active" };
  const problem = addBikeOptional_(row, [
    ["odometer_km", vehicle.odometerKm],
    ["base_usage_days", vehicle.baseUsageDays],
    ["notes", vehicle.notes],
  ]);
  return problem === "" ? { ok: true, row } : { ok: false, message: problem };
}

/** Sets each `[key, value]` that is not blank on the row. Answers a message for a value that is not a number or text. */
function addBikeOptional_(row, entries) {
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "number" && typeof value !== "string") return `${key}: enter a number or text.`;
    row[key] = value;
  }
  return "";
}

/** The `field_ja` to `field_ko` entries of `{ ja, en, zh, ko }`, each as typed. */
function addBikeNames_(field, values) {
  const given = values !== null && typeof values === "object" ? values : {};
  return ADD_BIKE_LOCALES_.map((locale) => [`${field}_${locale}`, given[locale]]);
}

/** The sort given, or for a blank one, one past the tab's highest sort. */
function addBikeSort_(value, tab) {
  if (value !== undefined && value !== null && value !== "") return value;
  let highest = 0;
  for (const { cells } of tab.records) {
    const sort = addBikeNumber_(cells.sort);
    if (sort !== null && sort > highest) highest = sort;
  }
  return highest + 1;
}

/** The RateClasses group a type's models belong in. */
function addBikeGroupOf_(typeId) {
  return typeId === "ebike" || typeId === "car" ? typeId : "bike";
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

/** A cell as a number, or null when it is blank or not a number. */
function addBikeNumber_(value) {
  if (value === undefined || value === null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addBikeId_(value) {
  return typeof value === "string" ? value.trim() : "";
}

function addBikeText_(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function addBikeReason_(error) {
  return typeof error?.message === "string" ? error.message : String(error);
}
