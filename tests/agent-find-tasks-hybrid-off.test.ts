import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';
process.env.JWT_SECRET = 'test-agent-find-tasks-hybrid-off';
process.env.AGENT_HYBRID_SEARCH = 'false';

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

describe('agent find_tasks hybrid search (AGENT_HYBRID_SEARCH=false)', () => {
  it('skips Ollama embeddings when source is agent', async () => {
    let embeddingCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        embeddingCalls += 1;
        throw new Error('embeddings should not be called');
      }
      return originalFetch(input);
    };

    const { ProjectModel, TaskModel } = await import('../src/models/index.js');
    const { executeTool } = await import('../src/agent/tools.js');

    const userId = 'agent-hybrid-off-user';
    const project = await ProjectModel.create({
      userId,
      name: 'Marketing',
      collaborators: [],
      parentId: null,
      sortOrder: 0,
    });

    await TaskModel.create({
      userId,
      title: 'Advertise on craigslist',
      description: 'Listing',
      tags: [],
      projectIds: [String(project._id)],
      projectId: String(project._id),
      status: 'todo',
    });

    const result = await executeTool(
      'find_tasks',
      { query: 'craigslist', projectId: String(project._id), limit: 5 },
      userId,
      { source: 'agent' }
    );

    assert.equal(result.success, true);
    assert.equal(embeddingCalls, 0);
    assert.match(result.text, /craigslist/i);

    globalThis.fetch = originalFetch;
  });

  it('create-task preflight completes without embedding calls', async () => {
    let embeddingCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/embeddings')) {
        embeddingCalls += 1;
        throw new Error('embeddings should not be called');
      }
      if (url.includes('/api/chat')) {
        throw new Error('LLM should not run for create-task preflight');
      }
      return originalFetch(input);
    };

    const { UserModel } = await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { projectService } = await import('../src/services/projectService.js');

    const user = await UserModel.create({
      email: `preflight-hybrid-off-${randomUUID()}@example.com`,
      passwordHash: 'unused',
      emailVerified: true,
    });
    const userId = String(user._id);
    const projectId = await projectService.ensureDefaultProject(userId);

    const events: Array<{ type: string; name?: string }> = [];
    for await (const event of agentService.streamAgent(
      userId,
      'add task advertise on craigslist',
      undefined,
      projectId
    )) {
      events.push(event as { type: string; name?: string });
    }

    assert.equal(embeddingCalls, 0);
    assert.ok(events.some((event) => event.type === 'tool_proposal' && event.name === 'create_task'));
    assert.ok(events.some((event) => event.type === 'done'));

    globalThis.fetch = originalFetch;
  });
});
