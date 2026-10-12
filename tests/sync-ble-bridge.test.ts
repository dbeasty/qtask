import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import { BleBridgeServer, BridgeRadio, LineDecoder, MAX_LINE, parseMsg } from '../src/sync/ble/bridge.ts';
import { converged, linked, makeBleDevice, pair, seedTasks, stopAll, world } from './helpers/ble-world.ts';
import { bridged, type BridgeDriver } from './helpers/ble-bridge-driver.ts';

afterEach(() => stopAll());

describe('bridge: the whole stack through the app<->node protocol', () => {
  it('pairs-then-syncs, reconnects after range-out, with every radio call crossing the JSON bridge', async () => {
    const w = world({ mtu: 185, bytesPerSec: 60_000, latencyMs: 50 });
    const drivers: BridgeDriver[] = [];
    const wrap = (sim: Parameters<typeof bridged>[0]) => {
      const b = bridged(sim, w, { window: 6 });
      drivers.push(b.driver);
      return b.radio;
    };
    const a = await makeBleDevice(w, 'A', { radioWrap: wrap, batchSize: 50 });
    const b = await makeBleDevice(w, 'B', { radioWrap: wrap, batchSize: 50 });
    await pair(a, b);
    await w.until(() => a.transport.links().length === 1 && b.transport.links().length === 1, { what: 'link through the bridge' });
    await w.advance(2500);
    await seedTasks(a, 150);
    void a.coordinator.syncNow();
    await converged(w, [a, b], 150);

    // Out of range and back: the app reports `closed`, the desired scan state is re-applied, a new link comes up.
    w.setRange(a.radio, b.radio, false);
    await w.until(() => a.transport.links().length === 0 && b.transport.links().length === 0, { what: 'links to close' });
    await b.tasks().create({ _id: 'offline', userId: 'u1', title: 'x' });
    w.setRange(a.radio, b.radio, true);
    await converged(w, [a, b], 151);
    // The write window bounded the app-side queue.
    for (const d of drivers) assert.ok(d.maxQueued <= 6, `driver queued ${d.maxQueued} chunks with a window of 6`);
  });

  it('applies desired state once Bluetooth powers on, and drops every link when the app disconnects', async () => {
    const w = world();
    const sim = w.createRadio('R');
    sim.setState('off');
    const { radio } = bridged(sim, w);
    await radio.startAdvertising(Buffer.from([1, 2, 3]));
    await radio.startScan();
    await w.advance(50);
    assert.equal(sim.advertising, false);
    sim.setState('on');
    await w.advance(50);
    assert.equal(radio.state, 'on');
    assert.equal(sim.advertising, true);
    assert.equal(sim.scanning, true);
    radio.detach();
    assert.equal(radio.state, 'unknown');
    await assert.rejects(radio.connect('x', 1000), /not connected/);
  });

  it('ignores malformed events from the app', () => {
    const r = new BridgeRadio((): void => undefined);
    r.attach(() => undefined);
    for (const m of [
      { t: 'data', link: 5, data: 7 },
      { t: 'connected', req: 'x' },
      { t: 'incoming', link: 'L1', mtu: 9999 },
      { t: 'acked', link: 'L1', n: -3 },
      { t: 'state', state: 'bogus' },
      { t: 'nope' },
      { t: 'info', req: 1, data: '!!!' },
    ]) assert.doesNotThrow(() => r.feed(m as never));
    assert.equal(r.state, 'unknown');
  });
});

describe('bridge: server on loopback', () => {
  async function client(port: number) {
    const s = tcpConnect(port, '127.0.0.1');
    s.setEncoding('utf8');
    s.on('error', () => undefined);
    const lines: string[] = [];
    const dec = new LineDecoder();
    s.on('data', (d: string) => lines.push(...dec.push(d)));
    await new Promise<void>((r) => s.once('connect', () => r()));
    const closed = new Promise<void>((r) => s.once('close', () => r()));
    return { s, lines, closed };
  }
  const wait = (f: () => boolean, ms = 3000) =>
    new Promise<void>((res, rej) => {
      const t0 = Date.now();
      const i = setInterval(() => {
        if (f()) (clearInterval(i), res());
        else if (Date.now() - t0 > ms) (clearInterval(i), rej(new Error('timeout')));
      }, 5);
    });

  it('refuses a wrong token, accepts the right one, and allows only one app at a time', async () => {
    const server = new BleBridgeServer({ token: 'a'.repeat(64) });
    const port = await server.listen();
    try {
      const bad = await client(port);
      bad.s.write(JSON.stringify({ t: 'auth', token: 'b'.repeat(64) }) + '\n');
      await bad.closed;
      assert.equal(bad.lines.length, 0, 'nothing is sent to an unauthenticated client');

      const good = await client(port);
      good.s.write(JSON.stringify({ t: 'auth', token: 'a'.repeat(64) }) + '\n');
      await wait(() => good.lines.length > 0);
      assert.deepEqual(parseMsg(good.lines[0]!), { t: 'hello', v: 1 });

      const second = await client(port);
      second.s.write(JSON.stringify({ t: 'auth', token: 'a'.repeat(64) }) + '\n');
      await second.closed;

      good.s.write(JSON.stringify({ t: 'state', state: 'on' }) + '\n');
      await wait(() => server.radio.state === 'on');
      good.s.destroy();
      await wait(() => server.radio.state === 'unknown');
    } finally {
      await server.close();
    }
  });

  it('drops a client that is silent, sends garbage first, or sends an oversized line', async () => {
    const server = new BleBridgeServer({ token: 't'.repeat(40), authTimeoutMs: 150 });
    const port = await server.listen();
    try {
      const silent = await client(port);
      await silent.closed;
      const junk = await client(port);
      junk.s.write('not json\n');
      await junk.closed;
      const big = await client(port);
      big.s.write('x'.repeat(MAX_LINE + 10));
      await big.closed;
    } finally {
      await server.close();
    }
  });

  it('refuses to listen on a non-loopback address', async () => {
    const server = new BleBridgeServer({ token: 'x', host: '0.0.0.0' });
    await assert.rejects(server.listen(), /loopback/);
  });

  it('LineDecoder and parseMsg: slicing invariance and fuzz', () => {
    const lines = ['{"t":"a"}', '{"t":"b","x":1}', '{"t":"c","d":"' + 'z'.repeat(500) + '"}'];
    const stream = lines.join('\n') + '\n';
    for (let k = 0; k < 40; k++) {
      const d = new LineDecoder();
      const out: string[] = [];
      for (let off = 0; off < stream.length; ) {
        const n = 1 + Math.floor(Math.random() * 30);
        out.push(...d.push(stream.slice(off, off + n)));
        off += n;
      }
      assert.deepEqual(out, lines);
    }
    for (let i = 0; i < 3000; i++) {
      const junk = randomBytes(Math.floor(Math.random() * 100)).toString('latin1');
      assert.doesNotThrow(() => parseMsg(junk));
      const d = new LineDecoder();
      try {
        d.push(junk);
      } catch (e) {
        assert.match(String(e), /too long/);
      }
    }
    assert.equal(parseMsg('[1,2]'), null);
    assert.equal(parseMsg('{"t":5}'), null);
    assert.equal(parseMsg('null'), null);
  });
});
