import type {
  AdminFeedbackDetail,
  AdminStats,
  FeedbackListResponse,
  GpuResources,
  LoginResponse,
  OllamaCallsResponse,
  OllamaStatusResponse,
  OllamaSummaryResponse,
  OllamaTimeseriesResponse,
  SessionResponse,
  UsersResponse,
  FeedbackStatus,
} from '../types';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

let csrfToken: string | null = null;

async function request<T>(
  path: string,
  init?: RequestInit & { csrf?: boolean; treat401AsAuthFailure?: boolean }
): Promise<T> {
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

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    const message = (body as { error?: string }).error ?? 'Request failed';
    if (response.status === 401 && init?.treat401AsAuthFailure !== false) {
      throw new AuthError('Session expired. Please sign in again.');
    }
    throw new Error(message);
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
    treat401AsAuthFailure: false,
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
    const result = await request<LoginResponse>('/api/admin/auth/mtls', {
      method: 'POST',
      treat401AsAuthFailure: false,
    });
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

export async function fetchOllamaGpu(): Promise<GpuResources> {
  return request('/api/admin/ollama/gpu');
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

export async function listFeedback(params: {
  page: number;
  limit: number;
  search?: string;
  status?: FeedbackStatus;
}): Promise<FeedbackListResponse> {
  const query = new URLSearchParams({
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);
  return request(`/api/admin/feedback?${query.toString()}`);
}

export async function getFeedback(id: string): Promise<AdminFeedbackDetail> {
  return request(`/api/admin/feedback/${encodeURIComponent(id)}`);
}

export async function updateFeedbackStatus(
  id: string,
  status: FeedbackStatus
): Promise<{ id: string; status: FeedbackStatus; updatedAt: string }> {
  return request(`/api/admin/feedback/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
    csrf: true,
  });
}
