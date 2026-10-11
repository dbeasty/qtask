import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecords } from '../src/sync/merge.ts';
import { hashEncoded } from '../src/sync/codec.ts';
import { formatStamp } from '../src/sync/clock.ts';
import type { DocRec } from '../src/sync/meta.ts';
import type { WireDoc } from '../src/sync/types.ts';
import { link, makePeer, settle } from './helpers/syncHarness.ts';

const T = (wall: number, node: string) => formatStamp(wall, 0, node);

function rec(fields: DocRec['fields'], vv: DocRec['vv'], del?: DocRec['del']): DocRec {
  return { coll: 'tasks', id: 't1', scope: 'u:u1', fields, vv, del, seq: 1, src: null, ut: 0 };
}
function wire(fields: WireDoc['fields'], vv: WireDoc['vv'], del?: WireDoc['del']): WireDoc {
  return { coll: 'tasks', id: 't1', scope: 'u:u1', fields, vv, ...(del ? { del } : {}) };
}
const f = (value: unknown, wall: number, node: string, c: number) => ({ v: value, t: T(wall, node), c });
const lf = (value: unknown, wall: number, node: string, c: number) => ({
  t: T(wall, node),
  c,
  h: hashEncoded(value),
});

describe('field merge (pure)', () => {
  it('keeps both sides when different fields changed', () => {
    const local = rec({ title: lf('mine', 10, 'a', 1), due: lf('d0', 5, 'a', 1) }, { a: 1 });
    const remote = wire(
      { title: f('mine', 10, 'a', 1) as never, due: f('d0', 5, 'a', 1), priority: f('high', 20, 'b', 1) },
      { a: 1, b: 1 }
    );
    const out = mergeRecords(local, remote);
    assert.deepEqual(out.takeRemote, ['priority']);
    assert.equal(out.conflicts.length, 0);
    assert.equal(out.vv.b, 1);
  });

  it('fast-forwards a descendant edit without reporting a conflict', () => {
    // remote saw local's write (vv.a=1) and then overwrote it
    const local = rec({ title: lf('v1', 10, 'a', 1) }, { a: 1 });
    const remote = wire({ title: f('v2', 20, 'b', 1) }, { a: 1, b: 1 });
    const out = mergeRecords(local, remote);
    assert.deepEqual(out.takeRemote, ['title']);
    assert.equal(out.conflicts.length, 0);
  });

  it('ignores a stale ancestor from the remote', () => {
    const local = rec({ title: lf('v2', 20, 'b', 1) }, { a: 1, b: 1 });
    const remote = wire({ title: f('v1', 10, 'a', 1) }, { a: 1 });
    const out = mergeRecords(local, remote);
    assert.deepEqual(out.takeRemote, []);
    assert.equal(out.changed, false);
  });

  it('flags concurrent edits of one field and lets the later stamp win', () => {
    const local = rec({ title: lf('left', 10, 'a', 1) }, { a: 1 });
    const remote = wire({ title: f('right', 30, 'b', 1) }, { b: 1 });
    const out = mergeRecords(local, remote);
    assert.equal(out.conflicts.length, 1);
    assert.equal(out.conflicts[0]!.winner, 'remote');
    assert.deepEqual(out.takeRemote, ['title']);

    const flipped = mergeRecords(
      rec({ title: lf('right', 30, 'b', 1) }, { b: 1 }),
      wire({ title: f('left', 10, 'a', 1) }, { a: 1 })
    );
    assert.equal(flipped.conflicts[0]!.winner, 'local');
    assert.deepEqual(flipped.takeRemote, []);
  });

  it('does not call it a conflict when concurrent edits wrote the same value', () => {
    const out = mergeRecords(
      rec({ title: lf('same', 10, 'a', 1) }, { a: 1 }),
      wire({ title: f('same', 11, 'b', 1) }, { b: 1 })
    );
    assert.equal(out.conflicts.length, 0);
  });

  it('is commutative: either merge direction yields the same field stamps', () => {
    const a = rec({ x: lf(1, 10, 'a', 1), y: lf(2, 40, 'a', 2) }, { a: 2 });
    const b = rec({ x: lf(9, 20, 'b', 1), z: lf(3, 5, 'b', 2) }, { b: 2 });
    const asWire = (r: DocRec): WireDoc =>
      wire(
        Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, { v: 0, t: v.t, c: v.c }])),
        r.vv
      );
    const ab = mergeRecords(a, asWire(b));
    const ba = mergeRecords(b, asWire(a));
    const stamps = (fields: DocRec['fields']) =>
      Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.t]));
    assert.deepEqual(stamps(ab.fields), stamps(ba.fields));
    assert.deepEqual(ab.vv, ba.vv);
  });

  it('is idempotent: merging the same remote twice changes nothing the second time', () => {
    const remote = wire({ title: f('r', 30, 'b', 1) }, { b: 1 });
    const first = mergeRecords(rec({ title: lf('l', 10, 'a', 1) }, { a: 1 }), remote);
    const merged: DocRec = rec(first.fields, first.vv, first.del);
    const second = mergeRecords(merged, remote);
    assert.equal(second.changed, false);
    assert.equal(second.takeRemote.length, 0);
  });

  it('a tombstone kills the whole document, even fields stamped after it', () => {
    const local = rec({ title: lf('old', 10, 'a', 1), note: lf('newer', 50, 'a', 2) }, { a: 2 });
    const remote = wire({}, { a: 1, b: 1 }, { t: T(30, 'b'), c: 1 });
    const out = mergeRecords(local, remote);
    assert.deepEqual(out.dropLocal.sort(), ['note', 'title']);
    assert.equal(out.deleted, true);
  });

  it('a tombstone newer than every field deletes the document', () => {
    const out = mergeRecords(
      rec({ title: lf('old', 10, 'a', 1) }, { a: 1 }),
      wire({}, { a: 1, b: 1 }, { t: T(30, 'b'), c: 1 })
    );
    assert.equal(out.deleted, true);
    assert.equal(out.changed, true);
  });
});

describe('field merge through the engine', () => {
  async function pair() {
    let wallA = 1000;
    let wallB = 1000;
    const a = await makePeer('a', { now: () => wallA });
    const b = await makePeer('b', { now: () => wallB });
    return { a, b, setA: (n: number) => (wallA = n), setB: (n: number) => (wallB = n) };
  }

  it('merges edits to different fields of the same task', async () => {
    const { a, b, setA, setB } = await pair();
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'base', priority: 'low' });
    await settle([a, b]);
    setA(2000);
    setB(3000);
    await a.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'renamed on a' } });
    await b.store.collection('tasks').updateOne({ _id: task._id }, { $set: { priority: 'high' } });
    await settle([a, b]);
    for (const peer of [a, b]) {
      const doc = await peer.inner.collection('tasks').findById(String(task._id));
      assert.equal(doc?.title, 'renamed on a');
      assert.equal(doc?.priority, 'high');
    }
    assert.equal(a.inner.count('activities'), 0, 'disjoint edits are not conflicts');
  });

  it('later edit wins a same-field conflict and the loser lands in the activity log', async () => {
    const { a, b, setA, setB } = await pair();
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'base' });
    await settle([a, b]);
    setA(2000);
    setB(3000);
    await a.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'from a' } });
    await b.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'from b' } });
    await settle([a, b]);

    for (const peer of [a, b]) {
      assert.equal((await peer.inner.collection('tasks').findById(String(task._id)))?.title, 'from b');
      const log = await peer.inner.collection('activities').find({ action: 'sync_conflict' });
      assert.equal(log.length, 1, `${peer.name} has exactly one conflict entry`);
      const entry = log[0]!;
      assert.equal(entry.taskId, String(task._id));
      const details = entry.details as { field: string; kept: { value: unknown }; discarded: { value: unknown } };
      assert.equal(details.field, 'title');
      assert.equal(details.kept.value, 'from b');
      assert.equal(details.discarded.value, 'from a');
    }
    assert.ok(a.engine.log().some((e) => e.kind === 'conflict') || b.engine.log().some((e) => e.kind === 'conflict'));
  });

  it('is not fooled by a device whose wall clock is far in the past', async () => {
    const { a, b, setA, setB } = await pair();
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'base' });
    await settle([a, b]);
    setA(5000);
    await a.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'a, later in real time' } });
    await settle([a, b]); // b has now seen a's stamp
    setB(10); // b's clock is wrong, but it observed a's stamp
    await b.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'b, causally after' } });
    await settle([a, b]);
    assert.equal((await a.inner.collection('tasks').findById(String(task._id)))?.title, 'b, causally after');
    assert.equal(a.inner.count('activities'), 0, 'a causal overwrite is not a conflict');
  });

  it('delete wins over a concurrent edit whichever is later, leaving no partial document', async () => {
    const { a, b, setA, setB } = await pair();
    const t1 = await a.store.collection('tasks').create({ userId: 'u1', title: 'doomed' });
    const t2 = await a.store.collection('tasks').create({ userId: 'u1', title: 'doomed too' });
    await settle([a, b]);

    // t1: b edits, then a deletes later
    setB(2000);
    await b.store.collection('tasks').updateOne({ _id: t1._id }, { $set: { title: 'edited' } });
    setA(3000);
    await a.store.collection('tasks').deleteOne({ _id: t1._id });
    // t2: a deletes, b edits later
    setA(4000);
    await a.store.collection('tasks').deleteOne({ _id: t2._id });
    setB(5000);
    await b.store.collection('tasks').updateOne({ _id: t2._id }, { $set: { title: 'late edit' } });

    await settle([a, b]);
    for (const peer of [a, b]) {
      assert.equal(await peer.inner.collection('tasks').findById(String(t1._id)), null);
      assert.equal(await peer.inner.collection('tasks').findById(String(t2._id)), null);
    }
  });
});
