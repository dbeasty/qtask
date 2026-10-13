import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fleet, ENGINE_WORKER, type Device } from './helpers/lan-fleet.ts';

/**
 * The real Phase 2 sync engine (field-level merge, tombstones, version vectors) running
 * over the real Phase 3 LAN transport (pairing, pinned TLS, mDNS), three separate
 * processes on loopback. Not covered: real Wi-Fi, see docs/perf/phase3.md.
 */
const MDNS_PORT = 15380;
const fleet = new Fleet(ENGINE_WORKER);
after(() => fleet.cleanup());

async function converged(devs: Device[], count: number, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ds = await Promise.all(devs.map((d) => d.call<{ count: number; digest: string }>('digest')));
    if (ds.every((d) => d.count === count && d.digest === ds[0]!.digest)) return ds[0]!;
    if (Date.now() > end) throw new Error(`no convergence: ${JSON.stringify(ds)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('engine over LAN: three devices', () => {
  let a: Device, b: Device, c: Device;

  it('pairs and meshes', async () => {
    [a, b, c] = await Promise.all([fleet.add('A', MDNS_PORT), fleet.add('B', MDNS_PORT), fleet.add('C', MDNS_PORT)]);
    await fleet.pair(a, b);
    await fleet.pair(a, c);
    await fleet.pair(b, c);
    await Promise.all([a, b, c].map((d) => d.call('waitLinks', { n: 2 })));
  });

  it('a task created on A appears on B and C', async () => {
    await a.call('create', { id: 't1', doc: { title: 'buy milk' } });
    await converged([a, b, c], 1);
    assert.equal((await c.call<any>('get', { id: 't1' })).title, 'buy milk');
  });

  it('edits to different fields of one task both survive, with no conflict', async () => {
    await Promise.all([
      b.call('update', { id: 't1', set: { done: true } }),
      c.call('update', { id: 't1', set: { notes: 'oat milk' } }),
    ]);
    const end = Date.now() + 15_000;
    for (;;) {
      const docs = await Promise.all([a, b, c].map((d) => d.call<any>('get', { id: 't1' })));
      if (docs.every((d) => d.done === true && d.notes === 'oat milk')) break;
      if (Date.now() > end) throw new Error(`field merge failed: ${JSON.stringify(docs)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const d of [a, b, c]) assert.equal(await d.call('conflicts'), 0);
  });

  it('the same field edited on two devices converges to one value and the loser is logged', async () => {
    await Promise.all([
      b.call('update', { id: 't1', set: { title: 'from B' } }),
      c.call('update', { id: 't1', set: { title: 'from C' } }),
    ]);
    const end = Date.now() + 15_000;
    let titles: string[] = [];
    for (;;) {
      titles = (await Promise.all([a, b, c].map((d) => d.call<any>('get', { id: 't1' })))).map((d) => d.title);
      if (titles.every((t) => t === titles[0]) && ['from B', 'from C'].includes(titles[0]!)) break;
      if (Date.now() > end) throw new Error(`no single winner: ${titles}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    const logged = (await Promise.all([a, b, c].map((d) => d.call<number>('conflicts')))).reduce((x, y) => x + y, 0);
    assert.ok(logged >= 1, 'the discarded value is recorded in the activity log');
  });

  it('a delete on one device deletes everywhere and an edit cannot resurrect it', async () => {
    await a.call('remove', { id: 't1' });
    await converged([a, b, c], 0);
    await b.call('update', { id: 't1', set: { notes: 'late edit' } }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    await converged([a, b, c], 0);
  });

  it('a device that was away catches up when it returns', async () => {
    // D is created after A, B, C have diverged work, then pairs with just A.
    await a.call('bulk', { n: 200, prefix: 'bulk-', bytes: 200 });
    await converged([a, b, c], 200);
    const d = await fleet.add('D', MDNS_PORT);
    await fleet.pair(a, d);
    await d.call('waitDigest', { count: 200 });
    // ... and, never paired with B or C directly, D still receives what they write next.
    await b.call('create', { id: 'from-b-later', doc: { title: 'relay me' } });
    await d.call('waitDigest', { count: 201 });
    await converged([a, b, c, d], 201);
    for (const dev of [a, b, c, d]) {
      const s = await dev.call<any>('status');
      assert.deepEqual(s.errors, [], `no sync errors on ${dev.name}`);
    }
  });

  it('an unpaired device on the network learns nothing', async () => {
    const x = await fleet.add('X', MDNS_PORT);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await x.call<string[]>('peers')).length, 0);
    assert.equal((await x.call<any>('digest')).count, 0);
  });
});
