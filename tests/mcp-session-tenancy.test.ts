import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Express } from 'express';
import { createMcpContext, mcpInitialize, mcpRpc, resetMcpTestData } from './helpers/mcp.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-mcp-tenancy-jwt-secret';
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
  await resetMcpTestData();
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('MCP in-memory session tenancy', () => {
  it('rejects a request that presents another key\'s live session id', async () => {
    const { secret: secretA } = await createMcpContext();
    const { secret: secretB } = await createMcpContext();

    // A's initialize puts a live transport for A's session in the
    // in-memory sessions map (the fast path RT-H1 was about).
    const sessionIdFromA = await mcpInitialize(app, secretA);

    // B authenticates with its own valid key but presents A's session id.
    // Before the fix, the in-memory fast path served this using A's
    // cached ctx (userId/keyId/scope) without checking it against B's
    // authenticated identity — B would execute tools as A.
    const crossTenantCall = await mcpRpc(app, secretB, sessionIdFromA, 'tools/call', {
      name: 'list_projects',
      arguments: {},
    });

    assert.equal(crossTenantCall.status, 401);
  });

  it('still serves the owning key normally on the same session id', async () => {
    const { secret } = await createMcpContext();
    const sessionId = await mcpInitialize(app, secret);

    const ownCall = await mcpRpc(app, secret, sessionId, 'tools/call', {
      name: 'list_projects',
      arguments: {},
    });

    assert.equal(ownCall.status, 200);
  });
});
