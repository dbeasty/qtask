/**
 * Shadow writes: stage 2 of the backend migration.
 *
 * The properties under test are the ones the design depends on, not the happy path:
 * the shadow must receive every write in order and under the primary's identities,
 * and it must be incapable of affecting the request — not when it errors, not when
 * it is slow, not when it is missing entirely.
 *
 * The shadow here is an in-memory fake rather than a real backend. Both real
 * backends are already checked against each other by the conformance suite; what
 * this file tests is the mirroring behaviour, and a fake is what makes failure,
 * latency and saturation reproducible.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { ShadowDataStore } from '../src/data/shadow/store.ts';
import { ShadowQueue } from '../src/data/shadow/queue.ts';
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
} from '../src/data/types.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

/** Records what the shadow was asked to do, and can be made to fail or stall. */
class RecordingCollection implements Collection<Doc> {
  readonly calls: Array<{ op: string; args: unknown[] }> = [];
  readonly docs = new Map<string, Doc>();
  failNext = false;
  gate: Promise<void> | undefined;

  constructor(readonly name: CollectionName) {}

  private async record(op: string, args: unknown[]): Promise<void> {
    if (this.gate) await this.gate;
    this.calls.push({ op, args });
    if (this.failNext) {
      this.failNext = false;
      throw new Error(`shadow ${op} failed`);
    }
  }

  async find(): Promise<Doc[]> {
    this.calls.push({ op: 'find', args: [] });
    return [];
  }
  async findOne(): Promise<Doc | null> {
    this.calls.push({ op: 'findOne', args: [] });
    return null;
  }
  async findById(id: string): Promise<Doc | null> {
    return this.docs.get(id) ?? null;
  }
  async countDocuments(): Promise<number> {
    this.calls.push({ op: 'countDocuments', args: [] });
    return 0;
  }
  async distinct(): Promise<unknown[]> {
    this.calls.push({ op: 'distinct', args: [] });
    return [];
  }

  async create(doc: Doc): Promise<Doc> {
    await this.record('create', [doc]);
    this.docs.set(String(doc._id), doc);
    return doc;
  }
  async insertMany(docs: Doc[]): Promise<Doc[]> {
    await this.record('insertMany', [docs]);
    for (const doc of docs) this.docs.set(String(doc._id), doc);
    return docs;
  }
  async updateOne(filter: Filter, update: Update, options?: UpdateOptions): Promise<UpdateResult> {
    await this.record('updateOne', [filter, update, options]);
    return { matched: 1, modified: 1 };
  }
  async updateMany(filter: Filter, update: Update): Promise<UpdateResult> {
    await this.record('updateMany', [filter, update]);
    return { matched: 0, modified: 0 };
  }
  async findOneAndUpdate(filter: Filter, update: Update, options?: UpdateOptions): Promise<Doc | null> {
    await this.record('findOneAndUpdate', [filter, update, options]);
    return null;
  }
  async findByIdAndUpdate(id: string, update: Update): Promise<Doc | null> {
    await this.record('findByIdAndUpdate', [id, update]);
    return null;
  }
  async replaceOne(filter: Filter, doc: Doc): Promise<UpdateResult> {
    await this.record('replaceOne', [filter, doc]);
    this.docs.set(String(doc._id ?? (filter as { _id?: string })._id), doc);
    return { matched: 1, modified: 1 };
  }
  async deleteOne(filter: Filter): Promise<DeleteResult> {
    await this.record('deleteOne', [filter]);
    return { deleted: 1 };
  }
  async deleteMany(filter: Filter): Promise<DeleteResult> {
    await this.record('deleteMany', [filter]);
    return { deleted: 0 };
  }
  async findOneAndDelete(filter: Filter): Promise<Doc | null> {
    await this.record('findOneAndDelete', [filter]);
    return null;
  }
  async bulkWrite(operations: BulkOperation[]): Promise<UpdateResult> {
    await this.record('bulkWrite', [operations]);
    return { matched: 0, modified: 0 };
  }
}

class RecordingStore implements DataStore {
  readonly backend = 'kdb' as const;
  readonly collections = new Map<CollectionName, RecordingCollection>();
  connectShouldFail = false;
  connected = false;

  async connect(): Promise<void> {
    if (this.connectShouldFail) throw new Error('shadow refused the connection');
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  collection<T extends Doc = Doc>(name: CollectionName): Collection<T> {
    let existing = this.collections.get(name);
    if (!existing) {
      existing = new RecordingCollection(name);
      this.collections.set(name, existing);
    }
    return existing as unknown as Collection<T>;
  }
  async clear(): Promise<void> {
    for (const collection of this.collections.values()) {
      collection.calls.length = 0;
      collection.docs.clear();
    }
  }
  tasks(): RecordingCollection {
    return this.collection('tasks') as unknown as RecordingCollection;
  }
}

let mongo: MongoMemoryServer;
let primary: DataStore;
let shadow: RecordingStore;
let store: ShadowDataStore;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.DATA_MONGO = 'true';
  delete process.env.DATA_KDB;

  await import('../src/models/index.ts');
  const { MongoDataStore } = await import('../src/data/mongo/store.ts');
  primary = new MongoDataStore();
  shadow = new RecordingStore();
  store = new ShadowDataStore(primary, shadow);
  await store.connect();
});

after(async () => {
  await store.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await store.clear();
});

describe('shadow writes', () => {
  it('answers reads from the primary and never asks the shadow', async () => {
    await store.collection('tasks').create({ userId: 'u1', title: 'read me' });
    await store.drainShadow();
    shadow.tasks().calls.length = 0;

    const found = await store.collection('tasks').find({ title: 'read me' });
    assert.equal(found.length, 1);
    assert.deepEqual(shadow.tasks().calls, [], 'a read reached the shadow');
  });

  it('mirrors the document the primary stored, with its id and timestamps', async () => {
    const created = await store.collection('tasks').create({ userId: 'u1', title: 'mirrored' });
    await store.drainShadow();

    const mirrored = shadow.tasks().calls.find((call) => call.op === 'create');
    assert.ok(mirrored, 'the create was not mirrored');

    const doc = mirrored.args[0] as Doc;
    assert.equal(doc._id, created._id, 'shadow minted its own id');
    assert.equal(doc.title, 'mirrored');
    assert.deepEqual(doc.createdAt, created.createdAt, 'shadow stamped its own createdAt');
    // Defaults resolved by the primary travel too, so the shadow does not have to
    // re-derive them and agree by luck.
    assert.equal(doc.status, 'todo');
  });

  it('mirrors updates, deletes and bulk writes', async () => {
    const tasks = store.collection('tasks');
    const created = await tasks.create({ userId: 'u1', title: 'busy' });
    await tasks.updateOne({ _id: created._id }, { $set: { status: 'done' } });
    await tasks.findOneAndUpdate({ _id: created._id }, { $set: { priority: 'high' } });
    await tasks.bulkWrite([
      { updateOne: { filter: { _id: created._id }, update: { $set: { sortOrder: 3 } } } },
    ]);
    await tasks.deleteOne({ _id: created._id });
    await store.drainShadow();

    assert.deepEqual(
      shadow.tasks().calls.map((call) => call.op),
      ['create', 'updateOne', 'findOneAndUpdate', 'bulkWrite', 'deleteOne']
    );
  });

  it('applies mirrored writes in the order they were issued', async () => {
    const tasks = store.collection('tasks');
    // Hold the shadow so every write queues up before any is applied — the case
    // where a concurrent mirror would reorder a create behind its own update.
    let release: () => void = () => {};
    shadow.tasks().gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const created = await tasks.create({ userId: 'u1', title: 'ordered' });
    for (const status of ['in_progress', 'done', 'cancelled']) {
      await tasks.updateOne({ _id: created._id }, { $set: { status } });
    }

    release();
    shadow.tasks().gate = undefined;
    await store.drainShadow();

    const ops = shadow.tasks().calls.map((call) => call.op);
    assert.deepEqual(ops, ['create', 'updateOne', 'updateOne', 'updateOne']);

    const statuses = shadow
      .tasks()
      .calls.filter((call) => call.op === 'updateOne')
      .map((call) => ((call.args[1] as { $set: { status: string } }).$set.status));
    assert.deepEqual(statuses, ['in_progress', 'done', 'cancelled']);
  });

  it('does not fail the request when the shadow write throws', async () => {
    // The queue's counters are cumulative for the life of the store, so every
    // assertion here is a delta. Asserting absolutes would couple these tests to
    // the order they happen to run in.
    const before = store.stats();
    shadow.tasks().failNext = true;

    const created = await store.collection('tasks').create({ userId: 'u1', title: 'survives' });
    await store.drainShadow();

    assert.ok(created._id, 'the primary write did not succeed');
    assert.equal((await store.collection('tasks').findById(String(created._id)))?.title, 'survives');
    assert.equal(store.stats().failed - before.failed, 1);
    assert.match(store.stats().lastError ?? '', /shadow create failed/);
  });

  it('keeps mirroring after a shadow failure', async () => {
    const tasks = store.collection('tasks');
    const before = store.stats();
    shadow.tasks().failNext = true;

    await tasks.create({ userId: 'u1', title: 'first' });
    await tasks.create({ userId: 'u1', title: 'second' });
    await store.drainShadow();

    // One failed, the next still went through: a failing shadow write must not
    // wedge the queue behind it.
    assert.equal(store.stats().failed - before.failed, 1);
    assert.equal(store.stats().applied - before.applied, 1);
    assert.equal(shadow.tasks().calls.filter((c) => c.op === 'create').length, 2);
  });

  it('does not make the request wait on a slow shadow', async () => {
    let release: () => void = () => {};
    shadow.tasks().gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const started = Date.now();
    await store.collection('tasks').create({ userId: 'u1', title: 'not blocked' });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1000, `the request waited ${elapsed}ms on the shadow`);
    assert.ok(store.stats().pending >= 0);

    release();
    shadow.tasks().gate = undefined;
    await store.drainShadow();
  });

  it('reports the primary as the backend it is reading from', () => {
    assert.equal(store.backend, 'mongo');
    assert.equal(store.shadowBackend, 'kdb');
  });
});

describe('shadow queue saturation', () => {
  it('drops rather than growing without bound, and counts the drops', async () => {
    const queue = new ShadowQueue(2);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The first push starts running immediately and clears the queue slot, so five
    // pushes against a cap of two leaves two queued and the rest refused.
    for (let i = 0; i < 5; i++) queue.push(`op-${i}`, () => gate);

    const saturated = queue.stats();
    assert.equal(saturated.dropped, 5 - saturated.enqueued);
    assert.ok(saturated.dropped > 0, 'a full queue accepted everything');
    assert.ok(saturated.enqueued <= 3, `queue held ${saturated.enqueued} with a cap of 2`);

    release();
    await queue.drain();
    assert.equal(queue.stats().pending, 0);
  });

  it('counts applied and failed separately from dropped', async () => {
    const queue = new ShadowQueue(10);
    queue.push('ok', async () => undefined);
    queue.push('bad', async () => {
      throw new Error('nope');
    });
    await queue.drain();

    const stats = queue.stats();
    assert.equal(stats.applied, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.dropped, 0);
    assert.equal(stats.lastError, 'nope');
  });
});

describe('shadow availability', () => {
  it('starts on the primary alone when the shadow will not connect', async () => {
    const brokenShadow = new RecordingStore();
    brokenShadow.connectShouldFail = true;
    const { MongoDataStore } = await import('../src/data/mongo/store.ts');
    const standalone = new ShadowDataStore(new MongoDataStore(), brokenShadow);

    const { ShadowUnavailableError } = await import('../src/data/shadow/store.ts');
    await assert.rejects(() => standalone.connect(), (error: unknown) => {
      assert.ok(error instanceof ShadowUnavailableError);
      return true;
    });
  });
});
