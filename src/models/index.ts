import { Schema, model } from 'mongoose';
import type { TaskStatus, TaskPriority, TaskLinkType } from '../types/task.js';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, trim: true },
  },
  { timestamps: true }
);

export const UserModel = model('User', userSchema);

const taskLinkSchema = new Schema(
  {
    taskId: { type: String, required: true },
    type: {
      type: String,
      enum: ['related', 'blocking', 'blocked_by'] satisfies TaskLinkType[],
      required: true,
    },
  },
  { _id: false }
);

const subtaskSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    status: {
      type: String,
      enum: ['todo', 'in_progress', 'done', 'cancelled'] satisfies TaskStatus[],
      default: 'todo',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'] satisfies TaskPriority[],
      default: 'medium',
    },
    dueDate: { type: Date },
    tags: { type: [String], default: [] },
    percentComplete: { type: Number, default: 0, min: 0, max: 100 },
    percentCompleteOverride: { type: Number, min: 0, max: 100 },
    progressShare: { type: Number, min: 0, max: 100 },
    hoursSpent: { type: Number, min: 0 },
    hoursRemaining: { type: Number, min: 0 },
    lastProgressField: {
      type: String,
      enum: ['percent', 'hoursSpent', 'hoursRemaining'],
    },
    subtasks: { type: [Schema.Types.Mixed], default: [] },
    links: { type: [taskLinkSchema], default: [] },
  },
  { timestamps: true }
);

const taskSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    projectId: { type: String, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    status: {
      type: String,
      enum: ['todo', 'in_progress', 'done', 'cancelled'] satisfies TaskStatus[],
      default: 'todo',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'] satisfies TaskPriority[],
      default: 'medium',
      index: true,
    },
    dueDate: { type: Date, index: true },
    tags: { type: [String], default: [], index: true },
    percentComplete: { type: Number, default: 0, min: 0, max: 100 },
    percentCompleteOverride: { type: Number, min: 0, max: 100 },
    progressShare: { type: Number, min: 0, max: 100 },
    hoursSpent: { type: Number, min: 0 },
    hoursRemaining: { type: Number, min: 0 },
    lastProgressField: {
      type: String,
      enum: ['percent', 'hoursSpent', 'hoursRemaining'],
    },
    subtasks: { type: [subtaskSchema], default: [] },
    links: { type: [taskLinkSchema], default: [] },
    sortOrder: { type: Number, default: 0 },
    assigneeId: { type: String, index: true },
    embedding: { type: [Number] },
  },
  { timestamps: true }
);

taskSchema.index({ title: 'text', description: 'text', tags: 'text' });

export const TaskModel = model('Task', taskSchema);

const activitySchema = new Schema(
  {
    taskId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    action: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: {} },
    source: { type: String, enum: ['user', 'ai', 'system'], default: 'user' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const ActivityModel = model('Activity', activitySchema);

const embeddingJobSchema = new Schema(
  {
    taskId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
  },
  { timestamps: true }
);

export const EmbeddingJobModel = model('EmbeddingJob', embeddingJobSchema);

const projectSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
  },
  { timestamps: true }
);

export const ProjectModel = model('Project', projectSchema);

const conversationMessageSchema = new Schema(
  {
    role: { type: String, enum: ['system', 'user', 'assistant', 'tool'], required: true },
    content: { type: String, default: '' },
    toolCalls: { type: [Schema.Types.Mixed] },
    toolName: { type: String },
  },
  { _id: false }
);

const conversationSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    title: { type: String, default: 'New conversation' },
    messages: { type: [conversationMessageSchema], default: [] },
    pendingProposals: { type: [Schema.Types.Mixed], default: [] },
    pausedBatch: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

export const ConversationModel = model('Conversation', conversationSchema);
