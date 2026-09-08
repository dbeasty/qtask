/**
 * A bounded, strictly serial queue for mirrored writes.
 *
 * Two properties matter more than throughput here.
 *
 * **Order is preserved.** Writes are applied one at a time, in the order they were
 * enqueued. A mirror that reorders a create and the update that follows it produces
 * a shadow that disagrees with the primary for reasons that have nothing to do with
 * the backend being evaluated — and stage 3's comparison would then report those as
 * divergences. Concurrency here would buy latency the caller never waits on anyway.
 *
 * **A full queue drops, and says so.** The alternative is unbounded memory growth
 * when the shadow is slower than the primary, which turns an evaluation exercise
 * into an outage. A drop means the shadow is knowingly stale, which is a different
 * thing from a divergence, and the counters keep them separate.
 */

import { createLogger } from '../../utils/logger.js';

const log = createLogger('data:shadow');

export interface ShadowStats {
  /** Operations accepted onto the queue. */
  enqueued: number;
  /** Operations applied to the shadow without error. */
  applied: number;
  /** Operations that reached the shadow and failed. */
  failed: number;
  /** Operations refused because the queue was full — the shadow is stale by this many. */
  dropped: number;
  /** Operations waiting to be applied. */
  pending: number;
  lastError?: string;
}

export class ShadowQueue {
  private readonly tasks: Array<() => Promise<void>> = [];
  private running = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;

  private enqueued = 0;
  private applied = 0;
  private failed = 0;
  private dropped = 0;
  private lastError: string | undefined;

  constructor(private readonly maxPending = 1000) {}

  /**
   * Schedules one mirrored write. Returns immediately: the caller's request never
   * waits on the shadow, and never fails because of it.
   */
  push(label: string, run: () => Promise<unknown>): void {
    if (this.tasks.length >= this.maxPending) {
      this.dropped++;
      // Logged once per drop rather than sampled: a shadow falling behind is the
      // signal this whole stage exists to produce.
      log.warn('shadow write dropped, queue full', {
        label,
        maxPending: this.maxPending,
        dropped: this.dropped,
      });
      return;
    }

    this.enqueued++;
    if (!this.resolveIdle) {
      this.idle = new Promise((resolve) => {
        this.resolveIdle = resolve;
      });
    }

    this.tasks.push(async () => {
      try {
        await run();
        this.applied++;
      } catch (error) {
        this.failed++;
        this.lastError = error instanceof Error ? error.message : String(error);
        log.warn('shadow write failed', { label, error: this.lastError });
      }
    });

    void this.drainLoop();
  }

  private async drainLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift()!;
        await task();
      }
    } finally {
      this.running = false;
      const resolve = this.resolveIdle;
      this.resolveIdle = undefined;
      resolve?.();
      // A push that landed between the loop ending and the flag clearing would
      // otherwise sit unprocessed until the next write arrived.
      if (this.tasks.length > 0) void this.drainLoop();
    }
  }

  /** Waits for everything queued so far. For shutdown, and for tests that need to
   *  observe the shadow after a write. */
  async drain(): Promise<void> {
    while (this.tasks.length > 0 || this.running) {
      await this.idle;
    }
  }

  stats(): ShadowStats {
    return {
      enqueued: this.enqueued,
      applied: this.applied,
      failed: this.failed,
      dropped: this.dropped,
      pending: this.tasks.length,
      lastError: this.lastError,
    };
  }
}
