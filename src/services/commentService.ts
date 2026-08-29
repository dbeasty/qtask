import { Types } from 'mongoose';
import { CommentModel, ProjectModel, UserModel } from '../models/index.js';
import type { Comment, CreateCommentInput, ListCommentsOptions, UpdateCommentInput } from '../types/comment.js';
import { canEditProject } from '../types/project.js';
import { HttpError } from '../utils/httpError.js';
import { serializeComment } from '../utils/serialization.js';
import { logActivity } from './activityService.js';
import { enqueueEmbeddingJob } from './embeddingQueue.js';
import { sendCommentNotificationEmail } from './emailService.js';
import { notificationService, type NotificationType } from './notificationService.js';
import { taskService } from './taskService.js';

const MAX_COMMENT_DEPTH = 5;
const BODY_PREVIEW_LENGTH = 120;

function normalizeSubtaskPath(path?: string[]): string[] {
  return path?.filter(Boolean) ?? [];
}

function bodyPreview(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= BODY_PREVIEW_LENGTH) return trimmed;
  return `${trimmed.slice(0, BODY_PREVIEW_LENGTH)}…`;
}

function subtaskPathQuery(subtaskPath: string[]): Record<string, unknown> {
  if (subtaskPath.length === 0) {
    return { $or: [{ subtaskPath: { $exists: false } }, { subtaskPath: { $size: 0 } }] };
  }
  return { subtaskPath };
}

async function loadAuthors(userIds: string[]): Promise<Map<string, { userId: string; email: string; displayName?: string }>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();

  const users = await UserModel.find({ _id: { $in: unique } }).select('email displayName').lean();
  const map = new Map<string, { userId: string; email: string; displayName?: string }>();
  for (const user of users) {
    const userId = String(user._id);
    map.set(userId, {
      userId,
      email: user.email,
      displayName: user.displayName ?? undefined,
    });
  }
  return map;
}

async function serializeComments(docs: Array<{
  _id: unknown;
  taskId: string;
  subtaskPath?: string[];
  userId: string;
  body: string;
  parentId?: string | null;
  editedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>): Promise<Comment[]> {
  const authors = await loadAuthors(docs.map((doc) => doc.userId));
  return docs.map((doc) =>
    serializeComment(
      {
        ...doc,
        parentId: doc.parentId ?? undefined,
        editedAt: doc.editedAt ?? undefined,
      },
      authors.get(doc.userId) ?? { userId: doc.userId, email: 'unknown' }
    )
  );
}

async function getCommentDepth(parentId: string): Promise<number> {
  let depth = 1;
  let currentId: string | undefined = parentId;

  while (currentId) {
    const parent: { parentId?: string | null } | null = await CommentModel.findById(currentId)
      .select('parentId')
      .lean();
    if (!parent) break;
    depth += 1;
    if (depth >= MAX_COMMENT_DEPTH) return depth;
    currentId = parent.parentId ?? undefined;
  }

  return depth;
}

async function resolveProjectContext(task: {
  projectIds?: string[];
  projectId?: string;
}): Promise<{ projectId?: string; projectName?: string }> {
  const projectIds = [
    ...(Array.isArray(task.projectIds) ? task.projectIds.map(String) : []),
    task.projectId ? String(task.projectId) : '',
  ].filter((id) => id && Types.ObjectId.isValid(id));

  const projectId = projectIds[0];
  if (!projectId) return {};

  const project = await ProjectModel.findById(projectId).select('name').lean();
  return { projectId, projectName: project?.name };
}

async function notifyCommentRecipients(input: {
  authorUserId: string;
  authorDisplayName?: string;
  authorEmail: string;
  task: { _id: unknown; userId: string; title: string; assigneeId?: string; projectIds?: string[]; projectId?: string };
  commentId: string;
  commentBody: string;
  subtaskPath: string[];
  parentAuthorUserId?: string;
  notifyByEmail: boolean;
  notificationType: NotificationType;
}): Promise<void> {
  const recipientIds = new Set<string>();

  if (input.task.assigneeId && input.task.assigneeId !== input.authorUserId) {
    recipientIds.add(input.task.assigneeId);
  }
  if (input.task.userId !== input.authorUserId) {
    recipientIds.add(input.task.userId);
  }
  if (input.parentAuthorUserId && input.parentAuthorUserId !== input.authorUserId) {
    recipientIds.add(input.parentAuthorUserId);
  }

  if (recipientIds.size === 0) return;

  const { projectId, projectName } = await resolveProjectContext(input.task);
  const preview = bodyPreview(input.commentBody);
  const authorLabel = input.authorDisplayName || input.authorEmail;

  const payload = {
    taskId: String(input.task._id),
    taskTitle: input.task.title,
    commentId: input.commentId,
    commentPreview: preview,
    authorDisplayName: input.authorDisplayName,
    authorEmail: input.authorEmail,
    subtaskPath: input.subtaskPath.length > 0 ? input.subtaskPath : undefined,
    projectId,
    projectName,
  };

  const users = await UserModel.find({ _id: { $in: [...recipientIds] } })
    .select('email displayName')
    .lean();

  for (const user of users) {
    const userId = String(user._id);
    await notificationService.createNotification(userId, input.notificationType, payload);

    if (input.notifyByEmail) {
      await sendCommentNotificationEmail({
        to: user.email,
        authorName: authorLabel,
        taskTitle: input.task.title,
        commentPreview: preview,
        taskId: String(input.task._id),
        subtaskPath: input.subtaskPath,
        projectId,
        isReply: input.notificationType === 'task_comment_reply',
      });
    }
  }
}

async function cascadeDeleteComment(commentId: string): Promise<void> {
  const childIds = await CommentModel.find({ parentId: commentId }).select('_id').lean();
  for (const child of childIds) {
    await cascadeDeleteComment(String(child._id));
  }
  await CommentModel.deleteOne({ _id: commentId });
}

export class CommentService {
  async listComments(userId: string, taskId: string, options: ListCommentsOptions = {}): Promise<Comment[]> {
    await taskService.assertTaskAccess(userId, taskId, 'viewer');

    const subtaskPath = normalizeSubtaskPath(options.subtaskPath);
    const docs = await CommentModel.find({ taskId, ...subtaskPathQuery(subtaskPath) })
      .sort({ createdAt: 1 })
      .lean();

    return serializeComments(docs);
  }

  async listCommentsForTask(userId: string, taskId: string, stagingConversationId?: string): Promise<Comment[]> {
    await taskService.assertTaskAccess(userId, taskId, 'viewer', stagingConversationId);

    const docs = await CommentModel.find({ taskId }).sort({ createdAt: 1 }).lean();
    return serializeComments(docs);
  }

  async createComment(
    userId: string,
    taskId: string,
    input: CreateCommentInput,
    stagingConversationId?: string
  ): Promise<Comment> {
    const { task: taskDoc } = await taskService.assertTaskAccess(userId, taskId, 'executor', stagingConversationId);
    const task = taskDoc as {
      _id: unknown;
      userId: string;
      title: string;
      assigneeId?: string | null;
      projectIds?: string[];
      projectId?: string | null;
      subtasks?: Array<{ _id: { toString(): string }; subtasks?: unknown[] }>;
    };
    const subtaskPath = normalizeSubtaskPath(input.subtaskPath);
    taskService.assertSubtaskPathExists(task, subtaskPath);

    const body = input.body.trim();
    if (!body) {
      throw new HttpError(400, 'body is required');
    }

    let parentAuthorUserId: string | undefined;
    const notificationType: NotificationType = input.parentId
      ? 'task_comment_reply'
      : 'task_comment';

    if (input.parentId) {
      if (!Types.ObjectId.isValid(input.parentId)) {
        throw new HttpError(400, 'Invalid parent comment id');
      }

      const parent = await CommentModel.findOne({ _id: input.parentId, taskId }).lean();
      if (!parent) {
        throw new HttpError(404, 'Parent comment not found');
      }

      const parentPath = parent.subtaskPath ?? [];
      if (parentPath.join(',') !== subtaskPath.join(',')) {
        throw new HttpError(400, 'Parent comment belongs to a different task scope');
      }

      const depth = await getCommentDepth(input.parentId);
      if (depth >= MAX_COMMENT_DEPTH) {
        throw new HttpError(400, `Comment threads cannot exceed ${MAX_COMMENT_DEPTH} levels`);
      }

      parentAuthorUserId = parent.userId;
    }

    const doc = await CommentModel.create({
      taskId,
      subtaskPath,
      userId,
      body,
      parentId: input.parentId,
    });

    await logActivity({
      taskId,
      userId,
      action: 'comment.added',
      details: {
        commentId: String(doc._id),
        bodyPreview: bodyPreview(body),
        subtaskPath: subtaskPath.length > 0 ? subtaskPath : undefined,
        parentId: input.parentId,
      },
    });

    const author = await UserModel.findById(userId).select('email displayName').lean();
    const authorEmail = author?.email ?? 'unknown';
    const authorDisplayName = author?.displayName ?? undefined;

    await notifyCommentRecipients({
      authorUserId: userId,
      authorDisplayName,
      authorEmail,
      task: {
        _id: task._id,
        userId: task.userId,
        title: task.title,
        assigneeId: task.assigneeId ?? undefined,
        projectIds: task.projectIds,
        projectId: task.projectId ?? undefined,
      },
      commentId: String(doc._id),
      commentBody: body,
      subtaskPath,
      parentAuthorUserId,
      notifyByEmail: Boolean(input.notifyByEmail),
      notificationType,
    });

    await enqueueEmbeddingJob(taskId);

    return serializeComment(
      {
        _id: doc._id,
        taskId: doc.taskId,
        subtaskPath: doc.subtaskPath,
        userId: doc.userId,
        body: doc.body,
        parentId: doc.parentId ?? undefined,
        editedAt: doc.editedAt ?? undefined,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
      {
        userId,
        email: authorEmail,
        displayName: authorDisplayName,
      }
    );
  }

  async updateComment(
    userId: string,
    taskId: string,
    commentId: string,
    input: UpdateCommentInput
  ): Promise<Comment> {
    await taskService.assertTaskAccess(userId, taskId, 'executor');

    const body = input.body.trim();
    if (!body) {
      throw new HttpError(400, 'body is required');
    }

    const doc = await CommentModel.findOne({ _id: commentId, taskId });
    if (!doc) {
      throw new HttpError(404, 'Comment not found');
    }
    if (doc.userId !== userId) {
      throw new HttpError(403, 'You can only edit your own comments');
    }

    doc.body = body;
    doc.editedAt = new Date();
    await doc.save();

    await logActivity({
      taskId,
      userId,
      action: 'comment.updated',
      details: {
        commentId,
        bodyPreview: bodyPreview(body),
        subtaskPath: (doc.subtaskPath ?? []).length > 0 ? doc.subtaskPath : undefined,
      },
    });

    await enqueueEmbeddingJob(taskId);

    const author = await UserModel.findById(userId).select('email displayName').lean();
    return serializeComment(
      {
        _id: doc._id,
        taskId: doc.taskId,
        subtaskPath: doc.subtaskPath,
        userId: doc.userId,
        body: doc.body,
        parentId: doc.parentId ?? undefined,
        editedAt: doc.editedAt ?? undefined,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
      {
        userId,
        email: author?.email ?? 'unknown',
        displayName: author?.displayName ?? undefined,
      }
    );
  }

  async deleteComment(userId: string, taskId: string, commentId: string): Promise<void> {
    const { role } = await taskService.assertTaskAccess(userId, taskId, 'executor');

    const doc = await CommentModel.findOne({ _id: commentId, taskId }).lean();
    if (!doc) {
      throw new HttpError(404, 'Comment not found');
    }

    const isAuthor = doc.userId === userId;
    if (!isAuthor && !canEditProject(role)) {
      throw new HttpError(403, 'Insufficient project permissions');
    }

    await cascadeDeleteComment(commentId);

    await logActivity({
      taskId,
      userId,
      action: 'comment.deleted',
      details: {
        commentId,
        bodyPreview: bodyPreview(doc.body),
        subtaskPath: (doc.subtaskPath ?? []).length > 0 ? doc.subtaskPath : undefined,
      },
    });

    await enqueueEmbeddingJob(taskId);
  }
}

export const commentService = new CommentService();
