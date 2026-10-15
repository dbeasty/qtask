/**
 * Device identity, signed pairing records and the paired-peer store.
 *
 * A device has two keys:
 *  - an Ed25519 *identity* key. `nodeId` = first 16 bytes of SHA-256(SPKI), hex.
 *    It signs pairing records and never touches TLS.
 *  - an ECDSA P-256 *TLS* key with a self-signed certificate. Peers pin the
 *    certificate's SHA-256 fingerprint.
 * The pairing record binds (nodeId, identity key, cert fingerprint) of both devices
 * and is signed by both identity keys, so a record cannot be forged or edited
 * (e.g. to swap in an attacker's certificate) by anyone who lacks a device key.
 *
 * Persistence is behind `SecretStore` so the Mac app can put the private keys in the
 * Keychain; the default is a 0600 JSON file in the data directory.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createSelfSignedCert, fingerprintDer } from './x509.js';

export interface DeviceInfo {
  nodeId: string;
  name: string;
  /** Identity public key, SPKI DER, base64. */
  signPub: string;
  /** SHA-256 of the TLS certificate DER, hex. */
  certFp: string;
}

export interface PairingRecord {
  v: 1;
  ts: number;
  a: DeviceInfo;
  b: DeviceInfo;
  sigA: string;
  sigB: string;
}

export interface DeviceIdentity {
  info: DeviceInfo;
  signKey: KeyObject;
  tlsKeyPem: string;
  tlsCertPem: string;
  tlsCertDer: Buffer;
}

export interface SecretStore {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly path: string) {}
  async load(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async save(data: string): Promise<void> {
    const dir = this.path.slice(0, Math.max(this.path.lastIndexOf('/'), 0)) || '.';
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function nodeIdFromSpki(spki: Uint8Array): string {
  return createHash('sha256').update(spki).digest('hex').slice(0, 32);
}

export async function loadOrCreateIdentity(store: SecretStore, name: string): Promise<DeviceIdentity> {
  const raw = await store.load();
  if (raw) {
    const j = JSON.parse(raw) as { signKeyPem: string; tlsKeyPem: string; tlsCertPem: string; name?: string };
    const signKey = createPrivateKey(j.signKeyPem);
    const spki = createPublicKey(signKey).export({ type: 'spki', format: 'der' });
    const certDer = pemToDer(j.tlsCertPem);
    return {
      info: {
        nodeId: nodeIdFromSpki(spki),
        name: name || j.name || 'device',
        signPub: spki.toString('base64'),
        certFp: fingerprintDer(certDer),
      },
      signKey,
      tlsKeyPem: j.tlsKeyPem,
      tlsCertPem: j.tlsCertPem,
      tlsCertDer: certDer,
    };
  }
  const sig = generateKeyPairSync('ed25519');
  const tls = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = sig.publicKey.export({ type: 'spki', format: 'der' });
  const nodeId = nodeIdFromSpki(spki);
  const cert = createSelfSignedCert(tls.privateKey, `qtask-${nodeId.slice(0, 8)}`);
  const tlsKeyPem = tls.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signKeyPem = sig.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await store.save(JSON.stringify({ signKeyPem, tlsKeyPem, tlsCertPem: cert.pem, name }));
  return {
    info: { nodeId, name, signPub: spki.toString('base64'), certFp: cert.fingerprint },
    signKey: sig.privateKey,
    tlsKeyPem,
    tlsCertPem: cert.pem,
    tlsCertDer: cert.der,
  };
}

function pemToDer(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

// --- pairing records --------------------------------------------------------------------

function recordBody(r: Pick<PairingRecord, 'v' | 'ts' | 'a' | 'b'>): Buffer {
  return Buffer.from(canonicalJson({ v: r.v, ts: r.ts, a: r.a, b: r.b }), 'utf8');
}

export function signRecordBody(id: DeviceIdentity, body: Pick<PairingRecord, 'v' | 'ts' | 'a' | 'b'>): string {
  return sign(null, recordBody(body), id.signKey).toString('base64');
}

function verifySig(signPubB64: string, body: Buffer, sigB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(signPubB64, 'base64'), format: 'der', type: 'spki' });
    return verify(null, body, key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

/** Structural + cryptographic validation of a device description. */
export function validateInfo(i: DeviceInfo): boolean {
  try {
    return (
      typeof i.name === 'string' &&
      i.name.length <= 100 &&
      /^[0-9a-f]{64}$/.test(i.certFp) &&
      /^[0-9a-f]{32}$/.test(i.nodeId) &&
      nodeIdFromSpki(Buffer.from(i.signPub, 'base64')) === i.nodeId
    );
  } catch {
    return false;
  }
}

export function verifyRecord(r: PairingRecord): boolean {
  if (r.v !== 1 || !validateInfo(r.a) || !validateInfo(r.b) || r.a.nodeId === r.b.nodeId) return false;
  const body = recordBody(r);
  return verifySig(r.a.signPub, body, r.sigA) && verifySig(r.b.signPub, body, r.sigB);
}

export interface PairedPeer {
  nodeId: string;
  name: string;
  certFp: string;
  signPub: string;
  pairedAt: number;
  record: PairingRecord;
}

/** Persistent set of paired peers. Everything loaded is re-verified; tampered entries are dropped. */
export class PeerStore {
  private peers = new Map<string, PairedPeer>();
  private constructor(
    private readonly self: DeviceIdentity,
    private readonly path: string | null,
  ) {}

  static async open(self: DeviceIdentity, dir: string | null): Promise<PeerStore> {
    const s = new PeerStore(self, dir ? join(dir, 'paired-peers.json') : null);
    if (s.path) {
      try {
        const list = JSON.parse(await readFile(s.path, 'utf8')) as PairingRecord[];
        for (const rec of list) s.ingest(rec);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    return s;
  }

  /** Validates a record that involves this device and returns the peer entry, or null. */
  private ingest(rec: PairingRecord): PairedPeer | null {
    if (!verifyRecord(rec)) return null;
    const me = this.self.info.nodeId;
    const other = rec.a.nodeId === me ? rec.b : rec.b.nodeId === me ? rec.a : null;
    const mine = rec.a.nodeId === me ? rec.a : rec.b;
    if (!other || mine.certFp !== this.self.info.certFp) return null;
    const p: PairedPeer = {
      nodeId: other.nodeId,
      name: other.name,
      certFp: other.certFp,
      signPub: other.signPub,
      pairedAt: rec.ts,
      record: rec,
    };
    this.peers.set(p.nodeId, p);
    return p;
  }

  async add(rec: PairingRecord): Promise<PairedPeer> {
    const p = this.ingest(rec);
    if (!p) throw new Error('invalid pairing record');
    await this.persist();
    this.notify();
    return p;
  }

  async remove(nodeId: string): Promise<boolean> {
    const had = this.peers.delete(nodeId);
    if (had) {
      await this.persist();
      this.notify();
    }
    return had;
  }

  private listeners: Array<() => void> = [];
  /** Called after a peer was added or removed, by whichever transport did it. */
  onChange(h: () => void): void {
    this.listeners.push(h);
  }
  private notify(): void {
    for (const h of this.listeners) h();
  }

  get(nodeId: string): PairedPeer | undefined {
    return this.peers.get(nodeId);
  }
  byCertFp(fp: string): PairedPeer | undefined {
    for (const p of this.peers.values()) if (p.certFp === fp) return p;
    return undefined;
  }
  list(): PairedPeer[] {
    return [...this.peers.values()];
  }

  private async persist(): Promise<void> {
    if (!this.path) return;
    await new FileSecretStore(this.path).save(JSON.stringify(this.list().map((p) => p.record)));
  }
}
