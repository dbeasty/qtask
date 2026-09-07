/**
 * The KDB backend.
 *
 * KDB is a document store with a SQL layer over declared fields. This store uses it
 * as the former: documents go in whole through `UPSERT`, come out whole through
 * `SELECT kdb_id, _doc`, and every filter, sort and projection is applied in process
 * by the shared query engine — the same engine checked against a real mongod in
 * tests/data-query-parity.test.ts. Pushing predicates into KDB SQL is a later,
 * separately-flagged step (`DATA_KDB_PUSHDOWN`); doing it now would mean debugging
 * two translation layers at once.
 *
 * Three KDB behaviours shape the code below, all of them verified against a running
 * server rather than assumed:
 *
 *  - A write is a shallow root-level *merge*, so no write path can remove a top-level
 *    key. Removal is therefore delete-then-write, and only when a key actually went
 *    away — see writeDocument.
 *  - The client has no delete operation at all; deletes go through SQL `DELETE`.
 *  - Document ids are UUIDs. The application's ObjectId-shaped ids are mapped in
 *    ids.ts rather than replaced.
 *  - `kdb-service` opens exactly one runtime, for its `--namespace`, and every
 *    namespace a client names resolves to that same store — the ServerRuntimeRegistry
 *    that would give one process several namespaces is not wired into the binary. So
 *    collections cannot be separated by namespace, and each document carries a `_c`
 *    discriminator instead. It is a stored field rather than a client-side filter so
 *    the server can do the narrowing: an undeclared column now resolves out of the
 *    document, which makes `WHERE _c = ?` a real predicate rather than a full scan
 *    dragged across the wire.
 */

import mongoose, { type Schema } from 'mongoose';
import { config } from '../../config/index.js';
import { matchesFilter } from '../query/filter.js';
import { applyUpdate, isOperatorUpdate, structuredCloneDoc } from '../query/update.js';
import { applyProjection, applySort } from '../query/shape.js';
import { valuesEqual } from '../query/compare.js';
import { getPath } from '../query/paths.js';
import { generateObjectId, toDocumentUuid } from './ids.js';
import { normalizeDocument, touchUpdatedAt, uniqueConstraints, ValidationError } from './schema.js';
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

/** The minimum of `@kdb/client` this store depends on. Declared here so the adapter
 *  boundary is explicit and the module can be loaded dynamically. */
interface KdbClient {
  upsert(ns: string, docId: string, body: unknown): Promise<string>;
  queryRaw(ns: string, sql: string, args?: unknown[]): Promise<{ columns: string[]; rows: string[][] }>;
  exec(ns: string, sql: string, args?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

type ConnectFn = (addr: string, token: string) => Promise<KdbClient>;

const MODEL_BY_COLLECTION: Record<CollectionName, string> = {
  users: 'User',
  tasks: 'Task',
  projects: 'Project',
  comments: 'Comment',
  activities: 'Activity',
  conversations: 'Conversation',
  notifications: 'Notification',
  invites: 'Invite',
  feedback: 'Feedback',
  feedbackVisionJobs: 'FeedbackVisionJob',
  embeddingJobs: 'EmbeddingJob',
  llmCallMetrics: 'LlmCallMetric',
  llmDailyMetrics: 'LlmDailyMetric',
  adminAudits: 'AdminAudit',
  mcpApiKeys: 'McpApiKey',
  mcpSessions: 'McpSession',
  mcpOAuthClients: 'McpOAuthClient',
  mcpOAuthAuthorizationCodes: 'McpOAuthAuthorizationCode',
  mcpOAuthRefreshTokens: 'McpOAuthRefreshToken',
  mcpOAuthPendingConsents: 'McpOAuthPendingConsent',
  userOAuthAuthCodes: 'UserOAuthAuthCode',
};

/** JSON revives dates as strings; the schema knows which paths are dates, and the
 *  query engine compares dates by instant, so reads rehydrate them on the way out. */
function reviveDates(schema: Schema, doc: Doc): Doc {
  const out: Doc = { ...doc };
  for (const [path, type] of Object.entries(schema.paths)) {
    const instance = (type as unknown as { instance?: string }).instance;
    if (instance !== 'Date') continue;
    const value = out[path];
    if (typeof value === 'string') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) out[path] = date;
    }
  }
  return out;
}

class KdbBackedCollection<T extends Doc> implements Collection<T> {
  private readonly unique: Array<{ fields: string[]; sparse: boolean }>;

  constructor(
    readonly name: CollectionName,
    private readonly namespace: string,
    private readonly table: string,
    private readonly schema: Schema,
    private readonly client: () => KdbClient
  ) {
    this.unique = uniqueConstraints(schema);
  }

  /** Every document in the collection. The only read primitive: filtering happens
   *  above this, in the shared engine. */
  private async scan(): Promise<T[]> {
    const { rows } = await this.client().queryRaw(
      this.namespace,
      `SELECT kdb_id, _doc FROM ${this.table} WHERE _c = ?`,
      [this.name]
    );
    const docs: T[] = [];
    for (const row of rows) {
      const json = row[1];
      if (!json) continue;
      try {
        const { _c: _discriminator, ...body } = JSON.parse(json) as Doc;
        docs.push(reviveDates(this.schema, body) as T);
      } catch {
        // A document that will not parse is corruption, not a query result. Skipping
        // it would hide that; failing the whole read makes it visible immediately.
        throw new Error(`${this.name}: stored document is not valid JSON (kdb_id ${row[0]})`);
      }
    }
    return docs;
  }

  private async matching(filter: Filter): Promise<T[]> {
    const docs = await this.scan();
    return docs.filter((doc) => matchesFilter(doc, filter));
  }

  async find(filter: Filter = {}, options: FindOptions = {}): Promise<T[]> {
    let docs = await this.matching(filter);
    docs = applySort(docs, options.sort);
    if (options.skip !== undefined) docs = docs.slice(options.skip);
    if (options.limit !== undefined) docs = docs.slice(0, options.limit);
    if (options.select) docs = docs.map((doc) => applyProjection(doc, options.select) as T);
    return docs;
  }

  async findOne(filter: Filter, options: FindOptions = {}): Promise<T | null> {
    const [first] = await this.find(filter, { ...options, limit: 1 });
    return first ?? null;
  }

  async findById(id: string, options: FindOptions = {}): Promise<T | null> {
    return this.findOne({ _id: id }, options);
  }

  async countDocuments(filter: Filter = {}): Promise<number> {
    return (await this.matching(filter)).length;
  }

  async distinct(field: string, filter: Filter = {}): Promise<unknown[]> {
    const docs = await this.matching(filter);
    const out: unknown[] = [];
    for (const doc of docs) {
      const value = getPath(doc, field);
      // A distinct over an array field returns the elements, not the arrays.
      const candidates = Array.isArray(value) ? value : [value];
      for (const candidate of candidates) {
        if (candidate === undefined) continue;
        if (!out.some((existing) => valuesEqual(existing, candidate))) out.push(candidate);
      }
    }
    return out;
  }

  async create(doc: Doc): Promise<T> {
    const normalized = normalizeDocument(this.schema, doc, { isCreate: true });
    if (normalized._id === undefined) normalized._id = generateObjectId();
    await this.assertUnique(normalized, null);
    await this.writeDocument(normalized, null);
    return normalized as T;
  }

  async insertMany(docs: Doc[]): Promise<T[]> {
    const out: T[] = [];
    for (const doc of docs) out.push(await this.create(doc));
    return out;
  }

  async updateOne(filter: Filter, update: Update, options: UpdateOptions = {}): Promise<UpdateResult> {
    const [target] = await this.find(filter, options.sort ? { sort: options.sort } : {});
    if (!target) {
      if (options.upsert) {
        const created = await this.upsertFrom(filter, update);
        return { matched: 0, modified: 0, upsertedId: created._id as string };
      }
      return { matched: 0, modified: 0 };
    }
    const { changed } = await this.applyToDocument(target, update);
    return { matched: 1, modified: changed ? 1 : 0 };
  }

  async updateMany(filter: Filter, update: Update): Promise<UpdateResult> {
    const targets = await this.matching(filter);
    let modified = 0;
    for (const target of targets) {
      const { changed } = await this.applyToDocument(target, update);
      if (changed) modified++;
    }
    return { matched: targets.length, modified };
  }

  async findOneAndUpdate(filter: Filter, update: Update, options: UpdateOptions = {}): Promise<T | null> {
    const [target] = await this.find(filter, options.sort ? { sort: options.sort } : {});
    if (!target) {
      if (!options.upsert) return null;
      const created = await this.upsertFrom(filter, update);
      return options.returnDocument === 'before' ? null : (created as T);
    }
    const before = structuredCloneDoc(target);
    const { doc } = await this.applyToDocument(target, update);
    return options.returnDocument === 'before' ? (before as T) : (doc as T);
  }

  async findByIdAndUpdate(id: string, update: Update, options: UpdateOptions = {}): Promise<T | null> {
    return this.findOneAndUpdate({ _id: id }, update, options);
  }

  async replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult> {
    const [target] = await this.find(filter);
    if (!target) return { matched: 0, modified: 0 };

    const { _id: _ignored, ...body } = doc;
    const replacement = normalizeDocument(this.schema, body, { isCreate: true });
    replacement._id = target._id;
    replacement.createdAt = target.createdAt ?? replacement.createdAt;
    const stamped = touchUpdatedAt(this.schema, replacement);

    await this.assertUnique(stamped, target._id as string);
    await this.writeDocument(stamped, target);
    return { matched: 1, modified: 1 };
  }

  async deleteOne(filter: Filter): Promise<DeleteResult> {
    const [target] = await this.find(filter);
    if (!target) return { deleted: 0 };
    await this.removeById(target._id as string);
    return { deleted: 1 };
  }

  async deleteMany(filter: Filter): Promise<DeleteResult> {
    const targets = await this.matching(filter);
    for (const target of targets) await this.removeById(target._id as string);
    return { deleted: targets.length };
  }

  async findOneAndDelete(filter: Filter): Promise<T | null> {
    const [target] = await this.find(filter);
    if (!target) return null;
    await this.removeById(target._id as string);
    return target;
  }

  async bulkWrite(operations: BulkOperation[]): Promise<UpdateResult> {
    let matched = 0;
    let modified = 0;
    for (const operation of operations) {
      const result = await this.updateOne(
        operation.updateOne.filter,
        operation.updateOne.update,
        { upsert: operation.updateOne.upsert }
      );
      matched += result.matched;
      modified += result.modified;
    }
    return { matched, modified };
  }

  // --- write helpers -------------------------------------------------------------

  /** Applies an update to one document and writes it back. Returns the stored result
   *  and whether anything actually changed — `modified` must not count a no-op
   *  update, which is how a caller tells "already in that state" from "wrote it". */
  private async applyToDocument(target: T, update: Update): Promise<{ doc: Doc; changed: boolean }> {
    const updated = applyUpdate(target, update);
    if (!isOperatorUpdate(update)) updated._id = target._id;
    // Cast and validate what the update produced; an update can set an enum field to
    // a value the schema forbids exactly as a create can.
    const normalized = normalizeDocument(this.schema, updated, { isCreate: false });

    const changed = !sameDocument(target, normalized);
    if (!changed) return { doc: target, changed: false };

    const stamped = touchUpdatedAt(this.schema, normalized);
    await this.assertUnique(stamped, target._id as string);
    await this.writeDocument(stamped, target);
    return { doc: stamped, changed: true };
  }

  /** Builds the document an upsert creates: the filter's equality fields seed it, as
   *  in Mongo, then the update is applied on top. */
  private async upsertFrom(filter: Filter, update: Update): Promise<Doc> {
    const seed: Doc = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key.startsWith('$')) continue;
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        continue; // an operator condition seeds nothing
      }
      seed[key] = value;
    }
    const built = applyUpdate(seed, update, true);
    return this.create(built);
  }

  /**
   * Writes a document, deleting first when the new body drops a top-level key.
   *
   * KDB applies a write as a shallow root-level merge, so a key absent from the new
   * body survives from the old one — `$unset` and whole-document replacement would
   * silently do nothing. Delete-then-write is the documented workaround until a
   * replace-capable document op exists; it is not atomic, which is why it is used
   * only when a key actually went away rather than on every write.
   */
  private async writeDocument(doc: Doc, previous: Doc | null): Promise<void> {
    const id = doc._id as string;
    if (previous) {
      const removed = Object.keys(previous).filter((key) => !(key in doc));
      if (removed.length > 0) await this.removeById(previous._id as string);
    }
    await this.client().upsert(this.namespace, toDocumentUuid(id), { ...doc, _c: this.name });
  }

  private async removeById(id: string): Promise<void> {
    await this.client().exec(
      this.namespace,
      `DELETE FROM ${this.table} WHERE kdb_id = '${toDocumentUuid(id)}'`
    );
  }

  /**
   * Enforces the schema's unique constraints.
   *
   * Read-then-write, so it is not atomic: two concurrent creates of the same email
   * can both pass the check. KDB enforces compound unique natively at commit, and
   * declaring these to the server is the durable fix — but that needs a declared
   * schema per namespace, which this store does not yet push. Until then this closes
   * the ordinary case and the race is documented rather than hidden.
   */
  private async assertUnique(doc: Doc, excludeId: string | null): Promise<void> {
    if (this.unique.length === 0) return;
    const existing = await this.scan();

    for (const constraint of this.unique) {
      const values = constraint.fields.map((field) => getPath(doc, field));
      // A constraint with any part absent or null claims nothing — sparse semantics,
      // which is what makes "unique email" work for accounts that have no email yet.
      if (values.some((value) => value === undefined || value === null)) continue;

      const clash = existing.find((candidate) => {
        if (excludeId !== null && candidate._id === excludeId) return false;
        return constraint.fields.every((field, index) => valuesEqual(getPath(candidate, field), values[index]));
      });

      if (clash) {
        throw new ValidationError(
          `${this.name}: duplicate value for unique ${constraint.fields.join(' + ')}`
        );
      }
    }
  }
}

export class KdbDataStore implements DataStore {
  readonly backend = 'kdb' as const;
  private client?: KdbClient;
  private readonly collections = new Map<CollectionName, Collection<Doc>>();

  async connect(): Promise<void> {
    const { connect } = await loadClient();
    this.client = await connect(config.kdb.addr, config.kdb.token);
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.collections.clear();
  }

  collection<T extends Doc = Doc>(name: CollectionName): Collection<T> {
    const existing = this.collections.get(name);
    if (existing) return existing as Collection<T>;

    const modelName = MODEL_BY_COLLECTION[name];
    if (!modelName) throw new Error(`Unknown collection: ${name}`);

    const schema = schemaFor(modelName);
    const collection = new KdbBackedCollection<T>(
      name,
      config.kdb.namespacePrefix,
      'docs',
      schema,
      () => {
        if (!this.client) throw new Error('KDB store is not connected');
        return this.client;
      }
    );
    this.collections.set(name, collection as unknown as Collection<Doc>);
    return collection;
  }

  async clear(): Promise<void> {
    if (config.nodeEnv !== 'test') throw new Error('clear() is test-support only');
    if (!this.client) return;
    // One namespace holds every collection (see the file comment), so one statement
    // empties them all.
    await this.client.exec(config.kdb.namespacePrefix, 'DELETE FROM docs');
  }
}

/** Structural equality for "did this update change anything". Dates compare by
 *  instant, so a re-set of the same timestamp is not a modification. */
function sameDocument(a: Doc, b: Doc): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) return false;
  return aKeys.every((key) => valuesEqual(a[key], b[key]));
}

function schemaFor(modelName: string): Schema {
  // Reads the schema off the registered Mongoose model. The schema is the shared
  // declaration both backends obey, which is what stops them drifting; defining one
  // opens no connection, so this costs the KDB path nothing but the import.
  const model = mongoose.models[modelName];
  if (!model) {
    throw new Error(`Mongoose model "${modelName}" is not registered — import src/models/index.js first`);
  }
  return model.schema as unknown as Schema;
}

async function loadClient(): Promise<{ connect: ConnectFn }> {
  const specifier = process.env.KDB_CLIENT_MODULE ?? '@kdb/client';
  try {
    const module = (await import(specifier)) as { connect: ConnectFn };
    if (typeof module.connect !== 'function') {
      throw new Error(`${specifier} does not export connect()`);
    }
    return module;
  } catch (error) {
    throw new Error(
      `DATA_KDB=true requires the KDB client. Could not load "${specifier}": ${(error as Error).message}. ` +
        'Set KDB_CLIENT_MODULE to its location, or install @kdb/client.'
    );
  }
}
