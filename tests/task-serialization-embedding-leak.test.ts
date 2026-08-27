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
  await mongoose.disconnect();
  await mongo.stop();
});

async function registerAndVerify(email: string, password = 'password1234') {
  const { testEmailOutbox } = await import('../src/services/emailService.js');
  const previousTokenCount = testEmailOutbox.verification.length;

  await request(app).post('/api/auth/register').send({ email, password, acceptLegal: true }).expect(201);

  const token = await waitForNewestToken(() => testEmailOutbox.verification, previousTokenCount);
  await request(app).post('/api/auth/verify-email').send({ token }).expect(200);

  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { token: login.body.token as string };
}

describe('serializeTask never leaks the internal embedding vector', () => {
  it('unit: strips embedding from the serialized shape', async () => {
    const { serializeTask } = await import('../src/utils/serialization.js');

    const serialized = serializeTask({
      _id: 'abc123',
      title: 'A task',
      status: 'todo',
      priority: 'medium',
      percentComplete: 0,
      embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
    });

    assert.equal('embedding' in serialized, false, 'serialized task must not carry the embedding field');
  });

  it('end-to-end: GET /api/tasks and GET /api/tasks/:id never include embedding', async () => {
    const { token } = await registerAndVerify('embedding-leak@example.com');

    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Embedding Leak Project' })
      .expect(201);
    const projectId = project.body.project._id as string;

    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Task with an embedding', projectId })
      .expect(201);
    const taskId = created.body.task._id as string;

    // Simulate the embedding worker having populated this task, since the
    // worker isn't running in this test (startWorker: false).
    const { TaskModel } = await import('../src/models/index.js');
    await TaskModel.findByIdAndUpdate(taskId, { embedding: [0.11, 0.22, 0.33] });

    const list = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const listedTask = (list.body.tasks as Array<Record<string, unknown>>).find((t) => t._id === taskId);
    assert.ok(listedTask, 'expected the created task in the list response');
    assert.equal('embedding' in listedTask!, false, 'GET /api/tasks must not leak embedding');

    const single = await request(app)
      .get(`/api/tasks/${taskId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.equal('embedding' in single.body.task, false, 'GET /api/tasks/:id must not leak embedding');
  });
});
