/**
 * The lookup indexes MongoDB has, on KDB.
 *
 * Indexes change what a read costs, never what it returns; a wrong one would be silent. So this
 * checks the three things that can go wrong: the mapping from the Mongoose declarations is what we
 * think it is, the server really holds the indexes (and declaring them twice is harmless), and
 * indexed reads return exactly what the in-process engine returns for the awkward shapes - arrays,
 * dotted paths through arrays, date and number ranges, IN lists.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MODULE, SERVICE_BIN, kdbUnavailable } from './helpers/kdbRelease.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const PORT = Number(process.env.KDB_TEST_PORT_INDEXES ?? 7920);
const NS = 'qtaskidx/docs';
// Config is read once, when the store module is first imported - which the first describe does -
// so the environment has to be in place before any test runs.
process.env.DATA_KDB = 'true';
delete process.env.DATA_MONGO;
process.env.DATA_KDB_PUSHDOWN = 'true';
process.env.KDB_CLIENT_MODULE = CLIENT_MODULE;
process.env.KDB_ADDR = `tcp://127.0.0.1:${PORT}`;
process.env.KDB_NAMESPACE_PREFIX = NS;
const skip = kdbUnavailable;

import { matchesFilter } from '../src/data/query/filter.ts';
import type { Collection, DataStore, Doc, Filter } from '../src/data/types.ts';

describe('which indexes the store asks KDB for', () => {
  it('maps the Mongoose declarations onto leading-field indexes', async () => {
    await import('../src/models/index.ts');
    const { declaredIndexes } = await import('../src/data/kdb/store.ts');
    const wanted = declaredIndexes();

    // Single-field and the leading field of compound indexes.
    assert.equal(wanted.get('userId'), 'HASH');
    assert.equal(wanted.get('status'), 'HASH');
    assert.equal(wanted.get('projectIds'), 'HASH', 'a multikey path is a hash index too');
    assert.equal(wanted.get('collaborators.userId'), 'HASH', 'a dotted path through an array');
    assert.equal(wanted.get('taskId'), 'HASH');
    // Dates and numbers are ordered, so ranges can use them.
    assert.equal(wanted.get('startedAt'), 'BTREE');
    assert.equal(wanted.get('expiresAt'), 'BTREE', 'an invite\'s plain expiresAt index (the TTL ones are expiry, not lookups)');
    // Not lookups: text search is the application's, and TTL indexes became server expiry.
    for (const path of ['title', 'description', 'body', 'name', 'notes']) {
      assert.equal(wanted.has(path), false, `${path} is a text index in Mongo`);
    }
    // A unique field is looked up too (login by email, every MCP request by keyHash): the
    // constraint is declared separately, the lookup is an ordinary index.
    assert.equal(wanted.get('email'), 'HASH');
    assert.equal(wanted.get('keyHash'), 'HASH');
    assert.equal(wanted.get('codeHash'), 'HASH');
    // The collection discriminator every query carries, so a small collection is not read by
    // examining the whole namespace.
    assert.equal(wanted.get('_c'), 'HASH');
  });

  it('never asks for the same path twice', async () => {
    await import('../src/models/index.ts');
    const { declaredIndexes } = await import('../src/data/kdb/store.ts');
    assert.equal(new Set(declaredIndexes().keys()).size, declaredIndexes().size);
  });
});

describe('indexes on a real kdb-service', { skip }, () => {
  let service: ChildProcess;
  let store: DataStore;
  let tasks: Collection;
  let projects: Collection;
  let every: Record<string, Doc[]>;

  before(async () => {
    service = spawn(
      SERVICE_BIN,
      ['--memory', '--namespace', NS, '--sql-addr', `tcp://127.0.0.1:${PORT}?bind=true`, '--log-level', 'error'],
      { stdio: 'ignore' }
    );
    await waitForPort(PORT);
    await import('../src/models/index.ts');
    const { KdbDataStore } = await import('../src/data/kdb/store.ts');
    store = new KdbDataStore();
    await store.connect(); // declares the indexes
    tasks = store.collection('tasks');
    projects = store.collection('projects');

    const statuses = ['todo', 'in_progress', 'done'];
    for (let i = 0; i < 90; i++) {
      await tasks.create({
        userId: `u${i % 9}`,
        title: `task ${i}`,
        status: statuses[i % 3],
        projectIds: i % 7 === 0 ? ['p1', 'p2'] : i % 5 === 0 ? ['p2'] : [],
        percentComplete: i,
        dueDate: new Date(Date.UTC(2026, 0, 1 + (i % 60))),
        steps: [{ text: i % 4 === 0 ? 'deploy' : 'plan' }],
      });
    }
    for (let i = 0; i < 40; i++) {
      await projects.create({
        userId: `u${i % 9}`,
        name: `project ${i}`,
        collaborators: i % 11 === 0 ? [{ userId: 'c1', role: 'editor' }, { userId: 'c2', role: 'viewer' }] : [{ userId: `c${i % 6}`, role: 'viewer' }],
      });
    }
    every = { tasks: await tasks.find({}), projects: await projects.find({}) };
  });

  after(async () => {
    await store?.disconnect();
    service?.kill('SIGKILL');
  });

  it('holds every index it asked for, and declaring them again is harmless', async () => {
    const { KdbDataStore, declaredIndexes } = await import('../src/data/kdb/store.ts');
    // A second store over the same server: connect() declares everything again and must not fail.
    const again = new KdbDataStore();
    await again.connect();
    await again.disconnect();

    // The server's own answer to "does it exist": creating it once more is refused as a repeat.
    const raw = (await import(CLIENT_MODULE)) as { connect(a: string, t: string): Promise<{ exec(ns: string, sql: string): Promise<void>; close(): Promise<void> }> };
    const client = await raw.connect(process.env.KDB_ADDR!, '');
    try {
      for (const [path, kind] of declaredIndexes()) {
        await assert.rejects(
          client.exec(NS, `CREATE INDEX qtask_i_${path.replace(/[^A-Za-z0-9_]/g, '_')} ON docs (${path}) USING ${kind}`),
          /already registered/,
          `${path} should already be indexed`
        );
      }
    } finally {
      await client.close();
    }
  });

  const CASES: Array<[string, 'tasks' | 'projects', Filter]> = [
    ['equality on an indexed field', 'tasks', { userId: 'u3' }],
    ['two indexed equalities', 'tasks', { userId: 'u3', status: 'done' }],
    ['array membership (multikey)', 'tasks', { projectIds: 'p1' }],
    ['IN over an indexed field', 'tasks', { status: { $in: ['todo', 'done'] } }],
    ['date range, ordered index', 'tasks', { dueDate: { $gt: new Date(Date.UTC(2026, 1, 1)) } }],
    ['date range, both bounds', 'tasks', { dueDate: { $gte: new Date(Date.UTC(2026, 0, 10)), $lt: new Date(Date.UTC(2026, 0, 20)) } }],
    ['number range', 'tasks', { percentComplete: { $gte: 30, $lt: 45 } }],
    ['dotted path through an array', 'projects', { 'collaborators.userId': 'c2' }],
    ['dotted path with a second condition', 'projects', { 'collaborators.userId': 'c1', userId: 'u0' }],
    ['an $or across indexed fields', 'tasks', { $or: [{ userId: 'u1' }, { status: 'in_progress' }] }],
    ['an index plus an unindexed condition', 'tasks', { userId: 'u2', title: 'task 11' }],
    ['no match', 'tasks', { userId: 'nobody' }],
  ];

  for (const [name, collection, filter] of CASES) {
    it(`returns what the engine returns: ${name}`, async () => {
      const source = collection === 'tasks' ? tasks : projects;
      const expected = every[collection]!.filter((doc) => matchesFilter(doc, filter)).map((d) => d._id).sort();
      const actual = (await source.find(filter)).map((d) => d._id).sort();
      assert.deepEqual(actual, expected);
      assert.equal(await source.countDocuments(filter), expected.length);
    });
  }

  it('reads documents named by id with a keyed lookup, never another collection\'s', async () => {
    const someTasks = every.tasks!.slice(0, 5).map((d) => d._id as string);
    const aProject = every.projects![0]!._id as string;
    // Pushdown off or on, an `_id: {$in}` filter is answered by key; a project id among task ids
    // must not come back from the tasks collection.
    const found = await tasks.find({ _id: { $in: [...someTasks, aProject, '6a0000000000000000000000'] } });
    assert.deepEqual(found.map((d) => d._id).sort(), [...someTasks].sort());
    assert.equal(await tasks.countDocuments({ _id: { $in: someTasks }, status: 'todo' }), every.tasks!.filter((d) => someTasks.includes(d._id as string) && d.status === 'todo').length);
    assert.deepEqual(await tasks.find({ _id: { $in: [] } }), []);
    assert.equal(await tasks.countDocuments({}), every.tasks!.length, 'an unfiltered count is the server\'s COUNT(*) for the collection');
    assert.equal(await projects.countDocuments({}), every.projects!.length);
  });

  it('keeps an index current as documents change', async () => {
    const created = await tasks.create({ userId: 'idx-mover', title: 'moves', status: 'todo', projectIds: ['px'] });
    assert.equal((await tasks.find({ userId: 'idx-mover' })).length, 1);
    await tasks.updateOne({ _id: created._id }, { $set: { userId: 'idx-moved' }, $push: { projectIds: 'py' } });
    assert.equal((await tasks.find({ userId: 'idx-mover' })).length, 0, 'the old key must not still match');
    assert.equal((await tasks.find({ userId: 'idx-moved' })).length, 1);
    assert.equal((await tasks.find({ projectIds: 'py' })).length, 1);
    await tasks.deleteOne({ _id: created._id });
    assert.equal((await tasks.find({ userId: 'idx-moved' })).length, 0, 'a deleted document must leave the index');
  });
});

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
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
