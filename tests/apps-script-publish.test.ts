// The sheet-bound Apps Script run in node:vm against fake Google services. Signatures go through the Worker's real
// verifyEnvelope, digests come from the RFC or from node:crypto, and headers from SHEET_TABS, never from the script.
// Alert and log text is free: tests look for the facts in it (numbers, fatal messages, a status), not for sentences.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SHEET_TABS } from "../src/lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../src/lib/crypto.ts";
import type { AffectedBooking } from "../src/lib/db/catalog-store.ts";
import {
  type AppsScriptWorld,
  hmacSignature,
  loadAppsScript,
  MENU_SEPARATOR,
  type MenuEntry,
  type Options,
  type Reply,
  type Route,
  signedBytes,
} from "./helpers/apps-script.ts";

const BASE_URL = "https://reservation-one.example.dev";
const SECRET = "publish-secret-one";
const USER = "staff@okinawa-dream.example";

const PUBLISH = "/api/publish";
const BLOCKS = "/api/publish/blocks";
const PHOTOS = "/api/publish/photos";
const ASSIGNMENTS = "/api/publish/assignments";

const ROUND_CAP = 10;

const DASHBOARD = "Dashboard";

const REPORT = {
  ok: true,
  version: 412,
  counts: { ok: 120, warning: 3, error: 2 },
  fatal: [],
  affectedBookings: [],
};

const HAPPY_ROUTES: Record<string, Route> = {
  [PUBLISH]: { body: REPORT },
  [BLOCKS]: { body: { processed: 15, remaining: 0, errors: [] } },
  [PHOTOS]: { body: { copied: ["a.jpg", "b.jpg"], skipped: [], errors: [], remaining: 0 } },
  [ASSIGNMENTS]: { body: { applied: 17, errors: [] } },
};

/** Bookings with the calendar date each starts on in Japan, worked out by hand. No date here is another's UTC date. */
const AFFECTED: { jst: [number, number, number]; booking: AffectedBooking }[] = [
  // 01:00 JST on the 2nd is still the 1st in UTC.
  {
    jst: [2026, 12, 2],
    booking: { bookingId: "bkg-a", ref: "7K2MQ9XA", plate: "わ1001", startAt: Date.UTC(2026, 11, 1, 16) },
  },
  // Midnight in Japan opens 2027 while UTC is still in 2026.
  {
    jst: [2027, 1, 1],
    booking: { bookingId: "bkg-b", ref: "B3TZ8VWN", plate: "沖縄 あ 35-80", startAt: Date.UTC(2026, 11, 31, 15) },
  },
  // 23:59 JST, the last minute of a day that UTC shares.
  {
    jst: [2026, 11, 20],
    booking: { bookingId: "bkg-c", ref: "2HRP5GDY", plate: "わ2002", startAt: Date.UTC(2026, 10, 20, 14, 59) },
  },
  // A morning pickup, the same date in both zones.
  {
    jst: [2026, 11, 30],
    booking: { bookingId: "bkg-d", ref: "X9C7JT3E", plate: "わ3003", startAt: Date.UTC(2026, 10, 30, 1) },
  },
  // February 2027 has 28 days, so 05:00 JST falls in March.
  {
    jst: [2027, 3, 1],
    booking: { bookingId: "bkg-e", ref: "MZ80SQ5K", plate: "わ5005", startAt: Date.UTC(2027, 1, 28, 20) },
  },
  // February 2028 has a 29th.
  {
    jst: [2028, 2, 29],
    booking: { bookingId: "bkg-f", ref: "P3Y2F7BV", plate: "わ8008", startAt: Date.UTC(2028, 1, 28, 16) },
  },
];

const STACK_TRACE = /\n\s+at\s|\.js:\d+|(Type|Reference|Syntax|Range)Error|Cannot read|\bundefined\b|\[object Object\]/;
const FAILED =
  /fail|could not|couldn't|unable|invalid|unexpected|unreadable|incomplete|not (finish|complet)|失敗|エラー/i;
const WORK_REMAINS = /remain|unfinished|incomplete|not (finish|complet)|残/i;

function world(overrides: Options = {}): AppsScriptWorld {
  return loadAppsScript({
    properties: { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: SECRET },
    user: USER,
    tabs: { PublishLog: [[...SHEET_TABS.PublishLog]] },
    ...overrides,
    routes: { ...HAPPY_ROUTES, ...overrides.routes },
  });
}

function paths(script: AppsScriptWorld): string[] {
  return script.fetches.map((call) => call.path);
}

function repeat(path: string, times: number): string[] {
  return Array.from({ length: times }, () => path);
}

function logRows(script: AppsScriptWorld): unknown[][] {
  const tab = script.tabs.get("PublishLog");
  assert.ok(tab !== undefined, "the PublishLog tab exists");
  return tab.rows.slice(1);
}

function cell(row: unknown[], column: (typeof SHEET_TABS.PublishLog)[number]): string {
  return String(row[SHEET_TABS.PublishLog.indexOf(column)] ?? "");
}

function hasNumber(text: string, value: number): boolean {
  return new RegExp(`(?<!\\d)${value}(?!\\d)`).test(text);
}

function assertHasNumbers(text: string, values: number[], what: string): void {
  for (const value of values) assert.ok(hasNumber(text, value), `${what} shows ${value}: ${text}`);
}

/** A report that replaced the catalog and left these bookings on vehicles leaving service. */
function reportWith(listed: typeof AFFECTED): Route {
  return { body: { ...REPORT, affectedBookings: listed.map(({ booking }) => booking) } };
}

/** The year, month and day in that order, in any of the common forms: 2026-12-02, 2026/12/2, 2026年12月2日. */
function dateMatcher([year, month, day]: [number, number, number]): RegExp {
  return new RegExp(`(?<!\\d)${year}\\D{1,3}0?${month}\\D{1,3}0?${day}(?!\\d)`);
}

function assertListsBookings(alert: string, listed: typeof AFFECTED): void {
  for (const { jst, booking } of listed) {
    assert.ok(alert.includes(booking.ref), `the alert shows ref ${booking.ref}: ${alert}`);
    assert.ok(alert.includes(booking.plate), `the alert shows plate ${booking.plate}: ${alert}`);
    assert.match(alert, dateMatcher(jst), `the alert shows ${booking.ref}'s start date in Japan`);
  }
}

/** Every path through publish() ends here: lock free, one clean alert for staff, one full log row. */
function settled(script: AppsScriptWorld, user = USER): { alert: string; row: unknown[] } {
  assert.equal(script.lock.held(), false, "the lock is released");
  assert.equal(script.alerts.length, 1, `one alert: ${JSON.stringify(script.alerts)}`);
  const rows = logRows(script);
  assert.equal(rows.length, 1, "one PublishLog row");
  const [alert] = script.alerts;
  const [row] = rows;
  assert.equal(row.length, SHEET_TABS.PublishLog.length, "the row fills every PublishLog column");
  assert.equal(cell(row, "user"), user);
  for (const text of [alert, ...row.map(String)]) {
    assert.doesNotMatch(text, STACK_TRACE);
    assert.ok(!text.includes(SECRET), "the secret stays out of what staff see");
  }
  return { alert, row };
}

/** A count in the shape the ticket states, or as the list task #17 actually returns for photos. */
const SHAPES: { name: string; many(count: number, item: unknown): unknown }[] = [
  { name: "numbers", many: (count) => count },
  { name: "lists", many: (count, item) => Array.from({ length: count }, () => item) },
];

/** Numbers the tests below never look for, so a count found in the alert can only be the step's under test. */
const QUIET_ROUTES: Record<string, Route> = {
  [PUBLISH]: { body: { ...REPORT, version: 9412, counts: { ok: 900, warning: 800, error: 700 } } },
  [BLOCKS]: { body: { processed: 901, remaining: 0, errors: [] } },
  [PHOTOS]: { body: { copied: 902, skipped: [], errors: [], remaining: 0 } },
  [ASSIGNMENTS]: { body: { applied: 903, errors: [] } },
};

/** Work left after a round that is not the last, and no count these tests look for. */
const LEFT_OVER = 500;

// A few photo errors all reach staff. The cap is free up to MOST_PHOTO_ERRORS, and these tests do not pin it.
const FEW_PHOTO_ERRORS = 3;
const MOST_PHOTO_ERRORS = 10;

type PhotoError = { name: string; message: string };

/** Distinct entries with no digits, so a number in the alert can only be a count. Fewer is a prefix of more. */
function photoErrors(count: number): PhotoError[] {
  return Array.from({ length: count }, (_, i) => {
    const code = String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26));
    return { name: `photo-${code}.jpg`, message: `Reason ${code} from Drive` };
  });
}

type LoopedStep = {
  label: string;
  path: string;
  column: "blocks" | "photos";
  round(errors: number, remaining: number): Reply;
  /** The entries a round with this many errors names. */
  named(errors: number): PhotoError[];
};

const noNames = (): PhotoError[] => [];

const PHOTO_LIST: LoopedStep = {
  label: "photos with an error list",
  path: PHOTOS,
  column: "photos",
  round: (errors, remaining) => ({ body: { copied: 300, skipped: [], errors: photoErrors(errors), remaining } }),
  named: photoErrors,
};

/** Both steps report every problem on every call, so a problem nobody fixed comes back each round. */
const LOOPED_STEPS: LoopedStep[] = [
  {
    label: "blocks with an error count",
    path: BLOCKS,
    column: "blocks",
    round: (errors, remaining) => ({ body: { processed: 200, remaining, errors } }),
    named: noNames,
  },
  {
    label: "blocks with an error list",
    path: BLOCKS,
    column: "blocks",
    round: (errors, remaining) => ({
      body: { processed: 200, remaining, errors: Array.from({ length: errors }, () => ({ message: "overlaps" })) },
    }),
    named: noNames,
  },
  {
    label: "photos with an error count",
    path: PHOTOS,
    column: "photos",
    round: (errors, remaining) => ({ body: { copied: 300, skipped: 0, errors, remaining } }),
    named: noNames,
  },
  PHOTO_LIST,
];

/** One step's replies, a reply per entry in `errors`, ending in `failure` when there is one. */
function publishRounds(step: LoopedStep, errors: number[], failure?: Reply): { alert: string; row: unknown[] } {
  const finished = errors.length - 1;
  const answers = errors.map((count, i) => step.round(count, failure === undefined && i === finished ? 0 : LEFT_OVER));
  const replies = failure === undefined ? answers : [...answers, failure];
  const script = world({ routes: { ...QUIET_ROUTES, [step.path]: replies } });
  script.call("publish");

  const rounds = paths(script).filter((path) => path === step.path).length;
  assert.equal(rounds, replies.length, `${step.label}: every round ran`);
  assert.ok(paths(script).includes(ASSIGNMENTS), `${step.label}: the steps after it still ran`);
  return settled(script);
}

/** All of a few, some of many, each once with its reason, and nothing only an earlier round reported. */
function assertPhotoList(text: string, current: PhotoError[], stale: PhotoError[], what: string): void {
  const shown = current.filter(({ name }) => text.includes(name));
  const least = Math.min(current.length, FEW_PHOTO_ERRORS);
  assert.ok(
    shown.length >= least && shown.length <= MOST_PHOTO_ERRORS,
    `${what} shows ${shown.length} of ${current.length} names: ${text}`,
  );
  for (const { name, message } of shown) {
    assert.equal(text.split(name).length - 1, 1, `${what} shows ${name} once: ${text}`);
    assert.ok(text.includes(message), `${what} shows why ${name} failed: ${text}`);
  }
  for (const { name } of stale) assert.ok(!text.includes(name), `${what} no longer lists ${name}: ${text}`);
}

type RoundsCase = { errors: number[]; shows: number; not: number[] };

/** The alert and the log tell staff the last answered round's errors, whatever came before it. */
function assertLastRoundReported(step: LoopedStep, rounds: RoundsCase, alert: string, row: unknown[]): void {
  const { errors, shows, not } = rounds;
  const what = `${step.label} over ${errors.join(", ")}`;
  for (const [where, text] of [
    ["alert", alert],
    [`${step.column} cell`, cell(row, step.column)],
  ]) {
    assertHasNumbers(text, [shows], `the ${where} for ${what}`);
    for (const value of not) assert.ok(!hasNumber(text, value), `the ${where} for ${what} omits ${value}: ${text}`);
  }

  const current = step.named(shows);
  const stale = step.named(Math.max(...errors)).slice(shows);
  assertPhotoList(alert, current, stale, `the alert for ${what}`);
  assertPhotoList(cell(row, "message"), current, stale, `the message cell for ${what}`);
}

/** What each round of `path` signed, read back through the Worker's own check. */
async function signedPayloads(script: AppsScriptWorld, path: string): Promise<unknown[]> {
  const payloads: unknown[] = [];
  for (const call of script.fetches.filter((fetched) => fetched.path === path)) {
    const verified = await verifyEnvelope(SECRET, String(call.payload), Date.now());
    assert.ok(verified.ok, `${path}: ${JSON.stringify(verified)}`);
    payloads.push(verified.payload);
  }
  return payloads;
}

type CursorPass = {
  label: string;
  /** The errors each round answers. No two rounds share an entry. */
  errors: number[];
  /** The cursor each round answers. */
  cursors: (string | null)[];
  /** The first round whose errors still count at the end. */
  countsFrom: number;
  not: number[];
};

const ROUND_PROCESSED = 110;

/** One list cut into the rounds of `errors`, in order. */
function roundLists(errors: number[]): PhotoError[][] {
  const all = photoErrors(errors.reduce((sum, count) => sum + count, 0));
  return errors.map((count, i) => {
    const from = errors.slice(0, i).reduce((sum, earlier) => sum + earlier, 0);
    return all.slice(from, from + count);
  });
}

/** Publish over these rounds of blocks. The last leaves `left` remaining, and `then` is the reply after it, if any. */
function publishCursorPass({ errors, cursors }: CursorPass, left = 0, then?: Reply): { alert: string; row: unknown[] } {
  const lists = roundLists(errors);
  const answers = lists.map((list, i): Reply => {
    const remaining = i === lists.length - 1 ? left : LEFT_OVER;
    return { body: { processed: ROUND_PROCESSED, remaining, errors: list, cursor: cursors[i] } };
  });
  const replies = then === undefined ? answers : [...answers, then];
  const script = world({ routes: { ...QUIET_ROUTES, [BLOCKS]: replies } });
  script.call("publish");

  assert.equal(paths(script).filter((path) => path === BLOCKS).length, replies.length, "every round ran");
  return settled(script);
}

/** The alert and the log tell staff the running list, which is every round from `countsFrom` on. */
function assertPassReported(pass: CursorPass, alert: string, row: unknown[]): void {
  const lists = roundLists(pass.errors);
  const current = lists.slice(pass.countsFrom).flat();
  const stale = lists.slice(0, pass.countsFrom).flat();
  const done = ROUND_PROCESSED * pass.errors.length;

  for (const [where, text] of [
    ["alert", alert],
    ["blocks cell", cell(row, "blocks")],
  ]) {
    assertHasNumbers(text, [current.length, done], `the ${where} for ${pass.label}`);
    for (const value of pass.not) {
      assert.ok(!hasNumber(text, value), `the ${where} for ${pass.label} omits ${value}: ${text}`);
    }
  }
  assertPhotoList(alert, current, stale, `the alert for ${pass.label}`);
  assertPhotoList(cell(row, "message"), current, stale, `the message cell for ${pass.label}`);
}

test("publish signs requests the Worker accepts", async () => {
  const cases = [
    { secret: SECRET, baseUrl: BASE_URL, user: USER },
    { secret: "another-secret-2", baseUrl: "https://worker-two.example.workers.dev", user: "manager@example.jp" },
    { secret: "s3cret with spaces & symbols", baseUrl: BASE_URL, user: "比嘉太郎@例え.jp" },
    { secret: SECRET, baseUrl: BASE_URL, user: "Ünï-🛵@example.com" },
    // getEmail answers blank when security policies hide the address, and the Worker takes any string.
    { secret: SECRET, baseUrl: BASE_URL, user: "" },
  ];
  for (const { secret, baseUrl, user } of cases) {
    const script = world({ properties: { WORKER_BASE_URL: baseUrl, PUBLISH_SECRET: secret }, user });
    const before = Date.now();
    script.call("publish");
    const after = Date.now();

    assert.deepEqual(paths(script), [PUBLISH, BLOCKS, PHOTOS, ASSIGNMENTS]);
    for (const call of script.fetches) {
      assert.equal(call.url, `${baseUrl}${call.path}`);
      assert.equal(String(call.method).toLowerCase(), "post");
      assert.match(String(call.contentType), /^application\/json/);
      assert.equal(call.muteHttpExceptions, true, "a 4xx or 5xx comes back as a response");
      assert.equal(typeof call.payload, "string");
      const body = String(call.payload);

      const verified = await verifyEnvelope(secret, body, Date.now());
      assert.equal(verified.ok, true, `${call.path} for ${user}: ${JSON.stringify(verified)}`);
      const rejected = await verifyEnvelope(`${secret}-other`, body, Date.now());
      assert.deepEqual(rejected, { ok: false, reason: "bad_signature" });

      const { ts } = JSON.parse(body) as { ts: number };
      assert.ok(ts >= before && ts <= after, `ts ${ts} is the time of the call, in epoch ms`);
    }

    const first = await verifyEnvelope(secret, String(script.fetches[0].payload), Date.now());
    assert.ok(first.ok);
    const { requestedBy } = first.payload as { requestedBy: unknown };
    assert.equal(typeof requestedBy, "string");
    if (user !== "") assert.equal(requestedBy, user);
  }
});

test("signedPost_ signs the path and payload it is given", async () => {
  const cases: [string, unknown][] = [
    [PUBLISH, { requestedBy: "staff@example.jp" }],
    [BLOCKS, { requestedBy: "沖縄 🛵" }],
    [PHOTOS, { note: 'quotes " and \\ backslash', z: 1, a: [null, false] }],
    [ASSIGNMENTS, {}],
  ];
  for (const [path, payload] of cases) {
    const script = world();
    script.call("signedPost_", path, payload);
    assert.deepEqual(paths(script), [path]);
    const verified = await verifyEnvelope(SECRET, String(script.fetches[0].payload), Date.now());
    assert.deepEqual(verified, { ok: true, payload });
  }
});

test("hex conversion handles negative signed bytes", async () => {
  // RFC 4231 test case 2. Its digest has bytes above 0x7f, and bytes below 0x10 that need their leading zero.
  const rfcDigest = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
  const bytes = hmacSignature("what do ya want for nothing?", "Jefe", "UTF_8");
  assert.deepEqual(bytes, signedBytes(rfcDigest), "the fake is real HMAC-SHA256");
  assert.ok(Math.min(...bytes) < 0 && Math.max(...bytes) > 0, "the fake returns signed bytes");

  const digests = [rfcDigest, "ff".repeat(32), "00".repeat(32), "807f0ff001fe10ef".repeat(4)];
  for (const digest of digests) {
    const script = world({ signatureBytes: signedBytes(digest) });
    script.call("publish");
    for (const call of script.fetches) {
      assert.equal((JSON.parse(String(call.payload)) as { sig: string }).sig, digest);
    }
  }
});

test("a non-fatal report runs blocks, photos and assignments in order and summarizes them", () => {
  const cases = [
    { version: 412, counts: { ok: 120, warning: 3, error: 2 } },
    { version: 9001, counts: { ok: 58, warning: 0, error: 0 } },
    { version: 3, counts: { ok: 0, warning: 41, error: 77 } },
  ];
  for (const { version, counts } of cases) {
    const script = world({ routes: { [PUBLISH]: { body: { ...REPORT, version, counts } } } });
    script.call("publish");
    assert.deepEqual(paths(script), [PUBLISH, BLOCKS, PHOTOS, ASSIGNMENTS]);
    const { alert } = settled(script);
    assertHasNumbers(alert, [version, counts.ok, counts.warning, counts.error, 15, 17], "the summary");
  }
});

test("a fatal publish stops before blocks, photos and assignments", () => {
  const cases = [
    ["Models: missing header model_id"],
    ["Types: missing tab", "Config: missing key shop_name", "料金表: 見出しがありません"],
  ];
  for (const fatal of cases) {
    const report = { ok: false, counts: { ok: 0, warning: 0, error: 0 }, fatal, affectedBookings: [] };
    const script = world({ routes: { [PUBLISH]: { body: report } } });
    script.call("publish");

    assert.deepEqual(paths(script), [PUBLISH]);
    const { alert, row } = settled(script);
    for (const message of fatal) {
      assert.ok(alert.includes(message), `the alert shows ${message}: ${alert}`);
      assert.ok(cell(row, "message").includes(message), `the log shows ${message}`);
    }
    assert.equal(cell(row, "version"), "", "no version was published");
  }
});

test("blocks and photos loop until nothing remains", () => {
  const countdown = (from: number) => Array.from({ length: from + 1 }, (_, i) => from - i);
  const cases = [
    { blocks: [0], photos: [0] },
    { blocks: [5, 2, 0], photos: [0] },
    { blocks: [0], photos: [30, 15, 1, 0] },
    { blocks: [7, 0], photos: [1, 0] },
    // Round 10 is the last one allowed and the one that finishes.
    { blocks: countdown(ROUND_CAP - 1), photos: countdown(ROUND_CAP - 1) },
  ];
  for (const { blocks, photos } of cases) {
    const script = world({
      routes: {
        [BLOCKS]: blocks.map((remaining) => ({ body: { processed: 1, remaining, errors: [] } })),
        [PHOTOS]: photos.map((remaining) => ({ body: { copied: [], skipped: [], errors: [], remaining } })),
      },
    });
    script.call("publish");
    assert.deepEqual(paths(script), [
      PUBLISH,
      ...repeat(BLOCKS, blocks.length),
      ...repeat(PHOTOS, photos.length),
      ASSIGNMENTS,
    ]);
    settled(script);
  }
});

test("blocks and photos each stop after 10 rounds and say that work remains", () => {
  const endlessBlocks: Route = { body: { processed: 2, remaining: 37, errors: [] } };
  const endlessPhotos: Route = { body: { copied: ["x.jpg"], skipped: [], errors: [], remaining: 23 } };
  const cases: { routes: Record<string, Route>; blockRounds: number; photoRounds: number }[] = [
    { routes: { [BLOCKS]: endlessBlocks }, blockRounds: ROUND_CAP, photoRounds: 1 },
    { routes: { [PHOTOS]: endlessPhotos }, blockRounds: 1, photoRounds: ROUND_CAP },
    { routes: { [BLOCKS]: endlessBlocks, [PHOTOS]: endlessPhotos }, blockRounds: ROUND_CAP, photoRounds: ROUND_CAP },
  ];
  for (const { routes, blockRounds, photoRounds } of cases) {
    const script = world({ routes });
    script.call("publish");
    assert.deepEqual(paths(script), [
      PUBLISH,
      ...repeat(BLOCKS, blockRounds),
      ...repeat(PHOTOS, photoRounds),
      ASSIGNMENTS,
    ]);

    const { alert, row } = settled(script);
    assert.match(alert, WORK_REMAINS);
    assert.match(cell(row, "message"), WORK_REMAINS);
    if (blockRounds === ROUND_CAP) {
      assertHasNumbers(alert, [37], "the alert");
      assertHasNumbers(cell(row, "blocks"), [37], "the blocks cell");
    }
    if (photoRounds === ROUND_CAP) {
      assertHasNumbers(alert, [23], "the alert");
      assertHasNumbers(cell(row, "photos"), [23], "the photos cell");
    }
  }
});

test("the summary totals every round of blocks and photos", () => {
  for (const { name, many } of SHAPES) {
    const blocks = [
      { processed: 40, remaining: 37, errors: many(0, "") },
      { processed: 30, remaining: 7, errors: many(0, "") },
      { processed: 7, remaining: 0, errors: many(0, "") },
    ];
    const photos = [
      { copied: many(11, "a.jpg"), skipped: many(0, "b.jpg"), errors: many(0, ""), remaining: 2 },
      { copied: many(2, "c.jpg"), skipped: many(0, "d.jpg"), errors: many(0, ""), remaining: 0 },
    ];
    const script = world({
      routes: {
        [BLOCKS]: blocks.map((body) => ({ body })),
        [PHOTOS]: photos.map((body) => ({ body })),
        [ASSIGNMENTS]: { body: { applied: many(19, { row: 2 }), errors: many(0, "") } },
      },
    });
    script.call("publish");
    const { alert, row } = settled(script);
    assertHasNumbers(alert, [77, 13, 19], `the ${name} alert`);
    assertHasNumbers(cell(row, "blocks"), [77], `the ${name} blocks cell`);
    assertHasNumbers(cell(row, "photos"), [13], `the ${name} photos cell`);
    assertHasNumbers(cell(row, "assignments"), [19], `the ${name} assignments cell`);
  }
});

test("errors from the follow-up steps reach the alert and the log", () => {
  for (const { name, many } of SHAPES) {
    const script = world({
      routes: {
        [BLOCKS]: { body: { processed: 1, remaining: 0, errors: many(4, { message: "block conflict" }) } },
        [PHOTOS]: {
          body: {
            copied: many(0, ""),
            skipped: many(0, ""),
            errors: many(6, { name: "x.png", message: "too big" }),
            remaining: 0,
          },
        },
        [ASSIGNMENTS]: { body: { applied: many(0, {}), errors: many(8, { row: 3, message: "plate busy" }) } },
      },
    });
    script.call("publish");
    const { alert, row } = settled(script);
    assertHasNumbers(alert, [4, 6, 8], `the ${name} alert`);
    assertHasNumbers(cell(row, "blocks"), [4], `the ${name} blocks cell`);
    assertHasNumbers(cell(row, "photos"), [6], `the ${name} photos cell`);
    assertHasNumbers(cell(row, "assignments"), [8], `the ${name} assignments cell`);
  }
});

test("errors that come back every round count once", () => {
  const cases: RoundsCase[] = [
    { errors: [2, 2, 2], shows: 2, not: [6] },
    { errors: [3, 3], shows: 3, not: [6] },
    { errors: [3, 3, 3, 3], shows: 3, not: [12] },
    { errors: [4, 4, 4], shows: 4, not: [12] },
    { errors: [4], shows: 4, not: [] },
    { errors: Array.from({ length: ROUND_CAP }, () => 2), shows: 2, not: [20] },
  ];
  for (const step of LOOPED_STEPS) {
    for (const rounds of cases) {
      const { alert, row } = publishRounds(step, rounds.errors);
      // The cell, since a heading over the photo list may well say "failed". A count has no names to list, not a crash.
      assert.doesNotMatch(cell(row, step.column), FAILED, `${step.label}: the step did not fail`);
      assertLastRoundReported(step, rounds, alert, row);
    }
  }
});

test("errors that change between rounds show the last round's", () => {
  const cases: RoundsCase[] = [
    // Copy failures can clear on the next round, so the worst round is not the answer either.
    { errors: [3, 1], shows: 1, not: [4, 3] },
    { errors: [6, 4, 1], shows: 1, not: [11, 6] },
    { errors: [2, 0], shows: 0, not: [2] },
    { errors: [1, 3], shows: 3, not: [4] },
  ];
  for (const step of LOOPED_STEPS) {
    for (const rounds of cases) {
      const { alert, row } = publishRounds(step, rounds.errors);
      assertLastRoundReported(step, rounds, alert, row);
    }
  }
});

test("a round that fails keeps the last answered round's errors", () => {
  const failures: Reply[] = [
    { status: 503, body: "upstream busy" },
    { throws: "Timeout: reservation-one.example.dev" },
    { body: "<html>Bad gateway</html>" },
  ];
  const cases: RoundsCase[] = [
    { errors: [3, 1], shows: 1, not: [4, 3] },
    { errors: [2, 2, 2], shows: 2, not: [6] },
    { errors: [2, 0], shows: 0, not: [2] },
    { errors: [7], shows: 7, not: [] },
  ];
  for (const step of LOOPED_STEPS) {
    for (const rounds of cases) {
      for (const failure of failures) {
        const { alert, row } = publishRounds(step, rounds.errors, failure);
        assert.match(alert, FAILED, `${step.label}: the alert says the step failed`);
        assertLastRoundReported(step, rounds, alert, row);
      }
    }
  }
});

test("photo errors reach staff with each name and reason", () => {
  // The photos step writes nothing back to the sheet, so this is the only report staff get.
  const problems: PhotoError[] = [
    { name: "pcx125 front.jpg", message: "Not in the Drive folder" },
    { name: "フォルツァ 横.png", message: "More than one file in the Drive folder has this name" },
    { name: "n-van.webp", message: "7340032 bytes is over the limit of 5242880" },
  ];
  for (const count of [1, 2, FEW_PHOTO_ERRORS]) {
    const errors = problems.slice(0, count);
    const script = world({
      routes: { ...QUIET_ROUTES, [PHOTOS]: { body: { copied: 904, skipped: [], errors, remaining: 0 } } },
    });
    script.call("publish");
    const { alert, row } = settled(script);
    assertHasNumbers(alert, [count], "the alert");
    assertPhotoList(alert, errors, [], "the alert");
    assertPhotoList(cell(row, "message"), errors, [], "the message cell");
  }
});

test("a long list of photo errors is capped and states the total", () => {
  const cases: RoundsCase[] = [
    { errors: [MOST_PHOTO_ERRORS + 1], shows: MOST_PHOTO_ERRORS + 1, not: [] },
    { errors: [25], shows: 25, not: [] },
    { errors: [25, 25, 25], shows: 25, not: [75] },
    { errors: [60, 60], shows: 60, not: [120] },
    { errors: [60, 25], shows: 25, not: [85, 60] },
  ];
  for (const rounds of cases) {
    const { alert, row } = publishRounds(PHOTO_LIST, rounds.errors);
    assertLastRoundReported(PHOTO_LIST, rounds, alert, row);
  }
});

test("a round sends back the cursor the round before answered", async () => {
  const cases: { label: string; answered: unknown[]; sent: (string | null)[] }[] = [
    { label: "one cursor", answered: ["Q1VSU09S", null], sent: [null, "Q1VSU09S"] },
    { label: "a new cursor each round", answered: ["one", "two", "three", null], sent: [null, "one", "two", "three"] },
    { label: "a cursor with quotes and kana", answered: ['"沖縄"/=+', null], sent: [null, '"沖縄"/=+'] },
    // The last round's cursor has no round to go to, and must not reach the next step either.
    { label: "a cursor on the last round", answered: ["one", "two"], sent: [null, "one"] },
    { label: "a cursor that stops", answered: ["one", null, null], sent: [null, "one", null] },
    { label: "one that comes back", answered: ["one", null, "two", null], sent: [null, "one", null, "two"] },
    { label: "null cursors", answered: [null, null, null], sent: [null, null, null] },
    { label: "no cursor key", answered: [undefined, undefined, undefined], sent: [null, null, null] },
    { label: "no strings", answered: [7, ["one"], { at: 1 }, true, null], sent: [null, null, null, null, null] },
  ];
  for (const { label, answered, sent } of cases) {
    for (const user of [USER, ""]) {
      const blocks = answered.map((cursor, i): Reply => ({
        body: { processed: 20, remaining: answered.length - 1 - i, errors: [], cursor },
      }));
      const photos = [1, 0].map((remaining): Reply => ({ body: { copied: 1, skipped: [], errors: [], remaining } }));
      const script = world({ user, routes: { [BLOCKS]: blocks, [PHOTOS]: photos } });
      script.call("publish");

      const plain = { requestedBy: user };
      const expected = sent.map((cursor) => (cursor === null ? plain : { ...plain, cursor }));
      assert.deepEqual(await signedPayloads(script, BLOCKS), expected, `${label}, user ${JSON.stringify(user)}`);
      assert.deepEqual(await signedPayloads(script, PHOTOS), [plain, plain], label);
      assert.deepEqual(await signedPayloads(script, ASSIGNMENTS), [plain], label);
    }
  }
});

test("a cursor pass adds up the errors of the rounds that sent one", () => {
  const passes: CursorPass[] = [
    { label: "two rounds", errors: [2, 1], cursors: ["one", null], countsFrom: 0, not: [] },
    { label: "three rounds", errors: [1, 1, 1], cursors: ["one", "two", null], countsFrom: 0, not: [] },
    { label: "20 rows, then 3", errors: [20, 3], cursors: ["one", null], countsFrom: 0, not: [3, 20] },
    { label: "a lot, then a few", errors: [25, 25, 7], cursors: ["one", "two", null], countsFrom: 0, not: [7, 25] },
    { label: "a clean last round", errors: [4, 0], cursors: ["one", null], countsFrom: 0, not: [] },
    { label: "a clean round between", errors: [2, 0, 1], cursors: ["one", "two", null], countsFrom: 0, not: [1, 2] },
    { label: "a clean first round", errors: [0, 2], cursors: ["one", null], countsFrom: 0, not: [] },
    // A round that sent no cursor starts the list again, as every round of a step without a cursor does.
    { label: "no cursor at all", errors: [3, 1], cursors: [null, null], countsFrom: 1, not: [4, 3] },
    { label: "a late cursor", errors: [5, 2, 1], cursors: [null, "one", null], countsFrom: 1, not: [8, 5, 1] },
    { label: "a cursor that stops", errors: [2, 1, 4], cursors: ["one", null, null], countsFrom: 2, not: [7, 3] },
  ];
  for (const pass of passes) {
    const { alert, row } = publishCursorPass(pass);
    assert.doesNotMatch(cell(row, "blocks"), FAILED, `${pass.label}: the step did not fail`);
    assertPassReported(pass, alert, row);
  }
});

test("a cursor pass that fails or hits the round cap keeps the errors it has", () => {
  const failures: Reply[] = [
    { status: 503, body: "upstream busy" },
    { throws: "Timeout: reservation-one.example.dev" },
    { body: "<html>Bad gateway</html>" },
  ];
  const failing: CursorPass = { label: "a failure", errors: [2, 1], cursors: ["one", "two"], countsFrom: 0, not: [] };
  for (const failure of failures) {
    const { alert, row } = publishCursorPass(failing, LEFT_OVER, failure);
    assert.match(alert, FAILED);
    assertPassReported(failing, alert, row);
  }

  const capped: CursorPass = {
    label: "the round cap",
    errors: Array.from({ length: ROUND_CAP }, () => 2),
    cursors: Array.from({ length: ROUND_CAP }, (_, i) => `round-${i}`),
    countsFrom: 0,
    not: [2],
  };
  const { alert, row } = publishCursorPass(capped, LEFT_OVER);
  assert.match(alert, WORK_REMAINS);
  assertHasNumbers(cell(row, "blocks"), [LEFT_OVER], "the blocks cell");
  assertPassReported(capped, alert, row);
});

test("a failed /api/publish ends in an alert and a log row, not a stack trace", () => {
  const cases: { name: string; reply: Reply; shows?: string[] }[] = [
    { name: "401 with no detail", reply: { status: 401 }, shows: ["401"] },
    { name: "401 with a body", reply: { status: 401, body: { error: "unauthorized" } }, shows: ["401"] },
    { name: "502 as text", reply: { status: 502, body: "Sheets unavailable" }, shows: ["502", "Sheets unavailable"] },
    {
      name: "502 as JSON",
      reply: { status: 502, body: { error: "Sheets read failed" } },
      shows: ["502", "Sheets read failed"],
    },
    {
      name: "500 as text",
      reply: { status: 500, body: "Publish misconfigured" },
      shows: ["500", "Publish misconfigured"],
    },
    { name: "200 with HTML", reply: { body: "<html><body>Error 1101</body></html>" } },
    { name: "200 with nothing", reply: { body: "" } },
    { name: "200 with JSON null", reply: { body: null } },
    { name: "200 with a JSON list", reply: { body: [] } },
    { name: "a thrown fetch", reply: { throws: "Address unavailable: reservation-one.example.dev" } },
  ];
  for (const { name, reply, shows } of cases) {
    const script = world({ routes: { [PUBLISH]: reply } });
    script.call("publish");

    assert.deepEqual(paths(script), [PUBLISH], name);
    const { alert, row } = settled(script);
    assert.equal(cell(row, "version"), "", `${name}: no version was published`);
    assert.notEqual(cell(row, "message"), "", `${name}: the log says what happened`);
    if (shows === undefined) assert.match(alert, FAILED, name);
    for (const text of shows ?? []) {
      assert.ok(alert.includes(text), `${name}: the alert shows ${text}: ${alert}`);
      assert.ok(cell(row, "message").includes(text), `${name}: the log shows ${text}`);
    }
  }
});

test("a failed follow-up step ends in an alert and a log row, not a stack trace", () => {
  const failures: { name: string; reply: Reply; shows?: string }[] = [
    { name: "503", reply: { status: 503, body: "upstream busy" }, shows: "503" },
    { name: "401", reply: { status: 401, body: { error: "unauthorized" } }, shows: "401" },
    { name: "non-JSON", reply: { body: "<html>Error 1101</html>" } },
    { name: "JSON null", reply: { body: null } },
    { name: "a thrown fetch", reply: { throws: "Timeout: reservation-one.example.dev" } },
  ];
  for (const path of [BLOCKS, PHOTOS, ASSIGNMENTS]) {
    for (const { name, reply, shows } of failures) {
      const script = world({ routes: { [path]: reply } });
      script.call("publish");

      const rounds = paths(script).filter((called) => called === path).length;
      assert.ok(rounds >= 1 && rounds <= ROUND_CAP, `${path} ${name}: ${rounds} rounds`);
      const { alert, row } = settled(script);
      assert.equal(cell(row, "version"), String(REPORT.version), "the catalog itself was published");
      if (shows === undefined) assert.match(alert, FAILED, `${path} ${name}`);
      else assert.ok(alert.includes(shows), `${path} ${name}: the alert shows ${shows}: ${alert}`);
    }
  }
});

test("a held lock prevents a second publish", () => {
  const elsewhere = world({ lockHeldElsewhere: true });
  elsewhere.call("publish");
  assert.deepEqual(elsewhere.fetches, []);
  assert.deepEqual(elsewhere.lock.timeouts, [10_000]);
  assert.equal(elsewhere.alerts.length, 1);
  assert.match(elsewhere.alerts[0], /Publish already running/);
  assert.deepEqual(logRows(elsewhere), [], "a refused click published nothing, so it logs nothing");
  assert.equal(elsewhere.lock.held(), true, "the other run keeps its lock");

  // A second click while the first run waits on the Worker, then a third once it is done.
  let clicked = false;
  const script: AppsScriptWorld = world({
    routes: {
      [PUBLISH]: () => {
        if (!clicked) {
          clicked = true;
          script.call("publish");
          assert.deepEqual(paths(script), [PUBLISH], "the second click sent nothing");
        }
        return { body: REPORT };
      },
    },
  });
  script.call("publish");
  assert.deepEqual(paths(script), [PUBLISH, BLOCKS, PHOTOS, ASSIGNMENTS]);
  assert.equal(script.alerts.length, 2);
  assert.match(script.alerts[0], /Publish already running/);
  assert.doesNotMatch(script.alerts[1], /Publish already running/);
  assert.equal(logRows(script).length, 1);
  assert.equal(script.lock.held(), false);

  script.call("publish");
  assert.equal(paths(script).length, 8, "the lock is free for the next Publish");
});

test("each publish appends a PublishLog row", () => {
  const earlier = ["2026-10-01 09:00", "someone@example.jp", 411, "1/0/0", "", "", "", "kept"];
  const reports = [
    { ...REPORT, version: 412, counts: { ok: 120, warning: 3, error: 2 } },
    { ...REPORT, version: 413, counts: { ok: 95, warning: 6, error: 0 } },
  ];
  const script = world({
    user: "keiko@okinawa-dream.example",
    tabs: { PublishLog: [[...SHEET_TABS.PublishLog], earlier] },
    routes: {
      [PUBLISH]: reports.map((body) => ({ body })),
      [BLOCKS]: [
        { body: { processed: 21, remaining: 0, errors: [] } },
        { body: { processed: 22, remaining: 0, errors: [] } },
      ],
      [PHOTOS]: [
        { body: { copied: ["1.jpg", "2.jpg", "3.jpg"], skipped: [], errors: [], remaining: 0 } },
        { body: { copied: ["1.jpg", "2.jpg", "3.jpg", "4.jpg"], skipped: [], errors: [], remaining: 0 } },
      ],
      [ASSIGNMENTS]: [{ body: { applied: 31, errors: [] } }, { body: { applied: 32, errors: [] } }],
    },
  });

  const before = Date.now();
  script.call("publish");
  script.call("publish");
  const after = Date.now();

  const rows = logRows(script);
  assert.equal(rows.length, 3, "one row per Publish, after the rows already there");
  assert.deepEqual(rows[0], earlier);
  assert.deepEqual(script.tabs.get("PublishLog")?.rows[0], SHEET_TABS.PublishLog);

  const expected = [
    { blocks: 21, photos: 3, assignments: 31 },
    { blocks: 22, photos: 4, assignments: 32 },
  ];
  rows.slice(1).forEach((row, i) => {
    const { version, counts } = reports[i];
    assert.equal(row.length, SHEET_TABS.PublishLog.length);
    const time = new Date(row[0] as string).getTime();
    assert.ok(time >= before - 1000 && time <= after + 1000, `the time cell ${String(row[0])} is now`);
    assert.equal(cell(row, "user"), "keiko@okinawa-dream.example");
    assert.equal(cell(row, "version"), String(version));
    assertHasNumbers(cell(row, "counts"), [counts.ok, counts.warning, counts.error], "the counts cell");
    assertHasNumbers(cell(row, "blocks"), [expected[i].blocks], "the blocks cell");
    assertHasNumbers(cell(row, "photos"), [expected[i].photos], "the photos cell");
    assertHasNumbers(cell(row, "assignments"), [expected[i].assignments], "the assignments cell");
    assert.notEqual(cell(row, "message"), "");
  });
});

test("a blank user still publishes and logs a row with a blank user cell", () => {
  // getEmail answers blank when security policies hide the address.
  const script = world({ user: "" });
  script.call("publish");
  assert.deepEqual(paths(script), [PUBLISH, BLOCKS, PHOTOS, ASSIGNMENTS]);
  const { alert, row } = settled(script, "");
  assertHasNumbers(alert, [REPORT.version], "the summary");
  assert.equal(cell(row, "version"), String(REPORT.version));
});

test("publish lists each affected booking in the alert and counts them in the log", () => {
  // None of these counts is a number the rest of the fake report puts in the log.
  for (const count of [1, 4, 6]) {
    const listed = AFFECTED.slice(0, count);
    const script = world({ routes: { [PUBLISH]: reportWith(listed) } });
    script.call("publish");

    assert.deepEqual(paths(script), [PUBLISH, BLOCKS, PHOTOS, ASSIGNMENTS]);
    const { alert, row } = settled(script);
    assertListsBookings(alert, listed);
    assertHasNumbers(cell(row, "message"), [count], "the message cell");
  }
});

test("affected bookings still reach staff when a follow-up step fails", () => {
  // The catalog is already replaced by then, so these bookings need action whatever happens next.
  const listed = AFFECTED.slice(2);
  const failures: Reply[] = [
    { status: 503, body: "upstream busy" },
    { throws: "Timeout: reservation-one.example.dev" },
  ];
  for (const path of [BLOCKS, PHOTOS, ASSIGNMENTS]) {
    for (const reply of failures) {
      const script = world({ routes: { [PUBLISH]: reportWith(listed), [path]: reply } });
      script.call("publish");

      const { alert, row } = settled(script);
      assertListsBookings(alert, listed);
      assertHasNumbers(cell(row, "message"), [listed.length], `${path}: the message cell`);
    }
  }
});

test("a missing PublishLog tab does not hide the result from staff", () => {
  const script = world({ tabs: {} });
  script.call("publish");
  assert.deepEqual(paths(script), [PUBLISH, BLOCKS, PHOTOS, ASSIGNMENTS]);
  assert.equal(script.lock.held(), false);
  const alert = script.alerts.join("\n");
  assert.doesNotMatch(alert, STACK_TRACE);
  assertHasNumbers(alert, [REPORT.version], "the alert");
});

test("a user lookup that throws ends in an alert, not a stack trace", () => {
  const script = world({ userError: "You do not have permission to call Session.getActiveUser" });
  script.call("publish");
  assert.equal(script.lock.held(), false);
  assert.ok(script.alerts.length >= 1);
  for (const alert of script.alerts) assert.doesNotMatch(alert, STACK_TRACE);
});

test("setupTabs headers equal SHEET_TABS", () => {
  const script = world({ tabs: {} });
  script.call("setupTabs");

  // The Worker never reads the Dashboard tab, so it stays out of SHEET_TABS, and the copy equals the original.
  assert.ok(!(DASHBOARD in SHEET_TABS), "SHEET_TABS has no Dashboard");
  assert.deepEqual(script.evaluate("SHEET_TABS_"), SHEET_TABS, "SHEET_TABS_ in Publish.js equals SHEET_TABS");
  // Dashboard holds instructions, not a header row: the dashboard tests check what is in it.
  assert.deepEqual([...script.inserted].sort(), [...Object.keys(SHEET_TABS), DASHBOARD].sort());
  for (const [name, headers] of Object.entries(SHEET_TABS)) {
    assert.deepEqual(script.tabs.get(name)?.rows, [headers], name);
  }
  assert.equal(script.timeZone(), "Asia/Tokyo");
  assert.deepEqual(script.fetches, []);
});

test("setupTabs creates exactly the missing tabs and leaves existing ones untouched", () => {
  // Dashboard is one of the tabs Set up tabs makes, with instructions in place of headers.
  const names = [...Object.keys(SHEET_TABS), DASHBOARD];
  const existing: Record<string, unknown[][]> = {
    Config: [["key", "value", "my own notes"], ["shop_name", "Okinawa Dream", "keep me"]],
    // Headers that no longer match are for Publish to report. Setup must not repair them.
    Models: [["model_id"], ["pcx-125"]],
    // Even an empty tab already there stays as it is.
    Bookings: [],
    PublishLog: [[...SHEET_TABS.PublishLog], ["2026-10-01 09:00", "a@example.jp", 7, "", "", "", "", "kept"]],
    // Not one of ours: the tab a new spreadsheet starts with.
    Sheet1: [["scratch"]],
  };
  const partials: [string, Record<string, unknown[][]>][] = [
    ["a partly set up sheet", existing],
    ["a partly set up sheet with its own Dashboard", { ...existing, [DASHBOARD]: [["our notes"], ["", "kept"]] }],
    ["a new spreadsheet", { Sheet1: [] }],
    ["every tab there", Object.fromEntries(names.map((name) => [name, [["kept"]]]))],
    // One case per tab: a typo in any one copied header list has nowhere to hide.
    ...names.map((missing): [string, Record<string, unknown[][]>] => [
      `all but ${missing}`,
      Object.fromEntries(names.filter((name) => name !== missing).map((name) => [name, [[`kept ${name}`]]])),
    ]),
  ];

  for (const [label, tabs] of partials) {
    const script = world({ tabs, timeZone: "America/Los_Angeles" });
    script.call("setupTabs");
    script.call("setupTabs");

    const missing = names.filter((name) => !(name in tabs)).sort();
    assert.deepEqual([...script.inserted].sort(), missing, label);
    for (const name of missing) {
      if (name === DASHBOARD) {
        assert.ok((script.tabs.get(name)?.rows.length ?? 0) > 0, `${label}: the new Dashboard has its instructions`);
        continue;
      }
      assert.deepEqual(script.tabs.get(name)?.rows, [SHEET_TABS[name as keyof typeof SHEET_TABS]], `${label}: ${name}`);
    }
    for (const [name, rows] of Object.entries(tabs)) {
      assert.deepEqual(script.tabs.get(name)?.rows, rows, `${label}: ${name} keeps its cells`);
      assert.deepEqual(script.tabs.get(name)?.touches, [], `${label}: nothing wrote to ${name}`);
    }
    assert.equal(script.timeZone(), "Asia/Tokyo", label);
  }
});

test("missing properties alert clearly", () => {
  const present = { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: SECRET };
  const cases: { properties: Record<string, string>; names: RegExp }[] = [
    { properties: { PUBLISH_SECRET: SECRET }, names: /WORKER_BASE_URL/ },
    { properties: { ...present, WORKER_BASE_URL: "" }, names: /WORKER_BASE_URL/ },
    { properties: { WORKER_BASE_URL: BASE_URL }, names: /PUBLISH_SECRET/ },
    { properties: { ...present, PUBLISH_SECRET: "" }, names: /PUBLISH_SECRET/ },
    { properties: {}, names: /WORKER_BASE_URL|PUBLISH_SECRET/ },
  ];
  for (const { properties, names } of cases) {
    const script = world({ properties });
    script.call("publish");

    assert.deepEqual(script.fetches, [], "nothing is sent");
    assert.equal(script.alerts.length, 1);
    assert.match(script.alerts[0], names);
    assert.doesNotMatch(script.alerts[0], STACK_TRACE);
    assert.equal(script.lock.held(), false, "the lock is released");
    assert.ok(logRows(script).length <= 1, "a log row is optional here");
  }
});

test("onOpen adds the Okinawa Dream menu", () => {
  const script = world();
  script.call("onOpen");
  // Each panel task adds its entry to DASHBOARD_ACTIONS_, so the list is read from the script as it is now.
  const actions = script.evaluate("DASHBOARD_ACTIONS_") as { label: string; fn: string }[];
  assert.deepEqual(script.menus, [
    {
      name: "Okinawa Dream",
      items: [
        ["Publish to website", "publish"],
        ["Set up tabs", "setupTabs"],
        MENU_SEPARATOR,
        ["Open dashboard", "openDashboard"],
        ...actions.map(({ label, fn }): MenuEntry => [label, fn]),
      ],
      added: true,
    },
  ]);
  assert.deepEqual(script.fetches, []);
});

test("the manifest runs on V8 in Japan time with the ticket's scopes", () => {
  const manifest = JSON.parse(readFileSync(new URL("../apps-script/appsscript.json", import.meta.url), "utf8")) as {
    runtimeVersion: string;
    timeZone: string;
    oauthScopes: string[];
  };
  assert.equal(manifest.runtimeVersion, "V8");
  assert.equal(manifest.timeZone, "Asia/Tokyo");
  // userinfo.email is the scope Google documents for Session.getActiveUser, added by the owner's answer on the ticket.
  // script.send_mail is the mail web app's, from task #38. drive.file is Add a bike's photo upload, from task #155
  // (owner decision 6): the narrowest Drive scope, acting as the staff member who runs it.
  assert.deepEqual([...manifest.oauthScopes].sort(), [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/script.container.ui",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.send_mail",
    "https://www.googleapis.com/auth/spreadsheets.currentonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ]);
});
