// The four-language routing, through the built Worker: the root redirect, the locale pages, unknown locales
// and the language switcher.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { startWorker, type TestWorker } from "../helpers/worker.ts";

const base = "http://localhost/";

let worker: TestWorker;

before(async () => {
  worker = await startWorker();
});

after(async () => {
  await worker?.stop();
});

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLowerCase()] ?? "";
  });
}

/** The attributes of every `name` tag in `html`, with lower-case names and decoded values. */
function tagsNamed(html: string, name: string): Record<string, string>[] {
  const tag = new RegExp(`<${name}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, "gi");
  return [...html.matchAll(tag)].map((match) => {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[1] ?? "").matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      attributes[String(attribute[1]).toLowerCase()] = decodeEntities(value);
    }
    return attributes;
  });
}

/** The text a reader sees in the page body. */
function visibleText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("root redirects by Accept-Language", async () => {
  // `null` sends no header of our own. Node's fetch then adds `Accept-Language: *`, and an empty value is dropped.
  const table: [string | null, string][] = [
    // The definition of done.
    ["ja", "/ja/"],
    ["ko-KR", "/ko/"],
    ["zh-CN", "/zh-cn/"],
    ["zh-Hans", "/zh-cn/"],
    ["zh-TW", "/zh-cn/"],
    ["zh-HK", "/zh-cn/"],
    ["en-US", "/en/"],
    ["fr", "/en/"],
    // Regions, and the header as browsers send it.
    ["ja-JP", "/ja/"],
    ["ko", "/ko/"],
    ["de-DE,de;q=0.9,ja;q=0.8", "/ja/"],
    ["ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7", "/ko/"],
    // q-values and case.
    ["ja;q=0.2, ko;q=0.8", "/ko/"],
    ["ko;q=0.2, ja;q=0.8", "/ja/"],
    ["ko;q=0, ja", "/ja/"],
    ["KO-kr", "/ko/"],
    // Nothing usable.
    [null, "/en/"],
    ["", "/en/"],
    ["*", "/en/"],
    ["garbage;;;", "/en/"],
    ["//evil.example/", "/en/"],
  ];
  for (const [header, target] of table) {
    const headers: Record<string, string> = header === null ? {} : { "Accept-Language": header };
    const label = `Accept-Language: ${JSON.stringify(header)}`;

    const res = await worker.fetch("/", { headers, redirect: "manual" });
    await res.text();
    assert.equal(res.status, 302, label);

    const location = res.headers.get("location");
    assert.ok(location, `${label}: no Location header`);
    const url = new URL(location, base);
    assert.equal(url.pathname + url.search, target, label);

    const vary = (res.headers.get("vary") ?? "").split(",").map((field) => field.trim().toLowerCase());
    assert.ok(vary.includes("accept-language"), `${label}: Vary is ${JSON.stringify(res.headers.get("vary"))}`);

    // The target renders; it does not redirect again.
    const landed = await worker.fetch(url.pathname, { headers, redirect: "manual" });
    await landed.text();
    assert.equal(landed.status, 200, `${label}: ${target}`);
  }

  // The query string survives the redirect.
  const queries: [string, string, string][] = [
    ["/?utm=x&b=1", "ko", "/ko/?utm=x&b=1"],
    ["/?utm=x&b=1", "ja-JP", "/ja/?utm=x&b=1"],
    ["/?q=%E6%B2%96%20a&next=/ja/", "zh-TW", "/zh-cn/?q=%E6%B2%96%20a&next=/ja/"],
    ["/?b=2&a=1&a=0", "fr", "/en/?b=2&a=1&a=0"],
  ];
  for (const [path, header, target] of queries) {
    const res = await worker.fetch(path, { headers: { "Accept-Language": header }, redirect: "manual" });
    await res.text();
    assert.equal(res.status, 302, `${path} with ${header}`);

    const location = res.headers.get("location");
    assert.ok(location, `${path} with ${header}: no Location header`);
    const url = new URL(location, base);
    assert.equal(url.pathname + url.search, target, `${path} with ${header}`);
  }
});

test("locale pages set lang and hreflang", async () => {
  const langs: Record<Locale, string> = { ja: "ja", en: "en", "zh-cn": "zh-CN", ko: "ko" };
  const texts = new Set<string>();

  for (const [index, locale] of LOCALES.entries()) {
    // The header of another locale must not move a reader who chose this one.
    const otherLocale = LOCALES[(index + 1) % LOCALES.length] as Locale;
    const res = await worker.fetch(`/${locale}/`, {
      headers: { "Accept-Language": otherLocale },
      redirect: "manual",
    });
    const html = await res.text();
    assert.equal(res.status, 200, locale);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/, locale);

    const [htmlTag] = tagsNamed(html, "html");
    assert.equal(htmlTag?.lang, langs[locale], `/${locale}/ <html lang>`);

    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    assert.notEqual(title.trim(), "", `/${locale}/ has no <title>`);

    const alternates = tagsNamed(html, "link").filter(
      (link) => (link.rel ?? "").toLowerCase().split(/\s+/).includes("alternate") && "hreflang" in link,
    );
    // hreflang values ignore case, so this accepts zh-cn as well as zh-CN.
    assert.deepEqual(
      alternates.map((link) => String(link.hreflang).toLowerCase()).sort(),
      ["en", "ja", "ko", "x-default", "zh-cn"],
      `/${locale}/ hreflang set`,
    );

    const hrefs = new Map(alternates.map((link) => [String(link.hreflang).toLowerCase(), String(link.href)]));
    for (const href of hrefs.values()) {
      // Search engines ignore relative alternates.
      assert.match(href, /^https?:\/\//, `/${locale}/ hreflang href ${href} is not absolute`);
    }
    for (const target of LOCALES) {
      assert.equal(new URL(hrefs.get(target) ?? "", base).pathname, `/${target}/`, `/${locale}/ hreflang ${target}`);
    }

    // x-default names the page for readers with no matching language: the negotiating root.
    const fallback = new URL(hrefs.get("x-default") ?? "", base).pathname;
    assert.equal(fallback, "/", `/${locale}/ x-default points at ${fallback}`);
    const answer = await worker.fetch(fallback, { redirect: "manual" });
    await answer.text();
    assert.equal(answer.status, 302, `x-default ${fallback} answered ${answer.status}`);

    texts.add(visibleText(html));
  }

  assert.equal(texts.size, LOCALES.length, "two locales render the same page text");
});

test("unknown locales return 404", async () => {
  // Without these the test would pass on a site with no locale routes at all.
  for (const locale of LOCALES) {
    const res = await worker.fetch(`/${locale}/`, { redirect: "manual" });
    await res.text();
    assert.equal(res.status, 200, `/${locale}/`);
  }

  const unknown = [
    "/fr/",
    "/fr",
    "/fr/?lang=ja",
    "/fr/rentals",
    "/de/",
    "/th/",
    "/xx/",
    // Near misses of the four codes. Locales are lower case, as isLocale() has them.
    "/zh/",
    "/zh-tw/",
    "/zh-hans/",
    "/zh_cn/",
    "/zh-CN/",
    "/ZH-CN/",
    "/JA/",
    "/En/",
    "/en-us/",
    "/ja-jp/",
    "/ko-kr/",
    "/jp/",
    "/kr/",
    "/cn/",
    // Names every object inherits, for a guard built on a lookup.
    "/constructor/",
    "/toString/",
    "/__proto__/",
    "/hasOwnProperty/",
    "/length/",
    "/0/",
    // Not codes at all.
    "/%E6%97%A5%E6%9C%AC/",
    "/ja%20/",
    // A known locale with a page that does not exist.
    "/ja/no-such-page",
  ];
  for (const path of unknown) {
    const res = await worker.fetch(path, { redirect: "manual" });
    await res.text();
    assert.equal(res.status, 404, path);
  }

  // API routes have no locale prefix, and locale routing must leave them alone.
  const health = await worker.fetch("/api/health", { redirect: "manual" });
  assert.equal(health.status, 200, "/api/health");
  assert.deepEqual(await health.json(), { ok: true, db: true });
});

test("the switcher keeps path and query", async () => {
  const queries = [
    "",
    "?tab=faq&page=2",
    // Non-ASCII, a space, a repeated key, and values holding the query's own delimiters.
    "?q=%E6%B2%96%E7%B8%84%20%E3%83%90%E3%82%A4%E3%82%AF&tag=a%26b%3Dc&tag=x%2By",
    // Values that look like the locale prefix, for a replace over the whole URL.
    "?next=/ja/rentals&en=/en/&zh=/zh-cn/&ko=/ko/",
    // Markup in the query must stay data.
    '?q="><script>alert(1)</script>',
    '?q=" onmouseover="alert(1)',
  ];
  for (const locale of LOCALES) {
    for (const query of queries) {
      const path = `/${locale}/${query}`;
      const res = await worker.fetch(path, { redirect: "manual" });
      const html = await res.text();
      assert.equal(res.status, 200, path);

      assert.doesNotMatch(html, /<script>alert\(1\)/, `${path} reflects the query as markup`);
      for (const tag of [...tagsNamed(html, "a"), ...tagsNamed(html, "link")]) {
        assert.ok(!("onmouseover" in tag), `${path} reflects the query as an attribute`);
      }

      const page = new URL(path, base);
      const links = tagsNamed(html, "a").flatMap((a) => (a.href === undefined ? [] : [new URL(a.href, page)]));
      const expected = [...page.searchParams];
      // A switcher may render its current locale as plain text, so only the other three must be links.
      for (const target of LOCALES.filter((code) => code !== locale)) {
        const found = links.filter((link) => link.pathname === `/${target}/`);
        assert.ok(
          found.some((link) => JSON.stringify([...link.searchParams]) === JSON.stringify(expected)),
          `${path}: no link to /${target}/ with query ${JSON.stringify(expected)}; ` +
            `links there: ${JSON.stringify(found.map((link) => link.search))}`,
        );
      }
    }
  }
});
