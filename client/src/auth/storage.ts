const TOKEN_KEY = 'qtask_token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export interface AuthUser {
  id: string;
  email: string;
  displayName?: string;
}

export async function register(
  email: string,
  password: string,
  displayName?: string
): Promise<{ token: string; user: AuthUser }> {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });
  const body = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? 'Registration failed');
  }
  return body as { token: string; user: AuthUser };
}

export async function login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? 'Login failed');
  }
  return body as { token: string; user: AuthUser };
}

export async function fetchMe(token: string): Promise<AuthUser> {
  const response = await fetch('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? 'Session expired');
  }
  return (body as { user: AuthUser }).user;
}
