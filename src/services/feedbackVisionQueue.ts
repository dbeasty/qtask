import { FeedbackModel, FeedbackVisionJobModel } from '../models/index.js';
import {
  classifyScreenshotForFeedback,
  SCREENSHOT_REJECTION_MESSAGE,
} from './feedbackVisionService.js';
import { notificationService } from './notificationService.js';
import { getObjectStorage } from './storage/index.js';

const MAX_ATTEMPTS = 3;

let drainDisabled = true;
let processing = false;

function scheduleDrain(): void {
  if (drainDisabled || processing) return;
  void processNextJob();
}

export async function enqueueFeedbackVisionJob(feedbackId: string): Promise<void> {
  const existing = await FeedbackVisionJobModel.findOne({ feedbackId }).lean();
  if (existing?.status === 'processing') {
    return;
  }

  await FeedbackVisionJobModel.findOneAndUpdate(
    { feedbackId },
    {
      $set: {
        status: 'pending',
        lastError: undefined,
        feedbackId,
      },
      $setOnInsert: { attempts: 0 },
    },
    { upsert: true }
  );

  scheduleDrain();
}

export function startFeedbackVisionWorker(): void {
  drainDisabled = false;
  scheduleDrain();
}

export function stopFeedbackVisionWorker(): void {
  drainDisabled = true;
}

async function processNextJob(): Promise<void> {
  if (drainDisabled || processing) return;
  processing = true;

  try {
    const job = await FeedbackVisionJobModel.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { sort: { updatedAt: 1 }, new: true }
    );

    if (!job) return;

    const feedback = await FeedbackModel.findById(job.feedbackId);
    if (!feedback) {
      await FeedbackVisionJobModel.findByIdAndUpdate(job._id, {
        status: 'failed',
        lastError: 'Feedback not found',
      });
      return;
    }

    const storage = getObjectStorage();
    const attachments = feedback.attachments ?? [];

    try {
      const validatedAttachments = [];

      for (const attachment of attachments) {
        const object = await storage.get(attachment.storageKey);
        if (!object) {
          throw new Error('Attachment missing from storage');
        }

        const visionCheck = await classifyScreenshotForFeedback(
          object.body,
          attachment.contentType,
          feedback.userId
        );

        if (!visionCheck.isScreenshot) {
          await Promise.all(
            attachments.map((item) => storage.delete(item.storageKey).catch(() => undefined))
          );
          await FeedbackModel.findByIdAndUpdate(feedback._id, {
            validationStatus: 'rejected',
            attachments: [],
          });
          await notificationService.createNotification(feedback.userId, 'feedback_rejected', {
            feedbackId: String(feedback._id),
            message: feedback.message.slice(0, 200),
            reason: SCREENSHOT_REJECTION_MESSAGE,
          });
          await FeedbackVisionJobModel.findByIdAndUpdate(job._id, {
            status: 'completed',
            lastError: undefined,
          });
          return;
        }

        validatedAttachments.push({
          storageKey: attachment.storageKey,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          visionCheck,
        });
      }

      await FeedbackModel.findByIdAndUpdate(feedback._id, {
        validationStatus: 'validated',
        attachments: validatedAttachments,
      });
      await FeedbackVisionJobModel.findByIdAndUpdate(job._id, {
        status: 'completed',
        lastError: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';

      if (status === 'failed') {
        await FeedbackModel.findByIdAndUpdate(feedback._id, {
          validationStatus: 'failed',
        });
      }

      await FeedbackVisionJobModel.findByIdAndUpdate(job._id, {
        status,
        lastError: message,
      });
    }
  } finally {
    processing = false;
    scheduleDrain();
  }
}
