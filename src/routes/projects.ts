import { Router } from 'express';
import { z } from 'zod';
import { getUserId } from '../middleware/index.js';
import { validateBody } from '../middleware/validate.js';
import { projectService } from '../services/projectService.js';
import { COLLABORATOR_ROLES } from '../types/project.js';

export const projectsRouter = Router();

const addCollaboratorSchema = z
  .object({
    email: z.string().email().optional(),
    userId: z.string().min(1).optional(),
    role: z.enum(COLLABORATOR_ROLES).optional(),
  })
  .refine((body) => Boolean(body.email || body.userId), {
    message: 'email or userId is required',
  });

const updateCollaboratorSchema = z.object({
  role: z.enum(COLLABORATOR_ROLES),
});

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

projectsRouter.post(
  '/:id/collaborators',
  validateBody(addCollaboratorSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const project = await projectService.addCollaborator(userId, String(req.params.id), req.body);
      res.status(201).json({ project });
    } catch (error) {
      next(error);
    }
  }
);

projectsRouter.patch(
  '/:id/collaborators/:collaboratorUserId',
  validateBody(updateCollaboratorSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const project = await projectService.updateCollaboratorRole(
        userId,
        String(req.params.id),
        String(req.params.collaboratorUserId),
        req.body.role
      );
      res.json({ project });
    } catch (error) {
      next(error);
    }
  }
);

projectsRouter.delete('/:id/collaborators/:collaboratorUserId', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await projectService.removeCollaborator(
      userId,
      String(req.params.id),
      String(req.params.collaboratorUserId)
    );
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
