import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();

  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

beforeEach(async () => {
  const { McpOAuthClientModel } = await import('../src/models/index.js');
  await McpOAuthClientModel.deleteMany({});
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('POST /oauth/token rejects non-string body fields', () => {
  it('does not let an object-shaped client_id reach the client-resolution query', async () => {
    // A real client in the DB — if the $gt-shaped client_id below reached
    // McpOAuthClientModel.findOne({ clientId: {$gt: ''}, ... }) unvalidated,
    // it would match this (or any) client without knowing its real id,
    // and the request would fail later for an unrelated reason (bad code)
    // instead of at the body-shape check.
    await request(app)
      .post('/oauth/register')
      .send({ client_name: 'Real Client', redirect_uris: ['http://127.0.0.1:8765/callback'] })
      .expect(201);

    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'authorization_code',
        code: 'whatever',
        redirect_uri: 'http://127.0.0.1:8765/callback',
        code_verifier: 'some-verifier',
        client_id: { $gt: '' },
      });

    assert.equal(res.status, 400);
    // Must be rejected at the body-shape check, not fall through to
    // client resolution and fail later for an unrelated reason (which
    // would prove the object reached the query).
    assert.equal(res.body.error, 'Invalid token request body');
  });

  it('rejects an array-shaped field', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: ['$ne', null],
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid token request body');
  });

  it('still processes a normal, all-string request body past the shape check', async () => {
    const res = await request(app).post('/oauth/token').send({
      grant_type: 'authorization_code',
      code: 'not-a-real-code',
      client_id: 'qto_fake',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      code_verifier: 'verifier',
    });

    // Rejected for a real business reason (unknown client), not the shape
    // check — proves legitimate string-only requests aren't blocked.
    assert.equal(res.status, 400);
    assert.notEqual(res.body.error, 'Invalid token request body');
  });
});
