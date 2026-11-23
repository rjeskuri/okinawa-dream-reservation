// Randomized (property) test runs: how many cases a run draws, from which seed, and how a failure names the case that
// replays it alone. A run draws the bounded count unless PROPERTY_RUNS says `full` or a number; PROPERTY_SEED replaces
// the test's own seed. Case i draws from its own generator seeded base + i * 0x9E3779B9 (mod 2^32), so case 0 is the base
// seed and PROPERTY_SEED=<case seed> PROPERTY_RUNS=1 replays exactly that case.

/** The variables a run reads; `process.env` fits. */
export type PropertyEnv = Readonly<Record<string, string | undefined>>;

/** The case counts a test declares: the bounded one CI draws, and the full one PROPERTY_RUNS=full draws. */
export interface PropertyRunCounts {
  bounded: number;
  full: number;
}

/** One case of a run: its position, its seed and a generator seeded with it. */
export interface PropertyCase {
  index: number;
  seed: number;
  random: () => number;
}

export interface PropertyOptions {
  env: PropertyEnv;
  runs: PropertyRunCounts;
  /** The base seed when PROPERTY_SEED is unset. */
  seed: number;
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const UNSIGNED_INTEGER = /^\d+$/;
const UINT32_MAX = 0xffffffff;
const CASE_SEED_STEP = 0x9e3779b9;

/** The number of cases to draw: `bounded` when PROPERTY_RUNS is unset or empty, `full` for `full`, else the number. */
export function propertyRuns(env: PropertyEnv, counts: PropertyRunCounts): number {
  const value = env.PROPERTY_RUNS;
  if (value === undefined || value === "") return counts.bounded;
  if (value === "full") return counts.full;
  if (POSITIVE_INTEGER.test(value)) {
    const runs = Number(value);
    if (Number.isSafeInteger(runs)) return runs;
  }
  throw new RangeError(`PROPERTY_RUNS must be "full" or a positive integer, got "${value}"`);
}

/** The base seed: PROPERTY_SEED when set, an unsigned 32-bit integer, else `fallback`. */
export function propertySeed(env: PropertyEnv, fallback: number): number {
  const value = env.PROPERTY_SEED;
  if (value === undefined || value === "") return fallback;
  if (UNSIGNED_INTEGER.test(value)) {
    const seed = Number(value);
    if (seed <= UINT32_MAX) return seed;
  }
  throw new RangeError(`PROPERTY_SEED must be an integer from 0 to ${UINT32_MAX}, got "${value}"`);
}

/** mulberry32: a small seeded generator of numbers in [0, 1). Each call returns a generator with its own state. */
export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs `check` once per case, in order, awaiting each. The first failure ends the run and is rethrown with the env
 * that replays that case alone, the original error as its cause. Bad PROPERTY_RUNS or PROPERTY_SEED values throw before
 * any case runs.
 */
export async function forAll(options: PropertyOptions, check: (testCase: PropertyCase) => void | Promise<void>): Promise<void> {
  const runs = propertyRuns(options.env, options.runs);
  const base = propertySeed(options.env, options.seed);
  for (let index = 0; index < runs; index++) {
    // Math.imul keeps the low 32 bits of the step; >>> 0 takes the sum modulo 2^32.
    const seed = (base + Math.imul(index, CASE_SEED_STEP)) >>> 0;
    try {
      await check({ index, seed, random: mulberry32(seed) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`property case ${index} failed; replay it with PROPERTY_SEED=${seed} PROPERTY_RUNS=1\n${message}`, {
        cause: error,
      });
    }
  }
}
