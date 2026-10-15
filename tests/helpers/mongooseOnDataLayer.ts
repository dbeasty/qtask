/**
 * Lets the existing tests seed and inspect data through Mongoose models while the application
 * runs on KDB.
 *
 * Most of the suite arranges its fixtures with `UserModel.create(...)`, asserts with
 * `TaskModel.findOne(...).lean()` and cleans up with `...deleteMany({})`. Those calls go to a
 * Mongo the app is no longer using, so on KDB they either fail outright or - worse - look at an
 * empty database. This routes the handful of model methods the tests actually use to the active
 * data store instead, so an unchanged test arranges and checks the same database the app reads.
 *
 * It is test support, not an emulation of Mongoose: only the methods in use are covered, results
 * are plain objects (no `.save()`, no virtuals), and anything else still fails loudly - because
 * buffering is off in KDB mode - rather than quietly doing the wrong thing. Only installed when
 * QTASK_TEST_BACKEND=kdb (see useKdbBackend.ts).
 */

import mongoose from 'mongoose';
import { MODEL_BY_COLLECTION } from '../../src/data/modelNames.ts';
import type { CollectionName, Collection, Doc, Filter } from '../../src/data/types.ts';

const collectionByModel = new Map<string, CollectionName>(
  (Object.entries(MODEL_BY_COLLECTION) as Array<[CollectionName, string]>).map(([collection, model]) => [model, collection])
);

type ModelLike = { modelName: string };

async function collectionOf(model: ModelLike): Promise<Collection> {
  const name = collectionByModel.get(model.modelName);
  if (!name) throw new Error(`No data-layer collection for model "${model.modelName}"`);
  const { collection } = await import('../../src/data/index.ts');
  return collection(name);
}

/** ObjectIds become the hex strings the data layer uses for ids; everything else is copied. */
function plain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  const maybe = value as unknown as { _bsontype?: string; toHexString?: () => string };
  if (maybe._bsontype === 'ObjectId' || maybe._bsontype === 'ObjectID') return maybe.toHexString!() as unknown as T;
  if (Array.isArray(value)) return value.map((item) => plain(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = plain(inner);
  return out as T;
}

/** Mongoose treats an update with no operators as an implicit `$set`; the data layer, like the
 *  driver, treats it as replacing the whole document. Tests are written against Mongoose. */
function asUpdate(update: Doc): Doc {
  const plainUpdate = plain(update);
  return Object.keys(plainUpdate).some((key) => key.startsWith('$')) ? plainUpdate : { $set: plainUpdate };
}

/** Mongoose documents expose `id` as well as `_id`; tests lean on it. Not stored. */
function withId<T extends Doc | null>(doc: T): T {
  if (doc && typeof doc._id === 'string' && !('id' in doc)) {
    Object.defineProperty(doc, 'id', { value: doc._id, enumerable: false, configurable: true });
  }
  if (doc && !('toObject' in doc)) {
    Object.defineProperty(doc, 'toObject', { value: () => ({ ...doc }), enumerable: false, configurable: true });
  }
  return doc;
}

/** A thenable standing in for a Mongoose Query: `.lean()`, `.sort()`, `.select()`, `.limit()`, `.skip()`. */
class Query<T> implements PromiseLike<T> {
  private sortSpec: Record<string, 1 | -1> | undefined;
  private selectSpec: string | undefined;
  private limitN: number | undefined;
  private skipN: number | undefined;

  constructor(private readonly run: (options: { sort?: Record<string, 1 | -1>; select?: string; limit?: number; skip?: number }) => Promise<T>) {}

  lean(): this {
    return this;
  }
  sort(spec: Record<string, 1 | -1 | 'asc' | 'desc'> | string): this {
    if (typeof spec === 'string') {
      this.sortSpec = Object.fromEntries(spec.split(/\s+/).filter(Boolean).map((f) => (f.startsWith('-') ? [f.slice(1), -1] : [f, 1])));
    } else {
      this.sortSpec = Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v === -1 || v === 'desc' ? -1 : 1]));
    }
    return this;
  }
  select(spec: string): this {
    this.selectSpec = spec;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  skip(n: number): this {
    this.skipN = n;
    return this;
  }
  exec(): Promise<T> {
    return this.run({ sort: this.sortSpec, select: this.selectSpec, limit: this.limitN, skip: this.skipN });
  }
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

/** The statics routed to the data layer. */
const ROUTED = [
  'create', 'insertMany', 'find', 'findOne', 'findById', 'countDocuments', 'deleteMany', 'deleteOne',
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate',
] as const;

/**
 * Whether the call being made came from test code rather than from the application. In shadow
 * mode MongoDB is the primary and the Mongo adapter *itself* calls `Model.find` and friends, so
 * routing every call to the data layer would send the adapter back into itself. The first stack
 * frame that is not this file, a dependency or Node decides.
 *
 * Except when the Mongo adapter is anywhere on the stack. A test that spies on a model method
 * (`UserModel.find = (...args) => { calls++; return originalFind(...args); }`) puts its own frame
 * between the adapter and this file, and taken at its word that call is the test's: it goes to
 * the data layer, whose Mongo primary calls the spy again, and so on for ever - one microtask
 * at a time, so the process spins without ever reaching a timer or exiting.
 */
function callerIsTest(): boolean {
  const frames = (new Error().stack ?? '').split('\n').slice(2);
  if (frames.some((frame) => frame.includes('/src/data/mongo/'))) return false;
  for (const frame of frames) {
    if (frame.includes('mongooseOnDataLayer') || frame.includes('node_modules') || frame.includes('node:internal')) continue;
    return frame.includes('/tests/');
  }
  return false;
}

export function installMongooseOnDataLayer(options: { mongoConnected?: boolean } = {}): void {
  const M = mongoose.Model as unknown as Record<string, unknown>;
  const originals = Object.fromEntries(ROUTED.map((name) => [name, M[name]])) as Record<string, (...args: unknown[]) => unknown>;
  const originalsMongo = options.mongoConnected ? originals : undefined;

  M.create = async function (this: ModelLike, docs: unknown, ...rest: unknown[]) {
    const coll = await collectionOf(this);
    // Mongoose accepts create(doc), create([docs]) and create(doc1, doc2).
    const many = Array.isArray(docs);
    const inputs = many ? (docs as unknown[]) : [docs, ...rest.filter((r) => r && typeof r === 'object' && !('session' in (r as object)))];
    const out: Doc[] = [];
    for (const input of inputs) out.push(withId(await coll.create(plain(input) as Doc)));
    return many ? out : out[0];
  };

  M.insertMany = async function (this: ModelLike, docs: unknown[]) {
    const coll = await collectionOf(this);
    return (await coll.insertMany(plain(docs) as Doc[])).map(withId);
  };

  M.find = function (this: ModelLike, filter: Filter = {}) {
    return new Query(async (o) => (await (await collectionOf(this)).find(plain(filter), o)).map(withId));
  };

  M.findOne = function (this: ModelLike, filter: Filter = {}) {
    return new Query(async (o) => withId(await (await collectionOf(this)).findOne(plain(filter), o)));
  };

  M.findById = function (this: ModelLike, id: unknown) {
    return new Query(async (o) => withId(await (await collectionOf(this)).findById(String(plain(id)), o)));
  };

  M.countDocuments = function (this: ModelLike, filter: Filter = {}) {
    return new Query(async () => (await collectionOf(this)).countDocuments(plain(filter)));
  };

  M.deleteMany = function (this: ModelLike, filter: Filter = {}) {
    return new Query(async () => {
      const { deleted } = await (await collectionOf(this)).deleteMany(plain(filter));
      return { acknowledged: true, deletedCount: deleted };
    });
  };

  M.deleteOne = function (this: ModelLike, filter: Filter = {}) {
    return new Query(async () => {
      const { deleted } = await (await collectionOf(this)).deleteOne(plain(filter));
      return { acknowledged: true, deletedCount: deleted };
    });
  };

  const updateResult = (r: { matched: number; modified: number; upsertedId?: string }) => ({
    acknowledged: true,
    matchedCount: r.matched,
    modifiedCount: r.modified,
    upsertedId: r.upsertedId,
  });

  M.updateOne = function (this: ModelLike, filter: Filter, update: Doc, options?: { upsert?: boolean; timestamps?: boolean }) {
    // `{ timestamps: false }` is a Mongoose feature the data layer does not have. With MongoDB
    // really connected (shadow mode) the real method does exactly that, so use it.
    if (options?.timestamps === false && originalsMongo) return originalsMongo.updateOne.apply(this, [filter, update, options]);
    return new Query(async () => {
      const coll = await collectionOf(this);
      const result = updateResult(await coll.updateOne(plain(filter), asUpdate(update), options));
      // `{ timestamps: false }` is how a test backdates `updatedAt` (Mongoose would otherwise
      // stamp "now"). The store always stamps, so write the requested value back verbatim.
      const wanted = (update as { $set?: { updatedAt?: Date } }).$set?.updatedAt;
      if (options?.timestamps === false && wanted && result.matchedCount > 0) {
        const { getDataStore } = await import('../../src/data/index.ts');
        const store = getDataStore() as unknown as { importDocument?: (name: CollectionName, doc: Doc) => Promise<void> };
        const found = await coll.findOne(plain(filter));
        if (found && store.importDocument) {
          await store.importDocument(collectionByModel.get(this.modelName)!, { ...found, updatedAt: wanted });
        }
      }
      return result;
    });
  };

  M.updateMany = function (this: ModelLike, filter: Filter, update: Doc) {
    return new Query(async () => updateResult(await (await collectionOf(this)).updateMany(plain(filter), asUpdate(update))));
  };

  M.findOneAndUpdate = function (this: ModelLike, filter: Filter, update: Doc, options?: { new?: boolean; upsert?: boolean }) {
    return new Query(async () =>
      withId(
        await (await collectionOf(this)).findOneAndUpdate(plain(filter), asUpdate(update), {
          upsert: options?.upsert,
          returnDocument: options?.new ? 'after' : 'before',
        })
      )
    );
  };

  M.findByIdAndUpdate = function (this: ModelLike, id: unknown, update: Doc, options?: { new?: boolean; upsert?: boolean }) {
    return new Query(async () =>
      withId(
        await (await collectionOf(this)).findByIdAndUpdate(String(plain(id)), asUpdate(update), {
          upsert: options?.upsert,
          returnDocument: options?.new ? 'after' : 'before',
        })
      )
    );
  };

  if (options.mongoConnected) {
    for (const name of ROUTED) {
      const routed = M[name] as (...args: unknown[]) => unknown;
      M[name] = function (this: unknown, ...args: unknown[]) {
        return (callerIsTest() ? routed : originals[name]).apply(this, args);
      };
    }
  }

  // `await mongoose.connection.dropDatabase()` and `mongoose.connection.db?.dropDatabase()`
  // between tests. The second is optional-chained, so without a `db` it would silently clean
  // nothing and let one test's data leak into the next.
  const dropDatabase = async () => {
    const { getDataStore } = await import('../../src/data/index.ts');
    await getDataStore().clear();
  };
  (mongoose.connection as unknown as Record<string, unknown>).dropDatabase = dropDatabase;
  if (options.mongoConnected) {
    // Mongo really is connected (shadow mode): leave `db` to the driver, which assigns it on
    // connect, and make its dropDatabase clear both stores so they do not drift apart.
    mongoose.connection.once('open', () => {
      const db = mongoose.connection.db as unknown as Record<string, unknown> | undefined;
      if (db) db.dropDatabase = dropDatabase;
    });
  } else {
    Object.defineProperty(mongoose.connection, 'db', { value: { dropDatabase }, configurable: true });
  }
}
