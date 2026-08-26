import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { escapeRegex } from '../src/services/searchUtils.js';

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
  adminApp = await createAdminApp({ connect: true, serveClient: false });
});

beforeEach(async () => {
  const { UserModel, FeedbackModel } = await import('../src/models/index.js');
  await Promise.all([UserModel.deleteMany({}), FeedbackModel.deleteMany({})]);
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

describe('escapeRegex', () => {
  it('escapes every regex metacharacter', () => {
    assert.equal(escapeRegex('a.b'), 'a\\.b');
    assert.equal(escapeRegex('a*b'), 'a\\*b');
    assert.equal(escapeRegex('(a|b)'), '\\(a\\|b\\)');
    assert.equal(escapeRegex('a+b?c'), 'a\\+b\\?c');
    assert.equal(escapeRegex('[a]{2}'), '\\[a\\]\\{2\\}');
    assert.equal(escapeRegex('a^b$c'), 'a\\^b\\$c');
    assert.equal(escapeRegex('plain text'), 'plain text');
  });
});

describe('admin user search treats the query as a literal string, not a regex', () => {
  it('a "." in the search only matches a literal dot, not "any character"', async () => {
    const { UserModel } = await import('../src/models/index.js');
    await UserModel.create([
      { email: 'a.b@example.com', passwordHash: 'x', emailVerified: true },
      { email: 'aXb@example.com', passwordHash: 'x', emailVerified: true },
    ]);

    const { agent } = await adminSession();
    const res = await agent.get('/api/admin/users').query({ search: 'a.b' }).expect(200);

    const emails = res.body.users.map((u: { email: string }) => u.email);
    assert.deepEqual(emails, ['a.b@example.com']);
  });

  it('an unbalanced group does not 500', async () => {
    const { agent } = await adminSession();
    await agent.get('/api/admin/users').query({ search: '(unbalanced' }).expect(200);
  });
});

describe('admin feedback search treats the query as a literal string, not a regex', () => {
  it('a "." in the search only matches a literal dot, not "any character"', async () => {
    const { FeedbackModel } = await import('../src/models/index.js');
    await FeedbackModel.create([
      { userId: new mongoose.Types.ObjectId().toString(), message: 'a.b issue', status: 'open' },
      { userId: new mongoose.Types.ObjectId().toString(), message: 'aXb issue', status: 'open' },
    ]);

    const { agent } = await adminSession();
    const res = await agent.get('/api/admin/feedback').query({ search: 'a.b' }).expect(200);

    const messages = res.body.items.map((f: { message: string }) => f.message);
    assert.deepEqual(messages, ['a.b issue']);
  });

  it('an unbalanced group does not 500', async () => {
    const { agent } = await adminSession();
    await agent.get('/api/admin/feedback').query({ search: '(unbalanced' }).expect(200);
  });
});
