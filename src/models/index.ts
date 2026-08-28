import { Schema, model } from 'mongoose';
import type { TaskStatus, TaskPriority, TaskLinkType } from '../types/task.js';

const userPreferencesSchema = new Schema(
  {
    autoApproveProposals: { type: Boolean, default: false },
    skipConfirmations: { type: Boolean, default: false },
    trackExpenses: { type: Boolean, default: true },
    agentEnterToSend: { type: Boolean, default: true },
    completedDemoTour: { type: Boolean, default: false },
    theme: { type: String, enum: ['dark', 'light'], default: 'light' },
    startupView: {
      type: String,
      enum: ['auto', 'agent', 'projects', 'tasks', 'last'],
      default: 'last',
    },
    /** @deprecated Legacy field; migrated to trackExpenses on read */
    enableHourlyTracking: { type: Boolean },
  },
  { _id: false }
);

const identityProviderSchema = new Schema(
  {
    provider: { type: String, enum: ['google', 'microsoft'], required: true },
    providerUserId: { type: String, required: true },
    linkedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String },
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
    identityProviders: { type: [identityProviderSchema], default: [] },
  },
  { timestamps: true }
);

userSchema.index(
  { 'identityProviders.provider': 1, 'identityProviders.providerUserId': 1 },
  { unique: true, sparse: true }
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
    links: { type: [taskLinkSchema], default: [] },
  },
  { timestamps: true }
);

// Self-reference added after construction — a schema can't reference its
// own variable inside its own definition object. Without this, subtasks
// nested past depth 1 were typed as Schema.Types.Mixed and got no
// validation at all (missing title, invalid status/priority, negative
// percentComplete, arbitrary fields — none of it rejected).
subtaskSchema.add({ subtasks: { type: [subtaskSchema], default: [] } });

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

taskSchema.index({ title: 'text', description: 'text', tags: 'text', 'steps.text': 'text' });

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

const commentSchema = new Schema(
  {
    taskId: { type: String, required: true, index: true },
    subtaskPath: { type: [String], default: [] },
    userId: { type: String, required: true, index: true },
    body: { type: String, required: true, trim: true, maxlength: 10000 },
    parentId: { type: String, index: true },
    editedAt: { type: Date },
  },
  { timestamps: true }
);

commentSchema.index({ taskId: 1, createdAt: 1 });
commentSchema.index({ taskId: 1, subtaskPath: 1, createdAt: 1 });
commentSchema.index({ body: 'text' });

export const CommentModel = model('Comment', commentSchema);

const embeddingJobSchema = new Schema(
  {
    entityType: {
      type: String,
      enum: ['task', 'project'],
      default: 'task',
      required: true,
      index: true,
    },
    entityId: { type: String, required: true, index: true },
    /** @deprecated Prefer entityId when entityType is task. */
    taskId: { type: String, index: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    /** Set when this entity was edited again while its job was already
     *  'processing' — checked when the job finishes so the edit isn't
     *  silently dropped (see enqueueEntityEmbeddingJob / finishEmbeddingJob). */
    dirty: { type: Boolean, default: false },
  },
  { timestamps: true }
);

embeddingJobSchema.index({ entityType: 1, entityId: 1 }, { unique: true });

export const EmbeddingJobModel = model('EmbeddingJob', embeddingJobSchema);

const projectCollaboratorSchema = new Schema(
  {
    userId: { type: String, required: true },
    role: {
      type: String,
      enum: ['editor', 'executor', 'viewer', 'manager'],
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
    notes: { type: String, trim: true },
    parentId: { type: String, default: null, index: true },
    sortOrder: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['todo', 'in_progress', 'done', 'cancelled'] satisfies TaskStatus[],
      default: 'todo',
    },
    percentComplete: { type: Number, default: 0, min: 0, max: 100 },
    doneOverride: { type: Boolean, default: false },
    progressShare: { type: Number, min: 0, max: 100 },
    hourlyRate: { type: Number, min: 0 },
    trainingHourlyRate: { type: Number, min: 0 },
    trackingRollup: { type: trackingRollupSchema },
    collaborators: { type: [projectCollaboratorSchema], default: [] },
    embedding: { type: [Number] },
    staging: { type: stagingSchema },
  },
  { timestamps: true }
);

projectSchema.index({ name: 'text', description: 'text', notes: 'text' });
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
    callType: { type: String, enum: ['agent', 'generate', 'embed', 'feedback_vision'], required: true, index: true },
    source: {
      type: String,
      enum: ['agent_loop', 'project_summary', 'embedding_job', 'semantic_search'],
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
    callType: { type: String, enum: ['agent', 'generate', 'embed', 'feedback_vision'], required: true },
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

const inviteSchema = new Schema(
  {
    projectId: { type: String, required: true, index: true },
    inviterUserId: { type: String, required: true, index: true },
    inviteeEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    inviteeUserId: { type: String, index: true },
    role: {
      type: String,
      enum: ['editor', 'executor', 'viewer', 'manager'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'expired'],
      default: 'pending',
      index: true,
    },
    token: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);

inviteSchema.index({ projectId: 1, inviteeEmail: 1, status: 1 });
inviteSchema.index({ inviteeUserId: 1, status: 1 });

export const InviteModel = model('Invite', inviteSchema);

const notificationSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: [
        'project_invite',
        'project_share_accepted',
        'project_share_declined',
        'task_comment',
        'task_comment_reply',
        'feedback_rejected',
        'feedback_reply',
      ],
      required: true,
    },
    payload: { type: Schema.Types.Mixed, required: true },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const NotificationModel = model('Notification', notificationSchema);

const feedbackVisionCheckSchema = new Schema(
  {
    isScreenshot: { type: Boolean, required: true },
    confidence: { type: Number, min: 0, max: 1 },
    model: { type: String, required: true },
    rationale: { type: String },
    checkedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const feedbackAttachmentSchema = new Schema(
  {
    storageKey: { type: String, required: true },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    visionCheck: { type: feedbackVisionCheckSchema, required: false },
  },
  { _id: false }
);

const feedbackContextSchema = new Schema(
  {
    url: { type: String },
    userAgent: { type: String },
    appVersion: { type: String },
  },
  { _id: false }
);

const feedbackAdminReplySchema = new Schema(
  {
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    repliedAt: { type: Date, required: true },
  },
  { _id: false }
);

const feedbackSchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    category: {
      type: String,
      enum: ['bug', 'feature', 'other'],
      default: 'other',
    },
    status: {
      type: String,
      enum: ['open', 'read', 'resolved'],
      default: 'open',
      index: true,
    },
    validationStatus: {
      type: String,
      enum: ['pending', 'validated', 'rejected', 'failed'],
      default: 'validated',
      index: true,
    },
    context: { type: feedbackContextSchema, default: () => ({}) },
    attachments: { type: [feedbackAttachmentSchema], default: [] },
    adminReply: { type: feedbackAdminReplySchema, required: false },
  },
  { timestamps: true }
);

feedbackSchema.index({ status: 1, createdAt: -1 });
feedbackSchema.index({ userId: 1, createdAt: -1 });

const feedbackVisionJobSchema = new Schema(
  {
    feedbackId: { type: String, required: true },
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

feedbackVisionJobSchema.index({ feedbackId: 1 }, { unique: true });

export const FeedbackVisionJobModel = model('FeedbackVisionJob', feedbackVisionJobSchema);

export const FeedbackModel = model('Feedback', feedbackSchema);

const mcpApiKeySchema = new Schema(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true, index: true },
    scope: { type: String, enum: ['read', 'read_write'], required: true },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

mcpApiKeySchema.index({ userId: 1, createdAt: -1 });

export const McpApiKeyModel = model('McpApiKey', mcpApiKeySchema);

const mcpSessionSchema = new Schema(
  {
    _id: { type: String },
    userId: { type: String, required: true, index: true },
    keyId: { type: String, required: true, index: true },
    activeProjectId: { type: String },
    pendingProposals: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

mcpSessionSchema.index({ userId: 1, updatedAt: -1 });
mcpSessionSchema.index({ userId: 1, keyId: 1, updatedAt: -1 });
mcpSessionSchema.index({ userId: 1, keyId: 1, 'pendingProposals.id': 1 });

export const McpSessionModel = model('McpSession', mcpSessionSchema);

const mcpOAuthClientSchema = new Schema(
  {
    clientId: { type: String, required: true, unique: true, index: true },
    clientSecretHash: { type: String },
    name: { type: String, required: true, trim: true },
    userId: { type: String, index: true },
    redirectUris: { type: [String], default: [] },
    source: { type: String, enum: ['registered', 'dcr', 'cimd'], required: true },
    clientName: { type: String },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

mcpOAuthClientSchema.index({ userId: 1, createdAt: -1 });

export const McpOAuthClientModel = model('McpOAuthClient', mcpOAuthClientSchema);

const mcpOAuthAuthorizationCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true, index: true },
    clientId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    scope: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    codeChallengeMethod: { type: String, required: true, default: 'S256' },
    redirectUri: { type: String, required: true },
    resource: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Authorization codes are single-use and short-lived; without this, an
// abandoned (never-exchanged) code sits in the collection forever.
mcpOAuthAuthorizationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const McpOAuthAuthorizationCodeModel = model(
  'McpOAuthAuthorizationCode',
  mcpOAuthAuthorizationCodeSchema
);

const mcpOAuthRefreshTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    clientId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    scope: { type: String, required: true },
    resource: { type: String, required: true },
    revokedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Revoked or expired refresh tokens would otherwise accumulate forever.
mcpOAuthRefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const McpOAuthRefreshTokenModel = model('McpOAuthRefreshToken', mcpOAuthRefreshTokenSchema);

const mcpOAuthPendingConsentSchema = new Schema(
  {
    state: { type: String, required: true, unique: true, index: true },
    clientId: { type: String, required: true },
    clientName: { type: String, required: true },
    redirectUri: { type: String, required: true },
    scope: { type: String, required: true },
    stateParam: { type: String },
    codeChallenge: { type: String, required: true },
    codeChallengeMethod: { type: String, required: true, default: 'S256' },
    resource: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// A pending consent that's never completed (user abandons the OAuth
// authorize screen) would otherwise sit in the collection forever.
mcpOAuthPendingConsentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const McpOAuthPendingConsentModel = model(
  'McpOAuthPendingConsent',
  mcpOAuthPendingConsentSchema
);

const userOAuthAuthCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Exchanged codes are deleted eagerly (exchange.ts), but an abandoned
// (never-exchanged) code would otherwise sit in the collection forever.
userOAuthAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserOAuthAuthCodeModel = model('UserOAuthAuthCode', userOAuthAuthCodeSchema);
