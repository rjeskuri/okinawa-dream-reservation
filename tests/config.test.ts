// wrangler.jsonc declares what the Worker, the e2e helper and the deploy rely on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Strips line and block comments that sit outside string literals, so JSON.parse can read JSONC. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_flags?: string[];
  d1_databases?: { binding: string; migrations_dir?: string }[];
  r2_buckets?: { binding: string }[];
  triggers?: { crons?: string[] };
  vars?: Record<string, string>;
}

function readWranglerConfig(): WranglerConfig {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  return JSON.parse(stripJsonComments(raw)) as WranglerConfig;
}

test("wrangler.jsonc declares main, DB, MEDIA, nodejs_compat and both crons", () => {
  const config = readWranglerConfig();
  assert.equal(config.name, "okinawa-dream");
  assert.equal(config.main, "src/worker.ts");
  assert.ok(config.compatibility_flags?.includes("nodejs_compat"), "nodejs_compat is missing");
  const db = config.d1_databases?.find((d) => d.binding === "DB");
  assert.ok(db, "no D1 binding named DB");
  assert.equal(db.migrations_dir, "migrations");
  assert.ok(config.r2_buckets?.some((b) => b.binding === "MEDIA"), "no R2 binding named MEDIA");
  assert.deepEqual(config.triggers?.crons, ["*/10 * * * *", "0 18 * * *"]);
});

test("SQUARE_WEBHOOK_URL points at the webhook route", () => {
  const url = readWranglerConfig().vars?.SQUARE_WEBHOOK_URL;
  assert.ok(url, "wrangler.jsonc declares no SQUARE_WEBHOOK_URL");
  assert.equal(new URL(url).pathname, "/api/webhooks/square");
});

test("the dev server allows quick-tunnel hosts", async () => {
  const { default: config } = await import("../astro.config.mjs");
  // Astro also accepts `server` as a function of the command.
  const server = typeof config.server === "function" ? config.server({ command: "dev" }) : config.server;
  const allowedHosts = server?.allowedHosts;
  assert.notEqual(allowedHosts, true, "server.allowedHosts: true would allow every host");
  assert.ok(Array.isArray(allowedHosts), `server.allowedHosts is ${JSON.stringify(allowedHosts)}, not a list`);
  assert.ok(allowedHosts.includes(".trycloudflare.com"), `.trycloudflare.com is not in ${JSON.stringify(allowedHosts)}`);
});

test("stripJsonComments leaves comment-like text inside strings alone", () => {
  const text = '{ // a comment\n "url": "http://x/y", /* block */ "n": 1 }';
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { url: "http://x/y", n: 1 });
});
