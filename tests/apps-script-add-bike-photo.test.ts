// Add a bike's photo step (apps-script/AddBike.js), run in node:vm against the fake Google services as in
// apps-script-add-bike.test.ts. addBikeUploadPhoto({ modelId, fileName, mimeType, base64 }) stores one photo in the Drive
// folder named by the Script Property PHOTO_FOLDER_ID, under the smallest free `<modelId>-<n>.<jpg|png|webp>`, and the
// draft's `photos` (the names it answered) go into the model's Models photos cell on save. The fake Drive holds the
// folders a test gives by id and records every file the script creates with its bytes, so a test compares the stored
// bytes with the ones it encoded. Expected names and cells are written out here by hand. The Worker's photo copy
// (src/lib/catalog/photos.ts) refuses a name held by two files, a type other than JPEG, PNG or WebP, and a file over
// photo_max_mb x 1,000,000 bytes, which is why the upload refuses the same.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkProposedRows, parseProposedRows } from "../src/lib/catalog/check-rows.ts";
import { SHEET_TABS } from "../src/lib/catalog/sheet-schema.ts";
import { type AppsScriptWorld, type FetchCall, loadAppsScript, type Options, type Route } from "./helpers/apps-script.ts";
import { validWorkbook } from "./helpers/sheet-workbook.ts";

const SCRIPT_DIR = new URL("../apps-script/", import.meta.url);

const BASE_URL = "https://reservation-one.example.dev";
const SECRET = "publish-secret-one";
const USER = "staff@okinawa-dream.example";
const FOLDER = "1PhotoFolderAbc";
const OTHER_FOLDER = "1OtherFolderXyz";
const PROPERTIES = { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: SECRET, PHOTO_FOLDER_ID: FOLDER };
const MB = 1_000_000;

const CHECK = "/api/staff/check-rows";
const PUBLISH = "/api/publish";
const BLOCKS = "/api/publish/blocks";
const PHOTOS = "/api/publish/photos";
const ASSIGNMENTS = "/api/publish/assignments";
const PUBLISH_PATHS = [PUBLISH, BLOCKS, PHOTOS, ASSIGNMENTS];

const REPORT = { ok: true, version: 412, counts: { ok: 120, warning: 3, error: 0 }, fatal: [], affectedBookings: [] };
const STEP_ROUTES: Record<string, Route> = {
  [BLOCKS]: { body: { processed: 4, remaining: 0, errors: [] } },
  [PHOTOS]: { body: { copied: 2, skipped: [], errors: [], remaining: 0 } },
  [ASSIGNMENTS]: { body: { applied: 1, errors: [] } },
};
const OK_CHECK = { fatal: [], rows: { Vehicles: [{ level: "ok", messages: [] }] } };

// As in apps-script-publish.test.ts.
const STACK_TRACE = /\n\s+at\s|\.js:\d+|(Type|Reference|Syntax|Range)Error|Cannot read|\bundefined\b|\[object Object\]/;

const plain = (value: unknown): any => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** The 40-character slug, the longest docs/sheet-schema.md allows. */
const LONGEST = "honda-super-cub-c125-limited-edition-red";

// ---------------------------------------------------------------------------------------------------------------------
// The upload.

/**
 * `size` bytes that run through every byte value, the high ones included, so a signed/unsigned slip or base64 text
 * stored in place of the bytes shows. `seed` gives each photo bytes of its own.
 */
function photoBytes(size: number, seed: number): Buffer {
  const pattern = Buffer.alloc(256);
  for (let i = 0; i < 256; i += 1) pattern[i] = (i * 37 + seed) & 0xff;
  return Buffer.alloc(size, pattern);
}

/** The Config tab of the valid workbook with photo_max_mb set to `value`, or without its row for `"no row"`. */
function configWith(value: unknown): unknown[][] {
  const [header, ...rows] = validWorkbook().Config;
  const kept = rows.filter((cells) => cells[0] !== "photo_max_mb");
  // The row goes in the middle, so a reader that looks only at the last row or a fixed one does not find it by chance.
  if (value !== "no row") kept.splice(3, 0, ["photo_max_mb", value]);
  return [header, ...kept];
}

type UploadWorld = {
  folders: Record<string, string[]>;
  properties?: Record<string, string>;
  /** The Config tab, or null for none. The valid workbook's, whose photo_max_mb is 5, when left out. */
  config?: unknown[][] | null;
  readOnlyFolders?: string[];
};

function uploadWorld({ folders, properties = PROPERTIES, config, readOnlyFolders }: UploadWorld): AppsScriptWorld {
  const tabs: Record<string, unknown[][]> = { ...validWorkbook(), PublishLog: [[...SHEET_TABS.PublishLog]] };
  if (config === null) delete tabs.Config;
  else if (config !== undefined) tabs.Config = config;
  return loadAppsScript({ properties, user: USER, tabs, folders, readOnlyFolders });
}

/** The upload's answer. A throw fails the test with what was thrown: the function answers and never throws. */
function uploadPhoto(script: AppsScriptWorld, args: unknown, what: string): any {
  try {
    return plain(script.call("addBikeUploadPhoto", args));
  } catch (error) {
    assert.fail(`${what}: addBikeUploadPhoto threw instead of answering: ${String((error as Error)?.message ?? error)}`);
  }
}

function photo(modelId: unknown, mimeType: unknown, data: Buffer, fileName: unknown = "IMG_0001.JPG") {
  return { modelId, fileName, mimeType, base64: data.toString("base64") };
}

function folderNames(script: AppsScriptWorld): Record<string, string[]> {
  return Object.fromEntries([...script.drive.folders].map(([id, files]) => [id, files.map(({ name }) => name)]));
}

/** The upload was refused: nothing was created and every folder holds what it held. */
function assertNoUpload(script: AppsScriptWorld, folders: Record<string, string[]>, what: string): void {
  assert.deepEqual(
    script.drive.created.map(({ folderId, name }) => `${folderId}/${name}`),
    [],
    `${what}: no file was created`,
  );
  assert.deepEqual(folderNames(script), folders, `${what}: every folder is as it was`);
}

/** The upload writes nothing to the sheet and calls nothing: the names reach Models on save. */
function assertSheetUntouched(script: AppsScriptWorld, what: string): void {
  for (const [name, tab] of script.tabs) assert.deepEqual(tab.touches, [], `${what}: nothing wrote to ${name}`);
  assert.deepEqual(
    script.fetches.map(({ path }) => path),
    [],
    `${what}: no request`,
  );
}

/** One file was created, in `folderId`, under `name`, with the type and exactly the bytes sent. */
function assertStored(script: AppsScriptWorld, folderId: string, name: string, mimeType: string, data: Buffer, what: string) {
  const created = script.drive.created.filter((file) => file.name === name);
  assert.equal(created.length, 1, `${what}: one file named ${name}: ${JSON.stringify(folderNames(script))}`);
  const [file] = created;
  assert.equal(file.folderId, folderId, `${what}: ${name} is in the PHOTO_FOLDER_ID folder`);
  assert.equal(file.mimeType, mimeType, `${what}: ${name} has the type sent`);
  assert.equal(file.data.length, data.length, `${what}: ${name} has the decoded size`);
  assert.ok(file.data.equals(data), `${what}: ${name} holds the bytes sent`);
}

function assertReadable(text: unknown, what: string): void {
  assert.equal(typeof text, "string", `${what}: a message`);
  assert.notEqual(String(text).trim(), "", `${what}: a message`);
  assert.doesNotMatch(String(text), STACK_TRACE, what);
  assert.ok(!String(text).includes(SECRET), `${what}: the secret stays out of what staff see`);
}

/** A refusal: an answer with a message and no name, nothing in Drive and nothing in the sheet. */
function assertRefused(script: AppsScriptWorld, result: any, folders: Record<string, string[]>, what: string): void {
  assert.equal(result?.ok, false, `${what}: ${JSON.stringify(result)}`);
  assertReadable(result.message, what);
  assert.equal(result.name, undefined, `${what}: no name is answered`);
  assertNoUpload(script, folders, what);
  assertSheetUntouched(script, what);
}

// ---------------------------------------------------------------------------------------------------------------------
// The save, for the photos cell.

type Texts = { ja: string; en: string; zh: string; ko: string };

function texts(label: string): { name: Texts; summary: Texts; description: Texts } {
  return {
    name: { ja: `${label}（名前）`, en: `${label} name`, zh: `${label}名称`, ko: `${label} 이름` },
    summary: { ja: `${label}の概要`, en: `${label} summary`, zh: `${label}简介`, ko: `${label} 요약` },
    description: { ja: `${label}の説明`, en: `${label} description`, zh: `${label}说明`, ko: `${label} 설명` },
  };
}

const text = (value: unknown): string => (value === undefined || value === null ? "" : String(value));

function headerIndex(headers: unknown[], name: string): number {
  return headers.findIndex((header) => String(header).trim().toLowerCase() === name);
}

/** The sheet row (1-based) whose `column` cell reads `key`, or 0. */
function rowWith(rows: unknown[][], column: string, key: string): number {
  const at = headerIndex(rows[0] ?? [], column);
  const index = rows.findIndex((cells, i) => i > 0 && text(cells?.[at]).trim() === key);
  return index < 0 ? 0 : index + 1;
}

/** A model's photos cell as the sheet holds it now, applied writes only: what the Worker reads. */
function photosCell(script: AppsScriptWorld, modelId: string): string | undefined {
  const rows = script.tabs.get("Models")?.rows ?? [];
  const row = rowWith(rows, "model_id", modelId);
  return row === 0 ? undefined : text(rows[row - 1][headerIndex(rows[0], "photos")]);
}

function rowsOf(call: FetchCall | undefined): Record<string, Record<string, unknown>[]> {
  const envelope = JSON.parse(String(call?.payload));
  return JSON.parse(envelope.payload).rows;
}

function workbookOf(script: AppsScriptWorld): Record<string, unknown[][]> {
  return Object.fromEntries([...script.tabs].map(([name, tab]) => [name, tab.rows.map((cells) => [...cells])]));
}

type Saving = { script: AppsScriptWorld; atPublish: () => string | undefined; published: () => boolean };

/**
 * A world whose Worker checks the proposed rows with the real checkProposedRows over the sheet as it stands, or answers
 * `check`, and whose /api/publish notes the photos cell of `modelId` as the Sheets API would read it then.
 */
function saving(
  tabs: Record<string, unknown[][]>,
  modelId: string,
  extra: { check?: unknown; folders?: Record<string, string[]> } & Pick<Options, "lockHeldElsewhere"> = {},
): Saving {
  let script: AppsScriptWorld | undefined;
  let seen: string | undefined;
  let published = false;
  const checkRoute: Route =
    extra.check === undefined
      ? () => {
          const world = script as AppsScriptWorld;
          const rows = parseProposedRows(rowsOf(world.fetches.filter((call) => call.path === CHECK).at(-1)));
          if (rows === null) return { status: 400, body: "The rows could not be read" };
          return { body: checkProposedRows(workbookOf(world), rows, Date.now()) };
        }
      : { body: extra.check };
  script = loadAppsScript({
    properties: PROPERTIES,
    user: USER,
    tabs,
    folders: extra.folders ?? { [FOLDER]: [] },
    lockHeldElsewhere: extra.lockHeldElsewhere,
    routes: {
      [CHECK]: checkRoute,
      [PUBLISH]: () => {
        published = true;
        seen = photosCell(script as AppsScriptWorld, modelId);
        return { body: REPORT };
      },
      ...STEP_ROUTES,
    },
  });
  return { script, atPublish: () => seen, published: () => published };
}

/** A save's answer; a throw fails the test with what was thrown. */
function save(script: AppsScriptWorld, draft: unknown, what: string): any {
  try {
    return plain(script.call("addBikeSave", draft));
  } catch (error) {
    assert.fail(`${what}: addBikeSave threw: ${String((error as Error)?.message ?? error)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------

test("a photo is uploaded into the photo folder under the next free model name and its name is answered", () => {
  assert.equal(LONGEST.length, 40);
  const cases: {
    label: string;
    folders: Record<string, string[]>;
    folderId: string;
    modelId: string;
    fileName: string;
    mimeType: string;
    size: number;
    name: string;
  }[] = [
    {
      label: "a JPEG into an empty folder; another folder holds the name",
      folders: { [FOLDER]: [], [OTHER_FOLDER]: ["adv-160-1.jpg"] },
      folderId: FOLDER,
      modelId: "adv-160",
      fileName: "IMG_0001.JPG",
      mimeType: "image/jpeg",
      size: 2_048,
      name: "adv-160-1.jpg",
    },
    {
      label: "a PNG after the model's two, in the folder PHOTO_FOLDER_ID names",
      folders: {
        [FOLDER]: ["pcx-125-3.png"],
        [OTHER_FOLDER]: ["pcx-125-1.png", "today-50-1.png", "pcx-125-2.png"],
      },
      folderId: OTHER_FOLDER,
      modelId: "pcx-125",
      fileName: "pcx side.png",
      mimeType: "image/png",
      size: 150_000,
      name: "pcx-125-3.png",
    },
    {
      label: "a WebP into the gap",
      folders: { [FOLDER]: ["nbox-660-1.webp", "nbox-660-3.webp", "nbox-660-4.webp"] },
      folderId: FOLDER,
      modelId: "nbox-660",
      fileName: "",
      mimeType: "image/webp",
      size: 1,
      name: "nbox-660-2.webp",
    },
    {
      label: "a model whose id begins another's; the extension follows the type, not the file name",
      folders: { [FOLDER]: ["pcx-125-1.jpg", "pcx-125-2.jpg"] },
      folderId: FOLDER,
      modelId: "pcx",
      fileName: "IMG_0042.PNG",
      mimeType: "image/jpeg",
      size: 750_000,
      name: "pcx-1.jpg",
    },
    {
      label: "the longest slug, a WebP sent as photo.jpg",
      folders: { [FOLDER]: [`${LONGEST}-1.webp`] },
      folderId: FOLDER,
      modelId: LONGEST,
      fileName: "photo.jpg",
      mimeType: "image/webp",
      size: 999,
      name: `${LONGEST}-2.webp`,
    },
  ];

  cases.forEach(({ label, folders, folderId, modelId, fileName, mimeType, size, name }, seed) => {
    const script = uploadWorld({ folders, properties: { ...PROPERTIES, PHOTO_FOLDER_ID: folderId } });
    const data = photoBytes(size, seed);
    const result = uploadPhoto(script, photo(modelId, mimeType, data, fileName), label);

    assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);
    assert.equal(result.name, name, `${label}: the name answered`);
    assert.equal(script.drive.created.length, 1, `${label}: one file created`);
    assertStored(script, folderId, name, mimeType, data, label);
    assert.deepEqual(
      folderNames(script),
      { ...folders, [folderId]: [...folders[folderId], name] },
      `${label}: the photo folder gained the file and the others are as they were`,
    );
    assertSheetUntouched(script, label);
  });
});

/** The valid workbook, which the real check accepts, with an empty PublishLog. */
function newModelTabs(): Record<string, unknown[][]> {
  return { ...validWorkbook(), PublishLog: [[...SHEET_TABS.PublishLog]] };
}

type NewDraft = {
  mode: "new";
  model: { modelId: string; typeId: string; brand: string; engineCc: number; seats: number; active: true; texts: unknown };
  rateClass: { id: string };
  vehicle: { plate: string };
  photos?: string[];
};

/** A new model in a class the valid workbook has, as the new-model tests draft one. */
function newDraft(modelId: string, typeId: string, classId: string, cc: number, seats: number, plate: string, photos?: string[]) {
  const draft: NewDraft = {
    mode: "new",
    model: { modelId, typeId, brand: "Honda", engineCc: cc, seats, active: true, texts: texts(modelId) },
    rateClass: { id: classId },
    vehicle: { plate },
  };
  if (photos !== undefined) draft.photos = photos;
  return draft;
}

test("a new model's photos go in its photos cell separated by commas", async () => {
  const cases: { label: string; draft: NewDraft; cell: string }[] = [
    {
      label: "two photos",
      draft: newDraft("adv-160", "scooter", "bike-125", 156, 2, "わ2001", ["adv-160-1.jpg", "adv-160-2.png"]),
      cell: "adv-160-1.jpg, adv-160-2.png",
    },
    {
      label: "one photo",
      draft: newDraft("sienta", "car", "car-k", 1490, 7, "沖縄 さ 12-34", ["sienta-1.webp"]),
      cell: "sienta-1.webp",
    },
    {
      label: "three photos, in the order taken",
      draft: newDraft("pcx-160", "scooter", "bike-125", 157, 2, "わ2002", ["pcx-160-2.jpg", "pcx-160-3.jpg", "pcx-160-1.webp"]),
      cell: "pcx-160-2.jpg, pcx-160-3.jpg, pcx-160-1.webp",
    },
    { label: "no photos", draft: newDraft("adv-161", "scooter", "bike-125", 156, 2, "わ2003", []), cell: "" },
    { label: "a draft without photos", draft: newDraft("adv-162", "scooter", "bike-125", 156, 2, "わ2004"), cell: "" },
  ];

  for (const { label, draft: given, cell } of cases) {
    const modelId = given.model.modelId;
    const folders = { [FOLDER]: [...(given.photos ?? [])] };

    // The check proposes the Models row with its photos, and the real check takes it.
    const checking = saving(newModelTabs(), modelId, { folders });
    const checked = plain(checking.script.call("addBikeCheck", given));
    assert.equal(checked?.ok, true, `${label}: check: ${JSON.stringify(checked)}`);
    assert.deepEqual(checked.fatal, [], `${label}: no fatal reason`);
    const proposed = rowsOf(checking.script.fetches.find((call) => call.path === CHECK));
    assert.equal(proposed.Models?.length, 1, `${label}: one Models row proposed`);
    assert.equal(text(proposed.Models[0].photos), cell, `${label}: the proposed photos cell`);
    for (const [tab, checks] of Object.entries(checked.rows as Record<string, { level: string; messages: string[] }[]>)) {
      checks.forEach((check, i) => assert.notEqual(check.level, "error", `${label}: ${tab} row ${i + 1}: ${check.messages}`));
    }

    // The save writes it, and Publish already sees it.
    const { script, atPublish, published } = saving(newModelTabs(), modelId, { folders });
    const result = save(script, given, label);
    assert.equal(result?.ok, true, `${label}: save: ${JSON.stringify(result)}`);
    assert.equal(photosCell(script, modelId), cell, `${label}: the Models photos cell`);
    assert.ok(published(), `${label}: Publish ran`);
    assert.equal(atPublish(), cell, `${label}: the photos cell was in the sheet when Publish ran`);
    assert.deepEqual(script.drive.created, [], `${label}: the save uploads nothing`);
  }

  // As staff do it: two photos uploaded for the new model, then the names they answered saved with it.
  const { script, atPublish } = saving(newModelTabs(), "adv-160", { folders: { [FOLDER]: ["adv-160-1.jpg"] } });
  const names = [photoBytes(3_000, 1), photoBytes(4_000, 2)].map((data, i) => {
    const answer = uploadPhoto(script, photo("adv-160", "image/jpeg", data), `upload ${i + 1}`);
    assert.equal(answer?.ok, true, `upload ${i + 1}: ${JSON.stringify(answer)}`);
    return answer.name as string;
  });
  assert.deepEqual(names, ["adv-160-2.jpg", "adv-160-3.jpg"], "the uploads' names");
  const result = save(script, newDraft("adv-160", "scooter", "bike-125", 156, 2, "わ2001", names), "upload then save");
  assert.equal(result?.ok, true, `upload then save: ${JSON.stringify(result)}`);
  assert.equal(photosCell(script, "adv-160"), "adv-160-2.jpg, adv-160-3.jpg", "upload then save: the photos cell");
  assert.equal(atPublish(), "adv-160-2.jpg, adv-160-3.jpg", "upload then save: Publish saw the photos");
});

// Models with its columns in another order, one header in capitals with spaces around and a column staff added, as in
// apps-script-add-bike.test.ts, so the photos cell is found by its header.
const MODEL_HEADERS = [
  "name_en",
  " Model_ID ",
  "staff memo",
  "Photos ",
  ...SHEET_TABS.Models.filter((header) => !["photos", "name_en", "model_id"].includes(header)),
];
const VEHICLE_HEADERS = ["notes", " Plate", "my notes", "publish_status", "base_usage_days", "model_id", "STATUS", "odometer_km"];

type Cells = Record<string, string | number | boolean>;

function tab(headers: string[], records: (Cells | null)[]): unknown[][] {
  const key = (header: string) => header.trim().toLowerCase();
  return [
    headers,
    ...records.map((record) => headers.map((header) => (record === null ? "" : (record[key(header)] ?? "")))),
  ];
}

function existingTabs(): Record<string, unknown[][]> {
  const model = (id: string, photos: string, extra: Cells = {}): Cells => ({
    model_id: id,
    type_id: "scooter",
    rate_class_id: "bike-125",
    brand: "Honda",
    sort: 1,
    active: true,
    name_en: id.toUpperCase(),
    name_ja: id,
    photos,
    ...extra,
  });
  return {
    Models: tab(MODEL_HEADERS, [
      model("pcx-125", "pcx-1.jpg, pcx-2.jpg"),
      null,
      model("rebel-250", "rebel-1.jpg、rebel-2.jpg，rebel-3.jpg", { "staff memo": "new tyres" }),
      model("nbox-660", ""),
      model("today-50", "today-a.jpg"),
    ]),
    Vehicles: tab(VEHICLE_HEADERS, [
      { plate: "わ1001", model_id: "pcx-125", status: "active", odometer_km: 1200 },
      { plate: "わ1002", model_id: "rebel-250", status: "retired", notes: "sold" },
    ]),
    PublishLog: [[...SHEET_TABS.PublishLog]],
  };
}

test("an existing model's photos are added to its photos cell, keeping the names there", () => {
  const photosAt = headerIndex(MODEL_HEADERS, "photos");
  const cases: { label: string; modelId: string; photos?: string[]; row: number; cell: string }[] = [
    {
      label: "one photo after two",
      modelId: "pcx-125",
      photos: ["pcx-125-1.jpg"],
      row: 2,
      cell: "pcx-1.jpg, pcx-2.jpg, pcx-125-1.jpg",
    },
    {
      label: "two photos after names separated by 、 and ，",
      modelId: "rebel-250",
      photos: ["rebel-250-1.jpg", "rebel-250-2.png"],
      row: 4,
      cell: "rebel-1.jpg、rebel-2.jpg，rebel-3.jpg, rebel-250-1.jpg, rebel-250-2.png",
    },
    {
      label: "two photos into an empty cell",
      modelId: "nbox-660",
      photos: ["nbox-660-1.webp", "nbox-660-2.jpg"],
      row: 5,
      cell: "nbox-660-1.webp, nbox-660-2.jpg",
    },
    { label: "no photos", modelId: "today-50", photos: [], row: 6, cell: "today-a.jpg" },
    { label: "a draft without photos", modelId: "pcx-125", row: 2, cell: "pcx-1.jpg, pcx-2.jpg" },
  ];

  cases.forEach(({ label, modelId, photos, row, cell }, i) => {
    const before = existingTabs();
    const draft = { mode: "existing", modelId, vehicle: { plate: `わ90${i}1` }, ...(photos === undefined ? {} : { photos }) };
    const { script, atPublish, published } = saving(before, modelId, {
      check: OK_CHECK,
      folders: { [FOLDER]: [...(photos ?? [])] },
    });
    const result = save(script, draft, label);

    assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);
    // Only the model's photos cell changed in Models; every other cell and row is as it was.
    const expected = before.Models.map((cells) => [...cells]);
    expected[row - 1][photosAt] = cell;
    assert.deepEqual(script.tabs.get("Models")?.rows, expected, `${label}: Models with the photos cell of row ${row}`);
    assert.ok(published(), `${label}: Publish ran`);
    assert.equal(atPublish(), cell, `${label}: the photos cell was in the sheet when Publish ran`);
    // The vehicle row is still written below the others.
    const vehicles = script.tabs.get("Vehicles")?.rows ?? [];
    assert.equal(vehicles.length, before.Vehicles.length + 1, `${label}: one Vehicles row added`);
    assert.equal(rowWith(vehicles, "plate", draft.vehicle.plate), vehicles.length, `${label}: the new plate's row`);
  });

  // A save that writes nothing leaves the photos cell as it was too.
  const draft = { mode: "existing", modelId: "pcx-125", vehicle: { plate: "わ9999" }, photos: ["pcx-125-1.jpg"] };
  const refusals: { label: string; check: unknown; lockHeldElsewhere?: boolean }[] = [
    { label: "the check has an error", check: { fatal: [], rows: { Vehicles: [{ level: "error", messages: ["plate: used twice"] }] } } },
    { label: "the check has a fatal reason", check: { fatal: ["Vehicles: the header plate is missing"], rows: {} } },
    { label: "another Publish holds the lock", check: OK_CHECK, lockHeldElsewhere: true },
  ];
  for (const { label, check, lockHeldElsewhere } of refusals) {
    const before = existingTabs();
    const { script, published } = saving(before, "pcx-125", {
      check,
      lockHeldElsewhere,
      folders: { [FOLDER]: ["pcx-125-1.jpg"] },
    });
    const result = save(script, draft, label);
    assert.equal(result?.ok, false, `${label}: ${JSON.stringify(result)}`);
    assert.deepEqual(script.tabs.get("Models")?.rows, before.Models, `${label}: Models is as it was`);
    assert.deepEqual(script.tabs.get("Models")?.touches, [], `${label}: nothing wrote to Models`);
    assert.equal(published(), false, `${label}: no Publish`);
    assert.deepEqual(
      script.fetches.filter(({ path }) => PUBLISH_PATHS.includes(path)).map(({ path }) => path),
      [],
      `${label}: no Publish request`,
    );
  }
});

test("a type other than JPEG, PNG or WebP is refused without an upload", () => {
  const folders = { [FOLDER]: ["pcx-125-1.jpg"], [OTHER_FOLDER]: [] };
  const types: unknown[] = [
    "image/gif",
    "image/heic",
    "image/svg+xml",
    "image/bmp",
    "image/jpg",
    "application/pdf",
    "text/html",
    "",
    undefined,
    null,
  ];
  types.forEach((mimeType, seed) => {
    const what = `type ${JSON.stringify(mimeType)}`;
    const script = uploadWorld({ folders });
    const result = uploadPhoto(script, photo("pcx-125", mimeType, photoBytes(4_096, seed), "IMG_0001.JPG"), what);
    assertRefused(script, result, folders, what);
  });

  // The same photo as a JPEG is stored, so the refusals above are about the type.
  const script = uploadWorld({ folders });
  const data = photoBytes(4_096, 0);
  const result = uploadPhoto(script, photo("pcx-125", "image/jpeg", data), "image/jpeg");
  assert.equal(result?.ok, true, `image/jpeg: ${JSON.stringify(result)}`);
  assert.equal(result.name, "pcx-125-2.jpg", "image/jpeg: the name");
  assertStored(script, FOLDER, "pcx-125-2.jpg", "image/jpeg", data, "image/jpeg");
});

test("a photo over photo_max_mb is refused without an upload", () => {
  // photo_max_mb as a number and as text the Worker reads the same way, and a photo one byte over its limit; then one at
  // the limit exactly, which is stored. At the limit the base64 text is a third longer than the limit, so only the
  // decoded bytes count.
  const cases: { maxMb: unknown; limit: number; mimeType: string; name: string }[] = [
    { maxMb: 1, limit: 1 * MB, mimeType: "image/jpeg", name: "pcx-125-1.jpg" },
    { maxMb: 2, limit: 2 * MB, mimeType: "image/png", name: "pcx-125-1.png" },
    { maxMb: "3", limit: 3 * MB, mimeType: "image/webp", name: "pcx-125-1.webp" },
  ];
  cases.forEach(({ maxMb, limit, mimeType, name }, seed) => {
    const what = `photo_max_mb ${JSON.stringify(maxMb)}`;
    const folders = { [FOLDER]: [] as string[] };
    const script = uploadWorld({ folders, config: configWith(maxMb) });

    const over = uploadPhoto(script, photo("pcx-125", mimeType, photoBytes(limit + 1, seed)), `${what}, ${limit + 1} bytes`);
    assertRefused(script, over, folders, `${what}, ${limit + 1} bytes`);

    const data = photoBytes(limit, seed + 10);
    assert.ok(data.toString("base64").length > limit, "the base64 text is longer than the limit");
    const at = uploadPhoto(script, photo("pcx-125", mimeType, data), `${what}, ${limit} bytes`);
    assert.equal(at?.ok, true, `${what}, ${limit} bytes: ${JSON.stringify(at)}`);
    assert.equal(at.name, name, `${what}, ${limit} bytes: the name`);
    assertStored(script, FOLDER, name, mimeType, data, `${what}, ${limit} bytes`);
  });

  // A limit of 2 takes what a limit of 1 refuses, so the limit is read from Config, not fixed.
  const script = uploadWorld({ folders: { [FOLDER]: [] }, config: configWith(2) });
  const data = photoBytes(1_500_000, 7);
  const result = uploadPhoto(script, photo("pcx-125", "image/jpeg", data), "1,500,000 bytes under a limit of 2");
  assert.equal(result?.ok, true, `1,500,000 bytes under a limit of 2: ${JSON.stringify(result)}`);
  assertStored(script, FOLDER, "pcx-125-1.jpg", "image/jpeg", data, "1,500,000 bytes under a limit of 2");
});

test("a missing PHOTO_FOLDER_ID is a readable message, not a stack trace", () => {
  const folders: Record<string, string[]> = { [FOLDER]: [], [OTHER_FOLDER]: ["pcx-125-1.jpg"] };
  const withoutFolder = { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: SECRET };
  const cases: { label: string; properties: Record<string, string> }[] = [
    { label: "no PHOTO_FOLDER_ID", properties: withoutFolder },
    { label: "a blank PHOTO_FOLDER_ID", properties: { ...withoutFolder, PHOTO_FOLDER_ID: "" } },
  ];
  for (const { label, properties } of cases) {
    const script = uploadWorld({ folders, properties });
    const result = uploadPhoto(script, photo("pcx-125", "image/jpeg", photoBytes(2_000, 3)), label);
    assertRefused(script, result, folders, label);
    assert.ok(String(result.message).includes("PHOTO_FOLDER_ID"), `${label}: names the property to set: ${result.message}`);
  }
});

test("a name already in the folder is never reused", () => {
  // Uploads one after another: each takes the smallest number no file in the folder has, counting the ones before it.
  // The folder already holds one name twice, as a hand upload can leave it.
  const folders = { [FOLDER]: ["pcx-125-2.jpg", "pcx-125-4.jpg", "pcx-125-4.jpg", "rebel-250-1.jpg"] };
  const script = uploadWorld({ folders });
  const expected = ["pcx-125-1.jpg", "pcx-125-3.jpg", "pcx-125-5.jpg", "pcx-125-6.jpg"];
  const sent: Buffer[] = [];
  const answered = expected.map((_, i) => {
    const data = photoBytes(1_000 + i, 20 + i);
    sent.push(data);
    const result = uploadPhoto(script, photo("pcx-125", "image/jpeg", data), `upload ${i + 1}`);
    assert.equal(result?.ok, true, `upload ${i + 1}: ${JSON.stringify(result)}`);
    return result.name as string;
  });
  assert.deepEqual(answered, expected, "each upload takes the next free number");
  answered.forEach((name, i) => assertStored(script, FOLDER, name, "image/jpeg", sent[i], `upload ${i + 1}`));

  // Numbers count as numbers: with 1 to 10 taken, the next is 11.
  const ten = Array.from({ length: 10 }, (_, i) => `cub-110-${i + 1}.png`);
  const counted = uploadWorld({ folders: { [FOLDER]: ten } });
  const eleventh = uploadPhoto(counted, photo("cub-110", "image/png", photoBytes(500, 5)), "after ten");
  assert.equal(eleventh?.ok, true, `after ten: ${JSON.stringify(eleventh)}`);
  assert.equal(eleventh.name, "cub-110-11.png", "after ten");

  // Whatever the other types in the folder, an answered name is never one the folder already had.
  const mixed = uploadWorld({ folders: { [FOLDER]: ["nbox-660-1.png", "nbox-660-2.jpg", "nbox-660-1.webp"] } });
  const uploads: [string, string][] = [
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["image/jpeg", "jpg"],
  ];
  uploads.forEach(([mimeType, extension], i) => {
    const what = `mixed folder, upload ${i + 1} (${mimeType})`;
    const before = folderNames(mixed)[FOLDER];
    const result = uploadPhoto(mixed, photo("nbox-660", mimeType, photoBytes(800, 40 + i)), what);
    assert.equal(result?.ok, true, `${what}: ${JSON.stringify(result)}`);
    assert.match(String(result.name), new RegExp(`^nbox-660-[1-9]\\d*\\.${extension}$`), `${what}: <modelId>-<n>.${extension}`);
    assert.ok(!before.includes(result.name), `${what}: ${result.name} was not in the folder: ${JSON.stringify(before)}`);
  });

  // What the Worker's copy needs: every name the script created is held by exactly one file in the folder.
  for (const world of [script, mixed]) {
    const names = folderNames(world)[FOLDER];
    for (const { name } of world.drive.created) {
      assert.equal(names.filter((held) => held === name).length, 1, `${name} is held by one file: ${JSON.stringify(names)}`);
    }
  }
});

test("with no readable photo_max_mb the upload has no size limit", () => {
  // Over the workbook's 5 MB, so a fallback limit of 5 would refuse it.
  const size = 6 * MB + 1;
  const cases: { label: string; config: unknown[][] | null }[] = [
    { label: "no Config tab", config: null },
    { label: "no photo_max_mb row", config: configWith("no row") },
    { label: "a blank photo_max_mb", config: configWith("") },
    { label: "photo_max_mb as words", config: configWith("five") },
  ];
  cases.forEach(({ label, config }, seed) => {
    const script = uploadWorld({ folders: { [FOLDER]: ["adv-160-1.webp"] }, config });
    const data = photoBytes(size, seed);
    const result = uploadPhoto(script, photo("adv-160", "image/webp", data), label);
    assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);
    assert.equal(result.name, "adv-160-2.webp", `${label}: the name`);
    assertStored(script, FOLDER, "adv-160-2.webp", "image/webp", data, label);
  });
});

test("a bad model id is refused without an upload", () => {
  const folders = { [FOLDER]: ["pcx-125-1.jpg"] };
  const ids: unknown[] = [
    "",
    "   ",
    undefined,
    null,
    125,
    "PCX-125",
    "pcx_125",
    "pcx 125",
    "pcx/125",
    "../pcx-125",
    "pcx--125",
    "-pcx",
    "pcx-",
    "pcx-125.jpg",
    "ｐｃｘ",
    `${LONGEST}x`,
  ];
  ids.forEach((modelId, seed) => {
    const what = `model id ${JSON.stringify(modelId)}`;
    const script = uploadWorld({ folders });
    const result = uploadPhoto(script, photo(modelId, "image/jpeg", photoBytes(1_024, seed)), what);
    assertRefused(script, result, folders, what);
  });

  // A slug goes through, so the refusals above are about the id.
  const script = uploadWorld({ folders });
  const result = uploadPhoto(script, photo("pcx-125", "image/jpeg", photoBytes(1_024, 0)), "pcx-125");
  assert.equal(result?.ok, true, `pcx-125: ${JSON.stringify(result)}`);
  assert.equal(result.name, "pcx-125-2.jpg", "pcx-125");
});

test("a PHOTO_FOLDER_ID naming no folder, or one the user cannot add to, is a readable message", () => {
  const folders = { [FOLDER]: ["pcx-125-1.jpg"], [OTHER_FOLDER]: [] };
  const cases: { label: string; folderId: string; readOnlyFolders?: string[] }[] = [
    { label: "an id that names no folder", folderId: "1NoSuchFolder" },
    { label: "a folder the user may only view", folderId: OTHER_FOLDER, readOnlyFolders: [OTHER_FOLDER] },
  ];
  for (const { label, folderId, readOnlyFolders } of cases) {
    const script = uploadWorld({ folders, readOnlyFolders, properties: { ...PROPERTIES, PHOTO_FOLDER_ID: folderId } });
    const result = uploadPhoto(script, photo("pcx-125", "image/jpeg", photoBytes(2_000, 9)), label);
    assertRefused(script, result, folders, label);
  }
});

test("an upload that cannot be read answers a message and never throws", () => {
  const folders = { [FOLDER]: [] };
  const good = photo("pcx-125", "image/jpeg", photoBytes(2_000, 11));
  const cases: { label: string; args: unknown }[] = [
    { label: "no argument", args: undefined },
    { label: "null", args: null },
    { label: "a string", args: "pcx-125" },
    { label: "no base64", args: { modelId: "pcx-125", fileName: "a.jpg", mimeType: "image/jpeg" } },
    { label: "base64 that is a number", args: { ...good, base64: 42 } },
    { label: "text that is not base64", args: { ...good, base64: "not base64!!" } },
  ];
  for (const { label, args } of cases) {
    const script = uploadWorld({ folders });
    const result = uploadPhoto(script, args, label);
    assertRefused(script, result, folders, label);
  }
});

test("the panel's photo step reads the file as base64 and sends it to addBikeUploadPhoto", () => {
  const html = readFileSync(new URL("AddBike.html", SCRIPT_DIR), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
  const called = Array.from(html.matchAll(/\bcallServer\s*\(\s*(["'`])([^"'`]*)\1/g), (match) => match[2]);
  assert.ok(called.includes("addBikeUploadPhoto"), `AddBike.html calls addBikeUploadPhoto: ${JSON.stringify(called)}`);
  assert.match(html, /type\s*=\s*["'`]file["'`]/i, "AddBike.html has a file input");
  assert.match(html, /\bFileReader\b/, "AddBike.html reads the file with FileReader");
});
