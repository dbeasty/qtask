export type SessionExpiryReason = 'missing' | 'expired' | 'invalid';

export const REFRESH_LEAD_MS = 24 * 60 * 60 * 1000;
export const REFRESH_GRACE_MS = 5 * 60 * 1000;

export const AUTH_PATHS = new Set([
  '/login',
  '/register',
  '/verify-email',
  '/reset-password',
  '/oauth/consent',
  '/auth/oauth/callback',
]);

const SESSION_MESSAGE_KEY = 'qtask_session_message';

export interface TokenPayload {
  sub?: string;
  exp?: number;
}

export function decodeTokenPayload(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as TokenPayload;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function getTokenExpiryMs(token: string): number | null {
  const payload = decodeTokenPayload(token);
  if (!payload?.exp) return null;
  return payload.exp * 1000;
}

export function getExpiredAgoMs(token: string | null): number | null {
  if (!token) return null;
  const expMs = getTokenExpiryMs(token);
  if (expMs == null) return null;
  const ago = Date.now() - expMs;
  return ago > 0 ? ago : null;
}

export function isTokenExpired(token: string | null): boolean {
  if (!token) return false;
  const expMs = getTokenExpiryMs(token);
  if (expMs == null) return false;
  return Date.now() >= expMs;
}

export function isWithinRefreshGrace(token: string | null): boolean {
  if (!token) return false;
  const expMs = getTokenExpiryMs(token);
  if (expMs == null) return false;
  return Date.now() >= expMs && Date.now() - expMs <= REFRESH_GRACE_MS;
}

export function msUntilRefresh(token: string, leadMs: number = REFRESH_LEAD_MS): number | null {
  const expMs = getTokenExpiryMs(token);
  if (expMs == null) return null;
  const refreshAt = expMs - leadMs;
  const delay = refreshAt - Date.now();
  return delay > 0 ? delay : 0;
}

export function sessionMessageForReason(reason: SessionExpiryReason): string {
  switch (reason) {
    case 'missing':
      return 'Please sign in to continue.';
    case 'expired':
      return 'Your session timed out. Please sign in again.';
    case 'invalid':
      return 'Your session is no longer valid. Please sign in again.';
  }
}

export function classifyAuthFailure(input: {
  hadToken: boolean;
  token: string | null;
}): SessionExpiryReason {
  if (!input.hadToken || !input.token) {
    return 'missing';
  }
  if (isTokenExpired(input.token)) {
    return 'expired';
  }
  return 'invalid';
}

export function setSessionMessage(message: string): void {
  sessionStorage.setItem(SESSION_MESSAGE_KEY, message);
}

export function consumeSessionMessage(): string | null {
  const message = sessionStorage.getItem(SESSION_MESSAGE_KEY);
  if (message) {
    sessionStorage.removeItem(SESSION_MESSAGE_KEY);
  }
  return message;
}

export function getAuthPathname(): string {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

export function getReturnToPath(): string | null {
  const params = new URLSearchParams(window.location.search);
  const returnTo = params.get('returnTo');
  if (!returnTo || !returnTo.startsWith('/')) {
    return null;
  }
  return returnTo;
}

export function isAuthPath(pathname?: string): boolean {
  return AUTH_PATHS.has(pathname ?? getAuthPathname());
}
