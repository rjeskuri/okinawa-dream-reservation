// What Astro answers for a throw in any route, once it has logged the failure. Without this route the lookup of /500 lands
// on /[locale]/, which answers 404 or renders a locale page. The body is plain words, because the Apps Script prints it to
// staff as it stands, after "the Worker answered 500:", and it carries no text of the failure.
import type { APIRoute } from "astro";

export const ALL: APIRoute = () =>
  new Response("Something went wrong on our side, so this request did not finish. Please try again.", { status: 500 });
