import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-agent-multi-create-secret';

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

function ollamaMultiToolCallResponse(
  tools: Array<{ name: string; arguments: Record<string, unknown> }>,
  content = ''
) {
  return new Response(
    [
      JSON.stringify({
        message: {
          role: 'assistant',
          content,
          tool_calls: tools.map((tool) => ({ function: tool })),
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
  return {
    getAgentCalls: () => agentCalls,
  };
}

describe('native multi create_task in one response', () => {
  it('stages two distinct create_task proposals without pausing mid-batch', async () => {
    const { UserModel, TaskModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const user = await UserModel.create({
      email: `multi-native-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaMultiToolCallResponse([
          { name: 'create_task', arguments: { title: 'Change the oil filter' } },
          { name: 'create_task', arguments: { title: 'Wash the car' } },
        ]);
      }
      return ollamaTextResponse('Both tasks are ready for approval.');
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'add following tasks change the oil filter, wash the car'
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    const proposals = events.filter((event) => event.type === 'tool_proposal');
    assert.equal(proposals.length, 2);
    assert.equal(events.some((event) => event.type === 'paused'), true);

    const conversationId = String(
      (events.find((event) => event.type === 'done') as { conversationId: string }).conversationId
    );
    const conversation = await conversationService.getConversation(userId, conversationId);
    assert.ok(conversation);

    const pendingCreates = (conversation.pendingProposals ?? []).filter(
      (proposal) => proposal.name === 'create_task' && proposal.status === 'pending'
    );
    assert.equal(pendingCreates.length, 2);
    assert.equal(await TaskModel.countDocuments({ userId, staging: { $exists: true } }), 2);
  });
});

describe('multi-task user prompt — partial native + turn-2 fallback', () => {
  it('adds a second task via text fallback when turn 2 proposes a different title', async () => {
    const { UserModel, TaskModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const user = await UserModel.create({
      email: `partial-fallback-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    const oilFilterJson = JSON.stringify({
      name: 'create_task',
      parameters: { title: 'Change the oil filter', status: 'todo' },
    });

    mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaToolCallResponse('create_task', { title: 'Wash the car' });
      }
      if (callIndex === 2) {
        return ollamaTextResponse(`Here is the corrected task:\n${oilFilterJson}`);
      }
      return ollamaTextResponse('Both tasks are ready for approval.');
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'add following tasks change the oil filter, wash the car'
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    const conversationId = String(
      (events.find((event) => event.type === 'done') as { conversationId: string }).conversationId
    );
    const conversation = await conversationService.getConversation(userId, conversationId);
    assert.ok(conversation);

    const pendingCreates = (conversation.pendingProposals ?? []).filter(
      (proposal) => proposal.name === 'create_task' && proposal.status === 'pending'
    );
    assert.equal(pendingCreates.length, 2);

    const titles = pendingCreates
      .map((proposal) => String(proposal.arguments.title ?? '').toLowerCase())
      .sort();
    assert.deepEqual(titles, ['change the oil filter', 'wash the car']);

    const textFallback = pendingCreates.filter((proposal) => proposal.source === 'text_fallback');
    assert.equal(textFallback.length, 1);
    assert.equal(textFallback[0]?.arguments.title, 'Change the oil filter');
    assert.equal(await TaskModel.countDocuments({ userId, staging: { $exists: true } }), 2);
  });

  it('warns and skips duplicate text-fallback create_task on turn 2', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const user = await UserModel.create({
      email: `duplicate-warn-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    const duplicateJson = JSON.stringify({
      name: 'create_task',
      parameters: { title: 'Wash the car', status: 'todo' },
    });

    mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaToolCallResponse('create_task', { title: 'Wash the car' });
      }
      return ollamaTextResponse(`Here is the corrected task:\n${duplicateJson}`);
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'add following tasks change the oil filter, wash the car'
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(
      events.some((event) => event.type === 'warning' && String(event.message).includes('duplicate')),
      true
    );

    const conversationId = String(
      (events.find((event) => event.type === 'done') as { conversationId: string }).conversationId
    );
    const conversation = await conversationService.getConversation(userId, conversationId);
    assert.ok(conversation);

    const pendingCreates = (conversation.pendingProposals ?? []).filter(
      (proposal) => proposal.name === 'create_task' && proposal.status === 'pending'
    );
    assert.equal(pendingCreates.length, 1);
  });

  it('nudges the model when only one of two requested tasks was proposed', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const user = await UserModel.create({
      email: `multi-nudge-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    const mock = mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaToolCallResponse('create_task', { title: 'Wash the car' });
      }
      if (callIndex === 2) {
        return ollamaToolCallResponse('create_task', { title: 'Change the oil filter' });
      }
      return ollamaTextResponse('Both tasks are ready for approval.');
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'add following tasks change the oil filter, wash the car'
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(
      events.some(
        (event) =>
          event.type === 'warning' &&
          String(event.message).includes('Only 1 of 2 requested tasks was proposed')
      ),
      true
    );
    assert.equal(mock.getAgentCalls(), 2);

    const conversationId = String(
      (events.find((event) => event.type === 'done') as { conversationId: string }).conversationId
    );
    const conversation = await conversationService.getConversation(userId, conversationId);
    assert.ok(conversation);

    const pendingCreates = (conversation.pendingProposals ?? []).filter(
      (proposal) => proposal.name === 'create_task' && proposal.status === 'pending'
    );
    assert.equal(pendingCreates.length, 2);
  });
});

describe('approval sequencing for multiple staged creates', () => {
  it('approves two staged creates sequentially and commits both tasks', async () => {
    const { UserModel, TaskModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');
    const { taskService } = await import('../src/services/taskService.js');

    const user = await UserModel.create({
      email: `approve-two-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaMultiToolCallResponse([
          { name: 'create_task', arguments: { title: 'Change the oil filter' } },
          { name: 'create_task', arguments: { title: 'Wash the car' } },
        ]);
      }
      return ollamaTextResponse('Both tasks are ready for approval.');
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'add following tasks change the oil filter, wash the car'
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    const conversationId = String(
      (events.find((event) => event.type === 'done') as { conversationId: string }).conversationId
    );
    const conversation = await conversationService.getConversation(userId, conversationId);
    assert.ok(conversation);

    const pending = (conversation.pendingProposals ?? []).filter(
      (proposal) => proposal.status === 'pending'
    );
    assert.equal(pending.length, 2);

    const first = pending[0]!;
    mockOllamaAgent(() => ollamaTextResponse('Both tasks are ready for approval.'));
    const resumeEvents1: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.resumeAfterApproval(
      userId,
      conversationId,
      first.id,
      'approve'
    )) {
      resumeEvents1.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(
      resumeEvents1.some((event) => event.type === 'paused' && event.pendingCount === 1),
      true
    );

    const afterFirst = await conversationService.getConversation(userId, conversationId);
    assert.ok(afterFirst);
    const remaining = (afterFirst.pendingProposals ?? []).filter(
      (proposal) => proposal.status === 'pending'
    );
    assert.equal(remaining.length, 1);

    const second = remaining[0]!;
    mockOllamaAgent(() => ollamaTextResponse('Done.'));
    for await (const _event of agentService.resumeAfterApproval(
      userId,
      conversationId,
      second.id,
      'approve'
    )) {
      // drain
    }

    const tasks = await taskService.listTasks(userId);
    assert.equal(tasks.length, 2);
    assert.equal(await TaskModel.countDocuments({ userId, staging: { $exists: true } }), 0);
  });
});

describe('parseTextToolCalls multi create', () => {
  it('extracts two JSON create_task objects from one message', async () => {
    const { parseTextToolCalls } = await import('../src/agent/parseTextToolCall.js');

    const content = [
      JSON.stringify({
        name: 'create_task',
        parameters: { title: 'Change the oil filter' },
      }),
      JSON.stringify({
        name: 'create_task',
        parameters: { title: 'Wash the car' },
      }),
    ].join('\n');

    const parsed = parseTextToolCalls(content);
    assert.equal(parsed.length, 2);
    const titles = parsed.map((item) => item.arguments.title).sort();
    assert.deepEqual(titles, ['Change the oil filter', 'Wash the car']);
  });
});

describe('estimateRequestedCreateCount', () => {
  it('counts comma-separated tasks in a multi-task user message', async () => {
    const { estimateRequestedCreateCount } = await import('../src/agent/multiCreateHeuristic.js');

    assert.equal(
      estimateRequestedCreateCount('add following tasks change the oil filter, wash the car'),
      2
    );
  });
});
