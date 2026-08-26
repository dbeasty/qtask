import { after, before, describe, it } from 'node:test';
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
  return { token: login.body.token as string };
}

describe('GET /api/tasks/workload sorts by priority severity, not alphabetically', () => {
  it('orders urgent > high > medium > low', async () => {
    const { token } = await registerAndVerify('workload-priority@example.com');

    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Workload' })
      .expect(201);
    const projectId = project.body.project._id as string;

    // Created in an order that would coincidentally look "sorted" under a
    // naive check if we only verified two priorities — created out of
    // priority order and out of alphabetical order.
    for (const priority of ['low', 'urgent', 'medium', 'high']) {
      await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: `Task ${priority}`, projectId, priority })
        .expect(201);
    }

    const res = await request(app)
      .get('/api/tasks/workload')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const priorities = res.body.workload.map((t: { priority: string }) => t.priority);
    assert.deepEqual(priorities, ['urgent', 'high', 'medium', 'low']);
  });
});
