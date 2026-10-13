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

  it('calls made during a run share one follow-up run that starts after them', async () => {
    const device = await makePeer('device');
    const hub = await makePeer('hub', { role: 'hub' });
    const transport = new LoopbackTransport(hub.engine.service());
    const client = new DeviceSyncClient({ engine: device.engine, transport, getToken: () => 't' });
    const [a, b, c] = await Promise.all([client.syncNow(), client.syncNow(), client.syncNow()]);
    assert.ok(a && b && c);
    assert.equal(b, c, 'the calls made during the first run share its follow-up');
    assert.equal(transport.requests, 4, 'two runs of hello + pull, not three');
  });

  it('a change made on the hub while a run is going is pulled by a syncNow called after it', async () => {
    const device = await makePeer('device');
    const hub = await makePeer('hub', { role: 'hub' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    // Hold the first run just after its pull has been answered, as a slow local apply
    // would, and change the hub meanwhile: that run can no longer see the change.
    const inner = new LoopbackTransport(hub.engine.service());
    const transport = {
      kind: 'held',
      requests: 0,
      hello: (r: any) => inner.hello(r),
      push: (r: any) => inner.push(r),
      pull: async (r: any) => {
        const res = await inner.pull(r);
        if (first) {
          first = false;
          await gate;
        }
        return res;
      },
    };
    const client = new DeviceSyncClient({ engine: device.engine, transport, getToken: () => 't' });
    const running = client.syncNow();
    await new Promise((r) => setTimeout(r, 5));
    await hub.store.collection('tasks').create({ _id: 'late', userId: 'u1', title: 'made mid-run' });
    const after = client.syncNow();
    release();
    await running;
    await after;
    assert.ok(await device.inner.collection('tasks').findOne({ _id: 'late' }), 'the follow-up run pulled it');
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

  it('data that predates tracking never outranks a real edit (hub restarted with empty records)', async () => {
    const hubData = new MemoryDataStore();
    const boot = async () => {
      const meta = new MemoryMetaStore({ nodeId: 'hub' });
      const engine = new SyncEngine({ store: new SyncDataStore(hubData, meta), meta, role: 'hub' });
      await engine.init();
      return engine;
    };
    let hubEngine = await boot();
    const device = await makePeer('device');
    const task = await device.store.collection('tasks').create({ userId: 'u', title: 'original' });
    await device.engine.syncWith(new LoopbackTransport(hubEngine.service()));

    // the device edits offline, then the hub process restarts and re-baselines its data
    await device.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'offline edit' } });
    await new Promise((r) => setTimeout(r, 3));
    hubEngine = await boot();
    await device.engine.syncWith(new LoopbackTransport(hubEngine.service()));
    await device.engine.syncWith(new LoopbackTransport(hubEngine.service()));

    assert.equal((await hubData.collection('tasks').findById(String(task._id)))?.title, 'offline edit');
    assert.equal(hubData.count('activities'), 0, 'a baseline is not a conflicting edit');
  });
});
