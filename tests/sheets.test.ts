// The Sheets client: URLs, request bodies, how batchGet keys its result, and the retry policy. A fake fetch plays
// Google from a script of replies shaped like the API's, where a response range carries the tab, quoted where A1
// notation needs it. Expected values are written out here, and `sleep` and `random` are injected wherever a call can
// retry, so nothing really waits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { createSheetsClient, SheetsError } from "../src/lib/google/sheets.ts";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEET_ID = "1aBcD-eFgH_iJkLmNoPqRsTuVwXyZ0123456789";
const OTHER_SHEET_ID = "9zYxW-vUtS_rQpOnMlKjIhGfEdCbA9876543210";
const TOKEN = "ya29.test-bearer-token";

type Client = ReturnType<typeof createSheetsClient>;
type Reply = { status: number; body: string; retryAfter?: string };
type SentRequest = {
  url: URL;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
};
type SetupOptions = { draws?: number[]; spreadsheetId?: string };

function ok(json: unknown = {}): Reply {
  return { status: 200, body: JSON.stringify(json) };
}

function fail(status: number, retryAfter?: string): Reply {
  const body = JSON.stringify({ error: { code: status, message: "The fake says no.", status: "FAILED" } });
  return { status, body, retryAfter };
}

const SUCCESS = ok({ valueRanges: [{ range: "Config!A1:B2", values: [["key", "value"]] }] });
const SUCCESS_VALUES = { Config: [["key", "value"]] };

// One call of each method, so the retry rules are proved on reads and writes alike.
const OPERATIONS: [string, (client: Client) => Promise<unknown>][] = [
  ["batchGet", (client) => client.batchGet(["Config"])],
  ["batchUpdate", (client) => client.batchUpdate([{ range: "Config!C2", values: [["ok"]] }])],
  ["append", (client) => client.append("Log!A1", [["published", 3]])],
];

// What `random` returns for each delay in turn: high then low at every step, and both ends of [0, 1).
const DRAW_SEQUENCES = [
  [0.9, 0.1, 0.9, 0.1],
  [0.1, 0.9, 0.1, 0.9],
  [0, 0.999, 0, 0.999],
  [0.999, 0, 0.999, 0],
  [0, 0, 0, 0],
  [0.999, 0, 0, 0],
  [0.5, 0.5, 0.5, 0.5],
  [0.999, 0.999, 0.999, 0.999],
];

// `onRequest` hears of each request as it starts, with the number of requests before it.
function scriptedFetch(replies: Reply[], onRequest: (earlier: number) => void = () => {}) {
  const requests: SentRequest[] = [];
  // A function and not an arrow, so that it can see `this`. The real fetch throws "Illegal invocation" in workerd when it
  // is called as a method, like `opts.fetch(...)`, and these tests are the only place that shows before the e2e of #15.
  const fetchFake: typeof fetch = async function (this: unknown, input, init) {
    assert.ok(this === undefined || this === globalThis, "the injected fetch must be called unbound");
    onRequest(requests.length);
    const request = new Request(input, init);
    requests.push({
      url: new URL(request.url),
      method: request.method,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body: await request.text(),
    });
    const reply = replies[requests.length - 1];
    if (reply === undefined) {
      throw new Error(`request ${requests.length} is past the end of the script`);
    }
    const headers = reply.retryAfter === undefined ? undefined : { "Retry-After": reply.retryAfter };
    return new Response(reply.body, { status: reply.status, headers });
  };
  return { fetch: fetchFake, requests };
}

function setup(replies: Reply[], options: SetupOptions = {}) {
  const sleeps: number[] = [];
  const finished = { sleeps: 0 };
  // A setup serves one client call, so every request but the first follows one whole sleep, backoff or Retry-After. The
  // delays are recorded when sleep is called, so without this count a sleep nobody awaits looks just like a real wait.
  const { fetch: fetchFake, requests } = scriptedFetch(replies, (earlier) => {
    assert.equal(finished.sleeps, earlier, `request ${earlier + 1} went out before the sleep ahead of it finished`);
  });
  // Each call of `random` takes the next draw, starting over past the end so that a count can tell what went wrong.
  const draws = options.draws ?? [0.5];
  const drawn = { count: 0 };
  const client = createSheetsClient({
    getToken: async () => TOKEN,
    fetch: fetchFake,
    spreadsheetId: options.spreadsheetId ?? SHEET_ID,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      // A turn of the event loop, which an unawaited sleep does not get before the next request starts.
      await new Promise<void>((resolve) => setImmediate(resolve));
      finished.sleeps += 1;
    },
    random: () => {
      const draw = draws[drawn.count % draws.length];
      drawn.count += 1;
      return draw;
    },
  });
  return { client, requests, sleeps, drawn };
}

const FOUR_FAILURES = [503, 429, 503, 429];

/** The delays of four failures in a row when no reply says how long to wait, given the draws of `random` in order. */
async function plainBackoff(draws?: number[]): Promise<number[]> {
  const { client, sleeps } = setup([...FOUR_FAILURES.map((status) => fail(status)), SUCCESS], { draws });
  await client.batchGet(["Config"]);
  return sleeps;
}

/** Four positive delays in milliseconds, each longer than the one before it. No multiplier is implied. */
function assertGrowing(delays: number[], label: string): void {
  assert.equal(delays.length, 4, label);
  for (const delay of delays) {
    assert.ok(Number.isFinite(delay) && delay > 0, `${label}: ${delays}`);
  }
  assert.ok(Math.max(...delays) >= 100, `${label}: ${delays} look like seconds, and sleep takes milliseconds`);
  for (const [i, delay] of delays.slice(1).entries()) {
    assert.ok(delay > delays[i], `${label}: ${delays} do not grow`);
  }
}

/** At least the header's wait, whether the code adds its backoff or jitter on top or not. */
function assertWaits(delay: number, seconds: number, label: string): void {
  assert.ok(delay >= seconds * 1000 && delay < seconds * 2000, `${label}: slept ${delay} for a ${seconds} s wait`);
}

function errorViews(error: Error): string[] {
  return [
    error.message,
    String(error),
    error.stack ?? "",
    inspect(error, { depth: null, showHidden: true }),
    JSON.stringify(error) ?? "",
  ];
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to reject");
}

async function assertSheetsError(promise: Promise<unknown>, status: number, label: string): Promise<SheetsError> {
  const error = await rejection(promise);
  assert.ok(error instanceof SheetsError, `${label}: got ${String(error)}`);
  assert.ok(error instanceof Error, label);
  assert.equal(error.status, status, label);
  return error;
}

/** A bare tab name may go out quoted or not; a range that ends in cells is sent as given. */
function unquoted(range: string): string {
  return range.replace(/^'(.*)'$/, "$1");
}

function rowsFor(i: number): unknown[][] {
  return [["id", "price_jpy", "active", "starts"], [`row-${i}`, 1500 + i, i % 2 === 0, 46_000.25 + i], [""], []];
}

test("batchGet fetches all ranges in one request and keys them by tab", async () => {
  // [what the caller asks for, the range Google answers with, the tab name]. Task #15 asks for bare names.
  const tabs: [string, string, string][] = [
    ["Config", "Config!A1:Z1000", "Config"],
    ["ClosedDates", "ClosedDates!A1:C40", "ClosedDates"],
    ["Rate Classes", "'Rate Classes'!A1:Z1000", "Rate Classes"],
    ["'Vehicle Types'!A1:Z", "'Vehicle Types'!A1:Z1000", "Vehicle Types"],
    ["料金表", "料金表!A1:Z1000", "料金表"],
    ["'料金 プラン'!B2:D", "'料金 プラン'!B2:D9", "料金 プラン"],
    ["'Bob''s Bikes'!A:C", "'Bob''s Bikes'!A1:C40", "Bob's Bikes"],
    ["'Q&A +#1'!A1:B2", "'Q&A +#1'!A1:B2", "Q&A +#1"],
    ["'Sale!'!A1:B2", "'Sale!'!A1:B2", "Sale!"],
    ["Config!A1:B2", "Config!A1:B2", "Config"],
  ];
  // The first and last rows read one tab, which a result keyed by tab cannot hold twice, so they never share a request.
  const subsets = [...tabs.map((row) => [row]), tabs.slice(0, 2), tabs.slice(2, 5), tabs.slice(0, -1), tabs.slice(1)];

  for (const [i, subset] of subsets.entries()) {
    const asked = subset.map(([range]) => range);
    const label = asked.join(", ");
    const spreadsheetId = i % 2 === 0 ? SHEET_ID : OTHER_SHEET_ID;
    const valueRanges = subset.map(([, range], j) => ({ range, majorDimension: "ROWS", values: rowsFor(j) }));
    const { client, requests, sleeps } = setup([ok({ spreadsheetId, valueRanges })], { spreadsheetId });

    const result = await client.batchGet(asked);

    assert.deepEqual({ ...result }, Object.fromEntries(subset.map(([, , tab], j) => [tab, rowsFor(j)])), label);
    assert.equal(requests.length, 1, label);
    assert.deepEqual(sleeps, [], label);
    const [{ url, method, authorization }] = requests;
    assert.equal(method, "GET", label);
    assert.equal(authorization, `Bearer ${TOKEN}`, label);
    assert.equal(`${url.origin}${url.pathname}`, `${API}/${spreadsheetId}/values:batchGet`, label);
    assert.equal(url.hash, "", label);
    const sent = url.searchParams.getAll("ranges");
    assert.equal(sent.length, asked.length, label);
    for (const [j, range] of asked.entries()) {
      assert.equal(range.includes("!") ? sent[j] : unquoted(sent[j]), range, label);
    }
    assert.equal(url.searchParams.get("valueRenderOption"), "UNFORMATTED_VALUE", label);
    assert.equal(url.searchParams.get("dateTimeRenderOption"), "SERIAL_NUMBER", label);
  }
});

test("batchGet keys each value range by its own tab, in any order, and an empty tab gives []", async () => {
  const asked = ["Config", "Types", "Models"];
  const ranges = ["Config!A1:Z1000", "Types!A1:Z1000", "Models!A1:Z1000"];
  const expected = { Config: rowsFor(0), Types: rowsFor(1), Models: rowsFor(2) };

  for (const order of [[2, 1, 0], [1, 2, 0], [2, 0, 1], [0, 2, 1]]) {
    const valueRanges = order.map((i) => ({ range: ranges[i], values: rowsFor(i) }));
    const { client } = setup([ok({ valueRanges })]);
    assert.deepEqual({ ...(await client.batchGet(asked)) }, expected, `order ${order}`);
  }

  // Google leaves `values` out of a tab with no cells.
  for (const [empty, tab] of asked.entries()) {
    const valueRanges = ranges.map((range, i) => (i === empty ? { range } : { range, values: rowsFor(i) }));
    const { client } = setup([ok({ valueRanges })]);
    assert.deepEqual({ ...(await client.batchGet(asked)) }, { ...expected, [tab]: [] }, `${tab} empty`);
  }
});

test("batchUpdate and append send RAW values to the right URLs", async () => {
  const datasets: { range: string; values: unknown[][] }[][] = [
    [{ range: "Config!C2:C3", values: [["ok"], ["error: bad slug"]] }],
    [
      { range: "Types!H2:H4", values: [["ok"], [""], ["warning: no photo"]] },
      { range: "'Vehicle Types'!D2", values: [[1500, true, null]] },
    ],
    [
      { range: "A!B1", values: [["=SUM(A1:A9)", "'quoted", "沖縄 🛵"]] },
      { range: "B!C2", values: [[0, false, ""]] },
      { range: "C!D3", values: [[]] },
    ],
  ];
  for (const [i, data] of datasets.entries()) {
    const label = `batchUpdate of ${data.length} ranges`;
    const spreadsheetId = i % 2 === 0 ? SHEET_ID : OTHER_SHEET_ID;
    const { client, requests, sleeps } = setup([ok({ totalUpdatedCells: 3 })], { spreadsheetId });

    await client.batchUpdate(data);

    assert.equal(requests.length, 1, label);
    assert.deepEqual(sleeps, [], label);
    const [{ url, method, authorization, contentType, body }] = requests;
    assert.equal(method, "POST", label);
    assert.equal(authorization, `Bearer ${TOKEN}`, label);
    assert.equal(`${url.origin}${url.pathname}`, `${API}/${spreadsheetId}/values:batchUpdate`, label);
    assert.match(contentType ?? "", /^application\/json/i, label);
    assert.deepEqual(JSON.parse(body), { valueInputOption: "RAW", data }, label);
  }

  // The range is one path segment: / ? # and % would cut the URL short if they went out bare, while the : of :append
  // must stay a colon for Google to route it.
  const appends: [string, unknown[][]][] = [
    ["Log", [["published", 3, true, null]]],
    ["Log!A1", [[1], [2], [3]]],
    ["Bookings!A:Z", [["=1+1", "", "沖縄 🛵"]]],
    ["'Vehicle Types'!A1:Z", [[0, false]]],
    ["'料金 プラン'!A:D", [["税込", 1500]]],
    ["'Bob''s Bikes'!A1", [["x"]]],
    ["'Q&A?/#1'!A:B", [["y"]]],
    ["'100% real'!A1", [["z"]]],
  ];
  for (const [i, [range, rows]] of appends.entries()) {
    const spreadsheetId = i % 2 === 0 ? SHEET_ID : OTHER_SHEET_ID;
    const { client, requests, sleeps } = setup([ok({ updates: { updatedRows: rows.length } })], { spreadsheetId });

    await client.append(range, rows);

    assert.equal(requests.length, 1, range);
    assert.deepEqual(sleeps, [], range);
    const [{ url, method, authorization, contentType, body }] = requests;
    assert.equal(method, "POST", range);
    assert.equal(authorization, `Bearer ${TOKEN}`, range);
    assert.equal(url.origin, "https://sheets.googleapis.com", range);
    assert.equal(url.hash, "", range);
    const segments = url.pathname.split("/");
    assert.deepEqual(segments.slice(0, -1), ["", "v4", "spreadsheets", spreadsheetId, "values"], range);
    const last = segments.at(-1) ?? "";
    assert.ok(last.endsWith(":append"), `${range}: ${last}`);
    assert.equal(decodeURIComponent(last), `${range}:append`, range);
    assert.equal(url.searchParams.get("valueInputOption"), "RAW", range);
    assert.equal(url.searchParams.get("insertDataOption"), "INSERT_ROWS", range);
    assert.match(contentType ?? "", /^application\/json/i, range);
    assert.deepEqual(JSON.parse(body).values, rows, range);
  }
});

test("sleep and random are optional", async () => {
  // Only the success path, so the default sleep is never reached and nothing really waits.
  const { fetch: fetchFake, requests } = scriptedFetch([SUCCESS]);
  const client = createSheetsClient({ getToken: async () => TOKEN, fetch: fetchFake, spreadsheetId: SHEET_ID });
  assert.deepEqual({ ...(await client.batchGet(["Config"])) }, SUCCESS_VALUES);
  assert.equal(requests.length, 1);
});

test("every Sheets call sends the current bearer token", async () => {
  let issued = 0;
  const { fetch: fetchFake, requests } = scriptedFetch([SUCCESS, SUCCESS, SUCCESS, fail(503), SUCCESS]);
  const client = createSheetsClient({
    getToken: async () => {
      issued += 1;
      return `token-${issued}`;
    },
    fetch: fetchFake,
    spreadsheetId: SHEET_ID,
    sleep: async () => {},
    random: () => 0.5,
  });

  // The token can change between calls, so the client cannot keep the first one.
  for (const [i, [name, call]] of OPERATIONS.entries()) {
    await call(client);
    assert.equal(requests[i].authorization, `Bearer token-${issued}`, name);
  }
  assert.equal(new Set(requests.map(({ authorization }) => authorization)).size, 3);

  // A retry may ask getToken again or reuse the call's token, and either way sends one issued for this call.
  const before = issued;
  await client.batchGet(["Config"]);
  for (const { authorization } of requests.slice(3)) {
    const number = Number(authorization?.replace("Bearer token-", ""));
    assert.ok(number > before && number <= issued, `sent ${authorization}, issued ${before} then ${issued}`);
  }
});

test("429 and 503 are retried with backoff and Retry-After", async () => {
  for (const [name, call] of OPERATIONS) {
    for (const statuses of [
      [429, 503, 429, 503],
      [500, 502, 504, 599],
    ]) {
      for (const draws of DRAW_SEQUENCES) {
        const label = `${name}, ${statuses}, draws ${draws}`;
        const { client, requests, sleeps, drawn } = setup([...statuses.map((status) => fail(status)), SUCCESS], {
          draws,
        });
        await call(client);
        assert.equal(requests.length, 5, label);
        assertGrowing(sleeps, label);
        assert.equal(drawn.count, 4, `${label}: random is drawn once per delay`);
      }
    }

    // Longer than any delay the backoff gives, on either status and on a later attempt too.
    const wait = Math.ceil(Math.max(...(await plainBackoff())) / 1000) + 60;
    const waits: [number, number][] = [
      [wait, wait + 17],
      [wait + 300, wait + 1],
    ];
    for (const [first, second] of waits) {
      const label = `${name}, Retry-After ${first} then ${second}`;
      const { client, requests, sleeps } = setup([fail(429, String(first)), fail(503, String(second)), SUCCESS]);
      await call(client);
      assert.equal(requests.length, 3, label);
      assert.equal(sleeps.length, 2, label);
      assertWaits(sleeps[0], first, label);
      assertWaits(sleeps[1], second, label);
    }
  }
});

test("the backoff jitter comes from the injected random", async () => {
  const draws = [0.2, 0.2, 0.2, 0.2];
  const delays = await plainBackoff(draws);
  assert.deepEqual(await plainBackoff(draws), delays);

  // Each delay moves with its own draw, so one draw kept for the whole client does not do.
  for (const i of draws.keys()) {
    const moved = await plainBackoff(draws.with(i, 0.8));
    assert.notEqual(moved[i], delays[i], `delay ${i} ignored its draw: ${moved} against ${delays}`);
  }

  // No retry, no draw. The count follows the number of delays and not the number of clients or attempts.
  for (const failures of [0, 1, 2, 3, 4]) {
    const script = [...Array.from({ length: failures }, () => fail(503)), SUCCESS];
    const { client, sleeps, drawn } = setup(script);
    await client.batchGet(["Config"]);
    assert.equal(sleeps.length, failures);
    assert.equal(drawn.count, failures, `${failures} retries`);
  }
});

test("Retry-After as an HTTP date waits until that time", async (t) => {
  const now = Date.UTC(2026, 10, 2, 3, 4, 5);
  t.mock.timers.enable({ apis: ["Date"], now });

  for (const seconds of [90, 600]) {
    const header = new Date(now + seconds * 1000).toUTCString();
    const { client, sleeps } = setup([fail(429, header), SUCCESS]);
    await client.batchGet(["Config"]);
    assert.equal(sleeps.length, 1, header);
    assertWaits(sleeps[0], seconds, header);
  }

  const past = new Date(now - 60_000).toUTCString();
  const { client, sleeps } = setup([fail(503, past), SUCCESS]);
  await client.batchGet(["Config"]);
  assert.equal(sleeps.length, 1, past);
  assert.ok(sleeps[0] >= 0 && sleeps[0] < 60_000, `slept ${sleeps[0]} for a date in the past`);
});

test("Retry-After is honoured on every retried status", async (t) => {
  const now = Date.UTC(2026, 10, 2, 3, 4, 5);
  t.mock.timers.enable({ apis: ["Date"], now });

  for (const [name, call] of OPERATIONS) {
    for (const status of [429, 500, 502, 503, 504, 599]) {
      for (const seconds of [120, 600]) {
        for (const header of [String(seconds), new Date(now + seconds * 1000).toUTCString()]) {
          const label = `${name}, ${status}, Retry-After ${header}`;

          const first = setup([fail(status, header), SUCCESS]);
          await call(first.client);
          assert.equal(first.requests.length, 2, label);
          assert.equal(first.sleeps.length, 1, label);
          assertWaits(first.sleeps[0], seconds, label);

          const later = setup([fail(status), fail(status, header), SUCCESS]);
          await call(later.client);
          assert.equal(later.requests.length, 3, label);
          assert.equal(later.sleeps.length, 2, label);
          assertWaits(later.sleeps[1], seconds, `${label}, on the second retry`);
        }
      }
    }
  }
});

test("a Retry-After that cannot be read still gives a usable delay", async () => {
  // A header nobody can read says nothing, so the delays are those of the same failures with no header at all, draw for
  // draw and attempt for attempt. Zero does not do: that retry goes out at once.
  for (const header of ["soon", "", "-5", "NaN", "Infinity"]) {
    for (const draws of DRAW_SEQUENCES) {
      const expected = await plainBackoff(draws);
      for (const attempt of FOUR_FAILURES.keys()) {
        const label = `Retry-After "${header}" on failure ${attempt + 1}, draws ${draws}`;
        const failures = FOUR_FAILURES.map((status, i) => fail(status, i === attempt ? header : undefined));
        const { client, requests, sleeps } = setup([...failures, SUCCESS], { draws });
        await client.batchGet(["Config"]);
        assert.equal(requests.length, 5, label);
        assert.deepEqual(sleeps, expected, label);
      }
    }
  }
});

test("after 4 retries the call throws SheetsError with the last status", async () => {
  const sequences = [
    [429, 429, 429, 429, 429],
    [500, 500, 500, 500, 500],
    [502, 502, 502, 502, 502],
    [503, 503, 503, 503, 503],
    [504, 504, 504, 504, 504],
    [599, 599, 599, 599, 599],
    [503, 429, 500, 502, 504],
    [504, 502, 500, 429, 429],
    [429, 429, 429, 429, 503],
    [500, 429, 503, 504, 502],
  ];
  for (const [name, call] of OPERATIONS) {
    for (const statuses of sequences) {
      const label = `${name}, ${statuses}`;
      const { client, requests, sleeps } = setup(statuses.map((status) => fail(status)));
      await assertSheetsError(call(client), statuses[4], label);
      assert.equal(requests.length, 5, label);
      assert.equal(sleeps.length, 4, label);
    }
  }
});

test("a retry that succeeds returns the normal result and resends the same request", async () => {
  const failureRuns = [[429], [503, 429], [500, 502, 504], [429, 503, 500, 504]];
  for (const [name, call] of OPERATIONS) {
    for (const statuses of failureRuns) {
      const label = `${name}, after ${statuses}`;
      const { client, requests, sleeps } = setup([...statuses.map((status) => fail(status)), SUCCESS]);

      const result = await call(client);

      if (name === "batchGet") {
        assert.deepEqual({ ...(result as object) }, SUCCESS_VALUES, label);
      }
      assert.equal(requests.length, statuses.length + 1, label);
      assert.equal(sleeps.length, statuses.length, label);
      for (const request of requests) {
        assert.equal(request.url.href, requests[0].url.href, label);
        assert.equal(request.method, requests[0].method, label);
        assert.equal(request.body, requests[0].body, label);
      }
      assert.equal(requests[0].body !== "", name !== "batchGet", label);
    }
  }
});

test("400 is not retried", async () => {
  for (const [name, call] of OPERATIONS) {
    for (const status of [400, 401, 403, 404, 405, 408, 409, 413, 422, 425, 428, 431, 499]) {
      const label = `${name}, ${status}`;
      const { client, requests, sleeps } = setup([fail(status)]);
      await assertSheetsError(call(client), status, label);
      assert.equal(requests.length, 1, label);
      assert.deepEqual(sleeps, [], label);
    }

    // Retry-After does not make a 400 retryable.
    const withHeader = setup([fail(400, "5")]);
    await assertSheetsError(call(withHeader.client), 400, `${name}, Retry-After on a 400`);
    assert.equal(withHeader.requests.length, 1, name);
    assert.deepEqual(withHeader.sleeps, [], name);

    // A 4xx ends the retries as well.
    const midway = setup([fail(503), fail(429), fail(403)]);
    await assertSheetsError(call(midway.client), 403, `${name}, 403 after two retries`);
    assert.equal(midway.requests.length, 3, name);
    assert.equal(midway.sleeps.length, 2, name);
  }
});

test("Sheets errors do not carry the bearer token", async () => {
  const google = (status: number, message: string) =>
    JSON.stringify({ error: { code: status, message, status: "UNAUTHENTICATED" } });
  // Bodies that quote the token are the reason a raw body, or Google's error.message, cannot go into the error as it
  // came. Some quote it bare, so taking out only what follows the word Bearer does not do either.
  const bodies: [string, (status: number) => string][] = [
    ["JSON quoting the token", (status) => google(status, `Invalid token ${TOKEN}.`)],
    ["JSON quoting the header", (status) => google(status, `Refused Authorization: Bearer ${TOKEN}`)],
    ["text quoting the token", () => `upstream refused token ${TOKEN}`],
    ["text quoting the header", () => `upstream refused Authorization: Bearer ${TOKEN}`],
  ];
  // [status, requests it takes to give up]: one when it is not retried, five when the retries run out.
  const outcomes: [number, number][] = [
    [400, 1],
    [401, 1],
    [403, 1],
    [404, 1],
    [429, 5],
    [500, 5],
    [503, 5],
  ];

  for (const [name, call] of OPERATIONS) {
    for (const [status, attempts] of outcomes) {
      for (const [kind, body] of bodies) {
        const label = `${name}, ${status}, ${kind}`;
        const reply = { status, body: body(status) };
        const { client, requests } = setup(Array.from({ length: attempts }, () => reply));

        const error = await assertSheetsError(call(client), status, label);

        assert.equal(requests.length, attempts, label);
        for (const view of errorViews(error)) {
          assert.equal(view.includes(TOKEN), false, `${label}: the error carries the token`);
        }
      }
    }
  }
});
