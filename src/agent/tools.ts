import { z } from 'zod';
import { projectService } from '../services/projectService.js';
import { taskService } from '../services/taskService.js';
import { createLogger } from '../utils/logger.js';
import type { StagingContext } from '../types/staging.js';

const log = createLogger('tools');

const taskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'cancelled']);
const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);

// All QTask ids (tasks, projects, users) are MongoDB ObjectIds. Rejecting
// fabricated ids at proposal time keeps invalid write proposals from ever
// reaching the user and tells the model to look the real id up instead.
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const objectIdMessage =
  'must be a real 24-character hex id copied from a previous tool result. Do not invent ids — use find_tasks, get_task, get_workload, or list_projects to look up the real id first';
const objectIdSchema = z.string().regex(OBJECT_ID_PATTERN, objectIdMessage);

const subtaskInputSchema: z.ZodType<{
  title: string;
  description?: string;
  status?: z.infer<typeof taskStatusSchema>;
  priority?: z.infer<typeof taskPrioritySchema>;
  dueDate?: string;
  tags?: string[];
  percentComplete?: number;
  subtasks?: unknown[];
}> = z.lazy(() =>
  z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    dueDate: z.string().optional(),
    tags: z.array(z.string()).optional(),
    percentComplete: z.number().min(0).max(100).optional(),
    subtasks: z.array(subtaskInputSchema).optional(),
  })
);

export interface ToolResult {
  success: boolean;
  text: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  zodShape: z.ZodRawShape;
  execute: (
    userId: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ) => Promise<ToolResult>;
}

export interface ToolExecutionContext {
  conversationId?: string;
  proposalId?: string;
  staged?: boolean;
}

function stagingContext(context?: ToolExecutionContext): StagingContext | undefined {
  if (!context?.staged || !context.conversationId || !context.proposalId) return undefined;
  return { conversationId: context.conversationId, proposalId: context.proposalId };
}

function ok(text: string): ToolResult {
  return { success: true, text };
}

function err(text: string): ToolResult {
  return { success: false, text };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'create_task',
    description: 'Create a task, optionally with nested subtasks from a natural-language goal breakdown.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        dueDate: { type: 'string', description: 'ISO 8601 due date' },
        tags: { type: 'array', items: { type: 'string' } },
        projectId: { type: 'string' },
        subtasks: {
          type: 'array',
          description: 'Nested subtasks. Each item MUST have a "title".',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Subtask title (required)' },
              description: { type: 'string' },
              status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
              priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
              dueDate: { type: 'string', description: 'ISO 8601 due date' },
              tags: { type: 'array', items: { type: 'string' } },
              percentComplete: { type: 'number', minimum: 0, maximum: 100 },
              subtasks: { type: 'array', items: { type: 'object' } },
            },
            required: ['title'],
          },
        },
      },
      required: ['title'],
    },
    zodShape: {
      title: z.string().min(1).describe('Task title'),
      description: z.string().optional().describe('Task description'),
      status: taskStatusSchema.optional(),
      priority: taskPrioritySchema.optional(),
      dueDate: z.string().optional().describe('ISO 8601 due date'),
      tags: z.array(z.string()).optional(),
      projectId: objectIdSchema.optional(),
      subtasks: z.array(subtaskInputSchema).optional().describe('Nested subtasks'),
    },
    async execute(userId, input, context) {
      const task = await taskService.createTask(
        userId,
        input as unknown as Parameters<typeof taskService.createTask>[1],
        'ai',
        stagingContext(context)
      );
      return ok(JSON.stringify(task, null, 2));
    },
  },
  {
    name: 'update_task',
    description: 'Update task fields such as status, priority, due date, or percent complete.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'Task ID to update: a 24-character hex id copied from a find_tasks/get_task result. Never invent this value.',
        },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        dueDate: { type: 'string', nullable: true },
        tags: { type: 'array', items: { type: 'string' } },
        percentComplete: { type: 'number', minimum: 0, maximum: 100 },
        percentCompleteOverride: { type: 'number', nullable: true, minimum: 0, maximum: 100 },
        projectId: { type: 'string', nullable: true },
        assigneeId: { type: 'string', nullable: true },
      },
      required: ['taskId'],
    },
    zodShape: {
      taskId: objectIdSchema.describe('Task ID to update'),
      title: z.string().optional(),
      description: z.string().optional(),
      status: taskStatusSchema.optional(),
      priority: taskPrioritySchema.optional(),
      dueDate: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      percentComplete: z.number().min(0).max(100).optional(),
      percentCompleteOverride: z.number().min(0).max(100).nullable().optional(),
      projectId: objectIdSchema.nullable().optional(),
      assigneeId: objectIdSchema.nullable().optional(),
    },
    async execute(userId, input) {
      const { taskId, ...updates } = input;
      const task = await taskService.updateTask(userId, String(taskId), updates, 'ai');
      if (!task) return err('Task not found');
      return ok(JSON.stringify(task, null, 2));
    },
  },
  {
    name: 'find_tasks',
    description:
      'Hybrid structured + semantic search for tasks by status, priority, project, tags, due date, or natural-language query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query' },
        status: { type: 'string' },
        priority: { type: 'string' },
        projectId: { type: 'string' },
        assigneeId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        dueBefore: { type: 'string' },
        dueAfter: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    zodShape: {
      query: z.string().optional().describe('Natural-language search query'),
      status: z.union([taskStatusSchema, z.array(taskStatusSchema)]).optional(),
      priority: z.union([taskPrioritySchema, z.array(taskPrioritySchema)]).optional(),
      projectId: objectIdSchema.optional(),
      assigneeId: objectIdSchema.optional(),
      tags: z.array(z.string()).optional(),
      dueBefore: z.string().optional(),
      dueAfter: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async execute(userId, input) {
      const { limit, ...filters } = input;
      const tasks = await taskService.findTasks(userId, filters, (limit as number) ?? 20);
      return ok(JSON.stringify({ count: tasks.length, tasks }, null, 2));
    },
  },
  {
    name: 'get_task',
    description: 'Fetch a single task with its subtasks and links.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID: a 24-character hex id from a previous tool result',
        },
      },
      required: ['taskId'],
    },
    zodShape: {
      taskId: objectIdSchema.describe('Task ID'),
    },
    async execute(userId, input) {
      const task = await taskService.getTask(userId, String(input.taskId));
      if (!task) return err('Task not found');
      return ok(JSON.stringify(task, null, 2));
    },
  },
  {
    name: 'get_workload',
    description: 'List open tasks for a user with status and percent complete.',
    parameters: {
      type: 'object',
      properties: {
        assigneeId: { type: 'string', description: 'Filter by assignee; defaults to all open tasks' },
      },
    },
    zodShape: {
      assigneeId: objectIdSchema.optional().describe('Filter by assignee; defaults to all open tasks'),
    },
    async execute(userId, input) {
      const workload = await taskService.getWorkload(userId, input.assigneeId as string | undefined);
      return ok(JSON.stringify({ count: workload.length, workload }, null, 2));
    },
  },
  {
    name: 'assign_task',
    description:
      'Assign a task to a project collaborator (sets assigneeId). The assignee must already be a project member.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        assigneeId: { type: 'string', description: 'User id of an existing project collaborator' },
      },
      required: ['taskId', 'assigneeId'],
    },
    zodShape: {
      taskId: objectIdSchema,
      assigneeId: objectIdSchema,
    },
    async execute(userId, input) {
      const task = await taskService.getTask(userId, String(input.taskId));
      if (!task) return err('Task not found');
      const projectIds = Array.isArray(task.projectIds)
        ? task.projectIds.map(String)
        : task.projectId
          ? [String(task.projectId)]
          : [];
      if (projectIds.length === 0) return err('Task has no project');
      const projectId = projectIds[0]!;

      const project = await projectService.getProject(userId, projectId);
      if (!project) return err('Project not found');

      const assigneeId = String(input.assigneeId);
      const isMember =
        project.userId === assigneeId ||
        project.collaborators.some((c) => c.userId === assigneeId);
      if (!isMember) {
        return err('Assignee must be a project member. Use share_project first.');
      }

      const updated = await taskService.updateTask(
        userId,
        String(input.taskId),
        { assigneeId },
        'ai'
      );
      if (!updated) return err('Task not found');
      return ok(JSON.stringify(updated, null, 2));
    },
  },
  {
    name: 'share_project',
    description:
      'Add an existing QTask user as a project collaborator by email (or userId). Roles: editor, executor, viewer.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        email: { type: 'string', description: 'Email of an existing QTask account' },
        userId: { type: 'string', description: 'User id (alternative to email)' },
        role: {
          type: 'string',
          enum: ['editor', 'executor', 'viewer'],
          description: 'Collaborator role (default editor)',
        },
      },
      required: ['projectId'],
    },
    zodShape: {
      projectId: objectIdSchema,
      email: z.string().email().optional(),
      userId: objectIdSchema.optional(),
      role: z.enum(['editor', 'executor', 'viewer']).optional(),
    },
    async execute(userId, input) {
      try {
        const project = await projectService.addCollaborator(userId, String(input.projectId), {
          email: input.email as string | undefined,
          userId: input.userId as string | undefined,
          role: input.role as 'editor' | 'executor' | 'viewer' | undefined,
        });
        return ok(JSON.stringify(project, null, 2));
      } catch (error) {
        return err(error instanceof Error ? error.message : 'Failed to share project');
      }
    },
  },
  {
    name: 'share_task',
    description:
      'Share a task by adding the collaborator to its project (by email or userId) and assigning them.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        email: { type: 'string', description: 'Email of an existing QTask account' },
        collaboratorId: { type: 'string', description: 'User id (alternative to email)' },
        role: {
          type: 'string',
          enum: ['editor', 'executor', 'viewer'],
          description: 'Project role if they are not yet a member (default editor)',
        },
      },
      required: ['taskId'],
    },
    zodShape: {
      taskId: objectIdSchema,
      email: z.string().email().optional(),
      collaboratorId: objectIdSchema.optional(),
      role: z.enum(['editor', 'executor', 'viewer']).optional(),
    },
    async execute(userId, input) {
      try {
        const task = await taskService.getTask(userId, String(input.taskId));
        if (!task) return err('Task not found');
        const projectIds = Array.isArray(task.projectIds)
          ? task.projectIds.map(String)
          : task.projectId
            ? [String(task.projectId)]
            : [];
        if (projectIds.length === 0) return err('Task has no project');
        const projectId = projectIds[0]!;

        const project = await projectService.getProject(userId, projectId);
        if (!project) return err('Project not found');

        let collaboratorUserId = input.collaboratorId as string | undefined;
        const email = input.email as string | undefined;

        const alreadyMember = collaboratorUserId
          ? project.userId === collaboratorUserId ||
            project.collaborators.some((c) => c.userId === collaboratorUserId)
          : email
            ? project.collaborators.some((c) => c.email === email.trim().toLowerCase())
            : false;

        if (!alreadyMember) {
          const shared = await projectService.addCollaborator(userId, projectId, {
            email,
            userId: collaboratorUserId,
            role: (input.role as 'editor' | 'executor' | 'viewer' | undefined) ?? 'editor',
          });
          const added = shared.collaborators.find(
            (c) =>
              (collaboratorUserId && c.userId === collaboratorUserId) ||
              (email && c.email === email.trim().toLowerCase())
          );
          collaboratorUserId = added?.userId;
        } else if (!collaboratorUserId && email) {
          collaboratorUserId = project.collaborators.find(
            (c) => c.email === email.trim().toLowerCase()
          )?.userId;
        }

        if (!collaboratorUserId) {
          return err('Could not resolve collaborator user id');
        }

        const updated = await taskService.updateTask(
          userId,
          String(input.taskId),
          { assigneeId: collaboratorUserId },
          'ai'
        );
        if (!updated) return err('Task not found');
        return ok(
          JSON.stringify(
            { message: 'Collaborator added to project and assigned to task', task: updated },
            null,
            2
          )
        );
      } catch (error) {
        return err(error instanceof Error ? error.message : 'Failed to share task');
      }
    },
  },
  {
    name: 'summarize_project',
    description: 'Generate a natural-language status digest for a project.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
      required: ['projectId'],
    },
    zodShape: {
      projectId: objectIdSchema,
    },
    async execute(userId, input) {
      const summary = await projectService.summarizeProject(userId, String(input.projectId));
      return ok(summary);
    },
  },
  {
    name: 'add_task_link',
    description: 'Link two tasks as related, blocking, or blocked_by.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        linkedTaskId: { type: 'string' },
        type: { type: 'string', enum: ['related', 'blocking', 'blocked_by'] },
      },
      required: ['taskId', 'linkedTaskId', 'type'],
    },
    zodShape: {
      taskId: objectIdSchema,
      linkedTaskId: objectIdSchema,
      type: z.enum(['related', 'blocking', 'blocked_by']),
    },
    async execute(userId, input) {
      const task = await taskService.addLink(
        userId,
        String(input.taskId),
        String(input.linkedTaskId),
        input.type as 'related' | 'blocking' | 'blocked_by'
      );
      if (!task) return err('Task not found');
      return ok(JSON.stringify(task, null, 2));
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project workspace.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Project description' },
      },
      required: ['name'],
    },
    zodShape: {
      name: z.string().min(1).describe('Project name'),
      description: z.string().optional().describe('Project description'),
    },
    async execute(userId, input, context) {
      const project = await projectService.createProject(
        userId,
        String(input.name),
        input.description as string | undefined,
        stagingContext(context)
      );
      return ok(JSON.stringify(project, null, 2));
    },
  },
  {
    name: 'list_projects',
    description: 'List all projects for the user.',
    parameters: {
      type: 'object',
      properties: {},
    },
    zodShape: {},
    async execute(userId) {
      const projects = await projectService.listProjects(userId);
      return ok(JSON.stringify({ count: projects.length, projects }, null, 2));
    },
  },
];

const toolMap = new Map(toolDefinitions.map((t) => [t.name, t]));

export function isKnownTool(name: string): boolean {
  return toolMap.has(name);
}

function normalizeSubtaskItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return item;
  }

  const subtask = { ...(item as Record<string, unknown>) };

  if (!subtask.title) {
    if (typeof subtask.description === 'string' && subtask.description.trim()) {
      subtask.title = subtask.description;
      delete subtask.description;
    } else if (typeof subtask.name === 'string' && subtask.name.trim()) {
      subtask.title = subtask.name;
      delete subtask.name;
    } else if (typeof subtask.task_name === 'string' && subtask.task_name.trim()) {
      subtask.title = subtask.task_name;
      delete subtask.task_name;
    } else if (typeof subtask.taskName === 'string' && subtask.taskName.trim()) {
      subtask.title = subtask.taskName;
      delete subtask.taskName;
    }
  }

  if ('subtasks' in subtask) {
    subtask.subtasks = normalizeSubtasksValue(subtask.subtasks);
  }

  return subtask;
}

function normalizeSubtasksValue(value: unknown): unknown {
  let raw = value;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
      raw = JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  if (!Array.isArray(raw)) {
    return raw;
  }

  return raw.map(normalizeSubtaskItem);
}

export function normalizeToolArgs(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...args };

  if ('parameters' in normalized && typeof normalized.parameters === 'object' && normalized.parameters) {
    Object.assign(normalized, normalized.parameters as Record<string, unknown>);
    delete normalized.parameters;
  }

  if (name === 'create_task' || name === 'update_task') {
    if (!normalized.title && typeof normalized.task_name === 'string') {
      normalized.title = normalized.task_name;
      delete normalized.task_name;
    }
    if (!normalized.title && typeof normalized.taskName === 'string') {
      normalized.title = normalized.taskName;
      delete normalized.taskName;
    }
  }

  if (name === 'create_task' && 'subtasks' in normalized) {
    const subtasks = normalizeSubtasksValue(normalized.subtasks);
    if (subtasks === undefined) {
      delete normalized.subtasks;
    } else {
      normalized.subtasks = subtasks;
    }
  }

  if (name === 'create_project' && !normalized.name && typeof normalized.project_name === 'string') {
    normalized.name = normalized.project_name;
    delete normalized.project_name;
  }
  if (name === 'create_project' && !normalized.name && typeof normalized.title === 'string') {
    normalized.name = normalized.title;
    delete normalized.title;
  }

  for (const key of ['projectId', 'dueDate', 'description', 'taskId', 'assigneeId']) {
    if (normalized[key] === '') {
      delete normalized[key];
    }
  }

  return normalized;
}

function validateToolArgs(
  tool: ToolDefinition,
  args: Record<string, unknown>
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
  const schema = z.object(tool.zodShape);
  const result = schema.safeParse(args);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { success: false, error: `Validation failed: ${issues}` };
  }
  return { success: true, data: result.data as Record<string, unknown> };
}

export function validateToolProposal(
  name: string,
  args: Record<string, unknown>
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
  const tool = toolMap.get(name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  const normalized = normalizeToolArgs(name, args);
  return validateToolArgs(tool, normalized);
}

export function getOllamaTools() {
  return toolDefinitions.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  userId: string,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const start = Date.now();
  const tool = toolMap.get(name);
  if (!tool) {
    log.warn('Unknown tool requested', { name });
    return err(`Unknown tool: ${name}`);
  }

  const normalized = normalizeToolArgs(name, args);
  const validation = validateToolArgs(tool, normalized);
  if (!validation.success) {
    log.warn('Tool validation failed', { name, args: normalized, error: validation.error });
    return err(validation.error);
  }

  try {
    log.debug('Executing tool', { name, args: validation.data });
    const result = await tool.execute(userId, validation.data, context);
    log.info('Tool executed', {
      name,
      success: result.success,
      durationMs: Date.now() - start,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool execution failed';
    log.error('Tool execution error', { name, error: message, durationMs: Date.now() - start });
    return err(message);
  }
}
