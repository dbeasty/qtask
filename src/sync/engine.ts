/**
 * The sync engine: captures local changes, applies remote ones, and exchanges deltas
 * with a peer through any `SyncTransport`.
 *
 * One engine serves both directions. As a client it runs `syncWith(transport)`; as a
 * server it hands out `service(authorizer)`, which a hub route, a LAN listener or a
 * BLE tunnel calls with decoded requests. The hub is not special to the engine: it is
 * a peer whose authorizer is stricter.
 */

import { createHash } from 'node:crypto';
import { HybridClock, stampWall } from './clock.js';
import { decodeValue, encodeValue, hashEncoded } from './codec.js';
import { mergeRecords, type MergeOutcome } from './merge.js';
import { isLive, recKey, type DocRec, type FieldRec, type MetaStore } from './meta.js';
import { computeScope, isSyncedField, REPLICATED_COLLECTIONS } from './policy.js';
import { ALL_MARK, type SyncDataStore } from './tracker.js';
import {
  PROTOCOL_VERSION,
  type ConflictRecord,
  type HelloRequest,
  type HelloResponse,
  type PeerStatus,
  type PullRequest,
  type PullResponse,
  type PushRejection,
  type PushRequest,
  type PushResponse,
  type ReplicatedCollection,
  type SyncAuthorizer,
  type SyncLogEntry,
  type SyncResult,
  type SyncStatus,
  type SyncTransport,
  type WireDoc,
  type WireField,
} from './types.js';
import type { Doc } from '../data/types.js';
import { projectHintsFor, type TouchedDoc } from './derived.js';

/** Recomputes fields that are derived from other fields, after a merge changed them. */
export interface DerivedRecompute {
  recompute(
    store: SyncDataStore,
    touched: ReadonlyArray<TouchedDoc>
  ): Promise<void>;
}

export interface SyncEngineOptions {
  store: SyncDataStore;
  meta: MetaStore;
  role: 'hub' | 'device';
  derived?: DerivedRecompute;
  /** Injectable for tests. */
  now?: () => number;
  batchSize?: number;
}

const COLL_ORDER = new Map(REPLICATED_COLLECTIONS.map((name, index) => [name, index]));
const CHUNK = 500;
const MAX_ROUNDS = 5;
const LOG_LIMIT = 500;

function parseKey(key: string): { coll: ReplicatedCollection; id: string } {
  const index = key.indexOf(':');
  return { coll: key.slice(0, index) as ReplicatedCollection, id: key.slice(index + 1) };
}

/** A deterministic ObjectId-shaped id, so two peers logging the same conflict agree. */
function deterministicId(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}

export class SyncEngine {
  readonly store: SyncDataStore;
  readonly meta: MetaStore;
  readonly role: 'hub' | 'device';
  readonly clock: HybridClock;
  private readonly derived?: DerivedRecompute;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly syncLog: SyncLogEntry[] = [];
  private touched = new Map<string, TouchedDoc>();
  private capturing: Promise<number> = Promise.resolve(0);

  constructor(options: SyncEngineOptions) {
    this.store = options.store;
    this.meta = options.meta;
    this.role = options.role;
    this.derived = options.derived;
    this.now = options.now ?? Date.now;
    this.batchSize = options.batchSize ?? CHUNK;
    this.clock = new HybridClock(this.meta.nodeId, this.now, this.meta.clock || undefined);
  }

  get nodeId(): string {
    return this.meta.nodeId;
  }

  /**
   * Prepares the engine. On first run this baselines every existing replicated
   * document (so data created before sync was enabled, such as a local-mode
   * database, becomes replicable); on later runs it only repairs what a crash lost.
   */
  async init(): Promise<void> {
    await this.reconcile();
  }

  // --- change capture ---------------------------------------------------------------

  private get inner() {
    return this.store.inner;
  }

  /** Processes the dirty set. Serialised so concurrent callers never double-stamp. */
  capture(): Promise<number> {
    const run = this.capturing.then(() => this.captureNow());
    this.capturing = run.catch(() => 0);
    return run;
  }

  private async captureNow(): Promise<number> {
    const entries = this.meta.takeDirty();
    if (entries.length === 0) return 0;
    const wholeCollections = new Set<string>();
    const direct: Array<[string, number]> = [];
    for (const entry of entries) {
      if (entry[0].startsWith(`${ALL_MARK}:`)) wholeCollections.add(entry[0].slice(ALL_MARK.length + 1));
      else direct.push(entry);
    }
    let changed = 0;
    if (wholeCollections.size > 0) changed += await this.reconcile([...wholeCollections] as ReplicatedCollection[]);
    changed += await this.captureKeys(direct);
    return changed;
  }

  private async captureKeys(entries: Array<[string, number]>): Promise<number> {
    const byColl = new Map<ReplicatedCollection, string[]>();
    const when = new Map<string, number>();
    for (const [key, at] of entries) {
      const { coll, id } = parseKey(key);
      const list = byColl.get(coll) ?? [];
      list.push(id);
      byColl.set(coll, list);
      when.set(key, at);
    }
    const ordered = [...byColl.entries()].sort(
      (a, b) => (COLL_ORDER.get(a[0]) ?? 99) - (COLL_ORDER.get(b[0]) ?? 99)
    );
    let changed = 0;
    for (const [coll, ids] of ordered) {
      for (let i = 0; i < ids.length; i += this.batchSize) {
        const chunk = ids.slice(i, i + this.batchSize);
        const docs = await this.inner.collection(coll).find({ _id: { $in: chunk } });
        const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
        for (const id of chunk) {
          if (this.captureDoc(coll, id, byId.get(id) ?? null, when.get(recKey(coll, id)))) changed += 1;
        }
      }
    }
    return changed;
  }

  /**
   * Compares one live document (or its absence) with its sync record and, when they
   * disagree, stamps the difference as a local edit. Synchronous: it only touches
   * memory, so a batch cannot interleave with another capture.
   */
  captureDoc(coll: ReplicatedCollection, id: string, doc: Doc | null, at?: number): boolean {
    const key = recKey(coll, id);
    const existing = this.meta.get(key);

    if (!doc) {
      if (!existing || !isLive(existing)) return false;
      const t = this.clock.tick(at);
      const node = this.nodeId;
      const c = (existing.vv[node] ?? 0) + 1;
      existing.vv[node] = c;
      existing.del = { t, c };
      existing.fields = {};
      existing.src = null;
      existing.ut = stampWall(t);
      this.commit(existing);
      return true;
    }

    // A tombstoned id stays deleted; a local write that raced a remote delete loses.
    if (existing?.del) return false;

    const rec: DocRec = existing ?? {
      coll,
      id,
      scope: '',
      fields: {},
      vv: {},
      seq: 0,
      src: null,
      ut: 0,
    };

    const encoded: Record<string, { v: unknown; h: number }> = {};
    for (const [name, value] of Object.entries(doc)) {
      if (value === undefined || !isSyncedField(coll, name)) continue;
      const v = encodeValue(value);
      encoded[name] = { v, h: hashEncoded(v) };
    }

    const changedFields: Array<[string, number, boolean]> = [];
    for (const [name, { h }] of Object.entries(encoded)) {
      const current = rec.fields[name];
      if (!current || current.x || current.h !== h) changedFields.push([name, h, false]);
    }
    for (const [name, current] of Object.entries(rec.fields)) {
      if (!(name in encoded) && !current.x) changedFields.push([name, 0, true]);
    }

    const scope = computeScope(coll, id, doc, (c, i) => this.meta.get(recKey(c, i))?.scope);
    if (changedFields.length === 0 && existing && existing.scope === scope) return false;

    if (changedFields.length > 0) {
      const t = this.clock.tick(at);
      const node = this.nodeId;
      const c = (rec.vv[node] ?? 0) + 1;
      rec.vv[node] = c;
      for (const [name, h, removed] of changedFields) {
        const next: FieldRec = removed ? { t, c, h: 0, x: 1 } : { t, c, h };
        rec.fields[name] = next;
      }
      rec.ut = stampWall(t);
    }
    rec.scope = scope;
    rec.src = null;
    this.commit(rec);
    return changedFields.length > 0 || !existing;
  }

  private commit(rec: DocRec): void {
    this.meta.clock = this.clock.last();
    this.meta.commit(rec);
  }

  /**
   * Full verification scan: every document of the given collections against its
   * record, and every live record against the store. Used on startup and after a
   * write whose targets could not be known. O(documents).
   */
  async reconcile(only?: ReplicatedCollection[]): Promise<number> {
    const targets = only ?? REPLICATED_COLLECTIONS;
    let changed = 0;
    for (const coll of targets) {
      const docs = await this.inner.collection(coll).find({});
      const present = new Set<string>();
      for (const doc of docs) {
        const id = String(doc._id);
        present.add(id);
        if (this.captureDoc(coll, id, doc)) changed += 1;
      }
      for (const rec of [...this.meta.all()]) {
        if (rec.coll !== coll || !isLive(rec) || present.has(rec.id)) continue;
        if (this.captureDoc(coll, rec.id, null)) changed += 1;
      }
    }
    return changed;
  }

  // --- applying remote documents ----------------------------------------------------

  /**
   * Applies one incoming document. Idempotent: applying the same document again, or
   * one the local record already dominates, changes nothing and bumps no sequence.
   * `check` is the hub's authorization hook; it sees what the merge would change
   * before anything is written.
   */
  async applyRemote(
    wire: WireDoc,
    peerId: string,
    check?: (merge: MergeOutcome, existing: Doc | null) => Promise<string | null>
  ): Promise<{ applied: boolean; conflicts: number; rejected?: string }> {
    const key = recKey(wire.coll, wire.id);
    if (this.meta.hasDirty(key)) await this.capture();

    for (const field of Object.values(wire.fields)) this.clock.observe(field.t);
    if (wire.del) this.clock.observe(wire.del.t);

    const local = this.meta.get(key);
    const merge = mergeRecords(local, wire);
    if (!merge.changed && local) return { applied: false, conflicts: 0 };

    const coll = this.inner.collection(wire.coll);
    const current = await coll.findById(wire.id);

    if (check) {
      const reason = await check(merge, current);
      if (reason) return { applied: false, conflicts: 0, rejected: reason };
    }

    const set: Doc = {};
    const unset: Record<string, 1> = {};
    for (const name of merge.takeRemote) {
      const field = wire.fields[name]!;
      if (field.x) unset[name] = 1;
      else set[name] = decodeValue(field.v);
    }
    for (const name of merge.dropLocal) unset[name] = 1;

    let finalDoc: Doc | null = null;
    if (merge.deleted) {
      if (current) await coll.deleteOne({ _id: wire.id });
    } else if (!current) {
      try {
        finalDoc = await coll.create({ _id: wire.id, ...set });
      } catch {
        // A concurrent create of the same id: fall through to an update.
        await coll.updateOne({ _id: wire.id }, { $set: set });
        finalDoc = await coll.findById(wire.id);
      }
    } else {
      const update: Doc = {};
      if (Object.keys(set).length > 0) update.$set = set;
      if (Object.keys(unset).length > 0) update.$unset = unset;
      if (Object.keys(update).length > 0) await coll.updateOne({ _id: wire.id }, update);
      finalDoc = { ...current, ...set };
      for (const name of Object.keys(unset)) delete finalDoc[name];
    }

    // Conflicts are recorded before the record moves, so a failure here retries the
    // whole document on the next sync instead of losing the loser silently.
    let conflictCount = 0;
    for (const conflict of merge.conflicts) {
      conflictCount += 1;
      const localField = local?.fields[conflict.field];
      const remoteField = wire.fields[conflict.field]!;
      const localValue = current ? encodeValue(current[conflict.field]) : undefined;
      const record: ConflictRecord =
        conflict.winner === 'remote'
          ? {
              coll: wire.coll,
              id: wire.id,
              field: conflict.field,
              kept: { t: remoteField.t, value: remoteField.v },
              discarded: { t: localField?.t ?? '', value: localValue },
            }
          : {
              coll: wire.coll,
              id: wire.id,
              field: conflict.field,
              kept: { t: localField?.t ?? '', value: localValue },
              discarded: { t: remoteField.t, value: remoteField.v },
            };
      await this.recordConflict(record, finalDoc ?? current ?? {}, peerId);
    }

    const rec: DocRec = {
      coll: wire.coll,
      id: wire.id,
      scope: wire.scope,
      fields: merge.fields,
      vv: merge.vv,
      del: merge.del,
      seq: 0,
      src: merge.equalsRemote ? peerId : null,
      ut: Math.max(local?.ut ?? 0, ...Object.values(wire.fields).map((f) => stampWall(f.t)), wire.del ? stampWall(wire.del.t) : 0),
    };
    if (this.role === 'hub' && finalDoc) {
      rec.scope = computeScope(wire.coll, wire.id, finalDoc, (c, i) => this.meta.get(recKey(c, i))?.scope);
    }
    this.commit(rec);
    const hints = new Set([...projectHintsFor(wire.coll, wire.id, current), ...projectHintsFor(wire.coll, wire.id, finalDoc)]);
    this.touched.set(key, { coll: wire.coll, id: wire.id, projectHints: [...hints] });
    return { applied: true, conflicts: conflictCount };
  }

  private async recordConflict(conflict: ConflictRecord, doc: Doc, peerId: string): Promise<void> {
    this.pushLog({ at: new Date(this.now()).toISOString(), kind: 'conflict', peerId, conflict });
    const taskId = conflict.coll === 'tasks' ? conflict.id : String(doc.taskId ?? conflict.id);
    const userId = String(doc.userId ?? 'system');
    try {
      await this.store.collection('activities').create({
        _id: deterministicId('conflict', conflict.coll, conflict.id, conflict.field, conflict.kept.t, conflict.discarded.t),
        taskId,
        userId,
        action: 'sync_conflict',
        source: 'system',
        details: {
          collection: conflict.coll,
          documentId: conflict.id,
          field: conflict.field,
          kept: conflict.kept,
          discarded: conflict.discarded,
        },
      });
    } catch {
      // Already logged by another peer (same deterministic id): nothing more to do.
    }
  }

  private pushLog(entry: SyncLogEntry): void {
    this.syncLog.push(entry);
    if (this.syncLog.length > LOG_LIMIT) this.syncLog.splice(0, this.syncLog.length - LOG_LIMIT);
  }

  /** Recent conflicts, rejections and syncs, newest last. */
  log(): readonly SyncLogEntry[] {
    return this.syncLog;
  }

  private async finishApply(): Promise<void> {
    if (this.touched.size === 0) return;
    const touched = [...this.touched.values()];
    this.touched = new Map();
    if (this.derived) await this.derived.recompute(this.store, touched);
    // Derived writes and conflict activities went through the tracked store; fold
    // them into the records now so they are part of this round.
    await this.capture();
  }

  // --- building outgoing documents --------------------------------------------------

  private async toWire(recs: DocRec[]): Promise<WireDoc[]> {
    const out: WireDoc[] = [];
    const byColl = new Map<ReplicatedCollection, DocRec[]>();
    for (const rec of recs) {
      const list = byColl.get(rec.coll) ?? [];
      list.push(rec);
      byColl.set(rec.coll, list);
    }
    for (const [coll, list] of byColl) {
      const live = list.filter(isLive);
      const docs = new Map<string, Doc>();
      for (let i = 0; i < live.length; i += this.batchSize) {
        const chunk = live.slice(i, i + this.batchSize);
        const found = await this.inner.collection(coll).find({ _id: { $in: chunk.map((r) => r.id) } });
        for (const doc of found) docs.set(String(doc._id), doc);
      }
      for (const rec of list) {
        const fields: Record<string, WireField> = {};
        if (isLive(rec)) {
          const doc = docs.get(rec.id);
          if (!doc) continue; // deleted since capture; the next capture tombstones it
          for (const [name, f] of Object.entries(rec.fields)) {
            fields[name] = f.x
              ? { x: 1, t: f.t, c: f.c }
              : { v: encodeValue(doc[name]), t: f.t, c: f.c };
          }
        }
        out.push({ coll, id: rec.id, scope: rec.scope, fields, vv: rec.vv, ...(rec.del ? { del: rec.del } : {}) });
      }
    }
    return out;
  }

  // --- serving a peer ---------------------------------------------------------------

  service(authorizer?: SyncAuthorizer): SyncService {
    return new SyncService(this, authorizer);
  }

  /** @internal used by SyncService */
  async servePull(from: string, req: PullRequest, authorizer?: SyncAuthorizer): Promise<PullResponse> {
    await this.capture();
    const scopes = authorizer ? await authorizer.readableScopes() : null;
    const sig = scopes ? createHash('sha1').update([...scopes].sort().join('|')).digest('hex').slice(0, 16) : '*';
    const cursor = req.sig === sig ? req.cursor : 0;
    const limit = Math.max(1, Math.min(req.limit, 2000));
    const head = this.meta.seq;
    const { recs, more } = this.meta.since(scopes, cursor, limit, from);
    const docs = await this.toWire(recs);
    const next = more ? recs[recs.length - 1]!.seq : head;
    return { docs, next, more, sig };
  }

  /** @internal used by SyncService */
  async servePush(from: string, req: PushRequest, authorizer?: SyncAuthorizer): Promise<PushResponse> {
    await this.capture();
    let accepted = 0;
    const rejected: PushRejection[] = [];
    const ordered = [...req.docs].sort(
      (a, b) => (COLL_ORDER.get(a.coll) ?? 99) - (COLL_ORDER.get(b.coll) ?? 99)
    );
    for (const wire of ordered) {
      if (!COLL_ORDER.has(wire.coll)) {
        rejected.push({ coll: wire.coll, id: wire.id, reason: 'collection does not replicate' });
        continue;
      }
      const check = authorizer
        ? (merge: MergeOutcome, existing: Doc | null) =>
            authorizer.checkWrite(wire, existing, merge.takeRemote)
        : undefined;
      const result = await this.applyRemote(wire, from, check);
      if (result.rejected) {
        rejected.push({ coll: wire.coll, id: wire.id, reason: result.rejected });
        this.pushLog({
          at: new Date(this.now()).toISOString(),
          kind: 'rejected',
          peerId: from,
          rejection: { coll: wire.coll, id: wire.id, reason: result.rejected },
        });
      } else {
        accepted += 1;
      }
    }
    await this.finishApply();
    return { accepted, rejected };
  }

  // --- syncing with a peer ----------------------------------------------------------

  /**
   * One full reconciliation with a peer: push what it is missing, pull what we are
   * missing, repeat until a round changes nothing locally (merges can create new
   * local content, such as conflict activities, that the peer should also receive).
   */
  async syncWith(transport: SyncTransport): Promise<SyncResult> {
    const started = performance.now();
    const hello = await transport.hello({
      protocol: PROTOCOL_VERSION,
      nodeId: this.nodeId,
      epoch: this.meta.epoch,
    });
    if (hello.protocol !== PROTOCOL_VERSION) {
      throw new Error(`sync protocol mismatch: peer speaks ${hello.protocol}, this build ${PROTOCOL_VERSION}`);
    }
    const peerId = hello.nodeId;
    let cursor = this.meta.peer(peerId);
    if (!cursor || cursor.epoch !== hello.epoch) {
      cursor = { epoch: hello.epoch, pushedSeq: 0, pulledSeq: 0 };
    }

    const result: SyncResult = {
      peerId,
      pulled: 0,
      pushed: 0,
      rejected: [],
      conflicts: 0,
      rounds: 0,
      durationMs: 0,
    };

    await this.capture();
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      result.rounds = round;
      await this.pushTo(transport, peerId, cursor, result);
      await this.pullFrom(transport, peerId, cursor, result);
      cursor.lastSyncedAt = new Date(this.now()).toISOString();
      this.meta.setPeer(peerId, cursor);
      await this.finishApply();
      const stillPending =
        this.meta.countSince(null, cursor.pushedSeq, peerId) > 0 || this.meta.dirtyCount() > 0;
      if (!stillPending) break;
    }

    result.durationMs = performance.now() - started;
    this.pushLog({
      at: new Date(this.now()).toISOString(),
      kind: 'sync',
      peerId,
      pulled: result.pulled,
      pushed: result.pushed,
    });
    return result;
  }

  private async pushTo(
    transport: SyncTransport,
    peerId: string,
    cursor: { pushedSeq: number },
    result: SyncResult
  ): Promise<number> {
    let total = 0;
    for (;;) {
      await this.capture();
      const head = this.meta.seq;
      const { recs, more } = this.meta.since(null, cursor.pushedSeq, this.batchSize, peerId);
      if (recs.length === 0) {
        cursor.pushedSeq = Math.max(cursor.pushedSeq, head);
        return total;
      }
      const docs = await this.toWire(recs);
      if (docs.length > 0) {
        const response = await transport.push({ from: this.nodeId, docs });
        result.pushed += response.accepted;
        total += response.accepted;
        for (const rejection of response.rejected) {
          result.rejected.push(rejection);
          this.pushLog({ at: new Date(this.now()).toISOString(), kind: 'rejected', peerId, rejection });
        }
      }
      cursor.pushedSeq = more ? recs[recs.length - 1]!.seq : Math.max(head, recs[recs.length - 1]!.seq);
      if (!more) return total;
    }
  }

  private async pullFrom(
    transport: SyncTransport,
    peerId: string,
    cursor: { pulledSeq: number; sig?: string },
    result: SyncResult
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const response = await transport.pull({
        from: this.nodeId,
        cursor: cursor.pulledSeq,
        limit: this.batchSize,
        sig: cursor.sig,
      });
      for (const wire of response.docs) {
        const applied = await this.applyRemote(wire, peerId);
        if (applied.applied) {
          result.pulled += 1;
          total += 1;
        }
        result.conflicts += applied.conflicts;
      }
      cursor.pulledSeq = response.next;
      cursor.sig = response.sig;
      if (!response.more) return total;
    }
  }

  // --- status -----------------------------------------------------------------------

  /** Pending-change count, last-sync time and per-peer progress. */
  async status(): Promise<SyncStatus> {
    const peers: PeerStatus[] = this.meta.peers().map(([peerId, cursor]) => ({
      peerId,
      epoch: cursor.epoch,
      pushedSeq: cursor.pushedSeq,
      pulledSeq: cursor.pulledSeq,
      lastSyncedAt: cursor.lastSyncedAt,
      pendingChanges: this.meta.countSince(null, cursor.pushedSeq, peerId),
    }));
    const dirty = this.meta.dirtyCount();
    const pending = peers.length === 0
      ? this.meta.countSince(null, 0) + dirty
      : Math.max(...peers.map((p) => p.pendingChanges)) + dirty;
    const last = peers.map((p) => p.lastSyncedAt).filter(Boolean).sort().pop();
    return {
      nodeId: this.nodeId,
      role: this.role,
      pendingChanges: pending,
      lastSyncedAt: last,
      documents: this.meta.size,
      tombstones: this.meta.tombstoneCount(),
      peers,
    };
  }
}

/** The server side of the protocol; what every listener delegates to. */
export class SyncService {
  constructor(
    private readonly engine: SyncEngine,
    private readonly authorizer?: SyncAuthorizer
  ) {}

  async hello(req: HelloRequest): Promise<HelloResponse> {
    return {
      protocol: PROTOCOL_VERSION,
      nodeId: this.engine.nodeId,
      epoch: this.engine.meta.epoch,
      role: this.engine.role,
      ...(this.authorizer?.userId ? { userId: this.authorizer.userId } : {}),
    };
  }

  pull(req: PullRequest): Promise<PullResponse> {
    return this.engine.servePull(req.from, req, this.authorizer);
  }

  push(req: PushRequest): Promise<PushResponse> {
    return this.engine.servePush(req.from, req, this.authorizer);
  }
}
