import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-user-secret';
process.env.ADMIN_JWT_SECRET = 'test-admin-secret';
process.env.ADMIN_AUTH_MODE = 'mtls';
process.env.ADMIN_PROXY_SECRET = 'trusted-proxy-secret';
process.env.ADMIN_COOKIE_SECURE = 'false';

const { createAdminApp } = await import('../src/admin/app.js');
const app = await createAdminApp({ connect: false, serveClient: false });

describe('admin mTLS exchange', () => {
  it('rejects spoofed certificate headers without the proxy secret', async () => {
    await request(app)
      .post('/api/admin/auth/mtls')
      .set('x-ssl-client-verify', 'SUCCESS')
      .set('x-ssl-client-dn', 'CN=attacker')
      .expect(401);
  });

  it('issues a session only for a proxy-verified client identity', async () => {
    const agent = request.agent(app);
    const login = await agent
      .post('/api/admin/auth/mtls')
      .set('x-admin-proxy-secret', 'trusted-proxy-secret')
      .set('x-ssl-client-verify', 'SUCCESS')
      .set('x-ssl-client-dn', 'CN=qtask-admin')
      .expect(200);

    assert.equal(login.body.identity, 'CN=qtask-admin');
    const session = await agent.get('/api/admin/auth/session').expect(200);
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.identity, 'CN=qtask-admin');
  });
});
