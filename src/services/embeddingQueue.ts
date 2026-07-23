import { EmbeddingJobModel, TaskModel } from '../models/index.js';
import { buildTaskEmbeddingText, generateEmbedding } from './embeddingService.js';

const MAX_ATTEMPTS = 3;

let drainDisabled = true;
let processing = false;

function scheduleDrain(): void {
  if (drainDisabled || processing) return;
  void processNextJob();
}

export async function enqueueEmbeddingJob(taskId: string): Promise<void> {
  const existing = await EmbeddingJobModel.findOne({ taskId }).lean();
  if (existing?.status === 'processing') {
    return;
  }

  await EmbeddingJobModel.findOneAndUpdate(
    { taskId },
    {
      $set: { status: 'pending', lastError: undefined },
      $setOnInsert: { attempts: 0 },
    },
    { upsert: true }
  );

  scheduleDrain();
}

export function startEmbeddingWorker(): void {
  drainDisabled = false;
  scheduleDrain();
}

export function stopEmbeddingWorker(): void {
  drainDisabled = true;
}

async function processNextJob(): Promise<void> {
  if (drainDisabled || processing) return;
  processing = true;

  try {
    const job = await EmbeddingJobModel.findOneAndUpdate(
      { status: 'pending', attempts: { $lt: MAX_ATTEMPTS } },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true }
    );

    if (!job) return;

    try {
      const task = await TaskModel.findById(job.taskId);
      if (!task) {
        await EmbeddingJobModel.findByIdAndUpdate(job._id, {
          status: 'failed',
          lastError: 'Task not found',
        });
        return;
      }

      const text = buildTaskEmbeddingText({
        title: task.title,
        description: task.description ?? undefined,
        tags: task.tags,
      });
      const embedding = await generateEmbedding(text, {
        userId: task.userId,
        taskId: String(task._id),
        source: 'embedding_job',
      });

      await TaskModel.findByIdAndUpdate(task._id, { embedding });
      await EmbeddingJobModel.findByIdAndUpdate(job._id, {
        status: 'completed',
        lastError: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';

      await EmbeddingJobModel.findByIdAndUpdate(job._id, {
        status,
        lastError: message,
      });
    }
  } finally {
    processing = false;
    scheduleDrain();
  }
}
