import { collection } from '../data/index.js';
import type {
  CommentDoc,
  EmbeddingJobDoc,
  ProjectDoc,
  TaskDoc,
  UserDoc,
} from '../data/documents.js';
import {
  buildProjectEmbeddingText,
  buildTaskEmbeddingText,
  generateEmbedding,
} from './embeddingService.js';

function jobs() {
  return collection<EmbeddingJobDoc>('embeddingJobs');
}

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
  // Two mutually exclusive conditional updates rather than one aggregation
  // pipeline: the condition lives in the filter, so each branch is still a single
  // atomic statement. The first claims a job that is mid-flight and marks it dirty
  // so the worker requeues it on finish; the second covers every other state.
  const markedDirty = await jobs().updateOne(
    { entityType, entityId, status: 'processing' },
    { $set: { dirty: true }, $unset: { lastError: '' } }
  );

  if (markedDirty.matched === 0) {
    // `attempts` and `dirty` are spelled out on insert because a job missing
    // `attempts` never matches processNextJob's `attempts: { $lt: MAX_ATTEMPTS }`
    // pickup query, and would sit at 'pending' forever.
    await jobs().updateOne(
      { entityType, entityId },
      {
        $set: {
          entityType,
          entityId,
          ...(entityType === 'task' ? { taskId: entityId } : {}),
          status: 'pending',
        },
        $setOnInsert: { attempts: 0, dirty: false },
        $unset: { lastError: '' },
      },
      { upsert: true }
    );
  }

  scheduleDrain();
}

export async function enqueueEmbeddingJob(taskId: string): Promise<void> {
  await enqueueEntityEmbeddingJob('task', taskId);
}

export async function enqueueProjectEmbeddingJob(projectId: string): Promise<void> {
  await enqueueEntityEmbeddingJob('project', projectId);
}

export async function enqueueTaskEmbeddingsForProject(projectId: string): Promise<void> {
  const tasks = await collection<TaskDoc>('tasks').find(
    {
      staging: { $exists: false },
      $or: [{ projectIds: projectId }, { projectId }],
    },
    { select: '_id' }
  );

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

  const projects = await collection<ProjectDoc>('projects').find(
    { _id: { $in: [...new Set(ids)] } },
    { select: 'name' }
  );
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
  // Dirty means the entity was edited again while this job was processing, so the
  // finished result is already stale and the job goes back on the queue instead of
  // being marked done. The check is in the filter, so it stays atomic with the write.
  const requeued = await jobs().updateOne(
    { _id: String(jobId), dirty: true },
    { $set: { status: 'pending', dirty: false }, $unset: { lastError: '' } }
  );

  if (requeued.matched === 0) {
    await jobs().updateOne(
      { _id: String(jobId), dirty: { $ne: true } },
      lastError === undefined
        ? { $set: { status, dirty: false }, $unset: { lastError: '' } }
        : { $set: { status, dirty: false, lastError } }
    );
  }
}

async function processNextJob(): Promise<void> {
  if (drainDisabled || processing) return;
  processing = true;
  let foundJob = false;

  try {
    const job = await jobs().findOneAndUpdate(
      { status: 'pending', attempts: { $lt: MAX_ATTEMPTS } },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, returnDocument: 'after' }
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
        const project = await collection<ProjectDoc>('projects').findById(String(entityId));
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

        await collection<ProjectDoc>('projects').updateOne({ _id: project._id }, { $set: { embedding } });
        await finishEmbeddingJob(job._id, 'completed');
        return;
      }

      const task = await collection<TaskDoc>('tasks').findById(String(entityId));
      if (!task) {
        await finishEmbeddingJob(job._id, 'failed', 'Task not found');
        return;
      }

      const projectNames = await resolveProjectNames(task);
      const commentDocs = await collection<CommentDoc>('comments').find(
        { taskId: String(task._id) },
        { sort: { createdAt: 1 }, select: 'body subtaskPath userId' }
      );
      const commentAuthorIds = [...new Set(commentDocs.map((c) => c.userId))];
      const commentAuthors = commentAuthorIds.length
        ? await collection<UserDoc>('users').find(
            { _id: { $in: commentAuthorIds } },
            { select: 'email displayName' }
          )
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
        steps: task.steps?.map((step) => ({ text: String(step.text ?? '') })),
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

      await collection<TaskDoc>('tasks').updateOne({ _id: task._id }, { $set: { embedding } });
      await finishEmbeddingJob(job._id, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = (job.attempts ?? 0) >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await finishEmbeddingJob(job._id, status, message);
    }
  } finally {
    processing = false;
    if (foundJob) scheduleDrain();
  }
}
