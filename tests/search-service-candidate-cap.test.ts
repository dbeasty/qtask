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

describe('searchService candidate pool is bounded, not a full collection scan', () => {
  it('applies a finite .limit() when fetching candidates for semantic scoring', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        return new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input);
    };

    const { TaskModel } = await import('../src/models/index.js');
    const { searchService } = await import('../src/services/searchService.js');

    const userId = 'cap-user';
    await TaskModel.create({
      userId,
      title: 'A task with an embedding',
      status: 'todo',
      embedding: [0.9, 0.1, 0],
    });

    // Spy on Query#limit to see what searchService actually asks Mongo
    // for. A real fix bounds the candidate pool it loads into memory for
    // in-process cosine-similarity scoring; the pre-fix code never called
    // .limit() at all on this path and would pull in every accessible
    // task with an embedding, no matter how many exist.
    const capturedLimits: unknown[] = [];
    const originalLimit = mongoose.Query.prototype.limit;
    mongoose.Query.prototype.limit = function limitSpy(this: mongoose.Query<unknown, unknown>, n) {
      capturedLimits.push(n);
      return originalLimit.call(this, n);
    } as typeof mongoose.Query.prototype.limit;

    try {
      await searchService.search(userId, 'task');
    } finally {
      mongoose.Query.prototype.limit = originalLimit;
    }

    assert.ok(capturedLimits.length > 0, 'expected the candidate query to call .limit(...)');
    for (const limit of capturedLimits) {
      assert.equal(typeof limit, 'number');
      assert.ok((limit as number) > 0 && Number.isFinite(limit as number));
    }
  });
});
