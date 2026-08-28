import { createLogger } from '../utils/logger';

const logger = createLogger('session');

const TOKEN_KEY = 'qtask_token';

export const AUTH_TOKEN_KEY = TOKEN_KEY;

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export type ThemePreference = 'dark' | 'light';
export type StartupViewPreference = 'auto' | 'agent' | 'projects' | 'tasks' | 'last';

export interface UserPreferences {
  autoApproveProposals: boolean;
  skipConfirmations: boolean;
  trackExpenses: boolean;
  agentEnterToSend: boolean;
  completedDemoTour: boolean;
  theme: ThemePreference;
  startupView: StartupViewPreference;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName?: string;
  emailVerified?: boolean;
  mustChangePassword?: boolean;
  hasPassword?: boolean;
  hourlyRate?: number;
  preferences?: UserPreferences;
}

export interface OAuthProviderPublicInfo {
  id: string;
  label: string;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  autoApproveProposals: false,
  skipConfirmations: false,
  trackExpenses: true,
  agentEnterToSend: true,
  completedDemoTour: false,
  theme: 'light',
  startupView: 'last',
};

const STARTUP_VIEW_VALUES: StartupViewPreference[] = ['auto', 'agent', 'projects', 'tasks', 'last'];

function normalizeStartupView(value: unknown): StartupViewPreference {
  return STARTUP_VIEW_VALUES.includes(value as StartupViewPreference)
    ? (value as StartupViewPreference)
    : 'last';
}

export function getUserPreferences(user: AuthUser | null | undefined): UserPreferences {
  return {
    autoApproveProposals: user?.preferences?.autoApproveProposals === true,
    skipConfirmations: user?.preferences?.skipConfirmations === true,
    trackExpenses: user?.preferences?.trackExpenses !== false,
    agentEnterToSend: user?.preferences?.agentEnterToSend !== false,
    completedDemoTour: user?.preferences?.completedDemoTour === true,
    theme: user?.preferences?.theme === 'dark' ? 'dark' : 'light',
    startupView: normalizeStartupView(user?.preferences?.startupView),
  };
}

export class AuthApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AuthApiError';
    this.status = status;
  }
}

/** True only for an actual server-side auth rejection (401/403) — never for a network failure, CORS error, or 5xx. */
export function isAuthRejection(error: unknown): boolean {
  return error instanceof AuthApiError && (error.status === 401 || error.status === 403);
}

async function parseAuthResponse(response: Response, fallbackError: string) {
  const body = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    throw new AuthApiError((body as { error?: string }).error ?? fallbackError, response.status);
  }
  return body;
}

/** Authenticated PATCH with a single refresh-and-retry on 401, mirroring
 *  authorizedFetch() in api/client.ts — that helper can't be reused
 *  directly here since it imports from this module (getStoredToken/
 *  refreshSessionRequest/setStoredToken), and importing it back would
 *  create a cycle. Without this, updateProfile/updatePreferences (unlike
 *  every request routed through api/client.ts) failed immediately on an
 *  expired token instead of transparently refreshing and retrying. */
async function patchAuthenticated(path: string, body: unknown): Promise<Response> {
  const doFetch = () => {
    const token = getStoredToken();
    return fetch(path, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  };

  const response = await doFetch();
  if (response.status !== 401 || !getStoredToken()) {
    return response;
  }

  try {
    const refreshed = await refreshSessionRequest();
    setStoredToken(refreshed.token);
  } catch {
    return response;
  }
  return doFetch();
}

export async function getAuthConfig(): Promise<{
  registrationEnabled: boolean;
  oauthProviders?: OAuthProviderPublicInfo[];
  mcp?: import('../utils/mcpUrl').McpPublicConfig;
}> {
  const response = await fetch('/api/auth/config');
  if (!response.ok) {
    return { registrationEnabled: false };
  }
  return response.json() as Promise<{
    registrationEnabled: boolean;
    oauthProviders?: OAuthProviderPublicInfo[];
    mcp?: import('../utils/mcpUrl').McpPublicConfig;
  }>;
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

export interface LoginResult {
  token: string;
  user: AuthUser;
  /** True when the user signed in with a temporary password and the token is
   * only valid for POST /api/auth/change-password. */
  mustChangePassword?: boolean;
}

export async function exchangeOAuthCode(code: string): Promise<LoginResult> {
  const response = await fetch('/api/auth/oauth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return parseAuthResponse(response, 'OAuth sign-in failed') as Promise<LoginResult>;
}

/**
 * Completes an OAuth sign-in that matched an existing account by email but
 * needed the account owner to prove ownership with their password before the
 * new provider identity was merged in (see providerRequiresLinkConfirmation
 * server-side).
 */
export async function confirmOAuthProviderLink(linkToken: string, password: string): Promise<LoginResult> {
  const response = await fetch('/api/auth/oauth/confirm-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkToken, password }),
  });
  return parseAuthResponse(response, 'Could not confirm sign-in') as Promise<LoginResult>;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return parseAuthResponse(response, 'Login failed') as Promise<LoginResult>;
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

export interface ChangePasswordResult {
  message?: string;
  /** Present when the backend issues a fresh session after the change
   * (e.g. after a forced temporary-password change). */
  token?: string;
  user?: AuthUser;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<ChangePasswordResult> {
  const token = getStoredToken();
  const response = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return parseAuthResponse(response, 'Could not change password') as Promise<ChangePasswordResult>;
}

export async function updateProfile(
  body: { displayName?: string | null; hourlyRate?: number | null }
): Promise<{ user: AuthUser }> {
  const response = await patchAuthenticated('/api/auth/me', body);
  return parseAuthResponse(response, 'Could not update profile') as Promise<{ user: AuthUser }>;
}

export async function updatePreferences(
  preferences: Partial<UserPreferences>
): Promise<{ user: AuthUser }> {
  const response = await patchAuthenticated('/api/auth/me', { preferences });
  return parseAuthResponse(response, 'Could not update preferences') as Promise<{ user: AuthUser }>;
}

export async function fetchMe(token: string): Promise<AuthUser> {
  const response = await fetch('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await parseAuthResponse(response, 'Session expired');
  return (body as { user: AuthUser }).user;
}

export async function refreshSessionRequest(): Promise<LoginResult> {
  const token = getStoredToken();
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    logger.warn('Refresh request failed', {
      status: response.status,
      serverError: (body as { error?: string }).error,
    });
    throw new Error((body as { error?: string }).error ?? 'Session refresh failed');
  }
  return body as LoginResult;
}
