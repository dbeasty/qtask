/**
 * Randomised convergence: three peers make concurrent edits, creates and deletes
 * while syncing in arbitrary pairs (some syncs fail halfway), and must end up with
 * identical data, which a further round of syncs must not change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { link, makePeer, settle, snapshot, type Peer } from './helpers/syncHarness.ts';
import { LoopbackTransport } from '../src/sync/transport.ts';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const STATUSES = ['todo', 'in_progress', 'done'];
const TAGS = ['ops', 'home', 'urgent', 'later'];

async function randomOp(peer: Peer, random: () => number, ids: string[]): Promise<void> {
  const tasks = peer.store.collection('tasks');
  const pick = <T,>(list: T[]): T => list[Math.floor(random() * list.length)]!;
  const roll = random();
  const known = (await tasks.find({}, { select: '_id' })).map((t) => String(t._id));

  if (roll < 0.2 || known.length === 0) {
    const created = await tasks.create({
      userId: 'u1',
      title: pick(TITLES),
      status: pick(STATUSES),
      tags: [pick(TAGS)],
      sortOrder: Math.floor(random() * 100),
    });
    ids.push(String(created._id));
    return;
  }
  const target = pick(known);
  if (roll < 0.3) {
    await tasks.deleteOne({ _id: target });
  } else if (roll < 0.5) {
    await tasks.updateOne({ _id: target }, { $set: { title: pick(TITLES) } });
  } else if (roll < 0.65) {
    await tasks.updateOne({ _id: target }, { $set: { status: pick(STATUSES) } });
  } else if (roll < 0.75) {
    await tasks.updateOne({ _id: target }, { $set: { tags: [pick(TAGS), pick(TAGS)] } });
  } else if (roll < 0.82) {
    await tasks.updateOne({ _id: target }, { $unset: { description: 1 } });
  } else if (roll < 0.9) {
    await tasks.updateOne({ _id: target }, { $set: { description: `d${Math.floor(random() * 1000)}`, dueDate: new Date(1_700_000_000_000 + Math.floor(random() * 1e9)) } });
  } else {
    await peer.store.collection('comments').create({ userId: 'u1', taskId: target, body: `c${Math.floor(random() * 1000)}` });
  }
}

async function flakySync(from: Peer, to: Peer, random: () => number): Promise<void> {
  // Fail some calls mid-sync to exercise retry safety.
  const transport = new LoopbackTransport(to.engine.service(), (op) => {
    if (op !== 'hello' && random() < 0.12) throw new Error('simulated network drop');
  });
  try {
    await from.engine.syncWith(transport);
  } catch {
    // expected
  }
}

async function comparePeers(peers: Peer[]): Promise<void> {
  for (const coll of ['tasks', 'comments'] as const) {
    const first = await snapshot(peers[0]!, coll);
    for (const peer of peers.slice(1)) {
      assert.deepEqual(await snapshot(peer, coll), first, `${coll}: ${peer.name} diverged from ${peers[0]!.name}`);
    }
  }
  // Conflict log entries are replicated documents too; they must agree as well.
  const activityIds = async (p: Peer) => (await p.inner.collection('activities').find({})).map((d) => String(d._id)).sort();
  const base = await activityIds(peers[0]!);
  for (const peer of peers.slice(1)) assert.deepEqual(await activityIds(peer), base, 'activity log diverged');
}

describe('three-peer convergence (randomised)', () => {
  const SEEDS = Number(process.env.SYNC_PROPERTY_SEEDS ?? 40);
  const OPS = Number(process.env.SYNC_PROPERTY_OPS ?? 60);

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: converges, and further syncs change nothing`, async () => {
      const random = rng(seed * 7919);
      const peers = [await makePeer('a'), await makePeer('b'), await makePeer('c')];
      const ids: string[] = [];

      for (let step = 0; step < OPS; step++) {
        const actor = peers[Math.floor(random() * peers.length)]!;
        await randomOp(actor, random, ids);
        if (random() < 0.25) {
          const [x, y] = [peers[Math.floor(random() * 3)]!, peers[Math.floor(random() * 3)]!];
          if (x !== y) await flakySync(x, y, random);
        }
      }

      await settle(peers);
      await comparePeers(peers);

      // Idempotence: another full pass of every pair must move nothing and change nothing.
      const before = await Promise.all(peers.map((p) => snapshot(p)));
      for (const a of peers) {
        for (const b of peers) {
          if (a === b) continue;
          const result = await a.engine.syncWith(link(a, b));
          assert.equal(result.pulled + result.pushed, 0, `${a.name}->${b.name} moved data after settling`);
        }
      }
      assert.deepEqual(await Promise.all(peers.map((p) => snapshot(p))), before);
    });
  }

  it('converges when two peers apply the same changes in opposite orders', async () => {
    const a = await makePeer('a');
    const b = await makePeer('b');
    const c = await makePeer('c');
    const task = await a.store.collection('tasks').create({ userId: 'u1', title: 'base', status: 'todo' });
    await settle([a, b, c]);
    await a.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'A' } });
    await b.store.collection('tasks').updateOne({ _id: task._id }, { $set: { title: 'B', status: 'done' } });
    await c.store.collection('tasks').deleteOne({ _id: task._id });
    // c receives a then b; a receives c then b; b receives c then a
    await c.engine.syncWith(link(c, a));
    await c.engine.syncWith(link(c, b));
    await a.engine.syncWith(link(a, c));
    await a.engine.syncWith(link(a, b));
    await b.engine.syncWith(link(b, c));
    await b.engine.syncWith(link(b, a));
    await settle([a, b, c]);
    await comparePeers([a, b, c]);
  });
});
