import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.FEEDBACK_IMAGES_ENABLED = 'true';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let mongo: MongoMemoryServer;
let storageRoot: string;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qtask-feedback-queue-'));
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  const { stopFeedbackVisionWorker } = await import('../src/services/feedbackVisionQueue.js');
  const { setScreenshotClassifierForTests } = await import('../src/services/feedbackVisionService.js');
  const { setObjectStorageForTests } = await import('../src/services/storage/index.js');
  stopFeedbackVisionWorker();
  setScreenshotClassifierForTests(null);
  setObjectStorageForTests(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(storageRoot, { recursive: true, force: true });
});

describe('feedbackVisionQueue', () => {
  it('processes a job immediately on enqueue', async () => {
    const { FeedbackModel, FeedbackVisionJobModel } = await import('../src/models/index.js');
    const { LocalObjectStorage } = await import('../src/services/storage/local.js');
    const { setObjectStorageForTests } = await import('../src/services/storage/index.js');
    const { setScreenshotClassifierForTests } = await import('../src/services/feedbackVisionService.js');
    const {
      enqueueFeedbackVisionJob,
      startFeedbackVisionWorker,
      stopFeedbackVisionWorker,
    } = await import('../src/services/feedbackVisionQueue.js');

    const storage = new LocalObjectStorage(storageRoot);
    setObjectStorageForTests(storage);
    setScreenshotClassifierForTests(async () => ({
      isScreenshot: true,
      confidence: 0.99,
      model: 'test-vision',
      checkedAt: new Date(),
    }));

    stopFeedbackVisionWorker();

    const storageKey = 'feedback/11111111-1111-1111-1111-111111111111.png';
    await storage.put(storageKey, PNG, 'image/png');

    const feedback = await FeedbackModel.create({
      userId: 'user-queue',
      message: 'Queue test',
      category: 'bug',
      validationStatus: 'pending',
      attachments: [{ storageKey, contentType: 'image/png', sizeBytes: PNG.length }],
    });

    startFeedbackVisionWorker();
    await enqueueFeedbackVisionJob(String(feedback._id));

    for (let i = 0; i < 50; i++) {
      const job = await FeedbackVisionJobModel.findOne({ feedbackId: String(feedback._id) }).lean();
      if (job?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const job = await FeedbackVisionJobModel.findOne({ feedbackId: String(feedback._id) }).lean();
    assert.equal(job?.status, 'completed');

    const updated = await FeedbackModel.findById(feedback._id).lean();
    assert.equal(updated?.validationStatus, 'validated');
    assert.equal(updated?.attachments?.[0]?.visionCheck?.confidence, 0.99);

    stopFeedbackVisionWorker();
  });

  it('stopFeedbackVisionWorker prevents drain while disabled', async () => {
    const { FeedbackModel, FeedbackVisionJobModel } = await import('../src/models/index.js');
    const { enqueueFeedbackVisionJob, stopFeedbackVisionWorker } = await import(
      '../src/services/feedbackVisionQueue.js'
    );

    stopFeedbackVisionWorker();

    const feedback = await FeedbackModel.create({
      userId: 'user-queue-2',
      message: 'Paused',
      validationStatus: 'pending',
      attachments: [],
    });

    await enqueueFeedbackVisionJob(String(feedback._id));

    await new Promise((resolve) => setTimeout(resolve, 100));

    const job = await FeedbackVisionJobModel.findOne({ feedbackId: String(feedback._id) }).lean();
    assert.equal(job?.status, 'pending');
  });
});
