/**
 * Bridges the two transport layers: the engine speaks request/response
 * (`SyncTransport`: hello, pull, push) and the LAN/BLE transports move opaque
 * messages over a link (`SyncPeerLink`). `LinkRpc` multiplexes both directions on one
 * link, so each side can serve the other and ask it questions at the same time.
 *
 * `LanSyncCoordinator` then runs the engine over every paired peer that is up.
 * Paired devices belong to one person, so they are fully trusted: no authorizer.
 */

import type { SyncEngine } from '../engine.js';
import type {
  HelloRequest,
  HelloResponse,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SyncResult,
  SyncTransport,
} from '../types.js';
import type { PeerLinkTransport, SyncPeerLink } from '../transport-contract.js';

type Op = 'hello' | 'pull' | 'push';
type Envelope =
  | { k: 'req'; id: number; op: Op; body: unknown }
  | { k: 'res'; id: number; body: unknown }
  | { k: 'err'; id: number; message: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class LinkRpc implements SyncTransport {
  readonly kind: string;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(
    private readonly link: SyncPeerLink,
    private readonly service: SyncServiceLike,
    private readonly options: { timeoutMs?: number; onServed?: (op: Op) => void } = {}
  ) {
    this.kind = link.transport;
    link.onMessage((m) => this.receive(m));
    link.onClose((reason) => this.fail(reason ?? new Error('link closed')));
  }

  hello(req: HelloRequest): Promise<HelloResponse> {
    return this.call('hello', req);
  }
  pull(req: PullRequest): Promise<PullResponse> {
    return this.call('pull', req);
  }
  push(req: PushRequest): Promise<PushResponse> {
    return this.call('push', req);
  }
  async close(): Promise<void> {
    this.fail(new Error('closed'));
    this.link.close();
  }

  private call<T>(op: Op, body: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('link closed'));
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sync ${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.link.send(encoder.encode(JSON.stringify({ k: 'req', id, op, body } satisfies Envelope))).catch((e) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      });
    });
  }

  private async receive(raw: Uint8Array): Promise<void> {
    let env: Envelope;
    try {
      env = JSON.parse(decoder.decode(raw)) as Envelope;
    } catch {
      return; // not ours; a malformed message never takes the link down
    }
    if (env.k === 'res' || env.k === 'err') {
      const p = this.pending.get(env.id);
      if (!p) return;
      this.pending.delete(env.id);
      if (env.k === 'res') p.resolve(env.body);
      else p.reject(new Error(env.message));
      return;
    }
    if (env.k !== 'req') return;
    try {
      const body = await this.serve(env.op, env.body);
      await this.link.send(encoder.encode(JSON.stringify({ k: 'res', id: env.id, body } satisfies Envelope)));
      this.options.onServed?.(env.op);
    } catch (e) {
      await this.link
        .send(encoder.encode(JSON.stringify({ k: 'err', id: env.id, message: (e as Error).message } satisfies Envelope)))
        .catch(() => undefined);
    }
  }

  private serve(op: Op, body: unknown): Promise<unknown> {
    switch (op) {
      case 'hello':
        return this.service.hello(body as HelloRequest);
      case 'pull':
        return this.service.pull(body as PullRequest);
      case 'push':
        return this.service.push(body as PushRequest);
      default:
        return Promise.reject(new Error(`unknown op ${String(op)}`));
    }
  }

  private fail(reason: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }
}

interface SyncServiceLike {
  hello(req: HelloRequest): Promise<HelloResponse>;
  pull(req: PullRequest): Promise<PullResponse>;
  push(req: PushRequest): Promise<PushResponse>;
}

export interface LanSyncOptions {
  /** Minimum gap between two rounds with the same peer. */
  debounceMs?: number;
  /** Offer version vectors before content so nothing is sent twice. On by default; false for A/B comparison. */
  headersFirst?: boolean;
  onResult?: (peerId: string, result: SyncResult) => void;
  onError?: (peerId: string, error: Error) => void;
}

/**
 * Runs the engine over every paired peer that is up: a round when a peer appears, a
 * round after local changes (`syncNow`), and a round with the other peers after a
 * peer pushes us something, so a change relays through a mesh.
 */
export class LanSyncCoordinator {
  private readonly rpcs = new Map<string, LinkRpc>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private stopped = false;

  constructor(
    private readonly engine: SyncEngine,
    private readonly transport: PeerLinkTransport,
    private readonly options: LanSyncOptions = {}
  ) {}

  start(): void {
    this.transport.onPeerUp((link) => {
      const rpc = new LinkRpc(link, this.engine.service(), {
        onServed: (op) => {
          // A peer pushed us changes: relay them to everyone else.
          if (op === 'push') this.syncAllExcept(link.peerId);
        },
      });
      this.rpcs.set(link.peerId, rpc);
      // Both ends see peerUp and both start a round; `running` collapses overlaps.
      void this.syncPeer(link.peerId);
    });
    this.transport.onPeerDown((peerId) => {
      this.rpcs.delete(peerId);
    });
  }

  stop(): void {
    this.stopped = true;
  }

  /** Call after local writes. Resolves when every peer round has finished. */
  async syncNow(): Promise<void> {
    await Promise.all([...this.rpcs.keys()].map((id) => this.syncPeer(id)));
  }

  private syncAllExcept(peerId: string): void {
    for (const id of this.rpcs.keys()) if (id !== peerId) void this.syncPeer(id);
  }

  private syncPeer(peerId: string): Promise<void> {
    const current = this.running.get(peerId);
    if (current) {
      this.again.add(peerId); // changes landed mid-round: run once more afterwards
      return current;
    }
    const run = (async () => {
      do {
        this.again.delete(peerId);
        const rpc = this.rpcs.get(peerId);
        if (!rpc || this.stopped) return;
        try {
          const result = await this.engine.syncWith(rpc, { headersFirst: this.options.headersFirst !== false });
          this.options.onResult?.(peerId, result);
        } catch (e) {
          this.options.onError?.(peerId, e as Error);
        }
      } while (this.again.has(peerId));
    })().finally(() => this.running.delete(peerId));
    this.running.set(peerId, run);
    return run;
  }
}
