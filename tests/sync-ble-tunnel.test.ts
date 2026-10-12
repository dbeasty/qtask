import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SimClock } from '../src/sync/ble/sim.ts';
import {
  acceptTunnel,
  initiateTunnel,
  readFirstRecord,
  RecordDecoder,
  RecordPipe,
  T_SEALED,
  TunnelError,
  type SecureTunnel,
  type TunnelContext,
  type TunnelSecurityEvent,
} from '../src/sync/ble/tunnel.ts';
import { decodeInfo, encodeInfo, writeChunked } from '../src/sync/ble/radio.ts';
import { FramingError, encodeVarint } from '../src/sync/framing.ts';
import { makeParty, pair, type Party } from './helpers/ble-world.ts';
import { memoryLinks, type PipeEnd, type Tap } from './helpers/ble-pipe.ts';

interface Rig {
  clock: SimClock;
  a: Party;
  b: Party;
  central: PipeEnd & { tap: Tap | null };
  peripheral: PipeEnd & { tap: Tap | null };
  events: { a: TunnelSecurityEvent[]; b: TunnelSecurityEvent[] };
  ctxA: TunnelContext;
  ctxB: TunnelContext;
  /** Runs the handshake: A is the central (initiator), B the peripheral. */
  connect(): Promise<{ ta: SecureTunnel; tb: SecureTunnel }>;
}

async function rig(opts: { mtu?: number; paired?: boolean; latencyMs?: number } = {}): Promise<Rig> {
  const clock = new SimClock();
  const a = await makeParty('A');
  const b = await makeParty('B');
  if (opts.paired !== false) await pair(a, b);
  const { central, peripheral } = memoryLinks(clock, { mtu: opts.mtu, latencyMs: opts.latencyMs });
  const events = { a: [] as TunnelSecurityEvent[], b: [] as TunnelSecurityEvent[] };
  const ctxA: TunnelContext = { ...a, timers: clock, handshakeTimeoutMs: 5000, onSecurity: (e) => events.a.push(e) };
  const ctxB: TunnelContext = { ...b, timers: clock, handshakeTimeoutMs: 5000, onSecurity: (e) => events.b.push(e) };
  return {
    clock,
    a,
    b,
    central,
    peripheral,
    events,
    ctxA,
    ctxB,
    async connect() {
      const pa = new RecordPipe(central, clock, { stallMs: 3000 });
      const pb = new RecordPipe(peripheral, clock, { stallMs: 3000 });
      const bPeerOfA = a.peers.get(b.identity.info.nodeId)!;
      const respond = (async () => {
        const first = await readFirstRecord(pb, ctxB);
        if (first.kind !== 'hello') throw new Error('unexpected pairing hello');
        return acceptTunnel(pb, ctxB, first.rec);
      })();
      respond.catch(() => undefined);
      const init = initiateTunnel(pa, ctxA, bPeerOfA);
      init.catch(() => undefined);
      const [ta, tb] = await clock.drive(Promise.all([init, respond]));
      return { ta, tb };
    },
  };
}

const sleepV = (clock: SimClock, ms: number) => clock.advance(ms);

describe('tunnel: handshake between paired devices', () => {
  it('completes, both sides learn the peer and derive the same six-digit code', async () => {
    const r = await rig();
    const { ta, tb } = await r.connect();
    assert.equal(ta.peer.nodeId, r.b.identity.info.nodeId);
    assert.equal(tb.peer.nodeId, r.a.identity.info.nodeId);
    assert.match(ta.sas, /^\d{6}$/);
    assert.equal(ta.sas, tb.sas);
    assert.equal(tb.initiatorId, r.a.identity.info.nodeId);
  });

  it('the six-digit code changes from session to session', async () => {
    const clock = new SimClock();
    const a = await makeParty('A');
    const b = await makeParty('B');
    await pair(a, b);
    const sas = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const { central, peripheral } = memoryLinks(clock);
      const pa = new RecordPipe(central, clock);
      const pb = new RecordPipe(peripheral, clock);
      const resp = readFirstRecord(pb, { ...b, timers: clock }).then((f) => acceptTunnel(pb, { ...b, timers: clock }, f.rec));
      const init = initiateTunnel(pa, { ...a, timers: clock }, a.peers.get(b.identity.info.nodeId)!);
      const [ta] = await clock.drive(Promise.all([init, resp]));
      sas.add(ta.sas);
    }
    assert.ok(sas.size > 1);
  });

  for (const mtu of [23, 24, 26, 100, 185, 247, 509, 512, 517]) {
    it(`carries messages both ways at ATT MTU ${mtu}`, async () => {
      const r = await rig({ mtu });
      const { ta, tb } = await r.connect();
      const gotB: Buffer[] = [];
      const gotA: Buffer[] = [];
      tb.onData((p) => gotB.push(p));
      ta.onData((p) => gotA.push(p));
      const sizes = [1, 2, mtu - 4, mtu - 3, mtu - 2, 3 * (mtu - 3), 3 * (mtu - 3) + 1, 5000];
      const msgs = sizes.map((n) => randomBytes(n));
      await r.clock.drive(
        (async () => {
          for (const m of msgs) await ta.send(m);
          for (const m of msgs) await tb.send(m);
        })(),
      );
      await r.clock.until(() => gotB.length === msgs.length && gotA.length === msgs.length);
      assert.deepEqual(gotB, msgs);
      assert.deepEqual(gotA, msgs);
      // Nothing larger than MTU-3 ever hit the air.
      for (const c of [...r.central.sent, ...r.peripheral.sent]) assert.ok(c.length <= mtu - 3);
    });
  }

  it('does not put plaintext on the air', async () => {
    const r = await rig();
    const { ta, tb } = await r.connect();
    const secret = Buffer.from('the-quick-brown-fox-must-not-appear-on-air');
    let got = false;
    tb.onData(() => void (got = true));
    await r.clock.drive(ta.send(secret));
    await r.clock.until(() => got);
    const air = Buffer.concat([...r.central.sent, ...r.peripheral.sent]);
    assert.equal(air.includes(secret), false);
  });
});

describe('tunnel: who is let in', () => {
  it('drops an unpaired initiator on HELLO without sending a single byte back', async () => {
    const r = await rig({ paired: false });
    const pa = new RecordPipe(r.central, r.clock);
    const pb = new RecordPipe(r.peripheral, r.clock);
    // The attacker even knows the target's node id (it is in `info`), but is not in B's PeerStore.
    const fake = { ...r.b.identity.info };
    const stranger = await makeParty('stranger');
    const asPeer = { nodeId: fake.nodeId, name: 'B', certFp: fake.certFp, signPub: fake.signPub, pairedAt: 0, record: {} as never };
    const resp = readFirstRecord(pb, r.ctxB).then((f) => acceptTunnel(pb, r.ctxB, f.rec));
    resp.catch(() => undefined);
    const init = initiateTunnel(pa, { ...stranger, timers: r.clock, handshakeTimeoutMs: 2000 }, asPeer);
    init.catch(() => undefined);
    await assert.rejects(r.clock.drive(resp), (e: TunnelError) => e.code === 'unpaired');
    await assert.rejects(r.clock.drive(init));
    assert.equal(r.peripheral.sent.length, 0, 'the responder sent nothing');
    assert.ok(r.events.b.some((e) => e.reason === 'unpaired-central'));
  });

  it('rejects a device that claims a paired node id but holds a different key', async () => {
    const r = await rig();
    const evil = await makeParty('evil');
    // Same node id on the wire, different signing key.
    const impostor = { ...evil, identity: { ...evil.identity, info: { ...evil.identity.info, nodeId: r.a.identity.info.nodeId } } };
    const pa = new RecordPipe(r.central, r.clock);
    const pb = new RecordPipe(r.peripheral, r.clock);
    const resp = readFirstRecord(pb, r.ctxB).then((f) => acceptTunnel(pb, r.ctxB, f.rec));
    resp.catch(() => undefined);
    // The impostor believes it is dialling B (it can: B's identity key is public).
    const bPeer = { nodeId: r.b.identity.info.nodeId, name: 'B', certFp: '', signPub: r.b.identity.info.signPub, pairedAt: 0, record: {} as never };
    const init = initiateTunnel(pa, { ...impostor, timers: r.clock, handshakeTimeoutMs: 2000 }, bPeer);
    init.catch(() => undefined);
    await assert.rejects(r.clock.drive(resp), (e: TunnelError) => e.code === 'bad-signature');
    assert.ok(r.events.b.some((e) => e.reason === 'bad-signature'));
    await assert.rejects(r.clock.drive(init));
  });

  it('initiator rejects a responder that answers as the expected device but signs with another key', async () => {
    const r = await rig();
    const x = await makeParty('X');
    await pair(r.a, x); // X trusts A, so it gets as far as answering
    const xAsB = { ...x, identity: { ...x.identity, info: { ...x.identity.info, nodeId: r.b.identity.info.nodeId } } };
    const pa = new RecordPipe(r.central, r.clock);
    const pb = new RecordPipe(r.peripheral, r.clock);
    const ctxX = { ...xAsB, timers: r.clock, handshakeTimeoutMs: 2000 };
    const resp = readFirstRecord(pb, ctxX).then((f) => acceptTunnel(pb, ctxX, f.rec));
    resp.catch(() => undefined);
    const init = initiateTunnel(pa, r.ctxA, r.a.peers.get(r.b.identity.info.nodeId)!);
    init.catch(() => undefined);
    await assert.rejects(r.clock.drive(init), (e: TunnelError) => e.code === 'bad-signature');
    assert.ok(r.events.a.some((e) => e.reason === 'bad-signature'));
  });

  it('rejects a HELLO addressed to another device', async () => {
    const r = await rig();
    const c = await makeParty('C');
    await pair(r.a, c);
    const pa = new RecordPipe(r.central, r.clock);
    const pb = new RecordPipe(r.peripheral, r.clock);
    const resp = readFirstRecord(pb, r.ctxB).then((f) => acceptTunnel(pb, r.ctxB, f.rec));
    resp.catch(() => undefined);
    // A thinks it is talking to C (a stale address) but the radio reached B.
    const init = initiateTunnel(pa, r.ctxA, r.a.peers.get(c.identity.info.nodeId)!);
    init.catch(() => undefined);
    await assert.rejects(r.clock.drive(resp), (e: TunnelError) => e.code === 'misdirected');
    await assert.rejects(r.clock.drive(init));
  });

  it('a suppressed peer is dropped like an unpaired one', async () => {
    const r = await rig();
    const pa = new RecordPipe(r.central, r.clock);
    const pb = new RecordPipe(r.peripheral, r.clock);
    const ctxB = { ...r.ctxB, allow: () => false };
    const resp = readFirstRecord(pb, ctxB).then((f) => acceptTunnel(pb, ctxB, f.rec));
    resp.catch(() => undefined);
    const init = initiateTunnel(pa, r.ctxA, r.a.peers.get(r.b.identity.info.nodeId)!);
    init.catch(() => undefined);
    await assert.rejects(r.clock.drive(resp));
    await assert.rejects(r.clock.drive(init));
    assert.equal(r.peripheral.sent.length, 0);
  });

  it('times out a peer that connects and says nothing', async () => {
    const r = await rig();
    const pb = new RecordPipe(r.peripheral, r.clock);
    const resp = readFirstRecord(pb, r.ctxB);
    resp.catch(() => undefined);
    await assert.rejects(r.clock.drive(resp), (e: TunnelError) => e.code === 'timeout');
    assert.ok(pb.closed);
  });

  it('closes on an unknown first record', async () => {
    const r = await rig();
    const pb = new RecordPipe(r.peripheral, r.clock);
    const resp = readFirstRecord(pb, r.ctxB);
    resp.catch(() => undefined);
    const pa = new RecordPipe(r.central, r.clock);
    await r.clock.drive(pa.send(Buffer.from([0x55, 1, 2, 3])));
    await assert.rejects(r.clock.drive(resp), (e: TunnelError) => e.code === 'protocol');
  });
});

async function established(opts: { mtu?: number } = {}) {
  const r = await rig(opts);
  const { ta, tb } = await r.connect();
  const gotB: Buffer[] = [];
  tb.onData((p) => gotB.push(p));
  return { r, ta, tb, gotB };
}

describe('tunnel: integrity of the data phase', () => {
  it('a flipped bit in a sealed record ends the tunnel and delivers nothing', async () => {
    const { r, ta, tb, gotB } = await established();
    let n = 0;
    r.central.tap = (c) => {
      const out = Buffer.from(c);
      if (n++ === 0) out[out.length - 1]! ^= 0x01;
      return [out];
    };
    await r.clock.drive(ta.send(Buffer.from('hello there')));
    await r.clock.until(() => tb.closed);
    assert.equal(gotB.length, 0);
    assert.ok(r.events.b.some((e) => e.reason === 'record-rejected'));
    await r.clock.until(() => ta.closed); // the other end is told the link is gone
  });

  it('a modified record type is rejected', async () => {
    const { r, ta, tb, gotB } = await established();
    let first = true;
    r.central.tap = (c) => {
      const out = Buffer.from(c);
      // record = varint(len) | type | ct ; the type byte is right after the 1-byte varint of a small record
      if (first) {
        out[1] = 0x77;
        first = false;
      }
      return [out];
    };
    await r.clock.drive(ta.send(Buffer.from('hi')));
    await r.clock.until(() => tb.closed);
    assert.equal(gotB.length, 0);
  });

  it('a replayed record is rejected', async () => {
    const { r, ta, tb, gotB } = await established();
    r.central.tap = (c, i) => [c, ...(i === 0 ? [c] : [])]; // deliver the first chunk twice
    // Single-chunk record so the duplicate is a whole record.
    await r.clock.drive(ta.send(Buffer.from('pay 10 euros')));
    await r.clock.until(() => tb.closed);
    assert.deepEqual(gotB.map((b) => b.toString()), ['pay 10 euros'], 'the original arrived once, the replay killed the tunnel');
  });

  it('a record replayed from an earlier session is rejected', async () => {
    const first = await established();
    await first.r.clock.drive(first.ta.send(Buffer.from('session one payload')));
    await first.r.clock.until(() => first.gotB.length === 1);
    const recorded = first.r.central.sent.slice(-1);
    const second = await established();
    // Inject the recorded chunk into session two as if the radio had delivered it.
    second.r.central.tap = (c, i) => (i === 0 ? [...recorded, c] : [c]);
    await second.r.clock.drive(second.ta.send(Buffer.from('session two payload')));
    await second.r.clock.until(() => second.tb.closed);
    assert.equal(second.gotB.length, 0);
  });

  it('reordered records are rejected', async () => {
    const { r, ta, tb, gotB } = await established();
    const held: Buffer[] = [];
    r.central.tap = (c, i) => {
      if (i === 0) {
        held.push(c);
        return [];
      }
      if (i === 1) return [c, ...held.splice(0)]; // second record arrives before the first
      return [c];
    };
    await r.clock.drive(
      (async () => {
        await ta.send(Buffer.from('one'));
        await ta.send(Buffer.from('two'));
      })(),
    );
    await r.clock.until(() => tb.closed);
    assert.equal(gotB.length, 0);
  });

  it('a dropped record makes the next one fail (counter gap)', async () => {
    const { r, ta, tb, gotB } = await established();
    r.central.tap = (c, i) => (i === 0 ? [] : [c]);
    await r.clock.drive(
      (async () => {
        await ta.send(Buffer.from('lost'));
        await ta.send(Buffer.from('arrives'));
      })(),
    );
    await r.clock.until(() => tb.closed);
    assert.equal(gotB.length, 0);
  });

  it('a truncated record followed by more data fails closed', async () => {
    const { r, ta, tb, gotB } = await established({ mtu: 23 });
    let seen = 0;
    r.central.tap = (c) => (seen++ === 1 ? [] : [c]); // lose the second chunk of a multi-chunk record
    await r.clock.drive(
      (async () => {
        await ta.send(Buffer.alloc(100, 7));
        await ta.send(Buffer.from('next'));
      })(),
    );
    await r.clock.until(() => tb.closed);
    assert.equal(gotB.length, 0);
  });

  it('a record cut short with nothing after it is closed by the stall timer', async () => {
    const { r, ta, tb } = await established({ mtu: 23 });
    let seen = 0;
    r.central.tap = (c) => (seen++ >= 2 ? [] : [c]); // only the first two chunks of a long record get through
    ta.send(Buffer.alloc(200, 1)).catch(() => undefined);
    await r.clock.until(() => tb.closed, { maxVirtualMs: 30_000 });
    assert.ok(r.clock.now() >= 3000, 'closed by the 3 s stall timer, not immediately');
  });

  it('data sent after the other side closed is rejected, not buffered forever', async () => {
    const { r, ta, tb } = await established();
    tb.close();
    await r.clock.until(() => ta.closed);
    await assert.rejects(ta.send(Buffer.from('x')));
  });

  it('refuses a data record before the handshake finished', async () => {
    const r = await rig();
    const pa = new RecordPipe(r.central, r.clock);
    const pb = new RecordPipe(r.peripheral, r.clock);
    const resp = readFirstRecord(pb, r.ctxB);
    resp.catch(() => undefined);
    await r.clock.drive(pa.send(Buffer.concat([Buffer.from([T_SEALED]), randomBytes(40)])));
    await assert.rejects(r.clock.drive(resp), (e: TunnelError) => e.code === 'protocol');
  });
});

describe('tunnel: record decoder and info decoder (fuzz)', () => {
  it('reassembles records under any slicing', () => {
    const recs = [Buffer.from([1]), randomBytes(300), randomBytes(5), randomBytes(1000)];
    const stream = Buffer.concat(recs.flatMap((r) => [encodeVarint(r.length), r]));
    for (let trial = 0; trial < 50; trial++) {
      const d = new RecordDecoder();
      const out: Buffer[] = [];
      for (let off = 0; off < stream.length; ) {
        const n = 1 + Math.floor(Math.random() * 40);
        out.push(...d.push(stream.subarray(off, off + n)));
        off += n;
      }
      assert.deepEqual(out, recs);
      assert.equal(d.pending(), 0);
    }
  });

  it('never throws anything but FramingError, never grows without bound', () => {
    for (let trial = 0; trial < 2000; trial++) {
      const d = new RecordDecoder(4096);
      try {
        for (let k = 0; k < 6; k++) d.push(randomBytes(1 + Math.floor(Math.random() * 64)));
        assert.ok(d.pending() <= 4096 + 5 + 64 * 6);
      } catch (e) {
        assert.ok(e instanceof FramingError, String(e));
      }
    }
  });

  it('rejects zero-length and oversized records', () => {
    assert.throws(() => new RecordDecoder().push(Buffer.from([0])), FramingError);
    assert.throws(() => new RecordDecoder(100).push(encodeVarint(101)), FramingError);
  });

  it('info: round trip and rejection of malformed values', () => {
    const base = { nodeId: randomBytes(16).toString('hex'), keyTag: randomBytes(8).toString('hex') };
    const plain = decodeInfo(encodeInfo({ ...base, pairing: false, name: 'ignored' }));
    assert.deepEqual(plain, { version: 1, ...base, pairing: false, name: undefined });
    const pairing = decodeInfo(encodeInfo({ ...base, pairing: true, name: "David's MacBook" }));
    assert.equal(pairing?.name, "David's MacBook");
    assert.equal(decodeInfo(Buffer.alloc(0)), null);
    assert.equal(decodeInfo(Buffer.alloc(25)), null);
    for (let i = 0; i < 3000; i++) {
      const junk = randomBytes(Math.floor(Math.random() * 60));
      const r = decodeInfo(junk);
      if (r) assert.match(r.nodeId, /^[0-9a-f]{32}$/);
    }
    const bad = Buffer.from(encodeInfo({ ...base, pairing: false }));
    bad[0] = 9;
    assert.equal(decodeInfo(bad), null);
  });

  it('acceptTunnel survives arbitrary first records without throwing out of band', async () => {
    const r = await rig();
    for (let i = 0; i < 200; i++) {
      const { central, peripheral } = memoryLinks(r.clock);
      const pa = new RecordPipe(central, r.clock);
      const pb = new RecordPipe(peripheral, r.clock, { stallMs: 500 });
      const body = Buffer.concat([Buffer.from([i % 3 === 0 ? 0x01 : i % 3 === 1 ? 0x06 : Math.floor(Math.random() * 256)]), randomBytes(Math.floor(Math.random() * 80))]);
      const resp = readFirstRecord(pb, { ...r.ctxB, handshakeTimeoutMs: 300 }).then((f) =>
        f.kind === 'hello' ? acceptTunnel(pb, { ...r.ctxB, handshakeTimeoutMs: 300 }, f.rec) : (pb.close(), Promise.reject(new Error('pair'))),
      );
      resp.catch(() => undefined);
      pa.send(body).catch(() => undefined);
      await assert.rejects(r.clock.drive(resp, { maxVirtualMs: 5000 }));
      assert.ok(pb.closed);
    }
  });

  it('writeChunked splits at the link chunk size and honours backpressure', async () => {
    const clock = new SimClock();
    const { central, peripheral } = memoryLinks(clock, { mtu: 23 });
    let refuse = 3;
    const real = central.tryWrite.bind(central);
    central.tryWrite = (c) => (refuse-- > 0 ? false : real(c));
    central.onWritable = (h) => void clock.setTimeout(h, 10);
    const got: Buffer[] = [];
    peripheral.onData((c) => got.push(Buffer.from(c)));
    const data = randomBytes(95);
    await clock.drive(writeChunked(central, data));
    await clock.advance(50);
    assert.deepEqual(Buffer.concat(got), data);
    assert.deepEqual(got.map((g) => g.length), [20, 20, 20, 20, 15]);
  });
});

void sleepV;
