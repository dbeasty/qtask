import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import {
  AGENT_INSTRUCTIONS,
  instructionById,
  type AgentInstruction,
} from './fixtures/agentInstructions.ts';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-agent-instructions-secret';

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

function agentResponse(content: string, tool?: { name: string; arguments: Record<string, unknown> }) {
  return new Response(
    [
      JSON.stringify({
        message: {
          role: 'assistant',
          content,
          tool_calls: tool ? [{ function: tool }] : undefined,
        },
        done: false,
      }),
      JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }),
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
  return () => agentCalls;
}

function mockOllamaAgentWithBody(handler: (callIndex: number, init?: RequestInit) => Response) {
  let agentCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      return ollamaEmbeddingResponse();
    }
    if (url.includes('/api/chat')) {
      agentCalls += 1;
      return handler(agentCalls, init);
    }
    return new Response('unexpected fetch', { status: 500 });
  };
  return () => agentCalls;
}

function mockOllamaTextOnly() {
  return mockOllamaAgent(() => ollamaTextResponse('Done.'));
}

async function defaultProjectId(userId: string): Promise<string> {
  const { projectService } = await import('../src/services/projectService.js');
  return projectService.ensureDefaultProject(userId);
}

async function createTestUser() {
  const { UserModel } = await import('../src/models/index.js');
  const user = await UserModel.create({
    email: `instructions-${randomUUID()}@example.com`,
    passwordHash: 'unused',
    emailVerified: true,
  });
  return String(user._id);
}

async function collectStream(
  userId: string,
  message: string,
  conversationId?: string,
  projectId?: string
) {
  const { agentService } = await import('../src/services/agentService.js');
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of agentService.streamAgent(userId, message, conversationId, projectId)) {
    events.push(event as { type: string; [key: string]: unknown });
  }
  return events;
}

async function approveFirstProposal(userId: string, events: Array<{ type: string; [key: string]: unknown }>) {
  const { agentService } = await import('../src/services/agentService.js');
  const { conversationService } = await import('../src/services/conversationService.js');
  const done = events.find((event) => event.type === 'done') as { conversationId: string };
  const conversation = await conversationService.getConversation(userId, done.conversationId);
  const proposal = conversation?.pendingProposals?.find((entry) => entry.status === 'pending');
  assert.ok(proposal);
  mockOllamaAgent(() => ollamaTextResponse('Approved.'));
  for await (const _event of agentService.resumeAfterApproval(
    userId,
    done.conversationId,
    proposal.id,
    'approve'
  )) {
    // drain
  }
  return { conversationId: done.conversationId, proposal };
}

function allCatalogPhrases(instruction: AgentInstruction): string[] {
  const phrases = [instruction.example];
  if (instruction.steps) {
    for (const step of instruction.steps) {
      if (!phrases.includes(step)) phrases.push(step);
    }
  }
  return phrases;
}

describe('agent instruction integration — read preflight', () => {
  const readInstructions = AGENT_INSTRUCTIONS.filter(
    (entry) =>
      entry.route === 'preflight' &&
      ['get_project', 'list_projects', 'find_tasks'].includes(entry.expectedTool)
  );

  for (const instruction of readInstructions) {
    it(`${instruction.id} runs ${instruction.expectedTool} before the LLM loop`, async () => {
      const userId = await createTestUser();
      const projectId = await defaultProjectId(userId);
      const { taskService } = await import('../src/services/taskService.js');

      if (instruction.expectedTool === 'find_tasks') {
        await taskService.createTask(
          userId,
          { title: 'Seed task', projectId },
          'user'
        );
      }

      const getLlmCalls = mockOllamaTextOnly();
      const events = await collectStream(
        userId,
        instruction.example,
        undefined,
        projectId
      );

      assert.ok(
        events.some(
          (event) =>
            event.type === 'tool_call' &&
            event.name === instruction.expectedTool &&
            event.success !== false
        )
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === 'tool_result' &&
            event.name === instruction.expectedTool &&
            event.success === true
        )
      );
      assert.equal(getLlmCalls(), 1);
    });
  }
});

describe('agent instruction integration — write preflight', () => {
  it('create-project auto-stages without LLM', async () => {
    const instruction = instructionById('create-project');
    const userId = await createTestUser();
    const projectId = await defaultProjectId(userId);
    const getLlmCalls = mockOllamaTextOnly();

    const events = await collectStream(userId, instruction.example, undefined, projectId);

    assert.equal(getLlmCalls(), 0);
    const proposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_project'
    );
    assert.equal(proposals.length, 1);
    assert.equal(
      (proposals[0] as { arguments: { name: string } }).arguments.name,
      'Kitchen Reno'
    );
  });

  it('create-subproject auto-stages with parentId', async () => {
    const instruction = instructionById('create-subproject');
    const userId = await createTestUser();
    const parentId = await defaultProjectId(userId);
    const getLlmCalls = mockOllamaTextOnly();

    const events = await collectStream(userId, instruction.example, undefined, parentId);

    assert.equal(getLlmCalls(), 0);
    const proposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_project'
    );
    assert.equal(proposals.length, 1);
    assert.equal(
      (proposals[0] as { arguments: { name: string; parentId: string } }).arguments.parentId,
      parentId
    );
    assert.equal(
      (proposals[0] as { arguments: { name: string } }).arguments.name,
      'Electrical'
    );
  });

  it('add-task auto-stages without LLM', async () => {
    const instruction = instructionById('add-task');
    const userId = await createTestUser();
    const projectId = await defaultProjectId(userId);
    const getLlmCalls = mockOllamaTextOnly();

    const events = await collectStream(userId, instruction.example, undefined, projectId);

    assert.equal(getLlmCalls(), 0);
    const proposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_task'
    );
    assert.equal(proposals.length, 1);
    assert.equal(
      (proposals[0] as { arguments: { title: string; projectId: string } }).arguments.title,
      'Schedule inspection'
    );
    assert.equal(
      (proposals[0] as { arguments: { title: string; projectId: string } }).arguments.projectId,
      projectId
    );
  });
});

describe('agent instruction integration — modify task', () => {
  it('modify-task produces an update_task proposal', async () => {
    const instruction = instructionById('modify-task');
    const userId = await createTestUser();
    const projectId = await defaultProjectId(userId);
    const { taskService } = await import('../src/services/taskService.js');
    const task = await taskService.createTask(
      userId,
      { title: 'Schedule inspection', projectId },
      'user'
    );
    const taskId = String(task._id);

    mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaToolCallResponse('update_task', { taskId, status: 'done' });
      }
      return ollamaTextResponse('Marked Schedule inspection as done.');
    });

    const events = await collectStream(userId, instruction.example, undefined, projectId);
    const proposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'update_task'
    );
    assert.equal(proposals.length, 1);
    assert.equal(
      (proposals[0] as { arguments: { taskId: string; status: string } }).arguments.taskId,
      taskId
    );
    assert.equal(
      (proposals[0] as { arguments: { taskId: string; status: string } }).arguments.status,
      'done'
    );
  });
});

describe('agent instruction integration — compound one-turn', () => {
  it('create-project-with-subproject-single stages root then sub-project', async () => {
    const instruction = instructionById('create-project-with-subproject-single');
    const userId = await createTestUser();
    await defaultProjectId(userId);

    const getLlmCalls = mockOllamaAgentWithBody((callIndex, init) => {
      if (callIndex === 1) {
        return agentResponse('', { name: 'create_project', arguments: { name: 'Boat' } });
      }
      if (callIndex === 2) {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string; tool_name?: string }>;
        };
        const projectResult = [...body.messages]
          .reverse()
          .find((message) => message.role === 'tool' && message.tool_name === 'create_project');
        assert.ok(projectResult);
        const parentId = (JSON.parse(projectResult.content.split('\n\nSTAGED:')[0]!) as { _id: string })
          ._id;
        return agentResponse('', {
          name: 'create_project',
          arguments: { name: 'Engine work', parentId },
        });
      }
      return agentResponse('Both projects are staged.');
    });

    const events = await collectStream(userId, instruction.example);
    const proposals = events.filter((event) => event.type === 'tool_proposal');
    assert.equal(proposals.length, 2);
    assert.equal(getLlmCalls(), 3);
    assert.ok(events.some((event) => event.type === 'paused'));
  });

  it('create-project-with-tasks-single stages project then tasks', async () => {
    const instruction = instructionById('create-project-with-tasks-single');
    const userId = await createTestUser();
    await defaultProjectId(userId);

    const getLlmCalls = mockOllamaAgentWithBody((callIndex, init) => {
      if (callIndex === 1) {
        return agentResponse('', { name: 'create_project', arguments: { name: 'Garden' } });
      }
      if (callIndex === 2) {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string; tool_name?: string }>;
        };
        const projectResult = [...body.messages]
          .reverse()
          .find((message) => message.role === 'tool' && message.tool_name === 'create_project');
        assert.ok(projectResult);
        const projectId = (JSON.parse(projectResult.content.split('\n\nSTAGED:')[0]!) as { _id: string })
          ._id;
        return ollamaMultiToolCallResponse([
          { name: 'create_task', arguments: { title: 'Plan layout', projectId } },
          { name: 'create_task', arguments: { title: 'Buy soil', projectId } },
          { name: 'create_task', arguments: { title: 'Plant herbs', projectId } },
        ]);
      }
      return agentResponse('Project and tasks are staged.');
    });

    const events = await collectStream(userId, instruction.example);
    const projectProposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_project'
    );
    const taskProposals = events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_task'
    );
    assert.equal(projectProposals.length, 1);
    assert.equal(taskProposals.length, 3);
    assert.equal(getLlmCalls(), 2);
  });
});

describe('agent instruction integration — compound step-by-step', () => {
  it('create-project-with-subproject-steps uses preflight for both messages', async () => {
    const instruction = instructionById('create-project-with-subproject-steps');
    assert.ok(instruction.steps);
    const userId = await createTestUser();
    const defaultId = await defaultProjectId(userId);
    const getLlmCalls = mockOllamaTextOnly();

    const step1Events = await collectStream(userId, instruction.steps[0], undefined, defaultId);
    assert.equal(getLlmCalls(), 0);
    const step1Proposal = step1Events.find(
      (event) => event.type === 'tool_proposal' && event.name === 'create_project'
    ) as { arguments: { name: string } } | undefined;
    assert.ok(step1Proposal);
    assert.equal(step1Proposal.arguments.name, 'Boat');

    await approveFirstProposal(userId, step1Events);
    const { projectService } = await import('../src/services/projectService.js');
    const boat = (await projectService.listProjects(userId)).find((project) => project.name === 'Boat');
    assert.ok(boat);

    const getStep2LlmCalls = mockOllamaTextOnly();
    const step2Events = await collectStream(
      userId,
      instruction.steps[1],
      undefined,
      String(boat._id)
    );
    assert.equal(getStep2LlmCalls(), 0);
    const step2Proposal = step2Events.find(
      (event) => event.type === 'tool_proposal' && event.name === 'create_project'
    ) as { arguments: { name: string; parentId: string } } | undefined;
    assert.ok(step2Proposal);
    assert.equal(step2Proposal.arguments.name, 'Engine work');
    assert.equal(step2Proposal.arguments.parentId, String(boat._id));
  });

  it('create-project-with-tasks-steps preflights project then LLM multi-create', async () => {
    const instruction = instructionById('create-project-with-tasks-steps');
    assert.ok(instruction.steps);
    const userId = await createTestUser();
    const defaultId = await defaultProjectId(userId);

    const step1Events = await collectStream(userId, instruction.steps[0], undefined, defaultId);
    const step1Proposal = step1Events.find(
      (event) => event.type === 'tool_proposal' && event.name === 'create_project'
    );
    assert.ok(step1Proposal);

    await approveFirstProposal(userId, step1Events);
    const { projectService } = await import('../src/services/projectService.js');
    const garden = (await projectService.listProjects(userId)).find(
      (project) => project.name === 'Garden'
    );
    assert.ok(garden);
    const gardenId = String(garden._id);

    const getStep2LlmCalls = mockOllamaAgent((callIndex) => {
      if (callIndex === 1) {
        return ollamaMultiToolCallResponse([
          { name: 'create_task', arguments: { title: 'Plan layout', projectId: gardenId } },
          { name: 'create_task', arguments: { title: 'Buy soil', projectId: gardenId } },
          { name: 'create_task', arguments: { title: 'Plant herbs', projectId: gardenId } },
        ]);
      }
      return ollamaTextResponse('Three tasks are ready for approval.');
    });

    const step2Events = await collectStream(
      userId,
      instruction.steps[1],
      undefined,
      gardenId
    );
    assert.equal(getStep2LlmCalls(), 1);
    const taskProposals = step2Events.filter(
      (event) => event.type === 'tool_proposal' && event.name === 'create_task'
    );
    assert.equal(taskProposals.length, 3);
  });
});

describe('agent instruction documentation sync', () => {
  it('USER_GUIDE contains every catalog example phrase', () => {
    const userGuide = readFileSync(join(process.cwd(), 'docs/USER_GUIDE.md'), 'utf8');
    for (const instruction of AGENT_INSTRUCTIONS) {
      for (const phrase of allCatalogPhrases(instruction)) {
        assert.ok(
          userGuide.includes(phrase),
          `USER_GUIDE.md missing phrase for ${instruction.id}: ${phrase}`
        );
      }
    }
  });
});
