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
  await new Promise((resolve) => setTimeout(resolve, 50));
  await mongoose.disconnect();
  await mongo.stop();
});

describe('embeddingQueue re-embeds edits that land while a job is already processing', () => {
  it('marks a mid-processing edit dirty and re-processes with fresh data instead of dropping it', async () => {
    const { EmbeddingJobModel, TaskModel } = await import('../src/models/index.js');
    const { enqueueEmbeddingJob, startEmbeddingWorker, stopEmbeddingWorker } = await import(
      '../src/services/embeddingQueue.js'
    );

    stopEmbeddingWorker();
    await EmbeddingJobModel.deleteMany({});

    const task = await TaskModel.create({
      userId: 'user-1',
      title: 'Original title',
      status: 'todo',
    });
    const taskId = String(task._id);

    // The first embedding call is held open until the test has had a
    // chance to enqueue a second edit while the job is still
    // 'processing', simulating a task edit that lands mid-run.
    let embedCalls = 0;
    let releaseFirstCall: () => void = () => {};
    const firstCallHeld = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.includes('/api/embeddings')) return originalFetch(input);

      embedCalls += 1;
      if (embedCalls === 1) await firstCallHeld;
      return new Response(JSON.stringify({ embedding: [embedCalls, embedCalls, embedCalls] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    startEmbeddingWorker();
    await enqueueEmbeddingJob(taskId);

    for (let i = 0; i < 50; i++) {
      const job = await EmbeddingJobModel.findOne({ taskId }).lean();
      if (job?.status === 'processing') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const midRunJob = await EmbeddingJobModel.findOne({ taskId }).lean();
    assert.equal(midRunJob?.status, 'processing');

    // Edit lands while the first run is still in flight.
    await enqueueEmbeddingJob(taskId);
    const dirtiedJob = await EmbeddingJobModel.findOne({ taskId }).lean();
    assert.equal(dirtiedJob?.status, 'processing', 'must not interrupt the in-flight run');
    assert.equal(dirtiedJob?.dirty, true, 'the mid-processing edit must be recorded, not dropped');

    releaseFirstCall();

    for (let i = 0; i < 50; i++) {
      const job = await EmbeddingJobModel.findOne({ taskId }).lean();
      if (job?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const finalJob = await EmbeddingJobModel.findOne({ taskId }).lean();
    assert.equal(finalJob?.status, 'completed');
    assert.equal(finalJob?.dirty, false);
    // Requeued and reprocessed once more, rather than the dirty edit
    // being silently discarded and the job left with a stale embedding.
    assert.equal(embedCalls, 2);

    const updatedTask = await TaskModel.findById(taskId).lean();
    assert.deepEqual(updatedTask?.embedding, [2, 2, 2]);

    stopEmbeddingWorker();
    await new Promise((resolve) => setTimeout(resolve, 50));
    globalThis.fetch = originalFetch;
  });
});
