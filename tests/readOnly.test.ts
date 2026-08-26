import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { waitForNewestToken } from './helpers/testEmail.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;

async function createTestApp(env: Record<string, string | undefined> = {}) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const { createApp } = await import('../src/app.js');
  return createApp({ connect: true, startWorker: false });
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  app = await createTestApp();
});

beforeEach(async () => {
  const { clearTestEmailOutbox } = await import('../src/services/emailService.js');
  clearTestEmailOutbox();
  delete process.env.READ_ONLY_MODE;
  delete process.env.DEPLOYMENT_PHASE;
  app = await createTestApp();
});

after(async () => {
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

async function registerAndVerify(email: string, password = 'password1234') {
  const { testEmailOutbox } = await import('../src/services/emailService.js');
  const previousTokenCount = testEmailOutbox.verification.length;

  await request(app)
    .post('/api/auth/register')
    .send({ email, password, acceptLegal: true })
    .expect(201);

  const token = await waitForNewestToken(() => testEmailOutbox.verification, previousTokenCount);

  await request(app).post('/api/auth/verify-email').send({ token }).expect(200);

  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return login.body.token as string;
}

describe('read-only deployment mode', () => {
  it('allows writes when READ_ONLY_MODE is not set', async () => {
    const token = await registerAndVerify('readonly-normal@example.com');

    await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Deploy Test' })
      .expect(201);
  });

  it('blocks mutating API calls when READ_ONLY_MODE=true', async () => {
    app = await createTestApp({ READ_ONLY_MODE: 'true', DEPLOYMENT_PHASE: 'major-deploy' });
    const token = await registerAndVerify('readonly-blocked@example.com');

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Blocked Project' })
      .expect(503);

    assert.equal(res.body.readOnly, true);
    assert.match(String(res.body.message), /disabled/i);
  });

  it('still allows GET /health and reports deployment state', async () => {
    app = await createTestApp({ READ_ONLY_MODE: 'true', DEPLOYMENT_PHASE: 'major-deploy' });

    const res = await request(app).get('/health').expect(200);
    assert.equal(res.body.deployment.readOnly, true);
    assert.equal(res.body.deployment.phase, 'major-deploy');
  });

  it('allows auth login during read-only mode', async () => {
    app = await createTestApp({ READ_ONLY_MODE: 'true' });
    await registerAndVerify('readonly-auth@example.com');

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'readonly-auth@example.com', password: 'password1234' })
      .expect(200);
  });
});
