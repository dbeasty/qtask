import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import type { VisionCheckResult } from '../src/services/feedbackVisionService.js';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.JWT_SECRET = 'test-user-jwt-secret';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_AUTH_MODE = 'password';
process.env.HASH_ADMIN_PASSWORD = 'false';
process.env.ADMIN_COOKIE_SECURE = 'false';
process.env.SERVE_CLIENT = 'false';
process.env.FEEDBACK_ENABLED = 'true';
process.env.FEEDBACK_IMAGES_ENABLED = 'true';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let mongo: MongoMemoryServer;
let app: Express;
let adminApp: Express;
let storageRoot: string;
let storage: import('../src/services/storage/local.js').LocalObjectStorage;
let userToken: string;
let userId: string;
let FeedbackModel: typeof import('../src/models/index.js').FeedbackModel;
let FeedbackVisionJobModel: typeof import('../src/models/index.js').FeedbackVisionJobModel;
let NotificationModel: typeof import('../src/models/index.js').NotificationModel;
let setScreenshotClassifierForTests: typeof import('../src/services/feedbackVisionService.js').setScreenshotClassifierForTests;
let startFeedbackVisionWorker: typeof import('../src/services/feedbackVisionQueue.js').startFeedbackVisionWorker;
let stopFeedbackVisionWorker: typeof import('../src/services/feedbackVisionQueue.js').stopFeedbackVisionWorker;

function acceptScreenshot(): Promise<VisionCheckResult> {
  return Promise.resolve({
    isScreenshot: true,
    confidence: 0.95,
    model: 'test-vision',
    checkedAt: new Date(),
  });
}

function rejectScreenshot(): Promise<VisionCheckResult> {
  return Promise.resolve({
    isScreenshot: false,
    confidence: 0.2,
    model: 'test-vision',
    rationale: 'Not a UI screenshot',
    checkedAt: new Date(),
  });
}

async function waitForJob(feedbackId: string, expected: 'completed' | 'failed', timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await FeedbackVisionJobModel.findOne({ feedbackId }).lean();
    if (job?.status === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const job = await FeedbackVisionJobModel.findOne({ feedbackId }).lean();
  assert.fail(`Expected job status ${expected}, got ${job?.status ?? 'missing'}`);
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qtask-feedback-'));
  const [
    { LocalObjectStorage },
    { setObjectStorageForTests },
    { setScreenshotClassifierForTests: setClassifier },
    { FeedbackModel: feedbackModel },
    { FeedbackVisionJobModel: visionJobModel },
    { NotificationModel: notificationModel },
    { createApp },
    { createAdminApp },
    { signToken },
    { startFeedbackVisionWorker: startWorker },
    { stopFeedbackVisionWorker: stopWorker },
  ] = await Promise.all([
    import('../src/services/storage/local.js'),
    import('../src/services/storage/index.js'),
    import('../src/services/feedbackVisionService.js'),
    import('../src/models/index.js'),
    import('../src/models/index.js'),
    import('../src/models/index.js'),
    import('../src/app.js'),
    import('../src/admin/app.js'),
    import('../src/auth/jwt.js'),
    import('../src/services/feedbackVisionQueue.js'),
    import('../src/services/feedbackVisionQueue.js'),
  ]);
  storage = new LocalObjectStorage(storageRoot);
  setObjectStorageForTests(storage);
  setScreenshotClassifierForTests = setClassifier;
  setScreenshotClassifierForTests(acceptScreenshot);
  FeedbackModel = feedbackModel;
  FeedbackVisionJobModel = visionJobModel;
  NotificationModel = notificationModel;
  startFeedbackVisionWorker = startWorker;
  stopFeedbackVisionWorker = stopWorker;

  app = await createApp({ connect: true, startWorker: false });
  startFeedbackVisionWorker();
  adminApp = await createAdminApp({ connect: false, serveClient: false });

  const { UserModel } = await import('../src/models/index.js');
  const bcrypt = (await import('bcryptjs')).default;
  const user = await UserModel.create({
    email: 'feedback@example.com',
    passwordHash: await bcrypt.hash('password123', 4),
    emailVerified: true,
  });
  userId = String(user._id);
  userToken = signToken({ sub: userId, email: user.email });
});

after(async () => {
  stopFeedbackVisionWorker();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const { setObjectStorageForTests } = await import('../src/services/storage/index.js');
  setScreenshotClassifierForTests(null);
  setObjectStorageForTests(null);
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(storageRoot, { recursive: true, force: true });
});

async function adminSession() {
  const agent = request.agent(adminApp);
  const login = await agent
    .post('/api/admin/auth/login')
    .send({ password: 'test-admin-password' })
    .expect(200);
  return { agent, csrf: login.body.csrfToken as string };
}

describe('feedback API', () => {
  it('requires authentication', async () => {
    await request(app).post('/api/feedback').expect(401);
  });

  it('returns 503 when feedback is disabled', async () => {
    process.env.FEEDBACK_ENABLED = 'false';
    try {
      await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${userToken}`)
        .field('message', 'Something broke')
        .attach('attachments', PNG, { filename: 'screen.png', contentType: 'image/png' })
        .expect(503);
    } finally {
      process.env.FEEDBACK_ENABLED = 'true';
    }
  });

  it('rejects submissions without attachments when images are enabled', async () => {
    await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${userToken}`)
      .field('message', 'Something broke')
      .expect(400);
  });

  it('accepts text-only feedback when images are disabled', async () => {
    process.env.FEEDBACK_IMAGES_ENABLED = 'false';
    try {
      const response = await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${userToken}`)
        .field('message', 'Text only feedback')
        .field('category', 'feature')
        .expect(201);

      assert.equal(response.body.validationStatus, 'validated');
      assert.equal(response.body.attachmentCount, 0);
    } finally {
      process.env.FEEDBACK_IMAGES_ENABLED = 'true';
    }
  });

  it('creates feedback with pending validation and completes asynchronously', async () => {
    const response = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${userToken}`)
      .field('message', 'Button does not work')
      .field('category', 'bug')
      .attach('attachments', PNG, { filename: 'screen.png', contentType: 'image/png' })
      .expect(201);

    assert.equal(response.body.category, 'bug');
    assert.equal(response.body.validationStatus, 'pending');
    assert.equal(response.body.attachmentCount, 1);

    await waitForJob(response.body.id, 'completed');

    const doc = await FeedbackModel.findById(response.body.id).lean();
    assert.ok(doc);
    assert.equal(doc?.validationStatus, 'validated');
    assert.equal(doc?.attachments?.length, 1);
    assert.ok(doc?.attachments?.[0]?.visionCheck);
    const stored = await storage.get(doc!.attachments![0].storageKey);
    assert.ok(stored);
  });

  it('rejects non-screenshot images asynchronously with notification', async () => {
    setScreenshotClassifierForTests(rejectScreenshot);
    const response = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${userToken}`)
      .field('message', 'Bad upload')
      .attach('attachments', PNG, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);

    assert.equal(response.body.validationStatus, 'pending');
    await waitForJob(response.body.id, 'completed');

    const doc = await FeedbackModel.findById(response.body.id).lean();
    assert.equal(doc?.validationStatus, 'rejected');
    assert.equal(doc?.attachments?.length, 0);

    const notification = await NotificationModel.findOne({ userId, type: 'feedback_rejected' }).lean();
    assert.ok(notification);
    setScreenshotClassifierForTests(acceptScreenshot);
  });

  it('exposes validation status for the submitting user', async () => {
    const doc = await FeedbackModel.findOne({ userId, message: 'Button does not work' }).lean();
    assert.ok(doc);

    const response = await request(app)
      .get(`/api/feedback/${String(doc!._id)}`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);

    assert.equal(response.body.validationStatus, 'validated');
  });
});

describe('health features', () => {
  it('includes feedback feature flags', async () => {
    const response = await request(app).get('/health').expect(200);
    assert.equal(response.body.features.feedback, true);
    assert.equal(response.body.features.feedbackImages, true);
  });
});

describe('admin feedback API', () => {
  it('lists feedback for admins', async () => {
    const { agent } = await adminSession();
    const response = await agent.get('/api/admin/feedback').expect(200);
    assert.ok(response.body.total >= 1);
    assert.ok(Array.isArray(response.body.items));
    assert.ok(response.body.items[0].validationStatus);
  });

  it('returns feedback detail and attachment bytes', async () => {
    const doc = await FeedbackModel.findOne({ userId, message: 'Button does not work' }).lean();
    assert.ok(doc);
    const { agent } = await adminSession();

    const detail = await agent.get(`/api/admin/feedback/${String(doc!._id)}`).expect(200);
    assert.equal(detail.body.message, 'Button does not work');
    assert.equal(detail.body.validationStatus, 'validated');

    const attachment = await agent
      .get(`/api/admin/feedback/${String(doc!._id)}/attachments/0`)
      .expect(200);
    assert.equal(attachment.headers['content-type'], 'image/png');
    assert.ok(attachment.body.length > 0);
  });

  it('updates feedback status with CSRF', async () => {
    const doc = await FeedbackModel.findOne({ userId, message: 'Button does not work' }).lean();
    assert.ok(doc);
    const { agent, csrf } = await adminSession();

    await agent
      .patch(`/api/admin/feedback/${String(doc!._id)}`)
      .set('x-csrf-token', csrf)
      .send({ status: 'read' })
      .expect(200);

    const updated = await FeedbackModel.findById(doc!._id).lean();
    assert.equal(updated?.status, 'read');
  });

  it('updates feedback status without creating a notification', async () => {
    process.env.FEEDBACK_IMAGES_ENABLED = 'false';
    try {
      const created = await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${userToken}`)
        .field('message', 'Status-only update test')
        .expect(201);

      const beforeCount = await NotificationModel.countDocuments({ userId, type: 'feedback_reply' });
      const { agent, csrf } = await adminSession();

      await agent
        .patch(`/api/admin/feedback/${created.body.id}`)
        .set('x-csrf-token', csrf)
        .send({ status: 'resolved' })
        .expect(200);

      const updated = await FeedbackModel.findById(created.body.id).lean();
      assert.equal(updated?.status, 'resolved');
      assert.equal(await NotificationModel.countDocuments({ userId, type: 'feedback_reply' }), beforeCount);
    } finally {
      process.env.FEEDBACK_IMAGES_ENABLED = 'true';
    }
  });

  it('admin reply resolves feedback and notifies the submitter', async () => {
    process.env.FEEDBACK_IMAGES_ENABLED = 'false';
    try {
      const created = await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${userToken}`)
        .field('message', 'Please fix the sidebar')
        .expect(201);

      const { agent, csrf } = await adminSession();
      const response = await agent
        .patch(`/api/admin/feedback/${created.body.id}`)
        .set('x-csrf-token', csrf)
        .send({ reply: 'Fixed in the latest release.' })
        .expect(200);

      assert.equal(response.body.status, 'resolved');
      assert.equal(response.body.adminReply.message, 'Fixed in the latest release.');

      const updated = await FeedbackModel.findById(created.body.id).lean();
      assert.equal(updated?.status, 'resolved');
      assert.equal(updated?.adminReply?.message, 'Fixed in the latest release.');

      const notification = await NotificationModel.findOne({
        userId,
        type: 'feedback_reply',
        'payload.feedbackId': created.body.id,
      }).lean();
      assert.ok(notification);
      assert.equal(notification?.payload.reply, 'Fixed in the latest release.');

      const userView = await request(app)
        .get(`/api/feedback/${created.body.id}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      assert.equal(userView.body.adminReply.message, 'Fixed in the latest release.');

      await agent
        .patch(`/api/admin/feedback/${created.body.id}`)
        .set('x-csrf-token', csrf)
        .send({ reply: 'Another reply' })
        .expect(409);
    } finally {
      process.env.FEEDBACK_IMAGES_ENABLED = 'true';
    }
  });
});

describe('admin user delete cascades feedback', () => {
  it('deletes feedback documents and storage objects', async () => {
    const doc = await FeedbackModel.findOne({ userId, message: 'Button does not work' }).lean();
    assert.ok(doc);
    const storageKey = doc!.attachments![0].storageKey;
    const { agent, csrf } = await adminSession();

    await agent
      .delete(`/api/admin/users/${userId}`)
      .set('x-csrf-token', csrf)
      .send({})
      .expect(200);

    assert.equal(await FeedbackModel.countDocuments({ userId }), 0);
    assert.equal(await storage.get(storageKey), null);
  });
});
