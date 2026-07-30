import {
  classifyAuthFailure,
  getExpiredAgoMs,
  getTokenExpiryMs,
  isWithinRefreshGrace,
  sessionMessageForReason,
  type SessionExpiryReason,
} from '../auth/session';
import { getStoredToken, refreshSessionRequest, setStoredToken, type AuthUser } from '../auth/storage';
import { createLogger } from '../utils/logger';

const logger = createLogger('session');

export type { SessionExpiryReason };

export class AuthError extends Error {
  readonly reason: SessionExpiryReason;

  constructor(message: string, reason: SessionExpiryReason) {
    super(message);
    this.name = 'AuthError';
    this.reason = reason;
  }
}

type SessionExpiredHandler = (reason: SessionExpiryReason, source: 'api' | 'refresh_failed') => void;
type TokenRefreshedHandler = (user: AuthUser, token: string) => void;

let sessionExpiredHandler: SessionExpiredHandler | null = null;
let tokenRefreshedHandler: TokenRefreshedHandler | null = null;
let refreshInFlight: Promise<{ token: string; user: AuthUser } | null> | null = null;
let logoutInProgress = false;

export function setSessionExpiredHandler(handler: SessionExpiredHandler | null): void {
  sessionExpiredHandler = handler;
}

export function setTokenRefreshedHandler(handler: TokenRefreshedHandler | null): void {
  tokenRefreshedHandler = handler;
}

function authHeaders(extra?: HeadersInit, body?: BodyInit | null): HeadersInit {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (!(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return { ...headers, ...extra };
}

function log401(path: string, method: string, hadToken: boolean, token: string | null, reason: SessionExpiryReason) {
  logger.warn('Unauthorized response', {
    reason,
    path,
    method,
    hadToken,
    tokenExp: token ? getTokenExpiryMs(token) : undefined,
    expiredAgoMs: getExpiredAgoMs(token),
  });
}

function triggerSessionExpired(reason: SessionExpiryReason, source: 'api' | 'refresh_failed'): never {
  if (!logoutInProgress) {
    logoutInProgress = true;
    sessionExpiredHandler?.(reason, source);
    logoutInProgress = false;
  }
  throw new AuthError(sessionMessageForReason(reason), reason);
}

async function attemptTokenRefresh(): Promise<{ token: string; user: AuthUser } | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      const result = await refreshSessionRequest();
      setStoredToken(result.token);
      tokenRefreshedHandler?.(result.user, result.token);
      return { token: result.token, user: result.user };
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function canAttemptRefresh(token: string | null, reason: SessionExpiryReason): boolean {
  if (!token) return false;
  return reason === 'expired' || isWithinRefreshGrace(token);
}

async function handleUnauthorized(
  _response: Response,
  path: string,
  method: string,
  hadToken: boolean,
  retry: () => Promise<Response>
): Promise<Response> {
  const token = getStoredToken();
  const reason = classifyAuthFailure({ hadToken, token });
  log401(path, method, hadToken, token, reason);

  if (canAttemptRefresh(token, reason)) {
    logger.info('Attempting refresh and retry', { trigger: 'reactive_401', path });
    const refreshed = await attemptTokenRefresh();
    if (refreshed) {
      logger.info('Refresh succeeded, retrying request', { trigger: 'reactive_401', path });
      const retryResponse = await retry();
      if (retryResponse.status !== 401) {
        return retryResponse;
      }
    }
    logger.warn('Refresh failed, signing out', { reason, path });
    return triggerSessionExpired(reason, 'refresh_failed');
  }

  return triggerSessionExpired(reason, 'api');
}

async function authorizedFetch(path: string, init?: RequestInit): Promise<Response> {
  const hadToken = Boolean(getStoredToken());
  const method = init?.method ?? 'GET';

  const doFetch = () =>
    fetch(path, {
      ...init,
      headers: authHeaders(init?.headers, init?.body),
    });

  const response = await doFetch();
  if (response.status === 401) {
    return handleUnauthorized(response, path, method, hadToken, doFetch);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authorizedFetch(path, init);

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((body as { error?: string }).error ?? 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function consumeSseStream(
  response: Response,
  onEvent: (event: import('../types').AgentStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((body as { error?: string }).error ?? 'Request failed');
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const abortReader = () => {
    void reader.cancel().catch(() => {
      // ignore cancel errors
    });
  };

  if (signal) {
    if (signal.aborted) {
      abortReader();
      return;
    }
    signal.addEventListener('abort', abortReader, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6)) as import('../types').AgentStreamEvent;
        onEvent(event);
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  }
}

export async function checkHealth(): Promise<{
  status: string;
  service: string;
  version?: string;
  aiVersion?: string | null;
  features?: {
    feedback: boolean;
    feedbackImages: boolean;
  };
  deployment?: {
    readOnly: boolean;
    phase: string;
    message: string;
  };
}> {
  const response = await fetch('/health');
  if (!response.ok) {
    throw new Error('Health check failed');
  }
  return response.json() as Promise<{
    status: string;
    service: string;
    version?: string;
    aiVersion?: string | null;
    features?: {
      feedback: boolean;
      feedbackImages: boolean;
    };
    deployment?: {
      readOnly: boolean;
      phase: string;
      message: string;
    };
  }>;
}

export async function listTasks(): Promise<{ tasks: import('../types').Task[] }> {
  return request('/api/tasks');
}

export async function listProjects(): Promise<{ projects: import('../types').Project[] }> {
  return request('/api/projects');
}

export async function search(query: string): Promise<import('../types').SearchResults> {
  const params = new URLSearchParams({ q: query });
  return request(`/api/search?${params.toString()}`);
}

export async function createProject(
  body: { name: string; description?: string; notes?: string; parentId?: string | null }
): Promise<{ project: import('../types').Project }> {
  return request('/api/projects', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateProject(
  id: string,
  body: {
    name?: string;
    description?: string | null;
    notes?: string | null;
    parentId?: string | null;
    sortOrder?: number;
    progressShare?: number | null;
    hourlyRate?: number | null;
  }
): Promise<{ project: import('../types').Project }> {
  return request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function getProjectTracking(
  id: string
): Promise<{ tracking: import('../types').ProjectTrackingResult }> {
  return request(`/api/projects/${id}/tracking`);
}

export async function moveProject(
  id: string,
  body: { parentId: string | null; index?: number }
): Promise<{ project: import('../types').Project }> {
  return request(`/api/projects/${id}/move`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deleteProject(
  id: string
): Promise<{ deletedTaskCount: number; nextProjectId: string | null }> {
  return request(`/api/projects/${id}`, { method: 'DELETE' });
}

export async function addProjectCollaborator(
  projectId: string,
  body: { email?: string; userId?: string; role?: import('../types').CollaboratorRole }
): Promise<{ invite: import('../types').ProjectInvite }> {
  return request(`/api/projects/${projectId}/collaborators`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listShareContacts(
  excludeProjectId?: string
): Promise<{ contacts: import('../types').ShareContact[] }> {
  const params = excludeProjectId
    ? `?excludeProjectId=${encodeURIComponent(excludeProjectId)}`
    : '';
  return request(`/api/projects/share-contacts${params}`);
}

export async function getProjectShareSummary(
  projectId: string
): Promise<{ summary: import('../types').ProjectShareSummary }> {
  return request(`/api/projects/${projectId}/share-summary`);
}

export async function listProjectInvites(
  projectId: string
): Promise<{ invites: import('../types').ProjectInvite[] }> {
  return request(`/api/projects/${projectId}/invites`);
}

export async function cancelProjectInvite(
  projectId: string,
  inviteId: string
): Promise<{ invite: import('../types').ProjectInvite }> {
  return request(`/api/projects/${projectId}/invites/${inviteId}`, { method: 'DELETE' });
}

export async function listInvites(
  status: 'pending' | 'all' = 'pending'
): Promise<{ invites: import('../types').ProjectInvite[] }> {
  const params = status === 'all' ? '?status=all' : '';
  return request(`/api/invites${params}`);
}

export async function getInvitePreviewPublic(
  token: string
): Promise<{ invite: import('../types').PublicProjectInvite }> {
  const response = await fetch(`/api/invites/preview/${encodeURIComponent(token)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((body as { error?: string }).error ?? 'Request failed');
  }
  return response.json() as Promise<{ invite: import('../types').PublicProjectInvite }>;
}

export async function getInvitePreview(
  token: string
): Promise<{ invite: import('../types').PublicProjectInvite }> {
  return getInvitePreviewPublic(token);
}

export async function acceptInvite(
  inviteId: string
): Promise<{ invite: import('../types').ProjectInvite; project: import('../types').Project | null }> {
  return request(`/api/invites/${inviteId}/accept`, { method: 'POST' });
}

export async function acceptInviteByToken(
  token: string
): Promise<{ invite: import('../types').ProjectInvite; project: import('../types').Project | null }> {
  return request('/api/invites/accept-by-token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function declineInvite(
  inviteId: string
): Promise<{ invite: import('../types').ProjectInvite }> {
  return request(`/api/invites/${inviteId}/decline`, { method: 'POST' });
}

export async function listNotifications(): Promise<{ notifications: import('../types').AppNotification[] }> {
  return request('/api/notifications');
}

export async function getUnreadNotificationCount(): Promise<{ count: number }> {
  return request('/api/notifications/unread-count');
}

export async function markNotificationRead(
  notificationId: string
): Promise<{ notification: import('../types').AppNotification }> {
  return request(`/api/notifications/${notificationId}/read`, { method: 'PATCH' });
}

export async function markAllNotificationsRead(): Promise<{ count: number }> {
  return request('/api/notifications/read-all', { method: 'POST' });
}

export async function updateProjectCollaborator(
  projectId: string,
  collaboratorUserId: string,
  body: { role: import('../types').CollaboratorRole }
): Promise<{ project: import('../types').Project }> {
  return request(`/api/projects/${projectId}/collaborators/${collaboratorUserId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function removeProjectCollaborator(
  projectId: string,
  collaboratorUserId: string
): Promise<{ left: boolean; project: import('../types').Project | null }> {
  return request(`/api/projects/${projectId}/collaborators/${collaboratorUserId}`, {
    method: 'DELETE',
  });
}

export async function createTask(
  body: import('../types').CreateTaskInput
): Promise<{ task: import('../types').Task }> {
  return request('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateTask(
  id: string,
  body: import('../types').UpdateTaskInput
): Promise<{ task: import('../types').Task }> {
  return request(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function getTaskActivity(
  taskId: string
): Promise<{ activity: import('../types').ActivityEntry[] }> {
  return request(`/api/tasks/${taskId}/activity`);
}

function commentsSubtaskPathQuery(path?: string[]): string {
  if (!path || path.length === 0) return '';
  return `?subtaskPath=${path.join(',')}`;
}

export async function getTaskComments(
  taskId: string,
  subtaskPath?: string[]
): Promise<{ comments: import('../types').Comment[] }> {
  return request(`/api/tasks/${taskId}/comments${commentsSubtaskPathQuery(subtaskPath)}`);
}

export async function createTaskComment(
  taskId: string,
  body: {
    body: string;
    subtaskPath?: string[];
    parentId?: string;
    notifyByEmail?: boolean;
  }
): Promise<{ comment: import('../types').Comment }> {
  return request(`/api/tasks/${taskId}/comments`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateTaskComment(
  taskId: string,
  commentId: string,
  body: { body: string }
): Promise<{ comment: import('../types').Comment }> {
  return request(`/api/tasks/${taskId}/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteTaskComment(taskId: string, commentId: string): Promise<void> {
  await request(`/api/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' });
}

export async function deleteTask(
  id: string,
  options: { keepChildren?: boolean } = {}
): Promise<{ promotedTasks?: import('../types').Task[] } | void> {
  const query = options.keepChildren ? '?keepChildren=true' : '';
  if (options.keepChildren) {
    return request(`/api/tasks/${id}${query}`, { method: 'DELETE' });
  }
  await request(`/api/tasks/${id}${query}`, { method: 'DELETE' });
}

function subtaskPathQuery(path: string[]): string {
  return path.length > 0 ? `?path=${path.join(',')}` : '';
}

export async function addSubtask(
  taskId: string,
  body: import('../types').CreateSubtaskInput,
  path: string[] = []
): Promise<{ task: import('../types').Task }> {
  return request(`/api/tasks/${taskId}/subtasks${subtaskPathQuery(path)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateSubtask(
  taskId: string,
  path: string[],
  body: import('../types').UpdateSubtaskInput
): Promise<{ task: import('../types').Task }> {
  return request(`/api/tasks/${taskId}/subtasks${subtaskPathQuery(path)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteSubtask(
  taskId: string,
  path: string[],
  options: { keepChildren?: boolean } = {}
): Promise<{ task?: import('../types').Task } | void> {
  const pathQuery = subtaskPathQuery(path);
  const keepQuery = options.keepChildren
    ? `${pathQuery ? '&' : '?'}keepChildren=true`
    : '';
  if (options.keepChildren) {
    return request(`/api/tasks/${taskId}/subtasks${pathQuery}${keepQuery}`, { method: 'DELETE' });
  }
  await request(`/api/tasks/${taskId}/subtasks${pathQuery}${keepQuery}`, { method: 'DELETE' });
}

export async function moveSubtask(
  taskId: string,
  body: import('../types').MoveSubtaskInput
): Promise<{ task: import('../types').Task }> {
  return request(`/api/tasks/${taskId}/subtasks/move`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function promoteSubtask(
  taskId: string,
  path: string[]
): Promise<{ task: import('../types').Task; promotedTask: import('../types').Task }> {
  return request(`/api/tasks/${taskId}/subtasks/promote${subtaskPathQuery(path)}`, {
    method: 'POST',
  });
}

export async function attachTaskAsSubtask(
  targetTaskId: string,
  body: import('../types').AttachTaskAsSubtaskInput
): Promise<{
  targetTask: import('../types').Task;
  removedTaskId: string;
  subtaskId: string;
}> {
  return request(`/api/tasks/${targetTaskId}/subtasks/attach-task`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function moveTaskToProject(
  taskId: string,
  projectId: string
): Promise<{ task: import('../types').Task }> {
  return request(`/api/tasks/${taskId}/move-project`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

export async function shareTaskToProject(
  taskId: string,
  projectId: string
): Promise<{ task: import('../types').Task }> {
  return request(`/api/tasks/${taskId}/share-project`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

export async function unlinkTaskFromProject(
  taskId: string,
  projectId: string
): Promise<{ task: import('../types').Task }> {
  return request(`/api/tasks/${taskId}/unlink-project`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

export async function duplicateTask(
  taskId: string,
  projectId: string
): Promise<{ task: import('../types').Task }> {
  return request(`/api/tasks/${taskId}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

export async function reorderProjectTask(
  projectId: string,
  taskId: string,
  index: number
): Promise<{ tasks: import('../types').Task[] }> {
  return request(`/api/projects/${projectId}/tasks/reorder`, {
    method: 'POST',
    body: JSON.stringify({ taskId, index }),
  });
}

export async function listConversations(
  projectId?: string
): Promise<{ conversations: import('../types').ConversationSummary[] }> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request(`/api/conversations${query}`);
}

export async function getConversation(id: string): Promise<{ conversation: import('../types').Conversation }> {
  return request(`/api/conversations/${id}`);
}

export async function deleteConversation(
  id: string
): Promise<{ discardedStagedCount: number }> {
  return request(`/api/conversations/${id}`, { method: 'DELETE' });
}

export async function resetConversation(
  id: string
): Promise<{ conversation: import('../types').Conversation; discardedStagedCount: number }> {
  return request(`/api/conversations/${id}/reset`, { method: 'POST' });
}

export async function duplicateConversation(
  id: string
): Promise<{ conversation: import('../types').Conversation }> {
  return request(`/api/conversations/${id}/duplicate`, { method: 'POST' });
}

export async function streamAgent(
  message: string,
  conversationId: string | undefined,
  onEvent: (event: import('../types').AgentStreamEvent) => void,
  projectId?: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await authorizedFetch('/api/agent', {
    method: 'POST',
    body: JSON.stringify({ message, conversationId, projectId }),
    signal,
  });

  await consumeSseStream(response, onEvent, signal);
}

export async function submitProposal(
  conversationId: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ proposal: import('../types').PendingProposal }> {
  return request('/api/agent/proposals', {
    method: 'POST',
    body: JSON.stringify({ conversationId, name, arguments: args }),
  });
}

export async function approveProposal(
  conversationId: string,
  proposalId: string,
  action: 'approve' | 'reject',
  onEvent: (event: import('../types').AgentStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await authorizedFetch('/api/agent/approve', {
    method: 'POST',
    body: JSON.stringify({ conversationId, proposalId, action }),
    signal,
  });

  await consumeSseStream(response, onEvent, signal);
}

export async function submitFeedback(formData: FormData): Promise<{
  id: string;
  message: string;
  category: string;
  status: string;
  validationStatus: string;
  createdAt: string;
  attachmentCount: number;
}> {
  const response = await authorizedFetch('/api/feedback', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((body as { error?: string }).error ?? 'Request failed');
  }

  return response.json();
}

export async function getFeedbackStatus(feedbackId: string): Promise<{
  id: string;
  validationStatus: string;
  message: string;
}> {
  return request(`/api/feedback/${encodeURIComponent(feedbackId)}`);
}

export { isTokenExpired, msUntilRefresh, REFRESH_LEAD_MS } from '../auth/session';
