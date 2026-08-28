import mongoose from 'mongoose';

export type LoggedQuery = { collection: string; method: string };

/**
 * Count every Mongo operation issued while `fn` runs.
 *
 * Query counts are the load-bearing assertion in the performance suite:
 * unlike wall-clock timings they are deterministic, so they can be asserted
 * exactly without making CI flaky. An endpoint whose query count is flat as
 * the dataset grows is not doing per-row work (the N+1 shape); one whose
 * count tracks the row count is.
 */
export async function withQueryLog<T>(
  fn: () => Promise<T>
): Promise<{ result: T; queries: LoggedQuery[] }> {
  const queries: LoggedQuery[] = [];
  mongoose.set('debug', (collection: string, method: string) => {
    queries.push({ collection, method });
  });
  try {
    const result = await fn();
    return { result, queries };
  } finally {
    mongoose.set('debug', false);
  }
}

export async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  const { queries } = await withQueryLog(fn);
  return queries.length;
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, ms };
}

/** Run `fn` `runs` times (after `warmup` untimed runs) and return the durations. */
export async function samples(
  runs: number,
  fn: () => Promise<unknown>,
  warmup = 2
): Promise<number[]> {
  for (let i = 0; i < warmup; i += 1) await fn();
  const out: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const { ms } = await timed(fn);
    out.push(ms);
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

/**
 * Absolute latency ceilings are a blunt instrument on shared CI runners, so
 * they are deliberately generous: they exist to catch a catastrophic
 * regression (an endpoint going from milliseconds to seconds), not to police
 * small changes. Raise the whole budget on a slow machine with
 * QTASK_PERF_BUDGET_SCALE=2.
 */
export const BUDGET_SCALE = Number(process.env.QTASK_PERF_BUDGET_SCALE ?? '1') || 1;

export function budget(ms: number): number {
  return ms * BUDGET_SCALE;
}
