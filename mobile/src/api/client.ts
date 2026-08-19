import type {
  AuthUser,
  CreateTaskInput,
  LoginResult,
  Project,
  Task,
  UpdateTaskInput,
} from '@qtask/shared';
import { clearStoredToken, getServerUrl, getStoredToken, setStoredToken } from '../config/storage';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let cachedBaseUrl: string | null = null;

// QTask is self-hosted, so — unlike the web client, which is always
// same-origin with the API — the mobile app needs a configured server URL.
// Set once via ServerSetupScreen and cached in memory for the session.
export function setCachedBaseUrl(url: string | null): void {
  cachedBaseUrl = url;
}

export async function resolveBaseUrl(): Promise<string> {
  if (cachedBaseUrl) return cachedBaseUrl;
  const stored = await getServerUrl();
  if (!stored) {
    throw new ApiError('No QTask server configured', 0);
  }
  cachedBaseUrl = stored;
  return stored;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<T> {
  const baseUrl = await resolveBaseUrl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (options.auth !== false) {
    const token = await getStoredToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const message = (data as { error?: string } | undefined)?.error ?? response.statusText;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export async function pingServer(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function getAuthConfig(): Promise<{ registrationEnabled: boolean }> {
  return request('/api/auth/config', { auth: false });
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const result = await request<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  });
  await setStoredToken(result.token);
  return result;
}

export async function fetchMe(): Promise<AuthUser> {
  const body = await request<{ user: AuthUser }>('/api/auth/me');
  return body.user;
}

export async function refreshSession(): Promise<LoginResult> {
  const result = await request<LoginResult>('/api/auth/refresh', { method: 'POST' });
  await setStoredToken(result.token);
  return result;
}

export async function logout(): Promise<void> {
  await clearStoredToken();
}

export async function listProjects(): Promise<Project[]> {
  const body = await request<{ projects: Project[] }>('/api/projects');
  return body.projects;
}

export async function listTasks(projectId?: string): Promise<Task[]> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const body = await request<{ tasks: Task[] }>(`/api/tasks${query}`);
  return body.tasks;
}

export async function getTask(id: string): Promise<Task> {
  const body = await request<{ task: Task }>(`/api/tasks/${id}`);
  return body.task;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const body = await request<{ task: Task }>('/api/tasks', { method: 'POST', body: input });
  return body.task;
}

export async function updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
  const body = await request<{ task: Task }>(`/api/tasks/${id}`, { method: 'PATCH', body: input });
  return body.task;
}

export async function deleteTask(id: string): Promise<void> {
  await request(`/api/tasks/${id}`, { method: 'DELETE' });
}
