/**
 * An in-memory `DataStore`. It exists for the sync engine's tests and benchmarks,
 * where booting Mongo or kdb-service per peer would dominate the measurement, and as
 * a reference implementation of the contract built on the same query helpers KDB
 * uses. It enforces no schema: documents are stored as given, plus `_id`,
 * `createdAt` and `updatedAt`.
 *
 * Lookups by `_id` (a string or `{ $in: [...] }`) are indexed; every other filter is
 * a scan, as it is on KDB.
 */

import { randomBytes } from 'node:crypto';
import { applySort, applyProjection } from '../query/shape.js';
import { matchesFilter } from '../query/filter.js';
import { applyUpdate, isOperatorUpdate, structuredCloneDoc } from '../query/update.js';
import { getPath } from '../query/paths.js';
import { valuesEqual } from '../query/compare.js';
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

let counter = randomBytes(3).readUIntBE(0, 3);
const processRandom = randomBytes(5);

function newId(): string {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
  processRandom.copy(buffer, 4);
  counter = (counter + 1) % 0xffffff;
  buffer.writeUIntBE(counter, 9, 3);
  return buffer.toString('hex');
}

class MemoryCollection<T extends Doc> implements Collection<T> {
  readonly docs = new Map<string, Doc>();

  constructor(readonly name: CollectionName) {}

  private candidates(filter: Filter): { docs: Doc[]; exact: boolean } {
    const keys = Object.keys(filter);
    if (keys.length === 1 && keys[0] === '_id') {
      const cond = filter._id;
      if (typeof cond === 'string') {
        const doc = this.docs.get(cond);
        return { docs: doc ? [doc] : [], exact: true };
      }
      if (cond && typeof cond === 'object' && Array.isArray((cond as { $in?: unknown }).$in)) {
        const inKeys = Object.keys(cond as object);
        if (inKeys.length === 1) {
          const out: Doc[] = [];
          for (const id of (cond as { $in: unknown[] }).$in) {
            const doc = typeof id === 'string' ? this.docs.get(id) : undefined;
            if (doc) out.push(doc);
          }
          return { docs: out, exact: true };
        }
      }
    }
    return { docs: [...this.docs.values()], exact: false };
  }

  private match(filter: Filter): Doc[] {
    const { docs, exact } = this.candidates(filter);
    return exact ? docs : docs.filter((doc) => matchesFilter(doc, filter));
  }

  async find(filter: Filter = {}, options: FindOptions = {}): Promise<T[]> {
    let docs = this.match(filter);
    docs = applySort(docs, options.sort);
    if (options.skip !== undefined) docs = docs.slice(options.skip);
    if (options.limit !== undefined) docs = docs.slice(0, options.limit);
    return docs.map((doc) =>
      structuredCloneDoc(options.select ? applyProjection(doc, options.select) : doc)
    ) as T[];
  }

  async findOne(filter: Filter, options: FindOptions = {}): Promise<T | null> {
    const [first] = await this.find(filter, { ...options, limit: 1 });
    return first ?? null;
  }

  async findById(id: string, options: FindOptions = {}): Promise<T | null> {
    return this.findOne({ _id: id }, options);
  }

  async countDocuments(filter: Filter = {}): Promise<number> {
    return this.match(filter).length;
  }

  async distinct(field: string, filter: Filter = {}): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const doc of this.match(filter)) {
      const value = getPath(doc, field);
      for (const candidate of Array.isArray(value) ? value : [value]) {
        if (candidate === undefined) continue;
        if (!out.some((existing) => valuesEqual(existing, candidate))) out.push(candidate);
      }
    }
    return out;
  }

  private insert(input: Doc): Doc {
    const doc = structuredCloneDoc(input);
    if (doc._id === undefined) doc._id = newId();
    const id = String(doc._id);
    doc._id = id;
    if (this.docs.has(id)) throw new Error(`${this.name}: duplicate _id ${id}`);
    const now = new Date();
    if (doc.createdAt === undefined) doc.createdAt = now;
    doc.updatedAt = now;
    this.docs.set(id, doc);
    return doc;
  }

  async create(doc: Doc): Promise<T> {
    return structuredCloneDoc(this.insert(doc)) as T;
  }

  async insertMany(docs: Doc[]): Promise<T[]> {
    return docs.map((doc) => structuredCloneDoc(this.insert(doc)) as T);
  }

  private write(target: Doc, next: Doc): boolean {
    const before = JSON.stringify(target);
    next._id = target._id;
    next.createdAt = target.createdAt ?? next.createdAt;
    if (JSON.stringify({ ...next, updatedAt: target.updatedAt }) === before) return false;
    next.updatedAt = new Date();
    this.docs.set(String(target._id), next);
    return true;
  }

  private upsertFrom(filter: Filter, update: Update): Doc {
    const seed: Doc = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key.startsWith('$')) continue;
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) continue;
      seed[key] = value;
    }
    return this.insert(applyUpdate(seed, update, true));
  }

  async updateOne(filter: Filter, update: Update, options: UpdateOptions = {}): Promise<UpdateResult> {
    const [target] = applySort(this.match(filter), options.sort);
    if (!target) {
      if (!options.upsert) return { matched: 0, modified: 0 };
      const created = this.upsertFrom(filter, update);
      return { matched: 0, modified: 0, upsertedId: String(created._id) };
    }
    const modified = this.write(target, applyUpdate(target, update));
    return { matched: 1, modified: modified ? 1 : 0 };
  }

  async updateMany(filter: Filter, update: Update): Promise<UpdateResult> {
    const targets = this.match(filter);
    let modified = 0;
    for (const target of targets) if (this.write(target, applyUpdate(target, update))) modified++;
    return { matched: targets.length, modified };
  }

  async findOneAndUpdate(filter: Filter, update: Update, options: UpdateOptions = {}): Promise<T | null> {
    const [target] = applySort(this.match(filter), options.sort);
    if (!target) {
      if (!options.upsert) return null;
      const created = this.upsertFrom(filter, update);
      return options.returnDocument === 'before' ? null : (structuredCloneDoc(created) as T);
    }
    const before = structuredCloneDoc(target);
    this.write(target, applyUpdate(target, update));
    const after = this.docs.get(String(target._id))!;
    return structuredCloneDoc(options.returnDocument === 'before' ? before : after) as T;
  }

  async findByIdAndUpdate(id: string, update: Update, options: UpdateOptions = {}): Promise<T | null> {
    return this.findOneAndUpdate({ _id: id }, update, options);
  }

  async replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult> {
    const [target] = this.match(filter);
    if (!target) return { matched: 0, modified: 0 };
    const { _id: _ignored, ...body } = doc;
    const next = structuredCloneDoc(body) as Doc;
    this.write(target, next);
    return { matched: 1, modified: 1 };
  }

  async deleteOne(filter: Filter): Promise<DeleteResult> {
    const [target] = this.match(filter);
    if (!target) return { deleted: 0 };
    this.docs.delete(String(target._id));
    return { deleted: 1 };
  }

  async deleteMany(filter: Filter): Promise<DeleteResult> {
    const targets = this.match(filter);
    for (const target of targets) this.docs.delete(String(target._id));
    return { deleted: targets.length };
  }

  async findOneAndDelete(filter: Filter): Promise<T | null> {
    const [target] = this.match(filter);
    if (!target) return null;
    this.docs.delete(String(target._id));
    return structuredCloneDoc(target) as T;
  }

  async bulkWrite(operations: BulkOperation[]): Promise<UpdateResult> {
    let matched = 0;
    let modified = 0;
    for (const { updateOne } of operations) {
      const result = await this.updateOne(updateOne.filter, updateOne.update, { upsert: updateOne.upsert });
      matched += result.matched;
      modified += result.modified;
    }
    return { matched, modified };
  }
}

export class MemoryDataStore implements DataStore {
  readonly backend = 'memory' as const;
  private readonly collections = new Map<CollectionName, MemoryCollection<Doc>>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  /** Always answers: the data is in this process. */
  async ping(): Promise<void> {}

  collection<T extends Doc = Doc>(name: CollectionName): Collection<T> {
    let existing = this.collections.get(name);
    if (!existing) {
      existing = new MemoryCollection<Doc>(name);
      this.collections.set(name, existing);
    }
    return existing as unknown as Collection<T>;
  }

  async clear(): Promise<void> {
    this.collections.clear();
  }

  /** Test support: documents currently stored in a collection. */
  count(name: CollectionName): number {
    return this.collections.get(name)?.docs.size ?? 0;
  }
}
