// The one reader of a publish route's body, src/lib/request-body.ts (#103). A copy of it in a route behaves just like the
// shared one, so no e2e test can tell them apart: this file calls the reader directly, then reads the two routes' source.
//
// Each expected text is the text the test started from. The limit is written out here and not imported, so that moving it
// is the only thing that keeps this file green.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readBody } from "../src/lib/request-body.ts";

/** 64 * 1024. A body of this many bytes is allowed and one more is not. */
const LIMIT_BYTES = 65_536;

/** One, two, three and four UTF-8 bytes each, so a count of characters comes out short on all but the first. */
const FILLERS = ["x", "é", "沖", "𠮷"];

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELPER = resolve(ROOT, "src/lib/request-body.ts");
const ROUTES = ["src/pages/api/publish/index.ts", "src/pages/api/publish/photos.ts"];

function post(body?: BodyInit): Request {
  return new Request("https://worker.test/api/publish", { method: "POST", body, duplex: "half" } as RequestInit);
}

/** The bytes of `body` in chunks of `size`, as a stream with no length to go by. */
function chunksOf(body: string | Uint8Array, size: number): ReadableStream<Uint8Array> {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at < bytes.length) controller.enqueue(bytes.subarray(at, at + size));
      at += size;
      if (at >= bytes.length) controller.close();
    },
  });
}

/** Each chunk size but the whole body is far below the limit, so the count has to run across them. */
const SENDS: [string, (text: string) => Request][] = [
  ["as a string", (text) => post(text)],
  ["as one chunk", (text) => post(chunksOf(text, Buffer.byteLength(text)))],
  ["in chunks of 1000 bytes", (text) => post(chunksOf(text, 1000))],
  ["in chunks of 7 bytes", (text) => post(chunksOf(text, 7))],
];

/** Text of exactly `bytes` UTF-8 bytes: `filler`, and then "x" where the filler no longer fits. */
function sized(bytes: number, filler: string): string {
  const count = Math.floor(bytes / Buffer.byteLength(filler));
  const text = filler.repeat(count) + "x".repeat(bytes - count * Buffer.byteLength(filler));
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}

/** A read for a failure message, since a body here can be 200 KB. */
function shown(read: string | null): string {
  return read === null ? "null" : `${Buffer.byteLength(read)} bytes of text`;
}

test("a body up to the limit comes back as its text, however it arrives", async () => {
  for (const filler of FILLERS) {
    for (const bytes of [1, 1000, LIMIT_BYTES - 1, LIMIT_BYTES]) {
      for (const [how, send] of SENDS) {
        const text = sized(bytes, filler);
        const read = await readBody(send(text));
        assert.ok(read === text, `${bytes} bytes of "${filler}" padding ${how} read as ${shown(read)}`);
      }
    }
  }
});

test("a body past the limit is null, however it arrives", async () => {
  for (const filler of FILLERS) {
    for (const bytes of [LIMIT_BYTES + 1, 70_000, 200_000]) {
      for (const [how, send] of SENDS) {
        const read = await readBody(send(sized(bytes, filler)));
        assert.ok(read === null, `${bytes} bytes of "${filler}" padding ${how} read as ${shown(read)}`);
      }
    }
  }
});

test("multi-byte characters split across chunks decode intact", async () => {
  // Chunks of one byte split every character, and the other sizes end at every offset into the longer ones.
  const TEXTS = ["é", "沖縄", "𠮷", "バイクを予約する", '{"requestedBy":"沖縄 𠮷 é"}', "𠮷𠮷𠮷"];
  for (const text of TEXTS) {
    for (const size of [1, 2, 3, 4, 5, 6, 7]) {
      assert.equal(await readBody(post(chunksOf(text, size))), text, `chunks of ${size}`);
    }
  }
});

test("bytes that are not UTF-8 come back as text with U+FFFD, however they arrive", async () => {
  // Anyone can send these, and a route has to answer them with its signature check's 401, so the reader neither throws
  // nor refuses them. The expected texts follow the WHATWG decoder: one U+FFFD for each cut-off sequence and one for each
  // byte that can start none. Chunks of one to four bytes end inside every sequence here, and the cut-off ones decode to
  // one U+FFFD only when the reader carries the start of a sequence into the next chunk and flushes at the end.
  const R = "�";
  const OKI = [...Buffer.from("沖")];
  const CASES: [string, number[], string][] = [
    ["a lone 0xFF", [0xff], R],
    ["0xFF between letters", [0x61, 0xff, 0x62], `a${R}b`],
    ["a lone continuation byte", [0x61, 0x80, 0x62], `a${R}b`],
    ["two of the three bytes of 沖 before a letter", [0xe6, 0xb2, 0x41], `${R}A`],
    ["two of the three bytes of 沖 at the end", [0x41, 0xe6, 0xb2], `A${R}`],
    ["three of the four bytes of 𠮷 before a quote", [0xf0, 0xa0, 0xae, 0x22], `${R}"`],
    ["an overlong quote", [0xc0, 0xa2], R.repeat(2)],
    ["an encoded surrogate", [0xed, 0xa0, 0x80], R.repeat(3)],
    ["0xFF between two whole characters", [...OKI, 0xff, ...OKI], `沖${R}沖`],
  ];
  const BYTE_SENDS: [string, (bytes: Uint8Array<ArrayBuffer>) => Request][] = [
    ["as bytes", (bytes) => post(bytes)],
    ...[1, 2, 3, 4].map((size): [string, (bytes: Uint8Array<ArrayBuffer>) => Request] => [
      `in chunks of ${size}`,
      (bytes) => post(chunksOf(bytes, size)),
    ]),
  ];

  for (const [name, bytes, expected] of CASES) {
    for (const [how, send] of BYTE_SENDS) {
      const read = await readBody(send(Uint8Array.from(bytes))).catch((error: Error) => `threw ${error.message}`);
      assert.equal(read, expected, `${name} ${how}`);
    }
  }

  // The limit counts the bytes that arrive and not the text they decode to, which takes three bytes for each U+FFFD.
  const LIMIT_SENDS: [string, (bytes: Uint8Array<ArrayBuffer>) => Request][] = [
    ["as bytes", (bytes) => post(bytes)],
    ["in chunks of 1000 bytes", (bytes) => post(chunksOf(bytes, 1000))],
  ];
  for (const [how, send] of LIMIT_SENDS) {
    const at = await readBody(send(Buffer.alloc(LIMIT_BYTES, 0xff)));
    assert.ok(at === R.repeat(LIMIT_BYTES), `${LIMIT_BYTES} bytes of 0xFF ${how} read as ${shown(at)}`);
    const past = await readBody(send(Buffer.alloc(LIMIT_BYTES + 1, 0xff)));
    assert.ok(past === null, `${LIMIT_BYTES + 1} bytes of 0xFF ${how} read as ${shown(past)}`);
  }
});

test("a null body gives an empty string and not the null of a refusal", async () => {
  assert.equal(post().body, null);

  const EMPTY: [string, Request][] = [
    ["no body", post()],
    ["an empty string", post("")],
    ["an empty stream", post(chunksOf("", 1))],
  ];
  for (const [name, request] of EMPTY) {
    assert.equal(await readBody(request), "", name);
  }
});

test("reading stops once the body is past the limit", async () => {
  // A stream hands over one chunk when asked and keeps one more ready, which is all a reader that stops can have cost it.
  const READ_AHEAD = 1;

  for (const size of [1024, 16 * 1024, LIMIT_BYTES, 70_000]) {
    const needed = Math.ceil((LIMIT_BYTES + 1) / size);
    // The source ends, so a reader that goes to the end and then measures still finishes, and shows how far it went.
    const available = needed + 64;
    const chunk = Buffer.alloc(size, "x");

    let pulled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        pulled += 1;
        if (pulled === available) controller.close();
      },
    });

    assert.equal(await readBody(post(source)), null, `chunks of ${size}`);
    assert.ok(pulled >= needed, `chunks of ${size}: only ${pulled} chunks pulled, which never reached the limit`);
    assert.ok(pulled <= needed + READ_AHEAD, `chunks of ${size}: ${pulled} chunks pulled, ${needed} were enough`);
  }
});

// The checks below go by the syntax tree, so what counts is the code and not its layout: a comment or a string that names
// these things is not a copy of them, and a line break or a change of quotes does not hide one.

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

/** What `source` imports from the file at `module`, by the names that file exports them under. */
function importedFrom(source: ts.SourceFile, module: string): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (resolve(dirname(source.fileName), statement.moduleSpecifier.text) !== module) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      names.push(...bindings.elements.map((element) => (element.propertyName ?? element.name).text));
    }
  }
  return names;
}

/** Each of these on a request reads its body, or in the case of `clone` makes something that reads the same bytes. */
const BODY_READERS = ["arrayBuffer", "blob", "body", "bytes", "clone", "formData", "json", "text"];

function isRequest(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === "request" || node.text === "req";
  return ts.isPropertyAccessExpression(node) && node.name.text === "request";
}

/** `65536`, `65_536`, `64 * 1024`, `1024 * 64`: the limit, whatever a copy of it is called. */
function isLimit(node: ts.Node): boolean {
  if (ts.isNumericLiteral(node)) return Number(node.text) === LIMIT_BYTES;
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.AsteriskToken) return false;
  const { left, right } = node;
  return ts.isNumericLiteral(left) && ts.isNumericLiteral(right) && Number(left.text) * Number(right.text) === LIMIT_BYTES;
}

/** The parts of a body reader in `source`, one line for each place. */
function readerParts(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isRequest(node.expression) && BODY_READERS.includes(node.name.text)) {
      found.push(`reads ${node.getText()}`);
    } else if (ts.isNewExpression(node) && node.expression.getText().startsWith("TextDecoder")) {
      found.push(`decodes with ${node.getText()}`);
    } else if (ts.isVariableDeclaration(node) && node.name.getText() === "MAX_BODY_BYTES") {
      found.push("defines MAX_BODY_BYTES");
    } else if (isLimit(node)) {
      found.push(`spells out the limit as ${node.getText()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("both publish routes import readBody from the one module", () => {
  for (const route of ROUTES) {
    const names = importedFrom(parse(resolve(ROOT, route)), HELPER);
    assert.ok(names.includes("readBody"), `${route} does not import readBody from src/lib/request-body.ts`);
  }
});

test("neither publish route keeps its own limit or reads the body itself", () => {
  // The same search has to find the reader where it does live, or the empty lists below would prove nothing.
  assert.notDeepEqual(readerParts(parse(HELPER)), [], "the search found no reader in the helper");

  for (const route of ROUTES) {
    assert.deepEqual(readerParts(parse(resolve(ROOT, route))), [], route);
  }
});
