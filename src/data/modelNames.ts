/**
 * Which Mongoose model defines each collection. The schema on that model is the single
 * declaration both backends obey, so this table is shared rather than restated per store.
 */

import type { CollectionName } from './types.js';

export const MODEL_BY_COLLECTION: Record<CollectionName, string> = {
  users: 'User',
  tasks: 'Task',
  projects: 'Project',
  comments: 'Comment',
  activities: 'Activity',
  conversations: 'Conversation',
  notifications: 'Notification',
  invites: 'Invite',
  feedback: 'Feedback',
  feedbackVisionJobs: 'FeedbackVisionJob',
  embeddingJobs: 'EmbeddingJob',
  llmCallMetrics: 'LlmCallMetric',
  llmDailyMetrics: 'LlmDailyMetric',
  adminAudits: 'AdminAudit',
  mcpApiKeys: 'McpApiKey',
  mcpSessions: 'McpSession',
  mcpOAuthClients: 'McpOAuthClient',
  mcpOAuthAuthorizationCodes: 'McpOAuthAuthorizationCode',
  mcpOAuthRefreshTokens: 'McpOAuthRefreshToken',
  mcpOAuthPendingConsents: 'McpOAuthPendingConsent',
  userOAuthAuthCodes: 'UserOAuthAuthCode',
  appMeta: 'AppMeta',
};
