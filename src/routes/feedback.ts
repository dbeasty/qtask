import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config/index.js';
import { APP_VERSION } from '../version.js';
import {
  createFeedback,
  FeedbackValidationError,
  getFeedbackForUser,
  listUserFeedback,
} from '../services/feedbackService.js';

const router = Router();

function requireFeedbackEnabled(req: Request, res: Response, next: NextFunction): void {
  if (process.env.FEEDBACK_ENABLED === 'false') {
    res.status(503).json({ error: 'Feedback is not available.' });
    return;
  }
  next();
}

router.use(requireFeedbackEnabled);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.feedback.maxAttachmentBytes,
    files: config.feedback.maxAttachments,
  },
});

const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: config.nodeEnv === 'test' ? 10_000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth!.userId,
  message: { error: 'Too many feedback submissions, please try again later' },
});

const categorySchema = z.enum(['bug', 'feature', 'other']).optional();

router.post('/', feedbackLimiter, upload.array('attachments', config.feedback.maxAttachments), async (req, res, next) => {
  try {
    const message = typeof req.body.message === 'string' ? req.body.message : '';
    const category = categorySchema.parse(
      typeof req.body.category === 'string' ? req.body.category : undefined
    );
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    const feedback = await createFeedback({
      userId: req.auth!.userId,
      message,
      category,
      context: {
        url: typeof req.body.url === 'string' ? req.body.url.slice(0, 2000) : undefined,
        userAgent: typeof req.body.userAgent === 'string' ? req.body.userAgent.slice(0, 1000) : undefined,
        appVersion: typeof req.body.appVersion === 'string' ? req.body.appVersion.slice(0, 100) : APP_VERSION,
      },
      attachments: files.map((file) => ({
        buffer: file.buffer,
        contentType: file.mimetype,
        sizeBytes: file.size,
      })),
    });

    res.status(201).json({
      id: String(feedback._id),
      message: feedback.message,
      category: feedback.category,
      status: feedback.status,
      validationStatus: feedback.validationStatus ?? 'validated',
      createdAt: feedback.createdAt,
      attachmentCount: feedback.attachments?.length ?? 0,
    });
  } catch (error) {
    if (error instanceof FeedbackValidationError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'Attachment exceeds maximum size' });
        return;
      }
      if (error.code === 'LIMIT_FILE_COUNT') {
        res.status(400).json({ error: `At most ${config.feedback.maxAttachments} attachments are allowed` });
        return;
      }
      res.status(400).json({ error: 'Invalid upload' });
      return;
    }
    next(error);
  }
});

router.get('/mine', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const result = await listUserFeedback(req.auth!.userId, page, limit);
    res.json({
      ...result,
      items: result.items.map((item) => ({
        id: String(item._id),
        message: item.message,
        category: item.category,
        status: item.status,
        validationStatus: item.validationStatus ?? 'validated',
        createdAt: item.createdAt,
        attachmentCount: item.attachments?.length ?? 0,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const feedbackId = String(req.params.id);
    const feedback = await getFeedbackForUser(req.auth!.userId, feedbackId);
    if (!feedback) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }
    res.json({
      id: String(feedback._id),
      message: feedback.message,
      category: feedback.category,
      status: feedback.status,
      validationStatus: feedback.validationStatus ?? 'validated',
      createdAt: feedback.createdAt,
      attachmentCount: feedback.attachments?.length ?? 0,
    });
  } catch (error) {
    next(error);
  }
});

export const feedbackRouter = router;
