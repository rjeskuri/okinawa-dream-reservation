// Reading rendered pages in e2e tests: tags with their attributes, the text a reader sees, and a page cut into its
// named sections and blocks, so an assertion can tie facts together without fixing the markup or the wording.

export function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLowerCase()] ?? "";
  });
}

export interface Tag {
  name: string;
  index: number;
  attributes: Record<string, string>;
}

/** Every start tag in `html`, in document order, with lower-case names and decoded attribute values. */
export function tagsIn(html: string): Tag[] {
  const tag = /<([a-z][a-z0-9-]*)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  return [...html.matchAll(tag)].map((match) => {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[2] ?? "").matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      attributes[String(attribute[1]).toLowerCase()] = decodeEntities(value);
    }
    return { name: String(match[1]).toLowerCase(), index: match.index, attributes };
  });
}

/** `html` without comments, scripts or styles. */
export function withoutCode(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
}

/** The text a reader sees, with full-width digits, letters and symbols (１２％, ：) folded to ASCII. */
export function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/** The content of `<main>`, without comments, scripts or styles. */
export function mainOf(html: string, label: string): string {
  const main = withoutCode(html).match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1];
  if (main === undefined) throw new Error(`${label} has no <main>`);
  return main;
}

/** Each named section's HTML, from the element with that id to the next named one or the end of `html`. */
export function sectionsIn<Anchor extends string>(
  html: string,
  anchors: readonly Anchor[],
  label: string,
): Record<Anchor, string> {
  const marks = tagsIn(html).filter(({ attributes }) => (anchors as readonly string[]).includes(attributes.id ?? ""));
  const sections = {} as Record<Anchor, string>;
  for (const anchor of anchors) {
    const start = marks.find(({ attributes }) => attributes.id === anchor);
    if (start === undefined) throw new Error(`${label} has no element with id="${anchor}"`);
    const next = marks.find(({ index }) => index > start.index);
    sections[anchor] = html.slice(start.index, next?.index ?? html.length);
  }
  return sections;
}

/** A section's blocks in order. Headings and `<dt>` stay with the text below them. */
export function blocksOf(section: string): string[] {
  return section
    .split(/<\/(?:li|tr|p|dd)\s*>/i)
    .map(visibleText)
    .filter((block) => block !== "");
}

/** The section's text without its headings, so an anchor on a lone heading does not count as content. */
export function bodyOf(section: string): string {
  return visibleText(section.replace(/<h[1-6]\b[\s\S]*?<\/h[1-6]\s*>/gi, " "));
}
