import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-chat-recovery-secret';

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

function mockOllamaChat(handler: (callIndex: number) => Response) {
  let chatCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      return ollamaEmbeddingResponse();
    }
    if (url.includes('/api/chat')) {
      chatCalls += 1;
      return handler(chatCalls);
    }
    return new Response('unexpected fetch', { status: 500 });
  };
}

describe('chat update_task id recovery', () => {
  it('revalidates stale invalid approvals, runs find_tasks, and emits a fresh update proposal', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { taskService } = await import('../src/services/taskService.js');
    const { conversationService } = await import('../src/services/conversationService.js');
    const { chatService } = await import('../src/services/chatService.js');

    const user = await UserModel.create({
      email: `recovery-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    const task = await taskService.createTask(userId, { title: 'Test the Boar' }, 'user');
    const taskId = String(task._id);

    const conversation = await conversationService.createConversation(userId, 'Rename task');
    const proposalId = randomUUID();

    await conversationService.savePauseState(userId, conversation._id, {
      messages: [
        { role: 'system', content: 'You are QTask.' },
        { role: 'user', content: 'Rename Test the Boar to Test the Boat' },
        {
          role: 'assistant',
          content: 'I will update the title.',
          toolCalls: [
            {
              function: {
                name: 'update_task',
                arguments: { taskId: '1234567890abcdef', title: 'Test the Boat' },
              },
            },
          ],
        },
      ],
      pendingProposals: [
        {
          id: proposalId,
          name: 'update_task',
          arguments: { taskId: '1234567890abcdef', title: 'Test the Boat' },
          source: 'native',
          status: 'pending',
          toolCallIndex: 0,
        },
      ],
      pausedBatch: {
        assistantContent: 'I will update the title.',
        toolCalls: [
          {
            function: {
              name: 'update_task',
              arguments: { taskId: '1234567890abcdef', title: 'Test the Boat' },
            },
          },
        ],
        nextToolIndex: 0,
      },
    });

    mockOllamaChat((callIndex) => {
      if (callIndex === 1) {
        return ollamaToolCallResponse('update_task', {
          taskId,
          title: 'Test the Boat',
        });
      }
      return ollamaTextResponse('Updated the title to Test the Boat.');
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of chatService.resumeAfterApproval(
      userId,
      conversation._id,
      proposalId,
      'approve'
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    const updateCalls = events.filter(
      (e) => e.type === 'tool_call' && e.name === 'update_task'
    );
    const findCalls = events.filter((e) => e.type === 'tool_call' && e.name === 'find_tasks');
    const updateFailures = events.filter(
      (e) => e.type === 'tool_result' && e.name === 'update_task' && e.success === false
    );
    const proposals = events.filter((e) => e.type === 'tool_proposal' && e.name === 'update_task');

    assert.equal(updateCalls.length >= 1, true);
    assert.equal(findCalls.length, 1);
    assert.equal(updateFailures.length >= 1, true);
    assert.equal(proposals.length, 1);
    assert.deepEqual((proposals[0] as { arguments: Record<string, unknown> }).arguments, {
      taskId,
      title: 'Test the Boat',
    });

    // Original task must not have been mutated by the invalid approval.
    const stillOriginal = await taskService.getTask(userId, taskId);
    assert.ok(stillOriginal);
    assert.equal(stillOriginal.title, 'Test the Boar');

    const after = await conversationService.getConversation(userId, conversation._id);
    assert.ok(after);
    // Corrected update_task should pause again for a new approval card.
    assert.ok(after.pausedBatch);
    assert.equal(
      after.pausedBatch.toolCalls[0]?.function.arguments.taskId,
      taskId
    );
    const resolved = after.pendingProposals?.find((p) => p.id === proposalId);
    assert.equal(resolved?.status, 'approved');
    const pending = (after.pendingProposals ?? []).filter((p) => p.status === 'pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.arguments.taskId, taskId);
  });

  it('does not silently update when find_tasks matches multiple tasks', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { taskService } = await import('../src/services/taskService.js');
    const { conversationService } = await import('../src/services/conversationService.js');
    const { chatService } = await import('../src/services/chatService.js');

    const user = await UserModel.create({
      email: `multi-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    const a = await taskService.createTask(userId, { title: 'Boat prep A' }, 'user');
    const b = await taskService.createTask(userId, { title: 'Boat prep B' }, 'user');

    const conversation = await conversationService.createConversation(userId, 'Ambiguous');
    const proposalId = randomUUID();

    await conversationService.savePauseState(userId, conversation._id, {
      messages: [
        { role: 'user', content: 'Rename the Boat prep task to Ready' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              function: {
                name: 'update_task',
                arguments: { taskId: 'not-a-real-id', title: 'Ready' },
              },
            },
          ],
        },
      ],
      pendingProposals: [
        {
          id: proposalId,
          name: 'update_task',
          arguments: { taskId: 'not-a-real-id', title: 'Ready' },
          source: 'native',
          status: 'pending',
          toolCallIndex: 0,
        },
      ],
      pausedBatch: null,
    });

    mockOllamaChat(() =>
      ollamaTextResponse(
        'I found two matching tasks (Boat prep A and Boat prep B). Which one should I rename?'
      )
    );

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of chatService.resumeAfterApproval(
      userId,
      conversation._id,
      proposalId,
      'approve'
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(
      events.some((e) => e.type === 'tool_call' && e.name === 'find_tasks'),
      true
    );
    assert.equal(
      events.some((e) => e.type === 'tool_proposal' && e.name === 'update_task'),
      false
    );

    const taskA = await taskService.getTask(userId, String(a._id));
    const taskB = await taskService.getTask(userId, String(b._id));
    assert.equal(taskA?.title, 'Boat prep A');
    assert.equal(taskB?.title, 'Boat prep B');
  });

  it('keeps the normal one-approval flow for valid update_task proposals', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { taskService } = await import('../src/services/taskService.js');
    const { conversationService } = await import('../src/services/conversationService.js');
    const { chatService } = await import('../src/services/chatService.js');

    const user = await UserModel.create({
      email: `valid-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    const task = await taskService.createTask(userId, { title: 'Original' }, 'user');
    const taskId = String(task._id);

    const conversation = await conversationService.createConversation(userId, 'Valid update');
    const proposalId = randomUUID();

    await conversationService.savePauseState(userId, conversation._id, {
      messages: [
        { role: 'user', content: 'Rename Original to Updated' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              function: {
                name: 'update_task',
                arguments: { taskId, title: 'Updated' },
              },
            },
          ],
        },
      ],
      pendingProposals: [
        {
          id: proposalId,
          name: 'update_task',
          arguments: { taskId, title: 'Updated' },
          source: 'native',
          status: 'pending',
          toolCallIndex: 0,
        },
      ],
      pausedBatch: {
        assistantContent: '',
        toolCalls: [
          {
            function: {
              name: 'update_task',
              arguments: { taskId, title: 'Updated' },
            },
          },
        ],
        nextToolIndex: 0,
      },
    });

    mockOllamaChat(() => ollamaTextResponse('Done — renamed to Updated.'));

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of chatService.resumeAfterApproval(
      userId,
      conversation._id,
      proposalId,
      'approve'
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(
      events.some((e) => e.type === 'tool_call' && e.name === 'find_tasks'),
      false
    );
    assert.equal(
      events.some((e) => e.type === 'tool_result' && e.name === 'update_task' && e.success === true),
      true
    );

    const updated = await taskService.getTask(userId, taskId);
    assert.equal(updated?.title, 'Updated');
  });

  it('recovers when a well-formed taskId is not found', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { taskService } = await import('../src/services/taskService.js');
    const { conversationService } = await import('../src/services/conversationService.js');
    const { chatService } = await import('../src/services/chatService.js');

    const user = await UserModel.create({
      email: `missing-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);

    const task = await taskService.createTask(userId, { title: 'Find me' }, 'user');
    const realId = String(task._id);
    const missingId = '507f1f77bcf86cd799439099';

    const conversation = await conversationService.createConversation(userId, 'Missing id');
    const proposalId = randomUUID();

    await conversationService.savePauseState(userId, conversation._id, {
      messages: [
        { role: 'user', content: 'Rename Find me to Found' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              function: {
                name: 'update_task',
                arguments: { taskId: missingId, title: 'Found' },
              },
            },
          ],
        },
      ],
      pendingProposals: [
        {
          id: proposalId,
          name: 'update_task',
          arguments: { taskId: missingId, title: 'Found' },
          source: 'native',
          status: 'pending',
          toolCallIndex: 0,
        },
      ],
      pausedBatch: null,
    });

    mockOllamaChat((callIndex) => {
      if (callIndex === 1) {
        return ollamaToolCallResponse('update_task', { taskId: realId, title: 'Found' });
      }
      return ollamaTextResponse('Ready for approval.');
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of chatService.resumeAfterApproval(
      userId,
      conversation._id,
      proposalId,
      'approve'
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(
      events.some((e) => e.type === 'tool_result' && e.name === 'update_task' && e.success === false),
      true
    );
    assert.equal(
      events.some((e) => e.type === 'tool_call' && e.name === 'find_tasks'),
      true
    );
    const proposal = events.find((e) => e.type === 'tool_proposal' && e.name === 'update_task') as
      | { arguments: { taskId: string } }
      | undefined;
    assert.ok(proposal);
    assert.equal(proposal.arguments.taskId, realId);

    const unchanged = await taskService.getTask(userId, realId);
    assert.equal(unchanged?.title, 'Find me');
  });
});
