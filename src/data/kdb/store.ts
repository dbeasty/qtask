/**
 * The KDB backend.
 *
 * KDB is a document store with a SQL layer over declared fields. This store uses it
 * as the former: documents go in whole through `UPSERT`, come out whole through
 * `SELECT kdb_id, _doc`, and every filter, sort and projection is applied in process
 * by the shared query engine — the same engine checked against a real mongod in
 * tests/data-query-parity.test.ts. Pushing predicates into KDB SQL is a later,
 * separately-flagged step (`DATA_KDB_PUSHDOWN`, see pushdown.ts): the server narrows
 * the scan and the engine still decides, so it can only make a query cheaper.
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
import { getPath, setPath } from '../query/paths.js';
import { generateObjectId, toDocumentUuid } from './ids.js';
import { buildWhere } from './pushdown.js';
import { DuplicateKeyError, EXPIRE_FIELD, mixedUndefinedToNull, normalizeDocument, touchUpdatedAt, ttlSpec, uniqueConstraints } from './schema.js';
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
import { MODEL_BY_COLLECTION } from '../modelNames.js';

/** The minimum of `@kdb/client` this store depends on. Declared here so the adapter
 *  boundary is explicit and the module can be loaded dynamically. */
interface KdbClient {
  upsert(ns: string, docId: string, body: unknown): Promise<string>;
  queryRaw(ns: string, sql: string, args?: unknown[]): Promise<{ columns: string[]; rows: string[][] }>;
  exec(ns: string, sql: string, args?: unknown[]): Promise<void>;
  /** Keyed read. Rejects with an error named KdbNotFoundError when there is no such document. */
  get(ns: string, docId: string): Promise<{ body: unknown; commit: string }>;
  /** Keyed read plus the content hash a conditional write compares against. */
  getWithHash(ns: string, docId: string): Promise<{ body: unknown; contentHash: string }>;
  /** Wholesale replacement: keys the new body omits are gone, in one commit. */
  replace(ns: string, docId: string, body: unknown): Promise<string>;
  /** Wholesale replacement that the server applies only if the document still hashes to
   *  `expectedContentHash`; otherwise it rejects with an error named KdbPreconditionError. */
  replaceIf(ns: string, docId: string, body: unknown, expectedContentHash: string): Promise<string>;
  /** Keyed delete: a commit, not a scan, so it is not bounded by anything about the namespace. */
  delete(ns: string, docId: string): Promise<string>;
  close(): Promise<void>;
}

type ConnectFn = (addr: string, token: string) => Promise<KdbClient>;

/**
 * The client's `exec` is two round trips on one shared session per namespace - run the DML, then
 * commit whatever the session holds - with nothing to stop two callers interleaving them. Two
 * concurrent deletes both buffer, the first commit takes both, and the second commit fails with
 * "no pending transaction to commit": a spurious error on the second caller, after its delete
 * has in fact been applied. The application deletes concurrently as a matter of course
 * (`Promise.all` over collections), so every DML statement goes through one queue here. Reads and
 * upserts are unaffected: they do not touch the session's pending buffer.
 *
 * The right fix is in the client; this keeps the store correct against any client version, and
 * costs nothing where DML is already one-at-a-time.
 */
class SerializedDmlClient implements KdbClient {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly inner: KdbClient) {}

  upsert(ns: string, docId: string, body: unknown): Promise<string> {
    return this.inner.upsert(ns, docId, body);
  }
  queryRaw(ns: string, sql: string, args?: unknown[]) {
    return this.inner.queryRaw(ns, sql, args);
  }
  get(ns: string, docId: string) {
    return this.inner.get(ns, docId);
  }
  getWithHash(ns: string, docId: string) {
    return this.inner.getWithHash(ns, docId);
  }
  replace(ns: string, docId: string, body: unknown) {
    return this.inner.replace(ns, docId, body);
  }
  replaceIf(ns: string, docId: string, body: unknown, expectedContentHash: string) {
    return this.inner.replaceIf(ns, docId, body, expectedContentHash);
  }
  delete(ns: string, docId: string) {
    return this.inner.delete(ns, docId);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  exec(ns: string, sql: string, args?: unknown[]): Promise<void> {
    // A failed statement must not poison the queue for the next one.
    const run = this.tail.then(
      () => this.inner.exec(ns, sql, args),
      () => this.inner.exec(ns, sql, args)
    );
    this.tail = run.catch(() => undefined);
    return run;
  }
}


/** JSON revives dates as strings; the schema knows which paths are dates, and the query engine
 *  compares dates by instant, so reads rehydrate them on the way out. Recurses into
 *  sub-documents, arrays of sub-documents and arrays of dates: a store that revived only
 *  top-level dates handed `project.trackingRollup.updatedAt` back as a string, and the first
 *  caller to call `.toISOString()` on it failed in production code. */
function reviveDates(schema: Schema, doc: Doc): Doc {
  const out: Doc = { ...doc };
  for (const [path, type] of Object.entries(schema.paths)) {
    const value = getPath(out, path);
    if (value === undefined || value === null) continue;
    const revived = reviveValue(type as unknown as SchemaTypeLike, value);
    if (revived !== value) setPath(out, path, revived);
  }
  return out;
}

interface SchemaTypeLike {
  instance?: string;
  schema?: Schema;
  caster?: { instance?: string };
  $embeddedSchemaType?: { instance?: string };
}

function reviveValue(type: SchemaTypeLike, value: unknown): unknown {
  if (type.instance === 'Date') {
    if (typeof value !== 'string') return value;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  // A single sub-document, or an array of them: both carry the sub-schema.
  if (type.schema) {
    if (Array.isArray(value)) {
      return value.map((item) => (isPlainObject(item) ? reviveDates(type.schema as Schema, item) : item));
    }
    return isPlainObject(value) ? reviveDates(type.schema, value) : value;
  }
  // An array of dates.
  if (type.instance === 'Array' && Array.isArray(value)) {
    const element = type.caster ?? type.$embeddedSchemaType;
    if (element?.instance === 'Date') return value.map((item) => reviveValue(element, item));
  }
  return value;
}

function isPlainObject(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * kdb-service v0.6.2 stops a non-indexed scan after collecting 10,000 document ids,
 * *before* the WHERE clause runs (go/kdb/sql/executor.go, MaxRows). On a namespace
 * holding more than that, every SQL read examines only the first 10,000 documents and
 * says nothing: COUNT(*) reports 10000, and a lookup of document 10,001 by id finds
 * nothing. qtask reads and writes (unique checks, key-removal detection) all go
 * through those scans, so past the cap the answers are wrong rather than slow.
 *
 * Wrong answers that look right are the worst way for a database to fail, so the store
 * refuses instead. Set KDB_SERVER_ROW_CAP=0 once the server no longer truncates (the
 * regression test in tests/data-kdb-scan-cap.test.ts says when), or to the cap the
 * server was actually configured with.
 */
export class KdbScanCapError extends Error {
  constructor(count: number, cap: number) {
    super(
      `KDB namespace holds at least ${count} documents, which reaches the server's ${cap}-row scan cap; ` +
        'SQL reads would silently ignore everything past it. Refusing to answer rather than return a truncated result. ' +
        'See docs/KDB_MIGRATION.md (blocker B1).'
    );
    this.name = 'KdbScanCapError';
  }
}

/** Shared by every collection: the cap is a property of the one namespace, not of a collection. */
const capCheck: { at?: number; count: number } = { count: 0 };

const DEFAULT_SERVER_ROW_CAP = 10_000;
const CAP_RECHECK_MS = 5_000;

function serverRowCap(): number {
  const raw = process.env.KDB_SERVER_ROW_CAP;
  if (raw === undefined || raw === '') return DEFAULT_SERVER_ROW_CAP;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`KDB_SERVER_ROW_CAP must be a non-negative integer, got "${raw}"`);
  return parsed;
}

/**
 * A per-key async mutex. The store runs inside one process, and the operations MongoDB
 * guarantees to be atomic on a single document (`updateOne` with a condition in the filter,
 * `findOneAndUpdate`, `findOneAndDelete`) are read-evaluate-write here, so two callers can both
 * pass the same condition and both write. Taking the document's lock, re-reading it and
 * re-checking the filter under the lock restores what callers rely on: exactly one of two
 * concurrent "claim this if unclaimed" updates wins.
 *
 * Scope, stated plainly: this makes a single process correct. A second process writing the same
 * namespace (an A/B deploy overlap, a second app instance) is not excluded by it; that needs the
 * server to arbitrate (conditional writes on a content hash), and is listed in the migration
 * plan as a condition for running more than one instance.
 */
const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Attempts at "find a candidate, lock it, find it no longer matches" before giving up. Each
 *  retry means another writer changed the candidate away from the filter, so the answer is
 *  almost always "nothing matches any more" within one or two. */
const MAX_CLAIM_ATTEMPTS = 8;

/** Re-reads allowed when the server rejects a conditional write because the document changed. */
const MAX_PRECONDITION_RETRIES = 60;

/** Jittered exponential backoff for a retried conditional write: up to ~2ms, doubling to a 64ms cap. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(64, 2 * 2 ** Math.min(attempt, 5));
  return Math.random() * ceiling;
}

class KdbBackedCollection<T extends Doc> implements Collection<T> {
  private readonly unique: Array<{ fields: string[]; sparse: boolean }>;
  private readonly ttl: { path: string; graceMs: number } | null;
  /** Unique constraints the server enforces, each carried on a synthetic field only this
   *  collection's documents have (see declareConstraints). */
  private readonly serverKeys: Array<{ field: string; paths: string[] }>;

  constructor(
    readonly name: CollectionName,
    private readonly namespace: string,
    private readonly table: string,
    private readonly schema: Schema,
    private readonly client: () => KdbClient
  ) {
    this.unique = uniqueConstraints(schema);
    this.ttl = ttlSpec(schema);
    this.serverKeys = this.unique
      .filter((constraint) => !constraint.fields.some((field) => isArrayPath(schema, field)))
      .map((constraint) => ({ field: serverKeyField(name, constraint.fields), paths: constraint.fields }));
  }

  /** Every document in the collection. The only read primitive: filtering happens
   *  above this, in the shared engine. */
  private async scan(filter: Filter = {}): Promise<T[]> {
    await this.assertWithinScanCap();
    // Pushdown only ever narrows: the caller re-checks every row with the shared
    // engine, so a clause the server cannot express is just left to that check.
    const pushed = config.kdb.pushdown ? buildWhere(filter) : null;
    const { rows } = await this.client().queryRaw(
      this.namespace,
      `SELECT kdb_id, _doc FROM ${this.table} WHERE _c = ?${pushed ? ` AND (${pushed.sql})` : ''}`,
      [this.name, ...(pushed?.args ?? [])]
    );
    const docs: T[] = [];
    for (const row of rows) {
      const json = row[1];
      if (!json) continue;
      try {
        docs.push(this.decode(JSON.parse(json) as Doc));
      } catch {
        // A document that will not parse is corruption, not a query result. Skipping
        // it would hide that; failing the whole read makes it visible immediately.
        throw new Error(`${this.name}: stored document is not valid JSON (kdb_id ${row[0]})`);
      }
    }
    // A scan has no inherent order. MongoDB's natural order is insertion order, which ObjectId
    // order tracks, and callers that sorted nothing (or sorted on ties) see it. Returning it here
    // makes an unsorted read stable and the same as the other backend's.
    docs.sort((a, b) => (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0));
    return docs;
  }

  /** A stored body back to the application's document: bookkeeping fields off, dates revived. */
  private decode(stored: Doc): T {
    const { _c: _discriminator, [EXPIRE_FIELD]: _expireAt, ...withKeys } = stored;
    // The synthetic fields that carry unique constraints are the store's, not the document's.
    const body = Object.fromEntries(Object.entries(withKeys).filter(([key]) => !key.startsWith('_u_')));
    return reviveDates(this.schema, body) as T;
  }

  /**
   * One document by id through KDB's keyed read, which does not scan and so is not
   * subject to the scan cap (see KdbScanCapError). Returns null for a missing document
   * and for one that belongs to another collection - ids are unique across the
   * namespace, but a collection must never serve another's document.
   */
  private async fetchById(id: string): Promise<T | null> {
    let stored: Doc;
    try {
      stored = (await this.client().get(this.namespace, toDocumentUuid(id))).body as Doc;
    } catch (error) {
      if ((error as Error).constructor.name === 'KdbNotFoundError') return null;
      throw error;
    }
    return stored._c === this.name ? this.decode(stored) : null;
  }

  /** Checks (at most every few seconds) that the namespace is still small enough for
   *  the server to scan completely. COUNT(*) is itself capped, so a result at or past
   *  the cap means "at least this many", which is all the check needs. */
  private async assertWithinScanCap(): Promise<void> {
    const cap = serverRowCap();
    if (cap === 0) return;
    const now = Date.now();
    if (capCheck.at === undefined || now - capCheck.at > CAP_RECHECK_MS) {
      const { rows } = await this.client().queryRaw(this.namespace, `SELECT COUNT(*) FROM ${this.table}`);
      capCheck.count = Number(rows[0]?.[0] ?? 0);
      capCheck.at = now;
    }
    // Exactly the cap, not "at least": a truncating server can never report more than
    // the cap, while a server with the fix reports the true count, which may be larger
    // and must not be refused.
    if (capCheck.count === cap) throw new KdbScanCapError(capCheck.count, cap);
  }

  private async matching(filter: Filter): Promise<T[]> {
    // A filter that names the document is a keyed read, whatever else it says: fetch it and let
    // the engine apply the rest. Without this a conditional update by id ({_id, status: 'open'})
    // would scan the whole collection to find one document.
    if (typeof filter._id === 'string') {
      const doc = await this.fetchById(filter._id);
      return doc && matchesFilter(doc, filter) ? [doc] : [];
    }
    const docs = await this.scan(filter);
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
    // The unique check and the write are one step: without the lock two concurrent creates of
    // the same email both pass the check.
    await this.guardUnique(async () => {
      await this.assertUnique(normalized, null);
      await this.writeDocument(normalized, null);
    });
    return normalized as T;
  }

  async insertMany(docs: Doc[]): Promise<T[]> {
    const out: T[] = [];
    for (const doc of docs) out.push(await this.create(doc));
    return out;
  }

  async updateOne(filter: Filter, update: Update, options: UpdateOptions = {}): Promise<UpdateResult> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const [candidate] = await this.find(filter, options.sort ? { sort: options.sort } : {});
      if (!candidate) {
        if (options.upsert) {
          const created = await this.upsertFrom(filter, update);
          return { matched: 0, modified: 0, upsertedId: created._id as string };
        }
        return { matched: 0, modified: 0 };
      }
      const claimed = await this.claim(candidate._id as string, filter, (fresh, guard) => this.applyToDocument(fresh, update, filter, guard));
      if (claimed.hit) return { matched: 1, modified: claimed.value.changed ? 1 : 0 };
    }
    return { matched: 0, modified: 0 };
  }

  async updateMany(filter: Filter, update: Update): Promise<UpdateResult> {
    const targets = await this.matching(filter);
    let matched = 0;
    let modified = 0;
    for (const target of targets) {
      const claimed = await this.claim(target._id as string, filter, (fresh, guard) => this.applyToDocument(fresh, update, filter, guard));
      if (!claimed.hit) continue;
      matched++;
      if (claimed.value.changed) modified++;
    }
    return { matched, modified };
  }

  async findOneAndUpdate(filter: Filter, update: Update, options: UpdateOptions = {}): Promise<T | null> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const [candidate] = await this.find(filter, options.sort ? { sort: options.sort } : {});
      if (!candidate) {
        if (!options.upsert) return null;
        const created = await this.upsertFrom(filter, update);
        return options.returnDocument === 'before' ? null : (created as T);
      }
      const claimed = await this.claim(candidate._id as string, filter, async (fresh, guard) => {
        const before = structuredCloneDoc(fresh);
        const { doc } = await this.applyToDocument(fresh, update, filter, guard);
        return options.returnDocument === 'before' ? (before as T) : (doc as T);
      });
      if (claimed.hit) return claimed.value;
    }
    return null;
  }

  async findByIdAndUpdate(id: string, update: Update, options: UpdateOptions = {}): Promise<T | null> {
    return this.findOneAndUpdate({ _id: id }, update, options);
  }

  async replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const [candidate] = await this.find(filter);
      if (!candidate) return { matched: 0, modified: 0 };
      const claimed = await this.claim(candidate._id as string, filter, async (target, guard) => {
        const { _id: _ignored, ...body } = doc;
        const replacement = normalizeDocument(this.schema, body, { isCreate: true });
        replacement._id = target._id;
        replacement.createdAt = target.createdAt ?? replacement.createdAt;
        const stamped = touchUpdatedAt(this.schema, replacement);

        await this.assertUnique(stamped, target._id as string);
        await this.writeDocument(stamped, target, guard);
      });
      if (claimed.hit) return { matched: 1, modified: 1 };
    }
    return { matched: 0, modified: 0 };
  }

  async deleteOne(filter: Filter): Promise<DeleteResult> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const [candidate] = await this.find(filter);
      if (!candidate) return { deleted: 0 };
      const claimed = await this.claim(candidate._id as string, filter, (fresh) => this.removeById(fresh._id as string));
      if (claimed.hit) return { deleted: 1 };
    }
    return { deleted: 0 };
  }

  async deleteMany(filter: Filter): Promise<DeleteResult> {
    const targets = await this.matching(filter);
    let deleted = 0;
    for (const target of targets) {
      const claimed = await this.claim(target._id as string, filter, (fresh) => this.removeById(fresh._id as string));
      if (claimed.hit) deleted++;
    }
    return { deleted };
  }

  async findOneAndDelete(filter: Filter): Promise<T | null> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const [candidate] = await this.find(filter);
      if (!candidate) return null;
      const claimed = await this.claim(candidate._id as string, filter, async (fresh) => {
        await this.removeById(fresh._id as string);
        return fresh;
      });
      if (claimed.hit) return claimed.value;
    }
    return null;
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

  /**
   * Writes a document exactly as given - no defaults, no casting, no `updatedAt`
   * stamp, no unique check. This is for copying data that another backend already
   * validated (src/scripts/migrate-mongo-to-kdb.ts); `create` would re-stamp
   * timestamps, which is precisely what a faithful copy must not do. Idempotent:
   * running it again over the same document leaves the same document.
   */
  async importDocument(doc: Doc): Promise<void> {
    if (typeof doc._id !== 'string') throw new Error(`${this.name}: cannot import a document without a string _id`);
    // A wholesale replace: idempotent, drops stale keys from an earlier copy, and needs no read.
    await this.writeDocument(doc, null);
  }

  // --- write helpers -------------------------------------------------------------

  /** Runs `fn` while holding the collection's unique-constraint lock, if it has constraints.
   *  Always taken before a document lock, never after, so two writers cannot deadlock. */
  private guardUnique<R>(fn: () => Promise<R>): Promise<R> {
    return this.unique.length > 0 ? withLock(`${this.namespace}/${this.name}#unique`, fn) : fn();
  }

  /**
   * Acts on one document atomically with respect to other writers in this process: takes the
   * document's lock, re-reads it, and only proceeds if it still satisfies `filter`. A miss means
   * somebody changed or removed it between the caller finding it and now - the caller looks
   * again rather than acting on a stale reading.
   */
  private claim<R>(
    id: string,
    filter: Filter,
    fn: (fresh: T, guard: { hash: string }) => Promise<R>
  ): Promise<{ hit: true; value: R } | { hit: false }> {
    return this.guardUnique(() =>
      withLock(`${this.namespace}/${this.name}/${id}`, async () => {
        // The lock orders writers within this process; the guard makes the server refuse a write
        // based on a stale reading, which is what covers a second process. A refusal means the
        // document moved under us, so read it again and re-check the filter.
        for (let attempt = 0; attempt < MAX_PRECONDITION_RETRIES; attempt++) {
          const read = await this.fetchWithHash(id);
          if (!read || !matchesFilter(read.doc, filter)) return { hit: false as const };
          try {
            return { hit: true as const, value: await fn(read.doc, { hash: read.hash }) };
          } catch (error) {
            if ((error as Error).constructor.name !== 'KdbPreconditionError') throw error;
            // Someone else's write landed between our read and ours. Retrying at once makes every
            // contender collide again in lockstep and starves some of them, so back off, with
            // jitter, longer each time. (Contention inside this process is already ordered by the
            // lock; this is for other processes writing the same document.)
            await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
          }
        }
        throw new Error(`${this.name}: ${id} kept changing under a conditional write; gave up after ${MAX_PRECONDITION_RETRIES} attempts`);
      })
    );
  }

  /** One document and the content hash a conditional write must quote, or null when absent
   *  or belonging to another collection. */
  private async fetchWithHash(id: string): Promise<{ doc: T; hash: string } | null> {
    let read: { body: unknown; contentHash: string };
    try {
      read = await this.client().getWithHash(this.namespace, toDocumentUuid(id));
    } catch (error) {
      if ((error as Error).constructor.name === 'KdbNotFoundError') return null;
      throw error;
    }
    const stored = read.body as Doc;
    return stored._c === this.name ? { doc: this.decode(stored), hash: read.contentHash } : null;
  }

  /** Applies an update to one document and writes it back. Returns the stored result
   *  and whether anything actually changed — `modified` must not count a no-op
   *  update, which is how a caller tells "already in that state" from "wrote it". */
  private async applyToDocument(target: T, update: Update, filter: Filter, guard?: { hash: string }): Promise<{ doc: Doc; changed: boolean }> {
    // The filter is what the positional operator (`list.$.field`) resolves against.
    const updated = applyUpdate(target, update, false, filter);
    if (!isOperatorUpdate(update)) updated._id = target._id;
    // Cast and validate what the update produced; an update can set an enum field to
    // a value the schema forbids exactly as a create can.
    const normalized = normalizeDocument(this.schema, mixedUndefinedToNull(this.schema, updated), { isCreate: false });

    const changed = !sameDocument(target, normalized);
    if (!changed) return { doc: target, changed: false };

    const stamped = touchUpdatedAt(this.schema, normalized);
    await this.assertUnique(stamped, target._id as string);
    await this.writeDocument(stamped, target, guard);
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
    const built = applyUpdate(seed, update, true, filter);
    return this.create(built);
  }

  /**
   * Writes a document wholesale, in one commit.
   *
   * `replace` drops keys the body omits (a write used to be a shallow merge, so `$unset` and
   * replacement needed delete-then-write, which is two commits and loses the document if the
   * process dies between them). With a `guard` the server applies it only if the document is
   * still the one that was read - the cross-process half of atomicity that the in-process lock
   * cannot give. A rejected guard is a KdbPreconditionError, which `claim` retries.
   */
  private async writeDocument(doc: Doc, _previous: Doc | null, guard?: { hash: string }): Promise<void> {
    const key = toDocumentUuid(doc._id as string);
    const body: Doc = { ...doc, _c: this.name, ...this.expiry(doc) };
    for (const { field, paths } of this.serverKeys) {
      const value = serverKeyValue(doc, paths);
      if (value !== undefined) body[field] = value;
    }
    try {
      if (guard) await this.client().replaceIf(this.namespace, key, body, guard.hash);
      else await this.client().replace(this.namespace, key, body);
    } catch (error) {
      // The server's unique constraint, which no in-process check can pre-empt, reports the same
      // thing the in-process check does: a duplicate key, code 11000, which authService turns
      // into a 409.
      if ((error as { code?: string }).code === 'UNIQUE_VIOLATION') {
        throw new DuplicateKeyError(`${this.name}: duplicate value for a unique field (${(error as Error).message})`);
      }
      throw error;
    }
  }

  /** The deadline the server's expiry sweeper reads, for collections whose Mongo
   *  schema declared a TTL index. Epoch milliseconds, which the sweeper accepts. */
  private expiry(doc: Doc): Doc {
    if (!this.ttl) return {};
    const at = getPath(doc, this.ttl.path);
    const ms = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : NaN;
    return Number.isNaN(ms) ? {} : { [EXPIRE_FIELD]: ms + this.ttl.graceMs };
  }

  private async removeById(id: string): Promise<void> {
    await this.client().delete(this.namespace, toDocumentUuid(id));
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
    for (const constraint of this.unique) {
      const values = constraint.fields.map((field) => getPath(doc, field));
      // A constraint with any part absent or null claims nothing — sparse semantics,
      // which is what makes "unique email" work for accounts that have no email yet.
      if (values.some((value) => value === undefined || value === null)) continue;

      // Only documents sharing the constraint's values can clash, so ask for those
      // rather than the whole collection (the comparison below still decides).
      const existing = await this.scan(Object.fromEntries(constraint.fields.map((field, i) => [field, values[i]])));

      const clash = existing.find((candidate) => {
        if (excludeId !== null && candidate._id === excludeId) return false;
        return constraint.fields.every((field, index) => valuesEqual(getPath(candidate, field), values[index]));
      });

      if (clash) {
        throw new DuplicateKeyError(`${this.name}: duplicate value for unique ${constraint.fields.join(' + ')}`);
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
    capCheck.at = undefined;
    this.client = new SerializedDmlClient(await connect(config.kdb.addr, config.kdb.token));
    if (config.kdb.declareConstraints || config.kdb.declareIndexes) {
      try {
        if (config.kdb.declareConstraints) await this.declareConstraints();
        if (config.kdb.declareIndexes) await this.declareIndexes();
      } catch (error) {
        // A connection left open by a failed connect() keeps the process alive after the error
        // that should have ended it.
        await this.client.close().catch(() => undefined);
        this.client = undefined;
        throw error;
      }
    }
  }

  /**
   * Hands the schema's unique constraints to the server, which enforces them at commit.
   *
   * The in-process check (assertUnique, under a lock) is check-then-write, so two *processes*
   * could both pass it. A constraint the server holds cannot be raced.
   *
   * Every collection lives in one namespace and a server constraint binds every document that has
   * the field, so a bare `UNIQUE clientId` would also bind the authorization codes, which repeat
   * the same clientId by design (and prefixing `_c` would not help: all the codes share both).
   * Each constraint is instead carried on a field only its collection's documents have, a
   * synthetic `_u_<collection>_<fields>` holding the tuple's value; the store writes it and
   * strips it on read. A document missing a part gets no key and claims nothing, the sparse
   * behaviour the schemas declare.
   *
   * Idempotent: stating a constraint the server already holds does nothing. It fails if existing
   * data already violates one, which is the right place to find out. A constraint over array
   * elements (a user's linked identity providers) cannot be a field tuple and stays in-process.
   *
   * Needs a server that installs constraints for CREATE UNIQUE INDEX (KDB 0.7.0 + #147). An older
   * one accepts the statement and enforces nothing; the in-process check still stands, so that
   * costs the extra guarantee, not the existing one.
   */
  private async declareConstraints(): Promise<void> {
    for (const name of Object.keys(MODEL_BY_COLLECTION) as CollectionName[]) {
      for (const { field, paths } of (this.collection(name) as unknown as { serverKeys: Array<{ field: string; paths: string[] }> }).serverKeys) {
        try {
          await this.client!.exec(config.kdb.namespacePrefix, `CREATE UNIQUE INDEX qtask_${field} ON docs (${field})`);
        } catch (error) {
          // Stating a constraint the server already holds is the normal case after the first
          // start; only a refusal for another reason (existing data violating it) is a problem.
          if (/already registered/i.test((error as Error).message)) continue;
          throw new Error(`KDB refused the unique constraint on ${name}(${paths.join(', ')}): ${(error as Error).message}`);
        }
      }
    }
  }

  /**
   * Creates on KDB the lookup indexes the Mongoose schemas declare for MongoDB, so a filtered read
   * is a lookup rather than a scan of the namespace.
   *
   * What translates, and how:
   *  - KDB indexes cover one path; a Mongo compound index serves its leading field as a prefix, so
   *    each becomes an index on that field and the other columns stay a residual filter.
   *  - Every collection lives in one namespace, so an index is per path, not per collection:
   *    `userId` is declared by a dozen collections and created once.
   *  - BTREE for Date and Number paths (ranges, ordering), HASH otherwise. KDB's indexes see
   *    through arrays (`projectIds`, `collaborators.userId`) as Mongo's multikey indexes do.
   *  - Unique, TTL and text indexes are not lookups: constraints and expiry are declared
   *    separately, and text search is done by the application.
   *
   * Idempotent: stating an index the server already holds is the normal case after the first start.
   * Indexes only change cost, never an answer, so a server without them still returns the same rows.
   */
  private async declareIndexes(): Promise<void> {
    const wanted = declaredIndexes();
    for (const [path, kind] of wanted) {
      const index = `qtask_i_${path.replace(/[^A-Za-z0-9_]/g, '_')}`;
      try {
        await this.client!.exec(config.kdb.namespacePrefix, `CREATE INDEX ${index} ON docs (${path}) USING ${kind}`);
      } catch (error) {
        if (/already registered/i.test((error as Error).message)) continue;
        throw new Error(`KDB refused the index on ${path}: ${(error as Error).message}`);
      }
    }
  }

  async ping(): Promise<void> {
    if (!this.client) throw new Error('KDB store is not connected');
    await this.client.queryRaw(config.kdb.namespacePrefix, 'SELECT 1');
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

  /** Verbatim import for the migration tool; see KdbBackedCollection.importDocument. */
  async importDocument(name: CollectionName, doc: Doc): Promise<void> {
    await (this.collection(name) as unknown as KdbBackedCollection<Doc>).importDocument(doc);
  }

  async clear(): Promise<void> {
    if (config.nodeEnv !== 'test') throw new Error('clear() is test-support only');
    if (!this.client) return;
    // One namespace holds every collection (see the file comment), so one statement
    // empties them all.
    await this.client.exec(config.kdb.namespacePrefix, 'DELETE FROM docs');
    capCheck.at = undefined;
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

/** The field that carries one collection's unique constraint on the server. */
function serverKeyField(collection: string, fields: string[]): string {
  return `_u_${collection}_${fields.join('_').replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** A constraint tuple's value as one comparable string, or undefined when any part is missing
 *  (a document that lacks a part claims nothing). Dates compare by instant, as in the engine. */
function serverKeyValue(doc: Doc, fields: string[]): string | undefined {
  const parts: unknown[] = [];
  for (const field of fields) {
    const value = getPath(doc, field);
    if (value === undefined || value === null) return undefined;
    parts.push(value instanceof Date ? value.toISOString() : value);
  }
  return JSON.stringify(parts);
}

/**
 * The lookup indexes the Mongoose schemas declare, as path to kind (see declareIndexes for how a
 * MongoDB index maps onto KDB's). Exported for the tests that check what the store asks for.
 */
export function declaredIndexes(): Map<string, 'HASH' | 'BTREE'> {
  const wanted = new Map<string, 'HASH' | 'BTREE'>();
  for (const name of Object.keys(MODEL_BY_COLLECTION) as CollectionName[]) {
    const model = mongoose.models[MODEL_BY_COLLECTION[name]];
    if (!model) continue;
    const schema = model.schema as unknown as Schema;
    const declared = (schema as unknown as { indexes(): Array<[Record<string, unknown>, Record<string, unknown>?]> }).indexes();
    for (const [fields, options] of declared) {
      if (options?.unique || options?.expireAfterSeconds !== undefined) continue;
      const keys = Object.keys(fields);
      if (keys.length === 0 || keys.some((key) => fields[key] === 'text')) continue;
      const lead = keys[0]!;
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(lead)) continue;
      const instance = (schema.path(lead) as unknown as { instance?: string } | undefined)?.instance;
      const kind = instance === 'Date' || instance === 'Number' ? 'BTREE' : 'HASH';
      // A path wanted ordered by any collection is ordered for all of them.
      if (kind === 'BTREE' || !wanted.has(lead)) wanted.set(lead, kind);
    }
  }
  return wanted;
}

/** Whether a dotted path passes through an array, which a field tuple cannot express. */
function isArrayPath(schema: Schema, path: string): boolean {
  const segments = path.split('.');
  for (let i = 1; i <= segments.length; i++) {
    const type = schema.path(segments.slice(0, i).join('.')) as unknown as { instance?: string } | undefined;
    if (type?.instance === 'Array') return true;
  }
  return false;
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
