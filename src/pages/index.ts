// GET /: sends the reader to the locale their Accept-Language asks for, keeping the query string.
import type { APIRoute } from "astro";
import { negotiateLocale } from "../i18n/locales.ts";

export const GET: APIRoute = ({ request, url }) => {
  const locale = negotiateLocale(request.headers.get("accept-language"));
  return new Response(null, {
    status: 302,
    headers: { Location: `/${locale}/${url.search}`, Vary: "Accept-Language" },
  });
};
