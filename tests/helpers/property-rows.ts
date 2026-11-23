// #177: a slow table of cases checked one row at a time, bounded like the randomized tests. Under PROPERTY_RUNS=full every
// row runs, in order, as it always did. Otherwise the run draws `bounded` rows (or PROPERTY_RUNS of them), each picked by
// a forAll case from the seed, so a failure names the PROPERTY_SEED that replays its row alone.
import { forAll } from "../../src/lib/property.ts";

export async function forRows<T>(
  rows: readonly T[],
  options: { bounded: number; seed: number },
  check: (row: T) => void | Promise<void>,
): Promise<void> {
  if (process.env.PROPERTY_RUNS === "full") {
    for (const row of rows) await check(row);
    return;
  }
  await forAll({ env: process.env, runs: { bounded: options.bounded, full: rows.length }, seed: options.seed }, ({ random }) =>
    check(rows[Math.floor(random() * rows.length)]),
  );
}
