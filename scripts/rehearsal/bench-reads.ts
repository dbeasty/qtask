/**
 * Read latencies of the app's hottest queries, through the real services and the configured store.
 *
 *   DATA_KDB=true DATA_KDB_PUSHDOWN=true KDB_ADDR=... KDB_NAMESPACE_PREFIX=qtask/docs \
 *     npx tsx scripts/rehearsal/bench-reads.ts --tasks=100000 [--iterations=20]
 *   MONGODB_URI=... npx tsx scripts/rehearsal/bench-reads.ts --tasks=100000      # the same on MongoDB
 *
 * Meant for a database filled by generate-mongo.ts (and, for KDB, backfilled from it) with the same
 * --tasks and --seed: the generator is re-run in memory (skeletons only) to pick a heavy user, a
 * typical one and their tasks, so both backends are asked exactly the same questions. Synthetic
 * data; see dataset.ts. Read-only: it never writes.
 *
 * Queries (each warmed up twice, then timed `iterations` times; p50/p95/max in ms):
 *  - taskService.listTasks, first page of 50 and unpaginated, for the heaviest and a median user
 *  - taskService.getTask and store findById for random tasks
 *  - tasks.countDocuments({ userId }), the whole collection, notificationService.unreadCount
 *  - lexical task search (searchTasksWithFilters, hybridSearch off: no Ollama here)
 */

import { createDataset, scaleFor } from './dataset.js';

function arg(name: string, fallback: string): string {
  const flag = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : fallback;
}

const tasks = Number(arg('tasks', '100000'));
const seed = Number(arg('seed', '20261015'));
const iterations = Number(arg('iterations', '20'));

async function time(label: string, fn: (i: number) => Promise<unknown>, rows?: (r: unknown) => number): Promise<void> {
  try {
    await timeOrThrow(label, fn, rows);
  } catch (error) {
    // A failed query is a result too (B5: some take kdb-service down); report it and go on.
    console.log(`${label.padEnd(58)} FAILED: ${(error as Error).message.slice(0, 140)}`);
  }
}

async function timeOrThrow(label: string, fn: (i: number) => Promise<unknown>, rows?: (r: unknown) => number): Promise<void> {
  let lastRows: number | undefined;
  for (let i = 0; i < 2; i++) await fn(i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const result = await fn(i);
    samples.push(performance.now() - t0);
    if (rows) lastRows = rows(result);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!;
  console.log(
    `${label.padEnd(58)} p50 ${q(0.5).toFixed(1).padStart(8)}  p95 ${q(0.95).toFixed(1).padStart(8)}  max ${samples[samples.length - 1]!.toFixed(1).padStart(8)} ms` +
      (lastRows !== undefined ? `  (${lastRows} rows)` : '')
  );
}

async function main(): Promise<void> {
  await import('../../src/models/index.js');
  const { connectData, collection, disconnectData } = await import('../../src/data/index.js');
  const { config } = await import('../../src/config/index.js');
  const { taskService } = await import('../../src/services/taskService.js');
  const { searchService } = await import('../../src/services/searchService.js');
  const { notificationService } = await import('../../src/services/notificationService.js');
  const mongoose = (await import('mongoose')).default;
  if (config.dataBackend === 'mongo') await mongoose.connect(config.mongodbUri, { family: 4 });
  await connectData();

  const dataset = createDataset(scaleFor(tasks), { seed });
  const ranked = dataset.userTaskCounts();
  const heavy = ranked[0]!;
  const typical = ranked[Math.floor(ranked.length / 2)]!;
  const taskIds = dataset.ids.tasks;
  const pickTask = (i: number) => taskIds[(i * 7919) % taskIds.length]!;
  const ownerOf = new Map<string, string>();
  for (const t of await collection('tasks').find({ _id: { $in: Array.from({ length: iterations + 2 }, (_, i) => pickTask(i)) } }, { select: '_id userId' })) {
    ownerOf.set(String(t._id), String(t.userId));
  }

  console.log(`backend=${config.dataBackend}${config.dataBackend === 'kdb' ? ` pushdown=${config.kdb.pushdown}` : ''} tasks=${tasks} iterations=${iterations}`);
  console.log(`heavy user owns ${heavy.tasks} tasks, typical user ${typical.tasks}`);
  const len = (r: unknown) => (Array.isArray(r) ? r.length : (r as { tasks: unknown[] }).tasks.length);

  for (const [who, user] of [['heavy', heavy], ['typical', typical]] as const) {
    await time(`listTasks(${who}) first page of 50`, () => taskService.listTasks(user.userId, {}, { limit: 50, offset: 0 }), len);
    await time(`listTasks(${who}) unpaginated`, () => taskService.listTasks(user.userId, {}), len);
    await time(`listTasks(${who}, status=todo) first page`, () => taskService.listTasks(user.userId, { status: 'todo' }, { limit: 50, offset: 0 }), len);
    await time(`tasks.countDocuments({ userId }) (${who})`, () => collection('tasks').countDocuments({ userId: user.userId }));
    await time(`notificationService.unreadCount (${who})`, () => notificationService.unreadCount(user.userId));
    await time(`search tasks "invoice" lexical (${who})`, () => searchService.searchTasksWithFilters(user.userId, { query: 'invoice' }, 20, { hybridSearch: false }), len);
  }
  await time('tasks findById (store)', (i) => collection('tasks').findById(pickTask(i)));
  await time('taskService.getTask (owner)', (i) => taskService.getTask(ownerOf.get(pickTask(i))!, pickTask(i)));
  if (config.dataBackend === 'kdb' && tasks > 20_000) {
    // Counting a collection reads every body in kdb-service v0.8.0; listing the ids of 100,000 tasks
    // took it past a 4 GiB limit (docs/KDB_MIGRATION.md B5). Not asked here, so the rest can run.
    console.log(`${'tasks.countDocuments({}) (whole collection)'.padEnd(58)} SKIPPED on KDB above 20,000 tasks (B5)`);
  } else {
    await time('tasks.countDocuments({}) (whole collection)', () => collection('tasks').countDocuments({}));
  }

  await disconnectData();
  if (config.dataBackend === 'mongo') await mongoose.disconnect();
}

main().catch((error) => {
  console.error((error as Error).stack ?? error);
  process.exitCode = 1;
});
