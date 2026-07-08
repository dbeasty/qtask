import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PasswordInput } from '../components/PasswordInput';
import { forgotPassword, resendVerification } from '../auth/storage';

type Mode = 'login' | 'register' | 'forgot-password' | 'check-email';

interface LoginPageProps {
  initialMode?: 'login' | 'register';
}

export function LoginPage({ initialMode = 'login' }: LoginPageProps) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [acceptLegal, setAcceptLegal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setInfo(null);
    setNeedsVerification(false);
    if (next !== 'register') {
      setAcceptLegal(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setNeedsVerification(false);
    setSubmitting(true);

    try {
      if (mode === 'login') {
        await login(email, password);
      } else if (mode === 'register') {
        const result = await register(email, password, displayName || undefined, acceptLegal);
        setInfo(result.message);
        setMode('check-email');
      } else if (mode === 'forgot-password') {
        const result = await forgotPassword(email);
        setInfo(result.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      setError(message);
      if (message.toLowerCase().includes('verify your email')) {
        setNeedsVerification(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendVerification() {
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      const result = await resendVerification(email);
      setInfo(result.message);
      setNeedsVerification(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend verification email');
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === 'check-email') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>QTask</h1>
          <p className="auth-success">{info ?? 'Check your email to verify your account.'}</p>
          <p className="muted">We sent a verification link to {email || 'your email address'}.</p>
          <button type="button" className="auth-link-btn" onClick={() => switchMode('login')}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  const canSubmit =
    !submitting && (mode !== 'register' || acceptLegal);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>QTask</h1>
        <p className="muted">
          {mode === 'forgot-password' ? 'Reset your password' : 'Sign in to manage your tasks'}
        </p>

        {mode !== 'forgot-password' && (
          <div className="auth-tabs">
            <button
              type="button"
              className={mode === 'login' ? 'nav-active' : ''}
              onClick={() => switchMode('login')}
            >
              Sign in
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'nav-active' : ''}
              onClick={() => switchMode('register')}
            >
              Create account
            </button>
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === 'register' && (
            <label>
              Display name
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                placeholder="Optional"
              />
            </label>
          )}

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>

          {mode !== 'forgot-password' && (
            <label>
              Password
              <PasswordInput
                value={password}
                onChange={setPassword}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={mode === 'register' ? 10 : 1}
                required
              />
            </label>
          )}

          {mode === 'register' && (
            <p className="auth-hint muted">Password must be at least 10 characters.</p>
          )}

          {mode === 'register' && (
            <label className="legal-checkbox">
              <input
                type="checkbox"
                checked={acceptLegal}
                onChange={(e) => setAcceptLegal(e.target.checked)}
                required
              />
              <span>
                I agree to the <a href="/terms">Terms &amp; Disclaimer</a> and{' '}
                <a href="/privacy">Privacy Policy</a>
              </span>
            </label>
          )}

          {mode === 'login' && (
            <button type="button" className="auth-link-btn" onClick={() => switchMode('forgot-password')}>
              Forgot password?
            </button>
          )}

          {error && <p className="auth-error">{error}</p>}
          {info && <p className="auth-success">{info}</p>}

          {needsVerification && (
            <button
              type="button"
              className="auth-link-btn"
              onClick={() => void handleResendVerification()}
              disabled={submitting || !email}
            >
              Resend verification email
            </button>
          )}

          <button type="submit" className="auth-submit" disabled={!canSubmit}>
            {submitting
              ? 'Please wait…'
              : mode === 'login'
                ? 'Sign in'
                : mode === 'register'
                  ? 'Create account'
                  : 'Send reset link'}
          </button>

          {mode === 'forgot-password' && (
            <button type="button" className="auth-link-btn" onClick={() => switchMode('login')}>
              Back to sign in
            </button>
          )}
        </form>

        <p className="auth-back-home muted">
          <a href="/">Back to home</a>
        </p>
      </div>
    </div>
  );
}
