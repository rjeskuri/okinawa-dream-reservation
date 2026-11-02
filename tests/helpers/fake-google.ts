// A fake Google for e2e tests, passed to startWorker as `outbound`. It serves a workbook the way values.batchGet does,
// records what comes back through values:batchUpdate, and holds a service account of its own: the token endpoint checks
// the assertion against GOOGLE_PRIVATE_KEY's public half, and Sheets refuses any bearer but GOOGLE_TOKEN.
import { generateKeyPairSync, verify } from "node:crypto";
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
