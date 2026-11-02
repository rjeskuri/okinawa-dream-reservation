# Local development and testing

Everything here runs on your machine with no Cloudflare account. Commands are for zsh on macOS, from the repo root.

## Prerequisites

- Node 24 or newer (CI runs 24) and npm.
- `brew install cloudflared`, only for the [live checks](#live-checks-manual).

## First run

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
```

Fill in `.dev.vars` after copying it; the comments in the file say what each value is.

Seed a small sample catalog, before starting the server:

```sh
npx wrangler d1 execute DB --local --file seed/local.sql
```

The seed uses plain INSERTs, so to reseed, delete `.wrangler/state` first, then migrate and seed again.

Start the server; it serves http://localhost:4321:

```sh
npm run dev
```

- `.dev.vars` holds the secrets declared in `src/env.d.ts`. It is gitignored and never committed. The placeholders in the
  example are enough for `npm run dev` and the tests; real values are needed only for the live checks.
- The non-secret vars (`SITE_URL`, `SQUARE_ENV`, `SQUARE_WEBHOOK_URL`, ...) come from `wrangler.jsonc`. To override one
  locally, add `NAME=value` to `.dev.vars` and restart the server; a value there wins over `wrangler.jsonc`.
- The local D1 database is one SQLite file under `.wrangler/state/v3/d1/`. `npm run dev`, `npx wrangler d1 execute DB --local`
  and `npx wrangler dev` all use it, so what you seed or migrate is what the site sees. Delete `.wrangler/state` to start over.
- Check it is up: `curl http://localhost:4321/api/health` answers `{"ok":true,"db":true}`.
- Stop the server with Ctrl-C. If your shell is an AI agent's, `astro dev` detaches itself instead; stop it with
  `npx astro dev stop`.

## Demo site

One command runs the built site with the shop's line-up and rates, on local data only. It needs no Cloudflare login, no
Google account and no `.dev.vars` beyond the example:

```sh
scripts/demo.sh
```

It installs dependencies if `node_modules` is missing, copies `.dev.vars.example` to `.dev.vars` if that is missing, builds
the site, applies the migrations, loads `seed/demo.sql`, puts the photos in the local R2 bucket, and starts the Worker on
http://localhost:8787 until you press Ctrl-C. Run it again whenever you like: nothing fails or doubles, and bookings you
made stay. An existing `.dev.vars` is left alone.

- `seed/demo.sql` is transcribed from the shop's site. Its header lists what is a placeholder, including every deposit,
  refund tier, plate and closed date. Models and vehicles it does not name, such as those of `seed/local.sql`, end up
  inactive and retired.
- `seed/local.sql` uses plain INSERTs, so it fails on a database that holds the demo. Delete `.wrangler/state` first.
- `seed/photos/` holds one placeholder per model, and the seed's `photos` rows describe those files. To see the shop's own
  photos, put them in `seed/photos-local/` under the same file names (`honda-pcx125.jpg`) and run the script again. That
  folder is gitignored because the rights to those photos are unconfirmed. A local file goes in under the placeholder's
  key, so its `/media` URL does not change, and a browser that has already cached that URL needs a hard reload.

Trigger a cron while it runs, from a second terminal:

```sh
curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*'
```

[Crons locally](#crons-locally) has the details.

## Crons locally

`astro dev` does not run crons. Run the built Worker with scheduled triggers enabled. It serves `dist/server` via
`.wrangler/deploy/config.json` on http://localhost:8787 and keeps running, so run the `curl` from a second terminal:

```sh
npm run build
npx wrangler dev --test-scheduled
```

```sh
curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*'
```

The `curl` answers `ok`.

- Quote the URL: zsh refuses unquoted `?` and `*`. In the URL `+` stands for a space, so the cron is `*/10 * * * *`.
  The other registered cron is `0 18 * * *` (`0+18+*+*+*`). Any other expression is recorded with status `unknown`.
- Each run leaves a row: `npx wrangler d1 execute DB --local --command "SELECT cron, status FROM cron_runs"`.
- `wrangler dev` serves the build, not the source: run `npm run build` again after a code change. It reads `.dev.vars` live.

## Tests

- `npm test` runs the unit tests (`tests/*.test.ts`) with Node's runner. D1 runs in Miniflare in memory; there is no network.
- `npm run test:e2e` runs the built Worker in Miniflare (`tests/e2e/*.e2e.ts`). It builds first if `dist` is older than
  `src`, `migrations`, `astro.config.mjs` or `wrangler.jsonc`.
- `scripts/verify.sh` runs lint, `npm test`, `npm run build` and `npm run test:e2e`. CI and the stop hook run it.

## How fakes work

No test touches the network, Google, Square or a real D1.

Present now:

- `tests/helpers/d1.ts`: `createTestDb()` returns `{ db, dispose }`, a fresh in-memory D1 with every `migrations/*.sql`
  applied. Call `dispose()` when done.
- `tests/helpers/worker.ts`: `startWorker({ vars?, outbound? })` builds the site when stale and starts the built Worker in
  Miniflare with D1 and R2 and test values for every var and secret (`testVars`; `vars` overrides some). It returns
  `{ fetch, scheduled, db, media, stop }`. `outbound` answers the Worker's own `fetch()` calls; it is passed to Miniflare as
  `outboundService`. The default answers every outbound request with a 502, so an unfaked call fails loudly.

Rules for the tasks to come:

- Code in `src/lib` takes `fetch`, the clock and API clients as parameters, so unit tests pass fakes.
- E2e tests fake the Google token, Sheets, Drive, Square and Apps Script endpoints inside `outbound`, switching on the
  request URL.
- The Apps Script files in `apps-script/` run in a Node `vm` with fake `SpreadsheetApp`, `UrlFetchApp`, `MailApp`, `Utilities`,
  `PropertiesService`, `CacheService`, `LockService` and `ContentService`.

## Live checks (manual)

The real services are exercised by hand, one task each, and each task corrects this guide with what it needed:

- Test Google Sheet and service account: task #18.
- Square sandbox with a seller in Japan (JPY) and 3DS test cards: task #37.
- The mail web app (Apps Script): task #45.

Apps Script and Square webhooks reach local dev through a quick tunnel:

```sh
cloudflared tunnel --url http://localhost:4321
```

The tunnel URL changes on each run. Each time, update `WORKER_BASE_URL` in the Apps Script Script Properties,
`SQUARE_WEBHOOK_URL` in `.dev.vars` (`https://<tunnel host>/api/webhooks/square`, then restart `npm run dev`) and the
URL of the Square webhook subscription. `astro.config.mjs` already allows `*.trycloudflare.com` hosts; without that the
dev server answers 403.

## Not enforced locally

The Workers Free limits of 10 ms CPU, 50 subrequests and 50 D1 queries per invocation. Production measures them (task #48).

## Troubleshooting

`Tsconfig not found astro/tsconfigs/strict` from `astro dev` or `astro build` means a `tsconfig.json` above the project
(for example a main checkout that holds this worktree under `.claude/worktrees/`) extends `astro/...` but has no
`node_modules` to resolve it. Put a `node_modules` where that parent can find it, for example a symlink to this project's,
or work from a clone outside the other checkout.
