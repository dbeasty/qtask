import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-mcp-jwt-secret';
process.env.MCP_OAUTH_JWT_SECRET = 'test-mcp-oauth-jwt-secret';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();

  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

beforeEach(async () => {
  const {
    UserModel,
    McpApiKeyModel,
    McpSessionModel,
    McpOAuthClientModel,
    McpOAuthAuthorizationCodeModel,
    McpOAuthRefreshTokenModel,
    McpOAuthPendingConsentModel,
    TaskModel,
    ProjectModel,
  } = await import('../src/models/index.js');
  await Promise.all([
    UserModel.deleteMany({}),
    McpApiKeyModel.deleteMany({}),
    McpSessionModel.deleteMany({}),
    McpOAuthClientModel.deleteMany({}),
    McpOAuthAuthorizationCodeModel.deleteMany({}),
    McpOAuthRefreshTokenModel.deleteMany({}),
    McpOAuthPendingConsentModel.deleteMany({}),
    TaskModel.deleteMany({}),
    ProjectModel.deleteMany({}),
  ]);
  const { _resetMcpSessionsForTests } = await import('../src/mcp/httpHandler.js');
  _resetMcpSessionsForTests();
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function registerUser(email: string) {
  const { UserModel } = await import('../src/models/index.js');
  const user = await UserModel.create({
    email,
    passwordHash: 'unused',
    emailVerified: true,
  });
  const { signToken } = await import('../src/auth/jwt.js');
  return {
    userId: String(user._id),
    jwt: signToken({ sub: String(user._id), email }),
  };
}

describe('MCP OAuth metadata', () => {
  it('serves authorization server metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    assert.equal(res.body.client_id_metadata_document_supported, true);
    assert.ok(res.body.registration_endpoint.includes('/oauth/register'));
    assert.deepEqual(res.body.code_challenge_methods_supported, ['S256']);
  });

  it('serves protected resource metadata for MCP path', async () => {
    const res = await request(app)
      .get('/.well-known/oauth-protected-resource/api/mcp')
      .expect(200);
    assert.equal(res.body.resource, 'http://localhost:3000/api/mcp');
    assert.equal(res.body.authorization_servers[0], 'http://localhost:3000');
    assert.ok(res.body.scopes_supported.includes('mcp:read_write'));
  });

  it('includes oauth block in auth config', async () => {
    const res = await request(app).get('/api/auth/config').expect(200);
    assert.ok(res.body.mcp.oauth);
    assert.equal(res.body.mcp.oauth.enabled, true);
    assert.equal(res.body.mcp.oauth.resource, 'https://qtask.dev/api/mcp');
  });
});

describe('MCP OAuth discovery', () => {
  it('returns WWW-Authenticate on unauthenticated MCP POST', async () => {
    const res = await request(app).post('/api/mcp').send({}).expect(401);
    const header = res.headers['www-authenticate'];
    assert.ok(typeof header === 'string');
    assert.match(header, /resource_metadata=/);
    assert.match(header, /scope=/);
  });
});

describe('MCP OAuth authorization code flow', () => {
  it('registers a client, approves consent, and accesses MCP with OAuth token', async () => {
    const { jwt } = await registerUser('oauth-user@example.com');
    const { getMcpResourceUri } = await import('../src/config/urls.js');
    const resource = getMcpResourceUri();
    const redirectUri = 'http://127.0.0.1:8765/callback';
    const { verifier, challenge } = pkcePair();

    const registered = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'Test MCP Client',
        redirect_uris: [redirectUri],
      })
      .expect(201);

    const clientId = registered.body.client_id as string;
    const clientSecret = registered.body.client_secret as string;
    assert.ok(clientId.startsWith('qto_'));

    const authorize = await request(app)
      .get('/oauth/authorize')
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'mcp:read_write',
        state: 'test-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource,
      })
      .expect(302);

    const consentUrl = new URL(authorize.headers.location as string);
    const state = consentUrl.searchParams.get('state');
    assert.ok(state);

    const consentDetails = await request(app)
      .get('/oauth/consent')
      .query({ state })
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.equal(consentDetails.body.consent.clientName, 'Test MCP Client');

    const approved = await request(app)
      .post('/oauth/consent')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ state, action: 'approve' })
      .expect(200);

    const callbackUrl = new URL(approved.body.redirectUrl as string);
    assert.equal(callbackUrl.searchParams.get('state'), 'test-state');
    const code = callbackUrl.searchParams.get('code');
    assert.ok(code);

    const tokenRes = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
        resource,
      })
      .expect(200);

    assert.ok(tokenRes.body.access_token);
    assert.equal(tokenRes.body.token_type, 'Bearer');

    const mcpRes = await request(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${tokenRes.body.access_token}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      });

    assert.notEqual(mcpRes.status, 401);
  });
});

describe('MCP OAuth pre-registered clients', () => {
  it('creates registered client via API', async () => {
    const { jwt } = await registerUser('oauth-client@example.com');

    const created = await request(app)
      .post('/api/mcp-oauth-clients')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'Claude org' })
      .expect(201);

    assert.match(created.body.clientId, /^qto_/);
    assert.match(created.body.clientSecret, /^qto_sec_/);

    const listed = await request(app)
      .get('/api/mcp-oauth-clients')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.equal(listed.body.clients.length, 1);
  });
});

describe('MCP API key regression', () => {
  it('still accepts qtk_ API keys on /api/mcp', async () => {
    const { userId } = await registerUser('api-key-user@example.com');
    const { mcpKeyService } = await import('../src/services/mcpKeyService.js');
    const { secret } = await mcpKeyService.createKey(userId, 'bridge', 'read_write');

    const res = await request(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${secret}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      });

    assert.notEqual(res.status, 401);
  });
});
