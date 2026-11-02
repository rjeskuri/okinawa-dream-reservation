<!--
Maintainer notes (HTML comments are stripped before Claude sees this file, so they cost no context).
Scaffolded by harness-scaffold (node, 2026). Keep it short: only what Claude cannot infer
from the code. When Claude makes the same mistake twice, add one line here.
-->

# okinawa-dream-reservation

Booking site for an Okinawa rental shop (motorcycles, scooters, cars). Guests book ahead and pay a Square deposit; staff run inventory, prices and packages in Google Sheets. Correct means no double-bookings, site prices equal the last published sheet, and every deposit and refund reconciles with Square.

## Commands
- Verify, the whole suite plus lint (CI and the stop hook run the same): `scripts/verify.sh`
- Named test files: `npm test -- {files}`, with `{files}` replaced by their paths

## Where things live
- `src/lib/`: pure TypeScript tested in Node. No `cloudflare:workers` or `astro:*` imports; relative imports end in `.ts`.
- `src/server/`: factories that read `env`.
- `src/pages/`: routes and API endpoints.
- `src/worker.ts` and `src/cron/`: the Worker entry and cron jobs.
- `migrations/`: D1 SQL.
- `apps-script/`: the sheet-bound Apps Script.
- `tests/`: the test suite (`npm test`, Node's runner over `tests/*.test.ts`).
- `tests/e2e/`: tests against the built Worker in Miniflare (`npm run test:e2e`).
- `tests/helpers/`: shared test helpers: `d1.ts` (in-memory D1 with the migrations) and `worker.ts` (the built Worker).
- `docs/`: sheet schema, data model, local dev, deploy. Local dev and testing: [docs/local-dev.md](docs/local-dev.md); local secrets template: [.dev.vars.example](.dev.vars.example).
- `scripts/verify.sh`: the checks behind the verify command; `.github/workflows/ci.yml` runs it.
- `.githooks/pre-commit`: format and lint checks on staged files.

## Conventions
- Ask before adding a dependency; say what it does that the standard library or existing ones cannot.
- Secrets come from the environment or a gitignored `.dev.vars` (copy `.dev.vars.example`); never on a command line, never committed.
- Times are epoch ms UTC, with JST through `src/lib/time.ts`.
- Money is integer JPY.
- D1 statements use `?` or `?NNN` parameters: no named parameters, at most 100 per statement.
- The orchestrator edits package.json.
- Vars and bindings are typed from wrangler.jsonc by `npm run typegen` (commit `worker-configuration.d.ts`); secrets are declared in `src/env.d.ts`.

## Board and branches
- Work starts from a ticket on the GitHub board: `harness-work start <issue#>` makes the branch
  `t/<issue#>-<slug>` and its worktree. Never on main; a hook blocks edits and commits there.
- Tests first: write the tests the ticket names, prove them red with `harness-red check`, then
  change the source. Never loosen a test to make it pass.
- The test-breaker guards against honest mistakes, not sabotage of our own tests (the owner's
  decision, 2026-11-02). A cheat counts only if a well-meaning coder could plausibly write it. One
  that needs deliberate sabotage is recorded as `cheat failed` and noted in the PR for the reviewer.
  This never covers attackers at runtime: forged webhooks, tampered links, bad signatures and
  hostile input stay required test cases.
- Land through a pull request (`harness-pr open`); the user merges.

## Done means
- The ticket's definition of done holds and `scripts/verify.sh` passes. Show the command and its output.
- Say plainly what could not be verified here (production data, credentials, a GUI).

## Compact Instructions
When compacting, keep the ticket number and branch, the list of changed files, and the latest
verify or test result.
