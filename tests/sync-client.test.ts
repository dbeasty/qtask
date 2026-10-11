import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { link, makePeer, settle } from './helpers/syncHarness.ts';
import { DeviceSyncClient } from '../src/sync/client.ts';
import { FileMetaPersistence, MemoryMetaStore } from '../src/sync/meta.ts';
import { SyncEngine } from '../src/sync/engine.ts';
import { SyncDataStore } from '../src/sync/tracker.ts';
import { MemoryDataStore } from '../src/data/memory/store.ts';
import { LoopbackTransport, SyncTransportError } from '../src/sync/transport.ts';
import type { SyncTransport } from '../src/sync/types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('device sync client', () => {
  it('makes no network call while signed out, and reports it', async () => {
    const device = await makePeer('device');
    let calls = 0;
    const transport: SyncTransport = {
      kind: 'test',
      hello: async () => { calls++; throw new Error('should not dial'); },
      pull: async () => { calls++; throw new Error('should not dial'); },
      push: async () => { calls++; throw new Error('should not dial'); },
    };
    const client = new DeviceSyncClient({ engine: device.engine, transport, getToken: () => undefined, intervalMs: 1000 });
    await device.store.collection('tasks').create({ userId: 'local', title: 'offline work' });
    assert.equal(await client.syncNow(), undefined);
    const status = await client.status();
    assert.equal(calls, 0);
    assert.equal(status.pendingChanges, 1);
    assert.equal(status.lastSyncedAt, undefined);
  });

  it('syncs once a token appears and then reports last-synced and zero pending', async () => {
    const device = await makePeer('device');
    const hub = await makePeer('hub', { role: 'hub' });
    let token: string | undefined;
    const client = new DeviceSyncClient({
      engine: device.engine,
      transport: new LoopbackTransport(hub.engine.service()),
      getToken: () => token,
    });
    await device.store.collection('tasks').create({ userId: 'u', title: 'a' });
    await device.store.collection('tasks').create({ userId: 'u', title: 'b' });
    assert.equal((await client.status()).pendingChanges, 2);

    assert.equal(await client.syncNow(), undefined);
    token = 'abc';
    const result = await client.syncNow();
    assert.equal(result?.pushed, 2);
    const status = await client.status();
    assert.equal(status.pendingChanges, 0);
    assert.ok(status.lastSyncedAt);
    assert.equal(status.state, 'idle');
    assert.equal(hub.inner.count('tasks'), 2);

    await device.store.collection('tasks').create({ userId: 'u', title: 'c' });
    assert.equal((await client.status()).pendingChanges, 1);
  });

  it('backs off exponentially with jitter, capped, and recovers', async () => {
    const device = await makePeer('device');
    const hub = await makePeer('hub', { role: 'hub' });
    const client = new DeviceSyncClient({
      engine: device.engine,
      transport: new LoopbackTransport(hub.engine.service()),
      getToken: () => 't',
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      random: () => 1, // upper end of the jitter band
    });
    assert.deepEqual([1, 2, 3, 4, 5, 8].map((n) => client.backoffMs(n)), [100, 200, 400, 800, 1000, 1000]);
    const low = new DeviceSyncClient({
      engine: device.engine, transport: new LoopbackTransport(hub.engine.service()), getToken: () => 't',
      minBackoffMs: 100, maxBackoffMs: 1000, random: () => 0,
    });
    assert.equal(low.backoffMs(3), 200, 'jitter never drops below half the delay');
  });

  it('retries after a network failure without losing the queued changes', async () => {
    const device = await makePeer('device');
    const hub = await makePeer('hub', { role: 'hub' });
    let down = true;
    const flaky = new LoopbackTransport(hub.engine.service(), () => {
      if (down) throw new SyncTransportError('network error: offline');
    });
    const client = new DeviceSyncClient({
      engine: device.engine,
      transport: flaky,
      getToken: () => 't',
      minBackoffMs: 10,
      maxBackoffMs: 20,
      intervalMs: 5000,
      random: () => 0,
    });
    await device.store.collection('tasks').create({ userId: 'u', title: 'survives the outage' });

    await assert.rejects(client.syncNow());
    let status = await client.status();
    assert.equal(status.state, 'offline');
    assert.equal(status.consecutiveFailures, 1);
    assert.equal(status.pendingChanges, 1);
    assert.match(status.lastError ?? '', /offline/);

    down = false;
    client.start();
    for (let i = 0; i < 50 && hub.inner.count('tasks') === 0; i++) await sleep(10);
    client.stop();
    assert.equal(hub.inner.count('tasks'), 1);
    status = await client.status();
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(status.pendingChanges, 0);
  });

  it('treats a rejected token as signed-out rather than retrying', async () => {
    const device = await makePeer('device');
    const hub = await makePeer('hub', { role: 'hub' });
    const client = new DeviceSyncClient({
      engine: device.engine,
      transport: new LoopbackTransport(hub.engine.service(), () => {
        throw new SyncTransportError('hub responded 401', 401, false);
      }),
      getToken: () => 'expired',
    });
    assert.equal(await client.syncNow(), undefined);
    const status = await client.status();
    assert.equal(status.state, 'signed-out');
    assert.equal(status.consecutiveFailures, 0);
  });

  it('coalesces concurrent syncNow calls into one run', async () => {
    const device = await makePeer('device');
    const hub = await makePeer('hub', { role: 'hub' });
    const transport = new LoopbackTransport(hub.engine.service());
    const client = new DeviceSyncClient({ engine: device.engine, transport, getToken: () => 't' });
    const [a, b] = await Promise.all([client.syncNow(), client.syncNow()]);
    assert.equal(a, b);
    assert.equal(transport.requests, 2, 'one hello and one pull; nothing to push, and no second run');
  });
});

describe('sync records persistence', () => {
  it('survives a restart: cursors, clock and tombstones are kept, nothing is re-sent', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'qtask-sync-'));
    const path = join(dir, 'meta.json');
    const data = new MemoryDataStore();
    const hub = await makePeer('hub', { role: 'hub' });

    let { meta, persistence } = await FileMetaPersistence.open(path, { nodeId: 'dev' });
    let store = new SyncDataStore(data, meta);
    let engine = new SyncEngine({ store, meta, role: 'device' });
    await engine.init();
    const keep = await store.collection('tasks').create({ userId: 'u', title: 'keep' });
    const gone = await store.collection('tasks').create({ userId: 'u', title: 'gone' });
    await engine.syncWith(new LoopbackTransport(hub.engine.service()));
    await store.collection('tasks').deleteOne({ _id: gone._id });
    await engine.syncWith(new LoopbackTransport(hub.engine.service()));
    await persistence.flush();

    // "restart": new objects from the same files
    ({ meta, persistence } = await FileMetaPersistence.open(path));
    store = new SyncDataStore(data, meta);
    engine = new SyncEngine({ store, meta, role: 'device' });
    await engine.init();
    assert.equal(meta.nodeId, 'dev');
    const again = await engine.syncWith(new LoopbackTransport(hub.engine.service()));
    assert.equal(again.pushed + again.pulled, 0, 'no re-upload after restart');
    assert.equal((await engine.status()).tombstones, 1);

    await store.collection('tasks').updateOne({ _id: keep._id }, { $set: { title: 'after restart' } });
    await engine.syncWith(new LoopbackTransport(hub.engine.service()));
    assert.equal((await hub.inner.collection('tasks').findById(String(keep._id)))?.title, 'after restart');
    await fs.rm(dir, { recursive: true });
  });

  it('a peer whose records were reset (new epoch) is fully re-synced, harmlessly', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    for (let i = 0; i < 10; i++) await a.store.collection('tasks').create({ userId: 'u', title: `t${i}` });
    await settle([a, b]);

    // b loses its sync records (and its data) and comes back with a new epoch.
    const fresh = new MemoryMetaStore({ nodeId: 'b' });
    const freshData = new MemoryDataStore();
    const b2 = new SyncEngine({ store: new SyncDataStore(freshData, fresh), meta: fresh, role: 'device' });
    await b2.init();
    await b2.syncWith(new LoopbackTransport(a.engine.service()));
    assert.equal(freshData.count('tasks'), 10);
  });
});
