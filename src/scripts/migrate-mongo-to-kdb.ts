/**
 * Copies every collection from MongoDB into KDB, and checks the copy.
 *
 *   npm run migrate:kdb -- backfill [--collection=tasks] [--dry-run]
 *   npm run migrate:kdb -- verify   [--collection=tasks] [--count-limit=20000]
 *   npm run migrate:kdb -- counts
 *   npm run migrate:kdb -- declare
 *
 * It only ever reads MongoDB. KDB is written by `backfill` and by nothing else here.
 *
 * `declare` creates on KDB the lookup indexes and unique constraints the schemas declare (what the
 * app also does on every connect). For a large first load, run the backfill with
 * DATA_KDB_DECLARE_INDEXES=false and `declare` afterwards: one index build over the loaded data is
 * cheaper than maintaining every index through every copied write.
 *
 * Why a backfill at all: shadow writes (DATA_SHADOW_WRITES) mirror *new* traffic, so
 * on their own the KDB side holds only what was written since they were switched on.
 * The backfill brings it level with the history. It is idempotent - a document is
 * written verbatim by id - so it can be re-run, resumed after a failure, or run again
 * just before cutover to catch up. Run it with shadow writes on, so nothing written
 * during the copy is lost; where a mirrored write and the copy race on one document,
 * the later `verify` is what settles which is right.
 *
 * `verify` reports counts, missing and extra ids, and the *names* of fields that
 * differ - never values, for the same reason shadow reports don't: output goes to
 * logs and the documents hold emails and task text.
 *
 * Needs MONGODB_URI, KDB_ADDR, KDB_NAMESPACE_PREFIX (and KDB_TOKEN if set) and the
 * KDB client (KDB_CLIENT_MODULE or @limidus/kdb-client), the same as the app.
 */

import mongoose from 'mongoose';
import { compareDocLists } from '../data/shadow/compare.js';
import { ttlSpec } from '../data/kdb/schema.js';
import { MODEL_BY_COLLECTION } from '../data/modelNames.js';
import type { MongoDataStore } from '../data/mongo/store.js';
import type { KdbDataStore } from '../data/kdb/store.js';
import type { CollectionName, Doc } from '../data/types.js';

/**
 * Every collection the data layer knows, from the table both stores use. A hand-kept list here
 * once left out `appMeta` - the one-shot data-migration markers - so a KDB built by the backfill
 * would have re-run every data migration at its first start on KDB.
 */
export const ALL_COLLECTIONS = Object.keys(MODEL_BY_COLLECTION) as CollectionName[];

const PAGE = 500;
const CONCURRENCY = 16;
/** Keyed reads in flight during verify. */
const VERIFY_CONCURRENCY = 64;
/**
 * One import commit carries at most this many documents and this many bytes of JSON. The byte bound
 * is about reads, not the 16 MiB wire frame: kdb-service v0.8.0 stores a commit as one compressed
 * frame and a cold read of any document in it decompresses the whole frame, so a backfill written
 * in 4 MiB commits made later reads slow for good (measured on 27,600 documents: a random keyed
 * read 14 ms, COUNT of a collection 20 s; with 64 KiB commits 1.2 ms and 1.1 s; a commit per
 * document 0.5 ms and 1.3 s, but the backfill three times slower). Overridable for experiments.
 */
const COMMIT_DOCS = Number(process.env.KDB_IMPORT_COMMIT_DOCS ?? 250);
const COMMIT_BYTES = Number(process.env.KDB_IMPORT_COMMIT_BYTES ?? 64 * 1024);

interface Args {
  command: 'backfill' | 'verify' | 'counts' | 'declare';
  only?: CollectionName;
  dryRun: boolean;
  /** verify: count the KDB copy (to find surplus documents) only for collections up to this size. */
  countLimit: number;
}

/**
 * Above this many documents verify does not count the KDB copy. In kdb-service v0.8.0 with
 * --expire-field, counting (or listing the ids of) a collection reads every document body, and on
 * the 100,000-task rehearsal listing the task ids took the service past a 4 GiB memory limit
 * (OOM-killed). `--count-limit=0` counts everything regardless.
 */
const DEFAULT_COUNT_LIMIT = 20_000;

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'backfill' && command !== 'verify' && command !== 'counts' && command !== 'declare') {
    throw new Error('usage: migrate-mongo-to-kdb <backfill|verify|counts|declare> [--collection=<name>] [--dry-run]');
  }
  const args: Args = { command, dryRun: false, countLimit: DEFAULT_COUNT_LIMIT };
  for (const flag of rest) {
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag.startsWith('--collection=')) {
      const name = flag.slice('--collection='.length) as CollectionName;
      if (!ALL_COLLECTIONS.includes(name)) throw new Error(`unknown collection "${name}"`);
      args.only = name;
    } else if (flag.startsWith('--count-limit=')) {
      const limit = Number(flag.slice('--count-limit='.length));
      if (!Number.isInteger(limit) || limit < 0) throw new Error(`--count-limit must be a non-negative integer`);
      args.countLimit = limit;
    } else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

/** Walks a collection in `_id` order, a page at a time, so memory stays flat. */
async function* pages(mongo: MongoDataStore, name: CollectionName): AsyncGenerator<Doc[]> {
  const source = mongo.collection(name);
  let after: string | undefined;
  for (;;) {
    const page = await source.find(after ? { _id: { $gt: after } } : {}, { sort: { _id: 1 }, limit: PAGE });
    if (page.length === 0) return;
    yield page;
    after = page[page.length - 1]._id as string;
  }
}

async function inChunks<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(work));
  }
}

/** Splits a page into import commits, bounded by document count and by encoded size. */
export function commitGroups(docs: Doc[], maxDocs = COMMIT_DOCS, maxBytes = COMMIT_BYTES): Doc[][] {
  const groups: Doc[][] = [];
  let current: Doc[] = [];
  let bytes = 0;
  for (const doc of docs) {
    const size = JSON.stringify(doc).length;
    if (current.length > 0 && (current.length >= maxDocs || bytes + size > maxBytes)) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(doc);
    bytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

async function backfill(mongo: MongoDataStore, kdb: KdbDataStore, names: CollectionName[], dryRun: boolean): Promise<void> {
  const started = Date.now();
  let total = 0;
  for (const name of names) {
    const t0 = Date.now();
    let copied = 0;
    for await (const page of pages(mongo, name)) {
      // A few multi-document commits per page rather than a commit per document: the per-commit
      // fsync is the cost that matters (see KdbDataStore.importMany).
      if (!dryRun) for (const group of commitGroups(page)) await kdb.importMany(name, group);
      copied += page.length;
    }
    total += copied;
    const seconds = (Date.now() - t0) / 1000;
    console.log(
      `${dryRun ? 'would copy' : 'copied'} ${String(copied).padStart(8)}  ${name.padEnd(28)}` +
        (dryRun ? '' : ` ${seconds.toFixed(1)}s`)
    );
  }
  if (!dryRun) {
    const seconds = (Date.now() - started) / 1000;
    console.log(`copied ${String(total).padStart(8)}  TOTAL in ${seconds.toFixed(1)}s (${Math.round(total / Math.max(seconds, 0.001))} docs/s)`);
  }
}

/**
 * Whether a document's TTL deadline has passed. MongoDB's TTL monitor removes such a document up to
 * a minute late, while KDB hides it from reads the moment it expires, so a document in this state
 * is legitimately absent from the copy and must not be reported as missing.
 */
function ttlExpired(name: CollectionName, doc: Doc, now: number): boolean {
  const schema = mongoose.models[MODEL_BY_COLLECTION[name]]?.schema;
  const ttl = schema ? ttlSpec(schema) : null;
  if (!ttl) return false;
  const at = doc[ttl.path];
  const ms = at instanceof Date ? at.getTime() : typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(ms) && ms + ttl.graceMs <= now;
}

/** Returns the number of collections that disagree. */
async function verify(mongo: MongoDataStore, kdb: KdbDataStore, names: CollectionName[], countLimit = DEFAULT_COUNT_LIMIT): Promise<number> {
  const started = Date.now();
  let bad = 0;
  const unchecked: string[] = [];
  for (const name of names) {
    const target = kdb.collection(name);
    let missing = 0;
    let expired = 0;
    const differing: string[] = [];
    const fields = new Set<string>();

    for await (const page of pages(mongo, name)) {
      // Keyed reads, many in flight, not SQL: the cost follows the page, not the namespace. On
      // 100,000 tasks with embeddings keyed gets read them all in 13 s at 761 MiB RSS; `IN (...)`
      // statements of 500 ids took 43 s at 767 MiB.
      const copies = new Map<string, Doc>();
      await inChunks(page, VERIFY_CONCURRENCY, async (doc) => {
        const copy = await target.findById(doc._id as string);
        if (copy) copies.set(doc._id as string, copy);
      });
      const now = Date.now();
      for (const doc of page) {
        const copy = copies.get(doc._id as string);
        if (!copy) {
          if (ttlExpired(name, doc, now)) expired++;
          else missing++;
          continue;
        }
        const divergence = compareDocLists(name, 'verify', {}, [doc], [copy]);
        if (divergence) {
          differing.push(doc._id as string);
          divergence.fields?.forEach((field) => fields.add(field));
        }
      }
    }

    const mongoCount = await mongo.collection(name).countDocuments({});
    // Surplus can only be found by counting KDB, which is skipped for large collections (see
    // countLimit). Say so rather than report extra=0: "could not look" is not "nothing there".
    let kdbCount: number | string;
    let extra: number | string;
    try {
      if (countLimit > 0 && mongoCount > countLimit) {
        // Not "0": an unchecked surplus is reported as such, and listed at the end.
        unchecked.push(name);
        throw Object.assign(new Error('not counted'), { name: 'NotCounted' });
      }
      kdbCount = await target.countDocuments({});
      // Extras are expected to be small and transient while shadow writes are on (a
      // delete mirrored after the scan above); a persistent surplus is a real finding.
      extra = Math.max(0, kdbCount - (mongoCount - missing - expired));
    } catch (error) {
      if ((error as Error).name !== 'NotCounted') throw error;
      kdbCount = 'not-counted';
      extra = 'unchecked';
    }
    // An unchecked surplus does not fail the run (it is listed below).
    const ok = missing === 0 && differing.length === 0 && (extra === 0 || extra === 'unchecked');
    if (!ok) bad++;

    console.log(
      `${ok ? 'ok     ' : 'DIFFERS'} ${name.padEnd(28)} mongo=${mongoCount} kdb=${kdbCount} ` +
        `missing=${missing} differing=${differing.length} extra=${extra}` +
        (expired ? ` expired=${expired}` : '') +
        (fields.size ? `  fields=[${[...fields].sort().join(', ')}]` : '') +
        (differing.length ? `  e.g. ${differing.slice(0, 3).join(', ')}` : '')
    );
  }
  if (unchecked.length) {
    console.log(
      `NOTE: surplus documents in KDB were not looked for in ${unchecked.join(', ')} (more than ${countLimit} documents; ` +
        'counting reads every body in kdb-service v0.8.0 - docs/KDB_MIGRATION.md B5). --count-limit=0 counts them anyway.'
    );
  }
  console.log(`verified in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return bad;
}

/** Reads only MongoDB: how much there is to copy, before any KDB exists. */
async function counts(mongo: MongoDataStore, names: CollectionName[]): Promise<void> {
  let total = 0;
  for (const name of names) {
    const n = await mongo.collection(name).countDocuments({});
    total += n;
    console.log(`${String(n).padStart(9)}  ${name}`);
  }
  // One kdb-service namespace holds every collection. Since KDB v0.8.0 nothing truncates at
  // 10,000 documents (blocker B1 is fixed). The limit that does grow with this total is
  // kdb-service's --scan-row-budget (rows one scan may examine, default 1,000,000), which an
  // unindexed scan of any collection reaches once the whole namespace is that large.
  console.log(`${String(total).padStart(9)}  TOTAL  (one KDB namespace; kdb-service --scan-row-budget defaults to 1000000)`);
  if (total >= 1_000_000) {
    console.log('AT OR PAST 1,000,000 DOCUMENTS: raise kdb-service --scan-row-budget before cutover (docs/KDB_MIGRATION.md).');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const names = args.only ? [args.only] : ALL_COLLECTIONS;

  // Models register on import; the Mongo store reads them from the registry. It is
  // not `connect()`ed on purpose - that also syncs indexes, and this tool must not
  // change anything in MongoDB.
  // Verify asks KDB for a page of ids at a time; without pushdown each ask is a full
  // scan. Pushdown only narrows (see kdb/pushdown.ts), so it is safe to force on. The
  // config snapshot is taken at import, hence the dynamic imports below.
  process.env.DATA_KDB_PUSHDOWN = 'true';
  if (args.command === 'declare') process.env.DATA_KDB_DECLARE_INDEXES = 'true';
  await import('../models/index.js');
  const { config } = await import('../config/index.js');
  const { MongoDataStore } = await import('../data/mongo/store.js');
  const { KdbDataStore } = await import('../data/kdb/store.js');
  if (args.command === 'declare') {
    // Declaring happens in connect(), idempotently; timing it is the whole command. No Mongo.
    const kdb = new KdbDataStore();
    const started = Date.now();
    await kdb.connect();
    console.log(`declared indexes and unique constraints in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    await kdb.disconnect();
    return;
  }
  await mongoose.connect(config.mongodbUri, { family: 4 });
  const mongo = new MongoDataStore();
  if (args.command === 'counts') {
    try {
      await counts(mongo, names);
    } finally {
      await mongoose.disconnect();
    }
    return;
  }
  const kdb = new KdbDataStore();
  await kdb.connect();

  try {
    if (args.command === 'backfill') {
      await backfill(mongo, kdb, names, args.dryRun);
    } else {
      const bad = await verify(mongo, kdb, names, args.countLimit);
      if (bad > 0) process.exitCode = 1;
    }
  } finally {
    await kdb.disconnect();
    await mongoose.disconnect();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
