/**
 * Copies every collection from MongoDB into KDB, and checks the copy.
 *
 *   npm run migrate:kdb -- backfill [--collection=tasks] [--dry-run]
 *   npm run migrate:kdb -- verify   [--collection=tasks]
 *   npm run migrate:kdb -- counts
 *
 * It only ever reads MongoDB. KDB is written by `backfill` and by nothing else here.
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
 * KDB client (KDB_CLIENT_MODULE or @kdb/client), the same as the app.
 */

import mongoose from 'mongoose';
import { compareDocLists } from '../data/shadow/compare.js';
import type { MongoDataStore } from '../data/mongo/store.js';
import type { KdbDataStore } from '../data/kdb/store.js';
import type { CollectionName, Doc } from '../data/types.js';

const ALL_COLLECTIONS: CollectionName[] = [
  'users', 'projects', 'tasks', 'comments', 'activities', 'conversations', 'notifications',
  'invites', 'feedback', 'feedbackVisionJobs', 'embeddingJobs', 'llmCallMetrics', 'llmDailyMetrics',
  'adminAudits', 'mcpApiKeys', 'mcpSessions', 'mcpOAuthClients', 'mcpOAuthAuthorizationCodes',
  'mcpOAuthRefreshTokens', 'mcpOAuthPendingConsents', 'userOAuthAuthCodes',
];

const PAGE = 500;
const CONCURRENCY = 16;

interface Args {
  command: 'backfill' | 'verify' | 'counts';
  only?: CollectionName;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'backfill' && command !== 'verify' && command !== 'counts') {
    throw new Error('usage: migrate-mongo-to-kdb <backfill|verify|counts> [--collection=<name>] [--dry-run]');
  }
  const args: Args = { command, dryRun: false };
  for (const flag of rest) {
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag.startsWith('--collection=')) {
      const name = flag.slice('--collection='.length) as CollectionName;
      if (!ALL_COLLECTIONS.includes(name)) throw new Error(`unknown collection "${name}"`);
      args.only = name;
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

async function backfill(mongo: MongoDataStore, kdb: KdbDataStore, names: CollectionName[], dryRun: boolean): Promise<void> {
  for (const name of names) {
    let copied = 0;
    for await (const page of pages(mongo, name)) {
      if (!dryRun) await inChunks(page, CONCURRENCY, (doc) => kdb.importDocument(name, doc));
      copied += page.length;
    }
    console.log(`${dryRun ? 'would copy' : 'copied'} ${String(copied).padStart(8)}  ${name}`);
  }
}

/** Returns the number of collections that disagree. */
async function verify(mongo: MongoDataStore, kdb: KdbDataStore, names: CollectionName[]): Promise<number> {
  let bad = 0;
  for (const name of names) {
    const target = kdb.collection(name);
    let checked = 0;
    let missing = 0;
    const differing: string[] = [];
    const fields = new Set<string>();

    for await (const page of pages(mongo, name)) {
      // Keyed reads, one per Mongo document: what gets checked is exactly what Mongo
      // holds, however the two stores happen to order or page a listing.
      const copies = new Map<string, Doc>();
      await inChunks(page, CONCURRENCY, async (doc) => {
        const copy = await target.findById(doc._id as string);
        if (copy) copies.set(doc._id as string, copy);
      });
      for (const doc of page) {
        const copy = copies.get(doc._id as string);
        if (!copy) { missing++; continue; }
        const divergence = compareDocLists(name, 'verify', {}, [doc], [copy]);
        if (divergence) {
          differing.push(doc._id as string);
          divergence.fields?.forEach((field) => fields.add(field));
        }
      }
      checked += page.length;
    }

    const mongoCount = await mongo.collection(name).countDocuments({});
    const kdbCount = await target.countDocuments({});
    // Extras are expected to be small and transient while shadow writes are on (a
    // delete mirrored after the scan above); a persistent surplus is a real finding.
    const extra = Math.max(0, kdbCount - (mongoCount - missing));
    const ok = missing === 0 && differing.length === 0 && extra === 0;
    if (!ok) bad++;

    console.log(
      `${ok ? 'ok     ' : 'DIFFERS'} ${name.padEnd(28)} mongo=${mongoCount} kdb=${kdbCount} ` +
        `missing=${missing} differing=${differing.length} extra=${extra}` +
        (fields.size ? `  fields=[${[...fields].sort().join(', ')}]` : '') +
        (differing.length ? `  e.g. ${differing.slice(0, 3).join(', ')}` : '')
    );
    void checked;
  }
  return bad;
}

/** Reads only MongoDB. Sizes the backfill before any KDB exists. */
async function counts(mongo: MongoDataStore, names: CollectionName[]): Promise<void> {
  let total = 0;
  for (const name of names) {
    const n = await mongo.collection(name).countDocuments({});
    total += n;
    console.log(`${String(n).padStart(9)}  ${name}`);
  }
  console.log(`${String(total).padStart(9)}  TOTAL`);
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
  await import('../models/index.js');
  const { config } = await import('../config/index.js');
  const { MongoDataStore } = await import('../data/mongo/store.js');
  const { KdbDataStore } = await import('../data/kdb/store.js');
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
      const bad = await verify(mongo, kdb, names);
      if (bad > 0) process.exitCode = 1;
    }
  } finally {
    await kdb.disconnect();
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
