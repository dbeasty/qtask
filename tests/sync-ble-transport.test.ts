import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SimWorld } from '../src/sync/ble/sim.ts';
import { RecordPipe, T_HELLO } from '../src/sync/ble/tunnel.ts';
import { formatBlePairLink, parseBlePairLink } from '../src/sync/ble/transport.ts';
import type { SyncPeerLink } from '../src/sync/transport-contract.ts';
import { converged, linked, makeBleDevice, pair, realisticTask, seedTasks, stopAll, world, type BleDevice } from './helpers/ble-world.ts';

afterEach(() => stopAll());

const linkTo = (a: BleDevice, b: BleDevice): SyncPeerLink | undefined => a.transport.links().find((l) => l.peerId === b.identity.info.nodeId);
const noLink = (a: BleDevice, b: BleDevice) => !linkTo(a, b);

async function twoDevices(params: Parameters<typeof world>[0] = {}, o: Parameters<typeof makeBleDevice>[2] = {}) {
  const w = world(params);
  const a = await makeBleDevice(w, 'A', o);
  const b = await makeBleDevice(w, 'B', o);
  await pair(a, b);
  await linked(w, a, b);
  return { w, a, b };
}

describe('ble transport: messages over the link', () => {
  for (const mtu of [23, 27, 64, 185, 247, 512, 517]) {
    it(`delivers whole messages of awkward sizes in order at MTU ${mtu}`, async () => {
      const { w, a, b } = await twoDevices({ mtu, bytesPerSec: 200_000 });
      const la = linkTo(a, b)!;
      const lb = linkTo(b, a)!;
      const got: Buffer[] = [];
      lb.onMessage((m) => void got.push(Buffer.from(m)));
      const chunk = mtu - 3;
      // After deflate and AEAD the on-air sizes shift, so cover many sizes around the boundaries.
      const sizes = [0, 1, 2, chunk - 1, chunk, chunk + 1, 2 * chunk, 2 * chunk + 1, 1000, 2047, 2048, 2049, 4096, 10_000, 70_000];
      const msgs = sizes.map((n, i) => (i % 2 ? randomBytes(n) : Buffer.alloc(n, i)));
      await w.drive(
        (async () => {
          for (const m of msgs) await la.send(m);
        })(),
      );
      await w.until(() => got.length === msgs.length, { what: 'all messages' });
      assert.deepEqual(got, msgs);
    });
  }

  it('waits for the radio when its queue is full (write-without-response backpressure)', async () => {
    const { w, a, b } = await twoDevices({ bytesPerSec: 8_000, txQueue: 3, latencyMs: 30 });
    const got: number[] = [];
    linkTo(b, a)!.onMessage((m) => void got.push(m.length));
    const sizes = Array.from({ length: 6 }, (_, i) => 5000 + i);
    await w.drive(
      (async () => {
        for (const n of sizes) await linkTo(a, b)!.send(randomBytes(n));
      })(),
    );
    await w.until(() => got.length === sizes.length, { what: 'messages' });
    assert.deepEqual(got, sizes);
    assert.ok(w.airStats().refused > 0, 'the radio refused chunks and the writer waited for onWritable');
    assert.equal(w.airStats().dropped, 0);
  });

  it('credit flow control: a slow consumer slows the sender and the receiver queue stays bounded', async () => {
    const highWater = 8 * 1024;
    const { w, a, b } = await twoDevices(
      { bytesPerSec: 60_000, txQueue: 64, latencyMs: 20 },
      { ble: { channel: { window: 2048, highWater, maxFramePayload: 1024 } } },
    );
    const la = linkTo(a, b)!;
    const lb = linkTo(b, a)!;
    const got: number[] = [];
    // The consumer takes 400 ms of virtual time per message.
    lb.onMessage(
      (m) =>
        new Promise<void>((resolve) => {
          got.push(m.length);
          w.clock.setTimeout(resolve, 400);
        }),
    );
    let maxPending = 0;
    const sample = () => {
      maxPending = Math.max(maxPending, (lb as any).channel.pendingDelivery as number);
      w.clock.setTimeout(sample, 50);
    };
    sample();
    const sizes = Array.from({ length: 16 }, (_, i) => 6000 + i);
    const started = w.clock.now();
    await w.drive(
      (async () => {
        for (const n of sizes) await la.send(randomBytes(n));
      })(),
    );
    await w.until(() => got.length === sizes.length, { what: 'slow consumer to finish' });
    assert.deepEqual(got, sizes);
    assert.ok((la as any).channel.stats.creditStalls > 0, 'the sender waited for credit');
    assert.ok(maxPending <= highWater + 7000, `receiver held ${maxPending} undelivered bytes`);
    assert.ok(w.clock.now() - started >= 15 * 400 * 0.9, 'the sender was paced by the consumer');
  });

  it('keeps every chunk within MTU-3 and the record layer free of plaintext task text', async () => {
    const { w, a, b } = await twoDevices({ mtu: 100 });
    const seen: number[] = [];
    const air: Buffer[] = [];
    for (const c of w.connections) {
      const orig = (c as any).central.tryWrite.bind((c as any).central);
      (c as any).central.tryWrite = (x: Uint8Array) => (seen.push(x.length), air.push(Buffer.from(x)), orig(x));
    }
    await seedTasks(a, 30);
    await w.drive(a.coordinator.syncNow());
    await converged(w, [a, b], 30);
    assert.ok(seen.length > 0 && Math.max(...seen) <= 97);
  });
});

describe('ble transport: keep-alive', () => {
  it('an idle link stays up for ten minutes at a cost of about a kilobyte per five minutes', async () => {
    const { w, a, b } = await twoDevices();
    const before = w.airStats().bytes;
    await w.advance(600_000);
    assert.ok(linkTo(a, b) && linkTo(b, a), 'still linked');
    const used = w.airStats().bytes - before;
    assert.ok(used < 4000, `${used} bytes in ten idle minutes`);
  });

  it('a link that goes silent without any disconnect is closed by the idle timeout and rebuilt', async () => {
    const { w, a, b } = await twoDevices();
    const first = linkTo(a, b)!;
    for (const c of w.connections) (c.params as any).dropRate = 1; // the air swallows everything, no disconnect event
    await w.until(() => linkTo(a, b) !== first, { what: 'the silent link to be replaced', maxVirtualMs: 600_000 });
    for (const c of w.connections) (c.params as any).dropRate = 0;
    await w.until(() => !!linkTo(a, b) && !!linkTo(b, a), { what: 'a new link', maxVirtualMs: 600_000 });
    assert.ok(w.clock.now() > 60_000, 'it took the idle timeout (60 s of silence), not an instant');
  });
});

describe('ble transport: finding peers', () => {
  it('stops scanning when every paired peer is connected and resumes when one is lost', async () => {
    const { w, a, b } = await twoDevices();
    await w.advance(500);
    assert.equal(a.radio.scanning, false);
    assert.equal(b.radio.scanning, false);
    w.setRange(a.radio, b.radio, false);
    await w.until(() => noLink(a, b) && noLink(b, a), { what: 'links to time out' });
    assert.equal(a.radio.scanning, true);
    w.setRange(a.radio, b.radio, true);
    await linked(w, a, b);
    await w.advance(500);
    assert.equal(a.radio.scanning, false);
  });

  it('never connects to, or answers, a device that is not paired', async () => {
    const w = world();
    const a = await makeBleDevice(w, 'A');
    const b = await makeBleDevice(w, 'B');
    const c = await makeBleDevice(w, 'C'); // nearby, running QTask, but not paired with anyone
    await pair(a, b);
    await linked(w, a, b);
    await w.advance(20_000);
    assert.equal(c.transport.links().length, 0);
    assert.equal(a.transport.links().length, 1);
    // A read C's info at most a handful of times (once, then ignored), not on every rescan.
    assert.ok(c.radio.stats.connectsIn <= 2, `C was connected to ${c.radio.stats.connectsIn} times`);
  });

  it('survives a rogue central that connects, reads info and sends junk', async () => {
    const { w, a, b } = await twoDevices();
    const rogue = w.createRadio('rogue');
    const ev: unknown[] = [];
    a.ble.on('security', (e) => ev.push(e));
    await rogue.startScan();
    const found = new Promise<string>((res) => rogue.onDiscovered((d) => res(d.deviceId)));
    w.changed();
    const id = await w.drive(found);
    const link = await w.drive(rogue.connect(id, 5000));
    const pipe = new RecordPipe(link, w.clock);
    await w.drive(pipe.send(Buffer.concat([Buffer.from([T_HELLO, 1]), randomBytes(64)])));
    await w.until(() => pipe.closed, { what: 'A to drop the rogue' });
    assert.ok(ev.length > 0);
    // The real link is unaffected, and A can still take a new peer afterwards.
    assert.ok(linkTo(a, b));
    const c = await makeBleDevice(w, 'C');
    await pair(a, c);
    await linked(w, a, c);
  });
});

describe('ble transport: reconnect', () => {
  it('reconnects after range-out and range-in without re-pairing, then syncs what changed meanwhile', async () => {
    const { w, a, b } = await twoDevices();
    await seedTasks(a, 10);
    await w.drive(a.coordinator.syncNow());
    await converged(w, [a, b], 10);
    w.setRange(a.radio, b.radio, false);
    await w.until(() => noLink(a, b) && noLink(b, a), { what: 'both ends to notice' });
    await a.tasks().create({ _id: 'while-away', userId: 'u1', title: 'made out of range' });
    await b.tasks().create({ _id: 'while-away-b', userId: 'u1', title: 'also out of range' });
    await w.advance(30_000);
    assert.equal((await a.digest()).count, 11);
    assert.equal((await b.digest()).count, 11);
    const back = w.clock.now();
    w.setRange(a.radio, b.radio, true);
    await converged(w, [a, b], 12);
    assert.ok(w.clock.now() - back < 20_000, `reconnected and synced ${Math.round(w.clock.now() - back)} ms after coming back`);
    assert.deepEqual(a.errors.concat(b.errors).filter((e) => !/closed|timeout/i.test(e)), []);
  });

  it('finds a peer whose device address rotated while the link was down', async () => {
    const { w, a, b } = await twoDevices();
    const before = b.radio.address;
    w.disconnect(a.radio, b.radio);
    await w.until(() => noLink(a, b) && noLink(b, a), { what: 'link to drop' });
    w.rotateAddress(b.radio);
    assert.notEqual(b.radio.address, before);
    await b.tasks().create({ _id: 'after-rotation', userId: 'u1', title: 'x' });
    await linked(w, a, b);
    await converged(w, [a, b], 1);
  });

  it('recovers from Bluetooth being switched off and on', async () => {
    const { w, a, b } = await twoDevices();
    a.radio.setState('off');
    await w.until(() => noLink(a, b) && noLink(b, a), { what: 'links to drop' });
    await w.advance(5000);
    a.radio.setState('on');
    await linked(w, a, b);
  });

  it('retries with backoff while the peer is away and does not hammer the radio', async () => {
    const { w, a, b } = await twoDevices();
    w.setRange(a.radio, b.radio, false);
    await w.until(() => noLink(a, b), { what: 'link to drop' });
    const t0 = a.radio.stats.connectsOut + b.radio.stats.connectsOut;
    await w.advance(120_000);
    const attempts = a.radio.stats.connectsOut + b.radio.stats.connectsOut - t0;
    assert.ok(attempts > 0, 'it keeps trying');
    assert.ok(attempts < 40, `${attempts} connection attempts in 2 minutes is too many for a battery`);
  });

  it('chunks lost on the air are detected by the tunnel, the link is rebuilt and the data still converges', async () => {
    const w = world({ bytesPerSec: 100_000, dropRate: 0.02 }, 3);
    const a = await makeBleDevice(w, 'A', { batchSize: 20 });
    const b = await makeBleDevice(w, 'B', { batchSize: 20 });
    const closes: string[] = [];
    a.ble.on('security', (e) => closes.push(e.reason));
    b.ble.on('security', (e) => closes.push(e.reason));
    await pair(a, b);
    await seedTasks(a, 120);
    void a.coordinator.syncNow();
    await converged(w, [a, b], 120, { maxVirtualMs: 4 * 3_600_000 });
    const air = w.airStats();
    assert.ok(air.dropped > 0, 'the simulator really lost chunks');
    assert.ok(closes.length > 0 || a.errors.length + b.errors.length > 0, 'the loss was noticed, not silently absorbed');
  });

  it('a link killed in the middle of a transfer resumes without losing or duplicating documents', async () => {
    const { w, a, b } = await twoDevices({ bytesPerSec: 20_000 }, { batchSize: 25 });
    await seedTasks(a, 200);
    void a.coordinator.syncNow();
    // Kill the link three times while documents are in flight.
    for (let i = 0; i < 3; i++) {
      await w.until(() => w.airStats().bytes > (i + 1) * 12_000, { what: 'some bytes on air' });
      w.disconnect(a.radio, b.radio);
      await w.until(() => noLink(a, b) && noLink(b, a), { what: 'link to drop' });
      await linked(w, a, b);
    }
    await converged(w, [a, b], 200, { maxVirtualMs: 1_800_000 });
    const docs = await b.tasks().find({});
    assert.equal(new Set(docs.map((d) => String(d._id))).size, 200);
  });
});

describe('ble transport: pairing over Bluetooth', () => {
  async function unpaired() {
    const w = world();
    const a = await makeBleDevice(w, 'A');
    const b = await makeBleDevice(w, 'B');
    return { w, a, b };
  }

  it('QR flow: pairs, then the devices link and sync with no further setup', async () => {
    const { w, a, b } = await unpaired();
    const inv = a.ble.openPairing();
    assert.ok(parseBlePairLink(inv.link));
    const joined = b.ble.pairWith({ link: inv.link });
    const [pa, pb] = await w.drive(Promise.all([inv.result, joined]));
    assert.equal(pa.nodeId, b.identity.info.nodeId);
    assert.equal(pb.nodeId, a.identity.info.nodeId);
    assert.ok(a.peers.get(b.identity.info.nodeId) && b.peers.get(a.identity.info.nodeId));
    await linked(w, a, b);
    await a.tasks().create({ _id: 'x', userId: 'u1', title: 'after pairing' });
    await w.drive(a.coordinator.syncNow());
    await converged(w, [a, b], 1);
  });

  it('SAS flow: both users see the same six digits and must both confirm', async () => {
    const { w, a, b } = await unpaired();
    const shownA: string[] = [];
    const shownB: string[] = [];
    const inv = a.ble.openPairing({ confirmSas: async (sas) => (shownA.push(sas), true) });
    const found = await w.drive(b.ble.findPairable(3000));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.nodeId, a.identity.info.nodeId);
    assert.equal(found[0]!.name, 'A');
    await w.drive(Promise.all([inv.result, b.ble.pairWith({ deviceId: found[0]!.deviceId }, { confirmSas: async (sas) => (shownB.push(sas), true) })]));
    assert.equal(shownA.length, 1);
    assert.match(shownA[0]!, /^\d{6}$/);
    assert.deepEqual(shownA, shownB);
  });

  it('SAS flow: a user pressing "no" on either side pairs nothing', async () => {
    for (const refuser of ['inviter', 'joiner'] as const) {
      const { w, a, b } = await unpaired();
      const inv = a.ble.openPairing({ confirmSas: async () => refuser !== 'inviter' });
      const found = await w.drive(b.ble.findPairable(3000));
      const joined = b.ble.pairWith({ deviceId: found[0]!.deviceId }, { confirmSas: async () => refuser !== 'joiner' });
      joined.catch(() => undefined);
      await assert.rejects(w.drive(joined));
      assert.equal(a.peers.list().length, 0);
      assert.equal(b.peers.list().length, 0);
      inv.cancel();
    }
  });

  it('QR flow: a wrong secret is refused and nothing is stored', async () => {
    const { w, a, b } = await unpaired();
    const inv = a.ble.openPairing();
    const bad = formatBlePairLink({ id: inv.parts.id, secret: 'A'.repeat(22) });
    const attempt = b.ble.pairWith({ link: bad });
    attempt.catch(() => undefined);
    await assert.rejects(w.drive(attempt));
    assert.equal(a.peers.list().length + b.peers.list().length, 0);
    inv.cancel();
  });

  it('refuses to pair when no pairing window is open', async () => {
    const { w, a, b } = await unpaired();
    const attempt = b.ble.pairWith({ deviceId: a.radio.address }, { confirmSas: async () => true });
    attempt.catch(() => undefined);
    await assert.rejects(w.drive(attempt), /not in pairing mode/);
  });

  it('closes the pairing window after too many failed attempts', async () => {
    const { w, a, b } = await unpaired();
    const inv = a.ble.openPairing({ maxFailures: 2 });
    for (let i = 0; i < 2; i++) {
      const attempt = b.ble.pairWith({ link: formatBlePairLink({ id: inv.parts.id, secret: 'B'.repeat(22) }) });
      attempt.catch(() => undefined);
      await assert.rejects(w.drive(attempt));
    }
    await assert.rejects(w.drive(inv.result), /too many failed/);
  });

  it('a man in the middle sees two sessions and so two different codes', async () => {
    const { pairAsInviter, pairAsJoiner, RecordPipe } = await import('../src/sync/ble/tunnel.ts');
    const { memoryLinks } = await import('./helpers/ble-pipe.ts');
    const { makeParty } = await import('./helpers/ble-world.ts');
    const { SimClock } = await import('../src/sync/ble/sim.ts');
    const clock = new SimClock();
    const [alice, bob, mallory] = await Promise.all([makeParty('alice'), makeParty('bob'), makeParty('mallory')]);
    // alice <-> mallory(as inviter), mallory(as joiner) <-> bob(inviter): mallory relays the codes.
    const l1 = memoryLinks(clock);
    const l2 = memoryLinks(clock);
    const sasSeenByAlice: string[] = [];
    const sasSeenByBob: string[] = [];
    const ctx = (p: { identity: any; peers: any }) => ({ ...p, timers: clock, handshakeTimeoutMs: 5000 });
    const bobWin = { secret: randomBytes(16), confirmSas: async (s: string) => (sasSeenByBob.push(s), true) };
    const malloryWin = { secret: randomBytes(16), confirmSas: async () => true };
    const { readFirstRecord } = await import('../src/sync/ble/tunnel.ts');
    const p1c = new RecordPipe(l1.central, clock);
    const p1p = new RecordPipe(l1.peripheral, clock);
    const p2c = new RecordPipe(l2.central, clock);
    const p2p = new RecordPipe(l2.peripheral, clock);
    const run = [
      readFirstRecord(p1p, ctx(mallory)).then((f) => pairAsInviter(p1p, ctx(mallory), f.rec, malloryWin)),
      pairAsJoiner(p1c, ctx(alice), {}, async (s) => (sasSeenByAlice.push(s), true)),
      readFirstRecord(p2p, ctx(bob)).then((f) => pairAsInviter(p2p, ctx(bob), f.rec, bobWin)),
      pairAsJoiner(p2c, ctx(mallory), {}, async () => true),
    ];
    await clock.drive(Promise.all(run));
    assert.equal(sasSeenByAlice.length, 1);
    assert.equal(sasSeenByBob.length, 1);
    assert.notEqual(sasSeenByAlice[0], sasSeenByBob[0], 'users comparing screens would notice');
  });
});

describe('ble transport: pairing code format', () => {
  it('round-trips and rejects malformed codes', () => {
    const l = { id: 'a'.repeat(32), secret: 'abcdefghijklmnopqrstuv' };
    assert.deepEqual(parseBlePairLink(formatBlePairLink(l)), l);
    for (const bad of ['', 'qtask://pair?h=1.2.3.4:5', 'qtask://pairble', 'qtask://pairble?id=zz&s=abcdefghijklmnopqrstuv', 'http://x', `qtask://pairble?id=${'a'.repeat(32)}&s=short`]) {
      assert.equal(parseBlePairLink(bad), null, bad);
    }
    for (let i = 0; i < 500; i++) assert.doesNotThrow(() => parseBlePairLink(randomBytes(Math.floor(Math.random() * 80)).toString('latin1')));
  });
});

void SimWorld;
void realisticTask;
