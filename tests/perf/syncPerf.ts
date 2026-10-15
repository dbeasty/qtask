/**
 * Phase 2 sync performance harness. Not part of `npm test` (no `.test.` in the name).
 *
 *   npm run perf:sync                    # in-memory device and hub, JSON loopback
 *   npm run perf:sync -- --http          # also: device -> real Express + Mongo over HTTP
 *   npm run perf:sync -- --sizes=1000,10000 --out=docs/perf/phase2.md
 *
 * Every figure printed here is measured on the machine running it; nothing is
 * estimated. See docs/perf/phase2.md for the method and the recorded run.
 */

import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MemoryDataStore } from '../../src/data/memory/store.ts';
import { HubAuthorizer } from '../../src/sync/hub.ts';
import { MemoryMetaStore } from '../../src/sync/meta.ts';
import { mergeRecords } from '../../src/sync/merge.ts';
import { hashEncoded } from '../../src/sync/codec.ts';
import { formatStamp } from '../../src/sync/clock.ts';
import { HttpSyncTransport, LoopbackTransport } from '../../src/sync/transport.ts';
import { createDefaultDerived } from '../../src/sync/derived.ts';
import { SyncEngine } from '../../src/sync/engine.ts';
import { SyncDataStore } from '../../src/sync/tracker.ts';
import type { SyncTransport } from '../../src/sync/types.ts';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k!, v ?? 'true'] as const;
  })
);
const SIZES = (args.get('sizes') ?? '1000,10000,50000').split(',').map(Number);
const HTTP = args.has('http');
const HTTP_SIZES = (args.get('http-sizes') ?? '1000,10000').split(',').map(Number);
const OUT = args.get('out');
const HUB_DERIVED = !args.has('no-derived');
const NOOP_RUNS = Number(args.get('noop-runs') ?? 50);

const gc = (globalThis as { gc?: () => void }).gc;
const mb = (bytes: number) => bytes / 1024 / 1024;
const fmt = (n: number, digits = 1) => n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const ms = (n: number) => `${fmt(n, n < 10 ? 2 : 0)} ms`;

function heap(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
}
function rss(): number {
  return process.memoryUsage().rss;
}

const WORDS = ['plan', 'review', 'ship', 'fix', 'draft', 'call', 'email', 'update', 'design', 'test', 'write', 'merge'];
function taskDoc(i: number, userId: string, projectId: string) {
  const w = (k: number) => WORDS[(i * 7 + k) % WORDS.length];
  return {
    userId,
    projectId,
    projectIds: [projectId],
    title: `${w(0)} ${w(1)} ${w(2)} item ${i}`,
    description: `${w(3)} the ${w(4)} before ${w(5)}; notes for task ${i}. `.repeat(4),
    status: ['todo', 'in_progress', 'done'][i % 3],
    priority: ['low', 'medium', 'high'][i % 3],
    tags: [w(6), w(7)],
    percentComplete: i % 3 === 2 ? 100 : 0,
    sortOrder: i,
    steps: [],
    subtasks: [],
    links: [],
    dueDate: new Date(1_800_000_000_000 + i * 3_600_000),
    hoursSpent: i % 5,
    hoursRemaining: (i + 1) % 4,
  };
}

interface Node {
  inner: MemoryDataStore;
  meta: MemoryMetaStore;
  store: SyncDataStore;
  engine: SyncEngine;
}

function makeNode(name: string, role: 'hub' | 'device', derived = false): Node {
  const inner = new MemoryDataStore();
  const meta = new MemoryMetaStore({ nodeId: name });
  const store = new SyncDataStore(inner, meta);
  const engine = new SyncEngine({ store, meta, role, derived: derived ? createDefaultDerived() : undefined });
  return { inner, meta, store, engine };
}

function viaLoopback(server: Node, userId?: string): LoopbackTransport {
  return new LoopbackTransport(server.engine.service(userId ? new HubAuthorizer(server.store, userId) : undefined));
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const lines: string[] = [];
function out(line = ''): void {
  lines.push(line);
  console.log(line);
}
function table(headers: string[], rows: string[][]): void {
  out(`| ${headers.join(' | ')} |`);
  out(`|${headers.map(() => '---').join('|')}|`);
  for (const row of rows) out(`| ${row.join(' | ')} |`);
  out();
}

// --- in-memory runs -----------------------------------------------------------------

interface SizeResult {
  n: number;
  baselineMs: number;
  pushMs: number;
  pushBytes: number;
  pushRequests: number;
  pullMs: number;
  pullBytes: number;
  heapDataMb: number;
  heapMetaMb: number;
  hubHeapMb: number;
  incrementalMs: number;
  incrementalBytes: number;
  incrementalRequests: number;
  incrementalPullMs: number;
  noopMedianMs: number;
  noopP95Ms: number;
  noopRequests: number;
  noopBytes: number;
  writeRawUs: number;
  writeTrackedUs: number;
  snapshotMb: number;
  snapshotMs: number;
  mergeDocs: number;
  mergeMs: number;
  mergePerSec: number;
}

async function runSize(n: number): Promise<SizeResult> {
  const user = 'acct';
  const projectId = 'proj-1';
  const heap0 = heap();
  const device = makeNode('device', 'device');
  const hub = makeNode('hub', 'hub', HUB_DERIVED);

  // Existing local data (what Phase 1 leaves behind), written straight to the store.
  await device.inner.collection('projects').create({ _id: projectId, userId: user, name: 'P', collaborators: [] });
  const batch = [];
  for (let i = 0; i < n; i++) batch.push({ ...taskDoc(i, user, projectId), _id: i.toString(16).padStart(24, '0') });
  await device.inner.collection('tasks').insertMany(batch);
  const heapData = heap();

  const baseline = await timed(() => device.engine.init());
  const heapMeta = heap();

  // Initial push to an empty hub.
  const t1 = viaLoopback(hub, user);
  const push = await timed(() => device.engine.syncWith(t1));
  const hubHeap = heap();

  // Initial pull by a second, empty device of the same account.
  const device2 = makeNode('device2', 'device');
  await device2.engine.init();
  const t2 = viaLoopback(hub, user);
  const pull = await timed(() => device2.engine.syncWith(t2));
  if (device2.inner.count('tasks') !== n) throw new Error(`device2 has ${device2.inner.count('tasks')} of ${n}`);

  // Write overhead of the tracking layer: same updates through the raw and tracked stores.
  const probe = Math.min(2000, n);
  const rawRuns: number[] = [];
  const trackedRuns: number[] = [];
  for (let round = 0; round < 7; round++) {
    const rawMs = await timed(async () => {
      for (let i = 0; i < probe; i++) {
        await device.inner.collection('tasks').updateOne({ _id: i.toString(16).padStart(24, '0') }, { $set: { hoursSpent: 100 + round } });
      }
    });
    const trackedMs = await timed(async () => {
      for (let i = 0; i < probe; i++) {
        await device.store.collection('tasks').updateOne({ _id: i.toString(16).padStart(24, '0') }, { $set: { hoursSpent: 200 + round } });
      }
    });
    rawRuns.push((rawMs.ms / probe) * 1000);
    trackedRuns.push((trackedMs.ms / probe) * 1000);
  }
  const raw = { ms: percentile(rawRuns, 50) };
  const tracked = { ms: percentile(trackedRuns, 50) };
  await device.engine.syncWith(viaLoopback(hub, user));

  // Incremental: 100 edits on the device, sync; then 100 edits on the hub, device syncs.
  const incrementalCount = Math.min(100, n);
  for (let i = 0; i < incrementalCount; i++) {
    await device.store.collection('tasks').updateOne(
      { _id: (n - 1 - i).toString(16).padStart(24, '0') },
      { $set: { title: `edited ${i}`, status: 'done' } }
    );
  }
  const incTransport = viaLoopback(hub, user);
  const incremental = await timed(() => device.engine.syncWith(incTransport));
  if (incremental.result.pushed !== incrementalCount) {
    throw new Error(`incremental pushed ${incremental.result.pushed}, expected ${incrementalCount}`);
  }
  for (let i = 0; i < incrementalCount; i++) {
    await hub.store.collection('tasks').updateOne(
      { _id: i.toString(16).padStart(24, '0') },
      { $set: { priority: 'urgent' } }
    );
  }
  const incPull = await timed(() => device.engine.syncWith(viaLoopback(hub, user)));
  if (incPull.result.pulled !== incrementalCount) {
    throw new Error(`incremental pulled ${incPull.result.pulled}, expected ${incrementalCount}`);
  }

  // Repeated no-op syncs.
  const noopTimes: number[] = [];
  const noopTransport = viaLoopback(hub, user);
  for (let i = 0; i < NOOP_RUNS; i++) {
    const r = await timed(() => device.engine.syncWith(noopTransport));
    if (r.result.pushed + r.result.pulled !== 0) throw new Error('no-op sync moved data');
    noopTimes.push(r.ms);
  }

  // Merge throughput: both sides edit the same field of the same documents.
  const mergeDocs = Math.min(n, 5000);
  await new Promise((r) => setTimeout(r, 2));
  for (let i = 0; i < mergeDocs; i++) {
    const id = i.toString(16).padStart(24, '0');
    await device.store.collection('tasks').updateOne({ _id: id }, { $set: { title: `device ${i}` } });
    await hub.store.collection('tasks').updateOne({ _id: id }, { $set: { title: `hub ${i}` } });
  }
  await hub.engine.capture();
  const mergeTransport = viaLoopback(hub, user);
  const merge = await timed(() => device.engine.syncWith(mergeTransport));
  // The hub detects the conflicts while applying the device's push, so they are in its log.
  const logged = hub.inner.count('activities');
  if (logged !== mergeDocs) throw new Error(`expected ${mergeDocs} conflict entries on the hub, saw ${logged}`);
  if (device.inner.count('activities') !== mergeDocs) throw new Error('device did not receive the conflict entries');

  // Snapshot of the device's sync records.
  const snap = await timed(async () => JSON.stringify(device.meta.snapshot()));

  return {
    n,
    baselineMs: baseline.ms,
    pushMs: push.ms,
    pushBytes: t1.bytesOut + t1.bytesIn,
    pushRequests: t1.requests,
    pullMs: pull.ms,
    pullBytes: t2.bytesOut + t2.bytesIn,
    heapDataMb: mb(heapData - heap0),
    heapMetaMb: mb(heapMeta - heapData),
    hubHeapMb: mb(hubHeap - heapMeta),
    incrementalMs: incremental.ms,
    incrementalBytes: incTransport.bytesOut + incTransport.bytesIn,
    incrementalRequests: incTransport.requests,
    incrementalPullMs: incPull.ms,
    noopMedianMs: percentile(noopTimes, 50),
    noopP95Ms: percentile(noopTimes, 95),
    noopRequests: noopTransport.requests / NOOP_RUNS,
    noopBytes: (noopTransport.bytesOut + noopTransport.bytesIn) / NOOP_RUNS,
    writeRawUs: raw.ms,
    writeTrackedUs: tracked.ms,
    snapshotMb: mb(snap.result.length),
    snapshotMs: snap.ms,
    mergeDocs,
    mergeMs: merge.ms,
    mergePerSec: mergeDocs / (merge.ms / 1000),
  };
}

function microMerge(): { perSec: number; conflictPerSec: number } {
  const T = (w: number, node: string) => formatStamp(w, 0, node);
  const field = (v: unknown, w: number, node: string, c: number) => ({ t: T(w, node), c, h: hashEncoded(v) });
  const names = Array.from({ length: 15 }, (_, i) => `f${i}`);
  const local = {
    coll: 'tasks' as const, id: 'x', scope: 'u:a', seq: 1, src: null, ut: 0, vv: { a: 3 },
    fields: Object.fromEntries(names.map((n, i) => [n, field(`v${i}`, 10, 'a', 1 + (i % 3))])),
  };
  const remoteSame = {
    coll: 'tasks' as const, id: 'x', scope: 'u:a', vv: { b: 3 },
    fields: Object.fromEntries(names.map((n, i) => [n, { v: `v${i}`, t: T(10, 'a'), c: 1 + (i % 3) }])),
  };
  const remoteConflict = {
    ...remoteSame,
    fields: Object.fromEntries(names.map((n, i) => [n, { v: `other${i}`, t: T(20, 'b'), c: 1 + (i % 3) }])),
  };
  const iterations = 200_000;
  let start = performance.now();
  for (let i = 0; i < iterations; i++) mergeRecords(local, remoteSame);
  const noConflict = iterations / ((performance.now() - start) / 1000);
  start = performance.now();
  for (let i = 0; i < iterations; i++) mergeRecords(local, remoteConflict);
  const conflict = iterations / ((performance.now() - start) / 1000);
  return { perSec: noConflict, conflictPerSec: conflict };
}

// --- real HTTP hub ---------------------------------------------------------------------

async function runHttp(sizes: number[]): Promise<void> {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
  process.env.SERVE_CLIENT = 'false';
  process.env.QTASK_SYNC_HUB = 'true';
  process.env.EMBEDDING_WORKER_ENABLED = 'false';
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mongoose = (await import('mongoose')).default;
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { createApp } = await import('../../src/app.ts');
  const { signToken } = await import('../../src/auth/jwt.ts');
  const app = await createApp({ connect: true, startWorker: false });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { getHubEngine } = await import('../../src/sync/runtime.ts');
  const { collection } = await import('../../src/data/index.ts');

  out('### Device (in-memory) to the real hub: Express + Mongo (mongodb-memory-server) over HTTP on localhost');
  out();
  const rows: string[][] = [];
  for (const n of sizes) {
    // A fresh account per size keeps runs independent.
    const userId = `6a${n.toString(16).padStart(22, '0')}`;
    const token = signToken({ sub: userId, email: `perf${n}@example.com` } as never);
    const device = makeNode(`http-device-${n}`, 'device');
    const projectId = `6b${n.toString(16).padStart(22, '0')}`;
    await device.inner.collection('projects').create({ _id: projectId, userId, name: 'P', collaborators: [], sortOrder: 0 });
    const docs = [];
    for (let i = 0; i < n; i++) docs.push({ ...taskDoc(i, userId, projectId), _id: (n * 0x1000000 + i).toString(16).padStart(24, '1') });
    await device.inner.collection('tasks').insertMany(docs);
    await device.engine.init();

    const transport = new HttpSyncTransport({ baseUrl, getToken: () => token, timeoutMs: 600_000 });
    let requests = 0;
    const counting: SyncTransport = {
      kind: 'http',
      hello: (r) => { requests++; return transport.hello(r); },
      pull: (r) => { requests++; return transport.pull(r); },
      push: (r) => { requests++; return transport.push(r); },
    };
    const first = await timed(() => device.engine.syncWith(counting));
    if (first.result.rejected.length) console.error('rejected:', first.result.rejected.slice(0, 3), first.result.rejected.length);
    const hubCount = await collection('tasks').countDocuments({ userId });
    if (hubCount !== n) throw new Error(`hub has ${hubCount} of ${n}`);

    requests = 0;
    for (let i = 0; i < Math.min(100, n); i++) {
      await device.store.collection('tasks').updateOne({ _id: (n * 0x1000000 + n - 1 - i).toString(16).padStart(24, '1') }, { $set: { title: `edited ${i}` } });
    }
    const inc = await timed(() => device.engine.syncWith(counting));

    requests = 0;
    const noop: number[] = [];
    for (let i = 0; i < 20; i++) noop.push((await timed(() => device.engine.syncWith(counting))).ms);

    const device2 = makeNode(`http-device2-${n}`, 'device');
    await device2.engine.init();
    const pull = await timed(() => device2.engine.syncWith(counting));
    if (device2.inner.count('tasks') !== n) throw new Error(`device2 got ${device2.inner.count('tasks')} of ${n}`);

    rows.push([
      fmt(n, 0),
      ms(first.ms),
      `${fmt(n / (first.ms / 1000), 0)}/s`,
      ms(pull.ms),
      `${fmt(n / (pull.ms / 1000), 0)}/s`,
      ms(inc.ms),
      ms(percentile(noop, 50)),
      ms(percentile(noop, 95)),
    ]);
  }
  table(
    ['tasks', 'initial push', 'push rate', 'initial pull (2nd device)', 'pull rate', 'incremental (100 edits)', 'no-op median', 'no-op p95'],
    rows
  );
  void getHubEngine;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { disconnectData } = await import('../../src/data/index.ts');
  await disconnectData();
  await mongoose.disconnect();
  await mongo.stop();
}

// --- main -------------------------------------------------------------------------------

async function main() {
  if (!gc) console.warn('Run with --expose-gc for meaningful heap numbers (npm run perf:sync does).');
  out('# Phase 2 sync performance (measured)');
  out();
  out(`Run: ${new Date().toISOString()}`);
  out(`Machine: ${cpus()[0]?.model}, ${cpus().length} cores, ${fmt(mb(totalmem()) / 1024, 0)} GB RAM; Node ${process.version}; ${process.platform}/${process.arch}`);
  out(`Sizes: ${SIZES.join(', ')} tasks; no-op runs per size: ${NOOP_RUNS}; HTTP section: ${HTTP ? HTTP_SIZES.join(', ') : 'not run'}`);
  out();
  out('## Method');
  out();
  out('- Reproduce: `npm run perf:sync -- --http --http-sizes=1000,10000,50000 --out=docs/perf/phase2.md` (script: `tests/perf/syncPerf.ts`). Single run, single machine, no repetition across runs except where a column says median/p95 over many syncs.');
  out('- Workload: tasks of ~15 fields (title, ~200-char description, status, priority, tags, dates, hours, empty steps/subtasks/links) in one project, one account. Synthetic, not production data.');
  out('- "In-memory" runs use `MemoryDataStore` for both the device and the hub with a `LoopbackTransport` that JSON-serialises every request and response (so encoding and parsing cost is included, network latency is not). This isolates the sync engine from database speed. Batch size is 500 documents.');
  out('- "Real hub" runs use the actual Express app with `QTASK_SYNC_HUB=true` on Mongo (mongodb-memory-server, in the same process) and a real HTTP client over localhost: JWT auth, body parsing, `HubAuthorizer` checks, Mongoose validation and the embedding-job enqueue for every received document. Localhost HTTP has no network latency or bandwidth limit; add round trips x RTT for a real link (an initial push is `ceil(n/500) + 2` requests, a no-op sync is 2).');
  out('- Baseline stamp = `engine.init()` over existing local data that was never tracked (the Phase 1 adoption case). Initial push = first `syncWith` to an empty hub, including the hub applying, recomputing derived fields and queueing embeddings. Initial pull = a second, empty device of the same account syncing from the hub.');
  out('- Incremental = 100 `updateOne` edits (two fields each) made through the tracked store, then one `syncWith`; then 100 hub-side edits pulled by the device. No-op = repeated `syncWith` with nothing changed.');
  out('- Merge = the same field of the same documents edited on both sides while apart; the timed sync captures them, detects the conflicts, writes one `sync_conflict` activity per conflict on the hub, and returns the merged documents to the device. The run asserts the conflict count.');
  out('- Heap figures are `process.memoryUsage().heapUsed` deltas after two forced GCs (`--expose-gc`); RSS is the whole process.');
  out();

  const results: SizeResult[] = [];
  for (const n of SIZES) {
    console.error(`running ${n} ...`);
    results.push(await runSize(n));
  }

  out('### Initial sync, in-memory device and hub, JSON round-tripped loopback (no network)');
  out();
  table(
    ['tasks', 'baseline stamp (existing data)', 'initial push to empty hub', 'push rate', 'initial pull by 2nd device', 'pull rate', 'push bytes', 'requests'],
    results.map((r) => [
      fmt(r.n, 0),
      ms(r.baselineMs),
      ms(r.pushMs),
      `${fmt(r.n / (r.pushMs / 1000), 0)}/s`,
      ms(r.pullMs),
      `${fmt(r.n / (r.pullMs / 1000), 0)}/s`,
      `${fmt(mb(r.pushBytes))} MB`,
      fmt(r.pushRequests, 0),
    ])
  );
  out('### Incremental sync after the initial sync');
  out();
  table(
    ['tasks', '100 edits: push', 'requests', 'bytes', '100 hub edits: pull', 'update by _id, raw store', 'update by _id, tracked store'],
    results.map((r) => [
      fmt(r.n, 0),
      ms(r.incrementalMs),
      fmt(r.incrementalRequests, 0),
      `${fmt(r.incrementalBytes / 1024)} KB`,
      ms(r.incrementalPullMs),
      `${fmt(r.writeRawUs, 1)} us`,
      `${fmt(r.writeTrackedUs, 1)} us`,
    ])
  );
  out('### Repeated no-op sync (nothing changed on either side)');
  out();
  table(
    ['tasks', 'median', 'p95', 'requests per sync', 'bytes per sync'],
    results.map((r) => [fmt(r.n, 0), ms(r.noopMedianMs), ms(r.noopP95Ms), fmt(r.noopRequests, 1), `${fmt(r.noopBytes, 0)} B`])
  );
  out('### Merge throughput (same field edited on both sides, then synced)');
  out();
  table(
    ['tasks in store', 'conflicting docs', 'sync time (merge + activity log + apply)', 'docs/s'],
    results.map((r) => [fmt(r.n, 0), fmt(r.mergeDocs, 0), ms(r.mergeMs), fmt(r.mergePerSec, 0)])
  );
  const micro = microMerge();
  out(`Pure \`mergeRecords\` (15-field document, no I/O): ${fmt(micro.perSec, 0)} merges/s with no conflict, ${fmt(micro.conflictPerSec, 0)} merges/s when every field conflicts.`);
  out();
  out('### Memory and storage (heap after forced GC)');
  out();
  table(
    ['tasks', 'document data', 'sync records (device)', 'sync records (hub, after receiving)', 'records per doc', 'snapshot JSON', 'snapshot time'],
    results.map((r) => [
      fmt(r.n, 0),
      `${fmt(r.heapDataMb)} MB`,
      `${fmt(r.heapMetaMb)} MB`,
      `${fmt(r.hubHeapMb)} MB (incl. its copy of the documents)`,
      `${fmt((r.heapMetaMb * 1024 * 1024) / r.n, 0)} B`,
      `${fmt(r.snapshotMb)} MB`,
      ms(r.snapshotMs),
    ])
  );
  out(`Process RSS at the end of the in-memory runs: ${fmt(mb(rss()))} MB.`);
  out();

  if (HTTP) await runHttp(HTTP_SIZES);

  if (OUT) {
    writeFileSync(OUT, `${lines.join('\n')}\n`);
    console.error(`wrote ${OUT}`);
  }
}

await main();
process.exit(0);
