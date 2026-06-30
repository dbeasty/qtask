import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from '../config/index.js';
import { connectDb } from '../db/connection.js';
import { projectService } from '../services/projectService.js';
import { taskService } from '../services/taskService.js';
import { startEmbeddingWorker } from '../services/embeddingQueue.js';

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

export async function createMcpServer(userId = config.defaultUserId): Promise<McpServer> {
  const server = new McpServer({
    name: 'qtask',
    version: '0.1.0',
  });

  server.tool(
    'create_task',
    'Create a task, optionally with nested subtasks from a natural-language goal breakdown.',
    {
      title: z.string().min(1).describe('Task title'),
      description: z.string().optional().describe('Task description'),
      status: taskStatusSchema.optional(),
      priority: taskPrioritySchema.optional(),
      dueDate: z.string().optional().describe('ISO 8601 due date'),
      tags: z.array(z.string()).optional(),
      projectId: z.string().optional(),
      subtasks: z.array(subtaskInputSchema).optional().describe('Nested subtasks'),
    },
    async (input) => {
      const task = await taskService.createTask(userId, input as Parameters<typeof taskService.createTask>[1], 'ai');
      return {
        content: [{ type: 'text', text: JSON.stringify(task, null, 2) }],
      };
    }
  );

  server.tool(
    'update_task',
    'Update task fields such as status, priority, due date, or percent complete.',
    {
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
    async (input) => {
      const { taskId, ...updates } = input;
      const task = await taskService.updateTask(userId, taskId, updates, 'ai');
      if (!task) {
        return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(task, null, 2) }],
      };
    }
  );

  server.tool(
    'find_tasks',
    'Hybrid structured + semantic search for tasks by status, priority, project, tags, due date, or natural-language query.',
    {
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
    async (input) => {
      const { limit, ...filters } = input;
      const tasks = await taskService.findTasks(userId, filters, limit ?? 20);
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: tasks.length, tasks }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_task',
    'Fetch a single task with its subtasks and links.',
    {
      taskId: z.string().describe('Task ID'),
    },
    async ({ taskId }) => {
      const task = await taskService.getTask(userId, taskId);
      if (!task) {
        return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(task, null, 2) }],
      };
    }
  );

  server.tool(
    'get_workload',
    'List open tasks for a user with status and percent complete.',
    {
      assigneeId: z.string().optional().describe('Filter by assignee; defaults to all open tasks'),
    },
    async ({ assigneeId }) => {
      const workload = await taskService.getWorkload(userId, assigneeId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: workload.length, workload }, null, 2) }],
      };
    }
  );

  server.tool(
    'assign_task',
    'Assign a task to a user (Phase 1: sets assigneeId on the task).',
    {
      taskId: z.string(),
      assigneeId: z.string(),
    },
    async ({ taskId, assigneeId }) => {
      const task = await taskService.updateTask(userId, taskId, { assigneeId }, 'ai');
      if (!task) {
        return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(task, null, 2) }],
      };
    }
  );

  server.tool(
    'share_task',
    'Share a task with a collaborator by assigning them (Phase 1 placeholder for collaboration).',
    {
      taskId: z.string(),
      collaboratorId: z.string(),
    },
    async ({ taskId, collaboratorId }) => {
      const task = await taskService.updateTask(userId, taskId, { assigneeId: collaboratorId }, 'ai');
      if (!task) {
        return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'Task shared via assigneeId', task }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'summarize_project',
    'Generate a natural-language status digest for a project.',
    {
      projectId: z.string(),
    },
    async ({ projectId }) => {
      const summary = await projectService.summarizeProject(userId, projectId);
      return {
        content: [{ type: 'text', text: summary }],
      };
    }
  );

  server.tool(
    'add_task_link',
    'Link two tasks as related, blocking, or blocked_by.',
    {
      taskId: z.string(),
      linkedTaskId: z.string(),
      type: z.enum(['related', 'blocking', 'blocked_by']),
    },
    async ({ taskId, linkedTaskId, type }) => {
      const task = await taskService.addLink(userId, taskId, linkedTaskId, type);
      if (!task) {
        return { content: [{ type: 'text', text: 'Task not found' }], isError: true };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(task, null, 2) }],
      };
    }
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  await connectDb();
  startEmbeddingWorker();

  const server = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
