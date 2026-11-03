// Two fakes of the Google endpoints, for `outbound` in tests/helpers/worker.ts. A test picks the one it needs.
//
// fakeGoogle serves a workbook the way values.batchGet does, records what comes back through values:batchUpdate, and holds
// a service account of its own: the token endpoint checks the assertion against GOOGLE_PRIVATE_KEY's public half, and
// Sheets refuses any bearer but GOOGLE_TOKEN.
//
// fakeGoogleSheets is the service account's token exchange and the Sheets batchGet, batchUpdate and append, all answered
// from a FakeSheets. E2e tests can then assert on the cells that end up in the grid, as the unit tests do. Run against the
// real client, this speaks its wire format: a batchGet comes back with each range's tab, and with no `values` for an empty
// range.
import { generateKeyPairSync, verify } from "node:crypto";
import type { FakeSheets } from "./fake-sheets.ts";
import type { StatusWrite, Workbook } from "./sheet-workbook.ts";
import { testVars } from "./worker.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_URL = `https://sheets.googleapis.com/v4/spreadsheets/${testVars.GOOGLE_SHEET_ID}`;

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** Pass as the Worker's GOOGLE_SA_PRIVATE_KEY. */
export const GOOGLE_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

export const GOOGLE_TOKEN = "ya29.fake-token-issued-by-the-test";

export type Fault = () => Response;

export type FakeGoogle = ReturnType<typeof fakeGoogle>;

/** A fake that serves `workbook` as it stands at each call. A fault replaces the normal answer to that call. */
export function fakeGoogle(workbook: Workbook) {
  const google = {
    faults: {} as { token?: Fault; batchGet?: Fault; batchUpdate?: Fault },
    /** Every outbound request, whatever it was for. */
    requests: [] as string[],
    batchGets: [] as string[][],
    batchUpdates: [] as StatusWrite[][],
    outbound,
  };

  async function exchangeToken(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
    const signed = Buffer.from(`${header}.${claims}`);
    if (!verify("RSA-SHA256", signed, publicKey, Buffer.from(signature ?? "", "base64url"))) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({ access_token: GOOGLE_TOKEN, expires_in: 3600, token_type: "Bearer" });
  }

  function batchGet(url: URL): Response {
    const tabs = url.searchParams.getAll("ranges").map((range) => range.replace(/^'(.*)'$/, "$1"));
    google.batchGets.push(tabs);
    if (google.faults.batchGet) return google.faults.batchGet();
    return Response.json({
      spreadsheetId: testVars.GOOGLE_SHEET_ID,
      valueRanges: tabs.map((tab) => ({ range: `${tab}!A1:Z1000`, majorDimension: "ROWS", values: workbook[tab] })),
    });
  }

  async function batchUpdate(request: Request): Promise<Response> {
    const { data } = (await request.json()) as { data: StatusWrite[] };
    google.batchUpdates.push(data);
    if (google.faults.batchUpdate) return google.faults.batchUpdate();
    return Response.json({ spreadsheetId: testVars.GOOGLE_SHEET_ID });
  }

  async function outbound(request: Request): Promise<Response> {
    google.requests.push(`${request.method} ${request.url}`);
    if (request.url === TOKEN_URL) {
      return google.faults.token ? google.faults.token() : exchangeToken(request);
    }
    if (request.headers.get("authorization") !== `Bearer ${GOOGLE_TOKEN}`) {
      return Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
    }
    const url = new URL(request.url);
    if (`${url.origin}${url.pathname}` === `${SHEETS_URL}/values:batchGet`) return batchGet(url);
    if (`${url.origin}${url.pathname}` === `${SHEETS_URL}/values:batchUpdate`) return batchUpdate(request);
    return new Response("no such fake", { status: 404 });
  }

  return google;
}

const SHEETS_ORIGIN = "https://sheets.googleapis.com";
const TOKEN = "e2e-sheets-token";

/**
 * `sheet` is read on each request, so a test can put a new sheet in place between requests. So is `batchUpdateDown`: while
 * it says so, every batchUpdate gets a 503 and the sheet does not hear of it.
 */
export function fakeGoogleSheets(
  sheet: () => FakeSheets,
  spreadsheetId: string,
  batchUpdateDown: () => boolean = () => false,
): (request: Request) => Promise<Response> {
  const values = `/v4/spreadsheets/${spreadsheetId}/values`;

  async function answer(request: Request, url: URL): Promise<Response | null> {
    if (request.method === "GET" && url.pathname === `${values}:batchGet`) {
      const tabs = await sheet().batchGet(url.searchParams.getAll("ranges"));
      const valueRanges = Object.entries(tabs).map(([tab, rows]) => ({
        range: `'${tab.replaceAll("'", "''")}'!A1:ZZ`,
        ...(rows.length > 0 ? { values: rows } : {}),
      }));
      return Response.json({ spreadsheetId, valueRanges });
    }
    if (request.method === "POST" && url.pathname === `${values}:batchUpdate`) {
      // The client retries a 503 four times. The header makes that four seconds instead of up to 22 of backoff.
      if (batchUpdateDown()) return new Response("the service is unavailable", { status: 503, headers: { "Retry-After": "1" } });
      const { data } = (await request.json()) as { data: { range: string; values: unknown[][] }[] };
      await sheet().batchUpdate(data);
      return Response.json({ spreadsheetId });
    }
    const append = request.method === "POST" && url.pathname.startsWith(`${values}/`) && url.pathname.endsWith(":append");
    if (append) {
      const range = decodeURIComponent(url.pathname.slice(values.length + 1, -":append".length));
      const { values: rows } = (await request.json()) as { values: unknown[][] };
      await sheet().append(range, rows);
      return Response.json({ spreadsheetId });
    }
    return null;
  }

  return async (request) => {
    if (request.url === TOKEN_URL) return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });

    const url = new URL(request.url);
    if (url.origin !== SHEETS_ORIGIN) return new Response(`no fake for ${request.url}`, { status: 502 });
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no bearer token", { status: 401 });
    try {
      return (await answer(request, url)) ?? new Response(`no fake for ${request.url}`, { status: 502 });
    } catch (error) {
      // A 400, because the client backs off and retries a 5xx, and a bad range is a bug to report at once.
      return new Response(String(error), { status: 400 });
    }
  };
}
