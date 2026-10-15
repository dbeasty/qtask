/**
 * Latency recording. A log-linear histogram (HdrHistogram-style: 1/64 relative precision) so a
 * long run at high throughput keeps constant memory, with exact min/max/count/sum on the side.
 */

const SUB_BUCKETS = 64;

export class Histogram {
  private readonly counts = new Map<number, number>();
  count = 0;
  sum = 0;
  min = Infinity;
  max = 0;

  /** Records one latency in milliseconds. */
  record(ms: number): void {
    const us = Math.max(1, Math.round(ms * 1000));
    const key = bucketOf(us);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.count++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }

  /** The latency (ms) at quantile q (0..1); the upper edge of the bucket it falls in. */
  quantile(q: number): number {
    if (this.count === 0) return 0;
    const rank = Math.max(1, Math.ceil(q * this.count));
    const keys = [...this.counts.keys()].sort((a, b) => a - b);
    let seen = 0;
    for (const key of keys) {
      seen += this.counts.get(key)!;
      if (seen >= rank) return Math.min(this.max, upperEdge(key) / 1000);
    }
    return this.max;
  }

  merge(other: Histogram): void {
    for (const [key, n] of other.counts) this.counts.set(key, (this.counts.get(key) ?? 0) + n);
    this.count += other.count;
    this.sum += other.sum;
    this.min = Math.min(this.min, other.min);
    this.max = Math.max(this.max, other.max);
  }

  /** Plain data, so histograms from several client processes can be merged exactly. */
  toJSON(): HistogramData {
    return { counts: [...this.counts.entries()], count: this.count, sum: this.sum, min: this.min, max: this.max };
  }

  static from(data: HistogramData): Histogram {
    const h = new Histogram();
    for (const [k, n] of data.counts) h.counts.set(k, n);
    h.count = data.count;
    h.sum = data.sum;
    h.min = data.min ?? Infinity;
    h.max = data.max;
    return h;
  }

  summary(): LatencySummary {
    return {
      count: this.count,
      meanMs: this.count ? this.sum / this.count : 0,
      minMs: this.count ? this.min : 0,
      p50Ms: this.quantile(0.5),
      p95Ms: this.quantile(0.95),
      p99Ms: this.quantile(0.99),
      maxMs: this.max,
    };
  }
}

export interface HistogramData {
  counts: Array<[number, number]>;
  count: number;
  sum: number;
  min: number | null;
  max: number;
}

export interface LatencySummary {
  count: number;
  meanMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Bucket index: exponent * 64 + mantissa slot, exact below 64 µs. */
function bucketOf(us: number): number {
  if (us < SUB_BUCKETS) return us;
  const exponent = Math.floor(Math.log2(us / SUB_BUCKETS)) + 1;
  const slot = Math.floor(us / 2 ** exponent);
  return exponent * SUB_BUCKETS + slot;
}

function upperEdge(key: number): number {
  if (key < SUB_BUCKETS) return key;
  const exponent = Math.floor(key / SUB_BUCKETS);
  const slot = key % SUB_BUCKETS;
  return (slot + 1) * 2 ** exponent;
}

/** Deterministic PRNG (mulberry32), so a dataset and an operation sequence are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

export function intBetween(random: () => number, lo: number, hi: number): number {
  return lo + Math.floor(random() * (hi - lo + 1));
}

/** Picks a key of `weights` with probability proportional to its weight. */
export function weighted<K extends string>(random: () => number, weights: Record<K, number>): K {
  const entries = Object.entries(weights) as Array<[K, number]>;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = random() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1]![0];
}
