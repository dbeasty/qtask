import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fleet, type Device } from './helpers/lan-fleet.ts';

/**
 * Three separate Node processes, each with its own data directory, identity and
 * LAN transport, on loopback. They really do pair (QR flow), discover each other
 * over multicast DNS, connect over pinned TLS and converge. What this cannot cover:
 * real Wi-Fi (client isolation, multicast filtering, roaming) and real multi-host
 * routing. See docs/perf/phase3.md.
 */
const MDNS_PORT = 15360;
const fleet = new Fleet();
after(() => fleet.cleanup());

async function converged(devs: Device[], timeoutMs = 10_000): Promise<{ count: number; digest: string }> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ds = await Promise.all(devs.map((d) => d.call<{ count: number; digest: string }>('digest')));
    if (ds.every((d) => d.digest === ds[0]!.digest)) return ds[0]!;
    if (Date.now() > end) throw new Error(`no convergence: ${JSON.stringify(ds)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('LAN e2e: three devices', () => {
  let a: Device, b: Device, c: Device;

  it('pairs, discovers and connects a full mesh', async () => {
    [a, b, c] = await Promise.all([fleet.add('A', MDNS_PORT), fleet.add('B', MDNS_PORT), fleet.add('C', MDNS_PORT)]);
    await fleet.pair(a, b);
    await fleet.pair(a, c);
    await fleet.pair(b, c);
    await Promise.all([a, b, c].map((d) => d.call('waitLinks', { n: 2 })));
    for (const d of [a, b, c]) assert.equal((await d.call<string[]>('peers')).length, 2);
  });

  it('a change on one device reaches both others', async () => {
    await a.call('put', { id: 'task-1', value: { title: 'buy milk' } });
    await Promise.all([b.call('waitDoc', { id: 'task-1' }), c.call('waitDoc', { id: 'task-1' })]);
    const d = await converged([a, b, c]);
    assert.equal(d.count, 1);
  });

  it('concurrent edits to the same document converge to one winner everywhere', async () => {
    await Promise.all([
      b.call('put', { id: 'shared', value: 'from-b' }),
      c.call('put', { id: 'shared', value: 'from-c' }),
      a.call('put', { id: 'only-a', value: 1 }),
    ]);
    await converged([a, b, c]);
    const vals = await Promise.all([a, b, c].map((d) => d.call('get', { id: 'shared' })));
    assert.equal(new Set(vals.map((v: any) => v.hlc)).size, 1);
  });

  it('a device that was killed rejoins by discovery alone and catches up', async () => {
    const dir = c.dir;
    const oldPort = c.info.port;
    await c.kill();
    await a.call('put', { id: 'while-c-was-down', value: true });
    await b.call('put', { id: 'also-while-down', value: true });
    const c2 = await fleet.add('C', MDNS_PORT, dir); // same identity + pairings, new process, new port
    assert.notEqual(c2.info.port, oldPort, 'new process listens on a new port; only discovery can find it');
    assert.equal(c2.info.nodeId, c.info.nodeId);
    c = c2;
    await c.call('waitDoc', { id: 'while-c-was-down', timeoutMs: 20_000 });
    await c.call('waitDoc', { id: 'also-while-down', timeoutMs: 20_000 });
    const d = await converged([a, b, c]);
    assert.equal(d.count, 5);
  });

  it('an unpaired device on the same network learns nothing and joins nothing', async () => {
    const stranger = await fleet.add('Stranger', MDNS_PORT);
    for (const target of [a, b, c]) {
      const r = await stranger.call<{ received: number }>('probe', { port: target.info.port });
      assert.equal(r.received, 0, 'no application byte may reach an unpaired peer');
    }
    await new Promise((r) => setTimeout(r, 1500)); // plenty of time for discovery to (wrongly) connect
    assert.equal((await stranger.call<string[]>('peers')).length, 0);
    assert.equal(await stranger.call('count'), 0);
    assert.equal((await a.call<string[]>('peers')).length, 2, 'existing links untouched');
    assert.ok(a.events.some((e) => e.event === 'security' && e.e.reason === 'unpaired-client'));
  });
});
