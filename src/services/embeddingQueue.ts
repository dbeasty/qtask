import { EmbeddingJobModel, ProjectModel, TaskModel } from '../models/index.js';
import {
  buildProjectEmbeddingText,
  buildTaskEmbeddingText,
  generateEmbedding,
} from './embeddingService.js';

const MAX_ATTEMPTS = 3;

let drainDisabled = true;
let processing = false;

function scheduleDrain(): void {
  if (drainDisabled || processing) return;
  void processNextJob();
}

async function enqueueEntityEmbeddingJob(
  entityType: 'task' | 'project',
  entityId: string
): Promise<void> {
  const existing = await EmbeddingJobModel.findOne({ entityType, entityId }).lean();
  if (existing?.status === 'processing') {
    return;
  }

  await EmbeddingJobModel.findOneAndUpdate(
    { entityType, entityId },
    {
      $set: {
        status: 'pending',
        lastError: undefined,
        entityType,
        entityId,
        ...(entityType === 'task' ? { taskId: entityId } : {}),
      },
      $setOnInsert: { attempts: 0 },
    },
    { upsert: true }
  );

  scheduleDrain();
}

export async function enqueueEmbeddingJob(taskId: string): Promise<void> {
  await enqueueEntityEmbeddingJob('task', taskId);
}

export async function enqueueProjectEmbeddingJob(projectId: string): Promise<void> {
  await enqueueEntityEmbeddingJob('project', projectId);
}

export async function enqueueTaskEmbeddingsForProject(projectId: string): Promise<void> {
  const tasks = await TaskModel.find({
    staging: { $exists: false },
    $or: [{ projectIds: projectId }, { projectId }],
  })
    .select('_id')
    .lean();

  await Promise.all(tasks.map((task) => enqueueEmbeddingJob(String(task._id))));
}

export function startEmbeddingWorker(): void {
  drainDisabled = false;
  scheduleDrain();
}

export function stopEmbeddingWorker(): void {
  drainDisabled = true;
}

async function resolveProjectNames(task: {
  projectIds?: string[];
  projectId?: string | null;
}): Promise<string[]> {
  const ids = [
    ...(Array.isArray(task.projectIds) ? task.projectIds.map(String) : []),
    ...(task.projectId ? [String(task.projectId)] : []),
  ].filter(Boolean);

  if (ids.length === 0) return [];

  const projects = await ProjectModel.find({ _id: { $in: [...new Set(ids)] } })
    .select('name')
    .lean();
  return projects.map((project) => project.name);
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

    const entityType = job.entityType ?? 'task';
    const entityId = job.entityId ?? job.taskId;
    if (!entityId) {
      await EmbeddingJobModel.findByIdAndUpdate(job._id, {
        status: 'failed',
        lastError: 'Missing entity id',
      });
      return;
    }

    try {
      if (entityType === 'project') {
        const project = await ProjectModel.findById(entityId);
        if (!project || project.staging) {
          await EmbeddingJobModel.findByIdAndUpdate(job._id, {
            status: 'failed',
            lastError: 'Project not found',
          });
          return;
        }

        const text = buildProjectEmbeddingText({
          name: project.name,
          description: project.description ?? undefined,
        });
        const embedding = await generateEmbedding(text, {
          userId: project.userId,
          source: 'embedding_job',
        });

        await ProjectModel.findByIdAndUpdate(project._id, { embedding });
        await EmbeddingJobModel.findByIdAndUpdate(job._id, {
          status: 'completed',
          lastError: undefined,
        });
        return;
      }

      const task = await TaskModel.findById(entityId);
      if (!task) {
        await EmbeddingJobModel.findByIdAndUpdate(job._id, {
          status: 'failed',
          lastError: 'Task not found',
        });
        return;
      }

      const projectNames = await resolveProjectNames(task);
      const text = buildTaskEmbeddingText({
        title: task.title,
        description: task.description ?? undefined,
        tags: task.tags,
        projectNames,
        steps: task.steps?.map((step) => ({ text: step.text })),
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
