/**
 * Hybrid logical clock.
 *
 * A timestamp is the string `wall-counter-node`, with `wall` zero-padded to 15
 * decimal digits and `counter` to 6 hex digits, so ordinary string comparison is a
 * total order: wall time first, then the logical counter, then the node id as a
 * deterministic tie-break. Every stamp a node mints is greater than every stamp it
 * has observed, which is what makes "later wins" agree with causality even when two
 * devices' wall clocks disagree.
 */

const WALL_WIDTH = 15;
const COUNTER_WIDTH = 6;
const COUNTER_MAX = 0xffffff;

export function formatStamp(wall: number, counter: number, node: string): string {
  return `${String(wall).padStart(WALL_WIDTH, '0')}-${counter.toString(16).padStart(COUNTER_WIDTH, '0')}-${node}`;
}

export interface ParsedStamp {
  wall: number;
  counter: number;
  node: string;
}

export function parseStamp(t: string): ParsedStamp {
  const wall = Number(t.slice(0, WALL_WIDTH));
  const counter = parseInt(t.slice(WALL_WIDTH + 1, WALL_WIDTH + 1 + COUNTER_WIDTH), 16);
  const node = t.slice(WALL_WIDTH + 1 + COUNTER_WIDTH + 1);
  return { wall, counter, node };
}

/** The node that minted a stamp, without parsing the rest. */
export function stampNode(t: string): string {
  return t.slice(WALL_WIDTH + 1 + COUNTER_WIDTH + 1);
}

export function stampWall(t: string): number {
  return Number(t.slice(0, WALL_WIDTH));
}

export function compareStamps(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class HybridClock {
  private wall = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    private readonly now: () => number = Date.now,
    initial?: string
  ) {
    if (initial) this.observe(initial);
  }

  /**
   * A new stamp, strictly greater than every stamp this clock has minted or observed.
   * `at` backdates the physical component to when a write really happened; a stamp
   * can never go below what the clock has already seen, so causality still holds.
   */
  tick(at?: number): string {
    const physical = at ?? this.now();
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.counter += 1;
      if (this.counter > COUNTER_MAX) {
        // Only reachable with a clock stuck for 16M events; roll the wall forward.
        this.wall += 1;
        this.counter = 0;
      }
    }
    return formatStamp(this.wall, this.counter, this.node);
  }

  /** Folds a remote stamp in so later local stamps order after it. */
  observe(t: string): void {
    const parsed = parseStamp(t);
    if (parsed.wall > this.wall || (parsed.wall === this.wall && parsed.counter > this.counter)) {
      this.wall = parsed.wall;
      this.counter = parsed.counter;
    }
  }

  /** The latest stamp state, for persisting across restarts. */
  last(): string {
    return formatStamp(this.wall, this.counter, this.node);
  }
}
