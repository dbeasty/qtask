import { before, after, beforeEach, describe, it } from 'node:test';
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

beforeEach(async () => {
  const { clearTestEmailOutbox } = await import('../src/services/emailService.js');
  clearTestEmailOutbox();
});

after(async () => {
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

async function registerAndVerify(email: string, password: string) {
  const register = await request(app)
    .post('/api/auth/register')
    .send({ email, password, acceptLegal: true })
    .expect(201);

  assert.ok(register.body.message);

  const { testEmailOutbox } = await import('../src/services/emailService.js');
  const token = testEmailOutbox.verification.at(-1);
  assert.ok(token, 'verification token should be captured in test outbox');

  await request(app).post('/api/auth/verify-email').send({ token }).expect(200);

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);

  return login.body.token as string;
}

describe('auth', () => {
  it('registers, verifies email, logs in, and returns /me', async () => {
    const token = await registerAndVerify('alice@example.com', 'password1234');

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.equal(me.body.user.email, 'alice@example.com');
    assert.equal(me.body.user.emailVerified, true);
    assert.deepEqual(me.body.user.preferences, {
      autoApproveProposals: false,
      skipConfirmations: false,
      trackExpenses: true,
      agentEnterToSend: true,
      completedDemoTour: false,
      theme: 'light',
      startupView: 'last',
    });
  });

  it('blocks login until email is verified', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'unverified@example.com', password: 'password1234', acceptLegal: true })
      .expect(201);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'unverified@example.com', password: 'password1234' })
      .expect(403);

    assert.match(login.body.error, /verify your email/i);
  });

  it('resends verification email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'resend@example.com', password: 'password1234', acceptLegal: true })
      .expect(201);

    const { testEmailOutbox } = await import('../src/services/emailService.js');
    const firstToken = testEmailOutbox.verification.at(-1);

    await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: 'resend@example.com' })
      .expect(200);

    const secondToken = testEmailOutbox.verification.at(-1);
    assert.notEqual(firstToken, secondToken);
  });

  it('resets password via email link', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'reset@example.com', password: 'password1234', acceptLegal: true })
      .expect(201);

    const { testEmailOutbox } = await import('../src/services/emailService.js');
    const verifyToken = testEmailOutbox.verification.at(-1);
    assert.ok(verifyToken);
    await request(app).post('/api/auth/verify-email').send({ token: verifyToken }).expect(200);

    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'reset@example.com' })
      .expect(200);

    const resetToken = testEmailOutbox.reset.at(-1);
    assert.ok(resetToken);

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: 'newpassword999' })
      .expect(200);

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'reset@example.com', password: 'password1234' })
      .expect(401);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reset@example.com', password: 'newpassword999' })
      .expect(200);

    assert.ok(login.body.token);
  });

  it('changes password while authenticated', async () => {
    const token = await registerAndVerify('changepw@example.com', 'password1234');

    await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'wrong-password', newPassword: 'newpassword999' })
      .expect(401);

    await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'password1234', newPassword: 'newpassword999' })
      .expect(200);

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'changepw@example.com', password: 'newpassword999' })
      .expect(200);
  });

  it('updates display name via PATCH /me', async () => {
    const token = await registerAndVerify('profile@example.com', 'password1234');

    const updated = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Profile User' })
      .expect(200);

    assert.equal(updated.body.user.displayName, 'Profile User');
  });

  it('persists and merges preferences via PATCH /me', async () => {
    const token = await registerAndVerify('prefs@example.com', 'password1234');

    const enabled = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ preferences: { autoApproveProposals: true } })
      .expect(200);

    assert.deepEqual(enabled.body.user.preferences, {
      autoApproveProposals: true,
      skipConfirmations: false,
      trackExpenses: true,
      agentEnterToSend: true,
      completedDemoTour: false,
      theme: 'light',
      startupView: 'last',
    });

    const merged = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ preferences: { skipConfirmations: true, trackExpenses: false } })
      .expect(200);

    assert.deepEqual(merged.body.user.preferences, {
      autoApproveProposals: true,
      skipConfirmations: true,
      trackExpenses: false,
      agentEnterToSend: true,
      completedDemoTour: false,
      theme: 'light',
      startupView: 'last',
    });

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.deepEqual(me.body.user.preferences, {
      autoApproveProposals: true,
      skipConfirmations: true,
      trackExpenses: false,
      agentEnterToSend: true,
      completedDemoTour: false,
      theme: 'light',
      startupView: 'last',
    });

    const disabled = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        preferences: {
          autoApproveProposals: false,
          skipConfirmations: false,
          trackExpenses: true,
        },
      })
      .expect(200);

    assert.deepEqual(disabled.body.user.preferences, {
      autoApproveProposals: false,
      skipConfirmations: false,
      trackExpenses: true,
      agentEnterToSend: true,
      completedDemoTour: false,
      theme: 'light',
      startupView: 'last',
    });
  });

  it('persists startupView preference via PATCH /me', async () => {
    const token = await registerAndVerify('startupview@example.com', 'password1234');

    const updated = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ preferences: { startupView: 'tasks' } })
      .expect(200);

    assert.equal(updated.body.user.preferences.startupView, 'tasks');

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.equal(me.body.user.preferences.startupView, 'tasks');
    assert.equal(me.body.user.preferences.autoApproveProposals, false);
  });

  it('rejects invalid preference values on PATCH /me', async () => {
    const token = await registerAndVerify('badprefs@example.com', 'password1234');

    await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ preferences: { autoApproveProposals: 'yes' } })
      .expect(400);

    await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ preferences: { startupView: 'invalid' } })
      .expect(400);
  });

  it('rejects protected routes without a token', async () => {
    await request(app).get('/api/tasks').expect(401);
    await request(app).get('/api/projects').expect(401);
  });

  it('rejects registration without legal acceptance', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'nolegal@example.com', password: 'password1234' })
      .expect(400);

    assert.match(res.body.error, /accept the Terms/i);
  });

  it('records legal acceptance on registration', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'legal@example.com', password: 'password1234', acceptLegal: true })
      .expect(201);

    const user = await mongoose.connection.collection('users').findOne({ email: 'legal@example.com' });
    assert.ok(user);
    assert.ok(user.legalAcceptedAt);
    assert.equal(user.legalVersion, '1.0');
  });

  it('includes privacy link in verification email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'emailprivacy@example.com', password: 'password1234', acceptLegal: true })
      .expect(201);

    const { testEmailOutbox } = await import('../src/services/emailService.js');
    const body = testEmailOutbox.verificationBodies.at(-1);
    assert.ok(body, 'verification email body should be captured in test outbox');
    assert.match(body, /\/privacy/);
    assert.match(body, /github\.com\/dbeasty\/qtask/);
  });

  it('rejects invalid credentials', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong' })
      .expect(401);
  });

  it('disables registration when REGISTRATION_ENABLED=false', async () => {
    const previous = process.env.REGISTRATION_ENABLED;
    process.env.REGISTRATION_ENABLED = 'false';

    try {
      const config = await request(app).get('/api/auth/config').expect(200);
      assert.equal(config.body.registrationEnabled, false);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'capacity@example.com', password: 'password1234', acceptLegal: true })
        .expect(503);

      assert.match(res.body.error, /not currently enabled/i);

      const { UserModel } = await import('../src/models/index.js');
      const user = await UserModel.findOne({ email: 'capacity@example.com' }).lean();
      assert.equal(user, null);
    } finally {
      if (previous === undefined) {
        delete process.env.REGISTRATION_ENABLED;
      } else {
        process.env.REGISTRATION_ENABLED = previous;
      }
    }
  });
});

describe('session refresh', () => {
  function parseLogLine(call: unknown): Record<string, unknown> | null {
    if (typeof call !== 'string') return null;
    try {
      return JSON.parse(call) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  function findAuthLog(calls: unknown[][], predicate: (entry: Record<string, unknown>) => boolean) {
    return calls
      .map((call) => parseLogLine(call[0]))
      .find((entry): entry is Record<string, unknown> => entry != null && predicate(entry));
  }

  it('refreshes a valid token and returns a new expiry', async () => {
    const token = await registerAndVerify('refresh-valid@example.com', 'password1234');
    const { decodeTokenUnsafe } = await import('../src/auth/jwt.js');
    const before = decodeTokenUnsafe(token);

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.ok(res.body.token);
    assert.equal(res.body.user.email, 'refresh-valid@example.com');

    const after = decodeTokenUnsafe(res.body.token as string);
    assert.ok(after.exp != null && before.exp != null);
    assert.ok(after.exp >= before.exp);
  });

  it('preserves pwd_change on refresh when mustChangePassword is set', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { signToken } = await import('../src/auth/jwt.js');

    const user = await UserModel.create({
      email: 'refresh-pwd@example.com',
      passwordHash: 'unused',
      emailVerified: true,
      mustChangePassword: true,
    });

    const token = signToken({
      sub: String(user._id),
      email: user.email,
      pwd_change: true,
    });

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.equal(res.body.mustChangePassword, true);

    const jwt = await import('jsonwebtoken');
    const { config } = await import('../src/config/index.js');
    const decoded = jwt.default.decode(res.body.token as string) as { pwd_change?: boolean };
    assert.equal(decoded.pwd_change, true);
  });

  it('rejects refresh without a token', async () => {
    await request(app).post('/api/auth/refresh').expect(401);
  });

  it('rejects refresh with invalid signature', async () => {
    await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', 'Bearer not.a.valid-token')
      .expect(401);
  });

  it('rejects refresh when token expired beyond grace', async () => {
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../src/config/index.js');

    const token = jwt.default.sign(
      { sub: 'expired-user', email: 'expired@example.com' },
      config.jwtSecret,
      { expiresIn: -600 }
    );

    await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('accepts refresh within grace after expiry', async () => {
    const token = await registerAndVerify('refresh-grace@example.com', 'password1234');
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../src/config/index.js');
    const { decodeTokenUnsafe } = await import('../src/auth/jwt.js');

    const payload = decodeTokenUnsafe(token);
    assert.ok(payload.sub && payload.exp);

    const expiredToken = jwt.default.sign(
      { sub: payload.sub, email: 'refresh-grace@example.com' },
      config.jwtSecret,
      { expiresIn: -60 }
    );

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(200);

    assert.ok(res.body.token);
    assert.equal(res.body.user.email, 'refresh-grace@example.com');
  });

  it('logs refresh success and rejection with auth module metadata', async () => {
    const token = await registerAndVerify('refresh-log@example.com', 'password1234');
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../src/config/index.js');

    const warnCalls: unknown[][] = [];
    const logCalls: unknown[][] = [];
    const originalWarn = console.warn;
    const originalLog = console.log;

    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
      originalWarn(...args);
    };
    console.log = (...args: unknown[]) => {
      logCalls.push(args);
      originalLog(...args);
    };

    try {
      await request(app)
        .post('/api/auth/refresh')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const successLog = findAuthLog(logCalls, (entry) => entry.message === 'Session refreshed');
      assert.ok(successLog);
      assert.equal(successLog.module, 'auth');
      assert.equal(successLog.source, 'refresh_endpoint');

      const staleToken = jwt.default.sign(
        { sub: 'missing-user', email: 'missing@example.com' },
        config.jwtSecret,
        { expiresIn: -3600 }
      );

      await request(app)
        .post('/api/auth/refresh')
        .set('Authorization', `Bearer ${staleToken}`)
        .expect(401);

      const rejectLog = findAuthLog(warnCalls, (entry) => entry.reason === 'refresh_rejected');
      assert.ok(rejectLog);
      assert.equal(rejectLog.module, 'auth');
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });
});

describe('user isolation', () => {
  it('keeps tasks scoped per user', async () => {
    const aliceToken = await registerAndVerify('alice2@example.com', 'password1234');
    const bobToken = await registerAndVerify('bob@example.com', 'password1234');

    const aliceTask = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ title: 'Alice task' })
      .expect(201);

    const bobTasks = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(200);

    assert.equal(bobTasks.body.tasks.length, 0);

    await request(app)
      .get(`/api/tasks/${aliceTask.body.task._id}`)
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(404);

    const aliceTasks = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${aliceToken}`)
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
    assert.equal(res.body.checks.email, 'configured');
    assert.ok(res.body.version);
  });
});
