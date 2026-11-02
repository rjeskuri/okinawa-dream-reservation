// The Sheets API client: batchGet, batchUpdate and append, retrying 429 and 5xx with exponential backoff. The token and
// fetch are injected, so the file runs unchanged in Node and in Workers.

export type SheetsClient = {
  batchGet(tabs: string[]): Promise<Record<string, unknown[][]>>;
  batchUpdate(data: { range: string; values: unknown[][] }[]): Promise<void>;
  append(range: string, rows: unknown[][]): Promise<void>;
};

type SheetsClientOptions = {
  getToken: () => Promise<string>;
  fetch: typeof fetch;
  spreadsheetId: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

type SheetsRequest = { method: string; headers?: Record<string, string>; body?: string };

type ValueRange = { range: string; values?: unknown[][] };

const API = "https://sheets.googleapis.com/v4/spreadsheets";

const MAX_RETRIES = 4;

const BASE_DELAY_MS = 1000;

// All three HTTP date forms open with a day name and hold a time. Date.parse is no check by itself: V8 reads "-5" as a
// date, and skips unknown words in front of a number.
const HTTP_DATE = /^[A-Za-z]+,? .*\d{2}:\d{2}:\d{2}/;

/** Carries the HTTP status and nothing from the response body, which can quote the bearer token. */
export class SheetsError extends Error {
  readonly status: number;

  constructor(status: number, message = `Sheets request failed with status ${status}`) {
    super(message);
    this.name = "SheetsError";
    this.status = status;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** The header's wait in milliseconds, negative for a date in the past, or null when it cannot be read. */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  if (/^\d+$/.test(header)) {
    const ms = Number(header) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  // An HTTP date is always GMT, but the asctime form does not say so and Date.parse would take it as local time.
  const at = HTTP_DATE.test(header) ? Date.parse(header.endsWith("GMT") ? header : `${header} GMT`) : Number.NaN;
  return Number.isNaN(at) ? null : at - Date.now();
}

/** A wait already over says no more than no header does, so it takes the backoff rather than retrying at once. */
function delayMs(header: string | null, retries: number, random: () => number): number {
  const waitMs = retryAfterMs(header);
  if (waitMs !== null && waitMs > 0) return waitMs;
  return BASE_DELAY_MS * 2 ** retries * (1 + random() * 0.5);
}

/** Quotes a bare tab name, so that a tab called Q1 is not read as the cell Q1. Anything else is A1 notation already. */
function rangeOf(tab: string): string {
  return tab.includes("!") || /^'.*'$/.test(tab) ? tab : `'${tab.replaceAll("'", "''")}'`;
}

/** The tab of a response range such as `'Bob''s Bikes'!A1:C40`. A quoted name can hold a `!` of its own. */
function tabOf(range: string): string {
  const quoted = /^'((?:[^']|'')*)'/.exec(range);
  return quoted === null ? range.split("!")[0] : quoted[1].replaceAll("''", "'");
}

/** A 200 of any other shape throws rather than reading as an empty sheet, without the text JSON.parse would quote. */
function valueRangesIn(text: string): ValueRange[] {
  try {
    const { valueRanges } = JSON.parse(text);
    if (Array.isArray(valueRanges)) return valueRanges;
  } catch {
    // Falls through to the error below.
  }
  throw new SheetsError(200, "Sheets response has no valueRanges");
}

// `fetch` is destructured because workerd's throws "Illegal invocation" when it is called as `options.fetch(...)`.
export function createSheetsClient({
  getToken,
  fetch,
  spreadsheetId,
  sleep = wait,
  random = Math.random,
}: SheetsClientOptions): SheetsClient {
  const spreadsheet = `${API}/${spreadsheetId}`;

  async function send(url: string, request: SheetsRequest): Promise<string> {
    for (let retries = 0; ; retries += 1) {
      // Asked on every attempt, since a long Retry-After can outlast the token.
      const token = await getToken();
      const headers = { ...request.headers, Authorization: `Bearer ${token}` };
      const response = await fetch(url, { ...request, headers });
      // Read on a failure too, to free the connection. It never goes into an error: it can quote the token.
      const text = await response.text();
      if (response.ok) return text;
      if (!isRetryable(response.status) || retries === MAX_RETRIES) throw new SheetsError(response.status);
      await sleep(delayMs(response.headers.get("Retry-After"), retries, random));
    }
  }

  function post(url: string, payload: unknown): Promise<string> {
    const headers = { "Content-Type": "application/json" };
    return send(url, { method: "POST", headers, body: JSON.stringify(payload) });
  }

  return {
    async batchGet(tabs) {
      const ranges = tabs.map((tab) => `ranges=${encodeURIComponent(rangeOf(tab))}`).join("&");
      const options = "valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER";
      const text = await send(`${spreadsheet}/values:batchGet?${ranges}&${options}`, { method: "GET" });
      // Object.fromEntries defines own keys, so a tab called __proto__ is only a tab.
      return Object.fromEntries(valueRangesIn(text).map(({ range, values }) => [tabOf(range), values ?? []]));
    },

    async batchUpdate(data) {
      await post(`${spreadsheet}/values:batchUpdate`, { valueInputOption: "RAW", data });
    },

    async append(range, rows) {
      const url = `${spreadsheet}/values/${encodeURIComponent(range)}:append`;
      await post(`${url}?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
    },
  };
}
