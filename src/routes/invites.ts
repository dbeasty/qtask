import { Router } from 'express';
import { z } from 'zod';
import { getUserId } from '../middleware/index.js';
import { validateBody } from '../middleware/validate.js';
import { inviteService } from '../services/inviteService.js';

export const invitesRouter = Router();

const acceptByTokenSchema = z.object({
  token: z.string().min(1),
});

invitesRouter.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const status = req.query.status === 'all' ? 'all' : 'pending';
    const invites = await inviteService.listInvitesForUser(userId, status);
    res.json({ invites });
  } catch (error) {
    next(error);
  }
});

invitesRouter.get('/preview/:token', async (req, res, next) => {
  try {
    const invite = await inviteService.getInvitePreview(String(req.params.token));
    res.json({ invite });
  } catch (error) {
    next(error);
  }
});

invitesRouter.post('/:id/accept', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await inviteService.acceptInvite(userId, String(req.params.id));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

invitesRouter.post(
  '/accept-by-token',
  validateBody(acceptByTokenSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const result = await inviteService.acceptInviteByToken(userId, req.body.token);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

invitesRouter.post('/:id/decline', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const invite = await inviteService.declineInvite(userId, String(req.params.id));
    res.json({ invite });
  } catch (error) {
    next(error);
  }
});
