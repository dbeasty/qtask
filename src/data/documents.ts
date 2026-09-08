/**
 * Stored document shapes, per collection.
 *
 * These describe what is *in the store*, not what the API returns — dates are `Date`,
 * ids are strings, and nothing is serialized. Services pass the matching type to
 * `collection<T>(…)` so reads come back typed instead of as `Record<string, unknown>`.
 *
 * They are declarations of intent, not enforcement: the schemas in src/models/index.ts
 * are what actually validate, and these have to be kept in step with them. Where the
 * two could drift, the conformance suite is what catches it.
 *
 * `[key: string]: unknown` on each is deliberate. It is what lets a typed document
 * satisfy the `Doc` the store speaks, and it keeps a field added to a schema but not
 * yet added here from becoming a compile error in unrelated code.
 */

import type { PendingProposal } from '../types/conversation.js';

export interface StoredDoc {
  _id: string;
  createdAt?: Date;
  updatedAt?: Date;
  [key: string]: unknown;
}

/** A collection whose schema declares `timestamps: true`, so both stamps always exist. */
export interface TimestampedDoc extends StoredDoc {
  createdAt: Date;
  updatedAt: Date;
}

/** A collection stamped on create only (`timestamps: { updatedAt: false }`). */
export interface CreatedDoc extends StoredDoc {
  createdAt: Date;
}

export interface UserDoc extends TimestampedDoc {
  email: string;
  passwordHash?: string;
  displayName?: string;
  emailVerified?: boolean;
  emailVerificationTokenHash?: string;
  emailVerificationExpires?: Date;
  passwordResetTokenHash?: string;
  passwordResetExpires?: Date;
  legalAcceptedAt?: Date;
  legalVersion?: string;
  lastLoginAt?: Date;
  lastActiveAt?: Date;
  mustChangePassword?: boolean;
  hourlyRate?: number;
  preferences?: Record<string, unknown>;
  identityProviders?: Array<{ provider: string; providerUserId: string; linkedAt: Date }>;
}

export interface TaskDoc extends TimestampedDoc {
  userId: string;
  projectId?: string;
  projectIds?: string[];
  title: string;
  description?: string;
  // Fields the schema defaults are always present on a stored document.
  steps: Array<Record<string, unknown>>;
  status: string;
  priority: string;
  dueDate?: Date;
  tags: string[];
  percentComplete: number;
  subtasks: Array<Record<string, unknown>>;
  links: Array<{ taskId: string; type: string }>;
  sortOrder: number;
  assigneeId?: string;
  embedding?: number[];
  staging?: { conversationId: string; proposalId: string; stagedAt?: Date };
}

export interface ProjectDoc extends TimestampedDoc {
  userId: string;
  name: string;
  description?: string;
  notes?: string;
  parentId?: string | null;
  sortOrder?: number;
  status?: string;
  percentComplete?: number;
  doneOverride?: boolean;
  collaborators: Array<{ userId: string; role: string }>;
  hourlyRate?: number;
  trainingHourlyRate?: number;
  progressShare?: number;
  trackingRollup?: {
    hoursSpent?: number;
    hoursRemaining?: number;
    materialsTotal?: number;
    laborCost?: number;
    trainingCost?: number;
    totalCost?: number;
    updatedAt?: Date;
  };
  embedding?: number[];
  staging?: { conversationId: string; proposalId: string; stagedAt?: Date };
}

export interface CommentDoc extends TimestampedDoc {
  taskId: string;
  subtaskPath?: string[];
  userId: string;
  body: string;
  parentId?: string;
  editedAt?: Date;
}

export interface ActivityDoc extends CreatedDoc {
  taskId: string;
  userId: string;
  action: string;
  details?: Record<string, unknown>;
  source?: string;
}

export interface ConversationDoc extends TimestampedDoc {
  userId: string;
  projectId?: string;
  title?: string;
  messages?: Array<Record<string, unknown>>;
  pendingProposals?: Array<Record<string, unknown>>;
  pausedBatch?: Record<string, unknown> | null;
}

export interface NotificationDoc extends CreatedDoc {
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  read: boolean;
}

export interface InviteDoc extends TimestampedDoc {
  projectId: string;
  inviterUserId: string;
  inviteeEmail: string;
  inviteeUserId?: string;
  role: string;
  status: string;
  token: string;
  expiresAt: Date;
  respondedAt?: Date;
}

export interface FeedbackAttachment {
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  visionCheck?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FeedbackDoc extends TimestampedDoc {
  userId: string;
  message: string;
  category?: string;
  status?: string;
  validationStatus?: string;
  context?: Record<string, unknown>;
  attachments?: FeedbackAttachment[];
  adminReply?: { message: string; repliedAt: Date };
}

export interface JobDoc extends TimestampedDoc {
  status: string;
  attempts?: number;
  lastError?: string;
}

export interface EmbeddingJobDoc extends JobDoc {
  entityType: string;
  entityId: string;
  taskId?: string;
  dirty?: boolean;
}

export interface FeedbackVisionJobDoc extends JobDoc {
  feedbackId: string;
}

export interface McpApiKeyDoc extends TimestampedDoc {
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scope: string;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface McpSessionDoc extends TimestampedDoc {
  userId: string;
  keyId: string;
  activeProjectId?: string;
  pendingProposals?: PendingProposal[];
}

export interface McpOAuthClientDoc extends TimestampedDoc {
  clientId: string;
  clientSecretHash?: string;
  name: string;
  userId?: string;
  redirectUris?: string[];
  source: string;
  clientName?: string;
  revokedAt?: Date;
}

export interface McpOAuthCodeDoc extends TimestampedDoc {
  codeHash: string;
  clientId: string;
  userId: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  resource: string;
  expiresAt: Date;
}

export interface McpOAuthRefreshTokenDoc extends TimestampedDoc {
  tokenHash: string;
  clientId: string;
  userId: string;
  scope: string;
  resource: string;
  revokedAt?: Date;
  expiresAt: Date;
}

export interface McpOAuthPendingConsentDoc extends TimestampedDoc {
  state: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  stateParam?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  expiresAt: Date;
}

export interface UserOAuthAuthCodeDoc extends TimestampedDoc {
  codeHash: string;
  userId: string;
  expiresAt: Date;
}

export interface LlmCallMetricDoc extends StoredDoc {
  requestId: string;
  userId?: string;
  callType: string;
  model: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  success: boolean;
  expiresAt: Date;
}

export interface AdminAuditDoc extends CreatedDoc {
  adminIdentity: string;
  action: string;
  targetUserId?: string;
  targetEmail?: string;
  details?: Record<string, unknown>;
}
