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
  emailVerified?: boolean;
}

async function parseAuthResponse(response: Response, fallbackError: string) {
  const body = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? fallbackError);
  }
  return body;
}

export async function getAuthConfig(): Promise<{ registrationEnabled: boolean }> {
  const response = await fetch('/api/auth/config');
  if (!response.ok) {
    return { registrationEnabled: false };
  }
  return response.json() as Promise<{ registrationEnabled: boolean }>;
}

export async function register(
  email: string,
  password: string,
  displayName?: string,
  acceptLegal?: boolean
): Promise<{ message: string }> {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, acceptLegal: acceptLegal ? true : undefined }),
  });
  return parseAuthResponse(response, 'Registration failed') as Promise<{ message: string }>;
}

export async function login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return parseAuthResponse(response, 'Login failed') as Promise<{ token: string; user: AuthUser }>;
}

export async function verifyEmail(token: string): Promise<{ message: string }> {
  const response = await fetch('/api/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return parseAuthResponse(response, 'Verification failed') as Promise<{ message: string }>;
}

export async function resendVerification(email: string): Promise<{ message: string }> {
  const response = await fetch('/api/auth/resend-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return parseAuthResponse(response, 'Could not resend verification email') as Promise<{ message: string }>;
}

export async function forgotPassword(email: string): Promise<{ message: string }> {
  const response = await fetch('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return parseAuthResponse(response, 'Could not send reset email') as Promise<{ message: string }>;
}

export async function resetPassword(token: string, password: string): Promise<{ message: string }> {
  const response = await fetch('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  return parseAuthResponse(response, 'Password reset failed') as Promise<{ message: string }>;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<{ message: string }> {
  const token = getStoredToken();
  const response = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return parseAuthResponse(response, 'Could not change password') as Promise<{ message: string }>;
}

export async function updateProfile(displayName: string | null): Promise<{ user: AuthUser }> {
  const token = getStoredToken();
  const response = await fetch('/api/auth/me', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ displayName }),
  });
  return parseAuthResponse(response, 'Could not update profile') as Promise<{ user: AuthUser }>;
}

export async function fetchMe(token: string): Promise<AuthUser> {
  const response = await fetch('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await parseAuthResponse(response, 'Session expired');
  return (body as { user: AuthUser }).user;
}
