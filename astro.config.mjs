// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// Every route renders on demand in the Worker (`output: "server"`); the adapter builds `src/worker.ts`
// from wrangler.jsonc's `main`.
export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  // `redirectToDefaultLocale` stays off, so Astro leaves `/` to src/pages/index.ts, which negotiates it.
  i18n: {
    locales: ["ja", "en", "zh-cn", "ko"],
    defaultLocale: "ja",
    routing: { prefixDefaultLocale: true },
  },
  // `astro dev` answers 403 to unknown hosts; live checks reach it through Cloudflare quick tunnels.
  server: { allowedHosts: [".trycloudflare.com"] },
});
