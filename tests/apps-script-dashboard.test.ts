// The staff Dashboard: the menu, the home sidebar, the shared panel shell and the signed staff call, run in node:vm
// against the fake Google services. Signatures go through the Worker's real verifyEnvelope, and the HTML a sidebar or
// dialog must hold is read from apps-script/*.html here, never taken from the script. Node cannot run the panels' own
// script, so the HTML is held to its rules by scanning it. Message and tab text is free: tests look for facts in it
// (a property's name, a status, a function name), not for sentences.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { SHEET_TABS } from "../src/lib/catalog/sheet-schema.ts";
import { verifyEnvelope } from "../src/lib/crypto.ts";
import {
  type AppsScriptWorld,
  loadAppsScript,
  MENU_SEPARATOR,
  type MenuEntry,
  type Options,
  type Reply,
} from "./helpers/apps-script.ts";

const SCRIPT_DIR = new URL("../apps-script/", import.meta.url);

const BASE_URL = "https://reservation-one.example.dev";
const SECRET = "publish-secret-one";
const USER = "staff@okinawa-dream.example";
const PROPERTIES = { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: SECRET };

const STAFF_PATH = "/api/staff/bookings/find";

const DASHBOARD = "Dashboard";

// As in apps-script-publish.test.ts.
const STACK_TRACE = /\n\s+at\s|\.js:\d+|(Type|Reference|Syntax|Range)Error|Cannot read|\bundefined\b|\[object Object\]/;
const FAILED =
  /fail|could not|couldn't|unable|invalid|unexpected|unreadable|incomplete|not (finish|complet)|失敗|エラー/i;

type Action = { label: string; fn: string };

/** Entries a later task could add. Their functions need not exist: the menu, the home and the tab only name them. */
const EXTRA_ACTIONS: Action[] = [
  { label: "Rent a spaceship", fn: "openSpaceshipPanel" },
  { label: "予約を追加 🛵", fn: "openWalkInPanel" },
];

function world(overrides: Options = {}): AppsScriptWorld {
  return loadAppsScript({ properties: PROPERTIES, user: USER, ...overrides });
}

/** DASHBOARD_ACTIONS_ as the script holds it now, so every test holds as later tasks add entries. */
function dashboardActions(script: AppsScriptWorld): Action[] {
  const actions = script.evaluate("DASHBOARD_ACTIONS_");
  assert.ok(Array.isArray(actions), `DASHBOARD_ACTIONS_ is a list: ${JSON.stringify(actions)}`);
  return actions as Action[];
}

/**
 * Adds entries to the live list, as a later task adds its line to the literal. Today's list is empty, so without this a
 * menu, home or tab that ignored the list would pass.
 */
function addActions(script: AppsScriptWorld, entries: Action[]): void {
  if (entries.length > 0) script.evaluate(`DASHBOARD_ACTIONS_.push(...${JSON.stringify(entries)})`);
}

function panelFile(name: string): string {
  const text = readFileSync(new URL(name, SCRIPT_DIR), "utf8");
  assert.notEqual(text.trim(), "", `${name} has content`);
  return text;
}

/** The shell first: its script defines the callServer that the panel's own script calls as it loads. */
function assertBuiltOnShell(html: string, panel: string, what: string): void {
  const shell = panelFile("PanelShell.html");
  const at = html.indexOf(shell);
  assert.ok(at >= 0, `${what} holds the content of PanelShell.html`);
  const after = html.indexOf(panelFile(panel), at + shell.length);
  assert.ok(after >= 0, `${what} holds the content of ${panel}, after the shell`);
}

/** Code only: a comment that says "never innerHTML" is no use of it, nor is a commented-out call. */
function withoutComments(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function htmlFiles(): { name: string; code: string }[] {
  return readdirSync(SCRIPT_DIR)
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((name) => ({ name, code: withoutComments(readFileSync(new URL(name, SCRIPT_DIR), "utf8")) }));
}

function assertScansPanels(files: { name: string }[]): void {
  const names = files.map(({ name }) => name);
  for (const required of ["PanelShell.html", "DashboardPanel.html"]) {
    assert.ok(names.includes(required), `the scan reads ${required}: ${JSON.stringify(names)}`);
  }
}

const CALL_SERVER = /\bcallServer\s*\(\s*(["'`])([^"'`]*)\1/g;

function callServerNames(code: string): string[] {
  return Array.from(code.matchAll(CALL_SERVER), (match) => match[2]);
}

const MARKUP_WRITES = /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\s*\.\s*write|<\?/;

function tabRows(script: AppsScriptWorld, name: string): unknown[][] {
  const tab = script.tabs.get(name);
  assert.ok(tab !== undefined, `the ${name} tab exists`);
  return tab.rows;
}

test("onOpen lists Publish, Set up tabs, Open dashboard and every dashboard action", () => {
  for (const added of [[], EXTRA_ACTIONS.slice(0, 1), EXTRA_ACTIONS]) {
    const script = world();
    addActions(script, added);
    script.call("onOpen");

    const actions = dashboardActions(script);
    assert.deepEqual(actions.slice(actions.length - added.length), added, "the added entries are in the list");
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
  }
});

test("openDashboard shows the home sidebar built on the panel shell", () => {
  // Missing Script Properties are the home's to show, so the sidebar opens without them too.
  for (const properties of [PROPERTIES, {}]) {
    const script = world({ properties });
    script.call("openDashboard");

    assert.equal(script.shown.length, 1, `one sidebar: ${JSON.stringify(script.shown.map(({ kind }) => kind))}`);
    const [shown] = script.shown;
    assert.equal(shown.kind, "sidebar");
    assert.equal(shown.title, "Okinawa Dream");
    assertBuiltOnShell(shown.html, "DashboardPanel.html", "the home sidebar");
    assert.deepEqual(script.fetches, []);
  }
});

test("dashboardHome lists the actions and the missing Script Properties without calling the Worker", () => {
  const cases: { label: string; properties: Record<string, string>; missing: string[] }[] = [
    { label: "both set", properties: PROPERTIES, missing: [] },
    { label: "none set", properties: {}, missing: ["PUBLISH_SECRET", "WORKER_BASE_URL"] },
    { label: "WORKER_BASE_URL unset", properties: { PUBLISH_SECRET: SECRET }, missing: ["WORKER_BASE_URL"] },
    {
      label: "WORKER_BASE_URL empty",
      properties: { ...PROPERTIES, WORKER_BASE_URL: "" },
      missing: ["WORKER_BASE_URL"],
    },
    { label: "PUBLISH_SECRET unset", properties: { WORKER_BASE_URL: BASE_URL }, missing: ["PUBLISH_SECRET"] },
    { label: "PUBLISH_SECRET empty", properties: { ...PROPERTIES, PUBLISH_SECRET: "" }, missing: ["PUBLISH_SECRET"] },
    {
      label: "both empty",
      properties: { WORKER_BASE_URL: "", PUBLISH_SECRET: "" },
      missing: ["PUBLISH_SECRET", "WORKER_BASE_URL"],
    },
  ];
  for (const { label, properties, missing } of cases) {
    for (const added of [[], EXTRA_ACTIONS]) {
      const what = `${label}, ${added.length} added actions`;
      const script = world({ properties, routes: { [STAFF_PATH]: { body: { ok: true } } } });
      addActions(script, added);
      const home = structuredClone(script.call("dashboardHome")) as { actions: unknown; missing: unknown };

      assert.deepEqual(home.actions, dashboardActions(script), what);
      assert.ok(Array.isArray(home.missing), `${what}: missing is a list`);
      assert.deepEqual([...home.missing].sort(), missing, what);
      assert.deepEqual(script.fetches, [], `${what}: the Worker is not called`);
      assert.deepEqual(script.shown, [], what);
    }
  }
});

test("staffPost_ signs the payload with requestedBy so verifyEnvelope accepts it", async () => {
  const cases: {
    label: string;
    properties: { WORKER_BASE_URL: string; PUBLISH_SECRET: string };
    user: string;
    userError?: string;
    path: string;
    payload: Record<string, unknown>;
    requestedBy: string;
    answer: Record<string, unknown>;
  }[] = [
    {
      label: "a catalog check",
      properties: PROPERTIES,
      user: USER,
      path: "/api/staff/catalog/check",
      payload: { plate: "わ1001", model_id: "pcx-125" },
      requestedBy: USER,
      answer: { ok: true, errors: [], warnings: [{ row: 2, message: "photo missing" }] },
    },
    {
      label: "another Worker, secret and user",
      properties: { WORKER_BASE_URL: "https://worker-two.example.workers.dev/", PUBLISH_SECRET: "another-secret-2" },
      user: "manager@example.jp",
      path: STAFF_PATH,
      payload: { query: "比嘉 🛵", limit: 20, filters: { status: ["held", "paid"], since: null, paid: false } },
      requestedBy: "manager@example.jp",
      answer: { bookings: [{ ref: "7K2MQ9XA", guest: "比嘉太郎" }], total: 1 },
    },
    {
      label: "an empty payload and answer",
      properties: { WORKER_BASE_URL: BASE_URL, PUBLISH_SECRET: "s3cret with spaces & symbols" },
      user: "Ünï-🛵@example.com",
      path: "/api/staff/catalog",
      payload: {},
      requestedBy: "Ünï-🛵@example.com",
      answer: {},
    },
    // The signed requestedBy is the signed-in user's, whatever the panel sent: a panel cannot speak for someone else.
    {
      label: "a payload that names another user",
      properties: PROPERTIES,
      user: USER,
      path: "/api/staff/bookings/cancel",
      payload: { requestedBy: "someone-else@example.com", bookingRef: "P3Y2F7BV", refundJpy: 3000 },
      requestedBy: USER,
      answer: { ok: true, refundJpy: 3000 },
    },
    // Google withholds the address, or the lookup throws: still signed, with the blank requestedBy Publish sends.
    {
      label: "a withheld address",
      properties: PROPERTIES,
      user: "",
      path: STAFF_PATH,
      payload: { query: "B3TZ8VWN" },
      requestedBy: "",
      answer: { bookings: [] },
    },
    {
      label: "a user lookup that throws",
      properties: PROPERTIES,
      user: USER,
      userError: "You do not have permission to call Session.getActiveUser",
      path: STAFF_PATH,
      payload: { query: "B3TZ8VWN" },
      requestedBy: "",
      answer: { bookings: [], total: 0 },
    },
  ];
  for (const { label, properties, user, userError, path, payload, requestedBy, answer } of cases) {
    const script = world({
      properties,
      user,
      ...(userError === undefined ? {} : { userError }),
      routes: { [path]: { body: answer } },
    });
    const result = structuredClone(script.call("staffPost_", path, payload));

    assert.deepEqual(result, { ok: true, result: answer }, label);
    assert.equal(script.fetches.length, 1, `${label}: one request`);
    const [call] = script.fetches;
    assert.equal(call.url, `${properties.WORKER_BASE_URL.replace(/\/+$/, "")}${path}`, label);
    assert.equal(String(call.method).toLowerCase(), "post", label);

    const body = String(call.payload);
    const verified = await verifyEnvelope(properties.PUBLISH_SECRET, body, Date.now());
    assert.deepEqual(verified, { ok: true, payload: { ...payload, requestedBy } }, label);
    const forged = await verifyEnvelope(`${properties.PUBLISH_SECRET}-other`, body, Date.now());
    assert.deepEqual(forged, { ok: false, reason: "bad_signature" }, label);
  }
});

test("staffPost_ turns missing properties, a non-200 answer and unreadable JSON into readable messages", () => {
  type Failure = { name: string; properties?: Record<string, string>; reply: Reply } & (
    | { kind: "missing"; names: string[] }
    | { kind: "status"; status: number }
    | { kind: "unreadable" }
    | { kind: "thrown" }
  );
  // A request that went out would be answered happily, so a missing property shows only as a request made anyway.
  const answered: Reply = { body: { bookings: [] } };
  const failures: Failure[] = [
    {
      name: "no properties",
      properties: {},
      reply: answered,
      kind: "missing",
      names: ["WORKER_BASE_URL", "PUBLISH_SECRET"],
    },
    {
      name: "WORKER_BASE_URL unset",
      properties: { PUBLISH_SECRET: SECRET },
      reply: answered,
      kind: "missing",
      names: ["WORKER_BASE_URL"],
    },
    {
      name: "WORKER_BASE_URL empty",
      properties: { ...PROPERTIES, WORKER_BASE_URL: "" },
      reply: answered,
      kind: "missing",
      names: ["WORKER_BASE_URL"],
    },
    {
      name: "PUBLISH_SECRET unset",
      properties: { WORKER_BASE_URL: BASE_URL },
      reply: answered,
      kind: "missing",
      names: ["PUBLISH_SECRET"],
    },
    {
      name: "PUBLISH_SECRET empty",
      properties: { ...PROPERTIES, PUBLISH_SECRET: "" },
      reply: answered,
      kind: "missing",
      names: ["PUBLISH_SECRET"],
    },
    { name: "401 with no body", reply: { status: 401 }, kind: "status", status: 401 },
    { name: "403 as JSON", reply: { status: 403, body: { error: "bad_signature" } }, kind: "status", status: 403 },
    { name: "404 as text", reply: { status: 404, body: "Not found" }, kind: "status", status: 404 },
    { name: "409 as JSON", reply: { status: 409, body: { error: "plate taken" } }, kind: "status", status: 409 },
    { name: "500 as text", reply: { status: 500, body: "Internal error" }, kind: "status", status: 500 },
    { name: "502 as HTML", reply: { status: 502, body: "<html>Bad gateway</html>" }, kind: "status", status: 502 },
    { name: "200 with HTML", reply: { body: "<html><body>Error 1101</body></html>" }, kind: "unreadable" },
    { name: "200 with nothing", reply: { body: "" }, kind: "unreadable" },
    { name: "200 with cut-off JSON", reply: { body: '{"bookings": [' }, kind: "unreadable" },
    { name: "200 with JSON null", reply: { body: null }, kind: "unreadable" },
    { name: "200 with a JSON list", reply: { body: [{ ok: true }] }, kind: "unreadable" },
    { name: "200 with a JSON number", reply: { body: 42 }, kind: "unreadable" },
    { name: "200 with a JSON string", reply: { body: '"ok"' }, kind: "unreadable" },
    { name: "200 with JSON true", reply: { body: true }, kind: "unreadable" },
    { name: "a thrown fetch", reply: { throws: "Address unavailable: reservation-one.example.dev" }, kind: "thrown" },
  ];
  for (const failure of failures) {
    const { name } = failure;
    const script = world({ properties: failure.properties ?? PROPERTIES, routes: { [STAFF_PATH]: failure.reply } });
    let answer: unknown;
    assert.doesNotThrow(() => {
      answer = script.call("staffPost_", STAFF_PATH, { query: "7K2MQ9XA" });
    }, name);

    const { ok, message } = structuredClone(answer) as { ok?: unknown; message?: unknown };
    assert.equal(ok, false, `${name}: ${JSON.stringify(answer)}`);
    assert.equal(typeof message, "string", `${name}: a message`);
    const text = String(message);
    assert.notEqual(text.trim(), "", `${name}: a message`);
    assert.doesNotMatch(text, STACK_TRACE, name);
    assert.ok(!text.includes(SECRET), `${name}: the secret stays out of the message`);

    if (failure.kind === "missing") {
      assert.deepEqual(script.fetches, [], `${name}: nothing is sent`);
      for (const property of failure.names) assert.ok(text.includes(property), `${name}: names ${property}: ${text}`);
    } else {
      assert.equal(script.fetches.length, 1, `${name}: one request`);
    }
    if (failure.kind === "status") {
      assert.match(text, new RegExp(`(?<!\\d)${failure.status}(?!\\d)`), `${name}: shows the status: ${text}`);
    }
    if (failure.kind === "unreadable") assert.match(text, FAILED, `${name}: ${text}`);
  }
});

test("setupTabs adds a Dashboard tab with the open instructions and leaves an existing one alone", () => {
  const sheetTabs = Object.keys(SHEET_TABS);
  const everyOtherTab = Object.fromEntries(sheetTabs.map((name) => [name, [[`kept ${name}`]]]));

  // Missing: created, with how to open the dashboard and one line per action naming its function.
  for (const [label, tabs] of [
    ["a new spreadsheet", {}],
    ["every other tab there", everyOtherTab],
  ] as [string, Record<string, unknown[][]>][]) {
    for (const added of [[], EXTRA_ACTIONS]) {
      const what = `${label}, ${added.length} added actions`;
      const script = world({ tabs });
      addActions(script, added);
      script.call("setupTabs");

      assert.equal(script.inserted.filter((name) => name === DASHBOARD).length, 1, `${what}: Dashboard is created`);
      const rows = tabRows(script, DASHBOARD);
      const text = rows.flat().map(String).join("\n");
      assert.ok(text.includes("Okinawa Dream"), `${what}: the tab names the menu: ${text}`);
      assert.ok(text.includes("Open dashboard"), `${what}: the tab names the menu item: ${text}`);
      for (const { label: actionLabel, fn } of dashboardActions(script)) {
        assert.ok(
          rows.some((cells) => {
            const line = cells.map(String).join(" ");
            return line.includes(actionLabel) && line.includes(fn);
          }),
          `${what}: a row names ${actionLabel} and ${fn}: ${JSON.stringify(rows)}`,
        );
      }
      assert.equal(script.alerts.length, 1, what);
      assert.ok(script.alerts[0].includes(DASHBOARD), `${what}: the alert names Dashboard: ${script.alerts[0]}`);
      for (const [name, kept] of Object.entries(tabs)) {
        assert.deepEqual(script.tabs.get(name)?.rows, kept, `${what}: ${name} keeps its cells`);
        assert.deepEqual(script.tabs.get(name)?.touches, [], `${what}: nothing wrote to ${name}`);
      }

      // Set up tabs again: the tab it made is now one already there.
      const made = structuredClone(rows);
      const touches = [...(script.tabs.get(DASHBOARD)?.touches ?? [])];
      script.call("setupTabs");
      assert.deepEqual(tabRows(script, DASHBOARD), made, `${what}: a second run leaves Dashboard as it was`);
      assert.deepEqual(script.tabs.get(DASHBOARD)?.touches, touches, `${what}: a second run writes nothing to it`);
      assert.equal(script.inserted.filter((name) => name === DASHBOARD).length, 1, what);
      const second = script.alerts[1];
      assert.ok(!second.includes(DASHBOARD), `${what}: the second alert creates nothing: ${second}`);
    }
  }

  // Already there, in whatever state staff left it: untouched, and the other tabs behave as before.
  const existingDashboards: unknown[][][] = [
    [],
    [["My own dashboard notes"], ["Call the owner: 098-000-0000"]],
    [["Okinawa Dream"], ["Old instructions", "openSomethingRemoved"]],
  ];
  for (const existing of existingDashboards) {
    for (const [label, others] of [
      ["a new spreadsheet", {}],
      ["every other tab there", everyOtherTab],
    ] as [string, Record<string, unknown[][]>][]) {
      const what = `${label} with a Dashboard of ${existing.length} rows`;
      const script = world({ tabs: { ...others, [DASHBOARD]: existing } });
      addActions(script, EXTRA_ACTIONS);
      script.call("setupTabs");

      assert.ok(!script.inserted.includes(DASHBOARD), what);
      assert.deepEqual(tabRows(script, DASHBOARD), existing, `${what}: Dashboard keeps its cells`);
      assert.deepEqual(script.tabs.get(DASHBOARD)?.touches, [], `${what}: nothing wrote to Dashboard`);
      assert.equal(script.alerts.length, 1, what);
      assert.ok(!script.alerts[0].includes(DASHBOARD), `${what}: the alert creates no Dashboard: ${script.alerts[0]}`);

      const missing = sheetTabs.filter((name) => !(name in others)).sort();
      assert.deepEqual([...script.inserted].sort(), missing, what);
      for (const name of missing) {
        assert.deepEqual(tabRows(script, name), [SHEET_TABS[name as keyof typeof SHEET_TABS]], `${what}: ${name}`);
      }
      assert.equal(script.timeZone(), "Asia/Tokyo", what);
    }
  }
});

test("every callServer in the panels names a public global function", () => {
  // The scan itself, on text whose calls are known: each quote style, spacing, and a comment that is no call.
  assert.deepEqual(
    callServerNames(withoutComments("callServer('a'); callServer( \"b\", 1); callServer(`c`); // callServer('d')")),
    ["a", "b", "c"],
  );

  const script = world();
  const files = htmlFiles();
  assertScansPanels(files);
  const calls = files.flatMap(({ name, code }) => callServerNames(code).map((fn) => ({ file: name, fn })));
  // The home loads through callServer, so a scan that finds nothing is broken, not clean.
  assert.ok(
    calls.some(({ file, fn }) => file === "DashboardPanel.html" && fn === "dashboardHome"),
    `DashboardPanel.html calls dashboardHome: ${JSON.stringify(calls)}`,
  );
  for (const { file, fn } of calls) {
    assert.ok(!fn.endsWith("_"), `${file}: google.script.run cannot call the private ${fn}`);
    assert.ok(script.isFunction(fn), `${file}: callServer('${fn}') names no global function`);
  }
});

test("no panel writes markup from data", () => {
  // The scan itself: every way in it looks for, and the ways that are fine.
  for (const bad of [
    "el.innerHTML = name;",
    'el["outerHTML"] = row;',
    "list.insertAdjacentHTML('beforeend', item);",
    "document.write(guest);",
    "document . writeln(guest);",
    "<p><?!= booking.guestName ?></p>",
    "<p><?= booking.guestName ?></p>",
  ]) {
    assert.match(withoutComments(bad), MARKUP_WRITES, bad);
  }
  for (const fine of [
    "el.textContent = name;",
    "// never innerHTML: textContent only",
    "<!-- no document.write here -->",
    "/* outerHTML is banned */ el.textContent = row;",
  ]) {
    assert.doesNotMatch(withoutComments(fine), MARKUP_WRITES, fine);
  }

  const files = htmlFiles();
  assertScansPanels(files);
  for (const { name, code } of files) {
    const line = code.split("\n").find((text) => MARKUP_WRITES.test(text));
    assert.equal(line, undefined, `${name} writes markup: ${line?.trim()}`);
  }
});

test("every dashboard action opens one modal dialog", () => {
  // The dialog every action opens: openPanel_, with its own panel file and title.
  for (const title of ["Add a bike", "予約をキャンセル / Cancel a booking"]) {
    const script = world();
    script.call("openPanel_", "DashboardPanel", title);

    assert.equal(script.shown.length, 1, `${title}: one dialog`);
    const [shown] = script.shown;
    assert.equal(shown.kind, "modal", title);
    assert.equal(shown.title, title);
    assert.equal(shown.width, 720, title);
    assert.equal(shown.height, 640, title);
    assertBuiltOnShell(shown.html, "DashboardPanel.html", `the ${title} dialog`);
    assert.deepEqual(script.fetches, [], title);
  }

  // A panel whose file is missing is an error that names it, not an empty dialog.
  const broken = world();
  assert.throws(
    () => broken.call("openPanel_", "NoSuchPanel", "Missing"),
    /No HTML file named NoSuchPanel(\.html)? was found/,
  );
  assert.deepEqual(broken.shown, []);

  const actions = dashboardActions(world());
  const fns = actions.map(({ fn }) => fn);
  assert.equal(new Set(fns).size, fns.length, `each action has its own function: ${JSON.stringify(fns)}`);
  for (const { label, fn } of actions) {
    assert.ok(typeof label === "string" && label.trim() !== "", `${fn}: a label`);
    assert.ok(typeof fn === "string" && !fn.endsWith("_"), `${label}: the menu cannot run the private ${fn}`);

    const script = world();
    assert.ok(script.isFunction(fn), `${label}: ${fn} is a global function`);
    script.call(fn);
    assert.deepEqual(
      script.shown.map(({ kind }) => kind),
      ["modal"],
      `${label}: ${fn} opens exactly one modal dialog`,
    );
    const shell = panelFile("PanelShell.html");
    assert.ok(script.shown[0].html.includes(shell), `${label}: the dialog is built on the shell`);
  }
});
