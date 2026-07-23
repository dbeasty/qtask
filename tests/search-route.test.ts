import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;
const originalFetch = globalThis.fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

after(async () => {
  globalThis.fetch = originalFetch;
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

async function registerAndLogin() {
  const email = `search-route-${Date.now()}@example.com`;
  const password = 'Password123!';

  await request(app)
    .post('/api/auth/register')
    .send({ email, password, acceptLegal: true })
    .expect(201);

  const { testEmailOutbox } = await import('../src/services/emailService.js');
  const verifyToken = testEmailOutbox.verification.at(-1);
  assert.ok(verifyToken);

  await request(app).post('/api/auth/verify-email').send({ token: verifyToken }).expect(200);
  const login = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return login.body.token as string;
}

describe('GET /api/search', () => {
  it('returns grouped project and task hits', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        return new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input);
    };

    const token = await registerAndLogin();
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const userId = me.body.user.id as string;
    const { ProjectModel, TaskModel } = await import('../src/models/index.js');

    const project = await ProjectModel.create({
      userId,
      name: 'Roof Repair',
      description: 'Fix shingles',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
      embedding: [1, 0, 0],
    });

    await TaskModel.create({
      userId,
      title: 'Replace flashing',
      description: 'Front gutter area',
      tags: ['roof'],
      projectIds: [String(project._id)],
      projectId: String(project._id),
      status: 'todo',
      embedding: [0.95, 0.05, 0],
    });

    const response = await request(app)
      .get('/api/search?q=roof')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.ok(Array.isArray(response.body.projects));
    assert.ok(Array.isArray(response.body.tasks));
    assert.ok(response.body.projects.some((hit: { title: string }) => hit.title === 'Roof Repair'));
    assert.ok(response.body.tasks.some((hit: { title: string }) => hit.title === 'Replace flashing'));

    globalThis.fetch = originalFetch;
  });
});
