// Loads every apps-script/*.js into one node:vm context, the way Apps Script shares one global scope between files,
// with fakes of the Google services the script reaches. The context has no Node globals, so Buffer, fetch and
// TextEncoder are missing there as they are in Apps Script. Values crossing out of the context are copied into plain
// arrays, because an array built in another realm fails assert's deepEqual on its prototype.
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

export type FakeMenu = { name: string; items: [string, string][]; added: boolean };

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
};

export type AppsScriptWorld = {
  /** Calls a global function of the script, as the menu does. */
  call(name: string, ...args: unknown[]): unknown;
  fetches: FetchCall[];
  alerts: string[];
  menus: FakeMenu[];
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
  return format.replace(/'[^']*'|[A-Za-z]+/g, (token) => {
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

function fakeRange(tab: FakeTab, row: number, column: number, numRows: number, numColumns: number) {
  const range = {
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
  };
  return range;
}

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
    getRange(row: unknown, column: unknown = 1, numRows: unknown = 1, numColumns: unknown = 1) {
      if (typeof row !== "number") throw new Error("this fake's getRange takes (row, column, numRows, numColumns)");
      return fakeRange(tab, row, Number(column), Number(numRows), Number(numColumns));
    },
    setFrozenRows() {
      tab.touches.push("setFrozenRows");
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
  const inserted: string[] = [];
  const timeouts: number[] = [];
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
        addSeparator: () => menu,
        addToUi() {
          entry.added = true;
        },
      };
      return menu;
    },
  };

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
  };

  const LockService = {
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

  const context: Record<string, unknown> = createContext({
    SpreadsheetApp: { getActive: () => spreadsheet, getActiveSpreadsheet: () => spreadsheet, getUi: () => ui },
    UrlFetchApp,
    Utilities,
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
    fetches,
    alerts,
    menus,
    tabs,
    inserted,
    timeZone: () => timeZone,
    lock: { held: () => lockOwner !== null, timeouts },
  };
}
