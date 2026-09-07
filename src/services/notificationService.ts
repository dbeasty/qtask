import { collection } from '../data/index.js';
import type { NotificationDoc } from '../data/documents.js';
import { HttpError } from '../utils/httpError.js';

export type NotificationType =
  | 'project_invite'
  | 'project_share_accepted'
  | 'project_share_declined'
  | 'task_comment'
  | 'task_comment_reply'
  | 'feedback_rejected'
  | 'feedback_reply';

export type NotificationPayload = {
  projectId?: string;
  projectName?: string;
  inviterEmail?: string;
  inviterDisplayName?: string;
  inviteeEmail?: string;
  inviteeDisplayName?: string;
  role?: string;
  inviteId?: string;
  taskId?: string;
  taskTitle?: string;
  commentId?: string;
  commentPreview?: string;
  authorDisplayName?: string;
  authorEmail?: string;
  subtaskPath?: string[];
  feedbackId?: string;
  message?: string;
  reason?: string;
  reply?: string;
};

export type SerializedNotification = {
  _id: string;
  type: NotificationType;
  payload: NotificationPayload;
  read: boolean;
  createdAt: string;
};

function notifications() {
  return collection<NotificationDoc>('notifications');
}

function toIso(value: Date | undefined): string {
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

export class NotificationService {
  async createNotification(
    userId: string,
    type: NotificationType,
    payload: NotificationPayload
  ): Promise<SerializedNotification> {
    const doc = await notifications().create({ userId, type, payload, read: false });
    return {
      _id: String(doc._id),
      type,
      payload,
      read: false,
      createdAt: toIso(doc.createdAt),
    };
  }

  async listNotifications(userId: string, limit = 50): Promise<SerializedNotification[]> {
    const docs = await notifications().find({ userId }, { sort: { createdAt: -1 }, limit });

    return docs.map((doc) => ({
      _id: String(doc._id),
      type: doc.type as NotificationType,
      payload: (doc.payload ?? {}) as NotificationPayload,
      read: Boolean(doc.read),
      createdAt: toIso(doc.createdAt),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    return notifications().countDocuments({ userId, read: false });
  }

  async markRead(userId: string, notificationId: string): Promise<SerializedNotification> {
    const doc = await notifications().findOneAndUpdate(
      { _id: notificationId, userId },
      { $set: { read: true } },
      { returnDocument: 'after' }
    );

    if (!doc) {
      throw new HttpError(404, 'Notification not found');
    }

    return {
      _id: String(doc._id),
      type: doc.type as NotificationType,
      payload: (doc.payload ?? {}) as NotificationPayload,
      read: true,
      createdAt: toIso(doc.createdAt),
    };
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await notifications().updateMany(
      { userId, read: false },
      { $set: { read: true } }
    );
    return result.modified;
  }
}

export const notificationService = new NotificationService();
