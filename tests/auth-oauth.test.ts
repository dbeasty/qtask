import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.SERVE_CLIENT = 'false';
process.env.OAUTH_GOOGLE_ENABLED = 'false';
process.env.OAUTH_MICROSOFT_ENABLED = 'false';

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

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

describe('user OAuth sign-in', () => {
  it('reports empty oauthProviders when feature flags are off', async () => {
    const res = await request(app).get('/api/auth/config').expect(200);
    assert.deepEqual(res.body.oauthProviders, []);
  });

  it('rejects unknown OAuth provider', async () => {
    await request(app).get('/api/auth/oauth/unknown').expect(404);
  });

  it('creates a new Google account and exchanges auth code for session', async () => {
    const { authService } = await import('../src/services/authService.js');
    const { issueUserOAuthAuthCode } = await import('../src/auth/userOAuth/exchange.js');

    const session = await authService.loginWithOAuthProvider(
      {
        provider: 'google',
        providerUserId: 'google-sub-1',
        email: 'oauth-new@example.com',
        emailVerified: true,
        displayName: 'OAuth User',
      },
      { acceptLegal: true }
    );

    assert.equal(session.user.email, 'oauth-new@example.com');
    assert.equal(session.user.hasPassword, false);

    const code = await issueUserOAuthAuthCode(session.userId);
    const exchange = await request(app).post('/api/auth/oauth/exchange').send({ code }).expect(200);

    assert.ok(exchange.body.token);
    assert.equal(exchange.body.user.email, 'oauth-new@example.com');
  });

  it('auto-links Google to an existing verified password account', async () => {
    const { authService } = await import('../src/services/authService.js');
    const { UserModel } = await import('../src/models/index.js');
    const bcrypt = await import('bcryptjs');

    const user = await UserModel.create({
      email: 'linked@example.com',
      passwordHash: await bcrypt.hash('password1234', 12),
      emailVerified: true,
      legalAcceptedAt: new Date(),
      legalVersion: '1.0',
    });

    const session = await authService.loginWithOAuthProvider({
      provider: 'google',
      providerUserId: 'google-sub-linked',
      email: 'linked@example.com',
      emailVerified: true,
    });

    assert.equal(session.userId, String(user._id));

    const updated = await UserModel.findById(user._id).lean();
    assert.equal(updated?.identityProviders?.length, 1);
    assert.equal(updated?.identityProviders?.[0]?.provider, 'google');
  });

  it('verifies an unverified email/password stub via Google sign-in', async () => {
    const { authService } = await import('../src/services/authService.js');
    const { UserModel } = await import('../src/models/index.js');
    const bcrypt = await import('bcryptjs');

    await UserModel.create({
      email: 'stub@example.com',
      passwordHash: await bcrypt.hash('password1234', 12),
      emailVerified: false,
    });

    const session = await authService.loginWithOAuthProvider({
      provider: 'google',
      providerUserId: 'google-sub-stub',
      email: 'stub@example.com',
      emailVerified: true,
    });

    assert.equal(session.user.emailVerified, true);

    const updated = await UserModel.findOne({ email: 'stub@example.com' }).lean();
    assert.equal(updated?.emailVerified, true);
    assert.equal(updated?.emailVerificationTokenHash, undefined);
  });

  it('links Microsoft to the same account when email matches', async () => {
    const { authService } = await import('../src/services/authService.js');
    const { UserModel } = await import('../src/models/index.js');

    await authService.loginWithOAuthProvider(
      {
        provider: 'google',
        providerUserId: 'google-sub-multi',
        email: 'multi@example.com',
        emailVerified: true,
      },
      { acceptLegal: true }
    );

    await authService.loginWithOAuthProvider({
      provider: 'microsoft',
      providerUserId: 'ms-sub-multi',
      email: 'multi@example.com',
      emailVerified: true,
    });

    const user = await UserModel.findOne({ email: 'multi@example.com' }).lean();
    assert.equal(user?.identityProviders?.length, 2);
  });

  it('blocks password login for OAuth-only accounts', async () => {
    const { authService } = await import('../src/services/authService.js');

    await authService.loginWithOAuthProvider(
      {
        provider: 'google',
        providerUserId: 'google-sub-nopw',
        email: 'oauth-only@example.com',
        emailVerified: true,
      },
      { acceptLegal: true }
    );

    await assert.rejects(
      () => authService.login({ email: 'oauth-only@example.com', password: 'anything' }),
      (err: unknown) => err instanceof Error && err.message.includes('Invalid email or password')
    );
  });

  it('requires legal acceptance for new OAuth accounts', async () => {
    const { authService } = await import('../src/services/authService.js');

    await assert.rejects(
      () =>
        authService.loginWithOAuthProvider({
          provider: 'microsoft',
          providerUserId: 'ms-sub-legal',
          email: 'legal@example.com',
          emailVerified: true,
        }),
      (err: unknown) => err instanceof Error && err.message.includes('Terms')
    );
  });
});

describe('OAuth state', () => {
  it('round-trips signed OAuth state', async () => {
    const { createOAuthState, verifyOAuthState } = await import('../src/auth/userOAuth/state.js');
    const state = createOAuthState({
      provider: 'google',
      pkceCodeVerifier: 'verifier-123',
      returnTo: '/projects',
      acceptLegal: true,
    });

    const parsed = verifyOAuthState(state);
    assert.ok(parsed);
    assert.equal(parsed.provider, 'google');
    assert.equal(parsed.returnTo, '/projects');
    assert.equal(parsed.acceptLegal, true);
  });
});
