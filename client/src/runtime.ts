/**
 * Which backend the client is talking to: the hosted server ("online") or the private
 * backend inside the Mac app ("local": one user, no network, no cloud).
 *
 * The native shell sets `window.__QTASK_NATIVE__` before any script runs. That is only a
 * hint that there is something to ask: the answer comes from GET /api/version, so the UI
 * follows what the backend says it is, not what the page was told.
 */

export type RuntimeMode = 'local' | 'online';

declare global {
  interface Window {
    __QTASK_NATIVE__?: { platform?: string };
  }
}

import { setStoredToken } from './auth/storage';

let mode: RuntimeMode = 'online';

export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && window.__QTASK_NATIVE__ !== undefined;
}

export function getRuntimeMode(): RuntimeMode {
  return mode;
}

/** True when online-only UI (sign-in, sharing, the AI agent, feedback...) must be hidden. */
export function isLocalMode(): boolean {
  return mode === 'local';
}

/** For tests. */
export function setRuntimeMode(next: RuntimeMode): void {
  mode = next;
}

export async function fetchRuntimeMode(): Promise<RuntimeMode> {
  const response = await fetch('/api/version');
  if (!response.ok) return 'online';
  const body = (await response.json()) as { mode?: string };
  return body.mode === 'local' ? 'local' : 'online';
}

/**
 * In the Mac app there is no sign-in: ask the local backend for a session and store it
 * like any other login, so everything downstream (api/client.ts, AuthContext) is unchanged.
 */
export async function ensureLocalSession(): Promise<void> {
  const response = await fetch('/api/auth/local-session', { method: 'POST' });
  if (!response.ok) throw new Error(`Could not start the local session (${response.status})`);
  const body = (await response.json()) as { token: string };
  setStoredToken(body.token);
}

/**
 * Called once before the first render. Resolves the mode and, in local mode, the session.
 * A failure leaves the mode "online" so the page still renders (and shows its own error)
 * rather than staying blank.
 */
export async function initRuntime(): Promise<void> {
  if (!isNativeShell()) return;
  try {
    mode = await fetchRuntimeMode();
    if (mode === 'local') await ensureLocalSession();
  } catch (error) {
    console.error('Runtime initialisation failed', error);
  }
}
