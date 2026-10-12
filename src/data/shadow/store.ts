/**
 * Shadow writes and shadow reads: stages 2 and 3 of the backend migration.
 *
 * **Stage 2 (`DATA_SHADOW_WRITES`)** mirrors every write to the other backend. Its
 * job is to put the candidate under real production write traffic — an honest
 * measurement of its commit latency and failure rate — and to keep the two stores
 * holding the same data, which is what makes stage 3 possible at all.
 *
 * **Stage 3 (`DATA_SHADOW_READS`)** asks the shadow the same questions and reports
 * where the answers differ. The primary still serves every request, so a divergence
 * is a bug report rather than an incident. This is the evidence the migration
 * actually turns on: a backend that answers identically for a full bake period has
 * earned a read flip, and one that does not has told you why in the logs.
 *
 * Four rules define the behaviour:
 *
 *  1. **The primary answers everything.** Its result is what the caller gets, on
 *     every read and every write, whatever the shadow says or does.
 *  2. **The request never waits on the shadow, and never fails because of it.**
 *     Mirrored writes and read comparisons are queued; failures are counted and
 *     logged. A shadow that will not connect at all degrades to the primary alone.
 *  3. **Identity is the primary's.** A create mirrors the document the primary
 *     actually stored — its `_id`, its timestamps — rather than re-running the
 *     insert and letting the shadow mint its own. Two stores that disagree about
 *     ids cannot be compared at all.
 *  4. **Comparisons run at the equivalent point in the shadow's timeline.** Reads
 *     are compared on the same serial queue as writes, so a comparison only runs
 *     once every write issued before it has landed. Without that, ordinary queue
 *     lag would be reported as divergence on every read following a write.
 *
 * Everything other than a create replays the same operation against the shadow,
 * because exercising the shadow's own filter and update handling is the point. The
 * known benign consequence is that each store stamps its own `updatedAt`, which is
 * why compare.ts ignores that field and nothing else.
 */

import { createLogger } from '../../utils/logger.js';
import { ShadowQueue, type ShadowStats } from './queue.js';
import {
  compareCounts,
  compareDocLists,
  compareDocs,
  compareValueSets,
  queryIsOrdered,
  type Divergence,
} from './compare.js';
import type {
  BulkOperation,
  Collection,
  CollectionName,
  DataStore,
  DeleteResult,
  Doc,
  Filter,
  FindOptions,
  Update,
  UpdateOptions,
  UpdateResult,
} from '../types.js';

const log = createLogger('data:shadow');

/**
 * A private copy of anything the shadow will look at later.
 *
 * Mirrored writes and read comparisons run out of band, some time after the call returned, and
 * callers own what they pass in and what they get back: the application routinely reads a
 * document, mutates it (`user.emailVerified = true`) and passes it to `replaceOne`. A queued
 * comparison holding the caller's object would compare the shadow with the caller's *edited*
 * copy, and a queued write would replay a later edit than the one the primary applied - both
 * reported as divergence that is really aliasing. Snapshot at the call, replay the snapshot.
 */
function snap<V>(value: V): V {
  return value === undefined || value === null ? value : structuredClone(value);
}

class ShadowedCollection<T extends Doc> implements Collection<T> {
  constructor(
    readonly name: CollectionName,
    private readonly primary: Collection<T>,
    private readonly shadow: Collection<T>,
    private readonly queue: ShadowQueue,
    private readonly reads: ReadComparison | undefined
  ) {}

  // --- reads: the primary answers; the shadow is asked afterwards, out of band ----

  async find(filter: Filter = {}, options: FindOptions = {}): Promise<T[]> {
    const result = await this.primary.find(filter, options);
    const seen = snap(result);
    const query = snap({ filter, options });
    this.compare('find', query, async () =>
      compareDocLists(this.name, 'find', query, seen, await this.shadow.find(query.filter, query.options), queryIsOrdered(query.options))
    );
    return result;
  }

  async findOne(filter: Filter, options: FindOptions = {}): Promise<T | null> {
    const result = await this.primary.findOne(filter, options);
    const seen = snap(result);
    const query = snap({ filter, options });
    this.compare('findOne', query, async () =>
      compareDocs(this.name, 'findOne', query, seen, await this.shadow.findOne(query.filter, query.options))
    );
    return result;
  }

  async findById(id: string, options: FindOptions = {}): Promise<T | null> {
    const result = await this.primary.findById(id, options);
    const seen = snap(result);
    const query = snap({ id, options });
    this.compare('findById', query, async () =>
      compareDocs(this.name, 'findById', query, seen, await this.shadow.findById(query.id, query.options))
    );
    return result;
  }

  async countDocuments(filter: Filter = {}): Promise<number> {
    const result = await this.primary.countDocuments(filter);
    const query = snap({ filter });
    this.compare('countDocuments', query, async () =>
      compareCounts(this.name, 'countDocuments', query, result, await this.shadow.countDocuments(query.filter))
    );
    return result;
  }

  async distinct(field: string, filter: Filter = {}): Promise<unknown[]> {
    const result = await this.primary.distinct(field, filter);
    const seen = snap(result);
    const query = snap({ field, filter });
    this.compare('distinct', query, async () =>
      compareValueSets(this.name, 'distinct', query, seen, await this.shadow.distinct(query.field, query.filter))
    );
    return result;
  }

  /**
   * Queues a comparison of one read.
   *
   * It goes onto the *same* serial queue as mirrored writes, and that is the whole
   * trick. The shadow lags the primary by whatever is still queued, so comparing
   * against it directly would report that lag as divergence on every read that
   * follows a write. Enqueueing here means the comparison runs only once every
   * write issued before this read has been applied — the equivalent point in the
   * shadow's own timeline — so what is left is real disagreement.
   */
  private compare(
    operation: string,
    query: unknown,
    run: () => Promise<Divergence | null>
  ): void {
    const reads = this.reads;
    if (!reads || !reads.shouldSample()) return;
    this.queue.push(`${this.name}.${operation}:compare`, async () => {
      reads.record(await run());
    });
  }

  // --- writes: primary answers, shadow mirrors -----------------------------------

  async create(doc: Doc): Promise<T> {
    const created = await this.primary.create(doc);
    // The stored document, not the input: it carries the id and timestamps the
    // primary assigned, which is what keeps the two stores addressable alike.
    const replay = snap(created);
    this.mirror('create', () => this.shadow.create(replay));
    return created;
  }

  async insertMany(docs: Doc[]): Promise<T[]> {
    const created = await this.primary.insertMany(docs);
    const replay = snap(created);
    this.mirror('insertMany', () => this.shadow.insertMany(replay));
    return created;
  }

  async updateOne(filter: Filter, update: Update, options?: UpdateOptions): Promise<UpdateResult> {
    const args = snap({ filter, update, options });
    const result = await this.primary.updateOne(filter, update, options);
    if (result.upsertedId) {
      // The primary created this document and gave it an id. Replaying the upsert would make the
      // shadow mint a different one, leaving the same row under two identities for good.
      //
      // Queued at once and read when it runs, not read here first: awaiting before queueing lets
      // a later write to the same key reach the queue ahead of this one, and the shadow then
      // creates the row under a new id before this copy arrives and collides with it.
      const id = result.upsertedId;
      this.mirror('updateOne:upsert', async () => {
        const created = await this.primary.findById(id);
        if (created) await this.copyAcross(created);
      });
      return result;
    }
    this.mirror('updateOne', () => this.shadow.updateOne(args.filter, args.update, args.options));
    return result;
  }

  async updateMany(filter: Filter, update: Update): Promise<UpdateResult> {
    const args = snap({ filter, update });
    const result = await this.primary.updateMany(filter, update);
    this.mirror('updateMany', () => this.shadow.updateMany(args.filter, args.update));
    return result;
  }

  async findOneAndUpdate(filter: Filter, update: Update, options?: UpdateOptions): Promise<T | null> {
    const args = snap({ filter, update, options });
    const result = await this.primary.findOneAndUpdate(filter, update, options);
    // An upsert that created a document has to carry the primary's id across, or the
    // two stores hold the same row under different identities from then on.
    if (result && options?.upsert) {
      const upserted = snap(result);
      this.mirror('findOneAndUpdate:upsert', async () => {
        const existing = await this.shadow.findById(String(upserted._id));
        if (existing) {
          await this.shadow.replaceOne({ _id: upserted._id }, upserted);
        } else {
          await this.shadow.create(upserted);
        }
      });
      return result;
    }
    this.mirror('findOneAndUpdate', () => this.shadow.findOneAndUpdate(args.filter, args.update, args.options));
    return result;
  }

  async findByIdAndUpdate(id: string, update: Update, options?: UpdateOptions): Promise<T | null> {
    const args = snap({ update, options });
    const result = await this.primary.findByIdAndUpdate(id, update, options);
    this.mirror('findByIdAndUpdate', () => this.shadow.findByIdAndUpdate(id, args.update, args.options));
    return result;
  }

  async replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult> {
    const args = snap({ filter, doc });
    const result = await this.primary.replaceOne(filter, doc);
    this.mirror('replaceOne', () => this.shadow.replaceOne(args.filter, args.doc));
    return result;
  }

  async deleteOne(filter: Filter): Promise<DeleteResult> {
    const replay = snap(filter);
    const result = await this.primary.deleteOne(filter);
    this.mirror('deleteOne', () => this.shadow.deleteOne(replay));
    return result;
  }

  async deleteMany(filter: Filter): Promise<DeleteResult> {
    const replay = snap(filter);
    const result = await this.primary.deleteMany(filter);
    this.mirror('deleteMany', () => this.shadow.deleteMany(replay));
    return result;
  }

  async findOneAndDelete(filter: Filter): Promise<T | null> {
    const replay = snap(filter);
    const result = await this.primary.findOneAndDelete(filter);
    this.mirror('findOneAndDelete', () => this.shadow.findOneAndDelete(replay));
    return result;
  }

  async bulkWrite(operations: BulkOperation[]): Promise<UpdateResult> {
    const replay = snap(operations);
    const result = await this.primary.bulkWrite(operations);
    // An upsert may have created documents, and replaying it would mint different ids on the
    // shadow. Those operations are mirrored by copying the primary's resulting document; the
    // rest are replayed as written.
    const plain = replay.filter((op) => !op.updateOne.upsert);
    const upserts = replay.filter((op) => op.updateOne.upsert);
    if (plain.length > 0) this.mirror('bulkWrite', () => this.shadow.bulkWrite(plain));
    for (const op of upserts) {
      const filter = op.updateOne.filter;
      // Queued now, read when it runs (see updateOne): the order of the queue is the order of the
      // calls, and a read made before queueing would let a later write overtake it.
      this.mirror('bulkWrite:upsert', async () => {
        const current = await this.primary.findOne(filter);
        if (current) await this.copyAcross(current);
      });
    }
    return result;
  }

  /** Makes the shadow hold exactly this document, creating it under the primary's id if absent. */
  private async copyAcross(doc: T): Promise<void> {
    const existing = await this.shadow.findById(String(doc._id));
    if (existing) await this.shadow.replaceOne({ _id: doc._id }, doc);
    else await this.shadow.create(doc);
  }

  private mirror(operation: string, run: () => Promise<unknown>): void {
    this.queue.push(`${this.name}.${operation}`, run);
  }
}

export interface ReadComparisonStats {
  compared: number;
  matched: number;
  /** Real disagreements. This is the number a bake gates on. */
  diverged: number;
  /**
   * Same documents, different order, for a query that asked for no order. Not a
   * disagreement — Mongo's natural order is not a promise — but a caller relying on
   * it would still behave differently after a flip, so it is counted apart rather
   * than swept in with `matched`.
   */
  unordered: number;
  /** Divergences seen, by kind, so a bake can be read at a glance. */
  byKind: Record<string, number>;
  lastDivergence?: Divergence;
}

/**
 * Runs and accounts for read comparisons. Owned by the store rather than by each
 * collection so the counters describe the deployment, not one table.
 */
class ReadComparison {
  private compared = 0;
  private matched = 0;
  private diverged = 0;
  private unordered = 0;
  private readonly byKind: Record<string, number> = {};
  private lastDivergence: Divergence | undefined;

  constructor(private readonly sampleRate: number) {}

  shouldSample(): boolean {
    if (this.sampleRate >= 1) return true;
    if (this.sampleRate <= 0) return false;
    return Math.random() < this.sampleRate;
  }

  record(divergence: Divergence | null): void {
    this.compared++;
    if (!divergence) {
      this.matched++;
      return;
    }
    this.byKind[divergence.kind] = (this.byKind[divergence.kind] ?? 0) + 1;
    this.lastDivergence = divergence;

    if (divergence.kind === 'unordered') {
      this.unordered++;
      log.info('shadow read returned the same documents in a different order', {
        collection: divergence.collection,
        operation: divergence.operation,
        summary: divergence.summary,
      });
      return;
    }

    this.diverged++;
    // Warn, not error: the primary answered the request correctly and nobody was
    // affected. This is a bug report, which is exactly what stage 3 is for.
    log.warn('shadow read diverged', {
      collection: divergence.collection,
      operation: divergence.operation,
      kind: divergence.kind,
      summary: divergence.summary,
      ids: divergence.ids,
      fields: divergence.fields,
    });
  }

  stats(): ReadComparisonStats {
    return {
      compared: this.compared,
      matched: this.matched,
      diverged: this.diverged,
      unordered: this.unordered,
      byKind: { ...this.byKind },
      lastDivergence: this.lastDivergence,
    };
  }
}

export class ShadowDataStore implements DataStore {
  private readonly collections = new Map<CollectionName, Collection<Doc>>();
  private readonly queue: ShadowQueue;

  private readonly reads: ReadComparison | undefined;

  constructor(
    private readonly primary: DataStore,
    private readonly shadow: DataStore,
    options: { maxPending?: number; compareReads?: boolean; readSampleRate?: number } = {}
  ) {
    this.queue = new ShadowQueue(options.maxPending);
    this.reads = options.compareReads
      ? new ReadComparison(options.readSampleRate ?? 1)
      : undefined;
  }

  /** The backend that answers. Callers asking "what am I reading from" get the truth. */
  get backend(): 'mongo' | 'kdb' {
    return this.primary.backend;
  }

  get shadowBackend(): 'mongo' | 'kdb' {
    return this.shadow.backend;
  }

  async connect(): Promise<void> {
    await this.primary.connect();
    try {
      await this.shadow.connect();
    } catch (error) {
      // A shadow that will not open must not stop the service starting. It is an
      // evaluation aid, and the whole design says the request path does not depend
      // on it — that has to hold at startup too, not only per write.
      log.error('shadow backend failed to connect; continuing without mirroring', {
        backend: this.shadow.backend,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ShadowUnavailableError(error);
    }
  }

  async disconnect(): Promise<void> {
    // Drain first: a queued write that never landed is a divergence that would be
    // blamed on the backend at the next comparison.
    await this.queue.drain();
    await Promise.allSettled([this.primary.disconnect(), this.shadow.disconnect()]);
  }

  /** Health is the primary's: it serves every request, and the shadow is allowed to be down. */
  async ping(): Promise<void> {
    await this.primary.ping();
  }

  collection<T extends Doc = Doc>(name: CollectionName): Collection<T> {
    const existing = this.collections.get(name);
    if (existing) return existing as Collection<T>;

    const collection = new ShadowedCollection<T>(
      name,
      this.primary.collection<T>(name),
      this.shadow.collection<T>(name),
      this.queue,
      this.reads
    );
    this.collections.set(name, collection as unknown as Collection<Doc>);
    return collection;
  }

  async clear(): Promise<void> {
    await this.queue.drain();
    await Promise.all([this.primary.clear(), this.shadow.clear()]);
  }

  /** Applies everything queued so far. Tests await this; shutdown goes through it. */
  drainShadow(): Promise<void> {
    return this.queue.drain();
  }

  stats(): ShadowStats {
    return this.queue.stats();
  }

  /** Read-comparison counters, or undefined when reads are not being compared. */
  readStats(): ReadComparisonStats | undefined {
    return this.reads?.stats();
  }
}

/** Thrown when the shadow cannot be opened, so the caller can fall back to the
 *  primary alone rather than failing startup. */
export class ShadowUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('shadow backend unavailable');
    this.name = 'ShadowUnavailableError';
  }
}
