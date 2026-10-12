/**
 * Device sync in local mode: the sync engine (src/sync) wired to this device's store,
 * its paired peers over Wi-Fi and Bluetooth, and optionally the cloud.
 *
 *   services ─► SyncDataStore (tracks writes) ─► KDB
 *                    │
 *               SyncEngine (role device, records in <dataDir>/sync/meta.json)
 *                    │
 *   LanSyncCoordinator ── TransportSelector ─┬─ LanTransport (TLS, mDNS, pinned peers)
 *     (lower node id initiates, headers first) └─ BleTransport (bridge radio, opt-in)
 *   DeviceSyncClient ── HttpSyncTransport ─► cloud hub (only when signed in)
 *
 * Two steps, because the store is wrapped while the data layer connects (before the
 * server exists) and the network starts after the server listens:
 *   installLocalSync(innerStore)  from connectData(): wrap, open records, baseline, owner
 *   startLocalSync()              from startLocalServer(): transports, coordinator, cloud
 *   stopLocalSync()               on shutdown: stops everything and flushes the records
 *
 * Nothing here is on a request path: writes only mark documents dirty (a map insert)
 * and schedule a debounced round; rounds run in the background.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DataStore, Doc } from '../data/types.js';
import { adoptLocalAccount } from '../sync/adopt.js';
import { DeviceSyncClient, type ClientStatus } from '../sync/client.js';
import { createDefaultDerived } from '../sync/derived.js';
import { SyncEngine } from '../sync/engine.js';
import { FileMetaPersistence, type MemoryMetaStore } from '../sync/meta.js';
import { SyncDataStore } from '../sync/tracker.js';
import { HttpSyncTransport } from '../sync/transport.js';
import type {
  ConflictRecord,
  HelloRequest,
  HelloResponse,
  PullRequest,
  PushRequest,
  SyncResult,
  SyncTransport,
} from '../sync/types.js';
import {
  FileSecretStore,
  LanSyncCoordinator,
  LanTransport,
  PeerStore,
  createSelfSignedCert,
  loadOrCreateIdentity,
  nodeIdFromSpki,
  parsePairLink,
  type DeviceIdentity,
  type DeviceInfo,
  type PairedPeer,
  type SyncServiceLike,
} from '../sync/lan/index.js';
import { BleTransport, parseBlePairLink } from '../sync/ble/transport.js';
import { TransportSelector } from '../sync/ble/selector.js';
import type { PeerLinkTransport, SyncPeerLink } from '../sync/transport-contract.js';
import { createLogger } from '../utils/logger.js';
import { bleRadio } from './ble.js';
import { dataPaths } from './device.js';
import { readJson, writeJsonPrivate } from './files.js';
import { LOCAL_OWNER_ID, LOCAL_USER_EMAIL, installOwnerUser, loadOwner, ownerDecision, saveOwner, type OwnerState } from './owner.js';
import { qrSvg } from './qr.js';

const log = createLogger('local-sync');

export type LinkKind = 'wifi' | 'bluetooth';

export interface SyncEvent {
  at: string;
  kind: 'sync' | 'error' | 'conflict' | 'paired' | 'unpaired' | 'pairing' | 'owner' | 'cloud' | 'bluetooth';
  peerId?: string;
  peerName?: string;
  transport?: LinkKind | 'cloud';
  message: string;
  pulled?: number;
  pushed?: number;
  conflicts?: number;
}

export interface PairingState {
  id: number;
  role: 'inviter' | 'joiner';
  phase: 'waiting' | 'connecting' | 'confirm' | 'paired' | 'failed' | 'cancelled';
  /** Inviter: the `qtask://pair` link with the one-time secret (show as a QR code). */
  link?: string;
  /** Inviter: the same link without the secret, for typing; it pairs only after both confirm the six-digit code. */
  codeLink?: string;
  /** Inviter: `host:port` to type on the other device. */
  address?: string;
  /** Inviter with Bluetooth on: `qtask://pairble` link for pairing with no network. */
  bleLink?: string;
  qrSvg?: string;
  expiresAt?: string;
  /** The six-digit code both screens must show (code flow only). */
  sas?: string;
  peerName?: string;
  peerId?: string;
  error?: string;
}

interface Settings {
  bluetooth?: boolean;
  lanPort?: number;
}

interface CloudConfig {
  hubUrl: string;
  token: string;
  userId: string;
  email?: string;
  savedAt: string;
}

interface PeerRuntime {
  lastResultAt?: string;
  lastTransport?: LinkKind;
  lastError?: string;
  lastErrorAt?: string;
}

const kindOf = (t: SyncPeerLink['transport']): LinkKind => (t === 'ble' ? 'bluetooth' : 'wifi');

/** Time from a local write to the round it triggers. Writes in between join the same round. */
export const WRITE_DEBOUNCE_MS = 400;

function deviceName(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.QTASK_DEVICE_NAME?.trim();
  if (fromEnv) return fromEnv.slice(0, 60);
  return os.hostname().replace(/\.local$/, '').slice(0, 60) || 'Mac';
}

/**
 * The LAN/Bluetooth identity reuses the device's Ed25519 key (device.key), so the sync
 * node id is derived from the same identity the rest of local mode uses. Only the TLS
 * key and certificate are new.
 */
async function loadSyncIdentity(dataDir: string, name: string): Promise<DeviceIdentity> {
  const store = new FileSecretStore(path.join(dataDir, 'sync', 'identity.json'));
  if (!(await store.load())) {
    const signKeyPem = readFileSync(dataPaths(dataDir).deviceKeyFile, 'utf8');
    const spki = createPublicKey(createPrivateKey(signKeyPem)).export({ type: 'spki', format: 'der' });
    const tls = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const cert = createSelfSignedCert(tls.privateKey, `qtask-${nodeIdFromSpki(spki).slice(0, 8)}`);
    await store.save(
      JSON.stringify({
        signKeyPem,
        tlsKeyPem: tls.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        tlsCertPem: cert.pem,
        name,
      })
    );
  }
  return loadOrCreateIdentity(store, name);
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });
}

export class LocalSync {
  readonly dataDir: string;
  readonly syncDir: string;
  readonly env: NodeJS.ProcessEnv;
  identity!: DeviceIdentity;
  peers!: PeerStore;
  meta!: MemoryMetaStore;
  persistence!: FileMetaPersistence;
  tracked!: SyncDataStore;
  engine!: SyncEngine;
  owner: OwnerState;
  lan?: LanTransport;
  ble?: BleTransport;
  selector?: TransportSelector;
  coordinator?: LanSyncCoordinator;
  cloud?: DeviceSyncClient;
  private cloudConfig?: CloudConfig;
  private cloudStatus?: ClientStatus;
  private settings: Settings = {};
  private started = false;
  private bleOn = false;
  /** Bumped whenever remote changes were applied or the owner changed; the UI polls it. */
  revision = 0;
  ownerRevision = 0;
  private waiters: Array<() => void> = [];
  private readonly events: SyncEvent[] = [];
  private readonly peerRuntime = new Map<string, PeerRuntime>();
  private writeTimer?: NodeJS.Timeout;
  private ownerLock: Promise<unknown> = Promise.resolve();
  pairing: PairingState | null = null;
  private pairingSeq = 0;
  private pairingCancel?: () => void;
  private pendingSas?: (ok: boolean) => void;
  /** Rounds completed and their durations, for status and measurements. */
  rounds = 0;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.dataDir = dataDir;
    this.syncDir = path.join(dataDir, 'sync');
    this.env = env;
    this.owner = loadOwner(dataDir);
  }

  get name(): string {
    return this.identity.info.name;
  }

  // --- install: wrap the store -----------------------------------------------------------------

  async install(inner: DataStore): Promise<SyncDataStore> {
    this.identity = await loadSyncIdentity(this.dataDir, deviceName(this.env));
    this.peers = await PeerStore.open(this.identity, this.syncDir);
    this.settings = await readJson<Settings>(path.join(this.syncDir, 'settings.json'), {});
    const opened = await FileMetaPersistence.open(path.join(this.syncDir, 'meta.json'), {
      nodeId: this.identity.info.nodeId,
      debounceMs: 250,
      durable: true,
    });
    this.meta = opened.meta;
    this.persistence = opened.persistence;
    if (this.meta.nodeId !== this.identity.info.nodeId) {
      log.warn('sync records belong to another node id; peers will see this device as new', {
        records: this.meta.nodeId,
        identity: this.identity.info.nodeId,
      });
    }
    this.tracked = new SyncDataStore(inner, this.meta);
    this.engine = new SyncEngine({
      store: this.tracked,
      meta: this.meta,
      role: 'device',
      derived: createDefaultDerived(),
      afterApply: async (touched) => {
        if (touched.length === 0) return;
        this.bump();
        // Relay: what came from a peer goes on to the cloud, and what came from the cloud
        // to the peers. (A peer that pushed to us is relayed to the other peers by the
        // coordinator itself; one extra no-op round with the sender is the cost here.)
        this.cloud?.notifyLocalChange();
        this.scheduleRound();
      },
    });
    const started = Date.now();
    await this.engine.init();
    await this.migrateOwner();
    await this.persistence.flush();
    this.meta.setDirtyListener(() => this.onLocalWrite());
    log.info('sync engine ready', { nodeId: this.engine.nodeId, documents: this.meta.size, ms: Date.now() - started });
    return this.tracked;
  }

  /** Re-owns data left by an earlier local user id (Phase 1 installs used a random one). */
  private async migrateOwner(): Promise<void> {
    const users = this.tracked.collection<Doc>('users');
    const stale = (await users.find({ email: LOCAL_USER_EMAIL })).map((u) => String(u._id)).filter((id) => id !== this.owner.ownerId);
    for (const id of stale) {
      const result = await adoptLocalAccount(this.engine, id, this.owner.ownerId);
      if (result.total > 0) log.info('re-owned local data to the device owner', { from: id, documents: result.total });
    }
    await installOwnerUser(this.tracked, this.owner.ownerId, stale);
  }

  // --- start / stop -----------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const env = this.env;
    let port = this.settings.lanPort ?? 0;
    if (port && !(await portIsFree(port))) port = 0;
    const mdnsPort = env.QTASK_SYNC_MDNS_PORT ? Number(env.QTASK_SYNC_MDNS_PORT) : undefined;
    const mdnsIfaces = env.QTASK_SYNC_MDNS_IFACES?.split(',').map((s) => s.trim()).filter(Boolean);
    const lanOff = env.QTASK_SYNC_LAN === '0';
    const transports: PeerLinkTransport[] = [];
    if (!lanOff) {
      this.lan = new LanTransport({
        identity: this.identity,
        peers: this.peers,
        port,
        // Every interface, so a peer on the Wi-Fi can reach it; only paired certificates get past the handshake.
        host: env.QTASK_SYNC_HOST ?? '0.0.0.0',
        discovery: env.QTASK_SYNC_MDNS === '0' ? false : { port: mdnsPort, interfaces: mdnsIfaces },
        advertiseHost: env.QTASK_SYNC_ADVERTISE_HOST || undefined,
        log: (m) => log.debug(m),
      });
      this.lan.on('security', (e: { reason: string; remote?: string }) => log.info('refused a connection', e));
      transports.push(this.lan);
    }
    const radio = bleRadio();
    if (radio) {
      this.ble = new BleTransport({ identity: this.identity, peers: this.peers, radio, log: (m) => log.debug(m) });
      transports.push(this.ble);
    }
    if (transports.length === 0) return;
    this.selector = new TransportSelector(transports);
    this.coordinator = new LanSyncCoordinator(this.engine, this.selector, {
      headersFirst: true,
      // One initiator per link: the lower node id starts the round when a link comes up.
      shouldInitiate: (link) => this.identity.info.nodeId < link.peerId,
      service: this.service(),
      wrapTransport: (rpc) => this.clientTransport(rpc),
      onResult: (peerId, result) => this.onRoundResult(peerId, result),
      onError: (peerId, error) => this.onRoundError(peerId, error),
    });
    this.coordinator.start();

    if (this.lan) {
      try {
        await this.lan.start();
        if (this.lan.port !== this.settings.lanPort) {
          this.settings.lanPort = this.lan.port;
          await this.saveSettings();
        }
        const known = await readJson<Array<{ nodeId: string; host: string; port: number }>>(path.join(this.syncDir, 'peer-addresses.json'), []);
        for (const a of known) if (this.peers.get(a.nodeId)) this.lan.addManualAddress(a.nodeId, a.host, a.port);
      } catch (error) {
        this.event({ kind: 'error', message: `Wi-Fi sync could not start: ${(error as Error).message}` });
        log.error('LAN transport failed to start', { error: (error as Error).message });
      }
    }
    if (this.ble && (this.settings.bluetooth || env.QTASK_BLE_ENABLE === '1')) await this.setBluetooth(true, false);
    await this.loadCloud();
    log.info('device sync started', { nodeId: this.identity.info.nodeId, lanPort: this.lan?.port, ble: Boolean(this.ble), paired: this.peers.list().length });
  }

  async stop(): Promise<void> {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    this.pairingCancel?.();
    this.coordinator?.stop();
    this.cloud?.stop();
    if (this.lan) await this.saveAddresses().catch(() => undefined);
    await Promise.allSettled([this.lan?.stop(), this.bleOn ? this.ble?.stop() : undefined]);
    this.started = false;
    await this.persistence?.flush();
  }

  async flush(): Promise<void> {
    await this.persistence?.flush();
  }

  // --- the protocol wrappers -------------------------------------------------------------------

  /** Serves peers: exchanges owners in hello, and persists records before telling a peer about them. */
  private service(): SyncServiceLike {
    const base = this.engine.service();
    return {
      hello: async (req: HelloRequest) => {
        await this.reconcileOwner((req as HelloRequest & { owner?: string }).owner);
        return { ...(await base.hello(req)), owner: this.owner.ownerId } as HelloResponse;
      },
      pull: async (req: PullRequest) => {
        const res = await base.pull(req);
        await this.persistence.flushIfChanged();
        return res;
      },
      push: (req: PushRequest) => base.push(req),
    };
  }

  private clientTransport(inner: SyncTransport): SyncTransport {
    return {
      kind: inner.kind,
      hello: async (req) => {
        const res = await inner.hello({ ...req, owner: this.owner.ownerId } as HelloRequest);
        await this.reconcileOwner((res as HelloResponse & { owner?: string }).owner);
        return res;
      },
      pull: (req) => inner.pull(req),
      push: async (req) => {
        await this.persistence.flushIfChanged();
        return inner.push(req);
      },
      close: inner.close ? () => inner.close!() : undefined,
    };
  }

  private async reconcileOwner(theirs: string | undefined): Promise<void> {
    const decision = ownerDecision(this.owner.ownerId, theirs);
    if (decision === 'refuse') throw new Error('the other device is signed in to a different account');
    if (decision === 'adopt') await this.adoptOwner(theirs!, undefined, 'peer');
  }

  /** Re-owns this device's data to `ownerId`. Serialised; a no-op if already the owner. */
  adoptOwner(ownerId: string, account: OwnerState['account'] | undefined, reason: 'peer' | 'cloud'): Promise<void> {
    const run = this.ownerLock.then(async () => {
      const previous = this.owner.ownerId;
      if (previous === ownerId) {
        if (account && !this.owner.account) {
          this.owner = { ...this.owner, account };
          await saveOwner(this.dataDir, this.owner);
        }
        return;
      }
      const result = await adoptLocalAccount(this.engine, previous, ownerId);
      await installOwnerUser(this.tracked, ownerId, [previous]);
      this.owner = { ownerId, ...(account ? { account } : {}) };
      await saveOwner(this.dataDir, this.owner);
      await this.persistence.flush();
      this.ownerRevision += 1;
      this.event({
        kind: 'owner',
        message:
          reason === 'cloud'
            ? `Signed in: ${result.total} item(s) now belong to the account`
            : `Joined the account of a paired device: ${result.total} item(s) re-owned`,
      });
      this.bump();
    });
    this.ownerLock = run.catch(() => undefined);
    return run;
  }

  // --- rounds -----------------------------------------------------------------------------------

  private onLocalWrite(): void {
    this.cloud?.notifyLocalChange();
    this.scheduleRound();
  }

  /** One round with every connected peer, WRITE_DEBOUNCE_MS after the first trigger. */
  private scheduleRound(): void {
    if (!this.coordinator || this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.coordinator?.syncNow().catch(() => undefined);
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref();
  }

  private onRoundResult(peerId: string, result: SyncResult): void {
    this.rounds += 1;
    const link = this.coordinator?.connected().find((c) => c.peerId === peerId);
    const rt = this.runtime(peerId);
    rt.lastResultAt = new Date().toISOString();
    if (link) rt.lastTransport = kindOf(link.transport);
    rt.lastError = undefined;
    void this.persistence.flushIfChanged().catch(() => undefined);
    if (result.pulled || result.pushed || result.conflicts || result.rejected.length) {
      this.event({
        kind: 'sync',
        peerId,
        peerName: this.peers.get(peerId)?.name,
        transport: rt.lastTransport,
        pulled: result.pulled,
        pushed: result.pushed,
        conflicts: result.conflicts,
        message: `Synced with ${this.peers.get(peerId)?.name ?? peerId.slice(0, 8)}: ${result.pulled} in, ${result.pushed} out${result.conflicts ? `, ${result.conflicts} conflict(s)` : ''}`,
      });
    }
  }

  private onRoundError(peerId: string, error: Error): void {
    const rt = this.runtime(peerId);
    rt.lastError = error.message;
    rt.lastErrorAt = new Date().toISOString();
    this.event({ kind: 'error', peerId, peerName: this.peers.get(peerId)?.name, message: error.message });
  }

  private runtime(peerId: string): PeerRuntime {
    let rt = this.peerRuntime.get(peerId);
    if (!rt) {
      rt = {};
      this.peerRuntime.set(peerId, rt);
    }
    return rt;
  }

  /** Sync with every connected peer and the cloud now. Resolves when the rounds finished. */
  async syncNow(): Promise<void> {
    await Promise.allSettled([this.coordinator?.syncNow(), this.cloud?.syncNow()]);
  }

  private bump(): void {
    this.revision += 1;
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves when `revision` moves past `since`, or after `timeoutMs`. */
  waitForRevision(since: number, timeoutMs: number): Promise<void> {
    if (this.revision !== since) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      const waiters = this.waiters;
      function done() {
        clearTimeout(timer);
        const i = waiters.indexOf(done);
        if (i >= 0) waiters.splice(i, 1);
        resolve();
      }
      waiters.push(done);
    });
  }

  private event(e: Omit<SyncEvent, 'at'>): void {
    this.events.push({ at: new Date().toISOString(), ...e });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  // --- pairing ----------------------------------------------------------------------------------

  private newPairing(state: Omit<PairingState, 'id'>): PairingState {
    this.pairingCancel?.();
    this.pairingCancel = undefined;
    this.pendingSas?.(false);
    this.pendingSas = undefined;
    this.pairing = { id: ++this.pairingSeq, ...state };
    return this.pairing;
  }

  /** Asks the user (through the UI) whether both screens show the same six digits. */
  private confirmSas(id: number) {
    return (sas: string, peer: DeviceInfo): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (!this.pairing || this.pairing.id !== id) return resolve(false);
        this.pairing.phase = 'confirm';
        this.pairing.sas = sas;
        this.pairing.peerName = peer.name;
        this.pairing.peerId = peer.nodeId;
        const timer = setTimeout(() => finish(false), 120_000);
        timer.unref();
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          if (this.pendingSas === finish) this.pendingSas = undefined;
          if (this.pairing?.id === id && this.pairing.phase === 'confirm') this.pairing.phase = ok ? 'connecting' : 'failed';
          if (!ok && this.pairing?.id === id) this.pairing.error = 'The codes were not confirmed';
          resolve(ok);
        };
        this.pendingSas = finish;
      });
  }

  private paired(id: number, peer: PairedPeer, via: LinkKind): void {
    this.event({ kind: 'paired', peerId: peer.nodeId, peerName: peer.name, transport: via, message: `Paired with ${peer.name}` });
    if (this.pairing?.id === id) {
      this.pairing.phase = 'paired';
      this.pairing.peerName = peer.name;
      this.pairing.peerId = peer.nodeId;
      this.pairing.sas = undefined;
    }
    void this.saveAddresses().catch(() => undefined);
  }

  private failed(id: number, error: Error): void {
    if (this.pairing?.id !== id || this.pairing.phase === 'paired' || this.pairing.phase === 'cancelled') return;
    this.pairing.phase = 'failed';
    this.pairing.error = error.message;
    this.event({ kind: 'pairing', message: `Pairing failed: ${error.message}` });
  }

  /** Opens a pairing window (2 minutes): a QR link, a typed address with code confirmation, and Bluetooth when on. */
  openPairing(): PairingState {
    if (!this.lan && !(this.ble && this.bleOn)) throw new Error('No sync transport is running');
    const state = this.newPairing({ role: 'inviter', phase: 'waiting' });
    const id = state.id;
    const confirmSas = this.confirmSas(id);
    const cancels: Array<() => void> = [];
    if (this.lan) {
      const inv = this.lan.openPairing({ confirmSas });
      state.link = inv.link;
      state.address = `${inv.parts.host}:${inv.parts.port}`;
      state.codeLink = `qtask://pair?h=${state.address}`;
      state.qrSvg = qrSvg(inv.link);
      state.expiresAt = new Date(inv.expiresAt).toISOString();
      cancels.push(inv.cancel);
      inv.result.then((p) => this.paired(id, p, 'wifi'), (e: Error) => this.failed(id, e));
    }
    if (this.ble && this.bleOn) {
      const inv = this.ble.openPairing({ confirmSas });
      state.bleLink = inv.link;
      if (!state.qrSvg) state.qrSvg = qrSvg(inv.link);
      state.expiresAt ??= new Date(inv.expiresAt).toISOString();
      cancels.push(inv.cancel);
      inv.result.then((p) => this.paired(id, p, 'bluetooth'), (e: Error) => {
        if (!this.lan) this.failed(id, e);
      });
    }
    this.pairingCancel = () => {
      for (const c of cancels) c();
    };
    return state;
  }

  /**
   * Joins a pairing from a link (`qtask://pair?...` from a QR code or pasted, a typed
   * `host:port`, or `qtask://pairble?...`). Returns once it paired, failed, or needs the
   * user to confirm the six-digit code (then POST /pair/confirm), or after `waitMs`.
   */
  async joinPairing(input: string, waitMs = 15_000): Promise<PairingState> {
    const text = input.trim();
    const state = this.newPairing({ role: 'joiner', phase: 'connecting' });
    const id = state.id;
    const confirmSas = this.confirmSas(id);
    let run: Promise<PairedPeer>;
    let via: LinkKind = 'wifi';
    if (text.startsWith('qtask://pairble')) {
      if (!this.ble || !this.bleOn) throw new Error('Turn on Bluetooth sync to pair over Bluetooth');
      if (!parseBlePairLink(text)) throw new Error('Not a QTask Bluetooth pairing link');
      via = 'bluetooth';
      run = this.ble.pairWith({ link: text }, { confirmSas });
    } else {
      if (!this.lan) throw new Error('Wi-Fi sync is not running');
      const link = text.startsWith('qtask://') ? text : /^[A-Za-z0-9.:[\]-]+:\d+$/.test(text) ? `qtask://pair?h=${text}` : text;
      const parts = parsePairLink(link);
      if (!parts) throw new Error('Not a QTask pairing link or address');
      run = this.lan.pairWith(parts, { confirmSas });
    }
    run.then((p) => this.paired(id, p, via), (e: Error) => this.failed(id, e));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && this.pairing?.id === id && this.pairing.phase === 'connecting') {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.pairing!;
  }

  confirmPairing(accept: boolean): PairingState | null {
    if (!this.pendingSas) throw new Error('No pairing code is waiting for confirmation');
    this.pendingSas(accept);
    return this.pairing;
  }

  cancelPairing(): void {
    this.pairingCancel?.();
    this.pairingCancel = undefined;
    this.pendingSas?.(false);
    if (this.pairing && this.pairing.phase !== 'paired') this.pairing.phase = 'cancelled';
  }

  async unpair(nodeId: string): Promise<boolean> {
    const peer = this.peers.get(nodeId);
    const removed = await this.peers.remove(nodeId);
    if (removed) {
      this.peerRuntime.delete(nodeId);
      this.event({ kind: 'unpaired', peerId: nodeId, peerName: peer?.name, message: `Unpaired ${peer?.name ?? nodeId.slice(0, 8)}` });
      await this.saveAddresses();
    }
    return removed;
  }

  private async saveAddresses(): Promise<void> {
    if (!this.lan) return;
    const list = this.lan.knownAddresses().filter((a) => this.peers.get(a.nodeId) && a.host);
    await writeJsonPrivate(path.join(this.syncDir, 'peer-addresses.json'), list);
  }

  /** A manual address for a paired peer (client-isolated Wi-Fi, hotspots). */
  async addAddress(nodeId: string, host: string, port: number): Promise<void> {
    if (!this.lan) throw new Error('Wi-Fi sync is not running');
    if (!this.peers.get(nodeId)) throw new Error('Not a paired device');
    this.lan.addManualAddress(nodeId, host, port);
    await this.saveAddresses();
  }

  // --- Bluetooth --------------------------------------------------------------------------------

  get bluetoothAvailable(): boolean {
    return Boolean(this.ble);
  }

  async setBluetooth(enabled: boolean, persist = true): Promise<void> {
    if (enabled && !this.ble) throw new Error('Bluetooth is not available: the app did not open the Bluetooth bridge');
    if (persist) {
      this.settings.bluetooth = enabled;
      await this.saveSettings();
    }
    if (!this.ble || enabled === this.bleOn) return;
    this.bleOn = enabled;
    if (enabled) await this.ble.start();
    else await this.ble.stop();
    this.event({ kind: 'bluetooth', message: enabled ? 'Bluetooth sync on' : 'Bluetooth sync off' });
  }

  private async saveSettings(): Promise<void> {
    await writeJsonPrivate(path.join(this.syncDir, 'settings.json'), this.settings);
  }

  // --- cloud ------------------------------------------------------------------------------------

  private cloudFile(): string {
    return path.join(this.syncDir, 'cloud.json');
  }

  private async loadCloud(): Promise<void> {
    if (!existsSync(this.cloudFile())) return;
    const cfg = await readJson<CloudConfig | null>(this.cloudFile(), null);
    if (cfg?.hubUrl && cfg.token) this.startCloud(cfg);
  }

  private startCloud(cfg: CloudConfig): void {
    this.cloud?.stop();
    this.cloudConfig = cfg;
    const transport = this.clientTransport(
      new HttpSyncTransport({ baseUrl: cfg.hubUrl, getToken: () => this.cloudConfig?.token })
    );
    this.cloud = new DeviceSyncClient({
      engine: this.engine,
      transport,
      getToken: () => this.cloudConfig?.token,
      debounceMs: 1_000,
      onStatus: (s) => {
        const before = this.cloudStatus?.lastSyncedAt;
        this.cloudStatus = s;
        if (s.lastSyncedAt && s.lastSyncedAt !== before && s.lastResult) {
          void this.persistence.flushIfChanged().catch(() => undefined);
          if (s.lastResult.pulled || s.lastResult.pushed || s.lastResult.conflicts) {
            this.event({
              kind: 'sync',
              transport: 'cloud',
              pulled: s.lastResult.pulled,
              pushed: s.lastResult.pushed,
              conflicts: s.lastResult.conflicts,
              message: `Synced with the cloud: ${s.lastResult.pulled} in, ${s.lastResult.pushed} out`,
            });
          }
        }
      },
    });
    this.cloud.start();
  }

  /**
   * Signs this device in to a cloud hub with an account session token (or e-mail and
   * password, exchanged for one at the hub's /api/auth/login). Adopts the account:
   * local data is re-owned to it, then synced. The token is kept owner-only in the data
   * directory; there is no Keychain storage and no OAuth flow yet (see README).
   */
  async signIn(input: { hubUrl: string; token?: string; email?: string; password?: string }): Promise<{ userId: string; reowned: boolean }> {
    const hubUrl = input.hubUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(hubUrl)) throw new Error('A hub URL (https://...) is required');
    let token = input.token?.trim();
    if (!token) {
      if (!input.email || !input.password) throw new Error('A token, or an e-mail and password, is required');
      const r = await fetch(`${hubUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: input.email, password: input.password }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) throw new Error(r.status === 401 ? 'Wrong e-mail or password' : `The hub answered ${r.status}`);
      token = ((await r.json()) as { token?: string }).token;
      if (!token) throw new Error('The hub did not return a session');
    }
    const probe = new HttpSyncTransport({ baseUrl: hubUrl, getToken: () => token });
    const hello = await probe.hello({ protocol: 1, nodeId: this.engine.nodeId, epoch: this.meta.epoch });
    if (!hello.userId) throw new Error('The hub did not identify the account');
    const decision = ownerDecision(this.owner.ownerId, hello.userId);
    if (decision === 'refuse' || decision === 'keep') {
      throw new Error('This device already belongs to another account; sign out first');
    }
    await this.adoptOwner(hello.userId, { hubUrl, ...(input.email ? { email: input.email } : {}) }, 'cloud');
    const cfg: CloudConfig = { hubUrl, token, userId: hello.userId, email: input.email, savedAt: new Date().toISOString() };
    await writeJsonPrivate(this.cloudFile(), cfg);
    this.startCloud(cfg);
    this.event({ kind: 'cloud', transport: 'cloud', message: `Signed in to ${hubUrl}` });
    // Peers learn the new owner in their next hello.
    void this.syncNow();
    return { userId: hello.userId, reowned: decision === 'adopt' };
  }

  /** Stops cloud sync and forgets the token. The data stays owned by the account. */
  async signOut(): Promise<void> {
    this.cloud?.stop();
    this.cloud = undefined;
    this.cloudConfig = undefined;
    this.cloudStatus = undefined;
    await writeJsonPrivate(this.cloudFile(), null);
    this.event({ kind: 'cloud', transport: 'cloud', message: 'Signed out of the cloud' });
  }

  // --- status -----------------------------------------------------------------------------------

  async conflicts(limit = 50): Promise<Array<Record<string, unknown>>> {
    const docs = await this.tracked
      .collection<Doc>('activities')
      .find({ action: 'sync_conflict' }, { sort: { createdAt: -1 }, limit });
    const out: Array<Record<string, unknown>> = [];
    for (const d of docs) {
      const details = (d.details ?? {}) as { collection?: string; documentId?: string; field?: string } & Pick<ConflictRecord, 'kept' | 'discarded'>;
      let title: string | undefined;
      if (details.collection === 'tasks' || details.collection === 'projects') {
        const target = await this.tracked.collection<Doc>(details.collection).findById(String(details.documentId), { select: details.collection === 'tasks' ? 'title' : 'name' });
        title = (target?.title ?? target?.name) as string | undefined;
      }
      out.push({
        id: String(d._id),
        at: d.createdAt,
        collection: details.collection,
        documentId: details.documentId,
        title,
        field: details.field,
        kept: details.kept?.value,
        discarded: details.discarded?.value,
      });
    }
    return out;
  }

  async status(): Promise<Record<string, unknown>> {
    const engine = await this.engine.status();
    const cursors = new Map(engine.peers.map((p) => [p.peerId, p]));
    const connected = new Map((this.coordinator?.connected() ?? []).map((c) => [c.peerId, kindOf(c.transport)]));
    const standby = new Set((this.selector?.allLinks() ?? []).map((l) => `${l.peerId}:${kindOf(l.transport)}`));
    const peers = this.peers.list().map((p) => {
      const c = cursors.get(p.nodeId);
      const rt = this.peerRuntime.get(p.nodeId);
      return {
        nodeId: p.nodeId,
        name: p.name,
        pairedAt: new Date(p.pairedAt).toISOString(),
        connected: connected.has(p.nodeId),
        transport: connected.get(p.nodeId) ?? null,
        links: (['wifi', 'bluetooth'] as LinkKind[]).filter((k) => standby.has(`${p.nodeId}:${k}`)),
        lastSyncedAt: c?.lastSyncedAt ?? null,
        // Rounds this device started record their link; a device that only served uses the live link.
        lastTransport: rt?.lastTransport ?? connected.get(p.nodeId) ?? null,
        pendingChanges: c ? c.pendingChanges : engine.pendingChanges,
        lastError: rt?.lastError ?? null,
      };
    });
    const cloudPeer = this.cloudStatus?.sync.peers.find((p) => !this.peers.get(p.peerId));
    return {
      enabled: true,
      device: {
        nodeId: this.identity.info.nodeId,
        name: this.identity.info.name,
        ownerId: this.owner.ownerId,
        signedIn: this.owner.ownerId !== LOCAL_OWNER_ID,
        account: this.owner.account ?? null,
      },
      revision: this.revision,
      ownerRevision: this.ownerRevision,
      pendingChanges: engine.pendingChanges,
      lastSyncedAt: engine.lastSyncedAt ?? null,
      documents: engine.documents,
      tombstones: engine.tombstones,
      rounds: this.rounds,
      wifi: this.lan ? { running: true, port: this.lan.port, mdns: this.env.QTASK_SYNC_MDNS !== '0' } : { running: false },
      bluetooth: { available: Boolean(this.ble), enabled: this.bleOn, radio: bleRadio()?.state ?? null },
      peers,
      cloud: this.cloudConfig
        ? {
            hubUrl: this.cloudConfig.hubUrl,
            email: this.cloudConfig.email ?? null,
            state: this.cloudStatus?.state ?? 'idle',
            lastSyncedAt: cloudPeer?.lastSyncedAt ?? null,
            pendingChanges: cloudPeer?.pendingChanges ?? null,
            lastError: this.cloudStatus?.lastError ?? null,
          }
        : null,
      pairing: this.pairing,
      log: [...this.events].reverse().slice(0, 50),
      conflicts: await this.conflicts(),
    };
  }
}

// --- process-wide instance -----------------------------------------------------------------------

let instance: LocalSync | undefined;

export function getLocalSync(): LocalSync | undefined {
  return instance;
}

/** The owner id of this device, when device sync is installed (else the caller falls back). */
export function currentOwnerId(): string | undefined {
  return instance?.owner.ownerId;
}

export function localSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QTASK_LOCAL_SYNC !== '0';
}

export async function installLocalSync(inner: DataStore, dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<DataStore> {
  const sync = new LocalSync(dataDir, env);
  const tracked = await sync.install(inner);
  instance = sync;
  return tracked;
}

export async function startLocalSync(): Promise<void> {
  await instance?.start();
}

export async function stopLocalSync(): Promise<void> {
  await instance?.stop();
}

/** For the data layer's disconnect: flush and forget the instance. */
export async function closeLocalSync(): Promise<void> {
  const s = instance;
  instance = undefined;
  await s?.stop().catch(() => undefined);
}
