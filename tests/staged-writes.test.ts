import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-staged-writes-secret';

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

describe('staged AI creates', () => {
  it('chains real project ids into tasks, hides both, then commits both from task approval', async () => {
    const { ActivityModel, EmbeddingJobModel, UserModel, ProjectModel, TaskModel } =
      await import('../src/models/index.js');
    const { agentService } = await import('../src/services/agentService.js');
    const { conversationService } = await import('../src/services/conversationService.js');
    const { projectService } = await import('../src/services/projectService.js');
    const { taskService } = await import('../src/services/taskService.js');

    const user = await UserModel.create({
      email: `staged-chain-${randomUUID()}@example.com`,
      passwordHash: 'unused',
    });
    const userId = String(user._id);
    let call = 0;

    globalThis.fetch = async (_input, init) => {
      call += 1;
      if (call === 1) {
        return agentResponse('', {
          name: 'create_project',
          arguments: { name: 'Test the Boar' },
        });
      }
      if (call === 2) {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string; tool_name?: string }>;
        };
        const projectResult = [...body.messages]
          .reverse()
          .find((message) => message.role === 'tool' && message.tool_name === 'create_project');
        assert.ok(projectResult);
        const projectId = (JSON.parse(projectResult.content.split('\n\nSTAGED:')[0]!) as { _id: string })
          ._id;
        assert.match(projectId, /^[0-9a-f]{24}$/);
        return agentResponse('', {
          name: 'create_task',
          arguments: { title: 'Test the Boar', projectId },
        });
      }
      return agentResponse('The project and task are staged and awaiting approval.');
    };

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of agentService.streamAgent(userId, 'Create Test the Boar')) {
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
    const taskProposal = conversation.pendingProposals?.find(
      (proposal) => proposal.name === 'create_task'
    );
    assert.ok(taskProposal?.stagedEntity);

    assert.equal((await taskService.listTasks(userId)).length, 0);
    const visibleProjects = await projectService.listProjects(userId);
    assert.equal(visibleProjects.some((project) => project.name === 'Test the Boar'), false);
    assert.equal(await TaskModel.countDocuments({ staging: { $exists: true } }), 1);
    assert.equal(await ProjectModel.countDocuments({ staging: { $exists: true } }), 1);
    assert.equal(await ActivityModel.countDocuments({ action: 'task.created' }), 0);
    assert.equal(await EmbeddingJobModel.countDocuments(), 0);

    for await (const _event of agentService.resumeAfterApproval(
      userId,
      conversationId,
      taskProposal.id,
      'approve'
    )) {
      // drain stream
    }

    assert.equal(await TaskModel.countDocuments({ staging: { $exists: true } }), 0);
    assert.equal(await ProjectModel.countDocuments({ staging: { $exists: true } }), 0);
    assert.equal(await ActivityModel.countDocuments({ action: 'task.created' }), 1);
    assert.equal(await EmbeddingJobModel.countDocuments(), 1);
    assert.equal((await taskService.listTasks(userId)).length, 1);
    assert.equal(
      (await projectService.listProjects(userId)).some((project) => project.name === 'Test the Boar'),
      true
    );
  });

  it('deletes rejected staged creates and expires abandoned ones', async () => {
    const { UserModel, ProjectModel } = await import('../src/models/index.js');
    const { executeTool } = await import('../src/agent/tools.js');
    const { conversationService } = await import('../src/services/conversationService.js');
    const { stagingService } = await import('../src/services/stagingService.js');

    const user = await UserModel.create({
      email: `staged-rollback-${randomUUID()}@example.com`,
      passwordHash: 'unused',
    });
    const userId = String(user._id);
    const conversation = await conversationService.createConversation(userId);
    const proposalId = randomUUID();
    const result = await executeTool('create_project', { name: 'Discard me' }, userId, {
      staged: true,
      conversationId: conversation._id,
      proposalId,
    });
    assert.equal(result.success, true);
    const id = (JSON.parse(result.text) as { _id: string })._id;
    const proposal = {
      id: proposalId,
      name: 'create_project',
      arguments: { name: 'Discard me' },
      source: 'native' as const,
      status: 'pending' as const,
      stagedEntity: { kind: 'project' as const, id },
    };
    await conversationService.savePauseState(userId, conversation._id, {
      messages: [],
      pendingProposals: [proposal],
      pausedBatch: null,
    });

    await stagingService.rollbackProposal(userId, conversation._id, proposal);
    assert.equal(await ProjectModel.countDocuments({ _id: id }), 0);

    const abandonedProposalId = randomUUID();
    const abandonedResult = await executeTool(
      'create_project',
      { name: 'Abandon me' },
      userId,
      {
        staged: true,
        conversationId: conversation._id,
        proposalId: abandonedProposalId,
      }
    );
    const abandonedId = (JSON.parse(abandonedResult.text) as { _id: string })._id;
    await conversationService.savePauseState(userId, conversation._id, {
      messages: [],
      pendingProposals: [
        {
          id: abandonedProposalId,
          name: 'create_project',
          arguments: { name: 'Abandon me' },
          source: 'native',
          status: 'pending',
          stagedEntity: { kind: 'project', id: abandonedId },
        },
      ],
      pausedBatch: null,
    });

    await ProjectModel.updateOne(
      { _id: abandonedId },
      { $set: { 'staging.stagedAt': new Date(Date.now() - 25 * 60 * 60 * 1000) } }
    );
    const removed = await stagingService.sweepExpired();
    assert.equal(removed, 1);
    assert.equal(await ProjectModel.countDocuments({ _id: abandonedId }), 0);
    const updated = await conversationService.getConversation(userId, conversation._id);
    assert.equal(updated?.pendingProposals?.[0]?.status, 'expired');

    const nextMessageProposalId = randomUUID();
    const nextMessageResult = await executeTool(
      'create_project',
      { name: 'Discard on next message' },
      userId,
      {
        staged: true,
        conversationId: conversation._id,
        proposalId: nextMessageProposalId,
      }
    );
    const nextMessageId = (JSON.parse(nextMessageResult.text) as { _id: string })._id;
    await conversationService.savePauseState(userId, conversation._id, {
      messages: [],
      pendingProposals: [
        {
          id: nextMessageProposalId,
          name: 'create_project',
          arguments: { name: 'Discard on next message' },
          source: 'native',
          status: 'pending',
          stagedEntity: { kind: 'project', id: nextMessageId },
        },
      ],
      pausedBatch: null,
    });
    globalThis.fetch = async () => agentResponse('Started a fresh turn.');
    const { agentService } = await import('../src/services/agentService.js');
    for await (const _event of agentService.streamAgent(
      userId,
      'Do something else',
      conversation._id
    )) {
      // drain stream
    }
    assert.equal(await ProjectModel.countDocuments({ _id: nextMessageId }), 0);
  });
});
