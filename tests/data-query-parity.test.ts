/**
 * Proves the in-process query engine agrees with a real MongoDB.
 *
 * This is the parity gate the whole data-layer abstraction rests on. A backend
 * without a comparable query engine (KDB) gets handed the same filters and has to
 * reach the same answers; the only trustworthy way to know it will is to run every
 * filter, sort and update against mongod and against the engine and compare.
 *
 * Every case here is a query shape the application actually issues — the operators
 * were taken from the existing services, not invented.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Collection as MongoCollection } from 'mongodb';

import { matchesFilter } from '../src/data/query/filter.ts';
import { applyUpdate } from '../src/data/query/update.ts';
import { applySort } from '../src/data/query/shape.ts';

process.env.NODE_ENV = 'test';

let mongo: MongoMemoryServer;
let client: MongoClient;
let collection: MongoCollection<Record<string, unknown>>;

/** A corpus shaped like the application's own documents: array fields, nested
 *  subdocuments, optional fields, dates and mixed types. */
const CORPUS: Record<string, unknown>[] = [
  {
    _id: 'a',
    userId: 'u1',
    title: 'Deploy staging server',
    status: 'todo',
    priority: 'high',
    tags: ['ops', 'urgent'],
    projectIds: ['p1', 'p2'],
    steps: [{ text: 'provision', done: false }, { text: 'deploy', done: true }],
    collaborators: [{ userId: 'u2', role: 'editor' }],
    percentComplete: 40,
    hoursSpent: 5,
    dueDate: new Date('2026-03-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  {
    _id: 'b',
    userId: 'u1',
    title: 'Review deploy notes',
    status: 'done',
    priority: 'low',
    tags: ['ops'],
    projectIds: ['p2'],
    steps: [],
    collaborators: [],
    percentComplete: 100,
    hoursSpent: 3,
    dueDate: new Date('2026-02-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
  },
  {
    _id: 'c',
    userId: 'u2',
    title: 'Unrelated chore',
    status: 'todo',
    priority: 'medium',
    tags: [],
    projectIds: [],
    steps: [{ text: 'think', done: false }],
    collaborators: [{ userId: 'u1', role: 'viewer' }, { userId: 'u3', role: 'manager' }],
    percentComplete: 0,
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    staging: { conversationId: 'conv-1', proposalId: 'prop-1' },
  },
  {
    _id: 'd',
    userId: 'u3',
    title: 'No optional fields at all',
    status: 'in_progress',
    priority: 'medium',
    percentComplete: 55,
    createdAt: new Date('2026-01-04T00:00:00.000Z'),
    embedding: [0.1, 0.2],
  },
];

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
  collection = client.db('parity').collection('docs');
  await collection.insertMany(CORPUS.map((doc) => ({ ...doc })));
});

after(async () => {
  await client.close();
  await mongo.stop();
});

async function mongoIds(filter: Record<string, unknown>): Promise<string[]> {
  const found = await collection.find(filter).project({ _id: 1 }).toArray();
  return found.map((doc) => String(doc._id)).sort();
}

function engineIds(filter: Record<string, unknown>): string[] {
  return CORPUS.filter((doc) => matchesFilter(doc, filter))
    .map((doc) => String(doc._id))
    .sort();
}

async function assertSameMatches(name: string, filter: Record<string, unknown>): Promise<void> {
  const expected = await mongoIds(filter);
  const actual = engineIds(filter);
  assert.deepEqual(actual, expected, `${name}: engine returned ${JSON.stringify(actual)}, mongod returned ${JSON.stringify(expected)}`);
}

describe('filter parity with mongod', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['implicit equality', { status: 'todo' }],
    ['equality on an array field', { projectIds: 'p1' }],
    ['equality on a tag', { tags: 'ops' }],
    ['equality matching nothing', { status: 'cancelled' }],
    ['nested path', { 'staging.proposalId': 'prop-1' }],
    ['nested path through an array', { 'collaborators.userId': 'u1' }],
    ['nested path through an array, no match', { 'collaborators.userId': 'nobody' }],
    ['array of subdocs by field', { 'steps.done': true }],
    ['$eq', { status: { $eq: 'done' } }],
    ['$ne', { status: { $ne: 'todo' } }],
    ['$ne on a missing field', { assigneeId: { $ne: 'u1' } }],
    ['$in', { status: { $in: ['todo', 'done'] } }],
    ['$in over an array field', { projectIds: { $in: ['p1'] } }],
    ['$in matching nothing', { status: { $in: ['nope'] } }],
    ['$nin', { status: { $nin: ['todo'] } }],
    ['$gt on a number', { percentComplete: { $gt: 40 } }],
    ['$gte on a number', { percentComplete: { $gte: 40 } }],
    ['$lt on a number', { percentComplete: { $lt: 40 } }],
    ['$lte on a number', { percentComplete: { $lte: 40 } }],
    ['$gt on a date', { dueDate: { $gt: new Date('2026-02-15T00:00:00.000Z') } }],
    ['$lte on a date', { createdAt: { $lte: new Date('2026-01-02T00:00:00.000Z') } }],
    ['range on both ends', { percentComplete: { $gte: 40, $lte: 100 } }],
    ['$exists true', { staging: { $exists: true } }],
    ['$exists false', { staging: { $exists: false } }],
    ['$exists false on a field some docs lack', { dueDate: { $exists: false } }],
    ['$exists true on an array field', { embedding: { $exists: true } }],
    ['$regex string', { title: { $regex: 'deploy', $options: 'i' } }],
    ['$regex anchored', { title: { $regex: '^Deploy' } }],
    ['$regex no match', { title: { $regex: 'zzz' } }],
    ['$all', { tags: { $all: ['ops', 'urgent'] } }],
    ['$all single', { tags: { $all: ['ops'] } }],
    ['$size', { projectIds: { $size: 2 } }],
    ['$size zero', { tags: { $size: 0 } }],
    ['$elemMatch on subdocs', { collaborators: { $elemMatch: { role: 'manager' } } }],
    ['$elemMatch with two conditions', { collaborators: { $elemMatch: { userId: 'u1', role: 'viewer' } } }],
    ['$elemMatch matching nothing', { collaborators: { $elemMatch: { role: 'nope' } } }],
    ['$or', { $or: [{ userId: 'u1' }, { projectIds: { $in: ['p1'] } }] }],
    ['$or with no matches', { $or: [{ userId: 'nobody' }, { status: 'cancelled' }] }],
    ['$and', { $and: [{ userId: 'u1' }, { status: 'todo' }] }],
    ['$nor', { $nor: [{ status: 'todo' }] }],
    ['$not with an operator', { percentComplete: { $not: { $gt: 40 } } }],
    ['top-level combination', {
      $or: [{ userId: 'u1' }, { 'collaborators.userId': 'u1' }],
      status: { $ne: 'done' },
    }],
    ['the accessible-task shape', {
      $or: [{ userId: 'u1' }, { projectIds: { $in: ['p2'] } }],
      staging: { $exists: false },
    }],
  ];

  for (const [name, filter] of cases) {
    it(name, async () => {
      await assertSameMatches(name, filter);
    });
  }
});

describe('sort parity with mongod', () => {
  const cases: Array<[string, Record<string, 1 | -1>]> = [
    ['ascending string', { status: 1 }],
    ['descending string', { status: -1 }],
    ['ascending number', { percentComplete: 1 }],
    ['descending number', { percentComplete: -1 }],
    ['ascending date', { createdAt: 1 }],
    ['descending date', { createdAt: -1 }],
    ['a field some documents lack', { dueDate: 1 }],
    ['a field some documents lack, descending', { dueDate: -1 }],
    ['two keys', { status: 1, percentComplete: -1 }],
  ];

  for (const [name, sort] of cases) {
    it(name, async () => {
      // _id breaks ties on both sides, so the comparison tests the sort keys
      // rather than either side's incidental ordering of equal documents.
      const withTieBreak = { ...sort, _id: 1 as const };
      const expected = (await collection.find({}).sort(withTieBreak).project({ _id: 1 }).toArray()).map((d) =>
        String(d._id)
      );
      const actual = applySort(CORPUS, withTieBreak).map((doc) => String(doc._id));
      assert.deepEqual(actual, expected, name);
    });
  }
});

describe('update parity with mongod', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['$set a scalar', { $set: { status: 'done' } }],
    ['$set a nested path', { $set: { 'staging.proposalId': 'prop-9' } }],
    ['$set creating a nested path', { $set: { 'tracking.hours': 3 } }],
    ['$set an array', { $set: { tags: ['x', 'y'] } }],
    ['$unset', { $unset: { priority: '' } }],
    ['$unset a missing field', { $unset: { nothingHere: '' } }],
    ['$inc', { $inc: { percentComplete: 5 } }],
    ['$inc a missing field', { $inc: { attempts: 1 } }],
    ['$inc negative', { $inc: { percentComplete: -10 } }],
    ['$push', { $push: { tags: 'new' } }],
    ['$push with $each', { $push: { tags: { $each: ['x', 'y'] } } }],
    ['$push onto a missing field', { $push: { history: 'first' } }],
    ['$addToSet new value', { $addToSet: { tags: 'fresh' } }],
    ['$addToSet existing value', { $addToSet: { tags: 'ops' } }],
    ['$pull by value', { $pull: { tags: 'ops' } }],
    ['$pull by operator', { $pull: { tags: { $in: ['ops', 'urgent'] } } }],
    ['$min lower', { $min: { percentComplete: 10 } }],
    ['$max higher', { $max: { percentComplete: 99 } }],
    ['two operators at once', { $set: { status: 'done' }, $inc: { percentComplete: 1 } }],
  ];

  for (const [name, update] of cases) {
    it(name, async () => {
      const source = CORPUS[0]!;
      const scratch = client.db('parity').collection('update_scratch');
      await scratch.deleteMany({});
      await scratch.insertOne({ ...source });
      await scratch.updateOne({ _id: source._id as never }, update as never);
      const expected = await scratch.findOne({ _id: source._id as never });

      const actual = applyUpdate(source, update);

      assert.deepEqual(
        normalize(actual),
        normalize(expected as Record<string, unknown>),
        `${name}: engine and mongod disagree`
      );
    });
  }
});

/** Dates compare by instant, and key order is not meaningful in either store. */
function normalize(doc: Record<string, unknown> | null): unknown {
  if (!doc) return doc;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(doc).sort()) {
    const value = doc[key];
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
