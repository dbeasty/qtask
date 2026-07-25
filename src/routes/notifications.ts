import { Router } from 'express';
import { getUserId } from '../middleware/index.js';
import { notificationService } from '../services/notificationService.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const notifications = await notificationService.listNotifications(userId);
    res.json({ notifications });
  } catch (error) {
    next(error);
  }
});

notificationsRouter.get('/unread-count', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const count = await notificationService.unreadCount(userId);
    res.json({ count });
  } catch (error) {
    next(error);
  }
});

notificationsRouter.patch('/:id/read', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const notification = await notificationService.markRead(userId, String(req.params.id));
    res.json({ notification });
  } catch (error) {
    next(error);
  }
});

notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const count = await notificationService.markAllRead(userId);
    res.json({ count });
  } catch (error) {
    next(error);
  }
});
