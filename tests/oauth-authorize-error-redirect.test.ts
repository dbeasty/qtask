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
  const { McpOAuthClientModel, McpOAuthPendingConsentModel } = await import(
    '../src/models/index.js'
  );
  await Promise.all([
    McpOAuthClientModel.deleteMany({}),
    McpOAuthPendingConsentModel.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('/oauth/authorize error path does not open-redirect', () => {
  it('does not redirect to an attacker redirect_uri paired with an unknown client_id', async () => {
    const { challenge } = pkcePair();

    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: 'not-a-real-client',
      redirect_uri: 'https://evil.example/phish',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://qtask.dev/api/mcp',
    });

    assert.notEqual(res.status, 302);
    assert.equal(res.headers.location, undefined);
  });

  it('does not redirect when redirect_uri does not match the resolved client\'s registered URIs', async () => {
    const registered = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'Legit Client',
        redirect_uris: ['http://127.0.0.1:8765/callback'],
      })
      .expect(201);
    const clientId = registered.body.client_id as string;

    // Missing code_challenge triggers the error path; redirect_uri here is
    // NOT one of the client's registered URIs.
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://evil.example/phish',
      resource: 'https://qtask.dev/api/mcp',
    });

    assert.notEqual(res.status, 302);
    assert.equal(res.headers.location, undefined);
  });

  it('still redirects to the registered client\'s own redirect_uri with error params (legit UX preserved)', async () => {
    const redirectUri = 'http://127.0.0.1:8765/callback';
    const registered = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'Legit Client',
        redirect_uris: [redirectUri],
      })
      .expect(201);
    const clientId = registered.body.client_id as string;
    const { challenge } = pkcePair();

    // response_type=token is unsupported — triggers the error path with a
    // client_id + redirect_uri pair that IS registered.
    const res = await request(app)
      .get('/oauth/authorize')
      .query({
        response_type: 'token',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: 'abc123',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'https://qtask.dev/api/mcp',
      })
      .expect(302);

    const location = new URL(res.headers.location as string);
    assert.equal(`${location.origin}${location.pathname}`, redirectUri);
    assert.equal(location.searchParams.get('error'), 'invalid_request');
    assert.equal(location.searchParams.get('state'), 'abc123');
  });
});
