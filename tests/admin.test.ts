import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
let app: Express;
let adminApp: Express;

before(async () => {
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

async function createVerifiedUser(email: string) {
  const { UserModel } = await import('../src/models/index.js');
  const bcrypt = (await import('bcryptjs')).default;
  return UserModel.create({
    email,
    passwordHash: await bcrypt.hash('original-password', 4),
    emailVerified: true,
  });
}

async function adminSession() {
  const agent = request.agent(adminApp);
  const login = await agent
    .post('/api/admin/auth/login')
    .send({ password: 'test-admin-password' })
    .expect(200);
  return { agent, csrf: login.body.csrfToken as string };
}

describe('admin data management', () => {
  it('requires a valid admin session and CSRF token', async () => {
    await request(adminApp).get('/api/admin/users').expect(401);
    const user = await createVerifiedUser('csrf@example.com');
    const { agent } = await adminSession();
    await agent
      .post(`/api/admin/users/${user._id}/reset-password`)
      .send({ password: 'temporary-password' })
      .expect(403);
  });

  it('sets a temporary password and forces replacement before app access', async () => {
    const user = await createVerifiedUser('forced@example.com');
    const { agent, csrf } = await adminSession();
    await agent
      .post(`/api/admin/users/${user._id}/reset-password`)
      .set('x-csrf-token', csrf)
      .send({ password: 'temporary-password' })
      .expect(200);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'temporary-password' })
      .expect(200);
    assert.equal(login.body.mustChangePassword, true);

    await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(403);

    const changed = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: 'temporary-password', newPassword: 'replacement-password' })
      .expect(200);
    assert.ok(changed.body.token);

    await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${changed.body.token}`)
      .expect(200);
  });

  it('reports totals and cascade deletes a confirmed account', async () => {
    const user = await createVerifiedUser('delete@example.com');
    const { TaskModel, ProjectModel } = await import('../src/models/index.js');
    await Promise.all([
      TaskModel.create({ userId: String(user._id), title: 'Delete me' }),
      ProjectModel.create({ userId: String(user._id), name: 'Delete me' }),
    ]);
    const { agent, csrf } = await adminSession();
    const stats = await agent.get('/api/admin/stats').expect(200);
    assert.ok(stats.body.users >= 1);
    assert.ok(stats.body.totalDataBytes > 0);

    await agent
      .delete(`/api/admin/users/${user._id}`)
      .set('x-csrf-token', csrf)
      .send({ confirmEmail: user.email })
      .expect(200);

    assert.equal(await TaskModel.countDocuments({ userId: String(user._id) }), 0);
    assert.equal(await ProjectModel.countDocuments({ userId: String(user._id) }), 0);
  });
});
