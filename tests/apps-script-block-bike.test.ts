// The Block a bike panel (apps-script/BlockBike.js and BlockBikePanel.html) run in node:vm against the fake Google services.
// The clock is fixed through the helper's `web` state, so block ids are worked out by hand from the time in Japan and the
// uuids handed out. Rows are read back by header, never by column, and expected cells are written out here, never taken
// from the script. Messages are free text: tests look for facts in them (a block id, a booking ref, a plate), not for
// sentences.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SHEET_TABS, validateBlocks } from "../src/lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../src/lib/crypto.ts";
import {
  type AppsScriptWorld,
  loadAppsScript,
  type Options,
  type Reply,
  type Route,
  sheetsApiValues,
  type WebState,
} from "./helpers/apps-script.ts";

const SCRIPT_DIR = new URL("../apps-script/", import.meta.url);

const BASE_URL = "https://reservation-one.example.dev";
const SECRET = "publish-secret-one";
const USER = "staff@okinawa-dream.example";
const PROPERTIES = { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: SECRET };

const CATALOG_PATH = "/api/staff/catalog";
const BLOCKS = "/api/publish/blocks";
const ROUND_CAP = 10;

const STACK_TRACE = /\n\s+at\s|\.js:\d+|(Type|Reference|Syntax|Range)Error|Cannot read|\bundefined\b|\[object Object\]/;

// 15:30 UTC on 19 November 2026 is 00:30 on the 20th in Japan.
const NOW = Date.UTC(2026, 10, 19, 15, 30);
const NOW_STAMP = "20261120-0030";
// 02:07 UTC on 5 January 2027 is 11:07 the same day in Japan.
const LATER = Date.UTC(2027, 0, 5, 2, 7);
const LATER_STAMP = "20270105-1107";

const UUID_A = "a1b2c3d4-0000-4000-8000-000000000001";
const UUID_B = "9f3c1e2a-1111-4111-8111-000000000002";
const UUID_C = "7e0d55aa-2222-4222-8222-000000000003";
const UUID_D = "c0ffee11-3333-4333-8333-000000000004";

type Plate = { plate: string; status: "active" | "maintenance" | "retired" };
type Model = {
  id: string;
  nameJa: string;
  nameEn: string;
  typeId: string;
  active: boolean;
  depositJpy: number;
  plates: Plate[];
};

function catalog(models: Model[]) {
  return {
    ok: true,
    version: 412,
    models,
    packages: [],
    prices: [],
    slots: ["09:00", "09:30"],
    config: { shopOpen: "09:00", shopClose: "18:00", slotMinutes: 30, minLeadHours: 2, maxDaysAhead: 365 },
  };
}

const MODELS: Model[] = [
  {
    id: "pcx-125",
    nameJa: "PCX",
    nameEn: "PCX",
    typeId: "scooter",
    active: true,
    depositJpy: 3000,
    plates: [
      { plate: "わ1001", status: "active" },
      { plate: "わ1002", status: "maintenance" },
    ],
  },
  {
    id: "forza-250",
    nameJa: "フォルツァ",
    nameEn: "Forza",
    typeId: "motorcycle",
    active: true,
    depositJpy: 5000,
    plates: [
      { plate: "わ2002", status: "active" },
      { plate: "沖縄 あ 35-80", status: "retired" },
    ],
  },
  {
    id: "jimny",
    nameJa: "ジムニー",
    nameEn: "Jimny",
    typeId: "car",
    active: true,
    depositJpy: 10000,
    plates: [{ plate: "わ3003", status: "active" }],
  },
  {
    id: "old-50",
    nameJa: "旧型",
    nameEn: "Old",
    typeId: "scooter",
    active: false,
    depositJpy: 3000,
    plates: [{ plate: "わ5005", status: "retired" }],
  },
];

const CATALOG = catalog(MODELS);

const SYNCED: Reply = { body: { processed: 1, remaining: 0, errors: [], cursor: null } };

/** A header as the sheet matches it, written here so nothing is taken from the script. */
function key(header: unknown): string {
  return typeof header === "string" ? header.normalize("NFKC").trim().toLowerCase() : "";
}

const STANDARD = [...SHEET_TABS.Blocks];
const STANDARD_ROW = ["BLK-1", "pcx-125", "", "2027-07-15 09:00", "2027-07-16 18:00", "Klook", "KL-1234", "Group", "ok"];

// Every Blocks header in another order, two of them in other cases or with spaces, and a column staff added.
const SHUFFLED = ["Note", "end", " Plate ", "publish_status", "my column", "channel", "BLOCK_ID", "start", "reference", "model_id"];
const SHUFFLED_ROWS: unknown[][] = [
  ["Group of two", "2027-07-16 18:00", "", "ok", "mine", "Klook", "BLK-1", "2027-07-15 09:00", "KL-1234", "pcx-125"],
  ["", "2027-08-02 12:00", "わ2002", "error: Conflicts", "", "walk-in", "BLK-2", "2027-08-01 10:00", "", "forza-250"],
  ["oil", "2027-09-01 18:00", "わ3003", "", "x", "maintenance", "MNT-20261001-0900-dead", "2027-08-30 09:00", "", "jimny"],
];

const clock = (now: number): WebState => ({ now, quota: 100, sent: [], sendCalls: 0, sendFailures: [], cache: new Map() });

type World = Omit<Options, "tabs" | "routes" | "web"> & {
  now?: number;
  blocks?: unknown[][];
  publishLog?: unknown[][];
  routes?: Record<string, Route>;
};

// The sheet is in Japan time, as Set up tabs leaves it, so a date-time written as text is read on Japan's wall clock.
function world({ now = NOW, blocks = [STANDARD, STANDARD_ROW], publishLog, routes = {}, ...rest }: World = {}) {
  return loadAppsScript({
    properties: PROPERTIES,
    user: USER,
    timeZone: "Asia/Tokyo",
    ...rest,
    web: clock(now),
    tabs: { Blocks: blocks, PublishLog: publishLog ?? [[...SHEET_TABS.PublishLog]] },
    routes: { [CATALOG_PATH]: { body: CATALOG }, [BLOCKS]: SYNCED, ...routes },
  });
}

// Values cross out of the script's realm with another Object prototype, which deepEqual refuses. A copy is plain.
const plain = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

type Input = { modelId?: unknown; plate?: unknown; start?: unknown; end?: unknown; reason?: unknown };
type Saved = { ok: boolean; blockId?: unknown; row?: unknown; level?: unknown; synced?: unknown; message?: unknown };

function call(script: AppsScriptWorld, input: Input): unknown {
  assert.ok(script.isFunction("blockPanelSave"), "blockPanelSave is a global function");
  return script.call("blockPanelSave", input);
}

function save(script: AppsScriptWorld, input: Input): Saved {
  const answer = plain(call(script, input)) as Saved;
  assert.equal(answer?.ok, true, `saved ${JSON.stringify(input)}: ${JSON.stringify(answer)}`);
  assert.equal(typeof answer.message, "string", "a message for staff");
  assert.doesNotMatch(String(answer.message), STACK_TRACE);
  return answer;
}

/** A refusal is a throw or `{ ok: false, message }`. Either way it names a reason, not a stack trace. */
function refusal(script: AppsScriptWorld, input: Input): string {
  // Outside the try, so a missing function is a failure here and never counts as a refusal.
  assert.ok(script.isFunction("blockPanelSave"), "blockPanelSave is a global function");
  let answer: unknown;
  try {
    answer = script.call("blockPanelSave", input);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    assert.doesNotMatch(message, STACK_TRACE, `refused ${JSON.stringify(input)} with a reason: ${message}`);
    return message;
  }
  const { ok, message } = (plain(answer) ?? {}) as Saved;
  assert.equal(ok, false, `refused ${JSON.stringify(input)}: ${JSON.stringify(answer)}`);
  assert.equal(typeof message, "string", "a refusal names its reason");
  assert.notEqual(String(message).trim(), "");
  assert.doesNotMatch(String(message), STACK_TRACE);
  return String(message);
}

function tabRows(script: AppsScriptWorld, name: string): unknown[][] {
  const tab = script.tabs.get(name);
  assert.ok(tab !== undefined, `the ${name} tab exists`);
  return structuredClone(tab.rows);
}

/** The Blocks tab as the sheet shows it: every row padded to the header row's width. */
function blocksGrid(script: AppsScriptWorld): unknown[][] {
  const rows = tabRows(script, "Blocks");
  const width = rows[0].length;
  return rows.map((cells) => Array.from({ length: width }, (_, i) => cells?.[i] ?? ""));
}

function cellsOf(headers: unknown[], row: unknown[]): Record<string, unknown> {
  return Object.fromEntries(headers.map((header, i) => [key(header), row[i] ?? ""]));
}

/** The row a save should write: each value under its header, '' under every other column. */
function expectedRow(headers: unknown[], record: Record<string, unknown>): unknown[] {
  return headers.map((header) => record[key(header)] ?? "");
}

function logRows(script: AppsScriptWorld): unknown[][] {
  return tabRows(script, "PublishLog").slice(1);
}

function logCell(row: unknown[], column: (typeof SHEET_TABS.PublishLog)[number]): string {
  return String(row[SHEET_TABS.PublishLog.indexOf(column)] ?? "");
}

function publishPaths(script: AppsScriptWorld): string[] {
  return script.fetches.map(({ path }) => path).filter((path) => path.startsWith("/api/publish"));
}

async function signedPayloads(script: AppsScriptWorld, path: string, now: number): Promise<unknown[]> {
  const payloads: unknown[] = [];
  for (const fetched of script.fetches.filter((call) => call.path === path)) {
    const verified = await verifyEnvelope(SECRET, String(fetched.payload), now);
    assert.ok(verified.ok, `${path}: ${JSON.stringify(verified)}`);
    payloads.push(verified.payload);
  }
  return payloads;
}

function hasNumber(text: string, value: number): boolean {
  return new RegExp(`(?<!\\d)${value}(?!\\d)`).test(text);
}

/** The block_id on the last Blocks row, read by its header, for a Worker reply that names the row just saved. */
function lastBlockId(script: AppsScriptWorld): string {
  const rows = tabRows(script, "Blocks");
  return String(cellsOf(rows[0], rows[rows.length - 1]).block_id);
}

/** Nothing written to Blocks or PublishLog and no publish request: what every refused save leaves. */
function assertNothingDone(script: AppsScriptWorld, blocks: unknown[][], what: string): void {
  assert.deepEqual(tabRows(script, "Blocks"), blocks, `${what}: Blocks is as it was`);
  assert.deepEqual(script.tabs.get("Blocks")?.touches, [], `${what}: nothing wrote to Blocks`);
  assert.deepEqual(logRows(script), [], `${what}: nothing is logged`);
  assert.deepEqual(publishPaths(script), [], `${what}: no sync request`);
}

function withoutComments(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function panelFile(name: string): string {
  const text = readFileSync(new URL(name, SCRIPT_DIR), "utf8");
  assert.notEqual(text.trim(), "", `${name} has content`);
  return text;
}

/** Every object anywhere in the value, for answers whose exact shape the ticket leaves free. */
function objectsIn(value: unknown): Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return [];
  const own = Array.isArray(value) ? [] : [value as Record<string, unknown>];
  return [...own, ...Object.values(value).flatMap(objectsIn)];
}

const START = "2027-07-15 09:00";
const END = "2027-07-16 18:00";

/**
 * The cell a start or end lands in: Sheets reads `YYYY-MM-DD HH:mm` as a date-time on the sheet's wall clock, Japan
 * time, UTC+9 all year. Worked out here, not by the fake.
 */
function jst(text: unknown): Date {
  const [, year, month, day, hour, minute] = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(text)) ?? [];
  assert.ok(year !== undefined, `a YYYY-MM-DD HH:mm date-time: ${String(text)}`);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute)));
}

test("Block a bike is a dashboard action that opens the BlockBike dialog", async () => {
  const script = world();
  const actions = script.evaluate("DASHBOARD_ACTIONS_") as { label: string; fn: string }[];
  assert.deepEqual(
    actions.filter(({ fn, label }) => fn === "openBlockBike" || label === "Block a bike"),
    [{ label: "Block a bike", fn: "openBlockBike" }],
    "one Block a bike action",
  );

  script.call("onOpen");
  const items = script.menus.flatMap((menu) => menu.items);
  assert.ok(
    items.some((item) => Array.isArray(item) && item[0] === "Block a bike" && item[1] === "openBlockBike"),
    `the menu lists Block a bike: ${JSON.stringify(items)}`,
  );
  const home = plain(script.call("dashboardHome")) as { actions: { label: string; fn: string }[] };
  assert.ok(
    home.actions.some(({ label, fn }) => label === "Block a bike" && fn === "openBlockBike"),
    `the home lists Block a bike: ${JSON.stringify(home.actions)}`,
  );

  script.call("openBlockBike");
  assert.equal(script.shown.length, 1, "one dialog");
  const [shown] = script.shown;
  assert.equal(shown.kind, "modal");
  assert.equal(shown.title, "Block a bike");
  assert.equal(shown.width, 720);
  assert.equal(shown.height, 640);
  const shell = panelFile("PanelShell.html");
  const at = shown.html.indexOf(shell);
  assert.ok(at >= 0, "the dialog holds PanelShell.html");
  assert.ok(shown.html.indexOf(panelFile("BlockBikePanel.html"), at + shell.length) >= 0, "then BlockBikePanel.html");
  assert.deepEqual(script.fetches, [], "opening the dialog sends nothing");

  // The panel reads its choices and saves through the public functions.
  const code = withoutComments(panelFile("BlockBikePanel.html"));
  const called = Array.from(code.matchAll(/\bcallServer\s*\(\s*(["'`])([^"'`]*)\1/g), (match) => match[2]);
  for (const fn of ["blockPanelOptions", "blockPanelSave"]) {
    assert.ok(called.includes(fn), `BlockBikePanel.html calls ${fn}: ${JSON.stringify(called)}`);
  }

  // Its choices: every model with every plate and its status, retired and in maintenance too, from the catalog read.
  const other: Model[] = [
    { ...MODELS[3], id: "adv-160", plates: [{ plate: "わ7007", status: "maintenance" }] },
    { ...MODELS[1], plates: [{ plate: "わ8008", status: "retired" }, { plate: "わ8009", status: "active" }] },
  ];
  for (const models of [MODELS, other]) {
    const options = world({ routes: { [CATALOG_PATH]: { body: catalog(models) } } });
    const answer = plain(options.call("blockPanelOptions"));
    const objects = objectsIn(answer);
    for (const model of models) {
      const holder = objects.find((object) => Object.values(object).includes(model.id));
      assert.ok(holder !== undefined, `the options name ${model.id}: ${JSON.stringify(answer)}`);
      const inside = objectsIn(holder);
      for (const { plate, status } of model.plates) {
        assert.ok(
          inside.some((object) => object.plate === plate && object.status === status),
          `${model.id} lists ${plate} as ${status}: ${JSON.stringify(holder)}`,
        );
      }
    }
    assert.deepEqual(options.fetches.map(({ path }) => path), [CATALOG_PATH]);
    assert.deepEqual(await signedPayloads(options, CATALOG_PATH, NOW), [{ requestedBy: USER }]);
  }
});

test("save appends a maintenance row under the Blocks headers and syncs it", async () => {
  const cases: {
    label: string;
    now: number;
    uuid: string;
    blocks: unknown[][];
    input: Input;
    blockId: string;
    model: string;
    plate: string;
  }[] = [
    {
      label: "the standard headers and a plate in maintenance",
      now: NOW,
      uuid: UUID_A,
      blocks: [STANDARD, STANDARD_ROW],
      input: { modelId: "pcx-125", plate: "わ1002", start: START, end: END, reason: "ブレーキ交換" },
      blockId: `MNT-${NOW_STAMP}-a1b2`,
      model: "pcx-125",
      plate: "わ1002",
    },
    {
      label: "shuffled headers, a staff column and a blank plate",
      now: LATER,
      uuid: UUID_B,
      blocks: [SHUFFLED, ...SHUFFLED_ROWS],
      input: { modelId: "forza-250", plate: "", start: "2027-03-01 10:30", end: "2027-03-03 17:00", reason: "Oil change" },
      blockId: `MNT-${LATER_STAMP}-9f3c`,
      model: "forza-250",
      plate: "",
    },
    {
      label: "a tab with only its headers and a retired plate",
      now: NOW,
      uuid: UUID_C,
      blocks: [SHUFFLED],
      input: { modelId: "forza-250", plate: "沖縄 あ 35-80", start: "2028-02-28 23:30", end: "2028-02-29 00:30", reason: "車検" },
      blockId: `MNT-${NOW_STAMP}-7e0d`,
      model: "forza-250",
      plate: "沖縄 あ 35-80",
    },
  ];
  for (const { label, now, uuid, blocks, input, blockId, model, plate } of cases) {
    const holder: { script?: AppsScriptWorld; atSync?: unknown[][] } = {};
    const script = world({
      now,
      blocks,
      uuids: [uuid],
      routes: {
        [BLOCKS]: () => {
          holder.atSync ??= tabRows(holder.script as AppsScriptWorld, "Blocks");
          return SYNCED;
        },
      },
    });
    holder.script = script;
    const answer = save(script, input);

    const headers = blocks[0];
    const row = expectedRow(headers, {
      block_id: blockId,
      model_id: model,
      plate,
      start: jst(input.start),
      end: jst(input.end),
      channel: "maintenance",
      note: input.reason,
    });
    const grid = blocksGrid(script);
    assert.equal(grid.length, blocks.length + 1, `${label}: one row added`);
    assert.deepEqual(grid.slice(0, blocks.length), blocks, `${label}: the header and every other row are as they were`);
    assert.deepEqual(grid[blocks.length], row, `${label}: the new row, each value under its header`);

    assert.equal(answer.blockId, blockId, label);
    assert.equal(answer.row, blocks.length + 1, `${label}: the sheet row it wrote`);
    assert.equal(answer.level, "ok", label);
    assert.notEqual(answer.synced, false, label);

    // Synced after the write, with the blocks step alone: no catalog publish, no photos, no assignments.
    assert.ok(holder.atSync !== undefined, `${label}: the blocks step ran`);
    assert.equal(holder.atSync.length, blocks.length + 1, `${label}: the row was on the tab when the sync ran`);
    assert.deepEqual(publishPaths(script), [BLOCKS], label);
    assert.deepEqual(await signedPayloads(script, BLOCKS, now), [{ requestedBy: USER }], label);
    assert.equal(logRows(script).length, 1, `${label}: one PublishLog row`);
    assert.equal(script.lock.held(), false, `${label}: the lock is released`);
  }
});

test("a bike in the way comes back as the row's error with what is in the way", () => {
  type Named = { name: string; message: string };
  // Errors for other blocks share the list: a block id the panel did not write, a blank-id row, the whole tab.
  const others: Named[] = [
    { name: "BLK-7", message: "Conflicts with B3TZ8VWN on わ2002" },
    { name: "row 5", message: "start: not a date and time" },
  ];
  const cases: { label: string; input: Input; ours: string | null; rounds: (ours: string) => Reply[] }[] = [
    {
      label: "a booking on the plate, among other errors",
      input: { modelId: "pcx-125", plate: "わ1001", start: START, end: END, reason: "tyres" },
      ours: "Conflicts with 7K2MQ9XA on わ1001",
      rounds: (id) => [
        { body: { processed: 3, remaining: 0, errors: [others[0], { name: id, message: "Conflicts with 7K2MQ9XA on わ1001" }, others[1]], cursor: null } },
      ],
    },
    {
      label: "another block on the plate",
      input: { modelId: "forza-250", plate: "わ2002", start: START, end: END, reason: "chain" },
      ours: "Conflicts with KLOOK-1234 on わ2002",
      rounds: (id) => [{ body: { processed: 1, remaining: 0, errors: [{ name: id, message: "Conflicts with KLOOK-1234 on わ2002" }], cursor: null } }],
    },
    {
      label: "no bike of the model free",
      input: { modelId: "jimny", plate: "", start: START, end: END, reason: "recall" },
      ours: "No vehicle of jimny is free",
      rounds: (id) => [{ body: { processed: 1, remaining: 0, errors: [others[1], { name: id, message: "No vehicle of jimny is free" }], cursor: null } }],
    },
    {
      label: "the error in a later round of a cursor pass",
      input: { modelId: "pcx-125", plate: "わ1002", start: START, end: END, reason: "brakes" },
      ours: "Conflicts with MNT-20261001-0900-dead on わ1002",
      rounds: (id) => [
        { body: { processed: 200, remaining: 4, errors: [others[0]], cursor: "c1" } },
        { body: { processed: 4, remaining: 0, errors: [{ name: id, message: "Conflicts with MNT-20261001-0900-dead on わ1002" }], cursor: null } },
      ],
    },
    {
      label: "errors that name only other blocks",
      input: { modelId: "pcx-125", plate: "わ1001", start: START, end: END, reason: "tyres" },
      ours: null,
      rounds: () => [{ body: { processed: 2, remaining: 0, errors: others, cursor: null } }],
    },
  ];
  for (const { label, input, ours, rounds } of cases) {
    const holder: { script?: AppsScriptWorld } = {};
    const script = world({
      blocks: [SHUFFLED, ...SHUFFLED_ROWS],
      routes: {
        [BLOCKS]: (round) => {
          const replies = rounds(lastBlockId(holder.script as AppsScriptWorld));
          return replies[Math.min(round, replies.length - 1)];
        },
      },
    });
    holder.script = script;
    const answer = save(script, input);
    const message = String(answer.message);

    assert.equal(answer.blockId, lastBlockId(script), `${label}: the id of the row it wrote`);
    assert.equal(answer.row, SHUFFLED_ROWS.length + 2, label);
    assert.equal(blocksGrid(script).length, SHUFFLED_ROWS.length + 2, `${label}: the row stays`);
    assert.notEqual(answer.synced, false, `${label}: the sync ran`);
    if (ours === null) {
      assert.equal(answer.level, "ok", `${label}: another block's error is not this row's: ${message}`);
    } else {
      assert.equal(answer.level, "error", `${label}: ${message}`);
      assert.ok(message.includes(ours), `${label}: the message tells what is in the way: ${message}`);
    }
    assert.ok(!message.includes("B3TZ8VWN"), `${label}: no other block's error: ${message}`);
  }
});

test("the block_id is new and never repeats one on the tab", () => {
  // The id: MNT-, the time in Japan to the minute, and the first 4 characters of a uuid.
  for (const [now, stamp] of [
    [NOW, NOW_STAMP],
    [LATER, LATER_STAMP],
    [Date.UTC(2027, 11, 31, 14, 59), "20271231-2359"],
    [Date.UTC(2027, 11, 31, 15, 0), "20280101-0000"],
  ] as [number, string][]) {
    for (const uuid of [UUID_A, UUID_D]) {
      const script = world({ now, uuids: [uuid] });
      const answer = save(script, { modelId: "pcx-125", plate: "わ1001", start: START, end: END, reason: "check" });
      const expected = `MNT-${stamp}-${uuid.slice(0, 4)}`;
      assert.equal(answer.blockId, expected);
      assert.equal(lastBlockId(script), expected);
    }
  }

  // The tab already holds the ids the first uuids give, under a header in another case and column: the next one is new.
  const taken = [`MNT-${NOW_STAMP}-a1b2`, `MNT-${NOW_STAMP}-9f3c`];
  const blocks = [
    SHUFFLED,
    ...SHUFFLED_ROWS,
    ["", "2027-01-02 10:00", "わ1001", "ok", "", "maintenance", taken[0], "2027-01-01 10:00", "", "pcx-125"],
    ["", "2027-02-02 10:00", "わ2002", "ok", "", "maintenance", taken[1], "2027-02-01 10:00", "", "forza-250"],
  ];
  const script = world({ blocks, uuids: [UUID_A, UUID_B, UUID_C, UUID_D] });
  const answer = save(script, { modelId: "jimny", plate: "わ3003", start: START, end: END, reason: "check" });
  const fresh = String(answer.blockId);
  assert.match(fresh, new RegExp(`^MNT-${NOW_STAMP}-[0-9a-f]{4}$`));
  assert.ok(!taken.includes(fresh), `${fresh} is not on the tab already`);
  assert.ok([UUID_C, UUID_D].some((uuid) => fresh.endsWith(`-${uuid.slice(0, 4)}`)), `${fresh} takes a later uuid`);
  assert.equal(lastBlockId(script), fresh);
  assert.deepEqual(blocksGrid(script).slice(0, blocks.length), blocks, "the rows holding those ids are untouched");

  // Two saves in the same minute whose uuids start alike: the second sees the first's row and takes another id.
  const twice = world({ uuids: [UUID_A, "a1b2ffff-0000-4000-8000-000000000009", UUID_B] });
  const first = save(twice, { modelId: "pcx-125", plate: "わ1001", start: START, end: END, reason: "one" });
  const second = save(twice, { modelId: "pcx-125", plate: "わ1002", start: START, end: END, reason: "two" });
  assert.equal(first.blockId, `MNT-${NOW_STAMP}-a1b2`);
  assert.equal(second.blockId, `MNT-${NOW_STAMP}-9f3c`);
  const ids = blocksGrid(twice).slice(1).map((row) => cellsOf(STANDARD, row).block_id);
  assert.equal(new Set(ids).size, ids.length, `every id on the tab is unique: ${JSON.stringify(ids)}`);
  assert.equal(second.row, 4);
});

test("a plate decides the model and a plate of another model is refused", () => {
  const accepted: { label: string; input: Input; model: string; plate: string }[] = [
    { label: "a plate alone", input: { plate: "わ2002" }, model: "forza-250", plate: "わ2002" },
    { label: "a retired plate alone", input: { plate: "沖縄 あ 35-80" }, model: "forza-250", plate: "沖縄 あ 35-80" },
    { label: "a plate in maintenance, a blank model", input: { modelId: "", plate: "わ1002" }, model: "pcx-125", plate: "わ1002" },
    { label: "a plate of a car", input: { plate: "わ3003" }, model: "jimny", plate: "わ3003" },
    { label: "a model and its own plate", input: { modelId: "pcx-125", plate: "わ1001" }, model: "pcx-125", plate: "わ1001" },
    { label: "an inactive model alone", input: { modelId: "old-50", plate: "" }, model: "old-50", plate: "" },
    { label: "a model alone", input: { modelId: "jimny" }, model: "jimny", plate: "" },
  ];
  for (const { label, input, model, plate } of accepted) {
    const script = world({ blocks: [SHUFFLED, ...SHUFFLED_ROWS] });
    const answer = save(script, { ...input, start: START, end: END, reason: "check" });
    const written = cellsOf(SHUFFLED, blocksGrid(script)[SHUFFLED_ROWS.length + 1]);
    assert.equal(written.model_id, model, `${label}: model_id`);
    assert.equal(written.plate, plate, `${label}: plate`);
    assert.equal(answer.row, SHUFFLED_ROWS.length + 2, label);
  }

  const refused: { label: string; input: Input; names?: string }[] = [
    { label: "a plate of another model", input: { modelId: "pcx-125", plate: "わ2002" }, names: "わ2002" },
    { label: "a car's plate on a scooter", input: { modelId: "pcx-125", plate: "わ3003" }, names: "わ3003" },
    { label: "a scooter's plate on a car", input: { modelId: "jimny", plate: "わ1001" }, names: "わ1001" },
    { label: "an unknown plate of a model", input: { modelId: "pcx-125", plate: "わ9999" }, names: "わ9999" },
    { label: "an unknown plate alone", input: { plate: "わ9999" } },
    { label: "no model and no plate", input: {} },
    { label: "a blank model and plate", input: { modelId: "", plate: "" } },
    { label: "a model not in the catalog", input: { modelId: "nope-999" } },
  ];
  for (const { label, input, names } of refused) {
    const blocks = [SHUFFLED, ...SHUFFLED_ROWS];
    const script = world({ blocks });
    const message = refusal(script, { ...input, start: START, end: END, reason: "check" });
    if (names !== undefined) assert.ok(message.includes(names), `${label}: names ${names}: ${message}`);
    assertNothingDone(script, blocks, label);
  }
});

test("an end not after the start or a bad date is refused without writing", () => {
  const accepted: [string, string][] = [
    ["2027-07-15 23:59", "2027-07-16 00:00"],
    ["2027-07-15 09:00", "2027-07-15 09:01"],
    ["2028-02-29 10:00", "2028-03-01 10:00"],
    ["2027-12-31 18:00", "2028-01-01 09:00"],
  ];
  for (const [start, end] of accepted) {
    const script = world();
    const answer = save(script, { modelId: "pcx-125", plate: "わ1001", start, end, reason: "check" });
    const written = cellsOf(STANDARD, blocksGrid(script)[2]);
    assert.deepEqual(written.start, jst(start));
    assert.deepEqual(written.end, jst(end));
    assert.equal(answer.row, 3);
  }

  const refused: { label: string; start: unknown; end: unknown }[] = [
    { label: "an end equal to the start", start: START, end: START },
    { label: "an end a minute before the start", start: "2027-07-15 09:00", end: "2027-07-15 08:59" },
    { label: "an end a day before the start", start: "2027-07-16 09:00", end: "2027-07-15 09:00" },
    { label: "an end a year before the start", start: "2028-01-01 00:00", end: "2027-12-31 23:59" },
    { label: "month 13", start: "2027-13-01 09:00", end: END },
    { label: "30 February", start: START, end: "2027-02-30 10:00" },
    { label: "29 February in a common year", start: "2027-02-29 09:00", end: END },
    { label: "hour 25", start: "2027-07-15 25:00", end: END },
    { label: "minute 60", start: START, end: "2027-07-16 18:60" },
    { label: "a date with no time", start: "2027-07-15", end: END },
    { label: "a month without its zero", start: "2027-7-15 09:00", end: END },
    { label: "words", start: "tomorrow morning", end: END },
    { label: "a blank start", start: "", end: END },
    { label: "no end", start: START, end: undefined },
    { label: "a number", start: Date.UTC(2027, 6, 15), end: END },
  ];
  for (const { label, start, end } of refused) {
    const blocks = [STANDARD, STANDARD_ROW];
    const script = world({ blocks });
    refusal(script, { modelId: "pcx-125", plate: "わ1001", start, end, reason: "check" });
    assertNothingDone(script, blocks, label);
  }
});

test("save writes nothing while another Publish holds the lock", () => {
  for (const blocks of [
    [STANDARD, STANDARD_ROW],
    [SHUFFLED, ...SHUFFLED_ROWS],
  ]) {
    const script = world({ blocks, lockHeldElsewhere: true });
    const message = refusal(script, { modelId: "pcx-125", plate: "わ1001", start: START, end: END, reason: "check" });
    assert.match(message, /publish/i, `the answer says a Publish is running: ${message}`);
    assertNothingDone(script, blocks, "a held lock");
    assert.ok(script.lock.timeouts.includes(10_000), `it waits 10 s for the lock: ${JSON.stringify(script.lock.timeouts)}`);
    assert.equal(script.lock.held(), true, "the other run keeps its lock");
  }

  // The other way round: a Publish pressed while a save is syncing is refused, and the next one runs.
  const holder: { script?: AppsScriptWorld; during?: string[] } = {};
  const script = world({
    routes: {
      "/api/publish": { body: { ok: true, version: 413, counts: { ok: 1, warning: 0, error: 0 }, fatal: [], affectedBookings: [] } },
      "/api/publish/photos": { body: { copied: 0, skipped: [], errors: [], remaining: 0 } },
      "/api/publish/assignments": { body: { applied: 0, errors: [] } },
      [BLOCKS]: () => {
        if (holder.during === undefined) {
          const inner = holder.script as AppsScriptWorld;
          inner.call("publish");
          holder.during = [...inner.alerts];
          assert.deepEqual(publishPaths(inner), [BLOCKS], "the Publish pressed during the save sent nothing");
        }
        return SYNCED;
      },
    },
  });
  holder.script = script;
  save(script, { modelId: "pcx-125", plate: "わ1001", start: START, end: END, reason: "check" });
  assert.equal(holder.during?.length, 1, "the Publish pressed during the save was answered");
  assert.match(String(holder.during?.[0]), /Publish already running/);
  assert.equal(script.lock.held(), false, "the save released the lock");
  script.call("publish");
  assert.ok(publishPaths(script).includes("/api/publish"), "the next Publish runs");
});

test("the sync follows the cursor and is logged in PublishLog", async () => {
  const earlier = ["2026-10-01 09:00", "someone@example.jp", 411, "1 ok, 0 warning, 0 error", "3 processed, 0 errors", "", "", "kept"];
  const passes: { label: string; now: number; answered: { processed: number; remaining: number; cursor: unknown }[] }[] = [
    {
      label: "three rounds",
      now: NOW,
      answered: [
        { processed: 7, remaining: 9, cursor: "c1" },
        { processed: 5, remaining: 2, cursor: '"沖縄"/=+' },
        { processed: 2, remaining: 0, cursor: null },
      ],
    },
    {
      label: "two rounds",
      now: LATER,
      answered: [
        { processed: 200, remaining: 31, cursor: "Q1VSU09S" },
        { processed: 31, remaining: 0, cursor: null },
      ],
    },
  ];
  for (const { label, now, answered } of passes) {
    const replies = answered.map((round): Reply => ({ body: { ...round, errors: [] } }));
    const script = world({ now, publishLog: [[...SHEET_TABS.PublishLog], earlier], routes: { [BLOCKS]: replies } });
    const answer = save(script, { modelId: "forza-250", plate: "わ2002", start: START, end: END, reason: "check" });

    const sent = [null, ...answered.slice(0, -1).map(({ cursor }) => cursor)];
    const expected = sent.map((cursor) => (cursor === null ? { requestedBy: USER } : { requestedBy: USER, cursor }));
    assert.deepEqual(await signedPayloads(script, BLOCKS, now), expected, `${label}: each round sends the cursor before`);
    assert.deepEqual(publishPaths(script), expected.map(() => BLOCKS), label);

    const rows = logRows(script);
    assert.equal(rows.length, 2, `${label}: one row after the one already there`);
    assert.deepEqual(rows[0], earlier, `${label}: the earlier row is kept`);
    const row = rows[1];
    assert.equal(row.length, SHEET_TABS.PublishLog.length, `${label}: the row fills every column`);
    assert.equal(new Date(row[0] as string).getTime(), now, `${label}: the time cell is now`);
    assert.equal(logCell(row, "user"), USER);
    const total = answered.reduce((sum, { processed }) => sum + processed, 0);
    assert.ok(hasNumber(logCell(row, "blocks"), total), `${label}: the blocks cell totals ${total}: ${logCell(row, "blocks")}`);
    assert.ok(logCell(row, "message").includes(String(answer.blockId)), `${label}: the message names the block`);
  }

  // A pass that never ends stops at the round cap, and the row stays for the next Publish.
  const endless = world({
    routes: { [BLOCKS]: (round) => ({ body: { processed: 1, remaining: 50, errors: [], cursor: `r${round}` } }) },
  });
  const answer = save(endless, { modelId: "pcx-125", plate: "わ1001", start: START, end: END, reason: "check" });
  const sent = await signedPayloads(endless, BLOCKS, NOW);
  assert.equal(sent.length, ROUND_CAP, "ten rounds at most");
  assert.deepEqual(sent.slice(1), Array.from({ length: ROUND_CAP - 1 }, (_, i) => ({ requestedBy: USER, cursor: `r${i}` })));
  assert.equal(lastBlockId(endless), answer.blockId);
  assert.equal(logRows(endless).length, 1);
  assert.equal(endless.lock.held(), false);
});

test("a failed sync keeps the row and says the next Publish syncs it", () => {
  const failures: { label: string; route: Route; requests: number }[] = [
    { label: "a thrown fetch", route: { throws: "Address unavailable: reservation-one.example.dev" }, requests: 1 },
    { label: "a 500", route: { status: 500, body: "Internal error" }, requests: 1 },
    { label: "a 401", route: { status: 401, body: { error: "unauthorized" } }, requests: 1 },
    { label: "a 200 that is not JSON", route: { body: "<html>Error 1101</html>" }, requests: 1 },
    {
      label: "a 502 after a cursor round",
      route: [{ body: { processed: 200, remaining: 3, errors: [], cursor: "c1" } }, { status: 502, body: "Bad gateway" }],
      requests: 2,
    },
  ];
  for (const { label, route, requests } of failures) {
    for (const blocks of [
      [STANDARD, STANDARD_ROW],
      [SHUFFLED, ...SHUFFLED_ROWS],
    ]) {
      const script = world({ blocks, uuids: [UUID_B], routes: { [BLOCKS]: route } });
      const answer = save(script, { modelId: "pcx-125", plate: "わ1002", start: START, end: END, reason: "check" });
      const message = String(answer.message);

      assert.equal(answer.synced, false, `${label}: ${JSON.stringify(answer)}`);
      assert.equal(answer.blockId, `MNT-${NOW_STAMP}-9f3c`, label);
      assert.equal(answer.row, blocks.length + 1, label);
      assert.match(message, /publish/i, `${label}: the next Publish syncs it: ${message}`);
      assert.ok(!message.includes(SECRET), `${label}: the secret stays out`);

      const grid = blocksGrid(script);
      assert.equal(grid.length, blocks.length + 1, `${label}: the row stays`);
      assert.deepEqual(grid.slice(0, blocks.length), blocks, `${label}: the other rows are as they were`);
      assert.equal(lastBlockId(script), answer.blockId, label);
      assert.equal(publishPaths(script).length, requests, `${label}: no retry past the failure`);
      const rows = logRows(script);
      assert.equal(rows.length, 1, `${label}: the failed sync is logged`);
      assert.ok(logCell(rows[0], "message").includes(String(answer.blockId)), `${label}: the log names the block`);
      assert.equal(script.lock.held(), false, `${label}: the lock is released`);
    }
  }
});

test("a digit-only plate and a reason that looks like a number, date or boolean are kept as typed and read back", () => {
  // Plates of digits only, which Sheets would read as numbers, one of them with a leading zero.
  const models: Model[] = [
    { ...MODELS[0], plates: [{ plate: "0123", status: "active" }, { plate: "わ1001", status: "active" }] },
    { ...MODELS[1], plates: [{ plate: "2002", status: "active" }, { plate: "007", status: "maintenance" }] },
    MODELS[2],
  ];
  const catalogForBlocks = {
    models: models.map(({ id }) => ({ id })),
    vehicles: models.flatMap(({ id, plates }) => plates.map(({ plate }) => ({ plate, modelId: id }))),
  };
  const cases: { input: Input; model: string; blocks: unknown[][] }[] = [
    { input: { modelId: "pcx-125", plate: "0123", start: START, end: END, reason: "2027-07-15" }, model: "pcx-125", blocks: [STANDARD, STANDARD_ROW] },
    { input: { plate: "2002", start: "2027-03-01 10:30", end: "2027-03-03 17:00", reason: "TRUE" }, model: "forza-250", blocks: [SHUFFLED, ...SHUFFLED_ROWS] },
    { input: { modelId: "forza-250", plate: "007", start: START, end: END, reason: "09:30" }, model: "forza-250", blocks: [STANDARD] },
    { input: { modelId: "jimny", plate: "", start: "2028-02-28 23:30", end: "2028-02-29 00:30", reason: "0123" }, model: "jimny", blocks: [SHUFFLED] },
    { input: { modelId: "pcx-125", plate: "わ1001", start: START, end: END, reason: "1,500" }, model: "pcx-125", blocks: [STANDARD, STANDARD_ROW] },
    { input: { modelId: "pcx-125", plate: "0123", start: START, end: END, reason: "false" }, model: "pcx-125", blocks: [STANDARD] },
  ];
  for (const { input, model, blocks } of cases) {
    const label = `plate ${JSON.stringify(input.plate)}, reason ${JSON.stringify(input.reason)}`;
    const holder: { script?: AppsScriptWorld; read?: ReturnType<typeof validateBlocks> } = {};
    const script = world({
      blocks,
      routes: {
        [CATALOG_PATH]: { body: catalog(models) },
        // What the blocks step reads: the tab through the Sheets API, checked by the Worker's own validateBlocks.
        [BLOCKS]: () => {
          holder.read ??= validateBlocks({ Blocks: sheetsApiValues(holder.script as AppsScriptWorld, "Blocks") }, catalogForBlocks, NOW);
          return SYNCED;
        },
      },
    });
    holder.script = script;
    const answer = save(script, input);

    // The row as the sheet holds it: the typed text stays text, and the start and end stay date-times.
    const grid = blocksGrid(script);
    assert.equal(grid.length, blocks.length + 1, `${label}: one row added`);
    const written = cellsOf(blocks[0], grid[blocks.length]);
    assert.strictEqual(written.plate, input.plate, `${label}: the plate as typed`);
    assert.strictEqual(written.note, input.reason, `${label}: the reason as typed`);
    assert.strictEqual(written.block_id, answer.blockId, `${label}: the block id`);
    assert.strictEqual(written.model_id, model, label);
    assert.strictEqual(written.channel, "maintenance", label);
    assert.deepEqual(written.start, jst(input.start), `${label}: the start is a date-time in Japan`);
    assert.deepEqual(written.end, jst(input.end), `${label}: the end is a date-time in Japan`);

    // The blocks step reads back what staff typed, and the times they meant.
    const read = holder.read;
    assert.ok(read !== undefined, `${label}: the blocks step ran`);
    const row = blocks.length + 1;
    const errors = read.statuses.filter((status) => status.row === row && status.level === "error");
    assert.deepEqual(errors, [], `${label}: the Worker takes the row`);
    const block = read.blocks.find((each) => each.blockId === answer.blockId);
    assert.ok(block !== undefined, `${label}: the block is read: ${JSON.stringify(read.blocks)}`);
    assert.strictEqual(block.plate, input.plate === "" ? null : input.plate, `${label}: the plate read back`);
    assert.strictEqual(block.note, input.reason, `${label}: the reason read back`);
    assert.strictEqual(block.modelId, model, label);
    assert.strictEqual(block.startAt, jst(input.start).getTime(), `${label}: the start read back`);
    assert.strictEqual(block.endAt, jst(input.end).getTime(), `${label}: the end read back`);
  }
});
