import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import {
  callMcpTool,
  createMcpContext,
  mcpInitialize,
  resetMcpTestData,
  stageWriteWithMeta,
} from './helpers/mcp.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-mcp-session-jwt-secret';
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

describe('MCP cross-session proposals (Option B)', () => {
  it('approves create_task staged in sessionA from sessionB', async () => {
    const { ctx: ctxA, userId, secret } = await createMcpContext();
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');
    const { mcpKeyService } = await import('../src/services/mcpKeyService.js');
    const { TaskModel } = await import('../src/models/index.js');

    const auth = await mcpKeyService.authenticate(secret);
    assert.ok(auth);
    const sessionB = await mcpSessionService.createSession(userId, auth.keyId, randomUUID());
    const ctxB = { ...ctxA, sessionId: sessionB };

    const { proposalId } = await stageWriteWithMeta(ctxA, 'create_task', {
      title: 'Cross-session task',
    });

    const hidden = await TaskModel.findOne({ userId, title: 'Cross-session task' }).lean();
    assert.ok(hidden?.staging);
    assert.equal(String(hidden.staging?.conversationId), ctxA.sessionId);

    const approved = await callMcpTool(ctxB, 'approve_proposal', { proposalId });
    assert.equal(approved.success, true, approved.text);

    const visible = await TaskModel.findOne({ userId, title: 'Cross-session task' }).lean();
    assert.ok(visible);
    assert.equal(visible.staging, undefined);
  });

  it('lists pending proposals from all sessions for the same key', async () => {
    const { ctx: ctxA, userId, secret } = await createMcpContext();
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');
    const { mcpKeyService } = await import('../src/services/mcpKeyService.js');

    const auth = await mcpKeyService.authenticate(secret);
    assert.ok(auth);
    const sessionB = await mcpSessionService.createSession(userId, auth.keyId, randomUUID());
    const ctxB = { ...ctxA, sessionId: sessionB };

    const { proposalId } = await stageWriteWithMeta(ctxA, 'create_task', { title: 'Listed task' });

    const listed = await callMcpTool(ctxB, 'list_pending_proposals', {});
    assert.equal(listed.success, true, listed.text);
    const body = JSON.parse(listed.text) as {
      proposals: Array<{ id: string; sessionId: string; name: string }>;
    };
    assert.equal(body.proposals.length, 1);
    assert.equal(body.proposals[0]?.id, proposalId);
    assert.equal(body.proposals[0]?.sessionId, ctxA.sessionId);
    assert.equal(body.proposals[0]?.name, 'create_task');
  });

  it('rejects create_task staged in sessionA from sessionB', async () => {
    const { ctx: ctxA, userId, secret } = await createMcpContext();
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');
    const { mcpKeyService } = await import('../src/services/mcpKeyService.js');
    const { TaskModel } = await import('../src/models/index.js');

    const auth = await mcpKeyService.authenticate(secret);
    assert.ok(auth);
    const sessionB = await mcpSessionService.createSession(userId, auth.keyId, randomUUID());
    const ctxB = { ...ctxA, sessionId: sessionB };

    const { proposalId } = await stageWriteWithMeta(ctxA, 'create_task', { title: 'Reject me' });

    const rejected = await callMcpTool(ctxB, 'reject_proposal', { proposalId });
    assert.equal(rejected.success, true, rejected.text);

    const task = await TaskModel.findOne({ userId, title: 'Reject me' }).lean();
    assert.equal(task, null);
  });

  it('does not approve proposals from a different MCP key', async () => {
    const { ctx: ctxA } = await createMcpContext();
    const { ctx: ctxB } = await createMcpContext();

    const { proposalId } = await stageWriteWithMeta(ctxA, 'create_task', { title: 'Key isolated' });

    const approved = await callMcpTool(ctxB, 'approve_proposal', { proposalId });
    assert.equal(approved.success, false);
    assert.match(approved.text, /not found|already resolved/i);
  });
});

describe('MCP session reuse and rehydration (Option A)', () => {
  it('reuses the same mongo session on a second initialize for the same key', async () => {
    const { secret, userId } = await createMcpContext();
    const { McpSessionModel } = await import('../src/models/index.js');

    const sessionA = await mcpInitialize(app, secret);
    const sessionB = await mcpInitialize(app, secret);

    assert.equal(sessionB, sessionA);
    assert.equal(await McpSessionModel.countDocuments({ userId }), 1);
  });

  it('rehydrates a mongo session when mcp-session-id is sent after memory reset', async () => {
    const { secret } = await createMcpContext();
    const { mcpRpc } = await import('./helpers/mcp.js');
    const {
      _resetMcpSessionsForTests,
      _getMcpSessionsForTests,
    } = await import('../src/mcp/httpHandler.js');

    const sessionId = await mcpInitialize(app, secret);
    assert.equal(_getMcpSessionsForTests().size, 1);

    _resetMcpSessionsForTests();
    assert.equal(_getMcpSessionsForTests().size, 0);

    const rehydrated = await mcpRpc(
      app,
      secret,
      sessionId,
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
      2
    );
    assert.equal(rehydrated.status, 200);
    assert.equal(_getMcpSessionsForTests().size, 1);
    assert.ok(_getMcpSessionsForTests().has(sessionId));
  });

  it('answers a non-initialize request after memory reset with 404, not a bare 400, and a fresh initialize then works', async () => {
    const { secret } = await createMcpContext();
    const { mcpRpc } = await import('./helpers/mcp.js');
    const { _resetMcpSessionsForTests, _getMcpSessionsForTests } = await import(
      '../src/mcp/httpHandler.js'
    );

    const sessionId = await mcpInitialize(app, secret);
    _resetMcpSessionsForTests();

    // A known-but-not-live session id on a non-initialize request (the
    // shape of every real reconnect after a restart) must not fall through
    // to the SDK's own "Server not initialized" 400 — the client has no
    // standard way to recover from that. 404 is the spec's signal to
    // re-initialize.
    const toolCall = await mcpRpc(app, secret, sessionId, 'tools/call', {
      name: 'list_projects',
      arguments: {},
    });
    assert.equal(toolCall.status, 404);
    assert.equal(_getMcpSessionsForTests().size, 0);

    // A compliant client reacts to that 404 by re-initializing with no
    // session id, and gets back the same underlying (mongo) session.
    const reinitialized = await mcpInitialize(app, secret);
    assert.equal(reinitialized, sessionId);

    const afterReinit = await mcpRpc(app, secret, reinitialized, 'tools/call', {
      name: 'list_projects',
      arguments: {},
    });
    assert.equal(afterReinit.status, 200);
  });

  it('keeps pending proposals after soft transport disconnect and allows cross-session approve', async () => {
    const { ctx: ctxA, userId, secret } = await createMcpContext();
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');
    const { mcpKeyService } = await import('../src/services/mcpKeyService.js');
    const { McpSessionModel, TaskModel } = await import('../src/models/index.js');
    const {
      _closeMcpTransportForTests,
      _getMcpSessionsForTests,
    } = await import('../src/mcp/httpHandler.js');

    const auth = await mcpKeyService.authenticate(secret);
    assert.ok(auth);
    const sessionB = await mcpSessionService.createSession(userId, auth.keyId, randomUUID());
    const ctxB = { ...ctxA, sessionId: sessionB };

    const { proposalId } = await stageWriteWithMeta(ctxA, 'create_task', {
      title: 'Soft disconnect task',
    });

    _getMcpSessionsForTests().set(ctxA.sessionId, {
      transport: {} as never,
      server: {} as never,
      ctx: ctxA,
    });
    _closeMcpTransportForTests(ctxA.sessionId);
    assert.equal(_getMcpSessionsForTests().has(ctxA.sessionId), false);

    const mongoSession = await McpSessionModel.findById(ctxA.sessionId).lean();
    assert.ok(mongoSession);
    assert.equal(
      (mongoSession.pendingProposals ?? []).filter((p) => p.status === 'pending').length,
      1
    );

    const approved = await callMcpTool(ctxB, 'approve_proposal', { proposalId });
    assert.equal(approved.success, true, approved.text);

    const visible = await TaskModel.findOne({ userId, title: 'Soft disconnect task' }).lean();
    assert.ok(visible);
    assert.equal(visible.staging, undefined);
  });
});
