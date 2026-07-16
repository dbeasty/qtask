import type {
  AdminStats,
  LoginResponse,
  OllamaCallsResponse,
  OllamaStatusResponse,
  OllamaSummaryResponse,
  OllamaTimeseriesResponse,
  SessionResponse,
  UsersResponse,
} from '../types';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

let csrfToken: string | null = null;

async function request<T>(path: string, init?: RequestInit & { csrf?: boolean }): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.csrf && csrfToken) {
    headers['x-csrf-token'] = csrfToken;
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (response.status === 401) {
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

export async function fetchSession(): Promise<SessionResponse> {
  const session = await request<SessionResponse>('/api/admin/auth/session');
  if (session.csrfToken) {
    csrfToken = session.csrfToken;
  }
  return session;
}

export async function loginWithPassword(password: string): Promise<LoginResponse> {
  const result = await request<LoginResponse>('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  csrfToken = result.csrfToken;
  return result;
}

/**
 * Attempt cookie issuance from an mTLS client certificate forwarded by the
 * reverse proxy. Returns null when no verified certificate is present.
 */
export async function exchangeMtls(): Promise<LoginResponse | null> {
  try {
    const result = await request<LoginResponse>('/api/admin/auth/mtls', { method: 'POST' });
    csrfToken = result.csrfToken;
    return result;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  await request<undefined>('/api/admin/auth/logout', { method: 'POST', csrf: true });
  csrfToken = null;
}

export async function fetchStats(): Promise<AdminStats> {
  return request('/api/admin/stats');
}

export async function listUsers(params: {
  page: number;
  limit: number;
  search?: string;
}): Promise<UsersResponse> {
  const query = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.search) {
    query.set('search', params.search);
  }
  return request(`/api/admin/users?${query.toString()}`);
}

export async function resetUserPassword(
  userId: string,
  password: string
): Promise<{ message: string }> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
    csrf: true,
  });
}

export async function deleteUser(userId: string, confirmEmail?: string): Promise<void> {
  await request<unknown>(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    body: JSON.stringify(confirmEmail !== undefined ? { confirmEmail } : {}),
    csrf: true,
  });
}

function windowQuery(windowHours: number): URLSearchParams {
  const to = new Date();
  const from = new Date(to.getTime() - windowHours * 60 * 60 * 1000);
  return new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
}

export async function fetchOllamaStatus(): Promise<OllamaStatusResponse> {
  return request('/api/admin/ollama/status');
}

export async function fetchOllamaSummary(windowHours: number): Promise<OllamaSummaryResponse> {
  return request(`/api/admin/ollama/summary?${windowQuery(windowHours).toString()}`);
}

export async function fetchOllamaTimeseries(
  windowHours: number
): Promise<OllamaTimeseriesResponse> {
  const query = windowQuery(windowHours);
  query.set('interval', windowHours >= 168 ? 'day' : 'hour');
  return request(`/api/admin/ollama/timeseries?${query.toString()}`);
}

export async function listOllamaCalls(params: {
  page: number;
  limit: number;
}): Promise<OllamaCallsResponse> {
  const query = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  return request(`/api/admin/ollama/calls?${query.toString()}`);
}
