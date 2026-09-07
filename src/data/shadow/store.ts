/**
 * Shadow writes: every write goes to both backends, the primary answers.
 *
 * This is stage 2 of the migration. Its job is to put the candidate backend under
 * real production write traffic — the first honest measurement of its commit
 * latency and failure rate — while the primary stays authoritative and the request
 * path is unaffected. It is not yet a correctness comparison; that is stage 3's
 * shadow *reads*, which this stage exists to make meaningful by keeping the two
 * stores holding the same data.
 *
 * Three rules define the behaviour:
 *
 *  1. **Reads never touch the shadow.** Every read is the primary's, unchanged.
 *  2. **The request never waits on the shadow, and never fails because of it.**
 *     Mirrored writes are queued; failures are counted and logged.
 *  3. **Identity is the primary's.** A create mirrors the document the primary
 *     actually stored — its `_id`, its timestamps — rather than re-running the
 *     insert and letting the shadow mint its own. Two stores that disagree about
 *     ids cannot be compared at all, so this is the difference between a shadow
 *     that is worth reading in stage 3 and one that is noise.
 *
 * Everything other than a create replays the same operation against the shadow,
 * because exercising the shadow's own filter and update handling is the point. The
 * known benign consequence is that each store stamps its own `updatedAt`, so those
 * differ by milliseconds; stage 3's comparator has to ignore that field.
 */

import { createLogger } from '../../utils/logger.js';
import { ShadowQueue, type ShadowStats } from './queue.js';
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

class ShadowedCollection<T extends Doc> implements Collection<T> {
  constructor(
    readonly name: CollectionName,
    private readonly primary: Collection<T>,
    private readonly shadow: Collection<T>,
    private readonly queue: ShadowQueue
  ) {}

  // --- reads: primary only -------------------------------------------------------

  find(filter?: Filter, options?: FindOptions): Promise<T[]> {
    return this.primary.find(filter, options);
  }

  findOne(filter: Filter, options?: FindOptions): Promise<T | null> {
    return this.primary.findOne(filter, options);
  }

  findById(id: string, options?: FindOptions): Promise<T | null> {
    return this.primary.findById(id, options);
  }

  countDocuments(filter?: Filter): Promise<number> {
    return this.primary.countDocuments(filter);
  }

  distinct(field: string, filter?: Filter): Promise<unknown[]> {
    return this.primary.distinct(field, filter);
  }

  // --- writes: primary answers, shadow mirrors -----------------------------------

  async create(doc: Doc): Promise<T> {
    const created = await this.primary.create(doc);
    // The stored document, not the input: it carries the id and timestamps the
    // primary assigned, which is what keeps the two stores addressable alike.
    this.mirror('create', () => this.shadow.create(created));
    return created;
  }

  async insertMany(docs: Doc[]): Promise<T[]> {
    const created = await this.primary.insertMany(docs);
    this.mirror('insertMany', () => this.shadow.insertMany(created));
    return created;
  }

  async updateOne(filter: Filter, update: Update, options?: UpdateOptions): Promise<UpdateResult> {
    const result = await this.primary.updateOne(filter, update, options);
    this.mirror('updateOne', () => this.shadow.updateOne(filter, update, options));
    return result;
  }

  async updateMany(filter: Filter, update: Update): Promise<UpdateResult> {
    const result = await this.primary.updateMany(filter, update);
    this.mirror('updateMany', () => this.shadow.updateMany(filter, update));
    return result;
  }

  async findOneAndUpdate(filter: Filter, update: Update, options?: UpdateOptions): Promise<T | null> {
    const result = await this.primary.findOneAndUpdate(filter, update, options);
    // An upsert that created a document has to carry the primary's id across, or the
    // two stores hold the same row under different identities from then on.
    if (result && options?.upsert) {
      const upserted = result;
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
    this.mirror('findOneAndUpdate', () => this.shadow.findOneAndUpdate(filter, update, options));
    return result;
  }

  async findByIdAndUpdate(id: string, update: Update, options?: UpdateOptions): Promise<T | null> {
    const result = await this.primary.findByIdAndUpdate(id, update, options);
    this.mirror('findByIdAndUpdate', () => this.shadow.findByIdAndUpdate(id, update, options));
    return result;
  }

  async replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult> {
    const result = await this.primary.replaceOne(filter, doc);
    this.mirror('replaceOne', () => this.shadow.replaceOne(filter, doc));
    return result;
  }

  async deleteOne(filter: Filter): Promise<DeleteResult> {
    const result = await this.primary.deleteOne(filter);
    this.mirror('deleteOne', () => this.shadow.deleteOne(filter));
    return result;
  }

  async deleteMany(filter: Filter): Promise<DeleteResult> {
    const result = await this.primary.deleteMany(filter);
    this.mirror('deleteMany', () => this.shadow.deleteMany(filter));
    return result;
  }

  async findOneAndDelete(filter: Filter): Promise<T | null> {
    const result = await this.primary.findOneAndDelete(filter);
    this.mirror('findOneAndDelete', () => this.shadow.findOneAndDelete(filter));
    return result;
  }

  async bulkWrite(operations: BulkOperation[]): Promise<UpdateResult> {
    const result = await this.primary.bulkWrite(operations);
    this.mirror('bulkWrite', () => this.shadow.bulkWrite(operations));
    return result;
  }

  private mirror(operation: string, run: () => Promise<unknown>): void {
    this.queue.push(`${this.name}.${operation}`, run);
  }
}

export class ShadowDataStore implements DataStore {
  private readonly collections = new Map<CollectionName, Collection<Doc>>();
  private readonly queue: ShadowQueue;

  constructor(
    private readonly primary: DataStore,
    private readonly shadow: DataStore,
    maxPending?: number
  ) {
    this.queue = new ShadowQueue(maxPending);
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

  collection<T extends Doc = Doc>(name: CollectionName): Collection<T> {
    const existing = this.collections.get(name);
    if (existing) return existing as Collection<T>;

    const collection = new ShadowedCollection<T>(
      name,
      this.primary.collection<T>(name),
      this.shadow.collection<T>(name),
      this.queue
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
}

/** Thrown when the shadow cannot be opened, so the caller can fall back to the
 *  primary alone rather than failing startup. */
export class ShadowUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('shadow backend unavailable');
    this.name = 'ShadowUnavailableError';
  }
}
