# Deploy

The runbook for task #48. Nothing here has run against a real Cloudflare account yet; that task corrects whatever turns out different.

## How a deploy runs

- A push to `main` starts the Deploy workflow (`.github/workflows/deploy.yml`), which checks out the pushed commit and runs `scripts/deploy.sh`.
- CI (`.github/workflows/ci.yml`) runs on pull requests only, and the pull request's run is the gate: CI does not run again on `main`, and Deploy does not wait for it. There is no post-merge verify. That is acceptable only because every landing goes through `harness-pr land --catch-up`, which squash-merges exactly the tree a green pull request run verified, and git hooks refuse direct pushes to `main`. A commit that reaches `main` any other way deploys unverified.
- The script runs `npm ci`, `npm run build`, `npx wrangler d1 migrations apply DB --remote` and `npx wrangler deploy`, and stops at the first failure.
- If `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` is unset or empty, the script prints `deploy skipped: Cloudflare credentials not set` and passes.
- Manual run: Actions, Deploy, Run workflow on `main`, or `gh workflow run Deploy --ref main`. This is the owner's override, for redeploying without a new commit: it takes no inputs and deploys the tip of `main`. On any other branch or tag the job is skipped.

## Order

Do these in the order below. Setting the GitHub secrets comes last, because the next push to `main` after that deploys.

## 1. Resources to create

`wrangler.jsonc` already names these. Sign in first with `npx wrangler login`.

| Resource | Command | Then |
| --- | --- | --- |
| D1 database `okinawa-dream` (binding `DB`) | `npx wrangler d1 create okinawa-dream` | Replace the placeholder `database_id` (`00000000-0000-0000-0000-000000000000`) in `wrangler.jsonc` with the printed id. |
| R2 bucket `okinawa-dream-media` (binding `MEDIA`) | `npx wrangler r2 bucket create okinawa-dream-media` | Nothing. Enabling R2 may require a payment method. |
| Custom domain | Put the domain on Cloudflare DNS. | Add `"routes": [{ "pattern": "<domain>", "custom_domain": true }]` to `wrangler.jsonc`, which has no `routes` yet. The first deploy attaches it to the Worker `okinawa-dream`. |

The Astro adapter adds two more bindings at build time, so they are in `dist/server/wrangler.json` but not in `wrangler.jsonc`: `SESSION` (KV) and `IMAGES` (Cloudflare Images). There is nothing to create for `SESSION`: `npx wrangler deploy` creates the namespace on the first deploy, which is why the token in step 4 needs KV access. Check at go-live whether `IMAGES` needs anything on the Workers Free plan.

### Mail web app

Email goes out through the sheet's Apps Script, deployed as a web app (`apps-script/Mail.js`). Sign in as the staff Gmail account, which is the account that sends, and open the sheet's Extensions, Apps Script.

1. Copy in `apps-script/Mail.js` and `apps-script/appsscript.json`, which adds the send-only `script.send_mail` scope. The editor shows the manifest once Project Settings, Show "appsscript.json", is on.
2. Under Project Settings, Script Properties, add `MAIL_SECRET` with a new random value from `openssl rand -hex 32`. Step 3 sets the same value on the Worker.
3. Choose Deploy, New deployment, type Web app. Set Execute as to Me, and Who has access to Anyone, not Anyone with Google account: the Worker cannot sign in, so the signature in each request is the only protection.
4. Approve the authorization prompt. Put the web app URL, which ends in `/exec`, in `APPS_SCRIPT_MAIL_URL` in step 2.

A later change to `Mail.js` goes live only with Deploy, Manage deployments, edit, Version: New version. The URL stays the same.

If the authorization lapses, the web app answers with a Google login page and mail waits in the outbox. It waits for 8 attempts only, about 20 hours 36 minutes, and then the message goes dead, so restore the authorization before that.

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
| `APPS_SCRIPT_MAIL_URL` | The deployed mail web app's URL, from step 1. |
| `STAFF_EMAIL` | The shop's staff address. |
| `ENABLE_GOOGLE_PAY` | `true` offers Google Pay on the hold page, beside the card form. Leave it `false` until the sandbox check in [docs/local-dev.md](local-dev.md#google-pay-and-apple-pay) has passed. |
| `ENABLE_APPLE_PAY` | `true` offers Apple Pay on the hold page, in Safari only. `false` until the [Apple Pay go-live check](#apple-pay-go-live-check) passes. |

Only the exact string `true` turns a wallet on; anything else leaves it off. A wallet that cannot start in the guest's browser stays hidden, and the card form works as before.

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

## Apple Pay go-live check

For task #48, after the first deploy. Apple Pay on the web needs the domain registered with Square and served over HTTPS, so it cannot be checked locally or in the sandbox.

1. The site answers on `https://<domain>` from the custom domain in step 1.
2. In the Square Developer Console, open the production application, then Apple Pay, and add the domain. Square gives a domain association file to serve at `https://<domain>/.well-known/apple-developer-merchantid-domain-association`. Add it to the site, deploy, then choose Verify.
3. Set `ENABLE_APPLE_PAY` to `"true"` in `wrangler.jsonc` and deploy.
4. In Safari on an iPhone or Mac with a card in Wallet, make a hold and open its checkout page. Expect the Apple Pay button under the guest details. Fill in the details, click it, and expect the sheet's total to be the deposit in yen. Pay, and expect the page to reload as confirmed and the payment in the Square Dashboard.
5. Refund that payment the way the shop refunds any booking, so Square and the site agree.
6. In Chrome or Firefox, open a hold page: expect no Apple Pay button and a card form that works.

Result: not run yet. Date: ____. Result: ____.

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

- Revert the bad commit on `main` as well. A rollback lasts only until the next deploy, and the next push to `main` ships the bad commit again.
- A rollback does not touch D1 or R2. Fix bad data with a new migration.
- `npx wrangler d1 time-travel restore okinawa-dream --timestamp=<time>` is the last resort: it discards every booking written after that time, so Square will hold deposits the database no longer knows about.
