// The client of src/components/DatePicker.astro: the `date-picker` element, defined on import. It swaps the plain date
// input for a date field that opens the month grid below it (#137) and writes the choice to the hidden `date` input. The
// field reads the pickup and the return of the package the page reports through `package-days` and `package-hours`.
import { monthGrid, returnDate, returnSummary, type CalendarDay, type DisabledReason } from "../lib/calendar.ts";
import type { Locale } from "../lib/locale.ts";
import { addDaysToDate } from "../lib/time.ts";
import type { PackageLength } from "../lib/types.ts";

interface Config {
  locale: Locale;
  lang: string;
  shopClose: string;
  closedDates: string[];
  labels: Record<"pickup" | "return" | "empty" | DisabledReason, string>;
}

/** YYYY-MM-01 of a month counted from year 0, so adding to the count crosses year ends. */
function monthStart(months: number): string {
  const year = String(Math.floor(months / 12)).padStart(4, "0");
  const month = String((months % 12) + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/** The same day `delta` months away, or that month's last day when it is shorter. */
function addMonths(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const months = year * 12 + month - 1 + delta;
  const last = addDaysToDate(monthStart(months + 1), -1);
  const same = addDaysToDate(monthStart(months), day - 1);
  return same < last ? same : last;
}

/** Where each key moves the cursor. `column` is the cell's place in its week, 0 for Sunday. */
const MOVES: Record<string, (date: string, column: number) => string> = {
  ArrowLeft: (date) => addDaysToDate(date, -1),
  ArrowRight: (date) => addDaysToDate(date, 1),
  ArrowUp: (date) => addDaysToDate(date, -7),
  ArrowDown: (date) => addDaysToDate(date, 7),
  Home: (date, column) => addDaysToDate(date, -column),
  End: (date, column) => addDaysToDate(date, 6 - column),
  PageUp: (date) => addMonths(date, -1),
  PageDown: (date) => addMonths(date, 1),
};

/** A whole number of at least 1 from an attribute, else null: a missing or empty attribute reads as 0. */
function wholeAttribute(value: string | null): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

class DatePicker extends HTMLElement {
  static observedAttributes = ["package-days", "package-hours"];
  private refresh?: () => void;

  attributeChangedCallback() {
    this.refresh?.();
  }

  connectedCallback() {
    const { locale, lang, shopClose, closedDates, labels } = JSON.parse(this.dataset.config ?? "") as Config;
    const part = <T extends Element>(selector: string) => this.querySelector<T>(selector) as T;
    const fallback = part<HTMLInputElement>("input[type=date]");
    const hidden = part<HTMLInputElement>("input[type=hidden]");
    const field = part<HTMLButtonElement>("button[data-field]");
    const popup = part<HTMLElement>("[data-calendar]");
    const previous = part<HTMLButtonElement>("[data-previous]");
    const next = part<HTMLButtonElement>("[data-next]");
    const month = part<HTMLElement>("[data-month]");
    const weekdays = part<HTMLElement>("[data-weekdays]");
    const weeks = part<HTMLElement>("[data-weeks]");
    const { min, max } = fallback;
    const opts = { minDate: min, maxDate: max, closedDates };

    // Every name is formatted in UTC from a UTC midnight, so the guest's own zone cannot shift the day.
    const formatter = (options: Intl.DateTimeFormatOptions) => {
      const format = new Intl.DateTimeFormat(lang, { ...options, timeZone: "UTC" });
      return (date: string) => format.format(new Date(`${date}T00:00:00Z`));
    };
    const monthName = formatter({ year: "numeric", month: "long" });
    const fullDate = formatter({ dateStyle: "full" });
    const shortWeekday = formatter({ weekday: "short" });
    const longWeekday = formatter({ weekday: "long" });

    const clamp = (date: string) => (date < min ? min : date > max ? max : date);
    const gridOf = (date: string) => monthGrid(Number(date.slice(0, 4)), Number(date.slice(5, 7)), opts);

    /** The package the page reports: an hours package by package-hours, a days package by package-days alone. */
    const chosenPackage = (): PackageLength | null => {
      const hours = wholeAttribute(this.getAttribute("package-hours"));
      if (hours !== null) return { days: null, hours };
      const days = wholeAttribute(this.getAttribute("package-days"));
      return days === null ? null : { days, hours: null };
    };

    // The cursor is the date holding the grid's one tab stop, and the month on show is always the cursor's. A browser
    // empties a malformed value, so the clamped date is a real one, and a pickup that is not selectable is dropped.
    let cursor = clamp(fallback.value || min);
    let selected = gridOf(cursor)
      .flat()
      .some((day) => day.date === fallback.value && !day.disabled)
      ? fallback.value
      : null;

    const dayCell = (day: CalendarDay, back: string | null) => {
      const cell = document.createElement("td");
      const note = day.reason === undefined ? (day.date === back ? labels.return : null) : labels[day.reason];
      cell.textContent = String(Number(day.date.slice(8)));
      cell.dataset.date = day.date;
      cell.tabIndex = day.date === cursor ? 0 : -1;
      cell.classList.toggle("is-outside", !day.inMonth);
      cell.classList.toggle("is-return", day.date === back);
      cell.setAttribute("aria-selected", String(day.date === selected));
      cell.setAttribute("aria-label", note === null ? fullDate(day.date) : `${fullDate(day.date)} (${note})`);
      if (day.reason !== undefined) {
        cell.setAttribute("aria-disabled", "true");
        cell.title = labels[day.reason];
      }
      return cell;
    };

    const focusCursor = () => weeks.querySelector<HTMLElement>('[tabindex="0"]')?.focus();

    const render = () => {
      // A missing or empty attribute reads as 0. Anything but a whole number of at least 1 has no return date.
      const days = wholeAttribute(this.getAttribute("package-days"));
      const back = selected !== null && days !== null ? returnDate(selected, days) : null;
      const shown = cursor.slice(0, 7);
      month.textContent = monthName(`${shown}-01`);
      previous.disabled = shown <= min.slice(0, 7);
      next.disabled = shown >= max.slice(0, 7);
      weeks.replaceChildren(
        ...gridOf(cursor).map((week) => {
          const row = document.createElement("tr");
          row.replaceChildren(...week.map((day) => dayCell(day, back)));
          return row;
        }),
      );
      hidden.value = selected ?? "";
      const text = selected === null ? labels.empty : returnSummary(locale, selected, chosenPackage(), shopClose);
      field.textContent = text;
      field.setAttribute("aria-label", `${labels.pickup}: ${text}`);
    };

    const isOpen = () => !popup.hidden;

    const open = () => {
      if (selected !== null) cursor = selected;
      popup.hidden = false;
      field.setAttribute("aria-expanded", "true");
      render();
      focusCursor();
    };

    /** Closes the calendar, and gives the focus back to the field unless the guest moved it elsewhere. */
    const close = (refocus: boolean) => {
      popup.hidden = true;
      field.setAttribute("aria-expanded", "false");
      if (refocus) field.focus();
    };

    const select = (date: string) => {
      selected = date;
      cursor = date;
      render();
      close(true);
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const turnMonth = (button: HTMLButtonElement, delta: number) => {
      cursor = clamp(addMonths(cursor, delta));
      render();
      // A disabled button drops the focus it holds.
      if (button.disabled) focusCursor();
    };

    field.addEventListener("click", () => (isOpen() ? close(true) : open()));
    previous.addEventListener("click", () => turnMonth(previous, -1));
    next.addEventListener("click", () => turnMonth(next, 1));

    weeks.addEventListener("click", (event) => {
      const cell = (event.target as Element).closest<HTMLTableCellElement>("td");
      if (cell !== null && !cell.hasAttribute("aria-disabled")) select(cell.dataset.date as string);
    });

    weeks.addEventListener("keydown", (event) => {
      const cell = (event.target as Element).closest<HTMLTableCellElement>("td");
      if (cell === null) return;
      const date = cell.dataset.date as string;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!cell.hasAttribute("aria-disabled")) select(date);
        return;
      }
      const move = MOVES[event.key];
      if (move === undefined) return;
      event.preventDefault();
      cursor = clamp(move(date, cell.cellIndex));
      render();
      focusCursor();
    });

    // Escape, a tap outside or the focus leaving the picker closes the calendar and keeps the pickup.
    this.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !isOpen()) return;
      event.preventDefault();
      close(true);
    });
    document.addEventListener("pointerdown", (event) => {
      if (isOpen() && !event.composedPath().includes(this)) close(false);
    });
    this.addEventListener("focusout", (event) => {
      const to = event.relatedTarget;
      if (isOpen() && to instanceof Element && !this.contains(to)) close(false);
    });

    weekdays.replaceChildren(
      ...gridOf(cursor)[0].map((day) => {
        const heading = document.createElement("th");
        heading.scope = "col";
        heading.abbr = longWeekday(day.date);
        heading.textContent = shortWeekday(day.date);
        return heading;
      }),
    );

    fallback.disabled = true;
    part<HTMLElement>("[data-fallback]").hidden = true;
    hidden.disabled = false;
    part<HTMLElement>("[data-field-wrap]").hidden = false;
    this.refresh = render;
    render();
  }
}

customElements.define("date-picker", DatePicker);
