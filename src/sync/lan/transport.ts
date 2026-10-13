/**
 * LAN sync transport: pinned mutual TLS + framed channel + discovery + pairing.
 *
 * Trust model
 *  - One TLS listener per device. Both ends present self-signed certificates and both
 *    ends check the peer's certificate *fingerprint* against the signed pairing
 *    record. No CA, no hostname checks.
 *  - ALPN `qtask-sync/1` is for paired peers only. A connection whose client
 *    certificate is not pinned is destroyed before the server writes a single
 *    application byte, so an unpaired device on the same network learns nothing
 *    but "something with a TLS stack listens here" (and the public certificate).
 *  - ALPN `qtask-pair/1` is served only while a pairing window is open (explicit
 *    user action, one attempt at a time, 3 failures or 2 minutes, whichever first).
 *  - Discovery (mDNS) is only a hint of where to dial. A spoofed advertisement can
 *    at worst cause a failed dial: the fingerprint check is what authenticates.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { FramedChannel, type FramedChannelOptions } from '../framing.js';
import type { PeerLinkTransport, SyncPeerLink } from '../transport-contract.js';
import {
  canonicalJson,
  signRecordBody,
  validateInfo,
  verifyRecord,
  type DeviceIdentity,
  type DeviceInfo,
  type PairedPeer,
  type PairingRecord,
  type PeerStore,
} from './identity.js';
import { formatPairLink, type PairLink } from './links.js';
import { pairMac, pairSas, pairTranscript } from './pairing-crypto.js';
import { MdnsAdvertiser, MdnsBrowser, type MdnsOptions, type MdnsService } from './mdns.js';
import { fingerprintDer } from './x509.js';

export const ALPN_SYNC = 'qtask-sync/1';
export const ALPN_PAIR = 'qtask-pair/1';
export const PROTOCOL_VERSION = 1;

export interface LanTransportOptions {
  identity: DeviceIdentity;
  peers: PeerStore;
  /** Listen port; 0 picks a free one (read `transport.port` after start). */
  port?: number;
  host?: string;
  /** mDNS options, or `false` to disable discovery (manual addresses only). */
  discovery?: MdnsOptions | false;
  /** Address to put in pairing links. Default: first non-internal IPv4, else loopback. */
  advertiseHost?: string;
  backoff?: { minMs?: number; maxMs?: number };
  keepAliveMs?: number;
  channel?: Omit<FramedChannelOptions, 'write'>;
  log?: (msg: string) => void;
}

export interface SecurityEvent {
  reason: 'unpaired-client' | 'pairing-closed' | 'bad-hello' | 'fingerprint-mismatch' | 'pairing-failed';
  remote?: string;
}

function sha256(...parts: Array<string | Buffer>): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function firstLocalAddress(): string {
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

function peerFp(sock: tls.TLSSocket): string | null {
  const c = sock.getPeerCertificate(true);
  return c && c.raw && c.raw.length ? fingerprintDer(c.raw) : null;
}

function eqHex(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Async message reader over a FramedChannel, for the strictly sequential handshakes. */
class Inbox {
  private q: Buffer[] = [];
  private waiters: Array<{ res: (b: Buffer) => void; rej: (e: Error) => void; t: NodeJS.Timeout }> = [];
  private err: Error | null = null;
  constructor(ch: FramedChannel) {
    ch.onMessage((m) => {
      const w = this.waiters.shift();
      if (w) {
        clearTimeout(w.t);
        w.res(m);
      } else this.q.push(m);
    });
    const prev = ch.onClose;
    ch.onClose = (e) => {
      prev?.(e);
      this.fail(e ?? new Error('connection closed'));
    };
  }
  drain(): Buffer[] {
    return this.q.splice(0);
  }
  fail(e: Error): void {
    this.err = e;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.t);
      w.rej(e);
    }
  }
  next(timeoutMs: number): Promise<Buffer> {
    const m = this.q.shift();
    if (m) return Promise.resolve(m);
    if (this.err) return Promise.reject(this.err);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('handshake timeout')), timeoutMs);
      this.waiters.push({ res, rej, t });
    });
  }
  async json<T = Record<string, unknown>>(timeoutMs: number): Promise<T> {
    return JSON.parse((await this.next(timeoutMs)).toString('utf8')) as T;
  }
}

function channelFor(sock: Duplex, opts: Omit<FramedChannelOptions, 'write'> | undefined): FramedChannel {
  const ch = new FramedChannel({
    ...opts,
    write: (bytes) =>
      new Promise<void>((resolve, reject) => {
        if (sock.destroyed) return reject(new Error('socket closed'));
        const ok = sock.write(bytes, (err) => (err ? reject(err) : undefined));
        if (ok) resolve();
        else sock.once('drain', () => resolve());
      }),
  });
  sock.on('data', (d: Buffer) => ch.receive(d));
  sock.on('close', () => ch.closeAfterDelivery());
  sock.on('error', (e) => ch.close(e));
  ch.onClose = () => {
    // end() flushes anything still queued (a final message must not be lost to destroy()),
    // then a timer makes sure a stuck peer cannot keep the socket around.
    if (sock.destroyed) return;
    sock.end();
    const t = setTimeout(() => sock.destroy(), 2000);
    t.unref();
    sock.once('close', () => clearTimeout(t));
  };
  return ch;
}

class LanLink implements SyncPeerLink {
  readonly transport = 'lan' as const;
  private msgHandler: ((m: Uint8Array) => void | Promise<void>) | null = null;
  private closeHandlers: Array<(e?: Error) => void> = [];
  private early: Buffer[] = [];
  private closedFlag = false;
  private keep: NodeJS.Timeout | null = null;
  constructor(
    readonly peerId: string,
    readonly peerName: string,
    readonly initiatorId: string,
    readonly channel: FramedChannel,
    keepAliveMs: number,
    early: Buffer[] = [],
  ) {
    this.early = early;
    channel.onMessage((m) => {
      if (this.msgHandler) return this.msgHandler(m);
      this.early.push(m);
    });
    const prev = channel.onClose;
    channel.onClose = (e) => {
      prev?.(e);
      this.finish(e);
    };
    if (keepAliveMs > 0) {
      this.keep = setInterval(() => {
        channel.ping(keepAliveMs).catch((e) => channel.close(e as Error));
      }, keepAliveMs);
      this.keep.unref();
    }
  }
  send(message: Uint8Array): Promise<void> {
    return this.channel.send(message);
  }
  onMessage(h: (m: Uint8Array) => void | Promise<void>): void {
    this.msgHandler = h;
    const e = this.early;
    this.early = [];
    for (const m of e) void h(m);
  }
  onClose(h: (e?: Error) => void): void {
    if (this.closedFlag) h();
    else this.closeHandlers.push(h);
  }
  close(): void {
    this.channel.close();
  }
  get closed(): boolean {
    return this.closedFlag;
  }
  private finish(e?: Error): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    if (this.keep) clearInterval(this.keep);
    for (const h of this.closeHandlers) h(e);
  }
}

export interface PairingInvitation {
  /** `qtask://pair?...` link to render as a QR code. */
  link: string;
  parts: PairLink;
  expiresAt: number;
  /** Resolves when a device paired through this invitation; rejects on timeout/cancel/too many failures. */
  result: Promise<PairedPeer>;
  cancel(): void;
}

export interface OpenPairingOptions {
  timeoutMs?: number;
  /**
   * Allow joiners that did not scan the QR code (typed address). They are accepted
   * only after both users confirm that the same 6-digit code is shown on both
   * screens. Without this callback only QR joiners (those holding the secret) pair.
   */
  confirmSas?: (sas: string, peer: DeviceInfo) => Promise<boolean>;
  maxFailures?: number;
}

interface PairingWindow {
  secret: Buffer;
  confirmSas?: OpenPairingOptions['confirmSas'];
  failures: number;
  maxFailures: number;
  busy: boolean;
  resolve: (p: PairedPeer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const HANDSHAKE_MS = 10_000;
const PAIR_STEP_MS = 120_000;

export class LanTransport extends EventEmitter implements PeerLinkTransport {
  readonly kind = 'lan' as const;
  port = 0;
  get localId(): string {
    return this.o.identity.info.nodeId;
  }
  private server: tls.Server | null = null;
  private advertiser: MdnsAdvertiser | null = null;
  private browser: MdnsBrowser | null = null;
  private upHandlers: Array<(l: SyncPeerLink) => void> = [];
  private downHandlers: Array<(id: string, e?: Error) => void> = [];
  private live = new Map<string, LanLink>();
  private addrs = new Map<string, { host: string; port: number }>();
  private dials = new Map<string, { attempts: number; timer: NodeJS.Timeout | null; busy: boolean }>();
  private pairing: PairingWindow | null = null;
  /** Last advertisement seen per node id, so a device paired *after* it was seen is dialed at once. */
  private seen = new Map<string, MdnsService>();
  private stopped = true;
  private readonly log: (m: string) => void;

  constructor(private readonly o: LanTransportOptions) {
    super();
    this.log = o.log ?? (() => undefined);
    // Unpairing ends the relationship at once: drop the live link and stop dialing.
    o.peers.onChange(() => {
      for (const [id, l] of [...this.live]) if (!o.peers.get(id)) l.close();
      for (const [id, d] of [...this.dials]) {
        if (o.peers.get(id)) continue;
        if (d.timer) clearTimeout(d.timer);
        this.dials.delete(id);
        this.addrs.delete(id);
      }
    });
  }

  /** Last known address of each peer (manual, from pairing or from mDNS), to persist across restarts. */
  knownAddresses(): Array<{ nodeId: string; host: string; port: number }> {
    return [...this.addrs].map(([nodeId, a]) => ({ nodeId, ...a }));
  }

  get self(): DeviceInfo {
    return this.o.identity.info;
  }

  onPeerUp(h: (l: SyncPeerLink) => void): void {
    this.upHandlers.push(h);
    for (const l of this.live.values()) h(l); // replay: a late subscriber still learns of live links
  }
  onPeerDown(h: (id: string, e?: Error) => void): void {
    this.downHandlers.push(h);
  }
  links(): SyncPeerLink[] {
    return [...this.live.values()];
  }

  /** Bytes on the wire (after compression and framing) across live links, for diagnostics and perf runs. */
  wireStats(): { bytesIn: number; bytesOut: number; creditStalls: number } {
    let bytesIn = 0, bytesOut = 0, creditStalls = 0;
    for (const l of this.live.values()) {
      bytesIn += l.channel.stats.bytesIn;
      bytesOut += l.channel.stats.bytesOut;
      creditStalls += l.channel.stats.creditStalls;
    }
    return { bytesIn, bytesOut, creditStalls };
  }

  // --- lifecycle ---

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    const id = this.o.identity;
    this.server = tls.createServer({
      key: id.tlsKeyPem,
      cert: id.tlsCertPem,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      ALPNProtocols: [ALPN_SYNC, ALPN_PAIR],
    });
    this.server.on('secureConnection', (s) => this.onSecure(s));
    this.server.on('tlsClientError', () => undefined);
    this.server.on('error', (e) => this.log(`server error: ${e.message}`));
    await new Promise<void>((res, rej) => {
      this.server!.once('error', rej);
      this.server!.listen(this.o.port ?? 0, this.o.host ?? '0.0.0.0', () => {
        this.server!.off('error', rej);
        res();
      });
    });
    this.port = (this.server.address() as { port: number }).port;

    if (this.o.discovery !== false) {
      const d = this.o.discovery ?? {};
      this.advertiser = new MdnsAdvertiser(
        { instance: `qtask-${id.info.nodeId.slice(0, 12)}`, port: this.port, txt: { v: String(PROTOCOL_VERSION), id: id.info.nodeId } },
        d,
      );
      this.browser = new MdnsBrowser(d);
      this.browser.on('up', (s: MdnsService) => this.onDiscovered(s));
      await this.advertiser.start();
      await this.browser.start();
    }
    // Reconnect to every known peer that has an address (manual addresses survive via addManualAddress).
    for (const p of this.o.peers.list()) this.scheduleDial(p.nodeId, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pairing) this.closePairing(this.pairing, new Error('transport stopped'));
    this.browser?.stop();
    await this.advertiser?.stop();
    for (const d of this.dials.values()) if (d.timer) clearTimeout(d.timer);
    this.dials.clear();
    for (const l of [...this.live.values()]) l.close();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.browser = null;
    this.advertiser = null;
  }

  /** Where to find a paired peer when mDNS cannot (client isolation, hotspot, typed address). */
  addManualAddress(nodeId: string, host: string, port: number): void {
    this.addrs.set(nodeId, { host, port });
    this.scheduleDial(nodeId, 0);
  }

  rescan(): void {
    this.browser?.rescan();
  }

  // --- discovery + dialing ---

  private onDiscovered(s: MdnsService): void {
    const id = s.txt.id;
    if (!id || id === this.self.nodeId || s.txt.v !== String(PROTOCOL_VERSION)) return;
    if (!/^[0-9a-f]{32}$/.test(id)) return;
    if (this.seen.size < 512 || this.seen.has(id)) this.seen.set(id, s);
    if (!this.o.peers.get(id)) return; // unpaired devices are ignored entirely
    this.addrs.set(id, { host: s.addresses[0] ?? '', port: s.port });
    this.log(`discovered paired peer ${id.slice(0, 8)} at ${s.addresses[0]}:${s.port}`);
    const d = this.dials.get(id);
    if (d) d.attempts = 0;
    // Tie-break to avoid both sides dialing at once: the lower id dials immediately.
    this.scheduleDial(id, this.self.nodeId < id ? 0 : 1200, true);
  }

  private scheduleDial(peerId: string, delayMs: number, reset = false): void {
    if (this.stopped || this.live.has(peerId)) return;
    if (!this.addrs.has(peerId)) return;
    const st = this.dials.get(peerId) ?? { attempts: 0, timer: null, busy: false };
    this.dials.set(peerId, st);
    if (reset) st.attempts = 0;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => void this.dial(peerId), delayMs);
    st.timer.unref();
  }

  private backoff(attempts: number): number {
    const min = this.o.backoff?.minMs ?? 500;
    const max = this.o.backoff?.maxMs ?? 30_000;
    const base = Math.min(max, min * 2 ** Math.min(attempts, 16));
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  private async dial(peerId: string): Promise<void> {
    const st = this.dials.get(peerId);
    const addr = this.addrs.get(peerId);
    const peer = this.o.peers.get(peerId);
    if (!st || !addr || !peer || this.stopped || this.live.has(peerId) || st.busy) return;
    st.busy = true;
    st.timer = null;
    try {
      const link = await this.connectSync(peer, addr.host, addr.port);
      st.attempts = 0;
      this.register(link);
    } catch (e) {
      this.log(`dial ${peerId.slice(0, 8)} failed: ${(e as Error).message}`);
      st.attempts++;
      this.scheduleDial(peerId, this.backoff(st.attempts));
    } finally {
      st.busy = false;
    }
  }

  private async connectSync(peer: PairedPeer, host: string, port: number): Promise<LanLink> {
    const id = this.o.identity;
    const sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({
        host,
        port,
        key: id.tlsKeyPem,
        cert: id.tlsCertPem,
        ALPNProtocols: [ALPN_SYNC],
        minVersion: 'TLSv1.3',
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error('connect timeout'));
      }, HANDSHAKE_MS);
      s.once('secureConnect', () => {
        clearTimeout(t);
        const fp = peerFp(s);
        if (!fp || !eqHex(fp, peer.certFp) || s.alpnProtocol !== ALPN_SYNC) {
          s.destroy();
          this.emit('security', { reason: 'fingerprint-mismatch', remote: host } satisfies SecurityEvent);
          return reject(new Error('peer certificate does not match pinned fingerprint'));
        }
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    return this.handshake(sock, peer, true);
  }

  private async handshake(sock: tls.TLSSocket, peer: PairedPeer, outbound: boolean): Promise<LanLink> {
    const ch = channelFor(sock, this.o.channel);
    const inbox = new Inbox(ch);
    try {
      await ch.send(Buffer.from(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, id: this.self.nodeId, name: this.self.name })));
      const h = await inbox.json<{ t: string; v: number; id: string; name?: string }>(HANDSHAKE_MS);
      if (h.t !== 'hello' || h.v !== PROTOCOL_VERSION || h.id !== peer.nodeId) {
        this.emit('security', { reason: 'bad-hello', remote: sock.remoteAddress } satisfies SecurityEvent);
        throw new Error('bad hello');
      }
    } catch (e) {
      ch.close();
      throw e;
    }
    // Hand the channel over from the Inbox to the link.
    const link = new LanLink(
      peer.nodeId,
      peer.name,
      outbound ? this.self.nodeId : peer.nodeId,
      ch,
      this.o.keepAliveMs ?? 15_000,
      inbox.drain(),
    );
    return link;
  }

  private register(link: LanLink): void {
    const existing = this.live.get(link.peerId);
    if (existing && !existing.closed) {
      // Both sides apply the same rule: keep the connection initiated by the lower node id.
      const keepNew = link.initiatorId < existing.initiatorId;
      if (!keepNew) {
        this.log(`duplicate link from ${link.peerId.slice(0, 8)} dropped`);
        link.close();
        return;
      }
      this.live.delete(link.peerId);
      existing.close();
    }
    this.live.set(link.peerId, link);
    link.onClose((e) => {
      if (this.live.get(link.peerId) === link) {
        this.live.delete(link.peerId);
        for (const h of this.downHandlers) h(link.peerId, e);
        this.scheduleDial(link.peerId, this.backoff(0));
      }
    });
    this.log(`peer up ${link.peerId.slice(0, 8)}`);
    for (const h of this.upHandlers) h(link);
  }

  // --- server side ---

  private onSecure(sock: tls.TLSSocket): void {
    const remote = sock.remoteAddress;
    sock.on('error', () => undefined);
    const fp = peerFp(sock);
    if (sock.alpnProtocol === ALPN_SYNC) {
      const peer = fp ? this.o.peers.byCertFp(fp) : undefined;
      if (!peer) {
        this.emit('security', { reason: 'unpaired-client', remote } satisfies SecurityEvent);
        sock.destroy();
        return;
      }
      this.handshake(sock, peer, false).then(
        (l) => this.register(l),
        () => sock.destroy(),
      );
      return;
    }
    if (sock.alpnProtocol === ALPN_PAIR) {
      const w = this.pairing;
      if (!w || w.busy || !fp) {
        this.emit('security', { reason: 'pairing-closed', remote } satisfies SecurityEvent);
        sock.destroy();
        return;
      }
      w.busy = true;
      this.runInviter(sock, w, fp).then(
        (p) => {
          w.busy = false;
          this.closePairing(w);
          w.resolve(p);
        },
        (e) => {
          w.busy = false;
          w.failures++;
          this.log(`pairing attempt failed: ${(e as Error).message}`);
          this.emit('security', { reason: 'pairing-failed', remote } satisfies SecurityEvent);
          sock.destroy();
          if (w.failures >= w.maxFailures) {
            this.closePairing(w);
            w.reject(new Error('too many failed pairing attempts'));
          }
        },
      );
      return;
    }
    sock.destroy();
  }

  // --- pairing ---

  openPairing(opts: OpenPairingOptions = {}): PairingInvitation {
    if (this.pairing) this.closePairing(this.pairing, new Error('superseded by a new pairing window'));
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const secret = randomBytes(16);
    let resolve!: (p: PairedPeer) => void;
    let reject!: (e: Error) => void;
    const result = new Promise<PairedPeer>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    result.catch(() => undefined);
    const w: PairingWindow = {
      secret,
      confirmSas: opts.confirmSas,
      failures: 0,
      maxFailures: opts.maxFailures ?? 3,
      busy: false,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.closePairing(w);
        reject(new Error('pairing window expired'));
      }, timeoutMs),
    };
    w.timer.unref();
    this.pairing = w;
    const parts: PairLink = {
      host: this.o.advertiseHost ?? firstLocalAddress(),
      port: this.port,
      id: this.self.nodeId,
      fp: this.self.certFp,
      secret: secret.toString('base64url'),
    };
    return {
      link: formatPairLink(parts),
      parts,
      expiresAt: Date.now() + timeoutMs,
      result,
      cancel: () => {
        this.closePairing(w);
        reject(new Error('pairing cancelled'));
      },
    };
  }

  private closePairing(w: PairingWindow, err?: Error): void {
    clearTimeout(w.timer);
    if (this.pairing === w) this.pairing = null;
    if (err) w.reject(err);
  }

  private transcript = pairTranscript;

  private exporter(sock: tls.TLSSocket): Buffer {
    return Buffer.from(sock.exportKeyingMaterial(32, 'EXPERIMENTAL qtask pairing v1', Buffer.alloc(0)));
  }

  private async runInviter(sock: tls.TLSSocket, w: PairingWindow, clientFp: string): Promise<PairedPeer> {
    const ch = channelFor(sock, this.o.channel);
    const inbox = new Inbox(ch);
    const send = (o: unknown) => ch.send(Buffer.from(JSON.stringify(o)));
    const me = this.o.identity;
    try {
      const hello = await inbox.json<{ t: string; mode: string; info: DeviceInfo; nonce: string }>(PAIR_STEP_MS);
      if (hello.t !== 'hello' || !validateInfo(hello.info) || hello.info.certFp !== clientFp) throw new Error('bad pairing hello');
      if (hello.info.nodeId === this.self.nodeId) throw new Error('cannot pair with self');
      if (hello.mode !== 'qr' && hello.mode !== 'sas') throw new Error('bad mode');
      if (hello.mode === 'sas' && !w.confirmSas) throw new Error('code pairing is not enabled');
      const ni = randomBytes(16).toString('hex');
      const ts = Date.now();
      await send({ t: 'hello', info: me.info, nonce: ni, ts });
      const T = this.transcript(me.info, hello.info, ni, String(hello.nonce), ts, this.exporter(sock));
      if (hello.mode === 'qr') {
        const a = await inbox.json<{ t: string; mac: string }>(HANDSHAKE_MS);
        if (a.t !== 'auth' || typeof a.mac !== 'string' || !eqHex(a.mac, pairMac(w.secret, 'J', T))) throw new Error('bad pairing secret');
        await send({ t: 'auth', mac: pairMac(w.secret, 'I', T) });
      } else {
        const ok = await w.confirmSas!(pairSas(T), hello.info);
        if (!ok) throw new Error('pairing rejected by user');
        const c = await inbox.json<{ t: string; ok: boolean }>(PAIR_STEP_MS);
        if (c.t !== 'confirm' || c.ok !== true) throw new Error('pairing rejected by peer');
        await send({ t: 'confirm', ok: true });
      }
      const body = { v: 1 as const, ts, a: me.info, b: hello.info };
      const sigA = signRecordBody(me, body);
      await send({ t: 'sig', sig: sigA });
      const s = await inbox.json<{ t: string; sig: string }>(HANDSHAKE_MS);
      const rec: PairingRecord = { ...body, sigA, sigB: String(s.sig) };
      if (s.t !== 'sig' || !verifyRecord(rec)) throw new Error('bad pairing signature');
      const peer = await this.o.peers.add(rec);
      const adv = this.seen.get(peer.nodeId);
      if (adv) this.onDiscovered(adv);
      await send({ t: 'done' });
      await new Promise((r) => setTimeout(r, 20)); // let the final frame flush before teardown
      ch.close();
      return peer;
    } catch (e) {
      ch.close();
      throw e;
    }
  }

  /**
   * Joins a pairing. With a `qtask://pair` link carrying a secret and fingerprint this
   * is the QR flow; with only a host/port it is the 6-digit-code flow and `confirmSas`
   * must ask the user whether the same code is shown on the other device.
   */
  async pairWith(
    target: PairLink,
    opts: { confirmSas?: (sas: string, peer: DeviceInfo) => Promise<boolean> } = {},
  ): Promise<PairedPeer> {
    const me = this.o.identity;
    const qr = !!(target.secret && target.fp);
    if (!qr && !opts.confirmSas) throw new Error('confirmSas is required without a QR invitation');
    const sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({
        host: target.host,
        port: target.port,
        key: me.tlsKeyPem,
        cert: me.tlsCertPem,
        ALPNProtocols: [ALPN_PAIR],
        minVersion: 'TLSv1.3',
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error('connect timeout'));
      }, HANDSHAKE_MS);
      s.once('secureConnect', () => {
        clearTimeout(t);
        const fp = peerFp(s);
        if (!fp || s.alpnProtocol !== ALPN_PAIR || (target.fp && !eqHex(fp, target.fp))) {
          s.destroy();
          return reject(new Error('inviter certificate does not match the QR code'));
        }
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const serverFp = peerFp(sock)!;
    const ch = channelFor(sock, this.o.channel);
    const inbox = new Inbox(ch);
    const send = (o: unknown) => ch.send(Buffer.from(JSON.stringify(o)));
    try {
      const nj = randomBytes(16).toString('hex');
      await send({ t: 'hello', mode: qr ? 'qr' : 'sas', info: me.info, nonce: nj });
      const hello = await inbox.json<{ t: string; info: DeviceInfo; nonce: string; ts: number }>(HANDSHAKE_MS);
      if (hello.t !== 'hello' || !validateInfo(hello.info) || hello.info.certFp !== serverFp) throw new Error('bad pairing hello');
      if (target.id && hello.info.nodeId !== target.id) throw new Error('inviter id does not match the QR code');
      if (typeof hello.ts !== 'number') throw new Error('bad pairing hello');
      const T = this.transcript(hello.info, me.info, String(hello.nonce), nj, hello.ts, this.exporter(sock));
      if (qr) {
        const secret = Buffer.from(target.secret!, 'base64url');
        await send({ t: 'auth', mac: pairMac(secret, 'J', T) });
        const a = await inbox.json<{ t: string; mac: string }>(HANDSHAKE_MS);
        if (a.t !== 'auth' || typeof a.mac !== 'string' || !eqHex(a.mac, pairMac(secret, 'I', T))) throw new Error('inviter failed authentication');
      } else {
        const ok = await opts.confirmSas!(pairSas(T), hello.info);
        await send({ t: 'confirm', ok });
        if (!ok) throw new Error('pairing rejected by user');
        const c = await inbox.json<{ t: string; ok: boolean }>(PAIR_STEP_MS);
        if (c.t !== 'confirm' || c.ok !== true) throw new Error('pairing rejected by peer');
      }
      const body = { v: 1 as const, ts: hello.ts, a: hello.info, b: me.info };
      const s = await inbox.json<{ t: string; sig: string }>(HANDSHAKE_MS);
      const sigB = signRecordBody(me, body);
      const rec: PairingRecord = { ...body, sigA: String(s.sig), sigB };
      if (s.t !== 'sig' || !verifyRecord(rec)) throw new Error('bad pairing signature');
      await send({ t: 'sig', sig: sigB });
      const d = await inbox.json<{ t: string }>(HANDSHAKE_MS);
      if (d.t !== 'done') throw new Error('inviter did not confirm');
      const peer = await this.o.peers.add(rec);
      ch.close();
      this.addrs.set(peer.nodeId, { host: target.host, port: target.port });
      this.scheduleDial(peer.nodeId, 0);
      return peer;
    } catch (e) {
      ch.close();
      throw e;
    }
  }
}
