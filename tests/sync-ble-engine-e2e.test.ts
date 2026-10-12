import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LanTransport } from '../src/sync/lan/index.ts';
import { TransportSelector } from '../src/sync/ble/selector.ts';
import {
  converged,
  linked,
  makeBleDevice,
  pairAll,
  realisticTask,
  seedTasks,
  startDevice,
  stopAll,
  world,
  type BleDevice,
} from './helpers/ble-world.ts';
import type { SimWorld } from '../src/sync/ble/sim.ts';

afterEach(() => stopAll());

/**
 * The REAL sync engine (field-level merge, tombstones, version vectors, headers-first)
 * over the REAL BleTransport (tunnel, framing, reconnect) on the simulated radio, with
 * virtual time. Not covered: a real radio, see docs/perf/phase4.md.
 */

async function mesh(w: SimWorld, names: string[], o: Parameters<typeof makeBleDevice>[2] = {}) {
  const devs = await Promise.all(names.map((n) => makeBleDevice(w, n, o)));
  await pairAll(devs);
  for (let i = 0; i < devs.length; i++) for (let j = i + 1; j < devs.length; j++) await linked(w, devs[i]!, devs[j]!);
  return devs;
}

async function until(w: SimWorld, pred: () => Promise<boolean> | boolean, what: string, maxVirtualMs = 1_800_000) {
  await w.until(pred, { what, maxVirtualMs });
}

describe('engine over Bluetooth: three devices', () => {
  it('create, field merge, same-field conflict and delete converge on all three', async () => {
    const w = world({ mtu: 185, bytesPerSec: 60_000, latencyMs: 50 });
    const [a, b, c] = await mesh(w, ['A', 'B', 'C']);

    // create on A appears on B and C
    await a.tasks().create({ _id: 't1', userId: 'u1', title: 'buy milk' });
    void a.coordinator.syncNow();
    await converged(w, [a!, b!, c!], 1);
    assert.equal((await c!.tasks().findOne({ _id: 't1' }))?.title, 'buy milk');

    // edits to different fields of one task both survive, and are not a conflict
    await Promise.all([b!.tasks().updateOne({ _id: 't1' }, { $set: { done: true } }), c!.tasks().updateOne({ _id: 't1' }, { $set: { notes: 'oat milk' } })]);
    void b!.coordinator.syncNow();
    void c!.coordinator.syncNow();
    await until(
      w,
      async () => {
        const docs = await Promise.all([a, b, c].map((d) => d!.tasks().findOne({ _id: 't1' })));
        return docs.every((d) => d?.done === true && d?.notes === 'oat milk');
      },
      'field merge',
    );
    const conflicts = async (d: BleDevice) => (await d.store.collection('activities').find({ action: 'sync_conflict' })).length;
    for (const d of [a!, b!, c!]) assert.equal(await conflicts(d), 0);

    // the same field on two devices: one value everywhere, the loser is logged
    await Promise.all([b!.tasks().updateOne({ _id: 't1' }, { $set: { title: 'from B' } }), c!.tasks().updateOne({ _id: 't1' }, { $set: { title: 'from C' } })]);
    void b!.coordinator.syncNow();
    void c!.coordinator.syncNow();
    let titles: string[] = [];
    await until(
      w,
      async () => {
        titles = (await Promise.all([a, b, c].map((d) => d!.tasks().findOne({ _id: 't1' })))).map((d) => String(d?.title));
        return titles.every((t) => t === titles[0]) && ['from B', 'from C'].includes(titles[0]!);
      },
      'single winner',
    );
    const logged = (await Promise.all([a!, b!, c!].map(conflicts))).reduce((x, y) => x + y, 0);
    assert.ok(logged >= 1, 'the discarded value is recorded');

    // delete wins, an edit cannot resurrect it
    await a.tasks().deleteOne({ _id: 't1' });
    void a.coordinator.syncNow();
    await converged(w, [a!, b!, c!], 0);
    await b!.tasks().updateOne({ _id: 't1' }, { $set: { notes: 'late edit' } }).catch(() => undefined);
    void b!.coordinator.syncNow();
    await w.advance(20_000);
    await converged(w, [a!, b!, c!], 0);
    for (const d of [a!, b!, c!]) assert.deepEqual(d.errors, [], `no sync errors on ${d.name}`);
  });

  it('a device that was out of range catches up when it returns, and its own edits are not lost', async () => {
    const w = world({ mtu: 185, bytesPerSec: 60_000, latencyMs: 50 });
    const [a, b, c] = await mesh(w, ['A', 'B', 'C']);
    await seedTasks(a!, 20);
    void a!.coordinator.syncNow();
    await converged(w, [a!, b!, c!], 20);

    // C walks away from both.
    w.setRange(c!.radio, a!.radio, false);
    w.setRange(c!.radio, b!.radio, false);
    await until(w, () => c!.transport.links().length === 0 && a!.transport.links().length === 1 && b!.transport.links().length === 1, 'C to be lost');

    await seedTasks(a!, 5, 'a-new-', 0);
    await b!.tasks().updateOne({ _id: 'task-3' }, { $set: { done: true } });
    await c!.tasks().create({ _id: 'c-offline', userId: 'u1', title: 'written while away' });
    void a!.coordinator.syncNow();
    void b!.coordinator.syncNow();
    await converged(w, [a!, b!], 25);
    assert.equal((await c!.digest()).count, 21, 'C has seen none of it yet');

    const back = w.clock.now();
    w.setRange(c!.radio, a!.radio, true);
    w.setRange(c!.radio, b!.radio, true);
    await converged(w, [a!, b!, c!], 26);
    assert.equal((await c!.tasks().findOne({ _id: 'task-3' }))?.done, true);
    assert.ok(w.clock.now() - back < 60_000, `converged ${Math.round(w.clock.now() - back)} ms after returning`);
  });

  it('1,000 documents sync to a newly paired device, and a third device receives at most one copy per neighbour', async () => {
    const w = world({ mtu: 185, bytesPerSec: 60_000, latencyMs: 50 });
    const o = { singleInitiator: true };
    const a = await makeBleDevice(w, 'A', o);
    const b = await makeBleDevice(w, 'B', o);
    const c = await makeBleDevice(w, 'C', o);
    await seedTasks(a, 1000);
    await pairAll([a, b]);
    await linked(w, a, b);
    const t0 = w.clock.now();
    void a.coordinator.syncNow();
    await converged(w, [a, b], 1000);
    const initial = w.clock.now() - t0;
    const da = await a.digest();
    assert.equal((await b.digest()).digest, da.digest);
    const bIn = b.ble.wireStats().frameBytesIn;
    await pairAll([a, c]);
    await pairAll([b, c]);
    await linked(w, a, c);
    await linked(w, b, c);
    await converged(w, [a, b, c], 1000);
    await w.advance(5000);
    const cIn = c.ble.wireStats().frameBytesIn;
    // With one initiator per link, a document crosses each link at most once, so C (two neighbours
    // that both hold everything) receives at most about twice what B did. The engine has no way to
    // tell one neighbour that another is already sending the same document (documented limit).
    assert.ok(cIn < bIn * 2.3, `C received ${cIn} framed bytes, B received ${bIn} for the same data`);
    for (const d of [a, b, c]) assert.deepEqual(d.errors.filter((e) => !/closed/.test(e)), []);
    console.log(`  1k docs over BLE (MTU 185, 60 KB/s, 50 ms): ${Math.round(initial / 100) / 10} s virtual; C received ${cIn} framed B vs ${bIn} B for B itself`);
  });

  it('with a single initiator per link, the other end starts its own round if the initiator never does', async () => {
    const w = world();
    const a = await makeBleDevice(w, 'A', { singleInitiator: true, deferStart: true });
    const b = await makeBleDevice(w, 'B', { singleInitiator: true, deferStart: true });
    const [low, high] = a.identity.info.nodeId < b.identity.info.nodeId ? [a, b] : [b, a];
    await seedTasks(high, 15);
    await pairAll([a, b]);
    low.coordinator.stop(); // the designated initiator is wedged and will never start a round
    for (const d of [a, b]) {
      d.coordinator.start();
      await d.transport.start();
    }
    await linked(w, a, b);
    await w.advance(5000);
    assert.equal((await low.digest()).count, 0, 'nothing moved yet: the passive end is waiting');
    await converged(w, [a, b], 15, { maxVirtualMs: 120_000 });
  });

  it('realistic documents survive the round trip exactly (dates, arrays, empty strings)', async () => {
    const w = world();
    const [a, b] = await mesh(w, ['A', 'B']);
    await seedTasks(a!, 60);
    void a!.coordinator.syncNow();
    await converged(w, [a!, b!], 60);
    for (let i = 0; i < 60; i++) {
      const want = realisticTask(i);
      const got = (await b!.tasks().findOne({ _id: `task-${i}` }))!;
      for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], `field ${k} of task-${i}`);
    }
  });
});

describe('Wi-Fi preferred when both transports reach a peer', () => {
  it('uses Bluetooth alone, switches to Wi-Fi when it appears, and falls back to Bluetooth when Wi-Fi goes', async () => {
    const w = world({ mtu: 185, bytesPerSec: 60_000, latencyMs: 50 });
    const lans = new Map<string, LanTransport>();
    const selectors = new Map<string, TransportSelector>();
    const make = (name: string) =>
      makeBleDevice(w, name, {
        deferStart: true,
        transport: (ble, d) => {
          const lan = new LanTransport({ identity: d.identity, peers: d.peers, host: '127.0.0.1', advertiseHost: '127.0.0.1', discovery: false, backoff: { minMs: 100, maxMs: 500 } });
          const sel = new TransportSelector([lan, ble], { timers: w.clock, standbyGraceMs: 8000 });
          lans.set(name, lan);
          selectors.set(name, sel);
          return sel;
        },
      });
    const x = await make('X');
    const y = await make('Y');
    await pairAll([x, y]);
    for (const d of [x, y]) {
      d.coordinator.start();
      await d.ble.start();
    }
    const kindOf = (d: BleDevice) => d.transport.links()[0]?.transport;
    await until(w, () => kindOf(x) === 'ble' && kindOf(y) === 'ble', 'Bluetooth link');

    // 1. over Bluetooth only
    await x.tasks().create({ _id: 'over-ble', userId: 'u1', title: 'first' });
    void x.coordinator.syncNow();
    await converged(w, [x, y], 1);
    const bleBytes1 = x.ble.wireStats().airBytesOut + y.ble.wireStats().airBytesOut;
    assert.ok(bleBytes1 > 0);

    // 2. Wi-Fi comes up: it becomes the link, and sync traffic moves to it
    const lanX = lans.get('X')!;
    const lanY = lans.get('Y')!;
    await lanX.start();
    await lanY.start();
    lanX.addManualAddress(y.identity.info.nodeId, '127.0.0.1', lanY.port);
    lanY.addManualAddress(x.identity.info.nodeId, '127.0.0.1', lanX.port);
    await until(w, () => kindOf(x) === 'lan' && kindOf(y) === 'lan', 'Wi-Fi link to take over');
    await w.advance(1000);
    const bleBefore = x.ble.wireStats().airBytesOut + y.ble.wireStats().airBytesOut;
    await y.tasks().create({ _id: 'over-lan', userId: 'u1', title: 'second' });
    void y.coordinator.syncNow();
    await converged(w, [x, y], 2);
    const lanBytes = lanX.wireStats().bytesIn + lanY.wireStats().bytesIn;
    assert.ok(lanBytes > 0, 'the change travelled over Wi-Fi');
    const bleAfter = x.ble.wireStats().airBytesOut + y.ble.wireStats().airBytesOut;
    // Only keep-alive pings may have used Bluetooth in the meantime.
    assert.ok(bleAfter - bleBefore < 400, `Bluetooth carried ${bleAfter - bleBefore} bytes while Wi-Fi was up`);

    // 3. standby Bluetooth is dropped after the grace period (radio stays quiet)
    await w.advance(12_000);
    assert.equal(x.ble.links().length, 0);
    assert.equal(x.radio.scanning, false);
    assert.equal(kindOf(x), 'lan');

    // 4. Wi-Fi disappears: Bluetooth takes over again, without re-pairing
    await lanY.stop();
    await until(w, () => kindOf(x) === 'ble' && kindOf(y) === 'ble', 'fallback to Bluetooth', 600_000);
    await x.tasks().create({ _id: 'back-on-ble', userId: 'u1', title: 'third' });
    void x.coordinator.syncNow();
    await converged(w, [x, y], 3);
    for (const d of [x, y]) assert.deepEqual(d.errors.filter((e) => !/closed|socket|ECONN|reset/i.test(e)), []);
    await lanX.stop();
  });
});

void startDevice;
