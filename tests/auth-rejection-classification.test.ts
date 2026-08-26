import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthApiError, isAuthRejection } from '../client/src/auth/storage.ts';

describe('isAuthRejection', () => {
  it('is true for 401 and 403 AuthApiErrors', () => {
    assert.equal(isAuthRejection(new AuthApiError('nope', 401)), true);
    assert.equal(isAuthRejection(new AuthApiError('nope', 403)), true);
  });

  it('is false for other status codes', () => {
    assert.equal(isAuthRejection(new AuthApiError('server error', 500)), false);
    assert.equal(isAuthRejection(new AuthApiError('bad request', 400)), false);
  });

  it('is false for a plain network failure (no status at all)', () => {
    assert.equal(isAuthRejection(new TypeError('Failed to fetch')), false);
    assert.equal(isAuthRejection(new Error('generic')), false);
    assert.equal(isAuthRejection(null), false);
    assert.equal(isAuthRejection(undefined), false);
  });
});
