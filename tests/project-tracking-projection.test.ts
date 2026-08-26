import { after, before, beforeEach, describe, it } from 'node:test';
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

beforeEach(async () => {
  const { clearTestEmailOutbox } = await import('../src/services/emailService.js');
  clearTestEmailOutbox();
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

describe('project tracking rollup with a projected task query', () => {
  it('still computes materials/labor cost correctly for a leaf project', async () => {
    const { token } = await registerAndVerify('tracking-projection@example.com');

    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Tracking Projection' })
      .expect(201);
    const projectId = project.body.project._id as string;

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Costed task',
        projectId,
        hourlyRate: 20,
        materials: [{ description: 'Lumber', quantity: 3, unitPrice: 10 }],
        laborLines: [{ description: 'Cutting', hours: 2 }],
      })
      .expect(201);

    const tracking = await request(app)
      .get(`/api/projects/${projectId}/tracking`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // materialsTotal = 3 * 10 = 30; laborCost = hoursSpent(2) * hourlyRate(20) = 40; total = 70
    assert.equal(tracking.body.tracking.trackingRollup.materialsTotal, 30);
    assert.equal(tracking.body.tracking.trackingRollup.laborCost, 40);
    assert.equal(tracking.body.tracking.trackingRollup.totalCost, 70);
  });
});
