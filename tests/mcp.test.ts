import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import {
  MCP_READ_TOOLS,
  MCP_SESSION_TOOLS,
  MCP_WRITE_TOOLS,
} from '../src/mcp/toolGroups.js';
import {
  createMcpContext,
  mcpCallTool,
  mcpInitialize,
  mcpRpc,
  parseProposal,
  parseToolResult,
  registerUser,
  resetMcpTestData,
} from './helpers/mcp.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-mcp-jwt-secret';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;

const ALL_MCP_TOOL_NAMES = new Set([
  ...MCP_READ_TOOLS,
  ...MCP_WRITE_TOOLS,
  ...MCP_SESSION_TOOLS,
]);

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
    const { ctx } = await createMcpContext('read');

    const result = await (await import('../src/mcp/mcpToolHandler.js')).executeMcpTool(
      ctx,
      'create_task',
      { title: 'Test task' }
    );

    assert.equal(result.success, false);
    assert.match(result.text, /read-only/i);
  });

  it('stages create_task and commits via approve_proposal', async () => {
    const { ctx, userId } = await createMcpContext();
    const { TaskModel } = await import('../src/models/index.js');
    const { executeMcpTool } = await import('../src/mcp/mcpToolHandler.js');

    const staged = await executeMcpTool(ctx, 'create_task', { title: 'Buy milk' });
    assert.equal(staged.success, true);
    const parsed = parseProposal(staged.text);

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

describe('MCP HTTP protocol', () => {
  it('initializes a session and lists all MCP tools', async () => {
    const { secret } = await createMcpContextWithSecret();
    const sessionId = await mcpInitialize(app, secret);
    const listed = await mcpRpc(app, secret, sessionId, 'tools/list', {}, 2);
    assert.equal(listed.status, 200);

    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of ALL_MCP_TOOL_NAMES) {
      assert.ok(names.has(name), `Missing tool in tools/list: ${name}`);
    }
  });

  it('calls list_projects over HTTP', async () => {
    const { secret } = await createMcpContextWithSecret();
    const sessionId = await mcpInitialize(app, secret);

    const { text, isError } = await mcpCallTool(app, secret, sessionId, 'list_projects');
    assert.equal(isError, false);
    const parsed = JSON.parse(text) as { projects: unknown[] };
    assert.ok(Array.isArray(parsed.projects));
  });

  it('stages create_task and approves via HTTP tools/call', async () => {
    const { secret } = await createMcpContextWithSecret();
    const sessionId = await mcpInitialize(app, secret);

    const stagedProject = await mcpCallTool(app, secret, sessionId, 'create_project', {
      name: 'HTTP Project',
    });
    assert.equal(stagedProject.isError, false);
    const projectProposal = parseProposal(stagedProject.text);
    const approvedProject = await mcpCallTool(app, secret, sessionId, 'approve_proposal', {
      proposalId: projectProposal.proposalId,
    });
    assert.equal(approvedProject.isError, false);
    const projectId = (projectProposal.preview as { _id: string })._id;

    const staged = await mcpCallTool(app, secret, sessionId, 'create_task', {
      title: 'HTTP staged task',
      projectId,
    });
    assert.equal(staged.isError, false);
    const proposal = parseProposal(staged.text);

    const approved = await mcpCallTool(app, secret, sessionId, 'approve_proposal', {
      proposalId: proposal.proposalId,
    });
    assert.equal(approved.isError, false);

    const taskId = (proposal.preview as { _id: string })._id;
    const fetched = await mcpCallTool(app, secret, sessionId, 'get_task', { taskId });
    assert.equal(fetched.isError, false);
    assert.match(fetched.text, /HTTP staged task/);
  });
});

async function createMcpContextWithSecret() {
  const { ctx, secret } = await createMcpContext();
  return { ctx, secret };
}