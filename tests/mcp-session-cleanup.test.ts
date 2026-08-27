import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';

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

describe('MCP session cleanup', () => {
  it('startSweep/stopSweep manage a single interval without throwing', async () => {
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');
    // Idempotent start (second call should not create a second timer or throw).
    mcpSessionService.startSweep();
    mcpSessionService.startSweep();
    mcpSessionService.stopSweep();
    mcpSessionService.stopSweep();
  });

  it('sweepExpiredSessions closes sessions older than the TTL', async () => {
    const { McpSessionModel } = await import('../src/models/index.js');
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');

    const userId = 'sweep-user';
    const staleId = randomUUID();
    await McpSessionModel.create({
      _id: staleId,
      userId,
      keyId: 'key-1',
      pendingProposals: [],
    });
    // Backdate updatedAt past the 7-day TTL (timestamps: true normally
    // stamps "now" on create).
    await McpSessionModel.updateOne(
      { _id: staleId },
      { $set: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } },
      { timestamps: false }
    );

    const closed = await mcpSessionService.sweepExpiredSessions();
    assert.equal(closed, 1);

    const remaining = await McpSessionModel.findById(staleId).lean();
    assert.equal(remaining, null);
  });

  it('closeSession does not crash and still deletes the session when it has a pending proposal for a staged (now-deleted) task', async () => {
    // Regression for the conversationId/mcpSessionId type confusion:
    // setProposalStatuses used to always query ConversationModel, whose
    // _id is an ObjectId — an MCP session id is a UUID string, so that
    // query threw a CastError, which propagated up through
    // rollbackStaleForConversation and closeSession and skipped the
    // McpSessionModel.deleteOne() that should run right after.
    const { McpSessionModel, TaskModel } = await import('../src/models/index.js');
    const { mcpSessionService } = await import('../src/services/mcpSessionService.js');

    const userId = 'close-session-user';
    const sessionId = randomUUID();
    const proposalId = randomUUID();

    await McpSessionModel.create({
      _id: sessionId,
      userId,
      keyId: 'key-1',
      pendingProposals: [
        { id: proposalId, name: 'create_task', arguments: {}, source: 'native', status: 'pending' },
      ],
    });

    await TaskModel.create({
      userId,
      title: 'Staged via MCP',
      status: 'todo',
      staging: { conversationId: sessionId, proposalId, stagedAt: new Date() },
    });

    await mcpSessionService.closeSession(userId, sessionId);

    const remainingSession = await McpSessionModel.findById(sessionId).lean();
    assert.equal(remainingSession, null, 'the session document must actually be deleted, not left behind by a thrown error');

    const remainingTask = await TaskModel.findOne({ 'staging.conversationId': sessionId }).lean();
    assert.equal(remainingTask, null, 'the abandoned staged task must be rolled back');
  });
});
