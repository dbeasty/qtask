import { Router } from 'express';
import { getUserId } from '../middleware/index.js';
import { searchService } from '../services/searchService.js';

export const searchRouter = Router();

searchRouter.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const projectLimit =
      typeof req.query.projectLimit === 'string' ? Number.parseInt(req.query.projectLimit, 10) : undefined;
    const taskLimit =
      typeof req.query.taskLimit === 'string' ? Number.parseInt(req.query.taskLimit, 10) : undefined;

    const results = await searchService.search(userId, q, {
      projectLimit: Number.isFinite(projectLimit) ? projectLimit : undefined,
      taskLimit: Number.isFinite(taskLimit) ? taskLimit : undefined,
    });

    res.json(results);
  } catch (error) {
    next(error);
  }
});
