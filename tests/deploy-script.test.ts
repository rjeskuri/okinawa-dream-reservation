// scripts/deploy.sh against fake npm, npx and git, and .github/workflows/{deploy,ci}.yml through a small YAML reader:
// nothing deploys without credentials, and only a push to main or a manual run on main reaches the script.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const script = join(repoRoot, "scripts", "deploy.sh");

const SKIP_MESSAGE = "deploy skipped: Cloudflare credentials not set";
const STEPS = [
  ["npm", "ci"],
  ["npm", "run", "build"],
  ["npx", "wrangler", "d1", "migrations", "apply", "DB", "--remote"],
  ["npx", "wrangler", "deploy"],
];

// Fresh on every run: distinctive enough to find in the output, and impossible to hard-code around.
const TOKEN = randomUUID();
const ACCOUNT = randomUUID();
const CREDENTIALS = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
// 1 is what a failing tool usually exits with; the random code cannot be special-cased.
const FAILURE_CODES = [1, 37, 113, randomInt(2, 256)];
// The files a GitHub runner hands a step, each of which reaches the job page or a later step.
const RUNNER_FILES = ["GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT", "GITHUB_ENV"];
// The script must behave the same on a runner: these cannot turn off the stop at a failure, turn on a trace or pick a commit.
const RUNNER_ENV = { CI: "true", GITHUB_ACTIONS: "true", RUNNER_DEBUG: "1", GITHUB_SHA: randomUUID() };
const ENVIRONMENTS: [string, Record<string, string>][] = [
  ["off a runner", {}],
  ["on a runner", RUNNER_ENV],
];

interface Failure {
  step: string[];
  code: number;
}

interface Run {
  status: number | null;
  /** stdout and stderr together. */
  output: string;
  /** The output plus what the script left in the runner's files. */
  exposed: string;
  /** One entry per fake call: the tool, then each argument as the fake received it. */
  calls: string[][];
  /** The working directory of each fake call. */
  dirs: string[];
  /** For each fake call, whether its environment held exactly the credentials the run started with. */
  sawCredentials: boolean[];
}

/**
 * A fake npm or npx: appends one tab-separated line to the log, prints nothing, and exits with `fail`'s code on its step.
 * It compares the credentials itself and logs only yes or no, so the log never holds a value.
 */
function fakeTool(tool: string, log: string, credentials: Record<string, string>, fail?: Failure): string {
  const matches = Object.keys(CREDENTIALS).map((name) => `[ "\${${name}-}" = '${credentials[name] ?? ""}' ]`);
  const lines = [
    "#!/bin/sh",
    `if ${matches.join(" && ")}; then saw=yes; else saw=no; fi`,
    `{ printf '%s' "$(pwd -P)"; printf '\\t%s' "$saw" ${tool} "$@"; printf '\\n'; } >> '${log}'`,
  ];
  if (fail?.step[0] === tool) lines.push(`[ "$*" != '${fail.step.slice(1).join(" ")}' ] || exit ${fail.code}`);
  return `${lines.join("\n")}\n`;
}

/** A fake git: records only that it ran and succeeds, so no argument, and no secret in one, reaches the log. */
function fakeGit(log: string): string {
  return `#!/bin/sh\necho called >> '${log}'\n`;
}

/** Runs the script with a clean environment, so a developer's real credentials can never reach it. */
function runDeploy(
  credentials: Record<string, string>,
  options: { fail?: Failure; outsideRepo?: boolean; runner?: Record<string, string> } = {},
): Run {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "deploy-script-")));
  try {
    const log = join(sandbox, "calls.log");
    for (const tool of ["npm", "npx"]) {
      writeFileSync(join(sandbox, tool), fakeTool(tool, log, credentials, options.fail), { mode: 0o755 });
    }
    const gitLog = join(sandbox, "git.log");
    writeFileSync(join(sandbox, "git"), fakeGit(gitLog), { mode: 0o755 });
    const runnerFiles = Object.fromEntries(RUNNER_FILES.map((name) => [name, join(sandbox, name)]));
    for (const file of Object.values(runnerFiles)) writeFileSync(file, "");
    const result = spawnSync(script, [], {
      cwd: options.outsideRepo ? sandbox : repoRoot,
      env: { PATH: `${sandbox}:/usr/bin:/bin`, HOME: sandbox, ...runnerFiles, ...options.runner, ...credentials } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.ifError(result.error);
    // The commit is the workflow's checkout, in every run: the script never picks one.
    assert.equal(existsSync(gitLog), false, "the script called git");
    const records = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").map((line) => line.split("\t")) : [];
    const output = result.stdout + result.stderr;
    return {
      status: result.status,
      output,
      exposed: [output, ...Object.values(runnerFiles).map((file) => readFileSync(file, "utf8"))].join("\n"),
      calls: records.map((record) => record.slice(2)),
      dirs: records.map((record) => record[0]),
      sawCredentials: records.map((record) => record[1] === "yes"),
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** A secret and the encodings a log line could carry it in. Base64 shifts with the start, so it is taken at all three alignments. */
function secretForms(secret: string): string[] {
  const base64 = [0, 1, 2].map((start) => Buffer.from(secret.slice(start)).toString("base64"));
  return [secret, ...base64, Buffer.from(secret).toString("hex"), [...secret].reverse().join("")];
}

/** Letters and digits only, in one case, so no separator or casing can break a secret up. */
function alphanumeric(text: string): string {
  return text.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** No run may expose eight characters in a row of a secret or its encodings, in either case or broken up by any separator. */
function assertNoSecret(run: Run): void {
  const exposed = alphanumeric(run.exposed);
  for (const form of [TOKEN, ACCOUNT].flatMap(secretForms).map(alphanumeric)) {
    for (let start = 0; start + 8 <= form.length; start += 1) {
      const slice = form.slice(start, start + 8);
      assert.ok(!exposed.includes(slice), `the script exposed ${slice}, a slice of ${form}`);
    }
  }
}

test("skips cleanly without credentials", async (t) => {
  // An unconfigured GitHub secret arrives as an empty string, so empty must behave exactly like unset.
  const tokens = { unset: {}, empty: { CLOUDFLARE_API_TOKEN: "" }, set: { CLOUDFLARE_API_TOKEN: TOKEN } };
  const accounts = { unset: {}, empty: { CLOUDFLARE_ACCOUNT_ID: "" }, set: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT } };
  for (const [where, runner] of ENVIRONMENTS) {
    for (const [tokenState, token] of Object.entries(tokens)) {
      for (const [accountState, account] of Object.entries(accounts)) {
        if (tokenState === "set" && accountState === "set") continue;
        await t.test(`${where}, token ${tokenState}, account ${accountState}`, () => {
          const run = runDeploy({ ...token, ...account }, { runner });
          assert.equal(run.status, 0, run.output);
          assert.ok(run.output.includes(SKIP_MESSAGE), `no skip message in: ${run.output}`);
          assert.deepEqual(run.calls, []);
          // With one credential set, a trace of the check under RUNNER_DEBUG shows up here.
          assertNoSecret(run);
        });
      }
    }
  }
});

test("runs the steps in order with credentials", async (t) => {
  for (const [where, runner] of ENVIRONMENTS) {
    await t.test(where, () => {
      for (const credentials of [CREDENTIALS, { CLOUDFLARE_API_TOKEN: "a token with spaces", CLOUDFLARE_ACCOUNT_ID: "0f9e" }]) {
        const run = runDeploy(credentials, { runner });
        assert.equal(run.status, 0, run.output);
        assert.deepEqual(run.calls, STEPS);
        assert.ok(!run.output.includes(SKIP_MESSAGE), `skip message on a real deploy: ${run.output}`);
        // Wrangler authenticates from these two variables alone. npm ci and the build do not need them.
        assert.deepEqual(run.sawCredentials.slice(2), [true, true], "a wrangler step did not get the exact credentials");
      }
    });
  }
});

test("runs the steps in the repository when started from another directory", () => {
  const run = runDeploy(CREDENTIALS, { outsideRepo: true });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.calls, STEPS);
  assert.deepEqual(run.dirs, STEPS.map(() => repoRoot));
});

test("stops at the first failing step", async (t) => {
  for (const [where, runner] of ENVIRONMENTS) {
    for (const [index, step] of STEPS.entries()) {
      for (const code of FAILURE_CODES) {
        await t.test(`${where}, ${step.join(" ")} exits ${code}`, () => {
          const run = runDeploy(CREDENTIALS, { fail: { step, code }, runner });
          assert.equal(run.status, code, run.output);
          assert.deepEqual(run.calls, STEPS.slice(0, index + 1));
        });
      }
    }
  }
});

test("prints no credential on success or at any failing step", async (t) => {
  // Every step fails once and every code is used once: the full matrix above costs a fresh set of fakes per row.
  const failures = STEPS.map((step, index) => ({ step, code: FAILURE_CODES[index] }));
  for (const [where, runner] of ENVIRONMENTS) {
    for (const fail of [undefined, ...failures]) {
      await t.test(`${where}, ${fail ? `${fail.step.join(" ")} exits ${fail.code}` : "every step passes"}`, () => {
        const run = runDeploy(CREDENTIALS, { fail, runner });
        assert.notDeepEqual(run.calls, [], "the deploy path did not run, so this proves nothing");
        assertNoSecret(run);
      });
    }
  }
});

// ---------------------------------------------------------------- the workflow

/** Drops comments, so a commented-out line cannot satisfy an assertion. */
function withoutComments(text: string): string {
  return text.replace(/(^|\s)#.*$/gm, "$1");
}

function shallowestIndent(lines: string[]): number {
  return Math.min(...lines.map((line) => line.search(/\S/)));
}

function contentLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/**
 * The keys at a YAML block's shallowest indent, each with the raw text under it: the rest of its line and what nests.
 * Throws on any other line, so what the reader cannot parse cannot hide a job from the assertions.
 */
function yamlMap(text = ""): Record<string, string> {
  const lines = contentLines(text);
  const indent = shallowestIndent(lines);
  const map: Record<string, string> = {};
  let key = "";
  for (const line of lines) {
    const entry = line.search(/\S/) === indent ? /^\s*["']?([\w-]+)["']?:(?:\s+(.*))?$/.exec(line) : null;
    if (entry) {
      key = entry[1];
      map[key] = entry[2] ?? "";
    } else {
      // A block sequence may sit at its own key's indent, as that key's whole value.
      const item = line.trimStart().startsWith("- ") && /^\s*(- |$)/.test(map[key]);
      assert.ok(key && (line.search(/\S/) > indent || item), `not a key of this YAML map, or nested under one: ${line}`);
      map[key] += `\n${line}`;
    }
  }
  return map;
}

/** The items of a YAML sequence in flow or block style, or a lone scalar. Block items stay aligned for yamlMap. */
function yamlList(text = ""): string[] {
  const flow = /^\s*\[(.*)\]\s*$/s.exec(text);
  if (flow) return flow[1].split(",").filter((item) => item.trim() !== "");
  const lines = contentLines(text);
  const indent = shallowestIndent(lines);
  const items: string[] = [];
  for (const line of lines) {
    if (line.search(/\S/) === indent && line.trimStart().startsWith("- ")) items.push(line.replace("-", " "));
    else if (items.length > 0) items[items.length - 1] += `\n${line}`;
  }
  return items.length > 0 ? items : lines;
}

/** A scalar's value: plain, quoted or under a `|` or `>` block header. */
function scalar(text = ""): string {
  return text.trim().replace(/^[>|][-+]?\s*/, "").replace(/^(["'])(.*)\1$/s, "$2");
}

function scalars(text?: string): string[] {
  return yamlList(text).map(scalar);
}

const REPOSITORY = "rjeskuri/okinawa-dream-reservation";
// Fresh on every run, so a constant ref cannot name them.
const PUSHED_COMMIT = randomUUID();
const MANUAL_COMMIT = randomUUID();
const HOSTILE_REF = randomUUID();

/** The `github` context of a push to `ref`: the pushed commit is github.sha, and the payload's after and head_commit. */
function pushTo(ref: string): object {
  const [, kind, name] = /^refs\/(heads|tags)\/(.+)$/.exec(ref) ?? [];
  assert.ok(name, `not a branch or tag ref: ${ref}`);
  return {
    event_name: "push",
    ref,
    ref_name: name,
    ref_type: kind === "tags" ? "tag" : "branch",
    sha: PUSHED_COMMIT,
    repository: REPOSITORY,
    event: { ref, after: PUSHED_COMMIT, head_commit: { id: PUSHED_COMMIT }, repository: { full_name: REPOSITORY } },
  };
}

/** The `github` context of the trigger this workflow replaced: CI passing on a push to main, delivered as workflow_run. */
function afterCi(): object {
  return {
    event_name: "workflow_run",
    ref: "refs/heads/main",
    ref_name: "main",
    sha: randomUUID(),
    repository: REPOSITORY,
    event: {
      workflow_run: {
        conclusion: "success",
        event: "push",
        head_branch: "main",
        head_sha: randomUUID(),
        head_repository: { full_name: REPOSITORY },
        repository: { full_name: REPOSITORY },
      },
    },
  };
}

/** The `github` context of a manual run: an input under any name is hostile. */
function manualRun(name: string, refType: "branch" | "tag" = "branch"): object {
  return {
    event_name: "workflow_dispatch",
    ref: `refs/${refType === "tag" ? "tags" : "heads"}/${name}`,
    ref_name: name,
    ref_type: refType,
    sha: MANUAL_COMMIT,
    repository: REPOSITORY,
    event: { inputs: new Proxy({}, { get: () => HOSTILE_REF }) },
  };
}

/** GitHub expressions share JavaScript's operators and precedence, so a guard is evaluated rather than pattern-matched. */
function evaluate(expression: string, github: object): unknown {
  const source = scalar(expression).replace(/^\$\{\{(.*)\}\}$/s, "$1");
  return new Function("github", `return (${source});`)(github);
}

/**
 * GitHub reads text outside `${{ }}` as a non-empty string, so the guard would always be true. A block scalar has that
 * text in its trailing newline. This takes the raw value of `if:`, because scalar() and evaluate() strip what it looks for.
 */
function assertOneExpression(raw: string): void {
  const value = raw.trim();
  assert.doesNotMatch(value, /^[|>]/, "the guard is a block scalar");
  assert.ok(!value.includes("\n"), `the guard spans lines: ${raw}`);
  const unquoted = /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
  if (unquoted.includes("${{")) {
    assert.match(unquoted, /^\$\{\{(?:(?!\$\{\{|\}\}).)*\}\}$/, "the guard has text outside one ${{ }} expression");
  }
}

function readWorkflow(name: string): string {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
}

/** A workflow's `on:` as each event with the raw text of its filters. A list or a lone event has no filters. */
function triggers(on = ""): Record<string, string> {
  if (!/:(\s|$)/.test(on)) return Object.fromEntries(scalars(on).map((event) => [event, ""]));
  return yamlMap(on);
}

/** An event with no filters or inputs: an empty value, `{}`, `~` or null. */
const UNFILTERED = /^(\{\s*\}|~|null)?$/;

function readDeployWorkflow() {
  const workflow = yamlMap(withoutComments(readWorkflow("deploy.yml")));
  const runsScript = (text = "") => /\bscripts\/deploy\.sh\b/.test(text);
  const job = Object.values(yamlMap(workflow.jobs)).map(yamlMap).find((candidate) => runsScript(candidate.steps));
  assert.ok(job, "no job in deploy.yml runs scripts/deploy.sh");
  const steps = yamlList(job.steps).map(yamlMap);
  const scriptIndex = steps.findIndex((step) => runsScript(step.run));
  assert.notEqual(scriptIndex, -1, "no step runs scripts/deploy.sh");
  return { workflow, job, steps, scriptIndex };
}

/** The action a step uses, without its version, or "run". */
function stepKind(step: Record<string, string>): string {
  return step.run === undefined ? scalar(step.uses).split("@")[0] : "run";
}

test("deploy.yml runs on a push to main or a manual dispatch, and nothing else", () => {
  // Comments may tell the history; no trigger, guard or checkout ref may wait on another workflow's run.
  assert.doesNotMatch(withoutComments(readWorkflow("deploy.yml")), /workflow_run/, "deploy.yml still references workflow_run");
  const on = triggers(readDeployWorkflow().workflow.on);
  assert.deepEqual(Object.keys(on).sort(), ["push", "workflow_dispatch"]);
  assert.match(on.workflow_dispatch.trim(), UNFILTERED, "a manual run takes no inputs");
  // A tags or paths filter beside branches would change which pushes deploy.
  const push = yamlMap(on.push);
  assert.deepEqual(Object.keys(push), ["branches"], "push has filters other than branches");
  assert.deepEqual(scalars(push.branches), ["main"]);
});

test("CI runs on every pull request and by hand, not on the push to main", () => {
  const on = triggers(yamlMap(withoutComments(readWorkflow("ci.yml"))).on);
  assert.deepEqual(Object.keys(on).sort(), ["pull_request", "workflow_dispatch"]);
  // The pull request run is the only verify before a deploy, so no filter may let a pull request skip it.
  for (const [event, filters] of Object.entries(on)) {
    assert.match(filters.trim(), UNFILTERED, `${event} has filters or inputs`);
  }
});

test("the deploy job runs only on a push to main, or by hand on main", async (t) => {
  const { workflow, job } = readDeployWorkflow();
  const guard = job.if;
  assert.ok(guard, "the deploy job has no if: guard");
  assertOneExpression(guard);
  // The guard proves nothing if the deploy can start from anywhere else.
  assert.equal(Object.keys(yamlMap(workflow.jobs)).length, 1, "a second job could deploy without the guard");
  for (const name of readdirSync(new URL("../.github/workflows/", import.meta.url))) {
    if (name !== "deploy.yml") assert.doesNotMatch(readWorkflow(name), /scripts\/deploy\.sh|wrangler/, `${name} can deploy`);
  }
  // One row per event shape. ref_name is "main" for the tag too, so only github.ref tells it from the branch.
  const cases: [string, object, boolean][] = [
    ["a push to main", pushTo("refs/heads/main"), true],
    ["a manual run on main", manualRun("main"), true],
    ["a push of a tag named main", pushTo("refs/tags/main"), false],
    ["a push to another branch", pushTo("refs/heads/t/164-run-ci-on-pull-requests-only"), false],
    ["a manual run on another branch", manualRun("t/46-add-a-deploy-script"), false],
    ["another event on main: CI's completion, the trigger this replaced", afterCi(), false],
  ];
  for (const [name, github, admitted] of cases) {
    await t.test(name, () => {
      assert.equal(Boolean(evaluate(guard, github)), admitted, `guard: ${guard}`);
    });
  }
});

test("a manual run on a tag named main is refused", () => {
  const onBranch = manualRun("main");
  const onTag = manualRun("main", "tag");
  // Samples first, so the red run shows both hold. ref_name is "main" for a tag too, and that tag's commit has no CI.
  const byRef = "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' }}";
  const byName = "${{ github.event_name == 'workflow_dispatch' && github.ref_name == 'main' }}";
  assert.ok(evaluate(byRef, onBranch), "a guard on github.ref must admit refs/heads/main");
  assert.ok(!evaluate(byRef, onTag), "a guard on github.ref must refuse refs/tags/main");
  assert.ok(evaluate(byName, onTag), "the tag context does not expose a guard on github.ref_name");

  const guard = readDeployWorkflow().job.if;
  assert.ok(guard, "the deploy job has no if: guard");
  assert.ok(!evaluate(guard, onTag), `a tag named main would deploy without CI, guard: ${guard}`);
});

test("the job checks out the pushed commit and sets up Node 24 before the script", () => {
  const { steps } = readDeployWorkflow();
  // Exactly these three, in this order: any further step could swap the commit or the Node version before the script.
  // The npm cache needs the lockfile on disk, so setup-node comes after checkout as well as before the script.
  assert.deepEqual(steps.map(stepKind), ["actions/checkout", "actions/setup-node", "run"]);
  const [checkout, node] = steps.map((step) => yamlMap(step.with));
  assert.match(scalar(checkout.ref), /^\$\{\{.*\}\}$/, "checkout has no ref expression");
  assert.doesNotMatch(checkout.ref, /workflow_run/, "the checkout ref reads a workflow_run, which a push does not carry");
  assert.equal(evaluate(checkout.ref, pushTo("refs/heads/main")), PUSHED_COMMIT);
  // An empty ref makes actions/checkout use the dispatched commit, so on a manual run empty is as good as github.sha.
  const dispatched: unknown[] = [MANUAL_COMMIT, "", null, undefined];
  const manualRef = evaluate(checkout.ref, manualRun("main"));
  assert.ok(dispatched.includes(manualRef), `a manual run checks out ${manualRef}`);
  assert.equal(checkout.repository, undefined, "checkout reads another repository");
  assert.match(scalar(node["node-version"]), /^24(\.x)?$/);
  assert.equal(scalar(node.cache), "npm");
});

test("a failed deploy fails the job, and the job always reaches the script", () => {
  const { workflow, job, steps, scriptIndex } = readDeployWorkflow();
  assert.equal(scalar(steps[scriptIndex].run), "scripts/deploy.sh", "the script step does more than run the script");
  for (const [index, step] of steps.entries()) {
    for (const key of ["if", "continue-on-error", "shell", "working-directory"]) {
      assert.equal(step[key], undefined, `step ${index} sets ${key}`);
    }
  }
  assert.equal(job["continue-on-error"], undefined, "the job tolerates a failed deploy");
  // A default shell wraps the script the way a step's own shell would.
  assert.equal(job.defaults, undefined, "the job sets run defaults");
  assert.equal(workflow.defaults, undefined, "the workflow sets run defaults");
});

test("the script gets both credentials from repository secrets, never on a command line", () => {
  const { workflow, job, steps, scriptIndex } = readDeployWorkflow();
  const env = yamlMap(steps[scriptIndex].env);
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    assert.match(scalar(env[name]), new RegExp(`^\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}$`), `${name} is not passed from secrets`);
  }
  // Workflow and job env reach every step, third-party actions included, so the secrets stay on the script's step.
  const otherSteps = steps.filter((_, index) => index !== scriptIndex);
  for (const text of [workflow.env, job.env, ...otherSteps.flatMap((step) => [step.env, step.with])]) {
    assert.doesNotMatch(text ?? "", /\bsecrets\b/, "a secret reaches more than the script");
  }
});
