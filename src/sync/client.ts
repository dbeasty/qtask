/**
 * The offline device's side of cloud sync: dials out when signed in, retries with
 * exponential backoff, and reports status ("last synced", "N changes waiting").
 *
 * It never listens. A device behind NAT or on a phone hotspot reaches the hub the
 * same way a browser does, with the account's bearer token. With no token it makes no
 * network call at all, which is what "works offline, syncs when signed in" means.
 */

import type { SyncEngine } from './engine.js';
import { HttpSyncTransport, SyncTransportError } from './transport.js';
import type { SyncResult, SyncStatus, SyncTransport } from './types.js';

export type ClientState = 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out' | 'stopped';

export interface DeviceSyncClientOptions {
  engine: SyncEngine;
  /** Provide either a ready transport or the hub URL. */
  transport?: SyncTransport;
  hubUrl?: string;
  getToken: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** Periodic sync interval while healthy. Default 60s. */
  intervalMs?: number;
  /** First retry delay; doubles per consecutive failure. Default 2s. */
  minBackoffMs?: number;
  /** Retry delay ceiling. Default 5 min. */
  maxBackoffMs?: number;
  /** Delay between a local change notification and the sync it triggers. Default 2s. */
  debounceMs?: number;
  /** 0..1 randomness source, injectable for tests. */
  random?: () => number;
  onStatus?: (status: ClientStatus) => void;
}

export interface ClientStatus {
  state: ClientState;
  lastSyncedAt?: string;
  lastError?: string;
  lastResult?: Pick<SyncResult, 'pulled' | 'pushed' | 'conflicts' | 'rounds' | 'durationMs'>;
  consecutiveFailures: number;
  nextAttemptAt?: string;
  pendingChanges: number;
  sync: SyncStatus;
}

export class DeviceSyncClient {
  private readonly engine: SyncEngine;
  private readonly transport: SyncTransport;
  private readonly options: Required<Pick<DeviceSyncClientOptions, 'intervalMs' | 'minBackoffMs' | 'maxBackoffMs' | 'debounceMs'>> &
    DeviceSyncClientOptions;
  private state: ClientState = 'stopped';
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<SyncResult | undefined>;
  /** The one run queued behind `inflight`, shared by every call made while it runs. */
  private followUp?: Promise<SyncResult | undefined>;
  private failures = 0;
  private lastError?: string;
  private lastResult?: ClientStatus['lastResult'];
  private nextAttemptAt?: number;
  private running = false;

  constructor(options: DeviceSyncClientOptions) {
    this.engine = options.engine;
    if (!options.transport && !options.hubUrl) throw new Error('transport or hubUrl is required');
    this.transport =
      options.transport ??
      new HttpSyncTransport({ baseUrl: options.hubUrl!, getToken: options.getToken, fetchImpl: options.fetchImpl });
    this.options = {
      intervalMs: 60_000,
      minBackoffMs: 2_000,
      maxBackoffMs: 5 * 60_000,
      debounceMs: 2_000,
      ...options,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = 'idle';
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    this.state = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextAttemptAt = undefined;
  }

  /** Call after a local write so it reaches the cloud soon; coalesced by the debounce. */
  notifyLocalChange(): void {
    if (!this.running || this.failures > 0) return;
    // A write made while a run is going may have missed its capture: queue one after it.
    if (this.inflight) {
      void this.syncNow().catch(() => undefined);
      return;
    }
    this.schedule(this.options.debounceMs);
  }

  /** Delay before the next attempt after `failures` consecutive failures. */
  backoffMs(failures: number): number {
    const random = this.options.random ?? Math.random;
    const exponential = Math.min(this.options.maxBackoffMs, this.options.minBackoffMs * 2 ** Math.max(0, failures - 1));
    // Equal jitter: half fixed, half random, so a fleet reconnecting together spreads out.
    return Math.round(exponential / 2 + (random() * exponential) / 2);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAttemptAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.syncNow().catch(() => undefined);
    }, delayMs);
    this.timer.unref();
  }

  /**
   * Sync now. Resolves after a run that started after this call, so a change made just
   * before calling is included even when a run was already going (that run may have
   * passed its capture or its pull). Calls made during a run share one follow-up run.
   * Resolves undefined if signed out.
   */
  syncNow(): Promise<SyncResult | undefined> {
    if (this.inflight) {
      this.followUp ??= this.inflight
        .catch(() => undefined)
        .then(() => {
          this.followUp = undefined;
          return this.syncNow();
        });
      return this.followUp;
    }
    this.inflight = this.run().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async run(): Promise<SyncResult | undefined> {
    const token = await this.options.getToken();
    if (!token) {
      this.state = this.running ? 'signed-out' : this.state;
      this.failures = 0;
      this.lastError = undefined;
      this.emit();
      // Poll for a token appearing; no network involved.
      this.schedule(this.options.intervalMs);
      return undefined;
    }

    this.state = 'syncing';
    this.emit();
    try {
      const result = await this.engine.syncWith(this.transport);
      this.failures = 0;
      this.lastError = undefined;
      this.lastResult = {
        pulled: result.pulled,
        pushed: result.pushed,
        conflicts: result.conflicts,
        rounds: result.rounds,
        durationMs: result.durationMs,
      };
      this.state = 'idle';
      this.emit();
      this.schedule(this.options.intervalMs);
      return result;
    } catch (error) {
      this.failures += 1;
      this.lastError = (error as Error).message;
      const transportError = error instanceof SyncTransportError ? error : undefined;
      if (transportError?.status === 401) {
        // The token was rejected: stop dialling until the app supplies a new one.
        this.state = 'signed-out';
        this.failures = 0;
        this.emit();
        this.schedule(this.options.intervalMs);
        return undefined;
      }
      this.state = transportError && transportError.status === undefined ? 'offline' : 'error';
      this.emit();
      this.schedule(this.backoffMs(this.failures));
      throw error;
    }
  }

  async status(): Promise<ClientStatus> {
    const sync = await this.engine.status();
    return {
      state: this.state,
      lastSyncedAt: sync.lastSyncedAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
      consecutiveFailures: this.failures,
      nextAttemptAt: this.nextAttemptAt ? new Date(this.nextAttemptAt).toISOString() : undefined,
      pendingChanges: sync.pendingChanges,
      sync,
    };
  }

  private emit(): void {
    if (!this.options.onStatus) return;
    void this.status().then((s) => this.options.onStatus!(s), () => undefined);
  }
}
