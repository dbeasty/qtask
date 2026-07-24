import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();

  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

after(async () => {
  delete process.env.TEST_EMAIL_SEND_FAIL;
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

describe('register email send failure', () => {
  it('returns 503 and does not leave an orphan user', async () => {
    process.env.TEST_EMAIL_SEND_FAIL = 'true';

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'rollback@example.com', password: 'password1234', acceptLegal: true })
      .expect(503);

    assert.match(res.body.error, /verification email/i);

    const { UserModel, ProjectModel } = await import('../src/models/index.js');
    const user = await UserModel.findOne({ email: 'rollback@example.com' }).lean();
    assert.equal(user, null);
    assert.equal(await ProjectModel.countDocuments({}), 0);

    delete process.env.TEST_EMAIL_SEND_FAIL;
  });
});
