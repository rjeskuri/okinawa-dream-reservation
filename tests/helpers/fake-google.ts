// The Google endpoints behind src/lib/google/sheets.ts, for `outbound` in tests/helpers/worker.ts: the service account's
// token exchange and the Sheets batchGet, batchUpdate and append, all answered from a FakeSheets. E2e tests can then
// assert on the cells that end up in the grid, as the unit tests do. Run against the real client, this speaks its wire
// format: a batchGet comes back with each range's tab, and with no `values` for an empty range.
import type { FakeSheets } from "./fake-sheets.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
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
