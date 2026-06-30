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

projectsRouter.get('/:id/summary', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const summary = await projectService.summarizeProject(userId, req.params.id!);
    res.json({ summary });
  } catch (error) {
    next(error);
  }
});
