import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { link, makePeer, settle } from './helpers/syncHarness.ts';
import { isLive, recKey } from '../src/sync/meta.ts';

describe('tombstones', () => {
  it('records a delete in the sync record instead of forgetting the document', async () => {
    const a = await makePeer('a');
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'x' });
    await a.engine.capture();
    await a.store.collection('tasks').deleteOne({ _id: task._id });
    await a.engine.capture();
    const rec = a.meta.get(recKey('tasks', String(task._id)))!;
    assert.ok(rec.del, 'tombstone stamp present');
    assert.equal(isLive(rec), false);
    assert.equal((await a.engine.status()).tombstones, 1);
  });

  it('a stale peer cannot resurrect a deleted task by syncing late', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    const c = await makePeer('c'); // goes offline holding the old copy
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'x' });
    await settle([a, b, c]);

    await a.store.collection('tasks').deleteOne({ _id: task._id });
    await settle([a, b]); // c is offline
    await settle([a, b, c]); // c returns

    for (const peer of [a, b, c]) {
      assert.equal(await peer.inner.collection('tasks').findById(String(task._id)), null, peer.name);
    }
  });

  it('cascade deletes (deleteMany) tombstone every document', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'parent' });
    for (let i = 0; i < 5; i++) {
      await a.store.collection('comments').create({ userId: 'u1', taskId: String(task._id), body: `c${i}` });
    }
    await settle([a, b]);
    assert.equal(b.inner.count('comments'), 5);

    await a.store.collection('tasks').deleteOne({ _id: task._id });
    await a.store.collection('comments').deleteMany({ taskId: String(task._id) });
    await settle([a, b]);
    assert.equal(b.inner.count('comments'), 0);
    assert.equal(b.inner.count('tasks'), 0);
    assert.equal((await b.engine.status()).tombstones, 6);
  });

  it('findOneAndDelete and bulk deletes by filter are tracked too', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    await a.store.collection('tasks').create({ userId: 'u1', title: 'keep', status: 'todo' });
    await a.store.collection('tasks').create({ userId: 'u1', title: 'drop1', status: 'done' });
    await a.store.collection('tasks').create({ userId: 'u1', title: 'drop2', status: 'done' });
    await settle([a, b]);
    await a.store.collection('tasks').deleteMany({ status: 'done' });
    await settle([a, b]);
    assert.deepEqual((await b.inner.collection('tasks').find({})).map((t) => t.title), ['keep']);

    await a.store.collection('tasks').findOneAndDelete({ title: 'keep' });
    await settle([a, b]);
    assert.equal(b.inner.count('tasks'), 0);
  });

  it('leaves no trace for a document created and deleted before it was ever captured', async () => {
    const a = await makePeer('a');
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'blink' });
    await a.store.collection('tasks').deleteOne({ _id: task._id });
    await a.engine.capture();
    assert.equal(a.meta.get(recKey('tasks', String(task._id))), undefined);
  });

  it('an id that was deleted stays deleted even if a stale peer edits it', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'first life' });
    await settle([a, b]);
    await a.store.collection('tasks').deleteOne({ _id: task._id });
    await b.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'edited offline' } });
    await settle([a, b]);
    assert.equal(a.inner.count('tasks'), 0);
    assert.equal(b.inner.count('tasks'), 0);
  });

  it('a delete is idempotent over repeated syncs', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'x' });
    await settle([a, b]);
    await a.store.collection('tasks').deleteOne({ _id: task._id });
    await settle([a, b]);
    const again = await a.engine.syncWith(link(a, b));
    assert.equal(again.pushed + again.pulled, 0);
  });
});
