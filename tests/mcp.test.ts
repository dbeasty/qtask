import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-mcp-jwt-secret';
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
  const { UserModel, McpApiKeyModel, McpSessionModel, TaskModel, ProjectModel } =
    await import('../src/models/index.js');
  await Promise.all([
    UserModel.deleteMany({}),
    McpApiKeyModel.deleteMany({}),
    McpSessionModel.deleteMany({}),
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

describe('MCP auth config', () => {
  it('exposes localhost MCP URL in test environment', async () => {
    const res = await request(app).get('/api/auth/config').expect(200);
    assert.equal(res.body.mcp.url, 'http://localhost:3000/api/mcp');
    assert.equal(res.body.mcp.cloudUrl, 'https://qtask.dev/api/mcp');
    assert.equal(res.body.mcp.authHeader, 'Authorization');
    assert.equal(res.body.mcp.authScheme, 'Bearer');
    assert.equal(res.body.mcp.isLocalhost, true);
  });
});

describe('MCP API keys', () => {
  it('creates, lists, and revokes keys', async () => {
    const { jwt } = await registerUser(`mcp-${randomUUID()}@example.com`);

    const created = await request(app)
      .post('/api/mcp-keys')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'Claude', scope: 'read_write' })
      .expect(201);

    assert.match(created.body.secret, /^qtk_/);
    assert.equal(created.body.key.name, 'Claude');

    const listed = await request(app)
      .get('/api/mcp-keys')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.equal(listed.body.keys.length, 1);

    await request(app)
      .delete(`/api/mcp-keys/${created.body.key.id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    const auth = await request(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${created.body.secret}`)
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

    assert.equal(auth.status, 401);
  });
});

describe('MCP tool handler', () => {
  it('blocks write tools for read-only keys', async () => {
    const { userId } = await registerUser(`mcp-ro-${randomUUID()}@example.com`);
    const { mcpKeyService } = await import('../src/services/mcpKeyService.js');
    const { executeMcpTool } = await import('../src/mcp/mcpToolHandler.js');
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');

    const { secret } = await mcpKeyService.createKey(userId, 'read key', 'read');
    const auth = await mcpKeyService.authenticate(secret);
    assert.ok(auth);
    const sessionId = await mcpSessionService.createSession(userId, auth.keyId);

    const result = await executeMcpTool(
      { userId, sessionId, scope: 'read', keyId: auth.keyId },
      'create_task',
      { title: 'Test task' }
    );

    assert.equal(result.success, false);
    assert.match(result.text, /read-only/i);
  });

  it('stages create_task and commits via approve_proposal', async () => {
    const { userId } = await registerUser(`mcp-stage-${randomUUID()}@example.com`);
    const { mcpKeyService } = await import('../src/services/mcpKeyService.js');
    const { executeMcpTool } = await import('../src/mcp/mcpToolHandler.js');
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');
    const { TaskModel } = await import('../src/models/index.js');

    const { secret } = await mcpKeyService.createKey(userId, 'write key', 'read_write');
    const auth = await mcpKeyService.authenticate(secret);
    assert.ok(auth);
    const sessionId = await mcpSessionService.createSession(userId, auth.keyId);
    const ctx = { userId, sessionId, scope: 'read_write' as const, keyId: auth.keyId };

    const staged = await executeMcpTool(ctx, 'create_task', { title: 'Buy milk' });
    assert.equal(staged.success, true);
    const parsed = JSON.parse(staged.text) as { proposalId: string };
    assert.ok(parsed.proposalId);

    const hidden = await TaskModel.find({ userId, title: 'Buy milk' });
    assert.equal(hidden.length, 1);
    assert.ok(hidden[0]?.staging);

    const approved = await executeMcpTool(ctx, 'approve_proposal', {
      proposalId: parsed.proposalId,
    });
    assert.equal(approved.success, true);

    const visible = await TaskModel.findOne({ userId, title: 'Buy milk' }).lean();
    assert.ok(visible);
    assert.equal(visible.staging, undefined);
  });
});

describe('MCP HTTP endpoint', () => {
  it('rejects unauthenticated initialize requests', async () => {
    await request(app)
      .post('/api/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      })
      .expect(401);
  });
});
