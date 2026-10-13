/**
 * A standalone "device" process for the multi-process LAN e2e and perf runs.
 * Controlled over Node IPC (child_process.fork). One process = one device with its
 * own data directory, identity, LAN transport and an in-memory LWW replica.
 */

import tls from 'node:tls';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  FileSecretStore,
  LanTransport,
  PeerStore,
  loadOrCreateIdentity,
  parsePairLink,
  type DeviceIdentity,
} from '../../src/sync/lan/index.ts';
import { LwwReplica } from './lww-store.ts';

type Req = { id: number; cmd: string; args?: any };

let identity: DeviceIdentity;
let transport: LanTransport;
let replica: LwwReplica;
let dataDir = '';
const upAt = new Map<string, bigint>();
const appliedAt = new Map<string, bigint>();
let pairingResult: Promise<unknown> | null = null;

function digest(): string {
  const h = createHash('sha256');
  for (const id of [...replica.docs.keys()].sort()) {
    const d = replica.docs.get(id)!;
    h.update(id).update(d.hlc);
  }
  return h.digest('hex');
}

const handlers: Record<string, (a: any) => Promise<unknown> | unknown> = {
  async init(a: { dir: string; name: string; discoveryPort?: number; backoffMs?: [number, number] }) {
    dataDir = a.dir;
    identity = await loadOrCreateIdentity(new FileSecretStore(join(a.dir, 'identity.json')), a.name);
    const peers = await PeerStore.open(identity, a.dir);
    transport = new LanTransport({
      identity,
      peers,
      host: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      discovery: a.discoveryPort ? { port: a.discoveryPort, interfaces: ['127.0.0.1'] } : false,
      backoff: { minMs: a.backoffMs?.[0] ?? 100, maxMs: a.backoffMs?.[1] ?? 1000 },
    });
    transport.on('security', (e) => process.send!({ event: 'security', e }));
    replica = new LwwReplica(identity.info.nodeId, transport);
    replica.onApplied = (doc) => appliedAt.set(doc.id, process.hrtime.bigint());
    transport.onPeerUp((l) => upAt.set(l.peerId, process.hrtime.bigint()));
    await transport.start();
    return { nodeId: identity.info.nodeId, port: transport.port, certFp: identity.info.certFp, pid: process.pid };
  },
  openPairing() {
    const inv = transport.openPairing();
    pairingResult = inv.result.then((p) => ({ nodeId: p.nodeId }));
    return { link: inv.link };
  },
  async awaitPairing() {
    return pairingResult;
  },
  async pairWith(a: { link: string }) {
    const p = await transport.pairWith(parsePairLink(a.link)!);
    return { nodeId: p.nodeId };
  },
  peers() {
    return transport.links().map((l) => l.peerId);
  },
  put(a: { id: string; value: unknown }) {
    const t = process.hrtime.bigint();
    replica.put(a.id, a.value);
    return { t: t.toString() };
  },
  seed(a: { n: number; prefix: string; bytes: number; random?: boolean }) {
    const same = 'x'.repeat(Math.max(0, a.bytes));
    const filler = () => (a.random ? randomBytes(Math.ceil((a.bytes * 3) / 4)).toString('base64').slice(0, a.bytes) : same);
    replica.seed(a.n, a.prefix, (i) => ({ title: `Task ${i}`, notes: filler(), n: i, tags: ['a', 'b'], done: i % 7 === 0 }));
    return replica.docs.size;
  },
  get(a: { id: string }) {
    return replica.docs.get(a.id) ?? null;
  },
  count() {
    return replica.docs.size;
  },
  digest() {
    return { count: replica.docs.size, digest: digest() };
  },
  /** Resolves with performance.now()-relative timing once `id` shows up (or immediately if present). */
  async waitDoc(a: { id: string; timeoutMs?: number }) {
    const end = Date.now() + (a.timeoutMs ?? 10_000);
    while (!replica.docs.has(a.id)) {
      if (Date.now() > end) throw new Error(`timeout waiting for ${a.id}`);
      await new Promise((r) => setTimeout(r, 1));
    }
    return { appliedAt: appliedAt.get(a.id)?.toString() ?? null };
  },
  async waitCount(a: { n: number; timeoutMs?: number }) {
    const end = Date.now() + (a.timeoutMs ?? 60_000);
    while (replica.docs.size < a.n) {
      if (Date.now() > end) throw new Error(`timeout: have ${replica.docs.size}, want ${a.n}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return { done: process.hrtime.bigint().toString() };
  },
  async waitLinks(a: { n: number; timeoutMs?: number }) {
    const end = Date.now() + (a.timeoutMs ?? 15_000);
    while (transport.links().length < a.n) {
      if (Date.now() > end) throw new Error(`timeout: ${transport.links().length}/${a.n} links`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return { wall: Date.now() };
  },
  times(a: { id?: string }) {
    return {
      upAt: Object.fromEntries([...upAt].map(([k, v]) => [k, v.toString()])),
      applied: a.id ? (appliedAt.get(a.id)?.toString() ?? null) : null,
    };
  },
  usage() {
    const cpu = process.cpuUsage();
    const m = process.memoryUsage();
    return { cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, rssMB: m.rss / 1048576, heapMB: m.heapUsed / 1048576 };
  },
  stats() {
    return { ...replica.stats, wire: transport.wireStats() };
  },
  /** Connect as a stranger (own cert, sync ALPN) and report whether any application byte came back. */
  async probe(a: { port: number }) {
    let received = 0;
    await new Promise<void>((resolve) => {
      const s = tls.connect({
        host: '127.0.0.1',
        port: a.port,
        key: identity.tlsKeyPem,
        cert: identity.tlsCertPem,
        ALPNProtocols: ['qtask-sync/1'],
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
      });
      s.on('data', (d) => (received += d.length));
      s.on('error', () => undefined);
      s.on('close', () => resolve());
    });
    return { received };
  },
  async stop() {
    await transport.stop();
    return true;
  },
};

process.on('message', async (req: Req) => {
  try {
    const result = await handlers[req.cmd]!(req.args);
    process.send!({ id: req.id, result });
  } catch (e) {
    process.send!({ id: req.id, error: (e as Error).message });
  }
});
process.send?.({ event: 'ready' });
