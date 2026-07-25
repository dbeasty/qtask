import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.JWT_SECRET = 'test-agent-find-tasks-hybrid';

let mongo: MongoMemoryServer;
const originalFetch = globalThis.fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await mongoose.disconnect();
  await mongo.stop();
});

describe('agent find_tasks hybrid search (default on)', () => {
  it('calls Ollama embeddings when source is agent and hybrid is enabled', async () => {
    let embeddingCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        embeddingCalls += 1;
        return new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input);
    };

    const { ProjectModel, TaskModel } = await import('../src/models/index.js');
    const { executeTool } = await import('../src/agent/tools.js');

    const userId = 'agent-hybrid-on-user';
    const project = await ProjectModel.create({
      userId,
      name: 'Marketing',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
    });

    await TaskModel.create({
      userId,
      title: 'Advertise on craigslist',
      description: 'Listing',
      tags: [],
      projectIds: [String(project._id)],
      projectId: String(project._id),
      status: 'todo',
      embedding: [1, 0, 0],
    });

    const result = await executeTool(
      'find_tasks',
      { query: 'craigslist', projectId: String(project._id), limit: 5 },
      userId,
      { source: 'agent' }
    );

    assert.equal(result.success, true);
    assert.ok(embeddingCalls >= 1);

    globalThis.fetch = originalFetch;
  });
});
