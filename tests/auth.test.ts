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
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

describe('auth', () => {
  it('registers, logs in, and returns /me', async () => {
    const register = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@example.com', password: 'password1234' })
      .expect(201);

    assert.ok(register.body.token);
    assert.equal(register.body.user.email, 'alice@example.com');

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'password1234' })
      .expect(200);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);

    assert.equal(me.body.user.email, 'alice@example.com');
  });

  it('rejects protected routes without a token', async () => {
    await request(app).get('/api/tasks').expect(401);
    await request(app).get('/api/projects').expect(401);
  });

  it('rejects invalid credentials', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong' })
      .expect(401);
  });
});

describe('user isolation', () => {
  it('keeps tasks scoped per user', async () => {
    const alice = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice2@example.com', password: 'password1234' })
      .expect(201);

    const bob = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bob@example.com', password: 'password1234' })
      .expect(201);

    const aliceTask = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({ title: 'Alice task' })
      .expect(201);

    const bobTasks = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${bob.body.token}`)
      .expect(200);

    assert.equal(bobTasks.body.tasks.length, 0);

    await request(app)
      .get(`/api/tasks/${aliceTask.body.task._id}`)
      .set('Authorization', `Bearer ${bob.body.token}`)
      .expect(404);

    const aliceTasks = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .expect(200);

    assert.equal(aliceTasks.body.tasks.length, 1);
    assert.equal(aliceTasks.body.tasks[0].title, 'Alice task');
  });
});

describe('health', () => {
  it('reports mongodb status', async () => {
    const res = await request(app).get('/health').expect(200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.checks.mongodb, 'ok');
  });
});
