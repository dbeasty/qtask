import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { link, makePeer, settle, snapshot } from './helpers/syncHarness.ts';

describe('sync smoke', () => {
  it('replicates a create, an edit and a delete between two peers', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    const created = await a.store.collection('tasks').create({ userId: 'u1', title: 'one', status: 'todo', due: new Date('2026-01-01') });
    await settle([a, b]);
    const onB = await b.inner.collection('tasks').findById(String(created._id));
    assert.equal(onB?.title, 'one');
    assert.ok(onB?.due instanceof Date);

    await b.store.collection('tasks').updateOne({ _id: created._id }, { $set: { title: 'two' } });
    await settle([a, b]);
    assert.equal((await a.inner.collection('tasks').findById(String(created._id)))?.title, 'two');

    await a.store.collection('tasks').deleteOne({ _id: created._id });
    await settle([a, b]);
    assert.equal(await b.inner.collection('tasks').findById(String(created._id)), null);
    assert.deepEqual(await snapshot(a), await snapshot(b));
  });

  it('is idempotent: a second sync moves nothing', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    for (let i = 0; i < 20; i++) await a.store.collection('tasks').create({ userId: 'u1', title: `t${i}` });
    await a.engine.syncWith(link(a, b));
    const again = await a.engine.syncWith(link(a, b));
    assert.equal(again.pushed, 0);
    assert.equal(again.pulled, 0);
  });
});
