/**
 * Shadow writes and reads against a real KDB, rather than a fake.
 *
 * The fake-shadow suites cover mirroring mechanics and comparator behaviour, because
 * failure, latency and saturation have to be reproducible. This covers what a fake
 * cannot: that a write served by Mongo actually lands in KDB under the same id, and
 * that the two backends then answer real queries identically.
 *
 * This is the bake in miniature. Read comparison is on for the whole file, so every
 * read any test here issues is also checked against KDB — a divergence anywhere
 * fails the run rather than being confined to the tests that look for one.
 *
 * Skips with a reason when there is no kdb checkout to run against.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

import type { DataStore, Doc } from '../src/data/types.ts';
import type { ShadowDataStore } from '../src/data/shadow/store.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const KDB_ROOT = process.env.KDB_ROOT ?? resolve(import.meta.dirname, '../../kdb');
const CLIENT_MODULE =
  process.env.KDB_CLIENT_MODULE ?? resolve(KDB_ROOT, 'packages/kdb-client/src/index.ts');
const SERVICE_BIN = process.env.KDB_SERVICE_BIN ?? resolve(KDB_ROOT, 'go/bin/kdb-service');
const PORT = Number(process.env.KDB_SHADOW_TEST_PORT ?? 7813);

function unavailable(): string | undefined {
  if (!existsSync(SERVICE_BIN)) return `kdb-service not built at ${SERVICE_BIN}`;
  if (!existsSync(CLIENT_MODULE)) return `@kdb/client not found at ${CLIENT_MODULE}`;
  return undefined;
}

let mongo: MongoMemoryServer;
let service: ChildProcess | undefined;
let store: ShadowDataStore;
let shadow: DataStore;

// Setup is file-level rather than per-describe: both suites drive the same store,
// and a `before` inside one describe does not run for the other.
before(async () => {
  if (unavailable()) return;
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.DATA_MONGO = 'true';
  delete process.env.DATA_KDB;
  process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
  process.env.KDB_ADDR = `tcp://127.0.0.1:${PORT}`;
  process.env.KDB_NAMESPACE_PREFIX = 'qtaskshadow/docs';

  service = spawn(
    SERVICE_BIN,
    [
      '--memory',
      '--namespace',
      'qtaskshadow/docs',
      '--sql-addr',
      `tcp://127.0.0.1:${PORT}?bind=true`,
      '--log-level',
      'error',
    ],
    { stdio: 'ignore' }
  );
  await waitForPort(PORT);

  await import('../src/models/index.ts');
  const { MongoDataStore } = await import('../src/data/mongo/store.ts');
  const { KdbDataStore } = await import('../src/data/kdb/store.ts');
  const { ShadowDataStore } = await import('../src/data/shadow/store.ts');

  shadow = new KdbDataStore();
  store = new ShadowDataStore(new MongoDataStore(), shadow, { compareReads: true });
  await store.connect();
});

after(async () => {
  await store?.disconnect();
  service?.kill();
  await mongo?.stop();
});

beforeEach(async () => {
  if (store) await store.clear();
});

describe('shadow writes into a real KDB', { skip: unavailable() }, () => {

  it('lands a Mongo-served write in KDB under the same id', async () => {
    const created = await store.collection('tasks').create({ userId: 'u1', title: 'shadowed' });
    await store.drainShadow();

    const mirrored = await shadow.collection('tasks').findById(String(created._id));
    assert.ok(mirrored, 'the document never reached KDB');
    assert.equal(mirrored._id, created._id);
    assert.equal(mirrored.title, 'shadowed');
    assert.equal(store.stats().failed, 0, store.stats().lastError ?? '');
  });

  it('keeps the two stores holding the same document through an update', async () => {
    const tasks = store.collection('tasks');
    const created = await tasks.create({ userId: 'u1', title: 'evolving', tags: ['a'] });
    await tasks.updateOne({ _id: created._id }, { $set: { status: 'done' }, $push: { tags: 'b' } });
    await store.drainShadow();

    const fromPrimary = await tasks.findById(String(created._id));
    const fromShadow = await shadow.collection('tasks').findById(String(created._id));

    assert.ok(fromPrimary && fromShadow);
    assert.equal(fromShadow.status, fromPrimary.status);
    assert.deepEqual(fromShadow.tags, fromPrimary.tags);
    assert.deepEqual(fromShadow.tags, ['a', 'b']);
  });

  it('mirrors a delete', async () => {
    const tasks = store.collection('tasks');
    const created = await tasks.create({ userId: 'u1', title: 'temporary' });
    await store.drainShadow();
    assert.ok(await shadow.collection('tasks').findById(String(created._id)));

    await tasks.deleteOne({ _id: created._id });
    await store.drainShadow();

    assert.equal(await shadow.collection('tasks').findById(String(created._id)), null);
  });

  it('converges over a run of interleaved writes', async () => {
    const tasks = store.collection('tasks');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const doc = await tasks.create({ userId: 'u1', title: `task-${i}`, sortOrder: i });
      ids.push(String(doc._id));
      if (i % 2 === 0) {
        await tasks.updateOne({ _id: doc._id }, { $set: { status: 'in_progress' } });
      }
    }
    await tasks.deleteOne({ _id: ids[0] });
    await store.drainShadow();

    const primaryDocs = await tasks.find({}, { sort: { sortOrder: 1 } });
    const shadowDocs = await shadow.collection('tasks').find({}, { sort: { sortOrder: 1 } });

    assert.equal(store.stats().failed, 0, store.stats().lastError ?? '');
    assert.equal(store.stats().dropped, 0);
    assert.deepEqual(
      shadowDocs.map((doc: Doc) => [doc._id, doc.title, doc.status]),
      primaryDocs.map((doc: Doc) => [doc._id, doc.title, doc.status])
    );
  });
});

describe('shadow reads against a real KDB', { skip: unavailable() }, () => {
  /** Asserts that everything read in `body` matched between the two backends. */
  async function expectAgreement(body: () => Promise<void>): Promise<void> {
    const before = store.readStats()!;
    await body();
    await store.drainShadow();
    const after = store.readStats()!;
    assert.ok(after.compared > before.compared, 'nothing was actually compared');
    assert.equal(
      after.diverged - before.diverged,
      0,
      `KDB disagreed with Mongo: ${JSON.stringify(after.lastDivergence)}`
    );
  }

  async function seed(): Promise<void> {
    const tasks = store.collection('tasks');
    await tasks.create({ userId: 'u1', title: 'deploy staging', status: 'todo', tags: ['ops', 'urgent'], projectIds: ['p1'], sortOrder: 1 });
    await tasks.create({ userId: 'u1', title: 'review notes', status: 'done', tags: ['ops'], projectIds: ['p1', 'p2'], sortOrder: 2 });
    await tasks.create({ userId: 'u2', title: 'unrelated chore', status: 'todo', tags: [], projectIds: [], sortOrder: 3 });
    await store.drainShadow();
  }

  it('agrees on equality and array-membership filters', async () => {
    await seed();
    await expectAgreement(async () => {
      const tasks = store.collection('tasks');
      await tasks.find({ status: 'todo' });
      await tasks.find({ projectIds: 'p2' });
      await tasks.find({ tags: 'ops' });
      await tasks.find({ userId: 'u1', status: 'done' });
    });
  });

  it('agrees on operator filters', async () => {
    await seed();
    await expectAgreement(async () => {
      const tasks = store.collection('tasks');
      await tasks.find({ status: { $in: ['todo', 'done'] } });
      await tasks.find({ sortOrder: { $gt: 1 } });
      await tasks.find({ sortOrder: { $gte: 1, $lte: 2 } });
      await tasks.find({ assigneeId: { $exists: false } });
      await tasks.find({ $or: [{ userId: 'u2' }, { status: 'done' }] });
      await tasks.find({ tags: { $size: 0 } });
    });
  });

  it('agrees on sort, limit, skip and projection', async () => {
    await seed();
    await expectAgreement(async () => {
      const tasks = store.collection('tasks');
      await tasks.find({}, { sort: { sortOrder: -1 } });
      await tasks.find({}, { sort: { sortOrder: 1 }, skip: 1, limit: 1 });
      await tasks.find({}, { sort: { title: 1 } });
      await tasks.find({ userId: 'u1' }, { select: 'title status' });
    });
  });

  it('agrees on findOne, findById, count and distinct', async () => {
    await seed();
    await expectAgreement(async () => {
      const tasks = store.collection('tasks');
      const first = await tasks.findOne({ userId: 'u1' }, { sort: { sortOrder: 1 } });
      await tasks.findById(String(first!._id));
      await tasks.findOne({ title: 'nothing here' });
      await tasks.countDocuments({ userId: 'u1' });
      await tasks.countDocuments();
      await tasks.distinct('status');
    });
  });

  it('still agrees after updates and deletes', async () => {
    await seed();
    const tasks = store.collection('tasks');
    const target = await tasks.findOne({ title: 'deploy staging' });
    await tasks.updateOne({ _id: target!._id }, { $set: { status: 'in_progress' }, $push: { tags: 'later' } });
    await tasks.deleteOne({ title: 'unrelated chore' });
    await store.drainShadow();

    await expectAgreement(async () => {
      const tasksAgain = store.collection('tasks');
      await tasksAgain.find({}, { sort: { sortOrder: 1 } });
      await tasksAgain.find({ status: 'in_progress' });
      await tasksAgain.countDocuments();
    });
  });

  it('reports a divergence when one is manufactured', async () => {
    // Guards the guard: a comparator that never fires would make every test above
    // pass regardless of what KDB did. Writing straight to the shadow, behind the
    // mirroring, puts the two backends genuinely out of step.
    await seed();
    const before = store.readStats()!;
    await shadow.collection('tasks').create({
      _id: 'ffffffffffffffffffffffff',
      userId: 'u1',
      title: 'only in the shadow',
      status: 'todo',
    });

    await store.collection('tasks').find({ userId: 'u1' });
    await store.drainShadow();

    const after = store.readStats()!;
    assert.equal(after.diverged - before.diverged, 1);
    assert.equal(after.lastDivergence?.kind, 'unexpected');
  });
});

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`kdb-service did not open port ${port}`);
}
