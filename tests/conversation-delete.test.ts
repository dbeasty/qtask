import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Express } from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-conversation-delete-secret';
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

describe('conversation deletion', () => {
  it('deletes owned chat history and staged drafts but preserves committed tasks', async () => {
    const { signToken } = await import('../src/auth/jwt.js');
    const { ConversationModel, TaskModel, UserModel } = await import('../src/models/index.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const owner = await UserModel.create({
      email: `chat-owner-${randomUUID()}@example.com`,
      passwordHash: 'unused',
    });
    const otherUser = await UserModel.create({
      email: `chat-other-${randomUUID()}@example.com`,
      passwordHash: 'unused',
    });
    const ownerId = String(owner._id);
    const conversation = await conversationService.createConversation(ownerId, 'Old chat');
    const proposalId = randomUUID();

    const committedTask = await TaskModel.create({ userId: ownerId, title: 'Keep me' });
    const stagedTask = await TaskModel.create({
      userId: ownerId,
      title: 'Discard me',
      staging: {
        conversationId: conversation._id,
        proposalId,
        stagedAt: new Date(),
      },
    });

    const otherToken = signToken({ sub: String(otherUser._id), email: otherUser.email });
    await request(app)
      .delete(`/api/conversations/${conversation._id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    assert.equal(await ConversationModel.countDocuments({ _id: conversation._id }), 1);
    assert.equal(await TaskModel.countDocuments({ _id: stagedTask._id }), 1);

    const ownerToken = signToken({ sub: ownerId, email: owner.email });
    const response = await request(app)
      .delete(`/api/conversations/${conversation._id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    assert.equal(response.body.discardedStagedCount, 1);
    assert.equal(await ConversationModel.countDocuments({ _id: conversation._id }), 0);
    assert.equal(await TaskModel.countDocuments({ _id: stagedTask._id }), 0);
    assert.equal(await TaskModel.countDocuments({ _id: committedTask._id }), 1);
  });
});

describe('conversation reset', () => {
  it('keeps the first user message, clears later context, and preserves committed tasks', async () => {
    const { signToken } = await import('../src/auth/jwt.js');
    const { ConversationModel, TaskModel, UserModel } = await import('../src/models/index.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const owner = await UserModel.create({
      email: `reset-owner-${randomUUID()}@example.com`,
      passwordHash: 'unused',
    });
    const otherUser = await UserModel.create({
      email: `reset-other-${randomUUID()}@example.com`,
      passwordHash: 'unused',
    });
    const ownerId = String(owner._id);
    const conversation = await conversationService.createConversation(ownerId, 'Reusable chat');
    const proposalId = randomUUID();

    await conversationService.savePauseState(ownerId, conversation._id, {
      messages: [
        { role: 'system', content: 'You are QTask.' },
        { role: 'user', content: 'Create a draft' },
        { role: 'assistant', content: 'Ready for approval.' },
        { role: 'user', content: 'Also rename it' },
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

    const committedTask = await TaskModel.create({ userId: ownerId, title: 'Keep me' });
    const stagedTask = await TaskModel.create({
      userId: ownerId,
      title: 'Discard me',
      staging: {
        conversationId: conversation._id,
        proposalId,
        stagedAt: new Date(),
      },
    });

    const otherToken = signToken({ sub: String(otherUser._id), email: otherUser.email });
    await request(app)
      .post(`/api/conversations/${conversation._id}/reset`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    assert.equal(await ConversationModel.countDocuments({ _id: conversation._id }), 1);
    assert.equal(await TaskModel.countDocuments({ _id: stagedTask._id }), 1);

    const ownerToken = signToken({ sub: ownerId, email: owner.email });
    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/reset`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    assert.equal(response.body.discardedStagedCount, 1);
    assert.equal(response.body.conversation._id, conversation._id);
    assert.equal(response.body.conversation.title, 'Reusable chat');
    assert.equal(response.body.conversation.messages.length, 1);
    assert.equal(response.body.conversation.messages[0]?.role, 'user');
    assert.equal(response.body.conversation.messages[0]?.content, 'Create a draft');
    assert.deepEqual(response.body.conversation.pendingProposals, []);
    assert.equal(response.body.conversation.pausedBatch, null);

    const remaining = await ConversationModel.findById(conversation._id).lean();
    assert.ok(remaining);
    assert.equal(remaining.title, 'Reusable chat');
    assert.equal(remaining.messages.length, 1);
    assert.equal(remaining.messages[0]?.role, 'user');
    assert.equal(remaining.messages[0]?.content, 'Create a draft');
    assert.equal((remaining.pendingProposals ?? []).length, 0);
    assert.equal(remaining.pausedBatch, null);
    assert.equal(await TaskModel.countDocuments({ _id: stagedTask._id }), 0);
    assert.equal(await TaskModel.countDocuments({ _id: committedTask._id }), 1);
  });

  it('resets to an empty conversation when there is no user message to preserve', async () => {
    const { signToken } = await import('../src/auth/jwt.js');
    const { ConversationModel, UserModel } = await import('../src/models/index.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const owner = await UserModel.create({
      email: `reset-empty-${randomUUID()}@example.com`,
      passwordHash: 'unused',
    });
    const ownerId = String(owner._id);
    const conversation = await conversationService.createConversation(ownerId, 'Empty chat');
    await conversationService.savePauseState(ownerId, conversation._id, {
      messages: [{ role: 'system', content: 'You are QTask.' }],
      pendingProposals: [],
      pausedBatch: null,
    });

    const ownerToken = signToken({ sub: ownerId, email: owner.email });
    const response = await request(app)
      .post(`/api/conversations/${conversation._id}/reset`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    assert.equal(response.body.conversation.title, 'Empty chat');
    assert.deepEqual(response.body.conversation.messages, []);
    assert.deepEqual(response.body.conversation.pendingProposals, []);
    assert.equal(response.body.conversation.pausedBatch, null);

    const remaining = await ConversationModel.findById(conversation._id).lean();
    assert.ok(remaining);
    assert.equal(remaining.messages.length, 0);
  });
});
