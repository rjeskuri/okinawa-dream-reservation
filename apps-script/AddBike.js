// The Add a bike panel: a vehicle of a model already in the sheet, or a new model with the rows it needs. The panel lists
// the options, checks the proposed rows with the Worker, then saves them and runs Publish. A draft is
// `{ mode: 'existing', modelId, vehicle: { plate, odometerKm?, baseUsageDays?, notes? } }` or
// `{ mode: 'new', model, rateClass, prices?, type?, vehicle }`, where `model` is
// `{ modelId, typeId, brand, engineCc?, seats?, licenseClass?, sort?, active, texts: { name, summary, description } }`,
// `rateClass` is `{ id }` for a class in RateClasses or `{ new: { id, group, sort?, extensionPerHourJpy?, names } }`,
// `prices` is `{ packageId, priceJpy, advancePriceJpy? }[]` and counts only with a new class, and `type` is
// `{ depositJpy, sort?, names }` and counts only when Types has no row for the model's type. Texts and names are
// `{ ja, en, zh, ko }`. A class's prices and a type's deposit already in the sheet are read-only here (owner decision 4).
// Either draft may hold `photos`, the names addBikeUploadPhoto answered, which save puts in the model's photos cell.
// Apps Script files share one global scope and have no modules. Helpers end in `_`, which keeps them off the Run list.

const ADD_BIKE_TYPE_IDS_ = ["scooter", "motorcycle", "car", "ebike"];
const ADD_BIKE_LOCALES_ = ["ja", "en", "zh", "ko"];
/** The types the Worker's photo copy takes (src/lib/catalog/photos.ts), each with the extension its name gets. */
const ADD_BIKE_PHOTO_TYPES_ = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const ADD_BIKE_BYTES_PER_MB_ = 1000000;
/** An id as docs/sheet-schema.md has it: lower-case letters, digits and single hyphens, at most 40 characters. */
const ADD_BIKE_SLUG_ = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ADD_BIKE_SLUG_MAX_ = 40;

function openAddBike() {
  openPanel_("AddBikePanel", "Add a bike");
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
 * and runs Publish. A model already in Models first gets the draft's photos added to its photos cell. Nothing is
 * written when the check cannot run, has an error or a fatal reason, or another Publish holds the lock. A Publish that
 * fails after the write still answers the rows written, with the Publish messages.
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
      if (built.addPhotos) {
        written.push({ tab: "Models", row: addBikeAddPhotos_(built.addPhotos.modelId, built.addPhotos.names) });
      }
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
 * Stores one photo in the Drive folder that the Script Property PHOTO_FOLDER_ID names, the folder the Worker's photo
 * copy reads, as that copy takes it (src/lib/catalog/photos.ts): JPEG, PNG or WebP, at most Config's photo_max_mb x
 * 1,000,000 bytes, and under a name no other file in the folder has, `<modelId>-<n>.<jpg|png|webp>` with the smallest n
 * from 1. The type alone picks the extension, so `fileName` is not used. `upload` is
 * `{ modelId, fileName, mimeType, base64 }`. Answers `{ ok: true, name }` or `{ ok: false, message }` and never throws.
 * It writes nothing to the sheet: save puts the names in Models.
 */
function addBikeUploadPhoto(upload) {
  try {
    return addBikeStorePhoto_(upload);
  } catch (error) {
    return { ok: false, message: `The photo was not uploaded: ${addBikeReason_(error)}` };
  }
}

function addBikeStorePhoto_(upload) {
  const unreadable = { ok: false, message: "The photo could not be read. Choose the file again." };
  if (upload === null || typeof upload !== "object") return unreadable;
  const modelId = addBikeId_(upload.modelId);
  if (modelId.length > ADD_BIKE_SLUG_MAX_ || !ADD_BIKE_SLUG_.test(modelId)) {
    return {
      ok: false,
      message: "The model id must be lower-case letters, digits and single hyphens, 40 at most, such as pcx-125.",
    };
  }
  const extension = ADD_BIKE_PHOTO_TYPES_.get(upload.mimeType);
  if (extension === undefined) {
    return { ok: false, message: "Only a JPEG, PNG or WebP photo can be uploaded. Save it as one of those first." };
  }
  if (typeof upload.base64 !== "string") return unreadable;

  const folderId = addBikeText_(PropertiesService.getScriptProperties().getProperty("PHOTO_FOLDER_ID"));
  if (folderId === "") {
    return {
      ok: false,
      message: "Set PHOTO_FOLDER_ID to the photo folder's id in Project Settings, under Script Properties.",
    };
  }

  let bytes;
  try {
    bytes = Utilities.base64Decode(upload.base64);
  } catch {
    return unreadable;
  }
  if (bytes.length === 0) return { ok: false, message: "The photo is empty. Choose another file." };
  const maxBytes = addBikePhotoMaxBytes_();
  if (maxBytes !== null && bytes.length > maxBytes) {
    return {
      ok: false,
      message: `The photo is ${bytes.length} bytes, over the ${maxBytes} that photo_max_mb in Config allows.`,
    };
  }

  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (error) {
    return { ok: false, message: `Could not open the photo folder set in PHOTO_FOLDER_ID: ${addBikeReason_(error)}` };
  }
  // Two uploads at once could otherwise both find one name free, and the Worker's copy refuses a name two files have.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS_)) return { ok: false, message: "Another photo is uploading. Try again in a moment." };
  try {
    const name = addBikeFreePhotoName_(folder, modelId, extension);
    folder.createFile(Utilities.newBlob(bytes, upload.mimeType, name));
    return { ok: true, name };
  } catch (error) {
    return { ok: false, message: `Could not add the photo to the photo folder: ${addBikeReason_(error)}` };
  } finally {
    lock.releaseLock();
  }
}

/** `<modelId>-<n>.<extension>` with the smallest n from 1 that no file in the folder is named. */
function addBikeFreePhotoName_(folder, modelId, extension) {
  for (let n = 1; ; n += 1) {
    const name = `${modelId}-${n}.${extension}`;
    if (!folder.getFilesByName(name).hasNext()) return name;
  }
}

/**
 * Config's photo_max_mb x 1,000,000, read as the Worker reads it: the first photo_max_mb row, a whole number of at
 * least 1, as a number or as text. Null when Config has no such value; Publish then reports what is wrong.
 */
function addBikePhotoMaxBytes_() {
  const asText = (value) => (typeof value === "string" ? value.normalize("NFKC").trim() : "");
  const found = readRecords_("Config")?.records.find(({ cells }) => asText(cells.key) === "photo_max_mb");
  const value = found === undefined ? "" : found.cells.value;
  const mb = typeof value === "number" ? value : /^\d+$/.test(asText(value)) ? Number(asText(value)) : NaN;
  return Number.isSafeInteger(mb) && mb >= 1 ? mb * ADD_BIKE_BYTES_PER_MB_ : null;
}

/** The draft's photo names, trimmed, as `{ ok: true, names }`, none without; or `{ ok: false, message }`. */
function addBikePhotoNames_(photos) {
  if (photos === undefined || photos === null) return { ok: true, names: [] };
  const refused = { ok: false, message: "photos: each photo is one file name, as the upload answered it." };
  if (!Array.isArray(photos)) return refused;
  const names = photos.map((photo) => (typeof photo === "string" ? photo.trim() : ""));
  // A separator inside a name would split it in two when the Worker reads the cell.
  return names.some((name) => name === "" || /[,，、]/.test(name)) ? refused : { ok: true, names };
}

/** Adds `names` after what the model's photos cell holds, kept as typed, separated by `, `, and answers the row. */
function addBikeAddPhotos_(modelId, names) {
  const found = (readRecords_("Models")?.records ?? []).find(({ cells }) => addBikeText_(cells.model_id) === modelId);
  if (found === undefined) throw new Error(`Models has no model ${modelId}`);
  const typed = found.cells.photos;
  const added = names.join(", ");
  setCellValue_("Models", found.row, "photos", isBlankCell_(typed) ? added : `${typed}, ${added}`);
  return found.row;
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

/**
 * One Vehicles row, and in `addPhotos` the draft's photos for the model's photos cell, or null for none. Refused: a
 * model not in Models, a blank plate, a photo that is not a name, or an optional value that is not a number or text.
 */
function addBikeExistingRows_(draft) {
  const modelId = addBikeId_(draft.modelId);
  if (modelId === "") return { ok: false, message: "Choose a model." };
  const models = readRecords_("Models");
  if (models === null) return { ok: false, message: "Models: the tab is missing, use Set up tabs" };
  if (!models.records.some(({ cells }) => addBikeText_(cells.model_id) === modelId)) {
    return { ok: false, message: `Models has no model ${modelId}. Choose one from the list.` };
  }
  const photos = addBikePhotoNames_(draft.photos);
  if (!photos.ok) return photos;
  const vehicle = addBikeVehicleRow_(draft.vehicle, modelId);
  if (!vehicle.ok) return vehicle;
  const addPhotos = photos.names.length > 0 ? { modelId, names: photos.names } : null;
  return { ok: true, rows: { Vehicles: [vehicle.row] }, addPhotos };
}

/**
 * The Types, RateClasses, Prices, Models and Vehicles rows a new model needs, in that order: a Types row only when Types
 * has none for the model's type, and a RateClasses row and its Prices rows only for a new class. A blank sort takes one
 * past the tab's highest. The draft's photos go in the Models row's photos cell. Refused before any call: a blank model
 * id or type, a class not in RateClasses, a class whose group does not fit the type, a type with no row and no deposit,
 * a blank plate, a missing tab, a photo that is not a name, or a value that is not a number or text. Every tab is read
 * first, so a missing one never leaves a write half done.
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

  const photos = addBikePhotoNames_(draft.photos);
  if (!photos.ok) return photos;
  const modelRow = { model_id: modelId, type_id: typeId, rate_class_id: classId };
  const modelProblem = addBikeOptional_(modelRow, [
    ["photos", photos.names.join(", ")],
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
