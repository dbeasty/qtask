/**
 * The Bluetooth tunnel: authentication and encryption over a plain, unpaired GATT link.
 *
 * Why it exists: BLE links are opened with no OS pairing (no system dialog, no stable
 * address), so the link itself carries no security. Everything here is built on node:crypto
 * only and keyed from what the two devices already share, the signed pairing records in
 * `PeerStore` (src/sync/lan/identity.ts).
 *
 * Layers, bottom to top:
 *   GATT chunks (<= MTU-3, in order)  ->  records  ->  AEAD (this file)  ->  FramedChannel
 *
 * A record is `varint(length) | type (1) | body`. The tunnel is the record layer plus the
 * handshakes; the FramedChannel (src/sync/framing.ts) above it provides messages,
 * deflate and credit flow control and is unaware of Bluetooth.
 *
 * Handshake between paired devices (SIGMA-like: ephemeral X25519, identity signatures):
 *
 *   I -> R  HELLO    0x01 | v | I.nodeId (16) | R.nodeId (16) | eI (32)
 *   R -> I  WELCOME  0x02 | eR (32) | sigR (64)      sigR = Ed25519(R.id, label "R" | TH)
 *   I -> R  AUTH     0x03 | seal(k_i2r, ctr 0, sigI)  sigI = Ed25519(I.id, label "I" | TH)
 *   R -> I  READY    0x04 | seal(k_r2i, ctr 0, TH)
 *
 *   TH = SHA-256("qtask-ble-v1" | HELLO | eR);  shared = X25519(eI, eR)
 *   k_i2r, k_r2i, SAS = HKDF-SHA-256(shared, salt = TH, info = label)
 *   data  0x10 | ChaCha20-Poly1305(k_dir, nonce = 0^4 | counter(8, BE), aad = 0x10)
 *
 * Properties and limits:
 *  - The responder drops an unpaired initiator on the HELLO, silently, before sending a
 *    byte and long before any application data exists. A wrong-key initiator fails at
 *    AUTH. Neither side accepts a data record before both signatures verified.
 *  - Both identity signatures cover both ephemerals and both node ids, so a man in the
 *    middle cannot splice sessions, and a session cannot be redirected to another device
 *    (R.nodeId is in HELLO). Fresh ephemerals per session mean nothing replays across
 *    sessions; ephemeral keys give forward secrecy against later key theft.
 *  - Counters are implicit (not on the wire): a replayed, reordered, dropped, truncated or
 *    modified record fails authentication, and any failure ends the tunnel. The link is
 *    ordered, so nothing legitimate ever arrives out of order.
 *  - NOT hidden: the two node ids in HELLO and the responder's `info` are readable by any
 *    radio in range. A stable device identifier on the air is a tracking vector; it is
 *    the price of reconnecting by instance id because addresses rotate. Documented limit.
 *
 * First-time pairing runs in the same tunnel layer on a PRE-AUTH channel (`pairAsInviter`
 * / `pairAsJoiner`): anonymous X25519, then the very dialogue the LAN uses (QR secret MAC
 * or 6-digit SAS), bound to the session by a value derived from the DH secret instead of
 * the TLS exporter, ending in the same two-signature `PairingRecord`.
 */

import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { decodeVarint, encodeVarint, FramingError } from '../framing.js';
import {
  signRecordBody,
  validateInfo,
  verifyRecord,
  type DeviceIdentity,
  type DeviceInfo,
  type PairedPeer,
  type PairingRecord,
  type PeerStore,
} from '../lan/identity.js';
import { pairMac, pairSas, pairTranscript } from '../lan/pairing-crypto.js';
import { writeChunked, type GattLink, type Timers } from './radio.js';

export const TUNNEL_VERSION = 1;

export const T_HELLO = 0x01;
export const T_WELCOME = 0x02;
export const T_AUTH = 0x03;
export const T_READY = 0x04;
export const T_PAIR_HELLO = 0x06;
export const T_PAIR_WELCOME = 0x07;
export const T_SEALED = 0x10;

/** Largest record body accepted from the air. Frames are far smaller; this bounds memory per link. */
export const MAX_RECORD = 64 * 1024;
const TAG = 16;

export type TunnelErrorCode =
  | 'protocol'
  | 'unpaired'
  | 'misdirected'
  | 'bad-signature'
  | 'auth-failed'
  | 'timeout'
  | 'closed'
  | 'pairing';

export class TunnelError extends Error {
  constructor(
    message: string,
    readonly code: TunnelErrorCode,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

export interface TunnelSecurityEvent {
  reason:
    | 'unpaired-central'
    | 'misdirected'
    | 'bad-handshake'
    | 'bad-signature'
    | 'record-rejected'
    | 'pairing-closed'
    | 'pairing-failed'
    | 'key-tag-mismatch';
  detail?: string;
}

// --- records ------------------------------------------------------------------------------------

/**
 * Incremental record parser over the chunk stream. Throws FramingError on a malformed
 * length (zero, or above `maxBody`). Feed it any slicing of the stream.
 */
export class RecordDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly maxBody = MAX_RECORD) {}

  push(chunk: Uint8Array): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: Buffer[] = [];
    let off = 0;
    for (;;) {
      const v = decodeVarint(this.buf, off);
      if (!v) break;
      const [len, n] = v;
      if (len < 1) throw new FramingError('empty record');
      if (len > this.maxBody) throw new FramingError(`record too large: ${len}`);
      if (this.buf.length - off - n < len) break;
      out.push(Buffer.from(this.buf.subarray(off + n, off + n + len)));
      off += n + len;
    }
    this.buf = off ? Buffer.from(this.buf.subarray(off)) : this.buf;
    return out;
  }

  /** Bytes of an incomplete record held back (0 between records). */
  pending(): number {
    return this.buf.length;
  }
}

export interface RecordPipeOptions {
  maxRecord?: number;
  /** A record that starts but makes no progress for this long ends the link (truncation, stalled radio). */
  stallMs?: number;
}

/**
 * Records over a GATT link: serialised writes (records never interleave on the air),
 * chunking to the link's MTU with the radio's backpressure, and an ordered inbox.
 */
export class RecordPipe {
  readonly stats = { recordsIn: 0, recordsOut: 0, airBytesIn: 0, airBytesOut: 0, chunksIn: 0, chunksOut: 0 };
  private readonly decoder: RecordDecoder;
  private readonly queue: Buffer[] = [];
  private waiters: Array<{ res: (b: Buffer) => void; rej: (e: Error) => void; t: unknown }> = [];
  private handler: ((rec: Buffer) => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closeHandlers: Array<(e?: Error) => void> = [];
  private stallTimer: unknown = null;
  private closedErr: Error | null = null;

  constructor(
    readonly link: GattLink,
    private readonly timers: Timers,
    private readonly o: RecordPipeOptions = {},
  ) {
    this.decoder = new RecordDecoder(o.maxRecord ?? MAX_RECORD);
    link.onData((c) => this.onChunk(c));
    link.onClose((e) => this.fail(e ?? new TunnelError('link closed', 'closed')));
  }

  get closed(): boolean {
    return this.closedErr !== null;
  }

  private onChunk(chunk: Uint8Array): void {
    if (this.closedErr) return;
    this.stats.chunksIn++;
    this.stats.airBytesIn += chunk.length;
    let recs: Buffer[];
    try {
      recs = this.decoder.push(chunk);
    } catch (e) {
      this.fail(new TunnelError((e as Error).message, 'protocol'));
      return;
    }
    for (const r of recs) {
      this.stats.recordsIn++;
      if (this.handler) this.handler(r);
      else {
        const w = this.waiters.shift();
        if (w) {
          this.timers.clearTimeout(w.t);
          w.res(r);
        } else this.queue.push(r);
      }
      if (this.closedErr) return;
    }
    this.armStall();
  }

  private armStall(): void {
    if (this.stallTimer) this.timers.clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (this.decoder.pending() === 0) return;
    this.stallTimer = this.timers.setTimeout(() => {
      this.stallTimer = null;
      this.fail(new TunnelError('record stalled (truncated?)', 'timeout'));
    }, this.o.stallMs ?? 15_000);
  }

  /** Next record, for the strictly sequential handshakes. */
  next(timeoutMs: number): Promise<Buffer> {
    const r = this.queue.shift();
    if (r) return Promise.resolve(r);
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise((res, rej) => {
      const w = {
        res,
        rej,
        t: this.timers.setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          rej(new TunnelError('handshake timeout', 'timeout'));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  /** Switches to push delivery; records already queued are delivered first. */
  setHandler(h: (rec: Buffer) => void): void {
    this.handler = h;
    for (const r of this.queue.splice(0)) h(r);
  }

  onClose(h: (e?: Error) => void): void {
    if (this.closedErr) h(this.closedErr);
    else this.closeHandlers.push(h);
  }

  /** `build` runs inside the write lock, so anything stateful (a nonce counter) is ordered with the wire. */
  sendWith(build: () => Buffer): Promise<void> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    const p = this.chain.then(async () => {
      if (this.closedErr) throw this.closedErr;
      const body = build();
      const rec = Buffer.concat([encodeVarint(body.length), body]);
      this.stats.recordsOut++;
      try {
        this.stats.chunksOut += await writeChunked(this.link, rec, () => this.closed);
      } catch (e) {
        this.fail(e as Error);
        throw this.closedErr ?? e;
      }
      this.stats.airBytesOut += rec.length;
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  send(body: Buffer): Promise<void> {
    return this.sendWith(() => body);
  }

  fail(err: Error): void {
    if (this.closedErr) return;
    this.closedErr = err;
    if (this.stallTimer) this.timers.clearTimeout(this.stallTimer);
    for (const w of this.waiters.splice(0)) {
      this.timers.clearTimeout(w.t);
      w.rej(err);
    }
    try {
      this.link.close();
    } catch {
      /* already closed */
    }
    for (const h of this.closeHandlers.splice(0)) h(err);
  }

  close(): void {
    this.fail(new TunnelError('closed', 'closed'));
  }
}

// --- AEAD ---------------------------------------------------------------------------------------

/** One direction of a session: a key and a strictly increasing 64-bit counter used as the nonce. */
export class AeadDirection {
  private ctr = 0n;
  constructor(private readonly key: Buffer) {}

  get counter(): bigint {
    return this.ctr;
  }

  private nonce(): Buffer {
    if (this.ctr >= 0xffffffffffffffffn) throw new TunnelError('nonce space exhausted', 'protocol');
    const n = Buffer.alloc(12);
    n.writeBigUInt64BE(this.ctr, 4);
    return n;
  }

  seal(type: number, plain: Uint8Array): Buffer {
    const c = createCipheriv('chacha20-poly1305', this.key, this.nonce(), { authTagLength: TAG });
    c.setAAD(Buffer.from([type]), { plaintextLength: plain.length });
    const ct = Buffer.concat([c.update(plain), c.final()]);
    this.ctr++;
    return Buffer.concat([ct, c.getAuthTag()]);
  }

  /** Throws TunnelError('auth-failed') for a modified, replayed, reordered, dropped or truncated record. */
  open(type: number, sealed: Uint8Array): Buffer {
    if (sealed.length < TAG) throw new TunnelError('record too short', 'auth-failed');
    const buf = Buffer.from(sealed);
    try {
      const d = createDecipheriv('chacha20-poly1305', this.key, this.nonce(), { authTagLength: TAG });
      d.setAAD(Buffer.from([type]), { plaintextLength: buf.length - TAG });
      d.setAuthTag(buf.subarray(buf.length - TAG));
      const plain = Buffer.concat([d.update(buf.subarray(0, buf.length - TAG)), d.final()]);
      this.ctr++;
      return plain;
    } catch {
      throw new TunnelError('record failed authentication', 'auth-failed');
    }
  }
}

// --- key agreement ------------------------------------------------------------------------------

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function x25519Public(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

interface Ephemeral {
  priv: KeyObject;
  pub: Buffer;
}

function newEphemeral(): Ephemeral {
  const k = generateKeyPairSync('x25519');
  return { priv: k.privateKey, pub: k.publicKey.export({ type: 'spki', format: 'der' }).subarray(12) };
}

function dh(mine: Ephemeral, theirPub: Buffer): Buffer {
  if (theirPub.length !== 32) throw new TunnelError('bad public key', 'protocol');
  const out = diffieHellman({ privateKey: mine.priv, publicKey: x25519Public(theirPub) });
  if (out.every((b) => b === 0)) throw new TunnelError('degenerate shared secret', 'protocol');
  return out;
}

function sha256(...parts: Array<string | Uint8Array>): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function kdf(shared: Buffer, salt: Buffer, label: string, n = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, salt, `qtask-ble-v1 ${label}`, n));
}

function sasFrom(shared: Buffer, th: Buffer): string {
  return String(kdf(shared, th, 'sas', 4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function signLabelled(id: DeviceIdentity, role: 'I' | 'R', th: Buffer): Buffer {
  return sign(null, Buffer.concat([Buffer.from(`qtask-ble-v1 sig ${role}`), th]), id.signKey);
}

function verifyLabelled(signPubB64: string, role: 'I' | 'R', th: Buffer, sig: Buffer): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(signPubB64, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(`qtask-ble-v1 sig ${role}`), th]), key, sig);
  } catch {
    return false;
  }
}

// --- the established tunnel --------------------------------------------------------------------

export class SecureTunnel {
  private dataHandler: ((plain: Buffer) => void) | null = null;
  private early: Buffer[] = [];
  constructor(
    readonly pipe: RecordPipe,
    readonly peer: PairedPeer,
    /** Who opened the connection (the GATT central). */
    readonly initiatorId: string,
    /** Six digits both devices derive; both screens may show them. */
    readonly sas: string,
    private readonly out: AeadDirection,
    private readonly inn: AeadDirection,
    private readonly onSecurity: (e: TunnelSecurityEvent) => void,
  ) {
    pipe.setHandler((rec) => this.onRecord(rec));
  }

  private onRecord(rec: Buffer): void {
    if (rec[0] !== T_SEALED) {
      this.onSecurity({ reason: 'record-rejected', detail: 'unexpected record type' });
      this.pipe.fail(new TunnelError('unexpected record type', 'protocol'));
      return;
    }
    let plain: Buffer;
    try {
      plain = this.inn.open(T_SEALED, rec.subarray(1));
    } catch (e) {
      this.onSecurity({ reason: 'record-rejected', detail: (e as Error).message });
      this.pipe.fail(e as Error);
      return;
    }
    if (this.dataHandler) this.dataHandler(plain);
    else this.early.push(plain);
  }

  /** Whole plaintext chunks of the framed stream, in order. */
  onData(h: (plain: Buffer) => void): void {
    this.dataHandler = h;
    for (const p of this.early.splice(0)) h(p);
  }

  send(plain: Uint8Array): Promise<void> {
    return this.pipe.sendWith(() => Buffer.concat([Buffer.from([T_SEALED]), this.out.seal(T_SEALED, plain)]));
  }

  onClose(h: (e?: Error) => void): void {
    this.pipe.onClose(h);
  }
  close(): void {
    this.pipe.close();
  }
  get closed(): boolean {
    return this.pipe.closed;
  }
}

export interface TunnelContext {
  identity: DeviceIdentity;
  peers: PeerStore;
  timers: Timers;
  handshakeTimeoutMs?: number;
  onSecurity?: (e: TunnelSecurityEvent) => void;
  /** Extra gate on top of being paired (standby suppression). A refused initiator is dropped silently. */
  allow?: (nodeId: string) => boolean;
}

const sec = (c: TunnelContext) => c.onSecurity ?? (() => undefined);

/** Central side. `expected` comes from the `info` the peripheral advertised and must be a paired peer. */
export async function initiateTunnel(pipe: RecordPipe, ctx: TunnelContext, expected: PairedPeer): Promise<SecureTunnel> {
  const timeout = ctx.handshakeTimeoutMs ?? 10_000;
  try {
    const me = ctx.identity.info.nodeId;
    const eI = newEphemeral();
    const hello = Buffer.concat([
      Buffer.from([T_HELLO, TUNNEL_VERSION]),
      Buffer.from(me, 'hex'),
      Buffer.from(expected.nodeId, 'hex'),
      eI.pub,
    ]);
    await pipe.send(hello);
    const w = await pipe.next(timeout);
    if (w.length !== 1 + 32 + 64 || w[0] !== T_WELCOME) throw new TunnelError('bad WELCOME', 'protocol');
    const eRpub = w.subarray(1, 33);
    const th = sha256('qtask-ble-v1', hello, eRpub);
    if (!verifyLabelled(expected.signPub, 'R', th, w.subarray(33))) {
      sec(ctx)({ reason: 'bad-signature', detail: 'responder' });
      throw new TunnelError('responder signature invalid', 'bad-signature');
    }
    const shared = dh(eI, eRpub);
    const out = new AeadDirection(kdf(shared, th, 'i2r'));
    const inn = new AeadDirection(kdf(shared, th, 'r2i'));
    await pipe.sendWith(() => Buffer.concat([Buffer.from([T_AUTH]), out.seal(T_AUTH, signLabelled(ctx.identity, 'I', th))]));
    const r = await pipe.next(timeout);
    if (r[0] !== T_READY) throw new TunnelError('expected READY', 'protocol');
    const confirm = inn.open(T_READY, r.subarray(1));
    if (!eq(confirm, th)) throw new TunnelError('key confirmation failed', 'auth-failed');
    return new SecureTunnel(pipe, expected, me, sasFrom(shared, th), out, inn, sec(ctx));
  } catch (e) {
    pipe.fail(e as Error);
    throw e;
  }
}

export type FirstRecord = { kind: 'hello'; rec: Buffer } | { kind: 'pair-hello'; rec: Buffer };

/** Peripheral side: reads the first record of a new connection and says which dialogue it starts. */
export async function readFirstRecord(pipe: RecordPipe, ctx: TunnelContext): Promise<FirstRecord> {
  try {
    const rec = await pipe.next(ctx.handshakeTimeoutMs ?? 10_000);
    if (rec[0] === T_HELLO) return { kind: 'hello', rec };
    if (rec[0] === T_PAIR_HELLO) return { kind: 'pair-hello', rec };
    sec(ctx)({ reason: 'bad-handshake', detail: 'unknown first record' });
    throw new TunnelError('unknown first record', 'protocol');
  } catch (e) {
    pipe.fail(e as Error);
    throw e;
  }
}

/**
 * Peripheral side, normal handshake. An initiator that is not a paired peer, or that
 * addresses another device, is dropped without a single byte sent back.
 */
export async function acceptTunnel(pipe: RecordPipe, ctx: TunnelContext, hello: Buffer): Promise<SecureTunnel> {
  const timeout = ctx.handshakeTimeoutMs ?? 10_000;
  try {
    if (hello.length !== 2 + 16 + 16 + 32 || hello[1] !== TUNNEL_VERSION) {
      sec(ctx)({ reason: 'bad-handshake', detail: 'malformed HELLO' });
      throw new TunnelError('malformed HELLO', 'protocol');
    }
    const initiatorId = hello.subarray(2, 18).toString('hex');
    const target = hello.subarray(18, 34).toString('hex');
    const peer = ctx.peers.get(initiatorId);
    if (!peer) {
      sec(ctx)({ reason: 'unpaired-central', detail: initiatorId.slice(0, 8) });
      throw new TunnelError('initiator is not paired', 'unpaired');
    }
    if (ctx.allow && !ctx.allow(initiatorId)) throw new TunnelError('peer suppressed', 'unpaired');
    if (target !== ctx.identity.info.nodeId) {
      sec(ctx)({ reason: 'misdirected' });
      throw new TunnelError('HELLO addressed to another device', 'misdirected');
    }
    const eR = newEphemeral();
    const th = sha256('qtask-ble-v1', hello, eR.pub);
    const shared = dh(eR, hello.subarray(34, 66));
    const inn = new AeadDirection(kdf(shared, th, 'i2r'));
    const out = new AeadDirection(kdf(shared, th, 'r2i'));
    await pipe.send(Buffer.concat([Buffer.from([T_WELCOME]), eR.pub, signLabelled(ctx.identity, 'R', th)]));
    const a = await pipe.next(timeout);
    if (a[0] !== T_AUTH) throw new TunnelError('expected AUTH', 'protocol');
    let sig: Buffer;
    try {
      sig = inn.open(T_AUTH, a.subarray(1));
    } catch {
      sec(ctx)({ reason: 'bad-handshake', detail: 'AUTH did not open' });
      throw new TunnelError('AUTH did not open', 'auth-failed');
    }
    if (!verifyLabelled(peer.signPub, 'I', th, sig)) {
      sec(ctx)({ reason: 'bad-signature', detail: 'initiator' });
      throw new TunnelError('initiator signature invalid', 'bad-signature');
    }
    await pipe.sendWith(() => Buffer.concat([Buffer.from([T_READY]), out.seal(T_READY, th)]));
    return new SecureTunnel(pipe, peer, initiatorId, sasFrom(shared, th), out, inn, sec(ctx));
  } catch (e) {
    pipe.fail(e as Error);
    throw e;
  }
}

// --- first-time pairing over the pre-auth channel -----------------------------------------------

export interface PairingWindowLike {
  secret: Buffer;
  confirmSas?: (sas: string, peer: DeviceInfo) => Promise<boolean>;
}

/** Sequential JSON dialogue inside the anonymous sealed session. */
class PairDialogue {
  constructor(
    private readonly pipe: RecordPipe,
    private readonly out: AeadDirection,
    private readonly inn: AeadDirection,
  ) {}
  send(o: unknown): Promise<void> {
    const plain = Buffer.from(JSON.stringify(o));
    return this.pipe.sendWith(() => Buffer.concat([Buffer.from([T_SEALED]), this.out.seal(T_SEALED, plain)]));
  }
  async next<T>(timeoutMs: number): Promise<T> {
    const rec = await this.pipe.next(timeoutMs);
    if (rec[0] !== T_SEALED) throw new TunnelError('unexpected record in pairing', 'pairing');
    const plain = this.inn.open(T_SEALED, rec.subarray(1));
    try {
      return JSON.parse(plain.toString('utf8')) as T;
    } catch {
      throw new TunnelError('bad pairing message', 'pairing');
    }
  }
}

const PAIR_MODE_QR = 1;
const PAIR_MODE_SAS = 2;
const PAIR_STEP_MS = 120_000;

function pairKeys(shared: Buffer, th: Buffer, role: 'joiner' | 'inviter') {
  const j2i = new AeadDirection(kdf(shared, th, 'pair j2i'));
  const i2j = new AeadDirection(kdf(shared, th, 'pair i2j'));
  return { out: role === 'joiner' ? j2i : i2j, inn: role === 'joiner' ? i2j : j2i, exporter: kdf(shared, th, 'pair exporter') };
}

/** Peripheral side of pairing (the device showing the QR code / accepting the code). */
export async function pairAsInviter(
  pipe: RecordPipe,
  ctx: TunnelContext,
  hello: Buffer,
  w: PairingWindowLike,
): Promise<PairedPeer> {
  const timeout = ctx.handshakeTimeoutMs ?? 10_000;
  const me = ctx.identity;
  try {
    if (hello.length !== 1 + 1 + 32 + 1 || hello[1] !== TUNNEL_VERSION) throw new TunnelError('malformed PAIR_HELLO', 'protocol');
    const mode = hello[34];
    if (mode !== PAIR_MODE_QR && mode !== PAIR_MODE_SAS) throw new TunnelError('bad pairing mode', 'pairing');
    if (mode === PAIR_MODE_SAS && !w.confirmSas) throw new TunnelError('code pairing is not enabled', 'pairing');
    const eI = newEphemeral();
    const th = sha256('qtask-ble-pair-v1', hello, eI.pub);
    const shared = dh(eI, hello.subarray(2, 34));
    const k = pairKeys(shared, th, 'inviter');
    await pipe.send(Buffer.concat([Buffer.from([T_PAIR_WELCOME]), eI.pub]));
    const d = new PairDialogue(pipe, k.out, k.inn);

    const jh = await d.next<{ t: string; info: DeviceInfo; nonce: string }>(timeout);
    if (jh.t !== 'hello' || !validateInfo(jh.info)) throw new TunnelError('bad pairing hello', 'pairing');
    if (jh.info.nodeId === me.info.nodeId) throw new TunnelError('cannot pair with self', 'pairing');
    const ni = randomBytes(16).toString('hex');
    const ts = ctx.timers.now();
    await d.send({ t: 'hello', info: me.info, nonce: ni, ts });
    const T = pairTranscript(me.info, jh.info, ni, String(jh.nonce), ts, k.exporter);
    if (mode === PAIR_MODE_QR) {
      const a = await d.next<{ t: string; mac: string }>(timeout);
      const want = pairMac(w.secret, 'J', T);
      if (a.t !== 'auth' || typeof a.mac !== 'string' || !eq(Buffer.from(a.mac), Buffer.from(want))) {
        throw new TunnelError('bad pairing secret', 'pairing');
      }
      await d.send({ t: 'auth', mac: pairMac(w.secret, 'I', T) });
    } else {
      const ok = await w.confirmSas!(pairSas(T), jh.info);
      if (!ok) throw new TunnelError('pairing rejected by user', 'pairing');
      const c = await d.next<{ t: string; ok: boolean }>(PAIR_STEP_MS);
      if (c.t !== 'confirm' || c.ok !== true) throw new TunnelError('pairing rejected by peer', 'pairing');
      await d.send({ t: 'confirm', ok: true });
    }
    const body = { v: 1 as const, ts, a: me.info, b: jh.info };
    const sigA = signRecordBody(me, body);
    await d.send({ t: 'sig', sig: sigA });
    const s = await d.next<{ t: string; sig: string }>(timeout);
    const rec: PairingRecord = { ...body, sigA, sigB: String(s.sig) };
    if (s.t !== 'sig' || !verifyRecord(rec)) throw new TunnelError('bad pairing signature', 'pairing');
    const peer = await ctx.peers.add(rec);
    await d.send({ t: 'done' });
    // The joiner hangs up once it has the final message: closing here could cut it off in the air.
    ctx.timers.setTimeout(() => pipe.close(), 3000);
    return peer;
  } catch (e) {
    pipe.fail(e as Error);
    throw e;
  }
}

export interface JoinTarget {
  /** From a `qtask://pairble` code: pins who we expect and proves we saw the QR. */
  nodeId?: string;
  secret?: Buffer;
}

/** Central side of pairing (the device that scanned the QR code or picked the device from a list). */
export async function pairAsJoiner(
  pipe: RecordPipe,
  ctx: TunnelContext,
  target: JoinTarget,
  confirmSas?: (sas: string, peer: DeviceInfo) => Promise<boolean>,
): Promise<PairedPeer> {
  const timeout = ctx.handshakeTimeoutMs ?? 10_000;
  const me = ctx.identity;
  const qr = !!target.secret;
  try {
    if (!qr && !confirmSas) throw new TunnelError('confirmSas is required without a QR invitation', 'pairing');
    const eJ = newEphemeral();
    const hello = Buffer.concat([Buffer.from([T_PAIR_HELLO, TUNNEL_VERSION]), eJ.pub, Buffer.from([qr ? PAIR_MODE_QR : PAIR_MODE_SAS])]);
    await pipe.send(hello);
    const wl = await pipe.next(timeout);
    if (wl.length !== 33 || wl[0] !== T_PAIR_WELCOME) throw new TunnelError('bad PAIR_WELCOME', 'protocol');
    const th = sha256('qtask-ble-pair-v1', hello, wl.subarray(1));
    const shared = dh(eJ, wl.subarray(1));
    const k = pairKeys(shared, th, 'joiner');
    const d = new PairDialogue(pipe, k.out, k.inn);

    const nj = randomBytes(16).toString('hex');
    await d.send({ t: 'hello', info: me.info, nonce: nj });
    const ih = await d.next<{ t: string; info: DeviceInfo; nonce: string; ts: number }>(timeout);
    if (ih.t !== 'hello' || !validateInfo(ih.info) || typeof ih.ts !== 'number') throw new TunnelError('bad pairing hello', 'pairing');
    if (target.nodeId && ih.info.nodeId !== target.nodeId) throw new TunnelError('inviter id does not match the QR code', 'pairing');
    const T = pairTranscript(ih.info, me.info, String(ih.nonce), nj, ih.ts, k.exporter);
    if (qr) {
      await d.send({ t: 'auth', mac: pairMac(target.secret!, 'J', T) });
      const a = await d.next<{ t: string; mac: string }>(timeout);
      if (a.t !== 'auth' || typeof a.mac !== 'string' || !eq(Buffer.from(a.mac), Buffer.from(pairMac(target.secret!, 'I', T)))) {
        throw new TunnelError('inviter failed authentication', 'pairing');
      }
    } else {
      const ok = await confirmSas!(pairSas(T), ih.info);
      await d.send({ t: 'confirm', ok });
      if (!ok) throw new TunnelError('pairing rejected by user', 'pairing');
      const c = await d.next<{ t: string; ok: boolean }>(PAIR_STEP_MS);
      if (c.t !== 'confirm' || c.ok !== true) throw new TunnelError('pairing rejected by peer', 'pairing');
    }
    const body = { v: 1 as const, ts: ih.ts, a: ih.info, b: me.info };
    const s = await d.next<{ t: string; sig: string }>(timeout);
    const sigB = signRecordBody(me, body);
    const rec: PairingRecord = { ...body, sigA: String(s.sig), sigB };
    if (s.t !== 'sig' || !verifyRecord(rec)) throw new TunnelError('bad pairing signature', 'pairing');
    await d.send({ t: 'sig', sig: sigB });
    const done = await d.next<{ t: string }>(timeout);
    if (done.t !== 'done') throw new TunnelError('inviter did not confirm', 'pairing');
    const peer = await ctx.peers.add(rec);
    pipe.close();
    return peer;
  } catch (e) {
    pipe.fail(e as Error);
    throw e;
  }
}

/** Short fingerprint of an identity key for `info.keyTag`. */
export function keyTagOf(signPubB64: string): string {
  return sha256('qtask-ble-info', Buffer.from(signPubB64, 'base64')).subarray(0, 8).toString('hex');
}
