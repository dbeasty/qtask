/**
 * What replicates, what does not, and how a document is assigned to a scope.
 *
 * This is the application-level reading of plan section 5.6: sessions, OAuth
 * tokens, embeddings, LLM metrics and admin audits stay on the device or server that
 * owns them.
 */

import type { ReplicatedCollection } from './types.js';

/**
 * Order matters: a comment's scope is inherited from its task, so tasks are captured
 * before comments, and projects before tasks.
 */
export const REPLICATED_COLLECTIONS: readonly ReplicatedCollection[] = [
  'projects',
  'tasks',
  'comments',
  'activities',
  'conversations',
  'notifications',
];

const REPLICATED = new Set<string>(REPLICATED_COLLECTIONS);

export function isReplicated(name: string): name is ReplicatedCollection {
  return REPLICATED.has(name);
}

/** Collections that stay local, listed so the omission is deliberate and testable. */
export const LOCAL_ONLY_COLLECTIONS = [
  'users',
  'invites',
  'feedback',
  'feedbackVisionJobs',
  'embeddingJobs',
  'llmCallMetrics',
  'llmDailyMetrics',
  'adminAudits',
  'mcpApiKeys',
  'mcpSessions',
  'mcpOAuthClients',
  'mcpOAuthAuthorizationCodes',
  'mcpOAuthRefreshTokens',
  'mcpOAuthPendingConsents',
  'userOAuthAuthCodes',
] as const;

/** Never part of a document's replicated state, for any collection. */
const ALWAYS_EXCLUDED = new Set(['_id', '__v', 'updatedAt', 'embedding']);

/**
 * Fields recomputed after a merge instead of merged (plan section 5.5). A value
 * computed from other fields converges on its own once those fields converge, and
 * merging it would let a stale rollup overwrite a fresh one.
 *
 * `progressShare` is deliberately *not* here even though it is easy to mistake for a
 * rollup: it is a weight the user sets, and the effective (normalised) share is what
 * is derived at read time. Excluding it would drop the user's input.
 */
const DERIVED_FIELDS: Partial<Record<ReplicatedCollection, ReadonlySet<string>>> = {
  tasks: new Set(['percentComplete']),
  projects: new Set(['percentComplete', 'status', 'trackingRollup']),
};

export function isSyncedField(coll: ReplicatedCollection, field: string): boolean {
  if (ALWAYS_EXCLUDED.has(field)) return false;
  if (DERIVED_FIELDS[coll]?.has(field)) return false;
  return true;
}

export function isDerivedField(coll: ReplicatedCollection, field: string): boolean {
  return DERIVED_FIELDS[coll]?.has(field) ?? false;
}

export const userScope = (userId: string): string => `u:${userId}`;
export const projectScope = (projectId: string): string => `p:${projectId}`;

type Lookup = (coll: ReplicatedCollection, id: string) => string | undefined;

/**
 * The scope a document belongs to. Project documents and the tasks in them are shared
 * with the project's members, so they live in `p:<projectId>`; everything else is the
 * owner's. Comments and activities follow their task; `lookup` resolves a task's
 * scope from the sync records, and a missing task falls back to the author's scope.
 */
export function computeScope(
  coll: ReplicatedCollection,
  id: string,
  doc: Record<string, unknown>,
  lookup: Lookup
): string {
  const owner = typeof doc.userId === 'string' && doc.userId ? doc.userId : 'unknown';
  switch (coll) {
    case 'projects':
      return projectScope(id);
    case 'tasks': {
      const projectId = typeof doc.projectId === 'string' && doc.projectId
        ? doc.projectId
        : Array.isArray(doc.projectIds) && typeof doc.projectIds[0] === 'string'
          ? (doc.projectIds[0] as string)
          : undefined;
      return projectId ? projectScope(projectId) : userScope(owner);
    }
    case 'comments':
    case 'activities': {
      const taskId = typeof doc.taskId === 'string' ? doc.taskId : undefined;
      return (taskId && lookup('tasks', taskId)) || userScope(owner);
    }
    default:
      return userScope(owner);
  }
}

/** Fields that carry a user id and must be re-owned when a local user adopts an account. */
export const OWNER_FIELDS: Record<ReplicatedCollection, string[]> = {
  projects: ['userId'],
  tasks: ['userId', 'assigneeId'],
  comments: ['userId'],
  activities: ['userId'],
  conversations: ['userId'],
  notifications: ['userId'],
};
