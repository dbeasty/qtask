import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-agent-create-preflight-secret';

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

async function defaultProjectId(userId: string): Promise<string> {
  const { projectService } = await import('../src/services/projectService.js');
  return projectService.ensureDefaultProject(userId);
}

describe('create-task preflight', () => {
  it('auto-stages immediately without entering LLM tool loop', async () => {
    const { UserModel, TaskModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const user = await UserModel.create({
      email: `preflight-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const projectId = await defaultProjectId(userId);

    let llmCalls = 0;
    mockOllamaAgent(() => {
      llmCalls += 1;
      return ollamaTextResponse('This should not run.');
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'Add a task to Advertise on Local Facebook',
      undefined,
      projectId
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(llmCalls, 0);
    assert.equal(events.some((event) => event.type === 'status'), false);

    const createProposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_task'
    );
    assert.equal(createProposals.length, 1);
    assert.equal(
      (createProposals[0] as { arguments: { title: string; projectId: string } }).arguments.title,
      'Advertise on Local Facebook'
    );
    assert.equal(
      (createProposals[0] as { arguments: { title: string; projectId: string } }).arguments
        .projectId,
      projectId
    );

    const done = events.find((event) => event.type === 'done') as {
      paused?: boolean;
      conversationId: string;
    };
    assert.ok(done?.paused);

    const conversation = await conversationService.getConversation(userId, done.conversationId);
    assert.ok(conversation);
    assert.equal(
      await TaskModel.countDocuments({ userId, staging: { $exists: true } }),
      1
    );
    assert.ok(
      conversation.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.includes('Staged task "Advertise on Local Facebook"')
      )
    );
  });

  it('skips auto-stage for exact duplicate in active project', async () => {
    const { UserModel, TaskModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { taskService } = await import('../src/services/taskService.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const user = await UserModel.create({
      email: `dup-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const projectId = await defaultProjectId(userId);

    await taskService.createTask(
      userId,
      { title: 'Advertise on Local Facebook', projectId },
      'user'
    );

    let llmCalls = 0;
    mockOllamaAgent(() => {
      llmCalls += 1;
      return ollamaTextResponse('Should not run.');
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'Add a task to Advertise on Local Facebook',
      undefined,
      projectId
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(llmCalls, 0);
    assert.equal(
      events.filter((event) => event.type === 'tool_proposal' && event.name === 'create_task')
        .length,
      0
    );

    const findResults = events.filter(
      (event) => event.type === 'tool_result' && event.name === 'find_tasks'
    );
    assert.equal(findResults.length, 1);
    const entityLinks = (findResults[0] as { entityLinks?: unknown[] }).entityLinks ?? [];
    assert.ok(entityLinks.length >= 1);

    const conversationId = String(
      (events.find((event) => event.type === 'done') as { conversationId: string }).conversationId
    );
    const conversation = await conversationService.getConversation(userId, conversationId);
    assert.ok(
      conversation?.messages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('already exists in the active project')
      )
    );
    assert.equal(
      await TaskModel.countDocuments({ userId, staging: { $exists: true } }),
      0
    );
  });

  it('does not block on similar task in a different project', async () => {
    const { UserModel, TaskModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { taskService } = await import('../src/services/taskService.js');
    const { projectService } = await import('../src/services/projectService.js');

    const user = await UserModel.create({
      email: `cross-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const projectA = await defaultProjectId(userId);
    const projectBDoc = await projectService.createProject(userId, 'Project B');
    const projectB = String(projectBDoc._id);

    await taskService.createTask(
      userId,
      { title: 'Put advertisement on Barnstormers', projectId: projectA },
      'user'
    );

    mockOllamaAgent(() => ollamaTextResponse('Should not run.'));

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'Add a task to Advertise on Orcas Buy and Sell Facebook',
      undefined,
      projectB
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    const createProposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_task'
    );
    assert.equal(createProposals.length, 1);
    assert.equal(
      (createProposals[0] as { arguments: { title: string } }).arguments.title,
      'Advertise on Orcas Buy and Sell Facebook'
    );

    const findResults = events.filter(
      (event) => event.type === 'tool_result' && event.name === 'find_tasks'
    );
    for (const result of findResults) {
      const links = (result as { entityLinks?: Array<{ label: string }> }).entityLinks ?? [];
      assert.ok(!links.some((link) => link.label === 'Put advertisement on Barnstormers'));
    }

    assert.equal(
      await TaskModel.countDocuments({ userId, staging: { $exists: true } }),
      1
    );
  });

  it('does not run preflight for multi-create requests', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');

    const user = await UserModel.create({
      email: `multi-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const projectId = await defaultProjectId(userId);

    mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaToolCallResponse('create_task', { title: 'Task A', projectId });
      }
      return ollamaTextResponse('Adding the rest.');
    });

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'Add tasks: A, B, and C',
      undefined,
      projectId
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    const preflightFind = events.filter(
      (event) => event.type === 'tool_call' && event.name === 'find_tasks'
    );
    assert.equal(preflightFind.length, 0);
  });
});
