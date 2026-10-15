/**
 * A small mDNS / DNS-SD implementation for exactly one service type (`_qtask._tcp`).
 *
 * Why not a package: the maintained options (bonjour-service, multicast-dns) are fine
 * but each pulls transitive dependencies into a security-sensitive path that parses
 * attacker-controlled UDP from the local network, and we need only PTR/SRV/TXT/A for
 * one service. This is ~250 lines on node:dgram, with a decoder written to never
 * throw past its boundary and to bound its work (see mdns.test.ts fuzz test).
 * On the Mac app the native side may instead advertise/browse with NWListener /
 * NWBrowser; the wire result is the same service and both can coexist.
 *
 * Advertised data is deliberately minimal and non-secret: protocol version and the
 * public node id (a hash of a public key). Nothing about tasks, users or names.
 */

import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';

export const SERVICE_TYPE = '_qtask._tcp.local';
export const MDNS_GROUP = '224.0.0.251';
export const MDNS_PORT = 5353;

const T_A = 1;
const T_PTR = 12;
const T_TXT = 16;
const T_SRV = 33;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;

export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  data: unknown;
}
export interface DnsMessage {
  isResponse: boolean;
  questions: Array<{ name: string; type: number }>;
  records: DnsRecord[]; // answers + authority + additional, flattened
}

// --- encoding -------------------------------------------------------------------------

function encName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    const b = Buffer.from(label, 'utf8');
    if (b.length > 63) throw new Error('label too long');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encRecord(r: DnsRecord): Buffer {
  let rdata: Buffer;
  switch (r.type) {
    case T_PTR:
      rdata = encName(r.data as string);
      break;
    case T_SRV: {
      const d = r.data as { port: number; target: string };
      const h = Buffer.alloc(6);
      h.writeUInt16BE(d.port, 4);
      rdata = Buffer.concat([h, encName(d.target)]);
      break;
    }
    case T_TXT: {
      const strs = (r.data as string[]).map((s) => Buffer.from(s, 'utf8'));
      rdata = strs.length
        ? Buffer.concat(strs.flatMap((s) => [Buffer.from([s.length]), s]))
        : Buffer.from([0]);
      break;
    }
    case T_A:
      rdata = Buffer.from((r.data as string).split('.').map(Number));
      break;
    default:
      throw new Error('unsupported record type');
  }
  const h = Buffer.alloc(10);
  h.writeUInt16BE(r.type, 0);
  h.writeUInt16BE(CLASS_IN | (r.type === T_PTR ? 0 : CACHE_FLUSH), 2);
  h.writeUInt32BE(r.ttl, 4);
  h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encName(r.name), h, rdata]);
}

export function encodeMessage(m: { isResponse: boolean; questions?: Array<{ name: string; type: number }>; records?: DnsRecord[] }): Buffer {
  const qs = m.questions ?? [];
  const rs = m.records ?? [];
  const h = Buffer.alloc(12);
  h.writeUInt16BE(m.isResponse ? 0x8400 : 0, 2);
  h.writeUInt16BE(qs.length, 4);
  h.writeUInt16BE(rs.length, 6);
  const parts: Buffer[] = [h];
  for (const q of qs) {
    const t = Buffer.alloc(4);
    t.writeUInt16BE(q.type, 0);
    t.writeUInt16BE(CLASS_IN, 2);
    parts.push(encName(q.name), t);
  }
  for (const r of rs) parts.push(encRecord(r));
  return Buffer.concat(parts);
}

// --- decoding (bounded, never throws) ---------------------------------------------------

class Reader {
  constructor(readonly b: Buffer) {}
  u16(o: number): number {
    if (o + 2 > this.b.length) throw new RangeError('eof');
    return this.b.readUInt16BE(o);
  }
  u32(o: number): number {
    if (o + 4 > this.b.length) throw new RangeError('eof');
    return this.b.readUInt32BE(o);
  }
  /** Reads a possibly compressed name. Returns [name, offsetAfterName]. */
  name(off: number): [string, number] {
    const labels: string[] = [];
    let o = off;
    let end = -1;
    let jumps = 0;
    for (;;) {
      if (o >= this.b.length) throw new RangeError('eof');
      const l = this.b[o]!;
      if (l === 0) {
        if (end < 0) end = o + 1;
        break;
      }
      if ((l & 0xc0) === 0xc0) {
        if (o + 1 >= this.b.length) throw new RangeError('eof');
        if (end < 0) end = o + 2;
        if (++jumps > 10) throw new RangeError('pointer loop');
        o = ((l & 0x3f) << 8) | this.b[o + 1]!;
        continue;
      }
      if (l > 63) throw new RangeError('bad label');
      if (o + 1 + l > this.b.length) throw new RangeError('eof');
      labels.push(this.b.toString('utf8', o + 1, o + 1 + l));
      if (labels.length > 40) throw new RangeError('name too long');
      o += 1 + l;
    }
    return [labels.join('.'), end];
  }
}

const MAX_RECORDS = 64;

export function decodeMessage(buf: Buffer): DnsMessage | null {
  try {
    const r = new Reader(buf);
    const flags = r.u16(2);
    const qd = r.u16(4);
    const rc = r.u16(6) + r.u16(8) + r.u16(10);
    if (qd > 16 || rc > MAX_RECORDS) return null;
    let o = 12;
    const questions: DnsMessage['questions'] = [];
    for (let i = 0; i < qd; i++) {
      const [name, n] = r.name(o);
      questions.push({ name, type: r.u16(n) });
      o = n + 4;
    }
    const records: DnsRecord[] = [];
    for (let i = 0; i < rc; i++) {
      const [name, n] = r.name(o);
      const type = r.u16(n);
      const ttl = r.u32(n + 4);
      const rdlen = r.u16(n + 8);
      const ds = n + 10;
      if (ds + rdlen > buf.length) return null;
      o = ds + rdlen;
      let data: unknown = null;
      if (type === T_PTR) data = r.name(ds)[0];
      else if (type === T_SRV) {
        data = { port: r.u16(ds + 4), target: r.name(ds + 6)[0] };
      } else if (type === T_TXT) {
        const strs: string[] = [];
        let p = ds;
        while (p < ds + rdlen) {
          const l = buf[p]!;
          if (p + 1 + l > ds + rdlen) break;
          if (l) strs.push(buf.toString('utf8', p + 1, p + 1 + l));
          p += 1 + l;
        }
        data = strs;
      } else if (type === T_A && rdlen === 4) data = `${buf[ds]}.${buf[ds + 1]}.${buf[ds + 2]}.${buf[ds + 3]}`;
      else continue;
      records.push({ name, type, ttl, data });
    }
    return { isResponse: (flags & 0x8000) !== 0, questions, records };
  } catch {
    return null;
  }
}

export function parseTxt(strs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of strs) {
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

// --- socket plumbing ----------------------------------------------------------------------

export interface MdnsOptions {
  /** Multicast UDP port. 5353 in production; tests use another to stay off the system responder. */
  port?: number;
  group?: string;
  /** Local IPv4 addresses of the interfaces to use. Default: all non-internal IPv4 interfaces. */
  interfaces?: string[];
}

function localV4(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

class MdnsSocket extends EventEmitter {
  readonly sock: dgram.Socket;
  readonly ifaces: string[];
  private readonly port: number;
  private readonly group: string;

  constructor(o: MdnsOptions) {
    super();
    this.port = o.port ?? MDNS_PORT;
    this.group = o.group ?? MDNS_GROUP;
    this.ifaces = o.interfaces ?? localV4();
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('message', (msg, rinfo) => this.emit('packet', msg, rinfo.address));
    this.sock.on('error', () => undefined);
  }

  async open(): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.sock.once('error', rej);
      this.sock.bind(this.port, () => {
        this.sock.off('error', rej);
        res();
      });
    });
    for (const i of this.ifaces) {
      try {
        this.sock.addMembership(this.group, i);
      } catch {
        /* interface may not support multicast */
      }
    }
    try {
      this.sock.setMulticastTTL(255);
      this.sock.setMulticastLoopback(true);
    } catch {
      /* ignore */
    }
  }

  send(buf: Buffer): void {
    const ifaces = this.ifaces.length ? this.ifaces : [undefined];
    for (const i of ifaces) {
      try {
        if (i) this.sock.setMulticastInterface(i);
        this.sock.send(buf, this.port, this.group, () => undefined);
      } catch {
        /* ignore send failures on a flapping interface */
      }
    }
  }

  close(): void {
    try {
      this.sock.close();
    } catch {
      /* already closed */
    }
  }
}

// --- advertiser ----------------------------------------------------------------------------

export interface Advertisement {
  instance: string; // e.g. qtask-1a2b3c4d
  port: number;
  txt: Record<string, string>;
}

export class MdnsAdvertiser {
  private s: MdnsSocket;
  private timer: NodeJS.Timeout | null = null;
  private readonly host: string;
  constructor(
    private readonly ad: Advertisement,
    private readonly o: MdnsOptions = {},
  ) {
    this.s = new MdnsSocket(o);
    this.host = `${ad.instance}.local`;
  }

  private records(ttl: number): DnsRecord[] {
    const full = `${this.ad.instance}.${SERVICE_TYPE}`;
    const addrs = this.s.ifaces;
    return [
      { name: SERVICE_TYPE, type: T_PTR, ttl, data: full },
      { name: full, type: T_SRV, ttl, data: { port: this.ad.port, target: this.host } },
      { name: full, type: T_TXT, ttl, data: Object.entries(this.ad.txt).map(([k, v]) => `${k}=${v}`) },
      ...addrs.map((a) => ({ name: this.host, type: T_A, ttl, data: a })),
    ];
  }

  async start(): Promise<void> {
    this.s.on('packet', (msg: Buffer) => {
      const m = decodeMessage(msg);
      if (!m || m.isResponse) return;
      if (m.questions.some((q) => q.name.toLowerCase() === SERVICE_TYPE && (q.type === T_PTR || q.type === 255))) {
        // Small random delay avoids a response storm when many devices answer one query.
        setTimeout(() => this.announce(120), Math.random() * 100);
      }
    });
    await this.s.open();
    this.announce(120);
    // Re-announce periodically so late joiners and cache-expiry are covered.
    this.timer = setInterval(() => this.announce(120), 30_000);
    this.timer.unref();
  }

  private announce(ttl: number): void {
    this.s.send(encodeMessage({ isResponse: true, records: this.records(ttl) }));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.announce(0); // goodbye
    await new Promise((r) => setTimeout(r, 20));
    this.s.close();
  }
}

// --- browser --------------------------------------------------------------------------------

export interface MdnsService {
  instance: string;
  host: string;
  port: number;
  txt: Record<string, string>;
  addresses: string[];
}

export class MdnsBrowser extends EventEmitter {
  private s: MdnsSocket;
  private timer: NodeJS.Timeout | null = null;
  private ptrs = new Map<string, number>(); // instance fqdn -> expiry
  private srv = new Map<string, { port: number; target: string }>();
  private txt = new Map<string, Record<string, string>>();
  private a = new Map<string, Set<string>>();
  private lastEmit = new Map<string, string>();

  constructor(o: MdnsOptions = {}) {
    super();
    this.s = new MdnsSocket(o);
  }

  /** Emits 'up' (MdnsService) when a service is first seen or changes, 'down' (instance). */
  async start(): Promise<void> {
    this.s.on('packet', (msg: Buffer, from: string) => this.onPacket(msg, from));
    await this.s.open();
    let delay = 1000;
    const query = () => {
      this.s.send(encodeMessage({ isResponse: false, questions: [{ name: SERVICE_TYPE, type: T_PTR }] }));
      this.timer = setTimeout(query, delay);
      this.timer.unref();
      delay = Math.min(delay * 2, 60_000);
    };
    query();
  }

  /** Ask again right now (e.g. when the user opens the "Nearby devices" screen). */
  rescan(): void {
    this.s.send(encodeMessage({ isResponse: false, questions: [{ name: SERVICE_TYPE, type: T_PTR }] }));
  }

  private onPacket(msg: Buffer, from: string): void {
    const m = decodeMessage(msg);
    if (!m || !m.isResponse) return;
    const touched = new Set<string>();
    for (const r of m.records) {
      const lname = r.name.toLowerCase();
      if (r.type === T_PTR && lname === SERVICE_TYPE) {
        const inst = r.data as string;
        if (!inst.toLowerCase().endsWith(`.${SERVICE_TYPE}`)) continue;
        if (r.ttl === 0) {
          this.drop(inst);
          continue;
        }
        if (this.ptrs.size < 256 || this.ptrs.has(inst)) this.ptrs.set(inst, Date.now() + r.ttl * 1000);
        touched.add(inst);
      } else if (r.type === T_SRV && lname.endsWith(`.${SERVICE_TYPE}`)) {
        if (r.ttl === 0) this.drop(r.name);
        else {
          this.srv.set(r.name, r.data as { port: number; target: string });
          touched.add(r.name);
        }
      } else if (r.type === T_TXT && lname.endsWith(`.${SERVICE_TYPE}`)) {
        this.txt.set(r.name, parseTxt(r.data as string[]));
        touched.add(r.name);
      } else if (r.type === T_A && r.ttl > 0) {
        const set = this.a.get(r.name) ?? new Set();
        if (set.size < 16) set.add(r.data as string);
        this.a.set(r.name, set);
      }
    }
    for (const inst of this.ptrs.keys()) if (touched.has(inst) || this.srv.has(inst)) this.maybeEmit(inst, from);
  }

  private maybeEmit(inst: string, from: string): void {
    const srv = this.srv.get(inst);
    const txt = this.txt.get(inst);
    if (!srv || !txt || !this.ptrs.has(inst)) return;
    const addrs = [...(this.a.get(srv.target) ?? [])];
    // Prefer the address the packet actually came from: it is the one that is routable to us.
    const ordered = [from, ...addrs.filter((x) => x !== from)];
    const svc: MdnsService = {
      instance: inst.slice(0, -(SERVICE_TYPE.length + 1)),
      host: srv.target,
      port: srv.port,
      txt,
      addresses: ordered,
    };
    const key = JSON.stringify([svc.port, svc.txt, ordered[0]]);
    if (this.lastEmit.get(inst) === key) return;
    this.lastEmit.set(inst, key);
    this.emit('up', svc);
  }

  private drop(inst: string): void {
    this.ptrs.delete(inst);
    this.srv.delete(inst);
    this.txt.delete(inst);
    this.lastEmit.delete(inst);
    this.emit('down', inst.slice(0, -(SERVICE_TYPE.length + 1)));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.s.close();
  }
}
