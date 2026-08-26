import { useEffect, useState } from 'react';
import { consumeSessionMessage, getReturnToPath, isSafeReturnPath, setSessionMessage } from '../auth/session';
import { exchangeOAuthCode, setStoredToken, type LoginResult } from '../auth/storage';

/** Dedupe Strict Mode double-mount so a one-time code is only exchanged once. */
const oauthExchangeByCode = new Map<string, Promise<LoginResult>>();

function exchangeOAuthCodeOnce(code: string): Promise<LoginResult> {
  const existing = oauthExchangeByCode.get(code);
  if (existing) return existing;
  const pending = exchangeOAuthCode(code);
  oauthExchangeByCode.set(code, pending);
  return pending;
}

export function OAuthCallbackPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error');
    if (oauthError) {
      setSessionMessage(oauthError);
      window.location.replace('/login');
      return;
    }

    const code = params.get('code');
    if (!code) {
      setError('Missing sign-in code');
      return;
    }

    let cancelled = false;
    void exchangeOAuthCodeOnce(code)
      .then((result) => {
        if (cancelled) return;
        // Persist the token only — a full reload follows. Calling applyLoginResult here
        // schedules an immediate proactive refresh that navigation aborts, which clears
        // the session before the next page loads.
        setStoredToken(result.token);
        const returnTo = params.get('returnTo') ?? getReturnToPath();
        window.location.replace(isSafeReturnPath(returnTo) ? returnTo : '/');
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Sign-in failed';
        setError(message);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    consumeSessionMessage();
  }, []);

  if (error) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Sign-in failed</h1>
          <p className="auth-error">{error}</p>
          <p className="auth-hint muted">
            <a href="/login">Back to sign in</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <p className="muted">Completing sign-in…</p>
    </div>
  );
}
