import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('embedding worker drain loop', () => {
  it('goes idle once the queue is empty instead of busy-looping', async () => {
    const { EmbeddingJobModel } = await import('../src/models/index.js');
    const { enqueueEmbeddingJob, startEmbeddingWorker, stopEmbeddingWorker } = await import(
      '../src/services/embeddingQueue.js'
    );

    // A nonexistent task id fails fast ("Task not found") with no embedding
    // provider call, so the job drains almost immediately and the queue
    // goes genuinely empty — exactly the state that used to busy-loop.
    await enqueueEmbeddingJob(String(new Types.ObjectId()));

    const original = EmbeddingJobModel.findOneAndUpdate.bind(EmbeddingJobModel);
    let callsDuringIdleWindow = 0;
    (EmbeddingJobModel as unknown as { findOneAndUpdate: typeof original }).findOneAndUpdate = ((
      ...args: Parameters<typeof original>
    ) => {
      callsDuringIdleWindow += 1;
      return original(...args);
    }) as typeof original;

    try {
      startEmbeddingWorker();

      // Let the single job actually process and reach a terminal state.
      await sleep(200);

      // Reset the counter, then watch a window with a genuinely empty
      // queue. Each polling round-trip against an in-memory Mongo with no
      // work to do is near-instant, so an unbounded busy-loop would rack
      // up dozens-to-hundreds of calls in this window; a fixed loop stays
      // idle after the queue drains and calls enqueue's own wake-up only.
      callsDuringIdleWindow = 0;
      await sleep(300);

      assert.ok(
        callsDuringIdleWindow <= 2,
        `expected the drain loop to go idle on an empty queue, but findOneAndUpdate was called ${callsDuringIdleWindow} times in 300ms`
      );
    } finally {
      stopEmbeddingWorker();
      (EmbeddingJobModel as unknown as { findOneAndUpdate: typeof original }).findOneAndUpdate =
        original;
    }
  });
});
