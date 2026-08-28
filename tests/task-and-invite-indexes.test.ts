import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('RT-L3: task compound indexes match real query shapes', () => {
  it('TaskModel has a compound {userId, status} index', async () => {
    const { TaskModel } = await import('../src/models/index.js');
    const indexes = await TaskModel.collection.indexes();
    const match = indexes.find(
      (idx) => (idx.key as Record<string, unknown>).userId === 1 && (idx.key as Record<string, unknown>).status === 1
    );
    assert.ok(match, `expected a {userId:1, status:1} compound index, got: ${JSON.stringify(indexes)}`);
  });

  it('TaskModel has a compound {projectIds, sortOrder} index', async () => {
    const { TaskModel } = await import('../src/models/index.js');
    const indexes = await TaskModel.collection.indexes();
    const match = indexes.find(
      (idx) =>
        (idx.key as Record<string, unknown>).projectIds === 1 &&
        (idx.key as Record<string, unknown>).sortOrder === 1
    );
    assert.ok(match, `expected a {projectIds:1, sortOrder:1} compound index, got: ${JSON.stringify(indexes)}`);
  });

  it('InviteModel has exactly one index on token, not a duplicate pair', async () => {
    const { InviteModel } = await import('../src/models/index.js');
    const indexes = await InviteModel.collection.indexes();
    const tokenIndexes = indexes.filter((idx) => {
      const key = idx.key as Record<string, unknown>;
      return Object.keys(key).length === 1 && key.token === 1;
    });
    assert.equal(
      tokenIndexes.length,
      1,
      `expected exactly one single-field index on token, got: ${JSON.stringify(tokenIndexes)}`
    );
    assert.equal(tokenIndexes[0]?.unique, true);
  });
});
