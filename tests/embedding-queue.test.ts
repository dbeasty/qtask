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

describe('embeddingQueue (event-driven)', () => {
  it('processes a job immediately on enqueue without a poll timer', async () => {
    const { EmbeddingJobModel, TaskModel } = await import('../src/models/index.js');
    const { enqueueEmbeddingJob, startEmbeddingWorker, stopEmbeddingWorker } = await import(
      '../src/services/embeddingQueue.js'
    );

    let embedCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        embedCalls += 1;
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input);
    };

    stopEmbeddingWorker();

    const task = await TaskModel.create({
      userId: 'user-1',
      title: 'Index me',
      status: 'todo',
    });

    startEmbeddingWorker();
    await enqueueEmbeddingJob(String(task._id));

    for (let i = 0; i < 50; i++) {
      const job = await EmbeddingJobModel.findOne({ taskId: String(task._id) }).lean();
      if (job?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const job = await EmbeddingJobModel.findOne({ taskId: String(task._id) }).lean();
    assert.equal(job?.status, 'completed');
    assert.equal(embedCalls, 1);

    const updated = await TaskModel.findById(task._id).lean();
    assert.deepEqual(updated?.embedding, [0.1, 0.2, 0.3]);

    stopEmbeddingWorker();
    globalThis.fetch = originalFetch;
  });

  it('stopEmbeddingWorker prevents drain while disabled', async () => {
    const { EmbeddingJobModel, TaskModel } = await import('../src/models/index.js');
    const { enqueueEmbeddingJob, stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');

    let embedCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        embedCalls += 1;
        return new Response(JSON.stringify({ embedding: [0.5] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input);
    };

    stopEmbeddingWorker();

    const task = await TaskModel.create({
      userId: 'user-2',
      title: 'Should not index',
      status: 'todo',
    });

    await enqueueEmbeddingJob(String(task._id));
    await new Promise((r) => setTimeout(r, 100));

    const job = await EmbeddingJobModel.findOne({ taskId: String(task._id) }).lean();
    assert.equal(job?.status, 'pending');
    assert.equal(embedCalls, 0);

    globalThis.fetch = originalFetch;
  });

  it('re-queues a completed job when the task is updated again', async () => {
    const { EmbeddingJobModel } = await import('../src/models/index.js');
    const { enqueueEmbeddingJob, stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');

    stopEmbeddingWorker();

    const taskId = new mongoose.Types.ObjectId().toString();
    await EmbeddingJobModel.create({
      entityType: 'task',
      entityId: taskId,
      taskId,
      status: 'completed',
      attempts: 1,
    });

    await enqueueEmbeddingJob(taskId);

    const job = await EmbeddingJobModel.findOne({ taskId }).lean();
    assert.equal(job?.status, 'pending');
  });

  it('does not re-queue while a job is processing', async () => {
    const { EmbeddingJobModel } = await import('../src/models/index.js');
    const { enqueueEmbeddingJob, stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');

    stopEmbeddingWorker();

    const taskId = new mongoose.Types.ObjectId().toString();
    await EmbeddingJobModel.create({
      entityType: 'task',
      entityId: taskId,
      taskId,
      status: 'processing',
      attempts: 1,
    });

    await enqueueEmbeddingJob(taskId);

    const job = await EmbeddingJobModel.findOne({ taskId }).lean();
    assert.equal(job?.status, 'processing');
    assert.equal(job?.attempts, 1);
  });

  it('processes a project embedding job', async () => {
    const { EmbeddingJobModel, ProjectModel } = await import('../src/models/index.js');
    const {
      enqueueProjectEmbeddingJob,
      startEmbeddingWorker,
      stopEmbeddingWorker,
    } = await import('../src/services/embeddingQueue.js');

    let embedCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        embedCalls += 1;
        return new Response(JSON.stringify({ embedding: [0.4, 0.5, 0.6] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input);
    };

    stopEmbeddingWorker();
    await EmbeddingJobModel.deleteMany({});

    const project = await ProjectModel.create({
      userId: 'user-project',
      name: 'Garden Project',
      description: 'Plant beds',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
    });

    startEmbeddingWorker();
    await enqueueProjectEmbeddingJob(String(project._id));

    for (let i = 0; i < 50; i++) {
      const job = await EmbeddingJobModel.findOne({
        entityType: 'project',
        entityId: String(project._id),
      }).lean();
      if (job?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const job = await EmbeddingJobModel.findOne({
      entityType: 'project',
      entityId: String(project._id),
    }).lean();
    assert.equal(job?.status, 'completed');
    assert.equal(embedCalls, 1);

    const updated = await ProjectModel.findById(project._id).lean();
    assert.deepEqual(updated?.embedding, [0.4, 0.5, 0.6]);

    stopEmbeddingWorker();
    await new Promise((resolve) => setTimeout(resolve, 50));
    globalThis.fetch = originalFetch;
  });
});
