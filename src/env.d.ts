// Bindings and vars come from wrangler.jsonc through `npm run typegen` (worker-configuration.d.ts).
// Secrets are not in that file: they live in .dev.vars locally and `wrangler secret put` in production,
// so they are declared here, on both the global Env and Cloudflare.Env.

interface Secrets {
  SQUARE_ACCESS_TOKEN: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY: string;
  GOOGLE_SA_EMAIL: string;
  GOOGLE_SA_PRIVATE_KEY: string;
  PUBLISH_SECRET: string;
  MAIL_SECRET: string;
  CANCEL_LINK_SECRET: string;
}

declare namespace Cloudflare {
  interface Env extends Secrets {}
}

interface Env extends Secrets {}
