# Deploy

The runbook for task #48. Nothing here has run against a real Cloudflare account yet; that task corrects whatever turns out different.

## How a deploy runs

- CI passes on a push to `main`, then the Deploy workflow (`.github/workflows/deploy.yml`) checks out that commit and runs `scripts/deploy.sh`.
- The script runs `npm ci`, `npm run build`, `npx wrangler d1 migrations apply DB --remote` and `npx wrangler deploy`, and stops at the first failure.
- If `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` is unset or empty, the script prints `deploy skipped: Cloudflare credentials not set` and passes.
- Manual run: Actions, Deploy, Run workflow on `main`, or `gh workflow run Deploy --ref main`. This is the owner's override, for redeploying without a new commit: it takes no inputs, deploys the tip of `main` and does not wait for CI. On any other branch or tag the job is skipped.

## Order

Do these in the order below. Setting the GitHub secrets comes last, because the next CI success on `main` after that deploys.

## 1. Resources to create

`wrangler.jsonc` already names these. Sign in first with `npx wrangler login`.

| Resource | Command | Then |
| --- | --- | --- |
| D1 database `okinawa-dream` (binding `DB`) | `npx wrangler d1 create okinawa-dream` | Replace the placeholder `database_id` (`00000000-0000-0000-0000-000000000000`) in `wrangler.jsonc` with the printed id. |
| R2 bucket `okinawa-dream-media` (binding `MEDIA`) | `npx wrangler r2 bucket create okinawa-dream-media` | Nothing. Enabling R2 may require a payment method. |
| Custom domain | Put the domain on Cloudflare DNS. | Add `"routes": [{ "pattern": "<domain>", "custom_domain": true }]` to `wrangler.jsonc`, which has no `routes` yet. The first deploy attaches it to the Worker `okinawa-dream`. |

The Astro adapter adds two more bindings at build time, so they are in `dist/server/wrangler.json` but not in `wrangler.jsonc`: `SESSION` (KV) and `IMAGES` (Cloudflare Images). There is nothing to create for `SESSION`: `npx wrangler deploy` creates the namespace on the first deploy, which is why the token in step 4 needs KV access. Check at go-live whether `IMAGES` needs anything on the Workers Free plan.

## 2. Vars

Replace the placeholders under `vars` in `wrangler.jsonc`. They are committed and are not secret.

| Var | Production value |
| --- | --- |
| `SITE_URL` | `https://<domain>` |
| `SQUARE_ENV` | `production` |
| `SQUARE_APPLICATION_ID` | The Square production application id. |
| `SQUARE_LOCATION_ID` | The Square production location id. |
| `SQUARE_WEBHOOK_URL` | `https://<domain>/api/webhooks/square` |
| `GOOGLE_SHEET_ID` | The production sheet's id. |
| `GOOGLE_DRIVE_FOLDER_ID` | The photo folder's id. |
| `APPS_SCRIPT_MAIL_URL` | The deployed mail web app's URL. |
| `STAFF_EMAIL` | The shop's staff address. |
| `ENABLE_GOOGLE_PAY`, `ENABLE_APPLE_PAY` | `false` unless task #47 ran. |

Run `npm run typegen` after the edit, and commit `wrangler.jsonc` and `worker-configuration.d.ts` together. Without credentials set, that push still skips.

## 3. Worker secrets

Set each one with `wrangler secret put`, which prompts for the value. Never put a value on a command line. The names are the ones in `src/env.d.ts`.

```sh
npx wrangler secret put SQUARE_ACCESS_TOKEN
npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY
npx wrangler secret put GOOGLE_SA_EMAIL
npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
npx wrangler secret put PUBLISH_SECRET
npx wrangler secret put MAIL_SECRET
npx wrangler secret put CANCEL_LINK_SECRET
```

The first run offers to create the Worker, because it does not exist yet. Accept.

## 4. Turn deploys on

Create a Cloudflare API token from the Edit Cloudflare Workers template, which should already cover Workers and KV. Add D1 Edit, and limit it to this account and the domain's zone. Then set both GitHub repository secrets. `gh secret set` prompts for the value.

```sh
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

Run the first deploy by hand with `gh workflow run Deploy --ref main` and watch it with `gh run watch`.

## Migrations stay additive

The script applies migrations before it deploys the Worker, and `wrangler rollback` restores code only. So the previous Worker version runs against the new schema whenever a deploy fails after its migrations, during every deploy for a moment, and after every rollback.

- Add tables, indexes and columns that are nullable or have a default.
- Never edit a migration that has shipped.
- To drop or rename something, first ship a Worker that no longer uses it. Drop it in a later migration, once no version you might roll back to reads it.

## Roll back

```sh
npx wrangler deployments list
npx wrangler rollback <version-id> --message "<reason>"
```

Without a version id, `wrangler rollback` picks the previous version.

- Revert the bad commit on `main` as well. A rollback lasts only until the next deploy, and the next CI success on `main` ships the bad commit again.
- A rollback does not touch D1 or R2. Fix bad data with a new migration.
- `npx wrangler d1 time-travel restore okinawa-dream --timestamp=<time>` is the last resort: it discards every booking written after that time, so Square will hold deposits the database no longer knows about.
