/**
 * Sync records: everything the engine knows about a document besides its content.
 *
 * Kept beside the data rather than inside it so that no backend schema has to learn
 * about sync, and so a store the sync layer does not own (Mongo behind the cloud
 * API) is not widened. The records are in memory with an optional JSON snapshot;
 * `reconcile()` in the engine rebuilds anything a lost snapshot or a crash dropped
 * by comparing the records against the live collections.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { ReplicatedCollection } from './types.js';

export interface FieldRec {
  /** Stamp of the write that produced the current value. */
  t: string;
  /** Writer's per-document counter at that write. */
  c: number;
  /** Hash of the encoded value, to notice local edits without storing the value. */
  h: number;
  /** The field was removed by that write. */
  x?: 1;
}

export interface DocRec {
  coll: ReplicatedCollection;
  id: string;
  scope: string;
  fields: Record<string, FieldRec>;
  vv: Record<string, number>;
  del?: { t: string; c: number };
  /** Local change sequence; bumped whenever this record changes. */
  seq: number;
  /** Peer whose state this record equals exactly, or null when it has local content. */
  src: string | null;
  /** Wall-clock ms of the latest change, as sync sees it. */
  ut: number;
}

export interface PeerCursor {
  epoch: string;
  pushedSeq: number;
  pulledSeq: number;
  /** Scope signature the pull cursor was issued under. */
  sig?: string;
  lastSyncedAt?: string;
}

export const recKey = (coll: string, id: string): string => `${coll}:${id}`;

export function isLive(rec: DocRec): boolean {
  return Object.keys(rec.fields).length > 0;
}

interface ScopeLog {
  seqs: number[];
  keys: string[];
}

export interface MetaSnapshot {
  version: 1;
  nodeId: string;
  epoch: string;
  clock: string;
  seq: number;
  recs: DocRec[];
  peers: Record<string, PeerCursor>;
  dirty: Array<[string, number]>;
}

export interface MetaStore {
  readonly nodeId: string;
  readonly epoch: string;
  clock: string;
  readonly seq: number;
  get(key: string): DocRec | undefined;
  /** Registers or updates a record and assigns it a fresh `seq`. */
  commit(rec: DocRec): void;
  all(): IterableIterator<DocRec>;
  readonly size: number;
  /** Notes that a document changed, remembering when (wall ms) so its stamp reflects the write. */
  markDirty(key: string, at?: number): void;
  takeDirty(): Array<[key: string, at: number]>;
  hasDirty(key: string): boolean;
  dirtyCount(): number;
  peer(peerId: string): PeerCursor | undefined;
  setPeer(peerId: string, cursor: PeerCursor): void;
  peers(): Array<[string, PeerCursor]>;
  /** Records after `cursor`, oldest first, optionally limited to scopes. */
  since(
    scopes: ReadonlySet<string> | null,
    cursor: number,
    limit: number,
    excludeSrc?: string
  ): { recs: DocRec[]; more: boolean };
  countSince(scopes: ReadonlySet<string> | null, cursor: number, excludeSrc?: string): number;
  tombstoneCount(): number;
  /** Called when a snapshot is wanted; persistence implementations hook this. */
  changed(): void;
}

function lowerBound(seqs: number[], cursor: number): number {
  let lo = 0;
  let hi = seqs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (seqs[mid]! <= cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class MemoryMetaStore implements MetaStore {
  nodeId: string;
  epoch: string;
  clock = '';
  seq = 0;
  private readonly recs = new Map<string, DocRec>();
  private readonly logs = new Map<string, ScopeLog>();
  private logEntries = 0;
  private dirty = new Map<string, number>();
  private readonly peerCursors = new Map<string, PeerCursor>();
  private onChange?: () => void;

  constructor(options: { nodeId?: string; epoch?: string } = {}) {
    this.nodeId = options.nodeId ?? randomBytes(6).toString('hex');
    this.epoch = options.epoch ?? randomBytes(6).toString('hex');
  }

  get size(): number {
    return this.recs.size;
  }

  get(key: string): DocRec | undefined {
    return this.recs.get(key);
  }

  commit(rec: DocRec): void {
    const key = recKey(rec.coll, rec.id);
    rec.seq = ++this.seq;
    this.recs.set(key, rec);
    let log = this.logs.get(rec.scope);
    if (!log) {
      log = { seqs: [], keys: [] };
      this.logs.set(rec.scope, log);
    }
    log.seqs.push(rec.seq);
    log.keys.push(key);
    this.logEntries += 1;
    if (this.logEntries > 2 * this.recs.size + 1024) this.compact();
    this.changed();
  }

  /** Drops log entries that a newer commit superseded. */
  private compact(): void {
    this.logs.clear();
    const ordered = [...this.recs.entries()].sort((a, b) => a[1].seq - b[1].seq);
    for (const [key, rec] of ordered) {
      let log = this.logs.get(rec.scope);
      if (!log) {
        log = { seqs: [], keys: [] };
        this.logs.set(rec.scope, log);
      }
      log.seqs.push(rec.seq);
      log.keys.push(key);
    }
    this.logEntries = this.recs.size;
  }

  all(): IterableIterator<DocRec> {
    return this.recs.values();
  }

  markDirty(key: string, at: number = Date.now()): void {
    this.dirty.set(key, at);
  }

  takeDirty(): Array<[string, number]> {
    const entries = [...this.dirty.entries()].sort((a, b) => a[1] - b[1]);
    this.dirty = new Map();
    return entries;
  }

  hasDirty(key: string): boolean {
    return this.dirty.has(key);
  }

  dirtyCount(): number {
    return this.dirty.size;
  }

  peer(peerId: string): PeerCursor | undefined {
    return this.peerCursors.get(peerId);
  }

  setPeer(peerId: string, cursor: PeerCursor): void {
    this.peerCursors.set(peerId, cursor);
    this.changed();
  }

  peers(): Array<[string, PeerCursor]> {
    return [...this.peerCursors.entries()];
  }

  tombstoneCount(): number {
    let n = 0;
    for (const rec of this.recs.values()) if (rec.del && !isLive(rec)) n += 1;
    return n;
  }

  since(
    scopes: ReadonlySet<string> | null,
    cursor: number,
    limit: number,
    excludeSrc?: string
  ): { recs: DocRec[]; more: boolean } {
    const collected: DocRec[] = [];
    let more = false;
    const logs = scopes ? [...scopes].map((s) => [s, this.logs.get(s)] as const) : [...this.logs.entries()];
    for (const [scope, log] of logs) {
      if (!log) continue;
      let taken = 0;
      for (let i = lowerBound(log.seqs, cursor); i < log.seqs.length; i++) {
        const rec = this.recs.get(log.keys[i]!);
        if (!rec || rec.seq !== log.seqs[i] || rec.scope !== scope) continue;
        if (excludeSrc !== undefined && rec.src === excludeSrc) continue;
        if (taken === limit) {
          more = true;
          break;
        }
        collected.push(rec);
        taken += 1;
      }
    }
    collected.sort((a, b) => a.seq - b.seq);
    if (collected.length > limit) {
      collected.length = limit;
      more = true;
    }
    return { recs: collected, more };
  }

  countSince(scopes: ReadonlySet<string> | null, cursor: number, excludeSrc?: string): number {
    let count = 0;
    const logs = scopes ? [...scopes].map((s) => [s, this.logs.get(s)] as const) : [...this.logs.entries()];
    for (const [scope, log] of logs) {
      if (!log) continue;
      for (let i = lowerBound(log.seqs, cursor); i < log.seqs.length; i++) {
        const rec = this.recs.get(log.keys[i]!);
        if (!rec || rec.seq !== log.seqs[i] || rec.scope !== scope) continue;
        if (excludeSrc !== undefined && rec.src === excludeSrc) continue;
        count += 1;
      }
    }
    return count;
  }

  changed(): void {
    this.onChange?.();
  }

  setChangeListener(listener: (() => void) | undefined): void {
    this.onChange = listener;
  }

  snapshot(): MetaSnapshot {
    return {
      version: 1,
      nodeId: this.nodeId,
      epoch: this.epoch,
      clock: this.clock,
      seq: this.seq,
      recs: [...this.recs.values()],
      peers: Object.fromEntries(this.peerCursors),
      dirty: [...this.dirty.entries()],
    };
  }

  static restore(snapshot: MetaSnapshot): MemoryMetaStore {
    const store = new MemoryMetaStore({ nodeId: snapshot.nodeId, epoch: snapshot.epoch });
    store.clock = snapshot.clock;
    for (const rec of snapshot.recs) store.recs.set(recKey(rec.coll, rec.id), rec);
    store.compact();
    store.seq = snapshot.seq;
    for (const [peerId, cursor] of Object.entries(snapshot.peers)) store.peerCursors.set(peerId, cursor);
    store.dirty = new Map(snapshot.dirty);
    store.onChange = undefined;
    return store;
  }
}

/**
 * Debounced JSON persistence for a MemoryMetaStore. The write is atomic (temp file +
 * rename), so a crash leaves the previous snapshot rather than a torn one.
 */
export class FileMetaPersistence {
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly meta: MemoryMetaStore,
    private readonly path: string,
    private readonly debounceMs = 1000
  ) {
    meta.setChangeListener(() => this.schedule());
  }

  static async open(
    path: string,
    options: { nodeId?: string; debounceMs?: number } = {}
  ): Promise<{ meta: MemoryMetaStore; persistence: FileMetaPersistence }> {
    let meta: MemoryMetaStore;
    try {
      const raw = await fs.readFile(path, 'utf8');
      meta = MemoryMetaStore.restore(JSON.parse(raw) as MetaSnapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      meta = new MemoryMetaStore({ nodeId: options.nodeId });
    }
    return { meta, persistence: new FileMetaPersistence(meta, path, options.debounceMs) };
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const body = JSON.stringify(this.meta.snapshot());
    this.writing = this.writing.then(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, this.path);
    });
    await this.writing;
  }
}
