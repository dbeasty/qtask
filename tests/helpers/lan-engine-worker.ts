/**
 * A "device" process running the REAL sync engine (SyncDataStore + SyncEngine over an
 * in-memory DataStore) on the real LAN transport. Same IPC protocol as lan-worker.ts
 * for the pairing/link commands, plus data commands that go through the tracked store
 * exactly as the application services would.
 */

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryDataStore } from '../../src/data/memory/store.ts';
import { SyncEngine } from '../../src/sync/engine.ts';
import { MemoryMetaStore } from '../../src/sync/meta.ts';
import { SyncDataStore } from '../../src/sync/tracker.ts';
import {
  FileSecretStore,
  LanSyncCoordinator,
  LanTransport,
  PeerStore,
  loadOrCreateIdentity,
  parsePairLink,
} from '../../src/sync/lan/index.ts';

type Req = { id: number; cmd: string; args?: any };

let transport: LanTransport;
let store: SyncDataStore;
let engine: SyncEngine;
let coordinator: LanSyncCoordinator;
let rounds = 0;
let errors: string[] = [];
let pairingResult: Promise<unknown> | null = null;

const tasks = () => store.collection('tasks');

async function digest() {
  const docs = (await tasks().find({})).map((d) => ({
    id: String(d._id),
    title: d.title,
    done: d.done ?? false,
    notes: d.notes ?? null,
  }));
  docs.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { count: docs.length, digest: createHash('sha256').update(JSON.stringify(docs)).digest('hex') };
}

const handlers: Record<string, (a: any) => Promise<unknown> | unknown> = {
  async init(a: { dir: string; name: string; discoveryPort?: number }) {
    const identity = await loadOrCreateIdentity(new FileSecretStore(join(a.dir, 'identity.json')), a.name);
    const peers = await PeerStore.open(identity, a.dir);
    transport = new LanTransport({
      identity,
      peers,
      host: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      discovery: a.discoveryPort ? { port: a.discoveryPort, interfaces: ['127.0.0.1'] } : false,
      backoff: { minMs: 100, maxMs: 1000 },
    });
    const meta = new MemoryMetaStore({ nodeId: a.name });
    store = new SyncDataStore(new MemoryDataStore(), meta);
    engine = new SyncEngine({ store, meta, role: 'device' });
    await engine.init();
    coordinator = new LanSyncCoordinator(engine, transport, {
      headersFirst: process.env.HEADERS_FIRST !== '0',
      onResult: () => void rounds++,
      onError: (_p, e) => void errors.push(e.message),
    });
    coordinator.start();
    await transport.start();
    return { nodeId: identity.info.nodeId, port: transport.port, certFp: identity.info.certFp, pid: process.pid };
  },
  openPairing() {
    const inv = transport.openPairing();
    pairingResult = inv.result.then((p) => ({ nodeId: p.nodeId }));
    return { link: inv.link };
  },
  awaitPairing: () => pairingResult,
  async pairWith(a: { link: string }) {
    const p = await transport.pairWith(parsePairLink(a.link)!);
    return { nodeId: p.nodeId };
  },
  peers: () => transport.links().map((l) => l.peerId),
  async waitLinks(a: { n: number; timeoutMs?: number }) {
    const end = Date.now() + (a.timeoutMs ?? 15_000);
    while (transport.links().length < a.n) {
      if (Date.now() > end) throw new Error(`timeout: ${transport.links().length}/${a.n} links`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return true;
  },
  async create(a: { id: string; doc: Record<string, unknown> }) {
    await tasks().create({ _id: a.id, userId: 'u1', ...a.doc });
    void coordinator.syncNow();
    return true;
  },
  async update(a: { id: string; set?: Record<string, unknown>; unset?: Record<string, 1> }) {
    await tasks().updateOne({ _id: a.id }, { ...(a.set ? { $set: a.set } : {}), ...(a.unset ? { $unset: a.unset } : {}) });
    void coordinator.syncNow();
    return true;
  },
  async remove(a: { id: string }) {
    await tasks().deleteOne({ _id: a.id });
    void coordinator.syncNow();
    return true;
  },
  /** Writes without triggering a sync, to model an edit made while nobody was reachable. */
  async createQuiet(a: { id: string; doc: Record<string, unknown> }) {
    await tasks().create({ _id: a.id, userId: 'u1', ...a.doc });
    return true;
  },
  async bulk(a: { n: number; prefix: string; bytes: number }) {
    const pad = 'x'.repeat(a.bytes);
    for (let i = 0; i < a.n; i++) await tasks().create({ _id: `${a.prefix}${i}`, userId: 'u1', title: `Task ${i}`, notes: pad, n: i });
    void coordinator.syncNow();
    return a.n;
  },
  syncNow: async () => (await coordinator.syncNow(), true),
  get: async (a: { id: string }) => tasks().findOne({ _id: a.id }),
  digest: () => digest(),
  async waitDigest(a: { count: number; digest?: string; timeoutMs?: number }) {
    const end = Date.now() + (a.timeoutMs ?? 20_000);
    for (;;) {
      const d = await digest();
      if (d.count === a.count && (!a.digest || d.digest === a.digest)) return d;
      if (Date.now() > end) throw new Error(`timeout: have ${d.count}, want ${a.count}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  },
  async conflicts() {
    return (await store.collection('activities').find({ action: 'sync_conflict' })).length;
  },
  async status() {
    return { ...(await engine.status()), rounds, errors, wire: transport.wireStats() };
  },
  usage() {
    const cpu = process.cpuUsage();
    return { cpuMs: (cpu.user + cpu.system) / 1000, rssMB: process.memoryUsage().rss / 1048576 };
  },
  async stop() {
    coordinator.stop();
    await transport.stop();
    return true;
  },
};

process.on('message', async (req: Req) => {
  try {
    process.send!({ id: req.id, result: await handlers[req.cmd]!(req.args) });
  } catch (e) {
    process.send!({ id: req.id, error: (e as Error).message });
  }
});
process.send?.({ event: 'ready' });
