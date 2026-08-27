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

describe('task endpoints return 400 on malformed input instead of crashing with a 500', () => {
  it('POST /api/tasks: missing title', async () => {
    const { token } = await registerAndVerify('validation-1@example.com');
    const res = await request(app).post('/api/tasks').set('Authorization', `Bearer ${token}`).send({});
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks: steps is not an array', async () => {
    const { token } = await registerAndVerify('validation-2@example.com');
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'ok', steps: 'not-an-array' });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks: dueDate is not a valid date', async () => {
    const { token } = await registerAndVerify('validation-3@example.com');
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'ok', dueDate: 'not-a-date' });
    assert.equal(res.status, 400);
  });

  it('PATCH /api/tasks/:id: steps is not an array', async () => {
    const { token } = await registerAndVerify('validation-4@example.com');
    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Base task' })
      .expect(201);
    const res = await request(app)
      .patch(`/api/tasks/${created.body.task._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ steps: 'nope' });
    assert.equal(res.status, 400);
  });

  it('PATCH /api/tasks/:id: dueDate is not a valid date', async () => {
    const { token } = await registerAndVerify('validation-5@example.com');
    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Base task' })
      .expect(201);
    const res = await request(app)
      .patch(`/api/tasks/${created.body.task._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ dueDate: 'not-a-date' });
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks/:id/subtasks: missing title', async () => {
    const { token } = await registerAndVerify('validation-6@example.com');
    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Base task' })
      .expect(201);
    const res = await request(app)
      .post(`/api/tasks/${created.body.task._id}/subtasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.equal(res.status, 400);
  });

  it('POST /api/tasks/:id/subtasks: steps is not an array', async () => {
    const { token } = await registerAndVerify('validation-7@example.com');
    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Base task' })
      .expect(201);
    const res = await request(app)
      .post(`/api/tasks/${created.body.task._id}/subtasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'sub', steps: 'nope' });
    assert.equal(res.status, 400);
  });

  it('PATCH /api/tasks/:id/subtasks: steps is not an array', async () => {
    const { token } = await registerAndVerify('validation-8@example.com');
    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Base task' })
      .expect(201);
    await request(app)
      .post(`/api/tasks/${created.body.task._id}/subtasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'sub' })
      .expect(201);
    const res = await request(app)
      .patch(`/api/tasks/${created.body.task._id}/subtasks?path=x`)
      .set('Authorization', `Bearer ${token}`)
      .send({ steps: 'nope' });
    assert.equal(res.status, 400);
  });

  it('still accepts a well-formed task with steps, materials, and a due date', async () => {
    const { token } = await registerAndVerify('validation-9@example.com');
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Well-formed task',
        steps: [{ text: 'Step one', done: false }],
        materials: [{ description: 'Lumber', quantity: 2, unitPrice: 10 }],
        dueDate: '2026-12-01T00:00:00.000Z',
        status: 'in_progress',
        priority: 'high',
      });
    assert.equal(res.status, 201);
    assert.equal(res.body.task.title, 'Well-formed task');
  });
});
