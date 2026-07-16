import { EmbeddingJobModel, TaskModel } from '../models/index.js';
import { buildTaskEmbeddingText, generateEmbedding } from './embeddingService.js';

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 3;

let workerTimer: ReturnType<typeof setInterval> | null = null;
let processing = false;

export async function enqueueEmbeddingJob(taskId: string): Promise<void> {
  await EmbeddingJobModel.findOneAndUpdate(
    { taskId, status: { $in: ['pending', 'processing'] } },
    { $setOnInsert: { taskId, status: 'pending', attempts: 0 } },
    { upsert: true }
  );
}

export function startEmbeddingWorker(): void {
  if (workerTimer) return;

  workerTimer = setInterval(() => {
    void processNextJob();
  }, POLL_INTERVAL_MS);
}

export function stopEmbeddingWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

async function processNextJob(): Promise<void> {
  if (processing) return;
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
  }
}
