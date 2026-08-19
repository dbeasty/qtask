import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeTokenPayload,
  getTokenExpiryMs,
  isTokenExpired,
  isWithinRefreshGrace,
  REFRESH_GRACE_MS,
  REFRESH_LEAD_MS,
  shouldProactivelyRefresh,
} from './jwt';

function makeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-signature`;
}

describe('decodeTokenPayload', () => {
  it('decodes a well-formed JWT payload', () => {
    const token = makeToken({ sub: 'user-1', exp: 1234567890 });
    assert.deepEqual(decodeTokenPayload(token), { sub: 'user-1', exp: 1234567890 });
  });

  it('returns null for a token missing segments', () => {
    assert.equal(decodeTokenPayload('not-a-jwt'), null);
  });

  it('returns null for invalid base64/JSON in the payload segment', () => {
    assert.equal(decodeTokenPayload('a.!!!not-base64!!!.c'), null);
  });

  it('round-trips non-ASCII characters in the payload', () => {
    const token = makeToken({ sub: 'üser-日本語' });
    assert.deepEqual(decodeTokenPayload(token), { sub: 'üser-日本語' });
  });
});

describe('getTokenExpiryMs', () => {
  it('converts the exp claim (seconds) to milliseconds', () => {
    const token = makeToken({ exp: 1000 });
    assert.equal(getTokenExpiryMs(token), 1_000_000);
  });

  it('returns null when there is no exp claim', () => {
    const token = makeToken({ sub: 'user-1' });
    assert.equal(getTokenExpiryMs(token), null);
  });
});

describe('isTokenExpired', () => {
  it('returns false for null token', () => {
    assert.equal(isTokenExpired(null), false);
  });

  it('returns false for a token expiring in the future', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) + 3600 });
    assert.equal(isTokenExpired(token), false);
  });

  it('returns true for a token that already expired', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    assert.equal(isTokenExpired(token), true);
  });
});

describe('isWithinRefreshGrace', () => {
  it('returns false when well within validity', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) + 3600 });
    assert.equal(isWithinRefreshGrace(token), false);
  });

  it('returns true just after expiry, inside the grace window', () => {
    const expiredSecondsAgo = Math.floor((REFRESH_GRACE_MS / 2) / 1000);
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) - expiredSecondsAgo });
    assert.equal(isWithinRefreshGrace(token), true);
  });

  it('returns false once past the grace window', () => {
    const expiredSecondsAgo = Math.floor((REFRESH_GRACE_MS * 2) / 1000);
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) - expiredSecondsAgo });
    assert.equal(isWithinRefreshGrace(token), false);
  });
});

describe('shouldProactivelyRefresh', () => {
  it('returns false for a token far from expiry', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) + REFRESH_LEAD_MS / 1000 + 3600 });
    assert.equal(shouldProactivelyRefresh(token), false);
  });

  it('returns true once inside the proactive refresh lead window', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) + 60 });
    assert.equal(shouldProactivelyRefresh(token), true);
  });

  it('returns true for an already-expired token', () => {
    const token = makeToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    assert.equal(shouldProactivelyRefresh(token), true);
  });
});
