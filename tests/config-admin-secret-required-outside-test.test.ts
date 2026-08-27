import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * admin.jwtSecret used to fall back to an empty string in production (and
 * a hardcoded dev constant everywhere else) instead of using the same
 * requireSecret() helper JWT_SECRET/MCP_OAUTH_JWT_SECRET already use — an
 * unset ADMIN_JWT_SECRET in production meant the admin panel signed
 * sessions with an empty HMAC key instead of refusing to start. This
 * deliberately does NOT set ADMIN_JWT_SECRET and skips dotenv, so
 * config/index.ts's top-level requireSecret('ADMIN_JWT_SECRET', ...) call
 * must throw during import, matching JWT_SECRET's existing behavior.
 */
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'present-so-this-is-not-what-fails';
process.env.MCP_OAUTH_JWT_SECRET = 'present-so-this-is-not-what-fails';
delete process.env.ADMIN_JWT_SECRET;

describe('admin JWT secret requirement outside test', () => {
  it('fails to import config when NODE_ENV=production and ADMIN_JWT_SECRET is unset', async () => {
    await assert.rejects(
      () => import('../src/config/index.js'),
      /ADMIN_JWT_SECRET is required when NODE_ENV=production/
    );
  });
});
