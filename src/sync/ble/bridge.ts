/**
 * The seam between the Node backend and the native radio.
 *
 * The Swift app owns CoreBluetooth (a sandboxed process may be the only one allowed
 * to use it, and macOS shows its permission prompt for the app). The Node backend owns
 * the protocol (tunnel, framing, engine). They talk over a loopback TCP socket that the
 * backend listens on and the app connects to, authenticated with the same per-launch
 * device token the app already uses for HTTP (QTASK_DEVICE_TOKEN). The wire format is
 * newline-delimited JSON; binary is base64.
 *
 *   app -> node   {"t":"auth","token":"..."}                    first line, within 5 s
 *   node -> app   {"t":"hello","v":1}
 *
 * Node -> app (commands; the app keeps the DESIRED state and applies it whenever
 * Bluetooth is powered on, so commands sent before `state:on` are not lost):
 *   adv.start {info}  adv.info {info}  adv.stop
 *   scan.start  scan.stop
 *   connect {req, device, timeoutMs}   connect.cancel {req}
 *   info.read {req, link}
 *   write {link, data}                 one GATT chunk (<= mtu-3 bytes)
 *   close {link}
 *
 * App -> node (events):
 *   state {state}                      on | off | unauthorized | unsupported | unknown
 *   discovered {device, rssi}
 *   connected {req, link, mtu} | connect.failed {req, error}
 *   info {req, data} | info.failed {req, error}
 *   incoming {link, mtu}               a central connected and subscribed
 *   data {link, data}
 *   acked {link, n}                    n written chunks were accepted by the radio stack
 *   closed {link, error?}
 *
 * Backpressure over an asynchronous seam: the node side may have at most `window` written
 * chunks un-acked per link; beyond that `tryWrite` returns false until `acked` arrives.
 * The app acks a chunk when CoreBluetooth took it (`canSendWriteWithoutResponse` was true /
 * `updateValue` returned true), so the app's own queue stays at `window` chunks.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import {
  ATT_MTU_MAX,
  ATT_MTU_MIN,
  ATT_OVERHEAD,
  realTimers,
  type BleRadio,
  type CentralLink,
  type Discovery,
  type GattLink,
  type PeripheralLink,
  type RadioState,
  type Timers,
} from './radio.js';

export const BRIDGE_VERSION = 1;
export const MAX_LINE = 16 * 1024;
const MAX_CHUNK_B64 = Math.ceil((ATT_MTU_MAX * 4) / 3) + 8;

export type BridgeMsg = { t: string } & Record<string, unknown>;

/** Splits a byte stream into JSON lines. Throws on an oversized line. */
export class LineDecoder {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i < 0) break;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.length > MAX_LINE) throw new Error('bridge line too long');
      if (line.length) out.push(line);
    }
    if (this.buf.length > MAX_LINE) throw new Error('bridge line too long');
    return out;
  }
  pending(): number {
    return this.buf.length;
  }
}

/** Parses one line; null for anything that is not an object with a string `t`. */
export function parseMsg(line: string): BridgeMsg | null {
  try {
    const v = JSON.parse(line) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { t?: unknown }).t === 'string') return v as BridgeMsg;
  } catch {
    /* fall through */
  }
  return null;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
function data(v: unknown): Buffer | null {
  if (typeof v !== 'string' || v.length > MAX_CHUNK_B64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return null;
  return Buffer.from(v, 'base64');
}

class BridgeLink implements GattLink {
  readonly maxChunk: number;
  private inflight = 0;
  private wantWritable = false;
  private writable: Array<() => void> = [];
  private dataHandler: ((c: Uint8Array) => void) | null = null;
  private early: Uint8Array[] = [];
  private closeHandlers: Array<(e?: Error) => void> = [];
  private done: { reason?: Error } | null = null;
  private infoWaiters = new Map<number, { res: (b: Uint8Array) => void; rej: (e: Error) => void }>();

  constructor(
    readonly id: string,
    readonly role: 'central' | 'peripheral',
    readonly mtu: number,
    private readonly radio: BridgeRadio,
    private readonly window: number,
  ) {
    this.maxChunk = mtu - ATT_OVERHEAD;
  }

  tryWrite(chunk: Uint8Array): boolean {
    if (this.done) throw new Error('link closed');
    if (chunk.length < 1 || chunk.length > this.maxChunk) throw new Error(`chunk of ${chunk.length} bytes exceeds ${this.maxChunk}`);
    if (this.inflight >= this.window) {
      this.wantWritable = true;
      return false;
    }
    this.inflight++;
    this.radio.out({ t: 'write', link: this.id, data: b64(chunk) });
    return true;
  }
  onWritable(h: () => void): void {
    if (this.done) queueMicrotask(h);
    else this.writable.push(h);
  }
  acked(n: number): void {
    this.inflight = Math.max(0, this.inflight - n);
    if (this.wantWritable && this.inflight < this.window) {
      this.wantWritable = false;
      for (const w of this.writable.splice(0)) w();
    }
  }
  onData(h: (c: Uint8Array) => void): void {
    this.dataHandler = h;
    for (const c of this.early.splice(0)) h(c);
  }
  receive(b: Buffer): void {
    if (this.done) return;
    if (this.dataHandler) this.dataHandler(b);
    else this.early.push(b);
  }
  onClose(h: (e?: Error) => void): void {
    if (this.done) h(this.done.reason);
    else this.closeHandlers.push(h);
  }
  close(): void {
    if (this.done) return;
    this.radio.out({ t: 'close', link: this.id });
    this.finish();
  }
  finish(reason?: Error): void {
    if (this.done) return;
    this.done = { reason };
    for (const w of this.writable.splice(0)) w();
    for (const w of this.infoWaiters.values()) w.rej(reason ?? new Error('link closed'));
    this.infoWaiters.clear();
    for (const h of this.closeHandlers.splice(0)) h(reason);
    this.radio.forget(this.id);
  }
  readInfo(): Promise<Uint8Array> {
    if (this.done) return Promise.reject(new Error('link closed'));
    const req = this.radio.nextReq();
    return new Promise((res, rej) => {
      this.infoWaiters.set(req, { res, rej });
      this.radio.out({ t: 'info.read', req, link: this.id });
    });
  }
  infoResult(req: number, d: Buffer | Error): void {
    const w = this.infoWaiters.get(req);
    if (!w) return;
    this.infoWaiters.delete(req);
    if (d instanceof Error) w.rej(d);
    else w.res(d);
  }
}

export interface BridgeRadioOptions {
  /** Un-acked chunks allowed per link. */
  window?: number;
  timers?: Timers;
}

/** A `BleRadio` whose hardware lives in the app on the other end of `send`. */
export class BridgeRadio implements BleRadio {
  state: RadioState = 'unknown';
  private stateHandlers: Array<(s: RadioState) => void> = [];
  private discHandler: ((d: Discovery) => void) | null = null;
  private incomingHandler: ((l: PeripheralLink) => void) | null = null;
  private earlyIncoming: PeripheralLink[] = [];
  private links = new Map<string, BridgeLink>();
  private connects = new Map<number, { res: (l: CentralLink) => void; rej: (e: Error) => void; timer: unknown }>();
  private req = 0;
  private advInfo: Uint8Array | null = null;
  private scanning = false;
  private attached = false;
  private readonly timers: Timers;
  private readonly window: number;

  constructor(
    private send: ((msg: BridgeMsg) => void) | null = null,
    o: BridgeRadioOptions = {},
  ) {
    this.timers = o.timers ?? realTimers;
    this.window = o.window ?? 16;
  }

  // plumbing used by BridgeLink / the server
  out(msg: BridgeMsg): void {
    if (this.attached && this.send) this.send(msg);
  }
  nextReq(): number {
    return ++this.req;
  }
  forget(id: string): void {
    this.links.delete(id);
  }

  /** The app connected: re-apply the desired state. */
  attach(send: (msg: BridgeMsg) => void): void {
    this.send = send;
    this.attached = true;
    this.out({ t: 'hello', v: BRIDGE_VERSION });
    if (this.advInfo) this.out({ t: 'adv.start', info: b64(this.advInfo) });
    if (this.scanning) this.out({ t: 'scan.start' });
  }

  /** The app went away: every link is gone. */
  detach(): void {
    this.attached = false;
    this.send = null;
    for (const l of [...this.links.values()]) l.finish(new Error('bridge disconnected'));
    for (const [req, c] of this.connects) {
      this.timers.clearTimeout(c.timer);
      c.rej(new Error('bridge disconnected'));
      this.connects.delete(req);
    }
    this.setState('unknown');
  }

  private setState(s: RadioState): void {
    if (s === this.state) return;
    this.state = s;
    for (const h of this.stateHandlers) h(s);
  }

  /** One message from the app. Malformed input is ignored: the app is trusted, the socket is not. */
  feed(m: BridgeMsg): void {
    switch (m.t) {
      case 'state': {
        const s = str(m.state, 20);
        if (s === 'on' || s === 'off' || s === 'unauthorized' || s === 'unsupported' || s === 'unknown') this.setState(s);
        return;
      }
      case 'discovered': {
        const d = str(m.device);
        if (d) this.discHandler?.({ deviceId: d, rssi: typeof m.rssi === 'number' ? m.rssi : undefined });
        return;
      }
      case 'connected': {
        const req = int(m.req, 1, 2 ** 31);
        const link = str(m.link);
        const mtu = int(m.mtu, ATT_MTU_MIN, ATT_MTU_MAX);
        if (req === null || !link || mtu === null) return;
        const c = this.connects.get(req);
        if (!c) {
          this.out({ t: 'close', link }); // we gave up on this connect already
          return;
        }
        this.connects.delete(req);
        this.timers.clearTimeout(c.timer);
        const l = new BridgeLink(link, 'central', mtu, this, this.window);
        this.links.set(link, l);
        c.res(l as unknown as CentralLink);
        return;
      }
      case 'connect.failed': {
        const req = int(m.req, 1, 2 ** 31);
        const c = req === null ? undefined : this.connects.get(req);
        if (!c || req === null) return;
        this.connects.delete(req);
        this.timers.clearTimeout(c.timer);
        c.rej(new Error(str(m.error, 200) ?? 'connect failed'));
        return;
      }
      case 'incoming': {
        const link = str(m.link);
        const mtu = int(m.mtu, ATT_MTU_MIN, ATT_MTU_MAX);
        if (!link || mtu === null || this.links.has(link)) return;
        const l = new BridgeLink(link, 'peripheral', mtu, this, this.window);
        this.links.set(link, l);
        if (this.incomingHandler) this.incomingHandler(l as unknown as PeripheralLink);
        else this.earlyIncoming.push(l as unknown as PeripheralLink);
        return;
      }
      case 'data': {
        const link = str(m.link);
        const d = data(m.data);
        if (link && d && d.length) this.links.get(link)?.receive(d);
        return;
      }
      case 'acked': {
        const link = str(m.link);
        const n = int(m.n, 1, 4096);
        if (link && n !== null) this.links.get(link)?.acked(n);
        return;
      }
      case 'closed': {
        const link = str(m.link);
        if (link) this.links.get(link)?.finish(typeof m.error === 'string' ? new Error(m.error.slice(0, 200)) : new Error('link closed'));
        return;
      }
      case 'info':
      case 'info.failed': {
        const req = int(m.req, 1, 2 ** 31);
        if (req === null) return;
        for (const l of this.links.values()) {
          if (m.t === 'info') {
            const d = data(m.data);
            if (d) l.infoResult(req, d);
          } else l.infoResult(req, new Error(str(m.error, 200) ?? 'info read failed'));
        }
        return;
      }
      default:
        return;
    }
  }

  // --- BleRadio ---
  onState(h: (s: RadioState) => void): void {
    this.stateHandlers.push(h);
  }
  async startAdvertising(info: Uint8Array): Promise<void> {
    this.advInfo = Buffer.from(info);
    this.out({ t: 'adv.start', info: b64(info) });
  }
  async setInfo(info: Uint8Array): Promise<void> {
    this.advInfo = Buffer.from(info);
    this.out({ t: 'adv.info', info: b64(info) });
  }
  async stopAdvertising(): Promise<void> {
    this.advInfo = null;
    this.out({ t: 'adv.stop' });
  }
  onIncoming(h: (l: PeripheralLink) => void): void {
    this.incomingHandler = h;
    for (const l of this.earlyIncoming.splice(0)) h(l);
  }
  async startScan(): Promise<void> {
    this.scanning = true;
    this.out({ t: 'scan.start' });
  }
  async stopScan(): Promise<void> {
    this.scanning = false;
    this.out({ t: 'scan.stop' });
  }
  onDiscovered(h: (d: Discovery) => void): void {
    this.discHandler = h;
  }
  connect(deviceId: string, timeoutMs: number): Promise<CentralLink> {
    if (!this.attached) return Promise.reject(new Error('bridge not connected'));
    const req = this.nextReq();
    return new Promise<CentralLink>((res, rej) => {
      const timer = this.timers.setTimeout(() => {
        if (this.connects.delete(req)) {
          this.out({ t: 'connect.cancel', req });
          rej(new Error('connect timeout'));
        }
      }, timeoutMs);
      this.connects.set(req, { res, rej, timer });
      this.out({ t: 'connect', req, device: deviceId, timeoutMs });
    });
  }
}

// --- the loopback server ----------------------------------------------------------------------------

export interface BleBridgeServerOptions {
  /** The per-launch device token (QTASK_DEVICE_TOKEN). */
  token: string;
  host?: string;
  port?: number;
  radio?: BridgeRadio;
  authTimeoutMs?: number;
  log?: (m: string) => void;
}

/**
 * Accepts exactly one app connection at a time on loopback. A client that does not
 * present the token within the timeout, sends garbage, or arrives while another is
 * attached is dropped. The bridge only ever moves radio bytes (already end-to-end
 * encrypted by the tunnel); the token keeps other local processes from impersonating the
 * app's radio.
 */
export class BleBridgeServer {
  readonly radio: BridgeRadio;
  private server: Server | null = null;
  private active: Socket | null = null;
  port = 0;
  constructor(private readonly o: BleBridgeServerOptions) {
    this.radio = o.radio ?? new BridgeRadio();
  }

  async listen(): Promise<number> {
    const host = this.o.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') throw new Error('the Bluetooth bridge listens on loopback only');
    this.server = createServer((s) => this.onSocket(s));
    await new Promise<void>((res, rej) => {
      this.server!.once('error', rej);
      this.server!.listen(this.o.port ?? 0, host, () => res());
    });
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async close(): Promise<void> {
    this.active?.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  private onSocket(s: Socket): void {
    s.setEncoding('utf8');
    s.setNoDelay(true);
    s.on('error', () => undefined);
    const dec = new LineDecoder();
    let authed = false;
    const timer = setTimeout(() => s.destroy(), this.o.authTimeoutMs ?? 5000);
    timer.unref();
    s.on('close', () => {
      clearTimeout(timer);
      if (this.active === s) {
        this.active = null;
        this.radio.detach();
      }
    });
    s.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = dec.push(chunk);
      } catch {
        s.destroy();
        return;
      }
      for (const line of lines) {
        const m = parseMsg(line);
        if (!m) {
          if (!authed) return void s.destroy();
          continue;
        }
        if (!authed) {
          const tok = typeof m.token === 'string' ? Buffer.from(m.token) : Buffer.alloc(0);
          const want = Buffer.from(this.o.token);
          if (m.t !== 'auth' || tok.length !== want.length || !timingSafeEqual(tok, want) || this.active) {
            this.o.log?.('bridge: client refused');
            return void s.destroy();
          }
          authed = true;
          clearTimeout(timer);
          this.active = s;
          this.radio.attach((msg) => {
            if (!s.destroyed) s.write(JSON.stringify(msg) + '\n');
          });
          continue;
        }
        this.radio.feed(m);
      }
    });
  }
}
