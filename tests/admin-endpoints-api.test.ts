import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-user-jwt-secret';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.ADMIN_AUTH_MODE = 'password';
process.env.ADMIN_COOKIE_SECURE = 'false';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let adminApp: Express;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { createAdminApp } = await import('../src/admin/app.js');
  await mongoose.connect(process.env.MONGODB_URI);
  adminApp = await createAdminApp({ connect: false, serveClient: false });
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function adminSession() {
  const agent = request.agent(adminApp);
  const login = await agent
    .post('/api/admin/auth/login')
    .send({ password: 'test-admin-password' })
    .expect(200);
  return { agent, csrf: login.body.csrfToken as string };
}

describe('POST /api/admin/auth/logout', () => {
  it('rejects a logout with no session', async () => {
    await request(adminApp).post('/api/admin/auth/logout').expect(401);
  });

  it('rejects a logout that is missing the CSRF token', async () => {
    const { agent } = await adminSession();
    await agent.post('/api/admin/auth/logout').expect(403);
  });

  it('ends the session so protected routes stop working', async () => {
    const { agent, csrf } = await adminSession();

    await agent.get('/api/admin/users').expect(200);

    await agent.post('/api/admin/auth/logout').set('x-csrf-token', csrf).expect(204);

    await agent.get('/api/admin/users').expect(401);
  });
});

describe('GET /api/admin/auth/session', () => {
  it('reports an unauthenticated caller', async () => {
    const res = await request(adminApp).get('/api/admin/auth/session');
    assert.ok([200, 401].includes(res.status));
    if (res.status === 200) assert.notEqual(res.body.authenticated, true);
  });

  it('reports an authenticated admin', async () => {
    const { agent } = await adminSession();
    const res = await agent.get('/api/admin/auth/session').expect(200);
    assert.equal(res.body.authenticated, true);
  });
});

describe('GET /api/admin/users/:id', () => {
  it('requires an admin session', async () => {
    await request(adminApp)
      .get(`/api/admin/users/${new mongoose.Types.ObjectId()}`)
      .expect(401);
  });

  it('returns per-user detail with usage counters', async () => {
    const { UserModel, TaskModel } = await import('../src/models/index.js');
    const user = await UserModel.create({
      email: 'detail@example.com',
      passwordHash: 'x',
      emailVerified: true,
      lastLoginAt: new Date(),
    });
    const userId = String(user._id);
    await TaskModel.create({ userId, title: 'One' });
    await TaskModel.create({ userId, title: 'Two' });

    const { agent } = await adminSession();
    const res = await agent.get(`/api/admin/users/${userId}`).expect(200);

    assert.equal(res.body.user.id, userId);
    assert.equal(res.body.user.email, 'detail@example.com');
    assert.equal(res.body.user.taskCount, 2);
    assert.equal(res.body.user.active, true);
    assert.equal(typeof res.body.user.storageBytes, 'number');
  });

  it('returns 404 for an unknown user', async () => {
    const { agent } = await adminSession();
    await agent.get(`/api/admin/users/${new mongoose.Types.ObjectId()}`).expect(404);
  });

  it('returns 404 rather than 500 for a malformed id', async () => {
    const { agent } = await adminSession();
    await agent.get('/api/admin/users/not-an-object-id').expect(404);
  });
});

describe('admin ollama metrics endpoints', () => {
  beforeEach(async () => {
    const { LlmCallMetricModel } = await import('../src/models/index.js');
    await LlmCallMetricModel.deleteMany({});
  });

  async function seedMetrics() {
    const { LlmCallMetricModel } = await import('../src/models/index.js');
    const base = new Date('2026-01-15T10:00:00.000Z');
    const expiresAt = new Date(base.getTime() + 30 * 24 * 3600_000);
    const metric = (
      overrides: Record<string, unknown> & { startedAt: Date; durationMs: number }
    ) => ({
      requestId: randomUUID(),
      source: 'agent_loop',
      completedAt: new Date(overrides.startedAt.getTime() + overrides.durationMs),
      expiresAt,
      ...overrides,
    });

    await LlmCallMetricModel.create([
      metric({
        callType: 'agent',
        model: 'llama3',
        success: true,
        durationMs: 100,
        startedAt: base,
        promptEvalCount: 10,
        evalCount: 20,
      }),
      metric({
        callType: 'agent',
        model: 'llama3',
        success: false,
        durationMs: 300,
        startedAt: new Date(base.getTime() + 60_000),
        promptEvalCount: 5,
        evalCount: 0,
      }),
      metric({
        callType: 'embed',
        model: 'nomic',
        source: 'embedding_job',
        success: true,
        durationMs: 50,
        startedAt: new Date(base.getTime() + 120_000),
      }),
    ]);
    return base;
  }

  it('all three require an admin session', async () => {
    for (const path of ['summary', 'timeseries', 'calls']) {
      await request(adminApp).get(`/api/admin/ollama/${path}`).expect(401);
    }
  });

  it('summary groups by call type and model with success/failure counts', async () => {
    const base = await seedMetrics();
    const { agent } = await adminSession();

    const res = await agent
      .get('/api/admin/ollama/summary')
      .query({
        from: new Date(base.getTime() - 3600_000).toISOString(),
        to: new Date(base.getTime() + 3600_000).toISOString(),
      })
      .expect(200);

    const agentGroup = res.body.groups.find(
      (g: { _id: { callType: string } }) => g._id.callType === 'agent'
    );
    assert.ok(agentGroup, `expected an agent group in ${JSON.stringify(res.body.groups)}`);
    assert.equal(agentGroup.calls, 2);
    assert.equal(agentGroup.successes, 1);
    assert.equal(agentGroup.failures, 1);
    assert.equal(agentGroup.promptTokens, 15);
    assert.equal(agentGroup.averageDurationMs, 200);
  });

  it('timeseries buckets by the requested interval', async () => {
    const base = await seedMetrics();
    const { agent } = await adminSession();

    const res = await agent
      .get('/api/admin/ollama/timeseries')
      .query({
        from: new Date(base.getTime() - 3600_000).toISOString(),
        to: new Date(base.getTime() + 3600_000).toISOString(),
        interval: 'minute',
      })
      .expect(200);

    assert.equal(res.body.interval, 'minute');
    assert.equal(res.body.points.length, 3, 'three metrics one minute apart -> three buckets');

    const hourly = await agent
      .get('/api/admin/ollama/timeseries')
      .query({
        from: new Date(base.getTime() - 3600_000).toISOString(),
        to: new Date(base.getTime() + 3600_000).toISOString(),
        interval: 'hour',
      })
      .expect(200);
    assert.equal(hourly.body.points.length, 1, 'same three collapse into one hourly bucket');
  });

  it('timeseries falls back to hourly for an unknown interval', async () => {
    await seedMetrics();
    const { agent } = await adminSession();
    const res = await agent
      .get('/api/admin/ollama/timeseries')
      .query({ interval: 'fortnight' })
      .expect(200);
    assert.equal(res.body.interval, 'hour');
  });

  it('calls paginates newest-first and reports the total', async () => {
    await seedMetrics();
    const { agent } = await adminSession();

    const res = await agent.get('/api/admin/ollama/calls').query({ limit: 2 }).expect(200);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.calls.length, 2);
    assert.equal(res.body.limit, 2);

    const times = res.body.calls.map((c: { startedAt: string }) => new Date(c.startedAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'must be newest-first');

    const page2 = await agent
      .get('/api/admin/ollama/calls')
      .query({ limit: 2, page: 2 })
      .expect(200);
    assert.equal(page2.body.calls.length, 1);
  });

  it('calls filters by callType and success', async () => {
    await seedMetrics();
    const { agent } = await adminSession();

    const embeds = await agent
      .get('/api/admin/ollama/calls')
      .query({ callType: 'embed' })
      .expect(200);
    assert.equal(embeds.body.total, 1);
    assert.equal(embeds.body.calls[0].model, 'nomic');

    const failures = await agent
      .get('/api/admin/ollama/calls')
      .query({ success: 'false' })
      .expect(200);
    assert.equal(failures.body.total, 1);
    assert.equal(failures.body.calls[0].success, false);
  });

  it('calls clamps limit to 100', async () => {
    await seedMetrics();
    const { agent } = await adminSession();
    const res = await agent.get('/api/admin/ollama/calls').query({ limit: 9999 }).expect(200);
    assert.ok(res.body.limit <= 100, `limit was ${res.body.limit}`);
  });
});
