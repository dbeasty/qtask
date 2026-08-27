import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { FeedbackModel } from '../models/index.js';
import { enqueueFeedbackVisionJob } from './feedbackVisionQueue.js';
import { SCREENSHOT_REJECTION_MESSAGE } from './feedbackVisionService.js';
import { notificationService } from './notificationService.js';
import { escapeRegex } from './searchUtils.js';
import {
  extensionForContentType,
  getObjectStorage,
  type ObjectStorage,
} from './storage/index.js';

export {
  setScreenshotClassifierForTests,
  classifyScreenshotForFeedback,
  SCREENSHOT_REJECTION_MESSAGE,
} from './feedbackVisionService.js';

export const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type FeedbackValidationStatus = 'pending' | 'validated' | 'rejected' | 'failed';

export interface FeedbackAttachmentInput {
  buffer: Buffer;
  contentType: string;
  sizeBytes: number;
}

export interface FeedbackContextInput {
  url?: string;
  userAgent?: string;
  appVersion?: string;
}

export class FeedbackValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'FeedbackValidationError';
  }
}

function isFeedbackImagesEnabled(): boolean {
  return process.env.FEEDBACK_IMAGES_ENABLED !== 'false';
}

function detectContentType(buffer: Buffer, declaredType: string): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return ALLOWED_IMAGE_TYPES.has(declaredType) ? declaredType : null;
}

function validateAttachment(file: FeedbackAttachmentInput): FeedbackAttachmentInput {
  if (file.sizeBytes > config.feedback.maxAttachmentBytes) {
    throw new FeedbackValidationError('Attachment exceeds maximum size', 400);
  }
  const contentType = detectContentType(file.buffer, file.contentType);
  if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new FeedbackValidationError('Only PNG, JPEG, and WebP images are allowed', 400);
  }
  return { ...file, contentType };
}

async function storeAttachment(
  storage: ObjectStorage,
  file: FeedbackAttachmentInput
): Promise<{ storageKey: string; contentType: string; sizeBytes: number }> {
  const validated = validateAttachment(file);
  const ext = extensionForContentType(validated.contentType);
  const storageKey = `feedback/${randomUUID()}.${ext}`;

  await storage.put(storageKey, validated.buffer, validated.contentType);

  return {
    storageKey,
    contentType: validated.contentType,
    sizeBytes: validated.sizeBytes,
  };
}

export async function createFeedback(input: {
  userId: string;
  message: string;
  category?: 'bug' | 'feature' | 'other';
  context?: FeedbackContextInput;
  attachments: FeedbackAttachmentInput[];
  storage?: ObjectStorage;
}) {
  const imagesEnabled = isFeedbackImagesEnabled();
  const message = input.message.trim();
  if (!message) {
    throw new FeedbackValidationError('Message is required', 400);
  }

  if (imagesEnabled) {
    if (input.attachments.length === 0) {
      throw new FeedbackValidationError('At least one screenshot is required', 400);
    }
  } else if (input.attachments.length > 0) {
    throw new FeedbackValidationError('Screenshot attachments are not enabled', 400);
  }

  if (input.attachments.length > config.feedback.maxAttachments) {
    throw new FeedbackValidationError(
      `At most ${config.feedback.maxAttachments} attachments are allowed`,
      400
    );
  }

  const storage = input.storage ?? getObjectStorage();

  if (!imagesEnabled) {
    const doc = await FeedbackModel.create({
      userId: input.userId,
      message,
      category: input.category ?? 'other',
      context: input.context ?? {},
      attachments: [],
      validationStatus: 'validated',
    });
    return doc.toObject();
  }

  const storedAttachments = [];
  const storedKeys: string[] = [];

  try {
    for (const attachment of input.attachments) {
      const stored = await storeAttachment(storage, attachment);
      storedKeys.push(stored.storageKey);
      storedAttachments.push(stored);
    }
  } catch (error) {
    await Promise.all(storedKeys.map((key) => storage.delete(key).catch(() => undefined)));
    throw error;
  }

  const doc = await FeedbackModel.create({
    userId: input.userId,
    message,
    category: input.category ?? 'other',
    context: input.context ?? {},
    attachments: storedAttachments,
    validationStatus: 'pending',
  });

  await enqueueFeedbackVisionJob(String(doc._id));

  return doc.toObject();
}

export async function getFeedbackForUser(userId: string, feedbackId: string) {
  const doc = await FeedbackModel.findOne({ _id: feedbackId, userId }).lean();
  if (!doc) return null;
  return doc;
}

export async function listUserFeedback(userId: string, page: number, limit: number) {
  const skip = (page - 1) * limit;
  const [total, items] = await Promise.all([
    FeedbackModel.countDocuments({ userId }),
    FeedbackModel.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);
  return { page, limit, total, items };
}

export async function deleteFeedbackForUser(userId: string, storage?: ObjectStorage): Promise<number> {
  const store = storage ?? getObjectStorage();
  const docs = await FeedbackModel.find({ userId }).lean();
  await Promise.all(
    docs.flatMap((doc) =>
      (doc.attachments ?? []).map((attachment) => store.delete(attachment.storageKey).catch(() => undefined))
    )
  );
  const result = await FeedbackModel.deleteMany({ userId });
  return result.deletedCount ?? 0;
}

export async function listAdminFeedback(params: {
  page: number;
  limit: number;
  status?: 'open' | 'read' | 'resolved';
  search?: string;
  from?: Date;
  to?: Date;
}) {
  const filter: Record<string, unknown> = {};
  if (params.status) filter.status = params.status;
  if (params.from || params.to) {
    filter.createdAt = {
      ...(params.from ? { $gte: params.from } : {}),
      ...(params.to ? { $lte: params.to } : {}),
    };
  }

  if (params.search) {
    const searchPattern = escapeRegex(params.search);
    const { UserModel } = await import('../models/index.js');
    const users = await UserModel.find(
      {
        $or: [
          { email: { $regex: searchPattern, $options: 'i' } },
          { displayName: { $regex: searchPattern, $options: 'i' } },
        ],
      },
      { _id: 1 }
    ).lean();
    const userIds = users.map((user) => String(user._id));
    filter.$or = [{ message: { $regex: searchPattern, $options: 'i' } }, { userId: { $in: userIds } }];
  }

  const skip = (params.page - 1) * params.limit;
  const [total, items] = await Promise.all([
    FeedbackModel.countDocuments(filter),
    FeedbackModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(params.limit).lean(),
  ]);

  const { UserModel } = await import('../models/index.js');
  const userIds = [...new Set(items.map((item) => item.userId))];
  const users = await UserModel.find({ _id: { $in: userIds } }, { email: 1, displayName: 1 }).lean();
  const userMap = new Map(users.map((user) => [String(user._id), user]));

  return {
    page: params.page,
    limit: params.limit,
    total,
    items: items.map((item) => ({
      ...item,
      userEmail: userMap.get(item.userId)?.email,
      userDisplayName: userMap.get(item.userId)?.displayName ?? null,
    })),
  };
}

export async function getAdminFeedbackById(id: string) {
  const doc = await FeedbackModel.findById(id).lean();
  if (!doc) return null;
  const { UserModel } = await import('../models/index.js');
  const user = await UserModel.findById(doc.userId, { email: 1, displayName: 1 }).lean();
  return {
    ...doc,
    userEmail: user?.email,
    userDisplayName: user?.displayName ?? null,
  };
}

export async function updateFeedbackStatus(id: string, status: 'open' | 'read' | 'resolved') {
  const doc = await FeedbackModel.findByIdAndUpdate(id, { $set: { status } }, { new: true }).lean();
  return doc;
}

export async function replyToFeedback(id: string, replyMessage: string) {
  const message = replyMessage.trim();
  if (!message) {
    throw new FeedbackValidationError('Reply message is required', 400);
  }
  if (message.length > 2000) {
    throw new FeedbackValidationError('Reply message is too long', 400);
  }

  const existing = await FeedbackModel.findById(id).lean();
  if (!existing) return null;
  if (existing.adminReply) {
    throw new FeedbackValidationError('Feedback already has a reply', 409);
  }

  const repliedAt = new Date();
  const doc = await FeedbackModel.findByIdAndUpdate(
    id,
    {
      $set: {
        status: 'resolved',
        adminReply: { message, repliedAt },
      },
    },
    { new: true }
  ).lean();

  if (!doc) return null;

  await notificationService.createNotification(existing.userId, 'feedback_reply', {
    feedbackId: id,
    message: existing.message.slice(0, 200),
    reply: message,
  });

  return doc;
}

export async function updateAdminFeedback(
  id: string,
  input: { status?: 'open' | 'read' | 'resolved'; reply?: string }
) {
  if (input.reply !== undefined) {
    return replyToFeedback(id, input.reply);
  }
  if (input.status !== undefined) {
    return updateFeedbackStatus(id, input.status);
  }
  throw new FeedbackValidationError('Status or reply is required', 400);
}

export async function getFeedbackAttachment(id: string, index: number, storage?: ObjectStorage) {
  const doc = await FeedbackModel.findById(id).lean();
  if (!doc) return null;
  const attachment = doc.attachments?.[index];
  if (!attachment) return null;
  const store = storage ?? getObjectStorage();
  const object = await store.get(attachment.storageKey);
  if (!object) return null;
  return { object, attachment };
}
