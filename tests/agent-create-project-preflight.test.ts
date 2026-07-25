import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-agent-create-project-preflight-secret';

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

function mockOllamaAgent() {
  let agentCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/chat')) {
      agentCalls += 1;
      return ollamaTextResponse('Should not run.');
    }
    return new Response('unexpected fetch', { status: 500 });
  };
  return () => agentCalls;
};

async function defaultProjectId(userId: string): Promise<string> {
  const { projectService } = await import('../src/services/projectService.js');
  return projectService.ensureDefaultProject(userId);
}

describe('create-project preflight', () => {
  it('auto-stages root project without LLM loop', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');

    const user = await UserModel.create({
      email: `root-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const projectId = await defaultProjectId(userId);
    const getLlmCalls = mockOllamaAgent();

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'create project Q1 Launch',
      undefined,
      projectId
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(getLlmCalls(), 0);
    const createProposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_project'
    );
    assert.equal(createProposals.length, 1);
    assert.equal(
      (createProposals[0] as { arguments: { name: string } }).arguments.name,
      'Q1 Launch'
    );

    const done = events.find((event) => event.type === 'done') as { conversationId: string };
    const conversation = await conversationService.getConversation(userId, done.conversationId);
    assert.ok(conversation);
  });

  it('blocks exact duplicate root project name', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { projectService } = await import('../src/services/projectService.js');

    const user = await UserModel.create({
      email: `root-dup-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const projectId = await defaultProjectId(userId);
    await projectService.createProject(userId, 'Q1 Launch');

    const getLlmCalls = mockOllamaAgent();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'create project Q1 Launch',
      undefined,
      projectId
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(getLlmCalls(), 0);
    assert.equal(
      events.filter((event) => event.type === 'tool_proposal' && event.name === 'create_project')
        .length,
      0
    );
    assert.ok(
      events.some(
        (event) => event.type === 'tool_result' && event.name === 'list_projects'
      )
    );
  });

  it('blocks exact duplicate sub-project among siblings', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { projectService } = await import('../src/services/projectService.js');

    const user = await UserModel.create({
      email: `sub-dup-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const parentId = await defaultProjectId(userId);
    await projectService.createProject(userId, 'Engine work', undefined, undefined, parentId);

    const getLlmCalls = mockOllamaAgent();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'create sub-project Engine work',
      undefined,
      parentId
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(getLlmCalls(), 0);
    assert.equal(
      events.filter((event) => event.type === 'tool_proposal' && event.name === 'create_project')
        .length,
      0
    );
  });

  it('does not flag sub-project duplicate from a different parent', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { projectService } = await import('../src/services/projectService.js');

    const user = await UserModel.create({
      email: `sub-scope-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const parentA = await defaultProjectId(userId);
    const parentBDoc = await projectService.createProject(userId, 'Boat');
    const parentB = String(parentBDoc._id);
    await projectService.createProject(userId, 'Engine work', undefined, undefined, parentA);

    const getLlmCalls = mockOllamaAgent();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'create sub-project Engine work',
      undefined,
      parentB
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(getLlmCalls(), 0);
    const createProposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_project'
    );
    assert.equal(createProposals.length, 1);
    assert.equal(
      (createProposals[0] as { arguments: { name: string; parentId: string } }).arguments.parentId,
      parentB
    );
  });

  it('does not emit list_projects when no similar existing projects', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { projectService } = await import('../src/services/projectService.js');

    const user = await UserModel.create({
      email: `no-similar-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const projectId = await defaultProjectId(userId);
    await projectService.createProject(userId, 'Boat');
    await projectService.createProject(userId, 'Sell Airplane');
    await projectService.createProject(userId, 'Fix the HVAC');

    const getLlmCalls = mockOllamaAgent();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'create project Volvo',
      undefined,
      projectId
    )) {
      events.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(getLlmCalls(), 0);
    assert.equal(
      events.filter((event) => event.type === 'tool_proposal' && event.name === 'create_project')
        .length,
      1
    );
    assert.equal(
      events.filter((event) => event.type === 'tool_result' && event.name === 'list_projects')
        .length,
      0
    );
    const createResult = events.find(
      (event) => event.type === 'tool_result' && event.name === 'create_project'
    ) as { entityLinks?: unknown[] } | undefined;
    assert.equal(createResult?.entityLinks, undefined);
  });

  it('commits staged project without running the LLM and exposes a project link', async () => {
    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');
    const { buildMessageToolResults } = await import('../src/utils/toolEntityLinks.js');

    const user = await UserModel.create({
      email: `commit-volvo-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const projectId = await defaultProjectId(userId);

    const getLlmCalls = mockOllamaAgent();
    const stageEvents: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'create project Volvo',
      undefined,
      projectId
    )) {
      stageEvents.push(event as { type: string; [key: string]: unknown });
    }

    const conversationId = String(
      (stageEvents.find((event) => event.type === 'done') as { conversationId: string }).conversationId
    );
    const conversation = await conversationService.getConversation(userId, conversationId);
    const proposal = conversation?.pendingProposals?.find(
      (entry) => entry.name === 'create_project' && entry.status === 'pending'
    );
    assert.ok(proposal);

    const getResumeLlmCalls = mockOllamaAgent();
    const resumeEvents: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.resumeAfterApproval(
      userId,
      conversationId,
      proposal.id,
      'approve'
    )) {
      resumeEvents.push(event as { type: string; [key: string]: unknown });
    }

    assert.equal(getLlmCalls(), 0);
    assert.equal(getResumeLlmCalls(), 0);
    assert.equal(resumeEvents.some((event) => event.type === 'status'), false);

    const commitResult = resumeEvents.find(
      (event) => event.type === 'tool_result' && event.name === 'create_project' && event.success
    ) as { entityLinks?: Array<{ label: string }> } | undefined;
    assert.ok(commitResult?.entityLinks?.some((link) => link.label === 'Volvo'));

    const uiConversation = await agentService.getConversationForUi(userId, conversationId);
    assert.ok(uiConversation);
    const enrichments = buildMessageToolResults(uiConversation.messages);
    const projectLinks = Object.values(enrichments)
      .flat()
      .flatMap((entry) => entry.entityLinks ?? [])
      .filter((link) => link.kind === 'project' && link.label === 'Volvo');
    assert.equal(projectLinks.length, 1);
  });
});
