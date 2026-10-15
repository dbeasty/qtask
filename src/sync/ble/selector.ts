/**
 * Picks ONE link per peer when several transports reach it, preferring the better one
 * (list order: Wi-Fi before Bluetooth). The sync coordinator is unchanged: it sees a
 * single `PeerLinkTransport` that announces a peer when its best link appears and
 * announces it gone only when its last link is gone.
 *
 *   const sel = new TransportSelector([lan, ble]);        // best first
 *   new LanSyncCoordinator(engine, sel, ...).start();
 *
 * Behaviour:
 *  - A better link appearing while a worse one is active: `onPeerUp(better)`. The worse
 *    link is NOT closed or reported down, and keeps serving requests the other side may
 *    still be sending on it, so a switch loses nothing. The coordinator simply starts
 *    using the better one.
 *  - The active link going away while a worse one is alive: `onPeerUp(worse)` (failover,
 *    no event for the peer going down).
 *  - Standby cost. A Bluetooth connection held open "just in case" costs the radio. After
 *    `standbyGraceMs` of the better link staying up, lower transports that implement
 *    `suppress(peerId, on)` are told to drop and stay away from this peer. When the
 *    better link goes down they are released and reconnect lazily: failover then takes a
 *    scan + connect + handshake (measured in docs/perf/phase4.md) instead of being
 *    instant. `standbyGraceMs: Infinity` keeps standby links for instant failover.
 */

import type { PeerLinkTransport, SyncPeerLink, TransportKind } from '../transport-contract.js';
import { realTimers, type Timers } from './radio.js';

export interface Suppressible {
  suppress(peerId: string, on: boolean): void;
}

function suppressible(t: PeerLinkTransport): t is PeerLinkTransport & Suppressible {
  return typeof (t as unknown as Suppressible).suppress === 'function';
}

export interface TransportSelectorOptions {
  standbyGraceMs?: number;
  timers?: Timers;
}

interface Entry {
  rank: number;
  link: SyncPeerLink;
}

export class TransportSelector implements PeerLinkTransport {
  private upHandlers: Array<(l: SyncPeerLink) => void> = [];
  private downHandlers: Array<(id: string, e?: Error) => void> = [];
  private perPeer = new Map<string, Entry[]>();
  private active = new Map<string, Entry>();
  private graceTimers = new Map<string, unknown>();
  private readonly timers: Timers;
  private readonly graceMs: number;

  constructor(
    private readonly transports: PeerLinkTransport[],
    opts: TransportSelectorOptions = {},
  ) {
    this.timers = opts.timers ?? realTimers;
    this.graceMs = opts.standbyGraceMs ?? 30_000;
    transports.forEach((t, rank) => {
      t.onPeerUp((link) => this.up(rank, link));
      t.onPeerDown((peerId, e) => this.down(rank, peerId, e));
    });
  }

  get localId(): string | undefined {
    return this.transports.find((t) => t.localId)?.localId;
  }

  /** Kind of the preferred transport. */
  get kind(): TransportKind {
    return this.transports[0]!.kind;
  }

  async start(): Promise<void> {
    await Promise.all(this.transports.map((t) => t.start()));
  }
  async stop(): Promise<void> {
    for (const t of this.graceTimers.values()) this.timers.clearTimeout(t);
    this.graceTimers.clear();
    await Promise.all(this.transports.map((t) => t.stop()));
  }

  onPeerUp(h: (l: SyncPeerLink) => void): void {
    this.upHandlers.push(h);
    for (const e of this.active.values()) h(e.link);
  }
  onPeerDown(h: (id: string, e?: Error) => void): void {
    this.downHandlers.push(h);
  }
  links(): SyncPeerLink[] {
    return [...this.active.values()].map((e) => e.link);
  }

  /** Every live link including standbys, for diagnostics. */
  allLinks(): SyncPeerLink[] {
    return [...this.perPeer.values()].flat().map((e) => e.link);
  }

  private best(list: Entry[]): Entry | undefined {
    return list.reduce<Entry | undefined>((b, e) => (!b || e.rank < b.rank ? e : b), undefined);
  }

  private up(rank: number, link: SyncPeerLink): void {
    const list = this.perPeer.get(link.peerId) ?? [];
    // A reconnect of the same transport replaces its stale entry.
    const kept = list.filter((e) => e.rank !== rank);
    const entry: Entry = { rank, link };
    kept.push(entry);
    this.perPeer.set(link.peerId, kept);
    const cur = this.active.get(link.peerId);
    if (!cur || rank <= cur.rank) {
      this.active.set(link.peerId, entry);
      this.armGrace(link.peerId, rank);
      for (const h of this.upHandlers) h(link);
    }
  }

  private down(rank: number, peerId: string, e?: Error): void {
    const list = (this.perPeer.get(peerId) ?? []).filter((x) => x.rank !== rank);
    if (list.length) this.perPeer.set(peerId, list);
    else this.perPeer.delete(peerId);
    const cur = this.active.get(peerId);
    if (!cur || cur.rank !== rank) return; // a standby went away: nobody needs to know
    this.active.delete(peerId);
    this.clearGrace(peerId);
    const next = this.best(list);
    // Release the lower transports so they reconnect if nothing else is alive.
    this.releaseBelow(peerId, rank);
    if (next) {
      this.active.set(peerId, next);
      this.armGrace(peerId, next.rank);
      for (const h of this.upHandlers) h(next.link);
    } else {
      for (const h of this.downHandlers) h(peerId, e);
    }
  }

  private clearGrace(peerId: string): void {
    const t = this.graceTimers.get(peerId);
    if (t) this.timers.clearTimeout(t);
    this.graceTimers.delete(peerId);
  }

  private armGrace(peerId: string, rank: number): void {
    this.clearGrace(peerId);
    if (rank >= this.transports.length - 1 || !Number.isFinite(this.graceMs)) return;
    this.graceTimers.set(
      peerId,
      this.timers.setTimeout(() => {
        this.graceTimers.delete(peerId);
        const cur = this.active.get(peerId);
        if (!cur || cur.rank !== rank) return;
        this.transports.forEach((t, r) => {
          if (r > rank && suppressible(t)) t.suppress(peerId, true);
        });
      }, this.graceMs),
    );
  }

  private releaseBelow(peerId: string, rank: number): void {
    this.transports.forEach((t, r) => {
      if (r >= rank && suppressible(t)) t.suppress(peerId, false);
    });
  }
}
