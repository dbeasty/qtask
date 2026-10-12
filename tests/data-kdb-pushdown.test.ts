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

import { buildWhere } from '../src/data/kdb/pushdown.ts';
import { matchesFilter } from '../src/data/query/filter.ts';
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
    ['type mismatch', { percentComplete: '40' }],
    ['_id', { _id: undefined as unknown as string }],
  ];

  for (const [name, declared] of FILTERS) {
    it(`agrees with the engine: ${name}`, async () => {
      const filter: Filter = name === '_id' ? { _id: every[2]._id } : declared;
      const expected = every.filter((doc) => matchesFilter(doc, filter)).map((d) => d._id).sort();
      const actual = (await tasks.find(filter)).map((d) => d._id).sort();
      assert.deepEqual(actual, expected);
    });
  }

  it('finds by a set of ids', async () => {
    const ids = [every[0]._id as string, every[3]._id as string];
    assert.deepEqual((await tasks.find({ _id: { $in: ids } })).map((d) => d._id).sort(), [...ids].sort());
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
