import { z } from 'zod';
import { projectService } from '../services/projectService.js';
import { taskService } from '../services/taskService.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tools');

const taskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'cancelled']);
const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);

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
  execute: (userId: string, args: Record<string, unknown>) => Promise<ToolResult>;
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
          description: 'Nested subtasks',
          items: { type: 'object' },
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
      projectId: z.string().optional(),
      subtasks: z.array(subtaskInputSchema).optional().describe('Nested subtasks'),
    },
    async execute(userId, input) {
      const task = await taskService.createTask(
        userId,
        input as unknown as Parameters<typeof taskService.createTask>[1],
        'ai'
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
        taskId: { type: 'string', description: 'Task ID to update' },
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
      taskId: z.string().describe('Task ID to update'),
      title: z.string().optional(),
      description: z.string().optional(),
      status: taskStatusSchema.optional(),
      priority: taskPrioritySchema.optional(),
      dueDate: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      percentComplete: z.number().min(0).max(100).optional(),
      percentCompleteOverride: z.number().min(0).max(100).nullable().optional(),
      projectId: z.string().nullable().optional(),
      assigneeId: z.string().nullable().optional(),
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
      projectId: z.string().optional(),
      assigneeId: z.string().optional(),
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
        taskId: { type: 'string', description: 'Task ID' },
      },
      required: ['taskId'],
    },
    zodShape: {
      taskId: z.string().describe('Task ID'),
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
      assigneeId: z.string().optional().describe('Filter by assignee; defaults to all open tasks'),
    },
    async execute(userId, input) {
      const workload = await taskService.getWorkload(userId, input.assigneeId as string | undefined);
      return ok(JSON.stringify({ count: workload.length, workload }, null, 2));
    },
  },
  {
    name: 'assign_task',
    description: 'Assign a task to a user (Phase 1: sets assigneeId on the task).',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        assigneeId: { type: 'string' },
      },
      required: ['taskId', 'assigneeId'],
    },
    zodShape: {
      taskId: z.string(),
      assigneeId: z.string(),
    },
    async execute(userId, input) {
      const task = await taskService.updateTask(
        userId,
        String(input.taskId),
        { assigneeId: String(input.assigneeId) },
        'ai'
      );
      if (!task) return err('Task not found');
      return ok(JSON.stringify(task, null, 2));
    },
  },
  {
    name: 'share_task',
    description: 'Share a task with a collaborator by assigning them (Phase 1 placeholder for collaboration).',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        collaboratorId: { type: 'string' },
      },
      required: ['taskId', 'collaboratorId'],
    },
    zodShape: {
      taskId: z.string(),
      collaboratorId: z.string(),
    },
    async execute(userId, input) {
      const task = await taskService.updateTask(
        userId,
        String(input.taskId),
        { assigneeId: String(input.collaboratorId) },
        'ai'
      );
      if (!task) return err('Task not found');
      return ok(JSON.stringify({ message: 'Task shared via assigneeId', task }, null, 2));
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
      projectId: z.string(),
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
      taskId: z.string(),
      linkedTaskId: z.string(),
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
    async execute(userId, input) {
      const project = await projectService.createProject(
        userId,
        String(input.name),
        input.description as string | undefined
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

  if (name === 'create_project' && !normalized.name && typeof normalized.project_name === 'string') {
    normalized.name = normalized.project_name;
    delete normalized.project_name;
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
  userId: string
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
    const result = await tool.execute(userId, validation.data);
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
