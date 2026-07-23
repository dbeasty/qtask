import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  isBcryptHash,
  verifyPassword,
} from '../src/utils/passwordHash.js';

describe('passwordHash', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('test-password-12');
    assert.ok(isBcryptHash(hash));
    assert.equal(await verifyPassword('test-password-12', hash), true);
    assert.equal(await verifyPassword('wrong-password', hash), false);
  });

  it('isBcryptHash rejects plaintext', () => {
    assert.equal(isBcryptHash('plain-password'), false);
    assert.equal(isBcryptHash(undefined), false);
    assert.equal(isBcryptHash('$2a$12$abcdefghijklmnopqrstuv'), true);
  });
});
