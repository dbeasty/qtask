import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-agent-text-fallback-secret';

let mongo: MongoMemoryServer;
const originalFetch = globalThis.fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await mongoose.disconnect();
  await mongo.stop();
});

function ollamaToolCallResponse(toolName: string, args: Record<string, unknown>, content = '') {
  return new Response(
    [
      JSON.stringify({
        message: {
          role: 'assistant',
          content,
          tool_calls: [{ function: { name: toolName, arguments: args } }],
        },
        done: false,
      }),
      JSON.stringify({
        message: { role: 'assistant', content: '' },
        done: true,
        total_duration: 1_000_000,
        prompt_eval_count: 1,
        eval_count: 1,
      }),
      '',
    ].join('\n'),
    { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
  );
}

function ollamaTextResponse(content: string) {
  return new Response(
    [
      JSON.stringify({ message: { role: 'assistant', content }, done: false }),
      JSON.stringify({
        message: { role: 'assistant', content: '' },
        done: true,
        total_duration: 1_000_000,
        prompt_eval_count: 1,
        eval_count: 1,
      }),
      '',
    ].join('\n'),
    { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
  );
}

function ollamaEmbeddingResponse() {
  return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockOllamaAgent(handler: (callIndex: number) => Response) {
  let agentCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      return ollamaEmbeddingResponse();
    }
    if (url.includes('/api/chat')) {
      agentCalls += 1;
      return handler(agentCalls);
    }
    return new Response('unexpected fetch', { status: 500 });
  };
}

describe('parseTextToolCall helpers', () => {
  it('stripToolArtifactsFromContent removes tool JSON and markdown task blocks', async () => {
    const {
      stripToolArtifactsFromContent,
      normalizeCreateTaskTitle,
      sameStagedCreateIntent,
    } = await import('../src/agent/parseTextToolCall.js');

    const jsonBlock = JSON.stringify({
      name: 'create_task',
      parameters: { title: 'Wash the car', status: 'todo' },
    });
    const stripped = stripToolArtifactsFromContent(
      `Here is the corrected task:\n${jsonBlock}\n\nDone.`
    );
    assert.equal(stripped, 'Here is the corrected task:\n\nDone.');

    const markdown = stripToolArtifactsFromContent(
      'Please review:\n**Task:** Wash the car\n- Rinse\n- Dry'
    );
    assert.equal(markdown, 'Please review:');

    assert.equal(normalizeCreateTaskTitle('Wash the car'), 'wash the car');
    assert.equal(
      normalizeCreateTaskTitle(
        JSON.stringify({
          name: 'create_task',
          parameters: { title: 'Wash the car' },
        })
      ),
      'wash the car'
    );

    assert.equal(
      sameStagedCreateIntent(
        { name: 'create_task', arguments: { title: 'Wash the car' } },
        'create_task',
        { title: 'wash the car' }
      ),
      true
    );
  });
});

describe('agent text-fallback dedup', () => {
  it('skips duplicate text-fallback create_task when native staged create already exists', async () => {
    const { UserModel, TaskModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const user = await UserModel.create({
      email: `dedup-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    const duplicateJson = JSON.stringify({
      name: 'create_task',
      parameters: {
        title: 'Wash the car',
        description: '',
        status: 'todo',
        priority: 'low',
        subtasks: '[]',
        tags: [],
      },
    });

    mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaToolCallResponse('create_task', {
          title: 'Wash the car',
          priority: 'low',
          status: 'todo',
          subtasks: [{ title: 'Rinse car' }],
        });
      }
      return ollamaTextResponse(`Here is the corrected task:\n${duplicateJson}`);
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(userId, 'add task to wash the car')) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    const textFallbackProposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.source === 'text_fallback'
    );
    assert.equal(textFallbackProposals.length, 0);

    const conversationId = String(
      (events.find((event) => event.type === 'done') as { conversationId: string }).conversationId
    );
    const conversation = await conversationService.getConversation(userId, conversationId);
    assert.ok(conversation);

    const pendingCreates = (conversation.pendingProposals ?? []).filter(
      (proposal) => proposal.name === 'create_task' && proposal.status === 'pending'
    );
    assert.equal(pendingCreates.length, 1);
    assert.equal(await TaskModel.countDocuments({ staging: { $exists: true } }), 1);

    const assistants = conversation.messages.filter((message) => message.role === 'assistant');
    assert.ok(assistants.length >= 1);
    assert.equal(
      assistants.some((message) => message.content.includes('"create_task"')),
      false
    );
  });

  it('does not recover text-fallback proposals after content was stripped on save', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const user = await UserModel.create({
      email: `recover-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaToolCallResponse('create_task', { title: 'Wash the car' });
      }
      return ollamaTextResponse(
        `Here is the corrected task:\n${JSON.stringify({
          name: 'create_task',
          parameters: { title: 'Wash the car' },
        })}`
      );
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(userId, 'add task to wash the car')) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    const conversationId = String(
      (events.find((event) => event.type === 'done') as { conversationId: string }).conversationId
    );

    const saved = await conversationService.getConversation(userId, conversationId);
    assert.ok(saved);
    await conversationService.clearPauseState(userId, conversationId, saved.messages);

    const uiConversation = await agentService.getConversationForUi(userId, conversationId);
    assert.ok(uiConversation);
    assert.equal((uiConversation.pendingProposals ?? []).length, 0);
  });
});
