// Bulk-loads tasks into a local-mode store for the perf run, straight through the data layer
// (KdbDataStore.create, the same schema normalisation the API path uses), because creating
// tens of thousands of tasks over HTTP one by one is itself what is being measured elsewhere.
//
//   node --import tsx e2e/macos/seed.mts '<json>'
//   json: {kdbPort, userId, projectIds, from, to, kdbClientModule, concurrency}
//
// Tasks carry no activity-log entries and projects no tracking rollup; everything the list,
// search and update paths read is present.
import { taskFields } from './taskgen.mjs';

const spec = JSON.parse(process.argv[2] ?? '{}') as {
  kdbPort: number;
  userId: string;
  projectIds: string[];
  from: number;
  to: number;
  kdbClientModule: string;
  concurrency?: number;
};

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'seed-only';
process.env.DATA_KDB = 'true';
process.env.KDB_ADDR = `tcp://127.0.0.1:${spec.kdbPort}`;
process.env.KDB_NAMESPACE_PREFIX = 'qtask/docs';
process.env.KDB_CLIENT_MODULE = spec.kdbClientModule;

await import('../../src/models/index.js');
const { KdbDataStore } = await import('../../src/data/kdb/store.js');
const store = new KdbDataStore();
await store.connect();
const tasks = store.collection('tasks');

let next = spec.from;
const t0 = Date.now();
async function worker() {
  while (next < spec.to) {
    const n = next++;
    const f = taskFields(n, spec.projectIds);
    await tasks.create({ ...f, userId: spec.userId, projectIds: [f.projectId], status: n % 7 === 0 ? 'done' : 'todo' });
  }
}
await Promise.all(Array.from({ length: spec.concurrency ?? 32 }, worker));
await store.disconnect();
const seconds = (Date.now() - t0) / 1000;
console.log(JSON.stringify({ seeded: spec.to - spec.from, seconds, perSecond: Math.round((spec.to - spec.from) / seconds) }));
