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

describe('RT-L5: subtask route errors use typed status codes instead of string-matching', () => {
  it('attaching a task to a target that shares no project returns 400, not a 500', async () => {
    const { token } = await registerAndVerify('subtask-attach-noshare@example.com');

    const projectA = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Project A' })
      .expect(201);
    const projectB = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Project B' })
      .expect(201);

    const source = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Source task', projectId: projectA.body.project._id })
      .expect(201);
    const target = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Target task', projectId: projectB.body.project._id })
      .expect(201);

    // Pre-fix, the route matched thrown error messages against the literal
    // substring "same project", but the service actually threw "Tasks must
    // share at least one project" — the two never matched, so this fell
    // through to the generic 500 handler instead of a 400.
    const res = await request(app)
      .post(`/api/tasks/${target.body.task._id}/subtasks/attach-task`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceTaskId: source.body.task._id, parentPath: [] });

    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /share at least one project/i);
  });

  it('attaching a task to itself returns 400', async () => {
    const { token } = await registerAndVerify('subtask-attach-self@example.com');
    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Self task' })
      .expect(201);
    const taskId = created.body.task._id as string;

    const res = await request(app)
      .post(`/api/tasks/${taskId}/subtasks/attach-task`)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceTaskId: taskId, parentPath: [] });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /cannot attach a task to itself/i);
  });

  it('moving a subtask into its own descendant returns 400', async () => {
    const { token } = await registerAndVerify('subtask-move-cycle@example.com');
    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Parent task' })
      .expect(201);
    const taskId = created.body.task._id as string;

    const sub = await request(app)
      .post(`/api/tasks/${taskId}/subtasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Child subtask' })
      .expect(201);
    const subtaskId = sub.body.task.subtasks[0]._id as string;

    const res = await request(app)
      .post(`/api/tasks/${taskId}/subtasks/move`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fromPath: [subtaskId], toParentPath: [subtaskId] });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /cannot move a subtask into itself/i);
  });
});
