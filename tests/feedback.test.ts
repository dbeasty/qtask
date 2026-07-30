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
let setScreenshotClassifierForTests: typeof import('../src/services/feedbackService.js').setScreenshotClassifierForTests;

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

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qtask-feedback-'));
  const [
    { LocalObjectStorage },
    { setObjectStorageForTests },
    { setScreenshotClassifierForTests: setClassifier },
    { FeedbackModel: feedbackModel },
    { createApp },
    { createAdminApp },
    { signToken },
  ] = await Promise.all([
    import('../src/services/storage/local.js'),
    import('../src/services/storage/index.js'),
    import('../src/services/feedbackService.js'),
    import('../src/models/index.js'),
    import('../src/app.js'),
    import('../src/admin/app.js'),
    import('../src/auth/jwt.js'),
  ]);
  storage = new LocalObjectStorage(storageRoot);
  setObjectStorageForTests(storage);
  setScreenshotClassifierForTests = setClassifier;
  setScreenshotClassifierForTests(acceptScreenshot);
  FeedbackModel = feedbackModel;

  app = await createApp({ connect: true, startWorker: false });
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

  it('rejects submissions without attachments', async () => {
    await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${userToken}`)
      .field('message', 'Something broke')
      .expect(400);
  });

  it('creates feedback when screenshot validation passes', async () => {
    const response = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${userToken}`)
      .field('message', 'Button does not work')
      .field('category', 'bug')
      .attach('attachments', PNG, { filename: 'screen.png', contentType: 'image/png' })
      .expect(201);

    assert.equal(response.body.category, 'bug');
    assert.equal(response.body.attachmentCount, 1);

    const doc = await FeedbackModel.findById(response.body.id).lean();
    assert.ok(doc);
    assert.equal(doc?.attachments?.length, 1);
    const stored = await storage.get(doc!.attachments![0].storageKey);
    assert.ok(stored);
  });

  it('rejects non-screenshot images with 422', async () => {
    setScreenshotClassifierForTests(rejectScreenshot);
    const response = await request(app)
      .post('/api/feedback')
      .set('Authorization', `Bearer ${userToken}`)
      .field('message', 'Bad upload')
      .attach('attachments', PNG, { filename: 'photo.png', contentType: 'image/png' })
      .expect(422);

    assert.match(response.body.error, /screenshot/i);
    setScreenshotClassifierForTests(acceptScreenshot);
  });
});

describe('admin feedback API', () => {
  it('lists feedback for admins', async () => {
    const { agent } = await adminSession();
    const response = await agent.get('/api/admin/feedback').expect(200);
    assert.ok(response.body.total >= 1);
    assert.ok(Array.isArray(response.body.items));
  });

  it('returns feedback detail and attachment bytes', async () => {
    const doc = await FeedbackModel.findOne({ userId }).lean();
    assert.ok(doc);
    const { agent } = await adminSession();

    const detail = await agent.get(`/api/admin/feedback/${String(doc!._id)}`).expect(200);
    assert.equal(detail.body.message, 'Button does not work');

    const attachment = await agent
      .get(`/api/admin/feedback/${String(doc!._id)}/attachments/0`)
      .expect(200);
    assert.equal(attachment.headers['content-type'], 'image/png');
    assert.ok(attachment.body.length > 0);
  });

  it('updates feedback status with CSRF', async () => {
    const doc = await FeedbackModel.findOne({ userId }).lean();
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
});

describe('admin user delete cascades feedback', () => {
  it('deletes feedback documents and storage objects', async () => {
    const doc = await FeedbackModel.findOne({ userId }).lean();
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
