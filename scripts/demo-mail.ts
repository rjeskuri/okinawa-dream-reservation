// Renders the emails in the local D1 outbox to files, so a local booking's mail (the cancel link included) can be read
// without the Apps Script mail web app. Run from the repo root: `node scripts/demo-mail.ts`. docs/local-dev.md says how.
// Output goes to DEMO_MAIL_DIR (default .demo-mail, gitignored: it holds test guest data), as <outbox id>.html and .txt.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderEmail } from "../src/lib/mail/templates.ts";
import type { EmailPayload } from "../src/lib/outbox.ts";

const SQL = "SELECT id, payload FROM outbox WHERE kind = 'email' ORDER BY id";

const outDir = process.env.DEMO_MAIL_DIR || ".demo-mail";

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function readEmailRows(): { id: number; payload: EmailPayload }[] {
  const stdout = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", SQL], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const results = (JSON.parse(stdout) as { results?: { id: number; payload: string }[] }[])[0]?.results;
  if (!Array.isArray(results)) throw new Error("wrangler printed no results");
  return results.map((row) => ({ id: row.id, payload: JSON.parse(row.payload) as EmailPayload }));
}

// Everything is rendered before anything is written, so a bad row leaves the directory as it was.
const files = readEmailRows().map(({ id, payload }) => {
  const { subject, text, html } = renderEmail(payload);
  return {
    id,
    html: `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>\n<body>\n${html}\n</body></html>\n`,
    text: `Subject: ${subject}\n\n${text}\n`,
  };
});

if (files.length > 0) mkdirSync(outDir, { recursive: true });
for (const file of files) {
  writeFileSync(join(outDir, `${file.id}.html`), file.html);
  writeFileSync(join(outDir, `${file.id}.txt`), file.text);
}
console.log(`${files.length} email(s) written to ${outDir}`);
