// Design tokens and the neutral theme: src/styles/tokens.css, src/styles/global.css, loaded by Base.astro.
//
// The tests never pin a colour value (task #30 swaps the values), they compute from whatever tokens.css
// declares. They do pin this NAMING CONTRACT, which task #30 must keep:
//
//   tokens.css declares, in a top-level `:root { ... }` block, as 3- or 6-digit hex (or `var(--other)` alias):
//     --color-background             page background
//     --color-text                   body text                          (on background, 4.5:1)
//     --color-text-muted             secondary text                     (on background, 4.5:1)
//     --color-link                   link text                          (on background, 4.5:1)
//     --color-link-hover             link text on hover                 (on background, 4.5:1)
//     --color-button-background      button fill
//     --color-button-text            button label                       (on button background, 4.5:1)
//     --color-button-background-hover  button fill on hover             (with button text, 4.5:1)
//     --color-focus-ring             focus outline colour               (on background, 3:1, UI component)
//   and a type scale `--font-size-*` and spacing scale `--space-*`, at least three of each.
//
//   global.css uses those through var(--...) and gives links, buttons and form controls (a, button, input,
//   select, textarea) a `:focus-visible` outline drawn with var(--color-focus-ring).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const tokensPath = fileURLToPath(
  new URL("../src/styles/tokens.css", import.meta.url),
);
const globalPath = fileURLToPath(
  new URL("../src/styles/global.css", import.meta.url),
);
const basePath = fileURLToPath(
  new URL("../src/layouts/Base.astro", import.meta.url),
);

// ---------------------------------------------------------------------------------------------------
// Helpers

/** Removes CSS/HTML block comments and whole-line-ish `//` comments (not the `//` of a URL). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function read(path: string): string {
  assert.ok(existsSync(path), `${relative(repoRoot, path)} must exist`);
  return readFileSync(path, "utf8");
}

/** The declarations of the top-level `:root { }` rule(s); rules nested in @media and the like are ignored. */
function rootDeclarations(css: string): Map<string, string> {
  const text = stripComments(css);
  const out = new Map<string, string>();
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = -1;
  let selector = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        selector = text.slice(selectorStart, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (selector === ":root") {
          for (const decl of text.slice(bodyStart, i).split(";")) {
            const m = decl.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/);
            if (m) out.set(m[1]!, m[2]!);
          }
        }
        selectorStart = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      selectorStart = i + 1; // a top-level @import / @charset statement
    }
  }
  return out;
}

/** Resolves a token to [r, g, b], following `var(--other)` aliases. Only 3- and 6-digit hex are supported. */
function resolveColor(
  tokens: Map<string, string>,
  name: string,
  seen: string[] = [],
): [number, number, number] {
  const value = tokens.get(name);
  assert.ok(
    value !== undefined,
    `tokens.css must declare ${name} in a top-level :root block`,
  );
  const alias = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (alias) {
    assert.ok(!seen.includes(name), `${name} is part of an alias cycle`);
    return resolveColor(tokens, alias[1]!, [...seen, name]);
  }
  const hex = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  assert.ok(
    hex,
    `${name} must be a 3- or 6-digit hex colour (or a var() alias of one), got "${value}"`,
  );
  let digits = hex[1]!;
  if (digits.length === 3) digits = [...digits].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Hex colour literals in text. Skips `&#x..;` entities, `href="#frag"`-style attributes, `url(#frag)`, comments. */
function findHexColors(source: string): string[] {
  const text = stripComments(source);
  const found: string[] = [];
  const re = /#([0-9a-fA-F]{3,8})(?![0-9a-zA-Z_-])/g;
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index);
    if (![3, 4, 6, 8].includes(m[1]!.length)) continue;
    if (/[&\w/]$/.test(before)) continue; // `&#x1F;`, `a#id`, `page/#frag`
    if (
      /(?:href|src|action|for|id|aria-[\w-]+|xlink:href)\s*=\s*["']$/i.test(
        before,
      )
    )
      continue;
    if (/url\(\s*["']?$/i.test(before)) continue;
    found.push(m[0]);
  }
  return found;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = `${dir}${name}`;
    return statSync(full).isDirectory() ? walk(`${full}/`) : [full];
  });
}

/** Every rule as { selector, decls }, including those nested in at-rules (their preludes are dropped). */
function rules(
  css: string,
): { selector: string; decls: Map<string, string> }[] {
  const out: { selector: string; decls: Map<string, string> }[] = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const d of m[2]!.split(";")) {
      const kv = d.match(/^\s*([\w-]+)\s*:\s*([\s\S]*?)\s*$/);
      if (kv)
        decls.set(kv[1]!.toLowerCase(), kv[2]!.replace(/\s*!important$/i, ""));
    }
    out.push({ selector: m[1]!.trim(), decls });
  }
  return out;
}

/** Splits a selector list at top-level commas. */
function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of selector) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Does this one selector put `:focus-visible` on the element `el` (a type selector, `*`, or no type)? */
function focusVisibleCovers(part: string, el: string): boolean {
  if (!part.includes(":focus-visible")) return false;
  const compound = part.split(/\s*[>+~]\s*|\s+(?![^(]*\))/).pop()!;
  const head = compound.slice(0, compound.indexOf(":focus-visible"));
  const lead = head.match(/^(\*|[a-zA-Z][\w-]*)/)?.[1];
  if (lead === "*" || lead === el) return true;
  if (lead === undefined && /^:(?:is|where)\(/.test(head)) {
    return new RegExp(`(^|[\\s,(])${el}(?![\\w-])`).test(head);
  }
  return lead === undefined && head === ""; // bare `:focus-visible`
}

const FOCUSABLES = ["a", "button", "input", "select", "textarea"];

/** `<style>` block contents of an .astro file. */
function styleBlocks(astro: string): string {
  return [...astro.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Sanity checks for the helpers the real tests lean on

test("the contrast helper matches known WCAG ratios", () => {
  const black: [number, number, number] = [0, 0, 0];
  const white: [number, number, number] = [255, 255, 255];
  assert.ok(Math.abs(contrast(black, white) - 21) < 0.001);
  assert.ok(
    Math.abs(contrast(white, black) - 21) < 0.001,
    "order does not matter",
  );
  assert.ok(Math.abs(contrast(white, white) - 1) < 0.001);
  // Published values: #767676 on white is the lightest grey that passes AA (4.54), #777777 just fails (4.48).
  const g767676 = contrast([0x76, 0x76, 0x76], white);
  const g777777 = contrast([0x77, 0x77, 0x77], white);
  assert.ok(g767676 > 4.5 && g767676 < 4.6, `got ${g767676}`);
  assert.ok(g777777 > 4.4 && g777777 < 4.5, `got ${g777777}`);
  // Pure red on white is 4.00.
  assert.ok(Math.abs(contrast([255, 0, 0], white) - 4) < 0.01);
  // The color parser expands shorthand and follows aliases.
  const tokens = new Map([
    ["--a", "#fff"],
    ["--b", "#FFFFFF"],
    ["--c", "var(--a)"],
    ["--d", "#1a2b3c"],
  ]);
  assert.deepEqual(resolveColor(tokens, "--a"), [255, 255, 255]);
  assert.deepEqual(resolveColor(tokens, "--b"), [255, 255, 255]);
  assert.deepEqual(resolveColor(tokens, "--c"), [255, 255, 255]);
  assert.deepEqual(resolveColor(tokens, "--d"), [0x1a, 0x2b, 0x3c]);
});

test("the hex scanner finds colors and ignores entities, fragments and ticket numbers", () => {
  assert.deepEqual(findHexColors("a { color: #fff; }"), ["#fff"]);
  assert.deepEqual(
    findHexColors(
      "a { color: #FfF0; background: #112233; border-color: #11223344 }",
    ),
    ["#FfF0", "#112233", "#11223344"],
  );
  assert.deepEqual(findHexColors('<path fill="#abc" />'), ["#abc"]);
  assert.deepEqual(findHexColors("<p>caf&#xE9; &#x1F600; &#233;</p>"), []);
  assert.deepEqual(
    findHexColors(
      '<a href="#section">x</a> <use href="#add"/> background: url(#grad);',
    ),
    [],
  );
  assert.deepEqual(
    findHexColors(
      "/* see #100 and #fade */ <!-- #abcdef --> // ticket #123\na {}",
    ),
    [],
  );
  assert.deepEqual(findHexColors("a { color: #fffff; } b { color: #12; }"), []);
});

// ---------------------------------------------------------------------------------------------------
// Definition of done

test("token color pairs meet WCAG AA contrast", () => {
  const tokens = rootDeclarations(read(tokensPath));
  const pairs: { fg: string; bg: string; min: number; what: string }[] = [
    {
      fg: "--color-text",
      bg: "--color-background",
      min: 4.5,
      what: "body text",
    },
    {
      fg: "--color-text-muted",
      bg: "--color-background",
      min: 4.5,
      what: "muted text",
    },
    { fg: "--color-link", bg: "--color-background", min: 4.5, what: "link" },
    {
      fg: "--color-link-hover",
      bg: "--color-background",
      min: 4.5,
      what: "link on hover",
    },
    {
      fg: "--color-button-text",
      bg: "--color-button-background",
      min: 4.5,
      what: "button label",
    },
    {
      fg: "--color-button-text",
      bg: "--color-button-background-hover",
      min: 4.5,
      what: "button label on hover",
    },
    {
      fg: "--color-focus-ring",
      bg: "--color-background",
      min: 3,
      what: "focus ring (UI component)",
    },
  ];
  const failures: string[] = [];
  for (const { fg, bg, min, what } of pairs) {
    const ratio = contrast(resolveColor(tokens, fg), resolveColor(tokens, bg));
    if (ratio < min)
      failures.push(
        `${what}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`,
      );
  }
  assert.deepEqual(failures, []);
});

test("no hex colors outside tokens.css", () => {
  assert.ok(existsSync(`${srcDir}styles/`), "src/styles/ must exist");
  const files = [
    ...walk(srcDir).filter((f) => f.endsWith(".astro")),
    ...readdirSync(`${srcDir}styles/`)
      .filter((f) => f.endsWith(".css"))
      .map((f) => `${srcDir}styles/${f}`),
  ];
  const names = files.map((f) => relative(srcDir, f));
  // The scan must be real: these have to be in it, or it passes vacuously.
  assert.ok(
    names.includes("layouts/Base.astro"),
    `scan missed Base.astro: ${names.join(", ")}`,
  );
  assert.ok(
    names.includes("styles/global.css"),
    `scan missed global.css: ${names.join(", ")}`,
  );
  assert.ok(names.includes("styles/tokens.css"), "tokens.css must exist");
  const offenders: string[] = [];
  for (const file of files) {
    if (file === tokensPath) continue;
    for (const hex of findHexColors(readFileSync(file, "utf8")))
      offenders.push(`${relative(srcDir, file)}: ${hex}`);
  }
  assert.deepEqual(offenders, []);
});

test("tokens.css declares the color, type-scale and spacing tokens the theme is built on", () => {
  const tokens = rootDeclarations(read(tokensPath));
  for (const name of [
    "--color-background",
    "--color-text",
    "--color-text-muted",
    "--color-link",
    "--color-link-hover",
    "--color-button-background",
    "--color-button-background-hover",
    "--color-button-text",
    "--color-focus-ring",
  ]) {
    resolveColor(tokens, name); // throws with a clear message when missing or not a plain colour
  }
  const sizes = [...tokens.keys()].filter((k) => k.startsWith("--font-size-"));
  const spaces = [...tokens.keys()].filter((k) => k.startsWith("--space-"));
  assert.ok(
    sizes.length >= 3,
    `need at least 3 --font-size-* tokens, got ${sizes.join(", ") || "none"}`,
  );
  assert.ok(
    spaces.length >= 3,
    `need at least 3 --space-* tokens, got ${spaces.join(", ") || "none"}`,
  );
});

test("Base.astro loads tokens.css and then global.css", () => {
  const base = stripComments(read(basePath));
  const tokensAt = base.search(/styles\/tokens\.css/);
  const globalAt = base.search(/styles\/global\.css/);
  assert.ok(tokensAt >= 0, "Base.astro must load src/styles/tokens.css");
  assert.ok(globalAt >= 0, "Base.astro must load src/styles/global.css");
  assert.ok(tokensAt < globalAt, "tokens.css must load before global.css");
});

test("global.css is built on the tokens and every var() it or Base.astro uses is defined", () => {
  const tokens = rootDeclarations(read(tokensPath));
  const globalCss = stripComments(read(globalPath));
  const used = (text: string) =>
    [...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);

  const inGlobal = new Set(used(globalCss));
  for (const name of [
    "--color-background",
    "--color-text",
    "--color-link",
    "--color-button-background",
    "--color-button-text",
    "--color-focus-ring",
  ]) {
    assert.ok(inGlobal.has(name), `global.css must use var(${name})`);
  }
  assert.ok(
    [...inGlobal].some((n) => n.startsWith("--font-size-")),
    "global.css must use a --font-size-* token",
  );
  assert.ok(
    [...inGlobal].some((n) => n.startsWith("--space-")),
    "global.css must use a --space-* token",
  );

  const base = read(basePath);
  const missing = [
    ...new Set([
      ...inGlobal,
      ...used(stripComments(styleBlocks(base))),
      ...used(stripComments(base)),
    ]),
  ].filter((n) => !tokens.has(n));
  assert.deepEqual(
    missing,
    [],
    "var() references with no declaration in tokens.css",
  );
});

test("links, buttons and form controls get a visible :focus-visible outline from the focus token", () => {
  const all = rules(read(globalPath));
  for (const el of FOCUSABLES) {
    const covering = all.filter((r) =>
      selectorParts(r.selector).some((p) => focusVisibleCovers(p, el)),
    );
    assert.ok(
      covering.length > 0,
      `no :focus-visible rule in global.css covers <${el}>`,
    );
    const drawn = covering.some(({ decls }) => {
      const shorthand = decls.get("outline");
      if (shorthand !== undefined) {
        return (
          !/^(none|hidden|0(px|em|rem)?)(\s|$)/i.test(shorthand) &&
          shorthand.includes("var(--color-focus-ring")
        );
      }
      const style = decls.get("outline-style");
      const width = decls.get("outline-width");
      const color = decls.get("outline-color");
      return (
        style !== undefined &&
        !/^(none|hidden)$/i.test(style) &&
        (width === undefined || !/^0(px|em|rem)?$/i.test(width)) &&
        color !== undefined &&
        color.includes("var(--color-focus-ring")
      );
    });
    assert.ok(
      drawn,
      `the :focus-visible rule for <${el}> must draw an outline with var(--color-focus-ring)`,
    );
  }
});

test("no rule removes the focus outline without replacing it", () => {
  assert.ok(existsSync(`${srcDir}styles/`), "src/styles/ must exist");
  const sources = [
    read(globalPath),
    styleBlocks(read(basePath)),
    ...readdirSync(`${srcDir}styles/`)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(`${srcDir}styles/${f}`, "utf8")),
  ];
  const removed: string[] = [];
  for (const { selector, decls } of sources.flatMap(rules)) {
    const outline = decls.get("outline");
    const gone =
      (outline !== undefined &&
        /^(none|hidden|0(px|em|rem)?)(\s|$)/i.test(outline)) ||
      /^(none|hidden)$/i.test(decls.get("outline-style") ?? "") ||
      /^0(px|em|rem)?$/.test(decls.get("outline-width") ?? "");
    // `:focus:not(:focus-visible)` hides the ring for mouse clicks only; that is the one allowed form.
    if (gone && !/:focus:not\(\s*:focus-visible\s*\)/.test(selector))
      removed.push(selector);
  }
  assert.deepEqual(removed, []);
});

/** Does this one selector target the placeholder of every input/textarea (bare, `*`, or on input/textarea)? */
function placeholderCovers(part: string): boolean {
  if (!part.endsWith("::placeholder")) return false;
  const head = part.slice(0, -"::placeholder".length);
  const last = head.split(/\s+/).pop()!;
  return (
    last === "" ||
    /^(?:\*|input|textarea)(?:\[[^\]]*\]|\.[\w-]+|:[\w-]+(?:\([^)]*\))?)*$/.test(
      last,
    )
  );
}

test("placeholder text uses a checked text token at full opacity", () => {
  // tokens.css pairs --color-text and --color-text-muted with the background at 4.5:1 (pair test above);
  // an unset placeholder falls back to a browser default outside the tokens, and opacity < 1 would blend
  // the colour below the checked ratio.
  const matching = rules(read(globalPath)).filter(
    ({ selector, decls }) =>
      selectorParts(selector).some(placeholderCovers) &&
      /^var\(\s*--color-text(?:-muted)?\s*\)$/.test(decls.get("color") ?? "") &&
      /^(?:1(?:\.0+)?|100%)$/.test(decls.get("opacity") ?? ""),
  );
  assert.ok(
    matching.length > 0,
    "global.css needs a ::placeholder rule with color: var(--color-text-muted) (or var(--color-text)) and opacity: 1",
  );
});
