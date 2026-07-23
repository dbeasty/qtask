import { Types } from 'mongoose';
import { TaskModel } from '../models/index.js';
import type {
  AttachTaskAsSubtaskInput,
  CreateTaskInput,
  MoveSubtaskInput,
  TaskLink,
  TaskLinkType,
  TaskSearchFilters,
  UpdateSubtaskInput,
  UpdateTaskInput,
} from '../types/task.js';
import type { StagingContext } from '../types/staging.js';
import { canEditProject, roleAtLeast, type ProjectRole } from '../types/project.js';
import { HttpError } from '../utils/httpError.js';
import { applyPercentComplete } from '../utils/percentComplete.js';
import { buildSubtaskTree, normalizeStepsInput, serializeTask } from '../utils/serialization.js';
import { logActivity } from './activityService.js';
import { enqueueEmbeddingJob } from './embeddingQueue.js';
import { cosineSimilarity, generateEmbedding } from './embeddingService.js';

async function projects() {
  const { projectService } = await import('./projectService.js');
  return projectService;
}

function isVersionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'VersionError' || err.message.includes('VersionError');
}

const taskSaveLocks = new Map<string, Promise<void>>();

async function withTaskSaveLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prior = taskSaveLocks.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(
    () => gate,
    () => gate
  );
  taskSaveLocks.set(taskId, queued);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    void queued.finally(() => {
      if (taskSaveLocks.get(taskId) === queued) {
        taskSaveLocks.delete(taskId);
      }
    });
  }
}

const VERSION_SAVE_MAX_ATTEMPTS = 8;

async function saveTaskWithVersionRetry<T extends { save: () => Promise<unknown> }>(
  taskId: string,
  task: T,
  applyUpdate: (doc: T) => Promise<Record<string, unknown>> | Record<string, unknown>
): Promise<{ task: T; changes: Record<string, unknown> }> {
  let current = task;
  let changes = await applyUpdate(current);

  for (let attempt = 0; attempt < VERSION_SAVE_MAX_ATTEMPTS; attempt++) {
    try {
      await current.save();
      return { task: current, changes };
    } catch (err) {
      if (!isVersionError(err) || attempt === VERSION_SAVE_MAX_ATTEMPTS - 1) {
        throw err;
      }
      console.error('VersionError saving task update, retrying', {
        taskId,
        attempt: attempt + 1,
        maxAttempts: VERSION_SAVE_MAX_ATTEMPTS,
      });
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      const reloaded = await TaskModel.findById(taskId);
      if (!reloaded) throw err;
      current = reloaded as T;
      changes = await applyUpdate(current);
    }
  }

  throw new Error('Unreachable');
}

type ProgressNode = Record<string, unknown> & {
  status?: string;
  subtasks?: ProgressNode[];
  percentComplete?: number;
  lastProgressField?: string;
};

function applyProgressInputFields(
  node: ProgressNode,
  input: {
    percentComplete?: number;
    percentCompleteOverride?: number | null;
    progressShare?: number | null;
    hoursSpent?: number | null;
    hoursRemaining?: number | null;
    lastProgressField?: string | null;
    status?: string;
  },
  changes: Record<string, unknown>
) {
  if (input.status !== undefined) {
    node.status = input.status;
    changes.status = input.status;
    if (input.status === 'done' && (node.subtasks ?? []).length === 0) {
      node.percentComplete = 100;
      node.lastProgressField = 'percent';
      changes.percentComplete = 100;
      changes.lastProgressField = 'percent';
    }
  }
  if (input.percentComplete !== undefined) {
    node.percentComplete = input.percentComplete;
    changes.percentComplete = input.percentComplete;
  }
  if (input.percentCompleteOverride !== undefined) {
    node.percentCompleteOverride =
      input.percentCompleteOverride === null ? undefined : input.percentCompleteOverride;
    changes.percentCompleteOverride = input.percentCompleteOverride;
  }
  if (input.progressShare !== undefined) {
    node.progressShare = input.progressShare === null ? undefined : input.progressShare;
    changes.progressShare = input.progressShare;
  }
  if (input.hoursSpent !== undefined) {
    node.hoursSpent = input.hoursSpent === null ? undefined : input.hoursSpent;
    changes.hoursSpent = input.hoursSpent;
  }
  if (input.hoursRemaining !== undefined) {
    node.hoursRemaining = input.hoursRemaining === null ? undefined : input.hoursRemaining;
    changes.hoursRemaining = input.hoursRemaining;
  }
  if (input.lastProgressField !== undefined) {
    node.lastProgressField =
      input.lastProgressField === null ? undefined : input.lastProgressField;
    changes.lastProgressField = input.lastProgressField;
  }
}

function finalizeTaskProgress(task: {
  status?: string;
  percentComplete: number;
  subtasks: unknown[];
  markModified?: (path: string) => void;
  toObject: () => Record<string, unknown>;
}) {
  const withPercent = applyPercentComplete(
    task.toObject() as unknown as Parameters<typeof applyPercentComplete>[0]
  );
  task.status = withPercent.status as typeof task.status;
  task.percentComplete = withPercent.percentComplete;
  task.subtasks = withPercent.subtasks as typeof task.subtasks;
  task.markModified?.('subtasks');
}

export class TaskService {
  private getDocProjectIds(task: {
    projectId?: unknown;
    projectIds?: unknown;
  }): string[] {
    const ids: string[] = [];
    if (Array.isArray(task.projectIds)) {
      for (const id of task.projectIds) {
        if (id) ids.push(String(id));
      }
    }
    if (ids.length === 0 && task.projectId) {
      ids.push(String(task.projectId));
    }
    return [...new Set(ids)];
  }

  private async accessibleTaskQuery(userId: string): Promise<Record<string, unknown>> {
    const projectIds = await (await projects()).listAccessibleProjectIds(userId);
    if (projectIds.length === 0) {
      return { userId };
    }
    return {
      $or: [
        { userId },
        { projectIds: { $in: projectIds } },
        { projectId: { $in: projectIds } },
      ],
    };
  }

  /**
   * Load a task the user can access. Non-members get null (404);
   * members below minRole get 403.
   */
  private async loadAccessibleTask(userId: string, taskId: string, minRole: ProjectRole = 'viewer') {
    const loaded = await this.loadAccessibleTaskWithRole(userId, taskId, minRole);
    return loaded?.task ?? null;
  }

  private async loadAccessibleTaskWithRole(
    userId: string,
    taskId: string,
    minRole: ProjectRole = 'viewer'
  ) {
    const task = await TaskModel.findById(taskId);
    if (!task) return null;
    if (task.staging) return null;

    const projectIds = this.getDocProjectIds(task).filter((id) => Types.ObjectId.isValid(id));
    if (projectIds.length > 0) {
      let bestRole: ProjectRole | null = null;
      for (const projectId of projectIds) {
        const access = await (await projects()).getProjectAccess(userId, projectId);
        if (!access) continue;
        if (!bestRole || roleAtLeast(access.role, bestRole)) {
          bestRole = access.role;
        }
      }
      if (bestRole) {
        if (!roleAtLeast(bestRole, minRole)) {
          throw new HttpError(403, 'Insufficient project permissions');
        }
        return { task, role: bestRole };
      }
    }

    if (task.userId !== userId) return null;
    return { task, role: 'owner' as ProjectRole };
  }

  private assertStatusOnlyUpdate(input: Record<string, unknown>) {
    const provided = Object.entries(input).filter(([, value]) => value !== undefined);
    const disallowed = provided.filter(([key]) => key !== 'status').map(([key]) => key);
    if (disallowed.length > 0) {
      throw new HttpError(403, 'Executors may only update task status');
    }
    if (!provided.some(([key]) => key === 'status')) {
      throw new HttpError(400, 'status is required');
    }
  }

  private async requireProjectEdit(userId: string, projectId: string) {
    await (await projects()).assertProjectAccess(userId, projectId, 'editor');
  }

  private async notifyProjectProgress(projectIds: string[]): Promise<void> {
    const ids = [
      ...new Set(projectIds.filter((id) => Boolean(id) && Types.ObjectId.isValid(id))),
    ];
    if (ids.length === 0) return;
    await (await projects()).recalculateProjects(ids);
  }

  async createTask(
    userId: string,
    input: CreateTaskInput,
    source: 'user' | 'ai' = 'user',
    staging?: StagingContext
  ) {
    const subtasks = (input.subtasks ?? []).map(buildSubtaskTree);

    let projectIds =
      input.projectIds && input.projectIds.length > 0
        ? [...new Set(input.projectIds.map(String))]
        : input.projectId
          ? [input.projectId]
          : [];

    if (projectIds.length > 0) {
      for (const projectId of projectIds) {
        if (staging) {
          await (await projects()).assertProjectAccessForStaging(userId, projectId, staging);
        } else {
          await this.requireProjectEdit(userId, projectId);
        }
      }
    } else {
      projectIds = [await (await projects()).ensureDefaultProject(userId)];
    }

    const primaryProjectId = projectIds[0]!;

    const taskDoc = new TaskModel({
      userId,
      projectId: primaryProjectId,
      projectIds,
      title: input.title,
      description: input.description,
      steps: normalizeStepsInput(input.steps),
      status: input.status ?? 'todo',
      priority: input.priority ?? 'medium',
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      tags: input.tags ?? [],
      percentComplete: input.percentComplete ?? 0,
      percentCompleteOverride: input.percentCompleteOverride,
      subtasks,
      links: [],
      staging: staging ? { ...staging, stagedAt: new Date() } : undefined,
    });

    const minTask = await TaskModel.findOne({
      $or: [{ projectIds: primaryProjectId }, { projectId: primaryProjectId }],
      staging: { $exists: false },
    })
      .sort({ sortOrder: 1 })
      .select('sortOrder')
      .lean();
    taskDoc.sortOrder = minTask ? (minTask.sortOrder ?? 0) - 1 : 0;

    const withPercent = applyPercentComplete(taskDoc.toObject() as Parameters<typeof applyPercentComplete>[0]);
    taskDoc.status = withPercent.status as typeof taskDoc.status;
    taskDoc.percentComplete = withPercent.percentComplete;
    taskDoc.subtasks = withPercent.subtasks as typeof taskDoc.subtasks;

    await taskDoc.save();
    if (!staging) {
      await enqueueEmbeddingJob(String(taskDoc._id));

      await logActivity({
        taskId: String(taskDoc._id),
        userId,
        action: 'task.created',
        details: { title: taskDoc.title },
        source,
      });

      await this.notifyProjectProgress(projectIds);
    }

    return serializeTask(taskDoc.toObject());
  }

  async getTask(userId: string, taskId: string) {
    const task = await this.loadAccessibleTask(userId, taskId, 'viewer');
    if (!task) return null;

    const withPercent = applyPercentComplete(task.toObject() as Parameters<typeof applyPercentComplete>[0]);
    return serializeTask(withPercent as unknown as Record<string, unknown>);
  }

  async listTasks(userId: string, filters: TaskSearchFilters = {}) {
    if (filters.projectId) {
      await (await projects()).assertProjectAccess(userId, filters.projectId, 'viewer');
    }

    const accessQuery = await this.accessibleTaskQuery(userId);
    const query: Record<string, unknown> = {
      ...accessQuery,
      staging: { $exists: false },
    };

    if (filters.status) {
      query.status = Array.isArray(filters.status) ? { $in: filters.status } : filters.status;
    }
    if (filters.priority) {
      query.priority = Array.isArray(filters.priority) ? { $in: filters.priority } : filters.priority;
    }
    if (filters.projectId) {
      query.$and = [
        ...(Array.isArray(query.$and) ? (query.$and as unknown[]) : []),
        {
          $or: [{ projectIds: filters.projectId }, { projectId: filters.projectId }],
        },
      ];
    }
    if (filters.assigneeId) query.assigneeId = filters.assigneeId;
    if (filters.tags?.length) query.tags = { $all: filters.tags };
    if (filters.dueBefore || filters.dueAfter) {
      query.dueDate = {};
      if (filters.dueBefore) (query.dueDate as Record<string, Date>).$lte = new Date(filters.dueBefore);
      if (filters.dueAfter) (query.dueDate as Record<string, Date>).$gte = new Date(filters.dueAfter);
    }

    let tasks = await TaskModel.find(query).sort({ sortOrder: 1, createdAt: -1 }).lean();

    if (filters.query) {
      const textMatches = await TaskModel.find(
        { ...query, $text: { $search: filters.query } },
        { score: { $meta: 'textScore' } }
      )
        .sort({ score: { $meta: 'textScore' } })
        .lean();

      const semanticMatches = await this.semanticSearch(userId, filters.query, query);

      const merged = new Map<string, { task: Record<string, unknown>; score: number }>();

      for (const [index, task] of textMatches.entries()) {
        merged.set(String(task._id), { task: task as Record<string, unknown>, score: 1 - index * 0.01 });
      }

      for (const { task, score } of semanticMatches) {
        const id = String(task._id);
        const existing = merged.get(id);
        merged.set(id, {
          task: task as Record<string, unknown>,
          score: existing ? existing.score + score : score,
        });
      }

      if (merged.size > 0) {
        tasks = Array.from(merged.values())
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.task) as typeof tasks;
      } else {
        const regex = new RegExp(filters.query, 'i');
        tasks = tasks.filter(
          (t) =>
            regex.test(t.title) ||
            (t.description && regex.test(t.description)) ||
            t.tags.some((tag) => regex.test(tag))
        );
      }
    }

    return tasks.map((task) =>
      serializeTask(applyPercentComplete(task as Parameters<typeof applyPercentComplete>[0]) as unknown as Record<string, unknown>)
    );
  }

  async findTasks(userId: string, filters: TaskSearchFilters, limit = 20) {
    const results = await this.listTasks(userId, filters);
    return results.slice(0, limit);
  }

  async updateTask(
    userId: string,
    taskId: string,
    input: UpdateTaskInput,
    source: 'user' | 'ai' = 'user'
  ) {
    return withTaskSaveLock(taskId, async () => {
      const loaded = await this.loadAccessibleTaskWithRole(userId, taskId, 'executor');
      if (!loaded) return null;
      const { role } = loaded;

      const previousProjectIds = this.getDocProjectIds(loaded.task);

      const applyUpdate = async (task: typeof loaded.task): Promise<Record<string, unknown>> => {
        const changes: Record<string, unknown> = {};

        if (!canEditProject(role)) {
          this.assertStatusOnlyUpdate(input as Record<string, unknown>);
          applyProgressInputFields(task as unknown as ProgressNode, { status: input.status }, changes);
        } else {
          if (input.title !== undefined) {
            task.title = input.title;
            changes.title = input.title;
          }
          if (input.description !== undefined) {
            task.description = input.description;
            changes.description = input.description;
          }
          if (input.steps !== undefined) {
            task.steps = normalizeStepsInput(input.steps) as typeof task.steps;
            task.markModified('steps');
            changes.steps = input.steps;
          }
          if (input.priority !== undefined) {
            task.priority = input.priority;
            changes.priority = input.priority;
          }
          if (input.dueDate !== undefined) {
            task.dueDate = input.dueDate ? new Date(input.dueDate) : undefined;
            changes.dueDate = input.dueDate;
          }
          if (input.tags !== undefined) {
            task.tags = input.tags;
            changes.tags = input.tags;
          }
          applyProgressInputFields(task as unknown as ProgressNode, input, changes);
          if (input.projectIds !== undefined) {
            if (input.projectIds === null || input.projectIds.length === 0) {
              throw new HttpError(400, 'projectIds must contain at least one project');
            }
            const nextIds = [...new Set(input.projectIds.map(String))];
            for (const projectId of nextIds) {
              await this.requireProjectEdit(userId, projectId);
            }
            for (const existingId of this.getDocProjectIds(task)) {
              if (!nextIds.includes(existingId)) {
                await this.requireProjectEdit(userId, existingId);
              }
            }
            (task as { projectIds: string[] }).projectIds = nextIds;
            task.projectId = nextIds[0];
            changes.projectIds = nextIds;
            changes.projectId = nextIds[0];
          } else if (input.projectId !== undefined) {
            if (input.projectId !== null) {
              await this.requireProjectEdit(userId, input.projectId);
              (task as { projectIds: string[] }).projectIds = [input.projectId];
              task.projectId = input.projectId;
              changes.projectIds = [input.projectId];
              changes.projectId = input.projectId;
            } else {
              throw new HttpError(400, 'projectId cannot be null; use unlink instead');
            }
          }
          if (input.assigneeId !== undefined) {
            task.assigneeId = input.assigneeId === null ? undefined : input.assigneeId;
            changes.assigneeId = input.assigneeId;
          }
        }

        finalizeTaskProgress(task);
        return changes;
      };

      const { task, changes } = await saveTaskWithVersionRetry(taskId, loaded.task, applyUpdate);

      await enqueueEmbeddingJob(String(task._id));

      await logActivity({
        taskId: String(task._id),
        userId,
        action: 'task.updated',
        details: changes,
        source,
      });

      await this.notifyProjectProgress([...previousProjectIds, ...this.getDocProjectIds(task)]);

      return serializeTask(task.toObject());
    });
  }

  async deleteTask(userId: string, taskId: string, options: { keepChildren?: boolean } = {}) {
    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    const title = task.title;
    const affectedProjectIds = this.getDocProjectIds(task);
    const keepChildren = Boolean(options.keepChildren) && (task.subtasks?.length ?? 0) > 0;

    if (!keepChildren) {
      await task.deleteOne();
      await logActivity({
        taskId,
        userId,
        action: 'task.deleted',
        details: { title },
      });
      await this.notifyProjectProgress(affectedProjectIds);
      return { deleted: true as const, promotedTasks: [] as ReturnType<typeof serializeTask>[] };
    }

    let projectIds = this.getDocProjectIds(task).filter((id) => Types.ObjectId.isValid(id));
    if (projectIds.length === 0) {
      projectIds = [await (await projects()).ensureDefaultProject(userId)];
    }
    const projectId = projectIds[0]!;

    const parentSortOrder = task.sortOrder ?? 0;
    const children = (task.subtasks ?? []).map((child) => {
      const maybeDoc = child as { toObject?: () => Record<string, unknown> };
      return maybeDoc.toObject ? maybeDoc.toObject() : (child as unknown as Record<string, unknown>);
    });

    const promotedDocs = children.map((child, index) => {
      const doc = new TaskModel({
        userId: task.userId,
        projectId,
        projectIds: [...projectIds],
        title: child.title,
        description: child.description,
        status: child.status ?? 'todo',
        priority: child.priority ?? 'medium',
        dueDate: child.dueDate,
        tags: child.tags ?? [],
        percentComplete: child.percentComplete ?? 0,
        percentCompleteOverride: child.percentCompleteOverride,
        progressShare: child.progressShare,
        hoursSpent: child.hoursSpent,
        hoursRemaining: child.hoursRemaining,
        lastProgressField: child.lastProgressField,
        subtasks: child.subtasks ?? [],
        links: child.links ?? [],
        sortOrder: parentSortOrder + index,
      });

      const withPercent = applyPercentComplete(
        doc.toObject() as Parameters<typeof applyPercentComplete>[0]
      );
      doc.status = withPercent.status as typeof doc.status;
      doc.percentComplete = withPercent.percentComplete;
      doc.subtasks = withPercent.subtasks as typeof doc.subtasks;
      return doc;
    });

    // Shift later siblings so promoted children keep relative order after the parent slot.
    if (promotedDocs.length > 1) {
      await TaskModel.updateMany(
        {
          $or: [{ projectIds: projectId }, { projectId }],
          _id: { $ne: task._id },
          sortOrder: { $gt: parentSortOrder },
        },
        { $inc: { sortOrder: promotedDocs.length - 1 } }
      );
    }

    await Promise.all(promotedDocs.map((doc) => doc.save()));
    await task.deleteOne();

    const promotedTasks = promotedDocs.map((doc) => serializeTask(doc.toObject()));
    await Promise.all(promotedTasks.map((promoted) => enqueueEmbeddingJob(promoted._id)));

    await logActivity({
      taskId,
      userId,
      action: 'task.deleted_keep_children',
      details: {
        title,
        promotedTaskIds: promotedTasks.map((promoted) => promoted._id),
        promotedTitles: promotedTasks.map((promoted) => promoted.title),
      },
    });

    await this.notifyProjectProgress(affectedProjectIds);

    return { deleted: true as const, promotedTasks };
  }

  async addLink(userId: string, taskId: string, linkedTaskId: string, type: TaskLinkType) {
    if (taskId === linkedTaskId) {
      throw new Error('A task cannot link to itself');
    }

    const [task, linkedTask] = await Promise.all([
      this.loadAccessibleTask(userId, taskId, 'editor'),
      this.loadAccessibleTask(userId, linkedTaskId, 'editor'),
    ]);

    if (!task || !linkedTask) return null;

    const link: TaskLink = { taskId: linkedTaskId, type };
    if (!task.links.some((l) => l.taskId === linkedTaskId && l.type === type)) {
      task.links.push(link);
      await task.save();
    }

    await logActivity({
      taskId,
      userId,
      action: 'task.link_added',
      details: { linkedTaskId, type },
    });

    return serializeTask(task.toObject());
  }

  async removeLink(userId: string, taskId: string, linkedTaskId: string, type: TaskLinkType) {
    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    task.links = task.links.filter((l) => !(l.taskId === linkedTaskId && l.type === type)) as typeof task.links;
    await task.save();

    await logActivity({
      taskId,
      userId,
      action: 'task.link_removed',
      details: { linkedTaskId, type },
    });

    return serializeTask(task.toObject());
  }

  async getWorkload(userId: string, assigneeId?: string) {
    const accessQuery = await this.accessibleTaskQuery(userId);
    const query: Record<string, unknown> = {
      ...accessQuery,
      staging: { $exists: false },
      status: { $in: ['todo', 'in_progress'] },
    };

    if (assigneeId) {
      query.assigneeId = assigneeId;
    }

    const tasks = await TaskModel.find(query).sort({ priority: -1, dueDate: 1 }).lean();
    return tasks.map((task) => {
      const withPercent = applyPercentComplete(task as Parameters<typeof applyPercentComplete>[0]);
      return {
        _id: String(task._id),
        title: task.title,
        status: task.status,
        priority: task.priority,
        percentComplete: withPercent.percentComplete,
        dueDate: task.dueDate?.toISOString(),
        projectId: this.getDocProjectIds(task)[0],
        projectIds: this.getDocProjectIds(task),
        assigneeId: task.assigneeId,
      };
    });
  }

  async addSubtask(
    userId: string,
    taskId: string,
    subtaskPath: string[],
    input: CreateTaskInput['subtasks'] extends (infer U)[] | undefined ? U : never
  ) {
    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    const newSubtask = buildSubtaskTree(input);
    (newSubtask as { _id: Types.ObjectId })._id = new Types.ObjectId();

    if (subtaskPath.length === 0) {
      task.subtasks.push(newSubtask as unknown as (typeof task.subtasks)[0]);
    } else {
      const parent = this.findSubtaskByPath(task.subtasks, subtaskPath);
      if (!parent) return null;
      parent.subtasks = parent.subtasks ?? [];
      parent.subtasks.push(newSubtask as unknown as (typeof parent.subtasks)[0]);
    }

    finalizeTaskProgress(task);
    task.markModified('subtasks');
    await task.save();

    await logActivity({
      taskId,
      userId,
      action: 'subtask.added',
      details: { title: input.title, path: subtaskPath },
    });

    await this.notifyProjectProgress(this.getDocProjectIds(task));

    return serializeTask(task.toObject());
  }

  async updateSubtask(
    userId: string,
    taskId: string,
    subtaskPath: string[],
    input: UpdateSubtaskInput,
    source: 'user' | 'ai' = 'user'
  ) {
    return withTaskSaveLock(taskId, async () => {
      const loaded = await this.loadAccessibleTaskWithRole(userId, taskId, 'executor');
      if (!loaded || subtaskPath.length === 0) return null;
      const { role } = loaded;

      const applyUpdate = async (task: typeof loaded.task): Promise<Record<string, unknown>> => {
        const subtask = this.findSubtaskByPath(task.subtasks, subtaskPath);
        if (!subtask) {
          throw new HttpError(404, 'Subtask not found');
        }

        const changes: Record<string, unknown> = {};
        const node = subtask as Record<string, unknown>;

        if (!canEditProject(role)) {
          this.assertStatusOnlyUpdate(input as Record<string, unknown>);
          applyProgressInputFields(node as ProgressNode, { status: input.status }, changes);
        } else {
          if (input.title !== undefined) {
            node.title = input.title;
            changes.title = input.title;
          }
          if (input.description !== undefined) {
            node.description = input.description;
            changes.description = input.description;
          }
          if (input.steps !== undefined) {
            node.steps = normalizeStepsInput(input.steps);
            changes.steps = input.steps;
          }
          if (input.priority !== undefined) {
            node.priority = input.priority;
            changes.priority = input.priority;
          }
          if (input.dueDate !== undefined) {
            node.dueDate = input.dueDate ? new Date(input.dueDate) : undefined;
            changes.dueDate = input.dueDate;
          }
          if (input.tags !== undefined) {
            node.tags = input.tags;
            changes.tags = input.tags;
          }
          applyProgressInputFields(node as ProgressNode, input, changes);
        }

        finalizeTaskProgress(task);
        task.markModified('subtasks');
        return changes;
      };

      let saved: { task: typeof loaded.task; changes: Record<string, unknown> };
      try {
        saved = await saveTaskWithVersionRetry(taskId, loaded.task, applyUpdate);
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 404) return null;
        throw err;
      }

      const { task, changes } = saved;

      await enqueueEmbeddingJob(String(task._id));

      await logActivity({
        taskId,
        userId,
        action: 'subtask.updated',
        details: { path: subtaskPath, ...changes },
        source,
      });

      await this.notifyProjectProgress(this.getDocProjectIds(task));

      return serializeTask(task.toObject());
    });
  }

  async moveSubtask(userId: string, taskId: string, input: MoveSubtaskInput) {
    const { fromPath, toParentPath, index } = input;
    if (fromPath.length === 0) {
      throw new Error('fromPath is required');
    }

    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    const nodeId = fromPath[fromPath.length - 1]!;
    const currentParentPath = fromPath.slice(0, -1);

    if (this.isDescendantOrSelfPath(fromPath, toParentPath)) {
      throw new Error('Cannot move a subtask into itself or its descendants');
    }

    const currentParentArray = this.getParentArray(task, currentParentPath);
    if (!currentParentArray) return null;

    const fromIndex = currentParentArray.findIndex((s) => String(s._id) === nodeId);
    if (fromIndex === -1) return null;

    const targetParentArray = this.getParentArray(task, toParentPath);
    if (!targetParentArray) return null;

    const isSameParent =
      currentParentPath.length === toParentPath.length &&
      currentParentPath.every((id, i) => id === toParentPath[i]);

    const [node] = currentParentArray.splice(fromIndex, 1);

    let insertIndex = index ?? targetParentArray.length;
    if (isSameParent && insertIndex > fromIndex) {
      insertIndex -= 1;
    }
    insertIndex = Math.max(0, Math.min(insertIndex, targetParentArray.length));

    targetParentArray.splice(insertIndex, 0, node!);

    finalizeTaskProgress(task);
    task.markModified('subtasks');
    await task.save();

    await logActivity({
      taskId,
      userId,
      action: 'subtask.moved',
      details: { fromPath, toParentPath, index: insertIndex },
    });

    await this.notifyProjectProgress(this.getDocProjectIds(task));

    return serializeTask(task.toObject());
  }

  async promoteSubtaskToTask(userId: string, taskId: string, subtaskPath: string[]) {
    if (subtaskPath.length === 0) return null;

    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    const subtaskId = subtaskPath[subtaskPath.length - 1]!;
    const currentParentPath = subtaskPath.slice(0, -1);
    const currentParentArray = this.getParentArray(task, currentParentPath);
    if (!currentParentArray) return null;

    const fromIndex = currentParentArray.findIndex((s) => String(s._id) === subtaskId);
    if (fromIndex === -1) return null;

    const [node] = currentParentArray.splice(fromIndex, 1);
    const nodeObj = node as Record<string, unknown>;

    let projectIds = this.getDocProjectIds(task).filter((id) => Types.ObjectId.isValid(id));
    if (projectIds.length === 0) {
      projectIds = [await (await projects()).ensureDefaultProject(userId)];
    }
    const projectId = projectIds[0]!;

    const promotedDoc = new TaskModel({
      userId,
      projectId,
      projectIds: [...projectIds],
      title: nodeObj.title,
      description: nodeObj.description,
      status: nodeObj.status ?? 'todo',
      priority: nodeObj.priority ?? 'medium',
      dueDate: nodeObj.dueDate,
      tags: nodeObj.tags ?? [],
      percentComplete: nodeObj.percentComplete ?? 0,
      percentCompleteOverride: nodeObj.percentCompleteOverride,
      progressShare: nodeObj.progressShare,
      hoursSpent: nodeObj.hoursSpent,
      hoursRemaining: nodeObj.hoursRemaining,
      lastProgressField: nodeObj.lastProgressField,
      subtasks: nodeObj.subtasks ?? [],
      links: nodeObj.links ?? [],
    });

    const minTask = await TaskModel.findOne({
      $or: [{ projectIds: projectId }, { projectId }],
    })
      .sort({ sortOrder: 1 })
      .select('sortOrder')
      .lean();
    promotedDoc.sortOrder = minTask ? (minTask.sortOrder ?? 0) - 1 : 0;

    const withPercent = applyPercentComplete(
      promotedDoc.toObject() as Parameters<typeof applyPercentComplete>[0]
    );
    promotedDoc.status = withPercent.status as typeof promotedDoc.status;
    promotedDoc.percentComplete = withPercent.percentComplete;
    promotedDoc.subtasks = withPercent.subtasks as typeof promotedDoc.subtasks;

    await promotedDoc.save();
    const promotedId = String(promotedDoc._id);
    await enqueueEmbeddingJob(promotedId);

    if (!task.links.some((l) => l.taskId === promotedId && l.type === 'related')) {
      task.links.push({ taskId: promotedId, type: 'related' });
    }

    finalizeTaskProgress(task);
    task.markModified('subtasks');
    await task.save();

    await logActivity({
      taskId,
      userId,
      action: 'subtask.promoted',
      details: { path: subtaskPath, promotedTaskId: promotedId, title: nodeObj.title },
    });

    await this.notifyProjectProgress(this.getDocProjectIds(task));

    return {
      task: serializeTask(task.toObject()),
      promotedTask: serializeTask(promotedDoc.toObject()),
    };
  }

  async attachTaskAsSubtask(
    userId: string,
    targetTaskId: string,
    input: AttachTaskAsSubtaskInput
  ) {
    const { sourceTaskId, parentPath, index } = input;

    if (sourceTaskId === targetTaskId) {
      throw new Error('Cannot attach a task to itself');
    }

    const [sourceTask, targetTask] = await Promise.all([
      this.loadAccessibleTask(userId, sourceTaskId, 'editor'),
      this.loadAccessibleTask(userId, targetTaskId, 'editor'),
    ]);

    if (!sourceTask || !targetTask) return null;

    const [sourceProjectIds, targetProjectIds] = await Promise.all([
      this.resolveTaskProjectIds(userId, sourceTask),
      this.resolveTaskProjectIds(userId, targetTask),
    ]);
    const shareAny = sourceProjectIds.some((id) => targetProjectIds.includes(id));
    if (!shareAny) {
      throw new Error('Tasks must share at least one project');
    }

    if (this.getDocProjectIds(targetTask).length === 0) {
      (targetTask as { projectIds: string[] }).projectIds = targetProjectIds;
      targetTask.projectId = targetProjectIds[0];
    }

    const targetParentArray = this.getParentArray(targetTask, parentPath);
    if (!targetParentArray) return null;

    const sourceObj = sourceTask.toObject() as Record<string, unknown>;
    const newSubtask = this.taskDocToSubtaskNode(sourceObj);
    const subtaskId = String((newSubtask as { _id: Types.ObjectId })._id);

    let insertIndex = index ?? targetParentArray.length;
    insertIndex = Math.max(0, Math.min(insertIndex, targetParentArray.length));
    targetParentArray.splice(insertIndex, 0, newSubtask as (typeof targetParentArray)[0]);

    if (!targetTask.links.some((l) => l.taskId === sourceTaskId && l.type === 'related')) {
      targetTask.links.push({ taskId: sourceTaskId, type: 'related' });
    }

    finalizeTaskProgress(targetTask);
    targetTask.markModified('subtasks');
    await targetTask.save();
    await TaskModel.deleteOne({ _id: sourceTaskId });
    await enqueueEmbeddingJob(targetTaskId);

    await logActivity({
      taskId: targetTaskId,
      userId,
      action: 'task.attached_as_subtask',
      details: {
        sourceTaskId,
        parentPath,
        index: insertIndex,
        subtaskId,
        title: sourceObj.title,
      },
    });

    await this.notifyProjectProgress([...sourceProjectIds, ...targetProjectIds]);

    return {
      targetTask: serializeTask(targetTask.toObject()),
      removedTaskId: sourceTaskId,
      subtaskId,
    };
  }

  async reorderProjectTask(userId: string, projectId: string, taskId: string, index: number) {
    await this.requireProjectEdit(userId, projectId);

    const tasks = await TaskModel.find({
      $or: [{ projectIds: projectId }, { projectId }],
      staging: { $exists: false },
    }).sort({
      sortOrder: 1,
      createdAt: -1,
    });
    const orderedIds = tasks.map((task) => String(task._id));
    const fromIndex = orderedIds.indexOf(taskId);
    if (fromIndex === -1) return null;

    const clampedIndex = Math.max(0, Math.min(index, orderedIds.length - 1));
    const [movedId] = orderedIds.splice(fromIndex, 1);
    orderedIds.splice(clampedIndex, 0, movedId!);

    await Promise.all(
      orderedIds.map((id, sortOrder) => TaskModel.updateOne({ _id: id }, { $set: { sortOrder } }))
    );

    await logActivity({
      taskId,
      userId,
      action: 'task.reordered',
      details: { projectId, index: clampedIndex },
    });

    return this.listTasks(userId, { projectId });
  }

  async moveTaskToProject(userId: string, taskId: string, projectId: string) {
    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    const previousProjectIds = this.getDocProjectIds(task);
    for (const existingId of previousProjectIds) {
      await this.requireProjectEdit(userId, existingId);
    }
    await this.requireProjectEdit(userId, projectId);

    (task as { projectIds: string[] }).projectIds = [projectId];
    task.projectId = projectId;
    await task.save();

    await logActivity({
      taskId,
      userId,
      action: 'task.moved_project',
      details: { projectId },
    });

    await this.notifyProjectProgress([...previousProjectIds, projectId]);

    return serializeTask(task.toObject());
  }

  async shareTaskToProject(userId: string, taskId: string, projectId: string) {
    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    await this.requireProjectEdit(userId, projectId);

    const next = new Set(this.getDocProjectIds(task));
    next.add(projectId);
    const projectIds = [...next];
    (task as { projectIds: string[] }).projectIds = projectIds;
    task.projectId = projectIds[0];
    await task.save();

    await logActivity({
      taskId,
      userId,
      action: 'task.shared_project',
      details: { projectId, projectIds },
    });

    await this.notifyProjectProgress(projectIds);

    return serializeTask(task.toObject());
  }

  async unlinkTaskFromProject(userId: string, taskId: string, projectId: string) {
    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    await this.requireProjectEdit(userId, projectId);

    const remaining = this.getDocProjectIds(task).filter((id) => id !== projectId);
    if (remaining.length === 0) {
      throw new HttpError(400, 'Cannot unlink the last project from a task');
    }

    (task as { projectIds: string[] }).projectIds = remaining;
    task.projectId = remaining[0];
    await task.save();

    await logActivity({
      taskId,
      userId,
      action: 'task.unlinked_project',
      details: { projectId, projectIds: remaining },
    });

    await this.notifyProjectProgress([projectId, ...remaining]);

    return serializeTask(task.toObject());
  }

  async duplicateTask(userId: string, taskId: string, projectId: string) {
    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    await this.requireProjectEdit(userId, projectId);

    const source = task.toObject() as Record<string, unknown>;
    const duplicatedSubtasks = this.cloneSubtreeWithNewIds(
      (source.subtasks as Record<string, unknown>[]) ?? []
    );

    const doc = new TaskModel({
      userId,
      projectId,
      projectIds: [projectId],
      title: source.title,
      description: source.description,
      status: source.status ?? 'todo',
      priority: source.priority ?? 'medium',
      dueDate: source.dueDate,
      tags: source.tags ?? [],
      percentComplete: source.percentComplete ?? 0,
      percentCompleteOverride: source.percentCompleteOverride,
      progressShare: source.progressShare,
      hoursSpent: source.hoursSpent,
      hoursRemaining: source.hoursRemaining,
      lastProgressField: source.lastProgressField,
      subtasks: duplicatedSubtasks,
      links: [],
    });

    const minTask = await TaskModel.findOne({
      $or: [{ projectIds: projectId }, { projectId }],
      staging: { $exists: false },
    })
      .sort({ sortOrder: 1 })
      .select('sortOrder')
      .lean();
    doc.sortOrder = minTask ? (minTask.sortOrder ?? 0) - 1 : 0;

    const withPercent = applyPercentComplete(
      doc.toObject() as Parameters<typeof applyPercentComplete>[0]
    );
    doc.status = withPercent.status as typeof doc.status;
    doc.percentComplete = withPercent.percentComplete;
    doc.subtasks = withPercent.subtasks as typeof doc.subtasks;

    await doc.save();
    await enqueueEmbeddingJob(String(doc._id));

    await logActivity({
      taskId: String(doc._id),
      userId,
      action: 'task.duplicated',
      details: { sourceTaskId: taskId, projectId },
    });

    return serializeTask(doc.toObject());
  }

  async duplicateSubtaskToProject(
    userId: string,
    taskId: string,
    subtaskPath: string[],
    projectId: string
  ) {
    if (subtaskPath.length === 0) return null;

    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    await this.requireProjectEdit(userId, projectId);

    const subtask = this.findSubtaskByPath(task.subtasks, subtaskPath);
    if (!subtask) return null;

    const nodeObj =
      typeof (subtask as { toObject?: () => Record<string, unknown> }).toObject === 'function'
        ? (subtask as unknown as { toObject: () => Record<string, unknown> }).toObject()
        : (subtask as unknown as Record<string, unknown>);

    const duplicatedSubtasks = this.cloneSubtreeWithNewIds(
      (nodeObj.subtasks as Record<string, unknown>[]) ?? []
    );

    const doc = new TaskModel({
      userId,
      projectId,
      projectIds: [projectId],
      title: nodeObj.title,
      description: nodeObj.description,
      status: nodeObj.status ?? 'todo',
      priority: nodeObj.priority ?? 'medium',
      dueDate: nodeObj.dueDate,
      tags: nodeObj.tags ?? [],
      percentComplete: nodeObj.percentComplete ?? 0,
      percentCompleteOverride: nodeObj.percentCompleteOverride,
      progressShare: nodeObj.progressShare,
      hoursSpent: nodeObj.hoursSpent,
      hoursRemaining: nodeObj.hoursRemaining,
      lastProgressField: nodeObj.lastProgressField,
      subtasks: duplicatedSubtasks,
      links: [],
    });

    const minTask = await TaskModel.findOne({
      $or: [{ projectIds: projectId }, { projectId }],
      staging: { $exists: false },
    })
      .sort({ sortOrder: 1 })
      .select('sortOrder')
      .lean();
    doc.sortOrder = minTask ? (minTask.sortOrder ?? 0) - 1 : 0;

    const withPercent = applyPercentComplete(
      doc.toObject() as Parameters<typeof applyPercentComplete>[0]
    );
    doc.status = withPercent.status as typeof doc.status;
    doc.percentComplete = withPercent.percentComplete;
    doc.subtasks = withPercent.subtasks as typeof doc.subtasks;

    await doc.save();
    await enqueueEmbeddingJob(String(doc._id));

    return serializeTask(doc.toObject());
  }

  async promoteSubtaskToProject(
    userId: string,
    taskId: string,
    subtaskPath: string[],
    projectId: string
  ) {
    await this.requireProjectEdit(userId, projectId);
    const result = await this.promoteSubtaskToTask(userId, taskId, subtaskPath);
    if (!result) return null;

    const moved = await this.moveTaskToProject(userId, result.promotedTask._id, projectId);
    return {
      task: result.task,
      promotedTask: moved ?? result.promotedTask,
    };
  }

  async deleteSubtask(
    userId: string,
    taskId: string,
    subtaskPath: string[],
    options: { keepChildren?: boolean } = {}
  ) {
    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task || subtaskPath.length === 0) return null;

    const subtaskId = subtaskPath[subtaskPath.length - 1]!;
    const parentPath = subtaskPath.slice(0, -1);
    const parentArray = this.getParentArray(task, parentPath);
    if (!parentArray) return null;

    const index = parentArray.findIndex((s) => String(s._id) === subtaskId);
    if (index === -1) return null;

    const node = parentArray[index] as {
      title?: string;
      subtasks?: Array<{ _id: Types.ObjectId; subtasks?: unknown[] }>;
    };
    const deletedTitle = node.title;
    const children = [...(node.subtasks ?? [])];
    const keepChildren = Boolean(options.keepChildren) && children.length > 0;

    parentArray.splice(index, 1);
    if (keepChildren) {
      parentArray.splice(index, 0, ...children);
    }

    finalizeTaskProgress(task);
    task.markModified('subtasks');
    await task.save();
    await enqueueEmbeddingJob(taskId);

    await logActivity({
      taskId,
      userId,
      action: keepChildren ? 'subtask.deleted_keep_children' : 'subtask.deleted',
      details: {
        title: deletedTitle,
        path: subtaskPath,
        promotedChildIds: keepChildren ? children.map((child) => String(child._id)) : undefined,
      },
    });

    await this.notifyProjectProgress(this.getDocProjectIds(task));

    return serializeTask(task.toObject());
  }

  private taskDocToSubtaskNode(source: Record<string, unknown>): Record<string, unknown> {
    const nested = ((source.subtasks as Record<string, unknown>[]) ?? []).map((subtask) =>
      this.preserveSubtaskNode(subtask)
    );

    return {
      _id: new Types.ObjectId(),
      title: source.title,
      description: source.description,
      status: source.status ?? 'todo',
      priority: source.priority ?? 'medium',
      dueDate: source.dueDate,
      tags: source.tags ?? [],
      percentComplete: source.percentComplete ?? 0,
      percentCompleteOverride: source.percentCompleteOverride,
      progressShare: source.progressShare,
      hoursSpent: source.hoursSpent,
      hoursRemaining: source.hoursRemaining,
      lastProgressField: source.lastProgressField,
      subtasks: nested,
      links: source.links ?? [],
    };
  }

  private preserveSubtaskNode(subtask: Record<string, unknown>): Record<string, unknown> {
    const nested = ((subtask.subtasks as Record<string, unknown>[]) ?? []).map((child) =>
      this.preserveSubtaskNode(child)
    );

    return {
      ...subtask,
      subtasks: nested,
    };
  }

  private cloneSubtreeWithNewIds(subtasks: Record<string, unknown>[]): Record<string, unknown>[] {
    return subtasks.map((subtask) => {
      const maybeDoc = subtask as { toObject?: () => Record<string, unknown> };
      const node = maybeDoc.toObject ? maybeDoc.toObject() : { ...subtask };
      return {
        ...node,
        _id: new Types.ObjectId(),
        subtasks: this.cloneSubtreeWithNewIds(
          ((node.subtasks as Record<string, unknown>[]) ?? [])
        ),
      };
    });
  }

  private async resolveTaskProjectIds(
    userId: string,
    task: { projectId?: unknown; projectIds?: unknown }
  ): Promise<string[]> {
    const ids = this.getDocProjectIds(task).filter((id) => Types.ObjectId.isValid(id));
    if (ids.length > 0) return ids;
    return [await (await projects()).ensureDefaultProject(userId)];
  }

  private async resolveTaskProjectId(
    userId: string,
    task: { projectId?: unknown; projectIds?: unknown }
  ): Promise<string> {
    const ids = await this.resolveTaskProjectIds(userId, task);
    return ids[0]!;
  }

  private getParentArray(
    task: { subtasks: Array<{ _id: Types.ObjectId; subtasks?: unknown[] }> },
    parentPath: string[]
  ): Array<{ _id: Types.ObjectId; subtasks?: unknown[] }> | null {
    if (parentPath.length === 0) {
      return task.subtasks;
    }
    const parent = this.findSubtaskByPath(
      task.subtasks as Array<{ _id: Types.ObjectId; subtasks?: Array<{ _id: Types.ObjectId; subtasks?: unknown[] }> }>,
      parentPath
    );
    if (!parent) return null;
    parent.subtasks = parent.subtasks ?? [];
    return parent.subtasks as Array<{ _id: Types.ObjectId; subtasks?: unknown[] }>;
  }

  private isDescendantOrSelfPath(fromPath: string[], toParentPath: string[]): boolean {
    if (toParentPath.length < fromPath.length) return false;
    return fromPath.every((id, i) => toParentPath[i] === id);
  }

  private findSubtaskByPath(
    subtasks: Array<{ _id: Types.ObjectId; subtasks?: Array<{ _id: Types.ObjectId; subtasks?: unknown[] }> }>,
    path: string[]
  ): { subtasks: Array<{ _id: Types.ObjectId; subtasks?: unknown[] }> } | null {
    let current = subtasks;
    let node: (typeof subtasks)[0] | null = null;

    for (const id of path) {
      node = current.find((s) => String(s._id) === id) ?? null;
      if (!node) return null;
      current = (node.subtasks ?? []) as typeof subtasks;
    }

    return node as { subtasks: Array<{ _id: Types.ObjectId; subtasks?: unknown[] }> } | null;
  }

  private async semanticSearch(
    userId: string,
    queryText: string,
    baseQuery: Record<string, unknown>
  ): Promise<Array<{ task: Record<string, unknown>; score: number }>> {
    try {
      const queryEmbedding = await generateEmbedding(queryText, {
        userId,
        source: 'semantic_search',
        degradedFallback: true,
      });
      const candidates = await TaskModel.find({
        ...baseQuery,
        embedding: { $exists: true, $ne: [] },
      }).lean();

      return candidates
        .map((task) => ({
          task,
          score: cosineSimilarity(queryEmbedding, task.embedding ?? []),
        }))
        .filter((entry) => entry.score > 0.3)
        .sort((a, b) => b.score - a.score);
    } catch {
      return [];
    }
  }
}

export const taskService = new TaskService();
