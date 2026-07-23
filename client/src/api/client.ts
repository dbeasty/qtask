import { getStoredToken, clearStoredToken } from '../auth/storage';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return { ...headers, ...extra };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: authHeaders(init?.headers),
  });

  if (response.status === 401) {
    clearStoredToken();
    throw new AuthError('Session expired. Please sign in again.');
  }

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
  onEvent: (event: import('../types').ChatStreamEvent) => void
): Promise<void> {
  if (response.status === 401) {
    clearStoredToken();
    throw new AuthError('Session expired. Please sign in again.');
  }

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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6)) as import('../types').ChatStreamEvent;
      onEvent(event);
    }
  }
}

export async function checkHealth(): Promise<{ status: string; service: string; version?: string }> {
  const response = await fetch('/health');
  if (!response.ok) {
    throw new Error('Health check failed');
  }
  return response.json() as Promise<{ status: string; service: string }>;
}

export async function listTasks(): Promise<{ tasks: import('../types').Task[] }> {
  return request('/api/tasks');
}

export async function listProjects(): Promise<{ projects: import('../types').Project[] }> {
  return request('/api/projects');
}

export async function createProject(
  body: { name: string; description?: string; parentId?: string | null }
): Promise<{ project: import('../types').Project }> {
  return request('/api/projects', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateProject(
  id: string,
  body: {
    name?: string;
    description?: string | null;
    parentId?: string | null;
    sortOrder?: number;
    progressShare?: number | null;
  }
): Promise<{ project: import('../types').Project }> {
  return request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
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
): Promise<{ project: import('../types').Project }> {
  return request(`/api/projects/${projectId}/collaborators`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
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

export async function streamChat(
  message: string,
  conversationId: string | undefined,
  onEvent: (event: import('../types').ChatStreamEvent) => void,
  projectId?: string
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ message, conversationId, projectId }),
  });

  await consumeSseStream(response, onEvent);
}

export async function submitProposal(
  conversationId: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ proposal: import('../types').PendingProposal }> {
  return request('/api/chat/proposals', {
    method: 'POST',
    body: JSON.stringify({ conversationId, name, arguments: args }),
  });
}

export async function approveProposal(
  conversationId: string,
  proposalId: string,
  action: 'approve' | 'reject',
  onEvent: (event: import('../types').ChatStreamEvent) => void
): Promise<void> {
  const response = await fetch('/api/chat/approve', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ conversationId, proposalId, action }),
  });

  await consumeSseStream(response, onEvent);
}
