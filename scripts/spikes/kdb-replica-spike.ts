/**
 * Spike for docs/KDB_REPLICA_EVALUATION.md: what @kdb/replica (KDB v0.8.0) does against a
 * kdb-service holding qtask's own documents, written through qtask's KDB data store.
 *
 * Not part of the app or the test suite. @kdb/replica is not published; point KDB_REPLICA_SRC at
 * its source (packages/kdb-replica/src/index.ts from the v0.8.0 tag, with @kdb/client resolvable
 * from there) and run:
 *
 *   KDB_REPLICA_SRC=/path/to/kdb-replica/src/index.ts npx tsx scripts/spikes/kdb-replica-spike.ts
 *
 * Env: SPIKE_TASKS (default 5000), SPIKE_EDITS (default 500), SPIKE_SQL_PORT (8333),
 * SPIKE_PEER_PORT (8332). Starts its own on-disk kdb-service and removes its data afterwards.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pinnedKdbVersion } from '../fetch-kdb.ts';

const NS = 'qtask/docs';
const SQL_PORT = Number(process.env.SPIKE_SQL_PORT ?? 8333);
const PEER_PORT = Number(process.env.SPIKE_PEER_PORT ?? 8332);
const TASKS = Number(process.env.SPIKE_TASKS ?? 5000);
const EDITS = Number(process.env.SPIKE_EDITS ?? 500);
const REPLICA_SRC = process.env.KDB_REPLICA_SRC;
if (!REPLICA_SRC) throw new Error('set KDB_REPLICA_SRC to @kdb/replica src/index.ts');

const root = resolve(import.meta.dirname, '../..');
const bin = process.env.KDB_SERVICE_BIN ?? join(root, '.kdb', pinnedKdbVersion() ?? 'none', 'kdb-service');
const dataDir = mkdtempSync(join(tmpdir(), 'qtask-replica-spike-'));

const service = spawn(bin, [
  '--data-dir', dataDir,
  '--namespace', NS,
  '--sql-addr', `tcp://127.0.0.1:${SQL_PORT}?bind=true`,
  '--peer-http', `127.0.0.1:${PEER_PORT}`,
  '--peer-addr', '', '--stream-addr', '',
  '--log-level', 'error',
], { stdio: 'ignore' });

const ms = (t0: number) => `${(performance.now() - t0).toFixed(0)} ms`;

try {
  await waitForPort(SQL_PORT);
  await waitForPort(PEER_PORT);

  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'spike';
  process.env.DATA_KDB = 'true';
  process.env.DATA_KDB_PUSHDOWN = 'true';
  process.env.KDB_ADDR = `tcp://127.0.0.1:${SQL_PORT}`;
  process.env.KDB_NAMESPACE_PREFIX = NS;
  await import('../../src/models/index.ts');
  const { KdbDataStore } = await import('../../src/data/kdb/store.ts');
  const store = new KdbDataStore();
  await store.connect();
  const tasks = store.collection('tasks');
  const projects = store.collection('projects');

  let t0 = performance.now();
  const projectIds: string[] = [];
  for (let p = 0; p < 20; p++) {
    const project = await projects.create({ userId: p % 2 ? 'u1' : 'u2', name: `Project ${p}`, collaborators: [] });
    projectIds.push(project._id as string);
  }
  const created: string[] = [];
  for (let start = 0; start < TASKS; start += 250) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(250, TASKS - start) }, (_, j) => {
        const i = start + j;
        return tasks.create({
          userId: i % 2 ? 'u1' : 'u2',
          projectIds: [projectIds[i % 20]],
          title: `Task ${i}`,
          description: 'x'.repeat(200),
          status: 'todo',
          steps: [{ text: 'step one', done: false }],
        });
      })
    );
    created.push(...batch.map((t) => t._id as string));
  }
  console.log(`seeded ${TASKS} tasks + 20 projects through KdbDataStore in ${ms(t0)}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an unpublished package, loaded by path
  const replicaModule = (await import(REPLICA_SRC)) as any;
  const { openReplica, MemoryStore } = replicaModule;
  const url = `ws://127.0.0.1:${PEER_PORT}/kdb/sync`;

  // 1. Full namespace: snapshot bootstrap.
  const full = await openReplica({ store: new MemoryStore(), peer: { url }, namespaces: [{ ns: NS }], autoSync: false, live: false });
  t0 = performance.now();
  const [boot] = await full.syncNow();
  const bootMs = ms(t0);
  const docs = await full.scan(NS);
  console.log(`full replica bootstrap: route=${boot.route} docs=${docs.length} in ${bootMs} (MemoryStore)`);
  const sample = JSON.parse((await full.get(NS, docs.find((d: { json: string }) => d.json.includes('"Task 1"'))!.id))!);
  console.log(`  a task as the replica sees it: keys=${Object.keys(sample).sort().join(',')}`);

  // 2. Catch-up after EDITS edits made through qtask.
  t0 = performance.now();
  for (let i = 0; i < EDITS; i++) await tasks.updateOne({ _id: created[i] }, { $set: { status: 'done' } });
  console.log(`${EDITS} edits through KdbDataStore in ${ms(t0)}`);
  t0 = performance.now();
  const [catchUp] = await full.syncNow();
  console.log(`full replica catch-up: route=${catchUp.route} changed=${catchUp.changed.length} in ${ms(t0)}`);
  t0 = performance.now();
  const [noop] = await full.syncNow();
  console.log(`full replica no-op round: route=${noop.route ?? 'none'} changed=${noop.changed.length} in ${ms(t0)}`);

  // 3. A local write on the replica, pushed, then read by qtask.
  const target = docs.find((d: { json: string }) => d.json.includes('"Task 2"'))!;
  const edited = { ...JSON.parse(target.json), title: 'edited on the replica' };
  await full.put(NS, target.id, edited);
  t0 = performance.now();
  const [push] = await full.syncNow();
  console.log(`full replica push: pushed=${push.pushed} outcome=${push.pushOutcome} in ${ms(t0)}`);
  const { fromDocumentUuid } = await import('../../src/data/kdb/ids.ts');
  const seen = await tasks.findById(fromDocumentUuid(target.id)!);
  console.log(`  qtask reads it back: title=${JSON.stringify(seen?.title)}`);

  // 4. Concurrent edits of the same task on the replica and through qtask.
  const raceId = docs.find((d: { json: string }) => d.json.includes('"Task 3"'))!.id;
  await full.put(NS, raceId, { ...JSON.parse((await full.get(NS, raceId))!), title: 'replica title' });
  await tasks.updateOne({ _id: fromDocumentUuid(raceId)! }, { $set: { status: 'cancelled' } });
  const conflicts: unknown[] = [];
  full.on('conflict', (e: unknown) => conflicts.push(e));
  const [race] = await full.syncNow();
  const after = await tasks.findById(fromDocumentUuid(raceId)!);
  console.log(`concurrent edit (replica: title, qtask: status): outcome=${race.pushOutcome} conflictEvents=${conflicts.length} server title=${JSON.stringify(after?.title)} status=${JSON.stringify(after?.status)}`);
  await full.close();

  // 5. Filtered namespace for one user, with write-back.
  const filtered = await openReplica({
    store: new MemoryStore(),
    peer: { url },
    namespaces: [{ ns: NS, mode: 'filtered', filter: "userId = 'u1'", writeBack: true }],
    autoSync: false,
    live: false,
  });
  t0 = performance.now();
  await filtered.syncNow();
  const [fboot] = filtered.lastProjectionResults;
  const fdocs = await filtered.scan(NS);
  console.log(`filtered replica (userId = 'u1') bootstrap: docs=${fdocs.length} reset=${fboot.reset} in ${ms(t0)}`);
  for (let i = 1; i < 101; i += 2) await tasks.updateOne({ _id: created[i] }, { $set: { status: 'in_progress' } });
  t0 = performance.now();
  await filtered.syncNow();
  const [fcatch] = filtered.lastProjectionResults;
  console.log(`filtered catch-up after 50 u1 edits: changed=${fcatch.changed.length} in ${ms(t0)}`);
  const mine = fdocs.find((d: { json: string }) => d.json.includes('"_c":"tasks"'))!;
  await filtered.put(NS, mine.id, { ...JSON.parse((await filtered.get(NS, mine.id))!), title: 'written back' });
  t0 = performance.now();
  await filtered.syncNow();
  const [wb] = filtered.lastProjectionResults;
  const wbSeen = await tasks.findById(fromDocumentUuid(mine.id)!);
  console.log(`filtered write-back: applied=${wb.applied} rejected=${wb.rejected.length} in ${ms(t0)}; qtask reads title=${JSON.stringify(wbSeen?.title)}`);
  await filtered.close();

  await store.disconnect();
} finally {
  service.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((done) => {
      const socket = netConnect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => done(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`port ${port} did not open`);
}
