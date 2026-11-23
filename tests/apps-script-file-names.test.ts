// apps-script/ as clasp pushes it. Apps Script names each file without its extension, so a script file and an HTML
// file of one base name clash and the push is refused ("A file with this name already exists"). Each panel's HTML
// carries a Panel suffix; these tests hold the listing to unique base names and check that every opener loads the
// renamed file. Expected names come from the ticket's table here, never from the script.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { loadAppsScript } from "./helpers/apps-script.ts";

const SCRIPT_DIR = new URL("../apps-script/", import.meta.url);

const SHELL = "PanelShell.html";

/** Each panel: its script, the HTML it must load, the name that HTML had before, and the global that opens it. */
const PANELS = [
  {
    script: "Dashboard.js",
    html: "DashboardPanel.html",
    old: "Dashboard.html",
    opener: "openDashboard",
  },
  {
    script: "AddBike.js",
    html: "AddBikePanel.html",
    old: "AddBike.html",
    opener: "openAddBike",
  },
  {
    script: "AddReservation.js",
    html: "AddReservationPanel.html",
    old: "AddReservation.html",
    opener: "openAddReservation",
  },
  {
    script: "BlockBike.js",
    html: "BlockBikePanel.html",
    old: "BlockBike.html",
    opener: "openBlockBike",
  },
  {
    script: "CancelBooking.js",
    html: "CancelBookingPanel.html",
    old: "CancelBooking.html",
    opener: "openCancelBooking",
  },
];

/** The name up to its last dot, as Apps Script names a file. */
function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Base names that two or more files share, each with those files, sorted. */
function clashes(names: string[]): Record<string, string[]> {
  const byBase = new Map<string, string[]>();
  for (const name of names) byBase.set(baseName(name), [...(byBase.get(baseName(name)) ?? []), name]);
  const shared: Record<string, string[]> = {};
  for (const [base, files] of [...byBase].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.length > 1) shared[base] = [...files].sort();
  }
  return shared;
}

/** The files clasp pushes: every plain file in apps-script/, dotfiles (clasp's own settings) aside. */
function listing(): string[] {
  return readdirSync(SCRIPT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/** The HTML file a loader name resolves to: the name as given when it ends in .html, else the name plus .html. */
function htmlFileFor(name: string): string {
  return name.endsWith(".html") ? name : `${name}.html`;
}

const LOADER_CALL = /\b(openPanel_|panelHtml_|createHtmlOutputFromFile)\s*\(\s*(["'`])([^"'`]*)\2/g;

test("no two files in apps-script/ share a base name, whatever their extensions", () => {
  // The check itself, on listings whose answer is known.
  const known: [string[], Record<string, string[]>][] = [
    [["AddBike.js", "AddBike.html", "PanelShell.html"], { AddBike: ["AddBike.html", "AddBike.js"] }],
    [["AddBike.js", "AddBikePanel.html", "PanelShell.html"], {}],
    [["Mail.js", "Mail.gs", "Mail.json", "Publish.js"], { Mail: ["Mail.gs", "Mail.js", "Mail.json"] }],
    [["a.b.js", "a.b.html", "a.js"], { "a.b": ["a.b.html", "a.b.js"] }],
    [["Dashboard.js", "DashboardPanel.html", "Dashboard.html"], { Dashboard: ["Dashboard.html", "Dashboard.js"] }],
    [[], {}],
  ];
  for (const [names, expected] of known) assert.deepEqual(clashes(names), expected, JSON.stringify(names));

  const names = listing();
  // A listing with no scripts or no HTML would pass for nothing.
  assert.ok(
    names.some((name) => name.endsWith(".js")),
    `apps-script/ holds .js files: ${JSON.stringify(names)}`,
  );
  assert.ok(
    names.some((name) => name.endsWith(".html")),
    `apps-script/ holds .html files: ${JSON.stringify(names)}`,
  );
  assert.deepEqual(clashes(names), {}, `apps-script/ base names clash: ${JSON.stringify(names)}`);
});

test("each panel's HTML has its Panel name and the old name is gone", () => {
  const names = listing();
  assert.ok(names.includes(SHELL), `${SHELL} stays: ${JSON.stringify(names)}`);
  for (const { script, html, old } of PANELS) {
    assert.ok(names.includes(script), `${script} stays: ${JSON.stringify(names)}`);
    assert.ok(names.includes(html), `${html} exists: ${JSON.stringify(names)}`);
    assert.ok(!names.includes(old), `${old} is gone: ${JSON.stringify(names)}`);
    assert.notEqual(readFileSync(new URL(html, SCRIPT_DIR), "utf8").trim(), "", `${html} has content`);
  }
});

test("every opener loads the shell and its renamed panel file", () => {
  for (const { html, opener } of PANELS) {
    const script = loadAppsScript({});
    // Record each name the script hands to createHtmlOutputFromFile, then load as before.
    script.evaluate(`(() => {
      const original = HtmlService.createHtmlOutputFromFile;
      globalThis.loadedHtmlNames = [];
      HtmlService.createHtmlOutputFromFile = (name) => {
        globalThis.loadedHtmlNames.push(String(name));
        return original.call(HtmlService, name);
      };
    })()`);
    script.call(opener);

    const loaded = script.evaluate("loadedHtmlNames") as string[];
    assert.deepEqual(
      loaded.map(htmlFileFor).sort(),
      [html, SHELL].sort(),
      `${opener} loads: ${JSON.stringify(loaded)}`,
    );
    assert.equal(script.shown.length, 1, `${opener} shows one sidebar or dialog`);
    const content = readFileSync(new URL(html, SCRIPT_DIR), "utf8");
    assert.ok(script.shown[0].html.includes(content), `${opener} shows the content of ${html}`);
  }
});

test("every name the scripts pass to an HTML loader names an HTML file no script file shares", () => {
  // The scan itself, on code whose calls are known.
  const sample = `openPanel_("A", t); panelHtml_('B'); HtmlService.createHtmlOutputFromFile(\`C.html\`);
    // openPanel_("D", t)
    function openPanel_(file, title) {}`;
  assert.deepEqual(
    Array.from(withoutComments(sample).matchAll(LOADER_CALL), (match) => match[3]),
    ["A", "B", "C.html"],
  );

  const names = listing();
  const scripts = names.filter((name) => name.endsWith(".js"));
  const passed = scripts.flatMap((file) =>
    Array.from(withoutComments(readFileSync(new URL(file, SCRIPT_DIR), "utf8")).matchAll(LOADER_CALL), (match) => ({
      file,
      name: match[3],
    })),
  );
  // Every panel opener passes its name as a literal, so a scan that finds fewer than the panels is broken.
  assert.ok(passed.length >= PANELS.length, `loader calls found: ${JSON.stringify(passed)}`);
  for (const { file, name } of passed) {
    const html = htmlFileFor(name);
    assert.ok(names.includes(html), `${file}: "${name}" names no file in apps-script/`);
    const twins = names.filter((other) => other !== html && baseName(other) === baseName(html));
    assert.deepEqual(twins, [], `${file}: "${name}" shares its base name with ${JSON.stringify(twins)}`);
  }
});
