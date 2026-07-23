import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Express } from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-conversation-duplicate-secret';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();

  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('conversation duplication', () => {
  it('copies messages into a new session and leaves pending proposals behind', async () => {
    const { signToken } = await import('../src/auth/jwt.js');
    const { ConversationModel, UserModel } = await import('../src/models/index.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const owner = await UserModel.create({
      email: `dup-owner-${randomUUID()}@example.com`,
      passwordHash: 'unused',
    });
    const otherUser = await UserModel.create({
      email: `dup-other-${randomUUID()}@example.com`,
      passwordHash: 'unused',
    });
    const ownerId = String(owner._id);
    const conversation = await conversationService.createConversation(ownerId, 'Planning session');
    const proposalId = randomUUID();

    await conversationService.savePauseState(ownerId, conversation._id, {
      messages: [
        { role: 'system', content: 'You are QTask.' },
        { role: 'user', content: 'Create a draft' },
        { role: 'assistant', content: 'Ready for approval.' },
      ],
      pendingProposals: [
        {
          id: proposalId,
          name: 'create_task',
          arguments: { title: 'Draft task' },
          source: 'native',
          status: 'pending',
          stagedEntity: { kind: 'task', id: 'placeholder' },
        },
      ],
      pausedBatch: {
        assistantContent: 'Ready for approval.',
        toolCalls: [],
        nextToolIndex: 0,
      },
    });

    const otherToken = signToken({ sub: String(otherUser._id), email: otherUser.email });
    await request(app)
      .post(`/api/conversations/${conversation._id}/duplicate`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    const ownerToken = signToken({ sub: ownerId, email: owner.email });
    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/duplicate`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const duplicated = response.body.conversation;
    assert.ok(duplicated._id);
    assert.notEqual(duplicated._id, conversation._id);
    assert.equal(duplicated.title, 'Planning session (copy)');
    assert.equal(duplicated.messages.length, 3);
    assert.equal(duplicated.messages[1]?.role, 'user');
    assert.equal(duplicated.messages[1]?.content, 'Create a draft');
    assert.deepEqual(duplicated.pendingProposals, []);
    assert.equal(duplicated.pausedBatch, null);

    const original = await ConversationModel.findById(conversation._id).lean();
    assert.ok(original);
    assert.equal(original.title, 'Planning session');
    assert.equal(original.messages.length, 3);
    assert.equal((original.pendingProposals ?? []).length, 1);

    const copy = await ConversationModel.findById(duplicated._id).lean();
    assert.ok(copy);
    assert.equal(copy.userId, ownerId);
    assert.equal(copy.title, 'Planning session (copy)');
    assert.equal(copy.messages.length, 3);
    assert.equal((copy.pendingProposals ?? []).length, 0);
    assert.equal(copy.pausedBatch, null);
  });
});
