import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { registerUser } from './helpers/mcp.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-agent-api-jwt-secret';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;
const originalFetch = globalThis.fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

after(async () => {
  globalThis.fetch = originalFetch;
  const { stopEmbeddingWorker } = await import('../src/services/embeddingQueue.js');
  stopEmbeddingWorker();
  await mongoose.disconnect();
  await mongo.stop();
});

function ollamaTextResponse(content: string) {
  return new Response(
    JSON.stringify({
      message: { role: 'assistant', content },
      done: true,
      done_reason: 'stop',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** Route Ollama chat/embedding calls to canned responses; leave everything else alone. */
function mockOllama(content = 'Here is your answer.') {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/embeddings') || url.includes('/api/embed')) {
      return new Response(JSON.stringify({ embedding: new Array(768).fill(0.01) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/chat')) return ollamaTextResponse(content);
    return new Response('unexpected fetch', { status: 500 });
  }) as typeof fetch;
}

async function newUser(prefix: string) {
  return registerUser(`${prefix}-${randomUUID()}@example.com`);
}

async function newConversation(userId: string, title = 'Test conversation') {
  const { conversationService } = await import('../src/services/conversationService.js');
  return conversationService.createConversation(userId, title);
}

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((chunk) => chunk.replace(/^data: /, '').trim())
    .filter(Boolean)
    .flatMap((json) => {
      try {
        return [JSON.parse(json) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

describe('GET /api/conversations/:id', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).get(`/api/conversations/${new mongoose.Types.ObjectId()}`).expect(401);
  });

  it('returns the conversation with its UI projections', async () => {
    const { userId, jwt } = await newUser('conv-get');
    const conversation = await newConversation(userId, 'My chat');

    const res = await request(app)
      .get(`/api/conversations/${conversation._id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    assert.equal(res.body.conversation._id, String(conversation._id));
    assert.equal(res.body.conversation.title, 'My chat');
    assert.ok(Array.isArray(res.body.conversation.pendingProposals));
    assert.ok(Array.isArray(res.body.conversation.resolvedProposals));
    assert.ok(res.body.conversation.messageProposals !== undefined);
  });

  it('returns 404 for an unknown conversation', async () => {
    const { jwt } = await newUser('conv-404');
    await request(app)
      .get(`/api/conversations/${new mongoose.Types.ObjectId()}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(404);
  });

  it('returns 404 for another user conversation', async () => {
    const owner = await newUser('conv-owner');
    const stranger = await newUser('conv-stranger');
    const conversation = await newConversation(owner.userId);

    await request(app)
      .get(`/api/conversations/${conversation._id}`)
      .set('Authorization', `Bearer ${stranger.jwt}`)
      .expect(404);
  });
});

describe('POST /api/agent', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).post('/api/agent').send({ message: 'hi' }).expect(401);
  });

  it('rejects an empty or whitespace-only message with 400', async () => {
    const { jwt } = await newUser('agent-empty');

    await request(app)
      .post('/api/agent')
      .set('Authorization', `Bearer ${jwt}`)
      .send({})
      .expect(400);

    await request(app)
      .post('/api/agent')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ message: '   ' })
      .expect(400);
  });

  it('streams an SSE response and persists the exchange', async () => {
    mockOllama('Hello from the agent.');
    const { userId, jwt } = await newUser('agent-stream');
    const conversation = await newConversation(userId);

    const res = await request(app)
      .post('/api/agent')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ message: 'Hello there', conversationId: String(conversation._id) })
      .expect(200);

    assert.match(res.headers['content-type'], /text\/event-stream/);

    const events = sseEvents(res.text);
    assert.ok(events.length > 0, `expected SSE events, got: ${res.text.slice(0, 400)}`);
    assert.ok(
      events.some((e) => e.type === 'done' || e.type === 'complete' || e.type === 'error'),
      `expected a terminal event, got types: ${events.map((e) => e.type).join(', ')}`
    );

    const { conversationService } = await import('../src/services/conversationService.js');
    const saved = await conversationService.getConversation(userId, String(conversation._id));
    assert.ok(
      saved!.messages.some((m) => m.role === 'user' && String(m.content).includes('Hello there')),
      'the user turn must be persisted on the conversation'
    );
    globalThis.fetch = originalFetch;
  });
});

describe('POST /api/agent/proposals', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).post('/api/agent/proposals').send({}).expect(401);
  });

  it('requires conversationId, name and arguments', async () => {
    const { userId, jwt } = await newUser('prop-validate');
    const conversation = await newConversation(userId);

    for (const body of [
      {},
      { conversationId: String(conversation._id) },
      { conversationId: String(conversation._id), name: 'create_task' },
      { name: 'create_task', arguments: { title: 'x' } },
    ]) {
      await request(app)
        .post('/api/agent/proposals')
        .set('Authorization', `Bearer ${jwt}`)
        .send(body)
        .expect(400);
    }
  });

  it('stages a valid write-tool proposal on the conversation', async () => {
    const { userId, jwt } = await newUser('prop-create');
    const conversation = await newConversation(userId);

    const res = await request(app)
      .post('/api/agent/proposals')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        conversationId: String(conversation._id),
        name: 'create_task',
        arguments: { title: 'Proposed task' },
      })
      .expect(200);

    assert.equal(res.body.proposal.name, 'create_task');
    assert.equal(res.body.proposal.status, 'pending');
    assert.equal(res.body.proposal.source, 'manual');
    assert.equal(res.body.proposal.arguments.title, 'Proposed task');

    const read = await request(app)
      .get(`/api/conversations/${conversation._id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.equal(read.body.conversation.pendingProposals.length, 1);
  });

  it('refuses a tool that is not a write tool', async () => {
    const { userId, jwt } = await newUser('prop-readonly');
    const conversation = await newConversation(userId);

    const res = await request(app)
      .post('/api/agent/proposals')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        conversationId: String(conversation._id),
        name: 'find_tasks',
        arguments: { query: 'anything' },
      })
      .expect(400);
    assert.match(res.body.error, /not a write tool/i);
  });

  it('refuses arguments that fail the tool schema', async () => {
    const { userId, jwt } = await newUser('prop-badargs');
    const conversation = await newConversation(userId);

    await request(app)
      .post('/api/agent/proposals')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        conversationId: String(conversation._id),
        name: 'create_task',
        arguments: { notATitle: true },
      })
      .expect(400);
  });

  it('refuses a conversation the caller does not own', async () => {
    const owner = await newUser('prop-owner');
    const stranger = await newUser('prop-stranger');
    const conversation = await newConversation(owner.userId);

    const res = await request(app)
      .post('/api/agent/proposals')
      .set('Authorization', `Bearer ${stranger.jwt}`)
      .send({
        conversationId: String(conversation._id),
        name: 'create_task',
        arguments: { title: 'Not mine' },
      })
      .expect(400);
    assert.match(res.body.error, /not found/i);
  });
});

describe('POST /api/agent/approve', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app).post('/api/agent/approve').send({}).expect(401);
  });

  it('requires conversationId, proposalId and action', async () => {
    const { userId, jwt } = await newUser('approve-validate');
    const conversation = await newConversation(userId);

    for (const body of [
      {},
      { conversationId: String(conversation._id) },
      { conversationId: String(conversation._id), proposalId: 'p1' },
    ]) {
      await request(app)
        .post('/api/agent/approve')
        .set('Authorization', `Bearer ${jwt}`)
        .send(body)
        .expect(400);
    }
  });

  it('rejects an action other than approve or reject', async () => {
    const { userId, jwt } = await newUser('approve-action');
    const conversation = await newConversation(userId);

    const res = await request(app)
      .post('/api/agent/approve')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        conversationId: String(conversation._id),
        proposalId: 'p1',
        action: 'maybe',
      })
      .expect(400);
    assert.match(res.body.error, /approve or reject/i);
  });

  it('rejecting a staged proposal marks it resolved without creating the task', async () => {
    mockOllama('Acknowledged.');
    const { userId, jwt } = await newUser('approve-reject');
    const conversation = await newConversation(userId);

    const staged = await request(app)
      .post('/api/agent/proposals')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        conversationId: String(conversation._id),
        name: 'create_task',
        arguments: { title: 'Should not exist' },
      })
      .expect(200);

    const res = await request(app)
      .post('/api/agent/approve')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        conversationId: String(conversation._id),
        proposalId: staged.body.proposal.id,
        action: 'reject',
      })
      .expect(200);
    assert.match(res.headers['content-type'], /text\/event-stream/);

    const read = await request(app)
      .get(`/api/conversations/${conversation._id}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.equal(read.body.conversation.pendingProposals.length, 0, 'must no longer be pending');

    const tasks = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    assert.ok(
      !tasks.body.tasks.some((t: { title: string }) => t.title === 'Should not exist'),
      'a rejected proposal must not create the task'
    );
    globalThis.fetch = originalFetch;
  });
});
