// POST /api/staff/catalog through the built Worker: the published choices the Dashboard panels of #140 offer staff. The
// catalog is published with replaceCatalog into the real (Miniflare) D1, and bodies are signed here with node:crypto,
// the way the Apps Script side signs them. Expected values are literals from tests/fixtures/sheet/valid-catalog.json,
// written out by hand. The view's own rules are tests/staff-catalog-view.test.ts: here is what the route adds to them.
//
// Rulings these tests pin where the ticket is silent:
// - The route reads only: every table of D1 is the same after any request, answered or refused, and it calls nothing
//   outside the Worker.
// - The checks are the publish routes': past 64 * 1024 bytes a 413 before the signature, so for anyone; a body of exactly
//   the limit is still read. A refused signature is a 401 of `{ error: "unauthorized" }`, which the Apps Script reads
//   already. An empty or unset PUBLISH_SECRET is a 500 the route answers itself, not a throw it lets escape to /500.
// - The signed payload's content is not read: any signed payload gets the view.
// - The answer before the first publish is a 200 of exactly `{ ok: false, reason: "NOT_PUBLISHED" }`, even when catalog
//   rows were written by hand without a catalog_meta row, since only a publish records one.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import type { Catalog } from "../../src/lib/types.ts";
import { seedConfig, seedModel, seedVehicle } from "../helpers/seed.ts";
import { expectedCatalog } from "../helpers/sheet-workbook.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const PATH = "/api/staff/catalog";
const TEN_MINUTES_MS = 600_000;
/** 64 * 1024, the limit of every publish route. A body of this many bytes is allowed and one more is not. */
const LIMIT_BYTES = 65_536;
const UNAUTHORIZED = { error: "unauthorized" };
const NOT_PUBLISHED = { ok: false, reason: "NOT_PUBLISHED" };
const PAYLOAD = '{"requestedBy":"staff@example.com"}';

const outboundRequests: string[] = [];

function outbound(request: Request): Response {
  outboundRequests.push(`${request.method} ${request.url}`);
  return new Response("outbound request blocked by tests/e2e/staff-catalog.e2e.ts", { status: 502 });
}

let worker: TestWorker;
/** The version the second publish of `before` recorded, as replaceCatalog answered it. */
let publishedVersion: number;

/** The fixture with a model of its own, its bike and its class, a dearer scooter deposit and later hours. */
function firstCatalog(): Catalog {
  const base = expectedCatalog();
  const pcx = base.models.find((m) => m.id === "pcx-125");
  assert.ok(pcx);
  const names = (ja: string, en: string) => ({ ja: { name: ja }, en: { name: en }, "zh-cn": { name: en }, ko: { name: en } });
  const text = (name: string) => ({ name, summary: `${name} summary`, description: `${name} description` });
  return {
    ...base,
    config: { ...base.config, shopClose: "20:00" },
    vehicleTypes: base.vehicleTypes.map((type) => (type.id === "scooter" ? { ...type, depositJpy: 4000 } : type)),
    rateClasses: [
      ...base.rateClasses,
      { id: "bike-160", grp: "bike", sort: 6, extensionPerHourJpy: 800, texts: names("160cc", "160cc bike") },
    ],
    models: [
      ...base.models,
      {
        ...pcx,
        id: "adv-160",
        sort: 2,
        rateClassId: "bike-160",
        texts: { ja: text("エーディーブイ"), en: text("ADV"), "zh-cn": text("ADV"), ko: text("ADV") },
      },
    ],
    vehicles: [
      ...base.vehicles,
      { plate: "わ1010", modelId: "adv-160", status: "active", odometerKm: null, baseUsageDays: 0 },
    ],
    prices: [...base.prices, { rateClassId: "bike-160", packageId: "day-1", priceJpy: 6000, advancePriceJpy: 5500 }],
  };
}

async function publishTwice(db: D1Database): Promise<number> {
  await replaceCatalog(db, firstCatalog(), { now: Date.now() - 60_000, source: "sheet" });
  return (await replaceCatalog(db, expectedCatalog(), { now: Date.now(), source: "sheet" })).version;
}

before(async () => {
  worker = await startWorker({ outbound });
  publishedVersion = await publishTwice(worker.db);
});

after(async () => {
  await worker?.stop();
});

function signature(secret: string, ts: number, payload: string): string {
  return createHmac("sha256", secret).update(`${ts}.${payload}`, "utf8").digest("hex");
}

function signedBody(secret = testVars.PUBLISH_SECRET, ts = Date.now(), payload = PAYLOAD): string {
  return JSON.stringify({ ts, payload, sig: signature(secret, ts, payload) });
}

function post(body?: string | Buffer<ArrayBuffer>, on: TestWorker = worker): Promise<Response> {
  return on.fetch(PATH, { method: "POST", headers: { "content-type": "application/json" }, body });
}

async function answer(res: Response, status: number, label: string): Promise<unknown> {
  const text = await res.text();
  assert.equal(res.status, status, `${label}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Every row of every table, so a test can tell that a request wrote nothing at all. */
async function snapshot(db: D1Database): Promise<Record<string, string[]>> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND substr(name, 1, 4) <> '_cf_' ORDER BY name",
    )
    .all<{ name: string }>();
  const tables: Record<string, string[]> = {};
  for (const { name } of results) {
    const rows = await db.prepare(`SELECT * FROM "${name}"`).all();
    tables[name] = rows.results.map((row) => JSON.stringify(row)).sort();
  }
  return tables;
}

type Plate = { plate: string; status: string };
type PriceView = { modelId: string; packageId: string; priceJpy: number; advancePriceJpy: number | null };
type View = {
  ok: true;
  version: number;
  models: { id: string; nameJa: string; nameEn: string; typeId: string; active: boolean; depositJpy: number; plates: Plate[] }[];
  packages: unknown[];
  prices: PriceView[];
  slots: string[];
  config: unknown;
};

function priceRows(modelId: string, rows: [string, number][]): PriceView[] {
  return rows.map(([packageId, priceJpy]) => ({ modelId, packageId, priceJpy, advancePriceJpy: null }));
}

function sortedPrices(prices: PriceView[]): PriceView[] {
  return [...prices].sort((a, b) => (`${a.modelId}/${a.packageId}` < `${b.modelId}/${b.packageId}` ? -1 : 1));
}

/** The view after `before`: the fixture, and adv-160, which the second publish left out, kept as inactive and retired. */
function expectedView(version: number): View {
  return {
    ok: true,
    version,
    models: [
      {
        id: "today-50",
        nameJa: "トゥデイ",
        nameEn: "Today",
        typeId: "scooter",
        active: true,
        depositJpy: 3000,
        plates: [{ plate: "わ1001", status: "active" }],
      },
      // Sort 2 as pcx-125, and first by id.
      {
        id: "adv-160",
        nameJa: "エーディーブイ",
        nameEn: "ADV",
        typeId: "scooter",
        active: false,
        depositJpy: 3000,
        plates: [{ plate: "わ1010", status: "retired" }],
      },
      {
        id: "pcx-125",
        nameJa: "ピーシーエックス",
        nameEn: "PCX",
        typeId: "scooter",
        active: true,
        depositJpy: 3000,
        plates: [
          { plate: "わ1002", status: "active" },
          { plate: "わ1003", status: "maintenance" },
        ],
      },
      {
        id: "cub-110",
        nameJa: "カブ",
        nameEn: "Cub",
        typeId: "motorcycle",
        active: false,
        depositJpy: 5000,
        plates: [{ plate: "わ1004", status: "retired" }],
      },
      {
        id: "rebel-250",
        nameJa: "レブル",
        nameEn: "Rebel",
        typeId: "motorcycle",
        active: true,
        depositJpy: 5000,
        plates: [{ plate: "わ1005", status: "active" }],
      },
      {
        id: "nbox-660",
        nameJa: "エヌボックス",
        nameEn: "N-BOX",
        typeId: "car",
        active: true,
        depositJpy: 10000,
        plates: [{ plate: "わ1006", status: "active" }],
      },
    ],
    packages: [
      { id: "hours-6", nameJa: "6時間", nameEn: "6 hours", days: null, hours: 6 },
      { id: "day-1", nameJa: "1日", nameEn: "1 day", days: 1, hours: null },
      { id: "day-3", nameJa: "3日", nameEn: "3 days", days: 3, hours: null },
    ],
    // The second publish took bike-160's price away with the model, so adv-160 has none.
    prices: [
      ...priceRows("today-50", [["hours-6", 2500], ["day-1", 3500], ["day-3", 9000]]),
      ...priceRows("pcx-125", [["hours-6", 3600], ["day-1", 5200], ["day-3", 13800]]),
      ...priceRows("cub-110", [["hours-6", 3600], ["day-1", 5200], ["day-3", 13800]]),
      ...priceRows("rebel-250", [["hours-6", 6100], ["day-1", 9100], ["day-3", 24700]]),
      ...priceRows("nbox-660", [["day-1", 7300], ["day-3", 18900]]),
    ],
    slots: [
      "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00",
      "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
    ],
    config: { shopOpen: "09:00", shopClose: "18:00", slotMinutes: 30, minLeadHours: 24, maxDaysAhead: 180 },
  };
}

function assertView(body: unknown, version: number, label: string): void {
  const view = body as View;
  const expected = expectedView(version);
  assert.deepEqual(
    { ...view, prices: sortedPrices(view.prices ?? []) },
    { ...expected, prices: sortedPrices(expected.prices) },
    label,
  );
}

/** A signed request with the right secret gets the view, so the refusals before it were about what they say. */
async function assertAnswers(label: string): Promise<void> {
  assertView(await answer(await post(signedBody()), 200, label), publishedVersion, label);
}

test("a signed request answers the published catalog", async () => {
  assert.equal(publishedVersion, 2, "two publishes on a fresh D1");
  const was = await snapshot(worker.db);
  const calls = outboundRequests.length;

  const PAYLOADS: [string, string][] = [
    ["the requester", PAYLOAD],
    ["an empty object", "{}"],
    ["another requester", '{"requestedBy":"owner@example.com","panel":"block"}'],
  ];
  for (const [label, payload] of PAYLOADS) {
    const body = await answer(await post(signedBody(testVars.PUBLISH_SECRET, Date.now(), payload)), 200, label);
    assertView(body, publishedVersion, label);
  }

  // A third publish shows on the next request: the view is read from D1 each time.
  const shifted = expectedCatalog();
  shifted.vehicleTypes = shifted.vehicleTypes.map((type) => (type.id === "car" ? { ...type, depositJpy: 12000 } : type));
  shifted.vehicles = shifted.vehicles.map((v) => (v.plate === "わ1005" ? { ...v, status: "maintenance" as const } : v));
  const { version } = await replaceCatalog(worker.db, shifted, { now: Date.now(), source: "sheet" });
  assert.equal(version, 3);
  const third = (await answer(await post(signedBody()), 200, "after a third publish")) as View;
  assert.equal(third.version, 3);
  assert.equal(third.models.find((m) => m.id === "nbox-660")?.depositJpy, 12000);
  assert.deepEqual(third.models.find((m) => m.id === "rebel-250")?.plates, [{ plate: "わ1005", status: "maintenance" }]);

  // Put the second publish's state back for the tests below, as a new version.
  publishedVersion = (await replaceCatalog(worker.db, expectedCatalog(), { now: Date.now(), source: "sheet" })).version;
  await assertAnswers("after the catalog was put back");
  assert.equal(outboundRequests.length, calls, "the route called out of the Worker");

  // Reading wrote nothing: compared with a fresh snapshot of the state the requests above read.
  const settled = await snapshot(worker.db);
  await assertAnswers("once more");
  assert.deepEqual(await snapshot(worker.db), settled, "a signed request wrote to D1");
  assert.notDeepEqual(was.catalog_meta, settled.catalog_meta, "the publishes of this test are seen by the snapshot");
});

test("before the first publish it answers NOT_PUBLISHED", async () => {
  const fresh = await startWorker({ outbound });
  try {
    // Catalog rows written by hand, with no publish behind them.
    await seedConfig(fresh.db);
    const model = await seedModel(fresh.db);
    await seedVehicle(fresh.db, { model_id: model.id });
    const was = await snapshot(fresh.db);
    const calls = outboundRequests.length;

    for (const payload of [PAYLOAD, "{}"]) {
      const body = await answer(await post(signedBody(testVars.PUBLISH_SECRET, Date.now(), payload), fresh), 200, payload);
      assert.deepEqual(body, NOT_PUBLISHED, payload);
    }
    // Unsigned, it learns nothing of the state either.
    assert.deepEqual(await answer(await post("{}", fresh), 401, "unsigned, unpublished"), UNAUTHORIZED);

    assert.deepEqual(await snapshot(fresh.db), was, "a request before the first publish wrote to D1");
    assert.equal(outboundRequests.length, calls, "the route called out of the Worker");

    // The first publish turns the answer into the view.
    const { version } = await replaceCatalog(fresh.db, expectedCatalog(), { now: Date.now(), source: "sheet" });
    assert.equal(version, 1);
    const view = (await answer(await post(signedBody(), fresh), 200, "after the first publish")) as View;
    assert.equal(view.ok, true);
    assert.equal(view.version, 1);
    assert.deepEqual(view.models.find((m) => m.id === "pcx-125")?.plates, [
      { plate: "わ1002", status: "active" },
      { plate: "わ1003", status: "maintenance" },
    ]);
    // The model written by hand is kept by the publish as an inactive model, and listed as one.
    assert.equal(view.models.find((m) => m.id === model.id)?.active, false);
  } finally {
    await fresh.stop();
  }
});

test("unsigned, tampered and stale requests get 401", async () => {
  const was = await snapshot(worker.db);
  const calls = outboundRequests.length;

  const now = Date.now();
  const good = JSON.parse(signedBody(testVars.PUBLISH_SECRET, now)) as { ts: number; payload: string; sig: string };
  const bodies: [string, string | undefined][] = [
    ["no body", undefined],
    ["an empty body", ""],
    ["not JSON", "catalog please"],
    ["an empty object", "{}"],
    ["a payload with no signature", JSON.stringify({ ts: now, payload: PAYLOAD })],
    ["a ts that is a string", JSON.stringify({ ...good, ts: String(now) })],
    ["signed with another secret", signedBody("not-the-publish-secret", now)],
    ["signed with the mail secret", signedBody(testVars.MAIL_SECRET, now)],
    ["signed with the empty secret", signedBody("", now)],
    ["a payload changed after signing", JSON.stringify({ ...good, payload: '{"requestedBy":"someone-else"}' })],
    ["a timestamp changed after signing", JSON.stringify({ ...good, ts: now + 1 })],
    ["a signature cut short", JSON.stringify({ ...good, sig: good.sig.slice(0, 32) })],
    ["a signature with one character changed", JSON.stringify({ ...good, sig: `${good.sig[0] === "0" ? "1" : "0"}${good.sig.slice(1)}` })],
    ["an empty signature", JSON.stringify({ ...good, sig: "" })],
    ["signed too long ago", signedBody(testVars.PUBLISH_SECRET, now - TEN_MINUTES_MS)],
    ["signed in the future", signedBody(testVars.PUBLISH_SECRET, now + TEN_MINUTES_MS)],
  ];
  for (const [label, body] of bodies) {
    assert.deepEqual(await answer(await post(body), 401, label), UNAUTHORIZED, label);
  }

  assert.deepEqual(await snapshot(worker.db), was, "a refused request wrote to D1");
  assert.equal(outboundRequests.length, calls, "a refused request called out of the Worker");
  await assertAnswers("signed properly, after the refusals");
});

/** A good envelope of exactly `bytes`, padded with `filler`, and then with "x" where the filler no longer fits. */
function sized(bytes: number, filler: string, secret = testVars.PUBLISH_SECRET): string {
  const ts = Date.now();
  const padded = (padding: string) => signedBody(secret, ts, JSON.stringify({ requestedBy: padding }));
  const room = bytes - Buffer.byteLength(padded(""));
  const count = Math.floor(room / Buffer.byteLength(filler));
  const body = padded(filler.repeat(count) + "x".repeat(room - count * Buffer.byteLength(filler)));
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}

function tampered(body: string): string {
  const parsed = JSON.parse(body) as { ts: number; payload: string; sig: string };
  return JSON.stringify({ ...parsed, sig: `${parsed.sig[0] === "0" ? "1" : "0"}${parsed.sig.slice(1)}` });
}

// Miniflare's fetch sends a body as Transfer-Encoding: chunked unless the request names a Content-Length, so the limit is
// tried both ways, and as a stream of small chunks that end inside the multi-byte filler.
function postWithLength(body: string): Promise<Response> {
  const headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
  return worker.fetch(PATH, { method: "POST", headers, body });
}

function streamed(body: string): Promise<Response> {
  const bytes = Buffer.from(body);
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes.subarray(at, at + 1000));
      at += 1000;
      if (at >= bytes.length) controller.close();
    },
  });
  const headers = { "content-type": "application/json" };
  return worker.fetch(PATH, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
}

const SENDS: [how: string, send: (body: string) => Promise<Response>][] = [
  ["as a string", (body) => post(body)],
  ["with a Content-Length", postWithLength],
  ["as a stream with no Content-Length", streamed],
];

/** The caller has proved nothing, and what workerd throws for an empty key names it. */
const CRYPTO_DETAIL = /DataError|HMAC|importKey|key length/i;

/** What the Worker answers for a throw the route lets escape, from a real one: catalog_meta gone. */
async function uncaughtAnswer(): Promise<{ status: number; text: string }> {
  await worker.db.prepare("ALTER TABLE catalog_meta RENAME TO catalog_meta_gone").run();
  try {
    const res = await post(signedBody());
    return { status: res.status, text: await res.text() };
  } finally {
    await worker.db.prepare("ALTER TABLE catalog_meta_gone RENAME TO catalog_meta").run();
  }
}

test("a body over 64 KB gets 413 and an empty PUBLISH_SECRET gets 500", async () => {
  const was = await snapshot(worker.db);
  const calls = outboundRequests.length;

  // Signed, so only the limit can refuse them.
  for (const filler of ["x", "沖"]) {
    for (const size of [LIMIT_BYTES + 1, 70_000, 100_000]) {
      for (const [how, send] of SENDS) {
        const label = `${size} bytes of "${filler}" padding ${how}`;
        // The Worker stops reading a stream it refuses, so the end of the upload can fail before the answer arrives.
        const res = await send(sized(size, filler)).catch((error: Error) => {
          assert.equal(send, streamed, `${label}: ${error.message}`);
          return null;
        });
        if (res !== null) {
          const text = await res.text();
          assert.equal(res.status, 413, `${label}: ${text.slice(0, 200)}`);
        }
      }
    }
  }

  // Anyone can send these: the limit comes before the signature, so they are 413 and not 401.
  const UNSIGNED: [string, string | Buffer<ArrayBuffer>][] = [
    ["junk", "x".repeat(70_000)],
    ["junk that is not UTF-8", Buffer.alloc(70_000, 0xff)],
    ["a broken signature", tampered(sized(70_000, "x"))],
  ];
  for (const [label, body] of UNSIGNED) {
    const res = await post(body);
    await res.text();
    assert.equal(res.status, 413, label);
  }

  // At the limit the body is still read: signed, it gets the view, and with a broken signature a 401.
  for (const filler of ["x", "沖"]) {
    for (const [how, send] of SENDS) {
      const label = `"${filler}" padding ${how}, at the limit`;
      assertView(await answer(await send(sized(LIMIT_BYTES, filler)), 200, label), publishedVersion, label);
      assert.deepEqual(await answer(await send(tampered(sized(LIMIT_BYTES, filler))), 401, label), UNAUTHORIZED);
    }
  }

  assert.deepEqual(await snapshot(worker.db), was, "a request about the limit wrote to D1");
  assert.equal(outboundRequests.length, calls, "a request about the limit called out of the Worker");

  // The answer of a throw the route does not catch, to tell the route's own 500 from it.
  const uncaught = await uncaughtAnswer();
  assert.equal(uncaught.status, 500, `a throw in the route: ${uncaught.text.slice(0, 200)}`);
  await assertAnswers("after the uncaught throw");

  const ENVELOPES: [string, () => string][] = [
    ["the signature anyone can compute for an empty secret", () => signedBody("")],
    ["the same signature, stale", () => signedBody("", Date.now() - TEN_MINUTES_MS)],
    ["the signature for the word undefined", () => signedBody("undefined")],
    ["the signature a healthy Worker takes", () => signedBody(testVars.PUBLISH_SECRET)],
    ["an empty sig", () => JSON.stringify({ ...(JSON.parse(signedBody("")) as object), sig: "" })],
  ];
  const SECRETS: [string, string | undefined][] = [
    ["empty", ""],
    ["unset", undefined],
  ];
  for (const [name, secret] of SECRETS) {
    const unset = await startWorker({ vars: { PUBLISH_SECRET: secret }, outbound });
    try {
      await publishTwice(unset.db);
      const unsetState = await snapshot(unset.db);
      const unsetCalls = outboundRequests.length;
      for (const [how, body] of ENVELOPES) {
        const label = `${name} PUBLISH_SECRET, ${how}`;
        const res = await post(body(), unset);
        const text = await res.text();
        assert.equal(res.status, 500, `${label}: ${text.slice(0, 200)}`);
        assert.notEqual(text, uncaught.text, `${label}: the route let the error escape instead of answering it`);
        assert.doesNotMatch(text, CRYPTO_DETAIL, label);
        assert.doesNotMatch(text, /エヌボックス|pcx-125|わ100/, `${label}: the catalog was answered`);
      }
      assert.deepEqual(await snapshot(unset.db), unsetState, `${name}: a request wrote to D1`);
      assert.equal(outboundRequests.length, unsetCalls, `${name}: a request called out of the Worker`);
    } finally {
      await unset.stop();
    }
  }
});
