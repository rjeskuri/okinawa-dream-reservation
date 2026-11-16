// #137: the booking calendar behind a date field, on the pages the built Worker renders, with the real
// src/scripts/date-picker.ts run on them by tests/helpers/date-picker-client.ts, which holds the seam between the two. The
// field's expected text comes from tests/helpers/return-summary.ts, so the wording stays the dictionary's. The Worker reads
// the real clock, so dates are computed from today in JST, and the days a test picks are read off the grid it shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { replaceCatalog } from "../../src/lib/db/catalog-store.ts";
import { LOCALES, type Locale } from "../../src/lib/locale.ts";
import { jstToday } from "../../src/lib/time.ts";
import type { Catalog, LocalizedTexts, Package, PackageLength } from "../../src/lib/types.ts";
import { openPicker, withoutScript, type PickerPage } from "../helpers/date-picker-client.ts";
import { emptyField, expectedSummary, plusDays } from "../helpers/return-summary.ts";
import { startWorker, type TestWorker } from "../helpers/worker.ts";

let worker: TestWorker;

before(async () => {
  worker = await startWorker();
  await replaceCatalog(worker.db, catalog(), { now: Date.now(), source: "sheet" });
});

after(async () => {
  await worker?.stop();
});

// The catalog: one bike with a package of each kind, at a shop that closes at a time no default has.

const SHOP_CLOSE = "17:30";

function names(en: string): LocalizedTexts<{ name: string }> {
  return { ja: { name: `${en} 日本語` }, en: { name: en }, "zh-cn": { name: `${en} 中文` }, ko: { name: `${en} 한국어` } };
}

const THREE_DAYS: Package = { id: "p-c-3d", days: 3, hours: null, sort: 1, texts: names("Three days") };
const SAME_DAY: Package = { id: "p-a-1d", days: 1, hours: null, sort: 2, texts: names("Same day") };
const FOUR_HOURS: Package = { id: "p-d-4h", days: null, hours: 4, sort: 3, texts: names("Four hours") };
const FULL_DAY: Package = { id: "p-b-24h", days: null, hours: 24, sort: 4, texts: names("Day and night") };
const PACKAGES = [THREE_DAYS, SAME_DAY, FOUR_HOURS, FULL_DAY];

const MODEL_ID = "m-vino";

function catalog(): Catalog {
  const texts = (locale: Locale) => ({ name: `Vino ${locale}`, summary: `Vino summary`, description: `Vino description` });
  return {
    config: {
      shopOpen: "08:30",
      shopClose: SHOP_CLOSE,
      slotMinutes: 30,
      turnaroundMinutes: 60,
      holdMinutes: 12,
      minLeadHours: 24,
      maxDaysAhead: 120,
      photoMaxMb: 5,
    },
    vehicleTypes: [
      { id: "scooter", depositJpy: 3100, sort: 1, texts: names("Scooter") },
      { id: "motorcycle", depositJpy: 5300, sort: 2, texts: names("Motorcycle") },
      { id: "car", depositJpy: 10700, sort: 3, texts: names("Car") },
    ],
    rateClasses: [{ id: "r-50cc", grp: "bike", sort: 1, extensionPerHourJpy: 500, texts: names("50cc") }],
    models: [
      {
        id: MODEL_ID,
        typeId: "scooter",
        engineCc: 49,
        licenseClass: "moped",
        sort: 1,
        active: true,
        rateClassId: "r-50cc",
        brand: "Test",
        seats: null,
        texts: { ja: texts("ja"), en: texts("en"), "zh-cn": texts("zh-cn"), ko: texts("ko") },
        photos: [],
      },
    ],
    vehicles: [
      { plate: "vino-1", modelId: MODEL_ID, status: "active", odometerKm: null, baseUsageDays: 0 },
      { plate: "vino-2", modelId: MODEL_ID, status: "active", odometerKm: null, baseUsageDays: 0 },
    ],
    packages: PACKAGES,
    prices: [
      { rateClassId: "r-50cc", packageId: THREE_DAYS.id, priceJpy: 6130, advancePriceJpy: null },
      { rateClassId: "r-50cc", packageId: SAME_DAY.id, priceJpy: 2410, advancePriceJpy: null },
      { rateClassId: "r-50cc", packageId: FOUR_HOURS.id, priceJpy: 1490, advancePriceJpy: null },
      { rateClassId: "r-50cc", packageId: FULL_DAY.id, priceJpy: 4390, advancePriceJpy: null },
    ],
    options: [],
    cancellationTiers: [{ minDaysBefore: 0, refundPercent: 0 }],
    closedDates: [],
  };
}

const length = ({ days, hours }: Package): PackageLength => (days !== null ? { days, hours: null } : { days: null, hours });

// Pages.

/** A pickup well inside the booking window, whatever the hour. */
function pickupDay(): string {
  return plusDays(jstToday(Date.now()), 10);
}

async function pageHtml(path: string): Promise<string> {
  const res = await worker.fetch(path, { redirect: "manual" });
  const html = await res.text();
  assert.equal(res.status, 200, path);
  return html;
}

function modelPath(locale: Locale, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return `/${locale}/rentals/${MODEL_ID}${search === "" ? "" : `?${search}`}`;
}

/**
 * Opens `path` with the client running, after checking what a guest without JavaScript gets from the same page: the plain
 * date input, posted as today, and neither the field nor the grid.
 */
async function open(path: string): Promise<PickerPage> {
  const html = await pageHtml(path);
  withoutScript(html, `${path} without JavaScript`);
  return openPicker(html, path);
}

function assertClosed(page: PickerPage, label: string): void {
  assert.equal(page.isOpen(), false, `${label}: the calendar is open`);
  assert.equal(page.field().getAttribute("aria-expanded"), "false", `${label}: the field's aria-expanded`);
}

function assertOpen(page: PickerPage, label: string): void {
  assert.equal(page.isOpen(), true, `${label}: the calendar is closed`);
  assert.equal(page.field().getAttribute("aria-expanded"), "true", `${label}: the field's aria-expanded`);
}

/** The day the grid's tab stop is on. */
function cursorDay(page: PickerPage, label: string): string {
  const cursor = page.grid().querySelectorAll('td[tabindex="0"]');
  assert.equal(cursor.length, 1, `${label}: cells holding the grid's tab stop`);
  return (cursor[0] as { getAttribute(name: string): string | null }).getAttribute("data-date") ?? "";
}

/** That the focus is on the grid's cursor cell, and that cell is `day`. */
function assertFocusOnDay(page: PickerPage, day: string, label: string): void {
  const focused = page.focused();
  assert.equal(focused?.localName, "td", `${label}: the focus is on ${focused?.localName}, not a day`);
  assert.equal(focused?.getAttribute("data-date"), day, `${label}: the focused day`);
  assert.equal(cursorDay(page, label), day, `${label}: the grid's tab stop`);
}

/** What has focus, in a few words: an element itself would print the whole page in a failure. */
function describeFocus(page: PickerPage): string {
  const focused = page.focused();
  if (focused === null) return "nothing";
  const marks = focused.getAttributeNames().filter((name) => name.startsWith("data-") || name === "role");
  return `<${focused.localName}${marks.map((name) => ` ${name}="${focused.getAttribute(name)}"`).join("")}>`;
}

function assertFocusOnField(page: PickerPage, label: string): void {
  assert.ok(page.focused() === page.field(), `${label}: the focus is on ${describeFocus(page)}, not the field`);
}

/** Some enabled day on show other than `not`, from the end of the grid so it differs from the pickups the tests start on. */
function anotherDay(page: PickerPage, not: string, label: string): { cell: ReturnType<PickerPage["field"]>; date: string } {
  const cell = page.enabledDays().filter((day) => day.getAttribute("data-date") !== not).at(-1);
  assert.ok(cell, `${label}: no other enabled day on show`);
  return { cell, date: cell.getAttribute("data-date") ?? "" };
}

/** The same day a month on, or that month's last day, without the code under test. */
function monthLater(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last))).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

const ROOT = new URL("../../", import.meta.url);

test("the date picker runs its client from src/scripts/date-picker.ts", () => {
  const component = readFileSync(new URL("src/components/DatePicker.astro", ROOT), "utf8");
  const scripts = [...component.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(
    scripts.some(([, attributes, body]) => /scripts\/date-picker\.ts/.test(`${attributes} ${body}`)),
    "DatePicker.astro loads no ../scripts/date-picker.ts, so these tests run code the page does not",
  );
});

test("the calendar is closed on load, opens from the field and closes on a pick showing the pickup and the return", async () => {
  const day = pickupDay();

  // No pickup yet: the field asks for one.
  const blank = await open(modelPath("en"));
  assertClosed(blank, "no pickup, on load");
  assert.equal(blank.fieldText(), emptyField("en"), "no pickup: the field's text");

  const label = "en model page";
  const page = await open(modelPath("en", { date: day, package: THREE_DAYS.id }));
  assertClosed(page, `${label}, on load`);
  assert.equal(page.fieldText(), expectedSummary("en", day, length(THREE_DAYS), SHOP_CLOSE), `${label}: on load`);
  assert.equal(page.posted(), day, `${label}: the pickup posted on load`);

  await page.tap(page.field());
  assertOpen(page, `${label}, tapped`);
  assert.equal(page.submits, 0, `${label}: tapping the field submitted the form`);
  assert.equal(page.fieldText(), expectedSummary("en", day, length(THREE_DAYS), SHOP_CLOSE), `${label}: open`);

  const other = anotherDay(page, day, label);
  await page.tap(other.cell);
  assertClosed(page, `${label}, picked`);
  assert.equal(page.fieldText(), expectedSummary("en", other.date, length(THREE_DAYS), SHOP_CLOSE), `${label}: picked`);
  assert.equal(page.posted(), other.date, `${label}: the pickup posted after the pick`);
  assert.equal(page.changes, 1, `${label}: change events of the pickup`);
  assertFocusOnField(page, `${label}: the focus after the pick`);
  assert.equal(page.submits, 0, `${label}: picking submitted the form`);

  // And again from there: the calendar reopens on the day now chosen.
  await page.tap(page.field());
  assertOpen(page, `${label}, reopened`);
  assert.equal(cursorDay(page, `${label}, reopened`), other.date, `${label}: the day the calendar reopens on`);
});

test("Escape and a tap outside close the calendar without a change", async () => {
  const day = pickupDay();
  const label = "ja model page";
  const page = await open(modelPath("ja", { date: day, package: SAME_DAY.id }));
  const shown = expectedSummary("ja", day, length(SAME_DAY), SHOP_CLOSE);
  assert.equal(page.fieldText(), shown, `${label}: on load`);

  await page.tap(page.field());
  assertOpen(page, `${label}, tapped`);
  assertFocusOnDay(page, day, `${label}, tapped`);
  await page.press("ArrowRight");
  assertFocusOnDay(page, plusDays(day, 1), `${label}, ArrowRight`);
  await page.press("Escape");
  assertClosed(page, `${label}, Escape`);
  assert.equal(page.fieldText(), shown, `${label}: the field after Escape`);
  assert.equal(page.posted(), day, `${label}: the pickup after Escape`);
  assertFocusOnField(page, `${label}: the focus after Escape`);

  await page.tap(page.field());
  assertOpen(page, `${label}, tapped again`);
  await page.press("ArrowDown");
  const outside = page.document.querySelector("h1");
  assert.ok(outside, `${label}: no h1 to tap`);
  await page.tap(outside);
  assertClosed(page, `${label}, tapped outside`);
  assert.equal(page.fieldText(), shown, `${label}: the field after a tap outside`);
  assert.equal(page.posted(), day, `${label}: the pickup after a tap outside`);
  assert.equal(page.changes, 0, `${label}: change events of the pickup`);
});

test("the field opens with Enter or Space, the grid keys work as before and focus returns to the field", async () => {
  const day = pickupDay();
  const label = "ko model page";
  const page = await open(modelPath("ko", { date: day, package: FULL_DAY.id }));
  assertClosed(page, `${label}, on load`);

  page.field().focus();
  assertFocusOnField(page, `${label}: the field takes focus`);
  await page.press("Enter");
  assertOpen(page, `${label}, Enter`);
  assert.equal(page.submits, 0, `${label}: Enter on the field submitted the form`);
  assertFocusOnDay(page, day, `${label}, Enter`);

  // The grid's keys, as before #137: each moves the cursor and the focus with it.
  let at = day;
  const moves: [string, (date: string) => string][] = [
    ["ArrowRight", (date) => plusDays(date, 1)],
    ["ArrowDown", (date) => plusDays(date, 7)],
    ["ArrowLeft", (date) => plusDays(date, -1)],
    ["PageDown", monthLater],
    ["Home", (date) => plusDays(date, -weekday(date))],
    ["ArrowUp", (date) => plusDays(date, -7)],
  ];
  for (const [key, move] of moves) {
    at = move(at);
    await page.press(key);
    assertOpen(page, `${label}, ${key}`);
    assertFocusOnDay(page, at, `${label}, ${key}`);
  }
  assert.equal(page.posted(), day, `${label}: moving the cursor changed the pickup`);

  await page.press("Enter");
  assertClosed(page, `${label}, Enter on a day`);
  assert.equal(page.fieldText(), expectedSummary("ko", at, length(FULL_DAY), SHOP_CLOSE), `${label}: picked by key`);
  assert.equal(page.posted(), at, `${label}: the pickup picked by key`);
  assertFocusOnField(page, `${label}: the focus after Enter on a day`);

  await page.press(" ");
  assertOpen(page, `${label}, Space`);
  assert.equal(page.submits, 0, `${label}: Space on the field submitted the form`);
  assertFocusOnDay(page, at, `${label}, Space`);
  await page.press("Escape");
  assertClosed(page, `${label}, Escape`);
  assertFocusOnField(page, `${label}: the focus after Escape`);
});

test("the field reads each package kind in every locale and follows the package", async () => {
  const day = pickupDay();
  for (const locale of LOCALES) {
    // The package the page starts on, from the query.
    for (const pkg of PACKAGES) {
      const path = modelPath(locale, { date: day, package: pkg.id });
      const page = await open(path);
      assertClosed(page, path);
      assert.equal(page.fieldText(), expectedSummary(locale, day, length(pkg), SHOP_CLOSE), `${path}: the field`);
    }

    // Then the package the page reports as the guest changes the select, in another order and with lengths of its own.
    const path = modelPath(locale, { date: day, package: SAME_DAY.id });
    const page = await open(path);
    const lengths: (PackageLength | null)[] = [
      { days: null, hours: 24 },
      { days: 5, hours: null },
      { days: null, hours: 6 },
      { days: 1, hours: null },
      null,
      { days: null, hours: 4 },
      { days: 3, hours: null },
    ];
    for (const pkg of lengths) {
      await page.choosePackage(pkg);
      const label = `${path}, package ${JSON.stringify(pkg)}`;
      assert.equal(page.fieldText(), expectedSummary(locale, day, pkg, SHOP_CLOSE), `${label}: the field`);
      assertClosed(page, label);
      assert.equal(page.posted(), day, `${label}: the pickup`);
    }
  }
});

test("the home search and the rentals listing open the calendar from the field too", async () => {
  const day = pickupDay();

  // The home search has no package to read, so the field reads the pickup alone.
  const home = await open("/ja/");
  assertClosed(home, "home, on load");
  assert.equal(home.fieldText(), emptyField("ja"), "home: the field on load");
  await home.tap(home.field());
  assertOpen(home, "home, tapped");
  const picked = anotherDay(home, "", "home");
  await home.tap(picked.cell);
  assertClosed(home, "home, picked");
  assert.equal(home.fieldText(), expectedSummary("ja", picked.date, null, SHOP_CLOSE), "home: the field after the pick");
  assert.equal(home.posted(), picked.date, "home: the pickup posted");
  assertFocusOnField(home, "home: the focus after the pick");

  for (const [locale, pkg] of [
    ["zh-cn", THREE_DAYS],
    ["en", FOUR_HOURS],
  ] as const) {
    const path = `/${locale}/rentals?date=${day}&package=${pkg.id}`;
    const listing = await open(path);
    assertClosed(listing, `${path}, on load`);
    assert.equal(listing.fieldText(), expectedSummary(locale, day, length(pkg), SHOP_CLOSE), `${path}: on load`);
    await listing.tap(listing.field());
    assertOpen(listing, `${path}, tapped`);
    const other = anotherDay(listing, day, path);
    await listing.tap(other.cell);
    assertClosed(listing, `${path}, picked`);
    assert.equal(listing.fieldText(), expectedSummary(locale, other.date, length(pkg), SHOP_CLOSE), `${path}: picked`);
    assert.equal(listing.posted(), other.date, `${path}: the pickup posted`);
    await listing.press("Enter");
    assertOpen(listing, `${path}, Enter`);
    await listing.press("Escape");
    assertClosed(listing, `${path}, Escape`);
  }
});
