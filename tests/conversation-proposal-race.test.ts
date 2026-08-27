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

describe('concurrent proposal approvals on the same conversation', () => {
  it('two concurrent updateProposalStatus calls for different proposals both land', async () => {
    const { ConversationModel } = await import('../src/models/index.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const userId = 'proposal-race-user';
    const proposalAId = randomUUID();
    const proposalBId = randomUUID();

    const conversation = await ConversationModel.create({
      userId,
      title: 'Race conversation',
      messages: [],
      pendingProposals: [
        { id: proposalAId, name: 'create_task', arguments: {}, source: 'native', status: 'pending' },
        { id: proposalBId, name: 'create_task', arguments: {}, source: 'native', status: 'pending' },
      ],
      pausedBatch: null,
    });
    const conversationId = String(conversation._id);

    const [resultA, resultB] = await Promise.all([
      conversationService.updateProposalStatus(userId, conversationId, proposalAId, 'approved', [
        { role: 'assistant', content: 'Approved A' },
      ]),
      conversationService.updateProposalStatus(userId, conversationId, proposalBId, 'rejected', [
        { role: 'assistant', content: 'Rejected B' },
      ]),
    ]);

    assert.ok(resultA, 'first updateProposalStatus call should succeed');
    assert.ok(resultB, 'second updateProposalStatus call should succeed');

    const finalDoc = await ConversationModel.findById(conversationId).lean();
    const proposals = finalDoc?.pendingProposals as Array<{ id: string; status: string }>;
    const finalA = proposals.find((p) => p.id === proposalAId);
    const finalB = proposals.find((p) => p.id === proposalBId);

    assert.equal(finalA?.status, 'approved', 'proposal A status must not be reverted by the concurrent write');
    assert.equal(finalB?.status, 'rejected', 'proposal B status must not be reverted by the concurrent write');

    const messageContents = (finalDoc?.messages ?? []).map((m) => m.content);
    assert.ok(messageContents.includes('Approved A'), 'message from the first call must survive');
    assert.ok(messageContents.includes('Rejected B'), 'message from the second call must survive');
  });
});
