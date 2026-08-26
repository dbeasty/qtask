import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-mcp-stdio-jwt-secret';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

/**
 * Reproduces the session bootstrap that startMcpServer() does for the stdio
 * transport: a fixed sessionId generated up front, a session created under
 * a fixed keyId, and an McpServerContext built from both. Regression test
 * for the bug where the created session's real id was never threaded back
 * into ctx.sessionId (and ctx.keyId was left undefined), so every staged
 * write and proposal lookup failed "MCP session not found".
 */
async function bootstrapStdioSession(userId: string) {
  const { mcpSessionService } = await import('../src/services/mcpSessionService.js');
  const sessionId = randomUUID();
  const keyId = 'stdio-local';
  await mcpSessionService.createSession(userId, keyId, sessionId);
  return { sessionId, keyId };
}

describe('stdio MCP session bootstrap', () => {
  it('creates a session whose id and keyId match what the server context uses', async () => {
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');
    const userId = String(new mongoose.Types.ObjectId());
    const { sessionId, keyId } = await bootstrapStdioSession(userId);

    const session = await mcpSessionService.getSession(userId, sessionId);
    assert.ok(session, 'session should be found by the id used to create it');

    const byKey = await mcpSessionService.getSessionByKey(userId, keyId, sessionId);
    assert.ok(byKey, 'session should be found by the keyId used to create it');
  });

  it('lets a staged write and its approval succeed end to end', async () => {
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');
    const userId = String(new mongoose.Types.ObjectId());
    const { sessionId, keyId } = await bootstrapStdioSession(userId);

    const { proposal } = await mcpSessionService.stageWriteTool(userId, sessionId, 'create_task', {
      title: 'From stdio',
    });
    assert.ok(proposal.id);

    const pending = await mcpSessionService.getPendingProposals(userId, keyId);
    assert.equal(pending.some((p) => p.id === proposal.id), true);

    const resultText = await mcpSessionService.approveProposal(userId, keyId, proposal.id);
    assert.ok(resultText);
  });
});
