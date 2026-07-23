import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';

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
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

function mockEmbeddings(vector: number[] = [1, 0, 0]) {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      return new Response(JSON.stringify({ embedding: vector }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input);
  };
}

describe('searchService', () => {
  it('returns matching projects and tasks with hybrid search', async () => {
    mockEmbeddings([1, 0, 0]);

    const { ProjectModel, TaskModel } = await import('../src/models/index.js');
    const { searchService } = await import('../src/services/searchService.js');

    const userId = 'search-user-1';
    const project = await ProjectModel.create({
      userId,
      name: 'Kitchen Remodel',
      description: 'Cabinet and plumbing work',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
      embedding: [1, 0, 0],
    });

    await TaskModel.create({
      userId,
      title: 'Fix faucet',
      description: 'Replace cartridge under sink',
      tags: ['plumbing'],
      steps: [{ text: 'Shut off water', done: false }],
      projectIds: [String(project._id)],
      projectId: String(project._id),
      status: 'todo',
      embedding: [0.9, 0.1, 0],
    });

    const results = await searchService.search(userId, 'plumbing kitchen');
    assert.ok(results.projects.some((hit) => hit.id === String(project._id)));
    assert.ok(results.tasks.some((hit) => hit.title === 'Fix faucet'));
  });

  it('respects project access boundaries', async () => {
    mockEmbeddings();

    const { ProjectModel } = await import('../src/models/index.js');
    const { searchService } = await import('../src/services/searchService.js');

    const project = await ProjectModel.create({
      userId: 'owner-user',
      name: 'Secret Project',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
      embedding: [1, 0, 0],
    });

    const results = await searchService.search('other-user', 'Secret');
    assert.equal(
      results.projects.some((hit) => hit.id === String(project._id)),
      false
    );
  });

  it('falls back to regex when text and semantic search miss', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        throw new Error('ollama unavailable');
      }
      return originalFetch(input);
    };

    const { TaskModel } = await import('../src/models/index.js');
    const { searchService } = await import('../src/services/searchService.js');

    const userId = 'regex-user';
    await TaskModel.create({
      userId,
      title: 'UniqueZebraTask',
      description: 'Nothing semantic here',
      tags: [],
      status: 'todo',
    });

    const results = await searchService.search(userId, 'UniqueZebraTask');
    assert.ok(results.tasks.some((hit) => hit.title === 'UniqueZebraTask'));

    globalThis.fetch = originalFetch;
  });
});
