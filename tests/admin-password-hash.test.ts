import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { hashPassword } from '../src/utils/passwordHash.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-user-jwt-secret';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
process.env.ADMIN_AUTH_MODE = 'password';
process.env.ADMIN_COOKIE_SECURE = 'false';
process.env.SERVE_CLIENT = 'false';
delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.HASH_ADMIN_PASSWORD;

let mongo: MongoMemoryServer;
let app: Express;
let adminApp: Express;
let adminPasswordHash: string;

const ADMIN_PASSWORD = 'test-admin-password';

before(async () => {
  adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
  process.env.HASH_ADMIN_PASSWORD = 'true';
  process.env.ADMIN_PASSWORD_HASH = adminPasswordHash;

  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const [{ createApp }, { createAdminApp }] = await Promise.all([
    import('../src/app.js'),
    import('../src/admin/app.js'),
  ]);
  app = await createApp({ connect: true, startWorker: false });
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
    .send({ password: ADMIN_PASSWORD })
    .expect(200);
  return { agent, csrf: login.body.csrfToken as string };
}

describe('admin password hash mode', () => {
  it('accepts the correct password and rejects a wrong one', async () => {
    await request(adminApp)
      .post('/api/admin/auth/login')
      .send({ password: ADMIN_PASSWORD })
      .expect(200);

    await request(adminApp)
      .post('/api/admin/auth/login')
      .send({ password: 'wrong-password' })
      .expect(401);
  });

  it('issues a session usable for protected routes', async () => {
    const user = await (async () => {
      const { UserModel } = await import('../src/models/index.js');
      return UserModel.create({
        email: 'hash-mode@example.com',
        passwordHash: await hashPassword('user-password'),
        emailVerified: true,
      });
    })();

    const { agent, csrf } = await adminSession();
    const session = await agent.get('/api/admin/auth/session').expect(200);
    assert.equal(session.body.authenticated, true);

    await agent
      .post(`/api/admin/users/${user._id}/reset-password`)
      .send({ password: 'temporary-password' })
      .expect(403);

    await agent
      .post(`/api/admin/users/${user._id}/reset-password`)
      .set('x-csrf-token', csrf)
      .send({ password: 'temporary-password' })
      .expect(200);
  });
});
