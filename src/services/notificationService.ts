import { NotificationModel } from '../models/index.js';
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

export class NotificationService {
  async createNotification(
    userId: string,
    type: NotificationType,
    payload: NotificationPayload
  ): Promise<SerializedNotification> {
    const doc = await NotificationModel.create({ userId, type, payload, read: false });
    return {
      _id: String(doc._id),
      type,
      payload,
      read: false,
      createdAt: doc.createdAt.toISOString(),
    };
  }

  async listNotifications(userId: string, limit = 50): Promise<SerializedNotification[]> {
    const docs = await NotificationModel.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return docs.map((doc) => ({
      _id: String(doc._id),
      type: doc.type as NotificationType,
      payload: (doc.payload ?? {}) as NotificationPayload,
      read: Boolean(doc.read),
      createdAt: doc.createdAt.toISOString(),
    }));
  }

  async unreadCount(userId: string): Promise<number> {
    return NotificationModel.countDocuments({ userId, read: false });
  }

  async markRead(userId: string, notificationId: string): Promise<SerializedNotification> {
    const doc = await NotificationModel.findOneAndUpdate(
      { _id: notificationId, userId },
      { $set: { read: true } },
      { new: true }
    ).lean();

    if (!doc) {
      throw new HttpError(404, 'Notification not found');
    }

    return {
      _id: String(doc._id),
      type: doc.type as NotificationType,
      payload: (doc.payload ?? {}) as NotificationPayload,
      read: true,
      createdAt: doc.createdAt.toISOString(),
    };
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await NotificationModel.updateMany(
      { userId, read: false },
      { $set: { read: true } }
    );
    return result.modifiedCount;
  }
}

export const notificationService = new NotificationService();
