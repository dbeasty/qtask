/**
 * Transport-agnostic message framing for device-to-device sync.
 *
 * The LAN (TLS over TCP) transport uses it today; the Bluetooth tunnel in Phase 4
 * reuses it unchanged over a GATT characteristic by passing a small `maxFramePayload`
 * (MTU - 3) and an `io.write` that writes one characteristic value. Nothing in this
 * file knows about sockets, TLS or Bluetooth.
 *
 * Wire format of one frame:
 *
 *     varint(length of the rest) | flags (1 byte) | payload
 *
 * Flags:
 *   0x01 DEFLATE  the whole message (all chunks, concatenated) is raw-deflate compressed.
 *                 Set on the first chunk only.
 *   0x02 MORE     more chunks of the same message follow.
 *   0x04 CREDIT   control frame; payload is varint(bytes granted). Flow control.
 *   0x08 PING     control frame; empty payload.
 *   0x10 PONG     control frame; empty payload.
 *
 * Flow control is credit based, like HTTP/2 stream windows: the sender may have at most
 * `window` unacknowledged payload bytes in flight. The receiver returns credit as it
 * consumes frames and holds it back while the application is behind (`highWater`
 * bytes of undelivered messages), so a slow consumer slows the sender instead of
 * ballooning memory.
 */

import { deflateRaw, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const deflateAsync = promisify(deflateRaw);
const inflateAsync = promisify(inflateRaw) as (
  buf: Uint8Array,
  opts: { maxOutputLength: number },
) => Promise<Buffer>;

export const FLAG_DEFLATE = 0x01;
export const FLAG_MORE = 0x02;
export const FLAG_CREDIT = 0x04;
export const FLAG_PING = 0x08;
export const FLAG_PONG = 0x10;
const KNOWN_FLAGS = FLAG_DEFLATE | FLAG_MORE | FLAG_CREDIT | FLAG_PING | FLAG_PONG;

/**
 * Test seam. Compression runs on the thread pool, so a virtual-time simulator cannot tell from
 * the outside that a job is in flight; it installs a tracker here. Production leaves it alone.
 */
export const workTracker: { track<T>(p: Promise<T>): Promise<T> } = { track: (p) => p };

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FramingError';
  }
}

// --- varint (LEB128, max 5 bytes => values below 2^35, we cap at 2^32 - 1) -------------

export function encodeVarint(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new FramingError(`varint out of range: ${n}`);
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}

/** Returns [value, bytesRead] or null if the buffer ends mid-varint. Throws on a malformed one. */
export function decodeVarint(buf: Uint8Array, offset = 0): [number, number] | null {
  let value = 0;
  let mul = 1;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i]!;
    value += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) {
      if (value > 0xffffffff) throw new FramingError('varint too large');
      return [value, i + 1];
    }
    mul *= 0x80;
  }
  throw new FramingError('varint too long');
}

// --- frame codec ---------------------------------------------------------------------

export interface Frame {
  flags: number;
  payload: Buffer;
}

export function encodeFrame(flags: number, payload: Uint8Array): Buffer {
  return Buffer.concat([encodeVarint(payload.length + 1), Buffer.from([flags]), payload]);
}

/**
 * Incremental frame parser. Feed it arbitrary byte slices (TCP segments, BLE
 * notifications); it yields complete frames. Throws FramingError on a malformed or
 * oversized frame — after which the stream is unrecoverable and must be closed.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly maxFramePayload = 1 << 20) {}

  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const frames: Frame[] = [];
    let off = 0;
    for (;;) {
      const v = decodeVarint(this.buf, off);
      if (!v) break;
      const [len, n] = v;
      if (len < 1) throw new FramingError('empty frame');
      if (len - 1 > this.maxFramePayload) throw new FramingError(`frame too large: ${len - 1}`);
      if (this.buf.length - off - n < len) break;
      const flags = this.buf[off + n]!;
      if (flags & ~KNOWN_FLAGS) throw new FramingError(`unknown flags 0x${flags.toString(16)}`);
      frames.push({ flags, payload: this.buf.subarray(off + n + 1, off + n + len) });
      off += n + len;
    }
    this.buf = off ? this.buf.subarray(off) : this.buf;
    // Copy so a retained tail does not pin a large parent buffer.
    if (this.buf.length) this.buf = Buffer.from(this.buf);
    return frames;
  }
}

// --- message channel with compression, chunking and flow control ---------------------

export interface FramedChannelOptions {
  /** Writes raw bytes to the underlying link. Resolve when the link accepts more (backpressure). */
  write: (bytes: Buffer) => Promise<void> | void;
  /** Max payload bytes per frame. LAN: 64 KiB. BLE: MTU - 3 - header. */
  maxFramePayload?: number;
  /** Max reassembled (decompressed) message size. */
  maxMessageSize?: number;
  /** Unacknowledged payload bytes the sender may have in flight. */
  window?: number;
  /** Receiver holds credit back while this many bytes of messages are undelivered. */
  highWater?: number;
  /** Compress messages at least this large when it helps. Infinity disables. */
  compressThreshold?: number;
}

export type FramedMessageHandler = (msg: Buffer) => void | Promise<void>;

export class FramedChannel {
  private readonly o: Required<Omit<FramedChannelOptions, 'write'>> & { write: FramedChannelOptions['write'] };
  private readonly decoder: FrameDecoder;
  private credit: number;
  private creditWaiters: Array<() => void> = [];
  private sendChain: Promise<void> = Promise.resolve();
  private closed = false;
  private closeError: Error | null = null;

  // receive side
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private partialCompressed = false;
  private pendingDelivery = 0;
  private deferredCredit = 0;
  private deliverChain: Promise<void> = Promise.resolve();

  private handler: FramedMessageHandler | null = null;
  private earlyMessages: Buffer[] = [];
  private pongWaiters: Array<() => void> = [];

  onClose: ((err?: Error) => void) | null = null;

  /** Counters for tests and perf runs. */
  stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0, creditStalls: 0 };

  constructor(opts: FramedChannelOptions) {
    this.o = {
      write: opts.write,
      maxFramePayload: opts.maxFramePayload ?? 64 * 1024,
      maxMessageSize: opts.maxMessageSize ?? 256 * 1024 * 1024,
      window: opts.window ?? 1024 * 1024,
      highWater: opts.highWater ?? 4 * 1024 * 1024,
      compressThreshold: opts.compressThreshold ?? 256,
    };
    if (this.o.maxFramePayload < 8) throw new FramingError('maxFramePayload too small');
    this.decoder = new FrameDecoder(Math.max(this.o.maxFramePayload, 16));
    this.credit = this.o.window;
  }

  onMessage(h: FramedMessageHandler): void {
    this.handler = h;
    const early = this.earlyMessages;
    this.earlyMessages = [];
    for (const m of early) this.enqueueDelivery(m, 0);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Feed bytes arriving from the link. Never throws: protocol errors close the channel. */
  receive(bytes: Uint8Array): void {
    if (this.closed) return;
    try {
      for (const f of this.decoder.push(bytes)) this.onFrame(f);
    } catch (e) {
      this.close(e as Error);
    }
  }

  /**
   * Closes once everything already received has been handed to the application.
   * Use for a peer-initiated end of stream: the last message and the FIN often arrive
   * together, and the message must not be lost to the close.
   */
  closeAfterDelivery(err?: Error): void {
    if (this.closed) return;
    void this.deliverChain.then(() => this.close(err));
  }

  close(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err ?? null;
    for (const w of this.creditWaiters) w();
    this.creditWaiters = [];
    for (const w of this.pongWaiters) w();
    this.pongWaiters = [];
    this.onClose?.(err);
  }

  /** Sends one application message. Messages are delivered whole and in order. */
  send(message: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error('channel closed'));
    const p = this.sendChain.then(() => this.sendNow(Buffer.from(message.buffer, message.byteOffset, message.byteLength)));
    this.sendChain = p.catch(() => undefined);
    return p;
  }

  /** Writes a PING frame without waiting for the PONG (callers that run their own clock use this). */
  sendPing(): Promise<void> {
    return this.writeFrame(FLAG_PING, Buffer.alloc(0));
  }

  /** Round-trip liveness probe. Resolves with the RTT in ms, rejects on timeout. */
  async ping(timeoutMs = 5000): Promise<number> {
    const start = performance.now();
    await this.writeFrame(FLAG_PING, Buffer.alloc(0));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ping timeout')), timeoutMs);
      this.pongWaiters.push(() => {
        clearTimeout(t);
        if (this.closed) reject(this.closeError ?? new Error('channel closed'));
        else resolve();
      });
    });
    return performance.now() - start;
  }

  // --- send path ---

  private async sendNow(msg: Buffer): Promise<void> {
    let body = msg;
    let flags = 0;
    if (msg.length >= this.o.compressThreshold) {
      const z = await workTracker.track(deflateAsync(msg));
      if (z.length < msg.length) {
        body = z;
        flags = FLAG_DEFLATE;
      }
    }
    this.stats.messagesOut++;
    const max = this.o.maxFramePayload;
    let off = 0;
    do {
      const end = Math.min(off + max, body.length);
      const last = end >= body.length;
      const f = (off === 0 ? flags : 0) | (last ? 0 : FLAG_MORE);
      await this.takeCredit(end - off);
      await this.writeFrame(f, body.subarray(off, end));
      off = end;
    } while (off < body.length);
  }

  private async takeCredit(n: number): Promise<void> {
    while (this.credit < n) {
      if (this.closed) throw this.closeError ?? new Error('channel closed');
      this.stats.creditStalls++;
      await new Promise<void>((r) => this.creditWaiters.push(r));
    }
    if (this.closed) throw this.closeError ?? new Error('channel closed');
    this.credit -= n;
  }

  private async writeFrame(flags: number, payload: Buffer): Promise<void> {
    if (this.closed) throw this.closeError ?? new Error('channel closed');
    const bytes = encodeFrame(flags, payload);
    this.stats.framesOut++;
    this.stats.bytesOut += bytes.length;
    await this.o.write(bytes);
  }

  // --- receive path ---

  private onFrame(f: Frame): void {
    this.stats.framesIn++;
    this.stats.bytesIn += f.payload.length + 1;
    if (f.flags & FLAG_CREDIT) {
      const v = decodeVarint(f.payload);
      if (!v) throw new FramingError('bad credit frame');
      this.credit += v[0];
      const w = this.creditWaiters;
      this.creditWaiters = [];
      for (const r of w) r();
      return;
    }
    if (f.flags & FLAG_PING) {
      void this.writeFrame(FLAG_PONG, Buffer.alloc(0)).catch(() => undefined);
      return;
    }
    if (f.flags & FLAG_PONG) {
      const w = this.pongWaiters;
      this.pongWaiters = [];
      for (const r of w) r();
      return;
    }
    // data frame
    if (this.partial.length === 0) this.partialCompressed = (f.flags & FLAG_DEFLATE) !== 0;
    else if (f.flags & FLAG_DEFLATE) throw new FramingError('deflate flag on continuation chunk');
    this.partial.push(f.payload);
    this.partialBytes += f.payload.length;
    // Compressed bodies can legitimately be a bit larger than maxMessageSize only if
    // incompressible, which the sender never compresses; allow modest slack.
    if (this.partialBytes > this.o.maxMessageSize + 1024) throw new FramingError('message too large');
    const frameBytes = f.payload.length;
    if (f.flags & FLAG_MORE) {
      this.grant(frameBytes);
      return;
    }
    const body = Buffer.concat(this.partial);
    const compressed = this.partialCompressed;
    this.partial = [];
    this.partialBytes = 0;
    this.partialCompressed = false;
    this.stats.messagesIn++;
    this.pendingDelivery += body.length;
    // Credit for the final frame is returned once the app has had its chance to consume.
    const prep: Promise<Buffer> = compressed
      ? workTracker.track(inflateAsync(body, { maxOutputLength: this.o.maxMessageSize }))
      : Promise.resolve(body);
    this.deliverChain = this.deliverChain.then(async () => {
      let msg: Buffer;
      try {
        msg = await prep;
      } catch (e) {
        this.close(new FramingError(`bad compressed message: ${(e as Error).message}`));
        return;
      }
      await this.deliver(msg, frameBytes, body.length);
    });
  }

  private enqueueDelivery(msg: Buffer, frameBytes: number): void {
    this.deliverChain = this.deliverChain.then(() => this.deliver(msg, frameBytes, 0));
  }

  private async deliver(msg: Buffer, frameBytes: number, accounted: number): Promise<void> {
    if (!this.handler) {
      this.earlyMessages.push(msg);
      this.grant(frameBytes);
      this.pendingDelivery -= accounted;
      return;
    }
    try {
      await this.handler(msg);
    } catch {
      // handler errors are the application's problem; the channel stays up.
    }
    this.pendingDelivery -= accounted;
    this.grant(frameBytes);
    if (this.pendingDelivery < this.o.highWater && this.deferredCredit) this.flushDeferred();
  }

  private grant(n: number): void {
    if (n <= 0) return;
    if (this.pendingDelivery >= this.o.highWater) {
      this.deferredCredit += n;
      return;
    }
    const total = n + this.deferredCredit;
    this.deferredCredit = 0;
    void this.writeFrame(FLAG_CREDIT, encodeVarint(total)).catch(() => undefined);
  }

  private flushDeferred(): void {
    const n = this.deferredCredit;
    this.deferredCredit = 0;
    if (n) void this.writeFrame(FLAG_CREDIT, encodeVarint(n)).catch(() => undefined);
  }
}
