import { Schema, model } from 'mongoose';
import type { TaskStatus, TaskPriority, TaskLinkType } from '../types/task.js';

const userPreferencesSchema = new Schema(
  {
    autoApproveProposals: { type: Boolean, default: false },
    skipConfirmations: { type: Boolean, default: false },
    trackExpenses: { type: Boolean, default: true },
    /** @deprecated Legacy field; migrated to trackExpenses on read */
    enableHourlyTracking: { type: Boolean },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, trim: true },
    emailVerified: { type: Boolean, default: false },
    emailVerificationTokenHash: { type: String },
    emailVerificationExpires: { type: Date },
    passwordResetTokenHash: { type: String },
    passwordResetExpires: { type: Date },
    legalAcceptedAt: { type: Date },
    legalVersion: { type: String },
    lastLoginAt: { type: Date },
    lastActiveAt: { type: Date },
    mustChangePassword: { type: Boolean, default: false },
    hourlyRate: { type: Number, min: 0 },
    preferences: { type: userPreferencesSchema, default: () => ({}) },
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

const stagingSchema = new Schema(
  {
    conversationId: { type: String, required: true, index: true },
    proposalId: { type: String, required: true },
    stagedAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { _id: false }
);

const taskStepSchema = new Schema(
  {
    text: { type: String, required: true, trim: true },
    done: { type: Boolean, default: false },
  },
  { _id: true }
);

const materialLineSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    unitPrice: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: true }
);

const laborLineSchema = new Schema(
  {
    description: { type: String, trim: true },
    hours: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: true }
);

const trackingRollupSchema = new Schema(
  {
    hoursSpent: { type: Number, default: 0, min: 0 },
    hoursRemaining: { type: Number, default: 0, min: 0 },
    materialsTotal: { type: Number, default: 0, min: 0 },
    laborCost: { type: Number, default: 0, min: 0 },
    trainingCost: { type: Number, default: 0, min: 0 },
    totalCost: { type: Number, default: 0, min: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const subtaskSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    steps: { type: [taskStepSchema], default: [] },
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
    materials: { type: [materialLineSchema], default: [] },
    laborLines: { type: [laborLineSchema], default: [] },
    hourlyRate: { type: Number, min: 0 },
    trainingHourlyRate: { type: Number, min: 0 },
    trainingHoursSpent: { type: Number, min: 0 },
    trainingHoursRemaining: { type: Number, min: 0 },
    subtasks: { type: [Schema.Types.Mixed], default: [] },
    links: { type: [taskLinkSchema], default: [] },
  },
  { timestamps: true }
);

const taskSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    /** @deprecated Prefer projectIds. Kept temporarily for migration. */
    projectId: { type: String, index: true },
    projectIds: { type: [String], default: [], index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    steps: { type: [taskStepSchema], default: [] },
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
    materials: { type: [materialLineSchema], default: [] },
    laborLines: { type: [laborLineSchema], default: [] },
    hourlyRate: { type: Number, min: 0 },
    trainingHourlyRate: { type: Number, min: 0 },
    trainingHoursSpent: { type: Number, min: 0 },
    trainingHoursRemaining: { type: Number, min: 0 },
    subtasks: { type: [subtaskSchema], default: [] },
    links: { type: [taskLinkSchema], default: [] },
    sortOrder: { type: Number, default: 0 },
    assigneeId: { type: String, index: true },
    embedding: { type: [Number] },
    staging: { type: stagingSchema },
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

const projectCollaboratorSchema = new Schema(
  {
    userId: { type: String, required: true },
    role: {
      type: String,
      enum: ['editor', 'executor', 'viewer'],
      required: true,
    },
  },
  { _id: false }
);

const projectSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    parentId: { type: String, default: null, index: true },
    sortOrder: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['todo', 'in_progress', 'done', 'cancelled'] satisfies TaskStatus[],
      default: 'todo',
    },
    percentComplete: { type: Number, default: 0, min: 0, max: 100 },
    progressShare: { type: Number, min: 0, max: 100 },
    hourlyRate: { type: Number, min: 0 },
    trainingHourlyRate: { type: Number, min: 0 },
    trackingRollup: { type: trackingRollupSchema },
    collaborators: { type: [projectCollaboratorSchema], default: [] },
    staging: { type: stagingSchema },
  },
  { timestamps: true }
);

projectSchema.index({ 'collaborators.userId': 1 });
projectSchema.index({ parentId: 1, sortOrder: 1 });

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
    projectId: { type: String, index: true },
    title: { type: String, default: 'New conversation' },
    messages: { type: [conversationMessageSchema], default: [] },
    pendingProposals: { type: [Schema.Types.Mixed], default: [] },
    pausedBatch: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

conversationSchema.index({ userId: 1, projectId: 1, updatedAt: -1 });

export const ConversationModel = model('Conversation', conversationSchema);

const llmCallMetricSchema = new Schema(
  {
    requestId: { type: String, required: true, unique: true },
    userId: { type: String, index: true },
    conversationId: { type: String },
    taskId: { type: String },
    callType: { type: String, enum: ['chat', 'generate', 'embed'], required: true, index: true },
    source: {
      type: String,
      enum: ['chat_loop', 'project_summary', 'embedding_job', 'semantic_search'],
      required: true,
    },
    model: { type: String, required: true, index: true },
    startedAt: { type: Date, required: true, index: true },
    completedAt: { type: Date, required: true },
    durationMs: { type: Number, required: true },
    success: { type: Boolean, required: true, index: true },
    degradedFallback: { type: Boolean, default: false },
    httpStatus: { type: Number },
    errorCategory: { type: String },
    errorMessage: { type: String },
    totalDurationNs: { type: Number },
    loadDurationNs: { type: Number },
    promptEvalCount: { type: Number },
    promptEvalDurationNs: { type: Number },
    evalCount: { type: Number },
    evalDurationNs: { type: Number },
    iteration: { type: Number },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);

llmCallMetricSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
llmCallMetricSchema.index({ startedAt: -1, callType: 1, model: 1 });

export const LlmCallMetricModel = model('LlmCallMetric', llmCallMetricSchema);

const llmDailyMetricSchema = new Schema(
  {
    day: { type: Date, required: true },
    userId: { type: String },
    callType: { type: String, enum: ['chat', 'generate', 'embed'], required: true },
    model: { type: String, required: true },
    calls: { type: Number, default: 0 },
    successes: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    degradedFallbacks: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    evalTokens: { type: Number, default: 0 },
  },
  { timestamps: true }
);

llmDailyMetricSchema.index(
  { day: 1, userId: 1, callType: 1, model: 1 },
  { unique: true }
);

export const LlmDailyMetricModel = model('LlmDailyMetric', llmDailyMetricSchema);

const adminAuditSchema = new Schema(
  {
    adminIdentity: { type: String, required: true },
    action: { type: String, required: true },
    targetUserId: { type: String },
    targetEmail: { type: String },
    details: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const AdminAuditModel = model('AdminAudit', adminAuditSchema);
