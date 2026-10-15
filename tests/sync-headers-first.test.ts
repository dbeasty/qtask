import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makePeer, settle, snapshot, type Peer } from './helpers/syncHarness.ts';
import { LoopbackTransport } from '../src/sync/transport.ts';

/** Counts what each peer receives, so a document sent twice shows up. */
function counted(server: Peer, tally: { docs: number; bytes: number }) {
  const inner = new LoopbackTransport(server.engine.service());
  const wrap = <T extends (r: any) => Promise<any>>(fn: T) =>
    (async (req: any) => {
      const res = await fn.call(inner, req);
      tally.docs += (res.docs?.length ?? 0) + (res.headers?.length ?? 0) * 0;
      tally.bytes += JSON.stringify(res).length + JSON.stringify(req).length;
      return res;
    }) as T;
  return { kind: 'counted', hello: inner.hello.bind(inner), pull: wrap(inner.pull), push: wrap(inner.push) };
}

async function build(n: number) {
  const [a, b, c] = await Promise.all([makePeer('A'), makePeer('B'), makePeer('C')]);
  for (let i = 0; i < n; i++) await a.store.collection('tasks').create({ _id: `t${i}`, userId: 'u1', title: `Task ${i}`, notes: 'x'.repeat(100) });
  await a.engine.syncWith(new LoopbackTransport(b.engine.service()));
  return { a, b, c };
}

async function joinC(headersFirst: boolean, n: number) {
  const { a, b, c } = await build(n);
  const tally = { docs: 0, bytes: 0 };
  // C joins and syncs with both A and B, as the coordinator does.
  for (const peer of [a, b]) await c.engine.syncWith(counted(peer, tally), { headersFirst });
  // A and B also initiate toward C (both ends start a round when a peer appears).
  const toC = { docs: 0, bytes: 0 };
  for (const peer of [a, b]) await peer.engine.syncWith(counted(c, toC), { headersFirst });
  return { a, b, c, received: tally.docs + toC.docs, bytes: tally.bytes + toC.bytes };
}

describe('headers-first exchange', () => {
  it('still converges to the same data', async () => {
    const r = await joinC(true, 300);
    await settle([r.a, r.b, r.c]);
    assert.deepEqual(await snapshot(r.c), await snapshot(r.a));
    assert.equal(Object.keys(await snapshot(r.c)).length, 300);
  });

  it('moves each document to a joining peer once instead of once per source', async () => {
    const plain = await joinC(false, 300);
    const smart = await joinC(true, 300);
    assert.ok(plain.received >= 600, `plain full sync should duplicate (got ${plain.received})`);
    assert.ok(smart.received <= 320, `headers-first should send ~once (got ${smart.received})`);
    assert.ok(smart.bytes < plain.bytes, `${smart.bytes} < ${plain.bytes}`);
  });

  it('delivers deletes and edits made while the joiner was away', async () => {
    const { a, b, c } = await build(20);
    await c.engine.syncWith(new LoopbackTransport(a.engine.service()), { headersFirst: true });
    await a.store.collection('tasks').deleteOne({ _id: 't3' });
    await b.store.collection('tasks').updateOne({ _id: 't4' }, { $set: { title: 'renamed' } });
    await a.engine.syncWith(new LoopbackTransport(b.engine.service()), { headersFirst: true });
    await c.engine.syncWith(new LoopbackTransport(b.engine.service()), { headersFirst: true });
    await settle([a, b, c]);
    const snap = await snapshot(c);
    assert.equal(snap['t3'], undefined);
    assert.equal((snap['t4'] as any).title, 'renamed');
  });

  it('works against a peer that ignores headersOnly and offers', async () => {
    const { a, c } = await build(25);
    const svc = a.engine.service();
    const old = {
      kind: 'old',
      hello: (r: any) => svc.hello(r),
      pull: (r: any) => svc.pull({ from: r.from, cursor: r.cursor, limit: r.limit, sig: r.sig }),
      push: (r: any) => (r.offer ? Promise.resolve({ accepted: 0, rejected: [] }) : svc.push(r)),
    };
    await c.engine.syncWith(old as any, { headersFirst: true });
    assert.equal(Object.keys(await snapshot(c)).length, 25);
  });
});
