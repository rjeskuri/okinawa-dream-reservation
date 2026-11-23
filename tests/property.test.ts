// #177: the randomized tests draw a bounded number of cases by default and the full number with PROPERTY_RUNS=full, and a
// failing case names the seed that replays it alone. Expected values come from a reference mulberry32 written out here
// (the copy holds.test.ts and overrides.test.ts carried), from BigInt arithmetic for the case seeds, and from literals,
// never from src/lib/property.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { forAll, mulberry32, propertyRuns, propertySeed } from "../src/lib/property.ts";
import type { PropertyCase } from "../src/lib/property.ts";

/** The reference generator: mulberry32 as the tests had it before this module. */
function referenceMulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function draws(random: () => number, n: number): number[] {
  return Array.from({ length: n }, () => random());
}

/** Case `index` of a run from `base`: base + index * 0x9E3779B9, modulo 2^32, so case 0 is the base seed itself. */
function caseSeed(base: number, index: number): number {
  return Number((BigInt(base) + BigInt(index) * 0x9e3779b9n) % 4294967296n);
}

const UINT32_MAX = 4294967295;

test("PROPERTY_RUNS picks the bounded count, the full count, or the count it names", () => {
  const COUNTS = [
    { bounded: 1, full: 3 },
    { bounded: 2, full: 40 },
    { bounded: 5, full: 27 },
    { bounded: 12, full: 300 },
  ];
  for (const counts of COUNTS) {
    const label = JSON.stringify(counts);
    assert.equal(propertyRuns({}, counts), counts.bounded, `${label}: unset`);
    assert.equal(propertyRuns({ PROPERTY_RUNS: undefined }, counts), counts.bounded, `${label}: undefined`);
    assert.equal(propertyRuns({ PROPERTY_RUNS: "" }, counts), counts.bounded, `${label}: empty`);
    assert.equal(propertyRuns({ PROPERTY_RUNS: "full" }, counts), counts.full, `${label}: full`);
    for (const named of [1, 2, 7, 13, 250, 1000]) {
      assert.equal(propertyRuns({ PROPERTY_RUNS: String(named) }, counts), named, `${label}: ${named}`);
    }
  }
  // Other variables in the environment change nothing.
  assert.equal(propertyRuns({ PROPERTY_SEED: "9", RUNS: "full", PATH: "/bin" }, { bounded: 4, full: 9 }), 4);
});

test("a PROPERTY_RUNS that is not full or a positive integer is a clear error", () => {
  for (const bad of ["0", "-3", "2.5", "1e3", "ten", "0x10", "12abc", "fulll", "all"]) {
    assert.throws(
      () => propertyRuns({ PROPERTY_RUNS: bad }, { bounded: 2, full: 10 }),
      (error: unknown) => error instanceof Error && error.message.includes("PROPERTY_RUNS") && error.message.includes(bad),
      bad,
    );
  }
});

test("PROPERTY_SEED overrides the default seed with any unsigned 32-bit integer", () => {
  for (const fallback of [0, 20, 2026, 777, UINT32_MAX]) {
    assert.equal(propertySeed({}, fallback), fallback, `unset, default ${fallback}`);
    assert.equal(propertySeed({ PROPERTY_SEED: "" }, fallback), fallback, `empty, default ${fallback}`);
    for (const seed of [0, 1, 42, 2147483648, 3000000000, UINT32_MAX]) {
      assert.equal(propertySeed({ PROPERTY_SEED: String(seed) }, fallback), seed, `${seed} over default ${fallback}`);
    }
  }
});

test("a PROPERTY_SEED that is not an unsigned 32-bit integer is a clear error", () => {
  for (const bad of ["-1", "4294967296", "99999999999", "1.5", "abc", "0x10", "7seven"]) {
    assert.throws(
      () => propertySeed({ PROPERTY_SEED: bad }, 20),
      (error: unknown) => error instanceof Error && error.message.includes("PROPERTY_SEED") && error.message.includes(bad),
      bad,
    );
  }
});

test("mulberry32 draws the reference sequence, and the same seed replays it", () => {
  for (const seed of [0, 1, 20, 22, 555, 777, 2026, 2030, 2147483648, UINT32_MAX]) {
    const expected = draws(referenceMulberry32(seed), 500);
    const random = mulberry32(seed);
    const got = draws(random, 500);
    assert.deepEqual(got, expected, `seed ${seed}`);
    for (const value of got) assert.ok(value >= 0 && value < 1, `seed ${seed}: ${value}`);
    assert.deepEqual(draws(mulberry32(seed), 500), expected, `seed ${seed}, again`);
  }
  // Two generators keep their own state, drawn in turn.
  const [a, b] = [mulberry32(20), mulberry32(20)];
  const interleaved = Array.from({ length: 50 }, () => [a(), b()]);
  const reference = draws(referenceMulberry32(20), 50);
  assert.deepEqual(
    interleaved,
    reference.map((value) => [value, value]),
  );
});

test("forAll runs one case per count, in order, each with its own seed and generator", async () => {
  const RUNS = [
    { env: {}, fallback: 20, base: 20, expected: 2 },
    { env: { PROPERTY_RUNS: "full" }, fallback: 20, base: 20, expected: 7 },
    { env: { PROPERTY_RUNS: "5" }, fallback: 2026, base: 2026, expected: 5 },
    { env: { PROPERTY_SEED: "777" }, fallback: 20, base: 777, expected: 2 },
    { env: { PROPERTY_SEED: String(UINT32_MAX), PROPERTY_RUNS: "full" }, fallback: 20, base: UINT32_MAX, expected: 7 },
    { env: { PROPERTY_SEED: "0", PROPERTY_RUNS: "3" }, fallback: 9, base: 0, expected: 3 },
  ];
  for (const { env, fallback, base, expected } of RUNS) {
    const label = JSON.stringify(env);
    const seen: { index: number; seed: number; first: number[] }[] = [];
    await forAll({ env, runs: { bounded: 2, full: 7 }, seed: fallback }, ({ index, seed, random }: PropertyCase) => {
      // Draw a different number each time, so a generator shared between cases shows in the next one.
      seen.push({ index, seed, first: draws(random, 5 + index) });
    });

    assert.equal(seen.length, expected, `${label}: cases`);
    seen.forEach(({ index, seed, first }, i) => {
      assert.equal(index, i, `${label}: index`);
      assert.equal(seed, caseSeed(base, i), `${label}: case ${i}'s seed`);
      assert.deepEqual(first, draws(referenceMulberry32(caseSeed(base, i)), 5 + i), `${label}: case ${i}'s draws`);
    });
    assert.equal(new Set(seen.map(({ seed }) => seed)).size, seen.length, `${label}: every case has a seed of its own`);
  }
});

test("forAll waits for each async case before the next", async () => {
  let active = 0;
  const order: string[] = [];
  await forAll({ env: { PROPERTY_RUNS: "4" }, runs: { bounded: 1, full: 1 }, seed: 5 }, async ({ index }) => {
    active += 1;
    assert.equal(active, 1, `case ${index} overlaps another`);
    order.push(`start ${index}`);
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
    order.push(`end ${index}`);
    active -= 1;
  });
  assert.deepEqual(order, ["start 0", "end 0", "start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
});

test("a failing case names the seed and the env that replay it alone, and keeps the error", async () => {
  // Sync throws, async rejections and assertion failures, at the first case and later ones.
  const FAILURES: { label: string; base: number; failAt: number; fail: (index: number) => void | Promise<void> }[] = [
    { label: "sync throw at case 0", base: 20, failAt: 0, fail: (i) => { throw new Error(`boom ${i}`); } },
    { label: "sync throw at case 3", base: 2026, failAt: 3, fail: (i) => { throw new Error(`boom ${i}`); } },
    {
      label: "async rejection at case 2",
      base: 777,
      failAt: 2,
      fail: async (i) => {
        await Promise.resolve();
        throw new Error(`boom ${i}`);
      },
    },
    { label: "assertion at case 5", base: UINT32_MAX - 3, failAt: 5, fail: (i) => assert.equal(i, -1, `boom ${i}`) },
  ];
  for (const { label, base, failAt, fail } of FAILURES) {
    const ran: number[] = [];
    let original: unknown;
    const run = forAll({ env: { PROPERTY_SEED: String(base) }, runs: { bounded: 8, full: 8 }, seed: 1 }, async ({ index }) => {
      ran.push(index);
      if (index !== failAt) return;
      try {
        await fail(index);
      } catch (error) {
        original = error;
        throw error;
      }
    });

    const seed = caseSeed(base, failAt);
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof Error, `${label}: an Error`);
      assert.ok(error.message.includes(`PROPERTY_SEED=${seed} PROPERTY_RUNS=1`), `${label}: ${error.message}`);
      assert.ok(error.message.includes(`boom ${failAt}`), `${label}: the original message: ${error.message}`);
      assert.equal(error.cause, original, `${label}: the cause`);
      return true;
    });
    assert.ok(original instanceof Error, `${label}: the case ran and failed`);
    if (label.startsWith("assertion")) assert.ok(original instanceof assert.AssertionError, label);
    // The first failure ends the run.
    assert.deepEqual(ran, Array.from({ length: failAt + 1 }, (_, i) => i), `${label}: cases run`);
  }
});

test("the env a failure names replays exactly the failing case", async () => {
  for (const [base, failAt] of [
    [20, 1],
    [2026, 4],
    [555, 0],
    [UINT32_MAX, 6],
  ]) {
    // A case fails when its third draw is the one it saw in the failing run.
    const firstRun: { seed: number; draws: number[] }[] = [];
    let message = "";
    try {
      await forAll({ env: { PROPERTY_RUNS: "full" }, runs: { bounded: 1, full: 10 }, seed: base }, ({ index, seed, random }) => {
        firstRun.push({ seed, draws: draws(random, 3) });
        if (index === failAt) throw new Error("the property broke");
      });
      assert.fail(`base ${base}: the run passed`);
    } catch (error) {
      message = (error as Error).message;
    }
    const replayEnv = message.match(/PROPERTY_SEED=(\d+) PROPERTY_RUNS=1/);
    assert.ok(replayEnv, `base ${base}: no replay env in ${message}`);

    const replayed: { seed: number; draws: number[] }[] = [];
    await assert.rejects(
      forAll(
        { env: { PROPERTY_SEED: replayEnv[1], PROPERTY_RUNS: "1" }, runs: { bounded: 1, full: 10 }, seed: base },
        ({ seed, random }) => {
          const got = draws(random, 3);
          replayed.push({ seed, draws: got });
          if (got[2] === firstRun[failAt].draws[2]) throw new Error("the property broke");
        },
      ),
      /the property broke/,
    );
    assert.deepEqual(replayed, [firstRun[failAt]], `base ${base}`);
  }
});

test("a bad PROPERTY_RUNS or PROPERTY_SEED fails forAll before any case runs", async () => {
  for (const env of [{ PROPERTY_RUNS: "0" }, { PROPERTY_RUNS: "many" }, { PROPERTY_SEED: "-5" }, { PROPERTY_SEED: "seed" }]) {
    let ran = 0;
    await assert.rejects(
      async () =>
        forAll({ env, runs: { bounded: 2, full: 4 }, seed: 3 }, () => {
          ran += 1;
        }),
      /PROPERTY_(RUNS|SEED)/,
      JSON.stringify(env),
    );
    assert.equal(ran, 0, JSON.stringify(env));
  }
});
