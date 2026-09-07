/**
 * Shadow reads: stage 3 of the backend migration.
 *
 * The comparator has one job — say "these two backends disagree" only when they
 * actually do. So the tests come in two halves: it must catch every kind of real
 * disagreement, and it must not cry wolf on the differences that are structural.
 *
 * The case worth reading closely is "does not report queue lag as divergence".
 * Mirrored writes are applied out of band, so at any instant the shadow is behind
 * the primary by whatever is still queued. A comparator that read the shadow
 * directly would flag that on every read following a write, and a bake would drown
 * in false positives — which is the failure mode that makes a stage like this
 * worthless.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

import {
  compareCounts,
  compareDocLists,
  compareDocs,
  compareValueSets,
} from '../src/data/shadow/compare.ts';
import type { DataStore, Doc } from '../src/data/types.ts';
import type { ShadowDataStore } from '../src/data/shadow/store.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

describe('divergence detection', () => {
  const q = { filter: {} };

  it('reports nothing when the lists match', () => {
    const docs = [{ _id: 'a', title: 'x' }];
    assert.equal(compareDocLists('tasks', 'find', q, docs, [{ _id: 'a', title: 'x' }]), null);
  });

  it('catches a document the shadow is missing', () => {
    const result = compareDocLists('tasks', 'find', q, [{ _id: 'a' }, { _id: 'b' }], [{ _id: 'a' }]);
    assert.equal(result?.kind, 'missing');
    assert.deepEqual(result?.ids, ['b']);
  });

  it('catches a document only the shadow has', () => {
    const result = compareDocLists('tasks', 'find', q, [{ _id: 'a' }], [{ _id: 'a' }, { _id: 'b' }]);
    assert.equal(result?.kind, 'unexpected');
    assert.deepEqual(result?.ids, ['b']);
  });

  it('catches the same documents in a different order when a sort was asked for', () => {
    const result = compareDocLists(
      'tasks',
      'find',
      q,
      [{ _id: 'a' }, { _id: 'b' }],
      [{ _id: 'b' }, { _id: 'a' }],
      true
    );
    // Order is its own kind: a caller paginating on a sort gets different pages
    // from the two backends, which is a different bug from a missing document.
    assert.equal(result?.kind, 'order');
  });

  it('separates order differences on a query that asked for no sort', () => {
    // Mongo's natural order is not a promise, so this is not a disagreement — but a
    // caller relying on it would still behave differently after a flip, so it is
    // reported under its own kind rather than passed off as a match.
    const result = compareDocLists(
      'tasks',
      'find',
      q,
      [{ _id: 'a' }, { _id: 'b' }],
      [{ _id: 'b' }, { _id: 'a' }],
      false
    );
    assert.equal(result?.kind, 'unordered');
  });

  it('pairs documents by id, not by slot, when the order differs', () => {
    // Comparing slot-for-slot would report every field of both rows as differing.
    const result = compareDocLists(
      'tasks',
      'find',
      q,
      [{ _id: 'a', title: 'alpha' }, { _id: 'b', title: 'beta' }],
      [{ _id: 'b', title: 'beta' }, { _id: 'a', title: 'alpha' }],
      false
    );
    assert.equal(result?.kind, 'unordered');
    assert.equal(result?.fields, undefined);
  });

  it('catches a differing field, and names it without leaking the value', () => {
    const result = compareDocLists(
      'tasks',
      'find',
      q,
      [{ _id: 'a', title: 'real title', status: 'todo' }],
      [{ _id: 'a', title: 'wrong title', status: 'todo' }]
    );
    assert.equal(result?.kind, 'fields');
    assert.deepEqual(result?.fields, ['title']);
    assert.deepEqual(result?.ids, ['a']);

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('real title'), 'the report leaked a field value');
    assert.ok(!serialized.includes('wrong title'), 'the report leaked a field value');
  });

  it('catches a field present on one side only', () => {
    const result = compareDocLists('tasks', 'find', q, [{ _id: 'a', extra: 1 }], [{ _id: 'a' }]);
    assert.deepEqual(result?.fields, ['extra']);
  });

  it('ignores updatedAt, which each store stamps itself', () => {
    const result = compareDocLists(
      'tasks',
      'find',
      q,
      [{ _id: 'a', title: 'same', updatedAt: new Date('2026-01-01T00:00:00Z') }],
      [{ _id: 'a', title: 'same', updatedAt: new Date('2026-01-01T00:00:07Z') }]
    );
    assert.equal(result, null);
  });

  it('does not ignore createdAt, which is copied and must match', () => {
    const result = compareDocLists(
      'tasks',
      'find',
      q,
      [{ _id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') }],
      [{ _id: 'a', createdAt: new Date('2026-01-02T00:00:00Z') }]
    );
    assert.deepEqual(result?.fields, ['createdAt']);
  });

  it('treats equal dates as equal however they are represented', () => {
    const result = compareDocLists(
      'tasks',
      'find',
      q,
      [{ _id: 'a', dueDate: new Date('2026-03-01T00:00:00.000Z') }],
      [{ _id: 'a', dueDate: new Date('2026-03-01T00:00:00.000Z') }]
    );
    assert.equal(result, null);
  });

  it('compares single documents both ways round', () => {
    assert.equal(compareDocs('tasks', 'findOne', q, null, null), null);
    assert.equal(compareDocs('tasks', 'findOne', q, { _id: 'a' }, null)?.kind, 'missing');
    assert.equal(compareDocs('tasks', 'findOne', q, null, { _id: 'a' })?.kind, 'unexpected');
    assert.equal(compareDocs('tasks', 'findOne', q, { _id: 'a' }, { _id: 'a' }), null);
  });

  it('compares counts', () => {
    assert.equal(compareCounts('tasks', 'countDocuments', q, 3, 3), null);
    assert.equal(compareCounts('tasks', 'countDocuments', q, 3, 2)?.kind, 'count');
  });

  it('compares distinct as a set, not a sequence', () => {
    assert.equal(compareValueSets('tasks', 'distinct', q, ['a', 'b'], ['b', 'a']), null);
    assert.equal(compareValueSets('tasks', 'distinct', q, ['a', 'b'], ['a'])?.kind, 'missing');
  });
});

// --- against a live store -----------------------------------------------------------

/** A shadow that can be told to lie, so divergence can be provoked on demand. */
class DivergingStore implements DataStore {
  readonly backend = 'kdb' as const;
  private readonly docs = new Map<string, Map<string, Doc>>();
  dropWrites = false;
  corruptField: string | undefined;

  private table(name: string): Map<string, Doc> {
    let table = this.docs.get(name);
    if (!table) {
      table = new Map();
      this.docs.set(name, table);
    }
    return table;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async clear(): Promise<void> {
    this.docs.clear();
  }

  collection<T extends Doc = Doc>(name: string): never | any {
    const table = this.table(name);
    const store = this;
    return {
      name,
      async find(filter: Record<string, unknown> = {}): Promise<Doc[]> {
        return [...table.values()].filter((doc) => matches(doc, filter));
      },
      async findOne(filter: Record<string, unknown>): Promise<Doc | null> {
        return [...table.values()].find((doc) => matches(doc, filter)) ?? null;
      },
      async findById(id: string): Promise<Doc | null> {
        return table.get(id) ?? null;
      },
      async countDocuments(filter: Record<string, unknown> = {}): Promise<number> {
        return [...table.values()].filter((doc) => matches(doc, filter)).length;
      },
      async distinct(field: string): Promise<unknown[]> {
        return [...new Set([...table.values()].map((doc) => doc[field]))];
      },
      async create(doc: Doc): Promise<Doc> {
        if (store.dropWrites) return doc;
        const stored = { ...doc };
        if (store.corruptField) stored[store.corruptField] = 'corrupted-by-the-shadow';
        table.set(String(doc._id), stored);
        return stored;
      },
      async insertMany(docs: Doc[]): Promise<Doc[]> {
        for (const doc of docs) await this.create(doc);
        return docs;
      },
      async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
        if (store.dropWrites) return { matched: 0, modified: 0 };
        const target = [...table.values()].find((doc) => matches(doc, filter));
        if (!target) return { matched: 0, modified: 0 };
        Object.assign(target, (update.$set as Doc) ?? {});
        return { matched: 1, modified: 1 };
      },
      async updateMany() {
        return { matched: 0, modified: 0 };
      },
      async findOneAndUpdate() {
        return null;
      },
      async findByIdAndUpdate() {
        return null;
      },
      async replaceOne(filter: Record<string, unknown>, doc: Doc) {
        table.set(String(doc._id ?? filter._id), { ...doc });
        return { matched: 1, modified: 1 };
      },
      async deleteOne(filter: Record<string, unknown>) {
        const target = [...table.values()].find((doc) => matches(doc, filter));
        if (!target) return { deleted: 0 };
        table.delete(String(target._id));
        return { deleted: 1 };
      },
      async deleteMany() {
        return { deleted: 0 };
      },
      async findOneAndDelete() {
        return null;
      },
      async bulkWrite() {
        return { matched: 0, modified: 0 };
      },
    };
  }
}

/** Equality-only matching — enough for the filters these tests issue. */
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => String(doc[key]) === String(value));
}

let mongo: MongoMemoryServer;
let shadow: DivergingStore;
let store: ShadowDataStore;

describe('shadow reads against a live primary', () => {
  before(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri();
    process.env.DATA_MONGO = 'true';
    delete process.env.DATA_KDB;

    await import('../src/models/index.ts');
    const { MongoDataStore } = await import('../src/data/mongo/store.ts');
    const { ShadowDataStore } = await import('../src/data/shadow/store.ts');
    shadow = new DivergingStore();
    store = new ShadowDataStore(new MongoDataStore(), shadow, { compareReads: true });
    await store.connect();
  });

  after(async () => {
    await store?.disconnect();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await store.clear();
    shadow.dropWrites = false;
    shadow.corruptField = undefined;
  });

  it('reports no divergence when the backends agree', async () => {
    const before = store.readStats()!;
    const tasks = store.collection('tasks');
    await tasks.create({ userId: 'u1', title: 'agreed' });
    await tasks.find({ userId: 'u1' });
    await store.drainShadow();

    const stats = store.readStats()!;
    assert.ok(stats.compared > before.compared, 'nothing was compared');
    assert.equal(stats.diverged - before.diverged, 0, JSON.stringify(stats.lastDivergence));
  });

  it('does not report queue lag as divergence', async () => {
    // The read is issued immediately after the write, while the mirror is still
    // queued. Comparing the shadow at that instant would find nothing there; the
    // comparison has to wait its turn behind the write.
    const before = store.readStats()!;
    const tasks = store.collection('tasks');
    await tasks.create({ userId: 'lag', title: 'just written' });
    await tasks.find({ userId: 'lag' });
    await store.drainShadow();

    const stats = store.readStats()!;
    assert.equal(stats.diverged - before.diverged, 0, JSON.stringify(stats.lastDivergence));
  });

  it('catches a shadow that silently dropped a write', async () => {
    const before = store.readStats()!;
    const tasks = store.collection('tasks');
    shadow.dropWrites = true;
    await tasks.create({ userId: 'u2', title: 'never mirrored' });
    shadow.dropWrites = false;
    await tasks.find({ userId: 'u2' });
    await store.drainShadow();

    const stats = store.readStats()!;
    assert.equal(stats.diverged - before.diverged, 1);
    assert.equal(stats.lastDivergence?.kind, 'missing');
  });

  it('catches a shadow that stored a different value', async () => {
    const before = store.readStats()!;
    const tasks = store.collection('tasks');
    shadow.corruptField = 'title';
    await tasks.create({ userId: 'u3', title: 'correct' });
    shadow.corruptField = undefined;
    await tasks.find({ userId: 'u3' });
    await store.drainShadow();

    const stats = store.readStats()!;
    assert.equal(stats.diverged - before.diverged, 1);
    assert.equal(stats.lastDivergence?.kind, 'fields');
    assert.deepEqual(stats.lastDivergence?.fields, ['title']);
  });

  it("serves the primary's answer even when the shadow disagrees", async () => {
    const tasks = store.collection('tasks');
    shadow.corruptField = 'title';
    const created = await tasks.create({ userId: 'u4', title: 'authoritative' });
    shadow.corruptField = undefined;

    const found = await tasks.findById(String(created._id));
    await store.drainShadow();

    assert.equal(found?.title, 'authoritative', 'the caller got the shadow answer');
    assert.ok(store.readStats()!.diverged > 0, 'the divergence went unnoticed');
  });

  it('counts divergences by kind', async () => {
    const tasks = store.collection('tasks');
    shadow.dropWrites = true;
    await tasks.create({ userId: 'u5', title: 'gone' });
    shadow.dropWrites = false;
    await tasks.find({ userId: 'u5' });
    await store.drainShadow();

    assert.ok((store.readStats()!.byKind.missing ?? 0) > 0);
  });

  it('compares nothing when the sample rate is zero', async () => {
    const { MongoDataStore } = await import('../src/data/mongo/store.ts');
    const { ShadowDataStore } = await import('../src/data/shadow/store.ts');
    const sampled = new ShadowDataStore(new MongoDataStore(), new DivergingStore(), {
      compareReads: true,
      readSampleRate: 0,
    });
    await sampled.connect();
    await sampled.collection('tasks').find({});
    await sampled.drainShadow();
    assert.equal(sampled.readStats()!.compared, 0);
  });
});

describe('shadow read flags', () => {
  it('refuses read comparison without mirrored writes', async () => {
    const { shadowReadsEnabled } = await import('../src/data/index.ts');
    assert.throws(
      () => shadowReadsEnabled({ DATA_SHADOW_READS: 'true' }),
      /requires DATA_SHADOW_WRITES/
    );
  });

  it('is off unless explicitly enabled', async () => {
    const { shadowReadsEnabled } = await import('../src/data/index.ts');
    assert.equal(shadowReadsEnabled({}), false);
    assert.equal(shadowReadsEnabled({ DATA_SHADOW_READS: 'yes', DATA_SHADOW_WRITES: 'true' }), false);
    assert.equal(shadowReadsEnabled({ DATA_SHADOW_READS: 'true', DATA_SHADOW_WRITES: 'true' }), true);
  });

  it('validates the sample rate', async () => {
    const { shadowReadSampleRate } = await import('../src/data/index.ts');
    assert.equal(shadowReadSampleRate({}), 1);
    assert.equal(shadowReadSampleRate({ DATA_SHADOW_READ_SAMPLE: '0.25' }), 0.25);
    assert.throws(() => shadowReadSampleRate({ DATA_SHADOW_READ_SAMPLE: '2' }), /between 0 and 1/);
    assert.throws(() => shadowReadSampleRate({ DATA_SHADOW_READ_SAMPLE: 'half' }), /between 0 and 1/);
  });
});
