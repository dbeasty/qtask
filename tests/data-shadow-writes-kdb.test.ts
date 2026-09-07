/**
 * Shadow writes against a real KDB, rather than a fake.
 *
 * data-shadow-writes.test.ts covers the mirroring behaviour with a fake shadow,
 * because failure and saturation have to be reproducible. This covers the thing a
 * fake cannot: that a write served by Mongo actually lands in KDB, under the same
 * id, and that the two stores hold the same document afterwards. That is the
 * property stage 3's shadow reads will depend on.
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

describe('shadow writes into a real KDB', { skip: unavailable() }, () => {
  before(async () => {
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
    store = new ShadowDataStore(new MongoDataStore(), shadow);
    await store.connect();
  });

  after(async () => {
    await store?.disconnect();
    service?.kill();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await store.clear();
  });

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
