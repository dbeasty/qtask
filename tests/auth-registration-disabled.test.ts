import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'production';
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';
delete process.env.SMTP_HOST;
delete process.env.MAIL_RESEND;
delete process.env.MAIL_SMTP;
delete process.env.RESEND_API_KEY;

let mongo: MongoMemoryServer;
let app: Express;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();

  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

after(async () => {
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

describe('registration disabled without mail configured in production', () => {
  it('reports registrationEnabled false via /api/auth/config', async () => {
    const res = await request(app).get('/api/auth/config').expect(200);
    assert.equal(res.body.registrationEnabled, false);
  });

  it('rejects registration with 503 and does not create a user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'blocked@example.com', password: 'password1234', acceptLegal: true })
      .expect(503);

    assert.match(res.body.error, /not currently enabled/i);

    const { UserModel } = await import('../src/models/index.js');
    const user = await UserModel.findOne({ email: 'blocked@example.com' }).lean();
    assert.equal(user, null);
  });

  it('reports email disabled in /health', async () => {
    const res = await request(app).get('/health').expect(200);
    assert.equal(res.body.checks.email, 'disabled');
    assert.ok(res.body.version);
  });
});
