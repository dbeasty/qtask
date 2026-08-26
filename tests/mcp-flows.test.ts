import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Express } from 'express';
import type { McpServerContext } from '../src/mcp/mcpToolHandler.js';
import {
  callMcpTool,
  commitProject,
  commitTask,
  approve,
  commitWrite,
  createMcpContext,
  parseToolResult,
  refreshActiveProject,
  reject,
  resetMcpTestData,
  stageWrite,
} from './helpers/mcp.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-mcp-flows-jwt-secret';
process.env.SERVE_CLIENT = 'false';

let mongo: MongoMemoryServer;
let app: Express;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();

  const { createApp } = await import('../src/app.js');
  app = await createApp({ connect: true, startWorker: false });
});

beforeEach(async () => {
  await resetMcpTestData();
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function readJson(ctx: McpServerContext, tool: string, args: Record<string, unknown> = {}) {
  const result = await callMcpTool(ctx, tool, args);
  assert.equal(result.success, true, result.text);
  return JSON.parse(result.text) as Record<string, unknown>;
}

describe('MCP staging workflow', () => {
  it('reject_proposal removes a staged create_task', async () => {
    const { ctx, userId } = await createMcpContext();
    const { TaskModel } = await import('../src/models/index.js');

    const proposalId = await stageWrite(ctx, 'create_task', { title: 'Discard me' });
    assert.equal(await TaskModel.countDocuments({ userId, title: 'Discard me' }), 1);

    await reject(ctx, proposalId);
    assert.equal(await TaskModel.countDocuments({ userId, title: 'Discard me' }), 0);
  });

  it('list_pending_proposals returns multiple staged writes', async () => {
    const { ctx } = await createMcpContext();

    const firstId = await stageWrite(ctx, 'create_task', { title: 'Task A' });
    const secondId = await stageWrite(ctx, 'create_task', { title: 'Task B' });

    const listed = await readJson(ctx, 'list_pending_proposals');
    const proposals = listed.proposals as Array<{ id: string; name: string }>;
    assert.equal(proposals.length, 2);
    assert.deepEqual(
      proposals.map((p) => p.id).sort(),
      [firstId, secondId].sort()
    );
  });

  it('blocks approve_proposal for read-only keys', async () => {
    const { ctx, userId } = await createMcpContext('read');
    const { mcpKeyService } = await import('../src/services/mcpKeyService.js');
    const { secret } = await mcpKeyService.createKey(userId, 'write key', 'read_write');
    const auth = await mcpKeyService.authenticate(secret);
    assert.ok(auth);

    const writeCtx = { ...ctx, scope: 'read_write' as const, keyId: auth.keyId };
    const proposalId = await stageWrite(writeCtx, 'create_task', { title: 'Needs write key' });

    const result = await callMcpTool(ctx, 'approve_proposal', { proposalId });
    assert.equal(result.success, false);
    assert.match(result.text, /read-only/i);
  });
});

describe('MCP projects and subprojects', () => {
  it('creates a project and reads it back', async () => {
    const { ctx } = await createMcpContext();

    const project = await commitProject(ctx, 'Kitchen Reno');
    const fetched = await readJson(ctx, 'get_project', { projectId: project._id });
    assert.equal(fetched.name, 'Kitchen Reno');

    const listed = await readJson(ctx, 'list_projects');
    const projects = listed.projects as Array<{ _id: string; name: string }>;
    assert.ok(projects.some((p) => p._id === project._id && p.name === 'Kitchen Reno'));
  });

  it('creates a subproject with parentId', async () => {
    const { ctx, userId } = await createMcpContext();
    const { projectService } = await import('../src/services/projectService.js');

    const parent = await commitProject(ctx, 'Parent Project');
    const child = await commitProject(ctx, 'Child Project', parent._id);

    const fetched = await projectService.getProject(userId, child._id);
    assert.equal(fetched?.parentId, parent._id);
  });

  it('updates project name and hourlyRate', async () => {
    const { ctx } = await createMcpContext();

    const project = await commitProject(ctx, 'Billing Project');
    const text = await commitWrite(ctx, 'update_project', {
      projectId: project._id,
      name: 'Renamed Project',
      hourlyRate: 75,
    });
    const updated = parseToolResult(text);
    assert.equal(updated.name, 'Renamed Project');
    assert.equal(updated.hourlyRate, 75);
  });

  it('scopes find_tasks to the active project', async () => {
    const { ctx } = await createMcpContext();

    const projectA = await commitProject(ctx, 'Project A');
    const projectB = await commitProject(ctx, 'Project B');
    await commitTask(ctx, { title: 'Task in A', projectId: projectA._id });
    await commitTask(ctx, { title: 'Task in B', projectId: projectB._id });

    await callMcpTool(ctx, 'set_active_project', { projectId: projectA._id });
    await refreshActiveProject(ctx);

    const found = await readJson(ctx, 'find_tasks');
    const tasks = found.tasks as Array<{ title: string; projectId?: string }>;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.title, 'Task in A');
    assert.equal(tasks[0]?.projectId, projectA._id);

    await callMcpTool(ctx, 'set_active_project', { projectId: projectB._id });
    await refreshActiveProject(ctx);
    const foundB = await readJson(ctx, 'find_tasks');
    const tasksB = foundB.tasks as Array<{ title: string }>;
    assert.equal(tasksB.length, 1);
    assert.equal(tasksB[0]?.title, 'Task in B');
  });

  it('summarize_project returns project status text', async () => {
    const { ctx } = await createMcpContext();

    const project = await commitProject(ctx, 'Summary Project');
    await commitTask(ctx, { title: 'Open task', projectId: project._id, priority: 'high' });

    const result = await callMcpTool(ctx, 'summarize_project', { projectId: project._id });
    assert.equal(result.success, true);
    assert.ok(result.text.trim().length > 20);
  });
});

describe('MCP tasks', () => {
  it('creates a task in a project', async () => {
    const { ctx, userId } = await createMcpContext();
    const { TaskModel } = await import('../src/models/index.js');

    const project = await commitProject(ctx, 'Task Project');
    const task = await commitTask(ctx, { title: 'Install cabinets', projectId: project._id });

    const visible = await TaskModel.findOne({ userId, _id: task._id }).lean();
    assert.ok(visible);
    assert.equal(visible.staging, undefined);
  });

  it('creates a task with nested subtasks', async () => {
    const { ctx, userId } = await createMcpContext();
    const { taskService } = await import('../src/services/taskService.js');

    const project = await commitProject(ctx, 'Subtask Project');
    const task = await commitTask(ctx, {
      title: 'Parent task',
      projectId: project._id,
      subtasks: [{ title: 'Subtask one' }, { title: 'Subtask two' }],
    });

    const loaded = await taskService.getTask(userId, task._id);
    assert.ok(loaded);
    assert.equal(loaded.subtasks?.length, 2);

    const fetched = await readJson(ctx, 'get_task', { taskId: task._id });
    assert.equal(fetched.subtaskCount, 2);
  });

  it('modifies task title and priority via update_task', async () => {
    const { ctx } = await createMcpContext();

    const project = await commitProject(ctx, 'Update Project');
    const task = await commitTask(ctx, { title: 'Original title', projectId: project._id });

    const text = await commitWrite(ctx, 'update_task', {
      taskId: task._id,
      title: 'Updated title',
      priority: 'urgent',
    });
    const updated = parseToolResult(text);
    assert.equal(updated.title, 'Updated title');
    assert.equal(updated.priority, 'urgent');
  });

  it('finishes a task and excludes it from workload', async () => {
    const { ctx } = await createMcpContext();

    const project = await commitProject(ctx, 'Finish Project');
    const task = await commitTask(ctx, { title: 'Finish me', projectId: project._id });

    const before = await readJson(ctx, 'get_workload');
    assert.equal((before.workload as unknown[]).length, 1);

    await commitWrite(ctx, 'update_task', { taskId: task._id, status: 'done' });

    const after = await readJson(ctx, 'get_workload');
    assert.equal((after.workload as unknown[]).length, 0);
  });
});

describe('MCP comments', () => {
  it('adds a comment to a task and reads it via get_task', async () => {
    const { ctx } = await createMcpContext();

    const project = await commitProject(ctx, 'Comment Project');
    const task = await commitTask(ctx, { title: 'Discuss me', projectId: project._id });

    const text = await commitWrite(ctx, 'add_comment', {
      taskId: task._id,
      body: 'Looks good',
    });
    const created = parseToolResult(text).comment as { body: string };

    const fetched = await readJson(ctx, 'get_task', { taskId: task._id });
    const comments = fetched.comments as Array<{ body: string }>;
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.body, created.body);
  });

  it('adds a comment on a subtask via subtaskPath', async () => {
    const { ctx, userId } = await createMcpContext();
    const { taskService } = await import('../src/services/taskService.js');

    const project = await commitProject(ctx, 'Subtask Comment Project');
    const task = await commitTask(ctx, {
      title: 'Parent',
      projectId: project._id,
      subtasks: [{ title: 'Nested subtask' }],
    });

    const loaded = await taskService.getTask(userId, task._id);
    const subtaskId = String(loaded?.subtasks?.[0]?._id);
    assert.ok(subtaskId);

    await commitWrite(ctx, 'add_comment', {
      taskId: task._id,
      body: 'Subtask note',
      subtaskPath: [subtaskId],
    });

    const fetched = await readJson(ctx, 'get_task', { taskId: task._id });
    const comments = fetched.comments as Array<{ body: string; subtaskPath?: string[] }>;
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.body, 'Subtask note');
    assert.deepEqual(comments[0]?.subtaskPath, [subtaskId]);
  });
});

describe('MCP cost and time tracking', () => {
  it('creates a task with materials, hours, and hourlyRate', async () => {
    const { ctx, userId } = await createMcpContext();
    const { taskService } = await import('../src/services/taskService.js');

    const project = await commitProject(ctx, 'Tracking Project');
    await commitWrite(ctx, 'update_project', { projectId: project._id, hourlyRate: 50 });

    const task = await commitTask(ctx, {
      title: 'Paint room',
      projectId: project._id,
      hoursSpent: 2,
      hoursRemaining: 3,
      materials: [{ description: 'Paint', quantity: 2, unitPrice: 10 }],
    });

    const loaded = await taskService.getTask(userId, task._id);
    assert.equal(loaded?.hoursSpent, 2);
    assert.equal(loaded?.hoursRemaining, 3);
    const materials1 = loaded?.materials as Array<{ description: string }> | undefined;
    assert.equal(materials1?.[0]?.description, 'Paint');
  });

  it('updates tracking fields on an existing task', async () => {
    const { ctx, userId } = await createMcpContext();
    const { taskService } = await import('../src/services/taskService.js');

    const project = await commitProject(ctx, 'Update Tracking');
    const task = await commitTask(ctx, { title: 'Track me', projectId: project._id });

    await commitWrite(ctx, 'update_task', {
      taskId: task._id,
      hoursSpent: 4,
      hoursRemaining: 1,
      materials: [{ description: 'Supplies', quantity: 1, unitPrice: 25 }],
    });

    const loaded = await taskService.getTask(userId, task._id);
    assert.equal(loaded?.hoursSpent, 4);
    assert.equal(loaded?.hoursRemaining, 1);
    const materials2 = loaded?.materials as Array<{ unitPrice: number }> | undefined;
    assert.equal(materials2?.[0]?.unitPrice, 25);
  });

  it('get_project_tracking returns cost rollup totals', async () => {
    const { ctx } = await createMcpContext();

    const project = await commitProject(ctx, 'Cost Project');
    await commitWrite(ctx, 'update_project', { projectId: project._id, hourlyRate: 50 });
    await commitTask(ctx, {
      title: 'Costed task',
      projectId: project._id,
      hoursSpent: 2,
      hoursRemaining: 3,
      materials: [{ description: 'Paint', quantity: 2, unitPrice: 10 }],
    });

    const tracking = await readJson(ctx, 'get_project_tracking', { projectId: project._id });
    const totals = tracking.totals as {
      materialsTotal: number;
      laborCost: number;
      totalCost: number;
    };
    assert.equal(totals.materialsTotal, 20);
    assert.equal(totals.laborCost, 250);
    assert.equal(totals.totalCost, 270);

    const lines = tracking.lines as Array<{ title: string; totalCost: number }>;
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.title, 'Costed task');
    assert.equal(lines[0]?.totalCost, 270);
  });
});

describe('MCP collaboration and links', () => {
  it('assign_task sets assignee on a project collaborator', async () => {
    const { ctx, userId } = await createMcpContext();
    const { registerUser } = await import('./helpers/mcp.js');
    const { projectService } = await import('../src/services/projectService.js');

    const collaborator = await registerUser(`collab-${Date.now()}@example.com`);
    const project = await commitProject(ctx, 'Assign Project');
    await projectService.addCollaborator(userId, project._id, {
      userId: collaborator.userId,
      role: 'executor',
    });

    const task = await commitTask(ctx, { title: 'Assignable', projectId: project._id });
    const text = await commitWrite(ctx, 'assign_task', {
      taskId: task._id,
      assigneeId: collaborator.userId,
    });
    const updated = parseToolResult(text);
    assert.equal(updated.assigneeId, collaborator.userId);
  });

  it('share_project stages and commits a collaboration invite', async () => {
    const { ctx } = await createMcpContext();
    const { InviteModel } = await import('../src/models/index.js');

    const project = await commitProject(ctx, 'Share Project');
    const proposalId = await stageWrite(ctx, 'share_project', {
      projectId: project._id,
      email: 'invitee@example.com',
      role: 'editor',
    });

    const pending = await readJson(ctx, 'list_pending_proposals');
    assert.equal((pending.proposals as unknown[]).length, 1);
    assert.equal((pending.proposals as Array<{ id: string }>)[0]?.id, proposalId);

    await approve(ctx, proposalId);

    const invites = await InviteModel.find({ projectId: project._id }).lean();
    assert.equal(invites.length, 1);
    assert.equal(invites[0]?.inviteeEmail, 'invitee@example.com');
  });

  it('share_task assigns a task to an existing project collaborator', async () => {
    const { ctx, userId } = await createMcpContext();
    const { registerUser } = await import('./helpers/mcp.js');
    const { projectService } = await import('../src/services/projectService.js');
    const { taskService } = await import('../src/services/taskService.js');

    const invitee = await registerUser(`share-task-${Date.now()}@example.com`);
    const project = await commitProject(ctx, 'Share Task Project');
    await projectService.addCollaborator(userId, project._id, {
      userId: invitee.userId,
      role: 'executor',
    });
    const task = await commitTask(ctx, { title: 'Shared task', projectId: project._id });

    const text = await commitWrite(ctx, 'share_task', {
      taskId: task._id,
      collaboratorId: invitee.userId,
      role: 'executor',
    });
    const payload = parseToolResult(text);
    const updated = (payload.task ?? payload) as { assigneeId?: string };
    assert.equal(updated.assigneeId, invitee.userId);

    const loaded = await taskService.getTask(userId, task._id);
    assert.equal(loaded?.assigneeId, invitee.userId);
  });

  it('add_task_link links two tasks', async () => {
    const { ctx } = await createMcpContext();

    const project = await commitProject(ctx, 'Link Project');
    const first = await commitTask(ctx, { title: 'Blocker', projectId: project._id });
    const second = await commitTask(ctx, { title: 'Blocked', projectId: project._id });

    const text = await commitWrite(ctx, 'add_task_link', {
      taskId: second._id,
      linkedTaskId: first._id,
      type: 'blocked_by',
    });
    const linked = parseToolResult(text);
    const links = linked.links as Array<{ taskId: string; type: string }>;
    assert.ok(links.some((l) => l.taskId === first._id && l.type === 'blocked_by'));
  });
});

describe('MCP read tools smoke', () => {
  it('exercises all read tools on committed data', async () => {
    const { ctx } = await createMcpContext();

    const project = await commitProject(ctx, 'Read Smoke Project');
    const task = await commitTask(ctx, {
      title: 'Readable task',
      projectId: project._id,
      priority: 'high',
    });

    const byProject = await readJson(ctx, 'find_tasks', { projectId: project._id });
    assert.equal((byProject.tasks as unknown[]).length, 1);

    const one = await readJson(ctx, 'get_task', { taskId: task._id });
    assert.equal(one.title, 'Readable task');

    const workload = await readJson(ctx, 'get_workload');
    assert.equal((workload.workload as unknown[]).length, 1);

    const projectOne = await readJson(ctx, 'get_project', { projectId: project._id });
    assert.equal(projectOne.name, 'Read Smoke Project');

    const allProjects = await readJson(ctx, 'list_projects');
    assert.ok((allProjects.projects as unknown[]).length >= 1);

    const summary = await callMcpTool(ctx, 'summarize_project', { projectId: project._id });
    assert.equal(summary.success, true);

    const tracking = await readJson(ctx, 'get_project_tracking', { projectId: project._id });
    assert.ok(tracking.totals);
  });
});

describe('MCP READ_ONLY_MODE', () => {
  it('blocks MCP write tools when READ_ONLY_MODE is enabled', async () => {
    const previous = process.env.READ_ONLY_MODE;
    process.env.READ_ONLY_MODE = 'true';

    try {
      const { ctx } = await createMcpContext();
      const result = await callMcpTool(ctx, 'create_task', { title: 'Blocked' });
      assert.equal(result.success, false);
      assert.match(result.text, /read-only mode/i);

      const approve = await callMcpTool(ctx, 'approve_proposal', { proposalId: 'fake' });
      assert.equal(approve.success, false);
      assert.match(approve.text, /read-only mode/i);
    } finally {
      if (previous === undefined) {
        delete process.env.READ_ONLY_MODE;
      } else {
        process.env.READ_ONLY_MODE = previous;
      }
    }
  });
});
