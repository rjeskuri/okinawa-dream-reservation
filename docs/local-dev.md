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
  locally, add `NAME=value` to `.dev.vars` and restart the server; a value there wins over `wrangler.jsonc`. The
  [demo site](#demo-site) sets `SITE_URL` and `SQUARE_WEBHOOK_URL` on its own command line, so values for those two in
  `.dev.vars` reach `npm run dev` only.
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

- The demo's links point at the demo. It starts `wrangler dev` with `--var` for `SITE_URL` (http://localhost:8787) and
  `SQUARE_WEBHOOK_URL` (http://localhost:8787/api/webhooks/square), which win over `wrangler.jsonc` and `.dev.vars`, so
  the cancel link in its emails opens http://localhost:8787 too. `wrangler.jsonc` keeps http://localhost:4321 for
  `npm run dev`.
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

### Export the mock to PDF

The mock goes to the customer as PDFs, not as a link. With the demo site running, from a second terminal:

```sh
scripts/export-pdf.sh
```

It prints each page through headless Chrome (the macOS install at `/Applications/Google Chrome.app`, or set `CHROME`),
in English and Japanese, into `mock-pdfs/` (gitignored), as `en-home.pdf`, `ja-rentals-search.pdf` and so on. Rerunning
replaces each PDF and removes the one of a page that fails or is skipped, so the folder holds only this run's output.
The pages are home, rentals with a search two weeks out, a model page, the fee schedule in full and filtered
to one class, FAQ, policies and access. Checkout joins once it renders from a seeded hold.

- The script checks `/api/health` first and stops with a message when the site is down. If another session holds port
  8787, start the demo elsewhere and point the script at it with `EXPORT_BASE_URL=http://localhost:8788`.
- A page that does not answer 200, or whose PDF comes out empty, fails the run and is named at the end. The two fee
  schedule pages are the exception until the fee schedule page exists: a 404 there is listed as skipped.
- Chrome runs with its own throwaway profile, so an open Chrome does not get in the way. The PDFs carry no URL or print
  date in the margins.
- Text that is still a placeholder keeps its dashed box and "draft" label in the PDF.

### Read the emails a booking sends

The outbox holds the emails a booking queues, such as the guest confirmation with its cancel link. Without the Apps Script
mail web app they are never delivered, so render them to files from the local database:

```sh
node scripts/demo-mail.ts
```

It reads the `email` items of the local D1 outbox (`npx wrangler d1 execute DB --local`), whatever their status, and writes
`.demo-mail/<outbox id>.html` and `.txt` for each. Open the HTML in a browser; the cancel link in a guest confirmation
points at the `SITE_URL` of the server that confirmed the booking: http://localhost:8787 for a booking made on the demo,
http://localhost:4321 for one made on `npm run dev`. The link is written when the booking is confirmed, so an email queued
before the demo set `SITE_URL` keeps the old origin; book again for a fresh one. Rerunning overwrites the files. Set
`DEMO_MAIL_DIR` to write elsewhere.
`.demo-mail/` is gitignored because it holds test guest data.

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
- Both suites run 4 files at a time (`--test-concurrency=4`).
- Randomized tests draw a bounded number of cases unless `PROPERTY_RUNS` says otherwise: `full` draws every case, a
  number draws that many. A failing case prints `PROPERTY_SEED=<seed> PROPERTY_RUNS=1`; set both to replay that case
  alone. A pull request's CI run draws the bounded count; a manual "Run workflow" of CI
  (`workflow_dispatch`) draws the full count.

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
  `PropertiesService`, `CacheService`, `LockService`, `ContentService`, `HtmlService`, `DriveApp` and `MimeType`. The
  `HtmlService` fake reads `apps-script/*.html` and records each sidebar and dialog shown; Node cannot run a panel's own
  script, so tests scan the HTML instead.
- The `DriveApp` fake holds the folders a test passes as `folders` (id to file names), and `getFolderById` throws for
  any other id, as Google does for one the user cannot see. `Folder.createFile(blob)` records each file with its
  folder, name, type and bytes in `drive.created`, and throws in a folder listed in `readOnlyFolders`. `Folder.getFiles`
  and `getFilesByName` list the files as they were when called. `Utilities.base64Decode` answers signed bytes, as Apps
  Script does, and throws `Could not decode string.` for text that is not padded base64.
  `Utilities.newBlob(bytes, type, name)` makes the blob `createFile` takes.

## Live checks (manual)

The real services are exercised by hand, one task each, and each task corrects this guide with what it needed:

- Test Google Sheet and service account: task #18.
- Square sandbox with a seller in Japan (JPY) and 3DS test cards: task #37.
- The mail web app (Apps Script): task #45.
- Google Pay in the Square sandbox: task #47, [below](#google-pay-and-apple-pay). Apple Pay can only be checked on the
  production domain, in [docs/deploy.md](deploy.md#apple-pay-go-live-check) (task #48).
- The staff dashboard in the test sheet, with a Drive upload, sandbox refunds and real emails: task #159,
  [below](#staff-dashboard).

Apps Script and Square webhooks reach local dev through a quick tunnel:

```sh
cloudflared tunnel --url http://localhost:4321
```

The tunnel URL changes on each run. Each time, update `WORKER_BASE_URL` in the Apps Script Script Properties,
`SQUARE_WEBHOOK_URL` in `.dev.vars` (`https://<tunnel host>/api/webhooks/square`, then restart `npm run dev`) and the
URL of the Square webhook subscription. `astro.config.mjs` already allows `*.trycloudflare.com` hosts; without that the
dev server answers 403.

Add a bike's photo upload also reads the Script Property `PHOTO_FOLDER_ID`: the test photo folder's id, the same one as
`GOOGLE_DRIVE_FOLDER_ID`. It does not change between runs; [docs/deploy.md](deploy.md#photo-upload-from-add-a-bike) has
the scope and folder access it needs.

### Google Pay and Apple Pay

`ENABLE_GOOGLE_PAY` and `ENABLE_APPLE_PAY` are `"false"` in `wrangler.jsonc`. Only the exact string `true` turns a
wallet on; `TRUE`, `1` or ` true` leave it off. With a flag on, the hold page renders that wallet's mount under the guest
details (`#google-pay-button`, `#apple-pay-button`), and `src/scripts/checkout.ts` loads the wallet code with `import()`
and starts it. A wallet that cannot start stays hidden and the card form works as before. With both off, the page has no
wallet markup and loads no wallet code. A wallet's token goes to the same confirm endpoint as a card's.

To turn one on locally, add `ENABLE_GOOGLE_PAY=true` (or `ENABLE_APPLE_PAY=true`) to `.dev.vars` and restart
`npm run dev`.

Manual Google Pay check in the Square sandbox (not automated; the tests use a fake SDK):

1. Set up the sandbox values of task #37 in `.dev.vars`: the sandbox application id, the Japan seller's location id and the
   sandbox access token.
2. Add `ENABLE_GOOGLE_PAY=true` and restart `npm run dev`. Use Chrome, signed in to a Google account with a card in
   Google Pay. If Google Pay will not start on `http://localhost:4321`, use the quick tunnel above, which is HTTPS.
3. Make a hold and open its checkout page. Expect the Google Pay button under the guest details, and no Apple Pay button.
4. Click it with an empty form: expect the field errors and no Google Pay sheet.
5. Fill in the details and click it. Expect the sheet's total to be the hold's deposit in yen, labelled "Okinawa Dream
   deposit" (in the page's language). Close the sheet: expect no message, and the card and Google Pay still usable.
6. Click it again and pay. Expect the page to reload as confirmed, and the payment for the deposit in the sandbox Seller
   Dashboard.
7. Remove the line from `.dev.vars` and restart: expect no Google Pay button.

Result: not run yet. Date: ____. Result: ____.

### Staff dashboard

The check for task #159 of what the fakes cannot prove: the real panels in a browser, a real Drive upload, Square sandbox
refunds and real emails. It uses the test accounts of tasks #18, #37 and #45, and a computer browser signed in to the
Google account that owns the test sheet. [docs/dashboard.md](dashboard.md) says what each panel should do. File each
problem found as a ticket under epic #140, linked from #159.

Setup, once, in order:

1. Copy the panels into the clasp folder of the test sheet's Apps Script, `~/Projects/OkinawaDream-appsscript`, outside
   the repo. Do not copy `appsscript.json` over: the one there has a `webapp` section for the mail web app that the
   repo's lacks. Add the repo's scopes to it instead, which keeps the rest. From the repo root:

   ```sh
   cp apps-script/*.js apps-script/*.html ~/Projects/OkinawaDream-appsscript/
   node -e '
     const fs = require("node:fs");
     const [repo, target] = process.argv.slice(1);
     const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
     const wanted = JSON.parse(fs.readFileSync(repo, "utf8")).oauthScopes;
     manifest.oauthScopes = [...new Set([...(manifest.oauthScopes ?? []), ...wanted])];
     fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n");
   ' apps-script/appsscript.json ~/Projects/OkinawaDream-appsscript/appsscript.json
   ```

   The manifest there then lists `https://www.googleapis.com/auth/drive.file` and still has its `webapp` section.
2. Run `clasp push` in that folder. If clasp asks whether to overwrite the manifest, answer yes. The mail web app keeps
   running the version it was deployed with.
3. Open the test sheet and reload it. The Okinawa Dream menu lists Open dashboard and the four actions. Choose Open
   dashboard: Google asks to authorize the script again, now with access to the Drive files it creates. Allow it.
4. In Extensions > Apps Script > Project Settings > Script Properties, `PUBLISH_SECRET` and `MAIL_SECRET` already hold
   the values in `.dev.vars`. Add `PHOTO_FOLDER_ID`, the test photo folder's id: the `GOOGLE_DRIVE_FOLDER_ID` the local
   site uses. Paste values there only.
5. Choose Okinawa Dream > Set up tabs. Expect the alert to name Dashboard, and the Dashboard tab to list the four actions
   with their functions.
6. On the Dashboard tab, add a drawing assigned to `openAddBike`, as [docs/dashboard.md](dashboard.md#setup) says.
7. In `.dev.vars`, add `STAFF_EMAIL=<inbox>`, with an inbox you can read in place of `<inbox>`. The shop's emails go to
   it, and the checks call it the `STAFF_EMAIL` inbox. A line in `.dev.vars` wins over the placeholder in
   `wrangler.jsonc` ([First run](#first-run)), and each email takes the address when it is queued, so set it before the
   checks. Check that `APPS_SCRIPT_MAIL_URL` there is the URL of the mail web app of task #45, ending in `/exec`:
   without it no email is sent. Restart `npm run dev` if it is running.

Each run:

1. Start `npm run dev` and the quick tunnel [above](#live-checks-manual), and make its three updates: `WORKER_BASE_URL`,
   `SQUARE_WEBHOOK_URL` in `.dev.vars` with a restart of `npm run dev`, and the URL of the sandbox webhook subscription,
   which needs the events `payment.created`, `payment.updated`, `refund.created` and `refund.updated`. Expect the
   dashboard's home to list nothing missing.
2. Choose Okinawa Dream > Publish to website, so the local site holds the test sheet's catalog. Expect `Published
   version` and a number.

The checks, in order:

1. **Add a bike.** Every type has a Types row in the test sheet, so to write all five tabs, first clear the cells of the
   `scooter` row in Types, noting its deposit and names. Do not Publish until Add a bike has saved, which writes the row
   back, and put it back by hand if the check stops before that. Open Add a bike from the drawing, and add a bike of a
   new scooter model with a new rate class: a price for one package or more, the deposit and names you noted, the
   English name `=Dashboard test`, the plate `2002`, and one JPEG photo. Expect:
   - the steps to fit the window, and Back and Next to work;
   - the upload to list `<model id>-1.jpg`, and that file in the test photo folder in Drive;
   - the result to list one row each in Types, RateClasses, Models and Vehicles and one Prices row per price, each with
     publish_status `ok` or a translation warning, then `Published version` and a number;
   - the new PublishLog row to show `1 copied` under photos, and http://localhost:4321/en/rentals/<model id> to show
     the photo.

   If the upload is refused for a missing permission, record Google's words: that settles the `drive.file` question in
   [docs/deploy.md](deploy.md#photo-upload-from-add-a-bike).
2. **Add a reservation.** Book a guest with your own inbox as the email and a pickup some days ahead. Expect the Booked
   step with a ref, a plate, the return and the deposit to collect at the shop. Within a few minutes expect, in your
   inbox, the confirmation email in the guest's language, with the deposit to pay at the shop, a line that cancelling
   refunds nothing, and a cancel link; the new-booking email in the `STAFF_EMAIL` inbox; and a Bookings row with source
   `staff` and `paid_jpy` 0. Open the cancel link on this computer, since it points at `SITE_URL`,
   http://localhost:4321. Expect the page to say nothing was paid online, so cancelling refunds nothing. Press Cancel
   this booking: expect the done page, the guest's cancellation email in your inbox and the shop's in the `STAFF_EMAIL`
   inbox, the Bookings row `CANCELLED`, and nothing in the sandbox. When an email or a row does not come, run the
   ten-minute cron as in [Crons locally](#crons-locally), which sends what the outbox holds.
3. **Cancel with each choice.** On http://localhost:4321 make three bookings, each with your own inbox as the guest's
   email, and pay each deposit with a sandbox test card (task #37), with pickups whose tier gives between 0% and 100%
   (see the Cancellation tab), so the three choices differ.
   Once each shows `CONFIRMED` on the Bookings tab, cancel the first with Tier refund, the second with Full refund and the
   third with No refund. For each, expect the confirm screen to show the choice and amount clicked, and the result to say
   Square accepted or made that refund, or no refund for the third. In the sandbox Seller Dashboard, expect a refund of
   the tier amount on the first payment, of the whole deposit on the second, and none on the third. Expect the guest's
   cancellation emails in your inbox and the shop's in the `STAFF_EMAIL` inbox, and the three Bookings rows `CANCELLED`.
   Then run the daily check while `npm run dev` runs, since both read the same local D1. In a second terminal:

   ```sh
   npm run build
   npx wrangler dev --test-scheduled
   ```

   In a third:

   ```sh
   curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+18+*+*+*'
   npx wrangler d1 execute DB --local --command "SELECT cron, status, detail FROM cron_runs ORDER BY ran_at DESC LIMIT 1"
   ```

   Expect `ok`, the run's status `ok`, and the Reconciliation tab rewritten with no issue naming the three bookings' refs.
   An issue about another booking comes from earlier sandbox tests: note it.
4. **Block a bike.** Make a reservation with Add a reservation, with no email, and note its plate, pickup and return. In
   Block a bike, block that plate for a day starting a week after the return, with a reason. Expect the green result, a
   new Blocks row with an `MNT-` id, `maintenance` and the reason, publish_status `ok`, and a PublishLog row naming it.
   Then block the same plate for a time inside the reservation. Expect the red result naming the reservation's ref and
   the plate, and the same error in that row's publish_status. Keep both rows for check 5.
5. **How Sheets stored the values.** In a scratch tab, `=TYPE(<cell>)` answers 1 for a number, a date-time cell
   included, and 2 for text. Use it on:
   - the plate `2002` in Vehicles, from check 1: expect the row `ok` either way, and `2002` in Block a bike's plate list;
   - `start` and `end` of the green Blocks row, from check 4: expect them to show the Japan time entered, and the row
     `ok`;
   - `name_en` `=Dashboard test` in Models, from check 1: expect 2, the text as typed with no formula result or error, and
     the same name on the model page.

   Record each answer, then delete the scratch tab. A plate read as another number, a time off by hours, or a name run
   as a formula is a problem to file.

Clean up, which also checks that deleting a row ends a block early:

1. Delete the green Blocks row and keep the red one, so the tab is not left empty: a tab with no data rows cancels
   nothing. Choose Publish to website. Expect the block cancelled: this lists its `block_id` as `CANCELLED`.

   ```sh
   npx wrangler d1 execute DB --local \
     --command "SELECT external_ref, status FROM bookings WHERE source = 'block' AND external_ref LIKE 'MNT-%'"
   ```

2. Delete the red row and Publish. Cancel the reservation of check 4 with Cancel a booking.
3. Set the test model's `active` to FALSE and Publish, or leave it on the test site.

Date: ____.

- Check 1, Add a bike. Result: not run yet.
- Check 2, Add a reservation. Result: not run yet.
- Check 3, Cancel with each choice. Result: not run yet.
- Check 4, Block a bike. Result: not run yet.
- Check 5, How Sheets stored the values. Result: not run yet.

## Not enforced locally

The Workers Free limits of 10 ms CPU, 50 subrequests and 50 D1 queries per invocation. Production measures them (task #48).

## Troubleshooting

`Tsconfig not found astro/tsconfigs/strict` from `astro dev` or `astro build` means a `tsconfig.json` above the project
(for example a main checkout that holds this worktree under `.claude/worktrees/`) extends `astro/...` but has no
`node_modules` to resolve it. Put a `node_modules` where that parent can find it, for example a symlink to this project's,
or work from a clone outside the other checkout.
