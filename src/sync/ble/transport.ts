/**
 * Bluetooth LE sync transport: a `PeerLinkTransport` over the tunnel in tunnel.ts.
 *
 * Roles. Every device advertises the QTask service (peripheral role) and scans for it
 * (central role). Whichever side connects first is the GATT central for that link; if
 * both connect at once, both keep the link opened by the lower node id (the same rule the
 * LAN transport uses) and close the other.
 *
 * Discovery and reconnection. Advertisements carry only the service UUID. After
 * connecting, the central reads `info` (the peer's node id and a key tag) and drops
 * anything that is not a paired peer before the tunnel handshake. Device addresses
 * rotate, so a peer is always identified by `info.nodeId`, never by address:
 *   1. after a link drops, retry the remembered device id with backoff (works when the
 *      peer is merely back in range, and is cheap: no scan);
 *   2. scan whenever some paired peer has no link, and connect to any new device the scan
 *      reports; a rotated address is found this way. Scanning stops when every paired
 *      peer is connected (battery).
 *
 * Only the tunnel's authenticated, encrypted bytes reach the FramedChannel
 * (src/sync/framing.ts), which provides messages, deflate and credit flow control; the
 * sync engine speaks to the link through `LinkRpc` exactly as it does over Wi-Fi.
 */

import { EventEmitter } from 'node:events';
import { FramedChannel, type FramedChannelOptions } from '../framing.js';
import type { PairedPeer, PairingRecord, DeviceIdentity, DeviceInfo, PeerStore } from '../lan/identity.js';
import type { PeerLinkTransport, SyncPeerLink } from '../transport-contract.js';
import {
  decodeInfo,
  encodeInfo,
  realTimers,
  type BleInfo,
  type BleRadio,
  type CentralLink,
  type Discovery,
  type PeripheralLink,
  type Timers,
} from './radio.js';
import {
  acceptTunnel,
  initiateTunnel,
  keyTagOf,
  pairAsInviter,
  pairAsJoiner,
  readFirstRecord,
  RecordPipe,
  type SecureTunnel,
  type TunnelContext,
  type TunnelSecurityEvent,
} from './tunnel.js';
import { randomBytes } from 'node:crypto';

/** Defaults for the FramedChannel over BLE: small frames, small window (a slow radio, not a socket). */
export const BLE_CHANNEL_DEFAULTS: Omit<FramedChannelOptions, 'write'> = {
  maxFramePayload: 2048,
  window: 48 * 1024,
  highWater: 512 * 1024,
  compressThreshold: 128,
};

export interface BleTransportOptions {
  identity: DeviceIdentity;
  peers: PeerStore;
  radio: BleRadio;
  timers?: Timers;
  channel?: Omit<FramedChannelOptions, 'write'>;
  /** Give up on one connection attempt after this long (CoreBluetooth never does by itself). */
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  backoff?: { minMs?: number; maxMs?: number };
  /** Ping a quiet link this often; a link silent for 3x this is closed. 0 disables. */
  keepAliveMs?: number;
  /** Restart the scan this often while a paired peer is missing (OS scans report each device once per session). */
  rescanMs?: number;
  /** A higher node id waits this long before dialing a device it knows, so the lower id connects first. */
  higherIdDelayMs?: number;
  /** After reading a device that is not a paired peer, leave it alone for this long. */
  unpairedIgnoreMs?: number;
  /** Unauthenticated inbound connections allowed at once. */
  maxPreAuth?: number;
  log?: (msg: string) => void;
}

export interface BlePairingInvitation {
  /** `qtask://pairble?...`, for a QR code. */
  link: string;
  parts: { id: string; secret: string };
  expiresAt: number;
  result: Promise<PairedPeer>;
  cancel(): void;
}

export interface OpenBlePairingOptions {
  timeoutMs?: number;
  /** Accept joiners that did not scan the QR, after both users confirm the same 6 digits. */
  confirmSas?: (sas: string, peer: DeviceInfo) => Promise<boolean>;
  maxFailures?: number;
}

export interface PairableDevice {
  deviceId: string;
  nodeId: string;
  name?: string;
}

export function formatBlePairLink(l: { id: string; secret: string }): string {
  return `qtask://pairble?id=${l.id}&s=${l.secret}`;
}
export function parseBlePairLink(url: string): { id: string; secret: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'qtask:' || u.hostname !== 'pairble') return null;
  const id = u.searchParams.get('id');
  const secret = u.searchParams.get('s');
  if (!id || !/^[0-9a-f]{32}$/.test(id) || !secret || !/^[A-Za-z0-9_-]{16,64}$/.test(secret)) return null;
  return { id, secret };
}

export type BleSecurityEvent = TunnelSecurityEvent;

export interface BleWireStats {
  /** Bytes handed to / received from the radio (after encryption, framing and record headers). */
  airBytesOut: number;
  airBytesIn: number;
  chunksOut: number;
  chunksIn: number;
  /** Framed bytes before encryption (what FramedChannel wrote / read). */
  frameBytesOut: number;
  frameBytesIn: number;
  creditStalls: number;
  messagesOut: number;
  messagesIn: number;
}

class BleLink implements SyncPeerLink {
  readonly transport = 'ble' as const;
  private msgHandler: ((m: Uint8Array) => void | Promise<void>) | null = null;
  private closeHandlers: Array<(e?: Error) => void> = [];
  private early: Buffer[] = [];
  private closedFlag = false;
  private keep: unknown = null;
  lastHeard: number;
  readonly channel: FramedChannel;

  constructor(
    readonly peerId: string,
    readonly peerName: string,
    readonly initiatorId: string,
    readonly tunnel: SecureTunnel,
    /** Device id on our radio, when we were the central. */
    readonly deviceId: string | null,
    channelOpts: Omit<FramedChannelOptions, 'write'>,
    private readonly timers: Timers,
    keepAliveMs: number,
  ) {
    this.lastHeard = timers.now();
    const ch = new FramedChannel({ ...channelOpts, write: (b) => tunnel.send(b) });
    this.channel = ch;
    tunnel.onData((plain) => {
      this.lastHeard = timers.now();
      ch.receive(plain);
    });
    ch.onMessage((m) => {
      if (this.msgHandler) return this.msgHandler(m);
      this.early.push(m);
    });
    ch.onClose = (e) => {
      tunnel.close();
      this.finish(e);
    };
    tunnel.onClose((e) => {
      ch.closeAfterDelivery(e);
    });
    if (keepAliveMs > 0) this.armKeepAlive(keepAliveMs);
  }

  private armKeepAlive(ms: number): void {
    this.keep = this.timers.setTimeout(() => {
      if (this.closedFlag) return;
      if (this.timers.now() - this.lastHeard > ms * 3) {
        this.channel.close(new Error('link idle'));
        return;
      }
      this.channel.sendPing().catch(() => undefined);
      this.armKeepAlive(ms);
    }, ms);
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
    if (this.keep) this.timers.clearTimeout(this.keep);
    for (const h of this.closeHandlers) h(e);
  }
}

interface Reconnect {
  attempts: number;
  timer: unknown;
  deviceId: string | null;
}

interface PairingWindow {
  secret: Buffer;
  confirmSas?: OpenBlePairingOptions['confirmSas'];
  failures: number;
  maxFailures: number;
  busy: boolean;
  resolve: (p: PairedPeer) => void;
  reject: (e: Error) => void;
  timer: unknown;
}

interface Locator {
  match: (info: BleInfo) => boolean;
  found: (link: CentralLink, info: BleInfo, deviceId: string) => void;
  timer: unknown;
  fail: (e: Error) => void;
}

export class BleTransport extends EventEmitter implements PeerLinkTransport {
  readonly kind = 'ble' as const;
  private readonly timers: Timers;
  private readonly radio: BleRadio;
  private readonly log: (m: string) => void;
  private upHandlers: Array<(l: SyncPeerLink) => void> = [];
  private downHandlers: Array<(id: string, e?: Error) => void> = [];
  private live = new Map<string, BleLink>();
  private reconnect = new Map<string, Reconnect>();
  /** device id -> node id, learned by reading `info`. Ids rotate, so this is only a hint. */
  private byDevice = new Map<string, string>();
  private ignore = new Map<string, number>();
  private queued = new Set<string>();
  private queue: string[] = [];
  private draining = false;
  private suppressed = new Set<string>();
  private preAuth = 0;
  private pairing: PairingWindow | null = null;
  private locator: Locator | null = null;
  private started = false;
  private scanning = false;
  private rescanTimer: unknown = null;
  private totals: BleWireStats = zeroStats();
  private readonly ctx: TunnelContext;

  constructor(private readonly o: BleTransportOptions) {
    super();
    this.timers = o.timers ?? realTimers;
    this.radio = o.radio;
    this.log = o.log ?? (() => undefined);
    this.ctx = {
      identity: o.identity,
      peers: o.peers,
      timers: this.timers,
      handshakeTimeoutMs: o.handshakeTimeoutMs,
      onSecurity: (e) => this.emit('security', e satisfies BleSecurityEvent),
      allow: (id) => !this.suppressed.has(id),
    };
    // A device paired over Wi-Fi (or unpaired) changes who we look for.
    o.peers.onChange(() => {
      for (const [id, l] of [...this.live]) if (!o.peers.get(id)) l.close();
      this.updateScan();
    });
  }

  get self(): DeviceInfo {
    return this.o.identity.info;
  }

  onPeerUp(h: (l: SyncPeerLink) => void): void {
    this.upHandlers.push(h);
    for (const l of this.live.values()) h(l);
  }
  onPeerDown(h: (id: string, e?: Error) => void): void {
    this.downHandlers.push(h);
  }
  links(): SyncPeerLink[] {
    return [...this.live.values()];
  }

  wireStats(): BleWireStats {
    const t = { ...this.totals };
    for (const l of this.live.values()) addStats(t, linkStats(l));
    return t;
  }

  // --- lifecycle ---------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.radio.onIncoming((l) => void this.onIncoming(l));
    this.radio.onDiscovered((d) => this.onDiscovered(d));
    this.radio.onState((s) => {
      if (!this.started) return;
      if (s === 'on') {
        void this.radio.startAdvertising(this.infoBytes()).then(() => this.updateScan());
      } else {
        this.scanning = false;
      }
    });
    if (this.radio.state === 'on') {
      await this.radio.startAdvertising(this.infoBytes());
      this.updateScan();
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.pairing) this.closePairing(this.pairing, new Error('transport stopped'));
    if (this.locator) this.endLocator(new Error('transport stopped'));
    if (this.rescanTimer) this.timers.clearTimeout(this.rescanTimer);
    for (const r of this.reconnect.values()) if (r.timer) this.timers.clearTimeout(r.timer);
    this.reconnect.clear();
    await this.radio.stopScan().catch(() => undefined);
    await this.radio.stopAdvertising().catch(() => undefined);
    this.scanning = false;
    for (const l of [...this.live.values()]) l.close();
  }

  /**
   * Standby control for TransportSelector: while suppressed we neither dial nor accept
   * this peer, and an existing link is closed. Un-suppressing reconnects lazily.
   */
  suppress(peerId: string, on: boolean): void {
    if (on) {
      this.suppressed.add(peerId);
      this.live.get(peerId)?.close();
      const r = this.reconnect.get(peerId);
      if (r?.timer) this.timers.clearTimeout(r.timer);
      this.reconnect.delete(peerId);
    } else if (this.suppressed.delete(peerId)) {
      this.scheduleDirect(peerId, 0);
    }
    this.updateScan();
  }

  private infoBytes(): Buffer {
    const me = this.o.identity.info;
    return encodeInfo({ nodeId: me.nodeId, keyTag: keyTagOf(me.signPub), pairing: !!this.pairing, name: me.name });
  }

  private refreshInfo(): void {
    if (this.started) void this.radio.setInfo(this.infoBytes()).catch(() => undefined);
  }

  // --- scanning policy ------------------------------------------------------------------------------

  private wantsPeers(): boolean {
    if (this.locator) return true;
    for (const p of this.o.peers.list()) if (!this.live.has(p.nodeId) && !this.suppressed.has(p.nodeId)) return true;
    return false;
  }

  /** Scans only while something is missing: no point burning battery when every peer is connected. */
  private updateScan(): void {
    if (!this.started || this.radio.state !== 'on') return;
    const want = this.wantsPeers();
    if (want && !this.scanning) {
      this.scanning = true;
      void this.radio.startScan().catch(() => undefined);
      this.armRescan();
    } else if (!want && this.scanning) {
      this.scanning = false;
      void this.radio.stopScan().catch(() => undefined);
      if (this.rescanTimer) this.timers.clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
  }

  private armRescan(): void {
    if (this.rescanTimer) this.timers.clearTimeout(this.rescanTimer);
    this.rescanTimer = this.timers.setTimeout(() => {
      this.rescanTimer = null;
      if (!this.started || !this.scanning) return;
      // A new scan session reports every device in range again, including one that came back.
      void this.radio
        .stopScan()
        .then(() => this.radio.startScan())
        .catch(() => undefined);
      this.armRescan();
    }, this.o.rescanMs ?? 8000);
  }

  private onDiscovered(d: Discovery): void {
    if (!this.started) return;
    if (this.scanHook) {
      this.scanHook(d);
      return;
    }
    const until = this.ignore.get(d.deviceId);
    if (until !== undefined && until > this.timers.now()) return;
    if (this.locator) {
      this.enqueue(d.deviceId);
      return;
    }
    const known = this.byDevice.get(d.deviceId);
    if (known && (this.live.has(known) || this.suppressed.has(known))) return;
    if (!this.wantsPeers()) return;
    this.enqueue(d.deviceId);
  }

  // --- outbound -----------------------------------------------------------------------------------

  private enqueue(deviceId: string): void {
    if (this.queued.has(deviceId)) return;
    this.queued.add(deviceId);
    // Two devices that see each other at the same moment would both connect. A short random
    // pause (and a longer one for the higher node id when we know whom the device is) makes
    // one side win; if both still connect, `register` keeps the lower initiator's link.
    const known = this.byDevice.get(deviceId);
    const delay = Math.random() * 300 + (known && this.self.nodeId > known ? this.o.higherIdDelayMs ?? 1500 : 0);
    this.timers.setTimeout(() => {
      this.queue.push(deviceId);
      void this.drain();
    }, delay);
  }

  /** One outbound connection at a time: connection setup is the radio's scarcest operation. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && this.started) {
        const id = this.queue.shift()!;
        this.queued.delete(id);
        const peerId = this.byDevice.get(id);
        if (!this.locator && peerId && (this.live.has(peerId) || this.suppressed.has(peerId))) continue;
        try {
          await this.tryDevice(id);
        } catch (e) {
          this.log(`connect ${id} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async tryDevice(deviceId: string): Promise<void> {
    const cap = this.o.connectTimeoutMs ?? 10_000;
    let link: CentralLink;
    try {
      link = await this.radio.connect(deviceId, cap);
    } catch (e) {
      const peerId = this.byDevice.get(deviceId);
      if (peerId) this.directFailed(peerId, deviceId, e as Error);
      throw e;
    }
    let info: BleInfo | null;
    try {
      const raw = await this.withTimeout(link.readInfo(), cap, 'read info');
      info = decodeInfo(raw);
    } catch (e) {
      link.close();
      throw e;
    }
    if (!info) {
      link.close();
      this.ignore.set(deviceId, this.timers.now() + (this.o.unpairedIgnoreMs ?? 120_000));
      return;
    }
    if (this.locator?.match(info) && !this.live.has(info.nodeId)) {
      this.byDevice.set(deviceId, info.nodeId);
      const loc = this.locator;
      this.endLocator();
      loc.found(link, info, deviceId);
      return;
    }
    const peer = this.o.peers.get(info.nodeId);
    if (!peer) {
      // Not ours (or not paired yet). Nothing is sent; remember so a rescan does not reconnect.
      link.close();
      this.ignore.set(deviceId, this.timers.now() + (this.o.unpairedIgnoreMs ?? 120_000));
      return;
    }
    this.byDevice.set(deviceId, peer.nodeId);
    if (info.keyTag !== keyTagOf(peer.signPub)) {
      this.emit('security', { reason: 'key-tag-mismatch', detail: peer.nodeId.slice(0, 8) } satisfies BleSecurityEvent);
      link.close();
      return;
    }
    if (this.live.has(peer.nodeId) || this.suppressed.has(peer.nodeId)) {
      link.close();
      return;
    }
    const pipe = new RecordPipe(link, this.timers);
    let tunnel: SecureTunnel;
    try {
      tunnel = await initiateTunnel(pipe, this.ctx, peer);
    } catch (e) {
      this.directFailed(peer.nodeId, deviceId, e as Error);
      throw e;
    }
    this.register(this.makeLink(tunnel, peer, this.self.nodeId, deviceId));
  }

  private makeLink(tunnel: SecureTunnel, peer: PairedPeer, initiatorId: string, deviceId: string | null): BleLink {
    return new BleLink(
      peer.nodeId,
      peer.name,
      initiatorId,
      tunnel,
      deviceId,
      { ...BLE_CHANNEL_DEFAULTS, ...this.o.channel },
      this.timers,
      this.o.keepAliveMs ?? 20_000,
    );
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = this.timers.setTimeout(() => reject(new Error(`${what} timed out`)), ms);
      p.then(
        (v) => (this.timers.clearTimeout(t), resolve(v)),
        (e) => (this.timers.clearTimeout(t), reject(e)),
      );
    });
  }

  // --- reconnection ---------------------------------------------------------------------------------

  private backoff(attempts: number): number {
    const min = this.o.backoff?.minMs ?? 1000;
    const max = this.o.backoff?.maxMs ?? 30_000;
    const base = Math.min(max, min * 2 ** Math.min(attempts, 16));
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  private scheduleDirect(peerId: string, delayMs: number): void {
    if (!this.started || this.live.has(peerId) || this.suppressed.has(peerId) || !this.o.peers.get(peerId)) return;
    const r = this.reconnect.get(peerId) ?? { attempts: 0, timer: null, deviceId: null };
    this.reconnect.set(peerId, r);
    if (!r.deviceId) return; // never connected out to it: the scan will find it
    if (r.timer) this.timers.clearTimeout(r.timer);
    r.timer = this.timers.setTimeout(() => {
      r.timer = null;
      if (!r.deviceId || this.live.has(peerId) || !this.started) return;
      this.enqueue(r.deviceId);
    }, delayMs);
    this.updateScan();
  }

  private directFailed(peerId: string, deviceId: string, e: Error): void {
    const r = this.reconnect.get(peerId);
    if (!r) return;
    r.attempts++;
    if (/unknown device/.test(e.message)) {
      // The address rotated. Let the scan find the new one.
      r.deviceId = null;
      this.byDevice.delete(deviceId);
      return;
    }
    this.scheduleDirect(peerId, this.backoff(r.attempts));
  }

  // --- registration ---------------------------------------------------------------------------------

  private register(link: BleLink): void {
    const existing = this.live.get(link.peerId);
    if (existing && !existing.closed) {
      const keepNew = link.initiatorId < existing.initiatorId;
      if (!keepNew) {
        this.log(`duplicate link from ${link.peerId.slice(0, 8)} dropped`);
        link.close();
        return;
      }
      this.live.delete(link.peerId);
      addStats(this.totals, linkStats(existing));
      existing.close();
    }
    this.live.set(link.peerId, link);
    const r = this.reconnect.get(link.peerId) ?? { attempts: 0, timer: null, deviceId: null };
    this.reconnect.set(link.peerId, r);
    r.attempts = 0;
    if (r.timer) this.timers.clearTimeout(r.timer);
    r.timer = null;
    if (link.deviceId) r.deviceId = link.deviceId;
    link.onClose((e) => {
      if (this.live.get(link.peerId) === link) {
        this.live.delete(link.peerId);
        addStats(this.totals, linkStats(link));
        for (const h of this.downHandlers) h(link.peerId, e);
        this.scheduleDirect(link.peerId, this.backoff(0));
        this.updateScan();
      }
    });
    this.updateScan();
    this.log(`peer up ${link.peerId.slice(0, 8)}`);
    for (const h of this.upHandlers) h(link);
  }

  // --- inbound ----------------------------------------------------------------------------------------

  private async onIncoming(link: PeripheralLink): Promise<void> {
    if (this.preAuth >= (this.o.maxPreAuth ?? 4)) {
      link.close();
      return;
    }
    this.preAuth++;
    let counted = true;
    const release = () => {
      if (counted) {
        counted = false;
        this.preAuth--;
      }
    };
    const pipe = new RecordPipe(link, this.timers);
    try {
      const first = await readFirstRecord(pipe, this.ctx);
      if (first.kind === 'hello') {
        const tunnel = await acceptTunnel(pipe, this.ctx, first.rec);
        release();
        this.register(this.makeLink(tunnel, tunnel.peer, tunnel.initiatorId, null));
        return;
      }
      const w = this.pairing;
      if (!w || w.busy) {
        this.emit('security', { reason: 'pairing-closed' } satisfies BleSecurityEvent);
        pipe.close();
        return;
      }
      w.busy = true;
      try {
        const peer = await pairAsInviter(pipe, this.ctx, first.rec, w);
        w.busy = false;
        this.closePairing(w);
        this.onPaired(peer);
        w.resolve(peer);
      } catch (e) {
        w.busy = false;
        w.failures++;
        this.log(`pairing attempt failed: ${(e as Error).message}`);
        this.emit('security', { reason: 'pairing-failed', detail: (e as Error).message } satisfies BleSecurityEvent);
        if (w.failures >= w.maxFailures) {
          this.closePairing(w);
          w.reject(new Error('too many failed pairing attempts'));
        }
      }
    } catch {
      /* the pipe has already failed and the link is closed */
    } finally {
      release();
    }
  }

  // --- pairing ----------------------------------------------------------------------------------------

  private onPaired(peer: PairedPeer): void {
    this.log(`paired with ${peer.nodeId.slice(0, 8)}`);
    this.refreshInfo();
    this.updateScan();
  }

  openPairing(opts: OpenBlePairingOptions = {}): BlePairingInvitation {
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
      timer: this.timers.setTimeout(() => {
        this.closePairing(w);
        reject(new Error('pairing window expired'));
      }, timeoutMs),
    };
    this.pairing = w;
    this.refreshInfo();
    const parts = { id: this.self.nodeId, secret: secret.toString('base64url') };
    return {
      link: formatBlePairLink(parts),
      parts,
      expiresAt: this.timers.now() + timeoutMs,
      result,
      cancel: () => {
        this.closePairing(w);
        reject(new Error('pairing cancelled'));
      },
    };
  }

  private closePairing(w: PairingWindow, err?: Error): void {
    this.timers.clearTimeout(w.timer);
    if (this.pairing === w) {
      this.pairing = null;
      this.refreshInfo();
    }
    if (err) w.reject(err);
  }

  /** Scans and reads `info` of what is nearby; returns devices that have a pairing window open. */
  async findPairable(scanMs = 5000): Promise<PairableDevice[]> {
    const found: PairableDevice[] = [];
    const seen = new Set<string>();
    const handler = (d: Discovery) => {
      if (seen.has(d.deviceId)) return;
      seen.add(d.deviceId);
      void (async () => {
        try {
          const link = await this.radio.connect(d.deviceId, this.o.connectTimeoutMs ?? 10_000);
          const info = decodeInfo(await link.readInfo());
          link.close();
          if (info?.pairing) found.push({ deviceId: d.deviceId, nodeId: info.nodeId, name: info.name });
        } catch {
          /* unreachable device */
        }
      })();
    };
    const prev = this.scanHook;
    this.scanHook = handler;
    this.scanning = true;
    await this.radio.startScan();
    await new Promise<void>((r) => this.timers.setTimeout(r, scanMs));
    this.scanHook = prev;
    this.scanning = false;
    await this.radio.stopScan();
    this.updateScan();
    return found;
  }
  private scanHook: ((d: Discovery) => void) | null = null;

  /**
   * Joins a pairing window on a nearby device. With a `qtask://pairble` code it finds the
   * device by node id and proves it saw the QR; with a device from `findPairable()` it
   * needs `confirmSas`, and both users must see the same 6 digits.
   */
  async pairWith(
    target: { link: string } | { deviceId: string },
    opts: { confirmSas?: (sas: string, peer: DeviceInfo) => Promise<boolean>; timeoutMs?: number } = {},
  ): Promise<PairedPeer> {
    const timeout = opts.timeoutMs ?? 30_000;
    let link: CentralLink;
    let info: BleInfo;
    let join: { nodeId?: string; secret?: Buffer } = {};
    if ('link' in target) {
      const parsed = parseBlePairLink(target.link);
      if (!parsed) throw new Error('not a QTask Bluetooth pairing code');
      join = { nodeId: parsed.id, secret: Buffer.from(parsed.secret, 'base64url') };
      const f = await this.locate((i) => i.nodeId === parsed.id, timeout);
      link = f.link;
      info = f.info;
    } else {
      link = await this.radio.connect(target.deviceId, this.o.connectTimeoutMs ?? 10_000);
      const i = decodeInfo(await link.readInfo());
      if (!i) {
        link.close();
        throw new Error('not a QTask device');
      }
      info = i;
    }
    if (!info.pairing) {
      link.close();
      throw new Error('that device is not in pairing mode');
    }
    const pipe = new RecordPipe(link, this.timers);
    const peer = await pairAsJoiner(pipe, this.ctx, join, opts.confirmSas);
    this.onPaired(peer);
    return peer;
  }

  private locate(match: (i: BleInfo) => boolean, timeoutMs: number): Promise<{ link: CentralLink; info: BleInfo }> {
    if (this.locator) throw new Error('already looking for a device');
    return new Promise((resolve, reject) => {
      const l: Locator = {
        match,
        found: (link, info) => resolve({ link, info }),
        fail: reject,
        timer: this.timers.setTimeout(() => this.endLocator(new Error('device not found nearby')), timeoutMs),
      };
      this.locator = l;
      this.scanning = false;
      this.updateScan();
      // restart so that devices already seen in this session are reported again
      void this.radio.stopScan().then(() => this.radio.startScan());
      this.scanning = true;
    });
  }

  private endLocator(err?: Error): void {
    const l = this.locator;
    if (!l) return;
    this.locator = null;
    this.timers.clearTimeout(l.timer);
    if (err) l.fail(err);
    this.updateScan();
  }
}

function zeroStats(): BleWireStats {
  return {
    airBytesOut: 0,
    airBytesIn: 0,
    chunksOut: 0,
    chunksIn: 0,
    frameBytesOut: 0,
    frameBytesIn: 0,
    creditStalls: 0,
    messagesOut: 0,
    messagesIn: 0,
  };
}

function linkStats(l: BleLink): BleWireStats {
  const p = l.tunnel.pipe.stats;
  const c = l.channel.stats;
  return {
    airBytesOut: p.airBytesOut,
    airBytesIn: p.airBytesIn,
    chunksOut: p.chunksOut,
    chunksIn: p.chunksIn,
    frameBytesOut: c.bytesOut,
    frameBytesIn: c.bytesIn,
    creditStalls: c.creditStalls,
    messagesOut: c.messagesOut,
    messagesIn: c.messagesIn,
  };
}

function addStats(into: BleWireStats, add: BleWireStats): void {
  for (const k of Object.keys(add) as Array<keyof BleWireStats>) into[k] += add[k];
}

export type { PairingRecord };
