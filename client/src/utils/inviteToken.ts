import { getAuthPathname } from '../auth/session';

export const PENDING_INVITE_TOKEN_KEY = 'qtask_pending_invite_token';

export function captureInviteTokenFromUrl(): string | null {
  if (getAuthPathname() !== '/invites/accept') {
    return getPendingInviteToken();
  }

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token')?.trim();
  if (token) {
    sessionStorage.setItem(PENDING_INVITE_TOKEN_KEY, token);
    return token;
  }

  return getPendingInviteToken();
}

export function getPendingInviteToken(): string | null {
  const stored = sessionStorage.getItem(PENDING_INVITE_TOKEN_KEY);
  return stored?.trim() ? stored : null;
}

export function clearPendingInviteToken(): void {
  sessionStorage.removeItem(PENDING_INVITE_TOKEN_KEY);
}
