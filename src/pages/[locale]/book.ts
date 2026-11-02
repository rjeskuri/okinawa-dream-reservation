// /{locale}/book: POST holds a bike for the model page's form, then sends the guest on to checkout, or back to the page
// with the reason and the search. The form chooses only the model, package and pickup: the server makes the id, the path
// gives the locale, and the bike, price and deposit are createHold's. Astro's origin check refuses a post from another site.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { createHold } from "../../lib/booking/holds.ts";
import { pickupInstant } from "../../lib/booking/pickup-window.ts";
import { isLocale } from "../../lib/locale.ts";

/** Longer than any date, time or package id, so that a guest's megabyte field stays out of the Location header. */
const MAX_CARRIED_LENGTH = 200;

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

/** The posted form. JSON or no body at all reads as an empty form, which names no model. */
async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export const POST: APIRoute = async ({ params, request }) => {
  const { locale } = params;
  // Astro's own check ignores case and sees any segment of the path, so it passes /JA/.
  if (!isLocale(locale)) return new Response(null, { status: 404 });

  const form = await readForm(request);
  const modelId = field(form, "model");
  const packageId = field(form, "package");
  const date = field(form, "date");
  const time = field(form, "time");

  const startAt = pickupInstant(date, time);
  const hold = { id: crypto.randomUUID(), modelId, packageId, startAt, locale };
  const result = await createHold(env.DB, hold, Date.now());
  if (result.ok) return seeOther(`/${locale}/checkout/${result.booking.id}`);

  // There is no model page to go back to, and from here on `modelId` is one the catalog holds.
  if (result.reason === "UNKNOWN_MODEL") return seeOther(`/${locale}/rentals/`);

  const query = new URLSearchParams({ error: result.reason });
  for (const [name, value] of Object.entries({ date, time, package: packageId })) {
    if (value !== "" && value.length <= MAX_CARRIED_LENGTH) query.set(name, value);
  }
  return seeOther(`/${locale}/rentals/${encodeURIComponent(modelId)}?${query}`);
};

export const ALL: APIRoute = ({ params }) => {
  if (!isLocale(params.locale)) return new Response(null, { status: 404 });
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
};
