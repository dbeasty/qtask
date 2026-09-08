import { collection } from '../data/index.js';
import type { FeedbackDoc, FeedbackVisionJobDoc } from '../data/documents.js';

function visionJobs() {
  return collection<FeedbackVisionJobDoc>('feedbackVisionJobs');
}

function feedbackDocs() {
  return collection<FeedbackDoc>('feedback');
}
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
  const existing = await visionJobs().findOne({ feedbackId });
  if (existing?.status === 'processing') {
    return;
  }

  await visionJobs().updateOne(
    { feedbackId },
    {
      $set: {
        status: 'pending',
        feedbackId,
      },
      $unset: { lastError: '' },
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
    const job = await visionJobs().findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { sort: { updatedAt: 1 }, returnDocument: 'after' }
    );

    if (!job) return;

    const feedback = await feedbackDocs().findById(job.feedbackId);
    if (!feedback) {
      await visionJobs().updateOne({ _id: job._id }, { $set: {
        status: 'failed',
        lastError: 'Feedback not found',
      } });
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
          await feedbackDocs().updateOne({ _id: feedback._id }, { $set: {
            validationStatus: 'rejected',
            attachments: [],
          } });
          await notificationService.createNotification(feedback.userId, 'feedback_rejected', {
            feedbackId: String(feedback._id),
            message: feedback.message.slice(0, 200),
            reason: SCREENSHOT_REJECTION_MESSAGE,
          });
          await visionJobs().updateOne({ _id: job._id }, { $set: {
            status: 'completed',
          }, $unset: { lastError: '' } });
          return;
        }

        validatedAttachments.push({
          storageKey: attachment.storageKey,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          visionCheck,
        });
      }

      await feedbackDocs().updateOne({ _id: feedback._id }, { $set: {
        validationStatus: 'validated',
        attachments: validatedAttachments,
      } });
      await visionJobs().updateOne({ _id: job._id }, { $set: {
        status: 'completed',
      }, $unset: { lastError: '' } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = (job.attempts ?? 0) >= MAX_ATTEMPTS ? 'failed' : 'pending';

      if (status === 'failed') {
        await feedbackDocs().updateOne({ _id: feedback._id }, { $set: {
          validationStatus: 'failed',
        } });
      }

      await visionJobs().updateOne({ _id: job._id }, { $set: {
        status,
        lastError: message,
      } });
    }
  } finally {
    processing = false;
    scheduleDrain();
  }
}
