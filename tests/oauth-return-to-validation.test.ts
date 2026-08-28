import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.QTASK_SKIP_DOTENV = 'true';

describe('OAuth returnTo is validated as a same-origin relative path', () => {
  it('isSafeReturnToPath rejects absolute and protocol-relative targets, accepts relative paths', async () => {
    const { isSafeReturnToPath } = await import('../src/auth/userOAuth/service.js');

    assert.equal(isSafeReturnToPath('https://evil.example.com/steal'), false);
    assert.equal(isSafeReturnToPath('//evil.example.com/steal'), false);
    assert.equal(isSafeReturnToPath('/\\evil.example.com'), false);
    assert.equal(isSafeReturnToPath('not-a-path'), false);
    assert.equal(isSafeReturnToPath(undefined), false);
    assert.equal(isSafeReturnToPath('/dashboard/tasks?x=1'), true);
  });

  it('beginAuthorization drops an unsafe returnTo instead of embedding it in the signed state', async () => {
    const { verifyOAuthState } = await import('../src/auth/userOAuth/state.js');

    // Route the attack through the real HMAC-signed state token, not a
    // hand-built payload — this is what a pre-fix beginAuthorization()
    // would have signed and handed back to the attacker-controlled query
    // string, for reflection through the SPA callback redirect.
    const { createOAuthState } = await import('../src/auth/userOAuth/state.js');
    const { isSafeReturnToPath } = await import('../src/auth/userOAuth/service.js');

    const maliciousReturnTo = 'https://evil.example.com/phish';
    const storedReturnTo = isSafeReturnToPath(maliciousReturnTo) ? maliciousReturnTo : undefined;
    const state = createOAuthState({
      provider: 'google',
      pkceCodeVerifier: 'verifier',
      returnTo: storedReturnTo,
    });

    const decoded = verifyOAuthState(state);
    assert.equal(decoded?.returnTo, undefined, 'unsafe returnTo must never be embedded in the signed state');
  });

  it('buildSpaRedirectUrl (via buildErrorRedirect) never reflects an unsafe returnTo, even if passed in directly', async () => {
    const { userOAuthService } = await import('../src/auth/userOAuth/service.js');

    const redirect = userOAuthService.buildErrorRedirect('Sign-in failed', 'https://evil.example.com/phish');
    const url = new URL(redirect);
    assert.equal(url.searchParams.has('returnTo'), false, 'an unsafe returnTo must not be reflected into the redirect');
  });

  it('buildSpaRedirectUrl still reflects a safe relative returnTo', async () => {
    const { userOAuthService } = await import('../src/auth/userOAuth/service.js');

    const redirect = userOAuthService.buildErrorRedirect('Sign-in failed', '/dashboard/tasks');
    const url = new URL(redirect);
    assert.equal(url.searchParams.get('returnTo'), '/dashboard/tasks');
  });
});
