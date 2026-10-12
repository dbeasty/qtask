/**
 * A simulated Bluetooth LE air interface, so the tunnel, transport and the real sync
 * engine are exercised without hardware.
 *
 * Time is VIRTUAL. `SimClock` is both the simulator's event queue and the `Timers` the
 * transport uses, so a sync that needs two minutes on a 20 KB/s link finishes in
 * milliseconds of real time and gives the same answer every run. Tests advance the clock
 * with `world.until(...)` / `world.drive(promise)`. Computation (crypto, deflate, JSON)
 * costs zero virtual time: results are therefore the RADIO's time, not the CPU's.
 *
 * What it models (all configurable through `SimParams`):
 *   - ATT MTU (min of both radios) and the resulting chunk size (MTU - 3);
 *   - application-payload bandwidth per direction in bytes/s, plus an optional per-chunk
 *     air overhead;
 *   - one-way latency (about one connection interval), connect time (connect, service
 *     discovery, MTU exchange, subscribe), advertising interval;
 *   - a bounded transmit queue with the same backpressure contract as CoreBluetooth
 *     (`tryWrite` false until `onWritable`);
 *   - link-layer retransmission (a lost packet costs one more interval), and, separately,
 *     hard chunk loss for fault injection (what a misbehaving stack could do);
 *   - range in / out with a supervision timeout, abrupt disconnects, Bluetooth off,
 *     address rotation (a peripheral's device id changes);
 *   - a radio never hears its own advertisement.
 *
 * What it does NOT model: radio contention between several connections or with Wi-Fi,
 * connection-interval negotiation by the OS, iOS/Android scan throttling and background
 * restrictions, packet-level timing inside a connection event, or CPU cost. See
 * docs/perf/phase4.md for what that means for the numbers.
 */

import { createHook } from 'node:async_hooks';
import { workTracker } from '../framing.js';
import {
  ATT_MTU_MAX,
  ATT_MTU_MIN,
  ATT_OVERHEAD,
  type BleRadio,
  type CentralLink,
  type Discovery,
  type GattLink,
  type PeripheralLink,
  type RadioState,
  type Timers,
} from './radio.js';

export interface SimParams {
  /** ATT MTU each radio offers; a link uses the smaller. */
  mtu: number;
  /** Sustained application payload bytes per second, per direction. */
  bytesPerSec: number;
  /** One-way delivery latency per chunk (about the connection interval). */
  latencyMs: number;
  /** Connect + service discovery + MTU exchange + notification subscribe. */
  connectMs: number;
  /** How often a peripheral is heard while scanning. */
  advertiseIntervalMs: number;
  /** Chunks the radio holds before `tryWrite` refuses. */
  txQueue: number;
  /** Extra bytes of air time charged per chunk (headers, inter-frame space). */
  chunkOverheadBytes: number;
  /** Fraction of chunks needing one link-layer retransmission (costs one latency, nothing lost). */
  retransmitRate: number;
  /** Fraction of chunks silently lost (fault injection). */
  dropRate: number;
  /** How long a link in a dead zone lives before both ends notice. */
  supervisionTimeoutMs: number;
  /** Centrals a peripheral accepts at once. */
  maxCentrals: number;
}

export const DEFAULT_PARAMS: SimParams = {
  mtu: 185,
  bytesPerSec: 60_000,
  latencyMs: 50,
  connectMs: 600,
  advertiseIntervalMs: 300,
  txQueue: 24,
  chunkOverheadBytes: 0,
  retransmitRate: 0,
  dropRate: 0,
  supervisionTimeoutMs: 4000,
  maxCentrals: 7,
};

// --- virtual clock ------------------------------------------------------------------------------

interface Ev {
  at: number;
  seq: number;
  kind: 'radio' | 'timer';
  fn: () => void;
  cancelled: boolean;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- knowing when the program is idle ---------------------------------------------------------------
//
// Computation (crypto, deflate, the engine applying documents) costs zero VIRTUAL time, so the
// clock must not move while the program still has work in flight. "Idle" is defined with
// async_hooks: no promise has been created, no compression job is running and no short real timer
// is pending, for two consecutive event-loop turns. Without this, a far-away timer fires while an async apply is
// still running and the run reports tens of seconds of "radio time" that were really CPU.

// Compression jobs on the thread pool are tracked through `workTracker` in framing.ts (async_hooks
// cannot say when a streaming zlib job is finished, it calls back once per chunk).
let BUSY = 0;
workTracker.track = <T>(p: Promise<T>): Promise<T> => {
  BUSY++;
  return p.finally(() => {
    BUSY--;
  });
};
const NATIVE_PENDING = new Set<number>();
const NATIVE_TYPES = new Map<number, string>();
let ACTIVITY = 0;
let hookOn = false;
function enableActivityHook(): void {
  if (hookOn) return;
  hookOn = true;
  createHook({
    init(id, type, _trigger, resource) {
      if (type === 'PROMISE') ACTIVITY++;
      else if (type === 'Timeout') {
        // A short real timer is code yielding to the event loop (setTimeout(0) between batches):
        // work in flight. Long ones (request timeouts, keep-alives) are not.
        const ms = (resource as { _idleTimeout?: number } | undefined)?._idleTimeout;
        if (typeof ms === 'number' && ms <= 50) {
          ACTIVITY++;
          NATIVE_PENDING.add(id);
          NATIVE_TYPES.set(id, 'Timeout');
        }
      } else if (type !== 'Immediate' && type !== 'TickObject' && type !== 'TIMERWRAP') ACTIVITY++;
    },
    before(id) {
      NATIVE_PENDING.delete(id);
    },
    destroy(id) {
      NATIVE_PENDING.delete(id);
    },
  }).enable();
}

/** Resolves once the program has been idle for two consecutive event-loop turns (bounded). */
function quiesce(maxRealMs = 5000): Promise<void> {
  enableActivityHook();
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + maxRealMs;
    let quiet = 0;
    let last = ACTIVITY;
    const step = () => {
      if (ACTIVITY === last && NATIVE_PENDING.size === 0 && BUSY === 0) {
        if (++quiet >= 2) return resolve();
      } else {
        quiet = 0;
        last = ACTIVITY;
      }
      if (Date.now() > deadline) {
        if (process.env.SIM_DEBUG) console.error('quiesce deadline; pending', [...NATIVE_PENDING].map((i) => NATIVE_TYPES.get(i)));
        return resolve();
      }
      if (NATIVE_PENDING.size || BUSY) {
        if (process.env.SIM_DEBUG === '2') console.error('waiting for', [...NATIVE_PENDING].map((i) => NATIVE_TYPES.get(i)));
        setTimeout(step, 1);
      }
      else setImmediate(step);
    };
    setImmediate(step);
  });
}

export class SimClock implements Timers {
  private t = 0;
  private seq = 0;
  private heap: Ev[] = [];
  /** Events executed, for diagnostics. */
  events = 0;

  constructor() {
    enableActivityHook();
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    return this.schedule(this.t + Math.max(0, ms), 'timer', fn);
  }
  clearTimeout(h: unknown): void {
    if (h) (h as Ev).cancelled = true;
  }

  schedule(at: number, kind: 'radio' | 'timer', fn: () => void): Ev {
    const e: Ev = { at: Math.max(at, this.t), seq: this.seq++, kind, fn, cancelled: false };
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(h[p]!, h[i]!)) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
    return e;
  }

  private less(a: Ev, b: Ev): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }

  private popRaw(): Ev | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }

  private pop(): Ev | undefined {
    for (;;) {
      const e = this.popRaw();
      if (!e || !e.cancelled) return e;
    }
  }

  private peek(): Ev | undefined {
    while (this.heap.length && this.heap[0]!.cancelled) this.popRaw();
    return this.heap[0];
  }

  /** Waits until the program is idle, so work in flight finishes before time moves. */
  private async settle(_strong: boolean): Promise<void> {
    await quiesce();
  }

  /**
   * Advances virtual time until `pred()` holds. `realWaitMs` bounds how long the loop
   * waits in REAL time when nothing is scheduled (real sockets, such as a LAN transport
   * on loopback, complete on their own time).
   */
  async until(
    pred: () => boolean | Promise<boolean>,
    opts: { maxVirtualMs?: number; realWaitMs?: number; what?: string } = {},
  ): Promise<void> {
    const limit = this.t + (opts.maxVirtualMs ?? 3_600_000);
    const realDeadline = Date.now() + (opts.realWaitMs ?? 60_000);
    let next: Ev | undefined;
    for (;;) {
      await this.settle(false);
      if (await pred()) return;
      next = this.peek();
      if (!next) {
        await realSleep(2);
        await this.settle(true);
        if (await pred()) return;
        if (!this.peek()) {
          if (Date.now() > realDeadline) throw new Error(`sim stalled${opts.what ? ` waiting for ${opts.what}` : ''} at t=${this.t}ms`);
          continue;
        }
        continue;
      }
      if (next.at > limit) throw new Error(`virtual time limit (${opts.maxVirtualMs ?? 3_600_000} ms) reached${opts.what ? ` waiting for ${opts.what}` : ''}`);
      if (next.kind === 'timer') await this.settle(true);
      const e = this.pop();
      if (!e) continue;
      if (process.env.SIM_DEBUG === '3' && e.at - this.t > 1000) console.error(`jump ${Math.round(this.t)} -> ${Math.round(e.at)} kind ${e.kind} pending ${NATIVE_PENDING.size} activity ${ACTIVITY}`);
      this.t = Math.max(this.t, e.at);
      this.events++;
      e.fn();
    }
  }

  /** Runs the clock until `p` settles and returns its value. */
  async drive<T>(p: Promise<T>, opts: { maxVirtualMs?: number; realWaitMs?: number; what?: string } = {}): Promise<T> {
    let done = false;
    let value!: T;
    let error: unknown;
    let failed = false;
    p.then(
      (v) => ((value = v), (done = true)),
      (e) => ((error = e), (failed = true), (done = true)),
    );
    await this.until(() => done, opts);
    if (failed) throw error;
    return value;
  }

  /** Advances virtual time by `ms`, running everything due on the way. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await this.settle(false);
      const next = this.peek();
      if (!next || next.at > end) break;
      if (next.kind === 'timer') await this.settle(true);
      const e = this.pop();
      if (!e) continue;
      this.t = Math.max(this.t, e.at);
      this.events++;
      e.fn();
    }
    this.t = end;
    await this.settle(false);
  }
}

// --- deterministic randomness ---------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- the air ------------------------------------------------------------------------------------

interface DirState {
  freeAt: number;
  queued: number;
  writable: Array<() => void>;
}

class SimConnection {
  closed = false;
  dead = false;
  held: Array<() => void> = [];
  deadTimer: unknown = null;
  readonly dir: Record<'c2p' | 'p2c', DirState> = {
    c2p: { freeAt: 0, queued: 0, writable: [] },
    p2c: { freeAt: 0, queued: 0, writable: [] },
  };
  readonly stats = { c2pBytes: 0, p2cBytes: 0, c2pChunks: 0, p2cChunks: 0, dropped: 0, refused: 0 };
  central!: SimEndpoint;
  peripheral!: SimEndpoint;
  constructor(
    readonly world: SimWorld,
    readonly cRadio: SimRadio,
    readonly pRadio: SimRadio,
    readonly params: SimParams,
    readonly mtu: number,
  ) {}

  teardown(origin: 'c' | 'p' | 'air', reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.held = [];
    if (this.deadTimer) this.world.clock.clearTimeout(this.deadTimer);
    const now = this.world.clock.now();
    const lat = origin === 'air' ? 0 : this.params.latencyMs;
    const notify = (ep: SimEndpoint, delay: number) =>
      this.world.clock.schedule(now + delay, 'radio', () => ep.finish(reason));
    notify(origin === 'p' ? this.peripheral : this.central, 0);
    notify(origin === 'p' ? this.central : this.peripheral, origin === 'air' ? 0 : lat);
    // Writers blocked on backpressure wake up and see the closed link.
    for (const d of Object.values(this.dir)) for (const w of d.writable.splice(0)) w();
    this.cRadio.conns.delete(this);
    this.pRadio.conns.delete(this);
    this.world.retire(this);
  }
}

class SimEndpoint implements GattLink {
  readonly maxChunk: number;
  private dataHandler: ((c: Uint8Array) => void) | null = null;
  private earlyData: Uint8Array[] = [];
  private closeHandlers: Array<(e?: Error) => void> = [];
  private finished: { reason?: Error } | null = null;
  readonly role: 'central' | 'peripheral';

  constructor(
    readonly id: string,
    private readonly conn: SimConnection,
    private readonly side: 'c' | 'p',
  ) {
    this.role = side === 'c' ? 'central' : 'peripheral';
    this.maxChunk = conn.mtu - ATT_OVERHEAD;
  }

  get mtu(): number {
    return this.conn.mtu;
  }

  private get out(): DirState {
    return this.conn.dir[this.side === 'c' ? 'c2p' : 'p2c'];
  }

  tryWrite(chunk: Uint8Array): boolean {
    const c = this.conn;
    if (c.closed || this.finished) throw new Error('link closed');
    if (chunk.length < 1 || chunk.length > this.maxChunk) throw new Error(`chunk of ${chunk.length} bytes exceeds ${this.maxChunk}`);
    const d = this.out;
    const p = c.params;
    if (d.queued >= p.txQueue) {
      c.stats.refused++;
      return false;
    }
    const clock = c.world.clock;
    const now = clock.now();
    d.queued++;
    const air = ((chunk.length + p.chunkOverheadBytes) / p.bytesPerSec) * 1000;
    const start = Math.max(now, d.freeAt);
    let done = start + air;
    let extra = 0;
    if (p.retransmitRate > 0 && c.world.rand() < p.retransmitRate) extra = p.latencyMs;
    d.freeAt = done + extra;
    done += extra;
    const bytes = Buffer.from(chunk);
    const toPeripheral = this.side === 'c';
    clock.schedule(done, 'radio', () => {
      d.queued--;
      if (d.queued < p.txQueue && d.writable.length) for (const w of d.writable.splice(0)) w();
    });
    const lost = p.dropRate > 0 && c.world.rand() < p.dropRate;
    if (lost) c.stats.dropped++;
    clock.schedule(done + p.latencyMs, 'radio', () => {
      if (c.closed || lost) return;
      const deliver = () => {
        if (c.closed) return;
        if (toPeripheral) {
          c.stats.c2pBytes += bytes.length;
          c.stats.c2pChunks++;
          c.peripheral.receive(bytes);
        } else {
          c.stats.p2cBytes += bytes.length;
          c.stats.p2cChunks++;
          c.central.receive(bytes);
        }
      };
      if (c.dead) c.held.push(deliver);
      else deliver();
    });
    return true;
  }

  onWritable(handler: () => void): void {
    if (this.finished || this.conn.closed) {
      queueMicrotask(handler);
      return;
    }
    this.out.writable.push(handler);
  }

  onData(handler: (c: Uint8Array) => void): void {
    this.dataHandler = handler;
    for (const c of this.earlyData.splice(0)) handler(c);
  }

  receive(bytes: Uint8Array): void {
    if (this.finished) return;
    if (this.dataHandler) this.dataHandler(bytes);
    else this.earlyData.push(bytes);
  }

  onClose(handler: (e?: Error) => void): void {
    if (this.finished) handler(this.finished.reason);
    else this.closeHandlers.push(handler);
  }

  finish(reason?: Error): void {
    if (this.finished) return;
    this.finished = { reason };
    for (const h of this.closeHandlers.splice(0)) h(reason);
  }

  close(): void {
    if (this.conn.closed) return;
    this.conn.teardown(this.side);
  }

  async readInfo(): Promise<Uint8Array> {
    const c = this.conn;
    if (this.side !== 'c') throw new Error('readInfo is a central operation');
    const clock = c.world.clock;
    return new Promise<Uint8Array>((resolve, reject) => {
      if (c.closed) return reject(new Error('link closed'));
      clock.schedule(clock.now() + 2 * c.params.latencyMs, 'radio', () => {
        if (c.closed) return reject(new Error('link closed'));
        const read = () => resolve(Buffer.from(c.pRadio.info));
        if (c.dead) c.held.push(read);
        else read();
      });
    });
  }
}

interface PendingConnect {
  deviceId: string;
  timeoutAt: number;
  resolve: (l: CentralLink) => void;
  reject: (e: Error) => void;
  timer: unknown;
  started: boolean;
}

export class SimRadio implements BleRadio {
  state: RadioState = 'on';
  readonly conns = new Set<SimConnection>();
  info: Uint8Array = new Uint8Array();
  advertising = false;
  scanning = false;
  address: string;
  private stateHandlers: Array<(s: RadioState) => void> = [];
  private incomingHandler: ((l: PeripheralLink) => void) | null = null;
  private earlyIncoming: PeripheralLink[] = [];
  private discHandler: ((d: Discovery) => void) | null = null;
  private seenThisScan = new Set<string>();
  private pending = new Set<PendingConnect>();
  readonly stats = { connectsOut: 0, connectsIn: 0, bytesTx: 0, bytesRx: 0 };

  constructor(
    readonly world: SimWorld,
    readonly name: string,
    readonly mtuOffer: number,
    address: string,
  ) {
    this.address = address;
  }

  onState(h: (s: RadioState) => void): void {
    this.stateHandlers.push(h);
  }

  // --- peripheral ---
  async startAdvertising(info: Uint8Array): Promise<void> {
    this.info = Buffer.from(info);
    this.advertising = this.state === 'on';
    this.world.changed();
  }
  async setInfo(info: Uint8Array): Promise<void> {
    this.info = Buffer.from(info);
  }
  async stopAdvertising(): Promise<void> {
    this.advertising = false;
    this.world.changed();
  }
  onIncoming(h: (l: PeripheralLink) => void): void {
    this.incomingHandler = h;
    for (const l of this.earlyIncoming.splice(0)) h(l);
  }
  deliverIncoming(l: PeripheralLink): void {
    this.stats.connectsIn++;
    if (this.incomingHandler) this.incomingHandler(l);
    else this.earlyIncoming.push(l);
  }

  // --- central ---
  async startScan(): Promise<void> {
    if (this.state !== 'on') return;
    this.scanning = true;
    this.seenThisScan.clear();
    this.world.changed();
  }
  async stopScan(): Promise<void> {
    this.scanning = false;
  }
  onDiscovered(h: (d: Discovery) => void): void {
    this.discHandler = h;
  }

  /** Called by the world whenever range, advertising or addresses change. */
  evaluate(): void {
    if (this.state !== 'on') return;
    const w = this.world;
    if (this.scanning) {
      for (const other of w.radios.values()) {
        if (other === this || !other.advertising || other.state !== 'on' || !w.inRange(this, other)) continue;
        const id = other.address;
        if (this.seenThisScan.has(id)) continue;
        this.seenThisScan.add(id);
        const delay = w.rand() * w.paramsFor(this, other).advertiseIntervalMs;
        w.clock.schedule(w.clock.now() + delay, 'radio', () => {
          if (this.scanning && this.state === 'on' && other.advertising && w.inRange(this, other) && other.address === id) {
            this.discHandler?.({ deviceId: id, rssi: -60 });
          }
        });
      }
    }
    for (const p of [...this.pending]) this.tryStart(p);
  }

  connect(deviceId: string, timeoutMs: number): Promise<CentralLink> {
    if (this.state !== 'on') return Promise.reject(new Error('bluetooth is off'));
    const w = this.world;
    return new Promise<CentralLink>((resolve, reject) => {
      const p: PendingConnect = {
        deviceId,
        timeoutAt: w.clock.now() + timeoutMs,
        resolve,
        reject,
        started: false,
        timer: null,
      };
      p.timer = w.clock.setTimeout(() => {
        this.pending.delete(p);
        if (!p.started) reject(new Error('connect timeout'));
      }, timeoutMs);
      this.pending.add(p);
      this.stats.connectsOut++;
      this.tryStart(p);
    });
  }

  private tryStart(p: PendingConnect): void {
    if (p.started) return;
    const w = this.world;
    const target = w.byAddress(p.deviceId);
    if (!target || target === this) {
      // The stack does not know this id (address rotated): fails fast, like a stale identifier.
      p.started = true;
      this.pending.delete(p);
      w.clock.clearTimeout(p.timer);
      w.clock.schedule(w.clock.now() + 20, 'radio', () => p.reject(new Error('unknown device')));
      return;
    }
    if (!target.advertising || target.state !== 'on' || !w.inRange(this, target)) return; // keeps waiting
    if (target.conns.size >= w.paramsFor(this, target).maxCentrals) {
      p.started = true;
      this.pending.delete(p);
      w.clock.clearTimeout(p.timer);
      w.clock.schedule(w.clock.now() + 50, 'radio', () => p.reject(new Error('peripheral busy')));
      return;
    }
    p.started = true;
    const params = w.paramsFor(this, target);
    const mtu = Math.max(ATT_MTU_MIN, Math.min(this.mtuOffer, target.mtuOffer, ATT_MTU_MAX));
    w.clock.schedule(w.clock.now() + params.connectMs, 'radio', () => {
      this.pending.delete(p);
      w.clock.clearTimeout(p.timer);
      if (this.state !== 'on' || target.state !== 'on' || !w.inRange(this, target) || !target.advertising) {
        return p.reject(new Error('connection failed'));
      }
      const conn = new SimConnection(w, this, target, params, mtu);
      const cid = `${this.name}>${target.address}#${++w.linkSeq}`;
      const pid = `${target.name}<${this.name}#${w.linkSeq}`;
      conn.central = new SimEndpoint(cid, conn, 'c');
      conn.peripheral = new SimEndpoint(pid, conn, 'p');
      this.conns.add(conn);
      target.conns.add(conn);
      w.connections.add(conn);
      target.deliverIncoming(conn.peripheral as unknown as PeripheralLink);
      w.clock.schedule(w.clock.now() + params.latencyMs, 'radio', () => {
        if (conn.closed) return p.reject(new Error('connection lost'));
        p.resolve(conn.central as unknown as CentralLink);
      });
    });
  }

  // --- control ---
  setState(s: RadioState): void {
    if (s === this.state) return;
    this.state = s;
    if (s !== 'on') {
      this.advertising = false;
      this.scanning = false;
      for (const c of [...this.conns]) c.teardown(c.cRadio === this ? 'c' : 'p', new Error('bluetooth turned off'));
      for (const p of [...this.pending]) {
        this.pending.delete(p);
        p.reject(new Error('bluetooth turned off'));
      }
    }
    for (const h of this.stateHandlers) h(s);
    this.world.changed();
  }
}

export class SimWorld {
  readonly clock = new SimClock();
  readonly radios = new Map<string, SimRadio>();
  readonly connections = new Set<SimConnection>();
  params: SimParams;
  linkSeq = 0;
  private rng: () => number;
  private outOfRange = new Set<string>();
  private pairParams = new Map<string, Partial<SimParams>>();
  private addrSeq = 0;

  constructor(params: Partial<SimParams> = {}, seed = 1) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.rng = mulberry32(seed);
  }

  rand(): number {
    return this.rng();
  }

  createRadio(name: string, opts: { mtu?: number } = {}): SimRadio {
    const r = new SimRadio(this, name, opts.mtu ?? this.params.mtu, this.newAddress());
    this.radios.set(name, r);
    return r;
  }

  private newAddress(): string {
    const n = ++this.addrSeq;
    return `AA:${n.toString(16).padStart(2, '0')}:${Math.floor(this.rng() * 0xffffff)
      .toString(16)
      .padStart(6, '0')}`;
  }

  byAddress(addr: string): SimRadio | undefined {
    for (const r of this.radios.values()) if (r.address === addr) return r;
    return undefined;
  }

  private key(a: SimRadio, b: SimRadio): string {
    return a.name < b.name ? `${a.name}|${b.name}` : `${b.name}|${a.name}`;
  }

  inRange(a: SimRadio, b: SimRadio): boolean {
    return !this.outOfRange.has(this.key(a, b));
  }

  /** Per-pair override of the air parameters (for example one slow pair in a 3-device mesh). */
  setLink(a: SimRadio, b: SimRadio, p: Partial<SimParams>): void {
    this.pairParams.set(this.key(a, b), p);
  }

  paramsFor(a: SimRadio, b: SimRadio): SimParams {
    return { ...this.params, ...(this.pairParams.get(this.key(a, b)) ?? {}) };
  }

  /** Walks `a` and `b` out of / back into range of each other. */
  setRange(a: SimRadio, b: SimRadio, inRange: boolean): void {
    const k = this.key(a, b);
    if (inRange === !this.outOfRange.has(k)) return;
    if (inRange) this.outOfRange.delete(k);
    else this.outOfRange.add(k);
    for (const c of [...this.connections]) {
      if (c.closed || this.key(c.cRadio, c.pRadio) !== k) continue;
      if (!inRange) {
        c.dead = true;
        // Nothing is acknowledged any more; both ends notice only at the supervision timeout.
        c.deadTimer = this.clock.setTimeout(() => {
          if (c.dead) c.teardown('air', new Error('connection timeout'));
        }, c.params.supervisionTimeoutMs);
      } else if (c.dead) {
        c.dead = false;
        if (c.deadTimer) this.clock.clearTimeout(c.deadTimer);
        const held = c.held.splice(0);
        for (const h of held) h();
      }
    }
    this.changed();
  }

  /** Abrupt loss of every connection between a and b (a crash, a stack reset). */
  disconnect(a: SimRadio, b: SimRadio, reason = new Error('link lost')): void {
    for (const c of [...this.connections]) {
      if (!c.closed && this.key(c.cRadio, c.pRadio) === this.key(a, b)) c.teardown('air', reason);
    }
  }

  /** The peripheral gets a new device id, as Android does periodically. */
  rotateAddress(r: SimRadio): string {
    r.address = this.newAddress();
    this.changed();
    return r.address;
  }

  changed(): void {
    for (const r of this.radios.values()) r.evaluate();
  }

  retire(c: SimConnection): void {
    this.connections.delete(c);
    this.closedStats.push(c.stats);
  }

  // convenience wrappers
  until: SimClock['until'] = (p, o) => this.clock.until(p, o);
  drive: SimClock['drive'] = (p, o) => this.clock.drive(p, o);
  advance(ms: number): Promise<void> {
    return this.clock.advance(ms);
  }

  /** Bytes and chunks that crossed the air, all connections, both directions (live and closed ones are summed by the caller if needed). */
  airStats(): { bytes: number; chunks: number; dropped: number; refused: number } {
    let bytes = 0;
    let chunks = 0;
    let dropped = 0;
    let refused = 0;
    for (const s of [...this.closedStats, ...[...this.connections].map((c) => c.stats)]) {
      bytes += s.c2pBytes + s.p2cBytes;
      chunks += s.c2pChunks + s.p2cChunks;
      dropped += s.dropped;
      refused += s.refused;
    }
    return { bytes, chunks, dropped, refused };
  }
  private closedStats: SimConnection['stats'][] = [];
}
