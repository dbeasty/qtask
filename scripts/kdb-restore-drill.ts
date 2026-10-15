/**
 * KDB backup and restore drill, end to end, on SYNTHETIC qtask-shaped data.
 *
 *   npx tsx scripts/kdb-restore-drill.ts [--tasks=20000] [--port=8260] [--dir=.rehearsal/drill-<ts>] [--keep]
 *
 * Rehearses the path deploy/kdb-backup.sh and docs/KDB_MIGRATION.md describe, with the binaries from
 * the pinned KDB release (`npm run kdb:fetch -- --with-inspect`):
 *
 *   1. A source kdb-service, on disk, with the production unit's flags (deploy/qtask-kdb.service):
 *      --durability sync, --expire-field _expireAt, control plane with a backup directory.
 *   2. The qtask store connects (declaring constraints and indexes, as the app does) and loads the
 *      dataset (scripts/rehearsal/dataset.ts) with importMany - plus authorization codes that
 *      expire shortly after the restore, and some already expired.
 *   3. Writes keep coming (task creates and updates, user creates) while an online backup is taken
 *      through the control plane. Every write records when it was acknowledged.
 *   4. The backup is verified, restored with `kdb-inspect restore` into a fresh data directory, and
 *      a second kdb-service is started on it.
 *   5. Checks: every write acknowledged before the backup started is in the restore; nothing
 *      acknowledged after it finished is; untouched documents are identical; counts per collection
 *      are within the bounds the writes allow; whether unique constraints and indexes are present
 *      before the store re-declares them, and that they hold after it does; expiry continues.
 *   6. With writes stopped, a second backup is taken with deploy/kdb-backup.sh itself (backup,
 *      verify, prune), restored, and compared with the source document for document: every
 *      collection's count and every document identical.
 *
 * Prints a report (sizes, times, results) and exits non-zero if any check fails.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { castForStore, createDataset, GENERATED, scaleFor } from './rehearsal/dataset.js';
import { fetchKdbTool, pinnedKdbVersion } from './fetch-kdb.js';
import type { CollectionName, Doc } from '../src/data/types.js';

const ROOT = resolve(import.meta.dirname, '..');
const NS = 'qtask/docs';

function arg(name: string, fallback?: string): string | undefined {
  const flag = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!flag) return fallback;
  return flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : 'true';
}

const TASKS = Number(arg('tasks', '20000'));
const BASE_PORT = Number(arg('port', '8260'));
const DIR = resolve(arg('dir', join(ROOT, '.rehearsal', `drill-${new Date().toISOString().replace(/[:.]/g, '-')}`))!);
const KEEP = arg('keep') === 'true';

process.env.NODE_ENV ??= 'production';
process.env.JWT_SECRET ??= 'drill';
process.env.ADMIN_JWT_SECRET ??= 'drill';
process.env.MCP_OAUTH_JWT_SECRET ??= 'drill';
process.env.DATA_KDB = 'true';
process.env.DATA_KDB_PUSHDOWN = 'true';
process.env.KDB_NAMESPACE_PREFIX = NS;
process.env.KDB_REQUEST_TIMEOUT_MS ??= '120000';

const report: string[] = [];
const failures: string[] = [];
function note(line: string): void {
  console.log(line);
  report.push(line);
}
function check(ok: boolean, what: string): void {
  note(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function du(path: string): string {
  const out = spawnSync('du', ['-sk', path], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[0];
  return `${(Number(out) / 1024).toFixed(1)} MiB`;
}

interface Service {
  child: ChildProcess;
  sql: number;
  admin: number;
  control: number;
  dataDir: string;
  backupDir: string;
}

/** A kdb-service with deploy/qtask-kdb.service's flags (ports, paths and expiry interval aside). */
async function startService(bin: string, dataDir: string, backupDir: string, port: number): Promise<{ service: Service; readyMs: number }> {
  mkdirSync(backupDir, { recursive: true });
  const service: Service = { child: undefined as unknown as ChildProcess, sql: port, admin: port + 1, control: port + 2, dataDir, backupDir };
  const started = performance.now();
  service.child = spawn(bin, [
    '--data-dir', dataDir, '--namespace', NS,
    '--sql-addr', `tcp://127.0.0.1:${service.sql}?bind=true`,
    '--peer-addr', '', '--stream-addr', '',
    '--admin-addr', `127.0.0.1:${service.admin}`,
    '--control-addr', `127.0.0.1:${service.control}`, '--control-write', '--control-ui=false',
    '--control-backup-dir', backupDir,
    '--expire-field', '_expireAt', '--expire-interval', '2s',
    '--durability', 'sync', '--memory-budget-mb', '1536', '--scrub-interval', '24h',
    '--log-format', 'json', '--log-level', 'warn',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  const deadline = Date.now() + 600_000;
  for (;;) {
    if (service.child.exitCode !== null) throw new Error(`kdb-service exited with ${service.child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${service.admin}/readyz`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('kdb-service did not become ready');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { service, readyMs: performance.now() - started };
}

async function stopService(service: Service): Promise<void> {
  if (service.child.exitCode !== null) return;
  const exited = new Promise((r) => service.child.once('exit', r));
  service.child.kill('SIGTERM');
  await exited;
}

async function control(service: Service, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${service.control}${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from('drill:unused').toString('base64')}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

type Store = import('../src/data/kdb/store.js').KdbDataStore;

/** A KdbDataStore pointed at one service. The config is a module-level snapshot, so the address
 *  is set on it before connect(); each store keeps the client it connected with. */
async function openStore(service: Service, declare: boolean): Promise<Store> {
  const { config } = await import('../src/config/index.js');
  const { KdbDataStore } = await import('../src/data/kdb/store.js');
  const kdb = config.kdb as { addr: string; declareConstraints: boolean; declareIndexes: boolean };
  kdb.addr = `tcp://127.0.0.1:${service.sql}`;
  kdb.declareConstraints = declare;
  kdb.declareIndexes = declare;
  const store = new KdbDataStore();
  await store.connect();
  return store;
}

interface RawClient {
  replace(ns: string, id: string, body: unknown): Promise<string>;
  delete(ns: string, id: string): Promise<string>;
  exec(ns: string, sql: string): Promise<unknown>;
  close(): Promise<void>;
}
async function rawClient(service: Service): Promise<RawClient> {
  const { connect } = (await import(process.env.KDB_CLIENT_MODULE ?? '@kdb/client')) as { connect(a: string, o: object): Promise<RawClient> };
  return connect(`tcp://127.0.0.1:${service.sql}`, { requestTimeoutMs: 120_000 });
}

/** Every document of a collection, read by id (keyed), in pages - not a scan. */
async function readAll(store: Store, name: CollectionName, ids: string[]): Promise<Map<string, Doc>> {
  const out = new Map<string, Doc>();
  const coll = store.collection(name);
  for (let i = 0; i < ids.length; i += 500) {
    for (const doc of await coll.find({ _id: { $in: ids.slice(i, i + 500) } })) out.set(doc._id as string, doc);
  }
  return out;
}

async function main(): Promise<void> {
  const version = pinnedKdbVersion();
  const serviceBin = process.env.KDB_SERVICE_BIN ?? (await fetchKdbTool('kdb-service'));
  const inspectBin = process.env.KDB_INSPECT_BIN ?? (await fetchKdbTool('kdb-inspect'));
  if (existsSync(DIR)) rmSync(DIR, { recursive: true });
  mkdirSync(DIR, { recursive: true });
  await import('../src/models/index.js');
  const { compareDocLists } = await import('../src/data/shadow/compare.js');
  const { DuplicateKeyError } = await import('../src/data/kdb/schema.js');
  const { toDocumentUuid } = await import('../src/data/kdb/ids.js');

  note('# KDB backup/restore drill - SYNTHETIC qtask-shaped data, not production');
  note(`kdb-service v${version}: ${spawnSync(serviceBin, ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
  note(`host: ${process.platform}/${process.arch}; work dir ${DIR}`);

  // --- 1-2: source service and dataset ---------------------------------------------------------
  const { service: source } = await startService(serviceBin, join(DIR, 'source'), join(DIR, 'backups'), BASE_PORT);
  const store = await openStore(source, true);
  const scale = scaleFor(TASKS);
  const now = new Date();
  const dataset = createDataset(scale, { now });
  const ids = new Map<CollectionName, string[]>();
  let loaded = 0;
  const loadStarted = performance.now();
  for (const name of GENERATED) {
    const list: string[] = [];
    for (const batch of dataset.batches(name, 500)) {
      const docs = batch.map((raw) => castForStore(name, raw));
      // Commits of at most ~64 KiB, as the backfill writes them.
      let group: Doc[] = [];
      let bytes = 0;
      for (const doc of docs) {
        const size = JSON.stringify(doc).length;
        if (group.length && (group.length >= 250 || bytes + size > 64 * 1024)) {
          await store.importMany(name, group);
          group = [];
          bytes = 0;
        }
        group.push(doc);
        bytes += size;
        list.push(doc._id as string);
      }
      if (group.length) await store.importMany(name, group);
    }
    ids.set(name, list);
    loaded += list.length;
  }
  // Expiry probes: authorization codes expiring 45 s from now (after the restore), and some that
  // expired a minute ago (hidden already, and must stay gone after the restore).
  const codes = store.collection('mcpOAuthAuthorizationCodes');
  const soon = new Date(Date.now() + 45_000);
  const probeLive: string[] = [];
  const probePast: string[] = [];
  for (let i = 0; i < 20; i++) {
    const past = i % 2 === 1;
    const created = await codes.create({
      codeHash: `drill-code-${i}`, clientId: 'drill', userId: dataset.ids.users[0], scope: 's', codeChallenge: 'c',
      redirectUri: 'https://example.com/cb', resource: 'r', expiresAt: past ? new Date(Date.now() - 60_000) : soon,
    });
    (past ? probePast : probeLive).push(created._id as string);
  }
  const farFuture = await store.collection('mcpOAuthRefreshTokens').findById(ids.get('mcpOAuthRefreshTokens')![0]!);
  note(`loaded ${loaded} documents (${scale.tasks} tasks) through the store in ${seconds(performance.now() - loadStarted)}; source data dir ${du(source.dataDir)}`);

  // --- 3: writes during an online backup ---------------------------------------------------------
  const tasks = store.collection('tasks');
  const users = store.collection('users');
  interface Ack { kind: 'createTask' | 'updateTask' | 'createUser'; id: string; at: number; value?: number }
  const acks: Ack[] = [];
  let writing = true;
  const updateTargets = ids.get('tasks')!.slice(0, 200);
  const touched = new Set<string>(updateTargets);
  const writer = (async () => {
    let n = 0;
    while (writing) {
      n++;
      const kind = n % 3;
      if (kind === 0) {
        const doc = await tasks.create({ userId: dataset.ids.users[n % dataset.ids.users.length], title: `drill write ${n}`, projectIds: [dataset.ids.projects[0]] });
        acks.push({ kind: 'createTask', id: doc._id as string, at: Date.now() });
        touched.add(doc._id as string);
      } else if (kind === 1) {
        const id = updateTargets[n % updateTargets.length]!;
        await tasks.updateOne({ _id: id }, { $set: { sortOrder: 1_000_000 + n } });
        acks.push({ kind: 'updateTask', id, at: Date.now(), value: 1_000_000 + n });
      } else {
        const doc = await users.create({ email: `drill-${n}@example.com`, displayName: 'Drill' });
        acks.push({ kind: 'createUser', id: doc._id as string, at: Date.now() });
        touched.add(doc._id as string);
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 3_000));
  const backupStart = Date.now();
  const backup = await control(source, `/v1/ns/${encodeURIComponent(NS)}/backups`);
  const backupEnd = Date.now();
  await new Promise((r) => setTimeout(r, 3_000));
  writing = false;
  await writer;
  const backupId = String(backup.backupId);
  const before = acks.filter((a) => a.at < backupStart);
  const during = acks.filter((a) => a.at >= backupStart && a.at <= backupEnd);
  const after = acks.filter((a) => a.at > backupEnd);
  note(`online backup ${backupId}: ${(Number(backup.sizeBytes) / 1048576).toFixed(1)} MiB, ${backup.commitCount} commits, ${backup.segments} segments, ` +
    `server took ${backup.tookMs} ms (request ${backupEnd - backupStart} ms); verified-prefix segments: ${backup.verifiedPrefixSegments ?? 0}`);
  note(`writes acknowledged: ${before.length} before the backup started, ${during.length} while it ran, ${after.length} after it finished`);
  const verifyStarted = performance.now();
  const verified = await control(source, `/v1/ns/${encodeURIComponent(NS)}/backups/${backupId}/verify`);
  check(verified.clean === true, `backup verifies against its manifest (${verified.objects} objects, ${seconds(performance.now() - verifyStarted)})`);
  note(`backup dir ${du(source.backupDir)}`);

  // --- 4: restore into a fresh directory, start a service on it -----------------------------------
  const restoredDir = join(DIR, 'restored');
  let t0 = performance.now();
  const restore = spawnSync(inspectBin, ['restore', '--namespace', NS, '--from-backup', source.backupDir, '--backup-id', backupId, '--out', restoredDir], { encoding: 'utf8' });
  check(restore.status === 0, `kdb-inspect restore exits 0 (${seconds(performance.now() - t0)})`);
  if (restore.status !== 0) throw new Error(restore.stderr || restore.stdout);
  note(restore.stdout.trim().split('\n').map((l) => `    ${l}`).join('\n'));
  const { service: restored, readyMs } = await startService(serviceBin, restoredDir, join(DIR, 'restored-backups'), BASE_PORT + 10);
  note(`restored data dir ${du(restoredDir)}; kdb-service ready on it in ${seconds(readyMs)} (first open)`);

  // Before anything re-declares them: are the constraints and indexes there?
  const rawRestored = await rawClient(restored);
  const existingUser = (await store.collection('users').findById(dataset.ids.users[0]!))!;
  const dupId = toDocumentUuid('6b0000000000000000000001');
  const dupBody = { _c: 'users', email: existingUser.email, _u_users_email: JSON.stringify([existingUser.email]) };
  let constraintBefore = false;
  try {
    await rawRestored.replace(NS, dupId, dupBody);
    await rawRestored.delete(NS, dupId);
  } catch (error) {
    constraintBefore = (error as { code?: string }).code === 'UNIQUE_VIOLATION';
  }
  let indexBefore = false;
  try {
    await rawRestored.exec(NS, 'CREATE INDEX qtask_i_userId ON docs (userId) USING HASH');
  } catch (error) {
    indexBefore = /already registered/i.test((error as Error).message);
  }
  note(`straight after restore, before the store connects: server unique constraint ${constraintBefore ? 'present' : 'ABSENT'}, userId index ${indexBefore ? 'present' : 'ABSENT'}` +
    (indexBefore ? '' : ' (the probe just created it)'));

  t0 = performance.now();
  const restoredStore = await openStore(restored, true); // declares, as the app does on start
  note(`the store's first connect to the restore re-declared constraints and indexes in ${seconds(performance.now() - t0)}`);
  let constraintAfter = false;
  try {
    await rawRestored.replace(NS, dupId, dupBody);
    await rawRestored.delete(NS, dupId);
  } catch (error) {
    constraintAfter = (error as { code?: string }).code === 'UNIQUE_VIOLATION';
  }
  check(constraintAfter, 'after the store connects to the restore: the server refuses a duplicate email (UNIQUE_VIOLATION)');
  let appDup = false;
  try {
    await restoredStore.collection('users').create({ email: existingUser.email });
  } catch (error) {
    appDup = error instanceof DuplicateKeyError || (error as { code?: number }).code === 11000;
  }
  check(appDup, 'after the store connects to the restore: users.create with an existing email is a duplicate key');
  const { declaredIndexes } = await import('../src/data/kdb/store.js');
  let indexesPresent = 0;
  const wanted = declaredIndexes();
  for (const [path, kind] of wanted) {
    try {
      await rawRestored.exec(NS, `CREATE INDEX qtask_i_${path.replace(/[^A-Za-z0-9_]/g, '_')} ON docs (${path}) USING ${kind}`);
    } catch (error) {
      if (/already registered/i.test((error as Error).message)) indexesPresent++;
    }
  }
  check(indexesPresent === wanted.size, `after the store connects to the restore: all ${wanted.size} lookup indexes present (${indexesPresent})`);
  t0 = performance.now();
  const heavy = dataset.userTaskCounts()[0]!;
  const heavyTasks = await restoredStore.collection('tasks').find({ userId: heavy.userId });
  note(`indexed read on the restore: tasks of the heaviest user, ${heavyTasks.length} rows in ${(performance.now() - t0).toFixed(0)} ms`);

  // --- 5: content of the online backup ----------------------------------------------------------
  const restoredTasks = restoredStore.collection('tasks');
  const restoredUsers = restoredStore.collection('users');
  let missingBefore = 0;
  let presentAfter = 0;
  let staleUpdates = 0;
  for (const ack of before) {
    if (ack.kind === 'updateTask') {
      const doc = await restoredTasks.findById(ack.id);
      if (!doc || Number(doc.sortOrder) < ack.value!) staleUpdates++;
    } else {
      const doc = await (ack.kind === 'createTask' ? restoredTasks : restoredUsers).findById(ack.id);
      if (!doc) missingBefore++;
    }
  }
  for (const ack of after) {
    if (ack.kind === 'updateTask') continue;
    const doc = await (ack.kind === 'createTask' ? restoredTasks : restoredUsers).findById(ack.id);
    if (doc) presentAfter++;
  }
  check(missingBefore === 0 && staleUpdates === 0, `every write acknowledged before the backup started is in the restore (${before.length} checked; missing ${missingBefore}, stale updates ${staleUpdates})`);
  check(presentAfter === 0, `no document created after the backup finished is in the restore (${after.filter((a) => a.kind !== 'updateTask').length} checked)`);
  const duringIn = (await Promise.all(during.filter((a) => a.kind !== 'updateTask').map(async (a) => (await (a.kind === 'createTask' ? restoredTasks : restoredUsers).findById(a.id)) !== null))).filter(Boolean).length;
  note(`of ${during.filter((a) => a.kind !== 'updateTask').length} documents created while the backup ran, ${duringIn} are in it (either is allowed)`);

  // Untouched documents identical; counts within bounds.
  t0 = performance.now();
  let compared = 0;
  let differing = 0;
  let absent = 0;
  for (const name of GENERATED) {
    const list = (ids.get(name) ?? []).filter((id) => !touched.has(id));
    const [a, b] = await Promise.all([readAll(store, name, list), readAll(restoredStore, name, list)]);
    for (const id of list) {
      const x = a.get(id);
      const y = b.get(id);
      if (!x && !y) continue; // expired on both sides
      compared++;
      if (!y || !x) { absent++; continue; }
      if (compareDocLists(name, 'drill', {}, [x], [y])) differing++;
    }
  }
  check(differing === 0 && absent === 0, `untouched documents identical in source and restore (${compared} compared, ${differing} differing, ${absent} on one side only; ${seconds(performance.now() - t0)})`);
  const createdTasks = (window: Ack[]) => window.filter((a) => a.kind === 'createTask').length;
  const createdUsers = (window: Ack[]) => window.filter((a) => a.kind === 'createUser').length;
  const restoredTaskCount = await restoredTasks.countDocuments({});
  const restoredUserCount = await restoredUsers.countDocuments({});
  const baseTasks = ids.get('tasks')!.length;
  const baseUsers = ids.get('users')!.length;
  check(restoredTaskCount >= baseTasks + createdTasks(before) && restoredTaskCount <= baseTasks + createdTasks(before) + createdTasks(during),
    `restored task count ${restoredTaskCount} within [${baseTasks + createdTasks(before)}, ${baseTasks + createdTasks(before) + createdTasks(during)}]`);
  check(restoredUserCount >= baseUsers + createdUsers(before) && restoredUserCount <= baseUsers + createdUsers(before) + createdUsers(during),
    `restored user count ${restoredUserCount} within [${baseUsers + createdUsers(before)}, ${baseUsers + createdUsers(before) + createdUsers(during)}]`);

  // Expiry continues on the restore.
  const restoredCodes = restoredStore.collection('mcpOAuthAuthorizationCodes');
  const liveNow = (await Promise.all(probeLive.map((id) => restoredCodes.findById(id)))).filter(Boolean).length;
  const pastNow = (await Promise.all(probePast.map((id) => restoredCodes.findById(id)))).filter(Boolean).length;
  check(pastNow === 0, `codes that had expired before the backup are not readable on the restore (${pastNow}/${probePast.length})`);
  const waitMs = soon.getTime() - Date.now();
  note(`codes still valid at restore time: ${liveNow}/${probeLive.length}; waiting ${seconds(Math.max(0, waitMs) + 5_000)} for them to expire`);
  check(liveNow === probeLive.length || waitMs <= 0, 'codes not yet expired are readable on the restore');
  await new Promise((r) => setTimeout(r, Math.max(0, waitMs) + 5_000));
  const liveLater = (await Promise.all(probeLive.map((id) => restoredCodes.findById(id)))).filter(Boolean).length;
  check(liveLater === 0, `after their expiry the restore no longer serves them (${liveLater}/${probeLive.length} left)`);
  const sweptCount = Number((await rawRestoredCount(rawRestored, probeLive, toDocumentUuid)));
  note(`expired codes physically swept by the restore's expiry sweeper: ${probeLive.length - sweptCount}/${probeLive.length}`);
  if (farFuture) check((await restoredStore.collection('mcpOAuthRefreshTokens').findById(farFuture._id as string)) !== null, 'a refresh token valid for weeks is still there');
  await rawRestored.close();
  await restoredStore.disconnect();
  await stopService(restored);

  // --- 6: quiesced backup with deploy/kdb-backup.sh, restore, full comparison -----------------------
  t0 = performance.now();
  const script = spawnSync('bash', [join(ROOT, 'deploy', 'kdb-backup.sh'), 'backup'], {
    encoding: 'utf8',
    env: { ...process.env, KDB_CONTROL_URL: `http://127.0.0.1:${source.control}`, KDB_BACKUP_DIR: source.backupDir, KDB_NAMESPACE: NS },
  });
  check(script.status === 0, `deploy/kdb-backup.sh backup (backup + verify + prune) exits 0 (${seconds(performance.now() - t0)})`);
  note(script.stderr.trim().split('\n').map((l) => `    ${l}`).join('\n'));
  const quietId = script.stdout.trim().split('\n').pop()!;
  const quietDir = join(DIR, 'restored-quiet');
  t0 = performance.now();
  const restore2 = spawnSync(inspectBin, ['restore', '--namespace', NS, '--from-backup', source.backupDir, '--backup-id', quietId, '--out', quietDir], { encoding: 'utf8' });
  check(restore2.status === 0, `restore of the quiesced backup exits 0 (${seconds(performance.now() - t0)})`);
  const { service: quiet, readyMs: quietReady } = await startService(serviceBin, quietDir, join(DIR, 'quiet-backups'), BASE_PORT + 20);
  t0 = performance.now();
  const quietStore = await openStore(quiet, true);
  note(`quiesced restore: ready in ${seconds(quietReady)}; constraints and indexes re-declared in ${seconds(performance.now() - t0)}`);
  t0 = performance.now();
  let allCompared = 0;
  let allDiffering = 0;
  let countMismatch = 0;
  const allIds = new Map<CollectionName, string[]>(ids);
  allIds.set('tasks', [...(ids.get('tasks') ?? []), ...acks.filter((a) => a.kind === 'createTask').map((a) => a.id)]);
  allIds.set('users', [...(ids.get('users') ?? []), ...acks.filter((a) => a.kind === 'createUser').map((a) => a.id)]);
  allIds.set('mcpOAuthAuthorizationCodes', [...(ids.get('mcpOAuthAuthorizationCodes') ?? []), ...probeLive, ...probePast]);
  for (const name of GENERATED) {
    const list = allIds.get(name) ?? [];
    const [a, b] = await Promise.all([readAll(store, name, list), readAll(quietStore, name, list)]);
    const [ca, cb] = await Promise.all([store.collection(name).countDocuments({}), quietStore.collection(name).countDocuments({})]);
    if (ca !== cb) {
      countMismatch++;
      note(`    count differs for ${name}: source ${ca}, restore ${cb}`);
    }
    for (const id of list) {
      const x = a.get(id);
      const y = b.get(id);
      if (!x && !y) continue;
      allCompared++;
      if (!x || !y || compareDocLists(name, 'drill', {}, [x], [y])) allDiffering++;
    }
  }
  check(countMismatch === 0, `quiesced restore: every collection's count equals the source's (${GENERATED.length} collections)`);
  check(allDiffering === 0, `quiesced restore: every document identical to the source (${allCompared} compared, ${allDiffering} differing; ${seconds(performance.now() - t0)})`);
  await quietStore.disconnect();
  await stopService(quiet);

  await store.disconnect();
  await stopService(source);
  note(`sizes: source ${du(source.dataDir)}, backups ${du(source.backupDir)} (${readdirSync(join(source.backupDir, 'backups', ...NS.split('/'))).length} kept), restored ${du(restoredDir)}, quiesced restore ${du(quietDir)}`);
  note(failures.length === 0 ? 'DRILL PASSED' : `DRILL FAILED: ${failures.length} check(s)`);
  if (!KEEP) rmSync(DIR, { recursive: true, force: true });
  if (failures.length) process.exitCode = 1;
}

/** How many of these documents still exist physically (a keyed SQL lookup sees through nothing). */
async function rawRestoredCount(raw: RawClient, ids: string[], toUuid: (id: string) => string): Promise<number> {
  const client = raw as unknown as { queryRaw(ns: string, sql: string, args: unknown[]): Promise<{ rows: string[][] }> };
  const uuids = ids.map(toUuid);
  const { rows } = await client.queryRaw(NS, `SELECT kdb_id FROM docs WHERE kdb_id IN (${uuids.map(() => '?').join(', ')})`, uuids);
  return rows.length;
}

void statSync;
main().catch((error) => {
  console.error((error as Error).stack ?? error);
  process.exitCode = 1;
});
