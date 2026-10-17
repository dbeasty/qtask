/**
 * MongoDB vs KDB, each in a Docker container limited to the same CPUs and memory, driven through
 * qtask's own data layer. One command:
 *
 *   npm run bench:docker -- --scale prod --duration 120
 *
 * See bench/README.md for the workload model, every option, and how to read the report.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import { join, relative } from 'node:path';
import {
  DEFAULT_LIMITS, MONGO_IMAGE, PREFIX, ROOT, StatsSampler, containerLogs, copyVolume, dropCaches,
  engineInfo, ensureImage, fsyncProbe, ensureKdbImage, imageDigest, inspectLimits, removeContainer, startContainer,
  startExisting, stopContainer, volumeBytes, volumeExists, waitForHttpOk, waitForTcp, type Limits,
} from './lib/docker.ts';
import { SCALES } from './lib/dataset.ts';
import { Histogram, type HistogramData, type LatencySummary } from './lib/stats.ts';
import { writeReport } from './lib/report.ts';
import type { WorkerTask } from './worker.ts';

// --- options ----------------------------------------------------------------------------------

interface Options {
  scale: string;
  seed: number;
  duration: number;
  warmup: number;
  concurrency: number[];
  profiles: string[];
  backends: string[];
  cpus: number;
  memory: string;
  ollamaDelay: number;
  coldRuns: number;
  reuseData: boolean;
  verifyLoad: boolean;
  out: string;
  kdbVersion: string;
  reset: 'profile' | 'cell';
  reportOnly?: string;
  /** Client (load generator) processes per cell; sessions are split across them. */
  clients: number;
  /** Dataset shape overrides on top of the scale preset (--users, --tasks, --embedding-dims). */
  overrides: Record<string, number>;
  crosscheckUsers: number;
}

function parseOptions(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    if (inline !== undefined) flags.set(key, inline);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags.set(key, argv[++i]!);
    else flags.set(key, 'true');
  }
  const scale = flags.get('scale') ?? 'prod';
  if (!SCALES[scale]) throw new Error(`--scale must be one of ${Object.keys(SCALES).join(', ')}`);
  const smoke = scale === 'smoke';
  const list = (key: string, fallback: string) => (flags.get(key) ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const options: Options = {
    scale,
    seed: Number(flags.get('seed') ?? 42),
    duration: Number(flags.get('duration') ?? (smoke ? 10 : 120)),
    warmup: Number(flags.get('warmup') ?? (smoke ? 3 : 15)),
    concurrency: list('concurrency', smoke ? '1,8' : '1,8,32,64').map(Number),
    profiles: list('profiles', 'mixed,read-heavy,write-heavy,claim'),
    backends: list('backends', 'mongo,mongo-j,kdb,kdb-async'),
    clients: Number(flags.get('clients') ?? 4),
    overrides: Object.fromEntries(
      ([['users', 'users'], ['tasks', 'tasks'], ['embedding-dims', 'embeddingDims']] as const)
        .filter(([flag]) => flags.has(flag))
        .map(([flag, key]) => [key, Number(flags.get(flag))])
    ),
    crosscheckUsers: Number(flags.get('crosscheck-users') ?? (scale === 'prod' ? 3 : 25)),
    cpus: Number(flags.get('cpus') ?? DEFAULT_LIMITS.cpus),
    memory: flags.get('memory') ?? DEFAULT_LIMITS.memory,
    ollamaDelay: Number(flags.get('ollama-delay') ?? 100),
    coldRuns: Number(flags.get('cold-runs') ?? (smoke ? 1 : 3)),
    reuseData: flags.get('reuse-data') !== 'false',
    verifyLoad: flags.get('verify-load') !== undefined ? flags.get('verify-load') !== 'false' : scale !== 'prod',
    out: flags.get('out') ?? join(ROOT, 'bench/results', `${stamp}-${scale}`),
    kdbVersion: flags.get('kdb-version') ?? '0.9.2',
    reset: (flags.get('reset') ?? 'profile') as 'profile' | 'cell',
    reportOnly: flags.get('report-only'),
  };
  for (const b of options.backends) if (!['mongo', 'mongo-j', 'kdb', 'kdb-async'].includes(b)) throw new Error(`unknown backend ${b}`);
  for (const p of options.profiles) if (!['mixed', 'read-heavy', 'write-heavy', 'claim'].includes(p)) throw new Error(`unknown profile ${p}`);
  if (options.reset !== 'profile' && options.reset !== 'cell') throw new Error('--reset is profile or cell');
  return options;
}

// --- fixed names and ports (8411-8499) --------------------------------------------------------

const MONGO_PORT = 8411;
const KDB_PORT = 8412;
const KDB_ADMIN_PORT = 8413;
const MONGO_CONTAINER = `${PREFIX}-mongo`;
const KDB_CONTAINER = `${PREFIX}-kdb`;
const MONGO_WORK = `${PREFIX}-mongo-work`;
const KDB_WORK = `${PREFIX}-kdb-work`;
const NAMESPACE = 'qtask/docs'; // deploy/qtask-kdb.service

const dbOf = (backend: string): 'mongo' | 'kdb' => (backend.startsWith('kdb') ? 'kdb' : 'mongo');

/** Names a dataset: scale, seed and any overrides, so a changed shape never reuses an old one. */
const datasetKey = (o: Options) => [o.scale, `s${o.seed}`, ...Object.entries(o.overrides).sort().map(([k, v]) => `${k}${v}`)].join('-').toLowerCase();
const pristine = (o: Options, db: 'mongo' | 'kdb') => `${PREFIX}-${datasetKey(o)}-${db}-pristine`;
const cacheDir = (o: Options) => join(ROOT, 'bench/.cache', datasetKey(o));

function mongoArgs(): string[] {
  // mongo:7 defaults: WiredTiger, journaling on, cache sized from the container's memory limit.
  return [];
}

function kdbArgs(durability: 'sync' | 'async'): string[] {
  // As deploy/qtask-kdb.service runs it, bound inside the container instead of on loopback.
  return [
    '--data-dir', '/var/lib/kdb',
    '--namespace', NAMESPACE,
    '--sql-addr', 'tcp://0.0.0.0:9090?bind=true',
    '--admin-addr', '0.0.0.0:9093',
    '--peer-addr', '',
    '--stream-addr', '',
    '--expire-field', '_expireAt',
    // How often kdb-service sweeps for expired documents. v0.8.0's sweep reads every document in
    // the namespace (profiled: 85% of an idle server's CPU at 517k documents), so this setting
    // alone decides how much of the CPU limit is left for queries. BENCH_KDB_EXPIRE_INTERVAL
    // measures that; the default is what deploy/qtask-kdb.service uses.
    '--expire-interval', process.env.BENCH_KDB_EXPIRE_INTERVAL ?? '1m',
    '--durability', durability,
    '--log-format', 'json',
    '--log-level', 'warn',
  ];
}

/** The environment the app would run with, per backend. */
function appEnv(backend: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    QTASK_SKIP_DOTENV: 'true',
    LOG_LEVEL: 'warn',
    JWT_SECRET: 'bench', ADMIN_JWT_SECRET: 'bench', MCP_OAUTH_JWT_SECRET: 'bench',
    SECRETS_BACKEND: 'env',
  };
  delete base.DATA_SHADOW_WRITES;
  delete base.DATA_SHADOW_READS;
  const mongoUri = `mongodb://127.0.0.1:${MONGO_PORT}/qtask${backend === 'mongo-j' ? '?w=1&journal=true' : ''}`;
  const kdb = {
    KDB_ADDR: `tcp://127.0.0.1:${KDB_PORT}`,
    KDB_NAMESPACE_PREFIX: NAMESPACE,
    // What docs/KDB_MIGRATION.md tells a deployment to run with: pushdown on, constraints and
    // lookup indexes declared (the last two are the defaults).
    DATA_KDB_PUSHDOWN: 'true',
    DATA_KDB_DECLARE_CONSTRAINTS: 'true',
    DATA_KDB_DECLARE_INDEXES: 'true',
  };
  if (dbOf(backend) === 'kdb') return { ...base, DATA_KDB: 'true', DATA_MONGO: undefined, MONGODB_URI: mongoUri, ...kdb };
  return { ...base, DATA_MONGO: 'true', DATA_KDB: undefined, MONGODB_URI: mongoUri, ...kdb };
}

// --- processes --------------------------------------------------------------------------------

const TSX = join(ROOT, 'node_modules/.bin/tsx');

function runProcess(args: string[], env: NodeJS.ProcessEnv, onLine?: (line: string) => void, onSpawn?: (child: ChildProcess) => void): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(TSX, args, { cwd: ROOT, env, stdio: [onSpawn ? 'pipe' : 'ignore', 'inherit', 'pipe'] });
    onSpawn?.(child);
    let buffer = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (onLine) onLine(line);
        if (!line.startsWith('READY')) process.stderr.write(`  ${line}\n`);
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

async function runWorker<T>(backend: string, task: WorkerTask, outFile: string, onLine?: (line: string) => void, onSpawn?: (child: ChildProcess) => void): Promise<T> {
  const env: NodeJS.ProcessEnv = { ...appEnv(backend), BENCH_TASK: JSON.stringify(task), BENCH_OUT: outFile };
  // Measured cells keep the app's request deadline (the KDB client's 30 s default), so a request
  // that would time out in production times out here and is counted. Setup, cross-check, integrity
  // and cold-start workers are there to get an answer, however long it takes.
  if (task.mode !== 'run' && task.mode !== 'claim') env.KDB_REQUEST_TIMEOUT_MS = '900000';
  const code = await runProcess([join(ROOT, 'bench/worker.ts')], env, onLine, onSpawn);
  const result = existsSync(outFile) ? (JSON.parse(readFileSync(outFile, 'utf8')) as T & { error?: string }) : undefined;
  if (code !== 0 || !result || result.error) throw new Error(`worker ${task.mode} (${backend}) failed: ${result?.error ?? `exit ${code}`}`);
  return result;
}

// --- containers -------------------------------------------------------------------------------

interface Images { mongo: string; kdb: string; kdbSource: string }

async function startMongo(o: Options, images: Images, volume = MONGO_WORK): Promise<number> {
  const limits: Limits = { cpus: o.cpus, memory: o.memory };
  const t0 = performance.now();
  await startContainer({ name: MONGO_CONTAINER, image: images.mongo, volume, mountPath: '/data/db', ports: [[MONGO_PORT, 27017]], args: mongoArgs(), limits });
  await waitForTcp(MONGO_PORT);
  // The port opens before mongod accepts commands; a ping is the real readiness.
  for (;;) {
    const out = await new Promise<string>((done) => {
      const child = spawn('docker', ['exec', MONGO_CONTAINER, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let s = '';
      child.stdout.on('data', (d) => (s += d));
      child.on('exit', () => done(s.trim()));
    });
    if (out === '1') break;
    if (performance.now() - t0 > 120_000) throw new Error(`mongod did not become ready:\n${await containerLogs(MONGO_CONTAINER)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return performance.now() - t0;
}

async function startKdb(o: Options, images: Images, durability: 'sync' | 'async', volume = KDB_WORK): Promise<number> {
  const limits: Limits = { cpus: o.cpus, memory: o.memory };
  const t0 = performance.now();
  await startContainer({ name: KDB_CONTAINER, image: images.kdb, volume, mountPath: '/var/lib/kdb', ports: [[KDB_PORT, 9090], [KDB_ADMIN_PORT, 9093]], args: kdbArgs(durability), limits });
  try {
    await waitForHttpOk(`http://127.0.0.1:${KDB_ADMIN_PORT}/readyz`, 300_000);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${await containerLogs(KDB_CONTAINER)}`);
  }
  return performance.now() - t0;
}

const containerOf = (backend: string) => (dbOf(backend) === 'kdb' ? KDB_CONTAINER : MONGO_CONTAINER);

// --- phases -----------------------------------------------------------------------------------

interface DatasetInfo {
  scale: string;
  seed: number;
  counts: Record<string, number>;
  mongoLoad?: unknown;
  kdbBackfillSeconds?: number;
  verify?: { ok: boolean; output: string };
  crosscheck?: unknown;
  bytes: { mongo: number; kdb: number };
  indexPath: string;
}

async function prepareDataset(o: Options, images: Images): Promise<DatasetInfo> {
  const dir = cacheDir(o);
  const infoPath = join(dir, 'dataset.json');
  if (o.reuseData && existsSync(infoPath) && (await volumeExists(pristine(o, 'mongo'))) && (await volumeExists(pristine(o, 'kdb')))) {
    console.log(`reusing dataset ${o.scale}/seed ${o.seed} (pristine volumes exist; --reuse-data false to rebuild)`);
    return JSON.parse(readFileSync(infoPath, 'utf8')) as DatasetInfo;
  }
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, 'index.json');
  console.log(`\n== dataset: generating ${o.scale} (seed ${o.seed}) into MongoDB ==`);
  await removeContainer(MONGO_CONTAINER);
  await removeContainer(KDB_CONTAINER);
  for (const v of [MONGO_WORK, KDB_WORK]) await copyVolumeReset(v);
  await startMongo(o, images);
  const mongoLoad = await runWorker<{ counts: Record<string, number> }>('mongo', { mode: 'load', scale: o.scale, seed: o.seed, indexPath, overrides: o.overrides }, join(dir, 'load.json'));
  console.log(`   loaded: ${JSON.stringify(mongoLoad)}`);

  console.log('== dataset: backfilling KDB from MongoDB (npm run migrate:kdb -- backfill) ==');
  // Loaded with --durability async (acknowledged once queued) to save time; a graceful stop then
  // flushes everything, and every measurement runs with --durability sync.
  await startKdb(o, images, 'async');
  const t0 = performance.now();
  const code = await runProcess([join(ROOT, 'src/scripts/migrate-mongo-to-kdb.ts'), 'backfill'], appEnv('kdb'));
  if (code !== 0) throw new Error(`backfill failed (exit ${code})`);
  const kdbBackfillSeconds = (performance.now() - t0) / 1000;

  let verify: DatasetInfo['verify'];
  if (o.verifyLoad) {
    console.log('== dataset: verifying the copy (npm run migrate:kdb -- verify) ==');
    const lines: string[] = [];
    const vcode = await new Promise<number>((done) => {
      const child = spawn(TSX, [join(ROOT, 'src/scripts/migrate-mongo-to-kdb.ts'), 'verify'], { cwd: ROOT, env: appEnv('kdb'), stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { process.stdout.write(d); lines.push(d); });
      child.on('exit', (c) => done(c ?? 1));
    });
    verify = { ok: vcode === 0, output: lines.join('') };
    if (!verify.ok) console.warn('   VERIFY REPORTED DIFFERENCES (see report)');
  }

  console.log('== dataset: cross-checking query answers on both backends ==');
  const crosscheck = await runWorker('kdb', { mode: 'crosscheck', indexPath, users: o.crosscheckUsers }, join(dir, 'crosscheck.json'));
  console.log(`   ${JSON.stringify({ checks: (crosscheck as { checks: number }).checks, failed: (crosscheck as { failed: number }).failed })}`);

  await stopContainer(MONGO_CONTAINER);
  await stopContainer(KDB_CONTAINER);
  await removeContainer(MONGO_CONTAINER);
  await removeContainer(KDB_CONTAINER);
  await copyVolume(MONGO_WORK, pristine(o, 'mongo'));
  await copyVolume(KDB_WORK, pristine(o, 'kdb'));
  const info: DatasetInfo = {
    scale: o.scale,
    seed: o.seed,
    counts: (mongoLoad as { counts: Record<string, number> }).counts,
    mongoLoad,
    kdbBackfillSeconds,
    verify,
    crosscheck,
    bytes: { mongo: await volumeBytes(pristine(o, 'mongo')), kdb: await volumeBytes(pristine(o, 'kdb')) },
    indexPath,
  };
  writeFileSync(infoPath, JSON.stringify(info, null, 2));
  return info;
}

async function copyVolumeReset(volume: string): Promise<void> {
  const { removeVolume, createVolume } = await import('./lib/docker.ts');
  await removeVolume(volume);
  await createVolume(volume);
}

async function restore(o: Options, db: 'mongo' | 'kdb'): Promise<void> {
  await removeContainer(db === 'kdb' ? KDB_CONTAINER : MONGO_CONTAINER);
  await copyVolume(pristine(o, db), db === 'kdb' ? KDB_WORK : MONGO_WORK);
}

async function startBackend(o: Options, images: Images, backend: string): Promise<number> {
  if (backend === 'kdb') return startKdb(o, images, 'sync');
  if (backend === 'kdb-async') return startKdb(o, images, 'async');
  return startMongo(o, images);
}

interface CellResult {
  backend: string;
  profile: string;
  concurrency: number;
  [key: string]: unknown;
}

type RawCell = {
  backend: string;
  sessions: number;
  seconds: number;
  cpuMs: number;
  reads: number;
  writes: number;
  actions: Record<string, HistogramData>;
  ops: Record<string, HistogramData>;
  errors: Record<string, { count: number; sample: string }>;
  claim?: { claims: number; empty: number; doubleClaimsInProcess: number; pairs: string[] };
  unfinished: number;
  connectMs: number;
};

function mergeHistograms(raws: Array<Record<string, HistogramData>>): Map<string, Histogram> {
  const out = new Map<string, Histogram>();
  for (const raw of raws) {
    for (const [key, data] of Object.entries(raw)) {
      const h = Histogram.from(data);
      const existing = out.get(key);
      if (existing) existing.merge(h);
      else out.set(key, h);
    }
  }
  return out;
}

function summarize(map: Map<string, Histogram>, seconds: number): Record<string, LatencySummary & { perSec: number }> {
  return Object.fromEntries([...map.entries()].sort().map(([k, h]) => [k, { ...h.summary(), perSec: h.count / seconds }]));
}

/** Splits `concurrency` sessions over at most `clients` processes, as evenly as possible. */
function splitSessions(concurrency: number, clients: number): number[] {
  const k = Math.max(1, Math.min(clients, concurrency));
  return Array.from({ length: k }, (_, i) => Math.floor(concurrency / k) + (i < concurrency % k ? 1 : 0));
}

async function runCell(o: Options, backend: string, profile: string, concurrency: number, info: DatasetInfo, dir: string, salt: number): Promise<CellResult> {
  const container = containerOf(backend);
  const sampler = new StatsSampler(container);
  sampler.start();
  const split = splitSessions(concurrency, o.clients);
  const claim = profile === 'claim';
  // Every client process connects, says READY, and waits. Once all have, the warmup starts and
  // every process is handed the same absolute window, so a slow connect (KDB declares its
  // constraints and indexes on connect) never eats into what is measured.
  const children: ChildProcess[] = [];
  let ready = 0;
  let stats: ReturnType<StatsSampler['stop']> | undefined;
  let resetTimer: NodeJS.Timeout | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  const openWindow = () => {
    const measureStartAt = Date.now() + o.warmup * 1000;
    const measureEndAt = measureStartAt + o.duration * 1000;
    resetTimer = setTimeout(() => sampler.reset(), measureStartAt - Date.now());
    stopTimer = setTimeout(() => (stats = sampler.stop()), measureEndAt - Date.now());
    for (const child of children) child.stdin?.write(`${JSON.stringify({ measureStartAt, measureEndAt })}\n`);
  };
  const raws = await Promise.all(split.map((sessions, i) => runWorker<RawCell>(backend, {
    mode: claim ? 'claim' : 'run',
    profile,
    concurrency: sessions,
    indexPath: info.indexPath,
    salt: salt * 16 + i,
    ollamaDelayMs: o.ollamaDelay,
    embeddingWorker: i === 0,
  }, join(dir, 'raw', `${backend}-${profile}-c${concurrency}-p${i}.json`), (line) => {
    if (line.startsWith('READY') && ++ready === split.length) openWindow();
  }, (child) => children.push(child))));
  clearTimeout(resetTimer);
  clearTimeout(stopTimer);
  for (const child of children) child.stdin?.end();
  stats ??= sampler.stop();

  const seconds = o.duration;
  const actions = mergeHistograms(raws.map((r) => r.actions));
  const total = new Histogram();
  for (const [name, h] of actions) if (!name.startsWith('bg:')) total.merge(h);
  const errors: Record<string, { count: number; sample: string }> = {};
  for (const r of raws) for (const [k, v] of Object.entries(r.errors)) {
    errors[k] = { count: (errors[k]?.count ?? 0) + v.count, sample: errors[k]?.sample ?? v.sample };
  }
  const reads = raws.reduce((s, r) => s + r.reads, 0);
  const writes = raws.reduce((s, r) => s + r.writes, 0);
  const cell: CellResult = {
    backend,
    profile,
    concurrency,
    clientProcesses: split.length,
    clientConnectMs: raws.map((r) => Math.round(r.connectMs)),
    sessionsPerProcess: split,
    seconds,
    actionsPerSec: total.count / seconds,
    opsPerSec: (reads + writes) / seconds,
    reads,
    writes,
    errors,
    errorCount: Object.values(errors).reduce((s, e) => s + e.count, 0),
    unfinished: raws.reduce((s, r) => s + r.unfinished, 0),
    // Sum over client processes (100% = one core), and the busiest single process, which is the
    // one to watch: near 100% means the client, not the database, was the limit.
    clientCpuPct: (raws.reduce((s, r) => s + r.cpuMs, 0) / (seconds * 1000)) * 100,
    clientCpuPctMaxProcess: Math.max(...raws.map((r) => (r.cpuMs / (seconds * 1000)) * 100)),
    allActions: total.summary(),
    actions: summarize(actions, seconds),
    ops: summarize(mergeHistograms(raws.map((r) => r.ops)), seconds),
    container: stats,
    limits: await inspectLimits(container),
  };
  if (claim) {
    const claims = raws.reduce((s, r) => s + (r.claim?.claims ?? 0), 0);
    const empty = raws.reduce((s, r) => s + (r.claim?.empty ?? 0), 0);
    const seen = new Set<string>();
    let duplicatePairs = 0;
    for (const r of raws) for (const p of r.claim?.pairs ?? []) {
      if (seen.has(p)) duplicatePairs++;
      seen.add(p);
    }
    const check = await runWorker<{ stuckProcessing: number; pendingAfter: number }>(backend, { mode: 'integrity' }, join(dir, 'raw', `${backend}-claim-c${concurrency}-integrity.json`));
    Object.assign(cell, {
      actionsPerSec: claims / seconds,
      claims,
      emptyClaims: empty,
      emptyClaimPct: claims + empty ? (100 * empty) / (claims + empty) : 0,
      // Same (job, attempts) seen twice = two claims of one job from the same state.
      doubleClaims: duplicatePairs + raws.reduce((s, r) => s + (r.claim?.doubleClaimsInProcess ?? 0), 0),
      stuckProcessing: check.stuckProcessing,
      pendingAfter: check.pendingAfter,
    });
  }
  return cell;
}

async function coldStart(o: Options, images: Images, backend: string, info: DatasetInfo, dir: string): Promise<unknown[]> {
  const db = dbOf(backend);
  await restore(o, db);
  // A first start after the restore, so one-time work (index declaration, which is idempotent)
  // is not counted as cold start.
  await startBackend(o, images, backend);
  await stopContainer(containerOf(backend));
  const runs: unknown[] = [];
  for (let i = 0; i < o.coldRuns; i++) {
    const cachesDropped = await dropCaches();
    const t0 = Date.now();
    await startExisting(containerOf(backend));
    // The worker starts at once and retries until the database answers. (Docker's port proxy
    // accepts connections before the database listens, so an open port proves nothing.)
    const worker = await runWorker<{ connectMs: number; connectAttempts: number; firstReadMs: number; firstListMs: number; firstQueryDoneAt: number; processReadyAt: number }>(
      backend, { mode: 'cold', indexPath: info.indexPath }, join(dir, 'raw', `${backend}-cold-${i}.json`)
    );
    runs.push({
      cachesDropped,
      clientProcessStartupMs: worker.processReadyAt - t0,
      connectMs: worker.connectMs,
      connectAttempts: worker.connectAttempts,
      firstReadMs: worker.firstReadMs,
      firstListMs: worker.firstListMs,
      startToFirstListMs: worker.firstQueryDoneAt - t0,
    });
    await stopContainer(containerOf(backend));
  }
  await removeContainer(containerOf(backend));
  return runs;
}


// --- main -------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  if (o.reportOnly) {
    const results = JSON.parse(readFileSync(join(o.reportOnly, 'results.json'), 'utf8'));
    writeReport(o.reportOnly, results);
    console.log(`report: ${join(o.reportOnly, 'report.md')}`);
    return;
  }
  mkdirSync(join(o.out, 'raw'), { recursive: true });
  const started = new Date();
  const engine = await engineInfo();
  await ensureImage(MONGO_IMAGE);
  const kdbImage = await ensureKdbImage(o.kdbVersion);
  const images: Images = { mongo: MONGO_IMAGE, kdb: kdbImage.image, kdbSource: kdbImage.source };
  console.log(`engine: ${engine.os} ${engine.arch}, ${engine.ncpu} CPUs, ${(engine.memBytes / 2 ** 30).toFixed(1)} GiB; limits per database: ${o.cpus} CPUs, ${o.memory} (no swap)`);
  console.log(`plan: scale=${o.scale} backends=${o.backends} profiles=${o.profiles} concurrency=${o.concurrency} duration=${o.duration}s warmup=${o.warmup}s`);

  const info = await prepareDataset(o, images);
  // Measured with nothing else running, on the volume the databases use.
  const fsync = await fsyncProbe(MONGO_WORK, images.mongo);
  console.log(`volume fsync probe: ${JSON.stringify(fsync)}`);
  const cells: CellResult[] = [];
  const cold: Record<string, unknown[]> = {};
  const after: Record<string, number> = {};
  const results = () => ({
    meta: {
      started: started.toISOString(),
      finished: new Date().toISOString(),
      options: o,
      host: { platform: platform(), release: release(), cpus: cpus().length, cpuModel: cpus()[0]?.model, memBytes: totalmem(), node: process.version },
      engine,
      fsync,
      images: { mongo: images.mongo, mongoDigest: '', kdb: images.kdb, kdbSource: images.kdbSource },
      kdbArgs: kdbArgs('sync'),
      mongoUri: { mongo: appEnv('mongo').MONGODB_URI, 'mongo-j': appEnv('mongo-j').MONGODB_URI },
      kdbEnv: Object.fromEntries(Object.entries(appEnv('kdb')).filter(([k]) => k.startsWith('DATA_KDB') || k.startsWith('KDB_'))),
    },
    dataset: { ...info, indexPath: relative(ROOT, info.indexPath) },
    cells,
    cold,
    bytesAfterRun: after,
  });
  const save = () => {
    const r = results();
    writeFileSync(join(o.out, 'results.json'), JSON.stringify(r, null, 2));
    writeReport(o.out, r);
  };
  const digests = { mongo: await imageDigest(images.mongo), kdb: await imageDigest(images.kdb) };

  let salt = 1;
  for (const backend of o.backends) {
    const db = dbOf(backend);
    for (const profile of o.profiles) {
      for (const [i, concurrency] of o.concurrency.entries()) {
        if (i === 0 || o.reset === 'cell') {
          await restore(o, db);
          await startBackend(o, images, backend);
        }
        console.log(`\n== ${backend} / ${profile} / ${concurrency} concurrent (${o.warmup}s warmup + ${o.duration}s) ==`);
        let cell: CellResult;
        try {
          cell = await runCell(o, backend, profile, concurrency, info, o.out, salt++);
        } catch (error) {
          // One failed cell (a crashed client, a database that fell over) is a result, not a
          // reason to lose the rest of a multi-hour run. Recorded, reported, and the profile is
          // restarted from pristine data.
          console.error(`   CELL FAILED: ${(error as Error).message.slice(0, 500)}`);
          cells.push({ backend, profile, concurrency, failed: (error as Error).message.slice(0, 2000), containerLogs: await containerLogs(containerOf(backend), 30) });
          save();
          await removeContainer(containerOf(backend));
          if (i < o.concurrency.length - 1 && o.reset !== 'cell') {
            await restore(o, db);
            await startBackend(o, images, backend);
          }
          continue;
        }
        cells.push(cell);
        const c = cell as unknown as { actionsPerSec: number; opsPerSec: number; errorCount: number; allActions: { p50Ms: number; p99Ms: number }; container: { cpuPctAvg: number; memBytesMax: number }; clientCpuPct: number };
        console.log(`   ${c.actionsPerSec.toFixed(1)} actions/s, ${c.opsPerSec.toFixed(1)} ops/s, p50 ${c.allActions.p50Ms.toFixed(2)} ms, p99 ${c.allActions.p99Ms.toFixed(2)} ms, errors ${c.errorCount}, db cpu ${c.container.cpuPctAvg.toFixed(0)}%, db mem ${(c.container.memBytesMax / 2 ** 20).toFixed(0)} MiB, client cpu ${c.clientCpuPct.toFixed(0)}%`);
        if (i === o.concurrency.length - 1 || o.reset === 'cell') {
          await stopContainer(containerOf(backend));
          after[`${backend}/${profile}`] = await volumeBytes(db === 'kdb' ? KDB_WORK : MONGO_WORK);
          await removeContainer(containerOf(backend));
        }
        save();
      }
    }
    if (o.coldRuns > 0) {
      console.log(`\n== ${backend} / cold start x${o.coldRuns} ==`);
      try {
        cold[backend] = await coldStart(o, images, backend, info, o.out);
      } catch (error) {
        console.error(`   COLD START FAILED: ${(error as Error).message.slice(0, 500)}`);
        cold[backend] = [{ failed: (error as Error).message.slice(0, 2000) }];
        await removeContainer(containerOf(backend));
      }
      console.log(`   ${JSON.stringify(cold[backend])}`);
      save();
    }
  }
  const final = results();
  final.meta.images.mongoDigest = digests.mongo;
  (final.meta.images as Record<string, string>).kdbDigest = digests.kdb;
  writeFileSync(join(o.out, 'results.json'), JSON.stringify(final, null, 2));
  writeReport(o.out, final);
  console.log(`\nresults: ${join(o.out, 'results.json')}\nreport:  ${join(o.out, 'report.md')}  (and report.html)`);
}

main().catch(async (error) => {
  console.error(error);
  // Leave nothing running; the volumes stay for inspection.
  await removeContainer(MONGO_CONTAINER).catch(() => undefined);
  await removeContainer(KDB_CONTAINER).catch(() => undefined);
  process.exitCode = 1;
});
