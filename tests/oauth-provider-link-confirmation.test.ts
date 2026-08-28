import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.QTASK_SKIP_DOTENV = 'true';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function createExistingUser(email: string, password = 'existing-password-123') {
  const { UserModel } = await import('../src/models/index.js');
  const passwordHash = await bcrypt.hash(password, 4);
  const user = await UserModel.create({
    email,
    passwordHash,
    emailVerified: true,
    legalAcceptedAt: new Date(),
    legalVersion: '1.0',
    identityProviders: [],
  });
  return { user, password };
}

describe('OAuth provider linking (SEC-L4 + SVC-L1)', () => {
  it('Google (a provider that reports verified email reliably) still auto-links, unchanged behavior', async () => {
    const { authService } = await import('../src/services/authService.js');
    const { UserModel } = await import('../src/models/index.js');

    const { user } = await createExistingUser('google-autolink@example.com');

    const result = await authService.loginWithOAuthProvider({
      provider: 'google',
      providerUserId: 'google-sub-1',
      email: user.email,
      emailVerified: true,
      displayName: 'Google User',
    });

    assert.equal('linkConfirmationRequired' in result, false, 'Google sign-in must not require confirmation');
    assert.ok('token' in result && result.token, 'Google sign-in must return a session token directly');

    const reloaded = await UserModel.findById(user._id).lean();
    assert.equal(reloaded?.identityProviders?.length, 1);
    assert.equal(reloaded?.identityProviders?.[0]?.provider, 'google');
  });

  it('Microsoft sign-in matching an existing account by email does NOT silently auto-link', async () => {
    const { authService } = await import('../src/services/authService.js');
    const { UserModel } = await import('../src/models/index.js');

    const { user } = await createExistingUser('microsoft-needs-confirm@example.com');

    const result = await authService.loginWithOAuthProvider({
      provider: 'microsoft',
      providerUserId: 'ms-sub-1',
      email: user.email,
      emailVerified: true,
      displayName: 'MS User',
    });

    // This is the core regression this fix guards: a pre-fix
    // loginWithOAuthProvider() would have pushed the Microsoft identity
    // into identityProviders and returned a live session token here,
    // letting anyone who controls a Microsoft "common" tenant claim for
    // this email silently take over the existing account.
    assert.ok(
      'linkConfirmationRequired' in result && result.linkConfirmationRequired,
      'Microsoft sign-in against an existing account must require confirmation'
    );
    assert.ok('linkToken' in result && typeof result.linkToken === 'string' && result.linkToken.length > 0);
    assert.equal((result as { email: string }).email, user.email);
    assert.equal('token' in result, false, 'no session token must be issued before confirmation');

    const reloaded = await UserModel.findById(user._id).lean();
    assert.equal(reloaded?.identityProviders?.length, 0, 'the account must be untouched pending confirmation');
  });

  it('confirming the link with the correct password links the provider and issues a session', async () => {
    const { authService } = await import('../src/services/authService.js');
    const { UserModel } = await import('../src/models/index.js');

    const { user, password } = await createExistingUser('microsoft-confirm-ok@example.com');

    const pending = await authService.loginWithOAuthProvider({
      provider: 'microsoft',
      providerUserId: 'ms-sub-2',
      email: user.email,
      emailVerified: true,
      displayName: 'MS User 2',
    });
    assert.ok('linkToken' in pending);

    const confirmed = await authService.confirmOAuthProviderLink(
      (pending as { linkToken: string }).linkToken,
      password
    );
    assert.ok(confirmed.token, 'confirming with the correct password must issue a session token');

    const reloaded = await UserModel.findById(user._id).lean();
    assert.equal(reloaded?.identityProviders?.length, 1);
    assert.equal(reloaded?.identityProviders?.[0]?.provider, 'microsoft');
  });

  it('confirming the link with the wrong password fails and does not link the provider', async () => {
    const { authService } = await import('../src/services/authService.js');
    const { UserModel } = await import('../src/models/index.js');

    const { user } = await createExistingUser('microsoft-confirm-wrong@example.com');

    const pending = await authService.loginWithOAuthProvider({
      provider: 'microsoft',
      providerUserId: 'ms-sub-3',
      email: user.email,
      emailVerified: true,
      displayName: 'MS User 3',
    });
    assert.ok('linkToken' in pending);

    await assert.rejects(
      () => authService.confirmOAuthProviderLink((pending as { linkToken: string }).linkToken, 'totally-wrong'),
      /invalid email or password/i
    );

    const reloaded = await UserModel.findById(user._id).lean();
    assert.equal(reloaded?.identityProviders?.length, 0);
  });

  it('confirming with a tampered or garbage token fails', async () => {
    const { authService } = await import('../src/services/authService.js');

    await assert.rejects(
      () => authService.confirmOAuthProviderLink('not-a-real-token', 'whatever'),
      /invalid or expired/i
    );
  });
});
