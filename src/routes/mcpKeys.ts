import { Router } from 'express';
import { z } from 'zod';
import { getUserId } from '../middleware/index.js';
import { validateBody } from '../middleware/validate.js';
import { mcpKeyService } from '../services/mcpKeyService.js';

export const mcpKeysRouter = Router();

const createKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['read', 'read_write']),
});

mcpKeysRouter.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const keys = await mcpKeyService.listKeys(userId);
    res.json({ keys });
  } catch (error) {
    next(error);
  }
});

mcpKeysRouter.post('/', validateBody(createKeySchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await mcpKeyService.createKey(userId, req.body.name, req.body.scope);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

mcpKeysRouter.delete('/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const revoked = await mcpKeyService.revokeKey(userId, req.params.id!);
    if (!revoked) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json({ key: revoked });
  } catch (error) {
    next(error);
  }
});
