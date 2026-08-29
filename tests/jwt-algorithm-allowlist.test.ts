import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
process.env.QTASK_SKIP_DOTENV = 'true';

describe('JWT verification only accepts the algorithm it was signed with (HS256)', () => {
  it('auth/jwt.verifyToken rejects a token signed with a different HMAC algorithm', async () => {
    const { config } = await import('../src/config/index.js');
    const { verifyToken } = await import('../src/auth/jwt.js');

    // Same secret, same claims, but signed HS384 instead of HS256 — a
    // pre-fix jwt.verify() call with no `algorithms` option accepts
    // whatever algorithm the token header claims, so this must now be
    // rejected explicitly rather than silently verified.
    const token = jwt.sign({ sub: 'user-1', email: 'a@example.com' }, config.jwtSecret, {
      algorithm: 'HS384',
    });

    assert.throws(() => verifyToken(token), /invalid algorithm/i);
  });

  it('oauth/jwt.verifyMcpOAuthAccessToken rejects a token signed with a different HMAC algorithm', async () => {
    const { config } = await import('../src/config/index.js');
    const { verifyMcpOAuthAccessToken } = await import('../src/oauth/jwt.js');

    const token = jwt.sign(
      { sub: 'user-1', scope: 'read', client_id: 'client-1', aud: 'resource-1', typ: 'mcp_oauth' },
      config.mcpOAuth.jwtSecret,
      { algorithm: 'HS384' }
    );

    assert.equal(verifyMcpOAuthAccessToken(token), null);
  });
});
