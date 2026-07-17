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
import { buildSubtaskTree, serializeTask } from '../utils/serialization.js';
import { logActivity } from './activityService.js';
import { enqueueEmbeddingJob } from './embeddingQueue.js';
import { cosineSimilarity, generateEmbedding } from './embeddingService.js';

async function projects() {
  const { projectService } = await import('./projectService.js');
  return projectService;
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
  private async accessibleTaskQuery(userId: string): Promise<Record<string, unknown>> {
    const projectIds = await (await projects()).listAccessibleProjectIds(userId);
    if (projectIds.length === 0) {
      return { userId };
    }
    return {
      $or: [{ userId }, { projectId: { $in: projectIds } }],
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

    // Only treat the task as project-scoped when it has a real project reference.
    // An orphaned/invalid projectId (e.g. a stray title string) falls through to the
    // ownership check so the owner can still manage and delete the task.
    if (task.projectId && Types.ObjectId.isValid(String(task.projectId))) {
      const access = await (await projects()).getProjectAccess(userId, String(task.projectId));
      if (access) {
        if (!roleAtLeast(access.role, minRole)) {
          throw new HttpError(403, 'Insufficient project permissions');
        }
        return { task, role: access.role };
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

  async createTask(
    userId: string,
    input: CreateTaskInput,
    source: 'user' | 'ai' = 'user',
    staging?: StagingContext
  ) {
    const subtasks = (input.subtasks ?? []).map(buildSubtaskTree);

    let projectId = input.projectId;
    if (projectId) {
      if (staging) {
        await (await projects()).assertProjectAccessForStaging(userId, projectId, staging);
      } else {
        await this.requireProjectEdit(userId, projectId);
      }
    } else {
      projectId = await (await projects()).ensureDefaultProject(userId);
    }

    const taskDoc = new TaskModel({
      userId,
      projectId,
      title: input.title,
      description: input.description,
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

    if (projectId) {
      const minTask = await TaskModel.findOne({ projectId, staging: { $exists: false } })
        .sort({ sortOrder: 1 })
        .select('sortOrder')
        .lean();
      taskDoc.sortOrder = minTask ? (minTask.sortOrder ?? 0) - 1 : 0;
    }

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
    if (filters.projectId) query.projectId = filters.projectId;
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
    const loaded = await this.loadAccessibleTaskWithRole(userId, taskId, 'executor');
    if (!loaded) return null;
    const { task, role } = loaded;

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
      if (input.projectId !== undefined) {
        if (input.projectId !== null) {
          await this.requireProjectEdit(userId, input.projectId);
        }
        task.projectId = input.projectId === null ? undefined : input.projectId;
        changes.projectId = input.projectId;
      }
      if (input.assigneeId !== undefined) {
        task.assigneeId = input.assigneeId === null ? undefined : input.assigneeId;
        changes.assigneeId = input.assigneeId;
      }
    }

    finalizeTaskProgress(task);

    await task.save();
    await enqueueEmbeddingJob(String(task._id));

    await logActivity({
      taskId: String(task._id),
      userId,
      action: 'task.updated',
      details: changes,
      source,
    });

    return serializeTask(task.toObject());
  }

  async deleteTask(userId: string, taskId: string, options: { keepChildren?: boolean } = {}) {
    const task = await this.loadAccessibleTask(userId, taskId, 'editor');
    if (!task) return null;

    const title = task.title;
    const keepChildren = Boolean(options.keepChildren) && (task.subtasks?.length ?? 0) > 0;

    if (!keepChildren) {
      await task.deleteOne();
      await logActivity({
        taskId,
        userId,
        action: 'task.deleted',
        details: { title },
      });
      return { deleted: true as const, promotedTasks: [] as ReturnType<typeof serializeTask>[] };
    }

    let projectId =
      task.projectId && Types.ObjectId.isValid(String(task.projectId))
        ? String(task.projectId)
        : undefined;
    if (!projectId) {
      projectId = await (await projects()).ensureDefaultProject(userId);
    }

    const parentSortOrder = task.sortOrder ?? 0;
    const children = (task.subtasks ?? []).map((child) => {
      const maybeDoc = child as { toObject?: () => Record<string, unknown> };
      return maybeDoc.toObject ? maybeDoc.toObject() : (child as unknown as Record<string, unknown>);
    });

    const promotedDocs = children.map((child, index) => {
      const doc = new TaskModel({
        userId: task.userId,
        projectId,
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
          projectId,
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
        projectId: task.projectId,
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

    return serializeTask(task.toObject());
  }

  async updateSubtask(
    userId: string,
    taskId: string,
    subtaskPath: string[],
    input: UpdateSubtaskInput,
    source: 'user' | 'ai' = 'user'
  ) {
    const loaded = await this.loadAccessibleTaskWithRole(userId, taskId, 'executor');
    if (!loaded || subtaskPath.length === 0) return null;
    const { task, role } = loaded;

    const subtask = this.findSubtaskByPath(task.subtasks, subtaskPath);
    if (!subtask) return null;

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
    await task.save();
    await enqueueEmbeddingJob(String(task._id));

    await logActivity({
      taskId,
      userId,
      action: 'subtask.updated',
      details: { path: subtaskPath, ...changes },
      source,
    });

    return serializeTask(task.toObject());
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

    let projectId =
      task.projectId && Types.ObjectId.isValid(String(task.projectId))
        ? String(task.projectId)
        : undefined;
    if (!projectId) {
      projectId = await (await projects()).ensureDefaultProject(userId);
    }

    const promotedDoc = new TaskModel({
      userId,
      projectId,
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

    const minTask = await TaskModel.findOne({ projectId })
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

    const [sourceProjectId, targetProjectId] = await Promise.all([
      this.resolveTaskProjectId(userId, sourceTask),
      this.resolveTaskProjectId(userId, targetTask),
    ]);
    if (sourceProjectId !== targetProjectId) {
      throw new Error('Tasks must belong to the same project');
    }

    if (!targetTask.projectId) {
      targetTask.projectId = targetProjectId;
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

    return {
      targetTask: serializeTask(targetTask.toObject()),
      removedTaskId: sourceTaskId,
      subtaskId,
    };
  }

  async reorderProjectTask(userId: string, projectId: string, taskId: string, index: number) {
    await this.requireProjectEdit(userId, projectId);

    const tasks = await TaskModel.find({ projectId, staging: { $exists: false } }).sort({
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

  private async resolveTaskProjectId(
    userId: string,
    task: { projectId?: unknown }
  ): Promise<string> {
    if (task.projectId) return String(task.projectId);
    return (await projects()).ensureDefaultProject(userId);
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
