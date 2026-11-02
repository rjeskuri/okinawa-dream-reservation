// Runs the real src/scripts/checkout.ts under Node, on a page parsed from HTML, with a fake Square SDK, a fake fetch and a
// mocked clock. tests/checkout-client.test.ts opens `fakeHoldPage`, tests/e2e/checkout.e2e.ts opens the page the Worker
// rendered, and both go through `openCheckout`, which refuses a page that `readHoldPage` cannot read. So the fake page and
// the real one cannot drift apart.
//
// The seam, which is all the client reads from the page:
//   <form id="checkout"> carries data-booking-id, data-locale (the URL's), data-deposit-jpy, data-sdk-url,
//   data-application-id, data-location-id and data-expires-at (epoch ms). A native submit of it puts no guest detail in a
//   URL, whatever the client does or fails to do: its inputs are named, so a GET would write them there. It holds:
//     inputs named familyName, givenName, email and phone, and for each an element data-error-for="<that name>";
//     #card-container, the mount for card.attach;
//     #checkout-message, where the client speaks to the guest;
//     #pay-button, a submit <button>, rendered disabled, which only a mounted card makes live.
//   #countdown, anywhere on the page, which the client keeps filled with the time left, as 12:05 or 12分05秒.
// The error elements and #checkout-message show no text until the client fills them.
//
// What the client has to do with it:
// - start itself on import, as plain code, since this DOM has no customElements. An Astro <script> is a deferred module: it
//   runs at readyState "interactive", and then DOMContentLoaded, load and pageshow fire. Nothing else does, so no
//   astro:page-load;
// - take the form's submit from the moment it runs, before anything it has to wait for, and prevent every one from then on,
//   in every state of the page;
// - load the SDK by adding a <script> whose src is data-sdk-url, and wait for its load event to reach window.Square. An
//   error event on that script, a missing window.Square or a refusal from Square is a failure the guest hears about;
// - take its own words from src/i18n/strings/checkout.ts in data-locale, since the page carries none for it;
// - show and hide with the `hidden` attribute, the only styling this DOM reads.
//
// The DOM is the part of the real thing a client like this uses. A selector it cannot read throws.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { decodeEntities, tagsIn, type Tag } from "./html.ts";

export const GUEST_FIELDS = ["familyName", "givenName", "email", "phone"] as const;

export type GuestField = (typeof GUEST_FIELDS)[number];
export type Guest = Record<GuestField, string>;

/** What the client reads from the page. */
export type HoldPage = {
  bookingId: string;
  locale: string;
  depositJpy: number;
  sdkUrl: string;
  applicationId: string;
  locationId: string;
  expiresAt: number;
};

const CLIENT = new URL("../../src/scripts/checkout.ts", import.meta.url).href;
const SITE = "https://okinawa-dream.example";

/** Captured here because a mocked clock must not stop the page's promises from settling. */
const nextTurn = globalThis.setImmediate;

// ---- The clock

type Timer = { id: number; at: number; every: number | null; run: () => void };

/**
 * What the timers below hand back. A page only passes it to clear, but the globals are the whole process's, and the
 * Miniflare client behind the e2e database calls unref on what setTimeout gives it.
 */
class TimerHandle {
  readonly id: number;

  constructor(id: number) {
    this.id = id;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  hasRef(): boolean {
    return false;
  }

  refresh(): this {
    return this;
  }

  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

/**
 * setTimeout and setInterval on a clock the test moves. Node's mock catches an interval up with a call for every period a
 * jump skipped, which lets a counter keep perfect time. A sleeping tab fires once on waking, and that is what this does.
 */
class FakeClock {
  #timers = new Map<number, Timer>();
  #lastId = 0;
  #now: number;
  #setDate: (ms: number) => void;

  constructor(now: number, setDate: (ms: number) => void) {
    this.#now = now;
    this.#setDate = setDate;
  }

  setTimeout = (run: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): TimerHandle =>
    this.#add(() => run(...args), ms, null);

  setInterval = (run: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): TimerHandle =>
    this.#add(() => run(...args), ms, Math.max(ms, 1));

  clear = (handle?: TimerHandle | number): void => {
    if (handle !== undefined) this.#timers.delete(Number(handle));
  };

  #add(run: () => void, ms: number, every: number | null): TimerHandle {
    this.#lastId += 1;
    this.#timers.set(this.#lastId, { id: this.#lastId, at: this.#now + Math.max(ms, 0), every, run });
    return new TimerHandle(this.#lastId);
  }

  #moveTo(ms: number): void {
    this.#now = ms;
    this.#setDate(ms);
  }

  /** Time passes with the page awake, and each timer fires as it comes due. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.values()].filter((timer) => timer.at <= end);
      const [next] = due.sort((a, b) => a.at - b.at || a.id - b.id);
      if (next === undefined) break;
      this.#moveTo(Math.max(this.#now, next.at));
      if (next.every === null) this.#timers.delete(next.id);
      else next.at = this.#now + next.every;
      next.run();
    }
    this.#moveTo(end);
  }

  /** Time passes with the tab asleep. Nothing fires, and what came due fires once when the page next runs. */
  sleep(ms: number): void {
    this.#moveTo(this.#now + ms);
  }
}

// ---- Events

type Handler = ((event: FakeEvent) => unknown) | { handleEvent(event: FakeEvent): unknown };
type ListenerOptions = boolean | { once?: boolean; capture?: boolean; passive?: boolean };

export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly submitter: FakeElement | null;
  defaultPrevented = false;
  stopped = false;
  target: FakeTarget | null = null;
  currentTarget: FakeTarget | null = null;

  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; submitter?: FakeElement | null } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
    this.submitter = init.submitter ?? null;
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.stopped = true;
  }

  stopImmediatePropagation(): void {
    this.stopped = true;
  }
}

class FakeTarget {
  #listeners = new Map<string, { handler: Handler; once: boolean }[]>();

  addEventListener(type: string, handler: Handler | null, options?: ListenerOptions): void {
    const listeners = this.#listeners.get(type) ?? [];
    if (handler === null || listeners.some((listener) => listener.handler === handler)) return;
    const once = typeof options === "object" && options.once === true;
    this.#listeners.set(type, [...listeners, { handler, once }]);
  }

  removeEventListener(type: string, handler: Handler | null): void {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(
      type,
      listeners.filter((listener) => listener.handler !== handler),
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target = this;
    let at: FakeTarget | null = this;
    while (at !== null && !event.stopped) {
      at.#fire(event);
      at = event.bubbles ? at.eventParent() : null;
    }
    return !event.defaultPrevented;
  }

  eventParent(): FakeTarget | null {
    return null;
  }

  #fire(event: FakeEvent): void {
    event.currentTarget = this;
    const property = (this as unknown as Record<string, unknown>)[`on${event.type}`];
    if (typeof property === "function") property.call(this, event);
    for (const { handler, once } of this.#listeners.get(event.type) ?? []) {
      if (once) this.removeEventListener(event.type, handler);
      if (typeof handler === "function") handler.call(this, event);
      else handler.handleEvent(event);
    }
  }
}

// ---- Selectors: tags, #ids, .classes, [attributes], commas, descendants and >

type Step = { combinator: string; parts: string[] };

const SIMPLE_SELECTOR = /\*|#[\w-]+|\.[\w-]+|\[[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\]]*))?\]|[a-z][\w-]*/gi;

function compoundParts(text: string, selector: string): string[] {
  const parts = text.match(SIMPLE_SELECTOR) ?? [];
  if (parts.join("") !== text) throw new Error(`tests/helpers/checkout-client.ts cannot read the selector ${selector}`);
  return parts;
}

function parseSelector(selector: string): Step[][] {
  const groups: Step[][] = [[]];
  let combinator = " ";
  let word = "";
  let depth = 0;
  const flush = (): void => {
    if (word === "") return;
    (groups.at(-1) as Step[]).push({ combinator, parts: compoundParts(word, selector) });
    word = "";
    combinator = " ";
  };
  for (const char of selector) {
    if (char === "[") depth += 1;
    if (depth > 0) {
      word += char;
      if (char === "]") depth -= 1;
    } else if (char === ",") {
      flush();
      groups.push([]);
    } else if (char === ">") {
      flush();
      combinator = ">";
    } else if (/\s/.test(char)) {
      flush();
    } else {
      word += char;
    }
  }
  flush();
  return groups;
}

function matchesPart(element: FakeElement, part: string): boolean {
  if (part === "*") return true;
  if (part.startsWith("#")) return element.id === part.slice(1);
  if (part.startsWith(".")) return element.classList.contains(part.slice(1));
  if (part.startsWith("[")) {
    const [, name, value] = part.match(/^\[([\w-]+)(?:=["']?(.*?)["']?)?\]$/) as RegExpMatchArray;
    const attribute = element.getAttribute(name as string);
    return value === undefined ? attribute !== null : attribute === value;
  }
  return element.localName === part.toLowerCase();
}

function matchesSteps(element: FakeElement, steps: Step[], index: number = steps.length - 1): boolean {
  const step = steps[index] as Step;
  if (!step.parts.every((part) => matchesPart(element, part))) return false;
  if (index === 0) return true;
  let parent = element.parentElement;
  if (step.combinator === ">") return parent !== null && matchesSteps(parent, steps, index - 1);
  for (; parent !== null; parent = parent.parentElement) {
    if (matchesSteps(parent, steps, index - 1)) return true;
  }
  return false;
}

// ---- The DOM

export class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  data: string;

  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(text: string) {
    this.data = String(text);
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

type Child = FakeElement | FakeText;

function dataAttribute(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function datasetKey(attribute: string): string {
  return attribute.slice("data-".length).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function fakeStyle(): Record<string, unknown> {
  const style: Record<string, unknown> = {
    display: "",
    setProperty(name: string, value: string) {
      style[name] = value;
    },
    removeProperty(name: string) {
      style[name] = "";
    },
  };
  return style;
}

export class FakeElement extends FakeTarget {
  declare id: string;
  declare name: string;
  declare src: string;
  declare href: string;
  declare hidden: boolean;
  declare disabled: boolean;

  readonly nodeType: number = 1;
  readonly localName: string;
  readonly ownerDocument: FakeDocument;
  readonly childNodes: Child[] = [];
  readonly style = fakeStyle();
  readonly dataset: Record<string, string | undefined>;
  parentNode: FakeElement | null = null;
  #attributes = new Map<string, string>();
  #value: string | undefined;

  constructor(localName: string, ownerDocument: FakeDocument | null) {
    super();
    this.localName = localName;
    this.ownerDocument = ownerDocument ?? (this as unknown as FakeDocument);
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_, key) => (typeof key === "string" ? (this.getAttribute(dataAttribute(key)) ?? undefined) : undefined),
      set: (_, key, value) => {
        this.setAttribute(dataAttribute(String(key)), String(value));
        return true;
      },
      has: (_, key) => this.hasAttribute(dataAttribute(String(key))),
      deleteProperty: (_, key) => {
        this.removeAttribute(dataAttribute(String(key)));
        return true;
      },
      ownKeys: () => this.getAttributeNames().filter((name) => name.startsWith("data-")).map(datasetKey),
      getOwnPropertyDescriptor: (_, key) => ({
        configurable: true,
        enumerable: true,
        value: this.getAttribute(dataAttribute(String(key))) ?? undefined,
      }),
    });
  }

  override eventParent(): FakeTarget | null {
    return this.parentNode;
  }

  get tagName(): string {
    return this.localName.toUpperCase();
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name.toLowerCase(), String(value));
  }

  hasAttribute(name: string): boolean {
    return this.#attributes.has(name.toLowerCase());
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name.toLowerCase());
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name);
    if (on && !this.hasAttribute(name)) this.setAttribute(name, "");
    if (!on) this.removeAttribute(name);
    return on;
  }

  getAttributeNames(): string[] {
    return [...this.#attributes.keys()];
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  set className(names: string) {
    this.setAttribute("class", names);
  }

  get classList() {
    const read = (): string[] => this.className.split(/\s+/).filter((name) => name !== "");
    const write = (names: string[]): void => {
      this.className = [...new Set(names)].join(" ");
    };
    return {
      contains: (name: string) => read().includes(name),
      add: (...names: string[]) => write([...read(), ...names]),
      remove: (...names: string[]) => write(read().filter((name) => !names.includes(name))),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !read().includes(name);
        write(on ? [...read(), name] : read().filter((other) => other !== name));
        return on;
      },
    };
  }

  /** As in a browser, a button without a type submits its form. */
  get type(): string {
    const fallback: Record<string, string> = { button: "submit", input: "text" };
    return this.getAttribute("type") ?? fallback[this.localName] ?? "";
  }

  set type(type: string) {
    this.setAttribute("type", type);
  }

  get value(): string {
    return this.#value ?? this.getAttribute("value") ?? (this.localName === "textarea" ? this.textContent : "");
  }

  set value(value: string) {
    this.#value = String(value);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(text: string | null) {
    this.replaceChildren(...(text === null || text === "" ? [] : [new FakeText(String(text))]));
  }

  get innerText(): string {
    return this.textContent;
  }

  set innerText(text: string | null) {
    this.textContent = text;
  }

  get innerHTML(): string {
    return this.textContent;
  }

  set innerHTML(html: string) {
    this.replaceChildren();
    parseInto(this, html);
  }

  get parentElement(): FakeElement | null {
    return this.parentNode === null || this.parentNode === this.ownerDocument ? null : this.parentNode;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((child) => child instanceof FakeElement);
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get isConnected(): boolean {
    let at: FakeElement | null = this;
    while (at.parentNode !== null) at = at.parentNode;
    return at === this.ownerDocument;
  }

  contains(node: Child | null): boolean {
    for (let at = node as FakeElement | null; at !== null; at = at.parentNode) {
      if (at === this) return true;
    }
    return false;
  }

  appendChild<T extends Child>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends Child>(child: T, before: Child | null): T {
    child.remove();
    child.parentNode = this;
    const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild<T extends Child>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  append(...nodes: (Child | string)[]): void {
    for (const node of nodes) this.appendChild(typeof node === "string" ? new FakeText(node) : node);
  }

  prepend(...nodes: (Child | string)[]): void {
    const first = this.childNodes[0] ?? null;
    for (const node of nodes) this.insertBefore(typeof node === "string" ? new FakeText(node) : node, first);
  }

  replaceChildren(...nodes: (Child | string)[]): void {
    for (const child of [...this.childNodes]) child.remove();
    this.append(...nodes);
  }

  replaceWith(...nodes: (Child | string)[]): void {
    const parent = this.parentNode;
    if (parent === null) return;
    for (const node of nodes) parent.insertBefore(typeof node === "string" ? new FakeText(node) : node, this);
    this.remove();
  }

  *#descendants(): Generator<FakeElement> {
    for (const child of this.childNodes) {
      if (child instanceof FakeElement) {
        yield child;
        yield* child.#descendants();
      }
    }
  }

  querySelectorAll(selector: string): FakeElement[] {
    const groups = parseSelector(selector);
    return [...this.#descendants()].filter((element) => groups.some((steps) => matchesSteps(element, steps)));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getElementsByTagName(name: string): FakeElement[] {
    return this.querySelectorAll(name);
  }

  matches(selector: string): boolean {
    return parseSelector(selector).some((steps) => matchesSteps(this, steps));
  }

  closest(selector: string): FakeElement | null {
    for (let at: FakeElement | null = this; at !== null; at = at.parentElement) {
      if (at.matches(selector)) return at;
    }
    return null;
  }

  get form(): FakeElement | null {
    return this.closest("form");
  }

  get elements() {
    const controls = this.querySelectorAll("input, select, textarea, button");
    const named = Object.fromEntries(controls.flatMap((control) => (control.name === "" ? [] : [[control.name, control]])));
    return Object.assign([...controls], named, { namedItem: (name: string) => named[name] ?? null });
  }

  /** The browser's own check. The client's validateGuest is what these tests are after, so nothing fails it here. */
  checkValidity(): boolean {
    return true;
  }

  reportValidity(): boolean {
    return true;
  }

  setCustomValidity(): void {}

  focus(): void {}

  blur(): void {}

  select(): void {}

  scrollIntoView(): void {}

  click(): void {
    click(this);
  }

  requestSubmit(submitter?: FakeElement): void {
    const submit = new FakeEvent("submit", { bubbles: true, cancelable: true, submitter: submitter ?? null });
    this.dispatchEvent(submit);
    assert.ok(submit.defaultPrevented, "the submit was not prevented, so the browser would post the form and leave");
  }

  submit(): void {
    assert.fail("form.submit() posts the form to the server and leaves the page");
  }
}

for (const name of ["id", "name", "src", "href", "title", "lang", "role", "placeholder", "autocomplete"]) {
  Object.defineProperty(FakeElement.prototype, name, {
    get(this: FakeElement) {
      return this.getAttribute(name) ?? "";
    },
    set(this: FakeElement, value: string) {
      this.setAttribute(name, value);
    },
  });
}

for (const name of ["hidden", "disabled", "required", "async", "defer"]) {
  Object.defineProperty(FakeElement.prototype, name, {
    get(this: FakeElement) {
      return this.hasAttribute(name);
    },
    set(this: FakeElement, value: unknown) {
      this.toggleAttribute(name, Boolean(value));
    },
  });
}

class FakeForm extends FakeElement {}
class FakeInput extends FakeElement {}
class FakeButton extends FakeElement {}
class FakeScript extends FakeElement {}
class FakeTextArea extends FakeElement {}
class FakeSelect extends FakeElement {}

const ELEMENT_KINDS: Record<string, typeof FakeElement> = {
  form: FakeForm,
  input: FakeInput,
  button: FakeButton,
  script: FakeScript,
  textarea: FakeTextArea,
  select: FakeSelect,
};

export class FakeDocument extends FakeElement {
  readonly window = new FakeTarget();
  readyState = "loading";
  currentScript = null;
  visibilityState = "visible";

  constructor() {
    super("#document", null);
  }

  override eventParent(): FakeTarget {
    return this.window;
  }

  get documentElement(): FakeElement | null {
    return this.querySelector("html");
  }

  get head(): FakeElement | null {
    return this.querySelector("head");
  }

  get body(): FakeElement | null {
    return this.querySelector("body");
  }

  get forms() {
    const forms = this.querySelectorAll("form");
    return Object.assign(forms, { namedItem: (id: string) => forms.find((form) => form.id === id) ?? null });
  }

  createElement(name: string): FakeElement {
    const localName = name.toLowerCase();
    return new (ELEMENT_KINDS[localName] ?? FakeElement)(localName, this);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  getElementById(id: string): FakeElement | null {
    return this.querySelectorAll("*").find((element) => element.id === id) ?? null;
  }

  getElementsByName(name: string): FakeElement[] {
    return this.querySelectorAll("*").filter((element) => element.name === name);
  }
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

function parseInto(root: FakeElement, html: string): void {
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-z][a-z0-9-]*)\s*>|<([a-z][a-z0-9-]*)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</gi;
  const open = [root];
  for (let match = token.exec(html); match !== null; match = token.exec(html)) {
    const [text, closing, opening] = match;
    const parent = open.at(-1) as FakeElement;
    if (opening !== undefined) {
      const element = root.ownerDocument.createElement(opening);
      for (const [name, value] of Object.entries(tagsIn(text)[0]?.attributes ?? {})) element.setAttribute(name, value);
      parent.appendChild(element);
      if (RAW_TEXT_TAGS.has(element.localName)) {
        const rest = html.slice(token.lastIndex);
        const end = rest.match(new RegExp(`</${element.localName}\\s*>`, "i"));
        const content = rest.slice(0, end?.index ?? rest.length);
        if (content !== "") element.appendChild(new FakeText(decodeEntities(content)));
        token.lastIndex += content.length + (end?.[0].length ?? 0);
      } else if (!VOID_TAGS.has(element.localName)) {
        open.push(element);
      }
    } else if (closing !== undefined) {
      const index = open.findLastIndex((element) => element.localName === closing.toLowerCase());
      if (index > 0) open.length = index;
    } else if (!text.startsWith("<")) {
      parent.appendChild(new FakeText(decodeEntities(text)));
    }
  }
}

function parsePage(html: string): FakeDocument {
  const document = new FakeDocument();
  parseInto(document, html);
  return document;
}

function isShown(element: FakeElement): boolean {
  for (let at: FakeElement | null = element; at !== null; at = at.parentElement) {
    if (at.hidden || at.style.display === "none") return false;
  }
  return true;
}

function textOf(node: Child): string {
  if (node instanceof FakeText) return node.data;
  if (node.hidden || node.style.display === "none" || ["script", "style", "template"].includes(node.localName)) return "";
  return node.childNodes.map(textOf).join("");
}

/** The text a guest sees in `element`, which is none when it or an ancestor is hidden. */
function visibleText(element: FakeElement | null): string {
  if (element === null || !isShown(element)) return "";
  return textOf(element).replace(/\s+/g, " ").trim();
}

// ---- The seam

function readSeam(document: FakeDocument, label: string): HoldPage {
  const only = (selector: string): FakeElement => {
    const found = document.querySelectorAll(selector);
    assert.equal(found.length, 1, `${label}: ${found.length} of ${selector}, where the client needs exactly one`);
    return found[0] as FakeElement;
  };
  const form = only("#checkout");
  assert.equal(form.localName, "form", `${label}: #checkout is a <${form.localName}>`);
  assert.ok(isShown(only("#card-container")), `${label}: #card-container is hidden`);
  assert.ok(isShown(only("#countdown")), `${label}: #countdown is hidden`);
  assert.equal(visibleText(only("#checkout-message")), "", `${label}: #checkout-message speaks before the client does`);

  const button = only("#pay-button");
  assert.equal(button.localName, "button", `${label}: #pay-button is a <${button.localName}>`);
  assert.equal(button.type, "submit", `${label}: #pay-button does not submit`);
  assert.ok(form.contains(button), `${label}: #pay-button is outside #checkout`);
  assert.equal(button.disabled, true, `${label}: #pay-button renders live, before any card has mounted`);

  for (const field of GUEST_FIELDS) {
    const input = only(`[name="${field}"]`);
    assert.ok(form.contains(input), `${label}: the input ${field} is outside #checkout`);
    assert.ok(isShown(input), `${label}: the input ${field} is hidden`);
    const error = only(`[data-error-for="${field}"]`);
    assert.equal(visibleText(error), "", `${label}: ${field} shows an error before the guest has typed`);
  }

  const data = (name: string): string => {
    const value = form.getAttribute(name);
    assert.ok(value !== null && value !== "", `${label}: #checkout has no ${name}`);
    return value;
  };
  const whole = (name: string): number => {
    assert.match(data(name), /^\d+$/, `${label}: ${name} is not a whole number`);
    return Number(data(name));
  };
  return {
    bookingId: data("data-booking-id"),
    locale: data("data-locale"),
    depositJpy: whole("data-deposit-jpy"),
    sdkUrl: data("data-sdk-url"),
    applicationId: data("data-application-id"),
    locationId: data("data-location-id"),
    expiresAt: whole("data-expires-at"),
  };
}

/** What the client would read from `html`. Throws on a page that does not have the whole seam. */
export function readHoldPage(html: string, label: string): HoldPage {
  return readSeam(parsePage(html), label);
}

/**
 * Where the form goes with `guest` typed in it if nothing stops it, by the browser's form submission rules, for a page at
 * `pageUrl`. A GET, which is the default and what any unknown method falls back to, writes every named control that is not
 * disabled into the URL. A POST leaves them in its body, and a dialog method outside a <dialog> goes nowhere. Worked out
 * here because the tests have no browser.
 */
export function nativeSubmitUrl(html: string, guest: Guest, pageUrl: string): URL {
  const document = parsePage(html);
  const form = document.getElementById("checkout") as FakeElement;
  const button = document.getElementById("pay-button") as FakeElement;
  for (const field of GUEST_FIELDS) (document.querySelector(`[name="${field}"]`) as FakeElement).value = guest[field];

  const read = (name: string): string => button.getAttribute(`form${name}`) ?? form.getAttribute(name) ?? "";
  const method = read("method").toLowerCase();
  if (method === "dialog") return new URL(pageUrl);
  const url = new URL(read("action"), pageUrl);
  if (method === "post") return url;

  const owned = (control: FakeElement): boolean =>
    control.hasAttribute("form") ? control.getAttribute("form") === form.id : form.contains(control);
  const sent = document
    .querySelectorAll("input, select, textarea")
    .filter((control) => owned(control) && control.name !== "")
    .filter((control) => !control.disabled && control.closest("fieldset[disabled]") === null)
    .map((control) => [control.name, control.value]);
  if (button.name !== "") sent.push([button.name, button.value]);
  url.search = new URLSearchParams(sent).toString();
  return url;
}

/**
 * Each tag a browser's parser finds in `html`, start and end, with its attribute names and no values. Text does not count,
 * and neither does what a raw-text element holds. That ends at the first closing tag, wherever it stands, as it does in a
 * browser, so what breaks out of a script block shows up here as tags.
 */
export function markupOf(html: string): string[] {
  const token = /<!--[\s\S]*?(?:-->|$)|<\/([a-z][a-z0-9-]*)[^>]*>|<([a-z][a-z0-9-]*)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  const found: string[] = [];
  for (let match = token.exec(html); match !== null; match = token.exec(html)) {
    const [text, closing, opening] = match;
    if (closing !== undefined) {
      found.push(`/${closing.toLowerCase()}`);
    } else if (opening === undefined) {
      found.push("<!--");
    } else {
      const name = opening.toLowerCase();
      found.push([name, ...Object.keys(tagsIn(text)[0]?.attributes ?? {}).sort()].join(" "));
      if (RAW_TEXT_TAGS.has(name)) {
        const end = html.slice(token.lastIndex).search(new RegExp(`</${name}[\\s/>]`, "i"));
        token.lastIndex = end === -1 ? html.length : token.lastIndex + end;
      }
    }
  }
  return found;
}

/** The page's tags with the code inside scripts and styles dropped, so a URL that only code mentions does not count. */
export function tagsOutsideCode(html: string): Tag[] {
  return tagsIn(html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2[\s/>])/gi, "$1$3"));
}

/** What each script block holds, cut where a browser cuts it. */
function inlineCode(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)(?:<\/script[\s/>]|$)/gi)].map(([, code]) => code as string);
}

/** `code` with every string literal emptied, so a value inside one does not count and a value out of one does. */
function codeShape(code: string): string {
  return code.replace(/"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`/g, '""');
}

/** What can run from a tag: its event handlers, and a URL that is a script. */
function executableAttributes(html: string): [string, string][] {
  const urls = ["href", "src", "action", "formaction"];
  return tagsOutsideCode(html).flatMap(({ attributes }) =>
    Object.entries(attributes).filter(
      ([name, value]) => name.startsWith("on") || (urls.includes(name) && /^\s*javascript:/i.test(value)),
    ),
  );
}

/**
 * `html`, which holds a guest's hostile text, has the structure of `clean`, the same page with a plain guest. So the text
 * stayed text: it wrote no tag or attribute, left no script block or string literal, and put no `<` in a script, where
 * `<!--<script>` would stop the block from ending at its own closing tag.
 */
export function assertSameStructure(html: string, clean: string, label: string): void {
  assert.deepEqual(markupOf(html), markupOf(clean), `${label}: the text changed the page's tags`);
  const code = inlineCode(html);
  const cleanCode = inlineCode(clean);
  assert.deepEqual(code.map(codeShape), cleanCode.map(codeShape), `${label}: the text got out of its place in a script`);
  const angles = (blocks: string[]): number => blocks.join("").split("<").length;
  assert.equal(angles(code), angles(cleanCode), `${label}: a < of the text reached a script`);
  assert.deepEqual(executableAttributes(html), executableAttributes(clean), `${label}: the text can run from an attribute`);
}

/** The smallest page with the seam. It hides what it can, so a client that only sets text does not pass here either. */
export function fakeHoldPage(hold: HoldPage): string {
  const fields = GUEST_FIELDS.map(
    (field) => `<label>${field} <input name="${field}"></label><p data-error-for="${field}" hidden></p>`,
  );
  return `<!doctype html>
<html lang="${hold.locale}">
  <head><meta charset="utf-8"><title>Checkout</title></head>
  <body>
    <main>
      <h1>Checkout</h1>
      <p id="countdown"></p>
      <form
        id="checkout"
        method="post"
        data-booking-id="${hold.bookingId}"
        data-locale="${hold.locale}"
        data-deposit-jpy="${hold.depositJpy}"
        data-sdk-url="${hold.sdkUrl}"
        data-application-id="${hold.applicationId}"
        data-location-id="${hold.locationId}"
        data-expires-at="${hold.expiresAt}"
      >
        ${fields.join("\n        ")}
        <div id="card-container"></div>
        <p id="checkout-message" hidden></p>
        <button id="pay-button" disabled>Pay ¥${hold.depositJpy.toLocaleString("en-US")}</button>
      </form>
    </main>
  </body>
</html>`;
}

// ---- The page, opened

type TokenReply = string | object | (() => unknown);
type ConfirmReply = () => Response | Promise<Response>;

export type OpenOptions = {
  /** The mocked clock at the start, in epoch ms. */
  now: number;
  /** What each tokenize answers, in turn: a token, a result, or a function for one. After these, a new token each time. */
  tokens?: TokenReply[];
  /** What each POST answers, in turn. After these, 200 { ok: true }. */
  confirms?: ConfirmReply[];
  /**
   * What becomes of the SDK's <script>: it "loads" (the default), "fails" with an error event, loads with "no-global" left
   * behind, or "waits", which leaves it loading until `loadSdk`.
   */
  sdk?: "loads" | "fails" | "no-global" | "waits";
  /** Runs in Square.payments, to throw as it does on ids it refuses. */
  payments?: () => void;
  /** Stands in for what payments.card() resolves after, to reject or to wait. */
  card?: () => Promise<void>;
  /** Stands in for what card.attach() resolves after, to reject or to wait. */
  attach?: () => Promise<void>;
  /** Runs as soon as the client's script has run, before DOMContentLoaded or anything that script waits for. */
  onStart?: (checkout: Checkout) => void;
};

/** One call to fetch, read back. */
export type Confirm = { method: string; path: string; contentType: string; body: unknown };

export type Checkout = {
  document: FakeDocument;
  button: FakeElement;
  /** The src of each script the client added. */
  readonly sdkRequests: string[];
  square: {
    payments: unknown[][];
    card: number;
    attach: unknown[];
    tokenize: unknown[][];
    verifyBuyer: unknown[][];
  };
  confirms: Confirm[];
  /** Each time the page reloaded. After one the page is gone and nothing on it can be clicked. */
  readonly reloads: number;
  /** Types `guest` into the form. */
  fill(guest: Guest): void;
  /** Clicks the pay button, if a guest could, and lets the page settle. */
  pay(): Promise<void>;
  /** The same without waiting, for a second click on the heels of the first. */
  click(): void;
  /**
   * Submits the form as form.requestSubmit() does, which does not ask whether the button is live. Throws if the client lets
   * the event through, since the browser would then leave with the form.
   */
  submit(): void;
  /** Lets an SDK opened with `sdk: "waits"` finish loading. */
  loadSdk(): Promise<void>;
  settle(): Promise<void>;
  /** Moves the clock on, a second at a time. */
  tick(ms: number): Promise<void>;
  /** The tab sleeps: the clock moves on and no timer fires, until the next `tick`, when what came due fires once. */
  sleep(ms: number): void;
  /** Whether a guest could press the pay button. */
  payable(): boolean;
  text(): string;
  message(): string;
  fieldError(field: GuestField): string;
  countdown(): string;
  /** Ends the page and puts the globals back, before the test next needs them. Runs by itself when the test ends. */
  close(): void;
};

export function respond(status: number, body: unknown): ConfirmReply {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return () => new Response(text, { status });
}

/** What a page does after the event that started the work, once its promises have settled. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await new Promise<void>((resolve) => nextTurn(resolve));
}

/** A click as a browser runs it: its default action submits the form, unless the click was prevented. */
function click(button: FakeElement): void {
  const event = new FakeEvent("click", { bubbles: true, cancelable: true });
  button.dispatchEvent(event);
  if (event.defaultPrevented || button.localName !== "button" || button.type !== "submit") return;
  button.form?.requestSubmit(button);
}

function installGlobals(values: Record<string, unknown>): () => void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const saved = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete scope[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  };
}

function fakeLocation(url: URL, reload: () => void) {
  const navigate = (target: string | URL): void => {
    const next = new URL(target, url);
    assert.equal(next.pathname, url.pathname, `the client left for ${next.pathname}`);
    reload();
  };
  return {
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    pathname: url.pathname,
    search: "",
    hash: "",
    get href() {
      return url.href;
    },
    set href(target: string) {
      navigate(target);
    },
    assign: navigate,
    replace: navigate,
    reload,
    toString: () => url.href,
  };
}

/** FormData, which in Node takes no form. */
class PageFormData extends FormData {
  constructor(form?: FakeElement) {
    super();
    for (const control of form?.querySelectorAll("input, select, textarea") ?? []) {
      if (control.name !== "" && !control.disabled) this.append(control.name, control.value);
    }
  }
}

let opens = 0;
let closeCurrent: (() => void) | undefined;

/** Opens `html` in a plain page and starts the real client on it, up to the moment the guest can type. */
export async function openCheckout(t: TestContext, html: string, options: OpenOptions): Promise<Checkout> {
  closeCurrent?.();
  const document = parsePage(html);
  const hold = readSeam(document, "the opened page");
  const form = document.getElementById("checkout") as FakeElement;
  const button = document.getElementById("pay-button") as FakeElement;
  const present = document.querySelectorAll("script[src]");
  const added = (): FakeElement[] => document.querySelectorAll("script[src]").filter((script) => !present.includes(script));

  const tokens = [...(options.tokens ?? [])];
  const replies = [...(options.confirms ?? [])];
  const square: Checkout["square"] = { payments: [], card: 0, attach: [], tokenize: [], verifyBuyer: [] };
  const confirms: Confirm[] = [];
  let reloads = 0;

  const card = {
    attach: async (selector: unknown) => {
      square.attach.push(selector);
      await options.attach?.();
    },
    tokenize: async (...args: unknown[]) => {
      square.tokenize.push(args);
      const reply = tokens.shift() ?? `cnon:unnamed-token-${square.tokenize.length}`;
      if (typeof reply === "string") return { status: "OK", token: reply };
      return typeof reply === "function" ? reply() : reply;
    },
    destroy: async () => {},
    addEventListener: () => {},
  };

  const sdk = {
    payments: (...ids: unknown[]) => {
      square.payments.push(ids);
      options.payments?.();
      return {
        card: async () => {
          square.card += 1;
          await options.card?.();
          return card;
        },
        verifyBuyer: async (...args: unknown[]) => {
          square.verifyBuyer.push(args);
          return { token: "verf:should-never-be-asked-for" };
        },
      };
    },
  };

  const location = fakeLocation(new URL(`/${hold.locale}/checkout/${hold.bookingId}`, SITE), () => {
    reloads += 1;
  });

  const fetchFake = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    confirms.push({
      method: (init?.method ?? "GET").toUpperCase(),
      path: new URL(url, location.href).pathname,
      contentType: (new Headers(init?.headers).get("content-type") ?? "").split(";")[0] as string,
      body: JSON.parse(String(init?.body)),
    });
    return (replies.shift() ?? respond(200, { ok: true }))();
  };

  const clock = new FakeClock(options.now, (ms) => t.mock.timers.setTime(ms));
  const restore = installGlobals({
    window: globalThis,
    document,
    location,
    fetch: fetchFake,
    FormData: PageFormData,
    Square: undefined,
    Node: FakeElement,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLDivElement: FakeElement,
    HTMLParagraphElement: FakeElement,
    HTMLSpanElement: FakeElement,
    HTMLFormElement: FakeForm,
    HTMLInputElement: FakeInput,
    HTMLButtonElement: FakeButton,
    HTMLScriptElement: FakeScript,
    HTMLTextAreaElement: FakeTextArea,
    HTMLSelectElement: FakeSelect,
    addEventListener: document.window.addEventListener.bind(document.window),
    removeEventListener: document.window.removeEventListener.bind(document.window),
    dispatchEvent: document.window.dispatchEvent.bind(document.window),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clear,
    setInterval: clock.setInterval,
    clearInterval: clock.clear,
    requestAnimationFrame: (callback: (now: number) => void) => clock.setTimeout(() => callback(Date.now()), 16),
    cancelAnimationFrame: clock.clear,
    scrollTo: () => {},
  });
  t.mock.timers.enable({ apis: ["Date"], now: options.now });
  const close = (): void => {
    if (closeCurrent !== close) return;
    closeCurrent = undefined;
    t.mock.timers.reset();
    restore();
  };
  closeCurrent = close;
  t.after(close);

  let started: Promise<unknown> = Promise.resolve();

  const finishSdk = async (ending: "loads" | "fails" | "no-global"): Promise<void> => {
    if (ending === "loads") (globalThis as unknown as { Square: unknown }).Square = sdk;
    for (const script of added()) script.dispatchEvent(new FakeEvent(ending === "fails" ? "error" : "load"));
    await settle();
    // The client's own failure comes out here, if it has one, without waiting on a script that may never finish.
    await Promise.race([started, settle()]);
  };

  const payable = (): boolean => reloads === 0 && button.isConnected && !button.disabled && isShown(button);
  const clickPay = (): void => {
    if (payable()) click(button);
  };

  const checkout: Checkout = {
    document,
    button,
    get sdkRequests() {
      return added().map((script) => script.src);
    },
    square,
    confirms,
    get reloads() {
      return reloads;
    },
    fill(guest) {
      for (const field of GUEST_FIELDS) {
        const input = document.querySelector(`[name="${field}"]`) as FakeElement;
        input.value = guest[field];
        input.dispatchEvent(new FakeEvent("input", { bubbles: true }));
        input.dispatchEvent(new FakeEvent("change", { bubbles: true }));
      }
    },
    async pay() {
      clickPay();
      await settle();
    },
    click: clickPay,
    submit: () => form.requestSubmit(),
    loadSdk: () => finishSdk("loads"),
    settle,
    async tick(ms) {
      for (let left = ms; left > 0; left -= 1000) {
        clock.advance(Math.min(left, 1000));
        await Promise.resolve();
      }
      await settle();
    },
    sleep: (ms) => clock.sleep(ms),
    payable,
    text: () => visibleText(document.body),
    message: () => visibleText(document.getElementById("checkout-message")),
    fieldError: (field) => visibleText(document.querySelector(`[data-error-for="${field}"]`)),
    countdown: () => visibleText(document.getElementById("countdown")),
    close,
  };

  document.readyState = "interactive";
  opens += 1;
  started = import(`${CLIENT}?open=${opens}`);
  // A client may wait for the SDK at its top level, and that load event comes after this, so the import alone could hang.
  let running = true;
  const stop = (): void => {
    running = false;
  };
  started.then(stop, stop);
  const askedForSdk = async (): Promise<void> => {
    while (running && added().length === 0) await new Promise<void>((resolve) => nextTurn(resolve));
  };
  await Promise.race([started, askedForSdk()]);
  options.onStart?.(checkout);
  await settle();
  document.dispatchEvent(new FakeEvent("DOMContentLoaded", { bubbles: true }));
  await settle();
  document.readyState = "complete";
  document.window.dispatchEvent(new FakeEvent("load"));
  document.window.dispatchEvent(new FakeEvent("pageshow"));
  await settle();

  assert.ok(added().length > 0, "the client never asked for the SDK, so it never started on a plain page");
  const sdkEnding = options.sdk ?? "loads";
  if (sdkEnding !== "waits") await finishSdk(sdkEnding);
  return checkout;
}
