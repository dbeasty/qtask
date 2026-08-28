import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.QTASK_SKIP_DOTENV = 'true';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  const { connectDb } = await import('../src/db/connection.js');
  await connectDb();
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

// Project/comment code paths look users up by _id (an ObjectId-typed field),
// so test userIds there need to be real ObjectId-shaped strings — plain
// task-only tests don't hit that lookup (Task.userId is a plain String).
function objectId(): string {
  return new mongoose.Types.ObjectId().toString();
}

describe('RT-L6: staged entities are usable within their own owning conversation', () => {
  it('a staged task is invisible via getTask with no conversation id (unchanged baseline)', async () => {
    const { taskService } = await import('../src/services/taskService.js');

    const userId = 'staged-task-user-1';
    const conversationId = 'conv-1';
    const created = await taskService.createTask(
      userId,
      { title: 'Staged task' },
      'ai',
      { conversationId, proposalId: 'prop-1' }
    );

    assert.equal(await taskService.getTask(userId, created._id as string), null);
  });

  it('a staged task IS visible via getTask when the caller supplies its own conversation id', async () => {
    const { taskService } = await import('../src/services/taskService.js');

    const userId = 'staged-task-user-2';
    const conversationId = 'conv-2';
    const created = await taskService.createTask(
      userId,
      { title: 'Staged task 2' },
      'ai',
      { conversationId, proposalId: 'prop-2' }
    );

    const found = await taskService.getTask(userId, created._id as string, conversationId);
    assert.ok(found, 'the owning conversation must be able to reference its own staged task');
    assert.equal((found as { title: string }).title, 'Staged task 2');
  });

  it('a staged task stays hidden from a DIFFERENT conversation of the same user', async () => {
    const { taskService } = await import('../src/services/taskService.js');

    const userId = 'staged-task-user-3';
    const created = await taskService.createTask(
      userId,
      { title: 'Staged task 3' },
      'ai',
      { conversationId: 'conv-owner', proposalId: 'prop-3' }
    );

    assert.equal(
      await taskService.getTask(userId, created._id as string, 'conv-a-different-conversation'),
      null,
      'a sibling conversation for the same user must not see a staged task it did not create'
    );
  });

  it('a staged task stays hidden from a different user, even with the matching conversation id', async () => {
    const { taskService } = await import('../src/services/taskService.js');

    const ownerUserId = 'staged-task-user-4-owner';
    const attackerUserId = 'staged-task-user-4-attacker';
    const conversationId = 'conv-4';
    const created = await taskService.createTask(
      ownerUserId,
      { title: 'Staged task 4' },
      'ai',
      { conversationId, proposalId: 'prop-4' }
    );

    assert.equal(
      await taskService.getTask(attackerUserId, created._id as string, conversationId),
      null,
      "guessing/reusing a conversation id must not grant access to another user's staged task"
    );
  });

  it('updateTask lets the owning conversation fully edit its own staged task (not status-only)', async () => {
    const { taskService } = await import('../src/services/taskService.js');

    const userId = 'staged-task-user-5';
    const conversationId = 'conv-5';
    const created = await taskService.createTask(
      userId,
      { title: 'Original title' },
      'ai',
      { conversationId, proposalId: 'prop-5' }
    );

    const updated = await taskService.updateTask(
      userId,
      created._id as string,
      { title: 'Refined title', priority: 'high' },
      'ai',
      conversationId
    );
    assert.ok(updated);
    assert.equal((updated as { title: string }).title, 'Refined title');
    assert.equal((updated as { priority: string }).priority, 'high');
  });

  it('commentService can list/create comments on a staged task within its own conversation', async () => {
    const { taskService } = await import('../src/services/taskService.js');
    const { commentService } = await import('../src/services/commentService.js');
    const { UserModel } = await import('../src/models/index.js');

    const userId = objectId();
    await UserModel.create({ _id: userId, email: `${userId}@example.com`, emailVerified: true });
    const conversationId = 'conv-6';
    const created = await taskService.createTask(
      userId,
      { title: 'Task with a comment' },
      'ai',
      { conversationId, proposalId: 'prop-6' }
    );
    const taskId = created._id as string;

    const comment = await commentService.createComment(
      userId,
      taskId,
      { body: 'Looks good' },
      conversationId
    );
    assert.ok(comment);

    const comments = await commentService.listCommentsForTask(userId, taskId, conversationId);
    assert.equal(comments.length, 1);

    // Without the conversation id, the task (and therefore its comments)
    // must remain invisible, same as getTask above.
    await assert.rejects(() => commentService.listCommentsForTask(userId, taskId), /task not found/i);
  });

  it('a staged project is invisible via getProject with no conversation id (unchanged baseline)', async () => {
    const { projectService } = await import('../src/services/projectService.js');

    const userId = objectId();
    const conversationId = 'conv-p1';
    const created = await projectService.createProject(userId, 'Staged project', undefined, {
      conversationId,
      proposalId: 'prop-p1',
    });

    assert.equal(await projectService.getProject(userId, created._id as string), null);
  });

  it('a staged project IS visible via getProject when the caller supplies its own conversation id', async () => {
    const { projectService } = await import('../src/services/projectService.js');

    const userId = objectId();
    const conversationId = 'conv-p2';
    const created = await projectService.createProject(userId, 'Staged project 2', undefined, {
      conversationId,
      proposalId: 'prop-p2',
    });

    const found = await projectService.getProject(userId, created._id as string, conversationId);
    assert.ok(found, 'the owning conversation must be able to reference its own staged project');
  });

  it('a staged project stays hidden from a different user, even with the matching conversation id', async () => {
    const { projectService } = await import('../src/services/projectService.js');

    const ownerUserId = objectId();
    const attackerUserId = objectId();
    const conversationId = 'conv-p3';
    const created = await projectService.createProject(ownerUserId, 'Staged project 3', undefined, {
      conversationId,
      proposalId: 'prop-p3',
    });

    assert.equal(
      await projectService.getProject(attackerUserId, created._id as string, conversationId),
      null
    );
  });

  it('updateProject lets the owning conversation edit its own staged project', async () => {
    const { projectService } = await import('../src/services/projectService.js');

    const userId = objectId();
    const conversationId = 'conv-p4';
    const created = await projectService.createProject(userId, 'Original name', undefined, {
      conversationId,
      proposalId: 'prop-p4',
    });

    const updated = await projectService.updateProject(
      userId,
      created._id as string,
      { name: 'Refined name' },
      conversationId
    );
    assert.ok(updated);
    assert.equal((updated as { name: string }).name, 'Refined name');
  });

  it('end-to-end: stageCreateTool followed by the tool-level get_task/update_task/add_comment executors', async () => {
    const { stageCreateTool } = await import('../src/agent/stageCreateProposal.js');
    const { toolDefinitions } = await import('../src/agent/tools.js');
    const { UserModel } = await import('../src/models/index.js');

    const userId = objectId();
    await UserModel.create({ _id: userId, email: `${userId}@example.com`, emailVerified: true });
    const conversationId = 'conv-e2e';

    const staged = await stageCreateTool(
      userId,
      conversationId,
      'create_task',
      { title: 'E2E staged task' },
      'native',
      [],
      0
    );
    assert.ok(staged.proposal?.stagedEntity, 'expected a staged entity id back from create_task');
    const taskId = staged.proposal!.stagedEntity!.id;

    const getTaskDef = toolDefinitions.find((t) => t.name === 'get_task')!;
    const getResult = await getTaskDef.execute(userId, { taskId }, { conversationId, source: 'agent' });
    assert.ok(getResult.success, `get_task should resolve the staged id it just created: ${getResult.text}`);

    const updateTaskDef = toolDefinitions.find((t) => t.name === 'update_task')!;
    const updateResult = await updateTaskDef.execute(
      userId,
      { taskId, title: 'Refined via update_task' },
      { conversationId, source: 'agent' }
    );
    assert.ok(updateResult.success, `update_task should be able to refine the staged task: ${updateResult.text}`);

    const addCommentDef = toolDefinitions.find((t) => t.name === 'add_comment')!;
    const commentResult = await addCommentDef.execute(
      userId,
      { taskId, body: 'Reviewing before approval' },
      { conversationId, source: 'agent' }
    );
    assert.ok(commentResult.success, `add_comment should work against the staged task: ${commentResult.text}`);

    // A tool call from outside this conversation must still fail, exactly
    // as it would have pre-fix for everyone.
    const outsideResult = await getTaskDef.execute(
      userId,
      { taskId },
      { conversationId: 'conv-other', source: 'agent' }
    );
    assert.equal(outsideResult.success, false);
  });
});
