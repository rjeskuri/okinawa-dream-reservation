// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// Every route renders on demand in the Worker (`output: "server"`); the adapter builds `src/worker.ts`
// from wrangler.jsonc's `main`. No i18n yet: task #23 adds the four-language routing.
export default defineConfig({
  output: "server",
  adapter: cloudflare(),
});
