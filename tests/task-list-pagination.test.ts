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

describe('GET /api/tasks is bounded by default and pages correctly', () => {
  it('applies a default limit even when the client sends none, and reports the true total', async () => {
    const { token } = await registerAndVerify('pagination-default@example.com');
    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pagination Project' })
      .expect(201);
    const projectId = project.body.project._id as string;

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: `Task ${i}`, projectId })
        .expect(201);
    }

    const res = await request(app).get('/api/tasks').set('Authorization', `Bearer ${token}`).expect(200);

    assert.equal(res.body.total, 5);
    assert.equal(res.body.tasks.length, 5);
    assert.ok(typeof res.body.limit === 'number' && res.body.limit > 0, 'expected a default limit to be reported');
    assert.equal(res.body.offset, 0);
  });

  it('never returns more than the requested limit, and offset pages through the rest', async () => {
    const { token } = await registerAndVerify('pagination-paged@example.com');
    const project = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Paged Project' })
      .expect(201);
    const projectId = project.body.project._id as string;

    const titles: string[] = [];
    for (let i = 0; i < 7; i++) {
      const created = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: `Paged task ${i}`, projectId })
        .expect(201);
      titles.push(created.body.task.title);
    }

    const seen: string[] = [];
    let offset = 0;
    const limit = 3;
    for (;;) {
      const res = await request(app)
        .get(`/api/tasks?limit=${limit}&offset=${offset}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      assert.ok(res.body.tasks.length <= limit, 'a single page must never exceed the requested limit');
      seen.push(...res.body.tasks.map((t: { title: string }) => t.title));
      offset += res.body.tasks.length;
      if (res.body.tasks.length === 0 || seen.length >= res.body.total) break;
    }

    assert.deepEqual(seen.sort(), titles.sort(), 'paging through every offset must reconstruct the full set');
  });

  it('rejects an absurd limit by clamping it instead of returning everything unbounded', async () => {
    const { token } = await registerAndVerify('pagination-clamp@example.com');
    const res = await request(app)
      .get('/api/tasks?limit=999999999')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.ok(res.body.limit < 999999999, 'an absurd limit must be clamped, not honored verbatim');
  });
});
