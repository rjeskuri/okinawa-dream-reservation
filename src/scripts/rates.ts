// The live view of the fee schedule's filter form. Without JavaScript the form submits and the server narrows the table, so
// this is only an enhancement. It applies buildFeeTable's rules to the rendered table, which holds every class and package a
// group has: the filters pick rows and columns, and a group left with no price disappears.
const FILTERS = ["group", "class", "duration"];

const form = document.querySelector<HTMLFormElement>("form.filters");

form?.addEventListener("change", () => {
  const data = new FormData(form);
  const [group, rateClass, duration] = FILTERS.map((name) => String(data.get(name) ?? ""));

  const sections = [...document.querySelectorAll<HTMLElement>("[data-rates-group]")];
  for (const section of sections) {
    for (const row of section.querySelectorAll<HTMLElement>("tr[data-class]")) {
      row.hidden = Boolean(rateClass) && row.dataset.class !== rateClass;
    }
    for (const cell of section.querySelectorAll<HTMLElement>("[data-package]")) {
      cell.hidden = Boolean(duration) && cell.dataset.package !== duration;
    }
    const priced = section.querySelector("tr[data-class]:not([hidden]) td:not([hidden]) a") !== null;
    section.hidden = !priced || (Boolean(group) && section.dataset.ratesGroup !== group);
  }

  // The form holds only valid choices, so whatever the server refused is gone.
  const invalid = document.querySelector<HTMLElement>('[data-rates-error="invalid"]');
  const empty = document.querySelector<HTMLElement>('[data-rates-error="empty"]');
  if (invalid) invalid.hidden = true;
  if (empty) empty.hidden = sections.some(({ hidden }) => !hidden);

  const params = new URLSearchParams();
  for (const name of FILTERS) {
    const value = data.get(name);
    if (typeof value === "string" && value !== "") params.set(name, value);
  }
  const search = params.size > 0 ? `?${params}` : "";
  history.replaceState(null, "", location.pathname + search);
  // The language switcher carries the query, as Base.astro renders it for the server's URL.
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[hreflang]")) link.search = search;
});
