import { Types } from 'mongoose';
import { TaskModel } from '../models/index.js';
import type {
  CreateTaskInput,
  TaskLink,
  TaskLinkType,
  TaskSearchFilters,
  UpdateSubtaskInput,
  UpdateTaskInput,
} from '../types/task.js';
import { applyPercentComplete } from '../utils/percentComplete.js';
import { buildSubtaskTree, serializeTask } from '../utils/serialization.js';
import { logActivity } from './activityService.js';
import { enqueueEmbeddingJob } from './embeddingQueue.js';
import { buildTaskEmbeddingText, cosineSimilarity, generateEmbedding } from './embeddingService.js';

export class TaskService {
  async createTask(userId: string, input: CreateTaskInput, source: 'user' | 'ai' = 'user') {
    const subtasks = (input.subtasks ?? []).map(buildSubtaskTree);

    const taskDoc = new TaskModel({
      userId,
      projectId: input.projectId,
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
    });

    const withPercent = applyPercentComplete(taskDoc.toObject() as Parameters<typeof applyPercentComplete>[0]);
    taskDoc.percentComplete = withPercent.percentComplete;
    taskDoc.subtasks = withPercent.subtasks as typeof taskDoc.subtasks;

    await taskDoc.save();
    await enqueueEmbeddingJob(String(taskDoc._id));

    await logActivity({
      taskId: String(taskDoc._id),
      userId,
      action: 'task.created',
      details: { title: taskDoc.title },
      source,
    });

    return serializeTask(taskDoc.toObject());
  }

  async getTask(userId: string, taskId: string) {
    const task = await TaskModel.findOne({ _id: taskId, userId }).lean();
    if (!task) return null;

    const withPercent = applyPercentComplete(task as Parameters<typeof applyPercentComplete>[0]);
    return serializeTask(withPercent as unknown as Record<string, unknown>);
  }

  async listTasks(userId: string, filters: TaskSearchFilters = {}) {
    const query: Record<string, unknown> = { userId };

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

    let tasks = await TaskModel.find(query).sort({ updatedAt: -1 }).lean();

    if (filters.query) {
      const textMatches = await TaskModel.find(
        { ...query, $text: { $search: filters.query } },
        { score: { $meta: 'textScore' } }
      )
        .sort({ score: { $meta: 'textScore' } })
        .lean();

      const textIds = new Set(textMatches.map((t) => String(t._id)));
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
    const task = await TaskModel.findOne({ _id: taskId, userId });
    if (!task) return null;

    const changes: Record<string, unknown> = {};

    if (input.title !== undefined) {
      task.title = input.title;
      changes.title = input.title;
    }
    if (input.description !== undefined) {
      task.description = input.description;
      changes.description = input.description;
    }
    if (input.status !== undefined) {
      task.status = input.status;
      changes.status = input.status;
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
    if (input.percentComplete !== undefined) {
      task.percentComplete = input.percentComplete;
      changes.percentComplete = input.percentComplete;
    }
    if (input.percentCompleteOverride !== undefined) {
      task.percentCompleteOverride =
        input.percentCompleteOverride === null ? undefined : input.percentCompleteOverride;
      changes.percentCompleteOverride = input.percentCompleteOverride;
    }
    if (input.projectId !== undefined) {
      task.projectId = input.projectId === null ? undefined : input.projectId;
      changes.projectId = input.projectId;
    }
    if (input.assigneeId !== undefined) {
      task.assigneeId = input.assigneeId === null ? undefined : input.assigneeId;
      changes.assigneeId = input.assigneeId;
    }

    const withPercent = applyPercentComplete(task.toObject() as Parameters<typeof applyPercentComplete>[0]);
    task.percentComplete = withPercent.percentComplete;
    task.subtasks = withPercent.subtasks as typeof task.subtasks;

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

  async deleteTask(userId: string, taskId: string) {
    const result = await TaskModel.findOneAndDelete({ _id: taskId, userId });
    if (!result) return false;

    await logActivity({
      taskId,
      userId,
      action: 'task.deleted',
      details: { title: result.title },
    });

    return true;
  }

  async addLink(userId: string, taskId: string, linkedTaskId: string, type: TaskLinkType) {
    if (taskId === linkedTaskId) {
      throw new Error('A task cannot link to itself');
    }

    const [task, linkedTask] = await Promise.all([
      TaskModel.findOne({ _id: taskId, userId }),
      TaskModel.findOne({ _id: linkedTaskId, userId }),
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
    const task = await TaskModel.findOne({ _id: taskId, userId });
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
    const query: Record<string, unknown> = {
      userId,
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
    const task = await TaskModel.findOne({ _id: taskId, userId });
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

    const withPercent = applyPercentComplete(task.toObject() as Parameters<typeof applyPercentComplete>[0]);
    task.percentComplete = withPercent.percentComplete;
    task.subtasks = withPercent.subtasks as typeof task.subtasks;
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
    const task = await TaskModel.findOne({ _id: taskId, userId });
    if (!task || subtaskPath.length === 0) return null;

    const subtask = this.findSubtaskByPath(task.subtasks, subtaskPath);
    if (!subtask) return null;

    const changes: Record<string, unknown> = {};
    const node = subtask as Record<string, unknown>;

    if (input.title !== undefined) {
      node.title = input.title;
      changes.title = input.title;
    }
    if (input.description !== undefined) {
      node.description = input.description;
      changes.description = input.description;
    }
    if (input.status !== undefined) {
      node.status = input.status;
      changes.status = input.status;
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
    if (input.percentComplete !== undefined) {
      node.percentComplete = input.percentComplete;
      changes.percentComplete = input.percentComplete;
    }
    if (input.percentCompleteOverride !== undefined) {
      node.percentCompleteOverride =
        input.percentCompleteOverride === null ? undefined : input.percentCompleteOverride;
      changes.percentCompleteOverride = input.percentCompleteOverride;
    }

    const withPercent = applyPercentComplete(task.toObject() as Parameters<typeof applyPercentComplete>[0]);
    task.percentComplete = withPercent.percentComplete;
    task.subtasks = withPercent.subtasks as typeof task.subtasks;
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

  async deleteSubtask(userId: string, taskId: string, subtaskPath: string[]) {
    const task = await TaskModel.findOne({ _id: taskId, userId });
    if (!task || subtaskPath.length === 0) return null;

    const subtaskId = subtaskPath[subtaskPath.length - 1]!;
    let deletedTitle: string | undefined;

    if (subtaskPath.length === 1) {
      const index = task.subtasks.findIndex((s) => String(s._id) === subtaskId);
      if (index === -1) return null;
      deletedTitle = task.subtasks[index]?.title;
      task.subtasks.splice(index, 1);
    } else {
      const parent = this.findSubtaskByPath(task.subtasks, subtaskPath.slice(0, -1));
      if (!parent) return null;
      parent.subtasks = parent.subtasks ?? [];
      const index = parent.subtasks.findIndex((s) => String(s._id) === subtaskId);
      if (index === -1) return null;
      deletedTitle = (parent.subtasks[index] as { title?: string })?.title;
      parent.subtasks.splice(index, 1);
    }

    const withPercent = applyPercentComplete(task.toObject() as Parameters<typeof applyPercentComplete>[0]);
    task.percentComplete = withPercent.percentComplete;
    task.subtasks = withPercent.subtasks as typeof task.subtasks;
    await task.save();

    await logActivity({
      taskId,
      userId,
      action: 'subtask.deleted',
      details: { title: deletedTitle, path: subtaskPath },
    });

    return serializeTask(task.toObject());
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
      const queryEmbedding = await generateEmbedding(queryText);
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
