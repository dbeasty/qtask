/**
 * The change-tracking layer: a `DataStore` decorator that notes which replicated
 * documents a write touched, without changing what the write does.
 *
 * It records *that* a document changed, never *what* changed. The engine's
 * `capture()` later reads the current document and diffs it against the sync record
 * by content hash, so correctness does not depend on this layer understanding every
 * update operator, and a missed mark (a crash, a write that bypassed the wrapper)
 * is repaired by `reconcile()` rather than lost.
 *
 * Deletes are the case that needs care. A document that is gone cannot be diffed, so
 * the ids a delete will remove are looked up first and marked dirty; capture then
 * finds the document missing and writes a tombstone to the sync record. Services keep
 * calling `deleteOne` / `deleteMany` / `findOneAndDelete` as before, including the
 * cascades in taskService / projectService, and every one becomes a tombstone.
 */

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
} from '../data/types.js';
import { recKey, type MetaStore } from './meta.js';
import { isReplicated } from './policy.js';

/** Marks every document of a collection for re-examination (a write whose targets are unknowable). */
export const ALL_MARK = '*';

function directId(filter: Filter): string | undefined {
  const id = filter._id;
  return typeof id === 'string' ? id : undefined;
}

class TrackedCollection<T extends Doc> implements Collection<T> {
  readonly name: CollectionName;

  constructor(
    private readonly inner: Collection<T>,
    private readonly meta: MetaStore,
    private readonly replicated: boolean
  ) {
    this.name = inner.name as CollectionName;
  }

  private mark(id: unknown): void {
    if (this.replicated && typeof id === 'string') this.meta.markDirty(recKey(this.name, id));
  }

  private markAll(): void {
    if (this.replicated) this.meta.markDirty(`${ALL_MARK}:${this.name}`);
  }

  private async targets(filter: Filter, sort?: FindOptions['sort'], one = false): Promise<string[]> {
    const id = directId(filter);
    if (id !== undefined && Object.keys(filter).length === 1) return [id];
    const options: FindOptions = { select: '_id' };
    if (sort) options.sort = sort;
    if (one) options.limit = 1;
    const docs = await this.inner.find(filter, options);
    return docs.map((doc) => String(doc._id));
  }

  find(filter?: Filter, options?: FindOptions) {
    return this.inner.find(filter, options);
  }
  findOne(filter: Filter, options?: FindOptions) {
    return this.inner.findOne(filter, options);
  }
  findById(id: string, options?: FindOptions) {
    return this.inner.findById(id, options);
  }
  countDocuments(filter?: Filter) {
    return this.inner.countDocuments(filter);
  }
  distinct(field: string, filter?: Filter) {
    return this.inner.distinct(field, filter);
  }

  async create(doc: Doc): Promise<T> {
    const created = await this.inner.create(doc);
    this.mark(created._id);
    return created;
  }

  async insertMany(docs: Doc[]): Promise<T[]> {
    const created = await this.inner.insertMany(docs);
    for (const doc of created) this.mark(doc._id);
    return created;
  }

  async updateOne(filter: Filter, update: Update, options?: UpdateOptions): Promise<UpdateResult> {
    const before = this.replicated ? await this.targets(filter, options?.sort, true) : [];
    const result = await this.inner.updateOne(filter, update, options);
    for (const id of before) this.mark(id);
    this.mark(result.upsertedId);
    return result;
  }

  async updateMany(filter: Filter, update: Update): Promise<UpdateResult> {
    const before = this.replicated ? await this.targets(filter) : [];
    const result = await this.inner.updateMany(filter, update);
    for (const id of before) this.mark(id);
    return result;
  }

  async findOneAndUpdate(filter: Filter, update: Update, options?: UpdateOptions): Promise<T | null> {
    const before = this.replicated && !directId(filter) ? await this.targets(filter, options?.sort, true) : [];
    const doc = await this.inner.findOneAndUpdate(filter, update, options);
    for (const id of before) this.mark(id);
    const direct = directId(filter);
    if (direct) this.mark(direct);
    if (doc) this.mark(doc._id);
    else if (options?.upsert) this.markAll();
    return doc;
  }

  async findByIdAndUpdate(id: string, update: Update, options?: UpdateOptions): Promise<T | null> {
    const doc = await this.inner.findByIdAndUpdate(id, update, options);
    this.mark(id);
    return doc;
  }

  async replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult> {
    const before = this.replicated ? await this.targets(filter, undefined, true) : [];
    const result = await this.inner.replaceOne(filter, doc);
    for (const id of before) this.mark(id);
    return result;
  }

  async deleteOne(filter: Filter): Promise<DeleteResult> {
    const before = this.replicated ? await this.targets(filter, undefined, true) : [];
    const result = await this.inner.deleteOne(filter);
    for (const id of before) this.mark(id);
    return result;
  }

  async deleteMany(filter: Filter): Promise<DeleteResult> {
    const before = this.replicated ? await this.targets(filter) : [];
    const result = await this.inner.deleteMany(filter);
    for (const id of before) this.mark(id);
    return result;
  }

  async findOneAndDelete(filter: Filter): Promise<T | null> {
    const doc = await this.inner.findOneAndDelete(filter);
    if (doc) this.mark(doc._id);
    return doc;
  }

  async bulkWrite(operations: BulkOperation[]): Promise<UpdateResult> {
    const before: string[] = [];
    if (this.replicated) {
      for (const operation of operations) {
        const { filter, upsert } = operation.updateOne;
        const ids = await this.targets(filter, undefined, true);
        before.push(...ids);
        if (upsert && ids.length === 0) this.markAll();
      }
    }
    const result = await this.inner.bulkWrite(operations);
    for (const id of before) this.mark(id);
    return result;
  }
}

export class SyncDataStore implements DataStore {
  private readonly cache = new Map<CollectionName, Collection<Doc>>();

  constructor(
    readonly inner: DataStore,
    readonly meta: MetaStore
  ) {}

  get backend(): 'mongo' | 'kdb' | 'memory' {
    return this.inner.backend;
  }

  connect(): Promise<void> {
    return this.inner.connect();
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  collection<T extends Doc = Doc>(name: CollectionName): Collection<T> {
    const cached = this.cache.get(name);
    if (cached) return cached as unknown as Collection<T>;
    const tracked = new TrackedCollection<Doc>(this.inner.collection<Doc>(name), this.meta, isReplicated(name));
    this.cache.set(name, tracked);
    return tracked as unknown as Collection<T>;
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }
}
