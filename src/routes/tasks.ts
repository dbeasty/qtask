import { Router } from 'express';
import { z } from 'zod';
import { getUserId } from '../middleware/index.js';
import { validateBody } from '../middleware/validate.js';
import { getActivityForTask } from '../services/activityService.js';
import { commentService } from '../services/commentService.js';
import { taskService } from '../services/taskService.js';
import type { TaskLinkType } from '../types/task.js';

export const tasksRouter = Router();

const createCommentSchema = z.object({
  body: z.string().trim().min(1, 'body is required').max(10000),
  subtaskPath: z.array(z.string()).optional(),
  parentId: z.string().optional(),
  notifyByEmail: z.boolean().optional(),
});

const updateCommentSchema = z.object({
  body: z.string().trim().min(1, 'body is required').max(10000),
});

const taskStepInputSchema = z.object({
  _id: z.string().optional(),
  text: z.string(),
  done: z.boolean().optional(),
});

const materialLineInputSchema = z.object({
  _id: z.string().optional(),
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
});

const laborLineInputSchema = z.object({
  _id: z.string().optional(),
  description: z.string().optional(),
  hours: z.number(),
});

const taskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'cancelled']);
const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
const progressFieldSchema = z.enum(['percent', 'hoursSpent', 'hoursRemaining']);

function dueDateSchema() {
  return z.union([z.string(), z.date()]).refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: 'dueDate must be a valid date',
  });
}

type CreateSubtaskBody = {
  title: string;
  description?: string;
  steps?: z.infer<typeof taskStepInputSchema>[];
  status?: z.infer<typeof taskStatusSchema>;
  priority?: z.infer<typeof taskPrioritySchema>;
  dueDate?: string | Date;
  tags?: string[];
  percentComplete?: number;
  percentCompleteOverride?: number;
  progressShare?: number;
  hoursSpent?: number;
  hoursRemaining?: number;
  lastProgressField?: z.infer<typeof progressFieldSchema>;
  materials?: z.infer<typeof materialLineInputSchema>[];
  laborLines?: z.infer<typeof laborLineInputSchema>[];
  hourlyRate?: number;
  subtasks?: CreateSubtaskBody[];
};

const createSubtaskSchema: z.ZodType<CreateSubtaskBody> = z.lazy(() =>
  z.object({
    title: z.string().trim().min(1, 'title is required'),
    description: z.string().optional(),
    steps: z.array(taskStepInputSchema).optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    dueDate: dueDateSchema().optional(),
    tags: z.array(z.string()).optional(),
    percentComplete: z.number().optional(),
    percentCompleteOverride: z.number().optional(),
    progressShare: z.number().optional(),
    hoursSpent: z.number().optional(),
    hoursRemaining: z.number().optional(),
    lastProgressField: progressFieldSchema.optional(),
    materials: z.array(materialLineInputSchema).optional(),
    laborLines: z.array(laborLineInputSchema).optional(),
    hourlyRate: z.number().optional(),
    subtasks: z.array(createSubtaskSchema).optional(),
  })
);

const createTaskSchema = z.object({
  title: z.string().trim().min(1, 'title is required'),
  description: z.string().optional(),
  steps: z.array(taskStepInputSchema).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: dueDateSchema().optional(),
  tags: z.array(z.string()).optional(),
  percentComplete: z.number().optional(),
  percentCompleteOverride: z.number().optional(),
  progressShare: z.number().optional(),
  hoursSpent: z.number().optional(),
  hoursRemaining: z.number().optional(),
  lastProgressField: progressFieldSchema.optional(),
  materials: z.array(materialLineInputSchema).optional(),
  laborLines: z.array(laborLineInputSchema).optional(),
  hourlyRate: z.number().optional(),
  projectId: z.string().optional(),
  projectIds: z.array(z.string()).optional(),
  subtasks: z.array(createSubtaskSchema).optional(),
});

const updateTaskSchema = z.object({
  title: z.string().trim().min(1, 'title cannot be empty').optional(),
  description: z.string().optional(),
  steps: z.array(taskStepInputSchema).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: dueDateSchema().nullable().optional(),
  tags: z.array(z.string()).optional(),
  percentComplete: z.number().optional(),
  percentCompleteOverride: z.number().nullable().optional(),
  progressShare: z.number().nullable().optional(),
  hoursSpent: z.number().nullable().optional(),
  hoursRemaining: z.number().nullable().optional(),
  lastProgressField: progressFieldSchema.nullable().optional(),
  materials: z.array(materialLineInputSchema).optional(),
  laborLines: z.array(laborLineInputSchema).optional(),
  hourlyRate: z.number().nullable().optional(),
  projectId: z.string().nullable().optional(),
  projectIds: z.array(z.string()).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
});

const updateSubtaskSchema = z.object({
  title: z.string().trim().min(1, 'title cannot be empty').optional(),
  description: z.string().optional(),
  steps: z.array(taskStepInputSchema).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: dueDateSchema().nullable().optional(),
  tags: z.array(z.string()).optional(),
  percentComplete: z.number().optional(),
  percentCompleteOverride: z.number().nullable().optional(),
  progressShare: z.number().nullable().optional(),
  hoursSpent: z.number().nullable().optional(),
  hoursRemaining: z.number().nullable().optional(),
  lastProgressField: progressFieldSchema.nullable().optional(),
  materials: z.array(materialLineInputSchema).optional(),
  laborLines: z.array(laborLineInputSchema).optional(),
  hourlyRate: z.number().nullable().optional(),
});

function parseSubtaskPathQuery(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.split(',').filter(Boolean);
}

function parseKeepChildren(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

const DEFAULT_TASKS_PAGE_LIMIT = 200;
const MAX_TASKS_PAGE_LIMIT = 500;

function parseLimitParam(value: unknown): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TASKS_PAGE_LIMIT;
  return Math.min(parsed, MAX_TASKS_PAGE_LIMIT);
}

function parseOffsetParam(value: unknown): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

tasksRouter.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { status, priority, projectId, assigneeId, tags, dueBefore, dueAfter, query } = req.query;

    // A default limit applies even when the client sends none, so a
    // single request can never pull an unbounded number of tasks into
    // one response — the previous behavior for an account with many
    // tasks.
    const limit = parseLimitParam(req.query.limit);
    const offset = parseOffsetParam(req.query.offset);

    const { tasks, total } = await taskService.listTasks(
      userId,
      {
        status: status as never,
        priority: priority as never,
        projectId: projectId as string | undefined,
        assigneeId: assigneeId as string | undefined,
        tags: tags ? String(tags).split(',') : undefined,
        dueBefore: dueBefore as string | undefined,
        dueAfter: dueAfter as string | undefined,
        query: query as string | undefined,
      },
      { limit, offset }
    );

    res.json({ tasks, total, limit, offset });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/', validateBody(createTaskSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const task = await taskService.createTask(userId, req.body);
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/workload', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const assigneeId = req.query.assigneeId as string | undefined;
    const workload = await taskService.getWorkload(userId, assigneeId);
    res.json({ workload });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const task = await taskService.getTask(userId, req.params.id!);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.patch('/:id', validateBody(updateTaskSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const task = await taskService.updateTask(userId, String(req.params.id), req.body);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/move-project', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.body as { projectId?: string };
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    const task = await taskService.moveTaskToProject(userId, req.params.id!, projectId);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/share-project', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.body as { projectId?: string };
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    const task = await taskService.shareTaskToProject(userId, req.params.id!, projectId);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/unlink-project', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.body as { projectId?: string };
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    const task = await taskService.unlinkTaskFromProject(userId, req.params.id!, projectId);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/duplicate', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { projectId } = req.body as { projectId?: string };
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    const task = await taskService.duplicateTask(userId, req.params.id!, projectId);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.delete('/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const keepChildren = parseKeepChildren(req.query.keepChildren);
    const result = await taskService.deleteTask(userId, req.params.id!, { keepChildren });
    if (!result) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    if (keepChildren) {
      res.json({ promotedTasks: result.promotedTasks });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/links', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { linkedTaskId, type } = req.body as { linkedTaskId: string; type: TaskLinkType };

    if (!linkedTaskId || !type) {
      res.status(400).json({ error: 'linkedTaskId and type are required' });
      return;
    }

    const task = await taskService.addLink(userId, req.params.id!, linkedTaskId, type);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.delete('/:id/links/:linkedTaskId/:type', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const task = await taskService.removeLink(
      userId,
      req.params.id!,
      req.params.linkedTaskId!,
      req.params.type! as TaskLinkType
    );
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/subtasks', validateBody(createSubtaskSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const path = (req.query.path as string)?.split(',').filter(Boolean) ?? [];
    const task = await taskService.addSubtask(userId, String(req.params.id), path, req.body);
    if (!task) {
      res.status(404).json({ error: 'Task or parent subtask not found' });
      return;
    }
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.patch('/:id/subtasks', validateBody(updateSubtaskSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const path = (req.query.path as string)?.split(',').filter(Boolean) ?? [];
    if (path.length === 0) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const task = await taskService.updateSubtask(userId, String(req.params.id), path, req.body);
    if (!task) {
      res.status(404).json({ error: 'Task or subtask not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/subtasks/promote', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const path = (req.query.path as string)?.split(',').filter(Boolean) ?? [];
    if (path.length === 0) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    const result = await taskService.promoteSubtaskToTask(userId, req.params.id!, path);
    if (!result) {
      res.status(404).json({ error: 'Task or subtask not found' });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/subtasks/attach-task', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { sourceTaskId, parentPath, index } = req.body as {
      sourceTaskId?: string;
      parentPath?: string[];
      index?: number;
    };

    if (!sourceTaskId) {
      res.status(400).json({ error: 'sourceTaskId is required' });
      return;
    }
    if (!Array.isArray(parentPath)) {
      res.status(400).json({ error: 'parentPath is required' });
      return;
    }

    const result = await taskService.attachTaskAsSubtask(userId, req.params.id!, {
      sourceTaskId,
      parentPath,
      index,
    });
    if (!result) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cannot attach')) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes('same project')) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

tasksRouter.post('/:id/subtasks/move', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { fromPath, toParentPath, index } = req.body as {
      fromPath?: string[];
      toParentPath?: string[];
      index?: number;
    };

    if (!fromPath?.length) {
      res.status(400).json({ error: 'fromPath is required' });
      return;
    }
    if (!Array.isArray(toParentPath)) {
      res.status(400).json({ error: 'toParentPath is required' });
      return;
    }

    const task = await taskService.moveSubtask(userId, req.params.id!, {
      fromPath,
      toParentPath,
      index,
    });
    if (!task) {
      res.status(404).json({ error: 'Task or subtask not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cannot move')) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

tasksRouter.delete('/:id/subtasks', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const path = (req.query.path as string)?.split(',').filter(Boolean) ?? [];
    if (path.length === 0) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const keepChildren = parseKeepChildren(req.query.keepChildren);
    const task = await taskService.deleteSubtask(userId, req.params.id!, path, { keepChildren });
    if (!task) {
      res.status(404).json({ error: 'Task or subtask not found' });
      return;
    }
    if (keepChildren) {
      res.json({ task });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id/activity', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const task = await taskService.getTask(userId, req.params.id!);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    const activity = await getActivityForTask(req.params.id!);
    res.json({ activity });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id/comments', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const comments = await commentService.listComments(userId, req.params.id!, {
      subtaskPath: parseSubtaskPathQuery(req.query.subtaskPath),
    });
    res.json({ comments });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/:id/comments', validateBody(createCommentSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const comment = await commentService.createComment(userId, String(req.params.id), req.body);
    res.status(201).json({ comment });
  } catch (error) {
    next(error);
  }
});

tasksRouter.patch(
  '/:id/comments/:commentId',
  validateBody(updateCommentSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const comment = await commentService.updateComment(
        userId,
        String(req.params.id),
        String(req.params.commentId),
        req.body
      );
      res.json({ comment });
    } catch (error) {
      next(error);
    }
  }
);

tasksRouter.delete('/:id/comments/:commentId', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await commentService.deleteComment(userId, String(req.params.id), String(req.params.commentId));
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
