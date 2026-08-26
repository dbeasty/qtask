import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeReturnPath } from '../client/src/auth/session.ts';

describe('isSafeReturnPath', () => {
  it('accepts a plain relative path', () => {
    assert.equal(isSafeReturnPath('/tasks'), true);
    assert.equal(isSafeReturnPath('/projects/123?x=1'), true);
  });

  it('rejects protocol-relative paths', () => {
    assert.equal(isSafeReturnPath('//evil.com'), false);
    assert.equal(isSafeReturnPath('//evil.com/phish'), false);
  });

  it('rejects backslash-prefixed paths', () => {
    assert.equal(isSafeReturnPath('/\\evil.com'), false);
  });

  it('rejects absolute URLs and empty/missing values', () => {
    assert.equal(isSafeReturnPath('https://evil.com'), false);
    assert.equal(isSafeReturnPath('evil.com'), false);
    assert.equal(isSafeReturnPath(''), false);
    assert.equal(isSafeReturnPath(null), false);
    assert.equal(isSafeReturnPath(undefined), false);
  });
});
