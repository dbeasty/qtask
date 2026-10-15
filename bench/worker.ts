/**
 * One benchmark process. The orchestrator (bench/docker.ts) starts one per measurement, with the
 * backend chosen the way a deployment chooses it - DATA_MONGO / DATA_KDB and the DATA_KDB_*
 * flags in the environment - so what runs is the application's own data layer, connected through
 * its own connectData(). A fresh process per cell also means a fresh client, pool and in-process
 * lock table every time.
 *
 * Input: BENCH_TASK (JSON). Output: BENCH_OUT (a JSON file). Progress on stderr.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { Histogram, rng } from './lib/stats.ts';
import { generate, SCALES, type DatasetIndex } from './lib/dataset.ts';
import {
  OpRecorder, PROFILES, Workload, claimVisionJob, claimEmbeddingJob, completeAndRequeueVisionJob,
  instrument, processEmbeddingJob, type ActionName, type CollectionFn,
} from './lib/workload.ts';
import type { Doc } from '../src/data/types.ts';

export interface WorkerTask {
  mode: 'load' | 'run' | 'claim' | 'integrity' | 'cold' | 'crosscheck';
  /** crosscheck: how many users to ask about. */
  users?: number;
  /** load: overrides on the scale preset. */
  overrides?: Record<string, number>;
  scale?: string;
  seed?: number;
  indexPath?: string;
  profile?: string;
  /** Simulated users (or claim workers) in this process. */
  concurrency?: number;
  salt?: number;
  /** Run the background embedding worker in this process (one process per cell does). */
  embeddingWorker?: boolean;

  /** Simulated Ollama time per embedding job in the background worker (ms); <0 disables it. */
  ollamaDelayMs?: number;
}

const task = JSON.parse(process.env.BENCH_TASK ?? '{}') as WorkerTask;
const outPath = process.env.BENCH_OUT!;
const log = (...args: unknown[]) => console.error(`[worker ${task.mode}]`, ...args);

await import('../src/models/index.ts');

async function connectApp(): Promise<{ c: CollectionFn; close: () => Promise<void>; backend: string }> {
  const { connectData, disconnectData, collection, getDataStore } = await import('../src/data/index.ts');
  await connectData();
  return { c: collection as unknown as CollectionFn, close: disconnectData, backend: getDataStore().backend };
}

// --- load: generate the dataset into MongoDB --------------------------------------------------

async function load(): Promise<unknown> {
  const preset = SCALES[task.scale ?? 'smoke'];
  if (!preset) throw new Error(`unknown scale ${task.scale}`);
  const scale = { ...preset, ...(task.overrides ?? {}) };
  const { connectData } = await import('../src/data/index.ts');
  await connectData(); // the Mongo store: connect + the app's index sync
  const { MODEL_BY_COLLECTION } = await import('../src/data/modelNames.ts');
  // Make sure every model's indexes exist before data goes in (autoIndex builds them lazily).
  await Promise.all(Object.values(MODEL_BY_COLLECTION).map((name) => mongoose.models[name]!.init()));
  const started = performance.now();
  let docs = 0;
  let lastLog = started;
  const index = await generate(scale, task.seed ?? 42, async ({ collection, docs: batch }) => {
    const model = mongoose.models[MODEL_BY_COLLECTION[collection as keyof typeof MODEL_BY_COLLECTION]]!;
    // The app's own Mongoose model, so documents are cast and validated exactly as the app's
    // writes are; timestamps off so the generated createdAt/updatedAt survive.
    await model.insertMany(batch, { timestamps: false } as never);
    docs += batch.length;
    if (performance.now() - lastLog > 5_000) {
      lastLog = performance.now();
      log(`${docs} documents (${Math.round(docs / ((lastLog - started) / 1000))}/s)`);
    }
  });
  const seconds = (performance.now() - started) / 1000;
  writeFileSync(task.indexPath!, JSON.stringify(index));
  await mongoose.disconnect();
  return { counts: index.counts, documents: docs, seconds, docsPerSec: docs / seconds };
}

// --- the measurement window ---------------------------------------------------------------------

/**
 * Every client process measures the same wall-clock window: the orchestrator hands out absolute
 * start and end times, so several processes started a few hundred ms apart still agree on what
 * was measured, and the container stats are sampled over exactly that window.
 */
async function awaitWindow(connectMs: number): Promise<{ start: number; end: number }> {
  // Connected: say so, then wait for the orchestrator to open the window, which it does once
  // every client process of the cell is connected (a slow connect cannot eat into the window).
  console.error(`READY ${JSON.stringify({ connectMs })}`);
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      const i = buffer.indexOf('\n');
      if (i >= 0) resolve(buffer.slice(0, i));
    });
    process.stdin.on('end', () => reject(new Error('orchestrator closed stdin before opening the window')));
  });
  process.stdin.pause();
  const { measureStartAt, measureEndAt } = JSON.parse(line) as { measureStartAt: number; measureEndAt: number };
  return { start: measureStartAt, end: measureEndAt };
}

const sleepUntil = (at: number) => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));

interface RawCell {
  backend: string;
  sessions: number;
  seconds: number;
  cpuMs: number;
  reads: number;
  writes: number;
  actions: Record<string, ReturnType<Histogram['toJSON']>>;
  ops: Record<string, ReturnType<Histogram['toJSON']>>;
  errors: Record<string, { count: number; sample: string }>;
  connectMs: number;
  /** Sessions still inside an action when the drain timeout expired. */
  unfinished: number;
  claim?: { claims: number; empty: number; doubleClaimsInProcess: number; pairs: string[] };
}

/**
 * Waits for in-flight actions after the window closes, but not for ever: a backend that takes
 * minutes per action would otherwise hold the whole run hostage. Whatever is still running after
 * the drain timeout is abandoned (the process exits) and reported as unfinished.
 */
async function drain(lanes: Promise<unknown>[]): Promise<number> {
  let done = 0;
  for (const lane of lanes) void lane.finally(() => done++);
  await Promise.race([Promise.allSettled(lanes), new Promise((r) => setTimeout(r, DRAIN_TIMEOUT_MS))]);
  return lanes.length - done;
}

const DRAIN_TIMEOUT_MS = Number(process.env.BENCH_DRAIN_TIMEOUT_MS ?? 60_000);

const toRaw = (map: Map<string, Histogram>) => Object.fromEntries([...map.entries()].map(([k, h]) => [k, h.toJSON()]));

// --- run: N concurrent simulated users ---------------------------------------------------------

async function runProfile(): Promise<RawCell> {
  const index = JSON.parse(readFileSync(task.indexPath!, 'utf8')) as DatasetIndex;
  const profile = PROFILES[task.profile ?? 'mixed'];
  if (!profile) throw new Error(`unknown profile ${task.profile}`);
  const t0 = performance.now();
  const { c: raw, close, backend } = await connectApp();
  const connectMs = performance.now() - t0;
  const { start, end } = await awaitWindow(connectMs);
  const recorder = new OpRecorder();
  const c = instrument(raw, recorder);
  const salt = task.salt ?? 1;
  const workload = new Workload(c, index, rng(salt * 7919), salt);
  const actions = new Map<string, Histogram>();
  const errors = new Map<string, { count: number; sample: string }>();
  let measuring = false;
  let stopping = false;

  const recordAction = (name: string, began: number, ms: number) => {
    // An action counts if it started inside the window; one still running at the end is waited for.
    if (!measuring || began < start) return;
    let h = actions.get(name);
    if (!h) actions.set(name, (h = new Histogram()));
    h.record(ms);
  };
  const recordError = (name: string, error: unknown) => {
    if (!measuring) return;
    const key = `${name}: ${(error as Error).name}`;
    const entry = errors.get(key) ?? { count: 0, sample: String((error as Error).message).slice(0, 300) };
    entry.count++;
    errors.set(key, entry);
  };

  const session = async () => {
    while (!stopping) {
      const user = workload.pickUser();
      const action = workload.pickAction(profile);
      const began = Date.now();
      const started = performance.now();
      try {
        await workload.run(action as ActionName, user);
        recordAction(action, began, performance.now() - started);
      } catch (error) {
        recordError(action, error);
      }
    }
  };

  // The app runs one embedding worker per process, one job at a time (embeddingQueue.ts), fed by
  // the enqueues the edits make. One runs here too (in one client process only, so the background
  // load does not depend on how many client processes there are), Ollama replaced by a delay.
  const delay = task.ollamaDelayMs ?? 100;
  const dims = index.scale.embeddingDims;
  const embeddingWorker = async () => {
    while (!stopping) {
      const began = Date.now();
      const started = performance.now();
      try {
        const job = await claimEmbeddingJob(c);
        if (!job) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        await processEmbeddingJob(c, job, delay, dims);
        recordAction('bg:embeddingJob', began, performance.now() - started);
      } catch (error) {
        recordError('bg:embeddingJob', error);
      }
    }
  };

  recorder.enabled = false;
  const n = task.concurrency ?? 1;
  const lanes = Array.from({ length: n }, () => session());
  if (task.embeddingWorker && delay >= 0) lanes.push(embeddingWorker());

  await sleepUntil(start);
  recorder.enabled = true;
  measuring = true;
  const cpu0 = process.cpuUsage();
  await sleepUntil(end);
  recorder.enabled = false;
  const cpu = process.cpuUsage(cpu0);
  stopping = true;
  const unfinished = await drain(lanes);
  measuring = false;
  if (unfinished === 0) await close();

  return {
    backend,
    sessions: n,
    seconds: (end - start) / 1000,
    cpuMs: (cpu.user + cpu.system) / 1000,
    reads: recorder.reads,
    writes: recorder.writes,
    actions: toRaw(actions),
    ops: toRaw(recorder.ops),
    errors: Object.fromEntries(errors),
    unfinished,
    connectMs,
  };
}

// --- claim: many workers, one queue ------------------------------------------------------------

async function claimContention(): Promise<RawCell> {
  const t0 = performance.now();
  const { c: raw, close, backend } = await connectApp();
  const connectMs = performance.now() - t0;
  const { start, end } = await awaitWindow(connectMs);
  const recorder = new OpRecorder();
  const c = instrument(raw, recorder);
  const n = task.concurrency ?? 8;
  const inFlight = new Set<string>();
  // Every claim increments `attempts` atomically, so (job id, attempts after the claim) is unique
  // across every worker in every process if and only if no two claims of one job ever overlapped
  // or were lost. The orchestrator merges these from all client processes and counts duplicates.
  const pairs: string[] = [];
  let claims = 0;
  let empty = 0;
  let doubleClaims = 0;
  const errors = new Map<string, { count: number; sample: string }>();
  const cycle = new Histogram();
  let measuring = false;
  let stopping = false;

  const worker = async () => {
    while (!stopping) {
      const began = Date.now();
      const started = performance.now();
      try {
        const job = (await claimVisionJob(c)) as Doc | null;
        if (!job) {
          if (measuring) empty++;
          continue;
        }
        const id = String(job._id);
        if (inFlight.has(id) && measuring) doubleClaims++;
        inFlight.add(id);
        if (measuring) pairs.push(`${id}:${job.attempts}`);
        await completeAndRequeueVisionJob(c, job);
        inFlight.delete(id);
        if (measuring && began >= start) {
          claims++;
          cycle.record(performance.now() - started);
        }
      } catch (error) {
        if (measuring) {
          const key = `claim: ${(error as Error).name}`;
          const entry = errors.get(key) ?? { count: 0, sample: String((error as Error).message).slice(0, 300) };
          entry.count++;
          errors.set(key, entry);
        }
      }
    }
  };

  recorder.enabled = false;
  const lanes = Array.from({ length: n }, () => worker());
  await sleepUntil(start);
  recorder.enabled = true;
  measuring = true;
  const cpu0 = process.cpuUsage();
  await sleepUntil(end);
  recorder.enabled = false;
  const cpu = process.cpuUsage(cpu0);
  stopping = true;
  const unfinished = await drain(lanes);
  measuring = false;
  await close();
  return {
    backend,
    sessions: n,
    seconds: (end - start) / 1000,
    cpuMs: (cpu.user + cpu.system) / 1000,
    reads: recorder.reads,
    writes: recorder.writes,
    actions: { claimCycle: cycle.toJSON() },
    ops: toRaw(recorder.ops),
    errors: Object.fromEntries(errors),
    unfinished,
    connectMs,
    claim: { claims, empty, doubleClaimsInProcess: doubleClaims, pairs },
  };
}

/** After a claim storm, with every client stopped: nothing may be left claimed. */
async function integrity(): Promise<unknown> {
  const { c, close } = await connectApp();
  const stuckProcessing = await c('feedbackVisionJobs').countDocuments({ status: 'processing' });
  const pendingAfter = await c('feedbackVisionJobs').countDocuments({ status: 'pending' });
  await close();
  return { stuckProcessing, pendingAfter };
}

// --- cold: connect and answer the first queries ------------------------------------------------

async function cold(): Promise<unknown> {
  const index = JSON.parse(readFileSync(task.indexPath!, 'utf8')) as DatasetIndex;
  const processReadyAt = Date.now();
  const t0 = performance.now();
  // The container was just started: keep trying until the database answers, as an app's
  // supervisor restart loop would.
  let app: Awaited<ReturnType<typeof connectApp>> | undefined;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      app = await connectApp();
      break;
    } catch (error) {
      const { disconnectData } = await import('../src/data/index.ts');
      await disconnectData().catch(() => undefined);
      if (performance.now() - t0 > 300_000) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const connectMs = performance.now() - t0;
  const user = index.users[0]!;
  const workload = new Workload(app.c, index, rng(1), 1);
  const t1 = performance.now();
  await workload.me(user);
  const firstReadMs = performance.now() - t1;
  const t2 = performance.now();
  await workload.listTasks(user);
  const firstListMs = performance.now() - t2;
  const firstQueryDoneAt = Date.now();
  await app.close();
  return { backend: app.backend, processReadyAt, connectAttempts: attempts, connectMs, firstReadMs, firstListMs, firstQueryDoneAt };
}


// --- crosscheck: both stores, same questions ----------------------------------------------------

async function crosscheck(): Promise<unknown> {
  const index = JSON.parse(readFileSync(task.indexPath!, 'utf8')) as DatasetIndex;
  const { MongoDataStore } = await import('../src/data/mongo/store.ts');
  const { KdbDataStore } = await import('../src/data/kdb/store.ts');
  const { compareDocLists, compareCounts } = await import('../src/data/shadow/compare.ts');
  const { config } = await import('../src/config/index.ts');
  await mongoose.connect(config.mongodbUri, { family: 4 });
  const mongo = new MongoDataStore();
  const kdb = new KdbDataStore();
  await kdb.connect();
  const notStaged = { staging: { $exists: false } };
  const random = rng(99);
  const users = index.users.filter((_, i) => i % Math.max(1, Math.floor(index.users.length / (task.users ?? 25))) === 0).slice(0, task.users ?? 25);
  const results: Array<{ query: string; ok: boolean; detail?: string; rows: number }> = [];

  const compareFind = async (label: string, name: Parameters<typeof mongo.collection>[0], filter: Doc, options: Doc = {}, ordered = true) => {
    const [a, b] = await Promise.all([mongo.collection(name).find(filter, options), kdb.collection(name).find(filter, options)]);
    const divergence = compareDocLists(name, label, filter, a, b, ordered);
    results.push({ query: label, ok: !divergence, detail: divergence?.summary, rows: a.length });
  };
  const compareCount = async (label: string, name: Parameters<typeof mongo.collection>[0], filter: Doc) => {
    const [a, b] = await Promise.all([mongo.collection(name).countDocuments(filter), kdb.collection(name).countDocuments(filter)]);
    const divergence = compareCounts(name, label, filter, a, b);
    results.push({ query: label, ok: !divergence, detail: divergence?.summary, rows: a });
  };

  for (const user of users) {
    const accessFilter = { ...notStaged, $or: [{ userId: user.id }, { 'collaborators.userId': user.id }] };
    const pids = (await mongo.collection('projects').find(accessFilter, { select: '_id' })).map((p) => String(p._id));
    const taskQuery = { $or: [{ userId: user.id }, { projectIds: { $in: pids } }, { projectId: { $in: pids } }], ...notStaged };
    await compareFind('projects: accessible, sorted', 'projects', accessFilter, { sort: { sortOrder: 1, createdAt: 1 } });
    await compareFind('tasks: list page 1 (sort+limit)', 'tasks', taskQuery, { sort: { sortOrder: 1, createdAt: -1, _id: 1 }, limit: 200 });
    await compareFind('tasks: list page 2 (skip)', 'tasks', taskQuery, { sort: { sortOrder: 1, createdAt: -1, _id: 1 }, limit: 200, skip: 200 });
    await compareCount('tasks: count', 'tasks', taskQuery);
    await compareFind('tasks: open, status $in', 'tasks', { ...taskQuery, status: { $in: ['todo', 'in_progress'] } }, { sort: { sortOrder: 1, createdAt: -1, _id: 1 } });
    await compareFind('tasks: search candidates (updatedAt, limit 500, -embedding)', 'tasks', taskQuery, { sort: { updatedAt: -1, _id: 1 }, limit: 500, select: '-embedding' });
    await compareFind('notifications: latest 50', 'notifications', { userId: user.id }, { sort: { createdAt: -1 }, limit: 50 });
    await compareCount('notifications: unread', 'notifications', { userId: user.id, read: false });
    await compareFind('users: by email', 'users', { email: user.email });
    if (user.taskIds.length) {
      const taskId = user.taskIds[Math.floor(random() * user.taskIds.length)]!;
      const [a, b] = await Promise.all([mongo.collection('tasks').findById(taskId), kdb.collection('tasks').findById(taskId)]);
      const divergence = compareDocLists('tasks', 'findById', { _id: taskId }, a ? [a] : [], b ? [b] : []);
      results.push({ query: 'tasks: findById (full document with steps/subtasks/embedding)', ok: !divergence, detail: divergence?.summary, rows: a ? 1 : 0 });
      await compareFind('comments: by task, sorted', 'comments', { taskId, $or: [{ subtaskPath: { $exists: false } }, { subtaskPath: { $size: 0 } }] }, { sort: { createdAt: 1 } });
      await compareFind('activities: by task, latest 50', 'activities', { taskId }, { sort: { createdAt: -1 }, limit: 50 });
    }
    if (user.apiKeyHash) await compareFind('mcpApiKeys: by keyHash', 'mcpApiKeys', { keyHash: user.apiKeyHash, revokedAt: { $exists: false } });
  }
  await compareCount('embeddingJobs: claimable', 'embeddingJobs', { status: 'pending', attempts: { $lt: 3 } });
  await compareFind('embeddingJobs: next to claim', 'embeddingJobs', { status: 'pending', attempts: { $lt: 3 } }, { sort: { createdAt: 1, _id: 1 }, limit: 5 });
  await compareFind('feedbackVisionJobs: next to claim', 'feedbackVisionJobs', { status: 'pending' }, { sort: { updatedAt: 1, _id: 1 }, limit: 5 });

  await kdb.disconnect();
  await mongoose.disconnect();
  const failed = results.filter((r) => !r.ok);
  const byQuery = new Map<string, { checks: number; failed: number; rows: number; example?: string }>();
  for (const r of results) {
    const entry = byQuery.get(r.query) ?? { checks: 0, failed: 0, rows: 0 };
    entry.checks++;
    entry.rows += r.rows;
    if (!r.ok) {
      entry.failed++;
      entry.example ??= r.detail;
    }
    byQuery.set(r.query, entry);
  }
  return { checks: results.length, failed: failed.length, byQuery: Object.fromEntries(byQuery) };
}

const handlers = { load, run: runProfile, claim: claimContention, integrity, cold, crosscheck } as const;
try {
  const result = await handlers[task.mode]();
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.error(error);
  writeFileSync(outPath, JSON.stringify({ error: String((error as Error).stack ?? error) }));
  process.exit(1);
}
