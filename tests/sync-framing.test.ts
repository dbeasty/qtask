import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  FrameDecoder,
  FramedChannel,
  FramingError,
  FLAG_DEFLATE,
  decodeVarint,
  encodeFrame,
  encodeVarint,
  type FramedChannelOptions,
} from '../src/sync/framing.ts';

type Opts = Omit<FramedChannelOptions, 'write'>;

/** Two channels wired back to back through an async "link" that can re-slice the byte stream randomly. */
function pair(opts: Opts = {}, slice = false) {
  let a!: FramedChannel;
  let b!: FramedChannel;
  const wire = (to: () => FramedChannel) => async (bytes: Buffer) => {
    await new Promise((r) => setImmediate(r));
    if (!slice) return to().receive(bytes);
    let off = 0;
    while (off < bytes.length) {
      const n = 1 + Math.floor(Math.random() * 37);
      to().receive(bytes.subarray(off, off + n));
      off += n;
    }
  };
  a = new FramedChannel({ ...opts, write: wire(() => b) });
  b = new FramedChannel({ ...opts, write: wire(() => a) });
  return { a, b };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('framing: varint', () => {
  it('round-trips boundary values', () => {
    for (const n of [0, 1, 127, 128, 16383, 16384, 2 ** 21, 2 ** 28, 0xffffffff]) {
      const enc = encodeVarint(n);
      assert.deepEqual(decodeVarint(enc), [n, enc.length]);
    }
    assert.throws(() => encodeVarint(-1), FramingError);
    assert.throws(() => encodeVarint(2 ** 32), FramingError);
  });
  it('returns null on truncation and throws on an over-long varint', () => {
    assert.equal(decodeVarint(Buffer.from([0x80])), null);
    assert.throws(() => decodeVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])), FramingError);
  });
});

describe('framing: channel', () => {
  it('delivers messages whole and in order across sizes, with and without compression', async () => {
    const { a, b } = pair({ maxFramePayload: 1000, window: 4000 });
    const got: Buffer[] = [];
    b.onMessage((m) => void got.push(m));
    const msgs = [
      Buffer.alloc(0),
      Buffer.from('x'),
      randomBytes(999),
      randomBytes(1000),
      randomBytes(1001),
      randomBytes(50_000), // incompressible, many chunks
      Buffer.from('abc'.repeat(100_000)), // very compressible
    ];
    for (const m of msgs) await a.send(m);
    await sleep(100);
    assert.equal(got.length, msgs.length);
    msgs.forEach((m, i) => assert.ok(got[i]!.equals(m), `message ${i}`));
    assert.ok(a.stats.bytesOut < 120_000, `compression should shrink the repetitive message (sent ${a.stats.bytesOut})`);
  });

  it('survives arbitrary re-slicing of the byte stream (tiny BLE-style notifications)', async () => {
    const { a, b } = pair({ maxFramePayload: 20 }, true);
    const got: Buffer[] = [];
    b.onMessage((m) => void got.push(m));
    const msgs = Array.from({ length: 30 }, (_, i) => randomBytes(i * 13));
    for (const m of msgs) await a.send(m);
    await sleep(200);
    assert.equal(got.length, msgs.length);
    msgs.forEach((m, i) => assert.ok(got[i]!.equals(m)));
  });

  it('flow control: a slow consumer stalls the sender instead of buffering unbounded data', async () => {
    const { a, b } = pair({ maxFramePayload: 1024, window: 4096, highWater: 8192 });
    let delivered = 0;
    b.onMessage(async () => {
      delivered++;
      await sleep(20); // slow app
    });
    const t0 = Date.now();
    const msg = randomBytes(2048);
    for (let i = 0; i < 10; i++) await a.send(msg);
    await sleep(400);
    assert.equal(delivered, 10);
    assert.ok(a.stats.creditStalls > 0, 'sender must have waited for credit at least once');
    assert.ok(Date.now() - t0 >= 150, 'sending is paced by the consumer');
  });

  it('a message larger than the whole window still gets through', async () => {
    const { a, b } = pair({ maxFramePayload: 512, window: 1024 });
    const got: Buffer[] = [];
    b.onMessage((m) => void got.push(m));
    const big = randomBytes(100_000);
    await a.send(big);
    await sleep(100);
    assert.ok(got[0]!.equals(big));
  });

  it('ping measures a round trip', async () => {
    const { a } = pair();
    const rtt = await a.ping(2000);
    assert.ok(rtt >= 0 && rtt < 1000);
  });

  it('rejects a decompression bomb and closes', async () => {
    let err: Error | undefined;
    const b = new FramedChannel({ write: () => undefined, maxMessageSize: 1000 });
    b.onClose = (e) => (err = e);
    b.onMessage(() => undefined);
    const bomb = deflateRawSync(Buffer.alloc(1_000_000));
    b.receive(encodeFrame(FLAG_DEFLATE, bomb));
    await sleep(50);
    assert.ok(b.isClosed);
    assert.ok(err instanceof FramingError);
  });

  it('rejects oversized frames, unknown flags and empty frames', () => {
    const d = new FrameDecoder(100);
    assert.throws(() => d.push(encodeVarint(5000)), FramingError);
    assert.throws(() => new FrameDecoder().push(Buffer.from([2, 0x80, 0])), FramingError);
    assert.throws(() => new FrameDecoder().push(Buffer.from([0])), FramingError);
  });

  it('fuzz: random bytes and mutated valid streams never throw anything but FramingError', () => {
    for (let i = 0; i < 3000; i++) {
      const d = new FrameDecoder(4096);
      const input = i % 2 ? randomBytes(Math.floor(Math.random() * 300)) : mutate(validStream());
      try {
        d.push(input);
      } catch (e) {
        assert.ok(e instanceof FramingError, `unexpected ${e}`);
      }
    }
    // Same through a whole channel: errors must close it, never throw out of receive().
    for (let i = 0; i < 300; i++) {
      const ch = new FramedChannel({ write: () => undefined, maxMessageSize: 10_000 });
      ch.onMessage(() => undefined);
      assert.doesNotThrow(() => ch.receive(mutate(validStream())));
      ch.close();
    }
  });
});

function validStream(): Buffer {
  return Buffer.concat([
    encodeFrame(0, Buffer.from('hello world')),
    encodeFrame(2, randomBytes(20)),
    encodeFrame(0, randomBytes(5)),
    encodeFrame(FLAG_DEFLATE, deflateRawSync(Buffer.from('zzzzzzzzzz'))),
  ]);
}
function mutate(b: Buffer): Buffer {
  const c = Buffer.from(b);
  const n = 1 + Math.floor(Math.random() * 4);
  for (let i = 0; i < n; i++) c[Math.floor(Math.random() * c.length)] = Math.floor(Math.random() * 256);
  return Math.random() < 0.3 ? c.subarray(0, Math.floor(Math.random() * c.length)) : c;
}
