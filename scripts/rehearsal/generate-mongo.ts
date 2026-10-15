/**
 * Fills a MongoDB database with the synthetic qtask-shaped dataset (scripts/rehearsal/dataset.ts).
 *
 *   MONGODB_URI=mongodb://127.0.0.1:8240/qtask_rehearsal \
 *     npx tsx scripts/rehearsal/generate-mongo.ts --tasks=100000 [--seed=N] [--drop]
 *
 * Synthetic data only - see the header of dataset.ts for what that does and does not prove.
 * Documents go through the Mongoose models (defaults, casting, sub-document ids) and are then
 * bulk-inserted with the raw driver, so they are what the app would have stored, without paying
 * for a save() per document. Indexes are created with syncIndexes() afterwards, as the app does
 * on connect, so the database matches a production one structurally.
 *
 * Refuses to touch a database that already has tasks unless --drop is given, and refuses
 * --drop on any database whose name does not contain "rehearsal" or "drill": this tool must never
 * be pointed at a real database by accident.
 */

import mongoose from 'mongoose';
import { castForMongo, createDataset, GENERATED, scaleFor } from './dataset.js';
import { MODEL_BY_COLLECTION } from '../../src/data/modelNames.js';

function arg(name: string): string | undefined {
  const flag = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!flag) return undefined;
  return flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : 'true';
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const tasks = Number(arg('tasks') ?? 100_000);
  const seed = Number(arg('seed') ?? 20261015);
  await import('../../src/models/index.js');
  await mongoose.connect(uri, { family: 4 });
  const db = mongoose.connection.db!;
  const dbName = db.databaseName;

  const existing = await db.collection('tasks').estimatedDocumentCount().catch(() => 0);
  if (existing > 0) {
    if (arg('drop') !== 'true') throw new Error(`${dbName} already has ${existing} tasks; pass --drop to replace it`);
    if (!/rehearsal|drill/.test(dbName)) throw new Error(`refusing to drop "${dbName}": only databases named *rehearsal* or *drill* may be dropped`);
    await db.dropDatabase();
  }

  const scale = scaleFor(tasks);
  const dataset = createDataset(scale, { seed });
  console.log(`generating into ${dbName}: ${JSON.stringify(scale)}`);
  const started = Date.now();
  let total = 0;
  for (const name of GENERATED) {
    const Model = mongoose.models[MODEL_BY_COLLECTION[name]]!;
    const target = db.collection(Model.collection.collectionName);
    const t0 = Date.now();
    let n = 0;
    for (const batch of dataset.batches(name, 1000)) {
      await target.insertMany(batch.map((doc) => castForMongo(name, doc)), { ordered: false });
      n += batch.length;
    }
    total += n;
    console.log(`${String(n).padStart(9)}  ${name.padEnd(28)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const t1 = Date.now();
  for (const name of GENERATED) await mongoose.models[MODEL_BY_COLLECTION[name]]!.syncIndexes();
  console.log(`${String(total).padStart(9)}  TOTAL  inserted in ${((t1 - started) / 1000).toFixed(1)}s, indexes in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  const stats = await db.stats();
  console.log(`mongo dbStats: dataSize=${mb(stats.dataSize)} storageSize=${mb(stats.storageSize)} indexSize=${mb(stats.indexSize)} objects=${stats.objects}`);
  const heavy = dataset.userTaskCounts();
  console.log(`heaviest user owns ${heavy[0]!.tasks} tasks (${heavy[0]!.userId}); median user ${heavy[Math.floor(heavy.length / 2)]!.tasks}`);
  await mongoose.disconnect();
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)}MiB`;
}

main().catch(async (error) => {
  console.error((error as Error).stack ?? error);
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
