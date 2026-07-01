const USER_ID = import.meta.env.VITE_USER_ID ?? 'local-user';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': USER_ID,
      ...init?.headers,
    },
  });

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

export async function checkHealth(): Promise<{ status: string; service: string }> {
  return request('/health');
}

export async function listTasks(): Promise<{ tasks: import('../types').Task[] }> {
  return request('/api/tasks');
}

export async function listProjects(): Promise<{ projects: import('../types').Project[] }> {
  return request('/api/projects');
}

export async function createProject(
  body: { name: string; description?: string }
): Promise<{ project: import('../types').Project }> {
  return request('/api/projects', { method: 'POST', body: JSON.stringify(body) });
}

export async function updateProject(
  id: string,
  body: { name?: string; description?: string | null }
): Promise<{ project: import('../types').Project }> {
  return request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteProject(
  id: string
): Promise<{ deletedTaskCount: number; nextProjectId: string | null }> {
  return request(`/api/projects/${id}`, { method: 'DELETE' });
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

export async function deleteTask(id: string): Promise<void> {
  await request(`/api/tasks/${id}`, { method: 'DELETE' });
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

export async function deleteSubtask(taskId: string, path: string[]): Promise<void> {
  await request(`/api/tasks/${taskId}/subtasks${subtaskPathQuery(path)}`, { method: 'DELETE' });
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

export async function listConversations(): Promise<{ conversations: import('../types').ConversationSummary[] }> {
  return request('/api/conversations');
}

export async function getConversation(id: string): Promise<{ conversation: import('../types').Conversation }> {
  return request(`/api/conversations/${id}`);
}

export async function streamChat(
  message: string,
  conversationId: string | undefined,
  onEvent: (event: import('../types').ChatStreamEvent) => void
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': USER_ID,
    },
    body: JSON.stringify({ message, conversationId }),
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
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': USER_ID,
    },
    body: JSON.stringify({ conversationId, proposalId, action }),
  });

  await consumeSseStream(response, onEvent);
}
