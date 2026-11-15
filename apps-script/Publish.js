// The sheet's Okinawa Dream menu: Publish calls the Worker with signed requests, and Set up tabs creates missing tabs.
// Apps Script files share one global scope and have no modules. Helpers end in `_`, which keeps them off the Run list.

const JST_ = "Asia/Tokyo";
const LOCK_WAIT_MS_ = 10000;
const MAX_ROUNDS_ = 10;
const DETAIL_LIMIT_ = 300;
const NAMED_ERROR_LIMIT_ = 10;

/** A copy of SHEET_TABS in src/lib/catalog/sheet-schema.ts, which this file cannot import. A test keeps them equal. */
const SHEET_TABS_ = {
  Config: ["key", "value", "publish_status"],
  Types: ["type_id", "deposit_jpy", "sort", "name_ja", "name_en", "name_zh", "name_ko", "publish_status"],
  RateClasses: [
    "rate_class_id", "group", "sort", "extension_per_hour_jpy", "name_ja", "name_en", "name_zh", "name_ko",
    "publish_status",
  ],
  Packages: ["package_id", "days", "hours", "sort", "name_ja", "name_en", "name_zh", "name_ko", "publish_status"],
  Prices: ["rate_class_id", "package_id", "price_jpy", "advance_price_jpy", "publish_status"],
  Models: [
    "model_id", "type_id", "rate_class_id", "brand", "seats", "engine_cc", "license_class", "sort", "active",
    "name_ja", "name_en", "name_zh", "name_ko", "summary_ja", "summary_en", "summary_zh", "summary_ko",
    "description_ja", "description_en", "description_zh", "description_ko", "photos", "publish_status",
  ],
  Vehicles: ["plate", "model_id", "status", "odometer_km", "base_usage_days", "notes", "publish_status"],
  Options: [
    "option_id", "group", "base_jpy", "extra_per_hour_jpy", "extra_per_24h_jpy", "sort", "name_ja", "name_en",
    "name_zh", "name_ko", "publish_status",
  ],
  Cancellation: ["min_days_before", "refund_percent", "publish_status"],
  ClosedDates: ["date", "note", "publish_status"],
  Blocks: ["block_id", "model_id", "plate", "start", "end", "channel", "reference", "note", "publish_status"],
  Bookings: [
    "booking_ref", "booking_id", "status", "source", "model_id", "plate", "override_plate", "override_status",
    "start", "end", "package_id", "guest_name", "guest_email", "guest_phone", "locale",
    "price_jpy", "deposit_jpy", "paid_jpy", "refund_jpy", "refund_status", "created_at", "updated_at",
  ],
  Reconciliation: [
    "run_at", "counts", "type", "booking_ref", "payment_id", "refund_id", "expected_jpy", "actual_jpy", "detail",
  ],
  PublishLog: ["time", "user", "version", "counts", "blocks", "photos", "assignments", "message"],
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Okinawa Dream")
    .addItem("Publish to website", "publish")
    .addItem("Set up tabs", "setupTabs")
    .addToUi();
}

/** Creates the missing tabs with their headers. A tab already there keeps its cells, whatever they are. */
function setupTabs() {
  const workbook = SpreadsheetApp.getActive();
  const missing = Object.keys(SHEET_TABS_).filter((name) => workbook.getSheetByName(name) === null);
  for (const name of missing) {
    const headers = SHEET_TABS_[name];
    workbook.insertSheet(name).getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  workbook.setSpreadsheetTimeZone(JST_);
  SpreadsheetApp.getUi().alert(missing.length > 0 ? `Tabs created: ${missing.join(", ")}` : "Every tab already exists");
}

function publish() {
  const ui = SpreadsheetApp.getUi();
  const missing = missingProperties_();
  if (missing.length > 0) {
    ui.alert(`Publish cannot start. Set ${missing.join(" and ")} in Project Settings, under Script Properties.`);
    return;
  }

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(LOCK_WAIT_MS_)) {
    ui.alert("Publish already running");
    return;
  }
  let run;
  let logProblem;
  try {
    run = runPublish_();
    logProblem = appendLog_(run);
  } finally {
    // Before the alert, which holds the script open until staff dismiss it.
    lock.releaseLock();
  }
  ui.alert(alertText_(run, logProblem));
}

function missingProperties_() {
  const properties = PropertiesService.getScriptProperties();
  return ["WORKER_BASE_URL", "PUBLISH_SECRET"].filter((name) => !properties.getProperty(name));
}

/** `messages` go to the alert and the log. Every failure ends up there, so nothing here throws at staff. */
function runPublish_() {
  const run = {
    user: currentUser_(),
    version: "",
    counts: "",
    blocks: "",
    photos: "",
    assignments: "",
    messages: [],
    affected: [],
  };

  let report;
  try {
    report = signedPost_("/api/publish", { requestedBy: run.user });
  } catch (error) {
    run.messages.push(`Publish failed: ${error.message}`);
    return run;
  }

  if (report.ok === false) {
    run.counts = countsCell_(report.counts);
    run.messages.push("Publish stopped, the site is unchanged", ...(report.fatal ?? []));
    return run;
  }
  if (report.ok !== true || typeof report.version !== "number") {
    run.messages.push("Publish failed: the Worker sent a report that could not be read");
    return run;
  }

  run.version = report.version;
  run.counts = countsCell_(report.counts);
  run.affected = report.affectedBookings ?? [];
  run.messages.push(`Published version ${run.version}`);
  if (run.affected.length > 0) run.messages.push(`Bookings on vehicles leaving service: ${run.affected.length}`);

  run.blocks = runStep_(run, "Blocks", "/api/publish/blocks", "processed");
  run.photos = runStep_(run, "Photos", "/api/publish/photos", "copied");
  run.assignments = runStep_(run, "Assignments", "/api/publish/assignments", "applied");
  return run;
}

/** Blank when Google withholds the address or the lookup fails. Neither stops a Publish. */
function currentUser_() {
  try {
    return Session.getActiveUser().getEmail();
  } catch {
    return "";
  }
}

function countsCell_(counts = {}) {
  return `${count_(counts.ok)} ok, ${count_(counts.warning)} warning, ${count_(counts.error)} error`;
}

/** A count as a number, or as the list of items some responses return instead. */
function count_(value) {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" ? value : 0;
}

/**
 * Calls a follow-up step while it reports work remaining and answers its PublishLog cell. The catalog is already
 * published by now, so a step that fails ends only that step: the next ones still have their own work to do.
 * Work totals across rounds. Errors depend on the cursor. A step that answers a string `cursor` gets it back on its next
 * round and tells each error once, so a round that sent a cursor adds to the list. A round that sent none starts the list
 * again: a step without a cursor reports its errors on every call until staff fix them, so its last round has them all.
 */
function runStep_(run, name, path, doneField) {
  let done = 0;
  let errors = [];
  let remaining = 0;
  let rounds = 0;
  let failed = false;
  let cursor = null;
  try {
    do {
      const result = signedPost_(path, cursor === null ? { requestedBy: run.user } : { requestedBy: run.user, cursor });
      done += count_(result[doneField]);
      errors = cursor === null ? result.errors : [...errors, ...result.errors];
      cursor = typeof result.cursor === "string" ? result.cursor : null;
      remaining = count_(result.remaining);
      rounds += 1;
    } while (remaining > 0 && rounds < MAX_ROUNDS_);
  } catch (error) {
    failed = true;
    run.messages.push(`${name} failed: ${error.message}`);
  }
  if (remaining > 0) run.messages.push(`${name}: ${remaining} still remain, press Publish again to finish them`);
  run.messages.push(...namedErrorLines_(name, errors));

  let cell = `${done} ${doneField}, ${count_(errors)} errors`;
  if (remaining > 0) cell += `, ${remaining} remaining`;
  if (failed) cell += ", failed";
  return cell;
}

/** The `{ name, message }` entries of a step's errors, for staff. A step may send a count, or entries with no name. */
function namedErrorLines_(stepName, errors) {
  const named = Array.isArray(errors) ? errors.filter((error) => typeof error?.name === "string") : [];
  if (named.length === 0) return [];

  const listed = named.slice(0, NAMED_ERROR_LIMIT_);
  const total = `${stepName} with errors: ${errors.length}`;
  const heading = errors.length > listed.length ? `${total}, first ${listed.length} listed` : total;
  return [heading, ...listed.map((error) => `${error.name}: ${error.message}`)];
}

/** Posts the envelope verifyEnvelope in src/lib/crypto.ts checks, and answers the JSON object the Worker sends back. */
function signedPost_(path, payload) {
  const properties = PropertiesService.getScriptProperties();
  const baseUrl = properties.getProperty("WORKER_BASE_URL").replace(/\/+$/, "");
  const text = JSON.stringify(payload);
  const ts = Date.now();
  const digest = Utilities.computeHmacSha256Signature(
    `${ts}.${text}`,
    properties.getProperty("PUBLISH_SECRET"),
    Utilities.Charset.UTF_8,
  );

  const response = UrlFetchApp.fetch(baseUrl + path, {
    method: "post",
    contentType: "application/json; charset=utf-8",
    payload: JSON.stringify({ ts, payload: text, sig: toHex_(digest) }),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const body = response.getContentText("UTF-8");
  if (status !== 200) {
    const detail = body.slice(0, DETAIL_LIMIT_);
    throw new Error(detail === "" ? `the Worker answered ${status}` : `the Worker answered ${status}: ${detail}`);
  }

  let result = null;
  try {
    result = JSON.parse(body);
  } catch {
    // Not JSON at all, which the check below reports with every other shape it cannot use.
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("the Worker sent a response that could not be read");
  }
  return result;
}

/** computeHmacSha256Signature returns signed bytes, from -128 to 127. */
function toHex_(bytes) {
  return bytes.map((byte) => (byte & 0xff).toString(16).padStart(2, "0")).join("");
}

/** Writes the row and answers what staff should know if it could not: the result matters more than the log. */
function appendLog_(run) {
  const tab = SpreadsheetApp.getActive().getSheetByName("PublishLog");
  if (tab === null) return "This Publish was not logged because the PublishLog tab is missing. Use Set up tabs.";
  try {
    tab.appendRow([
      new Date(),
      run.user,
      run.version,
      run.counts,
      run.blocks,
      run.photos,
      run.assignments,
      run.messages.join("; "),
    ]);
    return "";
  } catch (error) {
    return `This Publish was not logged: ${error.message}`;
  }
}

function alertText_(run, logProblem) {
  const sections = [run.messages.join("\n")];
  if (run.version !== "") {
    sections.push(
      [
        `Rows: ${run.counts}`,
        `Blocks: ${run.blocks}`,
        `Photos: ${run.photos}`,
        `Assignments: ${run.assignments}`,
      ].join("\n"),
    );
  }
  if (run.affected.length > 0) {
    sections.push(["Ref, plate and start date in Japan:", ...run.affected.map(bookingLine_)].join("\n"));
  }
  if (logProblem !== "") sections.push(logProblem);
  return sections.join("\n\n");
}

function bookingLine_(booking) {
  return `${booking.ref}  ${booking.plate}  ${Utilities.formatDate(new Date(booking.startAt), JST_, "yyyy-MM-dd")}`;
}
