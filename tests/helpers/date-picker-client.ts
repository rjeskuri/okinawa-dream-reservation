// Runs the real src/scripts/date-picker.ts under Node on a page the Worker rendered (#137), in the fake DOM of
// tests/helpers/checkout-client.ts with what a date picker needs on top: custom elements, focus, keys and taps that behave
// as a browser's do. Each open is a fresh page load: a new document, a new custom element registry and a fresh evaluation
// of the module, so state from one page cannot leak into the next.
//
// The seam, which is all these tests read:
//   src/components/DatePicker.astro loads its client from src/scripts/date-picker.ts, a module that starts itself on
//   import, as plain code or by defining the `date-picker` custom element.
//   Each form holds one <date-picker>. A page reports the chosen package through its attributes, as it reports
//   `package-days` today: `package-days` is packageDays of the package, and `package-hours` is an hours package's hours,
//   absent for a day package. With neither, no package is chosen.
//   Inside it, after the client has run:
//     button[data-field], the date field: a type=button whose text is all the guest reads of the choice (an accessible
//       name beyond it goes in aria-label), with aria-expanded "true" while the calendar is open and "false" otherwise;
//     [role=grid], the month grid as today: td[data-date] cells, aria-disabled on a closed or out-of-window day, and
//       tabindex="0" on the cursor's cell only;
//     exactly one enabled control named `date` in the form, holding the chosen pickup.
//   Closed means the grid or an ancestor carries `hidden`, the only styling this DOM reads, so no popover or dialog.
//   Before the client runs, the page is what a guest without JavaScript gets: the only enabled `date` control is the
//   shown <input type=date>, and neither the field nor the grid shows.
//
// The DOM is the part of the real thing a client like this uses. A selector it cannot read throws.
import assert from "node:assert/strict";
import { FakeDocument, FakeElement, FakeEvent, isShown, parsePage, visibleText } from "./checkout-client.ts";
import type { PackageLength } from "../../src/lib/types.ts";

const CLIENT = new URL("../../src/scripts/date-picker.ts", import.meta.url).href;

/** Captured here so a page's own timers cannot stop the test from moving on. */
const nextTurn = globalThis.setImmediate;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => nextTurn(resolve));
}

// ---- What a browser's DOM has that checkout's does not

/** A string attribute reflected as a property, as `min` and `max` are on an input. */
for (const name of ["min", "max", "step", "abbr", "scope"]) {
  if (Object.getOwnPropertyDescriptor(FakeElement.prototype, name)) continue;
  Object.defineProperty(FakeElement.prototype, name, {
    configurable: true,
    get(this: FakeElement) {
      return this.getAttribute(name) ?? "";
    },
    set(this: FakeElement, value: string) {
      this.setAttribute(name, String(value));
    },
  });
}

const NATIVELY_FOCUSABLE = new Set(["button", "select", "textarea", "input"]);

Object.defineProperty(FakeElement.prototype, "tabIndex", {
  configurable: true,
  get(this: FakeElement) {
    const own = this.getAttribute("tabindex");
    if (own !== null && /^-?\d+$/.test(own.trim())) return Number(own);
    return NATIVELY_FOCUSABLE.has(this.localName) || (this.localName === "a" && this.hasAttribute("href")) ? 0 : -1;
  },
  set(this: FakeElement, value: number) {
    this.setAttribute("tabindex", String(Math.trunc(Number(value))));
  },
});

/** A table cell's place in its row, as the grid's Home and End keys read it. */
Object.defineProperty(FakeElement.prototype, "cellIndex", {
  configurable: true,
  get(this: FakeElement) {
    if (this.localName !== "td" && this.localName !== "th") return -1;
    const row = this.parentElement;
    if (row === null) return -1;
    return row.children.filter((cell) => cell.localName === "td" || cell.localName === "th").indexOf(this);
  },
});

/** An event of any kind a page may make or hear: keys, pointers, focus. */
export class DomEvent extends FakeEvent {
  key = "";
  code = "";
  button = 0;
  pointerType = "mouse";
  relatedTarget: FakeElement | null = null;
  shiftKey = false;
  altKey = false;
  ctrlKey = false;
  metaKey = false;
  isComposing = false;
  path: unknown[] | null = null;

  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, { bubbles: Boolean(init.bubbles), cancelable: Boolean(init.cancelable) });
    for (const [name, value] of Object.entries(init)) {
      if (!["bubbles", "cancelable"].includes(name)) (this as unknown as Record<string, unknown>)[name] = value;
    }
  }

  composedPath(): unknown[] {
    return this.path ?? [];
  }
}

function pathOf(target: FakeElement | FakeDocument): unknown[] {
  const path: unknown[] = [];
  for (let at: FakeElement | null = target; at !== null; at = at.parentNode) path.push(at);
  const top = path.at(-1);
  if (top instanceof FakeDocument) path.push(top.window);
  return path;
}

function fire(target: FakeElement, type: string, init: Record<string, unknown> = {}): DomEvent {
  const event = new DomEvent(type, { bubbles: true, cancelable: true, ...init });
  event.path = pathOf(target);
  target.dispatchEvent(event);
  return event;
}

const active = new WeakMap<FakeDocument, FakeElement>();

/** What has focus: the element last focused while it is still on the page and shown, else the body. */
function activeOf(document: FakeDocument): FakeElement | null {
  const element = active.get(document);
  return element !== undefined && element.isConnected && isShown(element) ? element : document.body;
}

Object.defineProperty(FakeDocument.prototype, "activeElement", {
  configurable: true,
  get(this: FakeDocument) {
    return activeOf(this);
  },
});

/** As in a browser, only a shown, enabled element that takes focus can have it. */
function focusable(element: FakeElement): boolean {
  if (!element.isConnected || !isShown(element) || element.disabled) return false;
  if (element.hasAttribute("tabindex")) return true;
  if (element.localName === "input") return element.getAttribute("type") !== "hidden";
  if (element.localName === "a") return element.hasAttribute("href");
  return NATIVELY_FOCUSABLE.has(element.localName);
}

function moveFocus(document: FakeDocument, to: FakeElement | null): void {
  const from = active.get(document) ?? null;
  if (from === to) return;
  if (to === null) active.delete(document);
  else active.set(document, to);
  if (from !== null && from.isConnected) {
    fire(from, "blur", { bubbles: false, cancelable: false, relatedTarget: to });
    fire(from, "focusout", { cancelable: false, relatedTarget: to });
  }
  if (to !== null) {
    fire(to, "focus", { bubbles: false, cancelable: false, relatedTarget: from });
    fire(to, "focusin", { cancelable: false, relatedTarget: from });
  }
}

FakeElement.prototype.focus = function focus(this: FakeElement): void {
  if (focusable(this)) moveFocus(this.ownerDocument, this);
};

FakeElement.prototype.blur = function blur(this: FakeElement): void {
  if (active.get(this.ownerDocument) === this) moveFocus(this.ownerDocument, null);
};

// ---- Custom elements

let constructing: { name: string; document: FakeDocument } | null = null;

/** HTMLElement for a custom element class to extend. The registry constructs it when it upgrades a parsed element. */
export class FakeHTMLElement extends FakeElement {
  constructor() {
    const at = constructing;
    if (at === null) throw new TypeError("Illegal constructor: a custom element is made by customElements, not by new");
    super(at.name, at.document);
  }

  override setAttribute(name: string, value: string): void {
    const old = this.getAttribute(name);
    super.setAttribute(name, value);
    this.#changed(name, old, this.getAttribute(name));
  }

  override removeAttribute(name: string): void {
    if (!this.hasAttribute(name)) return;
    const old = this.getAttribute(name);
    super.removeAttribute(name);
    this.#changed(name, old, null);
  }

  #changed(name: string, old: string | null, value: string | null): void {
    const observed = (this.constructor as { observedAttributes?: string[] }).observedAttributes ?? [];
    const callback = (this as unknown as { attributeChangedCallback?: unknown }).attributeChangedCallback;
    if (observed.includes(name.toLowerCase()) && typeof callback === "function") {
      callback.call(this, name.toLowerCase(), old, value);
    }
  }
}

type ElementClass = new () => FakeHTMLElement;

/** A registry for one page. Defining a name upgrades the page's elements of it, as a browser does. */
function registryFor(document: FakeDocument) {
  const defined = new Map<string, ElementClass>();

  const upgrade = (element: FakeElement, name: string, Class: ElementClass): void => {
    constructing = { name, document };
    let fresh: FakeHTMLElement;
    try {
      fresh = new Class();
    } finally {
      constructing = null;
    }
    for (const attribute of element.getAttributeNames()) fresh.setAttribute(attribute, element.getAttribute(attribute) ?? "");
    for (const child of [...element.childNodes]) fresh.appendChild(child);
    element.replaceWith(fresh);
    (fresh as unknown as { connectedCallback?: () => void }).connectedCallback?.();
  };

  return {
    define(name: string, Class: ElementClass): void {
      if (defined.has(name)) throw new Error(`customElements.define: ${name} is already defined`);
      defined.set(name, Class);
      for (const element of document.querySelectorAll(name)) {
        if (!(element instanceof Class)) upgrade(element, name, Class);
      }
    },
    get: (name: string) => defined.get(name),
    whenDefined: async (name: string) => defined.get(name),
    upgrade: () => {},
  };
}

// ---- Pages

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

/** The enabled controls named `date` in the picker's form: what a submit of it posts for the pickup. */
function postedDates(form: FakeElement): FakeElement[] {
  return form.querySelectorAll("[name=date]").filter((control) => !control.disabled);
}

function onlyPicker(document: FakeDocument, label: string): FakeElement {
  const pickers = document.querySelectorAll("date-picker");
  assert.equal(pickers.length, 1, `${label}: date pickers on the page`);
  return pickers[0] as FakeElement;
}

function formOf(picker: FakeElement, label: string): FakeElement {
  const form = picker.closest("form");
  assert.ok(form, `${label}: the date picker is in no form`);
  return form;
}

/** What a guest without JavaScript gets from the picker's form. */
export function withoutScript(html: string, label: string): void {
  const document = parsePage(html);
  const picker = onlyPicker(document, label);
  const posted = postedDates(formOf(picker, label));
  assert.equal(posted.length, 1, `${label}: enabled date controls without JavaScript`);
  const [input] = posted as [FakeElement];
  assert.equal(input.localName, "input", `${label}: the date control without JavaScript`);
  assert.equal(input.getAttribute("type"), "date", `${label}: the date control's type without JavaScript`);
  assert.ok(isShown(input), `${label}: the date input is hidden without JavaScript`);
  const field = picker.querySelector("button[data-field]");
  assert.ok(field === null || !isShown(field), `${label}: the date field shows without JavaScript, where it does nothing`);
  const grid = picker.querySelector("[role=grid]");
  assert.ok(grid === null || !isShown(grid), `${label}: the calendar shows without JavaScript`);
}

export type PickerPage = {
  document: FakeDocument;
  /** The picker as it is now: an upgrade replaces the parsed element. */
  picker(): FakeElement;
  field(): FakeElement;
  grid(): FakeElement;
  isOpen(): boolean;
  /** The field's text, whitespace collapsed. */
  fieldText(): string;
  /** What the form posts for the pickup: the one enabled `date` control's value. */
  posted(): string;
  /** The element with focus. */
  focused(): FakeElement | null;
  /** The enabled day cells on show. */
  enabledDays(): FakeElement[];
  /** Change events of a `date` control that reached the document. */
  changes: number;
  /** Times a tap or a key submitted the form. */
  submits: number;
  tap(target: FakeElement): Promise<void>;
  /** A key pressed where the focus is. */
  press(key: string): Promise<void>;
  /** Reports a package as a page does, through package-days and package-hours; null clears it. */
  choosePackage(pkg: PackageLength | null): Promise<void>;
};

let opens = 0;
let closeCurrent: (() => void) | undefined;

/** Opens `html` as a fresh page and runs the real client on it, as an Astro module script runs: once the page is parsed. */
export async function openPicker(html: string, label: string): Promise<PickerPage> {
  closeCurrent?.();
  const document = parsePage(html);
  onlyPicker(document, label);
  const window = document.window as unknown as Record<string, unknown>;
  const customElements = registryFor(document);
  const requestAnimationFrame = (callback: (at: number) => void): number => {
    nextTurn(() => callback(performance.now()));
    return 0;
  };
  Object.assign(window, {
    document,
    customElements,
    requestAnimationFrame,
    cancelAnimationFrame: () => {},
    getComputedStyle: (element: FakeElement) => element.style,
  });
  closeCurrent = installGlobals({
    window,
    document,
    customElements,
    requestAnimationFrame,
    cancelAnimationFrame: () => {},
    getComputedStyle: (element: FakeElement) => element.style,
    HTMLElement: FakeHTMLElement,
    Element: FakeElement,
    Event: FakeEvent,
    CustomEvent: DomEvent,
    KeyboardEvent: DomEvent,
    MouseEvent: DomEvent,
    PointerEvent: DomEvent,
    FocusEvent: DomEvent,
  });

  const page: PickerPage = {
    document,
    picker: () => onlyPicker(document, label),
    field() {
      const field = page.picker().querySelector("button[data-field]");
      assert.ok(field, `${label}: the date picker has no button[data-field]`);
      assert.equal(field.getAttribute("type"), "button", `${label}: the date field's type`);
      return field;
    },
    grid() {
      const grid = page.picker().querySelector("[role=grid]");
      assert.ok(grid, `${label}: the date picker has no [role=grid]`);
      return grid;
    },
    isOpen: () => isShown(page.grid()),
    fieldText: () => visibleText(page.field()),
    posted() {
      const posted = postedDates(formOf(page.picker(), label));
      assert.equal(posted.length, 1, `${label}: enabled date controls in the form`);
      return (posted[0] as FakeElement).value;
    },
    focused: () => activeOf(document),
    enabledDays: () => page.grid().querySelectorAll("td[data-date]").filter((cell) => !cell.hasAttribute("aria-disabled")),
    changes: 0,
    submits: 0,
    async tap(target) {
      fire(target, "pointerdown");
      fire(target, "mousedown");
      let focus: FakeElement | null = target;
      while (focus !== null && !focusable(focus)) focus = focus.parentElement;
      moveFocus(document, focus);
      fire(target, "pointerup");
      fire(target, "mouseup");
      const click = fire(target, "click");
      const button = target.closest("button");
      if (!click.defaultPrevented && button !== null && button.type === "submit" && button.form !== null) page.submits += 1;
      await settle();
    },
    async press(key) {
      const target = activeOf(document) ?? (document.body as FakeElement);
      const down = fire(target, "keydown", { key, code: key === " " ? "Space" : key });
      const button = target.localName === "button" && !target.disabled ? target : null;
      const activate = (): void => {
        const click = fire(button as FakeElement, "click");
        if (!click.defaultPrevented && (button as FakeElement).type === "submit" && button?.form) page.submits += 1;
      };
      // A button clicks on Enter's keydown and on Space's keyup, unless the page prevented the key.
      if (button !== null && key === "Enter" && !down.defaultPrevented) activate();
      const up = fire(target, "keyup", { key, code: key === " " ? "Space" : key });
      if (button !== null && key === " " && !down.defaultPrevented && !up.defaultPrevented) activate();
      await settle();
    },
    async choosePackage(pkg) {
      const picker = page.picker();
      if (pkg === null) {
        picker.removeAttribute("package-hours");
        picker.removeAttribute("package-days");
      } else {
        // packageDays, without the code under test: a day package's days, else the pickup's day plus each whole 24 hours.
        const days = pkg.days ?? Math.floor(pkg.hours / 24) + 1;
        if (pkg.hours === null) picker.removeAttribute("package-hours");
        else picker.setAttribute("package-hours", String(pkg.hours));
        picker.setAttribute("package-days", String(days));
      }
      await settle();
    },
  };

  document.addEventListener("change", (event: FakeEvent) => {
    if ((event.target as FakeElement | null)?.getAttribute?.("name") === "date") page.changes += 1;
  });

  document.readyState = "interactive";
  opens += 1;
  await import(`${CLIENT}?page=${opens}`);
  fire(document as unknown as FakeElement, "DOMContentLoaded", { cancelable: false });
  document.readyState = "complete";
  await settle();
  page.changes = 0;
  return page;
}
