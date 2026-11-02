// The Worker entry: Astro answers every fetch through the adapter's handler, and Cron Triggers reach
// `scheduled()`, which the adapter's default entry does not export.
import { handle } from "@astrojs/cloudflare/handler";
import { runCron } from "./cron/index.ts";

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(controller.cron, controller.scheduledTime, env));
  },
} satisfies ExportedHandler<Env>;
