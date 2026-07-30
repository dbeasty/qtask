import type { UserSummary } from './user.js';

export interface Comment {
  _id: string;
  taskId: string;
  subtaskPath: string[];
  userId: string;
  author: UserSummary;
  body: string;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  editedAt?: string;
}

export interface CreateCommentInput {
  body: string;
  subtaskPath?: string[];
  parentId?: string;
  notifyByEmail?: boolean;
}

export interface UpdateCommentInput {
  body: string;
}

export interface ListCommentsOptions {
  subtaskPath?: string[];
}
