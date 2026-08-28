import { useEffect, useState, type FormEvent } from 'react';
import { consumeSessionMessage, getReturnToPath, isSafeReturnPath, setSessionMessage } from '../auth/session';
import {
  confirmOAuthProviderLink,
  exchangeOAuthCode,
  setStoredToken,
  type LoginResult,
} from '../auth/storage';
import { PasswordInput } from '../components/PasswordInput';

/** Dedupe Strict Mode double-mount so a one-time code is only exchanged once. */
const oauthExchangeByCode = new Map<string, Promise<LoginResult>>();

function exchangeOAuthCodeOnce(code: string): Promise<LoginResult> {
  const existing = oauthExchangeByCode.get(code);
  if (existing) return existing;
  const pending = exchangeOAuthCode(code);
  oauthExchangeByCode.set(code, pending);
  return pending;
}

function completeLogin(result: LoginResult, params: URLSearchParams) {
  // Persist the token only — a full reload follows. Calling applyLoginResult here
  // schedules an immediate proactive refresh that navigation aborts, which clears
  // the session before the next page loads.
  setStoredToken(result.token);
  const returnTo = params.get('returnTo') ?? getReturnToPath();
  window.location.replace(isSafeReturnPath(returnTo) ? returnTo : '/');
}

function LinkConfirmationForm({ linkToken, email }: { linkToken: string; email: string | null }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await confirmOAuthProviderLink(linkToken, password);
      completeLogin(result, new URLSearchParams(window.location.search));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm sign-in');
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Link this account?</h1>
        <p className="muted">
          An account already exists for {email ?? 'this email address'}. Enter its password to link this
          sign-in method, or go back and use your existing sign-in instead.
        </p>
        <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
          <label>
            Password
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              minLength={1}
              required
            />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? 'Please wait…' : 'Link and sign in'}
          </button>
        </form>
        <p className="auth-hint muted">
          <a href="/login">Back to sign in</a>
        </p>
      </div>
    </div>
  );
}

export function OAuthCallbackPage() {
  const [error, setError] = useState<string | null>(null);
  const [linkConfirmation, setLinkConfirmation] = useState<{ linkToken: string; email: string | null } | null>(
    null
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error');
    if (oauthError) {
      setSessionMessage(oauthError);
      window.location.replace('/login');
      return;
    }

    const linkToken = params.get('linkToken');
    if (linkToken) {
      setLinkConfirmation({ linkToken, email: params.get('linkEmail') });
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
        completeLogin(result, params);
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

  if (linkConfirmation) {
    return <LinkConfirmationForm linkToken={linkConfirmation.linkToken} email={linkConfirmation.email} />;
  }

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
