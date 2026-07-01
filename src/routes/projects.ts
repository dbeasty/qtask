import { Router } from 'express';
import { getUserId } from '../middleware/index.js';
import { projectService } from '../services/projectService.js';

export const projectsRouter = Router();

projectsRouter.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const projects = await projectService.listProjects(userId);
    res.json({ projects });
  } catch (error) {
    next(error);
  }
});

projectsRouter.post('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const project = await projectService.createProject(userId, name, description);
    res.status(201).json({ project });
  } catch (error) {
    next(error);
  }
});

projectsRouter.patch('/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { name, description } = req.body as { name?: string; description?: string | null };
    const project = await projectService.updateProject(userId, req.params.id!, { name, description });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ project });
  } catch (error) {
    if (error instanceof Error && error.message.includes('cannot be empty')) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

projectsRouter.get('/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const project = await projectService.getProject(userId, req.params.id!);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

projectsRouter.delete('/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await projectService.deleteProject(userId, req.params.id!);
    if (!result) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

projectsRouter.get('/:id/summary', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const summary = await projectService.summarizeProject(userId, req.params.id!);
    res.json({ summary });
  } catch (error) {
    next(error);
  }
});

projectsRouter.post('/:id/tasks/reorder', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { taskId, index } = req.body as { taskId?: string; index?: number };

    if (!taskId || typeof index !== 'number') {
      res.status(400).json({ error: 'taskId and index are required' });
      return;
    }

    const { taskService } = await import('../services/taskService.js');
    const tasks = await taskService.reorderProjectTask(userId, req.params.id!, taskId, index);
    if (!tasks) {
      res.status(404).json({ error: 'Project or task not found' });
      return;
    }
    res.json({ tasks });
  } catch (error) {
    next(error);
  }
});
