import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'test-user-jwt-secret';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
process.env.ADMIN_AUTH_MODE = 'password';
process.env.HASH_ADMIN_PASSWORD = 'true';
process.env.ADMIN_PASSWORD_HASH = 'not-a-bcrypt-hash';
process.env.ADMIN_COOKIE_SECURE = 'false';

const { createAdminApp } = await import('../src/admin/app.js');

describe('admin hash mode startup validation', () => {
  it('rejects invalid ADMIN_PASSWORD_HASH in production', async () => {
    await assert.rejects(
      () => createAdminApp({ connect: false, serveClient: false }),
      /ADMIN_PASSWORD_HASH must be a valid bcrypt hash/
    );
  });
});
