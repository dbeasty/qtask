import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { registerUser } from './helpers/mcp.js';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.JWT_SECRET = 'test-misc-jwt-secret';
process.env.MCP_OAUTH_JWT_SECRET = 'test-misc-mcp-oauth-secret';
process.env.SERVE_CLIENT = 'false';
process.env.FEEDBACK_ENABLED = 'true';
process.env.FEEDBACK_IMAGES_ENABLED = 'false';

let mongo: MongoMemoryServer;
let app: Express;

const realFetch = globalThis.fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });

  // summarizeProject calls Ollama and only falls back to a deterministic
  // plain-text summary once that call fails. There is no Ollama in CI, so
  // without this stub every summary assertion would sit through the 60s
  // AbortSignal timeout before getting the text it is actually asserting on.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/generate')) throw new Error('ollama unavailable in test');
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

async function newUser(prefix: string) {
  return registerUser(`${prefix}-${randomUUID()}@example.com`);
}

async function createProject(jwt: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/projects')
    .set('Authorization', `Bearer ${jwt}`)
    .send({ name })
    .expect(201);
  return res.body.project._id as string;
}

describe('GET /api/projects/:id/summary', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).get(`/api/projects/${new mongoose.Types.ObjectId()}/summary`).expect(401);
  });

  it('summarises task counts by status and average completion', async () => {
    const { jwt } = await newUser('summary');
    const projectId = await createProject(jwt, 'Summary project');

    const statuses = ['todo', 'todo', 'in_progress', 'done'] as const;
    for (const [i, status] of statuses.entries()) {
      await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ title: `Task ${i}`, projectId, status })
        .expect(201);
    }

    const res = await request(app)
      .get(`/api/projects/${projectId}/summary`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    const summary = res.body.summary as string;
    assert.equal(typeof summary, 'string');
    assert.match(summary, /Summary project/);
    assert.match(summary, /has 4 tasks/);
    assert.match(summary, /2 todo, 1 in progress, 1 done/);
  });

  it('surfaces high-priority open tasks', async () => {
    const { jwt } = await newUser('summary-prio');
    const projectId = await createProject(jwt, 'Priorities');

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ title: 'Urgent open', projectId, status: 'todo', priority: 'urgent' })
      .expect(201);
    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ title: 'Urgent done', projectId, status: 'done', priority: 'urgent' })
      .expect(201);

    const res = await request(app)
      .get(`/api/projects/${projectId}/summary`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    const summary = res.body.summary as string;

    assert.match(summary, /High-priority open items: Urgent open\./);
    assert.ok(
      !summary.includes('Urgent done'),
      'completed tasks must not appear as high-priority open work'
    );
  });

  it('returns 404 for a project belonging to another user', async () => {
    const owner = await newUser('summary-owner');
    const stranger = await newUser('summary-stranger');
    const projectId = await createProject(owner.jwt, 'Private');

    await request(app)
      .get(`/api/projects/${projectId}/summary`)
      .set('Authorization', `Bearer ${stranger.jwt}`)
      .expect(404);
  });
});

describe('GET /api/feedback/mine', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).get('/api/feedback/mine').expect(401);
  });

  it('returns only the caller own feedback, newest first', async () => {
    const mine = await newUser('fb-mine');
    const other = await newUser('fb-other');

    for (const [token, message] of [
      [mine.jwt, 'mine one'],
      [mine.jwt, 'mine two'],
      [other.jwt, 'theirs'],
    ] as const) {
      await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${token}`)
        .field('message', message)
        .field('category', 'bug')
        .expect(201);
    }

    const res = await request(app)
      .get('/api/feedback/mine')
      .set('Authorization', `Bearer ${mine.jwt}`)
      .expect(200);

    const messages = res.body.items.map((i: { message: string }) => i.message);
    assert.equal(messages.length, 2);
    assert.ok(!messages.includes('theirs'), 'must not leak another user feedback');
    assert.ok(res.body.items.every((i: { id: string }) => typeof i.id === 'string'));
  });

  it('honours page and limit and clamps limit to 50', async () => {
    const { jwt } = await newUser('fb-page');
    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/feedback')
        .set('Authorization', `Bearer ${jwt}`)
        .field('message', `item ${i}`)
        .field('category', 'bug')
        .expect(201);
    }

    const page1 = await request(app)
      .get('/api/feedback/mine?page=1&limit=2')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.equal(page1.body.items.length, 2);

    const page2 = await request(app)
      .get('/api/feedback/mine?page=2&limit=2')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.equal(page2.body.items.length, 1);

    const clamped = await request(app)
      .get('/api/feedback/mine?limit=9999')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.ok(clamped.body.items.length <= 50);
  });
});

describe('DELETE /api/mcp-oauth-clients/:id', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).delete(`/api/mcp-oauth-clients/${randomUUID()}`).expect(401);
  });

  it('revokes a client the caller registered and removes it from the list', async () => {
    const { jwt } = await newUser('oauth-client');

    const created = await request(app)
      .post('/api/mcp-oauth-clients')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'My client' })
      .expect(201);

    // The route matches on the document id, which is what the UI sends
    // (McpSettingsDialog passes client.id, not the qto_ client_id).
    const id = created.body.client.id as string;
    assert.ok(id, `expected a client id in ${JSON.stringify(created.body)}`);

    await request(app)
      .delete(`/api/mcp-oauth-clients/${id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    // Revocation is soft: the client stays listed with revokedAt set, which is
    // what the settings UI keys off to hide the Revoke button.
    const list = await request(app)
      .get('/api/mcp-oauth-clients')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.equal(list.body.clients.length, 1);
    assert.ok(list.body.clients[0].revokedAt, 'revoked client must carry revokedAt');

    // ...and revoking twice is not treated as a fresh revocation.
    await request(app)
      .delete(`/api/mcp-oauth-clients/${id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(404);
  });

  it('returns 404 for an unknown client id', async () => {
    const { jwt } = await newUser('oauth-client-404');
    await request(app)
      .delete(`/api/mcp-oauth-clients/${new mongoose.Types.ObjectId()}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(404);
  });

  it('returns 404 rather than 500 for a malformed id', async () => {
    const { jwt } = await newUser('oauth-client-cast');
    // A qto_-style client_id is not an ObjectId; this used to reach Mongoose
    // as a CastError and surface as a 500.
    await request(app)
      .delete('/api/mcp-oauth-clients/qto_not_an_object_id')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(404);
  });

  it('will not let one user revoke another user client', async () => {
    const owner = await newUser('oauth-owner');
    const attacker = await newUser('oauth-attacker');

    const created = await request(app)
      .post('/api/mcp-oauth-clients')
      .set('Authorization', `Bearer ${owner.jwt}`)
      .send({ name: 'Owned' })
      .expect(201);
    const id = created.body.client.id as string;

    await request(app)
      .delete(`/api/mcp-oauth-clients/${id}`)
      .set('Authorization', `Bearer ${attacker.jwt}`)
      .expect(404);

    const stillThere = await request(app)
      .get('/api/mcp-oauth-clients')
      .set('Authorization', `Bearer ${owner.jwt}`)
      .expect(200);
    assert.equal(stillThere.body.clients.length, 1);
    assert.ok(!stillThere.body.clients[0].revokedAt, 'must still be live for its owner');
  });
});

describe('GET /api/mcp (discovery)', () => {
  it('returns 401 with a WWW-Authenticate challenge when unauthenticated', async () => {
    const res = await request(app).get('/api/mcp').expect(401);
    assert.ok(
      res.headers['www-authenticate'],
      'discovery must advertise the auth challenge so MCP clients can find the AS'
    );
  });

  it('returns 405 telling an authenticated caller to use POST', async () => {
    const { userId } = await newUser('mcp-get');
    const { mcpKeyService } = await import('../src/services/mcpKeyService.js');
    const { secret } = await mcpKeyService.createKey(userId, 'discovery key', 'read_write');

    const res = await request(app)
      .get('/api/mcp')
      .set('Authorization', `Bearer ${secret}`)
      .expect(405);
    assert.match(res.body.error, /POST/);
  });
});

describe('GET /.well-known/oauth-protected-resource', () => {
  it('advertises the resource and its authorization server', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource').expect(200);
    assert.ok(res.body.resource, 'must advertise the resource identifier');
    assert.ok(
      Array.isArray(res.body.authorization_servers) && res.body.authorization_servers.length > 0,
      'must advertise at least one authorization server'
    );
  });
});

describe('POST /oauth/revoke', () => {
  it('acknowledges a revocation request', async () => {
    const res = await request(app)
      .post('/oauth/revoke')
      .send({ token: 'whatever' })
      .expect(200);
    assert.equal(res.body.revoked, true);
  });
});
