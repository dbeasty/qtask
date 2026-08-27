import { CommentModel, EmbeddingJobModel, ProjectModel, TaskModel, UserModel } from '../models/index.js';
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
  // A single atomic pipeline update instead of a separate findOne-then-write
  // (which raced with the job's own status changes): if the job is
  // currently 'processing', leave it running and just mark it dirty so it
  // gets requeued the moment it finishes, instead of dropping this edit's
  // re-embed and leaving a stale embedding until some unrelated later edit
  // happens to trigger one. Otherwise, behave as before — mark it pending.
  // Note: setDefaultsOnInsert does not apply schema defaults for
  // pipeline-style ($set-array) updates, so defaults for a brand-new
  // document (attempts, dirty) must be spelled out explicitly here —
  // otherwise a freshly-upserted job is missing `attempts` entirely and
  // never matches processNextJob's `attempts: { $lt: MAX_ATTEMPTS }` pickup
  // query, leaving it stuck at 'pending' forever.
  await EmbeddingJobModel.findOneAndUpdate(
    { entityType, entityId },
    [
      {
        $set: {
          entityType,
          entityId,
          ...(entityType === 'task' ? { taskId: entityId } : {}),
          status: { $cond: [{ $eq: ['$status', 'processing'] }, 'processing', 'pending'] },
          dirty: {
            $cond: [{ $eq: ['$status', 'processing'] }, true, { $ifNull: ['$dirty', false] }],
          },
          attempts: { $ifNull: ['$attempts', 0] },
          lastError: undefined,
        },
      },
    ] as unknown as Record<string, unknown>,
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

/**
 * Writes a job's terminal (or retry) status, but atomically checks whether
 * it was marked dirty (edited again while processing) first — if so, the
 * requested status is overridden back to 'pending' and dirty is cleared,
 * so the next drain pass picks it up and re-embeds with the latest data
 * instead of leaving a stale embedding with nothing left to requeue it.
 */
async function finishEmbeddingJob(
  jobId: unknown,
  status: 'completed' | 'failed' | 'pending',
  lastError?: string
): Promise<void> {
  await EmbeddingJobModel.findByIdAndUpdate(jobId, [
    {
      $set: {
        status: { $cond: [{ $eq: ['$dirty', true] }, 'pending', status] },
        lastError: { $cond: [{ $eq: ['$dirty', true] }, undefined, lastError] },
        dirty: false,
      },
    },
  ] as unknown as Record<string, unknown>);
}

async function processNextJob(): Promise<void> {
  if (drainDisabled || processing) return;
  processing = true;
  let foundJob = false;

  try {
    const job = await EmbeddingJobModel.findOneAndUpdate(
      { status: 'pending', attempts: { $lt: MAX_ATTEMPTS } },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true }
    );

    if (!job) return;
    foundJob = true;

    const entityType = job.entityType ?? 'task';
    const entityId = job.entityId ?? job.taskId;
    if (!entityId) {
      await finishEmbeddingJob(job._id, 'failed', 'Missing entity id');
      return;
    }

    try {
      if (entityType === 'project') {
        const project = await ProjectModel.findById(entityId);
        if (!project || project.staging) {
          await finishEmbeddingJob(job._id, 'failed', 'Project not found');
          return;
        }

        const text = buildProjectEmbeddingText({
          name: project.name,
          description: project.description ?? undefined,
          notes: project.notes ?? undefined,
        });
        const embedding = await generateEmbedding(text, {
          userId: project.userId,
          source: 'embedding_job',
        });

        await ProjectModel.findByIdAndUpdate(project._id, { embedding });
        await finishEmbeddingJob(job._id, 'completed');
        return;
      }

      const task = await TaskModel.findById(entityId);
      if (!task) {
        await finishEmbeddingJob(job._id, 'failed', 'Task not found');
        return;
      }

      const projectNames = await resolveProjectNames(task);
      const commentDocs = await CommentModel.find({ taskId: String(task._id) })
        .sort({ createdAt: 1 })
        .select('body subtaskPath userId')
        .lean();
      const commentAuthorIds = [...new Set(commentDocs.map((c) => c.userId))];
      const commentAuthors = commentAuthorIds.length
        ? await UserModel.find({ _id: { $in: commentAuthorIds } }).select('email displayName').lean()
        : [];
      const authorById = new Map(
        commentAuthors.map((u) => [
          String(u._id),
          u.displayName || u.email,
        ])
      );
      const text = buildTaskEmbeddingText({
        title: task.title,
        description: task.description ?? undefined,
        tags: task.tags,
        projectNames,
        steps: task.steps?.map((step) => ({ text: step.text })),
        comments: commentDocs.map((comment) => ({
          authorLabel: authorById.get(comment.userId) ?? 'Unknown',
          body: comment.body,
          subtaskPath: comment.subtaskPath,
        })),
      });
      const embedding = await generateEmbedding(text, {
        userId: task.userId,
        taskId: String(task._id),
        source: 'embedding_job',
      });

      await TaskModel.findByIdAndUpdate(task._id, { embedding });
      await finishEmbeddingJob(job._id, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await finishEmbeddingJob(job._id, status, message);
    }
  } finally {
    processing = false;
    if (foundJob) scheduleDrain();
  }
}
