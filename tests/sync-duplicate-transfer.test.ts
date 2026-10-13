import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makePeer, settle, snapshot, type Peer } from './helpers/syncHarness.ts';
import { LoopbackTransport } from '../src/sync/transport.ts';
import { LanSyncCoordinator } from '../src/sync/lan/rpc.ts';
import type { PeerLinkTransport, SyncPeerLink } from '../src/sync/transport-contract.ts';
import type { SyncTransport } from '../src/sync/types.ts';

/**
 * Bounds for docs/sync-duplicate-transfer-tasks.md T6, T1, T2 and T3: a regression that
 * sends a document twice fails here, not only in a perf report.
 */
const N = 300;
const lan = { headersFirst: true, shareProgress: true };

async function neighbours(k: number): Promise<Peer[]> {
  const peers = await Promise.all(Array.from({ length: k }, (_, i) => makePeer(`N${i}`)));
  for (let i = 0; i < N; i++) await peers[0]!.store.collection('tasks').create({ _id: `t${i}`, userId: 'u1', title: `Task ${i}` });
  for (const p of peers.slice(1)) await p.engine.syncWith(new LoopbackTransport(peers[0]!.engine.service()), lan);
  return peers;
}

const to = (p: Peer) => new LoopbackTransport(p.engine.service());

describe('duplicate transfer', () => {
  for (const k of [2, 3]) {
    it(`T1: a device joining ${k} neighbours at once receives each document once`, async () => {
      const ns = await neighbours(k);
      const j = await makePeer('J');
      const results = await Promise.all(ns.map((n) => j.engine.syncWith(to(n), lan)));
      const received = results.reduce((a, r) => a + r.traffic.docsReceived, 0);
      const dups = results.reduce((a, r) => a + r.traffic.duplicates, 0);
      assert.equal(received, N);
      assert.equal(dups, 0);
      assert.deepEqual(await snapshot(j), await snapshot(ns[0]!));
      // T6: the totals show up in status too
      const status = await j.engine.status();
      assert.equal(status.traffic.docsReceived, N);
      assert.equal(status.traffic.duplicates, 0);
    });
  }

  it('T1: a neighbour failing mid-fetch leaves nothing missing; the other brings it in', async () => {
    const [a, b] = await neighbours(2);
    const j = await makePeer('J');
    const inner = to(a!);
    const failing: SyncTransport = {
      kind: 'failing',
      hello: (r) => inner.hello(r),
      push: (r) => inner.push(r),
      // headers arrive, then the content fetch dies, as when a link drops
      pull: async (r) => {
        if (r.ids) {
          await new Promise((res) => setTimeout(res, 5));
          throw new Error('link closed');
        }
        return inner.pull(r);
      },
    };
    const outcomes = await Promise.allSettled([j.engine.syncWith(failing, lan), j.engine.syncWith(to(b!), lan)]);
    assert.equal(outcomes[0]!.status, 'rejected');
    assert.equal(outcomes[1]!.status, 'fulfilled');
    assert.equal(Object.keys(await snapshot(j)).length, N, 'everything A claimed was fetched from B instead');
  });

  it('T2: after pulling from a neighbour, that neighbour has nothing to send back', async () => {
    const [a] = await neighbours(1);
    const j = await makePeer('J');
    await j.engine.syncWith(to(a!), lan);
    const back = await a!.engine.syncWith(to(j), lan);
    assert.equal(back.traffic.docsSent + back.traffic.docsReceived, 0);
    assert.equal(back.traffic.headersSent, 0, 'A knows J already holds everything');
    assert.equal(back.traffic.headersReceived, 0, 'J told A it pushed nothing new');
  });

  it('T2: progress sharing cuts the headers in the neighbours\' rounds back to a joiner', async () => {
    const run = async (shareProgress: boolean) => {
      const ns = await neighbours(2);
      const j = await makePeer('J');
      const opts = { headersFirst: true, shareProgress };
      await Promise.all(ns.map((n) => j.engine.syncWith(to(n), opts)));
      const back = await Promise.all(ns.map((n) => n.engine.syncWith(to(j), opts)));
      return back.reduce((t, r) => t + r.traffic.headersSent + r.traffic.headersReceived + r.traffic.docsSent, 0);
    };
    const without = await run(false);
    const withShare = await run(true);
    assert.ok(withShare <= without / 2, `${withShare} <= ${without} / 2`);
  });

  it('T2: edits made after the acknowledged point still travel', async () => {
    const [a] = await neighbours(1);
    const j = await makePeer('J');
    await j.engine.syncWith(to(a!), lan);
    await a!.store.collection('tasks').updateOne({ _id: 't1' }, { $set: { title: 'renamed on A' } });
    await j.store.collection('tasks').updateOne({ _id: 't2' }, { $set: { title: 'renamed on J' } });
    await a!.engine.syncWith(to(j), lan);
    await settle([a!, j]);
    for (const p of [a!, j]) {
      const s = await snapshot(p);
      assert.equal((s['t1'] as any).title, 'renamed on A');
      assert.equal((s['t2'] as any).title, 'renamed on J');
    }
  });

  it('T3: only the lower id starts the round when a link comes up', async () => {
    const [x, y] = await Promise.all([makePeer('X'), makePeer('Y')]);
    const tx = new MemTransport('id-a');
    const ty = new MemTransport('id-b');
    const started: string[] = [];
    const cx = new LanSyncCoordinator(x.engine, tx, { onResult: () => started.push('X'), passiveFallbackMs: 60_000 });
    const cy = new LanSyncCoordinator(y.engine, ty, { onResult: () => started.push('Y'), passiveFallbackMs: 60_000 });
    cx.start();
    cy.start();
    MemTransport.connect(tx, ty);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(started, ['X'], 'id-a < id-b, so only X initiated');
    cx.stop();
    cy.stop();
  });
});

/** Two in-memory link endpoints, enough for the coordinator. */
class MemTransport implements PeerLinkTransport {
  readonly kind = 'lan' as const;
  private up: Array<(l: SyncPeerLink) => void> = [];
  private down: Array<(id: string) => void> = [];
  private live: SyncPeerLink[] = [];
  constructor(readonly localId: string) {}
  async start() {}
  async stop() {}
  onPeerUp(h: (l: SyncPeerLink) => void) {
    this.up.push(h);
  }
  onPeerDown(h: (id: string) => void) {
    this.down.push(h);
  }
  links() {
    return this.live;
  }
  static connect(a: MemTransport, b: MemTransport) {
    const mk = (self: MemTransport, other: MemTransport) => {
      let handler: ((m: Uint8Array) => void | Promise<void>) | undefined;
      const link: SyncPeerLink & { deliver: (m: Uint8Array) => void } = {
        peerId: other.localId,
        peerName: other.localId,
        transport: 'lan',
        send: async (m) => void setImmediate(() => peer.deliver(m)),
        onMessage: (h) => void (handler = h),
        onClose: () => undefined,
        close: () => undefined,
        deliver: (m) => void handler?.(m),
      };
      let peer!: { deliver: (m: Uint8Array) => void };
      return { link, setPeer: (p: { deliver: (m: Uint8Array) => void }) => (peer = p) };
    };
    const la = mk(a, b);
    const lb = mk(b, a);
    la.setPeer(lb.link);
    lb.setPeer(la.link);
    a.live.push(la.link);
    b.live.push(lb.link);
    a.up.forEach((h) => h(la.link));
    b.up.forEach((h) => h(lb.link));
  }
}
