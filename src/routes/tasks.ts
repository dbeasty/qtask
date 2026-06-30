import { Router } from 'express';
import { getUserId } from '../middleware/index.js';
import { getActivityForTask } from '../services/activityService.js';
import { taskService } from '../services/taskService.js';
import type { TaskLinkType } from '../types/task.js';

export const tasksRouter = Router();

tasksRouter.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { status, priority, projectId, assigneeId, tags, dueBefore, dueAfter, query } = req.query;

    const tasks = await taskService.listTasks(userId, {
      status: status as never,
      priority: priority as never,
      projectId: projectId as string | undefined,
      assigneeId: assigneeId as string | undefined,
      tags: tags ? String(tags).split(',') : undefined,
      dueBefore: dueBefore as string | undefined,
      dueAfter: dueAfter as string | undefined,
      query: query as string | undefined,
    });

    res.json({ tasks });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post('/', async (req, res, next) => {
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

tasksRouter.patch('/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const task = await taskService.updateTask(userId, req.params.id!, req.body);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.delete('/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const deleted = await taskService.deleteTask(userId, req.params.id!);
    if (!deleted) {
      res.status(404).json({ error: 'Task not found' });
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

tasksRouter.post('/:id/subtasks', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const path = (req.query.path as string)?.split(',').filter(Boolean) ?? [];
    const task = await taskService.addSubtask(userId, req.params.id!, path, req.body);
    if (!task) {
      res.status(404).json({ error: 'Task or parent subtask not found' });
      return;
    }
    res.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

tasksRouter.patch('/:id/subtasks', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const path = (req.query.path as string)?.split(',').filter(Boolean) ?? [];
    if (path.length === 0) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const task = await taskService.updateSubtask(userId, req.params.id!, path, req.body);
    if (!task) {
      res.status(404).json({ error: 'Task or subtask not found' });
      return;
    }
    res.json({ task });
  } catch (error) {
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
    const task = await taskService.deleteSubtask(userId, req.params.id!, path);
    if (!task) {
      res.status(404).json({ error: 'Task or subtask not found' });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

tasksRouter.get('/:id/activity', async (req, res, next) => {
  try {
    const activity = await getActivityForTask(req.params.id!);
    res.json({ activity });
  } catch (error) {
    next(error);
  }
});
