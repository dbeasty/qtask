/**
 * Filter pushdown to KDB SQL must narrow scans without ever changing an answer.
 *
 * The check is differential: with pushdown on, every filter's result must equal what
 * the shared query engine produces over an unfiltered scan (which pushes nothing).
 * The failure this guards is the silent one — SQL excluding a document the filter
 * wants — so the corpus leans on the awkward cases: nulls, absent fields, arrays,
 * dates, mixed types, and field names that look like SQL keywords.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './helpers/kdbRelease.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const PORT = Number(process.env.KDB_TEST_PORT_PUSHDOWN ?? 7812);
const skip = kdbUnavailable;

import { buildWhere, exactWhere, unionBranches, type PathKind } from '../src/data/kdb/pushdown.ts';
import { matchesFilter } from '../src/data/query/filter.ts';
import { applySort } from '../src/data/query/shape.ts';
import type { Collection, DataStore, Doc, Filter } from '../src/data/types.ts';

describe('buildWhere', () => {
  it('pushes equality, $in, ranges and dates', () => {
    assert.deepEqual(buildWhere({ userId: 'u1' }), { sql: 'userId = ?', args: ['u1'] });
    assert.deepEqual(buildWhere({ status: { $in: ['a', 'b'] } }), { sql: 'status IN (?, ?)', args: ['a', 'b'] });
    const when = new Date('2026-01-02T03:04:05.006Z');
    assert.deepEqual(buildWhere({ dueDate: { $lt: when } }), { sql: 'dueDate < ?', args: [when.toISOString()] });
  });

  it('maps _id onto kdb_id', () => {
    const where = buildWhere({ _id: '6890aaaaaaaaaaaaaaaaaaaa' });
    assert.equal(where?.sql, 'kdb_id = ?');
    assert.equal(where?.args[0], '00000000-6890-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('leaves out what SQL cannot express faithfully', () => {
    assert.equal(buildWhere({ x: null }), null);
    assert.equal(buildWhere({ x: { $ne: 'a' } }), null);
    assert.equal(buildWhere({ x: { $exists: false } }), null);
    assert.equal(buildWhere({ x: { $in: ['a', null] } }), null);
    assert.equal(buildWhere({ 'steps.0.text': 'a' }), null);
    assert.equal(buildWhere({ 'a b': 'x' }), null);
    assert.equal(buildWhere({ x: /abc/ }), null);
  });

  it('keeps the pushable half of a mixed filter, and only whole $or', () => {
    assert.deepEqual(buildWhere({ userId: 'u1', title: { $regex: 'x' } }), { sql: 'userId = ?', args: ['u1'] });
    assert.equal(buildWhere({ $or: [{ a: 1 }, { b: { $ne: 2 } }] }), null);
    assert.deepEqual(buildWhere({ $or: [{ a: 1 }, { b: 2 }] }), { sql: '(a = ?) OR (b = ?)', args: [1, 2] });
  });
});

describe('unionBranches', () => {
  const indexed = (path: string) => ['userId', 'projectIds', 'status', 'collaborators.userId'].includes(path);

  it('splits an access $or whose branches are all indexed, keeping the rest on each', () => {
    const out = unionBranches({ title: 'x', $or: [{ userId: 'u' }, { 'collaborators.userId': 'u' }] }, indexed);
    assert.deepEqual(out, [
      { title: 'x', $and: [{ userId: 'u' }] },
      { title: 'x', $and: [{ 'collaborators.userId': 'u' }] },
    ]);
  });

  it('finds the $or inside a top-level $and', () => {
    const out = unionBranches({ $and: [{ $or: [{ userId: 'u' }, { projectIds: { $in: ['p'] } }] }, { title: 'x' }] }, indexed);
    assert.equal(out?.length, 2);
    assert.deepEqual(out?.[1], { $and: [{ title: 'x' }, { projectIds: { $in: ['p'] } }] });
  });

  it('does not split when it would not help', () => {
    // Something outside the $or is indexed: that index serves the whole query.
    assert.equal(unionBranches({ status: 'todo', $or: [{ userId: 'u' }, { projectIds: 'p' }] }, indexed), null);
    // A branch with nothing indexed would scan anyway.
    assert.equal(unionBranches({ $or: [{ userId: 'u' }, { title: 'x' }] }, indexed), null);
    // A branch that cannot be pushed (null matches absent) at all.
    assert.equal(unionBranches({ $or: [{ userId: 'u' }, { userId: null }] }, indexed), null);
    // No $or, a single branch, or too many to be worth separate queries.
    assert.equal(unionBranches({ userId: 'u' }, indexed), null);
    assert.equal(unionBranches({ $or: [{ userId: 'u' }] }, indexed), null);
    assert.equal(unionBranches({ $or: Array.from({ length: 9 }, (_, i) => ({ userId: `u${i}` })) }, indexed), null);
  });
});

describe('exactWhere', () => {
  const kinds: Record<string, PathKind> = { userId: 'text', read: 'text', tags: 'textList', 'collaborators.userId': 'textList', percentComplete: 'other', dueDate: 'other' };
  const kindOf = (path: string) => kinds[path] ?? 'other';

  it('translates equality, $in, booleans, ids and $and/$or of them', () => {
    assert.deepEqual(exactWhere({ userId: 'u', read: false }, kindOf), { sql: '(userId = ?) AND (read = ?)', args: ['u', false] });
    assert.deepEqual(exactWhere({ tags: { $in: ['a', 'b'] } }, kindOf), { sql: 'tags IN (?, ?)', args: ['a', 'b'] });
    assert.equal(exactWhere({ $or: [{ userId: 'u' }, { 'collaborators.userId': 'u' }] }, kindOf)?.sql, '(userId = ?) OR (collaborators.userId = ?)');
    assert.equal(exactWhere({ _id: 'abc' }, kindOf)?.sql, 'kdb_id = ?');
    assert.deepEqual(exactWhere({}, kindOf), { sql: '', args: [] });
  });

  it('refuses anything it cannot promise exactly', () => {
    for (const filter of [
      { percentComplete: 40 }, // numbers
      { dueDate: new Date() }, // dates
      { userId: null }, // null matches absent
      { userId: { $exists: false } },
      { userId: { $ne: 'u' } },
      { userId: { $regex: 'u' } },
      { userId: { $in: ['u', null] } },
      { $nor: [{ userId: 'u' }] },
      { unknownPath: 'x' },
      { $or: [{ userId: 'u' }, { percentComplete: 1 }] }, // one inexact branch spoils it
    ] as Filter[]) {
      assert.equal(exactWhere(filter, kindOf), null, JSON.stringify(filter));
    }
  });
});

describe('pushdown against a real kdb-service', { skip }, () => {
  let service: ChildProcess;
  let store: DataStore;
  let tasks: Collection;
  let every: Doc[];

  before(async () => {
    process.env.DATA_KDB = 'true';
    delete process.env.DATA_MONGO;
    process.env.DATA_KDB_PUSHDOWN = 'true';
    process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
    process.env.KDB_ADDR = `tcp://127.0.0.1:${PORT}`;
    process.env.KDB_NAMESPACE_PREFIX = 'qtaskpd/docs';
    service = spawn(
      SERVICE_BIN,
      ['--memory', '--namespace', 'qtaskpd/docs', '--peer-addr', '', '--stream-addr', '', '--sql-addr', `tcp://127.0.0.1:${PORT}?bind=true`, '--log-level', 'error'],
      { stdio: 'ignore' }
    );
    await waitForPort(PORT);
    await import('../src/models/index.ts');
    const { KdbDataStore } = await import('../src/data/kdb/store.ts');
    store = new KdbDataStore();
    await store.connect();
    tasks = store.collection('tasks');

    const base = (userId: string, title: string, extra: Doc = {}): Doc => ({ userId, title, ...extra });
    await tasks.create(base('u1', 'Deploy staging', { status: 'todo', tags: ['ops', 'urgent'], percentComplete: 40, dueDate: new Date('2026-03-01T00:00:00Z'), steps: [{ text: 'deploy' }] }));
    await tasks.create(base('u1', 'Review notes', { status: 'done', tags: ['ops'], percentComplete: 100, dueDate: new Date('2026-01-01T00:00:00Z') }));
    await tasks.create(base('u2', 'Plan offsite', { status: 'todo', tags: [], percentComplete: 0 }));
    await tasks.create(base('u2', 'Write report', { status: 'in_progress', percentComplete: 55.5, projectIds: ['p1'] }));
    await tasks.create(base('u3', 'Orphan', { status: 'todo', dueDate: new Date('2026-02-01T00:00:00Z'), projectIds: ['p1', 'p2'] }));
    every = await tasks.find({});
  });

  after(async () => {
    await store?.disconnect();
    service?.kill();
  });

  const FILTERS: Array<[string, Filter]> = [
    ['equality', { userId: 'u1' }],
    ['equality on a miss', { userId: 'nobody' }],
    ['$in', { status: { $in: ['todo', 'done'] } }],
    ['number range', { percentComplete: { $gte: 40, $lt: 100 } }],
    ['float equality', { percentComplete: 55.5 }],
    ['date range', { dueDate: { $gt: new Date('2026-01-15T00:00:00Z') } }],
    ['array membership', { tags: 'ops' }],
    ['array $in', { projectIds: { $in: ['p2'] } }],
    ['nested path', { 'steps.text': 'deploy' }],
    ['null matches absent', { dueDate: null }],
    ['$exists false', { dueDate: { $exists: false } }],
    ['$ne', { status: { $ne: 'todo' } }],
    ['$nin', { status: { $nin: ['todo'] } }],
    ['$or both pushable', { $or: [{ userId: 'u1' }, { status: 'in_progress' }] }],
    ['$or with an unpushable branch', { $or: [{ userId: 'u1' }, { dueDate: null }] }],
    ['$and mixed', { $and: [{ userId: 'u2' }, { title: { $regex: 'plan', $options: 'i' } }] }],
    ['$nor', { $nor: [{ userId: 'u1' }] }],
    // Access filters, asked one branch at a time (unionBranches): overlapping branches must come
    // back once, and the rest of the filter must still apply to every branch.
    ['access: owner or project member', { $or: [{ userId: 'u2' }, { projectIds: { $in: ['p1'] } }] }],
    ['access: three branches, overlapping', { $or: [{ userId: 'u1' }, { status: 'todo' }, { projectIds: 'p1' }] }],
    ['access inside $and, with a residual', { $and: [{ $or: [{ userId: 'u1' }, { projectIds: 'p2' }] }, { status: 'todo' }] }],
    ['access with a range branch', { $or: [{ userId: 'u3' }, { percentComplete: { $gte: 50 } }] }],
    ['everything', {}],
    ['exact: array element and $in', { tags: 'ops', status: { $in: ['todo', 'in_progress'] } }],
    ['exact: no array element matches', { tags: 'nope' }],
    ['exact: nested array path', { 'steps.text': 'deploy' }],
    ['exact: $or of exact parts, one unindexed', { $or: [{ userId: 'u3' }, { title: 'Review notes' }] }],
    ['type mismatch', { percentComplete: '40' }],
    ['_id', { _id: undefined as unknown as string }],
  ];

  for (const [name, declared] of FILTERS) {
    it(`agrees with the engine: ${name}`, async () => {
      const filter: Filter = name === '_id' ? { _id: every[2]._id } : declared;
      const expected = every.filter((doc) => matchesFilter(doc, filter)).map((d) => d._id).sort();
      const actual = (await tasks.find(filter)).map((d) => d._id).sort();
      assert.deepEqual(actual, expected);
      // A count may be answered by the server (exactWhere), with nobody re-checking it after.
      assert.equal(await tasks.countDocuments(filter), expected.length, 'countDocuments');
    });
  }

  // Pages and counts decided on lean documents (leanMatches): only the fields the filter and sort
  // name are read, so each must come back exactly as stored - booleans, explicit nulls against
  // absent fields, dates - or the page and the count would differ from the engine's.
  describe('lean pages and counts', () => {
    let jobs: Collection;
    let all: Doc[];
    before(async () => {
      jobs = store.collection('embeddingJobs');
      for (let i = 0; i < 40; i++) {
        const created = await jobs.create({
          entityType: 'task', entityId: `t${i}`, taskId: `t${i}`,
          status: ['pending', 'processing', 'completed', 'failed'][i % 4], attempts: i % 5, dirty: i % 3 === 0,
          ...(i % 7 === 0 ? { lastError: 'boom' } : {}),
        });
        // An explicit null, which a lean read must tell from an absent field.
        if (i % 6 === 0) await jobs.updateOne({ _id: created._id }, { $set: { lastError: null } });
      }
      all = await jobs.find({});
    });

    const CASES: Array<[string, Filter, Record<string, 1 | -1> | undefined]> = [
      ['the queue claim', { status: 'pending', attempts: { $lt: 3 } }, { createdAt: 1 }],
      ['a boolean, true', { dirty: true }, { attempts: -1 }],
      ['a boolean, false', { dirty: false }, undefined],
      ['$exists false (absent, not null)', { lastError: { $exists: false } }, { createdAt: -1 }],
      ['$exists true (null counts as present)', { lastError: { $exists: true } }, undefined],
      ['null matches null and absent', { lastError: null }, { attempts: 1 }],
      ['$ne null', { lastError: { $ne: null } }, undefined],
      ['$or with a range', { $or: [{ status: 'failed' }, { attempts: { $gte: 4 } }] }, { attempts: 1, createdAt: -1 }],
      ['everything', {}, { attempts: -1 }],
    ];
    for (const [name, filter, sort] of CASES) {
      it(`agrees with the engine: ${name}`, async () => {
        const expected = applySort(all.filter((doc) => matchesFilter(doc, filter)), sort).map((d) => d._id);
        assert.equal(await jobs.countDocuments(filter), expected.length, 'count');
        for (const [skip, limit] of [[0, 1], [0, 5], [3, 4], [0, 1000]] as const) {
          const page = (await jobs.find(filter, { sort, skip, limit })).map((d) => d._id);
          assert.deepEqual(page, expected.slice(skip, skip + limit), `skip ${skip} limit ${limit}`);
        }
        // The claim path: findOneAndUpdate takes the first match in sort order.
        const first = await jobs.findOne(filter, sort ? { sort } : {});
        assert.equal(first?._id, expected[0]);
      });
    }

    it('returns whole documents for a lean page, projected when asked', async () => {
      const [page] = await jobs.find({ status: 'pending' }, { sort: { createdAt: 1 }, limit: 1 });
      assert.equal(typeof page!.entityId, 'string', 'a lean page is fetched whole, not returned as the partial document');
      const [projected] = await jobs.find({ status: 'pending' }, { sort: { createdAt: 1 }, limit: 1, select: 'status' });
      assert.deepEqual(Object.keys(projected!).sort(), ['_id', 'status']);
    });
  });

  it('stores an embedding packed, and returns exactly the numbers it was given', async () => {
    // Packed because kdb-service parses every document a query examines, and 768 floats per task
    // were ~40% of its CPU (packNumbers). Exact because similarity search compares them.
    const embedding = [0, -0, 1, -1, 0.1, 1 / 3, Math.PI, -2.5e-300, 1.7976931348623157e308, Number.MIN_VALUE, ...Array.from({ length: 758 }, (_, i) => Math.sin(i) * 1e-3)];
    const created = await tasks.create({ userId: 'emb-user', title: 'with embedding', embedding });
    const read = (await tasks.findById(String(created._id)))!;
    assert.equal((read.embedding as number[]).length, 768);
    (read.embedding as number[]).forEach((value, i) => assert.ok(Object.is(value, embedding[i]), `element ${i}: ${value} vs ${embedding[i]}`));
    // On the server it is one string, not 768 numbers.
    const raw = (await import(CLIENT_MODULE)) as { connect(a: string, o: object): Promise<{ get(ns: string, id: string): Promise<{ body: Doc }>; close(): Promise<void> }> };
    const client = await raw.connect(process.env.KDB_ADDR!, {});
    try {
      const { toDocumentUuid } = await import('../src/data/kdb/ids.ts');
      const stored = (await client.get('qtaskpd/docs', toDocumentUuid(String(created._id)))).body;
      assert.match(String(stored.embedding), /^f64:/);
      // A document written before packing (a plain array) still reads back as it is.
      const old = { ...stored, _id: '6b0000000000000000000001', embedding: [0.5, 0.25] };
      await (client as unknown as { upsert(ns: string, id: string, body: unknown): Promise<unknown> }).upsert('qtaskpd/docs', toDocumentUuid(old._id), old);
      assert.deepEqual((await tasks.findById(old._id))!.embedding, [0.5, 0.25]);
      await tasks.deleteOne({ _id: old._id });
    } finally {
      await client.close();
    }
    // Lean pages, counts and projections are unaffected.
    assert.equal(await tasks.countDocuments({ userId: 'emb-user' }), 1);
    const [page] = await tasks.find({ userId: 'emb-user' }, { sort: { title: 1 }, limit: 1, select: '-embedding' });
    assert.equal(page!.embedding, undefined);
    assert.equal(((await tasks.find({ userId: 'emb-user' }, { limit: 1 }))[0]!.embedding as number[]).length, 768);
    await tasks.deleteOne({ _id: created._id });
  });

  it('narrows by the rest of a filter that also names the packed embedding', async () => {
    // Search's semantic candidates: an access filter plus "has an embedding". The embedding
    // condition stays in process; the rest must still be answered right, paged or not.
    const made = await Promise.all([
      tasks.create({ userId: 'emb-a', title: 'a1', embedding: [0.5, 0.25] }),
      tasks.create({ userId: 'emb-a', title: 'a2', embedding: [] }),
      tasks.create({ userId: 'emb-a', title: 'a3' }),
      tasks.create({ userId: 'emb-b', title: 'b1', embedding: [0.75] }),
    ]);
    const filter = { $or: [{ userId: 'emb-a' }, { projectIds: { $in: ['emb-p'] } }], embedding: { $exists: true, $ne: [] } };
    const titles = (docs: Doc[]) => docs.map((d) => d.title).sort();
    assert.deepEqual(titles(await tasks.find(filter)), ['a1']);
    assert.deepEqual(titles(await tasks.find(filter, { sort: { title: 1 }, limit: 10 })), ['a1']);
    assert.deepEqual(((await tasks.find(filter, { limit: 1 }))[0]!.embedding), [0.5, 0.25]);
    assert.equal(await tasks.countDocuments(filter), 1);
    await Promise.all(made.map((doc) => tasks.deleteOne({ _id: doc._id })));
  });

  it('finds by a set of ids', async () => {
    const ids = [every[0]._id as string, every[3]._id as string];
    assert.deepEqual((await tasks.find({ _id: { $in: ids } })).map((d) => d._id).sort(), [...ids].sort());
  });

  it('refuses a duplicate with the server alone holding the constraint', async () => {
    // Every users constraint is server-held, so the in-process check is skipped (serverHoldsUnique):
    // the duplicate is the server's to refuse, and it must still read as Mongo's 11000.
    const users = store.collection('users');
    await users.create({ email: 'server-held@example.com', displayName: 'A', passwordHash: 'x' });
    await assert.rejects(
      users.create({ email: 'server-held@example.com', displayName: 'B', passwordHash: 'x' }),
      (error: { code?: number }) => error.code === 11000
    );
    // ...and updating a user without touching the unique field is not a conflict with itself.
    const [only] = await users.find({ email: 'server-held@example.com' });
    await users.updateOne({ _id: only!._id }, { $set: { displayName: 'A2' } });
    assert.equal((await users.findById(only!._id as string))?.displayName, 'A2');
  });

  it('still enforces unique constraints through the narrowed scan', async () => {
    const users = store.collection('users');
    await users.create({ email: 'dup@example.com', displayName: 'A', passwordHash: 'x' });
    await assert.rejects(users.create({ email: 'dup@example.com', displayName: 'B', passwordHash: 'x' }), /duplicate/i);
  });

  it('can query every declared schema path without a SQL error', async () => {
    const mongoose = (await import('mongoose')).default;
    for (const model of Object.values(mongoose.models)) {
      for (const path of Object.keys(model.schema.paths)) {
        if (path === '_id' || path === '__v') continue;
        const collectionName = collectionFor(model.modelName);
        if (!collectionName) continue;
        await assert.doesNotReject(
          store.collection(collectionName as never).find({ [path]: 'x' }),
          `${model.modelName}.${path} must be a valid pushed column`
        );
      }
    }
  });
});

function collectionFor(modelName: string): string | undefined {
  const lower = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const map: Record<string, string> = {
    user: 'users', task: 'tasks', project: 'projects', comment: 'comments', activity: 'activities',
    conversation: 'conversations', notification: 'notifications', invite: 'invites', feedback: 'feedback',
    feedbackVisionJob: 'feedbackVisionJobs', embeddingJob: 'embeddingJobs', llmCallMetric: 'llmCallMetrics',
    llmDailyMetric: 'llmDailyMetrics', adminAudit: 'adminAudits', mcpApiKey: 'mcpApiKeys', mcpSession: 'mcpSessions',
    mcpOAuthClient: 'mcpOAuthClients', mcpOAuthAuthorizationCode: 'mcpOAuthAuthorizationCodes',
    mcpOAuthRefreshToken: 'mcpOAuthRefreshTokens', mcpOAuthPendingConsent: 'mcpOAuthPendingConsents',
    userOAuthAuthCode: 'userOAuthAuthCodes',
  };
  return map[lower];
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((done) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => done(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`kdb-service did not open port ${port}`);
}
