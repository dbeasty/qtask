import { Router } from 'express';
import { z } from 'zod';
import { getUserId } from '../middleware/index.js';
import { validateBody } from '../middleware/validate.js';
import { mcpOAuthClientService } from '../services/mcpOAuthClientService.js';

export const mcpOAuthClientsRouter = Router();

const createClientSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

mcpOAuthClientsRouter.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const clients = await mcpOAuthClientService.listRegisteredClients(userId);
    res.json({ clients });
  } catch (error) {
    next(error);
  }
});

mcpOAuthClientsRouter.post('/', validateBody(createClientSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await mcpOAuthClientService.createRegisteredClient(userId, req.body.name);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

mcpOAuthClientsRouter.delete('/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const revoked = await mcpOAuthClientService.revokeRegisteredClient(userId, req.params.id!);
    if (!revoked) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    res.json({ client: revoked });
  } catch (error) {
    next(error);
  }
});
