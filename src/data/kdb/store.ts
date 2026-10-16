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
import { buildWhere, exactWhere, unionBranches, type PathKind, type Where } from './pushdown.js';
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

/** The minimum of `@limidus/kdb-client` this store depends on. Declared here so the adapter
 *  boundary is explicit and the module can be loaded dynamically. */
interface KdbClient {
  upsert(ns: string, docId: string, body: unknown): Promise<string>;
  queryRaw(ns: string, sql: string, args?: unknown[]): Promise<{ columns: string[]; rows: string[][] }>;
  /** The same query a page at a time (pageSize 0: the largest page the server allows). A single
   *  unpaged reply is capped (15 MiB encoded since KDB 0.8.0), so anything that can grow with the
   *  data - a collection scan - is read this way. */
  queryRawPages(ns: string, sql: string, args?: unknown[], pageSize?: number): AsyncIterable<{ columns: string[]; rows: string[][] }>;
  /** A SELECT with typed cells: null for NULL, numbers, parsed JSON for objects and arrays. Unpaged
   *  (the client has no paged form), so callers bound the rows themselves (see leanMatches). */
  queryValues(ns: string, sql: string, args?: unknown[]): Promise<{ columns: string[]; rows: unknown[][] }>;
  exec(ns: string, sql: string, args?: unknown[]): Promise<void>;
  /** A DML statement with RETURNING (KDB 0.9): the rows as they are after it, typed as queryValues
   *  types them. An `UPDATE … ORDER BY … LIMIT 1 RETURNING` decides and commits in one step. */
  execReturning(ns: string, sql: string, args?: unknown[]): Promise<{ columns: string[]; rows: unknown[][]; rowsAffected: number }>;
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
  /** Several writes in one commit. `baseVersion` must be a commit hash; a stale one is rebased. */
  commit(tx: {
    namespace: string;
    baseVersion: string;
    writes: Array<{ docId: string; body: unknown; replace?: boolean }>;
    deletes?: string[];
    preconditions?: Array<{ opIndex: number; kind: 'EXPECT_CONTENT_HASH'; contentHashHex: string }>;
  }): Promise<string>;
  close(): Promise<void>;
}

type ConnectFn = (addr: string, options: { token?: string; requestTimeoutMs?: number }) => Promise<KdbClient>;

/**
 * Rows per page of a collection scan. Each page is one reply, and a reply over 15 MiB encoded is
 * refused, so the page is sized by documents rather than left to the server's maximum: 2,000
 * documents stays under the cap up to an average of about 7 KiB each, several times qtask's
 * largest documents (a task with its steps, subtasks and materials).
 */
const SCAN_PAGE_ROWS = 2_000;

/** Rows per page of a lean read (leanMatches): small rows, so more of them than a scan page. */
const LEAN_PAGE_ROWS = 5_000;

/** The stored list of a document's explicitly-null top-level fields (see storedBody). */
const NULLS_FIELD = '_nulls';

/** An empty number array as packNumbers stores it. */
const PACKED_EMPTY = 'f64:';

/** Mongo's range operators as SQL, for the numeric conditions of an atomic claim. */
const RANGE_SQL: Record<string, string> = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' };

/** Ids per keyed `kdb_id IN (...)` statement (see scan). */
const KEYED_BATCH = 100;

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
    return retryWhenBusy(() => this.inner.queryRaw(ns, sql, args));
  }
  queryValues(ns: string, sql: string, args?: unknown[]) {
    return retryWhenBusy(() => this.inner.queryValues(ns, sql, args));
  }
  async *queryRawPages(ns: string, sql: string, args?: unknown[], pageSize?: number) {
    // Only the first page is retried: a later one would need the continuation the failed call
    // lost, and starting over would repeat rows the caller already has.
    let pages!: AsyncIterator<{ columns: string[]; rows: string[][] }>;
    let page = await retryWhenBusy(() => {
      pages = this.inner.queryRawPages(ns, sql, args, pageSize)[Symbol.asyncIterator]();
      return pages.next();
    });
    while (!page.done) {
      yield page.value;
      page = await pages.next();
    }
  }
  get(ns: string, docId: string) {
    return retryWhenBusy(() => this.inner.get(ns, docId));
  }
  getWithHash(ns: string, docId: string) {
    return retryWhenBusy(() => this.inner.getWithHash(ns, docId));
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
  commit(tx: Parameters<KdbClient['commit']>[0]) {
    return this.inner.commit(tx);
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
  execReturning(ns: string, sql: string, args?: unknown[]) {
    // Through the same queue: the server refuses it while the session holds another statement's
    // uncommitted writes.
    const run = this.tail.then(
      () => this.inner.execReturning(ns, sql, args),
      () => this.inner.execReturning(ns, sql, args)
    );
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/**
 * Runs a read again when the server refuses it as BUSY - kdb-service v0.8.0's answer to a read
 * that arrives in a high memory-pressure zone ("rejecting scan - memory pressure zone high (retry
 * after 100ms)"), which it marks retryable. Seen in the restore drill on a 110,000-document
 * namespace under --memory-budget-mb 1536. A handful of attempts, backing off from the server's
 * hint to at most 2 s, about 6 s in all; past that the refusal is the caller's to see. Writes are
 * not retried here: a write the server refused is the claim loop's to retry, with a fresh read.
 */
export async function retryWhenBusy<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const busy = (error as { code?: string }).code === 'BUSY' || (error as Error).constructor?.name === 'KdbBusyError';
      if (!busy || attempt >= attempts - 1) throw error;
      const hint = Number((error as { retryAfterMs?: number }).retryAfterMs) || 100;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, hint * 2 ** attempt)));
    }
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

/** The latest commit this process has seen per namespace: the base a multi-document import
 *  commit is built on (see importMany). Any real commit will do; the server rebases a stale one. */
const lastCommit = new Map<string, string>();

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
  private readonly serverKeys: Array<{ field: string; paths: string[]; arrayPrefix?: string }>;
  /** Top-level number arrays stored packed (see packNumbers): the embeddings. */
  private readonly packed: Set<string>;

  constructor(
    readonly name: CollectionName,
    private readonly namespace: string,
    private readonly table: string,
    private readonly schema: Schema,
    private readonly client: () => KdbClient
  ) {
    this.unique = uniqueConstraints(schema);
    this.packed = new Set(
      Object.entries((schema as unknown as { paths: Record<string, { instance?: string; caster?: { instance?: string }; embeddedSchemaType?: { instance?: string } }> }).paths)
        .filter(([path, type]) => !path.includes('.') && type.instance === 'Array' && (type.embeddedSchemaType ?? type.caster)?.instance === 'Number')
        .map(([path]) => path)
    );
    this.ttl = ttlSpec(schema);
    this.serverKeys = this.unique.flatMap((constraint) => {
      const field = serverKeyField(name, constraint.fields);
      if (!constraint.fields.some((path) => isArrayPath(schema, path))) return [{ field, paths: constraint.fields }];
      // Through an array: one key per element, which the server holds as a multikey constraint.
      // Only the shape the schemas use - every part under the same array of sub-documents - has
      // an unambiguous per-element meaning; anything else stays with the in-process check.
      const arrayPrefix = sharedArrayPrefix(schema, constraint.fields);
      return arrayPrefix ? [{ field, paths: constraint.fields, arrayPrefix }] : [];
    });
  }

  /** Every document in the collection. The only read primitive: filtering happens
   *  above this, in the shared engine. */
  private async scan(filter: Filter = {}): Promise<T[]> {
    // Pushdown only ever narrows: the caller re-checks every row with the shared
    // engine, so a clause the server cannot express is just left to that check.
    // A filter naming documents by id (`{_id: {$in: [...]}}`) is a keyed lookup, whatever else it
    // says and whether or not pushdown is on, the same way fetchById is. It is sent as the id
    // predicate alone: kdb-service v0.8.0 answers `kdb_id IN (...)` by key, but stops doing so once
    // another conjunct comes first (`_c = ? AND kdb_id IN (...)` read the whole namespace: 2.7 s
    // instead of 6 ms for 100 ids at 27,000 documents). The collection is checked here instead.
    // At most KEYED_BATCH ids per statement, so no statement carries an unbounded number of large
    // documents. (Measured on 100,000 tasks with embeddings: reading all of them in statements of
    // 100 or 500 ids took 41-43 s at under 1.1 GiB RSS; the size of one statement is not what
    // exhausted the server's memory in the rehearsal - see docs/KDB_MIGRATION.md B5.)
    const ids = isPlainObject(filter._id) && Array.isArray((filter._id as Doc).$in) ? ((filter._id as Doc).$in as unknown[]) : null;
    const keyedBatches = ids && buildWhere({ _id: filter._id })
      ? Array.from({ length: Math.ceil(ids.length / KEYED_BATCH) }, (_, i) => buildWhere({ _id: { $in: ids.slice(i * KEYED_BATCH, (i + 1) * KEYED_BATCH) } })!)
      : null;
    const keyed = keyedBatches !== null;
    // Otherwise a disjunction KDB cannot serve from an index is asked one branch at a time (see
    // unionBranches); a document matching several branches comes back once.
    const pushable = this.pushable(filter);
    const alternatives = pushable ? (unionBranches(pushable, isIndexedPath) ?? [pushable]) : [filter];
    const seen = !keyed && alternatives.length > 1 ? new Set<string>() : null;
    const docs: T[] = [];
    const client = this.client();
    const queries = keyedBatches
      ? keyedBatches.map((where) => () => client.queryRawPages(this.namespace, `SELECT kdb_id, _doc FROM ${this.table} WHERE ${where.sql}`, where.args, SCAN_PAGE_ROWS))
      : alternatives.map((alternative) => () => {
          const pushed = pushable ? buildWhere(alternative) : null;
          return client.queryRawPages(
            this.namespace,
            `SELECT kdb_id, _doc FROM ${this.table} WHERE _c = ?${pushed ? ` AND (${pushed.sql})` : ''}`,
            [this.name, ...(pushed?.args ?? [])],
            SCAN_PAGE_ROWS
          );
        });
    for (const query of queries) for await (const { rows } of query()) {
      for (const row of rows) {
        const json = row[1];
        if (!json) continue;
        if (seen) {
          if (seen.has(row[0]!)) continue;
          seen.add(row[0]!);
        }
        let stored: Doc;
        try {
          stored = JSON.parse(json) as Doc;
        } catch {
          // A document that will not parse is corruption, not a query result. Skipping
          // it would hide that; failing the whole read makes it visible immediately.
          throw new Error(`${this.name}: stored document is not valid JSON (kdb_id ${row[0]})`);
        }
        // Ids are unique across the namespace, but a collection never serves another's document.
        if (keyed && stored._c !== this.name) continue;
        docs.push(this.decode(stored));
      }
    }
    // A scan has no inherent order. MongoDB's natural order is insertion order, which ObjectId
    // order tracks, and callers that sorted nothing (or sorted on ties) see it. Returning it here
    // makes an unsorted read stable and the same as the other backend's.
    docs.sort((a, b) => (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0));
    return docs;
  }

  /**
   * The documents matching `filter`, in `sort` order (ties in id order, as scan returns them),
   * each as a partial document holding only its id and the top-level fields the filter and sort
   * name - or null when that cannot be done exactly (an operator naming no field, such as
   * `$where`, or a field name SQL cannot carry), and the caller reads whole documents instead.
   *
   * Exact because the shared engine decides on the partial document what it would decide on the
   * whole one: it only looks at those fields, each rebuilt as stored - booleans from the 0/1 SQL
   * returns, an explicit null told from an absent field by the stored null list (storedBody),
   * dates revived by the schema. Paged by id, since the typed query has no paged form.
   *
   * With `presence`, a packed field the filter names only as present and not empty (search's
   * `embedding: {$exists: true, $ne: []}`) is checked on the server instead of read: selecting it
   * shipped every candidate's 768 numbers to decide a yes/no. The server's check is a superset (a
   * legacy unpacked `[]` passes it), so the result is `approximate` and its caller must re-check
   * whole documents - which is why a count never asks for it.
   */
  private async leanMatches(filter: Filter, sort: FindOptions['sort'], presence = false): Promise<{ docs: Doc[]; approximate: boolean } | null> {
    const present = presence ? this.presenceOnly(filter) : [];
    const residual = present.length > 0 ? Object.fromEntries(Object.entries(filter).filter(([key]) => !present.includes(key))) : filter;
    const fields = topLevelFields(residual);
    const pushable = this.pushable(residual);
    if (fields === null || !pushable) return null;
    // Packed: an empty array is stored as the bare prefix (packNumbers). Missing and that prefix
    // are what Mongo's `$exists: true, $ne: []` excludes; null and every other value pass.
    const presenceSql = present.map((field) => ({ sql: `${field} IS NOT MISSING AND NOT (${field} = ?)`, args: [PACKED_EMPTY] }));
    for (const key of Object.keys(sort ?? {})) fields.add(key.split('.')[0]!);
    fields.delete('_id');
    if (![...fields].every((field) => /^[A-Za-z][A-Za-z0-9_]*$/.test(field))) return null;
    const columns = ['_id', NULLS_FIELD, ...fields];
    const alternatives = unionBranches(pushable, isIndexedPath) ?? [pushable];
    const seen = new Set<string>();
    const out: Doc[] = [];
    for (const alternative of alternatives) {
      const pushed = [buildWhere(alternative), ...presenceSql].filter((part): part is Where => part !== null);
      let after = '';
      for (;;) {
        const { rows } = await this.client().queryValues(
          this.namespace,
          `SELECT kdb_id, ${columns.join(', ')} FROM ${this.table} WHERE _c = ?${pushed.map((part) => ` AND (${part.sql})`).join('')} AND kdb_id > ? ORDER BY kdb_id LIMIT ${LEAN_PAGE_ROWS}`,
          [this.name, ...pushed.flatMap((part) => part.args), after]
        );
        for (const row of rows) {
          const key = String(row[0]);
          if (seen.has(key)) continue;
          seen.add(key);
          const nulls = new Set(Array.isArray(row[2]) ? (row[2] as string[]) : []);
          const partial: Doc = { _id: row[1] };
          [...fields].forEach((field, i) => {
            const value = row[i + 3];
            if (value === null || value === undefined) {
              if (nulls.has(field)) partial[field] = null;
            } else {
              partial[field] = this.isBooleanField(field) && typeof value === 'number' ? value !== 0 : value;
            }
          });
          for (const field of this.packed) if (typeof partial[field] === 'string') partial[field] = unpackNumbers(partial[field] as string);
          const doc = reviveDates(this.schema, partial) as Doc;
          if (matchesFilter(doc, residual)) out.push(doc);
        }
        if (rows.length < LEAN_PAGE_ROWS) break;
        after = String(rows[rows.length - 1]![0]);
      }
    }
    out.sort((a, b) => (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0));
    return { docs: applySort(out, sort), approximate: present.length > 0 };
  }

  /** The packed fields `filter` names only at its top level, and only as `{$exists: true, $ne: []}`. */
  private presenceOnly(filter: Filter): string[] {
    return Object.entries(filter)
      .filter(([key, condition]) => {
        if (!this.packed.has(key) || !isPlainObject(condition)) return false;
        const ops = Object.keys(condition).sort();
        return ops.join() === '$exists,$ne' && condition.$exists === true && Array.isArray(condition.$ne) && condition.$ne.length === 0;
      })
      .map(([key]) => key);
  }

  /** One page of `find`, chosen on lean documents and then fetched whole by key. */
  private async leanPage(filter: Filter, options: FindOptions): Promise<T[] | null> {
    let lean: { docs: Doc[]; approximate: boolean } | null;
    try {
      // An approximate choice is only safe without a skip: a wrong document among the skipped ones
      // would shift the page unseen, while one inside the page is caught below.
      lean = await this.leanMatches(filter, options.sort, !options.skip);
    } catch (error) {
      // A field SQL could not select (a reserved word, say) is not worth failing the read over.
      if ((error as { code?: string }).code === 'INVALID_ARGUMENT' || /parse|syntax/i.test((error as Error).message)) return null;
      throw error;
    }
    if (lean === null) return null;
    const ids = lean.docs.slice(options.skip ?? 0, (options.skip ?? 0) + options.limit!).map((doc) => String(doc._id));
    if (ids.length === 0) return [];
    const byId = new Map((await this.scan({ _id: { $in: ids } })).map((doc) => [String(doc._id), doc]));
    // A document changed between the two reads is judged as it is now.
    let docs = ids.map((id) => byId.get(id)).filter((doc): doc is T => doc !== undefined && matchesFilter(doc, filter));
    // A page chosen approximately that lost a document may be short of one that belonged in it:
    // decide it again on whole documents.
    if (lean.approximate && docs.length < ids.length) return null;
    if (options.select) docs = docs.map((doc) => applyProjection(doc, options.select) as T);
    return docs;
  }

  /**
   * Whether a filter may be pushed to the server. Not when it names a packed field: SQL sees the
   * packed string, so a pushed condition on it could wrongly exclude a match. No query in qtask
   * filters on an embedding; this keeps one from going wrong if it ever does.
   */
  private canPush(filter: Filter): boolean {
    if (!config.kdb.pushdown) return false;
    if (this.packed.size === 0) return true;
    const fields = topLevelFields(filter);
    return fields !== null && ![...fields].some((field) => this.packed.has(field));
  }

  /**
   * The part of a filter a scan may push, or null when pushdown is off: the filter without its
   * conditions on packed fields. Leaving a condition out only widens what the SQL matches, and the
   * engine re-checks every row, so the rest still narrows the read. Refusing the whole filter
   * instead turned search's "tasks with an embedding" into a read of every task (27 s at 100k).
   * Exact counts still go through canPush: a count has nobody to re-check it.
   */
  private pushable(filter: Filter): Filter | null {
    if (!config.kdb.pushdown) return null;
    return this.packed.size === 0 ? filter : withoutFields(filter, this.packed);
  }

  private isBooleanField(field: string): boolean {
    return (this.schema.path(field) as unknown as { instance?: string } | undefined)?.instance === 'Boolean';
  }

  /** A stored body back to the application's document: bookkeeping fields off, dates revived. */
  private decode(stored: Doc): T {
    const { _c: _discriminator, [EXPIRE_FIELD]: _expireAt, [NULLS_FIELD]: _nulls, ...withKeys } = stored;
    // The synthetic fields that carry unique constraints are the store's, not the document's.
    const body = Object.fromEntries(Object.entries(withKeys).filter(([key]) => !key.startsWith('_u_')));
    for (const field of this.packed) if (typeof body[field] === 'string') body[field] = unpackNumbers(body[field] as string);
    return reviveDates(this.schema, body) as T;
  }

  /**
   * One document by id through KDB's keyed read, which does not scan. Returns null for a
   * missing document and for one that belongs to another collection - ids are unique across the
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

  private async matching(filter: Filter): Promise<T[]> {
    // A filter that names the document is a keyed read, whatever else it says: fetch it and let
    // the engine apply the rest. Without this a conditional update by id ({_id, status: 'open'})
    // would scan the whole collection to find one document.
    if (typeof filter._id === 'string') {
      const doc = await this.fetchById(filter._id);
      return doc && matchesFilter(doc, filter) ? [doc] : [];
    }
    // `_id: {$in: []}` matches nothing, whatever the rest says; no need to read the collection.
    if (isPlainObject(filter._id) && Array.isArray((filter._id as Doc).$in) && ((filter._id as Doc).$in as unknown[]).length === 0) {
      return [];
    }
    const docs = await this.scan(filter);
    return docs.filter((doc) => matchesFilter(doc, filter));
  }

  async find(filter: Filter = {}, options: FindOptions = {}): Promise<T[]> {
    // A page (or the first match) of a larger set: decide which documents on their filter and
    // sort fields alone, then fetch only those whole. Fetching every match whole to keep a few
    // is what made a heavy user's task list, or a queue claim, take seconds (each task carries a
    // 768-number embedding).
    if (options.limit !== undefined && typeof filter._id !== 'string') {
      const page = await this.leanPage(filter, options);
      if (page !== null) return page;
    }
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
    // A count the server can answer exactly is asked of the server, rather than fetching every
    // matching document (each task carries a 768-number embedding) to count them here. A list
    // page's total is such a count, with the same access filter as the page; the whole collection
    // (an empty filter) is one too.
    if (this.canPush(filter) && typeof filter._id !== 'string') {
      const counted = await this.countOnServer(filter);
      if (counted !== null) return counted;
    }
    if (typeof filter._id !== 'string') {
      const lean = await this.leanMatches(filter, undefined);
      if (lean !== null) return lean.docs.length;
    }
    return (await this.matching(filter)).length;
  }

  /** The count from the server, or null when the filter has no exact SQL form (exactWhere). */
  private async countOnServer(filter: Filter): Promise<number | null> {
    const kindOf = (path: string) => pathKind(this.schema, path);
    const where = (sql: Where) => `SELECT %s FROM ${this.table} WHERE _c = ?${sql.sql ? ` AND (${sql.sql})` : ''}`;
    // A disjunction is counted branch by branch, by id, for the reason scan asks it that way.
    const branches = unionBranches(filter, isIndexedPath);
    const exactBranches = branches?.map((branch) => exactWhere(branch, kindOf));
    if (exactBranches && exactBranches.every((branch): branch is Where => branch !== null)) {
      const ids = new Set<string>();
      for (const branch of exactBranches) {
        const pages = this.client().queryRawPages(this.namespace, where(branch).replace('%s', 'kdb_id'), [this.name, ...branch.args], SCAN_PAGE_ROWS);
        for await (const { rows } of pages) for (const row of rows) ids.add(row[0]!);
      }
      return ids.size;
    }
    const exact = exactWhere(filter, kindOf);
    if (!exact) return null;
    const { rows } = await this.client().queryRaw(this.namespace, where(exact).replace('%s', 'COUNT(*)'), [this.name, ...exact.args]);
    return Number(rows[0]?.[0] ?? 0);
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
      const [candidate] = await this.find(filter, { ...(options.sort ? { sort: options.sort } : {}), limit: 1 });
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
    const atomic = this.atomicClaimSql(filter, update, options);
    if (atomic) {
      const { rows } = await this.client().execReturning(this.namespace, atomic.sql, atomic.args);
      const body = rows[0]?.[1];
      if (body !== undefined && body !== null) return this.decode((typeof body === 'string' ? JSON.parse(body) : body) as Doc);
      // Nothing matched. Unless the statement narrowed the filter, that is the answer.
      if (!atomic.narrowed) return null;
    }
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const [candidate] = await this.find(filter, { ...(options.sort ? { sort: options.sort } : {}), limit: 1 });
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

  /**
   * A queue claim as one server statement, `UPDATE … WHERE … ORDER BY <field> LIMIT 1 RETURNING`,
   * or null when it cannot be promised to do exactly what the read-then-write path does. The
   * server picks, updates and returns the document at the front of its write gate, so two claims
   * never take the same one and none fails for another having committed first. The read-then-write
   * path read every pending job's lean row to find the oldest (125-230 ms at 15k pending jobs on
   * KDB 0.9.1), and its conditional writes collided more the more workers claimed.
   *
   * Nothing re-checks the server's choice, so only what SQL evaluates exactly as Mongo does is
   * accepted, and anything else falls back:
   *  - the filter: exactWhere's equalities on text paths, plus equalities and ranges of finite
   *    numbers on top-level Number paths (a missing or null field matches neither, in both);
   *  - the sort: one top-level Date or Number field (missing and null sort first ascending, last
   *    descending, in both);
   *  - the update: `$set` of strings, booleans, finite numbers or dates on top-level paths whose
   *    schema type has no casting or validation beyond its enum, and `$inc` of a number field.
   *    SQL's `x + 1` on a missing or null field stores null where Mongo stores 1, and KDB has
   *    neither COALESCE nor CASE, so the field must be a number: either the filter requires it, or
   *    the schema gives it a numeric default (every write the store or Mongoose makes includes it)
   *    and the statement requires it too - `narrowed`, and an empty answer then falls back to the
   *    read-then-write path, so a document missing the field is still found. No unique, packed or
   *    expiry field, which the store derives other fields from;
   *  - no upsert, and the document after the update.
   */
  private atomicClaimSql(filter: Filter, update: Update, options: UpdateOptions): (Where & { narrowed: boolean }) | null {
    if (!config.kdb.atomicClaim || !config.kdb.pushdown || options.upsert || options.returnDocument === 'before') return null;
    const sortKeys = Object.entries(options.sort ?? {});
    if (sortKeys.length !== 1) return null;
    const [sortField, direction] = sortKeys[0]! as [string, unknown];
    if ((direction !== 1 && direction !== -1) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(sortField)) return null;
    const instanceOf = (path: string) => (this.schema.path(path) as unknown as { instance?: string } | undefined)?.instance;
    if (instanceOf(sortField) !== 'Date' && instanceOf(sortField) !== 'Number') return null;

    const where: Where[] = [];
    const numericFields = new Set<string>();
    for (const [key, condition] of Object.entries(filter)) {
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && instanceOf(key) === 'Number') {
        const conditions = isPlainObject(condition) ? Object.entries(condition as Doc) : [['$eq', condition] as [string, unknown]];
        for (const [operator, operand] of conditions) {
          const sqlOperator = operator === '$eq' ? '=' : RANGE_SQL[operator];
          if (!sqlOperator || typeof operand !== 'number' || !Number.isFinite(operand)) return null;
          where.push({ sql: `${key} ${sqlOperator} ?`, args: [operand] });
        }
        numericFields.add(key);
      } else {
        const exact = exactWhere({ [key]: condition }, (path) => pathKind(this.schema, path));
        if (!exact || !exact.sql) return null;
        where.push(exact);
      }
    }

    let narrowed = false;
    const derived = new Set<string>([...this.packed, ...this.unique.flatMap((constraint) => constraint.fields.map((field) => field.split('.')[0]!))]);
    if (this.ttl) derived.add(this.ttl.path.split('.')[0]!);
    const settable = (field: string) => /^[A-Za-z][A-Za-z0-9]*$/.test(field) && field !== '_id' && !derived.has(field);
    const sets: Where[] = [];
    for (const [operator, fields] of Object.entries(update)) {
      if (!isPlainObject(fields)) return null;
      for (const [field, value] of Object.entries(fields as Doc)) {
        if (!settable(field) || sets.some((set) => set.sql.startsWith(`${field} =`))) return null;
        if (operator === '$set') {
          const stored = this.claimSetValue(field, value);
          if (stored === undefined) return null;
          sets.push({ sql: `${field} = ?`, args: [stored] });
        } else if (operator === '$inc') {
          if (typeof value !== 'number' || !Number.isFinite(value)) return null;
          if (!numericFields.has(field)) {
            const type = this.schema.path(field) as unknown as { instance?: string; options?: { default?: unknown } } | undefined;
            if (type?.instance !== 'Number' || typeof type.options?.default !== 'number') return null;
            where.push({ sql: `${field} IS NOT MISSING AND ${field} IS NOT NULL`, args: [] });
            narrowed = true;
          }
          sets.push({ sql: `${field} = ${field} + ?`, args: [value] });
        } else {
          return null;
        }
      }
    }
    if (sets.length === 0) return null;
    const stamped = touchUpdatedAt(this.schema, {});
    if (stamped.updatedAt instanceof Date && !sets.some((set) => set.sql.startsWith('updatedAt ='))) {
      sets.push({ sql: 'updatedAt = ?', args: [stamped.updatedAt.toISOString()] });
    }

    return {
      sql:
        `UPDATE ${this.table} SET ${sets.map((set) => set.sql).join(', ')}` +
        ` WHERE _c = ?${where.map((part) => ` AND (${part.sql})`).join('')}` +
        ` ORDER BY ${sortField}${direction === -1 ? ' DESC' : ''} LIMIT 1 RETURNING kdb_id, _doc`,
      args: [...sets.flatMap((set) => set.args), this.name, ...where.flatMap((part) => part.args)],
      narrowed,
    };
  }

  /** A `$set` value as the store would write it, or undefined when only the schema walk can say:
   *  a path with casting or validation beyond its type and enum, or a value of another type. */
  private claimSetValue(field: string, value: unknown): unknown {
    const type = this.schema.path(field) as unknown as
      | { instance?: string; options?: Record<string, unknown>; enumValues?: unknown[] }
      | undefined;
    if (!type || !Object.keys(type.options ?? {}).every((option) => ['type', 'enum', 'default', 'required', 'index'].includes(option))) return undefined;
    switch (type.instance) {
      case 'String':
        if (typeof value !== 'string') return undefined;
        return type.enumValues && type.enumValues.length > 0 && !type.enumValues.includes(value) ? undefined : value;
      case 'Number':
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      case 'Boolean':
        return typeof value === 'boolean' ? value : undefined;
      case 'Date':
        return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
      default:
        return undefined;
    }
  }

  async findByIdAndUpdate(id: string, update: Update, options: UpdateOptions = {}): Promise<T | null> {
    return this.findOneAndUpdate({ _id: id }, update, options);
  }

  async replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const [candidate] = await this.find(filter, { limit: 1 });
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
      const [candidate] = await this.find(filter, { limit: 1 });
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
      const [candidate] = await this.find(filter, { limit: 1 });
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

  /**
   * `importDocument` for many documents, in one commit: the same bodies, written wholesale.
   *
   * Why: a single-document `replace` is one durable commit, and kdb-service does not share an
   * fsync between concurrent transaction commits (it does for `upsert`), so a backfill made of
   * them runs at the disk's fsync rate - measured at about 45 documents/s on macOS with
   * `--durability sync`, whatever the concurrency. One commit of a few hundred documents costs one
   * fsync. Same guarantees as before: idempotent, stale keys dropped, a unique-constraint violation
   * rejects the commit (as DuplicateKeyError), and either every document in it lands or none does.
   *
   * A commit names the version it was built on; a stale one is rebased by the server, applying only
   * the fields this commit changes, so a concurrent mirrored write to another field survives. The
   * base is the last commit this process saw for the namespace, or (the first time) the commit of
   * the first document, written on its own.
   */
  async importMany(docs: Doc[]): Promise<void> {
    if (docs.length === 0) return;
    for (const doc of docs) {
      if (typeof doc._id !== 'string') throw new Error(`${this.name}: cannot import a document without a string _id`);
    }
    let rest = docs;
    let base = lastCommit.get(this.namespace);
    if (!base) {
      await this.writeDocument(docs[0]!, null);
      base = lastCommit.get(this.namespace);
      rest = docs.slice(1);
      if (rest.length === 0) return;
    }
    try {
      const hash = await this.client().commit({
        namespace: this.namespace,
        baseVersion: base!,
        writes: rest.map((doc) => ({ docId: toDocumentUuid(doc._id as string), body: this.storedBody(doc), replace: true })),
      });
      if (hash) lastCommit.set(this.namespace, hash);
    } catch (error) {
      if ((error as { code?: string }).code === 'UNIQUE_VIOLATION') {
        throw new DuplicateKeyError(`${this.name}: duplicate value for a unique field (${(error as Error).message})`);
      }
      throw error;
    }
  }

  // --- write helpers -------------------------------------------------------------

  /** Runs `fn` while holding the collection's unique-constraint lock, if it has constraints.
   *  Always taken before a document lock, never after, so two writers cannot deadlock. */
  private guardUnique<R>(fn: () => Promise<R>): Promise<R> {
    return this.unique.length > 0 && !this.serverHoldsUnique() ? withLock(`${this.namespace}/${this.name}#unique`, fn) : fn();
  }

  /**
   * Whether the server enforces every unique constraint of this collection (declareConstraints,
   * each carried on its synthetic key). Then the in-process check is only a slower, weaker copy
   * of it - a query per constraint under a collection-wide lock on every write, with no reach
   * across processes - and is skipped: the server's UNIQUE_VIOLATION becomes the same
   * DuplicateKeyError (writeDocument). Measured on the benchmark, that lock and those queries
   * were most of a users write.
   */
  private serverHoldsUnique(): boolean {
    return config.kdb.declareConstraints && this.serverKeys.length === this.unique.length;
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
    const body = this.storedBody(doc);
    try {
      const hash = await this.rebasingOnConflict(
        () => (guard ? this.client().replaceIf(this.namespace, key, body, guard.hash) : this.client().replace(this.namespace, key, body)),
        (baseVersion) =>
          this.client().commit({
            namespace: this.namespace,
            baseVersion,
            writes: [{ docId: key, body, replace: true }],
            ...(guard ? { preconditions: [{ opIndex: 0, kind: 'EXPECT_CONTENT_HASH' as const, contentHashHex: guard.hash }] } : {}),
          })
      );
      if (hash) lastCommit.set(this.namespace, hash);
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

  /** A document as stored: the collection discriminator, the expiry deadline and the synthetic
   *  fields that carry server-held unique constraints, added to the application's fields. */
  private storedBody(doc: Doc): Doc {
    const body: Doc = { ...doc, _c: this.name, ...this.expiry(doc) };
    for (const field of this.packed) if (Array.isArray(doc[field])) body[field] = packNumbers(doc[field] as unknown[]);
    // Which top-level fields hold an explicit null. A SQL read of a field returns NULL for null and
    // for absent alike, and Mongo tells them apart (`$exists`), so the lean read (leanMatches)
    // needs this to rebuild a field exactly.
    const nulls = Object.keys(doc).filter((key) => doc[key] === null);
    if (nulls.length > 0) body[NULLS_FIELD] = nulls;
    for (const { field, paths, arrayPrefix } of this.serverKeys) {
      const value = arrayPrefix ? serverKeyValues(doc, paths, arrayPrefix) : serverKeyValue(doc, paths);
      if (value !== undefined) body[field] = value;
    }
    return body;
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
    const docId = toDocumentUuid(id);
    await this.rebasingOnConflict(
      () => this.client().delete(this.namespace, docId),
      (baseVersion) => this.client().commit({ namespace: this.namespace, baseVersion, writes: [], deletes: [docId] })
    );
  }

  /**
   * Runs a single-document commit, and if the server reports a version conflict, commits the same
   * operation again on the head the conflict names.
   *
   * The client bases each commit on the last head its own session saw. When another process
   * (a second app instance, the migration tool) has since changed the same document, a delete is
   * refused as a conflict - and the client does not move its head on a conflict, so retrying the
   * same call conflicts for ever. The store's operations are already decided against the current
   * document (a keyed read, or a hash precondition that the server checks), so re-basing them on
   * the server's head is what was meant; a commit at that base also moves the client's head on.
   * Bounded, because the head can keep moving under heavy contention.
   */
  private async rebasingOnConflict(first: () => Promise<string>, rebased: (baseVersion: string) => Promise<string>): Promise<string> {
    try {
      return await first();
    } catch (error) {
      let current = error;
      for (let attempt = 0; attempt < 5; attempt++) {
        const target = (current as { targetHash?: string }).targetHash;
        if ((current as Error).constructor.name !== 'KdbConflictError' || !target) throw current;
        try {
          return await rebased(target);
        } catch (next) {
          current = next;
        }
      }
      throw current;
    }
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
    if (this.unique.length === 0 || this.serverHoldsUnique()) return;
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
    // KDB_REQUEST_TIMEOUT_MS raises the client's per-request deadline (30 s by default).
    // The Mac app sets it: opening a store with a few thousand documents can make the
    // first request wait longer than that while kdb-service recovers, and a timeout there
    // is a failed launch rather than a slow one.
    const timeout = Number(process.env.KDB_REQUEST_TIMEOUT_MS);
    this.client = new SerializedDmlClient(
      await connect(config.kdb.addr, {
        // Always an options object: a bare string as the second argument is read as options
        // with no token, so the token was silently dropped and every connection to a server
        // with access control would have been anonymous.
        ...(config.kdb.token ? { token: config.kdb.token } : {}),
        ...(Number.isFinite(timeout) && timeout > 0 ? { requestTimeoutMs: timeout } : {}),
      })
    );
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
   * data already violates one, which is the right place to find out. A constraint through an
   * array of sub-documents (a user's linked identity providers) is carried as an array of
   * per-element keys, which the server enforces element by element (multikey, KDB 0.7.2).
   *
   * Needs a server that installs constraints for CREATE UNIQUE INDEX (KDB 0.7.0 + #147). An older
   * one accepts the statement and enforces nothing; the in-process check still stands, so that
   * costs the extra guarantee, not the existing one.
   */
  private async declareConstraints(): Promise<void> {
    for (const name of Object.keys(MODEL_BY_COLLECTION) as CollectionName[]) {
      for (const { field, paths } of (this.collection(name) as unknown as { serverKeys: Array<{ field: string; paths: string[]; arrayPrefix?: string }> }).serverKeys) {
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
   *  - A unique index is a lookup too (a login finds its user by email, every MCP request its key
   *    by keyHash), so its leading field is indexed like any other; the constraint itself is
   *    declared separately (declareConstraints), on a synthetic field. TTL indexes became server
   *    expiry, and text search is done by the application.
   *  - `_c`, the collection discriminator every query carries: without it, reading a small
   *    collection examines the whole namespace (measured: every collection's unfiltered read cost
   *    the same as reading all 27,000 documents of a rehearsal dataset).
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

  /** Verbatim import of many documents in one commit; see KdbBackedCollection.importMany. */
  async importMany(name: CollectionName, docs: Doc[]): Promise<void> {
    await (this.collection(name) as unknown as KdbBackedCollection<Doc>).importMany(docs);
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
 * A constraint through an array of sub-documents as one key per element, e.g. a user's linked
 * logins `identityProviders.[provider, providerUserId]` as `['["google","1"]', '["github","7"]']`.
 * The server treats an array under a unique constraint as multikey (KDB 0.7.2), so no two users
 * may hold the same login. Pairs are taken within one element, which is what the rule means; an
 * element missing a part claims nothing, and so does an empty list.
 */
function serverKeyValues(doc: Doc, fields: string[], arrayPrefix: string): string[] | undefined {
  const elements = getPath(doc, arrayPrefix);
  if (!Array.isArray(elements)) return undefined;
  const rest = fields.map((field) => field.slice(arrayPrefix.length + 1));
  const keys = new Set<string>();
  for (const element of elements) {
    if (element === null || typeof element !== 'object') continue;
    const value = serverKeyValue(element as Doc, rest);
    if (value !== undefined) keys.add(value);
  }
  return keys.size > 0 ? [...keys] : undefined;
}

/** The array of sub-documents every part of a constraint sits under, when there is exactly one. */
function sharedArrayPrefix(schema: Schema, fields: string[]): string | undefined {
  const prefixes = fields.map((field) => {
    const segments = field.split('.');
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join('.');
      if ((schema.path(prefix) as unknown as { instance?: string } | undefined)?.instance === 'Array') return prefix;
    }
    return undefined;
  });
  const first = prefixes[0];
  return first && prefixes.every((prefix) => prefix === first) ? first : undefined;
}

/**
 * The lookup indexes the Mongoose schemas declare, as path to kind (see declareIndexes for how a
 * MongoDB index maps onto KDB's). Exported for the tests that check what the store asks for.
 */
export function declaredIndexes(): Map<string, 'HASH' | 'BTREE'> {
  // Every query the store sends is `_c = ? AND ...`. Indexing the collection tag bounds a query
  // nothing else serves to its own collection, rather than every document in the namespace.
  const wanted = new Map<string, 'HASH' | 'BTREE'>([['_c', 'HASH']]);
  for (const name of Object.keys(MODEL_BY_COLLECTION) as CollectionName[]) {
    const model = mongoose.models[MODEL_BY_COLLECTION[name]];
    if (!model) continue;
    const schema = model.schema as unknown as Schema;
    const declared = (schema as unknown as { indexes(): Array<[Record<string, unknown>, Record<string, unknown>?]> }).indexes();
    for (const [fields, options] of declared) {
      // A unique index is also how Mongo finds a user by email or a session by token. The
      // constraint itself is held on a synthetic `_u_` field (declareConstraints), which no query
      // names, so the field the queries do name needs a lookup index of its own.
      if (options?.expireAfterSeconds !== undefined) continue;
      const keys = Object.keys(fields);
      if (keys.length === 0 || keys.some((key) => fields[key] === 'text')) continue;
      const lead = keys[0]!;
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(lead)) continue;
      const instance = (schema.path(lead) as unknown as { instance?: string } | undefined)?.instance;
      const kind = instance === 'Date' || instance === 'Number' ? 'BTREE' : 'HASH';
      // A path wanted ordered by any collection is ordered for all of them.
      if (kind === 'BTREE' || !wanted.has(lead)) wanted.set(lead, kind);
      // A compound index's second key, when it is a date or a number, is what the index orders by
      // (`{status: 1, createdAt: 1}`: the oldest pending job). KDB indexes single fields, and since
      // 0.9 walks a BTREE for `ORDER BY <field> LIMIT k` when the WHERE has an index of its own,
      // stopping at the first rows instead of sorting every match: an atomic queue claim at 15k
      // pending jobs went from 44 ms to 10-17 ms. Declared namespace-wide, like every index here.
      const second = keys[1];
      if (second && /^[A-Za-z_][A-Za-z0-9_]*$/.test(second)) {
        const secondInstance = (schema.path(second) as unknown as { instance?: string } | undefined)?.instance;
        if (secondInstance === 'Date' || secondInstance === 'Number') wanted.set(second, 'BTREE');
      }
    }
  }
  return wanted;
}

/**
 * A number array as the server stores it: one string, `f64:` and the base64 of its IEEE 754
 * doubles, so it round-trips exactly. An embedding is 768 numbers, and the server parses every
 * document it examines - each candidate of a query, even one that selects three other fields:
 * profiled at 517k documents, parsing those numbers (strconv.ParseFloat and the array around it)
 * was about 40% of kdb-service's CPU under qtask's workload. A string is one token to skip.
 * An array holding anything but finite numbers is left as it is.
 */
function packNumbers(values: unknown[]): unknown {
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return values;
  return `f64:${Buffer.from(Float64Array.from(values as number[]).buffer).toString('base64')}`;
}

function unpackNumbers(packed: string): unknown {
  if (!packed.startsWith('f64:')) return packed;
  // Copied: a decoded Buffer may sit at an offset a Float64Array cannot start at.
  const bytes = Uint8Array.from(Buffer.from(packed.slice(4), 'base64'));
  return Array.from(new Float64Array(bytes.buffer, 0, bytes.byteLength >> 3));
}

/**
 * The top-level fields a filter looks at, or null when it has an operator that names no field
 * (`$where`, `$expr`, `$text`, ...) and so cannot be decided on chosen fields.
 */
function topLevelFields(filter: Filter): Set<string> | null {
  const out = new Set<string>();
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      if (!Array.isArray(condition)) return null;
      for (const sub of condition as Filter[]) {
        const inner = topLevelFields(sub);
        if (inner === null) return null;
        for (const field of inner) out.add(field);
      }
    } else if (key.startsWith('$')) {
      return null;
    } else {
      out.add(key.split('.')[0]!);
    }
  }
  return out;
}

/**
 * The filter with every condition on the given top-level fields left out, at any depth of
 * `$and`/`$or`, so it matches a superset of what the filter matches. A `$nor` is left out whole:
 * dropping a condition inside one would narrow it instead.
 */
function withoutFields(filter: Filter, fields: Set<string>): Filter {
  const out: Filter = {};
  for (const [key, condition] of Object.entries(filter)) {
    if ((key === '$and' || key === '$or') && Array.isArray(condition)) {
      out[key] = (condition as Filter[]).map((sub) => withoutFields(sub, fields));
    } else if (key === '$nor' || fields.has(key.split('.')[0]!)) {
      continue;
    } else {
      out[key] = condition;
    }
  }
  return out;
}

/** Whether the store declares a lookup index on `path` (cached: the schemas do not change). */
let indexedPaths: Set<string> | undefined;
function isIndexedPath(path: string): boolean {
  if (!config.kdb.declareIndexes) return false;
  indexedPaths ??= new Set(declaredIndexes().keys());
  return indexedPaths.has(path);
}

/**
 * How a schema stores `path` (see PathKind): a string, id or boolean held directly is `text`, one
 * reached through an array - an array of them, or a field of an array of sub-documents - is
 * `textList`, and anything else is `other`.
 */
function pathKind(schema: Schema, path: string, throughArray = false): PathKind {
  const type = schema.path(path) as unknown as
    | { instance?: string; schema?: Schema; caster?: { instance?: string }; embeddedSchemaType?: { instance?: string } }
    | undefined;
  const scalar = (instance?: string) => instance === 'String' || instance === 'ObjectId' || instance === 'Boolean';
  if (type) {
    if (scalar(type.instance)) return throughArray ? 'textList' : 'text';
    if (type.instance === 'Array' && !type.schema) {
      return scalar(type.embeddedSchemaType?.instance ?? type.caster?.instance) ? 'textList' : 'other';
    }
    return 'other';
  }
  // A field of a sub-document schema: resolve the rest of the path in it.
  const segments = path.split('.');
  for (let i = segments.length - 1; i >= 1; i--) {
    const parent = schema.path(segments.slice(0, i).join('.')) as unknown as { instance?: string; schema?: Schema } | undefined;
    if (parent?.schema) {
      return pathKind(parent.schema, segments.slice(i).join('.'), throughArray || parent.instance === 'Array');
    }
  }
  return 'other';
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
  const specifier = process.env.KDB_CLIENT_MODULE ?? '@limidus/kdb-client';
  try {
    const module = (await import(specifier)) as { connect: ConnectFn };
    if (typeof module.connect !== 'function') {
      throw new Error(`${specifier} does not export connect()`);
    }
    return module;
  } catch (error) {
    throw new Error(
      `DATA_KDB=true requires the KDB client. Could not load "${specifier}": ${(error as Error).message}. ` +
        'Set KDB_CLIENT_MODULE to its location, or install @limidus/kdb-client.'
    );
  }
}
