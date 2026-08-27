import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Express } from 'express';
import { createMcpContext, mcpCallTool, mcpInitialize, resetMcpTestData } from './helpers/mcp.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-mcp-readonly-jwt-secret';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

beforeEach(async () => {
  await resetMcpTestData();
  delete process.env.READ_ONLY_MODE;
});

after(async () => {
  delete process.env.READ_ONLY_MODE;
  await mongoose.disconnect();
  await mongo.stop();
});

async function createTestApp(env: Record<string, string | undefined> = {}): Promise<Express> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const { createApp } = await import('../src/app.js');
  return createApp({ connect: true, startWorker: false });
}

describe('MCP stays reachable in read-only mode; only write tools are blocked', () => {
  it('completes the initialize handshake and serves read tools instead of a blanket 503', async () => {
    const { ProjectModel } = await import('../src/models/index.js');
    const { userId, secret } = await createMcpContext('read_write');
    await ProjectModel.create({
      userId,
      name: 'Visible in read-only mode',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
    });

    const readOnlyApp = await createTestApp({ READ_ONLY_MODE: 'true', DEPLOYMENT_PHASE: 'major-deploy' });

    // Pre-fix, the global readOnlyMiddleware 503'd every POST to /api/mcp,
    // including the handshake itself — mcpInitialize() asserts a 200
    // internally, so this alone fails hard pre-fix.
    const sessionId = await mcpInitialize(readOnlyApp, secret);

    const listed = await mcpCallTool(readOnlyApp, secret, sessionId, 'list_projects', {});
    assert.equal(listed.isError, false);
    assert.match(listed.text, /Visible in read-only mode/);
  });

  it('still blocks write tools in read-only mode via the existing per-tool check', async () => {
    const { userId, secret } = await createMcpContext('read_write');
    const { ProjectModel } = await import('../src/models/index.js');
    const project = await ProjectModel.create({
      userId,
      name: 'Read-only write target',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
    });

    const readOnlyApp = await createTestApp({ READ_ONLY_MODE: 'true', DEPLOYMENT_PHASE: 'major-deploy' });
    const sessionId = await mcpInitialize(readOnlyApp, secret);

    const created = await mcpCallTool(readOnlyApp, secret, sessionId, 'create_task', {
      title: 'Should not be created',
      projectId: String(project._id),
    });
    assert.equal(created.isError, true);
    assert.match(created.text, /read-only mode/i);
  });
});
