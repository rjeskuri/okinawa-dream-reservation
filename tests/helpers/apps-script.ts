// Loads every apps-script/*.js into one node:vm context, the way Apps Script shares one global scope between files,
// with fakes of the Google services the script reaches. The context has no Node globals, so Buffer, fetch and
// TextEncoder are missing there as they are in Apps Script. Values crossing out of the context are copied into plain
// arrays, because an array built in another realm fails assert's deepEqual on its prototype.
// loadWebApp is the mail web app's side: each POST is a new execution, as on Google, sharing only what Google keeps.
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";

const SCRIPT_DIR = new URL("../../apps-script/", import.meta.url);

export type Reply = { status?: number; body?: unknown; throws?: string };

/** One reply for every call, one per round with the last repeating, or a function of the round counted from 0. */
export type Route = Reply | Reply[] | ((round: number) => Reply);

export type FetchCall = {
  url: string;
  path: string;
  method: unknown;
  contentType: unknown;
  payload: unknown;
  muteHttpExceptions: unknown;
};

export type FakeTab = { rows: unknown[][]; touches: string[] };

/** What addSeparator records in a menu's items, between the `[caption, functionName]` pairs. */
export const MENU_SEPARATOR = "---";

export type MenuEntry = [caption: string, functionName: string] | typeof MENU_SEPARATOR;

export type FakeMenu = { name: string; items: MenuEntry[]; added: boolean };

/** A sidebar or dialog the script showed: its title and HTML content, and its size when the output set one. */
export type Shown = {
  kind: "sidebar" | "modal" | "modeless";
  title: string;
  html: string;
  width?: number;
  height?: number;
};

export type Options = {
  /** getProperty answers null for a name left out, as Script Properties does. */
  properties?: Record<string, string>;
  user?: string;
  /** Thrown by getEmail, as a missing scope does. */
  userError?: string;
  tabs?: Record<string, unknown[][]>;
  timeZone?: string;
  routes?: Record<string, Route>;
  /** Someone else's execution holds the document lock for the whole run. */
  lockHeldElsewhere?: boolean;
  /** Replaces the digest, for checking the hex conversion on chosen bytes. */
  signatureBytes?: number[];
  /** What Google keeps between web app executions. Given, it also sets the time the script sees. */
  web?: WebState;
  /** Utilities.getUuid answers these in order, then uuid-1, uuid-2 and so on. */
  uuids?: string[];
};

export type CacheEntry = { value: string; expiresAt: number };

/** Google's state, and the time the script sees, moved by hand so that the 5-minute edge and 6-hour cache are exact. */
export type WebState = {
  now: number;
  /** MailApp.getRemainingDailyQuota, which a sent email lowers. */
  quota: number;
  /** The messages MailApp.sendEmail took, copied. */
  sent: Record<string, unknown>[];
  /** Calls to MailApp.sendEmail, the ones that threw included. */
  sendCalls: number;
  /** The next calls to MailApp.sendEmail throw these, one each. */
  sendFailures: string[];
  cache: Map<string, CacheEntry>;
};

export type WebAppOptions = {
  properties?: Record<string, string>;
  now: number;
  quota?: number;
  sendFailures?: string[];
};

export type WebReply = { text: string; mimeType: unknown };

export type WebApp = {
  state: WebState;
  /** A POST with this raw body. */
  post(body: string): WebReply;
  /** doPost with an event of the test's choosing, for a request that has no ordinary body. */
  deliver(event?: unknown): WebReply;
};

export type AppsScriptWorld = {
  /** Calls a global function of the script, as the menu does. */
  call(name: string, ...args: unknown[]): unknown;
  /** Whether the script defines a global function of this name, the lookup `call` makes. */
  isFunction(name: string): boolean;
  /**
   * Runs code in the script's global scope and answers a plain copy of its value. Top-level `const` and `let` live in
   * that scope without being properties of the global object, so this is how a test reads or extends one.
   */
  evaluate(code: string): unknown;
  fetches: FetchCall[];
  alerts: string[];
  menus: FakeMenu[];
  /** Every sidebar and dialog, in the order the script showed them. */
  shown: Shown[];
  tabs: Map<string, FakeTab>;
  /** Tab names in the order insertSheet created them. */
  inserted: string[];
  timeZone(): string;
  lock: { held(): boolean; timeouts: number[] };
};

/** The bytes as Apps Script returns them: signed, from -128 to 127. */
export function signedBytes(hex: string): number[] {
  return Array.from(new Int8Array(Buffer.from(hex, "hex")));
}

function encode(text: string, charset: unknown): Buffer {
  if (charset === "UTF_8") return Buffer.from(text, "utf8");
  // What Java's US-ASCII encoder does, and so what a call without UTF_8 signs for non-ASCII text.
  return Buffer.from(text.replace(/[^\x00-\x7f]/gu, "?"), "ascii");
}

/** Real HMAC-SHA256 over (value, key, charset), in the argument order of Utilities.computeHmacSha256Signature. */
export function hmacSignature(value: string, key: string, charset: unknown): number[] {
  return signedBytes(createHmac("sha256", encode(key, charset)).update(encode(value, charset)).digest("hex"));
}

/** Utilities.formatDate for the SimpleDateFormat letters a date or time needs. Any other letter throws, not guesses. */
export function formatDate(date: { getTime(): number }, timeZone: string, format: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date.getTime());
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const fields: Record<string, string> = {
    yyyy: field("year"),
    MM: field("month"),
    dd: field("day"),
    HH: field("hour"),
    mm: field("minute"),
    ss: field("second"),
  };
  // A run of one letter is one field, as in SimpleDateFormat, so `yyyyMMdd-HHmm` reads as five fields.
  return format.replace(/'[^']*'|([A-Za-z])\1*/g, (token) => {
    if (token.startsWith("'")) return token.slice(1, -1);
    if (fields[token] === undefined) throw new Error(`this fake's formatDate does not know ${token}`);
    return fields[token];
  });
}

function scriptFiles(): string[] {
  let names: string[];
  try {
    names = readdirSync(SCRIPT_DIR);
  } catch (error) {
    throw new Error(`apps-script/ cannot be read, so there is no script to test: ${String(error)}`);
  }
  const scripts = names.filter((name) => name.endsWith(".js")).sort();
  if (scripts.length === 0) throw new Error("apps-script/ holds no .js files, so there is no script to test");
  return scripts;
}

function replyTo(route: Route | undefined, round: number): Reply {
  if (route === undefined) return { status: 404, body: "no such route" };
  if (typeof route === "function") return route(round);
  if (Array.isArray(route)) return route[Math.min(round, route.length - 1)];
  return route;
}

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  return body === undefined ? "" : JSON.stringify(body);
}

/** The rectangle Google answers: every cell past the data is '', and a row that was never written is all ''. */
function rectangle(tab: FakeTab, row: number, column: number, numRows: number, numColumns: number): unknown[][] {
  return Array.from({ length: numRows }, (_, i) =>
    Array.from({ length: numColumns }, (_, j) => tab.rows[row - 1 + i]?.[column - 1 + j] ?? ""),
  );
}

function fakeRange(tab: FakeTab, row: number, column: number, numRows: number, numColumns: number) {
  const range = {
    getValues: () => rectangle(tab, row, column, numRows, numColumns),
    getValue: () => rectangle(tab, row, column, 1, 1)[0][0],
    setValue(value: unknown) {
      return range.setValues([[value]]);
    },
    setValues(values: ArrayLike<ArrayLike<unknown>>) {
      tab.touches.push("setValues");
      const copied = Array.from(values, (cells) => Array.from(cells));
      if (copied.length !== numRows || copied.some((cells) => cells.length !== numColumns)) {
        throw new Error("The data's size does not match the range's size");
      }
      copied.forEach((cells, i) => {
        const target = (tab.rows[row - 1 + i] ??= []);
        cells.forEach((cell, j) => {
          target[column - 1 + j] = cell;
        });
      });
      return range;
    },
    // Formatting changes no cell, but it is still a write: a tab that must stay untouched shows it in `touches`.
    setFontWeight() {
      tab.touches.push("setFontWeight");
      return range;
    },
    setFontSize() {
      tab.touches.push("setFontSize");
      return range;
    },
  };
  return range;
}

type FakeHtmlOutput = {
  getContent(): string;
  setContent(html: unknown): FakeHtmlOutput;
  append(html: unknown): FakeHtmlOutput;
  getTitle(): string;
  setTitle(title: unknown): FakeHtmlOutput;
  getWidth(): number | undefined;
  setWidth(width: unknown): FakeHtmlOutput;
  getHeight(): number | undefined;
  setHeight(height: unknown): FakeHtmlOutput;
  getSandboxMode(): unknown;
  setSandboxMode(mode: unknown): FakeHtmlOutput;
};

/** HtmlService's outputs. The set tells the Ui fake a real output from anything else handed to it. */
function fakeHtmlService(outputs: WeakSet<object>) {
  const createHtmlOutput = (html: unknown = ""): FakeHtmlOutput => {
    let content = String(html);
    let title = "";
    let width: number | undefined;
    let height: number | undefined;
    let sandboxMode: unknown = "IFRAME";
    const output: FakeHtmlOutput = {
      getContent: () => content,
      setContent(next) {
        content = String(next);
        return output;
      },
      append(more) {
        content += String(more);
        return output;
      },
      getTitle: () => title,
      setTitle(next) {
        title = String(next);
        return output;
      },
      getWidth: () => width,
      setWidth(next) {
        width = Number(next);
        return output;
      },
      getHeight: () => height,
      setHeight(next) {
        height = Number(next);
        return output;
      },
      getSandboxMode: () => sandboxMode,
      setSandboxMode(mode) {
        sandboxMode = mode;
        return output;
      },
    };
    outputs.add(output);
    return output;
  };

  return {
    SandboxMode: { IFRAME: "IFRAME", NATIVE: "NATIVE", EMULATED: "EMULATED" },
    XFrameOptionsMode: { ALLOWALL: "ALLOWALL", DEFAULT: "DEFAULT" },
    createHtmlOutput,
    /** Reads apps-script/<name>.html, named with or without its `.html`, as Apps Script names its HTML files. */
    createHtmlOutputFromFile(name: unknown) {
      const given = String(name);
      const file = given.endsWith(".html") ? given : `${given}.html`;
      if (!readdirSync(SCRIPT_DIR).includes(file)) throw new Error(`No HTML file named ${given} was found.`);
      return createHtmlOutput(readFileSync(new URL(file, SCRIPT_DIR), "utf8"));
    },
    createTemplate() {
      throw new Error("this fake has no HTML templates: build the HTML from getContent(), with no scriptlets");
    },
    createTemplateFromFile() {
      throw new Error("this fake has no HTML templates: build the HTML from getContent(), with no scriptlets");
    },
  };
}

function fakeTextOutput(initial: string) {
  let content = initial;
  let mimeType: unknown = "TEXT";
  const output = {
    getContent: () => content,
    getMimeType: () => mimeType,
    setContent(text: unknown) {
      content = String(text);
      return output;
    },
    append(text: unknown) {
      content += String(text);
      return output;
    },
    setMimeType(next: unknown) {
      mimeType = next;
      return output;
    },
  };
  return output;
}

function fakeMailApp(web: WebState) {
  return {
    getRemainingDailyQuota: () => web.quota,
    sendEmail(...args: unknown[]) {
      const [message] = args;
      if (args.length !== 1 || typeof message !== "object" || message === null) {
        throw new Error("this fake's sendEmail takes one message object");
      }
      web.sendCalls += 1;
      const failure = web.sendFailures.shift();
      if (failure !== undefined) throw new Error(failure);
      if (web.quota <= 0) throw new Error("Service invoked too many times for one day: email.");
      web.quota -= 1;
      web.sent.push({ ...message });
    },
  };
}

// CacheService's own limits: a value with no expiration lasts 10 minutes, and no value lasts past 6 hours. Keys have
// Google's documented limit, "The maximum length of a key is 250 characters", which the reference states on put and
// putAll and leaves unsaid for get and remove. This fake throws at all three: such a key can never have been stored, so
// a get answering null would read as "not seen yet" and a remove as done, each hiding the bug behind a quiet miss.
const CACHE_DEFAULT_SECONDS = 600;
const CACHE_MAX_SECONDS = 21_600;
const CACHE_MAX_KEY_LENGTH = 250;

function assertCacheKey(key: string): void {
  if (key.length > CACHE_MAX_KEY_LENGTH) {
    throw new Error(`The cache key has ${key.length} characters, over the limit of ${CACHE_MAX_KEY_LENGTH}`);
  }
}

function fakeCache(web: WebState) {
  return {
    get(key: string) {
      assertCacheKey(key);
      const entry = web.cache.get(key);
      return entry !== undefined && web.now < entry.expiresAt ? entry.value : null;
    },
    put(key: string, value: string, seconds: number = CACHE_DEFAULT_SECONDS) {
      assertCacheKey(key);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > CACHE_MAX_SECONDS) {
        throw new Error(`The cache expiration ${seconds} is outside 1 to ${CACHE_MAX_SECONDS} seconds`);
      }
      web.cache.set(key, { value: String(value), expiresAt: web.now + seconds * 1000 });
    },
    remove(key: string) {
      assertCacheKey(key);
      web.cache.delete(key);
    },
  };
}

// Run inside the context, so that both Date.now() and new Date() in the script read the test's clock.
const SCRIPT_CLOCK = `(clock) => {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock());
      else super(...args);
    }
    static now() {
      return clock();
    }
  };
}`;

function fakeSheet(name: string, tab: FakeTab) {
  const sheet = {
    getName: () => name,
    getLastRow: () => tab.rows.length,
    getLastColumn: () => Math.max(0, ...tab.rows.map((cells) => cells.length)),
    appendRow(cells: ArrayLike<unknown>) {
      tab.touches.push("appendRow");
      tab.rows.push(Array.from(cells));
      return sheet;
    },
    // Google answers A1 alone for an empty tab, and otherwise the rectangle from A1 to the last row and column.
    getDataRange: () => fakeRange(tab, 1, 1, Math.max(1, tab.rows.length), Math.max(1, sheet.getLastColumn())),
    getRange(row: unknown, column: unknown = 1, numRows: unknown = 1, numColumns: unknown = 1) {
      if (typeof row !== "number") throw new Error("this fake's getRange takes (row, column, numRows, numColumns)");
      return fakeRange(tab, row, Number(column), Number(numRows), Number(numColumns));
    },
    setFrozenRows() {
      tab.touches.push("setFrozenRows");
      return sheet;
    },
    setColumnWidth() {
      tab.touches.push("setColumnWidth");
      return sheet;
    },
  };
  return sheet;
}

export function loadAppsScript(options: Options = {}): AppsScriptWorld {
  const scripts = scriptFiles();
  const fetches: FetchCall[] = [];
  const alerts: string[] = [];
  const menus: FakeMenu[] = [];
  const shown: Shown[] = [];
  const htmlOutputs = new WeakSet<object>();
  const inserted: string[] = [];
  const timeouts: number[] = [];
  const uuids = [...(options.uuids ?? [])];
  let uuidCount = 0;
  const tabs = new Map<string, FakeTab>(
    Object.entries(options.tabs ?? {}).map(([name, rows]) => [
      name,
      { rows: rows.map((cells) => [...cells]), touches: [] },
    ]),
  );
  let timeZone = options.timeZone ?? "America/New_York";
  let lockOwner: object | null = options.lockHeldElsewhere === true ? {} : null;

  const spreadsheet = {
    getSheetByName(name: string) {
      const tab = tabs.get(name);
      return tab === undefined ? null : fakeSheet(name, tab);
    },
    getSheets: () => Array.from(tabs, ([name, tab]) => fakeSheet(name, tab)),
    insertSheet(name: string) {
      if (tabs.has(name)) throw new Error(`A sheet with the name "${name}" already exists`);
      const tab: FakeTab = { rows: [], touches: [] };
      tabs.set(name, tab);
      inserted.push(name);
      return fakeSheet(name, tab);
    },
    getSpreadsheetTimeZone: () => timeZone,
    setSpreadsheetTimeZone(zone: string) {
      timeZone = zone;
    },
  };

  const ui = {
    ButtonSet: { OK: 0 },
    alert(...args: unknown[]) {
      alerts.push(args.filter((arg) => typeof arg === "string").join("\n"));
      return 0;
    },
    createMenu(name: string) {
      const entry: FakeMenu = { name, items: [], added: false };
      menus.push(entry);
      const menu = {
        addItem(caption: string, functionName: string) {
          entry.items.push([caption, functionName]);
          return menu;
        },
        addSeparator() {
          entry.items.push(MENU_SEPARATOR);
          return menu;
        },
        addToUi() {
          entry.added = true;
        },
      };
      return menu;
    },
    showSidebar(output: unknown) {
      show("sidebar", "showSidebar", output);
    },
    showModalDialog(output: unknown, title: unknown) {
      show("modal", "showModalDialog", output, title);
    },
    showModelessDialog(output: unknown, title: unknown) {
      show("modeless", "showModelessDialog", output, title);
    },
  };

  /** A sidebar takes its title from the output. A dialog takes the one it is given, which Google requires. */
  function show(kind: Shown["kind"], method: string, output: unknown, title?: unknown): void {
    if (typeof output !== "object" || output === null || !htmlOutputs.has(output)) {
      throw new Error(`The parameters don't match the method signature for Ui.${method}: pass an HtmlOutput`);
    }
    if (kind !== "sidebar" && typeof title !== "string") {
      throw new Error(`The parameters don't match the method signature for Ui.${method}: pass a title`);
    }
    const html = output as FakeHtmlOutput;
    const entry: Shown = { kind, title: kind === "sidebar" ? html.getTitle() : String(title), html: html.getContent() };
    const width = html.getWidth();
    const height = html.getHeight();
    if (width !== undefined) entry.width = width;
    if (height !== undefined) entry.height = height;
    shown.push(entry);
  }

  const UrlFetchApp = {
    fetch(url: string, request: Record<string, unknown> = {}) {
      const path = new URL(url).pathname;
      const round = fetches.filter((call) => call.path === path).length;
      fetches.push({
        url,
        path,
        method: request.method,
        contentType: request.contentType,
        payload: request.payload,
        muteHttpExceptions: request.muteHttpExceptions,
      });
      const reply = replyTo(options.routes?.[path], round);
      if (reply.throws !== undefined) throw new Error(reply.throws);
      const text = bodyText(reply.body);
      return { getResponseCode: () => reply.status ?? 200, getContentText: () => text };
    },
  };

  const Utilities = {
    Charset: { US_ASCII: "US_ASCII", UTF_8: "UTF_8" },
    computeHmacSha256Signature(value: string, key: string, charset?: unknown) {
      return options.signatureBytes === undefined ? hmacSignature(value, key, charset) : [...options.signatureBytes];
    },
    formatDate,
    getUuid() {
      const given = uuids.shift();
      if (given !== undefined) return given;
      uuidCount += 1;
      return `uuid-${uuidCount}`;
    },
  };

  const LockService = {
    getScriptLock: () => LockService.getDocumentLock(),
    getDocumentLock() {
      const lock = {
        tryLock(timeoutMs: number) {
          timeouts.push(timeoutMs);
          if (lockOwner !== null && lockOwner !== lock) return false;
          lockOwner = lock;
          return true;
        },
        hasLock: () => lockOwner === lock,
        releaseLock() {
          if (lockOwner === lock) lockOwner = null;
        },
      };
      return lock;
    },
  };

  const web = options.web ?? newWebState({ now: Date.now() });
  const cache = fakeCache(web);

  const context: Record<string, unknown> = createContext({
    SpreadsheetApp: { getActive: () => spreadsheet, getActiveSpreadsheet: () => spreadsheet, getUi: () => ui },
    UrlFetchApp,
    Utilities,
    MailApp: fakeMailApp(web),
    CacheService: { getScriptCache: () => cache, getDocumentCache: () => cache, getUserCache: () => cache },
    ContentService: {
      MimeType: { JSON: "JSON", TEXT: "TEXT" },
      createTextOutput: (content: unknown = "") => fakeTextOutput(String(content)),
    },
    HtmlService: fakeHtmlService(htmlOutputs),
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (name: string) => options.properties?.[name] ?? null }),
    },
    LockService,
    Session: {
      // The manifest's timeZone, which its test pins.
      getScriptTimeZone: () => "Asia/Tokyo",
      getActiveUser: () => ({
        getEmail() {
          if (options.userError !== undefined) throw new Error(options.userError);
          return options.user ?? "";
        },
      }),
    },
    Logger: { log() {} },
    console: { log() {}, info() {}, warn() {}, error() {} },
  });

  if (options.web !== undefined) {
    const useClock = new Script(SCRIPT_CLOCK).runInContext(context) as (clock: () => number) => void;
    useClock(() => web.now);
  }

  for (const name of scripts) {
    new Script(readFileSync(new URL(name, SCRIPT_DIR), "utf8"), { filename: `apps-script/${name}` }).runInContext(
      context,
    );
  }

  return {
    call(name, ...args) {
      const fn = context[name];
      if (typeof fn !== "function") throw new Error(`apps-script/ defines no global function ${name}`);
      return fn(...args);
    },
    isFunction: (name) => typeof context[name] === "function",
    evaluate(code) {
      // structuredClone copies into this realm, so the copy passes assert's deepEqual where the original would not.
      return structuredClone(new Script(code, { filename: "evaluate" }).runInContext(context));
    },
    fetches,
    alerts,
    menus,
    shown,
    tabs,
    inserted,
    timeZone: () => timeZone,
    lock: { held: () => lockOwner !== null, timeouts },
  };
}

function newWebState({ now, quota = 100, sendFailures = [] }: WebAppOptions): WebState {
  return { now, quota, sent: [], sendCalls: 0, sendFailures: [...sendFailures], cache: new Map() };
}

/** The event Apps Script hands doPost for a POST with this body. */
function postEvent(contents: string) {
  const postData = { contents, length: contents.length, type: "application/json", name: "postData" };
  return { parameter: {}, parameters: {}, queryString: "", contextPath: "", contentLength: contents.length, postData };
}

/**
 * The deployed web app. Every request is a new execution with fresh globals, so nothing the script keeps in a variable
 * reaches the next request. A throw out of doPost stays a throw here: on Google it is an HTML error page, no answer.
 */
export function loadWebApp(options: WebAppOptions): WebApp {
  const state = newWebState(options);
  const deliver = (event?: unknown): WebReply => {
    const script = loadAppsScript({ properties: options.properties, web: state });
    const output = script.call("doPost", event) as Partial<ReturnType<typeof fakeTextOutput>> | undefined;
    if (typeof output?.getContent !== "function" || typeof output.getMimeType !== "function") {
      throw new Error("doPost returned no ContentService output, which Google turns into an error page");
    }
    return { text: output.getContent(), mimeType: output.getMimeType() };
  };
  return { state, deliver, post: (body) => deliver(postEvent(body)) };
}
