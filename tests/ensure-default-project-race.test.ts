import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

describe('ensureDefaultProject concurrency', () => {
  it('two concurrent calls for a brand-new user create only one default project', async () => {
    const { ProjectModel } = await import('../src/models/index.js');
    const { projectService } = await import('../src/services/projectService.js');

    const userId = randomUUID();

    const [idA, idB] = await Promise.all([
      projectService.ensureDefaultProject(userId),
      projectService.ensureDefaultProject(userId),
    ]);

    assert.equal(idA, idB, 'both callers must resolve to the same default project');

    const projects = await ProjectModel.find({ userId, staging: { $exists: false } }).lean();
    assert.equal(projects.length, 1, 'exactly one default project must exist, not one per caller');
  });
});
