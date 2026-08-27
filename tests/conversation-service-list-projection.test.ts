import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

describe('listConversations only loads the fields its summary actually needs', () => {
  it('projects out full message history instead of loading every conversation in full', async () => {
    const { ConversationModel } = await import('../src/models/index.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const userId = 'projection-user';
    // A conversation with a large message history — listConversations()
    // only needs title/timestamps for its summary, not this.
    await ConversationModel.create({
      userId,
      title: 'Big conversation',
      messages: Array.from({ length: 50 }, (_, i) => ({
        role: 'user',
        content: `Message number ${i} with some real content in it`,
      })),
      pendingProposals: [{ id: 'p1', tool: 'create_task', args: {} }],
      pausedBatch: null,
    });

    const capturedSelects: unknown[] = [];
    const originalSelect = mongoose.Query.prototype.select;
    mongoose.Query.prototype.select = function selectSpy(this: mongoose.Query<unknown, unknown>, arg) {
      capturedSelects.push(arg);
      return originalSelect.call(this, arg);
    } as typeof mongoose.Query.prototype.select;

    let summaries;
    try {
      summaries = await conversationService.listConversations(userId);
    } finally {
      mongoose.Query.prototype.select = originalSelect;
    }

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].title, 'Big conversation');

    const projection = capturedSelects
      .map((select) => String(select))
      .find((select) => select.includes('title'));
    assert.ok(
      projection,
      `expected a .select(...) call including "title", got: ${JSON.stringify(capturedSelects)}`
    );
    assert.ok(
      !projection.includes('messages') && !projection.includes('pendingProposals'),
      `expected the projection to exclude messages/pendingProposals, got: ${projection}`
    );
  });
});
