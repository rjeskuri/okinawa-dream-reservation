// What a route that throws answers, through the built Worker: 500, whichever route it is, while a path nothing serves
// stays a 404. The throws are real ones, reached from outside: Google refusing in `outbound`, or a table a route reads
// renamed away in Miniflare's D1, and renamed back so that the same request can show it works again. Each test gets its
// own Worker, so a fault that outlives a failed assertion cannot reach another test.
//
// Rulings these tests pin where the ticket is silent:
// - A request for /500 itself is no page of the site, so it answers an error, 404 or 500, and never a locale page.
// - An error page can say what it likes, as long as it says it in nobody's locale layout and does not quote the failure.
//   So the body is checked for what a locale page has, and each of those marks is first seen on a healthy page.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { common } from "../../src/i18n/strings/common.ts";
import { t } from "../../src/i18n/t.ts";
import { BOOKINGS_COLUMNS } from "../../src/lib/catalog/sheet-schema.ts";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { LOCALES } from "../../src/lib/locale.ts";
import { fakeGoogleSheets, GOOGLE_PRIVATE_KEY } from "../helpers/fake-google.ts";
import { createFakeSheets } from "../helpers/fake-sheets.ts";
import { photoCatalog } from "../helpers/photos.ts";
import { startWorker, testVars, type TestWorker } from "../helpers/worker.ts";

const PHOTOS = "/api/publish/photos";
const ASSIGNMENTS = "/api/publish/assignments";
const MODEL = "route-errors-model";
const JSON_HEADERS = { "content-type": "application/json" };

/** What a failure says to the code that caught it, and nothing a guest or staff should be shown. */
const INTERNAL = /no such table|D1_ERROR|SQLITE|Drive request failed|\.mjs/i;

const SITE_NAMES = new Set(LOCALES.map((locale) => t(locale, common, "site.name")));

type Upstream = "token" | "drive" | "sheets";
type Site = { worker: TestWorker; refused: Set<Upstream> };
type Answer = { status: number; body: string };
type Fault = { name: string; during<T>(site: Site, run: () => Promise<T>): Promise<T> };

function upstreamOf(request: Request): Upstream {
  const { hostname } = new URL(request.url);
  if (hostname === "oauth2.googleapis.com") return "token";
  return hostname === "www.googleapis.com" ? "drive" : "sheets";
}

/** A Worker with a published catalog and a Google that answers until the test refuses a part of it. */
async function withSite(run: (site: Site) => Promise<void>): Promise<void> {
  const refused = new Set<Upstream>();
  // An override of no known booking: the assignments step reads D1 for it and has a row to report, so it gets to work.
  const cells: Record<string, string> = { booking_id: "no-such-booking", override_plate: "no-such-plate" };
  const row = BOOKINGS_COLUMNS.map((name) => cells[name] ?? "");
  const sheet = createFakeSheets({ Bookings: [[...BOOKINGS_COLUMNS], row] });
  const sheets = fakeGoogleSheets(() => sheet, testVars.GOOGLE_SHEET_ID);
  const worker = await startWorker({
    vars: { GOOGLE_SA_PRIVATE_KEY: GOOGLE_PRIVATE_KEY },
    outbound: (request) => {
      const upstream = upstreamOf(request);
      if (refused.has(upstream)) return new Response("refused by the test", { status: 403 });
      return upstream === "drive" ? Response.json({ files: [] }) : sheets(request);
    },
  });
  try {
    await replaceCatalog(worker.db, photoCatalog([{ id: MODEL, photos: ["front.jpg"] }]), {
      now: Date.now(),
      source: "sheet",
    });
    await run({ worker, refused });
  } finally {
    await worker.stop();
  }
}

/** Google refuses `upstream`. The token cache goes first, since a cached token never reaches the token endpoint. */
function refusing(name: string, upstream: Upstream): Fault {
  return {
    name,
    async during({ worker, refused }, run) {
      await worker.db.prepare("DELETE FROM kv_cache").run();
      refused.add(upstream);
      try {
        return await run();
      } finally {
        refused.delete(upstream);
      }
    },
  };
}

function tableGone(table: string): Fault {
  return {
    name: `the ${table} table gone`,
    async during({ worker }, run) {
      await worker.db.prepare(`ALTER TABLE ${table} RENAME TO ${table}_gone`).run();
      try {
        return await run();
      } finally {
        await worker.db.prepare(`ALTER TABLE ${table}_gone RENAME TO ${table}`).run();
      }
    },
  };
}

async function answer(worker: TestWorker, path: string, init?: RequestInit): Promise<Answer> {
  const res = await worker.fetch(path, { redirect: "manual", ...init });
  return { status: res.status, body: await res.text() };
}

/** The envelope the Apps Script sends: an HMAC-SHA256 in hex over `ts.payload`. */
function signedBody(): string {
  const ts = Date.now();
  const payload = '{"requestedBy":"staff@example.com"}';
  const sig = createHmac("sha256", testVars.PUBLISH_SECRET).update(`${ts}.${payload}`, "utf8").digest("hex");
  return JSON.stringify({ ts, payload, sig });
}

function signedPost(worker: TestWorker, path: string): Promise<Answer> {
  return answer(worker, path, { method: "POST", headers: JSON_HEADERS, body: signedBody() });
}

/** Which of the things every locale page has are in `body`. */
function localeMarks(body: string): string[] {
  return [
    ...[...SITE_NAMES].filter((name) => body.includes(name)),
    ...(/hreflang=/i.test(body) ? ["hreflang alternates"] : []),
    ...(/href="\/(?:ja|en|zh-cn|ko)\//i.test(body) ? ["links into a locale"] : []),
  ];
}

const ALL_MARKS = [...SITE_NAMES, "hreflang alternates", "links into a locale"];

function assertLocalePage({ status, body }: Answer, label: string): void {
  assert.equal(status, 200, label);
  assert.deepEqual(localeMarks(body), ALL_MARKS, label);
}

function assertBareError({ status, body }: Answer, label: string): void {
  assert.equal(status, 500, `${label}: ${body.slice(0, 200)}`);
  assert.deepEqual(localeMarks(body), [], `${label} rendered a locale page`);
  assert.doesNotMatch(body, INTERNAL, `${label} quotes the failure`);
}

/** The step works, fails on each fault, and works again, so what the 500 reports is that fault. */
async function assertStepFailsWith(path: string, faults: Fault[]): Promise<void> {
  await withSite(async (site) => {
    for (const fault of faults) {
      const label = `${path}, ${fault.name}`;
      const healthy = await signedPost(site.worker, path);
      assert.equal(healthy.status, 200, `${label}, before: ${healthy.body}`);

      const broken = await fault.during(site, () => signedPost(site.worker, path));
      assertBareError(broken, label);

      assert.equal((await signedPost(site.worker, path)).status, 200, `${label}, after`);
    }
  });
}

test("a throw in the photos step answers 500", async () => {
  await assertStepFailsWith(PHOTOS, [
    refusing("the Drive list refused", "drive"),
    refusing("the token refused", "token"),
    tableGone("closed_dates"),
    tableGone("photos"),
  ]);
});

test("a throw in the assignments step answers 500", async () => {
  // Green today through the route's own catch. It stays here for step 3 of the ticket, which removes that catch.
  await assertStepFailsWith(ASSIGNMENTS, [
    refusing("the sheet read refused", "sheets"),
    refusing("the token refused", "token"),
    tableGone("bookings"),
  ]);
});

test("a throw in a page route answers 500 and renders no locale page", async () => {
  const pages = [
    ...LOCALES.map((locale) => `/${locale}/`),
    "/ja/rentals",
    `/en/rentals/${MODEL}`,
    "/ko/rates",
    "/zh-cn/policies",
    "/ja/access",
  ];
  // Nothing serves these, whatever state D1 is in.
  const unknown = ["/nope", "/ja/nope", "/fr/", "/api/nope"];

  await withSite(async (site) => {
    const { worker } = site;
    for (const page of pages) assertLocalePage(await answer(worker, page), `${page}, before`);

    await tableGone("closed_dates").during(site, async () => {
      for (const page of pages) assertBareError(await answer(worker, page), page);
      for (const path of unknown) assert.equal((await answer(worker, path)).status, 404, `${path}, during the outage`);
    });

    for (const page of pages) assertLocalePage(await answer(worker, page), `${page}, after`);
  });
});

test("a throw in a locale route that is not a page answers 500", async () => {
  // A real model and a package nobody sells: the hold reads the catalog for both, and a healthy site sends the guest back.
  const book = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost" },
    body: `model=${MODEL}&package=no-such-package`,
  };
  await withSite(async (site) => {
    const { worker } = site;
    assert.equal((await answer(worker, "/ja/book", book)).status, 303, "before");

    const broken = await tableGone("packages").during(site, () => answer(worker, "/ja/book", book));
    assertBareError(broken, "POST /ja/book");

    assert.equal((await answer(worker, "/ja/book", book)).status, 303, "after");
  });
});

test("an unknown path stays 404 and a healthy page stays 200", async () => {
  const unknown = [
    "/nope",
    "/nope/",
    "/nope/deeper",
    "/ja/nope",
    "/ja/rentals/no-such-model",
    "/fr/",
    "/fr/nope",
    "/5000/",
    "/500/nope",
    "/500/rentals",
    "/404",
    "/404/",
    "/api/nope",
    "/api/publish/nope",
  ];
  await withSite(async ({ worker }) => {
    assertLocalePage(await answer(worker, "/ja/"), "/ja/");

    for (const path of unknown) assert.equal((await answer(worker, path)).status, 404, path);
    const post = { method: "POST", headers: JSON_HEADERS, body: signedBody() };
    assert.equal((await answer(worker, "/api/nope", post)).status, 404, "POST /api/nope");

    assertLocalePage(await answer(worker, "/ja/"), "/ja/, after them");
  });
});

test("a request for /500 itself is an error and no locale page", async () => {
  await withSite(async ({ worker }) => {
    assertLocalePage(await answer(worker, "/ja/"), "/ja/");
    for (const path of ["/500", "/500/"]) {
      const { status, body } = await answer(worker, path);
      assert.ok(status === 404 || status === 500, `${path} answered ${status}`);
      assert.deepEqual(localeMarks(body), [], path);
    }
  });
});
