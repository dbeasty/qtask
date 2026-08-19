import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';

const { isAllowedMobileRedirectUri } = await import('../src/auth/userOAuth/service.js');

describe('isAllowedMobileRedirectUri', () => {
  it('always allows the qtask:// scheme, in any environment', () => {
    assert.equal(isAllowedMobileRedirectUri('qtask://oauth', 'production'), true);
    assert.equal(isAllowedMobileRedirectUri('qtask://oauth', 'development'), true);
  });

  it('allows Expo Go\'s exp:// scheme outside production', () => {
    assert.equal(
      isAllowedMobileRedirectUri('exp://192.168.1.200:19000/--/oauth', 'development'),
      true
    );
    assert.equal(isAllowedMobileRedirectUri('exp://192.168.1.200:19000/--/oauth', 'test'), true);
  });

  it('rejects the exp:// scheme in production', () => {
    assert.equal(
      isAllowedMobileRedirectUri('exp://192.168.1.200:19000/--/oauth', 'production'),
      false
    );
  });

  it('rejects arbitrary schemes regardless of environment', () => {
    assert.equal(isAllowedMobileRedirectUri('https://evil.example.com/steal', 'development'), false);
    assert.equal(isAllowedMobileRedirectUri('https://evil.example.com/steal', 'production'), false);
    assert.equal(isAllowedMobileRedirectUri('javascript:alert(1)', 'development'), false);
  });
});
